// Bio Mapping — recording session event loop and data-processing pipeline.
//
// All GSR/GPS data processing (EMA, graph buffer, batch CSV, graph
// rescaling, GPS position extraction, second-boundary logging) lives
// here as static functions — they exist only to serve the session.
//
// Pipeline functions operate on Session* (not BioMapApp*) so they can
// be unit-tested with a plain struct and no Flipper SDK dependency.
// Only the event loop and key handlers touch FuriMutex*/NotificationApp*.
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

// ==========================================================================
// Session lifecycle
// ==========================================================================

void session_init(Session* s, BioMapMode mode, bool zoom_enabled) {
    *s = (Session){
        .mode       = mode,
        .display    = {.smooth_iir = 0.0f, .smooth_iir_primed = false,
                       .smoothed = 0.0f, .primed = false,
                       .last_displayed = 0, .refresh_counter = 0},
        .graph      = {.head = 0, .tick_counter = 0,
                       .last_smoothed = 0.0f, .scroll_divider = 1},
        .zoom       = {.level = 1.0f, .peak = 1.0f, .enabled = zoom_enabled,
                       .manual_timeout = 0},
        .recording  = {.active = false, .tick_counter = 0, .flush_counter = 0},
        .running    = true,
    };
    memset(s->graph.buf, 0, sizeof(s->graph.buf));
}

void session_deinit(Session* s, BioMapApp* app) {
    if(s->timer) {
        furi_timer_stop(s->timer);
        furi_timer_free(s->timer);
        s->timer = NULL;
    }
    if(s->recording.active && s->logger) {
        sd_logger_batch_flush(s->logger);
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
    if(s->gps) {
        gps_uart_free(s->gps);
        s->gps = NULL;
    }
    // Restore auto backlight when leaving recording view
    notification_message(app->notifications, &sequence_display_backlight_enforce_auto);
    if(s->vp) {
        gui_remove_view_port(app->gui, s->vp);
        view_port_free(s->vp);
        s->vp = NULL;
    }
}

// ==========================================================================
// Data-processing pipeline (static — operate on Session* only)
// ==========================================================================

// ── RTC → Unix epoch seconds (UTC) ────────────────────────────────────────
// Converts a Flipper DateTime (local time) to seconds since 1970-01-01.
// Assumes the RTC is set to UTC — the Flipper has no timezone concept.
static uint32_t rtc_to_unix_epoch(const DateTime* dt) {
    // Days before each month in a non-leap year
    static const uint16_t days_before[12] = {
        0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334
    };
    // Guard against uninitialised RTC: month=0 would cause days_before[-1]
    // (OOB read on the static array).  Year < 2020 catches a completely unset
    // RTC which typically reads 2000-01-01.  Return 0 as a sentinel — callers
    // write it into the CSV header and downstream tools treat 0 as "unknown".
    if(dt->year < 2020 || dt->month < 1 || dt->month > 12 ||
       dt->day   < 1   || dt->day   > 31) {
        FURI_LOG_W("BioMap", "RTC not set — recording epoch will be 0 in CSV header");
        return 0;
    }
    uint16_t y = dt->year;
    // Whole days from 1970 to start of year y
    uint32_t days = (y - 1970) * 365U
                  + (y - 1969) / 4U
                  - (y - 1901) / 100U
                  + (y - 1601) / 400U;
    days += days_before[dt->month - 1];
    if(dt->month > 2 &&
       (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)))
        days++;  // leap day
    days += dt->day - 1;
    return (uint32_t)(days * 86400UL + dt->hour * 3600U +
                      dt->minute * 60U + dt->second);
}

// ── Relative timestamp (seconds since recording start) ────────────────────
// Uses the monotonic total_ticks counter; each tick = 100 ms at TICK_HZ=10.
static double session_rel_seconds(const Session* s) {
    return (double)s->recording.total_ticks / 10;
}

