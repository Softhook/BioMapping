// em_scan.c — EM Scan: standalone GPS + sub-GHz RSSI walk-test logger & calibration wizard.

#include "biomap_config.h"
#include "biomap_events.h"
#include "biomap_types.h"
#include "em_scan_cal.h"
#include "em_scan_rf.h"
#include "em_scan_rf_worker.h"
#include "modules/gps_uart.h"
#include "modules/sd_logger.h"
#include "modules/sound.h"

#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <gui/view_port.h>
#include <notification/notification_messages.h>
#include <storage/storage.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

typedef enum {
    EmScanModeMenu,        // Main Navigation Menu
    EmScanModeNormal,      // Live Walk Scan bar screen
    EmScanModeCalPrep,     // 30-second preparation countdown (place in RF bag)
    EmScanModeCalSampling, // 20-second active CC1101 RF noise sampling
    EmScanModeCalStats     // Post-calibration stats display & save decision
} EmScanMode;

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

    // RF worker thread (EmScanModeNormal only — see em_scan_rf_worker.h).
    // Owns long-park sampling; the tick loop below only reads its snapshot
    // in Normal mode and falls back to the legacy short em_scan_rf_dwell_band()
    // path everywhere else (Menu/CalPrep/CalSampling/CalStats), since
    // calibration timing depends on that fixed-cadence short dwell and the
    // two must never touch the CC1101 at the same time.
    EmScanRfWorker* rf_worker;

    EmScanMode mode;
    int        menu_selection;
    EmScanCal  cal_data;
    bool       is_calibrated;

    // Preparation countdown (30 seconds @ 10 Hz tick = 300 ticks)
    uint32_t cal_prep_ticks_left;

    // Active calibration noise sampling
    uint32_t cal_sample_ticks_left;
    uint32_t cal_sweep_count;
    float    cal_samples[64][EM_SCAN_NUM_FREQS];
    float    cal_computed_floors[EM_SCAN_NUM_FREQS];
    float    cal_computed_std_devs[EM_SCAN_NUM_FREQS];
    bool     cal_passed;

    bool     recording;
    uint32_t total_ticks;
    int      flush_counter;

    int   sweep_band;
    float rssi_dbm[EM_SCAN_NUM_FREQS];
    float peak_hold_dbm[EM_SCAN_NUM_FREQS];
} EmScanApp;

// ==========================================================================
// Callbacks
// ==========================================================================

