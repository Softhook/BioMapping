#pragma once

// em_scan_rf.h — CC1101 sub-GHz RSSI sweep.
//
// Isolates every furi_hal_subghz_* call in one place (em_scan_rf.c). See
// docs/peak_density_vs_spatial_clustering.md §6E/§6F for the original full
// 4-band EM-Fog Index design this is a cut-down feasibility test of.
//
// Two live entry points: em_scan_rf_dwell_band() (RF calibration wizard,
// biomap_rf_cal.c — one band, peak-hold over a short dwell) and
// em_scan_rf_fast_sweep_snapshot() (GSR worker's RF path, gsr_sensor.c —
// all bands, one RSSI read each).

#include <stdint.h>

// Single source of truth for the band count — em_scan_cal.h includes this
// header rather than defining its own copy, so adding/removing a band only
// needs three edits, all in this file/em_scan_rf.c: this count, and the two
// arrays below (em_scan_freq_hz/em_scan_freq_label in em_scan_rf.c).
// Everything else (UI bars, CSV columns, calibration struct sizing) is
// already sized off this constant. Note: bumping EM_SCAN_CAL_VERSION in
// em_scan_cal.h is also required whenever this count changes, since it
// changes the on-disk calibration struct's size — see em_scan_cal.h.
#define EM_SCAN_NUM_FREQS 3

// Spot frequencies to sweep, in Hz. Focused on the 3 high-frequency sub-GHz bands:
// 815 MHz (LTE Band 20 downlink edge), 868 MHz (EU SRD / Smart Grid), and 915 MHz (US ISM / RFID).
// Lower frequencies (300, 315, 434, 446 MHz) were dropped due to CC1101 internal antenna
// mismatch and self-noise floor (~-76 dBm), whereas 815-915 MHz achieve a clean -91.5 dBm
// noise floor in Faraday box testing.
extern const uint32_t em_scan_freq_hz[EM_SCAN_NUM_FREQS];
extern const char* const em_scan_freq_label[EM_SCAN_NUM_FREQS];

// Powers up the CC1101 and loads an RX preset. Call once at app start.
void em_scan_rf_init(void);

// Powers down the CC1101. Call once at app exit.
void em_scan_rf_deinit(void);

// Tunes to ONE band (band_index into em_scan_freq_hz/em_scan_freq_label),
// discards a short AGC/PLL warm-up, then polls RSSI repeatedly over an
// active dwell window and returns the MAXIMUM reading seen — not a single
// snapshot. Real ISM/keyfob/RFID traffic is bursty (a transmission can
// last a few ms then go silent for seconds); a single point-sample has a
// low chance of landing inside a burst, which is why an earlier version of
// this function (one instantaneous read per band) looked "similar
// everywhere" — it was mostly measuring the quiet floor between bursts,
// not the bursts themselves. Peak-hold-over-a-dwell is the standard
// spectrum-analyser "max hold" technique for exactly this problem.
//
// Leaves the radio idle when done, same duty-cycled approach as the
// original EM-Fog plan (§6F). Called round-robin, one band per iteration,
// by the RF calibration wizard (biomap_rf_cal.c).
void em_scan_rf_dwell_band(int band_index, float* out_peak_dbm);

// Performs a single-pass 3-band sweep in ~10 ms: a single RSSI read per
// band (no dwell/park polling window) after each band's normal, known-safe
// em_scan_rf_tune_and_warmup() retune. See the doc comment on this
// function's definition in em_scan_rf.c for why this does NOT try to stay
// in RX across bands — an earlier version did, modelled on the official
// Flipper Zero Frequency Analyzer app, and froze the device on real
// hardware on the very first sweep.
//
// out_retune_peak_ms (may be NULL): set to the worst single per-band
// em_scan_rf_tune_and_warmup() duration (retune + settle delay, NOT
// including the RSSI read) observed during this call, in ms. Callers that
// separately time the whole call (as gsr_sensor.c's worker does, for
// rf_rssi_peak_ms) will find that outer duration is always >= this value.
void em_scan_rf_fast_sweep_snapshot(
    float     out_rssi_dbm[EM_SCAN_NUM_FREQS],
    uint32_t* out_retune_peak_ms);
