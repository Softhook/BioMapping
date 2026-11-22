// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// The GSR calibration wizard, shared by every device — see cal_wizard.h.

#include "cal_wizard.h"

#include <math.h>
#include <stdio.h>

void cal_wizard_init(CalWizardCore* w, GsrSensor* gsr) {
    *w = (CalWizardCore){
        .gsr             = gsr,
        .sensor_ok       = gsr && gsr_sensor_available(gsr),
        .step            = WizardStepPromptZero,
        .bias_measured_v = NAN,
        .seconds_left    = CAL_DWELL_SECONDS,
        .gain            = 1.0f,
        .phase           = CalDwellPhaseIdle,
        .zero_step       = true,
        .fit_cue         = BioMapCueCount,
    };
}

static void cal_wizard_start_dwell(CalWizardCore* w, bool zero_step, int resistor_idx) {
    if(zero_step) {
        gsr_sensor_set_calibration(w->gsr, false, 1.0f, 0.0f);
    } else {
        gsr_sensor_set_calibration(w->gsr, true, 1.0f, w->zero_counts);
    }
    w->zero_step = zero_step;
    w->resistor_idx = resistor_idx;
    w->phase = CalDwellPhaseFlushBefore;
    w->phase_ticks = 0;
    w->phase_target = zero_step ? CAL_ZERO_FLUSH_TICKS : CAL_RESISTOR_FLUSH_TICKS;
    w->seconds_left = CAL_DWELL_SECONDS;
    w->fit_cue = BioMapCueCount;
    cal_dwell_init(&w->dwell);
}

CalKeyOutcome cal_wizard_key(CalWizardCore* w, bool is_ok, BioMapCue* out_cue) {
    if(!is_ok) {
        // Back cancels from any prompt, active measurement dwell, or result screen.
        w->phase = CalDwellPhaseIdle;
        if(out_cue) *out_cue = BioMapCueBack;
        return CalKeyOutcomeCancelAndExit;
    }

    if(cal_wizard_measuring(w)) {
        return CalKeyOutcomeNone;
    }

    if(w->step == WizardStepSuccess) {
        if(out_cue) *out_cue = BioMapCueConfirm;
        return CalKeyOutcomeSaveAndExit;
    }

    if(w->step == WizardStepMeasureFailed || w->step == WizardStepFitFailed ||
       w->step == WizardStepNoiseFailed || w->step == WizardStepBiasFailed ||
       w->step == WizardStepZeroFailed) {
        w->step = WizardStepPromptZero;
        if(out_cue) *out_cue = BioMapCueClick;
        return CalKeyOutcomeStepChanged;
    }

    if(w->step == WizardStepPromptZero) {
        w->step = WizardStepMeasuringZero;
        if(w->sensor_ok) cal_wizard_start_dwell(w, true, 0);
        if(out_cue) *out_cue = BioMapCueClick;
        return CalKeyOutcomeStepChanged;
    }

    if(w->step == WizardStepPrompt470k || w->step == WizardStepPrompt100k ||
       w->step == WizardStepPrompt47k) {
        int idx = w->step / 2;
        w->step = idx * 2 + 1;
        if(w->sensor_ok) cal_wizard_start_dwell(w, false, idx);
        if(out_cue) *out_cue = BioMapCueClick;
        return CalKeyOutcomeStepChanged;
    }

    return CalKeyOutcomeNone;
}

bool cal_wizard_check_sensor(CalWizardCore* w, BioMapCue* out_cue) {
    if(w->sensor_ok) return false;
    if(w->step == WizardStepMeasuringZero) {
        w->fail_idx = 0;
        w->step = WizardStepMeasureFailed;
        if(out_cue) *out_cue = BioMapCueError;
        return true;
    }
    if(w->step == WizardStepMeasuring470k || w->step == WizardStepMeasuring100k ||
       w->step == WizardStepMeasuring47k) {
        w->fail_idx = w->step / 2;
        w->step = WizardStepMeasureFailed;
        if(out_cue) *out_cue = BioMapCueError;
        return true;
    }
    return false;
}

static BioMapCue cal_wizard_finish_dwell(CalWizardCore* w) {
    w->phase = CalDwellPhaseIdle;
    if(w->zero_step) {
        if(cal_dwell_ok(&w->dwell)) {
            w->zero_counts = w->dwell.mean;
            w->zero_noise_ns = cal_dwell_std(&w->dwell) * gsr_tia_counts_to_ns(1.0f);
            bool zero_ok = calibration_noise_grade(w->zero_noise_ns) != CalNoisePoor;
            w->step = zero_ok ? WizardStepPrompt470k : WizardStepZeroFailed;
            return zero_ok ? BioMapCueConfirm : BioMapCueError;
        }
        w->zero_counts = cal_dwell_mean_all(&w->dwell);
        w->zero_noise_ns = 0.0f;
        w->step = WizardStepZeroFailed;
        return BioMapCueError;
    }

    int idx = w->resistor_idx;
    if(!cal_dwell_ok(&w->dwell)) {
        w->fail_idx = idx;
        w->step = WizardStepMeasureFailed;
        return BioMapCueError;
    }

    float avg_g = w->dwell.mean;
    float std_dev = cal_dwell_std(&w->dwell);
    w->measured[idx] = avg_g;
    w->noise_std_dev[idx] = std_dev;

    if(calibration_noise_grade(std_dev) == CalNoisePoor) {
        w->fail_idx = idx;
        w->step = WizardStepNoiseFailed;
        return BioMapCueError;
    }

    w->step = idx * 2 + 2;
    if(w->step == WizardStepFitPending) {
        float gain = 1.0f, r2 = 0.0f;
        bool fit_ok = calibration_wizard_compute_fit(w->measured, biomap_cal_targets, &gain, &r2);
        w->gain = gain;
        w->r_squared = r2;
        w->step = fit_ok ? WizardStepSuccess : WizardStepFitFailed;
        w->fit_cue = fit_ok ? BioMapCueSuccess : BioMapCueError;
    }
    return BioMapCueConfirm;
}

