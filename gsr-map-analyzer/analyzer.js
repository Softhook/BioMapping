// GSR/EDA Signal Analysis Engine with GPS coordinate parsing and interpolation
// Handles variable-rate (10 Hz GSR, 1 Hz GPS) CSV files.

class GSRAnalyzer {
  constructor() {
    this.raw = [];          // Raw signal: { time, val, lat, lon, alt, sats, fix, hasGps }
    this.filtered = [];     // Cleaned signal: { time, val }
    this.tonic = [];        // Tonic component (SCL): { time, val }
    this.phasic = [];       // Phasic component (SCR): { time, val }
    this.peaks = [];        // Detected peaks with shape metrics:
                            // { time, index, amplitude, onsetIndex, onsetTime, halfRecoveryTime,
                            //   riseTime, onsetSlope, decaySlope, skewnessRatio, fwhm, snr,
                            //   qualityScore, label }

    this.sampleRate = 10;   // In Hz, auto-detected
    this.isResistance = false; // Whether original CSV was resistance (Ohms)
    this.filteredGps = [];
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
  getCoordinates(index) {
    const raw = this.raw[index];
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
   * Format a relative time (seconds from recording start) as a clock time string.
   * If recordingStartTime is set (real timestamps were in the CSV), returns
   * a formatted time like "14:32:05".
   * Falls back to relative seconds display when no real clock time is available.
   */
  formatClockTime(relativeSeconds) {
    const absSeconds = this.recordingStartTime + relativeSeconds;
    const d = new Date(absSeconds * 1000);

    // If recordingStartTime is 0 or not a real date, show relative time
    if (!this.recordingStartTime || this.recordingStartTime < 86400) {
      const totalSec = Math.round(relativeSeconds);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      return h > 0
        ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
        : m + ':' + String(s).padStart(2, '0');
    }

    const hours = d.getUTCHours();
    const mins = d.getUTCMinutes();
    const secs = d.getUTCSeconds();
    return String(hours).padStart(2, '0') + ':' +
           String(mins).padStart(2, '0') + ':' +
           String(secs).padStart(2, '0');
  }

  /**
   * Returns just the formatted clock time, e.g. "14:32:05".
   * Falls back to relative seconds when no real clock time is available.
   */
  formatTimeOnly(relativeSeconds) {
    const absSeconds = this.recordingStartTime + relativeSeconds;
    const d = new Date(absSeconds * 1000);

    if (!this.recordingStartTime || this.recordingStartTime < 86400) {
      return this.formatClockTime(relativeSeconds);
    }

    return String(d.getUTCHours()).padStart(2, '0') + ':' +
           String(d.getUTCMinutes()).padStart(2, '0') + ':' +
           String(d.getUTCSeconds()).padStart(2, '0');
  }

  /**
   * Returns a UK-formatted date string, e.g. "30th Dec 2026".
   * Falls back to relative seconds display when no real clock time is available.
   */
  formatDateUK(relativeSeconds) {
    const absSeconds = this.recordingStartTime + relativeSeconds;
    const d = new Date(absSeconds * 1000);

    if (!this.recordingStartTime || this.recordingStartTime < 86400) {
      return this.formatClockTime(relativeSeconds);
    }

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = d.getUTCDate();
    const month = months[d.getUTCMonth()];
    const year = d.getUTCFullYear();

    // Ordinal suffix
    let suffix = 'th';
    if (day % 10 === 1 && day !== 11) suffix = 'st';
    else if (day % 10 === 2 && day !== 12) suffix = 'nd';
    else if (day % 10 === 3 && day !== 13) suffix = 'rd';

    return day + suffix + ' ' + month + ' ' + year;
  }

  /**
   * Parse CSV string into raw time/value objects with GPS columns.
   * Interpolates GPS coordinates to reconstruct a continuous 10 Hz path.
   */
  parseCSV(csvText) {
    this.raw = [];
    this.isResistance = false;

    // Split into lines
    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error("CSV file is empty or has too few lines.");
    }

    // Restore recordingStartTime from metadata comment line if present
    this.recordingStartTime = 0;
    let dataStartLine = 0;
    if (lines[0].startsWith('# RecordingStartTime:')) {
      const metaVal = parseFloat(lines[0].split(':')[1]);
      if (!isNaN(metaVal)) {
        this.recordingStartTime = metaVal;
      }
      dataStartLine = 1;
    }

    // Read headers
    const headerLine = lines[dataStartLine];
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

    // Guess column indices
    let timeColIndex = -1;
    let gsrColIndex = -1;
    let latColIndex = -1;
    let lonColIndex = -1;
    let altColIndex = -1;
    let satsColIndex = -1;
    let fixColIndex = -1;

    // Time column keyword search
    const timeKeywords = GSR_CONST.TIME_KEYWORDS;
    for (let i = 0; i < headers.length; i++) {
      if (timeKeywords.some(kw => headers[i].includes(kw))) {
        timeColIndex = i;
        break;
      }
    }

    // GSR column keyword search
    const gsrKeywords = GSR_CONST.GSR_KEYWORDS;
    for (let i = 0; i < headers.length; i++) {
      if (i === timeColIndex) continue;
      if (gsrKeywords.some(kw => headers[i].includes(kw))) {
        gsrColIndex = i;
        break;
      }
    }

    // GPS column keyword search
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (h.includes('lat')) latColIndex = i;
      else if (h.includes('lon') || h.includes('lng')) lonColIndex = i;
      else if (h.includes('alt')) altColIndex = i;
      else if (h.includes('sat')) satsColIndex = i;
      else if (h.includes('fix')) fixColIndex = i;
    }

    // Processed-CSV column detection (re-imported data)
    let peakLabelColIndex = -1;
    let isPeakColIndex = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (h.includes('peaklabel') || h.includes('peak_label')) peakLabelColIndex = i;
      if (h.includes('ispeak') || h.includes('is_peak')) isPeakColIndex = i;
    }

