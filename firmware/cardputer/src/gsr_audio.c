#include "gsr_audio.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "biomap_types.h"
#include "gsr_sensor.h"  // GSR_VALID_MIN_NS, GSR_VALID_MAX_NS

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static const float TWO_PI = (float)(2.0 * M_PI);
static const float INV_FS = 1.0f / (float)GSR_AUDIO_SAMPLE_RATE;

// 10 Hz conditioning constants:
// Three cascaded 1st-order poles with alpha = 0.18 at 10 Hz cut walking
// footstep bounce by about 44 dB at 1.8 Hz (39 dB at 1.4 Hz), so even the
// differentiated slope stays steady while walking, while 1-3 s skin
// responses pass.
static const float LPF_ALPHA   = 0.18f;
static const float SLOPE_ALPHA = 0.20f;

// Slow personal reference adaptation (at 10 Hz, dt = 0.1 s):
//   - Downward (relaxing below baseline): tau = 45 s so you clearly hear and
//     feel a long downward slide into deep calm, while still gently following
//     multi-minute relaxation deeper.
//   - Upward (resting skin warming): tau = 75 s, paused during active surges so
//     an acute startle peak and its full recovery slide stay audible.
static const float REF_DOWN_ALPHA = 0.1f / 45.0f;
static const float REF_UP_ALPHA   = 0.1f / 75.0f;

// Base sensitivity of normalised tension drive x to log-conductance offset and rate:
static const float LEVEL_GAIN = 3.5f;
static const float SLOPE_GAIN = 6.0f;

// 48 kHz per-sample smoothing coefficients (1 - exp(-1 / (tau * 48000))):
//   gate fade-in:  tau ~ 400 ms (slow fade-in on finger contact)
//   gate fade-out: tau ~ 160 ms (fade to silence)
//   mode xfade:    tau ~ 16 ms  (smooth zero-dip when switching soundscapes)
//   pitch/timbre:  tau ~ 65 ms  (smooth glide between 10 Hz ticks)
//   volume slew:   tau ~ 25 ms  (smooth +/- 10% loudness steps)
static const float GATE_IN_COEFF  = 0.00005208f;
static const float GATE_OUT_COEFF = 0.00013020f;
static const float MODE_XFADE_OUT = 0.00130124f;
static const float PARAM_SLEW     = 0.00032046f;
static const float VOL_SLEW       = 0.00083299f;

// Clean full-range 16-bit PCM peak under M5Cardputer.Speaker's bench-tested
// master VOLUME = 128 (never clips the internal speaker amplifier).
static const float PCM_PEAK = 25000.0f;

// Warm D-major pentatonic bowl notes (D3, E3, F#3, A3, B3, D4, E4) — steady,
// resonant, and free of any dissonant intervals.
static const int   BOWL_SCALE_LEN = 7;
static const float BOWL_SCALE_HZ[7] = {
    146.8324f,  // D3
    164.8138f,  // E3
    184.9972f,  // F#3
    220.0000f,  // A3
    246.9417f,  // B3
    293.6648f,  // D4
    329.6276f,  // E4
};

static inline float clamp01(float x) {
    return clampf(x, 0.0f, 1.0f);
}

static inline float wrap_unit(float u) {
    u -= (float)(int)u;
    if(u < 0.0f) u += 1.0f;
    return u;
}

// 9th-degree polynomial sine for unit phase `u >= 0` (sin(2*pi*u)). Folds
// [0, 1) symmetrically into [-pi/2, +pi/2]; max error about 3.5e-6 (-109 dB),
// far below the 16-bit output, with no libm call in the 48 kHz inner loop.
static inline float precise_sin_unit(float u) {
    float r = u + 0.25f;
    r -= (float)(int)r;
    float x  = TWO_PI * (0.25f - fabsf(r - 0.5f));
    float x2 = x * x;
    return x * (1.0f + x2 * (-0.166666667f + x2 * (0.0083333310f +
               x2 * (-0.00019840874f + x2 * 2.7523971e-6f))));
}

static inline uint32_t xorshift32(uint32_t* state) {
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return x;
}

float gsr_audio_volume_pct_to_gain(int pct) {
    if(pct <= 0) return 0.0f;
    if(pct >= 100) return 1.0f;
    // True logarithmic (dB) audio taper: 6.0 dB per 10% step across a 60 dB span
    // (100% = 0 dB, 80% = -12 dB, 50% = -30 dB, 20% = -48 dB, 10% = -54 dB, 0% = mute).
    float u = (float)pct * 0.01f;
    return powf(10.0f, -3.0f * (1.0f - u));
}

