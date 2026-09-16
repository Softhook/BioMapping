# Visualiser architecture review (post-ESM-migration)

Snapshot taken 2026-09-16, after the ESM migration (`docs/archive/...esm...`
work, completed 2026-09-15) and the `visualizer_modularity_plan.md` god-object
splits. Answers: is the current `visualiser/src/**/*.mjs` structure coherent,
and what (if anything) is worth doing next.

## Verdict

Mostly coherent. The domain-folder split (`core/ gps/ live/ map/ osm/ render/
signal/ spatial/ ui/`) holds up, and the lower layers are genuinely clean:
`signal/`, `gps/`, and `osm/` have no DOM/`window`/`ui` references — verified
by grep, not assumed. Prior extractions (`csv_parser.mjs`, `deconvolution.mjs`,
`cvxeda.mjs`, `dwt_filter.mjs`, `analyzer_time_format.mjs`,
`response_dynamics.mjs`) are real delegations, not duplicated logic —
`analyzer.mjs`'s `parseCSV`/`formatClockTime`/etc. are thin wrappers that call
into them. Full suite: 1320 tests, green.

Two things still drag, both already flagged as "planned, not done" in prior
project notes.

## 1. Two god-objects remain

| File | Lines | Members |
|---|---:|---:|
| `signal/analyzer.mjs` (`GSRAnalyzer`) | 3358 | 47 methods |
| `ui/events.mjs` (`GSREvents`) | 1895 | 32 methods |

`analyzer.mjs` still carries three separate peak-detection algorithms
(`_detectPeaksFromCurve`, `_detectPeaksByProminence` +
`_topographicProminence` + `_prominenceNMS`, `_detectPeaksFullScan`), a
quality-scoring cluster (`_computePeakQuality`, `_computeDeconPeakQuality`,
`_computeSalienceScore`, `_computeEDASymp`, `_computeNoiseFloor`), and a
stats/export cluster (`getStats`, `exportToCSV`, `computeTemporalPeakDensity`,
`computePhasicAUC`, `computeCombinedArousalIndex`, `computeTriIndex`) inline —
all candidates for the exact delegation pattern already proven in this same
file for CSV parsing and time formatting.

`events.mjs` is already internally organised into named `_bind*Controls()`
methods (`_bindGsrAnalysisControls`, `_bindTimelineControls`,
`_bindFileAndExportControls`, `_bindGpsControls`, `_bindMapPanelControls`,
`_bindPresetControls`, `_bindEnrichmentControls`,
`_bindEnvironmentalDashboardControls`, plus `bindViewSwitcher`,
`bindMobileSidebar`, `bindSurfaceSwitcher`) — the seams for a split are
already drawn, it just hasn't been cut into files yet.

## 2. Legacy prototype-patching composition, and the circular-import clique it causes

