#pragma once

// The Cardputer's keys as the Flipper's six buttons.
//
// The Cardputer has no separate arrow keys: the arrows are printed on
// ; . , and / (up, down, left, right), and Esc on the ` key. Each works
// with or without Fn held. Enter is OK. Del also counts as Back, because
// it is the bigger key and easier to find by feel.

#include <M5Cardputer.h>

#include "biomap_session.h"

// The button for the key just pressed, or false if the key isn't one of
// the six. `st` is M5Cardputer.Keyboard.keysState() after a change.
bool keys_to_session(const Keyboard_Class::KeysState& st, SessionKey* out);

// "Up", "OK" and so on, for the screen and the log.
const char* keys_session_name(SessionKey key);

// Call once a loop pass, after M5Cardputer.update(). Restarts the keyboard
// if it has stopped (keys.cpp says why it can).
void keys_unstick_poll(void);