static float drive_to_norm(float x) {
    const float u0 = GSR_AUDIO_REST_NORM;
    if(x >= 0.0f) {
        float span = 1.0f - u0;
        return clamp01(u0 + span * tanhf(x / span));
    }
    return clamp01(u0 + u0 * tanhf(x / u0));
}

const char* gsr_audio_mode_label(GsrAudioMode mode) {
    switch(mode) {
    case GsrAudioOff:    return "MUTED";
    case GsrAudioDrone:  return "DRONE";
    case GsrAudioBreath: return "BREATH";
    case GsrAudioChord:  return "CHORD";
    case GsrAudioBowls:  return "BOWLS";
    case GsrAudioRain:   return "RAIN";
    default:             return "?";
    }
}

GsrAudioMode gsr_audio_cycle_soundscape(GsrAudioMode current, bool next) {
    // Active soundscapes are 1 .. GsrAudioModeCount - 1 (skipping GsrAudioOff = 0).
    const int count = (int)GsrAudioModeCount - 1;
    int idx = (int)current - 1;
    if(idx < 0 || idx >= count) idx = 0;
    idx = next ? ((idx + 1) % count) : ((idx + count - 1) % count);
    return (GsrAudioMode)(idx + 1);
}

float gsr_audio_norm_to_hz(GsrAudioMode mode, float u) {
    u = clamp01(u);
    switch(mode) {
    case GsrAudioBreath:
        return GSR_AUDIO_BREATH_MIN_HZ *
               powf(GSR_AUDIO_BREATH_MAX_HZ / GSR_AUDIO_BREATH_MIN_HZ, u);
    case GsrAudioChord:
        return GSR_AUDIO_CHORD_ROOT_HZ;
    case GsrAudioBowls: {
        int idx = clampi((int)(u * (float)(BOWL_SCALE_LEN - 1) + 0.5f), 0, BOWL_SCALE_LEN - 1);
        return BOWL_SCALE_HZ[idx];
    }
    case GsrAudioRain:
        return GSR_AUDIO_RAIN_MIN_HZ *
               powf(GSR_AUDIO_RAIN_MAX_HZ / GSR_AUDIO_RAIN_MIN_HZ, u);
    case GsrAudioDrone:
    default:
        return GSR_AUDIO_DRONE_MIN_HZ *
               powf(GSR_AUDIO_DRONE_MAX_HZ / GSR_AUDIO_DRONE_MIN_HZ, u);
    }
}

void gsr_audio_hz_note_name(float hz, char* out, size_t cap) {
    if(!out || cap == 0) return;
    if(!(hz > 20.0f && hz < 5000.0f)) {
        snprintf(out, cap, "--");
        return;
    }
    static const char* const NAMES[12] = {
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"
    };
    float midi_f = 69.0f + 12.0f * log2f(hz / 440.0f);
    int midi = clampi((int)lroundf(midi_f), 12, 108);
    int note = midi % 12;
    int oct  = (midi / 12) - 1;
    snprintf(out, cap, "%s%d", NAMES[note], oct);
}

static void clear_voice_filters(GsrAudio* a) {
    a->lp1           = 0.0f;
    a->lp2           = 0.0f;
    a->pink_b0       = 0.0f;
    a->pink_b1       = 0.0f;
    a->pink_b2       = 0.0f;
    a->noise_lp      = 0.0f;
    a->lfo_phase     = 0.0f;
    a->lfo2_phase    = 0.37f;
    a->breath_level  = 0.0f;
    a->breath_inhale = true;
    for(int b = 0; b < 2; b++) {
        a->bowl_hz[b]      = BOWL_SCALE_HZ[1];
        a->bowl_phase_a[b] = 0.0f;
        a->bowl_phase_b[b] = 0.0f;
        a->bowl_atk_rem[b] = 1.0f;
        a->bowl_dec[b]     = 0.0f;
    }
    // Trigger the first gentle singing bowl 150 ms after entering BOWLS.
    a->bowl_samples_until_next = (uint32_t)(0.15f * (float)GSR_AUDIO_SAMPLE_RATE);
    a->bowl_next_slot          = 0;
    a->bowl_last_note          = 1;
    a->drop_s                  = 0.0f;
    a->drop_c                  = 0.0f;
    a->drop_w                  = 0.06f;
    a->drop_atk_rem            = 1.0f;
}

