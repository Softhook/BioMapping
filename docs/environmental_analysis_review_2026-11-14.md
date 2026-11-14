# Environmental analysis review — 2026-11-14

A review of everything in the visualiser that links arousal to the
environment: the dashboard numbers, the map data they are built from
(OpenStreetMap and NDVI greenness), and the screens that show them.

This file is filled in as the review goes. Each finding says what is wrong,
why it matters, and whether it has been fixed.

Status words used below:

- **Fixed** — changed in code, with a test.
- **Checked, fine** — looked wrong at first, turned out to be correct.
- **Open** — real, but needs a decision from you before changing.

## What has been read

| Area | File | State |
| --- | --- | --- |
| Dashboard maths | `visualiser/src/spatial/environmental_stats.mjs` | read |
| Shared statistics | `visualiser/src/signal/stats_math.mjs` | read |
| Dashboard wiring and cache | `visualiser/src/ui/ui_environmental_dashboard.mjs` | read |
| Correlation table and scatter plot | `visualiser/src/ui/ui_correlation_table.mjs` | read |
| Road profile table | `visualiser/src/ui/ui_road_profile.mjs` | read |
| Junction turns maths | `visualiser/src/gps/junction_response.mjs` | read |
| OSM enrichment | `visualiser/src/osm/osm_enrichment.mjs`, `overpass_client.mjs` | read |
| OSM cache | `visualiser/src/osm/osm_cache.mjs` | lookup logic read |
| NDVI greenness | `visualiser/src/osm/ndvi_sampler.mjs` | read |
| Enrichment buttons and status | `visualiser/src/ui/ui_enrichment.mjs`, `events_enrichment.mjs` | read |
| Junction table drawing, road-snap matcher, TIFF decoder | — | not reviewed in this pass |

## Result

The seven findings below and the follow-up fixes for A, B and C are in the
working copy. D remains open. Nothing is committed.

The initial review recorded these checks before the follow-up changes:

| Check | Before | Initial review |
| --- | --- | --- |
| Automated tests | 1882 pass, 0 fail | 1896 pass, 0 fail |
| Lint and dependency rules | clean | clean |
| Whole-app check in real Chrome (`npm run smoke`) | — | 22 of 22 steps pass, including all four dashboard tabs |

The initial review added 14 tests and rewrote one. Run against the old code,
12 of those 15 fail, which shows they catch the faults rather than just
passing. The other three are guards that the fixes leave working cases
alone (an already-closed outline, a point outside a park, a walk with no
speed readings at all), so they pass on both.

To see the fixes on walks you have already enriched, press "Retrieve
Spatial Data" again and re-run NDVI if you use it. The wider distance
coverage can require a new OpenStreetMap download if cached data is too small.

The real-data checks below used the 80 or so recordings in `tracks/`
(52,132 one-second samples in total).

## Findings

### 1. Missing walking speed is counted as "standing still" — Fixed

**What happens.** When the GPS gives no speed reading for a second, the
dashboard stores the speed as 0 m/s. The file format says a blank speed
means "not available", not "not moving".

**How big.** In the recordings in `tracks/`, 12,490 of 52,132 samples
(24%) have no speed reading. In 37 walks these fake zeros sit mixed in with
real speeds.

**Why it matters.**

- The scatter plot with "Walking Speed" on the bottom axis shows a false
  column of points at zero.
- The "spd-adj" figure under each baseline (tonic) correlation removes the
  effect of walking speed. It was removing the effect of a speed signal
  that is a quarter invented.

**Fix.** A second with no speed reading now has no speed (blank), and is
left out of the speed plot and the speed adjustment. The adjusted figure
uses only walks with usable speed readings and is compared with the
unadjusted figure for those same readings.

Code: `environmental_stats.mjs` (`buildSamples`, `_speedSeries`). Tests:
`test_environmental_stats.js`.

### 2. Large parks, woods and lakes are read wrongly — Fixed

**What happens.** OpenStreetMap often draws a big park as several outline
pieces that join end to end. The code treated every piece as if it were a
complete shape on its own. A piece that is just one side of the park
encloses nothing, or encloses the wrong sliver.

**Why it matters.** For those parks, "In Park", "Green Space %", "Tree
Canopy %" and "Distance to Green" are wrong: usually the park is missed
altogether, sometimes a wedge outside it counts as park. The green shapes
drawn on the map have the same fault. Small parks drawn as one closed
outline were always fine.

**Fix.** Outline pieces are now joined into complete rings before any
"am I inside?" test. Applies to cached map data too, so there is nothing to
re-download for the ring fix itself; press "Retrieve Spatial Data" again to
re-score. Incomplete chains are not treated as filled areas.

Code: `osm_enrichment.mjs` (`_assembleRings`). Tests:
`test_osm_multipolygon_rings.js` (4 of its 6 tests fail on the old code).

### 3. A walk with only NDVI shows up as a "none" road — Fixed

**What happens.** Fetching NDVI marks a walk as "enriched", the same flag
OpenStreetMap enrichment sets. The road profile then lists the whole of
that walk under a road type called "none", as if the map had said "no road
nearby". Checked on real recordings: a walk with no road data gives one
row, "none: 1130 s".

