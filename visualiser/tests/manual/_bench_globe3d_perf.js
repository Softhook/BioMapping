'use strict';
/**
 * Profiling harness for a 3D-globe track rebuild — everything that reruns on a
 * settled GSR/GPS slider drag, a colour-metric change or an extrusion change
 * (globe3d.js `_render3DWallAndPath` + `_renderPeakSpires` + `_renderHotspots`).
 *
 * Three layers, because different parts cost in different places:
 *
 *   SECTION A — wall geometry realization. Uses the REAL vendored CesiumJS
 *   geometry pipeline: WallGeometry.createGeometry (edge subdivision +
 *   triangulation + per-vertex normals/tangents) and
 *   PrimitivePipeline.combineGeometry (merge every instance into one buffer
 *   set), both run headless in Node. NOTE: in the app the wall Primitive is
 *   built with `asynchronous: true`, so this work runs on a Cesium worker, NOT
 *   the main thread — it does not stall the drag. What it costs is worker CPU,
 *   latency-to-visible and battery. A/B: pre-refactor per-segment instances vs
 *   the colour-bucket-coalesced + thinned instances production builds now.
 *
 *   SECTION B — main-thread JS per rebuild (stub Cesium). Our own loops in
 *   `_render3DWallAndPath`, `_renderPeakSpires`, `_renderHotspots`, plus the
 *   entity add/remove counts. This is what actually competes with the frame.
 *   Cesium's own per-entity Visualizer diffing is NOT measurable headless — the
 *   entity COUNTS here are the proxy for it (fewer entities added == less work
 *   for Cesium on the next frame).
 *
 *   SECTION C — hover scan (`_pickTrackPoint`), rAF-coalesced to ~1/frame.
 *
 * Fixture: a real track run through the actual 2D map GPS pipeline, so
 * `drawPoints` is byte-for-byte what feeds the globe in the app. Default
 * tracks/Newhaven.csv (~14 k rows); set BENCH_TRACK=biomap_016.csv for a
 * large (35 k-row / ~900-peak) track — SECTION B costs that scale with point
 * or peak count roughly triple there.
 *
 * Run:
 *   npm i --no-save cesium@1.120        # dev-only; not committed, not in `npm test`
 *   node tests/manual/_bench_globe3d_perf.js
 *   BENCH_TRACK=biomap_016.csv node tests/manual/_bench_globe3d_perf.js
 *
 * ── RESULTS  (node on macOS) ──
 *
 *   SECTION A — real WallGeometry.createGeometry + combineGeometry (WORKER, not main thread)
 *     Newhaven.csv (14225 drawPoints):   per-segment pre-refactor ≈ 77 ms → coalesced+thinned ≈ 15 ms
 *     biomap_016.csv (35466 drawPoints): per-segment pre-refactor ≈ 261 ms → coalesced+thinned ≈ 36 ms
 *     → ~5–7x faster to realize+combine; ~2.8x fewer vertices. Async (asynchronous:true),
 *       so it runs on a Cesium worker and never stalls the drag — left as-is.
 *
 *   SECTION B — main-thread JS per rebuild (stub Cesium)   [Newhaven 196 peaks / biomap_016 888 peaks]
 *     BEFORE the 2026-09-08 spire pass:
 *       _renderPeakSpires                  19 ms  /  320 ms      ← _getMetricSeries did a full
 *       full rebuild (wall+spires+hotspots) 20 ms  /  329 ms        analyzer[field].map() ONCE PER
 *                                                                    PEAK, and allPeaks.indexOf(peak)
 *                                                                    made the loop O(peaks²).
 *     AFTER: _getMetricSeries memoised per render (dropped at renderData/_refreshTrack),
 *            peak→index Map instead of indexOf, marker Cesium.Color/Cartesian2/DDC hoisted:
 *       _renderPeakSpires                  0.04 ms / 0.17 ms
 *       _render3DWallAndPath               0.5 ms  / 1.1 ms   GeometryInstance 362 / 789
 *       _renderHotspots                    0.01 ms / 0.03 ms
 *       full rebuild (wall+spires+hotspots) 0.5 ms / 1.3 ms   ← ~250x on the big track
 *       _getMetricSeries (cold)            <0.1 ms / 0.35 ms  now 1x/render, was Nx (N=peaks)
 *     Extrusion-slider drags also coalesce _refreshTrack to 1x/frame (setExtrusionScale rAF).
 *
 *   SECTION C — _pickTrackPoint  ~22 µs/call (14k) · ~55 µs/call (35k) — rAF-coalesced, fine.
 *
 *   STILL ON THE TABLE (not done)
 *     - peak spires / hotspots as one batched PointPrimitiveCollection +
 *       LabelCollection instead of one Entity each (cuts Cesium-side Visualizer
 *       diffing, not visible in this bench — see the entity counts).
 *     - colour-metric change updates per-instance colour attributes instead of
 *       rebuilding geometry (needs colour-independent coalescing).
 *     - custom lightweight wall Geometry (skip WallGeometry subdivision/caps +
 *       the combine step). Worker-side only; ceiling ~15 ms → ~5 ms.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.join(__dirname, '..', '..');
const TRACKS_DIR = path.join(APP_DIR, '..', 'tracks');
const TRACK_FILE = process.env.BENCH_TRACK || 'Newhaven.csv';
const GLOBE3D = path.join(APP_DIR, 'src', 'map', 'globe3d.js');
const MAP_COLORS = path.join(APP_DIR, 'src', 'map', 'map_colors.js');

const { bootApp } = require('../support/boot_app.js');

// ── real vendored Cesium (headless geometry pipeline) ───────────────────────
let realCesium = null;
try {
  realCesium = require('cesium');
} catch (e) {
  console.log('\n  This bench needs CesiumJS as a dev dependency to measure the real');
  console.log('  geometry pipeline. It is not committed and not part of `npm test`:\n');
  console.log('    npm i --no-save cesium@1.120 && node tests/manual/_bench_globe3d_perf.js\n');
  process.exit(0);
}

// ── timing helpers (shape from _bench_render_perf.js) ───────────────────────
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
  const s = [];
  for (let i = 0; i < iters; i++) s.push(timeMs(fn));
  return { label, median: median(s), mean: s.reduce((a, b) => a + b, 0) / s.length, min: Math.min(...s), max: Math.max(...s), n: iters };
}
function printRow(r, extra) {
  console.log(
    `  ${r.label.padEnd(30)} median=${r.median.toFixed(3).padStart(9)}ms  mean=${r.mean.toFixed(3).padStart(9)}ms  ` +
    `(n=${r.n})` + (extra ? `\n    ${extra}` : '')
  );
}

// ── recording Leaflet (verbatim from tests/manual/_bench_render_perf.js) ─────
function installRecordingLeaflet(window) {
  const map = {
    _layers: new Map(), _direct: [], _groups: new Map(), _viaGroup: new Set(), _nextId: 1,
    addLayer(layer) {
      if (!layer || typeof layer !== 'object') return map;
      if (layer._gsrId === undefined) layer._gsrId = map._nextId++;
      map._layers.set(layer._gsrId, layer);
      if (layer._isGroup) { map._groups.set(layer._gsrId, layer); layer._onMap = true; layer._children.forEach(c => map._viaGroup.add(c)); }
      else { map._direct.push(layer); }
      return map;
    },
    removeLayer(layer) {
      if (!layer || layer._gsrId === undefined) return map;
      if (layer._isGroup) { map._groups.delete(layer._gsrId); map._layers.delete(layer._gsrId); layer._onMap = false; layer._children.forEach(c => map._viaGroup.delete(c)); }
      else {
        const i = map._direct.indexOf(layer); if (i >= 0) map._direct.splice(i, 1);
        map._layers.delete(layer._gsrId); map._viaGroup.delete(layer);
        for (const g of map._groups.values()) { if (g.hasLayer(layer)) g._children.delete(layer._gsrId); }
      }
      return map;
    },
    hasLayer(layer) {
      if (!layer || layer._gsrId === undefined) return false;
      if (layer._isGroup) return map._groups.has(layer._gsrId);
      return map._direct.includes(layer) || map._viaGroup.has(layer);
    },
    latLngToLayerPoint() { return { x: 10, y: 20 }; },
    fitBounds() {}, setView() { return map; },
    getBounds() { return { pad: () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) }) }; },
    getSize() { return { x: 800, y: 600 }; }, on() {}, remove() {},
  };
  function makeLayer(kind) {
    return {
      _gsrId: map._nextId++, _isGroup: false, _gsrKind: kind || 'layer', _gsrLayerGroup: null,
      addTo(m) { m.addLayer(this); return this; }, remove() { map.removeLayer(this); return this; },
      bindPopup() { return this; }, bindTooltip() { return this; }, setZIndexOffset() { return this; },
      setOpacity() { return this; }, setLatLng() { return this; }, on() { return this; }, openPopup() { return this; },
    };
  }
  function makeGroup() {
    return {
      _gsrId: map._nextId++, _isGroup: true, _children: new Map(), _onMap: false,
      addLayer(c) { this._children.set(c._gsrId, c); if (this._onMap) map._viaGroup.add(c); return this; },
      removeLayer(c) { this._children.delete(c._gsrId); if (this._onMap) map._viaGroup.delete(c); return this; },
      hasLayer(c) { return this._children.has(c._gsrId); },
      addTo(m) { m.addLayer(this); return this; }, remove() { map.removeLayer(this); return this; },
      getLayers() { return [...this._children.values()]; }, eachLayer(fn) { this._children.forEach(fn); },
    };
  }
  class FakeControl {
    constructor(o) { this.options = o || {}; }
    _onAdd() { return window.document.createElement('div'); }
    addTo(m) { m.addLayer(this); this._container = this._onAdd(); return this; }
    getContainer() { return this._container; } getPosition() { return this.options.position; }
  }
  FakeControl.extend = (proto) => { class C extends FakeControl {} Object.keys(proto).forEach(k => { C.prototype[k] = proto[k]; }); return C; };
  window.L = {
    map: () => map, layerGroup: makeGroup,
    polyline: (ll, o) => { const l = makeLayer('path'); l._latlngs = ll; l._options = o; return l; },
    polygon: (ll, o) => { const l = makeLayer('cluster'); l._latlngs = ll; l._options = o; return l; },
    marker: (ll, o) => { const l = makeLayer('marker'); l._latlng = ll; l._options = o; return l; },
    tileLayer: () => makeLayer('tile'),
    imageOverlay: (u, b, o) => { const l = makeLayer('surface'); l._url = u; l._bounds = b; l._options = o; return l; },
    featureGroup: function (layers) { const g = makeGroup(); (layers || []).forEach(l => g.addLayer(l)); g.getBounds = () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) }); return g; },
    divIcon: (o) => o || {}, icon: (o) => o || {},
    DomUtil: { create: (tag, cn) => { const el = window.document.createElement(tag); if (cn) el.className = cn; return el; }, setTransform() {} },
    Control: FakeControl,
  };
  return { map };
}

// ── load the real track through the real 2D pipeline ────────────────────────
const { window, context } = bootApp();
vm.runInContext('RFFluidRenderer = undefined;', context);
window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
installRecordingLeaflet(window);
window.setup();

const mm = window.AppState.mapManager;
const analyzer = new window.GSRAnalyzer();
analyzer.parseCSV(fs.readFileSync(path.join(TRACKS_DIR, TRACK_FILE), 'utf8'));
const track = window.GSRTrackManager.createTrackObject('bench', TRACK_FILE, '#ff0000', analyzer);
analyzer.analyze(track.filterParams, 0);
window.AppState.collectiveManager.addTrack(track);
window.AppState.activeTrackId = track.id;
window.AppState.analyzer = analyzer;

const gpsParams = vm.runInContext('JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT))', context);
mm.renderData(analyzer, gpsParams);              // populates mm._lastDrawPoints
const drawPoints = mm._lastDrawPoints || [];
const metric = mm.activeColoringMetric || 'phasic';
const colorRange = { min: mm._legendMinVal, max: mm._legendMaxVal };

let segCount = 0;
for (let i = 0; i < drawPoints.length - 1; i++) {
  if (Math.abs(drawPoints[i + 1].time - drawPoints[i].time) <= 15.0) segCount++;
}

console.log(`\nBioMapping — 3D globe wall profile   fixture: tracks/${TRACK_FILE}`);
console.log(`  drawPoints=${drawPoints.length}  segments=${segCount}  peaks=${(analyzer.peaks || []).length}  ` +
  `metric=${metric}  range=[${(+colorRange.min).toPrecision(3)}, ${(+colorRange.max).toPrecision(3)}]\n`);

if (drawPoints.length < 2) { console.log('  track has < 2 display points — nothing to profile\n'); process.exit(0); }

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A — real geometry realization (WallGeometry.createGeometry + combine)
// ─────────────────────────────────────────────────────────────────────────────
const Cx = realCesium;
const MapColors = require(MAP_COLORS).MapColors;

// arousal series for heights + colours, indexed by origIdx (mirror _getMetricSeries)
function seriesFor(m) {
  const F = { phasic: 'phasic', tonic: 'tonic', arousalIndex: 'arousalIndex', peakDensity: 'peakDensity', phasicAUC: 'phasicAUC', em_fog: 'em_fog', emFog: 'em_fog' }[m];
  const arr = (F && analyzer[F] && analyzer[F].length) ? analyzer[F] : null;
  if (arr) return arr.map((d) => (d && typeof d === 'object' && 'val' in d) ? d.val : (typeof d === 'number' ? d : 0));
  return (analyzer.raw || []).map((d) => (d.gsr !== undefined ? d.gsr : 0));
}
const HEIGHT_CAPABLE = new Set(['gsr', 'phasic', 'tonic', 'arousalIndex', 'peakDensity', 'phasicAUC']);
const colorSeries = seriesFor(metric);
const heightMetric = HEIGHT_CAPABLE.has(metric) ? metric : 'phasic';
const heightSeries = heightMetric === metric ? colorSeries : seriesFor(heightMetric);
const baseHeight = 2.0, extrusionScale = 8.0;
let minV = colorRange.min, maxV = colorRange.max;
if (!isFinite(minV) || !isFinite(maxV) || minV === maxV) { minV = 0; maxV = 1; }
const heightAt = (idx) => baseHeight + Math.max(0, heightSeries[idx] ?? 0) * extrusionScale;

// (1)/(2) pre-refactor shape: one WallGeometry per segment, per-segment colour
// parse. `vf` toggles POSITION+NORMAL vs POSITION-only to isolate the flat-format
// effect.
function buildPerSegmentInstances(vf) {
  const inst = [];
  for (let i = 0; i < drawPoints.length - 1; i++) {
    const p1 = drawPoints[i], p2 = drawPoints[i + 1];
    if (Math.abs(p2.time - p1.time) > 15.0) continue;
    const v1 = colorSeries[p1.origIdx] ?? minV, v2 = colorSeries[p2.origIdx] ?? minV;
    const hex = MapColors.getColorForMetric(metric, (v1 + v2) / 2, minV, maxV);
    const color = Cx.Color.fromCssColorString(hex).withAlpha(0.85);
    try {
      inst.push(new Cx.GeometryInstance({
        geometry: new Cx.WallGeometry({
          positions: [Cx.Cartesian3.fromDegrees(p1.lon, p1.lat), Cx.Cartesian3.fromDegrees(p2.lon, p2.lat)],
          minimumHeights: [0, 0], maximumHeights: [heightAt(p1.origIdx), heightAt(p2.origIdx)], vertexFormat: vf,
        }),
        attributes: { color: Cx.ColorGeometryInstanceAttribute.fromColor(color) }, id: `s-${i}`,
      }));
    } catch (e) { /* skip degenerate */ }
  }
  return inst;
}

