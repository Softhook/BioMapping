#pragma once

// Which of the six buttons a typed character stands for on the Cardputer.
// One table for the keyboard (keys.cpp), keys typed into a serial monitor
// (main.cpp) and the Esc check during a Wi-Fi download
// (wifi_files_cardputer.cpp). Plain C, so the host tests can check it
// (tests/test_cardputer_rules.c).
//
// The Cardputer has no separate arrow keys: the arrows are printed on
// ; . , and / (up, down, left, right), and Esc on the ` key. Each works
// with or without Fn held, so the shifted characters count too. A serial
// monitor also sends Enter as CR or LF (OK), and Esc or Delete (Back).

#include <stdbool.h>

#include "biomap_session.h"  // SessionKey (core/)

#ifdef __cplusplus
extern "C" {
#endif

static inline bool key_map_char(int ch, SessionKey* out) {
    switch(ch) {
    case ';':
    case ':':  *out = SessionKeyUp;    return true;
    case '.':
    case '>':  *out = SessionKeyDown;  return true;
    case ',':
    case '<':  *out = SessionKeyLeft;  return true;
    case '/':
    case '?':  *out = SessionKeyRight; return true;
    case '`':
    case '~':
    case 0x1B:
    case 0x7F: *out = SessionKeyBack;  return true;
    case '\r':
    case '\n': *out = SessionKeyOk;    return true;
    default:   return false;
    }
}

#ifdef __cplusplus
}
#endif
