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
// does other blocking calls (furi_delay_ms(GPS_COLD_START_SETTLE_MS) in
// run_gps_cold_start(), the calibration measurement loop, mutex waits, etc.).
// The longest tones here (success/error/warning) block for up to ~270 ms —
// during an active recording that's 2-3 missed 100 ms timer ticks, which
// simply queue up (EVENT_QUEUE_DEPTH=64) and get processed back-to-back the
// instant the tone finishes. Since these are rare, discrete events (not
// per-tick), a quarter-second catch-up burst is an acceptable trade for the
// tone actually being audible on the Flipper's quiet piezo.
//
// Only flipper/biomap_cues_flipper.c calls these: the rest of the app sends
// a cue (core/biomap_cues.h), and that file picks the tone. All functions
// take `enabled` explicitly — the Options > Sound setting, or true to force
// the tone (the Sound toggle itself).

#include <furi.h>
#include <furi_hal_speaker.h>
#include "core/biomap_cues.h"

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

// Play a short melody (1+ notes) back-to-back with a small silent gap
// between notes for articulation. No-op if `enabled` is false, the note
// count is 0, or the speaker is already in use elsewhere (acquire failure
// is silently ignored — a missed UI beep is not worth blocking on).
static inline void biomap_sound_play(bool enabled, const BioMapCueNote* notes, size_t count, float volume) {
    if(!enabled || !notes || count == 0) return;
    uint32_t budget_ms = 30;
    for(size_t i = 0; i < count; i++) budget_ms += notes[i].dur_ms + 10;
    if(!furi_hal_speaker_acquire(budget_ms)) return;

    for(size_t i = 0; i < count; i++) {
        if(i > 0) {
            furi_hal_speaker_stop();
            furi_delay_ms(BIOMAP_CUE_NOTE_GAP_MS); // brief silence between notes for articulation
        }
        furi_hal_speaker_start(notes[i].freq_hz, volume);
        furi_delay_ms(notes[i].dur_ms);
    }
    furi_hal_speaker_stop();
    furi_hal_speaker_release();
}

// Plays the shared notes for `cue` (core/biomap_cues.h).
static inline void biomap_sound_play_cue(bool enabled, BioMapCue cue) {
    const BioMapCueNote* notes = NULL;
    bool alert = false;
    size_t count = biomap_cue_notes(cue, &notes, &alert);
    if(count == 0) return;
    biomap_sound_play(enabled, notes, count,
                      alert ? BIOMAP_SOUND_VOL_ALERT : BIOMAP_SOUND_VOL_NORMAL);
}
