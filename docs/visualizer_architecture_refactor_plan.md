# GSR Map Visualiser — Stability Refactor Plan

> **Living document.** This is a forward plan, not a status report — update phase
> status as work lands, and correct anything that turns out wrong once touched.
> Scope: `visualiser/` only (the browser-based track/RF visualizer), not
> the Flipper firmware.

## Why this document exists

Investigating "RF visualization data is left behind when a track is removed"
turned up a bug class, not a single bug: `GSRMapManager` held flat arrays of
Leaflet layer handles (`pathSegments`, `collectivePeakMarkers`, …) that had to
be manually kept in sync with track add/remove across several call sites. Two
of those "clear everything" call sites forgot to clear the RF fluid canvas,
because nothing enforced that the two stayed paired — see `map.js:clearMap()`
and `map.js:clearCollectiveLayers()` (fixed, and consolidated behind a single
`clearAll()` entry point).

That fix is done. This document is the broader plan: the same
*manually-synchronized state* pattern shows up in several other places in the
app, and a couple of unrelated stability gaps (error handling, test wiring)
compound how visible/recoverable this class of bug is when it recurs. The
phases below are ordered cheapest-and-safest first, each independently
shippable.

## 1. Diagnosis

### 1.1 Boot sequence — not a risk, noted for completeness

No bundler, no `package.json` at repo root. `index.html` loads ~30 plain
`<script>` tags in a fixed order (Leaflet/p5/html2canvas/jszip from CDN,
`app_state.js` first among app files, `sketch.js` last), everything hangs off
`window` globals (`window.GSRMapManager = GSRMapManager` at `map.js:1806`).
There is exactly **one** init path: p5.js auto-invokes `setup()` in
`sketch.js:6-32`, which constructs `AppState.collectiveManager`,
`AppState.analyzer`, `AppState.mapManager` (which builds the Leaflet map),
creates the p5 canvas, then wires all DOM listeners via
`GSREvents.setupEventListeners()`. Sequential and synchronous — no race
between map init, canvas init, and DOM wiring. **Not a refactor target.**

### 1.2 Core instability pattern: state that must be remembered to stay in sync

Concrete instances found, beyond the map-layer one already fixed:

| State | Location | Invalidated by | Risk |
|---|---|---|---|
| `analyzer._cachedEnvStats` / `collectiveManager._cachedEnvStats` | set `ui.js:1177`, read `ui.js:1005,1188,1386-1389` | `GSRUI.invalidateEnvironmentalCache()` (`ui.js:13-19`), called from **9 separate call sites**: `ui.js:68,202,231,243,806,843`, `tracks.js:228-229`, `events.js:653-654`, `storage.js:293-294` | Miss one call site after adding a new data-mutating action → stats silently stale |
| `GSRMapManager._gpsCache` | `map.js:51`, read/written `map.js:404,415,453` | Keyed by paramsHash + snap fingerprint, comment at `map.js:9` warns it "would otherwise go stale the moment a GSR slider changes" | Self-invalidating via hash key — lower risk, but the hash must be kept exhaustive as new GPS params are added |
| `_lastFitBoundsTrackId` / `_lastFitBoundsTrackSet` | `map.js:57-58`, compared `map.js:485,1642`, reset `map.js:1461` | Manual reset on clear; comment at `map.js:1459` warns a stale signature "would wrongly look unchanged" | Low blast radius (viewport framing only, not data correctness) |
| RF fluid `cachedNodes` (`rf_fluid_renderer.js`) | `_precalculateSpatialFans()` (`rf_fluid_renderer.js:174`) | **Not cached at all** — recomputed from scratch on every `setData()` call, for the full combined point set of every active track | Not a correctness bug (this is why the RF-left-behind fix works), but an O(all active points × rays × building segments) cost paid on every track toggle — the actual scaling wall for "many tracks" (see §3, Phase 5) |
| OSM enrichment snapped-position cache | `osm_enrichment.js:587,598` | Manual clear when snapping toggled off | Scoped to one feature, lower risk |
| `OsmCache` bbox entries | `osm_cache.js:78,130,271-278` | TTL (30 days) + explicit stale-entry cleanup + documented load-order dependency ("osm_cache.js loads before osm_enrichment.js") | Load-order dependency is implicit, not enforced by the script-tag list itself |

The common shape: **N call sites must each remember to do M things** whenever
some piece of source data changes. This is exactly the pattern that produced
the RF bug, and it's not confined to the map.

### 1.3 Error handling — inconsistent, no safety net

No `window.onerror` or `unhandledrejection` handler anywhere in the app. Four
different failure-handling conventions coexist depending on which file you're
in:

- Real try/catch with descriptive re-thrown errors: `overpass_client.js:77-157`.
- Caught + `console.warn` + graceful fallback: `osm_cache.js:387,405,441`.
- Caught + blocking `alert(...)`: ~22 call sites, e.g. `ui.js:253,575,737,748,864`, `events.js:628,690,693`, `storage.js:174-181`.
- Silently swallowed, no logging: `map_exporter.js:992,1004,1037,1190` (`catch (_) {}` / `catch (_) { /* tainted */ }`).

An uncaught exception mid-render today leaves the UI in whatever half-updated
state it was in, with no visible signal that anything went wrong. That's
plausibly why bugs in the §1.2 family are hard to *notice* in the first place,
not just why they happen.

