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
#include "modules/em_scan_rf.h"
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

// Absolute-threshold wait, deliberately NOT a "wait for N more from
// whatever the count is right now" helper: a caller waiting on a one-time
// event (e.g. "the worker applies the CONFIG_REG write my last tick()
// call queued") needs to capture its baseline BEFORE triggering that
// event, then wait for an ABSOLUTE target. A "start = count now, wait for
// start+N" helper called AFTER the trigger races against how fast the
// worker is: if it's already applied the write by the time such a helper
// reads its own "now" baseline, that baseline already includes the write
// being waited for, and the helper then waits forever for a second one
// that isn't coming. This bit test_autorange_up_on_low_signal in
// practice (~1-2% of runs) before being fixed this way.
static void wait_for_write_count_at_least(int target) {
    int waited_us = 0;
    while(furi_hal_i2c_mock_write_count() < target) {
        usleep(200);
        waited_us += 200;
        furi_test_advance_tick(1);
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: write_count never reached %d\n", target);
            assert(false);
        }
    }
}

// RF analog of wait_for_more_reads — the interleaved SubGHz block in the
// worker loop runs once per iteration whenever RF is enabled, in step with
// the I2C portion.
static void wait_for_more_rssi_reads(int n) {
    int start = furi_hal_subghz_mock_get_rssi_call_count();
    int waited_us = 0;
    while(furi_hal_subghz_mock_get_rssi_call_count() < start + n) {
        usleep(200);
        waited_us += 200;
        furi_test_advance_tick(1);
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: worker did not produce %d more RSSI reads\n", n);
            assert(false);
        }
    }
}

// RF analog of wait_for_more_reads, keyed off em_scan_rf_set_band() calls
// instead of I2C reads. NOTE: deliberately an "at least N" threshold, not
// "wait until the band changes" — the worker can race through several
// 150-iteration rotations (in practice, 10,000+ loop iterations can elapse
// in the time it takes this thread's polling loop to wake up even once)
// between two of this test thread's polling wake-ups, so by the time a
// "did it change yet?" check runs, the band may already be many steps past
// whatever you expected. Combine this with state the worker itself
// resolves (the per-(band,visit) RSSI table, or em_scan_rf_mock_visit_count()
// for a monotonic count) rather than em_scan_rf_mock_last_band() (only ever
// shows wherever the worker happens to be *right now*).
static void wait_for_more_set_band_calls(int n) {
    int start = em_scan_rf_mock_set_band_count();
    int waited_us = 0;
    while(em_scan_rf_mock_set_band_count() < start + n) {
        usleep(200);
        waited_us += 200;
        furi_test_advance_tick(1);
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: worker did not produce %d more band-rotation calls\n", n);
            assert(false);
        }
    }
}

