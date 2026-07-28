# Specification & Architecture Plan: EM Scan Hardware Faraday Calibration Wizard (`em_scan_cal.bin`)

This document outlines the technical design, binary storage format, CRC32 verification scheme, UI wizard flow, and integration path for **Hardware Faraday Zeroing** in the `em_scan` module.

---

## 1. Executive Summary & Rationale

Just as BioMapping uses `biomap_cal.bin` to store individual skin conductance electrode offsets, `em_scan` requires persistent per-device calibration to eliminate component tolerances in the Flipper Zero's CC1101 transceiver, LNA, and internal Sub-GHz antenna switches ($\pm 2\text{--}3\text{ dB}$ device variance).

### The Solution
A dedicated **Hardware Faraday Calibration Wizard** in `em_scan` that guides the user to place the Flipper Zero inside an RF shielding bag/box (Faraday cage), measures 20 seconds of pure internal hardware thermal noise across all 7 bands, validates noise stability, and saves a checksummed binary calibration file (`/ext/biomapping/em_scan_cal.bin`).

---

## 2. Binary Format & Data Structure

The calibration file is stored at `/ext/biomapping/em_scan_cal.bin` using a packed C struct with a deterministic CRC32 integrity check.

```c
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define EM_SCAN_CAL_MAGIC   0x454D4341  // "EMCA" (EM Scan Calibration)
#define EM_SCAN_CAL_VERSION 1
#define EM_SCAN_NUM_FREQS   7

typedef struct {
    uint32_t magic;                              // 0x454D4341
    uint32_t version;                            // Version 1
    uint32_t timestamp;                          // Unix epoch timestamp of calibration
    float    noise_floor_dbm[EM_SCAN_NUM_FREQS]; // Calibrated noise floor per band (dBm)
    float    noise_std_dev_db[EM_SCAN_NUM_FREQS];// Signal stability during calibration
    uint32_t sample_count;                        // Total sweep frames sampled (e.g. 28)
    uint32_t crc32;                               // CRC32 of all preceding bytes
} EmScanCal;
```

### Validation Constraints
When loading `em_scan_cal.bin`, the system validates:
1. `magic == EM_SCAN_CAL_MAGIC`
2. `version == EM_SCAN_CAL_VERSION`
3. Computed CRC32 matches `cal.crc32`
4. Every `noise_floor_dbm[i]` is bounded within physical CC1101 limits ($-110.0\text{ dBm} \le \text{floor} \le -70.0\text{ dBm}$)
5. Stability check: `noise_std_dev_db[i] < 3.5 dB` (proves the device was truly shielded during calibration and not exposed to external bursts)

---

## 3. Calibration Wizard User Interface & Workflow

The wizard runs as a dedicated View / State within `em_scan`, accessible by holding the **OK** button or selecting **Calibrate RF** from a menu.

```
┌─────────────────────────────────────────────────────────┐
## STEP 1: Preparation Prompt
│  [RF Faraday Zeroing]                                   │
│  Place Flipper inside RF                                │
│  Shielding Bag / Cage.                                  │
│                                                         │
│  [OK = Start Zeroing]                                   │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
## STEP 2: Active Sampling (20 Seconds)
│  Zeroing CC1101...  14s                                 │
│  [████████████░░░░░░░░] 60%                             │
│  300: -84.2dB  815: -91.5dB                             │
│  Live Noise Stability: OK                               │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
## STEP 3: Verification & Save
│  Calibration Passed!                                    │
│  Floors: -84.2 to -91.5dB                               │
│  Saved to SD card.                                      │
│                                                         │
│  [Press OK to Return]                                   │
└─────────────────────────────────────────────────────────┘
```

### Detailed Wizard Logic
1. **Sampling Loop:** Collects **28 full 7-band sweep cycles** (~20 seconds @ 1.43 Hz rate / 200 ticks @ 10 Hz).
2. **Noise Floor Estimation:** Computes the $10^{\text{th}}$ percentile RSSI for each band to isolate the hardware thermal floor from any residual leakage.
3. **Stability Guard:** Calculates standard deviation per band. If $\text{std\_dev} > 3.5\text{ dB}$, the wizard aborts with a warning: *"External RF Detected! Ensure Faraday bag is sealed tightly."*
4. **Checksum & Persistence:** Calculates CRC32, writes to `/ext/biomapping/em_scan_cal.bin`, and blinks the green LED with a success chirp.

---

## 4. Integration with `em_scan` Core Application

### Runtime Startup Flow
When `em_scan` initializes (`em_scan_app()`):

```c
EmScanCal cal;
bool calibrated = em_scan_cal_load(&cal, app->storage);

if(calibrated) {
    FURI_LOG_I("EmScan", "Loaded valid Faraday calibration from SD card");
    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        app->rssi_floor_dbm[i] = cal.noise_floor_dbm[i];
    }
} else {
    FURI_LOG_W("EmScan", "No valid .cal file found — using default baseline array");
    memcpy(app->rssi_floor_dbm, EM_SCAN_BAND_FLOOR_DBM, sizeof(EM_SCAN_BAND_FLOOR_DBM));
}
```

### CSV Logging Integration
When starting a CSV recording, `em_scan` prepends calibration metadata to the log header:
```csv
# EM Scan Walk Log v1.0
# Calibrated: TRUE (Date: 2026-07-25, CRC: 0x8A4E012F)
# Band Floors (dBm): 300:-84.2, 434:-84.0, 446:-84.1, 815:-91.5, 868:-91.5, 915:-91.5
timestamp,lat,lon,hdop,fix_type,em_fog,rssi_300,rssi_434,rssi_446,rssi_815,rssi_868,rssi_915
```

---

## 5. Automated Verification & Testing Strategy

To ensure zero regression, a host-side unit test binary (`tests/test_em_scan_cal.c`) will be added to `./run_tests.sh`:

1. **`test_cal_checksum_valid()`**: Verifies CRC32 calculation and bit-flip detection.
2. **`test_cal_deserialization_bounds()`**: Ensures corrupted values (e.g. $+50\text{ dBm}$) trigger fallback defaults.
3. **`test_cal_stability_rejection()`**: Tests that high variance inputs (unshielded bursts) fail validation.
