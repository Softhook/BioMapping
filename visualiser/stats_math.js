/**
 * Shared statistical mathematics helper routines for the Bio Mapping GSR analyser.
 */
const StatsMath = {
  /**
   * Percentile rank of `value` within a pre-sorted (ascending) array, via binary search.
   * Returns the fraction (0..1) of entries at or below `value`. Used to map a grid value to
   * a color ratio based on where it sits in the *distribution* of the surface's values,
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

  calculatePearsonCorrelation(x, y) {
    const n = x.length;
    if (n === 0) return { r: 0, p: 1 };
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
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

  calculateLinearRegression(x, y) {
    const n = x.length;
    if (n === 0) return { m: 0, c: 0, r2: 0 };
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
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
    if (a < 1 || b < 1) {
      return Math.log(Math.pow(a, a - 0.5) * Math.pow(b, b - 0.5) /
             Math.pow(a + b, a + b - 0.5) * Math.sqrt(2 * Math.PI)) +
             (1 / 12) * (1 / a + 1 / b - 1 / (a + b));
    }
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