    // Fallbacks for main biometric columns
    if (timeColIndex === -1) timeColIndex = 0;
    if (gsrColIndex === -1) gsrColIndex = headers.length > 1 ? 1 : 0;

    // Parse data rows
    let rawDataList = [];
    for (let i = dataStartLine + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split(',');
      if (cols.length <= Math.max(timeColIndex, gsrColIndex)) continue;

      let rawTimeStr = cols[timeColIndex].trim();
      let timeVal = NaN;

      // Parse timestamp
      if (rawTimeStr.includes('-') || rawTimeStr.includes(':') || rawTimeStr.includes('T')) {
        let parsedDate = Date.parse(rawTimeStr);
        if (!isNaN(parsedDate)) {
          timeVal = parsedDate / 1000.0;
        }
      }
      if (isNaN(timeVal)) {
        timeVal = parseFloat(rawTimeStr);
      }

      let gsrVal = parseFloat(cols[gsrColIndex]);
      if (isNaN(timeVal) || isNaN(gsrVal)) continue;

      // Parse GPS fields (empty fields parse to NaN)
      let latVal = latColIndex !== -1 && cols[latColIndex] ? parseFloat(cols[latColIndex]) : NaN;
      let lonVal = lonColIndex !== -1 && cols[lonColIndex] ? parseFloat(cols[lonColIndex]) : NaN;
      let altVal = altColIndex !== -1 && cols[altColIndex] ? parseFloat(cols[altColIndex]) : NaN;
      let satsVal = satsColIndex !== -1 && cols[satsColIndex] ? parseInt(cols[satsColIndex]) : 0;
      let fixVal = fixColIndex !== -1 && cols[fixColIndex] ? parseInt(cols[fixColIndex]) : 0;

      // Read peak label from processed-CSV re-import
      let importedPeakLabel = '';
      if (peakLabelColIndex !== -1 && isPeakColIndex !== -1 &&
          cols[isPeakColIndex] && parseInt(cols[isPeakColIndex]) === 1) {
        importedPeakLabel = (cols[peakLabelColIndex] || '').replace(/^"|"$/g, '').trim();
      }

      rawDataList.push({
        time: timeVal,
        val: gsrVal,
        lat: latVal,
        lon: lonVal,
        alt: altVal,
        sats: satsVal,
        fix: fixVal,
        hasGps: false,
        _importLabel: importedPeakLabel
      });
    }

