// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// Session logic shared by every device — see biomap_session.h.

#include "biomap_session.h"

#include "biomap_format.h"
#include "core_check.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>

// ==========================================================================
// Device helpers
// ==========================================================================

static void session_lock(SessionCore* s) {
    s->platform.lock(s->platform.ctx);
    s->locked = true;
}

static void session_unlock(SessionCore* s) {
    s->locked = false;
    s->platform.unlock(s->platform.ctx);
}

// Never called with the lock held: a log line can go out over a slow
// serial link, and the screen waits for the lock.
__attribute__((format(printf, 3, 4)))
static void session_log(SessionCore* s, SessionLogLevel level, const char* fmt, ...) {
    CORE_CHECK(!s->locked, "session: log line with the lock held");
    if(!s->platform.log) return;
    char line[200];
    va_list args;
    va_start(args, fmt);
    vsnprintf(line, sizeof(line), fmt, args);
    va_end(args);
    s->platform.log(s->platform.ctx, level, line);
}

void session_core_cue(SessionCore* s, BioMapCue cue) {
    if(biomap_cue_has_sound(cue)) {
        // Rule 2: a sound blocks, and the screen waits for this lock.
        CORE_CHECK(!s->locked, "session: cue with a sound sent with the lock held");
        // Rule 3: no sound during a recording. Today only key clicks reach
        // here mid-recording; they are left out on purpose.
        if(s->recording.active) return;
    }
    s->platform.cue(s->platform.ctx, cue);
}

// ==========================================================================
// Start
// ==========================================================================

void session_core_init(SessionCore* s, BioMapMode mode, const SessionPlatform* platform,
                       const SessionSettings* settings) {
    CORE_CHECK(s && platform && settings, "session_core_init: NULL argument");
    CORE_CHECK(platform->lock && platform->unlock && platform->now_ms && platform->delay_ms
                   && platform->cue && platform->datetime_now && platform->epoch_now,
               "session_core_init: platform lacks a required function");
    if(session_mode_records(mode)) {
        CORE_CHECK(platform->file_start && platform->file_stop && platform->file_append
                       && platform->file_flush,
                   "session_core_init: a recording mode needs the file functions");
    }
    if(mode == BioMapModeLiveStream) {
        CORE_CHECK(platform->live_connected && platform->live_send,
                   "session_core_init: Live Stream needs the live functions");
    }
    // Compound-literal assignment zero-fills every field not named here
    // (all of .recording, the display and graph filter state, the module
    // pointers), so only the non-zero starting values are spelled out.
    *s = (SessionCore){
        .mode              = mode,
        .pipeline.zoom     = {.level = 1.0f, .peak = 1.0f, .enabled = settings->zoom_enabled},
        .pipeline.graph    = {.scroll_divider = 1},
        .running           = true,
        .settings          = *settings,
        .platform          = *platform,
    };
}

// ==========================================================================
// Readings
// ==========================================================================

// ── GPS row cadence: is this tick the GPS sub-sample boundary? ─────────
static inline bool is_gps_row_tick(const SessionCore* s) {
    return s->recording.tick_counter % (TICK_HZ / GPS_CSV_HZ) == 0;
}

// ── GpsStatus → GpsPosition ────────────────────────────────────────────
static GpsPosition get_gps_position(const SessionCore* s) {
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
    if(gps_status_has_fix(&gs) && !isnan(gs.latitude) && !isnan(gs.longitude)) {
        pos.valid = true;
        pos.lat = gs.latitude;
        pos.lon = gs.longitude;
    }
    return pos;
}

