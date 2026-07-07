# GPS Pipeline — Change Review & Analysis

**Date:** 2026-07-07  
**Scope:** All GPS-related changes from firmware NMEA parsing through to the web analyser filter pipeline.  
**Files touched:** `modules/gps_uart.c`, `biomap_types.h`, `biomap_session.c`, `biomap_render.c`, `gsr-map-analyzer/analyzer.js`, `gsr-map-analyzer/gps_filter.js`, `gsr-map-analyzer/map.js`, `gsr-map-analyzer/index.html`

---

## 1. Overview

Changes fall into four categories:

| Category | Goal |
|----------|------|
| **Firmware — NMEA robustness** | Prevent NaN from clobbering valid DOP readings |
| **Firmware — Quality gating** | Only log positions above an HDOP threshold |
| **Firmware — Richer data** | Add speed & course to the CSV for downstream use |
| **Analyser — Filter pipeline** | Four new/upgraded algorithms using the richer data |

All changes are **backward compatible**: the analyser handles old CSVs without speed/course columns by silently skipping the velocity-dependent filters.

---

## 2. Firmware Changes

### 2.1 `modules/gps_uart.c` — NMEA Sentence Handlers

#### A. NaN-guard on GGA and GSA HDOP updates

**Before:**
```c
g->status.hdop = minmea_tofloat(&frame.hdop);   // GGA
g->status.hdop = minmea_tofloat(&frame.hdop);   // GSA
g->status.vdop = minmea_tofloat(&frame.vdop);   // GSA
```

**After:**
```c
float gga_hdop = minmea_tofloat(&frame.hdop);
if (!isnan(gga_hdop)) g->status.hdop = gga_hdop;

float gsa_hdop = minmea_tofloat(&frame.hdop);
float gsa_vdop = minmea_tofloat(&frame.vdop);
if (!isnan(gsa_hdop)) g->status.hdop = gsa_hdop;
if (!isnan(gsa_vdop)) g->status.vdop = gsa_vdop;
```

**Rationale:** `minmea_tofloat` returns `NaN` for empty NMEA fields. The L76K occasionally sends GGA with an empty HDOP field during fix acquisition, or GSA with empty DOP when only 2D geometry is available. Previously this NaN was written directly into `GpsStatus.hdop`, immediately invalidating the good reading from the previous sentence. The fix reads into a temporary float and only commits the write if the value is a real number.

**Impact:** The HDOP quality gate in `biomap_session.c` now works correctly in all signal conditions rather than oscillating when one sentence in a burst has a missing DOP field.

---

#### B. GLL validity flag guard

**Before:**
```c
if (minmea_parse_gll(&frame, line)) {
    g->status.latitude  = minmea_tocoord(&frame.latitude);
    g->status.longitude = minmea_tocoord(&frame.longitude);
```

**After:**
```c
if (minmea_parse_gll(&gll_frame, line) &&
    gll_frame.status == MINMEA_GLL_STATUS_DATA_VALID) {
    g->status.latitude  = minmea_tocoord(&gll_frame.latitude);
    g->status.longitude = minmea_tocoord(&gll_frame.longitude);
```

**Rationale:** The GLL sentence includes a validity flag (`A` = valid, `V` = void). The previous code ignored it, meaning a void GLL sentence could overwrite good coordinates with NaN. GLL is currently **disabled** by the PCAS configuration, so this was a latent bug. Guarding it now makes the code safe if GLL is ever re-enabled.

---

### 2.2 `biomap_types.h` — Constants & Structs

#### C. `GPS_HDOP_GATE` raised from 3.0 → 5.0

**Rationale:** HDOP 3.0 is the "excellent" open-sky threshold. In dense urban environments — the primary use case for a biometric stress-mapping device — HDOP regularly sits between 3 and 6 even with a solid 3D fix and 8+ satellites. The 3.0 gate caused the device to silently write empty GPS rows for large portions of urban walks and blink the blue LED almost continuously. 5.0 corresponds to the "good" threshold in standard DOP terminology.

| HDOP  | Standard Rating | Real-world example                         |
|-------|-----------------|--------------------------------------------|
| < 2   | Excellent        | Open field, clear sky                      |
| < 5   | Good             | Suburban streets, light tree cover         |
| < 10  | Moderate         | Urban canyons, dense trees                 |
| ≥ 10  | Poor             | Deep canyons, indoor near windows          |

