# Environmental Enrichment & Analysis — Implementation Reference

This document describes the environmental-enrichment system as it is actually implemented in the Bio Mapping GSR map visualiser (`visualiser/`), and lists concrete suggestions for extending it. It replaces an earlier forward-looking plan; that plan's Phase 1 (native OSM integration) shipped, was extended with a GPS road-snapping system that was never in the original plan. Phase 2 (satellite NDVI) shipped 2026-09-04 as a live raster sampler against a custom Sentinel Hub evalscript layer, rather than the plan's offline-raster script — see §2E for what actually got built (including a same-day correction: the first cut decoded NDVI from a rendered colour image via heuristics before being rebuilt to decode the real float raster instead). Phase 3 (automated Street View greenery index) was not built.

---

## 1. Conceptual Overview & Scientific Rationale

Skin conductance (GSR/EDA) measures sympathetic nervous system activation, reflecting physiological arousal and stress. When people navigate urban spaces, their arousal levels fluctuate in response to environmental conditions. Pairing physiological data with spatial location lets us identify environmental drivers of stress and restoration.

```
[Urban Stressors]     --> [Sympathetic Spike]    --> GSR Peak / SCL Rise (after ~1.5–3.0s latency)
[Restorative Zones]   --> [Sympathetic Decay]    --> GSR Recovery / SCL Decline
```

The implemented system captures five environmental dimensions, each backed by an OpenStreetMap tag set (see `visualiser/src/osm/osm_enrichment.js`):

1. **Traffic & Acoustic Stress** — road classification and distance to the nearest major road.
2. **Visual & Natural Restoration (Green Spaces)** — park containment (`in_park`), green-space density (`green_pct`), **distance to the nearest green space (`dist_green`) as a visual-perception proxy — a park you can see from across the street is part of the environment even if you're not standing in it — and tree-canopy coverage (`canopy_pct`) for "am I among trees", the other half of perceived green** — all from `leisure` (`park`/`garden`/`nature_reserve` — **not** `playground`, which is rubber surfacing and steel, not vegetated nature), `landuse` (`grass`/`forest`/`meadow`/`recreation_ground`/`village_green`/`orchard`), and `natural` (`wood`/`scrub`/`grassland`/`heath`/`wetland`) tags.
3. **Blue Spaces (Water Bodies)** — distance to the nearest water feature (`natural=water|wetland`, `waterway`, `landuse` water tags). **`natural=wetland` counts as both blue and green** — it feeds `dist_water` *and* `green_pct` / `in_park` (a wetland geom matches both `OSMEnricher.isWaterSpace` and `isGreenSpace`, and the two metric branches run independently).
4. **Built Complexity (Enclosure)** — building density from `building` ways/relations.
5. **Social & Pedestrian Activity** — count of nearby amenities (cafes, shops, transit, schools, etc.) from `amenity`/`shop` tags.

The Environmental Analysis dashboard also correlates a sixth factor when the recording carries it: the **EM Fog Index** (0–100), an RMS of the seven Sub-GHz RSSI bands (`GSRAnalyzer.calcEmFog`). This is not OSM-derived and has no physical unit — it is a rough "radio-frequency busyness" proxy — but it is latency-shifted and treated like the OSM factors in the correlation table and scatter.

---

## 2. What's Implemented

### A. OSM enrichment (shipped, matches the original Phase 1 goal)

Fetches structural environmental data from the public Overpass API entirely client-side — no API keys, no server, no preprocessing. Implemented in `osm_enrichment.js` (~895 lines) with the network layer split out into `overpass_client.js`.

Per-point outputs, appended as new columns on the analyzed track. The `_50m`
suffix is **nominal** — the four `_50m` columns use whatever the search-radius
slider was set to at enrichment time (25–200 m); the actual value is recorded in
the exported CSV's `# EnrichmentRadius:` header and mirrored back onto the radius
slider on load. The dashboard does **not** yet warn when active tracks in
collective mode were enriched at different radii (open item).

| Column | Meaning |
|---|---|
| `osm_road_class` | The road/path `highway` tag for where you are. Prefers the nearest **motor-traffic carriageway** (`VEHICULAR_ROAD_CLASSES`) when one is close — within the search radius *and* ≤ 25 m — so a footway a few metres off doesn't mask a residential/primary road just beyond it; otherwise the nearest way of any kind (`footway`, `path`, …). Non-road `highway=*` values — point features (`bus_stop`, `traffic_signals`, `crossing`, street furniture, junction markers) and lifecycle tags (`construction`, `proposed`, `razed`, …), plus `platform` — are in `NON_ROAD_HIGHWAY` and never become the class label or a Roads Profile row |
| `osm_dist_major_road` | Distance in metres to the nearest major road (`motorway`/`trunk`/`primary`/`secondary`) **anywhere in the fetched geometry that reaches the query cell** (the spatial-hash grid reach, ≈ 2 cells ≈ 220 m — *not* the 25–200 m search-radius slider); `999` = none that close |
| `osm_in_park` | 1 if the point falls inside a park/green polygon, else 0 |
| `osm_green_pct_50m` | Fraction of the 25 concentric sample points (out to the full search radius) that fall in green space |
| `osm_canopy_pct_50m` | Fraction of the 25 sample points that are **under tree canopy** — inside a `natural=wood` / `landuse=forest` polygon, or within ~10 m of a `natural=tree_row` way or `natural=tree` node. The "am I among trees" channel, decoupled from `green_pct`: a mown-grass park has `green_pct` high and `canopy_pct` ≈ 0; a tree-lined street with no green polygon has `canopy_pct` > 0 and `green_pct` = 0. Far more robust than `osm_tree_density_50m` (a raw count of individually-mapped tree nodes, which misses woods and avenues entirely) |
| `osm_dist_green` | Distance in metres to the nearest green space — **0** when standing inside one, otherwise the distance to its nearest boundary (outer ring, or an inner-ring hole edge). Within grid reach (see `osm_dist_major_road`); `999` = none that close. This is the *visual-perception* channel: a park across the street is part of the view even when the GPS point is not inside its polygon. `osm_in_park` is the 0/1 special case (`in_park = 1 ⟺ dist_green = 0`) |
| `osm_building_density_50m` | Count of buildings — `way["building"]` **and** `relation["building"]` multipolygons — with any footprint **edge** within the search radius (nearest-edge distance, so a large block whose wall is close but whose centroid is far still counts, and multipolygon footprints are no longer skipped) |
| `osm_dist_water` | Distance in metres to the nearest water feature within grid reach (see `osm_dist_major_road`); `999` = none that close |
| `osm_tree_density_50m` | Count of `natural=tree` nodes within radius |
| `osm_amenity_count_50m` | Count of amenity/shop/bus-stop features within radius |

