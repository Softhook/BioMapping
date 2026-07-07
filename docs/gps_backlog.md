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

### B3 · GPS Update Rate — From 1 Hz to 2 Hz (phase 1), then 5 Hz (phase 2)

#### Why not just jump to 5 Hz?

The session loop ticks at 10 Hz, so clean GPS-on-tick alignments exist only at rates that divide evenly into 10 Hz: **1, 2, 5, or 10 Hz**. Here's what each rate buys you for a person walking at 1.4 m/s:

| Rate | PCAS02 | Ticks between GPS | Distance between fixes | Dead-reckon step | CSV GPS rows | Batch buf needed |
|------|--------|-------------------|----------------------|------------------|-------------|-----------------|
| 1 Hz | 1000   | 10 (every tick 0) | 1.40 m               | 1000 ms          | 10%          | 490 B (fits 512) |
| 2 Hz | 500    | 5  (ticks 0,5)    | 0.70 m               | 500 ms           | 20%          | 530 B (needs 1024) |
| 5 Hz | 200    | 2  (every even)   | 0.28 m               | 200 ms           | 50%          | 650 B (needs 1024) |
| 10 Hz| 100    | 1  (every tick)   | 0.14 m               | 100 ms           | 100%         | 850 B (needs 1024) |

The velocity-aided smoother already uses Doppler speed+course (carrier-phase derived, ~10× more accurate than position) to dead-reckon between GPS fixes. At 1 Hz the smoother bridges 1.4 m gaps surprisingly well in straight-line motion. **The weak spot is turns** — Doppler can't predict a corner, so the dead-reckoned path overshoots. At a sharp 90° turn at 1.4 m/s, the error at the corner apex is:
- 1 Hz: ~1.4 m (dead-reckons straight for 1000 ms)
- 2 Hz: ~0.7 m (500 ms)
- 5 Hz: ~0.28 m (200 ms)

#### The fix-quality trade-off

Budget GNSS chips like the L76K/AT6558R have less integration time per fix at higher update rates. At 10 Hz, individual fixes can become noisier as tracking loops get less signal. At 5 Hz this is generally fine on the AT6558R. At 2 Hz, fix quality is **identical** to 1 Hz — 500 ms of integration is already past the point of diminishing returns for a consumer-grade receiver.

#### What actually matters for the use case?

The BioMapping use case is **environmental enrichment** — mapping GSR arousal onto OSM land-use polygons (parks, roads, buildings). The relevant spatial scale is ~5–10 m (road width, park boundary). GPS position accuracy in urban environments is already ~3–5 m. Going from 1.4 m between fixes (1 Hz) to 0.7 m (2 Hz) cuts the worst-case polygon misclassification in half. Going further to 0.28 m (5 Hz) helps, but the GPS position error itself is the limiting factor, not the sampling density.

For **path rendering smoothness**, the Kalman+RTS smoother already produces clean trajectories at 1 Hz. The analyser's `GPS_INTERP_MAX_GAP_S = 30` s interpolation fills gaps up to 30 seconds — more GPS points mainly reduce how often interpolation is needed.

#### Recommendation: phased approach

| Phase | Rate | Rationale |
|-------|------|-----------|
| **Phase 1** | 2 Hz | Safest first step. Validates the baud upgrade at low throughput. Fix quality is identical to 1 Hz. Dead-reckoning drift is halved. Tick alignment is clean (`tick_counter % 5 == 0`). Batch buffer bump to 1024 B is the only firmware change beyond the baud upgrade. |
| **Phase 2** | 5 Hz | If 2 Hz is stable and the L76K fix quality holds, try 5 Hz. Further reduces turn-overshoot and gives the speed filter 2.5× more data points. Only proceed after validating Phase 1 on real urban walks. |
| **Skip** | 10 Hz | Diminishing returns. 100% of CSV rows become GPS rows (file bloat). Fix quality likely degrades on the AT6558R. The smoother already handles 200 ms gaps well enough at 5 Hz. |

**Changes required (Phase 1 — 2 Hz)**

| File | Change |
|------|--------|
| `modules/gps_uart.c` | Send `$PCAS01,1` (115200 baud), then `$PCAS02,500` (2 Hz). Add baud ACK check + NMEA watchdog. |
| `modules/sd_logger.c` | Bump `gsr_batch` from 512 → 1024 bytes. |
| `biomap_session.c` | Change `tick_counter == 0` → `tick_counter % 5 == 0` for GPS row trigger in `batch_csv_row`. Same pattern for GPS-only mode in `handle_second_boundary`. |

