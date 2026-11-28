#pragma once

// The recording screen on the Flipper (biomap_session_flipper.c). The
// session logic itself is shared: core/biomap_session.h.

#include "core/biomap_config.h"

typedef struct BioMapApp BioMapApp;

// Runs a session in the given mode until the user presses Back. Allocates
// the GPS, GSR, radio, file and Bluetooth modules the mode needs, and
// frees them all before returning.
void run_recording_session(BioMapApp* app, BioMapMode mode);
