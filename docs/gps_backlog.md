# GPS Improvement Backlog — Status Review 2026-07-07

## ✅ Implemented (Tier 1 — already delivered)

These are the original Tier 1 items, all confirmed in the codebase:

| # | Item | Where |
|---|------|-------|
| T1.1 | **HDOP-adaptive Kalman** (R₂ = R_base × HDOP², clamped [0.5,10]) | `gps_filter.js:applyKalman()` |
| T1.2 | **Velocity-aided smoothing** (dead-reckon from Doppler speed/course, unit-vector heading EMA) | `gps_filter.js:applyVelocitySmoothing()` |
| T1.3 | **Chi-squared innovation gate** (rejects measurements > 3σ from prediction, P-inflation on reject) | `gps_filter.js:applyKalman()` forward pass |
| T1.4 | **Stop averaging** (collapses stationary clusters ≥ 3 pts @ ≤0.5 kt into centroid) | `gps_filter.js:applyStopAveraging()` |
| T1.5 | **Speed/course CSV logging** (Doppler speedKts + course_deg columns, 10→12 cols) | `biomap_session.c` + `biomap_types.h` |
| T1.6 | **NaN-guard on HDOP** (temp float guards GGA/GSA HDOP/VDOP writes) | `modules/gps_uart.c` |
| T1.7 | **GLL validity flag guard** (A/V check before coordinate overwrite) | `modules/gps_uart.c` |
| T1.8 | **HDOP gate 3.0→5.0** ("good" threshold for urban use) | `biomap_types.h` |
| T1.9 | **Speed filter** (rejects points with Doppler speed > 3 m/s, recovery after 10 consecutive rejections) | `gps_filter.js:applySpeedFilter()` |

---

## ✅ Implemented (Tier 2 items)

| # | Item | Where |
|---|------|-------|
| B2 | **Proper RTS (Rauch-Tung-Striebel) Smoother** — forward pass stores P_fwd[i]; backward pass uses optimal gain A_i = P_fwd[i]/(P_fwd[i]+Q·dt). Per-point 4 m displacement cap. Verified: 55% reduction on synthetic 20 m multipath spike (23.5→10.4 m). | `gps_filter.js:applyKalman()` |
| B4 | **Confirm and Force SBAS/EGNOS** — `$PCAS06,1,1` force-enables WAAS/EGNOS correction during GPS init. PCAS responses logged via `FURI_LOG_D`. | `modules/gps_uart.c:gps_uart_configure()` |

---

## ❌ Not Yet Implemented

---

### B1 · GSV Satellite Elevation Weighting

**What it does**

Satellites near the horizon are up to 4× noisier than overhead ones. The L76K outputs GSV sentences (Satellites in View) with per-satellite elevation angles and SNR. By enabling GSV and parsing it, we can compute a **Weighted DOP** (WDOP) that is more sensitive than raw HDOP — two identical HDOPs can have very different real-world accuracy depending on whether the satellites are high or low.

```
WDOP = sqrt( Σ (1 / sin²(elevationᵢ)) )  for all active satellites
```

Use WDOP instead of HDOP for the quality gate and as the Kalman R scaling factor.

**Changes required**

| File | Change |
|------|--------|
| `modules/gps_uart.c` | Enable GSV in `$PCAS03` config (bit 3 → 1). Add `MINMEA_SENTENCE_GSV` case to parse elevation + PRN per satellite. Store per-satellite data in `GpsStatus`. |
| `modules/gps_uart.h` | Add `sat_elevations[12]` and `sat_prns[12]` arrays to `GpsStatus`. |
| `biomap_session.c` | Compute WDOP from tracked sat elevations; use it as the gate threshold instead of raw `hdop`. |
| `gsr-map-analyzer/gps_filter.js` | Use `wdop` field (once logged) as the R scaling factor in `applyKalman`. |

> **Prerequisite:** Bandwidth check at current baud rate. GSV adds ~150 bytes/epoch. At 9600 baud this is ~78% utilisation; consider enabling `$PCAS01,1` (115200 baud) first.