// (3)/(4) the REAL globe3d code path (colour-bucket coalescing + flat format +
// wall thinning). `wallMaxSegments = Infinity` disables the thinning.
function buildRealInstances(wallMaxSegments) {
  global.Cesium = Cx;
  global.MapColors = MapColors;
  delete require.cache[require.resolve(GLOBE3D)];
  const { GSRGlobeManager } = require(GLOBE3D);
  const mgr = Object.create(GSRGlobeManager.prototype);
  Object.assign(mgr, {
    activeColoringMetric: metric, heightMetric, externalColorRange: { min: minV, max: maxV },
    baseHeight, extrusionScale, wallMaxSegments, showGroundPath: false, requestRenderMode: false,
    _cesiumColorLut: null, _cesiumColorLutKey: null,
    viewer: { scene: { primitives: { add(p) { mgr.__wall = p; } } }, entities: { add: () => ({}) } },
  });
  mgr._render3DWallAndPath(analyzer, drawPoints);
  return (mgr.__wall && mgr.__wall.geometryInstances) || [];
}

function realizeAndCombine(instances) {
  const realized = [];
  for (const inst of instances) {
    // WallGeometry.createGeometry returns undefined for a degenerate wall
    // (coincident points) — Cesium drops those silently too.
    const g = Cx.WallGeometry.createGeometry(inst.geometry);
    if (g) realized.push(new Cx.GeometryInstance({ geometry: g, attributes: inst.attributes, id: inst.id }));
  }
  if (realized.length) Cx.PrimitivePipeline.combineGeometry({ instances: realized });
  return realized;
}
function totals(realized) {
  let v = 0, idx = 0;
  for (const r of realized) { v += r.geometry.attributes.position.values.length / 3; idx += r.geometry.indices.length; }
  return { verts: v, tris: idx / 3 };
}

