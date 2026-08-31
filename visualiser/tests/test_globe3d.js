/**
 * Unit tests for src/map/globe3d.js (the embedded 3D globe engine).
 *
 * GSRGlobeManager is a construct / render / destroy lifecycle that makes no
 * assumption it owns the page — index.html's 3D-surface panel is the only host
 * (see src/map/globe3d_view.js). These lock in:
 *   - the module-level helpers (seriesValue, SERIES_FIELD, BASEMAP_PROVIDERS),
 *   - `keyboardFlight: false` really suppresses the window key listeners,
 *   - destroy() removes every listener the constructor added and tears the viewer down,
 *   - renderData needs host-supplied drawPoints (this class never runs the GPS chain),
 *   - the wall colours from a bounded LUT and batches its geodesy,
 *   - WebGL context-loss recovery.
 *
 * Cesium is replaced by a small auto-stub; no real WebGL viewer is created.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const GLOBE3D = path.join(APP_DIR, 'src', 'map', 'globe3d.js');

// ── A minimal Cesium stand-in ───────────────────────────────────────────────
// Any property access yields a callable/constructable stub; chained calls
// (Color.fromCssColorString(x).withAlpha(y)) just keep returning stubs.
function autoStub() {
  const fn = function () { return autoStub(); };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'isDestroyed') return () => false;
      return autoStub();
    },
    apply() { return autoStub(); },
    construct() { return autoStub(); },
  });
}

/** Fresh window/document spies + Cesium stub for one manager instance. */
function freshEnv() {
  const listeners = [];
  const rafQueue = [];
  global.window = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    // deterministic rAF — the test drives frames via flushRaf()
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: (id) => { if (id) rafQueue[id - 1] = null; },
  };
  global.window.__flushRaf = () => { const q = rafQueue.splice(0); q.forEach((fn) => fn && fn()); };
  global.document = {
    activeElement: null,
    createElement: () => autoStub(),
    body: { appendChild() {}, removeChild() {} },
  };

  const viewer = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
    scene: autoStub(),
    camera: autoStub(),
    clock: { onTick: { addEventListener: () => () => {} } },
    entities: { add: () => ({}), remove: () => {} },
    imageryLayers: { removeAll() {}, addImageryProvider() {} },
  };
  const Cesium = autoStub();
  Cesium.Viewer = function () { return viewer; };
  Cesium.Ion = { defaultAccessToken: '' };
  global.Cesium = Cesium;

  return { listeners, viewer };
}

function loadFresh() {
  delete require.cache[require.resolve(GLOBE3D)];
  return require(GLOBE3D);
}

test('exports the manager and the module-level helpers', () => {
  freshEnv();
  const m = loadFresh();
  assert.strictEqual(typeof m.GSRGlobeManager, 'function');
  assert.strictEqual(typeof m.seriesValue, 'function');
  assert.ok(m.SERIES_FIELD && typeof m.SERIES_FIELD === 'object');
  assert.ok(m.BASEMAP_PROVIDERS && typeof m.BASEMAP_PROVIDERS === 'object');
});

test('public API the page depends on is present', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const proto = GSRGlobeManager.prototype;
  for (const method of [
    'renderData', 'destroy', 'setColoringMetric', 'setExtrusionScale', 'togglePeaks',
    'toggleHotspots', 'toggleLabels', 'toggleClusters',
    'setBasemap', 'toggle3DBuildings', 'apply3DBuildingStyle', 'toggle3DRf',
    'flyToTrack', 'toggleOrbit', 'setViewPerspective', 'resetNorth',
    'setScrubPosition', 'onPeakClick',
  ]) {
    assert.strictEqual(typeof proto[method], 'function', `missing ${method}()`);
  }
});

test('seriesValue unwraps {val} objects, passes numbers, zeroes the rest', () => {
  freshEnv();
  const { seriesValue } = loadFresh();
  assert.strictEqual(seriesValue({ time: 1, val: 3.5 }), 3.5);
  assert.strictEqual(seriesValue(7), 7);
  assert.strictEqual(seriesValue(null), 0);
  assert.strictEqual(seriesValue(undefined), 0);
  assert.strictEqual(seriesValue({}), 0);
});

test('_getMetricSeries: derived field, then raw-GSR fallback', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c');
  const analyzer = {
    phasic: [{ val: 1 }, { val: 2 }, { val: 3 }],
    raw: [{ gsr: 10 }, { gsr: 20 }],
  };
  assert.deepStrictEqual(mgr._getMetricSeries(analyzer, 'phasic'), [1, 2, 3]);
  assert.deepStrictEqual(mgr._getMetricSeries(analyzer, 'gsr'), [10, 20]);
  assert.deepStrictEqual(mgr._getMetricSeries({ raw: [] }, 'phasic'), []);
  mgr.destroy();
});

