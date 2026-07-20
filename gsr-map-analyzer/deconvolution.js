/**
 * SCR Deconvolution — Benedek & Kaernbach (2010) nonnegative deconvolution
 * of the phasic skin conductance signal against a canonical bi-exponential
 * SCRF (Skin Conductance Response Function) kernel.
 *
 * Reference:
 *   Benedek, M., & Kaernbach, C. (2010). A continuous measure of phasic
 *   electrodermal activity. Journal of Neuroscience Methods, 190(1), 80–91.
 *   https://doi.org/10.1016/j.jneumeth.2010.04.028
 *
 * The Bateman (bi-exponential) SCRF kernel:
 *   SCRF(t) = exp(−t/τ_slow) − exp(−t/τ_fast)
 *
 * Default parameters (Benedek & Kaernbach, 2010, Table 1):
 *   τ_slow = 2.0 s  (decay time constant — conventionally τ₁ in the paper)
 *   τ_fast = 0.75 s (rise time constant — conventionally τ₂ in the paper)
 *
 * Algorithm: Matching Pursuit — greedy iterative atom selection against the
 * SCRF kernel dictionary.  At each iteration the global maximum of the
 * residual signal is found, an impulse is placed to explain it, and the
 * kernel contribution is subtracted.  This avoids the degenerate solutions
 * that gradient-descent NNLS falls into when the kernel tail is long.
 */

const SCRDeconvolution = {

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
   * Matching Pursuit deconvolution — greedily selects the kernel atom
   * that best explains the current residual at each iteration.
   *
   * At each step the global maximum of the residual is found, an impulse
   * is placed at the position that aligns the kernel peak with that maximum,
   * and the kernel contribution is subtracted from the residual.  This
   * guarantees impulses are placed wherever the phasic signal has energy,
   * regardless of position in the recording — no start/end bias.
   *
   * @param {Float64Array|Array<number>} phasic   - Tonic-subtracted phasic (≥ 0).
   * @param {number} sampleRate                   - Sampling rate in Hz.
   * @param {object} [opts]                       - Optional overrides.
   * @param {number} [opts.tauSlow=2.0]           - SCRF decay constant (s).
   * @param {number} [opts.tauFast=0.75]          - SCRF rise constant (s).
   * @param {number} [opts.maxIter=100]           - Max matching-pursuit iterations.
   * @param {number} [opts.lr=1.0]                - Atom amplitude scale (1.0 = full subtraction).
   * @param {number} [opts.convTol=0.001]         - Stop when residual max < this (µS).
   * @returns {{ driver: Float64Array, kernel: Float64Array, iterations: number }}
   */
  deconvolve(phasic, sampleRate, opts = {}) {
    const tauSlow = opts.tauSlow ?? 2.0;
    const tauFast = opts.tauFast ?? 0.75;
    const maxIter = opts.maxIter ?? 100;
    const lr      = opts.lr      ?? 1.0;   // atom scale (1.0 = subtract full atom)
    const convTol = opts.convTol ?? 0.001; // residual threshold in µS

    const n = phasic.length;
    const kernel = this.buildSCRFKernel(sampleRate, tauSlow, tauFast);
    const kLen = kernel.length;

    // Find kernel peak index
    let kPeakIdx = 0;
    for (let i = 0; i < kLen; i++) {
      if (kernel[i] > kernel[kPeakIdx]) kPeakIdx = i;
    }

    // Clamp input
    const residual = new Float64Array(n);
    for (let i = 0; i < n; i++) residual[i] = Math.max(0, phasic[i]);

    const driver = new Float64Array(n);
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
      const amplitude = maxVal * lr;  // kernel peak = 1.0, so A = residual peak

      // Only store the impulse in the driver if it falls within the signal boundaries
      if (impIdx >= 0) {
        driver[impIdx] += amplitude;
      }

      // Subtract kernel contribution from residual (handling negative impIdx correctly)
      const startJ = Math.max(0, impIdx);
      const startK = startJ - impIdx;
      const endJ = Math.min(n, impIdx + kLen);
      for (let j = startJ, k = startK; j < endJ; j++, k++) {
        residual[j] -= amplitude * kernel[k];
        if (residual[j] < 0) residual[j] = 0;
      }
    }

    return { driver, kernel, iterations };
  },

  /**
   * Detect discrete impulses in the driver signal by finding local maxima
   * above a threshold.  The driver is already sparse and nonnegative.
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
    const impulses = [];

    let i = 0;
    while (i < n) {
      // Find local maximum
      if (driver[i] <= threshold) { i++; continue; }

      // Walk forward to find the peak of this impulse cluster
      let peakIdx = i;
      let peakVal = driver[i];
      let j = i + 1;
      while (j < n && driver[j] > threshold) {
        if (driver[j] > peakVal) {
          peakVal = driver[j];
          peakIdx = j;
        }
        j++;
      }

      // A local maximum must be higher than its immediate neighbours
      const isLocalMax = (peakIdx === 0 || driver[peakIdx] >= driver[peakIdx - 1]) &&
                         (peakIdx === n - 1 || driver[peakIdx] >= driver[peakIdx + 1]);

      if (isLocalMax && peakVal > threshold) {
        impulses.push({
          index: peakIdx,
          time: peakIdx / sampleRate,
          amplitude: peakVal
        });
      }

      // Skip ahead by minGapSamples to avoid double-counting
      i = Math.max(j, peakIdx + minGapSamples);
    }

    return impulses;
  },

  /**
   * Reconstruct a clean phasic signal from detected driver impulses by
   * convolving each impulse individually with the SCRF kernel and summing.
   * This produces non-overlapping SCR waveforms where each impulse generates
   * its own clean, isolated SCR shape — resolving the superposition problem.
   *
   * @param {Array<{index: number, amplitude: number}>} impulses - Detected driver impulses.
   * @param {number} n             - Total signal length (samples).
   * @param {Float64Array} kernel  - Pre-built SCRF kernel.
   * @returns {Float64Array} Clean reconstructed phasic signal.
   */
  reconstructPhasic(impulses, n, kernel) {
    const clean = new Float64Array(n);
    const kLen = kernel.length;

    for (const imp of impulses) {
      const amp = imp.amplitude;
      const start = imp.index;
      const end = Math.min(n, start + kLen);
      for (let j = start, k = 0; j < end; j++, k++) {
        clean[j] += amp * kernel[k];
      }
    }

    return clean;
  }
};