// ── Graph rescaling (time-axis zoom) ───────────────────────────────────────
// Called on Left/Right key during GSR recording sessions.
// zoom_out=true  → average adjacent pairs, halving resolution
// zoom_out=false → interpolate, doubling resolution
//
// This is a one-time O(N) pass on keypress; performance is not a concern.
static void rescale_graph_buf(Session* s, bool zoom_out) {
    float temp[GRAPH_N];

    // Linearise ring buffer: temp[0] = oldest sample, temp[N-1] = newest.
    for(int i = 0; i < GRAPH_N; i++) {
        temp[i] = s->graph.buf[(s->graph.head + i) % GRAPH_N];
    }
    memset(s->graph.buf, 0, sizeof(s->graph.buf));
    s->graph.head = 0;

    if(zoom_out) {
        // Average adjacent pairs (both are rate-per-tick; average preserves that).
        // 126 old samples → 63 averaged samples at positions [63..125].
        // Positions [0..62] remain zero (no data at this resolution yet).
        for(int i = 0; i < GRAPH_HALF; i++) {
            s->graph.buf[GRAPH_HALF + i] = (temp[i * 2] + temp[i * 2 + 1]) * 0.5f;
        }
    } else {
        // Zoom in (÷2): split newest 63 old samples using linear interpolation.
        // Samples are already rate-per-tick — no amplitude scaling needed.
        // Even positions: keep the original rate value.
        // Odd positions: interpolate midpoint toward the next sample, avoiding
        // the staircase a simple duplicate would produce.
        for(int i = 0; i < GRAPH_HALF; i++) {
            float curr = temp[GRAPH_HALF + i];
            // For the last sample there is no following neighbour — hold value.
            float next = (i + 1 < GRAPH_HALF) ? temp[GRAPH_HALF + i + 1] : curr;
            s->graph.buf[i * 2]     = curr;
            s->graph.buf[i * 2 + 1] = (curr + next) * 0.5f;
        }
    }
}

// ── GPS position extraction ────────────────────────────────────────────────
// Returns a GpsPosition snapshot.  .valid is true only when GPS has a fix.
static GpsPosition get_gps_position(const Session* s) {
    GpsPosition pos = {0};
    pos.hdop      = 99.9f;   // sentinel: unknown until GGA/GSA arrives
    pos.pdop      = 99.9f;
    pos.fix_type  = 1;       // 1=no fix
    pos.speed_kts = NAN;
    pos.course_deg = NAN;
    if(!s->gps) return pos;
    GpsStatus gs = gps_uart_get_status(s->gps);
    pos.sats      = gs.satellites_tracked;
    pos.hdop      = gs.hdop;
    pos.fix_type  = gs.fix_type;
    pos.speed_kts  = gs.speed;
    pos.course_deg = gs.course;
    pos.pdop       = gs.pdop;
    if((gs.fix_valid || gs.fix_quality > 0)
        && !isnan(gs.latitude) && !isnan(gs.longitude)) {
        pos.valid = true;
        pos.lat = gs.latitude;
        pos.lon = gs.longitude;
    }
    return pos;
}

// ── Post-decimation smoothing IIR ──────────────────────────────────────────
// First-order IIR at fc ≈ 3 Hz (α = 1 - e^{-2π·3/10} ≈ 0.848).
// Runs at 10 Hz AFTER the 100:1 boxcar decimation — aliasing at the
// 860→10 Hz downsampling step is a one-way door, so this filter
// attenuates both real high-frequency GSR and any aliased noise that
// already leaked into the 0–5 Hz band.  For a physiological signal
// with >95 % of power below 1 Hz, the net effect is still a net SNR
// improvement — real GSR at 3–5 Hz loses <3 dB while aliased broadband
// EMI (radio, switching artifacts) is suppressed.
//
// True anti-aliasing would require filtering at 860 SPS before the
// boxcar.  That is avoided here because PGA autoranging jumps cause
// the IIR state to become stale; handling that cleanly at 860 SPS
// adds complexity.  The boxcar itself is the pre-decimation filter.
//
// At 3 Hz the phase lag is ~50 ms — invisible for GSR where phasic
// responses have 1–3 s rise times.  Signal attenuation at 2 Hz
// (fastest measurable SCR onset) is <0.5 dB.
static float smooth_iir_filter(DisplayState* d, float raw) {
    if(!d->smooth_iir_primed) {
        d->smooth_iir = raw;
        d->smooth_iir_primed = true;
        return raw;
    }
    d->smooth_iir = SMOOTH_IIR_A * raw + SMOOTH_IIR_B * d->smooth_iir;
    return d->smooth_iir;
}

