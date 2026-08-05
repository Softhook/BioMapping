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

// SD writer control for A/B diagnostics.
// 0 = normal mode (real storage_file_write/storage_file_sync calls)
// 1 = dry-run mode (keeps logger API active but bypasses physical SD I/O)
//     Useful for isolating whether main-loop freezes are caused by SD path.
#define BIOMAP_SD_DRY_RUN 0

// One-shot log-file pre-allocation, A/B switch (2026-08-05 — see
// docs/gps_rf_mutex_status.md's "option E" entries). Track 016 showed the
// once-per-FLUSH_INTERVAL SD-flush stall getting progressively worse across
// a single 59-minute recording (94ms -> 162ms average, consistent with FAT
// fragmentation from repeated small appends). sd_logger_start() growing the
// file to its expected full size once, up front, via storage_file_seek()
// (the only pre-allocation primitive the app SDK actually exposes — no
// f_expand binding exists) is the fix being tested. sd_logger.c's
// SD_LOGGER_PREALLOC_BYTES is sized for ~90 minutes with margin.
// 0 = off (today's plain-append behavior, unchanged).
// 1 = on: pre-grow once at start, trim the unused tail at stop.
#define BIOMAP_SD_PREALLOC 1

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
// flush_peak_ms (2026-08-03): main-thread SD-flush stall attribution,
// added once tracks 116/117 ruled out the three columns above — see
// RowDiag's doc comment and sd_logger.h's sd_logger_get_flush_peak_ms().
//
// log_fill_bytes/log_fill_peak_bytes/log_overflow_count/log_flush_fail_count
// (2026-08-03): logger continuity-pressure telemetry. These columns show
// batch occupancy pressure and explicit write-risk events directly from
// sd_logger.c, independent of GUI timing symptoms.
//
// gps_reinit_count/pga_change_count/i2c_consec_fail (2026-08-05, debug-field
// review — see RowDiag's doc comment, biomap_types.h, for the full
// rationale and what was deliberately left out). gps_reinit_count only
// appears in the two GPS-bearing variants (no GPS module, no reinit
// possible in GSR_ONLY). pga_change_count/i2c_consec_fail appear in all
// three — both are computed unconditionally in every GSR-bearing mode.
//
// prealloc_ms (2026-08-05, BIOMAP_SD_PREALLOC investigation above): how long
// sd_logger_start()'s one-shot file pre-allocation took, in ms. SD-logger
// telemetry like log_fill_bytes, so present in all three variants same as
// those. Session-constant (set once at start, unlike the lifetime-max
// columns above) — see sd_logger.h's sd_logger_get_prealloc_ms().
//
// Debug fields are an Options-menu runtime toggle (BioMapApp::
// debug_fields_enabled, Options > Debug Fields, off by default — 2026-08-05),
// not a compile-time switch: BIOMAP_DEBUG_FIELDS used to gate these behind
// a firmware rebuild. Both the _PROD and _DEBUG variant of each schema are
// always compiled in; key_toggle_recording() (biomap_session.c) picks
// between them per-session based on Session::debug_fields_enabled.
#define BIOMAP_CSV_COLS_GPS_GSR_PROD \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m\n"
#define BIOMAP_CSV_COLS_GPS_GSR_DEBUG \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "tick_dt_ms,gps_rx_drops,nmea_fail,gps_reinit_count,gsr_hz," \
    "i2c_peak_ms,rf_rssi_peak_ms,rf_retune_peak_ms,flush_peak_ms," \
    "log_fill_bytes,log_fill_peak_bytes,log_overflow_count,log_flush_fail_count," \
    "pga_change_count,i2c_consec_fail,prealloc_ms\n"

#define BIOMAP_CSV_COLS_GSR_ONLY_PROD \
    "timestamp,gsr_raw\n"
#define BIOMAP_CSV_COLS_GSR_ONLY_DEBUG \
    "timestamp,gsr_raw,log_fill_bytes,log_fill_peak_bytes,log_overflow_count,log_flush_fail_count," \
    "pga_change_count,i2c_consec_fail,prealloc_ms\n"

// rssi_815/868/915 = raw per-band RSSI peak from the most recent dwell.
#define BIOMAP_CSV_COLS_GPS_GSR_RF_PROD \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "rssi_815,rssi_868,rssi_915\n"
#define BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "rssi_815,rssi_868,rssi_915," \
    "tick_dt_ms,gps_rx_drops,nmea_fail,gps_reinit_count,gsr_hz," \
    "i2c_peak_ms,rf_rssi_peak_ms,rf_retune_peak_ms,flush_peak_ms," \
    "log_fill_bytes,log_fill_peak_bytes,log_overflow_count,log_flush_fail_count," \
    "pga_change_count,i2c_consec_fail,prealloc_ms\n"


