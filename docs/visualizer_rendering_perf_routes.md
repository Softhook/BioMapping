# GSR Map Visualiser — Rendering Performance: Possible Routes for Speed-Up

> **Living document.** This is a survey of options, not a commitment to do any
> of them — nothing here is scheduled. Update as items are picked up, ruled
> out, or superseded by code changes. Scope: `visualiser/` track/path/layer
> rendering (`map.js`, `rf_fluid_renderer.js`, `renderer.js`, the slider event
> wiring in `events.js`). Companion to
> `visualizer_architecture_refactor_plan.md` — that document's Phase 5 (RF
> fan-cast cross-track caching) is one of the routes below; see §2.1 for how
> it relates to the other RF finding here.

> **2026-08-07 update:** a user report of "extreme slowdowns with zooming and
> adding label" traced to two concrete causes, now both fixed:
> 1. **p5 canvas mouse-wheel zoom wasn't rAF-coalesced** (`sketch.js:mouseWheel`)
>    — outside this doc's original scope (sketch.js, not map.js/events.js), but
>    the same class of issue §1 already solved for GSR/GPS sliders. Trackpads
>    fire wheel ticks faster than `redraw()` (synchronous full `draw()` under
>    `noLoop()`) can keep up with, so a zoom gesture stacked up many full
>    repaints before the browser could paint any of them — read as a stutter/
>    freeze. Fixed by wrapping the repaint (not the state update, which stays
>    synchronous) in `GSREvents.rafCoalesce()`, capping it to one repaint per
>    animation frame — the exact pattern §1 already validated.
> 2. **§2.2 below, for the label-edit case specifically**: `GSRUI.updatePeakLabel()`
>    (`ui.js`) no longer calls `renderData()`. It calls a new
>    `GSRMapManager.refreshPeakMarkers()` (`map.js`) that rebuilds only the
>    active track's peak/connector layers (+ cluster blobs, + a
>    `updateMarkerVisibility()` pass) — path and hotspot layers are left
>    untouched by reference. Falls back to the full `renderData()` when there's
>    no resolvable managed track (the legacy no-track fallback, whose layers
>    aren't tagged per-track so a scoped removal isn't possible). While adding
>    this, found and fixed an adjacent pre-existing bug it exposed: in that
>    same legacy fallback, `_renderPeakMarkers()` only tagged marker/connector
>    layers with `_gsrKind` *inside* the `if (layerGroup)` branch, so
>    fallback-rendered peaks were invisible to `getRenderLayers()` /
>    `getPeakMarkerByIndex()` / `updateMarkerVisibility()`'s classification
>    (hotspots already tagged unconditionally — peaks/connectors now match that
>    pattern). Regression coverage: three new tests in
>    `tests/test_map_layer_ownership.js` (path/hotspot layers survive by
>    reference, peak/connector layers are fully replaced with no orphans/
>    duplicates, the no-track fallback still renders correctly, and the real
>    `GSRUI.updatePeakLabel()` wiring — not just the map.js method in
>    isolation — is exercised end to end). `togglePeakExclusion()` (`ui.js`)
>    had the identical `renderData()`-does-a-full-rebuild issue noted below and
>    was deliberately left alone in this pass — same fix would apply, not done
>    without being asked. (Update: fixed in the Phase 6 step 2 pass below —
>    this paragraph is left as-is as the record of that pass's own scoping
>    decision.) Collective-mode label edits (`GSRUI.updateCollectiveMap()` →
>    `renderCollectiveData()`) also still do a full rebuild; not in scope of
>    this pass either, nor of Phase 6 step 2.

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

> **Status: landed (2026-08-07).** See the architecture refactor plan's
> Phase 6 step 1 status note for full detail. Summary: `buildingSegmentsGeo`
> is now grid-indexed once per `_precalculateSpatialFans()` call
> (`_buildSegmentGrid`), and each node's candidate-segment lookup queries
> that grid (`_queryNearbySegments`) instead of scanning the full segment
> list. Output is unchanged (verified byte-identical against a forced
> brute-force fallback) — only the lookup cost changes. Regression coverage:
> `tests/test_rf_fluid_spatial_index.js`.

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