test('keyboardFlight: false adds no window key listeners; true (default) does', () => {
  {
    const { listeners } = freshEnv();
    const { GSRGlobeManager } = loadFresh();
    const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
    assert.deepStrictEqual(listeners.filter((l) => l.type.startsWith('key')), []);
    mgr.destroy();
  }
  {
    const { listeners } = freshEnv();
    const { GSRGlobeManager } = loadFresh();
    const mgr = new GSRGlobeManager('c');
    const keys = listeners.filter((l) => l.type === 'keydown' || l.type === 'keyup');
    assert.strictEqual(keys.length, 2, 'keydown + keyup bound by default');
    mgr.destroy();
  }
});

test('destroy() removes the window listeners and tears the viewer down', () => {
  const { listeners, viewer } = freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c');
  assert.ok(listeners.some((l) => l.type === 'keydown'));

  mgr.destroy();
  assert.deepStrictEqual(listeners.filter((l) => l.type.startsWith('key')), []);
  assert.strictEqual(viewer.destroyed, true);
  assert.strictEqual(mgr.viewer, null);
  mgr.destroy(); // idempotent
});

test('requestRenderMode: default off (continuous); opt-in on for an embedded host', () => {
  freshEnv();
  let seen = null;
  const origViewer = global.Cesium.Viewer;
  global.Cesium.Viewer = function (id, o) { seen = o; return origViewer(id, o); };
  const { GSRGlobeManager } = loadFresh();

  const a = new GSRGlobeManager('c', { keyboardFlight: false });
  assert.strictEqual(seen.requestRenderMode, false, 'standalone default: continuous render');
  a.destroy();

  seen = null;
  const b = new GSRGlobeManager('c', { keyboardFlight: false, requestRenderMode: true });
  assert.strictEqual(seen.requestRenderMode, true, 'embedded host: render on demand');
  assert.strictEqual(seen.maximumRenderTimeChange, Infinity);
  b.destroy();
});

test('render-on-demand host: _wakeRenderLoop bursts continuous, then retires to on-demand', async () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false, requestRenderMode: true, idleRenderMs: 20 });
  const scene = mgr.viewer.scene;
  scene.requestRenderMode = true;

  mgr._wakeRenderLoop();
  assert.strictEqual(scene.requestRenderMode, false, 'interaction drops the scene to continuous rendering');

  await new Promise((r) => setTimeout(r, 45));
  assert.strictEqual(scene.requestRenderMode, true, 'idle timer hands the scene back to render-on-demand');
  assert.strictEqual(mgr._idleRenderTimer, null);
  mgr.destroy();
});

test('_wakeRenderLoop is inert for a continuous host and while a 360° orbit owns the loop', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();

  const cont = new GSRGlobeManager('c', { keyboardFlight: false }); // requestRenderMode off
  cont.viewer.scene.requestRenderMode = true;
  cont._wakeRenderLoop();
  assert.strictEqual(cont.viewer.scene.requestRenderMode, true, 'continuous host: bridge never touches requestRenderMode');
  cont.destroy();

  const emb = new GSRGlobeManager('c', { keyboardFlight: false, requestRenderMode: true });
  emb._isOrbiting = true;
  emb.viewer.scene.requestRenderMode = true;
  emb._wakeRenderLoop();
  assert.strictEqual(emb.viewer.scene.requestRenderMode, true, 'no burst while an orbit is running');
  emb.destroy();
});

test('destroy() cancels a pending idle-retire timer', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false, requestRenderMode: true });
  mgr._wakeRenderLoop();
  assert.notStrictEqual(mgr._idleRenderTimer, null, 'timer armed by the interaction');
  mgr.destroy();
  assert.strictEqual(mgr._idleRenderTimer, null, 'timer cleared on teardown');
});

// ── HiDPI render resolution ─────────────────────────────────────────────────

test('viewer renders at devicePixelRatio x a constant resolutionScale (default 1.2)', () => {
  const { viewer } = freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });

  assert.strictEqual(viewer.useBrowserRecommendedResolution, false, 'honours devicePixelRatio');
  assert.strictEqual(viewer.resolutionScale, 1.2, 'default supersample factor');
  mgr.destroy();
});

test('resolutionScale option overrides the default; it is held constant (no per-frame watcher)', () => {
  const { viewer } = freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false, resolutionScale: 1 });

  assert.strictEqual(viewer.resolutionScale, 1);
  // No dynamic-resolution machinery left to leak.
  assert.strictEqual(mgr._resolutionRemover, undefined);
  assert.strictEqual(mgr._resInputHandlers, undefined);
  assert.strictEqual(mgr._resolutionSettleTimer, undefined);
  mgr.destroy();
});

