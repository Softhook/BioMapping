/**
 * GSR / EDA Signal Processing Library
 */

class GSRAnalyzer {
  constructor() {
    this.raw = [];          // Raw values: { time, val }
    this.filtered = [];     // Noise-filtered values: { time, val }
    this.tonic = [];        // Tonic component (SCL): { time, val }
    this.phasic = [];       // Phasic component (SCR): { time, val }
    this.peaks = [];        // Detected peaks: { time, index, amplitude, onsetIndex, onsetTime, halfRecoveryTime }
    
    this.sampleRate = 10;   // In Hz (samples per second), auto-detected or manual
    this.isResistance = false; // Whether original CSV was resistance (Ohms) and converted
  }

  /**
   * Parse CSV string into raw time/value objects.
   * Auto-detects columns, parses ISO/datetime timestamps, reconstructs sub-second timestamps
   * for loggers with duplicate second resolution, and offsets time relative to 0.0s.
   */
  parseCSV(csvText) {
    this.raw = [];
    this.isResistance = false;

    // Split into lines
    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error("CSV file is empty or has too few lines.");
    }

    // Read headers
    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

    // Guess column indices
    let timeColIndex = -1;
    let gsrColIndex = -1;

    // Look for common time headers
    const timeKeywords = ['time', 'sec', 't', 'timestamp', 'millis', 'ms'];
    for (let i = 0; i < headers.length; i++) {
      if (timeKeywords.some(kw => headers[i].includes(kw))) {
        timeColIndex = i;
        break;
      }
    }

    // Look for common GSR/EDA headers
    const gsrKeywords = ['gsr', 'eda', 'conductance', 'resistance', 'res', 'us', 'raw', 'micro', 'ohms', 'val'];
    for (let i = 0; i < headers.length; i++) {
      if (i === timeColIndex) continue;
      if (gsrKeywords.some(kw => headers[i].includes(kw))) {
        gsrColIndex = i;
        break;
      }
    }

    // Fallbacks if headers not detected
    if (timeColIndex === -1) timeColIndex = 0;
    if (gsrColIndex === -1) gsrColIndex = headers.length > 1 ? 1 : 0;

    // Parse data rows
    let rawDataList = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = line.split(',');
      if (cols.length <= Math.max(timeColIndex, gsrColIndex)) continue;

      let rawTimeStr = cols[timeColIndex].trim();
      let timeVal = NaN;

      // Try parsing as ISO Date or datetime string
      if (rawTimeStr.includes('-') || rawTimeStr.includes(':') || rawTimeStr.includes('T')) {
        let parsedDate = Date.parse(rawTimeStr);
        if (!isNaN(parsedDate)) {
          timeVal = parsedDate / 1000.0; // convert epoch ms to seconds
        }
      }

      // Fallback to parseFloat
      if (isNaN(timeVal)) {
        timeVal = parseFloat(rawTimeStr);
      }

      let gsrVal = parseFloat(cols[gsrColIndex]);

      if (isNaN(timeVal) || isNaN(gsrVal)) continue;

