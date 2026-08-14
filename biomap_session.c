// Bio Mapping — recording session event loop and module lifecycle.
//
// Pure-math pipeline functions (IIR, graph, auto-zoom) live in
// biomap_pipeline.c — they include no Flipper SDK headers and are
// testable on a host compiler. CSV formatting and GPS position
// extraction live here, alongside the Flipper-specific state they read.
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

void session_init(Session* s, BioMapMode mode, bool zoom_enabled, bool debug_fields_enabled) {
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
        .ns_label_last = -1.0f,  // sentinel — forces format on first frame (nS ≥ 0 always)
        .debug_fields_enabled = debug_fields_enabled,
    };
    memset(s->pipeline.graph.buf, 0, sizeof(s->pipeline.graph.buf));
}

void session_deinit(Session* s, BioMapApp* app) {
    if(s->timer) {
        furi_timer_stop(s->timer);
        furi_timer_free(s->timer);
        s->timer = NULL;
    }
    // ── Mutex-guarded module teardown ──────────────────────────────────
    // biomap_render_callback() runs on the GUI service's own thread (not
    // this one) and acquires app->mutex before reading s->gsr/s->gps —
    // every other Session mutation in this file (tick handler, key
    // handlers) holds that same mutex for exactly this reason. This
    // function used to be the one exception: it freed s->logger/gsr/
    // gps and only THEN nulled the pointers, all without the
    // mutex, while the ViewPort stays enabled with this screen's draw
    // callback attached until the very end below — a real window for the
    // render thread to read a pointer this thread is mid-free()ing.
    // Narrow normally, but gsr_sensor_free()'s furi_thread_join()
    // can block this thread — by far the slowest step here — so the
    // exposure is real, not theoretical. Held across the whole teardown,
    // not just the RF step, for symmetry with every other Session-mutating
    // call site rather than special-casing one.
    // A blocked render during this window just means a stale-but-valid
    // last frame lingers a little longer on a screen that's leaving
    // anyway — trivial next to the alternative (a torn-down pointer read
    // from another thread).
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    SdLogger* logger = s->logger;
    GsrSensor* gsr = s->gsr;
    GpsUart* gps = s->gps;
    BtStream* bt_stream = s->bt_stream;
    s->logger = NULL;
    s->gsr = NULL;
    s->gps = NULL;
    s->bt_stream = NULL;
    bool active_recording = s->recording.active;
    s->recording.active = false;
    furi_mutex_release(app->mutex);

    if(bt_stream) {
        // bt_profile_restore_default() restarts the BLE co-processor's
        // second core (same doc-comment warning bt_profile_start() carries)
        // — slow, like gsr_sensor_free()'s furi_thread_join() below, which
        // is why this runs after the mutex is released rather than under it.
        bt_stream_stop(bt_stream);
        bt_stream_free(bt_stream);
    }

    if(active_recording && logger) {
        // Defensive fallback only — in normal operation the Back-key
        // handler and key_toggle_recording's stop path already clear
        // recording.active and flush before this runs, so this branch is
        // a no-op. Kept in sync with those call sites' failure handling
        // in case a future exit path ever reaches here with recording
        // still active.
        if(!flush_before_stop(logger)) biomap_sound_warning(app->sound_enabled);
        sd_logger_stop(logger);
    }
    if(logger) {
        sd_logger_free(logger);
    }
    if(gsr) {
        gsr_sensor_free(gsr);
    }
    if(gps) {
        gps_uart_free(gps);
    }

    // Restore auto backlight when leaving recording view.
    biomap_backlight_release(app, false);
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

// ── GPS row cadence: is this tick the GPS sub-sample boundary? ─────────
static inline bool is_gps_row_tick(const Session* s) {
    return s->recording.tick_counter % (TICK_HZ / GPS_CSV_HZ) == 0;
}

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

// ── Contention-diagnostic snapshot (2026-07-31) ─────────────────────────
// Always computed regardless of Session::debug_fields_enabled (2026-08-05
// — these are cheap accessor reads, no reason to branch on the runtime
// toggle here too; the toggle only decides whether the result gets
// written into the CSV, in format_gps_csv_row()/batch_csv_row() below).
// The only place that reads s->gps/s->gsr for RowDiag — see format_gps_csv_row's
// doc comment. Null-guards both: format_gps_csv_row's callers all currently
// guarantee non-NULL s->gsr/s->gps in practice (see gsr_sensor_get_worker_hz's
// callers and has_rf()/has_gps() gating in run_recording_session), but this
// stays defensive rather than relying on that holding forever.
static inline RowDiag get_row_diag(const Session* s) {
    RowDiag d = {0};
    d.tick_dt_ms   = s->recording.tick_dt_ms;
    d.gps_rx_drops = s->gps ? gps_uart_get_rx_drop_count(s->gps) : 0;
    d.nmea_fail    = s->gps ? gps_uart_get_nmea_fail_count(s->gps) : 0;
    d.gps_reinit_count = s->gps ? gps_uart_get_reinit_count(s->gps) : 0;
    d.gsr_hz       = s->gsr ? gsr_sensor_get_worker_hz(s->gsr) : 0.0f;
    d.i2c_peak_ms       = s->gsr ? gsr_sensor_get_i2c_peak_ms(s->gsr) : 0;
    d.rf_rssi_peak_ms   = s->gsr ? gsr_sensor_get_rf_rssi_peak_ms(s->gsr) : 0;
    d.rf_retune_peak_ms = s->gsr ? gsr_sensor_get_rf_retune_peak_ms(s->gsr) : 0;
    d.flush_peak_ms     = s->logger ? sd_logger_get_flush_peak_ms(s->logger) : 0;
    d.log_fill_bytes      = s->logger ? sd_logger_get_batch_fill_bytes(s->logger) : 0;
    d.log_fill_peak_bytes = s->logger ? sd_logger_get_batch_fill_peak_bytes(s->logger) : 0;
    d.log_overflow_count  = s->logger ? sd_logger_get_overflow_count(s->logger) : 0;
    d.log_flush_fail_count = s->logger ? sd_logger_get_flush_fail_count(s->logger) : 0;
    d.pga_change_count  = s->gsr ? gsr_sensor_get_pga_change_count(s->gsr) : 0;
    d.i2c_consec_fail   = s->gsr ? gsr_sensor_get_consecutive_failures(s->gsr) : 0;
    d.prealloc_ms       = s->logger ? sd_logger_get_prealloc_ms(s->logger) : 0;
    return d;
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
// a fresh EM_SCAN_NUM_FREQS-element snapshot — appended as 3 extra columns:
// rssi_815,rssi_868,rssi_915 (raw per-band peak from the last dwell).
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
// diag carries contention-diagnostic columns (RowDiag, biomap_types.h) —
// always built by the caller (get_row_diag(), above), but only written into
// the row when s->debug_fields_enabled is set (Options > Debug Fields,
// 2026-08-05 — runtime toggle, replacing the old BIOMAP_DEBUG_FIELDS
// compile-time switch). The only place that touches s->gps/s->gsr
// directly, keeping this function a pure formatter (mirrored, not linked,
// by tests/test_firmware.c).
// Returns true on success, false on buffer overflow.
static bool format_gps_csv_row(Session* s, const GpsPosition* pos,
                                double rel, float raw,
                                const float* rf_rssi, const RowDiag* diag) {
    bool gps_ok = pos->valid;
    // static, not a stack local: this runs on the main app thread's tick
    // path every ~100ms during a real recording, alongside GPS/GSR/RF
    // worker-management call chains that weren't all exercised together
    // before this merge (see the em_scan_rf_worker.c stack-size bump made
    // alongside this, prompted by a real on-device crash during the first
    // sustained outdoor GPS+GSR+RF walk). Safe as static since this
    // function is never reentrant or called concurrently — always one
    // call at a time from the single main app thread's tick handler.
    static char row[300];
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

    // Optional RF columns (raw per-band RSSI).
    int n2 = rf_rssi
        ? snprintf(row + n, sizeof(row) - (size_t)n, ",%.1f,%.1f,%.1f",
                   (double)rf_rssi[0], (double)rf_rssi[1], (double)rf_rssi[2])
        : 0;
    if(n2 < 0 || (size_t)(n + n2) >= sizeof(row)) return false;
    n += n2;

    // Debug columns are always appended at the very end so production
    // columns stay contiguous and easy to consume.
    int nd = s->debug_fields_enabled
        ? snprintf(row + n, sizeof(row) - (size_t)n,
                   ",%u,%u,%u,%u,%.1f,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u\n",
                   (unsigned)diag->tick_dt_ms, (unsigned)diag->gps_rx_drops,
                   (unsigned)diag->nmea_fail, (unsigned)diag->gps_reinit_count,
                   (double)diag->gsr_hz,
                   (unsigned)diag->i2c_peak_ms, (unsigned)diag->rf_rssi_peak_ms,
                   (unsigned)diag->rf_retune_peak_ms, (unsigned)diag->flush_peak_ms,
                   (unsigned)diag->log_fill_bytes, (unsigned)diag->log_fill_peak_bytes,
                   (unsigned)diag->log_overflow_count, (unsigned)diag->log_flush_fail_count,
                   (unsigned)diag->pga_change_count, (unsigned)diag->i2c_consec_fail,
                   (unsigned)diag->prealloc_ms)
        : snprintf(row + n, sizeof(row) - (size_t)n, "\n");
    if(nd <= 0 || (size_t)(n + nd) >= sizeof(row)) return false;
    n += nd;

    return sd_logger_batch_append(s->logger, row, (size_t)n);
}

// ── Batch CSV row construction ─────────────────────────────────────────────
// Dispatches to format_gps_csv_row for GPS+GSR mode; handles GSR-only
// and GPS-skip ticks directly. Rows are flushed at the 1-second boundary
// by handle_second_boundary().
//
// rf_rssi is fetched by the caller (see the Tick handler below), which
// already holds app->mutex when it does — safe, see gsr_sensor_get_rf_snapshot()'s
// doc comment.
// Returns true on success, false on buffer overflow.
static bool batch_csv_row(Session* s, float raw, const float* rf_rssi) {
    if(!s->recording.active || !has_gsr(s->mode)) return true;

    double rel = pipeline_rel_seconds(s->recording.total_ticks);
    // get_row_diag() reads several gsr_sensor_get_*()/gps_uart_get_*()
    // accessors, some of which acquire gsr->mutex/gsr->rf_mutex — real
    // (if brief) cost on the 10 Hz tick path. Only pay for it when the
    // result will actually be written to the CSV; a zeroed RowDiag keeps
    // this call truly free when the toggle is off (the default), same as
    // the old BIOMAP_DEBUG_FIELDS=0 compile-time behavior.
    RowDiag diag = s->debug_fields_enabled ? get_row_diag(s) : (RowDiag){0};

    if(s->mode == BioMapModeGsrOnly) {
        int ret = s->debug_fields_enabled
            ? sd_logger_batch_printf(
                  s->logger,
                  "%.2f,%.1f,%u,%u,%u,%u,%u,%u,%u\n",
                  rel,
                  (double)raw,
                  (unsigned)diag.log_fill_bytes,
                  (unsigned)diag.log_fill_peak_bytes,
                  (unsigned)diag.log_overflow_count,
                  (unsigned)diag.log_flush_fail_count,
                  (unsigned)diag.pga_change_count,
                  (unsigned)diag.i2c_consec_fail,
                  (unsigned)diag.prealloc_ms)
            : sd_logger_batch_printf(
                  s->logger,
                  "%.2f,%.1f\n",
                  rel,
                  (double)raw);
        return ret > 0;
    }

    // On the GPS tick boundary, include a fresh fix; otherwise preserve
    // GSR data with empty GPS columns (a GPS-skip tick).
    GpsPosition pos = is_gps_row_tick(s) ? get_gps_position(s) : (GpsPosition){0};
    return format_gps_csv_row(s, &pos, rel, raw, rf_rssi, &diag);
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
    s->recording.tick_counter = 0;

    if(!s->recording.active) return false;

    bool play_warning = false;

    // ── LED blink (every second, independent of flush interval) ────────
    // 500 ms blink — green when sensor OK, red when cuffs need attention.
    // Disconnect during recording is a visual-only alert: red blink, no
    // tone. Playing the speaker mid-recording contaminates the signal and
    // can also create long event-loop stalls while queued Tick events
    // catch up. Keep the edge flag so reconnect/re-disconnect cycles do
    // not need extra state changes elsewhere.
    if(has_gsr(s->mode) && s->gsr && !gsr_sensor_is_connected(s->gsr)) {
        notification_message(notifications, &sequence_blink_red_500);
        if(!s->gsr_alert_sounded) {
            s->gsr_alert_sounded = true;
        }
    } else {
        notification_message(notifications, &sequence_blink_green_500);
        s->gsr_alert_sounded = false;
    }
    // Brief blue blip after the main blink when GPS has no fix.
    if(has_gps(s->mode) && s->gps) {
        GpsPosition pos = get_gps_position(s);
        bool gps_ready = pos.valid;
        if(!gps_ready) {
            notification_message(notifications, &sequence_blink_blue_100);
        }
    }

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
                                  bool rf_calibrated, const float* rf_cal_floors,
                                  bool gsr_cal_active, float gsr_cal_gain, float gsr_cal_offset) {
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
            cols = s->debug_fields_enabled ? BIOMAP_CSV_COLS_GSR_ONLY_DEBUG : BIOMAP_CSV_COLS_GSR_ONLY_PROD;
        } else if(has_rf(s->mode)) {
            cols = s->debug_fields_enabled ? BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG : BIOMAP_CSV_COLS_GPS_GSR_RF_PROD;
        } else {
            cols = s->debug_fields_enabled ? BIOMAP_CSV_COLS_GPS_GSR_DEBUG : BIOMAP_CSV_COLS_GPS_GSR_PROD;
        }
        // 768 bytes to comfortably fit recording metadata + optional Band
        // Floors/DeviceName/GPSChipID/GSR Calibration + widest CSV schema
        // line (GPS+GSR+RF with continuity columns). Keep this headroom so
        // schema expansions do not block recording start with "Header too
        // long".
        char header[768];
        int n = snprintf(header, sizeof(header),
                         "# RecordingStartTime:%lu\n", (unsigned long)epoch);
        // DeviceName: the Flipper's user-visible name (Settings > System >
        // Device Name), for tracing which physical unit recorded a given
        // file. NULL-guarded — furi_hal_version_get_name_ptr()'s contract
        // doesn't promise non-NULL, and passing NULL to "%s" is UB on some
        // libc implementations.
        if(n > 0 && (size_t)n < sizeof(header)) {
            const char* device_name = furi_hal_version_get_name_ptr();
            n += snprintf(header + n, sizeof(header) - (size_t)n,
                         "# DeviceName:%s\n", device_name ? device_name : "");
        }
        // Band Floors line: only meaningful once RF is both active for this
        // session and a real calibration exists — order
        // (815,868,915) matches em_scan_freq_label[] in em_scan_rf.c.
        if(has_rf(s->mode) && rf_calibrated && n > 0 && (size_t)n < sizeof(header)) {
            n += snprintf(header + n, sizeof(header) - (size_t)n,
                         "# Band Floors (dBm): 815:%.1f,868:%.1f,915:%.1f\n",
                         (double)rf_cal_floors[0], (double)rf_cal_floors[1], (double)rf_cal_floors[2]);
        }
        // GPSChipID: a 5-word mnemonic phrase, not the raw hex — best
        // effort, only present once the UBX-SEC-UNIQID poll in gps_uart.c
        // has actually found one (see gps_uart_get_chip_id()'s doc
        // comment). Gated on has_gps() the same way Band Floors is gated
        // on has_rf() above.
        if(has_gps(s->mode) && s->gps && n > 0 && (size_t)n < sizeof(header)) {
            const char* chip_id = gps_uart_get_chip_id(s->gps);
            if(chip_id[0] != '\0') {
                n += snprintf(header + n, sizeof(header) - (size_t)n,
                             "# GPSChipID:%s\n", chip_id);
            }
        }
        // GSR Calibration line: gain/offset are applied inside GsrSensor
        // before gsr_raw is ever computed (see gsr_sensor_set_calibration),
        // so this is the only record of what transform produced the
        // logged values — only emitted when a calibration is actually
        // active, same gating style as Band Floors above.
        if(gsr_cal_active && n > 0 && (size_t)n < sizeof(header)) {
            n += snprintf(header + n, sizeof(header) - (size_t)n,
                         "# GSR Calibration: gain:%.4f,offset:%.4f\n",
                         (double)gsr_cal_gain, (double)gsr_cal_offset);
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
    bool in_range = zoom_out
        ? s->pipeline.graph.scroll_divider < 16
        : s->pipeline.graph.scroll_divider > 1;
    if(in_range) {
        s->pipeline.graph.scroll_divider = zoom_out
            ? s->pipeline.graph.scroll_divider * 2
            : s->pipeline.graph.scroll_divider / 2;
        s->pipeline.graph.tick_counter = 0;
        s->pipeline.graph.last_smoothed = s->pipeline.display.smoothed;
        pipeline_rescale_graph(&s->pipeline, zoom_out);
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

    // InputKeyOk is never seen here: run_recording_session()'s event loop
    // intercepts it (needs NotificationApp* for key_toggle_recording, which
    // this helper doesn't have) before ever calling this function.

    case InputKeyUp:
    case InputKeyDown:
        if(has_gsr(s->mode)) {
            // No click while actively recording — see key_zoom_vertical's
            // comment. Zoom itself still works either way; only the tone
            // is suppressed.
            bool zoom_in = (ev->input.key == InputKeyUp);
            if(!key_zoom_vertical(s, mutex, zoom_in)) biomap_sound_click(sound_enabled);
            view_port_update(vp);
        }
        return true;

    case InputKeyLeft:
    case InputKeyRight:
        if(has_gsr(s->mode)) {
            // Left = zoom out, Right = zoom in (key_zoom_horizontal's doc
            // comment) — named zoom_out here (not zoom_in) since that's
            // what it actually means, matching the callee's parameter name.
            bool zoom_out = (ev->input.key == InputKeyLeft);
            if(!key_zoom_horizontal(s, mutex, zoom_out)) biomap_sound_click(sound_enabled);
            view_port_update(vp);
        }
        return true;

    default:
        return false;
    }
}

// ── Live Stream mode (BLE) ──────────────────────────────────────────────
// docs/bluetooth_serial_investigation.md §3/§5. No SdLogger, no CSV — GPS
// and GSR are captured exactly like every other mode (gsr_sensor_tick()
// runs every tick so autoranging stays current), but the 45-byte packed
// binary packet is sent over BLE at BT_STREAM_INTERVAL_TICKS instead of
// written to SD every tick.
#define LIVE_STREAM_PACKET_SIZE 45

// Packs one wire packet at the exact offsets in §5's table. Uses memcpy at
// fixed byte offsets rather than a padded C struct — this project's STM32
// target is little-endian, matching the wire format's LE fields, so no
// byte-swapping is needed, but memcpy sidesteps any struct-padding
// ambiguity entirely rather than relying on that alignment coincidence.
static void pack_live_stream_packet(uint8_t out[LIVE_STREAM_PACKET_SIZE],
                                     uint32_t timestamp_ms, const GpsPosition* pos,
                                     float gsr_raw) {
    out[0] = 0x42; // 'B'
    out[1] = 0x4d; // 'M'
    memcpy(out + 2, &timestamp_ms, sizeof(timestamp_ms));
    // Not a `pos->valid ? pos->lat : 0.0` ternary — this project's build
    // treats -Wdouble-promotion as an error, and GCC's conditional-operator
    // type unification flags that form even though both branches are
    // already double.
    double lat = 0.0, lon = 0.0;
    if(pos->valid) {
        lat = pos->lat;
        lon = pos->lon;
    }
    memcpy(out + 6,  &lat, sizeof(lat));
    memcpy(out + 14, &lon, sizeof(lon));
    memcpy(out + 22, &gsr_raw, sizeof(gsr_raw));
    memcpy(out + 26, &pos->hdop, sizeof(pos->hdop));
    memcpy(out + 30, &pos->pdop, sizeof(pos->pdop));
    // speed_kts/course_deg are NaN when GPS has no velocity fix (see
    // get_gps_position) — the wire format has no separate "no velocity"
    // flag, so send 0 rather than propagating a NaN the frontend would
    // have to special-case.
    float speed = isnan(pos->speed_kts) ? 0.0f : pos->speed_kts;
    float course = isnan(pos->course_deg) ? 0.0f : pos->course_deg;
    memcpy(out + 34, &speed, sizeof(speed));
    memcpy(out + 38, &course, sizeof(course));
    out[42] = (uint8_t)pos->sats;
    out[43] = (uint8_t)pos->fix_type;
    out[44] = pos->valid ? 1 : 0;
}

// Builds this tick's packet (if any is due) while app->mutex is still
// held — GPS/GSR reads need it, same as every other mode's tick handling.
// Does NOT send it: ble_profile_serial_tx()'s worst-case latency is
// unmeasured (modules/bt_stream.h), so the actual bt_stream_tx_batch()
// call happens in the Tick handler AFTER releasing app->mutex, the same
// "no blocking hardware call under the render lock" rule the SD flush
// below already follows (see that block's own comment). *out_should_send
// is left false on every tick that isn't a send boundary.
static void handle_live_stream_tick_locked(
    Session* s, uint8_t out_packet[LIVE_STREAM_PACKET_SIZE], bool* out_should_send) {
    *out_should_send = false;

    float raw = 0.0f;
    if(s->gsr) {
        gsr_sensor_tick(s->gsr); // autoranging only, same as every other GSR mode
        raw = gsr_sensor_get_raw(s->gsr);
    }

    // s->recording.total_ticks is incremented by the caller AFTER this
    // returns (see the Tick handler below), so it's still last tick's
    // value here — using it directly means the very first tick
    // (total_ticks == 0) sends immediately, then every
    // BT_STREAM_INTERVAL_TICKS-th tick after. A one-tick phase shift
    // either way is immaterial to a periodic send cadence.
    if(s->recording.total_ticks % BT_STREAM_INTERVAL_TICKS != 0) return;

    GpsPosition pos = get_gps_position(s);
    uint32_t timestamp_ms = s->recording.total_ticks * (1000 / TICK_HZ);
    pack_live_stream_packet(out_packet, timestamp_ms, &pos, raw);
    *out_should_send = true;
}

// ── Handle one GSR tick (10 Hz) during a recording session ────────────────
// rf_rssi: see batch_csv_row's comment — fetched by the caller before
// app->mutex is held, not in here. NULL when RF is not active.
// Live Stream mode is dispatched separately by the caller (Tick handler,
// below), not through here — its packet-send needs to happen after
// app->mutex is released, unlike every path in this function.
// Returns true on success, false if a batch overflow occurred.
static bool handle_recording_tick(Session* s, const float* rf_rssi) {
    // ── GPS-only mode: write a row on the GPS tick boundary ────────────
    if(!has_gsr(s->mode) && has_gps(s->mode) && s->recording.active) {
        if(is_gps_row_tick(s)) {
            GpsPosition pos = get_gps_position(s);
            // See batch_csv_row's matching comment — only pay get_row_diag()'s
            // mutex-touching accessor reads when the result is actually used.
            RowDiag diag = s->debug_fields_enabled ? get_row_diag(s) : (RowDiag){0};
            return format_gps_csv_row(s, &pos, pipeline_rel_seconds(s->recording.total_ticks), 0.0f,
                                       rf_rssi, &diag);
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
    session_init(s, mode, app->zoom_enabled, app->debug_fields_enabled);

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

    // Live Stream (BioMapModeLiveStream) is deliberately excluded from
    // has_gps()/has_gsr()/has_rf() (biomap_config.h's enum comment) since
    // those also gate the shared CSV-writing path — but it still needs
    // real GPS+GSR capture, just routed to BLE instead of SD. OR'd in
    // explicitly here rather than folded into has_gps()/has_gsr()
    // themselves, so the CSV path stays untouched by this mode.
    bool is_live_stream = (mode == BioMapModeLiveStream);

    if(has_gps(mode) || is_live_stream) {
        s->gps = gps_uart_alloc(app->event_queue, app->notifications, app->nav_model);
    } else {
        gps_uart_standby();
        s->gps = NULL;
    }
    s->gsr    = (has_gsr(mode) || has_rf(mode) || is_live_stream) ? gsr_sensor_alloc() : NULL;
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
        // has_rf(LiveStream) is false — this mode never scans RF (§2's
        // architecture diagram: GSR+GPS only, no RF fields in the wire
        // packet).
        gsr_sensor_set_rf_enabled(s->gsr, has_rf(mode));
    }
    // No SdLogger at all for Live Stream (§3) — bt_stream replaces it.
    s->logger = is_live_stream ? NULL : sd_logger_alloc(app->storage);
    if(is_live_stream) {
        s->bt_stream = bt_stream_alloc();
        if(!bt_stream_start(s->bt_stream)) {
            // §1.7 — Bluetooth unavailable. Not fatal: bt_stream_get_status()
            // stays BtStatusUnavailable, and render_live_stream() shows that
            // as the on-screen status text rather than a separate error
            // screen — same "explicit, not silent" requirement, cheaper to
            // implement given the status readout already exists.
            FURI_LOG_W("BioMap", "Live Stream: BLE profile failed to start");
        }
    } else {
        s->bt_stream = NULL;
    }
    view_port_update(s->vp);

    // Apply backlight preference for this session.
    biomap_backlight_claim(app);

    s->timer = furi_timer_alloc(biomap_timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(s->timer, furi_kernel_get_tick_frequency() / TICK_HZ);

    PluginEvent ev;
    while(s->running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;

        // UART events: drain GPS data without holding the app mutex for
        // the entire parse.  We parse with a dedicated GPS mutex so the
        // GUI render thread is never blocked by NMEA parsing.
        //
        // Deliberately does NOT call view_port_update() here (removed
        // 2026-07-29 — see em_scan_rf_crash_investigation.md's "GPS + RF"
        // section). A single GPS fix arrives as several separate NMEA
        // sentences in a tight burst, not evenly spaced, so this used to
        // fire view_port_update() many times within a few milliseconds in
        // has_gsr()==false modes (GSR modes never took this branch, since
        // the graph buffer hadn't changed) — a rate no other mode ever
        // produces, spamming "ViewPort lockup" warnings and directly
        // preceding a real hang on real hardware. The Tick handler below
        // already calls view_port_update() unconditionally every tick
        // (10 Hz) regardless of mode, so GPS-only/GPS+RF screens still
        // redraw at that same bounded rate — this only costs up to one
        // tick (~100 ms) of extra latency before a fresh GPS reading
        // reaches the screen, in exchange for never bursting redraw calls
        // faster than every other mode already does safely. Matches
        // standalone em_scan.c's original UART handler, which never called
        // view_port_update() here either — this was a behavior the merge
        // introduced, not something standalone em_scan ever did.
        if(ev.type == EventTypeUart && s->gps) {
            gps_uart_process_rx(s->gps);
            continue;
        }

        // Handle OK key inline (needs NotificationApp* which the static
        // helper doesn't have access to). Live Stream has no CSV to
        // start/stop — reaching this mode's session_init() at all is
        // already the one deliberate "start streaming" act (§6) — so OK
        // is a no-op here rather than calling key_toggle_recording, which
        // assumes a real s->logger to open/close.
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
            && ev.input.key == InputKeyOk) {
            if(s->mode != BioMapModeLiveStream) {
                if(key_toggle_recording(s, app->mutex, app->notifications, app->sound_enabled,
                                         app->rf_calibrated, app->rf_cal_data.noise_floor_dbm,
                                         app->cal_active, app->cal_gain, app->cal_offset))
                    view_port_update(s->vp);
            } else {
                // No CSV to toggle, but every other screen in this app
                // gives SOME audible response to every key press — a
                // silent OK here reads as a frozen screen/dead button.
                biomap_sound_click(app->sound_enabled);
            }
            continue;
        }

        if(handle_recording_key(&ev, s, app->mutex, s->vp, app->sound_enabled))
            continue;

        if(ev.type == EventTypeTick) {
            // Real wall-clock capture, taken before anything else (mutex
            // acquire, UART draining that preceded this Tick in the queue,
            // etc. all show up in the diff below). See RecordingState's
            // tick_dt_ms doc comment (biomap_types.h) for why total_ticks/
            // `rel` can't be used for this instead.
            uint32_t now_tick = furi_get_tick();

            furi_mutex_acquire(app->mutex, FuriWaitForever);

            s->recording.tick_dt_ms = s->recording.last_tick_wall_ms
                ? (now_tick - s->recording.last_tick_wall_ms) : 0;
            s->recording.last_tick_wall_ms = now_tick;

            // Safe to call while holding app->mutex: gsr_sensor_get_rf_snapshot()
            // is guarded by GsrSensor's own dedicated rf_mutex, held only for a
            // 3-float memcpy and never across an RF hardware call — see
            // gsr_sensor.h's thread-safety comment. Same pattern
            // biomap_render_callback() already uses for this exact call
            // (2026-07-30 mutex audit: this used to be fetched before
            // app->mutex specifically to avoid a then-shared mutex with the
            // ADC path; that coupling no longer exists, so there's no reason
            // left to special-case this call site).
            float rf_rssi[EM_SCAN_NUM_FREQS];
            bool rf_active = has_rf(mode) && s->gsr && s->recording.active;
            if(rf_active) {
                gsr_sensor_get_rf_snapshot(s->gsr, rf_rssi);
            }

            // Live Stream is dispatched separately (not through
            // handle_recording_tick()) so its BLE send can happen after
            // app->mutex is released below — see
            // handle_live_stream_tick_locked()'s doc comment.
            uint8_t live_stream_packet[LIVE_STREAM_PACKET_SIZE];
            bool live_stream_should_send = false;
            bool batch_ok;
            if(mode == BioMapModeLiveStream) {
                handle_live_stream_tick_locked(s, live_stream_packet, &live_stream_should_send);
                batch_ok = true; // no batch buffer to overflow in this mode
            } else {
                batch_ok = handle_recording_tick(s, rf_active ? rf_rssi : NULL);
            }

            s->recording.total_ticks++;

            bool play_warning = false;
            bool do_flush = false;
            bool emit_heartbeat = false;
            bool emit_telemetry = false;
            bool emit_bt_telemetry = false;
            uint32_t hb_heap_free = 0;
            uint32_t hb_heap_min = 0;
            uint32_t hb_stack_main = 0;
            uint32_t hb_stack_gsr = 0;
            uint32_t tm_tick_dt = 0;
            uint32_t tm_gps_drop = 0;
            uint32_t tm_nmea_fail = 0;
            uint32_t tm_gps_reinit = 0;
            float tm_gsr_hz = 0.0f;
            uint32_t tm_i2c = 0;
            uint32_t tm_rf = 0;
            uint32_t tm_ret = 0;
            uint32_t tm_flush_peak = 0;
            uint32_t tm_fill = 0;
            uint32_t tm_peak = 0;
            uint32_t tm_over = 0;
            uint32_t tm_flfail = 0;
            uint32_t tm_pga = 0;
            uint32_t tm_i2c_consec = 0;
            uint32_t tm_bt_tick_dt = 0;
            uint32_t tm_bt_tx_peak = 0;
            uint32_t tm_bt_drop = 0;
            if(++s->recording.tick_counter >= TICK_HZ) {
                // Both heartbeat (heap/stack) and telemetry (RowDiag) are
                // gated on debug_fields_enabled (2026-08-05) — under the old
                // BIOMAP_DEBUG_FIELDS=0 compile-time build neither of this
                // existed at all, so "off" should mean the same zero-cost
                // thing at runtime: no heap/stack introspection, no
                // gsr->mutex/gsr->rf_mutex touches, no serial log line,
                // once a second, for every recording tick otherwise.
                if(s->debug_fields_enabled) {
                    emit_heartbeat = true;
                    hb_heap_free = memmgr_get_free_heap();
                    hb_heap_min = memmgr_get_minimum_free_heap();
                    hb_stack_main = furi_thread_get_stack_space(furi_thread_get_id(furi_thread_get_current()));
                    hb_stack_gsr = s->gsr ? gsr_sensor_get_stack_space(s->gsr) : 0;
                }

                if(s->recording.active && s->debug_fields_enabled) {
                    RowDiag diag = get_row_diag(s);
                    emit_telemetry = true;
                    tm_tick_dt = diag.tick_dt_ms;
                    tm_gps_drop = diag.gps_rx_drops;
                    tm_nmea_fail = diag.nmea_fail;
                    tm_gps_reinit = diag.gps_reinit_count;
                    tm_gsr_hz = diag.gsr_hz;
                    tm_i2c = diag.i2c_peak_ms;
                    tm_rf = diag.rf_rssi_peak_ms;
                    tm_ret = diag.rf_retune_peak_ms;
                    tm_flush_peak = diag.flush_peak_ms;
                    tm_fill = diag.log_fill_bytes;
                    tm_peak = diag.log_fill_peak_bytes;
                    tm_over = diag.log_overflow_count;
                    tm_flfail = diag.log_flush_fail_count;
                    tm_pga = diag.pga_change_count;
                    tm_i2c_consec = diag.i2c_consec_fail;
                }

                // Live Stream's own once-a-second diagnostic line (§10 Phase
                // 3 / §11's bt_tx_peak_ms bullet): the RowDiag-based
                // telemetry above is gated on s->recording.active, which
                // this mode never sets (there's no CSV to toggle recording
                // for — §6), so it would otherwise never fire here at all.
                // Same-row tick_dt_ms/bt_tx_peak_ms pairing is exactly the
                // signature this project has used to attribute every
                // previous tick stall to its real cause (SD flush, I2C, RF
                // retune) — this is that tool for BLE TX.
                if(s->mode == BioMapModeLiveStream && s->debug_fields_enabled && s->bt_stream) {
                    emit_bt_telemetry = true;
                    tm_bt_tick_dt = s->recording.tick_dt_ms;
                    tm_bt_tx_peak = bt_stream_get_tx_peak_ms(s->bt_stream);
                    tm_bt_drop = bt_stream_get_drop_count(s->bt_stream);
                }

                if(handle_second_boundary(s, app->notifications)) play_warning = true;
                if(++s->recording.flush_counter >= FLUSH_INTERVAL) {
                    s->recording.flush_counter = 0;
                    do_flush = true;
                }
            }
            furi_mutex_release(app->mutex);

            // BLE send happens here, after releasing app->mutex — same
            // rule the SD flush below follows, for the same reason
            // (ble_profile_serial_tx()'s worst-case latency is unmeasured,
            // and biomap_render_callback() only waits 10ms for this same
            // mutex before skipping its redraw).
            if(live_stream_should_send && s->bt_stream) {
                bt_stream_tx_batch(s->bt_stream, live_stream_packet, sizeof(live_stream_packet));
            }

            if(emit_heartbeat) {
                FURI_LOG_I("BioMap", "heartbeat heap:free=%u min=%u stack:main=%u gsr=%u sd_dry=%u",
                           (unsigned)hb_heap_free, (unsigned)hb_heap_min,
                           (unsigned)hb_stack_main, (unsigned)hb_stack_gsr,
                           (unsigned)BIOMAP_SD_DRY_RUN);
            }
            if(emit_bt_telemetry) {
                FURI_LOG_I("BioMap", "bt_telemetry tick_dt=%u bt_tx_peak_ms=%u bt_drop=%u",
                           (unsigned)tm_bt_tick_dt, (unsigned)tm_bt_tx_peak, (unsigned)tm_bt_drop);
            }
            if(emit_telemetry) {
                FURI_LOG_I(
                    "BioMap",
                    "telemetry tick_dt=%u gps_drop=%u nmea_fail=%u gps_reinit=%u gsr_hz=%.1f i2c=%u rf=%u ret=%u flush_peak=%u fill=%u peak=%u over=%u flfail=%u pga=%u i2c_consec=%u",
                    (unsigned)tm_tick_dt,
                    (unsigned)tm_gps_drop,
                    (unsigned)tm_nmea_fail,
                    (unsigned)tm_gps_reinit,
                    (double)tm_gsr_hz,
                    (unsigned)tm_i2c,
                    (unsigned)tm_rf,
                    (unsigned)tm_ret,
                    (unsigned)tm_flush_peak,
                    (unsigned)tm_fill,
                    (unsigned)tm_peak,
                    (unsigned)tm_over,
                    (unsigned)tm_flfail,
                    (unsigned)tm_pga,
                    (unsigned)tm_i2c_consec);
            }

            // SD card batch flush is performed AFTER releasing app->mutex!
            // storage_file_write() and storage_file_sync() block for ~20-60 ms.
            // Executing them outside app->mutex prevents biomap_render_callback()
            // from locking up the ViewPort.
            // s->logger is NULL for Live Stream (no SdLogger at all, §3) —
            // sd_logger_batch_flush() furi_check()s its argument non-NULL,
            // so this must never fire for that mode. do_flush can still go
            // true there (flush_counter/FLUSH_INTERVAL bookkeeping isn't
            // mode-gated above), and handle_live_stream_tick() always
            // returns batch_ok=true, so `s->logger &&` is the guard that
            // actually matters here.
            if(s->logger && (do_flush || !batch_ok)) {
                if(!batch_ok) FURI_LOG_W("BioMap", "Batch overflow — emergency flush");
                int flushed = sd_logger_batch_flush(s->logger);
                if(flushed < 0) {
                    FURI_LOG_E("BioMap", "Batch flush failed");
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    if(handle_write_failure(s, app->notifications)) play_warning = true;
                    furi_mutex_release(app->mutex);
                }
            }

            if(play_warning) biomap_sound_warning(app->sound_enabled);

            // Pace ViewPort redraw to 2 Hz (every 5 ticks at 10 Hz) to eliminate
            // GUI message queue lockups during background BLE/System service activity.
            if(s->recording.total_ticks % 5 == 0) {
                view_port_update(s->vp);
            }
        }
    }

    session_deinit(s, app);
}
