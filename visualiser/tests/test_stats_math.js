/**
 * Unit tests for stats_math.js (StatsMath) — statistical math helpers used
 * by the Bio Mapping GSR analyser (percentile ranking, correlation,
 * regression, and the t-distribution p-value machinery behind them).
 *
 * Run: node --test tests/test_stats_math.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const { StatsMath } = require('../stats_math.js');

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

test('_logBeta: a<1 branch (Stirling approximation) is in the right ballpark for B(0.5,0.5)=pi', () => {
  // This code path uses an approximation, not the exact Lanczos formula, so
  // only assert it lands close to the true value ln(pi) ~= 1.1447.
  closeTo(StatsMath._logBeta(0.5, 0.5), Math.log(Math.PI), 0.05);
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
