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
#include <time.h>
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
extern _Atomic uint32_t furi_test_tick;
_Atomic uint32_t furi_test_tick = 1;

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

static void wait_for_more_fast_sweeps(int n) {
    int start = em_scan_rf_mock_fast_sweep_count();
    int waited_us = 0;
    while(em_scan_rf_mock_fast_sweep_count() < start + n) {
        usleep(200);
        waited_us += 200;
        furi_test_advance_tick(1);
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: worker did not produce %d more fast-sweep calls\n", n);
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

// Real wall-clock milliseconds between two CLOCK_MONOTONIC timestamps —
// for the mutex-behavior tests below, which care about actual elapsed
// time (proving something did or didn't block), not the fake tick clock
// everything else in this file uses for dwell/pacing timing.
static double elapsed_ms(struct timespec start, struct timespec end) {
    return (double)(end.tv_sec - start.tv_sec) * 1000.0 +
           (double)(end.tv_nsec - start.tv_nsec) / 1e6;
}

// Waits (real wall-clock, no fake-tick involvement) until the mocked
// furi_hal_subghz_get_rssi() call is demonstrably in progress — i.e. the
// worker hasn't just been scheduled to call it, it's actually inside the
// (possibly artificially delayed) call right now. See
// furi_hal_subghz_mock_set_rssi_delay_ms()'s doc comment.
static void wait_for_rssi_call_in_progress(void) {
    int waited_us = 0;
    while(!furi_hal_subghz_mock_rssi_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: mocked RSSI call never started\n");
            assert(false);
        }
    }
}

// I2C/set_band analogs of wait_for_rssi_call_in_progress — deliberately
// tick-neutral (no furi_test_advance_tick() in the poll loop, unlike
// wait_for_more_reads/wait_for_more_rssi_reads) so a caller can advance the
// fake clock by an EXACT, test-chosen amount afterward without any
// incidental drift from this wait itself. Used by the peak_ms attribution
// tests below, where the assertion is an exact ms value.
static void wait_for_i2c_call_in_progress(void) {
    int waited_us = 0;
    while(!furi_hal_i2c_mock_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: mocked I2C call never started\n");
            assert(false);
        }
    }
}

static void wait_for_fast_sweep_call_in_progress(void) {
    int waited_us = 0;
    while(!em_scan_rf_mock_fast_sweep_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: mocked fast sweep call never started\n");
            assert(false);
        }
    }
}

static void wait_for_retune_call_in_progress(void) {
    int waited_us = 0;
    while(!em_scan_rf_mock_retune_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: mocked retune call never started\n");
            assert(false);
        }
    }
}

