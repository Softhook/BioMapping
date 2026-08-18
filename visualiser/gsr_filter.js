/**
 * GSR/EDA Signal Filter Pipeline — standalone pure functions.
 * Extracted from GSRAnalyzer (analyzer.js) so they can be tested
 * independently of the analysis engine.
 *
 * All functions operate on plain Float64Array-compatible arrays.
 */

const GsrFilter = {

  /**
   * Create a sliding sorted window pre-seeded with the first `half+1` elements
   * of `arr`. Returns `{ window, insert, remove }` where `insert`/`remove` keep
   * the window sorted via binary search — O(log n + n) per op (splice dominates).
   *
   * Factored out of applyMedianFilter and applyPercentileFilter which were
   * carrying byte-for-byte duplicate copies of this machinery.
   *
   * @param {Array<number>} arr  - Source data array
   * @param {number} half        - Floor of windowSize / 2
   * @returns {{ window: Array<number>, insert: Function, remove: Function }}
   */
  _makeSortedWindow(arr, half) {
    const win = [];
    for (let i = 0; i <= Math.min(half, arr.length - 1); i++) {
      win.push(arr[i]);
    }
    win.sort((a, b) => a - b);

    function insert(val) {
      let lo = 0, hi = win.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (win[mid] < val) lo = mid + 1;
        else hi = mid;
      }
      win.splice(lo, 0, val);
    }

    function remove(val) {
      let lo = 0, hi = win.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (win[mid] === val) { found = mid; break; }
        else if (win[mid] < val) lo = mid + 1;
        else hi = mid - 1;
      }
      if (found !== -1) win.splice(found, 1);
    }

    return { window: win, insert, remove };
  },

  applyMedianFilter(arr, windowSize) {
    return this.applyPercentileFilter(arr, windowSize, 0.5);
  },

  /**
   * Sliding window percentile filter — used for tonic baseline estimation.
   */
  applyPercentileFilter(arr, windowSize, percentile) {
    const n = arr.length;
    if (!windowSize || isNaN(windowSize) || windowSize <= 1 || n === 0) return [...arr];
    const result = new Array(n);
    const half = Math.floor(windowSize / 2);
    const { window: sortedWindow, insert: insertSorted, remove: removeSorted } =
      this._makeSortedWindow(arr, half);

    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const leftOut = i - 1 - half;
        if (leftOut >= 0) removeSorted(arr[leftOut]);
        const rightIn = i + half;
        if (rightIn < n) insertSorted(arr[rightIn]);
      }
      const targetIdx = Math.floor(sortedWindow.length * percentile);
      result[i] = sortedWindow[targetIdx];
    }
    return result;
  },

  /**
   * Zero-phase moving average (forward + backward) — smooths without phase lag.
   * Uses centered sliding window with correct edge handling.
   */
  applyZeroPhaseMovingAverage(arr, windowSize) {
    if (!windowSize || isNaN(windowSize) || windowSize <= 1) return [...arr];
    const n = arr.length;
    if (n === 0) return [];

    const singlePass = (data) => {
      const res = new Array(n);
      const r = (windowSize - 1) / 2;
      const m = Math.floor(r);
      const f = r - m;
      const oneMinusF = 1.0 - f;

      const getVal = (idx) => (idx >= 0 && idx < n) ? data[idx] : 0.0;
      const getInd = (idx) => (idx >= 0 && idx < n) ? 1.0 : 0.0;

      // Initial sum and count at i = 0
      let sum = 0.0;
      let count = 0.0;
      for (let j = -m; j <= m; j++) {
        if (j >= 0 && j < n) {
          sum += data[j];
          count += 1.0;
        }
      }
      
      const leftIdx = -m - 1;
      if (leftIdx >= 0 && leftIdx < n) {
        sum += data[leftIdx] * f;
        count += f;
      }
      
      const rightIdx = m + 1;
      if (rightIdx >= 0 && rightIdx < n) {
        sum += data[rightIdx] * f;
        count += f;
      }

      res[0] = count > 0 ? (sum / count) : data[0];

      // Slide window
      for (let i = 0; i < n - 1; i++) {
        sum += oneMinusF * (getVal(i + m + 1) - getVal(i - m))
             + f * (getVal(i + m + 2) - getVal(i - m - 1));

        count += oneMinusF * (getInd(i + m + 1) - getInd(i - m))
               + f * (getInd(i + m + 2) - getInd(i - m - 1));

        res[i + 1] = count > 0 ? (sum / count) : data[i + 1];
      }

      return res;
    };

    const forward = singlePass(arr);
    const backward = singlePass(forward.reverse());
    return backward.reverse();
  },

  applyAdaptiveZeroPhaseMovingAverage(arr, windowSizes) {
    const n = arr.length;
    if (n === 0) return [];

    const singlePass = (data, wSizes) => {
      const res = new Array(n);
      for (let i = 0; i < n; i++) {
        const windowSize = wSizes[i];
        if (!windowSize || isNaN(windowSize) || windowSize <= 1) {
          res[i] = data[i];
          continue;
        }
        const r = (windowSize - 1) / 2;
        const m = Math.floor(r);
        const f = r - m;

        let sum = 0;
        let count = 0;

        for (let j = i - m; j <= i + m; j++) {
          if (j >= 0 && j < n) {
            sum += data[j];
            count += 1.0;
          }
        }

        const leftIdx = i - m - 1;
        if (leftIdx >= 0 && leftIdx < n) {
          sum += data[leftIdx] * f;
          count += f;
        }

        const rightIdx = i + m + 1;
        if (rightIdx >= 0 && rightIdx < n) {
          sum += data[rightIdx] * f;
          count += f;
        }

        res[i] = count > 0 ? (sum / count) : data[i];
      }
      return res;
    };

    const forward = singlePass(arr, windowSizes);
    const backward = singlePass(forward.reverse(), windowSizes.slice().reverse());
    return backward.reverse();
  },

  estimateGaitPeriods(arr, sampleRate, defaultWindowSize) {
    const n = arr.length;
    const windowSizes = new Array(n);
    if (n === 0) return [];

    const fs = sampleRate || 10.0;
    const stepSize = 10; // estimate every 10 samples (1s)
    const winLen = Math.round(10 * fs); // 10s window for local autocorrelation
    const minLag = Math.round(0.35 * fs); // e.g. 4 samples at 10Hz (2.5 Hz)
    const maxLag = Math.round(0.75 * fs); // e.g. 8 samples at 10Hz (1.25 Hz)
    const halfWin = Math.floor(winLen / 2);

    // Precompute first differences of the entire signal to strip out baseline drift
    const diff = new Array(n);
    diff[0] = 0.0;
    for (let i = 1; i < n; i++) {
      diff[i] = arr[i] - arr[i - 1];
    }

    const estimates = []; // pairs of [index, val]

    for (let i = 0; i < n; i += stepSize) {
      const start = Math.max(0, i - halfWin);
      const end = Math.min(n, i + halfWin + 1);
      const sub = diff.slice(start, end);
      const len = sub.length;

      if (len < Math.round(3 * fs)) {
        estimates.push([i, defaultWindowSize]);
        continue;
      }

      // Detrend the differences (removes local linear trend of original signal)
      const mean = sub.reduce((a, b) => a + b, 0) / len;
      const detrended = sub.map(x => x - mean);

      // Compute variance
      let variance = detrended.reduce((sum, x) => sum + x * x, 0);
      if (variance === 0) {
        estimates.push([i, defaultWindowSize]);
        continue;
      }

      // Autocorrelation for lags minLag to maxLag
      const acf = [];
      let maxCoeff = -Infinity;
      let bestLag = -1;

      for (let lag = minLag; lag <= maxLag; lag++) {
        let num = 0;
        for (let j = 0; j < len - lag; j++) {
          num += detrended[j] * detrended[j + lag];
        }
        const coeff = num / variance;
        acf.push({ lag, coeff });
        if (coeff > maxCoeff) {
          maxCoeff = coeff;
          bestLag = lag;
        }
      }

      // Check peak prominence (threshold check)
      let peakFound = false;
      let peakLag = defaultWindowSize;

      // Threshold is 0.15 on the first-difference signal (highly sensitive and robust)
      if (maxCoeff > 0.15) {
        const idx = bestLag - minLag;
        if (idx > 0 && idx < acf.length - 1) {
          const y_left = acf[idx - 1].coeff;
          const y_mid = acf[idx].coeff;
          const y_right = acf[idx + 1].coeff;
          
          if (y_mid > y_left && y_mid > y_right) {
            const denom = 2.0 * (y_left - 2.0 * y_mid + y_right);
            const offset = denom !== 0 ? (y_left - y_right) / denom : 0.0;
            peakLag = bestLag + offset;
            peakLag = Math.max(minLag, Math.min(maxLag, peakLag));
            peakFound = true;
          }
        }
      }

      // If walk is detected, convolve with stride period (2 * step period)
      // Otherwise, convolve with defaultWindowSize (user's manual resting fallback)
      const targetW = peakFound ? (2.0 * peakLag) : defaultWindowSize;
      estimates.push([i, targetW]);
    }

    // Linearly interpolate estimates back to n samples
    for (let i = 0; i < n; i++) {
      let left = estimates[0];
      let right = estimates[estimates.length - 1];

      for (let k = 0; k < estimates.length; k++) {
        if (estimates[k][0] <= i) {
          left = estimates[k];
        }
        if (estimates[k][0] >= i) {
          right = estimates[k];
          break;
        }
      }

      if (left[0] === right[0]) {
        windowSizes[i] = left[1];
      } else {
        const ratio = (i - left[0]) / (right[0] - left[0]);
        windowSizes[i] = left[1] + ratio * (right[1] - left[1]);
      }
    }

    // Smooth the windowSizes using a 30-second moving average (300 samples at 10Hz) to prevent FM noise
    const smoothWin = Math.max(1, Math.round(30 * fs));
    const smoothHalf = Math.floor(smoothWin / 2);
    const result = new Array(n);

    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let j = i - smoothHalf; j <= i + smoothHalf; j++) {
        if (j >= 0 && j < n) {
          sum += windowSizes[j];
          count++;
        }
      }
      result[i] = sum / count;
    }

    return result;
  },

  /**
   * Zero-phase exponential moving average (forward + backward).
   * Alpha = 2 / (windowSize + 1) per EMA convention.
   */
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
  },

  /**
   * Calculates mean and standard deviation of an array of numeric values.
   */
  calculateStats(values) {
    const n = values.length;
    if (n === 0) return { mean: 0, std: 1 };
    
    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const std = Math.sqrt(variance);
    
    return { mean, std: std === 0 ? 1 : std }; // Prevent division by zero
  },

  /**
   * Standardizes a signal array of { time, val } objects using Z-score.
   */
  standardizeSignal(signal) {
    const vals = signal.map(d => d.val);
    const stats = this.calculateStats(vals);
    return signal.map(d => ({
      time: d.time,
      val: (d.val - stats.mean) / stats.std
    }));
  },

  /**
   * Decomposes a filtered/smoothed signal into Tonic and Phasic components.
   * Reuses the exact same logic and local-floor envelope correction from the analyzer.
   *
   * @param {Array<number>} afterLPF - Low-pass filtered signal
   * @param {number} sampleRate     - Sample rate in Hz
   * @param {Object} params         - Parameters: { tonicMethod, tonicWindow, dwtLevel }
   * @returns {{ tonic: Array<number>, phasic: Array<number> }}
   */
  decomposeTonicPhasic(afterLPF, sampleRate, params = {}) {
    const n = afterLPF.length;
    if (n === 0) return { tonic: [], phasic: [] };

    let tonicVals = [];
    let phasicVals = [];

    const method = params.tonicMethod || 'lpf';

    if (method === 'dwt') {
      const dwtLevel = params.dwtLevel || 6;
      if (typeof DWT === 'undefined') {
        throw new Error('DWT is not defined. Ensure dwt_filter.js is loaded.');
      }
      const result = DWT.analyzeGSR(afterLPF, dwtLevel);
      const smoothWin = Math.max(1, Math.round(5 * sampleRate));
      tonicVals = this.applyZeroPhaseMovingAverage(result.tonic, smoothWin);
    } else {
      const windowSec = params.tonicWindow !== undefined ? params.tonicWindow : 45;
      const tonicWinSize = Math.max(5, Math.round(windowSec * sampleRate));

      if (method === 'median') {
        tonicVals = this.applyMedianFilter(afterLPF, tonicWinSize);
      } else if (method === 'percentile') {
        tonicVals = this.applyPercentileFilter(afterLPF, tonicWinSize, 0.10);
      } else { // 'lpf' / 'ema'
        const alpha = 2.0 / (tonicWinSize + 1);
        tonicVals = this.applyZeroPhaseEMA(afterLPF, alpha);
      }
    }

    // Phasic = Filtered - Tonic (Initial Subtraction)
    phasicVals = afterLPF.map((v, i) => v - tonicVals[i]);

    // Reposition the tonic using a local-floor approach: for each sample, find
    // the minimum of (signal - tonic) in a ±6 s window.
    const floorHalf = Math.max(1, Math.round(6 * sampleRate)); // ±6 s
    const localOffsets = new Array(n);
    {
      const bwd = new Array(n);
      const dq1 = [];
      for (let i = 0; i < n; i++) {
        if (dq1.length > 0 && dq1[0] < i - floorHalf) dq1.shift();
        while (dq1.length > 0 && phasicVals[dq1[dq1.length - 1]] >= phasicVals[i]) dq1.pop();
        dq1.push(i);
        bwd[i] = phasicVals[dq1[0]];
      }
      const dq2 = [];
      for (let i = n - 1; i >= 0; i--) {
        if (dq2.length > 0 && dq2[0] > i + floorHalf) dq2.shift();
        while (dq2.length > 0 && phasicVals[dq2[dq2.length - 1]] >= phasicVals[i]) dq2.pop();
        dq2.push(i);
        localOffsets[i] = Math.min(bwd[i], phasicVals[dq2[0]]);
      }
    }

    // Light smoothing on offset curve (4 s window)
    const smoothOffsets = this.applyZeroPhaseMovingAverage(
      localOffsets, Math.round(4 * sampleRate)
    );
    for (let i = 0; i < n; i++) {
      tonicVals[i] += smoothOffsets[i];
    }

    // Recompute phasic from repositioned tonic, clamp to >=0
    phasicVals = afterLPF.map((v, i) => Math.max(0, v - tonicVals[i]));

    return { tonic: tonicVals, phasic: phasicVals };
  }
};
