# BioMapping Codebase — Refactoring Roadmap

> **Scope**: All ~55,000 lines of source code across `visualiser/src/`  
> **Date**: 2026-09-27  
> **Method**: Parallel deep static analysis across all 5 subsystems

---

## Five Root-Cause Anti-Patterns

Every maintainability, performance, and testability issue traces back to one of these:

1. **God Objects** — files of 1,000–2,300 lines doing 5–8 unrelated things
2. **Trampoline Inheritance** — artificial 10–13-class inheritance chains masquerading as modularity
3. **Object-Spread Mega-Objects** — `GSRUI`, `GSREvents`, and `GSRRenderer` flatten many modules into one namespace with hidden `this` coupling
4. **DOM as State Store** — `<input>` elements are the primary database for settings; no clean settings model
5. **Logic Duplication** — the same math (Haversine, bbox, backoff, detector mutex, hotspot percentile) is re-implemented in 3–6 places

---

## Phase 1 — Zero-Risk Hygiene ✅

> Safe, surgical fixes with near-zero regression risk. No behaviour changes.

| # | Change | File(s) | Status |
|---|---|---|---|
| 1 | Fix `spectral_eda.mjs` FFT buffer overflow — dynamic `nfft = nextPowerOfTwo(nperseg)` | `signal/spectral_eda.mjs` | ✅ Done |
| 2 | Fix `em_fog.mjs` division-by-zero when `floor === SATURATION_CEILING_DBM` | `signal/em_fog.mjs` | ✅ Done |
| 3 | Fix `calculateStats` — return honest `std: 0`; guard z-score call-sites | `signal/stats_math.mjs`, `signal/gsr_filter.mjs`, `signal/analyzer_stats.mjs` | ✅ Done |
| 4 | Consolidate `SUB_GHZ_BANDS` — export from `em_fog.mjs`, import everywhere | `signal/em_fog.mjs`, `signal/csv_parser.mjs`, `signal/analyzer_export.mjs` | ✅ Done |
| 5 | Remove duplicated `fmtMaxSpeed` from `events.mjs` (canonical version in `events_slider_defs.mjs`) | `ui/events.mjs`, `ui/events_slider_defs.mjs` | ✅ Done |
| 6 | Centralize detector precedence into `normalizeDetectorCheckboxes()` (UI layer, exported from `storage.mjs`). `events_gsr_analysis.mjs` keeps its own last-clicked-wins rule on purpose | `ui/storage.mjs`, `ui/tracks.mjs` | ✅ Done |
| 7 | Replace all `alert()` calls with `GSRNotices.report()` / `.warn()` (success messages use an info `dialog()`) | 11 files | ✅ Done |
| 8 | Fix sticky-failure `OsmCache` DB promise — clear on rejection so retries work | `osm/osm_cache.mjs` | ✅ Done |
| 9 | Hoist `lowerGridPresets` outside `draw()` in `sketch.mjs` — stop 60fps allocation | `render/sketch.mjs` | ✅ Done |

---

## Phase 2 — Boundary Enforcement

> Extract domain logic that has leaked into the wrong layer. Medium risk, guided by tests.

| # | Change | File(s) | Status |
|---|---|---|---|
| 10 | Move `_haversineMeters` from `analyzer.mjs` → use `GeoUtils.haversineMeters` | `signal/analyzer.mjs` | ✅ Done |
| 11 | Move `_interpolateGPS` from `csv_parser.mjs` → `gps_pipeline.mjs` | `signal/csv_parser.mjs`, `gps/gps_pipeline.mjs` | Investigate — the parser's linear gap-fill and the pipeline's Hermite rebuild overlap; A/B test before moving |
| 12 | Move `_detectRfPeakIndices` from `csv_parser.mjs` → separate RF pipeline | `signal/csv_parser.mjs` | ✅ Done — now `signal/rf_peaks.mjs` |
| 13 | Move `getHeadingAtPeak` from `map_popups.mjs` → `GeoUtils` | `map/map_popups.mjs`, `gps/geo_utils.mjs` | Skipped — already uses `GeoUtils.bearingDeg`; the rest reads analyzer data |
| 14 | Move `resolveLatencyIndex` from `map_markers.mjs` → `GSRAnalyzer` or `GpsTiming` | `map/map_markers.mjs` | ✅ Done — analyzer method used directly; fallback copies removed |
| 15 | Move `_buildOverlapCells` from `map_base.mjs` → `path_overlap_pooler.mjs` | `map/map_base.mjs` | Optional — cosmetic move |
| 16 | Move `_buildDisplayCache` from `analyzer.mjs` → UI view-model adapter | `signal/analyzer.mjs` | Skipped — analyzer computing ranges of its own series |
| 17 | Move OSM building fetch from `globe3d_view.mjs` → `OSMEnricher` / `OsmBuildingService` | `map/globe3d_view.mjs`, `osm/osm_enrichment.mjs` | Skipped — claim wrong: no HTTP in `globe3d_view.mjs`, it goes through `OsmCache` |
| 18 | Move `_showRestoreFsPill` from `tracks.mjs` → `core/fullscreen.mjs` | `ui/tracks.mjs`, `core/fullscreen.mjs` | Optional — cosmetic move |
| 19 | Remove DOM manipulation and `click()` simulation from `collective_project.mjs` | `spatial/collective_project.mjs` | Skipped — clicking the view button reuses the tested mode-switch path |
| 20 | Eliminate per-point `.bind()` in `osm_enrichment._evaluatePosition` | `osm/osm_enrichment.mjs` | Skipped — no measurable cost |

---