test('360° orbit lowers render resolution for its duration, restores the normal scale on stop', () => {
  const { viewer } = freshEnv();
  // startOrbit does a little geodesy — shim just the bits the auto-stub can't
  // coerce to a number, leave the rest as stubs.
  viewer.camera = { heading: 0, lookAt() {}, lookAtTransform() {} };
  global.Cesium.Cartesian3 = { distance: () => 1000 };
  global.Cesium.Math = { toRadians: (d) => (d * Math.PI) / 180 };
  global.Cesium.HeadingPitchRange = function () {};

  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', {
    keyboardFlight: false, resolutionScale: 1.2, orbitResolutionScale: 0.8,
  });
  mgr.currentDrawPoints = [
    { lon: 0, lat: 0, time: 0, origIdx: 0 },
    { lon: 0.01, lat: 0.01, time: 1, origIdx: 1 },
  ];
  assert.strictEqual(viewer.resolutionScale, 1.2);

  mgr.startOrbit();
  assert.strictEqual(mgr._isOrbiting, true);
  assert.strictEqual(viewer.resolutionScale, 0.8, 'orbit runs at the lower scale');

  mgr.stopOrbit();
  assert.strictEqual(mgr._isOrbiting, false);
  assert.strictEqual(viewer.resolutionScale, 1.2, 'normal scale restored on stop');
  mgr.destroy();
});

test('renderData needs host-supplied drawPoints — it never runs a GPS chain', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c');

  let wallCalls = 0;
  mgr._render3DWallAndPath = () => { wallCalls++; };
  mgr.flyToTrack = () => {};

  // no drawPoints -> warn + bail, nothing drawn
  let warned = 0;
  mgr._notifyWarn = () => { warned++; };
  mgr.renderData({ raw: [{}, {}], peaks: [] }, {}, {});
  assert.strictEqual(wallCalls, 0, 'nothing rendered without host drawPoints');
  assert.strictEqual(warned, 1);

  // host drawPoints -> used verbatim
  const drawPoints = [
    { lat: 51.5, lon: -0.1, time: 0, origIdx: 0 },
    { lat: 51.6, lon: -0.2, time: 1, origIdx: 1 },
  ];
  mgr.renderData({ raw: [{}, {}], peaks: [] }, {}, { drawPoints });
  assert.strictEqual(wallCalls, 1);
  assert.strictEqual(mgr.currentDrawPoints, drawPoints);
  mgr.destroy();
});

test('renderData({ isPreview: true }) suppresses the fly-to', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c');
  mgr._render3DWallAndPath = () => {};
  let flew = 0;
  mgr.flyToTrack = () => { flew++; };
  const drawPoints = [
    { lat: 0, lon: 0, time: 0, origIdx: 0 }, { lat: 1, lon: 1, time: 1, origIdx: 1 },
  ];
  mgr.renderData({ raw: [{}, {}], peaks: [] }, {}, { drawPoints, isPreview: true });
  assert.strictEqual(flew, 0, 'isPreview suppressed the fly-to');
  mgr.renderData({ raw: [{}, {}], peaks: [] }, {}, { drawPoints });
  assert.strictEqual(flew, 1, 'a normal render flies to the track');
  mgr.destroy();
});

// ── Embedded-host contract (index.html is the host) ───────────────────────
// 2D is the source of truth: colour metric + range come from the host, height
// is a separate arousal series so a non-magnitude colour metric still extrudes.

const { MapColors: REAL_MAP_COLORS } = require('../src/map/map_colors.js');

/**
 * Install Cesium/MapColors capture around the REAL _render3DWallAndPath.
 * Returns:
 *   seg       — one entry per WallGeometry instance built
 *               { maxHeights, minHeights, nPos, color }
 *   cssParses — every string passed to Cesium.Color.fromCssColorString (the
 *               wall's colour LUT — should be ≤ 30, and 0 on a same-range redraw)
 * The real MapColors is used so getColorLut() works.
 */
function installWallCapture() {
  const seg = [];
  const cssParses = [];
  global.Cesium.WallGeometry = function (opts) { this._opts = opts; return this; };
  global.Cesium.GeometryInstance = function (opts) {
    const g = opts.geometry._opts;
    seg.push({
      maxHeights: g.maximumHeights, minHeights: g.minimumHeights,
      nPos: g.positions.length, color: opts.attributes.color,
    });
    return opts;
  };
  global.Cesium.ColorGeometryInstanceAttribute = { fromColor: (c) => c };
  global.Cesium.Color = {
    fromCssColorString: (s) => { cssParses.push(s); return { _css: s, withAlpha: () => ({ _css: s }) }; },
    WHITE: { withAlpha: () => ({}) },
  };
  global.MapColors = REAL_MAP_COLORS;
  return { seg, cssParses };
}