// ── The debug-field columns of one row ─────────────────────────────────
// All zero unless debug fields are on, so the 10 Hz tick doesn't pay for
// the reads (some take the GSR sensor's own lock) when they won't be
// written. Called with the lock held.
static RowDiag get_row_diag(const SessionCore* s) {
    RowDiag d = {0};
    if(!s->settings.debug_fields_enabled) return d;
    d.tick_dt_ms       = s->recording.tick_dt_ms;
    d.gps_rx_drops     = s->gps ? gps_uart_get_rx_drop_count(s->gps) : 0;
    d.nmea_fail        = s->gps ? gps_uart_get_nmea_fail_count(s->gps) : 0;
    d.gps_reinit_count = s->gps ? gps_uart_get_reinit_count(s->gps) : 0;
    d.gsr_hz           = s->gsr ? gsr_sensor_get_worker_hz(s->gsr) : 0.0f;
    d.i2c_peak_ms      = s->gsr ? gsr_sensor_get_i2c_peak_ms(s->gsr) : 0;
    d.pga_change_count = s->gsr ? gsr_sensor_get_pga_change_count(s->gsr) : 0;
    d.i2c_consec_fail  = s->gsr ? gsr_sensor_get_consecutive_failures(s->gsr) : 0;
    // The radio and SD buffer figures.
    if(s->platform.fill_diag) s->platform.fill_diag(s->platform.ctx, &d);
    return d;
}

static void log_telemetry(SessionCore* s, const RowDiag* d) {
    session_log(
        s, SessionLogInfo,
        "telemetry tick_dt=%u gps_drop=%u nmea_fail=%u gps_reinit=%u gsr_hz=%.1f i2c=%u rf=%u ret=%u flush_peak=%u fill=%u peak=%u over=%u flfail=%u pga=%u i2c_consec=%u",
        (unsigned)d->tick_dt_ms, (unsigned)d->gps_rx_drops, (unsigned)d->nmea_fail,
        (unsigned)d->gps_reinit_count, (double)d->gsr_hz, (unsigned)d->i2c_peak_ms,
        (unsigned)d->rf_rssi_peak_ms, (unsigned)d->rf_retune_peak_ms,
        (unsigned)d->flush_peak_ms, (unsigned)d->log_fill_bytes,
        (unsigned)d->log_fill_peak_bytes, (unsigned)d->log_overflow_count,
        (unsigned)d->log_flush_fail_count, (unsigned)d->pga_change_count,
        (unsigned)d->i2c_consec_fail);
}

// ==========================================================================
// CSV rows
// ==========================================================================

// Each row is built whole, then handed to the device with ONE
// file_append(), never in two parts: if the first part landed and the
// second then failed because the buffer filled in between, the first
// part would be committed with no newline and the next row glued onto it.
// file_append() checks for room before writing anything.

// GPS+GSR rows (live GSR reading) and GPS-only rows (raw = 0).
// Returns true on success, false when the row didn't fit.
static bool append_gps_csv_row(SessionCore* s, const GpsPosition* pos, double rel, float raw,
                               const float* rf_rssi, const RowDiag* diag) {
    // static, not on the stack: keeps 300 bytes off the main thread's
    // stack on the tick path. Safe: only ever called from the tick, one
    // call at a time.
    static char row[300];
    int n = biomap_format_gps_row(row, sizeof(row), s->settings.debug_fields_enabled,
                                  pos, rel, raw, rf_rssi, diag);
    if(n < 0) return false;
    return s->platform.file_append(s->platform.ctx, row, (size_t)n);
}

// The row for the GSR modes. Rows are written to the card by the flush
// once every FLUSH_INTERVAL seconds (session_core_tick()).
// Returns true on success, false when the row didn't fit.
static bool batch_csv_row(SessionCore* s, float raw, const float* rf_rssi) {
    if(!s->recording.active || !has_gsr(s->mode)) return true;

    double rel = pipeline_rel_seconds(s->recording.total_ticks);
    RowDiag diag = get_row_diag(s);  // zero unless debug fields are on

    if(s->mode == BioMapModeGsrOnly) {
        // Two columns, or nine with debug fields: the widest debug row is
        // about 65 bytes, so 128 is plenty and small enough for the stack.
        char row[128];
        int n = biomap_format_gsr_row(row, sizeof(row), s->settings.debug_fields_enabled,
                                      rel, raw, &diag);
        if(n < 0) return false;
        return s->platform.file_append(s->platform.ctx, row, (size_t)n);
    }

    // On the GPS row boundary, include a fresh fix; otherwise keep the
    // GSR reading with empty GPS columns.
    GpsPosition pos = is_gps_row_tick(s) ? get_gps_position(s) : (GpsPosition){0};
    return append_gps_csv_row(s, &pos, rel, raw, rf_rssi, &diag);
}

