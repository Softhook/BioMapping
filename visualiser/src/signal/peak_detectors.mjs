// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * The three phasic-peak-detection algorithms — extracted from analyzer.js.
 * Pure functions: signal arrays and analyzer state (sampleRate, the filtered
 * series, label lookups) are passed in explicitly via a `ctx` object rather
 * than read off `this`. GSRAnalyzer keeps thin instance wrappers
 * (`_detectPeaksFullScan`, `_detectPeaksByProminence`, `_detectPeaksFromCurve`,
 * `_topographicProminence`, `_prominenceNMS`, `_buildPeakWithMetrics`) that
 * build the ctx from `this.*` and delegate here.
 *
 * `ctx` shape used throughout this module:
 *   {
 *     filtered: Array<{val}>,               // for noise-floor estimation
 *     getMatchingLabel(time): string,
 *     importedPeakLabels: Map|null,
 *     importedPeakExcluded: Set|null,
 *     topographicProminence?(vals): Float64Array,
 *       // injected so GSRAnalyzer's own _topographicProminence (stubbed by
 *       // tests to count sweeps) is what actually runs, not this module's
 *       // implementation directly.
 *   }
 */
import { GSR_CONST } from '../core/constants.mjs';
import { PeakShape } from './peak_shape.mjs';

export const PeakDetectors = {
  /**
   * Topographic prominence of every sample in `vals`, in O(n log n).
   *
   * Standard definition (matches SciPy's peak_prominences, which NeuroKit2's
   * default EDA peak detector gates on — cross-checked directly in
   * tests/manual/neurokit_compare/check_prominence_agreement.sh, exact match
   * on all sample tracks after the boundary correction below): a local
   * maximum's prominence is its height above the HIGHER of its two one-sided
   * bases — the lowest point reached scanning left, and separately right,
   * until either a taller point or the signal's edge is hit. This replaces
   * an earlier per-maximum left/right saddle walk that was O(n²) on a
   * monotonic input (every sample a local max, each walk O(n)).
   *
   * Method: activate samples in descending height order, tracking connected
   * runs with a union-find. Any already-active neighbour was activated at a
   * height ≥ this one, so when activating sample i merges two runs, the
   * current height vals[i] is a col between them; the shorter run's tallest
   * summit is now dominated and its prominence is (provisionally) fixed at
   * (its height − vals[i]).
   *
   * That provisional value is exactly right whenever both of the summit's
   * sides eventually meet a taller point — the merge col is the true base on
   * whichever side triggered it, and by construction no lower path exists.
   * It UNDERSTATES the true base (so overstates prominence) whenever at
   * least one side never finds a taller point before running off the array
   * edge: the sweep still eventually merges that summit into whatever
   * happens to be next door once the threshold drops far enough — often the
   * signal's baseline floor, arbitrarily lower than the true one-sided base a
   * bounded scan would have stopped at. The boundary-correction pass below
   * patches exactly those samples (found directly from prefix/suffix running
   * extrema, not by trusting which side the sweep merged from) up to
   * max(their own true one-sided floor, whatever the sweep found) — the
   * single global maximum (no taller point on either side) is the special
   * case of both sides needing this.
   *
   * @param {Array<number>|Float64Array} vals
   * @returns {Float64Array} prominence per index (callers only read indices
   *   they have already confirmed are local maxima).
   */
  topographicProminence(vals) {
    const n = vals.length;
    const prom = new Float64Array(n).fill(-1);
    if (n === 0) return prom;

    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const active = new Uint8Array(n);
    const compMax = new Float64Array(n); // tallest height in the run (valid at root)
    const compPeak = new Int32Array(n); // index of that tallest sample (valid at root)

    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };

    let vMin = Infinity;
    for (let i = 0; i < n; i++) if (vals[i] < vMin) vMin = vals[i];

    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => vals[b] - vals[a] || a - b);

    for (const i of order) {
      active[i] = 1;
      compMax[i] = vals[i];
      compPeak[i] = i;
      let ri = i;
      for (let s = 0; s < 2; s++) {
        const nb = s === 0 ? i - 1 : i + 1;
        if (nb < 0 || nb >= n || !active[nb]) continue;
        const rn = find(nb);
        ri = find(ri);
        if (rn === ri) continue;
        const c = vals[i]; // col height between the two runs
        const lo = compMax[ri] < compMax[rn] ? ri : rn;
        const hi = lo === ri ? rn : ri;
        if (prom[compPeak[lo]] < 0)
          prom[compPeak[lo]] = Math.max(0, compMax[lo] - c);
        parent[lo] = hi;
        ri = hi;
      }
    }

    // Any summit never dominated (the global max, or ties for it) starts from
    // the signal's own minimum; the boundary correction below replaces this
    // with the correct per-side floor.
    for (let i = 0; i < n; i++)
      if (prom[i] < 0) prom[i] = Math.max(0, vals[i] - vMin);

    // Boundary correction — see doc comment above. One-sided running
    // extrema, computed once in O(n): prefixMax/suffixMax find whether a
    // taller point exists on each side at all; prefixMin/suffixMin give the
    // true one-sided floor to fall back to when it doesn't.
    const prefixMax = new Float64Array(n),
      prefixMin = new Float64Array(n);
    let curMax = -Infinity,
      curMin = Infinity;
    for (let i = 0; i < n; i++) {
      prefixMax[i] = curMax; // strictly left of i (-Inf when i === 0)
      prefixMin[i] = curMin;
      if (vals[i] > curMax) curMax = vals[i];
      if (vals[i] < curMin) curMin = vals[i];
    }
    const suffixMax = new Float64Array(n),
      suffixMin = new Float64Array(n);
    curMax = -Infinity;
    curMin = Infinity;
    for (let i = n - 1; i >= 0; i--) {
      suffixMax[i] = curMax; // strictly right of i (-Inf when i === n-1)
      suffixMin[i] = curMin;
      if (vals[i] > curMax) curMax = vals[i];
      if (vals[i] < curMin) curMin = vals[i];
    }
    for (let i = 0; i < n; i++) {
      const noLeftBarrier = prefixMax[i] <= vals[i];
      const noRightBarrier = suffixMax[i] <= vals[i];
      if (!noLeftBarrier && !noRightBarrier) continue; // interior peak - sweep result already exact
      const leftFloor = i === 0 ? -Infinity : prefixMin[i];
      const rightFloor = i === n - 1 ? -Infinity : suffixMin[i];
      let reference;
      if (noLeftBarrier && noRightBarrier) {
        reference = Math.max(leftFloor, rightFloor); // global maximum (or an exact tie)
      } else if (noLeftBarrier) {
        // Right side genuinely dominated at some col (recovered via
        // vals[i] - prom[i]); left is boundary-limited.
        reference = Math.max(leftFloor, vals[i] - prom[i]);
      } else {
        reference = Math.max(rightFloor, vals[i] - prom[i]);
      }
      prom[i] = Math.max(0, vals[i] - reference);
    }

    return prom;
  },

  /**
   * Above-threshold topographic-prominence local maxima under refractory-period
   * non-max suppression — the peak list for detectPeaksByProminence(), from a
   * single topographicProminence() sweep.
   *
   * @param {Array<number>} vals - phasic signal.
   * @param {Float64Array} prom - per-sample topographic prominence (from topographicProminence(vals)).
   * @param {number} threshold - prominence gate (peakThreshold, µS).
   * @param {number} minGap - non-max-suppression radius, in samples.
   * @param {number} baselineWin - trailing window for the pre-burst minimum, in samples.
   * @returns {number[]} apex sample indices of survivors, ascending.
   */
  prominenceNMS(vals, prom, threshold, minGap, baselineWin) {
    const n = vals.length;
    // Artefact ceiling: amplitude above this cannot be a real SCR. Electrode
    // disconnects, motion artefacts and ADC rail-hits produce spikes of
    // hundreds of µS; prominence has no implicit scale gate, so a massive
    // spike is simply very prominent. MICROSIEMENS_MAX_SCR (default 20 µS) is
    // well above the physiological maximum (~5 µS in extreme subjects).
    const maxScrAmp =
      GSR_CONST.MICROSIEMENS_MAX_SCR != null
        ? GSR_CONST.MICROSIEMENS_MAX_SCR
        : 20;
    const cand = [];
    for (let i = 1; i < n - 1; i++) {
      if (!(vals[i] > vals[i - 1] && vals[i] >= vals[i + 1])) continue;
      if (vals[i] < 0.001) continue;
      // Fast artefact pre-filter: an apex already over the ceiling is
      // impossible as an SCR regardless of its local baseline.
      if (vals[i] > maxScrAmp) continue;
      if (prom[i] < threshold) continue;

      // Amplitude above the trailing pre-burst minimum ("sees under" a stacked
      // burst to pre-burst level). Bounded by baselineWin so a monotone input
      // can't make this O(n²).
      let mn = vals[i];
      for (let j = Math.max(0, i - baselineWin); j <= i; j++) {
        if (vals[j] < mn) mn = vals[j];
      }
      // Ceiling re-checked against baseline amplitude so a large-but-real event
      // riding a raised tonic is assessed from its pre-burst level, not zero.
      if (vals[i] - mn > maxScrAmp) continue;
      cand.push({ i, prominence: prom[i] });
    }

    // Minimum-gap non-max suppression — largest prominence wins, same
    // convention as detectPeaksFullScan()'s refractory skip-ahead.
    cand.sort((a, b) => b.prominence - a.prominence || a.i - b.i);
    const kept = [];
    for (const c of cand) {
      if (!kept.some((k) => Math.abs(k.i - c.i) < minGap)) kept.push(c);
    }
    kept.sort((a, b) => a.i - b.i);
    return kept.map((c) => c.i);
  },

  /**
   * Build a full peak object at apex sample `idx` with onset at `onsetIdx`
   * (passed in so the caller owns the onset rule). Reports trough-to-peak
   * `amplitude` from that onset AND topographic `prominence` from `prom[idx]`.
   * Shared by detectPeaksByProminence() and detectPeaksFullScan().
   */
  buildPeakWithMetrics(
    idx,
    onsetIdx,
    vals,
    times,
    prom,
    noiseHalfWin,
    oldLabels,
    oldExcluded,
    ctx,
  ) {
    const recoveryIdx = PeakShape.findRecoveryIndex(
      vals,
      idx,
      onsetIdx,
      vals[idx] - vals[onsetIdx],
    );
    const metrics = PeakShape.calculateShapeMetrics(
      vals,
      times,
      idx,
      onsetIdx,
      recoveryIdx,
      noiseHalfWin,
      ctx.filtered,
    );
    const peak = PeakShape.buildPeakObject(
      idx,
      vals[idx],
      vals,
      times,
      { ...metrics, onsetIdx, recoveryIdx },
      oldLabels,
      oldExcluded,
      true,
      ctx,
    );
    peak.prominence = prom[idx];
    peak.qualityScore = PeakShape.computePeakQuality(peak);
    peak.salienceScore = PeakShape.computeSalienceScore(peak);
    return peak;
  },

  /**
   * Prominence-based phasic peak detector (params.usePeakProminence).
   *
   * ONE non-greedy pass. A response is any local maximum whose TOPOGRAPHIC
   * PROMINENCE ≥ peakThreshold — i.e. skin conductance rose at least that much
   * above the level it last fell back to before this peak. Prominence is the
   * one size measure that is comparable across the whole list: exact for an
   * isolated SCR (it equals trough-to-peak amplitude there) and honest for a
   * small SCR riding on a larger one (it reads the incremental rise above the
   * dip, not an inflated distance to a far-off baseline).
   *
   * Because prominence already encodes separation — two adjacent maxima BOTH
   * clear the gate only if the valley between them is ≥ peakThreshold deep,
   * meaning a genuine partial recovery and re-rise — there is no shoulder to
   * "fix" and no compound-burst peak to "rescue"; both fall out of the single
   * pass. A refractory-period non-max suppression (PEAK_MIN_GAP, Boucsein 2012
   * ~1–2 s minimum resolvable inter-SCR interval) is still applied on top, so a
   * single burst's crest ripple is not counted as several responses; within
   * that window the more prominent maximum wins.
   *
   * Every peak carries BOTH numbers: `prominence` (the size metric this mode
   * selects on, and what hotspot ranking uses in this mode — see
   * GSRAnalyzer._selectMemorableEvents) and trough-to-peak `amplitude` (the
   * rise you would read straight off the trace), measured from a
   * threshold-aware saddle onset — findOnsetIndex walked with minDip =
   * peakThreshold, so a sub-threshold crest wiggle can't strand the onset in
   * the notch and collapse the amplitude.
   *
   * The only per-peak gate is Min Peak Quality. Min SNR is not applied: a stacked
   * peak's amplitude is saddle-referenced, so its SNR is deflated by
   * construction and would reject exactly the peaks this detector exists to
   * find. peakThreshold and the artefact ceiling (prominenceNMS) always apply.
   *
   * Cost: one topographicProminence() sweep (O(n log n)) + one prominenceNMS()
   * + one buildPeakWithMetrics() per survivor (a few hundred per track).
   *
   * @param {Array<{time:number,val:number}>} phasic - phasic series.
   * @param {number} sampleRate
   * @param {object} params - Analysis params (peakThreshold, minPeakQuality).
   * @param {Map} oldLabels - Preserved user labels, keyed by raw index.
   * @param {Set} oldExcluded - Preserved exclusion flags, keyed by raw index.
   * @param {object} ctx - See module doc comment.
   * @returns {Array<object>} Detected peaks.
   */
  detectPeaksByProminence(
    phasic,
    sampleRate,
    params,
    oldLabels,
    oldExcluded,
    ctx,
  ) {
    const n = phasic.length;
    if (n < 3) return [];

    const vals = phasic.map((d) => d.val);
    const times = phasic.map((d) => d.time);
    const sr = sampleRate;
    const threshold = params.peakThreshold;
    const minGap = Math.max(1, Math.round(GSR_CONST.PEAK_MIN_GAP * sr));
    const baselineWin = Math.max(
      1,
      Math.round((GSR_CONST.PEAK_PROMINENCE_BASELINE_SEC || 8) * sr),
    );
    const noiseHalfWin = Math.max(1, Math.round(sr));
    // Morphology gates are off in this mode, so the onset walk-back uses the
    // generous canonical MAX_RISE_TIME bound.
    const maxOnsetSteps = Math.round(GSR_CONST.PEAK_SHAPE.MAX_RISE_TIME * sr);
    const minQuality =
      params && params.minPeakQuality != null ? params.minPeakQuality : 0.0;

    const prom = ctx.topographicProminence(vals);
    // Above-threshold, artefact-screened prominence maxima, refractory-period
    // NMS applied (most-prominent-wins within PEAK_MIN_GAP). Returned ascending
    // by sample index == ascending by time.
    const kept = PeakDetectors.prominenceNMS(
      vals,
      prom,
      threshold,
      minGap,
      baselineWin,
    );

    const peaks = [];
    for (const idx of kept) {
      // Onset walk-back ignores notches shallower than peakThreshold, so a
      // response whose crest carries a sub-threshold wiggle is still measured
      // from its true onset (matches the "a real recovery is >= threshold" bar
      // the prominence gate itself uses).
      const onsetIdx = PeakShape.findOnsetIndex(
        vals,
        idx,
        maxOnsetSteps,
        threshold,
      );
      const peak = PeakDetectors.buildPeakWithMetrics(
        idx,
        onsetIdx,
        vals,
        times,
        prom,
        noiseHalfWin,
        oldLabels,
        oldExcluded,
        ctx,
      );
      if (peak.qualityScore >= minQuality) peaks.push(peak);
    }
    return peaks;
  },

  /**
   * Full-scan phasic peak detector — the DEFAULT (no params flag; the else
   * branch of analyze()'s detector selection).
   *
   * The standard trough-to-peak SCR criterion — a response is a local maximum
   * that rose at least peakThreshold above its onset (the nearest preceding
   * dip) — applied NON-GREEDILY: every local maximum is tested on its own
   * merit, not just the first one a left→right scan reaches before it skips a
   * refractory period ahead. Scanning non-greedily recovers two classes a
   * greedy left→right scan drops:
   *   - the true summit of a compound rise (a greedy scan strands the marker
   *     on the first shoulder and never revisits);
   *   - an SCR riding the rising edge of a larger later response — it has a real
   *     >= peakThreshold rise from its own onset but ZERO topographic prominence
   *     (no valley on the up-slope side), so the prominence detector cannot see
   *     it either. ~7.5% of real SCRs on the test corpus are this pattern,
   *     ~86% of them independently confirmed by deconvolution.
   *
   * Gates: peakThreshold (amplitude), Min SNR and Min Peak Quality — the
   * literature SCR criteria, per peak. Refractory-period non-max suppression
   * (PEAK_MIN_GAP): within one window the response that rose most from its own
   * onset wins. Topographic prominence is still computed and stamped on every
   * peak as a reported field (isolated vs part of a burst) but is not a
   * detection gate.
   *
   * @param {Array<{time:number,val:number}>} phasic - phasic series.
   * @param {number} sampleRate
   * @param {object} params - Analysis params (peakThreshold, shapeMinSnr, minPeakQuality).
   * @param {Map} oldLabels - Preserved user labels, keyed by raw index.
   * @param {Set} oldExcluded - Preserved exclusion flags, keyed by raw index.
   * @param {object} ctx - See module doc comment.
   * @returns {Array<object>} Detected peaks.
   */
  detectPeaksFullScan(phasic, sampleRate, params, oldLabels, oldExcluded, ctx) {
    const n = phasic.length;
    if (n < 3) return [];

    const vals = phasic.map((d) => d.val);
    const times = phasic.map((d) => d.time);
    const sr = sampleRate;
    const threshold = params.peakThreshold;
    const minGap = Math.max(1, Math.round(GSR_CONST.PEAK_MIN_GAP * sr));
    const noiseHalfWin = Math.max(1, Math.round(sr));
    const maxOnsetSteps = Math.round(GSR_CONST.PEAK_SHAPE.MAX_RISE_TIME * sr);
    const minSnr =
      params && params.shapeMinSnr != null
        ? params.shapeMinSnr
        : GSR_CONST.PEAK_SHAPE.MIN_SNR;
    const minQuality =
      params && params.minPeakQuality != null ? params.minPeakQuality : 0.0;
    const maxScrAmp =
      GSR_CONST.MICROSIEMENS_MAX_SCR != null
        ? GSR_CONST.MICROSIEMENS_MAX_SCR
        : 20;

    const prom = ctx.topographicProminence(vals); // reported field only

    const cand = [];
    for (let i = 1; i < n - 1; i++) {
      if (!(vals[i] > vals[i - 1] && vals[i] >= vals[i + 1])) continue;
      if (vals[i] < 0.001 || vals[i] > maxScrAmp) continue;
      const onsetIdx = PeakShape.findOnsetIndex(vals, i, maxOnsetSteps);
      const amplitude = vals[i] - vals[onsetIdx];
      if (amplitude < threshold) continue;
      if (minSnr > 0) {
        const noiseFloor = PeakShape.computeNoiseFloor(
          ctx.filtered,
          onsetIdx,
          noiseHalfWin,
        );
        if (noiseFloor > 0 && amplitude / noiseFloor < minSnr) continue;
      }
      cand.push({ i, onsetIdx, amplitude });
    }

    // Refractory-period NMS — largest rise from its own onset wins its window.
    cand.sort((a, b) => b.amplitude - a.amplitude || a.i - b.i);
    const kept = [];
    for (const c of cand) {
      if (!kept.some((k) => Math.abs(k.i - c.i) < minGap)) kept.push(c);
    }
    kept.sort((a, b) => a.i - b.i);

    const peaks = [];
    for (const c of kept) {
      const peak = PeakDetectors.buildPeakWithMetrics(
        c.i,
        c.onsetIdx,
        vals,
        times,
        prom,
        noiseHalfWin,
        oldLabels,
        oldExcluded,
        ctx,
      );
      if (peak.qualityScore >= minQuality) peaks.push(peak);
    }
    return peaks;
  },

  /**
   * Build the final discrete deconvolution-mode peak list by scanning the
   * reconstructed, superposition-resolved phasicClean curve for local
   * maxima — the same simple local-maximum + trough-to-peak amplitude approach
   * the default detector (detectPeaksFullScan) uses on the raw signal —
   * rather than working at the level of individual matching-pursuit atoms and
   * guessing which ones to merge.
   *
   * Scanning the reconstructed curve directly sidesteps the "how many atoms is
   * too many to merge" question: two atoms whose summed kernels show one local
   * maximum can't be told apart by this model anyway and correctly become one
   * peak; atoms far enough apart to show as separate bumps become separate
   * peaks. No gap cap or chain-length limit. This replaces an atom-level "run
   * consolidation" pass whose pairwise gap test chained transitively — a
   * sequence of individually-legal steps could span far beyond the cap and
   * collapse several genuinely separate large events into one.
   *
   * This applies no rise-time / half-recovery / skewness shape bounds (there
   * are none in any current detector): rise/recovery/skew measured off a
   * reconstructed curve reflect the summed shape of however many atoms landed
   * in one peak, not any single canonical SCR. Amplitude (peakThreshold), SNR
   * (shapeMinSnr) and composite quality (minPeakQuality) still apply.
   *
   * @param {Float64Array} cleanVals - Reconstructed phasic values (>= 0).
   * @param {Array<number>} times - Timestamps parallel to cleanVals.
   * @param {number} sampleRate
   * @param {object} params - Analysis parameters (peakThreshold, shapeMinSnr, minPeakQuality).
   * @param {Map} oldLabels - Preserved user labels, keyed by raw index.
   * @param {Set} oldExcluded - Preserved exclusion flags, keyed by raw index.
   * @param {Array<number>} [candidateIndices] - When supplied, only these
   *   apex positions are evaluated (each still re-verified as a genuine local
   *   maximum) instead of scanning every sample — used by the cvxEDA branch
   *   of GSRAnalyzer._runDeconvolutionPipeline() to detect candidates in the
   *   sparse driver rather than the smoothed reconstruction; see that call
   *   site's comment for why. Matching-pursuit's call (no candidateIndices) is
   *   unaffected — it keeps the original dense scan.
   * @param {object} ctx - See module doc comment.
   */
  detectPeaksFromCurve(
    cleanVals,
    times,
    sampleRate,
    params,
    oldLabels,
    oldExcluded,
    candidateIndices,
    ctx,
  ) {
    const n = cleanVals.length;
    const peaks = [];
    if (n < 3) return peaks;

    const defaults = GSR_CONST.PEAK_SHAPE;
    const threshold = params.peakThreshold;
    // Backward onset-search bound only — not a shape filter. The generous
    // canonical MAX_RISE_TIME, same bound detectPeaksFullScan and
    // detectPeaksByProminence use, purely to stop the walk-back at a sane point.
    const maxOnsetSteps = Math.round(defaults.MAX_RISE_TIME * sampleRate);
    const noiseHalfWin = Math.max(1, Math.round(sampleRate));

    const tryAcceptPeak = (i) => {
      const prev = cleanVals[i - 1],
        curr = cleanVals[i],
        next = cleanVals[i + 1];
      if (!(curr > prev && curr >= next)) return false;
      if (curr < 0.001) return false;

      const onsetIdx = PeakShape.findOnsetIndex(cleanVals, i, maxOnsetSteps);
      const amplitude = curr - cleanVals[onsetIdx];
      if (amplitude < threshold) return false;

      const recoveryIdx = PeakShape.findRecoveryIndex(
        cleanVals,
        i,
        onsetIdx,
        amplitude,
      );
      const metrics = PeakShape.calculateShapeMetrics(
        cleanVals,
        times,
        i,
        onsetIdx,
        recoveryIdx,
        noiseHalfWin,
        ctx.filtered,
      );

      const peak = PeakShape.buildPeakObject(
        i,
        curr,
        cleanVals,
        times,
        { ...metrics, onsetIdx, recoveryIdx },
        oldLabels,
        oldExcluded,
        false,
        ctx,
      );
      // Uses the deconvolution-specific quality formula, not
      // computePeakQuality() — see computeDeconPeakQuality()'s doc
      // comment for why the shape-based formula doesn't apply here.
      peak.qualityScore = PeakShape.computeDeconPeakQuality(peak);
      peak.salienceScore = PeakShape.computeSalienceScore(peak);
      peaks.push(peak);
      return true;
    };

    if (candidateIndices) {
      // Candidate-list mode: only visit the supplied apex positions, each
      // still subject to every gate tryAcceptPeak() applies (local-maximum
      // check, amplitude floor, SNR, quality) below. The refractory gap is
      // enforced against the nearest ACCEPTED peak rather than via the dense
      // scan's skip-ahead, since candidates already arrive sparse and out of
      // strict proximity order isn't a concern (sorted below).
      const minGapSamples = Math.max(
        1,
        Math.round(GSR_CONST.SCRF.minImpulseGapSec * sampleRate),
      );
      const sorted = [...new Set(candidateIndices)]
        .filter((i) => i >= 1 && i <= n - 2)
        .sort((a, b) => a - b);
      let lastAccepted = -minGapSamples;
      for (const i of sorted) {
        if (i - lastAccepted < minGapSamples) continue;
        if (tryAcceptPeak(i)) lastAccepted = i;
      }
    } else {
      for (let i = 1; i < n - 1; i++) {
        if (tryAcceptPeak(i)) {
          // Refractory skip-ahead uses SCRF.minImpulseGapSec (the driver-domain
          // minimum, ~0.5 s), NOT PEAK_MIN_GAP. PEAK_MIN_GAP is the trough-to-peak
          // detector's wider refractory, set to suppress tail-ripple that the raw
          // phasic shows between stacked SCRs — but this curve is the
          // superposition-resolved reconstruction, which has no such ripple, and
          // separating genuinely close events is the whole point of running
          // deconvolution. Forcing the wider gap here just throws away the
          // resolution the mode exists to provide.
          i = Math.min(
            n - 2,
            i + Math.round(GSR_CONST.SCRF.minImpulseGapSec * sampleRate),
          );
        }
      }
    }

    // Same hard SNR cutoff the default detector applies (shapeMinSnr, "0 = off").
    // SNR depends on each peak's local noise floor regardless of detection mode.
    const minSnr =
      params && params.shapeMinSnr != null
        ? params.shapeMinSnr
        : defaults.MIN_SNR;
    let result = minSnr > 0 ? peaks.filter((pk) => pk.snr >= minSnr) : peaks;

    // "0 = off" convention — no hardcoded floor here; a hardcoded minimum
    // would silently override an explicit user choice.
    const minQuality =
      params.minPeakQuality != null ? params.minPeakQuality : 0.0;
    result = result.filter((pk) => pk.qualityScore >= minQuality);

    return result;
  },
};
