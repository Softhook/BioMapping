#pragma once

// Sound — short UI feedback tones over the Flipper's piezo speaker.
//
// Implementation pattern lifted from the "Eye of the Phantom" Flipper app
// (furi_hal_speaker_acquire/start/stop/release, blocking for the tone
// duration via furi_delay_ms). That is the standard way external FAP apps
// drive the piezo speaker — there is no "speaker" service/record to open
// (unlike gui/storage/notification), just the HAL acquire/release pair, so
// no application.fam `requires` entry is needed.
//
// Every call site is a discrete, user-initiated key event or state-change
// edge (menu nav, mode select, recording start/stop, calibration steps,
// SD/GSR alerts, ...) handled synchronously in the same thread that already
// does other blocking calls (furi_delay_ms(300) in run_gps_hot_start(), the
// ~2 s calibration measurement loop, mutex waits, etc.). The longest tones
// here (success/error/warning) block for up to ~270 ms — during an active
// recording that's 2-3 missed 100 ms timer ticks, which simply queue up
// (EVENT_QUEUE_DEPTH=64) and get processed back-to-back the instant the
// tone finishes. Since these are rare, discrete events (not per-tick), a
// quarter-second catch-up burst is an acceptable trade for the tone
// actually being audible on the Flipper's quiet piezo.
//
// All functions take `enabled` explicitly (rather than reaching into
// BioMapApp) so the pipeline functions in biomap_session.c — which are
// deliberately kept Session*-only and Flipper-SDK-light for host
// testability — can accept a plain bool without pulling in app state.
// `enabled` is intended to be app->sound_enabled (the Options > Sound
// toggle); callers pass `false` to silence every call unconditionally.

#include <furi.h>
#include <furi_hal_speaker.h>

typedef struct {
    float    freq_hz;
    uint32_t dur_ms;
} SoundNote;

// Play a short melody (1+ notes) back-to-back with a small silent gap
// between notes for articulation. No-op if `enabled` is false, the note
// count is 0, or the speaker is already in use elsewhere (acquire failure
// is silently ignored — a missed UI beep is not worth blocking on).
static inline void biomap_sound_play(bool enabled, const SoundNote* notes, size_t count, float volume) {
    if(!enabled || !notes || count == 0) return;
    uint32_t budget_ms = 30;
    for(size_t i = 0; i < count; i++) budget_ms += notes[i].dur_ms + 10;
    if(!furi_hal_speaker_acquire(budget_ms)) return;

    for(size_t i = 0; i < count; i++) {
        if(i > 0) {
            furi_hal_speaker_stop();
            furi_delay_ms(8); // brief silence between notes for articulation
        }
        furi_hal_speaker_start(notes[i].freq_hz, volume);
        furi_delay_ms(notes[i].dur_ms);
    }
    furi_hal_speaker_stop();
    furi_hal_speaker_release();
}

static inline void biomap_sound_tone(bool enabled, float freq_hz, uint32_t dur_ms, float volume) {
    SoundNote n = {freq_hz, dur_ms};
    biomap_sound_play(enabled, &n, 1, volume);
}

// ── Volume ───────────────────────────────────────────────────────────────
// The Flipper's piezo is quiet to begin with, and very short pulses (the
// original tuning used 12-20 ms clicks at 0.35-0.55 volume) don't give the
// piezo element enough time to ramp up to audible amplitude — the result
// was barely perceptible even in a quiet room. furi_hal_speaker_start()
// volume is 0.0-1.0; run everything near the top of that range (matching
// the louder end of what "Eye of the Phantom" uses, default volume 8/10 =
// 0.8) and give every tone, including plain navigation clicks, enough
// duration (>=35 ms) to actually sound.
#define BIOMAP_SOUND_VOL_NORMAL 0.9f
#define BIOMAP_SOUND_VOL_ALERT  1.0f