// ==========================================================================
// Recording start and stop
// ==========================================================================

// ── GSR + Sound: keep sounds fully outside the recorded window ─────────
// The speaker and the GSR front end share the 3.3 V supply, so a sound can
// put noise on the GSR reading (rule 3 in core/biomap_cues.h). So:
//   START: play the sound (and let the GSR buffer settle) BEFORE
//          recording.active goes true. Every row is gated on that flag, so
//          nothing is written until the sound, and a settle time long
//          enough for the GSR ring buffer to refill with readings taken
//          after it, are over. The file is opened and the header written
//          first: that is card work only.
//   STOP:  clear recording.active and close the file BEFORE the sound.

// Writes the file header: the recording-start metadata lines and the
// column names. Returns its length, or -1 if it doesn't fit.
static int build_header(SessionCore* s, char* header, size_t cap, uint32_t epoch) {
    const SessionSettings* cfg = &s->settings;
    bool debug = cfg->debug_fields_enabled;
    const char* cols;
    if(s->mode == BioMapModeGsrOnly) {
        cols = debug ? BIOMAP_CSV_COLS_GSR_ONLY_DEBUG : BIOMAP_CSV_COLS_GSR_ONLY_PROD;
    } else if(has_rf(s->mode)) {
        cols = debug ? BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG : BIOMAP_CSV_COLS_GPS_GSR_RF_PROD;
    } else {
        cols = debug ? BIOMAP_CSV_COLS_GPS_GSR_DEBUG : BIOMAP_CSV_COLS_GPS_GSR_PROD;
    }

    // 0.5 V bias check for this recording (gsr_sensor.h, "When it is
    // measured"): done now, before the first row, so one value holds for
    // the whole file and goes in its header. Takes about 50 ms; if it
    // hasn't finished in 200 ms (I2C trouble) it is cancelled, so it can't
    // land mid-recording, and the previous value is used.
    bool  bias_line = false;
    float bias_measured = NAN;
    float bias_used = GSR_BIAS_NOMINAL_V;
    if(has_gsr(s->mode) && s->gsr && gsr_sensor_available(s->gsr)) {
        bool done = gsr_sensor_run_bias_check(s->gsr, GSR_BIAS_CHECK_TIMEOUT_MS);
        if(done) bias_measured = gsr_sensor_get_bias_measured_volts(s->gsr);
        float accepted = gsr_sensor_get_bias_volts(s->gsr);
        if(accepted > 0.0f) bias_used = accepted;
        bias_line = true;
    }

    int n = snprintf(header, cap, "# RecordingStartTime:%lu\n", (unsigned long)epoch);
    // DeviceName: which physical unit recorded the file.
    if(n > 0 && (size_t)n < cap) {
        n += snprintf(header + n, cap - (size_t)n, "# DeviceName:%s\n",
                      cfg->device_name ? cfg->device_name : "");
    }
    // Band Floors: only once the radio is on in this mode and a real
    // radio calibration exists. Order 815, 868, 915 (RF_BAND_COUNT).
    if(has_rf(s->mode) && cfg->rf_calibrated && n > 0 && (size_t)n < cap) {
        n += snprintf(header + n, cap - (size_t)n,
                      "# Band Floors (dBm): 815:%.1f,868:%.1f,915:%.1f\n",
                      (double)cfg->rf_floors_dbm[0], (double)cfg->rf_floors_dbm[1],
                      (double)cfg->rf_floors_dbm[2]);
    }
    // GPSChipID: a 5-word phrase, only once the module's ID has been read
    // (gps_uart_get_chip_id()).
    if(has_gps(s->mode) && s->gps && n > 0 && (size_t)n < cap) {
        const char* chip_id = gps_uart_get_chip_id(s->gps);
        if(chip_id[0] != '\0') {
            n += snprintf(header + n, cap - (size_t)n, "# GPSChipID:%s\n", chip_id);
        }
    }
    // GSR Calibration: the GSR sensor applies zero_counts and gain before
    // any reading is logged, so this line is the only record of what
    // produced the logged values. r2 and noise_ns are the wizard's fit and
    // per-resistor noise (470k/100k/47k, nS) as numbers, so a recording's
    // quality can be judged from the file alone. cal_time is when the
    // calibration was saved (Unix seconds; 0 if the clock was unset).
    if(cfg->cal_active && n > 0 && (size_t)n < cap) {
        n += snprintf(header + n, cap - (size_t)n,
                      "# GSR Calibration: gain:%.4f,zero_counts:%.1f,r2:%.4f,noise_ns:%.2f,%.2f,%.2f,cal_time:%lu\n",
                      (double)cfg->cal_gain, (double)cfg->cal_zero_counts, (double)cfg->cal_r_squared,
                      (double)cfg->cal_noise_std_dev[0], (double)cfg->cal_noise_std_dev[1],
                      (double)cfg->cal_noise_std_dev[2], (unsigned long)cfg->cal_timestamp);
    }
    if(bias_line && n > 0 && (size_t)n < cap) {
        int m = biomap_format_gsr_bias_line(header + n, cap - (size_t)n, bias_measured, bias_used);
        n = (m < 0) ? -1 : n + m;
    }
    if(n > 0 && (size_t)n < cap) {
        n += snprintf(header + n, cap - (size_t)n, "%s", cols);
    }
    if(n < 0 || (size_t)n >= cap) return -1;
    return n;
}

