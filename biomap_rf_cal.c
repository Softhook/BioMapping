// biomap_rf_cal.c — RF Faraday calibration menu & wizard control flow.
//
// Mirrors biomap_gui.c's GSR calibration menu/wizard (run_calibration_menu/
// run_calibration_wizard) in shape, but drives em_scan_cal.h's Faraday
// noise-floor calibration instead — rewritten to that blocking-loop style
// rather than porting em_scan.c's original tick/timer-driven state machine
// verbatim (see em_scan_biomap_merge_plan.md's "Calibration wizard
// control-flow style" design decision). Kept in its own file rather than
// folded into biomap_gui.c (already 500+ lines) — vp_push/vp_pop/
// drain_stale_events/cycle_selection are shared from there (see biomap.h).
#include "biomap.h"

// ── Show current RF calibration ─────────────────────────────────────────
static void run_show_current_rf_calibration(BioMapApp* app) {
    ViewPort* vp = vp_push(app, rf_show_current_calibration_render, app);
    drain_stale_events(app->event_queue);
    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack || ev.input.key == InputKeyOk) {
                biomap_sound_back(app->sound_enabled);
                break;
            }
        }
    }
    vp_pop(app, vp);
}

void run_rf_calibration_menu(BioMapApp* app) {
    int selection = 0;
    ViewPort* vp = vp_push(app, rf_calibration_menu_render, &selection);
    drain_stale_events(app->event_queue);
    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) {
                biomap_sound_back(app->sound_enabled);
                break;
            }
            if(ev.input.key == InputKeyUp) {
                selection = cycle_selection(selection, 3, false); // 3 items
                biomap_sound_click(app->sound_enabled);
            } else if(ev.input.key == InputKeyDown) {
                selection = cycle_selection(selection, 3, true);
                biomap_sound_click(app->sound_enabled);
            } else if(ev.input.key == InputKeyOk) {
                if(selection == 0) {
                    biomap_sound_confirm(app->sound_enabled);
                    run_rf_calibration_wizard(app);
                    break;
                } else if(selection == 1) {
                    biomap_sound_reset(app->sound_enabled);
                    biomap_reset_rf_calibration(app);
                    break;
                } else {
                    biomap_sound_confirm(app->sound_enabled);
                    run_show_current_rf_calibration(app);
                    vp_push(app, rf_calibration_menu_render, &selection);
                }
            }
            view_port_update(vp);
        }
    }
    vp_pop(app, vp);
}

