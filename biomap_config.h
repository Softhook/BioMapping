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
    BioMapModeGpsGsrRf = 0, // GPS, GSR, and RF all enabled
    BioMapModeGpsGsr,       // GPS and GSR, no RF
    BioMapModeGpsOnly,      // GPS track + RF, no biometrics ("GPS + RF" on the menu)
    BioMapModeGsrOnly,      // GSR waveform viewer, no location, no RF
    BioMapModeDiagnostics,  // GSR diagnostics — raw counts, no graph
} BioMapMode;

typedef enum {
    GpsNavModelPedestrian = 0, // Pedestrian (default, dynModel = 3)
    GpsNavModelWrist,          // Wrist-worn (dynModel = 9)
    GpsNavModelVehicle,        // Vehicle / Automotive (dynModel = 4)
    GpsNavModelStationary,     // Stationary / Seated baseline (dynModel = 2)
    GpsNavModelSea,            // Sea / Boating / Kayaking (dynModel = 5)
    GpsNavModelBike,           // Bicycle (dynModel = 10)
    GpsNavModelFlight,         // Commercial Flight / Airborne <2g (dynModel = 7)
    GpsNavModelCount,          // sentinel — number of valid GpsNavModel values, not a real mode
} GpsNavModel;

// ── CSV column headers ────────────────────────────────────────────────
// Must stay in sync with the printf format strings in format_gps_csv_row()
// (biomap_session.c).  Changing column order here requires matching changes
// to the "%.2f,%.7f,..." format strings.
//
// tick_dt_ms/gps_rx_drops/nmea_fail/gsr_hz (2026-07-31): real, measured
// contention diagnostics added alongside the GPS/RF mutex fix — see
// docs/gps_rf_mutex_status.md and RowDiag's doc comment (biomap_types.h).
// Present in both GPS_GSR and GPS_GSR_RF (not just the RF variant) so an
// RF-off vs RF-on recording of the same route is a direct column-for-column
// diff, not a comparison across differently-shaped files.
//
// i2c_peak_ms/rf_rssi_peak_ms/rf_retune_peak_ms (2026-08-03): per-call
// stall-attribution columns added alongside the above — see RowDiag's doc
// comment and gsr_sensor.h's gsr_sensor_get_*_peak_ms() accessors.
//
// flush_peak_ms briefly lived here too (2026-08-03) but was removed the
// same day: the SD flush it timed now runs on its own thread
// (modules/sd_logger.c) instead of blocking the caller, the more direct
// fix for the stall it was diagnosing — see docs/gps_rf_mutex_status.md.
#define BIOMAP_CSV_COLS_GPS_GSR  \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "tick_dt_ms,gps_rx_drops,nmea_fail,gsr_hz," \
    "i2c_peak_ms,rf_rssi_peak_ms,rf_retune_peak_ms\n"
#define BIOMAP_CSV_COLS_GSR_ONLY "timestamp,gsr_raw\n"
// rssi_815/868/915 = raw per-band RSSI peak from the most recent dwell.
#define BIOMAP_CSV_COLS_GPS_GSR_RF \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "tick_dt_ms,gps_rx_drops,nmea_fail,gsr_hz," \
    "i2c_peak_ms,rf_rssi_peak_ms,rf_retune_peak_ms," \
    "rssi_815,rssi_868,rssi_915\n"


