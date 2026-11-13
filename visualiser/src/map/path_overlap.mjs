// Overlap-aware path colour: where a walk retraces itself, colour that spot
// by the mean of the metric across every visit instead of whichever visit was
// drawn last. Pure functions (no Leaflet, no DOM); used by
// manager/path.mjs and unit-tested in tests/test_path_overlap_pooling.js.

import { GeoUtils } from '../gps/geo_utils.mjs';

export const PathOverlap = {
  /**
   * Pass 1 of overlap-aware colour: bin the draw points into a grid of
   * `radiusM` cells, accumulate each cell's metric sum/count, and — walking the
   * path in time order — flag the cells where the path RE-ENTERS a place it
   * had left more than `revisitGapS` seconds ago. For each point the 3×3 block
   * around its cell is checked for a "stale" touch (last seen > revisitGapS
   * ago); when found, both the stale cell and the current cell are flagged, so
   * two passes that run alongside each other in *adjacent* cells (GPS noise
   * between visits) are still caught, not just pixel-exact re-walks.
   *
   * The re-entry test is on *elapsed time*, so a path merely wiggling across a
   * cell boundary (re-touches milliseconds apart) is never a revisit — no
   * grid-straddle false positive, and no sorting. One linear pass, 9 map reads
   * per point, one small object per occupied cell.
   *
   * Cell keys are packed integers (`cr * KEY_STRIDE + cc`, both offset to be
   * non-negative), not `"cr|cc"` strings: on a 35k-point track the string
   * concatenation — ~350k throwaway strings for the key plus the 3×3 probe —
   * was ~30ms, the bulk of a single-track path re-render; the packed form is
   * ~8x faster for identical output. `keyAt(lat, lon)` is exported so
   * pooledAccessor packs the same way.
   *
   * @param {Array<{lat:number, lon:number, time:number}>} drawPoints
   * @param {(p:object) => number} getVal
   * @param {number} radiusM  cell edge in metres
   * @param {number} revisitGapS
   * @param {Array} [vals]  getVal of every draw point, when the caller has
   *   them already (vals[i] is used in place of getVal(drawPoints[i]))
   * @returns {{ cells: Map<number,{cr,cc,sum,count,lastT,revisited}>,
   *            rLat:number, rLon:number, keyAt:(lat:number,lon:number)=>number,
   *            anyRevisited:boolean } | null}
   */
  buildCells(drawPoints, getVal, radiusM, revisitGapS, vals) {
    if (!Array.isArray(drawPoints) || drawPoints.length < 4 || !(radiusM > 0))
      return null;
    if (typeof GeoUtils.getGeodesicScale !== 'function') return null;

    const sc = GeoUtils.getGeodesicScale(
      drawPoints[drawPoints.length >> 1].lat,
    );
    const mLat = sc.degToMeterLat || 111320;
    const mLon =
      Math.abs(sc.degToMeterLon) > 1 ? Math.abs(sc.degToMeterLon) : 1;
    const rLat = radiusM / mLat;
    const rLon = radiusM / mLon;

    // Pack (cr, cc) cell indices into one integer key rather than a "cr|cc"
    // string. Offset both axes to >= 1 (the 3×3 probe reaches one past the
    // extremes) and size the column stride to this track's cc span, so
    // cr*stride + cc is collision-free and stays inside Number.MAX_SAFE_INTEGER
    // for any realistic walk. A degenerate span falls back to string keys.
    let loLat = Infinity,
      hiLat = -Infinity,
      loLon = Infinity,
      hiLon = -Infinity;
    for (let i = 0; i < drawPoints.length; i++) {
      const p = drawPoints[i];
      if (p.lat < loLat) loLat = p.lat;
      if (p.lat > hiLat) hiLat = p.lat;
      if (p.lon < loLon) loLon = p.lon;
      if (p.lon > hiLon) hiLon = p.lon;
    }
    const baseCr = Math.floor(loLat / rLat) - 2;
    const baseCc = Math.floor(loLon / rLon) - 2;
    const stride = Math.floor(hiLon / rLon) - baseCc + 2 + 1;
    const crMax = Math.floor(hiLat / rLat) - baseCr + 2;
    const packable =
      stride > 0 &&
      crMax > 0 &&
      (crMax + 1) * stride <= Number.MAX_SAFE_INTEGER;
    // key(cr, cc) from raw cell indices — the single packing rule, reused by
    // pooledAccessor via the returned `keyOf`.
    const keyOf = packable
      ? (cr, cc) => (cr - baseCr) * stride + (cc - baseCc)
      : (cr, cc) => `${cr}|${cc}`;
    const keyAt = (lat, lon) =>
      keyOf(Math.floor(lat / rLat), Math.floor(lon / rLon));

    const cells = new Map();
    let anyRevisited = false;
    // The 3×3 block around the current cell. A walk stays in one cell for
    // many points in a row, and while it does the block holds the same cells
    // (only the cell being walked in can appear, and it is filled in below),
    // so the 9 lookups are redone only when the walk moves to another cell.
    const block = new Array(9).fill(undefined);
    let blockCr = NaN;
    let blockCc = NaN;
    for (let i = 0; i < drawPoints.length; i++) {
      const p = drawPoints[i];
      const v = vals ? vals[i] : getVal(p);
      if (v === undefined || v === null || (typeof v === 'number' && isNaN(v)))
        continue;
      const t = p.time;
      const cr = Math.floor(p.lat / rLat);
      const cc = Math.floor(p.lon / rLon);
      if (cr !== blockCr || cc !== blockCc) {
        blockCr = cr;
        blockCc = cc;
        let b = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            block[b++] = cells.get(keyOf(cr + dr, cc + dc));
          }
        }
      }

      // Re-entry? Scan the 3×3 block (including this cell) for a stale touch.
      let reentry = false;
      if (isFinite(t)) {
        for (let b = 0; b < 9; b++) {
          const nb = block[b];
          if (nb && isFinite(nb.lastT) && t - nb.lastT > revisitGapS) {
            nb.revisited = true;
            reentry = true;
          }
        }
      }

      let c = block[4];
      if (!c) {
        c = { cr, cc, sum: 0, count: 0, lastT: t, revisited: false };
        cells.set(keyOf(cr, cc), c);
        block[4] = c;
      }
      if (reentry) {
        c.revisited = true;
        anyRevisited = true;
      }
      if (isFinite(t)) c.lastT = t;
      c.sum += v;
      c.count++;
    }
    return { cells, rLat, rLon, keyOf, keyAt, anyRevisited };
  },

  /**
   * Build a metric accessor `(drawPoint) => value` that, where the walk
   * genuinely retraces itself, returns the mean of the active metric across a
   * small neighbourhood instead of that point's own value — so a re-walked
   * street shows one combined colour rather than whichever visit was drawn
   * last. Elsewhere it falls straight through to `getVal`.
   *
   * `radiusM` is the caller's "same spot" distance — the stroke's on-screen
   * width in metres (see _overlapRadiusMetres) — so a spot counts as
   * overlapping exactly when the two drawn lines visually merge. Detection and
   * cell sums come from `buildCells` (straddle-safe, sort-free). Each
   * revisited cell is then coloured by the mean over its 3×3 block, which
   * keeps the colour smooth along a re-walked street instead of blocky per
   * cell and softens the ends of the overlap.
   *
   * Returns `null` when nothing overlaps (or the path is too short / GeoUtils
   * absent) so the caller keeps its plain accessor and non-overlapping paths
   * stay byte-identical.
   *
   * @param {Array<{lat:number, lon:number, time:number}>} drawPoints
   * @param {(p:object) => number} getVal
   * @param {{radiusM?:number, revisitGapS?:number, vals?:Array}|null} [opts]
   *   vals: getVal of every draw point, when the caller has them already
   * @returns {((p:object) => number) | null}  also carries `sig` and
   *   `valuesFor(points, base)` (the accessor over a whole array)
   */
  pooledAccessor(drawPoints, getVal, opts) {
    const radiusM = opts && opts.radiusM > 0 ? opts.radiusM : 7;
    const revisitGapS = opts && opts.revisitGapS > 0 ? opts.revisitGapS : 15;

    const built = PathOverlap.buildCells(
      drawPoints,
      getVal,
      radiusM,
      revisitGapS,
      opts?.vals,
    );
    if (!built?.anyRevisited) return null;

    const { cells, keyOf, keyAt } = built;
    const pooled = new Map(); // packed cell key -> mean metric over the 3×3 block

    for (const c of cells.values()) {
      if (!c.revisited) continue;
      let sum = 0,
        count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nb = cells.get(keyOf(c.cr + dr, c.cc + dc));
          if (nb) {
            sum += nb.sum;
            count += nb.count;
          }
        }
      }
      if (count > 0) pooled.set(keyOf(c.cr, c.cc), sum / count);
    }
    if (pooled.size === 0) return null;

    // Order-independent 32-bit fingerprint of the outcome. `_refreshPathOnZoom`
    // compares it to the last render's so a zoom that doesn't actually change
    // which stretches overlap (most small zoom steps) skips the path rebuild —
    // the rebuild is what visually jerks.
    let sig = pooled.size | 0;
    for (const [k, v] of pooled) {
      let h = Math.round(v * 1000) | 0;
      // k is a packed integer (or a "cr|cc" string in the degenerate fallback).
      const ks = `${k}`;
      for (let i = 0; i < ks.length; i++)
        h = (Math.imul(h, 31) + ks.charCodeAt(i)) | 0;
      sig = (sig + h) | 0;
    }

    const fn = (p) => {
      if (!p) return getVal(p);
      const m = pooled.get(keyAt(p.lat, p.lon));
      return m !== undefined ? m : getVal(p);
    };
    fn.sig = sig;
    // fn for every point of `points` at once, given their getVal values
    // (`base`). Neighbouring points share a cell, so the pooled lookup is
    // only redone when the cell changes.
    fn.valuesFor = (points, base) => {
      const out = new Array(points.length);
      let lastKey;
      let lastM;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const k = keyAt(p.lat, p.lon);
        if (k !== lastKey) {
          lastKey = k;
          lastM = pooled.get(k);
        }
        out[i] = lastM !== undefined ? lastM : base[i];
      }
      return out;
    };
    return fn;
  },

  /**
   * Cheap gate: does the path ever come back to within `radiusM` of its own
   * earlier route after a > `revisitGapS` gap? Pass 1 only (no pooling). Used
   * to decide whether a zoom change could ever create/destroy an overlap — if
   * not, the zoomend hook can skip re-rendering entirely.
   */
  retraces(drawPoints, opts) {
    const radiusM = opts && opts.radiusM > 0 ? opts.radiusM : 60;
    const revisitGapS = opts && opts.revisitGapS > 0 ? opts.revisitGapS : 15;
    const built = PathOverlap.buildCells(
      drawPoints,
      () => 1,
      radiusM,
      revisitGapS,
    );
    return !!built?.anyRevisited;
  },
};
