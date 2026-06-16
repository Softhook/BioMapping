// biomap_config.h — Bio Mapping Runtime Configuration
//
// Central header for mode selection and shared constants.
// Mode is selected at runtime via the launch menu — no compile-time flags.

#pragma once

typedef enum {
    BioMapModeGpsGsr = 0,  // Both GPS and GSR enabled
    BioMapModeGpsOnly,     // GPS track recorder, no biometrics
    BioMapModeGsrOnly,     // GSR waveform viewer, no location
} BioMapMode;
