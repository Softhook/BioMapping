// biomap_config.h — Bio Mapping Runtime Configuration
//
// Central header for mode selection and shared constants.
// Mode is selected at runtime via the launch menu — no compile-time flags.

#pragma once

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

// Radio (EM) scan bands: 815, 868 and 915 MHz, in that order — the
// rssi_815,rssi_868,rssi_915 CSV columns and the "# Band Floors" header
// line. The Flipper's radio code (modules/em_scan_rf.h, EM_SCAN_NUM_FREQS)
// must agree; flipper/biomap_session_flipper.c checks that it does.
#define RF_BAND_COUNT 3

// The bands' names, in MHz and in the same order: the one list the screen's
// labels, the "# Band Floors" line and the Flipper's radio code are built
// from. The CSV column names above spell them out (they are the file
// format); tests/test_session.c checks they agree with this list.
#define RF_BAND_0_MHZ "815"
#define RF_BAND_1_MHZ "868"
#define RF_BAND_2_MHZ "915"

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
    GpsNavModelBike,           // Bicycle (dynModel = 0, Portable — see gps_uart.c)
    GpsNavModelFlight,         // Commercial Flight / Airborne <2g (dynModel = 7)
    GpsNavModelCount,          // sentinel — number of valid GpsNavModel values, not a real mode
} GpsNavModel;

// ── GSR calibration fit ──────────────────────────────────────────────
// Used by biomap_format.c's calibration_wizard_compute_fit(), by the
// Flipper and Cardputer calibration wizards, and by calibration file
// loading on both devices.
#define CAL_POINTS       3        // resistors measured: 470k, 100k, 47k

// Calibration targets — true physical skin conductance (nanosiemens).
// These are 1/R for each calibration resistor: 1e9 / R_ohms.
// Derived from the TIA circuit equation (see gsr_sensor.h):
//   nS = norm × 5 000 000 / (15 040 000 − 47 × norm)
// where norm is the ideal normalised ADC count for resistor R.
#define CAL_TARGET_470K  2127.66f   // 1e9 / 470000
#define CAL_TARGET_100K  10000.0f   // 1e9 / 100000
#define CAL_TARGET_47K   21276.6f   // 1e9 / 47000

// Valid-range gates for each resistor during calibration (nS).
// The fit's gain is a CORRECTION (target = gain × measured), so a device
// needing gain g reads target / g: CAL_GAIN_MIN (0.2) means the device
// reads 5× high, CAL_GAIN_MAX (5.0) means it reads 5× low.
//
// These gates admit a narrower range than the fit bounds. With the
// zero removed, each resistor's gate [lo, hi] admits gain in [target/hi,
// target/lo]:
//   470k: [0.71, 10.6]   100k: [0.40, 3.33]   47k: [0.47, 4.26]
// so only a device needing gain ≈ 0.71–3.33 can complete the wizard.
// Both binding limits come from CAL_MID_GATE_LO, which is the 470k upper
// bound (a device reading more than ~41 % high fails) AND the 100k lower
// bound (a device reading more than ~3.3× low fails) — so moving it
// widens one side only by narrowing the other. Left as-is pending a
// hardware-informed re-tune.
#define CAL_LO_GATE        200.0f
#define CAL_MID_GATE_LO   3000.0f
#define CAL_MID_GATE_HI  25000.0f
#define CAL_LO_GATE_47K   5000.0f
#define CAL_HI_GATE      45000.0f

// Valid-range bounds for a computed or loaded gain — a wizard fit or a
// loaded calibration file outside them is rejected.
#define CAL_GAIN_MIN     0.2f
#define CAL_GAIN_MAX     5.0f

// Largest zero reading (normalised counts, 7.8125 µV each, either sign) the
// wizard's open-circuit step accepts, and a loaded file may hold. 2000
// counts is ~15.6 mV at the ADC, several times the worst MCP6002 input
// offset (4.5 mV); a reading beyond it means something is still connected.
#define CAL_ZERO_MAX_COUNTS  2000.0f

// Every calibration dwell (the open-circuit zero and each resistor):
// CAL_DWELL_SECONDS of readings at TICK_HZ, of which CAL_MIN_VALID (60 %)
// must land in-gate — same ratio the original 20-sample/12-valid window
// used. See CalDwell in biomap_format.h.
#define CAL_DWELL_SECONDS    20
#define CAL_MIN_VALID        120

// Pre-dwell ring-buffer flush ticks (at TICK_HZ = 10 Hz) before sampling:
//   CAL_ZERO_FLUSH_TICKS (20 ticks = 2 s): lets autoranging climb from the
//     default PGA 2 to the most sensitive PGA 5 (each step up takes 5 low
//     ticks = 1.5 s total) when nothing is connected.
//   CAL_RESISTOR_FLUSH_TICKS (10 ticks = 1 s): clears pre-measurement click
//     noise and lets the ring buffer fill with the new resistor's reading.
//   CAL_POST_BIAS_FLUSH_TICKS (2 ticks = 200 ms): clears the ~50 ms gap
//     left by the 0.5 V bias check before the resistor dwell begins.
#define CAL_ZERO_FLUSH_TICKS       20
#define CAL_RESISTOR_FLUSH_TICKS   10
#define CAL_POST_BIAS_FLUSH_TICKS   2

