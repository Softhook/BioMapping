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

// ==========================================================================
// Session lifecycle
// ==========================================================================

void session_init(Session* s, BioMapMode mode, bool zoom_enabled) {
    *s = (Session){
        .mode       = mode,
        .display    = {.smoothed = 0.0f, .primed = false,
                       .last_displayed = 0, .refresh_counter = 0},
        .graph      = {.head = 0, .tick_counter = 0,
                       .last_smoothed = 0.0f, .scroll_divider = 1},
        .zoom       = {.level = 1.0f, .peak = 1.0f, .enabled = zoom_enabled,
                       .manual_timeout = 0},
        .recording  = {.active = false, .tick_counter = 0},
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

// ── Timestamp formatting from session GPS or RTC fallback ──────────────────
static void session_format_timestamp(const Session* s, char* buf, size_t sz) {
    if(s->gps) {
        GpsStatus g = gps_uart_get_status(s->gps);
        if(g.date.year) {
            int y = gps_year_expand(g.date.year);
            snprintf(buf, sz, "%04d-%02d-%02dT%02d:%02d:%02dZ",
                y, g.date.month, g.date.day,
                g.time.hours, g.time.minutes, g.time.seconds);
            return;
        }
    }
    DateTime dt;
    furi_hal_rtc_get_datetime(&dt);
    snprintf(buf, sz, "%04d-%02d-%02dT%02d:%02d:%02dZ",
        (int)dt.year, (int)dt.month, (int)dt.day,
        (int)dt.hour, (int)dt.minute, (int)dt.second);
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
    if(!s->gps) return pos;
    GpsStatus gs = gps_uart_get_status(s->gps);
    pos.sats = gs.satellites_tracked;
    pos.fix  = gs.fix_quality;
    if((gs.fix_valid || gs.fix_quality > 0)
        && !isnan(gs.latitude) && !isnan(gs.longitude)) {
        pos.valid = true;
        pos.lat = gs.latitude;
        pos.lon = gs.longitude;
        pos.alt = gs.altitude;
    }
    return pos;
}

// ── Display pipeline ───────────────────────────────────────────────────────
// EMA smoothing of raw GSR readings for on-screen display.
static void update_display_pipeline(Session* s, int32_t raw) {
    float rf = (float)raw;
    if(!s->display.primed) {
        s->display.smoothed = rf;
        s->graph.last_smoothed = rf;
        s->display.last_displayed = raw;
        s->display.primed = true;
    }
    float ns = DISPLAY_EMA_A * rf + DISPLAY_EMA_B * s->display.smoothed;
    s->display.smoothed = ns;

    s->display.refresh_counter++;
    if(s->display.refresh_counter >= REFRESH_EVERY) {
        s->display.last_displayed = raw;
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

// ── Batch CSV row construction ─────────────────────────────────────────────
// Formats each CSV row directly into the SD logger's internal batch buffer,
// avoiding an intermediate stack buffer and a memcpy per tick.
// Rows are flushed to SD at the 1‑second boundary by handle_second_boundary().
static void batch_csv_row(Session* s, int32_t raw) {
    if(!s->recording.active || !has_gsr(s->mode)) return;

    char ts[32];
    session_format_timestamp(s, ts, sizeof(ts));

    if(s->mode == BioMapModeGsrOnly) {
        sd_logger_batch_printf(s->logger, "%s,%d,%ld\n",
                               ts, s->recording.tick_counter, (long)raw);
    } else if(s->recording.tick_counter == 0) {
        GpsPosition pos = get_gps_position(s);
        sd_logger_batch_printf(s->logger,
                               "%s,%.6f,%.6f,%.1f,%d,%d,%ld\n",
                               ts, (double)pos.lat, (double)pos.lon, (double)pos.alt,
                               pos.sats, pos.fix, (long)raw);
    } else {
        sd_logger_batch_printf(s->logger, "%s,,,,,,%ld\n",
                               ts, (long)raw);
    }
}

// ── Write failure handler ──────────────────────────────────────────────────
// Stop the logger, clear recording state, and signal with red LED.
static void handle_write_failure(Session* s, NotificationApp* notifications) {
    if(s->logger) sd_logger_stop(s->logger);
    s->recording.active = false;
    notification_message(notifications, &sequence_set_only_red_255);
}

// ── 1‑second boundary ──────────────────────────────────────────────────────
// Called once per second.  All modes use the batch API for SD writes —
// GSR modes accumulate rows each tick; GPS-only builds one row here.
// Both flush through sd_logger_batch_flush with the same notification pattern.
static void handle_second_boundary(Session* s, NotificationApp* notifications) {
    if(!s->recording.active) {
        s->recording.tick_counter = 0;
        return;
    }

    if(!has_gsr(s->mode)) {
        // GPS-only: build one row per second via the batch API
        GpsPosition pos = get_gps_position(s);
        char ts[32];
        session_format_timestamp(s, ts, sizeof(ts));
        sd_logger_batch_printf(s->logger,
            "%s,%.6f,%.6f,%.1f,%d,%d,%d\n",
            ts, (double)pos.lat, (double)pos.lon, (double)pos.alt,
            pos.sats, pos.fix, 0);
    }

    int flushed = sd_logger_batch_flush(s->logger);
    if(flushed > 0) {
        notification_message(notifications, &sequence_blink_green_100);
    } else if(flushed < 0) {
        FURI_LOG_E("BioMap", "Batch flush failed");
        handle_write_failure(s, notifications);
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
        bool ok = sd_logger_start(
            s->logger,
            (s->mode == BioMapModeGsrOnly)
                ? "timestamp,tick,gsr_raw\n"
                : "timestamp,lat,lon,alt,sats,fix,gsr_raw\n");
        if(ok) {
            furi_mutex_acquire(mutex, FuriWaitForever);
            s->recording.active = true;
            s->recording.tick_counter = 0;
            furi_mutex_release(mutex);
            notification_message(notifications, &sequence_set_only_red_255);
        }
    } else {
        furi_mutex_acquire(mutex, FuriWaitForever);
        s->recording.active = false;
        if(has_gsr(s->mode)) {
            sd_logger_batch_flush(s->logger);
        }
        furi_mutex_release(mutex);
        sd_logger_stop(s->logger);
        notification_message(notifications, &sequence_reset_rgb);
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
        if(has_gsr(s->mode) && s->recording.active) {
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
static void handle_recording_tick(Session* s) {
    int32_t raw = 0;
    if(s->gsr) {
        gsr_sensor_tick(s->gsr);
        raw = gsr_sensor_get_raw(s->gsr);

        update_display_pipeline(s, raw);
        update_graph_pipeline(s);
    }
    batch_csv_row(s, raw);
}

// ── Run a recording session for the given mode ─────────────────────────────
// Blocks until the user presses Back or an unrecoverable error occurs.
// Allocates modules via session_init(); cleans up via session_deinit().
void run_recording_session(BioMapApp* app, BioMapMode mode) {
    Session* s = &app->session;
    session_init(s, mode, app->zoom_enabled);

    s->gps    = has_gps(mode) ? gps_uart_alloc(app->event_queue, app->notifications) : NULL;
    s->gsr    = has_gsr(mode) ? gsr_sensor_alloc() : NULL;
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

        if(ev.type == EventTypeUart && s->gps) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            gps_uart_process_rx(s->gps);
            furi_mutex_release(app->mutex);
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
            handle_recording_tick(s);

            if(++s->recording.tick_counter >= TICK_HZ) {
                handle_second_boundary(s, app->notifications);
            }
            furi_mutex_release(app->mutex);
            view_port_update(s->vp);
        }
    }

    session_deinit(s, app);
}
