# Visualiser modularity: where the god-object split pattern applies, and where it doesn't

## Context

`ui.js`'s `GSRUI` object had grown to 2,913 lines by mixing at least seven
unrelated UI concerns — the peaks table, the stats panel, OSM overlay sync,
the correlation table, the road-profile table, the environmental dashboard,
the street-view modal, the export-preset modal — in one namespace. It was
split (2026-09-14) into a 210-line core plus 10 topic files
(`ui_peaks_table.js`, `ui_stats_panel.js`, `ui_collective_map.js`,
`ui_export.js`, `ui_osm_overlay.js`, `ui_enrichment.js`,
`ui_correlation_table.js`, `ui_road_profile.js`,
`ui_environmental_dashboard.js`, `ui_modals.js`), each doing
`Object.assign(GSRUI, { ...methods... })` — the exact pattern already
established for `GSRMapManager` (`src/map/map.js`, split into 13
`map_manager_*.js` files). `events.js`'s 640-line `setupEventListeners()`
was regrouped the same session into 8 named `_bind*Controls()` methods
(same file, no split — see below for why that distinction matters).

The user asked whether this approach should be adopted across the rest of
the visualiser. This document surveys the remaining large files, answers
that per file with evidence (not just line count), and lays out a plan for
the ones worth doing. **Answer: selectively, not wholesale.** The pattern
is a real fix for a real problem (unrelated features sharing one namespace),
but most of the visualiser's other large files are large for a different
reason — one complex, internally-coupled algorithm or rendering pipeline —
where the same split would scatter one coherent thing across files without
making it any easier to reason about, and would add real risk. Prove the
shape actually matches (method-name clustering, not just line count)
before committing to any move — several files here look similar to
`ui.js` by size alone but aren't once you look at what the methods
actually do.

## Decision framework

Before splitting any file, classify it. Line count alone says nothing —
`ui.js` and `analyzer.js` were both ~2,900 lines; only one was a god-object.

**Split candidate** — the top-level object/class holds several **loosely-coupled
feature groups**, each independently understandable, sharing only a thin
piece of instance state (or none). Symptoms:
- Method names cluster into disjoint topics with no shared private helpers
  between clusters (peaks-table methods never call correlation-table
  methods).
- You could delete one cluster's methods and the rest of the file would
  still make sense on its own.
- New features get added as "one more method on the pile" because there's
  no natural narrower home for them.

**Not a split candidate** — the file is large because it implements **one
pipeline or one rendering surface**, where stages/methods are tightly
sequential or share deep mutable state (caches, memoized prefixes, entity
collections). Symptoms:
- Most methods are `_private` helpers called from one or two public entry
  points, not independent features.
- Splitting would require either duplicating shared state across files or
  inventing a new cross-file state-sharing mechanism this codebase doesn't
  otherwise use — pure code motion stops being possible.
- The actual complexity is algorithmic (a physics/DSP/geometry pipeline),
  not organisational.

A third, distinct case — **one method is just very long** — isn't a
multi-file question at all. The fix is extracting named private steps
within the same file (what happened to `events.js`'s
`setupEventListeners()`, and what `_detectPeaksByProminence` etc. already
do in `analyzer.js`), not a topic-file split.

## Survey

Current sizes (`find src -name '*.js' | xargs wc -l`, top of the list) and
classification:

| File | Lines | Class | Verdict |
|---|---:|---|---|
| `map/globe3d.js` | 2,917 → 1,768 | Split candidate | **DONE 2026-09-14** |
| `signal/analyzer.js` | 2,803 | Not a candidate | Leave — one memoized pipeline |
| `render/renderer.js` | 1,757 → 99 | Split candidate | **DONE 2026-09-14** |
| `osm/ndvi_sampler.js` | 1,424 | Not a candidate | Leave — one fetch/decode/sample pipeline |
| `live/live_view.js` | 1,072 | Ambiguous | Investigate only, not now |
| `signal/deconvolution.js` | 1,040 | Not a candidate | Leave — one algorithm |
| `osm/osm_enrichment.js` | 1,016 | Not a candidate | Leave — one enrichment pipeline |
| `map/map_exporter.js` | 1,015 | Not a candidate | Leave — one SVG/PNG export pipeline (all `static`) |
| `render/rf_fluid_renderer.js` | 915 | Not a candidate | Leave — one rendering engine, already narrowly scoped |
| `map/globe3d_view.js` | 900 | Ambiguous | Investigate only, not now |
| `signal/csv_parser.js` | 819 | Not a candidate | Leave — one parse pipeline (all `static`) |
| `spatial/collective_manager.js` | 762 | Long-method case | `generateContourSurface` could gain named internal steps; not a file split |
| `ui/tracks.js` | 641 | Not a candidate | Leave — cohesive "track library" domain, not disjoint features |
| `signal/cvxeda.js` | 624 | Not a candidate | Leave — effectively one function (`decompose`) |

### Why `globe3d.js` is the strongest remaining candidate

`GSRGlobeManager` has 79 methods clustering into: camera/viewer setup,
OSM-building extrusion, RF expanse rendering, scrub/follow, track wall+path
rendering, peak spires, hotspots, cluster blobs, metric-series caching,
visibility toggles, entity clearing, fly-to/focus, and an automated tour.
This is structurally the same shape `GSRMapManager` was *before* its
13-file split — same job (one interactive rendering surface), same pattern
of loosely-coupled feature groups (peaks/hotspots/OSM/RF/toggles/tour) each
addable or removable independently. The split that already worked for the
2D map is the direct precedent for its 3D counterpart.

Real complication, not a blocker: some state is genuinely shared across
clusters (the Cesium `viewer`, entity collections, `_getMetricSeries`
cache, render-loop wake/sleep). `map_manager_*.js` solved the equivalent
problem by keeping shared low-level primitives (`_buildOverlapCells` etc.)
as statics on the base class and only moving well-bounded feature groups to
`.prototype`-augment files — the same recipe applies: `globe3d.js` keeps
the constructor, viewer/camera setup, and the shared caches; peak spires,
hotspots, cluster blobs, RF expanse, OSM buildings, and the tour each
become their own `GSRGlobeManager.prototype`-augment file.

### Why `renderer.js` is the second candidate

`GSRRenderer` has 49 methods clustering into: OSM/NDVI/EM-Fog background
bands, grid drawing, signal-curve drawing, peak markers + pulse animation,
hotspot markers, click/hit-testing, scrub handling, and tooltip/timeline
overview. Same shape again — one canvas, several independently-addable
draw features. Lower priority than `globe3d.js` only because it's smaller
(1,757 vs 2,917 lines) and touched less often.

### Why the "not a candidate" files should stay as they are

Each of `analyzer.js`, `ndvi_sampler.js`, `deconvolution.js`,
`osm_enrichment.js`, `map_exporter.js`, `rf_fluid_renderer.js`,
`csv_parser.js`, `tracks.js`, and `cvxeda.js` is long because it does one
thing with many small private steps, not because several things share a
namespace. `analyzer.js` in particular has a memoized multi-stage prefix
cache (`_ensureSeriesPool`, the filter+decomposition memoisation keyed on
params) that every peak-detection method reads from — splitting it would
either duplicate that cache's invalidation logic across files or force a
new cross-file state-sharing convention this codebase doesn't use anywhere
else. The size is the cost of the domain (DSP, geometry, tile math), not a
maintainability defect the way `GSRUI` was.

### Ambiguous — investigate before deciding

- **`live_view.js`** (1,072 lines, actually two objects —
  `LiveConnectionController` + `GSRLiveView`) already sits alongside
  `live_bluetooth.js` and `live_map.js`, suggesting some splitting
  attention already happened here. Needs a closer read before a verdict;
  don't assume it's a candidate just because of size.
