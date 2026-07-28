#pragma once

// em_scan_rf.h — CC1101 sub-GHz RSSI sweep.
//
// Isolates every furi_hal_subghz_* call in one place (em_scan_rf.c). This is
// the one part of em_scan most likely to need small fixes on first build —
// see the note at the top of em_scan_rf.c — and the one part most worth
// lifting into biomap_session.c's tick handler later if a walk test shows
// the RSSI signal is worth keeping (see docs/peak_density_vs_spatial_
// clustering.md §6E/§6F for the original full 4-band EM-Fog Index design
// this is a cut-down feasibility test of).

#include <stdint.h>

// Single source of truth for the band count — em_scan_cal.h includes this
// header rather than defining its own copy, so adding/removing a band only
// needs three edits, all in this file/em_scan_rf.c: this count, and the two
// arrays below (em_scan_freq_hz/em_scan_freq_label in em_scan_rf.c).
// Everything else (UI bars, CSV columns, calibration struct sizing) is
// already sized off this constant. Note: bumping EM_SCAN_CAL_VERSION in
// em_scan_cal.h is also required whenever this count changes, since it
// changes the on-disk calibration struct's size — see em_scan_cal.h.
#define EM_SCAN_NUM_FREQS 6

// Spot frequencies to sweep, in Hz. Chosen from the original 4-band EM-Fog
// plan (433.92/868.3/915 MHz) plus two bands observed live on a walk with
// the stock Spectrum Analyzer app: ~300 MHz (garage/PIR-type ISM traffic)
// and ~815 MHz (top edge of the UK/EU 4G "800 MHz" downlink band,
// 791-821 MHz). 315 MHz was dropped — it sits in one of the most
// RF-congested consumer ISM bands (car keyfobs, TPMS, garage remotes) and
// consistently failed the Faraday calibration's noise-stability check
// because of that ambient traffic, not a device fault. Edit freely — the
// point of this tool is finding out which of these, if any, carry a real
// spatially-varying signal.
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
// spectrum-analyzer "max hold" technique for exactly this problem.
//
// Leaves the radio idle when done, same duty-cycled approach as the
// original EM-Fog plan (§6F).
//
// Call this once per band per tick, round-robin (see em_scan.c) — a real
// dwell no longer fits sweeping all EM_SCAN_NUM_FREQS bands inside one
// 100ms tick, so the full 6-band cycle now takes ~6 ticks (~600ms) instead
// of 100ms. At walking pace that's under a metre of travel per cycle,
// negligible for a spatial test.
void em_scan_rf_dwell_band(int band_index, float* out_peak_dbm);

// Tunes to ONE band, discards the same AGC/PLL warm-up as
// em_scan_rf_dwell_band(), then polls RSSI repeatedly over a much longer
// park window (hundreds of ms to seconds, vs. the ~22ms dwell above) —
// meant to be called from a dedicated background thread (see
// em_scan_rf_worker.h), not the main tick loop, since a park this long
// would freeze the UI/GPS if run inline on the main thread.
//
// Returns the MAXIMUM RSSI seen (out_peak_dbm, same peak-hold rationale as
// the dwell function), the mean across all polls (out_mean_dbm), and how
// many polls actually completed (out_sample_count). The worker currently
// only uses out_peak_dbm; mean/count are returned for whatever calls this
// next, not consumed by anything today.
//
// Leaves the radio idle when done. Must not be called concurrently with
// em_scan_rf_dwell_band() from another thread — both drive the same
// physical CC1101, so the caller (em_scan.c) is responsible for ensuring
// only one of the two is active at a time (see the EmScanModeNormal gating
// in em_scan.c's tick handler).
void em_scan_rf_park_band(
    int       band_index,
    uint32_t  park_ms,
    float*    out_peak_dbm,
    float*    out_mean_dbm,
    uint32_t* out_sample_count);
