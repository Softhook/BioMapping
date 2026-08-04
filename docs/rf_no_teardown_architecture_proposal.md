# Technical Proposal: RF No-Teardown Fast Tuning Architecture for BioMapping

## STATUS (2026-08-04): No-teardown approach abandoned after hardware freeze — see §6

The core idea this document originally proposed — keeping the CC1101 in RX and retuning bands 1/2 without an intervening `idle()` — **froze the Flipper Zero on the very first sweep** when tried on real hardware (serial log stopped mid-sequence, device required a power-cycle to recover, which very likely also caused a secondary SD card corruption on the same run). That specific mechanism (§2/§3 below) is **not implemented** and should not be re-attempted without hardware-in-the-loop bisection. What's actually shipped is a much more conservative fix described in §6: same known-safe per-band retune sequence BioMapping already used, just with the long dwell/park polling window removed. It's slower than this document's original target but still a large improvement, and everything in it reuses code paths already proven not to hang this hardware. Sections 1-5 below are kept as a record of the original (abandoned) proposal; read §6 for what's real.

## Executive Summary (original proposal — see STATUS above)

This document proposed transitioning the **BioMapping** Sub-GHz radio scanning architecture from its legacy radio-teardown mechanism (`idle()` $\rightarrow$ `flush_rx()` $\rightarrow$ `set_frequency_and_path()` $\rightarrow$ `rx()` $\rightarrow$ 3 ms warmup) to an **In-Place Fast Tuning (No-Teardown) Duty-Cycled Architecture**, modeled on the core mechanisms of the **Flipper Zero Frequency Analyzer**.

The claimed benefit was reducing a 3-band RF sweep from **300–900 ms down to ~6 ms** by retuning the TI CC1101 transceiver in place — a single `idle()`/`rx()` bracket for the whole sweep instead of one per band. **This was never achieved: the device froze before completing the first sweep.** See §6 for what was shipped instead (~10 ms via a different, safer mechanism).

**Implementation note (2026-08-04):** the SDK exposed by this project's `~/.ufbt` headers (`furi_hal_subghz.h`) does not provide a raw `furi_hal_subghz_write_reg()` / direct `CC1101_FREQ2/1/0` register API — that call, used in an earlier draft of this proposal, doesn't exist at the app level and would not compile. An interim implementation instead used the SDK's `furi_hal_subghz_set_frequency()` (frequency only, no antenna-path switch) for in-sweep retunes, plus a single `furi_hal_subghz_rx()` re-strobe per band to latch the new frequency — modeled directly on the official Flipper Zero Frequency Analyzer app's retune loop (`applications/main/subghz/helpers/subghz_frequency_analyzer_worker.c`), including its ~2 ms post-retune settle delay, rather than an unverified 150 µs guess. That interim version is what froze the device — see §6.

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

## 3. Proposed Architecture: Duty-Cycled Fast Sweep (No Teardown) — ABANDONED, see §6

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

## 4. Proposed Implementation Plan — ABANDONED, froze the device on first hardware test; see §6

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

## 5. Verification Plan — superseded by §6.4; §5.1's target latency was never reached

### Automated Tests
1. **Host Build Verification:** Run `./run_tests.sh` to ensure all host unit test shims compile cleanly.
2. **SDK API Compliance:** Confirm every `furi_hal_subghz_*` call used actually exists in `~/.ufbt/current/sdk_headers/f7_sdk/targets/f7/furi_hal/furi_hal_subghz.h` — this caught the nonexistent `furi_hal_subghz_write_reg()` in the original draft before it ever reached hardware.

### On-Device Hardware Verification
1. **Sweep Latency Measurement:** Verify via `BIOMAP_DEBUG_FIELDS` telemetry that `tm_rf` execution time drops from **>300 ms** down to **~6-10 ms**. Not sub-3ms — the 2ms-per-band settle delay alone accounts for ~6ms of that, and it is deliberately NOT the more aggressive 150µs-per-band figure the first draft assumed (see §1 implementation note); only shrink it below 2ms after confirming on real hardware that RSSI readings stay valid (§5.3) at a shorter delay.
2. **GPS Sentence Quality Check:** Record a 10-minute walk session while logging NMEA sentence arrival times. Verify `tick_over_150_count` is **0** and no GPS UART sentences are dropped.
3. **RF Sensitivity Check:** Confirm using a handheld sub-GHz transmitter (or ambient background) that RSSI response across 815, 868, and 915 MHz remains dynamic and accurately reflects local signal strength.

---

## 6. What Actually Happened, and What's Shipped Instead

### 6.1 The hardware failure

