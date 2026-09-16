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

**Update (same day, after this review):** the circular-import clique in §2
below has been resolved — see "§2 resolution" at the end of that section.
Item §1 (the two god-objects) and §3 (`src/map/` nesting) are unchanged and
still open.

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

### §2 resolution (2026-09-16, same day)

All of it fixed, not frozen — `npx madge --circular` went from 18 chains
(re-measured slightly lower than this review's 21, likely just repo drift
since the snapshot) to 0, and no `dependency-cruiser` baseline was needed.
Three separate fixes:

1. **The `ui`/`events`/`tracks`/`collective_project` clique above, plus
   `storage.mjs`, `map_popups.mjs`, `globe3d_view.mjs`, `sketch.mjs`,
   `layout_manager.mjs`, and `live_view.mjs`** — all fixed the same way: a
   new leaf module, `src/core/controllers.mjs`, exports a plain `Controllers`
   registry object. Each singleton (`GSRUI`, `GSREvents`, `GSRTrackManager`,
   `GSRCollectiveProject`, `GSRLiveView`) registers itself
   (`Controllers.ui = GSRUI;`) immediately after its own definition; callers
   elsewhere in the clique read `Controllers.ui.runAnalysis()` instead of
   importing `ui.mjs` directly. Safe because every cross-clique call already
   only ran from inside a function body executed after full module load
   (event handlers, `setup()`), never at module-eval time — same invariant
   that let the cycle work at all before this fix.
2. **`live_graph.mjs`/`live_map.mjs` ↔ `live_view.mjs`** — a different shape:
   not method calls but shared *mutable state* (`liveAnalyzer`, `liveGsrView`,
   packet timestamps). Fixed by exposing those as getters on `GSRLiveView`
   (reached via the same `Controllers` registry) and moving the one true
   constant, `LIVE_SETTLE_TAIL_S`, into the already-existing `live_state.mjs`
   leaf module.
3. **`analyzer.mjs` ↔ `csv_parser.mjs`** (unrelated to the clique above) —
   the pure static `calcEmFog` function both files needed was extracted to a
   new `src/signal/em_fog.mjs` leaf module; `GSRAnalyzer.calcEmFog` is now a
   thin delegate, matching the existing `parseCSV`/`formatClockTime`
   delegation pattern this file already used.

**Is the `Controllers` registry a real fix or a workaround?** Worth being
honest about this rather than presenting it as a clean solution. It's a
recognised pattern (service locator / mediator), it's zero-risk (same
objects, same methods, nothing changed at runtime — verified by the full
1320-test suite staying green through every step), and it's genuinely the
right tool for "make the import graph a DAG without a large redesign." But
it does **not** reduce the actual coupling between `ui`/`events`/`tracks`/
`collective_project` — they still reach as deep into each other's internals
as before. It trades a *static* import (visible to `madge`, `depcruise`, an
IDE's "find references") for a *dynamic* property lookup (invisible to all
three), which satisfies the cycle checker by making the dependency harder to
see, not by removing it. It also adds one sharp edge the static-import
version didn't have: calling `Controllers.ui.foo()` before `ui.mjs` has
registered itself fails silently (`undefined.foo is not a function`) instead
of erroring at import time — mitigated here only by the same "nothing
cross-clique runs before full load" discipline the old cycle already
depended on, now enforced by convention rather than by the module system.

**Event-based decoupling — a deeper fix, not done here.** The codebase
already has one example of the more genuine pattern, right next to this
clique: `sketch.mjs`'s `setup()` does
`AppState.on('trackRemoved', () => Controllers.trackManager.renderTrackList())`
instead of `tracks.mjs` reaching out to call renderers directly. Applied to
the clique, `events.mjs` would `AppState.emit('gsrParamsChanged', params)`
instead of calling `GSRUI.runAnalysis()`/`Controllers.ui.runAnalysis()`
directly, and `ui.mjs` would subscribe. That actually inverts the
dependency — `events.mjs` would no longer need to know `GSRUI` exists at
all — rather than just resolving it indirectly through a shared registry.
It's a materially bigger change than the registry swap (every call site's
semantics need rethinking: is this a synchronous return-value call or a
fire-and-forget notification?), so it was scoped out of "make the lint gate
pass" and left as a proposal. Worth doing as its own deliberate pass if the
`ui`/`events`/`tracks`/`collective_project` clique gets touched heavily
again — probably starting with one call site as a trial (e.g. the slider →
`runAnalysis()` path) before converting the rest.

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
4. ~~Don't chase the circular-import clique as an urgent fix.~~ **Done
   (2026-09-16, see §2 resolution above) rather than deferred** — resolved,
   not frozen as known debt. Going forward: treat a *new* direct import
   between any of `ui.mjs`/`events.mjs`/`tracks.mjs`/`collective_project.mjs`/
   `storage.mjs`/`map_popups.mjs`/`globe3d_view.mjs`/`sketch.mjs`/
   `layout_manager.mjs`/`live_view.mjs`/`live_graph.mjs`/`live_map.mjs` as a
   smell — route it through `Controllers` (`core/controllers.mjs`) instead,
   and `npm run lint:deps` now fails the build if someone reintroduces a
   cycle directly.

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
  the one added.

