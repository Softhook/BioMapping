'use strict';

const assert = require('assert');
const test   = require('node:test');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

global.GSR_CONST = require('./mock_constants.js');
global.MarchingSquares = require('../src/render/marching_squares.js').MarchingSquares;

// gsr_filter.js is a bare `const GsrFilter = {…}` with no module.exports, so it
// has to be evaluated into the global scope the same way the analyzer tests do.
// The collective manager's z-score normalization (topographySource 'auc') goes
// through GsrFilter.calculateStats → StatsMath.calculateStats, so both must be
// live for the normalized-surface test below to exercise the real path.
global.StatsMath = require('../src/signal/stats_math.js').StatsMath;
(function loadGsrFilter() {
  const src = fs.readFileSync(path.join(__dirname, '../src/signal/gsr_filter.js'), 'utf8');
  vm.runInThisContext(src.replace(/const GsrFilter\s*=/, 'global.GsrFilter ='),
    { filename: 'gsr_filter.js' });
})();

const { GSRCollectiveManager } = require('../src/spatial/collective_manager.js');

function makeMockTrack(id, n = 36) {
  const points = [];
  const phasic = [];
  const phasicZ = [];
  const tonic = [];
  const tonicZ = [];
  const phasicAUC = [];
  const arousalIndex = [];
  const triIndex = [];
  const peaks = [];

  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / 6);
    const c = i % 6;
    points.push({ lat: 51.5 + r * 0.001, lon: -0.1 + c * 0.001 });
    phasic.push({ time: i, val: (r + 1) * 0.5 });
    phasicZ.push({ time: i, val: (r + 1) * 0.2 });
    tonic.push({ time: i, val: (c + 1) * 1.5 });
    tonicZ.push({ time: i, val: (c + 1) * 0.4 });
    phasicAUC.push({ time: i, val: (r * c + 1) * 0.1 });
    arousalIndex.push({ time: i, val: (r - c) * 0.3 });
    triIndex.push({ time: i, val: (r + c) * 0.2 });
  }
  peaks.push({ index: 5, amplitude: 2.0, excluded: false });
  peaks.push({ index: 15, amplitude: 1.0, excluded: true });
  peaks.push({ index: 25, amplitude: 3.5, excluded: false });

  return {
    id,
    enabled: true,
    analyzer: {
      raw: new Array(n).fill(0),
      sampleRate: 1,
      getCoordinates: (i) => points[i] || null,
      phasic, phasicZ, tonic, tonicZ, phasicAUC, arousalIndex, triIndex,
      phasicStd: 0.5,
      peaks,
    }
  };
}

test('generateContourSurface: runs across all topography sources without error and produces valid grids', () => {
  const mgr = new GSRCollectiveManager();
  mgr.addTrack(makeMockTrack('t1'));
  mgr.addTrack(makeMockTrack('t2'));

  const sources = ['peaks', 'phasic', 'tonic', 'auc', 'arousal_index', 'tri_index', 'triIndex', 'unknown_fallback'];
  for (const src of sources) {
    for (const norm of [false, true]) {
      const res = mgr.generateContourSurface({
        gridResolution: 10,
        contourCount: 4,
        isolationRadius: 500,
        topographySource: src,
        normalizeZScore: norm,
      });

      assert.ok(Array.isArray(res.grid), `grid should be array for ${src}, norm=${norm}`);
      assert.strictEqual(res.grid.length, 10);
      assert.strictEqual(res.grid[0].length, 10);
      assert.ok(typeof res.minVal === 'number');
      assert.ok(typeof res.maxVal === 'number');
      assert.ok(res.maxVal >= res.minVal);
      assert.ok(Array.isArray(res.contours));
    }
  }
});

// ── active-metric resolution ────────────────────────────────────────────────
// Points now carry only { lat, lon, val } — the active series is resolved once
// per track and written to .val, with no mirrored phasic/tonic/... fields to
// fall back on. These pin that .val holds exactly the series the
// topographySource names, so a wrong selection can't slip through unnoticed.
// A constant series + peakPreservation 0 + no softening/blur makes every
// non-null grid cell equal the series value, so result.minVal is that value.

