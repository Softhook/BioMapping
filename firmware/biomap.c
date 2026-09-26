// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// Bio Mapping — app entry, GPS cold start, and timestamp formatting.
#include "biomap.h"

uint32_t biomap_rtc_now_epoch(void) {
    DateTime dt;
    furi_hal_rtc_get_datetime(&dt);
    return pipeline_unix_epoch(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second);
}

// Options > Cold Reset GPS. Every session start already restarts the module
// (waking from standby is a restart that keeps backup RAM), so the only
// reset worth offering is one that also wipes what the module remembers.
// The wipe sticks: gps_uart_free() puts the module back to sleep before it
// can relearn anything, so the next session starts from nothing (first fix
// ~23-29 s in open sky, SAM-M10Q datasheet).
void run_gps_cold_start(BioMapApp* app) {
    GpsUart* g = gps_uart_alloc(app->event_queue, app->notifications, app->nav_model, app->super_s);
    bool ok = g && gps_uart_is_ready(g);
    if(ok) { gps_uart_send_cold_start(g); furi_delay_ms(300); }
    notification_message(app->notifications,
        ok ? &sequence_blink_green_100 : &sequence_blink_red_100);
    if(ok) {
        biomap_sound_success(app->sound_enabled);
    } else {
        biomap_sound_error(app->sound_enabled);
    }
    if(g) gps_uart_free(g);
}

void biomap_backlight_claim(BioMapApp* app) {
    if(app->backlight_on) {
        notification_message(app->notifications, &sequence_display_backlight_enforce_on);
        app->backlight_enforced = true;
    } else {
        app->backlight_enforced = false;
    }
}

void biomap_backlight_release(BioMapApp* app, bool block) {
    if(!app->backlight_enforced) return;
    if(block) {
        notification_message_block(app->notifications, &sequence_display_backlight_enforce_auto);
    } else {
        notification_message(app->notifications, &sequence_display_backlight_enforce_auto);
    }
    app->backlight_enforced = false;
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
        .super_s = true,
        .cal_active = false,
        .cal_gain = 1.0f,
        .cal_offset = 0.0f,
        .cal_timestamp = 0,
        .cal_r_squared = 0.0f,
        .debug_fields_enabled = false,
    };

    app->event_queue   = furi_message_queue_alloc(EVENT_QUEUE_DEPTH, sizeof(BioMapEvent));
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

    // Held until exit so the GPS stays asleep on the menu and in GSR-only
    // mode. Blocks for up to ~2 s while it puts the module to sleep.
    gps_uart_port_open();

    _Static_assert(MenuOptions == MENU_COUNT - 1, "MENU_COUNT mismatch with MenuOptions enum");

    bool running = true;
    while(running) {
        int32_t sel = biomap_gui_show_menu(app);

        switch(sel) {
        case MenuGpsGsrRf:    run_recording_session(app, BioMapModeGpsGsrRf); break;
        case MenuGpsGsr:      run_recording_session(app, BioMapModeGpsGsr);   break;
        case MenuGpsOnly:     run_recording_session(app, BioMapModeGpsOnly);  break; // "GPS + RF"
        case MenuGsrOnly:     run_recording_session(app, BioMapModeGsrOnly);  break;
        case MenuLiveStream:  run_recording_session(app, BioMapModeLiveStream); break; // Live Stream
        case MenuOptions:     run_options_screen(app);                         break;
        default: running = false;                                break;
        }
    }

    // Defensive: every run_recording_session() call already releases its
    // own claim via session_deinit() before returning, so this should
    // normally be a no-op by the time we get here.
    biomap_backlight_release(app, true);

    gps_uart_port_close();

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

// Record formats, checksums and validity checks for both files live in
// biomap_format.c (SDK-free, host-tested); this file owns the SD I/O.

// Write `size` bytes to `tmp_path`, then rename it over `path`. Prevents
// corruption if power is lost or the SD card is removed mid-write — the
// real file is either the old valid one or the new complete one, never a
// partial write. `what` names the file in error logs.
static bool write_file_atomic(Storage* storage, const char* tmp_path, const char* path,
                              const void* data, size_t size, const char* what) {
    File* file = storage_file_alloc(storage);
    if(!file) return false;

    bool ok = false;
    if(storage_file_open(file, tmp_path, FSAM_WRITE, FSOM_CREATE_ALWAYS)) {
        size_t written = storage_file_write(file, data, size);
        storage_file_close(file);

        if(written == size) {
            FS_Error err = storage_common_rename(storage, tmp_path, path);
            if(err == FSE_OK) {
                ok = true;
            } else {
                FURI_LOG_E("BioMap", "%s rename failed (%d) — saved to .tmp", what, (int)err);
            }
        } else {
            FURI_LOG_E("BioMap", "%s temp write truncated (%d/%d)",
                       what, (int)written, (int)size);
        }
    }
    storage_file_free(file);
    return ok;
}

