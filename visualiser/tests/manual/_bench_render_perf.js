'use strict';
/**
 * Real A/B timing for the three Phase 6 rendering-perf changes (architecture
 * refactor plan §Phase 6 / docs/archive/visualizer_rendering_perf_routes.md). Not a
 * regression test (no assertions, nothing fails CI) — a measurement script,
 * following the `_probe_*.js` convention in this directory. Run manually:
 *
 *   node tests/manual/_bench_render_perf.js
 *
 * Each bench times the REAL production code paths (not reimplementations)
 * against real or realistically-shaped fixtures, using the same
 * bootApp()+recording-Leaflet harness tests/test_map_layer_ownership.js and
 * tests/test_rf_fluid_spatial_index.js already validate for correctness —
 * this file adds timing on top of paths already proven identical/correct.
 *
 * Methodology note: the recording Leaflet mock (copied from
 * tests/test_map_layer_ownership.js) tracks add/remove/hasLayer with plain
 * Maps/Arrays instead of real DOM/SVG manipulation, and there is no real
 * canvas/browser paint. That means these numbers isolate the actual JS-side
 * cost this codebase controls — marker/connector construction, cluster
 * blob computation, label-collision layout, contour surface generation —
 * from browser layout/paint cost, which Node can't reproduce. The absolute
 * ms will be lower than a real browser; the SPEEDUP RATIO between full
 * rebuild and scoped refresh is the number that carries over, because both
 * sides of each A/B pay the same (near-zero) mocked DOM cost and differ only
 * in how much real JS work they do.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootApp } = require('../support/boot_app.js');

const TRACKS_DIR = path.join(__dirname, '..', '..', '..', 'tracks');

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

// Runs `fn` `warmup + iters` times, discards the warmup runs (JIT/inline-cache
// settling — matters here because both sides of each A/B are freshly-defined
// closures the first few calls), returns { median, mean, min, max } in ms.
function bench(label, warmup, iters, fn) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < iters; i++) samples.push(timeMs(fn));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { label, median: median(samples), mean, min: Math.min(...samples), max: Math.max(...samples), n: iters };
}

function printRow(r) {
  console.log(
    `  ${r.label.padEnd(28)} median=${r.median.toFixed(3).padStart(9)}ms  mean=${r.mean.toFixed(3).padStart(9)}ms  ` +
    `min=${r.min.toFixed(3).padStart(8)}ms  max=${r.max.toFixed(3).padStart(8)}ms  (n=${r.n})`
  );
}

function printSpeedup(before, after) {
  const ratio = before.median / after.median;
  console.log(`  → scoped refresh is ${ratio.toFixed(1)}x faster (median) than the full rebuild it replaced\n`);
}

// ── Shared recording Leaflet (verbatim from tests/test_map_layer_ownership.js) ──
function installRecordingLeaflet(window) {
  const map = {
    _layers: new Map(), _direct: [], _groups: new Map(), _viaGroup: new Set(), _nextId: 1,
    addLayer(layer) {
      if (!layer || typeof layer !== 'object') return map;
      if (layer._gsrId === undefined) layer._gsrId = map._nextId++;
      map._layers.set(layer._gsrId, layer);
      if (layer._isGroup) {
        map._groups.set(layer._gsrId, layer);
        layer._onMap = true;
        layer._children.forEach(c => map._viaGroup.add(c));
      } else {
        map._direct.push(layer);
      }
      return map;
    },
    removeLayer(layer) {
      if (!layer || layer._gsrId === undefined) return map;
      if (layer._isGroup) {
        map._groups.delete(layer._gsrId);
        map._layers.delete(layer._gsrId);
        layer._onMap = false;
        layer._children.forEach(c => map._viaGroup.delete(c));
      } else {
        const i = map._direct.indexOf(layer);
        if (i >= 0) map._direct.splice(i, 1);
        map._layers.delete(layer._gsrId);
        map._viaGroup.delete(layer);
        for (const g of map._groups.values()) {
          if (g.hasLayer(layer)) g._children.delete(layer._gsrId);
        }
      }
      return map;
    },
    hasLayer(layer) {
      if (!layer || layer._gsrId === undefined) return false;
      if (layer._isGroup) return map._groups.has(layer._gsrId);
      return map._direct.includes(layer) || map._viaGroup.has(layer);
    },
    latLngToLayerPoint() { return { x: 10, y: 20 }; },
    fitBounds() {},
    setView() { return map; },
    getBounds() { return { pad: () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) }) }; },
    getSize() { return { x: 800, y: 600 }; },
    on() {},
    remove() {},
  };

  function makeLayer(kind) {
    return {
      _gsrId: map._nextId++, _isGroup: false, _gsrKind: kind || 'layer', _gsrLayerGroup: null,
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      bindPopup() { return this; }, bindTooltip() { return this; },
      setZIndexOffset() { return this; }, setOpacity() { return this; },
      setLatLng() { return this; }, on() { return this; }, openPopup() { return this; }
    };
  }
  function makeGroup() {
    return {
      _gsrId: map._nextId++, _isGroup: true, _children: new Map(), _onMap: false,
      addLayer(child) { this._children.set(child._gsrId, child); if (this._onMap) map._viaGroup.add(child); return this; },
      removeLayer(child) { this._children.delete(child._gsrId); if (this._onMap) map._viaGroup.delete(child); return this; },
      hasLayer(child) { return this._children.has(child._gsrId); },
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      getLayers() { return [...this._children.values()]; },
      eachLayer(fn) { this._children.forEach(fn); }
    };
  }
  class FakeControl {
    constructor(options) { this.options = options || {}; }
    _onAdd() { return window.document.createElement('div'); }
    addTo(m) { m.addLayer(this); this._container = this._onAdd(); return this; }
    getContainer() { return this._container; }
    getPosition() { return this.options.position; }
  }
  FakeControl.extend = (proto) => {
    class C extends FakeControl {}
    Object.keys(proto).forEach(k => { C.prototype[k] = proto[k]; });
    return C;
  };

  const L = {
    map: () => map,
    layerGroup: makeGroup,
    polyline: (latlngs, opts) => { const l = makeLayer('path'); l._latlngs = latlngs; l._options = opts; return l; },
    polygon: (latlngs, opts) => { const l = makeLayer('cluster'); l._latlngs = latlngs; l._options = opts; return l; },
    marker: (latlng, opts) => { const l = makeLayer('marker'); l._latlng = latlng; l._options = opts; return l; },
    tileLayer: () => makeLayer('tile'),
    imageOverlay: (url, bounds, opts) => { const l = makeLayer('surface'); l._url = url; l._bounds = bounds; l._options = opts; return l; },
    featureGroup: function (layers) {
      const g = makeGroup();
      (layers || []).forEach(l => g.addLayer(l));
      g.getBounds = () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) });
      return g;
    },
    divIcon: (opts) => opts || {},
    icon: (opts) => opts || {},
    DomUtil: { create: (tag, className) => { const el = window.document.createElement(tag); if (className) el.className = className; return el; }, setTransform() {} },
    Control: FakeControl
  };
  window.L = L;
  return { L, map };
}

function bootWithRecordingL() {
  const { window, context } = bootApp();
  // RF fluid is a separate perf item (§bench 1 below, self-contained) — nulled
  // here so these two benches isolate the peak-marker refresh path, same as
  // test_map_layer_ownership.js does. GSRSpatialClustering is deliberately
  // LEFT DEFINED (unlike that test file) so cluster-blob computation — real
  // work both renderData() and refreshPeakMarkers()/refreshCollectivePeakMarkers()
  // pay for — is included on both sides of the A/B, matching production.
  vm.runInContext('RFFluidRenderer = undefined;', context);
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
  const { map } = installRecordingLeaflet(window);
  window.setup();
  return { window, map, mapManager: window.AppState.mapManager, context };
}

function loadRealTrack(window, id, filename) {
  const analyzer = new window.GSRAnalyzer();
  const csv = fs.readFileSync(path.join(TRACKS_DIR, filename), 'utf8');
  analyzer.parseCSV(csv);
  const track = window.GSRTrackManager.createTrackObject(id, filename, '#ff0000', analyzer);
  analyzer.analyze(track.filterParams, 0);
  window.AppState.collectiveManager.addTrack(track);
  return track;
}

function gpsDefault(context) {
  return vm.runInContext('JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT))', context);
}

// ── Bench 1: RF fan-cast spatial index (grid vs forced brute-force fallback) ──
// Same seam test_rf_fluid_spatial_index.js uses for correctness
// (`_buildSegmentGrid` stubbed to return null routes the exact same node loop
// back to scanning `buildingSegmentsGeo` directly) — here timed instead of
// diffed. Fixture scaled up from that test's (6 nodes / 16 segments) to
// something with real lookup cost to save: 400 track nodes, ~2400 building
// segments spread across the same area (not clustered near just 2 nodes),
// so the brute-force side pays a full segments scan for every node.
function benchRfSpatialIndex() {
  console.log('── Bench 1: RF fan-cast — grid index vs forced brute-force scan ──');
  console.log('   (rf_fluid_renderer.js: _precalculateSpatialFans, Phase 6 step 1)\n');

  global.L = { DomUtil: { create: () => ({ style: {}, getContext: () => fakeCanvasContext() }), setPosition() {}, setTransform() {} } };
  global.window = { devicePixelRatio: 1 };
  function fakeCanvasContext() {
    return new Proxy({}, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'canvas') return { width: 400, height: 300 };
        return (...args) => (String(prop).startsWith('create') ? new Proxy({}, { get: () => () => {} }) : undefined);
      }
    });
  }
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'render', 'rf_fluid_renderer.js'), 'utf8');
  vm.runInThisContext(src.replace('class RFFluidRenderer', 'global.RFFluidRenderer = class RFFluidRenderer'), { filename: 'rf_fluid_renderer.js' });
  const RFFluidRenderer = global.RFFluidRenderer;

  function makeFakeMap() {
    const panes = {};
    return {
      getPane: (name) => panes[name] || null,
      createPane: (name) => { panes[name] = { style: {}, appendChild: () => {} }; return panes[name]; },
      on: () => {},
      getBounds: () => ({ pad: () => ({ contains: () => true, getNorthWest: () => ({ lat: 52, lon: -1 }), getSouthEast: () => ({ lat: 51, lon: 0 }) }) }),
      latLngToLayerPoint: () => ({ x: 100, y: 100 }),
      getZoomScale: () => 1, getZoom: () => 15, getSize: () => ({ x: 800, y: 600 }),
      _latLngToNewLayerPoint: () => ({ x: 0, y: 0 }),
    };
  }

  // 400 nodes along a ~2km path.
  const drawPoints = [];
  for (let i = 0; i < 400; i++) {
    drawPoints.push({ lat: 51.5000 + i * 0.000018, lon: -0.1000 + i * 0.000018, rssi_815: -70, rssi_868: -75, rssi_915: -60 });
  }
  // Buildings scattered ~uniformly over a 6km x 6km area (a plausible OSM
  // enrichment bbox for a dense city map view) at ~50% occupancy of 15m
  // cells — deterministic pseudo-random, not clustered around the track.
  // This is the realistic shape the fix targets: a LARGE total dataset
  // (~40k buildings / ~160k segments, brute force's O(nodes x segments)
  // cost) where any single node's actual 35m-radius neighborhood only ever
  // contains a couple dozen of them (grid's cost). An earlier version of
  // this fixture clustered buildings tightly around 10 "town center"
  // pockets and found almost no speedup — profiling traced that to an
  // unrealistic ~1,000+ buildings within a single node's 35m radius, which
  // made the (identical either way) ray/segment intersection pass dominate
  // over the candidate-gathering pass this fix actually targets. Real city
  // block density is far sparser at 35m — this fixture models that instead.
  function buildingAt(lat, lon) {
    const d = 0.00001;
    return { type: 'way', tags: { building: 'yes' }, coordinates: [
      { lat: lat - d, lon: lon - d }, { lat: lat + d, lon: lon - d },
      { lat: lat + d, lon: lon + d }, { lat: lat - d, lon: lon + d },
    ] };
  }
  function rand(n) { return Math.sin(n * 12.9898) * 43758.5453 % 1; }
  const ways = [];
  const CELL_M = 15, SPAN_M = 6000;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(51.5 * Math.PI / 180);
  const nCells = Math.floor(SPAN_M / CELL_M);
  let idx = 0;
  for (let a = 0; a < nCells; a++) {
    for (let b = 0; b < nCells; b++) {
      idx++;
      if (rand(idx) < 0.5) continue;
      const lat = 51.4970 + (a * CELL_M + rand(idx + 9999) * CELL_M) / metersPerDegLat;
      const lon = -0.1300 + (b * CELL_M + rand(idx + 7777) * CELL_M) / metersPerDegLon;
      ways.push(buildingAt(lat, lon));
    }
  }
  const osmGeoms = { ways };
  console.log(`   fixture: ${drawPoints.length} nodes, ${ways.length} buildings (${ways.length * 4} segments)\n`);

  const gridResult = bench('grid-indexed (current)', 2, 8, () => {
    const r = new RFFluidRenderer(makeFakeMap(), { visible: true });
    r.setData(drawPoints, osmGeoms);
  });
  const bruteResult = bench('brute-force (pre-fix)', 2, 8, () => {
    const r = new RFFluidRenderer(makeFakeMap(), { visible: true });
    r._buildSegmentGrid = () => null;
    r.setData(drawPoints, osmGeoms);
  });
  printRow(bruteResult);
  printRow(gridResult);
  printSpeedup(bruteResult, gridResult);

  delete global.L; delete global.window; delete global.RFFluidRenderer;
}

// ── Bench 2: single-track peak-label edit — refreshPeakMarkers() vs full renderData() ──
function benchSingleTrackPeakRefresh() {
  console.log('── Bench 2: single-track peak-label edit — refreshPeakMarkers() vs full renderData() ──');
  console.log('   (map.js, Phase 6 ad-hoc fix + step 2; fixture: real track biomap_016.csv)\n');

  const { window, mapManager, context } = bootWithRecordingL();
  const track = loadRealTrack(window, 'bench-single', 'biomap_016.csv');
  window.AppState.activeTrackId = track.id;
  window.AppState.analyzer = track.analyzer;
  const gpsParams = gpsDefault(context);

  console.log(`   fixture: ${track.analyzer.peaks.length} peaks, ${track.analyzer.raw.length} raw rows\n`);

  mapManager.renderData(track.analyzer, gpsParams); // establish the track's layerGroup

  let i = 0;
  const editAndFullRender = () => {
    track.analyzer.peaks[i % track.analyzer.peaks.length].label = `Label ${i++}`;
    mapManager.renderData(track.analyzer, gpsParams);
  };
  const editAndScopedRefreshNoSkip = () => {
    track.analyzer.peaks[i % track.analyzer.peaks.length].label = `Label ${i++}`;
    mapManager.refreshPeakMarkers(track.analyzer, gpsParams);
  };
  // The actual call ui.js's updatePeakLabel() makes today (perf-routes §2.4,
  // now landed): passes skipClustering so a label edit — which can't affect
  // clusterPeaks()'s lat/lon/amplitude input — doesn't recompute cluster
  // blobs on every keystroke-commit.
  const editAndScopedRefreshSkipClustering = () => {
    track.analyzer.peaks[i % track.analyzer.peaks.length].label = `Label ${i++}`;
    mapManager.refreshPeakMarkers(track.analyzer, gpsParams, { skipClustering: true });
  };

  const fullResult = bench('renderData() [pre-fix]', 3, 20, editAndFullRender);
  const scopedNoSkipResult = bench('refreshPeakMarkers() [no skip]', 3, 20, editAndScopedRefreshNoSkip);
  const scopedResult = bench('refreshPeakMarkers() [current]', 3, 20, editAndScopedRefreshSkipClustering);
  printRow(fullResult);
  printRow(scopedNoSkipResult);
  printRow(scopedResult);
  console.log(`  → skipClustering alone is ${(scopedNoSkipResult.median / scopedResult.median).toFixed(1)}x faster than the`);
  console.log(`    same call without it (isolates §2.4's fix from the path/hotspot skip §2.2 already landed)`);
  printSpeedup(fullResult, scopedResult);
}

// Real same-city tracks (all London — see bench 4's comment for why this
// matters: an earlier fixture accidentally included a track recorded in a
// different city entirely, which produces a degenerate all-null grid that
// hid a real bug during development of the bench 4 fix).
const COLLECTIVE_FIXTURE_FILES = ['biomap_016.csv', 'biomap_039.csv', 'biomap_048.csv', 'biomap_015.csv'];

// ── Bench 3: collective-mode peak-label edit — refreshCollectivePeakMarkers() vs full renderCollectiveData() ──
function benchCollectiveTrackPeakRefresh() {
  console.log('── Bench 3: collective-mode peak-label edit — refreshCollectivePeakMarkers() vs full renderCollectiveData() ──');
  console.log('   (map.js, Phase 6 step 2 collective piece; fixture: 4 real same-city tracks)\n');

  const { window, mapManager, context } = bootWithRecordingL();
  window.AppState.viewMode = 'collective';
  const tracks = COLLECTIVE_FIXTURE_FILES.map((f, idx) => loadRealTrack(window, `bench-${idx}`, f));
  const totalPeaks = tracks.reduce((s, t) => s + t.analyzer.peaks.length, 0);
  console.log(`   fixture: ${tracks.length} tracks, ${totalPeaks} total peaks (target track: ${tracks[0].analyzer.peaks.length} peaks)\n`);

  const contourParams = { gridResolution: 40, contourCount: 10, isolationRadius: 50, idwExponent: 2, topographySource: 'phasic', showShadedSurface: false, normalizeZScore: true, surfaceOpacity: 0.4 };
  mapManager.renderCollectiveData(window.AppState.collectiveManager, contourParams, 0); // establish layerGroups

  const target = tracks[0];
  let i = 0;
  const editAndFullRebuild = () => {
    target.analyzer.peaks[i % target.analyzer.peaks.length].label = `Label ${i++}`;
    mapManager.renderCollectiveData(window.AppState.collectiveManager, contourParams, 0);
  };
  const editAndScopedRefresh = () => {
    target.analyzer.peaks[i % target.analyzer.peaks.length].label = `Label ${i++}`;
    mapManager.refreshCollectivePeakMarkers(target, 0);
  };

  const fullResult = bench('renderCollectiveData() [pre-fix]', 3, 15, editAndFullRebuild);
  const scopedResult = bench('refreshCollectivePeakMarkers() [current]', 3, 15, editAndScopedRefresh);
  printRow(fullResult);
  printRow(scopedResult);
  printSpeedup(fullResult, scopedResult);
}

// ── Bench 4: cold collective render — getConcaveBlob() + generateContourSurface() cost ──
// Unlike bench 3 (a label edit on an ALREADY-rendered collective view), this
// times the full renderCollectiveData() cost itself — what pays every time
// collective mode is entered, a track is added/removed, or a contour
// parameter changes. Both GSRSpatialClustering.getConcaveBlob() (cluster
// boundary blobs) and GSRCollectiveManager.generateContourSurface() (the
// IDW topography surface) used to scan every (grid cell, peak-or-point)
// pair unconditionally; both are now point-major splats that only touch
// cells within actual range. See docs/archive/visualizer_architecture_refactor_plan.md
// Phase 7 for the full before/after (verified via git stash on this exact
// fixture: ~101ms -> ~36ms, 2.8x, for the full renderCollectiveData() call).
function benchCollectiveColdRender() {
  console.log('── Bench 4: cold collective render — getConcaveBlob()/generateContourSurface() cost ──');
  console.log('   (spatial_clustering.js + collective_manager.js, Phase 7; fixture: 4 real same-city tracks)\n');

  const { window, mapManager, context } = bootWithRecordingL();
  window.AppState.viewMode = 'collective';
  const tracks = COLLECTIVE_FIXTURE_FILES.map((f, idx) => loadRealTrack(window, `bench4-${idx}`, f));
  const totalPeaks = tracks.reduce((s, t) => s + t.analyzer.peaks.length, 0);
  console.log(`   fixture: ${tracks.length} tracks, ${totalPeaks} total peaks\n`);

  const contourParams = { gridResolution: 40, contourCount: 10, isolationRadius: 50, idwExponent: 2, topographySource: 'phasic', showShadedSurface: false, normalizeZScore: true, surfaceOpacity: 0.4 };
  const collectiveManager = window.AppState.collectiveManager;

  const GSRSpatialClustering = vm.runInContext('GSRSpatialClustering', context);
  let blobMs = 0, blobN = 0, surfaceMs = 0, surfaceN = 0;
  const origBlob = GSRSpatialClustering.getConcaveBlob.bind(GSRSpatialClustering);
  GSRSpatialClustering.getConcaveBlob = (...a) => { const t0 = process.hrtime.bigint(); const r = origBlob(...a); blobMs += Number(process.hrtime.bigint() - t0) / 1e6; blobN++; return r; };
  const origSurface = collectiveManager.generateContourSurface.bind(collectiveManager);
  collectiveManager.generateContourSurface = (...a) => { const t0 = process.hrtime.bigint(); const r = origSurface(...a); surfaceMs += Number(process.hrtime.bigint() - t0) / 1e6; surfaceN++; return r; };

  const fullResult = bench('renderCollectiveData() [current]', 3, 12, () => {
    mapManager.renderCollectiveData(collectiveManager, contourParams, 0);
  });
  printRow(fullResult);
  console.log(`  getConcaveBlob:          avg=${(blobMs / blobN).toFixed(3)}ms/call over ${blobN} calls`);
  console.log(`  generateContourSurface:  avg=${(surfaceMs / surfaceN).toFixed(3)}ms/call over ${surfaceN} calls`);
  console.log('  (compare against this phase\'s documented pre-fix numbers — see the plan doc)\n');
}

// ── Bench 5: GPS pipeline cache-miss cost — trimmed vs full-row-spread _collectGpsPoints() ──
// What pays once per settled frame of a GPS-param slider drag (Q/R/HDOP/
// speed/downsample/RDP sliders — anything that changes `_hashGpsParams()`'s
// output), on a large real track: `_getOrBuildDrawPoints()`'s cache misses
// and reruns the full pipeline (§2.1's already-fixed RF fan-cast cost is a
// separate, later stage — this is the pipeline that FEEDS it). Same forced-
// fallback seam bench 1 uses (method override, not a reimplementation):
// `_collectGpsPoints` swapped back to the pre-fix full `{ ...data[i],
// origIdx: i }` spread to measure what the trim (perf-routes §2.7) removed.
function benchGpsCollectPoints() {
  console.log('── Bench 5: GPS pipeline cache-miss cost — _collectGpsPoints() field trim ──');
  console.log('   (map.js, perf-routes §2.7; fixture: real track biomap_019.csv, 40,747 rows)\n');

  const { window, mapManager } = bootWithRecordingL();
  const track = loadRealTrack(window, 'bench5', 'biomap_019.csv');
  const p = { maxHdop: 2.0, smoothing: 0.5, kalmanR: 10, maxSpeed: 3.0, rdpTolerance: 0, downsample: false };

  console.log(`   fixture: ${track.analyzer.raw.length} raw rows\n`);

  const origCollect = mapManager._collectGpsPoints.bind(mapManager);
  function fullSpreadCollect(data) {
    const pts = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i]._isGpsFix && !isNaN(data[i].lat) && !isNaN(data[i].lon)) {
        pts.push({ ...data[i], origIdx: i });
      }
    }
    return pts;
  }

  const runFullSpread = () => {
    mapManager._gpsCache.clear();
    track.analyzer._filteredGpsCacheKey = null;
    mapManager._collectGpsPoints = fullSpreadCollect;
    mapManager._getOrBuildDrawPoints('bench5', track.analyzer, p);
  };
  const runTrimmed = () => {
    mapManager._gpsCache.clear();
    track.analyzer._filteredGpsCacheKey = null;
    mapManager._collectGpsPoints = origCollect;
    mapManager._getOrBuildDrawPoints('bench5', track.analyzer, p);
  };

  const fullResult = bench('full-row-spread [pre-fix]', 2, 8, runFullSpread);
  const trimmedResult = bench('field-trimmed [current]', 2, 8, runTrimmed);
  printRow(fullResult);
  printRow(trimmedResult);
  printSpeedup(fullResult, trimmedResult);

  mapManager._collectGpsPoints = origCollect;
}

benchRfSpatialIndex();
benchSingleTrackPeakRefresh();
benchCollectiveTrackPeakRefresh();
benchCollectiveColdRender();
benchGpsCollectPoints();