### 1.4 No decoupling layer between the three rendering surfaces

p5 canvas (`renderer.js`, `sketch.js`), Leaflet map (`map.js`), and the DOM
panel (`ui.js`, `events.js`) all read/write the single shared `AppState`
object directly and call each other's namespaced globals directly (e.g.
`GSRUI.invalidateEnvironmentalCache()` called from `tracks.js`/`events.js`/
`storage.js`; `GSREvents.initializeLabels()` called from `storage.js:191-192`
and `tracks.js:327`). No `CustomEvent`/`dispatchEvent`/`EventTarget`/pub-sub
exists anywhere in the app's own code — Leaflet's `.on()` is used only for
native map/DOM events, not as an app-wide bus. Every "X changed" has to be
manually propagated by whoever wrote that call site remembering every
downstream consumer — the same root cause as §1.2, one level up.

### 1.5 Testing — real coverage exists, but informal

`visualiser/tests/` has 19 plain Node scripts (pipelines, deconvolution,
DWT, OSM cache/enrichment, isoband rendering, RF fluid, SVG export, label
persistence, refactor regression) plus `tests/mock_constants.js`, run
individually via `node tests/test_x.js`. No `package.json` anywhere in the
repo, so no declared runner, no single `npm test`, no framework. Real
regression value already exists here — it just isn't wired together or run
automatically.

## 2. Explicitly out of scope

To keep this from becoming a rewrite:

- **No bundler or module system migration.** The plain-script-tag boot
  sequence works and isn't the source of any bug found. Introducing Webpack/
  Vite/ES modules would touch all 24 files for zero identified stability
  benefit.
- **No framework adoption** (React/Vue/etc.) for the DOM panel or as a
  replacement for the imperative rendering in `map.js`/`renderer.js`.
- **No replacing p5.js or Leaflet.**
- **No full pub/sub framework.** §3 Phase 3 below is a handful of named
  events, not a generic event-bus library.

## 3. Phased plan

Each phase lists goal, concrete steps, files touched, risk, and how to verify.
Phases are independently shippable; §4 gives suggested sequencing.

### Phase 0 — Global error safety net  ✅ DONE (2026-08-06)

> **Status:** landed. `error_handler.js` (loaded first in `index.html`/`boot_app.js`) adds `window.onerror` +
> `unhandledrejection` hooks and a `GSRErrors.report(err, context)` helper that shows a non-blocking toast
> (own container, no load-order coupling to app UI). The 4 silent `catch(_){}` sites in `map_exporter.js`
> now log through it (fallbacks preserved). `alert()` sites untouched per plan. Covered by
> `tests/test_error_handler.js` (4 tests). No test changes to other flows.

**Goal:** make failures visible instead of silent, with minimal behavior change.

**Steps:**
1. Add one `window.onerror` + `window.addEventListener('unhandledrejection', …)` handler (new small file, e.g. `error_handler.js`, loaded early in `index.html`) that logs consistently and surfaces a visible, non-blocking notice (reuse the existing file-status/toast UI pattern already used elsewhere, e.g. `GSRTrackManager.setFileStatus`) rather than failing silently.
2. Add a small `GSRErrors.report(err, context)` helper and migrate the worst offenders — the silent `catch (_) {}` sites in `map_exporter.js:992,1004,1037,1190` — to at least log through it. Leave the deliberate graceful-fallback catches (`osm_cache.js`) alone; those are intentional, not bugs.
3. Do **not** touch the 22 `alert()` call sites in this phase — that's a UX change (blocking alerts → toasts) worth doing but separable from "add a safety net," and mixing the two makes this phase harder to review.

**Risk:** very low — additive only, no existing behavior changes except the silent-catch sites gaining a log line.

**Verify:** manually throw inside a render path (temporary) and confirm the notice appears instead of a silent stuck UI; confirm existing `alert()` flows are unaffected.

### Phase 1 — Track/map rendering ownership model