    if (rawDataList.length === 0) {
      throw new Error("No valid numeric data found in CSV.");
    }

    // Sort chronologically
    rawDataList.sort((a, b) => a.time - b.time);

    // Reconstruct sub-second timestamps if multiple rows share identical seconds
    let hasDuplicates = false;
    for (let i = 1; i < rawDataList.length; i++) {
      if (rawDataList[i].time === rawDataList[i - 1].time) {
        hasDuplicates = true;
        break;
      }
    }

    if (hasDuplicates) {
      const firstTime = rawDataList[0].time;
      const lastTime = rawDataList[rawDataList.length - 1].time;
      const totalTimeDiff = lastTime - firstTime;
      if (totalTimeDiff > 0) {
        const step = totalTimeDiff / (rawDataList.length - 1);
        for (let i = 0; i < rawDataList.length; i++) {
          rawDataList[i].time = firstTime + i * step;
        }
      } else {
        for (let i = 0; i < rawDataList.length; i++) {
          rawDataList[i].time = i * 0.1;
        }
      }
    }

    // Store the recording start clock time (Unix epoch seconds).
    // If already restored from a metadata line (re-import), don't overwrite it.
    if (this.recordingStartTime === 0) {
      this.recordingStartTime = rawDataList.length > 0 ? rawDataList[0].time : 0;
    }

    // Offset timestamps relative to session start (0.0s)
    if (rawDataList.length > 0) {
      const startTime = rawDataList[0].time;
      rawDataList.forEach(d => {
        d.time = d.time - startTime;
      });
    }

    // Build imported peak label lookup (time→label, after offset)
    this._importedPeakLabels = new Map();
    for (const d of rawDataList) {
      if (d._importLabel) this._importedPeakLabels.set(d.time, d._importLabel);
      delete d._importLabel; // clean up temp field
    }

    // Auto-detect sample rate
    let timeDiffs = [];
    for (let i = 1; i < Math.min(100, rawDataList.length); i++) {
      let diff = rawDataList[i].time - rawDataList[i - 1].time;
      if (diff > 0) timeDiffs.push(diff);
    }
    if (timeDiffs.length > 0) {
      const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
      this.sampleRate = 1.0 / avgDiff;
    } else {
      this.sampleRate = 10.0;
    }

    // Auto-detect Units and convert to MicroSiemens (uS)
    const avgVal = rawDataList.reduce((sum, d) => sum + d.val, 0) / rawDataList.length;
    const gsrHeader = headers[gsrColIndex] || "";
    const isResistanceHeader = gsrHeader.includes('resistance') || gsrHeader.includes('ohms');
    
