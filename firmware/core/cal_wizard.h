#pragma once

// The 4-step GSR calibration wizard, shared by every device; plain C with
// no device code.
//
// Drives the open-circuit zero step (step 13 → 14) followed by the 470k,
// 100k, and 47k resistor steps (steps 0 → 5), computing the origin-locked
// least-squares gain fit and grading per-resistor noise σ.
//
// Runs at 10 Hz (TICK_HZ): each device calls cal_wizard_tick() once every
// 100 ms while cal_wizard_measuring() is true (either from a blocking loop
// on the Flipper or from the non-blocking main loop on the Cardputer), and
// calls cal_wizard_key() on OK or Back. Each device draws the screens and
// saves the result itself.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "biomap_config.h"
#include "biomap_cues.h"
#include "biomap_format.h"
#include "gsr_sensor.h"

#ifdef __cplusplus
extern "C" {
#endif

// The wizard's steps (it starts at WizardStepPromptZero):
//   13 = prompt zero (nothing connected)   14 = measure zero
//   0 = prompt 470k    4 = prompt 47k      8  = success
//   1 = measure 470k   5 = measure 47k     9  = measurement fail
//   2 = prompt 100k    6 = compute fit     10 = fit fail (bounds / R²)
//   3 = measure 100k   7 = (unused)        11 = noise/resolution fail (σ too high)
//   12 = bias check fail                   15 = zero fail (out of range / noisy)
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
    WizardStepNoiseFailed   = 11,
    WizardStepBiasFailed    = 12,
    WizardStepPromptZero    = 13,
    WizardStepMeasuringZero = 14,
    WizardStepZeroFailed    = 15,
};

typedef enum {
    CalDwellPhaseIdle = 0,
    CalDwellPhaseFlushBefore,
    CalDwellPhaseBiasCheck,
    CalDwellPhaseFlushAfterBias,
    CalDwellPhaseSampling,
} CalDwellPhase;

typedef enum {
    CalKeyOutcomeNone = 0,       // key ignored
    CalKeyOutcomeStepChanged,    // moved to a new step or started measuring (*out_cue set)
    CalKeyOutcomeSaveAndExit,    // OK on WizardStepSuccess: save gain/zero/r2/noise and close (*out_cue set)
    CalKeyOutcomeCancelAndExit,  // Back: cancel and close (*out_cue set)
} CalKeyOutcome;

typedef struct {
    GsrSensor*    gsr;
    bool          sensor_ok;
    int           step;                        // WizardStep* (biomap_config.h)
    float         measured[CAL_POINTS];        // [470k, 100k, 47k], nS
    float         noise_std_dev[CAL_POINTS];   // per-resistor σ from the dwell, nS
    int           fail_idx;                    // resistor index behind step 9/11/12's fail screen
    float         bias_measured_v;             // last bias check, V (NAN = failed) — step 12's fail screen
    uint32_t      seconds_left;                // live dwell countdown during Measuring steps
    float         zero_counts;                 // open-circuit reading, normalised counts (step 14)
    float         zero_noise_ns;               // σ of the zero dwell, as nS near zero — step 15's fail screen
    float         gain;
    float         r_squared;

    // 10 Hz dwell state machine (active while phase != CalDwellPhaseIdle)
    CalDwellPhase phase;
    bool          zero_step;
    int           resistor_idx;
    uint32_t      phase_ticks;
    uint32_t      phase_target;
    CalDwell      dwell;
    float         first_raw;
    float         live_reading;
    BioMapCue     fit_cue;                     // post-confirm fit cue on final step (BioMapCueSuccess/Error, else BioMapCueCount)
} CalWizardCore;

// Initialise the wizard at WizardStepPromptZero. `gsr` may be NULL if the
// sensor could not be opened (`sensor_ok` is set from gsr_sensor_available).
void cal_wizard_init(CalWizardCore* w, GsrSensor* gsr);

// True while a measurement dwell (flush, bias check, or 20 s sampling) is
// actively running and needs 10 Hz cal_wizard_tick() calls.
static inline bool cal_wizard_measuring(const CalWizardCore* w) {
    return w->phase != CalDwellPhaseIdle;
}

// Handle OK (`is_ok == true`) or Back (`is_ok == false`). When the return
// value is not CalKeyOutcomeNone, `*out_cue` receives the feedback cue the
// caller should play (for example BioMapCueClick when a prompt is accepted,
// BioMapCueConfirm on save, BioMapCueBack on cancel). If the prompt started
// a measurement step with `!w->sensor_ok`, `cal_wizard_check_sensor()`
// below immediately transitions to WizardStepMeasureFailed with
// BioMapCueError so the caller plays the click first, updates the screen,
// and then plays the error sound.
CalKeyOutcome cal_wizard_key(CalWizardCore* w, bool is_ok, BioMapCue* out_cue);

// Call right after cal_wizard_key() (once its click has played): if a
// Measuring step was entered with `!w->sensor_ok`, transitions to
// WizardStepMeasureFailed, sets `*out_cue = BioMapCueError`, and returns
// true. Returns false otherwise.
bool cal_wizard_check_sensor(CalWizardCore* w, BioMapCue* out_cue);

// Advance an active measurement by one 10 Hz (100 ms) tick. Returns true
// when the dwell finished (reaching the next prompt, success, or a fail
// screen), in which case `*out_cue` is set to BioMapCueConfirm,
// BioMapCueSuccess, or BioMapCueError for the caller to play. While false,
// no sound may be played (GSR + Sound rule).
bool cal_wizard_tick(CalWizardCore* w, BioMapCue* out_cue);

// Why the dwell that just finished failed, as one line for the device's
// log, e.g. "470k failed: first=0.0 in=0 below=200 above=0 gate=[200,
// 3000]". Returns false, and writes nothing, when the wizard isn't on a
// fail step.
bool cal_wizard_fail_reason(const CalWizardCore* w, char* out, size_t cap);

#ifdef __cplusplus
}
#endif
