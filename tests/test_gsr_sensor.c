// test_gsr_sensor.c — Host-side test for gsr_sensor.c, run against the
// REAL production driver (unmodified from what ships in the Flipper
// build), including its actual background FuriThread — not a stub.
//
// Unlike gps_uart.c (a single-threaded state machine driven by feeding it
// bytes), gsr_sensor.c's interesting behaviour (PGA autoranging, TIA
// conversion, disconnect debounce) only runs inside a worker thread that
// polls I2C continuously and writes into a ring buffer the main thread's
// gsr_sensor_tick() reads from. Testing it for real means real
// concurrency: tests/shims/furi.h backs FuriThread and FuriMutex with
// actual pthreads, and tests/shims/furi_hal.h's I2C mock is fully atomic
// so the worker and this test's main thread can touch it safely at the
// same time.
//
// Because the worker is a real thread and tests/shims/furi.h's
// furi_delay_ms() is a no-op, it spins as fast as the CPU allows — tests
// don't guess a sleep duration, they poll furi_hal_i2c_mock_read_count()
// (wait_for_more_reads below) until the worker has demonstrably produced
// enough fresh samples.
//
// Build: ./run_tests.sh (or see that script for the raw gcc invocation).

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <unistd.h>

#include "modules/gsr_sensor.h"
#include "furi.h"
#include "furi_hal.h"

// Declared in tests/shims/furi.h. Only gps_uart.c's tests previously
// needed this defined; gsr_sensor_get_worker_hz() now calls furi_get_tick()
// too, so it must be defined here as well or the link fails. It's a
// manually-advanced fake clock (see wait_for_more_reads below), not a
// real one — furi_delay_ms() is a no-op in this harness, so there's no
// wall-clock time for it to track automatically.
extern uint32_t furi_test_tick;
uint32_t furi_test_tick = 1;

// Poll until at least `n` more I2C reads have happened since this call
// started, or fail the test after a generous timeout. The worker spins
// essentially unthrottled, so in practice this resolves in well under a
// millisecond — the timeout exists only to turn "something is broken"
// into a clear assertion failure instead of a silent hang.
static void wait_for_more_reads(int n) {
    int start = furi_hal_i2c_mock_read_count();
    int waited_us = 0;
    while(furi_hal_i2c_mock_read_count() < start + n) {
        usleep(200);
        waited_us += 200;
        furi_test_advance_tick(1); // keep the fake clock moving alongside real waits
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: worker did not produce %d more I2C reads\n", n);
            assert(false);
        }
    }
}

static void wait_for_more_writes(int n) {
    int start = furi_hal_i2c_mock_write_count();
    int waited_us = 0;
    while(furi_hal_i2c_mock_write_count() < start + n) {
        usleep(200);
        waited_us += 200;
        furi_test_advance_tick(1);
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: worker did not produce %d more I2C writes\n", n);
            assert(false);
        }
    }
}

// Mirrors gsr_sensor.c's tia_counts_to_ns() (documented, stable hardware
// formula) — used to compute an independently-derived expected value,
// not to duplicate the driver's control flow.
static float expected_tia_ns(float counts) {
    if(counts <= 0.0f) return 0.0f;
    if(counts > 319000.0f) counts = 319000.0f;
    return (counts * 5000000.0f) / (15040000.0f - counts * 47.0f);
}

#define ADS_PGA_DEFAULT_NORM 8.0f // NORM_FACTOR[2] — default PGA index 2

