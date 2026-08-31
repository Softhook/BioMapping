'use strict';
/**
 * Profiling harness for the 3D globe (src/map/globe3d.js) hot paths — Phase 0 of
 * the globe3d critical-refactor plan (identify the bottleneck BEFORE fixing it).
 * Not a regression test: no assertions, nothing fails CI. Run manually:
 *
 *   node tests/manual/_bench_globe3d_perf.js
 *
 * Methodology (same as _bench_render_perf.js): there is no real WebGL viewer or
 * browser paint here, so these numbers isolate the JS-side cost this codebase
 * controls — the per-segment loops in _render3DWallAndPath, the _getMetricSeries
 * allocations, the _pickTrackPoint scan, the _renderPeakSpires indexOf loop. The
 * Cesium stand-in below does REAL work for the two calls whose cost is actually
 * in JS in a real browser too: Color.fromCssColorString (string parse) and
 * Cartesian3.fromDegrees (geodetic→ECEF). Everything else is a cheap recording
 * stub, and per-op construction COUNTS are printed alongside the ms so the
 * batching/LUT opportunities are visible even where Node can't price them.
 *
 * ── BASELINE (pre-refactor, globe3d.js @ globe3d-critical-refactor branch point)
 *    3000 drawPoints, 60 peaks, node on macOS:
 *
 *   path                            median   counts
 *   _render3DWallAndPath (phasic)   1.83ms   fromDegrees=5998 colorParse=2999 GeometryInstance=2999 WallGeometry=2999
 *   _refreshTrack (metric cycle)    1.77ms   (== the wall rebuild — the settled-slider / metric / extrusion path)
 *   _getMetricSeries x1             0.024ms  profiled cheap — NOT a target
 *   _renderPeakSpires (60 peaks)    0.050ms  63 indexOf calls — profiled cheap, NOT a target
 *   _pickTrackPoint x500            1.85ms   = 3.7us / MOUSE_MOVE — cheap; rAF-coalesce is hygiene, not a CPU fix
 *   render3DRfExpanse (triband)     0.13ms   50 slugs — profiled cheap, NOT a target
 *
 * CONCLUSION: the only real hot path is the arousal wall. Its cost is the
 * ~3000 per-segment GeometryInstance / WallGeometry / CSS-colour-parse — Node
 * under-prices the in-browser part (each of those 3000 geometries is batched,
 * combined and uploaded to the GPU on the main thread every rebuild), but the
 * COUNTS make the fix obvious: coalesce same-colour-bucket runs into a handful
 * of multi-vertex WallGeometry instances, colour from a 30-entry Cesium.Color
 * LUT, build positions once with fromDegreesArray. Everything else measured
 * sub-0.1ms and is deliberately left alone.
 *
 *   AFTER Phase 4 (colour LUT + one fromDegreesArray + same-bucket run merge):
 *   _render3DWallAndPath (phasic)   0.42ms   GeometryInstance=366 (was 2999)  colorParse=0 on redraw / <=30 on metric change
 *   _refreshTrack (metric cycle)    0.55ms   (was 1.77ms)
 *   fromDegrees: one fromDegreesArray call for the whole path (was ~6000 singletons)
 *   — ~4x faster in Node; the in-browser win is larger (fewer WallGeometry to
 *     batch/combine/upload on the main thread every settled slider drag).
 */

const path = require('path');

const GLOBE3D = path.join(__dirname, '..', '..', 'src', 'map', 'globe3d.js');
const MAP_COLORS = path.join(__dirname, '..', '..', 'src', 'map', 'map_colors.js');

// ── timing helpers (verbatim shape from _bench_render_perf.js) ────────────────
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
function bench(label, warmup, iters, fn) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < iters; i++) samples.push(timeMs(fn));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { label, median: median(samples), mean, min: Math.min(...samples), max: Math.max(...samples), n: iters };
}
function printRow(r, extra) {
  console.log(
    `  ${r.label.padEnd(32)} median=${r.median.toFixed(3).padStart(9)}ms  mean=${r.mean.toFixed(3).padStart(9)}ms  ` +
    `min=${r.min.toFixed(3).padStart(8)}ms  max=${r.max.toFixed(3).padStart(8)}ms  (n=${r.n})` +
    (extra ? `\n    ${extra}` : '')
  );
}

