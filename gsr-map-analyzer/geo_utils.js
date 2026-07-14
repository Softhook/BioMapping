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
