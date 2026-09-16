#pragma once

// furi_hal_subghz.h — host-test shim.
//
// modules/em_scan_rf.c is the only file that includes this header directly
// (furi_hal.h's shim already covers furi_hal_subghz_get_rssi(), shared with
// gsr_sensor.c's mocked RF path — not repeated here). Fakes the CC1101
// control surface em_scan_rf.c calls: reset/idle/sleep/flush_rx/rx (bare
// state transitions, no real radio), load_custom_preset (records the
// pointer so a test can confirm the right preset array was loaded), and
// set_frequency_and_path (echoes the requested frequency back as "actual"
// by default — see furi_hal_subghz_mock_set_freq_offset_hz() to simulate
// PLL quantization drift).
//
// See tests/shims/furi_hal_subghz_mock.c for the implementations and the
// test-injection API, and tests/test_em_scan_rf.c for the test that drives
// the real modules/em_scan_rf.c against this shim.

#include <stdint.h>

void furi_hal_subghz_reset(void);
void furi_hal_subghz_idle(void);
void furi_hal_subghz_sleep(void);
void furi_hal_subghz_flush_rx(void);
void furi_hal_subghz_rx(void);
void furi_hal_subghz_load_custom_preset(const uint8_t* preset_data);
uint32_t furi_hal_subghz_set_frequency_and_path(uint32_t value);

// ── Test-injection API ──────────────────────────────────────────────────

// Call counters, in the order em_scan_rf.c would issue them.
int furi_hal_subghz_mock_reset_count(void);
int furi_hal_subghz_mock_idle_count(void);
int furi_hal_subghz_mock_sleep_count(void);
int furi_hal_subghz_mock_flush_rx_count(void);
int furi_hal_subghz_mock_rx_count(void);
int furi_hal_subghz_mock_load_custom_preset_count(void);

// The pointer passed to the most recent load_custom_preset() call — compare
// against &subghz_device_cc1101_preset_ook_650khz_async_regs[0] to confirm
// em_scan_rf_init() loaded the intended preset, not just "a" preset.
const uint8_t* furi_hal_subghz_mock_last_preset(void);

// Every frequency requested via set_frequency_and_path(), in call order.
// Lets a test confirm em_scan_rf_init()'s tolerance-check loop and
// em_scan_rf_dwell_band()/em_scan_rf_fast_sweep_snapshot()'s retune both
// tune to the exact em_scan_freq_hz[] entries, in order.
int      furi_hal_subghz_mock_set_freq_call_count(void);
uint32_t furi_hal_subghz_mock_set_freq_call(int index);

// Fixed offset added to whatever's requested before it's returned as
// "actual" — simulates the CC1101 PLL's real quantization drift. 0
// (default) means exact pass-through.
void furi_hal_subghz_mock_set_freq_offset_hz(int32_t offset_hz);

// Resets every counter/injection above to its default. Call at the start
// of each test.
void furi_hal_subghz_mock_reset(void);

// ── RSSI injection (get_rssi() itself is declared in furi_hal.h, shared
// with gsr_sensor.c's mocked RF path) ────────────────────────────────────

// Queues values to return one per furi_hal_subghz_get_rssi() call, in
// order; once exhausted, falls back to furi_hal_subghz_mock_set_rssi()'s
// flat default. Replaces any previously queued sequence. `count` is capped
// at 64 entries.
void furi_hal_subghz_mock_queue_rssi_sequence(const float* values, int count);
