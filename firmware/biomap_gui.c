// Bio Mapping — GUI: input/timer callbacks, menus, options.
//
// Render callbacks (draw_graph, biomap_render_callback, menu_render,
// options_render) live in biomap_render.c for separation of presentation
// from control flow.
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

// cycle_selection() moved to biomap_format.c (SDK-free, linked by
// tests/test_firmware.c instead of mirrored).

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
//  ┌─────────────────────────────┐
//  │  Bio Mapping                │
//  │  ▓ GPS + GSR           ▓    │   ← selected item (inverse bar)
//  │    GPS Only                 │
//  │    GSR Only                 │
//  │    Options                  │
//  └─────────────────────────────┘
//
//  Controls:  Up/Down → navigate     OK → select     Back → exit app

int32_t biomap_gui_show_menu(BioMapApp* app) {
    MenuContext ctx = {.app = app, .selection = 0};
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
// Options screen — Cold Reset GPS, Auto-zoom toggle
// ==========================================================================
//
//  ┌─────────────────────────────┐
//  │  Options                    │
//  │  ▓ Cold Reset GPS      ▓   │   ← selected
//  │    Auto-zoom GSR   ON      │
//  │    Backlight           ON  │
//  │    GSR Calibration    YES  │
//  │    Diagnostics              │
//  └─────────────────────────────┘
//
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
    OptionsContext ctx = {.app = app, .selection = 0};
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
                    // Cycle GPS Profile (PED -> WRIST -> VEHICLE -> STATIONARY -> SEA -> BIKE -> FLIGHT)
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
    // thread) — guarded by app->mutex on both sides, same as MenuContext/
    // OptionsContext above. See CalSubmenuContext's doc comment in
    // biomap.h.
    CalSubmenuContext ctx = {.app = app, .selection = 0};
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
                // back (see WizardState's identical reasoning in
                // biomap_gui.c's run_calibration_wizard()).
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

// GSR + Sound safety invariant for the calibration wizard: this function
// must never send a cue with a sound (core/biomap_cues.h), and the caller (run_calibration_
// wizard) must never call it either during the dwell loop below. The
// caller's one pre-measurement tone (a ~35 ms click, played right before
// this function is entered) is made safe by the very next thing this
// function does: a full 1 s / 10-tick buffer flush, whose discarded
// readings absorb any tone-era ADC samples ~30x over (the GSR ring buffer
// is only ~128 ms deep — see GSR_TONE_SETTLE_MS in core/biomap_session.h for
// the equivalent, tighter-margin calculation used for recording start).
// The caller's post-measurement tones (confirm/error/success) are safe by
// construction: they only ever play after this function has already
// returned with its result, i.e. after the whole dwell's samples were taken.
typedef enum {
    CalMeasureOk,
    CalMeasureFailed,     // fewer than CAL_MIN_VALID in-gate samples over the dwell
    CalMeasureCancelled,  // Back pressed mid-dwell
    CalMeasureBiasFailed, // the 0.5 V bias check failed or read out of range
} CalMeasureResult;

// One dwell: CAL_DWELL_SECONDS of readings at TICK_HZ, added to *dwell
// (cleared first) against the gate [lo, hi]. The reading is the window mean
// count when zero_step (the open-circuit step), otherwise the conductance in
// nS. Keeps w->seconds_left current for the Measuring screen's countdown,
// and polls the event queue every tick so Back can cancel early rather
// than blocking the whole wizard for CAL_DWELL_SECONDS (same non-blocking-
// peek + fixed-delay shape as run_rf_calibration_wizard()'s sampling loop,
// biomap_rf_cal.c): returns false then. *first (if not NULL) gets the first reading, for a failure
// log.
static bool calibration_wizard_dwell(BioMapApp* app, ViewPort* vp, WizardState* w,
                                     GsrSensor* gsr, bool zero_step, float lo, float hi,
                                     CalDwell* dwell, float* first) {
    cal_dwell_init(dwell);
    for(uint32_t elapsed = 0; elapsed < CAL_DWELL_SECONDS * TICK_HZ; elapsed++) {
        BioMapEvent ev;
        if(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk) {
            if(ev.type == EventTypeKey && ev.input.type == InputTypeShort &&
               ev.input.key == InputKeyBack) {
                return false;
            }
        }
        furi_delay_ms(1000 / TICK_HZ);
        gsr_sensor_tick(gsr);
        float v = zero_step ? (float)gsr_sensor_get_mean_count(gsr) : gsr_sensor_get_raw(gsr);
        if(elapsed == 0 && first) *first = v;
        cal_dwell_add(dwell, v, lo, hi);

        furi_mutex_acquire(w->mutex, FuriWaitForever);
        w->seconds_left = CAL_DWELL_SECONDS - elapsed / TICK_HZ;
        furi_mutex_release(w->mutex);
        view_port_update(vp);
    }
    return true;
}

// Runs one resistor's calibration dwell (CAL_DWELL_SECONDS at TICK_HZ),
// computing the mean (for the gain fit) and σ (for the pre-flight
// noise/resolution gate — see calibration_noise_grade(), biomap_format.c)
// over the in-gate samples with the shared CalDwell accumulator
// (core/biomap_format.h). Back cancels the dwell (CalMeasureCancelled).
static CalMeasureResult calibration_wizard_measure(BioMapApp* app, ViewPort* vp, WizardState* w,
                                                    GsrSensor* gsr, int resistor_idx,
                                                    const float gates[CAL_POINTS][2],
                                                    float* out_avg_g, float* out_std_dev) {
    // The open-circuit zero (step 14) removed, gain 1: the readings the
    // gain is fitted to, the same as a recording's before its gain.
    gsr_sensor_set_calibration(gsr, true, 1.0f, w->zero_counts);

    // Flush the ring buffer (1 s, CAL_RESISTOR_FLUSH_TICKS). Also the GSR+Sound settle
    // window for the caller's pre-measurement click — see this function's
    // header comment. Every reading here is intentionally discarded.
    for(int i = 0; i < CAL_RESISTOR_FLUSH_TICKS; i++) {
        furi_delay_ms(100);
        gsr_sensor_tick(gsr);
    }

    // Fresh 0.5 V bias check for this resistor (gsr_sensor.h, GSR_BIAS_*).
    // The fit is made on bias-corrected readings, so a missing or wrong
    // bias would be built into the saved gain and carried into every later
    // recording. Without a good reading the wizard stops here instead of
    // falling back to the nominal 0.5 V.
    // After the flush, not before: the caller's click has only just ended,
    // and C9 smooths the bias over ~85 ms, so any dip the speaker put on
    // 3.3 V would still be partly there — the same reason recording start
    // checks before its chirp. The two ticks after it clear the ~50 ms gap
    // the check leaves in the samples before the dwell starts.
    bool bias_done = gsr_sensor_run_bias_check(gsr, GSR_BIAS_CHECK_TIMEOUT_MS);
    float bias_v = bias_done ? gsr_sensor_get_bias_measured_volts(gsr) : NAN;
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->bias_measured_v = bias_v;
    furi_mutex_release(w->mutex);
    if(!gsr_bias_in_range(bias_v)) {
        FURI_LOG_W("BioMap", "Cal bias check failed: %.4f V", (double)bias_v);
        return CalMeasureBiasFailed;
    }
    for(int i = 0; i < CAL_POST_BIAS_FLUSH_TICKS; i++) {
        furi_delay_ms(100);
        gsr_sensor_tick(gsr);
    }

    CalDwell dwell;
    float first_raw = 0;
    if(!calibration_wizard_dwell(app, vp, w, gsr, false, gates[resistor_idx][0],
                                 gates[resistor_idx][1], &dwell, &first_raw)) {
        return CalMeasureCancelled;
    }

    if(cal_dwell_ok(&dwell)) {
        *out_avg_g = dwell.mean;
        *out_std_dev = cal_dwell_std(&dwell);
        return CalMeasureOk;
    } else {
        FURI_LOG_W("BioMap", "Cal measure %d failed: first_raw=%.1f in=%d below=%d above=%d gate=[%.0f, %.0f]",
                   resistor_idx, (double)first_raw, dwell.in_gate, dwell.below, dwell.above,
                   (double)gates[resistor_idx][0], (double)gates[resistor_idx][1]);
        return CalMeasureFailed;
    }
}

// Runs the open-circuit dwell (step 14): nothing connected, so the window
// mean count is the board's zero error alone — op-amp and ADC offset plus
// any leakage across the board. Averages gsr_sensor_get_mean_count(), the
// raw count before any zero is removed, over the same dwell as a resistor,
// with calibration off. A tick whose count is beyond ±CAL_ZERO_MAX_COUNTS
// counts as out of gate (something is still connected).
//
// *out_zero is always written — the in-gate mean on success, otherwise the
// mean of every tick — so the fail screen can show what was read. *out_std_ns
// is the in-gate σ converted to nS at the bottom of the range (counts ×
// gsr_tia_counts_to_ns(1)), so the same CAL_NOISE_* grades as a resistor
// apply. No bias check: the zero is a voltage in counts, which the bias
// doesn't scale. Same sound rules as calibration_wizard_measure().
static CalMeasureResult calibration_wizard_measure_zero(BioMapApp* app, ViewPort* vp,
                                                         WizardState* w, GsrSensor* gsr,
                                                         float* out_zero, float* out_std_ns) {
    gsr_sensor_set_calibration(gsr, false, 1.0f, 0.0f);

    // Flush (2 s, CAL_ZERO_FLUSH_TICKS): also lets autoranging climb from
    // the default PGA 2 to the most sensitive PGA 5, as an open circuit
    // reads near zero. Each step up needs 5 low ticks, so the climb takes
    // at least 1.5 s.
    for(int i = 0; i < CAL_ZERO_FLUSH_TICKS; i++) {
        furi_delay_ms(100);
        gsr_sensor_tick(gsr);
    }

    CalDwell dwell;
    if(!calibration_wizard_dwell(app, vp, w, gsr, true, -CAL_ZERO_MAX_COUNTS,
                                 CAL_ZERO_MAX_COUNTS, &dwell, NULL)) {
        return CalMeasureCancelled;
    }

    if(cal_dwell_ok(&dwell)) {
        *out_zero = dwell.mean;
        *out_std_ns = cal_dwell_std(&dwell) * gsr_tia_counts_to_ns(1.0f);
        return CalMeasureOk;
    }
    *out_zero = cal_dwell_mean_all(&dwell);
    *out_std_ns = 0.0f;
    FURI_LOG_W("BioMap", "Cal zero failed: mean=%.1f in=%d of %d (limit ±%.0f)",
               (double)*out_zero, dwell.in_gate, dwell.all, (double)CAL_ZERO_MAX_COUNTS);
    return CalMeasureFailed;
}

// calibration_wizard_compute_fit() moved to biomap_format.c (SDK-free,
// linked by tests/test_firmware.c instead of mirrored). Declared in
// biomap_format.h. WizardStep* enum lives in core/biomap_config.h.

// Mutex-guarded WizardState field writers — collapse the repeated
// acquire/write/release blocks below (w.mutex guards every field, see
// WizardState's doc comment in biomap.h).
static void wizard_set_step(WizardState* w, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->step = step;
    furi_mutex_release(w->mutex);
}

static void wizard_set_measurement(WizardState* w, int idx, float avg_g, float std_dev, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->measured[idx] = avg_g;
    w->noise_std_dev[idx] = std_dev;
    w->step = step;
    furi_mutex_release(w->mutex);
}

// Records which resistor triggered a measurement or noise-gate failure, for
// calibration_wizard_render()'s step 9/11 fail screens.
static void wizard_set_fail(WizardState* w, int idx, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->fail_idx = idx;
    w->step = step;
    furi_mutex_release(w->mutex);
}

static void wizard_set_zero(WizardState* w, float zero_counts, float noise_ns, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->zero_counts = zero_counts;
    w->zero_noise_ns = noise_ns;
    w->step = step;
    furi_mutex_release(w->mutex);
}

static void wizard_set_fit_result(WizardState* w, float gain, float r_squared, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->gain = gain;
    w->r_squared = r_squared;
    w->step = step;
    furi_mutex_release(w->mutex);
}

void run_calibration_wizard(BioMapApp* app) {
    WizardState w = {.step = WizardStepPromptZero};
    // Guards every field above against calibration_wizard_render() running
    // on the GUI thread — see WizardState's doc comment in biomap.h.
    // Allocated before vp_push() so the callback is never live with
    // mutex == NULL.
    w.mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(w.mutex, "WizardState: mutex alloc failed");
    ViewPort* vp = vp_push(app, calibration_wizard_render, &w);
    drain_stale_events(app->event_queue);
    BioMapEvent ev;
    
    // Allocate the GSR sensor once for all measurements.
    GsrSensor* gsr = gsr_sensor_alloc(NULL, NULL);
    bool sensor_ok = gsr && gsr_sensor_available(gsr);
    if(!sensor_ok) {
        if(gsr) gsr_sensor_free(gsr);
        gsr = NULL;
    }
    
    // Target nS values for the three calibration resistors.
    const float targets[CAL_POINTS] = { CAL_TARGET_470K, CAL_TARGET_100K, CAL_TARGET_47K };
    // Valid-range gates [lo, hi] for each resistor (nS).
    const float gates[CAL_POINTS][2] = {
        { CAL_LO_GATE,     CAL_MID_GATE_LO  },
        { CAL_MID_GATE_LO, CAL_MID_GATE_HI  },
        { CAL_LO_GATE_47K, CAL_HI_GATE      }
    };
    
    while(true) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;
            
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort)
            continue;

        // ── Back handler ──────────────────────────────────────────
        if(ev.input.key == InputKeyBack) {
            // Allowed to cancel from any prompt, success, or fail screen.
            // Back during an active Measuring dwell is handled inside
            // calibration_wizard_measure() itself (CalMeasureCancelled),
            // not here — by the time this loop reads its next event the
            // step has already moved past Measuring.
            bool cancelable = w.step == WizardStepPromptZero || w.step == WizardStepPrompt470k ||
                              w.step == WizardStepPrompt100k || w.step == WizardStepPrompt47k ||
                              w.step == WizardStepSuccess || w.step == WizardStepMeasureFailed ||
                              w.step == WizardStepFitFailed || w.step == WizardStepNoiseFailed ||
                              w.step == WizardStepBiasFailed || w.step == WizardStepZeroFailed;
            if(cancelable) {
                biomap_app_cue(app, BioMapCueBack);
                break;
            }
            continue;
        }

        // ── OK handler ────────────────────────────────────────────
        if(ev.input.key != InputKeyOk)
            continue;

        if(w.step == WizardStepSuccess) {
            biomap_app_cue(app, BioMapCueConfirm);
            biomap_save_calibration(app, w.gain, w.zero_counts, w.r_squared, w.noise_std_dev);
            break;
        }

        // Any failure restarts from the zero step: the resistor readings
        // depend on the zero, so a fresh run measures both together.
        if(w.step == WizardStepMeasureFailed || w.step == WizardStepFitFailed ||
           w.step == WizardStepNoiseFailed || w.step == WizardStepBiasFailed ||
           w.step == WizardStepZeroFailed) {
            biomap_app_cue(app, BioMapCueClick);
            wizard_set_step(&w, WizardStepPromptZero);
            view_port_update(vp);
            continue;
        }

        // ── Open-circuit zero step ────────────────────────────────
        // Same click-then-measure order as the resistor steps below (see
        // the GSR+Sound note there).
        if(w.step == WizardStepPromptZero) {
            biomap_app_cue(app, BioMapCueClick);
            wizard_set_step(&w, WizardStepMeasuringZero);
            view_port_update(vp);

            if(!sensor_ok) {
                wizard_set_fail(&w, 0, WizardStepMeasureFailed);
                biomap_app_cue(app, BioMapCueError);
                view_port_update(vp);
                continue;
            }

            float zero = 0.0f, zero_noise_ns = 0.0f;
            CalMeasureResult result = calibration_wizard_measure_zero(app, vp, &w, gsr,
                                                                       &zero, &zero_noise_ns);
            if(result == CalMeasureCancelled) {
                biomap_app_cue(app, BioMapCueBack);
                break;
            }
            bool zero_ok = result == CalMeasureOk &&
                           calibration_noise_grade(zero_noise_ns) != CalNoisePoor;
            wizard_set_zero(&w, zero, zero_noise_ns,
                            zero_ok ? WizardStepPrompt470k : WizardStepZeroFailed);
            if(zero_ok) {
                biomap_app_cue(app, BioMapCueConfirm);
            } else {
                biomap_app_cue(app, BioMapCueError);
            }
            view_port_update(vp);
            continue;
        }

        // Resistor prompts are spaced 2 apart (470k/100k/47k → 0/2/4), so
        // dividing recovers which resistor (0/1/2) directly.
        int idx = (w.step == WizardStepPrompt470k || w.step == WizardStepPrompt100k ||
                   w.step == WizardStepPrompt47k) ? w.step / 2 : -1;

        if(idx >= 0) {
            // ── Measurement step ──────────────────────────────────
            // This click plays BEFORE calibration_wizard_measure() is
            // called below — safe by a large margin because that function's
            // own 1 s ring-buffer flush runs before it takes any real
            // sample (see the GSR+Sound comment on calibration_wizard_
            // measure). Do not move this click, or add any other sound
            // call, to inside calibration_wizard_measure() or its dwell
            // loop — that would remove the flush's settle margin.
            biomap_app_cue(app, BioMapCueClick);
            wizard_set_step(&w, idx * 2 + 1);  // Prompt → Measuring
            view_port_update(vp);

            if(!sensor_ok) {
                wizard_set_fail(&w, idx, WizardStepMeasureFailed);
                biomap_app_cue(app, BioMapCueError);
                view_port_update(vp);
                continue;
            }

            // calibration_wizard_measure() has already returned — every
            // real sample for this resistor's dwell was taken before this
            // line runs, so the tones below cannot affect them.
            float avg_g = 0.0f, std_dev = 0.0f;
            CalMeasureResult result = calibration_wizard_measure(app, vp, &w, gsr, idx, gates,
                                                                  &avg_g, &std_dev);
            if(result == CalMeasureCancelled) {
                biomap_app_cue(app, BioMapCueBack);
                break;
            } else if(result == CalMeasureBiasFailed) {
                wizard_set_fail(&w, idx, WizardStepBiasFailed);
                biomap_app_cue(app, BioMapCueError);
                view_port_update(vp);
                continue;
            } else if(result == CalMeasureFailed) {
                wizard_set_fail(&w, idx, WizardStepMeasureFailed);
                biomap_app_cue(app, BioMapCueError);
                view_port_update(vp);
                continue;
            }

            // Gatekeeper: a resistor whose dwell was too noisy fails the
            // wizard outright rather than silently degrading the fit — see
            // CAL_NOISE_ACCEPTABLE_NS (biomap_config.h). Still records the
            // measurement so the fail screen can show the offending σ.
            if(calibration_noise_grade(std_dev) == CalNoisePoor) {
                wizard_set_measurement(&w, idx, avg_g, std_dev, idx * 2 + 2);
                wizard_set_fail(&w, idx, WizardStepNoiseFailed);
                biomap_app_cue(app, BioMapCueError);
                view_port_update(vp);
                continue;
            }

            wizard_set_measurement(&w, idx, avg_g, std_dev, idx * 2 + 2);  // Measuring → next Prompt (or FitPending)
            biomap_app_cue(app, BioMapCueConfirm); // this resistor's reading passed its gate and noise check

            // After the last measurement, compute the least-squares fit.
            // calibration_wizard_compute_fit() is pure arithmetic on the
            // already-collected w.measured[] values — no GSR/ADC access —
            // so the success/error tone below can never affect a reading.
            // w.step's own read here is this same (writer) thread's own
            // last write, so it needs no lock; only the fields published
            // below (read cross-thread by the render callback) do.
            if(w.step == WizardStepFitPending) {
                float gain, r_squared;
                bool fit_ok = calibration_wizard_compute_fit(w.measured, targets, &gain, &r_squared);
                wizard_set_fit_result(&w, gain, r_squared,
                                      fit_ok ? WizardStepSuccess : WizardStepFitFailed);
                if(fit_ok) {
                    biomap_app_cue(app, BioMapCueSuccess);
                } else {
                    // gain 1.0 with R² 0 means the fit had nothing to work
                    // with (a zero target or all readings near 0).
                    FURI_LOG_W("BioMap", "Calibration fit failed: gain=%.4f R²=%.4f",
                               (double)gain, (double)r_squared);
                    biomap_app_cue(app, BioMapCueError);
                }
            }
            view_port_update(vp);
        }
    }

    if(gsr) gsr_sensor_free(gsr);
    vp_pop(app, vp);
    furi_mutex_free(w.mutex);
}

