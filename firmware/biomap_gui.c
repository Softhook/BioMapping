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
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

void biomap_timer_callback(void* ctx) {
    PluginEvent ev = {.type = EventTypeTick};
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
    PluginEvent ev;
    while(furi_message_queue_get(q, &ev, 0) == FuriStatusOk);
}

// Move a list selection by one step with wraparound: Up on the first item
// jumps to the last, Down on the last item jumps back to the first — used
// by the main menu, Options screen, and GSR Calibration submenu so all
// three list screens navigate the same way.
int32_t cycle_selection(int32_t sel, int32_t count, bool down) {
    if(down) {
        return (sel + 1 >= count) ? 0 : sel + 1;
    } else {
        return (sel - 1 < 0) ? count - 1 : sel - 1;
    }
}

// Cycle *selection under app->mutex (the render callback reads it from
// another thread) and play the nav click — shared Up/Down handling for the
// main menu, Options screen, and GSR/RF calibration submenu.
static void nav_cycle(BioMapApp* app, int32_t* selection, int32_t count, bool down) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    *selection = cycle_selection(*selection, count, down);
    furi_mutex_release(app->mutex);
    biomap_sound_click(app->sound_enabled);
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

    PluginEvent ev;
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
            biomap_sound_confirm(app->sound_enabled);
            running = false;
            break;
        case InputKeyBack:
            result = -1;
            biomap_sound_back(app->sound_enabled);
            running = false;
            break;
        default: break;
        }
    }

    vp_pop(app, vp);
    return result;
}

// ==========================================================================
// Options screen — Reset GPS, Auto-zoom toggle
// ==========================================================================
//
//  ┌─────────────────────────────┐
//  │  Options                    │
//  │  ▓ Reset GPS           ▓   │   ← selected
//  │    Auto-zoom GSR   ON      │
//  │    Backlight           ON  │
//  │    GSR Calibration    YES  │
//  │    Diagnostics              │
//  └─────────────────────────────┘
//
//  Controls:  Up/Down → navigate     OK → select/toggle     Back → return

// Toggle a bool app setting (Auto-zoom, Backlight, Sound), persist it, and
// play a distinct on/off confirmation tone — shared by cases 2/5/6 below,
// previously identical except which field. force_tone bypasses the
// `sound_enabled` gate: used only by the Sound toggle itself, so
// muting/unmuting is always audible regardless of the new state.
static void toggle_app_setting(BioMapApp* app, bool* field, bool force_tone) {
    furi_mutex_acquire(app->mutex, FuriWaitForever);
    *field = !*field;
    bool new_val = *field;
    furi_mutex_release(app->mutex);
    biomap_save_settings(app);
    biomap_sound_toggle(force_tone ? true : app->sound_enabled, new_val);
}

