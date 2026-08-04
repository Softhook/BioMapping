# Technical Proposal: RF No-Teardown Fast Tuning Architecture for BioMapping

## Executive Summary

This document proposes transitioning the **BioMapping** Sub-GHz radio scanning architecture from its legacy radio-teardown mechanism (`idle()` $\rightarrow$ `flush_rx()` $\rightarrow$ `set_frequency_and_path()` $\rightarrow$ `rx()` $\rightarrow$ 3 ms warmup) to an **In-Place Fast Tuning (No-Teardown) Duty-Cycled Architecture**, modeled on the core mechanisms of the **Flipper Zero Frequency Analyzer**.

By retuning the TI CC1101 transceiver in place — a single `idle()`/`rx()` bracket for the whole sweep instead of one per band — during a 10 Hz session tick, BioMapping reduces its 3-band RF sweep duration from **300–900 ms down to ~6 ms**, while preserving **~94% CPU availability** for GPS UART processing, GUI rendering, and SD card logging.

**Implementation note (2026-08-04):** the SDK exposed by this project's `~/.ufbt` headers (`furi_hal_subghz.h`) does not provide a raw `furi_hal_subghz_write_reg()` / direct `CC1101_FREQ2/1/0` register API — that call, used in an earlier draft of this proposal, doesn't exist at the app level and would not compile. The actual implementation instead uses the SDK's `furi_hal_subghz_set_frequency()` (frequency only, no antenna-path switch) for in-sweep retunes, plus a single `furi_hal_subghz_rx()` re-strobe per band to latch the new frequency — modeled directly on the official Flipper Zero Frequency Analyzer app's retune loop (`applications/main/subghz/helpers/subghz_frequency_analyzer_worker.c`), including its ~2 ms post-retune settle delay, rather than an unverified 150 µs guess. See §4 below for the as-built code.

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
3. **Fast VCO Synthesizer Lock (~90–150 $\mu\text{s}$ theoretical; ~2 ms used here):** Because the local oscillator (VCO) is already running in RX mode, small frequency shifts can lock in well under a millisecond without triggering a full `FSCAL` recalibration cycle. The 90–150 µs figure is the CC1101 datasheet's VCO-lock time in isolation; BioMapping's implementation instead reuses the ~2 ms settle delay the official Frequency Analyzer app actually ships with, since that number is real on-hardware-verified behavior rather than a datasheet best case, and this codebase has no way to verify the tighter figure without first confirming the shorter delay is safe on real hardware (see §5).
4. **AGC Gain Stability:** Maintaining active RX state prevents the AGC circuit from resetting to max gain, completely eliminating the need for a 3 ms AGC warm-up delay.

---

## 3. Proposed Architecture: Duty-Cycled Fast Sweep (No Teardown)

To avoid system instability, CPU starvation, high battery drain, and SPI bus congestion, BioMapping will **NOT** use continuous 100% busy-hopping. Instead, it will use a **Duty-Cycled Fast Sweep** synchronized to the 10 Hz (`TICK_HZ = 10`) session recording rate.

```
|-------------------------- 100 ms Session Frame (10 Hz) --------------------------|
[  ~6 ms Active Sweep  ] [-------------------- ~94 ms Free For Other Work ---------]
 (No Per-Band Teardown)   (Worker's native 1ms loop keeps running GPS/GUI/SD work;
                           the sweep just doesn't fire again until the next 100ms tick)
```

### Detailed Timing Breakdown per 100 ms Frame:

1. **Active Sweep Phase (~6 ms Total):**
   * **Band 0 (815 MHz):** `furi_hal_subghz_set_frequency_and_path()` (antenna path selected here, once) $\rightarrow$ `furi_hal_subghz_rx()` $\rightarrow$ `furi_delay_us(2000)` $\rightarrow$ `furi_hal_subghz_get_rssi()`.
   * **Band 1 (868 MHz):** `furi_hal_subghz_set_frequency()` (no path switch — see §4 for why this is safe for these 3 bands) $\rightarrow$ `furi_hal_subghz_rx()` $\rightarrow$ `furi_delay_us(2000)` $\rightarrow$ `furi_hal_subghz_get_rssi()`.
   * **Band 2 (915 MHz):** Same as Band 1.
   * **End Sweep:** Call `furi_hal_subghz_idle()` ONCE to put the radio into low-power idle.

2. **Remaining ~94 ms of the Frame:**
   * Unlike the original proposal, the worker thread does not sleep for a dedicated block of time — it keeps running its existing native ~1 ms loop (ADC sampling, GPS UART, etc.) and simply skips re-entering the RF branch until `RF_SAMPLE_INTERVAL_MS` (100 ms) has elapsed again, via a tick-timestamp gate (`gsr->rf_last_sample_tick`). This fits the worker's existing structure without adding a second sleep/wake cycle — see §4.

---

## 4. Proposed Implementation Plan

### Component 1: `modules/em_scan_rf.c` & `modules/em_scan_rf.h` (as implemented)

