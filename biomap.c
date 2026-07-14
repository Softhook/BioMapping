// Bio Mapping — app entry, GPS hot-start, and timestamp formatting.
#include "biomap.h"

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
        .zoom_enabled = true,
        .backlight_on = false,
        .cal_active = false,
        .cal_gain = 1.0f,
        .cal_offset = 0.0f
    };

    app->event_queue   = furi_message_queue_alloc(EVENT_QUEUE_DEPTH, sizeof(PluginEvent));
    app->mutex         = furi_mutex_alloc(FuriMutexTypeNormal);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->storage       = furi_record_open(RECORD_STORAGE);
    app->gui           = furi_record_open(RECORD_GUI);
    storage_common_mkdir(app->storage, "/ext/biomapping");
    biomap_load_calibration(app);
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
        case 3: run_options_screen(app);                        break;
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

bool biomap_load_calibration(BioMapApp* app) {
    furi_assert(app);
    File* file = storage_file_alloc(app->storage);
    if(!file) return false;

    bool success = false;
    if(storage_file_open(file, BIOMAP_CAL_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        BioMapCalibration cal;
        uint16_t bytes_read = storage_file_read(file, &cal, sizeof(BioMapCalibration));
        if(bytes_read == sizeof(BioMapCalibration)) {
            if(cal.magic == BIOMAP_CAL_MAGIC) {
                uint32_t expected_chk = cal.magic ^ *(uint32_t*)&cal.gain ^ *(uint32_t*)&cal.offset;
                if(cal.checksum == expected_chk) {
                    if(cal.gain >= 0.5f && cal.gain <= 2.0f &&
                       cal.offset >= -50000.0f && cal.offset <= 50000.0f) {
                        furi_mutex_acquire(app->mutex, FuriWaitForever);
                        app->cal_active = true;
                        app->cal_gain = cal.gain;
                        app->cal_offset = cal.offset;
                        furi_mutex_release(app->mutex);
                        success = true;
                        FURI_LOG_I("BioMap", "Loaded calibration: gain=%.4f offset=%.1f", (double)cal.gain, (double)cal.offset);
                    } else {
                        FURI_LOG_W("BioMap", "Calibration values out of bounds!");
                    }
                } else {
                    FURI_LOG_W("BioMap", "Calibration checksum mismatch!");
                }
            } else {
                FURI_LOG_W("BioMap", "Calibration file magic mismatch!");
            }
        }
        storage_file_close(file);
    }
    storage_file_free(file);
    return success;
}

void biomap_save_calibration(BioMapApp* app, float gain, float offset) {
    furi_assert(app);
    
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->cal_active = true;
    app->cal_gain = gain;
    app->cal_offset = offset;
    furi_mutex_release(app->mutex);

    File* file = storage_file_alloc(app->storage);
    if(!file) return;

    if(storage_file_open(file, BIOMAP_CAL_PATH, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        BioMapCalibration cal;
        cal.magic = BIOMAP_CAL_MAGIC;
        cal.gain = gain;
        cal.offset = offset;
        cal.checksum = cal.magic ^ *(uint32_t*)&cal.gain ^ *(uint32_t*)&cal.offset;
        
        storage_file_write(file, &cal, sizeof(BioMapCalibration));
        storage_file_close(file);
        FURI_LOG_I("BioMap", "Saved calibration file");
    }
    storage_file_free(file);
}

void biomap_reset_calibration(BioMapApp* app) {
    furi_assert(app);
    
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->cal_active = false;
    app->cal_gain = 1.0f;
    app->cal_offset = 0.0f;
    furi_mutex_release(app->mutex);

    storage_simply_remove(app->storage, BIOMAP_CAL_PATH);
    FURI_LOG_I("BioMap", "Deleted calibration file");
}