void run_options_screen(BioMapApp* app) {
    OptionsContext ctx = {.app = app, .selection = 0};
    ViewPort* vp = vp_push(app, options_render, &ctx);

    drain_stale_events(app->event_queue);
    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) {
                biomap_sound_back(app->sound_enabled);
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
                    biomap_sound_click(app->sound_enabled);
                    break;
                case OptResetGps:
                    // Reset GPS — VP stays visible, no need to re-create.
                    // run_gps_hot_start() plays its own success/error tone.
                    run_gps_hot_start(app);
                    view_port_update(vp);
                    continue;
                case OptAutoZoom:
                    // Toggle auto-zoom (session_init handles level/peak reset)
                    toggle_app_setting(app, &app->zoom_enabled, false);
                    break;
                case OptGsrCalibration:
                    biomap_sound_confirm(app->sound_enabled);
                    run_calibration_menu(app);
                    vp_push(app, options_render, &ctx);
                    continue;
                case OptRfCalibration:
                    // Re-arm-after-return pattern, same as GSR Calibration
                    biomap_sound_confirm(app->sound_enabled);
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
                    biomap_sound_confirm(app->sound_enabled);
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
    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) {
                biomap_sound_back(app->sound_enabled);
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
                    biomap_sound_confirm(app->sound_enabled);
                    start_wizard(app);
                    break;
                } else if(ctx.selection == CalSubmenuReset) {
                    biomap_sound_reset(app->sound_enabled);
                    reset(app);
                    break;
                } else {
                    biomap_sound_confirm(app->sound_enabled);
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
// must never call into modules/sound.h, and the caller (run_calibration_
// wizard) must never call it either during the 20-sample loop below. The
// caller's one pre-measurement tone (a ~35 ms click, played right before
// this function is entered) is made safe by the very next thing this
// function does: a full 1 s / 10-tick buffer flush, whose discarded
// readings absorb any tone-era ADC samples ~30x over (the GSR ring buffer
// is only ~128 ms deep — see GSR_TONE_SETTLE_MS in biomap_session.c for
// the equivalent, tighter-margin calculation used for recording start).
// The caller's post-measurement tones (confirm/error/success) are safe by
// construction: they only ever play after this function has already
// returned with its result, i.e. after all 20 real samples were taken.
static bool calibration_wizard_measure(GsrSensor* gsr, int resistor_idx, const float gates[CAL_POINTS][2], float* out_avg_g) {
    // Ensure calibration is disabled on this wizard-local sensor so measurements are raw nS
    gsr_sensor_set_calibration(gsr, false, 1.0f, 0.0f);

    // Flush the ring buffer (1 s, 10 ticks). Also the GSR+Sound settle
    // window for the caller's pre-measurement click — see this function's
    // header comment. Every reading here is intentionally discarded.
    for(int i = 0; i < 10; i++) {
        furi_delay_ms(100);
        gsr_sensor_tick(gsr);
    }

    enum { CAL_SAMPLES = 20, CAL_MIN_VALID = 12 };
    float samples[CAL_SAMPLES];
    int total = 0;
    float first_raw = 0;
    int below = 0, above = 0;

    for(int i = 0; i < CAL_SAMPLES; i++) {
        furi_delay_ms(100);
        gsr_sensor_tick(gsr);
        float g = gsr_sensor_get_raw(gsr);
        if(i == 0) first_raw = g;
        if(g >= gates[resistor_idx][0] && g <= gates[resistor_idx][1]) {
            samples[total++] = g;
        } else if(g < gates[resistor_idx][0]) {
            below++;
        } else {
            above++;
        }
    }

    if(total >= CAL_MIN_VALID) {
        // Single-pass min/max + sum for trimmed mean
        float s_min = samples[0], s_max = samples[0];
        float sum_g = 0;
        for(int i = 0; i < total; i++) {
            float s = samples[i];
            sum_g += s;
            if(s < s_min) s_min = s;
            if(s > s_max) s_max = s;
        }
        *out_avg_g = (sum_g - s_min - s_max) / (float)(total - 2);
        return true;
    } else {
        FURI_LOG_W("BioMap", "Cal measure %d failed: first_raw=%.1f in=%d below=%d above=%d gate=[%.0f, %.0f]",
                   resistor_idx, (double)first_raw, total, below, above,
                   (double)gates[resistor_idx][0], (double)gates[resistor_idx][1]);
        return false;
    }
}

// Computes the fit and ALWAYS writes *out_gain / *out_offset / *out_r_squared,
// even when validation fails — the fit-fail screen (calibration_wizard_render,
// step 10) displays these values so the user can see how far out of range
// their device is, rather than a fixed 0.000x placeholder. The return value
// is the sole validity signal; callers must not treat a false return as
// "outputs are undefined".
static bool calibration_wizard_compute_fit(const float measured[CAL_POINTS], const float targets[CAL_POINTS], float* out_gain, float* out_offset, float* out_r_squared) {
    // Three-point linear least-squares:  y = gain * x + offset
    // Σx, Σy, Σxx, Σxy  where x = measured, y = target
    float sx = 0, sy = 0, sxx = 0, sxy = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float xi = measured[i];
        float yi = targets[i];
        sx  += xi;
        sy  += yi;
        sxx += xi * xi;
        sxy += xi * yi;
    }
    float n     = (float)CAL_POINTS;
    float denom = n * sxx - sx * sx;
    if(denom <= 1e-9f) {
        // Degenerate fit (measurements collinear/identical) — no meaningful
        // gain/offset/R² exist. Report neutral defaults rather than leaving
        // the caller's variables untouched.
        *out_gain = 1.0f;
        *out_offset = 0.0f;
        *out_r_squared = 0.0f;
        FURI_LOG_W("BioMap", "Calibration fit degenerate (measurements not distinct)");
        return false;
    }

    float gain   = (n * sxy - sx * sy) / denom;
    float offset = (sy - gain * sx) / n;

    // R² goodness-of-fit
    float y_mean = sy / n;
    float ss_res = 0, ss_tot = 0;
    for(int i = 0; i < CAL_POINTS; i++) {
        float yi     = targets[i];
        float y_pred = gain * measured[i] + offset;
        float res    = yi - y_pred;
        ss_res += res * res;
        float dev    = yi - y_mean;
        ss_tot += dev * dev;
    }
    float r_squared = (ss_tot > 1e-9f) ? (1.0f - ss_res / ss_tot) : 1.0f;

    // Always publish the computed fit so the caller (and the fit-fail
    // screen) can show the user what was actually measured.
    *out_gain = gain;
    *out_offset = offset;
    *out_r_squared = r_squared;

    // Validate bounds (nS domain) and linearity (R² ≥ 0.95)
    bool ok = gain >= CAL_GAIN_MIN && gain <= CAL_GAIN_MAX &&
              offset >= CAL_OFFSET_MIN && offset <= CAL_OFFSET_MAX &&
              r_squared >= 0.95f;
    if(!ok) {
        FURI_LOG_W("BioMap", "Calibration out of bounds: gain=%.4f off=%.1f R²=%.4f",
                   (double)gain, (double)offset, (double)r_squared);
    }
    return ok;
}