`app_entry.mjs`'s own header comment confirms the pattern: many "part" files
exist only to run `Object.assign(GSRMapManager.prototype, __methods)` (10
files: `map_manager_*.mjs`) or `Object.assign(GSRGlobeManager.prototype,
__methods)` (6 files flat in `src/map/`, plus 3 more properly nested under
`src/map/globe3d/`) onto a shared singleton class. This is the same
composition idiom the pre-ESM `<script>`-tag era used (see
`visualizer_modularity_plan.md`'s "dual-mode tail" history) and it survived
the ESM migration unchanged in shape.

Running `npx madge --circular src/app_entry.mjs` found **21 circular-import
chains**, all rooted in one mutually-referential clique:

```
ui/ui.mjs ↔ ui/events.mjs ↔ ui/tracks.mjs ↔ spatial/collective_project.mjs
    ↔ map/map_popups.mjs ↔ map/globe3d_view.mjs ↔ render/sketch.mjs
```

Confirmed by reading the imports directly — `ui.mjs`, `events.mjs`,
`tracks.mjs`, and `collective_project.mjs` all import each other:

- `collective_project.mjs` imports `GSREvents`, `GSRTrackManager`, `GSRUI`
- `ui.mjs` imports `GSRCollectiveProject`, `GSREvents`, `GSRTrackManager`
- `events.mjs` imports `GSRUI`, `GSRTrackManager`, `GSRCollectiveProject`,
  plus `live/live_view.mjs`, `map/globe3d_view.mjs`, `map/map_exporter.mjs`,
  `render/sketch.mjs`
- `tracks.mjs` imports `GSREvents`, `GSRUI`, `GSRCollectiveProject`, plus
  `map/globe3d_view.mjs`, `render/sketch.mjs`

This isn't breaking anything today — ES module live bindings tolerate cycles
as long as nothing is called at module-eval time, and the full test suite is
green — but it means that seven-file clique can't be understood or extended
one file at a time; touching any one of them means holding most of the
others in your head. It's also why `app_entry.mjs` needs a manually-ordered
93-file import list (guarded only by `tests/test_script_order.js` checking it
against `boot_app.js`'s `SCRIPT_ORDER`).

Everything below the UI/orchestration layer (`signal/`, `gps/`, `osm/`) is
free of this — the cycle is confined to the app's wiring layer, not a
property of the whole codebase.

## 3. Minor inconsistency: `src/map/` nesting

`src/map/globe3d/` exists as a subfolder (`buildings.mjs`, `exporters.mjs`,
`rf_expanse.mjs`) but 6 sibling `globe3d_*.mjs` files
(`globe3d_navigation.mjs`, `globe3d_osm.mjs`, `globe3d_peaks.mjs`,
`globe3d_rf.mjs`, `globe3d_toggles.mjs`, `globe3d_tour.mjs`, plus
`globe3d.mjs` and `globe3d_view.mjs` themselves) sit flat in `src/map/`
instead. `src/map/` also holds all 10 `map_manager_*.mjs` files flat — 28
files in one directory total.

## Recommendations, ranked by payoff/risk

1. **Shrink `analyzer.mjs`** using the pattern already proven in the same
   file: pull the 3 peak-detector algorithms and the quality/stats clusters
   into pure `signal/` modules, leave delegating methods behind (mirrors
   `analyzer_time_format.mjs`). Mechanical, low-risk, precedent already
   exists.
2. **Split `events.mjs`** along its own existing `_bind*Controls()` seams
   into per-panel files that `Object.assign` onto the shared `GSREvents`
   object — the exact idiom `map_manager_*.mjs`/`ui_*.mjs` already use, so
   it's replication of a known-good pattern, not new design.
3. **Tidy `src/map/`**: move the 6 stray `globe3d_*.mjs` files into
   `globe3d/`, and consider nesting the 10 `map_manager_*.mjs` files into
   `map/manager/`.
4. **Don't chase the circular-import clique as an urgent fix.** Treat *new*
   imports into `ui.mjs`/`events.mjs`/`tracks.mjs`/`collective_project.mjs`
   as a smell going forward, and prefer one-directional wiring (callbacks or
   an explicit registration step instead of mutual imports) whenever that
   area is already being touched for another reason.

## Tooling for the circular-import clique

No tool safely *fixes* a cycle without a human deciding which edge to cut
(invert a dependency into a callback, extract shared bits to a new leaf
module, etc.) — but tooling can detect and guard against it automatically:

- **`knip.json`** (already in the repo) finds unused exports/files/deps —
  a different job, it does not detect import cycles.
- **`madge`** (used for this review, not installed as a devDependency) is
  good for one-off audits/visualisation (`madge --circular`, or
  `--image graph.svg`), but it's read-only and not wired into CI.
- **Biome** (the repo's actual linter) has no circular-import rule as of
  2.5.13.
- **`dependency-cruiser`** is the standard tool for this specific job and
  the one worth adding:
  - `forbidden: [{ name: 'no-circular', from: {}, to: { circular: true } }]`
    gives a `depcruise` CLI check runnable alongside `npm run lint`.
  - Supports a **baseline** (`--ignore-known known-violations.json`,
    generated once against current state) — freezes today's 21 cycles as
    "known debt" and fails only on *new* cycles from here on, turning
    recommendation 4 above from a manual-review habit into an enforced gate.
  - Can also encode the layering invariant that's already true today
    (`signal/`/`gps/`/`osm/` never import `ui/`/`map/`/`render/`) as a rule,
    so it stays true as the codebase grows instead of relying on someone
    noticing in review.

Not yet implemented — proposed as a `lint:deps` npm script,
`.dependency-cruiser.cjs` config, and a checked-in baseline file, if wanted.