**Effort:** ⭐⭐⭐ | **Expected gain:** 15–25% better quality discrimination; fewer false-good positions in urban canyons

---

### B3 · 5 Hz GPS Update Rate

**What it does**

Currently `$PCAS02,1000*2E` sets 1 Hz. The L76K supports up to 10 Hz with GGA+RMC+GSA only (the current config). At 5 Hz:

- GPS fixes align better with 10 Hz GSR samples (max misalignment shrinks from 1000 ms to 200 ms)
- The velocity-aided smoother integrates with 5× smaller `dt` → half the dead-reckoning drift
- The speed filter has 5× more data points to work with

**Changes required**

| File | Change |
|------|--------|
| `modules/gps_uart.c` | Change `$PCAS02,1000` → `$PCAS02,200` (200 ms = 5 Hz). Recalculate NMEA checksum. Send `$PCAS01,1` for 115200 baud first. |
| `biomap_session.c` | Update the 1 Hz GPS-only row write logic to 5 Hz, or update the GSR+GPS tick-0 logic if stride needs adjusting. |

> **Baud rate prerequisite:** At 9600 baud, GGA+RMC+GSA ≈ 200 bytes/epoch × 5 Hz = 1000 bytes/s = ~104% utilisation — will overflow. Switch to `$PCAS01,1` (115200 baud) before enabling 5 Hz.

**Effort:** ⭐⭐ (plus baud rate change) | **Expected gain:** Better temporal alignment; smoother velocity-aided integration

---

## Tier 3 — Architectural / Major Features

---

### C1 · HMM-Viterbi Map Matching

**What it does**

Map matching via Hidden Markov Model + Viterbi algorithm snaps GPS points to the actual road/footpath network in OSM, considering the entire sequence at once rather than snapping each point greedily to its nearest segment.

For each GPS fix, *k* candidate road segments (within ~50 m) are identified. Viterbi finds the globally most likely path through those candidates by maximising:

- **Emission probability:** Gaussian distance from the GPS fix to the segment
- **Transition probability:** whether moving from segment A to segment B is plausible via the road graph

This completely eliminates the "GPS jumped to the parallel street" artefact and handles corners cleanly.

**Changes required**

| File | Change |
|------|--------|
| `gsr-map-analyzer/map_match.js` | [NEW] `MapMatcher` class with `match(points, osmGraph)`. Uses spatial index (R-tree or quadtree) for candidate selection; simple Dijkstra/BFS for transition distances. |
| `gsr-map-analyzer/map.js` | Optional post-processing step: call `MapMatcher.match()` on filtered GPS points before rendering. Gated behind a new "Map Match" toggle. |
| `gsr-map-analyzer/index.html` | Add "Enable map matching" toggle to GPS filter panel. |
| `gsr-map-analyzer/osm_enricher.js` | Reuse the existing OSM tile fetch to supply the road graph to `MapMatcher`. |

> **Synergy:** The analyser already fetches OSM road data for environmental enrichment. The same graph feeds the map matcher, sharing the tile cache.

**Effort:** ⭐⭐⭐⭐ | **Expected gain:** Track always on real road/path; apparent accuracy 2–5 m improvement

---

### C2 · Multi-Constellation Dual-Frequency Hardware

**What it does**

The L76K tracks GPS + GLONASS + Galileo + BeiDou at L1 only. Upgrading to a **dual-frequency module** (e.g., u-blox ZED-F9P) provides:

- L1 + L5 ionospheric-free combination — removes ~2.5 m of ionospheric error
- RTK-capable — cm-level accuracy with a base station or PPP-RTK service
- Superior multipath rejection via frequency diversity

The rest of the firmware and analyser stack is unchanged; the ZED-F9P outputs standard NMEA.

**Effort:** Hardware swap | **Expected gain:** Sub-metre accuracy in open sky; 1–3 m urban

---

