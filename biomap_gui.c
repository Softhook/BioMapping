// Bio Mapping — GUI: input/timer callbacks, menus, options, converter flow.
//
// Render callbacks (draw_graph, biomap_render_callback, menu_render,
// options_render, conv_progress_render, conv_status_render) live in
// biomap_render.c for separation of presentation from control flow.
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
static ViewPort* vp_push(BioMapApp* app, ViewPortDrawCallback draw, void* ctx) {
    ViewPort* vp = app->screen_vp;
    view_port_draw_callback_set(vp, draw, ctx);
    view_port_enabled_set(vp, true);
    view_port_update(vp);
    return vp;
}

// "Pop" a screen: disable the shared ViewPort and clear its draw callback.
// It stays in the GUI stack — never removed/freed here.
static void vp_pop(BioMapApp* app, ViewPort* vp) {
    UNUSED(vp);
    view_port_enabled_set(app->screen_vp, false);
    view_port_draw_callback_set(app->screen_vp, NULL, NULL);
}

// Drain any stale events from the queue before starting a sub-screen loop.
static void drain_stale_events(FuriMessageQueue* q) {
    PluginEvent ev;
    while(furi_message_queue_get(q, &ev, 0) == FuriStatusOk);
}

// Move a list selection by one step with wraparound: Up on the first item
// jumps to the last, Down on the last item jumps back to the first — used
// by the main menu, Options screen, and GSR Calibration submenu so all
// three list screens navigate the same way.
static int32_t cycle_selection(int32_t sel, int32_t count, bool down) {
    if(down) {
        return (sel + 1 >= count) ? 0 : sel + 1;
    } else {
        return (sel - 1 < 0) ? count - 1 : sel - 1;
    }
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
//  │                             │
//  └─────────────────────────────┘
//
//  Controls:  Up/Down → navigate     OK → select     Back → exit app

int32_t biomap_gui_show_menu(BioMapApp* app) {
    MenuContext ctx = {.app = app, .selection = 0};
    view_port_draw_callback_set(app->screen_vp, menu_render, &ctx);

    // Enable the shared screen VP so it receives input and renders
    view_port_enabled_set(app->screen_vp, true);
    view_port_update(app->screen_vp);

    PluginEvent ev;
    int32_t result = -1;
    bool running = true;
    while(running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort) continue;

        switch(ev.input.key) {
        case InputKeyUp:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            ctx.selection = cycle_selection(ctx.selection, MENU_COUNT, false);
            furi_mutex_release(app->mutex);
            biomap_sound_click(app->sound_enabled);
            view_port_update(app->screen_vp);
            break;
        case InputKeyDown:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            ctx.selection = cycle_selection(ctx.selection, MENU_COUNT, true);
            furi_mutex_release(app->mutex);
            biomap_sound_click(app->sound_enabled);
            view_port_update(app->screen_vp);
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

    // Disable the shared screen VP so it stops receiving input/rendering
    // while the caller sets up the next sub-screen (which re-enables the
    // same ViewPort via vp_push — see biomap_gui.c comment above).
    view_port_enabled_set(app->screen_vp, false);
    view_port_draw_callback_set(app->screen_vp, NULL, NULL);
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
//  │                             │
//  │    Press Back to return     │
//  └─────────────────────────────┘
//
//  Controls:  Up/Down → navigate     OK → select/toggle     Back → return

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
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                ctx.selection = cycle_selection(ctx.selection, OPTIONS_COUNT, false);
                furi_mutex_release(app->mutex);
                biomap_sound_click(app->sound_enabled);
                break;
            case InputKeyDown:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                ctx.selection = cycle_selection(ctx.selection, OPTIONS_COUNT, true);
                furi_mutex_release(app->mutex);
                biomap_sound_click(app->sound_enabled);
                break;
            case InputKeyOk:
                switch(ctx.selection) {
                case 0:
                    // Reset GPS — VP stays visible, no need to re-create.
                    // run_gps_hot_start() plays its own success/error tone.
                    run_gps_hot_start(app);
                    view_port_update(vp);
                    continue;
                case 1:
                    // Toggle auto-zoom (session_init handles level/peak reset)
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_enabled = !app->zoom_enabled;
                    furi_mutex_release(app->mutex);
                    biomap_sound_toggle(app->sound_enabled, app->zoom_enabled);
                    break;
                case 2:
                    // Toggle backlight
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->backlight_on = !app->backlight_on;
                    furi_mutex_release(app->mutex);
                    biomap_sound_toggle(app->sound_enabled, app->backlight_on);
                    break;
                case 3:
                    // GSR Calibration
                    biomap_sound_confirm(app->sound_enabled);
                    run_calibration_menu(app);
                    // run_calibration_menu() (and the wizard it can open)
                    // pops the shared screen ViewPort on every exit path,
                    // leaving it disabled with no draw callback. This loop
                    // keeps running afterward, so re-arm it for the Options
                    // screen — otherwise the display is left blank/frozen
                    // (looks like a hang) until Back is pressed enough
                    // times to escape all the way out to the main menu.
                    vp_push(app, options_render, &ctx);
                    break;
                case 4:
                    // Toggle sound itself — always play the confirming click
                    // (bypass the `enabled` gate) so muting/unmuting is
                    // always audible right at the moment it changes, even
                    // when turning sound OFF.
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->sound_enabled = !app->sound_enabled;
                    furi_mutex_release(app->mutex);
                    biomap_sound_toggle(true, app->sound_enabled);
                    break;
                case 5:
                    // Cycle GPS Profile (PED -> WRIST -> VEHICLE -> STATIONARY -> SEA -> BIKE -> FLIGHT)
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->nav_model = (app->nav_model + 1) % 7;
                    furi_mutex_release(app->mutex);
                    biomap_sound_click(app->sound_enabled);
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

static void run_show_current_calibration(BioMapApp* app) {
    ViewPort* vp = vp_push(app, show_current_calibration_render, app);
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

void run_calibration_menu(BioMapApp* app) {
    int selection = 0;
    ViewPort* vp = vp_push(app, calibration_menu_render, &selection);
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
                    run_calibration_wizard(app);
                    break;
                } else if(selection == 1) {
                    biomap_sound_reset(app->sound_enabled);
                    biomap_reset_calibration(app);
                    break;
                } else {
                    biomap_sound_confirm(app->sound_enabled);
                    run_show_current_calibration(app);
                    vp_push(app, calibration_menu_render, &selection);
                }
            }
            view_port_update(vp);
        }
    }
    vp_pop(app, vp);
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

    #define CAL_SAMPLES      20
    #define CAL_MIN_VALID    12
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
        #undef CAL_SAMPLES
        #undef CAL_MIN_VALID
        return true;
    } else {
        FURI_LOG_W("BioMap", "Cal measure %d failed: first_raw=%.1f in=%d below=%d above=%d gate=[%.0f, %.0f]",
                   resistor_idx, (double)first_raw, total, below, above,
                   (double)gates[resistor_idx][0], (double)gates[resistor_idx][1]);
        #undef CAL_SAMPLES
        #undef CAL_MIN_VALID
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
    bool ok = gain >= 0.2f && gain <= 5.0f &&
              offset >= -20000.0f && offset <= 20000.0f &&
              r_squared >= 0.95f;
    if(!ok) {
        FURI_LOG_W("BioMap", "Calibration out of bounds: gain=%.4f off=%.1f R²=%.4f",
                   (double)gain, (double)offset, (double)r_squared);
    }
    return ok;
}

void run_calibration_wizard(BioMapApp* app) {
    WizardState w = {.step = 0};
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
            if(w.step == 0 || w.step == 2 || w.step == 4 || w.step == 8 || w.step == 9 || w.step == 10) {
                biomap_sound_back(app->sound_enabled);
                break;
            }
            continue;
        }

        // ── OK handler ────────────────────────────────────────────
        if(ev.input.key != InputKeyOk)
            continue;

        // step 0,2,4 = resistor prompts  → start measurement
        // step 8     = success            → save & exit
        // step 9     = measurement fail   → retry (go back to step 0)
        // step 10    = fit fail           → retry (go back to step 0)

        if(w.step == 8) {
            biomap_sound_confirm(app->sound_enabled);
            biomap_save_calibration(app, w.gain, w.offset);
            break;
        }

        if(w.step == 9 || w.step == 10) {
            biomap_sound_click(app->sound_enabled);
            w.step = 0;
            view_port_update(vp);
            continue;
        }

        // Determine which resistor to measure (0=470k, 1=100k, 2=47k).
        int idx = -1;
        if(w.step == 0)      idx = 0;
        else if(w.step == 2) idx = 1;
        else if(w.step == 4) idx = 2;

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
            w.step = (int)(idx * 2 + 1);  // 0→1, 2→3, 4→5
            view_port_update(vp);

            if(!sensor_ok) {
                w.step = 9;
                biomap_sound_error(app->sound_enabled);
                view_port_update(vp);
                continue;
            }

            // calibration_wizard_measure() has already returned — all 20
            // real samples for this resistor were taken before this line
            // runs, so the confirm/error tone below cannot affect them.
            float avg_g = 0.0f;
            if(calibration_wizard_measure(gsr, idx, gates, &avg_g)) {
                w.measured[idx] = avg_g;
                w.step = (int)(idx * 2 + 2);  // 1→2, 3→4, 5→6
                biomap_sound_confirm(app->sound_enabled); // this resistor's reading passed its gate
            } else {
                w.step = 9;
                biomap_sound_error(app->sound_enabled);
            }

            // After the last measurement, compute the least-squares fit.
            // calibration_wizard_compute_fit() is pure arithmetic on the
            // already-collected w.measured[] values — no GSR/ADC access —
            // so the success/error tone below can never affect a reading.
            if(w.step == 6) {
                if(calibration_wizard_compute_fit(w.measured, targets, &w.gain, &w.offset, &w.r_squared)) {
                    w.step = 8;  // success
                    biomap_sound_success(app->sound_enabled);
                } else {
                    w.step = 10; // fit failure
                    biomap_sound_error(app->sound_enabled);
                }
            }
            view_port_update(vp);
        }
    }

    if(gsr) gsr_sensor_free(gsr);
    vp_pop(app, vp);
}