// ── Display pipeline ───────────────────────────────────────────────────────
// Post-decimation smoothing IIR → EMA smoothing of GSR readings.
static void update_display_pipeline(Session* s, float raw) {
    float filtered = smooth_iir_filter(&s->display, raw);

    if(!s->display.primed) {
        s->display.smoothed = filtered;
        s->graph.last_smoothed = filtered;
        s->display.last_displayed = filtered;
        s->display.primed = true;
    }
    float ns = DISPLAY_EMA_A * filtered + DISPLAY_EMA_B * s->display.smoothed;
    s->display.smoothed = ns;

    s->display.refresh_counter++;
    if(s->display.refresh_counter >= REFRESH_EVERY) {
        s->display.last_displayed = filtered;
        s->display.refresh_counter = 0;
    }
}

// ── Graph pipeline ─────────────────────────────────────────────────────────
// Build the graph ring buffer from smoothed GSR derivative rate.
// Handles auto-zoom peak tracking and zoom-level lerp.
// Manual zoom (Up/Down) sets a timeout; auto-zoom re-engages when it
// expires, with a seamless transition (peak set so target = current level).
static void update_graph_pipeline(Session* s) {
    // Decrement manual zoom timeout; on expiry set peak so the lerp
    // target matches the current manual level — no visual jump.
    if(s->zoom.manual_timeout > 0) {
        s->zoom.manual_timeout--;
        if(s->zoom.manual_timeout == 0) {
            s->zoom.peak = ZOOM_TARGET_DIV / s->zoom.level;
            if(s->zoom.peak < ZOOM_PEAK_FLOOR) s->zoom.peak = ZOOM_PEAK_FLOOR;
        }
    }

    bool auto_active = s->zoom.enabled && s->zoom.manual_timeout == 0;

    if(auto_active) {
        s->zoom.peak *= ZOOM_PEAK_DECAY;
    }

    s->graph.tick_counter++;
    if(s->graph.tick_counter >= s->graph.scroll_divider) {
        float rate = s->display.smoothed - s->graph.last_smoothed;
        s->graph.buf[s->graph.head] = -(rate / (float)s->graph.scroll_divider) * GRAPH_RATE_SCALE;
        if(++s->graph.head >= GRAPH_N) s->graph.head = 0;
        s->graph.last_smoothed = s->display.smoothed;
        s->graph.tick_counter = 0;

        if(auto_active) {
            int just_written = s->graph.head - 1;
            if(just_written < 0) just_written = GRAPH_N - 1;
            float newest = fabsf(s->graph.buf[just_written]);
            if(newest > s->zoom.peak) s->zoom.peak = newest;
            if(s->zoom.peak < ZOOM_PEAK_FLOOR) s->zoom.peak = ZOOM_PEAK_FLOOR;
        }
    }

    if(auto_active && s->zoom.peak >= ZOOM_PEAK_FLOOR) {
        float target = ZOOM_TARGET_DIV / s->zoom.peak;
        target = fmaxf(ZOOM_MIN, fminf(ZOOM_MAX, target));
        s->zoom.level += (target - s->zoom.level) * ZOOM_LERP_RATE;
    }
}

// ── Shared GPS CSV row formatter ───────────────────────────────────────────
// Formats a 10-column GPS row into the SD batch buffer with an explicit GSR
// value in the last column.  Used by both GPS+GSR mode (via batch_csv_row
// with the live GSR reading) and GPS-only mode (via handle_recording_tick
// with raw=0).  When the fix is absent or HDOP is too high, GPS columns are
// left empty so the analyser treats the row as a gap rather than noise.
// Returns true on success, false on buffer overflow.
static bool format_gps_csv_row(Session* s, const GpsPosition* pos,
                                double rel, float raw) {
    bool gps_ok = pos->valid && pos->hdop < GPS_HDOP_GATE;
    int ret;
    if(gps_ok) {
        bool has_vel = !isnan(pos->speed_kts) && !isnan(pos->course_deg);
        if(has_vel) {
            ret = sd_logger_batch_printf(s->logger,
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f\n",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type,
                (double)pos->speed_kts, (double)pos->course_deg, (double)raw);
        } else {
            ret = sd_logger_batch_printf(s->logger,
                "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,,,%.1f\n",
                rel, pos->lat, pos->lon,
                (double)pos->hdop, (double)pos->pdop,
                pos->sats, pos->fix_type, (double)raw);
        }
    } else {
        ret = sd_logger_batch_printf(s->logger, "%.2f,,,,,,,,,%.1f\n",
                                     rel, (double)raw);
    }
    return ret > 0;
}

