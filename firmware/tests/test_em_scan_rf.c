// test_em_scan_rf.c — host tests for modules/em_scan_rf.c (CC1101 sub-GHz
// RSSI sweep), the one hardware-touching module with no prior host test
// (see docs/host_testing.md's status table). Links the real, unmodified
// em_scan_rf.c against tests/shims/furi_hal_subghz_mock.c — see that file's
// banner for why this mock is single-threaded and mutually exclusive with
// furi_hal_mock.c's own furi_hal_subghz_get_rssi() (used by
// test_gsr_sensor.c instead).
//
// Covers the two live entry points' actual sequencing/behaviour, not just
// "it compiles": em_scan_rf_init()'s reset/preset/tune-and-log sequence,
// em_scan_rf_deinit()'s idle+sleep, em_scan_rf_dwell_band()'s peak-hold
// (returns the MAX RSSI seen across the dwell window, not a single
// snapshot — the exact bug this function's doc comment says an earlier,
// buggier version had), and em_scan_rf_fast_sweep_snapshot()'s one-read-
// per-band behaviour plus its out_retune_peak_ms contract.

#include <assert.h>
#include <math.h>
#include <stdio.h>

#include "modules/em_scan_rf.h"
#include "furi_hal.h"
#include "furi_hal_subghz.h"
#include "lib/subghz/devices/cc1101_configs.h"

// Declared in tests/shims/furi.h; furi_hal_subghz_mock.c's get_rssi() calls
// furi_test_advance_tick() on every read (see that file's banner), so this
// definition is needed to link even though this test never advances it
// directly itself — same convention test_em_scan_cal.c/test_gps_uart.c use.
extern _Atomic uint32_t furi_test_tick;
_Atomic uint32_t furi_test_tick = 1;

static void reset_all(void) {
    furi_hal_subghz_mock_reset();
}

static void test_init_sequence(void) {
    printf("Running test_init_sequence...\n");
    reset_all();

    em_scan_rf_init();

    assert(furi_hal_subghz_mock_reset_count() == 1);
    assert(furi_hal_subghz_mock_load_custom_preset_count() == 1);
    assert(
        furi_hal_subghz_mock_last_preset() ==
        &subghz_device_cc1101_preset_ook_650khz_async_regs[0]);

    // idle(): once before the preset load, once per band in the
    // tolerance-check loop, once more at the very end.
    assert(furi_hal_subghz_mock_idle_count() == 2 + EM_SCAN_NUM_FREQS);

    assert(furi_hal_subghz_mock_set_freq_call_count() == EM_SCAN_NUM_FREQS);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(furi_hal_subghz_mock_set_freq_call(i) == em_scan_freq_hz[i]);
    }

    assert(furi_hal_subghz_mock_flush_rx_count() == 0);
    assert(furi_hal_subghz_mock_rx_count() == 0);
    assert(furi_hal_subghz_mock_sleep_count() == 0);
    printf("  -> Pass\n");
}

static void test_init_tolerates_pll_quantization_drift(void) {
    printf("Running test_init_tolerates_pll_quantization_drift...\n");
    reset_all();
    // A few hundred Hz of drift is real PLL quantization noise, not a
    // mistuned band (see em_scan_rf.c's EM_SCAN_FREQ_TOLERANCE_HZ comment)
    // — init() must complete the same way regardless, since the tolerance
    // check only logs (a no-op in this harness), it doesn't gate behaviour.
    furi_hal_subghz_mock_set_freq_offset_hz(300);

    em_scan_rf_init();

    assert(furi_hal_subghz_mock_set_freq_call_count() == EM_SCAN_NUM_FREQS);
    assert(furi_hal_subghz_mock_load_custom_preset_count() == 1);
    printf("  -> Pass\n");
}

static void test_deinit_sequence(void) {
    printf("Running test_deinit_sequence...\n");
    reset_all();

    em_scan_rf_deinit();

    assert(furi_hal_subghz_mock_idle_count() == 1);
    assert(furi_hal_subghz_mock_sleep_count() == 1);
    printf("  -> Pass\n");
}

static void test_dwell_band_retunes_to_requested_band(void) {
    printf("Running test_dwell_band_retunes_to_requested_band...\n");
    reset_all();

    float peak = 0.0f;
    em_scan_rf_dwell_band(1, &peak);

    assert(furi_hal_subghz_mock_set_freq_call_count() == 1);
    assert(furi_hal_subghz_mock_set_freq_call(0) == em_scan_freq_hz[1]);
    assert(furi_hal_subghz_mock_flush_rx_count() == 1);
    assert(furi_hal_subghz_mock_rx_count() == 1);
    // idle(): once in tune_and_warmup, once more at the end of dwell_band.
    assert(furi_hal_subghz_mock_idle_count() == 2);
    printf("  -> Pass\n");
}

