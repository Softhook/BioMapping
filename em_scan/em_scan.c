// em_scan.c — EM Scan: standalone GPS + sub-GHz RSSI walk-test logger.
//
// A deliberately separate, minimal FAP from Bio Mapping proper (see
// biomap.c/biomap_session.c) — it exists to answer one question before any
// of this gets folded into the main app: does ambient sub-GHz RSSI vary
// meaningfully with location, or is it just noise? See docs/peak_density_
// vs_spatial_clustering.md §6E/§6F for the full EM-Fog Index design this is
// a cut-down feasibility test of, and docs/todo.txt for the original doubt
// ("is this really at a high enough level to differentiate anything?") that
// prompted testing before building.
//
// Shares modules/gps_uart.c, modules/sd_logger.c, minmea.c, and
// biomap_config.h/biomap_events.h/biomap_types.h with the main biomap app
// via symlinks (not copies) — see this directory's contents. Any fix to
// those files benefits both apps; nothing here forks them. The one new
// piece is em_scan_rf.c (the CC1101 sweep) — written as a self-contained
// tick function so it can be lifted into biomap_session.c's tick handler
// later with minimal changes, the same way gsr_sensor_tick() and the
// acoustic-mic proposal's acoustic_tick() are structured.
//
// NOTE: recordings land in the same /ext/biomapping/ directory and
// biomap_NNN.csv numbering sequence as the main app (sd_logger.c hardcodes
// both) — a deliberate shortcut to avoid touching a tested, stable shared
// module for what's still a throwaway feasibility test. Distinguish an
// em_scan recording from a biomap recording by its header row. Worth
// parameterising sd_logger's dir/prefix if this tool survives past the
// feasibility stage.

#include "biomap_config.h"
#include "biomap_events.h"
#include "biomap_types.h"
#include "em_scan_rf.h"
#include "modules/gps_uart.h"
#include "modules/sd_logger.h"

#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <gui/view_port.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

typedef struct {
    Gui*              gui;
    ViewPort*         vp;
    FuriMessageQueue* event_queue;
    FuriMutex*        mutex;
    FuriTimer*        timer;
    NotificationApp*  notifications;
    Storage*          storage;

    GpsUart*  gps;
    SdLogger* logger;

    bool     recording;
    uint32_t total_ticks;    // ticks since recording start, for the relative timestamp column
    int      flush_counter;  // ticks since last SD flush

    // One band gets a real peak-hold dwell per tick, round-robin — see
    // em_scan_rf_dwell_band's doc comment. So each element updates roughly
    // every EM_SCAN_NUM_FREQS ticks (~600ms), not every tick; between its
    // own updates it holds its last peak-hold value (sample-and-hold), same
    // in the live bars as in the logged CSV.
    int   sweep_band;                  // which band gets dwelled-on this tick
    float rssi_dbm[EM_SCAN_NUM_FREQS]; // latest peak-hold reading per band, read by render + log

    // Display-only "falling peak" marker (VU-meter style), separate from
    // the CC1101 peak-hold dwell in em_scan_rf.c — that one catches short
    // RF bursts within a single ~25ms dwell; this one visualises the
    // recent high-water mark across many dwells so a brief spike is still
    // visible on screen after rssi_dbm[i] has moved back down. Snaps up
    // instantly on a new high, decays every tick (see EM_SCAN_PEAK_DECAY_
    // DB_PER_TICK), and is clamped so it never renders below the live bar.
    float peak_hold_dbm[EM_SCAN_NUM_FREQS];
} EmScanApp;

// ==========================================================================
// Input & timer callbacks — same pattern as biomap_input_callback /
// biomap_timer_callback in biomap_gui.c, small enough not to be worth
// sharing across a symlink.
// ==========================================================================

