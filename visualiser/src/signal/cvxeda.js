/**
 * cvxEDA: Convex Optimization Approach to Electrodermal Activity Processing.
 *
 * Implements the convex optimization formulation by:
 *   A. Greco, G. Valenza, A. Lanata, E. P. Scilingo, and L. Citi,
 *   "cvxEDA: a Convex Optimization Approach to Electrodermal Activity Processing,"
 *   IEEE Transactions on Biomedical Engineering, vol. 63, no. 4, pp. 797-804, 2016.
 *
 * Mathematical formulation:
 *   y = r + t + e = (M * q) + (B * l + C * d) + e
 *
 *   min_{q, d, l, p}  0.5 * ||M*q + C*d + B*l - y||_2^2 + alpha * 1^T p + 0.5 * gamma * ||l||_2^2
 *   s.t. A * q = p,  p >= 0
 *
 * Where:
 *   - A, M: Bateman ARMA filter matrices obtained via bilinear transform.
 *           p = A * q is the sparse non-negative sudomotor nerve driver.
 *           r = M * q is the smooth phasic response.
 *   - B: Cubic B-spline basis matrix for the slowly-varying tonic baseline.
 *   - C: Linear drift matrix [1, t/T].
 *   - alpha: L1 sparsity penalty on the neural driver (forces zero between events).
 *   - gamma: L2 smoothness penalty on the tonic spline coefficients.
 *
 * Solved via ADMM (Alternating Direction Method of Multipliers) with a warm-started
 * Conjugate Gradient solver for the coupled linear subproblem. Every operation is
 * O(n) with zero large matrix allocations.
 */

'use strict';