// Waits until every band 0..num_bands-1 has been visited at least once.
// Robust regardless of overshoot: em_scan_rf_mock_visit_count() is a plain
// monotonic per-band counter, not a fixed-size history indexed by absolute
// call number, so there's nothing for the worker to race past and corrupt.
static void wait_for_all_bands_visited(int num_bands) {
    int waited_us = 0;
    for(;;) {
        bool all_visited = true;
        for(int b = 0; b < num_bands; b++) {
            if(em_scan_rf_mock_visit_count(b) < 1) { all_visited = false; break; }
        }
        if(all_visited) return;
        usleep(200);
        waited_us += 200;
        furi_test_advance_tick(1);
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: not all %d bands were visited\n", num_bands);
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
    // Baseline captured BEFORE the tick loop below, which is what actually
    // triggers the PGA-change write — NOT inside wait_for_more_writes()
    // after the loop. wait_for_more_writes(1) used to capture its own
    // "start" baseline there instead, which raced against the worker: the
    // worker can (and, ~1-2% of the time, does) apply the pending CONFIG_REG
    // write in the brief gap between the tick loop finishing and that
    // baseline being read, so "start" would already include the write we
    // were waiting for, and the test would then time out waiting for a
    // second write that was never coming.
    int writes_after_alloc = furi_hal_i2c_mock_write_count();

    wait_for_more_reads(200);
    for(int i = 0; i < 5; i++) gsr_sensor_tick(gsr);

    assert(gsr_sensor_get_pga_index(gsr) == 3); // tick() applies this synchronously
    wait_for_write_count_at_least(writes_after_alloc + 1); // worker applies the CONFIG_REG write asynchronously

    printf("  pga_index=%d write_count=%d\n",
           gsr_sensor_get_pga_index(gsr), furi_hal_i2c_mock_write_count());
    assert(furi_hal_i2c_mock_write_count() > writes_after_alloc);

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

// ─────────────────────────────────────────────────────────────────────────
// RF (SubGHz) tests — the interleaved band-scan block the "only 2 threads"
// merge (069e505) added into this same worker loop. Covers the
// enable/disable lifecycle, dwell peak-capture, band rotation, and the
// peak-hold decay/floor-clamp arithmetic, none of which had any coverage
// before this file.
// ─────────────────────────────────────────────────────────────────────────

static void test_rf_disabled_snapshot_reads_default_floor(void) {
    printf("Running test_rf_disabled_snapshot_reads_default_floor...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    wait_for_more_reads(50); // let the worker run a bit; RF stays off throughout

    float rssi[EM_SCAN_NUM_FREQS];
    float peak_hold[EM_SCAN_NUM_FREQS];
    gsr_sensor_get_rf_snapshot(gsr, rssi, peak_hold);

    printf("  rssi[0]=%.1f peak_hold[0]=%.1f (expect -100.0, RF never enabled)\n",
           (double)rssi[0], (double)peak_hold[0]);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(fabs((double)rssi[i] - (-100.0)) < 1e-6);
        assert(fabs((double)peak_hold[i] - (-100.0)) < 1e-6);
    }
    assert(em_scan_rf_mock_init_count() == 0); // never enabled -> never inited
    assert(furi_hal_subghz_mock_get_rssi_call_count() == 0); // RF block never ran

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_rf_enable_calls_init_and_arms_band_zero(void) {
    printf("Running test_rf_enable_calls_init_and_arms_band_zero...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);

    gsr_sensor_set_rf_enabled(gsr, true);
    printf("  init_count=%d last_band=%d (expect 1, 0)\n",
           em_scan_rf_mock_init_count(), em_scan_rf_mock_last_band());
    assert(em_scan_rf_mock_init_count() == 1);
    assert(em_scan_rf_mock_deinit_count() == 0);
    assert(em_scan_rf_mock_last_band() == 0);

    wait_for_more_rssi_reads(20); // worker actually reads RSSI now that it's enabled
    assert(furi_hal_subghz_mock_get_rssi_call_count() >= 20);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_rf_disable_calls_deinit_and_stops_reads(void) {
    printf("Running test_rf_disable_calls_deinit_and_stops_reads...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true);
    wait_for_more_rssi_reads(20);

    gsr_sensor_set_rf_enabled(gsr, false);
    assert(em_scan_rf_mock_deinit_count() == 1);

    int count_at_disable = furi_hal_subghz_mock_get_rssi_call_count();
    wait_for_more_reads(50); // let the worker (GSR side) keep spinning a while
    printf("  rssi_calls at disable=%d, after=%d (expect unchanged)\n",
           count_at_disable, furi_hal_subghz_mock_get_rssi_call_count());
    assert(furi_hal_subghz_mock_get_rssi_call_count() == count_at_disable);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_rf_band_rotates_through_all_three_bands(void) {
    printf("Running test_rf_band_rotates_through_all_three_bands...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f); // constant floor — only rotation matters here

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(em_scan_rf_mock_visit_count(0) == 0);
    gsr_sensor_set_rf_enabled(gsr, true); // synchronously arms band 0
    assert(em_scan_rf_mock_visit_count(0) == 1);

    // Every band starting at visit_count 0 and reaching >= 1 proves the
    // dwell timer actually rotates through all of them — not just band 0
    // forever — regardless of how many times the worker has since
    // revisited any of them by the time this returns. Advances the fake
    // clock itself (via furi_test_advance_tick(), inside wait_for_*'s
    // polling loop) since dwell completion is tick-based, not iteration-
    // count-based — see test_rf_dwell_completes_on_elapsed_time_not_iteration_count.
    wait_for_all_bands_visited(EM_SCAN_NUM_FREQS);
    printf("  visit counts: band0=%d band1=%d band2=%d (all >= 1)\n",
           em_scan_rf_mock_visit_count(0), em_scan_rf_mock_visit_count(1),
           em_scan_rf_mock_visit_count(2));
    for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
        assert(em_scan_rf_mock_visit_count(b) >= 1);
    }

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Regression test for the dwell-timing fix in modules/gsr_sensor.c: a band's
// dwell now ends when RF_DWELL_MS worth of *real elapsed ticks* have passed
// (furi_get_tick() delta), not after a fixed number of loop iterations. This
// test would have caught the bug this replaced — the worker used to just
// count `rf_park_counter >= 150`, assuming the loop ran at a fixed rate,
// which is exactly the mistake em_scan_rf.c's em_scan_rf_park_band() was
// changed to avoid after real hardware measured it inflating a 300ms park to
// ~630-670ms (see that function's own comment).
//
// This test's polling helpers (wait_for_more_rssi_reads, etc.) advance the
// SAME fake clock (furi_test_advance_tick()) that gsr_sensor.c's worker now
// checks — so dwell completion here is driven entirely by how much this
// test chooses to advance that clock, not by how many real loop iterations
// the worker happens to spin through. That's what lets the two halves of
// this test assert something a pure iteration-count design never could:
// "many thousands of loop iterations must NOT be enough on their own" and
// "reaching the configured ms value, whether that takes many iterations or
// few, must be enough".
static void test_rf_dwell_completes_on_elapsed_time_not_iteration_count(void) {
    printf("Running test_rf_dwell_completes_on_elapsed_time_not_iteration_count...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // arms band 0 at the current fake tick

    // Let the worker spin through many thousands of iterations WITHOUT this
    // test advancing the fake clock at all (wait_for_more_rssi_reads' own
    // polling loop still calls furi_test_advance_tick(1) once per 200us
    // wake-up, so use a tight local loop instead to hold the clock still
    // while still giving the worker real wall-clock time to run).
    int start = furi_hal_subghz_mock_get_rssi_call_count();
    int waited_us = 0;
    while(furi_hal_subghz_mock_get_rssi_call_count() < start + 5000) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT\n"); assert(false); }
    }
    printf("  band0 visits=%d after 5000+ RSSI reads with the clock held still (expect 1)\n",
           em_scan_rf_mock_visit_count(0));
    assert(em_scan_rf_mock_visit_count(0) == 1); // must NOT have rotated on iteration count alone

    // Advance to just short of RF_DWELL_MS (300ms @ 1000 Hz shim frequency)
    // — still must not rotate, no matter how many more reads happen.
    furi_test_advance_tick(299);
    wait_for_more_rssi_reads(2000);
    printf("  band0 visits=%d at 299/300 ticks (expect still 1)\n",
           em_scan_rf_mock_visit_count(0));
    assert(em_scan_rf_mock_visit_count(0) == 1);

    // Cross the 300-tick threshold -> must rotate now.
    furi_test_advance_tick(1);
    wait_for_all_bands_visited(2);
    printf("  band1 visits=%d once the clock reaches 300/300 ticks (expect >= 1)\n",
           em_scan_rf_mock_visit_count(1));
    assert(em_scan_rf_mock_visit_count(1) >= 1);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Proves rssi_dbm[band] reports the MAX seen during the dwell, not just the
// most recent sample — the entire point of the peak-hold design (real
// ISM/keyfob bursts are brief; a plain instantaneous read would usually
// miss them). Configures every dwell's first RSSI sample as a high spike,
// with every other read pinned to a quiet floor, then just waits for band
// 0 to have completed at least one dwell. Robust to however far the worker
// has actually raced ahead by the time that's checked (unlike a one-shot
// override, which would only cover one specific dwell — see
// furi_hal_subghz_mock_set_first_read_of_each_dwell()'s doc comment):
// band 0's most recently completed dwell, whichever visit number it
// actually is, always ends with its peak pinned at the spike value.
static void test_rf_dwell_peak_captures_transient_spike(void) {
    printf("Running test_rf_dwell_peak_captures_transient_spike...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);                     // floor for every non-first read
    furi_hal_subghz_mock_set_first_read_of_each_dwell(-60.0f); // spike on each dwell's 1st read

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // call #0: arms band 0

    wait_for_more_set_band_calls(2); // call #1: band 0's first dwell has fully completed

    float rssi[EM_SCAN_NUM_FREQS];
    gsr_sensor_get_rf_snapshot(gsr, rssi, NULL); // NULL peak_hold_dbm must be tolerated
    printf("  rssi[0]=%.1f (expect -60.0, the captured spike, not the -95.0 floor)\n",
           (double)rssi[0]);
    assert(fabs((double)rssi[0] - (-60.0)) < 1e-6);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Cross-dwell-boundary regression test for the peak-hold decay/clamp logic
// (modules/gsr_sensor.c's interleaved worker block: "peak_hold -= 0.9f,
// then clamp to the live value if it would decay below it"). Band 0's
// first-ever dwell reads a strong -60 throughout; every dwell after that
// (bands 1, 2, and band 0's own later visits) reads a floor far enough
// below -60 (-1000.0f) that no plausible number of 0.9 dB decay steps could
// ever reach it, so the clamp-to-live-value branch never fires and
// peak_hold_dbm[0] decays by a clean, predictable -0.9 dB every time band
// 0's dwell completes.
//
// How many times band 0 has actually completed a dwell by the time this
// test gets around to checking is NOT controllable (the worker can race
// through dozens of rotations between two polls — see the mock's file-
// banner comment), so this test doesn't guess that count. Instead:
//   1. gsr_sensor_set_rf_enabled(gsr, false) — synchronised via the same
//      mutex the worker's RF block holds, so this freezes rssi_dbm/
//      peak_hold_dbm at whatever their final state was, with no further
//      writes possible afterward.
//   2. NOW read em_scan_rf_mock_visit_count(0) — safe to read after
//      freezing, tells us exactly how many times band 0 became active.
//   3. Compute the peak-hold value the decay formula predicts for that
//      exact visit count (accounting for the one remaining ambiguity: band
//      0's most recent visit may or may not have completed its own decay
//      step yet at the moment it was frozen) and assert the actual
//      snapshot matches — exact, regardless of how far the worker raced.
static void test_rf_peak_hold_decays_and_floor_clamp_does_not_overfire(void) {
    printf("Running test_rf_peak_hold_decays_and_floor_clamp_does_not_overfire...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    // -1000.0f: needs over 1000 decay steps (150,000+ worker iterations) to
    // ever reach, vastly more than any overshoot observed in practice.
    furi_hal_subghz_mock_set_rssi(-1000.0f);
    furi_hal_subghz_mock_set_rssi_for_band_visit(0, 1, -60.0f); // band 0's FIRST visit only

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // call #0: arms band 0, visit 1
    wait_for_more_set_band_calls(5); // let several rotations/decay-steps happen
    gsr_sensor_set_rf_enabled(gsr, false); // freeze — no more writes from here on

    int visits = em_scan_rf_mock_visit_count(0); // 1-based; safe to read now
    assert(visits >= 2); // otherwise wait_for_more_set_band_calls(5) itself is broken

    // peak_hold(C) for C completed band-0 dwells: -60 while C<=1 (the first
    // decay step is always clamped straight back up to the live -60), then
    // -60 - 0.9*(C-1) for C>=1. `visits` is band 0's current (possibly
    // still in-progress) visit number, so completed dwells C is either
    // visits-1 (last visit still in progress when frozen) or visits (it
    // had just completed) — compute both and accept either.
    double lo_c = visits - 1;
    double hi_c = visits;
    double expect_a = (lo_c <= 1) ? -60.0 : -60.0 - 0.9 * (lo_c - 1);
    double expect_b = (hi_c <= 1) ? -60.0 : -60.0 - 0.9 * (hi_c - 1);
    double expect_lo = expect_a < expect_b ? expect_a : expect_b;
    double expect_hi = expect_a > expect_b ? expect_a : expect_b;

    float rssi[EM_SCAN_NUM_FREQS];
    float peak_hold[EM_SCAN_NUM_FREQS];
    gsr_sensor_get_rf_snapshot(gsr, rssi, peak_hold);
    printf("  band0 visits=%d -> peak_hold[0]=%.2f (expect in [%.2f, %.2f])\n",
           visits, (double)peak_hold[0], expect_lo, expect_hi);
    assert((double)peak_hold[0] >= expect_lo - 0.01);
    assert((double)peak_hold[0] <= expect_hi + 0.01);
    // Sanity: still nowhere near the -1000 floor, i.e. genuinely gradual
    // decay, not some bug that snaps straight to the live value.
    assert((double)peak_hold[0] > -900.0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// The point of the "only 2 threads" merge: GSR autoranging/disconnect logic
// and the RF band scan share one loop iteration and one mutex. Neither must
// perturb the other. Runs the existing I2C-failure disconnect scenario
// (test_disconnect_on_i2c_failure) with RF concurrently enabled, and checks
// RF readings stay within a physically sane dBm range throughout — i.e. the
// two halves of the interleaved block aren't corrupting each other's state.
static void test_gsr_and_rf_worker_independence(void) {
    printf("Running test_gsr_and_rf_worker_independence...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-91.5f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true);
    wait_for_more_reads(200);
    assert(gsr_sensor_is_connected(gsr) == true);

    float rssi[EM_SCAN_NUM_FREQS];
    gsr_sensor_get_rf_snapshot(gsr, rssi, NULL);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(rssi[i] >= -127.0f && rssi[i] <= 0.0f);
    }

    // Same I2C-failure scenario as test_disconnect_on_i2c_failure, but now
    // with the RF half of the loop actively running concurrently.
    furi_hal_i2c_mock_set_read_fail(true);
    wait_for_more_reads(60); // >= 50 consecutive failures trips the worker's own check
    printf("  connected=%d after I2C failure with RF concurrently enabled (expect 0)\n",
           gsr_sensor_is_connected(gsr));
    assert(gsr_sensor_is_connected(gsr) == false);

    // RF must have kept running throughout, unaffected by the I2C failure.
    gsr_sensor_get_rf_snapshot(gsr, rssi, NULL);
    printf("  rssi[0]=%.1f after I2C failure (still sane range)\n", (double)rssi[0]);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(rssi[i] >= -127.0f && rssi[i] <= 0.0f);
    }
    assert(furi_hal_subghz_mock_get_rssi_call_count() > 0);

    gsr_sensor_free(gsr);
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
    test_rf_disabled_snapshot_reads_default_floor();
    test_rf_enable_calls_init_and_arms_band_zero();
    test_rf_disable_calls_deinit_and_stops_reads();
    test_rf_band_rotates_through_all_three_bands();
    test_rf_dwell_completes_on_elapsed_time_not_iteration_count();
    test_rf_dwell_peak_captures_transient_spike();
    test_rf_peak_hold_decays_and_floor_clamp_does_not_overfire();
    test_gsr_and_rf_worker_independence();

    printf("\nAll gsr_sensor host tests passed successfully!\n");
    return 0;
}
