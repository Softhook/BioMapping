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

### D. Local caching of Overpass responses (shipped, not in the original plan)

`osm_cache.js` caches fetched Overpass JSON in the browser's IndexedDB, keyed by bounding box, so re-enriching tracks in the same or an overlapping area doesn't re-hit the public Overpass API. This wasn't part of the original plan (which didn't address repeat fetches at all) and was added after real usage showed the same neighbourhoods getting re-fetched across sessions.

- **Containment reuse**: a request is served entirely from cache if any stored entry's bbox fully contains it (with a small tolerance for floating-point noise), preferring the tightest-fitting match.
- **Merge-on-overlap**: on a miss, if the request only *partially* overlaps one or more cached entries (a second walk that covers mostly the same streets but extends further), the fetch is expanded to the union of the request and those entries, and the result replaces them as one merged entry — capped at 12 km² so an opportunistic merge can't balloon into an oversized request. Coverage actively grows and coalesces across tracks and sessions instead of accumulating duplicate overlapping blobs.
- **Expiry & eviction**: entries expire after 30 days (`CACHE_TTL_MS`) since OSM data changes over time, and the cache is capped at 20 entries with least-recently-used eviction.
- A "Clear Cached Map Data" button in the sidebar wipes the cache manually.

See §3D for the storage architecture and §7 for known limitations of the rectangle-union approach.

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

### D. Cache architecture (`osm_cache.js`)

The cache uses **two IndexedDB object stores**, not one: `bbox_meta` holds small records (`id`, `bbox`, `queryVersion`, `fetchedAt`, `lastAccess`) and `bbox_data` holds the corresponding — potentially several-MB — Overpass JSON payload, keyed by the same `id`. This split exists because every cache decision (does anything contain this bbox? does anything overlap it? which entry is least-recently-used?) only needs the metadata; keeping it separate from the data blobs means those decisions stay cheap to compute no matter how large the cached payloads get, instead of deserializing every cached payload on every enrich click. The actual data blob is fetched exactly once, by id, only after a specific entry has been chosen. Writes and deletes span both stores in single atomic transactions so metadata can never reference a missing blob or vice versa.

`_planFetch(bbox)` is a pure function (no IndexedDB access) that decides, given the current metadata list, whether to fetch just the requested bbox or the union of it and any overlapping entries — this and the containment-matching logic (`_pickBestMatch`) and eviction selection (`_selectEvictions`) are all pure and unit-tested directly (see §6). The `_openDb`/`_getAll`/`_get`/`_putEntry`/`_deleteEntries` IndexedDB glue around them is thin, standard wrapper code, not independently tested (Node has no IndexedDB implementation — see §6 and §7).

A schema note: the cache started as a single object store mixing metadata and data together, which was the direct cause of the "every check reads the full payload" inefficiency above — `DB_VERSION` was bumped to 2 to migrate to the split-store layout, dropping any old single-store cache on upgrade (safe, since this is a cache — losing old entries only costs a few extra network fetches, never real data).

---

## 4. UI/UX — as built

**Sidebar "Environmental Enrichment" card**: search-radius slider (25–200m, default 50m), an "Enrich Active Track" button, and a progress bar with live status messages (checking the local cache, rate-limit waits, retry counts, parse progress, and — when a partial-overlap merge is happening — how many cached areas are being merged). A "Clear Cached Map Data" button wipes the IndexedDB cache described in §2D/§3D. No latency slider here (see §3C).

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
├── osm_cache.js          - IndexedDB cache for Overpass responses: containment
│                           reuse, merge-on-overlap, TTL/LRU eviction.
├── geo_utils.js          - haversine / distance-to-segment / point-in-polygon.
├── map_match.js          - HMM/Viterbi GPS-to-road snapping (MapMatcher).
├── map_colors.js         - Color scales / LUTs for all map metrics, incl. osm_*.
├── constants.js          - GSR_CONST, including SAMPLING_RINGS/POINTS_PER_RING
│                           and the SNAP tuning block.
├── index.html            - Sidebar enrichment + GPS-snap cards, map metric
│                           dropdown, Environmental Analysis dashboard markup.
├── ui.js                 - enrichTrack() orchestration (incl. cache lookup/
│                           merge-plan/store wiring), dashboard rendering
│                           (correlation table, scatter plot, road profile),
│                           street-view modal.
├── map.js                - OSM polygon overlay rendering (drawOsmShapes).
├── analyzer.js            - osm_* column CSV parsing/export, isEnriched state.
└── tests/
    ├── test_osm_enrichment.js - OSMEnricher + MapMatcher regression suite.
    └── test_osm_cache.js      - OsmCache pure-logic regression suite.