static void start_recording(SessionCore* s) {
    // One clock reading feeds both the header's start time and the file
    // name, so the two always agree.
    SessionDateTime dt;
    s->platform.datetime_now(s->platform.ctx, &dt);
    uint32_t epoch = pipeline_unix_epoch(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second);
    char stamp[24];
    biomap_format_file_stamp(stamp, sizeof(stamp), dt.year, dt.month, dt.day,
                             dt.hour, dt.minute, dt.second);
    if(epoch == 0) {
        session_log(s, SessionLogWarning, "RTC not set — recording epoch will be 0 in CSV header");
    }

    // 768 bytes fits the metadata lines and the widest column line
    // (GPS+GSR+RF with debug fields) with room to spare, so adding a
    // column doesn't block recording with "Header too long".
    char header[768];
    if(build_header(s, header, sizeof(header), epoch) < 0) {
        session_log(s, SessionLogError, "Header too long");
        session_core_cue(s, BioMapCueError);
        return;
    }
    if(!s->platform.file_start(s->platform.ctx, header, stamp)) {
        session_core_cue(s, BioMapCueError);
        return;
    }
    // Sound + settle BEFORE recording.active goes true (see "GSR + Sound"
    // above). Nothing about the file or the GSR has changed yet.
    session_core_cue(s, BioMapCueRecordingStarted);
    if(s->settings.sound_enabled) s->platform.delay_ms(s->platform.ctx, GSR_TONE_SETTLE_MS);

    session_lock(s);
    s->recording.active = true;
    s->recording.tick_counter = 0;
    s->recording.total_ticks  = 0;
    // Clear any SD failure from a previous recording in this session (the
    // screen stays open after an SD stop, so the user can reseat the card
    // and start a new file).
    s->recording.flush_fail_streak = 0;
    s->recording.write_stopped = false;
    session_unlock(s);
    // No light of its own: the heartbeat blink shows the recording.
}

