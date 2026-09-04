/**
 * Unit tests for stats_math.js (StatsMath) — statistical math helpers used
 * by the Bio Mapping GSR analyser (percentile ranking, correlation,
 * regression, and the t-distribution p-value machinery behind them).
 *
 * Run: node --test tests/test_stats_math.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const { StatsMath } = require('../src/signal/stats_math.js');

const closeTo = (actual, expected, tolerance, msg) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${msg || ''} expected ${actual} to be within ${tolerance} of ${expected}`);
};

// ---------------------------------------------------------------------------
// percentileRank
// ---------------------------------------------------------------------------

test('percentileRank: empty array returns 0.5 (documented default)', () => {
  assert.strictEqual(StatsMath.percentileRank(5, []), 0.5);
});

test('percentileRank: null/undefined array returns 0.5', () => {
  assert.strictEqual(StatsMath.percentileRank(5, null), 0.5);
  assert.strictEqual(StatsMath.percentileRank(5, undefined), 0.5);
});

test('percentileRank: singleton array returns 0.5 regardless of value', () => {
  assert.strictEqual(StatsMath.percentileRank(-999, [10]), 0.5);
  assert.strictEqual(StatsMath.percentileRank(999, [10]), 0.5);
});

test('percentileRank: value below all entries ranks 0', () => {
  assert.strictEqual(StatsMath.percentileRank(0, [1, 2, 3, 4, 5]), 0);
});

test('percentileRank: value above all entries ranks 1 (all at or below)', () => {
  assert.strictEqual(StatsMath.percentileRank(10, [1, 2, 3, 4, 5]), 1);
});

test('percentileRank: value matching an interior entry counts everything at-or-below it', () => {
  // Entries <= 3 are [1,2,3] -> 3 of 5.
  assert.strictEqual(StatsMath.percentileRank(3, [1, 2, 3, 4, 5]), 0.6);
});

test('percentileRank: value matching the first entry only counts that one', () => {
  assert.strictEqual(StatsMath.percentileRank(1, [1, 2, 3, 4, 5]), 0.2);
});

test('percentileRank: duplicate entries are all counted as "at or below"', () => {
  // Entries <= 2 are [1,2,2,2] -> 4 of 5.
  assert.strictEqual(StatsMath.percentileRank(2, [1, 2, 2, 2, 3]), 0.8);
});

// ---------------------------------------------------------------------------
// calculatePearsonCorrelation
// ---------------------------------------------------------------------------

test('calculatePearsonCorrelation: empty arrays return the neutral {r:0, p:1}', () => {
  assert.deepStrictEqual(StatsMath.calculatePearsonCorrelation([], []), { r: 0, p: 1 });
});

test('calculatePearsonCorrelation: perfect positive correlation gives r=1; p stays at the default 1 (guarded to avoid 1-r^2 divide-by-zero)', () => {
  const { r, p } = StatsMath.calculatePearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.strictEqual(r, 1);
  assert.strictEqual(p, 1);
});

test('calculatePearsonCorrelation: perfect negative correlation gives r=-1', () => {
  const { r, p } = StatsMath.calculatePearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  assert.strictEqual(r, -1);
  assert.strictEqual(p, 1);
});

test('calculatePearsonCorrelation: n=2 is always a perfect (anti)correlation by construction, p defaults to 1 (n>2 guard)', () => {
  const { r, p } = StatsMath.calculatePearsonCorrelation([1, 2], [5, 3]);
  assert.strictEqual(r, -1);
  assert.strictEqual(p, 1);
});

test('calculatePearsonCorrelation: zero variance in x (den===0) returns r=0 exactly (guarded, not NaN)', () => {
  const { r, p } = StatsMath.calculatePearsonCorrelation([5, 5, 5], [1, 2, 3]);
  assert.strictEqual(r, 0);
  // t=0 -> x=df/(df+0)=1 -> _regIncompleteBeta hits its x>=1 shortcut -> p=1.
  assert.strictEqual(p, 1);
});

test('calculatePearsonCorrelation: partial correlation matches hand-computed r, and p lands strictly inside (0,1)', () => {
  // sumX=15,sumY=15,sumXY=53,sumX2=55,sumY2=55,n=5 -> num=40, den=50 -> r=0.8
  const { r, p } = StatsMath.calculatePearsonCorrelation([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]);
  closeTo(r, 0.8, 1e-9);
  assert.ok(p > 0 && p < 1, `p should be a proper two-tailed p-value in (0,1), got ${p}`);
});

test('calculatePearsonCorrelation: p-value decreases as the correlation strengthens with more data (sanity/monotonicity check)', () => {
  const weak = StatsMath.calculatePearsonCorrelation([1, 2, 3, 4, 5, 6], [2, 1, 5, 3, 4, 6]);
  const strong = StatsMath.calculatePearsonCorrelation([1, 2, 3, 4, 5, 6], [1.1, 2.0, 3.2, 3.9, 5.1, 5.8]);
  assert.ok(Math.abs(strong.r) > Math.abs(weak.r), 'strong dataset should have larger |r|');
  assert.ok(strong.p < weak.p, 'stronger correlation should yield a smaller p-value');
});

// ---------------------------------------------------------------------------
// Autocorrelation-aware helpers (autocorrelation, lag1Autocorrelation,
// effectiveSampleSize, correlationEffectiveN, calculateAutocorrCorrelation)
// ---------------------------------------------------------------------------

test('autocorrelation: acf[0] is 1; a monotone ramp stays near 1 for many lags; alternating flips sign each lag', () => {
  const ramp = [];
  for (let i = 0; i < 200; i++) ramp.push(i);
  const acfRamp = StatsMath.autocorrelation(ramp, 10);
  assert.strictEqual(acfRamp[0], 1);
  assert.ok(acfRamp[1] > 0.95 && acfRamp[10] > 0.8, 'slow trend -> ACF decays slowly');

  const alt = [];
  for (let i = 0; i < 200; i++) alt.push(i % 2 === 0 ? 1 : -1);
  const acfAlt = StatsMath.autocorrelation(alt, 4);
  closeTo(acfAlt[1], -1, 0.05);
  closeTo(acfAlt[2], 1, 0.05);
});

test('autocorrelation: constant or near-empty series returns all zeros', () => {
  assert.deepStrictEqual(StatsMath.autocorrelation([5, 5, 5, 5], 2), [0, 0, 0]);
  assert.deepStrictEqual(StatsMath.autocorrelation([1], 3), [0, 0, 0, 0]);
});

test('lag1Autocorrelation: ~0 for i.i.d.-style alternating data, high for a slow ramp', () => {
  const alternating = [];
  for (let i = 0; i < 200; i++) alternating.push(i % 2 === 0 ? 1 : -1);
  closeTo(StatsMath.lag1Autocorrelation(alternating), -1, 0.05, 'strict alternation -> r1 ~= -1');

  const ramp = [];
  for (let i = 0; i < 200; i++) ramp.push(i);
  assert.ok(StatsMath.lag1Autocorrelation(ramp) > 0.95, 'monotone ramp -> r1 near 1');
});

test('lag1Autocorrelation: short or constant series returns 0', () => {
  assert.strictEqual(StatsMath.lag1Autocorrelation([1, 2]), 0);
  assert.strictEqual(StatsMath.lag1Autocorrelation([5, 5, 5, 5]), 0);
});

test('effectiveSampleSize: heavy positive autocorrelation shrinks N; white noise leaves it ~unchanged', () => {
  const ramp = [];
  for (let i = 0; i < 300; i++) ramp.push(i + Math.sin(i / 10));
  const nEff = StatsMath.effectiveSampleSize(ramp);
  assert.ok(nEff < 60, `strong autocorrelation should collapse 300 -> well under 60, got ${nEff}`);

  // Deterministic pseudo-white sequence (no lib RNG): low |r1|.
  const white = [];
  let s = 12345;
  for (let i = 0; i < 300; i++) { s = (1103515245 * s + 12345) & 0x7fffffff; white.push(s / 0x7fffffff); }
  const nEffWhite = StatsMath.effectiveSampleSize(white);
  assert.ok(nEffWhite > 240, `near-white noise should keep most of N=300, got ${nEffWhite}`);
});

test('correlationEffectiveN: never exceeds the raw pair count and drops with shared autocorrelation', () => {
  const a = [];
  const b = [];
  for (let i = 0; i < 400; i++) { a.push(i + Math.sin(i / 7)); b.push(i * 0.8 + Math.cos(i / 9)); }
  const nEff = StatsMath.correlationEffectiveN(a, b);
  assert.ok(nEff <= 400, 'nEff cannot exceed N');
  assert.ok(nEff < 80, `two smooth ramps share strong autocorrelation -> big reduction, got ${nEff}`);
});

test('calculateAutocorrCorrelation: same r as the plain Pearson, but a larger (more honest) p-value under autocorrelation', () => {
  // A faint linear trend buried in a smooth wave: plain Pearson over 600
  // autocorrelated points calls this "significant"; the corrected test
  // should not be so sure.
  const x = [];
  const y = [];
  for (let i = 0; i < 600; i++) {
    x.push(i);
    y.push(0.02 * i + 30 * Math.sin(i / 15));
  }
  const plain = StatsMath.calculatePearsonCorrelation(x, y);
  const corr = StatsMath.calculateAutocorrCorrelation(x, y);
  closeTo(corr.r, plain.r, 1e-12, 'point estimate r is unchanged');
  assert.ok(corr.nEff < x.length, 'effective N is below raw N');
  assert.ok(corr.p > plain.p, `corrected p (${corr.p}) should exceed the naive p (${plain.p})`);
  assert.ok(Number.isFinite(corr.p) && corr.p >= 0 && corr.p <= 1, 'corrected p is a valid probability');
});

// ---------------------------------------------------------------------------
// metaCorrelation (random-effects across independent groups / walks)
// ---------------------------------------------------------------------------

// Deterministic pseudo-random helper (no lib RNG).
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
}

test('metaCorrelation: fewer than 3 usable groups -> not tested (p = 1), r is the mean of available group rs', () => {
  const g1 = { x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], y: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };      // r = 1
  const g2 = { x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], y: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] };      // r = -1
  const res = StatsMath.metaCorrelation([g1, g2]);
  assert.strictEqual(res.k, 2);
  assert.strictEqual(res.p, 1);
  closeTo(res.r, 0, 1e-9, 'mean of +1 and -1');
});

test('metaCorrelation: groups too short, or with no variance, are skipped', () => {
  const short = { x: [1, 2, 3], y: [1, 2, 3] };
  const flatX = { x: new Array(20).fill(5), y: Array.from({ length: 20 }, (_, i) => i) };
  const ok1 = { x: Array.from({ length: 20 }, (_, i) => i), y: Array.from({ length: 20 }, (_, i) => i + (i % 3)) };
  const ok2 = { x: Array.from({ length: 20 }, (_, i) => i), y: Array.from({ length: 20 }, (_, i) => i * 0.9 - (i % 4)) };
  const ok3 = { x: Array.from({ length: 20 }, (_, i) => i), y: Array.from({ length: 20 }, (_, i) => i * 1.1 + (i % 2)) };
  const res = StatsMath.metaCorrelation([short, flatX, ok1, ok2, ok3]);
  assert.strictEqual(res.k, 3, 'only the 3 usable groups count');
});

test('metaCorrelation: a consistent per-group effect is detected; gains power as groups are added', () => {
  const R = lcg(42);
  const makeGroups = (K, beta) => {
    const out = [];
    for (let g = 0; g < K; g++) {
      const x = [], y = [];
      for (let i = 0; i < 60; i++) { const xv = R() * 10; x.push(xv); y.push(beta * xv + (R() - 0.5) * 8); }
      out.push({ x, y });
    }
    return out;
  };
  const p4 = StatsMath.metaCorrelation(makeGroups(4, 0.5)).p;
  const p12 = StatsMath.metaCorrelation(makeGroups(12, 0.5)).p;
  assert.ok(p4 < 0.05, `4 groups with a real effect should be detectable, got p=${p4}`);
  assert.ok(p12 < p4, `more groups -> smaller p (${p12} < ${p4})`);

  const pNull = StatsMath.metaCorrelation(makeGroups(12, 0)).p;
  assert.ok(pNull > 0.05, `no real effect -> not significant, got p=${pNull}`);
});

test('metaCorrelation: identical non-zero r in every group -> t is infinite -> p ~ 0', () => {
  const groups = [];
  for (let g = 0; g < 5; g++) {
    const x = Array.from({ length: 30 }, (_, i) => i);
    const y = Array.from({ length: 30 }, (_, i) => 2 * i + 1); // r = 1 exactly, same every group
    groups.push({ x, y });
  }
  const res = StatsMath.metaCorrelation(groups);
  assert.strictEqual(res.k, 5);
  assert.ok(res.p < 1e-6, `zero between-group variance in a non-zero effect -> tiny p, got ${res.p}`);
});

test('metaCorrelation: inverse-variance weighting — long walks outweigh a short uninformative one (equal-weighting would not)', () => {
  const R = lcg(5);
  const walk = (n, beta) => {
    const x = [], y = [];
    for (let i = 0; i < n; i++) { const xv = R() * 10; x.push(xv); y.push(beta * xv + (R() - 0.5) * 6); }
    return { x, y };
  };
  // Two long walks with a clear effect + one short, uninformative walk (no
  // effect, n=11). Equal-weighting (old behaviour) would average all three
  // Fisher-z's and drag the pooled r down toward ~0.47; inverse-variance
  // weighting keeps it near the two long walks' value (~0.60).
  const res = StatsMath.metaCorrelation([walk(150, 0.5), walk(150, 0.5), walk(11, 0)]);
  assert.strictEqual(res.k, 3);
  assert.ok(res.r > 0.55, `long walks dominate the short uninformative one: pooled r=${res.r.toFixed(3)}`);
});

test('metaCorrelation: operating characteristics — FPR at/below nominal, power scales with K (trimmed simulation)', () => {
  // Fuller sweep in scratchpad/meta_sim.js; recorded in the project memory.
  // Slow AR(1) predictor crossed once per walk + AR(1) noise — the real
  // single-walk regime. This trimmed run just guards against a regression to
  // false-positive inflation or a total loss of power.
  const S = lcg(918273);
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = S();
    while (v === 0) v = S();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const makeWalk = (nSec, beta) => {
    const bi = beta + 0.1 * gauss();
    const x = [], y = [];
    let xp = 0, ep = 0;
    for (let i = 0; i < nSec; i++) {
      xp = 0.98 * xp + Math.sqrt(1 - 0.98 * 0.98) * gauss();
      ep = 0.98 * ep + Math.sqrt(1 - 0.98 * 0.98) * gauss();
      x.push(xp); y.push(bi * xp + ep);
    }
    return { x, y };
  };
  const rejRate = (K, beta, iters) => {
    let rej = 0;
    for (let it = 0; it < iters; it++) {
      const g = [];
      for (let j = 0; j < K; j++) g.push(makeWalk(600, beta));
      if (StatsMath.metaCorrelation(g).p < 0.05) rej++;
    }
    return rej / iters;
  };
  const fpr = rejRate(10, 0, 150);
  assert.ok(fpr <= 0.13, `null FPR at K=10 should sit near/below nominal 0.05, got ${fpr.toFixed(3)}`);
  const power = rejRate(10, 0.5, 80);
  assert.ok(power > 0.6, `a strong consistent effect at K=10 should be detected most of the time, got ${power.toFixed(2)}`);
});

// ---------------------------------------------------------------------------
// benjaminiHochberg (FDR adjustment)
// ---------------------------------------------------------------------------

test('benjaminiHochberg: q-values are >= their raw p, monotone with rank, and clamped to <= 1', () => {
  const p = [0.001, 0.008, 0.02, 0.04, 0.9];
  const q = StatsMath.benjaminiHochberg(p);
  for (let i = 0; i < p.length; i++) {
    assert.ok(q[i] >= p[i] - 1e-12, `q[${i}]=${q[i]} should be >= p[${i}]=${p[i]}`);
    assert.ok(q[i] <= 1, 'q clamped to 1');
  }
  // Classic BH worked example: q_1 = 0.001*5/1, q_2 = 0.008*5/2, ...
  closeTo(q[0], 0.005, 1e-9);
  closeTo(q[1], 0.02, 1e-9);
});

test('benjaminiHochberg: non-finite entries pass through as NaN and do not join the ranking', () => {
  const q = StatsMath.benjaminiHochberg([0.01, NaN, 0.04]);
  assert.ok(Number.isNaN(q[1]), 'NaN in -> NaN out');
  // m = 2 (only the finite cells), so q_1 = 0.01*2/1 = 0.02, q_2 = 0.04*2/2 = 0.04
  closeTo(q[0], 0.02, 1e-9);
  closeTo(q[2], 0.04, 1e-9);
});

test('benjaminiHochberg: all-NaN family returns all NaN without throwing', () => {
  assert.deepStrictEqual(StatsMath.benjaminiHochberg([NaN, NaN]), [NaN, NaN]);
});

// ---------------------------------------------------------------------------
// welchTTest
// ---------------------------------------------------------------------------

test('welchTTest: two clearly separated samples give a small p; identical samples give p ~= 1', () => {
  const lo = Array.from({ length: 40 }, (_, i) => 1 + (i % 5) * 0.1);
  const hi = Array.from({ length: 40 }, (_, i) => 3 + (i % 5) * 0.1);
  const sep = StatsMath.welchTTest(lo, hi);
  assert.ok(sep.p < 1e-6, `well-separated means -> tiny p, got ${sep.p}`);
  closeTo(sep.meanA, 1.2, 1e-9);

  const same = StatsMath.welchTTest(lo, lo.slice());
  closeTo(same.p, 1, 1e-9);
  assert.strictEqual(same.t, 0);
});

test('welchTTest: unequal variances — df lands between the smaller (n-1) and the pooled value', () => {
  const tight = Array.from({ length: 30 }, (_, i) => 5 + (i % 3) * 0.01);
  const loose = Array.from({ length: 30 }, (_, i) => 5 + (i % 7) * 2.0);
  const { df } = StatsMath.welchTTest(tight, loose);
  assert.ok(df > 0 && df < 58, `Welch df should be well under the pooled 58, got ${df}`);
});

test('welchTTest: useEffectiveN widens the test (bigger p) when the samples are autocorrelated', () => {
  const a = [];
  const b = [];
  for (let i = 0; i < 200; i++) { a.push(Math.sin(i / 12)); b.push(0.4 + Math.sin(i / 12)); }
  const raw = StatsMath.welchTTest(a, b, false);
  const eff = StatsMath.welchTTest(a, b, true);
  assert.ok(eff.nA < a.length, 'effective N below raw N');
  assert.ok(eff.p > raw.p, `effective-N Welch should be less certain (${eff.p} > ${raw.p})`);
});

test('welchTTest: samples smaller than 2 return the neutral non-result', () => {
  const r = StatsMath.welchTTest([1], [1, 2, 3]);
  assert.strictEqual(r.p, 1);
  assert.strictEqual(r.t, 0);
});

test('welchTTest: an explicit effN overrides the internal effectiveSampleSize and is clamped to [2, rawN]', () => {
  const a = [], b = [];
  for (let i = 0; i < 300; i++) { a.push(Math.sin(i / 15)); b.push(0.5 + Math.sin(i / 15)); }
  const internal = StatsMath.welchTTest(a, b, true);                       // computes eff N over the joined series
  const supplied = StatsMath.welchTTest(a, b, true, { a: 40, b: 40 });     // caller-supplied (e.g. per-walk sum)
  assert.ok(Math.abs(supplied.nA - 40) < 1e-9 && Math.abs(supplied.nB - 40) < 1e-9, 'uses the supplied effective sizes');
  assert.notStrictEqual(supplied.p, internal.p, 'a different effective N gives a different p');
  // Clamped: can never exceed the raw count or drop below 2.
  const clampedHi = StatsMath.welchTTest(a, b, true, { a: 99999, b: 99999 });
  assert.ok(clampedHi.nA <= a.length && clampedHi.nB <= b.length, 'effN cannot exceed the raw sample size');
  const clampedLo = StatsMath.welchTTest(a, b, true, { a: 0.1, b: 0.1 });
  assert.ok(clampedLo.nA >= 2 && clampedLo.nB >= 2, 'effN floored at 2');
});

// ---------------------------------------------------------------------------
// calculateLinearRegression
// ---------------------------------------------------------------------------

test('calculateLinearRegression: empty arrays return the neutral {m:0, c:0, r2:0}', () => {
  assert.deepStrictEqual(StatsMath.calculateLinearRegression([], []), { m: 0, c: 0, r2: 0 });
});

test('calculateLinearRegression: perfect line y=2x fits exactly (m=2, c=0, r2=1)', () => {
  const { m, c, r2 } = StatsMath.calculateLinearRegression([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.strictEqual(m, 2);
  assert.strictEqual(c, 0);
  assert.strictEqual(r2, 1);
});

test('calculateLinearRegression: perfect line with an offset y=3x+1 fits exactly', () => {
  const { m, c, r2 } = StatsMath.calculateLinearRegression([0, 1, 2, 3], [1, 4, 7, 10]);
  assert.strictEqual(m, 3);
  assert.strictEqual(c, 1);
  assert.strictEqual(r2, 1);
});

test('calculateLinearRegression: flat/constant y (zero variance in y) reports slope 0 and r2=1 via the ssTot===0 special case', () => {
  const { m, c, r2 } = StatsMath.calculateLinearRegression([1, 2, 3], [5, 5, 5]);
  assert.strictEqual(m, 0);
  assert.strictEqual(c, 5);
  // Documented behaviour: when ssTot is 0 the code special-cases r2 to 1
  // (a constant fits its own mean perfectly) rather than producing 0/0=NaN.
  assert.strictEqual(r2, 1);
});

test('calculateLinearRegression: zero variance in x (denM===0, vertical scatter) reports slope 0 with r2 reflecting the mean-only fit', () => {
  const { m, c, r2 } = StatsMath.calculateLinearRegression([3, 3, 3], [1, 2, 3]);
  assert.strictEqual(m, 0);
  assert.strictEqual(c, 2);
  // pred is constant (=meanY) for every point here, so res===dev and r2=1-(ssRes/ssTot)=0.
  assert.strictEqual(r2, 0);
});

test('calculateLinearRegression: noisy data yields 0 <= r2 <= 1 and a regression line close to the generating trend', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8];
  const y = [2.1, 3.9, 6.2, 7.8, 10.1, 11.9, 14.2, 15.8]; // ~ y = 2x
  const { m, c, r2 } = StatsMath.calculateLinearRegression(x, y);
  closeTo(m, 2, 0.2);
  assert.ok(r2 >= 0 && r2 <= 1, `r2 should be in [0,1], got ${r2}`);
  assert.ok(r2 > 0.95, 'clean near-linear data should fit very well');
});

// ---------------------------------------------------------------------------
// Private helpers behind the p-value computation (_tTestPValue,
// _regIncompleteBeta, _logBeta, _logGamma). These are underscore-prefixed
// by convention but are reachable on the exported StatsMath object and are
// exercised directly here since they carry real, independently-checkable
// mathematical behaviour.
// ---------------------------------------------------------------------------

test('_logGamma: matches ln((n-1)!) for small integers', () => {
  closeTo(StatsMath._logGamma(1), 0, 1e-9); // ln(0!) = ln(1) = 0
  closeTo(StatsMath._logGamma(2), 0, 1e-9); // ln(1!) = ln(1) = 0
  closeTo(StatsMath._logGamma(5), Math.log(24), 1e-6); // ln(4!) = ln(24)
});

test('_logBeta: a,b >= 1 branch matches ln(Gamma(a)*Gamma(b)/Gamma(a+b)) for B(1,1)=1', () => {
  closeTo(StatsMath._logBeta(1, 1), 0, 1e-9); // B(1,1) = 1 -> ln(1) = 0
});

test('_logBeta: a,b >= 1 branch matches the closed-form B(2,3) = 1/12', () => {
  closeTo(StatsMath._logBeta(2, 3), Math.log(1 / 12), 1e-6);
});

test('_logBeta: B(0.5,0.5)=pi via log-gamma (single code path, no small-parameter approximation)', () => {
  closeTo(StatsMath._logBeta(0.5, 0.5), Math.log(Math.PI), 1e-6);
});

test('_logBeta: stays finite for a large first parameter (regression — the old small-parameter branch overflowed to NaN here)', () => {
  // df/2 = 1000 with b = 0.5 is exactly what _tTestPValue feeds for an
  // n ~= 2002 sample. Math.pow(1000, 999.5) is Infinity; the log-gamma
  // path must not be.
  const v = StatsMath._logBeta(1000, 0.5);
  assert.ok(Number.isFinite(v), `expected a finite log-beta, got ${v}`);
});

test('_regIncompleteBeta: x<=0 returns 0 and x>=1 returns 1 (boundary shortcuts)', () => {
  assert.strictEqual(StatsMath._regIncompleteBeta(0, 2, 2), 0);
  assert.strictEqual(StatsMath._regIncompleteBeta(-1, 2, 2), 0);
  assert.strictEqual(StatsMath._regIncompleteBeta(1, 2, 2), 1);
  assert.strictEqual(StatsMath._regIncompleteBeta(1.5, 2, 2), 1);
});

test('_regIncompleteBeta: I_x(1,1) is the identity (uniform distribution CDF), so I_0.5(1,1) ~= 0.5', () => {
  closeTo(StatsMath._regIncompleteBeta(0.5, 1, 1), 0.5, 1e-6);
  closeTo(StatsMath._regIncompleteBeta(0.25, 1, 1), 0.25, 1e-6);
});

test('_tTestPValue: t=0 always gives p=1 (no evidence against the null) regardless of degrees of freedom', () => {
  assert.strictEqual(StatsMath._tTestPValue(0, 1), 1);
  assert.strictEqual(StatsMath._tTestPValue(0, 30), 1);
});

test('_tTestPValue: a large |t| statistic gives a small p-value', () => {
  const p = StatsMath._tTestPValue(10, 20);
  assert.ok(p < 0.01, `expected a small p-value for t=10, df=20, got ${p}`);
});

test('_tTestPValue: p-value is symmetric in the sign of t (two-tailed by construction of the caller, but the raw beta-based value only depends on t^2)', () => {
  const pPos = StatsMath._tTestPValue(2.5, 10);
  const pNeg = StatsMath._tTestPValue(-2.5, 10);
  closeTo(pPos, pNeg, 1e-9);
});

test('_tTestPValue: matches reference values across a wide df range, including the large-n regime the env dashboard runs in', () => {
  // Reference values from R: 2 * pt(-abs(t), df).
  closeTo(StatsMath._tTestPValue(2.0, 10), 0.073388, 1e-4, 't=2, df=10');
  closeTo(StatsMath._tTestPValue(2.228, 10), 0.05004, 1e-4, 't=2.228, df=10');
  closeTo(StatsMath._tTestPValue(1.0, 100), 0.319724, 1e-4, 't=1, df=100');
  closeTo(StatsMath._tTestPValue(3.0, 500), 0.002827, 1e-4, 't=3, df=500 (was NaN before the log-beta fix)');
  closeTo(StatsMath._tTestPValue(2.0, 2000), 0.045637, 1e-4, 't=2, df=2000 (was NaN before the log-beta fix)');
});

test('calculatePearsonCorrelation: large autocorrelation-free sample returns a finite p-value (regression for the log-beta overflow)', () => {
  const x = [];
  const y = [];
  for (let i = 0; i < 1500; i++) {
    x.push(i);
    y.push(0.01 * i + Math.sin(i * 1.7) * 8); // faint trend under noise
  }
  const { r, p } = StatsMath.calculatePearsonCorrelation(x, y);
  assert.ok(Number.isFinite(r) && Number.isFinite(p), `r and p must be finite, got r=${r} p=${p}`);
  assert.ok(p >= 0 && p <= 1, `p must be in [0,1], got ${p}`);
});

// ---------------------------------------------------------------------------
// calculateStats
// ---------------------------------------------------------------------------

test('calculateStats: returns documented defaults on empty/null input', () => {
  assert.deepStrictEqual(StatsMath.calculateStats([]), { mean: 0, std: 1, variance: 0, min: 0, max: 0 });
  assert.deepStrictEqual(StatsMath.calculateStats(null), { mean: 0, std: 1, variance: 0, min: 0, max: 0 });
});

test('calculateStats: calculates mean, std, variance, min, max correctly', () => {
  const stats = StatsMath.calculateStats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.strictEqual(stats.mean, 5);
  assert.strictEqual(stats.variance, 4);
  assert.strictEqual(stats.std, 2);
  assert.strictEqual(stats.min, 2);
  assert.strictEqual(stats.max, 9);
});

test('calculateStats: single-value array prevents divide-by-zero by returning std=1', () => {
  const stats = StatsMath.calculateStats([10]);
  assert.strictEqual(stats.mean, 10);
  assert.strictEqual(stats.std, 1);
  assert.strictEqual(stats.variance, 0);
  assert.strictEqual(stats.min, 10);
  assert.strictEqual(stats.max, 10);
});

// ---------------------------------------------------------------------------
// partialCorrelation
// ---------------------------------------------------------------------------

test('partialCorrelation: empty/short inputs return documented default', () => {
  const res = StatsMath.partialCorrelation([], [], []);
  assert.strictEqual(res.r, 0);
  assert.strictEqual(res.p, 1);
  assert.strictEqual(res.rawR, 0);

  const resShort = StatsMath.partialCorrelation([1, 2], [3, 4], [5, 6]);
  assert.strictEqual(resShort.r, 0);
  assert.strictEqual(resShort.p, 1);
});

test('partialCorrelation: constant covariate falls back to raw correlation without error', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const y = [2, 4, 5, 8, 10, 12, 14, 16, 17, 20];
  const z = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]; // zero variance
  const res = StatsMath.partialCorrelation(x, y, z);
  const raw = StatsMath.calculateAutocorrCorrelation(x, y);
  closeTo(res.r, raw.r, 1e-6, 'partial r should match raw r when covariate has no variance');
  assert.strictEqual(res.rawR, raw.r);
});

test('partialCorrelation: spurious correlation driven entirely by covariate collapses to ~0', () => {
  // Let z be walking speed (1..100).
  // x and y are both driven by z with independent random jitter.
  const n = 120;
  const x = new Array(n);
  const y = new Array(n);
  const z = new Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = 0.5 + (i / n) * 1.5; // speed 0.5 .. 2.0 m/s
    // x and y both correlate with speed, but their residuals are independent
    x[i] = 10 * z[i] + Math.sin(i * 3.7) * 2;
    y[i] = 15 * z[i] + Math.cos(i * 5.1) * 2;
  }

  const raw = StatsMath.calculatePearsonCorrelation(x, y);
  assert.ok(raw.r > 0.85, `raw correlation between x and y should be high (got ${raw.r})`);

  const partial = StatsMath.partialCorrelation(x, y, z);
  assert.ok(Math.abs(partial.r) < 0.15,
    `partial correlation should collapse toward 0 after controlling for z (got ${partial.r})`);
  assert.ok(Number.isFinite(partial.p), 'p-value must be finite');
  assert.ok(partial.nEff > 0, 'effective N must be positive');
});

test('partialCorrelation: direct relationship independent of covariate is preserved', () => {
  const n = 100;
  const x = new Array(n);
  const y = new Array(n);
  const z = new Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = Math.sin(i * 1.1); // independent oscillating covariate
    x[i] = i;
    y[i] = 2 * i + Math.cos(i * 2.3) * 3; // strong linear link between x and y
  }

  const raw = StatsMath.calculatePearsonCorrelation(x, y);
  const partial = StatsMath.partialCorrelation(x, y, z);
  assert.ok(raw.r > 0.95, `raw correlation is strong (got ${raw.r})`);
  assert.ok(partial.r > 0.90, `partial correlation remains strong (got ${partial.r})`);
});
