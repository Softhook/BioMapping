// Bio Mapping — the menu, Options and calibration screens. The recording
// screen is shared: core/biomap_screen.c, drawn on the Flipper by
// flipper/biomap_screen_flipper.c.
#include "biomap.h"

#include <stdarg.h>

// ── Label arrays for menu and options screens ──────────────────────────────

static const char* const menu_labels[MenuCount] = {
    "GPS + GSR + RF", "GPS + GSR", "GPS + RF", "GSR Only", "Live Stream", "Options",
};

static const char* const options_labels[OptCount] = {
    "GPS Profile",
    "Super-S",
    "Cold Reset GPS",
    "Auto-zoom GSR",
    "GSR Calibration",
    "RF Calibration",
    "Backlight",
    "Sound",
    "Diagnostics",
    "Debug Fields",
};

// ── Rendering helpers ──────────────────────────────────────────────────────

static void draw_screen_header(Canvas* c, const char* title) {
    canvas_clear(c);
    canvas_set_font(c, FontPrimary);
    canvas_draw_str(c, 0, 10, title);
    canvas_set_font(c, FontSecondary);
}

// Format + draw at (x, y) in one call, returning y + 10 for the next line.
// Replaces the repetitive snprintf + canvas_draw_str + y += 10 triplet
// across the calibration screens.
// buf is intentionally capped at 48 bytes — FontSecondary (haxrcorp 4089)
// glyphs are 3–6 px wide, about 25–30 per line on the 128 px display, so
// 48 chars is a safe ceiling per line.
__attribute__((format(printf, 4, 5)))
static int draw_fmt(Canvas* c, int x, int y, const char* fmt, ...) {
    char buf[48];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    canvas_draw_str(c, x, y, buf);
    return y + 10;
}

// ==========================================================================
// Menu & options rendering
// ==========================================================================

static void draw_selection_list(Canvas* c, int sel, int count,
                         const char* const* labels, int start_y, int max_visible) {
    int top = scroll_window_top(sel, count, max_visible);
    for(int i = top; i < count && (i - top) < max_visible; i++) {
        int y = start_y + (i - top) * 10;
        if(i == sel) {
            canvas_draw_box(c, 0, y - 8, SCREEN_W, 9);
            canvas_invert_color(c);
            canvas_draw_str(c, 0, y, ">");
            canvas_draw_str(c, 8, y, labels[i]);
            canvas_invert_color(c);
        } else {
            canvas_draw_str(c, 8, y, labels[i]);
        }
    }
}

void menu_render(Canvas* c, void* ctx) {
    ListContext* m_ctx = (ListContext*)ctx;
    BioMapApp* a = m_ctx->app;
    if(furi_mutex_acquire(a->mutex, 10) != FuriStatusOk) return;
    draw_screen_header(c, "Bio Mapping");
    draw_selection_list(c, (int)m_ctx->selection, MenuCount, menu_labels, 22, 5);
    furi_mutex_release(a->mutex);
}

void options_render(Canvas* c, void* ctx) {
    ListContext* o_ctx = (ListContext*)ctx;
    BioMapApp* a = o_ctx->app;
    if(furi_mutex_acquire(a->mutex, 10) != FuriStatusOk) return;
    draw_screen_header(c, "Options");
    int sel = (int)o_ctx->selection;

    int max_visible = 5;
    int top = scroll_window_top(sel, OptCount, max_visible);

    draw_selection_list(c, sel, OptCount, options_labels, 22, max_visible);

    // Overlay toggle state on selectable items
    for(int i = top; i < OptCount && (i - top) < max_visible; i++) {
        if(i == OptColdResetGps || i == OptDiagnostics) continue; // no right-aligned state text
        int y = 22 + (i - top) * 10;
        const char* state;
        if(i == OptGpsProfile) {
            state = biomap_nav_model_label(a->nav_model);
        } else if(i == OptSuperS) {
            state = a->super_s ? "AUTO" : "OFF";
        } else if(i == OptAutoZoom) {
            state = a->zoom_enabled ? "ON" : "OFF";
        } else if(i == OptGsrCalibration) {
            state = a->cal_active ? "YES" : "NO";
        } else if(i == OptRfCalibration) {
            state = a->rf_calibrated ? "YES" : "NO";
        } else if(i == OptBacklight) {
            state = a->backlight_on ? "ON" : "OFF";
        } else if(i == OptSound) {
            state = a->sound_enabled ? "ON" : "OFF";
        } else if(i == OptDebugFields) {
            state = a->debug_fields_enabled ? "ON" : "OFF";
        } else {
            continue;
        }
        int sx = SCREEN_W - canvas_string_width(c, state) - 2;
        if(i == sel) canvas_invert_color(c);
        canvas_draw_str(c, sx, y, state);
        if(i == sel) canvas_invert_color(c);
    }
    furi_mutex_release(a->mutex);
}