// ── Final write before a normal stop ───────────────────────────────────
// A failed flush keeps the buffer, so one retry re-sends the same bytes:
// cheap insurance against a passing SD-busy moment, the most common
// failure. If it still fails, the file really is missing its last few
// seconds, and the caller warns instead of playing the ordinary stop sound.
// Returns true if nothing was lost.
static bool flush_before_stop(SessionCore* s) {
    if(s->platform.file_flush(s->platform.ctx) >= 0) return true;
    session_log(s, SessionLogError, "Final batch flush failed, retrying once");
    if(s->platform.file_flush(s->platform.ctx) >= 0) return true;
    session_log(s, SessionLogError, "Final batch flush failed after retry — recording is incomplete");
    return false;
}

typedef enum {
    StopNotRecording,
    StopClean,
    StopIncomplete,
} StopResult;

// Ends an active recording: the flag first (under the lock), then the
// final write and closing the file (lock released). No sound here: the
// caller plays it, now that the file is closed.
static StopResult stop_recording(SessionCore* s) {
    session_lock(s);
    bool was_active = s->recording.active;
    s->recording.active = false;
    s->recording.flush_fail_streak = 0;  // "not active ⇒ streak 0"
    session_unlock(s);
    if(!was_active) return StopNotRecording;

    // With recording.active false, nothing else touches the file buffer.
    bool flush_ok = flush_before_stop(s);
    s->platform.file_stop(s->platform.ctx, s->platform.epoch_now(s->platform.ctx));
    return flush_ok ? StopClean : StopIncomplete;
}

void session_core_end(SessionCore* s) {
    // In normal use Back has already stopped the recording, so this finds
    // nothing to do.
    if(stop_recording(s) == StopIncomplete) session_core_cue(s, BioMapCueRecordingIncomplete);
}

// ==========================================================================
// Keys
// ==========================================================================

// Manual vertical zoom. Pauses auto-zoom for MANUAL_ZOOM_TIMEOUT ticks;
// each press restarts the pause.
static void zoom_vertical(SessionCore* s, bool zoom_in) {
    session_lock(s);
    s->pipeline.zoom.manual_timeout = MANUAL_ZOOM_TIMEOUT;
    s->pipeline.zoom.level = zoom_in
        ? fminf(s->pipeline.zoom.level * ZOOM_FACTOR, ZOOM_MAX)
        : fmaxf(s->pipeline.zoom.level / ZOOM_FACTOR, ZOOM_MIN);
    session_unlock(s);
}

// Time-axis zoom: zoom_out shows a longer stretch of time.
static void zoom_horizontal(SessionCore* s, bool zoom_out) {
    session_lock(s);
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
    session_unlock(s);
}

bool session_core_key(SessionCore* s, SessionKey key) {
    switch(key) {
    case SessionKeyOk:
        if(!session_mode_records(s->mode)) {
            // No file to start (Live Stream, Diagnostics), but every key
            // press in this app gives some sound: a silent OK reads as a
            // frozen screen.
            session_core_cue(s, BioMapCueClick);
            return false;
        }
        if(s->recording.active) {
            // Sound only now the file is closed. A failed final write uses
            // the warning sound, so a lossy stop doesn't sound like a clean one.
            StopResult r = stop_recording(s);
            session_core_cue(s, r == StopIncomplete ? BioMapCueRecordingIncomplete
                                                   : BioMapCueRecordingStopped);
        } else {
            start_recording(s);
        }
        return true;

    case SessionKeyBack: {
        session_lock(s);
        s->running = false;
        session_unlock(s);
        // Stop fully here rather than leaving it to session_core_end().
        StopResult r = stop_recording(s);
        if(r == StopNotRecording) {
            session_core_cue(s, BioMapCueBack);
        } else {
            session_core_cue(s, r == StopIncomplete ? BioMapCueRecordingIncomplete
                                                   : BioMapCueRecordingStopped);
        }
        return false;
    }

    case SessionKeyUp:
    case SessionKeyDown:
        if(!has_gsr(s->mode)) return false;
        zoom_vertical(s, key == SessionKeyUp);
        // Left out during a recording (rule 3); zoom itself still works.
        session_core_cue(s, BioMapCueClick);
        return true;

    case SessionKeyLeft:
    case SessionKeyRight:
        if(!has_gsr(s->mode)) return false;
        zoom_horizontal(s, key == SessionKeyLeft);
        session_core_cue(s, BioMapCueClick);
        return true;
    }
    return false;
}

