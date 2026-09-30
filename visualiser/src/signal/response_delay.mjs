/**
 * Response delay — the one place that pairs body data with place data.
 *
 * A skin response comes a moment after whatever caused it, by which time the
 * walker has moved on. The Response delay slider moves all body data (GSR,
 * tonic, phasic, peaks, hotspots, the indices) back along the route by the
 * same number of seconds; place data (position, speed, OSM context, NDVI,
 * EM fog) stays where it was measured. It changes where body data appears,
 * never what it is. See docs/time_offsets_review.md (Solution design).
 *
 * Every view that pairs a reading with a place goes through the functions
 * here (via the GSRAnalyzer methods of the same names), so they all move
 * together:
 *   placeOf(a, i)     reading i → the position at (its time − delay),
 *                     interpolated between rows so the slider moves smoothly
 *   placeRowOf(a, i)  reading i → the place row at (its time − delay)
 *   readingAt(a, j)   place row j → the reading at (its time + delay)
 * A reading has no place (null / −1) when that moment is before the
 * recording started or had no position; a place has no reading (−1) when that
 * moment is after the recording ended.
 */

// Row times carry float noise (6.9 − 6.6 = 0.30000000000000004); a moment
// within this of a row is that row.
const EPS_S = 1e-6;

export const ResponseDelay = {
  MIN_S: 0,
  MAX_S: 8,
  DEFAULT_S: 2,
  STEP_S: 0.1,

  /** Seconds within 0–8; anything that isn't a number becomes the default. */
  normalise(s) {
    const v = Number(s);
    if (s == null || !Number.isFinite(v)) return this.DEFAULT_S;
    return Math.min(this.MAX_S, Math.max(this.MIN_S, v));
  },

  /** Last row at or before time t (−1 if t is before the first row). */
  _rowAtOrBefore(raw, t) {
    if (!raw.length || t < raw[0].time - EPS_S) return -1;
    let lo = 0;
    let hi = raw.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (raw[mid].time <= t + EPS_S) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  },

  /** Row nearest time t (−1 if t is outside the recording). */
  _rowNearest(raw, t) {
    const k = this._rowAtOrBefore(raw, t);
    if (k < 0) return -1;
    if (k === raw.length - 1) return t > raw[k].time + EPS_S ? -1 : k;
    return t - raw[k].time <= raw[k + 1].time - t ? k : k + 1;
  },

  placeRowOf(a, i) {
    if (!(i >= 0 && i < a.raw.length)) return -1;
    // At 0 s every reading is paired with its own row: no search needed, and
    // exactly the pairing the app had before the Response delay existed.
    if (!a.responseDelay) return a.getCoordinates(i) ? i : -1;
    const j = this._rowNearest(a.raw, a.raw[i].time - a.responseDelay);
    return j >= 0 && a.getCoordinates(j) ? j : -1;
  },

  placeOf(a, i) {
    const raw = a.raw;
    if (!(i >= 0 && i < raw.length)) return null;
    if (!a.responseDelay) {
      const p = a.getCoordinates(i);
      return p ? { lat: p.lat, lon: p.lon } : null;
    }
    const t = raw[i].time - a.responseDelay;
    const k = this._rowAtOrBefore(raw, t);
    if (k < 0) return null;
    const p = a.getCoordinates(k);
    if (!p) return null;
    const span = k + 1 < raw.length ? raw[k + 1].time - raw[k].time : 0;
    const f = span > 0 ? (t - raw[k].time) / span : 0;
    if (f <= EPS_S) return { lat: p.lat, lon: p.lon };
    const q = a.getCoordinates(k + 1);
    if (!q) return null;
    return {
      lat: p.lat + f * (q.lat - p.lat),
      lon: p.lon + f * (q.lon - p.lon),
    };
  },

  readingAt(a, j) {
    if (!(j >= 0 && j < a.raw.length)) return -1;
    if (!a.responseDelay) return j;
    return this._rowNearest(a.raw, a.raw[j].time + a.responseDelay);
  },

  /**
   * Whether reading i has a place at every slider setting this analyzer can
   * be shown at (0 to a.maxResponseDelay): the whole stretch of route from
   * that far back up to the reading itself has a position. Hotspots are
   * chosen only from such peaks, so none appears or vanishes while dragging.
   */
  placedAtEveryDelay(a, i) {
    const raw = a.raw;
    if (!(i >= 0 && i < raw.length)) return false;
    const k = this._rowAtOrBefore(raw, raw[i].time - a.maxResponseDelay);
    if (k < 0) return false;
    for (let j = k; j <= i; j++) if (!a.getCoordinates(j)) return false;
    return true;
  },
};
