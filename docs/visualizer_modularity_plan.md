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
| `live/live_view.js` | 1,072 | Not a candidate | **Verdict 2026-09-14** — shell + shared session state; `mount()` long-method regroup **DONE** |
| `signal/deconvolution.js` | 1,040 | Not a candidate | Leave — one algorithm |
| `osm/osm_enrichment.js` | 1,016 | Not a candidate | Leave — one enrichment pipeline |
| `map/map_exporter.js` | 1,015 | Not a candidate | Leave — one SVG/PNG export pipeline (all `static`) |
| `render/rf_fluid_renderer.js` | 915 | Not a candidate | Leave — one rendering engine, already narrowly scoped |
| `map/globe3d_view.js` | 900 | Not a candidate | **Verdict 2026-09-14** — already self-organised via section comments; one coordinating role |
| `signal/csv_parser.js` | 819 | Not a candidate | Leave — one parse pipeline (all `static`) |
| `spatial/collective_manager.js` | 762 → 869 | Long-method case | `generateContourSurface` long-method regroup **DONE 2026-09-14** |
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

3. **`live_view.js` and `globe3d_view.js` — investigated 2026-09-14, both
   verdict "not a split candidate."** Read in full and checked against the
   decision framework; neither turned out to be the loosely-coupled feature
   pile the framework looks for.

   - **`live_view.js` (1,072 lines).** This is the SHELL left over after an
     earlier session already pulled the two genuinely independent renderers
     out (`live_graph.js`, `live_map.js` — see the file's own header
     comment). What's left is one tightly-coupled session lifecycle: BLE
     connection state machine, `feedLiveAnalyzer()`'s trailing-window
     analysis feed, the FAB menu, and `mount()`. Nearly every function
     reads/writes shared module-level `let` state (`liveAnalyzer`,
     `liveAnalyzerBase`, `lastLiveAnalyzeAt`, `bleManager`,
     `needNewConnection`, `mapVisible`, `viewActive`, the DOM element refs
     `mount()` assigns) — the same "deep shared mutable state, tightly
     sequential" shape that keeps `analyzer.js`/`ndvi_sampler.js` off the
     split list, not `ui.js`'s "several independent feature piles" shape.
     `LiveConnectionController` (~110 lines) is the one piece with a real
     boundary (its own getter/setter object over `bleManager`/
     `needNewConnection`) but still calls back into `resetSession()`/
     `attemptConnect` — not worth a file on its own.
     **`mount()` long-method regroup — DONE 2026-09-14 (follow-up
     session).** `mount()`'s ~206 lines were split into 6 named top-level
     functions, called in order from a now ~15-line `mount()`:
     `initLiveViewDom(container)` (DOM injection + element refs),
     `bindLiveStateListeners()` (fullscreen init, visibilitychange,
     `LiveState.on('status'/'packet')`), `bindLiveConnectionControls()`
     (connect/skip/connection/export buttons), `bindLiveMapControls()`
     (cache-map, toggle-map, exit-display, metric group, geolocation
     button), `bindLiveKeyboardShortcuts()` (the p/m/c window keydown
     handler), `bindLiveResizeHandling(container)` (resize/orientation/
     ResizeObserver). Kept as top-level functions reading/writing the
     existing module-level `let`s, matching `bindLiveGsrControls()`/
     `bindLiveFab()`'s pre-existing shape rather than switching to
     `events.js`'s `_bind*Controls()` object-method convention (this file
     has no `this`-bearing methods elsewhere). Bodies moved verbatim (no
     logic changes). Full suite 1321/1321 green, including
     `test_live_view_switch.js` and `tests/support/boot_live.js`, both of
     which call `GSRLiveView.mount()` directly.
   - **`globe3d_view.js` (900 lines).** One object, ~35 methods, but
     already internally organised into 8 clearly labelled sections via its
     own `// ── Section name ──` divider comments (init & wiring, scrub
     sync + peak popups, shared header controls, toggle mirroring, Cesium
     lazy load, activate/deactivate, 2D→3D data push, small UI bits) — the
     "no natural narrower home for new code" smell that justified the
     other splits doesn't apply here; there already *is* a home for each
     kind of addition. The peak-popup cluster (`_showPeakPopup`/
     `_positionPeakPopup`/`_reflowPeakPopup`/`_closePeakPopup`/
     `_editPeakLabel`, ~150 lines) is the most self-contained group and the
     closest thing to a real candidate, but unlike `map_popups.js`'s PURE
     extraction from `map.js` (no shared state, just DOM builders taking
     args), these methods read/write `GSRGlobe3DView.els`/`_popupAnchor`/
     `_popupDismiss` by the object's own bare name throughout — genuinely
     coupled to the rest of the object, not a clean lift. Fundamentally
     this file is one coordinating role (relay between the 2D map's header
     controls and the 3D engine), matching the plan's original "borderline"
     read. Left as-is; the section-comment dividers are already doing the
     organisational job a split would.