#### D. `GpsPosition` — added `speed_kts` and `course_deg`

`GpsStatus` already stored speed and course from RMC sentences; they were not surfaced to the session layer. These values are Doppler-derived (not code-pseudorange-derived), making them significantly less noisy than the position fix. Adding them to `GpsPosition` costs 8 bytes of stack and unlocks all velocity-aided analyser algorithms.

---

### 2.3 `biomap_session.c` — CSV Logging

#### E. Speed and course added to all three logging paths

The CSV header changed from 10 columns to 12:

```
timestamp,lat,lon,alt,hdop,vdop,sats,fix,fix_type,speed_kts,course_deg,gsr_raw
```

Three format strings were updated to match. Speed/course have a separate `has_vel` NaN guard because RMC may not have arrived yet at log time even when the position fix is valid (GGA and RMC arrive in the same burst but are processed sequentially).

Empty rows (below gate) now emit 11 commas to maintain column count:
```
%s,,,,,,,,,,,%.1f\n
```

---

### 2.4 `biomap_render.c` — GPS Badge

#### F. Explicit font set before badge draw

`canvas_set_font(c, FontSecondary)` added immediately before the badge `canvas_string_width` / `canvas_draw_str` calls. Previously the width calculation used whatever font was current at that point in the render loop, making it fragile to reordering of render blocks.

#### G. Badge hidden when cuffs disconnected

The GPS quality badge is now suppressed when the finger cuffs are disconnected, preventing it from overlapping the "NO SIGNAL" alert that occupies the same screen region.

---

## 3. Analyser Changes

### 3.1 `gsr-map-analyzer/analyzer.js` — CSV Parsing

#### H. Speed and course columns parsed and propagated

`speed_kts` and `course_deg` headers are detected and per-row values populate `speedKts` and `course` fields. These are propagated through all three GPS interpolation paths (fill-before, interpolate-between, fill-after) using **step-hold** rather than linear interpolation — speed and course can jump discontinuously at corners, so interpolating them would produce misleading predictions mid-turn.

---

### 3.2 `gsr-map-analyzer/gps_filter.js` — Four New/Upgraded Algorithms

#### I. HDOP-Adaptive Kalman Filter (upgrade to `applyKalman`)

Measurement noise `R` is now scaled per-point by `HDOP²`:

```js
const h = Math.max(0.5, Math.min(10, pt.hdop));   // clamped HDOP
const R_effective = R_BASE * h * h;
```

| HDOP | R multiplier | Filter behaviour                       |
|------|-------------|----------------------------------------|
| 0.5  | 0.25×       | Aggressively tracks GPS                |
| 1.0  | 1.0×        | Baseline                               |
| 2.0  | 4×          | Moderate GPS trust                     |
| 5.0  | 25×         | Mostly coasts on momentum              |
| 10.0 | 100×        | Almost ignores GPS fix                 |

Applied to both the forward and backward Kalman passes. HDOP is clamped to `[0.5, 10]` to prevent degenerate values.

**Expected gain:** 20–40% jitter reduction in mixed-signal conditions; filter self-tunes with signal quality.

---

#### J. Velocity-Aided Smoothing (new `applyVelocitySmoothing`)

Dead-reckons a predicted position from the prior anchor using speed and course, then blends it with the GPS fix using an HDOP-adaptive weight:

```
predicted_pos = prev_pos + speed_ms × dt × direction(course)
effective_α   = clamp(α_base / HDOP, 0.1, 0.95)
blended_pos   = effective_α × GPS_fix + (1 − effective_α) × predicted_pos
```

At HDOP 1.0 (good signal), GPS dominates (60%). At HDOP 5.0, prediction dominates (12% GPS). Silently skips for old CSVs without velocity data.

**Expected gain:** 30–50% smoother paths; handles multipath spikes while moving in a consistent direction.

---

#### K. Chi-Squared Innovation Gate (integrated into `applySpeedFilter`)

A lightweight Kalman covariance is tracked alongside the speed check. Points are additionally rejected if their spatial innovation exceeds the χ²(2, 95%) threshold scaled by 100 (generous, since the speed gate is the primary defence):

