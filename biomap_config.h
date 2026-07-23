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

typedef enum {
    GpsNavModelPedestrian = 0, // Pedestrian (default, dynModel = 3)
    GpsNavModelWrist,          // Wrist-worn (dynModel = 9)
    GpsNavModelVehicle,        // Vehicle / Automotive (dynModel = 4)
    GpsNavModelStationary,     // Stationary / Seated baseline (dynModel = 2)
    GpsNavModelSea,            // Sea / Boating / Kayaking (dynModel = 5)
    GpsNavModelBike,           // Bicycle (dynModel = 10)
    GpsNavModelFlight,         // Commercial Flight / Airborne <2g (dynModel = 7)
} GpsNavModel;

// ── CSV column headers ────────────────────────────────────────────────
// Must stay in sync with the printf format strings in format_gps_csv_row()
// (biomap_session.c).  Changing column order here requires matching changes
// to the "%.2f,%.7f,..." format strings.
#define BIOMAP_CSV_COLS_GPS_GSR  "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw\n"
#define BIOMAP_CSV_COLS_GSR_ONLY "timestamp,gsr_raw\n"
