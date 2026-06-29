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

        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            switch(ev.input.key) {
            case InputKeyBack:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                app->running = false;
                furi_mutex_release(app->mutex);
                break;
            case InputKeyOk: {
                bool start;
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                start = !app->recording_active;
                furi_mutex_release(app->mutex);

                if(start) {
                    if(sd_logger_start(app->logger)) {
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
                    sd_logger_stop(app->logger);
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->recording_active = false;
                    app->recording_filename[0] = '\0';
                    furi_mutex_release(app->mutex);
                    notification_message(app->notifications, &sequence_reset_rgb);
                }
                view_port_update(vp);
                break;
            }
            case InputKeyUp:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    // Disable auto-zoom so the manual adjustment isn't
                    // immediately counteracted by the lerp in the tick handler.
                    app->auto_zoom_enabled = false;
                    app->zoom_level = fminf(app->zoom_level * ZOOM_FACTOR, ZOOM_MAX);
                    furi_mutex_release(app->mutex);
                    view_port_update(vp);
                }
                break;
            case InputKeyDown:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->auto_zoom_enabled = false;
                    app->zoom_level = fmaxf(app->zoom_level / ZOOM_FACTOR, ZOOM_MIN);
                    furi_mutex_release(app->mutex);
                    view_port_update(vp);
                }
                break;
            case InputKeyLeft:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    if(app->scroll_divider < 16) {
                        app->scroll_divider *= 2;
                        app->graph_tick_counter = 0;
                        app->graph_last_smoothed = app->display_smoothed;
                        // Rescale existing data to the new (slower) time base.
                        rescale_graph_buf(app, true);
                    }
                    furi_mutex_release(app->mutex);
                    view_port_update(vp);
                }
                break;
            case InputKeyRight:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    if(app->scroll_divider > 1) {
                        app->scroll_divider /= 2;
                        app->graph_tick_counter = 0;
                        app->graph_last_smoothed = app->display_smoothed;
                        // Rescale existing data to the new (faster) time base.
                        rescale_graph_buf(app, false);
                    }
                    furi_mutex_release(app->mutex);
                    view_port_update(vp);
                }
                break;
            default: break;
            }
            continue;
        }

        if(ev.type == EventTypeTick) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);

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

                // Auto-zoom peak: decay every tick (wall-clock time) so the
                // envelope releases at the same rate regardless of scroll_divider.
                if(app->auto_zoom_enabled) {
                    app->auto_zoom_peak *= 0.997f;
                }

                app->graph_tick_counter++;
                if(app->graph_tick_counter >= app->scroll_divider) {
                    float rate = app->display_smoothed - app->graph_last_smoothed;
                    // Normalise by scroll_divider so each sample stores rate-per-tick
                    // rather than total change over the window.  Without this, the
                    // amplitude would grow ×16 from the fastest to slowest time scale.
                    app->graph_buf[app->graph_head] = -(rate / (float)app->scroll_divider) * 0.2f; // scale for nanosiemens rate of change
                    if(++app->graph_head >= GRAPH_N) app->graph_head = 0;
                    app->graph_last_smoothed = app->display_smoothed;
                    app->graph_tick_counter = 0;

                    // Auto-zoom peak: capture newest sample (decay already applied above).
                    if(app->auto_zoom_enabled) {
                        // graph_head now points to next slot; one behind is what we just wrote.
                        int just_written = app->graph_head - 1;
                        if(just_written < 0) just_written = GRAPH_N - 1;
                        float newest = fabsf(app->graph_buf[just_written]);
                        if(newest > app->auto_zoom_peak) app->auto_zoom_peak = newest;
                        if(app->auto_zoom_peak < 0.5f) app->auto_zoom_peak = 0.5f;
                    }
                }

                app->gsr_raw_sum += raw;
                app->raw_count++;

                // Smooth zoom_level towards target every tick for fluid animation.
                // Lerp rate 0.02 → time constant ~5 s, 95 % convergence in ~15 s.
                if(app->auto_zoom_enabled && app->auto_zoom_peak >= 0.5f) {
                    float target = 80.0f / app->auto_zoom_peak;
                    target = fmaxf(ZOOM_MIN, fminf(ZOOM_MAX, target));
                    app->zoom_level += (target - app->zoom_level) * 0.02f;
                }
            }

            if(++app->tick_counter >= TICK_HZ) {
                float lat = 0, lon = 0, alt = 0;
                int   sats = 0, fix = 0;
                if(app->gps) {
                    GpsStatus gs = gps_uart_get_status(app->gps);
                    if((gs.fix_valid || gs.fix_quality > 0)
                        && !isnan(gs.latitude) && !isnan(gs.longitude)) {
                        lat = gs.latitude; lon = gs.longitude; alt = gs.altitude;
                    }
                    sats = gs.satellites_tracked;
                    fix  = gs.fix_quality;
                }

                int32_t avg = app->raw_count ? (app->gsr_raw_sum / app->raw_count) : 0;
                char ts[32];
                format_timestamp(app, ts, sizeof(ts));

                if(app->recording_active) {
                    if(sd_logger_write_row(app->logger, ts, lat, lon, alt, sats, fix, avg)) {
                        // Green heartbeat on every successful write
                        notification_message(app->notifications, &sequence_blink_green_100);
                    } else {
                        // Write failed — stop recording and hold red
                        if(app->logger) sd_logger_stop(app->logger);
                        app->recording_active = false;
                        app->recording_filename[0] = '\0';
                        notification_message(app->notifications, &sequence_set_only_red_255);
                    }
                }

                app->tick_counter = app->raw_count = app->gsr_raw_sum = 0;
            }

            furi_mutex_release(app->mutex);
            view_port_update(vp);
        }
    }

    furi_timer_stop(timer);
    furi_timer_free(timer);
    if(app->recording_active) sd_logger_stop(app->logger);

    sd_logger_free(app->logger); app->logger = NULL;
    if(app->gsr) { gsr_sensor_free(app->gsr); app->gsr = NULL; }
    if(app->gps) { gps_uart_free(app->gps); app->gps = NULL; }

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