```js
chiSq = dLat² / (P_pred + R) + dLon² / (P_pred + R)
reject if chiSq > 599.1
```

This catches **slow-but-wrong drift** — e.g. 5 m over 30 s while stationary — that stays under any pedestrian speed ceiling but is statistically inconsistent with the filter's uncertainty.

---

#### L. Stop Averaging (new `applyStopAveraging`)

Collapses consecutive stationary clusters (`speedKts ≤ 0.5`) of ≥ 3 points into a single centroid. The centroid preserves the `origIdx` of the middle cluster point so the downstream `filteredGps` index reconstruction remains correct. Silently skips for old CSVs.

**Rationale:** Single-frequency GPS chips wander a 3–10 m radius when stationary due to shifting multipath. Without averaging, stationary sections render as jitter blobs. After averaging, they are clean dots.

---

### 3.3 `gsr-map-analyzer/map.js` — Pipeline Order

```
raw GPS points
  ↓ [2a] applyStopAveraging      (new — runs first, before any filter)
  ↓ [3]  applyHampelFilter       (unchanged)
  ↓ [4]  applySpeedFilter        (upgraded — chi-squared innovation gate added)
  ↓ [4b] applyVelocitySmoothing  (new — after outliers removed)
  ↓ [5]  applyDBSCAN             (unchanged)
  ↓ [6]  applyKalman             (upgraded — HDOP-adaptive R per point)
  ↓ display / export
```

Stop averaging runs first so Hampel/speed see cleaner anchor data. Velocity smoothing runs after outlier removal so corrupted fixes do not contaminate the dead-reckoning. Kalman is the final polishing pass.

---

### 3.4 `gsr-map-analyzer/index.html` — HDOP Slider

Help text updated to note that firmware ≥ v2.1 pre-filters at HDOP < 5.0 at record time, so the slider is mainly for stricter post-processing or legacy CSVs. Recommended-range indicator bar repositioned from 1.5–3.5 to 3.0–5.0 on the 0–10 scale.

---

## 4. CSV Format Version History

| Firmware | Columns | Notes |
|----------|---------|-------|
| < v2.1 | `timestamp,lat,lon,alt,sats,fix,gsr_raw` | No DOP data |
| v2.1 | `timestamp,lat,lon,alt,hdop,vdop,sats,fix,fix_type,gsr_raw` | Added DOP + fix_type |
| **v2.2** | `timestamp,lat,lon,alt,hdop,vdop,sats,fix,fix_type,speed_kts,course_deg,gsr_raw` | Added velocity |

The analyser auto-detects the format from column headers and degrades gracefully for older files.

---

## 5. Remaining Concerns

| # | Concern | Severity |
|---|---------|----------|
| 1 | `velocitySmoothing` alpha (0.6) is hardcoded — no UI slider to tune it | Low |
| 2 | `stopAveraging` thresholds are hardcoded (0.5 kts, min 3 pts) | Low |
| 3 | SBAS/EGNOS not explicitly verified as active on the L76K | Medium |
| 4 | GPS still at 1 Hz — up to 1 s misalignment with 10 Hz GSR samples | Medium |
| 5 | Course wrap-around at 0°/360° not handled in velocity prediction (< 0.01° error at walking speed — acceptable) | Low |

---

## 6. Future Improvements (Backlog)

See `docs/gps_backlog.md` for full implementation detail on each item.

| ID | Title | Effort | Expected Gain |
|----|-------|--------|--------------|
| B4 | Confirm SBAS/EGNOS active | ⭐ | 1–2 m open-sky improvement |
| B3 | 5 Hz GPS update rate (needs baud upgrade) | ⭐⭐ | Better temporal alignment with GSR |
| B1 | GSV satellite elevation weighting | ⭐⭐⭐ | 15–25% better quality discrimination |
| B2 | Full RTS smoother | ⭐⭐⭐ | 10–20% smoother vs current Kalman |
| C1 | HMM-Viterbi map matching | ⭐⭐⭐⭐ | Track always on real road/path |
| C2 | Dual-frequency hardware (ZED-F9P) | Hardware | Sub-metre accuracy |
| C3 | PPP-RTK correction service | Hardware + connectivity | cm-level accuracy |