**Changes required (Phase 2 — 5 Hz, incremental on Phase 1)**

| File | Change |
|------|--------|
| `modules/gps_uart.c` | Change `$PCAS02,500` → `$PCAS02,200`. |
| `biomap_session.c` | Change `tick_counter % 5 == 0` → `tick_counter % 2 == 0`. |

**Effort:** ⭐⭐ (Phase 1) + ⭐ (Phase 2) | **Expected gain:** Halved dead-reckoning drift; better corner tracking; validated baud upgrade path

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

## Deep-Dive: Baud Rate + GPS Update Rate — System-Wide Implications

This section analyses what happens across the **entire** BioMapping stack when we move from 9600 baud / 1 Hz to 115200 baud / 2 Hz (Phase 1) and eventually 5 Hz (Phase 2). It is not just a firmware patch — it touches the UART IRQ path, SD card write pattern, session tick architecture, CSV format, analyser load, and error-recovery behaviour.

### 0. Rate Selection Rationale — Why 2 Hz First, Not 5 Hz

Before diving into implementation, here's why 2 Hz is the right first step:

**The velocity-aided smoother already bridges gaps.** Doppler velocity from GPS carrier-phase tracking is ~10× more accurate than code-pseudorange position. At 1 Hz, the smoother dead-reckons 1.4 m between fixes with <0.5 m drift in straight-line motion. The only weakness is **turns** — Doppler can't predict a corner. At a 90° turn at walking speed (1.4 m/s):

| Rate | Dead-reckon gap | Max turn-overshoot |
|------|----------------|-------------------|
| 1 Hz | 1000 ms | ~1.4 m |
| 2 Hz | 500 ms  | ~0.7 m |
| 5 Hz | 200 ms  | ~0.28 m |

**The use case doesn't demand sub-metre sampling.** BioMapping correlates GSR arousal with OSM land-use polygons at 5–10 m resolution. GPS position error in urban environments is already 3–5 m. Halving the dead-reckoning gap from 1.4 m to 0.7 m (2 Hz) eliminates the worst-case polygon misclassifications. Going further to 0.28 m (5 Hz) is nice but the GPS position error, not the sampling density, is the limiting factor.

**Fix quality holds at 2 Hz, may degrade at 10 Hz.** The L76K/AT6558R is a consumer-grade chip. At 2 Hz (500 ms integration per fix), quality is identical to 1 Hz. At 5 Hz (200 ms), quality is generally fine. At 10 Hz (100 ms), individual fixes can become noisier. Starting at 2 Hz validates the baud upgrade at low risk; 5 Hz is a low-risk follow-up.

**Tick alignment is cleaner at 2 Hz.** The 10 Hz session loop gives clean alignments at rates that divide evenly: 1, 2, 5, 10 Hz. At 2 Hz, GPS rows land on `tick_counter % 5 == 0` (ticks 0 and 5) — two evenly-spaced rows per second. At 5 Hz, GPS rows land on every even tick — 5 rows per second, 50% of the CSV.

**The batch buffer bump to 1024 bytes covers all rates up to 10 Hz.** Do it once in Phase 1 and Phase 2 requires only a one-line PCAS02 change.

---

### 1. Baud Rate: 9600 → 115200

#### 1.1 Why it's needed

At 9600 baud the serial link is already at ~78% utilisation with the current GGA+RMC+GSA sentence set. Adding GSV (B1) pushes it past 90%. Any rate above 1 Hz at 9600 baud is physically impossible — GGA+RMC+GSA ≈ 200 bytes/epoch × 2 Hz = 400 bytes/s is already pushing the 960-byte/s ceiling once you account for start/stop bits and inter-sentence gaps. The baud upgrade is a **hard prerequisite** for both B1 and any rate increase.

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

The session event loop drains GPS on `EventTypeUart` events. Between drains, the worst case is the main loop blocked on a long operation (SD write, mutex contention with the render thread). The SD batch flush writes ~500 bytes max — typically <1 ms on a fast SD card, up to 50 ms on a slow one.

At 115200 baud, 50 ms of sustained GPS output at 5 Hz = 50 ms × 1000 bytes/s = **50 bytes**. Even with 10× margin for pathological SD latency (500 ms = 500 bytes), the 5120-byte buffer has 10× headroom. **No buffer resize needed** — even at 10 Hz (2000 bytes/s, 500 ms = 1000 bytes) the headroom is 5×.

#### 1.5 Error Recovery at 115200

