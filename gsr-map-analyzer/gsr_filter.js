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

  /**
   * Sliding window median filter — removes impulse noise / motion artifacts.
   */
  applyMedianFilter(arr, windowSize) {
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
      result[i] = sortedWindow[Math.floor(sortedWindow.length / 2)];
    }
    return result;
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
      const half = Math.floor(windowSize / 2);
      let sum = 0;
      let count = 0;

      // Initialize: window centered at index 0 (clamped at left edge)
      for (let i = 0; i <= Math.min(half, n - 1); i++) {
        sum += data[i];
        count++;
      }
      res[0] = sum / count;

      for (let i = 1; i < n; i++) {
        // Remove the element that leaves the window on the left
        const leftOut = i - half - 1;
        if (leftOut >= 0) {
          sum -= data[leftOut];
          count--;
        }
        // Add the element that enters the window on the right
        const rightIn = i + half;
        if (rightIn < n) {
          sum += data[rightIn];
          count++;
        }
        res[i] = sum / count;
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
  }
};
