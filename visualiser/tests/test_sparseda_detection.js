/**
 * SparsEDA must model (and so detect) every clearly visible response in the
 * phasic. Each test pins one defect that silently lost responses:
 *   - the reference window baseline (first sample) applied to a
 *     tonic-subtracted input pushed windows below zero (zeroBaseline);
 *   - dmin-suppressed atoms were dropped instead of merged (half the mass);
 *   - tails of responses from earlier windows were re-fitted (double count);
 *   - per-atom apex mapping skipped visible peaks between overlapping atoms;
 *   - epsilon=1 stopped each 70 s window after one or two atoms.
 * Plus the two cost fixes that make the fuller solve affordable: span-limited
 * dot products (bit-identical) and the solve cache.
 */
const assert = require('node:assert');
const test = require('node:test');

global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
const { SCRDeconvolution: D } = require('../src/signal/deconvolution.mjs');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');

const FS = 10;
const bateman = (t, ts = 2.0, tf = 0.5) =>
  t <= 0 ? 0 : Math.exp(-t / ts) - Math.exp(-t / tf);
const peakOf = (ts = 2.0, tf = 0.5) => {
  let m = 0;
  for (let s = 0; s < 20; s += 0.001) m = Math.max(m, bateman(s, ts, tf));
  return m;
};

/** Phasic of unit-peak SCRs: events = [[onsetSec, amplitude], ...]. */
function phasicOf(events, durSec) {
  const n = durSec * FS;
  const y = new Float64Array(n);
  const pk = peakOf();
  for (const [t0, a] of events)
    for (let i = 0; i < n; i++) y[i] += (a * bateman(i / FS - t0)) / pk;
  return y;
}

const sparse = (y, extra = {}) =>
  D.deconvolve(y, FS, {
    algorithm: 'sparseda',
    maxIter: GSR_CONST.SCRF.sparsedaKmax,
    epsilon: GSR_CONST.SCRF.sparsedaEpsilon,
    dminSec: GSR_CONST.SCRF.sparsedaDminSec,
    rho: 0,
    zeroBaseline: true,
    ...extra,
  });

const r2 = (y, c, i0 = 0, i1 = y.length) => {
  let m = 0;
  for (let i = i0; i < i1; i++) m += y[i];
  m /= i1 - i0;
  let ss = 0;
  let sr = 0;
  for (let i = i0; i < i1; i++) {
    ss += (y[i] - m) ** 2;
    sr += (y[i] - c[i]) ** 2;
  }
  return 1 - sr / ss;
};

test('a recording that starts mid-response is still modelled (zero baseline)', () => {
  // First sample sits on the decay of a response that began before t=0.
  const y = phasicOf(
    [
      [-2, 0.3],
      [12, 0.15],
      [30, 0.2],
      [48, 0.1],
    ],
    90,
  );
  const r = sparse(y);
  assert.ok(
    r2(y, r.clean, 0, 70 * FS) > 0.9,
    `R² ${r2(y, r.clean, 0, 70 * FS)}`,
  );
});

test('an isolated response keeps its amplitude (suppressed atoms are merged)', () => {
  // Off the 8 Hz grid and not exactly the dictionary's shape — the realistic
  // case, where LARS splits one response across adjacent onsets and dropping
  // the smaller part lost ~40-45% of the amplitude.
  for (const [t0, ts, tf] of [
    [20.07, 2.6, 0.7],
    [20.03, 1.6, 0.4],
    [20.11, 3.0, 0.6],
  ]) {
    const pk = peakOf(ts, tf);
    const y = new Float64Array(80 * FS);
    for (let i = 0; i < y.length; i++)
      y[i] = (0.4 * bateman(i / FS - t0, ts, tf)) / pk;
    const r = sparse(y);
    let m = 0;
    for (const v of r.clean) m = Math.max(m, v);
    assert.ok(
      Math.abs(m - 0.4) / 0.4 < 0.1,
      `onset ${t0}: reconstructed peak ${m}`,
    );
  }
});

test('a response spanning a window boundary is not counted twice', () => {
  // Onsets near the end of the first 20/40/60 s chunks; their tails run into
  // the next window.
  const y = phasicOf(
    [
      [17, 0.3],
      [38, 0.3],
      [58, 0.3],
      [79, 0.3],
    ],
    140,
  );
  const r = sparse(y);
  let over = 0;
  for (let i = 0; i < y.length; i++) over = Math.max(over, r.clean[i] - y[i]);
  assert.ok(over < 0.06, `reconstruction overshoots the phasic by ${over}`);
  assert.ok(r2(y, r.clean) > 0.9, `R² ${r2(y, r.clean)}`);
});