## Phase 3 — Decompose God Objects

> Break up the largest monoliths into single-responsibility units. High impact, requires care.

| # | Change | Files |
|---|---|---|
| 21 | Extract `HotspotCurator` from `GSRAnalyzer` — geo math + memorable event selection | `signal/analyzer.mjs` |
| 22 | Extract `SeriesBufferPool` from `GSRAnalyzer` — all 14 cache/pool fields + invalidation | `signal/analyzer.mjs` |
| 23 | Extract `AnalysisPipelineOrchestrator` — coordinate the 5-stage pipeline cleanly | `signal/analyzer.mjs` |
| 24 | Extract `CsvMetadataParser` and `GpsInterpolator` from `csv_parser.mjs` | `signal/csv_parser.mjs` |
| 25 | Extract `NnLasso` solver from `deconvolution.mjs` into `signal/math/nn_lasso.mjs` | `signal/deconvolution.mjs` |
| 26 | Extract `TiffDecoder` from `ndvi_sampler.mjs` (116 lines, fully self-contained) | `osm/ndvi_sampler.mjs` |
| 27 | Extract `NdviTileClient`, merge Mercator math into `GeoUtils`, share `HttpRetryClient` | `osm/ndvi_sampler.mjs`, `osm/overpass_client.mjs` |
| 28 | Extract `GpsMapMatcher` and `OsmGeometryReconstructor` from `osm_enrichment.mjs` | `osm/osm_enrichment.mjs` |
| 29 | Extract `LiveBleService`, `LiveSignalProcessor`, `LiveSession` from `live_view.mjs` | `live/live_view.mjs` |
| 30 | Split `tracks.mjs` → `track_manager.mjs`, `track_loader.mjs`, `ui_track_list.mjs` | `ui/tracks.mjs` |
| 31 | Decompose `sketch.draw()` into `_computeLayout()`, `_resolveValueRanges()`, `_drawAxes()`, `_drawCurves()`, `_drawMarkers()` | `render/sketch.mjs` |
| 32 | Split `rf_fluid_renderer.mjs` → `RFRaycastSimulator` + SVG exporter adapter | `render/rf_fluid_renderer.mjs` |

---

## Phase 4 — Structural Modernization

> Hardest changes — requires agreed design patterns before implementation.

| # | Change | Files |
|---|---|---|
| 33 | Dismantle 13-tier 2D map inheritance chain → composite `GSRMapManager` with typed service delegates | `map/map*.mjs`, `map/manager/*.mjs` |
| 34 | Dismantle 10-tier 3D globe inheritance chain → `CesiumViewportManager`, `WallGeometryBuilder`, `CesiumRenderScheduler`, `CesiumScrubController` | `map/globe3d/*.mjs` |
| 35 | Replace spread aggregators (`GSRUI`, `GSREvents`, `GSRRenderer`) with explicit namespaced composition — eliminate `window.GSRUI` and inline `onclick=` HTML | `ui/ui.mjs`, `ui/events.mjs`, `render/renderer.mjs` |
| 36 | Introduce `SettingsState` — clean plain-object model; DOM inputs reflect state rather than being the state | `ui/storage.mjs`, `core/app_state.mjs` |
| 37 | Consolidate IIR filter infrastructure — unify `gsr_filter.mjs` biquad with `spectral_eda.mjs` SOS engine | `signal/gsr_filter.mjs`, `signal/spectral_eda.mjs` |
| 38 | Event-driven analysis pipeline — emit `AppState.emit('analysisCompleted')`, retire the 8-call imperative update cascade | `ui/ui.mjs`, `core/app_state.mjs` |

---

## Quick-Win Cheat Sheet

| Change | File | Effort | Risk |
|---|---|---|---|
| Fix `nfft` overflow | `spectral_eda.mjs` | 1 line | 🟢 None |
| Fix `em_fog` div/0 | `em_fog.mjs` | 1 line | 🟢 None |
| Hoist `lowerGridPresets` | `sketch.mjs` | 1 move | 🟢 None |
| Remove `alert()` → `GSRNotices` | 9 files | ~25 lines | 🟢 None |
| Delete duplicate `fmtMaxSpeed` | `events.mjs` | 4 lines delete | 🟢 None |
| Fix `_dbPromise` sticky failure | `osm_cache.mjs` | 2 lines | 🟢 None |
| Fix `calculateStats std:1` | `stats_math.mjs` | 1 line + guards | 🟡 Low |
| Centralize `SUB_GHZ_BANDS` | 3 files | ~30 lines | 🟡 Low |
| Centralize detector mutex | 3 files → 1 fn | ~60 lines | 🟡 Low |
| Extract `TiffDecoder` | `ndvi_sampler.mjs` | Move 116 lines | 🟡 Low |

---

## What's Already Good

- **Algorithm correctness**: DSP implementations (cvxEDA, SparsEDA, Linkwitz-Riley, Posada-Quintero EDASymp, Benedek & Kaernbach deconvolution) are state-of-the-art and well-referenced.
- **Comment quality**: Most modules document *why*, not just *what*.
- **Module extraction trend**: `analyzer_stats.mjs`, `analyzer_export.mjs`, `renderer_bands.mjs`, `events_gsr_analysis.mjs` show the right direction. The spread-aggregator is an intermediate step.
- **`AppState` events stub**: `on()`/`emit()` in `app_state.mjs` is the foundation for Phase 4's event-driven pipeline.
- **Test coverage**: ~100 test files provide a regression harness for refactoring.
- **`GSR_CONST`**: Centralised constants file in place — magic numbers just need to migrate into it.