static void em_scan_input_callback(InputEvent* e, void* ctx) {
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

static void em_scan_timer_callback(void* ctx) {
    PluginEvent ev = {.type = EventTypeTick};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

static inline bool em_scan_gps_fix_ok(const GpsStatus* gs) {
    return (gs->fix_valid || gs->fix_quality > 0) && !isnan(gs->latitude) &&
           !isnan(gs->longitude) && gs->hdop < GPS_HDOP_GATE;
}

#define EM_SCAN_RSSI_FLOOR -100.0f
#define EM_SCAN_RSSI_CEIL  -30.0f
#define EM_SCAN_PEAK_DECAY_DB_PER_TICK 0.1f

// How long the RF worker thread parks on each band before hopping to the
// next, while in EmScanModeNormal (see em_scan_rf_worker.h). This is the
// actual dwell-time knob — chosen as a middle ground between catching more
// short bursts (favors longer) and keeping the per-band revisit rate high
// (favors shorter), landing well above the old tick-bound ~22ms dwell
// without needing several seconds per band.
#define EM_SCAN_WORKER_PARK_MS 300

static const float EM_SCAN_TICK_DB[] = {-80.0f, -60.0f, -40.0f};
#define EM_SCAN_TICK_COUNT (sizeof(EM_SCAN_TICK_DB) / sizeof(EM_SCAN_TICK_DB[0]))

static int em_scan_db_to_x_cal(float db, int bar_x, int bar_w, float floor_dbm) {
    float norm = (db - floor_dbm) / (EM_SCAN_RSSI_CEIL - floor_dbm);
    if(norm < 0.0f) norm = 0.0f;
    if(norm > 1.0f) norm = 1.0f;
    return bar_x + 1 + (int)(norm * (bar_w - 2));
}

static float em_scan_calc_fog_index(const float rssi_dbm[EM_SCAN_NUM_FREQS], const EmScanApp* app) {
    float sum_p_sq = 0.0f;
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        float floor = (app && app->is_calibrated) ? app->cal_data.noise_floor_dbm[i] : EM_SCAN_RSSI_FLOOR;
        float norm = (rssi_dbm[i] - floor) / (EM_SCAN_RSSI_CEIL - floor);
        if(norm < 0.0f) norm = 0.0f;
        if(norm > 1.0f) norm = 1.0f;
        sum_p_sq += (norm * norm);
    }
    return sqrtf(sum_p_sq / (float)EM_SCAN_NUM_FREQS) * 100.0f;
}

// ==========================================================================
// Rendering Modes
// ==========================================================================

static void em_scan_render_menu(Canvas* canvas, const EmScanApp* app) {
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str_aligned(canvas, 64, 2, AlignCenter, AlignTop, "EM Scan");

    canvas_set_font(canvas, FontSecondary);
    char cal_status[32];
    snprintf(cal_status, sizeof(cal_status), "Calibration: %s", app->is_calibrated ? "YES" : "NO");
    canvas_draw_str_aligned(canvas, 64, 14, AlignCenter, AlignTop, cal_status);

    static const char* const menu_items[] = {
        "Start Live Scan",
        "Calibrate RF (Faraday)",
        "Reset Calibration",
    };

    const int item_h = 11;
    const int top_y = 26;

    for(int i = 0; i < 3; i++) {
        int y = top_y + i * (item_h + 1);
        if(app->menu_selection == i) {
            canvas_draw_box(canvas, 10, y, 108, item_h);
            canvas_set_color(canvas, ColorXOR);
            canvas_draw_str_aligned(canvas, 64, y + 1, AlignCenter, AlignTop, menu_items[i]);
            canvas_set_color(canvas, ColorBlack);
        } else {
            canvas_draw_str_aligned(canvas, 64, y + 1, AlignCenter, AlignTop, menu_items[i]);
        }
    }
}

static void em_scan_render_normal(Canvas* canvas, EmScanApp* app) {
    const int bar_x = 22;
    const int bar_w = 102;
    const int bar_h = 5;
    const int row_h = 7;
    const int top   = 4;

    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        int y = top + i * row_h;
        canvas_set_font(canvas, FontKeyboard);
        canvas_draw_str(canvas, 2, y + 4, em_scan_freq_label[i]);

        canvas_draw_frame(canvas, bar_x, y, bar_w, bar_h);

        float floor = app->is_calibrated ? app->cal_data.noise_floor_dbm[i] : EM_SCAN_RSSI_FLOOR;
        int fill_x = em_scan_db_to_x_cal(app->rssi_dbm[i], bar_x, bar_w, floor);
        int fill = fill_x - (bar_x + 1);
        if(fill > 0) canvas_draw_box(canvas, bar_x + 1, y + 1, fill, bar_h - 2);

        canvas_set_color(canvas, ColorXOR);
        if(app->is_calibrated) {
            float rel_ticks[] = {floor + 15.0f, floor + 35.0f, floor + 55.0f};
            for(size_t t = 0; t < 3; t++) {
                int tx = em_scan_db_to_x_cal(rel_ticks[t], bar_x, bar_w, floor);
                canvas_draw_line(canvas, tx, y + 1, tx, y + bar_h - 2);
            }
        } else {
            for(size_t t = 0; t < EM_SCAN_TICK_COUNT; t++) {
                int tx = em_scan_db_to_x_cal(EM_SCAN_TICK_DB[t], bar_x, bar_w, floor);
                canvas_draw_line(canvas, tx, y + 1, tx, y + bar_h - 2);
            }
        }
        canvas_set_color(canvas, ColorBlack);

        int peak_x = em_scan_db_to_x_cal(app->peak_hold_dbm[i], bar_x, bar_w, floor);
        if(peak_x > fill_x) {
            for(int yy = y + 1; yy < y + bar_h - 1; yy += 2) {
                canvas_draw_dot(canvas, peak_x, yy);
            }
        }
    }

    canvas_set_font(canvas, FontSecondary);
    bool gps_ready = false;
    if(app->gps) {
        GpsStatus gs = gps_uart_get_status(app->gps);
        gps_ready = em_scan_gps_fix_ok(&gs);
    }
    char left_str[24];
    snprintf(left_str, sizeof(left_str), "%s%s",
             gps_ready ? "GPS ok" : "GPS...",
             app->recording ? " [REC]" : "");
    canvas_draw_str(canvas, 2, 61, left_str);

    canvas_draw_str(canvas, 62, 61, app->is_calibrated ? "CAL:YES" : "CAL:NO");

    float fog = em_scan_calc_fog_index(app->rssi_dbm, app);
    char fog_str[16];
    snprintf(fog_str, sizeof(fog_str), "F:%.1f", (double)fog);
    uint16_t fog_width = canvas_string_width(canvas, fog_str);
    canvas_draw_str(canvas, 126 - fog_width, 61, fog_str);
}