static void em_scan_input_callback(InputEvent* e, void* ctx) {
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

static void em_scan_timer_callback(void* ctx) {
    PluginEvent ev = {.type = EventTypeTick};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

// ==========================================================================
// GPS fix check — shared by render (status line) and logging (row gating).
//
// Deliberately NOT gps_uart_is_ready(): that only means the Flipper's UART
// port was successfully claimed at alloc time, true almost immediately
// whether or not a GPS module is actually wired up or has ever produced a
// fix. This mirrors get_gps_position()'s gps_ok check in biomap_session.c
// and biomap_render.c's own "GPS ready" logic (has_fix && hdop below gate),
// not gps_uart_is_ready().
// ==========================================================================

static inline bool em_scan_gps_fix_ok(const GpsStatus* gs) {
    return (gs->fix_valid || gs->fix_quality > 0) && !isnan(gs->latitude) &&
           !isnan(gs->longitude) && gs->hdop < GPS_HDOP_GATE;
}

// ==========================================================================
// Render — one bar per swept frequency, plus GPS/recording status.
// ==========================================================================

// Bar fill range in dBm. -100 = thermal noise floor (nothing there), -30 =
// a strong nearby transmitter — same mapping used in the original EM-Fog
// normalisation (§6E: P_band clamp(RSSI - (-100) / (-30 - (-100)), 0, 1)).
#define EM_SCAN_RSSI_FLOOR -100.0f
#define EM_SCAN_RSSI_CEIL  -30.0f

// Falling-peak decay rate, in dB per 100ms tick (~15 dB/sec) — chosen so a
// 20dB spike takes a bit over a second to fully decay back into the live
// bar, similar to a music-player VU meter's falling peak marker. Applied
// every tick (10Hz) regardless of which band actually got dwelled on that
// tick, so the animation is smooth even though live readings only update
// per-band every ~600ms — see peak_hold_dbm's doc comment on EmScanApp.
#define EM_SCAN_PEAK_DECAY_DB_PER_TICK 1.5f

// dB values the reference tick marks sit at (every 20dB) — shared by every
// bar since they all use the same bar_x/bar_w/floor/ceil mapping.
static const float EM_SCAN_TICK_DB[] = {-80.0f, -60.0f, -40.0f};
#define EM_SCAN_TICK_COUNT (sizeof(EM_SCAN_TICK_DB) / sizeof(EM_SCAN_TICK_DB[0]))

// Shared by the live fill, the tick marks, and the peak marker so all
// three always agree on where a given dB value lands on screen.
static int em_scan_db_to_x(float db, int bar_x, int bar_w) {
    float norm = (db - EM_SCAN_RSSI_FLOOR) / (EM_SCAN_RSSI_CEIL - EM_SCAN_RSSI_FLOOR);
    if(norm < 0.0f) norm = 0.0f;
    if(norm > 1.0f) norm = 1.0f;
    return bar_x + 1 + (int)(norm * (bar_w - 2));
}

static void em_scan_render_callback(Canvas* canvas, void* ctx) {
    EmScanApp* app = ctx;
    furi_mutex_acquire(app->mutex, FuriWaitForever);

    canvas_clear(canvas);
    canvas_set_font(canvas, FontSecondary);

    canvas_draw_str(canvas, 2, 9, "EM Scan");
    if(app->recording) {
        canvas_draw_str(canvas, 100, 9, "REC");
    }

    const int bar_x = 32;
    const int bar_w = 92;
    const int bar_h = 6;
    const int row_h = 7;
    const int top   = 14;

    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        int y = top + i * row_h;
        canvas_draw_str(canvas, 2, y + bar_h, em_scan_freq_label[i]);

        canvas_draw_frame(canvas, bar_x, y, bar_w, bar_h);

        int fill_x = em_scan_db_to_x(app->rssi_dbm[i], bar_x, bar_w);
        int fill = fill_x - (bar_x + 1);
        if(fill > 0) canvas_draw_box(canvas, bar_x + 1, y + 1, fill, bar_h - 2);

        // Reference scale, every 20dB — XOR so the mark stays visible
        // whether it lands on the solid fill or the empty background.
        canvas_set_color(canvas, ColorXOR);
        for(size_t t = 0; t < EM_SCAN_TICK_COUNT; t++) {
            int tx = em_scan_db_to_x(EM_SCAN_TICK_DB[t], bar_x, bar_w);
            canvas_draw_line(canvas, tx, y + 1, tx, y + bar_h - 2);
        }
        canvas_set_color(canvas, ColorBlack);

        // Falling peak marker: dotted ("grey") vertical line ahead of the
        // live fill, decaying back down into it over about a second — see
        // peak_hold_dbm's doc comment on EmScanApp. Only drawn when it's
        // actually ahead of the live fill; once it decays down to match,
        // it's fully absorbed into the solid bar, same as it disappearing.
        int peak_x = em_scan_db_to_x(app->peak_hold_dbm[i], bar_x, bar_w);
        if(peak_x > fill_x) {
            for(int yy = y + 1; yy < y + bar_h - 1; yy += 2) {
                canvas_draw_dot(canvas, peak_x, yy);
            }
        }
    }

    bool gps_ready = false;
    if(app->gps) {
        GpsStatus gs = gps_uart_get_status(app->gps);
        gps_ready = em_scan_gps_fix_ok(&gs);
    }
    canvas_draw_str(canvas, 2, 63, gps_ready ? "GPS ok" : "GPS...");
    canvas_draw_str(canvas, 50, 63, "OK=rec  Back=exit");

    furi_mutex_release(app->mutex);
}

// ==========================================================================
// CSV row — timestamp,lat,lon,hdop,fix_type,rssi_<freq>...
// A lean subset of biomap's own GPS row (no pdop/sats/speed/course/hacc) —
// this tool cares about "is there a fix good enough to trust the position",
// not the full GPS diagnostic set.
// ==========================================================================

static void em_scan_build_header(char* out, size_t out_len) {
    int n = snprintf(out, out_len, "timestamp,lat,lon,hdop,fix_type");
    for(int i = 0; i < EM_SCAN_NUM_FREQS && n > 0 && (size_t)n < out_len; i++) {
        n += snprintf(out + n, out_len - (size_t)n, ",rssi_%s", em_scan_freq_label[i]);
    }
    if(n > 0 && (size_t)n < out_len) snprintf(out + n, out_len - (size_t)n, "\n");
}

static bool em_scan_log_row(EmScanApp* app) {
    double rel = app->total_ticks * (1.0 / TICK_HZ);

    GpsStatus gs = {0};
    bool gps_ok = false;
    if(app->gps) {
        gs = gps_uart_get_status(app->gps);
        gps_ok = em_scan_gps_fix_ok(&gs);
    }

    char row[192];
    int n;
    if(gps_ok) {
        n = snprintf(row, sizeof(row), "%.2f,%.7f,%.7f,%.1f,%d",
                     rel, gs.latitude, gs.longitude, (double)gs.hdop, gs.fix_type);
    } else {
        n = snprintf(row, sizeof(row), "%.2f,,,,", rel);
    }
    for(int i = 0; i < EM_SCAN_NUM_FREQS && n > 0 && (size_t)n < sizeof(row); i++) {
        n += snprintf(row + n, sizeof(row) - (size_t)n, ",%.1f", (double)app->rssi_dbm[i]);
    }
    if(n <= 0 || (size_t)n >= sizeof(row)) return false;
    n += snprintf(row + n, sizeof(row) - (size_t)n, "\n");
    if(n <= 0 || (size_t)n >= sizeof(row)) return false;

    return sd_logger_batch_append(app->logger, row, (size_t)n);
}

// ==========================================================================
// Recording toggle
// ==========================================================================

// Deliberately mirrors key_toggle_recording() in biomap_session.c: the
// mutex is only held around the shared-state flag flips, never across
// sd_logger_start()/sd_logger_stop() themselves. Both do real SD I/O
// (sd_logger_start scans the directory for the next free index) that can
// take long enough to be a visible stall in em_scan_render_callback, which
// also needs this mutex to draw — see that function's comment for the
// full reasoning this was copied from.
static void em_scan_toggle_recording(EmScanApp* app) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    bool start = !app->recording;
    furi_mutex_release(app->mutex);

    if(start) {
        char header[128];
        em_scan_build_header(header, sizeof(header));
        bool ok = sd_logger_start(app->logger, header);
        if(ok) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->recording = true;
            app->total_ticks = 0;
            app->flush_counter = 0;
            furi_mutex_release(app->mutex);
            notification_message(app->notifications, &sequence_blink_green_100);
        } else {
            notification_message(app->notifications, &sequence_blink_red_100);
        }
    } else {
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        app->recording = false;
        furi_mutex_release(app->mutex);
        sd_logger_batch_flush(app->logger);
        sd_logger_stop(app->logger);
        notification_message(app->notifications, &sequence_blink_stop);
    }
}

