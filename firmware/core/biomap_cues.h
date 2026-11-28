#pragma once

// Cues — the named moments the device tells the user about with its light
// and its speaker: "recording started", "write error", a key click.
// Shared by every device; plain C with no device code.
//
// Code says which cue happened; each device decides what that looks and
// sounds like (flipper/biomap_cues_flipper.c on the Flipper,
// cardputer/src/cues_cardputer.cpp on the Cardputer).
//
// ("Cue", not "event", so they aren't confused with the main loop's key,
// timer and serial events.)
//
// ── When a cue may make a sound ─────────────────────────────────────────
// Each cue below is marked (light), (sound) or (light + sound).
//
// 1. Light-only cues return at once. They may be sent anywhere, including
//    with the app's main lock held.
// 2. A cue with a sound blocks until the sound has finished — up to about
//    300 ms on the Flipper. Never send one with the app's main lock held:
//    the screen's drawing code waits for the same lock and would freeze.
// 3. No sound while a recording is active. The speaker puts noise on the
//    GSR reading. So the recording-start sound plays before the recording
//    becomes active, followed by a short settle wait (GSR_TONE_SETTLE_MS in
//    core/biomap_session.h); the stop sounds play once the file is closed; key
//    clicks during a recording are left out; and problems that happen
//    mid-recording (fingers off, an SD card retry) are light-only.
// 4. Every sound obeys the Options > Sound setting. The only exception is
//    the Sound toggle itself, which always sounds so muting is audible.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    // ── Key feedback ────────────────────────────────────────────────────
    BioMapCueClick,      // (sound) menu or list move, graph zoom
    BioMapCueBack,       // (sound) back / cancel; lower than Click so the direction is audible
    BioMapCueConfirm,    // (sound) select an item, enter a mode, a step passed
    BioMapCueToggleOn,   // (sound) an Options setting switched on
    BioMapCueToggleOff,  // (sound) an Options setting switched off
    BioMapCueReset,      // (sound) a destructive action, e.g. calibration reset to default
    BioMapCueSuccess,    // (sound) a calibration fit passed
    BioMapCueError,      // (sound) a step, fit or file start failed

    // ── Recording ───────────────────────────────────────────────────────
    BioMapCueRecordingStarted,    // (sound) the file is open; sent before the recording becomes active
    // The file is closed, nothing lost. Light: status light off.
    BioMapCueRecordingStopped,    // (light + sound)
    // The file is closed but its last few seconds are missing (the final
    // write failed). A warning instead of the stop sound, so a lossy stop
    // doesn't sound like a clean one. Light: status light off.
    BioMapCueRecordingIncomplete, // (light + sound)

    // Once a second while recording (light). The second one replaces the
    // first when the GSR finger cuffs are disconnected.
    BioMapCueHeartbeat,           // (light)
    BioMapCueHeartbeatFingersOff, // (light)
    BioMapCueNoGpsFix,            // (light) once a second, after the heartbeat, while GPS has no fix

    // ── SD card trouble during a recording ──────────────────────────────
    BioMapCueSdRetrying,          // (light) a write failed; rows are kept and retried
    // Writes kept failing, so the recording was stopped. Two cues, because
    // the light must come at once (the lock is held there) while the sound
    // must wait until the file is closed and the lock released.
    BioMapCueSdWriteStopped,      // (light) stays on until BioMapCueStatusLightOff
    BioMapCueSdWriteStoppedAlarm, // (sound)
    // Leaving the recording screen: turn off any light left on
    // (BioMapCueSdWriteStopped's).
    BioMapCueStatusLightOff,      // (light)

    // ── GPS ─────────────────────────────────────────────────────────────
    BioMapCueGpsColdStartDone,    // (light + sound) Options > Cold Reset GPS sent
    BioMapCueGpsColdStartFailed,  // (light + sound) no GPS port, nothing sent

    BioMapCueCount,
} BioMapCue;