test('SERIES_FIELD carries em_fog (2D chief can colour by it)', () => {
  freshEnv();
  const { SERIES_FIELD } = loadFresh();
  assert.strictEqual(SERIES_FIELD.em_fog, 'em_fog');
});

test('renderData({ colorMetric, colorRange }) drives colour from the host, not a local scan', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.flyToTrack = () => {};

  const analyzer = {
    raw: [{}, {}],
    peaks: [],
    em_fog: [{ val: 10 }, { val: 90 }],
    phasic: [{ val: 0.2 }, { val: 0.8 }],
  };
  const drawPoints = [
    { lat: 0, lon: 0, time: 0, origIdx: 0 },
    { lat: 0.001, lon: 0.001, time: 1, origIdx: 1 },
  ];

  const { seg, cssParses } = installWallCapture();
  mgr.renderData(analyzer, {}, { drawPoints, colorMetric: 'em_fog', colorRange: { min: 0, max: 100 } });

  assert.strictEqual(mgr.activeColoringMetric, 'em_fog', 'host metric adopted');
  assert.deepStrictEqual(mgr.externalColorRange, { min: 0, max: 100 });
  assert.ok(seg.length > 0, 'a wall segment was built');
  // colour LUT keyed by the HOST range (0..100), not the drawn points (10..90)
  assert.strictEqual(mgr._cesiumColorLutKey, 'em_fog|0.0000|100.0000');
  assert.ok(cssParses.length > 0 && cssParses.length <= 30, `bounded colour LUT (${cssParses.length})`);
  mgr.destroy();
});

test('the wall colour LUT is bounded (≤30) and reused across a same-range redraw', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.flyToTrack = () => {};

  // 400 points sweeping the whole phasic range — a per-segment colour build
  // would parse ~400 CSS strings; the LUT parses ≤ 30.
  const n = 400;
  const phasic = [];
  const drawPoints = [];
  for (let i = 0; i < n; i++) {
    phasic.push({ val: Math.sin(i / 25) });
    drawPoints.push({ lat: i * 1e-4, lon: i * 1e-4, time: i, origIdx: i });
  }
  const analyzer = { raw: new Array(n).fill({}), peaks: [], phasic };

  const { seg, cssParses } = installWallCapture();
  mgr.renderData(analyzer, {}, { drawPoints, colorMetric: 'phasic' });
  assert.ok(cssParses.length <= 30, `LUT bounded: ${cssParses.length} parses for ${n - 1} segments`);
  assert.ok(seg.length < n / 2, `same-bucket runs merged: ${seg.length} instances for ${n - 1} segments`);
  const afterFirst = cssParses.length;

  // a redraw at the same metric+range must not re-parse anything
  mgr._render3DWallAndPath(analyzer, drawPoints);
  assert.strictEqual(cssParses.length, afterFirst, 'colour LUT reused, no re-parse on redraw');
  mgr.destroy();
});

test('_decimateForWall thins a big track, keeps endpoints / peaks / gap edges, no synthetic gaps', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false, wallMaxSegments: 1000 });

  const n = 8000;
  const colorSeries = new Array(n);
  const drawPoints = [];
  for (let i = 0; i < n; i++) {
    // mostly a straight, flat, single-colour run (should thin hard)…
    let t = i * 0.1;
    if (i >= 4000 && i < 4200) t += 40; // …with a 40 s GPS drop-out at i≈4000
    colorSeries[i] = (i > 6000) ? Math.sin(i / 3) : 0.5; // busy tail — keep density
    drawPoints.push({ lat: 51.5 + i * 1e-6, lon: -0.1 + i * 2e-6, time: t, origIdx: i, isRfPeak: (i === 1234 || i === 7777) });
  }
  const heightAt = () => 2;
  const bucketOf = (v) => Math.max(0, Math.min(29, Math.floor(((v - -1) / 2) * 30)));

  const out = mgr._decimateForWall(drawPoints, colorSeries, heightAt, bucketOf, -1);

  assert.ok(out.length < n / 4, `thinned hard: ${out.length} of ${n}`);
  assert.ok(out.length <= 1000 * 3, `stays near the budget: ${out.length}`);
  assert.strictEqual(out[0], drawPoints[0], 'first point kept');
  assert.strictEqual(out[out.length - 1], drawPoints[n - 1], 'last point kept');
  assert.ok(out.includes(drawPoints[1234]) && out.includes(drawPoints[7777]), 'RF peaks kept');

  // no pair of kept points is > 15 s apart unless it straddles the real drop-out
  let straddle = 0;
  for (let i = 1; i < out.length; i++) {
    const dt = out[i].time - out[i - 1].time;
    if (dt > 15) { straddle++; assert.ok(out[i - 1].origIdx < 4200 && out[i].origIdx >= 4000, `gap only at the real drop-out (${out[i - 1].origIdx}→${out[i].origIdx})`); }
  }
  assert.strictEqual(straddle, 1, 'exactly one >15 s hop — the real drop-out');

  // the busy tail keeps far more density than the flat body
  const inRange = (lo, hi) => out.filter((p) => p.origIdx >= lo && p.origIdx < hi).length;
  assert.ok(inRange(6000, 8000) > inRange(1000, 3000), 'busy tail kept denser than the flat body');

  // below budget: identity (no-op)
  const small = drawPoints.slice(0, 500);
  assert.strictEqual(mgr._decimateForWall(small, colorSeries, heightAt, bucketOf, -1), small);
  mgr.destroy();
});