If baud rate negotiation fails (the L76K doesn't switch, or noise corrupts the config command), the parser sees garbage. Currently there is no baud-rate watchdog. Mitigations to add:

| Strategy | How |
|----------|-----|
| **Config ACK check** | After sending `$PCAS01,1`, wait 200 ms and verify the PCAS response contains `$PCAS01,1` echoed back. If not, retry or fall back to 9600. |
| **NMEA sanity watchdog** | If no valid NMEA sentence parsed in 5 seconds, assume baud mismatch and re-init at 9600. |
| **Single-byte re-init** | The L76K accepts `$PCAS01,0` (9600) at any baud rate if sent blind — a recovery command doesn't need to parse responses. |

These are small firmware additions (~30 lines) and should be implemented as part of B3.

---

### 2. GPS Update Rate — 2 Hz (Phase 1) and 5 Hz (Phase 2)

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

At higher rates the GPS row trigger becomes a modulo check:

| Rate | Trigger | GPS rows/sec | GSR-only rows/sec | Total rows/sec |
|------|---------|-------------|-------------------|----------------|
| 1 Hz | `tick_counter == 0`          | 1 | 9 | 10 |
| 2 Hz | `tick_counter % 5 == 0`      | 2 | 8 | 10 |
| 5 Hz | `tick_counter % 2 == 0`      | 5 | 5 | 10 |
| 10 Hz| always                       | 10 | 0 | 10 |

The total row count stays at 10 rows/s — only the mix of full vs GSR-only rows changes. The analyser's existing `NaN`-skip logic handles any mix transparently.

#### 2.2 Batch Buffer Sizing

The `sd_logger` batch buffer accumulates 10 rows (one second) and flushes on the second boundary. Row sizes:

- GSR-only row: ~45 bytes
- Full GPS+GSR row: ~85 bytes

| Rate | Batch payload | Fits in 512 B? | Fits in 1024 B? |
|------|--------------|----------------|-----------------|
| 1 Hz | 1×85 + 9×45 = 490 B | ✅ | ✅ |
| 2 Hz | 2×85 + 8×45 = 530 B | ❌ (overflow) | ✅ |
| 5 Hz | 5×85 + 5×45 = 650 B | ❌ | ✅ |
| 10 Hz| 10×85 + 0×45 = 850 B | ❌ | ✅ |

**Action:** Bump `gsr_batch` from 512 → 1024 bytes in Phase 1. This covers all rates up to 10 Hz in one change — Phase 2 requires no further buffer work.

#### 2.3 CSV Format — No Schema Change

The CSV header stays identical:
```
timestamp,lat,lon,alt,hdop,vdop,sats,fix,fix_type,speed_kts,course_deg,gsr_raw
```

The only difference is the fraction of rows with filled GPS columns (10% → 20% → 50%). The analyser's existing `hasVelData` detection and `NaN`-skip logic handles this transparently — old 1 Hz CSVs and new multi-rate CSVs parse identically.

#### 2.4 Inter-Sentence Timing Within the Epoch Window

At 2 Hz the L76K has 500 ms to output GGA, GSA, and RMC. At 115200 baud the burst takes ~17 ms — the epoch window is 29× wider than the burst duration. This is so generous that the race between GGA and RMC arrival (discussed below) is even less of a concern than at 1 Hz/9600 baud.

At 5 Hz the window shrinks to 200 ms — but the burst still takes only ~17 ms (8.5% of the window). The existing NaN-guard for `has_vel` already handles the case where RMC hasn't arrived when `get_gps_position()` is called.

**No new race condition at any rate ≤ 5 Hz.** At 10 Hz (100 ms window) the burst consumes 17% of the epoch — still safe but approaching the limit where NMEA output jitter could cause a missed sentence. This is another reason to stop at 5 Hz.

#### 2.5 GSR Temporal Alignment

At 1 Hz: GPS fix is up to 1000 ms old relative to the GSR sample it's paired with. For environmental enrichment, a 1.4 m offset (at walking speed) can place the user in the wrong OSM polygon. At 2 Hz the max age drops to 500 ms (0.7 m offset) — halving the worst-case misclassification rate. At 5 Hz it drops to 200 ms (0.28 m).

The velocity-aided smoother also benefits: dead-reckoning drift per step scales linearly with dt. At 2 Hz, drift is halved; at 5 Hz, it's 5× smaller.

#### 2.6 LED Indicator Behaviour

The blue "GPS not ready" LED blinks on the second boundary based on `get_gps_position()`. The position read is ≤500 ms old at 2 Hz, ≤200 ms at 5 Hz — but the LED only updates once per second. **No behavioural change at any rate.**

#### 2.7 Analyser Performance Impact

The Kalman+RTS smoother is O(n). On a modern browser in pure JS:

| Rate | GPS points/hour | Kalman+RTS time | Perceptible? |
|------|----------------|-----------------|-------------|
| 1 Hz | 3,600           | ~36 ms          | No |
| 2 Hz | 7,200           | ~72 ms          | No |
| 5 Hz | 18,000          | ~180 ms         | Barely |
| 10 Hz| 36,000          | ~360 ms         | Slight pause on load |

The real bottleneck is Leaflet polyline rendering, which already decimates for zoom level. **The analyser handles all rates without modification.**

---

### 3. Implementation Plan for B3

#### Phase 1: Baud rate upgrade + 2 Hz (1–2 days)

**Step 1 — Baud rate upgrade:**
```
gps_uart_configure():
  pcas_tx("$PCAS01,1*xx\r\n")   // switch to 115200 (checksum TBD)
  furi_delay_ms(200)             // let GPS switch
  furi_hal_serial_deinit(...)
  furi_hal_serial_init(..., 115200)  // re-init UART at new rate
  pcas_tx("$PCAS04,7*1E\r\n")   // re-send constellation config
  pcas_tx("$PCAS03,...")         // re-send NMEA filter
  pcas_tx("$PCAS02,500*xx\r\n") // 2 Hz (new checksum)
  pcas_tx("$PCAS06,1,1*07\r\n") // SBAS
```

**Critical:** Baud change must happen BEFORE rate change. If we send `$PCAS02,500` at 9600 baud and then switch to 115200, the GPS outputs at 2 Hz on the old baud — the UART sees framing errors until re-init completes.

**Step 2 — Batch buffer resize:**
```c
// sd_logger.c
char gsr_batch[1024];  // was 512
```

**Step 3 — Session tick logic:**
```c
// In batch_csv_row: change tick_counter == 0 → tick_counter % 5 == 0
// In handle_second_boundary: same pattern for GPS-only mode
```

**Step 4 — Baud error recovery (~30 lines):**
- PCAS config ACK check after `$PCAS01,1`: wait 200 ms, verify PCAS response echoes the command
- 5-second NMEA watchdog: if no valid `$Gx` sentence parsed, attempt re-init at 9600, then re-attempt 115200
- Blind fallback: `$PCAS01,0` (9600) can be sent blind at any time as a recovery command

**Step 5 — No analyser changes needed.**

#### Phase 2: 5 Hz (1 day, after Phase 1 validated on real walks)

```c
// gps_uart_configure():
pcas_tx("$PCAS02,200*xx\r\n") // was 500

// biomap_session.c:
// tick_counter % 5 == 0  →  tick_counter % 2 == 0
```

#### Skip: 10 Hz

Not worth it — diminishing returns, fix quality risk, 100% GPS rows in CSV, and the smoother already handles 200 ms gaps well at 5 Hz.

---

### 4. Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Baud negotiation fails silently | Low | GPS data is garbage; session logs empty rows | NMEA watchdog + config ACK check (Phase 1) |
| Batch buffer overflow at >1 Hz | High (certain at 512 B) | Truncated CSV rows; data loss | Increase buffer to 1024 B (Phase 1, covers all rates) |
| SD card write latency spike | Low | One-second boundary delayed; timer drift | Already handled — batch flush is non-blocking |
| L76K fix quality degrades at 5 Hz | Low–Medium | Slightly noisier positions | Validate at 2 Hz first; only proceed to 5 Hz if 2 Hz is stable on real urban walks |
| L76K fix quality degrades at 10 Hz | Medium | Noisier individual fixes | Skip 10 Hz entirely — not in the plan |
| Analyser becomes slow with 5× data | Low | Perceived UI lag on load | Pipeline is O(n); JS handles 18k points in ~180 ms |
| IRQ storm at 115200 | Very low | CPU starvation | Only 1000 IRQs/s at 5 Hz; STM32WB at 64 MHz has 64k cycles between them |

---

## Recommended Implementation Order

```
Week 1:
  B3 Phase 1  Baud upgrade + 2 Hz rate (1–2 days firmware)
  B1          GSV elevation weighting (3–4 days, firmware + analyser)

Week 2:
  B3 Phase 2  5 Hz rate — only after validating 2 Hz on real urban walks (1 day)

Following sprint:
  C1          HMM-Viterbi map matching (1–2 weeks, analyser-only)

When hardware budget allows:
  C2 → C3     ZED-F9P + PPP-RTK
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