### Implemented (2026-09-16)

- `dependency-cruiser` added as a devDependency — pinned to `16.10.4`, not
  the current `18.3.1`, because `18.x`'s CLI hard-refuses to run on Node
  25.2.1 (an odd/non-LTS release line outside its `^22||^24||>=26` support
  range); `16.10.4`'s wider `^18.17||>=20` range doesn't hit that check.
  Revisit the pin once the dev machine is back on an LTS Node line.
- `.dependency-cruiser.cjs`: a `no-circular` rule (`from: {}, to: { circular:
  true }`), plus a second rule enforcing the layering invariant §2 noted
  above (`signal/`/`gps/`/`osm/` → no `ui/`/`map/`/`render/`/`live/` imports).
- `npm run lint:deps` runs `depcruise src/app_entry.mjs src/live_entry.mjs`.
- **No baseline file** — since §2's fix resolved every cycle rather than
  deferring any of them, `--ignore-known` had nothing to freeze. If a
  genuinely unavoidable cycle shows up in future work, that's the point to
  add one (`depcruise --ignore-known` generates it), scoped to just that
  cycle rather than a blanket allowance.
- Sanity-checked the gate itself: temporarily added a
  `signal|gps|osm` → `ui` import, confirmed `npm run lint:deps` caught it and
  exited non-zero, then reverted.

## Follow-up review (same day, after `c32aaae`/`7b48413`/`7487c9c`)

Both items §1 and §3 above, listed at the time as "unchanged and still open,"
are now done — the codebase moved faster than this doc did. Re-verified
directly rather than trusting the old numbers:

- **§1 (god-objects) resolved.** `analyzer.mjs` 3358→2127 lines: every
  peak-detector, quality-scorer, and stats/export method checked is now a
  thin delegate to a new pure module (`peak_detectors.mjs`, `peak_shape.mjs`,
  `analyzer_stats.mjs`, `analyzer_export.mjs`), not just relocated bulk.
  `events.mjs` 1895→657 lines, split into 10 `events_*.mjs`/`ui_*.mjs`
  part-files along its own pre-existing `_bind*Controls()` seams, wired via
  the same `Object.assign(GSREvents, __methods)` idiom `map_manager_*.mjs`
  already used.
- **§3 (`src/map/` nesting) resolved.** `map_manager_*.mjs` → `map/manager/`
  (12 files), `globe3d_*.mjs` → `map/globe3d/` (9 files); only the module
  roots (`globe3d.mjs`, `globe3d_view.mjs`, `map.mjs`) still sit flat, which
  is correct.
- Re-ran the full check: `npm run lint:deps` still 0 cycles (112 modules),
  full suite still green (1320/1320). `biome check` found 2 trivial
  auto-fixable import-order violations in the two new `map/globe3d/*.mjs`
  files from the move. `knip`'s ~30 "unused export" hits are false
  positives — it doesn't trace the `Object.assign(prototype, __methods)`
  composition pattern.
- New largest file in the codebase is now `globe3d.mjs` (1982 lines,
  overtaking the old `analyzer.mjs`). Read through it — it's a legitimate
  camera/rendering/entity-lifecycle orchestrator that already delegates
  peaks/toggles/tour/osm/rf/buildings/exporters/navigation out to
  `map/globe3d/*`, not a dumping ground. Not a current problem, just the
  next file worth watching if it keeps growing.

**Updated verdict: architecture is clean.** No open recommendations remain
from this review.
