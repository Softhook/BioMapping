/**
 * SCR Deconvolution — splits the phasic skin conductance signal into a sparse
 * non-negative driver convolved with a bi-exponential SCRF (Skin Conductance
 * Response Function) kernel.
 *
 * This file holds what the methods share (the kernel, convolution, impulse
 * detection and phasic reconstruction) and deconvolve(), the single entry
 * point that picks the method:
 *   - 'matching_pursuit' (the default for the Deconvolution detector,
 *     GSR_DEFAULT.deconvAlgorithm) — matching_pursuit.mjs
 *   - 'sparseda' — sparseda.mjs, a port of the reference SparsEDA solver
 * cvxEDA is a separate detector with its own entry point (cvxeda.mjs).
 *
 * References:
 *   1. Hernando-Gallego, F., Luengo, D., & Artés-Rodríguez, A. (2018).
 *      Feature Extraction of Galvanic Skin Responses by Nonnegative Sparse
 *      Deconvolution. IEEE Journal of Biomedical and Health Informatics.
 *   2. Benedek, M., & Kaernbach, C. (2010). A continuous measure of phasic
 *      electrodermal activity. Journal of Neuroscience Methods, 190(1), 80–91.
 */

import { MatchingPursuit } from './matching_pursuit.mjs';
import { SparsEDA } from './sparseda.mjs';

export const SCRDeconvolution = {
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

  /**
   * Sparse Nonnegative Deconvolution (SparsEDA) / Matching Pursuit.
   *
   * Deconvolves the phasic skin-conductance signal into a sparse non-negative
   * driver. By default, utilizes a multi-atom dictionary with active-set local
   * refinement (SparsEDA) to prevent the overestimation of overlapping responses
   * and resolve variable SCR morphologies.
   *
   * @param {Float64Array|Array<number>} phasic   - Input signal: tonic-subtracted
   *                                                phasic (≥ 0) for matching
   *                                                pursuit, or the full filtered
   *                                                skin-conductance signal for
   *                                                SparsEDA's joint tonic solve.
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
    const strictReference = opts.strictReference || false;

    const maxIter = opts.maxIter ?? (strictReference ? 40 : 120);
    const lr = opts.lr ?? 1.0;
    const convTol = opts.convTol ?? 0.001;
    const _minGapSec = opts.minImpulseGapSec ?? 0.5;
    const epsilon = opts.epsilon ?? 1.0;
    const dminSec = opts.dminSec ?? (strictReference ? 1.25 : 0.25);
    const rho = opts.rho ?? (strictReference ? 0.025 : 0.0);
    const algorithm =
      opts.algorithm === 'matching_pursuit' ? 'matching_pursuit' : 'sparseda';

    if (n === 0) {
      return {
        driver: new Float64Array(0),
        clean: new Float64Array(0),
        kernel: new Float64Array(0),
        iterations: 0,
        impulseLog: [],
        converged: true,
      };
    }

    if (algorithm === 'matching_pursuit') {
      const tauSlow = opts.tauSlow ?? 2.0;
      const tauFast = opts.tauFast ?? 0.75;
      const kernelSec = opts.kernelSec ?? 5.0;
      const canonicalKernel = this.buildSCRFKernel(
        sampleRate,
        tauSlow,
        tauFast,
        kernelSec,
      );
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
          kernel: canonicalKernel,
          iterations: hasAmp ? 1 : 0,
          impulseLog: hasAmp
            ? [
                {
                  clampedIndex: 0,
                  trueIndex: 0,
                  amplitude: val,
                  atomIdx: 0,
                  atomName: 'standard',
                },
              ]
            : [],
          converged: true,
        };
      }
      const mp = MatchingPursuit.deconvolve(
        phasic,
        canonicalKernel,
        maxIter,
        lr,
        convTol,
      );
      return {
        driver: mp.driver,
        clean: this.reconstructPhasic(
          mp.impulseLog.map((e) => ({
            index: e.trueIndex,
            amplitude: e.amplitude,
          })),
          n,
          canonicalKernel,
        ),
        kernel: canonicalKernel,
        iterations: mp.iterations,
        impulseLog: mp.impulseLog,
        converged: mp.converged,
      };
    }

    const tauSlow = opts.tauSlow ?? 2.0;
    const tauFast = opts.tauFast ?? 0.5;
    const kernelSec = opts.kernelSec ?? 10.0;
    const referenceKernel = this.buildSCRFKernel(
      sampleRate,
      tauSlow,
      tauFast,
      kernelSec,
    );
    if (n === 1) {
      const driver = new Float64Array(1);
      const clean = new Float64Array(1);
      const tonic = new Float64Array(1);
      tonic[0] = phasic[0];
      return {
        driver,
        clean,
        tonic,
        kernel: referenceKernel,
        iterations: 0,
        impulseLog: [],
        converged: true,
        applyRescale: false,
      };
    }

    return SparsEDA.deconvolve(
      phasic,
      sampleRate,
      referenceKernel,
      maxIter,
      epsilon,
      dminSec,
      rho,
      tauSlow,
      tauFast,
      kernelSec,
      opts.strictReference || false,
      opts.zeroBaseline || false,
      opts.stretches ?? SparsEDA.REFERENCE_STRETCHES,
    );
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
      const isLocalMax =
        (i === 0 || driver[i] >= driver[i - 1]) &&
        (i === n - 1 || driver[i] >= driver[i + 1]);
      if (isLocalMax)
        candidates.push({
          index: i,
          time: i / sampleRate,
          amplitude: driver[i],
        });
    }

    // Phase 2: greedy NMS in descending amplitude order — the largest candidate always wins.
    candidates.sort((a, b) => b.amplitude - a.amplitude);
    const accepted = [];
    for (const c of candidates) {
      let tooClose = false;
      for (const a of accepted) {
        if (Math.abs(a.index - c.index) < minGapSamples) {
          tooClose = true;
          break;
        }
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
      const start =
        imp.index !== undefined
          ? imp.index
          : imp.onsetIdx !== undefined
            ? imp.onsetIdx
            : 0;
      const startJ = Math.max(0, start);
      const startK = startJ - start;
      const end = Math.min(n, start + kLen);
      for (let j = startJ, ki = startK; j < end; j++, ki++) {
        clean[j] += amp * k[ki];
      }
    }

    return clean;
  },
};