bool biomap_load_calibration(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");
    File* file = storage_file_alloc(app->storage);
    if(!file) return false;

    bool success = false;
    if(storage_file_open(file, BIOMAP_CAL_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        BioMapCalibration cal;
        size_t bytes_read = storage_file_read(file, &cal, sizeof(BioMapCalibration));
        if(bytes_read == sizeof(BioMapCalibration)) {
            switch(biomap_calibration_check(&cal)) {
            case CalRecordOk:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                app->cal_active = true;
                app->cal_gain = cal.gain;
                app->cal_offset = cal.offset;
                app->cal_timestamp = cal.timestamp;
                app->cal_r_squared = cal.r_squared;
                memcpy(app->cal_noise_std_dev, cal.noise_std_dev,
                       sizeof(app->cal_noise_std_dev));
                furi_mutex_release(app->mutex);
                success = true;
                FURI_LOG_I("BioMap",
                           "Loaded calibration v%lu: gain=%.4f offset=%.1f timestamp=%lu r2=%.4f",
                           (unsigned long)cal.version, (double)cal.gain, (double)cal.offset,
                           (unsigned long)cal.timestamp, (double)cal.r_squared);
                break;
            case CalRecordBadMagic:
                FURI_LOG_W("BioMap", "Calibration file magic mismatch!");
                break;
            case CalRecordBadVersion:
                // No migration path: when the format changes (new fields),
                // add a block here that reads the old struct and fills
                // defaults for the new fields before bumping
                // BIOMAP_CAL_VERSION.
                FURI_LOG_W("BioMap", "Calibration version mismatch (got %lu, want %d) — ignoring",
                           (unsigned long)cal.version, BIOMAP_CAL_VERSION);
                break;
            case CalRecordBadChecksum:
                FURI_LOG_W("BioMap", "Calibration checksum mismatch!");
                break;
            case CalRecordOutOfBounds:
                FURI_LOG_W("BioMap", "Calibration values out of bounds!");
                break;
            }
        }
        storage_file_close(file);
    }
    storage_file_free(file);
    return success;
}

void biomap_save_calibration(BioMapApp* app, float gain, float offset, float r_squared,
                             const float noise_std_dev[CAL_POINTS]) {
    furi_check(app, "BioMapApp: NULL app pointer");

    // Stamp the save time (0 if the RTC is unset — same sentinel the CSV
    // header's RecordingStartTime uses). Recorded so show_current_
    // calibration_render() and the next load can report the calibration's age.
    uint32_t timestamp = biomap_rtc_now_epoch();

    furi_mutex_acquire(app->mutex, FuriWaitForever);
    app->cal_active = true;
    app->cal_gain = gain;
    app->cal_offset = offset;
    app->cal_timestamp = timestamp;
    app->cal_r_squared = r_squared;
    memcpy(app->cal_noise_std_dev, noise_std_dev, sizeof(app->cal_noise_std_dev));
    furi_mutex_release(app->mutex);

    BioMapCalibration cal;
    cal.magic   = BIOMAP_CAL_MAGIC;
    cal.version = BIOMAP_CAL_VERSION;
    cal.gain    = gain;
    cal.offset  = offset;
    cal.timestamp = timestamp;
    cal.r_squared = r_squared;
    memcpy(cal.noise_std_dev, noise_std_dev, sizeof(cal.noise_std_dev));
    cal.checksum = biomap_calibration_checksum(&cal);

    if(write_file_atomic(app->storage, BIOMAP_CAL_PATH_TMP, BIOMAP_CAL_PATH,
                         &cal, sizeof(cal), "Calibration")) {
        FURI_LOG_I("BioMap",
                   "Saved calibration v%d: gain=%.4f offset=%.1f timestamp=%lu r2=%.4f",
                   BIOMAP_CAL_VERSION, (double)gain, (double)offset,
                   (unsigned long)timestamp, (double)r_squared);
    }
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
    app->cal_timestamp = 0;
    app->cal_r_squared = 0.0f;
    memset(app->cal_noise_std_dev, 0, sizeof(app->cal_noise_std_dev));
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
// Same shape as biomap_load_calibration/biomap_save_calibration above, kept
// as a separate file/struct since these are independent settings with their
// own versioning needs (see BioMapSettings in biomap_format.h).

bool biomap_load_settings(BioMapApp* app) {
    furi_check(app, "BioMapApp: NULL app pointer");
    File* file = storage_file_alloc(app->storage);
    if(!file) return false;

    bool success = false;
    if(storage_file_open(file, BIOMAP_SETTINGS_PATH, FSAM_READ, FSOM_OPEN_EXISTING)) {
        BioMapSettings s;
        size_t bytes_read = storage_file_read(file, &s, sizeof(BioMapSettings));
        if(bytes_read == sizeof(BioMapSettings) && biomap_settings_valid(&s)) {
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            app->zoom_enabled    = s.zoom_enabled;
            app->backlight_on    = s.backlight_on;
            app->sound_enabled   = s.sound_enabled;
            app->nav_model       = (GpsNavModel)s.nav_model;
            app->super_s         = s.super_s;
            app->debug_fields_enabled = s.debug_fields_enabled;
            furi_mutex_release(app->mutex);
            success = true;
            FURI_LOG_I("BioMap",
                       "Loaded settings: zoom=%d backlight=%d sound=%d nav=%lu super_s=%d debug_fields=%d",
                       s.zoom_enabled, s.backlight_on, s.sound_enabled,
                       (unsigned long)s.nav_model, s.super_s, s.debug_fields_enabled);
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
        .super_s         = app->super_s,
        .debug_fields_enabled = app->debug_fields_enabled,
    };
    furi_mutex_release(app->mutex);
    s.checksum = biomap_settings_checksum(&s);

    write_file_atomic(app->storage, BIOMAP_SETTINGS_PATH_TMP, BIOMAP_SETTINGS_PATH,
                      &s, sizeof(s), "Settings");
}