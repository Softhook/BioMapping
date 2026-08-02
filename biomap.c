// Bio Mapping — app entry, GPS hot-start, and timestamp formatting.
#include "biomap.h"

void run_gps_hot_start(BioMapApp* app) {
    GpsUart* g = gps_uart_alloc(app->event_queue, app->notifications, app->nav_model);
    bool ok = g && gps_uart_is_ready(g);
    if(ok) { gps_uart_send_hot_start(g); furi_delay_ms(300); }
    notification_message(app->notifications,
        ok ? &sequence_blink_green_100 : &sequence_blink_red_100);
    if(ok) {
        biomap_sound_success(app->sound_enabled);
    } else {
        biomap_sound_error(app->sound_enabled);
    }
    if(g) gps_uart_free(g);
}

int32_t biomap_app(void* p) {
    UNUSED(p);
    BioMapApp* app = malloc(sizeof(BioMapApp));
    furi_check(app, "BioMapApp: NULL app pointer");
    *app = (BioMapApp){
        .zoom_enabled = true,
        .backlight_on = false,
        .backlight_enforced = false,
        .sound_enabled = true,
        .nav_model = GpsNavModelPedestrian,
        .cal_active = false,
        .cal_gain = 1.0f,
        .cal_offset = 0.0f,
    };

    app->event_queue   = furi_message_queue_alloc(EVENT_QUEUE_DEPTH, sizeof(PluginEvent));
    app->mutex         = furi_mutex_alloc(FuriMutexTypeNormal);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);
    app->storage       = furi_record_open(RECORD_STORAGE);
    app->gui           = furi_record_open(RECORD_GUI);
    storage_common_mkdir(app->storage, "/ext/biomapping");
    biomap_load_calibration(app);
    biomap_load_rf_calibration(app);
    biomap_load_settings(app);
    // No enforce_auto here — nothing has claimed enforce_on yet at startup,
    // and NotificationSrv logs "Incorrect BacklightEnforce use" for an
    // unpaired release (see biomap.h's backlight_enforced doc comment).

    // Create the single persistent ViewPort shared by every screen — stays
    // in the GUI stack for the app's whole lifetime. Screens are switched by
    // enabling/disabling it and swapping the draw callback (see vp_push/
    // vp_pop and run_recording_session), so it's never removed from the GUI
    // stack. That's what prevents the desktop/dolphin from flashing through
    // between screen transitions.
    app->screen_vp = view_port_alloc();
    view_port_input_callback_set(app->screen_vp, biomap_input_callback, app->event_queue);
    view_port_enabled_set(app->screen_vp, false);
    gui_add_view_port(app->gui, app->screen_vp, GuiLayerFullscreen);

    bool running = true;
    while(running) {
        int32_t sel = biomap_gui_show_menu(app);

        switch(sel) {
        case 0: run_recording_session(app, BioMapModeGpsGsrRf); break;
        case 1: run_recording_session(app, BioMapModeGpsGsr);   break;
        case 2: run_recording_session(app, BioMapModeGpsOnly);  break; // "GPS + RF"
        case 3: run_recording_session(app, BioMapModeGsrOnly);  break;
        case 4: run_options_screen(app);                         break;
        default: running = false;                                break;
        }
    }

    // Defensive: only release if we actually still hold a claim. Every
    // run_recording_session() call already releases its own claim via
    // session_deinit() before returning, so this should normally be a
    // no-op by the time we get here.
    if(app->backlight_enforced) {
        notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
        app->backlight_enforced = false;
    }

    gui_remove_view_port(app->gui, app->screen_vp);
    view_port_free(app->screen_vp);
    furi_record_close(RECORD_GUI);
    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_STORAGE);
    furi_message_queue_free(app->event_queue);
    furi_mutex_free(app->mutex);
    free(app);
    return 0;
}

// Polynomial-rolling FNV-1a checksum over a byte range.  Shared by
// cal_checksum (BioMapCalibration) and settings_checksum (BioMapSettings)
// below — same algorithm, different struct types, so this factors out the
// only part that was actually identical between them.  This avoids
// strict-aliasing UB and is much more collision-resistant than the old
// magic ^ *(uint32_t*)&gain … XOR.
static uint32_t fnv1a_checksum(const void* data, size_t n) {
    uint32_t h = 0x811C9DC5u;
    const uint8_t* p = (const uint8_t*)data;
    for(size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 0x01000193u;  // FNV-1a prime
    }
    return h;
}

static uint32_t cal_checksum(const BioMapCalibration* cal) {
    return fnv1a_checksum(cal, offsetof(BioMapCalibration, checksum));
}