test('wall height uses the arousal heightMetric even when colour is a non-magnitude metric', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false, heightMetric: 'phasic' });

  const analyzer = {
    raw: [{}, {}],
    em_fog: [{ val: 0 }, { val: 0 }],      // colour series — flat
    phasic: [{ val: 1 }, { val: 5 }],      // height series — varies
  };
  const drawPoints = [
    { lat: 0, lon: 0, time: 0, origIdx: 0 },
    { lat: 0.001, lon: 0.001, time: 1, origIdx: 1 },
  ];
  mgr.activeColoringMetric = 'em_fog';
  mgr.extrusionScale = 10;
  mgr.baseHeight = 2;
  mgr.flyToTrack = () => {};

  const { seg } = installWallCapture();
  mgr.renderData(analyzer, {}, { drawPoints, colorMetric: 'em_fog' });
  assert.strictEqual(seg.length, 1);
  // h = baseHeight + phasic * extrusionScale  ->  [2 + 1*10, 2 + 5*10]
  assert.deepStrictEqual(seg[0].maxHeights, [12, 52]);
  mgr.destroy();
});

// ── Peak click (3D counterpart of a 2D peak-marker click) ─────────────────

test('a LEFT_CLICK on a peak marker reports its analyzer.peaks index to onPeakClick', () => {
  freshEnv();

  // Capture the canvas handler's actions so the test can fire a click.
  let handler = null;
  global.Cesium.ScreenSpaceEventHandler = function () {
    handler = {
      actions: {}, destroyed: false,
      setInputAction(fn, type) { this.actions[type] = fn; },
      removeInputAction(type) { delete this.actions[type]; },
      isDestroyed() { return this.destroyed; },
      destroy() { this.destroyed = true; },
    };
    return handler;
  };
  global.Cesium.ScreenSpaceEventType = { LEFT_CLICK: 'LEFT_CLICK', LEFT_DOUBLE_CLICK: 'LEFT_DOUBLE_CLICK' };

  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });

  // scene.pick returns whatever we stashed for the next click
  let pickResult = null;
  mgr.viewer.scene.pick = () => pickResult;

  const got = [];
  mgr.onPeakClick((idx, pos) => got.push([idx, pos]));

  const click = handler.actions.LEFT_CLICK;
  assert.strictEqual(typeof click, 'function', 'LEFT_CLICK handler is bound');

  pickResult = { id: { _biomapPeakIndex: 4 } };
  click({ position: { x: 120, y: 55 } });
  pickResult = { id: {} };            // a non-peak entity
  click({ position: { x: 0, y: 0 } });
  pickResult = undefined;             // empty space
  click({ position: { x: 0, y: 0 } });

  assert.deepStrictEqual(got, [[4, { x: 120, y: 55 }]],
    'only the peak click reported — analyzer.peaks index + canvas position');

  mgr.destroy();
  assert.strictEqual(handler.destroyed, true, 'canvas handler torn down with the manager');
});

// ── Panel-header layer parity with the 2D map (hotspots / labels / clusters) ─

/** A 2-point analysed track with peaks/hotspots at known coords. */
function parityTrack() {
  const peaks = [
    { index: 0, label: 'Church',  qualityScore: 0.9, amplitude: 1 },
    { index: 1, label: '',        qualityScore: 0.9, amplitude: 2 },
  ];
  const analyzer = {
    raw: [{}, {}],
    phasic: [{ val: 0.2 }, { val: 0.8 }],
    peaks,
    memorableEvents: [peaks[1]], // a hotspot IS a peak (same object, as in analyzer.js)
    getCoordinates: (i) => ({ lat: i * 0.001, lon: i * 0.001 }),
  };
  const drawPoints = [
    { lat: 0, lon: 0, time: 0, origIdx: 0 },
    { lat: 0.001, lon: 0.001, time: 1, origIdx: 1 },
  ];
  return { analyzer, drawPoints };
}