> **Status: landed for every case that turned out to need it (2026-08-07).**
> The label-edit, exclusion-toggle, and single-track coloring-metric cases
> are fixed. Collective mode's `renderCollectiveData()` was investigated
> trigger-by-trigger rather than assumed to need the same treatment: the
> coloring-metric dropdown turns out not to affect collective view at all
> (nothing to fix), the exclusion toggle turns out to feed global clustering
> + the contour surface so it correctly keeps the full rebuild, and the
> label-edit case turns out to be genuinely safe to scope down and is now
> fixed too. See the architecture refactor plan's Phase 6 step 2 status note
> for the full trigger-by-trigger trace.

**What:** every call to `renderData()` (`map.js:631-709`) starts with
`this.clearMap()` and rebuilds path segments, peak markers, *and* hotspot
markers unconditionally. But not every trigger needs all three:
- The map-coloring-metric dropdown (`events.js`) only changes how the path
  is colored — peak/hotspot marker positions and popups are identical before
  and after, yet they were destroyed and rebuilt anyway. ~~**Fixed**~~ — new
  `GSRMapManager.refreshPath()` handles single-track view. Collective mode
  needs no fix: `activeColoringMetric` is never read there (collective paths
  are always `track.color`, the collective legend is driven by
  `_collectiveTopographySource` instead) — the dropdown has zero visible
  effect in collective view, so its existing full-rebuild fallback there is
  wasted work but not a correctness gap worth this pass's scope.
- ~~`togglePeakExclusion()` (`ui.js`) changes one peak's excluded state —
  same full rebuild.~~ **Fixed** for single-track — swapped to
  `refreshPeakMarkers()`. **Deliberately NOT fixed for collective mode**:
  `pk.excluded` is read by both `generateContourSurface()`
  (`collective_manager.js`, when `topographySource === 'peaks'`) and
  `renderCollectiveData()`'s clustering input, both full-dataset
  computations across every active track — a correct partial render would
  still need to re-run most of that work, for a much smaller win than the
  single-track case.
- ~~`updatePeakLabel()` changes one peak's label~~ — **fixed**, single-track
  (see above) **and now collective mode too**: traced every collective-mode
  consumer of peak data and confirmed none of them — clustering, the
  contour surface, or per-track label-collision layout (computed per-track,
  not globally) — read `peak.label`, so a new
  `GSRMapManager.refreshCollectivePeakMarkers(track, peakLatency)` can
  safely rebuild just the edited track's peak/connector layers.

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

### 2.4 `refreshPeakMarkers()` (single-track) recomputed spatial-cluster blobs on every call — found via benchmarking, landed 2026-08-07

> **Status: landed (2026-08-07).** Full detail, including the exact fix and
> its regression coverage, lives in the architecture refactor plan's Phase 6
> status note — summary below.

**What:** discovered while measuring §2.2's fix with real A/B timing
(`tests/manual/_bench_render_perf.js`), not from a read-through. On a real
284-peak track, `refreshPeakMarkers()` (`map.js`) was only ~1.1x faster than
the full `renderData()` rebuild it replaced for a peak-label edit — far
below collective mode's ~204x for the equivalent case (§2.2). A cost
breakdown traced the gap to `GSRSpatialClustering.clusterPeaks()` +
concave-blob generation, called unconditionally from inside
`_renderPeakMarkers()` (the method both `renderData()` and
`refreshPeakMarkers()` call) — ~33ms of the ~36ms total on that fixture.
`refreshCollectivePeakMarkers()` (collective mode's equivalent scoped
refresh) already avoided this exact cost, by passing `activePeaksSink =
null` into `_renderCollectiveTrackPeaks()` so clustering is skipped — the
single-track path had never been given an equivalent option. `clusterPeaks()`
only reads `lat`/`lon`/`amplitude` per active (non-excluded) peak — provably
unaffected by a label edit, so the recompute was pure waste on that trigger.