    if (isResistanceHeader || avgVal > GSR_CONST.RESISTANCE_MIN_AVG) {
      this.isResistance = true;
      rawDataList.forEach(d => {
        d.val = d.val > 0 ? (1000000.0 / d.val) : 0;
      });
    } else if (avgVal > GSR_CONST.MICROSIEMENS_MIN_AVG && avgVal <= GSR_CONST.MICROSIEMENS_MAX_AVG) {
      rawDataList.forEach(d => {
        d.val = d.val / 1000.0;
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Linear Interpolation for Sparse 10 Hz GPS Coordinates
    // ─────────────────────────────────────────────────────────────────────────
    let gpsIndices = [];
    for (let i = 0; i < rawDataList.length; i++) {
      const d = rawDataList[i];
      if (!isNaN(d.lat) && !isNaN(d.lon) && (Math.abs(d.lat) > 0.0001 || Math.abs(d.lon) > 0.0001)) {
        d.hasGps = true;
        gpsIndices.push(i);
      } else {
        d.hasGps = false;
        d.lat = NaN;
        d.lon = NaN;
      }
    }

    if (gpsIndices.length > 0) {
      // 1. Fill values before first GPS coordinate
      const firstGpsIdx = gpsIndices[0];
      const firstGps = rawDataList[firstGpsIdx];
      for (let i = 0; i < firstGpsIdx; i++) {
        rawDataList[i].lat = firstGps.lat;
        rawDataList[i].lon = firstGps.lon;
        rawDataList[i].alt = firstGps.alt;
        rawDataList[i].sats = firstGps.sats;
        rawDataList[i].fix = firstGps.fix;
        rawDataList[i].hasGps = true;
      }

      // 2. Linearly interpolate coordinates in gap intervals
      for (let k = 0; k < gpsIndices.length - 1; k++) {
        const idxA = gpsIndices[k];
        const idxB = gpsIndices[k + 1];
        const dA = rawDataList[idxA];
        const dB = rawDataList[idxB];
        const tA = dA.time;
        const tB = dB.time;

        for (let i = idxA + 1; i < idxB; i++) {
          const d = rawDataList[i];
          const tI = d.time;
          const ratio = (tI - tA) / (tB - tA);
          d.lat = dA.lat + ratio * (dB.lat - dA.lat);
          d.lon = dA.lon + ratio * (dB.lon - dA.lon);
          d.alt = dA.alt + ratio * (dB.alt - dA.alt);
          d.sats = dB.sats;
          d.fix = dB.fix;
          d.hasGps = true;
        }
      }

      // 3. Fill values after last GPS coordinate
      const lastGpsIdx = gpsIndices[gpsIndices.length - 1];
      const lastGps = rawDataList[lastGpsIdx];
      for (let i = lastGpsIdx + 1; i < rawDataList.length; i++) {
        rawDataList[i].lat = lastGps.lat;
        rawDataList[i].lon = lastGps.lon;
        rawDataList[i].alt = lastGps.alt;
        rawDataList[i].sats = lastGps.sats;
        rawDataList[i].fix = lastGps.fix;
        rawDataList[i].hasGps = true;
      }
    }

    this.raw = rawDataList;
    return this.raw;
  }

  /**
   * Run the analysis pipeline with current parameter adjustments.
   */
  analyze(params) {
    if (this.raw.length === 0) return;

    const n = this.raw.length;

    // 1. Noise Median Filtering
    const medWindowSize = Math.max(1, Math.round(params.medianSize * this.sampleRate));
    let afterMedian = GsrFilter.applyMedianFilter(this.raw.map(d => d.val), medWindowSize);

    // 2. Low-Pass Filter
    const lpfWinSize = Math.max(1, Math.round(params.lpfWindow * this.sampleRate));
    let afterLPF = GsrFilter.applyZeroPhaseMovingAverage(afterMedian, lpfWinSize);

    this.filtered = this.raw.map((d, i) => ({ time: d.time, val: afterLPF[i] }));

    // 3. Tonic/Phasic Decomposition
    let tonicVals = [];
    let phasicVals = [];

    if (params.tonicMethod === 'dwt') {
      // ── DWT Wavelet Decomposition (db3) ────────────────────────────────
      // Uses the afterLPF signal (median + low-pass filtered) as input.
      // Tonic: approximation at level N (SCL), 0–Fs/2^(N+1) Hz
      // Phasic: signal − tonic (subtraction avoids wavelet ringing)
      const dwtLevel = params.dwtLevel || 6;
      const result = DWT.analyzeGSR(afterLPF, dwtLevel);
      // Gentle post-smoothing (5 s window) removes DWT reconstruction
      // ripples without introducing phase lag.  Empirically, 5 s gives the
      // best tonic RMSE and phasic/truth correlation across levels 4–7.
      const smoothWin = Math.max(1, Math.round(5 * this.sampleRate));
      tonicVals = GsrFilter.applyZeroPhaseMovingAverage(result.tonic, smoothWin);
      // Re-derive phasic from smoothed tonic for consistency
      phasicVals = afterLPF.map((v, i) => v - tonicVals[i]);

      // DWT separates by frequency → tonic runs through the MIDDLE of the
      // signal.  Physiologically, SCRs are always positive-going, so the
      // tonic should track the LOWER envelope.  We reposition the tonic
      // using a local-floor approach: for each sample, find the minimum
      // of (signal − tonic) in a ±6 s window — this is how far the tonic
      // needs to drop at that point to sit at the local floor.  Light
      // 4 s smoothing on the offsets (reduced from 8 s) keeps the tonic
      // responsive to rapid SCR onsets without introducing jitter.
      const floorHalf = Math.max(1, Math.round(6 * this.sampleRate)); // ±6 s
      const localOffsets = new Array(n);
      for (let i = 0; i < n; i++) {
        const s = Math.max(0, i - floorHalf);
        const e = Math.min(n - 1, i + floorHalf);
        let mn = Infinity;
        for (let j = s; j <= e; j++) {
          if (phasicVals[j] < mn) mn = phasicVals[j];
        }
        localOffsets[i] = mn;
      }
      // Light smoothing on offset curve (4 s window — tighter than before)
      const smoothOffsets = GsrFilter.applyZeroPhaseMovingAverage(
        localOffsets, Math.round(4 * this.sampleRate)
      );
      for (let i = 0; i < n; i++) {
        tonicVals[i] += smoothOffsets[i];  // offset is negative → moves tonic down
      }
      // Recompute phasic from repositioned tonic, clamp to ≥0
      phasicVals = afterLPF.map((v, i) => Math.max(0, v - tonicVals[i]));
    } else {
      // ── Classical sliding-window methods ────────────────────────────────
      const tonicWinSize = Math.max(5, Math.round(params.tonicWindow * this.sampleRate));

      if (params.tonicMethod === 'median') {
        tonicVals = GsrFilter.applyMedianFilter(afterLPF, tonicWinSize);
      } else if (params.tonicMethod === 'percentile') {
        tonicVals = GsrFilter.applyPercentileFilter(afterLPF, tonicWinSize, 0.10);
      } else {
        const alpha = 2.0 / (tonicWinSize + 1);
        tonicVals = GsrFilter.applyZeroPhaseEMA(afterLPF, alpha);
      }

      // 4. Phasic = Filtered - Tonic (subtraction method)
      phasicVals = afterLPF.map((v, i) => v - tonicVals[i]);
    }

    this.tonic = this.raw.map((d, i) => ({ time: d.time, val: tonicVals[i] }));
    this.phasic = this.raw.map((d, i) => ({ time: d.time, val: phasicVals[i] }));

    // 5. Phasic Peak Detection (with shape criteria from sliders)
    this.detectPeaks(params.peakThreshold, params);

    // 6. Build display cache for fast rendering (Y-range pyramid, timeline)
    this._buildDisplayCache();
  }

  /**
   * Pre-compute global Y-ranges and timeline glyph data so draw() doesn't
   * have to scan the full dataset every redraw.
   */
  _buildDisplayCache() {
    // Global Y-range per curve — used when view covers >40 % of data
    this._globalRange = {};
    for (const key of ['raw', 'filtered', 'tonic', 'phasic']) {
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

    // Reset per-redraw cache (recomputed once by draw())
    this.rawMinMaxCached = null;

    // Timeline waveform: sub-sample to ~300 points
    this._timelinePoints = [];
    if (this.raw.length > 0) {
      const step = Math.max(1, Math.floor(this.raw.length / 300));
      for (let i = 0; i < this.raw.length; i += step) {
        this._timelinePoints.push(this.raw[i]);
      }
    }

    // Timeline peak positions as fraction of total duration
    this._timelinePeakPct = [];
    if (this.peaks.length > 0 && this.raw.length > 0) {
      const totalDur = this.raw[this.raw.length - 1].time - this.raw[0].time;
      if (totalDur > 0) {
        this._timelinePeakPct = this.peaks.map(pk => pk.time / totalDur);
      }
    }
  }

  /**
   * Compute the local noise floor around an index for SNR estimation.
   * Uses ±1 s window, excludes the peak region.
   */
  _computeNoiseFloor(idx, halfWindow) {
    // Use the filtered signal (median+LPF, pre-decomposition) instead of
    // phasic, so that nearby SCRs don't inflate the noise estimate.
    const vals = this.filtered.map(d => d.val);
    const start = Math.max(0, idx - halfWindow);
    const end = Math.min(vals.length - 1, idx + halfWindow);
    let sum = 0, count = 0;
    for (let j = start; j <= end; j++) {
      sum += vals[j];
      count++;
    }
    const mean = sum / count;
    let sqSum = 0;
    for (let j = start; j <= end; j++) {
      sqSum += (vals[j] - mean) ** 2;
    }
    return Math.sqrt(sqSum / count);
  }

  /**
   * Compute a quality score (0–1) for a detected peak based on
   * how well it matches the canonical SCR shape.
   */
  _computePeakQuality(peak) {
    const W = GSR_CONST.PEAK_SHAPE.QUALITY_WEIGHTS;
    let score = 0;

    // Amplitude: higher is better, saturate at 0.5 µS
    const ampScore = Math.min(1, peak.amplitude / 0.5);
    score += ampScore * W.amplitude;

    // Rise time: ideal is 0.5–3 s, penalize outside that
    if (peak.riseTime >= 0.5 && peak.riseTime <= 3.0) {
      score += W.riseTime;
    } else if (peak.riseTime > 0 && peak.riseTime <= 5.0) {
      score += W.riseTime * 0.5;
    }

    // Recovery time: ideal is 0.5–4 s
    if (peak.halfRecoveryTime >= 0.5 && peak.halfRecoveryTime <= 4.0) {
      score += W.recoveryTime;
    } else if (peak.halfRecoveryTime > 0 && peak.halfRecoveryTime <= 8.0) {
      score += W.recoveryTime * 0.5;
    }

    // Skewness: classic SCR has fast rise, slow recovery (ratio < 1)
    if (peak.skewnessRatio > 0 && peak.skewnessRatio <= 1.0) {
      score += W.skewness;
    } else if (peak.skewnessRatio > 1.0 && peak.skewnessRatio <= 2.0) {
      score += W.skewness * 0.6;
    } else if (peak.skewnessRatio > 2.0 && peak.skewnessRatio <= 4.0) {
      score += W.skewness * 0.3;
    }

    // Onset slope: steep but not too steep (in µS/s)
    if (peak.onsetSlope >= 0.01 && peak.onsetSlope <= 1.0) {
      score += W.onsetSlope;
    } else if (peak.onsetSlope > 0 && peak.onsetSlope <= 3.0) {
      score += W.onsetSlope * 0.5;
    }

    // SNR
    if (peak.snr >= 3.0) {
      score += W.snr;
    } else if (peak.snr >= 2.0) {
      score += W.snr * 0.7;
    } else if (peak.snr >= 1.5) {
      score += W.snr * 0.4;
    }

    // Decay slope: recovery must exist (in µS/s)
    if (peak.decaySlope > 0.001) {
      score += W.decaySlope;
    }

    return Math.min(1, Math.max(0, score));
  }

  detectPeaks(threshold, params) {
    // Preserve any user-set labels across re-analysis by matching on raw index
    const oldLabels = new Map();
    for (const pk of this.peaks) {
      if (pk.label && pk.label.trim()) oldLabels.set(pk.index, pk.label);
    }
    // Also merge labels imported from re-loaded processed CSV (matched by time)
    if (this._importedPeakLabels && this._importedPeakLabels.size > 0) {
      for (const pk of this.peaks) {
        if (!pk.label || !pk.label.trim()) {
          const imported = this._importedPeakLabels.get(pk.time);
          if (imported) oldLabels.set(pk.index, imported);
        }
      }
    }
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

      // ── 2. Find onset (trough before peak) ──────────────────────────────
      // Limit backward search to MAX_RISE_TIME seconds to prevent walking
      // backward through overlapping SCRs into an unrelated trough.
      const maxOnsetSteps = Math.round(shape.MAX_RISE_TIME * this.sampleRate);
      let onsetIdx = i;
      let onsetSteps = 0;
      while (onsetIdx > 0 && phasicVals[onsetIdx] > 0 && onsetSteps < maxOnsetSteps) {
        if (onsetIdx < i && phasicVals[onsetIdx] < phasicVals[onsetIdx - 1]) {
          break;
        }
        onsetIdx--;
        onsetSteps++;
      }

      const amplitude = curr - phasicVals[onsetIdx];
      // Under literature standards, threshold is strictly applied to response amplitude
      if (amplitude < threshold) continue;

      // ── 3. Rise time (onset → peak duration) ────────────────────────────
      const riseTime = times[i] - times[onsetIdx];

      // Rise time bounds (skip check when slider is 0 / off)
      if (shape.MIN_RISE_TIME > 0 && riseTime < shape.MIN_RISE_TIME) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (shape.MAX_RISE_TIME > 0 && riseTime > shape.MAX_RISE_TIME) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 4. Onset slope (average derivative on rising edge in µS/second) ──
      const onsetSlope = riseTime > 0 ? amplitude / riseTime : 0;

      if (onsetSlope < shape.MIN_ONSET_SLOPE || onsetSlope > shape.MAX_ONSET_SLOPE) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 5. Half-recovery search ─────────────────────────────────────────
      const halfDecayVal = phasicVals[onsetIdx] + amplitude * 0.5;
      let recoveryIdx = -1;
      for (let j = i + 1; j < n; j++) {
        if (phasicVals[j] <= halfDecayVal) {
          recoveryIdx = j;
          break;
        }
        if (j < n - 1 &&
            phasicVals[j] < phasicVals[j + 1] &&
            phasicVals[j] > halfDecayVal + GSR_CONST.PEAK_RECOVERY_BREAK) {
          break;
        }
      }

      let halfRecoveryTime = -1;
      if (recoveryIdx !== -1) {
        halfRecoveryTime = times[recoveryIdx] - times[i];
      }

      // Recovery time bounds (skip individual check when slider is 0 / off)
      if (halfRecoveryTime < 0) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (shape.MIN_HALF_RECOVERY > 0 && halfRecoveryTime < shape.MIN_HALF_RECOVERY) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (shape.MAX_HALF_RECOVERY > 0 && halfRecoveryTime > shape.MAX_HALF_RECOVERY) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 6. Decay / recovery slope (average derivative in µS/second) ─────
      const decaySlope = halfRecoveryTime > 0
        ? (phasicVals[i] - phasicVals[recoveryIdx]) / halfRecoveryTime
        : 0;

      if (decaySlope < shape.MIN_DECAY_SLOPE) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 7. Skewness ratio (rise time / recovery time) ──────────────────
      // Genuine SCRs have fast rise, slow recovery → ratio < 1
      const skewnessRatio = halfRecoveryTime > 0
        ? riseTime / halfRecoveryTime
        : 0;

      if (skewnessRatio < shape.SKEWNESS_RATIO_MIN) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (shape.SKEWNESS_RATIO_MAX > 0 && skewnessRatio > shape.SKEWNESS_RATIO_MAX) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 8. Full width at half maximum (FWHM) ───────────────────────────
      // Find start of half-max on rising edge
      let fwhmStart = onsetIdx;
      for (let j = onsetIdx; j <= i; j++) {
        if (phasicVals[j] >= halfDecayVal) {
          fwhmStart = j;
          break;
        }
      }
      const fwhm = recoveryIdx !== -1
        ? times[recoveryIdx] - times[fwhmStart]
        : -1;

      if (fwhm > 0 && fwhm > shape.MAX_PEAK_WIDTH) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 9. Signal-to-noise ratio ───────────────────────────────────────
      const noiseHalfWin = Math.max(1, Math.round(this.sampleRate)); // ±1 s
      const noiseFloor = this._computeNoiseFloor(onsetIdx, noiseHalfWin);
      const snr = noiseFloor > 0 ? amplitude / noiseFloor : 0;

      if (shape.MIN_SNR > 0 && snr < shape.MIN_SNR) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 10. Build peak object with full shape metrics ──────────────────
      const peak = {
        index: i,
        time: times[i],
        value: curr,
        amplitude: amplitude,
        onsetIndex: onsetIdx,
        onsetTime: times[onsetIdx],
        onsetValue: phasicVals[onsetIdx],
        recoveryIndex: recoveryIdx,
        halfRecoveryTime: halfRecoveryTime,
        // New shape metrics
        riseTime: riseTime,
        onsetSlope: onsetSlope,
        decaySlope: decaySlope,
        skewnessRatio: skewnessRatio,
        fwhm: fwhm,
        snr: snr,
        label: oldLabels.get(i) ||
               (this._importedPeakLabels ? this._importedPeakLabels.get(times[i]) : '') ||
               ''
      };

      // ── 11. Compute composite quality score ────────────────────────────
      peak.qualityScore = this._computePeakQuality(peak);

      this.peaks.push(peak);

      // Skip ahead to enforce minimum gap between peaks
      i = Math.min(n - 2, i + Math.round(GSR_CONST.PEAK_MIN_GAP * this.sampleRate));
    }
  }

  getStats() {
    if (this.raw.length === 0) {
      return {
        duration: 0,
        meanSCL: 0,
        peakCount: 0,
        peakFrequency: 0,
        meanPeakAmplitude: 0
      };
    }

    const duration = this.raw[this.raw.length - 1].time - this.raw[0].time;
    const sumTonic = this.tonic.reduce((sum, d) => sum + d.val, 0);
    const meanSCL = sumTonic / this.tonic.length;

    const durationMinutes = duration / 60.0;
    const peakCount = this.peaks.length;
    const peakFrequency = durationMinutes > 0 ? (peakCount / durationMinutes) : 0;

    const sumAmp = this.peaks.reduce((sum, p) => sum + p.amplitude, 0);
    const meanPeakAmplitude = peakCount > 0 ? (sumAmp / peakCount) : 0;

    return {
      duration: duration,
      meanSCL: meanSCL,
      peakCount: peakCount,
      peakFrequency: peakFrequency,
      meanPeakAmplitude: meanPeakAmplitude
    };
  }

  exportToCSV() {
    if (this.raw.length === 0) return "";

    // Guard: if analysis hasn't been run, filtered/tonic/phasic are empty
    if (this.filtered.length === 0 || this.tonic.length === 0 || this.phasic.length === 0) {
      return "";
    }

    const hasFilteredGps = this.filteredGps && this.filteredGps.length === this.raw.length;

    // Preserve recording start time for clock-time display on re-import
    let csv = `# RecordingStartTime:${this.recordingStartTime}\n`;
    csv += "Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude,PeakLabel,Latitude,Longitude";
    if (hasFilteredGps) {
      csv += ",Raw Latitude,Raw Longitude";
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
      
      const peak = peakByIndex.get(i);
      if (peak) {
        isPeak = 1;
        peakAmp = peak.amplitude.toFixed(4);
        peakLabel = peak.label || "";
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
             `"${peakLabel}",` +
             `${latStr},` +
             `${lonStr}`;

      if (hasFilteredGps) {
        csv += `,${rawLatStr},${rawLonStr}`;
      }
      csv += "\n";
    }
    return csv;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRAnalyzer };
} else {
  window.GSRAnalyzer = GSRAnalyzer;
}


