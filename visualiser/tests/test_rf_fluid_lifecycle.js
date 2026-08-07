/**
 * Gap-fill unit tests for rf_fluid_renderer.js (RFFluidRenderer) covering the
 * constructor/canvas-lifecycle/option-setter methods NOT already exercised by
 * tests/test_rf_fluid.js (setData/_precalculateSpatialFans/_normDbm/ray-cast
 * math) or tests/test_rf_svg_export.js (exportToSvgElements). Those two files
 * already give the numerically-significant logic solid coverage; this file
 * fills in: constructor wiring, _initCanvas/_bindEvents/resizeCanvas,
 * setMode/setOpacity/setRadius/setVisible.
 *
 * RFFluidRenderer talks to a real Leaflet map + canvas in the browser — here
 * it's driven with a minimal hand-rolled Leaflet/DOM stub (no jsdom needed;
 * the class only touches a handful of specific Leaflet/DOM APIs, all mocked
 * below to match exactly what the source code calls).
 *
 * Run: node --test tests/test_rf_fluid_lifecycle.js
 */

const assert = require('assert');
const test = require('node:test');

// ── Minimal Leaflet (`L`) stub — only what RFFluidRenderer actually calls ──
global.L = {
  DomUtil: {
    create: (tag, className) => ({ tag, className, style: {} }),
    setPosition: () => {},
    setTransform: () => {},
  },
};
global.window = { devicePixelRatio: 1 };

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'rf_fluid_renderer.js'), 'utf8');
// rf_fluid_renderer.js declares `class RFFluidRenderer { ... }` with no
// module.exports at all (unlike the files touched elsewhere in this pass) —
// load it via vm the same way several pre-existing tests in this suite do
// for un-exported classes, rather than editing production source just to
// add an export hook for a class with no guard either way already.
const vm = require('vm');
vm.runInThisContext(src.replace('class RFFluidRenderer', 'global.RFFluidRenderer = class RFFluidRenderer'), { filename: 'rf_fluid_renderer.js' });
const RFFluidRenderer = global.RFFluidRenderer;

function makeFakeMap(overrides = {}) {
  const panes = {};
  const listeners = {};
  return Object.assign({
    getPane: (name) => panes[name] || null,
    createPane: (name) => { panes[name] = { style: {}, appendChild: () => {} }; return panes[name]; },
    on: (evt, fn) => { listeners[evt] = fn; },
    getBounds: () => ({
      pad: () => ({
        getNorthWest: () => ({ lat: 51.51, lon: -0.11 }),
        getSouthEast: () => ({ lat: 51.50, lon: -0.10 }),
      }),
    }),
    latLngToLayerPoint: (ll) => ({ x: 100, y: 100 }),
    getZoomScale: () => 1,
    getZoom: () => 15,
    getSize: () => ({ x: 800, y: 600 }),
    _latLngToNewLayerPoint: () => ({ x: 0, y: 0 }),
  }, overrides);
}

// redraw() is the actual 2D canvas drawing routine and calls a large surface
// of the CanvasRenderingContext2D API (clearRect/save/restore/gradients/
// paths/etc). Rather than enumerate every method it happens to call today
// (brittle — a rendering tweak would silently need a matching mock update),
// a Proxy auto-mocks any method as a no-op and any property read as a
// harmless default, so redraw() can run to completion without throwing.
// This intentionally does NOT verify *what* gets drawn — that's canvas
// pixel output, not something worth unit-testing here — only that the
// setter methods (setMode/setOpacity/setRadius/setVisible) can safely
// trigger a redraw without crashing.
function fakeCanvasContext() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'canvas') return { width: 400, height: 300 };
      return (...args) => {
        // Methods that create sub-objects (gradients, patterns) need to
        // return something with an addColorStop-shaped API of their own.
        if (String(prop).startsWith('create')) {
          return new Proxy({}, { get: () => () => {} });
        }
        return undefined;
      };
    },
  });
}