```

The original plan didn't list `overpass_client.js`, `geo_utils.js`, `map_match.js`, or `osm_cache.js` as separate files — the actual implementation split the network client and spatial-math primitives out of the main enrichment module, added the map-matching module entirely, and later added the caching module in response to real repeat-fetch behaviour the plan never anticipated.

---

## 6. Verification — current state

The enrichment and caching pipeline now has automated regression coverage, closing what used to be the largest gap between the plan and reality:

- **`tests/test_refactor.js`** — pre-existing coverage for `geo_utils.js` (`haversineMeters`, `distanceToSegmentMeters`, `pointInPolygon`, known-distance and antipodal cases).
- **`tests/test_osm_enrichment.js`** (117 assertions) — `OSMEnricher`: bbox math and coordinate validation, geometry reconstruction (ways/relations/multipolygons), the spatial hash grid, evaluation-point selection and thinning, `_evaluatePosition`'s per-feature metrics (roads, parks, water, buildings, trees, amenities), timeline interpolation, and a full `enrichTrack()` integration run. `MapMatcher`: distance/bearing helpers, candidate generation and road-class ranking, and a full HMM-Viterbi snap on a synthetic road network.
- **`tests/test_osm_cache.js`** (50 assertions) — `OsmCache`'s decision logic: containment matching and tightest-fit selection, merge-on-overlap (union math, multi-entry merges, the oversized-union fallback), query-version and TTL filtering, and LRU eviction selection.

All of this is run via `node tests/<file>.js` — no browser or build step needed, following the existing project convention of loading the browser-global modules through `vm.runInThisContext`.

What's still **not** covered: the plan's proposed `scratch/test_spatial_math.js` was never written as such (its intent is now met by `test_osm_enrichment.js` instead, in the project's existing test-file convention rather than a standalone `scratch/` script), and `osm_cache.js`'s actual IndexedDB glue (`_openDb`, `_putEntry`, `_deleteEntries`, the `DB_VERSION` migration) is untested — Node has no IndexedDB implementation, so only the pure decision functions that logic delegates to are exercised. See Future Improvements below.

Manual verification remains necessary for: the real Overpass network path (rate-limit/retry behaviour), the IndexedDB glue itself, and end-to-end UI flows — load a track, click Enrich, watch the network tab (and confirm a *second* enrich of an overlapping area shows no network request, or a merged one for partial overlap), toggle map coloring, and check the exported CSV for the eight `osm_*` columns.

---

## 7. Future Improvements

Items 1, 2, and 4 from the original version of this list (spatial-math tests, map-matcher tests, and Overpass response caching) have since shipped — see §2D/§3D and §6. What follows is the remaining open list, plus new items that came out of building and reviewing the cache.

1. **Wire the correlation/scatter dashboard to a real latency shift.** Either reuse the existing Peak Latency Compensation slider or add a dedicated one, and apply it inside `renderCorrelationMatrix`/`drawRegressionScatterPlot` so `Environment(t)` is actually compared against `Arousal(t + latency)` rather than the current same-timestamp comparison. This was the plan's original Phase 1 headline feature and is the one clearly-scoped piece that still hasn't shipped.

2. **Extend `_evaluatePosition` with acoustic proxies.** The plan's "Traffic & Acoustic Stress" dimension is currently approximated only by `osm_road_class`/`osm_dist_major_road`. OSM has `maxspeed`, `lanes`, and `traffic_signals` tags already present in the fetched way data that aren't extracted — cheap additions that would sharpen the traffic-stress signal without a new data source.

3. **Revisit Phase 2 (NDVI/canopy) as a real offline path.** Rather than the plan's original Google Earth Engine/Sentinel Hub script, consider a one-time bulk export (e.g. clipped Sentinel-2 NDVI tiles for the region) that a small Node script in `scratch/` samples at track coordinates and appends as CSV columns the existing `analyzer.js` column-detection logic (`headers.indexOf('osm_...')`) can already pick up with minimal changes — the CSV-column plumbing for "optional enrichment columns that light up the map dropdown when present" already exists and generalizes to any future column prefix.

4. **Turn the Street View modal into an automated GVI metric.** The Mapillary/Google Street View viewer (`ui.js: openStreetView`) already fetches street-level imagery per coordinate for manual inspection. A batch mode that samples imagery at the same evaluation points used for OSM enrichment, runs a simple green-pixel-fraction classifier client-side (or via a small serverless function, since CORS/canvas tainting will block pure client-side pixel analysis of most embeds), and writes an `osm_gvi_50m`-style column would complete the plan's original Phase 3 without requiring a new UI surface.

5. **Document the `osm_*` columns (and the cache) in `docs/csv_schema.md`.** The schema doc currently has no mention of the eight enrichment columns, the snapped-GPS fields, or the fact that enrichment results are cached locally; anyone reading it to understand the CSV format won't discover any of this.

6. **Move the cache from rectangle-union to a true delta fetch, if rectangle bloat becomes a real problem.** Merge-on-overlap reasons about axis-aligned bounding boxes, not actual track shapes — two tracks whose real paths barely overlap (e.g. two long tracks crossing near their midpoints but heading in different directions) can still have bounding rectangles that overlap heavily, causing the merged fetch to cover a lot of area neither track ever visited. The 12 km² cap bounds the worst case, but doesn't eliminate the waste. A true fix means either rectangle-subtraction (fetch only the geometrically uncovered area, then merge OSM elements by their stable global IDs — deduping across fetches turns out to be straightforward since Overpass always returns a way's full geometry, not a bbox-clipped fragment) or a persistent tile-based element cache (grid the world into fixed tiles, track which are fetched, store individual OSM elements once regardless of which fetch brought them in). Both are meaningfully more complex than the current approach and are only worth it if real usage shows the rectangle-union approach fetching noticeably more than needed.

7. **The merge is single-pass, not transitive.** `planFetch` only checks what overlaps the *original* request bbox. If merging with one entry produces a union that now also overlaps a second entry that didn't overlap the original request, that second entry isn't folded in — it's picked up (if at all) by some later request. A fixed-point merge (keep re-checking for new overlaps until none remain) would converge to a cleaner cache state, at the cost of more DB round-trips per miss.

8. **No cross-tab cache coordination.** The `_enriching` re-entrancy guard in `ui.js` is an in-memory flag scoped to one page. Two browser tabs enriching overlapping areas around the same time could each independently plan and store a merge, producing two overlapping "merged" entries instead of one. Low priority for a single-user local analysis tool, but worth knowing if the analyzer is ever used with multiple tabs open side by side.

9. **Exercise `osm_cache.js`'s actual IndexedDB glue in tests.** Everything currently tested (`_bboxContains`, `_planFetch`, `_selectEvictions`, etc.) is pure logic with no IndexedDB dependency, by design — Node has none. Adding the `fake-indexeddb` npm package to the test setup would let `_openDb`, `_putEntry`, `_deleteEntries`, and the `DB_VERSION` 1→2 migration path get real regression coverage too, rather than relying on manual in-browser verification.

10. **Surface cache stats in the UI.** The "Clear Cached Map Data" button currently has no visibility into what it's about to delete — showing the number of cached areas and approximate total size next to it (a quick `bbox_meta`/`bbox_data` count and size estimate) would make the cache's behaviour less opaque.