// ==========================================================================
// Ticks
// ==========================================================================

// Live Stream's version of the bias check at recording start: a fresh
// 0.5 V bias check when a phone first connects. Without it Live Stream
// would only have the reading from when the GSR sensor started, just after
// the GPS module was switched on, when its start-up current can pull the
// 3.3 V supply down. Only the first connect of the session: the visualiser
// reconnects by itself after a dropout and carries on the same track, and
// a new check then would put a step (and a ~50 ms gap) in the middle of
// it. The value isn't in the packet, so it is logged. Waits about 50 ms
// (200 ms at most), so it runs before the tick takes the lock.
// A check that times out, or a sensor that isn't answering at that moment,
// is tried again on the next tick, up to LIVE_BIAS_MAX_TRIES ticks after
// the connect.
static void live_stream_bias_check_on_first_connect(SessionCore* s) {
    if(s->live_bias_checked) return;
    if(!s->platform.live_connected(s->platform.ctx)) return;
    if(++s->live_bias_tries >= LIVE_BIAS_MAX_TRIES) s->live_bias_checked = true;
    if(!s->gsr || !gsr_sensor_available(s->gsr)) return;

    bool done = gsr_sensor_run_bias_check(s->gsr, GSR_BIAS_CHECK_TIMEOUT_MS);
    if(done) s->live_bias_checked = true;
    float measured = done ? gsr_sensor_get_bias_measured_volts(s->gsr) : NAN;
    float used = gsr_sensor_get_bias_volts(s->gsr);
    if(used <= 0.0f) used = GSR_BIAS_NOMINAL_V;
    session_log(s, SessionLogInfo, "Live Stream bias: measured %.1f mV, using %.1f mV",
                (double)(measured * 1000.0f), (double)(used * 1000.0f));
}

// Live Stream's tick, lock held: keeps the GSR gain current every tick, and
// on every BT_STREAM_INTERVAL_TICKS-th tick builds a packet. Doesn't send
// it: the send's worst-case time is unknown, so the caller sends after
// releasing the lock. Returns true when `packet` was filled.
static bool live_stream_tick_locked(SessionCore* s, uint8_t packet[BT_STREAM_PACKET_SIZE]) {
    float raw = 0.0f;
    if(s->gsr) {
        gsr_sensor_tick(s->gsr);  // gain switching only
        raw = gsr_sensor_get_raw(s->gsr);
    }
    // total_ticks is still last tick's value here (the caller adds one
    // afterwards), so the very first tick sends at once.
    if(s->recording.total_ticks % BT_STREAM_INTERVAL_TICKS != 0) return false;

    GpsPosition pos = get_gps_position(s);
    uint32_t timestamp_ms = s->recording.total_ticks * (1000 / TICK_HZ);
    bt_stream_pack_packet(packet, timestamp_ms, &pos, raw);
    return true;
}

