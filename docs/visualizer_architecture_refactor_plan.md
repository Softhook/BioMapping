# GSR Map Analyzer — Stability Refactor Plan

> **Living document.** This is a forward plan, not a status report — update phase
> status as work lands, and correct anything that turns out wrong once touched.
> Scope: `gsr-map-analyzer/` only (the browser-based track/RF visualizer), not
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

`gsr-map-analyzer/tests/` has 19 plain Node scripts (pipelines, deconvolution,
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

### Phase 0 — Global error safety net

**Goal:** make failures visible instead of silent, with minimal behavior change.

**Steps:**
1. Add one `window.onerror` + `window.addEventListener('unhandledrejection', …)` handler (new small file, e.g. `error_handler.js`, loaded early in `index.html`) that logs consistently and surfaces a visible, non-blocking notice (reuse the existing file-status/toast UI pattern already used elsewhere, e.g. `GSRTrackManager.setFileStatus`) rather than failing silently.
2. Add a small `GSRErrors.report(err, context)` helper and migrate the worst offenders — the silent `catch (_) {}` sites in `map_exporter.js:992,1004,1037,1190` — to at least log through it. Leave the deliberate graceful-fallback catches (`osm_cache.js`) alone; those are intentional, not bugs.
3. Do **not** touch the 22 `alert()` call sites in this phase — that's a UX change (blocking alerts → toasts) worth doing but separable from "add a safety net," and mixing the two makes this phase harder to review.

**Risk:** very low — additive only, no existing behavior changes except the silent-catch sites gaining a log line.

**Verify:** manually throw inside a render path (temporary) and confirm the notice appears instead of a silent stuck UI; confirm existing `alert()` flows are unaffected.

### Phase 1 — Track/map rendering ownership model

**Goal:** eliminate the specific flat-array-drift pattern in `GSRMapManager` that caused the original bug, for the map specifically.

**Steps:** (designed in the prior conversation, restated here for the record)
1. Give each track object (currently a plain `{id, name, analyzer, enabled, color, …}` in `AppState.collectiveManager.tracks`) an `L.layerGroup()` as its single rendering handle for path/peak/hotspot layers.
2. Track removal/deactivation = `map.removeLayer(track.layerGroup)` — one call, structurally can't leave a piece behind.
3. `GSRMapManager` stops owning `pathSegments`/`peakMarkers`/`collectivePathSegments`/etc. as flat arrays; it diffs the active-track set against the last render and calls `track.render()`/`track.clear()` only for tracks that changed.
4. Aggregate layers (RF fluid combination, contours, spatial clustering) stay owned by `GSRMapManager` since they're genuinely cross-track computations, not per-track — but always route through the now-single `clearAll()`/render path so they can't be forgotten.

**Risk:** medium — touches `renderCollectiveData()` (`map.js`) and the track object shape (`collective_manager.js`, `tracks.js`) directly.

**Verify:** the existing manual repro (add N tracks, toggle/remove in various orders and both view modes, confirm no stale layers of any kind) plus a new automated regression test (see Phase 4).

### Phase 2 — Collapse manual-invalidation caches to self-validating state

**Goal:** apply the Phase 1 principle (state that can't go stale by construction) to the `_cachedEnvStats` family from §1.2, the highest-call-count instance of the pattern.

**Steps:**
1. Attach a version/generation counter to the data source (`analyzer`/`collectiveManager`) that increments on any mutation already funneled through a small number of setter paths.
2. Change the cache read (`ui.js:1005,1188,1386-1389`) to check the stored generation against the current one and recompute automatically on mismatch, instead of trusting a null-check that depends on 9 call sites remembering to null it.
3. Once the read side self-validates, the 9 `invalidateEnvironmentalCache()` call sites become redundant and can be deleted rather than maintained.
4. Leave `_gpsCache` and `_lastFitBoundsTrackId/Set` alone — both are already keyed/compared in a way that makes staleness self-correcting (see §1.2 table), lower priority.

**Risk:** medium — need to confirm every mutation path actually funnels through the counter; a missed mutation path is the same failure mode as a missed invalidation call, just relocated. Worth grepping for direct `analyzer.raw =` / `peaks.push` style mutations that bypass any setter before committing to this approach.

**Verify:** new regression test asserting stats reflect a mutation made through every known mutation path (peak label edit, GPS param change, track add/remove, environmental enrichment).

### Phase 3 — Minimal event notification between rendering surfaces

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

### Phase 5 — RF fan-cast caching (performance, not correctness)

**Goal:** the "many tracks" scaling concern from the earlier discussion — `_precalculateSpatialFans()` (`rf_fluid_renderer.js:174`) recomputes fan-casting for *all* active tracks' points on every `setData()` call, including tracks that didn't change.

**Steps:**
1. Split `RFFluidRenderer` into `computeNodesForTrack(track)` (cached per track, invalidated only when that track's own `drawPoints`/GPS params change) and `combineAndRedraw(activeTracks)` (concatenate cached per-track node arrays + existing `redraw()`).
2. Wire `renderCollectiveData()` to call `computeNodesForTrack` only for tracks whose cache is stale, then always call the cheap combine step.

**Risk:** medium — the fan-casting math itself (`rf_fluid_renderer.js:174-260`) is unchanged, only the caching boundary moves; regression risk is mostly "did I cache at the right granularity."

**Verify:** existing `tests/` RF fluid test, extended to assert per-track cache reuse (e.g. via a call counter) when an unrelated track is toggled.

**Priority note:** this is a performance phase, not a stability one — sequence it after §4's test harness exists, and only if/when track counts in practice make it worth the risk. Not blocking on the correctness phases above.

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
```

## 5. Open questions before starting

- Phase 2: does every `analyzer`/`collectiveManager` mutation actually funnel through a small enough set of setters to make a generation counter reliable? Needs a grep audit before committing to the approach (see Phase 2, step 4 risk note).
- Phase 3: is the four-event set (`trackAdded`/`trackRemoved`/`activeTrackChanged`/`viewModeChanged`) actually sufficient, or will `updateCollectiveMap()`'s debounce (`ui.js:414`) need its own event/coalescing story once multiple listeners can independently trigger it?
- Phase 4: confirm none of the 19 existing test scripts have undocumented ordering dependencies (e.g. shared IndexedDB state from `osm_cache.js` tests) before wiring them into one sequential runner.
