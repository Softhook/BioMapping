# GSR Map Visualiser — Rendering Performance: Possible Routes for Speed-Up

> **Living document.** This is a survey of options, not a commitment to do any
> of them — nothing here is scheduled. Update as items are picked up, ruled
> out, or superseded by code changes. Scope: `visualiser/` track/path/layer
> rendering (`map.js`, `rf_fluid_renderer.js`, `renderer.js`, the slider event
> wiring in `events.js`). Companion to
> `visualizer_architecture_refactor_plan.md` — that document's Phase 5 (RF
> fan-cast cross-track caching) is one of the routes below; see §2.1 for how
> it relates to the other RF finding here.

## 1. Current state — what's already optimized

A read-through of the rendering path (2026-08-07) found it already carries
real optimization work, most of it recent (see the RF-desync and
peaks/hotspots-survive-track-removal fix commits). Worth recording so future
passes don't "fix" things that are already handled:

- **Slider drags are rAF-coalesced**, not per-`input`-event. `GSREvents.rafCoalesce()`
  (`events.js:92-104`) wraps both GSR-filter sliders (`bindGsrSlider`) and
  GPS-filter sliders (`bindGpsSlider`) so a fast native `input` stream
  collapses to one heavy re-render per animation frame, with the label text
  still updating synchronously outside the wrapped call.
- **GPS pipeline results are cached** by `GSRMapManager._getOrBuildDrawPoints()`
  (`map.js:560-619`), keyed by a hash of the GPS params + a snapped-GPS
  fingerprint (`_hashGpsParams`, `_snapFingerprint`). A GSR-only slider change
  (which doesn't touch GPS params) returns the *same array reference* —
  this matters because `RFFluidRenderer.setData()` (§2) uses reference
  equality to skip its own recompute.
- **Path coloring batches same-bucket runs into one polyline**, not one per
  point-pair: `_renderPathSegments()` (`map.js:877-1001`) precomputes a
  30-bucket color LUT once per render (`MapColors.getColorLut`), then walks
  each GPS-gap segment extending a batch while consecutive points land in the
  same bucket, emitting one `L.polyline` per batch. A reusable `latlngsBuf`
  array is cleared and refilled per batch rather than reallocated (comment at
  `map.js:935` — explicit GC-pressure reduction).
- **Peak popups are lazy.** Both `_renderPeakMarkers()` and
  `renderCollectiveData()` call `marker.bindPopup(() => this._buildSinglePeakPopup(...))`
  — a thunk, not a pre-built HTML string — so popup DOM is only built if the
  user actually opens it, not for every peak on every render.
  `_renderClusters()` similarly defers concave-blob math to sigma/proximity
  actually being active (only runs when `activePeaks.length > 0`).
  Both peak and hotspot markers reuse one shared `L.divIcon` instance
  (`_buildPeakIcon()` / `_buildHotspotIcon()`) for the common unlabeled case
  rather than building a new icon per marker.
- **RF fluid canvas redraw is viewport-clipped and event-driven, not a render
  loop.** `redraw()` (`rf_fluid_renderer.js:416-592`) only projects/draws
  nodes and building polygons whose lat/lon fall inside `map.getBounds().pad(0.3)`,
  and is only invoked on `moveend`/`zoomend` and explicit option changes
  (`rf_fluid_renderer.js:83`) — there is no `requestAnimationFrame` ticker
  running continuously.
- **Auto-fit-bounds is gated on track-identity change**, not run on every
  re-render — `renderData()` (`map.js:659-664`) and `renderCollectiveData()`
  (`map.js:2025-2034`) both compare a signature (active track id / sorted
  active-track-id-set) against the last-fit value, so nudging a slider while
  zoomed into a detail view doesn't yank the viewport back out.

None of the above needs touching. The routes below are what's left.

## 2. Possible routes

### 2.1 RF fan-cast building-segment lookup is unindexed — `rf_fluid_renderer.js:174-285`

**What:** `_precalculateSpatialFans()` loops every downsampled GPS node
(~1 per 6 m of track) and, for each node, linearly scans **all**
`buildingSegmentsGeo` twice — once for the bbox `nearbySegments` filter
(`rf_fluid_renderer.js:225-233`), once per ray (up to `numRays`, default 24)
for the actual ray/segment intersection test against whatever survived the
filter (`rf_fluid_renderer.js:245-251`). Cost is
O(nodes × segments) for the filter pass, worse for the intersection pass in
dense building areas where the bbox filter doesn't shrink `nearbySegments`
much. There's no spatial index (grid, quadtree) — every node re-scans the
full segment list.

**When it fires:** `setData()` short-circuits to a cheap `redraw()` when the
`drawPoints` array reference is unchanged (§1's GPS cache reference-equality
trick) — so GSR-only slider drags don't hit this. GPS-filter slider drags
*do* produce a new `drawPoints` reference each settled frame (still
rAF-coalesced to one per frame, not per raw `input` event), so this cost is
paid once per frame during a GPS-slider drag, for the full point set of
whichever track(s) are active. On a long track through a dense OSM building
area (city center), this is the most likely place to feel a stutter — not a
runaway loop, but real work on the main thread on every settled drag frame.

**Fix sketch:** bucket `buildingSegmentsGeo` into a uniform spatial grid once
per `setData()` call (segments are already rebuilt there from `osmGeoms`, so
this is a natural place to also grid-index them), sized to roughly
`radiusMeters` per cell. Per-node lookup becomes "gather segments from the
3×3 (or so) cells around this node" instead of a full scan. The ray/segment
intersection math itself (`_raySegmentIntersectionGeo`) doesn't change —
only which segments get tested.

**Impact:** high for dense-building + long-track combinations, near-zero for
sparse areas (nearbySegments is already small there, so the filter pass is
cheap regardless).

**Effort:** small-to-medium — self-contained to one method, no interaction
with the Leaflet layer/track-ownership model that Phase 1–3 of the
architecture refactor plan are concerned with.

**Risk:** low. The grid is a pure lookup-acceleration structure; output
(which segments are tested per node) is unchanged, just computed faster. Easy
to verify by asserting identical `fanGeo` output before/after on a fixed
fixture.

**Relation to Phase 5 of the architecture refactor plan:** that phase targets
a *different* redundancy — recomputing fan-casts for tracks that didn't
change when *any* active track's data changes in collective view (fix:
per-track result caching, so an unrelated track toggle doesn't recompute
everyone). This route targets the cost of a *single* track's computation
itself. They're complementary and independent — either can land first, and
landing this one first would make Phase 5's remaining "compute one track's
fans" cost cheaper too.