// Shared render body for the GSR and RF calibration menus (run_cal_submenu,
// biomap_gui.c) — same "Start Wizard / Reset to Default / Show Current"
// 3-item list, differing only in the title.
//
// ctx is a ListContext* (biomap.h) — guarded by app->mutex against
// run_cal_submenu()'s key-handling loop, same as menu_render/options_render.
static void draw_cal_submenu(Canvas* c, void* ctx, const char* title) {
    static const char* const options[CalSubmenuCount] = {
        "Start Wizard", "Reset to Default", "Show Current",
    };
    ListContext* sm = (ListContext*)ctx;
    if(furi_mutex_acquire(sm->app->mutex, 10) != FuriStatusOk) return;
    int sel = (int)sm->selection;
    draw_screen_header(c, title);

    for(int i = 0; i < CalSubmenuCount; i++) {
        int y = 25 + i * 12;
        if(i == sel) canvas_draw_str(c, 0, y, ">");
        canvas_draw_str(c, 10, y, options[i]);
    }
    furi_mutex_release(sm->app->mutex);
}

void calibration_menu_render(Canvas* c, void* ctx) {
    draw_cal_submenu(c, ctx, "GSR Calibration");
}

void calibration_wizard_render(Canvas* c, void* ctx) {
    WizardState* w = (WizardState*)ctx;

    // Guards against run_calibration_wizard()'s measurement loop (main
    // thread), which updates w->core as each step is measured —
    // see WizardState's doc comment in biomap.h.
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    int step = w->core.step;
    float gain = w->core.gain;
    float zero_counts = w->core.zero_counts;
    float zero_noise_ns = w->core.zero_noise_ns;
    float r_squared = w->core.r_squared;
    int fail_idx = cal_wizard_fail_step_index(&w->core);
    float bias_v = w->core.bias_measured_v;
    uint32_t seconds_left = w->core.seconds_left;
    float noise_std_dev[CAL_POINTS];
    memcpy(noise_std_dev, w->core.noise_std_dev, sizeof(noise_std_dev));
    furi_mutex_release(w->mutex);

    draw_screen_header(c, "GSR Calibration");

    switch(step) {
    case WizardStepPrompt470k:
    case WizardStepPrompt100k:
    case WizardStepPrompt47k: {
        int idx = step / 2;
        draw_fmt(c, 0, 25, "Step %d/4: %s (%s)",
                 idx + 2, biomap_cal_steps[idx].level, biomap_cal_steps[idx].resistor);
        draw_fmt(c, 0, 37, "Connect %s 0.1%% resistor", biomap_cal_steps[idx].resistor);
        canvas_draw_str(c, 0, 49, "OK to measure");
        break;
    }
    case WizardStepMeasuring470k:
    case WizardStepMeasuring100k:
    case WizardStepMeasuring47k: { // live dwell countdown (CAL_DWELL_SECONDS)
        int idx = step / 2;
        draw_fmt(c, 0, 25, "Measuring %s...", biomap_cal_steps[idx].resistor);
        canvas_draw_str(c, 0, 37, "Keep resistor connected");
        draw_fmt(c, 0, 49, "%lus remaining (Back=cancel)", (unsigned long)seconds_left);
        break;
    }
    case WizardStepPromptZero: // open-circuit zero
        canvas_draw_str(c, 0, 25, "Step 1/4: Zero");
        canvas_draw_str(c, 0, 37, "Disconnect everything");
        canvas_draw_str(c, 0, 49, "OK to measure");
        break;
    case WizardStepMeasuringZero: // live dwell countdown
        canvas_draw_str(c, 0, 25, "Measuring zero...");
        canvas_draw_str(c, 0, 37, "Keep nothing connected");
        draw_fmt(c, 0, 49, "%lus remaining (Back=cancel)", (unsigned long)seconds_left);
        break;
    case WizardStepZeroFailed: // out of range (something connected) or too noisy
        canvas_draw_str(c, 0, 25, "Zero Check Failed!");
        if(zero_noise_ns >= CAL_NOISE_ACCEPTABLE_NS) {
            draw_fmt(c, 0, 37, "Too noisy: %.1f nS", (double)zero_noise_ns);
            canvas_draw_str(c, 0, 49, "Keep cables still.");
        } else {
            draw_fmt(c, 0, 37, "Read %.0f, max %.0f", (double)zero_counts,
                     (double)CAL_ZERO_MAX_COUNTS);
            canvas_draw_str(c, 0, 49, "Disconnect everything.");
        }
        break;
    case WizardStepSuccess: {
        float worst_std = biomap_cal_worst_noise_std_dev(noise_std_dev);
        canvas_draw_str(c, 0, 23, "Calibration Success!");
        draw_fmt(c, 0, 35, "Gain: %.3fx  R\xb2: %.4f", (double)gain, (double)r_squared);
        draw_fmt(c, 0, 47, "Zero:%.0f  N:%.2fnS", (double)zero_counts, (double)worst_std);
        canvas_draw_str(c, 0, 60, "OK=Save  Back=Discard");
        break;
    }
    case WizardStepMeasureFailed: // not enough samples in gate
        canvas_draw_str(c, 0, 25, "Calibration Failed!");
        canvas_draw_str(c, 0, 38, "Check connections.");
        break;
    case WizardStepFitFailed: // bounds or R²
        canvas_draw_str(c, 0, 25, "Calibration Failed!");
        canvas_draw_str(c, 0, 37, "Device out of range.");
        draw_fmt(c, 0, 49, "Gain: %.3fx  R\xb2: %.4f", (double)gain, (double)r_squared);
        break;
    case WizardStepNoiseFailed: // sigma >= CAL_NOISE_ACCEPTABLE_NS
        canvas_draw_str(c, 0, 25, "Pre-flight Check Failed!");
        draw_fmt(c, 0, 37, "%s too noisy/unstable.", biomap_cal_steps[fail_idx].resistor);
        draw_fmt(c, 0, 49, "Sigma: %.2f nS (max %.0f)",
                 (double)noise_std_dev[fail_idx], (double)CAL_NOISE_ACCEPTABLE_NS);
        break;
    case WizardStepBiasFailed: // failed or out of range (gsr_sensor.h, GSR_BIAS_*)
        canvas_draw_str(c, 0, 25, "Bias Check Failed!");
        if(isnan(bias_v)) {
            canvas_draw_str(c, 0, 37, "No reading. Check wiring.");
        } else {
            draw_fmt(c, 0, 37, "Bias %.0fmV, need %.0f-%.0f", (double)(bias_v * 1000.0f),
                     (double)(GSR_BIAS_MIN_V * 1000.0f), (double)(GSR_BIAS_MAX_V * 1000.0f));
        }
        canvas_draw_str(c, 0, 49, "Check 3.3V supply.");
        break;
    default:
        break;
    }
}

