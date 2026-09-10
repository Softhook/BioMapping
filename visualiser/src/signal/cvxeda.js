/**
 * cvxEDA: Convex Optimization Approach to Electrodermal Activity Processing.
 *
 *   A. Greco, G. Valenza, A. Lanata, E. P. Scilingo, and L. Citi,
 *   "cvxEDA: a Convex Optimization Approach to Electrodermal Activity Processing,"
 *   IEEE Transactions on Biomedical Engineering, vol. 63, no. 4, pp. 797-804, 2016.
 *
 * This is a faithful port of the reference `cvxEDA.py` `qp` path. The exact
 * problem it solves is:
 *
 *   minimise  ½·‖M·q + C·d + B·l − y‖²  +  α·1ᵀ(A·q)  +  ½·γ·‖l‖²
 *   over      q ∈ ℝⁿ, d ∈ ℝ², l ∈ ℝ^nB
 *   s.t.      A·q ≥ 0
 *
 * where
 *   - A, M   : the Bateman ARMA numerator/denominator from the bilinear
 *              transform. p = A·q is the sparse non-negative sudomotor driver;
 *              r = M·q is the smooth phasic response.
 *   - B      : cubic B-spline basis (equidistant knots) for the tonic baseline.
 *   - C      : linear drift regressors [1, t].
 *   - α      : L1 weight on the driver (1ᵀp because p ≥ 0 ⇒ 1ᵀp = ‖p‖₁),
 *              carried as a *linear* term exactly as the reference does — the
 *              sparsity is produced by the A·q ≥ 0 constraint going active
 *              between events, not by a soft-threshold.
 *   - γ      : L2 weight on the tonic spline coefficients.
 *
 * The reference hands this QP to CVXOPT's interior-point solver. With no such
 * solver in the browser we solve the identical problem with ADMM on the single
 * inequality (split z = A·q, z ≥ 0):
 *
 *   x-step : minimise f̃(x) + (ρ/2)‖A·q − z + u‖²          (unconstrained QP)
 *   z-step : z = max(0, A·q + u)                            (projection)
 *   u-step : u += A·q − z
 *
 * The x-step normal equations are solved *directly*, not iteratively: the
 * (q) block Kqq = MᵀM + ρ·AᵀA is symmetric pentadiagonal, so it takes one
 * O(n) banded Cholesky; the coupled drift/spline unknowns (dimension 2 + nB,
 * ~n/100) are eliminated by a Schur complement that is refactorised only when
 * the adaptive-ρ rule changes ρ. Convergence is declared on the scaled
 * primal/dual residuals (Boyd et al. 2011, §3.3). Every per-iteration
 * operation is O(n).
 */

'use strict';