// ── Named events — call sites express intent, not Hz/ms ────────────────
//
// Palette is deliberately small and non-melodic (this is a field
// instrument used while walking around in public, not a game): short
// clicks for navigation, a slightly brighter click for confirm/enter,
// paired rising/falling chirps for recording start/stop (mirrors a
// camera's "recording started/stopped" cue), a bright ascending run for
// success, and a low descending buzz for errors/warnings.

// Menu/list navigation (Up/Down) and manual graph zoom (Up/Down/Left/Right
// during a recording session).
static inline void biomap_sound_click(bool enabled) {
    biomap_sound_tone(enabled, 1800.0f, 35, BIOMAP_SOUND_VOL_NORMAL);
}

// Back / cancel — deliberately lower-pitched than click/confirm so the
// "direction" of navigation is audible without looking at the screen.
static inline void biomap_sound_back(bool enabled) {
    biomap_sound_tone(enabled, 1100.0f, 35, BIOMAP_SOUND_VOL_NORMAL);
}

// Selecting a menu item / entering a mode or submenu / confirming a step.
static inline void biomap_sound_confirm(bool enabled) {
    biomap_sound_tone(enabled, 2200.0f, 45, BIOMAP_SOUND_VOL_NORMAL);
}

// Options toggles (Auto-zoom GSR, Backlight). `on` = new state after the
// toggle. Distinct pitch for on/off so the outcome is audible, not just
// "a click happened".
static inline void biomap_sound_toggle(bool enabled, bool on) {
    biomap_sound_tone(enabled, on ? 2400.0f : 900.0f, 45, BIOMAP_SOUND_VOL_NORMAL);
}

// Destructive/administrative action (GSR Calibration > Reset to Default).
// Distinct from a plain toggle — three quick descending notes.
static inline void biomap_sound_reset(bool enabled) {
    static const SoundNote notes[] = {{1400.0f, 45}, {1000.0f, 45}, {600.0f, 70}};
    biomap_sound_play(enabled, notes, 3, BIOMAP_SOUND_VOL_ALERT);
}

// Recording started — rising two-note chirp (E5 -> B5).
static inline void biomap_sound_recording_start(bool enabled) {
    static const SoundNote notes[] = {{659.25f, 70}, {987.77f, 90}};
    biomap_sound_play(enabled, notes, 2, BIOMAP_SOUND_VOL_ALERT);
}

// Recording stopped — falling two-note chirp (B5 -> E5), the mirror image
// of recording_start so start/stop are audibly distinguishable from each
// other without looking at the screen.
static inline void biomap_sound_recording_stop(bool enabled) {
    static const SoundNote notes[] = {{987.77f, 70}, {659.25f, 90}};
    biomap_sound_play(enabled, notes, 2, BIOMAP_SOUND_VOL_ALERT);
}

// Success — calibration wizard fit passed, GPS hot-start acknowledged.
static inline void biomap_sound_success(bool enabled) {
    static const SoundNote notes[] = {{880.0f, 60}, {1174.66f, 60}, {1567.98f, 130}};
    biomap_sound_play(enabled, notes, 3, BIOMAP_SOUND_VOL_ALERT);
}

// Error — calibration measurement/fit failed, GPS hot-start failed, header
// build failed at recording start.
static inline void biomap_sound_error(bool enabled) {
    static const SoundNote notes[] = {{300.0f, 90}, {220.0f, 130}};
    biomap_sound_play(enabled, notes, 2, BIOMAP_SOUND_VOL_ALERT);
}

// Warning — edge-triggered alert for events that matter mid-recording but
// would otherwise only show as a small on-screen/LED cue while the user
// isn't looking at the device: SD write failure (recording stops), GSR
// electrodes disconnecting. Deliberately harsher/longer than sound_error
// so it doesn't get lost while walking.
static inline void biomap_sound_warning(bool enabled) {
    static const SoundNote notes[] = {{260.0f, 110}, {260.0f, 110}};
    biomap_sound_play(enabled, notes, 2, BIOMAP_SOUND_VOL_ALERT);
}
