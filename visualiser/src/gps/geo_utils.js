/**
 * Shared geographical geometry utilities for the Bio Mapping GSR analyser.
 */
const GeoUtils = {
  EARTH_RADIUS_M: 6371000,
  METERS_PER_DEG_LAT: 111320,

  /**
   * Conversion factors from degrees to metres at a given latitude.
   *
   * @param {number} lat - Latitude in degrees.
   * @returns {{degToMeterLat: number, degToMeterLon: number}} Scaling factors.
   */
  getGeodesicScale(lat) {
    const degToMeterLon = GeoUtils.METERS_PER_DEG_LAT * Math.cos(parseFloat(lat) * Math.PI / 180);
    return { degToMeterLat: GeoUtils.METERS_PER_DEG_LAT, degToMeterLon };
  },

  /**
   * Fast flat-earth squared distance in metres given scale factors.
   *
   * @param {number} lat1 - Point 1 latitude.
   * @param {number} lon1 - Point 1 longitude.
   * @param {number} lat2 - Point 2 latitude.
   * @param {number} lon2 - Point 2 longitude.
   * @param {{degToMeterLat: number, degToMeterLon: number}} [scale] - Scale factors.
   * @returns {number} Squared distance in metres.
   */
  distanceMetersSq(lat1, lon1, lat2, lon2, scale) {
    const sc = scale || GeoUtils.getGeodesicScale((parseFloat(lat1) + parseFloat(lat2)) / 2);
    const dy = (parseFloat(lat1) - parseFloat(lat2)) * sc.degToMeterLat;
    const dx = (parseFloat(lon1) - parseFloat(lon2)) * sc.degToMeterLon;
    return dx * dx + dy * dy;
  },

  /**
   * Fast flat-earth distance in metres given scale factors.
   *
   * @param {number} lat1 - Point 1 latitude.
   * @param {number} lon1 - Point 1 longitude.
   * @param {number} lat2 - Point 2 latitude.
   * @param {number} lon2 - Point 2 longitude.
   * @param {{degToMeterLat: number, degToMeterLon: number}} [scale] - Scale factors.
   * @returns {number} Distance in metres.
   */
  distanceMeters(lat1, lon1, lat2, lon2, scale) {
    return Math.sqrt(GeoUtils.distanceMetersSq(lat1, lon1, lat2, lon2, scale));
  },

  /**
   * Extract standardised {lat, lon} numbers from various point representations.
   *
   * @param {object|Array} p - Point representation ({lat, lon}, {lat, lng}, [lat, lon], etc.)
   * @returns {{lat: number, lon: number}|null} Standardised coordinate pair or null.
   */
  extractCoord(p) {
    if (!p) return null;
    let lat, lon;
    if (typeof p.lat === 'number') lat = p.lat;
    else if (Array.isArray(p)) lat = p[0];
    else if (typeof p.lat === 'function') lat = p.lat();
    else if (p.lat != null) lat = parseFloat(p.lat);

    if (typeof p.lon === 'number') lon = p.lon;
    else if (typeof p.lng === 'number') lon = p.lng;
    else if (Array.isArray(p)) lon = p[1];
    else if (typeof p.lon === 'function') lon = p.lon();
    else if (p.lon != null) lon = parseFloat(p.lon);
    else if (p.lng != null) lon = parseFloat(p.lng);

    return (!isNaN(lat) && !isNaN(lon)) ? { lat, lon } : null;
  },

  /**
   * Compute bounding box for an array of points ({lat, lon} or [lat, lon]).
   *
   * @param {Array<object|Array>} points - Array of points.
   * @param {number} [marginRatio=0] - Optional margin ratio (e.g. 0.1 for 10% padding).
   * @param {function} [filterFn] - Optional point filter predicate.
   * @returns {{minLat: number, maxLat: number, minLon: number, maxLon: number}|null}
   */
  computeBounds(points, marginRatio = 0, filterFn) {
    if (!points || points.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p || (filterFn && !filterFn(p))) continue;
      const pt = GeoUtils.extractCoord(p);
      if (pt) {
        if (pt.lat < minLat) minLat = pt.lat;
        if (pt.lat > maxLat) maxLat = pt.lat;
        if (pt.lon < minLon) minLon = pt.lon;
        if (pt.lon > maxLon) maxLon = pt.lon;
      }
    }
    if (minLat === Infinity) return null;
    if (marginRatio > 0) {
      const latPad = (maxLat - minLat) * marginRatio;
      const lonPad = (maxLon - minLon) * marginRatio;
      minLat -= latPad;
      maxLat += latPad;
      minLon -= lonPad;
      maxLon += lonPad;
    }
    return { minLat, maxLat, minLon, maxLon };
  },

  /**
   * Expand a bounding box by a buffer distance in metres.
   *
   * @param {{minLat: number, maxLat: number, minLon: number, maxLon: number}} bounds
   * @param {number} marginMeters - Buffer in metres.
   * @returns {{minLat: number, maxLat: number, minLon: number, maxLon: number}} Expanded bounds.
   */
  expandBounds(bounds, marginMeters) {
    if (!bounds) return null;
    const midLat = (bounds.minLat + bounds.maxLat) / 2;
    const scale = GeoUtils.getGeodesicScale(midLat);
    const dLat = marginMeters / scale.degToMeterLat;
    const dLon = marginMeters / scale.degToMeterLon;
    return {
      minLat: bounds.minLat - dLat,
      maxLat: bounds.maxLat + dLat,
      minLon: bounds.minLon - dLon,
      maxLon: bounds.maxLon + dLon
    };
  },

  /**
   * Real-world area of a lat/lon bounding box in km².
   *
   * @param {{minLat: number, maxLat: number, minLon: number, maxLon: number}} bbox
   * @returns {number} Area in km².
   */
  bboxAreaKm2(bbox) {
    if (!bbox) return 0;
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const scale = GeoUtils.getGeodesicScale(midLat);
    const hKm = (bbox.maxLat - bbox.minLat) * (scale.degToMeterLat / 1000);
    const wKm = (bbox.maxLon - bbox.minLon) * (scale.degToMeterLon / 1000);
    return Math.max(0, hKm * wKm);
  },

  /**
   * Check if two bounding boxes overlap.
   *
   * @param {{minLat: number, maxLat: number, minLon: number, maxLon: number}} a
   * @param {{minLat: number, maxLat: number, minLon: number, maxLon: number}} b
   * @returns {boolean}
   */
  bboxIntersects(a, b) {
    if (!a || !b) return false;
    return a.minLat <= b.maxLat && a.maxLat >= b.minLat &&
           a.minLon <= b.maxLon && a.maxLon >= b.minLon;
  },

  /**
   * Smallest bounding box that contains every bbox in `bboxes`.
   *
   * @param {Array<{minLat: number, maxLat: number, minLon: number, maxLon: number}>} bboxes
   * @returns {{minLat: number, maxLat: number, minLon: number, maxLon: number}|null}
   */
  unionBBox(bboxes) {
    if (!bboxes || bboxes.length === 0) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const b of bboxes) {
      if (!b) continue;
      if (b.minLat < minLat) minLat = b.minLat;
      if (b.maxLat > maxLat) maxLat = b.maxLat;
      if (b.minLon < minLon) minLon = b.minLon;
      if (b.maxLon > maxLon) maxLon = b.maxLon;
    }
    if (minLat === Infinity) return null;
    return { minLat, maxLat, minLon, maxLon };
  },

  /**
   * Initial bearing (forward azimuth) from point 1 to point 2 in radians (-π..π).
   *
   * @param {number} lat1 - Start latitude.
   * @param {number} lon1 - Start longitude.
   * @param {number} lat2 - End latitude.
   * @param {number} lon2 - End longitude.
   * @returns {number} Bearing in radians.
   */
  bearingRad(lat1, lon1, lat2, lon2) {
    const φ1 = parseFloat(lat1) * Math.PI / 180;
    const φ2 = parseFloat(lat2) * Math.PI / 180;
    const Δλ = (parseFloat(lon2) - parseFloat(lon1)) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return Math.atan2(y, x);
  },

  /**
   * Initial bearing (forward azimuth) from point 1 to point 2 in degrees [0, 360).
   *
   * @param {number} lat1 - Start latitude.
   * @param {number} lon1 - Start longitude.
   * @param {number} lat2 - End latitude.
   * @param {number} lon2 - End longitude.
   * @returns {number} Compass bearing in degrees [0, 360).
   */
  bearingDeg(lat1, lon1, lat2, lon2) {
    const rad = GeoUtils.bearingRad(lat1, lon1, lat2, lon2);
    const deg = rad * 180 / Math.PI;
    return (deg + 360) % 360;
  },

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
   * Project point P(lat, lon) onto segment AB, returning distance (m) and snapped coordinates.
   */
  projectPointToSegment(lat, lon, lat1, lon1, lat2, lon2) {
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
    const dist = Math.sqrt(distLat * distLat + distLon * distLon) * GeoUtils.METERS_PER_DEG_LAT;

    return {
      distance: dist,
      lat: projY,
      lon: projX / cosLat
    };
  },

  /**
   * Shortest distance (m) from point P(lat, lon) to line segment AB.
   */
  distanceToSegmentMeters(lat, lon, lat1, lon1, lat2, lon2) {
    return this.projectPointToSegment(lat, lon, lat1, lon1, lat2, lon2).distance;
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

    const toPt = (p) => {
      if (!p) return { lat: 0, lon: 0, lng: 0 };
      if (Array.isArray(p)) return { lat: p[0], lon: p[1], lng: p[1] };
      const lat = typeof p.lat === 'number' ? p.lat : (typeof p.lat === 'function' ? p.lat() : 0);
      const lon = typeof p.lon === 'number' ? p.lon : (typeof p.lng === 'number' ? p.lng : (typeof p.lng === 'function' ? p.lng() : (typeof p.lon === 'function' ? p.lon() : 0)));
      return { lat, lon, lng: lon };
    };

    let pts = [];
    for (const rawP of points) {
      const p = toPt(rawP);
      const prev = pts[pts.length - 1];
      if (!prev || Math.abs(prev.lat - p.lat) > EPS || Math.abs(prev.lon - p.lon) > EPS) {
        pts.push(p);
      }
    }

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
        const latA = 0.75 * p0.lat + 0.25 * p1.lat;
        const lonA = 0.75 * p0.lon + 0.25 * p1.lon;
        const latB = 0.25 * p0.lat + 0.75 * p1.lat;
        const lonB = 0.25 * p0.lon + 0.75 * p1.lon;
        next.push({ lat: latA, lon: lonA, lng: lonA });
        next.push({ lat: latB, lon: lonB, lng: lonB });
      }
      if (!closed) next.push(pts[n - 1]); // keep the end endpoint anchored
      pts = next;
    }

    if (closed) pts = [...pts, pts[0]];
    return pts;
  },

  /**
   * Shoelace formula: unsigned area enclosed by a closed polygon ring.
   * Coordinates should be array of {lat, lon} or [lat, lon]. Units are
   * (whatever the input coordinates are)², e.g. degrees² for lat/lon rings —
   * not a real-world area, but consistent for comparing two rings' relative
   * size (e.g. "is this loop meaningfully smaller than that one").
   */
  shoelaceArea(points) {
    if (!points || points.length < 3) return 0;
    let a = 0;
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i], p2 = points[(i + 1) % points.length];
      const lat1 = Array.isArray(p1) ? p1[0] : p1.lat, lon1 = Array.isArray(p1) ? p1[1] : p1.lon;
      const lat2 = Array.isArray(p2) ? p2[0] : p2.lat, lon2 = Array.isArray(p2) ? p2[1] : p2.lon;
      a += lon1 * lat2 - lon2 * lat1;
    }
    return Math.abs(a) / 2;
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

if (typeof window !== 'undefined') window.GeoUtils = GeoUtils;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GeoUtils };
}
