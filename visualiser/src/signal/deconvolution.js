/**
 * SCR Deconvolution & SparsEDA — Sparse Nonnegative Deconvolution of the
 * phasic skin conductance signal against a dictionary of canonical
 * bi-exponential SCRF (Skin Conductance Response Function) kernels.
 *
 * References:
 *   1. Hernando-Gallego, F., Luengo, D., & Artés-Rodríguez, A. (2018).
 *      Feature Extraction of Galvanic Skin Responses by Nonnegative Sparse
 *      Deconvolution. IEEE Journal of Biomedical and Health Informatics.
 *   2. Benedek, M., & Kaernbach, C. (2010). A continuous measure of phasic
 *      electrodermal activity. Journal of Neuroscience Methods, 190(1), 80–91.
 *   3. Greco, A., Valenza, G., Lanata, A., Scilingo, E. P., & Citi, L. (2016).
 *      cvxEDA: A Convex Optimization Approach to Electrodermal Activity Processing.
 *
 * Sparse Non-negative Deconvolution (SparsEDA):
 *   This module's `algorithm: 'sparseda'` path is a direct JS port of the
 *   official reference implementation (`fhernandogallego/sparsEDA`): the same
 *   70 s overlap-save windows, 5-scale SCR dictionary, 6-column tonic basis,
 *   non-negative LARS/LASSO inner solver, and the same post-processing
 *   (`dmin` spacing + `rho` relative-amplitude threshold). The legacy
 *   `matching_pursuit` path is retained separately for backward compatibility.
 */

