// test_em_scan_cal.c — unit tests for EM Scanner calibration & persistence.

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "em_scan/em_scan_cal.h"
#include "storage/storage.h"

// Defined in tests/shims/storage_mock.c
Storage* storage_mock_alloc(void);
void storage_mock_free(Storage* storage);

static void test_cal_checksum(void) {
    printf("Running test_cal_checksum...\n");
    EmScanCal cal;
    memset(&cal, 0, sizeof(cal));
    cal.magic = EM_SCAN_CAL_MAGIC;
    cal.version = EM_SCAN_CAL_VERSION;
    cal.timestamp = 1700000000;
    // 300/434/446 MHz (ceiling -80dBm) vs 815/868/915 MHz (ceiling -95dBm) —
    // see em_scan_cal_max_floor_dbm.
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        cal.noise_floor_dbm[i] = (i < 3) ? (-85.0f - (float)i) : (-96.0f - (float)(i - 3));
        cal.noise_std_dev_db[i] = 0.5f;
    }
    cal.sample_count = 28;
    cal.crc32 = em_scan_cal_compute_crc(&cal);

    assert(cal.crc32 != 0);
    assert(em_scan_cal_validate(&cal));

    // Bit flip test
    cal.noise_floor_dbm[0] += 1.0f;
    assert(!em_scan_cal_validate(&cal));
    printf("  -> Pass\n");
}

static void test_cal_validation_bounds(void) {
    printf("Running test_cal_validation_bounds...\n");
    EmScanCal cal;
    memset(&cal, 0, sizeof(cal));
    cal.magic = EM_SCAN_CAL_MAGIC;
    cal.version = EM_SCAN_CAL_VERSION;

    // Out of bounds noise floor (above every band's ceiling)
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        cal.noise_floor_dbm[i] = -60.0f; // invalid
        cal.noise_std_dev_db[i] = 1.0f;
    }
    cal.crc32 = em_scan_cal_compute_crc(&cal);
    assert(!em_scan_cal_validate(&cal));

    // Per-band ceiling: a floor that's fine for the low bands (300/434/446,
    // ceiling -80dBm) but unshielded for the high bands (815/868/915,
    // ceiling -95dBm) must still fail overall.
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        cal.noise_floor_dbm[i] = -85.0f;
        cal.noise_std_dev_db[i] = 1.0f;
    }
    cal.crc32 = em_scan_cal_compute_crc(&cal);
    assert(!em_scan_cal_validate(&cal));

    // High std dev (unshielded burst, > 3.5 dB), floor within every ceiling
    // so this isolates the variance check specifically.
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        cal.noise_floor_dbm[i] = -96.0f;
        cal.noise_std_dev_db[i] = 4.2f; // invalid (> 3.5 dB)
    }
    cal.crc32 = em_scan_cal_compute_crc(&cal);
    assert(!em_scan_cal_validate(&cal));
    printf("  -> Pass\n");
}

static void test_cal_serialization(void) {
    printf("Running test_cal_serialization...\n");
    Storage* storage = storage_mock_alloc();

    EmScanCal cal_save;
    memset(&cal_save, 0, sizeof(cal_save));
    cal_save.timestamp = 1700000000;
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        cal_save.noise_floor_dbm[i] = (i < 3) ? (-84.0f - (float)i) : (-96.0f - (float)(i - 3));
        cal_save.noise_std_dev_db[i] = 0.4f + (float)i * 0.1f;
    }
    cal_save.sample_count = 28;

    bool saved = em_scan_cal_save(&cal_save, storage);
    assert(saved);

    EmScanCal cal_loaded;
    bool loaded = em_scan_cal_load(&cal_loaded, storage);
    assert(loaded);
    assert(cal_loaded.magic == EM_SCAN_CAL_MAGIC);
    assert(cal_loaded.version == EM_SCAN_CAL_VERSION);
    assert(cal_loaded.sample_count == 28);
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        assert(fabsf(cal_loaded.noise_floor_dbm[i] - cal_save.noise_floor_dbm[i]) < 1e-4f);
    }

    // Reset test
    em_scan_cal_reset(storage);
    assert(!em_scan_cal_load(&cal_loaded, storage));

    storage_mock_free(storage);
    printf("  -> Pass\n");
}

static void test_cal_stats_computation(void) {
    printf("Running test_cal_stats_computation...\n");
    float samples[20][EM_SCAN_NUM_FREQS];

    // Constant noise floor with small ripple
    for(int i = 0; i < 20; i++) {
        for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
            samples[i][b] = -85.0f + (float)(i % 5) * 0.2f;
        }
    }

    float floors[EM_SCAN_NUM_FREQS];
    float std_devs[EM_SCAN_NUM_FREQS];
    em_scan_cal_compute_stats(samples, 20, floors, std_devs);

    for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
        assert(floors[b] >= -85.0f && floors[b] <= -84.0f);
        assert(std_devs[b] < 1.0f);
    }
    printf("  -> Pass\n");
}

static void test_cal_stats_does_not_clamp_unshielded_floor(void) {
    printf("Running test_cal_stats_does_not_clamp_unshielded_floor...\n");
    // Regression test: compute_stats used to clamp the computed floor to
    // the ceiling BEFORE callers ever compared it against that ceiling,
    // which made the "unshielded" validation check unreachable (a floor
    // can never be measured as exceeding a bound it was already forced
    // down to). An unshielded room reading (~-70dBm, well above every
    // band's ceiling) must come back unclamped so validate() can reject it.
    float samples[20][EM_SCAN_NUM_FREQS];
    for(int i = 0; i < 20; i++) {
        for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
            samples[i][b] = -70.0f;
        }
    }

    float floors[EM_SCAN_NUM_FREQS];
    float std_devs[EM_SCAN_NUM_FREQS];
    em_scan_cal_compute_stats(samples, 20, floors, std_devs);

    for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
        assert(floors[b] > em_scan_cal_max_floor_dbm[b]);
    }
    printf("  -> Pass\n");
}

int main(void) {
    printf("========================================\n");
    printf("EM SCAN CALIBRATION & PERSISTENCE TESTS\n");
    printf("========================================\n");

    test_cal_checksum();
    test_cal_validation_bounds();
    test_cal_serialization();
    test_cal_stats_computation();
    test_cal_stats_does_not_clamp_unshielded_floor();

    printf("\nAll em_scan_cal tests passed successfully!\n");
    return 0;
}