```c
#define EM_SCAN_FAST_SWEEP_SETTLE_US 2000

void em_scan_rf_fast_sweep_snapshot(
    float     out_rssi_dbm[EM_SCAN_NUM_FREQS],
    uint32_t* out_retune_peak_ms) { // may be NULL; worst per-band retune sub-step, for diagnostics
    uint32_t retune_peak_ms = 0;

    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        uint32_t retune_start = furi_get_tick();
        if(i == 0) {
            // Antenna path is only switched once per sweep, on band 0 — all
            // configured bands (815/868.35/915 MHz) share one path bucket.
            furi_hal_subghz_set_frequency_and_path(em_scan_freq_hz[i]);
        } else {
            furi_hal_subghz_set_frequency(em_scan_freq_hz[i]);
        }
        // Re-strobe RX (not idle()+rx()) to latch the new frequency word —
        // mirrors the official Frequency Analyzer app's per-step retune.
        furi_hal_subghz_rx();
        uint32_t retune_dur = furi_get_tick() - retune_start;
        if(retune_dur > retune_peak_ms) retune_peak_ms = retune_dur;

        furi_delay_us(EM_SCAN_FAST_SWEEP_SETTLE_US);

        out_rssi_dbm[i] = furi_hal_subghz_get_rssi();
    }

    furi_hal_subghz_idle(); // Return radio to low-power idle once, at sweep end

    if(out_retune_peak_ms) *out_retune_peak_ms = retune_peak_ms;
}
```

No raw register access is used — `furi_hal_subghz_write_reg()` doesn't exist in this SDK (see the implementation note in §1). The no-teardown property comes entirely from never calling `furi_hal_subghz_idle()` (the expensive full state-machine walk) between bands, not from bypassing the driver's frequency-set functions.

`out_retune_peak_ms` exists because retune and RSSI-read are no longer separate top-level calls the worker can time independently (they were, before this change, via `em_scan_rf_set_band()` + a separate `furi_hal_subghz_get_rssi()`) — without it, the `rf_retune_peak_ms` diagnostic column (logged to CSV, see `docs/csv_schema.md`) would silently go dead. See `modules/gsr_sensor.c`'s `rf_rssi_peak_ms`/`rf_retune_peak_ms` struct comment for how the two now relate (the former always ≥ the latter, since it now times the whole call).

### Component 2: `modules/gsr_sensor.c` (as implemented)
`gsr_sensor_worker()`'s existing native ~1ms loop gates entry into the RF branch with a tick-timestamp check instead of adding a dedicated sleep:

```c
// Inside gsr_sensor_worker's existing 1ms-cadence loop:
if(gsr->rf_enabled) {
    uint32_t now_tick = furi_get_tick();
    uint32_t sample_ticks = (RF_SAMPLE_INTERVAL_MS * furi_kernel_get_tick_frequency()) / 1000;
    bool should_sample = (now_tick - gsr->rf_last_sample_tick) >= sample_ticks;
    // (rf_mutex bracketing / rf_spi_busy bookkeeping omitted here — see
    // modules/gsr_sensor.c for the full TOCTOU-safe version)

    if(should_sample) {
        gsr->rf_last_sample_tick = now_tick;
        float    snapshot[EM_SCAN_NUM_FREQS];
        uint32_t retune_dur = 0;
        em_scan_rf_fast_sweep_snapshot(snapshot, &retune_dur);
        for(int b = 0; b < EM_SCAN_NUM_FREQS; b++) {
            gsr->rf_rssi_dbm[b] = snapshot[b];
        }
        if(retune_dur > gsr->rf_retune_peak_ms) gsr->rf_retune_peak_ms = retune_dur;
    }
}
```

---

## 5. Verification Plan

### Automated Tests
1. **Host Build Verification:** Run `./run_tests.sh` to ensure all host unit test shims compile cleanly.
2. **SDK API Compliance:** Confirm every `furi_hal_subghz_*` call used actually exists in `~/.ufbt/current/sdk_headers/f7_sdk/targets/f7/furi_hal/furi_hal_subghz.h` — this caught the nonexistent `furi_hal_subghz_write_reg()` in the original draft before it ever reached hardware.

### On-Device Hardware Verification
1. **Sweep Latency Measurement:** Verify via `BIOMAP_DEBUG_FIELDS` telemetry that `tm_rf` execution time drops from **>300 ms** down to **~6-10 ms**. Not sub-3ms — the 2ms-per-band settle delay alone accounts for ~6ms of that, and it is deliberately NOT the more aggressive 150µs-per-band figure the first draft assumed (see §1 implementation note); only shrink it below 2ms after confirming on real hardware that RSSI readings stay valid (§5.3) at a shorter delay.
2. **GPS Sentence Quality Check:** Record a 10-minute walk session while logging NMEA sentence arrival times. Verify `tick_over_150_count` is **0** and no GPS UART sentences are dropped.
3. **RF Sensitivity Check:** Confirm using a handheld sub-GHz transmitter (or ambient background) that RSSI response across 815, 868, and 915 MHz remains dynamic and accurately reflects local signal strength.