// Wizard step values — mirrors the numeric cases calibration_wizard_render()
// (biomap_render.c) switches on; keep both in sync if steps change. 6 and 7
// are transient/unused as UI-visible states (6 is decided-but-not-yet-drawn
// fit-pending, checked only internally below).
enum {
    WizardStepPrompt470k    = 0,
    WizardStepMeasuring470k = 1,
    WizardStepPrompt100k    = 2,
    WizardStepMeasuring100k = 3,
    WizardStepPrompt47k     = 4,
    WizardStepMeasuring47k  = 5,
    WizardStepFitPending    = 6,
    WizardStepSuccess       = 8,
    WizardStepMeasureFailed = 9,
    WizardStepFitFailed     = 10,
};

// Mutex-guarded WizardState field writers — collapse the repeated
// acquire/write/release blocks below (w.mutex guards every field, see
// WizardState's doc comment in biomap.h).
static void wizard_set_step(WizardState* w, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->step = step;
    furi_mutex_release(w->mutex);
}

static void wizard_set_measurement(WizardState* w, int idx, float avg_g, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->measured[idx] = avg_g;
    w->step = step;
    furi_mutex_release(w->mutex);
}

static void wizard_set_fit_result(WizardState* w, float gain, float offset,
                                   float r_squared, int step) {
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    w->gain = gain;
    w->offset = offset;
    w->r_squared = r_squared;
    w->step = step;
    furi_mutex_release(w->mutex);
}

void run_calibration_wizard(BioMapApp* app) {
    WizardState w = {.step = WizardStepPrompt470k};
    // Guards every field above against calibration_wizard_render() running
    // on the GUI thread — see WizardState's doc comment in biomap.h.
    // Allocated before vp_push() so the callback is never live with
    // mutex == NULL.
    w.mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    furi_check(w.mutex, "WizardState: mutex alloc failed");
    ViewPort* vp = vp_push(app, calibration_wizard_render, &w);
    drain_stale_events(app->event_queue);
    PluginEvent ev;
    
    // Allocate the GSR sensor once for all measurements.
    GsrSensor* gsr = gsr_sensor_alloc();
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
            bool cancelable = w.step == WizardStepPrompt470k || w.step == WizardStepPrompt100k ||
                              w.step == WizardStepPrompt47k || w.step == WizardStepSuccess ||
                              w.step == WizardStepMeasureFailed || w.step == WizardStepFitFailed;
            if(cancelable) {
                biomap_sound_back(app->sound_enabled);
                break;
            }
            continue;
        }

        // ── OK handler ────────────────────────────────────────────
        if(ev.input.key != InputKeyOk)
            continue;

        if(w.step == WizardStepSuccess) {
            biomap_sound_confirm(app->sound_enabled);
            biomap_save_calibration(app, w.gain, w.offset);
            break;
        }

        if(w.step == WizardStepMeasureFailed || w.step == WizardStepFitFailed) {
            biomap_sound_click(app->sound_enabled);
            wizard_set_step(&w, WizardStepPrompt470k);
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
            // call, to inside calibration_wizard_measure() or its 20-sample
            // loop — that would remove the flush's settle margin.
            biomap_sound_click(app->sound_enabled);
            wizard_set_step(&w, idx * 2 + 1);  // Prompt → Measuring
            view_port_update(vp);

            if(!sensor_ok) {
                wizard_set_step(&w, WizardStepMeasureFailed);
                biomap_sound_error(app->sound_enabled);
                view_port_update(vp);
                continue;
            }

            // calibration_wizard_measure() has already returned — all 20
            // real samples for this resistor were taken before this line
            // runs, so the confirm/error tone below cannot affect them.
            float avg_g = 0.0f;
            if(calibration_wizard_measure(gsr, idx, gates, &avg_g)) {
                wizard_set_measurement(&w, idx, avg_g, idx * 2 + 2);  // Measuring → next Prompt (or FitPending)
                biomap_sound_confirm(app->sound_enabled); // this resistor's reading passed its gate
            } else {
                wizard_set_step(&w, WizardStepMeasureFailed);
                biomap_sound_error(app->sound_enabled);
            }

            // After the last measurement, compute the least-squares fit.
            // calibration_wizard_compute_fit() is pure arithmetic on the
            // already-collected w.measured[] values — no GSR/ADC access —
            // so the success/error tone below can never affect a reading.
            // w.step's own read here is this same (writer) thread's own
            // last write, so it needs no lock; only the fields published
            // below (read cross-thread by the render callback) do.
            if(w.step == WizardStepFitPending) {
                float gain, offset, r_squared;
                bool fit_ok = calibration_wizard_compute_fit(w.measured, targets, &gain, &offset, &r_squared);
                wizard_set_fit_result(&w, gain, offset, r_squared,
                                      fit_ok ? WizardStepSuccess : WizardStepFitFailed);
                if(fit_ok) {
                    biomap_sound_success(app->sound_enabled);
                } else {
                    biomap_sound_error(app->sound_enabled);
                }
            }
            view_port_update(vp);
        }
    }

    if(gsr) gsr_sensor_free(gsr);
    vp_pop(app, vp);
    furi_mutex_free(w.mutex);
}

