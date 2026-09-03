// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// GSR/EDA Signal Analysis Engine with GPS coordinate parsing and interpolation
// Handles variable-rate (10 Hz GSR, up to 5 Hz GPS) CSV files.
//
// CSV parsing lives in a dedicated pure module (csv_parser.js) so it can be
// tested independently; this file delegates to it by the bare name GSRCSVParser
// (no top-level declaration here, so there is no redeclaration clash with the
// module's own class declaration in the shared global lexical environment).
//  - Browser: index.html loads csv_parser.js via <script> before analyzer.js
//    (window global).
//  - Node tests: vm-based loaders expose it as a global; the CommonJS
//    require() path below does the same so the bare reference resolves.
if (typeof module !== 'undefined' && module.exports) {
  global.GSRCSVParser = require('./csv_parser.js').GSRCSVParser;
}

class GSRAnalyzer {
  constructor() {
    this.raw = [];          // Raw signal: { time, val, lat, lon, hdop, pdop, sats, fixType, speedKts, course, hasGps }
    this.filtered = [];     // Cleaned signal: { time, val }
    this.tonic = [];        // Tonic component (SCL): { time, val }
    this.phasic = [];       // Phasic component (SCR): { time, val }
    this.tonicZ = [];       // Z-score Tonic component (SCL): { time, val }
    this.phasicZ = [];      // Z-score Phasic component (SCR): { time, val }
    this.phasicStd = 1;     // Standard deviation of phasic component for Z-scaling peaks
    this.peaks = [];        // Detected peaks with shape metrics:
                            // { time, index, amplitude, onsetIndex, onsetTime, halfRecoveryTime,
                            //   riseTime, onsetSlope, decaySlope, skewnessRatio, fwhm, snr,
                            //   qualityScore, salienceScore, label }
    this.memorableEvents = []; // Curated hotspot subset of this.peaks: the
                                // highest-amplitude responses, spatially spread
                                // (>= MEMORABLE_EVENTS.MIN_SEPARATION_M apart) so
                                // no two crowd one spot on the map. Built in
                                // analyze() step 5b. A companion view over
                                // this.peaks, not a replacement for it.

    // Continuous, threshold-independent arousal metrics (see
    // docs/environmental_stress_literature_review.md §5-6). These resolve the
    // "thresholding dilemma" and "superposition problem" inherent to discrete
    // peak counting by integrating the phasic signal rather than gating it.
    this.peakDensity = [];  // Sliding-window NS-SCR frequency: { time, val } — peaks/minute
    this.phasicAUC = [];    // Sliding-window Phasic AUC (ISCR): { time, val } — µS·s
    this.arousalIndex = []; // Combined tonic+phasic z-scored blend: { time, val }
    this.triIndex = [];     // Tri Index (tonic + phasic AUC + peak density) z-scored blend: { time, val }

    // Deconvolution state (Benedek & Kaernbach, 2010).
    this.phasicDriver = [];       // Raw driver signal: { time, val }
    this.phasicClean = [];        // Reconstructed clean phasic
    this.phasicDriverPeaks = [];  // Driver impulse list
    this.phasicDeconvTruncated = false; // True if matching pursuit hit maxIter before converging
    this._phasicOrig = null;      // Pre-deconvolution phasic backup (only set when deconvolution is on)

    this.sampleRate = 10;   // In Hz, auto-detected
    this.isResistance = false; // Whether original CSV was resistance (Ohms)
    this.filteredGps = [];
    this._userPeakLabels = new Map(); // Persistent time-indexed store: timestamp (sec) -> label string

    this.rfPeakIndices = new Set(); // this.raw row indices with a momentary RF
                                     // spike on any band — must survive map
                                     // simplification, see _detectRfPeakIndices()

    // Bumped by analyze()/setPeakLabel()/setPeakExcluded() (and by
    // OSMEnricher.enrichTrack() after it finishes writing osm_* fields onto
    // `raw`). Callers that cache derived data (e.g. GSRUI's environmental
    // dashboard) key their cache on this instead of relying on being told
    // to invalidate — see docs/archive/visualizer_architecture_refactor_plan.md Phase 2.
    this._dataVersion = 0;

    // ── Reused per-sample series buffers (perf) ──────────────────────────────
    // analyze() reruns on every settled slider-drag frame. Rebuilding the six
    // {time,val} arrays behind .filtered/.tonic/.phasic/.tonicZ/.phasicZ/.em_fog
    // with raw.map() every call was ~50 ms of allocation + GC on a 40k-row
    // track. _ensureSeriesPool() allocates them once per loaded track (keyed on
    // this.raw identity); analyze() refills .val in place. Each fill also
    // records the curve's global Y-range, folding a re-scan out of
    // _buildDisplayCache().
    this._seriesPool = null;
    this._seriesPoolRaw = null;
    this._rawValsPool = null;
    this._seriesRange = {};
    this._rawGlobalRange = null;
    this._timelinePointsCache = null;
    // Memoised stages 1–3 output (filter + decomposition), keyed on the six
    // params that feed it; see analyze(). Nulled whenever the series pool is
    // rebuilt (raw data changed).
    this._prefixCache = null;
  }

  /**
   * Ensure the reused per-sample series buffers exist and match the current
   * raw data. Rebuilds them — plus the raw-only display caches (raw Y-range,
   * timeline waveform sub-sample) — only when this.raw is a different array
   * than last seen, i.e. once per loaded track rather than once per analyze().
   * @private
   */
  _ensureSeriesPool(raw, n) {
    if (this._seriesPoolRaw === raw && this._rawValsPool && this._rawValsPool.length === n) {
      return;
    }
    const rawVals = new Array(n);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = raw[i].val;
      rawVals[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this._rawValsPool = rawVals;
    this._rawGlobalRange = { min: mn, max: mx };

    this._seriesPool = {};
    for (const key of ['filtered', 'tonic', 'phasic', 'tonicZ', 'phasicZ', 'em_fog']) {
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = { time: raw[i].time, val: 0 };
      this._seriesPool[key] = arr;
    }

    // Timeline waveform: sub-sample raw to ~300 points (depends only on raw).
    const tl = [];
    if (n > 0) {
      const step = Math.max(1, Math.floor(n / 300));
      for (let i = 0; i < n; i += step) tl.push(raw[i]);
    }
    this._timelinePointsCache = tl;
    this._prefixCache = null; // pooled prefix result is tied to this raw data

    this._seriesPoolRaw = raw;
  }

  /**
   * Overwrite the reused series buffer for `key` from a parallel value array,
   * recording its min/max in this._seriesRange[key] in the same pass.
   * @private
   */
  _fillSeries(key, vals) {
    const arr = this._seriesPool[key];
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = vals[i];
      arr[i].val = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this[key] = arr;
    this._seriesRange[key] = { min: mn, max: mx };
  }

  /**
   * Register or update a user-assigned peak label by timestamp.
   * @param {number} time - Peak timestamp in seconds
   * @param {string} label - Text label for the peak
   */
  setPeakLabel(time, label) {
    if (time == null) return;
    const cleanLabel = (label || '').trim();
    const key = Number(time.toFixed(3));
    if (cleanLabel) {
      this._userPeakLabels.set(key, cleanLabel);
    } else {
      this._userPeakLabels.delete(key);
      for (const [t] of this._userPeakLabels.entries()) {
        if (Math.abs(t - time) <= 0.2) {
          this._userPeakLabels.delete(t);
        }
      }
    }
    this._dataVersion++;
  }

  /**
   * Toggle (or set) a peak's excluded flag by index.
   */
  setPeakExcluded(idx, excluded) {
    if (!this.peaks[idx]) return;
    this.peaks[idx].excluded = excluded;
    this._dataVersion++;
  }

  /**
   * Retrieve a user peak label by timestamp, using exact match first then nearest-neighbour lookup within tolerance.
   * @param {number} targetTime - Peak timestamp in seconds
   * @param {number} [maxToleranceSec=1.0] - Proximity window tolerance in seconds
   * @returns {string} Matching label or empty string
   */
  getMatchingLabel(targetTime, maxToleranceSec = 1.0) {
    if (targetTime == null || this._userPeakLabels.size === 0) return '';
    const key = Number(targetTime.toFixed(3));
    if (this._userPeakLabels.has(key)) {
      return this._userPeakLabels.get(key);
    }
    let bestMatch = '';
    let minDiff = Infinity;
    for (const [t, label] of this._userPeakLabels.entries()) {
      const diff = Math.abs(t - targetTime);
      if (diff <= maxToleranceSec && diff < minDiff) {
        minDiff = diff;
        bestMatch = label;
      }
    }
    return bestMatch;
  }

  /**
   * Assign persistent user labels to a list of detected peak objects using optimal 1-to-1 timestamp matching.
   * @param {Array<object>} peaks - List of detected peak objects
   * @private
   */
  _assignLabelsToPeaks(peaks) {
    if (!peaks || peaks.length === 0 || !this._userPeakLabels || this._userPeakLabels.size === 0) return;

    // Build list of candidate (peak, labelKey, diff) pairs within tolerance window (1.0s)
    const candidates = [];
    for (let pIdx = 0; pIdx < peaks.length; pIdx++) {
      const peak = peaks[pIdx];
      const pTime = peak.time;
      for (const [tKey, labelStr] of this._userPeakLabels.entries()) {
        const diff = Math.abs(pTime - tKey);
        if (diff <= 1.0 && labelStr) {
          candidates.push({ pIdx, tKey, labelStr, diff });
        }
      }
    }

    // Sort candidate pairs by ascending distance diff (closest matches first)
    candidates.sort((a, b) => a.diff - b.diff);

    // Greedily match 1-to-1: each peak gets at most 1 label, and each label key is used at most once
    const assignedPeaks = new Set();
    const assignedLabels = new Set();

    for (const cand of candidates) {
      if (!assignedPeaks.has(cand.pIdx) && !assignedLabels.has(cand.tKey)) {
        peaks[cand.pIdx].label = cand.labelStr;
        assignedPeaks.add(cand.pIdx);
        assignedLabels.add(cand.tKey);
      }
    }
  }


  /**
   * Binary search the raw data array for the index closest to a target time.
   */
  findClosestIndex(targetTime) {
    if (!this.raw || this.raw.length === 0) return -1;
    const data = this.raw;
    let low = 0;
    let high = data.length - 1;

    if (targetTime <= data[low].time) return low;
    if (targetTime >= data[high].time) return high;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midTime = data[mid].time;

      if (midTime === targetTime) return mid;

      if (midTime < targetTime) {
        if (mid < data.length - 1 && data[mid + 1].time > targetTime) {
          return (targetTime - midTime < data[mid + 1].time - targetTime) ? mid : mid + 1;
        }
        low = mid + 1;
      } else {
        if (mid > 0 && data[mid - 1].time < targetTime) {
          return (targetTime - data[mid - 1].time < midTime - targetTime) ? mid - 1 : mid;
        }
        high = mid - 1;
      }
    }
    return -1;
  }

  /**
   * Helper: gets coordinates at a given index from filtered GPS data if valid,
   * otherwise falls back to raw GPS data. Returns { lat, lon } or null.
   */
  getCoordinates(index, preferRaw = false) {
    const raw = this.raw[index];
    if (preferRaw && raw && !isNaN(raw.lat) && !isNaN(raw.lon)) {
      return { lat: raw.lat, lon: raw.lon };
    }
    const filtered = this.filteredGps && this.filteredGps[index];
    if (filtered && !isNaN(filtered.lat) && !isNaN(filtered.lon)) {
      return { lat: filtered.lat, lon: filtered.lon };
    }
    if (raw && !isNaN(raw.lat) && !isNaN(raw.lon)) {
      return { lat: raw.lat, lon: raw.lon };
    }
    return null;
  }

  // Time/date formatting implementations live in AnalyzerTimeFormat
  // (analyzer_time_format.js); these wrappers just pass recordingStartTime.

  /** Clock time for `relativeSeconds`, e.g. "14:32:05" (relative "M:SS" fallback). */
  formatClockTime(relativeSeconds) {
    return AnalyzerTimeFormat.clockTime(this.recordingStartTime, relativeSeconds);
  }

  /** Alias of formatClockTime — kept for call-site clarity. */
  formatTimeOnly(relativeSeconds) {
    return AnalyzerTimeFormat.clockTime(this.recordingStartTime, relativeSeconds);
  }

