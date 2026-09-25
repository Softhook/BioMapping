/**
 * GPS helpers shared by the GPS pipeline: the per-fix measurement-noise model
 * the Kalman filter (gps_cv_kalman.mjs) uses, and RDP simplification for
 * display.
 *
 * All functions operate on { lat, lon, time, ... } point objects.
 */

import { GeoUtils } from './geo_utils.mjs';

export const GpsFilter = {
  /**
   * Shared DOP fallback preference: pdop (chip-computed from all
   * constellations via GSA — most accurate) over hdop, falling back to
   * `fallbackDefault` when neither is valid. Sentinel values >= 50.0 (e.g.
   * 99.9 "unknown") are treated as invalid.
   */
  _preferredDop(pt, fallbackDefault) {
    if (!isNaN(pt.pdop) && pt.pdop > 0 && pt.pdop < 50.0) return pt.pdop;
    if (!isNaN(pt.hdop) && pt.hdop > 0 && pt.hdop < 50.0) return pt.hdop;
    return fallbackDefault;
  },

  /**
   * Canonical measurement-noise-variance model (m²): prefers hacc_m — the
   * u-blox M10Q's physical EKF horizontal accuracy from $PUBX,00 — over
   * DOP²-scaling of R_base_m2, since DOP (satellite geometry) can look fine
   * while multipath drives true position error up (e.g. HDOP 1.2 but hAcc
   * 15 m in an urban canyon). hacc_m is u-blox-only: on L76K hardware, or
   * before the first $PUBX,00 sentence, it's the 99.9 "unknown" sentinel and
   * this falls back to DOP²-scaling, clamped to [0.5, 10.0] — below 0.5 is
   * unrealistically optimistic, above 10.0 the HDOP gate has already
   * filtered most points.
   *
   * @param {object} pt - point with optional hacc/pdop/hdop fields
   * @param {number} R_base_m2 - base measurement variance (m²) to scale by DOP²
   */
  measurementVarianceM2(pt, R_base_m2) {
    if (!isNaN(pt.hacc) && pt.hacc > 0 && pt.hacc < 50.0) {
      return pt.hacc * pt.hacc;
    }
    const h = Math.max(0.5, Math.min(10.0, this._preferredDop(pt, 1.0)));
    return R_base_m2 * h * h;
  },

  /**
   * Ramer-Douglas-Peucker (RDP) trajectory simplification.
   * Reduces point count while preserving the overall shape.
   *
   * @param {Set<number>} [forceIndexSet] - analyzer.raw row indices (matched
   *   against each point's .origIdx) that must never be dropped, regardless
   *   of perpendicular distance — see GSRAnalyzer._detectRfPeakIndices().
   *   Plain RDP only reasons about geometric shape, so a momentary RF spike
   *   sitting on an otherwise-straight segment would normally fall below
   *   tolerance and vanish.
   */
  applyRDP(points, tolerance, forceIndexSet) {
    if (
      !tolerance ||
      isNaN(tolerance) ||
      tolerance <= 0.001 ||
      points.length < 3
    )
      return points;
    const n = points.length;

    const getPerpendicularDistance = (p, s, e) => {
      return GeoUtils.distanceToSegmentMeters(
        p.lat,
        p.lon,
        s.lat,
        s.lon,
        e.lat,
        e.lon,
      );
    };

    // keep mask: keep[i] is 1 if point i is kept, 0 if dropped.
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;

    const rdpRecurse = (startIdx, endIdx) => {
      if (endIdx <= startIdx + 1) return;

      let maxDist = 0;
      let index = -1;

      for (let i = startIdx + 1; i < endIdx; i++) {
        const dist = getPerpendicularDistance(
          points[i],
          points[startIdx],
          points[endIdx],
        );
        if (dist > maxDist) {
          maxDist = dist;
          index = i;
        }
      }

      if (maxDist > tolerance) {
        keep[index] = 1;
        rdpRecurse(startIdx, index);
        rdpRecurse(index, endIdx);
      }
    };

    if (!forceIndexSet || forceIndexSet.size === 0) {
      rdpRecurse(0, n - 1);
    } else {
      // Split into segments at forced vertices so they are guaranteed to survive
      const boundaryIdxs = [0];
      for (let i = 1; i < n - 1; i++) {
        if (forceIndexSet.has(points[i].origIdx)) {
          boundaryIdxs.push(i);
          keep[i] = 1;
        }
      }
      boundaryIdxs.push(n - 1);

      for (let s = 0; s < boundaryIdxs.length - 1; s++) {
        rdpRecurse(boundaryIdxs[s], boundaryIdxs[s + 1]);
      }
    }

    // Build the final array of kept points in a single pass
    const result = [];
    for (let i = 0; i < n; i++) {
      if (keep[i] === 1) {
        result.push(points[i]);
      }
    }
    return result;
  },
};
