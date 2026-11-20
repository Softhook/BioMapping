#pragma once

// Cues on the Cardputer: each cue in core/biomap_cues.h as a sound.
//
// The tones are the Flipper's (flipper/sound.h), so the two devices sound
// the same. The Cardputer has no status light yet, so the light-only cues
// (heartbeat, SD retrying, ...) do nothing for now; the screen shows the
// same states.

#include "biomap_cues.h"

void cues_cardputer_begin(void);
void cues_cardputer_play(bool sound_enabled, BioMapCue cue);
