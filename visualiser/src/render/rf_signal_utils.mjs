/**
 * Shared RF-band squelch/normalisation math for the 2D fluid overlay
 * (RFFluidRenderer) and the 3D volumetric expanse (globe3d/rf_expanse.mjs).
 * Keeping this in one place means the two views can't drift apart on what
 * counts as an "active" band or how a raw dBm reading maps to 0..1 fluid
 * intensity.
 */

// Absolute hardware/squelch noise floor. Readings at or below this are
// ambient noise, not active RF detections, regardless of the track's own
// dynamic range.
export const HARD_NOISE_FLOOR_DBM = -90.0;

// Gamma curve applied to the normalised 0..1 ramp for higher visual
// contrast on active detections.
export const NORM_GAMMA = 0.75;

// Default post-gamma gain, so a strong signal still reaches full intensity
// after the gamma curve compresses the top of the range.
export const DEFAULT_GAIN = 1.15;

/**
 * A band only counts as "active" if its peak clears the hard noise floor
 * AND spans at least 3 dB above its own local floor — otherwise 1-2 dB of
 * noise-floor jitter would stretch to full intensity and paint a dead band
 * solid.
 *
 * @param {number} floor - Band's minimum RSSI (dBm) on this track.
 * @param {number} peak - Band's maximum RSSI (dBm) on this track.
 * @returns {boolean}
 */
export function bandHasActiveSignal(floor, peak) {
  return (
    isFinite(floor) &&
    isFinite(peak) &&
    peak > HARD_NOISE_FLOOR_DBM &&
    peak - floor >= 3.0
  );
}

/**
 * Thresholded RSSI normalizer: 0 for an inactive band or any sample at/below
 * the local threshold (the greater of the hard noise floor and floor + 3dB);
 * a gamma-boosted 0..1 ramp from there up to the band peak.
 *
 * @param {number} val - Raw RSSI reading (dBm) to normalise.
 * @param {number} floor - Band's minimum RSSI (dBm) on this track.
 * @param {number} peak - Band's maximum RSSI (dBm) on this track.
 * @param {boolean} active - Result of bandHasActiveSignal(floor, peak).
 * @param {number} [gain=DEFAULT_GAIN] - Post-gamma intensity gain.
 * @returns {number} Normalised intensity in [0, 1].
 */
export function normDbm(val, floor, peak, active, gain = DEFAULT_GAIN) {
  if (val === null || val === undefined || isNaN(val) || !active) return 0.0;
  const threshold = Math.max(HARD_NOISE_FLOOR_DBM, floor + 3.0);
  if (val <= threshold) return 0.0;
  const activeRange = Math.max(5.0, peak - threshold);
  const norm = Math.max(0, Math.min(1, (val - threshold) / activeRange));
  return Math.max(0, Math.min(1, norm ** NORM_GAMMA * gain));
}