void gsr_audio_init(GsrAudio* a, GsrAudioMode mode) {
    if(!a) return;
    memset(a, 0, sizeof(*a));
    a->mode          = mode;
    a->pending_mode  = mode;
    a->sens_scale    = 1.0f;
    a->pitch_norm    = GSR_AUDIO_REST_NORM;
    a->cur_u         = GSR_AUDIO_REST_NORM;
    float rest_hz    = gsr_audio_norm_to_hz(mode, GSR_AUDIO_REST_NORM);
    a->target_hz     = rest_hz;
    a->cur_hz        = rest_hz;
    a->target_vol    = gsr_audio_volume_pct_to_gain(80);
    a->cur_vol       = a->target_vol;
    clear_voice_filters(a);
    a->phases[0] = 0.00f;
    a->phases[1] = 0.19f;
    a->phases[2] = 0.42f;
    a->phases[3] = 0.64f;
    a->phases[4] = 0.81f;
    a->phases[5] = 0.93f;
    a->rng       = 0x6D2B79F5u;
}

void gsr_audio_set_mode(GsrAudio* a, GsrAudioMode mode) {
    if(!a) return;
    if(a->cur_gate < 1e-3f) {
        a->mode         = mode;
        a->pending_mode = mode;
        a->cur_gate     = 0.0f;
        clear_voice_filters(a);
        a->target_hz    = gsr_audio_norm_to_hz(mode, a->pitch_norm);
        a->cur_hz       = a->target_hz;
        a->target_gate  = (mode != GsrAudioOff && a->has_contact) ? 1.0f : 0.0f;
        return;
    }
    a->pending_mode = mode;
    if(mode == GsrAudioOff) {
        a->target_gate = 0.0f;
    }
}

void gsr_audio_set_volume_pct(GsrAudio* a, int pct) {
    if(!a) return;
    a->target_vol = gsr_audio_volume_pct_to_gain(pct);
}

void gsr_audio_set_sensitivity_pct(GsrAudio* a, int sens_pct) {
    if(!a) return;
    sens_pct = clampi(sens_pct, GSR_AUDIO_SENS_MIN_PCT, GSR_AUDIO_SENS_MAX_PCT);
    a->sens_scale = (float)sens_pct * 0.01f;
}