// ==========================================================================
// App entry
// ==========================================================================

int32_t em_scan_app(void* p) {
    UNUSED(p);
    EmScanApp* app = malloc(sizeof(EmScanApp));
    furi_assert(app);
    memset(app, 0, sizeof(EmScanApp));
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        app->rssi_dbm[i] = EM_SCAN_RSSI_FLOOR;
        app->peak_hold_dbm[i] = EM_SCAN_RSSI_FLOOR;
    }

    app->event_queue   = furi_message_queue_alloc(EVENT_QUEUE_DEPTH, sizeof(PluginEvent));
    app->mutex         = furi_mutex_alloc(FuriMutexTypeNormal);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->storage       = furi_record_open(RECORD_STORAGE);
    app->gui           = furi_record_open(RECORD_GUI);
    storage_common_mkdir(app->storage, "/ext/biomapping");

    app->vp = view_port_alloc();
    view_port_draw_callback_set(app->vp, em_scan_render_callback, app);
    view_port_input_callback_set(app->vp, em_scan_input_callback, app->event_queue);
    gui_add_view_port(app->gui, app->vp, GuiLayerFullscreen);

    app->timer = furi_timer_alloc(em_scan_timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(app->timer, furi_kernel_get_tick_frequency() / TICK_HZ);

    app->gps = gps_uart_alloc(app->event_queue, app->notifications, GpsNavModelPedestrian);
    app->logger = sd_logger_alloc(app->storage);
    em_scan_rf_init();

    bool running = true;
    PluginEvent ev;
    while(running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk) continue;

        if(ev.type == EventTypeUart) {
            if(app->gps) gps_uart_process_rx(app->gps);
            continue;
        }

        if(ev.type == EventTypeTick) {
            // The ~25ms hardware dwell (em_scan_rf_dwell_band — 3ms warm-up
            // + 22ms peak-hold polling) deliberately runs OUTSIDE the
            // mutex. app->sweep_band is read/written only by this thread
            // (the render callback never touches it), so no lock is needed
            // for that either. Holding app->mutex across a guaranteed
            // ~25ms-every-tick busy-wait was the actual bug behind the
            // "ViewPort lockup" warnings seen in the device log — the
            // render callback needs this same mutex to draw, and was being
            // starved waiting on it every single tick. This mirrors why
            // em_scan_toggle_recording() also keeps SD I/O outside the
            // mutex: anything slow enough to be visible must not be held
            // under the lock the renderer depends on.
            int band = app->sweep_band;
            float peak;
            em_scan_rf_dwell_band(band, &peak);

            // Mutex held only for the actually-shared-state-touching part,
            // matching biomap_session.c's own Tick-handler pattern (see
            // handle_second_boundary/handle_write_failure) — including the
            // rare flush-failure branch's sd_logger_stop() call, since that
            // only runs on an SD error, not on every tick.
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->rssi_dbm[band] = peak;
            app->sweep_band = (band + 1) % EM_SCAN_NUM_FREQS;

            // Falling-peak decay, every band, every tick — see
            // EM_SCAN_PEAK_DECAY_DB_PER_TICK's comment. Cheap (six floats),
            // fine to run under the mutex alongside the rest of this block.
            for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
                if(app->rssi_dbm[i] > app->peak_hold_dbm[i]) {
                    app->peak_hold_dbm[i] = app->rssi_dbm[i]; // new high — snap up instantly
                } else {
                    app->peak_hold_dbm[i] -= EM_SCAN_PEAK_DECAY_DB_PER_TICK;
                    if(app->peak_hold_dbm[i] < app->rssi_dbm[i]) {
                        app->peak_hold_dbm[i] = app->rssi_dbm[i]; // never render below the live bar
                    }
                }
            }

            if(app->recording) {
                if(!em_scan_log_row(app)) {
                    FURI_LOG_E("EmScan", "CSV row build/append failed");
                }
                app->total_ticks++;
                if(++app->flush_counter >= TICK_HZ) { // flush once per second
                    app->flush_counter = 0;
                    if(sd_logger_batch_flush(app->logger) < 0) {
                        FURI_LOG_E("EmScan", "Batch flush failed — stopping recording");
                        sd_logger_stop(app->logger);
                        app->recording = false;
                    }
                }
            }
            furi_mutex_release(app->mutex);
            view_port_update(app->vp);
            continue;
        }

        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) {
                running = false;
            } else if(ev.input.key == InputKeyOk) {
                em_scan_toggle_recording(app);
            }
            view_port_update(app->vp);
        }
    }

    if(app->recording) {
        sd_logger_batch_flush(app->logger);
        sd_logger_stop(app->logger);
    }
    em_scan_rf_deinit();
    furi_timer_free(app->timer);
    if(app->gps) gps_uart_free(app->gps);
    sd_logger_free(app->logger);

    gui_remove_view_port(app->gui, app->vp);
    view_port_free(app->vp);

    furi_record_close(RECORD_GUI);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_STORAGE);
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);
    return 0;
}
