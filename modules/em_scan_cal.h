#pragma once

// em_scan_cal.h — EM Scanner Hardware Faraday Calibration Data & Persistence.
//
// Defines the binary file structure, CRC32 checksum, validation limits,
// and Storage load/save functions for the Sub-GHz CC1101 RF noise floor
// calibration file (/ext/biomapping/em_scan_cal.bin).

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <storage/storage.h>

#include "em_scan_rf.h" // EM_SCAN_NUM_FREQS — single source of truth, add/remove bands there

#define EM_SCAN_CAL_MAGIC          0x454D4341  // "EMCA" (EM Scan Calibration)
#define EM_SCAN_CAL_VERSION        3           // Bumped: reduced to 3 high bands (815, 868, 915 MHz), EM_SCAN_NUM_FREQS 6->3
#define EM_SCAN_CAL_MAX_SAMPLES    64          // Max sweep samples collected/consumed per calibration run

#define EM_SCAN_CAL_MIN_FLOOR_DBM  -110.0f
#define EM_SCAN_CAL_MAX_STD_DEV_DB 3.5f

// Per-band ceiling on the calibrated floor (dBm). For the 815, 868, and 915 MHz bands,
// clean Faraday box testing showed an actual noise floor of -91.5 dBm.
// See em_scan_cal.c for per-band values (-90.0 dBm).
extern const float em_scan_cal_max_floor_dbm[EM_SCAN_NUM_FREQS];

#define EM_SCAN_CAL_PATH           "/ext/biomapping/em_scan_cal.bin"

typedef struct {
    uint32_t magic;                              // 0x454D4341
    uint32_t version;                            // Version 1
    uint32_t timestamp;                          // Unix epoch timestamp of calibration
    float    noise_floor_dbm[EM_SCAN_NUM_FREQS]; // Calibrated noise floor per band (dBm)
    float    noise_std_dev_db[EM_SCAN_NUM_FREQS];// Signal stability during calibration
    uint32_t sample_count;                       // Total sweep frames sampled
    uint32_t crc32;                              // CRC32 of all preceding bytes
} EmScanCal;

// Computes CRC32 over all bytes of EmScanCal preceding the crc32 field itself.
uint32_t em_scan_cal_compute_crc(const EmScanCal* cal);

// Validates magic, version, CRC32, per-band noise floor ceiling (see em_scan_cal_max_floor_dbm), and max std dev (<3.5 dB).
bool em_scan_cal_validate(const EmScanCal* cal);

// Loads and validates calibration file from SD card. Returns true if valid file loaded.
bool em_scan_cal_load(EmScanCal* cal, Storage* storage);

// Saves calibration file to SD card with computed CRC32.
bool em_scan_cal_save(const EmScanCal* cal, Storage* storage);

// Deletes calibration file from SD card.
void em_scan_cal_reset(Storage* storage);

// Helper function to calculate 10th percentile noise floor & std dev across collected sample sweeps.
void em_scan_cal_compute_stats(
    const float samples[][EM_SCAN_NUM_FREQS],
    uint32_t count,
    float noise_floor_dbm[EM_SCAN_NUM_FREQS],
    float noise_std_dev_db[EM_SCAN_NUM_FREQS]);