test('span-limited dot products give bit-identical SparsEDA output', () => {
  const y = phasicOf(
    [
      [5, 0.2],
      [9, 0.1],
      [30, 0.3],
      [44, 0.05],
    ],
    80,
  );
  const fast = sparse(y);
  const build = D._buildReferenceDictionary;
  D._buildReferenceDictionary = function (...a) {
    const d = build.apply(this, a);
    for (const c of d.columns) {
      delete c._s;
      delete c._e;
    }
    return d;
  };
  try {
    const full = sparse(y);
    assert.ok(fast.driver.every((v, i) => Object.is(v, full.driver[i])));
    assert.ok(fast.clean.every((v, i) => Object.is(v, full.clean[i])));
  } finally {
    D._buildReferenceDictionary = build;
  }
});

function trackCsv(events, durSec) {
  const y = phasicOf(events, durSec);
  const rows = ['timestamp,Raw Conductance (uS)'];
  for (let i = 0; i < y.length; i++)
    rows.push(`${(i / FS).toFixed(1)},${(4 + y[i]).toFixed(5)}`);
  return rows.join('\n');
}

test('SparsEDA finds every response the full-scan detector sees in the phasic', () => {
  // Isolated, closely spaced (2-3 s) and small-on-large responses. "Clearly
  // visible" = what the trough-to-peak detector reports on the same phasic
  // (same peakThreshold), so SparsEDA must not miss any of those.
  const events = [
    [10, 0.3],
    [25, 0.12],
    [28, 0.1],
    [45, 0.5],
    [48, 0.25],
    [70, 0.08],
    [90, 0.25],
    [93, 0.2],
    [120, 0.06],
    [140, 0.4],
    [165, 0.1],
    [185, 0.2],
  ];
  const a = new GSRAnalyzer();
  a.parseCSV(trackCsv(events, 220));
  a.analyze({ ...GSR_CONST.GSR_DEFAULT }, 0);
  const visible = a.peaks.map((p) => p.time);
  assert.ok(visible.length >= 10, `only ${visible.length} visible`);
  a.analyze({ ...GSR_CONST.GSR_DEFAULT, useSparsEDA: true }, 0);
  const missed = visible.filter(
    (t) => !a.peaks.some((p) => Math.abs(p.time - t) <= 1.0),
  );
  assert.deepStrictEqual(
    missed,
    [],
    `SparsEDA missed visible peaks at ${missed}`,
  );
});

test('the SparsEDA solve is reused when only peak-detection sliders change', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(
    trackCsv(
      [
        [10, 0.3],
        [40, 0.2],
      ],
      80,
    ),
  );
  const orig = D.deconvolve;
  let calls = 0;
  D.deconvolve = function (...x) {
    calls++;
    return orig.apply(this, x);
  };
  try {
    const p = { ...GSR_CONST.GSR_DEFAULT, useSparsEDA: true };
    a.analyze(p, 0);
    a.analyze({ ...p, peakThreshold: 0.1, minPeakQuality: 0.2 }, 0);
    assert.strictEqual(calls, 1);
    a.analyze({ ...p, tonicWindow: 30 }, 0); // decomposition changed → re-solve
    assert.strictEqual(calls, 2);
  } finally {
    D.deconvolve = orig;
  }
});

/** Deterministic PRNG (mulberry32) and Box-Muller normal. */
function rng(seed) {
  let s = seed >>> 0;
  const u = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () =>
    Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, normal };
}

test('dropping an active atom (Givens delete) gives the same factor as a rebuild', () => {
  // No real track or fixture reaches the lasso's drop branch, so check the
  // update against a from-scratch factorisation directly.
  const { u } = rng(7);
  const factor = (cols, idx) => {
    let RI = null;
    const act = [];
    for (const j of idx) {
      RI = D._updateChol(RI, cols, act, j, 1e-12).RI;
      act.push(j);
    }
    return RI;
  };
  let worst = 0;
  for (let k = 2; k <= 14; k++) {
    for (let pos = 0; pos < k; pos++) {
      const cols = Array.from({ length: k }, () =>
        Float64Array.from({ length: 40 }, () => u() - 0.5),
      );
      const all = cols.map((_, j) => j);
      const kept = all.filter((j) => j !== pos);
      const got = D._cholDelete(factor(cols, all), pos);
      const want = factor(cols, kept);
      assert.strictEqual(got.length, want.length);
      for (let j = 0; j < want.length; j++) {
        assert.strictEqual(got[j].length, j + 1, `column ${j} length`);
        for (let i = 0; i <= j; i++)
          worst = Math.max(worst, Math.abs(got[j][i] - want[j][i]));
      }
    }
  }
  assert.ok(worst < 1e-12, `max |ΔR| ${worst}`);
});

