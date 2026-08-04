# Technical Proposal: RF No-Teardown Fast Tuning Architecture for BioMapping

## Executive Summary

This document proposes transitioning the **BioMapping** Sub-GHz radio scanning architecture from its legacy radio-teardown mechanism (`idle()` $\rightarrow$ `flush_rx()` $\rightarrow$ `set_frequency_and_path()` $\rightarrow$ `rx()` $\rightarrow$ 3 ms warmup) to an **In-Place Fast Tuning (No-Teardown) Duty-Cycled Architecture**, modeled on the core mechanisms of the **Flipper Zero Frequency Analyzer**.

By keeping the TI CC1101 transceiver in an active `RX` state and writing frequency registers directly over SPI during a 10 Hz session tick, BioMapping will reduce its 3-band RF sweep duration from **300–900 ms down to ~1.5 ms**, while preserving **98% CPU availability** for GPS UART processing, GUI rendering, and SD card logging.

---

## 1. Problem Statement: Current BioMapping Teardown Overhead

BioMapping currently measures ambient radiofrequency energy across three Sub-GHz ISM bands (815 MHz, 868.35 MHz, and 915 MHz). In [`modules/em_scan_rf.c`](file:///Users/softhook/Documents/GitHub/BioMapping/modules/em_scan_rf.c), every frequency transition calls `em_scan_rf_tune_and_warmup()`:

```c
// Current BioMapping Tuning Teardown Sequence (em_scan_rf.c)
static void em_scan_rf_tune_and_warmup(int band_index) {
    furi_hal_subghz_idle();                         // 1. Strobes SIDLE -> CC1101 drops to IDLE state
    furi_hal_subghz_flush_rx();                     // 2. Strobes SFRX  -> Flushes RX FIFO
    furi_hal_subghz_set_frequency_and_path(freq);  // 3. Full SPI write to FREQ2/1/0 + antenna switch
    furi_hal_subghz_rx();                           // 4. Strobes SRX   -> Re-enables RX mode
    furi_delay_ms(EM_SCAN_WARMUP_MS);               // 5. Waits 3 ms for AGC acquisition transient
}
```

### Key Issues with the Current Design:
1. **Radio State Teardown Penalties:** Dropping to `IDLE` before every hop shuts down the CC1101 receiver pipeline. Strobing `SRX` forces a full internal state machine sequence (`IDLE` $\rightarrow$ `FS_WAKEUP` $\rightarrow$ `CALIBRATE` $\rightarrow$ `SETTLING` $\rightarrow$ `RX`), incurring ~750 $\mu\text{s}$ of Frequency Synthesizer Calibration (`FSCAL`) overhead per hop.
2. **AGC Acquisition Transients:** Restarting `RX` forces the Automatic Gain Control (AGC) circuit to reset to maximum gain, producing false signal spikes. BioMapping compensates by forcing a 3 ms warm-up delay (`EM_SCAN_WARMUP_MS`) on every hop.
3. **RTOS Delay Inflation:** BioMapping's dwell/park loops call `furi_delay_ms(1)` or `furi_delay_ms(10)` inside `while` loops. Due to FreeRTOS tick quantization and task context-switching overhead, 1 ms delays frequently take **2.5 to 4.0 ms** of wall-clock time. A configured 300 ms park inflates to **630–670 ms** of real time.
4. **GPS UART Risk:** Dwelling on RF for hundreds of milliseconds starves the session thread, delaying the processing of `EventTypeUart` events and degrading NMEA GPS parsing accuracy.

---

## 2. Technical Insights from Flipper Zero Frequency Analyzer

The Flipper Zero Frequency Analyzer and community Spectrum Analyzer applications achieve ultra-fast, fluid channel sweeps by leveraging specific hardware characteristics of the TI CC1101 transceiver:

1. **Continuous RX State (No Teardown):** The transceiver is placed into `RX` mode once at the start of a sweep frame and remains in `RX` mode as frequency registers are updated.
2. **Direct `FREQ` Register Writes:** Frequency changes are written directly to registers `CC1101_FREQ2` (0x0D), `CC1101_FREQ1` (0x0E), and `CC1101_FREQ0` (0x0F) over SPI without strobing `SIDLE` or `SFRX`.
3. **Fast VCO Synthesizer Lock (~90–150 $\mu\text{s}$):** Because the local oscillator (VCO) is already running in RX mode, small frequency shifts lock within ~90–150 microseconds without triggering a full `FSCAL` recalibration cycle.
4. **AGC Gain Stability:** Maintaining active RX state prevents the AGC circuit from resetting to max gain, completely eliminating the need for a 3 ms AGC warm-up delay.

---

## 3. Proposed Architecture: Duty-Cycled Fast Sweep (No Teardown)

To avoid system instability, CPU starvation, high battery drain, and SPI bus congestion, BioMapping will **NOT** use continuous 100% busy-hopping. Instead, it will use a **Duty-Cycled Fast Sweep** synchronized to the 10 Hz (`TICK_HZ = 10`) session recording rate.

```
|-------------------------- 100 ms Session Frame (10 Hz) --------------------------|
[ 1.5 ms Active Sweep ] [------------------- 98.5 ms Sleep Yield -------------------]
 (No RF Teardown)        (Thread sleeping; FreeRTOS gets 98% CPU for GPS/GUI/SD)
```

### Detailed Timing Breakdown per 100 ms Frame:

1. **Active Sweep Phase (~1.5 ms Total):**
   * **Start Frame:** Call `furi_hal_subghz_rx()` ONCE to enter receive state.
   * **Band 0 (815 MHz):** Direct SPI write to `FREQ2..0` $\rightarrow$ `furi_delay_us(150)` $\rightarrow$ Read `CC1101_RSSI` register.
   * **Band 1 (868 MHz):** Direct SPI write to `FREQ2..0` $\rightarrow$ `furi_delay_us(150)` $\rightarrow$ Read `CC1101_RSSI` register.
   * **Band 2 (915 MHz):** Direct SPI write to `FREQ2..0` $\rightarrow$ `furi_delay_us(150)` $\rightarrow$ Read `CC1101_RSSI` register.
   * **End Sweep:** Call `furi_hal_subghz_idle()` ONCE to put the radio into low-power idle.

2. **Sleep Yield Phase (~98.5 ms Total):**
   * Call `furi_delay_ms(98)` to yield the thread back to FreeRTOS.
   * During this 98 ms window, the thread is 100% suspended. FreeRTOS allocates **98% of CPU cycles** to GPS UART parsing, GUI drawing, and SD writing.

---

## 4. Proposed Implementation Plan

### Component 1: `modules/em_scan_rf.c` & `modules/em_scan_rf.h`
Add a dedicated, non-teardown fast-sweep function:

```c
// Performs a single-pass 3-band sweep in ~1.5 ms without RF teardown
void em_scan_rf_fast_sweep_snapshot(float out_rssi_dbm[EM_SCAN_NUM_FREQS]) {
    furi_hal_subghz_rx(); // Enter RX state ONCE

    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        // Direct FREQ register update over SPI (In-place tuning, no IDLE strobe)
        uint32_t freq_val = (uint32_t)((double)em_scan_freq_hz[i] * 65536.0 / 26000000.0);
        uint8_t freq_regs[3] = {
            (uint8_t)(freq_val >> 16),
            (uint8_t)(freq_val >> 8),
            (uint8_t)(freq_val)
        };
        furi_hal_subghz_write_reg(CC1101_FREQ2, freq_regs[0]);
        furi_hal_subghz_write_reg(CC1101_FREQ1, freq_regs[1]);
        furi_hal_subghz_write_reg(CC1101_FREQ0, freq_regs[2]);

        // Microsecond PLL lock delay (blocks CPU for only 150 microseconds)
        furi_delay_us(150);

        // Read RSSI status register
        out_rssi_dbm[i] = furi_hal_subghz_get_rssi();
    }

    furi_hal_subghz_idle(); // Return radio to low-power idle
}
```

### Component 2: `modules/gsr_sensor.c`
Update `gsr_sensor_worker()` to replace the long park/dwell loop with the duty-cycled fast sweep:

```c
// Inside gsr_sensor_worker thread loop:
if(gsr->rf_enabled) {
    float snapshot[EM_SCAN_NUM_FREQS];
    em_scan_rf_fast_sweep_snapshot(snapshot);

    furi_mutex_acquire(gsr->rf_mutex, FuriWaitForever);
    for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
        gsr->rf_rssi_dbm[b] = snapshot[b];
    }
    furi_mutex_release(gsr->rf_mutex);
}

// Sleeping yield: Gives 98 ms per 100 ms frame back to FreeRTOS
furi_delay_ms(98);
```

---

## 5. Verification Plan

### Automated Tests
1. **Host Build Verification:** Run `./run_tests.sh` to ensure all host unit test shims compile cleanly.
2. **SPI API Compliance:** Verify that direct register writes use valid `furi_hal_subghz_*` SDK functions (`furi_hal_subghz_write_reg`).

### On-Device Hardware Verification
1. **Sweep Latency Measurement:** Verify via `BIOMAP_DEBUG_FIELDS` telemetry that `tm_rf` execution time drops from **>300 ms** down to **< 3 ms**.
2. **GPS Sentence Quality Check:** Record a 10-minute walk session while logging NMEA sentence arrival times. Verify `tick_over_150_count` is **0** and no GPS UART sentences are dropped.
3. **RF Sensitivity Check:** Confirm using a handheld sub-GHz transmitter (or ambient background) that RSSI response across 815, 868, and 915 MHz remains dynamic and accurately reflects local signal strength.