      rawDataList.push({ time: timeVal, val: gsrVal });
    }

    if (rawDataList.length === 0) {
      throw new Error("No valid numeric data found in CSV.");
    }

    // Sort by time in case it is out of order
    rawDataList.sort((a, b) => a.time - b.time);

    // Check for duplicate timestamps (e.g. loggers with second-level resolution)
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
        // Space samples evenly across the total recorded time span
        const step = totalTimeDiff / (rawDataList.length - 1);
        for (let i = 0; i < rawDataList.length; i++) {
          rawDataList[i].time = firstTime + i * step;
        }
      } else {
        // If all timestamps are identical (e.g. 3 rows total), assume 10Hz spacing
        for (let i = 0; i < rawDataList.length; i++) {
          rawDataList[i].time = i * 0.1;
        }
      }
    }

    // Offset timestamps relative to session start (0.0s)
    if (rawDataList.length > 0 && rawDataList[0]) {
      const startTime = rawDataList[0].time;
      rawDataList.forEach(d => {
        if (d) d.time = d.time - startTime;
      });
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
      this.sampleRate = 10.0; // fallback default
    }

    // Auto-detect Resistance vs Conductance
    const avgVal = rawDataList.reduce((sum, d) => sum + d.val, 0) / rawDataList.length;
    if (avgVal > 500) {
      this.isResistance = true;
      // Convert Resistance to Conductance: C (uS) = 1,000,000 / R (Ohms)
      const scale = avgVal > 10000 ? 1000000.0 : 1000.0;
      rawDataList.forEach(d => {
        d.val = d.val > 0 ? (scale / d.val) : 0;
      });
    }

    this.raw = rawDataList;
    return this.raw;
  }

  /**
   * Run the analysis pipeline with current parameter adjustments.
   * @param {Object} params
   *   - medianSize: size of the noise median filter window (seconds)
   *   - lpfWindow: size of moving average filter window (seconds)
   *   - tonicMethod: 'median' or 'lpf'
   *   - tonicWindow: size of tonic baseline window (seconds)
   *   - peakThreshold: minimum phasic height to register as a peak (uS)
   */
  analyze(params) {
    if (this.raw.length === 0) return;

    const n = this.raw.length;
    const dt = 1.0 / this.sampleRate;

    // 1. Noise Median Filtering (reduces motion artifacts/sharp spikes)
    const medWindowSize = Math.max(1, Math.round(params.medianSize * this.sampleRate));
    let afterMedian = this.applyMedianFilter(this.raw.map(d => d.val), medWindowSize);

    // 2. Low-Pass Filter (removes high frequency fuzz)
    // We use a zero-phase bidirectional moving average or bidirectional EMA
    const lpfWinSize = Math.max(1, Math.round(params.lpfWindow * this.sampleRate));
    let afterLPF = this.applyZeroPhaseMovingAverage(afterMedian, lpfWinSize);

    this.filtered = this.raw.map((d, i) => ({ time: d.time, val: afterLPF[i] }));

    // 3. Tonic Baseline Extraction
    let tonicVals = [];
    const tonicWinSize = Math.max(5, Math.round(params.tonicWindow * this.sampleRate));

    if (params.tonicMethod === 'median') {
      // Robust large-window median filter
      tonicVals = this.applyMedianFilter(afterLPF, tonicWinSize);
    } else {
      // Extremely low-pass filter (forward-backward EMA with very small alpha)
      // tonicWindow determines cutoff. Alpha corresponds to window size.
      const alpha = 2.0 / (tonicWinSize + 1);
      tonicVals = this.applyZeroPhaseEMA(afterLPF, alpha);
    }

    this.tonic = this.raw.map((d, i) => ({ time: d.time, val: tonicVals[i] }));

    // 4. Phasic Component Extraction
    // Phasic = Filtered - Tonic
    this.phasic = this.raw.map((d, i) => ({
      time: d.time,
      val: Math.max(0, afterLPF[i] - tonicVals[i]) // conductance changes are positive
    }));

    // 5. Phasic Peak Detection
    this.detectPeaks(params.peakThreshold);
  }

  /**
   * Apply a standard rolling median filter.
   */
  applyMedianFilter(arr, windowSize) {
    const n = arr.length;
    const result = new Array(n);
    const half = Math.floor(windowSize / 2);

    for (let i = 0; i < n; i++) {
      let start = Math.max(0, i - half);
      let end = Math.min(n - 1, i + half);
      let window = [];
      for (let j = start; j <= end; j++) {
        window.push(arr[j]);
      }
      window.sort((a, b) => a - b);
      result[i] = window[Math.floor(window.length / 2)];
    }
    return result;
  }

  /**
   * Apply a zero-phase (forward-backward) Moving Average filter.
   * Completely eliminates phase delay.
   */
  applyZeroPhaseMovingAverage(arr, windowSize) {
    if (windowSize <= 1) return [...arr];
    const n = arr.length;
    
    // Helper for single pass moving average
    const singlePass = (data) => {
      const res = new Array(n);
      let sum = 0;
      const w = Math.min(windowSize, n);
      
      // Initialize window
      for (let i = 0; i < w; i++) {
        sum += data[i];
      }
      res[0] = sum / w;
      
      for (let i = 1; i < n; i++) {
        // Slide window
        const outgoingIdx = i - Math.floor(w / 2) - 1;
        const incomingIdx = i + Math.ceil(w / 2) - 1;
        
        if (outgoingIdx >= 0) {
          sum -= data[outgoingIdx];
        } else {
          sum -= data[0]; // edge padding
        }
        
        if (incomingIdx < n) {
          sum += data[incomingIdx];
        } else {
          sum += data[n - 1]; // edge padding
        }
        
        res[i] = sum / w;
      }
      return res;
    };

    // Forward pass
    const forward = singlePass(arr);
    // Backward pass
    const backward = singlePass(forward.reverse());
    return backward.reverse();
  }

  /**
   * Apply a zero-phase (forward-backward) Exponential Moving Average (EMA) filter.
   */
  applyZeroPhaseEMA(arr, alpha) {
    const n = arr.length;
    if (n === 0) return [];
    
    // Forward
    const forward = new Array(n);
    forward[0] = arr[0];
    for (let i = 1; i < n; i++) {
      forward[i] = alpha * arr[i] + (1 - alpha) * forward[i - 1];
    }
    
    // Backward
    const backward = new Array(n);
    backward[n - 1] = forward[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      backward[i] = alpha * forward[i] + (1 - alpha) * backward[i + 1];
    }
    
    return backward;
  }

  /**
   * Find peaks in Phasic signal.
   * A peak is a local maximum above threshold.
   * Its onset is the preceding local minimum.
   */
  detectPeaks(threshold) {
    this.peaks = [];
    const n = this.phasic.length;
    if (n < 3) return;

    const phasicVals = this.phasic.map(d => d.val);
    const times = this.phasic.map(d => d.time);

    for (let i = 1; i < n - 1; i++) {
      const prev = phasicVals[i - 1];
      const curr = phasicVals[i];
      const next = phasicVals[i + 1];

      // Local maximum check
      if (curr > prev && curr >= next) {
        if (curr >= threshold) {
          // Find peak onset: backtrack to find the local minimum
          let onsetIdx = i;
          while (onsetIdx > 0 && phasicVals[onsetIdx] > 0) {
            // Stop if we hit a point where the signal rises again
            if (onsetIdx < i - 1 && phasicVals[onsetIdx] < phasicVals[onsetIdx - 1]) {
              break;
            }
            onsetIdx--;
          }

          const amplitude = curr - phasicVals[onsetIdx];
          
          // Only register if the actual rise exceeds threshold (helps filtering tiny bumps on high slopes)
          if (amplitude >= threshold * 0.5) {
            // Find half-recovery time: look forward for the point where signal decays to 50% of the peak amplitude
            let halfDecayVal = phasicVals[onsetIdx] + amplitude * 0.5;
            let recoveryIdx = -1;
            for (let j = i + 1; j < n; j++) {
              // If it starts rising again substantially, or drops below the half recovery
              if (phasicVals[j] <= halfDecayVal) {
                recoveryIdx = j;
                break;
              }
              // If another peak starts, stop
              if (j < n - 1 && phasicVals[j] < phasicVals[j + 1] && phasicVals[j] > halfDecayVal + 0.1) {
                break;
              }
            }

            let recoveryTime = -1;
            if (recoveryIdx !== -1) {
              recoveryTime = times[recoveryIdx] - times[i];
            }

            this.peaks.push({
              index: i,
              time: times[i],
              value: curr,
              amplitude: amplitude,
              onsetIndex: onsetIdx,
              onsetTime: times[onsetIdx],
              onsetValue: phasicVals[onsetIdx],
              recoveryIndex: recoveryIdx,
              recoveryTime: recoveryTime
            });

            // Skip forward to avoid double counting peaks close together
            i = Math.min(n - 2, i + Math.round(1.0 * this.sampleRate));
          }
        }
      }
    }
  }

  /**
   * Compute aggregate statistics on current analysis
   */
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
    
    // Mean Skin Conductance Level (Mean of Tonic component)
    const sumTonic = this.tonic.reduce((sum, d) => sum + d.val, 0);
    const meanSCL = sumTonic / this.tonic.length;

    // Peak frequency (peaks per minute)
    const durationMinutes = duration / 60.0;
    const peakCount = this.peaks.length;
    const peakFrequency = durationMinutes > 0 ? (peakCount / durationMinutes) : 0;

    // Mean peak amplitude
    const sumAmp = this.peaks.reduce((sum, p) => sum + p.amplitude, 0);
    const meanPeakAmplitude = peakCount > 0 ? (sumAmp / peakCount) : 0;

    return {
      duration: duration, // in seconds
      meanSCL: meanSCL,   // in uS
      peakCount: peakCount,
      peakFrequency: peakFrequency, // peaks/min
      meanPeakAmplitude: meanPeakAmplitude // in uS
    };
  }

  /**
   * Convert analyzed data back to CSV string
   */
  exportToCSV() {
    if (this.raw.length === 0) return "";

    let csv = "Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude\n";
    for (let i = 0; i < this.raw.length; i++) {
      let isPeak = 0;
      let peakAmp = "";
      
      // Check if this index was a peak
      const peak = this.peaks.find(p => p.index === i);
      if (peak) {
        isPeak = 1;
        peakAmp = peak.amplitude.toFixed(4);
      }

      csv += `${this.raw[i].time.toFixed(3)},` +
             `${this.raw[i].val.toFixed(4)},` +
             `${this.filtered[i].val.toFixed(4)},` +
             `${this.tonic[i].val.toFixed(4)},` +
             `${this.phasic[i].val.toFixed(4)},` +
             `${isPeak},` +
             `${peakAmp}\n`;
    }
    return csv;
  }
}

// Export for usage in Node or browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GSRAnalyzer;
} else {
  window.GSRAnalyzer = GSRAnalyzer;
}
