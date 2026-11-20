#pragma once

// Cues — the named moments the device tells the user about with its light
// and its speaker: "recording started", "write error", a key click.
// Shared by every device; plain C with no device code.
//
// Code says which cue happened; each device decides what that looks and
// sounds like. The Flipper's LED patterns and tones are in
// flipper/biomap_cues_flipper.c; the Cardputer will have its own (beeps,
// no vibration motor).
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

// Whether a cue makes a sound (the "(sound)" and "(light + sound)" marks
// above), for checking rules 2 and 3. Keep in step with those marks.
static inline bool biomap_cue_has_sound(BioMapCue cue) {
    switch(cue) {
    case BioMapCueHeartbeat:
    case BioMapCueHeartbeatFingersOff:
    case BioMapCueNoGpsFix:
    case BioMapCueSdRetrying:
    case BioMapCueSdWriteStopped:
    case BioMapCueStatusLightOff:
    case BioMapCueCount:
        return false;
    default:
        return true;
    }
}

#ifdef __cplusplus
}
#endif
