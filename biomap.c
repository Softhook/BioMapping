// Bio Mapping — core: recording session, GPS hot start, main entry.
#include "biomap.h"

void format_timestamp(BioMapApp* app, char* buf, size_t sz) {
    if(app->gps) {
        GpsStatus g = gps_uart_get_status(app->gps);
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

void run_gps_hot_start(BioMapApp* app) {
    GpsUart* g = gps_uart_alloc(app->event_queue, app->notifications);
    bool ok = g && gps_uart_is_ready(g);
    if(ok) { gps_uart_send_hot_start(g); furi_delay_ms(300); }
    notification_message(app->notifications,
        ok ? &sequence_blink_green_100 : &sequence_blink_red_100);
    if(g) gps_uart_free(g);
}

// Rescale graph_buf when scroll_divider changes by a factor of 2.
//
// Each graph_buf sample = normalised EMA-derivative: total change over the
// window divided by scroll_divider, i.e. rate-per-tick.  This keeps
// amplitude consistent across all time scales.
//
// zoom_out=true  (Left key, divider ×2):
//   Average adjacent pairs — both samples represent rate-per-tick, so the
//   average is the best estimate of the rate over the merged window.
//   63 averaged samples land at the newest (right) end; the older half
//   stays zero (no data collected at this resolution yet).
//
// zoom_out=false (Right key, divider ÷2):
//   Interpolate — each old sample is already rate-per-tick and does NOT
//   need halving.  The even position keeps the original value; the odd
//   position interpolates toward the next sample for a smooth curve.
//
// This is a one-time O(N) pass on keypress; performance is not a concern.
static void rescale_graph_buf(BioMapApp* app, bool zoom_out) {
    float temp[GRAPH_N];

    // Linearise ring buffer: temp[0] = oldest sample, temp[N-1] = newest.
    for(int i = 0; i < GRAPH_N; i++) {
        temp[i] = app->graph.buf[(app->graph.head + i) % GRAPH_N];
    }
    memset(app->graph.buf, 0, sizeof(app->graph.buf));
    app->graph.head = 0;

    if(zoom_out) {
        // Average adjacent pairs (both are rate-per-tick; average preserves that).
        // 126 old samples → 63 averaged samples at positions [63..125].
        // Positions [0..62] remain zero (no data at this resolution yet).
        int half = GRAPH_N / 2; // 63
        for(int i = 0; i < half; i++) {
            app->graph.buf[half + i] = (temp[i * 2] + temp[i * 2 + 1]) * 0.5f;
        }
    } else {
        // Zoom in (÷2): split newest 63 old samples using linear interpolation.
        // Samples are already rate-per-tick — no amplitude scaling needed.
        // Even positions: keep the original rate value.
        // Odd positions: interpolate midpoint toward the next sample, avoiding
        // the staircase a simple duplicate would produce.
        int half = GRAPH_N / 2; // 63
        for(int i = 0; i < half; i++) {
            float curr = temp[half + i];
            // For the last sample there is no following neighbour — hold value.
            float next = (i + 1 < half) ? temp[half + i + 1] : curr;
            app->graph.buf[i * 2]     = curr;
            app->graph.buf[i * 2 + 1] = (curr + next) * 0.5f;
        }
    }
}

// ── Extract: handle one key press during a recording session ──────────────
// Returns true if the event was consumed (the caller should continue its
// event loop without further processing for this iteration).
static bool handle_recording_key(PluginEvent* ev, BioMapApp* app,
                                  ViewPort* vp, BioMapMode mode) {
    if(ev->type != EventTypeKey || ev->input.type != InputTypeShort)
        return false;

    switch(ev->input.key) {
    case InputKeyBack:
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        if(has_gsr(mode) && app->recording.active) {
            sd_logger_batch_flush(app->logger);
        }
        app->running = false;
        furi_mutex_release(app->mutex);
        return true;

    case InputKeyOk: {
        bool start;
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        start = !app->recording.active;
        furi_mutex_release(app->mutex);

        if(start) {
            bool ok = sd_logger_start(
                app->logger,
                (mode == BioMapModeGsrOnly)
                    ? "timestamp,tick,gsr_raw\n"
                    : "timestamp,lat,lon,alt,sats,fix,gsr_raw\n");
            if(ok) {
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                app->recording.active = true;
                strncpy(app->recording.filename,
                    sd_logger_get_filename(app->logger),
                    sizeof(app->recording.filename) - 1);
                app->recording.tick_counter = 0;
                furi_mutex_release(app->mutex);
                notification_message(app->notifications, &sequence_set_only_red_255);
            }
        } else {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->recording.active = false;
            if(has_gsr(mode)) {
                sd_logger_batch_flush(app->logger);
            }
            app->recording.filename[0] = '\0';
            furi_mutex_release(app->mutex);
            sd_logger_stop(app->logger);
            notification_message(app->notifications, &sequence_reset_rgb);
        }
        view_port_update(vp);
        return true;
    }
    case InputKeyUp:
        if(has_gsr(mode)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->zoom.enabled = false;
            app->zoom.level = fminf(app->zoom.level * ZOOM_FACTOR, ZOOM_MAX);
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
        return true;
    case InputKeyDown:
        if(has_gsr(mode)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->zoom.enabled = false;
            app->zoom.level = fmaxf(app->zoom.level / ZOOM_FACTOR, ZOOM_MIN);
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
        return true;
    case InputKeyLeft:
        if(has_gsr(mode)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->graph.scroll_divider < 16) {
                app->graph.scroll_divider *= 2;
                app->graph.tick_counter = 0;
                app->graph.last_smoothed = app->display.smoothed;
                rescale_graph_buf(app, true);
            }
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
        return true;
    case InputKeyRight:
        if(has_gsr(mode)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->graph.scroll_divider > 1) {
                app->graph.scroll_divider /= 2;
                app->graph.tick_counter = 0;
                app->graph.last_smoothed = app->display.smoothed;
                rescale_graph_buf(app, false);
            }
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
        return true;
    default:
        return false;
    }
}

// ── Extract GPS position (lat, lon, alt, sats, fix) from app state ──────
// Output params are only written when app->gps is valid; caller should
// initialise to defaults before calling.
static void get_gps_position(BioMapApp* app, float* lat, float* lon,
                              float* alt, int* sats, int* fix) {
    if(!app->gps) return;
    GpsStatus gs = gps_uart_get_status(app->gps);
    if((gs.fix_valid || gs.fix_quality > 0)
        && !isnan(gs.latitude) && !isnan(gs.longitude)) {
        *lat = gs.latitude; *lon = gs.longitude; *alt = gs.altitude;
    }
    *sats = gs.satellites_tracked;
    *fix  = gs.fix_quality;
}

static void update_display_pipeline(BioMapApp* app, int32_t raw) {
    float rf = (float)raw;
    if(!app->display.primed) {
        app->display.smoothed = rf;
        app->graph.last_smoothed = rf;
        app->display.last_displayed = raw;
        app->display.primed = true;
    }
    float ns = DISPLAY_EMA_A * rf + DISPLAY_EMA_B * app->display.smoothed;
    app->display.smoothed = ns;

    app->display.refresh_counter++;
    if(app->display.refresh_counter >= 5) {
        app->display.last_displayed = raw;
        app->display.refresh_counter = 0;
    }
}

static void update_graph_pipeline(BioMapApp* app) {
    if(app->zoom.enabled) {
        app->zoom.peak *= 0.997f;
    }

    app->graph.tick_counter++;
    if(app->graph.tick_counter >= app->graph.scroll_divider) {
        float rate = app->display.smoothed - app->graph.last_smoothed;
        app->graph.buf[app->graph.head] = -(rate / (float)app->graph.scroll_divider) * 0.2f;
        if(++app->graph.head >= GRAPH_N) app->graph.head = 0;
        app->graph.last_smoothed = app->display.smoothed;
        app->graph.tick_counter = 0;

        if(app->zoom.enabled) {
            int just_written = app->graph.head - 1;
            if(just_written < 0) just_written = GRAPH_N - 1;
            float newest = fabsf(app->graph.buf[just_written]);
            if(newest > app->zoom.peak) app->zoom.peak = newest;
            if(app->zoom.peak < 0.5f) app->zoom.peak = 0.5f;
        }
    }

    if(app->zoom.enabled && app->zoom.peak >= 0.5f) {
        float target = 80.0f / app->zoom.peak;
        target = fmaxf(ZOOM_MIN, fminf(ZOOM_MAX, target));
        app->zoom.level += (target - app->zoom.level) * 0.02f;
    }
}

static void batch_csv_row(BioMapApp* app, BioMapMode mode, int32_t raw) {
    if(app->recording.active) {
        if(has_gsr(mode)) {
            char ts[32];
            format_timestamp(app, ts, sizeof(ts));
            char row[128];
            int n = 0;

            if(mode == BioMapModeGsrOnly) {
                n = snprintf(row, sizeof(row), "%s,%d,%ld\n",
                             ts, app->recording.tick_counter, (long)raw);
            } else {
                if(app->recording.tick_counter == 0) {
                    float lat = 0, lon = 0, alt = 0;
                    int   sats = 0, fix = 0;
                    get_gps_position(app, &lat, &lon, &alt, &sats, &fix);
                    n = snprintf(row, sizeof(row),
                                 "%s,%.6f,%.6f,%.1f,%d,%d,%ld\n",
                                 ts, (double)lat, (double)lon, (double)alt,
                                 sats, fix, (long)raw);
                } else {
                    n = snprintf(row, sizeof(row), "%s,,,,,,%ld\n",
                                 ts, (long)raw);
                }
            }

            if(n > 0 && n < (int)sizeof(row)) {
                sd_logger_batch_append(app->logger, row, (size_t)n);
            }
        }
    }
}

// ── Extract: handle one GSR tick (10 Hz) during a recording session ──────
static void handle_recording_tick(BioMapApp* app, BioMapMode mode) {
    int32_t raw = 0;
    if(app->gsr) {
        gsr_sensor_tick(app->gsr);
        raw = gsr_sensor_get_raw(app->gsr);

        update_display_pipeline(app, raw);
        update_graph_pipeline(app);
    }
    batch_csv_row(app, mode, raw);
}

// ── Shared: stop logger and signal failure with red blink ─────────────────
static void handle_write_failure(BioMapApp* app) {
    if(app->logger) sd_logger_stop(app->logger);
    app->recording.active = false;
    app->recording.filename[0] = '\0';
    notification_message(app->notifications, &sequence_set_only_red_255);
}

// ── 1-second boundary: flush batch or write GPS-only row ──────────────────
static void handle_second_boundary(BioMapApp* app, BioMapMode mode) {
    if(has_gsr(mode)) {
        if(app->recording.active) {
            int flushed = sd_logger_batch_flush(app->logger);
            if(flushed > 0) {
                notification_message(app->notifications, &sequence_blink_green_100);
            } else if(flushed < 0) {
                FURI_LOG_E("BioMap", "Batch flush failed");
                handle_write_failure(app);
            }
        }
    } else {
        float lat = 0, lon = 0, alt = 0;
        int   sats = 0, fix = 0;
        get_gps_position(app, &lat, &lon, &alt, &sats, &fix);

        char ts[32];
        format_timestamp(app, ts, sizeof(ts));

        if(app->recording.active) {
            if(sd_logger_write_row(app->logger, ts, lat, lon, alt, sats, fix, 0)) {
                notification_message(app->notifications, &sequence_blink_green_100);
            } else {
                handle_write_failure(app);
            }
        }
    }

    app->recording.tick_counter = 0;
}

void run_recording_session(BioMapApp* app, BioMapMode mode) {
    app->mode = mode;
    app->display = (DisplayState){.smoothed = 0.0f, .primed = false, .last_displayed = 0, .refresh_counter = 0};
    app->graph = (GraphState){.head = 0, .tick_counter = 0, .last_smoothed = 0.0f, .scroll_divider = 1};
    app->zoom.level = 1.0f;
    app->zoom.peak = 1.0f;
    app->recording = (RecordingState){.active = false, .tick_counter = 0};
    app->recording.filename[0] = '\0';
    app->running = true;
    memset(app->graph.buf, 0, sizeof(app->graph.buf));

    app->gps = has_gps(mode) ? gps_uart_alloc(app->event_queue, app->notifications) : NULL;
    app->gsr = has_gsr(mode) ? gsr_sensor_alloc() : NULL;
    app->logger = sd_logger_alloc(app->storage);

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, biomap_render_callback, app);
    view_port_input_callback_set(vp, biomap_input_callback, app->event_queue);

    // Menu VP is already in the stack (disabled) — add recording VP on top
    gui_add_view_port(app->gui, vp, GuiLayerFullscreen);
    view_port_update(vp);

    // Apply backlight preference
    notification_message(app->notifications,
        app->backlight_on
            ? &sequence_display_backlight_enforce_on
            : &sequence_display_backlight_enforce_auto);

    FuriTimer* timer = furi_timer_alloc(biomap_timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(timer, furi_kernel_get_tick_frequency() / TICK_HZ);

    PluginEvent ev;
    while(app->running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;

        if(ev.type == EventTypeUart && app->gps) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            gps_uart_process_rx(app->gps);
            furi_mutex_release(app->mutex);
            view_port_update(vp);
            continue;
        }

        if(handle_recording_key(&ev, app, vp, mode))
            continue;

        if(ev.type == EventTypeTick) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            handle_recording_tick(app, mode);

            if(++app->recording.tick_counter >= TICK_HZ) {
                handle_second_boundary(app, mode);
            }
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
    }

    furi_timer_stop(timer);
    furi_timer_free(timer);
    if(app->recording.active) sd_logger_stop(app->logger);

    sd_logger_free(app->logger);
    app->logger = NULL;
    if(app->gsr) {
        gsr_sensor_free(app->gsr);
        app->gsr = NULL;
    }
    if(app->gps) {
        gps_uart_free(app->gps);
        app->gps = NULL;
    }

    // Restore auto backlight when leaving recording view
    notification_message(app->notifications, &sequence_display_backlight_enforce_auto);

    // Remove recording VP — menu VP is still underneath (disabled), no flash
    gui_remove_view_port(app->gui, vp);
    view_port_free(vp);
}

int32_t biomap_app(void* p) {
    UNUSED(p);
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_assert(app);
    *app = (BioMapApp){
        .zoom = {.level = 1.0f, .peak = 1.0f, .enabled = true},
        .backlight_on = false
    };

    app->event_queue   = furi_message_queue_alloc(16, sizeof(PluginEvent));
    app->mutex         = furi_mutex_alloc(FuriMutexTypeNormal);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->storage       = furi_record_open(RECORD_STORAGE);
    app->gui           = furi_record_open(RECORD_GUI);
    storage_common_mkdir(app->storage, "/ext/biomapping");
    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);

    // Create persistent menu ViewPort — stays in GUI stack for app lifetime.
    // Enabled/disabled when entering/leaving sub-screens so it never needs
    // to be removed, preventing desktop flashes between screen transitions.
    app->menu_vp = view_port_alloc();
    view_port_input_callback_set(app->menu_vp, biomap_input_callback, app->event_queue);
    view_port_enabled_set(app->menu_vp, false);
    gui_add_view_port(app->gui, app->menu_vp, GuiLayerFullscreen);

    bool running = true;
    while(running) {
        int32_t sel = biomap_gui_show_menu(app);

        switch(sel) {
        case 0: run_recording_session(app, BioMapModeGpsGsr);  break;
        case 1: run_recording_session(app, BioMapModeGpsOnly); break;
        case 2: run_recording_session(app, BioMapModeGsrOnly); break;
        case 3: run_converter(app);                             break;
        case 4: run_options_screen(app);                        break;
        default: running = false;                               break;
        }
    }

    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);

    gui_remove_view_port(app->gui, app->menu_vp);
    view_port_free(app->menu_vp);
    furi_record_close(RECORD_GUI);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_STORAGE);
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);
    return 0;
}