  /** UK-formatted date, e.g. "30th Dec 2026" (relative clock fallback). */
  formatDateUK(relativeSeconds) {
    return AnalyzerTimeFormat.dateUK(this.recordingStartTime, relativeSeconds);
  }

  /** Short numeric date, e.g. "30.12.2026" (relative clock fallback). */
  formatDateShort(relativeSeconds) {
    return AnalyzerTimeFormat.dateShort(this.recordingStartTime, relativeSeconds);
  }

  /**
   * Parse CSV string into raw time/value objects with GPS columns.
   * Interpolates GPS coordinates to reconstruct a continuous 10 Hz path.
   * Delegates all parsing to the pure GSRCSVParser (csv_parser.js); this
   * method only maps the parser's result back onto analyzer state.
   */
  parseCSV(csvText) {
    const result = GSRCSVParser.parse(csvText);

    this.raw = result.raw;
    this.isResistance = result.isResistance;
    this.recordingStartTime = result.recordingStartTime;
    this.importedFilterParams = result.importedFilterParams;
    this.importedGpsFilterParams = result.importedGpsFilterParams;
    this.enrichmentRadius = result.enrichmentRadius;
    this.bandFloors = result.bandFloors;
    this.sampleRate = result.sampleRate;
    this.hasRfData = result.hasRfData;
    this.rfPeakIndices = result.rfPeakIndices;
    this.isEnriched = result.isEnriched;
    this.integrity = result.integrity;
    this._csvWarnings = result.warnings;

    // Restore imported peak labels/exclusions onto the persistent user-label
    // store (the parser builds the maps; only the analyzer owns setPeakLabel).
    this._importedPeakLabels = result.importedPeakLabels || new Map();
    this._importedPeakExcluded = result.importedPeakExcluded || new Map();
    for (const [t, label] of this._importedPeakLabels.entries()) {
      this.setPeakLabel(t, label);
    }

    return this.raw;
  }

