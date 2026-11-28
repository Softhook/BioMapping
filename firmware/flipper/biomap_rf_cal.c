// biomap_rf_cal.c — RF Faraday calibration menu & wizard control flow.
//
// Same shape as the GSR calibration menu and wizard in biomap_gui.c, but
// drives em_scan_cal.h's Faraday noise-floor calibration, in a blocking
// loop. vp_push/vp_pop/drain_stale_events/run_cal_submenu/run_simple_viewer
// come from biomap_gui.c (see biomap.h).
#include "biomap.h"

#define RF_CAL_PREP_SECONDS   30
#define RF_CAL_SAMPLE_SECONDS 20

// ── Show current RF calibration ─────────────────────────────────────────
// run_simple_viewer/run_cal_submenu (biomap_gui.c) hold the shared
// Up/Down/OK/Back loop shapes — see biomap.h.
static void run_show_current_rf_calibration(BioMapApp* app) {
    run_simple_viewer(app, rf_show_current_calibration_render, app);
}

void run_rf_calibration_menu(BioMapApp* app) {
    run_cal_submenu(app, rf_calibration_menu_render,
                    run_rf_calibration_wizard, biomap_reset_rf_calibration,
                    run_show_current_rf_calibration);
}

// Shared cancel-cleanup for the prep and sampling loops below — both bail
// out with the identical "back tone, power down radio, pop screen, free
// mutex" sequence, differing only in which loop's cancel flag triggered it.
static void rf_cal_wizard_abort(BioMapApp* app, FuriMutex* mutex) {
    biomap_app_cue(app, BioMapCueBack);
    em_scan_rf_deinit();
    vp_pop(app);
    furi_mutex_free(mutex);
}

