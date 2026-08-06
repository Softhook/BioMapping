# GSR Map Visualiser — Test Coverage & Gradual Refactor Plan

> Companion to `visualizer_architecture_refactor_plan.md`. That document's
> **Phase 4** already sketches "formalize the test suite" in one paragraph;
> this document expands that into its own plan, focused specifically on
> getting every function under automated test — and is honest about which
> functions that's actually achievable for. Scope: `visualiser/` only.

## Direct answer: can this be automated unit tests?

**Mostly yes, but not uniformly, and "every function" needs a definition.**

The app has no bundler and hangs everything off `window` globals, but a
majority of its ~1,000 functions (rough count below) are already **plain
JS with no DOM/Leaflet/p5 dependency** — several files even say so in their
own header comments:

- `gps_filter.js:2-3`: "standalone pure functions ... Extracted from
  `GSRMapManager` (`map.js`) so the filters can be tested independently"
- `gsr_filter.js:2-3`: "standalone pure functions ... Extracted from
  `GSRAnalyzer` so they can be tested"
- `marching_squares.js:2-3`: "pure spatial algorithm, zero dependencies"
- `label_placement.js:2-3`: "Extracted from `map.js` to separate Leaflet
  rendering from layout computations"

That extraction pattern — pull pure logic out of a DOM-coupled file, test
it standalone — is already this codebase's convention. It just hasn't been
applied everywhere yet. This plan is mostly "keep doing that, on purpose,
file by file."

For the remainder — functions whose entire body is a Leaflet/p5/DOM call
(`L.marker(...).addTo(map)`, `ctx.fillRect(...)`, `document.getElementById(...)`)
— a "unit test" would have to mock Leaflet/canvas/DOM so heavily that the
test only verifies the mock, not the code. Those need a different tool:
headless-browser integration/smoke tests (jsdom or Playwright), not
per-function unit tests. Real, but a different category of coverage.

## Current state (verified, not estimated)

- No `package.json` anywhere in the repo → no declared runner, no
  framework, no `npm test`.
- `tests/` has 19 scripts. 18 use plain `assert` + `process.exit(1)` on
  failure — genuinely CI-safe today, just not wired to anything.
- **One exception:** `test_dwt_clamp.js` hard-requires
  `$HOME/Downloads/biomap_020.csv` and calls `process.exit(1)` if it's
  missing (`tests/test_dwt_clamp.js:37-41`). It will fail on any machine
  other than the one it was written on. Needs fixing or excluding before
  any harness runs it automatically.
- Load pattern: tests `fs.readFileSync` the source file and `eval()` the
  relevant slice (e.g. `tests/test_dwt_clamp.js:19-21`) rather than
  `require`, because the source files assign to `window.X` / bare globals,
  not `module.exports`. Works, but brittle — a reordering of a source file
  can silently break the `eval` slice boundary.
- Modules with **zero** test references today (verified by grep, not
  inferred): `app_state.js`, `collective_project.js`, `label_placement.js`,
  `layout_manager.js`, `overpass_client.js`, `sketch.js`, `storage.js`.

### Rough function count / DOM-coupling per file

(heuristic grep — function-like declarations vs. `document./window./L\./getContext/p5` references — good enough to rank, not exact)

| File | ~Functions | DOM/Leaflet/p5 refs | Tier |
|---|---:|---:|---|
| analyzer.js | 175 | 3 | A |
| ui.js | 127 | 80 | D |
| map.js | 138 | 22 | C |
| events.js | 85 | 99 | D |
| osm_enrichment.js | 102 | 0 | A |
| renderer.js | 70 | 2 | A/C |
| rf_fluid_renderer.js | 64 | 4 | A/C |
| map_exporter.js | 52 | 14 | C |
| tracks.js | 43 | 24 | C |
| map_match.js | 39 | 0 | A |
| collective_manager.js | 33 | 0 | A (gap) |
| gsr_filter.js | 33 | 0 | A |
| storage.js | 30 | 0 | B (gap) |
| sketch.js | 29 | 6 | D (gap) |
| gps_filter.js | 28 | 0 | A |
| spatial_clustering.js | 28 | 1 | A |
| gps_pipeline.js | 18 | 0 | A |
| osm_cache.js | 24 | 0 | A |
| dwt_filter.js | 24 | 0 | A |
| layout_manager.js | 23 | 19 | D (gap) |
| collective_project.js | 21 | 5 | B (gap) |
| deconvolution.js | 19 | 0 | A |
| overpass_client.js | 14 | 0 | B (gap, needs fetch mock) |
| stats_math.js | 14 | 0 | A |
| label_placement.js | 12 | 0 | B (gap) |
| geo_utils.js | 10 | 1 | A |
| file_saver.js | 11 | 6 | C |
| map_colors.js | 17 | 0 | A |
| marching_squares.js | 4 | 0 | A |
| app_state.js | 1 (trivial) | 4 | D (low priority — plain data) |

