#pragma once

// Animated start-up screen for Bio Mapping 2 on the Cardputer ADV (240 x 135):
// one continuous zoom from outer space to the 3D Earth, down into London,
// into a person's body, where the Bio Mapping 2 square-wave symbol traces
// and grows into the title. A short bell melody plays with it (only when
// Options > Sound is on).
//
// It plays while the GPS module is woken and its backup RTC is polled at
// power-up. Any key or G0 skips it; a press before GPS start-up finishes
// takes effect once it is done. Nothing stays in RAM once it returns.

#include <M5Cardputer.h>

// Plays the start-up animation on `canvas`. If `is_background_done` is
// non-null, the animation holds on its last frame until it returns true.
void splash_cardputer_play(M5Canvas& canvas,
                           bool (*is_background_done)(void),
                           bool sound_enabled);
