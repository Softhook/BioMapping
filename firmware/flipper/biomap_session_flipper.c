// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// The recording screen on the Flipper: allocating and freeing the modules,
// the device functions the shared session (core/biomap_session.c) calls,
// and the event loop that feeds it keys, ticks and GPS bytes.

#include "../biomap.h"

_Static_assert(EM_SCAN_NUM_FREQS == RF_BAND_COUNT,
               "the radio code and the CSV columns must agree on the band count");

#define TAG "BioMap"

// ==========================================================================
// Device functions for the shared session (SessionPlatform)
// ==========================================================================
// ctx is the BioMapApp. Every function runs on the app's main thread.

static void plat_lock(void* ctx) {
    furi_mutex_acquire(((BioMapApp*)ctx)->mutex, FuriWaitForever);
}

static void plat_unlock(void* ctx) {
    furi_mutex_release(((BioMapApp*)ctx)->mutex);
}

static uint32_t plat_now_ms(void* ctx) {
    (void)ctx;
    return furi_get_tick();
}

static void plat_delay_ms(void* ctx, uint32_t ms) {
    (void)ctx;
    furi_delay_ms(ms);
}

static void plat_cue(void* ctx, BioMapCue cue) {
    biomap_app_cue((BioMapApp*)ctx, cue);
}

static void plat_log(void* ctx, SessionLogLevel level, const char* line) {
    (void)ctx;
    switch(level) {
    case SessionLogInfo:    FURI_LOG_I(TAG, "%s", line); break;
    case SessionLogWarning: FURI_LOG_W(TAG, "%s", line); break;
    case SessionLogError:   FURI_LOG_E(TAG, "%s", line); break;
    }
}

static void plat_datetime_now(void* ctx, SessionDateTime* out) {
    (void)ctx;
    DateTime dt;
    furi_hal_rtc_get_datetime(&dt);
    *out = (SessionDateTime){
        .year = dt.year, .month = dt.month, .day = dt.day,
        .hour = dt.hour, .minute = dt.minute, .second = dt.second,
    };
}

static uint32_t plat_epoch_now(void* ctx) {
    (void)ctx;
    return biomap_rtc_now_epoch();
}

static bool plat_file_start(void* ctx, const char* header, const char* stamp) {
    return sd_logger_start(((BioMapApp*)ctx)->session.logger, header, stamp);
}

static void plat_file_stop(void* ctx, uint32_t end_epoch) {
    sd_logger_stop(((BioMapApp*)ctx)->session.logger, end_epoch);
}

static bool plat_file_append(void* ctx, const char* row, size_t len) {
    return sd_logger_batch_append(((BioMapApp*)ctx)->session.logger, row, len);
}

static int plat_file_flush(void* ctx, bool all) {
    SdLogger* l = ((BioMapApp*)ctx)->session.logger;
    return all ? sd_logger_batch_flush_all(l) : sd_logger_batch_flush(l);
}

// Lock held: the snapshot is guarded by EmScanSampler's own lock, held only
// for a 3-float copy and never across a radio call (em_scan_sampler.h).
static void plat_rf_snapshot(void* ctx, float out_dbm[RF_BAND_COUNT]) {
    const Session* s = &((BioMapApp*)ctx)->session;
    if(s->em) {
        em_scan_sampler_get_snapshot(s->em, out_dbm);
    } else {
        for(int i = 0; i < RF_BAND_COUNT; i++) out_dbm[i] = 0.0f;
    }
}

static void plat_fill_diag(void* ctx, RowDiag* d) {
    const Session* s = &((BioMapApp*)ctx)->session;
    d->rf_rssi_peak_ms      = s->em ? em_scan_sampler_get_rssi_peak_ms(s->em) : 0;
    d->rf_retune_peak_ms    = s->em ? em_scan_sampler_get_retune_peak_ms(s->em) : 0;
    d->flush_peak_ms        = s->logger ? sd_logger_get_flush_peak_ms(s->logger) : 0;
    d->log_fill_bytes       = s->logger ? sd_logger_get_batch_fill_bytes(s->logger) : 0;
    d->log_fill_peak_bytes  = s->logger ? sd_logger_get_batch_fill_peak_bytes(s->logger) : 0;
    d->log_overflow_count   = s->logger ? sd_logger_get_overflow_count(s->logger) : 0;
    d->log_flush_fail_count = s->logger ? sd_logger_get_flush_fail_count(s->logger) : 0;
    d->prealloc_ms          = s->logger ? sd_logger_get_prealloc_ms(s->logger) : 0;
}

