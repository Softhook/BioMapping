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

// One-shot log-file pre-allocation, A/B switch (see
// docs/archive/gps_rf_mutex_status.md's "option E" entries). The
// once-per-FLUSH_INTERVAL SD-flush stall grows across a long recording
// (~94 ms -> ~162 ms average over 59 minutes on track 016, consistent with
// FAT fragmentation from repeated small appends). sd_logger_start() grows
// the file to its expected full size once, up front, via storage_file_seek()
// (the only pre-allocation primitive the app SDK exposes — no f_expand
// binding). sd_logger.c's SD_LOGGER_PREALLOC_BYTES is sized for ~90 minutes
// with margin.
// 0 = off (plain append).
// 1 = on: pre-grow once at start, trim the unused tail at stop.
#define BIOMAP_SD_PREALLOC 1

typedef enum {
    BioMapModeGpsGsrRf = 0, // GPS, GSR, and RF all enabled
    BioMapModeGpsGsr,       // GPS and GSR, no RF
    BioMapModeGpsOnly,      // GPS track + RF, no biometrics ("GPS + RF" on the menu)
    BioMapModeGsrOnly,      // GSR waveform viewer, no location, no RF
    BioMapModeDiagnostics,  // GSR diagnostics — raw counts, no graph
    // Live Stream (docs/archive/bluetooth_serial_investigation.md): GPS+GSR captured
    // as normal but sent live over BLE to a phone instead of written to SD —
    // no SdLogger for this mode at all. Deliberately excluded from
    // has_gps()/has_gsr()/has_rf() below (biomap_types.h): those gate the
    // shared CSV-writing tick/render path that this mode does not use — its
    // own session handling reads GpsUart/GsrSensor directly instead (see
    // modules/bt_stream.h).
    BioMapModeLiveStream,
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
// (biomap_session.c). Changing column order here requires matching changes
// to the "%.2f,%.7f,..." format strings.
//
// The _DEBUG schemas add contention/continuity diagnostics — see RowDiag's
// doc comment (biomap_types.h) and docs/archive/gps_rf_mutex_status.md for what each
// column measures and why. tick_dt_ms and the peak-ms columns appear in
// both GPS_GSR and GPS_GSR_RF (not just the RF variant) so an RF-off vs
// RF-on recording of the same route is a direct column-for-column diff.
// gps_reinit_count needs a GPS module, so it is absent from GSR_ONLY; the
// logger and PGA columns are computed in every GSR-bearing mode and so
// appear in all three.
//
// Debug fields are a runtime Options toggle (BioMapApp::debug_fields_enabled,
// off by default), not a compile-time switch: both the _PROD and _DEBUG
// variant of each schema is always compiled in, and key_toggle_recording()
// (biomap_session.c) picks between them per session.
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