Rows marked "(gap)" are the *quick wins*: already pure or nearly-pure, just
never got a test file. Tier C/D rows are where the refactor work (not just
test-writing) has to happen first.

## Tiers

- **Tier A — already pure, mostly already tested.** No refactor needed.
  Fill remaining gaps directly.
- **Tier B — already pure, untested.** No refactor needed, straight to
  writing tests. `overpass_client.js` needs a `fetch` mock (inject or
  stub `global.fetch`); the rest are pure computation on plain objects.
- **Tier C — mixed.** Real logic + DOM/Leaflet calls in the same
  functions. Needs the extraction refactor (same move as `gps_filter.js`
  already did to `map.js`) before the logic half is unit-testable.
- **Tier D — irreducible glue.** Function bodies are essentially "call
  Leaflet/p5/DOM and return." Not worth unit-testing; cover with a thin
  headless-browser smoke test instead.

## Phased plan

Each phase is independently shippable and ordered cheapest/safest first,
matching the sequencing style of the architecture refactor plan.

### Phase A — Wire up a real harness

1. Add a minimal `package.json` in `visualiser/` (no dependencies
   required) with `"test": "node --test tests/"` or a small loop script —
   Node 18+'s built-in `node:test` runner works with the existing
   `assert`-based style with minimal rewriting.
2. Fix or exclude `test_dwt_clamp.js`: either commit a small fixture CSV
   under `tests/fixtures/` and point it there, or mark it
   `tests/manual/` and exclude it from the default run (it's a real
   pipeline-comparison tool, worth keeping, just not as an automated gate).
3. No behavior change to the 18 already-automatable tests — just make them
   runnable as one command and confirm all 18 pass clean.

**Verify:** `npm test` from a fresh checkout exits 0.

### Phase B — Fill Tier A/B gaps (quick wins, no refactor)

Write new `tests/test_*.js` files (same `require(fs)`+`eval` load pattern
as existing tests, or switch to `module.exports` if Phase A's harness
makes that easier) for the currently-untested pure modules, in this order
(cheapest/highest-value first):

1. `label_placement.js` — pure layout math, 12 functions, zero deps.
2. `collective_project.js` — export/import logic; mock the 5 DOM touch
   points at the call boundary rather than testing them.
3. `storage.js` — `sliderVal`/`shapeSliderVal`/`getTrackSettingsStatus`
   etc. take DOM elements or plain objects as parameters; pass mock
   `{value: ...}` objects instead of real elements.
4. `overpass_client.js` — stub `global.fetch` to test rate-limit/backoff/
   retry logic without a real network call.
5. `collective_manager.js` — extend existing partial coverage
   (`test_all_pipelines.js`, `test_label_persistence.js`,
   `test_masked_grid_isobands.js`) to the remaining untested paths.

**Risk:** very low — no source changes, purely additive test files.

### Phase C — Extract-then-test the mixed files

Apply the same move that produced `gps_filter.js`/`gsr_filter.js`/
`marching_squares.js`/`label_placement.js`, to the remaining Tier C files,
**one file at a time**, each landing with its own test:

1. `tracks.js` (43 fns / 24 DOM refs) — likely candidate: track-list
   sort/filter/status logic separable from the `renderTrackList()` DOM
   writes.
2. `map_exporter.js` (52 fns / 14 DOM refs) — export-format assembly
   (SVG/JSON structure building) is probably separable from the
   `canvas.getContext()` / file-save calls; `test_rf_svg_export.js` and
   `test_svg_vector_surface.js` already exercise some of this and are a
   template.