// Once a second with debug fields on, lock released: memory and stack, and
// in Live Stream the Bluetooth figures. The recording's own telemetry line
// needs recording.active, which Live Stream never sets, so without its own
// line nothing would show a Bluetooth stall. tick_dt next to bt_tx_peak_ms
// in the same line is how a tick stall is traced to its cause.
static void plat_second_diag(void* ctx, const SessionCore* core) {
    const Session* s = &((BioMapApp*)ctx)->session;
    FURI_LOG_I(TAG, "heartbeat heap:free=%u min=%u stack:main=%u gsr=%u sd_dry=%u",
               (unsigned)memmgr_get_free_heap(), (unsigned)memmgr_get_minimum_free_heap(),
               (unsigned)furi_thread_get_stack_space(furi_thread_get_id(furi_thread_get_current())),
               (unsigned)(core->gsr ? gsr_sensor_get_stack_space(core->gsr) : 0),
               (unsigned)BIOMAP_SD_DRY_RUN);
    if(core->mode == BioMapModeLiveStream && s->bt_stream) {
        FURI_LOG_I(TAG, "bt_telemetry tick_dt=%u bt_tx_peak_ms=%u bt_drop=%u",
                   (unsigned)core->recording.tick_dt_ms,
                   (unsigned)bt_stream_get_tx_peak_ms(s->bt_stream),
                   (unsigned)bt_stream_get_drop_count(s->bt_stream));
    }
}

static bool plat_live_connected(void* ctx) {
    const Session* s = &((BioMapApp*)ctx)->session;
    return s->bt_stream && bt_stream_is_connected(s->bt_stream);
}

static void plat_live_send(void* ctx, const uint8_t* packet, size_t len) {
    const Session* s = &((BioMapApp*)ctx)->session;
    if(s->bt_stream) bt_stream_tx_batch(s->bt_stream, packet, len);
}

static SessionPlatform session_platform(BioMapApp* app) {
    return (SessionPlatform){
        .ctx            = app,
        .lock           = plat_lock,
        .unlock         = plat_unlock,
        .now_ms         = plat_now_ms,
        .delay_ms       = plat_delay_ms,
        .cue            = plat_cue,
        .log            = plat_log,
        .datetime_now   = plat_datetime_now,
        .epoch_now      = plat_epoch_now,
        .file_start     = plat_file_start,
        .file_stop      = plat_file_stop,
        .file_append    = plat_file_append,
        .file_flush     = plat_file_flush,
        .rf_snapshot    = plat_rf_snapshot,
        .fill_diag      = plat_fill_diag,
        .second_diag    = plat_second_diag,
        .live_connected = plat_live_connected,
        .live_send      = plat_live_send,
    };
}

// The settings and calibration, read once: Options can't be opened during
// a session.
static SessionSettings session_settings(BioMapApp* app) {
    SessionSettings cfg = {
        .sound_enabled        = app->sound_enabled,
        .zoom_enabled         = app->zoom_enabled,
        .debug_fields_enabled = app->debug_fields_enabled,
        // The Flipper's own name (Settings > System > Device Name).
        .device_name          = furi_hal_version_get_name_ptr(),
        .rf_calibrated        = app->rf_calibrated,
        .cal_active           = app->cal_active,
        .cal_gain             = app->cal_gain,
        .cal_zero_counts      = app->cal_zero_counts,
        .cal_r_squared        = app->cal_r_squared,
        .cal_timestamp        = app->cal_timestamp,
    };
    for(int i = 0; i < RF_BAND_COUNT; i++) cfg.rf_floors_dbm[i] = app->rf_cal_data.noise_floor_dbm[i];
    for(int i = 0; i < CAL_POINTS; i++) cfg.cal_noise_std_dev[i] = app->cal_noise_std_dev[i];
    return cfg;
}

// ==========================================================================
// Start and end
// ==========================================================================

static void session_init(BioMapApp* app, BioMapMode mode) {
    Session* s = &app->session;
    SessionPlatform platform = session_platform(app);
    SessionSettings cfg = session_settings(app);
    // The screen may be drawing the previous screen's state while this
    // runs: take the lock around the reset.
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    *s = (Session){0};
    screen_cache_init(&s->screen);
    session_core_init(&s->core, mode, &platform, &cfg);
    furi_mutex_release(app->mutex);
}

// Tear down: stop the timer, close any recording, free the modules, clear
// the light, hand the screen back. Safe after a partial start.
static void session_deinit(BioMapApp* app) {
    Session* s = &app->session;
    if(s->timer) {
        furi_timer_stop(s->timer);
        furi_timer_free(s->timer);
        s->timer = NULL;
    }
    // Last resort: in normal use Back has already closed the file.
    session_core_end(&s->core);

    // biomap_render_callback() runs on the GUI service's own thread and
    // takes app->mutex before reading the module pointers. The screen
    // keeps this draw callback until the very end below, so take the
    // pointers out under the lock, then free them without it (freeing the
    // GSR sensor joins its thread, which can take a while).
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    SdLogger* logger = s->logger;
    GsrSensor* gsr = s->core.gsr;
    EmScanSampler* em = s->em;
    GpsUart* gps = s->core.gps;
    BtStream* bt_stream = s->bt_stream;
    s->logger = NULL;
    s->core.gsr = NULL;
    s->em = NULL;
    s->core.gps = NULL;
    s->bt_stream = NULL;
    furi_mutex_release(app->mutex);

    if(bt_stream) {
        // Restores the default profile, which restarts the Bluetooth
        // co-processor's second core: slow, so not under the lock.
        bt_stream_stop(bt_stream);
        bt_stream_free(bt_stream);
    }
    if(logger) sd_logger_free(logger);
    if(gsr) gsr_sensor_free(gsr);
    // After gsr: em's poll runs on gsr's worker thread, which
    // gsr_sensor_free() has now joined. Powers the radio down.
    if(em) em_scan_sampler_free(em);
    if(gps) gps_uart_free(gps);

    // Restore auto backlight when leaving the recording screen.
    biomap_backlight_release(app, false);

    // Clear the light. An SD stop leaves a solid red one
    // (BioMapCueSdWriteStopped, paired with the "REC STOPPED" banner) and
    // nothing else turns it off. Every other light here clears itself.
    biomap_app_cue(app, BioMapCueStatusLightOff);
    if(s->vp) {
        // s->vp is app->screen_vp, the one fullscreen ViewPort every
        // screen shares. Disable it and clear its draw callback, but never
        // remove or free it: with no enabled fullscreen ViewPort for a
        // moment, the desktop would flash through before the next screen.
        view_port_enabled_set(s->vp, false);
        view_port_draw_callback_set(s->vp, NULL, NULL);
        s->vp = NULL;
    }
}