static void em_scan_render_cal_prep(Canvas* canvas, const EmScanApp* app) {
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str_aligned(canvas, 64, 2, AlignCenter, AlignTop, "[RF Faraday Calibration]");

    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(canvas, 64, 16, AlignCenter, AlignTop, "Place Flipper inside RF");
    canvas_draw_str_aligned(canvas, 64, 26, AlignCenter, AlignTop, "Shielding Bag/Box & seal.");

    uint32_t seconds_left = (app->cal_prep_ticks_left + 9) / TICK_HZ;
    char timer_str[32];
    snprintf(timer_str, sizeof(timer_str), "Pre-Bagging: %lus", (unsigned long)seconds_left);
    canvas_draw_str_aligned(canvas, 64, 38, AlignCenter, AlignTop, timer_str);

    const int bar_x = 14;
    const int bar_w = 100;
    const int bar_h = 7;
    const int bar_y = 48;
    canvas_draw_frame(canvas, bar_x, bar_y, bar_w, bar_h);
    uint32_t elapsed = 300 - (app->cal_prep_ticks_left > 300 ? 300 : app->cal_prep_ticks_left);
    int fill = (int)((elapsed * (bar_w - 2)) / 300);
    if(fill > 0) canvas_draw_box(canvas, bar_x + 1, bar_y + 1, fill, bar_h - 2);

    canvas_draw_str_aligned(canvas, 64, 57, AlignCenter, AlignTop, "[OK = Skip Wait, BACK = Exit]");
}

static void em_scan_render_cal_sampling(Canvas* canvas, const EmScanApp* app) {
    canvas_set_font(canvas, FontPrimary);
    canvas_draw_str_aligned(canvas, 64, 2, AlignCenter, AlignTop, "Zeroing CC1101...");

    uint32_t seconds_left = (app->cal_sample_ticks_left + 9) / TICK_HZ;
    char timer_str[32];
    snprintf(timer_str, sizeof(timer_str), "Sampling: %lus", (unsigned long)seconds_left);
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(canvas, 64, 16, AlignCenter, AlignTop, timer_str);

    const int bar_x = 14;
    const int bar_w = 100;
    const int bar_h = 7;
    const int bar_y = 26;
    canvas_draw_frame(canvas, bar_x, bar_y, bar_w, bar_h);
    uint32_t elapsed = 200 - (app->cal_sample_ticks_left > 200 ? 200 : app->cal_sample_ticks_left);
    int fill = (int)((elapsed * (bar_w - 2)) / 200);
    if(fill > 0) canvas_draw_box(canvas, bar_x + 1, bar_y + 1, fill, bar_h - 2);

    char live_str[64];
    snprintf(live_str, sizeof(live_str), "300:%.0fdB  815:%.0fdB",
             (double)app->rssi_dbm[0], (double)app->rssi_dbm[4]);
    canvas_draw_str_aligned(canvas, 64, 38, AlignCenter, AlignTop, live_str);

    canvas_draw_str_aligned(canvas, 64, 48, AlignCenter, AlignTop, "Noise Stability: OK");
    canvas_draw_str_aligned(canvas, 64, 57, AlignCenter, AlignTop, "[BACK = Cancel]");
}