**Status:** slice 1 (track `layerGroup` field + single-track render path routes into it; `clearMap`/`deleteTrack` remove the group) ✅ LANDED 2026-08-06, behind the new recording-Leaflet regression suite in `visualiser/tests/test_map_layer_ownership.js`. Slice 2 (collective/multi-track path now routes each active track's layers into ITS OWN layerGroup; `GSRMapManager` tracks the set of groups it rendered (`_renderedTrackGroups`) so `clearMap` clears by what it rendered, not by the manager's current tracks — a removed track can't leave an orphaned group) ✅ LANDED 2026-08-06, same suite extended (3 new collective tests). Also fixed during slice-2 verification: the collective surface overlay was gated on the button's `showShadedSurface` at *creation*, so a re-render while the surface was hidden (delete a track with the surface off) left `surfaceOverlay` null and toggling it back on did nothing — the overlay is now always created when there is surface data and visibility is a pure add/remove via `showSurface` (regression test added). Slice 3 (drop the flat render arrays: `pathSegments`/`peakMarkers`/`hotspotMarkers`/`collective*` are gone as state; `GSRMapManager` now owns per-track `layerGroup`s + a full per-track `_ownedLayers` registry so toggles can restore hidden layers; `getRenderLayers()`/`getPeakMarkerByIndex()` are the public accessors the SVG exporter and `focusOnPeak` use; `clearCollectiveLayers` also clears per-track groups, fixing the "uncheck the last track" stale-group bug) ✅ LANDED 2026-08-06, suite extended (5 tests). Browser-verification bug fixes (2026-08-06, commit ac57e26): the scrub marker lingered into collective view (0-active-tracks path only called `clearCollectiveLayers`), the GPS "Tracks" toggle didn't affect the single-track path, and track/contour/cluster colors exported as raw `hsl(...)` strings that render black in SVG viewers — exporter now converts to hex. Code-review fix (2026-08-07): `_clearRenderedTrackGroups()` (`map.js`) reset the legacy `_unownedLayers` array (layers rendered via the null-track fallback, i.e. no managed track for the active analyzer) without ever calling `map.removeLayer()` on them first — every `clearMap()`/`clearAll()`/`clearCollectiveLayers()` call permanently orphaned those layers, exactly the failure mode this ownership model exists to prevent. No test exercised that fallback path, so it wasn't caught by the slice 1–3 suite; fixed (now removes each `_unownedLayers` entry from the map before dropping the array) — regression-tested (`tests/test_map_layer_ownership.js`, "orphan-fix: clearMap removes legacy no-track-fallback layers, not just the tracking array reference"; this status note previously said untested, corrected 2026-08-07 on rediscovering the test already existed). "Slice 4 (`deleteTrack` pilot rollout)" was a forward reference to Phase 3 §3's pilot below, not unfinished Phase 1 work — Phase 1 itself (steps 1–4) is complete.

**Goal:** eliminate the specific flat-array-drift pattern in `GSRMapManager` that caused the original bug, for the map specifically.

**Goal:** eliminate the specific flat-array-drift pattern in `GSRMapManager` that caused the original bug, for the map specifically.

**Steps:** (designed in the prior conversation, restated here for the record)
1. Give each track object (currently a plain `{id, name, analyzer, enabled, color, …}` in `AppState.collectiveManager.tracks`) an `L.layerGroup()` as its single rendering handle for path/peak/hotspot layers.
2. Track removal/deactivation = `map.removeLayer(track.layerGroup)` — one call, structurally can't leave a piece behind.
3. `GSRMapManager` stops owning `pathSegments`/`peakMarkers`/`collectivePathSegments`/etc. as flat arrays; it diffs the active-track set against the last render and calls `track.render()`/`track.clear()` only for tracks that changed.
4. Aggregate layers (RF fluid combination, contours, spatial clustering) stay owned by `GSRMapManager` since they're genuinely cross-track computations, not per-track — but always route through the now-single `clearAll()`/render path so they can't be forgotten.

**Risk:** medium — touches `renderCollectiveData()` (`map.js`) and the track object shape (`collective_manager.js`, `tracks.js`) directly.

**Verify:** the existing manual repro (add N tracks, toggle/remove in various orders and both view modes, confirm no stale layers of any kind) plus a new automated regression test (see Phase 4).

### Phase 2 — Collapse manual-invalidation caches to self-validating state ✅ DONE (2026-08-07)

> **Status:** landed. `GSRAnalyzer` (`analyzer.js`) gained a `_dataVersion` counter, bumped by every
> mutation path that actually touches cached-worthy data: `analyze()` (end of the method, after
> `_buildDisplayCache()`), `setPeakLabel()`, and a new `setPeakExcluded(idx, excluded)` method
> (replaces the direct `peaks[idx].excluded = …` mutation that used to live in
> `ui.js:togglePeakExclusion` — that call site now resolves the analyzer via
> `_resolveTrackAndAnalyzer()` and calls the setter instead of poking the array directly).
> `OSMEnricher.enrichTrack()` (`osm_enrichment.js`) bumps the same counter on the analyzer it's
> passed, right after it sets `isEnriched = true` — the point where all `osm_*` fields on `raw`
> are finalized. The grep audit called for in the risk note below found exactly these mutation
> paths (plus internal-only ones like `this.peaks.push()` inside `analyze()`, already covered
> since `analyze()` bumps once at the end) — no direct `analyzer.raw =` / `peaks.push` bypass from
> outside the class.
>
> The read side (`GSRUI.updateEnvironmentalDashboard()`, `ui.js`) already fingerprinted the cache
> on `latency`/`trackCount`/`trackIds` (so track add/remove/enable-toggle and latency changes were
> already self-correcting); it now also folds in `versionSig` — a per-active-track join of each
> analyzer's `_dataVersion` — so a mutation that leaves the active-track set unchanged (peak label
> edit, exclusion toggle, re-analyze, OSM enrichment) also forces a recompute. All 9
> `invalidateEnvironmentalCache()` call sites (`ui.js` ×6, `tracks.js`, `events.js`, `storage.js`)
> and the method itself are deleted — the cache can no longer go stale by a caller forgetting to
> invalidate it, because nothing calls "invalidate" anymore. `_gpsCache` and
> `_lastFitBoundsTrackId/Set` left untouched per step 4. New regression coverage:
> `tests/test_analyzer_refactoring.js` (`_dataVersion` bumped by `setPeakLabel`/`setPeakExcluded`/
> `analyze()`, and *not* bumped by an out-of-range `setPeakExcluded` index) and
> `tests/test_osm_enrichment.js` (`enrichTrack` bumps `_dataVersion`) cover the write side —
> analyzer methods bump the counter correctly. `tests/test_env_dashboard_cache.js` (new) covers the
> read side, which the write-side tests alone don't prove: it drives the real
> `GSRUI.updateEnvironmentalDashboard()` against a real `GSRAnalyzer` built from an actual track CSV
> (`tracks/biomap_048.csv`, the same fixture `test_all_pipelines.js` uses), with `document` stubbed
> to return no render targets so the cache-computation logic runs for real while DOM painting
> no-ops. Five cases: cache reused across repeat calls with no mutation; recomputes after
> `setPeakLabel`, `setPeakExcluded`, and re-`analyze()` in single mode; and — the one most worth
> having, since it's genuinely new logic rather than a restated unit test — in collective mode,
> mutating only ONE of two active tracks still invalidates the shared `collectiveManager`-level
> cache (the `versionSig` join across tracks). Verified this test suite isn't vacuous by
> temporarily reverting the `versionSig` check in `ui.js` and confirming 4 of 5 cases fail, then
> restoring the fix. `tests/test_storage.js` and `tests/test_tracks.js` updated to drop their
> now-dead `invalidateEnvironmentalCache` mocks/assertions. Full suite green (all `tests/test_*.js`,
> run individually per §1.5 — no `npm test` yet, that's Phase 4).

**Goal:** apply the Phase 1 principle (state that can't go stale by construction) to the `_cachedEnvStats` family from §1.2, the highest-call-count instance of the pattern.

**Steps:**
1. Attach a version/generation counter to the data source (`analyzer`/`collectiveManager`) that increments on any mutation already funneled through a small number of setter paths.
2. Change the cache read (`ui.js:1005,1188,1386-1389`) to check the stored generation against the current one and recompute automatically on mismatch, instead of trusting a null-check that depends on 9 call sites remembering to null it.
3. Once the read side self-validates, the 9 `invalidateEnvironmentalCache()` call sites become redundant and can be deleted rather than maintained.
4. Leave `_gpsCache` and `_lastFitBoundsTrackId/Set` alone — both are already keyed/compared in a way that makes staleness self-correcting (see §1.2 table), lower priority.

**Risk:** medium — need to confirm every mutation path actually funnels through the counter; a missed mutation path is the same failure mode as a missed invalidation call, just relocated. Worth grepping for direct `analyzer.raw =` / `peaks.push` style mutations that bypass any setter before committing to this approach.

**Verify:** new regression test asserting stats reflect a mutation made through every known mutation path (peak label edit, GPS param change, track add/remove, environmental enrichment).

### Phase 3 — Minimal event notification between rendering surfaces

> **Status:** step 1–3 pilot ✅ LANDED 2026-08-07. `AppState.on(event, fn)`/`AppState.emit(event, ...args)` added (`app_state.js`) — plain array-of-listeners per event name, only `trackRemoved` defined/fired so far. `GSRTrackManager.deleteTrack()` (`tracks.js`) no longer calls `renderTrackList()`, `clearAll()`, or `updateCollectiveMap()` directly; it mutates state (unchanged) and ends with `AppState.emit('trackRemoved', trackId)`. The three listeners are registered once, centrally, in `sketch.js`'s `setup()` — not at `tracks.js`/`ui.js`/`map.js` module-top-level, because `tests/test_tracks.js` requires `tracks.js` directly against a hand-built `AppState` mock with no real `setup()` call ever made (deliberate isolation, see that file's header) — a top-level `AppState.on(...)` in `tracks.js` would throw at `require()` time under that harness. `tests/test_tracks.js`'s two assertions that depended on the old direct calls (`clearAllCalled`, `__collectiveMapUpdated`) now register the equivalent listener inline, mirroring what `setup()` does for real, since that file never boots the app; `tests/test_app_smoke.js` and `tests/test_map_layer_ownership.js` both call the real `window.setup()` so they exercise the actual listeners. All 90 tests across the four affected files pass, plus the full 587-test suite. Step 4 (migrating `addTrack`/`switchActiveTrack`/view-mode-toggle to also fire events) investigated 2026-08-07, **no event added** — none of the three named candidates actually has the "N call sites must each remember M things" duplication this phase exists to fix:
> - **`addTrack`**: `loadFilesSequentially()` and `loadDefaultTrack()` (`tracks.js`) each had a post-add `if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap()` block — looked like the same shape as the `trackRemoved` pilot, so it was migrated to a `trackAdded` event first. A listener-removal check (temporarily deregister the listener, confirm a test then fails) showed the map refresh *still happened* with no listener at all: both call sites call `switchActiveTrack(trackId)` immediately before that block, and `switchActiveTrack()` unconditionally calls `GSRUI.runAnalysis()`, which already calls `updateCollectiveMap()` whenever `AppState.viewMode !== 'single'` (`ui.js`). The block was dead code, not a live instance of the bug pattern — wrapping dead code in an event adds indirection for zero benefit. Reverted the event; deleted the dead block from both call sites instead (`loadDefaultTrack()` also had a redundant explicit `renderTrackList()` call — `switchActiveTrack()` already ends by calling it). Left a short comment at each site explaining why no explicit refresh call is needed, so it doesn't get "fixed" back in.
> - **`switchActiveTrack`**: already a single function fully encapsulating its own side effects; its 5 call sites just call it directly. No scattered duplicated logic to migrate.
> - **view-mode toggle** (`events.js` `bindViewSwitcher`): the single-view/collective-view click handlers are each the sole owner of their own DOM/CSS side effects — one definition, not N call sites repeating it. Same conclusion.
>
> Net effect: Phase 3 stays at the pilot (`trackRemoved`) state — the mechanism (`AppState.on`/`emit`) is proven, but no further genuine migration target has been found. Regression coverage for the corrected (dead-code-removed) behavior: `tests/test_app_smoke.js` gained one real end-to-end test (boots the actual app, adds a track via the real file-drop pipeline while in collective view, spies on `GSRUI.updateCollectiveMap` to confirm `runAnalysis()`'s existing collective-mode branch still fires it) — deliberately not unit-tested in `tests/test_tracks.js`, since `GSRUI.runAnalysis` is stubbed to a no-op there and this behavior was never `tracks.js`'s to own. Full suite green (598 tests).

**Goal:** address §1.4 — replace "every call site must remember every downstream consumer" with a handful of named events.

**Steps:**
1. Define a small set of events on `AppState` (not a generic bus): `trackAdded`, `trackRemoved`, `activeTrackChanged`, `viewModeChanged`. Plain array-of-listeners implementation, no dependency.
2. Fire them from the existing mutation points (`tracks.js: addTrack/deleteTrack/switchActiveTrack`, view-mode toggle in `events.js`).
3. Migrate `deleteTrack()` (`tracks.js`) as the pilot: today it manually calls `renderTrackList()`, conditionally `updateCollectiveMap()`, and (as of the Phase-1-adjacent fix) `clearAll()` — replace with firing `trackRemoved` and letting `GSRTrackManager`, `GSRMapManager`, and `GSRUI` each subscribe and react independently.
4. Only migrate other call sites incrementally after the pilot proves out — this phase changes the coupling model, so it deserves to land in small reviewable steps, not a single sweep across the codebase.

**Risk:** highest of the phases — this is the one that changes *how modules talk to each other*, not just what state they hold. Recommend doing this only after Phases 0–2 are stable and only starting with the one pilot call site.

**Verify:** the `deleteTrack()` pilot must produce identical observable behavior to today (same regression tests as Phase 1) before expanding further.

### Phase 4 — Formalize the test suite

**Goal:** turn the 19 existing ad hoc scripts (§1.5) into something that runs automatically and can hold new regression tests.

**Steps:**
1. Add a minimal `package.json` (no dependencies required — the existing tests are plain Node scripts) with a `test` script that runs all 19 in sequence and fails on first non-zero exit.
2. Add a regression test for the track-removal/clear-map bug class specifically (headless: construct a `GSRMapManager`-equivalent, add tracks, remove them, assert no leftover layer handles) so it can't silently regress.
3. Add regression tests alongside Phase 1 and Phase 2 as they land, rather than retrofitting after.

**Risk:** very low, purely additive.

**Verify:** `npm test` (or documented equivalent) runs clean from a fresh checkout.

### Phase 5 — RF fan-cast caching (performance, not correctness) ✅ DONE (2026-08-07)

> **Status:** landed. `RFFluidRenderer` gained a per-track fan-cast cache (`_trackCache`, keyed by
> track id): `setDataForTracks(tracksData)` (new) takes `[{id, drawPoints, osmGeoms}, ...]` and only
> re-runs `_precalculateSpatialFans()` (now a pure function of its arguments, no longer reading/
> writing instance state) for a track whose `drawPoints`/`osmGeoms` reference, radius, or ray count
> actually changed since the last call — an unchanged track reuses its cached nodes. The cheap combine
> step (concatenate per-track nodes/buildings, recompute `rssiStats`, `redraw()`) always runs.
> `setData(drawPoints, osmGeoms)` (single-track view) is now a thin wrapper around
> `setDataForTracks([{id: '__single__', ...}])`, so it gets the same reuse fast path the old
> reference-equality check gave it. `setRadius()` replays the last `tracksData` through
> `setDataForTracks()` — the per-entry radius check does the invalidation, no manual cache-clear
> needed. `map.js`'s `renderCollectiveData()` was the actual bug: it built one concatenated
> `collectiveDrawPoints` array (a fresh reference every render, defeating even the old fast path) and
> called `setData()` once — now it collects per-track `{id, drawPoints, osmGeoms}` entries (reusing
> the already-cached per-track `drawPoints` from `_getOrBuildDrawPoints()`, keyed by track id) and
> calls `setDataForTracks()`. Found during implementation: `clearMap()`/`clearCollectiveLayers()` call
> `_clearRfFluid()` at the START of every render pass, immediately followed by the real
> `setData()`/`setDataForTracks()` call later in the same synchronous pass — `_clearRfFluid()` used to
> call `setData([], null)`, which would prune every track's cache entry via that empty call's own
> active-track-set bookkeeping, forcing a full recompute on every single re-render and defeating the
> cache entirely. Added `RFFluidRenderer.clear()` (blanks `cachedNodes`/`buildingPolygons` + redraws,
> does not touch `_trackCache`) and switched `_clearRfFluid()` to use it. New regression coverage:
> `tests/test_rf_fluid_lifecycle.js` (per-track cache reuse when an unrelated track changes; cache
> pruning when a track drops out; `clear()` preserves the cache; `setRadius()`/`setData()` reuse
> behavior) and `tests/test_rf_fluid_collective_wiring.js` (new — boots the real app, proves
> `renderCollectiveData()` calls `setDataForTracks()` with genuine per-track entries and not the old
> single-blob `setData()`, that an unrelated track's `drawPoints` reference survives a re-render
> unchanged, and that `_clearRfFluid()` goes through `clear()` not `setData([], null)`). Verified the
> three new integration tests are not vacuous by running them against the pre-refactor code via `git
> stash` — all three fail there and pass on the refactored code. Full suite green (604 tests, 1
> pre-existing environment-gated skip unrelated to this change).

**Goal:** the "many tracks" scaling concern from the earlier discussion — `_precalculateSpatialFans()` (`rf_fluid_renderer.js:174`) recomputes fan-casting for *all* active tracks' points on every `setData()` call, including tracks that didn't change.

**Steps:**
1. Split `RFFluidRenderer` into `computeNodesForTrack(track)` (cached per track, invalidated only when that track's own `drawPoints`/GPS params change) and `combineAndRedraw(activeTracks)` (concatenate cached per-track node arrays + existing `redraw()`).
2. Wire `renderCollectiveData()` to call `computeNodesForTrack` only for tracks whose cache is stale, then always call the cheap combine step.

**Risk:** medium — the fan-casting math itself (`rf_fluid_renderer.js:174-260`) is unchanged, only the caching boundary moves; regression risk is mostly "did I cache at the right granularity."

**Verify:** existing `tests/` RF fluid test, extended to assert per-track cache reuse (e.g. via a call counter) when an unrelated track is toggled.

**Priority note:** this is a performance phase, not a stability one — sequence it after §4's test harness exists, and only if/when track counts in practice make it worth the risk. Not blocking on the correctness phases above.

### Phase 6 — Finish the rendering performance pass

> **Status:** two items landed ad-hoc ahead of this phase being written up, in
> response to a user-reported slowdown while zooming and adding a peak label
> (2026-08-07): **(a)** the p5 canvas mouse-wheel zoom handler
> (`sketch.js:mouseWheel`) is now rAF-coalesced — same `GSREvents.rafCoalesce()`
> pattern §1 already validated for the GSR/GPS sliders — instead of firing a
> full synchronous `redraw()` per wheel tick (trackpads fire ticks faster than
> a repaint completes, stacking up stutter). **(b)** `GSRUI.updatePeakLabel()`'s
> single-track path no longer calls the full `renderData()`; a new
> `GSRMapManager.refreshPeakMarkers()` rebuilds only the active track's
> peak/connector layers (+ cluster blobs, + a `updateMarkerVisibility()` pass),
> leaving path and hotspot layers untouched by reference, falling back to the
> full `renderData()` for the legacy no-track case. Found and fixed an
> adjacent pre-existing bug while adding it: `_renderPeakMarkers()` only
> tagged marker/connector layers with `_gsrKind` inside the `if (layerGroup)`
> branch, so peaks rendered via the legacy fallback were invisible to
> `getRenderLayers()`/`getPeakMarkerByIndex()`/`updateMarkerVisibility()`'s
> classification (hotspots already tagged unconditionally — peaks/connectors
> now match). Both covered by new tests in `tests/test_map_layer_ownership.js`
> (path/hotspot layers survive by reference, peak/connector layers are fully
> replaced with no orphans/duplicates, the no-track fallback still works, and
> the real `GSRUI.updatePeakLabel()` wiring is exercised end to end — not just
> the map.js method in isolation). Full detail, including what's deliberately
> *not* fixed yet, lives in the companion document
> `docs/visualizer_rendering_perf_routes.md` (top-of-doc 2026-08-07 update +
> §2.2's status note).
>
> **Step 1 (RF fan-cast spatial index) ✅ DONE (2026-08-07).**
> `_precalculateSpatialFans()` (`rf_fluid_renderer.js`) now buckets
> `buildingSegmentsGeo` into a uniform lat/lon grid once per call
> (`_buildSegmentGrid`, new) instead of linearly re-scanning every segment
> for every GPS node; the per-node candidate lookup (`_queryNearbySegments`,
> new) gathers only the segments in the grid cells overlapping that node's
> bounding box, then runs the exact same bbox filter over that smaller set —
> the filter logic and the ray/segment intersection math
> (`_raySegmentIntersectionGeo`) are untouched, only which segments get
> tested changes. Cell size is derived from `radiusMeters` and a
> representative latitude from the track's first valid point; correctness
> doesn't depend on the exact size (see `_buildSegmentGrid`'s doc comment) —
> only lookup cost does. New regression coverage:
> `tests/test_rf_fluid_spatial_index.js` — (1) byte-identical `cachedNodes`
> output between the grid path and a forced brute-force fallback
> (`_buildSegmentGrid` stubbed to return `null`, which routes
> `_precalculateSpatialFans` back to scanning `buildingSegmentsGeo` directly)
> on a fixture with nodes spread far apart and buildings clustered near only
> two of them; (2) a work-reduction check (spy on `_queryNearbySegments`,
> assert total candidates handed back across all node queries is less than
> `queries × totalSegments`); (3) a standalone `_buildSegmentGrid`/
> `_queryNearbySegments` unit test against a hand-rolled brute-force filter
> over several query boxes (corner, middle, cover-everything,
> cover-nothing). Verified none of the three are vacuous by simulating two
> broken variants outside the suite — an always-empty grid (caught by test
> 1's identical-output check) and a no-op grid that returns every segment
> regardless of bbox (caught by test 2's reduction check) — both correctly
> fail against the real assertions. Full suite green (607 tests, 1
> pre-existing environment-gated skip).
>
> **Step 2, `togglePeakExclusion()` + coloring-metric dropdown pieces ✅ DONE
> (2026-08-07)** — the collective-mode `renderCollectiveData()` piece is
> still open (see below). `togglePeakExclusion()` (`ui.js`) now calls
> `GSRMapManager.refreshPeakMarkers()` instead of the full `renderData()`,
> identical swap to the `updatePeakLabel()` fix it was already validated by.
> The coloring-metric dropdown (`events.js`, `mapColoringMetric` change
> handler) got a new `GSRMapManager.refreshPath()` (`map.js`, mirrors
> `refreshPeakMarkers()`'s shape exactly: strip only `_gsrKind === 'path'`
> layers from the active track's owned-layers registry + layerGroup, then
> re-run `_renderPathSegments()`) — wired in for single-track view only;
> collective mode still calls the existing `GSRUI.rerenderMap()` full
> rebuild, per the step's own scope note. Both fall back to the full
> `renderData()` for the legacy no-track case, same reasoning as
> `refreshPeakMarkers()`. New regression coverage in
> `tests/test_map_layer_ownership.js`: `togglePeakExclusion` end-to-end
> (peak/connector layers replaced, path/hotspot layers survive by
> reference); `refreshPath` unit tests (path layers replaced, peak/connector
> + hotspot layers survive by reference, no orphans/duplicates; falls back
> to `renderData()` with no active track); and the `mapColoringMetric`
> dropdown wired end-to-end through the real `events.js` handler (peak +
> hotspot layers survive a metric switch by reference). Verified non-vacuous
> by stashing the three production files and confirming exactly the 4 new
> behavior tests fail against pre-fix code (the two "falls back" tests still
> pass either way, as expected). Full suite green (611 tests, 1 pre-existing
> environment-gated skip).
>
> **Collective-mode `renderCollectiveData()` investigation (2026-08-07).**
> Before touching code, traced exactly what each of the three triggers above
> actually reads in collective mode, without assuming the single-track fix
> generalizes:
> - **Coloring-metric dropdown: nothing to do.** `activeColoringMetric` is
>   only read by `_renderPathSegments()` (single-track) and the single-track
>   legend branch. Collective mode's dashed per-track paths always use
>   `track.color`, and its legend branch is driven entirely by
>   `_collectiveTopographySource` — the dropdown has **zero visible effect**
>   in collective view today. (That means the existing full
>   `GSRUI.rerenderMap()` fallback the dropdown handler takes in collective
>   mode is pure wasted work with no correctness stake either way — a
>   separate, smaller finding than what this step was scoped to fix, left
>   as-is.)
> - **`togglePeakExclusion()`: confirmed NOT safe to scope down.**
>   `pk.excluded` is read directly by `generateContourSurface()`
>   (`collective_manager.js`, filters excluded peaks out of the density calc
>   when `topographySource === 'peaks'`) and by `renderCollectiveData()`'s
>   `allActivePeaksAcrossTracks` clustering input. Both are full-dataset
>   computations across every active track, not per-track — a correct
>   partial render would still need to re-run clustering and (when
>   peaks-sourced) the contour grid scan, which is most of the cost the
>   optimization exists to avoid. Left on the full `renderCollectiveData()`
>   rebuild; not worth the risk/complexity at this cost ratio.
> - **`updatePeakLabel()`: confirmed safe to scope down** — done, see below.
>   `peak.label` is never read by `generateContourSurface()` or by the
>   clustering input (both only touch `lat`/`lon`/`amplitude`/`excluded`).
>   Label-collision layout (`GSRLabelManager.computeLabelPositions`) is
>   computed **per-track**, inside `renderCollectiveData()`'s
>   `activeTracks.forEach` loop, not globally — one track's label edit can't
>   perturb another track's layout. Hotspot markers use a fixed icon
>   regardless of label, and popups are lazy thunks reading the live `peak`
>   object, so neither needs touching either.
>
> **Collective-mode `updatePeakLabel()` scoped refresh ✅ DONE (2026-08-07).**
> Extracted the per-track peak-marker+connector-line rendering block out of
> `renderCollectiveData()`'s `activeTracks.forEach` loop into a new private
> `_renderCollectiveTrackPeaks(track, layerGroup, trackColor, peakLatency,
> activePeaksSink)` (`map.js`) — `activePeaksSink` is the
> `allActivePeaksAcrossTracks` array when called from the full rebuild (so
> clustering still sees this track's peaks), or `null` when called from the
> new scoped refresh (so clustering is correctly left untouched, per the
> investigation above). New `GSRMapManager.refreshCollectivePeakMarkers(track,
> peakLatency)` mirrors `refreshPeakMarkers()`'s shape: strip only that
> track's `collectivePeak`/`collectiveConnector` layers, re-run
> `_renderCollectiveTrackPeaks()` for it alone, leave that track's own path/
> hotspots and every other track's entire layerGroup untouched by reference.
> Falls back to the full `GSRUI.updateCollectiveMap()` (debounced, same
> entry point every other collective-mode trigger already uses) when the
> track has no layerGroup yet. `ui.js`'s `updatePeakLabel()` now routes
> non-single-mode edits through this instead of the old unconditional
> `GSRUI.updateCollectiveMap()`. New regression coverage in
> `tests/test_map_layer_ownership.js`: refresh scoped to track A leaves A's
> own path/hotspot layers and track B's entire layerGroup untouched by
> reference, while A's peak/connector layers are fully replaced with no
> orphans/duplicates; falls back to a full rebuild for an unrendered track
> (awaited past the 150 ms `updateCollectiveMap()` debounce); and the real
> `ui.js` `updatePeakLabel()` wiring exercised end to end in collective mode
> with two tracks. Verified non-vacuous by stashing `map.js`/`ui.js` and
> confirming the new tests fail against pre-fix code (`refreshCollectivePeakMarkers
> is not a function`). Full suite green (614 tests, 1 pre-existing
> environment-gated skip). Step 3 below is still open.

**Goal:** close out the remaining items in `docs/visualizer_rendering_perf_routes.md` — real, measured-or-reasoned rendering costs distinct from Phase 5's specific RF fan-cast *caching* gap (complementary, not overlapping — see that document's §2.1 for how the two relate).

**Steps:**
1. **RF fan-cast spatial index** (perf-routes §2.1): `_precalculateSpatialFans()` (`rf_fluid_renderer.js:174`) linearly re-scans every building segment for every GPS node, on every settled GPS-slider-drag frame. Bucket `buildingSegmentsGeo` into a uniform spatial grid once per `setData()` call; per-node lookup becomes "gather segments from the 3×3 cells around this node" instead of a full scan. Self-contained to one method, no layer-ownership interaction — the strongest standalone candidate per that document's own priority ranking; do this one first.
2. **Finish the `renderData()` → `refreshPeakMarkers()` migration** (perf-routes §2.2 remainder): `togglePeakExclusion()` (`ui.js`) has the identical full-rebuild cost `updatePeakLabel()` had — same fix, already validated by the ad-hoc work above (swap the call site, extend the same `test_map_layer_ownership.js` pattern). Also extend the partial-render principle to the map-coloring-metric dropdown (`events.js:705-708`, which only needs a path repaint, not peaks/hotspots too) and to collective mode's `renderCollectiveData()` — bigger scope since it loops every active track, needs its own investigation rather than an assumed copy of the single-track fix.
3. **Investigate-only** (perf-routes §2.3, not sized yet): `GSRLabelManager.computeLabelPositions()` collision-avoidance cost on tracks with many *labeled* peaks (depends on step 2 landing first); `getRenderLayers()`/`_allTrackLayers()` rebuilding their classification arrays on every call (toggle-triggered, not drag-triggered — likely low priority until a specific toggle is reported sluggish with many tracks active). Profile against a large real track before scoping further; don't implement speculatively.

**Risk:** low for step 1 — pure lookup-acceleration, output unchanged (verify via identical `fanGeo` output before/after on a fixed fixture). Medium for step 2's collective-mode piece specifically — same layer-ownership contract the ad-hoc `refreshPeakMarkers()` work above already had to respect; the `togglePeakExclusion()`/dropdown pieces are low risk since they reuse an already-shipped, already-tested mechanism. Step 3 is measurement, not a code-risk item, until it's actually scoped.

**Verify:** step 1 — existing RF fluid test extended to assert identical output, plus a call-count/timing check proving the indexed path does less work. Step 2 — extend `tests/test_map_layer_ownership.js` the same way the `refreshPeakMarkers()` work already did, for each newly-migrated call site. Step 3 — no code changes without a profile first.

**Priority note:** sequence after Phase 5 (or interleaved — different methods in the same file, no conflict) and after Phase 4's test harness exists, so new perf regression tests have a home. Not blocking on Phase 3.

## 4. Suggested sequencing

```
Phase 0 (error safety net)  ──┐
Phase 4 (test harness)      ──┼── independent, do anytime, low risk
                               │
Phase 1 (track/map ownership) ── do next: fixes the actual bug class,
                               │   already designed, add regression test (Phase 4)
                               │
Phase 2 (self-validating caches) ── after Phase 1 proves the pattern works
                               │
Phase 3 (event notification)  ── only after 0–2 are stable; start with one pilot
                               │
Phase 5 (RF fan-cast caching) ── performance work, sequence whenever, not urgent
                               │
Phase 6 (finish perf pass)    ── after Phase 5 (or interleaved) + Phase 4;
                                   two items already landed ad-hoc, rest is
                                   the perf-routes doc's remaining survey
```

## 5. Open questions before starting

- Phase 2: does every `analyzer`/`collectiveManager` mutation actually funnel through a small enough set of setters to make a generation counter reliable? Needs a grep audit before committing to the approach (see Phase 2, step 4 risk note).
- Phase 3: is the four-event set (`trackAdded`/`trackRemoved`/`activeTrackChanged`/`viewModeChanged`) actually sufficient, or will `updateCollectiveMap()`'s debounce (`ui.js:414`) need its own event/coalescing story once multiple listeners can independently trigger it?
- Phase 4: confirm none of the 19 existing test scripts have undocumented ordering dependencies (e.g. shared IndexedDB state from `osm_cache.js` tests) before wiring them into one sequential runner.
- Phase 6: is collective mode's `renderCollectiveData()` partial-render migration (step 2) worth the risk on its own, or should it wait until a user actually reports collective-mode sluggishness the way the single-track case was reported? The single-track fix landed reactively, not speculatively — the collective-mode piece risks being speculative unless there's a concrete report to size it against.