// ── Counters the stub bumps ─────────────────────────────────────────────────
const counters = { fromDegrees: 0, colorParse: 0, GeometryInstance: 0, WallGeometry: 0, EllipsoidGeometry: 0, PolygonGeometry: 0, Primitive: 0 };
function resetCounters() { for (const k of Object.keys(counters)) counters[k] = 0; }
function counterStr(keys) { return keys.map((k) => `${k}=${counters[k]}`).join('  '); }

// ── A Cesium stand-in that does real work where a real browser also would ────
function autoStub() {
  const fn = function () { return autoStub(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'isDestroyed') return () => false;
      return autoStub();
    },
    apply() { return autoStub(); },
    construct() { return autoStub(); },
  });
}

// geodetic (deg) → ECEF on WGS84 — the maths Cesium.Cartesian3.fromDegrees runs.
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
function fromDegreesReal(lon, lat, height = 0) {
  counters.fromDegrees++;
  const lonR = lon * Math.PI / 180;
  const latR = lat * Math.PI / 180;
  const cosLat = Math.cos(latR);
  const sinLat = Math.sin(latR);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const x = (N + height) * cosLat * Math.cos(lonR);
  const y = (N + height) * cosLat * Math.sin(lonR);
  const z = (N * (1 - WGS84_E2) + height) * sinLat;
  return { x, y, z };
}

// minimal but real CSS-colour parser (#rgb / #rrggbb / hsl() / rgb[a]()) — the
// same class of string work Cesium.Color.fromCssColorString does per call.
function parseCssColorReal(str) {
  counters.colorParse++;
  const s = String(str).trim();
  const out = { red: 0, green: 0, blue: 0, alpha: 1, withAlpha(a) { return { ...this, alpha: a }; } };
  if (s[0] === '#') {
    if (s.length === 4) {
      out.red = parseInt(s[1] + s[1], 16) / 255;
      out.green = parseInt(s[2] + s[2], 16) / 255;
      out.blue = parseInt(s[3] + s[3], 16) / 255;
    } else {
      out.red = parseInt(s.slice(1, 3), 16) / 255;
      out.green = parseInt(s.slice(3, 5), 16) / 255;
      out.blue = parseInt(s.slice(5, 7), 16) / 255;
    }
    return out;
  }
  const hsl = s.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
  if (hsl) {
    const h = parseFloat(hsl[1]) / 360, sat = parseFloat(hsl[2]) / 100, l = parseFloat(hsl[3]) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const hk = (tc) => {
      let t = tc; if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    out.red = hk(h + 1 / 3); out.green = hk(h); out.blue = hk(h - 1 / 3);
    return out;
  }
  const rgb = s.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(',').map((x) => parseFloat(x));
    out.red = parts[0] / 255; out.green = parts[1] / 255; out.blue = parts[2] / 255;
    if (parts.length > 3) out.alpha = parts[3];
  }
  return out;
}