function makeConstTrack(id, consts, n = 36) {
  const mk = (v) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push({ time: i, val: v });
    return a;
  };
  const points = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / 6);
    const c = i % 6;
    points.push({ lat: 51.5 + r * 0.001, lon: -0.1 + c * 0.001 });
  }
  return {
    id,
    enabled: true,
    analyzer: {
      raw: new Array(n).fill(0),
      sampleRate: 1,
      getCoordinates: (i) => points[i] || null,
      phasic: mk(consts.phasic), phasicZ: mk(consts.phasicZ),
      tonic: mk(consts.tonic), tonicZ: mk(consts.tonicZ),
      phasicAUC: mk(consts.phasicAUC), arousalIndex: mk(consts.arousalIndex),
      triIndex: mk(consts.triIndex),
      phasicStd: 0.5,
      peaks: [],
    }
  };
}

const FLAT_PARAMS = {
  gridResolution: 10, contourCount: 3, isolationRadius: 500,
  peakPreservation: 0, softening: 0, blurIterations: 0,
};

const CONSTS = {
  phasic: 1.0, phasicZ: 5.0, tonic: 7.0, tonicZ: 2.0,
  phasicAUC: 0.4, arousalIndex: -3.0, triIndex: 9.0,
};

test('generateContourSurface: non-normalized surface value tracks the series named by topographySource', () => {
  const cases = [
    ['phasic', 1.0],
    ['tonic', 7.0],
    ['auc', 0.4],
    ['arousal_index', -3.0],
    ['tri_index', 9.0],
    ['triIndex', 9.0],
    ['unknown_fallback', 1.0],   // falls back to phasic
  ];
  for (const [src, expected] of cases) {
    const mgr = new GSRCollectiveManager();
    mgr.addTrack(makeConstTrack('t1', CONSTS));
    const res = mgr.generateContourSurface({ ...FLAT_PARAMS, topographySource: src, normalizeZScore: false });
    assert.ok(Math.abs(res.minVal - expected) < 1e-9,
      `${src}: expected surface value ${expected}, got minVal=${res.minVal}`);
  }
});

test('generateContourSurface: normalized surface uses the *Z series for phasic / tonic and arousal_index as-is', () => {
  const expect = {
    phasic: 5.0,          // phasicZ
    tonic: 2.0,           // tonicZ
    arousal_index: -3.0,  // already standardized upstream — used as-is
  };
  for (const src of Object.keys(expect)) {
    const mgr = new GSRCollectiveManager();
    mgr.addTrack(makeConstTrack('t1', CONSTS));
    const res = mgr.generateContourSurface({ ...FLAT_PARAMS, topographySource: src, normalizeZScore: true });
    assert.ok(Math.abs(res.minVal - expect[src]) < 1e-9,
      `${src} normalized: expected ${expect[src]}, got minVal=${res.minVal}`);
  }
});

test('generateContourSurface: AUC source is per-track z-scored only when normalizeZScore is on', () => {
  // Two-value AUC series (mean 0.4, std 0.2) → z-scores of ±1 straddling zero.
  const n = 36;
  const points = [];
  const phasicAUC = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / 6);
    const c = i % 6;
    points.push({ lat: 51.5 + r * 0.001, lon: -0.1 + c * 0.001 });
    phasicAUC.push({ time: i, val: (i % 2 === 0) ? 0.2 : 0.6 });
  }
  const makeTrack = () => ({
    id: 't1', enabled: true,
    analyzer: {
      raw: new Array(n).fill(0), sampleRate: 1,
      getCoordinates: (i) => points[i] || null,
      phasic: [], phasicZ: [], tonic: [], tonicZ: [],
      phasicAUC, arousalIndex: [], triIndex: [],
      phasicStd: 1, peaks: [],
    }
  });
  const base = { ...FLAT_PARAMS, topographySource: 'auc' };

  const mgrRaw = new GSRCollectiveManager();
  mgrRaw.addTrack(makeTrack());
  const raw = mgrRaw.generateContourSurface({ ...base, normalizeZScore: false });

  const mgrNorm = new GSRCollectiveManager();
  mgrNorm.addTrack(makeTrack());
  const norm = mgrNorm.generateContourSurface({ ...base, normalizeZScore: true });

  // Un-normalized: raw AUC is strictly positive.
  assert.ok(raw.minVal >= 0.2 - 1e-9, `raw AUC surface should stay positive, got minVal=${raw.minVal}`);
  // Normalized: z-scores straddle zero and stay within a sane band.
  assert.ok(norm.minVal < -0.1, `normalized AUC should dip below zero, got minVal=${norm.minVal}`);
  assert.ok(norm.maxVal > 0.1, `normalized AUC should rise above zero, got maxVal=${norm.maxVal}`);
  assert.ok(norm.minVal > -1.5 && norm.maxVal < 1.5, `normalized AUC should be ~unit scale, got [${norm.minVal}, ${norm.maxVal}]`);

  // The AUC z-score stats resolver falls back to StatsMath.calculateStats when
  // GsrFilter isn't on the global (both return a { mean, std } shape). Force
  // that branch and confirm the normalized surface still comes out the same.
  const savedGsrFilter = global.GsrFilter;
  try {
    delete global.GsrFilter;
    const mgrFallback = new GSRCollectiveManager();
    mgrFallback.addTrack(makeTrack());
    const fb = mgrFallback.generateContourSurface({ ...base, normalizeZScore: true });
    assert.ok(Math.abs(fb.minVal - norm.minVal) < 1e-9 && Math.abs(fb.maxVal - norm.maxVal) < 1e-9,
      `StatsMath.calculateStats fallback should match GsrFilter path, got [${fb.minVal}, ${fb.maxVal}] vs [${norm.minVal}, ${norm.maxVal}]`);
  } finally {
    global.GsrFilter = savedGsrFilter;
  }
});