test('constructor: merges default options with overrides and initializes empty state', () => {
  const map = makeFakeMap();
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;

  const renderer = new RFFluidRenderer(map, { opacity: 0.5, mode: '815' });
  assert.strictEqual(renderer.options.opacity, 0.5, 'override should win');
  assert.strictEqual(renderer.options.mode, '815', 'override should win');
  assert.strictEqual(renderer.options.radiusMeters, 35, 'unspecified option keeps its default');
  assert.deepStrictEqual(renderer.drawPoints, []);
  assert.strictEqual(renderer.enabled, true);
});

test('constructor: creates the rfFluidPane once and reuses it on a second instance', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });

  new RFFluidRenderer(map);
  assert.ok(map.getPane('rfFluidPane'), 'pane should have been created');
  const paneAfterFirst = map.getPane('rfFluidPane');

  new RFFluidRenderer(map); // second instance, same map
  assert.strictEqual(map.getPane('rfFluidPane'), paneAfterFirst, 'pane should not be recreated');
});

test('constructor: with no map, skips canvas init without throwing', () => {
  assert.doesNotThrow(() => {
    const renderer = new RFFluidRenderer(null);
    assert.strictEqual(renderer.canvas, null);
  });
});

test('constructor: with map but no global L, skips canvas init without throwing', () => {
  const realL = global.L;
  delete global.L;
  assert.doesNotThrow(() => {
    const renderer = new RFFluidRenderer(makeFakeMap());
    assert.strictEqual(renderer.canvas, null);
  });
  global.L = realL;
});

test('resizeCanvas: sizes the canvas to the padded viewport in device pixels', () => {
  const map = makeFakeMap({
    latLngToLayerPoint: (ll) => (ll.lat === 51.51 ? { x: 0, y: 0 } : { x: 200, y: 150 }),
  });
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;
  global.window.devicePixelRatio = 2;

  const renderer = new RFFluidRenderer(map);
  assert.strictEqual(canvasEl.width, 400, 'width should be scaled by devicePixelRatio');
  assert.strictEqual(canvasEl.height, 300);
  assert.strictEqual(canvasEl.style.width, '200px');
  assert.strictEqual(canvasEl.style.height, '150px');

  global.window.devicePixelRatio = 1;
});

test('resizeCanvas: enforces a 10px minimum canvas dimension for degenerate viewports', () => {
  const map = makeFakeMap({ latLngToLayerPoint: () => ({ x: 0, y: 0 }) }); // NW === SE → 0x0 viewport
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;

  new RFFluidRenderer(map);
  assert.strictEqual(canvasEl.width, 10);
  assert.strictEqual(canvasEl.height, 10);
});

test('_bindEvents: wires zoomanim and moveend/zoomend/resize/viewreset handlers without throwing when triggered', () => {
  const listeners = {};
  const map = makeFakeMap({ on: (evt, fn) => { listeners[evt] = fn; } });
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });

  const renderer = new RFFluidRenderer(map);
  assert.ok(typeof listeners['zoomanim'] === 'function');
  assert.ok(typeof listeners['moveend zoomend resize viewreset'] === 'function');

  assert.doesNotThrow(() => listeners['moveend zoomend resize viewreset']());
  assert.doesNotThrow(() => listeners['zoomanim']({ zoom: 16, center: { lat: 0, lon: 0 } }));
});

test('setMode: updates options.mode and triggers a redraw (no throw with an empty canvas)', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  assert.doesNotThrow(() => renderer.setMode('fog'));
  assert.strictEqual(renderer.options.mode, 'fog');
});

test('setOpacity: updates options.opacity and triggers a redraw', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  assert.doesNotThrow(() => renderer.setOpacity(0.2));
  assert.strictEqual(renderer.options.opacity, 0.2);
});

