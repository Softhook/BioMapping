/**
 * GSR/EDA Signal Filter Pipeline — standalone pure functions.
 * Extracted from GSRAnalyzer (analyzer.js) so they can be tested
 * independently of the analysis engine.
 *
 * All functions operate on plain Float64Array-compatible arrays.
 */

const GsrFilter = {

  /**
   * Sliding window median filter — removes impulse noise / motion artifacts.
   */
  applyMedianFilter(arr, windowSize) {
    const n = arr.length;
    const result = new Array(n);
    const half = Math.floor(windowSize / 2);

    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - half);
      const end = Math.min(n - 1, i + half);
      const window = [];
      for (let j = start; j <= end; j++) {
        window.push(arr[j]);
      }
      window.sort((a, b) => a - b);
      result[i] = window[Math.floor(window.length / 2)];
    }
    return result;
  },

  /**
   * Sliding window percentile filter — used for tonic baseline estimation.
   */
  applyPercentileFilter(arr, windowSize, percentile) {
    const n = arr.length;
    const result = new Array(n);
    const half = Math.floor(windowSize / 2);

    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - half);
      const end = Math.min(n - 1, i + half);
      const window = [];
      for (let j = start; j <= end; j++) {
        window.push(arr[j]);
      }
      window.sort((a, b) => a - b);
      const targetIdx = Math.floor(window.length * percentile);
      result[i] = window[targetIdx];
    }
    return result;
  },

  /**
   * Zero-phase moving average (forward + backward) — smooths without phase lag.
   */
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
  }
};