// ── Shared tone palette ────────────────────────────────────────────────
// Each device plays the same pitches and note durations so key feedback,
// recording start/stop chirps, and alerts sound identical across devices.
typedef struct {
    float    freq_hz;
    uint32_t dur_ms;
} BioMapCueNote;

// Gap between multi-note tones for articulation (ms).
#define BIOMAP_CUE_NOTE_GAP_MS 8

// Look up the notes for `cue`. Returns the note count (0 for light-only
// cues). If non-NULL, sets `*out_notes` to the static note array and
// `*out_alert` (true for alerts/recording chirps, false for normal
// navigation clicks) for devices that vary volume between the two.
static inline size_t biomap_cue_notes(BioMapCue cue, const BioMapCueNote** out_notes,
                                      bool* out_alert) {
    static const BioMapCueNote k_click[]     = {{1800.0f, 35}};
    static const BioMapCueNote k_back[]      = {{1100.0f, 35}};
    static const BioMapCueNote k_confirm[]   = {{2200.0f, 45}};
    static const BioMapCueNote k_tog_on[]    = {{2400.0f, 45}};
    static const BioMapCueNote k_tog_off[]   = {{900.0f, 45}};
    static const BioMapCueNote k_reset[]     = {{1400.0f, 45}, {1000.0f, 45}, {600.0f, 70}};
    static const BioMapCueNote k_rec_start[] = {{659.25f, 70}, {987.77f, 90}};
    static const BioMapCueNote k_rec_stop[]  = {{987.77f, 70}, {659.25f, 90}};
    static const BioMapCueNote k_success[]   = {{880.0f, 60}, {1174.66f, 60}, {1567.98f, 130}};
    static const BioMapCueNote k_error[]     = {{600.0f, 90}, {450.0f, 130}};
    static const BioMapCueNote k_warning[]   = {{550.0f, 110}, {550.0f, 110}};

    const BioMapCueNote* notes = NULL;
    bool alert = true;
    size_t count = 0;

    switch(cue) {
    case BioMapCueClick:
        notes = k_click;
        alert = false;
        count = 1;
        break;
    case BioMapCueBack:
        notes = k_back;
        alert = false;
        count = 1;
        break;
    case BioMapCueConfirm:
        notes = k_confirm;
        alert = false;
        count = 1;
        break;
    case BioMapCueToggleOn:
        notes = k_tog_on;
        alert = false;
        count = 1;
        break;
    case BioMapCueToggleOff:
        notes = k_tog_off;
        alert = false;
        count = 1;
        break;
    case BioMapCueReset:
        notes = k_reset;
        count = 3;
        break;
    case BioMapCueSuccess:
    case BioMapCueGpsColdStartDone:
        notes = k_success;
        count = 3;
        break;
    case BioMapCueError:
    case BioMapCueGpsColdStartFailed:
        notes = k_error;
        count = 2;
        break;
    case BioMapCueRecordingStarted:
        notes = k_rec_start;
        count = 2;
        break;
    case BioMapCueRecordingStopped:
        notes = k_rec_stop;
        count = 2;
        break;
    case BioMapCueRecordingIncomplete:
    case BioMapCueSdWriteStoppedAlarm:
        notes = k_warning;
        count = 2;
        break;
    case BioMapCueHeartbeat:
    case BioMapCueHeartbeatFingersOff:
    case BioMapCueNoGpsFix:
    case BioMapCueSdRetrying:
    case BioMapCueSdWriteStopped:
    case BioMapCueStatusLightOff:
    case BioMapCueCount:
        break;
    }

    if(out_notes) *out_notes = notes;
    if(out_alert) *out_alert = alert;
    return count;
}

// Whether a cue makes a sound (the "(sound)" and "(light + sound)" marks
// above), for checking rules 2 and 3. Derived directly from biomap_cue_notes
// so the two cannot drift apart.
static inline bool biomap_cue_has_sound(BioMapCue cue) {
    return biomap_cue_notes(cue, NULL, NULL) > 0;
}

#ifdef __cplusplus
}
#endif
