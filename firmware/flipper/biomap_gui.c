// Bio Mapping — GUI: input/timer callbacks, menus, options.
//
// The draw callbacks for these screens (menu_render, options_render, the
// calibration screens) live in biomap_render.c; the recording screen's in
// flipper/biomap_screen_flipper.c.
#include "biomap.h"

// ==========================================================================
// Input & timer callbacks — forward events to the app's message queue
// ==========================================================================

void biomap_input_callback(InputEvent* e, void* ctx) {
    BioMapEvent ev = {.type = EventTypeKey, .input = *e};
    // Non-blocking, like the timer callback below: this runs on the GUI
    // service's thread, which holds the ViewPort lock while dispatching
    // input. Blocking here on a full queue would stall the whole GUI (and
    // contend with the app thread's view_port_update()). A dropped key
    // press is harmless.
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

void biomap_timer_callback(void* ctx) {
    BioMapEvent ev = {.type = EventTypeTick, .tick_ms = furi_get_tick()};
    // Non-blocking: software timer callbacks run in the system timer daemon
    // task.  Blocking here would stall all OS timers (key repeat, backlight
    // dimming, etc.) when the queue is full.  The increased EVENT_QUEUE_DEPTH
    // (64) prevents drops under normal GPS UART burst conditions.
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

// ==========================================================================
// ViewPort lifecycle helpers — reduce boilerplate for push/pop screens
// ==========================================================================
//
// These do NOT allocate a new ViewPort. They repoint app->screen_vp — the
// single persistent fullscreen ViewPort that stays in the GUI stack for the
// app's whole lifetime (see biomap_app() in biomap.c). Screen transitions
// only swap the draw callback and toggle enabled/disabled, so there's never
// a frame where zero fullscreen ViewPorts are enabled — that gap is what
// let the desktop/dolphin background flash through during transitions.

// "Push" a screen: point the shared ViewPort at a new draw callback and
// enable it. Returns app->screen_vp for callers that pass it around.
// Not static — reused by biomap_rf_cal.c's RF calibration menu/wizard.
ViewPort* vp_push(BioMapApp* app, ViewPortDrawCallback draw, void* ctx) {
    ViewPort* vp = app->screen_vp;
    view_port_draw_callback_set(vp, draw, ctx);
    view_port_enabled_set(vp, true);
    view_port_update(vp);
    return vp;
}

// "Pop" a screen: disable the shared ViewPort and clear its draw callback.
// It stays in the GUI stack — never removed/freed here.
void vp_pop(BioMapApp* app, ViewPort* vp) {
    UNUSED(vp);
    view_port_enabled_set(app->screen_vp, false);
    view_port_draw_callback_set(app->screen_vp, NULL, NULL);
}

// Drain any stale events from the queue before starting a sub-screen loop.
void drain_stale_events(FuriMessageQueue* q) {
    BioMapEvent ev;
    while(furi_message_queue_get(q, &ev, 0) == FuriStatusOk);
}

// Cycle *selection under app->mutex (the render callback reads it from
// another thread) and play the nav click — shared Up/Down handling for the
// main menu, Options screen, and GSR/RF calibration submenu.
static void nav_cycle(BioMapApp* app, int32_t* selection, int32_t count, bool down) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    *selection = cycle_selection(*selection, count, down);
    furi_mutex_release(app->mutex);
    biomap_app_cue(app, BioMapCueClick);
}

// ==========================================================================
// Launch menu — main navigation
// ==========================================================================
//  Controls:  Up/Down → navigate     OK → select     Back → exit app

int32_t biomap_gui_show_menu(BioMapApp* app) {
    ListContext ctx = {.app = app, .selection = 0};
    ViewPort* vp = vp_push(app, menu_render, &ctx);
    drain_stale_events(app->event_queue);

    BioMapEvent ev;
    int32_t result = -1;
    bool running = true;
    while(running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort) continue;

        switch(ev.input.key) {
        case InputKeyUp:
            nav_cycle(app, &ctx.selection, MENU_COUNT, false);
            view_port_update(vp);
            break;
        case InputKeyDown:
            nav_cycle(app, &ctx.selection, MENU_COUNT, true);
            view_port_update(vp);
            break;
        case InputKeyOk:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            result = ctx.selection;
            furi_mutex_release(app->mutex);
            biomap_app_cue(app, BioMapCueConfirm);
            running = false;
            break;
        case InputKeyBack:
            result = -1;
            biomap_app_cue(app, BioMapCueBack);
            running = false;
            break;
        default: break;
        }
    }

    vp_pop(app, vp);
    return result;
}

