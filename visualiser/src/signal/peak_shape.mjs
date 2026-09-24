// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * Peak shape measurement and quality/salience scoring — extracted from
 * analyzer.js. Every function is pure: signal arrays, indices and any
 * instance state (the filtered series, label lookups) are passed in
 * explicitly rather than read off `this`. GSRAnalyzer keeps thin instance
 * wrappers (`_findOnsetIndex`, `_computeNoiseFloor`, `_buildPeakObject`,
 * etc.) that pass the relevant `this.*` state through.
 */
import { GSR_CONST } from '../core/constants.mjs';

export const PeakShape = {
  /**
   * Walk back from apex `i` to the response onset — the nearest sample the
   * signal fell to before rising into the peak.
   *
   * `minDip` (default 0) sets what counts as "fell to". At 0 the walk stops at
   * the very first local minimum, however shallow — used by the trough-to-peak
   * and deconvolution detectors, where every sub-peak of a compound burst is
   * kept separately so each response's onset is its own nearest dip.
   *
   * At `minDip > 0` (the prominence detector passes `peakThreshold`) a local
   * minimum is only the onset once the signal has climbed back `minDip` above
   * it — a genuine partial recovery, the same bar prominence uses to call two
   * maxima distinct. Shallower notches (a multi-modal crest) are walked
   * through. This is only sound in the prominence detector, where such a
   * shallow notch never separates two kept peaks (it would fold them): in
   * trough-to-peak mode it would walk a stacked peak's onset back past the
   * preceding kept peak and double-count the shared rise.
   *
   * @param {number} [minDip=0] µS a backward climb must exceed to fix the onset.
   */
  findOnsetIndex(vals, i, maxOnsetSteps, minDip = 0) {
    let onsetIdx = i;
    let minIdx = i;
    let onsetSteps = 0;
    while (onsetIdx > 0 && vals[onsetIdx] > 0 && onsetSteps < maxOnsetSteps) {
      if (minDip <= 0) {
        // Standard trough-to-peak: stop at the first preceding local minimum, however shallow.
        if (onsetIdx < i && vals[onsetIdx] < vals[onsetIdx - 1]) break;
      } else if (onsetIdx < i && vals[onsetIdx] >= vals[minIdx] + minDip) {
        // Threshold-aware: the walk has climbed a full `minDip` back above the
        // lowest point it reached — that low point was a genuine partial
        // recovery, i.e. the onset. Shallower notches are walked through.
        break;
      }
      onsetIdx--;
      onsetSteps++;
      if (minDip > 0 && vals[onsetIdx] < vals[minIdx]) minIdx = onsetIdx;
    }
    return minDip > 0 ? minIdx : onsetIdx;
  },

  findRecoveryIndex(vals, i, onsetIdx, amplitude) {
    const halfDecayVal = vals[onsetIdx] + amplitude * 0.5;
    const n = vals.length;
    for (let j = i + 1; j < n; j++) {
      if (vals[j] <= halfDecayVal) return j;
      if (
        j < n - 1 &&
        vals[j] < vals[j + 1] &&
        vals[j] > halfDecayVal + GSR_CONST.PEAK_RECOVERY_BREAK
      )
        break;
    }
    return -1;
  },

  /**
   * @param {Array} filtered - The filtered series ({val} objects), for the
   *   noise-floor estimate — see computeNoiseFloor().
   */
  calculateShapeMetrics(
    vals,
    times,
    i,
    onsetIdx,
    recoveryIdx,
    noiseHalfWin,
    filtered,
  ) {
    const curr = vals[i];
    const amplitude = curr - vals[onsetIdx];
    const riseTime = times[i] - times[onsetIdx];
    const onsetSlope = riseTime > 0 ? amplitude / riseTime : 0;
    const halfRecoveryTime =
      recoveryIdx !== -1 ? times[recoveryIdx] - times[i] : -1;
    const decaySlope =
      halfRecoveryTime > 0
        ? (vals[i] - vals[recoveryIdx]) / halfRecoveryTime
        : 0;
    const skewnessRatio =
      halfRecoveryTime > 0 ? riseTime / halfRecoveryTime : 0;

    const noiseFloor = PeakShape.computeNoiseFloor(
      filtered,
      onsetIdx,
      noiseHalfWin,
    );
    const snr = noiseFloor > 0 ? amplitude / noiseFloor : 0;

    return {
      amplitude,
      riseTime,
      onsetSlope,
      halfRecoveryTime,
      decaySlope,
      skewnessRatio,
      snr,
    };
  },

  /**
   * Local noise floor around an index, for SNR estimation, via the lag-1
   * difference (von Neumann) estimator: the standard deviation of successive
   * sample differences over a ±halfWindow window, divided by √2.
   *
   * This is trend-immune — a linear tonic ramp differences to a constant and
   * contributes nothing to the variance. That matters because on real
   * ambulatory recordings ~70–80% of SCR onsets sit on a tonic slope steeper
   * than the actual high-frequency noise in the same window; a plain
   * std-of-the-window estimate measures that slope rather than the noise,
   * deflating SNR and rejecting genuine peaks on any moving baseline. A
   * smooth SCR rise also has small successive differences, so this is far
   * less contaminated by the response's own shape than an absolute-deviation
   * estimate over the same samples.
   *
   * Uses the filtered signal (median+LPF, pre-decomposition), indexed
   * directly rather than mapped to a plain array first: this runs once per
   * candidate peak but only reads a small ±halfWindow slice, so a full-array
   * .map() here dominated analyse() time on long tracks (see the architecture
   * refactor plan's Phase 8 note).
   *
   * @param {Array} filtered - The filtered series ({val} objects).
   */
  computeNoiseFloor(filtered, idx, halfWindow) {
    const start = Math.max(1, idx - halfWindow);
    const end = Math.min(filtered.length - 1, idx + halfWindow);
    let sum = 0,
      sumSq = 0,
      count = 0;
    for (let j = start; j <= end; j++) {
      const d = filtered[j].val - filtered[j - 1].val;
      sum += d;
      sumSq += d * d;
      count++;
    }
    if (count < 2) return 1e-6;
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    // Floor at a tiny epsilon so an unusually clean segment can't drive SNR
    // to a divide-by-near-zero rejection of a genuine peak.
    return Math.max(1e-6, Math.sqrt(variance) / Math.SQRT2);
  },

  /**
   * Compute a quality score (0–1) for a detected peak from how well its
   * shape matches a canonical SCR.
   *
   * The score is the earned fraction of the *applicable* weight, not of the
   * full weight total. Recovery time, skewness and decay slope can only be
   * measured once the response has settled back toward baseline — when the
   * next SCR starts first (a peak in a cluster) or the recording ends,
   * findRecoveryIndex() returns -1 and those three are simply left out of
   * the denominator rather than scored zero. Otherwise a genuine response
   * that happens to sit inside a burst lost 0.40 of its possible score for a
   * reason that has nothing to do with whether it is a real response — the
   * exact peaks a high Min-Quality setting should keep, not cut.
   */
  computePeakQuality(peak) {
    const W = GSR_CONST.PEAK_SHAPE.QUALITY_WEIGHTS;
    let score = 0;
    let applicable = 0;

    // Amplitude — always measurable. Higher is better, saturates at 0.5 µS.
    applicable += W.amplitude;
    score += Math.min(1, peak.amplitude / 0.5) * W.amplitude;

    // Rise time — measurable whenever an onset was found. Ideal 0.5–3 s.
    if (peak.riseTime > 0) {
      applicable += W.riseTime;
      if (peak.riseTime >= 0.5 && peak.riseTime <= 3.0) score += W.riseTime;
      else if (peak.riseTime <= 5.0) score += W.riseTime * 0.5;
    }

    // Onset slope — measurable whenever positive. Steep but not too steep (µS/s).
    if (peak.onsetSlope > 0) {
      applicable += W.onsetSlope;
      if (peak.onsetSlope >= 0.01 && peak.onsetSlope <= 1.0)
        score += W.onsetSlope;
      else if (peak.onsetSlope <= 3.0) score += W.onsetSlope * 0.5;
    }

    // SNR — always measurable (noise floor is epsilon-floored).
    applicable += W.snr;
    if (peak.snr >= 3.0) score += W.snr;
    else if (peak.snr >= 2.0) score += W.snr * 0.7;
    else if (peak.snr >= 1.5) score += W.snr * 0.4;

    // Recovery-dependent trio — only when the response actually settled
    // (halfRecoveryTime > 0). Skipped, not zeroed, for clustered / end-of-
    // recording peaks.
    if (peak.halfRecoveryTime > 0) {
      applicable += W.recoveryTime + W.skewness + W.decaySlope;

      // Recovery time: ideal 0.5–4 s.
      if (peak.halfRecoveryTime >= 0.5 && peak.halfRecoveryTime <= 4.0)
        score += W.recoveryTime;
      else if (peak.halfRecoveryTime <= 8.0) score += W.recoveryTime * 0.5;

      // Skewness: classic SCR rises fast, recovers slow (ratio <= 1).
      if (peak.skewnessRatio > 0 && peak.skewnessRatio <= 1.0)
        score += W.skewness;
      else if (peak.skewnessRatio > 1.0 && peak.skewnessRatio <= 2.0)
        score += W.skewness * 0.6;
      else if (peak.skewnessRatio > 2.0 && peak.skewnessRatio <= 4.0)
        score += W.skewness * 0.3;

      // Decay slope: recovery limb must be going somewhere (µS/s).
      if (peak.decaySlope > 0.001) score += W.decaySlope;
    }

    if (applicable <= 0) return 0;
    return Math.min(1, Math.max(0, score / applicable));
  },

  /**
   * Quality score (0–1) for a deconvolution-mode peak.
   *
   * NOTE: this is deliberately a *different* formula from computePeakQuality(),
   * not a shared call with different inputs — reusing the shape-based formula
   * unchanged for deconvolution peaks was tried first and found to be wrong.
   *
   * Under the fixed-kernel SCRF model (Benedek & Kaernbach, 2010 — see the
   * SCRF class comment in constants.js), every deconvolution peak shares the
   * exact same riseTime, halfRecoveryTime and skewnessRatio by
   * construction: they're derived once from the kernel, not measured per
   * peak. Verified empirically on track 053: all 205 peaks have exactly one
   * distinct riseTime/halfRecoveryTime/skewnessRatio value between them,
   * vs. 17/30/many distinct values for the same fields in shape-based mode.
   * Likewise onsetSlope (= onsetSlopeUnit × amplitude) and decaySlope
   * (= amplitude × 0.5 / halfRecoveryTime) are pure linear rescalings of
   * amplitude in this mode, since onsetSlopeUnit and halfRecoveryTime are
   * themselves kernel constants — they carry no information beyond amplitude
   * itself here, unlike in shape-based mode where they're independently
   * measured from the noisy raw signal.
   *
   * Feeding computePeakQuality()'s weights unchanged into that reality gave
   * every peak an automatic ~45% of the total score (riseTime + recoveryTime
   * + skewness weights) regardless of size or genuineness, plus decaySlope's
   * near-zero pass bar (>0.001 µS/s) cleared by almost anything real — around
   * 55% of the composite score effectively free. Measured effect on track
   * 053: quality scores clustered at 0.66–0.98 (median 0.83) vs. shape mode's
   * 0.18–0.91 (median 0.56), and a peak sitting right at the amplitude
   * threshold (0.021 µS) still scored 0.808 — barely below a peak 56x larger
   * (0.950). minPeakQuality was consequently a no-op below ~0.6 in decon mode.
   *
   * This formula instead scores only the two quantities that are genuinely
   * independent per deconvolution peak: amplitude and SNR (local noise floor
   * varies per peak regardless of kernel shape). This also brings the scoring
   * closer to actual literature practice, not further from it — Ledalab's CDA
   * analysis (the standard implementation of this same fixed-kernel approach)
   * filters individual deconvolved SCRs by a minimum reconvolved amplitude
   * threshold alone (commonly 0.01–0.02 µS), not by re-scoring each impulse's
   * morphology, precisely because morphology isn't free to vary once the
   * kernel is fixed. Amplitude/SNR weights are rescaled from the shape-based
   * formula's own W.amplitude/W.snr ratio (not arbitrary new values) so the
   * two modes stay comparably calibrated where they overlap conceptually.
   */
  computeDeconPeakQuality(peak) {
    const W = GSR_CONST.PEAK_SHAPE.QUALITY_WEIGHTS;
    const totalW = W.amplitude + W.snr;
    const ampWeight = totalW > 0 ? W.amplitude / totalW : 0.5;
    const snrWeight = totalW > 0 ? W.snr / totalW : 0.5;

    // Amplitude: higher is better, saturate at 0.5 µS (same convention as
    // the shape-based formula).
    const ampScore = Math.min(1, peak.amplitude / 0.5);

    // SNR: same graduated breakpoints as the shape-based formula's SNR bucket.
    let snrScore = 0;
    if (peak.snr >= 3.0) snrScore = 1.0;
    else if (peak.snr >= 2.0) snrScore = 0.7;
    else if (peak.snr >= 1.5) snrScore = 0.4;

    const score = ampScore * ampWeight + snrScore * snrWeight;
    return Math.min(1, Math.max(0, score));
  },

  /**
   * "Memorability" / salience score (0–1) for a peak — a genuinely different
   * question from qualityScore. Quality asks "how confident are we this is a
   * real SCR, as opposed to noise"; salience asks "if it is real, how likely
   * is a person to actually notice/remember this moment" — fast, high-
   * amplitude responses read as salient regardless of how textbook-shaped
   * their recovery curve is.
   *
   * This exists as a separate metric rather than folding "memorable" into
   * the existing peak list, because they answer separate questions that
   * don't share one correct granularity. The discrete peak count (analyzer's
   * this.peaks) is trying to be an honest census of distinct SCR events — how
   * many separate things happened — a question the earlier chain-merge
   * consolidation bug (see peak_detectors.js's detectPeaksFromCurve() doc
   * comment) actively hurt. Phasic AUC (computePhasicAUC) is a continuous,
   * 30s-windowed measure of total phasic activation, already fairly robust to
   * exactly how many discrete atoms happened to compose a burst, since it
   * integrates the reconstructed signal directly rather than iterating peaks.
   * Salience adds a third view: one score per already-correctly-separated
   * peak, so the standout moments can be picked out from the full census
   * without confusing "how many events happened" with "which ones were
   * memorable."
   *
   * Blends Amplitude (50%), Steepest Rise / Onset Slope (30%), and Local Contrast / SNR (20%).
   * - Amplitude measures total response magnitude (saturating at 0.5 µS).
   * - Onset slope (amplitude / riseTime) measures response suddenness (saturating at 0.5 µS/s).
   * - SNR (contrast against local background noise) suppresses duplicate follow-up peaks in a cluster (saturating at SNR = 3.0).
   */
  computeSalienceScore(peak) {
    const ampScore = Math.min(1, Math.max(0, peak.amplitude / 0.5));
    const slope =
      peak.onsetSlope != null
        ? peak.onsetSlope
        : peak.riseTime > 0
          ? peak.amplitude / peak.riseTime
          : 0;
    const slopeScore = Math.min(1, Math.max(0, slope / 0.5));
    const snrScore =
      peak.snr != null ? Math.min(1, Math.max(0, peak.snr / 3.0)) : 0.5;
    return Math.min(
      1,
      Math.max(0, ampScore * 0.5 + slopeScore * 0.3 + snrScore * 0.2),
    );
  },

  /**
   * Construct a peak object from shape metrics, resolving labels from the
   * in-memory store and imported CSV data. The exclusion flag here is only the
   * index-matched carry-over; the analyzer then applies its time-keyed
   * exclusion store (GSRAnalyzer._assignExclusionsToPeaks).
   *
   * @param {number}  i                     - Sample index of the peak apex.
   * @param {number}  currVal               - Signal value at the apex.
   * @param {Array}   vals                  - Signal values array (phasic or reconstructed).
   * @param {Array}   times                 - Timestamps parallel to vals.
   * @param {object}  shape                 - Pre-computed shape metrics:
   *   { amplitude, onsetIdx, recoveryIdx, halfRecoveryTime, riseTime,
   *     onsetSlope, decaySlope, skewnessRatio, snr }
   * @param {Map}     oldLabels             - Index→label map from pre-analysis peaks.
   * @param {Set}     oldExcluded           - Index set of excluded pre-analysis peaks.
   * @param {object}  labelCtx
   *   { getMatchingLabel(time): string, importedPeakLabels: Map|null }
   *   — the analyzer's label-lookup state.
   * @returns {object} Peak object (qualityScore and salienceScore NOT yet set).
   */
  buildPeakObject(
    i,
    currVal,
    vals,
    times,
    shape,
    oldLabels,
    oldExcluded,
    labelCtx,
  ) {
    const {
      amplitude,
      onsetIdx,
      recoveryIdx,
      halfRecoveryTime,
      riseTime,
      onsetSlope,
      decaySlope,
      skewnessRatio,
      snr,
    } = shape;
    return {
      index: i,
      time: times[i],
      value: currVal,
      amplitude,
      onsetIndex: onsetIdx,
      onsetTime: times[onsetIdx],
      onsetValue: vals[onsetIdx],
      recoveryIndex: recoveryIdx,
      halfRecoveryTime,
      riseTime,
      onsetSlope,
      decaySlope,
      skewnessRatio,
      snr,
      label:
        oldLabels.get(i) ||
        labelCtx.getMatchingLabel(times[i]) ||
        (labelCtx.importedPeakLabels
          ? labelCtx.importedPeakLabels.get(times[i])
          : '') ||
        '',
      excluded: oldExcluded.has(i),
    };
  },
};