void run_rf_calibration_wizard(BioMapApp* app) {
    gps_uart_sleep();
    RfCalWizardState w = {
        .seconds_left = RF_CAL_PREP_SECONDS,
    };
    // Guards every field below against the GUI thread's render callbacks
    // (biomap_render.c's rf_calibration_wizard_*_render), which run
    // asynchronously off view_port_update() — see RfCalWizardState's doc
    // comment in biomap.h. Allocated before vp_push() so the callback is
    // never live with mutex == NULL.
    w.mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(w.mutex, "RfCalWizardState: mutex alloc failed");
    ViewPort* vp = vp_push(app, rf_calibration_wizard_prep_render, &w);
    drain_stale_events(app->event_queue);

    // The wizard drives the CC1101 directly (em_scan_rf_dwell_band), outside
    // of any recording session's RF worker — no session is active while the
    // Options-menu calibration flow runs, so this function owns power-up/
    // down of the radio for its own duration.
    em_scan_rf_init();

    // ── Prep countdown (30s), skippable via OK, cancelable via Back ────
    // Non-blocking drain + a fixed furi_delay_ms(100) each iteration — NOT
    // furi_message_queue_get(..., timeout) as the pacing clock, which would
    // return early on irrelevant keys and fast-forward the countdown.
    bool cancelled = false;
    bool skip_prep = false;
    for(uint32_t elapsed = 0; elapsed < RF_CAL_PREP_SECONDS * TICK_HZ; elapsed++) {
        BioMapEvent ev;
        while(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk) {
            if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
                if(ev.input.key == InputKeyBack) {
                    cancelled = true;
                    break;
                }
                if(ev.input.key == InputKeyOk) {
                    skip_prep = true;
                    break;
                }
            }
        }
        if(cancelled || skip_prep) break;
        furi_delay_ms(1000 / TICK_HZ);
        if((elapsed % TICK_HZ) == 0) {
            furi_mutex_acquire(w.mutex, FuriWaitForever);
            w.seconds_left = RF_CAL_PREP_SECONDS - elapsed / TICK_HZ;
            furi_mutex_release(w.mutex);
            view_port_update(vp);
        }
    }
    if(cancelled) {
        rf_cal_wizard_abort(app, w.mutex);
        return;
    }
    biomap_app_cue(app, BioMapCueConfirm);

    // ── Active sampling (20s / up to EM_SCAN_CAL_MAX_SAMPLES sweeps) ───
    // One em_scan_rf_dwell_band() call per ~100 ms iteration, round-robin
    // across EM_SCAN_NUM_FREQS bands — a full sweep (one sample per band)
    // completes and is recorded every time the band index wraps to 0.
    // Locked: the prep screen is still showing and reads seconds_left.
    furi_mutex_acquire(w.mutex, FuriWaitForever);
    w.seconds_left = RF_CAL_SAMPLE_SECONDS;
    furi_mutex_release(w.mutex);
    vp_push(app, rf_calibration_wizard_sampling_render, &w);
    // static, not a stack local: 64*3 floats (768 bytes) is a meaningful
    // chunk of this thread's 4 KB total stack (application.fam's stack_size)
    // several call-frames deep (biomap_app -> run_options_screen ->
    // run_rf_calibration_menu -> here). Safe as static — this wizard is
    // never re-entrant or concurrent (single blocking call on the main app
    // thread).
    static float samples[EM_SCAN_CAL_MAX_SAMPLES][EM_SCAN_NUM_FREQS];
    int band = 0;
    bool sampling_cancelled = false;
    for(uint32_t elapsed = 0; elapsed < RF_CAL_SAMPLE_SECONDS * TICK_HZ; elapsed++) {
        BioMapEvent ev;
        while(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk) {
            if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
                && ev.input.key == InputKeyBack) {
                sampling_cancelled = true;
                break;
            }
        }
        if(sampling_cancelled) break;
        furi_delay_ms(1000 / TICK_HZ);

        float peak;
        em_scan_rf_dwell_band(band, &peak);

        furi_mutex_acquire(w.mutex, FuriWaitForever);
        w.rssi_dbm[band] = peak;
        band = (band + 1) % EM_SCAN_NUM_FREQS;

        if(band == 0 && w.sweep_count < EM_SCAN_CAL_MAX_SAMPLES) {
            memcpy(samples[w.sweep_count], w.rssi_dbm, sizeof(w.rssi_dbm));
            w.sweep_count++;
        }

        w.seconds_left = RF_CAL_SAMPLE_SECONDS - elapsed / TICK_HZ;
        furi_mutex_release(w.mutex);
        view_port_update(vp);
    }
    if(sampling_cancelled) {
        rf_cal_wizard_abort(app, w.mutex);
        return;
    }

    // ── Compute stats + pass/fail ───────────────────────────────────────
    // Gate: minimum sweep count plus em_scan_cal_stats_valid() (per-band
    // floor bounds, max std dev, and NaN checks). Written before vp_push()
    // publishes them to rf_calibration_wizard_stats_render().
    em_scan_cal_compute_stats(
        (const float(*)[EM_SCAN_NUM_FREQS])samples,
        w.sweep_count,
        w.computed_floors,
        w.computed_std_devs);

    w.passed = (w.sweep_count >= EM_SCAN_CAL_MIN_SAMPLES) &&
               em_scan_cal_stats_valid(w.computed_floors, w.computed_std_devs);

    vp_push(app, rf_calibration_wizard_stats_render, &w);
    biomap_app_cue(app, w.passed ? BioMapCueSuccess : BioMapCueError);
    view_port_update(vp);

    // ── Result screen: OK saves (if passed), Back discards ─────────────
    drain_stale_events(app->event_queue);
    while(true) {
        BioMapEvent ev;
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk) continue;
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort) continue;

        if(ev.input.key == InputKeyOk && w.passed) {
            EmScanCal cal;
            memset(&cal, 0, sizeof(cal));
            cal.timestamp = biomap_rtc_now_epoch();
            memcpy(cal.noise_floor_dbm, w.computed_floors, sizeof(cal.noise_floor_dbm));
            memcpy(cal.noise_std_dev_db, w.computed_std_devs, sizeof(cal.noise_std_dev_db));
            cal.sample_count = w.sweep_count;

            bool saved = biomap_save_rf_calibration(app, &cal);
            biomap_app_cue(app, saved ? BioMapCueConfirm : BioMapCueError);
            break;
        } else if(ev.input.key == InputKeyBack || (ev.input.key == InputKeyOk && !w.passed)) {
            biomap_app_cue(app, BioMapCueBack);
            break;
        }
    }

    em_scan_rf_deinit();
    vp_pop(app);
    furi_mutex_free(w.mutex);
}