3. `map.js` (138 fns / 22 DOM refs) — biggest file, do last and in small
   slices; the architecture refactor plan's own Phase 1 (track/map
   ownership model) already touches this file, so sequence this *after*
   that phase lands to avoid rebasing test extractions against it twice.
4. `renderer.js` / `rf_fluid_renderer.js` — mostly already low-DOM
   (2 and 4 refs respectively); likely need the least extraction work of
   the Tier C group, good warm-up before `map.js`.

**Risk:** medium per file — this is the same category of work as any
refactor: confirm behavior is unchanged before/after each extraction
(manual smoke test + the new unit test) before moving to the next file.
Do not batch multiple files into one extraction pass.

### Phase D — Smoke-test the irreducible glue

For `ui.js`, `events.js`, `sketch.js`, `layout_manager.js`, and whatever
remains in `map.js`/`tracks.js` after Phase C — the code that's
legitimately "wire this DOM event to this Leaflet call" — don't chase
per-function unit tests. Instead:

1. Add a small headless-browser layer (`jsdom` for DOM-only checks, or a
   Playwright script for anything touching real Leaflet/p5 canvas
   rendering — this is the one place a new dependency is justified).
2. Write a handful of **smoke tests**, not exhaustive ones: app boots
   without throwing, a track can be added/removed without leftover state
   (this doubles as the Phase 4 regression test the architecture plan
   already calls for), view-mode toggle doesn't throw, export doesn't
   throw. Breadth over depth — this tier's job is "catch a crash," not
   "verify every branch."

**Risk:** low-medium — additive, but a new dependency (jsdom/Playwright)
is a real one; confirm it's acceptable given the "no bundler, no
`package.json`" stance in the architecture plan before adding it (that
plan explicitly scoped bundlers/frameworks out — this is narrower, a dev
dependency for tests only, not a build-time dependency, but worth flagging
since it changes "no `package.json` anywhere in the repo" from Phase A on).

## What "every function tested" should mean in practice

Not "1,000 unit tests, one per function." Recommend defining done as:

- **100% automated unit-test coverage of Tier A + B + (post-extraction)
  Tier C** — the actual analysis/geometry/data logic, which is also where
  bugs are most costly (wrong stress readings, wrong map geometry) and
  where the existing 19 tests already prove the approach works.
- **Smoke/integration coverage, not unit coverage, for Tier D** — the
  DOM/Leaflet/p5 glue — sized to "does it crash," matching how thin those
  functions actually are.
- Every Phase C extraction lands with its test in the *same* change, so
  coverage never regresses while the refactor is in progress (mirrors the
  architecture plan's own rule: "add regression tests alongside Phase 1
  and Phase 2 as they land, rather than retrofitting after").

## Suggested sequencing relative to the architecture refactor plan

```
Phase A (harness)         ── do first, low risk, unblocks everything else
Phase B (fill A/B gaps)   ── do anytime after A, independent of architecture plan
                              (can run in parallel with architecture Phase 0)
Phase C (extract+test)    ── sequence map.js slice AFTER architecture Phase 1
                              (track/map ownership model) lands, to avoid
                              double-touching map.js
Phase D (smoke tests)     ── last; benefits from Phase C shrinking Tier D first
```

## Open questions before starting

- Phase A: `node --test` (Node 18+) vs. keeping the current "loop over
  scripts, check exit code" style with zero new tooling — either works;
  `node --test` gives free parallelism and reporting, the loop script
  gives zero new concepts to learn. Worth a quick call before Phase A.
- Phase D: jsdom (fast, DOM-only, can't actually render Leaflet tiles or
  p5 canvas output) vs. Playwright (slower, real browser, can actually
  verify canvas/map rendering) — depends on whether Phase D's smoke tests
  need to assert on *visual* output or just "did it throw."
- Should `test_dwt_clamp.js` get a checked-in fixture CSV (Phase A, step 2)
  or move to a `tests/manual/` folder that's explicitly excluded from
  `npm test`? Affects whether it counts toward "every function" or stays
  a deliberately manual tool.