**Fix:** `_renderPeakMarkers(analyzer, data, peakLatency, track, options)`
gained an `options.skipClustering` guard around the whole cluster-boundary
block; `refreshPeakMarkers(analyzer, gpsParams, options)` threads it through
and also skips clearing `this.clusterLayers` when set (the existing blobs
are already correct). `ui.js`'s `updatePeakLabel()` passes
`{ skipClustering: true }` for the single-track case. `togglePeakExclusion()`
deliberately does **not** — excluding a peak changes `activePeaks`, which
feeds `clusterPeaks()` directly, so that trigger must keep recomputing (same
distinction §2.2 already drew for collective mode's exclusion vs. label-edit
triggers).

**Measured impact:** single-track peak-label edit went from ~1.1x to **~29x**
faster than the full `renderData()` rebuild (re-run via the same bench
script) — isolating `skipClustering`'s own contribution from §2.2's
already-landed path/hotspot skip shows it alone accounts for ~27x of that.

**Regression coverage:** three new tests in `tests/test_map_layer_ownership.js`
(a label edit leaves `mapManager.clusterLayers` untouched by reference,
verified non-vacuous against pre-fix code; an exclusion toggle still visibly
recomputes it; `refreshPeakMarkers({ skipClustering: true })` still replaces
peak/connector layers exactly like the default call) — needed a new boot
helper since the suite's usual harness nulls `GSRSpatialClustering` entirely
for every other test in that file.

### 2.5 `loop()` runs the full p5 `draw()` pipeline continuously at ~60fps for the entire time a single track is being viewed — found and landed 2026-08-07