### B. GPS road-snapping / map-matching (shipped, not in the original plan)

`osm_enrichment.js` and `map_match.js` together implement an HMM/Viterbi-style map matcher (`MapMatcher.match()`) that snaps noisy GPS points onto OSM road/path geometry before enrichment. This corrects multipath drift in urban canyons and under tree canopy — a real accuracy problem the original plan didn't anticipate. It scores emission probability (distance to candidate ways) and transition probability (route distance between candidate ways at consecutive fixes, with a junction-aware routing step); path smoothness comes from the global Viterbi optimisation rather than a hysteresis state machine, and the raw and snapped positions are blended with a distance-based alpha. `GSR_CONST.SNAP` keeps only `HEADING_W` (heading-penalty weight) and `SPEED_GATE` (below this speed the course is unreliable, so the heading penalty is skipped); the match radius comes from the "Snap to Roads & Trails" toggle and radius slider in the sidebar.

### C. Dashboard analysis (shipped, extended well past the original plan's UI/UX section)

The "Environmental Analysis" panel (`index.html`, rendered by `ui.js: updateEnvironmentalDashboard` + helpers) has three tabs. All of it is computed once and cached on the analyzer (single-track mode) or the collective manager (collective mode), keyed by the latency setting, the active-track set, and each track's `_dataVersion` fingerprint, so it self-invalidates on any re-analyze / peak edit / re-enrich.

- **Correlation Matrix** — for each environmental feature, the association with three arousal channels: momentary (max phasic in a trailing 1 s window), baseline (mean tonic), and arousal-response rate (peak count per 15 s bin). Features are the 8 continuous `osm_*` fields plus `osm_in_park` (0/1, point-biserial) plus the **EM Fog Index** (0–100, Sub-GHz RSSI derived — added only when some sample carries a reading). `osm_road_class` is multi-level categorical and stays out. Method depends on how many walks are active:
  - **1 walk** → Pearson `r` with a p-value corrected for serial autocorrelation (`calculateAutocorrCorrelation` — effective pair count from a Bartlett / Pyper–Peterman variance-inflation factor).
  - **≥ 3 walks in which the factor varies** → a random-effects **meta-analysis across walks** (`metaCorrelation`): per-walk Fisher-*z*, weighted by each walk's autocorrelation-adjusted effective N, DerSimonian–Laird between-walk variance, and a modified Knapp–Hartung *t* on *k*−1 df. Graded `meta` (≥ 5 walks, a real verdict) / `metaProvisional` (3–4, direction only) / `fewWalks` (< 3, effect size only).
  - The **Peaks** channel is re-aggregated to one point per 15 s bin (mean feature vs. peak count) before correlating, rather than duplicating a bin's count across every 1 Hz sample in it.
  - Multiple comparisons: Benjamini–Hochberg FDR, **one family per arousal channel** (`q`-values), over the environmental factors.
  - The table leads with an **effect-size band chip** (negligible / small / moderate / strong, |r| .10/.20/.30, Gignac & Szodorai 2016); the number's colour shows direction only; `· n.s.` marks a tested cell with q ≥ .05 and `· k/N` marks a factor that varied in too few walks to test. There are no significance stars.
- **Regression Plot** — scatter of a selected environmental factor vs. phasic or tonic arousal. Axes clip to the 2nd–98th percentile (outliers clamp to the frame); dot opacity and radius scale down with sample count so a dense collective cloud shows a density gradient. For a continuous factor: an OLS trend line and an R² badge. For a yes/no factor (`osm_in_park`): the points spread into two jittered columns each with a box-and-whisker (median, IQR, 10–90th percentile) and the badge shows the point-biserial `r`. The tonic channel uses the longer-lag environment (see §3C); phasic uses the shorter one.
- **Roads Profile** — mean phasic/tonic arousal per road class, with std dev and a 95% CI whose effective sample size is estimated *within each walk and summed* (never across the joins between concatenated walks). The phasic column groups each sample by the road class `latency` s back; the **tonic column groups by the class `latency × 4` s back** (the same longer lag the tonic correlation channel uses — a sample can land in a different class for the two columns near a boundary, so the per-class tonic count can differ slightly from its phasic count). `unclassified` and any class with under 5 s are dropped. The highest-vs-lowest class gap is tested with a Welch *t*-test on those effective sizes; because the two classes are chosen after seeing the means, the reported p is Bonferroni-adjusted by the number of pairwise contrasts (`k`·(`k`−1)/2), with the raw p also shown.

The map panel's "Map Metric" dropdown recolors the track by any of the ten `osm_*` columns or by GSR/HDOP, and an "OSM Layers" toggle draws the retrieved park/water/building polygons under the track (`map_manager_osm.js: drawOsmShapes`). The overlay classifies a polygon as park vs water via the *same* `OSMEnricher.isGreenSpace` / `isWaterSpace` predicates the metrics use, so a polygon drawn green is exactly one that counts toward `green_pct` / `in_park`. A `natural=wetland` satisfies both — the overlay can only paint one colour, and green wins.

### D. Local caching of Overpass responses (shipped, not in the original plan)

`osm_cache.js` caches fetched Overpass JSON in the browser's IndexedDB, keyed by bounding box, so re-enriching tracks in the same or an overlapping area doesn't re-hit the public Overpass API. This wasn't part of the original plan (which didn't address repeat fetches at all) and was added after real usage showed the same neighbourhoods getting re-fetched across sessions.

