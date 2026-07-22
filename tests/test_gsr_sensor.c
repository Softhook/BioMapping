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
#include "furi_hal.h"

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

int main(void) {
    test_alloc_probe_success();
    test_alloc_probe_failure();
    test_tia_conversion();
    test_calibration_applies_gain_offset();
    test_autorange_up_on_low_signal();
    test_autorange_down_on_saturation();
    test_pga_lock_suppresses_autorange();
    test_disconnect_debounce_low_signal();
    test_disconnect_on_i2c_failure();

    printf("\nAll gsr_sensor host tests passed successfully!\n");
    return 0;
}
