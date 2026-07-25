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

#define EM_SCAN_NUM_FREQS 6

// Spot frequencies to sweep, in Hz. Chosen from the original 4-band EM-Fog
// plan (315/433.92/868.3/915 MHz) plus two bands observed live on a walk
// with the stock Spectrum Analyzer app: ~300 MHz (garage/PIR-type ISM
// traffic) and ~815 MHz (top edge of the UK/EU 4G "800 MHz" downlink band,
// 791-821 MHz). Edit freely — the point of this tool is finding out which
// of these, if any, carry a real spatially-varying signal.
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