// Every other mode's tick, lock held. rf_rssi is NULL when the radio
// isn't recording. Returns false if this tick's row didn't fit.
static bool recording_tick_locked(SessionCore* s, const float* rf_rssi) {
    // ── GPS-only mode: a row on the GPS row boundary ───────────────────
    if(!has_gsr(s->mode) && has_gps(s->mode) && s->recording.active) {
        if(is_gps_row_tick(s)) {
            GpsPosition pos = get_gps_position(s);
            RowDiag diag = get_row_diag(s);
            return append_gps_csv_row(s, &pos, pipeline_rel_seconds(s->recording.total_ticks),
                                      0.0f, rf_rssi, &diag);
        }
        return true;
    }

    // ── GSR modes ──────────────────────────────────────────────────────
    float raw = 0.0f;
    if(s->gsr) {
        gsr_sensor_tick(s->gsr);                                  // gain switching only
        float raw_sample = gsr_sensor_get_raw_sample_ns(s->gsr);  // one reading, nS
        raw = gsr_sensor_get_raw(s->gsr);                         // ~100 ms mean, nS (CSV)
        s->pipeline.display.raw_sample_ns    = raw_sample;        // before the filters
        s->pipeline.display.filtered_ns      = raw;
        s->pipeline.display.raw_sample_count = gsr_sensor_get_raw_sample_count(s->gsr);

        bool valid = (raw_sample >= GSR_VALID_MIN_NS && raw_sample <= GSR_VALID_MAX_NS);
        if(valid) {
            // A big jump (fingers back on) restarts the graph's line from
            // the new value instead of drawing a spike.
            float delta = (raw_sample > s->pipeline.display.last_displayed)
                ? raw_sample - s->pipeline.display.last_displayed
                : s->pipeline.display.last_displayed - raw_sample;
            bool recovering = s->pipeline.display.primed && (delta > 500.0f);

            pipeline_update_display(&s->pipeline, raw_sample);
            if(recovering) s->pipeline.graph.last_smoothed = s->pipeline.display.smoothed;
            pipeline_update_graph(&s->pipeline);
        }
    }
    return batch_csv_row(s, raw, rf_rssi);
}

// Once a second, lock held: the recording light. Green when the GSR is
// fine, red when the finger cuffs are off, then a blue blip when GPS has
// no fix. Light only: a sound here would block with the lock held and
// would land on the GSR reading.
static void second_boundary_locked(SessionCore* s) {
    s->recording.tick_counter = 0;
    if(!s->recording.active) return;

    if(has_gsr(s->mode) && s->gsr && !gsr_sensor_is_connected(s->gsr)) {
        session_core_cue(s, BioMapCueHeartbeatFingersOff);
    } else {
        session_core_cue(s, BioMapCueHeartbeat);
    }
    if(has_gps(s->mode) && s->gps) {
        GpsPosition pos = get_gps_position(s);
        if(!pos.valid) session_core_cue(s, BioMapCueNoGpsFix);
    }
}

// The SD flush after the lock is released. A failed flush keeps the
// buffer, so a later success writes the old and new rows in one go (a
// partial write commits only what the card took, so no row is written
// twice). The recording is stopped only when the failure can't be ridden
// out: SD_FLUSH_FAIL_STREAK_LIMIT failures in a row, or the buffer already
// full (this tick's row was lost) and still not flushing. Riding out costs
// a brief stall of the tick loop on each retry with a card that is
// half-seated rather than removed.
static void flush_file(SessionCore* s, bool batch_ok) {
    if(!batch_ok) session_log(s, SessionLogWarning, "Batch overflow — emergency flush");
    int flushed = s->platform.file_flush(s->platform.ctx);

    enum { SdOk, SdRecovered, SdRidingOut, SdTerminated } outcome = SdOk;
    uint32_t streak = 0;

    // Decide under the lock (a few field writes), then log and play sounds
    // after releasing it.
    session_lock(s);
    if(flushed >= 0) {
        if(s->recording.flush_fail_streak > 0) {
            outcome = SdRecovered;
            streak = s->recording.flush_fail_streak;
        }
        s->recording.flush_fail_streak = 0;
    } else {
        streak = ++s->recording.flush_fail_streak;
        if(streak >= SD_FLUSH_FAIL_STREAK_LIMIT || !batch_ok) {
            // Stop for good. write_stopped keeps the screen's "REC
            // STOPPED" banner up; the solid red light goes with it.
            s->recording.active = false;
            s->recording.write_stopped = true;
            s->recording.flush_fail_streak = 0;  // "not active ⇒ streak 0"
            session_core_cue(s, BioMapCueSdWriteStopped);  // light only
            outcome = SdTerminated;
        } else {
            outcome = SdRidingOut;
        }
    }
    session_unlock(s);

    if(outcome == SdRecovered) {
        session_log(s, SessionLogInfo, "SD write recovered after %lu failed flush(es)",
                    (unsigned long)streak);
    } else if(outcome == SdRidingOut) {
        session_log(s, SessionLogError, "Batch flush failed (streak %lu) — buffering, retrying",
                    (unsigned long)streak);
        session_core_cue(s, BioMapCueSdRetrying);  // light only: still recording
    } else if(outcome == SdTerminated) {
        session_log(s, SessionLogError, "Batch flush failed (streak %lu) — recording stopped",
                    (unsigned long)streak);
        // Close the file (one last flush and the "# End" line, which may
        // fail too if the card is gone: then the file is left without it,
        // as after a power cut, and the visualiser flags it), then the
        // alarm, now the lock is released and the file is closed.
        s->platform.file_stop(s->platform.ctx, s->platform.epoch_now(s->platform.ctx));
        session_core_cue(s, BioMapCueSdWriteStoppedAlarm);
    }
}

