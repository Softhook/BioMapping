#pragma once

// Cues on the Flipper: the LED patterns and speaker tones for each cue in
// core/biomap_cues.h. The rules there (which cues sound, when a sound may
// be sent) apply to every call.

#include <stdbool.h>
#include <notification/notification_messages.h>
#include "core/biomap_cues.h"

// Shows and/or plays `cue`. `sound_enabled` is the Options > Sound setting
// (true to force a sound, as the Sound toggle itself does); it doesn't
// affect the light. `notifications` may be NULL only for sound-only cues.
// Blocks for the length of the sound, if the cue has one.
void biomap_cue(NotificationApp* notifications, bool sound_enabled, BioMapCue cue);
