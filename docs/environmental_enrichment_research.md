# Environmental Enrichment — Design Rationale & Roadmap

Bridges the two reference documents:

- [`environmental_enrichment_plan.md`](environmental_enrichment_plan.md) — **what the code does now.**
- [`environmental_stress_literature_review.md`](environmental_stress_literature_review.md) — **the field:** the full scholarly survey, every environmental dimension (including ones not built — aircraft noise, air quality, crowding, blue space), the external-database catalogue, the psychophysiological-metrics methodology, and the bibliography.

This document holds only what is specific to *these implementation choices* and the
near-term roadmap. For any background claim it cites the review by section rather
than restating it.

Scope note: this system produces **single-subject, observational, ambulatory**
data. Nothing here is a controlled comparison.

---

## 1. Physiological timing, as coded

Background: review §5 (NS-SCR frequency, ISCR/Phasic AUC, Combined Arousal
Index) and §8.2.B.3 (latency compensation).

- **`gpsPeakLatency` slider, default 2.0 s** — an SCR's onset latency after its
  trigger is ~1–3 s (review §8.2.B.3), and the subject has walked on in that
  time, so the environment that *caused* a phasic spike is the one ~2 s upstream.
  The slider spans 0–5 s because gait speed and individual differences move it.
- **Phasic window is short** (trailing ~1 s, max) — the Bateman SCR model used by
  the decomposition (review §5.B: τ₁ ≈ 0.7 s rise, τ₂ ≈ 2.0 s recovery) means an
  SCR is essentially over within a few seconds.
- **Tonic reads a longer lag:** `tonicLatency = min(30 s, latency × 4)`. SCL is
  not event-locked and drifts over tens of seconds with sustained tone,
  thermoregulation and hydration (review §2.3, §5.C). **The ×4 multiplier is an
  engineering guess** — there is no clean literature value for "how far back does
  SCL track its spatial driver on a walk." Bounded at 30 s; a knob to revisit,
  not a result.

Each `allData` row therefore carries two environment snapshots — the phasic one
at `latency`, the tonic one at `tonicLatency` (`tonicEnv`).

---

## 2. Why the green dimension is four channels

Background: review §2.2 (green + micro-greenery), §4.A/§4.B/§4.C (NDVI, LiDAR,
GVI), §7.B/§7.C (NDVI-vs-GVI correlation, 20-minute dose). The load-bearing
findings there: top-down and eye-level greenness correlate only weakly
(r ≈ −0.02 to 0.50), eye-level GVI tracks physiological restoration better than
planimetric NDVI, and forest-type exposure outperforms manicured parks.

That is the rationale for splitting "green" into four weakly-correlated `osm_*`
channels rather than trusting one number:

| Channel | Question | Notes |
|---|---|---|
| `osm_in_park` | Am I *inside* a green space? | ray-cast point-in-polygon |
| `osm_green_pct_50m` | How much green *area* around me? | 25-point sampling grid |
| `osm_dist_green` | How near / visible is the nearest green space? | 0 inside, nearest-boundary distance (incl. inner hole-ring) outside, `999` sentinel, ~220 m grid reach. Emitted as a raw metre value — no threshold baked in — so the analysis can fit whatever decay the data supports; the greenspace–health literature clusters buffers ≤ 300 m (≈ 5-min walk, EU access definition) but recommends reporting across several. `in_park` is its 0/1 case. |
| `osm_canopy_pct_50m` | Am I *among trees*, regardless of green-space polygons? | 25-point grid inside `natural=wood`/`landuse=forest`, OR within `CANOPY_BUFFER_M` (10 m) of a `natural=tree_row` way / `natural=tree` node. Decoupled from `green_pct` (grass park: green 100 / canopy 0). Replaces the old `natural=tree` node tally, which missed woods and avenues entirely. Still OSM-completeness-limited — an unmapped avenue reads 0; the real fix is an NDVI raster (§4.3) or a GVI pipeline (§4.4). |

Effect-size expectation: the meta-analytic green→arousal effect is **small**
(review §2.2), which is why the correlation table's bands top out at |r| ≈ .30 =
"strong" (Gignac & Szodorai 2016) rather than textbook .50 thresholds — a small
association here is the expected magnitude, not a weak result.

---

## 3. Confounds that bite this pipeline

The full catalogue is review §2.3. What matters for the enrichment metrics:

- **Thermal** — parks are shaded/cooler; thermoregulatory and emotional sweating
  are hard to separate, and both raise conductance. A "green → lower tonic SCL"
  reading is partly a temperature effect. The finger site is comparatively
  emotion-weighted, which helps but does not remove it. *Fix:* ingest an
  ambient-temperature column as a covariate if any logger provides one; otherwise
  state it on the green rows, not just in help text.
- **Exertion / walking speed** — faster walking raises EDA arousal; sweat pools
  at the electrode when movement drops, so *stopping* in a park can look like
  rising baseline. People walk slower and stop more in parks, so this covaries
  with green space *and* with the thermal effect. *Fix:* §4.1 below.
- **Self-selection** — the subject chose to enter the park, often to relax.
  Unbreakable with single-subject data; a reason the framing is descriptive
  ("arousal tended to be lower here"), not causal.

---

## 4. Roadmap (priority order)

### 4.1 Walking-speed / exertion covariate — SHIPPED (2026-09)

Cheapest partial de-confound (§3), using `raw[i].speedKts` (knots → m/s) / the GPS
pipeline's derived speed. Implemented:

1. Windowed `speed` (m/s) carried onto each `allData` row and its `tonicEnv`.
2. `StatsMath.partialCorrelation(x, y, z)` — residualises x and y on speed z by OLS,
   correlates the residuals with multi-lag Bartlett/Pyper–Peterman autocorrelation
   correction.
3. In the correlation matrix, the Tonic channel renders both raw `r` and the
   speed-adjusted partial correlation (`spd-adj`), highlighting when the effect-size
   band changes and updating the natural-language interpretation.
4. In collective mode, partial correlations are meta-analysed across walks.
5. `speed` registered in `#scatterEnvMetric` as an X-axis predictor.

### 4.2 Acoustic / traffic tags already fetched

Review §3 (OSM tag table) and §8.2.A: `maxspeed`, `lanes`, `surface`,
`traffic_signals` sit on the highway ways this tool already fetches and are not
extracted. A 2025 VR study (review ref: *Building and Environment* 2025) found
speed limit and road-surface type independently modulate pedestrian SCR. Sketch:
in `_evaluatePosition`, when a way sets the road class, also read `maxspeed`
(parse "30 mph"/"50" → km/h) and `lanes`; project like the other
categorical/discrete fields; register `roadMaxspeed`, `roadLanes` in
`OSM_METRICS`. No new network data; gives the Roads Profile a within-class
gradient.

### 4.3 NDVI — column *and* visible map layer

Background and the full external-data survey: review §4.A. NDVI complements the
OSM channels (it misses eye-level greenness — review §4.C, §7.B) so report all of
them; it does not replace `green_pct`/`canopy_pct`.

**As an analysis column** (`ndvi`, optionally `ndvi_300m`): one-time per region,
obtain a summer Sentinel-2 NDVI composite (10 m) or ESA WorldCover / a LiDAR CHM,
clipped to the region; a `scratch/ndvi_sample.js` (Node + a GeoTIFF reader)
samples it at each track's evaluation points and writes the column;
`headers.indexOf('ndvi')` detection + one `OSM_METRICS` entry lights it up
everywhere. Handle the raster CRS in the sampler.

**As a visible map layer — decision: Option A, a single pre-rendered
`L.imageOverlay` PNG.** The map is Leaflet; it already has
`this.baseTileLayer = L.tileLayer(cartoUrl…)` and the `osmLayers` +
toggle-button pattern in `map_manager_osm.js`.

1. Offline `scratch/` step: `gdalwarp` clip the NDVI GeoTIFF → `gdaldem
   color-relief` with a green ramp (transparent where nodata/water) → downsample
   to a ~2000–4000 px PNG (~5 m/px covers a city) → sidecar
   `ndvi_<region>.json` with `[[south,west],[north,east]]`.
2. Ship `visualiser/assets/ndvi_<region>.png` + json.
3. Mixin beside `drawOsmShapes`: `showNdviLayer()` →
   `this.ndviLayer = L.imageOverlay(url, bounds, { opacity: 0.55, interactive: false, pane: 'overlayPane' }).addTo(this.map)`;
   `hideNdviLayer()` removes it. Toggle + opacity slider next to "OSM Layers".
   ~40 lines, **no new runtime dependency**, keeps the client-side/no-server
   property, composes with the track recolour and OSM polygons.
4. *Later, only if wanted:* ship the clipped single-band GeoTIFF and render it
   client-side into an `overlayPane` canvas (same mechanism as
   `rf_fluid_renderer.js`) — buys live opacity/ramp/threshold controls **and**
   lets the same in-memory raster feed the `ndvi` column. ~150–250 lines + a
   GeoTIFF-reader dependency + reprojection maths; a separate step.
   *Not recommended:* `L.tileLayer.wms(...)` against Sentinel Hub / NASA GIBS —
   needs a key/instance + network, breaks the no-server property.

### 4.4 Green View Index from street imagery

Review §4.C. The measure the mental-health literature most consistently backs and
the truest match to "visual perception of green" (the framing behind `dist_green`
and `canopy_pct`). Batch-sample Mapillary / Street View at the evaluation points;
green-pixel-fraction classifier (HSV/ExG threshold to start, semantic
segmentation is the modern standard). CORS/canvas-tainting forces a small
serverless function or an offline batch step that writes a `gvi` column — same
plumbing as NDVI. Sequence after NDVI.

### 4.5 Ambient-temperature covariate

If any logger provides it (§3, review §2.3, §4.E) — the physically-grounded way
to subtract heat-driven tonic drift. Otherwise the caption in §3 stands.

---

## 5. One statistical note specific to this dashboard

The autocorrelation machinery (review §7.A: serial autocorrelation along a route
violates i.i.d., inflates Type-I; effective-N is the standard remedy) has a
direct consequence worth stating here: on a **single walk**, a slow spatial
gradient crossed with slow arousal drift collapses the Pyper–Peterman effective N
from ~1,200 rows to ~10–30, so even a moderate `r` reads non-significant. This is
correct, and it is why the single-walk view is exploratory (effect size only) and
inference lives in **collective mode**, where the walk is the unit and a
random-effects meta-analysis across walks is the honest test (the mixed-effects
direction review §7.D recommends). EM Fog is the cautionary case: its
near-white-noise autocorrelation structure *dodges* the effective-N
down-weighting, so it can clear significance while every genuinely spatial factor
does not — a statistical artefact, not a stronger effect.
