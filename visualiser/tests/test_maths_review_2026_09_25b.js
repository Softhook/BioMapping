/**
 * Regression tests for the second 2026-09-25 maths review. Each test pins
 * one defect reproduced against the old code:
 *  - applyZeroPhaseMovingAverage spread a W-sample window over 2W−1 samples.
 *  - The multi-walk speed-adjusted meta-analysis took no degree of freedom
 *    for the speed covariate.
 *  - Arousal Places energy and the collective surface ignored each walk's
 *    stimulus latency, while the peak markers they sit under applied it.
 */
const assert = require('node:assert');
const test = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
const { GsrFilter } = require('../src/signal/gsr_filter.mjs');
const { StatsMath } = require('../src/signal/stats_math.mjs');
const { GSRArousalPlaces } = require('../src/spatial/arousal_places.mjs');
const {
  GSRCollectiveManager,
} = require('../src/spatial/collective_manager.mjs');

const LAT0 = 51.55;
const LON0 = -0.08;

// ── Zero-phase moving average ───────────────────────────────────────────────

test('applyZeroPhaseMovingAverage: a W-sample window spans exactly W samples (triangle)', () => {
  const x = new Array(41).fill(0);
  x[20] = 1;
  const y = GsrFilter.applyZeroPhaseMovingAverage(x, 5);
  const support = y
    .map((v, i) => [i, v])
    .filter(([, v]) => v > 1e-12)
    .map(([i]) => i);
  assert.deepStrictEqual(support, [18, 19, 20, 21, 22]); // old code: 16..24
  const expect = [1, 2, 3, 2, 1].map((w) => w / 9);
  support.forEach((i, k) => {
    assert.ok(Math.abs(y[i] - expect[k]) < 1e-12, `weight ${k}`);
  });
});

test('applyZeroPhaseMovingAverage(2W−1) reproduces the old W-box-twice filter exactly (decomposition unchanged)', () => {
  // The previous implementation, verbatim in behaviour: a centred box of
  // width W with fractional end weights, run forward then on the reversal.
  const legacy = (arr, windowSize) => {
    const n = arr.length;
    const pass = (data) => {
      const res = new Array(n);
      const r = (windowSize - 1) / 2;
      const m = Math.floor(r);
      const f = r - m;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < n; i++) {
        sum = 0;
        count = 0;
        for (let j = i - m - 1; j <= i + m + 1; j++) {
          if (j < 0 || j >= n) continue;
          const w = j === i - m - 1 || j === i + m + 1 ? f : 1;
          sum += w * data[j];
          count += w;
        }
        res[i] = count > 0 ? sum / count : data[i];
      }
      return res;
    };
    return pass(pass(arr).reverse()).reverse();
  };
  const x = Array.from(
    { length: 300 },
    (_, i) => Math.sin(i * 0.37) + i * 0.01,
  );
  const W = 40; // decomposeTonicPhasic's Math.round(4 s × 10 Hz)
  const a = legacy(x, W);
  const b = GsrFilter.applyZeroPhaseMovingAverage(x, 2 * W - 1);
  const maxDiff = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  assert.ok(maxDiff < 1e-9, `max diff ${maxDiff}`);
});

// ── Meta-analysis covariate degrees of freedom ──────────────────────────────

test('metaCorrelation: nCovariates costs each walk a degree of freedom', () => {
  // Five short walks with a genuine moderate correlation.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const groups = [];
  for (let g = 0; g < 5; g++) {
    const x = [];
    const y = [];
    for (let i = 0; i < 20; i++) {
      const xv = rnd();
      x.push(xv);
      y.push(0.5 * xv + rnd());
    }
    groups.push({ x, y });
  }
  const plain = StatsMath.metaCorrelation(groups);
  const adj = StatsMath.metaCorrelation(
    groups.map((g) => ({ ...g, nCovariates: 1 })),
  );
  assert.strictEqual(plain.k, adj.k);
  assert.ok(Math.abs(plain.r - adj.r) < 0.02, 'effect size barely moves');
  assert.ok(adj.p > plain.p, `p ${adj.p} should exceed ${plain.p}`);
});