// Draw an "Age: N d" / "Age: unknown" line for a calibration saved at
// `saved_epoch` (Unix epoch; 0 = RTC was unset at save). "unknown" also
// covers an unset RTC now, or a clock that has gone backwards since the
// save. Shared by the GSR and RF "Show Current" screens.
static void draw_calibration_age(Canvas* c, int x, int y, uint32_t saved_epoch) {
    char age[32];
    uint32_t now = saved_epoch ? biomap_rtc_now_epoch() : 0;
    biomap_format_cal_age(age, sizeof(age), saved_epoch, now);
    canvas_draw_str(c, x, y, age);
}

void show_current_calibration_render(Canvas* c, void* ctx) {
    BioMapApp* app = (BioMapApp*)ctx;
    draw_screen_header(c, "GSR Calibration");

    if(furi_mutex_acquire(app->mutex, 10) != FuriStatusOk) return;
    bool active = app->cal_active;
    float gain = app->cal_gain;
    float zero_counts = app->cal_zero_counts;
    uint32_t timestamp = app->cal_timestamp;
    float r_squared = app->cal_r_squared;
    float noise_std_dev[CAL_POINTS];
    memcpy(noise_std_dev, app->cal_noise_std_dev, sizeof(noise_std_dev));
    furi_mutex_release(app->mutex);

    draw_fmt(c, 0, 23, "Active %s Cal:", active ? "Custom" : "Default");
    // Fit R² rides on the Gain line for a custom cal (same pairing as the
    // wizard's fit-fail screen); the default transform has no fit or
    // noise data, so the Zero line stays plain for it.
    if(active) {
        draw_fmt(c, 0, 35, "Gain: %.3fx  R\xb2: %.4f", (double)gain, (double)r_squared);
        draw_fmt(c, 0, 47, "Zero:%.0f  N:%.2fnS",
                 (double)zero_counts, (double)biomap_cal_worst_noise_std_dev(noise_std_dev));
    } else {
        draw_fmt(c, 0, 35, "Gain: %.3fx", (double)gain);
        draw_fmt(c, 0, 47, "Zero: %.0f", (double)zero_counts);
    }

    // Calibration age — custom cal only (the default transform has no save).
    if(active) draw_calibration_age(c, 0, 59, timestamp);
}