static void em_scan_render_cal_stats(Canvas* canvas, const EmScanApp* app) {
    canvas_set_font(canvas, FontPrimary);
    if(app->cal_passed) {
        canvas_draw_str_aligned(canvas, 64, 2, AlignCenter, AlignTop, "Calibration Passed!");
    } else {
        canvas_draw_str_aligned(canvas, 64, 2, AlignCenter, AlignTop, "Calibration Failed!");
    }

    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(canvas, 64, 14, AlignCenter, AlignTop, "Remove Flipper from bag");

    if(app->cal_passed) {
        float min_f = app->cal_computed_floors[0];
        float max_f = app->cal_computed_floors[0];
        float max_std = app->cal_computed_std_devs[0];
        for(int i = 1; i < EM_SCAN_NUM_FREQS; i++) {
            if(app->cal_computed_floors[i] < min_f) min_f = app->cal_computed_floors[i];
            if(app->cal_computed_floors[i] > max_f) max_f = app->cal_computed_floors[i];
            if(app->cal_computed_std_devs[i] > max_std) max_std = app->cal_computed_std_devs[i];
        }

        char buf1[48];
        snprintf(buf1, sizeof(buf1), "Floors: %.1f to %.1f dBm", (double)min_f, (double)max_f);
        canvas_draw_str_aligned(canvas, 64, 25, AlignCenter, AlignTop, buf1);

        char buf2[48];
        snprintf(buf2, sizeof(buf2), "Max StdDev: %.2fdB (OK)", (double)max_std);
        canvas_draw_str_aligned(canvas, 64, 35, AlignCenter, AlignTop, buf2);

        float fog = em_scan_calc_fog_index(app->cal_computed_floors, app);
        char buf3[48];
        snprintf(buf3, sizeof(buf3), "Baseline Fog Index: %.1f", (double)fog);
        canvas_draw_str_aligned(canvas, 64, 45, AlignCenter, AlignTop, buf3);

        canvas_draw_str_aligned(canvas, 64, 56, AlignCenter, AlignTop, "[OK = Save, BACK = Discard]");
    } else {
        canvas_draw_str_aligned(canvas, 64, 28, AlignCenter, AlignTop, "High Noise Variance (>3.5dB)");
        canvas_draw_str_aligned(canvas, 64, 38, AlignCenter, AlignTop, "Check bag seal for leaks!");
        canvas_draw_str_aligned(canvas, 64, 56, AlignCenter, AlignTop, "[OK/BACK = Exit]");
    }
}

static void em_scan_render_callback(Canvas* canvas, void* ctx) {
    EmScanApp* app = ctx;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    canvas_clear(canvas);

    switch(app->mode) {
    case EmScanModeMenu:
        em_scan_render_menu(canvas, app);
        break;
    case EmScanModeNormal:
        em_scan_render_normal(canvas, app);
        break;
    case EmScanModeCalPrep:
        em_scan_render_cal_prep(canvas, app);
        break;
    case EmScanModeCalSampling:
        em_scan_render_cal_sampling(canvas, app);
        break;
    case EmScanModeCalStats:
        em_scan_render_cal_stats(canvas, app);
        break;
    }

    furi_mutex_release(app->mutex);
}

// ==========================================================================
// Logging & Header
// ==========================================================================

static void em_scan_build_header(EmScanApp* app, char* out, size_t out_len) {
    int n = 0;
    if(app->is_calibrated) {
        n += snprintf(out + n, out_len - (size_t)n, "# Calibrated: YES (CRC: 0x%08X)\n", (unsigned int)app->cal_data.crc32);
        n += snprintf(out + n, out_len - (size_t)n, "# Band Floors (dBm):");
        for(int i = 0; i < EM_SCAN_NUM_FREQS && n > 0 && (size_t)n < out_len; i++) {
            n += snprintf(out + n, out_len - (size_t)n, "%s %s:%.1f",
                          (i == 0) ? "" : ",",
                          em_scan_freq_label[i],
                          (double)app->cal_data.noise_floor_dbm[i]);
        }
        if(n > 0 && (size_t)n < out_len) n += snprintf(out + n, out_len - (size_t)n, "\n");
    } else {
        n += snprintf(out + n, out_len - (size_t)n, "# Calibrated: NO\n");
    }
    n += snprintf(out + n, out_len - (size_t)n, "timestamp,lat,lon,hdop,fix_type,em_fog");
    for(int i = 0; i < EM_SCAN_NUM_FREQS && n > 0 && (size_t)n < out_len; i++) {
        n += snprintf(out + n, out_len - (size_t)n, ",rssi_%s", em_scan_freq_label[i]);
    }
    if(n > 0 && (size_t)n < out_len) snprintf(out + n, out_len - (size_t)n, "\n");
}

