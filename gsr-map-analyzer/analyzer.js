// GSR/EDA Signal Analysis Engine with GPS coordinate parsing and interpolation
// Handles variable-rate (10 Hz GSR, 1 Hz GPS) CSV files.

class GSRAnalyzer {
  constructor() {
    this.raw = [];          // Raw signal: { time, val, lat, lon, alt, sats, fix, hasGps }
    this.filtered = [];     // Cleaned signal: { time, val }
    this.tonic = [];        // Tonic component (SCL): { time, val }
    this.phasic = [];       // Phasic component (SCR): { time, val }
    this.peaks = [];        // Detected peaks: { time, index, amplitude, onsetIndex, onsetTime, halfRecoveryTime }
    
    this.sampleRate = 10;   // In Hz, auto-detected
    this.isResistance = false; // Whether original CSV was resistance (Ohms)
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

    // Read headers
    const headerLine = lines[0];
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
    const timeKeywords = ['time', 'sec', 't', 'timestamp', 'millis', 'ms'];
    for (let i = 0; i < headers.length; i++) {
      if (timeKeywords.some(kw => headers[i].includes(kw))) {
        timeColIndex = i;
        break;
      }
    }

    // GSR column keyword search
    const gsrKeywords = ['gsr', 'eda', 'conductance', 'resistance', 'res', 'us', 'raw', 'micro', 'ohms', 'val'];
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

    // Fallbacks for main biometric columns
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

      rawDataList.push({
        time: timeVal,
        val: gsrVal,
        lat: latVal,
        lon: lonVal,
        alt: altVal,
        sats: satsVal,
        fix: fixVal,
        hasGps: false
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

    // Offset timestamps relative to session start (0.0s)
    if (rawDataList.length > 0) {
      const startTime = rawDataList[0].time;
      rawDataList.forEach(d => {
        d.time = d.time - startTime;
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
      this.sampleRate = 10.0;
    }

    // Auto-detect Units and convert to MicroSiemens (uS)
    const avgVal = rawDataList.reduce((sum, d) => sum + d.val, 0) / rawDataList.length;
    const gsrHeader = headers[gsrColIndex] || "";
    const isResistanceHeader = gsrHeader.includes('resistance') || gsrHeader.includes('ohms');
    
    if (isResistanceHeader || avgVal > 50000) {
      this.isResistance = true;
      rawDataList.forEach(d => {
        d.val = d.val > 0 ? (1000000.0 / d.val) : 0;
      });
    } else if (avgVal > 100 && avgVal <= 50000) {
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
    const dt = 1.0 / this.sampleRate;

    // 1. Noise Median Filtering
    const medWindowSize = Math.max(1, Math.round(params.medianSize * this.sampleRate));
    let afterMedian = this.applyMedianFilter(this.raw.map(d => d.val), medWindowSize);

    // 2. Low-Pass Filter
    const lpfWinSize = Math.max(1, Math.round(params.lpfWindow * this.sampleRate));
    let afterLPF = this.applyZeroPhaseMovingAverage(afterMedian, lpfWinSize);

    this.filtered = this.raw.map((d, i) => ({ time: d.time, val: afterLPF[i] }));

    // 3. Tonic Baseline Extraction
    let tonicVals = [];
    const tonicWinSize = Math.max(5, Math.round(params.tonicWindow * this.sampleRate));

    if (params.tonicMethod === 'median') {
      tonicVals = this.applyMedianFilter(afterLPF, tonicWinSize);
    } else if (params.tonicMethod === 'percentile') {
      tonicVals = this.applyPercentileFilter(afterLPF, tonicWinSize, 0.10);
    } else {
      const alpha = 2.0 / (tonicWinSize + 1);
      tonicVals = this.applyZeroPhaseEMA(afterLPF, alpha);
    }

    this.tonic = this.raw.map((d, i) => ({ time: d.time, val: tonicVals[i] }));

    // 4. Phasic Component Extraction (Phasic = Filtered - Tonic)
    this.phasic = this.raw.map((d, i) => ({
      time: d.time,
      val: afterLPF[i] - tonicVals[i]
    }));

    // 5. Phasic Peak Detection
    this.detectPeaks(params.peakThreshold);
  }

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

  applyPercentileFilter(arr, windowSize, percentile) {
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
      const targetIdx = Math.floor(window.length * percentile);
      result[i] = window[targetIdx];
    }
    return result;
  }

  applyZeroPhaseMovingAverage(arr, windowSize) {
    if (windowSize <= 1) return [...arr];
    const n = arr.length;
    
    const singlePass = (data) => {
      const res = new Array(n);
      let sum = 0;
      const w = Math.min(windowSize, n);
      
      for (let i = 0; i < w; i++) {
        sum += data[i];
      }
      res[0] = sum / w;
      
      for (let i = 1; i < n; i++) {
        const outgoingIdx = i - Math.floor(w / 2) - 1;
        const incomingIdx = i + Math.ceil(w / 2) - 1;
        
        if (outgoingIdx >= 0) {
          sum -= data[outgoingIdx];
        } else {
          sum -= data[0];
        }
        
        if (incomingIdx < n) {
          sum += data[incomingIdx];
        } else {
          sum += data[n - 1];
        }
        
        res[i] = sum / w;
      }
      return res;
    };

    const forward = singlePass(arr);
    const backward = singlePass(forward.reverse());
    return backward.reverse();
  }

  applyZeroPhaseEMA(arr, alpha) {
    const n = arr.length;
    if (n === 0) return [];
    
    const forward = new Array(n);
    forward[0] = arr[0];
    for (let i = 1; i < n; i++) {
      forward[i] = alpha * arr[i] + (1 - alpha) * forward[i - 1];
    }
    
    const backward = new Array(n);
    backward[n - 1] = forward[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      backward[i] = alpha * forward[i] + (1 - alpha) * backward[i + 1];
    }
    
    return backward;
  }

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

      if (curr > prev && curr >= next) {
        if (curr >= threshold) {
          let onsetIdx = i;
          while (onsetIdx > 0 && phasicVals[onsetIdx] > 0) {
            if (onsetIdx < i - 1 && phasicVals[onsetIdx] < phasicVals[onsetIdx - 1]) {
              break;
            }
            onsetIdx--;
          }

          const amplitude = curr - phasicVals[onsetIdx];
          
          if (amplitude >= threshold * 0.5) {
            let halfDecayVal = phasicVals[onsetIdx] + amplitude * 0.5;
            let recoveryIdx = -1;
            for (let j = i + 1; j < n; j++) {
              if (phasicVals[j] <= halfDecayVal) {
                recoveryIdx = j;
                break;
              }
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

            i = Math.min(n - 2, i + Math.round(1.0 * this.sampleRate));
          }
        }
      }
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

    const hasFilteredGps = this.filteredGps && this.filteredGps.length === this.raw.length;

    let csv = "Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude,Latitude,Longitude";
    if (hasFilteredGps) {
      csv += ",Raw Latitude,Raw Longitude";
    }
    csv += "\n";

    for (let i = 0; i < this.raw.length; i++) {
      let isPeak = 0;
      let peakAmp = "";
      
      const peak = this.peaks.find(p => p.index === i);
      if (peak) {
        isPeak = 1;
        peakAmp = peak.amplitude.toFixed(4);
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
  module.exports = GSRAnalyzer;
} else {
  window.GSRAnalyzer = GSRAnalyzer;
}