// ==========================================================================
// RF Faraday calibration menu & wizard rendering
// ==========================================================================

void rf_calibration_menu_render(Canvas* c, void* ctx) {
    draw_cal_submenu(c, ctx, "RF Calibration");
}

void rf_calibration_wizard_prep_render(Canvas* c, void* ctx) {
    RfCalWizardState* w = (RfCalWizardState*)ctx;
    draw_screen_header(c, "RF Faraday Calibration");
    canvas_draw_str(c, 0, 25, "Place Flipper inside RF");
    canvas_draw_str(c, 0, 35, "shielding bag/box & seal.");

    // Guards against run_rf_calibration_wizard()'s prep-countdown loop
    // (main thread), which rewrites seconds_left every ~1s — see
    // RfCalWizardState's doc comment in biomap.h.
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    uint32_t seconds_left = w->seconds_left;
    furi_mutex_release(w->mutex);

    draw_fmt(c, 0, 47, "Pre-bagging: %lus", (unsigned long)seconds_left);
}

void rf_calibration_wizard_sampling_render(Canvas* c, void* ctx) {
    _Static_assert(EM_SCAN_NUM_FREQS == 3, "update sampling render format");
    RfCalWizardState* w = (RfCalWizardState*)ctx;
    draw_screen_header(c, "Zeroing CC1101...");

    furi_mutex_acquire(w->mutex, FuriWaitForever);
    uint32_t seconds_left = w->seconds_left;
    float rssi_dbm[EM_SCAN_NUM_FREQS];
    memcpy(rssi_dbm, w->rssi_dbm, sizeof(rssi_dbm));
    furi_mutex_release(w->mutex);

    draw_fmt(c, 0, 25, "Sampling: %lus", (unsigned long)seconds_left);
    draw_fmt(c, 0, 37, "%s:%.0f %s:%.0f %s:%.0f",
             em_scan_freq_label[0], (double)rssi_dbm[0],
             em_scan_freq_label[1], (double)rssi_dbm[1],
             em_scan_freq_label[2], (double)rssi_dbm[2]);
}