function makeCesium() {
  const C = autoStub();

  // callable as `new Cesium.Cartesian3(x,y,z)` and as a namespace of statics.
  C.Cartesian3 = function (x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; };
  C.Cartesian3.ZERO = { x: 0, y: 0, z: 0 };
  C.Cartesian3.fromDegrees = (lon, lat, h) => fromDegreesReal(lon, lat, h);
  C.Cartesian3.fromDegreesArray = (flat) => {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push(fromDegreesReal(flat[i], flat[i + 1]));
    return out;
  };
  C.Cartesian3.fromRadians = (lon, lat, h) => fromDegreesReal(lon * 180 / Math.PI, lat * 180 / Math.PI, h);
  C.Cartesian3.distance = () => 500;
  C.Cartesian3.clone = (v, o) => { if (o) { o.x = v.x; o.y = v.y; o.z = v.z; return o; } return { ...v }; };
  C.Cartesian3.equalsEpsilon = () => false;
  C.Cartographic = {
    fromCartesian: (c) => ({ longitude: 0, latitude: 0, height: c ? c.z || 0 : 0 }),
    fromDegrees: (lon, lat, h) => ({ longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180, height: h || 0 }),
    toCartesian: (c) => fromDegreesReal((c.longitude || 0) * 180 / Math.PI, (c.latitude || 0) * 180 / Math.PI, c.height || 0),
  };
  C.Math = { toRadians: (d) => d * Math.PI / 180, toDegrees: (r) => r * 180 / Math.PI };
  C.Color = {
    WHITE: parseCssColorReal('#ffffff'),
    fromCssColorString: (s) => parseCssColorReal(s),
  };
  C.Color.fromCssColorString.prototype = {};
  // constructor form: new Cesium.Color(r,g,b,a)
  const ColorCtor = function (r, g, b, a) { return { red: r, green: g, blue: b, alpha: a, withAlpha(x) { return { ...this, alpha: x }; } }; };
  ColorCtor.fromCssColorString = (s) => parseCssColorReal(s);
  ColorCtor.WHITE = parseCssColorReal('#ffffff');
  C.Color = ColorCtor;

  C.ColorGeometryInstanceAttribute = { fromColor: (c) => c };
  C.WallGeometry = function (opts) { counters.WallGeometry++; this._opts = opts; };
  C.PolygonGeometry = function (opts) { counters.PolygonGeometry++; this._opts = opts; };
  C.PolygonHierarchy = function (p) { this.positions = p; };
  C.EllipsoidGeometry = function (opts) { counters.EllipsoidGeometry++; this._opts = opts; };
  C.GeometryInstance = function (opts) { counters.GeometryInstance++; this._opts = opts; return this; };
  C.Primitive = function (opts) { counters.Primitive++; this._opts = opts; };
  C.PerInstanceColorAppearance = function (opts) { this._opts = opts; };
  C.PolylineGlowMaterialProperty = function (opts) { this._opts = opts; };
  C.Transforms = { eastNorthUpToFixedFrame: () => ({}) };
  C.BoundingSphere = { fromPoints: () => ({ radius: 500, center: { x: 0, y: 0, z: 0 } }) };
  C.HeadingPitchRange = function (h, p, r) { return { heading: h, pitch: p, range: r }; };
  C.Rectangle = {
    fromCartographicArray: () => ({}),
    center: () => ({ longitude: 0, latitude: 0 }),
    northwest: () => ({ longitude: 0, latitude: 0 }),
  };
  C.Matrix4 = { IDENTITY: 'IDENTITY' };
  C.Cartesian2 = function (x, y) { return { x, y }; };
  C.DistanceDisplayCondition = function (a, b) { return { a, b }; };
  C.LabelStyle = { FILL_AND_OUTLINE: 1 };
  C.VerticalOrigin = { BOTTOM: 1 };
  C.ScreenSpaceEventType = { LEFT_CLICK: 'LEFT_CLICK', LEFT_DOUBLE_CLICK: 'LEFT_DOUBLE_CLICK', MOUSE_MOVE: 'MOUSE_MOVE' };
  C.ScreenSpaceEventHandler = function () {
    return {
      actions: {}, destroyed: false,
      setInputAction(fn, type) { this.actions[type] = fn; },
      removeInputAction(type) { delete this.actions[type]; },
      isDestroyed() { return this.destroyed; },
      destroy() { this.destroyed = true; },
    };
  };
  C.CameraEventType = {};
  C.KeyboardEventModifier = {};
  C.Ion = { defaultAccessToken: '' };

  const scene = {
    requestRenderMode: false,
    canvas: { addEventListener() {}, removeEventListener() {} },
    screenSpaceCameraController: {},
    globe: { ellipsoid: {} },
    fog: {},
    skyBox: {}, skyAtmosphere: {}, sun: {}, moon: {},
    primitives: { add() {}, remove() {} },
    postRender: { addEventListener: () => () => {} },
    requestRender() {},
    pick: () => null,
  };
  const camera = {
    positionWC: { x: 0, y: 0, z: 0 },
    positionCartographic: { height: 1200 },
    heading: 0, pitch: -0.6,
    pickEllipsoid: () => ({ x: 1, y: 2, z: 3 }),
    flyTo() {}, flyToBoundingSphere() {}, lookAt() {}, lookAtTransform() {},
    getPickRay: () => ({}),
    moveForward() {}, moveBackward() {}, moveUp() {}, moveDown() {}, moveLeft() {}, moveRight() {}, lookLeft() {}, lookRight() {},
  };
  const viewer = {
    scene, camera,
    clock: { onTick: { addEventListener: () => () => {} } },
    entities: { add: () => ({}), remove() {} },
    imageryLayers: { removeAll() {}, addImageryProvider() {} },
    isDestroyed: () => false,
    destroy() {},
    render() {},
  };
  C.Viewer = function () { return viewer; };
  return { C, viewer };
}