static void test_alloc_probe_success(void) {
    printf("Running test_alloc_probe_success...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(gsr_sensor_available(gsr) == true);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_alloc_probe_failure(void) {
    printf("Running test_alloc_probe_failure...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_read_fail(true); // probe read fails

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(gsr_sensor_available(gsr) == false);
    assert(gsr_sensor_get_raw(gsr) == 0.0f);

    gsr_sensor_free(gsr); // must not hang — no worker thread was ever started
    printf("  -> Pass\n");
}

// Confirms the rolling-window iter_count/tick() plumbing works and the
// accessor doesn't crash or divide by zero — NOT a check of the real
// throughput number, which is meaningless on host since
// tests/shims/furi.h's furi_delay_ms() is a no-op there (see
// docs/gsr_filtering_analysis.md, Recommendation 1). Only a real device
// build can answer "is it near 1000 Hz". worker_hz_cached is written by
// gsr_sensor_tick() only once a ~1s window has elapsed, so this test must
// push the fake clock past that threshold and call tick() before reading
// it — it's not live-updated by the worker thread itself.
static void test_worker_hz_accessor(void) {
    printf("Running test_worker_hz_accessor...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(gsr_sensor_get_worker_hz(gsr) == 0.0f); // no window has elapsed yet

    wait_for_more_reads(200);
    furi_test_advance_tick(1001); // force the ~1s measurement window to roll over
    gsr_sensor_tick(gsr);

    float hz = gsr_sensor_get_worker_hz(gsr);
    printf("  worker_hz=%.0f (host-harness artifact, not a real-hardware rate)\n", (double)hz);
    assert(hz > 0.0f);
    assert(gsr_sensor_get_success_rate(gsr) > 99.0f); // no failures injected

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Validates the success-rate math against a known, deterministic failure
// ratio — not just "does it run without crashing". This is the
// diagnostic that distinguishes "the worker loop genuinely only runs
// this fast" from "the loop runs faster but half the reads silently
// fail" (see docs/gsr_filtering_analysis.md) — worth verifying the
// arithmetic is actually right, not just present.
static void test_success_rate_reflects_real_failure_ratio(void) {
    printf("Running test_success_rate_reflects_real_failure_ratio...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_i2c_mock_set_fail_every_nth(2); // exactly 50% of reads fail

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);

    wait_for_more_reads(400); // plenty of attempts on both sides of the 50%
    furi_test_advance_tick(1001);
    gsr_sensor_tick(gsr);

    float rate = gsr_sensor_get_success_rate(gsr);
    float hz = gsr_sensor_get_worker_hz(gsr);
    printf("  fail_every_nth=2 -> success_rate=%.1f%% (expect ~50%%), worker_hz=%.0f\n",
           (double)rate, (double)hz);
    assert(rate > 40.0f && rate < 60.0f);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Validates the duplicate-rate math against a known, deterministic case:
// the mock's raw16 value never changes here, so every successful read
// after the worker's very first one has the same raw ADC code as its
// predecessor, and gsr_sensor_get_duplicate_rate() should read close to
// 100% (not exactly 100%, since one read per session is never a
// "duplicate" of anything). This is the direct, measured check for the
// skip-vs-duplicate question in docs/gsr_filtering_analysis.md — worth
// verifying the arithmetic is actually right, not just present, the same
// way test_success_rate_reflects_real_failure_ratio does for that ratio.
static void test_duplicate_rate_reflects_stale_reads(void) {
    printf("Running test_duplicate_rate_reflects_stale_reads...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000); // held constant — every read after the first repeats it

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(gsr_sensor_get_duplicate_rate(gsr) == 0.0f); // no window has elapsed yet
    // No duplicates have happened yet either — must read the UINT32_MAX
    // "no data" sentinel, not 0 (which would misleadingly claim a real
    // zero-tick gap was observed).
    assert(gsr_sensor_get_duplicate_gap_min_ticks(gsr) == UINT32_MAX);

    wait_for_more_reads(400);
    furi_test_advance_tick(1001); // force the ~1s measurement window to roll over
    gsr_sensor_tick(gsr);

    float rate = gsr_sensor_get_duplicate_rate(gsr);
    printf("  raw16 held constant -> duplicate_rate=%.1f%% (expect ~100%%)\n", (double)rate);
    assert(rate > 95.0f);

    // Near-100% of reads were duplicates, so this window definitely had
    // some — the sentinel must be gone, replaced by a real (small, since
    // the host worker spins essentially unthrottled) tick-gap value.
    uint32_t dup_gap = gsr_sensor_get_duplicate_gap_min_ticks(gsr);
    printf("  duplicate_gap_min_ticks=%lu (expect a real value, not UINT32_MAX)\n",
           (unsigned long)dup_gap);
    assert(dup_gap != UINT32_MAX);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Sanity-checks the window ptp / mains-hum / PGA-oscillation / failure-
// streak accessors, plus the mains-hum enable/disable gate. Doesn't
// (can't, on host) validate real 50 Hz rejection — the mock produces a
// constant value, not an oscillating signal — just confirms the
// accessors run and give physically sensible results for a known
// constant, mid-range, failure-free input.
// mains_hum_mag, once enabled, operates on the DC-subtracted (centered)
// signal. For a pure DC input (like this constant mock), subtracting the
// mean leaves zero AC component, so get_mains_hum_mag() yields 0.0f.
static void test_new_diagnostics_accessors(void) {
    printf("Running test_new_diagnostics_accessors...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000); // mid-range, constant: no autorange, no variation

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(gsr_sensor_get_consecutive_failures(gsr) == 0);

    wait_for_more_reads(400);
    furi_test_advance_tick(1001); // roll the ~1s window so worker_hz_cached is set
    gsr_sensor_tick(gsr);

    // Mains-hum correlator is off by default — must read exactly 0.0f,
    // not a stale/leftover value, even though real samples exist.
    assert(gsr_sensor_get_mains_hum_mag(gsr) == 0.0f);

    gsr_sensor_set_mains_hum_enabled(gsr, true);
    gsr_sensor_tick(gsr);

    int32_t ptp = gsr_sensor_get_window_ptp(gsr);
    float mains = gsr_sensor_get_mains_hum_mag(gsr);
    uint32_t min_gap = gsr_sensor_get_window_min_gap_ticks(gsr);
    uint32_t pga_changes = gsr_sensor_get_pga_change_count(gsr);
    uint32_t fails = gsr_sensor_get_consecutive_failures(gsr);

    printf("  ptp=%ld mains_hum_mag=%.4f min_gap_ticks=%lu pga_changes=%lu fails=%lu\n",
           (long)ptp, (double)mains, (unsigned long)min_gap,
           (unsigned long)pga_changes, (unsigned long)fails);

    assert(ptp == 0);          // constant mock signal — no variation within the window
    assert(mains < 0.01f);     // mean-subtracted correlation removes DC offset (0.0037 float noise vs 160,000 before)
    assert(pga_changes == 0);  // mid-range constant signal — no autorange triggered
    assert(fails == 0);        // no failures injected

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_tia_conversion(void) {
    printf("Running test_tia_conversion...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000); // mid-range: no autorange trigger

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL && gsr_sensor_available(gsr));

    wait_for_more_reads(200); // let the 128-slot ring buffer fully turn over
    gsr_sensor_tick(gsr);

    float expected = expected_tia_ns(10000.0f * ADS_PGA_DEFAULT_NORM);
    float actual = gsr_sensor_get_raw(gsr);
    printf("  raw16=10000 norm=80000 expected=%.2f actual=%.2f\n", (double)expected, (double)actual);
    assert(fabsf(actual - expected) < 1.0f);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_calibration_applies_gain_offset(void) {
    printf("Running test_calibration_applies_gain_offset...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_calibration(gsr, true, 2.0f, 500.0f);

    wait_for_more_reads(200);
    gsr_sensor_tick(gsr);

    float raw_tia = expected_tia_ns(10000.0f * ADS_PGA_DEFAULT_NORM);
    float expected = 2.0f * raw_tia + 500.0f;
    float actual = gsr_sensor_get_raw(gsr);
    printf("  expected=%.2f actual=%.2f\n", (double)expected, (double)actual);
    assert(fabsf(actual - expected) < 1.0f);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// ADS_LOW_THRESH=4096, ADS_LOW_COUNT_TICKS=5: 5 consecutive low-signal
// ticks range up from the default PGA (index 2) to index 3.
static void test_autorange_up_on_low_signal(void) {
    printf("Running test_autorange_up_on_low_signal...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(1000); // well below ADS_LOW_THRESH

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(gsr_sensor_get_pga_index(gsr) == 2);

    wait_for_more_reads(200);
    for(int i = 0; i < 5; i++) gsr_sensor_tick(gsr);

    assert(gsr_sensor_get_pga_index(gsr) == 3); // tick() applies this synchronously
    wait_for_more_writes(1); // worker applies the CONFIG_REG write asynchronously

    printf("  pga_index=%d write_count=%d\n",
           gsr_sensor_get_pga_index(gsr), furi_hal_i2c_mock_write_count());
    assert(furi_hal_i2c_mock_write_count() > 0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// ADS_SATURATE_THRESH=30000: ranges down immediately, no hysteresis.
static void test_autorange_down_on_saturation(void) {
    printf("Running test_autorange_down_on_saturation...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(31000); // above ADS_SATURATE_THRESH

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    wait_for_more_reads(200);

    gsr_sensor_tick(gsr);
    printf("  pga_index=%d (expect 1)\n", gsr_sensor_get_pga_index(gsr));
    assert(gsr_sensor_get_pga_index(gsr) == 1);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_pga_lock_suppresses_autorange(void) {
    printf("Running test_pga_lock_suppresses_autorange...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(31000); // would range down hard if unlocked

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);

    gsr_sensor_lock_pga(gsr, 4);
    assert(gsr_sensor_get_pga_index(gsr) == 4);

    wait_for_more_reads(200);
    for(int i = 0; i < 10; i++) gsr_sensor_tick(gsr);
    printf("  pga_index=%d (expect 4, still locked)\n", gsr_sensor_get_pga_index(gsr));
    assert(gsr_sensor_get_pga_index(gsr) == 4);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// tick()-level debounce: 20 consecutive out-of-range (but I2C-valid)
// readings before connected flips false. Distinct from the worker-level
// I2C-failure path tested below.
static void test_disconnect_debounce_low_signal(void) {
    printf("Running test_disconnect_debounce_low_signal...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(0); // -> 0 nS, below GSR_VALID_MIN_NS

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    wait_for_more_reads(200);

    for(int i = 0; i < 19; i++) {
        gsr_sensor_tick(gsr);
        assert(gsr_sensor_is_connected(gsr) == true);
    }
    gsr_sensor_tick(gsr); // 20th consecutive out-of-range tick
    printf("  connected=%d after 20 consecutive zero-signal ticks\n", gsr_sensor_is_connected(gsr));
    assert(gsr_sensor_is_connected(gsr) == false);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Worker-level debounce: 50 consecutive I2C failures (real transport
// failure, not just an out-of-range value) trips connected=false directly
// inside gsr_sensor_worker(), independent of tick() ever being called.
static void test_disconnect_on_i2c_failure(void) {
    printf("Running test_disconnect_on_i2c_failure...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    wait_for_more_reads(200);
    assert(gsr_sensor_is_connected(gsr) == true);

    furi_hal_i2c_mock_set_read_fail(true);
    wait_for_more_reads(60); // >= 50 consecutive failures trips the worker's own check

    printf("  connected=%d after sustained I2C failure\n", gsr_sensor_is_connected(gsr));
    assert(gsr_sensor_is_connected(gsr) == false);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_adc_power_down_and_reenable(void) {
    printf("Running test_adc_power_down_and_reenable...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);

    // Step 1: Alloc sensor -> config MSB must have MODE bit = 0 (continuous mode)
    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    uint8_t alloc_msb = furi_hal_i2c_mock_last_config_msb();
    printf("  alloc config MSB = 0x%02X (MODE bit = %d, expect 0 for continuous)\n",
           alloc_msb, alloc_msb & 0x01);
    assert((alloc_msb & 0x01) == 0);

    // Step 2: Free sensor -> gsr_sensor_free must write power-down command with MODE bit = 1
    gsr_sensor_free(gsr);
    uint8_t free_msb = furi_hal_i2c_mock_last_config_msb();
    printf("  free config MSB = 0x%02X (MODE bit = %d, expect 1 for power-down)\n",
           free_msb, free_msb & 0x01);
    assert((free_msb & 0x01) == 1);

    // Step 3: Re-alloc sensor -> must write continuous mode config with MODE bit = 0 again
    GsrSensor* gsr2 = gsr_sensor_alloc();
    assert(gsr2 != NULL);
    uint8_t realloc_msb = furi_hal_i2c_mock_last_config_msb();
    printf("  re-alloc config MSB = 0x%02X (MODE bit = %d, expect 0 for continuous)\n",
           realloc_msb, realloc_msb & 0x01);
    assert((realloc_msb & 0x01) == 0);

    gsr_sensor_free(gsr2);
    printf("  -> Pass\n");
}

int main(void) {
    test_alloc_probe_success();
    test_alloc_probe_failure();
    test_worker_hz_accessor();
    test_success_rate_reflects_real_failure_ratio();
    test_duplicate_rate_reflects_stale_reads();
    test_new_diagnostics_accessors();
    test_tia_conversion();
    test_calibration_applies_gain_offset();
    test_autorange_up_on_low_signal();
    test_autorange_down_on_saturation();
    test_pga_lock_suppresses_autorange();
    test_disconnect_debounce_low_signal();
    test_disconnect_on_i2c_failure();
    test_adc_power_down_and_reenable();

    printf("\nAll gsr_sensor host tests passed successfully!\n");
    return 0;
}
