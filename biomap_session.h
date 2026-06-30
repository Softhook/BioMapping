// biomap_session.h — Recording session event loop for Bio Mapping
//
// Extracted from biomap.c: the main recording loop that handles UART events,
// key presses, and 10 Hz timer ticks for GSR/GPS data acquisition and logging.

#pragma once

#include "biomap_config.h"

typedef struct BioMapApp BioMapApp;

// Run a recording session for the given mode.  Blocks until the user
// presses Back or an unrecoverable error occurs.
// Allocates GPS, GSR sensor, SD logger, ViewPort, and timer internally;
// cleans them up on return.
void run_recording_session(BioMapApp* app, BioMapMode mode);