test('renderData draws memorable-event hotspots; toggleHotspots(false) clears them', () => {
  freshEnv();
  installWallCapture();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.flyToTrack = () => {};
  const { analyzer, drawPoints } = parityTrack();

  mgr.renderData(analyzer, {}, { drawPoints, isPreview: true });
  assert.ok(mgr.hotspotEntities.length > 0, 'a hotspot star was built');
  assert.strictEqual(mgr.hotspotEntities[0]._biomapPeakIndex, 1, 'tagged with the analyzer.peaks index');

  mgr.toggleHotspots(false);
  assert.strictEqual(mgr.hotspotEntities.length, 0, 'hotspots cleared');

  mgr.toggleHotspots(true);
  assert.ok(mgr.hotspotEntities.length > 0, 'hotspots redrawn from the cached track');
  mgr.destroy();
});

test('renderData applies the Track Width slider (gpsParams.trackWeight) to the 3D ground path', () => {
  freshEnv();
  installWallCapture();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.flyToTrack = () => {};
  const added = [];
  mgr.viewer.entities.add = (o) => { added.push(o); return {}; };
  const { analyzer, drawPoints } = parityTrack();

  mgr.renderData(analyzer, { trackWeight: 12 }, { drawPoints, isPreview: true });
  const ground = added.find((o) => o && o.name === 'Biomap Ground Path');
  assert.ok(ground, 'ground path entity built');
  assert.strictEqual(ground.polyline.width, 12, 'ground path width tracks the slider');
  assert.strictEqual(mgr.trackWidth, 12);
  mgr.destroy();
});

test('renderData shifts peak/hotspot markers by the Peak-latency slider (gpsParams.peakLatency)', () => {
  freshEnv();
  installWallCapture();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.flyToTrack = () => {};

  const peaks = [{ index: 5, time: 10, qualityScore: 0.9, amplitude: 1, label: '' }];
  const seen = [];
  const analyzer = {
    raw: new Array(6).fill({}),
    phasic: new Array(6).fill({ val: 0.5 }),
    peaks,
    memorableEvents: [peaks[0]],          // a hotspot IS a peak
    getCoordinates: (i) => { seen.push(i); return { lat: i * 0.001, lon: i * 0.001 }; },
    findClosestIndex: (t) => Math.max(0, Math.round(t)),
  };
  const drawPoints = [
    { lat: 0, lon: 0, time: 0, origIdx: 0 },
    { lat: 0.005, lon: 0.005, time: 10, origIdx: 5 },
  ];

  mgr.renderData(analyzer, { peakLatency: 3 }, { drawPoints, isPreview: true });
  assert.strictEqual(mgr.peakLatency, 3);
  // peak sample at t=10 → marker planted at the GPS fix 3 s earlier:
  // findClosestIndex(10 - 3) = 7, for the peak spire AND the hotspot star.
  assert.ok(seen.includes(7), 'marker position resolved at the latency-shifted index');
  mgr.destroy();
});

test('clusterPolygons handed in by the 2D view render as ground blobs; toggleClusters(false) clears', () => {
  freshEnv();
  installWallCapture();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.flyToTrack = () => {};
  const { analyzer, drawPoints } = parityTrack();

  const clusterPolygons = [
    { ring: [[0, 0], [0, 0.002], [0.002, 0.002], [0.002, 0]], color: '#ff5252', fillOpacity: 0.3 },
    { ring: [[1, 1]] }, // degenerate — skipped
  ];
  mgr.renderData(analyzer, {}, { drawPoints, clusterPolygons, isPreview: true });
  assert.ok(mgr.clusterEntities.length > 0, 'the valid hull became fill + outline entities');
  assert.strictEqual(mgr.currentClusterPolygons, clusterPolygons, 'hulls cached for a later toggle');

  mgr.toggleClusters(false);
  assert.strictEqual(mgr.clusterEntities.length, 0, 'cluster blobs cleared');
  mgr.destroy();
});