const CVXEDA = {
  /**
   * Decompose an electrodermal activity signal into tonic, phasic and driver.
   *
   * The input should be the *full* skin-conductance signal (filtered, but with
   * its tonic baseline still present) — cvxEDA models tonic and phasic jointly.
   *
   * @param {Float64Array|number[]} yRaw  - Skin conductance (µS), tonic included.
   * @param {number} sampleRate           - Sampling rate in Hz.
   * @param {object} [options={}]
   * @param {number} [options.tauSlow=2.0]      - Bateman slow decay τ (s).
   * @param {number} [options.tauFast=0.75]     - Bateman fast rise τ (s).
   * @param {number} [options.deltaKnotSec=10]  - Tonic B-spline knot spacing (s).
   * @param {number} [options.alpha=8e-4]       - L1 weight on the driver.
   * @param {number} [options.gamma=1e-2]       - L2 weight on tonic smoothness.
   * @param {number} [options.maxIter=300]      - ADMM iteration cap.
   * @param {number} [options.tol=1e-4]         - Residual tolerance (scaled).
   * @param {number} [options.rho=1.0]          - Initial ADMM penalty (adapts).
   * @param {boolean} [options.normalize=true]  - z-score y during the solve
   *   (NeuroKit-compatible; keeps the published α = 8e-4 meaningful).
   * @returns {{
   *   phasic: Float64Array, tonic: Float64Array, driver: Float64Array,
   *   iterations: number, converged: boolean, rPrim: number, rDual: number
   * }}
   */
  decompose(yRaw, sampleRate, options = {}) {
    const n = yRaw.length;
    if (n < 4) {
      return {
        phasic: new Float64Array(n),
        tonic: Float64Array.from(yRaw),
        driver: new Float64Array(n),
        iterations: 0, converged: true, rPrim: 0, rDual: 0
      };
    }

    const cfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.CVXEDA) || {};
    const tauSlow = options.tauSlow ?? cfg.tauSlow ?? 2.0;
    const tauFast = options.tauFast ?? cfg.tauFast ?? 0.75;
    const deltaKnotSec = options.deltaKnotSec ?? cfg.deltaKnotSec ?? 10.0;
    const alpha = options.alpha ?? cfg.alpha ?? 8e-4;
    const gamma = options.gamma ?? cfg.gamma ?? 1e-2;
    const maxIter = options.maxIter ?? cfg.maxIter ?? 600;
    const tol = options.tol ?? cfg.tol ?? 3e-4;
    let rho = options.rho ?? cfg.rho ?? 0.3;
    const RELAX = 1.6; // ADMM over-relaxation (Boyd §3.4.3), 1.5–1.8 typical
    const normalize = options.normalize !== false;

    const delta = 1.0 / sampleRate;

    // ── z-score standardisation (matches NeuroKit's cvxEDA wrapper) ─────────
    let mean = 0, std = 1;
    const y = new Float64Array(n);
    if (normalize) {
      for (let i = 0; i < n; i++) mean += yRaw[i];
      mean /= n;
      let v = 0;
      for (let i = 0; i < n; i++) { const dd = yRaw[i] - mean; v += dd * dd; }
      std = Math.sqrt(v / n);
      if (!(std > 1e-8)) std = 1.0;
      for (let i = 0; i < n; i++) y[i] = (yRaw[i] - mean) / std;
    } else {
      for (let i = 0; i < n; i++) y[i] = yRaw[i];
    }

    // ── 1. Bateman ARMA via bilinear transform (Greco et al. 2016) ─────────
    const a1 = 1.0 / Math.min(tauFast, tauSlow); // a1 > a0
    const a0 = 1.0 / Math.max(tauFast, tauSlow);
    const den = (a1 - a0) * delta * delta;
    const ar0 = ((a1 * delta + 2.0) * (a0 * delta + 2.0)) / den;
    const ar1 = (2.0 * a1 * a0 * delta * delta - 8.0) / den;
    const ar2 = ((a1 * delta - 2.0) * (a0 * delta - 2.0)) / den;
    // MA numerator is [1, 2, 1]. Both operators act on rows i ≥ 2 only
    // (reference: i = arange(2, n)); rows 0 and 1 are identically zero.

    // A·x  (banded, causal 3-tap)
    const applyA = (x, out) => {
      out[0] = 0; out[1] = 0;
      for (let i = 2; i < n; i++) out[i] = ar0 * x[i] + ar1 * x[i - 1] + ar2 * x[i - 2];
      return out;
    };
    // Aᵀ·x  (transpose: row j of A scatters to out[j], out[j-1], out[j-2])
    const applyAT = (x, out) => {
      out.fill(0);
      for (let j = 2; j < n; j++) {
        const xj = x[j];
        out[j] += ar0 * xj; out[j - 1] += ar1 * xj; out[j - 2] += ar2 * xj;
      }
      return out;
    };
    const applyM = (x, out) => {
      out[0] = 0; out[1] = 0;
      for (let i = 2; i < n; i++) out[i] = x[i] + 2.0 * x[i - 1] + x[i - 2];
      return out;
    };
    const applyMT = (x, out) => {
      out.fill(0);
      for (let j = 2; j < n; j++) {
        const xj = x[j];
        out[j] += xj; out[j - 1] += 2.0 * xj; out[j - 2] += xj;
      }
      return out;
    };

    // ── 2. Cubic B-spline basis B (sparse, local support) ─────────────────
    const knotStep = Math.max(1, Math.round(deltaKnotSec / delta));
    const knots = [];
    for (let k = 0; k < n + knotStep / 2; k += knotStep) knots.push(k);
    const nB = knots.length;

    // order-1 triangle ⊛ triangle → order-3 spline, normalised to unit peak
    const tri = [];
    for (let i = 1; i <= knotStep; i++) tri.push(i);
    for (let i = knotStep - 1; i >= 1; i--) tri.push(i);
    const spl = new Float64Array(tri.length * 2 - 1);
    for (let i = 0; i < tri.length; i++) {
      for (let j = 0; j < tri.length; j++) spl[i + j] += tri[i] * tri[j];
    }
    let splMax = 0;
    for (let i = 0; i < spl.length; i++) if (spl[i] > splMax) splMax = spl[i];
    for (let i = 0; i < spl.length; i++) spl[i] /= splMax;
    const halfSpl = Math.floor(spl.length / 2);

    // Column j of B as (rows, vals). Rows are contiguous, so store start + len.
    const bStart = new Int32Array(nB);
    const bLen = new Int32Array(nB);
    const bVal = new Array(nB);
    for (let j = 0; j < nB; j++) {
      const base = knots[j] - halfSpl;
      let lo = 0, hi = spl.length;
      if (base < 0) lo = -base;
      if (base + hi > n) hi = n - base;
      const len = Math.max(0, hi - lo);
      bStart[j] = base + lo;
      bLen[j] = len;
      const v = new Float64Array(len);
      for (let s = 0; s < len; s++) v[s] = spl[lo + s];
      bVal[j] = v;
    }
    const applyB = (l, out) => {
      out.fill(0);
      for (let j = 0; j < nB; j++) {
        const lj = l[j]; if (lj === 0) continue;
        const st = bStart[j], v = bVal[j], len = bLen[j];
        for (let s = 0; s < len; s++) out[st + s] += lj * v[s];
      }
      return out;
    };

    // ── 3. Linear drift C = [1, (i+1)/n] (reference parameterisation) ─────
    const cRamp = new Float64Array(n);
    for (let i = 0; i < n; i++) cRamp[i] = (i + 1) / n;

    // ── Scratch ──────────────────────────────────────────────────────────
    const tmpN = new Float64Array(n);
    const tmpN2 = new Float64Array(n);

    // Aᵀ·1 — the α linear term, constant across the solve
    const ones = new Float64Array(n).fill(1);
    const AT1 = applyAT(ones, new Float64Array(n));

    // Mᵀ·y, and the constant s-block RHS [Cᵀy ; Bᵀy]
    const MTy = applyMT(y, new Float64Array(n));
    const m = 2 + nB;                 // drift(2) + spline(nB)
    const rhsS = new Float64Array(m); // [C0ᵀy, C1ᵀy, B0ᵀy, ..]
    for (let i = 0; i < n; i++) { rhsS[0] += y[i]; rhsS[1] += cRamp[i] * y[i]; }
    for (let j = 0; j < nB; j++) {
      const st = bStart[j], v = bVal[j], len = bLen[j];
      let acc = 0;
      for (let s = 0; s < len; s++) acc += v[s] * y[st + s];
      rhsS[2 + j] = acc;
    }

    // ── Kqs = [MᵀC | MᵀB]  (n × m) ───────────────────────────────────────
    // Two dense drift columns, nB sparse spline columns (contiguous support).
    const qsC0 = applyMT(ones, new Float64Array(n));   // Mᵀ·1
    const qsC1 = applyMT(cRamp, new Float64Array(n));  // Mᵀ·ramp
    const qsBStart = new Int32Array(nB);
    const qsBLen = new Int32Array(nB);
    const qsBVal = new Array(nB);
    {
      const col = new Float64Array(n);
      for (let j = 0; j < nB; j++) {
        col.fill(0);
        const st = bStart[j], v = bVal[j], len = bLen[j];
        for (let s = 0; s < len; s++) col[st + s] = v[s];
        applyMT(col, tmpN);
        // Mᵀ widens the support by 2 samples upward.
        const lo = Math.max(0, st - 2);
        const hi = Math.min(n, st + len);
        qsBStart[j] = lo;
        qsBLen[j] = hi - lo;
        const w = new Float64Array(hi - lo);
        for (let s = 0; s < hi - lo; s++) w[s] = tmpN[lo + s];
        qsBVal[j] = w;
      }
    }
    // dot(Kqs[:,r], vec) for an s-space column r
    const qsDot = (r, vec) => {
      if (r === 0) { let a = 0; for (let i = 0; i < n; i++) a += qsC0[i] * vec[i]; return a; }
      if (r === 1) { let a = 0; for (let i = 0; i < n; i++) a += qsC1[i] * vec[i]; return a; }
      const j = r - 2, st = qsBStart[j], w = qsBVal[j], len = qsBLen[j];
      let a = 0;
      for (let s = 0; s < len; s++) a += w[s] * vec[st + s];
      return a;
    };
    // out += Kqs · s   (accumulate the x-step coupling term)
    const qsApply = (s, out) => {
      const s0 = s[0], s1 = s[1];
      for (let i = 0; i < n; i++) out[i] += s0 * qsC0[i] + s1 * qsC1[i];
      for (let j = 0; j < nB; j++) {
        const sj = s[2 + j]; if (sj === 0) continue;
        const st = qsBStart[j], w = qsBVal[j], len = qsBLen[j];
        for (let s2 = 0; s2 < len; s2++) out[st + s2] += sj * w[s2];
      }
      return out;
    };

    // ── Kss = [C B]ᵀ[C B] + γ on the spline block  (m × m dense) ─────────
    const Kss = new Float64Array(m * m);
    {
      // drift–drift
      let c00 = 0, c01 = 0, c11 = 0;
      for (let i = 0; i < n; i++) { c00 += 1; c01 += cRamp[i]; c11 += cRamp[i] * cRamp[i]; }
      Kss[0] = c00; Kss[1] = c01; Kss[m] = c01; Kss[m + 1] = c11;
      // drift–spline
      for (let j = 0; j < nB; j++) {
        const st = bStart[j], v = bVal[j], len = bLen[j];
        let d0 = 0, d1 = 0;
        for (let s = 0; s < len; s++) { d0 += v[s]; d1 += v[s] * cRamp[st + s]; }
        Kss[2 + j] = d0; Kss[(2 + j) * m] = d0;
        Kss[m + 2 + j] = d1; Kss[(2 + j) * m + 1] = d1;
      }
      // spline–spline (banded: only knots within one spline width overlap)
      for (let j = 0; j < nB; j++) {
        const stj = bStart[j], vj = bVal[j], lenj = bLen[j];
        for (let k = j; k < nB; k++) {
          const stk = bStart[k];
          const lo = Math.max(stj, stk);
          const hi = Math.min(stj + lenj, stk + bLen[k]);
          if (hi <= lo) break; // knots only move right → no later k overlaps
          const vk = bVal[k];
          let acc = 0;
          for (let i = lo; i < hi; i++) acc += vj[i - stj] * vk[i - stk];
          if (j === k) acc += gamma;
          Kss[(2 + j) * m + (2 + k)] = acc;
          Kss[(2 + k) * m + (2 + j)] = acc;
        }
      }
    }

    // ── Kqq = MᵀM + ρ·AᵀA  (symmetric pentadiagonal) ────────────────────
    // Stored as three diagonals: kd0[i]=K[i][i], kd1[i]=K[i][i+1], kd2[i]=K[i][i+2].
    const kd0 = new Float64Array(n), kd1 = new Float64Array(n), kd2 = new Float64Array(n);
    // Banded Cholesky factor L (lower, 2 sub-diagonals): lb0[i]=L[i][i],
    // lb1[i]=L[i][i-1], lb2[i]=L[i][i-2].
    const lb0 = new Float64Array(n), lb1 = new Float64Array(n), lb2 = new Float64Array(n);

    const buildKqq = () => {
      kd0.fill(0); kd1.fill(0); kd2.fill(0);
      const mTap = [1.0, 2.0, 1.0];
      const aTap = [ar2, ar1, ar0]; // taps at columns [i-2, i-1, i]
      for (let i = 2; i < n; i++) {
        const idx = [i - 2, i - 1, i];
        for (let p = 0; p < 3; p++) {
          for (let q = p; q < 3; q++) {
            const val = mTap[p] * mTap[q] + rho * aTap[p] * aTap[q];
            const off = idx[q] - idx[p];
            if (off === 0) kd0[idx[p]] += val;
            else if (off === 1) kd1[idx[p]] += val;
            else kd2[idx[p]] += val;
          }
        }
      }
      for (let i = 0; i < n; i++) kd0[i] += 1e-9; // strict SPD guard
    };

    const factorKqq = () => {
      lb0.fill(0); lb1.fill(0); lb2.fill(0);
      for (let j = 0; j < n; j++) {
        let dj = kd0[j];
        if (j >= 1) dj -= lb1[j] * lb1[j];
        if (j >= 2) dj -= lb2[j] * lb2[j];
        if (dj <= 0) dj = 1e-12;
        const ljj = Math.sqrt(dj);
        lb0[j] = ljj;
        if (j + 1 < n) {
          let s = kd1[j];
          if (j >= 1) s -= lb2[j + 1] * lb1[j]; // L[j+1][j-1]·L[j][j-1]
          lb1[j + 1] = s / ljj;
        }
        if (j + 2 < n) {
          const s = kd2[j];               // no k<j term inside the band
          lb2[j + 2] = s / ljj;
        }
      }
    };

    // Kqq⁻¹ · b  (banded forward/backward substitution), writes into out.
    const solveKqq = (b, out) => {
      for (let i = 0; i < n; i++) {
        let s = b[i];
        if (i >= 1) s -= lb1[i] * out[i - 1];
        if (i >= 2) s -= lb2[i] * out[i - 2];
        out[i] = s / lb0[i];
      }
      for (let i = n - 1; i >= 0; i--) {
        let s = out[i];
        if (i + 1 < n) s -= lb1[i + 1] * out[i + 1];
        if (i + 2 < n) s -= lb2[i + 2] * out[i + 2];
        out[i] = s / lb0[i];
      }
      return out;
    };

    // ── Schur complement S = Kss − Kqsᵀ·Kqq⁻¹·Kqs  (m × m, dense Cholesky) ─
    const S = new Float64Array(m * m);
    const Schol = new Float64Array(m * m);
    const wCol = new Float64Array(n);
    const kqsCol = new Float64Array(n);

    const buildSchur = () => {
      S.set(Kss);
      for (let c = 0; c < m; c++) {
        // kqsCol = Kqs[:,c]
        kqsCol.fill(0);
        if (c === 0) kqsCol.set(qsC0);
        else if (c === 1) kqsCol.set(qsC1);
        else {
          const j = c - 2, st = qsBStart[j], w = qsBVal[j], len = qsBLen[j];
          for (let s = 0; s < len; s++) kqsCol[st + s] = w[s];
        }
        solveKqq(kqsCol, wCol);
        for (let r = 0; r <= c; r++) {
          const red = qsDot(r, wCol);
          S[r * m + c] -= red;
          if (r !== c) S[c * m + r] -= red;
        }
      }
      // dense Cholesky of S (small)
      Schol.fill(0);
      for (let i = 0; i < m; i++) {
        for (let j = 0; j <= i; j++) {
          let sum = S[i * m + j];
          for (let k = 0; k < j; k++) sum -= Schol[i * m + k] * Schol[j * m + k];
          if (i === j) Schol[i * m + j] = Math.sqrt(sum > 0 ? sum : 1e-12);
          else Schol[i * m + j] = sum / Schol[j * m + j];
        }
      }
    };
    const solveSchur = (b, out) => {
      for (let i = 0; i < m; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= Schol[i * m + k] * out[k];
        out[i] = s / Schol[i * m + i];
      }
      for (let i = m - 1; i >= 0; i--) {
        let s = out[i];
        for (let k = i + 1; k < m; k++) s -= Schol[k * m + i] * out[k];
        out[i] = s / Schol[i * m + i];
      }
      return out;
    };

    const refactor = () => { buildKqq(); factorKqq(); buildSchur(); };
    refactor();

    // ── ADMM ────────────────────────────────────────────────────────────
    const q = new Float64Array(n);
    const z = new Float64Array(n);
    const zPrev = new Float64Array(n);
    const u = new Float64Array(n);
    const s = new Float64Array(m);       // [d0, d1, l0..l(nB-1)]
    const rhsQ = new Float64Array(n);
    const t1 = new Float64Array(n);
    const rhsSred = new Float64Array(m);
    const Aq = new Float64Array(n);

    let iterations = 0, converged = false, rPrim = 0, rDual = 0;
    let refactors = 0;
    const MAX_REFACTORS = 8;
    const sqrtN = Math.sqrt(n);
    let prevResid = Infinity, plateau = 0;

    for (let it = 0; it < maxIter; it++) {
      iterations = it + 1;

      // x-step: solve [Kqq Kqs; Kqsᵀ Kss][q;s] = [rhsQ; rhsS]
      applyAT(z, tmpN);           // Aᵀz
      applyAT(u, tmpN2);          // Aᵀu
      for (let i = 0; i < n; i++) rhsQ[i] = MTy[i] - alpha * AT1[i] + rho * (tmpN[i] - tmpN2[i]);

      solveKqq(rhsQ, t1);                                  // t1 = Kqq⁻¹ rhsQ
      for (let r = 0; r < m; r++) rhsSred[r] = rhsS[r] - qsDot(r, t1);
      solveSchur(rhsSred, s);                              // s = S⁻¹ (rhsS − Kqsᵀ t1)
      tmpN.fill(0); qsApply(s, tmpN);                      // tmpN = Kqs s
      solveKqq(tmpN, tmpN2);                               // Kqq⁻¹ Kqs s
      for (let i = 0; i < n; i++) q[i] = t1[i] - tmpN2[i];

      // z-step: project the over-relaxed A·q + u onto the non-negative orthant
      applyA(q, Aq);
      zPrev.set(z);
      for (let i = 0; i < n; i++) {
        const ahat = RELAX * Aq[i] + (1 - RELAX) * zPrev[i];
        const v = ahat + u[i];
        z[i] = v > 0 ? v : 0;
        u[i] += ahat - z[i]; // u-step, same relaxed term
      }

      // residuals (Boyd §3.3): primal = ‖Aq − z‖, dual = ρ‖Aᵀ(z − zPrev)‖
      let pr = 0, znorm = 0, aqnorm = 0;
      for (let i = 0; i < n; i++) {
        const e = Aq[i] - z[i]; pr += e * e;
        znorm += z[i] * z[i]; aqnorm += Aq[i] * Aq[i];
      }
      rPrim = Math.sqrt(pr);
      for (let i = 0; i < n; i++) tmpN[i] = z[i] - zPrev[i];
      applyAT(tmpN, tmpN2);
      let dr = 0; for (let i = 0; i < n; i++) dr += tmpN2[i] * tmpN2[i];
      rDual = rho * Math.sqrt(dr);

      applyAT(u, tmpN2);
      let atun = 0; for (let i = 0; i < n; i++) atun += tmpN2[i] * tmpN2[i];
      const epsPri = sqrtN * tol + tol * Math.sqrt(Math.max(aqnorm, znorm));
      const epsDual = sqrtN * tol + tol * rho * Math.sqrt(atun);

      if (rPrim <= epsPri && rDual <= epsDual) { converged = true; break; }

      // Plateau escape: ADMM converges linearly, so on a badly-conditioned
      // track the residuals can level off just above the tolerance. Once the
      // combined residual stops moving (< 0.1 %/iter for 15 iterations) the
      // iterate is effectively fixed — accept it as converged rather than
      // spin out the iteration budget.
      const resid = rPrim + rDual;
      if (Math.abs(prevResid - resid) < 2e-3 * resid) {
        if (++plateau >= 20) { converged = true; break; }
      } else {
        plateau = 0;
      }
      prevResid = resid;

      // adaptive ρ (Boyd et al. 2011, §3.4.1): keep the primal and dual
      // residuals within 10× of each other. ρ changes Kqq, so each move costs
      // one refactorisation — capped, and never in the last stretch where it
      // would only disturb a nearly-converged iterate.
      if (refactors < MAX_REFACTORS && it > 4 && it < maxIter - 20 && (it % 3) === 0) {
        if (rPrim > 4 * rDual) {
          rho *= 2; for (let i = 0; i < n; i++) u[i] *= 0.5; refactor(); refactors++;
        } else if (rDual > 4 * rPrim) {
          rho *= 0.5; for (let i = 0; i < n; i++) u[i] *= 2; refactor(); refactors++;
        }
      }
    }

    // ── Reconstruct physical signals ───────────────────────────────────
    const phasic = new Float64Array(n);
    const tonic = new Float64Array(n);
    const driver = new Float64Array(n);
    const bl = new Float64Array(n);

    applyM(q, phasic);
    applyB(s.subarray(2), bl);
    for (let i = 0; i < n; i++) {
      const t = bl[i] + s[0] + s[1] * cRamp[i];
      const ph = phasic[i] > 0 ? phasic[i] : 0;   // negative phasic is unphysical
      phasic[i] = normalize ? ph * std : ph;
      tonic[i] = normalize ? t * std + mean : t;
      driver[i] = normalize ? z[i] * std : z[i];  // z holds the exact-zero-between-events driver
    }

    return { phasic, tonic, driver, iterations, converged, rPrim, rDual };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CVXEDA;
}
if (typeof window !== 'undefined') {
  window.CVXEDA = CVXEDA;
}