### C3 · PPP-RTK Correction Service

**What it does**

**Precise Point Positioning – RTK** uses satellite-delivered state-space corrections (SSR) to achieve fast convergence to cm-level accuracy without a local base station. Services like u-blox PointPerfect cover Europe and North America.

**Prerequisites:** Dual-frequency module (C2), and an internet connection on the Flipper (Wi-Fi dev board or companion phone BLE bridge acting as an NTRIP proxy).

**Effort:** Significant (hardware + connectivity) | **Expected gain:** 0.1–0.3 m accuracy in open sky

---

## Deep-Dive: Baud Rate + 5 Hz — System-Wide Implications

This section analyses what happens across the **entire** BioMapping stack when we move from 9600 baud / 1 Hz to 115200 baud / 5 Hz GPS. It is not just a firmware patch — it touches the UART IRQ path, SD card write pattern, session tick architecture, CSV format, analyser load, and error-recovery behaviour.

---

### 1. Baud Rate: 9600 → 115200

#### 1.1 Why it's needed

At 9600 baud the serial link is already at ~78% utilisation with the current GGA+RMC+GSA sentence set. Adding GSV (B1) pushes it past 90%. 5 Hz at 9600 baud is physically impossible — GGA+RMC+GSA ≈ 200 bytes/epoch × 5 Hz = 1000 bytes/s, exceeding the 960-byte/s theoretical ceiling. The baud upgrade is a **hard prerequisite** for both B1 and B3.

#### 1.2 Electrical / Signal Integrity

| Concern | Severity | Mitigation |
|---------|----------|------------|
| **Expansion-port crosstalk** — adjacent pins on the Flipper's 18-pin expansion header have no ground interleaving. At 115200 (bit period 8.7 µs), capacitive coupling between TX and neighboring GPIOs can inject glitches. | Medium | The L76K shield is a rigid PCB with a dedicated UART trace; crosstalk is less of a problem than with a loose wire harness. If issues appear, adding a series 100 Ω resistor at the GPS TX pin slows edge rates. |
| **Cable-length reflection** — if the GPS module is on an extension cable rather than directly plugged in, the 8.7 µs bit period means a reflection must arrive within ~4 µs (≈ 400 m round-trip at 0.5c velocity factor). | Low | Even a 30 cm cable has ~3 ns round-trip — far below threshold. Only becomes relevant with >5 m cables, which are not a use case for a wearable device. |
| **EMI susceptibility at 115200** — the Flipper's Wi-Fi dev board (if present) operates at 2.4 GHz; GSM/LTE from a nearby phone is 700–2600 MHz. Neither couples efficiently into the sub-MHz UART baseband. | Low | Not a practical concern. The L76K itself radiates more EMI (L1 at 1.575 GHz) than anything coupling into the UART lines. |

**Verdict:** 115200 baud on the direct-plug L76K shield is safe. The risk profile is low enough that no hardware mitigation is required for an initial implementation.

#### 1.3 IRQ Load

The current architecture fires one ISR per received byte:

```
ISR → furi_stream_buffer_send() → rx_pending gate → furi_message_queue_put() (once per burst)
```

At 115200 baud the byte rate is 11,520 bytes/s theoretical, but the GPS only transmits ~1000 bytes/s (200 bytes/epoch × 5 Hz). That's ~1000 IRQs/s — roughly one every 1 ms.

The STM32WB55 running at 64 MHz has ~64,000 cycles between IRQs. `furi_stream_buffer_send` is a lightweight FreeRTOS stream buffer push (a handful of instructions). This is **well within budget** — the CPU won't notice.

The `rx_pending` gate ensures only **one** `EventTypeUart` is queued per burst, preventing the main event queue from flooding with 200 identical events per second. This gate logic is unchanged at 115200 baud — it still works correctly because the ISR sets `rx_pending` on the first byte, the main loop clears it during `gps_uart_process_rx()`, and any byte arriving during the drain sets it again.

#### 1.4 Stream Buffer Sizing

