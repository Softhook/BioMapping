// biomap_format.h — CSV row formatting and pure numeric helpers.
//
// Host-testable: the .c uses only FURI_LOG_W from the SDK (the host test
// build resolves it to the tests/shims/ no-op). No module headers, no I/O.
// These functions are linked directly by tests/test_firmware.c
// rather than mirrored, so a change to the CSV column layout or the
// calibration fit shows up in the existing golden-output assertions instead
// of silently diverging.
//
// Callers in biomap_session.c / biomap_gui.c own the SDK glue around them
// (SD batch append, app->mutex, notification sounds).

#pragma once

#include "biomap_types.h"

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
// (see append_gps_csv_row() in biomap_session.c).
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
// (see batch_csv_row() in biomap_session.c).
int biomap_format_gsr_row(char* out, size_t cap, bool debug_fields,
                          double rel, float raw, const RowDiag* diag);

// Move a list selection by one step with wraparound: Up on the first item
// jumps to the last, Down on the last item jumps back to the first — used
// by the main menu, Options screen, and GSR/RF calibration submenus so all
// the list screens navigate the same way.
int32_t cycle_selection(int32_t sel, int32_t count, bool down);

// Three-point linear least-squares fit  y = gain * x + offset  (x = measured
// nS, y = target nS) plus an R² goodness-of-fit.
//
// ALWAYS writes *out_gain / *out_offset / *out_r_squared — even on a
// degenerate (collinear) or out-of-bounds fit — so the fit-fail screen
// (calibration_wizard_render step 10) can show the user how far out of
// range their device is rather than a fixed placeholder. The bool return
// is the sole validity signal (bounds in the nS domain plus R² ≥ 0.95); a
// false return does NOT mean the outputs are undefined.
bool calibration_wizard_compute_fit(const float measured[CAL_POINTS],
                                    const float targets[CAL_POINTS],
                                    float* out_gain, float* out_offset,
                                    float* out_r_squared);

// Pre-flight noise/resolution grade for one calibration resistor's measured
// σ (nS) — see the CAL_NOISE_*_NS thresholds (biomap_config.h) and
// calibration_wizard_measure()'s Welford accumulator (biomap_gui.c), which
// computes σ across the full resistor dwell in a single pass. CalNoisePoor
// fails the wizard outright (WizardStepNoiseFailed in biomap_gui.c) —
// Excellent/Acceptable both pass and are shown on the success screen.
typedef enum {
    CalNoiseExcellent = 0,
    CalNoiseAcceptable = 1,
    CalNoisePoor = 2,
} CalNoiseGrade;

CalNoiseGrade calibration_noise_grade(float std_dev_ns);

// ── Calibration and settings records (on-disk formats) ────────────────
// The records biomap.c reads from and writes to the SD card, and the checks
// a loaded record must pass before it is applied. Kept here, SDK-free, so
// tests/test_firmware.c checks this exact validation rather than a copy;
// biomap.c owns the file I/O and the log messages.

#define BIOMAP_CAL_MAGIC   0x424D4341
// v3 added the `timestamp` (Unix epoch at save) and `r_squared` (wizard fit
// goodness) fields. v4 added `noise_std_dev` (per-resistor σ, nS, from the
// wizard's pre-flight noise/resolution check — see CalNoiseGrade above). A
// file at an older version fails the version check and is ignored — GSR
// falls back to the default 1.0/0.0 transform until the wizard is re-run,
// same as any other format change.
#define BIOMAP_CAL_VERSION 4

typedef struct {
    uint32_t magic;
    uint32_t version;
    float    gain;
    float    offset;
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
    // gain/offset outside CAL_GAIN_*/CAL_OFFSET_* (biomap_config.h), or a
    // noise σ that is NaN, negative, or would grade CalNoisePoor — a Poor
    // σ never reaches a save, so on disk it can only mean corruption.
    CalRecordOutOfBounds,
} CalRecordStatus;

// FNV-1a over every field before `checksum`.
uint32_t biomap_calibration_checksum(const BioMapCalibration* cal);

// Checks in order: magic → version → checksum → value bounds; returns the
// first failure.
CalRecordStatus biomap_calibration_check(const BioMapCalibration* cal);

// Options-menu settings (Auto-zoom, Backlight, Sound, GPS Profile, Debug
// Fields). A file whose version doesn't match BIOMAP_SETTINGS_VERSION fails
// biomap_settings_valid() and the app falls back to defaults — so a version
// bump is all a schema change needs.
#define BIOMAP_SETTINGS_MAGIC    0x424D4753
#define BIOMAP_SETTINGS_VERSION  3

typedef struct {
    uint32_t magic;
    uint32_t version;
    bool     zoom_enabled;
    bool     backlight_on;
    bool     sound_enabled;
    uint32_t nav_model;
    bool     debug_fields_enabled;
    uint32_t checksum;
} BioMapSettings;

// FNV-1a over every field before `checksum`.
uint32_t biomap_settings_checksum(const BioMapSettings* s);

// Magic, version, checksum, and nav_model a real GpsNavModel.
bool biomap_settings_valid(const BioMapSettings* s);