**Why it matters.** In a collection where some walks have road data and
some only have NDVI, the "none" row is inflated by every second of the
NDVI-only walks. The note above the table also calls these walks
"OSM-enriched".

**Fix.** Seconds with no road data are left out of the road profile.
"none" now only means the map was checked and found no road nearby. The
note wording no longer claims OSM.

Code: `environmental_stats.mjs` (`_roadGroups`, `roadProfile`),
`ui_correlation_table.mjs`. Tests: `test_environmental_stats.js`.

### 4. A failed satellite download is reported as success — Fixed

**What happens.** NDVI comes down as map tiles. If a tile fails after its
retries, the code carries on without it and says nothing. If every tile
fails (for example, no network), the status still reads "Sampled NDVI for
1/1 walks" and the walk is marked as enriched with no readings at all.

**Why it matters.** You cannot tell a complete result from a partial or
empty one.

**Fix.** If no usable readings are obtained for a walk, it is reported as
failed and its previous readings are kept. This also applies when walks share
a mosaic and another walk has usable tiles. If some tiles fail, the status
line says how many. Missing pixels stay blank rather than being filled from
an earlier position.

Code: `ndvi_sampler.mjs` (`_requireSomeTiles`), `ui_enrichment.mjs`. Tests:
`test_ndvi_sampler.js`.

### 5. Road profile says "this is one walk" with many walks loaded — Fixed

The sentence under the road table ends "though this is one walk in one set
of places" even in Collective view. Wording only. Now matches the number of
walks.

### 6. Junction windows include stretches where the sensor was off — Fixed

The correlation table leaves out seconds where the finger sensor was
disconnected, because the reading there is not real. The junction
turn-versus-straight comparison did not: it averaged those stretches in.
Now a junction window that touches a disconnected stretch is dropped, the
same rule the rest of the dashboard uses.

Code: `ui_environmental_dashboard.mjs`. Test: `test_environmental_scope.js`.

### 7. NDVI is read half a pixel off — Fixed

The satellite pixel under each position was picked by rounding to the
nearest pixel number rather than finding which pixel the position falls
in. That shifts every reading by half a pixel (about 1.5 m at the normal
zoom, up to 12 m when a very large walk forces a coarser zoom). Small, but
simply wrong. Now reads the pixel the position is in.

Code: `ndvi_sampler.mjs`. Test: `test_ndvi_sampler.js`.

## Checked, fine

- **Seconds in the road profile.** The table shows a sample count as
  seconds. Samples are exactly 1.00 s apart on every real recording
  checked, so the count is seconds.
- **Baseline (tonic) average.** Every row has a tonic value (no length
  mismatch in any recording), so the average is not pulled down.
- **Peaks inside sensor-off stretches.** Only 11 of 9,147 peaks sit in
  one. Too few to move the peak rates.
- **Part-filled 15-second slots for the peak count.** Only the last slot
  of each walk is short. One slot in about eighty; no effect worth
  changing.
- **Significance maths** (effective sample size, meta-analysis across
  walks, false-discovery correction, t-test p-values). Re-read line by
  line; matches the cited methods and the earlier validation.
- **Dashboard cache.** It refreshes when walks, peaks, enrichment, GPS
  settings or the Response delay change. NDVI sampling also triggers a
  refresh.
- **OSM cache.** Only reuses stored data that fully covers the area asked
  for and matches the current query version.

## Follow-up and open items

### A. "Distance to …" stops being measured at an uneven range — Fixed

Distance to a major road, to water and to green space only see features
the lookup grid happens to hand over. That reach is not a clean circle: at
UK latitudes a feature is always found within about 140 m, sometimes found
out to about 330 m, depending on direction and on where you stand in a
grid square. Beyond that the value becomes "none nearby" and the sample is
dropped. So distances between 140 m and 330 m are kept for some seconds
and dropped for others.

Distances are now capped at 150 m. The fetch area allows for the snap radius
plus 50 m padding, and major-road distance is checked against the kerb
rather than discarding a road solely because its centre is past 150 m.

### B. NDVI gaps are filled with the last good reading — Fixed

Where a satellite pixel has no value (cloud, or a tile that failed), the
code copies the previous good reading forward, however far. After a failed
tile that can be several hundred metres of one repeated value. The file's
own comments disagree on whether this fill is meant for no-data pixels or
only for rows without a position.

Missing pixels remain blank, so they drop out of NDVI correlations. A
reading is still held over rows with no position, but a missing pixel ends
that hold until a fresh reading is obtained.

### C. Paired junction test mixes walks with different baselines — Fixed

When the same junction is turned at in one walk and passed straight in
another, the paired test compared raw arousal values, so the gap between
the two walks' general levels could produce a false result. The paired test
now compares turns and straights at the same junction within the same walk.
When fewer than 15 junctions have such pairs, it uses the existing
walk-adjusted pooled test instead. Passages in a walk can still be correlated,
so results remain indicative rather than causal.

### D. Distance to water while on a bridge

Standing inside a water shape (crossing a wide river on a bridge) gives the
distance to the bank, not 0. Rivers usually also have a centre line that
gives a near-zero value, so this is small.
