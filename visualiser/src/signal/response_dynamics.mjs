/**
 * Response Dynamics — Multi-Scale Autonomic Response Speed Analysis
 *
 * Implements autonomic response speed profiling derived from SparsEDA
 * multi-scale dictionary deconvolution. In SparsEDA, the physiological
 * impulse response function (SCRF) dictionary contains atoms at 5 dilation
 * scales (0.50x to 1.50x), capturing autonomic kinetics from rapid startle
 * reactions to sluggish, prolonged responses.
 *
 * This module serves as the single source of truth for:
 *   - Physiological dilation scales (0.50x to 1.50x)
 *   - Discrete speed categories ('Very Slow' .. 'Very Fast')
 *   - Continuous speed band thresholds and palette mappings
 *   - Peak matching heuristics and aggregate statistics
 *   - Event-gated time-series computation with distance-weighted overlap resolution
 */

export const ResponseDynamics = {
  /**
   * Canonical multi-scale dictionary dilation factors.
   */
  SCALE_FACTORS: [0.5, 0.75, 1.0, 1.25, 1.5],

  /**
   * Canonical speed category labels (ascending scale order).
   */
  SPEED_LABELS: ['Very Slow', 'Slow', 'Standard', 'Fast', 'Very Fast'],

  /**
   * Canonical color palette for each speed category.
   */
  SPEED_COLORS: {
    'Very Slow': '#8b5cf6', // 0.50x (Deep Purple / Lingering tension)
    Slow: '#3b82f6', // 0.75x (Vivid Blue / Sluggish clearance)
    Standard: '#10b981', // 1.00x (Emerald Green / Habitual baseline)
    Fast: '#f97316', // 1.25x (Vibrant Orange / Rapid recruitment)
    'Very Fast': '#ef4444', // 1.50x (Vivid Red / Acute shock or startle)
  },

  /**
   * Continuous speed band definitions with partition thresholds.
   */
  BANDS: [
    {
      id: 'very_slow',
      label: 'Very Slow',
      scale: 0.5,
      color: '#8b5cf6',
      minVal: -Infinity,
      maxVal: 0.625,
    },
    {
      id: 'slow',
      label: 'Slow',
      scale: 0.75,
      color: '#3b82f6',
      minVal: 0.625,
      maxVal: 0.875,
    },
    {
      id: 'standard',
      label: 'Standard',
      scale: 1.0,
      color: '#10b981',
      minVal: 0.875,
      maxVal: 1.125,
    },
    {
      id: 'fast',
      label: 'Fast',
      scale: 1.25,
      color: '#f97316',
      minVal: 1.125,
      maxVal: 1.375,
    },
    {
      id: 'very_fast',
      label: 'Very Fast',
      scale: 1.5,
      color: '#ef4444',
      minVal: 1.375,
      maxVal: Infinity,
    },
  ],

  /**
   * Resolve the discrete speed band for a numeric scale factor.
   *
   * @param {number} val - Response speed multiplier (e.g. 0.50 .. 1.50).
   * @returns {object|null} Band descriptor or null if resting / inactive (<= 0).
   */
  getBand(val) {
    if (val == null || !isFinite(val) || val <= 0) return null;
    const bands = this.BANDS;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (
        val >= b.minVal &&
        (i === bands.length - 1 ? val <= b.maxVal : val < b.maxVal)
      ) {
        return b;
      }
    }
    return bands[2]; // Fallback to 'Standard'
  },

  /**
   * 1-based discrete bucket index for categorical maps and 3D globe geometry.
   * 0 = Resting / Inactive (transparent).
   * 1..5 = Very Slow, Slow, Standard, Fast, Very Fast.
   *
   * @param {number} val
   * @returns {number} 0..5
   */
  getBucketIndex(val) {
    if (val == null || !isFinite(val) || val <= 0) return 0;
    if (val < 0.625) return 1; // Very Slow
    if (val < 0.875) return 2; // Slow
    if (val < 1.125) return 3; // Standard
    if (val < 1.375) return 4; // Fast
    return 5; // Very Fast
  },

  /**
   * Hex color or 'transparent' for map/graph rendering.
   *
   * @param {number} val
   * @returns {string} Hex color string or 'transparent'
   */
  getColor(val) {
    const band = this.getBand(val);
    return band ? band.color : 'transparent';
  },

  /**
   * Hex color for a named speed category.
   *
   * @param {string} label
   * @returns {string} Hex color string
   */
  getSpeedColor(label) {
    return this.SPEED_COLORS[label] || this.SPEED_COLORS['Standard'];
  },

  /**
   * Format tooltip value and color for graph hover / scrubber inspection.
   *
   * @param {number} val - Series value at scrubber.
   * @param {string} [secondaryColor='#64748b'] - Text color for resting state.
   * @returns {{ valueStr: string, color: string }}
   */
  formatTooltip(val, secondaryColor = '#64748b') {
    if (val == null || !isFinite(val) || val <= 0) {
      return { valueStr: 'Resting', color: secondaryColor };
    }
    const band = this.getBand(val);
    const speedLabel = band ? band.label : 'Standard';
    const color = band ? band.color : this.SPEED_COLORS['Standard'];
    return {
      valueStr: `${val.toFixed(2)}x (${speedLabel})`,
      color,
    };
  },

  /**
   * Annotate detected peaks with their driving SparsEDA dictionary scale factor,
   * speed label, and band index, and compute aggregate dynamics statistics.
   *
   * @param {Array<object>} peaks - List of detected peaks.
   * @param {Array<object>} driverPeaks - SparsEDA driver impulses.
   * @param {number} sampleRate - Sampling rate in Hz.
   * @returns {object} Summary statistics
   */
  tagPeaks(peaks, driverPeaks = [], sampleRate = 10) {
    const counts = {
      'Very Slow': 0,
      Slow: 0,
      Standard: 0,
      Fast: 0,
      'Very Fast': 0,
    };
    let sumScale = 0;
    let nTagged = 0;
    const fs = sampleRate || 10;

    if (!peaks || peaks.length === 0) {
      return {
        speedCounts: counts,
        dominantSpeed: 'Standard',
        meanScaleFactor: 1.0,
        totalTaggedPeaks: 0,
      };
    }

    for (const peak of peaks) {
      const onsetIdx =
        peak.onsetIndex ?? Math.max(0, peak.index - Math.round(1.5 * fs));
      const apexIdx = peak.index;
      const winStart = Math.max(0, onsetIdx - Math.round(0.5 * fs));
      const winEnd = apexIdx;

      let bestDriver = null;
      let maxAmp = -Infinity;

      // 1. Primary search: strongest driver impulse between onset and apex
      for (let i = 0; i < driverPeaks.length; i++) {
        const drv = driverPeaks[i];
        if (drv.index >= winStart && drv.index <= winEnd) {
          if (drv.amplitude > maxAmp) {
            maxAmp = drv.amplitude;
            bestDriver = drv;
          }
        }
      }

      // 2. Secondary fallback: nearest driver impulse within 2 seconds of onset
      if (!bestDriver && driverPeaks.length > 0) {
        let minDist = Infinity;
        for (let i = 0; i < driverPeaks.length; i++) {
          const drv = driverPeaks[i];
          const dist = Math.abs(drv.index - onsetIdx);
          if (dist <= 2.0 * fs && dist < minDist) {
            minDist = dist;
            bestDriver = drv;
          }
        }
      }

      if (bestDriver) {
        peak.speedLabel = bestDriver.speedLabel ?? 'Standard';
        peak.scaleFactor = bestDriver.scaleFactor ?? 1.0;
        peak.bandIdx = bestDriver.bandIdx ?? 2;
      } else {
        peak.speedLabel = 'Standard';
        peak.scaleFactor = 1.0;
        peak.bandIdx = 2;
      }

      if (counts[peak.speedLabel] !== undefined) {
        counts[peak.speedLabel]++;
      }
      sumScale += peak.scaleFactor;
      nTagged++;
    }

    let dominantSpeed = 'Standard';
    let maxCount = -1;
    for (const [speed, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        dominantSpeed = speed;
      }
    }

    return {
      speedCounts: counts,
      dominantSpeed: maxCount > 0 ? dominantSpeed : 'Standard',
      meanScaleFactor: nTagged > 0 ? sumScale / nTagged : 1.0,
      totalTaggedPeaks: nTagged,
    };
  },

  /**
   * Compute a continuous event-gated autonomic response speed dynamics series.
   *
   * For resting periods without active autonomic arousal, the series returns 0.0
   * (rendered as transparent / inactive).
   * For active peak intervals (spanning physiological onset to recovery decay),
   * the series encodes the peak's dilation factor (0.50x to 1.50x). Overlapping
   * responses are resolved by proximity weighted by peak amplitude.
   *
   * @param {object} opts
   * @param {number} opts.n - Total number of samples.
   * @param {number} opts.sampleRate - Sampling rate in Hz.
   * @param {Array<object>} [opts.raw] - Raw sample array with time field.
   * @param {Array<number>} [opts.times] - Array of sample timestamps.
   * @param {Array<object>} [opts.peaks] - Analyzed peaks.
   * @param {boolean} [opts.isSparseda=true] - Whether SparsEDA is the active deconvolution algorithm.
   * @returns {Array<{ time: number, val: number }>} Continuous series
   */
  computeSeries({
    n,
    sampleRate = 4,
    raw = null,
    times = null,
    peaks = [],
    isSparseda = true,
  }) {
    if (!n || n <= 0) return [];

    const fs = sampleRate || 4;
    const series = new Array(n);
    for (let i = 0; i < n; i++) {
      const t =
        raw && raw[i] && typeof raw[i].time === 'number'
          ? raw[i].time
          : times
            ? times[i]
            : i / fs;
      series[i] = { time: t, val: 0.0 }; // 0.0 = Resting / Inactive
    }

    if (!isSparseda || !peaks || peaks.length === 0) {
      return series;
    }

    const activePeaks = peaks.filter(
      (p) => !p.excluded && typeof p.scaleFactor === 'number',
    );
    if (activePeaks.length === 0) {
      return series;
    }

    // Distance buffer to prioritize the dominant peak in overlapping responses
    const bestDist = new Float64Array(n);
    bestDist.fill(Infinity);

    for (let k = 0; k < activePeaks.length; k++) {
      const p = activePeaks[k];
      const alpha = Math.max(0.5, Math.min(1.5, p.scaleFactor));
      const apexIdx = Math.max(0, Math.min(n - 1, p.index));

      // Onset bound: detected onset or theoretical rise time (~1.2s / alpha)
      let onsetIdx =
        typeof p.onsetIndex === 'number' && p.onsetIndex >= 0
          ? p.onsetIndex
          : Math.max(0, apexIdx - Math.round((1.2 / alpha) * fs));
      onsetIdx = Math.max(0, Math.min(apexIdx, onsetIdx));

      // Recovery bound: 2.5x half-recovery index or nominal Bateman clearance (~6.0s / alpha)
      let endIdx;
      if (typeof p.recoveryIndex === 'number' && p.recoveryIndex > apexIdx) {
        endIdx = Math.min(
          n - 1,
          apexIdx + Math.round(2.5 * (p.recoveryIndex - apexIdx)),
        );
      } else {
        endIdx = Math.min(n - 1, apexIdx + Math.round((6.0 / alpha) * fs));
      }

      const amp = Math.max(0.01, p.amplitude || 0.05);

      for (let j = onsetIdx; j <= endIdx; j++) {
        // Distance weighted by amplitude so stronger responses claim overlap points
        const dist = Math.abs(j - apexIdx) / amp;
        if (dist < bestDist[j]) {
          bestDist[j] = dist;
          series[j].val = alpha;
        }
      }
    }

    return series;
  },
};