/** CSV of phasicOf(events) on a 4 µS level, plus white noise and a footstep ripple. */
function noisyCsv(events, durSec, { sigma = 0, stepAmp = 0, seed = 11 } = {}) {
  const y = phasicOf(events, durSec);
  const { normal } = rng(seed);
  const rows = ['timestamp,Raw Conductance (uS)'];
  for (let i = 0; i < y.length; i++) {
    const t = i / FS;
    const v =
      4 + y[i] + sigma * normal() + stepAmp * Math.sin(2 * Math.PI * 1.8 * t);
    rows.push(`${t.toFixed(1)},${v.toFixed(6)}`);
  }
  return rows.join('\n');
}

const EVENTS = [
  [10, 0.3],
  [40, 0.2],
  [70, 0.25],
];
const SCF = GSR_CONST.SCRF;
const withSparse = (extra = {}) => ({
  ...GSR_CONST.GSR_DEFAULT,
  useSparsEDA: true,
  ...extra,
});

test('SparsEDA noise estimate ignores footstep ripple (measured after the gait filter)', () => {
  assert.strictEqual(GSR_CONST.GSR_DEFAULT.useGaitFilter, true);
  const quiet = new GSRAnalyzer();
  quiet.parseCSV(noisyCsv(EVENTS, 120, { sigma: 0.002 }));
  quiet.analyze(withSparse(), 0);
  const walking = new GSRAnalyzer();
  walking.parseCSV(noisyCsv(EVENTS, 120, { sigma: 0.002, stepAmp: 0.05 }));
  walking.analyze(withSparse(), 0);
  // A 1.8 Hz, 0.05 µS gait ripple is 25x the white noise; after the 1 Hz
  // gait filter it must barely register.
  assert.ok(
    walking._noiseSigma() < 1.5 * quiet._noiseSigma(),
    `walking σ̂ ${walking._noiseSigma()} vs quiet ${quiet._noiseSigma()}`,
  );
  // Same analyzer, gait filter off: the ripple is now in the input and the
  // estimate must follow (the memo must not return the gait-on value).
  walking.analyze(withSparse({ useGaitFilter: false }), 0);
  assert.ok(
    walking._noiseSigma() > 5 * quiet._noiseSigma(),
    `gait off σ̂ ${walking._noiseSigma()}`,
  );
});

test('SparsEDA epsilon rises with noise and stays within [floor, cap]', () => {
  const eps = (sigma) => {
    const a = new GSRAnalyzer();
    a.parseCSV(noisyCsv(EVENTS, 120, { sigma }));
    a.analyze(withSparse(), 0);
    return a._sparsedaEpsilon(SCF);
  };
  const clean = eps(0.0005);
  const noisy = eps(0.01);
  const extreme = eps(0.5);
  assert.ok(clean >= SCF.sparsedaEpsilon, `clean ${clean}`);
  assert.ok(noisy > clean, `noisy ${noisy} should exceed clean ${clean}`);
  assert.ok(noisy < SCF.sparsedaEpsilonCap, `noisy ${noisy} under the cap`);
  assert.strictEqual(extreme, SCF.sparsedaEpsilonCap);
});

test('strictReference: a recording that starts mid-response prunes to an all-zero clean', () => {
  // The production-only start-pad tail term must not leak into the reference
  // path, where clean has to follow the rho-pruned driver exactly.
  const y = phasicOf(
    [
      [-3, 0.4],
      [20, 0.2],
    ],
    80,
  );
  for (let i = 0; i < y.length; i++) y[i] += 4;
  const r = D.deconvolve(y, FS, {
    algorithm: 'sparseda',
    strictReference: true,
    maxIter: 40,
    epsilon: 0.01,
    dminSec: 1.25,
    rho: 2.0,
  });
  assert.ok(r.driver.every((v) => v === 0));
  assert.ok(
    r.clean.every((v) => v === 0),
    `max clean ${Math.max(...r.clean)}`,
  );
});
