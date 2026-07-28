// Bio Mapping — recording session event loop and module lifecycle.
//
// Pure-math pipeline functions (IIR, graph, auto-zoom, CSV formatting
// helpers, GPS position extraction) live in biomap_pipeline.c — they
// include no Flipper SDK headers and are testable on a host compiler.
//
// This file owns the Flipper-specific event loop: timer ticks, UART
// events, key dispatch, LED notifications, and module (de)init.
#include "biomap.h"

// ── Custom notification sequences ─────────────────────────────────────────

// 500 ms blink — much more visible than the standard 100 ms flash.
// Green for normal recording, red when cuffs are disconnected.
static const NotificationSequence sequence_blink_green_500 = {
    &message_green_255,
    &message_delay_500,
    &message_green_0,
    NULL,
};
static const NotificationSequence sequence_blink_red_500 = {
    &message_red_255,
    &message_delay_500,
    &message_red_0,
    NULL,
};
// (sequence_blink_blue_100 is a standard SDK sequence — no
// need to redefine it.)

// ── Final flush before a normal (user-initiated) stop ──────────────────────
// sd_logger_batch_flush() no longer discards the batch on a failed write
// (see modules/sd_logger.c), so a single retry here actually re-sends the
// same bytes rather than flushing an already-emptied buffer — cheap
// insurance against a transient SD-busy blip, the most common real-world
// failure mode. If it still fails, the file is genuinely missing its last
// few seconds of data; the caller must know so it can warn the user
// instead of playing the ordinary "recording stopped" chirp, which would
// otherwise be indistinguishable from a clean stop.
// Returns true if the buffer was confirmed empty (nothing lost).
static bool flush_before_stop(SdLogger* logger) {
    if(sd_logger_batch_flush(logger) >= 0) return true;
    FURI_LOG_E("BioMap", "Final batch flush failed, retrying once");
    if(sd_logger_batch_flush(logger) >= 0) return true;
    FURI_LOG_E("BioMap", "Final batch flush failed after retry — recording is incomplete");
    return false;
}

// ==========================================================================
// Session lifecycle
// ==========================================================================

void session_init(Session* s, BioMapMode mode, bool zoom_enabled) {
    *s = (Session){
        .mode       = mode,
        .pipeline   = {.display = {.smooth_iir = 0.0f, .smooth_iir_primed = false,
                                   .smoothed = 0.0f, .primed = false,
                                   .last_displayed = 0, .raw_sample_ns = 0.0f,
                                   .filtered_ns = 0.0f, .refresh_counter = 0},
                       .graph   = {.head = 0, .tick_counter = 0,
                                   .last_smoothed = 0.0f, .scroll_divider = 1},
                       .zoom    = {.level = 1.0f, .peak = 1.0f, .enabled = zoom_enabled,
                                   .manual_timeout = 0}},
        .recording  = {.active = false, .tick_counter = 0, .flush_counter = 0},
        .running    = true,
        .gsr_alert_sounded = false,
    };
    memset(s->pipeline.graph.buf, 0, sizeof(s->pipeline.graph.buf));
}

void session_deinit(Session* s, BioMapApp* app) {
    if(s->timer) {
        furi_timer_stop(s->timer);
        furi_timer_free(s->timer);
        s->timer = NULL;
    }
    if(s->recording.active && s->logger) {
        // Defensive fallback only — in normal operation the Back-key
        // handler and key_toggle_recording's stop path already clear
        // recording.active and flush before this runs, so this branch is
        // a no-op. Kept in sync with those call sites' failure handling
        // in case a future exit path ever reaches here with recording
        // still active.
        if(!flush_before_stop(s->logger)) biomap_sound_warning(app->sound_enabled);
        sd_logger_stop(s->logger);
    }
    if(s->logger) {
        sd_logger_free(s->logger);
        s->logger = NULL;
    }
    if(s->gsr) {
        gsr_sensor_free(s->gsr);
        s->gsr = NULL;
    }
    if(s->rf_worker) {
        em_scan_rf_worker_free(s->rf_worker); // stops + joins internally
        s->rf_worker = NULL;
        em_scan_rf_deinit();
    }
    if(s->gps) {
        gps_uart_free(s->gps);
        s->gps = NULL;
    }
    // Restore auto backlight when leaving recording view
    notification_message(app->notifications, &sequence_display_backlight_enforce_auto);
    if(s->vp) {
        // s->vp is app->screen_vp — the single persistent fullscreen
        // ViewPort shared by every screen. Disable it and clear its draw
        // callback, but never remove/free it here: doing so (the old
        // behavior) left a window with zero enabled fullscreen ViewPorts
        // in the GUI stack, which let the desktop/dolphin flash through
        // before the next screen re-enabled it.
        view_port_enabled_set(s->vp, false);
        view_port_draw_callback_set(s->vp, NULL, NULL);
        s->vp = NULL;
    }
}

