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
//                 columns rssi_815,rssi_868,rssi_915 (raw per-band peak
//                 from the last dwell)
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