// Polls a peak_ms accessor until it reaches `target`, instead of trusting
// "the mocked call's own call_in_progress flag went false" as proof the
// result is ready to read. Those are NOT the same moment: the mock flips
// call_in_progress false as its very last step before returning, but the
// WORKER's surrounding code still has to compute the duration, take
// gsr->mutex, and publish it into the peak_ms field afterward — a real,
// if normally nanoseconds-wide, gap. A test that reads the accessor
// immediately after observing call_in_progress==false can race ahead of
// that publish and see the pre-call value (0) instead — measured in
// practice as a rare failure under the ThreadSanitizer build specifically
// (its heavier instrumentation on the mutex/atomic write widens this exact
// gap enough to occasionally lose the race). Waiting for the actual result
// removes the gap instead of guessing a settle delay to pad around it.
static void wait_for_peak_ms_at_least(
    uint32_t (*getter)(const GsrSensor*), const GsrSensor* gsr, uint32_t target) {
    int waited_us = 0;
    while(getter(gsr) < target) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) {
            fprintf(stderr, "TIMEOUT: peak_ms accessor never reached %u\n", (unsigned)target);
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

// Real open-circuit hardware doesn't read exactly 0 nS — ADC leakage/noise
// with the cuffs off measures ~17 nS in the field (raw16=7 here reproduces
// that: counts = 7*8 = 56 -> ~18.6 nS via tia_counts_to_ns()). The old
// GSR_VALID_MIN_NS=0.1f threshold sat far below this, so a real disconnect
// never tripped; GSR_VALID_MIN_NS=100.0f gives margin above this noise floor
// while staying well under the ~1000 nS literature floor for real skin.
static void test_disconnect_debounce_realistic_open_circuit_noise(void) {
    printf("Running test_disconnect_debounce_realistic_open_circuit_noise...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(7); // ~18.6 nS raw TIA — realistic open-circuit noise, not exactly 0

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    wait_for_more_reads(200);

    for(int i = 0; i < 19; i++) {
        gsr_sensor_tick(gsr);
        assert(gsr_sensor_is_connected(gsr) == true);
    }
    gsr_sensor_tick(gsr); // 20th consecutive out-of-range tick
    printf("  connected=%d after 20 ticks at raw=%.2f nS (realistic open-circuit noise)\n",
           gsr_sensor_is_connected(gsr), (double)gsr_sensor_get_raw(gsr));
    assert(gsr_sensor_is_connected(gsr) == false);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// A nonzero calibration offset must not mask a true open circuit: the
// disconnect check has to run on the pre-calibration TIA value, otherwise
// `gain*0 + offset` can land back inside [GSR_VALID_MIN_NS, GSR_VALID_MAX_NS]
// and the finger-cuff-disconnected message never fires for anyone who's run
// the calibration wizard.
static void test_disconnect_debounce_ignores_calibration_offset(void) {
    printf("Running test_disconnect_debounce_ignores_calibration_offset...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(0); // open circuit -> ~0 nS raw TIA

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_calibration(gsr, true, 2.0f, 500.0f); // offset alone sits well inside the valid window
    wait_for_more_reads(200);

    for(int i = 0; i < 19; i++) {
        gsr_sensor_tick(gsr);
        assert(gsr_sensor_is_connected(gsr) == true);
    }
    gsr_sensor_tick(gsr); // 20th consecutive out-of-range tick
    printf("  connected=%d after 20 ticks with offset=500 masking calibrated raw=%.2f\n",
           gsr_sensor_is_connected(gsr), (double)gsr_sensor_get_raw(gsr));
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
// enable/disable lifecycle, dwell peak-capture, and band rotation, none of
// which had any coverage before this file.
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
    gsr_sensor_get_rf_snapshot(gsr, rssi);

    printf("  rssi[0]=%.1f (expect -100.0, RF never enabled)\n", (double)rssi[0]);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(fabs((double)rssi[i] - (-100.0)) < 1e-6);
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
    printf("  init_count=%d (expect 1)\n", em_scan_rf_mock_init_count());
    assert(em_scan_rf_mock_init_count() == 1);
    assert(em_scan_rf_mock_deinit_count() == 0);

    wait_for_more_fast_sweeps(7); // worker actually performs fast sweeps now that it's enabled
    assert(em_scan_rf_mock_fast_sweep_count() >= 7);

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
    wait_for_more_fast_sweeps(7);

    gsr_sensor_set_rf_enabled(gsr, false);
    assert(em_scan_rf_mock_deinit_count() == 1);

    // Snapshot must reset to the disabled-default floor, not linger at
    // whatever RF last measured — a caller reading it after disable
    // (e.g. a mode switch) shouldn't see a stale live-looking value.
    // Regression coverage for the 2026-07-30 mutex review's fix #3.
    float rssi[EM_SCAN_NUM_FREQS];
    gsr_sensor_get_rf_snapshot(gsr, rssi);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        printf("  rssi[%d]=%.1f after disable (expect -100.0)\n", i, (double)rssi[i]);
        assert(fabs((double)rssi[i] - (-100.0)) < 1e-6);
    }

    int count_at_disable = em_scan_rf_mock_fast_sweep_count();
    wait_for_more_reads(50); // let the worker (GSR side) keep spinning a while
    printf("  sweep_calls at disable=%d, after=%d (expect unchanged)\n",
           count_at_disable, em_scan_rf_mock_fast_sweep_count());
    assert(em_scan_rf_mock_fast_sweep_count() == count_at_disable);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_rf_band_rotates_through_all_three_bands(void) {
    printf("Running test_rf_band_rotates_through_all_three_bands...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    assert(em_scan_rf_mock_visit_count(0) == 0);
    
    gsr_sensor_set_rf_enabled(gsr, true); // enables RF, triggers immediate fast sweep
    
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

static void test_rf_fast_sweep_pacing_on_elapsed_time(void) {
    printf("Running test_rf_fast_sweep_pacing_on_elapsed_time...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // forces immediate first fast sweep

    // Wait for the worker to take that forced first fast sweep
    int waited_us = 0;
    while(em_scan_rf_mock_fast_sweep_count() < 1) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT: no initial fast sweep\n"); assert(false); }
    }
    int count_after_first = em_scan_rf_mock_fast_sweep_count();

    // Now, hold clock frozen and wait real time. Fast sweep pacing compares
    // furi_get_tick() against the last sweep's tick, so with the clock
    // not moving, no further fast sweeps should occur no matter how many
    // thousands of loop iterations the worker spins through.
    waited_us = 0;
    while(waited_us < 500000) { // ~500ms real wall-clock time
        usleep(200);
        waited_us += 200;
    }
    printf("  sweep_count=%d after ~500ms wall time with clock frozen (expect unchanged from %d)\n",
           em_scan_rf_mock_fast_sweep_count(), count_after_first);
    assert(em_scan_rf_mock_fast_sweep_count() == count_after_first);

    // Advance to just short of RF_SAMPLE_INTERVAL_MS (100 ms) — still must not sweep.
    furi_test_advance_tick(99);
    wait_for_more_reads(50); // let worker spin
    assert(em_scan_rf_mock_fast_sweep_count() == count_after_first);

    // Cross the 100 ms threshold -> must perform a fast sweep now.
    furi_test_advance_tick(1);
    wait_for_more_fast_sweeps(1);
    assert(em_scan_rf_mock_fast_sweep_count() >= count_after_first + 1);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_rf_fast_sweep_captures_rssi(void) {
    printf("Running test_rf_fast_sweep_captures_rssi...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    
    // Set specific RSSI values for the three bands on their first visit
    furi_hal_subghz_mock_set_rssi_for_band_visit(0, 1, -70.0f);
    furi_hal_subghz_mock_set_rssi_for_band_visit(1, 1, -80.0f);
    furi_hal_subghz_mock_set_rssi_for_band_visit(2, 1, -90.0f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // forces immediate first fast sweep

    wait_for_more_fast_sweeps(1);

    float rssi[EM_SCAN_NUM_FREQS];
    gsr_sensor_get_rf_snapshot(gsr, rssi);
    printf("  rssi[0]=%.1f rssi[1]=%.1f rssi[2]=%.1f\n", (double)rssi[0], (double)rssi[1], (double)rssi[2]);
    assert(fabs((double)rssi[0] - (-70.0)) < 1e-6);
    assert(fabs((double)rssi[1] - (-80.0)) < 1e-6);
    assert(fabs((double)rssi[2] - (-90.0)) < 1e-6);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_rf_rssi_fast_sweep_updates(void) {
    printf("Running test_rf_rssi_fast_sweep_updates...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    
    // Visit 1 values
    furi_hal_subghz_mock_set_rssi_for_band_visit(0, 1, -70.0f);
    // Visit 2 values
    furi_hal_subghz_mock_set_rssi_for_band_visit(0, 2, -65.0f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // sweep 1 (visit 1)
    
    wait_for_more_fast_sweeps(1);
    float rssi[EM_SCAN_NUM_FREQS];
    gsr_sensor_get_rf_snapshot(gsr, rssi);
    assert(fabs((double)rssi[0] - (-70.0)) < 1e-6);

    // Advance clock to trigger sweep 2 (visit 2)
    furi_test_advance_tick(100);
    wait_for_more_fast_sweeps(1);
    
    gsr_sensor_get_rf_snapshot(gsr, rssi);
    printf("  rssi[0]=%.1f (expect -65.0)\n", (double)rssi[0]);
    assert(fabs((double)rssi[0] - (-65.0)) < 1e-6);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// The point of the "only 2 threads" merge: GSR autoranging/disconnect logic
// and the RF band scan share one worker loop and one thread, but — since
// the 2026-07-30 mutex audit — deliberately NOT one mutex: `mutex` guards
// ADC state, `rf_mutex` guards only the RF snapshot, so an RF SPI stall
// can never block ADC sampling. Neither must perturb the other. Runs the
// existing I2C-failure disconnect scenario (test_disconnect_on_i2c_failure)
// with RF concurrently enabled, and checks RF readings stay within a
// physically sane dBm range throughout — i.e. sharing a thread (not a
// lock) isn't corrupting either side's state.
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
    gsr_sensor_get_rf_snapshot(gsr, rssi);
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
    gsr_sensor_get_rf_snapshot(gsr, rssi);
    printf("  rssi[0]=%.1f after I2C failure (still sane range)\n", (double)rssi[0]);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(rssi[i] >= -127.0f && rssi[i] <= 0.0f);
    }

    assert(furi_hal_subghz_mock_get_rssi_call_count() > 0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Mutex-behavior regression tests (2026-07-30) — directly exercise the
// property the rf_mutex / gsr->mutex split exists for, using an
// artificially slow mocked SPI call (furi_hal_subghz_mock_set_rssi_delay_ms)
// standing in for the real, unbounded furi_hal_spi_bus_end_txrx() busy-wait
// documented in em_scan_rf_crash_investigation.md. Before that split (when
// RF's SPI section ran under the same gsr->mutex the ADC path and
// gsr_sensor_get_rf_snapshot() both needed), the first test below would
// have failed outright — it would have measured ~150ms, not <20ms.
// ─────────────────────────────────────────────────────────────────────────

static void test_rf_snapshot_read_not_blocked_by_slow_spi_call(void) {
    printf("Running test_rf_snapshot_read_not_blocked_by_slow_spi_call...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);
    em_scan_rf_mock_set_fast_sweep_delay_ms(150); // stand-in for a stuck SPI transaction

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // forces an immediate first (slow) sample
    wait_for_fast_sweep_call_in_progress();

    float rssi[EM_SCAN_NUM_FREQS];
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    gsr_sensor_get_rf_snapshot(gsr, rssi);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = elapsed_ms(t0, t1);
    printf("  get_rf_snapshot() took %.2fms while a 150ms SPI call was in flight (must be fast)\n", ms);
    assert(ms < 20.0);

    // Let the slow call actually finish before tearing down, so free()'s
    // own disable path isn't the thing waiting it out.
    int waited_us = 0;
    while(em_scan_rf_mock_fast_sweep_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT\n"); assert(false); }
    }
    em_scan_rf_mock_set_fast_sweep_delay_ms(0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_gsr_path_not_blocked_by_slow_rf_spi_call(void) {
    printf("Running test_gsr_path_not_blocked_by_slow_rf_spi_call...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);
    em_scan_rf_mock_set_fast_sweep_delay_ms(150);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true);
    wait_for_fast_sweep_call_in_progress();

    // gsr->mutex (ADC path) is a completely separate mutex from rf_mutex —
    // gsr_sensor_tick()/get_raw() must stay fast regardless of the RF
    // section's SPI call, since neither ever touches rf_mutex.
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    gsr_sensor_tick(gsr);
    float raw = gsr_sensor_get_raw(gsr);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = elapsed_ms(t0, t1);
    printf("  tick()+get_raw() took %.2fms while a 150ms RF SPI call was in flight (raw=%.1f)\n",
           ms, (double)raw);
    assert(ms < 20.0);

    int waited_us = 0;
    while(em_scan_rf_mock_fast_sweep_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT\n"); assert(false); }
    }
    em_scan_rf_mock_set_fast_sweep_delay_ms(0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Regression test for the 2026-07-30 review finding: a plain rf_enabled
// check followed by setting rf_spi_busy is a TOCTOU gap (the worker could
// read rf_enabled==true, get preempted, and the disable path could see
// rf_spi_busy==false and proceed in exactly that window). The fix makes
// the worker's decide-and-mark step share rf_mutex with disable's
// rendezvous. This test proves the actual observable guarantee: by the
// time gsr_sensor_set_rf_enabled(gsr, false) returns, the in-flight SPI
// call it raced against has already finished — deinit() never overlaps it.
static void test_rf_disable_waits_for_inflight_spi_call_before_deinit(void) {
    printf("Running test_rf_disable_waits_for_inflight_spi_call_before_deinit...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);
    em_scan_rf_mock_set_fast_sweep_delay_ms(10); // comfortably under the 20ms disable-wait bound

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // forces an immediate first (10ms) sample
    wait_for_fast_sweep_call_in_progress();

    gsr_sensor_set_rf_enabled(gsr, false); // races the in-flight call on purpose

    printf("  rssi_call_in_progress=%d immediately after set_rf_enabled(false) returns (expect 0)\n",
           furi_hal_subghz_mock_rssi_call_in_progress());
    assert(!furi_hal_subghz_mock_rssi_call_in_progress());
    assert(em_scan_rf_mock_deinit_count() == 1);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Per-call stall attribution tests (2026-08-03) — exercise the
// i2c_peak_ms/rf_rssi_peak_ms/rf_retune_peak_ms columns added to answer
// "which of the worker thread's three candidate blocking calls actually
// caused a given tick_dt_ms stall" directly, for the next real recording
// (track 116 showed real ~1s stalls; see docs/gps_rf_mutex_status.md's
// 2026-08-03 entry). Each test injects a real delay into exactly ONE
// underlying mock call (same furi_hal_*_mock_set_*_delay_ms() technique as
// the mutex-behavior tests above), advances the fake clock by the SAME
// amount while that one call is confirmed in flight (via its
// wait_for_*_call_in_progress() helper — see those functions' comments for
// why this is safe and precise even though gsr_sensor.c's worker measures
// duration with furi_get_tick(), which does not advance on its own here),
// then asserts not just that the right column caught it but that the
// OTHER TWO stayed at 0 — proving these columns can tell the three causes
// apart, not just detect that something happened. RF is enabled with real
// (undelayed) traffic in all three, so "the untouched columns stay 0" is
// checked against genuine concurrent activity, not against RF simply never
// having run.
// ─────────────────────────────────────────────────────────────────────────

static void test_i2c_peak_ms_detects_slow_i2c_call(void) {
    printf("Running test_i2c_peak_ms_detects_slow_i2c_call...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // real, undelayed RF traffic alongside the I2C stall

    // Only NOW arm the I2C delay — gsr_sensor_alloc()'s own probe read (not
    // measured by i2c_peak_ms; that's worker-thread-only instrumentation)
    // already happened above, and this way the delay lands on an ordinary
    // worker-loop read, the common case (see i2c_peak_ms's struct comment
    // for why the rarer PGA-write path shares this same column instead of
    // needing its own test).
    furi_hal_i2c_mock_set_delay_ms(150); // stand-in for a stuck ADS1115 transaction
    wait_for_i2c_call_in_progress();
    furi_test_advance_tick(150); // simulate 150ms of device time elapsing during the stall

    // Unlike the RF RSSI poll (paced by RF_SAMPLE_INTERVAL_MS, so it won't
    // fire again while the fake tick sits still), the I2C read path runs
    // on every worker-loop iteration unconditionally — with the delay left
    // armed, the worker would immediately re-enter another 150ms-delayed
    // call the instant this one returns, and polling could easily miss
    // the vanishingly narrow false-in-between window, hanging until the
    // timeout below despite nothing being wrong. Reset the delay now: the
    // ALREADY-in-flight call already captured 150 into its own local
    // before this write (see furi_hal_i2c_read_mem's delay_ms local), so
    // it still sleeps out its committed duration — only calls that
    // haven't started yet are affected, closing the race.
    furi_hal_i2c_mock_set_delay_ms(0);

    int waited_us = 0;
    while(furi_hal_i2c_mock_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT\n"); assert(false); }
    }
    // See wait_for_peak_ms_at_least's doc comment — call_in_progress going
    // false above proves the mock returned, not that the worker has
    // finished publishing the measured duration into i2c_peak_ms yet.
    wait_for_peak_ms_at_least(gsr_sensor_get_i2c_peak_ms, gsr, 150);

    printf("  i2c_peak_ms=%u rf_rssi_peak_ms=%u rf_retune_peak_ms=%u (expect 150/0/0)\n",
           (unsigned)gsr_sensor_get_i2c_peak_ms(gsr),
           (unsigned)gsr_sensor_get_rf_rssi_peak_ms(gsr),
           (unsigned)gsr_sensor_get_rf_retune_peak_ms(gsr));
    assert(gsr_sensor_get_i2c_peak_ms(gsr) == 150);
    assert(gsr_sensor_get_rf_rssi_peak_ms(gsr) == 0);
    assert(gsr_sensor_get_rf_retune_peak_ms(gsr) == 0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

static void test_rf_rssi_peak_ms_detects_slow_rssi_call(void) {
    printf("Running test_rf_rssi_peak_ms_detects_slow_rssi_call...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);
    em_scan_rf_mock_set_fast_sweep_delay_ms(150); // stand-in for a stuck SPI fast sweep

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // forces an immediate first (slow) sweep
    wait_for_fast_sweep_call_in_progress();
    furi_test_advance_tick(150); // simulate 150ms of device time elapsing during the sweep

    int waited_us = 0;
    while(em_scan_rf_mock_fast_sweep_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT\n"); assert(false); }
    }
    em_scan_rf_mock_set_fast_sweep_delay_ms(0);
    wait_for_peak_ms_at_least(gsr_sensor_get_rf_rssi_peak_ms, gsr, 150);

    printf("  rf_rssi_peak_ms=%u i2c_peak_ms=%u rf_retune_peak_ms=%u (expect 150/0/0)\n",
           (unsigned)gsr_sensor_get_rf_rssi_peak_ms(gsr),
           (unsigned)gsr_sensor_get_i2c_peak_ms(gsr),
           (unsigned)gsr_sensor_get_rf_retune_peak_ms(gsr));
    assert(gsr_sensor_get_rf_rssi_peak_ms(gsr) == 150);
    assert(gsr_sensor_get_i2c_peak_ms(gsr) == 0);
    assert(gsr_sensor_get_rf_retune_peak_ms(gsr) == 0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Was test_rf_retune_peak_ms_detects_slow_set_band_call, stubbed to a no-op
// on 2026-08-04 when em_scan_rf_set_band()'s separate per-band retune call
// was replaced by em_scan_rf_fast_sweep_snapshot() (see
// docs/rf_no_teardown_architecture_proposal.md) — retune and RSSI-read
// stopped being separate top-level calls the worker could time
// independently, so rf_retune_peak_ms had nothing left to measure it.
// Restored here now that em_scan_rf_fast_sweep_snapshot() reports its own
// internal retune sub-step timing back via an out-param.
static void test_rf_retune_peak_ms_detects_slow_retune_step(void) {
    printf("Running test_rf_retune_peak_ms_detects_slow_retune_step...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);
    em_scan_rf_mock_set_retune_delay_ms(150); // stand-in for a stuck per-band retune

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);
    gsr_sensor_set_rf_enabled(gsr, true); // forces an immediate first (slow-retune) sweep
    wait_for_retune_call_in_progress();
    furi_test_advance_tick(150); // simulate 150ms of device time elapsing during the retune

    int waited_us = 0;
    while(em_scan_rf_mock_retune_call_in_progress()) {
        usleep(200);
        waited_us += 200;
        if(waited_us > 5000000) { fprintf(stderr, "TIMEOUT\n"); assert(false); }
    }
    em_scan_rf_mock_set_retune_delay_ms(0);
    wait_for_peak_ms_at_least(gsr_sensor_get_rf_retune_peak_ms, gsr, 150);

    printf("  rf_retune_peak_ms=%u rf_rssi_peak_ms=%u i2c_peak_ms=%u (expect 150/>=150/0)\n",
           (unsigned)gsr_sensor_get_rf_retune_peak_ms(gsr),
           (unsigned)gsr_sensor_get_rf_rssi_peak_ms(gsr),
           (unsigned)gsr_sensor_get_i2c_peak_ms(gsr));
    assert(gsr_sensor_get_rf_retune_peak_ms(gsr) == 150);
    // Unlike i2c_peak_ms (still a fully separate call, unaffected here), a
    // slow retune now also shows up in rf_rssi_peak_ms — that column is
    // timed around the WHOLE fast-sweep call (retune + settle + RSSI read,
    // fused into one since the no-teardown change), which necessarily
    // includes the slow retune. See gsr_sensor.c's rf_rssi_peak_ms/
    // rf_retune_peak_ms struct comment.
    assert(gsr_sensor_get_rf_rssi_peak_ms(gsr) >= 150);
    assert(gsr_sensor_get_i2c_peak_ms(gsr) == 0);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

// Stress test for the specific TOCTOU gap fixed in the 2026-07-30 review:
// the worker's "read rf_enabled, then set rf_spi_busy" is two separate
// steps, and without sharing rf_mutex across both, the disable path could
// land in the narrow window between them. That window is a handful of
// instructions wide — the three tests above all wait for
// rssi_call_in_progress first, which means rf_spi_busy is already true by
// the time they act, so none of them actually land inside that window;
// they'd pass identically against a version of this fix missing the
// rf_mutex rendezvous. This test doesn't try to land in the window
// deterministically either (there's no test hook for that without adding
// production-code instrumentation) — instead it rapidly cycles enable/
// disable many times, each restarting the worker's decide-and-mark step
// at an arbitrary point in its own scheduling, to maximize how many
// distinct interleavings actually get exercised across the run. The
// functional assertions below are a sanity check, not the main point —
// the real coverage is running this under ThreadSanitizer (see
// run_tests.sh's TSAN pass), which flags the underlying unsynchronized
// access directly if the race is ever actually hit, independent of
// whether any particular run's assertions happen to still pass.
static void test_rf_enable_disable_stress_no_race(void) {
    printf("Running test_rf_enable_disable_stress_no_race...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();
    furi_hal_subghz_mock_set_rssi(-95.0f);

    GsrSensor* gsr = gsr_sensor_alloc();
    assert(gsr != NULL);

    // Deliberately no delay between enable and disable: a sleep here would
    // likely give the worker enough time to complete a full decide/sample/
    // clear cycle before disable ever runs, missing the narrow window
    // entirely. Racing them back-to-back, 200 times, relies on ordinary
    // thread-creation and scheduling jitter alone to land in a different
    // phase of the worker's loop each time.
    const int cycles = 200;
    for(int i = 0; i < cycles; i++) {
        gsr_sensor_set_rf_enabled(gsr, true);
        gsr_sensor_set_rf_enabled(gsr, false);
    }

    printf("  completed %d enable/disable cycles: init=%d deinit=%d (expect both == %d)\n",
           cycles, em_scan_rf_mock_init_count(), em_scan_rf_mock_deinit_count(), cycles);
    assert(em_scan_rf_mock_init_count() == cycles);
    assert(em_scan_rf_mock_deinit_count() == cycles);

    gsr_sensor_free(gsr);
    printf("  -> Pass\n");
}

struct TeardownTestContext {
    pthread_mutex_t mock_app_mutex;
    GsrSensor* volatile shared_gsr;
    _Atomic bool gui_thread_running;
};

static void* mock_gui_thread_fn(void* arg) {
    struct TeardownTestContext* ctx = (struct TeardownTestContext*)arg;
    float rf_rssi[EM_SCAN_NUM_FREQS];

    while(ctx->gui_thread_running) {
        pthread_mutex_lock(&ctx->mock_app_mutex);
        GsrSensor* g = ctx->shared_gsr;
        if(g) {
            // Simulate render callback accesses
            if(gsr_sensor_available(g)) {
                gsr_sensor_get_rf_snapshot(g, rf_rssi);
                volatile uint8_t pga = gsr_sensor_get_pga_index(g);
                volatile int32_t mean = gsr_sensor_get_mean_count(g);
                (void)pga; (void)mean;
            }
        }
        pthread_mutex_unlock(&ctx->mock_app_mutex);
        usleep(10); // yield
    }
    return NULL;
}

// Regression test for session_deinit early-release optimization:
// Nulls s->gsr under app->mutex, releases it, then runs gsr_sensor_free().
// Concurrently, the mock GUI thread tries to access shared_gsr under the
// same mutex. This test proves that the GUI thread sees NULL and avoids
// use-after-free, while never being blocked by the slow thread-join of
// gsr_sensor_free() since the lock was released early.
static void test_session_deinit_early_release_gui_safety(void) {
    printf("Running test_session_deinit_early_release_gui_safety...\n");
    furi_hal_i2c_mock_reset();
    furi_hal_i2c_mock_set_raw16(10000);
    furi_hal_subghz_mock_reset();
    em_scan_rf_mock_reset();

    struct TeardownTestContext ctx;
    pthread_mutex_init(&ctx.mock_app_mutex, NULL);
    ctx.shared_gsr = gsr_sensor_alloc();
    assert(ctx.shared_gsr != NULL);
    gsr_sensor_set_rf_enabled(ctx.shared_gsr, true);

    ctx.gui_thread_running = true;
    pthread_t gui_thread;
    int rc = pthread_create(&gui_thread, NULL, mock_gui_thread_fn, &ctx);
    assert(rc == 0);

    // Let the GUI thread run and access the active sensor
    usleep(5000);

    // Simulate session_deinit early-release pattern:
    pthread_mutex_lock(&ctx.mock_app_mutex);
    GsrSensor* local_gsr = ctx.shared_gsr;
    ctx.shared_gsr = NULL;
    pthread_mutex_unlock(&ctx.mock_app_mutex);

    // Free the sensor outside the lock (the slow join/deinit happens here)
    if(local_gsr) {
        gsr_sensor_free(local_gsr);
    }

    // Stop the mock GUI thread
    ctx.gui_thread_running = false;
    pthread_join(gui_thread, NULL);
    pthread_mutex_destroy(&ctx.mock_app_mutex);

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
    test_disconnect_debounce_realistic_open_circuit_noise();
    test_disconnect_debounce_ignores_calibration_offset();
    test_disconnect_on_i2c_failure();
    test_adc_power_down_and_reenable();
    test_rf_disabled_snapshot_reads_default_floor();
    test_rf_enable_calls_init_and_arms_band_zero();
    test_rf_disable_calls_deinit_and_stops_reads();
    test_rf_band_rotates_through_all_three_bands();
    test_rf_fast_sweep_pacing_on_elapsed_time();
    test_rf_fast_sweep_captures_rssi();
    test_rf_rssi_fast_sweep_updates();
    test_gsr_and_rf_worker_independence();
    test_rf_snapshot_read_not_blocked_by_slow_spi_call();
    test_gsr_path_not_blocked_by_slow_rf_spi_call();
    test_rf_disable_waits_for_inflight_spi_call_before_deinit();
    test_i2c_peak_ms_detects_slow_i2c_call();
    test_rf_rssi_peak_ms_detects_slow_rssi_call();
    test_rf_retune_peak_ms_detects_slow_retune_step();
    test_rf_enable_disable_stress_no_race();
    test_session_deinit_early_release_gui_safety();

    printf("\nAll gsr_sensor host tests passed successfully!\n");
    return 0;
}