// ── Batch CSV row construction ─────────────────────────────────────────────
// Dispatches to format_gps_csv_row for GPS+GSR mode; handles GSR-only
// and GPS-skip ticks directly.  Rows are flushed at the 1‑second boundary
// by handle_second_boundary().
// Returns true on success, false on buffer overflow.
static bool batch_csv_row(Session* s, float raw) {
    if(!s->recording.active || !has_gsr(s->mode)) return true;

    double rel = session_rel_seconds(s);
    int ret;

    if(s->mode == BioMapModeGsrOnly) {
        ret = sd_logger_batch_printf(s->logger, "%.2f,%.1f\n",
                                     rel, (double)raw);
    } else if(s->recording.tick_counter % (TICK_HZ / GPS_CSV_HZ) == 0) {
        GpsPosition pos = get_gps_position(s);
        return format_gps_csv_row(s, &pos, rel, raw);
    } else {
        // GPS-skip tick: preserve GSR data with empty GPS columns.
        GpsPosition empty = {0};
        return format_gps_csv_row(s, &empty, rel, raw);
    }
    return ret > 0;
}

// ── Write failure handler ──────────────────────────────────────────────────
// Stop the logger, clear recording state, and signal with red LED.
static void handle_write_failure(Session* s, NotificationApp* notifications) {
    if(s->logger) sd_logger_stop(s->logger);
    s->recording.active = false;
    notification_message(notifications, &sequence_set_only_red_255);
}

// ── 1‑second boundary ──────────────────────────────────────────────────────
// Called once per second.  Blinks the recording LED at 1 Hz and flushes the
// SD batch buffer every FLUSH_INTERVAL seconds (decoupled — LED always 1 Hz).
// GPS rows are written in handle_recording_tick; GSR rows in batch_csv_row.
static void handle_second_boundary(Session* s, NotificationApp* notifications) {
    if(!s->recording.active) {
        s->recording.tick_counter = 0;
        return;
    }

    // ── LED blink (every second, independent of flush interval) ────────
    // 500 ms blink — green when sensor OK, red when cuffs need attention.
    if(has_gsr(s->mode) && s->gsr && !gsr_sensor_is_connected(s->gsr)) {
        notification_message(notifications, &sequence_blink_red_500);
    } else {
        notification_message(notifications, &sequence_blink_green_500);
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
            handle_write_failure(s, notifications);
        }
    }

    s->recording.tick_counter = 0;
}

// ==========================================================================
// Recording session — key handling, tick processing, event loop
// ==========================================================================

// ── Key-action helpers (extracted from handle_recording_key) ──────────────

// Toggle recording on/off.  Returns true to request a view_port_update.
static bool key_toggle_recording(Session* s, FuriMutex* mutex,
                                  NotificationApp* notifications) {
    bool start;
    furi_mutex_acquire(mutex, FuriWaitForever);
    start = !s->recording.active;
    furi_mutex_release(mutex);

    if(start) {
        // Build header: recording-start metadata line + column names.
        DateTime dt;
        furi_hal_rtc_get_datetime(&dt);
        uint32_t epoch = rtc_to_unix_epoch(&dt);
        const char* cols = (s->mode == BioMapModeGsrOnly)
            ? "timestamp,gsr_raw\n"
            : "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw\n";
        char header[256];
        int n = snprintf(header, sizeof(header),
                         "# RecordingStartTime:%lu\n%s", (unsigned long)epoch, cols);
        if(n < 0 || (size_t)n >= sizeof(header)) {
            FURI_LOG_E("BioMap", "Header too long");
            return false;
        }
        bool ok = sd_logger_start(s->logger, header);
        if(ok) {
            furi_mutex_acquire(mutex, FuriWaitForever);
            s->recording.active = true;
            s->recording.tick_counter = 0;
            s->recording.total_ticks  = 0;
            furi_mutex_release(mutex);
            // Recording indicator: the green LED flash from
            // handle_second_boundary is used instead of a solid red LED.
            // This avoids a notification-layer conflict where the green
            // blink sequence clears the red LED state.
        }
    } else {
        furi_mutex_acquire(mutex, FuriWaitForever);
        s->recording.active = false;
        sd_logger_batch_flush(s->logger);
        furi_mutex_release(mutex);
        sd_logger_stop(s->logger);
        notification_message(notifications, &sequence_blink_stop);
    }
    return true;  // caller should view_port_update
}

