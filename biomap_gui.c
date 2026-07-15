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

// Push a new fullscreen ViewPort onto the GUI stack and return it.
// The caller owns the ViewPort until vp_pop().
static ViewPort* vp_push(BioMapApp* app, ViewPortDrawCallback draw, void* ctx) {
    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, draw, ctx);
    view_port_input_callback_set(vp, biomap_input_callback, app->event_queue);
    gui_add_view_port(app->gui, vp, GuiLayerFullscreen);
    view_port_update(vp);
    return vp;
}

// Remove a ViewPort from the GUI stack and free it.
static void vp_pop(BioMapApp* app, ViewPort* vp) {
    gui_remove_view_port(app->gui, vp);
    view_port_free(vp);
}

// Drain any stale events from the queue before starting a sub-screen loop.
static void drain_stale_events(FuriMessageQueue* q) {
    PluginEvent ev;
    while(furi_message_queue_get(q, &ev, 0) == FuriStatusOk);
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
    view_port_draw_callback_set(app->menu_vp, menu_render, &ctx);

    // Enable menu VP so it receives input and renders
    view_port_enabled_set(app->menu_vp, true);
    view_port_update(app->menu_vp);

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
            if(ctx.selection > 0) ctx.selection--;
            furi_mutex_release(app->mutex);
            view_port_update(app->menu_vp);
            break;
        case InputKeyDown:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(ctx.selection < MENU_COUNT - 1) ctx.selection++;
            furi_mutex_release(app->mutex);
            view_port_update(app->menu_vp);
            break;
        case InputKeyOk:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            result = ctx.selection;
            furi_mutex_release(app->mutex);
            running = false;
            break;
        case InputKeyBack:
            result = -1;
            running = false;
            break;
        default: break;
        }
    }

    // Disable menu VP so it stops receiving input while sub-screen runs.
    // The VP stays in the GUI stack (no flash of desktop) but passes
    // input through to any VP layered on top.
    view_port_enabled_set(app->menu_vp, false);
    view_port_draw_callback_set(app->menu_vp, NULL, NULL);
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
            if(ev.input.key == InputKeyBack) break;

            switch(ev.input.key) {
            case InputKeyUp:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                if(ctx.selection > 0) ctx.selection--;
                furi_mutex_release(app->mutex);
                break;
            case InputKeyDown:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                if(ctx.selection < OPTIONS_COUNT - 1) ctx.selection++;
                furi_mutex_release(app->mutex);
                break;
            case InputKeyOk:
                switch(ctx.selection) {
                case 0:
                    // Reset GPS — VP stays visible, no need to re-create
                    run_gps_hot_start(app);
                    view_port_update(vp);
                    continue;
                case 1:
                    // Toggle auto-zoom (session_init handles level/peak reset)
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom_enabled = !app->zoom_enabled;
                    furi_mutex_release(app->mutex);
                    break;
                case 2:
                    // Toggle backlight
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->backlight_on = !app->backlight_on;
                    furi_mutex_release(app->mutex);
                    break;
                case 3:
                    // GSR Calibration
                    run_calibration_menu(app);
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

void run_calibration_menu(BioMapApp* app) {
    int selection = 0;
    ViewPort* vp = vp_push(app, calibration_menu_render, &selection);
    drain_stale_events(app->event_queue);
    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) break;
            if(ev.input.key == InputKeyUp) {
                if(selection > 0) selection--;
            } else if(ev.input.key == InputKeyDown) {
                if(selection < 1) selection++;
            } else if(ev.input.key == InputKeyOk) {
                if(selection == 0) {
                    run_calibration_wizard(app);
                    break;
                } else {
                    biomap_reset_calibration(app);
                    break;
                }
            }
            view_port_update(vp);
        }
    }
    vp_pop(app, vp);
}

static bool calibration_wizard_measure(GsrSensor* gsr, int resistor_idx, const float gates[CAL_POINTS][2], float* out_avg_g) {
    // Ensure calibration is disabled on this wizard-local sensor so measurements are raw nS
    gsr_sensor_set_calibration(gsr, false, 1.0f, 0.0f);

    // Flush the ring buffer (1 s, 10 ticks)
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
        return false; // degenerate fit
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

    // Validate bounds (nS domain) and linearity (R² ≥ 0.95)
    if(gain >= 0.2f && gain <= 5.0f &&
       offset >= -20000.0f && offset <= 20000.0f &&
       r_squared >= 0.95f) {
        *out_gain = gain;
        *out_offset = offset;
        *out_r_squared = r_squared;
        return true;
    } else {
        FURI_LOG_W("BioMap", "Calibration out of bounds: gain=%.4f off=%.1f R²=%.4f",
                   (double)gain, (double)offset, (double)r_squared);
        return false;
    }
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
            if(w.step == 0 || w.step == 2 || w.step == 4 || w.step == 8 || w.step == 9 || w.step == 10)
                break;
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
            biomap_save_calibration(app, w.gain, w.offset);
            break;
        }

        if(w.step == 9 || w.step == 10) {
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
            w.step = (int)(idx * 2 + 1);  // 0→1, 2→3, 4→5
            view_port_update(vp);

            if(!sensor_ok) {
                w.step = 9;
                view_port_update(vp);
                continue;
            }

            float avg_g = 0.0f;
            if(calibration_wizard_measure(gsr, idx, gates, &avg_g)) {
                w.measured[idx] = avg_g;
                w.step = (int)(idx * 2 + 2);  // 1→2, 3→4, 5→6
            } else {
                w.step = 9;
            }

            // After the last measurement, compute the least-squares fit.
            if(w.step == 6) {
                if(calibration_wizard_compute_fit(w.measured, targets, &w.gain, &w.offset, &w.r_squared)) {
                    w.step = 8;  // success
                } else {
                    w.step = 10; // fit failure
                }
            }
            view_port_update(vp);
        }
    }

    if(gsr) gsr_sensor_free(gsr);
    vp_pop(app, vp);
}