// ==========================================================================
// The event loop
// ==========================================================================

static bool session_key(InputKey key, SessionKey* out) {
    switch(key) {
    case InputKeyOk:    *out = SessionKeyOk;    return true;
    case InputKeyBack:  *out = SessionKeyBack;  return true;
    case InputKeyUp:    *out = SessionKeyUp;    return true;
    case InputKeyDown:  *out = SessionKeyDown;  return true;
    case InputKeyLeft:  *out = SessionKeyLeft;  return true;
    case InputKeyRight: *out = SessionKeyRight; return true;
    default:            return false;
    }
}

void run_recording_session(BioMapApp* app, BioMapMode mode) {
    Session* s = &app->session;
    session_init(app, mode);

    // Show the recording screen BEFORE allocating the modules.
    // gps_uart_alloc() waits several hundred ms while it brings up the
    // GPS; with the screen still disabled, the GUI thread would run in
    // that time, find no enabled fullscreen ViewPort and paint the
    // desktop. The draw callback copes with the modules not being there
    // yet ("GPS unavailable", no graph).
    s->vp = app->screen_vp;
    view_port_draw_callback_set(s->vp, biomap_render_callback, app);
    view_port_enabled_set(s->vp, true);
    view_port_update(s->vp);

    GpsUart* gps = session_mode_needs_gps(mode)
        ? gps_uart_alloc(app->event_queue, app->notifications, app->nav_model, app->super_s)
        : NULL;  // otherwise the module stays asleep (gps_uart_port_open())
    // The radio scan borrows the GSR worker thread (em_scan_sampler.h).
    EmScanSampler* em = has_rf(mode) ? em_scan_sampler_alloc() : NULL;
    GsrSensor* gsr = session_mode_needs_gsr(mode)
        ? gsr_sensor_alloc(em ? em_scan_sampler_poll : NULL, em)
        : NULL;
    if(gsr) gsr_sensor_set_calibration(gsr, app->cal_active, app->cal_gain, app->cal_zero_counts);
    if(em) em_scan_sampler_set_enabled(em, true);
    // Live Stream has no file: Bluetooth replaces it.
    SdLogger* logger = (mode == BioMapModeLiveStream) ? NULL : sd_logger_alloc(app->storage);
    BtStream* bt_stream = NULL;
    if(mode == BioMapModeLiveStream) {
        bt_stream = bt_stream_alloc();
        if(!bt_stream_start(bt_stream)) {
            // Not fatal: the status stays BtStatusUnavailable, which the
            // Live Stream screen shows.
            FURI_LOG_W(TAG, "Live Stream: BLE profile failed to start");
        }
    }

    furi_mutex_acquire(app->mutex, FuriWaitForever);
    s->core.gps = gps;
    s->core.gsr = gsr;
    s->em = em;
    s->logger = logger;
    s->bt_stream = bt_stream;
    furi_mutex_release(app->mutex);
    view_port_update(s->vp);

    biomap_backlight_claim(app);

    s->timer = furi_timer_alloc(biomap_timer_callback, FuriTimerTypePeriodic, app->event_queue);
    furi_timer_start(s->timer, furi_kernel_get_tick_frequency() / TICK_HZ);

    BioMapEvent ev;
    while(s->core.running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;

        // GPS bytes. No redraw here: one fix arrives as a burst of NMEA
        // sentences, and a redraw per sentence spammed "ViewPort lockup"
        // warnings and came just before a real hang on hardware. The tick
        // redraws at 2 Hz anyway.
        if(ev.type == EventTypeUart) {
            if(s->core.gps) gps_uart_process_rx(s->core.gps);
            continue;
        }

        SessionKey key;
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
           && session_key(ev.input.key, &key)) {
            if(session_core_key(&s->core, key)) view_port_update(s->vp);
            continue;
        }

        if(ev.type == EventTypeTick) {
            if(session_core_tick(&s->core)) view_port_update(s->vp);
        }
    }

    session_deinit(app);
}