static bool em_scan_log_row(EmScanApp* app) {
    double rel = app->total_ticks * (1.0 / TICK_HZ);
    float fog = em_scan_calc_fog_index(app->rssi_dbm, app);

    GpsStatus gs = {0};
    bool gps_ok = false;
    if(app->gps) {
        gs = gps_uart_get_status(app->gps);
        gps_ok = em_scan_gps_fix_ok(&gs);
    }

    char row[192];
    int n;
    if(gps_ok) {
        n = snprintf(row, sizeof(row), "%.2f,%.7f,%.7f,%.1f,%d,%.1f",
                     rel, gs.latitude, gs.longitude, (double)gs.hdop, gs.fix_type, (double)fog);
    } else {
        n = snprintf(row, sizeof(row), "%.2f,,,,,%.1f", rel, (double)fog);
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
// Recording Toggle
// ==========================================================================

static void em_scan_toggle_recording(EmScanApp* app) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    bool start = !app->recording;
    furi_mutex_release(app->mutex);

    if(start) {
        // The calibrated header (CRC line + "Band Floors" line + CSV column
        // row) needs 236 bytes — a 192-byte buffer silently truncated it
        // mid-word via snprintf's return-value-vs-actually-written
        // mismatch, with no trailing newline, so the first data row landed
        // directly on the end of the corrupted header line. Confirmed
        // against a real recording (track 75) before sizing this.
        char header[320];
        em_scan_build_header(app, header, sizeof(header));
        bool ok = sd_logger_start(app->logger, header);
        if(ok) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->recording = true;
            app->total_ticks = 0;
            app->flush_counter = 0;
            furi_mutex_release(app->mutex);
            notification_message(app->notifications, &sequence_blink_green_100);
            biomap_sound_recording_start(true);
        } else {
            notification_message(app->notifications, &sequence_blink_red_100);
            biomap_sound_error(true);
        }
    } else {
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        app->recording = false;
        furi_mutex_release(app->mutex);
        sd_logger_batch_flush(app->logger);
        sd_logger_stop(app->logger);
        notification_message(app->notifications, &sequence_blink_stop);
        biomap_sound_recording_stop(true);
    }
}

// ==========================================================================
// Calibration Wizard Control
// ==========================================================================

static void em_scan_start_calibration_wizard(EmScanApp* app) {
    if(app->recording) return;
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->mode = EmScanModeCalPrep;
    app->cal_prep_ticks_left = 30 * TICK_HZ;
    app->cal_sample_ticks_left = 0;
    app->cal_sweep_count = 0;
    furi_mutex_release(app->mutex);
    biomap_sound_confirm(true);
}

// ==========================================================================
// App Entry
// ==========================================================================