// ==========================================================================
// Data-processing pipeline (static — operate on Session* only)
// ==========================================================================

// ── Convenience wrapper: GpsStatus → GpsPosition ──────────────────────
static inline GpsPosition get_gps_position(const Session* s) {
    GpsPosition pos = {0};
    pos.hdop       = 99.9f; pos.pdop = 99.9f; pos.hacc = 99.9f; pos.fix_type = 1;
    pos.speed_kts  = NAN;   pos.course_deg = NAN;
    if(!s->gps) return pos;
    GpsStatus gs = gps_uart_get_status(s->gps);
    pos.sats       = gs.satellites_tracked;
    pos.hdop       = gs.hdop;
    pos.fix_type   = gs.fix_type;
    pos.speed_kts  = gs.speed;
    pos.course_deg = gs.course;
    pos.pdop       = gs.pdop;
    pos.hacc       = gs.hacc;
    if((gs.fix_valid || gs.fix_quality > 0)
        && !isnan(gs.latitude) && !isnan(gs.longitude)) {
        pos.valid = true;
        pos.lat = gs.latitude;
        pos.lon = gs.longitude;
    }
    return pos;
}

// ── Shared GPS CSV row formatter ───────────────────────────────────────────
// Formats an 11-column GPS row into the SD batch buffer with an explicit GSR
// value and hacc_m (horizontal accuracy in meters, PUBX 00; 99.9 = unknown)
// trailing.  Used by both GPS+GSR mode (via batch_csv_row with the live GSR
// reading) and GPS-only mode (via handle_recording_tick with raw=0).  When
// the fix is absent or HDOP is too high, GPS columns are left empty so the
// analyser treats the row as a gap rather than noise.
//
// rf_rssi is NULL when RF scanning isn't active for this session, otherwise
// a fresh EM_SCAN_NUM_FREQS-element snapshot — appended as 3 extra columns
// (rssi_815,rssi_868,rssi_915, matching BIOMAP_CSV_COLS_GPS_GSR_RF).
//
// Builds the whole row into a local stack buffer via snprintf, then makes
// ONE sd_logger_batch_append() call — deliberately not two separate
// sd_logger_batch_printf() calls into the shared SD batch buffer directly.
// Each batch_printf call is individually atomic (all-or-nothing against
// the shared buffer), but two SEPARATE calls are not atomic as a pair: if
// the first (GPS/GSR columns) succeeded and the second (RF suffix) then
// failed because the buffer filled up in between, the first call's bytes
// are already committed with no trailing newline, corrupting the CSV by
// gluing the next row onto the same line. Building locally first and
// appending once (same pattern em_scan_log_row() already used) keeps the
// whole row atomic — batch_append() itself checks capacity before writing
// any bytes (see modules/sd_logger.c).
// Returns true on success, false on buffer overflow.
static bool format_gps_csv_row(Session* s, const GpsPosition* pos,
                                double rel, float raw, const float* rf_rssi) {
    bool gps_ok = pos->valid && pos->hdop < GPS_HDOP_GATE;
    // static, not a stack local: this runs on the main app thread's tick
    // path every ~100ms during a real recording, alongside GPS/GSR/RF
    // worker-management call chains that weren't all exercised together
    // before this merge (see the em_scan_rf_worker.c stack-size bump made
    // alongside this, prompted by a real on-device crash during the first
    // sustained outdoor GPS+GSR+RF walk). Safe as static since this
    // function is never reentrant or called concurrently — always one
    // call at a time from the single main app thread's tick handler.
    static char row[256];
    int n;
    if(gps_ok) {
        bool has_vel = !isnan(pos->speed_kts) && !isnan(pos->course_deg);
        if(has_vel) {
            n = snprintf(row, sizeof(row),
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f,%.1f",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type,
                (double)pos->speed_kts, (double)pos->course_deg, (double)raw,
                (double)pos->hacc);
        } else {
            n = snprintf(row, sizeof(row),
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,,,%.1f,%.1f",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type, (double)raw, (double)pos->hacc);
        }
    } else {
        n = snprintf(row, sizeof(row), "%.2f,,,,,,,,,%.1f,",
                     rel, (double)raw);
    }
    if(n <= 0 || (size_t)n >= sizeof(row)) return false;

    if(rf_rssi) {
        n += snprintf(row + n, sizeof(row) - (size_t)n, ",%.1f,%.1f,%.1f\n",
                     (double)rf_rssi[0], (double)rf_rssi[1], (double)rf_rssi[2]);
    } else {
        n += snprintf(row + n, sizeof(row) - (size_t)n, "\n");
    }
    if(n <= 0 || (size_t)n >= sizeof(row)) return false;

    return sd_logger_batch_append(s->logger, row, (size_t)n);
}

// ── Batch CSV row construction ─────────────────────────────────────────────
// Dispatches to format_gps_csv_row for GPS+GSR mode; handles GSR-only
// and GPS-skip ticks directly.  Rows are flushed at the 1‑second boundary
// by handle_second_boundary().
//
// rf_rssi is fetched by the caller BEFORE app->mutex is acquired (see the
// Tick handler below) rather than here — em_scan_rf_worker_get_snapshot()
// briefly blocks on the RF worker's own internal mutex, and this function
// runs entirely inside an app->mutex-held critical section that
// biomap_render_callback() also needs to draw. The same principle
// handle_write_failure()'s comment already documents for sound calls
// applies here: nothing that can block, even briefly, belongs inside that
// section, or the recording screen's redraw gets delayed.
// Returns true on success, false on buffer overflow.
static bool batch_csv_row(Session* s, float raw, const float* rf_rssi) {
    if(!s->recording.active || !has_gsr(s->mode)) return true;

    double rel = pipeline_rel_seconds(s->recording.total_ticks);
    int ret;

    if(s->mode == BioMapModeGsrOnly) {
        ret = sd_logger_batch_printf(s->logger, "%.2f,%.1f\n",
                                     rel, (double)raw);
    } else if(s->recording.tick_counter % (TICK_HZ / GPS_CSV_HZ) == 0) {
        GpsPosition pos = get_gps_position(s);
        return format_gps_csv_row(s, &pos, rel, raw, rf_rssi);
    } else {
        // GPS-skip tick: preserve GSR data with empty GPS columns.
        GpsPosition empty = {0};
        return format_gps_csv_row(s, &empty, rel, raw, rf_rssi);
    }
    return ret > 0;
}

// ── Write failure handler ──────────────────────────────────────────────────
// Stop the logger, clear recording state, and signal with red LED.
// Returns true when the caller should play the warning tone.
//
// IMPORTANT: this function (and handle_second_boundary below) must NOT play
// sound itself. Both are called from run_recording_session()'s Tick handler
// while app->mutex is held, and biomap_render_callback() needs that same
// mutex to draw. biomap_sound_warning() blocks for ~250 ms (see
// modules/sound.h) — playing it here would hold the mutex for that long and
// freeze the recording screen. The caller must release app->mutex first,
// then play the tone using this return value.
static bool handle_write_failure(Session* s, NotificationApp* notifications) {
    if(s->logger) sd_logger_stop(s->logger);
    s->recording.active = false;
    notification_message(notifications, &sequence_set_only_red_255);
    return true;
}

// ── 1‑second boundary ──────────────────────────────────────────────────────
// Called once per second.  Blinks the recording LED at 1 Hz and flushes the
// SD batch buffer every FLUSH_INTERVAL seconds (decoupled — LED always 1 Hz).
// GPS rows are written in handle_recording_tick; GSR rows in batch_csv_row.
// Returns true when the caller should play the warning tone (see
// handle_write_failure's comment above — the same mutex-hold constraint
// applies here, so this function only signals the need for a tone; it
// never calls into modules/sound.h directly).
static bool handle_second_boundary(Session* s, NotificationApp* notifications) {
    if(!s->recording.active) {
        s->recording.tick_counter = 0;
        return false;
    }

    bool play_warning = false;

    // ── LED blink (every second, independent of flush interval) ────────
    // 500 ms blink — green when sensor OK, red when cuffs need attention.
    // The warning tone fires once per disconnect episode (edge-triggered
    // via gsr_alert_sounded), not every second — otherwise a loose
    // electrode would nag continuously for the rest of the walk.
    if(has_gsr(s->mode) && s->gsr && !gsr_sensor_is_connected(s->gsr)) {
        notification_message(notifications, &sequence_blink_red_500);
        if(!s->gsr_alert_sounded) {
            play_warning = true;
            s->gsr_alert_sounded = true;
        }
    } else {
        notification_message(notifications, &sequence_blink_green_500);
        s->gsr_alert_sounded = false;
    }
    // Brief blue blip after the main blink when GPS has no fix.
    if(has_gps(s->mode) && s->gps) {
        GpsPosition pos = get_gps_position(s);
        bool gps_ready = pos.valid && pos.hdop < GPS_HDOP_GATE;
        if(!gps_ready) {
            notification_message(notifications, &sequence_blink_blue_100);
        }
    }

    // ── SD flush (every FLUSH_INTERVAL seconds) ────────────────────────
    if(++s->recording.flush_counter >= FLUSH_INTERVAL) {
        s->recording.flush_counter = 0;
        int flushed = sd_logger_batch_flush(s->logger);
        if(flushed < 0) {
            FURI_LOG_E("BioMap", "Batch flush failed");
            if(handle_write_failure(s, notifications)) play_warning = true;
        }
    }

    s->recording.tick_counter = 0;
    return play_warning;
}

// ==========================================================================
// Recording session — key handling, tick processing, event loop
// ==========================================================================

// ── Key-action helpers (extracted from handle_recording_key) ──────────────

// GSR ring buffer settle time after a tone.
//
// modules/gsr_sensor.h's SENSOR_BUFFER_SIZE (128) buffer holds roughly the
// last 128 ms of worker-loop writes (the background worker does one
// ADS1115 read + buffer write per ~1 ms furi_delay_ms(1) iteration). The
// recording_start chirp itself already runs ~168 ms (see modules/sound.h),
// which is longer than the buffer — so by the moment the chirp finishes,
// the buffer's OLDEST entry is already ~(168-128)=40 ms into the tone, i.e.
// every single entry in the ring buffer was captured while the speaker was
// driven. For that buffer to contain ONLY post-tone samples, we then need
// to wait a further ~128 ms past the end of the chirp — plus headroom for
// RTOS scheduling jitter on the worker thread (its 1 ms delay is nominal,
// not guaranteed exact under load). 200 ms gives ~70 ms of margin over the
// bare-minimum 128 ms, which comfortably covers that jitter.
#define GSR_TONE_SETTLE_MS 200

// Toggle recording on/off.  Returns true to request a view_port_update.
// Plays a rising chirp on a successful start, a falling chirp on stop, and
// an error tone if starting failed (header build or SD open error) — the
// audio cue for start/stop matters most here since there's no on-screen
// confirmation beyond the small recording-indicator box in the corner.
//
// ── GSR + Sound: keep tones fully outside the recorded window ─────────────
// The piezo speaker and the ADS1115/TIA front-end share the same 3.3V rail,
// and this is a breadboard build, so a tone is a plausible (if unverified)
// source of electrical noise on the sensitive GSR signal. Two rules, both
// enforced below:
//   START: play the chirp (and let the buffer settle) BEFORE
//          s->recording.active flips true. batch_csv_row()/handle_recording_
//          tick() gate all GSR logging on that flag, so nothing can be
//          written until the tone — and a settle period long enough for the
//          ADC ring buffer to fully refill with post-tone samples — is over.
//          The file is opened and the header written beforehand (that's
//          pure SD I/O, not GSR-related, so it's safe to do first).
//   STOP:  clear s->recording.active and fully close the file
//          (sd_logger_stop) BEFORE playing the chirp — never after. Once the
//          flag is false and the file handle is gone, nothing the tone
//          might do to the ADC reading can reach the recording.
static bool key_toggle_recording(Session* s, FuriMutex* mutex,
                                  NotificationApp* notifications, bool sound_enabled,
                                  bool rf_calibrated, const float* rf_cal_floors) {
    bool start;
    furi_mutex_acquire(mutex, FuriWaitForever);
    start = !s->recording.active;
    furi_mutex_release(mutex);

    if(start) {
        // Build header: recording-start metadata line + column names.
        DateTime dt;
        furi_hal_rtc_get_datetime(&dt);
        uint32_t epoch = pipeline_unix_epoch(dt.year, dt.month, dt.day,
                                              dt.hour, dt.minute, dt.second);
        if(epoch == 0) {
            FURI_LOG_W("BioMap", "RTC not set — recording epoch will be 0 in CSV header");
        }
        const char* cols;
        if(s->mode == BioMapModeGsrOnly) {
            cols = BIOMAP_CSV_COLS_GSR_ONLY;
        } else if(s->rf_worker) {
            cols = BIOMAP_CSV_COLS_GPS_GSR_RF;
        } else {
            cols = BIOMAP_CSV_COLS_GPS_GSR;
        }
        // 320 bytes (not 256) to comfortably fit the optional Band Floors
        // line below — em_scan.c's own header build hit silent truncation
        // at 192 bytes once a calibrated Band Floors line was added; sizing
        // generously here avoids repeating that.
        char header[320];
        int n = snprintf(header, sizeof(header),
                         "# RecordingStartTime:%lu\n", (unsigned long)epoch);
        // Band Floors line: only meaningful once RF is both active for this
        // session (s->rf_worker set) and a real calibration exists — order
        // (815,868,915) matches em_scan_freq_label[] in em_scan_rf.c.
        if(s->rf_worker && rf_calibrated && n > 0 && (size_t)n < sizeof(header)) {
            n += snprintf(header + n, sizeof(header) - (size_t)n,
                         "# Band Floors (dBm): 815:%.1f,868:%.1f,915:%.1f\n",
                         (double)rf_cal_floors[0], (double)rf_cal_floors[1], (double)rf_cal_floors[2]);
        }
        if(n > 0 && (size_t)n < sizeof(header)) {
            n += snprintf(header + n, sizeof(header) - (size_t)n, "%s", cols);
        }
        if(n < 0 || (size_t)n >= sizeof(header)) {
            FURI_LOG_E("BioMap", "Header too long");
            biomap_sound_error(sound_enabled);
            return false;
        }
        bool ok = sd_logger_start(s->logger, header);
        if(ok) {
            // Chirp + settle BEFORE recording.active goes true (see the
            // "GSR + Sound" note above) — this is pure air time for the
            // speaker, no file or GSR state has changed yet at this point.
            biomap_sound_recording_start(sound_enabled);
            if(sound_enabled) furi_delay_ms(GSR_TONE_SETTLE_MS);

            furi_mutex_acquire(mutex, FuriWaitForever);
            s->recording.active = true;
            s->recording.tick_counter = 0;
            s->recording.total_ticks  = 0;
            furi_mutex_release(mutex);
            // Recording indicator: the green LED flash from
            // handle_second_boundary is used instead of a solid red LED.
            // This avoids a notification-layer conflict where the green
            // blink sequence clears the red LED state.
        } else {
            biomap_sound_error(sound_enabled);
        }
    } else {
        furi_mutex_acquire(mutex, FuriWaitForever);
        s->recording.active = false;
        bool flush_ok = flush_before_stop(s->logger);
        furi_mutex_release(mutex);
        sd_logger_stop(s->logger);
        notification_message(notifications, &sequence_blink_stop);
        // Recording is fully stopped (flag cleared, file closed) above —
        // only now is it safe to play the tone. A failed final flush means
        // the file is missing its last few seconds of data — the ordinary
        // stop chirp would sound identical to a clean stop, so use the
        // warning tone instead to make the failure audible.
        if(flush_ok) {
            biomap_sound_recording_stop(sound_enabled);
        } else {
            biomap_sound_warning(sound_enabled);
        }
    }
    return true;  // caller should view_port_update
}

// Manual vertical zoom (Up=zoom in, Down=zoom out).  Sets a timeout after
// which auto-zoom re-engages (if enabled in Options).  Each keypress resets
// the timeout so continuous adjustment keeps auto-zoom paused.
// Returns whether a recording was active at the time of the change — reused
// (not re-locked) by the caller to decide whether to play the zoom click:
// per the "GSR + Sound" note on key_toggle_recording, any tone while
// recording.active is a plausible (if likely small, given the click is only
// 35 ms) source of electrical noise on the shared 3.3V rail, so clicks are
// suppressed entirely during an active recording rather than risked.
static bool key_zoom_vertical(Session* s, FuriMutex* mutex, bool zoom_in) {
    furi_mutex_acquire(mutex, FuriWaitForever);
    s->pipeline.zoom.manual_timeout = MANUAL_ZOOM_TIMEOUT;
    s->pipeline.zoom.level = zoom_in
        ? fminf(s->pipeline.zoom.level * ZOOM_FACTOR, ZOOM_MAX)
        : fmaxf(s->pipeline.zoom.level / ZOOM_FACTOR, ZOOM_MIN);
    bool recording = s->recording.active;
    furi_mutex_release(mutex);
    return recording;
}

// Horizontal time-axis zoom (Left=zoom out, Right=zoom in).
// Returns whether a recording was active — see key_zoom_vertical's comment.
static bool key_zoom_horizontal(Session* s, FuriMutex* mutex, bool zoom_out) {
    furi_mutex_acquire(mutex, FuriWaitForever);
    if(zoom_out) {
        if(s->pipeline.graph.scroll_divider < 16) {
            s->pipeline.graph.scroll_divider *= 2;
            s->pipeline.graph.tick_counter = 0;
            s->pipeline.graph.last_smoothed = s->pipeline.display.smoothed;
            pipeline_rescale_graph(&s->pipeline, true);
        }
    } else {
        if(s->pipeline.graph.scroll_divider > 1) {
            s->pipeline.graph.scroll_divider /= 2;
            s->pipeline.graph.tick_counter = 0;
            s->pipeline.graph.last_smoothed = s->pipeline.display.smoothed;
            pipeline_rescale_graph(&s->pipeline, false);
        }
    }
    bool recording = s->recording.active;
    furi_mutex_release(mutex);
    return recording;
}

// ── Handle one key press during a recording session ────────────────────────
// Returns true if the event was consumed (the caller should continue its
// event loop without further processing for this iteration).
static bool handle_recording_key(PluginEvent* ev, Session* s,
                                  FuriMutex* mutex, ViewPort* vp, bool sound_enabled) {
    if(ev->type != EventTypeKey || ev->input.type != InputTypeShort)
        return false;

    switch(ev->input.key) {
    case InputKeyBack: {
        furi_mutex_acquire(mutex, FuriWaitForever);
        bool was_recording = s->recording.active;
        bool flush_ok = true;
        if(was_recording) {
            // Fully stop here — clear the flag and flush — rather than
            // leaving it for session_deinit() to close later. Same "GSR +
            // Sound" rule as key_toggle_recording's stop path: the file
            // must already be closed before the tone plays, not after.
            s->recording.active = false;
            flush_ok = flush_before_stop(s->logger);
        }
        s->running = false;
        furi_mutex_release(mutex);

        if(was_recording) {
            sd_logger_stop(s->logger); // close the file BEFORE the tone
            // session_deinit()'s own stop-on-active check is now a no-op
            // (recording.active is already false), so this is the only
            // place that closes the file for this path.
            // A failed final flush leaves the file short of its last few
            // seconds — use the warning tone rather than the ordinary stop
            // chirp so that's audible instead of indistinguishable.
            if(flush_ok) {
                biomap_sound_recording_stop(sound_enabled);
            } else {
                biomap_sound_warning(sound_enabled);
            }
        } else {
            biomap_sound_back(sound_enabled);
        }
        return true;
    }

    case InputKeyOk:
        // key_toggle_recording needs NotificationApp* — pass NULL for now;
        // the actual notifications pointer is available in the caller.
        // (This is caught at build time — see the caller below.)
        return false;  // handled by caller with full context

    case InputKeyUp:
        if(has_gsr(s->mode)) {
            // No click while actively recording — see key_zoom_vertical's
            // comment. Zoom itself still works either way; only the tone
            // is suppressed.
            if(!key_zoom_vertical(s, mutex, true)) biomap_sound_click(sound_enabled);
            view_port_update(vp);
        }
        return true;
    case InputKeyDown:
        if(has_gsr(s->mode)) {
            if(!key_zoom_vertical(s, mutex, false)) biomap_sound_click(sound_enabled);
            view_port_update(vp);
        }
        return true;

    case InputKeyLeft:
        if(has_gsr(s->mode)) {
            if(!key_zoom_horizontal(s, mutex, true)) biomap_sound_click(sound_enabled);
            view_port_update(vp);
        }
        return true;
    case InputKeyRight:
        if(has_gsr(s->mode)) {
            if(!key_zoom_horizontal(s, mutex, false)) biomap_sound_click(sound_enabled);
            view_port_update(vp);
        }
        return true;

    default:
        return false;
    }
}

// ── Handle one GSR tick (10 Hz) during a recording session ────────────────
// rf_rssi: see batch_csv_row's comment — fetched by the caller before
// app->mutex is held, not in here.
// Returns true on success, false if a batch overflow occurred (caller should
// flush and potentially stop recording).
static bool handle_recording_tick(Session* s, const float* rf_rssi) {
    // ── GPS-only mode: write a row on the GPS tick boundary ────────────
    if(!has_gsr(s->mode) && has_gps(s->mode) && s->recording.active) {
        if(s->recording.tick_counter % (TICK_HZ / GPS_CSV_HZ) == 0) {
            GpsPosition pos = get_gps_position(s);
            return format_gps_csv_row(s, &pos, pipeline_rel_seconds(s->recording.total_ticks), 0.0f,
                                       rf_rssi);
        }
        return true;
    }

    // ── GSR modes (GsrOnly, GpsGsr) ────────────────────────────────────
    float raw = 0.0f;
    if(s->gsr) {
        gsr_sensor_tick(s->gsr);                    // autoranging only
        float raw_sample = gsr_sensor_get_raw_sample_ns(s->gsr);  // pure single-sample nS
        raw = gsr_sensor_get_raw(s->gsr);           // filtered 100-sample nS (CSV)
        s->pipeline.display.raw_sample_ns = raw_sample;      // store BEFORE IIR touches it
        s->pipeline.display.filtered_ns   = raw;             // store BEFORE IIR touches it
        s->pipeline.display.raw_sample_count = gsr_sensor_get_raw_sample_count(s->gsr);

        // ── Instantaneous per-tick validity check ────────────────────
        // Use the raw single-sample value for the display so you see
        // the unfiltered hardware reading.  The filtered value still
        // goes to CSV for clean recordings.
        bool valid = (raw_sample >= GSR_VALID_MIN_NS && raw_sample <= GSR_VALID_MAX_NS);
        if(valid) {
            // ── Re-connect smoothing ────────────────────────────────
            float delta = (raw_sample > s->pipeline.display.last_displayed)
                ? raw_sample - s->pipeline.display.last_displayed
                : s->pipeline.display.last_displayed - raw_sample;
            bool recovering = s->pipeline.display.primed && (delta > 500.0f);

            pipeline_update_display(&s->pipeline, raw_sample);

            if(recovering) {
                s->pipeline.graph.last_smoothed = s->pipeline.display.smoothed;
            }

            pipeline_update_graph(&s->pipeline);
        }
    }
    return batch_csv_row(s, raw, rf_rssi);
}

// ── Run a recording session for the given mode ─────────────────────────────
// Blocks until the user presses Back or an unrecoverable error occurs.
// Allocates modules via session_init(); cleans up via session_deinit().
void run_recording_session(BioMapApp* app, BioMapMode mode) {
    Session* s = &app->session;
    session_init(s, mode, app->zoom_enabled);

    // Reuse the single persistent screen ViewPort (already in the GUI
    // stack, currently disabled) rather than allocating a new one, and do
    // it BEFORE the module allocations below. gps_uart_alloc() blocks for
    // several hundred ms (it does multiple furi_delay_ms(100) waits while
    // bringing up the UART) — if the ViewPort were left disabled across
    // that sleep, the app thread is guaranteed to yield for long enough
    // that the GUI's redraw thread runs, finds no enabled fullscreen
    // ViewPort, and paints the desktop/dolphin fallback. That's the flash
    // seen specifically on "GPS Only" / "GPS + GSR" (both call
    // gps_uart_alloc()) and not on Options/GSR-only, which don't have a
    // comparable blocking wait before their screen was shown.
    //
    // session_init() already zeroed s->gps/s->gsr/s->logger to NULL and
    // set s->mode, and biomap_render_callback() null-checks all three, so
    // it's safe to start rendering the recording screen immediately —
    // it'll just show "GPS unavailable"/no graph until the modules below
    // finish initialising, instead of showing nothing (the desktop).
    s->vp = app->screen_vp;
    view_port_draw_callback_set(s->vp, biomap_render_callback, app);
    view_port_enabled_set(s->vp, true);
    view_port_update(s->vp);

    if(has_gps(mode)) {
        s->gps = gps_uart_alloc(app->event_queue, app->notifications, app->nav_model);
    } else {
        gps_uart_standby();
        s->gps = NULL;
    }
    s->gsr    = has_gsr(mode) ? gsr_sensor_alloc() : NULL;
    if(s->gsr) {
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        bool active = app->cal_active;
        float gain = app->cal_gain;
        float offset = app->cal_offset;
        furi_mutex_release(app->mutex);
        gsr_sensor_set_calibration(s->gsr, active, gain, offset);
        // Mains-hum correlator costs ~100 trig calls/tick and is off by
        // default (see gsr_sensor_set_mains_hum_enabled()) — only the
        // Diagnostics screen actually displays it, so only that mode
        // pays for it.
        gsr_sensor_set_mains_hum_enabled(s->gsr, mode == BioMapModeDiagnostics);
    }
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    bool rf_scan_enabled = app->rf_scan_enabled;
    furi_mutex_release(app->mutex);
    if(has_rf(mode) && rf_scan_enabled) {
        em_scan_rf_init();
        s->rf_worker = em_scan_rf_worker_alloc(RF_WORKER_PARK_MS);
        em_scan_rf_worker_start(s->rf_worker);
    } else {
        s->rf_worker = NULL;
    }
    s->logger = sd_logger_alloc(app->storage);
    view_port_update(s->vp);

    // Apply backlight preference
    notification_message(app->notifications,
        app->backlight_on
            ? &sequence_display_backlight_enforce_on
            : &sequence_display_backlight_enforce_auto);

    s->timer = furi_timer_alloc(biomap_timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(s->timer, furi_kernel_get_tick_frequency() / TICK_HZ);

    PluginEvent ev;
    while(s->running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;

        // UART events: drain GPS data without holding the app mutex for
        // the entire parse.  We parse with a dedicated GPS mutex so the
        // GUI render thread is never blocked by NMEA parsing.
        if(ev.type == EventTypeUart && s->gps) {
            gps_uart_process_rx(s->gps);
            // In GSR modes the graph buffer hasn't changed — skip the
            // redraw to avoid unnecessary GUI work.  GPS-only mode still
            // needs the update because the screen shows live GPS details.
            if(!has_gsr(s->mode))
                view_port_update(s->vp);
            continue;
        }

        // Handle OK key inline (needs NotificationApp* which the static
        // helper doesn't have access to).
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
            && ev.input.key == InputKeyOk) {
            if(key_toggle_recording(s, app->mutex, app->notifications, app->sound_enabled,
                                     app->rf_calibrated, app->rf_cal_data.noise_floor_dbm))
                view_port_update(s->vp);
            continue;
        }

        if(handle_recording_key(&ev, s, app->mutex, s->vp, app->sound_enabled))
            continue;

        if(ev.type == EventTypeTick) {
            // Fetch the RF snapshot BEFORE acquiring app->mutex, not inside
            // handle_recording_tick(). em_scan_rf_worker_get_snapshot()
            // briefly blocks on the RF worker's own internal mutex; doing
            // that while already holding app->mutex (which
            // biomap_render_callback() also needs to draw) could delay a
            // redraw every single tick, not just occasionally — see
            // batch_csv_row's comment. Reading s->rf_worker itself without
            // app->mutex here is safe: only this same thread ever writes
            // it (at session setup/teardown, never during the tick loop).
            float rf_rssi[EM_SCAN_NUM_FREQS];
            float rf_peak_hold[EM_SCAN_NUM_FREQS];
            if(s->rf_worker) {
                em_scan_rf_worker_get_snapshot(s->rf_worker, rf_rssi, rf_peak_hold);
            }

            furi_mutex_acquire(app->mutex, FuriWaitForever);
            bool batch_ok = handle_recording_tick(s, s->rf_worker ? rf_rssi : NULL);
            s->recording.total_ticks++;

            bool play_warning = false;
            if(++s->recording.tick_counter >= TICK_HZ) {
                if(handle_second_boundary(s, app->notifications)) play_warning = true;
            }

            // Batch overflow: try an emergency flush.  If even the flush
            // fails, stop recording and notify the user via red LED.
            if(!batch_ok) {
                FURI_LOG_W("BioMap", "Batch overflow — emergency flush");
                int flushed = sd_logger_batch_flush(s->logger);
                if(flushed < 0) {
                    FURI_LOG_E("BioMap", "Emergency flush failed — stopping recording");
                    if(handle_write_failure(s, app->notifications)) play_warning = true;
                }
            }
            furi_mutex_release(app->mutex);

            // Sound is played AFTER releasing app->mutex — biomap_sound_warning()
            // blocks for ~250 ms, and biomap_render_callback() needs this same
            // mutex to draw; holding it across a speaker call would freeze the
            // recording screen for that long (see handle_write_failure's comment).
            if(play_warning) biomap_sound_warning(app->sound_enabled);

            view_port_update(s->vp);
        }
    }

    session_deinit(s, app);
}
