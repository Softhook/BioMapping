#pragma once

// The recording session on the Cardputer: allocating and freeing the
// modules, the device functions the shared session (core/biomap_session.c)
// calls, and feeding it keys and the 10 Hz tick from the main loop.
//
// Everything here runs on the main loop. The GSR sensor has its own thread
// (gsr_cardputer.cpp); GPS bytes are parsed on the main loop
// (gps_cardputer.cpp).

#include "biomap_session.h"
#include "sd_logger.h"

// The session and what the screen shows besides it.
struct CardputerSession {
    SessionCore core;
    SdLogger*   logger = nullptr;
    bool        open = false;  // between session_cardputer_begin() and _end()
};

extern CardputerSession g_session;

// Starts a session in `mode`: the modules, then the session itself.
void session_cardputer_begin(BioMapMode mode);

// Call every pass of the main loop, with or without a session. Parses
// GPS bytes, sets the clock from GPS time, and runs the 10 Hz tick when it
// is due. Returns true when the screen should be redrawn.
bool session_cardputer_poll(void);

// One of the six buttons. Returns true when the screen should be redrawn.
// In a GPS mode, OK doesn't start a recording until the clock has GPS
// time: it plays the error sound and sets the notice below instead.
bool session_cardputer_key(SessionKey key);

// True for a few seconds after OK was refused for want of GPS time.
bool session_cardputer_no_time_notice(void);

// Closes a recording that is still open and frees the modules. Called
// after Back, once core.running is false.
void session_cardputer_end(void);

// The session lock, for the screen (see core/biomap_session.h).
void session_cardputer_lock(void);
void session_cardputer_unlock(void);
