# GPS Improvement Backlog

Items here are the **Tier 2 and Tier 3** improvements from the GPS research. The **Tier 1 items** (HDOP-adaptive Kalman, velocity-aided smoothing, chi-squared innovation gate, stop averaging, speed/course CSV logging) have already been implemented.

---

## Tier 2 — Moderate Effort, Significant Gain

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

### B2 · Proper RTS (Rauch-Tung-Striebel) Smoother

**What it does**

The current Kalman runs a forward pass and then a separate backward pass. A true **RTS smoother** uses the forward-pass covariance matrices to compute a proper backward gain, giving a provably optimal smoothed estimate for the whole track at once.

```
// RTS backward gain:
Aᵢ = Pᵢ_fwd · Fᵀ · P⁻¹ᵢ₊₁_predicted
// RTS smoothed state:
x̂ᵢ|ₙ = x̂ᵢ_fwd + Aᵢ · (x̂ᵢ₊₁|ₙ − F · x̂ᵢ_fwd)
```

The biggest gain comes when the state vector is extended to include velocity (from the velocity-aided smoother), making the motion model dynamic rather than random walk.

**Changes required**

| File | Change |
|------|--------|
| `gsr-map-analyzer/gps_filter.js` | Refactor `applyKalman` to store forward-pass covariance arrays (`P_fwd[]`). Add true RTS backward gain computation using stored `P_fwd`. Optionally add `vx`, `vy` state dimensions (4-state filter). |

**Effort:** ⭐⭐⭐ | **Expected gain:** 10–20% smoother output; larger when velocity state is included

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
| `modules/gps_uart.c` | Change `$PCAS02,1000` → `$PCAS02,200` (200 ms = 5 Hz). Recalculate NMEA checksum. |
| `biomap_session.c` | Update the 1 Hz GPS-only row write logic to 5 Hz, or update the GSR+GPS tick-0 logic if stride needs adjusting. |

> **Baud rate prerequisite:** At 9600 baud, GGA+RMC+GSA ≈ 200 bytes/epoch × 5 Hz = 1000 bytes/s = ~104% utilisation — will overflow. Switch to `$PCAS01,1` (115200 baud) before enabling 5 Hz.

**Effort:** ⭐⭐ (plus baud rate change) | **Expected gain:** Better temporal alignment; smoother velocity-aided integration

---

### B4 · Confirm and Force SBAS/EGNOS

**What it does**

The L76K/AT6558R supports SBAS (Satellite-Based Augmentation System). In Europe this is EGNOS; in North America it is WAAS. SBAS broadcasts free ionospheric corrections from geostationary satellites, reducing position error from ~3 m to ~1 m in open sky. The PCAS config says SBAS is "automatic" but this has never been explicitly verified.

**Changes required**

| File | Change |
|------|--------|
| `modules/gps_uart.c` | Send `$PCAS08` status query at startup and log the response to check if SBAS is active. If disabled, send `$PCAS06,1,1*...` to force-enable it. Consider logging the GGA `fix_quality == 2` (DGPS/SBAS enhanced) indicator in the CSV. |

**Effort:** ⭐ | **Expected gain:** 1–2 m open-sky improvement at no hardware cost

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

## Recommended Implementation Order

```
This week:
  B4  Confirm SBAS (1 day, firmware only)

Next sprint:
  B3  5 Hz rate after baud upgrade (2 days firmware)
  B1  GSV elevation weighting (3–4 days, firmware + analyser)

Following sprint:
  B2  RTS smoother refactor (2–3 days, analyser only)

Major feature sprint:
  C1  HMM-Viterbi map matching (1–2 weeks, analyser)

When hardware budget allows:
  C2 → C3  ZED-F9P + PPP-RTK
```
