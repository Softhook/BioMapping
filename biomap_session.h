// biomap_session.h — Recording session event loop for Bio Mapping
//
// Extracted from biomap.c: the main recording loop that handles UART events,
// key presses, and 10 Hz timer ticks for GSR/GPS data acquisition and logging.

#pragma once

#include "biomap_config.h"

typedef struct BioMapApp BioMapApp;
typedef struct Session   Session;

// Initialise a Session for the given recording mode.  zoom_enabled is the
// app-level auto-zoom preference (set in Options, survives sessions).
// This is the single place where session state is reset — if a new field
// is added to Session, it MUST be initialised here.
void session_init(Session* s, BioMapMode mode, bool zoom_enabled);

// Tear down a Session: stop timer, close logger, free GPS/GSR modules,
// remove ViewPort from GUI stack.  Safe to call even if init was partial
// (e.g. GPS alloc failed after logger was started).
void session_deinit(Session* s, BioMapApp* app);

// Run a recording session for the given mode.  Blocks until the user
// presses Back or an unrecoverable error occurs.
// Allocates GPS, GSR sensor, SD logger, ViewPort, and timer internally;
// cleans them up on return via session_deinit().
void run_recording_session(BioMapApp* app, BioMapMode mode);