test('toggleLabels(true) with peaks off keeps only the labelled peaks on screen', () => {
  freshEnv();
  installWallCapture();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.flyToTrack = () => {};
  const { analyzer, drawPoints } = parityTrack();

  mgr.renderData(analyzer, {}, { drawPoints, isPreview: true });
  const bothOn = mgr.peakEntities.length; // one circle entity per peak = 2

  mgr.togglePeaks(false);
  // labels still on → the one labelled peak survives (its circle = 1)
  assert.ok(mgr.peakEntities.length > 0 && mgr.peakEntities.length < bothOn,
    `only labelled peak kept: ${mgr.peakEntities.length} of ${bothOn}`);

  mgr.toggleLabels(false);
  assert.strictEqual(mgr.peakEntities.length, 0, 'peaks off + labels off → nothing');
  mgr.destroy();
});

// ── Scrub-hover (3D track -> host) + follow-cam ─────────────────────────────

/** freshEnv() + a ScreenSpaceEventHandler spy + real-ish Cesium geo maths. */
function scrubEnv() {
  const base = freshEnv();
  global.Cesium.ScreenSpaceEventHandler = function () {
    return {
      actions: {}, destroyed: false,
      setInputAction(fn, type) { this.actions[type] = fn; },
      removeInputAction(type) { delete this.actions[type]; },
      isDestroyed() { return this.destroyed; },
      destroy() { this.destroyed = true; },
    };
  };
  global.Cesium.ScreenSpaceEventType = {
    LEFT_CLICK: 'LEFT_CLICK', LEFT_DOUBLE_CLICK: 'LEFT_DOUBLE_CLICK', MOUSE_MOVE: 'MOUSE_MOVE',
  };
  global.Cesium.Math = { toDegrees: (r) => r * 180 / Math.PI, toRadians: (d) => d * Math.PI / 180 };
  global.Cesium.Cartographic = {
    fromCartesian: (c) => ({ latitude: c.lat * Math.PI / 180, longitude: c.lon * Math.PI / 180 }),
  };
  global.Cesium.Cartesian3 = {
    fromDegrees: (lon, lat) => ({ lon, lat }),
    distance: () => 500,
  };
  global.Cesium.Matrix4 = { IDENTITY: 'IDENTITY' };
  global.Cesium.HeadingPitchRange = function (h, p, r) { return { h, p, r }; };
  // A real canvas spy on the (otherwise auto-stubbed) scene so the mouseleave
  // listener add/remove can be asserted.
  const canvasListeners = [];
  base.viewer.scene.canvas = {
    addEventListener: (t, fn) => canvasListeners.push({ t, fn }),
    removeEventListener: (t, fn) => {
      const i = canvasListeners.findIndex((l) => l.t === t && l.fn === fn);
      if (i !== -1) canvasListeners.splice(i, 1);
    },
  };
  // Nothing reads viewer.camera at construction, so a plain spy is safe.
  base.viewer.camera = {
    pickEllipsoid: () => ({ lon: 0, lat: 0 }),   // overridden per test
    positionCartographic: { height: 1000 },
    positionWC: {},
    heading: 0, pitch: -0.6,
    lookAt() { this._lookAt = true; },
    lookAtTransform(m) { this._transform = m; },
  };
  return { ...base, canvasListeners };
}

test('onScrubHover registers/clears the callback', () => {
  scrubEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  const cb = () => {};
  mgr.onScrubHover(cb);
  assert.strictEqual(mgr._scrubHoverCb, cb);
  mgr.onScrubHover('not a function');
  assert.strictEqual(mgr._scrubHoverCb, null);
  mgr.destroy();
});

test('MOUSE_MOVE over the track reports the nearest drawPoint origIdx; a far pointer reports null', () => {
  scrubEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  const handler = mgr._screenSpaceHandler;

  mgr.currentDrawPoints = [
    { origIdx: 10, lat: 51.5000, lon: -0.1000 },
    { origIdx: 11, lat: 51.5010, lon: -0.1000 },
    { origIdx: 12, lat: 51.5020, lon: -0.1000 },
  ];

  const got = [];
  mgr.onScrubHover((idx, ll) => got.push([idx, ll]));
  const move = handler.actions.MOUSE_MOVE;
  assert.strictEqual(typeof move, 'function', 'MOUSE_MOVE handler bound');

  // pointer essentially on the middle point -> its origIdx (pick runs on the frame)
  mgr.viewer.camera.pickEllipsoid = () => ({ lon: -0.1000, lat: 51.5010 });
  move({ endPosition: { x: 1, y: 1 } });
  window.__flushRaf();

  // pointer ~1km away from any point -> null
  mgr.viewer.camera.pickEllipsoid = () => ({ lon: -0.1000, lat: 51.5100 });
  move({ endPosition: { x: 2, y: 2 } });
  window.__flushRaf();

  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0][0], 11);
  assert.deepStrictEqual(got[0][1], { lat: 51.5010, lon: -0.1000 });
  assert.strictEqual(got[1][0], null);
  mgr.destroy();
});

