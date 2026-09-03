/**
 * Shared statistical mathematics helper routines for the Bio Mapping GSR analyser.
 */
const StatsMath = {
  /**
   * Percentile rank of `value` within a pre-sorted (ascending) array, via binary search.
   * Returns the fraction (0..1) of entries at or below `value`. Used to map a grid value to
   * a colour ratio based on where it sits in the *distribution* of the surface's values,
   * rather than a linear (value - min) / (max - min) ratio which gets dominated by a long
   * flat baseline whenever a small number of values spike far above the rest.
   *
   * @param {number} value - The value to rank.
   * @param {number[]} sortedArr - Ascending-sorted array of reference values.
   * @returns {number} Rank in [0, 1]. Returns 0.5 for empty/singleton arrays.
   */
  percentileRank(value, sortedArr) {
    const n = sortedArr ? sortedArr.length : 0;
    if (n <= 1) return 0.5;
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedArr[mid] <= value) lo = mid + 1; else hi = mid;
    }
    return lo / n;
  },

  /**
   * Calculates mean and standard deviation of an array of numeric values.
   *
   * @param {number[]} values - Array of numeric values.
   * @returns {{mean: number, std: number, variance: number, min: number, max: number}}
   */
  calculateStats(values) {
    const n = values ? values.length : 0;
    if (n === 0) return { mean: 0, std: 1, variance: 0, min: 0, max: 0 };
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const mean = sum / n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const diff = values[i] - mean;
      ss += diff * diff;
    }
    const variance = ss / n;
    const std = Math.sqrt(variance);
    return { mean, std: std === 0 ? 1 : std, variance, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
  },

  _computeSums(x, y) {
    const n = x.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
    return { sumX, sumY, sumXY, sumX2, sumY2 };
  },

  calculatePearsonCorrelation(x, y) {
    const n = x.length;
    if (n === 0) return { r: 0, p: 1 };
    const { sumX, sumY, sumXY, sumX2, sumY2 } = this._computeSums(x, y);
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    const r = den === 0 ? 0 : num / den;
    // Two-tailed p-value from t-distribution: t = r * sqrt((n-2)/(1-r²))
    let p = 1;
    if (n > 2 && Math.abs(r) < 1) {
      const t = r * Math.sqrt((n - 2) / (1 - r * r));
      const df = n - 2;
      p = StatsMath._tTestPValue(t, df);
    }
    return { r, p };
  },

  /**
   * Biased lag-1 autocorrelation of a series (ACF at lag 1: the correlation
   * between each value and the next, normalised by the full sum of squares).
   * Returns 0 for series shorter than 3 or with zero variance.
   */
  lag1Autocorrelation(values) {
    const n = values ? values.length : 0;
    if (n < 3) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[i];
    const mean = sum / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const d = values[i] - mean;
      den += d * d;
      if (i < n - 1) num += d * (values[i + 1] - mean);
    }
    return den === 0 ? 0 : num / den;
  },

  /**
   * Effective sample size of a single autocorrelated series, used to widen
   * the standard error / CI of its mean. Quenouille / Bayley–Hammersley
   * lag-1 form: N_eff = N (1 - r1) / (1 + r1). Positive autocorrelation
   * (the usual case for a slow physiological signal sampled fast) shrinks
   * N_eff; negative or zero autocorrelation leaves it untouched.
   */
  effectiveSampleSize(values) {
    const n = values ? values.length : 0;
    if (n < 4) return n;
    const r1 = this.lag1Autocorrelation(values);
    if (!(r1 > 0)) return n;
    const ratio = (1 - r1) / (1 + r1);
    return Math.max(2, Math.min(n, n * ratio));
  },

  /**
   * Effective pair count for a correlation between two autocorrelated
   * series (Pyper & Peterman 1998, truncated at lag 1):
   *   N_eff = N (1 - r1x r1y) / (1 + r1x r1y)
   * This is what the significance test of r should use — r itself is
   * computed from all N points, but its sampling variance is governed by
   * the far smaller number of *independent* observations.
   */
  correlationEffectiveN(x, y) {
    const n = Math.min(x ? x.length : 0, y ? y.length : 0);
    if (n < 4) return n;
    const prod = this.lag1Autocorrelation(x) * this.lag1Autocorrelation(y);
    if (prod <= -1 || !isFinite(prod)) return n;
    const ratio = (1 - prod) / (1 + prod);
    return Math.max(2, Math.min(n, n * ratio));
  },

  /**
   * Pearson r with a p-value corrected for serial autocorrelation in either
   * series via the lag-1 effective sample size (see correlationEffectiveN).
   * The point estimate r is unchanged. Returns { r, p, n, nEff }.
   */
  calculateAutocorrCorrelation(x, y) {
    const n = Math.min(x ? x.length : 0, y ? y.length : 0);
    const { r } = this.calculatePearsonCorrelation(x, y);
    const nEff = this.correlationEffectiveN(x, y);
    let p = 1;
    if (nEff > 3 && Math.abs(r) < 1) {
      const df = nEff - 2;
      const t = r * Math.sqrt(df / (1 - r * r));
      p = StatsMath._tTestPValue(t, df);
    }
    return { r, p, n, nEff };
  },

  /**
   * Benjamini–Hochberg false-discovery-rate adjustment. Returns q-values in
   * the input order; non-finite inputs pass through as NaN and are excluded
   * from the ranking (so a family with some untestable cells still adjusts
   * correctly over the cells that were tested).
   */
  benjaminiHochberg(pValues) {
    const q = new Array(pValues.length).fill(NaN);
    const idx = [];
    for (let i = 0; i < pValues.length; i++) {
      if (typeof pValues[i] === 'number' && isFinite(pValues[i])) idx.push(i);
    }
    const m = idx.length;
    if (m === 0) return q;
    idx.sort((a, b) => pValues[a] - pValues[b]);
    let running = 1;
    for (let k = m - 1; k >= 0; k--) {
      const i = idx[k];
      running = Math.min(running, (pValues[i] * m) / (k + 1));
      q[i] = Math.min(1, running);
    }
    return q;
  },

  /**
   * Welch's unequal-variance two-sample t-test. With useEffectiveN the per
   * group counts are replaced by their autocorrelation-adjusted effective
   * sizes (effectiveSampleSize) so a comparison of two stretches of a fast
   * physiological signal is not massively over-powered.
   * Returns { t, df, p, meanA, meanB, nA, nB }.
   */
  welchTTest(sampleA, sampleB, useEffectiveN = false) {
    const rawA = sampleA ? sampleA.length : 0;
    const rawB = sampleB ? sampleB.length : 0;
    if (rawA < 2 || rawB < 2) {
      return { t: 0, df: 0, p: 1, meanA: NaN, meanB: NaN, nA: rawA, nB: rawB };
    }
    const meanOf = (arr) => {
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += arr[i];
      return s / arr.length;
    };
    const sampleVarOf = (arr, m) => {
      let s = 0;
      for (let i = 0; i < arr.length; i++) { const d = arr[i] - m; s += d * d; }
      return s / (arr.length - 1);
    };
    const mA = meanOf(sampleA), mB = meanOf(sampleB);
    const vA = sampleVarOf(sampleA, mA), vB = sampleVarOf(sampleB, mB);
    const nA = useEffectiveN ? this.effectiveSampleSize(sampleA) : rawA;
    const nB = useEffectiveN ? this.effectiveSampleSize(sampleB) : rawB;
    const seA = vA / nA, seB = vB / nB;
    const se = Math.sqrt(seA + seB);
    if (!(se > 0)) return { t: 0, df: nA + nB - 2, p: 1, meanA: mA, meanB: mB, nA, nB };
    const t = (mA - mB) / se;
    const df = (seA + seB) ** 2 / ((seA ** 2) / (nA - 1) + (seB ** 2) / (nB - 1));
    const p = StatsMath._tTestPValue(t, df);
    return { t, df, p, meanA: mA, meanB: mB, nA, nB };
  },

  calculateLinearRegression(x, y) {
    const n = x.length;
    if (n === 0) return { m: 0, c: 0, r2: 0 };
    const { sumX, sumY, sumXY, sumX2, sumY2 } = this._computeSums(x, y);
    const meanX = sumX / n;
    const meanY = sumY / n;
    
    const numM = n * sumXY - sumX * sumY;
    const denM = n * sumX2 - sumX * sumX;
    const m = denM === 0 ? 0 : numM / denM;
    const c = meanY - m * meanX;
    
    let ssTot = 0;
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const pred = m * x[i] + c;
      const dev = y[i] - meanY;
      const res = y[i] - pred;
      ssTot += dev * dev;
      ssRes += res * res;
    }
    const r2 = ssTot === 0 ? 1 : 1 - (ssRes / ssTot);
    
    return { m, c, r2 };
  },

  _tTestPValue(t, df) {
    const x = df / (df + t * t);
    const a = df / 2;
    const b = 0.5;
    let betaReg = StatsMath._regIncompleteBeta(x, a, b);
    return betaReg;
  },

  _regIncompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const maxIter = 200;
    const eps = 1e-12;
    const front = Math.exp(
      a * Math.log(x) + b * Math.log(1 - x) -
      Math.log(a) - StatsMath._logBeta(a, b)
    );
    let f = 1;
    let c = 1;
    let d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < eps) d = eps;
    d = 1 / d;
    f = d;
    for (let m = 1; m <= maxIter; m++) {
      const m2 = 2 * m;
      let d1 = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
      d = 1 + d1 * d;
      if (Math.abs(d) < eps) d = eps;
      c = 1 + d1 / c;
      if (Math.abs(c) < eps) c = eps;
      d = 1 / d;
      f *= d * c;
      d1 = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
      d = 1 + d1 * d;
      if (Math.abs(d) < eps) d = eps;
      c = 1 + d1 / c;
      if (Math.abs(c) < eps) c = eps;
      d = 1 / d;
      const del = d * c;
      f *= del;
      if (Math.abs(del - 1) < eps) break;
    }
    return front * f;
  },

  _logBeta(a, b) {
    // Always via log-gamma. An earlier small-parameter (a<1||b<1) branch
    // computed the gamma ratio in linear space; with b fixed at 0.5 that
    // branch was always taken, and for the large `a` the environmental
    // dashboard produces (a = df/2, df = n-2, n in the hundreds/thousands)
    // Math.pow(a, a-0.5) overflows to Infinity, so every p-value came back
    // NaN. _logGamma (Lanczos) stays finite for all a, b > 0.
    return StatsMath._logGamma(a) + StatsMath._logGamma(b) - StatsMath._logGamma(a + b);
  },

  _logGamma(z) {
    const x = z;
    let sum = 1.000000000190015;
    const coeffs = [
      76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 1.208650973866179e-3, -5.395239384953e-6
    ];
    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    for (let i = 0; i < 6; i++) {
      sum += coeffs[i] / ++y;
    }
    return -tmp + Math.log(2.5066282746310005 * sum / x);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StatsMath };
}
if (typeof window !== 'undefined') {
  window.StatsMath = StatsMath;
}