### 2.2 `renderData()` always does a full clear + rebuild, even for changes that only affect one layer kind

**What:** every call to `renderData()` (`map.js:631-709`) starts with
`this.clearMap()` and rebuilds path segments, peak markers, *and* hotspot
markers unconditionally. But not every trigger needs all three:
- The map-coloring-metric dropdown (`events.js:705-708`) only changes how
  the path is colored — peak/hotspot marker positions and popups are
  identical before and after, yet they're destroyed and rebuilt anyway.
- `togglePeakExclusion()` (`ui.js:193-208`) changes one peak's excluded
  state — same full rebuild.

**When it fires:** dropdown/checkbox-driven, not drag-driven, so this is
infrequent compared to §2.1 — but each occurrence does real work (`L.marker`
+ `L.divIcon` construction, popup thunk binding, label collision placement
via `GSRLabelManager.computeLabelPositions`) for every peak on the track,
including hundreds/thousands-of-peaks tracks the `_renderPeakMarkers` comment
at `map.js:1233` explicitly anticipates.

**Fix sketch:** split `renderData()` into independently-callable
`_renderPath()` / `_renderPeaks()` / `_renderHotspots()` (the private methods
already exist as this shape internally) and have callers request only what
changed — e.g. a `renderData(analyzer, gpsParams, { only: 'path' })` option
for the coloring-metric case.

**Impact:** low-to-medium — bounded by how large a single track's peak/hotspot
count gets in practice; likely most noticeable on the "hundreds/thousands of
peaks" tracks the codebase's own comments call out.

**Effort:** medium — touches the shared `clearMap()`/layer-group-ownership
contract that `tests/test_map_layer_ownership.js` and Phase 1 of the
architecture refactor plan were specifically written to pin down, so any
change here needs to keep that contract intact (partial-clear must still
leave no orphaned layers).

**Risk:** medium, for the reason above — this is exactly the kind of "N call
sites must each remember to do M things" surface the architecture refactor
plan's §1.2 warns about; a partial-rebuild path is a second way for a layer
kind to go missing if not done carefully.

### 2.3 Not investigated in depth — lower-confidence candidates

Flagged during the read-through but not traced far enough to size the
payoff. Listed so a future pass doesn't have to rediscover them from
scratch:

- **`_renderPeakMarkers` / `renderCollectiveData` label placement**
  (`GSRLabelManager.computeLabelPositions`, called at `map.js:1229` and
  `map.js:1922`) runs collision avoidance across all labeled peaks on every
  full rebuild. Only matters if a track has many *labeled* (not just
  detected) peaks — likely a small fraction of the "hundreds/thousands of
  peaks" case, so probably low priority, but not measured.
  Depends on §2.2 landing before it would apply.
- **`getRenderLayers()` / `_allTrackLayers()`** (`map.js:398-457`) rebuild
  their classification arrays by iterating every track's owned-layers list
  on every call. Called from `updateMarkerVisibility()` (toggle buttons),
  `focusOnPeak()`'s marker lookup, and the SVG exporter — all
  interaction-triggered, not drag-triggered, so likely not worth touching
  unless a specific toggle is reported as sluggish with many tracks active.

## 3. Suggested priority if picked up

§2.1 (RF fan-cast segment index) is the strongest standalone candidate:
self-contained, low risk, and targets the one place a continuous *drag*
interaction (not just a discrete click/toggle) does unindexed O(n×m) work.
§2.2 is real but lower-frequency and higher-risk given the layer-ownership
contract it touches — better sequenced after, and ideally validated against
the same `test_map_layer_ownership.js`-style regression tests used for
Phase 1 of the architecture refactor plan. §2.3 items need actual profiling
against a large real track before they're worth scoping further.