void rf_calibration_wizard_stats_render(Canvas* c, void* ctx) {
    RfCalWizardState* w = (RfCalWizardState*)ctx;

    // Not racing against a live writer by this point (see the "no mutex
    // needed here" comment where these are computed in biomap_rf_cal.c),
    // but taking the lock anyway costs nothing and keeps this function
    // honest about being a reader of shared state — snapshotted up front,
    // before any use, rather than reading w-> directly further down.
    furi_mutex_acquire(w->mutex, FuriWaitForever);
    bool passed = w->passed;
    uint32_t sweep_count = w->sweep_count;
    float computed_floors[EM_SCAN_NUM_FREQS];
    float computed_std_devs[EM_SCAN_NUM_FREQS];
    memcpy(computed_floors, w->computed_floors, sizeof(computed_floors));
    memcpy(computed_std_devs, w->computed_std_devs, sizeof(computed_std_devs));
    furi_mutex_release(w->mutex);

    draw_screen_header(c, passed ? "Calibration Passed!" : "Calibration Failed!");

    if(passed) {
        float min_f = computed_floors[0];
        float max_f = computed_floors[0];
        float max_std = computed_std_devs[0];
        for(int i = 1; i < EM_SCAN_NUM_FREQS; i++) {
            if(computed_floors[i] < min_f) min_f = computed_floors[i];
            if(computed_floors[i] > max_f) max_f = computed_floors[i];
            if(computed_std_devs[i] > max_std) max_std = computed_std_devs[i];
        }
        draw_fmt(c, 0, 24, "Floors: %.1f to %.1f dBm", (double)min_f, (double)max_f);
        draw_fmt(c, 0, 36, "Max StdDev: %.2fdB (OK)", (double)max_std);
        canvas_draw_str(c, 0, 60, "OK=Save  Back=Discard");
    } else if(sweep_count < EM_SCAN_CAL_MIN_SAMPLES) {
        draw_fmt(c, 0, 24, "Too few sweeps: %lu (need %d+)",
                 (unsigned long)sweep_count, EM_SCAN_CAL_MIN_SAMPLES);
        canvas_draw_str(c, 0, 36, "Sampling ran too slow/short");
    } else {
        int worst_std_idx = 0;
        float worst_std = computed_std_devs[0];
        int worst_floor_idx = -1;
        float worst_floor_margin = 0.0f;

        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
            if(computed_std_devs[i] > worst_std) {
                worst_std = computed_std_devs[i];
                worst_std_idx = i;
            }
            float margin = computed_floors[i] - em_scan_cal_max_floor_dbm[i];
            if(margin > worst_floor_margin) {
                worst_floor_margin = margin;
                worst_floor_idx = i;
            }
        }

        if(worst_floor_idx >= 0) {
            draw_fmt(c, 0, 24, "Unshielded (>%.0fdBm)", (double)em_scan_cal_max_floor_dbm[worst_floor_idx]);
            draw_fmt(c, 0, 36, "Worst: %sMHz %.1fdBm",
                     em_scan_freq_label[worst_floor_idx], (double)computed_floors[worst_floor_idx]);
            canvas_draw_str(c, 0, 48, "Place Flipper in Faraday bag!");
        } else {
            draw_fmt(c, 0, 24, "High Noise Variance (>%.1fdB)", (double)EM_SCAN_CAL_MAX_STD_DEV_DB);
            draw_fmt(c, 0, 36, "Worst: %sMHz %.2fdB",
                     em_scan_freq_label[worst_std_idx], (double)worst_std);
            canvas_draw_str(c, 0, 48, "Check bag seal for leaks!");
        }
    }
}

void rf_show_current_calibration_render(Canvas* c, void* ctx) {
    BioMapApp* app = (BioMapApp*)ctx;
    draw_screen_header(c, "RF Calibration");

    if(furi_mutex_acquire(app->mutex, 10) != FuriStatusOk) return;
    bool calibrated = app->rf_calibrated;
    EmScanCal cal = app->rf_cal_data;
    furi_mutex_release(app->mutex);

    if(!calibrated) {
        canvas_draw_str(c, 0, 24, "Not calibrated.");
    } else {
        // No "Band Floors (dBm):" header row — the three "(std ..)" lines
        // plus the screen title make the units clear, and dropping it leaves
        // vertical room for the age line below.
        int y = 24;
        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
            y = draw_fmt(c, 0, y, "%s: %.1f  (std %.2f)",
                         em_scan_freq_label[i],
                         (double)cal.noise_floor_dbm[i],
                         (double)cal.noise_std_dev_db[i]);
        }
        draw_calibration_age(c, 0, y + 2, cal.timestamp);
    }
}