const SCRDeconvolution = {

  /**
   * Default multi-kernel dictionary configurations.
   */
  DEFAULT_DICTIONARY_CONFIGS: [
    { name: 'fast',     tauSlow: 1.5, tauFast: 0.40, kernelSec: 5.0 },
    { name: 'standard', tauSlow: 2.0, tauFast: 0.75, kernelSec: 5.0 },
    { name: 'slow',     tauSlow: 3.5, tauFast: 1.20, kernelSec: 6.0 }
  ],

  /**
   * Build an overcomplete physiological dictionary of SCRF kernels.
   *
   * @param {number} sampleRate - Sampling rate in Hz.
   * @param {Array<object>} [configs] - Array of { name, tauSlow, tauFast, kernelSec }.
   * @returns {Array<object>} Array of atom descriptors with normalised kernels and peak indices.
   */
  buildDictionary(sampleRate, configs = this.DEFAULT_DICTIONARY_CONFIGS) {
    const dict = [];
    for (let i = 0; i < configs.length; i++) {
      const cfg = configs[i];
      const kernel = this.buildSCRFKernel(sampleRate, cfg.tauSlow, cfg.tauFast, cfg.kernelSec || 5.0);
      let peakIdx = 0;
      for (let j = 1; j < kernel.length; j++) {
        if (kernel[j] > kernel[peakIdx]) peakIdx = j;
      }
      dict.push({
        id: i,
        name: cfg.name || `atom_${i}`,
        tauSlow: cfg.tauSlow,
        tauFast: cfg.tauFast,
        kernelSec: cfg.kernelSec || 5.0,
        kernel: kernel,
        peakIdx: peakIdx
      });
    }
    return dict;
  },

  /**
   * Build the canonical bi-exponential SCRF kernel sampled at the given rate.
   *
   * @param {number} sampleRate - Sampling rate in Hz (e.g. 10).
   * @param {number} tauSlow    - Decay time constant in seconds (default 2.0).
   * @param {number} tauFast    - Rise time constant in seconds (default 0.75).
   * @param {number} kernelSec  - Kernel duration in seconds (default 5.0).
   * @returns {Float64Array} Normalised kernel (peak = 1.0).
   */
  buildSCRFKernel(sampleRate, tauSlow = 2.0, tauFast = 0.75, kernelSec = 5.0) {
    const dt = 1.0 / sampleRate;
    const len = Math.ceil(kernelSec * sampleRate);
    const kernel = new Float64Array(len);

    let peakVal = 0;
    for (let i = 0; i < len; i++) {
      const t = i * dt;
      // SCRF(t) = exp(-t/τ_slow) - exp(-t/τ_fast)
      kernel[i] = Math.exp(-t / tauSlow) - Math.exp(-t / tauFast);
      if (kernel[i] > peakVal) peakVal = kernel[i];
    }

    // Normalise so the kernel peaks at 1.0 — preserves amplitude scaling
    // when the driver amplitude represents the true SCR amplitude.
    if (peakVal > 0) {
      for (let i = 0; i < len; i++) kernel[i] /= peakVal;
    }

    return kernel;
  },

  /**
   * Convolve a driver signal with the SCRF kernel (causal, FIR).
   *
   * @param {Float64Array|Array<number>} driver - Input driver impulses.
   * @param {Float64Array} kernel              - Pre-built SCRF kernel.
   * @returns {Float64Array} Convolved (predicted phasic) signal, same length as driver.
   */
  convolve(driver, kernel) {
    const n = driver.length;
    const kLen = kernel.length;
    const out = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      let sum = 0;
      const maxJ = Math.min(kLen, i + 1);
      for (let j = 0; j < maxJ; j++) {
        sum += driver[i - j] * kernel[j];
      }
      out[i] = sum;
    }
    return out;
  },

  _norm2(vec, start = 0, end = vec.length) {
    let sum = 0;
    for (let i = start; i < end; i++) sum += vec[i] * vec[i];
    return Math.sqrt(sum);
  },

  _dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
  },

  _solveUpperTriangular(U, b, transpose = false) {
    const n = b.length;
    const x = new Float64Array(n);
    if (transpose) {
      for (let i = 0; i < n; i++) {
        let sum = b[i];
        for (let k = 0; k < i; k++) sum -= U[k][i] * x[k];
        x[i] = sum / U[i][i];
      }
      return x;
    }
    for (let i = n - 1; i >= 0; i--) {
      let sum = b[i];
      for (let k = i + 1; k < n; k++) sum -= U[i][k] * x[k];
      x[i] = sum / U[i][i];
    }
    return x;
  },

  _updateChol(RI, columns, activeSet, newIndex, zeroTol) {
    const newVec = columns[newIndex];
    if (activeSet.length === 0) {
      return { RI: [Float64Array.from([Math.sqrt(this._dot(newVec, newVec))])], flag: 0 };
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
    const next = new Array(m + 1);
    for (let r = 0; r < m; r++) {
      const row = new Float64Array(m + 1);
      row.set(RI[r], 0);
      row[m] = p[r];
      next[r] = row;
    }
    const last = new Float64Array(m + 1);
    last[m] = Math.sqrt(q);
    next[m] = last;
    return { RI: next, flag: 0 };
  },

  _buildReferenceDictionary(sampleRate, tauSlow = 2.0, tauFast = 0.5, kernelSec = 10.0) {
    const durationR = 70;
    const Lreg = Math.round(20 * sampleRate * 3);
    const N = Math.round(durationR * sampleRate);
    const T = 6;
    const columns = new Array(T + 5 * Lreg);
    const bandKernels = [];
    const srFactors = [0.5, 0.75, 1.0, 1.25, 1.5];

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
    columns[0] = c0;
    columns[1] = c1;
    columns[2] = c2;
    columns[3] = c3;
    columns[4] = c4;
    columns[5] = c5;

    return { columns, Lreg, N, T, bandKernels };
  },

  _linearResampleTo(signal, sampleRate, targetRate) {
    if (sampleRate === targetRate) {
      return { values: Float64Array.from(signal), outputLength: signal.length, rate: sampleRate };
    }
    const outputLength = Math.max(1, Math.round(targetRate * signal.length / sampleRate));
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
    if (signal.length === targetLength && inputRate === targetRate) return Float64Array.from(signal);
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
    if (signal.length === targetLength && inputRate === targetRate) return Float64Array.from(signal);
    const out = new Float64Array(targetLength);
    const scale = targetRate / inputRate;
    for (let i = 0; i < signal.length; i++) {
      const amp = signal[i];
      if (amp <= 0) continue;
      const idx = Math.max(0, Math.min(targetLength - 1, Math.round(i * scale)));
      out[idx] += amp;
    }
    return out;
  },

  _runReferenceLasso(columns, s, sampleRate, maxIter, epsilon) {
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
    if (lambda < 0) throw new Error('y is not expressible as a non-negative linear combination of the dictionary');

    let newIndices = [];
    for (let j = 0; j < W; j++) if (Math.abs(c[j] - lambda) < zeroTol) newIndices.push(j);
    const collinear = new Set();
    const activeSet = [];
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
        activationHist.push(idx);
      }
    }

    const res = Float64Array.from(s);
    let done = false;
    while (!done) {
      if (activationHist.length === 4) {
        lambda = -Infinity;
        newIndices = [];
        for (let j = 0; j < W; j++) if (c[j] > lambda) lambda = c[j];
        for (let j = 0; j < W; j++) if (Math.abs(c[j] - lambda) < zeroTol) newIndices.push(j);
        activeSet.length = 0;
        RI = null;
        for (const idx of newIndices) {
          iterations++;
          const updated = this._updateChol(RI, columns, activeSet, idx, zeroTol);
          RI = updated.RI;
          if (updated.flag) collinear.add(idx);
          else activeSet.push(idx);
        }
        activationHist.push(...activeSet);
      } else {
        lambda = c[activeSet[0]];
      }

      const activeSigns = new Float64Array(activeSet.length);
      for (let i = 0; i < activeSet.length; i++) activeSigns[i] = Math.sign(c[activeSet[i]]);
      const z = this._solveUpperTriangular(RI, activeSigns, true);
      const dxActive = this._solveUpperTriangular(RI, z, false);
      const dx = new Float64Array(W);
      for (let i = 0; i < activeSet.length; i++) dx[activeSet[i]] = dxActive[i];

      const v = new Float64Array(s.length);
      for (let i = 0; i < activeSet.length; i++) {
        const coeff = dxActive[i];
        if (coeff === 0) continue;
        const col = columns[activeSet[i]];
        for (let r = 0; r < s.length; r++) v[r] += coeff * col[r];
      }

      const ATv = new Float64Array(W);
      for (let j = 0; j < W; j++) ATv[j] = this._dot(columns[j], v);

      let gammaIc = 1;
      newIndices = [];
      {
        let best = Infinity;
        const denomEps = 1e-12;
        for (let j = 0; j < W; j++) {
          if (activeSet.includes(j) || collinear.has(j)) continue;
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

      const gammaMin = gammaIc;
      for (let j = 0; j < W; j++) x[j] += gammaMin * dx[j];
      for (let i = 0; i < res.length; i++) res[i] -= gammaMin * v[i];
      for (let j = 0; j < W; j++) c[j] -= gammaMin * ATv[j];

      if ((lambda - gammaMin) < optTol || (lambdaStop > 0 && lambda <= lambdaStop) || (epsilon > 0 && this._norm2(res) <= epsilon)) {
        newIndices = [];
        done = true;
      }
      if (this._norm2(res, 0, Math.min(res.length, Math.round(sampleRate * 20))) <= resStop2) done = true;

      for (const idx of newIndices) {
        iterations++;
        const updated = this._updateChol(RI, columns, activeSet, idx, zeroTol);
        RI = updated.RI;
        if (updated.flag) {
          collinear.add(idx);
        } else {
          activeSet.push(idx);
          activationHist.push(idx);
        }
      }
      if (iterations >= maxIter) done = true;

      let hasNegative = false;
      for (let j = 0; j < W; j++) {
        if (x[j] < 0) { hasNegative = true; break; }
      }
      if (hasNegative) {
        x.set(xOld);
        done = true;
      } else {
        xOld.set(x);
      }
    }

    return { beta: x, iterations, activationHist, lambda, residual: res };
  },

  /**
   * Sparse Nonnegative Deconvolution (SparsEDA) / Matching Pursuit.
   *
   * Deconvolves the phasic skin-conductance signal into a sparse non-negative
   * driver. By default, utilizes a multi-atom dictionary with active-set local
   * refinement (SparsEDA) to prevent the overestimation of overlapping responses
   * and resolve variable SCR morphologies.
   *
   * @param {Float64Array|Array<number>} phasic   - Tonic-subtracted phasic (≥ 0).
   * @param {number} sampleRate                   - Sampling rate in Hz.
   * @param {object} [opts]                       - Optional overrides.
   * @param {number} [opts.tauSlow=2.0]           - SCRF decay constant (MP, or SparsEDA when explicitly overridden).
   * @param {number} [opts.tauFast]               - SCRF rise constant (0.75 for MP defaults, 0.5 for SparsEDA defaults).
   * @param {number} [opts.kernelSec]             - Kernel duration (5 s for MP defaults, 10 s for SparsEDA defaults).
   * @param {number} [opts.maxIter=100]           - Max iterations budget (MP) or Kmax (SparsEDA).
   * @param {number} [opts.lr=1.0]                - Atom amplitude scale (for MP).
   * @param {number} [opts.convTol=0.001]         - Residual convergence threshold (µS, MP).
   * @param {number} [opts.minImpulseGapSec=0.5]  - Refractory gap between driver activations (s, MP).
   * @param {number} [opts.epsilon=1.0]           - Residual stop threshold (official SparsEDA).
   * @param {number} [opts.dminSec=1.25]          - Minimum spacing between kept driver events (official SparsEDA).
   * @param {number} [opts.rho=0.025]             - Relative post-pruning threshold (official SparsEDA).
   * @param {string} [opts.algorithm='sparseda']  - 'sparseda' | 'matching_pursuit'.
   * @returns {{
   *   driver: Float64Array,
   *   clean: Float64Array,
   *   tonic?: Float64Array,
   *   kernel: Float64Array,
   *   iterations: number,
   *   impulseLog: Array<{clampedIndex: number, trueIndex: number, amplitude: number, atomName?: string, atomIdx?: number}>,
   *   converged: boolean,
   *   applyRescale?: boolean
   * }}
   */
  deconvolve(phasic, sampleRate, opts = {}) {
    const n = phasic.length;
    const maxIter   = opts.maxIter   ?? 100;
    const lr        = opts.lr        ?? 1.0;
    const convTol   = opts.convTol   ?? 0.001;
    const minGapSec = opts.minImpulseGapSec ?? 0.5;
    const epsilon = opts.epsilon ?? 1.0;
    const dminSec = opts.dminSec ?? 1.25;
    const rho = opts.rho ?? 0.025;

    if (n === 0) {
      return {
        driver: new Float64Array(0),
        clean: new Float64Array(0),
        kernel: new Float64Array(0),
        iterations: 0,
        impulseLog: [],
        converged: true
      };
    }

    if (n === 1) {
      const driver = new Float64Array(1);
      const clean = new Float64Array(1);
      const val = phasic[0];
      const hasAmp = val > convTol;
      if (hasAmp) {
        driver[0] = val;
        clean[0] = val;
      }
      return {
        driver,
        clean,
        kernel: this.buildSCRFKernel(sampleRate, 2.0, 0.75, 5.0),
        iterations: hasAmp ? 1 : 0,
        impulseLog: hasAmp ? [{ clampedIndex: 0, trueIndex: 0, amplitude: val, atomIdx: 0, atomName: 'standard' }] : [],
        converged: true
      };
    }

    // Legacy matching pursuit path if explicitly requested
    if (opts.algorithm === 'matching_pursuit') {
      const tauSlow   = opts.tauSlow   ?? 2.0;
      const tauFast   = opts.tauFast   ?? 0.75;
      const kernelSec = opts.kernelSec ?? 5.0;
      const canonicalKernel = this.buildSCRFKernel(sampleRate, tauSlow, tauFast, kernelSec);
      return this._deconvolveMP(phasic, sampleRate, canonicalKernel, maxIter, lr, convTol);
    }

    const tauSlow   = opts.tauSlow   ?? 2.0;
    const tauFast   = opts.tauFast   ?? 0.5;
    const kernelSec = opts.kernelSec ?? 10.0;
    const referenceKernel = this.buildSCRFKernel(sampleRate, tauSlow, tauFast, kernelSec);
    return this._deconvolveSparsEDA(phasic, sampleRate, referenceKernel, maxIter, epsilon, dminSec, rho, tauSlow, tauFast, kernelSec);
  },

  /**
   * Core SparsEDA implementation: port of the official reference solver.
   * @private
   */
  _deconvolveSparsEDA(phasic, sampleRate, canonicalKernel, maxIter, epsilon, dminSec, rho, tauSlow = 2.0, tauFast = 0.5, kernelSec = 10.0) {
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
        applyRescale: false
      };
    }

    let hasPositive = false;
    for (let i = 0; i < n; i++) {
      if (phasic[i] > 0) { hasPositive = true; break; }
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
        applyRescale: false
      };
    }

    const targetRate = 8;
    const resampled = this._linearResampleTo(phasic, sampleRate, targetRate);
    const workSignal = resampled.values;
    const workRate = resampled.rate;

    const padStart = Math.round(20 * workRate);
    const padEnd = Math.round(60 * workRate);
    const signalAdd = new Float64Array(workSignal.length + padStart + padEnd);
    for (let i = 0; i < padStart; i++) signalAdd[i] = workSignal[0];
    signalAdd.set(workSignal, padStart);
    for (let i = 0; i < padEnd; i++) signalAdd[padStart + workSignal.length + i] = workSignal[workSignal.length - 1];

    const pointerS = padStart;
    const pointerE = pointerS + workSignal.length;
    const { columns, Lreg, N, T, bandKernels } = this._buildReferenceDictionary(workRate, tauSlow, tauFast, kernelSec);
    const Ns = signalAdd.length;
    const sclAux = new Float64Array(Ns);
    const driverAux = new Float64Array(Ns);
    const bandAux = Array.from({ length: 5 }, () => new Float64Array(Ns));
    const resAux = new Float64Array(Ns);
    let cutS = 0;
    let cutE = N;
    let b0 = 0;
    let totalIterations = 0;
    let truncated = false;

    const processWindow = (start, copyLen) => {
      const signalCut = new Float64Array(N);
      const available = Math.min(N, Ns - start);
      signalCut.set(signalAdd.subarray(start, start + available), 0);
      const fill = available > 0 ? signalCut[available - 1] : (start > 0 ? signalAdd[start - 1] : signalAdd[0]);
      for (let i = available; i < N; i++) signalCut[i] = fill;
      if (b0 === 0) b0 = signalCut[0];

      const centered = new Float64Array(signalCut.length);
      for (let i = 0; i < signalCut.length; i++) centered[i] = signalCut[i] - b0;
      const lasso = this._runReferenceLasso(columns, centered, workRate, maxIter, epsilon);
      totalIterations += lasso.iterations;
      if (lasso.iterations >= maxIter) truncated = true;
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
      let res2 = 0, res3 = 0;
      for (let i = Math.round(20 * workRate); i < Math.round(40 * workRate); i++) res2 += remAout[i];
      for (let i = Math.round(40 * workRate); i < Math.round(60 * workRate); i++) res3 += remAout[i];

      let jump = 1;
      if (res2 < 1) {
        jump = 2;
        if (res3 < 1) jump = 3;
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
      const bandChunks = Array.from({ length: 5 }, () => new Float64Array(Lreg));
      for (let offset = 0; offset < Lreg; offset++) {
        let sum = 0;
        for (let band = 0; band < 5; band++) {
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
      b0 = nextB0;

      driverAux.set(driverChunk.subarray(0, chunkLen), start);
      sclAux.set(scl.subarray(0, chunkLen), start);
      for (let band = 0; band < 5; band++) bandAux[band].set(bandChunks[band].subarray(0, chunkLen), start);
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
    const bandWorkRaw = bandAux.map(arr => arr.slice(pointerS, pointerE));
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
        if (Math.abs(idx - prev) < minGapSamples) { farEnough = false; break; }
      }
      if (farEnough) kept.push(idx);
    }

    const driverWork = new Float64Array(driverWorkRaw.length);
    let maxKept = 0;
    for (const idx of kept) {
      driverWork[idx] = driverWorkRaw[idx];
      if (driverWork[idx] > maxKept) maxKept = driverWork[idx];
    }
    const threshold = rho * maxKept;
    if (threshold > 0) {
      for (let i = 0; i < driverWork.length; i++) {
        if (driverWork[i] < threshold) driverWork[i] = 0;
      }
    }

    const cleanWork = new Float64Array(driverWork.length);
    for (let idx = 0; idx < driverWork.length; idx++) {
      if (driverWork[idx] <= 0) continue;
      for (let band = 0; band < 5; band++) {
        const amp = bandWorkRaw[band][idx];
        if (amp <= 0) continue;
        const kernel = bandKernels[band];
        const limit = Math.min(kernel.length, cleanWork.length - idx);
        for (let k = 0; k < limit; k++) cleanWork[idx + k] += amp * kernel[k];
      }
    }

    const driver = this._resampleSparseDriverBack(driverWork, workRate, n, sampleRate);
    const clean = this._linearResampleBack(cleanWork, workRate, n, sampleRate);
    const tonic = this._linearResampleBack(tonicWork, workRate, n, sampleRate);
    const mse = this._linearResampleBack(mseWork, workRate, n, sampleRate);
    const impulseLog = Array.from(driver).map((amp, i) => amp > 0 ? {
      clampedIndex: i,
      trueIndex: i,
      amplitude: amp
    } : null).filter(Boolean);

    return {
      driver,
      clean,
      tonic,
      mse,
      kernel: canonicalKernel,
      iterations: totalIterations,
      impulseLog,
      converged: !truncated,
      applyRescale: false
    };
  },

  /**
   * Legacy Matching Pursuit implementation (retained for backward compatibility).
   * @private
   */
  _deconvolveMP(phasic, sampleRate, kernel, maxIter, lr, convTol) {
    const n = phasic.length;
    const kLen = kernel.length;
    let kPeakIdx = 0;
    for (let i = 0; i < kLen; i++) {
      if (kernel[i] > kernel[kPeakIdx]) kPeakIdx = i;
    }

    const residual = new Float64Array(n);
    for (let i = 0; i < n; i++) residual[i] = Math.max(0, phasic[i]);

    const driver = new Float64Array(n);
    const impulseLog = [];
    let iterations = 0;

    for (let iter = 0; iter < maxIter; iter++) {
      // Find global maximum of residual
      let maxVal = 0, maxIdx = -1;
      for (let i = 0; i < n; i++) {
        if (residual[i] > maxVal) { maxVal = residual[i]; maxIdx = i; }
      }

      if (maxVal < convTol || maxIdx < 0) break;
      iterations++;

      // Place impulse so kernel peak aligns with the residual maximum.
      // kernel peak is at index kPeakIdx relative to impulse start, so
      // impulse index = maxIdx - kPeakIdx.
      const impIdx = maxIdx - kPeakIdx;
      // Amplitude = residual peak value. Because kernel[kPeakIdx] == 1.0 (normalised),
      // this explains the residual at maxIdx.
      const amplitude = maxVal * lr;

      // Clamp into the driver at index 0 rather than discarding when the true
      // onset would fall before the recording started (impIdx < 0).
      const clampedImpIdx = Math.max(0, impIdx);
      driver[clampedImpIdx] += amplitude;
      impulseLog.push({ clampedIndex: clampedImpIdx, trueIndex: impIdx, amplitude });

      // Subtract kernel contribution from residual (handling negative impIdx correctly)
      const startJ = Math.max(0, impIdx);
      const startK = startJ - impIdx;
      const endJ   = Math.min(n, impIdx + kLen);
      for (let j = startJ, k = startK; j < endJ; j++, k++) {
        residual[j] -= amplitude * kernel[k];
        if (residual[j] < 0) residual[j] = 0;
      }
    }

    const clean = this.reconstructPhasic(impulseLog.map(e => ({ index: e.trueIndex, amplitude: e.amplitude })), n, kernel);

    return { driver, clean, kernel, iterations, impulseLog, converged: iterations < maxIter };
  },

  /**
   * Detect discrete impulses in the driver signal by finding local maxima
   * above a threshold. The driver is already sparse and nonnegative.
   *
   * @param {Float64Array} driver        - Deconvolved driver signal.
   * @param {number} sampleRate          - Sampling rate in Hz.
   * @param {number} [threshold=0.005]   - Minimum driver amplitude for an impulse (µS).
   * @param {number} [minGapSec=0.5]     - Minimum gap between impulses (seconds).
   * @returns {Array<{index: number, time: number, amplitude: number}>}
   */
  detectImpulses(driver, sampleRate, threshold = 0.005, minGapSec = 0.5) {
    const n = driver.length;
    const minGapSamples = Math.max(1, Math.round(minGapSec * sampleRate));

    // Phase 1: collect every above-threshold local maximum, ignoring the
    // gap constraint entirely. Proper non-max suppression.
    const candidates = [];
    for (let i = 0; i < n; i++) {
      if (driver[i] <= threshold) continue;
      const isLocalMax = (i === 0 || driver[i] >= driver[i - 1]) &&
                          (i === n - 1 || driver[i] >= driver[i + 1]);
      if (isLocalMax) candidates.push({ index: i, time: i / sampleRate, amplitude: driver[i] });
    }

    // Phase 2: greedy NMS in descending amplitude order — the largest candidate always wins.
    candidates.sort((a, b) => b.amplitude - a.amplitude);
    const accepted = [];
    for (const c of candidates) {
      let tooClose = false;
      for (const a of accepted) {
        if (Math.abs(a.index - c.index) < minGapSamples) { tooClose = true; break; }
      }
      if (!tooClose) accepted.push(c);
    }

    accepted.sort((a, b) => a.index - b.index);
    return accepted;
  },

  /**
   * Reconstruct a clean phasic signal from detected driver impulses by
   * convolving each impulse individually with its SCRF kernel and summing.
   *
   * @param {Array<{index?: number, onsetIdx?: number, amplitude: number, kernel?: Float64Array}>} impulses
   * @param {number} n             - Total signal length (samples).
   * @param {Float64Array} kernel  - Pre-built fallback SCRF kernel.
   * @returns {Float64Array} Clean reconstructed phasic signal.
   */
  reconstructPhasic(impulses, n, kernel) {
    const clean = new Float64Array(n);
    if (!impulses || impulses.length === 0) return clean;

    for (const imp of impulses) {
      const k = imp.kernel || kernel;
      if (!k) continue;
      const kLen = k.length;
      const amp = imp.amplitude;
      const start = imp.index !== undefined ? imp.index : (imp.onsetIdx !== undefined ? imp.onsetIdx : 0);
      const startJ = Math.max(0, start);
      const startK = startJ - start;
      const end = Math.min(n, start + kLen);
      for (let j = startJ, ki = startK; j < end; j++, ki++) {
        clean[j] += amp * k[ki];
      }
    }

    return clean;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SCRDeconvolution;
}
if (typeof window !== 'undefined') {
  window.SCRDeconvolution = SCRDeconvolution;
}
