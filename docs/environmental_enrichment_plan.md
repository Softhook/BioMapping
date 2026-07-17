# Environmental Enrichment & Analysis — Implementation Reference

This document describes the environmental-enrichment system as it is actually implemented in the Bio Mapping GSR map analyzer (`gsr-map-analyzer/`), and lists concrete suggestions for extending it. It replaces an earlier forward-looking plan; that plan's Phase 1 (native OSM integration) shipped, was extended with a GPS road-snapping system that was never in the original plan, and Phases 2–3 (satellite NDVI/LiDAR, automated Street View greenery index) were not built.

---

## 1. Conceptual Overview & Scientific Rationale

Skin conductance (GSR/EDA) measures sympathetic nervous system activation, reflecting physiological arousal and stress. When people navigate urban spaces, their arousal levels fluctuate in response to environmental conditions. Pairing physiological data with spatial location lets us identify environmental drivers of stress and restoration.

```
[Urban Stressors]     --> [Sympathetic Spike]    --> GSR Peak / SCL Rise (after ~1.5–3.0s latency)
[Restorative Zones]   --> [Sympathetic Decay]    --> GSR Recovery / SCL Decline
```

The implemented system captures five environmental dimensions, each backed by an OpenStreetMap tag set (see `gsr-map-analyzer/osm_enrichment.js`):

1. **Traffic & Acoustic Stress** — road classification and distance to the nearest major road.
2. **Visual & Natural Restoration (Green Spaces)** — park containment and green-space density from `leisure`, `landuse`, and `natural` tags.
3. **Blue Spaces (Water Bodies)** — distance to the nearest water feature (`natural=water|wetland`, `waterway`, `landuse` water tags).
4. **Built Complexity (Enclosure)** — building density from `building` ways/relations.
5. **Social & Pedestrian Activity** — count of nearby amenities (cafes, shops, transit, schools, etc.) from `amenity`/`shop` tags.

---

## 2. What's Implemented

### A. OSM enrichment (shipped, matches the original Phase 1 goal)

Fetches structural environmental data from the public Overpass API entirely client-side — no API keys, no server, no preprocessing. Implemented in `osm_enrichment.js` (952 lines) with the network layer split out into `overpass_client.js`.

Per-point outputs, appended as new columns on the analyzed track:

| Column | Meaning |
|---|---|
| `osm_road_class` | Nearest road's `highway` tag (e.g. `residential`, `primary`) |
| `osm_dist_major_road` | Distance in meters to the nearest major road |
| `osm_in_park` | 1 if the point falls inside a park/green polygon, else 0 |
| `osm_green_pct_50m` | Fraction of sampled points within the search radius that fall in green space |
| `osm_building_density_50m` | Fraction of sampled points inside building footprints |
| `osm_dist_water` | Distance in meters to the nearest water feature |
| `osm_tree_density_50m` | Density of `natural=tree` nodes within radius |
| `osm_amenity_count_50m` | Count of amenity/shop nodes within radius |

### B. GPS road-snapping / map-matching (shipped, not in the original plan)

`osm_enrichment.js` and `map_match.js` together implement an HMM/Viterbi-style map matcher (`MapMatcher.match()`) that snaps noisy GPS points onto OSM road/path geometry before enrichment. This corrects multipath drift in urban canyons and under tree canopy — a real accuracy problem the original plan didn't anticipate. It scores emission probability (distance to candidate ways) and transition probability (route distance between candidate ways at consecutive fixes, with a junction-aware routing step), applies hysteresis so the matched way doesn't flicker, and blends the raw and snapped position with a distance-based alpha. Snap tuning lives in `constants.js` (`GSR_CONST.SNAP`: in/out radius, heading weight, hysteresis margin/duration, speed gate, spatial-index cell size) and is user-adjustable via the "Snap to Roads & Trails" toggle and radius slider in the sidebar.

### C. Dashboard analysis (shipped, matches the original plan's UI/UX section)