- **`globe3d_view.js`** (900 lines) is the coordination layer between app
  state and `GSRGlobeManager` (toggle/RF/colour-metric relay, peak-popup
  UI, lifecycle, legend/attribution). It's multi-concern but all in
  service of one coordinating role — borderline. Lower priority than
  `globe3d.js` itself; revisit after that split, since splitting
  `globe3d.js` first may change what `globe3d_view.js` needs to call.

## Plan

Sequence by value/risk, one file at a time, each independently verifiable
via the existing test suite (currently 1,321 Node tests) plus a headless-
browser smoke pass exercising the moved features — the same two-step
verification used for the `ui.js`/`events.js` work:

1. **`globe3d.js` split — DONE 2026-09-14** (commit `f7fa793`). Landed
   exactly as proposed: `globe3d.js` (2,917 → 1,768 lines: constructor,
   viewer/camera setup, wall+path rendering, scrub/interaction, shared
   `_getMetricSeries` cache — it turned out to be read from 3 of the 6
   moved groups, not just peaks, so it stayed core rather than moving to
   `globe3d_peaks.js` as first guessed), `globe3d_peaks.js` (419: spires,
   hotspots, cluster blobs), `globe3d_osm.js` (161: building extrusion
   orchestration — the geometry itself already lived in
   `globe3d/buildings.js` from an earlier session), `globe3d_rf.js` (73:
   RF expanse orchestration, same story re `globe3d/rf_expanse.js`),
   `globe3d_toggles.js` (151: visibility toggles + entity clearing),
   `globe3d_navigation.js` (228: fly-to/focus/orbit), `globe3d_tour.js`
   (310: automated sequential tour). Every method body verified
   byte-identical by script (line-range diff against the original; only
   trailing commas added). Full Node suite green throughout (1,321/1,321);
   the headless-browser smoke pass was **not** run this session (no
   Playwright/Puppeteer installed, would need a network fetch to add it) —
   flagged as a gap below rather than skipped silently.

   Two real complications found during extraction, worth remembering for
   the next split:
   - **`test_globe3d.js` breaks a plain-`require()` unit-test harness.**
     Unlike every `map_manager_*.js` test (which only exercise
     `GSRMapManager` via `bootApp()`'s shared vm context, where top-level
     `class`/`const` persist across separate `vm.runInContext` calls —
     confirmed experimentally), `test_globe3d.js` does a bare Node
     `require(globe3d.js)` per test for fine-grained isolation. A plain
     `require()` gives each file its own module scope, so the augment
     files' `Object.assign(GSRGlobeManager.prototype, {...})` had nothing
     to attach to. Fix: the augment files went dual-mode (mirroring
     globe3d.js's own tail) — live-global assign in the browser/vm path,
     `module.exports = methods` under CommonJS — and
     `test_globe3d.js`/`tests/manual/_bench_globe3d_perf.js` (also a plain
     `require()` site) now apply all 6 after loading the core module. Any
     future split of a class with its own plain-`require()` test file
     needs this same treatment, not just the `bootApp()` convention.
   - **Free module-scope identifiers, not just `this.*` methods, cross
     group boundaries.** `HEIGHT_CAPABLE_METRICS` (peaks) and `seriesValue`
     (tour) are top-level `const`s in globe3d.js referenced by bare name
     from the moved method bodies. In the vm/browser path they resolve
     fine (same persistence mechanism as the class itself). Under
     `require()` they don't — fixed by stamping them onto `global` in the
     augment file's require-branch only (never declaring a same-named
     local, which would TDZ-shadow the vm-path binding). Grep every
     module-level `const`/function a moved method references, not just
     grep the method names — this class of bug produces no syntax error,
     only a runtime `ReferenceError` on the first real invocation, so
     `node --check` alone won't catch it.