// Manual vertical zoom (Up=zoom in, Down=zoom out).  Sets a timeout after
// which auto-zoom re-engages (if enabled in Options).  Each keypress resets
// the timeout so continuous adjustment keeps auto-zoom paused.
static void key_zoom_vertical(Session* s, FuriMutex* mutex, bool zoom_in) {
    furi_mutex_acquire(mutex, FuriWaitForever);
    s->zoom.manual_timeout = MANUAL_ZOOM_TIMEOUT;
    s->zoom.level = zoom_in
        ? fminf(s->zoom.level * ZOOM_FACTOR, ZOOM_MAX)
        : fmaxf(s->zoom.level / ZOOM_FACTOR, ZOOM_MIN);
    furi_mutex_release(mutex);
}

// Horizontal time-axis zoom (Left=zoom out, Right=zoom in).
static void key_zoom_horizontal(Session* s, FuriMutex* mutex, bool zoom_out) {
    furi_mutex_acquire(mutex, FuriWaitForever);
    if(zoom_out) {
        if(s->graph.scroll_divider < 16) {
            s->graph.scroll_divider *= 2;
            s->graph.tick_counter = 0;
            s->graph.last_smoothed = s->display.smoothed;
            rescale_graph_buf(s, true);
        }
    } else {
        if(s->graph.scroll_divider > 1) {
            s->graph.scroll_divider /= 2;
            s->graph.tick_counter = 0;
            s->graph.last_smoothed = s->display.smoothed;
            rescale_graph_buf(s, false);
        }
    }
    furi_mutex_release(mutex);
}

// ── Handle one key press during a recording session ────────────────────────
// Returns true if the event was consumed (the caller should continue its
// event loop without further processing for this iteration).
static bool handle_recording_key(PluginEvent* ev, Session* s,
                                  FuriMutex* mutex, ViewPort* vp) {
    if(ev->type != EventTypeKey || ev->input.type != InputTypeShort)
        return false;

    switch(ev->input.key) {
    case InputKeyBack:
        furi_mutex_acquire(mutex, FuriWaitForever);
        if(s->recording.active) {
            sd_logger_batch_flush(s->logger);
        }
        s->running = false;
        furi_mutex_release(mutex);
        return true;

    case InputKeyOk:
        // key_toggle_recording needs NotificationApp* — pass NULL for now;
        // the actual notifications pointer is available in the caller.
        // (This is caught at build time — see the caller below.)
        return false;  // handled by caller with full context

    case InputKeyUp:
        if(has_gsr(s->mode)) { key_zoom_vertical(s, mutex, true);  view_port_update(vp); }
        return true;
    case InputKeyDown:
        if(has_gsr(s->mode)) { key_zoom_vertical(s, mutex, false); view_port_update(vp); }
        return true;

    case InputKeyLeft:
        if(has_gsr(s->mode)) { key_zoom_horizontal(s, mutex, true);  view_port_update(vp); }
        return true;
    case InputKeyRight:
        if(has_gsr(s->mode)) { key_zoom_horizontal(s, mutex, false); view_port_update(vp); }
        return true;

    default:
        return false;
    }
}

