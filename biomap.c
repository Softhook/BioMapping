// Bio Mapping — app entry, GPS hot-start, and timestamp formatting.
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

int32_t biomap_app(void* p) {
    UNUSED(p);
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_assert(app);
    *app = (BioMapApp){
        .zoom = {.level = 1.0f, .peak = 1.0f, .enabled = true},
        .backlight_on = false
    };

    app->event_queue   = furi_message_queue_alloc(EVENT_QUEUE_DEPTH, sizeof(PluginEvent));
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