test('setRadius: updates options.radiusMeters and re-precalculates fans for every previously-set track', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  // Phase 5: fan-casting is cached per track (setDataForTracks), so setRadius()
  // no longer unconditionally recomputes — it replays the last tracks data,
  // and each track's cache entry now mismatches on radiusMeters. Seed two
  // tracks first so there's something for setRadius() to actually re-run.
  renderer.setDataForTracks([
    { id: 'a', drawPoints: [{ lat: 0, lon: 0 }], osmGeoms: null },
    { id: 'b', drawPoints: [{ lat: 1, lon: 1 }], osmGeoms: null },
  ]);

  // Spy on the instance (own-property override shadows the prototype method)
  // so we can prove _precalculateSpatialFans() is actually invoked by
  // setRadius(), not just that radiusMeters got written and nothing threw.
  let fansRecalculated = 0;
  renderer._precalculateSpatialFans = () => { fansRecalculated++; return []; };

  assert.doesNotThrow(() => renderer.setRadius(60));
  assert.strictEqual(renderer.options.radiusMeters, 60);
  assert.strictEqual(fansRecalculated, 2, 'setRadius should re-run _precalculateSpatialFans once per previously-set track');

  // A second setRadius() call with the SAME radius should be a no-op recompute
  // (every entry's radiusMeters now matches again) — proves the cache check,
  // not just that setRadius() always forces work.
  fansRecalculated = 0;
  renderer.setRadius(60);
  assert.strictEqual(fansRecalculated, 0, 'setRadius with an unchanged radius should reuse cached fans');
});

// ── _precalculateSpatialFans spatial-downsampling: scaled to radiusMeters ──
// Reported bug: single-track SVG export of a real GPS-sampled track (points
// only ~0.1-3m apart depending on pace/sample rate) came out as a flat white
// halo hugging the whole track — traced to _precalculateSpatialFans's
// node-spacing downsample being a FIXED 6m regardless of the configured RF
// radius. At the default 35m radius, 6m spacing put consecutive fan centers
// only ~17% of a radius apart, so thousands of near-total-overlap fans got
// screen-blended together, saturating to solid white. A first fix
// (radiusMeters * 0.4) reduced but didn't remove the saturation — screen()
// compositing saturates fast (screen(0.5,0.5) is already 0.75), so leaving
// fans still overlapping by ~80% of their radius just shrank the white area
// rather than fixing it. Landed on radiusMeters * 1.2: spacing exceeds the
// radius, so only IMMEDIATE neighbors overlap (next-nearest neighbors are
// more than a diameter apart), capping how many fans can stack on any one
// point. These tests pin the resulting node counts directly, not just "some
// thinning happens somewhere."
function makeStraightLinePoints(n, spacingMeters) {
  // Straight line along longitude at the equator, where 1 degree = ~111,320m
  // exactly (cosLat = 1), so spacingMeters converts to degrees with no
  // latitude-dependent distortion to account for in the test's own math.
  const degPerMeter = 1 / 111320;
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ lat: 0, lon: i * spacingMeters * degPerMeter });
  }
  return pts;
}

test('_precalculateSpatialFans: points closer than the radius-scaled threshold are thinned (default 35m radius)', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map); // default radiusMeters: 35 -> threshold 42m

  // 100 points spaced 3m apart (~walking-pace GPS sampling) spans 300m total
  // — at a 42m thinning threshold that collapses to ~8 kept nodes
  // (ceil(300/42)+1), a world away from the old fixed-6m behavior which
  // would have kept every other point (~50 nodes).
  const drawPoints = makeStraightLinePoints(100, 3);
  renderer.setData(drawPoints, null);

  assert.ok(renderer.cachedNodes.length < 15,
    `expected radius-scaled thinning (42m @ 35m radius) to keep well under 15 of 100 points spaced 3m apart, got ${renderer.cachedNodes.length}`);
  assert.ok(renderer.cachedNodes.length >= 5,
    `thinning should not collapse a 300m-long line down to fewer than ~5 nodes, got ${renderer.cachedNodes.length}`);
});