int32_t em_scan_app(void* p) {
    UNUSED(p);
    EmScanApp* app = malloc(sizeof(EmScanApp));
    furi_assert(app);
    memset(app, 0, sizeof(EmScanApp));
    app->mode = EmScanModeMenu; // Start in Main Menu (matching BioMapping)
    app->menu_selection = 0;

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

    // Load existing calibration if present
    app->is_calibrated = em_scan_cal_load(&app->cal_data, app->storage);

    app->vp = view_port_alloc();
    view_port_draw_callback_set(app->vp, em_scan_render_callback, app);
    view_port_input_callback_set(app->vp, em_scan_input_callback, app->event_queue);
    gui_add_view_port(app->gui, app->vp, GuiLayerFullscreen);

    app->timer = furi_timer_alloc(em_scan_timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(app->timer, furi_kernel_get_tick_frequency() / TICK_HZ);

    app->gps = gps_uart_alloc(app->event_queue, app->notifications, GpsNavModelPedestrian);
    app->logger = sd_logger_alloc(app->storage);
    em_scan_rf_init();

    app->rf_worker = em_scan_rf_worker_alloc(EM_SCAN_WORKER_PARK_MS);

    bool running = true;
    PluginEvent ev;
    while(running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk) continue;

        if(ev.type == EventTypeUart) {
            if(app->gps) gps_uart_process_rx(app->gps);
            continue;
        }

        if(ev.type == EventTypeTick) {
            bool cal_just_finished = false;
            bool cal_passed_result = false;

            if(app->mode != EmScanModeNormal) {
                // Legacy short round-robin dwell, unchanged — still drives
                // Menu/CalPrep/CalSampling/CalStats. Calibration's timing
                // (20s / 28 sweeps) is built around this fixed ~700ms full-
                // cycle cadence, and it's the only thing besides the RF
                // worker allowed to touch the CC1101, so it must not run
                // while EmScanModeNormal (worker owns the radio then) —
                // enforced by this if/else, and by starting/stopping the
                // worker exactly on Normal-mode entry/exit below.
                int band = app->sweep_band;
                float peak;
                em_scan_rf_dwell_band(band, &peak);

                furi_mutex_acquire(app->mutex, FuriWaitForever);
                app->rssi_dbm[band] = peak;
                app->sweep_band = (band + 1) % EM_SCAN_NUM_FREQS;

                for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
                    if(app->rssi_dbm[i] > app->peak_hold_dbm[i]) {
                        app->peak_hold_dbm[i] = app->rssi_dbm[i];
                    } else {
                        app->peak_hold_dbm[i] -= EM_SCAN_PEAK_DECAY_DB_PER_TICK;
                        if(app->peak_hold_dbm[i] < app->rssi_dbm[i]) {
                            app->peak_hold_dbm[i] = app->rssi_dbm[i];
                        }
                    }
                }

                if(app->mode == EmScanModeCalPrep) {
                    if(app->cal_prep_ticks_left > 0) {
                        app->cal_prep_ticks_left--;
                    }
                    if(app->cal_prep_ticks_left == 0) {
                        app->mode = EmScanModeCalSampling;
                        app->cal_sample_ticks_left = 20 * TICK_HZ;
                        app->cal_sweep_count = 0;
                    }
                } else if(app->mode == EmScanModeCalSampling) {
                    if(app->sweep_band == 0 && app->cal_sweep_count < 64) {
                        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
                            app->cal_samples[app->cal_sweep_count][i] = app->rssi_dbm[i];
                        }
                        app->cal_sweep_count++;
                    }

                    if(app->cal_sample_ticks_left > 0) {
                        app->cal_sample_ticks_left--;
                    }
                    if(app->cal_sample_ticks_left == 0) {
                        em_scan_cal_compute_stats(
                            (const float(*)[EM_SCAN_NUM_FREQS])app->cal_samples,
                            app->cal_sweep_count,
                            app->cal_computed_floors,
                            app->cal_computed_std_devs);

                        app->cal_passed = (app->cal_sweep_count >= 5);
                        if(app->cal_passed) {
                            for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
                                if(app->cal_computed_std_devs[i] >= EM_SCAN_CAL_MAX_STD_DEV_DB) {
                                    app->cal_passed = false;
                                    break;
                                }
                            }
                        }

                        app->mode = EmScanModeCalStats;
                        cal_just_finished = true;
                        cal_passed_result = app->cal_passed;
                    }
                }
            } else {
                // EmScanModeNormal: the RF worker thread owns sampling
                // (long park per band, round-robin). The tick loop just
                // pulls its latest snapshot for the UI and CSV row, on the
                // tick's own 100ms cadence — decoupled from however long
                // the worker takes to cycle all 7 bands, so logging
                // resolution doesn't depend on park duration.
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                em_scan_rf_worker_get_snapshot(app->rf_worker, app->rssi_dbm, app->peak_hold_dbm);

                if(app->recording) {
                    if(!em_scan_log_row(app)) {
                        FURI_LOG_E("EmScan", "CSV row build/append failed");
                    }
                    app->total_ticks++;
                    if(++app->flush_counter >= TICK_HZ) {
                        app->flush_counter = 0;
                        if(sd_logger_batch_flush(app->logger) < 0) {
                            FURI_LOG_E("EmScan", "Batch flush failed — stopping recording");
                            sd_logger_stop(app->logger);
                            app->recording = false;
                        }
                    }
                }
            }
            furi_mutex_release(app->mutex);

            if(cal_just_finished) {
                biomap_sound_success(true);
                notification_message(
                    app->notifications,
                    cal_passed_result ? &sequence_blink_green_100 : &sequence_blink_red_100);
            }
            view_port_update(app->vp);
            continue;
        }

        if(ev.type == EventTypeKey) {
            if(app->mode == EmScanModeMenu) {
                if(ev.input.type == InputTypeShort) {
                    if(ev.input.key == InputKeyUp) {
                        app->menu_selection = (app->menu_selection - 1 < 0) ? 2 : (app->menu_selection - 1);
                        biomap_sound_click(true);
                    } else if(ev.input.key == InputKeyDown) {
                        app->menu_selection = (app->menu_selection + 1 >= 3) ? 0 : (app->menu_selection + 1);
                        biomap_sound_click(true);
                    } else if(ev.input.key == InputKeyOk) {
                        biomap_sound_confirm(true);
                        if(app->menu_selection == 0) {
                            app->mode = EmScanModeNormal; // Enter live walk scan screen
                            // Radio ownership handoff: the legacy tick-driven
                            // dwell above is now gated out of this mode, so
                            // the worker must be the one actively tuning —
                            // starting it here (rather than once at app
                            // init) keeps the CC1101 idle/untouched whenever
                            // the user isn't actually on the live scan
                            // screen.
                            em_scan_rf_worker_start(app->rf_worker);
                        } else if(app->menu_selection == 1) {
                            em_scan_start_calibration_wizard(app); // Launch Faraday Wizard
                        } else if(app->menu_selection == 2) {
                            em_scan_cal_reset(app->storage);
                            app->is_calibrated = false;
                            biomap_sound_reset(true);
                        }
                    } else if(ev.input.key == InputKeyBack) {
                        biomap_sound_back(true);
                        running = false; // Exit application
                    }
                }
            } else if(app->mode == EmScanModeNormal) {
                if(ev.input.type == InputTypeShort) {
                    if(ev.input.key == InputKeyBack) {
                        if(app->recording) {
                            em_scan_toggle_recording(app);
                        }
                        em_scan_rf_worker_stop(app->rf_worker);
                        app->mode = EmScanModeMenu; // Return to Main Menu
                        biomap_sound_back(true);
                    } else if(ev.input.key == InputKeyOk) {
                        em_scan_toggle_recording(app);
                    }
                }
            } else if(app->mode == EmScanModeCalPrep) {
                if(ev.input.type == InputTypeShort) {
                    if(ev.input.key == InputKeyBack) {
                        app->mode = EmScanModeMenu;
                        biomap_sound_back(true);
                    } else if(ev.input.key == InputKeyOk) {
                        app->mode = EmScanModeCalSampling;
                        app->cal_sample_ticks_left = 20 * TICK_HZ;
                        app->cal_sweep_count = 0;
                        biomap_sound_confirm(true);
                    }
                }
            } else if(app->mode == EmScanModeCalSampling) {
                if(ev.input.type == InputTypeShort && ev.input.key == InputKeyBack) {
                    app->mode = EmScanModeMenu;
                    biomap_sound_back(true);
                }
            } else if(app->mode == EmScanModeCalStats) {
                if(ev.input.type == InputTypeShort) {
                    if(ev.input.key == InputKeyOk && app->cal_passed) {
                        EmScanCal cal;
                        memset(&cal, 0, sizeof(cal));
                        cal.timestamp = (uint32_t)furi_get_tick();
                        memcpy(cal.noise_floor_dbm, app->cal_computed_floors, sizeof(cal.noise_floor_dbm));
                        memcpy(cal.noise_std_dev_db, app->cal_computed_std_devs, sizeof(cal.noise_std_dev_db));
                        cal.sample_count = app->cal_sweep_count;

                        if(em_scan_cal_save(&cal, app->storage)) {
                            app->cal_data = cal;
                            app->is_calibrated = true;
                            biomap_sound_confirm(true);
                        } else {
                            biomap_sound_error(true);
                        }
                        app->mode = EmScanModeMenu;
                    } else if(ev.input.key == InputKeyBack || (ev.input.key == InputKeyOk && !app->cal_passed)) {
                        app->mode = EmScanModeMenu;
                        biomap_sound_back(true);
                    }
                }
            }
            view_port_update(app->vp);
        }
    }

    if(app->recording) {
        sd_logger_batch_flush(app->logger);
        sd_logger_stop(app->logger);
    }
    // Worker must be fully stopped (joined) before the radio is powered
    // down and before gps is freed — em_scan_rf_worker_free() stops it
    // internally, so this ordering guarantees no worker iteration is still
    // in flight touching either. Normal mode's Back handler already stops
    // it on the common path; this is the defensive belt-and-braces path
    // for exiting straight from Menu.
    em_scan_rf_worker_free(app->rf_worker);
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
