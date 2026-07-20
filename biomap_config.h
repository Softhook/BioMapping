// biomap_config.h — Bio Mapping Runtime Configuration
//
// Central header for mode selection and shared constants.
// Mode is selected at runtime via the launch menu — no compile-time flags.

#pragma once

// ── GPS module selection — set BEFORE building ────────────────────────
// Only one firmware image is produced; change this define when you swap the
// physical GPS board connected to the Flipper Zero.
//   GPS_MODULE_L76K  = Quectel L76K (PCAS commands, external U.FL antenna)
//   GPS_MODULE_M10Q  = u-blox SAM-M10Q (UBX commands, integrated patch antenna)
#define GPS_MODULE_L76K  1
#define GPS_MODULE_M10Q  2
#define GPS_MODULE       GPS_MODULE_M10Q

typedef enum {
    BioMapModeGpsGsr = 0,  // Both GPS and GSR enabled
    BioMapModeGpsOnly,     // GPS track recorder, no biometrics
    BioMapModeGsrOnly,     // GSR waveform viewer, no location
    BioMapModeDiagnostics, // GSR diagnostics — raw counts, no graph
} BioMapMode;