// ── Handle one GSR tick (10 Hz) during a recording session ────────────────
// Returns true on success, false if a batch overflow occurred (caller should
// flush and potentially stop recording).
static bool handle_recording_tick(Session* s) {
    // ── GPS-only mode: write a row on the GPS tick boundary ────────────
    if(!has_gsr(s->mode) && has_gps(s->mode) && s->recording.active) {
        if(s->recording.tick_counter % (TICK_HZ / GPS_CSV_HZ) == 0) {
            GpsPosition pos = get_gps_position(s);
            return format_gps_csv_row(s, &pos, session_rel_seconds(s), 0.0f);
        }
        return true;
    }

    // ── GSR modes (GsrOnly, GpsGsr) ────────────────────────────────────
    float raw = 0.0f;
    if(s->gsr) {
        gsr_sensor_tick(s->gsr);
        raw = gsr_sensor_get_raw(s->gsr);

        // ── Instantaneous per-tick validity check ────────────────────
        // The connected flag uses a 20-tick (2 s) debounce to prevent
        // CSV false positives, but that delay lets 2 seconds of insane
        // values through to the display pipeline — corrupting the IIR
        // state and auto-zoom.  Instead, we gate the display update on
        // the instantaneous tick value: anything outside physiological
        // range (< 0.1 nS open circuit, > 50 000 nS rail saturation)
        // is rejected immediately.
        //
        // The smoothing IIR stays primed at its last valid state, the
        // auto-zoom doesn't spike, and the graph keeps showing the
        // last valid waveform.  The CSV still logs the exact value
        // (0.0 or rail) on every tick so the record is complete.
        bool valid = (raw >= GSR_VALID_MIN_NS && raw <= GSR_VALID_MAX_NS);
        if(valid) {
            // ── Re-connect smoothing ────────────────────────────────
            // When the sensor comes back after a disconnect, the graph
            // pipeline computes rate = smoothed - last_smoothed where
            // last_smoothed is stale (from before the gap).  The
            // resulting spike floods the graph buffer and makes the
            // display "catch up" at hyperspeed.  We detect a recovery
            // by comparing raw to last_displayed: if the delta exceeds
            // 500 nS/tick (far faster than real GSR), we run the
            // display pipeline then sync graph.last_smoothed to the
            // new smoothed value so the first rate is ~0.
            float delta = (raw > s->display.last_displayed)
                ? raw - s->display.last_displayed
                : s->display.last_displayed - raw;
            bool recovering = s->display.primed && (delta > 500.0f);

            update_display_pipeline(s, raw);

            if(recovering) {
                s->graph.last_smoothed = s->display.smoothed;
            }

            update_graph_pipeline(s);
        }
    }
    return batch_csv_row(s, raw);
}

// ── Run a recording session for the given mode ─────────────────────────────
// Blocks until the user presses Back or an unrecoverable error occurs.
// Allocates modules via session_init(); cleans up via session_deinit().
void run_recording_session(BioMapApp* app, BioMapMode mode) {
    Session* s = &app->session;
    session_init(s, mode, app->zoom_enabled);

    if(has_gps(mode)) {
        s->gps = gps_uart_alloc(app->event_queue, app->notifications);
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
    }
    s->logger = sd_logger_alloc(app->storage);

    s->vp = view_port_alloc();
    view_port_draw_callback_set(s->vp, biomap_render_callback, app);
    view_port_input_callback_set(s->vp, biomap_input_callback, app->event_queue);

    // Menu VP is already in the stack (disabled) — add recording VP on top
    gui_add_view_port(app->gui, s->vp, GuiLayerFullscreen);
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
            if(key_toggle_recording(s, app->mutex, app->notifications))
                view_port_update(s->vp);
            continue;
        }

        if(handle_recording_key(&ev, s, app->mutex, s->vp))
            continue;

        if(ev.type == EventTypeTick) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            bool batch_ok = handle_recording_tick(s);
            s->recording.total_ticks++;

            if(++s->recording.tick_counter >= TICK_HZ) {
                handle_second_boundary(s, app->notifications);
            }

            // Batch overflow: try an emergency flush.  If even the flush
            // fails, stop recording and notify the user via red LED.
            if(!batch_ok) {
                FURI_LOG_W("BioMap", "Batch overflow — emergency flush");
                int flushed = sd_logger_batch_flush(s->logger);
                if(flushed < 0) {
                    FURI_LOG_E("BioMap", "Emergency flush failed — stopping recording");
                    handle_write_failure(s, app->notifications);
                }
            }
            furi_mutex_release(app->mutex);
            view_port_update(s->vp);
        }
    }

    session_deinit(s, app);
}
