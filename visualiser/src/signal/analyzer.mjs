// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

// GSR/EDA Signal Analysis Engine with GPS coordinate parsing and interpolation
// Handles variable-rate (10 Hz GSR, up to 5 Hz GPS) CSV files.
//
// CSV parsing lives in a dedicated pure module (csv_parser.js) so it can be
// tested independently; imported directly below.
import { GSR_CONST } from '../core/constants.mjs';
import { AnalyzerExport } from './analyzer_export.mjs';
import { AnalyzerStats } from './analyzer_stats.mjs';
import { AnalyzerTimeFormat } from './analyzer_time_format.mjs';
import { GSRCSVParser } from './csv_parser.mjs';
import { CVXEDA } from './cvxeda.mjs';
import { SCRDeconvolution } from './deconvolution.mjs';
import { calcEmFog } from './em_fog.mjs';
import { detectAndRepairGsrDisconnects } from './gsr_disconnect_repair.mjs';
import { GsrFilter } from './gsr_filter.mjs';
import { PeakDetectors } from './peak_detectors.mjs';
import { PeakShape } from './peak_shape.mjs';
import { ResponseDynamics } from './response_dynamics.mjs';
import { SpectralEDA } from './spectral_eda.mjs';

export class GSRAnalyzer {
  constructor() {
    this.raw = []; // Raw signal: { time, val, lat, lon, hdop, pdop, sats, fixType, speedKts, course, hasGps }
    this.filtered = []; // Cleaned signal: { time, val }
    this.tonic = []; // Tonic component (SCL): { time, val }
    this.phasic = []; // Phasic component (SCR): { time, val }
    this.tonicZ = []; // Z-score Tonic component (SCL): { time, val }
    this.phasicZ = []; // Z-score Phasic component (SCR): { time, val }
    this.phasicStd = 1; // Standard deviation of phasic component for Z-scaling peaks
    this.peaks = []; // Detected peaks with shape metrics:
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
    this.peakDensity = []; // Sliding-window NS-SCR frequency: { time, val } — peaks/minute
    this.phasicAUC = []; // Sliding-window phasic integral: { time, val } — µS·s. In a
    // deconvolution/cvxEDA run this integrates the phasic DRIVER
    // (Benedek & Kaernbach's ISCR quantity); otherwise the
    // tonic-subtracted phasic response (ISCR-inspired).
    this.phasicAUCIsISCR = false; // true when phasicAUC integrated the driver (see above)
    this.arousalIndex = []; // Combined tonic+phasic z-scored blend: { time, val }
    this.triIndex = []; // Tri Index (tonic + phasic AUC + peak density) z-scored blend: { time, val }
    this.edasymp = []; // EDASymp spectral sympathetic index: { time, val } — µS²
    // (Posada-Quintero & Chon 2016, 0.045–0.25 Hz band power).
    // Computed from this.raw by SpectralEDA (spectral_eda.js),
    // independent of the filter/detector sliders, and cached
    // across re-analyses keyed on raw identity + length.
    this._edasympCache = null;

    // Deconvolution state (Benedek & Kaernbach, 2010).
    this.phasicDriver = []; // Raw driver signal: { time, val }
    this.phasicClean = []; // Reconstructed clean phasic
    this.phasicDriverPeaks = []; // Driver impulse list
    this.phasicDeconvTruncated = false; // True if matching pursuit hit maxIter before converging
    this._phasicOrig = null; // Pre-deconvolution phasic backup (only set when deconvolution is on)
    this._tonicOrig = null; // Pre-cvxEDA tonic backup (cvxEDA re-estimates tonic jointly)
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
    this._sparsedaKinetics = null; // SparsEDA band kernels, for peak rise times
    this.sparsedaStats = null;
    this.responseDynamics = [];

    this.sampleRate = 10; // In Hz, auto-detected
    this.isResistance = false; // Whether original CSV was resistance (Ohms)
    this.hasGpsData = false; // Whether raw signal contains valid GPS coordinates
    this.filteredGps = [];
    this._userPeakLabels = new Map(); // Persistent time-indexed store: timestamp (sec) -> label string
    // Same idea for exclusions: timestamp (sec) -> true (excluded) / false
    // (explicitly re-included, which must beat an exclusion imported from CSV).
    this._userPeakExclusions = new Map();

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
    // Disconnect detection output, cached alongside this.raw identity/length
    // like the series pool above; see gsr_disconnect_repair.mjs. Detection
    // itself always runs (it's a cheap O(n) pass, cached per raw load, not
    // per analyze() call) so this.gsrDisconnectSpans is available for other
    // consumers — e.g. the environmental dashboard excludes these samples
    // from its correlation stats — regardless of the repairGsrDisconnects
    // toggle. That toggle only controls whether the *main filter pipeline*
    // (stage 1 onward) is fed the straight-line-bridged values instead of
    // the pristine ones; a span's presence in this list never implies the
    // signal curves were altered.
    this._disconnectRepairCache = null;
    this.gsrDisconnectSpans = null;
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
    if (
      this._seriesPoolRaw === raw &&
      this._rawValsPool &&
      this._rawValsPool.length === n
    ) {
      return;
    }

    if (
      this._seriesPoolRaw === raw &&
      this._rawValsPool &&
      this._rawValsPool.length > 0 &&
      this._rawValsPool.length < n
    ) {
      const oldN = this._rawValsPool.length;
      let mn = this._rawGlobalRange.min,
        mx = this._rawGlobalRange.max;
      for (let i = oldN; i < n; i++) {
        const v = raw[i].val;
        this._rawValsPool.push(v);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this._rawGlobalRange = { min: mn, max: mx };
      for (const key of [
        'filtered',
        'tonic',
        'phasic',
        'tonicZ',
        'phasicZ',
        'em_fog',
      ]) {
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
    let mn = Infinity,
      mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = raw[i].val;
      rawVals[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    this._rawValsPool = rawVals;
    this._rawGlobalRange = { min: mn, max: mx };

    this._seriesPool = {};
    for (const key of [
      'filtered',
      'tonic',
      'phasic',
      'tonicZ',
      'phasicZ',
      'em_fog',
    ]) {
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
    this._deconvSolveCache = null; // ditto (keyed on the prefix's phasic array)
    this._wasDeconv = false; // fresh zeroed pool buffers — no deconvolution state to carry

    this._seriesPoolRaw = raw;
  }

  /**
   * Overwrite the reused series buffer for `key` from a parallel value array,
   * recording its min/max in this._seriesRange[key] in the same pass.
   * @private
   */
  _fillSeries(key, vals) {
    const arr = this._seriesPool[key];
    let mn = Infinity,
      mx = -Infinity;
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
    const cleanLabel = GSRCSVParser.cleanLabel(label);
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
   * Pair each stored label with the detected peak showing it: same text,
   * within 1 s, closest pairs first, each side used at most once. Two nearby
   * peaks can carry the same text, so "any same-text peak within 1 s" would
   * credit one peak with both entries.
   * @returns {Map<number, object>} store key -> peak
   * @private
   */
  _matchLabelEntriesToPeaks() {
    const pairs = [];
    for (const pk of this.peaks || []) {
      const text = GSRCSVParser.cleanLabel(pk.label);
      if (!text) continue;
      for (const [t, stored] of this._userPeakLabels) {
        const diff = Math.abs(pk.time - t);
        if (stored === text && diff <= 1.0) pairs.push({ t, pk, diff });
      }
    }
    pairs.sort((a, b) => a.diff - b.diff);
    const byKey = new Map();
    const usedPeaks = new Set();
    for (const { t, pk } of pairs) {
      if (byKey.has(t) || usedPeaks.has(pk)) continue;
      byKey.set(t, pk);
      usedPeaks.add(pk);
    }
    return byKey;
  }

  /**
   * Set a detected peak's label from a user edit. Drops the store entry that
   * held the peak's previous text first: after re-analysis a peak can sit up
   * to 1 s from the time its label was stored under, so writing at peak.time
   * alone would leave the old text behind as a hidden, still-exported label.
   */
  relabelPeak(peak, label) {
    for (const [t, pk] of this._matchLabelEntriesToPeaks()) {
      if (pk === peak) this._userPeakLabels.delete(t);
    }
    peak.label = label;
    this.setPeakLabel(peak.time, label);
  }

  /**
   * Stored labels with no detected peak showing them right now (e.g. the
   * peak threshold was raised past it). They are still the user's labels and
   * must be exported, or saving would silently drop them.
   * @returns {Array<{time:number, label:string}>}
   */
  hiddenPeakLabels() {
    const shown = this._matchLabelEntriesToPeaks();
    const hidden = [];
    for (const [t, text] of this._userPeakLabels) {
      if (!shown.has(t)) hidden.push({ time: t, label: text });
    }
    return hidden;
  }

  /**
   * Toggle (or set) a peak's excluded flag by index. Recorded by time in
   * _userPeakExclusions so it survives re-analysis the way labels do — an
   * index-only record was lost as soon as a slider drag hid the peak.
   */
  setPeakExcluded(idx, excluded) {
    const peak = this.peaks[idx];
    if (!peak) return;
    for (const [t, pk] of this._matchExclusionEntriesToPeaks()) {
      if (pk === peak) this._userPeakExclusions.delete(t);
    }
    peak.excluded = !!excluded;
    this._userPeakExclusions.set(Number(peak.time.toFixed(3)), !!excluded);
    this._dataVersion++;
    if (this._driverAlgorithm === 'sparseda') {
      this.responseDynamics = this.computeResponseDynamics();
    }
  }

  /**
   * Pair each stored exclusion decision with its detected peak: within 1 s,
   * closest pairs first, each side used at most once (as for labels).
   * @returns {Map<number, object>} store key -> peak
   * @private
   */
  _matchExclusionEntriesToPeaks() {
    const pairs = [];
    for (const pk of this.peaks || []) {
      for (const t of this._userPeakExclusions.keys()) {
        const diff = Math.abs(pk.time - t);
        if (diff <= 1.0) pairs.push({ t, pk, diff });
      }
    }
    pairs.sort((a, b) => a.diff - b.diff);
    const byKey = new Map();
    const usedPeaks = new Set();
    for (const { t, pk } of pairs) {
      if (byKey.has(t) || usedPeaks.has(pk)) continue;
      byKey.set(t, pk);
      usedPeaks.add(pk);
    }
    return byKey;
  }

  /** Apply the stored exclusion decisions to freshly detected peaks. @private */
  _assignExclusionsToPeaks() {
    if (this._userPeakExclusions.size === 0) return;
    for (const [t, pk] of this._matchExclusionEntriesToPeaks()) {
      pk.excluded = this._userPeakExclusions.get(t);
    }
  }

  /**
   * Excluded peaks not detected under the current settings. Exported so a
   * save doesn't drop them (see hiddenPeakLabels).
   * @returns {Array<{time:number}>}
   */
  hiddenPeakExclusions() {
    const shown = this._matchExclusionEntriesToPeaks();
    const hidden = [];
    for (const [t, excluded] of this._userPeakExclusions) {
      if (excluded && !shown.has(t)) hidden.push({ time: t });
    }
    return hidden;
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
    if (
      !peaks ||
      peaks.length === 0 ||
      !this._userPeakLabels ||
      this._userPeakLabels.size === 0
    )
      return;

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
          return targetTime - midTime < data[mid + 1].time - targetTime
            ? mid
            : mid + 1;
        }
        low = mid + 1;
      } else {
        if (mid > 0 && data[mid - 1].time < targetTime) {
          return targetTime - data[mid - 1].time < midTime - targetTime
            ? mid - 1
            : mid;
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
    const filtered = this.filteredGps?.[index];
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
    return !!this.raw?.some(
      (d) =>
        d.hasGps ||
        (!isNaN(d.lat) &&
          !isNaN(d.lon) &&
          (Math.abs(d.lat) > 0.0001 || Math.abs(d.lon) > 0.0001)),
    );
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
    return AnalyzerTimeFormat.clockTime(
      this.recordingStartTime,
      relativeSeconds,
    );
  }

  /** Alias of formatClockTime — kept for call-site clarity. */
  formatTimeOnly(relativeSeconds) {
    return AnalyzerTimeFormat.clockTime(
      this.recordingStartTime,
      relativeSeconds,
    );
  }

  /** UK-formatted date, e.g. "30th Dec 2026" (relative clock fallback). */
  formatDateUK(relativeSeconds) {
    return AnalyzerTimeFormat.dateUK(this.recordingStartTime, relativeSeconds);
  }

  /** Short numeric date, e.g. "30.12.2026" (relative clock fallback). */
  formatDateShort(relativeSeconds) {
    return AnalyzerTimeFormat.dateShort(
      this.recordingStartTime,
      relativeSeconds,
    );
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
    for (const [t, label] of this._importedPeakLabels.entries()) {
      this.setPeakLabel(t, label);
    }
    for (const t of (result.importedPeakExcluded || new Map()).keys()) {
      this._userPeakExclusions.set(Number(t.toFixed(3)), true);
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
    // Only filter / decomposition params feed this prefix; the peak-detection /
    // hotspot / metric-window sliders don't. When none changed since the last
    // analyze(), the pooled .filtered/.tonic/.phasic arrays (and their cached
    // Y-ranges) are still correct — skip ~25 ms of filtering + decomposition on
    // a 40k-row track and reuse them. Keyed alongside this.raw identity, which
    // _ensureSeriesPool() nulls the cache on.
    const prefixKey =
      params.medianSize +
      '|' +
      params.lpfWindow +
      '|' +
      (params.lpfMethod || 'butterworth') +
      '|' +
      params.tonicWindow +
      '|' +
      params.tonicMethod +
      '|' +
      !!params.useGaitFilter +
      '|' +
      !!params.repairGsrDisconnects;

    // Disconnect detection always runs and is cached once per raw-data load
    // (see the constructor comment) — this.gsrDisconnectSpans is available
    // to other consumers regardless of the toggle below. repairGsrDisconnects
    // (off by default) only decides whether stage 1 is fed the straight-line-
    // bridged values in place of the pristine _rawValsPool; this.raw itself
    // is never mutated, so the "Raw" curve keeps showing what was recorded.
    if (
      !this._disconnectRepairCache ||
      this._disconnectRepairCache.raw !== this.raw ||
      this._disconnectRepairCache.vals.length !== n
    ) {
      const { vals, spans } = detectAndRepairGsrDisconnects(this.raw);
      this._disconnectRepairCache = { raw: this.raw, vals, spans };
    }
    this.gsrDisconnectSpans = this._disconnectRepairCache.spans;
    const rawInputVals = params.repairGsrDisconnects
      ? this._disconnectRepairCache.vals
      : this._rawValsPool;

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
        this.phasicZ = GsrFilter.standardizeSignal(
          this.phasic,
          this._seriesPool.phasicZ,
        );
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
      // 1. Artifact Removal (Hampel MAD outlier rejection)
      const medWindowSize = Math.max(
        1,
        Math.round(params.medianSize * this.sampleRate),
      );
      const afterArtifact = GsrFilter.applyHampelFilter(
        rawInputVals,
        medWindowSize,
      );

      // 2. Smoothing Low-Pass (Zero-phase 4th-order Butterworth, NeuroKit-style)
      let afterSmooth = afterArtifact;
      const lpfWinSize = params.lpfWindow * this.sampleRate;
      if (lpfWinSize > 1) {
        if (params.lpfMethod === 'box') {
          afterSmooth = GsrFilter.applyZeroPhaseMovingAverage(
            afterSmooth,
            lpfWinSize,
          );
        } else {
          const bwCutoff =
            params.lpfCutoff ||
            Math.max(
              0.5,
              Math.min(this.sampleRate / 2 - 0.1, 1.0 / params.lpfWindow),
            );
          afterSmooth = GsrFilter.applyZeroPhaseButterworth(
            afterSmooth,
            bwCutoff,
            4,
            this.sampleRate,
          );
        }
      }

      // 3. Gait Filter (Zero-phase Linkwitz-Riley LR4 @ 1.0Hz)
      let afterLPF = afterSmooth;
      if (params.useGaitFilter) {
        const gf = GSR_CONST?.GAIT_FILTER || { cutoffHz: 1.0, type: 'lr4' };
        if (gf.type === 'butterworth') {
          afterLPF = GsrFilter.applyZeroPhaseButterworth(
            afterLPF,
            gf.cutoffHz,
            gf.order || 4,
            this.sampleRate,
          );
        } else {
          afterLPF = GsrFilter.applyZeroPhaseLinkwitzRiley(
            afterLPF,
            gf.cutoffHz,
            this.sampleRate,
          );
        }
      }

      this._fillSeries('filtered', afterLPF);

      // 3. Tonic/Phasic Decomposition
      const decomp = GsrFilter.decomposeTonicPhasic(
        afterLPF,
        this.sampleRate,
        params,
      );
      const tonicVals = decomp.tonic;
      phasicVals = decomp.phasic;

      this._fillSeries('tonic', tonicVals);
      this._fillSeries('phasic', phasicVals);

      // Compute Z-Scores and cache standard deviation of phasic values for peak scaling
      this.tonicZ = GsrFilter.standardizeSignal(
        this.tonic,
        this._seriesPool.tonicZ,
      );
      this.phasicZ = GsrFilter.standardizeSignal(
        this.phasic,
        this._seriesPool.phasicZ,
      );
      this.phasicStd = GsrFilter.calculateStats(phasicVals).std;
      // The pooled phasicZ buffer and the pristine ranges below are now rebuilt
      // from pristine data; any lingering deconvolution state is stale. (If this
      // analyze() is itself a deconvolution run, _runDeconvolutionPipeline() sets
      // the flag again straight after.)
      this._wasDeconv = false;

      // Pre-compute continuous metrics that depend only on tonic / phasic:
      const pristineAUC = this.computePhasicAUC();
      const aiCfg = GSR_CONST?.AROUSAL_INDEX || { wTonic: 0.3, wPhasic: 0.7 };
      const pristineArousal = this.computeCombinedArousalIndex(
        aiCfg.wTonic,
        aiCfg.wPhasic,
        pristineAUC,
      );

      let aucMn = Infinity,
        aucMx = -Infinity;
      for (let i = 0; i < pristineAUC.length; i++) {
        const v = pristineAUC[i].val;
        if (v < aucMn) aucMn = v;
        if (v > aucMx) aucMx = v;
      }
      let aiMn = Infinity,
        aiMx = -Infinity;
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

    // 5. Phasic Peak Detection. Exactly one of five mutually-exclusive
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
    //   - cvxEDA / sparsEDA (params.useCvxEDA / params.useSparsEDA): the same
    //     deconvolution pipeline with a different solver (deconvAlgorithm).
    // Precedence when several flags are set: prominence > cvxEDA >
    // sparsEDA > deconvolution > full-scan (default).
    if (params.usePeakProminence) {
      this._clearDeconvState();
      this._detectPeaksByProminence(params);
    } else if (params.useCvxEDA) {
      this._runDeconvolutionPipeline(phasicVals, {
        ...params,
        deconvAlgorithm: 'cvxeda',
      });
    } else if (params.useSparsEDA) {
      this._runDeconvolutionPipeline(phasicVals, {
        ...params,
        deconvAlgorithm: 'sparseda',
      });
    } else if (params.useDeconvolution) {
      this._runDeconvolutionPipeline(phasicVals, params);
    } else {
      this._clearDeconvState();
      this._detectPeaksFullScan(params);
    }

    // 5b. Memorable-event ("hotspot") selection — see _selectMemorableEvents().
    this.memorableEvents = this._selectMemorableEvents(params, peakLatency);

    // 6. Continuous, threshold-independent arousal metrics (ISCR/AUC + combined index + EM Fog)
    const densityWin =
      params && params.peakDensityWindow != null
        ? params.peakDensityWindow
        : null;
    this.peakDensity = this.computeTemporalPeakDensity(densityWin);

    const aiCfg = GSR_CONST?.AROUSAL_INDEX || { wTonic: 0.3, wPhasic: 0.7 };
    const triCfg = GSR_CONST?.TRI_INDEX || {
      wTonic: 0.1,
      wPhasic: 0.45,
      wDensity: 0.45,
    };

    if (params.useDeconvolution || params.useCvxEDA || params.useSparsEDA) {
      this.phasicAUC = this.computePhasicAUC(); // integrates the driver → sets phasicAUCIsISCR
      this.arousalIndex = this.computeCombinedArousalIndex(
        aiCfg.wTonic,
        aiCfg.wPhasic,
        this.phasicAUC,
      );
    } else {
      // Cached AUC is always the pristine phasic-response integral.
      this.phasicAUC = this._prefixCache.phasicAUC;
      this.arousalIndex = this._prefixCache.arousalIndex;
      this.phasicAUCIsISCR = false;
    }
    this.triIndex = this.computeTriIndex(
      triCfg.wTonic,
      triCfg.wPhasic,
      triCfg.wDensity,
      this.phasicAUC,
      this.peakDensity,
    );
    this._computeEDASymp(rawInputVals);
    const efArr = this._seriesPool.em_fog;
    let efMn = Infinity,
      efMx = -Infinity;
    for (let i = 0; i < n; i++) {
      const e = this.raw[i].em_fog;
      const v = e !== undefined && !isNaN(e) ? e : 0;
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
    this.sparsedaStats = null;
    this.responseDynamics = [];
  }

  /**
   * SparsEDA's lasso stops once a 70 s window's residual L2 norm reaches
   * epsilon. A fixed value is either too loose for a quiet sensor (stops
   * before real responses are fitted) or too tight for a noisy one (keeps
   * fitting noise as responses), so scale it to this track's noise σ̂
   * (_noiseSigma), times √N for the window's N samples at SparsEDA's 8 Hz
   * work rate, times a multiplier, clamped to [floor, cap]. The cap is the
   * top of the range the ground-truth sweep validated: real recordings (the
   * live ones especially) can measure far noisier than any synthetic track,
   * and an unclamped epsilon there drops most of a walk's responses.
   * @private
   */
  _sparsedaEpsilon(scf) {
    const floor = scf.sparsedaEpsilon ?? 0.1;
    const mult = scf.sparsedaEpsilonNoiseMult ?? 8;
    const cap = scf.sparsedaEpsilonCap ?? 1.0;
    if (!(mult > 0)) return floor;
    const WINDOW_SAMPLES = 70 * 8; // SparsEDA window (70 s) at 8 Hz
    const eps = mult * Math.sqrt(WINDOW_SAMPLES) * this._noiseSigma();
    return Math.min(Math.max(floor, cap), Math.max(floor, eps));
  }

  /**
   * Robust white noise σ̂ (µS) left in the signal SparsEDA's input is built
   * from: 1.4826·median|Δfiltered| / √2 (differencing white noise scales its
   * σ by √2; SCRs rise over seconds, so Δ is dominated by the noise). Read
   * AFTER the gait filter: on raw, footstep ripple counts as noise and a walk
   * is judged far noisier than it is. Memoised on the raw array plus the
   * prefix key — .filtered is a pooled buffer rewritten in place, so its
   * identity says nothing about which filter settings produced it. 0 when
   * unavailable.
   * @private
   */
  _noiseSigma() {
    const x = this.filtered;
    const n = x?.length ?? 0;
    if (n < 10) return 0;
    const key = this._prefixCache?.key;
    const memo = this._noiseSigmaMemo;
    if (key && memo?.raw === this.raw && memo.key === key) return memo.sigma;
    const dev = new Float64Array(n - 1);
    for (let i = 1; i < n; i++) dev[i - 1] = Math.abs(x[i].val - x[i - 1].val);
    dev.sort();
    const sigma = (1.4826 * dev[(n - 1) >> 1]) / Math.SQRT2;
    this._noiseSigmaMemo = key ? { raw: this.raw, key, sigma } : null;
    return sigma;
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
    this.sparsedaStats = null;
    this.responseDynamics = [];
    this._wasDeconv = true;
    if (n === 0) {
      this.peaks = [];
      return;
    }

    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();

    const scf = GSR_CONST.SCRF;
    const times = this.phasic.map((d) => d.time);
    const phasicArr = new Float64Array(phasicVals);

    // Opt-in cvxEDA convex optimization algorithm (Greco et al., 2016)
    const algorithm =
      params.deconvAlgorithm || scf.deconvAlgorithm || 'matching_pursuit';
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
      // its own reference defaults. Resolved to local consts (not inlined
      // below) so the kernel built for apex-resolution further down uses the
      // exact same taus the solve itself used.
      const cvxCfg = GSR_CONST.CVXEDA || {};
      const tauSlow = cvxCfg.tauSlow ?? scf.tauSlow;
      const tauFast = cvxCfg.tauFast ?? scf.tauFast;
      const res = CVXEDA.decompose(scVals, this.sampleRate, {
        tauSlow,
        tauFast,
        alpha: cvxCfg.alpha,
        gamma: cvxCfg.gamma,
        maxIter: cvxCfg.maxIter,
      });
      const cleanVals = res.phasic;

      // Joint tonic estimate → this.tonic (fresh array; pool stays pristine).
      this._tonicOrig = this.tonic;
      const tonicClean = new Array(n);
      let toMn = Infinity,
        toMx = -Infinity;
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
      // cvx-prefixed overrides let this driver-domain candidate scan be tuned
      // independently of the matching-pursuit path below, which shares the
      // same scf.impulseThreshold/minImpulseGapSec keys for its own (differently-
      // scaled) driver — unset, these fall back to the exact prior behaviour.
      const thresh = scf.cvxImpulseThreshold ?? scf.impulseThreshold ?? 0.005;
      const minGap = Math.max(
        1,
        Math.round(
          (scf.cvxMinImpulseGapSec ?? scf.minImpulseGapSec ?? 0.5) *
            this.sampleRate,
        ),
      );
      let lastPIdx = -minGap;
      for (let i = 1; i < n - 1; i++) {
        if (
          res.driver[i] >= thresh &&
          res.driver[i] >= res.driver[i - 1] &&
          res.driver[i] >= res.driver[i + 1]
        ) {
          if (i - lastPIdx >= minGap) {
            this.phasicDriverPeaks.push({
              index: i,
              time: times[i],
              amplitude: res.driver[i],
            });
            lastPIdx = i;
          }
        }
      }

      // Candidate apex positions for discrete peak detection come from the
      // sparse DRIVER (p = A·q), not a blind scan of the smooth reconstructed
      // curve (r = M·q) below — mirrors Ledalab's CDA approach (Benedek &
      // Kaernbach 2010a) of detecting SCRs in the deconvolved driver itself.
      // cvxEDA's L1 penalty drives sparsity via an optimisation constraint,
      // not a hard threshold, so small residual driver values between real
      // events still convolve through the Bateman kernel into faint ripple on
      // the reconstructed curve; a local-maximum scan of that curve (as the
      // matching-pursuit path below uses, fine there because MP's atoms are
      // cleanly separated) mistakes some of that ripple for extra events.
      // Scanning the driver's own local maxima first skips the ripple by
      // construction (see docs/eda_decomposition_analysis.md §3.E for the
      // measured effect: precision 69.4%→94.7%+ when NeuroKit2's independent
      // cvxEDA port is driven by an absolute-threshold driver-style picker
      // instead of the smoothed-curve default).
      //
      // A driver sample is each event's ARMA-model onset-ish position, not
      // its apex (same as the matching-pursuit driver below) — the true
      // apex sits roughly one kernel-peak-offset later in the reconstructed
      // curve, found by resolveApex()'s own search-window logic just below,
      // reused here rather than duplicated.
      const cvxKernel = SCRDeconvolution.buildSCRFKernel(
        this.sampleRate,
        tauSlow,
        tauFast,
        scf.kernelSec || 5.0,
      );
      const cvxKPeakIdx = this._kernelPeakOffset(cvxKernel);
      const cvxApexSearchHalfWin = Math.max(
        1,
        Math.round((scf.cvxApexSearchHalfWinSec ?? 0.5) * this.sampleRate),
      );
      const cvxCandidateIndices = this.phasicDriverPeaks.map(({ index }) => {
        const predicted = Math.min(n - 1, index + cvxKPeakIdx);
        const lo = Math.max(0, index, predicted - cvxApexSearchHalfWin);
        const hi = Math.min(n - 1, predicted + cvxApexSearchHalfWin);
        let bestIdx = Math.max(index, predicted),
          bestVal = cleanVals[bestIdx] || 0;
        for (let j = lo; j <= hi; j++) {
          if (cleanVals[j] > bestVal) {
            bestVal = cleanVals[j];
            bestIdx = j;
          }
        }
        return bestIdx;
      });

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
      this.phasicZ = GsrFilter.standardizeSignal(
        this.phasic,
        this._seriesPool?.phasicZ,
      );
      this.phasicStd = GsrFilter.calculateStats(cleanVals).std;
      let phMn = Infinity,
        phMx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = cleanVals[i];
        if (v < phMn) phMn = v;
        if (v > phMx) phMx = v;
      }
      this._seriesRange.phasic = { min: phMn, max: phMx };
      this.peaks = this._detectPeaksFromCurve(
        cleanVals,
        times,
        params,
        oldLabels,
        oldExcluded,
        cvxCandidateIndices,
      );
      this._assignLabelsToPeaks(this.peaks);
      this._assignExclusionsToPeaks();
      return;
    }

    this._driverAlgorithm =
      algorithm === 'sparseda' ? 'sparseda' : 'matching_pursuit';
    // Both SparsEDA and Matching Pursuit operate on the tonic-subtracted phasic
    // signal (phasicArr), leaving this.tonic as the smooth, physiological lower-envelope
    // baseline (with floor repositioning) computed by GsrFilter.decomposeTonicPhasic.
    // This avoids SparsEDA's unconstrained sliding-window polynomial baseline, which on
    // real continuous data suffers from boundary drift and rides above signal troughs.
    const deconvInput = phasicArr;
    const deconvOpts =
      algorithm === 'sparseda'
        ? {
            maxIter: scf.sparsedaKmax ?? 120,
            epsilon: this._sparsedaEpsilon(scf),
            dminSec: scf.sparsedaDminSec ?? 0.25,
            rho: scf.sparsedaRho ?? 0.0,
            // Input is the tonic-subtracted phasic (floor 0), not raw SC.
            zeroBaseline: true,
            algorithm: algorithm,
          }
        : {
            tauSlow: scf.tauSlow,
            tauFast: scf.tauFast,
            kernelSec: scf.kernelSec,
            maxIter: scf.maxIter,
            lr: scf.lr,
            convTol: scf.convTol,
            minImpulseGapSec: scf.minImpulseGapSec,
            algorithm: algorithm,
          };
    // The solve depends only on the phasic input and the solver options, not
    // on any peak-detection slider (threshold, SNR, quality, hotspots), so
    // reuse it while those are all that changed. phasicVals is the prefix
    // cache's array, so its identity changes exactly when filtering or
    // decomposition does. Nothing below mutates `result` (every downstream
    // array or impulse object is a fresh copy).
    const solveKey = `${this.sampleRate}|${JSON.stringify(deconvOpts)}`;
    const sc = this._deconvSolveCache;
    const result =
      sc && sc.input === phasicVals && sc.key === solveKey
        ? sc.result
        : SCRDeconvolution.deconvolve(deconvInput, this.sampleRate, deconvOpts);
    this._deconvSolveCache = { input: phasicVals, key: solveKey, result };

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
      const impulseLogMap = new Map();
      if (Array.isArray(result.impulseLog)) {
        for (const logEntry of result.impulseLog) {
          impulseLogMap.set(
            logEntry.trueIndex ?? logEntry.clampedIndex,
            logEntry,
          );
        }
      }
      this.phasicDriverPeaks = [];
      for (let i = 0; i < n; i++) {
        if (result.driver[i] > 0) {
          const meta = impulseLogMap.get(i);
          this.phasicDriverPeaks.push({
            index: i,
            time: times[i],
            amplitude: result.driver[i],
            height: meta ? meta.height : result.driver[i],
            onsetSec: meta ? meta.onsetSec : i / this.sampleRate,
            bandAmps: meta ? meta.bandAmps : null,
            bandIdx: meta ? meta.bandIdx : 2,
            durationScale: meta ? meta.durationScale : 1.0,
            scaleFactor: meta ? meta.scaleFactor : 1.0,
            speedLabel: meta ? meta.speedLabel : 'Standard',
          });
        }
      }
      this._sparsedaKinetics = result.bandKernels
        ? {
            bandKernels: result.bandKernels,
            workRate: result.workRate,
            signal: deconvInput,
          }
        : null;
      reconstructionImpulses = this.phasicDriverPeaks.map(
        ({ index, amplitude }) => ({ index, amplitude }),
      );
      cleanValsRaw =
        result.clean && result.clean.length === n
          ? new Float64Array(result.clean)
          : SCRDeconvolution.reconstructPhasic(
              reconstructionImpulses,
              n,
              result.kernel,
            );
    } else {
      // Global impulse detection: minImpulseGapSec is enforced exactly once,
      // across the whole track, so no two accepted impulses can be closer than
      // that regardless of how many original peaks would once have generated
      // overlapping local windows around them.
      const rawImpulses = SCRDeconvolution.detectImpulses(
        result.driver,
        this.sampleRate,
        scf.impulseThreshold,
        scf.minImpulseGapSec,
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
        if (!logByClampedIndex.has(entry.clampedIndex))
          logByClampedIndex.set(entry.clampedIndex, []);
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
        let bestIdx = Math.max(onsetIdx, predicted),
          bestVal = phasicVals[bestIdx] || 0;
        for (let i = lo; i <= hi; i++) {
          if (phasicVals[i] > bestVal) {
            bestVal = phasicVals[i];
            bestIdx = i;
          }
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
        .map((imp) => ({ imp, ...resolveApex(dominantTrueIndex(imp.index)) }))
        .filter(
          ({ imp, apexVal }) =>
            imp.amplitude >= threshold && apexVal >= minApexVal,
        );
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
          for (const e of entries)
            reconstructionImpulses.push({
              index: e.trueIndex,
              amplitude: e.amplitude,
            });
        } else {
          reconstructionImpulses.push({
            index: imp.index,
            amplitude: imp.amplitude,
          });
        }
      }
      // Always rebuild from the GATED set. deconvolve() also returns its own
      // `clean`, but that is every matching-pursuit atom, including the ones
      // the gate above just rejected — using it would make the gate a no-op
      // and break the rescaling invariant below.
      cleanValsRaw = SCRDeconvolution.reconstructPhasic(
        reconstructionImpulses,
        n,
        result.kernel,
      );
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
      let sumClean = 0,
        sumPhasic = 0;
      for (let i = 0; i < n; i++) {
        sumClean += cleanValsRaw[i];
        sumPhasic += phasicVals[i];
      }
      if (sumClean > 0) {
        const rawRescale = sumPhasic / sumClean;
        const kernelSamples = scf.kernelSec * this.sampleRate;
        const sortedIdx = reconstructionImpulses
          .map((imp) => imp.index)
          .sort((a, b) => a - b);
        let overlapWeight = 0;
        for (let k = 1; k < sortedIdx.length; k++) {
          const gap = sortedIdx[k] - sortedIdx[k - 1];
          if (gap < kernelSamples) overlapWeight += 1 - gap / kernelSamples;
        }
        const atomDensity =
          sortedIdx.length > 1 ? overlapWeight / (sortedIdx.length - 1) : 0;
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
      for (const imp of reconstructionImpulses)
        imp.amplitude *= rescaleAmplitudes;
      for (const imp of this.phasicDriverPeaks)
        imp.amplitude *= rescaleAmplitudes;
      // Rescale the driver array in-place so phasicDriver display is consistent.
      for (let i = 0; i < n; i++) this.phasicDriver[i].val *= rescaleAmplitudes;
      cleanVals = new Float64Array(n);
      for (let i = 0; i < n; i++)
        cleanVals[i] = cleanValsRaw[i] * rescaleAmplitudes;
    }
    this.phasicClean = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicClean[i] = { time: times[i], val: cleanVals[i] };
    }
    this._phasicOrig = this.phasic;
    this.phasic = this.phasicClean;
    this.phasicZ = GsrFilter.standardizeSignal(
      this.phasic,
      this._seriesPool?.phasicZ,
    );
    this.phasicStd = GsrFilter.calculateStats(cleanVals).std;
    // this.phasic is now the reconstructed curve, not the pooled pristine one
    // _fillSeries() ranged in analyze() — refresh its cached Y-range so
    // _buildDisplayCache() (and the plot's global-range fast path) match what
    // deconvolution mode actually draws.
    let phMn = Infinity,
      phMx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = cleanVals[i];
      if (v < phMn) phMn = v;
      if (v > phMx) phMx = v;
    }
    this._seriesRange.phasic = { min: phMn, max: phMx };

    // Build the final, displayed peak list by scanning the reconstructed
    // curve directly (both matching pursuit and SparsEDA). SparsEDA used to
    // map each driver atom to one apex via a kernel-offset window, copied
    // from the cvxEDA branch — but there the indirection filters L1 ripple,
    // whereas this curve is literally a sum of non-negative atoms, so every
    // local maximum on it is atom-supported already. Where responses overlap,
    // several atoms' windows landed on the same neighbour and a visible peak
    // between them got no candidate at all. Ground truth: the direct scan
    // recovers +2-3% of responses at unchanged precision.
    this.peaks = this._detectPeaksFromCurve(
      cleanVals,
      times,
      params,
      oldLabels,
      oldExcluded,
      null,
    );
    this._assignExclusionsToPeaks(); // before computeResponseDynamics(), which skips excluded peaks
    if (algorithm === 'sparseda') {
      this._tagSparsedaPeaksAndStats();
      this.responseDynamics = this.computeResponseDynamics();
    }
    this._assignLabelsToPeaks(this.peaks);
  }

  /**
   * Compute a continuous event-gated autonomic response speed dynamics series.
   * Delegated to the ResponseDynamics domain module.
   *
   * @returns {Array<{ time: number, val: number }>}
   */
  computeResponseDynamics() {
    const n =
      this.raw && this.raw.length > 0
        ? this.raw.length
        : this.times
          ? this.times.length
          : 0;
    const RD = ResponseDynamics;
    if (!RD) return [];
    return RD.computeSeries({
      n,
      sampleRate: this.sampleRate || 4,
      raw: this.raw,
      times: this.times,
      peaks: this.peaks,
      isSparseda: this._driverAlgorithm === 'sparseda',
    });
  }

  /**
   * Annotate detected peaks with SparsEDA response speed (from each peak's
   * measured rise time — see ResponseDynamics.REFERENCE_RISE_SEC) and band index,
   * and compute track-level summary dynamics statistics.
   * Delegated to the ResponseDynamics domain module.
   * @private
   */
  _tagSparsedaPeaksAndStats() {
    const RD = ResponseDynamics;
    if (!RD) return;
    this.sparsedaStats = RD.tagPeaks(
      this.peaks,
      this.phasicDriverPeaks,
      this.sampleRate,
      this._sparsedaKinetics,
    );
  }

  /**
   * Build the final discrete deconvolution-mode peak list by scanning the
   * reconstructed, superposition-resolved phasicClean curve for local
   * maxima. Delegates to PeakDetectors.detectPeaksFromCurve — see that
   * function's doc comment for the algorithm and the candidateIndices param.
   * @private
   */
  _detectPeaksFromCurve(
    cleanVals,
    times,
    params,
    oldLabels,
    oldExcluded,
    candidateIndices = null,
  ) {
    return PeakDetectors.detectPeaksFromCurve(
      cleanVals,
      times,
      this.sampleRate,
      params,
      oldLabels,
      oldExcluded,
      candidateIndices,
      this._peakDetectionCtx(),
    );
  }

  /**
   * Construct a peak object from shape metrics, resolving labels and exclusion
   * flags from both the in-memory store and (optionally) imported CSV data.
   * Delegates to PeakShape.buildPeakObject.
   * @private
   */
  _buildPeakObject(i, currVal, vals, times, shape, oldLabels, oldExcluded) {
    return PeakShape.buildPeakObject(
      i,
      currVal,
      vals,
      times,
      shape,
      oldLabels,
      oldExcluded,
      this._peakDetectionCtx(),
    );
  }

  /**
   * Bundles the analyzer state the peak_shape.js / peak_detectors.js pure
   * modules need but don't own themselves: the filtered series (noise-floor
   * estimation), user/imported label lookups, and a bound reference to
   * this._topographicProminence (not the module's own implementation
   * directly) so tests that stub _topographicProminence to count sweeps
   * still see every call made from inside the detectors.
   * @private
   */
  _peakDetectionCtx() {
    return {
      filtered: this.filtered,
      getMatchingLabel: (t) => this.getMatchingLabel(t),
      importedPeakLabels: this._importedPeakLabels,
      topographicProminence: (v) => this._topographicProminence(v),
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
    for (const key of ['peakDensity', 'triIndex', 'edasymp']) {
      const arr = this[key];
      if (!arr || arr.length === 0) continue;
      let mn = Infinity,
        mx = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        let v = arr[i].val;
        if (isNaN(v)) v = 0; // EDASymp yields 0 (not NaN) for a flat/zero-power band
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this._globalRange[key] = { min: mn, max: mx };
    }
    if (this._wasDeconv) {
      for (const key of [
        'phasicAUC',
        'arousalIndex',
        'phasicDriver',
        'responseDynamics',
      ]) {
        const arr = this[key];

        if (!arr || arr.length === 0) continue;
        let mn = Infinity,
          mx = -Infinity;
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i].val;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        this._globalRange[key] = { min: mn, max: mx };
      }
    } else if (this._prefixCache) {
      if (this._prefixCache.aucRange)
        this._globalRange.phasicAUC = this._prefixCache.aucRange;
      if (this._prefixCache.aiRange)
        this._globalRange.arousalIndex = this._prefixCache.aiRange;
    }
    if (this._seriesRange.em_fog)
      this._globalRange.em_fog = this._seriesRange.em_fog;

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
          .filter((pk) => !pk.excluded)
          .map((pk) => pk.time / totalDur);
      }
    }
  }

  /**
   * Walk back from apex `i` to the response onset. Delegates to PeakShape —
   * see that function's doc comment for the `minDip` behaviour.
   * @private
   */
  _findOnsetIndex(vals, i, maxOnsetSteps, minDip = 0) {
    return PeakShape.findOnsetIndex(vals, i, maxOnsetSteps, minDip);
  }

  /** @private */
  _findRecoveryIndex(vals, i, onsetIdx, amplitude) {
    return PeakShape.findRecoveryIndex(vals, i, onsetIdx, amplitude);
  }

  /** @private */
  _calculateShapeMetrics(vals, times, i, onsetIdx, recoveryIdx, noiseHalfWin) {
    return PeakShape.calculateShapeMetrics(
      vals,
      times,
      i,
      onsetIdx,
      recoveryIdx,
      noiseHalfWin,
      this.filtered,
    );
  }

  /**
   * Local noise floor around an index, for SNR estimation. Delegates to
   * PeakShape — see that function's doc comment for the estimator.
   */
  _computeNoiseFloor(idx, halfWindow) {
    return PeakShape.computeNoiseFloor(this.filtered, idx, halfWindow);
  }

  /**
   * Compute a quality score (0-1) for a detected peak from how well its
   * shape matches a canonical SCR. Delegates to PeakShape.
   */
  _computePeakQuality(peak) {
    return PeakShape.computePeakQuality(peak);
  }

  /**
   * Quality score (0-1) for a deconvolution-mode peak. Delegates to
   * PeakShape — see that function's doc comment for why this differs from
   * _computePeakQuality().
   */
  _computeDeconPeakQuality(peak) {
    return PeakShape.computeDeconPeakQuality(peak);
  }

  /**
   * "Memorability" / salience score (0-1) for a peak. Delegates to
   * PeakShape — see that function's doc comment for the blend.
   */
  _computeSalienceScore(peak) {
    return PeakShape.computeSalienceScore(peak);
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
    if (!(peakLatency > 0))
      return peak && peak.index !== undefined ? peak.index : 0;
    const si = this.stimulusIndexAt(
      peak && peak.time !== undefined ? peak.time : 0,
      peakLatency,
    );
    return si >= 0 ? si : peak && peak.index !== undefined ? peak.index : 0;
  }

  /**
   * Index of the sample the walker was at `lag` seconds before `time` — the
   * place a GSR reading at `time` actually responds to (see PhysioLatency).
   * -1 when the track is empty.
   */
  stimulusIndexAt(time, lag) {
    return this.findClosestIndex(Math.max(0, time - (lag || 0)));
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
    const a =
      Math.sin(dLat / 2) ** 2 +
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
    const magnitude = params?.usePeakProminence
      ? (p) => (p.prominence != null ? p.prominence : p.amplitude)
      : (p) => p.amplitude;
    const activeSorted = this.peaks
      .filter((p) => !p.excluded)
      .sort((a, b) => magnitude(b) - magnitude(a) || a.time - b.time);
    if (activeSorted.length === 0) return [];

    const percentile =
      params && params.hotspotPercentile != null
        ? params.hotspotPercentile
        : ME.HOTSPOT_PERCENTILE;
    const targetCount = Math.max(
      1,
      Math.round(activeSorted.length * percentile),
    );
    const minSepM = ME.MIN_SEPARATION_M != null ? ME.MIN_SEPARATION_M : 0;

    const selected = [];
    const selectedCoords = [];
    for (const p of activeSorted) {
      if (selected.length >= targetCount) break;
      const coords = this.getCoordinates(
        this._resolveHotspotIndex(p, peakLatency),
      );
      if (!coords) continue;
      if (
        minSepM > 0 &&
        selectedCoords.some(
          (c) =>
            this._haversineMeters(c.lat, c.lon, coords.lat, coords.lon) <
            minSepM,
        )
      ) {
        continue;
      }
      selected.push(p);
      selectedCoords.push(coords);
    }
    return selected;
  }

  /**
   * Snapshot any user-set labels and exclusion flags from the current peak list
   * so they survive re-analysis. Also merges labels imported from a re-loaded
   * processed CSV (matched by time); exclusions are re-applied by time from
   * _userPeakExclusions once detection finishes. Called at the top of every
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
      if (pk.label?.trim()) {
        this.setPeakLabel(pk.time, pk.label);
        oldLabels.set(pk.index, pk.label);
      }
      if (pk.excluded) oldExcluded.add(pk.index);
    }
    // Merge labels/exclusions imported from a re-loaded processed CSV (time-matched)
    if (this._importedPeakLabels && this._importedPeakLabels.size > 0) {
      for (const pk of this.peaks) {
        if (!pk.label?.trim()) {
          const imported = this._importedPeakLabels.get(pk.time);
          if (imported) oldLabels.set(pk.index, imported);
        }
      }
    }
    return { oldLabels, oldExcluded };
  }

  /**
   * Topographic prominence sweep — delegates to PeakDetectors. Kept as a
   * real instance method (not a bare module call at each call site) so
   * tests can stub it to count/inspect sweeps per analyze() call.
   * @private
   */
  _topographicProminence(vals) {
    return PeakDetectors.topographicProminence(vals);
  }

  /**
   * Above-threshold topographic-prominence local maxima under refractory-period
   * non-max suppression. Delegates to PeakDetectors.
   * @private
   */
  _prominenceNMS(vals, prom, threshold, minGap, baselineWin) {
    return PeakDetectors.prominenceNMS(
      vals,
      prom,
      threshold,
      minGap,
      baselineWin,
    );
  }

  /**
   * Prominence-based phasic peak detector (params.usePeakProminence).
   * Delegates to PeakDetectors.detectPeaksByProminence — see that function's
   * doc comment for the algorithm.
   * @param {object} params - Analysis params (peakThreshold, minPeakQuality).
   * @private
   */
  _detectPeaksByProminence(params) {
    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();
    this.peaks = PeakDetectors.detectPeaksByProminence(
      this.phasic,
      this.sampleRate,
      params,
      oldLabels,
      oldExcluded,
      this._peakDetectionCtx(),
    );
    this._assignLabelsToPeaks(this.peaks);
    this._assignExclusionsToPeaks();
  }

  /**
   * Build a full peak object at apex sample `idx` with onset at `onsetIdx`.
   * Delegates to PeakDetectors.
   * @private
   */
  _buildPeakWithMetrics(
    idx,
    onsetIdx,
    vals,
    times,
    prom,
    noiseHalfWin,
    oldLabels,
    oldExcluded,
  ) {
    return PeakDetectors.buildPeakWithMetrics(
      idx,
      onsetIdx,
      vals,
      times,
      prom,
      noiseHalfWin,
      oldLabels,
      oldExcluded,
      this._peakDetectionCtx(),
    );
  }

  /**
   * Full-scan phasic peak detector — the DEFAULT (no params flag; the else
   * branch of analyze()'s detector selection). Delegates to
   * PeakDetectors.detectPeaksFullScan — see that function's doc comment for
   * the algorithm.
   * @param {object} params - Analysis params (peakThreshold, shapeMinSnr, minPeakQuality).
   * @private
   */
  _detectPeaksFullScan(params) {
    const { oldLabels, oldExcluded } = this._preserveLabelsAndExclusions();
    this.peaks = PeakDetectors.detectPeaksFullScan(
      this.phasic,
      this.sampleRate,
      params,
      oldLabels,
      oldExcluded,
      this._peakDetectionCtx(),
    );
    this._assignLabelsToPeaks(this.peaks);
    this._assignExclusionsToPeaks();
  }
  /**
   * Continuous Temporal Peak Density (Non-Specific SCR Frequency), in
   * peaks/minute. Delegates to AnalyzerStats.computeTemporalPeakDensity —
   * see that function's doc comment for the KDE method.
   * @param {number|null} windowSizeSec - Spotlight time window in seconds (default: GSR_CONST.TEMPORAL_PEAK_DENSITY.windowSizeSec || 60)
   * @returns {Array<{time: number, val: number}>}
   */
  computeTemporalPeakDensity(windowSizeSec = null) {
    return AnalyzerStats.computeTemporalPeakDensity(
      this.phasic,
      this.peaks,
      windowSizeSec,
    );
  }

  /**
   * Sliding-window phasic integral, in µS·s. Delegates to
   * AnalyzerStats.computePhasicAUC, then applies its returned `isISCR` flag
   * to this.phasicAUCIsISCR (drives the UI label) — see that function's doc
   * comment for the ISCR-vs-phasic-response distinction.
   * @param {number} windowSizeSec - Temporal window width in seconds (default: 30)
   */
  computePhasicAUC(windowSizeSec = 30) {
    const { series, isISCR } = AnalyzerStats.computePhasicAUC(
      this.phasic,
      this.sampleRate,
      this._wasDeconv,
      this.phasicDriver,
      windowSizeSec,
    );
    this.phasicAUCIsISCR = isISCR;
    return series;
  }

  /**
   * Combined Arousal Index — a weighted, per-participant z-scored blend of
   * tonic baseline (SCL) and phasic AUC. Delegates to
   * AnalyzerStats.computeCombinedArousalIndex — see that function's doc
   * comment for the weighting rationale.
   * @param {number} wTonic - Weight for tonic SCL component (default: 0.3)
   * @param {number} wPhasic - Weight for phasic AUC component (default: 0.7)
   * @param {Array|null} precomputedAUC - Optional already-computed phasicAUC array
   *   (same 30 s window). When supplied by analyze(), skips the redundant
   *   computePhasicAUC(30) call (§B perf fix 2026-08-07).
   */
  computeCombinedArousalIndex(
    wTonic = 0.3,
    wPhasic = 0.7,
    precomputedAUC = null,
  ) {
    const auc = precomputedAUC || this.computePhasicAUC(30);
    return AnalyzerStats.computeCombinedArousalIndex(
      this.tonic,
      this.phasic,
      auc,
      wTonic,
      wPhasic,
    );
  }

  /**
   * Tri Index — a weighted, per-participant z-scored blend of tonic
   * baseline, phasic AUC and temporal peak density. Delegates to
   * AnalyzerStats.computeTriIndex — see that function's doc comment for the
   * default weighting.
   * @param {number} wTonic - Weight for tonic SCL component (default: 0.10)
   * @param {number} wPhasic - Weight for phasic AUC component (default: 0.45)
   * @param {number} wDensity - Weight for temporal peak density component (default: 0.45)
   * @param {Array|null} precomputedAUC - Optional already-computed phasicAUC array
   * @param {Array|null} precomputedDensity - Optional already-computed peakDensity array
   * @returns {Array<{time: number, val: number}>}
   */
  computeTriIndex(
    wTonic = 0.1,
    wPhasic = 0.45,
    wDensity = 0.45,
    precomputedAUC = null,
    precomputedDensity = null,
  ) {
    const auc = precomputedAUC || this.computePhasicAUC(30);
    const density = precomputedDensity || this.computeTemporalPeakDensity();
    return AnalyzerStats.computeTriIndex(
      this.tonic,
      this.phasic,
      auc,
      density,
      wTonic,
      wPhasic,
      wDensity,
    );
  }

  /**
   * EDASymp (0.045–0.25 Hz spectral sympathetic index) — Posada-Quintero &
   * Chon (2016), computed by the pure SpectralEDA module (spectral_eda.js).
   *
   * Runs on the raw (pre-filter) µS signal so it is independent of the
   * median / low-pass / tonic / detector sliders — a standalone spectral
   * metric, not a by-product of the decomposition. It still reads
   * `rawInputVals` (the disconnect-repaired series when that toggle is on)
   * rather than the pristine pool directly: an unbridged dropout is a sharp
   * step to and from the open-circuit floor, and Welch windowing would smear
   * that broadband transient across every frequency bin in any window that
   * overlaps it, corrupting the 0.045–0.25 Hz sympathetic band for the whole
   * window, not just the dropout's own samples. Because it depends on that
   * input (and sample rate), the per-sample series is cached keyed on raw
   * identity + length + which vals array fed it, so slider drags don't
   * re-run the Welch windowing, but toggling disconnect repair does.
   *
   * Guarded with `typeof SpectralEDA !== 'undefined'` so vm-based test
   * loaders that don't load spectral_eda.js still run analyze() (they just
   * leave edasymp empty) — same convention as GSRNotices.
   * @private
   */
  _computeEDASymp(rawInputVals) {
    const n = this.raw.length;
    if (n === 0 || typeof SpectralEDA === 'undefined') {
      this.edasymp = [];
      return;
    }

    const cache = this._edasympCache;
    if (
      cache &&
      cache.raw === this.raw &&
      cache.n === n &&
      cache.vals === rawInputVals
    ) {
      this.edasymp = cache.edasymp;
      return;
    }

    const cfg = GSR_CONST?.EDASYMP || {};
    const times = new Float64Array(n);
    for (let i = 0; i < n; i++) times[i] = this.raw[i].time;
    const series = SpectralEDA.computeSeries(
      rawInputVals,
      times,
      this.sampleRate,
      {
        windowSec: cfg.windowSec,
        hopSec: cfg.hopSec,
      },
    );
    this.edasymp = SpectralEDA.mapToSamples(series, times);
    this._edasympCache = {
      raw: this.raw,
      n,
      vals: rawInputVals,
      edasymp: this.edasymp,
    };
  }
  /**
   * Track-level summary statistics. Delegates to AnalyzerStats.getStats.
   */
  getStats() {
    return AnalyzerStats.getStats(
      this.raw,
      this.tonic,
      this.peaks,
      this.phasicAUC,
    );
  }

  /**
   * Export the current analysis state as a CSV string, including a header
   * comment preserving recording start time and filter/GPS params for
   * re-import. Delegates to AnalyzerExport.toCSV.
   */
  exportToCSV(params, gpsParams) {
    return AnalyzerExport.toCSV(
      {
        raw: this.raw,
        filtered: this.filtered,
        tonic: this.tonic,
        phasic: this.phasic,
        peaks: this.peaks,
        hiddenLabels: this.hiddenPeakLabels(),
        hiddenExclusions: this.hiddenPeakExclusions(),
        filteredGps: this.filteredGps,
        isEnriched: this.isEnriched,
        enrichmentRadius: this.enrichmentRadius,
        recordingStartTime: this.recordingStartTime,
      },
      params,
      gpsParams,
    );
  }

  /**
   * Calculate EM Fog Index (0-100) from RSSI readings across Sub-GHz bands.
   * Delegates to em_fog.mjs — the single source of truth, also reached
   * directly by GSRCSVParser.parse() for its dynamic EM-fog fallback.
   */
  static calcEmFog(row, bandFloors = null) {
    return calcEmFog(row, bandFloors);
  }
}
