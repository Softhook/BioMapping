'use strict';
/**
 * SUPERSEDED for most areas by bench/run.js — the track-parametrised runner
 * (`node tests/manual/bench/run.js --list`). Use that to see how a bottleneck
 * scales across tiny→large real walks. This file is kept for the few one-off,
 * NOT-track-parametrised findings it still uniquely holds: [5] per-frame object
 * allocation COUNT, [6] `_snapFingerprint` string-alloc, [7] DOM `L.marker` vs
 * canvas `L.circleMarker` construction (an architecture comparison, not a hot
 * path), plus the git-stash before/after narrative in each section.
 *
 * ── original header ──
 * Comprehensive profiling script covering all identified visualizer performance bottlenecks.
 * Primary subject Track 113 (biomap_113.csv, 11,298 rows, 332 peaks, 11,204 GPS fixes) — a
 * MID-SIZED track. [2b] repeats the Arousal Places chain against biomap_016.csv (35,467 rows,
 * 888 peaks, 19 clusters), the real worst case, so the headline numbers aren't optimistic.
 *
 * [0]  refreshPeakMarkers(): warm Arousal Places cache vs forced miss vs skipClustering
 * [1]  Arousal Places Scoring: O(places × N) raw sample scan in GSRArousalPlaces.buildPlaces()
 * [2]  Arousal Places Outlines: sequential Marching Squares KDE calls (getConcaveBlob)
 * [2b] Arousal Places WORST CASE: full compactClusters + buildPlaces + all blobs on biomap_016
 * [3]  Spatial Clustering: compactClusters() scaling (the live clusterer; grid leader-assignment)
 * [4]  Collective Topography: 'peaks' KDE cell-major scan in generateContourSurface()
 * [5]  Signal Pipeline: Unpooled {time, val} object allocations (45k objects per slider drag on Track 113)
 * [6]  GPS Pipeline: Object.keys() allocation on cache probe & RTS smoothing math on real fixes
 * [7]  Map Marker Creation: DOM L.marker vs Canvas L.circleMarker creation cost
 * [8]  Canvas Graph: Full draw() pipeline cost on mouse hover with Track 113 active
 *
 * NOTE: this runs under a RECORDING MOCK Leaflet (no real DOM). Pure-compute numbers
 * ([1]/[2]/[2b]/[3]/[5]/[6]) are faithful; anything that builds map layers ([0], [7])
 * understates a real browser — [7] is the isolated per-marker DOM cost to add back.
 *
 * Run manually:
 *   node tests/manual/_bench_all_perf_areas.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
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

function bench(warmup, iters, fn) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < iters; i++) samples.push(timeMs(fn));
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { median: median(samples), mean, min: Math.min(...samples), max: Math.max(...samples), n: iters };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup Environment & Recording Leaflet
// ─────────────────────────────────────────────────────────────────────────────
const { window, context } = bootApp();

function installRecordingLeaflet(win) {
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
      }
      return map;
    },
    hasLayer(layer) {
      if (!layer || layer._gsrId === undefined) return false;
      if (layer._isGroup) return map._groups.has(layer._gsrId);
      return map._direct.includes(layer) || map._viaGroup.has(layer);
    },
    latLngToLayerPoint(ll) {
      const lat = Array.isArray(ll) ? ll[0] : ll.lat;
      const lon = Array.isArray(ll) ? ll[1] : (ll.lng !== undefined ? ll.lng : ll.lon);
      return { x: (lon + 0.15) * 50000, y: (51.6 - lat) * 50000 };
    },
    layerPointToLatLng(pt) { return { lat: 51.6 - pt.y / 50000, lng: pt.x / 50000 - 0.15 }; },
    fitBounds() {}, setView() { return map; },
    getBounds() {
      return {
        pad: () => ({
          getNorthWest: () => ({ lat: 51.6, lon: -0.2 }),
          getSouthEast: () => ({ lat: 51.4, lon: -0.05 })
        }),
        contains: () => true
      };
    },
    getZoom() { return 14; },
    getSize() { return { x: 800, y: 600 }; },
    getPane() { return { appendChild() {} }; },
    createPane() { return { appendChild() {} }; },
    on() {}, remove() {}
  };

  function makeLayer(kind) {
    return {
      _gsrId: map._nextId++, _isGroup: false, _gsrKind: kind || 'layer', _gsrLayerGroup: null,
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      bindPopup() { return this; }, bindTooltip() { return this; },
      setZIndexOffset() { return this; }, setOpacity() { return this; },
      setLatLng() { return this; },
      on() { return this; }, openPopup() { return this; }
    };
  }

  function makeGroup() {
    return {
      _gsrId: map._nextId++, _isGroup: true, _children: new Map(), _onMap: false,
      addLayer(c) { this._children.set(c._gsrId, c); if (this._onMap) map._viaGroup.add(c); return this; },
      removeLayer(c) { this._children.delete(c._gsrId); if (this._onMap) map._viaGroup.delete(c); return this; },
      hasLayer(c) { return this._children.has(c._gsrId); },
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
      getLayers() { return [...this._children.values()]; },
      eachLayer(fn) { this._children.forEach(fn); }
    };
  }

  class FakeControl {
    constructor(options) { this.options = options || {}; }
    _onAdd() { return win.document.createElement('div'); }
    addTo(m) { m.addLayer(this); this._container = this._onAdd(); return this; }
    getContainer() { return this._container; }
    getPosition() { return this.options.position; }
  }
  FakeControl.extend = (proto) => {
    class C extends FakeControl {}
    Object.keys(proto).forEach(k => { C.prototype[k] = proto[k]; });
    return C;
  };

  win.L = {
    map: () => map,
    layerGroup: makeGroup,
    featureGroup: function (layers) {
      const g = makeGroup();
      (layers || []).forEach(l => g.addLayer(l));
      g.getBounds = () => ({ getNorthWest: () => ({ lat: 0, lon: 0 }), getSouthEast: () => ({ lat: 0, lon: 0 }) });
      return g;
    },
    latLng: (a, b) => ({ lat: a, lng: b, distanceTo: () => 1 }),
    point: (x, y) => ({ x, y }),
    polyline: (ll, o) => { const l = makeLayer('path'); l._latlngs = ll; l._options = o; return l; },
    polygon: (ll, o) => { const l = makeLayer('polygon'); l._latlngs = ll; l._options = o; return l; },
    marker: (ll, o) => { const l = makeLayer('marker'); l._latlng = ll; l._options = o; return l; },
    circleMarker: (ll, o) => { const l = makeLayer('circleMarker'); l._latlng = ll; l._options = o; return l; },
    tileLayer: () => makeLayer('tile'),
    imageOverlay: (u, b, o) => { const l = makeLayer('surface'); l._url = u; l._bounds = b; l._options = o; return l; },
    divIcon: (o) => o || {},
    icon: (o) => o || {},
    DomUtil: {
      create: (tag, className) => {
        const el = win.document.createElement(tag);
        if (className) el.className = className;
        return el;
      },
      setTransform() {}
    },
    Control: FakeControl
  };
}

vm.runInContext('RFFluidRenderer = undefined;', context);
vm.runInContext('var width = 1200, height = 600, mouseX = 500, mouseY = 300, winMouseX = 500, winMouseY = 300, BOLD = "bold", NORMAL = "normal", ITALIC = "italic", circle = () => {}, ellipse = () => {}, triangle = () => {};', context);
window.width = 1200;
window.height = 600;
window.mouseX = 500;
window.mouseY = 300;
window.winMouseX = 500;
window.winMouseY = 300;
window.BOLD = 'bold';
window.NORMAL = 'normal';
window.ITALIC = 'italic';
window.circle = () => {};
window.ellipse = () => {};
window.triangle = () => {};
window.document.elementFromPoint = () => (window.AppState.myCanvas ? window.AppState.myCanvas.elt : null);
window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {}, beginPath() {}, arc() {}, fill() {} });
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
window.GSR_CONST = vm.runInContext('GSR_CONST', context);
window.GpsFilter = vm.runInContext('GpsFilter', context);

installRecordingLeaflet(window);
window.setup();

// Load Real Track Helper
function loadRealTrack(id, filename) {
  const fullPath = path.join(TRACKS_DIR, filename);
  const text = fs.readFileSync(fullPath, 'utf8');
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(text);
  const track = window.GSRTrackManager.createTrackObject(id, filename, '#ff0000', analyzer);
  analyzer.analyze(track.filterParams, 0);
  return { id, filename, track, analyzer, text };
}

console.log('='.repeat(78));
console.log('PROFILING SUITE: ALL VISUALIZER PERFORMANCE BOTTLENECKS');
console.log('Primary subject: Track 113 (biomap_113.csv, mid-sized) — worst case [2b]: biomap_016.csv');
console.log('='.repeat(78));

const track113 = loadRealTrack('trk113', 'biomap_113.csv');
const track016 = loadRealTrack('trk016', 'biomap_016.csv');

const rawPoints113 = track113.analyzer.raw;
const validPeaks113 = track113.analyzer.peaks.filter(p => !p.excluded);
const gpsFixes113 = rawPoints113.filter(d => d._isGpsFix && !isNaN(d.lat));

console.log(`\n[Dataset Verification: Track 113]`);
console.log(`  File:           ${track113.filename}`);
console.log(`  Raw Samples:    ${rawPoints113.length.toLocaleString()} points`);
console.log(`  Sample Rate:    ${track113.analyzer.sampleRate} Hz (${(rawPoints113.length / track113.analyzer.sampleRate / 60).toFixed(1)} minutes duration)`);
console.log(`  Detected Peaks: ${track113.analyzer.peaks.length} total (${validPeaks113.length} valid active)`);
console.log(`  GPS Fixes:      ${gpsFixes113.length.toLocaleString()} fixes`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 0: End-to-End Production Map Render (Realistic Baseline)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[0] End-to-End Production Map Marker Refresh: refreshPeakMarkers()');
console.log('    Full refresh with a WARM Arousal Places cache (repeat call, no input change)');
console.log('    vs a forced cache MISS (peak amplitude nudged) vs skipClustering (label-edit path).');

window.AppState.collectiveManager = new window.GSRCollectiveManager();
window.AppState.collectiveManager.addTrack(track113.track);
window.AppState.activeTrackId = 'trk113';
window.AppState.currentTrack = track113.track;
window.AppState.analyzer = track113.analyzer;

// Initial render to mount layers into the map
window.AppState.mapManager.renderData(track113.analyzer, {});

// WARM: inputs unchanged between calls → _arousalPlacesCache hits, so
// compactClusters/buildPlaces/getConcaveBlob are all skipped (only the Leaflet
// layer rebuild runs). This is the common interactive case (any slider that
// isn't a peak slider or #placeMergeDistance).
const bRefreshWarm = bench(2, 6, () => {
  window.AppState.mapManager.refreshPeakMarkers(track113.analyzer, {}, { skipClustering: false });
});

// MISS: perturb a peak amplitude each call so the fingerprint changes and the
// full compactClusters + buildPlaces + getConcaveBlob pipeline reruns. This is
// the cost of a peak-threshold/quality/shape-slider frame or an exclusion toggle.
let ampToggle = 0;
const firstActivePeak = track113.analyzer.peaks.find(p => !p.excluded);
const bRefreshMiss = bench(2, 6, () => {
  firstActivePeak.amplitude += (ampToggle++ % 2 === 0) ? 1e-4 : -1e-4;
  window.AppState.mapManager.refreshPeakMarkers(track113.analyzer, {}, { skipClustering: false });
});

const bRefreshNoCluster = bench(2, 6, () => {
  window.AppState.mapManager.refreshPeakMarkers(track113.analyzer, {}, { skipClustering: true });
});

console.log(`    refreshPeakMarkers, cache WARM (unchanged inputs):   median=${bRefreshWarm.median.toFixed(2)}ms`);
console.log(`    refreshPeakMarkers, cache MISS (peak set changed):   median=${bRefreshMiss.median.toFixed(2)}ms`);
console.log(`    refreshPeakMarkers, { skipClustering: true }:        median=${bRefreshNoCluster.median.toFixed(2)}ms`);
console.log(`    Arousal Places compute avoided by a cache hit:       ${(bRefreshMiss.median - bRefreshWarm.median).toFixed(2)}ms`);
console.log(`    Warm-cache speedup vs a cold miss:                   ${(bRefreshMiss.median / Math.max(bRefreshWarm.median, 1e-3)).toFixed(1)}x`);
console.log(`    NB: mock Leaflet — the WARM/skipClustering figures are compute-only; a real`);
console.log(`        browser adds the marker/polygon layer rebuild (see [7] for the DOM cost).`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 1: Arousal Places Scoring (GSRArousalPlaces.buildPlaces)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Arousal Places Scoring: GSRArousalPlaces.buildPlaces()');
console.log('    Problem: O(places × N) unindexed loop across all raw samples.');

const peaks113 = validPeaks113.map(pk => {
  const c = track113.analyzer.getCoordinates(pk.index) || { lat: 51.5, lon: -0.1 };
  return { lat: c.lat, lon: c.lon, amplitude: pk.amplitude, time: pk.time, trackId: 'trk113' };
});
const clusters113 = window.GSRSpatialClustering.compactClusters(peaks113, 35, 1.8);
const scoreTracks113 = [{
  id: 'trk113',
  sampleRate: track113.analyzer.sampleRate,
  raw: track113.analyzer.raw,
  phasic: track113.analyzer.phasic
}];

const resBuildPlaces = bench(2, 10, () => {
  window.GSRArousalPlaces.buildPlaces(clusters113, scoreTracks113, window.GSR_CONST.AROUSAL_PLACES);
});
console.log(`    Fixture: ${clusters113.length} clusters across ${rawPoints113.length.toLocaleString()} raw samples`);
console.log(`    Time: median=${resBuildPlaces.median.toFixed(2)}ms (min=${resBuildPlaces.min.toFixed(2)}ms, max=${resBuildPlaces.max.toFixed(2)}ms)`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 2: Sequential Marching Squares KDE in _renderArousalPlaces()
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Arousal Places Outlines: Sequential getConcaveBlob() calls');
console.log('    Problem: Up to 20 separate 70x70 grid KDEs + Marching Squares passes.');

const places113 = window.GSRArousalPlaces.buildPlaces(clusters113, scoreTracks113, window.GSR_CONST.AROUSAL_PLACES);
const meanAmp113 = peaks113.reduce((s, p) => s + p.amplitude, 0) / Math.max(1, peaks113.length);

const singleBlobBench = bench(3, 15, () => {
  window.GSRSpatialClustering.getConcaveBlob(places113[0].cluster, 12.25, 17.5, meanAmp113);
});
const allBlobsBench = bench(1, 6, () => {
  for (let i = 0; i < places113.length; i++) {
    window.GSRSpatialClustering.getConcaveBlob(places113[i].cluster, 12.25, 17.5, meanAmp113);
  }
});
console.log(`    Single place getConcaveBlob():                   median=${singleBlobBench.median.toFixed(2)}ms`);
console.log(`    All ${places113.length} places getConcaveBlob() loop:           median=${allBlobsBench.median.toFixed(2)}ms total`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 2b: WORST-CASE single track — the full Arousal Places recompute chain
// (compactClusters + buildPlaces + every getConcaveBlob) that a peak-slider drag
// frame or a #placeMergeDistance drag frame pays, on the largest real track.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2b] Arousal Places WORST CASE (biomap_016.csv): full recompute chain');

const validPeaks016 = track016.analyzer.peaks.filter(p => !p.excluded);
const peaks016 = validPeaks016.map(pk => {
  const c = track016.analyzer.getCoordinates(pk.index) || { lat: 51.5, lon: -0.1 };
  return { lat: c.lat, lon: c.lon, amplitude: pk.amplitude, time: pk.time, trackId: 'trk016' };
});
const scoreTracks016 = [{
  id: 'trk016',
  sampleRate: track016.analyzer.sampleRate,
  raw: track016.analyzer.raw,
  phasic: track016.analyzer.phasic
}];
const meanAmp016 = peaks016.reduce((s, p) => s + p.amplitude, 0) / Math.max(1, peaks016.length);

let clusters016;
const bCluster016 = bench(2, 10, () => { clusters016 = window.GSRSpatialClustering.compactClusters(peaks016, 35, 1.8); });
const bBuild016 = bench(2, 8, () => {
  window.GSRArousalPlaces.buildPlaces(clusters016, scoreTracks016, window.GSR_CONST.AROUSAL_PLACES);
});
const places016 = window.GSRArousalPlaces.buildPlaces(clusters016, scoreTracks016, window.GSR_CONST.AROUSAL_PLACES);
const bBlobs016 = bench(1, 6, () => {
  for (let i = 0; i < places016.length; i++) {
    window.GSRSpatialClustering.getConcaveBlob(places016[i].cluster, 12.25, 17.5, meanAmp016);
  }
});
const total016 = bCluster016.median + bBuild016.median + bBlobs016.median;
console.log(`    ${track016.analyzer.raw.length.toLocaleString()} rows, ${peaks016.length} peaks → ${clusters016.length} clusters (${places016.length} places after cap)`);
console.log(`    compactClusters():   median=${bCluster016.median.toFixed(2)}ms`);
console.log(`    buildPlaces():        median=${bBuild016.median.toFixed(2)}ms   (vs ${resBuildPlaces.median.toFixed(2)}ms on track 113)`);
console.log(`    all getConcaveBlob(): median=${bBlobs016.median.toFixed(2)}ms   (vs ${allBlobsBench.median.toFixed(2)}ms on track 113)`);
console.log(`    → full recompute ≈ ${total016.toFixed(1)}ms/frame  (track 113 ≈ ${bRefreshMiss.median.toFixed(1)}ms)`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 3: compactClusters() scaling — the LIVE Arousal Places clusterer
// (grid leader-assignment, O(N); replaced the removed N×N-matrix clusterPeaks()).
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Spatial Clustering: compactClusters() scaling (grid leader-assignment, O(N))');

const bCompact113 = bench(3, 20, () => {
  window.GSRSpatialClustering.compactClusters(peaks113, 35, 1.8);
});
console.log(`    Track 113 (N=${peaks113.length} peaks): median=${bCompact113.median.toFixed(3)}ms`);

// Multi-track collective scaling — jittered duplicates of track 113's peaks.
for (const count of [1000, 2000, 4000]) {
  const pts = [...peaks113];
  while (pts.length < count) {
    pts.push(...peaks113.map(p => ({ ...p, lat: p.lat + 0.002 * Math.random(), lon: p.lon + 0.002 * Math.random() })));
  }
  const slice = pts.slice(0, count);
  const res = bench(3, 12, () => {
    window.GSRSpatialClustering.compactClusters(slice, 35, 1.8);
  });
  console.log(`    Collective N=${count.toString().padEnd(4)} peaks: median=${res.median.toFixed(3)}ms`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile 4: Collective Topography 'peaks' Mode Brute-Force Scan
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Collective Topography: generateContourSurface()');
console.log('    Comparing continuous IDW vs unindexed "peaks" KDE scan.');

window.AppState.collectiveManager = new window.GSRCollectiveManager();
window.AppState.collectiveManager.addTrack(track113.track);
window.AppState.collectiveManager.addTrack(track016.track);

const bIdw = bench(1, 6, () => {
  window.AppState.collectiveManager.generateContourSurface({
    topographySource: 'phasic',
    gridResolution: 40,
    upsampledResolution: 120,
    isolationRadius: 60,
    blurIterations: 1
  });
});

const bPeaks = bench(1, 6, () => {
  window.AppState.collectiveManager.generateContourSurface({
    topographySource: 'peaks',
    gridResolution: 40,
    upsampledResolution: 120,
    isolationRadius: 60,
    blurIterations: 1
  });
});
console.log(`    Continuous IDW (point-major splatting): median=${bIdw.median.toFixed(2)}ms`);
console.log(`    "peaks" Mode (cell-major peak scan):     median=${bPeaks.median.toFixed(2)}ms`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 5: Signal Pipeline Allocation Overhead (Unpooled Objects)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] Signal Processing Pipeline: Unpooled Object Allocation Churn');
console.log('    Problem: peakDensity, phasicAUC, arousalIndex, triIndex allocate unpooled objects on every drag.');

const an113 = track113.analyzer;
const n113 = an113.raw.length; // 11,298
const tMetrics = bench(2, 10, () => {
  an113.computeTemporalPeakDensity();
  an113.computePhasicAUC();
  an113.computeCombinedArousalIndex(0.3, 0.7);
  an113.computeTriIndex(0.1, 0.45, 0.45);
});
console.log(`    Track 113 (${n113} points)`);
console.log(`    Total 4-metrics compute time: median=${tMetrics.median.toFixed(2)}ms`);
console.log(`    Allocated objects per run: ~${(n113 * 4).toLocaleString()} objects (~${((n113 * 4 * 48) / (1024 * 1024)).toFixed(1)} MB heap churn per drag frame)`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 6: GPS Pipeline Cache Probe & RTS Math on Track 113
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] GPS Pipeline: Cache Fingerprint Probe & RTS Smoothing Math');
console.log('    Problem: Object.keys() on GPS fixes + per-point trig in RTS backward pass.');

// Real snapped dictionary sizing based on Track 113's 11,204 GPS fixes
const snapped113 = {};
for (let i = 0; i < gpsFixes113.length; i++) snapped113[i] = { alpha: 0.85 };

const bSnapFp = bench(10, 50, () => {
  window.AppState.mapManager._snapFingerprint(snapped113);
});
console.log(`    _snapFingerprint on ${gpsFixes113.length.toLocaleString()} keys: median=${bSnapFp.median.toFixed(3)}ms (allocates ${gpsFixes113.length} strings on every probe)`);

// Full RTS smoothing pass on all 11,204 real GPS fixes from Track 113
const bKalman = bench(2, 10, () => {
  window.GpsFilter.applyKalman(gpsFixes113, 0.5, 10);
});
console.log(`    applyKalman() on all ${gpsFixes113.length.toLocaleString()} Track 113 GPS fixes: median=${bKalman.median.toFixed(2)}ms`);

// ─────────────────────────────────────────────────────────────────────────────
// Profile 7: Map Marker Creation Overhead: DOM L.marker vs Canvas L.circleMarker
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Map Layer Creation: DOM L.marker vs Canvas L.circleMarker');
console.log('    Problem: Thousands of L.marker instances create real DOM elements with CSS transforms.');

for (const count of [peaks113.length, 1000, 3000]) {
  const bDomMarker = bench(5, 20, () => {
    const pane = window.document.createElement('div');
    for (let i = 0; i < count; i++) {
      const el = window.document.createElement('div');
      el.className = 'peak-marker-cluster';
      el.style.transform = 'translate3d(100px, 200px, 0px)';
      pane.appendChild(el);
    }
  });

  const bCircleMarker = bench(5, 20, () => {
    const canvas = window.document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < count; i++) {
      ctx.beginPath();
      ctx.arc(100, 200, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  const label = count === peaks113.length ? `Track 113 (${count} peaks)` : `Collective (${count.toString().padEnd(4)} peaks)`;
  console.log(`    ${label.padEnd(28)} | DOM (nodes): ${bDomMarker.median.toFixed(2)}ms | Canvas (path): ${bCircleMarker.median.toFixed(2)}ms | Speedup: ${(bDomMarker.median / Math.max(0.001, bCircleMarker.median)).toFixed(0)}x`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile 8: Canvas Graph Hover Redraw on Track 113
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[8] Canvas Graph: Full draw() Pipeline Cost on Mouse Hover');
console.log('    Problem: Moving the mouse over the graph runs full draw() (~60fps).');

window.AppState.analyzer = track113.analyzer;
window.AppState.viewDuration = 300;
window.AppState.viewStartTime = 0;
window.AppState.totalDuration = track113.analyzer.raw.length / track113.analyzer.sampleRate;
window.AppState.showRaw = true;
window.AppState.showFiltered = true;
window.AppState.showTonic = true;
window.AppState.showPeaks = true;
window.AppState.showHotspots = true;

const bFullDraw = bench(5, 20, () => {
  window.draw();
});
console.log(`    Full draw() execution time: median=${bFullDraw.median.toFixed(2)}ms per frame`);
console.log(`    Frame budget at 60fps is 16.6ms -> draw() consumes ${(bFullDraw.median / 16.6 * 100).toFixed(1)}% of frame budget.`);

console.log('\n' + '='.repeat(78));
console.log('PROFILING COMPLETE');
console.log('='.repeat(78));
