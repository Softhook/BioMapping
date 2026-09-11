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
 * The reference hands this QP to CVXOPT's primal-dual interior-point solver
 * (Mehrotra predictor-corrector). We solve it with the *same* algorithm —
 * not an approximation — because the single inequality A·q ≥ 0 only touches
 * the q block, so its KKT system has the same pentadiagonal-plus-small-dense
 * structure regardless of the per-iteration weighting:
 *
 *   slack s = A·q ≥ 0, dual z ≥ 0, complementarity S·z = 0. Each Newton step
 *   solves (H + Aᵀ·diag(z/s)·A)·Δx = rhs for x=[q;d;l], predictor then
 *   corrector (Mehrotra 1992), with a fraction-to-boundary line search.
 *
 * The q-block of that system, Kqq = MᵀM + Aᵀ·diag(w)·A, is symmetric
 * pentadiagonal for *any* per-sample weight w (not just a constant, as an
 * ADMM penalty would be) — one O(n) banded Cholesky. The coupled drift/spline
 * unknowns (dimension 2 + nB, ~n/100) are eliminated by a Schur complement,
 * rebuilt every Newton step since w changes every step. Convex QP + KKT
 * residuals → 0 is a global-optimality certificate, so this converges to the
 * same point CVXOPT does (validated to ~1e-6 relative RMSE against real
 * `cvxopt` output — see cvxEDA_ref cross-checks), typically in 10–25 Newton
 * iterations against CVXOPT's own similar count, and far fewer than the
 * hundreds an ADMM (first-order) solver needed for comparable accuracy.
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
   * @param {number} [options.tauFast=0.7]      - Bateman fast rise τ (s).
   * @param {number} [options.deltaKnotSec=10]  - Tonic B-spline knot spacing (s).
   * @param {number} [options.alpha=8e-4]       - L1 weight on the driver.
   * @param {number} [options.gamma=1e-2]       - L2 weight on tonic smoothness.
   * @param {number} [options.maxIter=50]       - Newton iteration cap (typical
   *   solves converge in 10-25; this is headroom, not a tuning knob).
   * @param {number} [options.tol=1e-10]        - Duality-gap (μ) convergence
   *   threshold, analogous to CVXOPT's reltol.
   * @param {boolean} [options.normalize=true]  - z-score y during the solve
   *   (NeuroKit-compatible; keeps the published α = 8e-4 meaningful).
   * @returns {{
   *   phasic: Float64Array, tonic: Float64Array, driver: Float64Array,
   *   l: Float64Array, d: Float64Array, e: Float64Array, obj: number,
   *   iterations: number, converged: boolean, rPrim: number, rDual: number
   * }} phasic/tonic/driver/l/d/e are in the caller's native y units; obj is
   *   the objective value (eq. 15) evaluated in the internal solve space
   *   (normalized, when normalize=true) — l/d/e/obj mirror the reference's
   *   `l, d, e, obj` return values for direct comparison against it.
   */
  decompose(yRaw, sampleRate, options = {}) {
    const n = yRaw.length;
    if (n < 4) {
      return {
        phasic: new Float64Array(n),
        tonic: Float64Array.from(yRaw),
        driver: new Float64Array(n),
        l: new Float64Array(0), d: new Float64Array([0, 0]), e: new Float64Array(n), obj: 0,
        iterations: 0, converged: true, rPrim: 0, rDual: 0
      };
    }

    const cfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.CVXEDA) || {};
    const tauSlow = options.tauSlow ?? cfg.tauSlow ?? 2.0;
    const tauFast = options.tauFast ?? cfg.tauFast ?? 0.7;
    const deltaKnotSec = options.deltaKnotSec ?? cfg.deltaKnotSec ?? 10.0;
    const alpha = options.alpha ?? cfg.alpha ?? 8e-4;
    const gamma = options.gamma ?? cfg.gamma ?? 1e-2;
    const maxIter = options.maxIter ?? cfg.maxIter ?? 50;
    const tol = options.tol ?? cfg.tol ?? 1e-10;
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
    // MA numerator is [1, 2, 1]. Both operators are square lower-triangular
    // banded matrices exactly as the reference builds them: the main diagonal
    // spans every row, the first sub-diagonal rows 1..n-1, the second rows
    // 2..n-1. So row 0 keeps only the diagonal tap and row 1 the diagonal +
    // first sub-diagonal tap (reference: i = concatenate(rangen, rangen[1:],
    // rangen[2:])).

    // A·x  (banded, causal 3-tap)
    const applyA = (x, out) => {
      out[0] = ar0 * x[0];
      out[1] = ar1 * x[0] + ar0 * x[1];
      for (let i = 2; i < n; i++) out[i] = ar0 * x[i] + ar1 * x[i - 1] + ar2 * x[i - 2];
      return out;
    };
    // Aᵀ·x  (transpose: row j of A scatters to out[j], out[j-1], out[j-2])
    const applyAT = (x, out) => {
      out.fill(0);
      out[0] += ar0 * x[0];
      out[0] += ar1 * x[1]; out[1] += ar0 * x[1];
      for (let j = 2; j < n; j++) {
        const xj = x[j];
        out[j] += ar0 * xj; out[j - 1] += ar1 * xj; out[j - 2] += ar2 * xj;
      }
      return out;
    };
    const applyM = (x, out) => {
      out[0] = x[0];
      out[1] = 2.0 * x[0] + x[1];
      for (let i = 2; i < n; i++) out[i] = x[i] + 2.0 * x[i - 1] + x[i - 2];
      return out;
    };
    const applyMT = (x, out) => {
      out.fill(0);
      out[0] += x[0];
      out[0] += 2.0 * x[1]; out[1] += x[1];
      for (let j = 2; j < n; j++) {
        const xj = x[j];
        out[j] += xj; out[j - 1] += 2.0 * xj; out[j - 2] += xj;
      }
      return out;
    };

    // ── 2. Cubic B-spline basis B (sparse, local support) ─────────────────
    // Knot count matches the reference exactly: np.arange(0, n + delta_knot_s
    // // 2, delta_knot_s) — the floor division matters when knotStep is odd.
    const knotStep = Math.max(1, Math.round(deltaKnotSec / delta));
    const knots = [];
    for (let k = 0; k < n + Math.floor(knotStep / 2); k += knotStep) knots.push(k);
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
    const m = 2 + nB; // drift(2) + spline(nB)

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

    // ── Kqq = MᵀM + Aᵀ·diag(w)·A  (symmetric pentadiagonal) ─────────────
    // w is a per-sample weight (the interior-point complementarity weight
    // z/s, recomputed every Newton step) rather than a constant — the outer
    // product structure that makes this banded doesn't care either way.
    // Stored as three diagonals: kd0[i]=K[i][i], kd1[i]=K[i][i+1], kd2[i]=K[i][i+2].
    const kd0 = new Float64Array(n), kd1 = new Float64Array(n), kd2 = new Float64Array(n);
    // Banded Cholesky factor L (lower, 2 sub-diagonals): lb0[i]=L[i][i],
    // lb1[i]=L[i][i-1], lb2[i]=L[i][i-2].
    const lb0 = new Float64Array(n), lb1 = new Float64Array(n), lb2 = new Float64Array(n);

    const buildKqq = (w) => {
      kd0.fill(0); kd1.fill(0); kd2.fill(0);
      const mTap = [1.0, 2.0, 1.0];
      const aTap = [ar2, ar1, ar0]; // taps at columns [i-2, i-1, i]
      for (let i = 0; i < n; i++) {
        const idx = [i - 2, i - 1, i];
        const pLo = i < 2 ? 2 - i : 0; // rows 0,1 have fewer taps (columns clipped at 0)
        const wi = w[i];
        for (let p = pLo; p < 3; p++) {
          for (let q = p; q < 3; q++) {
            const val = mTap[p] * mTap[q] + wi * aTap[p] * aTap[q];
            const off = idx[q] - idx[p];
            if (off === 0) kd0[idx[p]] += val;
            else if (off === 1) kd1[idx[p]] += val;
            else kd2[idx[p]] += val;
          }
        }
      }
      for (let i = 0; i < n; i++) kd0[i] += 1e-9; // SPD insurance (MᵀM is already full rank)
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

    // solve [Kqq Kqs; Kqsᵀ Kss][qOut;xsOut] = [rhsQ; rhsS] against the
    // current Kqq/Schur factorisation.
    const t1 = new Float64Array(n);
    const rhsSred = new Float64Array(m);
    const solveKKT = (rhsQ, rhsS, qOut, xsOut) => {
      solveKqq(rhsQ, t1);
      for (let r = 0; r < m; r++) rhsSred[r] = rhsS[r] - qsDot(r, t1);
      solveSchur(rhsSred, xsOut);
      tmpN.fill(0); qsApply(xsOut, tmpN);
      solveKqq(tmpN, tmpN2);
      for (let i = 0; i < n; i++) qOut[i] = t1[i] - tmpN2[i];
    };

    // ── Mehrotra predictor-corrector primal-dual interior point ──────────
    // x = [q; d; l]. Slack sk = A·q ≥ 0, dual zk ≥ 0, complementarity sk∘zk=0.
    // (Same algorithm CVXOPT's qp() runs; see the file header.)
    const q = new Float64Array(n);
    const xs = new Float64Array(m);          // [d0, d1, l0..l(nB-1)]
    const sk = new Float64Array(n).fill(1);  // slack, sk = A·q at feasibility
    const zk = new Float64Array(n).fill(1);  // dual
    const w = new Float64Array(n);           // complementarity weight zk/sk

    const Aq = new Float64Array(n), eModel = new Float64Array(n), bl = new Float64Array(n);
    const rdq = new Float64Array(n), rds = new Float64Array(m), rp = new Float64Array(n);
    const combo = new Float64Array(n), Atcombo = new Float64Array(n);
    const dq = new Float64Array(n), dxs = new Float64Array(m), ds = new Float64Array(n), dz = new Float64Array(n);
    const dqC = new Float64Array(n), dxsC = new Float64Array(m), dsC = new Float64Array(n), dzC = new Float64Array(n);
    const rhsQ = new Float64Array(n), rhsSb = new Float64Array(m);
    const gAff = new Float64Array(n), gCc = new Float64Array(n);

    // KKT residuals at the current (q, xs, sk, zk): rdq/rds = ∇_x L, rp = the
    // slack-feasibility gap sk − A·q (both driven to 0 by infeasible-start
    // Newton, no feasible starting point needed).
    const computeResiduals = () => {
      applyM(q, eModel);
      for (let i = 0; i < n; i++) eModel[i] += xs[0] + xs[1] * cRamp[i];
      bl.fill(0); applyB(xs.subarray(2), bl);
      for (let i = 0; i < n; i++) eModel[i] += bl[i] - y[i];

      applyMT(eModel, rdq);
      applyAT(zk, tmpN2);
      for (let i = 0; i < n; i++) rdq[i] += alpha * AT1[i] - tmpN2[i];

      let a0 = 0, a1 = 0;
      for (let i = 0; i < n; i++) { a0 += eModel[i]; a1 += cRamp[i] * eModel[i]; }
      rds[0] = a0; rds[1] = a1;
      for (let j = 0; j < nB; j++) {
        const st = bStart[j], v = bVal[j], len = bLen[j];
        let acc = 0;
        for (let s2 = 0; s2 < len; s2++) acc += v[s2] * eModel[st + s2];
        rds[2 + j] = acc + gamma * xs[2 + j];
      }
      applyA(q, Aq);
      for (let i = 0; i < n; i++) rp[i] = sk[i] - Aq[i];
    };

    // Solve the Newton direction for a given complementarity target γ (the
    // predictor uses γ=-sk∘zk; the corrector adds the Mehrotra second-order
    // + centering terms). Reuses whatever Kqq/Schur factorisation is current.
    const solveDirection = (gammaVec, qOut, xsOut, sOut, zOut) => {
      for (let i = 0; i < n; i++) combo[i] = (zk[i] * rp[i] + gammaVec[i]) / sk[i];
      applyAT(combo, Atcombo);
      for (let i = 0; i < n; i++) rhsQ[i] = -rdq[i] + Atcombo[i];
      for (let r = 0; r < m; r++) rhsSb[r] = -rds[r];
      solveKKT(rhsQ, rhsSb, qOut, xsOut);
      applyA(qOut, tmpN);
      for (let i = 0; i < n; i++) sOut[i] = tmpN[i] - rp[i];
      for (let i = 0; i < n; i++) zOut[i] = (gammaVec[i] - zk[i] * sOut[i]) / sk[i];
    };

    const fracToBoundary = (v, dv, tau) => {
      let amax = 1.0;
      for (let i = 0; i < n; i++) {
        if (dv[i] < 0) { const cand = -v[i] / dv[i]; if (cand < amax) amax = cand; }
      }
      return tau * amax < 1 ? tau * amax : 1;
    };

    let iterations = 0, converged = false, rPrim = 0, rDual = 0;
    const TAU = 0.995; // fraction-to-boundary safety factor (Wright 1997)

    for (let it = 0; it < maxIter; it++) {
      iterations = it + 1;
      computeResiduals();

      let mu = 0; for (let i = 0; i < n; i++) mu += sk[i] * zk[i]; mu /= n;
      let rpN = 0, rdqN = 0;
      for (let i = 0; i < n; i++) { rpN += rp[i] * rp[i]; rdqN += rdq[i] * rdq[i]; }
      rPrim = Math.sqrt(rpN); rDual = Math.sqrt(rdqN);

      // mu < tol is the binding criterion in practice (Newton's quadratic
      // convergence drives it to noise floor fast); rp/rd already converge
      // well ahead of it, so their bounds just need to be generously below
      // the noise floor of an O(1)-scale normalized problem, not tight.
      if (mu < tol && rPrim < 1e-6 && rDual < 1e-4) { converged = true; break; }

      for (let i = 0; i < n; i++) w[i] = zk[i] / sk[i];
      buildKqq(w); factorKqq(); buildSchur();

      // predictor (affine-scaling, σ=0)
      for (let i = 0; i < n; i++) gAff[i] = -sk[i] * zk[i];
      solveDirection(gAff, dq, dxs, ds, dz);
      const apAff = fracToBoundary(sk, ds, 1.0);
      const adAff = fracToBoundary(zk, dz, 1.0);
      let muAff = 0;
      for (let i = 0; i < n; i++) muAff += (sk[i] + apAff * ds[i]) * (zk[i] + adAff * dz[i]);
      muAff /= n;
      let sigma = (muAff / mu) ** 3;
      if (!(sigma >= 0)) sigma = 0; else if (sigma > 1) sigma = 1;

      // corrector (centering + Mehrotra 2nd-order term), same factorisation
      for (let i = 0; i < n; i++) gCc[i] = -sk[i] * zk[i] - ds[i] * dz[i] + sigma * mu;
      solveDirection(gCc, dqC, dxsC, dsC, dzC);

      const ap = fracToBoundary(sk, dsC, TAU);
      const ad = fracToBoundary(zk, dzC, TAU);
      for (let i = 0; i < n; i++) q[i] += ap * dqC[i];
      for (let r = 0; r < m; r++) xs[r] += ap * dxsC[r];
      for (let i = 0; i < n; i++) {
        sk[i] += ap * dsC[i]; if (sk[i] < 1e-13) sk[i] = 1e-13;
        zk[i] += ad * dzC[i]; if (zk[i] < 1e-13) zk[i] = 1e-13;
      }
    }

    // ── Reconstruct physical signals ───────────────────────────────────
    const phasic = new Float64Array(n);
    const tonic = new Float64Array(n);
    const driver = new Float64Array(n);

    applyM(q, phasic);  // r = M·q  (reference)
    applyA(q, driver);  // p = A·q  (reference)
    bl.fill(0); applyB(xs.subarray(2), bl);

    // Objective (reference eq. 15) and residual accumulate in the internal
    // solve space — i.e. the normalized y when normalize=true, matching what
    // the reference gets when the caller follows its own "pre-zscore y"
    // recommendation. Driver is A·q exactly as the reference returns it,
    // unthresholded — interior-point complementary slackness (sk∘zk → 0 at
    // convergence) already pins it to ~1e-8 or below between events, the
    // same noise floor the reference's own CVXOPT solve leaves behind, so no
    // active-set gating is needed (that was an ADMM-only workaround for its
    // much looser 3e-4 tolerance).
    let resid2 = 0, alphaSum = 0;
    for (let i = 0; i < n; i++) {
      const t = bl[i] + xs[0] + xs[1] * cRamp[i];
      const rRaw = phasic[i], pRaw = driver[i];
      const resid = rRaw + t - y[i];
      resid2 += resid * resid;
      alphaSum += pRaw;

      phasic[i] = normalize ? rRaw * std : rRaw;
      tonic[i] = normalize ? t * std + mean : t;
      driver[i] = normalize ? pRaw * std : pRaw;
    }
    let gammaTerm = 0;
    for (let j = 0; j < nB; j++) gammaTerm += xs[2 + j] * xs[2 + j];
    const obj = 0.5 * resid2 + alpha * alphaSum + 0.5 * gamma * gammaTerm;

    const e = new Float64Array(n);
    for (let i = 0; i < n; i++) e[i] = yRaw[i] - phasic[i] - tonic[i];

    // d, l rescaled to native units so d0 + d1·cRamp + B·l reproduces tonic
    // (mirrors how phasic/tonic/driver are already rescaled above).
    const d = normalize ? new Float64Array([xs[0] * std + mean, xs[1] * std]) : new Float64Array([xs[0], xs[1]]);
    const l = new Float64Array(nB);
    for (let j = 0; j < nB; j++) l[j] = normalize ? xs[2 + j] * std : xs[2 + j];

    return { phasic, tonic, driver, l, d, e, obj, iterations, converged, rPrim, rDual };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CVXEDA;
}
if (typeof window !== 'undefined') {
  window.CVXEDA = CVXEDA;
}