void run_rf_calibration_wizard(BioMapApp* app) {
    RfCalWizardState w = {0};
    // Guards every field below against the GUI thread's render callbacks
    // (biomap_render.c's rf_calibration_wizard_*_render), which run
    // asynchronously off view_port_update() — see RfCalWizardState's doc
    // comment in biomap.h. Allocated before vp_push() so the callback is
    // never live with mutex == NULL.
    w.mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    ViewPort* vp = vp_push(app, rf_calibration_wizard_prep_render, &w);
    drain_stale_events(app->event_queue);

    // The wizard drives the CC1101 directly (em_scan_rf_dwell_band), outside
    // of any recording session's RF worker — no session is active while the
    // Options-menu calibration flow runs, so this function owns power-up/
    // down of the radio for its own duration.
    em_scan_rf_init();

    // ── Prep countdown (30s), skippable via OK, cancelable via Back ────
    // Non-blocking peek + a fixed furi_delay_ms(100) each iteration — NOT a
    // furi_message_queue_get(..., timeout) used as the pacing clock. That
    // approach returns as soon as ANY event is queued (not just Back/OK),
    // so a repeated/held irrelevant key (Up/Down, which do nothing here)
    // would return early every iteration and silently fast-forward the
    // whole 30s wait. The fixed delay makes iteration cadence independent
    // of how much key traffic arrives — matches the sampling loop below,
    // which already used this pattern.
    furi_mutex_acquire(w.mutex, FuriWaitForever);
    w.step = 0;
    w.seconds_left = 30;
    furi_mutex_release(w.mutex);
    bool cancelled = false;
    for(uint32_t elapsed = 0; elapsed < 30 * TICK_HZ; elapsed++) {
        PluginEvent ev;
        if(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk) {
            if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
                if(ev.input.key == InputKeyBack) {
                    cancelled = true;
                    break;
                }
                if(ev.input.key == InputKeyOk) break; // skip remaining wait
            }
        }
        furi_delay_ms(1000 / TICK_HZ);
        if((elapsed % TICK_HZ) == 0) {
            furi_mutex_acquire(w.mutex, FuriWaitForever);
            w.seconds_left = 30 - elapsed / TICK_HZ;
            furi_mutex_release(w.mutex);
            view_port_update(vp);
        }
    }
    if(cancelled) {
        biomap_sound_back(app->sound_enabled);
        em_scan_rf_deinit();
        vp_pop(app, vp);
        furi_mutex_free(w.mutex);
        return;
    }
    biomap_sound_confirm(app->sound_enabled);

    // ── Active sampling (20s / up to EM_SCAN_CAL_MAX_SAMPLES sweeps) ───
    // One em_scan_rf_dwell_band() call per ~100ms iteration, round-robin
    // across EM_SCAN_NUM_FREQS bands — a full sweep (one sample per band)
    // completes and is recorded every time the band index wraps to 0,
    // exactly mirroring em_scan.c's original EmScanModeCalSampling logic.
    furi_mutex_acquire(w.mutex, FuriWaitForever);
    w.step = 1;
    furi_mutex_release(w.mutex);
    vp_push(app, rf_calibration_wizard_sampling_render, &w);
    // static, not a stack local: 64*3 floats (768 bytes) is a meaningful
    // chunk of this thread's 4KB total stack (application.fam's
    // stack_size) several call-frames deep (biomap_app -> run_options_
    // screen -> run_rf_calibration_menu -> here). em_scan.c's original
    // avoided this the same way, just via a heap-allocated EmScanApp field
    // instead — static works equally well since this wizard is never
    // re-entrant/concurrent (single blocking call on the main app thread).
    static float samples[EM_SCAN_CAL_MAX_SAMPLES][EM_SCAN_NUM_FREQS];
    w.sweep_count = 0;
    int band = 0;
    bool sampling_cancelled = false;
    for(uint32_t elapsed = 0; elapsed < 20 * TICK_HZ; elapsed++) {
        PluginEvent ev;
        if(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk) {
            if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
                && ev.input.key == InputKeyBack) {
                sampling_cancelled = true;
                break;
            }
        }
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

        w.seconds_left = 20 - elapsed / TICK_HZ;
        furi_mutex_release(w.mutex);
        view_port_update(vp);
    }
    if(sampling_cancelled) {
        biomap_sound_back(app->sound_enabled);
        em_scan_rf_deinit();
        vp_pop(app, vp);
        furi_mutex_free(w.mutex);
        return;
    }

    // ── Compute stats + pass/fail ───────────────────────────────────────
    // Same gate em_scan.c's original wizard used: per-band ceiling
    // (em_scan_cal_max_floor_dbm), floor sanity clamp (EM_SCAN_CAL_MIN_
    // FLOOR_DBM), and max std dev (EM_SCAN_CAL_MAX_STD_DEV_DB).
    // No mutex needed here: computed_floors/computed_std_devs/passed/step
    // are all written below BEFORE the vp_push() call that makes
    // rf_calibration_wizard_stats_render (the first reader of any of them)
    // live, and nothing else writes them afterward — vp_push() itself
    // provides the happens-before edge, same reasoning as any other
    // single-threaded-until-publish pattern.
    em_scan_cal_compute_stats(
        (const float(*)[EM_SCAN_NUM_FREQS])samples,
        w.sweep_count,
        w.computed_floors,
        w.computed_std_devs);

    w.passed = (w.sweep_count >= 5);
    if(w.passed) {
        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
            if(w.computed_floors[i] > em_scan_cal_max_floor_dbm[i] ||
               w.computed_floors[i] < EM_SCAN_CAL_MIN_FLOOR_DBM ||
               w.computed_std_devs[i] >= EM_SCAN_CAL_MAX_STD_DEV_DB) {
                w.passed = false;
                break;
            }
        }
    }

    w.step = 2;
    vp_push(app, rf_calibration_wizard_stats_render, &w);
    if(w.passed) {
        biomap_sound_success(app->sound_enabled);
    } else {
        biomap_sound_error(app->sound_enabled);
    }
    view_port_update(vp);

    // ── Result screen: OK saves (if passed), Back discards ─────────────
    drain_stale_events(app->event_queue);
    while(true) {
        PluginEvent ev;
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk) continue;
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort) continue;

        if(ev.input.key == InputKeyOk && w.passed) {
            EmScanCal cal;
            memset(&cal, 0, sizeof(cal));
            DateTime dt;
            furi_hal_rtc_get_datetime(&dt);
            cal.timestamp = pipeline_unix_epoch(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second);
            memcpy(cal.noise_floor_dbm, w.computed_floors, sizeof(cal.noise_floor_dbm));
            memcpy(cal.noise_std_dev_db, w.computed_std_devs, sizeof(cal.noise_std_dev_db));
            cal.sample_count = w.sweep_count;

            biomap_save_rf_calibration(app, &cal);
            biomap_sound_confirm(app->sound_enabled);
            break;
        } else if(ev.input.key == InputKeyBack || (ev.input.key == InputKeyOk && !w.passed)) {
            biomap_sound_back(app->sound_enabled);
            break;
        }
    }

    em_scan_rf_deinit();
    vp_pop(app, vp);
    furi_mutex_free(w.mutex);
}
