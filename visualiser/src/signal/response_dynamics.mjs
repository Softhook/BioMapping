/**
 * Response Dynamics — how quickly each SCR rises (response shape).
 *
 * For SparsEDA runs, every detected peak gets a rise time, measured on its
 * own bump rebuilt from the dictionary atoms that make it up (so overlapping
 * neighbours don't distort it), and a speed factor: how quick that rise is
 * compared with what is typical for a response of that size on this
 * project's walks. 1.0x = typical, >1 quicker, <1 slower.
 *
 * What rise time does and doesn't mean (Dawson, Schell & Filion, Handbook of
 * Psychophysiology; Boucsein, Electrodermal Activity):
 *   - It is NOT a measure of how intense or emotional a response was; size
 *     (amplitude) and frequency carry that.
 *   - It is mostly set by the skin: sweat-duct filling, skin temperature
 *     (colder = slower), electrode site, hydration and the person. So it is
 *     best compared between peaks of the same walk, not between walks.
 *   - A drawn-out rise usually means a longer or repeated nerve burst (or two
 *     responses merging): the model needs several staggered atoms for it.
 *   - A rise much quicker than skin normally manages (< SHARP_RISE_SEC) is
 *     more often electrode movement or pressure than a real response.
 *   - Normal rise times span roughly 1-3 s.
 *
 * This module is the single source of truth for the categories, colours,
 * the rise-time measurement and the speed rule.
 */

const VERY_DRAWN_OUT = 'Very drawn-out';
const DRAWN_OUT = 'Drawn-out';
const TYPICAL = 'Typical';
const BRIEF = 'Brief';
const SHARP = 'Sharp';

