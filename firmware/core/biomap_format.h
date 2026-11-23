// biomap_format.h — CSV row formatting and pure numeric helpers.
//
// Plain C with no device code, no module headers and no I/O.
// These functions are linked directly by tests/test_firmware.c
// rather than mirrored, so a change to the CSV column layout or the
// calibration fit shows up in the existing golden-output assertions instead
// of silently diverging.
//
// The callers (core/biomap_session.c, core/cal_wizard.c and each device's
// own code) own the glue around them: the SD writes, the locks, the cues.

#pragma once

#include "biomap_types.h"

#ifdef __cplusplus
extern "C" {
#endif

// Format one GPS+GSR CSV row into `out` (NUL-terminated, trailing '\n'
// included). Returns the byte count written (excluding the NUL), or -1 if
// the row would not fit in `cap`.
//
// The row is 11 GPS/GSR columns ending in hacc_m (horizontal accuracy in
// metres, PUBX 00; 99.9 = unknown). When the fix is absent the GPS columns
// are left empty so the analyser treats the row as a gap rather than noise.
//
//   debug_fields  append the RowDiag contention columns (Options > Debug Fields)
//   pos           GPS snapshot; pos->valid == false emits empty GPS columns
//   rel           relative timestamp in seconds — the first column
//   raw           GSR value in nS for the gsr_raw column
//   rf_rssi       NULL when RF scanning is inactive, otherwise an
//                 EM_SCAN_NUM_FREQS-element snapshot appended as 3 extra
//                 columns rssi_815,rssi_868,rssi_915 (raw per-band RSSI,
//                 one read per band from the last sweep)
//   diag          RowDiag contention columns; only read when debug_fields
//
// Pure formatter: the caller writes `out` to the SD batch with ONE
// sd_logger_batch_append() so a partially-built row can never be committed
// (see append_gps_csv_row() in core/biomap_session.c).
int biomap_format_gps_row(char* out, size_t cap, bool debug_fields,
                          const GpsPosition* pos, double rel, float raw,
                          const float* rf_rssi, const RowDiag* diag);

// Format one GSR-only CSV row into `out` (NUL-terminated, trailing '\n'
// included). Returns the byte count written (excluding the NUL), or -1 if
// the row would not fit in `cap`.
//
// The row is two columns (timestamp,gsr_raw). With debug_fields it appends
// the seven SD/I2C contention columns the GSR-only schema carries
// (BIOMAP_CSV_COLS_GSR_ONLY_DEBUG) — a subset of the RowDiag fields, since
// this mode has no GPS or RF pipeline to report on.
//
//   debug_fields  append the RowDiag contention columns (Options > Debug Fields)
//   rel           relative timestamp in seconds — the first column
//   raw           GSR value in nS for the gsr_raw column
//   diag          RowDiag contention columns; only read when debug_fields
//
// Pure formatter: the caller writes `out` with ONE sd_logger_batch_append()
// (see batch_csv_row() in core/biomap_session.c).
int biomap_format_gsr_row(char* out, size_t cap, bool debug_fields,
                          double rel, float raw, const RowDiag* diag);

// "# GSR Bias: measured_mv:<x>,used_mv:<y>\n" — the CSV header line for the
// bias check made at recording start (gsr_sensor.h, "When it is measured").
// measured_v is what the check read (NAN if it failed or timed out:
// written "none"); used_v is the bias the TIA equation applies for the
// whole recording. They differ only when the reading was out of range.
// Returns the length written, or -1 if it didn't fit.
int biomap_format_gsr_bias_line(char* out, size_t cap, float measured_v, float used_v);

// Move a list selection by one step with wraparound: Up on the first item
// jumps to the last, Down on the last item jumps back to the first — used
// by the main menu, Options screen, and GSR/RF calibration submenus so all
// the list screens navigate the same way.
int32_t cycle_selection(int32_t sel, int32_t count, bool down);

// The Options screen's short name for a GPS profile ("PED", "WRIST", ...),
// on both devices. "?" for a value that isn't a GpsNavModel.
const char* biomap_nav_model_label(GpsNavModel model);

// Three-point relative least-squares fit through the origin,  y = gain * x
// (x = measured nS with the open-circuit zero already removed, y = target nS),
// minimizing percentage error equally across all three points, plus an R²
// goodness-of-fit. No offset term: the zero is measured directly, so the fit
// does not have to guess it by extending a line from 2 000–21 000 nS down to
// 0, which magnified small errors at the calibration points into several nS
// at high resistances.
//
// ALWAYS writes *out_gain / *out_r_squared — even on a degenerate or
// out-of-bounds fit — so the fit-fail screen (calibration_wizard_render
// step 10) can show the user how far out of range their device is rather
// than a fixed placeholder. The bool return is the sole validity signal
// (gain bounds plus R² ≥ 0.95); a false return does NOT mean the outputs
// are undefined.
bool calibration_wizard_compute_fit(const float measured[CAL_POINTS],
                                    const float targets[CAL_POINTS],
                                    float* out_gain, float* out_r_squared);

// Pre-flight noise/resolution grade for one calibration resistor's measured
// σ (nS) — see the CAL_NOISE_*_NS thresholds (biomap_config.h) and the
// CalDwell accumulator below, which computes σ across the full resistor
// dwell in a single pass. CalNoisePoor
// fails the wizard outright (WizardStepNoiseFailed, core/cal_wizard.h) —
// Excellent/Acceptable both pass and are shown on the success screen.
typedef enum {
    CalNoiseExcellent = 0,
    CalNoiseAcceptable = 1,
    CalNoisePoor = 2,
} CalNoiseGrade;

CalNoiseGrade calibration_noise_grade(float std_dev_ns);

// ── Calibration dwell: averaging one wizard step ─────────────────────
// The calibration wizard takes one reading per tick for CAL_DWELL_SECONDS
// at each step: the open-circuit zero (window mean counts, gate
// ±CAL_ZERO_MAX_COUNTS) and each resistor (nS, that resistor's gate).
// Readings inside [lo, hi] go into the mean and σ, in a single Welford
// pass: the count, mean and M2 are updated as each reading arrives rather
// than stored and revisited, same running-accumulator shape as
// em_scan_cal_compute_stats() (flipper/em_scan_cal.c) uses for the RF
// noise floor. At this sample count the mean needs no min/max trim — one
// outlier among CAL_DWELL_SECONDS*TICK_HZ readings has negligible
// leverage. Readings outside the gate are counted as below or above
// (anything that is not >= lo, such as NAN, counts as above), and every
// reading goes into sum_all, so a failed step can still show what was read.
typedef struct {
    int   in_gate;    // readings inside [lo, hi]
    int   below;      // readings < lo
    int   above;      // readings > hi
    float mean;       // running mean of the in-gate readings
    float m2;         // running sum of squared deviations from it
    int   all;        // every reading
    float sum_all;    // sum of every reading
} CalDwell;

void cal_dwell_init(CalDwell* d);
void cal_dwell_add(CalDwell* d, float v, float lo, float hi);

// True once at least CAL_MIN_VALID readings landed in the gate: the step
// passed, and mean / cal_dwell_std() are its result.
bool cal_dwell_ok(const CalDwell* d);

// Sample standard deviation of the in-gate readings (n − 1). 0 with fewer
// than two in-gate readings.
float cal_dwell_std(const CalDwell* d);

// Mean of every reading, in gate or not. 0 if there were none.
float cal_dwell_mean_all(const CalDwell* d);

// Canonical calibration targets (nS) and valid-range gates [lo, hi] (nS)
// for the three calibration resistors (470k, 100k, 47k).
extern const float biomap_cal_targets[CAL_POINTS];
extern const float biomap_cal_gates[CAL_POINTS][2];

// Worst-case (highest) noise σ across the three calibration resistors (nS).
float biomap_cal_worst_noise_std_dev(const float noise_std_dev[CAL_POINTS]);

// ── Calibration and settings records (on-disk formats) ────────────────
// The records each device reads from and writes to its SD card, and the
// checks a loaded record must pass before it is applied. Kept here, SDK-free,
// so tests/test_firmware.c checks this exact validation rather than a copy;
// each device owns the file I/O and the log messages (the Flipper's in
// biomap.c, the Cardputer's in cardputer/src/settings_cardputer.cpp).

#define BIOMAP_CAL_MAGIC   0x424D4341
// v3 added the `timestamp` (Unix epoch at save) and `r_squared` (wizard fit
// goodness) fields. v4 added `noise_std_dev` (per-resistor σ, nS, from the
// wizard's pre-flight noise/resolution check — see CalNoiseGrade above). v5
// has the same layout, but the wizard's measurements now include the
// measured 0.5 V bias (gsr_sensor.h, GSR_BIAS_*), so a v4 fit would correct
// for the bias a second time. A file at an older version fails the version
// check and is ignored — GSR falls back to the default 1.0/0.0 transform
// until the wizard is re-run, same as any other format change. v6 replaces
// the nS `offset` with `zero_counts`: the wizard now measures the board's
// zero with nothing connected and removes it before the nS conversion, and
// the fit finds a gain only.
#define BIOMAP_CAL_VERSION 6

typedef struct {
    uint32_t magic;
    uint32_t version;
    float    gain;
    float    zero_counts;  // open-circuit reading, normalised counts; subtracted before the TIA conversion
    uint32_t timestamp;  // Unix epoch (RTC) when saved; 0 if the RTC was unset
    float    r_squared;  // wizard least-squares fit goodness (0..1); 0 if unknown
    float    noise_std_dev[CAL_POINTS];  // per-resistor σ (nS) from the wizard's noise check
    uint32_t checksum;
} BioMapCalibration;

typedef enum {
    CalRecordOk = 0,
    CalRecordBadMagic,
    CalRecordBadVersion,
    CalRecordBadChecksum,
    // gain outside CAL_GAIN_*, |zero_counts| above CAL_ZERO_MAX_COUNTS
    // (biomap_config.h), or a
    // noise σ that is NaN, negative, or would grade CalNoisePoor — a Poor
    // σ never reaches a save, so on disk it can only mean corruption.
    CalRecordOutOfBounds,
} CalRecordStatus;

// FNV-1a over every field before `checksum`.
uint32_t biomap_calibration_checksum(const BioMapCalibration* cal);

// Checks in order: magic → version → checksum → value bounds; returns the
// first failure.
CalRecordStatus biomap_calibration_check(const BioMapCalibration* cal);

// A record ready to write: magic, version and checksum filled in.
BioMapCalibration biomap_calibration_make(float gain, float zero_counts, uint32_t timestamp,
                                          float r_squared,
                                          const float noise_std_dev[CAL_POINTS]);

// Why a loaded record was ignored, for the log ("checksum mismatch").
const char* biomap_calibration_status_text(CalRecordStatus status);

// Options-menu settings (Auto-zoom, Backlight, Sound, GPS Profile, Debug
// Fields). A file whose version doesn't match BIOMAP_SETTINGS_VERSION fails
// biomap_settings_valid() and the app falls back to defaults — so a version
// bump is all a schema change needs.
#define BIOMAP_SETTINGS_MAGIC    0x424D4753
#define BIOMAP_SETTINGS_VERSION  4

typedef struct {
    uint32_t magic;
    uint32_t version;
    bool     zoom_enabled;
    bool     backlight_on;
    bool     sound_enabled;
    uint32_t nav_model;
    bool     super_s;
    bool     debug_fields_enabled;
    uint32_t checksum;
} BioMapSettings;

// FNV-1a over every field before `checksum`.
uint32_t biomap_settings_checksum(const BioMapSettings* s);

// Magic, version, checksum, and nav_model a real GpsNavModel.
bool biomap_settings_valid(const BioMapSettings* s);

// Start-time part of a recording's file name: "YYYY-MM-DD_HH-MM-SS", e.g.
// "2026-11-19_14-32-05". ISO 8601 order (largest unit first) so files sort
// by time, with "-" in place of ":" because ":" is not allowed in FAT file
// names. The time is the Flipper clock's local time. Returns the length
// written, or -1 if it would not fit in `cap` (needs 20 bytes).
int biomap_format_file_stamp(char* out, size_t cap, uint16_t year, uint8_t month, uint8_t day,
                             uint8_t hour, uint8_t minute, uint8_t second);

// ── Live Stream packet ──────────────────────────────────────────────────
// One 49-byte update sent to the visualiser's Live tab over Bluetooth
// (visualiser/src/live/live_binary_parser.mjs reads it), little-endian:
//   0  'B','N'          6  lat (double)    14 lon (double)
//   2  timestamp_ms     22 gsr_raw (nS)    26 hdop   30 pdop
//   34 speed_kts        38 course_deg      42 sats (u8)  43 fix_type (u8)
//   44 position valid (u8)                 45 hacc_m (float)
// lat/lon are 0 without a fix; an unknown speed or course is sent as 0.
#define BT_STREAM_PACKET_SIZE 49

void bt_stream_pack_packet(uint8_t out[BT_STREAM_PACKET_SIZE],
                           uint32_t timestamp_ms,
                           const GpsPosition* pos,
                           float gsr_raw);

#ifdef __cplusplus
}
#endif
