#pragma once

// Standalone 48 kHz GSR audification engine for the Cardputer ADV.
//
// Plain C with no device headers, so the signal conditioning, self-centring
// baseline, sensitivity scaling and all five soundscapes are tested on the
// host in tests/test_cardputer_rules.c.
//
// Used only by the top-level "GSR Audio" mode; it never touches recording
// sessions, Live Stream, Diagnostics, Calibration or saved settings.
//
// GSR conditioning shared by every soundscape:
//   - Silent when no fingers are on the cuffs. On fresh contact it waits
//     2.0 s (the ADS1115's gain switching and the finger press settle), then
//     snaps the low-pass filters to the settled reading and fades in at the
//     resting pitch, so the sound never starts with a swoop.
//   - A 3-pole low-pass cascade cuts walking footstep bounce (about 39 dB at
//     1.4 Hz, 44 dB at 1.8 Hz) while keeping 1-3 s skin responses.
//   - Follows the wearer's resting skin conductance in log-conductance, with
//     an adjustable response sensitivity (10%..150%).
//
// Soundscapes:
//   - DRONE:  5-voice detuned hum (root + two chorus voices + fifth + octave)
//             through a 2-pole low-pass filter.
//   - BREATH: Slow ~6 breaths/min surf and fifth chord whose pace and
//             brightness follow the GSR, as a breathing guide.
//   - CHORD:  Fixed C3/F3 chord that never changes pitch; the GSR opens and
//             closes its 3rd, major 7th and 9th layers.
//   - BOWLS:  Soft singing-bowl strikes on fixed pentatonic notes with long
//             decays.
//   - RAIN:   Rain noise and water drops over a quiet fifth pad, fuller as
//             arousal rises and thinner as it falls.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Matches the Cardputer ADV ES8311 DAC and M5Unified I2S clock 1:1 (48 kHz).
#define GSR_AUDIO_SAMPLE_RATE   48000
// 2.0 s at 10 Hz: clears both ADS1115 startup PGA autoranging (1.5 s) and
// initial finger-press settling before anchoring the personal baseline.
#define GSR_AUDIO_SETTLE_TICKS  20
#define GSR_AUDIO_JUMP_NS       500.0f  // single-tick jump (cuff re-seat) re-primes smoothly

// Sensitivity range (percent, 100 = default 1.0x response gain, 10% steps).
#define GSR_AUDIO_SENS_MIN_PCT  10
#define GSR_AUDIO_SENS_MAX_PCT  150
#define GSR_AUDIO_SENS_STEP_PCT 10
#define GSR_AUDIO_SENS_DEF_PCT  100

// Normalised resting point u0 in [0, 1]: leaves room below baseline (0 .. u0)
// for deep relaxation to sink lower, and room above for arousal.
#define GSR_AUDIO_REST_NORM     0.2083333f

// DRONE pitch span: warm chest/cello register (A2 = 110 Hz .. E4 = 329.6 Hz).
#define GSR_AUDIO_DRONE_MIN_HZ  110.0000f
#define GSR_AUDIO_DRONE_MAX_HZ  329.6276f

// BREATH root span: grounding C3 -> G3 harmonic bed under slow ocean swell.
#define GSR_AUDIO_BREATH_MIN_HZ 130.8128f
#define GSR_AUDIO_BREATH_MAX_HZ 196.0000f

// CHORD steady anchor: F3 / C3 ambient pad (never slides pitch).
#define GSR_AUDIO_CHORD_ROOT_HZ 174.6141f

// RAIN distant fifth anchor: D3 -> A3 warm undertone.
#define GSR_AUDIO_RAIN_MIN_HZ   146.8324f
#define GSR_AUDIO_RAIN_MAX_HZ   174.6141f

typedef enum {
    GsrAudioOff = 0,     // Muted / clean fade-out state
    GsrAudioDrone,       // Dense warm 5-voice hum drone
    GsrAudioBreath,      // Slow coherent breath tide + ocean surf
    GsrAudioChord,       // Steady floating ambient chord (layers bloom, no pitch slide)
    GsrAudioBowls,       // Soft felt-mallet pentatonic singing bowls
    GsrAudioRain,        // Warm rainfall + soft water droplets + distant pad
    GsrAudioModeCount,
} GsrAudioMode;