`GPS_RX_BUF_SIZE = 5120` bytes. At 1 Hz, a single epoch burst is ~200 bytes — 25× headroom. At 5 Hz with 115200 baud, the worst-case inter-drain interval determines the buffer requirement.

The session event loop drains GPS on `EventTypeUart` events. Between drains, the worst case is the main loop blocked on a long operation (SD write, mutex contention with the render thread). The SD batch flush writes ~500 bytes max (10 GSR rows) — typically <1 ms on a fast SD card, up to 50 ms on a slow one.

At 115200 baud, 50 ms of sustained GPS output = 50 ms × 1000 bytes/s = **50 bytes**. Even with 10× margin for pathological SD latency (500 ms = 500 bytes), the 5120-byte buffer has 10× headroom. **No buffer resize needed.**

#### 1.5 Error Recovery at 115200

If baud rate negotiation fails (the L76K doesn't switch, or noise corrupts the config command), the parser sees garbage. Currently there is no baud-rate watchdog. Mitigations to add:

| Strategy | How |
|----------|-----|
| **Config ACK check** | After sending `$PCAS01,1`, wait 200 ms and verify the PCAS response contains `$PCAS01,1` echoed back. If not, retry or fall back to 9600. |
| **NMEA sanity watchdog** | If no valid NMEA sentence parsed in 5 seconds, assume baud mismatch and re-init at 9600. |
| **Single-byte re-init** | The L76K accepts `$PCAS01,0` (9600) at any baud rate if sent blind — a recovery command doesn't need to parse responses. |

These are small firmware additions (~30 lines) and should be implemented as part of B3.

---

### 2. 5 Hz GPS Update Rate

#### 2.1 Session Tick Architecture Change

The current session loop runs at 10 Hz. The second-boundary logic is:

```c
handle_recording_tick(s);                    // GSR sample + batch CSV row
if (++s->recording.tick_counter >= TICK_HZ) {
    handle_second_boundary(s, notifications); // flush batch, LED, reset counter
}
```

At 1 Hz GPS, the combined GSR+GPS row is written on `tick_counter == 0`:
```c
if (s->recording.tick_counter == 0) {
    // write full 12-column GPS+GSR row
} else {
    // write GSR-only row (empty GPS columns)
}
```

At 5 Hz, the design decision is: **do we log GPS at 5 Hz (every 2nd tick) or keep GPS logging at 1 Hz but just update the internal position at 5 Hz?**

**Option A: Log GPS at 5 Hz (every tick 0, 2, 4, 6, 8)**

- CSV grows 5× in row count for GPS+GSR mode
- Every 2nd GSR row becomes a full 12-column row instead of every 10th
- Analyser parsing time grows linearly with row count
- The `sd_logger_batch` buffer (512 bytes) currently holds 10 GSR-only rows (~45 bytes each = 450 bytes). At 5 Hz GPS, 5 of those 10 rows become 12-column rows (~85 bytes each). Total: 5×85 + 5×45 = 650 bytes → **batch buffer overflow**.

**Option B: Log GPS at 1 Hz, sample position at 5 Hz**

- Keep CSV format unchanged (GPS row on tick 0 only)
- Use the 5 Hz positions internally: the `get_gps_position()` call becomes more accurate (position is only 200 ms old instead of 1000 ms), but the analyser sees the same data density
- Minimal code change — just change `PCAS02,200` and leave the session loop alone
- **Misses the whole point** of 5 Hz: the analyser has no extra data to work with

**Recommendation: Option A with a batch buffer increase.** The analyser already handles large CSVs (validated on hour-long sessions). The batch buffer needs to grow from 512 to 1024 bytes. This is the right trade-off — slightly larger firmware memory footprint for a 5× improvement in temporal resolution.

#### 2.2 SD Card Write Pattern

Current: 1 flush per second, ~500 bytes per flush, ~10 write operations per minute session.

At 5 Hz GPS (Option A): still 1 flush per second (the batch buffer still flushes on the second boundary). But each flush is larger: ~650 bytes instead of ~500. **The flush frequency does not change** — only the payload size grows by ~30%.

SD card wear: negligible. A 60-minute session at 1 flush/sec = 3600 writes. Modern SD cards are rated for 100,000+ write cycles per block. Wear levelling in the FAT filesystem means these 3600 writes are distributed across the card.

**No change needed to `sd_logger` flush logic.** Only the batch buffer size constant changes.

#### 2.3 CSV Format — No Schema Change

The CSV header stays identical:
```
timestamp,lat,lon,alt,hdop,vdop,sats,fix,fix_type,speed_kts,course_deg,gsr_raw
```

The only difference is that 50% of rows now have filled GPS columns instead of 10%. The analyser's existing `hasVelData` detection and `NaN`-skip logic handles this transparently — old 1 Hz CSVs and new 5 Hz CSVs parse identically.

#### 2.4 Inter-Sentence Timing Within a 200 ms Epoch

At 1 Hz the L76K has a full second to output GGA, GSA, and RMC. At 5 Hz the epoch window shrinks to 200 ms. The L76K outputs NMEA sentences in a burst at the fix epoch boundary — typically GGA first, then GSA, then RMC — all within ~50 ms at 115200 baud (200 bytes ÷ 11520 bytes/s ≈ 17 ms).

The concern: does the parser see all three sentences before the session reads `get_gps_position()`?

The session reads GPS position at tick boundaries (every 100 ms at 10 Hz). The UART drain (`gps_uart_process_rx`) happens on `EventTypeUart` events, which fire as soon as the first byte of a burst arrives. At 115200 baud the entire burst is received within ~17 ms — well before the next 100 ms tick.

But there's a race: `gps_uart_process_rx` parses complete lines from the RX buffer sequentially. If only GGA has arrived when `get_gps_position` is called (on tick 0), the position will use GGA coordinates but lack RMC speed/course. The next tick (100 ms later) will have all three.

**This is already the case at 1 Hz** — the race between GGA and RMC arrival within a burst already exists. The solution (already implemented): `batch_csv_row` checks `has_vel` and emits empty speed/course fields when RMC hasn't arrived yet. At 5 Hz the window is just as wide (17 ms burst at 115200 vs 170 ms burst at 9600 — proportionally identical at ~8.5% of the epoch period).

**No new race condition.** The existing NaN-guard handles it.

#### 2.5 GSR Temporal Alignment

At 1 Hz: GPS fix is up to 1000 ms old relative to the GSR sample it's paired with. At 5 Hz: max age shrinks to 200 ms.

For a person walking at 1.4 m/s, the position error from temporal misalignment drops from ~1.4 m to ~0.28 m. This matters for environmental enrichment — a 1.4 m offset can place the user in the wrong OSM land-use polygon (e.g., "in park" vs "on road").

The velocity-aided smoother also benefits: with dt ≤ 200 ms instead of ≤ 1000 ms, dead-reckoning drift per step is 5× smaller. This compounds with the HDOP-adaptive blending for a net improvement in the analyser's output path.

#### 2.6 LED Indicator Behaviour

The blue "GPS not ready" LED currently blinks at 1 Hz (100 ms every 1 second when HDOP > gate). At 5 Hz position updates, the `get_gps_position()` call in `handle_second_boundary` will see positions that are up to 200 ms old. The LED logic doesn't change — it still checks once per second on the second boundary. **No behavioural change.**

#### 2.7 Analyser Performance Impact

5× more GPS rows means 5× more points entering the filter pipeline. The Kalman+RTS smoother is O(n) per pass — an hour-long session goes from ~3600 GPS points to ~18,000.

On a modern browser, the Kalman+RTS processes ~100,000 points/second in pure JS. 18,000 points ≈ 180 ms — imperceptible. The real bottleneck is Leaflet polyline rendering, which already decimates for zoom level.

**The analyser handles 5 Hz data without modification.** The pipeline is already designed for variable-density input (the `GPS_INTERP_MAX_GAP_S = 30` interpolation logic handles gaps of any size).

---

### 3. Implementation Plan for B3 (Baud + 5 Hz)

#### Step 1: Baud rate upgrade (firmware)

```
gps_uart_configure():
  pcas_tx("$PCAS01,1*xx\r\n")   // switch to 115200 (checksum TBD)
  furi_delay_ms(200)             // let GPS switch
  furi_hal_serial_deinit(...)
  furi_hal_serial_init(..., 115200)  // re-init UART at new rate
  pcas_tx("$PCAS04,7*1E\r\n")   // re-send constellation config
  pcas_tx("$PCAS03,...")         // re-send NMEA filter
  pcas_tx("$PCAS02,200*xx\r\n") // 5 Hz (new checksum)
  pcas_tx("$PCAS06,1,1*07\r\n") // SBAS
```

**Critical detail:** The baud change must happen BEFORE the rate change. If we send `$PCAS02,200` at 9600 baud and then switch to 115200, the GPS is already outputting at 5 Hz on the old baud — the UART peripheral sees framing errors for 200 ms until the re-init completes.

#### Step 2: Batch buffer resize (firmware)

```c
// sd_logger.h or sd_logger.c
char gsr_batch[1024];  // was 512
```

#### Step 3: Session tick logic (firmware)

Change `batch_csv_row` to log GPS on every tick where `tick_counter % 2 == 0` (every 200 ms at 10 Hz tick rate) instead of only `tick_counter == 0`:

```c
// In batch_csv_row:
if (s->recording.tick_counter % (TICK_HZ / 5) == 0) {  // every 2nd tick
    // write full GPS+GSR row
}
```

#### Step 4: Baud error recovery (firmware)

Add a 5-second NMEA watchdog in the session loop: if no valid `$Gx` sentence parsed, attempt re-init at 9600, then re-attempt 115200.

#### Step 5: No analyser changes needed

The analyser pipeline is already density-agnostic. The only optional improvement is a configurable decimation factor in the UI ("Show every Nth GPS point") for users who prefer sparser markers on the map, but this is cosmetic.

---

### 4. Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Baud negotiation fails silently | Low | GPS data is garbage; session logs empty rows | NMEA watchdog + config ACK check |
| Batch buffer overflow at 5 Hz | Medium | Truncated CSV rows; data loss | Increase buffer to 1024 bytes |
| SD card write latency spike | Low | One-second boundary delayed; timer drift | Already handled — batch flush is non-blocking (FreeRTOS stream buffer) |
| L76K fix quality degrades at 5 Hz | Low | Slightly noisier positions | L76K datasheet specifies 5 Hz as supported; AT6558R can do 10 Hz |
| Analyser becomes slow with 5× data | Low | Perceived UI lag | Pipeline is O(n); JS handles 18k points in <200 ms |
| IRQ storm at 115200 | Very low | CPU starvation | Only 1000 IRQs/s; STM32WB at 64 MHz has 64k cycles between them |

---

## Recommended Implementation Order

```
Week 1:
  B3  5 Hz rate + baud upgrade (1–2 days firmware)
  B1  GSV elevation weighting (3–4 days, firmware + analyser)

Following sprint:
  C1  HMM-Viterbi map matching (1–2 weeks, analyser-only)

When hardware budget allows:
  C2 → C3  ZED-F9P + PPP-RTK
```

---

## Pipeline Summary (current state)

The analyser filter pipeline in `map.js:_applyCoreFilters()` runs these in order:

```
1. applyStopAveraging()      — collapse stationary jitter into centroids
2. applySpeedFilter()         — reject impossible Doppler-speed jumps (>3 m/s)
3. applyVelocitySmoothing()   — dead-reckon blend with HDOP-adaptive α
4. applyKalman()              — HDOP-adaptive forward Kalman + RTS backward smoother
                                  with chi-squared innovation gate and 4 m displacement cap
```