- **Containment reuse**: a request is served entirely from cache if any stored entry's bbox fully contains it (with a small tolerance for floating-point noise), preferring the tightest-fitting match.
- **Merge-on-overlap**: on a miss, if the request only *partially* overlaps one or more cached entries (a second walk that covers mostly the same streets but extends further), the fetch is expanded to the union of the request and those entries, and the result replaces them as one merged entry — capped at 12 km² so an opportunistic merge can't balloon into an oversized request. Coverage actively grows and coalesces across tracks and sessions instead of accumulating duplicate overlapping blobs.
- **Expiry & eviction**: entries expire after 30 days (`CACHE_TTL_MS`) since OSM data changes over time, and the cache is capped at 20 entries with least-recently-used eviction.
- A "Clear Cached Map Data" button in the sidebar wipes the cache manually.

See §3D for the storage architecture and §7 for known limitations of the rectangle-union approach.

### E. Satellite NDVI sampling (shipped 2026-09-04; rebuilt same day on real raster data, not colour heuristics)

`ndvi_sampler.js` (`NDVISampler`, ~1050 lines) streams the actual Sentinel-2 NDVI raster and appends two columns per GPS fix: `ndvi` (the pixel directly underfoot) and `ndvi_50m` (mean over a circular buffer, radius from the same search-radius slider as the OSM columns). Triggered by the "Sample Satellite NDVI" button; registered in `OSM_METRICS` alongside the `osm_*` columns so it lights up the Map Metric dropdown, the regression scatter, and the correlation matrix the same way.

**What changed from the first cut.** The initial version (same day) requested the stock Copernicus `VEGETATION_INDEX` layer, which — confirmed live — only ever returns a *rendered colour-ramp visualisation* regardless of requested format (`image/tiff;depth=32f` came back as the identical 8-bit RGBA bytes as the PNG); a client-side heuristic then tried to reverse-engineer a number from the colours and clipped 25% of vegetated pixels to the ceiling of 1.0 on a real test tile. That heuristic (`decodePixel`, the VARI-style formula, the thematic canvas reshading) has been removed entirely, along with the silent fallback that fabricated `ndvi`/`ndvi_50m` from `osm_green_pct_50m`/`osm_canopy_pct_50m` when a tile failed to decode.