// ==========================================================================
// Options screen
// ==========================================================================
//  Controls:  Up/Down → navigate     OK → select/toggle     Back → return

// Toggle a bool app setting (Super-S, Auto-zoom, Backlight, Sound, Debug
// Fields), persist it, and play a distinct on/off confirmation tone — shared
// by the on/off rows below. force_tone bypasses the
// `sound_enabled` gate: used only by the Sound toggle itself, so
// muting/unmuting is always audible regardless of the new state.
static void toggle_app_setting(BioMapApp* app, bool* field, bool force_tone) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    *field = !*field;
    bool new_val = *field;
    furi_mutex_release(app->mutex);
    biomap_save_settings(app);
    biomap_cue(app->notifications, force_tone ? true : app->sound_enabled,
               new_val ? BioMapCueToggleOn : BioMapCueToggleOff);
}

void run_options_screen(BioMapApp* app) {
    ListContext ctx = {.app = app, .selection = 0};
    ViewPort* vp = vp_push(app, options_render, &ctx);

    drain_stale_events(app->event_queue);
    BioMapEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) {
                biomap_app_cue(app, BioMapCueBack);
                break;
            }

            switch(ev.input.key) {
            case InputKeyUp:
                nav_cycle(app, &ctx.selection, OPTIONS_COUNT, false);
                break;
            case InputKeyDown:
                nav_cycle(app, &ctx.selection, OPTIONS_COUNT, true);
                break;
            case InputKeyOk:
            case InputKeyLeft:
            case InputKeyRight:
                switch(ctx.selection) {
                case OptGpsProfile:
                    // Next GPS Profile (PED, WRIST, VEHICLE, STATION, SEA, BIKE, FLIGHT)
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->nav_model = (GpsNavModel)cycle_selection((int32_t)app->nav_model, GpsNavModelCount, true);
                    furi_mutex_release(app->mutex);
                    biomap_save_settings(app);
                    biomap_app_cue(app, BioMapCueClick);
                    break;
                case OptSuperS:
                    // Applied at the next GPS start (session or Cold Reset GPS),
                    // same as GPS Profile.
                    toggle_app_setting(app, &app->super_s, false);
                    break;
                case OptColdResetGps:
                    // Cold Reset GPS — VP stays visible, no need to re-create.
                    // run_gps_cold_start() plays its own success/error tone.
                    run_gps_cold_start(app);
                    view_port_update(vp);
                    continue;
                case OptAutoZoom:
                    // Toggle auto-zoom (session_init handles level/peak reset)
                    toggle_app_setting(app, &app->zoom_enabled, false);
                    break;
                case OptGsrCalibration:
                    biomap_app_cue(app, BioMapCueConfirm);
                    run_calibration_menu(app);
                    vp_push(app, options_render, &ctx);
                    continue;
                case OptRfCalibration:
                    // Re-arm-after-return pattern, same as GSR Calibration
                    biomap_app_cue(app, BioMapCueConfirm);
                    run_rf_calibration_menu(app);
                    vp_push(app, options_render, &ctx);
                    continue;
                case OptBacklight:
                    toggle_app_setting(app, &app->backlight_on, false);
                    break;
                case OptSound:
                    // force_tone: mute/unmute must always be audible,
                    // regardless of the new sound_enabled state.
                    toggle_app_setting(app, &app->sound_enabled, true);
                    break;
                case OptDiagnostics:
                    biomap_app_cue(app, BioMapCueConfirm);
                    run_recording_session(app, BioMapModeDiagnostics);
                    vp_push(app, options_render, &ctx);
                    continue;
                case OptDebugFields:
                    toggle_app_setting(app, &app->debug_fields_enabled, false);
                    break;
                default: break;
                }
                break;
            default: break;
            }
            view_port_update(vp);
        }
    }

    vp_pop(app, vp);
}

