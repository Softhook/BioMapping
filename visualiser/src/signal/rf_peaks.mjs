/**
 * Momentary RF spike detection across the Sub-GHz bands.
 *
 * The map pipeline (GpsPipeline.buildDrawPoints / GpsPipeline.applyRDP, see
 * manager/process.mjs:_getOrBuildDrawPoints()) and RFFluidRenderer treat these
 * rows as forced vertices, so brief 868/915 MHz-class emissions can't be
 * simplified away before they're ever drawn — plain geometric RDP/stride
 * decimation has no notion of RF magnitude and will happily erase a spike
 * that sits on an otherwise straight or stationary stretch of track.
 */
import { SUB_GHZ_BANDS } from './em_fog.mjs';

/** A spike must stand this far above an adjacent sample. */
const RF_PEAK_PROMINENCE_DB = 3.5;

/**
 * Row indices where at least one band shows a local maximum at least
 * RF_PEAK_PROMINENCE_DB above an adjacent sample.
 * @param {Array<object>} data - Parsed row objects with rssi_* fields.
 * @param {string[]|null} [activeBands] - Band props to scan (the subset found
 *   in the CSV header); all Sub-GHz bands when omitted.
 * @returns {Set<number>} Indices of momentary RF spikes.
 */
export function detectRfPeakIndices(data, activeBands = null) {
  const bands = activeBands || SUB_GHZ_BANDS.map((b) => b.prop);
  const n = data.length;
  const peakIndices = new Set();

  for (const band of bands) {
    for (let i = 0; i < n; i++) {
      const v = data[i][band];
      if (typeof v !== 'number' || isNaN(v)) continue;

      const prev = i > 0 ? data[i - 1][band] : undefined;
      const next = i < n - 1 ? data[i + 1][band] : undefined;
      const prevValid = typeof prev === 'number' && !isNaN(prev);
      const nextValid = typeof next === 'number' && !isNaN(next);

      if (prevValid && v < prev) continue;
      if (nextValid && v < next) continue;

      const prominent =
        (prevValid && v - prev >= RF_PEAK_PROMINENCE_DB) ||
        (nextValid && v - next >= RF_PEAK_PROMINENCE_DB);
      if (prominent) peakIndices.add(i);
    }
  }
  return peakIndices;
}