typedef struct {
    GsrAudioMode mode;
    GsrAudioMode pending_mode;

    // 10 Hz GSR signal conditioning & self-centring baseline state
    bool     filter_primed;
    bool     has_contact;
    uint16_t contact_ticks;
    uint16_t settle_elapsed;
    float    prev_raw_ns;
    float    lpf1_ns;
    float    lpf2_ns;
    float    lpf3_ns;
    float    prev_log_g;
    float    ref_log;
    float    smooth_dlog_s;
    float    sens_scale;     // 0.10 .. 1.50 multiplier on GSR response drive
    float    pitch_norm;     // 0.0 = deep calm, ~0.21 = resting, 1.0 = high arousal
    float    target_hz;
    float    target_gate;    // 0.0 = silent, 1.0 = active
    float    target_vol;     // 0.0 .. 1.0 linear gain from 0%..100% volume control

    // Live breath guide readout (updated during BREATH synthesis for the UI)
    float    breath_level;   // 0.0 = bottom of exhale, 1.0 = top of inhale
    bool     breath_inhale;  // true while inhaling, false while exhaling

    // 48 kHz continuous phase-coherent synthesis state (unit phases in [0, 1))
    float    cur_hz;
    float    cur_gate;
    float    cur_u;
    float    cur_vol;
    float    phases[6];      // 6 oscillator unit phases in [0, 1)
    float    lfo_phase;      // primary slow shimmer / breath unit phase in [0, 1)
    float    lfo2_phase;     // secondary slow drift unit phase in [0, 1)
    float    lp1;            // warm 2-pole low-pass state (stage 1)
    float    lp2;            // warm 2-pole low-pass state (stage 2)
    float    pink_b0;        // Paul Kellet pinking stage 0 (BREATH / RAIN)
    float    pink_b1;        // Paul Kellet pinking stage 1
    float    pink_b2;        // Paul Kellet pinking stage 2
    float    noise_lp;       // smooth low-pass wave/rain filter

    // Singing-bowl dual alternating voices (BOWLS mode)
    float    bowl_hz[2];
    float    bowl_phase_a[2];
    float    bowl_phase_b[2];
    float    bowl_atk_rem[2];
    float    bowl_dec[2];
    uint32_t bowl_samples_until_next;
    uint8_t  bowl_next_slot;
    uint8_t  bowl_last_note;

    // Soft water-droplet resonator (RAIN mode)
    float    drop_s;
    float    drop_c;
    float    drop_w;
    float    drop_atk_rem;

    uint32_t rng;            // deterministic PRNG for pink noise, bowls, rain & dither
} GsrAudio;

// Short label for UI and logs ("MUTED", "DRONE", "BREATH", "CHORD", "BOWLS", "RAIN").
const char* gsr_audio_mode_label(GsrAudioMode mode);

// Cycles forward (`next = true`) or backward (`next = false`) among the 5 active soundscapes.
GsrAudioMode gsr_audio_cycle_soundscape(GsrAudioMode current, bool next);

// Resets all filter, baseline, and oscillator state to power-on silence.
void gsr_audio_init(GsrAudio* a, GsrAudioMode mode);

// Switches soundscape (or mutes with GsrAudioOff) with a short fade, keeping
// the wearer's learned skin baseline. Muting fades to exact zero within about
// 110 ms of rendered sound.
void gsr_audio_set_mode(GsrAudio* a, GsrAudioMode mode);

// Pure logarithmic volume curve helper: maps 0..100% to linear amplitude gain
// (0% = 0.0, 10%..100% = -54 dB .. 0 dB at 6 dB per 10% step).
float gsr_audio_volume_pct_to_gain(int pct);

// Sets loudness percentage (0..100), smoothed sample by sample.
void gsr_audio_set_volume_pct(GsrAudio* a, int pct);

// Sets GSR response sensitivity percentage (GSR_AUDIO_SENS_MIN_PCT..MAX_PCT, 100 = 1.0x).
void gsr_audio_set_sensitivity_pct(GsrAudio* a, int sens_pct);

// Feed one 10 Hz GSR window reading (nanosiemens) and sensor connection status.
void gsr_audio_tick(GsrAudio* a, float raw_ns, bool sensor_connected);

// Synthesises `sample_count` mono signed 16-bit PCM samples at 48 kHz.
void gsr_audio_render(GsrAudio* a, int16_t* out_pcm, size_t sample_count);

// Pure pitch curve helper: maps normalised tension u in [0, 1] to root Hz for `mode`.
float gsr_audio_norm_to_hz(GsrAudioMode mode, float u);

// Formats a musical pitch name ("A2", "D3", "F#3", ...) for `hz` into `out`.
void gsr_audio_hz_note_name(float hz, char* out, size_t cap);

#ifdef __cplusplus
}
#endif
