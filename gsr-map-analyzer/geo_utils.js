/**
 * Shared geographical geometry utilities for the Bio Mapping GSR analyser.
 */
const GeoUtils = {
  EARTH_RADIUS_M: 6371000,
  METERS_PER_DEG_LAT: 111320,

  /**
   * Haversine distance between two lat/lon points in metres.
   */
  haversineMeters(lat1, lon1, lat2, lon2) {
    const R = GeoUtils.EARTH_RADIUS_M;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /**
   * Shortest distance (m) from point P(lat, lon) to line segment AB.
   */
  distanceToSegmentMeters(lat, lon, lat1, lon1, lat2, lon2) {
    const cosLat = Math.cos(((lat + lat1 + lat2) / 3) * Math.PI / 180);
    const x = lon * cosLat,  y = lat;
    const x1 = lon1 * cosLat, y1 = lat1;
    const x2 = lon2 * cosLat, y2 = lat2;

    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;

    let t = 0;
    if (l2 > 0) {
      t = ((x - x1) * dx + (y - y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
    }

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const distLat = projY - y;
    const distLon = (projX - x) / cosLat;

    return Math.sqrt(distLat * distLat + distLon * distLon) * GeoUtils.METERS_PER_DEG_LAT;
  },

  /**
   * Chaikin's corner-cutting algorithm — smooths a polyline into a rounded curve by
   * repeatedly replacing each vertex with two points at 1/4 and 3/4 along its adjacent
   * segments. Cheap, dependency-free way to turn a blocky, grid-aligned contour path
   * (e.g. from Marching Squares) into a visually smooth continuous curve without pulling
   * in a spline library.
   *
   * @param {Array<{lat:number, lon:number}>} points - Path vertices, in order.
   * @param {number} [iterations=2] - Number of smoothing passes (higher = smoother/rounder).
   * @param {boolean} [closed=false] - Whether the path is a closed loop (first === last).
   * @returns {Array<{lat:number, lon:number}>} Smoothed path.
   */
  chaikinSmooth(points, iterations = 2, closed = false) {
    if (!points || points.length < 3) return points || [];
    const EPS = 1e-9;

    // Collapse consecutive (near-)duplicate vertices first. Marching Squares emits
    // zero-length or near-zero-length segments at ambiguous grid crossings (e.g. a grid
    // value landing exactly on the contour level right at a cell corner), and stitching
    // happily joins them since they share an endpoint. Left in, a run of overlapping
    // vertices just perpetuates itself through every Chaikin pass — visually a stub/kink
    // in the curve rather than a smooth pass-through, and it can occur anywhere along the
    // path, not just at a ring's closing point.
    let pts = [];
    for (const p of points) {
      const prev = pts[pts.length - 1];
      if (!prev || Math.abs(prev.lat - p.lat) > EPS || Math.abs(prev.lon - p.lon) > EPS) {
        pts.push(p);
      }
    }

    // Stitched closed rings repeat their first point as the last point (that's how the
    // path-stitcher detects the loop closed). Left in place, Chaikin treats that repeat as
    // an extra near-zero-length segment right at the seam, which produces a visible kink/
    // duplicate-vertex cluster exactly where the ring closes instead of a clean curve.
    // Drop the duplicate before smoothing and treat the ring as a genuinely cyclic point set.
    if (closed && pts.length > 1) {
      const first = pts[0], last = pts[pts.length - 1];
      if (Math.abs(first.lat - last.lat) < EPS && Math.abs(first.lon - last.lon) < EPS) {
        pts = pts.slice(0, -1);
      }
    }
    if (pts.length < 3) return points;

    for (let iter = 0; iter < iterations; iter++) {
      const n = pts.length;
      const segCount = closed ? n : n - 1;
      const next = [];
      if (!closed) next.push(pts[0]); // keep the start endpoint anchored
      for (let i = 0; i < segCount; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % n];
        next.push({ lat: 0.75 * p0.lat + 0.25 * p1.lat, lon: 0.75 * p0.lon + 0.25 * p1.lon });
        next.push({ lat: 0.25 * p0.lat + 0.75 * p1.lat, lon: 0.25 * p0.lon + 0.75 * p1.lon });
      }
      if (!closed) next.push(pts[n - 1]); // keep the end endpoint anchored
      pts = next;
    }

    // Re-close the ring explicitly (first point repeated at the end) so the rendered
    // polyline has no visible gap or seam where it loops back on itself.
    if (closed) pts = [...pts, pts[0]];
    return pts;
  },

  /**
   * Ray-casting point-in-polygon check.
   * Coordinates should be array of {lat, lon} or [lat, lon].
   */
  pointInPolygon(lat, lon, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = poly[i], pj = poly[j];
      const xi = Array.isArray(pi) ? pi[1] : pi.lon;
      const yi = Array.isArray(pi) ? pi[0] : pi.lat;
      const xj = Array.isArray(pj) ? pj[1] : pj.lon;
      const yj = Array.isArray(pj) ? pj[0] : pj.lat;

      if ((yi > lat) !== (yj > lat) &&
          lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
};