const CVXEDA = {
  /**
   * Decompose an electrodermal activity signal into tonic, phasic, and driver components.
   *
   * @param {Float64Array|number[]} yRaw       - Input EDA signal (e.g. filtered conductance in µS).
   * @param {number} sampleRate                - Sampling rate in Hz (e.g. 10).
   * @param {object} [options={}]              - Solver and model parameters:
   * @param {number} [options.tauSlow=2.0]     - Slow decay time constant (seconds).
   * @param {number} [options.tauFast=0.75]    - Fast rise time constant (seconds).
   * @param {number} [options.deltaKnotSec=10] - Equidistant knot spacing for tonic splines (seconds).
   * @param {number} [options.alpha=8e-4]      - L1 penalty on driver sparsity.
   * @param {number} [options.gamma=1e-2]      - L2 penalty on tonic spline smoothness.
   * @param {number} [options.maxIter=60]      - Number of ADMM outer iterations.
   * @param {number} [options.rho=0.1]         - ADMM augmented Lagrangian penalty parameter.
   * @param {boolean} [options.normalize=true] - Whether to z-score normalize y during optimization.
   * @returns {{
   *   phasic: Float64Array,
   *   tonic: Float64Array,
   *   driver: Float64Array,
   *   iterations: number
   * }}
   */
  decompose(yRaw, sampleRate, options = {}) {
    const n = yRaw.length;
    if (n === 0) {
      return {
        phasic: new Float64Array(0),
        tonic: new Float64Array(0),
        driver: new Float64Array(0),
        iterations: 0
      };
    }

    const cfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.CVXEDA) || {};
    const tauSlow = options.tauSlow ?? cfg.tauSlow ?? 2.0;
    const tauFast = options.tauFast ?? cfg.tauFast ?? 0.75;
    const deltaKnotSec = options.deltaKnotSec ?? cfg.deltaKnotSec ?? 10.0;
    const alpha = options.alpha ?? cfg.alpha ?? 8e-4;
    const gamma = options.gamma ?? cfg.gamma ?? 1e-2;
    const maxIter = options.maxIter ?? cfg.maxIter ?? 60;
    const rho = options.rho ?? cfg.rho ?? 0.1;
    const normalize = options.normalize !== false;

    const delta = 1.0 / sampleRate;

    // Normalization: z-score standardisation stabilizes the solver across varied skin types
    let mean = 0, std = 1;
    const y = new Float64Array(n);
    if (normalize) {
      for (let i = 0; i < n; i++) mean += yRaw[i];
      mean /= n;
      let varSum = 0;
      for (let i = 0; i < n; i++) varSum += (yRaw[i] - mean) * (yRaw[i] - mean);
      std = Math.sqrt(varSum / n);
      if (std < 1e-8) std = 1.0;
      for (let i = 0; i < n; i++) y[i] = (yRaw[i] - mean) / std;
    } else {
      for (let i = 0; i < n; i++) y[i] = yRaw[i];
    }

    // 1. Bateman ARMA model via bilinear transform
    const a1 = 1.0 / Math.min(tauFast, tauSlow);
    const a0 = 1.0 / Math.max(tauFast, tauSlow);
    const d2 = (a1 - a0) * delta * delta;
    const ar = [
      ((a1 * delta + 2.0) * (a0 * delta + 2.0)) / d2,
      (2.0 * a1 * a0 * delta * delta - 8.0) / d2,
      ((a1 * delta - 2.0) * (a0 * delta - 2.0)) / d2
    ];
    const ma = [1.0, 2.0, 1.0];

    function applyA(q, out) {
      for (let i = 0; i < n; i++) {
        let v = ar[0] * q[i];
        if (i >= 1) v += ar[1] * q[i - 1];
        if (i >= 2) v += ar[2] * q[i - 2];
        out[i] = v;
      }
      return out;
    }

    function applyAT(v, out) {
      for (let i = 0; i < n; i++) {
        let val = ar[0] * v[i];
        if (i + 1 < n) val += ar[1] * v[i + 1];
        if (i + 2 < n) val += ar[2] * v[i + 2];
        out[i] = val;
      }
      return out;
    }

    function applyM(q, out) {
      for (let i = 0; i < n; i++) {
        let v = ma[0] * q[i];
        if (i >= 1) v += ma[1] * q[i - 1];
        if (i >= 2) v += ma[2] * q[i - 2];
        out[i] = v;
      }
      return out;
    }

    function applyMT(v, out) {
      for (let i = 0; i < n; i++) {
        let val = ma[0] * v[i];
        if (i + 1 < n) val += ma[1] * v[i + 1];
        if (i + 2 < n) val += ma[2] * v[i + 2];
        out[i] = val;
      }
      return out;
    }

    // 2. Cubic B-Spline Basis B for tonic baseline
    const deltaKnotSamples = Math.max(1, Math.round(deltaKnotSec / delta));
    const knots = [];
    for (let k = 0; k < n + deltaKnotSamples / 2; k += deltaKnotSamples) knots.push(k);
    const nB = knots.length;

    const tri = [];
    for (let i = 1; i <= deltaKnotSamples; i++) tri.push(i);
    for (let i = deltaKnotSamples - 1; i >= 1; i--) tri.push(i);
    const spl = new Float64Array(tri.length * 2 - 1);
    for (let i = 0; i < tri.length; i++) {
      for (let j = 0; j < tri.length; j++) spl[i + j] += tri[i] * tri[j];
    }
    let maxSpl = 0;
    for (let i = 0; i < spl.length; i++) if (spl[i] > maxSpl) maxSpl = spl[i];
    for (let i = 0; i < spl.length; i++) spl[i] /= maxSpl;
    const halfSpl = Math.floor(spl.length / 2);

    function applyB(l, out) {
      out.fill(0);
      for (let j = 0; j < nB; j++) {
        const knot = knots[j];
        const lj = l[j];
        if (lj === 0) continue;
        for (let s = 0; s < spl.length; s++) {
          const row = knot + s - halfSpl;
          if (row >= 0 && row < n) out[row] += lj * spl[s];
        }
      }
      return out;
    }

    function applyBT(v, out) {
      out.fill(0);
      for (let j = 0; j < nB; j++) {
        const knot = knots[j];
        let acc = 0;
        for (let s = 0; s < spl.length; s++) {
          const row = knot + s - halfSpl;
          if (row >= 0 && row < n) acc += v[row] * spl[s];
        }
        out[j] = acc;
      }
      return out;
    }

    // 3. Linear drift matrix C: [1, t/T]
    function applyC(d, out) {
      const denom = Math.max(1, n - 1);
      for (let i = 0; i < n; i++) out[i] = d[0] + d[1] * (i / denom);
      return out;
    }

    function applyCT(v, out) {
      let s0 = 0, s1 = 0;
      const denom = Math.max(1, n - 1);
      for (let i = 0; i < n; i++) {
        s0 += v[i];
        s1 += v[i] * (i / denom);
      }
      out[0] = s0;
      out[1] = s1;
      return out;
    }

    // 4. ADMM state vectors
    const q = new Float64Array(n);
    const p = new Float64Array(n); // non-negative sparse driver
    const u = new Float64Array(n); // scaled dual variable for A*q = p
    const l = new Float64Array(nB); // spline weights
    const d = new Float64Array(2);  // linear drift [offset, slope]

    // Initialize linear drift from signal boundaries
    d[0] = y[0];
    d[1] = y[n - 1] - y[0];

    // Scratch buffers to avoid inner-loop allocations
    const Aq = new Float64Array(n);
    const Mq = new Float64Array(n);
    const Bl = new Float64Array(n);
    const Cd = new Float64Array(n);
    const pred = new Float64Array(n);
    const tempN = new Float64Array(n);
    const tempN2 = new Float64Array(n);
    const rhs_q = new Float64Array(n);
    const rhs_d = new Float64Array(2);
    const rhs_l = new Float64Array(nB);

    const rq_cg = new Float64Array(n);
    const rd_cg = new Float64Array(2);
    const rl_cg = new Float64Array(nB);
    const pq_cg = new Float64Array(n);
    const pd_cg = new Float64Array(2);
    const pl_cg = new Float64Array(nB);
    const Apq_cg = new Float64Array(n);
    const Apd_cg = new Float64Array(2);
    const Apl_cg = new Float64Array(nB);

    function applyG(in_q, in_d, in_l, out_q, out_d, out_l) {
      applyM(in_q, Mq);
      applyC(in_d, Cd);
      applyB(in_l, Bl);
      for (let i = 0; i < n; i++) pred[i] = Mq[i] + Cd[i] + Bl[i];

      applyMT(pred, out_q);
      applyA(in_q, tempN);
      applyAT(tempN, tempN2);
      for (let i = 0; i < n; i++) out_q[i] += rho * tempN2[i];

      applyCT(pred, out_d);
      applyBT(pred, out_l);
      for (let j = 0; j < nB; j++) out_l[j] += gamma * in_l[j];
    }

    // ADMM main loop
    let iterations = 0;
    for (let iter = 0; iter < maxIter; iter++) {
      iterations++;

      // Step 1: Update driver p via soft-thresholding and non-negative projection
      applyA(q, Aq);
      const thresh = alpha / rho;
      for (let i = 0; i < n; i++) {
        p[i] = Math.max(0, Aq[i] + u[i] - thresh);
      }

      // Step 2: Solve linear quadratic system for (q, d, l) via warm-started CG
      for (let i = 0; i < n; i++) tempN[i] = p[i] - u[i];
      applyAT(tempN, tempN2);
      applyMT(y, rhs_q);
      for (let i = 0; i < n; i++) rhs_q[i] += rho * tempN2[i];
      applyCT(y, rhs_d);
      applyBT(y, rhs_l);

      applyG(q, d, l, rq_cg, rd_cg, rl_cg);
      for (let i = 0; i < n; i++) { rq_cg[i] = rhs_q[i] - rq_cg[i]; pq_cg[i] = rq_cg[i]; }
      for (let i = 0; i < 2; i++) { rd_cg[i] = rhs_d[i] - rd_cg[i]; pd_cg[i] = rd_cg[i]; }
      for (let i = 0; i < nB; i++) { rl_cg[i] = rhs_l[i] - rl_cg[i]; pl_cg[i] = rl_cg[i]; }

      let r_dot_r = 0;
      for (let i = 0; i < n; i++) r_dot_r += rq_cg[i] * rq_cg[i];
      for (let i = 0; i < 2; i++) r_dot_r += rd_cg[i] * rd_cg[i];
      for (let i = 0; i < nB; i++) r_dot_r += rl_cg[i] * rl_cg[i];

      const maxCGIter = 10;
      for (let cgIter = 0; cgIter < maxCGIter; cgIter++) {
        if (r_dot_r < 1e-10) break;
        applyG(pq_cg, pd_cg, pl_cg, Apq_cg, Apd_cg, Apl_cg);
        let p_dot_Ap = 0;
        for (let i = 0; i < n; i++) p_dot_Ap += pq_cg[i] * Apq_cg[i];
        for (let i = 0; i < 2; i++) p_dot_Ap += pd_cg[i] * Apd_cg[i];
        for (let i = 0; i < nB; i++) p_dot_Ap += pl_cg[i] * Apl_cg[i];

        const step = r_dot_r / (p_dot_Ap + 1e-12);
        for (let i = 0; i < n; i++) { q[i] += step * pq_cg[i]; rq_cg[i] -= step * Apq_cg[i]; }
        for (let i = 0; i < 2; i++) { d[i] += step * pd_cg[i]; rd_cg[i] -= step * Apd_cg[i]; }
        for (let i = 0; i < nB; i++) { l[i] += step * pl_cg[i]; rl_cg[i] -= step * Apl_cg[i]; }

        let r_dot_r_next = 0;
        for (let i = 0; i < n; i++) r_dot_r_next += rq_cg[i] * rq_cg[i];
        for (let i = 0; i < 2; i++) r_dot_r_next += rd_cg[i] * rd_cg[i];
        for (let i = 0; i < nB; i++) r_dot_r_next += rl_cg[i] * rl_cg[i];

        const beta = r_dot_r_next / (r_dot_r + 1e-12);
        r_dot_r = r_dot_r_next;
        for (let i = 0; i < n; i++) pq_cg[i] = rq_cg[i] + beta * pq_cg[i];
        for (let i = 0; i < 2; i++) pd_cg[i] = rd_cg[i] + beta * pd_cg[i];
        for (let i = 0; i < nB; i++) pl_cg[i] = rl_cg[i] + beta * pl_cg[i];
      }

      // Step 3: Dual variable update
      applyA(q, Aq);
      for (let i = 0; i < n; i++) {
        u[i] += Aq[i] - p[i];
      }
    }

    // Reconstruct final physical signals, inverting the z-score scaling
    const phasic = new Float64Array(n);
    const tonic = new Float64Array(n);
    const driver = new Float64Array(n);

    applyM(q, phasic);
    applyB(l, Bl);
    applyC(d, Cd);

    for (let i = 0; i < n; i++) {
      phasic[i] = Math.max(0, phasic[i] * std);
      tonic[i] = (Bl[i] + Cd[i]) * std + mean;
      driver[i] = Math.max(0, p[i] * std);
    }

    return { phasic, tonic, driver, iterations };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CVXEDA;
}
if (typeof window !== 'undefined') {
  window.CVXEDA = CVXEDA;
}