**How it works now — a real raster, not a picture.** Sampling requires a **second, custom layer** on the Copernicus Sentinel Hub instance (`getRawLayerId()`, default layer ID `NDVI_RAW`) built from this evalscript, which outputs the actual `(B08-B04)/(B08+B04)` value as a single 32-bit float band instead of a colour:
```js
//VERSION=3
function setup() {
  return { input: [{ bands: ["B04", "B08", "dataMask"] }], output: { bands: 1, sampleType: "FLOAT32" } };
}
function evaluatePixel(sample) {
  if (sample.dataMask === 0) return [-9999]; // nodata sentinel
  return [(sample.B08 - sample.B04) / (sample.B08 + sample.B04)];
}
```
Add it once via `https://shapps.dataspace.copernicus.eu/dashboard/#/configurations` (find the configuration matching your `copernicusInstanceId`, add a Custom-script layer with this script, save it under a Layer ID, and enter that ID in the sidebar's "Raw Layer ID" field). The dashboard's own "Preview" button always renders as PNG regardless of the evalscript and will report `Format image/png does not support sample type FLOAT32` — that's the preview tool, not the layer; save anyway.

`NDVISampler` requests that layer via WMS `FORMAT=image/tiff;depth=32f`, decodes the response with a small baseline-TIFF reader written for exactly this shape of output (`parseFloat32Tiff` — one IFD, strip-organised single-band float32 samples, Deflate or uncompressed, either byte order; not a general-purpose TIFF/GeoTIFF library), using the browser's native `DecompressionStream('deflate')` for the Deflate case rather than a vendored library. The decoded tiles are stitched into an in-memory `Float32Array` mosaic and sampled directly — no canvas, no `getImageData()`, and consequently no CORS-taint failure mode either (fetched as raw bytes via `fetch().arrayBuffer()`, never drawn to a canvas). `sampleTrack`/`sampleTracks` refuse to run at all without a configured Copernicus instance — there is no other provider that can produce real data, so there is no heuristic fallback to fall back to. A point whose pixel is nodata (cloud-masked) or whose tile genuinely can't be fetched is left as `NaN` and step-held from the previous genuine reading, exactly like every other "no fix this tick" field in this codebase (§3B) — never fabricated from an unrelated column.

**The map's NDVI *visual* overlay renders the same raster, not a second one.** An even earlier version of this fix kept the stock Copernicus `VEGETATION_INDEX` *rendered* layer around for the on-map picture, fetched via a separate "Layer ID" setting — two independent server-side computations that could (in principle) disagree, and confusing in practice (a rendered colour picture next to a "raw" numeric setting invites the question "which one is actually being sampled?"). That's gone: `showNdviLayer` (`map_manager_osm.js`) now fetches the *same* `NDVI_RAW` raster used for sampling and renders it client-side as greyscale (`NDVISampler.paintGreyscaleTile`: low NDVI → black, high → white, nodata → transparent) — an exact forward mapping of the decoded float, not a reconstruction. The "Layer ID" setting and the `VEGETATION_INDEX` WMS branch are gone entirely; only "Raw Layer ID" remains. Without a Copernicus instance configured at all (so no raster exists to render), the overlay falls back to plain EOX cloudless / NASA GIBS / a custom XYZ layer shown as-is, for visual reference only — never touching `ndvi`/`ndvi_50m`.

**Batching & performance.** `sampleTracks` auto-selects a "Unified Mosaic" mode for co-located walks (combined bounding box ≤ 16 km² and ≤ 64 tiles at the requested zoom): tiles are fetched and decoded once and shared across all tracks, rather than once per track. Dispersed walks fall back to per-track sampling with fault isolation (one track's failure doesn't abort the batch). Adaptive zoom steps down (to a floor of z12) when a track's bounding box would need more than the tile budget.

Tests: `tests/test_ndvi_sampler.js` (41 tests) cover the Web Mercator math, the TIFF parser (round-tripped against synthetic uncompressed and Deflate/multi-strip rasters built in-test, plus its rejection of a non-TIFF buffer and of an unexpected band/sample-format response), the tile cache/LRU, circular-buffer sampling on a float grid (including nodata-sentinel exclusion), the retry/backoff/rate-limit state machine, mosaic-mode batching, and — unlike the first cut — that sampling refuses to run without a configured raw layer and that an unreachable tile is left as `NaN` rather than fabricated. What's still only manually verified: an actual configured `NDVI_RAW` layer against the live Copernicus WMS endpoint (the test suite mocks `fetch`), and browser support for `DecompressionStream('deflate')` (broadly supported in current Chrome/Edge/Firefox/Safari 16.4+, not polyfilled here).

---

## 3. Technical Implementation Details

### A. Data retrieval flow (`overpass_client.js`)

1. **Bounding box**: computed from the track extent plus a 100m buffer (`OSMEnricher.calculateBBox`), widened further to cover the snap radius when road-snapping is enabled.
2. **Overpass QL query** (`OverpassClient.buildQuery`) — one global `[bbox:…]` setting rather than a per-clause `(bbox)` filter (smaller body, the server resolves the box once):
   ```overpass
   [out:json][timeout:180][maxsize:536870912][bbox:{minLat},{minLon},{maxLat},{maxLon}];
   (
     way["highway"];
     way["building"];           relation["building"];
     way["leisure"~"park|garden|nature_reserve"];
     way["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"];
     way["natural"~"wood|scrub|grassland|heath|wetland"];
     relation["leisure"~"park|garden|nature_reserve"];
     relation["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"];
     relation["natural"~"wood|scrub|grassland|heath|wetland"];
     way["natural"~"water|wetland"];     way["waterway"];
     relation["natural"~"water|wetland"]; relation["waterway"];
     node["amenity"];  way["amenity"];
     node["shop"];     way["shop"];
     node["highway"="bus_stop"];
     node["natural"="tree"];
     way["natural"="tree_row"];
     relation["natural"="tree_row"];
   );
   out body; >; out skel qt;
   ```
   This is broader than the original plan's query — it adds `shop`, `bus_stop`, and several more `leisure`/`landuse`/`natural` subtypes, and drops the plan's single-value tag matches (e.g. `leisure="park"`) in favor of regex alternations that catch more park-like and green-like tags. The fetch list is kept in lock-step with the scoring sets in `osm_enrichment.js` (`GREEN_LEISURE`/`GREEN_LANDUSE`/`GREEN_NATURAL`, `WATER_*`); `wetland` appears in both the green `natural` clause and the water `natural` clause on purpose, and `natural=tree_row` (ways + relations) is fetched for `canopy_pct`. Changing the green/water **scoring** (not the fetch) needs no `OsmCache.QUERY_VERSION` bump — `enrichTrack` re-scores from whatever OSM JSON is cached — but a **fetch** change does: adding `tree_row` bumped `QUERY_VERSION` 1 → 2 (old cached payloads lack it, so `canopy_pct` from a stale entry would under-count). Either way, users re-run "Retrieve Spatial Data" for a change to take effect on already-enriched tracks.
3. **Reliability**: unlike the original plan (which didn't address network failure), the client handles Overpass rate limits (HTTP 429/509 with `Retry-After` honored), gateway timeouts (504, exponential backoff with jitter, up to 3 retries), and request aborts, with user-facing progress messages at each stage.
4. **BBox area guard**: `OSMEnricher.calculateBBoxAreaKm2` warns when the query area is large, as planned.

### B. Client-side spatial math (`geo_utils.js`, `osm_enrichment.js`)

- **Distance to segment / point-in-polygon**: implemented in a dedicated `GeoUtils` module (`haversineMeters`, `distanceToSegmentMeters`, `pointInPolygon`) rather than inline in the enrichment code — same algorithms the plan described (segment projection + haversine; ray-casting for polygons).
- **Density sampling**: a **centre point plus 2 concentric rings** (`SAMPLING_RINGS = 2`, `POINTS_PER_RING = [1, 8, 16]` — 1 + 8 + 16 = 25 points), with the rings at ½ and the full search radius. Radii scale with the user's radius slider (25–200m); at the 50m default the rings are at 25m and 50m. (This was a 3-entry / 3-ring config until a fix in which the nominal outer ring produced zero points, so coverage had been stopping at ⅔ of the radius.) The original plan specified fixed 10/25/40m rings.
- **Spatial hash indexing**: `OSMEnricher.buildSpatialIndex` grids OSM geometries at `CELL_SIZE_DEG = 0.001` (~111m at the equator) and `getNearby` checks the point's cell plus its 8 neighbors, as planned.
- **Evaluation thinning & projection**: points are evaluated at ≥1Hz spacing and projected back onto the full-rate timeline (`_selectEvaluationPoints`, `_projectToTimeline`). `_projectToTimeline` **steps** (nearest evaluation point) the categorical `osm_road_class`/`osm_in_park` and the discrete counts (`building`/`tree`/`amenity` density) — interpolating a count would invent fractional buildings and over-smooth the predictor — and linearly interpolates only the genuinely continuous fields (`green_pct`, and the distances). Where a segment has the `999` "none within radius" marker at one end, the real value is held across it rather than a mid-range distance being invented or the far half being dropped. A separate, tighter distance-based thinning (`_thinPoints`) feeds the road-snapping step.
- **Coordinate validation**: `_isValidCoord` filters `NaN`, `null`, `(0,0)`, and out-of-range lat/lon before they reach the spatial math — not in the original plan, added to harden against corrupt GPS rows.

### C. Temporal latency compensation — shipped for the dashboard

The plan proposed a "Latency Shift Slider" that would shift the arousal timeline against the *environmental* timeline before correlating. The **Peak Latency Compensation** slider (0–5s, default 2.0s, `gpsPeakLatency` in `index.html`) now drives exactly that in `updateEnvironmentalDashboard`:

- **Phasic and Peaks** channels read the environment `latency` seconds before each sample — an SCR lags its trigger and the subject has moved on.
- The **Tonic** channel reads a *longer* lag (`latency × 4`, capped at 30 s): skin-conductance *level* follows its driver over a much slower time course than an event-locked SCR. Each row carries a second `tonicEnv` snapshot for this. The ×4 factor is a reasonable estimate, not a calibrated value.
- The Roads Profile's peak-to-road-class attribution also shifts each peak's timestamp by `latency`.

The same slider still also compensates SCR onset delay for general map/peaks display.

### D. Cache architecture (`osm_cache.js`)

The cache uses **two IndexedDB object stores**, not one: `bbox_meta` holds small records (`id`, `bbox`, `queryVersion`, `fetchedAt`, `lastAccess`) and `bbox_data` holds the corresponding — potentially several-MB — Overpass JSON payload, keyed by the same `id`. This split exists because every cache decision (does anything contain this bbox? does anything overlap it? which entry is least-recently-used?) only needs the metadata; keeping it separate from the data blobs means those decisions stay cheap to compute no matter how large the cached payloads get, instead of deserializing every cached payload on every enrich click. The actual data blob is fetched exactly once, by id, only after a specific entry has been chosen. Writes and deletes span both stores in single atomic transactions so metadata can never reference a missing blob or vice versa.

`_planFetch(bbox)` is a pure function (no IndexedDB access) that decides, given the current metadata list, whether to fetch just the requested bbox or the union of it and any overlapping entries — this and the containment-matching logic (`_pickBestMatch`) and eviction selection (`_selectEvictions`) are all pure and unit-tested directly (see §6). The `_openDb`/`_getAll`/`_get`/`_putEntry`/`_deleteEntries` IndexedDB glue around them is thin, standard wrapper code, not independently tested (Node has no IndexedDB implementation — see §6 and §7).

A schema note: the cache started as a single object store mixing metadata and data together, which was the direct cause of the "every check reads the full payload" inefficiency above — `DB_VERSION` was bumped to 2 to migrate to the split-store layout, dropping any old single-store cache on upgrade (safe, since this is a cache — losing old entries only costs a few extra network fetches, never real data).

---

## 4. UI/UX — as built

**Sidebar "Spatial Data" card** (renamed from "Environmental Enrichment"): search-radius slider (25–200m, default 50m), the "Snap to Roads & Trails" toggle and snap-radius slider (10–60m, default 25m — moved here from the GPS Filtering card, since it's part of preparing data for retrieval rather than a display filter), a "Retrieve Spatial Data" button (renamed from "Enrich Active Track"), and a progress bar with live status messages (checking the local cache, rate-limit waits, retry counts, parse progress, and — when a partial-overlap merge is happening — how many cached areas are being merged). A "Clear Cached Map Data" button wipes the IndexedDB cache described in §2D/§3D. The latency slider that the dashboard uses lives with the peak-detection controls, not on this card (see §3C).

**Map panel**: a "Map Metric" dropdown recolors the track by `osm_road_class`, `osm_dist_major_road`, `osm_in_park`, `osm_green_pct_50m`, `osm_building_density_50m`, `osm_dist_water`, `osm_tree_density_50m`, `osm_amenity_count_50m`, GSR arousal, or GPS HDOP quality (colors defined in `map_colors.js`). Options are disabled until a track has been enriched. An "OSM Layers" toggle overlays the fetched park/water/building polygons on the map (`map.js: drawOsmShapes` / `clearOsmShapes`).

**Environmental Analysis dashboard**: the three-tab panel described in §2C, sitting alongside the SCR peaks table.

**Street-level imagery modal** (not in the original plan): clicking a track point can open a modal showing Mapillary and/or Google Street View imagery for that coordinate (`ui.js: openStreetView`). This is a manual visual-inspection tool, not an automated greenery metric — see Phase 3 below.

---

## 5. File Architecture — as built

```
visualiser/
├── src/
│   ├── osm/
│   │   ├── osm_enrichment.js     - Overpass orchestration, evaluation-point selection,
│   │   │                           per-point feature extraction, CSV column wiring.
│   │   ├── overpass_client.js    - Overpass HTTP client: query building, rate-limit
│   │   │                           and retry/backoff handling.
│   │   ├── osm_cache.js          - IndexedDB cache for Overpass responses: containment
│   │   │                           reuse, merge-on-overlap, TTL/LRU eviction.
│   │   └── ndvi_sampler.js       - Real NDVI raster sampling: fetches a custom Copernicus
│   │                               evalscript layer as FLOAT32 TIFF, a baseline-TIFF parser
│   │                               (parseFloat32Tiff), circular-buffer sampling on the
│   │                               decoded float grid, mosaic batching (§2E). EOX/NASA
│   │                               GIBS/custom XYZ registered for the visual overlay only.
│   ├── gps/
│   │   ├── geo_utils.js          - haversine / distance-to-segment / point-in-polygon.
│   │   ├── map_match.js          - HMM/Viterbi GPS-to-road snapping (MapMatcher).
│   │   ├── gps_filter.js         - Velocity smoothing, stop averaging, Kalman & RTS filter.
│   │   └── gps_pipeline.js       - Quality gates and GPS pipeline coordinator.
│   ├── map/
│   │   ├── map.js                - OSM polygon overlay rendering (drawOsmShapes).
│   │   └── map_colors.js         - Color scales / LUTs for all map metrics, incl. osm_*.
│   ├── core/
│   │   └── constants.js          - GSR_CONST: OSM_METRICS (key<->field<->label<->kind,
│   │                               the single source of truth for the 10 columns) and the
│   │                               SNAP tuning block. (SAMPLING_RINGS/POINTS_PER_RING are
│   │                               module-level consts in osm_enrichment.js, not here.)
│   ├── ui/
│   │   └── ui.js                 - enrichTrack() orchestration (incl. cache lookup/
│   │                               merge-plan/store wiring), and the whole
│   │                               Environmental Analysis dashboard:
│   │                               updateEnvironmentalDashboard (per-walk bucketing,
│   │                               latency alignment, caching), renderCorrelationTable,
│   │                               drawRegressionScatter, renderRoadProfile,
│   │                               street-view modal.
│   └── signal/
│       ├── analyzer.js           - osm_* column CSV parsing/export, isEnriched state,
│       │                           calcEmFog (EM Fog Index from Sub-GHz RSSI).
│       └── stats_math.js         - Pearson r; autocorrelation-corrected effective N
│                                   (Bartlett / Pyper-Peterman VIF); random-effects
│                                   meta-analysis (metaCorrelation); Benjamini-Hochberg
│                                   FDR; Welch t-test; OLS regression; the incomplete-
│                                   beta / log-gamma p-value machinery.
├── index.html                    - Sidebar enrichment + GPS-snap cards, map metric
│                                   dropdown, Environmental Analysis dashboard markup.
└── tests/
    ├── test_osm_enrichment.js         - OSMEnricher + MapMatcher regression suite.
    ├── test_osm_hard_shapes.js        - awkward multipolygon / geometry edge cases.
    ├── test_osm_overlay.js            - drawOsmShapes park/water/building categorisation
    │                                    (shares OSMEnricher.isGreenSpace/isWaterSpace;
    │                                    wetland → green, playground → nothing).
    ├── test_osm_metrics_table.js      - OSM_METRICS <-> osm_* field/kind consistency.
    ├── test_osm_enrich_orchestration.js - collective enrich: per-track fetch, one bad
    │                                    track doesn't abort the rest.
    ├── test_osm_cache.js              - OsmCache pure-logic regression suite.
    ├── test_overpass_client.js        - query building, rate-limit / retry / backoff.
    ├── test_env_dashboard_cache.js    - updateEnvironmentalDashboard end to end: cache
    │                                    self-invalidation, meta vs single method, per-
    │                                    channel FDR, tonic/peaks handling, road Bonferroni.
    ├── test_stats_math.js             - all of stats_math.js incl. metaCorrelation
    │                                    operating-characteristics (FPR / power) sim.
    ├── test_map_legend.js             - drawRegressionScatter + _percentile helpers.
    ├── test_geo_utils.js / test_refactor.js - GeoUtils regression coverage.
    ├── test_map_match.js              - HMM/Viterbi snapping.
    └── test_ndvi_sampler.js           - tile math, the baseline-TIFF float32 parser
                                          (round-tripped against synthetic rasters),
                                          cache/LRU, float-grid circular-buffer sampling,
                                          retry/backoff, mosaic batching, and the
                                          no-Copernicus-config / unreachable-tile refusal
                                          paths (§2E). Live endpoint not exercised — fetch
                                          is mocked throughout.
```

The original plan didn't list `overpass_client.js`, `geo_utils.js`, `map_match.js`, or `osm_cache.js` as separate files — the actual implementation split the network client and spatial-math primitives out of the main enrichment module, added the map-matching module entirely, modularized the codebase into `src/`, and added the caching module in response to real repeat-fetch behaviour the plan never anticipated.

---

## 6. Verification — current state

The enrichment, dashboard and caching pipeline all have automated regression coverage:

- **`tests/test_geo_utils.js` / `test_refactor.js`** — `geo_utils.js` (`haversineMeters`, `distanceToSegmentMeters`, `pointInPolygon`, known-distance and antipodal cases).
- **`tests/test_osm_enrichment.js`** (~270 assertions) — `OSMEnricher`: bbox math and coordinate validation, geometry reconstruction (ways, relations, multipolygon **inner rings / holes**), the spatial hash grid, evaluation-point selection and thinning, `_evaluatePosition`'s per-feature metrics — roads (nearest-vehicular-road preference + 25 m cap; `NON_ROAD_HIGHWAY` exclusion; "roads present but none major → sentinel"), green space (via `leisure` / `landuse` / `natural`; relation hole excluded from *in park*; **`natural=wetland` is green AND blue**; **`leisure=playground` is not green**; **`dist_green` = 0 inside / edge distance outside / nearest boundary incl. hole edge / 999 sentinel**; **`canopy_pct` = wood/forest polygons + a ~10 m buffer around `tree_row` ways / `tree` nodes, decoupled from `green_pct`**), water (`way` **and** `relation` bodies), buildings (nearest edge, ways **and** multipolygon relations), trees, amenities (shops, bus stops, way-mapped amenities at their centroid, non-`AMENITY_TYPES` values excluded) — the sampling grid reaching the full radius, `_projectToTimeline` step-vs-lerp and sentinel handling, and `enrichTrack()` integration on both the plain and the **HMM-snap** (`snapParams.enabled`) path. `MapMatcher`: distance/bearing helpers, candidate generation and road-class ranking, and a full HMM-Viterbi snap on a synthetic road network.
- **`tests/test_env_dashboard_cache.js`** — drives the real `updateEnvironmentalDashboard` against analysed fixture tracks: cache self-invalidation on every mutation path, single-walk vs meta method selection by walk count, per-channel FDR (`qPhasic` matches a phasic-only Benjamini–Hochberg family), `tonicEnv` presence, `kPeaks ≤ kPhasic` (peaks binned coarser), the road-comparison Bonferroni (`pAdj ≥ p`), and that the **Roads Profile groups tonic arousal by the tonic-lagged class**, not the phasic-lagged one.
- **`tests/test_stats_math.js`** — every routine in `stats_math.js`: Pearson + autocorrelation-corrected p, `metaCorrelation` (contract + inverse-variance weighting + a trimmed FPR/power simulation), `benjaminiHochberg`, `welchTTest` (incl. the `effN` override), regression, and the `_logBeta`/`_logGamma`/incomplete-beta p-value chain against R reference values.
- **`tests/test_osm_cache.js`** (~50 assertions) — `OsmCache`'s decision logic: containment matching and tightest-fit selection, merge-on-overlap (union math, multi-entry merges, the oversized-union fallback), query-version and TTL filtering, and LRU eviction selection.
- **`tests/test_overpass_client.js`, `test_osm_metrics_table.js`, `test_osm_enrich_orchestration.js`, `test_map_legend.js`, `test_map_match.js`** — query building / retry logic, the `OSM_METRICS` single-source-of-truth table, collective-mode enrich orchestration (one failing track doesn't abort the rest), and the scatter-plot / `_percentile` helpers.

All of this is run via `npm test` (`node --test tests/*.js`) — no browser or build step needed; the browser-global modules load through `vm.runInThisContext`.

What's still **not** covered: the plan's proposed `scratch/test_spatial_math.js` was never written as such (its intent is now met by `test_osm_enrichment.js` instead, in the project's existing test-file convention rather than a standalone `scratch/` script), and `osm_cache.js`'s actual IndexedDB glue (`_openDb`, `_putEntry`, `_deleteEntries`, the `DB_VERSION` migration) is untested — Node has no IndexedDB implementation, so only the pure decision functions that logic delegates to are exercised. See Future Improvements below.

Manual verification remains necessary for: the real Overpass network path (rate-limit/retry behaviour), the IndexedDB glue itself, and end-to-end UI flows — load a track, click Enrich, watch the network tab (and confirm a *second* enrich of an overlapping area shows no network request, or a merged one for partial overlap), toggle map coloring, and check the exported CSV for the ten `osm_*` columns.

---

## 7. Future Improvements

Spatial-math tests, map-matcher tests, Overpass response caching, and the latency-shifted dashboard comparison (`Environment(t − latency)` vs `Arousal(t)`, with a separate longer lag for the tonic channel — §3C) have all since shipped. What follows is the remaining open list.

> **Research basis & worked-up plans:** items 1, 3, 4, 5, 14 and 15 are developed
> with literature backing and implementation sketches in the companion
> [`environmental_enrichment_research.md`](environmental_enrichment_research.md)
> (physiological timing constants, the four green channels, the thermal/exertion
> confounds, the walking-speed covariate, traffic tags, NDVI as column + map
> layer, GVI, and the spatial-autocorrelation rationale). Priority order is in
> its §7.

1. **Model, or at least gate, the thermal confound.** Skin conductance outdoors is driven substantially by thermoregulatory sweating; parks are shaded and cooler, so a "green space → lower tonic arousal" reading may be as much a temperature effect as a restorative one. The dashboard captions this but cannot separate it — there is no temperature channel to regress out. Either ingest an ambient-temperature column (some loggers have one) as a covariate, or state the limitation more forcefully next to the green-space rows.

2. **Give the Roads Profile CI a between-walk term.** The CI now uses a per-walk-summed effective N (§2C), which removes the within-walk autocorrelation inflation, but it still treats every walk's samples as draws from one distribution — it doesn't account for one whole walk running hotter than another. A proper hierarchical / mixed-effects mean per road class (random intercept per walk) would; the Welch highest-vs-lowest test has the same limitation.

3. **Extend `_evaluatePosition` with acoustic / traffic proxies.** The "Traffic & Acoustic Stress" dimension is currently approximated only by `osm_road_class`/`osm_dist_major_road`. OSM has `maxspeed`, `lanes`, and `traffic_signals` tags already present in the fetched way data that aren't extracted — cheap additions that would sharpen the traffic-stress signal without a new data source.

4. **Make `ndvi`/`ndvi_50m` measure actual vegetation, not rendered colour — SHIPPED & FIXED (2026-09-04).** The first cut of §2E's `NDVISampler` decoded NDVI from the *rendered visualisation* of the Copernicus `VEGETATION_INDEX` layer via colour heuristics, not the underlying `(B8-B4)/(B8+B4)` value — verified to clip ~25% of vegetated pixels to the 1.0 ceiling on a real tile. Same-day fix: a custom evalscript layer (`NDVI_RAW` by default; the evalscript is in §2E) now outputs the raw float value directly, decoded via a small baseline-TIFF parser — no colour heuristics anywhere in the path. The fabricated-fallback path that used to fill `NaN` samples from `osm_green_pct_50m`/`osm_canopy_pct_50m` was removed rather than flagged — a missing/nodata reading is now left `NaN` and step-held, never invented. Open item: this depends on the custom evalscript layer actually being configured on the Sentinel Hub instance and being manually verified against the live endpoint (the test suite mocks `fetch` — see §2E).

5. **Turn the Street View modal into an automated GVI metric.** The Mapillary/Google Street View viewer (`ui.js: openStreetView`) already fetches street-level imagery per coordinate for manual inspection. A batch mode that samples imagery at the same evaluation points used for OSM enrichment, runs a simple green-pixel-fraction classifier client-side (or via a small serverless function, since CORS/canvas tainting will block pure client-side pixel analysis of most embeds), and writes an `osm_gvi_50m`-style column would complete the plan's original Phase 3 without requiring a new UI surface.

6. **Document the `osm_*` columns (and the cache) in `docs/csv_schema.md`.** (Addressed: `docs/csv_schema.md` v1.8 notes that post-processing enrichment columns and snapped GPS fields are appended by the visualiser upon export rather than by the firmware).

7. **Move the cache from rectangle-union to a true delta fetch, if rectangle bloat becomes a real problem.** Merge-on-overlap reasons about axis-aligned bounding boxes, not actual track shapes — two tracks whose real paths barely overlap (e.g. two long tracks crossing near their midpoints but heading in different directions) can still have bounding rectangles that overlap heavily, causing the merged fetch to cover a lot of area neither track ever visited. The 12 km² cap bounds the worst case, but doesn't eliminate the waste. A true fix means either rectangle-subtraction (fetch only the geometrically uncovered area, then merge OSM elements by their stable global IDs — deduping across fetches turns out to be straightforward since Overpass always returns a way's full geometry, not a bbox-clipped fragment) or a persistent tile-based element cache (grid the world into fixed tiles, track which are fetched, store individual OSM elements once regardless of which fetch brought them in). Both are meaningfully more complex than the current approach and are only worth it if real usage shows the rectangle-union approach fetching noticeably more than needed.

8. **The merge is single-pass, not transitive.** `planFetch` only checks what overlaps the *original* request bbox. If merging with one entry produces a union that now also overlaps a second entry that didn't overlap the original request, that second entry isn't folded in — it's picked up (if at all) by some later request. A fixed-point merge (keep re-checking for new overlaps until none remain) would converge to a cleaner cache state, at the cost of more DB round-trips per miss.

9. **No cross-tab cache coordination.** The `_enriching` re-entrancy guard in `ui.js` is an in-memory flag scoped to one page. Two browser tabs enriching overlapping areas around the same time could each independently plan and store a merge, producing two overlapping "merged" entries instead of one. Low priority for a single-user local analysis tool, but worth knowing if the visualiser is ever used with multiple tabs open side by side.

10. **Exercise `osm_cache.js`'s actual IndexedDB glue in tests.** Everything currently tested (`_bboxContains`, `_planFetch`, `_selectEvictions`, etc.) is pure logic with no IndexedDB dependency, by design — Node has none. Adding the `fake-indexeddb` npm package to the test setup would let `_openDb`, `_putEntry`, `_deleteEntries`, and the `DB_VERSION` 1→2 migration path get real regression coverage too, rather than relying on manual in-browser verification.

11. **Surface cache stats in the UI.** The "Clear Cached Map Data" button currently has no visibility into what it's about to delete — showing the number of cached areas and approximate total size next to it (a quick `bbox_meta`/`bbox_data` count and size estimate) would make the cache's behaviour less opaque.

12. **Warn on mixed enrichment radii in collective mode.** `updateEnvironmentalDashboard` pools every enriched active track regardless of the search radius each was enriched at — a walk done at 50 m and one at 150 m contribute `osm_green_pct_50m` / density values on different scales with no adjustment or notice. `analyzer.enrichmentRadius` is already available per track; the dashboard should flag (or offer to re-enrich) when active tracks disagree.

13. **Building & amenity density still ignore footprint area.** Nearest-edge distance (shipped) fixes the "large block, far centroid" miss, but a building is still a 0/1 count once any edge is in range — a huge complex and a garden shed weigh the same. An area-weighted or solid-angle "enclosure" measure would model the *Built Complexity* dimension better. Way-mapped amenities still use centroid distance (minor — most amenities are nodes).

14. **Add a walking-speed / exertion covariate — SHIPPED (2026-09).** GPS speed (m/s, converted from `speedKts`) is tracked on each sample and its `tonicEnv`. `StatsMath.partialCorrelation(x, y, z)` residualises both the environmental feature and baseline arousal on walking speed by OLS and correlates the residuals with autocorrelation correction. In the Environmental Analysis table, Tonic SCL shows the speed-adjusted partial correlation (`spd-adj`) alongside the raw value, flagging when gait slowing explains the apparent link. In collective mode, partial correlations are meta-analysed across walks. Walking speed is also registered as an X-axis factor in the Regression Scatter plot.

15. **Reconsider EM Fog's place in this dashboard.** It is not an OSM/structural feature, has no physical unit, and is partly a function of device pose. It also tends to be the one row that clears significance — because its near-white-noise autocorrelation structure dodges the effective-N down-weighting that flattens every genuinely spatial factor, not because the effect is stronger. Either move it to its own panel or caption that row pointedly.

16. **The other half of "perceived green": tree canopy / street greenery, not just green spaces.** *(Option A shipped — `osm_canopy_pct_50m`.)* `dist_green` covers *green spaces you can see* — parks, woods, meadows as polygons. It says nothing about **being under or among trees on an otherwise grey street** (a plane-tree avenue, a hedge-lined lane), which is a large part of what people report as a "green" walk. Today that is only `osm_tree_density_50m` = a raw count of `natural=tree` **nodes**, which misses almost everything: woodland is mapped as `natural=wood` / `landuse=forest` *polygons* with no tree nodes inside, and tree-lined streets are usually one `natural=tree_row` *way*, also not counted. So the column is really "did a local mapper tag individual trees here", an OSM-effort artefact. Three ways to add a real canopy channel, cheapest first:

    - **A — `osm_canopy_pct_50m` — SHIPPED.** Fraction of the 25-point sampling grid under a `natural=wood` / `landuse=forest` polygon, OR within `CANOPY_BUFFER_M` (10 m) of a `natural=tree_row` way or `natural=tree` node. `way`/`relation` `["natural"="tree_row"]` added to the Overpass query (`QUERY_VERSION` 1 → 2). Lerps like `green_pct` in `_projectToTimeline`. Registered in `OSM_METRICS` (`canopyPct`), so it appears in the correlation matrix, the regression scatter, the Map Metric dropdown (`map_colors.js` gives it a pale→deep-forest ramp), and the CSV export/import — the green dimension is now four weakly-correlated channels: `in_park` / `green_pct` / `dist_green` / `canopy_pct`. Still OSM-completeness-limited (an unmapped avenue reads 0), but far less so than the `natural=tree` node tally.

    - **B — NDVI / canopy raster (the real fix — SHIPPED 2026-09-04, live raster not offline export; see §2E).** The originally proposed *offline* path — a one-time bulk export of a greenness/canopy layer clipped to the region, sampled by a small `scratch/` Node script — was not what got built. What shipped instead (`ndvi_sampler.js`) streams the real Sentinel-2 NDVI raster live from a custom Copernicus Sentinel Hub evalscript layer (§2E) — a same-day correction after a first attempt that decoded NDVI from rendered colours and clipped badly. `canopy_m` (an actual canopy-height channel, vs. NDVI's greenness) is not built; NDVI now measures real vegetation, canopy height would need a LiDAR CHM specifically.

    - **C — Green View Index from street-level imagery (highest fidelity to "what they saw", most infrastructure).** Batch-sample Mapillary/Street View at the evaluation points and run a green-pixel-fraction classifier; CORS/canvas-tainting forces a small serverless function. Same idea as item 5's GVI proposal, applied to the canopy question.

    Recommendation: **A now** (immediate, reuses the `dist_green` plumbing verbatim), **B** when someone can do the one-time raster export.