The "Environmental Analysis" panel (`index.html`, rendered by `ui.js`) has three tabs:
- **Correlation Matrix** — Pearson `r` and p-value between each environmental feature and phasic/tonic/peak-rate arousal, with significance stars (`stats_math.js: calculatePearsonCorrelation`).
- **Regression Plot** — scatter of a selected environmental factor vs. phasic or tonic arousal, with a fitted line and R² interpretation legend.
- **Roads Profile** — mean phasic/tonic arousal (with std dev and 95% CI) and peak rate per road class, as both a table and a bar chart.

The map panel's "Map Metric" dropdown recolors the track by any of the eight `osm_*` columns or by GSR/HDOP, and an "OSM Layers" toggle draws the retrieved park/water/building polygons under the track (`map.js: drawOsmShapes`).

---

## 3. Technical Implementation Details

### A. Data retrieval flow (`overpass_client.js`)

1. **Bounding box**: computed from the track extent plus a 100m buffer (`OSMEnricher.calculateBBox`), widened further to cover the snap radius when road-snapping is enabled.
2. **Overpass QL query** (`OverpassClient.buildQuery`):
   ```overpass
   [out:json][timeout:180][maxsize:536870912];
   (
     way["highway"](bbox);
     way["building"](bbox);           relation["building"](bbox);
     way["leisure"~"park|garden|nature_reserve|playground"](bbox);
     way["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"](bbox);
     way["natural"~"wood|scrub|grassland|heath"](bbox);
     relation["leisure"~"park|garden|nature_reserve|playground"](bbox);
     relation["landuse"~"grass|forest|meadow|recreation_ground|village_green|orchard"](bbox);
     relation["natural"~"wood|scrub|grassland|heath"](bbox);
     way["natural"~"water|wetland"](bbox);     way["waterway"](bbox);
     relation["natural"~"water|wetland"](bbox); relation["waterway"](bbox);
     node["amenity"](bbox);  way["amenity"](bbox);
     node["shop"](bbox);     way["shop"](bbox);
     node["highway"="bus_stop"](bbox);
     node["natural"="tree"](bbox);
   );
   out body; >; out skel qt;
   ```
   This is broader than the original plan's query — it adds `shop`, `bus_stop`, and several more `leisure`/`landuse`/`natural` subtypes, and drops the plan's single-value tag matches (e.g. `leisure="park"`) in favor of regex alternations that catch more park-like and green-like tags.
