/**
 * Matching pursuit deconvolution of the phasic skin conductance signal
 * against one canonical bi-exponential SCRF kernel (Benedek & Kaernbach
 * 2010 kernel shape). The default algorithm for the Deconvolution detector
 * (GSR_DEFAULT.deconvAlgorithm).
 *
 * Entry point: SCRDeconvolution.deconvolve() with algorithm 'matching_pursuit'.
 */

export const MatchingPursuit = {
  /**
   * Greedy single-kernel deconvolution. Returns the driver and impulse log;
   * SCRDeconvolution.deconvolve() rebuilds the clean phasic from the log.
   *
   * @param {Float64Array|Array<number>} phasic - Tonic-subtracted phasic signal.
   * @param {Float64Array} kernel - Peak-normalised SCRF kernel.
   * @param {number} maxIter - Maximum number of impulses to place.
   * @param {number} lr - Amplitude scale per placed impulse.
   * @param {number} convTol - Stop once the residual peak falls below this (µS).
   */
  deconvolve(phasic, kernel, maxIter, lr, convTol) {
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
      let maxVal = 0,
        maxIdx = -1;
      for (let i = 0; i < n; i++) {
        if (residual[i] > maxVal) {
          maxVal = residual[i];
          maxIdx = i;
        }
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
      impulseLog.push({
        clampedIndex: clampedImpIdx,
        trueIndex: impIdx,
        amplitude,
      });

      // Subtract kernel contribution from residual (handling negative impIdx correctly)
      const startJ = Math.max(0, impIdx);
      const startK = startJ - impIdx;
      const endJ = Math.min(n, impIdx + kLen);
      for (let j = startJ, k = startK; j < endJ; j++, k++) {
        residual[j] -= amplitude * kernel[k];
        if (residual[j] < 0) residual[j] = 0;
      }
    }

    return {
      driver,
      iterations,
      impulseLog,
      converged: iterations < maxIter,
    };
  },
};