4. **`collective_manager.js` — long-method regroup DONE 2026-09-14
   (follow-up session).** `generateContourSurface` (588 of 762 lines) was
   split into 8 named private methods — `_resolveContourParams`,
   `_resolveBoundsAndTracks`, `_collectContourPoints`, `_buildContourGrid`
   (geometry helpers + the near-track mask), `_computeCoverageField`,
   `_computeValueGrid` (IDW splat + cell-fill loop, kept as one step since
   the splat's scratch arrays are read nowhere else), `_blurContourGrid`,
   `_extractContours` (upsample + percentile levels + MarchingSquares) —
   called in order from a ~30-line orchestrator. Each method's body is the
   original code block verbatim; the only real transformation was choosing
   what to thread across boundaries. Two correctness traps found and
   avoided during extraction, not just anticipated:
   - `minVal`/`maxVal` are read in **two** places — once (pre-blur) inside
     the value-grid fill loop, and again (post-blur, and after a
     near-zero-range nudge: `if (Math.abs(maxVal-minVal)<1e-9) maxVal =
     minVal+0.1`) inside the percentile-level loop. `_extractContours`
     takes the **post-nudge** `minVal`/`maxVal` as explicit parameters
     rather than re-deriving them from `sortedVals` (which would silently
     have reproduced the *pre-nudge* range and broken the near-zero-range
     guard on a flat/single-value surface).
   - `alpha` (`peakPreservation`) was moved from its original position
     (computed just before the fill loop) up into `_resolveContourParams`
     — safe because nothing between the two positions reads or writes it,
     verified by grep before moving, not assumed.

   Verified two ways, not just the Node suite: (1) full suite 1321/1321
   green (`test_collective_manager.js`, `test_collective_active_metric.js`,
   `test_masked_grid_isobands.js`, `test_hillshade.js`,
   `test_all_pipelines.js` among them); (2) a throwaway golden-output
   script (3 synthetic tracks, deterministic PRNG, 10 param combinations
   covering every branch — peaks mode, coverage on/off, all topography
   sources, softening=0 exact-match, blur/grid-size variants,
   peakPreservation blend) captured `generateContourSurface`'s full output
   (grid, upsampled grid, coverage grid, contour segments) before and after
   the refactor — **byte-identical** on every case, which the mechanical
   `globe3d.js`/`renderer.js` splits got from diffing method bodies
   directly but this one couldn't, since the code's shape genuinely
   changed.

**Headless-browser smoke pass — DONE 2026-09-15.** Playwright turned out to
already be reachable with no install/network fetch: `npx playwright` resolves
via the npx package cache, and a Chromium build was already downloaded to
`~/Library/Caches/ms-playwright`. Wrote a throwaway driver script
(`chromium.launch()` + a local `python3 -m http.server` for `visualiser/`,
since `fetch()`ing the demo CSV needs `http://`, not `file://`) that loaded
the demo track and exercised all 4 areas touched this session: single-track
graph (draw + a peak-tooltip click), 3D globe (switch + OSM-buildings toggle
+ automated tour), Collective view (contour surface), and Live view (mount).
Screenshotted every stage — all rendered correctly (peaks/hotspots/tooltip on
the 2D map, the extruded 3D arousal surface with peak spires, the Collective
contour patch, Live's clean "Connect via Bluetooth" shell). Zero console
errors traceable to any of the moved code; the sole console error seen once
(a 504 on an unspecified resource during the Live-view stage) did not
reproduce on a repeat run and is an external network fetch (map tiles/API),
not a code path this session touched.

Remaining steps are still pick-up-when-wanted, not scheduled commitments.

## Require/boot-up gotcha — root-caused and fixed (2026-09-14)

The two "lessons for the next split" logged above (free module-scope
identifiers, self-references) turned out to have a real bug hiding behind
them, found while reviewing the require-branch pattern for a cleaner fix
instead of just documenting around it again.

**Root cause:** `renderer.js`'s `module.exports` only ever contained
`{ GSRRenderer }` — never the module-level `getQualityColor`,
`getQualityLabel`, `EXCLUDED_STYLE`, `NORMAL_DASH`, `EXCLUDE_BTN` that
`renderer_chrome.js`/`renderer_markers.js`/`renderer_interaction.js`'s
require-branches assumed they could pull off it (`__rnd.getQualityColor`,
etc.) to stamp onto `global`. Each stamp silently became
`global.getQualityColor = undefined` — no error until a method that calls
`getQualityColor(...)` actually runs under plain `require()`. It was
unnoticed because **no test file plain-requires these three augments** (only
`renderer_bands.js`, whose one cross-reference — `GSRRenderer` itself — was
correctly exported). Confirmed live with a throwaway Node repro before
touching anything: `require()`-ing `renderer_chrome.js`, assigning it onto
`GSRRenderer`, and calling `getQualityColor(0.9)` threw
`ReferenceError: getQualityColor is not a function`. `globe3d.js`'s
equivalent augments (`globe3d_peaks.js`/`globe3d_tour.js`) were NOT broken —
`test_globe3d.js`'s `_computeTourWaypoints` test already exercised
`globe3d_tour.js`'s bare `seriesValue`/`HEIGHT_CAPABLE_METRICS` refs under
plain `require()`, which is exactly why that path stayed correct.

**Fix, two parts:**
1. `renderer.js` now exports every module-level name an augment reads bare:
   `module.exports = { GSRRenderer, getQualityColor, getQualityLabel, EXCLUDED_STYLE, NORMAL_DASH, EXCLUDE_BTN }`.
2. Every augment's require-branch (`renderer_bands.js`, `renderer_chrome.js`,
   `renderer_markers.js`, `renderer_interaction.js`, `globe3d_peaks.js`,
   `globe3d_tour.js`) replaced its itemized `global.X = mod.X` picks with one
   `Object.assign(global, require('./renderer.js'))` (or `./globe3d.js`).
   This is the actual architectural fix, not just the bug patch: enumerating
   names by hand is exactly the failure mode that caused this (a name used in
   the augment but missing from the picks, or missing from the core file's
   exports, fails silently either way). A blanket copy of the core file's
   entire export surface can't "forget" a name — the core file's
   `module.exports` becomes the single source of truth for what's resolvable
   bare, checked at the one place it's declared instead of re-derived by grep
   at every call site. `globe3d_osm.js`/`globe3d_rf.js`/`globe3d_toggles.js`/
   `globe3d_navigation.js` were left untouched — they reference nothing
   outside their own methods, so they carry no require-branch at all and
   don't need one pre-emptively.

New `tests/test_renderer_require_exports.js` locks this in: asserts
`renderer.js`'s exports contain every name, and that each of the four
augments' require-branch actually resolves them onto `global` — verified to
fail with the exact pre-fix `AssertionError` when the export list is
reverted, so it's a real regression guard, not a tautology. Full suite
1326/1326 green.

**Still true, unaffected by this fix:** the underlying reason two loading
conventions exist at all (`bootApp()`'s shared vm context for most tests vs.
plain `require()` for `test_globe3d.js` and the renderer band/curve tests,
which want fresh per-test module isolation `bootApp()` doesn't offer) wasn't
changed — this fix makes the dual-mode bridge between them correct and
low-maintenance, not something the codebase has migrated away from.

## Module-loading consistency: retrofitting the two earlier splits (2026-09-15)

The `renderer.js`/`globe3d.js` splits got a dual-mode tail (browser/vm live-global
assign vs. CommonJS `module.exports`, with a `require()`-branch bridge for any
bare cross-references) because `test_globe3d.js` forced the issue. The two
*earlier* splits — `map_manager_*.js` (12 files, the original precedent) and
`ui_*.js` (10 files) — never got the same treatment, because no test happened
to plain-`require()` them in isolation. Both families were still bare
`Object.assign(GSRMapManager.prototype, {...})` / `Object.assign(GSRUI, {...})`
with no guard at all — meaning neither could be `require()`'d standalone, an
inconsistency with every other augment family and a real gap, not a cosmetic
one: grepping confirmed `map_manager_peaks.js`, `map_manager_path.js`, and
eight of the ten `ui_*.js` files reference their own object bare
(`GSRMapManager._buildPeakIcon()`, `GSRUI.correlationBand()`, etc.) from inside
their own methods — exactly the self-reference shape that produced a silent
`global.X = undefined` in the `renderer.js` bug above.

All 22 files now carry the same dual-mode tail as `globe3d_*.js`/`renderer_*.js`
(`map.js`/`ui.js` as the bridge target). Bodies moved verbatim into a
`const __methods = {...}` wrapped in an IIFE — no logic changes, confirmed by
`node --check` on every file plus the diff shape (open/close lines only).
`map_manager_peaks.js` is the one exception with two `Object.assign` blocks in
the same file (prototype methods + two `GSRMapManager`-static icon builders);
a single `module.exports` can't carry two independent bridges, so it exports
`{ protoMethods, staticMethods }` instead of a flat method object — a shape
specific to that file, not a new house style, since nothing else in either
family has this split.

Fixing the guard surfaced a **real regression**, not just a gap: 7 existing
test files did a bare side-effect `require('../src/ui/ui_X.js')` relying on
the OLD unconditional `Object.assign(GSRUI, {...})` running on `require`
regardless of environment. Once the guard existed, plain `require()` took the
export branch instead, so the assignment never happened and later calls threw
`TypeError: GSRUI.someMethod is not a function`. Fixed by wrapping each site as
`Object.assign(GSRUI, require('../src/ui/ui_X.js'))`, the same convention
`test_curve_force_indices.js` etc. already use for the renderer/globe3d
augments (`test_env_dashboard_cache.js`, `test_osm_enrich_orchestration.js`,
`test_osm_ensure_geoms.js`, `test_response_dynamics.js`, `test_ndvi_sampler.js`).
One file (`test_refactored_helpers.js`) needed a different fix: its own
`loadBrowserModule()` helper loads `ui.js` via `vm.runInThisContext` + regex
source-rewriting onto `global.GSRUI`, but `ui_stats_panel.js`'s new
require-branch does its own internal `require('./ui.js')` — a SEPARATE
CommonJS-cached `GSRUI` object, distinct from the vm-loaded one, so the two
loaders fought over `global.GSRUI`. Fixed by loading `ui.js` itself via plain
`require()` at that one site too (safe — `ui.js` already fully dual-exports;
bare identifiers inside its methods still resolve at call time via the global
object either way). A fourth, unrelated custom harness
(`test_map_viewport_deferred_fit.js`, a hand-rolled `vm.createContext({module:
{exports:{}}, GSRMapManager: stub})` sandbox) broke differently: it had always
provided a dummy `module` object, which used to be inert but now satisfies the
guard's `if` branch and crashes on the missing `global`/`require` that branch
assumes — fixed by dropping `module` from that sandbox so the else-branch
(the one this harness actually wants) runs, matching its own header comment's
intent.

Two smaller gaps in the same "does every file support plain `require()`"
audit, unrelated to the augment-file guard: `gsr_filter.js` had **no** export
block at all (not even the old unconditional pattern) — fixed with the
standard `module.exports` / `window.X` dual tail matching every sibling in
`src/signal/`. `map_exporter.js` had an unconditional `window.GSRMapExporter =
...` that would throw under plain Node (no `window` global) were it not for
call sites pre-setting `global.window = global` — fixed the same way, which
also let `test_map_exporter_geometry.js` drop its own vm/regex workaround
(stale comment and all) for a plain `require()`.

New `tests/test_map_ui_augment_require_exports.js` (24 tests) locks in the
`map_manager_*.js`/`ui_*.js` fix the same way `test_renderer_require_exports.js`
locked in the `renderer.js` one: exercises every augment's require-branch
directly, asserting the core class/object lands on `global` and every
exported member actually attaches — so the same bug class fails here instead
of waiting for the next ad hoc plain-`require()` test to trip over a
`ReferenceError`. Full suite 1345/1345 green throughout; headless-browser
smoke pass not re-run this session (no production runtime-path code changed —
every touched file's browser/vm else-branch is byte-identical to what it
replaced, so the existing 2026-09-15 smoke pass still covers it).

**Code-review pass (2026-09-15), no bugs found.** Full trace of the
dual-mode pattern across all 22 converted files, cross-checked against this
section's own claims, plus a clean suite run. Two fragility/maintenance
observations, deliberately left as-is rather than fixed, since the ES-modules
migration above removes this whole pattern (tail included) whenever it
happens — fixing it now would be throwaway work:
- `typeof module !== 'undefined' && module.exports` is a fragile proxy for
  "am I under Node's `require()`" — it already misfired once in this diff
  (`test_map_viewport_deferred_fit.js`'s vm sandbox stubbed a `module` object
  for an unrelated reason, which took the wrong branch and crashed; fixed by
  dropping `module` from that one sandbox). Any future test reusing a generic
  vm sandbox that happens to include a `module` stub could hit the same thing.
- The 12-line dual-mode tail is now duplicated verbatim across 23+ files
  (12 `map_manager_*.js`, 10 `ui_*.js`, plus the pre-existing
  `renderer_*`/`globe3d_*` files) with no shared helper — a maintenance cost
  if the bridging convention needs another fix before the ES-modules
  migration lands.

**Not done, left as a follow-up:** a *third* test-loading convention still
exists alongside `bootApp()` and plain `require()` — half a dozen test files
(`test_env_dashboard_cache.js`, `test_ndvi_sampler.js`,
`test_isoband_boundary_closure.js` among them) hand-roll their own
`vm.runInThisContext` + regex source-rewrite loader for files that, as of this
session, all now support plain `require()` cleanly. Collapsing those onto
`require()` would remove a whole bespoke mechanism, but touching each site
means re-verifying every one of that file's other loaded dependencies too —
larger and separately-risked from this session's fix, not attempted here.

## Bigger follow-up (wanted, not scheduled): drop dual-mode for real ES modules

The dual-mode tail every augment file now carries (`if (typeof module !==
'undefined' ...) { ...CommonJS... } else { ...stamp onto the shared browser/vm
global... }`) is a workaround, not a design the codebase is aiming for. It
exists because the app loads as ~70 plain `<script src="...">` tags in
`index.html` with no build step (all files share one implicit global scope),
while the test suite wants to `require()` a single file in isolation (Node's
CommonJS gives each file its own private scope, nothing shared unless
exported) — two different sharing mechanisms, so every multi-file class/object
has to ask "which one am I in?" at load time. This session made the pattern
*consistent* across all four topic-file-split families; it didn't remove the
need for it.

The real fix is native ES modules (`import`/`export`) — supported directly by
both modern browsers (`<script type="module">`) and Node, with no `global`
stamping, no `typeof module !== 'undefined'` branching, and explicit
import/export instead of implicit shared scope. The user has confirmed this
is wanted, but explicitly **not now** — it's a much larger migration than
today's session: it would touch every one of the ~70 source files' load/export
tails, `index.html`'s script list, `boot_app.js`'s `SCRIPT_ORDER` +
`vm.createContext` approach (module scripts don't execute via `vm.runInContext`
the same way), and every test file's loader (`require()`, `bootApp()`, and the
half-dozen custom `vm`/regex loaders above all need re-deriving for module
semantics). Scope it properly as its own session before starting — don't fold
it into an unrelated change.

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