  /**
   * Run the analysis pipeline with current parameter adjustments.
   *
   * @param {object} params - GSR filter/detection params (see GSRStorage.readGsrSliderValues()).
   * @param {number} [peakLatency=0] - GPS peak-latency compensation (seconds),
   *   from GSRStorage.readGpsSliderValues(). Used when resolving coordinates
   *   for hotspot selection (memorableEvents). Defaults to 0 (no shift).
   */
  analyze(params, peakLatency = 0) {
    if (this.raw.length === 0) return;

    const n = this.raw.length;
    this._ensureSeriesPool(this.raw, n);

    // ── Stages 1–3: median filter → low-pass → tonic/phasic decomposition ──
    // Only six params feed this prefix; the ~9 peak-detection / hotspot /
    // metric-window sliders don't. When none of the six changed since the last
    // analyze(), the pooled .filtered/.tonic/.phasic arrays (and their cached
    // Y-ranges) are still correct — skip ~25 ms of filtering + decomposition on
    // a 40k-row track and reuse them. Keyed alongside this.raw identity, which
    // _ensureSeriesPool() nulls the cache on.
    const prefixKey = params.medianSize + '|' + params.lpfWindow + '|' + !!params.adaptiveNotch +
      '|' + params.tonicWindow + '|' + params.tonicMethod + '|' + params.dwtLevel;

    let phasicVals;
    if (this._prefixCache && this._prefixCache.key === prefixKey) {
      phasicVals = this._prefixCache.phasicVals;
      // .filtered / .tonic and their ranges are untouched between calls; the
      // phasic side may have been swapped out by a deconvolution run, so
      // restore it from the pristine prefix result.
      this.filtered = this._seriesPool.filtered;
      this.tonic = this._seriesPool.tonic;
      this.phasic = this._seriesPool.phasic;
      this._seriesRange.phasic = this._prefixCache.phasicRange;
      this.phasicStd = this._prefixCache.phasicStd;
      this.tonicZ = GsrFilter.standardizeSignal(this.tonic, this._seriesPool.tonicZ);
      this.phasicZ = GsrFilter.standardizeSignal(this.phasic, this._seriesPool.phasicZ);
    } else {
      // 1. Noise Median Filtering
      const medWindowSize = Math.max(1, Math.round(params.medianSize * this.sampleRate));
      let afterMedian = GsrFilter.applyMedianFilter(this._rawValsPool, medWindowSize);

      // 2. Low-Pass Filter
      let afterLPF;
      if (params.adaptiveNotch) {
        const defaultWinSize = params.lpfWindow * this.sampleRate;
        const windowSizes = GsrFilter.estimateGaitPeriods(afterMedian, this.sampleRate, defaultWinSize);
        afterLPF = GsrFilter.applyAdaptiveZeroPhaseMovingAverage(afterMedian, windowSizes);
      } else {
        const lpfWinSize = params.lpfWindow * this.sampleRate;
        afterLPF = GsrFilter.applyZeroPhaseMovingAverage(afterMedian, lpfWinSize);
      }

      this._fillSeries('filtered', afterLPF);

      // 3. Tonic/Phasic Decomposition
      const decomp = GsrFilter.decomposeTonicPhasic(afterLPF, this.sampleRate, params);
      const tonicVals = decomp.tonic;
      phasicVals = decomp.phasic;

      this._fillSeries('tonic', tonicVals);
      this._fillSeries('phasic', phasicVals);

      // Compute Z-Scores and cache standard deviation of phasic values for peak scaling
      this.tonicZ = GsrFilter.standardizeSignal(this.tonic, this._seriesPool.tonicZ);
      this.phasicZ = GsrFilter.standardizeSignal(this.phasic, this._seriesPool.phasicZ);
      this.phasicStd = GsrFilter.calculateStats(phasicVals).std;

      this._prefixCache = {
        key: prefixKey,
        phasicVals,
        phasicStd: this.phasicStd,
        phasicRange: this._seriesRange.phasic,
      };
    }

    // 5. Phasic Peak Detection. Exactly one of three mutually-exclusive
    // pipelines builds this.peaks per analyze() call. The morphology sliders
    // (rise / half-recovery / skew) apply in the default mode only; Min SNR and
    // Min Peak Quality apply in every mode.
    //   - default: trough-to-peak detection. The morphology sliders are live
    //     rejection gates.
    //   - combined (params.usePeakProminence): trough-to-peak as the base, each
    //     apex snapped to the locally most topographically-prominent maximum,
    //     plus the prominence detector's compound-SCR rescues the greedy scan
    //     skipped past. One shared prominence sweep feeds both. Identification
    //     is prominence + SNR + quality — the morphology sliders are forced off
    //     (see _detectPeaksCombined()).
    //   - deconvolution (params.useDeconvolution): one global SCR deconvolution
    //     pass that replaces this.phasic with a resolved, superposition-free
    //     reconstruction and builds peaks from its driver impulses. Morphology
    //     is fixed by the SCRF kernel, so the sliders are pinned to its
    //     canonical values.
    // Combined takes precedence over deconvolution if both flags are set.
    if (params.usePeakProminence) {
      this.phasicDriver = [];
      this.phasicClean = [];
      this.phasicDriverPeaks = [];
      this.phasicDeconvTruncated = false;
      this._phasicOrig = null;
      this._detectPeaksCombined(params);
    } else if (params.useDeconvolution) {
      this._runDeconvolutionPipeline(phasicVals, params);
    } else {
      this.phasicDriver = [];
      this.phasicClean = [];
      this.phasicDriverPeaks = [];
      this.phasicDeconvTruncated = false;
      this._phasicOrig = null; // clear stale backup from a prior deconvolution run
      this.detectPeaks(params.peakThreshold, params);
    }

    // 5b. Memorable-event ("hotspot") selection — see _selectMemorableEvents().
    this.memorableEvents = this._selectMemorableEvents(params, peakLatency);

    // 6. Continuous, threshold-independent arousal metrics (ISCR/AUC + combined index + EM Fog)
    const densityWin = (params && params.peakDensityWindow != null) ? params.peakDensityWindow : null;
    this.peakDensity = this.computeTemporalPeakDensity(densityWin);
    this.phasicAUC = this.computePhasicAUC();
    // Pass the already-computed phasicAUC so computeCombinedArousalIndex() and
    // computeTriIndex() don't each re-run the identical O(N) computePhasicAUC(30).
    const aiCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.AROUSAL_INDEX) || { wTonic: 0.3, wPhasic: 0.7 };
    const triCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.TRI_INDEX) || { wTonic: 0.10, wPhasic: 0.45, wDensity: 0.45 };
    this.arousalIndex = this.computeCombinedArousalIndex(aiCfg.wTonic, aiCfg.wPhasic, this.phasicAUC);
    this.triIndex = this.computeTriIndex(triCfg.wTonic, triCfg.wPhasic, triCfg.wDensity, this.phasicAUC, this.peakDensity);
    const efArr = this._seriesPool.em_fog;
    let efMn = Infinity, efMx = -Infinity;
    for (let i = 0; i < n; i++) {
      const e = this.raw[i].em_fog;
      const v = (e !== undefined && !isNaN(e)) ? e : 0;
      efArr[i].val = v;
      if (v < efMn) efMn = v;
      if (v > efMx) efMx = v;
    }
    this.em_fog = efArr;
    this.emFog = efArr;
    this._seriesRange.em_fog = { min: efMn, max: efMx };

    // 7. Build display cache for fast rendering (Y-range pyramid, timeline)
    this._buildDisplayCache();

    // Bump so any cache keyed on this analyzer's data (e.g. the environmental
    // dashboard's _cachedEnvStats) recomputes instead of trusting stale stats.
    this._dataVersion++;
  }

  /**
   * The canonical SCRF kernel's own peak offset: samples from kernel start to
   * kernel apex. _runDeconvolutionPipeline() uses it to predict where an
   * impulse's reconstructed apex should land, for resolveApex()'s search.
   *
   * Per Benedek & Kaernbach (2010) and the equivalent Ledalab/cvxEDA methods
   * the kernel shape is fixed across a whole recording, so amplitude is the
   * only free parameter per event — which is what makes superposed SCRs
   * separable. Per-peak rise/recovery/skew/FWHM are measured empirically off
   * the reconstructed curve by _detectPeaksFromCurve(), not derived here.
   * @private
   */
  _kernelPeakOffset(kernel) {
    let kPeakIdx = 0;
    for (let i = 1; i < kernel.length; i++) {
      if (kernel[i] > kernel[kPeakIdx]) kPeakIdx = i;
    }
    return kPeakIdx;
  }

  /**
   * SCR Deconvolution Pipeline (Benedek & Kaernbach, 2010).
   *
   * Runs ONE global nonnegative deconvolution over the entire phasic trace
   * (not a per-peak local window) against a canonical bi-exponential SCRF
   * kernel, recovering a sparse "driver" signal whose impulses each
   * correspond to one SCR — superposed/overlapping responses that a
   * trough-to-peak detector undercounts become separable because each
   * impulse only has to explain the residual left after every other impulse
   * already placed has been subtracted out.
   *
   * A single global pass (rather than deconvolving a window around each
   * already-detected peak) is what the published method does, and it avoids
   * double-counting: overlapping per-peak windows can each explain the same
   * physical SCR. One pass plus one global minimum-gap sweep over the driver
   * rules that out, matching the ~0.5 s minimum-separation constraint from the
   * sparse-EDA-deconvolution literature.
   *
   * Known limitation of the base method (Benedek & Kaernbach 2010 note it):
   * nonnegative/matching-pursuit deconvolution can explain residual noise as a
   * spurious small-amplitude SCR. Mitigated here by (a) the same amplitude
   * threshold as the non-deconvolution path and (b) requiring each impulse to
   * match a genuine local rise in the original phasic signal, not just a
   * driver-domain artefact — not eliminated the way a regularised convex
   * solver (e.g. cvxEDA) would.
   *
   * Amplitude accuracy: MP's per-atom amplitude is exact for isolated SCRs but
   * overestimates energy where adjacent kernel copies overlap, since each new
   * atom's residual is contaminated by prior atoms' tails. The rescaling step
   * below corrects it: all impulse amplitudes are multiplied by
   * sum(phasicVals)/sum(cleanVals), so aggregate energy — and therefore
   * phasicAUC, arousalIndex and exported amplitudes — is at the right scale.
   * The scalar is uniform, so per-peak ordering is preserved.
   *
   * @param {Array<number>} phasicVals - Tonic-subtracted phasic values (>= 0).
   * @param {object} params - Analysis parameters (peakThreshold, minPeakQuality, shapeMinSnr).
   * @private
   */
  _runDeconvolutionPipeline(phasicVals, params) {
    const n = phasicVals.length;
    this.phasicDriver = [];
    this.phasicClean = [];
    this.phasicDriverPeaks = [];
    if (n === 0) { this.peaks = []; return; }

    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();

    const scf = GSR_CONST.SCRF;
    const times = this.phasic.map(d => d.time);
    const phasicArr = new Float64Array(phasicVals);

    const result = SCRDeconvolution.deconvolve(phasicArr, this.sampleRate, {
      tauSlow: scf.tauSlow, tauFast: scf.tauFast, kernelSec: scf.kernelSec,
      maxIter: scf.maxIter, lr: scf.lr, convTol: scf.convTol
    });

    // Diagnostic: whether matching pursuit converged (residual < convTol)
    // before exhausting its iteration budget, or was truncated by maxIter.
    // A truncated run means real SCRs may have been left unmodelled with no
    // visible sign in the results — check this if peak counts look low for
    // a long/busy recording.
    this.phasicDeconvTruncated = result.iterations >= scf.maxIter;

    this.phasicDriver = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicDriver[i] = { time: times[i], val: result.driver[i] };
    }

    // Global impulse detection: minImpulseGapSec is enforced exactly once,
    // across the whole track, so no two accepted impulses can be closer than
    // that regardless of how many original peaks would once have generated
    // overlapping local windows around them.
    const rawImpulses = SCRDeconvolution.detectImpulses(
      result.driver, this.sampleRate, scf.impulseThreshold, scf.minImpulseGapSec
    );

    const kPeakIdx = this._kernelPeakOffset(result.kernel);

    // Map each clamped driver-array position back to the individual
    // matching-pursuit atom(s) that were combined into it — usually exactly
    // one, but multiple whenever two+ atoms independently clamp to the same
    // position, which in practice only happens right at the recording
    // boundary (see deconvolve()'s clampedImpIdx comment). rawImpulses
    // below (from detectImpulses(), which only sees the already-collapsed
    // `driver` array) only knows the CLAMPED position; resolving/
    // reconstructing a boundary impulse from that clamped position instead
    // of its true (possibly negative) one reproduces a mistimed, reshaped
    // bump — verified empirically (see deconvolve()'s impulseLog doc
    // comment: true apex at sample 4 reconstructed at sample ~kPeakIdx=12).
    const logByClampedIndex = new Map();
    for (const entry of result.impulseLog) {
      if (!logByClampedIndex.has(entry.clampedIndex)) logByClampedIndex.set(entry.clampedIndex, []);
      logByClampedIndex.get(entry.clampedIndex).push(entry);
    }
    // For the apex-prediction sanity check below, use the single largest
    // contributor's true position when multiple atoms share a clamped slot
    // — a coarse "is there really a rise near here" gate doesn't need every
    // contributor, just the dominant one's true position.
    const dominantTrueIndex = (clampedIndex) => {
      const entries = logByClampedIndex.get(clampedIndex);
      if (!entries || entries.length === 0) return clampedIndex; // shouldn't happen; safe fallback
      let best = entries[0];
      for (const e of entries) if (e.amplitude > best.amplitude) best = e;
      return best.trueIndex;
    };

    // imp.index from detectImpulses() is the driver-domain ONSET position, not
    // the SCR's apex: deconvolve() places each impulse at maxIdx - kPeakIdx so
    // that convolving it with the kernel puts the bump's own peak back at
    // maxIdx, i.e. the true apex is imp.index + kPeakIdx.
    //
    // Resolve the true apex by searching the *original* phasic signal near the
    // kernel-predicted position — the canonical kernel is only an approximation
    // of any real SCR, so the actual maximum can sit a little either side of
    // kPeakIdx samples after onset. The ±0.5 s window is deliberate; ±0.75 s
    // was tried and slightly hurt both apex accuracy and detectPeaks()
    // agreement (it snaps onto neighbouring peaks). resolveApex() here only
    // gates which raw impulses feed the reconstruction; the final peak
    // positions come from _detectPeaksFromCurve() scanning the reconstructed
    // curve.
    const apexSearchHalfWin = Math.max(1, Math.round(0.5 * this.sampleRate));
    const resolveApex = (onsetIdx) => {
      const predicted = Math.min(n - 1, onsetIdx + kPeakIdx);
      // Clamp the search window's lower bound to onsetIdx itself, not just
      // predicted-halfWin: near the end of a recording, `predicted` gets
      // clamped down to n-1, which can pull predicted-halfWin below onsetIdx
      // — without this, the search could return an apex earlier than its own
      // onset, which is physically nonsensical and breaks anything iterating
      // the [onsetIndex, index] range (e.g. renderer.js's shaded-region draw).
      const lo = Math.max(0, onsetIdx, predicted - apexSearchHalfWin);
      const hi = Math.min(n - 1, predicted + apexSearchHalfWin);
      let bestIdx = Math.max(onsetIdx, predicted), bestVal = phasicVals[bestIdx] || 0;
      for (let i = lo; i <= hi; i++) {
        if (phasicVals[i] > bestVal) { bestVal = phasicVals[i]; bestIdx = i; }
      }
      return { apexIdx: bestIdx, apexVal: bestVal };
    };

    // Gate which raw impulses feed the reconstruction: the amplitude threshold
    // detectPeaks() applies, plus a check that each impulse matches a genuine
    // local rise in the *original* signal at its resolved apex, not just a
    // driver-domain artefact (mitigates noise-detected-as-SCR). This is the
    // only pre-reconstruction filter — SNR and quality judge individual
    // reported events, not whether a piece of signal is real, so they run
    // later against the peaks built from the reconstructed curve, matching
    // detectPeaks()'s own order (amplitude gates candidacy; SNR/quality filter
    // the finished peak objects). resolveApex() is predicted from the TRUE
    // (possibly negative) onset via dominantTrueIndex(), not imp.index's
    // clamped position — a boundary impulse's clamp shift (up to kPeakIdx
    // samples) would otherwise push the real apex outside the search window.
    const threshold = params.peakThreshold;
    const minApexVal = scf.minApexVal ?? 0.001;
    const impulses = rawImpulses
      .map(imp => ({ imp, ...resolveApex(dominantTrueIndex(imp.index)) }))
      .filter(({ imp, apexVal }) => imp.amplitude >= threshold && apexVal >= minApexVal);
    this.phasicDriverPeaks = impulses.map(({ imp }) => imp);

    // Reconstruct the clean, superposition-resolved phasic signal from every
    // impulse that passed the gate above, at each atom's TRUE (possibly
    // negative) onset position — reconstructPhasic() treats impulse "index"
    // as the ONSET position (the kernel is convolved starting there), not
    // the apex, and needs the true position to correctly reproduce only the
    // visible tail of a kernel whose modelled onset predates t=0 (see that
    // function's doc comment). Falls back to the clamped position/amplitude
    // if a gated impulse's clamped index has no logged entry (shouldn't
    // happen — every driver-array impulse originates from an impulseLog
    // entry — but degrades safely rather than dropping the impulse).
    const reconstructionImpulses = [];
    for (const { imp } of impulses) {
      const entries = logByClampedIndex.get(imp.index);
      if (entries && entries.length > 0) {
        for (const e of entries) reconstructionImpulses.push({ index: e.trueIndex, amplitude: e.amplitude });
      } else {
        reconstructionImpulses.push({ index: imp.index, amplitude: imp.amplitude });
      }
    }
    const cleanValsRaw = SCRDeconvolution.reconstructPhasic(reconstructionImpulses, n, result.kernel);

    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: the rescaling below must operate on the EXACT SAME impulse set
    // that cleanValsRaw was reconstructed from.  If any filtering, merging, or
    // amplitude adjustment is inserted between reconstructPhasic() here and the
    // rescaling block below, the scale factor will be calibrated against a
    // different signal than the one it's applied to — silently corrupting all
    // downstream amplitudes, phasicAUC, arousalIndex, and CSV exports.
    //
    // The three arrays rescaled below (reconstructionImpulses, phasicDriverPeaks,
    // phasicDriver) are all derived from the SAME gated impulse set (the
    // `impulses` variable above), keeping the per-atom log entries, the summed
    // driver-domain peaks, and the driver display array mutually consistent.
    // ═══════════════════════════════════════════════════════════════════════════

    // Post-hoc amplitude rescaling — corrects the MP overestimation that
    // arises when adjacent kernel copies overlap.  The greedy residual-peak
    // amplitude heuristic (amplitude = maxVal at each MP step) is exact for
    // isolated SCRs (kernel[kPeakIdx] == 1.0) but overestimates energy when
    // the residual has been contaminated by neighbouring atoms' tails.
    // The correction is a global scalar applied uniformly to all accepted
    // impulse amplitudes:
    //
    //   scale = sum(phasicVals) / sum(cleanValsRaw)
    //
    // This is equivalent to asking "what single factor makes the total energy
    // of the reconstructed signal match the total energy of the original
    // phasic?" — exactly what the AUC overestimation is about.  Applying it
    // uniformly to all amplitudes preserves the *relative* amplitude ordering
    // of peaks (and therefore the peak/quality/salience ranking) while
    // bringing the aggregate and per-peak absolute values to the correct scale.
    //
    // A global scalar cannot fix per-peak errors that stem from MP's greedy
    // position selection (a fully joint NNLS optimisation would be needed for
    // that), but it eliminates the systematic aggregate bias measured at
    // +60–68% on real tracks and makes phasicAUC/arousalIndex/CSV amplitude
    // exports physiologically meaningful rather than inflation-inflated.
    //
    // Guard: if cleanValsRaw sums to zero (no impulses passed the gate, e.g.
    // a recording with no detectable SCRs), skip the rescaling to avoid ÷0.
    let rescaleAmplitudes = 1.0;
    {
      let sumClean = 0, sumPhasic = 0;
      for (let i = 0; i < n; i++) { sumClean += cleanValsRaw[i]; sumPhasic += phasicVals[i]; }
      if (sumClean > 0) rescaleAmplitudes = sumPhasic / sumClean;
    }
    // Apply the scale to every impulse so cleanVals, phasicDriver values, and
    // the impulse amplitudes stored on phasicDriverPeaks are all consistent.
    let cleanVals;
    if (Math.abs(rescaleAmplitudes - 1.0) < 1e-9) {
      // No inflation detected (isolated SCRs or empty reconstruction) — skip
      // the second reconstruction pass to save time.
      cleanVals = cleanValsRaw;
    } else {
      for (const imp of reconstructionImpulses) imp.amplitude *= rescaleAmplitudes;
      for (const imp of this.phasicDriverPeaks)  imp.amplitude *= rescaleAmplitudes;
      // Rescale the driver array in-place so phasicDriver display is consistent.
      for (let i = 0; i < n; i++) this.phasicDriver[i].val *= rescaleAmplitudes;
      cleanVals = SCRDeconvolution.reconstructPhasic(reconstructionImpulses, n, result.kernel);
    }
    this.phasicClean = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicClean[i] = { time: times[i], val: cleanVals[i] };
    }
    this._phasicOrig = this.phasic;
    this.phasic = this.phasicClean;
    this.phasicZ = GsrFilter.standardizeSignal(this.phasic, this._seriesPool && this._seriesPool.phasicZ);
    this.phasicStd = GsrFilter.calculateStats(cleanVals).std;
    // this.phasic is now the reconstructed curve, not the pooled pristine one
    // _fillSeries() ranged in analyze() — refresh its cached Y-range so
    // _buildDisplayCache() (and the plot's global-range fast path) match what
    // deconvolution mode actually draws.
    let phMn = Infinity, phMx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = cleanVals[i];
      if (v < phMn) phMn = v;
      if (v > phMx) phMx = v;
    }
    this._seriesRange.phasic = { min: phMn, max: phMx };

    // Build the final, displayed peak list by scanning the reconstructed
    // curve for local maxima — see _detectPeaksFromCurve()'s doc comment for
    // why this replaces the previous atom-level "run consolidation" pass.
    this.peaks = this._detectPeaksFromCurve(cleanVals, times, params, oldLabels, oldExcluded);
    this._assignLabelsToPeaks(this.peaks);
  }

  /**
   * Build the final discrete deconvolution-mode peak list by scanning the
   * reconstructed, superposition-resolved phasicClean curve for local
   * maxima — the same simple approach detectPeaks() already uses on the raw
   * signal in non-deconvolution mode — rather than working at the level of
   * individual matching-pursuit atoms and guessing which ones to merge.
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
   * Unlike detectPeaks(), this does not apply the rise-time / half-recovery /
   * skewness shape bounds: those sliders stay locked to the kernel's canonical
   * values while deconvolution is on (see
   * events.js:updateShapeSlidersForDetector), and rise/recovery/skew measured
   * off a reconstructed curve reflect the summed shape of however many atoms
   * landed in one peak, not any single canonical SCR. Amplitude
   * (peakThreshold), SNR (shapeMinSnr) and composite quality (minPeakQuality)
   * still apply.
   *
   * @param {Float64Array} cleanVals - Reconstructed phasic values (>= 0).
   * @param {Array<number>} times - Timestamps parallel to cleanVals.
   * @param {object} params - Analysis parameters (peakThreshold, shapeMinSnr, minPeakQuality).
   * @param {Map} oldLabels - Preserved user labels, keyed by raw index.
   * @param {Set} oldExcluded - Preserved exclusion flags, keyed by raw index.
   * @private
   */
  _detectPeaksFromCurve(cleanVals, times, params, oldLabels, oldExcluded) {
    const n = cleanVals.length;
    const peaks = [];
    if (n < 3) return peaks;

    const defaults = GSR_CONST.PEAK_SHAPE;
    const threshold = params.peakThreshold;
    // Backward onset-search bound only — not a shape filter (those stay
    // locked/inapplicable in decon mode, see doc comment above). Reuses the
    // same default search limit detectPeaks() falls back to when its own
    // slider is off, purely to stop the walk-back at a sane point.
    const maxOnsetSteps = Math.round(defaults.MAX_RISE_TIME * this.sampleRate);
    const noiseHalfWin = Math.max(1, Math.round(this.sampleRate));

    for (let i = 1; i < n - 1; i++) {
      const prev = cleanVals[i - 1], curr = cleanVals[i], next = cleanVals[i + 1];
      if (!(curr > prev && curr >= next)) continue;
      if (curr < 0.001) continue;

      const onsetIdx = this._findOnsetIndex(cleanVals, i, maxOnsetSteps);
      const amplitude = curr - cleanVals[onsetIdx];
      if (amplitude < threshold) continue;

      const recoveryIdx = this._findRecoveryIndex(cleanVals, i, onsetIdx, amplitude);
      const metrics = this._calculateShapeMetrics(cleanVals, times, i, onsetIdx, recoveryIdx, noiseHalfWin);

      const peak = this._buildPeakObject(i, curr, cleanVals, times,
        { ...metrics, onsetIdx, recoveryIdx },
        oldLabels, oldExcluded, false);
      // Uses the deconvolution-specific quality formula, not
      // _computePeakQuality() — see _computeDeconPeakQuality()'s doc
      // comment for why the shape-based formula doesn't apply here.
      peak.qualityScore = this._computeDeconPeakQuality(peak);
      peak.salienceScore = this._computeSalienceScore(peak);
      peaks.push(peak);

      // Refractory skip-ahead uses SCRF.minImpulseGapSec (the driver-domain
      // minimum, ~0.5 s), NOT PEAK_MIN_GAP. PEAK_MIN_GAP is the trough-to-peak
      // detector's wider refractory, set to suppress tail-ripple that the raw
      // phasic shows between stacked SCRs — but this curve is the
      // superposition-resolved reconstruction, which has no such ripple, and
      // separating genuinely close events is the whole point of running
      // deconvolution. Forcing the wider gap here just throws away the
      // resolution the mode exists to provide.
      i = Math.min(n - 2, i + Math.round(GSR_CONST.SCRF.minImpulseGapSec * this.sampleRate));
    }

    // Enforce the same hard SNR cutoff detectPeaks() applies (shape.MIN_SNR,
    // "0 = off"). shapeMinSnr stays live/editable in the UI when
    // deconvolution is on — unlike rise time/half-recovery/skew, SNR isn't a
    // property fixed by the kernel shape, it depends on each peak's local
    // noise floor regardless of detection mode.
    const minSnr = params && params.shapeMinSnr != null ? params.shapeMinSnr : defaults.MIN_SNR;
    let result = minSnr > 0 ? peaks.filter(pk => pk.snr >= minSnr) : peaks;

    // Same "0 = off" convention as detectPeaks() — no hardcoded floor here;
    // a hardcoded minimum would silently override an explicit user choice.
    const minQuality = params.minPeakQuality != null ? params.minPeakQuality : 0.0;
    result = result.filter(pk => pk.qualityScore >= minQuality);

    return result;
  }

  /**
   * Construct a peak object from shape metrics, resolving labels and exclusion
   * flags from both the in-memory store and (optionally) imported CSV data.
   *
   * @param {number}  i                     - Sample index of the peak apex.
   * @param {number}  currVal               - Signal value at the apex.
   * @param {Array}   vals                  - Signal values array (phasic or reconstructed).
   * @param {Array}   times                 - Timestamps parallel to vals.
   * @param {object}  shape                 - Pre-computed shape metrics:
   *   { amplitude, onsetIdx, recoveryIdx, halfRecoveryTime, riseTime,
   *     onsetSlope, decaySlope, skewnessRatio, fwhm, snr }
   * @param {Map}     oldLabels             - Index→label map from pre-analysis peaks.
   * @param {Set}     oldExcluded           - Index set of excluded pre-analysis peaks.
   * @param {boolean} [checkImportedExcluded=false]
   *   When true also checks this._importedPeakExcluded by *time* (detectPeaks
   *   mode, where the imported-CSV exclusion map exists). False in
   *   _detectPeaksFromCurve mode, which only sees the index-keyed oldExcluded.
   * @returns {object} Peak object (qualityScore and salienceScore NOT yet set).
   * @private
   */
  _buildPeakObject(i, currVal, vals, times, shape, oldLabels, oldExcluded, checkImportedExcluded = false) {
    const { amplitude, onsetIdx, recoveryIdx, halfRecoveryTime,
            riseTime, onsetSlope, decaySlope, skewnessRatio, fwhm, snr } = shape;
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
      fwhm,
      snr,
      label: oldLabels.get(i) ||
             this.getMatchingLabel(times[i]) ||
             (this._importedPeakLabels ? this._importedPeakLabels.get(times[i]) : '') ||
             '',
      excluded: oldExcluded.has(i) ||
                (checkImportedExcluded && this._importedPeakExcluded
                  ? this._importedPeakExcluded.has(times[i])
                  : false)
    };
  }

  /**
   * Pre-compute global Y-ranges
   */
  _buildDisplayCache() {
    // Global Y-range per curve — used when view covers >40 % of data.
    // raw, and the six pooled series (filtered/tonic/phasic/em_fog etc.), had
    // their range computed as a by-product of the fill loop in
    // _ensureSeriesPool() / _fillSeries(); only the threshold-dependent metric
    // curves, rebuilt fresh every analyze() by their own functions, are
    // scanned here.
    this._globalRange = {};
    if (this._rawGlobalRange) this._globalRange.raw = this._rawGlobalRange;
    for (const key of ['filtered', 'tonic', 'phasic']) {
      const r = this._seriesRange[key];
      if (r) this._globalRange[key] = r;
    }
    for (const key of ['peakDensity', 'phasicAUC', 'arousalIndex', 'triIndex']) {
      const arr = this[key];
      if (!arr || arr.length === 0) continue;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i].val;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this._globalRange[key] = { min: mn, max: mx };
    }
    if (this._seriesRange.em_fog) this._globalRange.em_fog = this._seriesRange.em_fog;

    // Reset per-redraw cache (recomputed once by draw())
    this.rawMinMaxCached = null;

    // Timeline waveform: sub-sampled from raw in _ensureSeriesPool() (raw-only).
    this._timelinePoints = this._timelinePointsCache || [];

    // Timeline peak positions as fraction of total duration (exclude excluded peaks)
    this._timelinePeakPct = [];
    if (this.peaks.length > 0 && this.raw.length > 0) {
      const totalDur = this.raw[this.raw.length - 1].time - this.raw[0].time;
      if (totalDur > 0) {
        this._timelinePeakPct = this.peaks
          .filter(pk => !pk.excluded)
          .map(pk => pk.time / totalDur);
      }
    }
  }

  _findOnsetIndex(vals, i, maxOnsetSteps) {
    let onsetIdx = i;
    let onsetSteps = 0;
    while (onsetIdx > 0 && vals[onsetIdx] > 0 && onsetSteps < maxOnsetSteps) {
      if (onsetIdx < i && vals[onsetIdx] < vals[onsetIdx - 1]) break;
      onsetIdx--;
      onsetSteps++;
    }
    return onsetIdx;
  }

  _findRecoveryIndex(vals, i, onsetIdx, amplitude) {
    const halfDecayVal = vals[onsetIdx] + amplitude * 0.5;
    const n = vals.length;
    for (let j = i + 1; j < n; j++) {
      if (vals[j] <= halfDecayVal) return j;
      if (j < n - 1 && vals[j] < vals[j + 1] &&
          vals[j] > halfDecayVal + GSR_CONST.PEAK_RECOVERY_BREAK) break;
    }
    return -1;
  }

  _calculateShapeMetrics(vals, times, i, onsetIdx, recoveryIdx, noiseHalfWin) {
    const curr = vals[i];
    const amplitude = curr - vals[onsetIdx];
    const riseTime = times[i] - times[onsetIdx];
    const onsetSlope = riseTime > 0 ? amplitude / riseTime : 0;
    const halfRecoveryTime = recoveryIdx !== -1 ? times[recoveryIdx] - times[i] : -1;
    const decaySlope = halfRecoveryTime > 0 ? (vals[i] - vals[recoveryIdx]) / halfRecoveryTime : 0;
    const skewnessRatio = halfRecoveryTime > 0 ? riseTime / halfRecoveryTime : 0;

    const halfDecayVal = vals[onsetIdx] + amplitude * 0.5;
    let fwhmStart = onsetIdx;
    for (let j = onsetIdx; j <= i; j++) {
      if (vals[j] >= halfDecayVal) { fwhmStart = j; break; }
    }
    const fwhm = recoveryIdx !== -1 ? times[recoveryIdx] - times[fwhmStart] : -1;

    const noiseFloor = this._computeNoiseFloor(onsetIdx, noiseHalfWin);
    const snr = noiseFloor > 0 ? amplitude / noiseFloor : 0;

    return {
      amplitude,
      riseTime,
      onsetSlope,
      halfRecoveryTime,
      decaySlope,
      skewnessRatio,
      fwhm,
      snr
    };
  }

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
   */
  _computeNoiseFloor(idx, halfWindow) {
    const filtered = this.filtered;
    const start = Math.max(1, idx - halfWindow);
    const end = Math.min(filtered.length - 1, idx + halfWindow);
    let sum = 0, sumSq = 0, count = 0;
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
  }

  /**
   * Compute a quality score (0–1) for a detected peak from how well its
   * shape matches a canonical SCR.
   *
   * The score is the earned fraction of the *applicable* weight, not of the
   * full weight total. Recovery time, skewness and decay slope can only be
   * measured once the response has settled back toward baseline — when the
   * next SCR starts first (a peak in a cluster) or the recording ends,
   * _findRecoveryIndex() returns -1 and those three are simply left out of
   * the denominator rather than scored zero. Otherwise a genuine response
   * that happens to sit inside a burst lost 0.40 of its possible score for a
   * reason that has nothing to do with whether it is a real response — the
   * exact peaks a high Min-Quality setting should keep, not cut.
   */
  _computePeakQuality(peak) {
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
      if (peak.onsetSlope >= 0.01 && peak.onsetSlope <= 1.0) score += W.onsetSlope;
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
      if (peak.halfRecoveryTime >= 0.5 && peak.halfRecoveryTime <= 4.0) score += W.recoveryTime;
      else if (peak.halfRecoveryTime <= 8.0) score += W.recoveryTime * 0.5;

      // Skewness: classic SCR rises fast, recovers slow (ratio <= 1).
      if (peak.skewnessRatio > 0 && peak.skewnessRatio <= 1.0) score += W.skewness;
      else if (peak.skewnessRatio > 1.0 && peak.skewnessRatio <= 2.0) score += W.skewness * 0.6;
      else if (peak.skewnessRatio > 2.0 && peak.skewnessRatio <= 4.0) score += W.skewness * 0.3;

      // Decay slope: recovery limb must be going somewhere (µS/s).
      if (peak.decaySlope > 0.001) score += W.decaySlope;
    }

    if (applicable <= 0) return 0;
    return Math.min(1, Math.max(0, score / applicable));
  }

  /**
   * Quality score (0–1) for a deconvolution-mode peak.
   *
   * NOTE: this is deliberately a *different* formula from _computePeakQuality(),
   * not a shared call with different inputs — reusing the shape-based formula
   * unchanged for deconvolution peaks was tried first and found to be wrong.
   *
   * Under the fixed-kernel SCRF model (Benedek & Kaernbach, 2010 — see the
   * SCRF class comment in constants.js), every deconvolution peak shares the
   * exact same riseTime, halfRecoveryTime, skewnessRatio and fwhm by
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
   * Feeding _computePeakQuality()'s weights unchanged into that reality gave
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
  _computeDeconPeakQuality(peak) {
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
  }

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
   * don't share one correct granularity. The discrete peak count (this.peaks)
   * is trying to be an honest census of distinct SCR events — how many
   * separate things happened — a question the earlier chain-merge
   * consolidation bug (see _detectPeaksFromCurve()'s doc comment) actively
   * hurt. Phasic AUC (computePhasicAUC) is a continuous, 30s-windowed
   * measure of total phasic activation, already fairly robust to exactly how
   * many discrete atoms happened to compose a burst, since it integrates the
   * reconstructed signal directly rather than iterating peaks. Salience adds
   * a third view: one score per already-correctly-separated peak, so the
   * standout moments can be picked out from the full census without
   * confusing "how many events happened" with "which ones were memorable."
   *
   * Blends Amplitude (50%), Steepest Rise / Onset Slope (30%), and Local Contrast / SNR (20%).
   * - Amplitude measures total response magnitude (saturating at 0.5 µS).
   * - Onset slope (amplitude / riseTime) measures response suddenness (saturating at 0.5 µS/s).
   * - SNR (contrast against local background noise) suppresses duplicate follow-up peaks in a cluster (saturating at SNR = 3.0).
   */
  _computeSalienceScore(peak) {
    const ampScore = Math.min(1, Math.max(0, peak.amplitude / 0.5));
    const slope = peak.onsetSlope != null ? peak.onsetSlope : (peak.riseTime > 0 ? peak.amplitude / peak.riseTime : 0);
    const slopeScore = Math.min(1, Math.max(0, slope / 0.5));
    const snrScore = peak.snr != null ? Math.min(1, Math.max(0, peak.snr / 3.0)) : 0.5;
    return Math.min(1, Math.max(0, ampScore * 0.50 + slopeScore * 0.30 + snrScore * 0.20));
  }

  /**
   * Resolve the raw-sample index a peak's position should be evaluated
   * at, applying the GPS-latency shift.
   *
   * @param {object} peak - Peak object with { index, time }.
   * @param {number} peakLatency - Latency shift in seconds.
   * @returns {number} Raw data index corresponding to latency-shifted time.
   */
  resolveLatencyIndex(peak, peakLatency) {
    if (!(peakLatency > 0)) return (peak && peak.index !== undefined) ? peak.index : 0;
    const shiftedTime = Math.max(0, (peak && peak.time !== undefined ? peak.time : 0) - peakLatency);
    const si = this.findClosestIndex(shiftedTime);
    return si >= 0 ? si : ((peak && peak.index !== undefined) ? peak.index : 0);
  }

  /**
   * Resolve the raw-sample index a hotspot's position should be evaluated
   * at, applying the same GPS-latency shift the map actually renders
   * markers with.
   */
  _resolveHotspotIndex(peak, peakLatency) {
    return this.resolveLatencyIndex(peak, peakLatency);
  }

  /**
   * Great-circle distance between two lat/lon points, in metres. Mirrors
   * GeoUtils.haversineMeters (gps/geo_utils.js) — inlined here so the analyzer
   * stays loadable on its own, without the GPS-utils bundle (several unit
   * tests load analyzer.js in isolation). Only used for hotspot spacing.
   * @private
   */
  _haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Build the "hotspot" subset of this.peaks — the biggest SCRs, spread out
   * on the ground so no two crowd the same spot on the map.
   *
   * Ranking is by raw peak AMPLITUDE, descending — the clearest "how big was
   * this response" signal, and well-measured in every detector path.
   * salienceScore (amplitude/slope/SNR blend) is still computed per peak for
   * the peaks table but does not drive this.
   *
   * Count target is percentile-based: top HOTSPOT_PERCENTILE of active
   * (non-excluded) peaks, at least 1 — not a fixed score cutoff, which scales
   * with peak count rather than staying a small curated set. 2% was picked
   * from real-track yields; treat it as a tunable starting point.
   *
   * Spatial spacing: walking the amplitude-ranked list, a candidate is skipped
   * if it falls within MEMORABLE_EVENTS.MIN_SEPARATION_M of an already-selected
   * hotspot, measured at the latency-shifted marker position (the same one the
   * map renders). The biggest response in any neighbourhood wins its spot. A
   * spatially compact recording (a short loop walked repeatedly) can therefore
   * yield fewer than the percentile target — intended: better a handful of
   * distinct places than twenty markers on one corner.
   *
   * Peaks with no GPS fix (getCoordinates returns null) are skipped entirely,
   * not auto-included: GSRMapManager._renderHotspotMarkers() /
   * _renderCollectiveTrackHotspots() (map.js) both bail out with
   * `if (!coords) return;`, so an unrenderable peak selected here would
   * silently consume a slot and render nothing.
   *
   * @param {object} params - Analysis params (may carry hotspotPercentile).
   * @param {number} peakLatency - GPS peak-latency shift (s) for marker position.
   * @returns {Array<object>} Selected peak objects, biggest-amplitude first.
   * @private
   */
  _selectMemorableEvents(params, peakLatency = 0) {
    const ME = GSR_CONST.MEMORABLE_EVENTS;
    const activeSorted = this.peaks
      .filter(p => !p.excluded)
      .sort((a, b) => (b.amplitude - a.amplitude) || (a.time - b.time));
    if (activeSorted.length === 0) return [];

    const percentile = (params && params.hotspotPercentile != null)
      ? params.hotspotPercentile
      : ME.HOTSPOT_PERCENTILE;
    const targetCount = Math.max(1, Math.round(activeSorted.length * percentile));
    const minSepM = ME.MIN_SEPARATION_M != null ? ME.MIN_SEPARATION_M : 0;

    const selected = [];
    const selectedCoords = [];
    for (const p of activeSorted) {
      if (selected.length >= targetCount) break;
      const coords = this.getCoordinates(this._resolveHotspotIndex(p, peakLatency));
      if (!coords) continue;
      if (minSepM > 0 && selectedCoords.some(c =>
            this._haversineMeters(c.lat, c.lon, coords.lat, coords.lon) < minSepM)) {
        continue;
      }
      selected.push(p);
      selectedCoords.push(coords);
    }
    return selected;
  }

  /**
   * Snapshot any user-set labels and exclusion flags from the current peak list
   * so they survive re-analysis. Also merges labels/exclusions imported from a
   * re-loaded processed CSV (matched by time). Called at the top of both
   * detectPeaks() and _runDeconvolutionPipeline() before this.peaks is cleared.
   *
   * @returns {{ oldLabels: Map<number,string>, oldExcluded: Set<number> }}
   * @private
   */
  _preserveLabelsAndExclusions() {
    const oldLabels = new Map();
    const oldExcluded = new Set();
    for (const pk of this.peaks) {
      if (pk.label && pk.label.trim()) {
        this.setPeakLabel(pk.time, pk.label);
        oldLabels.set(pk.index, pk.label);
      }
      if (pk.excluded) oldExcluded.add(pk.index);
    }
    // Merge labels/exclusions imported from a re-loaded processed CSV (time-matched)
    if (this._importedPeakLabels && this._importedPeakLabels.size > 0) {
      for (const pk of this.peaks) {
        if (!pk.label || !pk.label.trim()) {
          const imported = this._importedPeakLabels.get(pk.time);
          if (imported) oldLabels.set(pk.index, imported);
        }
        if (!pk.excluded) {
          const importedEx = this._importedPeakExcluded && this._importedPeakExcluded.get(pk.time);
          if (importedEx) oldExcluded.add(pk.index);
        }
      }
    }
    return { oldLabels, oldExcluded };
  }

  detectPeaks(threshold, params) {
    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();
    this.peaks = [];
    const n = this.phasic.length;
    if (n < 3) return;

    const phasicVals = this.phasic.map(d => d.val);
    const times = this.phasic.map(d => d.time);
    const defaults = GSR_CONST.PEAK_SHAPE;

    // Use dynamic slider values when available, fall back to defaults
    const shape = {
      MIN_RISE_TIME:     params && params.shapeMinRiseTime     != null ? params.shapeMinRiseTime     : defaults.MIN_RISE_TIME,
      MAX_RISE_TIME:     params && params.shapeMaxRiseTime     != null ? params.shapeMaxRiseTime     : defaults.MAX_RISE_TIME,
      MIN_HALF_RECOVERY: params && params.shapeMinHalfRecovery != null ? params.shapeMinHalfRecovery : defaults.MIN_HALF_RECOVERY,
      MAX_HALF_RECOVERY: params && params.shapeMaxHalfRecovery != null ? params.shapeMaxHalfRecovery : defaults.MAX_HALF_RECOVERY,
      MIN_ONSET_SLOPE:   defaults.MIN_ONSET_SLOPE,
      MAX_ONSET_SLOPE:   defaults.MAX_ONSET_SLOPE,
      MIN_DECAY_SLOPE:   defaults.MIN_DECAY_SLOPE,
      MAX_PEAK_WIDTH:    defaults.MAX_PEAK_WIDTH,
      MIN_SNR:           params && params.shapeMinSnr          != null ? params.shapeMinSnr          : defaults.MIN_SNR,
      SKEWNESS_RATIO_MIN: defaults.SKEWNESS_RATIO_MIN,
      SKEWNESS_RATIO_MAX: params && params.shapeMaxSkewRatio   != null ? params.shapeMaxSkewRatio   : defaults.SKEWNESS_RATIO_MAX,
      QUALITY_WEIGHTS:   defaults.QUALITY_WEIGHTS
    };

    for (let i = 1; i < n - 1; i++) {
      const prev = phasicVals[i - 1];
      const curr = phasicVals[i];
      const next = phasicVals[i + 1];

      // ── 1. Local maximum check ──────────────────────────────────────────
      if (!(curr > prev && curr >= next)) continue;
      if (curr < 0.001) continue; // Noise floor check to skip flat/zero regions

      // ── 2. Find onset ──────────────────────────────
      const maxRiseLimit = shape.MAX_RISE_TIME > 0 ? shape.MAX_RISE_TIME : defaults.MAX_RISE_TIME;
      const maxOnsetSteps = Math.round(maxRiseLimit * this.sampleRate);
      const onsetIdx = this._findOnsetIndex(phasicVals, i, maxOnsetSteps);

      const amplitude = curr - phasicVals[onsetIdx];
      if (amplitude < threshold) continue;

      // ── 3. Rise time ────────────────────────────
      const riseTime = times[i] - times[onsetIdx];
      const onsetSlope = riseTime > 0 ? amplitude / riseTime : 0;

      // Rise time bounds
      if (shape.MIN_RISE_TIME > 0 && riseTime < shape.MIN_RISE_TIME) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (shape.MAX_RISE_TIME > 0 && riseTime > shape.MAX_RISE_TIME) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (onsetSlope < shape.MIN_ONSET_SLOPE || onsetSlope > shape.MAX_ONSET_SLOPE) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 5. Half-recovery search ─────────────────────────────────────────
      const recoveryIdx = this._findRecoveryIndex(phasicVals, i, onsetIdx, amplitude);
      const halfRecoveryTime = recoveryIdx !== -1 ? times[recoveryIdx] - times[i] : -1;

      // ── 6. Decay / recovery metrics ─────────────────────────────────────
      const decaySlope = halfRecoveryTime > 0
        ? (phasicVals[i] - phasicVals[recoveryIdx]) / halfRecoveryTime
        : 0;
      const skewnessRatio = halfRecoveryTime > 0
        ? riseTime / halfRecoveryTime
        : 0;

      // Shape checks that require a valid half-recovery
      if (halfRecoveryTime >= 0) {
        if (shape.MIN_HALF_RECOVERY > 0 && halfRecoveryTime < shape.MIN_HALF_RECOVERY) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (shape.MAX_HALF_RECOVERY > 0 && halfRecoveryTime > shape.MAX_HALF_RECOVERY) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (decaySlope < shape.MIN_DECAY_SLOPE) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (skewnessRatio < shape.SKEWNESS_RATIO_MIN) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (shape.SKEWNESS_RATIO_MAX > 0 && skewnessRatio > shape.SKEWNESS_RATIO_MAX) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
      }

      // Compute FWHM and SNR using helper
      const noiseHalfWin = Math.max(1, Math.round(this.sampleRate));
      const metrics = this._calculateShapeMetrics(phasicVals, times, i, onsetIdx, recoveryIdx, noiseHalfWin);

      if (metrics.fwhm > 0 && metrics.fwhm > shape.MAX_PEAK_WIDTH) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      if (shape.MIN_SNR > 0 && metrics.snr < shape.MIN_SNR) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 10. Build peak object with full shape metrics ──────────────────
      const peak = this._buildPeakObject(i, curr, phasicVals, times,
        { ...metrics, onsetIdx, recoveryIdx },
        oldLabels, oldExcluded, true);

      // ── 11. Compute composite quality score ────────────────────────────
      peak.qualityScore = this._computePeakQuality(peak);
      peak.salienceScore = this._computeSalienceScore(peak);

      const minQuality = params && params.minPeakQuality != null ? params.minPeakQuality : 0.0;
      if (peak.qualityScore >= minQuality) {
        this.peaks.push(peak);
      }

      // Skip ahead to enforce minimum gap between peaks
      i = Math.min(n - 2, i + Math.round(GSR_CONST.PEAK_MIN_GAP * this.sampleRate));
    }
    this._assignLabelsToPeaks(this.peaks);
  }

  /**
   * Topographic prominence of every sample in `vals`, in O(n log n).
   *
   * Prominence of a local maximum is its height above the lowest col on the
   * path to any higher maximum (and, for the single global maximum, its
   * height above the signal's own minimum). This replaces an earlier
   * per-maximum left/right saddle walk that was O(n²) on a monotonic input
   * (every sample a local max, each walk O(n)).
   *
   * Method: activate samples in descending height order, tracking connected
   * runs with a union-find. Any already-active neighbour was activated at a
   * height ≥ this one, so when activating sample i merges two runs, the
   * current height vals[i] is a col between them; the shorter run's tallest
   * summit is now dominated and its prominence is fixed at (its height −
   * vals[i]). The one summit that is never dominated is the global maximum.
   *
   * @param {Array<number>|Float64Array} vals
   * @returns {Float64Array} prominence per index (callers only read indices
   *   they have already confirmed are local maxima).
   * @private
   */
  _topographicProminence(vals) {
    const n = vals.length;
    const prom = new Float64Array(n).fill(-1);
    if (n === 0) return prom;

    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const active = new Uint8Array(n);
    const compMax = new Float64Array(n);   // tallest height in the run (valid at root)
    const compPeak = new Int32Array(n);    // index of that tallest sample (valid at root)

    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };

    let vMin = Infinity;
    for (let i = 0; i < n; i++) if (vals[i] < vMin) vMin = vals[i];

    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => (vals[b] - vals[a]) || (a - b));

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
        if (prom[compPeak[lo]] < 0) prom[compPeak[lo]] = Math.max(0, compMax[lo] - c);
        parent[lo] = hi;
        ri = hi;
      }
    }

    // Any summit never dominated (the global max, or ties for it) is measured
    // to the signal's own minimum.
    for (let i = 0; i < n; i++) if (prom[i] < 0) prom[i] = Math.max(0, vals[i] - vMin);
    return prom;
  }

  /**
   * Above-threshold topographic-prominence local maxima under minimum-gap
   * non-max suppression. Feeds _detectPeaksCombined()'s apex-fix and rescue
   * steps from a single shared _topographicProminence() sweep.
   *
   * @param {Array<number>} vals - phasic signal.
   * @param {Float64Array} prom - per-sample topographic prominence (from _topographicProminence(vals)).
   * @param {number} threshold - prominence gate (peakThreshold, µS).
   * @param {number} minGap - non-max-suppression radius, in samples.
   * @param {number} baselineWin - trailing window for the pre-burst minimum, in samples.
   * @returns {Array<{i:number,prominence:number,baselineAmp:number}>}
   *   survivors, ascending by sample index.
   * @private
   */
  _prominenceNMS(vals, prom, threshold, minGap, baselineWin) {
    const n = vals.length;
    // Artefact ceiling: amplitude above this cannot be a real SCR. Electrode
    // disconnects, motion artefacts and ADC rail-hits produce spikes of
    // hundreds of µS; prominence has no implicit scale gate, so a massive
    // spike is simply very prominent. MICROSIEMENS_MAX_SCR (default 20 µS) is
    // well above the physiological maximum (~5 µS in extreme subjects).
    const maxScrAmp = GSR_CONST.MICROSIEMENS_MAX_SCR != null
      ? GSR_CONST.MICROSIEMENS_MAX_SCR : 20;
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
      const baselineAmp = vals[i] - mn;
      // Ceiling re-checked against baseline amplitude so a large-but-real event
      // riding a raised tonic is assessed from its pre-burst level, not zero.
      if (baselineAmp > maxScrAmp) continue;
      cand.push({ i, prominence: prom[i], baselineAmp });
    }

    // Minimum-gap non-max suppression — largest prominence wins, same
    // convention as detectPeaks()'s forward skip-ahead.
    cand.sort((a, b) => b.prominence - a.prominence);
    const kept = [];
    for (const c of cand) {
      if (!kept.some(k => Math.abs(k.i - c.i) < minGap)) kept.push(c);
    }
    kept.sort((a, b) => a.i - b.i);
    return kept;
  }

  /**
   * Combined phasic peak detector — the union of trough-to-peak and prominence.
   *
   * Runs the default trough-to-peak detectPeaks() as the base list, then uses a
   * single shared topographic-prominence sweep for two corrections:
   *
   *  1. APEX FIX. detectPeaks() scans left→right and accepts the first local
   *     maximum in a rising cluster that clears its shape gates, then skips
   *     PEAK_MIN_GAP ahead — so on a compound rise the marker is stranded on a
   *     shoulder while the true summit, a second later, is never revisited.
   *     Each base peak is moved to the most topographically-prominent local
   *     maximum within ±PEAK_MIN_GAP of it (measured across all 64 real tracks:
   *     ~5% of peaks move, always onto a higher sample; median move 0 s).
   *
   *  2. RESCUES. The prominence detector's above-threshold maxima that sit
   *     more than PEAK_MIN_GAP from every base peak — the compound-burst SCRs
   *     the greedy scan jumped over (~2% of the final list). Their reported
   *     shape metrics use the same _findOnsetIndex() saddle measurement as the
   *     base peaks (one consistent formula across the list), not the
   *     prominence detector's trailing-baseline amplitude. A rescue is gated
   *     only by its topographic prominence (>= peakThreshold) and Min Peak
   *     Quality — NOT by the shape gates or the Min SNR floor, both of which
   *     assume a trustworthy trough-to-peak amplitude that a compound-burst
   *     shoulder does not have.
   *
   * Cost: detectPeaks() + one _topographicProminence() (O(n log n)) + one
   * _prominenceNMS() + an O(base + kept) two-pointer reconciliation. The
   * prominence sweep and the local-maxima scan each run exactly once; per-peak
   * shape work is paid once for the base (in detectPeaks) and once per rescue
   * (a few per track) — never twice for the same event.
   *
   * @param {object} params - Analysis params (peakThreshold, shape gates, minPeakQuality).
   * @private
   */
  _detectPeaksCombined(params) {
    // Combined mode identifies peaks by topographic prominence + SNR + quality,
    // NOT morphology: the rise / half-recovery / skew sliders are hidden for
    // this mode in the UI (events.js:updateShapeSlidersForDetector). Force them
    // off for the base trough-to-peak pass too, so a bound left over from
    // trough-to-peak mode can't have a hidden marginal effect — measured across
    // all 64 real tracks this changes the output by 0 peaks (the rescue step
    // re-adds anything a tightened base gate would drop).
    //
    // Min SNR and Min Peak Quality DO reach the base pass (via detectPeaks
    // below), so they still gate the base list; the rescues are held only to
    // prominence + Min Peak Quality (see step 2). peakThreshold, the always-on
    // structural checks (onset/decay slope, FWHM, skew floor) and the min-gap
    // all still apply to the base via detectPeaks().
    const baseParams = {
      ...params,
      shapeMinRiseTime: 0, shapeMaxRiseTime: 0,
      shapeMinHalfRecovery: 0, shapeMaxHalfRecovery: 0,
      shapeMaxSkewRatio: 0,
    };
    this.detectPeaks(params.peakThreshold, baseParams);
    const base = this.peaks;

    const n = this.phasic.length;
    if (n < 3) return;

    const vals = this.phasic.map(d => d.val);
    const times = this.phasic.map(d => d.time);
    const sr = this.sampleRate;
    const threshold = params.peakThreshold;
    const minGap = Math.max(1, Math.round(GSR_CONST.PEAK_MIN_GAP * sr));
    const baselineWin = Math.max(1, Math.round((GSR_CONST.PEAK_PROMINENCE_BASELINE_SEC || 8) * sr));
    const noiseHalfWin = Math.max(1, Math.round(sr));
    // Shape gates are off in this mode, so the onset walk-back for relocations
    // and rescues uses the generous canonical MAX_RISE_TIME bound.
    const maxOnsetSteps = Math.round(GSR_CONST.PEAK_SHAPE.MAX_RISE_TIME * sr);

    // One shared prominence sweep feeds both the apex fix and the rescue search.
    const prom = this._topographicProminence(vals);
    const kept = this._prominenceNMS(vals, prom, threshold, minGap, baselineWin);
    if (kept.length === 0) return; // nothing prominence can add or correct

    // Rebuild the label/exclusion maps from the base list (current indices), so
    // a relocated or rescued peak still resolves an imported/user label by time.
    const oldLabels = new Map();
    const oldExcluded = new Set();
    for (const p of base) {
      if (p.label && p.label.trim()) oldLabels.set(p.index, p.label);
      if (p.excluded) oldExcluded.add(p.index);
    }

    // ── 1. Apex fix — two-pointer sweep of base (index-sorted) × kept
    //       (index-sorted). Each kept entry is claimed at most once.
    const keptUsed = new Uint8Array(kept.length);
    let lo = 0;
    for (let bi = 0; bi < base.length; bi++) {
      const p = base[bi];
      while (lo < kept.length && kept[lo].i < p.index - minGap) lo++;
      let bestK = -1;
      let bestProm = prom[p.index];
      for (let j = lo; j < kept.length && kept[j].i <= p.index + minGap; j++) {
        if (keptUsed[j]) continue;
        if (kept[j].i === p.index) { keptUsed[j] = 1; continue; } // already on the apex
        if (kept[j].prominence > bestProm) { bestProm = kept[j].prominence; bestK = j; }
      }
      if (bestK >= 0) {
        keptUsed[bestK] = 1;
        base[bi] = this._rebuildPeakAt(kept[bestK].i, vals, times, prom,
          maxOnsetSteps, noiseHalfWin, oldLabels, oldExcluded, p);
      }
    }
    // Every peak in the merged list carries its topographic prominence (a base
    // peak that was not relocated still needs the field for the peaks table).
    // Base peaks are kept whatever their prominence — the union deliberately
    // retains the trough-to-peak finds that do not clear the prominence gate.
    for (const p of base) if (p.prominence == null) p.prominence = prom[p.index] || 0;

    // ── 2. Rescues — un-claimed kept maxima with no base peak within PEAK_MIN_GAP
    //       of their (post-move) index.
    const baseIdx = base.map(p => p.index).sort((a, b) => a - b);
    const nearBase = (idx) => {
      let a = 0, b = baseIdx.length;
      while (a < b) { const m = (a + b) >> 1; if (baseIdx[m] < idx) a = m + 1; else b = m; }
      for (let k = a - 1; k <= a + 1; k++) {
        if (k >= 0 && k < baseIdx.length && Math.abs(baseIdx[k] - idx) < minGap) return true;
      }
      return false;
    };

    const minQuality = (params && params.minPeakQuality != null) ? params.minPeakQuality : 0.0;
    const rescues = [];
    for (let j = 0; j < kept.length; j++) {
      if (keptUsed[j]) continue;
      const idx = kept[j].i;
      if (nearBase(idx)) continue;
      const rp = this._rebuildPeakAt(idx, vals, times, prom,
        maxOnsetSteps, noiseHalfWin, oldLabels, oldExcluded, null);
      // A rescue is identified by topographic prominence >= peakThreshold, so
      // that is the gate it is held to. The trough-to-peak shape gates and the
      // Min SNR floor are NOT re-applied: rescues exist precisely because those
      // checks, fed a shoulder-referenced amplitude, rejected a real event, and
      // _rebuildPeakAt() measures amplitude the same saddle way — so SNR
      // (= amplitude / noise) is deflated for exactly these peaks and would
      // delete the ones the rescue step is there to recover. Min Peak Quality
      // still applies (off by default); a user who raises it is explicitly
      // asking for it across the whole list.
      if (rp.qualityScore < minQuality) continue;
      rescues.push(rp);
    }

    // ── 3. Merge, enforce PEAK_MIN_GAP (an apex move can push two base peaks
    //       together), sort by time, reassign labels.
    const merged = base.concat(rescues).sort((a, b) => a.index - b.index);
    const out = [];
    for (const p of merged) {
      const last = out[out.length - 1];
      if (last && p.index - last.index < minGap) {
        if ((p.prominence || 0) > (last.prominence || 0)) out[out.length - 1] = p;
      } else {
        out.push(p);
      }
    }
    out.sort((a, b) => a.time - b.time);
    this.peaks = out;
    this._assignLabelsToPeaks(this.peaks);
  }

  /**
   * Build a peak object at sample `idx` using the trough-to-peak measurement
   * (_findOnsetIndex saddle onset + _calculateShapeMetrics), for
   * _detectPeaksCombined()'s apex relocations and rescues. When `carry` is a
   * peak object its user label/exclusion are copied onto the result (the move
   * changes the index key those would otherwise be looked up by).
   * @private
   */
  _rebuildPeakAt(idx, vals, times, prom, maxOnsetSteps, noiseHalfWin, oldLabels, oldExcluded, carry) {
    const onsetIdx = this._findOnsetIndex(vals, idx, maxOnsetSteps);
    const recoveryIdx = this._findRecoveryIndex(vals, idx, onsetIdx, vals[idx] - vals[onsetIdx]);
    const metrics = this._calculateShapeMetrics(vals, times, idx, onsetIdx, recoveryIdx, noiseHalfWin);
    const peak = this._buildPeakObject(idx, vals[idx], vals, times,
      { ...metrics, onsetIdx, recoveryIdx }, oldLabels, oldExcluded, true);
    peak.prominence = prom[idx];
    peak.qualityScore = this._computePeakQuality(peak);
    peak.salienceScore = this._computeSalienceScore(peak);
    if (carry) {
      if (carry.label) peak.label = carry.label;
      if (carry.excluded) peak.excluded = true;
    }
    return peak;
  }

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
   * @param {number|null} windowSizeSec - Spotlight time window in seconds (default: GSR_CONST.TEMPORAL_PEAK_DENSITY.windowSizeSec || 60)
   * @returns {Array<{time: number, val: number}>}
   */
  computeTemporalPeakDensity(windowSizeSec = null) {
    const n = this.phasic.length;
    if (n === 0) return [];

    const activePeakTimes = this.peaks
      .filter(p => !p.excluded)
      .map(p => p.time);
    const m = activePeakTimes.length;

    // Fast path: no active peaks -> return zero-density series directly
    if (m === 0) {
      const emptyDensity = new Array(n);
      for (let i = 0; i < n; i++) {
        emptyDensity[i] = { time: this.phasic[i].time, val: 0 };
      }
      return emptyDensity;
    }

    const dCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.TEMPORAL_PEAK_DENSITY) || {};
    const winSec = (windowSizeSec != null && windowSizeSec > 0) ? windowSizeSec : (dCfg.windowSizeSec || 60);
    const sigmaRatio = dCfg.sigmaRatio || 0.25;
    const sigma = winSec * sigmaRatio;
    const cutoffMult = dCfg.cutoffMultiplier || 3.5;
    const scaleFactor = dCfg.scaleToPerMinute || 60.0;

    const invTwoSigmaSq = 1.0 / (2.0 * sigma * sigma);
    const maxDist = cutoffMult * sigma;
    const normFactor = scaleFactor / (Math.sqrt(2.0 * Math.PI) * sigma);

    const density = new Array(n);
    let lo = 0, hi = 0;

    for (let i = 0; i < n; i++) {
      const t = this.phasic[i].time;
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
        val: kernelSum * normFactor
      };
    }
    return density;
  }

  /**
   * Sliding-window Phasic Area Under the Curve, in µS·s — an ISCR-*inspired*
   * continuous metric, not a reproduction of Benedek & Kaernbach's (2010)
   * published Integrated Skin Conductance Response. Their ISCR integrates a
   * deconvolved "phasic driver" signal (nonnegative deconvolution against a
   * canonical bi-exponential SCR kernel), which is what properly separates
   * overlapping/superposed SCRs. This integrates the simpler tonic-subtracted
   * phasic signal produced by analyze() instead — no deconvolution — so it
   * meaningfully softens (but doesn't fully solve, the way true deconvolution
   * would) the "superposition problem" and the amplitude-threshold cliff-edge
   * described in docs/environmental_stress_literature_review.md §5B/§5D.
   *
   * Uses a *centred* window (±windowSizeSec/2), matching
   * computeTemporalPeakDensity's convention, so the two continuous metrics
   * stay time-aligned with each other — a single spike is smeared
   * symmetrically around its own timestamp in both series rather than
   * appearing to "start" at the spike in one and being centred on it in
   * the other.
   *
   * @param {number} windowSizeSec - Temporal window width in seconds (default: 30)
   */
  computePhasicAUC(windowSizeSec = 30) {
    const n = this.phasic.length;
    if (n === 0) return [];

    const auc = new Array(n);
    const halfWin = windowSizeSec / 2;

    let lo = 0, hi = 0;
    let runningSum = 0;

    for (let i = 0; i < n; i++) {
      const t = this.phasic[i].time;
      const tStart = t - halfWin;
      const tEnd = t + halfWin;

      // Advance the trailing edge to include samples entering the window.
      // this.phasic is already clamped to ≥0 during decomposition (see
      // analyze()), but re-clamp defensively in case this is called against
      // externally-supplied phasic data.
      while (hi < n && this.phasic[hi].time <= tEnd) {
        runningSum += Math.max(0, this.phasic[hi].val);
        hi++;
      }
      // Advance the leading edge to drop samples that have fallen out of the window.
      while (lo < n && this.phasic[lo].time < tStart) {
        runningSum -= Math.max(0, this.phasic[lo].val);
        lo++;
      }

      auc[i] = {
        time: t,
        val: runningSum / this.sampleRate // Convert running sum to a time-integral (µS·s)
      };
    }
    return auc;
  }

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
   * @param {number} wTonic - Weight for tonic SCL component (default: 0.3)
   * @param {number} wPhasic - Weight for phasic AUC component (default: 0.7)
   * @param {Array|null} precomputedAUC - Optional already-computed phasicAUC array
   *   (same 30 s window). When supplied by analyze(), skips the redundant
   *   computePhasicAUC(30) call (§B perf fix 2026-08-07).
   */
  computeCombinedArousalIndex(wTonic = 0.3, wPhasic = 0.7, precomputedAUC = null) {
    const n = this.phasic.length;
    if (n === 0) return [];

    // §B perf fix: reuse caller-supplied AUC instead of recomputing it.
    // When called standalone (e.g. tests, external code), falls back to
    // computing it fresh — same behaviour as before this fix.
    const auc = precomputedAUC || this.computePhasicAUC(30);

    // §B perf fix: compute mean/std in a single pass over this.tonic and auc
    // directly, eliminating the two O(N) .map(d => d.val) intermediate arrays
    // that were previously allocated only to pass into GsrFilter.calculateStats().
    let tSum = 0, tSumSq = 0, aSum = 0, aSumSq = 0;
    for (let i = 0; i < n; i++) {
      const tv = this.tonic[i].val;
      const av = auc[i].val;
      tSum += tv; tSumSq += tv * tv;
      aSum += av; aSumSq += av * av;
    }
    const tMean = tSum / n;
    const tStd = Math.sqrt(Math.max(0, tSumSq / n - tMean * tMean)) || 1;
    const aMean = aSum / n;
    const aStd = Math.sqrt(Math.max(0, aSumSq / n - aMean * aMean)) || 1;

    const arousalIndex = new Array(n);
    for (let i = 0; i < n; i++) {
      const tZ = (this.tonic[i].val - tMean) / tStd;
      const aZ = (auc[i].val - aMean) / aStd;
      arousalIndex[i] = {
        time: this.phasic[i].time,
        val: (wTonic * tZ) + (wPhasic * aZ)
      };
    }
    return arousalIndex;
  }

  /**
   * Tri Index — a weighted, per-participant z-scored blend of tonic baseline
   * (SCL), phasic AUC (ISCR), and temporal peak density (NS-SCR frequency).
   *
   * The default weights (0.10 Tonic / 0.45 Phasic AUC / 0.45 Peak Density)
   * prioritise acute event volume and sympathetic burst frequency while
   * anchoring to baseline tone and mitigating slow thermal/sweat drift.
   *
   * @param {number} wTonic - Weight for tonic SCL component (default: 0.10)
   * @param {number} wPhasic - Weight for phasic AUC component (default: 0.45)
   * @param {number} wDensity - Weight for temporal peak density component (default: 0.45)
   * @param {Array|null} precomputedAUC - Optional already-computed phasicAUC array
   * @param {Array|null} precomputedDensity - Optional already-computed peakDensity array
   * @returns {Array<{time: number, val: number}>}
   */
  computeTriIndex(wTonic = 0.10, wPhasic = 0.45, wDensity = 0.45, precomputedAUC = null, precomputedDensity = null) {
    const n = this.phasic.length;
    if (n === 0) return [];

    const auc = precomputedAUC || this.computePhasicAUC(30);
    const density = precomputedDensity || this.computeTemporalPeakDensity();

    let tSum = 0, tSumSq = 0, aSum = 0, aSumSq = 0, dSum = 0, dSumSq = 0;
    for (let i = 0; i < n; i++) {
      const tv = this.tonic[i].val;
      const av = auc[i].val;
      const dv = density[i].val;
      tSum += tv; tSumSq += tv * tv;
      aSum += av; aSumSq += av * av;
      dSum += dv; dSumSq += dv * dv;
    }
    const tMean = tSum / n;
    const tStd = Math.sqrt(Math.max(0, tSumSq / n - tMean * tMean)) || 1;
    const aMean = aSum / n;
    const aStd = Math.sqrt(Math.max(0, aSumSq / n - aMean * aMean)) || 1;
    const dMean = dSum / n;
    const dStd = Math.sqrt(Math.max(0, dSumSq / n - dMean * dMean)) || 1;

    const triIndex = new Array(n);
    for (let i = 0; i < n; i++) {
      const tZ = (this.tonic[i].val - tMean) / tStd;
      const aZ = (auc[i].val - aMean) / aStd;
      const dZ = (density[i].val - dMean) / dStd;
      triIndex[i] = {
        time: this.phasic[i].time,
        val: (wTonic * tZ) + (wPhasic * aZ) + (wDensity * dZ)
      };
    }
    return triIndex;
  }

  getStats() {
    if (this.raw.length === 0) {
      return {
        duration: 0,
        meanSCL: 0,
        peakCount: 0,
        peakFrequency: 0,
        meanPeakAmplitude: 0,
        meanPhasicAUC: 0
      };
    }

    const duration = this.raw[this.raw.length - 1].time - this.raw[0].time;
    const sumTonic = this.tonic.reduce((sum, d) => sum + d.val, 0);
    const meanSCL = sumTonic / this.tonic.length;

    const durationMinutes = duration / 60.0;
    const activePeaks = this.peaks.filter(p => !p.excluded);
    const peakCount = activePeaks.length;
    const peakFrequency = durationMinutes > 0 ? (peakCount / durationMinutes) : 0;

    const sumAmp = activePeaks.reduce((sum, p) => sum + p.amplitude, 0);
    const meanPeakAmplitude = peakCount > 0 ? (sumAmp / peakCount) : 0;

    // Mean of the sliding-window Phasic AUC series — a threshold-independent
    // companion to peakFrequency/meanPeakAmplitude (µS·s, 30s window).
    const meanPhasicAUC = this.phasicAUC.length > 0
      ? this.phasicAUC.reduce((sum, d) => sum + d.val, 0) / this.phasicAUC.length
      : 0;

    return {
      duration: duration,
      meanSCL: meanSCL,
      peakCount: peakCount,
      peakFrequency: peakFrequency,
      meanPeakAmplitude: meanPeakAmplitude,
      meanPhasicAUC: meanPhasicAUC
    };
  }

  exportToCSV(params, gpsParams) {
    if (this.raw.length === 0) return "";

    // Guard: if analysis hasn't been run, filtered/tonic/phasic are empty
    if (this.filtered.length === 0 || this.tonic.length === 0 || this.phasic.length === 0) {
      return "";
    }

    const hasFilteredGps = this.filteredGps && this.filteredGps.length === this.raw.length;
    const isEnriched = this.isEnriched;
    // GPS quality fields (hdop/pdop/hacc_m/fix_type/sats/speed_kts/course_deg) feed the
    // Kalman noise model and the maxHdop/maxSpeed/minFixType gates (gps_filter.js,
    // gps_pipeline.js). Without them a reloaded processed CSV can't be meaningfully
    // reprocessed with different GPS slider values, so preserve them when present.
    const hasGpsQuality = this.raw.some(d =>
      (!isNaN(d.hdop) || !isNaN(d.pdop) || !isNaN(d.hacc) || !isNaN(d.speedKts) || !isNaN(d.course) ||
       d.fixType || d.sats)
    );

    const hasRssi300 = this.raw.some(d => !isNaN(d.rssi_300));
    const hasRssi315 = this.raw.some(d => !isNaN(d.rssi_315));
    const hasRssi434 = this.raw.some(d => !isNaN(d.rssi_434));
    const hasRssi446 = this.raw.some(d => !isNaN(d.rssi_446));
    const hasRssi815 = this.raw.some(d => !isNaN(d.rssi_815));
    const hasRssi868 = this.raw.some(d => !isNaN(d.rssi_868));
    const hasRssi915 = this.raw.some(d => !isNaN(d.rssi_915));
    const hasEmFog   = this.raw.some(d => !isNaN(d.em_fog));

    const hasRf = hasRssi300 || hasRssi315 || hasRssi434 || hasRssi446 || hasRssi815 || hasRssi868 || hasRssi915 || hasEmFog;

    // Preserve recording start time and configurations for re-import
    let csv = `# RecordingStartTime:${this.recordingStartTime}\n`;
    if (params) {
      csv += `# FilterParams:${JSON.stringify(params)}\n`;
    }
    if (gpsParams) {
      csv += `# GpsFilterParams:${JSON.stringify(gpsParams)}\n`;
    }
    if (isEnriched) {
      csv += `# EnrichmentRadius:${this.enrichmentRadius}\n`;
    }
    csv += "Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude,PeakLabel,PeakExcluded,Latitude,Longitude";
    if (hasFilteredGps) {
      // Named "Pre-Kalman", not "Raw" — a header containing "raw" collides with
      // GSR_KEYWORDS ('raw' is a GSR-column keyword, checked before lat/lon
      // detection in parseCSV), which silently swallows the column into the
      // gsr_raw branch and makes it unrecoverable on reimport. See gps_pipeline.js
      // applyPreKalmanFilters for what "pre-Kalman" means here.
      csv += ",Pre-Kalman Latitude,Pre-Kalman Longitude";
    }
    if (hasGpsQuality) {
      csv += ",hdop,pdop,hacc_m,fix_type,sats,speed_kts,course_deg,is_gps_fix";
    }
    if (hasRf) {
      if (hasRssi300) csv += ",rssi_300";
      if (hasRssi315) csv += ",rssi_315";
      if (hasRssi434) csv += ",rssi_434";
      if (hasRssi446) csv += ",rssi_446";
      if (hasRssi815) csv += ",rssi_815";
      if (hasRssi868) csv += ",rssi_868";
      if (hasRssi915) csv += ",rssi_915";
      if (hasEmFog)   csv += ",em_fog";
    }
    if (isEnriched) {
      csv += ",osm_road_class,osm_dist_major_road,osm_in_park,osm_green_pct_50m,osm_building_density_50m,osm_dist_water,osm_tree_density_50m,osm_amenity_count_50m";
    }
    csv += "\n";

    // Build O(1) peak lookup map (avoid O(n²) .find() inside the loop)
    const peakByIndex = new Map();
    for (let pi = 0; pi < this.peaks.length; pi++) {
      peakByIndex.set(this.peaks[pi].index, this.peaks[pi]);
    }

    for (let i = 0; i < this.raw.length; i++) {
      let isPeak = 0;
      let peakAmp = "";
      let peakLabel = "";
      let peakExcluded = "";
      
      const peak = peakByIndex.get(i);
      if (peak) {
        isPeak = 1;
        peakAmp = peak.amplitude.toFixed(4);
        peakLabel = peak.label || "";
        peakExcluded = peak.excluded ? "1" : "0";
      }

      let latVal = this.raw[i].lat;
      let lonVal = this.raw[i].lon;
      let rawLatVal = NaN;
      let rawLonVal = NaN;

      if (hasFilteredGps) {
        rawLatVal = latVal;
        rawLonVal = lonVal;
        latVal = this.filteredGps[i].lat;
        lonVal = this.filteredGps[i].lon;
      }

      const latStr = (latVal !== null && latVal !== undefined && !isNaN(latVal)) ? latVal.toFixed(6) : "";
      const lonStr = (lonVal !== null && lonVal !== undefined && !isNaN(lonVal)) ? lonVal.toFixed(6) : "";
      const rawLatStr = (rawLatVal !== null && rawLatVal !== undefined && !isNaN(rawLatVal)) ? rawLatVal.toFixed(6) : "";
      const rawLonStr = (rawLonVal !== null && rawLonVal !== undefined && !isNaN(rawLonVal)) ? rawLonVal.toFixed(6) : "";

      csv += `${this.raw[i].time.toFixed(3)},` +
             `${this.raw[i].val.toFixed(4)},` +
             `${this.filtered[i].val.toFixed(4)},` +
             `${this.tonic[i].val.toFixed(4)},` +
             `${this.phasic[i].val.toFixed(4)},` +
             `${isPeak},` +
             `${peakAmp},` +
             `${GSRCSVParser._csvEscape(peakLabel)},` +
             `${peakExcluded},` +
             `${latStr},` +
             `${lonStr}`;

      if (hasFilteredGps) {
        csv += `,${rawLatStr},${rawLonStr}`;
      }

      if (hasGpsQuality) {
        const r = this.raw[i];
        // Only genuine fix rows carry real quality metadata — interpolated rows
        // are step-held in memory (see the interpolation pass in parseCSV) but
        // exporting that fabricated data would make every reimported row look
        // like an independent anchor, collapsing map.js's anchor-only Kalman
        // input back down to the dense interpolated grid. Leaving them blank
        // mirrors how the original device CSV itself encodes "no fix this tick".
        const isFix = !!r._isGpsFix;
        const hdopStr     = (isFix && !isNaN(r.hdop))     ? r.hdop.toFixed(2)     : "";
        const pdopStr     = (isFix && !isNaN(r.pdop))     ? r.pdop.toFixed(2)     : "";
        const haccStr     = (isFix && !isNaN(r.hacc))     ? r.hacc.toFixed(2)     : "";
        const speedKtsStr = (isFix && !isNaN(r.speedKts)) ? r.speedKts.toFixed(2) : "";
        const courseStr   = (isFix && !isNaN(r.course))   ? r.course.toFixed(1)   : "";
        const fixTypeStr  = isFix ? (r.fixType || 0) : "";
        const satsStr     = isFix ? (r.sats || 0) : "";
        csv += `,${hdopStr},${pdopStr},${haccStr},${fixTypeStr},${satsStr},${speedKtsStr},${courseStr},${isFix ? 1 : 0}`;
      }

      if (hasRf) {
        const r = this.raw[i];
        if (hasRssi300) csv += `,${(!isNaN(r.rssi_300)) ? r.rssi_300.toFixed(1) : ""}`;
        if (hasRssi315) csv += `,${(!isNaN(r.rssi_315)) ? r.rssi_315.toFixed(1) : ""}`;
        if (hasRssi434) csv += `,${(!isNaN(r.rssi_434)) ? r.rssi_434.toFixed(1) : ""}`;
        if (hasRssi446) csv += `,${(!isNaN(r.rssi_446)) ? r.rssi_446.toFixed(1) : ""}`;
        if (hasRssi815) csv += `,${(!isNaN(r.rssi_815)) ? r.rssi_815.toFixed(1) : ""}`;
        if (hasRssi868) csv += `,${(!isNaN(r.rssi_868)) ? r.rssi_868.toFixed(1) : ""}`;
        if (hasRssi915) csv += `,${(!isNaN(r.rssi_915)) ? r.rssi_915.toFixed(1) : ""}`;
        if (hasEmFog)   csv += `,${(!isNaN(r.em_fog))   ? r.em_fog.toFixed(1)   : ""}`;
      }

      if (isEnriched) {
        const roadClassStr = this.raw[i].osm_road_class ? GSRCSVParser._csvEscape(this.raw[i].osm_road_class) : "";
        const distMajorStr = (this.raw[i].osm_dist_major_road !== null && !isNaN(this.raw[i].osm_dist_major_road)) ? this.raw[i].osm_dist_major_road.toFixed(2) : "";
        const inParkStr = (this.raw[i].osm_in_park !== null && !isNaN(this.raw[i].osm_in_park)) ? this.raw[i].osm_in_park.toString() : "";
        const greenPctStr = (this.raw[i].osm_green_pct_50m !== null && !isNaN(this.raw[i].osm_green_pct_50m)) ? this.raw[i].osm_green_pct_50m.toFixed(1) : "";
        const bldDensityStr = (this.raw[i].osm_building_density_50m !== null && !isNaN(this.raw[i].osm_building_density_50m)) ? this.raw[i].osm_building_density_50m.toFixed(1) : "";
        const distWaterStr = (this.raw[i].osm_dist_water !== null && !isNaN(this.raw[i].osm_dist_water)) ? this.raw[i].osm_dist_water.toFixed(2) : "";
        const treeDensStr = (this.raw[i].osm_tree_density_50m !== null && !isNaN(this.raw[i].osm_tree_density_50m)) ? this.raw[i].osm_tree_density_50m.toFixed(1) : "";
        const amCountStr = (this.raw[i].osm_amenity_count_50m !== null && !isNaN(this.raw[i].osm_amenity_count_50m)) ? this.raw[i].osm_amenity_count_50m.toFixed(1) : "";

        csv += `,${roadClassStr},${distMajorStr},${inParkStr},${greenPctStr},${bldDensityStr},${distWaterStr},${treeDensStr},${amCountStr}`;
      }
      csv += "\n";
    }
    return csv;
  }

  /**
   * Calculate EM Fog Index (0-100) from RSSI readings across Sub-GHz bands.
   * Single source of truth — GSRCSVParser.parse() reaches this via
   * GSRAnalyzer.calcEmFog for its dynamic EM-fog fallback.
   */
  static calcEmFog(row, bandFloors = null) {
    const BANDS = ['rssi_300', 'rssi_315', 'rssi_434', 'rssi_446', 'rssi_815', 'rssi_868', 'rssi_915'];
    const floors = bandFloors || row?.bandFloors || null;
    let sumPsq = 0, cnt = 0;
    for (let i = 0; i < BANDS.length; i++) {
      const v = row[BANDS[i]];
      if (typeof v === 'number' && !isNaN(v)) {
        const bandKey = BANDS[i].replace('rssi_', '');
        const floor = (floors && typeof floors[bandKey] === 'number') ? floors[bandKey] : -100.0;
        const norm = Math.min(1.0, Math.max(0.0, (v - floor) / (-30.0 - floor)));
        sumPsq += norm * norm;
        cnt++;
      }
    }
    return cnt > 0 ? Math.sqrt(sumPsq / cnt) * 100.0 : NaN;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  global.GSRAnalyzer = GSRAnalyzer; // exposed so GSRCSVParser.parse() can reach GSRAnalyzer.calcEmFog
  module.exports = { GSRAnalyzer };
} else {
  window.GSRAnalyzer = GSRAnalyzer;
}