void gsr_audio_tick(GsrAudio* a, float raw_ns, bool sensor_available) {
    if(!a) return;

    bool valid = sensor_available && isfinite(raw_ns) &&
                 (raw_ns >= GSR_VALID_MIN_NS) && (raw_ns <= GSR_VALID_MAX_NS);
    if(!valid) {
        a->has_contact    = false;
        a->contact_ticks  = 0;
        a->settle_elapsed = 0;
        a->target_gate    = 0.0f;
        return;
    }

    float prev_ns = a->prev_raw_ns;
    float jump = fabsf(raw_ns - prev_ns);
    bool fresh_contact = (a->contact_ticks == 0 && a->settle_elapsed == 0);
    bool cuff_jump = a->filter_primed && !fresh_contact && (jump > GSR_AUDIO_JUMP_NS);
    a->prev_raw_ns = raw_ns;

    if(!a->filter_primed || fresh_contact || cuff_jump) {
        a->lpf1_ns       = raw_ns;
        a->lpf2_ns       = raw_ns;
        a->lpf3_ns       = raw_ns;
        float log_g      = logf(raw_ns);
        a->prev_log_g    = log_g;
        a->smooth_dlog_s = 0.0f;
        if(!a->filter_primed) {
            a->ref_log       = log_g;
            a->filter_primed = true;
        }
        if(cuff_jump && a->has_contact) {
            a->ref_log = log_g;
        }
    } else {
        a->lpf1_ns += LPF_ALPHA * (raw_ns - a->lpf1_ns);
        a->lpf2_ns += LPF_ALPHA * (a->lpf1_ns - a->lpf2_ns);
        a->lpf3_ns += LPF_ALPHA * (a->lpf2_ns - a->lpf3_ns);
    }

    if(!a->has_contact) {
        a->settle_elapsed++;
        bool fast_grab_transient = (prev_ns >= GSR_VALID_MIN_NS) &&
                                   (fabsf(logf(raw_ns / prev_ns)) > 0.05f) &&
                                   (a->settle_elapsed < 35);
        if(!fast_grab_transient) {
            a->contact_ticks++;
        } else if(a->contact_ticks > GSR_AUDIO_SETTLE_TICKS / 2) {
            a->contact_ticks = GSR_AUDIO_SETTLE_TICKS / 2;
        }

        if(a->contact_ticks >= GSR_AUDIO_SETTLE_TICKS) {
            // Snap all three low-pass stages directly to the settled reading
            // BEFORE latching ref_log so there is zero filter catch-up jump.
            a->lpf1_ns       = raw_ns;
            a->lpf2_ns       = raw_ns;
            a->lpf3_ns       = raw_ns;
            float log_g      = logf(raw_ns);
            a->prev_log_g    = log_g;
            a->ref_log       = log_g;
            a->smooth_dlog_s = 0.0f;
            a->pitch_norm    = GSR_AUDIO_REST_NORM;
            a->cur_u         = GSR_AUDIO_REST_NORM;
            GsrAudioMode active = (a->pending_mode != GsrAudioOff) ? a->pending_mode : a->mode;
            float rest_hz    = gsr_audio_norm_to_hz(active, GSR_AUDIO_REST_NORM);
            a->target_hz     = rest_hz;
            a->cur_hz        = rest_hz;
            a->has_contact   = true;
            a->target_gate   = (a->pending_mode != GsrAudioOff) ? 1.0f : 0.0f;
        } else {
            a->target_gate = 0.0f;
        }
        return;
    }

    a->target_gate = (a->pending_mode != GsrAudioOff) ? 1.0f : 0.0f;

    float log_g  = logf(a->lpf3_ns);
    float dlog_s = (log_g - a->prev_log_g) * (float)TICK_HZ;
    a->prev_log_g = log_g;
    a->smooth_dlog_s += SLOPE_ALPHA * (dlog_s - a->smooth_dlog_s);

    if(log_g < a->ref_log) {
        a->ref_log += REF_DOWN_ALPHA * (log_g - a->ref_log);
    } else if(a->smooth_dlog_s < 0.005f) {
        a->ref_log += REF_UP_ALPHA * (log_g - a->ref_log);
    }

    float sens    = (a->sens_scale > 0.0f) ? a->sens_scale : 1.0f;
    float drive   = sens * (LEVEL_GAIN * (log_g - a->ref_log) + SLOPE_GAIN * a->smooth_dlog_s);
    float u       = drive_to_norm(drive);
    a->pitch_norm = u;
    // In BOWLS the pitch shown is the bowl last struck (trigger_next_bowl).
    if(a->mode != GsrAudioBowls) {
        a->target_hz = gsr_audio_norm_to_hz(a->mode, u);
    }
}

static inline int16_t fast_dither_pcm(float sample, uint32_t* rng) {
    uint32_t r = xorshift32(rng);
    float u1 = (float)(r & 0xFFFFu) * (1.0f / 65536.0f);
    float u2 = (float)((r >> 16) & 0xFFFFu) * (1.0f / 65536.0f);
    float v  = sample + (u1 - u2);
    int32_t pcm = clampi((int32_t)(v >= 0.0f ? (v + 0.5f) : (v - 0.5f)), -30000, 30000);
    return (int16_t)pcm;
}

static void trigger_next_bowl(GsrAudio* a, float cur_u, uint32_t* rng) {
    uint8_t slot = a->bowl_next_slot & 1u;
    a->bowl_next_slot = slot ^ 1u;

    // Pick a steady pentatonic bowl note guided by cur_u, gently alternating
    // with an adjacent consonant harmony so repeated strikes never feel mechanical.
    float f_idx = cur_u * (float)(BOWL_SCALE_LEN - 1);
    int base_idx = (int)(f_idx + 0.5f);
    uint32_t r = xorshift32(rng);
    if((int)a->bowl_last_note == base_idx) {
        int alt = ((r & 1u) != 0u) ? (base_idx + 1) : (base_idx - 1);
        if(alt >= 0 && alt < BOWL_SCALE_LEN) base_idx = alt;
    }
    base_idx = clampi(base_idx, 0, BOWL_SCALE_LEN - 1);
    a->bowl_last_note = (uint8_t)base_idx;

    // The envelope starts at exactly 0 (dec * (1 - atk_rem) == 1 * (1 - 1)),
    // so resetting phase and frequency at the strike cannot click.
    float hz = BOWL_SCALE_HZ[base_idx];
    a->bowl_hz[slot]      = hz;
    a->bowl_phase_a[slot] = 0.0f;
    a->bowl_phase_b[slot] = 0.21f;
    a->bowl_atk_rem[slot] = 1.0f;
    a->bowl_dec[slot]     = 1.0f;
    a->target_hz          = hz;

    // Spacing: ~6.6 s in deep calm, ~4.2 s at higher arousal, +/- 0.4 s organic jitter.
    float jitter_s = ((float)(r & 0xFFu) * (1.0f / 255.0f) - 0.5f) * 0.8f;
    float period_s = 6.6f - 2.4f * cur_u + jitter_s;
    if(period_s < 3.5f) period_s = 3.5f;
    a->bowl_samples_until_next = (uint32_t)(period_s * (float)GSR_AUDIO_SAMPLE_RATE);
}

