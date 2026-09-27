/**
 * SparsEDA — Sparse Nonnegative Deconvolution of the skin conductance signal
 * against a dictionary of bi-exponential SCRF kernels, with a joint tonic fit.
 *
 *   Hernando-Gallego, F., Luengo, D., & Artés-Rodríguez, A. (2018).
 *   Feature Extraction of Galvanic Skin Responses by Nonnegative Sparse
 *   Deconvolution. IEEE Journal of Biomedical and Health Informatics.
 *
 * A direct JS port of the official reference implementation
 * (`fhernandogallego/sparsEDA`): the same 70 s overlap-save windows, 5-scale
 * SCR dictionary, 6-column tonic basis, non-negative LARS/LASSO inner solver,
 * and the same post-processing (`dmin` spacing + `rho` relative-amplitude
 * threshold). The LASSO solver stays here rather than in a shared maths file:
 * it follows the reference's own stopping rule and `strictReference` quirks,
 * and nothing else uses it.
 *
 * Entry point: SCRDeconvolution.deconvolve() with algorithm 'sparseda'.
 */

import { ResponseDynamics } from './response_dynamics.mjs';

export const SparsEDA = {
  /**
   * SparsEDA dictionary time-stretch factors (1.0 = the canonical kernel,
   * 0.5 = twice as fast). The slowest rises in ~1.4 s, quicker than many
   * real SCRs (~1-3 s), but adding slower kernels (2x, 2.5x) lets the solver
   * merge neighbouring responses into one drawn-out atom: ground-truth F1
   * fell .81 -> .78. So detection keeps these five and rise time is measured
   * on the signal instead (ResponseDynamics.measurePeakRise). Override per
   * call with opts.stretches.
   */
  REFERENCE_STRETCHES: [0.5, 0.75, 1.0, 1.25, 1.5],

  _norm2(vec, start = 0, end = vec.length) {
    let sum = 0;
    for (let i = start; i < end; i++) sum += vec[i] * vec[i];
    return Math.sqrt(sum);
  },

  _dot(a, b) {
    // SparsEDA dictionary columns carry their non-zero span as _s/_e (see
    // _buildReferenceDictionary): each is a ~10 s kernel inside a 70 s window,
    // so restricting the loop to the overlap skips only exact-zero products
    // and returns the identical sum at a fraction of the cost.
    let lo = 0;
    let hi = a.length;
    if (a._e !== undefined) {
      lo = a._s;
      hi = a._e;
    }
    if (b._e !== undefined) {
      if (b._s > lo) lo = b._s;
      if (b._e < hi) hi = b._e;
    }
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += a[i] * b[i];
    return sum;
  },

  // The lasso's Cholesky factor R (upper triangular, R^T R = A^T A over the
  // active columns) is stored COLUMN-wise: U[j] is column j, holding rows
  // 0..j. Adding an atom appends a column instead of copying the matrix, and
  // removing one is an O(k^2) Givens update (_cholDelete) instead of a
  // from-scratch rebuild.
  _solveUpperTriangular(U, b, transpose = false) {
    const n = b.length;
    const x = new Float64Array(n);
    if (transpose) {
      // R^T x = b: row i of R^T is column i of R.
      for (let i = 0; i < n; i++) {
        const col = U[i];
        let sum = b[i];
        for (let k = 0; k < i; k++) sum -= col[k] * x[k];
        x[i] = sum / col[i];
      }
      return x;
    }
    // R x = b, back substitution: R[i][k] = U[k][i].
    for (let i = n - 1; i >= 0; i--) {
      let sum = b[i];
      for (let k = i + 1; k < n; k++) sum -= U[k][i] * x[k];
      x[i] = sum / U[i][i];
    }
    return x;
  },

  _updateChol(RI, columns, activeSet, newIndex, zeroTol) {
    const newVec = columns[newIndex];
    if (!RI || activeSet.length === 0) {
      return {
        RI: [Float64Array.from([Math.sqrt(this._dot(newVec, newVec))])],
        flag: 0,
      };
    }

    const rhs = new Float64Array(activeSet.length);
    for (let i = 0; i < activeSet.length; i++) {
      rhs[i] = this._dot(columns[activeSet[i]], newVec);
    }
    const p = this._solveUpperTriangular(RI, rhs, true);
    let q = this._dot(newVec, newVec);
    for (let i = 0; i < p.length; i++) q -= p[i] * p[i];
    if (q <= zeroTol) return { RI, flag: 1 };

    const m = RI.length;
    const col = new Float64Array(m + 1);
    col.set(p, 0);
    col[m] = Math.sqrt(q);
    RI.push(col);
    return { RI, flag: 0 };
  },

  /**
   * Remove active column `pos` from the column-stored factor and restore
   * upper-triangular form with Givens rotations (the standard QR column
   * delete). Mathematically the factor of the remaining columns, as a
   * rebuild would give, in O(k^2) instead of O(k^3) plus k^2 dot products.
   */
  _cholDelete(RI, pos) {
    RI.splice(pos, 1);
    const m = RI.length;
    for (let k = pos; k < m; k++) {
      // Column k now has one sub-diagonal entry at row k+1; rotate rows
      // k, k+1 to zero it, applying the same rotation to later columns.
      const ck = RI[k];
      const a = ck[k];
      const b = ck[k + 1];
      const r = Math.hypot(a, b);
      const c = r > 0 ? a / r : 1;
      const sn = r > 0 ? b / r : 0;
      const trimmed = new Float64Array(k + 1);
      trimmed.set(ck.subarray(0, k), 0);
      trimmed[k] = r;
      RI[k] = trimmed;
      for (let j = k + 1; j < m; j++) {
        const cj = RI[j];
        const x = cj[k];
        const y = cj[k + 1];
        cj[k] = c * x + sn * y;
        cj[k + 1] = -sn * x + c * y;
      }
    }
    return RI;
  },

  _buildReferenceDictionary(
    sampleRate,
    tauSlow = 2.0,
    tauFast = 0.5,
    kernelSec = 10.0,
    srFactors = this.REFERENCE_STRETCHES,
  ) {
    const durationR = 70;
    const Lreg = Math.round(20 * sampleRate * 3);
    const N = Math.round(durationR * sampleRate);
    const T = 6;
    const columns = new Array(T + srFactors.length * Lreg);
    const bandKernels = [];

    for (let band = 0; band < srFactors.length; band++) {
      const srF = sampleRate * srFactors[band];
      const rf = [];
      for (let t = 0; t <= kernelSec + 1e-12; t += 1 / srF) {
        rf.push(Math.exp(-t / tauSlow) - Math.exp(-t / tauFast));
      }
      let rfNorm = 0;
      for (let i = 0; i < rf.length; i++) rfNorm += rf[i] * rf[i];
      rfNorm = Math.sqrt(rfNorm);
      for (let i = 0; i < rf.length; i++) rf[i] /= rfNorm;
      bandKernels.push(Float64Array.from(rf));

      const base = T + band * Lreg;
      for (let c = 0; c < Lreg; c++) {
        const col = new Float64Array(N);
        const limit = Math.min(rf.length, N - c);
        for (let k = 0; k < limit; k++) col[c + k] = rf[k];
        col._s = c; // non-zero span, read by _dot / the lasso's v update
        col._e = c + limit;
        columns[base + c] = col;
      }
    }

    const c0 = new Float64Array(N);
    const c1 = new Float64Array(N);
    const c2 = new Float64Array(N);
    const c3 = new Float64Array(N);
    const c4 = new Float64Array(N);
    const c5 = new Float64Array(N);
    for (let i = 0; i < Lreg; i++) {
      const frac = Lreg > 1 ? i / (Lreg - 1) : 0;
      c0[i] = frac;
      c1[i] = -frac;
    }
    const start2 = Math.floor(Lreg / 3);
    const len2 = Lreg - start2;
    for (let i = 0; i < len2; i++) {
      const frac = len2 > 1 ? i / (len2 - 1) : 0;
      c2[start2 + i] = (2 / 3) * frac;
      c3[start2 + i] = -(2 / 3) * frac;
    }
    const start4 = Math.floor((2 * Lreg) / 3);
    const len4 = Lreg - start4;
    for (let i = 0; i < len4; i++) {
      const frac = len4 > 1 ? i / (len4 - 1) : 0;
      c4[start4 + i] = (1 / 3) * frac;
      c5[start4 + i] = -(1 / 3) * frac;
    }
    let cte = 0;
    for (let i = 0; i < N; i++) cte += c0[i] * c0[i];
    const sclScale = Math.sqrt(cte);
    for (const col of [c0, c1, c2, c3, c4, c5]) {
      for (let i = 0; i < N; i++) col[i] /= sclScale;
    }
    c0._s = c1._s = 0;
    c0._e = c1._e = Lreg;
    c2._s = c3._s = start2;
    c2._e = c3._e = Lreg;
    c4._s = c5._s = start4;
    c4._e = c5._e = Lreg;
    columns[0] = c0;
    columns[1] = c1;
    columns[2] = c2;
    columns[3] = c3;
    columns[4] = c4;
    columns[5] = c5;

    return { columns, Lreg, N, T, bandKernels };
  },

  _gcd(a, b) {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y !== 0) {
      const t = x % y;
      x = y;
      y = t;
    }
    return x || 1;
  },

  _resampledLength(inputLength, sampleRate, targetRate) {
    if (sampleRate === targetRate) return inputLength;
    return Math.max(1, Math.round((targetRate * inputLength) / sampleRate));
  },

  _polyphaseResample(signal, upFactor, downFactor) {
    const maxRate = Math.max(upFactor, downFactor);
    const halfLen = 10 * maxRate;
    const taps = new Float64Array(2 * halfLen + 1);
    const cutoff = 1 / maxRate;
    for (let i = 0; i < taps.length; i++) {
      const n = i - halfLen;
      const base =
        n === 0 ? cutoff : Math.sin(Math.PI * cutoff * n) / (Math.PI * n);
      const window = 0.54 + 0.46 * Math.cos((Math.PI * n) / halfLen);
      taps[i] = upFactor * base * window;
    }

    const outputLength = Math.max(
      1,
      Math.round((signal.length * upFactor) / downFactor),
    );
    const out = new Float64Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const center = i * downFactor;
      const srcStart = Math.max(0, Math.ceil((center - halfLen) / upFactor));
      const srcEnd = Math.min(
        signal.length - 1,
        Math.floor((center + halfLen) / upFactor),
      );
      let sum = 0;
      for (let j = srcStart; j <= srcEnd; j++) {
        sum += signal[j] * taps[center - j * upFactor + halfLen];
      }
      out[i] = sum;
    }
    return out;
  },

  _linearResampleTo(signal, sampleRate, targetRate) {
    if (sampleRate === targetRate) {
      return {
        values: Float64Array.from(signal),
        outputLength: signal.length,
        rate: sampleRate,
      };
    }
    if (sampleRate > targetRate) {
      const gcd = this._gcd(sampleRate, targetRate);
      const upFactor = Math.round(targetRate / gcd);
      const downFactor = Math.round(sampleRate / gcd);
      const out = this._polyphaseResample(signal, upFactor, downFactor);
      return { values: out, outputLength: out.length, rate: targetRate };
    }
    const outputLength = this._resampledLength(
      signal.length,
      sampleRate,
      targetRate,
    );
    const out = new Float64Array(outputLength);
    const scale = sampleRate / targetRate;
    for (let i = 0; i < outputLength; i++) {
      const src = i * scale;
      const lo = Math.floor(src);
      const hi = Math.min(signal.length - 1, lo + 1);
      const frac = src - lo;
      out[i] = signal[lo] * (1 - frac) + signal[hi] * frac;
    }
    return { values: out, outputLength, rate: targetRate };
  },

  _linearResampleBack(signal, inputRate, targetLength, targetRate) {
    if (signal.length === targetLength && inputRate === targetRate)
      return Float64Array.from(signal);
    const out = new Float64Array(targetLength);
    const scale = inputRate / targetRate;
    for (let i = 0; i < targetLength; i++) {
      const src = i * scale;
      const lo = Math.max(0, Math.min(signal.length - 1, Math.floor(src)));
      const hi = Math.max(0, Math.min(signal.length - 1, lo + 1));
      const frac = src - lo;
      out[i] = signal[lo] * (1 - frac) + signal[hi] * frac;
    }
    return out;
  },

  _resampleSparseDriverBack(signal, inputRate, targetLength, targetRate) {
    if (signal.length === targetLength && inputRate === targetRate)
      return Float64Array.from(signal);
    const out = new Float64Array(targetLength);
    const scale = targetRate / inputRate;
    for (let i = 0; i < signal.length; i++) {
      const amp = signal[i];
      if (amp <= 0) continue;
      const idx = Math.max(
        0,
        Math.min(targetLength - 1, Math.round(i * scale)),
      );
      out[idx] += amp;
    }
    return out;
  },

  _runReferenceLasso(
    columns,
    s,
    sampleRate,
    maxIter,
    epsilon,
    strictReference = false,
  ) {
    const W = columns.length;
    const zeroTol = 1e-5;
    const optTol = -10;
    const resStop2 = 0.0005;
    const lambdaStop = 0;

    const x = new Float64Array(W);
    const xOld = new Float64Array(W);
    let iterations = 0;

    const c = new Float64Array(W);
    let lambda = -Infinity;
    for (let j = 0; j < W; j++) {
      const val = this._dot(columns[j], s);
      c[j] = val;
      if (val > lambda) lambda = val;
    }
    if (lambda < 0)
      throw new Error(
        'y is not expressible as a non-negative linear combination of the dictionary',
      );
    if (lambda <= zeroTol) {
      return {
        beta: x,
        iterations,
        activationHist: [],
        lambda,
        residual: Float64Array.from(s),
        converged: true,
      };
    }

    let newIndices = [];
    for (let j = 0; j < W; j++)
      if (Math.abs(c[j] - lambda) < zeroTol) newIndices.push(j);
    const collinear = new Set();
    const activeSet = [];
    const isActive = new Uint8Array(W); // membership flag for activeSet
    const activationHist = [];
    let RI = null;
    for (const idx of newIndices) {
      iterations++;
      const updated = this._updateChol(RI, columns, activeSet, idx, zeroTol);
      RI = updated.RI;
      if (updated.flag) {
        collinear.add(idx);
      } else {
        activeSet.push(idx);
        isActive[idx] = 1;
        activationHist.push(idx);
      }
    }

    const res = Float64Array.from(s);
    let done = false;
    let _hitIterCap = false;
    let rolledBack = false;
    while (!done) {
      if (activationHist.length === 4 && strictReference) {
        lambda = -Infinity;
        newIndices = [];
        for (let j = 0; j < W; j++) if (c[j] > lambda) lambda = c[j];
        for (let j = 0; j < W; j++)
          if (Math.abs(c[j] - lambda) < zeroTol) newIndices.push(j);
        for (const j of activeSet) isActive[j] = 0;
        activeSet.length = 0;
        RI = null;
        for (const idx of newIndices) {
          iterations++;
          const updated = this._updateChol(
            RI,
            columns,
            activeSet,
            idx,
            zeroTol,
          );
          RI = updated.RI;
          if (updated.flag) collinear.add(idx);
          else {
            activeSet.push(idx);
            isActive[idx] = 1;
          }
        }
        activationHist.push(...activeSet);
      } else if (activeSet.length > 0) {
        lambda = c[activeSet[0]];
      } else {
        lambda = -Infinity;
        newIndices = [];
        for (let j = 0; j < W; j++) {
          if (!collinear.has(j) && c[j] > lambda) lambda = c[j];
        }
        if (lambda <= zeroTol) break;
        for (let j = 0; j < W; j++) {
          if (!collinear.has(j) && Math.abs(c[j] - lambda) < zeroTol)
            newIndices.push(j);
        }
        for (const idx of newIndices) {
          iterations++;
          const updated = this._updateChol(
            RI,
            columns,
            activeSet,
            idx,
            zeroTol,
          );
          RI = updated.RI;
          if (updated.flag) collinear.add(idx);
          else {
            activeSet.push(idx);
            isActive[idx] = 1;
            activationHist.push(idx);
          }
        }
        if (activeSet.length === 0) break;
      }

      const activeSigns = new Float64Array(activeSet.length);
      for (let i = 0; i < activeSet.length; i++)
        activeSigns[i] = Math.sign(c[activeSet[i]]);
      const z = this._solveUpperTriangular(RI, activeSigns, true);
      const dxActive = this._solveUpperTriangular(RI, z, false);
      const dx = new Float64Array(W);
      for (let i = 0; i < activeSet.length; i++) dx[activeSet[i]] = dxActive[i];

      const v = new Float64Array(s.length);
      for (let i = 0; i < activeSet.length; i++) {
        const coeff = dxActive[i];
        if (coeff === 0) continue;
        const col = columns[activeSet[i]];
        const r0 = col._e !== undefined ? col._s : 0;
        const r1 = col._e !== undefined ? col._e : s.length;
        for (let r = r0; r < r1; r++) v[r] += coeff * col[r];
      }

      const ATv = new Float64Array(W);
      for (let j = 0; j < W; j++) ATv[j] = this._dot(columns[j], v);

      let gammaIc = 1;
      newIndices = [];
      {
        let best = Infinity;
        const denomEps = 1e-12;
        for (let j = 0; j < W; j++) {
          if (isActive[j] || collinear.has(j)) continue;
          const gamma = (lambda - c[j]) / (1 - ATv[j] + denomEps);
          if (gamma < zeroTol) continue;
          if (gamma < best - zeroTol) {
            best = gamma;
            newIndices = [j];
          } else if (Math.abs(gamma - best) < zeroTol) {
            newIndices.push(j);
          }
        }
        if (newIndices.length > 0) gammaIc = best;
      }

      // Lasso non-negative condition: distance until an active variable hits zero
      let gammaI = Infinity;
      let dropIdx = -1;
      if (!strictReference) {
        for (const j of activeSet) {
          if (dx[j] < -zeroTol && x[j] > zeroTol) {
            const gamma = -x[j] / dx[j];
            if (gamma < gammaI) {
              gammaI = gamma;
              dropIdx = j;
            }
          }
        }
      }

      const gammaMin = Math.min(gammaIc, gammaI);
      if (!isFinite(gammaMin) || gammaMin <= 0) break;

      for (let j = 0; j < W; j++) x[j] += gammaMin * dx[j];
      for (let i = 0; i < res.length; i++) res[i] -= gammaMin * v[i];
      for (let j = 0; j < W; j++) c[j] -= gammaMin * ATv[j];

      if (
        lambda - gammaMin < optTol ||
        (lambdaStop > 0 && lambda <= lambdaStop) ||
        (epsilon > 0 && this._norm2(res) <= epsilon)
      ) {
        newIndices = [];
        done = true;
        if (!strictReference) break;
      }
      if (
        this._norm2(
          res,
          0,
          Math.min(res.length, Math.round(sampleRate * 20)),
        ) <= resStop2
      ) {
        done = true;
        if (!strictReference) break;
      }

      if (!strictReference && gammaI <= gammaIc && dropIdx >= 0) {
        // Variable reached zero from above: drop from activeSet and continue
        x[dropIdx] = 0;
        const pos = activeSet.indexOf(dropIdx);
        if (pos >= 0) {
          activeSet.splice(pos, 1);
          isActive[dropIdx] = 0;
          if (activeSet.length === 0) RI = null;
          else RI = this._cholDelete(RI, pos);
        }
        collinear.clear();
      } else {
        for (const idx of newIndices) {
          iterations++;
          const updated = this._updateChol(
            RI,
            columns,
            activeSet,
            idx,
            zeroTol,
          );
          RI = updated.RI;
          if (updated.flag) {
            collinear.add(idx);
          } else {
            activeSet.push(idx);
            isActive[idx] = 1;
            activationHist.push(idx);
          }
        }
      }
      if (iterations >= maxIter) {
        _hitIterCap = true;
        done = true;
      }

      if (strictReference) {
        let hasNegative = false;
        for (let j = 0; j < W; j++) {
          if (x[j] < 0) {
            hasNegative = true;
            break;
          }
        }
        if (hasNegative) {
          x.set(xOld);
          rolledBack = true;
          done = true;
        } else {
          xOld.set(x);
        }
      } else {
        for (let j = 0; j < W; j++) {
          if (x[j] < 0) x[j] = 0;
        }
      }
    }

    return {
      beta: x,
      iterations,
      activationHist,
      lambda,
      residual: res,
      converged: !rolledBack,
    };
  },

  /**
   * Core SparsEDA implementation: port of the official reference solver.
   * Called through SCRDeconvolution.deconvolve(), which builds the kernel
   * and handles the empty / single-sample cases.
   */
  deconvolve(
    phasic,
    sampleRate,
    canonicalKernel,
    maxIter,
    epsilon,
    dminSec,
    rho,
    tauSlow = 2.0,
    tauFast = 0.5,
    kernelSec = 10.0,
    strictReference = false,
    zeroBaseline = false,
    stretches = this.REFERENCE_STRETCHES,
  ) {
    const n = phasic.length;
    if (n === 0) {
      return {
        driver: new Float64Array(0),
        clean: new Float64Array(0),
        tonic: new Float64Array(0),
        kernel: canonicalKernel,
        iterations: 0,
        impulseLog: [],
        converged: true,
        applyRescale: false,
      };
    }

    let hasPositive = false;
    for (let i = 0; i < n; i++) {
      if (phasic[i] > 0) {
        hasPositive = true;
        break;
      }
    }
    if (!hasPositive) {
      return {
        driver: new Float64Array(n),
        clean: new Float64Array(n),
        tonic: new Float64Array(n),
        kernel: canonicalKernel,
        iterations: 0,
        impulseLog: [],
        converged: true,
        applyRescale: false,
      };
    }

    const targetRate = 8;
    const padStartOrig = Math.round(20 * sampleRate);
    const padEndOrig = Math.round(60 * sampleRate);
    const signalAddOrig = new Float64Array(n + padStartOrig + padEndOrig);
    // Reference: pad with the edge value (it subtracts that same value as the
    // window baseline, so the pad is flat zero). With zeroBaseline the edge
    // value can be mid-response, and a long flat plateau is something no
    // decaying SCR atom can fit; a mirror image is (a rise into the edge).
    const clampIdx = (i) => Math.max(0, Math.min(n - 1, i));
    for (let i = 0; i < padStartOrig; i++)
      signalAddOrig[i] = zeroBaseline
        ? phasic[clampIdx(padStartOrig - i)]
        : phasic[0];
    signalAddOrig.set(phasic, padStartOrig);
    for (let i = 0; i < padEndOrig; i++)
      signalAddOrig[padStartOrig + n + i] = zeroBaseline
        ? phasic[clampIdx(n - 2 - i)]
        : phasic[n - 1];

    const resampled = this._linearResampleTo(
      signalAddOrig,
      sampleRate,
      targetRate,
    );
    const signalAdd = resampled.values;
    const workRate = resampled.rate;
    const workSignalLength = this._resampledLength(n, sampleRate, targetRate);
    const pointerS = this._resampledLength(
      padStartOrig,
      sampleRate,
      targetRate,
    );
    const pointerE = pointerS + workSignalLength;
    const { columns, Lreg, N, T, bandKernels } = this._buildReferenceDictionary(
      workRate,
      tauSlow,
      tauFast,
      kernelSec,
      stretches,
    );
    const nBands = bandKernels.length;
    const Ns = signalAdd.length;
    const sclAux = new Float64Array(Ns);
    const driverAux = new Float64Array(Ns);
    const bandAux = Array.from({ length: nBands }, () => new Float64Array(Ns));
    const resAux = new Float64Array(Ns);
    // zeroBaseline only: the summed response of atoms already committed by
    // earlier windows. Their kernels decay on into later windows; unless that
    // tail is removed before the next solve, the next window re-explains it
    // with fresh atoms at its start and the reconstruction counts it twice
    // (vertical jumps + overshoot at every window boundary).
    const committed = zeroBaseline ? new Float64Array(Ns) : null;
    let cutS = 0;
    let cutE = N;
    let b0 = 0;
    let totalIterations = 0;
    let truncated = false;

    const processWindow = (start, copyLen) => {
      const signalCut = new Float64Array(N);
      const available = Math.min(N, Ns - start);
      signalCut.set(signalAdd.subarray(start, start + available), 0);
      const fill =
        available > 0
          ? signalCut[available - 1]
          : start > 0
            ? signalAdd[start - 1]
            : signalAdd[0];
      for (let i = available; i < N; i++) signalCut[i] = fill;
      // The reference takes the window's first sample as the SCL start and
      // carries the ramp estimate forward. That assumes RAW conductance. For a
      // tonic-subtracted phasic input (zeroBaseline) the floor is 0 by
      // construction: a window that happens to start on a response would
      // otherwise shift the whole window below zero, where the non-negative
      // SCR atoms can't reach, and the solver spends its budget on the ramps.
      if (zeroBaseline) {
        b0 = 0;
        for (let i = 0; i < N && start + i < Ns; i++)
          signalCut[i] -= committed[start + i];
      } else if (b0 === 0) b0 = signalCut[0];

      const centered = new Float64Array(signalCut.length);
      for (let i = 0; i < signalCut.length; i++)
        centered[i] = signalCut[i] - b0;
      const lasso = this._runReferenceLasso(
        columns,
        centered,
        workRate,
        maxIter,
        epsilon,
        strictReference,
      );
      totalIterations += lasso.iterations;
      if (!lasso.converged) truncated = true;
      const beta = lasso.beta;

      const signalEst = new Float64Array(N);
      for (let i = 0; i < N; i++) signalEst[i] = b0;
      for (let j = 0; j < columns.length; j++) {
        const coeff = beta[j];
        if (coeff === 0) continue;
        const col = columns[j];
        for (let i = 0; i < N; i++) signalEst[i] += coeff * col[i];
      }

      const remAout = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const diff = signalCut[i] - signalEst[i];
        remAout[i] = diff * diff;
      }
      let res2 = 0,
        res3 = 0;
      for (
        let i = Math.round(20 * workRate);
        i < Math.round(40 * workRate);
        i++
      )
        res2 += remAout[i];
      for (
        let i = Math.round(40 * workRate);
        i < Math.round(60 * workRate);
        i++
      )
        res3 += remAout[i];

      // Advance past the 20-40 / 40-60 s chunks too when they're already
      // fitted. The reference judges that against an absolute 1 (units²),
      // which a phasic of 0.05-0.3 µS never reaches, so a window whose first
      // 20 s were quiet (the lasso's early resStop2 exit) skipped a full 60 s
      // with nothing modelled. For phasic input judge each chunk against the
      // same noise scale as epsilon: its residual RMS at the noise level.
      const jumpTol = zeroBaseline
        ? (epsilon * epsilon * Math.round(20 * workRate)) / N
        : 1;
      let jump = 1;
      if (res2 < jumpTol) {
        jump = 2;
        if (res3 < jumpTol) jump = 3;
      }

      const scl = new Float64Array(N);
      for (let i = 0; i < N; i++) scl[i] = b0;
      for (let j = 0; j < T; j++) {
        const coeff = beta[j];
        if (coeff === 0) continue;
        const col = columns[j];
        for (let i = 0; i < N; i++) scl[i] += coeff * col[i];
      }
      const driverChunk = new Float64Array(Lreg);
      const bandChunks = Array.from(
        { length: nBands },
        () => new Float64Array(Lreg),
      );
      for (let offset = 0; offset < Lreg; offset++) {
        let sum = 0;
        for (let band = 0; band < nBands; band++) {
          const coeff = beta[T + band * Lreg + offset];
          bandChunks[band][offset] = coeff;
          sum += coeff;
        }
        driverChunk[offset] = sum;
      }

      const naturalChunkLen = jump * Math.round(20 * workRate);
      const chunkLen = Math.min(copyLen, naturalChunkLen);
      const b0Row = Math.max(0, Math.min(N - 1, naturalChunkLen - 1));
      let nextB0 = b0;
      for (let j = 0; j < T; j++) nextB0 += columns[j][b0Row] * beta[j];
      b0 = zeroBaseline ? 0 : nextB0;

      if (committed) {
        for (let offset = 0; offset < chunkLen; offset++) {
          for (let band = 0; band < nBands; band++) {
            const amp = bandChunks[band][offset];
            if (amp <= 0) continue;
            const kern = bandKernels[band];
            const at = start + offset;
            const lim = Math.min(kern.length, Ns - at);
            for (let k = 0; k < lim; k++) committed[at + k] += amp * kern[k];
          }
        }
      }

      driverAux.set(driverChunk.subarray(0, chunkLen), start);
      sclAux.set(scl.subarray(0, chunkLen), start);
      for (let band = 0; band < nBands; band++)
        bandAux[band].set(bandChunks[band].subarray(0, chunkLen), start);
      resAux.set(remAout.subarray(0, chunkLen), start);
      return chunkLen;
    };

    while (cutE < Ns) {
      cutS += processWindow(cutS, Ns - cutS);
      cutE = cutS + N;
    }
    if (cutS < Ns) processWindow(cutS, Ns - cutS);

    const driverWorkRaw = driverAux.slice(pointerS, pointerE);
    const tonicWork = sclAux.slice(pointerS, pointerE);
    const mseWork = resAux.slice(pointerS, pointerE);
    const bandWorkRaw = bandAux.map((arr) => arr.slice(pointerS, pointerE));
    const minGapSamples = Math.max(1, Math.round(dminSec * workRate));

    const candidates = [];
    for (let i = 0; i < driverWorkRaw.length; i++) {
      if (driverWorkRaw[i] > 0) candidates.push(i);
    }
    candidates.sort((a, b) => driverWorkRaw[b] - driverWorkRaw[a]);
    const kept = [];
    for (const idx of candidates) {
      let farEnough = true;
      for (const prev of kept) {
        if (Math.abs(idx - prev) < minGapSamples) {
          farEnough = false;
          break;
        }
      }
      if (farEnough) kept.push(idx);
    }

    const driverWork = new Float64Array(driverWorkRaw.length);
    // Per-band coefficients the reconstruction uses. In production mode
    // (not strictReference) an atom suppressed by the dmin gap is MERGED
    // into the kept atom it sits next to rather than discarded: LARS often
    // splits one response across adjacent onset samples, and dropping the
    // smaller half threw away ~half of every response's amplitude (and the
    // reconstruction then under-fitted the phasic). strictReference keeps the
    // reference's discard behaviour.
    const bandWork = bandWorkRaw.map((arr) => Float64Array.from(arr));
    for (const idx of kept) driverWork[idx] = driverWorkRaw[idx];
    if (!strictReference) {
      const keptSorted = [...kept].sort((a, b) => a - b);
      const keptSet = new Set(kept);
      for (const idx of candidates) {
        if (keptSet.has(idx)) continue;
        // Nearest kept atom (one always lies within minGapSamples).
        let lo = 0,
          hi = keptSorted.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (keptSorted[mid] < idx) lo = mid + 1;
          else hi = mid;
        }
        let k = keptSorted[lo];
        if (lo > 0 && idx - keptSorted[lo - 1] <= Math.abs(k - idx))
          k = keptSorted[lo - 1];
        driverWork[k] += driverWorkRaw[idx];
        for (let band = 0; band < nBands; band++) {
          bandWork[band][k] += bandWorkRaw[band][idx];
          bandWork[band][idx] = 0;
        }
      }
    }
    let maxKept = 0;
    for (const idx of kept)
      if (driverWork[idx] > maxKept) maxKept = driverWork[idx];
    const threshold = rho * maxKept;
    if (threshold > 0) {
      for (let i = 0; i < driverWork.length; i++) {
        if (driverWork[i] < threshold) driverWork[i] = 0;
      }
    }

    const cleanWork = new Float64Array(driverWork.length);
    // Atoms whose onset falls in the start pad (a response already under way
    // when recording began) aren't in the sliced driver, but their visible
    // tail is part of the signal: add it, or the reconstruction starts at 0
    // and that response is never seen. Production only: the reference has no
    // such term, and its clean must stay consistent with the rho-pruned driver.
    for (let idx = 0; !strictReference && idx < pointerS; idx++) {
      for (let band = 0; band < nBands; band++) {
        const amp = bandAux[band][idx];
        if (!(amp > 0)) continue;
        const kernel = bandKernels[band];
        for (let k = pointerS - idx; k < kernel.length; k++) {
          const at = idx + k - pointerS;
          if (at >= cleanWork.length) break;
          cleanWork[at] += amp * kernel[k];
        }
      }
    }
    for (let idx = 0; idx < driverWork.length; idx++) {
      if (driverWork[idx] <= 0) continue;
      for (let band = 0; band < nBands; band++) {
        const amp = bandWork[band][idx];
        if (amp <= 0) continue;
        const kernel = bandKernels[band];
        const limit = Math.min(kernel.length, cleanWork.length - idx);
        for (let k = 0; k < limit; k++) cleanWork[idx + k] += amp * kernel[k];
      }
    }

    const driver = this._resampleSparseDriverBack(
      driverWork,
      workRate,
      n,
      sampleRate,
    );
    const clean = this._linearResampleBack(cleanWork, workRate, n, sampleRate);
    const tonic = this._linearResampleBack(tonicWork, workRate, n, sampleRate);
    const mse = this._linearResampleBack(mseWork, workRate, n, sampleRate);

    const scale = sampleRate / workRate;

    // Track dominant dictionary band for each driver activation. Every band
    // kernel is scaled to unit energy, so a slower (longer) kernel has a lower
    // peak and needs a larger coefficient for the same bump: compare bands by
    // the height each one contributes (coefficient × kernel peak), not by raw
    // coefficient, or the choice is biased towards the slow bands.
    const bandPeakHeight = bandKernels.map((k) => {
      let m = 0;
      for (let i = 0; i < k.length; i++) if (k[i] > m) m = k[i];
      return m;
    });
    const templateRise = bandKernels.map(
      (_, b) =>
        ResponseDynamics.measureBump(
          [
            {
              onsetSec: 0,
              bandAmps: bandKernels.map((__, j) => (j === b ? 1 : 0)),
            },
          ],
          bandKernels,
          workRate,
        ).rise,
    );
    const workDominant = new Map();
    for (let i = 0; i < driverWork.length; i++) {
      if (driverWork[i] <= 0) continue;
      let dominantBand = 2;
      let maxHeight = -1;
      let height = 0;
      for (let b = 0; b < nBands; b++) {
        const h = Math.max(0, bandWork[b][i]) * bandPeakHeight[b];
        height += h;
        if (h > maxHeight) {
          maxHeight = h;
          dominantBand = b;
        }
      }
      const targetIdx = Math.max(0, Math.min(n - 1, Math.round(i * scale)));
      workDominant.set(targetIdx, {
        band: dominantBand,
        height,
        onsetSec: i / workRate,
        bandAmps: bandWork.map((arr) => Math.max(0, arr[i])),
      });
    }

    const impulseLog = Array.from(driver)
      .map((amp, i) => {
        if (amp <= 0) return null;
        const dom = workDominant.get(i);
        const bandIdx = dom ? dom.band : 2;
        const height = dom ? dom.height : amp;
        // Band b stretches the kernel in time by stretches[b] (0.5 = the
        // fastest response). The atom's own speed uses the same rule as a
        // peak's (ResponseDynamics.speedFor): its dominant kernel's rise time,
        // relative to what is typical for its height. Peaks are normally
        // labelled from their rebuilt bump instead; this is the fallback.
        const speed = ResponseDynamics.speedFor(templateRise[bandIdx], height);
        return {
          clampedIndex: i,
          trueIndex: i,
          amplitude: amp,
          // Peak height of this atom's bump in signal units (summed over
          // bands) — comparable across bands, unlike `amplitude`.
          height,
          // Exact onset time and per-band coefficients, so the response's
          // own bump can be rebuilt from bandKernels (see
          // ResponseDynamics.riseTimeOf).
          onsetSec: dom ? dom.onsetSec : i / sampleRate,
          bandAmps: dom ? dom.bandAmps : null,
          bandIdx,
          durationScale: stretches[bandIdx],
          scaleFactor: speed.scaleFactor,
          speedLabel: speed.speedLabel,
        };
      })
      .filter(Boolean);

    return {
      driver,
      clean,
      tonic,
      mse,
      kernel: canonicalKernel,
      iterations: totalIterations,
      impulseLog,
      bandKernels,
      workRate,
      converged: !truncated,
      applyRescale: false,
    };
  },
};