// ── Environment + fixture ───────────────────────────────────────────────────
global.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (fn) => setTimeout(fn, 0) };
global.document = { activeElement: null, createElement: () => ({ style: {}, appendChild() {}, click() {} }), body: { appendChild() {}, removeChild() {} } };
global.MapColors = require(MAP_COLORS).MapColors;
const { C } = makeCesium();
global.Cesium = C;
global.GSRGlobe3DRf = require(path.join(__dirname, '..', '..', 'src', 'map', 'globe3d', 'rf_expanse.js')).GSRGlobe3DRf;
global.GSRGlobe3DBuildings = require(path.join(__dirname, '..', '..', 'src', 'map', 'globe3d', 'buildings.js')).GSRGlobe3DBuildings;

delete require.cache[require.resolve(GLOBE3D)];
const { GSRGlobeManager } = require(GLOBE3D);

const N_POINTS = 3000;
const N_PEAKS = 60;

function buildFixture(n, nPeaks) {
  const raw = [];
  const phasic = [];
  const emFog = [];
  const drawPoints = [];
  for (let i = 0; i < n; i++) {
    const t = i * 0.1;
    // phasic arousal from the deconvolution is smooth sample-to-sample with the
    // odd sharp SCR — a slow carrier + small jitter, not white noise.
    const ph = 0.5 + 0.45 * Math.sin(i / 90) + 0.06 * Math.sin(i / 11);
    const fog = 40 + 30 * Math.sin(i / 55);
    raw.push({ time: t, gsr: 2 + ph, hasGps: true, lat: 51.5 + i * 1.5e-5, lon: -0.12 + i * 1.2e-5,
      rssi_815: -70 - 10 * Math.sin(i / 30), rssi_868: -75 + 8 * Math.cos(i / 25), rssi_915: -60 - 5 * Math.sin(i / 12), em_fog: fog });
    phasic.push({ time: t, val: ph });
    emFog.push({ time: t, val: fog });
    drawPoints.push({ time: t, lat: 51.5 + i * 1.5e-5, lon: -0.12 + i * 1.2e-5, origIdx: i, isRfPeak: false });
  }
  const peaks = [];
  for (let k = 0; k < nPeaks; k++) {
    const idx = Math.floor((k + 0.5) * n / nPeaks);
    peaks.push({ index: idx, time: idx * 0.1, amplitude: 1 + (k % 5) * 0.3, qualityScore: 0.3 + (k % 7) / 10, excluded: false, label: k % 4 === 0 ? `Peak ${k}` : '' });
  }
  const analyzer = {
    raw, phasic, em_fog: emFog, peaks,
    sampleRate: 10,
    getCoordinates: (i) => ({ lat: 51.5 + i * 1.5e-5, lon: -0.12 + i * 1.2e-5 }),
    rfPeakIndices: new Set(),
  };
  return { analyzer, drawPoints };
}

const { analyzer, drawPoints } = buildFixture(N_POINTS, N_PEAKS);

function newManager(opts) {
  return new GSRGlobeManager('c', Object.assign({ keyboardFlight: false }, opts || {}));
}