void gsr_audio_render(GsrAudio* a, int16_t* out_pcm, size_t sample_count) {
    if(!a || !out_pcm || sample_count == 0) return;

    if(a->mode != a->pending_mode && a->cur_gate < 1e-4f) {
        a->mode      = a->pending_mode;
        a->cur_gate  = 0.0f;
        clear_voice_filters(a);
        a->target_hz = gsr_audio_norm_to_hz(a->mode, a->pitch_norm);
        a->cur_hz    = a->target_hz;
    }

    if(a->mode == a->pending_mode && a->target_gate <= 0.0f && a->cur_gate < 1e-4f) {
        a->cur_gate = 0.0f;
        a->cur_vol  = a->target_vol;
        memset(out_pcm, 0, sample_count * sizeof(int16_t));
        return;
    }

    GsrAudioMode mode = a->mode;
    float target_hz   = a->target_hz;
    float cur_hz      = a->cur_hz;
    float cur_gate    = a->cur_gate;
    float cur_u       = a->cur_u;
    float cur_vol     = a->cur_vol;
    const float target_vol = a->target_vol;
    const float target_u   = a->pitch_norm;

    float p0          = a->phases[0];
    float p1          = a->phases[1];
    float p2          = a->phases[2];
    float p3          = a->phases[3];
    float p4          = a->phases[4];
    float p5          = a->phases[5];
    float lfo_phase   = a->lfo_phase;
    float lfo2_phase  = a->lfo2_phase;
    float lp1         = a->lp1;
    float lp2         = a->lp2;
    float pink_b0     = a->pink_b0;
    float pink_b1     = a->pink_b1;
    float pink_b2     = a->pink_b2;
    float noise_lp    = a->noise_lp;
    uint32_t rng      = a->rng ? a->rng : 0x6D2B79F5u;

    float breath_env  = a->breath_level;
    bool  inhaling    = a->breath_inhale;

    for(size_t i = 0; i < sample_count; i++) {
        if(mode != a->pending_mode) {
            cur_gate += MODE_XFADE_OUT * (0.0f - cur_gate);
            if(cur_gate < 1e-3f) {
                cur_gate       = 0.0f;
                mode           = a->pending_mode;
                a->mode        = mode;
                clear_voice_filters(a);
                lp1            = 0.0f;
                lp2            = 0.0f;
                pink_b0        = 0.0f;
                pink_b1        = 0.0f;
                pink_b2        = 0.0f;
                noise_lp       = 0.0f;
                lfo_phase      = 0.0f;
                lfo2_phase     = 0.37f;
                breath_env     = 0.0f;
                inhaling       = true;
                target_hz      = gsr_audio_norm_to_hz(mode, target_u);
                a->target_hz   = target_hz;
                cur_hz         = target_hz;
                a->target_gate = (mode != GsrAudioOff && a->has_contact) ? 1.0f : 0.0f;
            }
        } else {
            float want_gate = (mode == GsrAudioOff) ? 0.0f : a->target_gate;
            float g_coeff   = (want_gate > cur_gate) ? GATE_IN_COEFF : GATE_OUT_COEFF;
            cur_gate += g_coeff * (want_gate - cur_gate);
        }

        cur_hz  += PARAM_SLEW * (target_hz - cur_hz);
        cur_u   += PARAM_SLEW * (target_u - cur_u);
        cur_vol += VOL_SLEW * (target_vol - cur_vol);

        float sample = 0.0f;

        if(mode == GsrAudioBreath) {
            // Breath tide: ~5.6 breaths/min when calm (0.09346 Hz),
            // up to ~7.5 breaths/min when aroused (0.125 Hz).
            float inv_period = 0.093458f + 0.031542f * cur_u;
            lfo_phase = wrap_unit(lfo_phase + inv_period * INV_FS);

            if(lfo_phase < 0.42f) {
                inhaling = true;
                breath_env = 0.5f - 0.5f * precise_sin_unit(lfo_phase * (0.5f / 0.42f) + 0.25f);
            } else {
                inhaling = false;
                breath_env = 0.5f + 0.5f * precise_sin_unit((lfo_phase - 0.42f) * (0.5f / 0.58f) + 0.25f);
            }

            p0 = wrap_unit(p0 + cur_hz * INV_FS);
            p1 = wrap_unit(p1 + (cur_hz * 1.0028f + 0.24f) * INV_FS);
            p2 = wrap_unit(p2 + (cur_hz * 1.4988f) * INV_FS);
            p3 = wrap_unit(p3 + (cur_hz * 2.0f) * INV_FS);

            float chord = 0.36f * precise_sin_unit(p0)
                        + 0.30f * precise_sin_unit(p1)
                        + 0.20f * precise_sin_unit(p2)
                        + 0.14f * precise_sin_unit(p3);

            uint32_t nr = xorshift32(&rng);
            float white = ((float)((int32_t)(nr & 0xFFFFu) - 32768)) * (1.0f / 32768.0f);
            pink_b0 = 0.99765f * pink_b0 + white * 0.0990460f;
            pink_b1 = 0.96300f * pink_b1 + white * 0.2965164f;
            pink_b2 = 0.57000f * pink_b2 + white * 1.0526913f;
            float pink = (pink_b0 + pink_b1 + pink_b2 + white * 0.1848f) * 0.22f;

            float surf_alpha = 0.014f + 0.032f * breath_env + 0.014f * cur_u;
            noise_lp += surf_alpha * (pink - noise_lp);

            float chord_gain = 0.32f + 0.58f * breath_env;
            float surf_gain  = (0.06f + 0.16f * cur_u) * breath_env;
            float mix = chord * chord_gain + noise_lp * surf_gain;

            lp1 += 0.064f * (mix - lp1);
            sample = lp1 * cur_gate * cur_vol * PCM_PEAK;

        } else if(mode == GsrAudioChord) {
            // Ambient chord (F major 9: C3, F3, A3, C4, E4, G4):
            // The pitch never slides; skin changes open and close the upper
            // layers instead.
            lfo_phase  = wrap_unit(lfo_phase  + 0.085f * INV_FS);
            lfo2_phase = wrap_unit(lfo2_phase + 0.133f * INV_FS);

            p0 = wrap_unit(p0 + 130.8128f * INV_FS);  // C3 grounding fifth bass
            p1 = wrap_unit(p1 + 174.6141f * INV_FS);  // F3 root (+ F4 octave)
            p2 = wrap_unit(p2 + 175.0400f * INV_FS);  // F3 warm chorus twin
            p3 = wrap_unit(p3 + 220.0000f * INV_FS);  // A3 warm major 3rd
            p4 = wrap_unit(p4 + 329.6276f * INV_FS);  // E4 major 7th
            p5 = wrap_unit(p5 + 391.9954f * INV_FS);  // G4 floating major 9th

            float swell1 = 0.84f + 0.16f * precise_sin_unit(lfo_phase);
            float swell2 = 0.84f + 0.16f * precise_sin_unit(lfo2_phase);

            float w_3rd = (0.14f + 0.22f * cur_u) * swell1;
            float w_7th = clamp01((cur_u - 0.12f) * 1.25f) * 0.22f * swell2;
            float w_9th = clamp01((cur_u - 0.30f) * 1.40f) * 0.18f * swell1;

            float raw_mix = 0.26f * (precise_sin_unit(p0) + 0.35f * precise_sin_unit(2.0f * p0))
                          + 0.24f * (precise_sin_unit(p1) + 0.30f * precise_sin_unit(2.0f * p1))
                          + 0.20f * precise_sin_unit(p2)
                          + w_3rd * (precise_sin_unit(p3) + 0.25f * precise_sin_unit(2.0f * p3))
                          + w_7th * precise_sin_unit(p4)
                          + w_9th * precise_sin_unit(p5);

            // 2-pole low-pass: ~275 Hz when calm -> ~1,000 Hz when aroused.
            float filt_alpha = 0.036f + 0.095f * cur_u;
            lp1 += filt_alpha * (raw_mix - lp1);
            lp2 += filt_alpha * (lp1 - lp2);

            float dyn = 0.82f + 0.18f * cur_u;
            sample = lp2 * dyn * cur_gate * cur_vol * PCM_PEAK;

        } else if(mode == GsrAudioBowls) {
            // Singing bowls: fixed pentatonic notes (no pitch sliding) that
            // fade in over ~130 ms and decay with a 2.2 s time constant over
            // a quiet D3 bed.
            if(a->has_contact) {
                if(a->bowl_samples_until_next == 0) {
                    trigger_next_bowl(a, cur_u, &rng);
                    target_hz = a->target_hz;
                } else {
                    a->bowl_samples_until_next--;
                }
            }

            // Quiet continuous D3 + A3 grounding resonance bed:
            p0 = wrap_unit(p0 + 146.8324f * INV_FS);
            p1 = wrap_unit(p1 + 220.0000f * INV_FS);
            float bed = 0.14f * precise_sin_unit(p0) + 0.07f * precise_sin_unit(p1);

            float bowls_sum = 0.0f;
            for(int b = 0; b < 2; b++) {
                if(a->bowl_dec[b] > 1e-4f) {
                    // 130 ms attack times 2.2 s decay (time constants):
                    a->bowl_atk_rem[b] *= 0.99984f;
                    a->bowl_dec[b]     *= 0.9999905f;
                    float env = a->bowl_dec[b] * (1.0f - a->bowl_atk_rem[b]);

                    float b_hz = a->bowl_hz[b];
                    float pa = wrap_unit(a->bowl_phase_a[b] + b_hz * INV_FS);
                    // Natural ~0.55 Hz singing-bowl shimmer between twin rims:
                    float pb = wrap_unit(a->bowl_phase_b[b] + (b_hz * 1.0022f + 0.28f) * INV_FS);
                    a->bowl_phase_a[b] = pa;
                    a->bowl_phase_b[b] = pb;

                    float voice = 0.50f * precise_sin_unit(pa)
                                + 0.44f * precise_sin_unit(pb)
                                + 0.18f * precise_sin_unit(2.0f * pa);
                    bowls_sum += env * voice;
                }
            }

            float raw_mix = bed + 0.56f * bowls_sum;
            float filt_alpha = 0.055f + 0.085f * cur_u;
            lp1 += filt_alpha * (raw_mix - lp1);
            lp2 += filt_alpha * (lp1 - lp2);
            sample = lp2 * cur_gate * cur_vol * PCM_PEAK;

        } else if(mode == GsrAudioRain) {
            // Rain: low-passed pink-noise bed + damped water drops + quiet
            // D3/A3 fifth pad.
            lfo_phase = wrap_unit(lfo_phase + 0.075f * INV_FS);
            float breeze = 0.86f + 0.14f * precise_sin_unit(lfo_phase);

            // 1. Pink-noise rain bed, low-passed:
            uint32_t nr = xorshift32(&rng);
            float white = ((float)((int32_t)(nr & 0xFFFFu) - 32768)) * (1.0f / 32768.0f);
            pink_b0 = 0.99765f * pink_b0 + white * 0.0990460f;
            pink_b1 = 0.96300f * pink_b1 + white * 0.2965164f;
            pink_b2 = 0.57000f * pink_b2 + white * 1.0526913f;
            float pink = (pink_b0 + pink_b1 + pink_b2 + white * 0.1848f) * 0.20f;

            // Rain filter opens from ~350 Hz (calm) to ~1,050 Hz (aroused):
            float rain_alpha = 0.046f + 0.088f * cur_u;
            noise_lp += rain_alpha * (pink - noise_lp);
            // Subtract the rumble below ~85 Hz (lp2 tracks it):
            lp2 += 0.011f * (noise_lp - lp2);
            float rain_bed = (noise_lp - 0.65f * lp2) * (0.28f + 0.42f * cur_u) * breeze;

            // 2. Water drops, ~8/s at u = 0 rising to ~26/s at u = 1. A new
            // drop waits until the last one has faded (~20 ms).
            // Chance per sample = rate / 48000, scaled to the 2^32 range of nr:
            // 8/48000 * 2^32 = 715,828 and 18/48000 * 2^32 = 1,610,613.
            uint32_t thresh = (uint32_t)(715828.0f + 1610613.0f * cur_u);
            if((nr < thresh) && (a->drop_s * a->drop_s + a->drop_c * a->drop_c < 0.002f)) {
                // nr is small whenever a drop fires, so the pitch takes a fresh draw.
                uint32_t pr = xorshift32(&rng);
                float drop_hz = 380.0f + (float)(pr & 0x1FFu) * 0.85f;  // 380..815 Hz
                a->drop_w       = TWO_PI * drop_hz * INV_FS;
                a->drop_s       = 0.0f;
                a->drop_c       = 0.22f + 0.16f * cur_u;
                a->drop_atk_rem = 1.0f;
            }
            // Damped sine, 12 ms decay and 2.3 ms attack. The second line uses
            // the new drop_s ("magic circle" oscillator): that keeps it stable
            // at every drop pitch, where updating both from the old values
            // grows without bound above ~460 Hz.
            float nw_s = a->drop_s + a->drop_w * a->drop_c;
            float nw_c = a->drop_c - a->drop_w * nw_s;
            a->drop_s = nw_s * 0.9982f;
            a->drop_c = nw_c * 0.9982f;
            a->drop_atk_rem *= 0.991f;
            float drop = a->drop_s * (1.0f - a->drop_atk_rem);

            // 3. Quiet D3/A3 fifth pad underneath:
            p0 = wrap_unit(p0 + cur_hz * INV_FS);
            p1 = wrap_unit(p1 + (cur_hz * 1.4988f + 0.18f) * INV_FS);
            float pad_raw = 0.20f * precise_sin_unit(p0) + 0.13f * precise_sin_unit(p1);
            lp1 += 0.038f * (pad_raw - lp1);

            float mix = rain_bed + 0.35f * drop + (0.65f + 0.35f * cur_u) * lp1;
            sample = mix * cur_gate * cur_vol * PCM_PEAK;

        } else {
            // GsrAudioDrone (also renders the fade-out when muting to
            // GsrAudioOff): 5-voice detuned drone.
            p0 = wrap_unit(p0 + cur_hz * INV_FS);
            p1 = wrap_unit(p1 + (cur_hz * 1.0034f + 0.32f) * INV_FS);
            p2 = wrap_unit(p2 + (cur_hz * 0.9969f - 0.23f) * INV_FS);
            p3 = wrap_unit(p3 + (cur_hz * 1.4988f + 0.15f) * INV_FS);
            p4 = wrap_unit(p4 + (cur_hz * 2.0021f - 0.18f) * INV_FS);
            lfo_phase = wrap_unit(lfo_phase + 0.14f * INV_FS);

            float v_root  = precise_sin_unit(p0)
                          + 0.50f * precise_sin_unit(2.0f * p0)
                          + 0.28f * precise_sin_unit(3.0f * p0);
            float v_uni1  = precise_sin_unit(p1) + 0.42f * precise_sin_unit(2.0f * p1);
            float v_uni2  = precise_sin_unit(p2) + 0.42f * precise_sin_unit(2.0f * p2);
            float v_fifth = precise_sin_unit(p3) + 0.30f * precise_sin_unit(2.0f * p3);
            float v_oct   = precise_sin_unit(p4);

            float fifth_w = 0.16f + 0.16f * cur_u;
            float oct_w   = 0.10f + 0.18f * cur_u;
            float raw_mix = 0.26f * v_root
                          + 0.22f * v_uni1
                          + 0.22f * v_uni2
                          + fifth_w * v_fifth
                          + oct_w * v_oct;

            float filt_alpha = 0.040f + 0.124f * cur_u;
            lp1 += filt_alpha * (raw_mix - lp1);
            lp2 += filt_alpha * (lp1 - lp2);

            float breath = 0.95f + 0.05f * precise_sin_unit(lfo_phase);
            float dyn    = 0.78f + 0.22f * cur_u;
            sample = lp2 * breath * dyn * cur_gate * cur_vol * PCM_PEAK;
        }

        if((cur_gate < 1e-4f && a->target_gate <= 0.0f && mode == a->pending_mode) ||
           (cur_vol < 1e-4f && target_vol <= 0.0f)) {
            out_pcm[i] = 0;
        } else {
            out_pcm[i] = fast_dither_pcm(sample, &rng);
        }
    }

    a->cur_hz        = cur_hz;
    a->cur_gate      = cur_gate;
    a->cur_u         = cur_u;
    a->cur_vol       = cur_vol;
    a->phases[0]     = p0;
    a->phases[1]     = p1;
    a->phases[2]     = p2;
    a->phases[3]     = p3;
    a->phases[4]     = p4;
    a->phases[5]     = p5;
    a->lfo_phase     = lfo_phase;
    a->lfo2_phase    = lfo2_phase;
    a->breath_level  = breath_env;
    a->breath_inhale = inhaling;
    a->lp1           = lp1;
    a->lp2           = lp2;
    a->pink_b0       = pink_b0;
    a->pink_b1       = pink_b1;
    a->pink_b2       = pink_b2;
    a->noise_lp      = noise_lp;
    a->rng           = rng;
}