static void test_dwell_band_polls_exactly_the_dwell_window(void) {
    printf("Running test_dwell_band_polls_exactly_the_dwell_window...\n");
    reset_all();

    float peak = 0.0f;
    em_scan_rf_dwell_band(0, &peak);

    // Locks in the peak-hold window size: em_scan_rf.c ties the loop exit
    // to elapsed fake-tick time, which only moves because this mock's
    // get_rssi() advances it once per call (see furi_hal_subghz_mock.c's
    // banner) — a regression here would mean the dwell either free-spins
    // or exits early, silently.
    assert(furi_hal_subghz_mock_get_rssi_call_count() == 22);
    printf("  -> Pass\n");
}

static void test_dwell_band_returns_max_not_last(void) {
    printf("Running test_dwell_band_returns_max_not_last...\n");
    reset_all();
    // A single brief burst inside an otherwise quiet 22-sample dwell — real
    // ISM/keyfob traffic is bursty (see em_scan_rf.h's doc comment on this
    // function). An instantaneous single-read implementation would almost
    // certainly miss it; peak-hold must not.
    float samples[22];
    for(int i = 0; i < 22; i++) samples[i] = -91.5f;
    samples[10] = -60.0f;
    furi_hal_subghz_mock_queue_rssi_sequence(samples, 22);

    float peak = 0.0f;
    em_scan_rf_dwell_band(0, &peak);

    assert(fabsf(peak - (-60.0f)) < 1e-4f);
    printf("  -> Pass\n");
}

static void test_dwell_band_quiet_floor(void) {
    printf("Running test_dwell_band_quiet_floor...\n");
    reset_all();
    furi_hal_subghz_mock_set_rssi(-95.0f);

    float peak = 0.0f;
    em_scan_rf_dwell_band(2, &peak);

    assert(fabsf(peak - (-95.0f)) < 1e-4f);
    printf("  -> Pass\n");
}

static void test_fast_sweep_snapshot_reads_one_per_band(void) {
    printf("Running test_fast_sweep_snapshot_reads_one_per_band...\n");
    reset_all();
    float per_band[EM_SCAN_NUM_FREQS] = {-80.0f, -70.0f, -90.0f};
    furi_hal_subghz_mock_queue_rssi_sequence(per_band, EM_SCAN_NUM_FREQS);

    float out[EM_SCAN_NUM_FREQS];
    uint32_t retune_peak_ms = 999;
    em_scan_rf_fast_sweep_snapshot(out, &retune_peak_ms);

    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(fabsf(out[i] - per_band[i]) < 1e-4f);
        assert(furi_hal_subghz_mock_set_freq_call(i) == em_scan_freq_hz[i]);
    }
    // Exactly one RSSI read per band — no dwell/peak-hold window here,
    // unlike em_scan_rf_dwell_band().
    assert(furi_hal_subghz_mock_get_rssi_call_count() == EM_SCAN_NUM_FREQS);
    assert(furi_hal_subghz_mock_flush_rx_count() == EM_SCAN_NUM_FREQS);
    assert(furi_hal_subghz_mock_rx_count() == EM_SCAN_NUM_FREQS);
    // idle(): once per band inside tune_and_warmup, once more at the end.
    assert(furi_hal_subghz_mock_idle_count() == EM_SCAN_NUM_FREQS + 1);

    // Nothing advances the fake tick during tune_and_warmup itself — only
    // this mock's get_rssi() does (see its banner) — so the retune-only
    // timing em_scan_rf.c measures around each tune_and_warmup() call
    // (explicitly NOT including the RSSI read, per em_scan_rf.h's doc
    // comment on out_retune_peak_ms) is always 0 in this harness. That's
    // the correct value here, not an unmeasured default — it confirms the
    // RSSI read really does happen outside the timed span.
    assert(retune_peak_ms == 0);
    printf("  -> Pass\n");
}

static void test_fast_sweep_snapshot_null_retune_ptr_is_safe(void) {
    printf("Running test_fast_sweep_snapshot_null_retune_ptr_is_safe...\n");
    reset_all();

    float out[EM_SCAN_NUM_FREQS];
    em_scan_rf_fast_sweep_snapshot(out, NULL);

    assert(furi_hal_subghz_mock_get_rssi_call_count() == EM_SCAN_NUM_FREQS);
    printf("  -> Pass\n");
}

int main(void) {
    printf("========================================\n");
    printf("EM SCAN RF (CC1101 SWEEP) TESTS\n");
    printf("========================================\n");

    test_init_sequence();
    test_init_tolerates_pll_quantization_drift();
    test_deinit_sequence();
    test_dwell_band_retunes_to_requested_band();
    test_dwell_band_polls_exactly_the_dwell_window();
    test_dwell_band_returns_max_not_last();
    test_dwell_band_quiet_floor();
    test_fast_sweep_snapshot_reads_one_per_band();
    test_fast_sweep_snapshot_null_retune_ptr_is_safe();

    printf("\nAll em_scan_rf tests passed successfully!\n");
    return 0;
}