3. **Reliability**: unlike the original plan (which didn't address network failure), the client handles Overpass rate limits (HTTP 429/509 with `Retry-After` honored), gateway timeouts (504, exponential backoff with jitter, up to 3 retries), and request aborts, with user-facing progress messages at each stage.
4. **BBox area guard**: `OSMEnricher.calculateBBoxAreaKm2` warns when the query area is large, as planned.

### B. Client-side spatial math (`geo_utils.js`, `osm_enrichment.js`)

- **Distance to segment / point-in-polygon**: implemented in a dedicated `GeoUtils` module (`haversineMeters`, `distanceToSegmentMeters`, `pointInPolygon`) rather than inline in the enrichment code — same algorithms the plan described (segment projection + haversine; ray-casting for polygons).
- **Density sampling**: uses a **3-ring, 25-point** concentric sampling pattern (`SAMPLING_RINGS = 3`, `POINTS_PER_RING = [1, 8, 16]`), but the ring radii are fractions of the user-configurable search radius (`r/3, 2r/3, r`), not the fixed 10/25/40m the original plan specified. Since the default search radius is 50m, the default rings land at ~17m/33m/50m — close to, but not identical to, the plan's numbers, and they scale correctly when the user changes the radius slider (25–200m).
- **Spatial hash indexing**: `OSMEnricher.buildSpatialIndex` grids OSM geometries at `CELL_SIZE_DEG = 0.001` (~111m at the equator) and `getNearby` checks the point's cell plus its 8 neighbors, as planned.
- **Evaluation thinning**: points are evaluated at ≥1Hz spacing and interpolated back onto the full-rate timeline (`_selectEvaluationPoints`, `_projectToTimeline`), matching the plan's performance strategy. A separate, tighter distance-based thinning (`_thinPoints`) feeds the road-snapping step, which needs different density characteristics than the environmental sampling step.
- **Coordinate validation**: `_isValidCoord` filters `NaN`, `null`, `(0,0)`, and out-of-range lat/lon before they reach the spatial math — not in the original plan, added to harden against corrupt GPS rows.

### C. Temporal latency compensation — partially implemented, not enrichment-specific

The plan proposed a "Latency Shift Slider" that would shift the GSR timeline against the *environmental* timeline before correlating. What actually shipped is a **Peak Latency Compensation** slider (0–5s, default 2.0s, `gpsPeakLatency` in `index.html`, `GSR_DEFAULT.peakLatency` in `constants.js`) that compensates SCR onset delay for map/statistics display generally — it isn't wired specifically into the correlation-matrix or scatter-plot calculations against OSM features. Aligning the correlation dashboard to this existing slider (or adding a dedicated one) is listed under Future Improvements below.

---

## 4. UI/UX — as built

**Sidebar "Environmental Enrichment" card**: search-radius slider (25–200m, default 50m), an "Enrich Active Track" button, and a progress bar with live status messages (rate-limit waits, retry counts, parse progress). No latency slider here (see §3C).

**Sidebar "GPS Processing" card**: a "Snap to Roads & Trails" toggle and snap-radius slider (10–60m, default 25m) — this is the road-snapping feature from §2B, not in the original plan.

**Map panel**: a "Map Metric" dropdown recolors the track by `osm_road_class`, `osm_dist_major_road`, `osm_in_park`, `osm_green_pct_50m`, `osm_building_density_50m`, `osm_dist_water`, `osm_tree_density_50m`, `osm_amenity_count_50m`, GSR arousal, or GPS HDOP quality (colors defined in `map_colors.js`). Options are disabled until a track has been enriched. An "OSM Layers" toggle overlays the fetched park/water/building polygons on the map (`map.js: drawOsmShapes` / `clearOsmShapes`).

**Environmental Analysis dashboard**: the three-tab panel described in §2C, sitting alongside the SCR peaks table.

**Street-level imagery modal** (not in the original plan): clicking a track point can open a modal showing Mapillary and/or Google Street View imagery for that coordinate (`ui.js: openStreetView`). This is a manual visual-inspection tool, not an automated greenery metric — see Phase 3 below.

---

## 5. File Architecture — as built

```
gsr-map-analyzer/
├── osm_enrichment.js     - Overpass orchestration, evaluation-point selection,
│                           per-point feature extraction, CSV column wiring.
├── overpass_client.js    - Overpass HTTP client: query building, rate-limit
│                           and retry/backoff handling.
├── geo_utils.js          - haversine / distance-to-segment / point-in-polygon.
├── map_match.js          - HMM/Viterbi GPS-to-road snapping (MapMatcher).
├── map_colors.js         - Color scales / LUTs for all map metrics, incl. osm_*.
├── constants.js          - GSR_CONST, including SAMPLING_RINGS/POINTS_PER_RING
│                           and the SNAP tuning block.
├── index.html            - Sidebar enrichment + GPS-snap cards, map metric
│                           dropdown, Environmental Analysis dashboard markup.
├── ui.js                 - enrichTrack() orchestration, dashboard rendering
│                           (correlation table, scatter plot, road profile),
│                           street-view modal.
├── map.js                - OSM polygon overlay rendering (drawOsmShapes).
└── analyzer.js            - osm_* column CSV parsing/export, isEnriched state.
```

The original plan didn't list `overpass_client.js`, `geo_utils.js`, or `map_match.js` as separate files — the actual implementation split the network client and spatial-math primitives out of the main enrichment module, and added the map-matching module entirely.

---

## 6. Verification — current state

There is no automated test coverage for the spatial math (`geo_utils.js`), the Overpass query builder, or the map matcher. The plan's proposed `scratch/test_spatial_math.js` was never written. The `gsr-map-analyzer/tests/` directory covers GSR filtering and the GPS/GSR processing pipeline (`test_all_pipelines.js`, `test_e2e_pipeline.js`, `test_refactor.js`, `test_dwt_clamp.js`) but nothing enrichment-related. This is the most significant gap between the plan and reality — the plan explicitly called for these tests and they don't exist. See Future Improvements below.

Manual verification remains ad hoc: load a track, click Enrich, watch the network tab, toggle map coloring, and check the exported CSV for the eight `osm_*` columns.

---

## 7. Future Improvements

1. **Add automated spatial-math tests.** Port the plan's original testing intent into `gsr-map-analyzer/tests/test_geo_utils.js`: known-answer tests for `haversineMeters` and `distanceToSegmentMeters` against hand-computed spherical cases, `pointInPolygon` against convex/non-convex/self-touching polygons, and a benchmark for `buildSpatialIndex`/`getNearby` at realistic track sizes (this is the single highest-value gap — the module has no regression protection today).

2. **Add regression coverage for the map matcher.** `map_match.js` is the most algorithmically complex piece of the enrichment system (Viterbi decoding, junction routing, hysteresis) and has zero tests. A small synthetic road network with known ground-truth snapped paths would catch regressions in `_getCandidates`, `_wayDistance`, and the hysteresis logic.

3. **Wire the correlation/scatter dashboard to a real latency shift.** Either reuse the existing Peak Latency Compensation slider or add a dedicated one, and apply it inside `renderCorrelationMatrix`/`drawRegressionScatterPlot` so `Environment(t)` is actually compared against `Arousal(t + latency)` rather than the current same-timestamp comparison. This was the plan's original Phase 1 headline feature and is the one clearly-scoped piece that didn't ship.

4. **Cache Overpass responses across sessions.** `analyzer.osmJson` is cached in memory for the current track, but re-enriching after a page reload re-fetches from Overpass. Persisting the raw JSON (or the derived per-point features) to `localStorage`/IndexedDB keyed by bbox would reduce load on the public Overpass instance and speed up repeat analysis.

5. **Extend `_evaluatePosition` with acoustic proxies.** The plan's "Traffic & Acoustic Stress" dimension is currently approximated only by `osm_road_class`/`osm_dist_major_road`. OSM has `maxspeed`, `lanes`, and `traffic_signals` tags already present in the fetched way data that aren't extracted — cheap additions that would sharpen the traffic-stress signal without a new data source.

6. **Revisit Phase 2 (NDVI/canopy) as a real offline path.** Rather than the plan's original Google Earth Engine/Sentinel Hub script, consider a one-time bulk export (e.g. clipped Sentinel-2 NDVI tiles for the region) that a small Node script in `scratch/` samples at track coordinates and appends as CSV columns the existing `analyzer.js` column-detection logic (`headers.indexOf('osm_...')`) can already pick up with minimal changes — the CSV-column plumbing for "optional enrichment columns that light up the map dropdown when present" already exists and generalizes to any future column prefix.

7. **Turn the Street View modal into an automated GVI metric.** The Mapillary/Google Street View viewer (`ui.js: openStreetView`) already fetches street-level imagery per coordinate for manual inspection. A batch mode that samples imagery at the same evaluation points used for OSM enrichment, runs a simple green-pixel-fraction classifier client-side (or via a small serverless function, since CORS/canvas tainting will block pure client-side pixel analysis of most embeds), and writes an `osm_gvi_50m`-style column would complete the plan's original Phase 3 without requiring a new UI surface.

8. **Document the `osm_*` columns in `docs/csv_schema.md`.** The schema doc currently has no mention of the eight enrichment columns or the snapped-GPS fields; anyone reading it to understand the CSV format won't discover enrichment exists.