> **Status: landed (2026-08-07).** Fix sketch option 2 (below) was the one
> implemented, at the user's suggestion to explore a standalone animation
> rather than throttling the loop: the hotspot pulse ring is now a real DOM
> element (`.graph-hotspot-pulse`, `styles.css`) inside a
> `#hotspotPulseOverlay` div absolutely positioned over `#canvasContainer`,
> animated with the map's own existing `@keyframes pulse-glow` — the same
> keyframe `.hotspot-glow-ring` already used, so the graph and the map pulse
> identically, now for the same reason (a CSS animation, not a JS re-render)
> instead of just the same hand-tuned curve. `GSRRenderer._syncPulseRing()` /
> `_prunePulseRings()` / `clearPulseRings()` (`renderer.js`) create/reposition/
> remove these divs only when `drawHotspotMarkers()` actually runs (i.e. on
> an on-demand `redraw()`), not every frame — the compositor keeps the
> animation going by itself in between. `_drawHotspotPulseRing()` (the old
> per-frame canvas painter) is deleted.
>
> With the pulse animation no longer needing continuous frames, both
> `loop()` call sites (`tracks.js:351`, `events.js:813`) were removed
> outright — the canvas is back to strictly on-demand `redraw()`, same as
> every other interactive path in this codebase.
>
> This surfaced a real dependency that wasn't obvious until the loop was
> actually removed: with no continuous loop, hovering the mouse over the
> graph (without dragging) stopped updating the tooltip/scrubber/map-cursor,
> because `handleScrubber()` only runs inside `draw()` and nothing had ever
> called `redraw()` on plain mouse movement — the 60fps loop had been
> silently doing that job too. Fixed by adding a `mouseMoved()` handler
> (`sketch.js`), rAF-coalesced with the same `GSREvents.rafCoalesce()`
> pattern used for sliders/wheel-zoom, plus an explicit `redraw()` on
> `mouseleave` so the scrubber/tooltip don't stick at their last position
> when the mouse exits the canvas.
>
> Verified live (Playwright against the real app, not just unit tests): 0
> `draw()` calls over a 2s idle window with a track loaded (previously ~120
> at 60fps); hovering without clicking still updates
> `AppState.hoveredIndex` and clears correctly on mouse-leave; the pulse-ring
> divs are correctly created/repositioned/pruned/cleared by
> `_syncPulseRing()`/`_prunePulseRings()`/`clearPulseRings()`, and computed
> `opacity`/`transform` were sampled 500ms apart to confirm the CSS
> animation genuinely progresses on its own — confirmed both synthetically
> (forced ring positions) and by driving the exact real
> `redraw()` → `draw()` → `drawHotspotMarkers()` path with real peaks
> promoted to hotspots. The demo dataset itself has no GPS-resolvable
> hotspots, so this pass couldn't eyeball an organically-detected hotspot —
> two peaks were manually flagged with fake GPS coords to exercise the
> exact same code path a real hotspot would take.
>
> The user then hit this for real and initially reported the graph's
> hotspots weren't pulsing (while the *map's* independent, pre-existing
> hotspot pulse — unrelated CSS, untouched by this change — was visible)
> — root cause was a stale cached `styles.css` (no build step/bundler in
> this app, so a plain browser reload doesn't always pick up an edited
> stylesheet); a hard refresh fixed it and confirmed the mechanism works
> as designed. Worth remembering for any future CSS-only change here: this
> app has no cache-busting, so "reload and it doesn't look different" isn't
> proof the change didn't ship.
>
> Follow-up suitability review (prompted by "will this DOM approach cause
> problems?"), checking the actual risk areas rather than re-asserting it
> works:
> - **Panel fullscreen** (`layout_manager.js`'s `setupPanelFullscreen`)
>   moves the *entire* `#gsrPanel` subtree — including `#canvasContainer`
>   and the pulse overlay inside it — into a new wrapper via `appendChild()`.
>   That's a DOM move, not a destroy/recreate, so the overlay's positioning
>   (relative to `#canvasContainer`, which travels with it) and each ring's
>   running CSS animation both survive the transition intact. Checked, not
>   just assumed.
> - **Chart PNG export** (`GSRUI.saveCanvasImage()`) calls `canvasEl.toBlob()`
>   directly on the raw `<canvas>` bitmap — a real, permanent behavior
>   change: exported chart images will no longer contain the hotspot pulse
>   ring at all (previously whatever phase happened to be mid-render at
>   export time got baked into the canvas pixels). Arguably an improvement —
>   a static export capturing a random half-faded ring was never something
>   anyone was relying on — but worth knowing about if it's ever reported as
>   "the exported chart looks different now."
> - **Lost cross-hotspot pulse sync**: the old canvas version computed one
>   `pulsePhase` per `draw()` call and used it for every ring that frame, so
>   every hotspot pulsed in *exact* lockstep, guaranteed, by construction
>   (explicitly called out in the removed code's doc comment). CSS
>   animations instead start their own clock from whenever each element was
>   inserted — rings created in the same `drawHotspotMarkers()` pass (the
>   common case: a track's hotspots all appearing together on first load)
>   stay in sync since they're inserted in the same synchronous pass, but a
>   ring created later (panning a new hotspot into view, switching tracks)
>   starts on its own clock, out of phase with rings already running. Purely
>   cosmetic — no functional impact — and not fixed in this pass since it
>   wasn't reported as noticeable, but the fix if it ever is: a
>   negative `animation-delay` computed from `performance.now() % 2000` at
>   creation time, so every new ring's clock is phase-aligned to a shared
>   reference instant instead of to its own insertion time.
> - **No prior regression coverage existed** for any of this (the project's
>   jsdom test harness has no rendering/DOM-drawing coverage at all
>   pre-existing — `tests/test_map_layer_ownership.js` covers Leaflet layer
>   ownership, not the p5/DOM canvas side). Added
>   `tests/test_hotspot_pulse_overlay.js`: create/reuse-by-key/reposition,
>   a distinct key creates a distinct element, `_prunePulseRings()` removes
>   only untouched keys (DOM *and* the internal `Map`, not just one or the
>   other), `clearPulseRings()` empties both, `drawPlaceholder()` clears
>   stale rings, and toggling `showHotspots` off clears rings left over from
>   before the toggle. Verified non-vacuous by stashing the fix and
>   confirming all 7 fail against pre-fix `renderer.js` (`_syncPulseRing is
>   not a function`). Deliberately does NOT assert real CSS animation
>   behavior (opacity/transform over time, lockstep sync) — jsdom has no CSS
>   engine, so those assertions would be meaningless; that class of check is
>   what the live-browser pass above is for. `npm test` is now 644 tests,
>   still green.

**What:** `GSRTrackManager.switchActiveTrack()` (`tracks.js:351`) and the
"Single View" button handler (`events.js:813`) both call p5's `loop()` and
never call the matching `noLoop()` — the only places that turn it back off
are deleting every track (`tracks.js:188`/`213`) or switching to Collective
view (`events.js:853`). Every other interactive path in this codebase
(sliders, drags, wheel zoom, toggles) is careful to render on demand via
`redraw()` under `noLoop()` — this is the one place that instead leaves the
canvas in a continuous animation-frame loop. `frameRate()` is never called
to throttle it, so it runs at the display's native refresh rate (typically
60fps).

Traced the reason `loop()` exists at all: `GSRRenderer.drawHotspotMarkers()`
→ `_drawHotspotPulseRing()` animates a pulsing ring around each hotspot
marker using `(millis() % 2000) / 2000` as phase — a genuine continuous
animation that needs repeated frames. `AppState.showHotspots` defaults to
`true` (`app_state.js:85`), so this isn't an opt-in feature — most tracks
with any fast/high-amplitude peaks have at least one hotspot, and hotspots
are visible out of the box.

**When it fires:** as soon as any track is loaded/selected and the single
track view is showing — i.e. the default, primary way this app is used, for
the entire duration it's open, not just during a drag or a click. This is
the single most "used all the time" path found in this whole review: every
other item in this document only costs something while the user is actively
interacting (dragging, zooming, toggling); this one costs something
constantly, including while the user is doing nothing at all — just reading
the stats panel.

**The actual cost:** the full `draw()` body runs every frame, not just the
pulse rings — grid/axis drawing, three signal curves
(`drawSignalCurve` ×3, already decimated to `DRAW_MAX_VERTICES` but still
real per-vertex work), `drawPeakMarkers()` iterating every in-view peak
(color computation, dot/line drawing per peak — the codebase's own comments
call out "hundreds/thousands of peaks" tracks as the expected upper bound),
`handleScrubber()`, and `drawTimelineOverview()`. All of that reruns 60
times a second to animate what's usually a handful of small pulsing circles.

**Fix sketch:** a few options, roughly increasing in effort/payoff:
1. Cheapest: only call `loop()` when hotspots are both toggled on *and* at
   least one falls in the current view (`AppState.showHotspots &&
   memorableEvents.some(p => !_peakOutOfView(p, viewStartTime, viewEndTime))`),
   re-checking on pan/zoom/toggle instead of unconditionally on track switch;
   falls back to `noLoop()` + on-demand `redraw()` otherwise (the majority of
   idle viewing time even when hotspots exist somewhere in the recording but
   the user has panned/zoomed away from them).
2. Better: stop redrawing the *entire* canvas for the pulse and instead
   layer just the pulsing rings on a second, cheap overlay (e.g. a small
   `<canvas>` positioned over the marker positions, or draw everything else
   once into an offscreen buffer and only re-composite the rings each frame)
   — keeps the animation smooth without paying for the static content 60x/sec.
3. Throttle instead of eliminate: `frameRate(10-15)` while looping — the CSS
   `@keyframes pulse-glow` this mirrors (per the code comment) is likely
   already a slow pulse, so a lower cap would be visually indistinguishable
   from 60fps while cutting the constant cost by 4-6x.

**Impact:** high — this is a continuous background cost, not a one-off, so
even a modest per-frame saving compounds over an entire viewing session
(battery/CPU on laptops, fan noise, contention with other tabs). Fixing it
removes work that currently never stops rather than just making occasional
work faster.

**Effort:** small for option 1 (condition-gate the existing `loop()` calls
and add pan/zoom/toggle re-checks), medium for option 2 (introduces a second
render surface).

**Risk:** low-to-medium — needs to preserve "hotspot ring pulses when a
hotspot is on screen" exactly, and needs to correctly re-enter/exit loop
mode on every path that can change what's in view (pan, zoom, toggle
`showHotspots`, switch tracks, delete the last hotspot) without leaving a
stale loop running or a hotspot silently not pulsing. Same class of "N call
sites must all remember to do the right thing" risk §2.2 flagged for the
layer-ownership contract — worth its own small regression test (e.g. assert
`isLooping()`-equivalent state after each of those triggers) rather than
manual-only verification.

### 2.6 `clearThemeCache()` forces a style recalc on every single `draw()` frame, not just on actual theme/resize changes

> **Status: landed (2026-08-07).** Fix sketch below was applied verbatim —
> the `GSRRenderer.clearThemeCache()` call at `sketch.js:58` was deleted.
> The resize-triggered clear in `layout_manager.js:140` is unaffected and
> remains the only invalidation path. Verified via the same live-browser
> pass as §2.5: rendered colors (curve/grid/peak colors) look correct in
> screenshots taken after this change, and `npm test` stays green.

**What:** `draw()` (`sketch.js:58`) unconditionally calls
`GSRRenderer.clearThemeCache()` as its first line, every frame. That forces
the next `getThemeColor()` call to re-run
`window.getComputedStyle(document.documentElement)` — a synchronous style
recalculation — against the full `styles.css` cascade (~54KB). The cache is
otherwise reused correctly within a frame (all the `getThemeColor()` calls
in one `draw()` share one `getComputedStyle()` result), and
`GSRLayoutManager.resizeCanvas()` (`layout_manager.js:140`) already
separately clears it on resize, which is a real invalidation trigger. But
there is no theme-toggle mechanism anywhere in this codebase (no
`prefers-color-scheme` media query, no `matchMedia` listener, no dark-mode
class toggle found) — the CSS custom properties `getThemeColor()` reads
never change after page load, so busting the cache every frame invalidates
something that is, in the app's current state, invariant for the life of
the page.

**When it fires:** every `draw()` call — i.e. every `redraw()` anywhere in
the app, plus (see §2.5) 60x/sec for the entire time a single track is
being viewed. Compounds §2.5 directly: fixing §2.5 alone still leaves this
paying a style-recalc cost on whatever reduced frame rate replaces it;
fixing this alone removes a real per-frame cost regardless of whether §2.5
is also fixed.

**Fix sketch:** delete the `GSRRenderer.clearThemeCache()` call at
`sketch.js:58`. The resize-triggered clear in `layout_manager.js:140`
remains as the (currently only meaningful) invalidation path. If dark-mode
support is ever added, its toggle handler would need to call
`clearThemeCache()` itself at that point — not a regression risk today since
no such handler exists to lose.

**Impact:** medium on its own (one `getComputedStyle()` call is not huge in
isolation), but high combined with §2.5 since it currently runs 60x/sec
during normal single-track viewing, unconditionally.

**Effort:** trivial — one line removed.

**Risk:** low. Easy to verify: confirm rendered colors are unaffected by
diffing a screenshot/canvas pixel sample before and after across a resize
event (the one remaining invalidation path) still picking up the change
correctly.

## 3. Suggested priority if picked up

**§2.5 and §2.6 both landed 2026-08-07**, ahead of §2.1 in this list despite
being found later — they were the only items in this document that cost
something *constantly* (the entire time the app's primary single-track view
is open, including while fully idle) rather than only during active
dragging/clicking, so they outweighed §2.1's previous "strongest standalone
candidate" ranking once found. See their status notes above for what
shipped and how it was verified.

§2.1 (RF fan-cast segment index) remains a strong, already-scoped,
self-contained, low-risk candidate: the one place a continuous *drag*
interaction (not just a discrete click/toggle) does unindexed O(n×m) work.
§2.2 is real but lower-frequency and higher-risk given the layer-ownership
contract it touches — better sequenced after, and ideally validated against
the same `test_map_layer_ownership.js`-style regression tests used for
Phase 1 of the architecture refactor plan. §2.3 items need actual profiling
against a large real track before they're worth scoping further. §2.4,
found via real A/B timing rather than a read-through, landed the same
session it was found (~1.1x → ~29x measured on the same trigger) —
proof that this document's own real-timing approach is worth repeating
against the still-open items above, not just the read-through-and-reason
method that flagged them originally.
