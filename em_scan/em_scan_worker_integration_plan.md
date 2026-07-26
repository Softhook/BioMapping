# Technical Specification & Plan: Sub-GHz EM Scan Worker Integration

This document outlines the technical design, architectural plan, and step-by-step implementation for integrating the **Sub-GHz EM Scan** module (`em_scan`) into Bio Mapping's primary background worker ([modules/gsr_sensor.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gsr_sensor.c)).

---

## 1. Executive Summary & Problem Statement

### The Problem in Current `em_scan`
In the standalone `em_scan` module ([em_scan.c](file:///Users/softhook/Documents/GitHub/BioMapping/em_scan/em_scan.c)), every 100 ms tick executes `em_scan_rf_dwell_band()` synchronously on the main thread. This function performs a 3 ms warmup delay plus a 22 ms RSSI peak-hold dwell loop, blocking the main event loop thread for **25 ms out of every 100 ms tick** (**25% of every second**).

### The Solution: GSR-Primary Interleaved Worker Architecture
Instead of freezing the main event loop or spawning a risky 3rd thread, Sub-GHz CC1101 RSSI sampling is interleaved into `GsrSensorWorker`'s existing idle sleep window.

Because the ADS1115 ADC operates continuously at 860 SPS (one conversion every 1,162 µs), the worker spends **~80 µs** reading I2C and **~1,082 µs ASLEEP (`furi_delay_ms(1)`)**. Performing a **5 µs SPI read** of the CC1101 RSSI register inside that 1,082 µs sleep window achieves high-density RF sampling with **0 ms main-thread delay** and **100% rock-solid GSR performance**.

---

## 2. Execution Schedule & Timing

```
0 µs                80 µs           85 µs                                 1162 µs
├───────────────────┼───────────────┼─────────────────────────────────────┤
│ 1. Read ADS1115   │ 2. Read CC1101│ 3. Yield to FreeRTOS (furi_delay_ms)│
│    I2C Sample     │    SPI RSSI   │    (1077 µs CPU Sleep Window)       │
│    (GSR PRIMARY)  │    (5 µs)     │                                     │
└───────────────────┴───────────────┴─────────────────────────────────────┘
```

### System Health & Buffer Guarantees
- **GSR Sampling:** Absolute priority #1. ADS1115 I2C ADC read executes FIRST on every iteration. 860 SPS throughput, PGA autoranging, TIA math, and boxcar IIR filtering remain 100% untouched.
- **High-Speed GPS:** At 115,200 baud (10 Hz SAM-M10Q mode), NMEA bursts (288 bytes / 25 ms) are buffered by `rx_stream` (`GPS_RX_BUF_SIZE = 5120 bytes` in [modules/gps_uart.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gps_uart.c)), utilizing <6% of available buffer capacity.
- **Thread Count:** Total application threads remain strictly at **2** (Main GUI Thread + GSR-Primary Worker Thread), avoiding multi-thread stack overflows and deadlock risks.

---

## 3. Proposed Code Architecture

### A. Non-Blocking Single-Step RF Sweep ([em_scan_rf.c](file:///Users/softhook/Documents/GitHub/BioMapping/em_scan/em_scan_rf.c))

```c
// Non-blocking single SPI RSSI read for current band
void em_scan_rf_step_rssi(int band_index, float* out_rssi) {
    // 5 µs SPI register read over internal CC1101 SPI bus
    *out_rssi = furi_hal_subghz_get_rssi();
}
```

### B. Interleaved Worker Loop ([modules/gsr_sensor.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gsr_sensor.c))

```c
static int32_t gsr_sensor_worker(void* context) {
    GsrSensor* gsr = context;
    
    while(gsr->running) {
        // STEP 1 (PRIMARY): Read ADS1115 I2C GSR Sample (~80 µs)
        furi_hal_i2c_acquire(&furi_hal_i2c_handle_external);
        uint8_t data[2];
        bool ok = furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external,
                                         ADS1115_I2C_ADDR, ADS1115_CONV_REG,
                                         data, 2, 50);
        furi_hal_i2c_release(&furi_hal_i2c_handle_external);
        
        if(ok) {
            gsr_store_sample_internal(gsr, data);
        }

        // STEP 2 (SECONDARY): Interleaved Sub-GHz SPI RSSI Read (~5 µs)
        if(gsr->em_scan_enabled) {
            float rssi = furi_hal_subghz_get_rssi();
            em_scan_update_peak_internal(gsr->em_scan, rssi);
        }

        // STEP 3: Sleep remaining ~1,077 µs until next 860 SPS ADC conversion
        furi_delay_ms(1);
    }
    return 0;
}
```

---

## 4. Flipper Sub-GHz Settings & Calibration Integration

1. **User Settings Integration (`subghz_setting`):**
   Use `lib/subghz/subghz_setting.h` (`subghz_setting_alloc()`, `subghz_setting_load()`) to dynamically read user-configured frequency lists and custom presets from `/ext/subghz/assets/setting_user`.
2. **Frequency Validity Bounds:**
   Guard all frequency tuning calls with `furi_hal_subghz_is_frequency_valid(freq)` to prevent tuning into forbidden CC1101 hardware band gaps (348–387 MHz, 464–779 MHz).
3. **Faraday Hardware Calibration (`em_scan_cal.bin`):**
   Implement the Faraday zeroing wizard specified in [em_scan_calibration_plan.md](file:///Users/softhook/Documents/GitHub/BioMapping/em_scan/em_scan_calibration_plan.md) to store per-device, per-band baseline thermal noise floors in `/ext/biomapping/em_scan_cal.bin`.

---

## 5. File Change Summary

| File Path | Action | Description |
| :--- | :--- | :--- |
| [em_scan/em_scan_rf.h](file:///Users/softhook/Documents/GitHub/BioMapping/em_scan/em_scan_rf.h) | Modify | Add single-step RSSI read interface and frequency validity checks |
| [em_scan/em_scan_rf.c](file:///Users/softhook/Documents/GitHub/BioMapping/em_scan/em_scan_rf.c) | Modify | Implement `subghz_setting` API integration and single-step SPI read |
| [modules/gsr_sensor.h](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gsr_sensor.h) | Modify | Add opt-in EM Scan state handle and getters |
| [modules/gsr_sensor.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gsr_sensor.c) | Modify | Interleave Sub-GHz SPI RSSI read into worker sleep window |
| [biomap_session.c](file:///Users/softhook/Documents/GitHub/BioMapping/biomap_session.c) | Modify | Log `em_fog` and `rssi_<freq>` columns into CSV logs |
| [em_scan/em_scan_cal.c](file:///Users/softhook/Documents/GitHub/BioMapping/em_scan/em_scan_cal.c) | New | Faraday calibration zeroing wizard & binary persistence |