// ── GSR pre-flight noise/resolution gate ───────────────────────────────
// Grades the σ (standard deviation, nS) of the raw readings collected
// during each resistor's calibration dwell — see calibration_noise_grade()
// in biomap_format.c and the CalDwell accumulator (biomap_format.h). Units are nS, same scale as CAL_TARGET_*/
// CAL_*_GATE above; the µS figures a human reads off a datasheet
// are these ÷ 1000 (1 µS = 1000 nS).
//   σ < CAL_NOISE_EXCELLENT_NS   -> Excellent (3σ resolution < 6 nS / 0.006 µS)
//   σ < CAL_NOISE_ACCEPTABLE_NS  -> Acceptable (3σ resolution < 30 nS / 0.030 µS)
//   σ >= CAL_NOISE_ACCEPTABLE_NS -> Poor — fails the wizard outright, cannot save.
#define CAL_NOISE_EXCELLENT_NS    2.0f
#define CAL_NOISE_ACCEPTABLE_NS  10.0f

// Calibration wizard step numbers — shared by the Flipper and Cardputer
// wizards (starts at WizardStepPromptZero):
//   13 = prompt zero (nothing connected)   14 = measure zero
//   0 = prompt 470k    4 = prompt 47k      8  = success
//   1 = measure 470k   5 = measure 47k     9  = measurement fail
//   2 = prompt 100k    6 = compute fit     10 = fit fail (bounds / R²)
//   3 = measure 100k   7 = (unused)        11 = noise/resolution fail (σ too high)
//   12 = bias check fail                   15 = zero fail (out of range / noisy)
enum {
    WizardStepPrompt470k    = 0,
    WizardStepMeasuring470k = 1,
    WizardStepPrompt100k    = 2,
    WizardStepMeasuring100k = 3,
    WizardStepPrompt47k     = 4,
    WizardStepMeasuring47k  = 5,
    WizardStepFitPending    = 6,
    WizardStepSuccess       = 8,
    WizardStepMeasureFailed = 9,
    WizardStepFitFailed     = 10,
    WizardStepNoiseFailed   = 11,
    WizardStepBiasFailed    = 12,
    WizardStepPromptZero    = 13,
    WizardStepMeasuringZero = 14,
    WizardStepZeroFailed    = 15,
};

// ── CSV column headers ────────────────────────────────────────────────
// Must stay in sync with the printf format strings in biomap_format_gps_row()
// (biomap_format.c). Changing column order here requires matching changes
// to the "%.2f,%.7f,..." format strings. test_csv_header_matches_row_column_count
// (tests/test_firmware.c) links the real formatter and asserts the counts agree.
//
// The visualiser's Live Stream CSV export mirrors this GPS+GSR schema; its
// test_firmware_csv_contract.js reads this header directly, so a column
// change here also turns the visualiser suite red until live_csv.js follows.
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
// variant of each schema is always compiled in, and build_header()
// (core/biomap_session.c) picks between them per session.
#define BIOMAP_CSV_COLS_GPS_GSR_PROD \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m\n"
#define BIOMAP_CSV_COLS_GPS_GSR_DEBUG \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "tick_dt_ms,gps_rx_drops,nmea_fail,gps_reinit_count,gsr_hz," \
    "i2c_peak_ms,rf_rssi_peak_ms,rf_retune_peak_ms,flush_peak_ms," \
    "log_fill_bytes,log_fill_peak_bytes,log_overflow_count,log_flush_fail_count," \
    "pga_change_count,i2c_consec_fail,prealloc_ms,gsr_spread_ns\n"

#define BIOMAP_CSV_COLS_GSR_ONLY_PROD \
    "timestamp,gsr_raw\n"
#define BIOMAP_CSV_COLS_GSR_ONLY_DEBUG \
    "timestamp,gsr_raw,log_fill_bytes,log_fill_peak_bytes,log_overflow_count,log_flush_fail_count," \
    "pga_change_count,i2c_consec_fail,prealloc_ms,gsr_spread_ns\n"

// rssi_815/868/915 = raw per-band RSSI, one instantaneous read per band from
// the most recent ~10 Hz sweep (em_scan_rf_fast_sweep_snapshot, no dwell).
#define BIOMAP_CSV_COLS_GPS_GSR_RF_PROD \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "rssi_815,rssi_868,rssi_915\n"
#define BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG \
    "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
    "rssi_815,rssi_868,rssi_915," \
    "tick_dt_ms,gps_rx_drops,nmea_fail,gps_reinit_count,gsr_hz," \
    "i2c_peak_ms,rf_rssi_peak_ms,rf_retune_peak_ms,flush_peak_ms," \
    "log_fill_bytes,log_fill_peak_bytes,log_overflow_count,log_flush_fail_count," \
    "pga_change_count,i2c_consec_fail,prealloc_ms,gsr_spread_ns\n"


