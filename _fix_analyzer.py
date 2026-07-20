import re

with open('gsr-map-analyzer/analyzer.js', 'r') as f:
    content = f.read()

old_sig = '_runDeconvolutionPipeline(phasicVals, params)'
end_marker = '  _buildDisplayCache()'

start_idx = content.find(old_sig)
if start_idx == -1:
    print('ERROR: old sig not found')
    exit(1)

end_idx = content.find(end_marker, start_idx)
if end_idx == -1:
    print('ERROR: end marker not found')
    exit(1)

jsdoc_start = content.rfind('  /**', 0, start_idx)
if jsdoc_start == -1 or jsdoc_start < start_idx - 500:
    print('ERROR: jsdoc not found')
    exit(1)

new_method = '''  /**
   * SCR Deconvolution Pipeline (Benedek & Kaernbach, 2010).
   *
   *   1. Deconvolve phasic -> neural driver via bidirectional NNLS.
   *   2. Detect discrete impulses in the sparse driver.
   *   3. Build peak objects directly from driver impulses, with shape
   *      metrics derived from the SCRF kernel.
   *   4. Reconstruct clean phasic for graph display.
   *
   * @param {Array<number>} phasicVals - Raw phasic values (clamped >= 0).
   * @param {object} params - Analysis parameters.
   * @private
   */
  _runDeconvolutionPipeline(phasicVals, params) {
    const n = phasicVals.length;
    if (n === 0) return;

    const scf = GSR_CONST.SCRF;
    const phasicArr = new Float64Array(phasicVals);
    const times = this.phasic.map(d => d.time);

    const result = SCRDeconvolution.deconvolve(phasicArr, this.sampleRate, {
      tauSlow: scf.tauSlow, tauFast: scf.tauFast,
      maxIter: scf.maxIter, lr: scf.lr, convTol: scf.convTol
    });

    this.phasicDriver = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicDriver[i] = { time: times[i], val: result.driver[i] };
    }

    this.phasicDriverPeaks = SCRDeconvolution.detectImpulses(
      result.driver, this.sampleRate, scf.impulseThreshold, scf.minImpulseGapSec
    );

    // Derive SCRF kernel shape metrics for peak objects
    const kernel = result.kernel;
    const kLen = kernel.length;
    const dt = 1.0 / this.sampleRate;
    let kPeakIdx = 0;
    for (let i = 0; i < kLen; i++) {
      if (kernel[i] > kernel[kPeakIdx]) kPeakIdx = i;
    }
    const kernelRiseTime = kPeakIdx * dt;
    let kHalfIdx = kPeakIdx;
    for (let i = kPeakIdx; i < kLen; i++) {
      if (kernel[i] <= 0.5) { kHalfIdx = i; break; }
    }
    const kernelHalfRecovery = (kHalfIdx - kPeakIdx) * dt;
    let kOnsetSlope = 0;
    for (let i = 1; i <= kPeakIdx; i++) {
      const s = (kernel[i] - kernel[i - 1]) / dt;
      if (s > kOnsetSlope) kOnsetSlope = s;
    }
    const kernelSkewRatio = kernelHalfRecovery > 0 ? kernelRiseTime / kernelHalfRecovery : 0;
    let kFwhmStart = 0, kFwhmEnd = 0;
    for (let i = 0; i <= kPeakIdx; i++) {
      if (kernel[i] >= 0.5) { kFwhmStart = i; break; }
    }
    for (let i = kPeakIdx; i < kLen; i++) {
      if (kernel[i] <= 0.5) { kFwhmEnd = i; break; }
    }
    const kernelFwhm = (kFwhmEnd - kFwhmStart) * dt;

    const filteredVals = this.filtered.map(d => d.val);
    const noiseHalfWin = Math.max(1, Math.round(this.sampleRate));
    const minQuality = params.minPeakQuality != null ? params.minPeakQuality : 0.0;

    this.peaks = [];
    for (const imp of this.phasicDriverPeaks) {
      const ns = Math.max(0, imp.index - noiseHalfWin);
      const ne = Math.min(n - 1, imp.index + noiseHalfWin);
      let nSum = 0, nCount = 0;
      for (let j = ns; j <= ne; j++) { nSum += filteredVals[j]; nCount++; }
      const nMean = nSum / nCount;
      let nSq = 0;
      for (let j = ns; j <= ne; j++) { nSq += (filteredVals[j] - nMean) ** 2; }
      const noiseFloor = Math.sqrt(nSq / nCount);
      const snr = noiseFloor > 0 ? imp.amplitude / noiseFloor : 0;

      const peak = {
        index: imp.index,
        time: imp.index * dt,
        value: imp.amplitude,
        amplitude: imp.amplitude,
        onsetIndex: Math.max(0, imp.index - Math.round(kernelRiseTime * this.sampleRate)),
        onsetTime: Math.max(0, imp.index * dt - kernelRiseTime),
        onsetValue: 0,
        recoveryIndex: Math.min(n - 1, imp.index + Math.round(kernelHalfRecovery * this.sampleRate)),
        halfRecoveryTime: kernelHalfRecovery,
        riseTime: kernelRiseTime,
        onsetSlope: kOnsetSlope * imp.amplitude,
        decaySlope: kernelHalfRecovery > 0 ? imp.amplitude * 0.5 / kernelHalfRecovery : 0,
        skewnessRatio: kernelSkewRatio,
        fwhm: kernelFwhm,
        snr: snr,
        qualityScore: this._computeDeconvPeakQuality(imp.amplitude, snr),
        label: '',
        excluded: false
      };

      if (peak.qualityScore >= minQuality) {
        this.peaks.push(peak);
      }
    }

    // Reconstruct clean phasic for graph display
    const cleanVals = SCRDeconvolution.reconstructPhasic(this.phasicDriverPeaks, n, kernel);
    this._phasicOrig = this.phasic;
    this.phasicClean = new Array(n);
    this.phasic = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicClean[i] = { time: times[i], val: cleanVals[i] };
      this.phasic[i] = { time: times[i], val: cleanVals[i] };
    }
    this.phasicZ = GsrFilter.standardizeSignal(this.phasic);
    this.phasicStd = GsrFilter.calculateStats(cleanVals).std;
  },

  /**
   * Quality score for a deconvolution-derived peak (0-1).
   * Uses amplitude and SNR; shape is guaranteed by the SCRF kernel.
   * @private
   */
  _computeDeconvPeakQuality(amplitude, snr) {
    const W = GSR_CONST.PEAK_SHAPE.QUALITY_WEIGHTS;
    let score = 0;
    score += Math.min(1, amplitude / 0.5) * W.amplitude;
    score += W.riseTime + W.recoveryTime + W.skewness + W.onsetSlope + W.decaySlope;
    if (snr >= 3.0) score += W.snr;
    else if (snr >= 2.0) score += W.snr * 0.7;
    else if (snr >= 1.5) score += W.snr * 0.4;
    return Math.min(1, Math.max(0, score));
  },

  /**
   * Pre-compute global Y-ranges and timeline glyph data so draw() doesn't'''

content = content[:jsdoc_start] + new_method + content[end_idx:]
with open('gsr-map-analyzer/analyzer.js', 'w') as f:
    f.write(content)
print('OK')