// Simple pop-up viewer: pushes `render`, waits for OK or Back to dismiss,
// then pops. Shared by the GSR (run_show_current_calibration below) and RF
// (run_show_current_rf_calibration, biomap_rf_cal.c) "Show Current" screens
// — see the declaration in biomap.h.
void run_simple_viewer(BioMapApp* app, ViewPortDrawCallback render, void* ctx) {
    ViewPort* vp = vp_push(app, render, ctx);
    drain_stale_events(app->event_queue);
    BioMapEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack || ev.input.key == InputKeyOk) {
                biomap_app_cue(app, BioMapCueBack);
                break;
            }
        }
    }
    vp_pop(app, vp);
}

static void run_show_current_calibration(BioMapApp* app) {
    run_simple_viewer(app, show_current_calibration_render, app);
}

// Generic "Start Wizard / Reset to Default / Show Current" 3-item submenu
// loop — shared shape behind run_calibration_menu (GSR, below) and
// run_rf_calibration_menu (RF, biomap_rf_cal.c) — see the declaration in
// biomap.h.
// run_cal_submenu()'s fixed 3-item shape: Start Wizard / Reset / Show
// Current — matches the order drawn by draw_cal_submenu() (biomap_render.c).
#define CAL_SUBMENU_COUNT 3
enum {
    CalSubmenuStartWizard = 0,
    CalSubmenuReset,
    CalSubmenuShowCurrent,
};

void run_cal_submenu(BioMapApp* app, ViewPortDrawCallback render,
                      SubmenuAction start_wizard, SubmenuAction reset,
                      SubmenuAction show_current) {
    // ctx.selection is read cross-thread by draw_cal_submenu() (GUI render
    // thread) — guarded by app->mutex on both sides (ListContext, biomap.h).
    ListContext ctx = {.app = app, .selection = 0};
    ViewPort* vp = vp_push(app, render, &ctx);
    drain_stale_events(app->event_queue);
    BioMapEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) {
                biomap_app_cue(app, BioMapCueBack);
                break;
            }
            if(ev.input.key == InputKeyUp) {
                nav_cycle(app, &ctx.selection, CAL_SUBMENU_COUNT, false);
            } else if(ev.input.key == InputKeyDown) {
                nav_cycle(app, &ctx.selection, CAL_SUBMENU_COUNT, true);
            } else if(ev.input.key == InputKeyOk) {
                // This thread's own last write — no lock needed to read it
                // back.
                if(ctx.selection == CalSubmenuStartWizard) {
                    biomap_app_cue(app, BioMapCueConfirm);
                    start_wizard(app);
                    break;
                } else if(ctx.selection == CalSubmenuReset) {
                    biomap_app_cue(app, BioMapCueReset);
                    reset(app);
                    break;
                } else {
                    biomap_app_cue(app, BioMapCueConfirm);
                    show_current(app);
                    vp_push(app, render, &ctx);
                    continue;
                }
            }
            view_port_update(vp);
        }
    }
    vp_pop(app, vp);
}

void run_calibration_menu(BioMapApp* app) {
    run_cal_submenu(app, calibration_menu_render,
                    run_calibration_wizard, biomap_reset_calibration,
                    run_show_current_calibration);
}