test('_precalculateSpatialFans: thinning threshold scales up with a larger configured radius', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map, { radiusMeters: 100 }); // threshold: 120m

  const drawPoints = makeStraightLinePoints(100, 3); // same 300m-long fixture as above
  renderer.setData(drawPoints, null);

  // At a 120m threshold, a 300m line fits at most ~4 kept nodes — fewer
  // than the 35m-radius case above, proving the threshold actually tracks
  // radiusMeters rather than being some other fixed constant.
  assert.ok(renderer.cachedNodes.length <= 4,
    `expected a 100m-radius renderer's 120m thinning threshold to keep <= 4 nodes on a 300m line, got ${renderer.cachedNodes.length}`);
});

test('_precalculateSpatialFans: an isRfPeak point always gets its own node, even inside the thinning radius', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map); // threshold: 42m

  // Two points only 3m apart (well inside the 42m threshold) — the second
  // would normally be thinned away, EXCEPT it's flagged as a momentary RF
  // spike, which this dedup must never silently erase.
  const drawPoints = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: (3 / 111320), isRfPeak: true },
  ];
  renderer.setData(drawPoints, null);

  assert.strictEqual(renderer.cachedNodes.length, 2, 'an isRfPeak point must survive thinning regardless of spacing');
});

test('setVisible: toggles canvas display style and redraws only when becoming visible', () => {
  const map = makeFakeMap();
  const canvasEl = { style: {}, getContext: () => fakeCanvasContext() };
  global.L.DomUtil.create = () => canvasEl;
  const renderer = new RFFluidRenderer(map);

  // Spy on the instance so the "redraws only when becoming visible" claim
  // is actually checked, not just the display style / options flag (which
  // don't depend on rf_fluid_renderer.js:385's `if (visible) this.redraw()`
  // branch at all).
  let redrawCount = 0;
  renderer.redraw = () => { redrawCount++; };

  renderer.setVisible(false);
  assert.strictEqual(canvasEl.style.display, 'none');
  assert.strictEqual(renderer.options.visible, false);
  assert.strictEqual(redrawCount, 0, 'becoming invisible should not trigger a redraw');

  renderer.setVisible(true);
  assert.strictEqual(canvasEl.style.display, 'block');
  assert.strictEqual(renderer.options.visible, true);
  assert.strictEqual(redrawCount, 1, 'becoming visible should trigger exactly one redraw');
});

// ── Phase 5: per-track fan-cast cache (setDataForTracks) ───────────────────
//
// The whole point of the refactor: _precalculateSpatialFans() is the expensive
// step (O(points x rays x building segments)), so a track whose drawPoints/
// osmGeoms reference didn't change since the last setDataForTracks() call must
// NOT pay that cost again, even when a DIFFERENT track in the same call did
// change. These tests spy on _precalculateSpatialFans by track identity (via
// the drawPoints array passed in) to prove that, not just that nothing throws.

function countingRenderer(map) {
  const renderer = new RFFluidRenderer(map);
  const calls = []; // each entry: the drawPoints array passed to _precalculateSpatialFans
  const real = renderer._precalculateSpatialFans.bind(renderer);
  renderer._precalculateSpatialFans = (drawPoints, ...rest) => {
    calls.push(drawPoints);
    return real(drawPoints, ...rest);
  };
  renderer.__calls = calls;
  return renderer;
}

test('setDataForTracks: reuses a cached track\'s fans when only an unrelated track changes', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = countingRenderer(map);

  const drawPointsA = [{ lat: 10, lon: 10 }];
  const drawPointsB1 = [{ lat: 20, lon: 20 }];

  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: drawPointsA, osmGeoms: null },
    { id: 'trackB', drawPoints: drawPointsB1, osmGeoms: null },
  ]);
  assert.strictEqual(renderer.__calls.length, 2, 'first call: both tracks are new, both recompute');

  // Re-render with trackA's array reference unchanged (the real map.js caller
  // gets this from _getOrBuildDrawPoints()'s own cache) and trackB replaced by
  // a genuinely new array (e.g. a GPS slider drag on track B).
  renderer.__calls.length = 0;
  const drawPointsB2 = [{ lat: 21, lon: 21 }];
  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: drawPointsA, osmGeoms: null },
    { id: 'trackB', drawPoints: drawPointsB2, osmGeoms: null },
  ]);

  assert.strictEqual(renderer.__calls.length, 1, 'only the changed track (B) should recompute');
  assert.strictEqual(renderer.__calls[0], drawPointsB2, 'the one recompute should be for track B\'s new data');
});