console.log(`\nBioMapping — 3D globe hot-path profile   (${N_POINTS} drawPoints, ${N_PEAKS} peaks)\n`);

// ── Bench A: _render3DWallAndPath cold ──────────────────────────────────────
{
  const mgr = newManager();
  mgr.activeColoringMetric = 'phasic';
  mgr.currentAnalyzer = analyzer;
  mgr.currentDrawPoints = drawPoints;
  let lastCounts = '';
  const r = bench('_render3DWallAndPath (phasic)', 3, 40, () => {
    mgr.clearTrackEntities();
    resetCounters();
    mgr._render3DWallAndPath(analyzer, drawPoints);
    lastCounts = counterStr(['fromDegrees', 'colorParse', 'GeometryInstance', 'WallGeometry', 'Primitive']);
  });
  printRow(r, lastCounts);
  mgr.destroy();
}

// ── Bench B: _refreshTrack — the settled-slider / metric / extrusion path ────
{
  const mgr = newManager();
  mgr.currentAnalyzer = analyzer;
  mgr.currentDrawPoints = drawPoints;
  mgr.currentPeaks = analyzer.peaks.filter((p) => !p.excluded);
  mgr.showPeaks = true;
  const metrics = ['phasic', 'em_fog', 'gsr'];
  let i = 0;
  const r = bench('_refreshTrack (metric cycle)', 3, 40, () => {
    mgr.activeColoringMetric = metrics[i++ % metrics.length];
    mgr._refreshTrack();
  });
  printRow(r);
  mgr.destroy();
}

// ── Bench C: _getMetricSeries alone ────────────────────────────────────────
{
  const mgr = newManager();
  const r = bench('_getMetricSeries x1 (phasic)', 5, 200, () => {
    mgr._getMetricSeries(analyzer, 'phasic');
  });
  printRow(r, `series length=${analyzer.phasic.length} — allocated fresh every call`);
  mgr.destroy();
}

// ── Bench D: _renderPeakSpires (indexOf-in-loop) ───────────────────────────
{
  const mgr = newManager();
  mgr.activeColoringMetric = 'phasic';
  mgr.currentPeaks = analyzer.peaks.filter((p) => !p.excluded);
  // count indexOf hits via a spy on the peaks array
  const realIndexOf = Array.prototype.indexOf;
  let idxCalls = 0;
  const r = bench('_renderPeakSpires (60 peaks)', 3, 60, () => {
    mgr.clearPeakEntities();
    analyzer.peaks.indexOf = function (...a) { idxCalls++; return realIndexOf.apply(this, a); };
    mgr._renderPeakSpires(analyzer, mgr.currentPeaks);
    analyzer.peaks.indexOf = realIndexOf;
  });
  printRow(r, `analyzer.peaks.indexOf calls per render = ${idxCalls / r.n | 0}  (O(peaks^2) = ${N_PEAKS * N_PEAKS})`);
  mgr.destroy();
}

// ── Bench E: _pickTrackPoint x500 (the per-MOUSE_MOVE scan) ────────────────
{
  const mgr = newManager();
  mgr.currentDrawPoints = drawPoints;
  const r = bench('_pickTrackPoint x500', 3, 20, () => {
    for (let k = 0; k < 500; k++) mgr._pickTrackPoint({ x: k, y: k });
  });
  printRow(r, `${N_POINTS} points scanned per call = ${(N_POINTS * 500).toLocaleString()} iterations/bench`);
  mgr.destroy();
}

// ── Bench F: render3DRfExpanse ────────────────────────────────────────────
{
  const mgr = newManager();
  mgr.rfMode = 'triband';
  let lastCounts = '';
  const r = bench('render3DRfExpanse (triband)', 3, 40, () => {
    mgr.clearRfEntities();
    resetCounters();
    mgr.render3DRfExpanse(analyzer, drawPoints);
    lastCounts = counterStr(['EllipsoidGeometry', 'GeometryInstance', 'Primitive']);
  });
  printRow(r, lastCounts);
  mgr.destroy();
}

console.log('');