test('MOUSE_MOVE picks are coalesced to one per animation frame (last position wins)', () => {
  scrubEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  const move = mgr._screenSpaceHandler.actions.MOUSE_MOVE;

  mgr.currentDrawPoints = [
    { origIdx: 10, lat: 51.5000, lon: -0.1000 },
    { origIdx: 11, lat: 51.5010, lon: -0.1000 },
    { origIdx: 12, lat: 51.5020, lon: -0.1000 },
  ];

  let picks = 0;
  const realPick = mgr._pickTrackPoint.bind(mgr);
  mgr._pickTrackPoint = (p) => { picks++; return realPick(p); };

  const got = [];
  mgr.onScrubHover((idx) => got.push(idx));

  // three moves in one frame — only the last should be picked
  mgr.viewer.camera.pickEllipsoid = () => ({ lon: -0.1, lat: 51.5000 });
  move({ endPosition: { x: 1, y: 1 } });
  mgr.viewer.camera.pickEllipsoid = () => ({ lon: -0.1, lat: 51.5010 });
  move({ endPosition: { x: 2, y: 2 } });
  mgr.viewer.camera.pickEllipsoid = () => ({ lon: -0.1, lat: 51.5020 });
  move({ endPosition: { x: 3, y: 3 } });
  assert.strictEqual(picks, 0, 'nothing picked synchronously');

  window.__flushRaf();
  assert.strictEqual(picks, 1, 'one pick for the whole frame');
  assert.deepStrictEqual(got, [12], 'the last pointer position won');

  mgr.destroy();
  window.__flushRaf(); // any queued frame after teardown is a harmless no-op
});

test('followScrub locks onto the point; releaseFollowScrub clears the transform; guards hold', () => {
  scrubEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });

  mgr.followScrub(51.5, -0.1);
  assert.strictEqual(mgr._followingScrub, true);
  assert.strictEqual(mgr.viewer.camera._lookAt, true);

  mgr.releaseFollowScrub();
  assert.strictEqual(mgr._followingScrub, false);
  assert.strictEqual(mgr.viewer.camera._transform, 'IDENTITY');

  // no-op while orbiting
  mgr._isOrbiting = true;
  mgr.viewer.camera._lookAt = false;
  mgr.followScrub(51.5, -0.1);
  assert.strictEqual(mgr._followingScrub, false, 'orbit owns the camera');
  assert.strictEqual(mgr.viewer.camera._lookAt, false);
  mgr._isOrbiting = false;

  // no-op on NaN
  mgr.followScrub(NaN, NaN);
  assert.strictEqual(mgr._followingScrub, false);
  mgr.destroy();
});

test('destroy() removes the mouseleave listener, releases follow-cam, nulls the scrub callback', () => {
  const { canvasListeners } = scrubEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.onScrubHover(() => {});
  mgr.followScrub(51.5, -0.1);
  assert.ok(canvasListeners.some((l) => l.t === 'mouseleave'), 'mouseleave bound in setup');

  mgr.destroy();
  assert.ok(!canvasListeners.some((l) => l.t === 'mouseleave'), 'mouseleave removed');
  assert.strictEqual(mgr._scrubHoverCb, null);
  assert.strictEqual(mgr._scrubHoverLeaveHandler, null);
});

// ── WebGL context loss / restore ──────────────────────────────────────────

test('WebGL context loss is prevented-default; restore rebuilds the scene; destroy() unbinds', () => {
  const { canvasListeners } = scrubEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });

  const lost = canvasListeners.find((l) => l.t === 'webglcontextlost');
  const restored = canvasListeners.find((l) => l.t === 'webglcontextrestored');
  assert.ok(lost && restored, 'both context listeners bound on the canvas');

  let prevented = false;
  lost.fn({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'lost handler calls preventDefault so the browser can restore');

  let refreshed = 0; let basemapSet = null;
  mgr._refreshTrack = () => { refreshed++; };
  mgr.setBasemap = (t) => { basemapSet = t; };
  mgr._currentBasemap = 'osm';
  restored.fn();
  assert.strictEqual(refreshed, 1, 'restore rebuilds the wall/peaks');
  assert.strictEqual(basemapSet, 'osm', 'restore re-adds the imagery layer');

  mgr.destroy();
  assert.ok(!canvasListeners.some((l) => l.t === 'webglcontextlost'), 'lost listener removed');
  assert.ok(!canvasListeners.some((l) => l.t === 'webglcontextrestored'), 'restored listener removed');
  assert.strictEqual(mgr._onContextLost, null);
});
