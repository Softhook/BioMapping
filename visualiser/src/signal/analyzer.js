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
  if (typeof global.CVXEDA === 'undefined') {
    try { global.CVXEDA = require('./cvxeda.js'); } catch (_) {}
  }
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
                            //   riseTime, onsetSlope, decaySlope, skewnessRatio, snr,
                            //   qualityScore, salienceScore, prominence, label }
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
    this.phasicAUC = [];    // Sliding-window phasic integral: { time, val } — µS·s. In a
                            // deconvolution/cvxEDA run this integrates the phasic DRIVER
                            // (Benedek & Kaernbach's ISCR quantity); otherwise the
                            // tonic-subtracted phasic response (ISCR-inspired).
    this.phasicAUCIsISCR = false; // true when phasicAUC integrated the driver (see above)
    this.arousalIndex = []; // Combined tonic+phasic z-scored blend: { time, val }
    this.triIndex = [];     // Tri Index (tonic + phasic AUC + peak density) z-scored blend: { time, val }

    // Deconvolution state (Benedek & Kaernbach, 2010).
    this.phasicDriver = [];       // Raw driver signal: { time, val }
    this.phasicClean = [];        // Reconstructed clean phasic
    this.phasicDriverPeaks = [];  // Driver impulse list
    this.phasicDeconvTruncated = false; // True if matching pursuit hit maxIter before converging
    this._phasicOrig = null;      // Pre-deconvolution phasic backup (only set when deconvolution is on)
    this._tonicOrig = null;       // Pre-cvxEDA tonic backup (cvxEDA re-estimates tonic jointly)
    // Which algorithm produced this.phasicDriver — the two are not the same
    // physical quantity. Matching pursuit's driver is amplitude-matched to the
    // phasic curve it explains (µS, sample-rate-independent). cvxEDA's driver
    // is the coefficient of the discretised Bateman ARMA's A operator, which
    // carries a built-in ~1/Δt gain (its coefficients are built from delta in
    // the denominator — see cvxeda.js's applyA) — confirmed empirically: at a
    // fixed input amplitude, driver scales linearly with sample rate (5/10/20
    // Hz → driver ≈ 0.81–0.84 × sampleRate). So it's a rate (µS/s), not an
    // amplitude — GSR_CONST.DRIVER_UNIT_BY_ALGORITHM carries the display unit
    // for each. Null when no driver is populated.
    this._driverAlgorithm = null;

    this.sampleRate = 10;   // In Hz, auto-detected
    this.isResistance = false; // Whether original CSV was resistance (Ohms)
    this.hasGpsData = false;   // Whether raw signal contains valid GPS coordinates
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
    // True while the pooled phasicZ buffer and the cached phasicAUC / arousalIndex
    // ranges still reflect a deconvolution run rather than the pristine stage 1–3
    // prefix. Set by _runDeconvolutionPipeline(); cleared the moment those are
    // rebuilt from pristine data (prefix-cache hit restore, prefix-cache miss, or
    // a fresh series pool).
    this._wasDeconv = false;
    this._rawGlobalRange = null;
    this._timelinePointsCache = null;
    // Memoised stages 1–3 output (filter + decomposition), keyed on the four
    // params that feed it; see analyze(). Nulled whenever the series pool is
    // rebuilt (raw data changed).
    this._prefixCache = null;
  }

  /**
   * Ensure the reused per-sample series buffers exist and match the current
   * raw data. Rebuilds them — plus the raw-only display caches (raw Y-range,
   * timeline waveform sub-sample) — only when this.raw is a different array
   * than last seen, i.e. once per loaded track rather than once per analyze().
   *
   * Incremental-growth fast path: when this.raw is the SAME array that has only
   * had rows appended, the seven pooled arrays are extended in place instead of
   * reallocated and rescanned end-to-end. This is for a caller that streams
   * onto one persistent buffer; the live receiver used to, but now hands
   * analyze() a fresh trailing-window slice each call (bounded, so a clean
   * rebuild is cheap) and no longer hits this branch. Kept because it's correct
   * and self-contained — a future streaming caller would want it. Note it only
   * saves the realloc + raw rescan: the filter / decomposition / peak / metric
   * stages still re-process the whole buffer, so it never makes a long buffer
   * cheap — bounding the row count is the only thing that does.
   * @private
   */
  _ensureSeriesPool(raw, n) {
    if (this._seriesPoolRaw === raw && this._rawValsPool && this._rawValsPool.length === n) {
      return;
    }

    if (
      this._seriesPoolRaw === raw &&
      this._rawValsPool &&
      this._rawValsPool.length > 0 &&
      this._rawValsPool.length < n
    ) {
      const oldN = this._rawValsPool.length;
      let mn = this._rawGlobalRange.min, mx = this._rawGlobalRange.max;
      for (let i = oldN; i < n; i++) {
        const v = raw[i].val;
        this._rawValsPool.push(v);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this._rawGlobalRange = { min: mn, max: mx };
      for (const key of ['filtered', 'tonic', 'phasic', 'tonicZ', 'phasicZ', 'em_fog']) {
        const arr = this._seriesPool[key];
        for (let i = oldN; i < n; i++) arr.push({ time: raw[i].time, val: 0 });
      }
      // Sub-sample depends on the full length; ~300 pushes, redo it wholesale.
      const tl = [];
      const step = Math.max(1, Math.floor(n / 300));
      for (let i = 0; i < n; i += step) tl.push(raw[i]);
      this._timelinePointsCache = tl;
      // The appended rows haven't been filtered yet — the pristine prefix
      // result no longer spans the whole buffer, so stages 1–3 must re-run.
      this._prefixCache = null;
      this._wasDeconv = false;
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
    this._wasDeconv = false;  // fresh zeroed pool buffers — no deconvolution state to carry

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

  /**
   * Whether this track contains valid GPS / geographic spatial data.
   * @returns {boolean}
   */
  get hasSpatialData() {
    if (this.hasGpsData !== undefined && typeof this.hasGpsData === 'boolean') {
      return this.hasGpsData;
    }
    return !!(this.raw && this.raw.some(d => d.hasGps || (!isNaN(d.lat) && !isNaN(d.lon) && (Math.abs(d.lat) > 0.0001 || Math.abs(d.lon) > 0.0001))));
  }

  /**
   * Alias for hasSpatialData.
   * @returns {boolean}
   */
  get hasGps() {
    return this.hasSpatialData;
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
    this.hasGpsData = result.hasGpsData;
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
    // Only five params feed this prefix; the peak-detection / hotspot /
    // metric-window sliders don't. When none of the five changed since the last
    // analyze(), the pooled .filtered/.tonic/.phasic arrays (and their cached
    // Y-ranges) are still correct — skip ~25 ms of filtering + decomposition on
    // a 40k-row track and reuse them. Keyed alongside this.raw identity, which
    // _ensureSeriesPool() nulls the cache on.
    const prefixKey = params.medianSize + '|' + params.lpfWindow +
      '|' + params.tonicWindow + '|' + params.tonicMethod + '|' + !!params.useGaitFilter;

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
      this.tonicZ = this._seriesPool.tonicZ;
      if (this._wasDeconv) {
        this.phasicZ = GsrFilter.standardizeSignal(this.phasic, this._seriesPool.phasicZ);
        // cvxEDA mode replaces this.tonic with its own joint estimate; the
        // pooled buffer is left pristine, so restoring it here (plus its
        // cached range) undoes the swap on the next non-cvxEDA run.
        this._seriesRange.tonic = this._prefixCache.tonicRange;
        this._tonicOrig = null;
        this._wasDeconv = false;
      } else {
        this.phasicZ = this._seriesPool.phasicZ;
      }
    } else {
      // 1. Noise Median Filtering
      const medWindowSize = Math.max(1, Math.round(params.medianSize * this.sampleRate));
      let afterMedian = GsrFilter.applyMedianFilter(this._rawValsPool, medWindowSize);

      // 2. Low-Pass Filter — useGaitFilter (on by default) swaps in the
      // Linkwitz-Riley 4 gait filter (GSR_CONST.GAIT_FILTER) in place of the box
      // average — see applyZeroPhaseLinkwitzRiley()'s doc comment in
      // gsr_filter.js for design details.
      // The toggle is independent of the lpfWindow slider's magnitude — it
      // has its own fixed cutoff/type — so it takes effect even with
      // lpfWindow at 0 (the box average's own "off" position); otherwise
      // checking the toggle while that slider sat at 0 would look like a
      // broken checkbox that silently does nothing.
      const lpfWinSize = params.lpfWindow * this.sampleRate;
      let afterLPF;
      if (params.useGaitFilter) {
        const gf = (typeof GSR_CONST !== 'undefined' && GSR_CONST.GAIT_FILTER) || { cutoffHz: 1.0, type: 'lr4' };
        if (gf.type === 'butterworth') {
          afterLPF = GsrFilter.applyZeroPhaseButterworth(afterMedian, gf.cutoffHz, gf.order || 4, this.sampleRate);
        } else {
          afterLPF = GsrFilter.applyZeroPhaseLinkwitzRiley(afterMedian, gf.cutoffHz, this.sampleRate);
        }
      } else {
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
      // The pooled phasicZ buffer and the pristine ranges below are now rebuilt
      // from pristine data; any lingering deconvolution state is stale. (If this
      // analyze() is itself a deconvolution run, _runDeconvolutionPipeline() sets
      // the flag again straight after.)
      this._wasDeconv = false;

      // Pre-compute continuous metrics that depend only on tonic / phasic:
      const pristineAUC = this.computePhasicAUC();
      const aiCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.AROUSAL_INDEX) || { wTonic: 0.3, wPhasic: 0.7 };
      const pristineArousal = this.computeCombinedArousalIndex(aiCfg.wTonic, aiCfg.wPhasic, pristineAUC);

      let aucMn = Infinity, aucMx = -Infinity;
      for (let i = 0; i < pristineAUC.length; i++) {
        const v = pristineAUC[i].val;
        if (v < aucMn) aucMn = v;
        if (v > aucMx) aucMx = v;
      }
      let aiMn = Infinity, aiMx = -Infinity;
      for (let i = 0; i < pristineArousal.length; i++) {
        const v = pristineArousal[i].val;
        if (v < aiMn) aiMn = v;
        if (v > aiMx) aiMx = v;
      }

      this._prefixCache = {
        key: prefixKey,
        phasicVals,
        tonicVals,
        tonicRange: this._seriesRange.tonic,
        phasicStd: this.phasicStd,
        phasicRange: this._seriesRange.phasic,
        phasicAUC: pristineAUC,
        arousalIndex: pristineArousal,
        aucRange: { min: aucMn, max: aucMx },
        aiRange: { min: aiMn, max: aiMx },
      };
    }

    // 5. Phasic Peak Detection. Exactly one of three mutually-exclusive
    // pipelines builds this.peaks per analyze() call. Min Peak Quality applies
    // in every mode; Min SNR in every mode except prominence.
    //   - full-scan (default, no flag): the trough-to-peak amplitude criterion
    //     applied non-greedily — every local maximum that rose >= peakThreshold
    //     from its saddle onset, plus Min SNR and Min Peak Quality, one per
    //     refractory window. Keeps SCRs that ride the rising edge of a larger
    //     response (no valley → zero prominence) (see _detectPeaksFullScan()).
    //   - prominence (params.usePeakProminence): one non-greedy pass — every
    //     local maximum whose topographic prominence >= peakThreshold, i.e.
    //     conductance rose that much above the level it last recovered to.
    //     Resolves shoulders in one step; the only per-peak gate is Min Peak
    //     Quality (see _detectPeaksByProminence()).
    //   - deconvolution (params.useDeconvolution): one global SCR deconvolution
    //     pass that replaces this.phasic with a resolved, superposition-free
    //     reconstruction and builds peaks from its driver impulses. Morphology
    //     is fixed by the SCRF kernel.
    // Precedence when several flags are set: prominence > cvxEDA >
    // deconvolution > full-scan (default).
    if (params.usePeakProminence) {
      this._clearDeconvState();
      this._detectPeaksByProminence(params);
    } else if (params.useCvxEDA) {
      this._runDeconvolutionPipeline(phasicVals, { ...params, deconvAlgorithm: 'cvxeda' });
    } else if (params.useDeconvolution) {
      this._runDeconvolutionPipeline(phasicVals, params);
    } else {
      this._clearDeconvState();
      this._detectPeaksFullScan(params);
    }

    // 5b. Memorable-event ("hotspot") selection — see _selectMemorableEvents().
    this.memorableEvents = this._selectMemorableEvents(params, peakLatency);

    // 6. Continuous, threshold-independent arousal metrics (ISCR/AUC + combined index + EM Fog)
    const densityWin = (params && params.peakDensityWindow != null) ? params.peakDensityWindow : null;
    this.peakDensity = this.computeTemporalPeakDensity(densityWin);

    const aiCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.AROUSAL_INDEX) || { wTonic: 0.3, wPhasic: 0.7 };
    const triCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.TRI_INDEX) || { wTonic: 0.10, wPhasic: 0.45, wDensity: 0.45 };

    if (params.useDeconvolution || params.useCvxEDA) {
      this.phasicAUC = this.computePhasicAUC(); // integrates the driver → sets phasicAUCIsISCR
      this.arousalIndex = this.computeCombinedArousalIndex(aiCfg.wTonic, aiCfg.wPhasic, this.phasicAUC);
    } else {
      // Cached AUC is always the pristine phasic-response integral.
      this.phasicAUC = this._prefixCache.phasicAUC;
      this.arousalIndex = this._prefixCache.arousalIndex;
      this.phasicAUCIsISCR = false;
    }
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
   * Reset SCR deconvolution state when running a non-deconvolution detector.
   * @private
   */
  _clearDeconvState() {
    this.phasicDriver = [];
    this.phasicClean = [];
    this.phasicDriverPeaks = [];
    this.phasicDeconvTruncated = false;
    this._phasicOrig = null;
    this._tonicOrig = null;
    this._driverAlgorithm = null;
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
    this._wasDeconv = true;
    if (n === 0) { this.peaks = []; return; }

    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();

    const scf = GSR_CONST.SCRF;
    const times = this.phasic.map(d => d.time);
    const phasicArr = new Float64Array(phasicVals);

    // Opt-in cvxEDA convex optimization algorithm (Greco et al., 2016)
    const algorithm = params.deconvAlgorithm || scf.deconvAlgorithm || 'matching_pursuit';
    if (algorithm === 'cvxeda' && typeof CVXEDA !== 'undefined') {
      this._driverAlgorithm = 'cvxeda';
      // cvxEDA models tonic and phasic jointly, so it is fed the full filtered
      // skin-conductance signal (tonic still present), NOT the EMA
      // tonic-subtracted phasic the matching-pursuit path uses. Its B-spline
      // tonic estimate then replaces this.tonic for the rest of this run
      // (the pooled buffer is left pristine; the prefix-cache restore in
      // analyze() swaps the EMA tonic back on the next non-cvxEDA call).
      const scVals = new Float64Array(n);
      for (let i = 0; i < n; i++) scVals[i] = this.filtered[i].val;

      // Every cvxEDA knob comes from the CVXEDA config block — there are no
      // per-recording sliders for these (as with SCRF's deconvolution
      // constants). Bateman taus default to the reference tau0=2.0 / tau1=0.7,
      // not SCRF's fixed-kernel pair. decompose() fills any missing key from
      // its own reference defaults.
      const cvxCfg = GSR_CONST.CVXEDA || {};
      const res = CVXEDA.decompose(scVals, this.sampleRate, {
        tauSlow: cvxCfg.tauSlow ?? scf.tauSlow,
        tauFast: cvxCfg.tauFast ?? scf.tauFast,
        alpha: cvxCfg.alpha,
        gamma: cvxCfg.gamma,
        maxIter: cvxCfg.maxIter
      });
      const cleanVals = res.phasic;

      // Joint tonic estimate → this.tonic (fresh array; pool stays pristine).
      this._tonicOrig = this.tonic;
      const tonicClean = new Array(n);
      let toMn = Infinity, toMx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = res.tonic[i];
        tonicClean[i] = { time: times[i], val: v };
        if (v < toMn) toMn = v;
        if (v > toMx) toMx = v;
      }
      this.tonic = tonicClean;
      this._seriesRange.tonic = { min: toMn, max: toMx };
      this.tonicZ = GsrFilter.standardizeSignal(this.tonic, null);

      this.phasicDriver = new Array(n);
      for (let i = 0; i < n; i++) {
        this.phasicDriver[i] = { time: times[i], val: res.driver[i] };
      }
      this.phasicDriverPeaks = [];
      const thresh = scf.impulseThreshold ?? 0.005;
      const minGap = Math.max(1, Math.round((scf.minImpulseGapSec ?? 0.5) * this.sampleRate));
      let lastPIdx = -minGap;
      for (let i = 1; i < n - 1; i++) {
        if (res.driver[i] >= thresh && res.driver[i] >= res.driver[i - 1] && res.driver[i] >= res.driver[i + 1]) {
          if (i - lastPIdx >= minGap) {
            this.phasicDriverPeaks.push({ index: i, time: times[i], amplitude: res.driver[i] });
            lastPIdx = i;
          }
        }
      }
      // cvxEDA solves the convex problem to a residual tolerance; a run that
      // hits its iteration cap first is flagged the same way a truncated
      // matching-pursuit run is (drives the same "results may be undercounted"
      // UI warning).
      this.phasicDeconvTruncated = !res.converged;
      this.phasicClean = new Array(n);
      for (let i = 0; i < n; i++) {
        this.phasicClean[i] = { time: times[i], val: cleanVals[i] };
      }
      this._phasicOrig = this.phasic;
      this.phasic = this.phasicClean;
      this.phasicZ = GsrFilter.standardizeSignal(this.phasic, this._seriesPool && this._seriesPool.phasicZ);
      this.phasicStd = GsrFilter.calculateStats(cleanVals).std;
      let phMn = Infinity, phMx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = cleanVals[i];
        if (v < phMn) phMn = v;
        if (v > phMx) phMx = v;
      }
      this._seriesRange.phasic = { min: phMn, max: phMx };
      this.peaks = this._detectPeaksFromCurve(cleanVals, times, params, oldLabels, oldExcluded);
      this._assignLabelsToPeaks(this.peaks);
      return;
    }

    this._driverAlgorithm = algorithm === 'sparseda' ? 'sparseda' : 'matching_pursuit';
    const deconvInput = (algorithm === 'sparseda')
      ? Float64Array.from(this.filtered, d => d.val)
      : phasicArr;
    const deconvOpts = (algorithm === 'sparseda')
      ? {
          maxIter: scf.sparsedaKmax ?? 40,
          epsilon: scf.sparsedaEpsilon,
          dminSec: scf.sparsedaDminSec,
          rho: scf.sparsedaRho,
          algorithm: algorithm
        }
      : {
          tauSlow: scf.tauSlow, tauFast: scf.tauFast, kernelSec: scf.kernelSec,
          maxIter: scf.maxIter, lr: scf.lr, convTol: scf.convTol,
          minImpulseGapSec: scf.minImpulseGapSec,
          algorithm: algorithm
        };
    const result = SCRDeconvolution.deconvolve(deconvInput, this.sampleRate, deconvOpts);
    if (algorithm === 'sparseda' && result.tonic && result.tonic.length === n) {
      this._tonicOrig = this.tonic;
      const tonicClean = new Array(n);
      let toMn = Infinity, toMx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = result.tonic[i];
        tonicClean[i] = { time: times[i], val: v };
        if (v < toMn) toMn = v;
        if (v > toMx) toMx = v;
      }
      this.tonic = tonicClean;
      this._seriesRange.tonic = { min: toMn, max: toMx };
      this.tonicZ = GsrFilter.standardizeSignal(this.tonic, null);
    }

    // Diagnostic: whether the selected deconvolution path converged before
    // exhausting its iteration budget. A truncated run means real SCRs may
    // have been left unmodelled with no visible sign in the results — check
    // this if peak counts look low for a long/busy recording.
    this.phasicDeconvTruncated = !result.converged;

    this.phasicDriver = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicDriver[i] = { time: times[i], val: result.driver[i] };
    }
    let reconstructionImpulses;
    let cleanValsRaw;
    if (algorithm === 'sparseda') {
      this.phasicDriverPeaks = [];
      for (let i = 0; i < n; i++) {
        if (result.driver[i] > 0) {
          this.phasicDriverPeaks.push({ index: i, time: times[i], amplitude: result.driver[i] });
        }
      }
      reconstructionImpulses = this.phasicDriverPeaks.map(({ index, amplitude }) => ({ index, amplitude }));
      cleanValsRaw = (result.clean && result.clean.length === n)
        ? new Float64Array(result.clean)
        : SCRDeconvolution.reconstructPhasic(reconstructionImpulses, n, result.kernel);
    } else {
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
      // was tried and slightly hurt both apex accuracy and raw-detector
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

      // Gate which raw impulses feed the reconstruction: the same amplitude
      // threshold (peakThreshold), plus a check that each impulse matches a
      // genuine local rise in the *original* signal at its resolved apex, not
      // just a driver-domain artefact (mitigates noise-detected-as-SCR). This is
      // the only pre-reconstruction filter — SNR and quality judge individual
      // reported events, not whether a piece of signal is real, so they run
      // later against the peaks built from the reconstructed curve, matching the
      // raw detectors' order (amplitude gates candidacy; SNR/quality filter
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
      reconstructionImpulses = [];
      for (const { imp } of impulses) {
        const entries = logByClampedIndex.get(imp.index);
        if (entries && entries.length > 0) {
          for (const e of entries) reconstructionImpulses.push({ index: e.trueIndex, amplitude: e.amplitude });
        } else {
          reconstructionImpulses.push({ index: imp.index, amplitude: imp.amplitude });
        }
      }
      cleanValsRaw = (result.clean && result.clean.length === n)
        ? new Float64Array(result.clean)
        : SCRDeconvolution.reconstructPhasic(reconstructionImpulses, n, result.kernel);
    }

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

    // Post-hoc amplitude rescaling — corrects MP overestimation from GENUINE
    // atom crowding (many accepted impulses packed close enough that their
    // kernel footprints compete for the same residual, biasing the greedy
    // per-atom fit), not a blanket correction applied everywhere regardless
    // of whether that crowding exists.
    //
    // Ground-truth testing (visualiser/tests/manual/neurokit_compare/
    // check_ground_truth.js, 2026-09-11) found the OLD unconditional version
    // of this correction — scale = sum(phasicVals) / sum(cleanValsRaw),
    // applied uniformly regardless of track density — shrank amplitude by
    // ~30-35% even on isolated, well-separated synthetic SCRs where a direct
    // per-atom check (comparing each accepted impulse's pre-rescale amplitude
    // against the known true amplitude) showed the raw matching-pursuit fit
    // was already accurate to within 1-2%. The old correction wasn't reacting
    // to overlap at all: sum(cleanValsRaw) is a plain sum over a purely
    // additive reconstruction, which is invariant to how much its components
    // overlap in time (summation is linear) — so the old ratio was actually
    // measuring a CONSTANT mismatch between the fixed SCRF kernel's own
    // area-to-peak ratio and whatever true-signal area-to-peak ratio the
    // track happens to have, unrelated to crowding, and it fired just as hard
    // on isolated single SCRs as on genuinely dense ones.
    //
    // Fix: weight the raw ratio by how densely accepted impulses are actually
    // packed on THIS track (atomDensity below, 0 = every impulse isolated by
    // more than one kernel length, 1 = impulses packed back-to-back), so an
    // isolated-SCR track is left at its own accurate per-atom fit
    // (rescaleAmplitudes -> 1.0) while a genuinely busy/overlapping track
    // keeps most of the original correction (rescaleAmplitudes -> raw ratio),
    // matching what real BioMapping recordings need (checked against
    // biomap_019/027/053/059: atom density 0.68-0.85, so real tracks keep
    // ~70-80% of the original correction) without over-punishing the common
    // case of well-separated genuine responses.
    //
    // Guard: if cleanValsRaw sums to zero (no impulses passed the gate, e.g.
    // a recording with no detectable SCRs), skip the rescaling to avoid ÷0.
    const shouldRescale = result.applyRescale !== false;
    let rescaleAmplitudes = 1.0;
    if (shouldRescale) {
      let sumClean = 0, sumPhasic = 0;
      for (let i = 0; i < n; i++) { sumClean += cleanValsRaw[i]; sumPhasic += phasicVals[i]; }
      if (sumClean > 0) {
        const rawRescale = sumPhasic / sumClean;
        const kernelSamples = scf.kernelSec * this.sampleRate;
        const sortedIdx = reconstructionImpulses.map(imp => imp.index).sort((a, b) => a - b);
        let overlapWeight = 0;
        for (let k = 1; k < sortedIdx.length; k++) {
          const gap = sortedIdx[k] - sortedIdx[k - 1];
          if (gap < kernelSamples) overlapWeight += 1 - gap / kernelSamples;
        }
        const atomDensity = sortedIdx.length > 1 ? overlapWeight / (sortedIdx.length - 1) : 0;
        rescaleAmplitudes = 1.0 + atomDensity * (rawRescale - 1.0);
      }
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
      cleanVals = new Float64Array(n);
      for (let i = 0; i < n; i++) cleanVals[i] = cleanValsRaw[i] * rescaleAmplitudes;
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
   * maxima — the same simple local-maximum + trough-to-peak amplitude approach
   * the default detector (_detectPeaksFullScan) uses on the raw signal —
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
    // Backward onset-search bound only — not a shape filter. The generous
    // canonical MAX_RISE_TIME, same bound _detectPeaksFullScan and
    // _detectPeaksByProminence use, purely to stop the walk-back at a sane point.
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

    // Same hard SNR cutoff the default detector applies (shapeMinSnr, "0 = off").
    // SNR depends on each peak's local noise floor regardless of detection mode.
    const minSnr = params && params.shapeMinSnr != null ? params.shapeMinSnr : defaults.MIN_SNR;
    let result = minSnr > 0 ? peaks.filter(pk => pk.snr >= minSnr) : peaks;

    // "0 = off" convention — no hardcoded floor here; a hardcoded minimum
    // would silently override an explicit user choice.
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
   *     onsetSlope, decaySlope, skewnessRatio, snr }
   * @param {Map}     oldLabels             - Index→label map from pre-analysis peaks.
   * @param {Set}     oldExcluded           - Index set of excluded pre-analysis peaks.
   * @param {boolean} [checkImportedExcluded=false]
   *   When true also checks this._importedPeakExcluded by *time* (the raw
   *   detectors, where the imported-CSV exclusion map exists). False in
   *   _detectPeaksFromCurve mode, which only sees the index-keyed oldExcluded.
   * @returns {object} Peak object (qualityScore and salienceScore NOT yet set).
   * @private
   */
  _buildPeakObject(i, currVal, vals, times, shape, oldLabels, oldExcluded, checkImportedExcluded = false) {
    const { amplitude, onsetIdx, recoveryIdx, halfRecoveryTime,
            riseTime, onsetSlope, decaySlope, skewnessRatio, snr } = shape;
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
    for (const key of ['peakDensity', 'triIndex']) {
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
    if (this._wasDeconv) {
      for (const key of ['phasicAUC', 'arousalIndex', 'phasicDriver']) {
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
    } else if (this._prefixCache) {
      if (this._prefixCache.aucRange) this._globalRange.phasicAUC = this._prefixCache.aucRange;
      if (this._prefixCache.aiRange) this._globalRange.arousalIndex = this._prefixCache.aiRange;
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
   * @private
   */
  _findOnsetIndex(vals, i, maxOnsetSteps, minDip = 0) {
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

    const noiseFloor = this._computeNoiseFloor(onsetIdx, noiseHalfWin);
    const snr = noiseFloor > 0 ? amplitude / noiseFloor : 0;

    return {
      amplitude,
      riseTime,
      onsetSlope,
      halfRecoveryTime,
      decaySlope,
      skewnessRatio,
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
   * Ranking is by response magnitude, descending — and magnitude means whatever
   * the active detector selected peaks by:
   *   - Prominence detector: topographic PROMINENCE. Every kept peak cleared a
   *     prominence gate, so prominence is the comparable size metric and the
   *     one that mode identifies peaks on.
   *   - Full-scan (default) and deconvolution: trough-to-peak AMPLITUDE. These
   *     select by amplitude, and a large real SCR can have near-zero
   *     topographic prominence (a crest micro-wiggle splits its apex; it rides
   *     the up-slope of a bigger later response; it sits on an elevated busy
   *     stretch). Full-scan DOES stamp a `prominence` field, but only as a
   *     reported "isolated vs part of a burst" hint — ranking by it would sink
   *     exactly the big rising-edge / compound events full-scan exists to keep.
   * salienceScore (amplitude/slope/SNR blend) is still computed per peak for
   * the peaks table but does not drive this.
   *
   * Count target is percentile-based: top HOTSPOT_PERCENTILE of active
   * (non-excluded) peaks, at least 1 — not a fixed score cutoff, which scales
   * with peak count rather than staying a small curated set. 2% was picked
   * from real-track yields; treat it as a tunable starting point.
   *
   * Spatial spacing: walking the magnitude-ranked list, a candidate is skipped
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
    // Rank by the metric the active detector actually selects peaks on:
    // prominence only in prominence mode, trough-to-peak amplitude otherwise
    // (full-scan default + deconvolution). Full-scan stamps `prominence` as a
    // reported field, so keying off its mere presence would rank by it too —
    // and drop large, low-prominence SCRs (crest wiggle, rising-edge, burst
    // summits) out of the hotspot set.
    const magnitude = (params && params.usePeakProminence)
      ? p => (p.prominence != null ? p.prominence : p.amplitude)
      : p => p.amplitude;
    const activeSorted = this.peaks
      .filter(p => !p.excluded)
      .sort((a, b) => (magnitude(b) - magnitude(a)) || (a.time - b.time));
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
   * re-loaded processed CSV (matched by time). Called at the top of every
   * detector (_detectPeaksFullScan / _detectPeaksByProminence /
   * _runDeconvolutionPipeline) before this.peaks is cleared.
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

    // Any summit never dominated (the global max, or ties for it) starts from
    // the signal's own minimum; the boundary correction below replaces this
    // with the correct per-side floor.
    for (let i = 0; i < n; i++) if (prom[i] < 0) prom[i] = Math.max(0, vals[i] - vMin);

    // Boundary correction — see doc comment above. One-sided running
    // extrema, computed once in O(n): prefixMax/suffixMax find whether a
    // taller point exists on each side at all; prefixMin/suffixMin give the
    // true one-sided floor to fall back to when it doesn't.
    const prefixMax = new Float64Array(n), prefixMin = new Float64Array(n);
    let curMax = -Infinity, curMin = Infinity;
    for (let i = 0; i < n; i++) {
      prefixMax[i] = curMax;   // strictly left of i (-Inf when i === 0)
      prefixMin[i] = curMin;
      if (vals[i] > curMax) curMax = vals[i];
      if (vals[i] < curMin) curMin = vals[i];
    }
    const suffixMax = new Float64Array(n), suffixMin = new Float64Array(n);
    curMax = -Infinity; curMin = Infinity;
    for (let i = n - 1; i >= 0; i--) {
      suffixMax[i] = curMax;   // strictly right of i (-Inf when i === n-1)
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
  }

  /**
   * Above-threshold topographic-prominence local maxima under refractory-period
   * non-max suppression — the peak list for _detectPeaksByProminence(), from a
   * single _topographicProminence() sweep.
   *
   * @param {Array<number>} vals - phasic signal.
   * @param {Float64Array} prom - per-sample topographic prominence (from _topographicProminence(vals)).
   * @param {number} threshold - prominence gate (peakThreshold, µS).
   * @param {number} minGap - non-max-suppression radius, in samples.
   * @param {number} baselineWin - trailing window for the pre-burst minimum, in samples.
   * @returns {number[]} apex sample indices of survivors, ascending.
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
      // Ceiling re-checked against baseline amplitude so a large-but-real event
      // riding a raised tonic is assessed from its pre-burst level, not zero.
      if (vals[i] - mn > maxScrAmp) continue;
      cand.push({ i, prominence: prom[i] });
    }

    // Minimum-gap non-max suppression — largest prominence wins, same
    // convention as _detectPeaksFullScan()'s refractory skip-ahead.
    cand.sort((a, b) => (b.prominence - a.prominence) || (a.i - b.i));
    const kept = [];
    for (const c of cand) {
      if (!kept.some(k => Math.abs(k.i - c.i) < minGap)) kept.push(c);
    }
    kept.sort((a, b) => a.i - b.i);
    return kept.map(c => c.i);
  }

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
   * _selectMemorableEvents) and trough-to-peak `amplitude` (the rise you would
   * read straight off the trace), measured from
   * a threshold-aware saddle onset — _findOnsetIndex walked with minDip =
   * peakThreshold, so a sub-threshold crest wiggle can't strand the onset in
   * the notch and collapse the amplitude.
   *
   * The only per-peak gate is Min Peak Quality. Min SNR is not applied: a stacked
   * peak's amplitude is saddle-referenced, so its SNR is deflated by
   * construction and would reject exactly the peaks this detector exists to
   * find. peakThreshold and the artefact ceiling (_prominenceNMS) always apply.
   *
   * Cost: one _topographicProminence() sweep (O(n log n)) + one _prominenceNMS()
   * + one _prominencePeakAt() per survivor (a few hundred per track).
   *
   * @param {object} params - Analysis params (peakThreshold, minPeakQuality).
   * @private
   */
  _detectPeaksByProminence(params) {
    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();
    this.peaks = [];
    const n = this.phasic.length;
    if (n < 3) return;

    const vals = this.phasic.map(d => d.val);
    const times = this.phasic.map(d => d.time);
    const sr = this.sampleRate;
    const threshold = params.peakThreshold;
    const minGap = Math.max(1, Math.round(GSR_CONST.PEAK_MIN_GAP * sr));
    const baselineWin = Math.max(1, Math.round((GSR_CONST.PEAK_PROMINENCE_BASELINE_SEC || 8) * sr));
    const noiseHalfWin = Math.max(1, Math.round(sr));
    // Morphology gates are off in this mode, so the onset walk-back uses the
    // generous canonical MAX_RISE_TIME bound.
    const maxOnsetSteps = Math.round(GSR_CONST.PEAK_SHAPE.MAX_RISE_TIME * sr);
    const minQuality = (params && params.minPeakQuality != null) ? params.minPeakQuality : 0.0;

    const prom = this._topographicProminence(vals);
    // Above-threshold, artefact-screened prominence maxima, refractory-period
    // NMS applied (most-prominent-wins within PEAK_MIN_GAP). Returned ascending
    // by sample index == ascending by time.
    const kept = this._prominenceNMS(vals, prom, threshold, minGap, baselineWin);

    for (const idx of kept) {
      // Onset walk-back ignores notches shallower than peakThreshold, so a
      // response whose crest carries a sub-threshold wiggle is still measured
      // from its true onset (matches the "a real recovery is >= threshold" bar
      // the prominence gate itself uses).
      const onsetIdx = this._findOnsetIndex(vals, idx, maxOnsetSteps, threshold);
      const peak = this._buildPeakWithMetrics(idx, onsetIdx, vals, times, prom,
        noiseHalfWin, oldLabels, oldExcluded);
      if (peak.qualityScore >= minQuality) this.peaks.push(peak);
    }
    this._assignLabelsToPeaks(this.peaks);
  }

  /**
   * Build a full peak object at apex sample `idx` with onset at `onsetIdx`
   * (passed in so the caller owns the onset rule). Reports trough-to-peak
   * `amplitude` from that onset AND topographic `prominence` from `prom[idx]`.
   * Shared by _detectPeaksByProminence() and _detectPeaksFullScan().
   * @private
   */
  _buildPeakWithMetrics(idx, onsetIdx, vals, times, prom, noiseHalfWin, oldLabels, oldExcluded) {
    const recoveryIdx = this._findRecoveryIndex(vals, idx, onsetIdx, vals[idx] - vals[onsetIdx]);
    const metrics = this._calculateShapeMetrics(vals, times, idx, onsetIdx, recoveryIdx, noiseHalfWin);
    const peak = this._buildPeakObject(idx, vals[idx], vals, times,
      { ...metrics, onsetIdx, recoveryIdx }, oldLabels, oldExcluded, true);
    peak.prominence = prom[idx];
    peak.qualityScore = this._computePeakQuality(peak);
    peak.salienceScore = this._computeSalienceScore(peak);
    return peak;
  }

  /**
   * Backwards-compatibility alias for _buildPeakWithMetrics().
   * @private
   */
  _prominencePeakAt(...args) {
    return this._buildPeakWithMetrics(...args);
  }

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
   * @param {object} params - Analysis params (peakThreshold, shapeMinSnr, minPeakQuality).
   * @private
   */
  _detectPeaksFullScan(params) {
    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();
    this.peaks = [];
    const n = this.phasic.length;
    if (n < 3) return;

    const vals = this.phasic.map(d => d.val);
    const times = this.phasic.map(d => d.time);
    const sr = this.sampleRate;
    const threshold = params.peakThreshold;
    const minGap = Math.max(1, Math.round(GSR_CONST.PEAK_MIN_GAP * sr));
    const noiseHalfWin = Math.max(1, Math.round(sr));
    const maxOnsetSteps = Math.round(GSR_CONST.PEAK_SHAPE.MAX_RISE_TIME * sr);
    const minSnr = (params && params.shapeMinSnr != null) ? params.shapeMinSnr : GSR_CONST.PEAK_SHAPE.MIN_SNR;
    const minQuality = (params && params.minPeakQuality != null) ? params.minPeakQuality : 0.0;
    const maxScrAmp = GSR_CONST.MICROSIEMENS_MAX_SCR != null ? GSR_CONST.MICROSIEMENS_MAX_SCR : 20;

    const prom = this._topographicProminence(vals); // reported field only

    const cand = [];
    for (let i = 1; i < n - 1; i++) {
      if (!(vals[i] > vals[i - 1] && vals[i] >= vals[i + 1])) continue;
      if (vals[i] < 0.001 || vals[i] > maxScrAmp) continue;
      const onsetIdx = this._findOnsetIndex(vals, i, maxOnsetSteps);
      const amplitude = vals[i] - vals[onsetIdx];
      if (amplitude < threshold) continue;
      if (minSnr > 0) {
        const noiseFloor = this._computeNoiseFloor(onsetIdx, noiseHalfWin);
        if (noiseFloor > 0 && amplitude / noiseFloor < minSnr) continue;
      }
      cand.push({ i, onsetIdx, amplitude });
    }

    // Refractory-period NMS — largest rise from its own onset wins its window.
    cand.sort((a, b) => (b.amplitude - a.amplitude) || (a.i - b.i));
    const kept = [];
    for (const c of cand) {
      if (!kept.some(k => Math.abs(k.i - c.i) < minGap)) kept.push(c);
    }
    kept.sort((a, b) => a.i - b.i);

    for (const c of kept) {
      const peak = this._buildPeakWithMetrics(c.i, c.onsetIdx, vals, times, prom,
        noiseHalfWin, oldLabels, oldExcluded);
      if (peak.qualityScore >= minQuality) this.peaks.push(peak);
    }
    this._assignLabelsToPeaks(this.peaks);
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
   * Sliding-window phasic integral, in µS·s.
   *
   * Source depends on the run:
   *  - Deconvolution / cvxEDA mode (this._wasDeconv, phasicDriver populated):
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
   * Sets this.phasicAUCIsISCR to say which path was taken (drives the UI label).
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
    if (n === 0) { this.phasicAUCIsISCR = false; return []; }

    // True ISCR integrates the deconvolved driver; fall back to the phasic
    // response when no driver is available (non-deconvolution runs).
    const useDriver = !!this._wasDeconv && Array.isArray(this.phasicDriver) &&
                      this.phasicDriver.length === n;
    this.phasicAUCIsISCR = useDriver;
    const src = useDriver ? this.phasicDriver : this.phasic;

    const auc = new Array(n);
    const halfWin = windowSizeSec / 2;

    let lo = 0, hi = 0;
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
    const hasNdvi = this.raw.some(d => (typeof d.ndvi === 'number' && !isNaN(d.ndvi)) || (typeof d.ndvi_50m === 'number' && !isNaN(d.ndvi_50m)));

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
      csv += ",osm_road_class,osm_dist_major_road,osm_in_park,osm_green_pct_50m,osm_dist_green,osm_canopy_pct_50m,osm_building_density_50m,osm_dist_water,osm_tree_density_50m,osm_amenity_count_50m";
    }
    if (hasNdvi) {
      csv += ",ndvi,ndvi_50m";
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
        const distGreenStr = (this.raw[i].osm_dist_green !== null && !isNaN(this.raw[i].osm_dist_green)) ? this.raw[i].osm_dist_green.toFixed(2) : "";
        const canopyPctStr = (this.raw[i].osm_canopy_pct_50m !== null && !isNaN(this.raw[i].osm_canopy_pct_50m)) ? this.raw[i].osm_canopy_pct_50m.toFixed(1) : "";
        const bldDensityStr = (this.raw[i].osm_building_density_50m !== null && !isNaN(this.raw[i].osm_building_density_50m)) ? this.raw[i].osm_building_density_50m.toFixed(1) : "";
        const distWaterStr = (this.raw[i].osm_dist_water !== null && !isNaN(this.raw[i].osm_dist_water)) ? this.raw[i].osm_dist_water.toFixed(2) : "";
        const treeDensStr = (this.raw[i].osm_tree_density_50m !== null && !isNaN(this.raw[i].osm_tree_density_50m)) ? this.raw[i].osm_tree_density_50m.toFixed(1) : "";
        const amCountStr = (this.raw[i].osm_amenity_count_50m !== null && !isNaN(this.raw[i].osm_amenity_count_50m)) ? this.raw[i].osm_amenity_count_50m.toFixed(1) : "";

        csv += `,${roadClassStr},${distMajorStr},${inParkStr},${greenPctStr},${distGreenStr},${canopyPctStr},${bldDensityStr},${distWaterStr},${treeDensStr},${amCountStr}`;
      }
      if (hasNdvi) {
        const ndviStr = (this.raw[i].ndvi !== null && !isNaN(this.raw[i].ndvi)) ? this.raw[i].ndvi.toFixed(3) : "";
        const ndvi50mStr = (this.raw[i].ndvi_50m !== null && !isNaN(this.raw[i].ndvi_50m)) ? this.raw[i].ndvi_50m.toFixed(3) : "";
        csv += `,${ndviStr},${ndvi50mStr}`;
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