test('setDataForTracks: combines cached and freshly-computed nodes into one cachedNodes array', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: [{ lat: 10, lon: 10 }], osmGeoms: null },
    { id: 'trackB', drawPoints: [{ lat: 20, lon: 20 }], osmGeoms: null },
  ]);
  assert.strictEqual(renderer.cachedNodes.length, 2, 'one node per track on first render');

  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: [{ lat: 10, lon: 10 }], osmGeoms: null }, // same id, new array -> recomputes
    { id: 'trackB', drawPoints: renderer._trackCache.get('trackB').drawPointsRef, osmGeoms: null }, // reused ref
  ]);
  assert.strictEqual(renderer.cachedNodes.length, 2, 'combined output still has one node per track');
});

test('setDataForTracks: drops cache entries for tracks no longer present (e.g. deleted/deactivated)', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = new RFFluidRenderer(map);

  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: [{ lat: 10, lon: 10 }], osmGeoms: null },
    { id: 'trackB', drawPoints: [{ lat: 20, lon: 20 }], osmGeoms: null },
  ]);
  assert.strictEqual(renderer._trackCache.size, 2);

  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: [{ lat: 10, lon: 10 }], osmGeoms: null },
  ]);
  assert.strictEqual(renderer._trackCache.size, 1, 'trackB\'s cache entry should be pruned once it drops out');
  assert.ok(!renderer._trackCache.has('trackB'));
  assert.strictEqual(renderer.cachedNodes.length, 1);
});

test('clear(): blanks cachedNodes/buildingPolygons and redraws, without touching the per-track fan cache', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = countingRenderer(map);

  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: [{ lat: 10, lon: 10 }], osmGeoms: null },
  ]);
  assert.strictEqual(renderer.cachedNodes.length, 1);
  assert.strictEqual(renderer._trackCache.size, 1);

  let redrawCount = 0;
  const realRedraw = renderer.redraw.bind(renderer);
  renderer.redraw = () => { redrawCount++; realRedraw(); };

  renderer.clear();
  assert.strictEqual(renderer.cachedNodes.length, 0, 'clear() blanks the visible nodes');
  assert.strictEqual(redrawCount, 1, 'clear() triggers exactly one redraw');
  assert.strictEqual(renderer._trackCache.size, 1, 'clear() must NOT prune the per-track fan cache — a real setData(For Tracks) call right after (map.js clearMap()->render pattern) needs it intact to skip recomputing unchanged tracks');

  // Prove the cache survival actually matters: re-supplying the SAME track
  // right after clear() should not recompute its fans.
  renderer.__calls.length = 0;
  renderer.setDataForTracks([
    { id: 'trackA', drawPoints: renderer._trackCache.get('trackA').drawPointsRef, osmGeoms: null },
  ]);
  assert.strictEqual(renderer.__calls.length, 0, 'the track re-supplied unchanged right after clear() should reuse its cached fans');
  assert.strictEqual(renderer.cachedNodes.length, 1, 'cachedNodes is repopulated from the surviving cache entry');
});

test('setData(): single-track wrapper still reuses cached fans when the same drawPoints reference is passed again', () => {
  const map = makeFakeMap();
  global.L.DomUtil.create = () => ({ style: {}, getContext: () => fakeCanvasContext() });
  const renderer = countingRenderer(map);

  const drawPoints = [{ lat: 10, lon: 10 }];
  renderer.setData(drawPoints, null);
  assert.strictEqual(renderer.__calls.length, 1);

  renderer.__calls.length = 0;
  renderer.setData(drawPoints, null);
  assert.strictEqual(renderer.__calls.length, 0, 'unchanged drawPoints reference should skip recompute, same as the old fast path');
  assert.strictEqual(renderer.cachedNodes.length, 1);
});
