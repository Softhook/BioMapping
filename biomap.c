// Bio Mapping — core: recording session, GPS hot start, main entry.
#include "biomap.h"

void format_timestamp(BioMapApp* app, char* buf, size_t sz) {
    if(app->gps) {
        GpsStatus g = gps_uart_get_status(app->gps);
        if(g.date.year) {
            int y = g.date.year + (g.date.year < 80 ? 2000 : 1900);
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
        temp[i] = app->graph_buf[(app->graph_head + i) % GRAPH_N];
    }
    memset(app->graph_buf, 0, sizeof(app->graph_buf));
    app->graph_head = 0;

    if(zoom_out) {
        // Average adjacent pairs (both are rate-per-tick; average preserves that).
        // 126 old samples → 63 averaged samples at positions [63..125].
        // Positions [0..62] remain zero (no data at this resolution yet).
        int half = GRAPH_N / 2; // 63
        for(int i = 0; i < half; i++) {
            app->graph_buf[half + i] = (temp[i * 2] + temp[i * 2 + 1]) * 0.5f;
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
            app->graph_buf[i * 2]     = curr;
            app->graph_buf[i * 2 + 1] = (curr + next) * 0.5f;
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
        if(has_gsr(mode) && app->recording_active) {
            sd_logger_batch_flush(app->logger);
        }
        app->running = false;
        furi_mutex_release(app->mutex);
        return true;

    case InputKeyOk: {
        bool start;
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        start = !app->recording_active;
        furi_mutex_release(app->mutex);

        if(start) {
            bool ok = (mode == BioMapModeGsrOnly)
                ? sd_logger_start_gsr(app->logger)
                : sd_logger_start(app->logger);
            if(ok) {
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                app->recording_active = true;
                strncpy(app->recording_filename,
                    sd_logger_get_filename(app->logger),
                    sizeof(app->recording_filename) - 1);
                app->tick_counter = app->raw_count = app->gsr_raw_sum = 0;
                furi_mutex_release(app->mutex);
                notification_message(app->notifications, &sequence_set_only_red_255);
            }
        } else {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->recording_active = false;
            if(has_gsr(mode)) {
                sd_logger_batch_flush(app->logger);
            }
            app->recording_filename[0] = '\0';
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
            app->auto_zoom_enabled = false;
            app->zoom_level = fminf(app->zoom_level * ZOOM_FACTOR, ZOOM_MAX);
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
        return true;
    case InputKeyDown:
        if(has_gsr(mode)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->auto_zoom_enabled = false;
            app->zoom_level = fmaxf(app->zoom_level / ZOOM_FACTOR, ZOOM_MIN);
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
        return true;
    case InputKeyLeft:
        if(has_gsr(mode)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->scroll_divider < 16) {
                app->scroll_divider *= 2;
                app->graph_tick_counter = 0;
                app->graph_last_smoothed = app->display_smoothed;
                rescale_graph_buf(app, true);
            }
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
        return true;
    case InputKeyRight:
        if(has_gsr(mode)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(app->scroll_divider > 1) {
                app->scroll_divider /= 2;
                app->graph_tick_counter = 0;
                app->graph_last_smoothed = app->display_smoothed;
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

// ── Extract: handle one GSR tick (10 Hz) during a recording session ──────
static void handle_recording_tick(BioMapApp* app, BioMapMode mode) {
    int32_t raw = 0;
    if(app->gsr) {
        gsr_sensor_tick(app->gsr);
        raw = gsr_sensor_get_raw(app->gsr);

        float rf = (float)raw;
        if(!app->display_primed) {
            app->display_smoothed = rf;
            app->graph_last_smoothed = rf;
            app->last_displayed_gsr = raw;
            app->display_primed = true;
        }
        float ns = DISPLAY_EMA_A * rf + DISPLAY_EMA_B * app->display_smoothed;
        app->display_smoothed = ns;

        app->text_refresh_counter++;
        if(app->text_refresh_counter >= 5) {
            app->last_displayed_gsr = raw;
            app->text_refresh_counter = 0;
        }

        if(app->auto_zoom_enabled) {
            app->auto_zoom_peak *= 0.997f;
        }

        app->graph_tick_counter++;
        if(app->graph_tick_counter >= app->scroll_divider) {
            float rate = app->display_smoothed - app->graph_last_smoothed;
            app->graph_buf[app->graph_head] = -(rate / (float)app->scroll_divider) * 0.2f;
            if(++app->graph_head >= GRAPH_N) app->graph_head = 0;
            app->graph_last_smoothed = app->display_smoothed;
            app->graph_tick_counter = 0;

            if(app->auto_zoom_enabled) {
                int just_written = app->graph_head - 1;
                if(just_written < 0) just_written = GRAPH_N - 1;
                float newest = fabsf(app->graph_buf[just_written]);
                if(newest > app->auto_zoom_peak) app->auto_zoom_peak = newest;
                if(app->auto_zoom_peak < 0.5f) app->auto_zoom_peak = 0.5f;
            }
        }

        if(mode == BioMapModeGpsOnly) {
            app->gsr_raw_sum += raw;
            app->raw_count++;
        }

        if(app->auto_zoom_enabled && app->auto_zoom_peak >= 0.5f) {
            float target = 80.0f / app->auto_zoom_peak;
            target = fmaxf(ZOOM_MIN, fminf(ZOOM_MAX, target));
            app->zoom_level += (target - app->zoom_level) * 0.02f;
        }
    }

    // ── Batch CSV row formatting (10 Hz modes) ──────────────────────
    if(app->recording_active) {
        if(has_gsr(mode)) {
            char ts[32];
            format_timestamp(app, ts, sizeof(ts));
            char row[128];
            int n = 0;

            if(mode == BioMapModeGsrOnly) {
                n = snprintf(row, sizeof(row), "%s,%ld\n", ts, (long)raw);
            } else {
                if(app->tick_counter == 0) {
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

// ── Shared: stop logger and signal failure with red blink ─────────────────
static void handle_write_failure(BioMapApp* app) {
    if(app->logger) sd_logger_stop(app->logger);
    app->recording_active = false;
    app->recording_filename[0] = '\0';
    notification_message(app->notifications, &sequence_set_only_red_255);
}

// ── 1-second boundary: flush batch or write GPS-only row ──────────────────
static void handle_second_boundary(BioMapApp* app, BioMapMode mode) {
    if(has_gsr(mode)) {
        if(app->recording_active) {
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

        int32_t avg = app->raw_count ? (app->gsr_raw_sum / app->raw_count) : 0;
        char ts[32];
        format_timestamp(app, ts, sizeof(ts));

        if(app->recording_active) {
            if(sd_logger_write_row(app->logger, ts, lat, lon, alt, sats, fix, avg)) {
                notification_message(app->notifications, &sequence_blink_green_100);
            } else {
                handle_write_failure(app);
            }
        }
    }

    app->tick_counter = app->raw_count = app->gsr_raw_sum = 0;
}

void run_recording_session(BioMapApp* app, BioMapMode mode) {
    app->mode = mode;
    app->gsr_raw_sum = app->raw_count = app->tick_counter = app->graph_head = 0;
    app->display_smoothed = 0.0f;
    app->display_primed   = false;
    app->scroll_divider = 1;
    app->graph_tick_counter = 0;
    app->graph_last_smoothed = 0.0f;
    app->recording_active = false;
    app->recording_filename[0] = '\0';
    app->running = true;
    app->zoom_level = 1.0f;
    app->auto_zoom_peak = 1.0f;
    memset(app->graph_buf, 0, sizeof(app->graph_buf));

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

            if(++app->tick_counter >= TICK_HZ) {
                handle_second_boundary(app, mode);
            }
            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
    }

    furi_timer_stop(timer);
    furi_timer_free(timer);
    if(app->recording_active) sd_logger_stop(app->logger);

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
    *app = (BioMapApp){.zoom_level = 1.0f, .auto_zoom_enabled = true, .backlight_on = false};

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
    view_port_draw_callback_set(app->menu_vp, menu_render, app);
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