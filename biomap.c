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

void run_recording_session(BioMapApp* app, BioMapMode mode) {
    app->mode = mode;
    app->gsr_raw_sum = app->raw_count = app->tick_counter = app->graph_head = 0;
    app->display_smoothed = 0.0f;
    app->display_primed   = false;
    app->recording_active = false;
    app->recording_filename[0] = '\0';
    app->running = true;
    memset(app->graph_buf, 0, sizeof(app->graph_buf));

    app->otg_was_enabled = furi_hal_power_is_otg_enabled();
    if(has_gps(mode)) {
        for(int i = 5; i > 0 && !furi_hal_power_enable_otg(); i--);
    }

    app->gps = has_gps(mode) ? gps_uart_alloc(app->event_queue, app->notifications) : NULL;
    app->gsr = has_gsr(mode) ? gsr_sensor_alloc() : NULL;
    app->logger = sd_logger_alloc(app->storage);

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, biomap_render_callback, app);
    view_port_input_callback_set(vp, biomap_input_callback, app->event_queue);
    Gui* gui = furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);

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
                app->running = false;
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
                        notification_message(app->notifications, &sequence_blink_blue_10);
                    }
                } else {
                    sd_logger_stop(app->logger);
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->recording_active = false;
                    app->recording_filename[0] = '\0';
                    furi_mutex_release(app->mutex);
                    notification_message(app->notifications, &sequence_blink_blue_100);
                }
                view_port_update(vp);
                break;
            }
            case InputKeyUp:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_level = fminf(app->zoom_level + ZOOM_STEP, ZOOM_MAX);
                    furi_mutex_release(app->mutex);
                    view_port_update(vp);
                }
                break;
            case InputKeyDown:
                if(has_gsr(mode)) {
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_level = fmaxf(app->zoom_level - ZOOM_STEP, ZOOM_MIN);
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

            int16_t raw = 0;
            if(app->gsr) {
                gsr_sensor_tick(app->gsr);
                raw = gsr_sensor_get_raw(app->gsr);

                float rf = (float)raw;
                if(!app->display_primed) { app->display_smoothed = rf; app->display_primed = true; }
                float ns = DISPLAY_EMA_A * rf + (1.0f - DISPLAY_EMA_A) * app->display_smoothed;
                float rate = ns - app->display_smoothed;
                app->display_smoothed = ns;
                app->graph_buf[app->graph_head] = -(rate) * 0.5f;
                app->graph_head = (app->graph_head + 1) % GRAPH_N;
                app->gsr_raw_sum += raw;
                app->raw_count++;
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

                int16_t avg = app->raw_count ? (int16_t)(app->gsr_raw_sum / app->raw_count) : 0;
                char ts[32];
                format_timestamp(app, ts, sizeof(ts));

                if(app->recording_active)
                    sd_logger_write_row(app->logger, ts, lat, lon, alt, sats, fix, avg);

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

    if(has_gps(mode) && furi_hal_power_is_otg_enabled() && !app->otg_was_enabled)
        furi_hal_power_disable_otg();

    gui_remove_view_port(gui, vp);
    view_port_free(vp);
    furi_record_close(RECORD_GUI);
}

int32_t biomap_app(void* p) {
    UNUSED(p);
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_assert(app);
    *app = (BioMapApp){.zoom_level = 1.0f};

    app->event_queue   = furi_message_queue_alloc(16, sizeof(PluginEvent));
    app->mutex         = furi_mutex_alloc(FuriMutexTypeNormal);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->storage       = furi_record_open(RECORD_STORAGE);
    storage_common_mkdir(app->storage, "/ext/biomapping");
    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);

    bool running = true;
    while(running) {
        int32_t sel = biomap_gui_show_menu(app);

        switch(sel) {
        case 0: run_recording_session(app, BioMapModeGpsGsr);  break;
        case 1: run_recording_session(app, BioMapModeGpsOnly); break;
        case 2: run_recording_session(app, BioMapModeGsrOnly); break;
        case 3: run_converter(app);                             break;
        case 4: run_gps_hot_start(app);                         break;
        default: running = false;                               break;
        }
    }

    notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_STORAGE);
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);
    return 0;
}