// Drives the shared 4-step calibration wizard (core/cal_wizard.h) on the
// Flipper: forwards OK and Back to cal_wizard_key(),
// and while cal_wizard_measuring() is true, steps cal_wizard_tick() at
// 10 Hz while polling the event queue for Back cancellation.
void run_calibration_wizard(BioMapApp* app) {
    gps_uart_sleep();
    GsrSensor* gsr = gsr_sensor_alloc(NULL, NULL);
    if(gsr && !gsr_sensor_available(gsr)) {
        gsr_sensor_free(gsr);
        gsr = NULL;
    }

    WizardState w = {0};
    cal_wizard_init(&w.core, gsr);
    // Guards w.core against calibration_wizard_render() running on the GUI
    // thread — see WizardState's doc comment in biomap.h. Allocated before
    // vp_push() so the callback is never live with mutex == NULL.
    w.mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(w.mutex, "WizardState: mutex alloc failed");
    ViewPort* vp = vp_push(app, calibration_wizard_render, &w);
    drain_stale_events(app->event_queue);

    bool running = true;
    while(running) {
        if(cal_wizard_measuring(&w.core)) {
            BioMapEvent ev;
            bool cancelled = false;
            while(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk) {
                if(ev.type == EventTypeKey && ev.input.type == InputTypeShort &&
                   ev.input.key == InputKeyBack) {
                    cancelled = true;
                    break;
                }
            }
            if(cancelled) {
                BioMapCue cue = BioMapCueBack;
                furi_mutex_acquire(w.mutex, FuriWaitForever);
                cal_wizard_key(&w.core, false, &cue);
                furi_mutex_release(w.mutex);
                biomap_app_cue(app, cue);
                break;
            }

            // In CalDwellPhaseBiasCheck, cal_wizard_tick() runs the
            // synchronous ~50 ms bias check itself (right after the 10-tick
            // pre-dwell flush), so don't add an extra 100 ms delay before it.
            if(w.core.phase != CalDwellPhaseBiasCheck) {
                furi_delay_ms(1000 / TICK_HZ);
            }

            // Tick a copy without the lock, so the GUI thread's render never
            // waits on the I2C reads or the bias check (up to
            // GSR_BIAS_CHECK_TIMEOUT_MS). This thread is the only writer, so
            // the copy is current; the lock is held only to publish it.
            BioMapCue done_cue = BioMapCueCount;
            CalWizardCore next = w.core;
            bool finished = cal_wizard_tick(&next, &done_cue);
            furi_mutex_acquire(w.mutex, FuriWaitForever);
            w.core = next;
            furi_mutex_release(w.mutex);
            BioMapCue fit_cue = next.fit_cue;
            view_port_update(vp);

            if(finished) {
                char why[96];
                if(cal_wizard_fail_reason(&next, why, sizeof(why))) {
                    FURI_LOG_W("BioMap", "Calibration: %s", why);
                }
                biomap_app_cue(app, done_cue);
                if(fit_cue != BioMapCueCount) {
                    biomap_app_cue(app, fit_cue);
                }
            }
            continue;
        }

        BioMapEvent ev;
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort)
            continue;
        if(ev.input.key != InputKeyOk && ev.input.key != InputKeyBack)
            continue;

        BioMapCue cue = BioMapCueCount;
        furi_mutex_acquire(w.mutex, FuriWaitForever);
        CalKeyOutcome out = cal_wizard_key(&w.core, ev.input.key == InputKeyOk, &cue);
        furi_mutex_release(w.mutex);

        if(out == CalKeyOutcomeNone) continue;
        // Play the click/confirm/back/error cue BEFORE the first dwell tick
        // runs: the dwell begins with a 1–2 s buffer flush that absorbs any
        // speaker noise from the click.
        biomap_app_cue(app, cue);
        if(out == CalKeyOutcomeSaveAndExit) {
            biomap_save_calibration(app, w.core.gain, w.core.zero_counts,
                                    w.core.r_squared, w.core.noise_std_dev);
            running = false;
        } else if(out == CalKeyOutcomeCancelAndExit) {
            running = false;
        } else {
            view_port_update(vp);
            BioMapCue err_cue = BioMapCueCount;
            furi_mutex_acquire(w.mutex, FuriWaitForever);
            bool no_sensor = cal_wizard_check_sensor(&w.core, &err_cue);
            furi_mutex_release(w.mutex);
            if(no_sensor) {
                biomap_app_cue(app, err_cue);
                view_port_update(vp);
            }
        }
    }

    if(gsr) gsr_sensor_free(gsr);
    vp_pop(app, vp);
    furi_mutex_free(w.mutex);
}

