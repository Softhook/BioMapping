// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * Continuous derived-metric time series and summary statistics — extracted
 * from analyzer.js. Every function is pure: the relevant series (phasic,
 * tonic, peaks, raw) are passed in explicitly rather than read off `this`.
 * GSRAnalyzer keeps thin instance wrappers (`computeTemporalPeakDensity`,
 * `computePhasicAUC`, `computeCombinedArousalIndex`, `computeTriIndex`,
 * `getStats`) that pass `this.*` state through — `computePhasicAUC`'s
 * wrapper also owns setting `this.phasicAUCIsISCR` from this module's
 * returned flag, since that's a UI-label side effect this module doesn't
 * own.
 */
import { GSR_CONST } from '../core/constants.mjs';

export const AnalyzerStats = {
  /**
   * Error function, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
   * @private
   */
  _erf(x) {
    const sgn = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * a);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
        t +
        0.254829592) *
        t *
        Math.exp(-a * a);
    return sgn * y;
  },

  /**
   * Continuous Temporal Peak Density (Non-Specific SCR Frequency), in
   * peaks/minute, computed via 1D Gaussian Kernel Density Estimation (KDE)
   * where the kernel bandwidth (sigma) is scaled directly by the spotlight window width.
   *
   * Bandwidth defaults to sigma = windowSizeSec / 4 (e.g. 15 s for the default
   * 60 s window, encompassing 95.4% of the Gaussian mass within ±30 s).
   *
   * Evaluated efficiently in O(n + peakCount) via a two-pointer sliding window (±3.5 sigma).
   *
   * @param {Array<{time:number,val:number}>} phasic
   * @param {Array<object>} peaks - Detected peak objects (excluded ones are ignored).
   * @param {number|null} windowSizeSec - Spotlight time window in seconds (default: GSR_CONST.TEMPORAL_PEAK_DENSITY.windowSizeSec || 60)
   * @returns {Array<{time: number, val: number}>}
   */
  computeTemporalPeakDensity(phasic, peaks, windowSizeSec = null) {
    const n = phasic.length;
    if (n === 0) return [];

    const activePeakTimes = peaks.filter((p) => !p.excluded).map((p) => p.time);
    const m = activePeakTimes.length;

    // Fast path: no active peaks -> return zero-density series directly
    if (m === 0) {
      const emptyDensity = new Array(n);
      for (let i = 0; i < n; i++) {
        emptyDensity[i] = { time: phasic[i].time, val: 0 };
      }
      return emptyDensity;
    }

    const dCfg = GSR_CONST.TEMPORAL_PEAK_DENSITY;
    const winSec =
      windowSizeSec != null && windowSizeSec > 0
        ? windowSizeSec
        : dCfg.windowSizeSec;
    const sigmaRatio = dCfg.sigmaRatio;
    const sigma = winSec * sigmaRatio;
    const cutoffMult = dCfg.cutoffMultiplier;
    const scaleFactor = dCfg.scaleToPerMinute;

    const invTwoSigmaSq = 1.0 / (2.0 * sigma * sigma);
    const maxDist = cutoffMult * sigma;
    const normFactor = scaleFactor / (Math.sqrt(2.0 * Math.PI) * sigma);

    const density = new Array(n);
    let lo = 0,
      hi = 0;
    // Edge correction: near the start/end part of each kernel falls outside
    // the recording, where no peak could have been observed, so the raw sum
    // under-reads by up to half. Divide by the kernel mass that lies inside
    // [tFirst, tLast] (renormalisation / reflection-free boundary correction).
    const tFirst = phasic[0].time;
    const tLast = phasic[n - 1].time;
    // Standard normal CDF.
    const normCdf = (z) => 0.5 * (1 + AnalyzerStats._erf(z / Math.SQRT2));

    for (let i = 0; i < n; i++) {
      const t = phasic[i].time;
      const inside =
        normCdf((tLast - t) / sigma) - normCdf((tFirst - t) / sigma);
      const tStart = t - maxDist;
      const tEnd = t + maxDist;

      while (lo < m && activePeakTimes[lo] < tStart) lo++;
      while (hi < m && activePeakTimes[hi] <= tEnd) hi++;

      let kernelSum = 0;
      for (let j = lo; j < hi; j++) {
        const dt = t - activePeakTimes[j];
        kernelSum += Math.exp(-(dt * dt) * invTwoSigmaSq);
      }

      density[i] = {
        time: t,
        val: (kernelSum * normFactor) / Math.max(0.5, inside),
      };
    }
    return density;
  },

  /**
   * Sliding-window phasic integral, in µS·s.
   *
   * Source depends on the run:
   *  - Deconvolution / cvxEDA mode (wasDeconv, phasicDriver populated):
   *    integrates the non-negative phasic DRIVER — Benedek & Kaernbach's (2010)
   *    Integrated Skin Conductance Response (ISCR). The driver is the
   *    superposition-free impulse train (nonnegative deconvolution / convex
   *    solve against the bi-exponential SCR kernel), so this is the genuine
   *    published quantity.
   *  - Otherwise: integrates the tonic-subtracted phasic RESPONSE. No
   *    deconvolution, so overlapping SCRs and their decay tails are not
   *    separated — an ISCR-*inspired* metric that softens but doesn't solve the
   *    "superposition problem" / amplitude-threshold cliff-edge
   *    (docs/environmental_stress_literature_review.md §5B/§5D).
   *
   * Returns `isISCR` alongside the series so the caller can set its own
   * `phasicAUCIsISCR` flag (drives the UI label) — this module doesn't own
   * analyzer instance state.
   *
   * Uses a *centred* window (±windowSizeSec/2), matching
   * computeTemporalPeakDensity's convention, so the two continuous metrics
   * stay time-aligned with each other — a single spike is smeared
   * symmetrically around its own timestamp in both series rather than
   * appearing to "start" at the spike in one and being centred on it in
   * the other.
   *
   * @param {Array<{time:number,val:number}>} phasic
   * @param {number} sampleRate
   * @param {boolean} wasDeconv - Whether the last analyze() ran a deconvolution mode.
   * @param {Array<{time:number,val:number}>|null} phasicDriver - Non-negative driver series, when available.
   * @param {number} windowSizeSec - Temporal window width in seconds (default: 30)
   * @returns {{series: Array<{time:number,val:number}>, isISCR: boolean}}
   */
  computePhasicAUC(
    phasic,
    sampleRate,
    wasDeconv,
    phasicDriver,
    windowSizeSec = 30,
  ) {
    const n = phasic.length;
    if (n === 0) {
      return { series: [], isISCR: false };
    }

    // True ISCR integrates the deconvolved driver; fall back to the phasic
    // response when no driver is available (non-deconvolution runs).
    const useDriver =
      !!wasDeconv && Array.isArray(phasicDriver) && phasicDriver.length === n;
    const src = useDriver ? phasicDriver : phasic;

    const auc = new Array(n);
    const halfWin = windowSizeSec / 2;

    let lo = 0,
      hi = 0;
    let runningSum = 0;

    for (let i = 0; i < n; i++) {
      const t = src[i].time;
      const tStart = t - halfWin;
      const tEnd = t + halfWin;

      // Advance the trailing edge to include samples entering the window.
      // Re-clamp to ≥0 defensively: the phasic response is clamped during
      // decomposition and the driver is non-negative by construction, but the
      // cvxEDA driver can dip slightly negative at the active-set boundary.
      while (hi < n && src[hi].time <= tEnd) {
        runningSum += Math.max(0, src[hi].val);
        hi++;
      }
      // Advance the leading edge to drop samples that have fallen out of the window.
      while (lo < n && src[lo].time < tStart) {
        runningSum -= Math.max(0, src[lo].val);
        lo++;
      }

      // Edge correction: a centred window that runs off either end of the
      // recording only saw part of its span; scale up to the full window so
      // the first/last windowSizeSec/2 seconds don't read low by up to half.
      const covered =
        Math.min(tEnd, src[n - 1].time) - Math.max(tStart, src[0].time);
      const edgeScale =
        covered > 0 && covered < windowSizeSec
          ? windowSizeSec / Math.max(covered, windowSizeSec / 2)
          : 1;
      auc[i] = {
        time: t,
        val: (runningSum / sampleRate) * edgeScale, // time-integral (µS·s)
      };
    }
    return { series: auc, isISCR: useDriver };
  },

  /**
   * Combined Arousal Index — a weighted, per-participant z-scored blend of
   * tonic baseline (SCL) and phasic AUC. Phasic is weighted higher by
   * default to prioritise immediate environmental triggers over baseline
   * physiological tone (exertion, thermal load) — a direction consistent
   * with the general practice in spatial wearability studies (e.g. Shoval
   * et al. 2018; Zhang et al. 2022) of treating phasic reactivity as the
   * primary signal and tonic as a secondary baseline term.
   *
   * IMPORTANT: the specific 0.3/0.7 split is this project's own default, not
   * a value taken from those papers — a search of their published methods
   * did not turn up a specific numeric weighting to cite, and
   * docs/environmental_stress_literature_review.md §5C itself frames the
   * split as illustrative ("e.g."). Treat these defaults as a tunable
   * starting point, not an empirically-validated constant; if this matters
   * for your use case, consider validating a weighting against ground-truth
   * data (e.g. self-reported arousal) rather than assuming these values.
   *
   * @param {Array<{time:number,val:number}>} tonic
   * @param {Array<{time:number,val:number}>} phasic
   * @param {Array<{time:number,val:number}>} auc - Phasic AUC series (same length as phasic).
   * @param {number} wTonic - Weight for tonic SCL component (default: 0.3)
   * @param {number} wPhasic - Weight for phasic AUC component (default: 0.7)
   * @param {{first:number,last:number}|null} [range] - rows the mean/std are
   *   taken from (default: all); every row is still scored.
   */
  computeCombinedArousalIndex(
    tonic,
    phasic,
    auc,
    wTonic = 0.3,
    wPhasic = 0.7,
    range = null,
  ) {
    const n = phasic.length;
    if (n === 0) return [];
    const r0 = range ? range.first : 0;
    const r1 = range ? range.last + 1 : n;
    const m = r1 - r0;

    // §B perf fix: compute mean/std in a single pass over tonic and auc
    // directly, eliminating the two O(N) .map(d => d.val) intermediate arrays
    // that were previously allocated only to pass into GsrFilter.calculateStats().
    let tSum = 0,
      tSumSq = 0,
      aSum = 0,
      aSumSq = 0;
    for (let i = r0; i < r1; i++) {
      const tv = tonic[i].val;
      const av = auc[i].val;
      tSum += tv;
      tSumSq += tv * tv;
      aSum += av;
      aSumSq += av * av;
    }
    const tMean = tSum / m;
    // `|| 1`: a perfectly constant series would otherwise divide by zero.
    const tStd = Math.sqrt(Math.max(0, tSumSq / m - tMean * tMean)) || 1;
    const aMean = aSum / m;
    const aStd = Math.sqrt(Math.max(0, aSumSq / m - aMean * aMean)) || 1;

    const arousalIndex = new Array(n);
    for (let i = 0; i < n; i++) {
      const tZ = (tonic[i].val - tMean) / tStd;
      const aZ = (auc[i].val - aMean) / aStd;
      arousalIndex[i] = {
        time: phasic[i].time,
        val: wTonic * tZ + wPhasic * aZ,
      };
    }
    return arousalIndex;
  },

  /**
   * Tri Index — a weighted, per-participant z-scored blend of tonic baseline
   * (SCL), phasic AUC (ISCR), and temporal peak density (NS-SCR frequency).
   *
   * The default weights (0.10 Tonic / 0.45 Phasic AUC / 0.45 Peak Density)
   * prioritise acute event volume and sympathetic burst frequency while
   * anchoring to baseline tone and mitigating slow thermal/sweat drift.
   *
   * @param {Array<{time:number,val:number}>} tonic
   * @param {Array<{time:number,val:number}>} phasic
   * @param {Array<{time:number,val:number}>} auc - Phasic AUC series.
   * @param {Array<{time:number,val:number}>} density - Temporal peak density series.
   * @param {number} wTonic - Weight for tonic SCL component (default: 0.10)
   * @param {number} wPhasic - Weight for phasic AUC component (default: 0.45)
   * @param {number} wDensity - Weight for temporal peak density component (default: 0.45)
   * @param {{first:number,last:number}|null} [range] - rows the mean/std are
   *   taken from (default: all); every row is still scored.
   * @returns {Array<{time: number, val: number}>}
   */
  computeTriIndex(
    tonic,
    phasic,
    auc,
    density,
    wTonic = 0.1,
    wPhasic = 0.45,
    wDensity = 0.45,
    range = null,
  ) {
    const n = phasic.length;
    if (n === 0) return [];
    const r0 = range ? range.first : 0;
    const r1 = range ? range.last + 1 : n;
    const m = r1 - r0;

    let tSum = 0,
      tSumSq = 0,
      aSum = 0,
      aSumSq = 0,
      dSum = 0,
      dSumSq = 0;
    for (let i = r0; i < r1; i++) {
      const tv = tonic[i].val;
      const av = auc[i].val;
      const dv = density[i].val;
      tSum += tv;
      tSumSq += tv * tv;
      aSum += av;
      aSumSq += av * av;
      dSum += dv;
      dSumSq += dv * dv;
    }
    const tMean = tSum / m;
    const tStd = Math.sqrt(Math.max(0, tSumSq / m - tMean * tMean)) || 1;
    const aMean = aSum / m;
    const aStd = Math.sqrt(Math.max(0, aSumSq / m - aMean * aMean)) || 1;
    const dMean = dSum / m;
    const dStd = Math.sqrt(Math.max(0, dSumSq / m - dMean * dMean)) || 1;

    const triIndex = new Array(n);
    for (let i = 0; i < n; i++) {
      const tZ = (tonic[i].val - tMean) / tStd;
      const aZ = (auc[i].val - aMean) / aStd;
      const dZ = (density[i].val - dMean) / dStd;
      triIndex[i] = {
        time: phasic[i].time,
        val: wTonic * tZ + wPhasic * aZ + wDensity * dZ,
      };
    }
    return triIndex;
  },

  /**
   * Track-level summary statistics.
   *
   * Leaves out the stretches where the sensor was disconnected (`offSpans`,
   * from gsr_disconnect_repair.mjs, row indices into `raw`): their readings
   * sit at the open-circuit floor, or on a straight-line repair, and are not
   * skin conductance. So the means use only connected rows, peaks inside a
   * stretch are not counted, and the peak rate is per connected minute.
   * Example: a 68 min walk whose first 36 min were disconnected reports its
   * peak rate over the remaining 32 min. If nothing is connected, the whole
   * track is used, so a flat file still reports its (floor) values.
   *
   * `duration` stays the full recording length; `connectedDuration` is the
   * part the rates are taken over.
   *
   * @param {Array<{time:number,val:number}>} raw
   * @param {Array<{time:number,val:number}>} tonic
   * @param {Array<object>} peaks
   * @param {Array<{time:number,val:number}>} phasicAUC
   * @param {Array<{startIdx:number,endIdx:number}>} [offSpans]
   */
  getStats(raw, tonic, peaks, phasicAUC, offSpans = []) {
    const n = raw.length;
    if (n === 0) {
      return {
        duration: 0,
        connectedDuration: 0,
        connectedSamples: 0,
        meanSCL: 0,
        peakCount: 0,
        peakFrequency: 0,
        meanPeakAmplitude: 0,
        meanPhasicAUC: 0,
      };
    }

    const duration = raw[n - 1].time - raw[0].time;

    let off = null;
    let offSec = 0;
    let offRows = 0;
    for (const sp of offSpans || []) {
      const s = Math.max(0, sp.startIdx);
      const e = Math.min(n - 1, sp.endIdx);
      if (e < s) continue;
      if (!off) off = new Uint8Array(n);
      for (let i = s; i <= e; i++) {
        if (!off[i]) {
          off[i] = 1;
          offRows++;
        }
      }
      offSec += raw[e].time - raw[s].time;
    }
    // Nothing connected: fall back to the whole track.
    if (off && offRows >= n) {
      off = null;
      offSec = 0;
      offRows = 0;
    }
    const isOn = (i) => !off?.[i];
    const connectedDuration = Math.max(0, duration - offSec);
    const connectedSamples = n - offRows;

    const meanOver = (series) => {
      let sum = 0;
      let count = 0;
      const len = Math.min(series.length, n);
      for (let i = 0; i < len; i++) {
        if (isOn(i)) {
          sum += series[i].val;
          count++;
        }
      }
      return count > 0 ? sum / count : 0;
    };

    const meanSCL = meanOver(tonic);

    const connectedMinutes = connectedDuration / 60.0;
    const activePeaks = peaks.filter((p) => !p.excluded && !off?.[p.index]);
    const peakCount = activePeaks.length;
    const peakFrequency =
      connectedMinutes > 0 ? peakCount / connectedMinutes : 0;

    const sumAmp = activePeaks.reduce((sum, p) => sum + p.amplitude, 0);
    const meanPeakAmplitude = peakCount > 0 ? sumAmp / peakCount : 0;

    // Mean of the sliding-window Phasic AUC series — a threshold-independent
    // companion to peakFrequency/meanPeakAmplitude (µS·s, 30s window).
    const meanPhasicAUC = meanOver(phasicAUC);

    return {
      duration: duration,
      connectedDuration: connectedDuration,
      connectedSamples: connectedSamples,
      meanSCL: meanSCL,
      peakCount: peakCount,
      peakFrequency: peakFrequency,
      meanPeakAmplitude: meanPeakAmplitude,
      meanPhasicAUC: meanPhasicAUC,
    };
  },
};