const VF_NORMAL = Cx.PerInstanceColorAppearance.VERTEX_FORMAT;      // position + normal
const VF_FLAT = Cx.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT;   // position only

const VARIANTS = [
  ['per-segment · pos+normal   (pre-refactor)', () => buildPerSegmentInstances(VF_NORMAL)],
  ['per-segment · pos only     (flat format)',  () => buildPerSegmentInstances(VF_FLAT)],
  ['coalesced   · no thinning',                 () => buildRealInstances(Infinity)],
  ['coalesced   · thinned      (current)',      () => buildRealInstances(undefined)],
];

console.log('── SECTION A — real geometry realization (WallGeometry.createGeometry + combineGeometry) ──\n');
const resA = [];
for (const [label, build] of VARIANTS) {
  const t = totals(realizeAndCombine(build()));
  const r = bench(label, 2, 12, () => realizeAndCombine(build()));
  r.instances = build().length; r.verts = t.verts; r.tris = t.tris;
  resA.push(r);
  printRow(r, `instances=${String(r.instances).padStart(5)}  verts=${String(t.verts).padStart(7)}  tris=${String(t.tris).padStart(7)}`);
}
{
  const base = resA[0], cur = resA[resA.length - 1];
  console.log(`\n  → current is ${(base.median / cur.median).toFixed(1)}x faster to realize+combine than pre-refactor`);
  console.log(`    (flat format alone: ${(resA[0].median / resA[1].median).toFixed(1)}x · coalescing: ${(resA[1].median / resA[2].median).toFixed(1)}x · thinning: ${(resA[2].median / resA[3].median).toFixed(1)}x)`);
  console.log(`    vertices ${base.verts} → ${cur.verts}  (${(base.verts / Math.max(1, cur.verts)).toFixed(1)}x fewer to upload / draw)\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B — orchestration cost (stub Cesium) — JS loop cost + counts
// ─────────────────────────────────────────────────────────────────────────────
delete global.Cesium; delete global.MapColors;
const counters = { fromDegrees: 0, colorParse: 0, GeometryInstance: 0, WallGeometry: 0, EllipsoidGeometry: 0, Primitive: 0, entityAdd: 0, entityRemove: 0, pointAdd: 0, labelAdd: 0 };
const reset = () => { for (const k in counters) counters[k] = 0; };

function autoStub() {
  const fn = function () { return autoStub(); };
  return new Proxy(fn, { get(t, p) { if (p in t) return t[p]; if (p === 'isDestroyed') return () => false; return autoStub(); }, apply() { return autoStub(); }, construct() { return autoStub(); } });
}
function stubCesium() {
  const C = autoStub();
  C.Cartesian3 = function (x, y, z) { return { x, y, z }; };
  C.Cartesian3.ZERO = { x: 0, y: 0, z: 0 };
  C.Cartesian3.fromDegrees = (lon, lat) => { counters.fromDegrees++; return { lon, lat }; };
  C.Cartesian3.fromDegreesArray = (a) => { const o = []; for (let i = 0; i < a.length; i += 2) { counters.fromDegrees++; o.push({ lon: a[i], lat: a[i + 1] }); } return o; };
  C.Cartesian3.fromDegreesArrayHeights = (a) => { const o = []; for (let i = 0; i < a.length; i += 3) { counters.fromDegrees++; o.push({ x: a[i], y: a[i + 1], z: a[i + 2] }); } return o; };
  C.Cartographic = { fromCartesian: () => ({ latitude: 0, longitude: 0 }) };
  C.Math = { toRadians: (d) => d * Math.PI / 180, toDegrees: (r) => r * 180 / Math.PI };
  const Color = function (r, g, b, a) { return { r, g, b, a, withAlpha(x) { return { r, g, b, a: x }; } }; };
  Color.fromCssColorString = (s) => { counters.colorParse++; return { _s: s, withAlpha: () => ({ _s: s }) }; };
  Color.WHITE = { withAlpha: () => ({}) };
  C.Color = Color;
  C.ColorGeometryInstanceAttribute = { fromColor: (c) => c };
  C.WallGeometry = function (o) { counters.WallGeometry++; this._o = o; };
  C.EllipsoidGeometry = function (o) { counters.EllipsoidGeometry++; this._o = o; };
  C.PolygonGeometry = function (o) { this._o = o; };
  C.PolygonHierarchy = function (p) { this.positions = p; };
  C.GeometryInstance = function (o) { counters.GeometryInstance++; this._o = o; return this; };
  C.Primitive = function (o) { counters.Primitive++; this._o = o; };
  C.PerInstanceColorAppearance = function (o) { this._o = o; };
  C.PerInstanceColorAppearance.VERTEX_FORMAT = {};
  C.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT = {};
  C.PolylineGlowMaterialProperty = function (o) { this._o = o; };
  C.Transforms = { eastNorthUpToFixedFrame: () => ({}) };
  C.ScreenSpaceEventHandler = function () { return { setInputAction() {}, removeInputAction() {}, isDestroyed: () => false, destroy() {} }; };
  C.ScreenSpaceEventType = {}; C.CameraEventType = {}; C.KeyboardEventModifier = {};
  C.Ion = { defaultAccessToken: '' };
  C.PointPrimitiveCollection = function () {
    return {
      add: (o) => { counters.pointAdd++; return o || {}; },
      removeAll: () => {},
    };
  };
  C.LabelCollection = function () {
    return {
      add: (o) => { counters.labelAdd++; return o || {}; },
      removeAll: () => {},
    };
  };
  const scene = { requestRenderMode: false, canvas: { addEventListener() {}, removeEventListener() {} }, screenSpaceCameraController: {}, globe: { ellipsoid: {} }, fog: {}, skyBox: {}, skyAtmosphere: {}, sun: {}, moon: {}, primitives: { add: (p) => p, remove: () => {} }, postRender: { addEventListener: () => () => {} }, requestRender() {}, pick: () => null };
  const camera = { positionWC: {}, positionCartographic: { height: 1200 }, heading: 0, pitch: -0.6, pickEllipsoid: () => ({}), flyTo() {}, flyToBoundingSphere() {}, lookAt() {}, lookAtTransform() {}, getPickRay: () => ({}) };
  const entities = {
    add: (o) => { counters.entityAdd++; return o || {}; },
    remove: () => { counters.entityRemove++; },
    removeById() {}, getById: () => null,
    suspendEvents() {}, resumeEvents() {},
  };
  C.Viewer = function () { return { scene, camera, clock: { onTick: { addEventListener: () => () => {} } }, entities, imageryLayers: { removeAll() {}, addImageryProvider() {} }, isDestroyed: () => false, destroy() {} }; };
  return C;
}

global.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (fn) => setTimeout(fn, 0) };
global.document = { activeElement: null, createElement: () => ({ style: {}, appendChild() {}, click() {} }), body: { appendChild() {}, removeChild() {} } };
global.Cesium = stubCesium();
global.MapColors = require(MAP_COLORS).MapColors;
delete require.cache[require.resolve(GLOBE3D)];
const { GSRGlobeManager } = require(GLOBE3D);

console.log('── SECTION B — main-thread JS per rebuild (stub Cesium) ──\n');
{
  const mgr = new GSRGlobeManager('c', { keyboardFlight: false });
  mgr.activeColoringMetric = metric;
  mgr.externalColorRange = { min: minV, max: maxV };
  mgr.currentAnalyzer = analyzer;
  mgr.currentDrawPoints = drawPoints;
  mgr.currentPeaks = (analyzer.peaks || []).filter((p) => !p.excluded);
  mgr.showPeaks = true;
  mgr.showLabels = true;
  mgr.showHotspots = true;

  let counts = '';
  const r = bench('_render3DWallAndPath', 3, 40, () => {
    mgr.clearTrackEntities();
    reset();
    mgr._render3DWallAndPath(analyzer, drawPoints);
    counts = `GeometryInstance=${counters.GeometryInstance}  colorParse=${counters.colorParse}  WallGeometry=${counters.WallGeometry}  entityAdd=${counters.entityAdd}`;
  });
  printRow(r, counts + '  (colorParse 0 on redraw = LUT reused; ≤30 on a metric/range change)');

  let spireCounts = '';
  const rS = bench('_renderPeakSpires', 3, 40, () => {
    mgr.clearPeakEntities();
    reset();
    mgr._renderPeakSpires(analyzer, mgr.currentPeaks);
    spireCounts = `points=${counters.pointAdd}  labels=${counters.labelAdd}  entityAdd=${counters.entityAdd}  fromDegrees=${counters.fromDegrees}`;
  });
  printRow(rS, `${mgr.currentPeaks.length} candidate peaks · ${spireCounts}`);

  let hotCounts = '';
  const rH = bench('_renderHotspots', 3, 40, () => {
    mgr.clearHotspotEntities();
    reset();
    mgr._renderHotspots(analyzer);
    hotCounts = `hotspots=${counters.labelAdd}  entityAdd=${counters.entityAdd}  fromDegrees=${counters.fromDegrees}`;
  });
  printRow(rH, `${(analyzer.memorableEvents || []).length} memorable events · ${hotCounts}`);

  // The whole main-thread JS a settled slider / metric / extrusion change reruns.
  const rAll = bench('full rebuild (wall+spires+hotspots)', 3, 30, () => {
    mgr.clearTrackEntities();
    mgr.clearPeakEntities();
    mgr.clearHotspotEntities();
    mgr._render3DWallAndPath(analyzer, drawPoints);
    mgr._renderPeakSpires(analyzer, mgr.currentPeaks);
    mgr._renderHotspots(analyzer);
  });
  printRow(rAll, 'wall geometry realize/upload is async (SECTION A) — not in this number');

  // Cold (memo dropped) — this is the once-per-render cost now; before the
  // 2026-09-08 spire pass it was paid once PER PEAK inside _peakWallHeight.
  const r2 = bench('_getMetricSeries x1 (cold)', 5, 200, () => {
    mgr._invalidateMetricSeriesCache();
    mgr._getMetricSeries(analyzer, metric);
  });
  printRow(r2, `series length ${(analyzer[SERIES_FIELD_GUESS(metric)] || analyzer.raw).length} — memoised; 1x/render`);

  mgr.rfMode = 'triband';
  global.GSRGlobe3DRf = require(path.join(APP_DIR, 'src', 'map', 'globe3d', 'rf_expanse.js')).GSRGlobe3DRf;
  const r4 = bench('render3DRfExpanse', 3, 40, () => { mgr.clearRfEntities(); mgr.render3DRfExpanse(analyzer, drawPoints); });
  printRow(r4, 'cheap, not a target');

  console.log('\n── SECTION C — hover scan ──\n');
  mgr.currentDrawPoints = drawPoints;
  const r3 = bench('_pickTrackPoint x500', 3, 20, () => { for (let k = 0; k < 500; k++) mgr._pickTrackPoint({ x: k, y: k }); });
  printRow(r3, `${drawPoints.length}-point scan/call, rAF-coalesced to ~1/frame`);
  mgr.destroy();
}

function SERIES_FIELD_GUESS(m) {
  return { phasic: 'phasic', tonic: 'tonic', arousalIndex: 'arousalIndex', triIndex: 'triIndex', peakDensity: 'peakDensity', phasicAUC: 'phasicAUC', em_fog: 'em_fog', emFog: 'em_fog' }[m] || 'raw';
}
console.log('');