bool cal_wizard_tick(CalWizardCore* w, BioMapCue* out_cue) {
    switch(w->phase) {
    case CalDwellPhaseFlushBefore:
        gsr_sensor_tick(w->gsr);
        w->live_reading = w->zero_step
            ? (float)gsr_sensor_get_mean_count(w->gsr)
            : gsr_sensor_get_raw(w->gsr);
        if(++w->phase_ticks >= w->phase_target) {
            if(w->zero_step) {
                w->phase = CalDwellPhaseSampling;
                w->phase_ticks = 0;
                w->phase_target = CAL_DWELL_SECONDS * TICK_HZ;
            } else {
                w->phase = CalDwellPhaseBiasCheck;
            }
        }
        return false;

    case CalDwellPhaseBiasCheck: {
        bool bias_done = gsr_sensor_run_bias_check(w->gsr, GSR_BIAS_CHECK_TIMEOUT_MS);
        float bias_v = bias_done ? gsr_sensor_get_bias_measured_volts(w->gsr) : NAN;
        w->bias_measured_v = bias_v;
        if(!gsr_bias_in_range(bias_v)) {
            w->phase = CalDwellPhaseIdle;
            w->fail_idx = w->resistor_idx;
            w->step = WizardStepBiasFailed;
            if(out_cue) *out_cue = BioMapCueError;
            return true;
        }
        w->phase = CalDwellPhaseFlushAfterBias;
        w->phase_ticks = 0;
        w->phase_target = CAL_POST_BIAS_FLUSH_TICKS;
        return false;
    }

    case CalDwellPhaseFlushAfterBias:
        gsr_sensor_tick(w->gsr);
        if(++w->phase_ticks >= w->phase_target) {
            w->phase = CalDwellPhaseSampling;
            w->phase_ticks = 0;
            w->phase_target = CAL_DWELL_SECONDS * TICK_HZ;
        }
        return false;

    case CalDwellPhaseSampling: {
        gsr_sensor_tick(w->gsr);
        float v = w->zero_step
            ? (float)gsr_sensor_get_mean_count(w->gsr)
            : gsr_sensor_get_raw(w->gsr);
        w->live_reading = v;
        if(w->phase_ticks == 0) w->first_raw = v;
        float lo = w->zero_step ? -CAL_ZERO_MAX_COUNTS : biomap_cal_gates[w->resistor_idx][0];
        float hi = w->zero_step ?  CAL_ZERO_MAX_COUNTS : biomap_cal_gates[w->resistor_idx][1];
        cal_dwell_add(&w->dwell, v, lo, hi);
        w->seconds_left = CAL_DWELL_SECONDS - w->phase_ticks / TICK_HZ;
        if(++w->phase_ticks >= w->phase_target) {
            BioMapCue cue = cal_wizard_finish_dwell(w);
            if(out_cue) *out_cue = cue;
            return true;
        }
        return false;
    }

    case CalDwellPhaseIdle:
        break;
    }
    return false;
}

static const char* const RESISTOR_NAME[CAL_POINTS] = {"470k", "100k", "47k"};

bool cal_wizard_fail_reason(const CalWizardCore* w, char* out, size_t cap) {
    const CalDwell* d = &w->dwell;
    int idx = (w->fail_idx >= 0 && w->fail_idx < CAL_POINTS) ? w->fail_idx : 0;
    int n;
    switch(w->step) {
    case WizardStepBiasFailed:
        n = snprintf(out, cap, "Bias check failed: %.4f V", (double)w->bias_measured_v);
        break;
    case WizardStepZeroFailed:
        n = cal_dwell_ok(d)
            ? snprintf(out, cap, "Zero too noisy: %.2f nS (max %.0f)",
                       (double)w->zero_noise_ns, (double)CAL_NOISE_ACCEPTABLE_NS)
            : snprintf(out, cap, "Zero failed: mean=%.1f in=%d/%d (limit ±%.0f)",
                       (double)w->zero_counts, d->in_gate, d->all, (double)CAL_ZERO_MAX_COUNTS);
        break;
    case WizardStepMeasureFailed:
        if(!w->sensor_ok) {
            n = snprintf(out, cap, "No GSR sensor");
            break;
        }
        n = snprintf(out, cap, "%s failed: first=%.1f in=%d below=%d above=%d gate=[%.0f, %.0f]",
                     RESISTOR_NAME[idx], (double)w->first_raw, d->in_gate, d->below, d->above,
                     (double)biomap_cal_gates[idx][0], (double)biomap_cal_gates[idx][1]);
        break;
    case WizardStepNoiseFailed:
        n = snprintf(out, cap, "%s too noisy: %.2f nS (max %.0f)", RESISTOR_NAME[idx],
                     (double)w->noise_std_dev[idx], (double)CAL_NOISE_ACCEPTABLE_NS);
        break;
    case WizardStepFitFailed:
        n = snprintf(out, cap, "Fit failed: gain=%.4f R2=%.4f", (double)w->gain,
                     (double)w->r_squared);
        break;
    default:
        return false;
    }
    return n > 0;
}
