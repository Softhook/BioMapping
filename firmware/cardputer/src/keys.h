#pragma once

// The Cardputer's keys as the Flipper's six buttons: the characters in
// key_map.h, plus Enter for OK and Del for Back (the bigger key, easier to
// find by feel than `).

#include <M5Cardputer.h>

#include "biomap_session.h"

// The button for the key just pressed, or false if the key isn't one of
// the six. `st` is M5Cardputer.Keyboard.keysState() after a change.
bool keys_to_session(const Keyboard_Class::KeysState& st, SessionKey* out);

// Call once a loop pass, after M5Cardputer.update(). Restarts the keyboard
// if it has stopped (keys.cpp says why it can).
void keys_unstick_poll(void);

// Reads the next character from USB Serial, folding "\r\n" into a single '\r'
// so Enter from any serial terminal counts once across all callers.
bool keys_serial_read_char(int* out_ch);

// Polls M5Cardputer.update() + keys_unstick_poll() + USB Serial during a
// blocking transfer (Wi-Fi Files streaming) and returns true if Back / Esc
// was pressed.
bool keys_poll_back_escape(void);