2. **`renderer.js` split — DONE 2026-09-14** (same session, commit
   pending). `GSRRenderer` turned out to be a plain object literal (like
   `GSRUI`), not a `class` — so the split follows the `ui_*.js`
   object-augment precedent (`Object.assign(GSRRenderer, {...})`, no
   `.prototype`), not the `map_manager_*.js`/`globe3d_*.js` class-prototype
   one. Landed as: `renderer.js` (1,757 → 99 lines: `getThemeColor`,
   `clearThemeCache`, `drawPlaceholder`, plus the module-level
   `getQualityColor`/`getQualityLabel`/`EXCLUDED_STYLE`/`NORMAL_DASH`/
   `EXCLUDE_BTN` every group reads from), `renderer_bands.js` (323: OSM/
   NDVI/EM-fog background context bands), `renderer_curve.js` (324: signal
   curve, phasic area, response-dynamics overlay), `renderer_markers.js`
   (455: peak markers + pulse animation, hotspot markers),
   `renderer_interaction.js` (354: click/hit-testing, graph-scrub hover),
   `renderer_chrome.js` (369: grid, tooltip, timeline overview). Every
   method body verified byte-identical by script, same as `globe3d.js`.

   This split hit **both** lessons the `globe3d.js` split had just
   surfaced, confirming they generalise rather than being one-offs:
   - **4 more plain-`require()` test files** (`test_curve_force_indices.js`,
     `test_emfog_graph_bands.js`, `test_ndvi_graph_bands.js`,
     `test_osm_graph_bands.js`) needed the same dual-mode augment-file
     treatment + an explicit `Object.assign(GSRRenderer, require(...))` in
     each test file after its own `require('../src/render/renderer.js')`.
   - **A new variant of the free-identifier problem:** two methods
     (`_classifyOsmContext` in the bands group, `handleScrubber` in the
     interaction group) referenced the shared singleton **by its own bare
     name** (`GSRRenderer.PARK_EDGE_TOLERANCE_M`, `GSRRenderer.drawTooltip(...)`)
     instead of `this.` — a self-reference / cross-group call written as if
     `GSRRenderer` were a module-level global, which it effectively is in
     the browser/vm path. Same fix as `HEIGHT_CAPABLE_METRICS`: stamp
     `GSRRenderer` itself onto `global` in the affected augment files'
     require-branch. **Lesson for the next split:** grep every moved method
     for the class/object's own name used as a bare identifier, not just
     for genuinely-external module-level consts — a `this`-less
     self-reference is easy to miss by eye and produces no syntax error,
     only a `ReferenceError` on first real call (this one was caught by the
     existing `test_osm_graph_bands.js` "Park edge tolerance" test, not by
     `node --check`).

3. **`live_view.js` and `globe3d_view.js`**: read in full, apply the
   decision framework above, only split if they turn out to genuinely be
   loosely-coupled feature piles rather than one coordinating role.
4. **`collective_manager.js`**: not a file split — if `generateContourSurface`
   is revisited, extract named private steps within the file (same pattern
   as `events.js`'s `setupEventListeners()`), not a topic-file split.

**Open gap:** no headless-browser smoke pass has verified either the
`globe3d.js` split (3D tab, peak click, tour, OSM buildings toggle) or the
`renderer.js` split (main graph draw, hotspot/peak click, tooltip, timeline
scrub) in an actual running page — only the Node test suite, for both. Worth
doing together if a Playwright/Puppeteer setup becomes available.

Remaining steps are still pick-up-when-wanted, not scheduled commitments.

## Verification, every step

1. `cd visualiser && npm test` — full suite must stay green.
2. Headless-browser pass (Playwright, no project skill for this yet —
   `run` skill's generic `chromium.launch()` fallback was used for the
   `ui.js`/`events.js` work) loading the demo track and exercising one
   control per moved feature, checking `console --errors` is empty.
3. For any split, before writing files: grep the target for plain (non-method)
   properties and for locally-defined helper functions/variables used across
   your proposed group boundaries — both caused real fixes during the
   `ui.js`/`events.js` split and will recur here.
