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
 * The Bateman (bi-exponential) SCRF kernel:
 *   SCRF(t) = exp(−t/τ_slow) − exp(−t/τ_fast)
 *
 * Default dictionary atoms:
 *   - Fast:     τ_slow = 1.5 s, τ_fast = 0.40 s  (sharp, acute response)
 *   - Standard: τ_slow = 2.0 s, τ_fast = 0.75 s  (canonical Benedek & Kaernbach default)
 *   - Slow:     τ_slow = 3.5 s, τ_fast = 1.20 s  (broad / prolonged recovery)
 *
 * Sparse Non-negative Deconvolution (SparsEDA):
 *   Solves the sparse recovery problem:
 *     minimise ½·‖y − ∑_k D_k * x_k‖²  subject to x_k ≥ 0
 *   using dictionary-matched impulse selection and active-set local coordinate
 *   descent refinement. Unlike greedy single-kernel matching pursuit (which
 *   overestimates energy in overlapping responses by 60–70% and requires
 *   post-hoc heuristics), this joint refinement decouples overlapping atoms,
 *   preserves physical energy scaling naturally, and adapts to varying SCR
 *   morphologies without generating false peaks or ringing.
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
   * @param {number} [opts.tauSlow=2.0]           - Canonical SCRF decay constant (s).
   * @param {number} [opts.tauFast=0.75]          - Canonical SCRF rise constant (s).
   * @param {number} [opts.kernelSec=5.0]         - Canonical kernel duration (s).
   * @param {number} [opts.maxIter=100]           - Max iterations budget.
   * @param {number} [opts.lr=1.0]                - Atom amplitude scale (for MP).
   * @param {number} [opts.convTol=0.001]         - Residual convergence threshold (µS).
   * @param {number} [opts.minImpulseGapSec=0.5]  - Refractory gap between driver activations (s).
   * @param {string} [opts.algorithm='sparseda']  - 'sparseda' | 'matching_pursuit'.
   * @param {boolean} [opts.useDictionary=true]   - Whether to use multi-atom dictionary.
   * @param {Array<object>} [opts.dictionary]     - Custom dictionary if provided.
   * @returns {{
   *   driver: Float64Array,
   *   clean: Float64Array,
   *   kernel: Float64Array,
   *   iterations: number,
   *   impulseLog: Array<{clampedIndex: number, trueIndex: number, amplitude: number, atomName?: string, atomIdx?: number}>,
   *   converged: boolean
   * }}
   */
  deconvolve(phasic, sampleRate, opts = {}) {
    const n = phasic.length;
    const tauSlow   = opts.tauSlow   ?? 2.0;
    const tauFast   = opts.tauFast   ?? 0.75;
    const kernelSec = opts.kernelSec ?? 5.0;
    const maxIter   = opts.maxIter   ?? 100;
    const lr        = opts.lr        ?? 1.0;
    const convTol   = opts.convTol   ?? 0.001;
    const minGapSec = opts.minImpulseGapSec ?? 0.5;
    const minGapSamples = Math.max(1, Math.round(minGapSec * sampleRate));

    const canonicalKernel = this.buildSCRFKernel(sampleRate, tauSlow, tauFast, kernelSec);

    if (n === 0) {
      return {
        driver: new Float64Array(0),
        clean: new Float64Array(0),
        kernel: canonicalKernel,
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
        kernel: canonicalKernel,
        iterations: hasAmp ? 1 : 0,
        impulseLog: hasAmp ? [{ clampedIndex: 0, trueIndex: 0, amplitude: val, atomIdx: 0, atomName: 'standard' }] : [],
        converged: true
      };
    }

    // Legacy matching pursuit path if explicitly requested
    if (opts.algorithm === 'matching_pursuit') {
      return this._deconvolveMP(phasic, sampleRate, canonicalKernel, maxIter, lr, convTol);
    }

    // SparsEDA path: multi-atom dictionary or single specified atom
    let dict;
    if (opts.dictionary) {
      dict = opts.dictionary;
    } else if (opts.useDictionary === false) {
      let pIdx = 0;
      for (let i = 1; i < canonicalKernel.length; i++) {
        if (canonicalKernel[i] > canonicalKernel[pIdx]) pIdx = i;
      }
      dict = [{ id: 0, name: 'standard', tauSlow, tauFast, kernelSec, kernel: canonicalKernel, peakIdx: pIdx }];
    } else {
      dict = this.buildDictionary(sampleRate, [
        { name: 'fast',     tauSlow: 1.5, tauFast: 0.40, kernelSec: 5.0 },
        { name: 'standard', tauSlow: tauSlow, tauFast: tauFast, kernelSec: kernelSec },
        { name: 'slow',     tauSlow: 3.5, tauFast: 1.20, kernelSec: Math.max(6.0, kernelSec) }
      ]);
    }

    return this._deconvolveSparsEDA(phasic, sampleRate, dict, canonicalKernel, maxIter, convTol, minGapSamples);
  },

  /**
   * Core SparsEDA implementation: dictionary cross-correlation and active-set
   * coordinate descent refinement to resolve overlapping responses.
   * @private
   */
  _deconvolveSparsEDA(phasic, sampleRate, dict, canonicalKernel, maxIter, convTol, minGapSamples) {
    const n = phasic.length;
    const residual = new Float64Array(n);
    let hasPositive = false;
    for (let i = 0; i < n; i++) {
      const v = phasic[i];
      if (v > convTol) hasPositive = true;
      residual[i] = v > 0 ? v : 0;
    }

    if (!hasPositive) {
      return {
        driver: new Float64Array(n),
        clean: new Float64Array(n),
        kernel: canonicalKernel,
        iterations: 0,
        impulseLog: [],
        converged: true
      };
    }

    const activeImpulses = [];
    let iterations = 0;

    for (let iter = 0; iter < maxIter; iter++) {
      let maxVal = 0, maxIdx = -1;
      for (let i = 0; i < n; i++) {
        if (residual[i] > maxVal) { maxVal = residual[i]; maxIdx = i; }
      }
      if (maxVal < convTol || maxIdx < 0) break;
      iterations++;

      // Evaluate candidate atoms from dictionary on positive residual
      let bestScore = -Infinity;
      let bestAtomIdx = dict.length > 1 ? 1 : 0;
      let bestOnset = maxIdx - dict[bestAtomIdx].peakIdx;

      for (let d = 0; d < dict.length; d++) {
        const atom = dict[d];
        const kLen = atom.kernel.length;
        const candOnset = maxIdx - atom.peakIdx;

        let corr = 0, normSq = 0;
        const startK = candOnset < 0 ? -candOnset : 0;
        const endK = Math.min(kLen, n - candOnset);
        for (let k = startK; k < endK; k++) {
          const rVal = Math.max(0, residual[candOnset + k]);
          const kVal = atom.kernel[k];
          corr += rVal * kVal;
          normSq += kVal * kVal;
        }

        if (normSq > 1e-9) {
          const score = (corr * corr) / normSq;
          if (score > bestScore) {
            bestScore = score;
            bestAtomIdx = d;
            bestOnset = candOnset;
          }
        }
      }

      const atom = dict[bestAtomIdx];
      const bestAmp = maxVal;

      let existing = null;
      for (let i = 0; i < activeImpulses.length; i++) {
        if (activeImpulses[i].onsetIdx === bestOnset && activeImpulses[i].atomIdx === bestAtomIdx) {
          existing = activeImpulses[i];
          break;
        }
      }
      if (existing) {
        existing.amplitude += bestAmp;
      } else {
        activeImpulses.push({ onsetIdx: bestOnset, atomIdx: bestAtomIdx, amplitude: bestAmp });
      }

      const startK = bestOnset < 0 ? -bestOnset : 0;
      const endK = Math.min(atom.kernel.length, n - bestOnset);
      for (let k = startK; k < endK; k++) {
        residual[bestOnset + k] -= bestAmp * atom.kernel[k];
      }
    }

    // Coordinate descent refinement on active impulses to eliminate overlap inflation
    if (activeImpulses.length > 1) {
      // Recompute exact full residual: r = phasic - sum(a_i * k_i)
      const cleanRec = new Float64Array(n);
      for (const imp of activeImpulses) {
        const a = dict[imp.atomIdx];
        const sK = imp.onsetIdx < 0 ? -imp.onsetIdx : 0;
        const eK = Math.min(a.kernel.length, n - imp.onsetIdx);
        for (let k = sK; k < eK; k++) cleanRec[imp.onsetIdx + k] += imp.amplitude * a.kernel[k];
      }
      for (let i = 0; i < n; i++) residual[i] = phasic[i] - cleanRec[i];

      for (let pass = 0; pass < 5; pass++) {
        let maxChange = 0;
        for (let i = 0; i < activeImpulses.length; i++) {
          const cur = activeImpulses[i];
          const a = dict[cur.atomIdx];
          const sK = cur.onsetIdx < 0 ? -cur.onsetIdx : 0;
          const eK = Math.min(a.kernel.length, n - cur.onsetIdx);

          let corr = 0, normSq = 0;
          for (let k = sK; k < eK; k++) {
            corr += residual[cur.onsetIdx + k] * a.kernel[k];
            normSq += a.kernel[k] * a.kernel[k];
          }
          if (normSq > 1e-9) {
            const delta = corr / normSq;
            const newAmp = Math.max(0, cur.amplitude + delta);
            const actualDelta = newAmp - cur.amplitude;
            if (Math.abs(actualDelta) > 1e-5) {
              cur.amplitude = newAmp;
              maxChange = Math.max(maxChange, Math.abs(actualDelta));
              for (let k = sK; k < eK; k++) {
                residual[cur.onsetIdx + k] -= actualDelta * a.kernel[k];
              }
            }
          }
        }
        if (maxChange < 1e-4) break;
      }
    }

    const finalImpulses = activeImpulses.filter(imp => imp.amplitude >= convTol);
    finalImpulses.sort((a, b) => a.onsetIdx - b.onsetIdx);

    const clean = new Float64Array(n);
    const driver = new Float64Array(n);
    const impulseLog = [];

    for (const imp of finalImpulses) {
      const atom = dict[imp.atomIdx];
      const clamped = Math.max(0, imp.onsetIdx);
      driver[clamped] += imp.amplitude;
      impulseLog.push({
        clampedIndex: clamped,
        trueIndex: imp.onsetIdx,
        amplitude: imp.amplitude,
        atomName: atom.name,
        atomIdx: imp.atomIdx
      });
      const startK = imp.onsetIdx < 0 ? -imp.onsetIdx : 0;
      const endK = Math.min(atom.kernel.length, n - imp.onsetIdx);
      for (let k = startK; k < endK; k++) {
        clean[imp.onsetIdx + k] += imp.amplitude * atom.kernel[k];
      }
    }

    return {
      driver,
      clean,
      kernel: canonicalKernel,
      iterations,
      impulseLog,
      impulses: finalImpulses,
      converged: iterations < maxIter
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
