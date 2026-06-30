// Bio Mapping — recording session event loop.
#include "biomap.h"

// ── Handle one key press during a recording session ────────────────────────
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

// ── Handle one GSR tick (10 Hz) during a recording session ────────────────
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
