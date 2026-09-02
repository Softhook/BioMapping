# Dwell-Time Awareness — Implementation Spec

> **Status (2026-09-02) — spec, not yet built.** Grew out of the single-track
> arousal-surface evaluation (see `peak_density_vs_spatial_clustering.md` §2
> note): the surface adds little for one track, so the effort moves to making
> the *existing* single-track layers dwell-aware instead of adding a new one.

## Settled decisions

1. **No new visual layer.** Nothing new is drawn on the map. Dwell information
   only *modulates* what is already there — the peak-cluster blobs. Their style
   vocabulary (amber→red concave blobs) is unchanged; only the intensity input
   is blended.
2. **Cluster intensity is blended**, not replaced — a geometric mean of relative
   amplitude and relative SCR-rate, so a big-amplitude slow stop is pulled down
   but not flattened to nothing.
3. **Arousal figures use the active colouring metric** (`mapManager.activeColoringMetric`
   → `phasic` / `tonic` / `phasicAUC` / `arousalIndex` / …), meaned over the
   relevant sample range.
4. Scope is **single-track view only** for now. Collective clusters keep today's
   pure-amplitude styling.

## Problem

- `applyStopAveraging` (gps_filter.js) centroid-locks a stationary GPS run but
  keeps every sample, so a 4-minute pause becomes a stack of zero-length path
  segments under one dot — invisible.
- `GSRSpatialClustering.clusterPeaks()` only receives `{lat, lon, amplitude}`
  per peak. It cannot tell "6 SCRs while stood at a bus stop for 5 min" (a low
  arousal *rate*) from "6 SCRs walking through a junction in 20 s" (a genuine
  hot spot). Both render as the same blob.

The fix is to bring **time spent in a place** into the cluster styling.

---

## 1. `DwellDetector` — new module (`src/spatial/dwell_detector.js`)

Pure functions, no DOM, no Leaflet — unit-testable in isolation.

### `presenceTime(samples, lat, lon, radiusM) → seconds`  *(the one we build now)*

`Σ Δt` over consecutive `samples` that lie within `radiusM` of `(lat, lon)`.
`Δt` is the gap to the next sample, clamped to a sane max (e.g. 2 s) so a single
gap across a data hole can't dominate.

```
samples: [{ time, lat, lon }]   // ascending time
returns: total seconds the path spent inside the disc
```

**Sample source:** built from `analyzer.filteredGps[i]` (post-GPS-filter, one
entry per raw row) + `analyzer.raw[i].time`, strided to `DWELL.detectHz` (2 Hz —
dwells are ≥ tens of seconds, 2 Hz is ample and keeps the scan cheap).
**Not** `drawPoints` — RDP simplification collapses a stationary run to its two
endpoints and destroys the duration signal.

Cache the strided sample array per `(trackId, gpsParamsKey)` next to the
existing draw-point cache in map.js, so it rebuilds only when GPS sliders move.

### `detect(samples, params) → Dwell[]`  *(documented, NOT built now)*

Reserved for a later "timeline dwell bands / mostly-stationary hint" pass.
Single linear sweep: fixed per-run anchor, a candidate joins if within
`radiusM` of the anchor, `graceSec` of continuous excursion ends the run, emit
if `durationSec ≥ minSec`. Dwell = `{ startTime, endTime, durationSec, lat, lon,
startIndex, endIndex, spreadM }`. Left in the module as commented spec + tests
only when that pass is scheduled.

### Constants — new `GSR_CONST.DWELL`

```js
DWELL: {
  presenceRadiusM: 25,   // footprint disc for cluster presence-time
  detectHz: 2,           // sample stride for the scan
  maxGapS: 2,            // Δt clamp across data holes
  // detect() only — unused until the timeline pass:
  radiusM: 15,
  minSec: 25,
  graceSec: 5,
}
```

---

## 2. Dwell-aware peak clusters (single-track)

### Where