test('generateContourSurface: temporalSmoothingWindow smooths the active series before gridding', () => {
  // One sharp spike in an otherwise flat phasic series; a wide smoothing window
  // must pull the surface maximum well below the raw spike height.
  const n = 36;
  const points = [];
  const phasic = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / 6);
    const c = i % 6;
    points.push({ lat: 51.5 + r * 0.001, lon: -0.1 + c * 0.001 });
    phasic.push({ time: i, val: i === 18 ? 10.0 : 0.0 });
  }
  const makeTrack = () => ({
    id: 't1', enabled: true,
    analyzer: {
      raw: new Array(n).fill(0), sampleRate: 1,
      getCoordinates: (i) => points[i] || null,
      phasic, phasicZ: phasic, tonic: [], tonicZ: [],
      phasicAUC: [], arousalIndex: [], triIndex: [],
      phasicStd: 1, peaks: [],
    }
  });
  const base = {
    gridResolution: 10, contourCount: 3, isolationRadius: 500,
    peakPreservation: 0, softening: 0, blurIterations: 0,
    topographySource: 'phasic', normalizeZScore: false,
  };

  const mgrRaw = new GSRCollectiveManager();
  mgrRaw.addTrack(makeTrack());
  const raw = mgrRaw.generateContourSurface({ ...base, temporalSmoothingWindow: 0 });

  const mgrSm = new GSRCollectiveManager();
  mgrSm.addTrack(makeTrack());
  const sm = mgrSm.generateContourSurface({ ...base, temporalSmoothingWindow: 20 });

  assert.ok(raw.maxVal > 1.0, `precondition: raw spike survives into the surface (maxVal=${raw.maxVal})`);
  assert.ok(sm.maxVal < raw.maxVal - 1e-6,
    `smoothed maxVal (${sm.maxVal}) should sit below the raw spike surface (${raw.maxVal})`);
});

test('generateContourSurface: peaks mode produces identical surface when continuous series are omitted', () => {
  const mgr1 = new GSRCollectiveManager();
  mgr1.addTrack(makeMockTrack('t1'));

  const res1 = mgr1.generateContourSurface({
    gridResolution: 10,
    contourCount: 4,
    isolationRadius: 500,
    topographySource: 'peaks',
    normalizeZScore: false,
  });

  // Second manager where continuous series are empty
  const trackBare = makeMockTrack('t2');
  trackBare.analyzer.phasic = [];
  trackBare.analyzer.tonic = [];
  trackBare.analyzer.phasicAUC = [];
  trackBare.analyzer.arousalIndex = [];
  trackBare.analyzer.triIndex = [];

  const mgr2 = new GSRCollectiveManager();
  mgr2.addTrack(trackBare);

  const res2 = mgr2.generateContourSurface({
    gridResolution: 10,
    contourCount: 4,
    isolationRadius: 500,
    topographySource: 'peaks',
    normalizeZScore: false,
  });

  assert.strictEqual(res1.minVal, res2.minVal);
  assert.strictEqual(res1.maxVal, res2.maxVal);
  assert.strictEqual(res1.contours.length, res2.contours.length);
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      assert.strictEqual(res1.grid[r][c], res2.grid[r][c]);
    }
  }
});
