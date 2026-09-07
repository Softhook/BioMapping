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
   * Uses centred sliding window with correct edge handling.
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

  /**
   * Zero-phase exponential moving average (forward + backward).
   * Alpha = 2 / (windowSize + 1) per EMA convention.
   *
   * Both passes are seeded from a robust (10th-percentile) estimate of the
   * baseline over ~one time constant of samples at the near end, not the bare
   * first/last sample. Seeding with arr[0] / arr[n-1] lets an opening or
   * closing SCR (or artifact) bias the result for ~1/alpha samples — tens of
   * seconds at tonic settings — whereas a low-percentile seed starts on the
   * between-SCR floor.
   */
  applyZeroPhaseEMA(arr, alpha) {
    const n = arr.length;
    if (n === 0) return [];

    const seedWin = Math.min(n, Math.max(1, Math.round(1 / alpha)));
    const seedFloor = (lo, hi) => {
      const s = arr.slice(lo, hi).sort((a, b) => a - b);
      return s[Math.floor(0.1 * (s.length - 1))];
    };

    const forward = new Array(n);
    forward[0] = seedFloor(0, seedWin);
    for (let i = 1; i < n; i++) {
      forward[i] = alpha * arr[i] + (1 - alpha) * forward[i - 1];
    }

    const backward = new Array(n);
    backward[n - 1] = alpha * forward[n - 1] + (1 - alpha) * seedFloor(n - seedWin, n);
    for (let i = n - 2; i >= 0; i--) {
      backward[i] = alpha * forward[i] + (1 - alpha) * backward[i + 1];
    }

    return backward;
  },

  /**
   * Calculates mean and standard deviation of an array of numeric values.
   */
  calculateStats(values) {
    if (typeof StatsMath !== 'undefined' && typeof StatsMath.calculateStats === 'function') {
      return StatsMath.calculateStats(values);
    }
    const n = values ? values.length : 0;
    if (n === 0) return { mean: 0, std: 1 };
    
    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
    const std = Math.sqrt(variance);
    
    return { mean, std: std === 0 ? 1 : std }; // Prevent division by zero
  },

  /**
   * Standardizes a signal array of { time, val } objects using Z-score.
   */
  standardizeSignal(signal, out = null) {
    const vals = signal.map(d => d.val);
    const stats = this.calculateStats(vals);
    const n = signal.length;
    // Reuse the caller's {time,val} array when one of the right length is
    // passed (analyzer.js pools tonicZ/phasicZ across analyze() calls) rather
    // than allocating a fresh n-object array every call.
    if (out && out.length === n) {
      for (let i = 0; i < n; i++) {
        out[i].time = signal[i].time;
        out[i].val = (signal[i].val - stats.mean) / stats.std;
      }
      return out;
    }
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
   * @param {Object} params         - Parameters: { tonicMethod, tonicWindow }
   * @returns {{ tonic: Array<number>, phasic: Array<number> }}
   */
  decomposeTonicPhasic(afterLPF, sampleRate, params = {}) {
    const n = afterLPF.length;
    if (n === 0) return { tonic: [], phasic: [] };

    let tonicVals = [];
    let phasicVals = [];

    const method = params.tonicMethod || 'lpf';
    const windowSec = params.tonicWindow !== undefined ? params.tonicWindow : 45;
    const tonicWinSize = Math.max(5, Math.round(windowSec * sampleRate));

    if (method === 'median') {
      tonicVals = this.applyMedianFilter(afterLPF, tonicWinSize);
    } else if (method === 'percentile') {
      tonicVals = this.applyPercentileFilter(afterLPF, tonicWinSize, 0.10);
    } else { // 'lpf' / 'ema' (also the fallback for any unrecognised method)
      const alpha = 2.0 / (tonicWinSize + 1);
      tonicVals = this.applyZeroPhaseEMA(afterLPF, alpha);
    }

    // Reposition the tonic onto the local floor: for each sample, subtract the
    // minimum of (signal - tonic) over a ±6 s window, lightly smoothed. This
    // guarantees the tonic never rides above the signal, so no SCR ever has
    // its lower flank clipped away by the phasic = max(0, signal - tonic) step.
    // Runs for every method — on the sliding-window / EMA tonics it does the
    // heavy lifting, since they otherwise sit well above the signal.
    {
      // Phasic = Filtered - Tonic (Initial Subtraction)
      phasicVals = afterLPF.map((v, i) => v - tonicVals[i]);

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
    }

    // Recompute phasic from the (possibly repositioned) tonic, clamp to >=0
    phasicVals = afterLPF.map((v, i) => Math.max(0, v - tonicVals[i]));

    return { tonic: tonicVals, phasic: phasicVals };
  }
};