bool biomap_load_calibration(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");
    File* file = storage_file_alloc(app->storage);
    if(!file) return false;

    bool success = false;
    if(storage_file_open(file, BIOMAP_CAL_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        BioMapCalibration cal;
        uint16_t bytes_read = storage_file_read(file, &cal, sizeof(BioMapCalibration));
        if(bytes_read == sizeof(BioMapCalibration)) {
            if(cal.magic == BIOMAP_CAL_MAGIC) {
                if(cal.version == BIOMAP_CAL_VERSION) {
                    if(cal.checksum == cal_checksum(&cal)) {
                        if(cal.gain >= CAL_GAIN_MIN && cal.gain <= CAL_GAIN_MAX &&
                           cal.offset >= CAL_OFFSET_MIN && cal.offset <= CAL_OFFSET_MAX) {
                            furi_mutex_acquire(app->mutex, FuriWaitForever);
                            app->cal_active = true;
                            app->cal_gain = cal.gain;
                            app->cal_offset = cal.offset;
                            furi_mutex_release(app->mutex);
                            success = true;
                            FURI_LOG_I("BioMap", "Loaded calibration v%lu: gain=%.4f offset=%.1f",
                                       (unsigned long)cal.version, (double)cal.gain, (double)cal.offset);
                        } else {
                            FURI_LOG_W("BioMap", "Calibration values out of bounds!");
                        }
                    } else {
                        FURI_LOG_W("BioMap", "Calibration checksum mismatch!");
                    }
                } else {
                    // Version mismatch: no migration path exists because
                    // the struct is only gain/offset.  When the format
                    // changes (new fields), add a migration block here
                    // that reads the old struct and populates defaults
                    // for any new fields before bumping BIOMAP_CAL_VERSION.
                    FURI_LOG_W("BioMap", "Calibration version mismatch (got %lu, want %d) — ignoring",
                               (unsigned long)cal.version, BIOMAP_CAL_VERSION);
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
    furi_check(app, "BioMapApp: NULL app pointer");
    
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->cal_active = true;
    app->cal_gain = gain;
    app->cal_offset = offset;
    furi_mutex_release(app->mutex);

    File* file = storage_file_alloc(app->storage);
    if(!file) return;

    // Write to a temp file first, then atomically rename over the real
    // path.  This prevents corruption if power is lost or the SD card is
    // removed mid-write — the real file is either the old valid one or
    // the new complete one, never a partial write.
    if(storage_file_open(file, BIOMAP_CAL_PATH_TMP, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        BioMapCalibration cal;
        cal.magic   = BIOMAP_CAL_MAGIC;
        cal.version = BIOMAP_CAL_VERSION;
        cal.gain    = gain;
        cal.offset  = offset;
        cal.checksum = cal_checksum(&cal);
        
        uint16_t written = storage_file_write(file, &cal, sizeof(BioMapCalibration));
        storage_file_close(file);

        if(written == sizeof(BioMapCalibration)) {
            // Replace the old file atomically.
            FS_Error err = storage_common_rename(app->storage,
                BIOMAP_CAL_PATH_TMP, BIOMAP_CAL_PATH);
            if(err == FSE_OK) {
                FURI_LOG_I("BioMap", "Saved calibration v%d: gain=%.4f offset=%.1f",
                           BIOMAP_CAL_VERSION, (double)gain, (double)offset);
            } else {
                FURI_LOG_E("BioMap", "Rename failed (%d) — calibration saved to .tmp", (int)err);
            }
        } else {
            FURI_LOG_E("BioMap", "Temp write truncated (%d/%d)",
                       (int)written, (int)sizeof(BioMapCalibration));
        }
    }
    storage_file_free(file);
}

void biomap_reset_calibration(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");
    
    // Delete the file FIRST, then clear the in-memory state.  This order
    // is important for crash resilience: if power is lost between the
    // delete and the state update, the file is already gone and the next
    // boot won't reload the old calibration.  The reverse order (clear
    // state → delete file) risks the file surviving a crash and the
    // calibration silently coming back on next boot.
    storage_simply_remove(app->storage, BIOMAP_CAL_PATH);
    // Also clean up any orphaned temp file from a crashed/aborted save.
    storage_simply_remove(app->storage, BIOMAP_CAL_PATH_TMP);

    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->cal_active = false;
    app->cal_gain = 1.0f;
    app->cal_offset = 0.0f;
    furi_mutex_release(app->mutex);

    FURI_LOG_I("BioMap", "Deleted calibration file");
}

// ── RF Faraday calibration (em_scan_cal.h) ──────────────────────────────
// Thin BioMapApp-level wrappers around em_scan_cal_load/save/reset, mirroring
// biomap_load_calibration/biomap_save_calibration/biomap_reset_calibration's
// shape above. Unlike the GSR calibration file, em_scan_cal_load() already
// does its own full validation (magic/version/CRC/per-band ceiling/std dev
// — see em_scan_cal.h) internally, so there's no separate checksum helper
// needed here.

bool biomap_load_rf_calibration(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");
    EmScanCal cal;
    bool ok = em_scan_cal_load(&cal, app->storage);
    if(ok) {
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        app->rf_cal_data = cal;
        app->rf_calibrated = true;
        furi_mutex_release(app->mutex);
    }
    return ok;
}

void biomap_save_rf_calibration(BioMapApp* app, const EmScanCal* cal) {
    furi_check(app, "BioMapApp: NULL app pointer");
    bool ok = em_scan_cal_save(cal, app->storage);
    if(ok) {
        furi_mutex_acquire(app->mutex, FuriWaitForever);
        app->rf_cal_data = *cal;
        app->rf_calibrated = true;
        furi_mutex_release(app->mutex);
    }
}

void biomap_reset_rf_calibration(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");
    em_scan_cal_reset(app->storage);

    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->rf_calibrated = false;
    furi_mutex_release(app->mutex);
}

// ── Options persistence ──────────────────────────────────────────────────
// Same shape as cal_checksum/biomap_load_calibration/biomap_save_calibration
// above — see BioMapSettings's doc comment in biomap.h for why this is a
// separate file/struct rather than folded into the GSR calibration one.

static uint32_t settings_checksum(const BioMapSettings* s) {
    return fnv1a_checksum(s, offsetof(BioMapSettings, checksum));
}

bool biomap_load_settings(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");
    File* file = storage_file_alloc(app->storage);
    if(!file) return false;

    bool success = false;
    if(storage_file_open(file, BIOMAP_SETTINGS_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        BioMapSettings s;
        uint16_t bytes_read = storage_file_read(file, &s, sizeof(BioMapSettings));
        if(bytes_read == sizeof(BioMapSettings) &&
           s.magic == BIOMAP_SETTINGS_MAGIC &&
           s.version == BIOMAP_SETTINGS_VERSION &&
           s.checksum == settings_checksum(&s) &&
           s.nav_model < 7) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->zoom_enabled    = s.zoom_enabled;
            app->backlight_on    = s.backlight_on;
            app->sound_enabled   = s.sound_enabled;
            app->nav_model       = (GpsNavModel)s.nav_model;
            furi_mutex_release(app->mutex);
            success = true;
            FURI_LOG_I("BioMap",
                       "Loaded settings: zoom=%d backlight=%d sound=%d nav=%lu",
                       s.zoom_enabled, s.backlight_on, s.sound_enabled,
                       (unsigned long)s.nav_model);
        } else if(bytes_read == sizeof(BioMapSettings)) {
            FURI_LOG_W("BioMap", "Settings file invalid — using defaults");
        }
        storage_file_close(file);
    }
    storage_file_free(file);
    return success;
}

void biomap_save_settings(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");

    furi_mutex_acquire(app->mutex, FuriWaitForever);
    BioMapSettings s = {
        .magic           = BIOMAP_SETTINGS_MAGIC,
        .version         = BIOMAP_SETTINGS_VERSION,
        .zoom_enabled    = app->zoom_enabled,
        .backlight_on    = app->backlight_on,
        .sound_enabled   = app->sound_enabled,
        .nav_model       = (uint32_t)app->nav_model,
    };
    furi_mutex_release(app->mutex);
    s.checksum = settings_checksum(&s);

    File* file = storage_file_alloc(app->storage);
    if(!file) return;

    // Same atomic write-then-rename as biomap_save_calibration — crash or
    // power loss mid-write leaves the old settings file intact.
    if(storage_file_open(file, BIOMAP_SETTINGS_PATH_TMP, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        uint16_t written = storage_file_write(file, &s, sizeof(BioMapSettings));
        storage_file_close(file);

        if(written == sizeof(BioMapSettings)) {
            FS_Error err = storage_common_rename(app->storage,
                BIOMAP_SETTINGS_PATH_TMP, BIOMAP_SETTINGS_PATH);
            if(err != FSE_OK) {
                FURI_LOG_E("BioMap", "Settings rename failed (%d) — saved to .tmp", (int)err);
            }
        } else {
            FURI_LOG_E("BioMap", "Settings temp write truncated (%d/%d)",
                       (int)written, (int)sizeof(BioMapSettings));
        }
    }
    storage_file_free(file);
}