// ── Stimulus latency on the map surfaces ────────────────────────────────────

test('Arousal Places: phasic energy is filed at the latency-shifted position', () => {
  // 10 Hz, 20 s; one phasic spike at t = 10 s.
  const raw = [];
  const phasic = [];
  for (let i = 0; i < 200; i++) {
    raw.push({ time: i / 10, lat: LAT0 + i * 1e-5, lon: LON0 });
    phasic.push({ time: i / 10, val: i === 100 ? 1 : 0 });
  }
  const shifted = GSRArousalPlaces._getOrBuildFastCoords({
    raw,
    phasic,
    latency: 2,
  });
  assert.strictEqual(shifted.phasicVals[80], 1, 'energy at t − 2 s');
  assert.strictEqual(shifted.phasicVals[100], 0);
  const unshifted = GSRArousalPlaces._getOrBuildFastCoords({
    raw,
    phasic,
    latency: 0,
  });
  assert.strictEqual(unshifted.phasicVals[100], 1, 'no latency → in place');
});

test('Arousal Places: phasic whose stimulus came before the recording started is left out', () => {
  // 10 Hz, 5 s, phasic 1 everywhere, 2 s latency: the first 2 s of phasic
  // responds to places before the track began.
  const raw = [];
  const phasic = [];
  for (let i = 0; i < 50; i++) {
    raw.push({ time: i / 10, lat: LAT0 + i * 1e-5, lon: LON0 });
    phasic.push({ time: i / 10, val: 1 });
  }
  const { phasicVals } = GSRArousalPlaces._getOrBuildFastCoords({
    raw,
    phasic,
    latency: 2,
  });
  assert.strictEqual(phasicVals[0], 1, 'not piled onto the first sample');
  assert.strictEqual(
    phasicVals.reduce((s, v) => s + v, 0),
    30,
    'only the 30 samples from t = 2 s on are filed',
  );
});

test('Collective surface: values and peaks are placed at each walk’s latency-shifted position', () => {
  const n = 300; // 30 s at 10 Hz
  const raw = [];
  const series = [];
  for (let i = 0; i < n; i++) {
    raw.push({ time: i / 10 });
    series.push({ time: i / 10, val: i });
  }
  const idxAt = (t) => Math.max(0, Math.min(n - 1, Math.round(t * 10)));
  const analyzer = {
    raw,
    sampleRate: 10,
    phasic: series,
    tonic: series,
    peaks: [{ index: 150, time: 15, amplitude: 1 }],
    // Latitude == sample index, so a point's lat says which sample it used.
    getCoordinates: (i) => ({ lat: i, lon: 0 }),
    stimulusIndexAt: (t, lag) => idxAt(t - lag),
    resolveLatencyIndex: (pk, lag) => idxAt(pk.time - lag),
  };
  const track = { analyzer, gpsFilterParams: { peakLatency: 2 } };
  const mgr = new GSRCollectiveManager();
  const base = { temporalSmoothingWindow: 0, useNormalization: false };

  const ph = mgr._collectContourPoints([track], {
    ...base,
    topographySource: 'phasic',
  });
  for (const p of ph.points) {
    const i = p.val; // the sample the value came from
    assert.strictEqual(p.lat, Math.max(0, i - 20), `phasic sample ${i}`);
  }
  assert.strictEqual(ph.peaks[0].lat, 130, 'peak at t − 2 s');

  // Tonic uses the longer baseline lag (4 × 2 s = 8 s), as the dashboard does.
  const to = mgr._collectContourPoints([track], {
    ...base,
    topographySource: 'tonic',
  });
  for (const p of to.points) {
    assert.strictEqual(p.lat, Math.max(0, p.val - 80), `tonic sample ${p.val}`);
  }
});
