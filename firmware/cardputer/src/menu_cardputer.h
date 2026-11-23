#pragma once

// The Cardputer's colour menus, Options screen, and GSR Calibration wizard
// (240 × 135). Everything runs non-blockingly on the main loop so keyboard
// unstick and idle GPS byte checks continue on every pass.

#include <M5Cardputer.h>
#include "biomap_session.h"

// Initialises the menu state at start-up.
void menu_cardputer_begin(void);

// True while we are in a menu or calibration screen (no recording session open).
bool menu_cardputer_active(void);

// Handles one of the six buttons while the menu is active. Returns true when
// the screen should be redrawn.
bool menu_cardputer_key(SessionKey key, M5Canvas& canvas);

// Call once every pass of loop() while the menu is active. Drives the
// non-blocking GSR calibration wizard ticks and the Wi-Fi Files web server.
// Returns true when the screen should be redrawn.
bool menu_cardputer_poll(M5Canvas& canvas);

// Draws the current menu, Options, or calibration screen into `canvas`.
void menu_cardputer_draw(M5Canvas& canvas);