bool session_core_tick(SessionCore* s) {
    bool live = (s->mode == BioMapModeLiveStream);
    if(live) live_stream_bias_check_on_first_connect(s);

    // The real time between ticks, read before anything else so a late
    // tick shows up in tick_dt_ms. (Live Stream's bias check just above,
    // on the first connect only, shows up in that one tick.) total_ticks
    // can't be used for this: it counts ticks, not time.
    uint32_t now = s->platform.now_ms(s->platform.ctx);

    session_lock(s);

    s->recording.tick_dt_ms = s->recording.last_tick_wall_ms
        ? (now - s->recording.last_tick_wall_ms) : 0;
    s->recording.last_tick_wall_ms = now;

    float rf_rssi[RF_BAND_COUNT];
    bool rf_active = has_rf(s->mode) && s->platform.rf_snapshot && s->recording.active;
    if(rf_active) s->platform.rf_snapshot(s->platform.ctx, rf_rssi);

    uint8_t packet[BT_STREAM_PACKET_SIZE];
    bool send_packet = false;
    bool batch_ok = true;  // Live Stream has no buffer to overflow
    if(live) {
        send_packet = live_stream_tick_locked(s, packet);
    } else {
        batch_ok = recording_tick_locked(s, rf_active ? rf_rssi : NULL);
    }

    s->recording.total_ticks++;

    bool do_flush = false;
    bool emit_second_diag = false;
    bool emit_telemetry = false;
    RowDiag tm = {0};
    if(++s->recording.tick_counter >= TICK_HZ) {
        // The once-a-second log lines are debug-fields only, and go out
        // after the lock is released.
        emit_second_diag = s->settings.debug_fields_enabled;
        if(s->recording.active && s->settings.debug_fields_enabled) {
            emit_telemetry = true;
            tm = get_row_diag(s);
        }
        second_boundary_locked(s);
        if(++s->recording.flush_counter >= FLUSH_INTERVAL) {
            s->recording.flush_counter = 0;
            do_flush = true;
        }
    }
    session_unlock(s);

    if(send_packet) s->platform.live_send(s->platform.ctx, packet, sizeof(packet));

    if(emit_second_diag && s->platform.second_diag) s->platform.second_diag(s->platform.ctx, s);
    if(emit_telemetry) log_telemetry(s, &tm);

    // The SD flush, with the lock released: a card write and sync takes
    // ~20–60 ms. Only while recording: the stop paths already did the
    // final write, and a flush with nothing in it would read a stale
    // failure streak as a recovery. recording.active is only written on
    // this thread, so reading it here without the lock is safe.
    if(session_mode_records(s->mode) && s->recording.active && (do_flush || !batch_ok)) {
        flush_file(s, batch_ok);
    }

    // Redraw at 2 Hz (every fifth tick): more often than that has caused
    // the Flipper's screen queue to lock up during Bluetooth activity.
    return s->recording.total_ticks % 5 == 0;
}