The §3/§4 implementation (staying in RX across the sweep, retuning bands 1/2 via `set_frequency()` + a bare `rx()` re-strobe with no `idle()`/`flush_rx()` in between) was flashed and run on the actual Flipper Zero. Serial log at the point of failure:

```
21094 [I][GpsUart] Configuring u-blox SAM-M10Q
21094 [I][GpsUart] Switching GPS to 115200 baud
21492 [I][GpsUart] M10Q running at 115200 baud, 10 Hz, GSV@1Hz
21493 [I][GsrSensor] I2C Probe OK
21502 [I][EmScan] freq[0] 815: requested=815000000 actual=814999786
21504 [I][EmScan] freq[1] 868: requested=868350000 actual=868349853
21507 [I][EmScan] freq[2] 915: requested=915000000 actual=914999969
```

That's `em_scan_rf_init()`'s one-time startup calibration log (§ implementation note) completing normally. The device then froze solid — no crash screen, required a power-cycle to recover. Critically, a rate-limited `[I][GsrSensor] RF sweep=...` log had been added specifically to observe the first live sweep, and it **never printed** — meaning the freeze happened inside the very first call to `em_scan_rf_fast_sweep_snapshot()`, before it returned from even one band. The abrupt power-cycle also correlated with a "mounting SD card failed" error on the next boot — consistent with FAT32 corruption from power loss mid-write, not a separate bug.

**Most likely cause:** `furi_hal_subghz_rx()` called a second/third time while the radio is already in RX (no intervening `idle()`). The CC1101 datasheet documents an `SRX` strobe issued while already in RX as a no-op; if this SDK's `rx()` wrapper polls for a state *transition* rather than checking current state before waiting, it would spin forever exactly where the log shows the hang. The also-removed `flush_rx()` (added in an earlier fix specifically after a prior hardware-crash investigation — see `em_scan_rf_crash_investigation.md`) can't be ruled out as a contributing factor either. Given a frozen device and a corrupted SD card are the cost of guessing wrong, both were reverted together rather than bisected further without hardware-in-the-loop access.

### 6.2 The insight that made the safe version possible

The original 300–900 ms cost was never actually coming from the retune sequence itself (`idle → flush_rx → set_frequency_and_path → rx`, a handful of SPI transactions). It came from `em_scan_rf_dwell_band()` / `em_scan_rf_park_band()` polling RSSI repeatedly over a tens-to-hundreds-of-ms **dwell window** per band. Swapping that dwell for a single RSSI read per band — while keeping the exact retune sequence already proven safe elsewhere in this file — captures most of the speedup without touching the part that froze the device.

### 6.3 What's actually implemented (`modules/em_scan_rf.c`)

```c
void em_scan_rf_fast_sweep_snapshot(
    float     out_rssi_dbm[EM_SCAN_NUM_FREQS],
    uint32_t* out_retune_peak_ms) {
    uint32_t retune_peak_ms = 0;

    for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
        uint32_t retune_start = furi_get_tick();
        em_scan_rf_tune_and_warmup(i); // idle -> flush_rx -> set_frequency_and_path -> rx -> 3ms warmup
        uint32_t retune_dur = furi_get_tick() - retune_start;
        if(retune_dur > retune_peak_ms) retune_peak_ms = retune_dur;

        out_rssi_dbm[i] = furi_hal_subghz_get_rssi();
    }

    furi_hal_subghz_idle();

    if(out_retune_peak_ms) *out_retune_peak_ms = retune_peak_ms;
}
```

Every hardware call here is one already used (and working) elsewhere in `em_scan_rf.c` — `em_scan_rf_tune_and_warmup()` is the same helper `em_scan_rf_dwell_band()` and `em_scan_rf_park_band()` already call. No new radio-state-machine sequencing is introduced at all; the only change from the pre-existing dwell/park functions is doing one read instead of a dwell loop, and doing it for all 3 bands back to back.

### 6.4 Actual verification target

~10 ms per 3-band sweep (retune + 3ms warmup, x3), not the originally targeted ~6ms and nowhere near the abandoned design's theoretical ~1.5ms — but still roughly a 30-90x improvement over the 300-900ms baseline, using only sequencing already known not to hang this hardware. §5's verification plan still applies with this revised target; §5.1's "~6-10ms" is now the right ballpark by coincidence, though for a different reason (a full retune+warmup per band, not a fast in-place register write).

### 6.5 If faster is still wanted later

Any future attempt at true in-place retuning (skipping `idle()` between bands) should be bisected on real hardware one variable at a time — e.g., first test keeping `flush_rx()` but dropping `idle()`, separately from dropping the settle delay, separately from skipping the antenna-path switch — rather than combining several untested changes in one pass, which is what made this failure hard to diagnose from a single log capture.