export const ResponseDynamics = {
  /**
   * Category labels, in ascending speed-factor order.
   */
  SPEED_LABELS: [VERY_DRAWN_OUT, DRAWN_OUT, TYPICAL, BRIEF, SHARP],

  /**
   * Colour for each category.
   */
  SPEED_COLORS: {
    [VERY_DRAWN_OUT]: '#8b5cf6', // purple
    [DRAWN_OUT]: '#3b82f6', // blue
    [TYPICAL]: '#10b981', // green
    [BRIEF]: '#f97316', // orange
    [SHARP]: '#ef4444', // red — also where possible artefacts land
  },

  /**
   * Speed-factor bands. A factor of 1.25 means the peak rose in 80 % of the
   * typical time for its size; 0.5 means it took twice as long.
   */
  BANDS: [
    {
      id: 'very_drawn_out',
      label: VERY_DRAWN_OUT,
      scale: 0.5,
      color: '#8b5cf6',
      minVal: -Infinity,
      maxVal: 0.625,
    },
    {
      id: 'drawn_out',
      label: DRAWN_OUT,
      scale: 0.75,
      color: '#3b82f6',
      minVal: 0.625,
      maxVal: 0.875,
    },
    {
      id: 'typical',
      label: TYPICAL,
      scale: 1.0,
      color: '#10b981',
      minVal: 0.875,
      maxVal: 1.125,
    },
    {
      id: 'brief',
      label: BRIEF,
      scale: 1.25,
      color: '#f97316',
      minVal: 1.125,
      maxVal: 1.375,
    },
    {
      id: 'sharp',
      label: SHARP,
      scale: 1.5,
      color: '#ef4444',
      minVal: 1.375,
      maxVal: Infinity,
    },
  ],

  /**
   * Resolve the discrete band for a numeric speed factor.
   *
   * @param {number} val - Speed factor (e.g. 0.50 .. 1.50).
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
    return bands[2]; // Fallback to 'Typical'
  },

  /**
   * 1-based discrete bucket index for categorical maps and 3D globe geometry.
   * 0 = Resting / Inactive (transparent).
   * 1..5 = Very drawn-out, Drawn-out, Typical, Brief, Sharp.
   *
   * @param {number} val
   * @returns {number} 0..5
   */
  getBucketIndex(val) {
    const band = this.getBand(val);
    return band ? this.BANDS.indexOf(band) + 1 : 0;
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
   * Hex color for a named category.
   *
   * @param {string} label
   * @returns {string} Hex color string
   */
  getSpeedColor(label) {
    return this.SPEED_COLORS[label] || this.SPEED_COLORS[TYPICAL];
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
    const speedLabel = band ? band.label : TYPICAL;
    const color = band ? band.color : this.SPEED_COLORS[TYPICAL];
    return {
      valueStr: `${val.toFixed(2)}x (${speedLabel})`,
      color,
    };
  },

  /**
   * Typical rise time (10 %-of-height to apex, seconds) for a response of
   * REFERENCE_HEIGHT µS, and how it grows with size: bigger responses rise
   * more slowly (longer nerve bursts fill more ducts), so without the size
   * term 'drawn-out' would partly just mean 'big'. Expected rise for height h
   * = REFERENCE_RISE_SEC · (h / REFERENCE_HEIGHT)^SIZE_EXPONENT.
   *
   * Fitted on 63 walks (7483 SparsEDA peaks) as a log-log line through the
   * median rise of each height decile: rise is flat (1.2-1.3 s) over the
   * smallest 90 % and ~1.5 s for the largest 10 %. 1.3 s at 0.2 µS sits in
   * the quick half of the textbook 1-3 s range, in line with the canonical
   * kernels of cvxEDA / Alexander et al. (~1.15 s). The band edges were
   * checked for sensitivity: ~12 % of peaks sit within 2 % of an edge for
   * any reference from 1.15 to 1.45 s.
   */
  REFERENCE_RISE_SEC: 1.3,
  REFERENCE_HEIGHT: 0.2,
  SIZE_EXPONENT: 0.075,

  /**
   * Rises quicker than this are flagged as possible artefacts: real SCRs
   * rarely rise in under ~0.5 s (the peak quality score uses the same bound).
   */
  SHARP_RISE_SEC: 0.5,

  /**
   * Expected (typical) rise time for a response of the given height.
   *
   * @param {number} height - Bump height (µS); <= 0 or missing = no size term.
   * @returns {number} Seconds.
   */
  expectedRise(height) {
    if (!(height > 0) || !this.SIZE_EXPONENT) return this.REFERENCE_RISE_SEC;
    return (
      this.REFERENCE_RISE_SEC *
      (height / this.REFERENCE_HEIGHT) ** this.SIZE_EXPONENT
    );
  },

  /**
   * Speed factor and category for a measured rise time.
   *
   * @param {number} rise - Seconds.
   * @param {number} [height] - Bump height (µS), for the size allowance.
   * @returns {{ scaleFactor: number, speedLabel: string }}
   */
  speedFor(rise, height) {
    if (!(rise > 0)) return { scaleFactor: 1.0, speedLabel: TYPICAL };
    const scaleFactor =
      Math.round((this.expectedRise(height) / rise) * 100) / 100;
    return { scaleFactor, speedLabel: this.getBand(scaleFactor).label };
  },

  /**
   * Rebuild the bump made by a group of SparsEDA atoms, isolated from any
   * neighbouring responses, and measure it: height, and rise time from 10 %
   * of the height to the apex (linearly interpolated). Textbook rise time
   * runs from the first upturn; for this kernel shape the 10 % start is only
   * ~3 % shorter and is far less sensitive to tiny leading atoms.
   *
   * @param {Array<{onsetSec:number, bandAmps:number[]}>} atoms
   * @param {Array<Float64Array>} bandKernels - Per-band kernels at workRate.
   * @param {number} workRate - Sample rate the kernels are sampled at.
   * @returns {{rise: number, height: number}|null} Null if there is no bump.
   */
  measureBump(atoms, bandKernels, workRate) {
    if (!atoms.length || !bandKernels || !workRate) return null;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const a of atoms) {
      if (a.onsetSec < t0) t0 = a.onsetSec;
      if (a.onsetSec > t1) t1 = a.onsetSec;
    }
    let kLen = 0;
    for (const k of bandKernels) kLen = Math.max(kLen, k.length);
    const y = new Float64Array(Math.round((t1 - t0) * workRate) + kLen);
    for (const a of atoms) {
      const o = Math.round((a.onsetSec - t0) * workRate);
      for (let b = 0; b < bandKernels.length; b++) {
        const c = a.bandAmps[b];
        if (!(c > 0)) continue;
        const k = bandKernels[b];
        for (let j = 0; j < k.length; j++) y[o + j] += c * k[j];
      }
    }
    let m = 0;
    for (let i = 1; i < y.length; i++) if (y[i] > y[m]) m = i;
    if (!(y[m] > 0)) return null;
    const th = 0.1 * y[m];
    let j = m;
    while (j > 0 && y[j - 1] >= th) j--;
    const frac = j > 0 ? (y[j] - th) / (y[j] - y[j - 1]) : 0;
    return { rise: (m - j + frac) / workRate, height: y[m] };
  },

  /**
   * Rise time measured on the signal itself: the phasic input around the
   * peak, minus the tails of earlier atoms (responses that started before
   * this one), from 10 % of the height to the apex. Not limited by the
   * dictionary's kernel shapes, but the signal's own smoothing blurs quick
   * rises, so measurePeakRise only uses it where the model is at its limit.
   *
   * @param {ArrayLike<number>} signal - Phasic input the solver was given.
   * @param {number} fs - Its sample rate.
   * @param {number} winStart - First sample of the peak's atom window.
   * @param {number} apexIdx - Detected apex sample.
   * @param {Array<object>} earlierAtoms - Atoms with onset before winStart.
   * @param {{bandKernels: Array<Float64Array>, workRate: number}} kinetics
   * @returns {number|null} Seconds, or null if there is no rise.
   */
  measureOnSignal(signal, fs, winStart, apexIdx, earlierAtoms, kinetics) {
    const { bandKernels, workRate } = kinetics;
    const lo = Math.max(0, winStart);
    const hi = Math.min(signal.length - 1, apexIdx + Math.round(0.3 * fs));
    if (hi <= lo) return null;
    const seg = new Float64Array(hi - lo + 1);
    for (let i = lo; i <= hi; i++) seg[i - lo] = signal[i];
    for (const a of earlierAtoms) {
      for (let i = lo; i <= hi; i++) {
        const x = (i / fs - a.onsetSec) * workRate;
        if (x < 0) continue;
        const j = Math.floor(x);
        const f = x - j;
        let v = 0;
        for (let b = 0; b < bandKernels.length; b++) {
          const c = a.bandAmps[b];
          const k = bandKernels[b];
          if (!(c > 0) || j + 1 >= k.length) continue;
          v += c * (k[j] * (1 - f) + k[j + 1] * f);
        }
        seg[i - lo] -= v;
      }
    }
    // Apex: the signal's maximum near the detected one.
    let m = Math.min(seg.length - 1, Math.max(0, apexIdx - lo));
    for (let i = Math.max(0, m - 3); i < seg.length; i++)
      if (seg[i] > seg[m]) m = i;
    let base = Infinity;
    for (let i = 0; i <= m; i++) if (seg[i] < base) base = seg[i];
    const h = seg[m] - base;
    if (!(h > 0)) return null;
    const th = base + 0.1 * h;
    let j = m;
    while (j > 0 && seg[j - 1] >= th) j--;
    const frac = j > 0 ? (seg[j] - th) / (seg[j] - seg[j - 1]) : 0;
    return (m - j + frac) / fs;
  },

  /**
   * A peak's rise time. The rebuilt model bump (measureBump) is the better
   * measure except where the model is at its limit: the dictionary's slowest
   * kernel rises in ~1.4 s while real SCRs rise in ~1-3 s, so a response
   * resting on that kernel may be slower than the model can express. There
   * the signal's own rise (measureOnSignal) is used if longer. On synthetic
   * tracks with known rise times this matched the true category for 73 % of
   * peaks (86 % of truly slow ones) against 65 % (66 %) for the model alone.
   *
   * @returns {{rise: number, height: number}|null}
   */
  measurePeakRise(windowAtoms, earlierAtoms, winStart, apexIdx, fs, kinetics) {
    const bump = this.measureBump(
      windowAtoms,
      kinetics.bandKernels,
      kinetics.workRate,
    );
    if (!bump) return null;
    let strongest = windowAtoms[0];
    for (const a of windowAtoms)
      if ((a.height ?? 0) > (strongest.height ?? 0)) strongest = a;
    const atCeiling = strongest.bandIdx === kinetics.bandKernels.length - 1;
    if (atCeiling && kinetics.signal) {
      const onSignal = this.measureOnSignal(
        kinetics.signal,
        fs,
        winStart,
        apexIdx,
        earlierAtoms,
        kinetics,
      );
      if (onSignal > bump.rise) return { rise: onSignal, height: bump.height };
    }
    return bump;
  },

  /**
   * Annotate detected peaks with a rise-speed category and compute aggregate
   * statistics. Sets on each peak:
   *   speedRiseTime   - rise time of its own rebuilt bump (s). Separate from
   *                     peak.riseTime (onset-to-apex on the summed curve, cut
   *                     short when responses overlap), which quality scoring
   *                     uses.
   *   scaleFactor     - speed vs typical for its size (see speedFor).
   *   speedLabel      - category from BANDS.
   *   possibleArtefact- rise quicker than SHARP_RISE_SEC.
   *
   * With `kinetics` (SparsEDA's band kernels) and atoms carrying bandAmps the
   * bump is rebuilt and measured; otherwise the strongest atom's own
   * (template-based) label is used.
   *
   * @param {Array<object>} peaks - List of detected peaks.
   * @param {Array<object>} driverPeaks - SparsEDA driver impulses.
   * @param {number} sampleRate - Sampling rate in Hz.
   * @param {{bandKernels: Array<Float64Array>, workRate: number,
   *          signal?: ArrayLike<number>}} [kinetics] - signal = the phasic
   *   input the solver was given (see measurePeakRise).
   * @returns {object} Summary statistics
   */
  tagPeaks(peaks, driverPeaks = [], sampleRate = 10, kinetics = null) {
    const counts = {};
    for (const l of this.SPEED_LABELS) counts[l] = 0;
    let sumScale = 0;
    let nTagged = 0;
    let nArtefact = 0;
    const fs = sampleRate || 10;

    if (!peaks || peaks.length === 0) {
      return {
        speedCounts: counts,
        dominantSpeed: TYPICAL,
        meanScaleFactor: 1.0,
        totalTaggedPeaks: 0,
        possibleArtefacts: 0,
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
      const windowAtoms = [];

      // 1. Primary search: every atom between onset and apex; the strongest
      // is the one by bump height, not raw coefficient (slow-band
      // coefficients are inflated by their unit-energy kernels).
      for (let i = 0; i < driverPeaks.length; i++) {
        const drv = driverPeaks[i];
        if (drv.index >= winStart && drv.index <= winEnd) {
          windowAtoms.push(drv);
          const strength = drv.height ?? drv.amplitude;
          if (strength > maxAmp) {
            maxAmp = strength;
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
        if (bestDriver) windowAtoms.push(bestDriver);
      }

      const measurable =
        kinetics &&
        windowAtoms.length > 0 &&
        windowAtoms.every((a) => a.bandAmps);
      let bump = null;
      if (measurable) {
        // Earlier responses whose tails still run under this one: the
        // longest kernel lasts ~19 s.
        const earlierAtoms = driverPeaks.filter(
          (a) =>
            a.bandAmps && a.index < winStart && a.onsetSec > winStart / fs - 20,
        );
        bump = this.measurePeakRise(
          windowAtoms,
          earlierAtoms,
          winStart,
          apexIdx,
          fs,
          kinetics,
        );
      }

      peak.possibleArtefact = false;
      if (bump) {
        const speed = this.speedFor(bump.rise, bump.height);
        peak.speedRiseTime = Math.round(bump.rise * 100) / 100;
        peak.scaleFactor = speed.scaleFactor;
        peak.speedLabel = speed.speedLabel;
        peak.possibleArtefact = bump.rise < this.SHARP_RISE_SEC;
        peak.bandIdx = bestDriver.bandIdx ?? 2;
      } else if (bestDriver) {
        peak.speedLabel = bestDriver.speedLabel ?? TYPICAL;
        peak.scaleFactor = bestDriver.scaleFactor ?? 1.0;
        peak.bandIdx = bestDriver.bandIdx ?? 2;
      } else {
        peak.speedLabel = TYPICAL;
        peak.scaleFactor = 1.0;
        peak.bandIdx = 2;
      }

      if (counts[peak.speedLabel] !== undefined) {
        counts[peak.speedLabel]++;
      }
      if (peak.possibleArtefact) nArtefact++;
      sumScale += peak.scaleFactor;
      nTagged++;
    }

    let dominantSpeed = TYPICAL;
    let maxCount = -1;
    for (const [speed, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        dominantSpeed = speed;
      }
    }

    return {
      speedCounts: counts,
      dominantSpeed: maxCount > 0 ? dominantSpeed : TYPICAL,
      meanScaleFactor: nTagged > 0 ? sumScale / nTagged : 1.0,
      totalTaggedPeaks: nTagged,
      possibleArtefacts: nArtefact,
    };
  },

  /**
   * Compute a continuous event-gated rise-speed series.
   *
   * Between responses the series is 0.0 (rendered as transparent / inactive).
   * Over each peak (onset to recovery) it holds the peak's speed factor
   * (see speedFor). Overlapping responses are resolved by proximity weighted
   * by peak amplitude.
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
        raw?.[i] && typeof raw[i].time === 'number'
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
