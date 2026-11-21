#pragma once

// The recording screen on the Cardputer: supplies the ten ScreenDraw calls
// (core/biomap_screen.h) that stretch the 128 × 64 layout onto the
// Cardputer's 240 × 135 colour display, and adds colour to the recording
// mark, "REC STOPPED" banner, and the Cardputer's "Waiting for GPS time"
// notice.

#include <M5Cardputer.h>

void screen_cardputer_draw_session(M5Canvas& canvas);
