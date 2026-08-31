/**
 * Unit tests for src/map/globe3d.js (the standalone 3d.html engine).
 *
 * globe3d.js had no coverage; these lock in the refactor that made
 * GSRGlobeManager embeddable — a construct / render / destroy lifecycle with no
 * assumption that it owns the page:
 *   - the module-level helpers (seriesValue, SERIES_FIELD, BASEMAP_PROVIDERS),
 *   - `keyboardFlight: false` really suppresses the window key listeners,
 *   - destroy() removes every listener the constructor added and tears the viewer down,
 *   - renderData({ drawPoints }) bypasses the standalone GPS chain,
 *   - 3d.html's basemap <select> options all have a BASEMAP_PROVIDERS entry, and
 *   - every local src/href in 3d.html resolves on disk (test_html_wiring.js only
 *     covers index.html / live.html).
 *
 * Cesium is replaced by a small auto-stub; no real WebGL viewer is created.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
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
  global.window = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
  };
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
    'setBasemap', 'toggle3DBuildings', 'apply3DBuildingStyle', 'toggle3DRf',
    'flyToTrack', 'toggleOrbit', 'setViewPerspective', 'resetNorth',
    'exportSnapshot', 'exportCzml', 'exportKml', 'setScrubPosition', 'onPeakClick',
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

test('renderData({ drawPoints }) bypasses the standalone GPS chain', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c');

  let standaloneCalls = 0;
  mgr._computeDrawPointsStandalone = () => { standaloneCalls++; return []; };
  let wallCalls = 0;
  mgr._render3DWallAndPath = () => { wallCalls++; };
  mgr.flyToTrack = () => {};

  const drawPoints = [
    { lat: 51.5, lon: -0.1, time: 0, origIdx: 0 },
    { lat: 51.6, lon: -0.2, time: 1, origIdx: 1 },
  ];
  mgr.renderData({ raw: [{}, {}], peaks: [] }, {}, { drawPoints });

  assert.strictEqual(standaloneCalls, 0, 'did not run the standalone GPS pipeline');
  assert.strictEqual(wallCalls, 1);
  assert.strictEqual(mgr.currentDrawPoints, drawPoints);
  mgr.destroy();
});

test('renderData(analyzer, params, true) still means isPreview (back-compat)', () => {
  freshEnv();
  const { GSRGlobeManager } = loadFresh();
  const mgr = new GSRGlobeManager('c');
  mgr._render3DWallAndPath = () => {};
  let flew = 0;
  mgr.flyToTrack = () => { flew++; };
  mgr._computeDrawPointsStandalone = () => ([
    { lat: 0, lon: 0, time: 0, origIdx: 0 }, { lat: 1, lon: 1, time: 1, origIdx: 1 },
  ]);
  mgr.renderData({ raw: [{}, {}], peaks: [] }, {}, true);
  assert.strictEqual(flew, 0, 'isPreview suppressed the fly-to');
  mgr.destroy();
});

// ── 3d.html wiring ─────────────────────────────────────────────────────────

const html3d = fs.readFileSync(path.join(APP_DIR, '3d.html'), 'utf8');

test('every basemap <option> in 3d.html has a BASEMAP_PROVIDERS entry', () => {
  freshEnv();
  const { BASEMAP_PROVIDERS } = loadFresh();
  const selectBlock = html3d.match(/id="basemapSelect"[\s\S]*?<\/select>/);
  assert.ok(selectBlock, '#basemapSelect not found in 3d.html');
  const values = [...selectBlock[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 2, 'expected several basemap options');
  for (const v of values) {
    assert.ok(BASEMAP_PROVIDERS[v], `no BASEMAP_PROVIDERS['${v}']`);
  }
});

test('every local src/href in 3d.html resolves on disk', () => {
  const isLocal = (u) =>
    u && !/^(https?:)?\/\//.test(u) && !/^(data:|mailto:|tel:|javascript:|#)/.test(u);
  const refs = [...html3d.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter(isLocal);
  assert.ok(refs.includes('src/map/globe3d.js'), 'test is stale — globe3d.js not linked');
  const missing = refs.filter((rel) => !fs.existsSync(path.resolve(APP_DIR, rel)));
  assert.deepStrictEqual(missing, [], `3d.html points at missing file(s): ${missing.join(', ')}`);
});

test('3d.html loads notices.js before globe3d.js (so GSRNotices exists for it)', () => {
  const notices = html3d.indexOf('src="src/core/notices.js"');
  const globe = html3d.indexOf('src="src/map/globe3d.js"');
  assert.ok(notices !== -1 && globe !== -1 && notices < globe);
});

// ── Embedded-host contract (index.html is a second host) ───────────────────
// 2D is the source of truth: colour metric + range come from the host, height
// is a separate arousal series so a non-magnitude colour metric still extrudes.

/**
 * Install Cesium/MapColors stubs that record what each wall segment would be
 * built with. Returns { seg, colors } arrays that fill in when the REAL
 * _render3DWallAndPath runs (via renderData). No method is monkey-patched.
 */
function installWallCapture() {
  const seg = [];
  const colors = [];
  global.Cesium.WallGeometry = function (opts) { this._opts = opts; return this; };
  global.Cesium.GeometryInstance = function (opts) {
    seg.push({ maxHeights: opts.geometry._opts.maximumHeights });
    return opts;
  };
  global.Cesium.ColorGeometryInstanceAttribute = { fromColor: (c) => c };
  global.Cesium.Color = { fromCssColorString: () => ({ withAlpha: () => ({}) }), WHITE: { withAlpha: () => ({}) } };
  global.MapColors = {
    getColorForMetric: (metric, avg, min, max) => { colors.push({ metric, avg, min, max }); return '#123456'; },
  };
  return { seg, colors };
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

  const { colors } = installWallCapture();
  mgr.renderData(analyzer, {}, { drawPoints, colorMetric: 'em_fog', colorRange: { min: 0, max: 100 } });

  assert.strictEqual(mgr.activeColoringMetric, 'em_fog', 'host metric adopted');
  assert.deepStrictEqual(mgr.externalColorRange, { min: 0, max: 100 });
  assert.ok(colors.length > 0, 'a wall segment was coloured');
  // colour normalised against the HOST range (0..100), not the drawn points (10..90)
  assert.ok(colors.every((c) => c.min === 0 && c.max === 100));
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

test('a LEFT_CLICK on a peak spire reports its analyzer.peaks index to onPeakClick', () => {
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