`GSRMapManager._renderPeakMarkers()` — the block that builds `ptsForClustering`,
calls `GSRSpatialClustering.clusterPeaks()`, then `_renderClusters()`.
(`renderCollectiveData()`'s cluster block is left as-is.)

### New per-cluster figures

For each cluster returned by `clusterPeaks()`:

| figure | how |
|---|---|
| `centroid` | mean lat/lon of the cluster's peak points |
| `presenceSec` | `DwellDetector.presenceTime(samples, centroid.lat, centroid.lon, DWELL.presenceRadiusM)` |
| `scrRate` | `cluster.length / (presenceSec / 60)` — SCRs per minute present. `presenceSec` floored at one `detectHz` step so a cluster with no nearby samples doesn't divide by zero (falls back to `scrRate = null`). |
| `meanMetric` | mean of the **active colouring metric** series over the cluster's peak raw-indices (`analyzer[seriesKey][pk.index].val`) |

`refRate` = mean of the non-null `scrRate` values across all clusters this
render (same role `refAmplitude` already plays for amplitude).

### Blended intensity

`_severityStyleForCluster(cluster, refAmplitude)` currently derives its `ratio`
(0..1, drives hue/sat/light/opacity/weight) from `maxAmp / refAmplitude` alone.
Extend it to `_severityStyleForCluster(cluster, refAmplitude, clusterStats)`
where `clusterStats = { scrRate, refRate, presenceSec, meanMetric, metricLabel, metricUnit }`:

```
relAmp  = maxAmp / refAmplitude                       // as today
relRate = (refRate && scrRate != null)
            ? scrRate / refRate
            : 1                                        // neutral when unknown
relBlend = Math.sqrt(clamp(relAmp, 0.1, 10) * clamp(relRate, 0.1, 10))
ratio    = clamp((relBlend - 0.3) / (3 - 0.3), 0, 1)  // same 0.3x–3x → 0..1 band
```

Geometric mean: a slow high-amplitude stop (`relAmp 2.0`, `relRate 0.3`) →
`relBlend 0.77` → still a visible mid blob, not zeroed. A fast burst
(`relAmp 1.2`, `relRate 3`) → `relBlend 1.9` → hot. When rate is unknown
(no GPS, collective) `relRate = 1` and behaviour is identical to today.

### Tooltip

Append to the existing `"{n} peaks · {relMax}x avg severity"`:

```
 · 6 SCRs in 42 s (8.6/min) · mean phasic 0.42 μS here
```

`presenceSec` formatted `mm:ss` when ≥ 60 s. The rate/mean clause is omitted
when `scrRate` is null.

### Toggle

New checkbox **"Dwell-normalise clusters"** in the GPS-filtering card near
`clusterProximity` / `clusterBoundaryRadius`, `AppState.sliders.dwellNormaliseClusters`,
**default checked**. When unchecked, `_renderPeakMarkers` passes
`clusterStats = null` and `_severityStyleForCluster` runs exactly as today.
Change fires `GSRUI.rerenderMap()` (single) — no re-analysis needed.

---

## Explicitly cut / deferred

- **Standalone dwell markers** on the map — *cut*. (User: "I don't want the
  markers to look any different, just be dwell aware.")
- **Cell-pooled path colour** (bin the path to ~12 m cells, pool the active
  metric per cell so a revisited street shows the combined reading instead of
  last-pass-wins) — *deferred*, separate task.
- `DwellDetector.detect()` and timeline dwell bands — *deferred*.
- Collective-view dwell-normalisation, 3D-globe anything, toggle persistence.

---

## Edge cases

- **No GPS / `filteredGps` empty** → `samples` empty → `presenceTime` returns 0
  → `scrRate` null → clusters style on amplitude alone (today's behaviour).
- **Old CSV, no speed column** → irrelevant; detection is position + time only.
- **Cluster centroid far from any sample** (latency-shifted peaks, snap drift)
  → `presenceSec` below the floor → `scrRate` null → amplitude-only styling for
  that cluster.
- **Whole track is one stop** (recorder left running) → every cluster gets a
  huge `presenceSec` → uniformly low rates → blobs settle toward mild. Correct.
- **Peak latency** shifts peak *marker* positions; presence-time is measured
  against the **path**, and `meanMetric` against **raw indices**, so neither is
  affected by the latency slider.

## Testing

`test_dwell_detector.js` (new):
- `presenceTime`: straight 3 m/s walk through a disc → ≈ `2·radius/speed`;
  60 s stationary inside → ≈ 60 s; point outside every sample → 0; data hole
  mid-disc → gap clamped to `maxGapS`.
- stride/argument validation, empty input.

`test_spatial_clustering.js` / a map test:
- `_severityStyleForCluster` with `clusterStats` null → byte-identical style to
  the current one-arg call (regression guard).
- high `scrRate` vs `refRate` pushes `ratio` up; low pushes down; `relRate = 1`
  when `refRate` null leaves `ratio` unchanged.
- geometric-mean floor: `relAmp 2.0 / relRate 0.3` still yields a visible
  (`ratio > 0.15`) blob.

Map-wiring: toggle off ⇒ `clusterStats` null path; toggle fires `rerenderMap`.

## Size

`dwell_detector.js` ≈ 50 LOC + ≈ 110 test. map.js cluster figures + blend +
tooltip ≈ 70 LOC. constants + checkbox + events ≈ 25 LOC. Total ≈ 150 LOC +
≈ 130 test. One focused change.
