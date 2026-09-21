/**
 * Physiological response latency — the one place that knows GSR lags its
 * stimulus.
 *
 * A GSR sample at time t reflects what the walker met at t − lag: an SCR peaks
 * ~1–3 s after its trigger, and the walker has moved on since. Anything that
 * pairs GSR with a place (map markers, environment lookups, junction windows)
 * must therefore read the place at t − lag, or equivalently read the GSR at
 * (place time) + lag. The lag is set by the "Latency Offset" slider
 * (gpsPeakLatency); consumers get their numbers from here rather than
 * reading the slider or re-deriving the tonic scaling themselves.
 *
 * Phasic/peaks use the slider value as is. Tonic (SCL) follows its driver on a
 * slower time course, so it is read further back — the same knob scaled ×4 and
 * capped at 30 s (≈40 m at walking pace).
 */
import { GSR_CONST } from '../core/constants.mjs';

export const PhysioLatency = {
  TONIC_FACTOR: 4,
  TONIC_MAX_S: 30,

  /** Finite, non-negative seconds; anything else falls back to the default. */
  normalise(latency) {
    const v = Number(latency);
    if (!Number.isFinite(v)) return GSR_CONST.GPS_DEFAULT.peakLatency;
    return Math.max(0, v);
  },

  /** Per-channel lags (s) for a slider value. */
  lags(latency) {
    const phasic = this.normalise(latency);
    return {
      phasic,
      tonic: Math.min(this.TONIC_MAX_S, phasic * this.TONIC_FACTOR),
    };
  },

  /** Current slider value in seconds (default when the slider is absent). */
  fromSlider() {
    const el =
      typeof document !== 'undefined'
        ? document.getElementById('gpsPeakLatency')
        : null;
    return this.normalise(el ? parseFloat(el.value) : NaN);
  },
};
