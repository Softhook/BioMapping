/**
 * GPS Filter Pipeline — standalone pure functions for trajectory cleaning.
 * Extracted from GSRMapManager (map.js) so the filters can be tested independently
 * and the map manager stays focused on Leaflet rendering.
 *
 * All functions operate on arrays of { lat, lon, time, ... } point objects.
 */

const GpsFilter = {

  /**
   * Haversine distance between two lat/lon points in metres.
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  /**
   * Speed plausibility check: drops points that imply speed > maxSpeed (m/s).
   * Keeps points where dt is too small to compute speed reliably.
   */
  applySpeedFilter(points, maxSpeed) {
    if (points.length < 2) return points;
    const kept = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = kept[kept.length - 1];
      const curr = points[i];
      const dist = GpsFilter.haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
      const dt = curr.time - prev.time;
      if (dt > 0.001) {
        const speed = dist / dt;
        if (speed <= maxSpeed) {
          kept.push(curr);
        }
      } else {
        kept.push(curr);
      }
    }
    return kept;
  },

  /**
   * Hampel filter (MAD-based outlier detection) applied independently to Lat and Lon.
   * Replaces outliers with the local median rather than dropping them.
   *
   * @param {Array} points  — array of { lat, lon, ... }
   * @param {number} k      — half-window size in sample count
   * @param {number} nSigma — sigma threshold for outlier classification
   */
  applyHampelFilter(points, k, nSigma) {
    if (points.length < 2 * k + 1) return points;
    const n = points.length;
    const result = [];

    const getMedianAndMAD = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const absDevs = arr.map(x => Math.abs(x - median));
      const sortedDevs = absDevs.sort((a, b) => a - b);
      const mad = sortedDevs[Math.floor(sortedDevs.length / 2)];
      return { median, mad };
    };

    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - k);
      const end = Math.min(n - 1, i + k);

      const windowLats = [];
      const windowLons = [];
      for (let j = start; j <= end; j++) {
        windowLats.push(points[j].lat);
        windowLons.push(points[j].lon);
      }

      const latStats = getMedianAndMAD(windowLats);
      const lonStats = getMedianAndMAD(windowLons);

      const sigmaLat = 1.4826 * latStats.mad;
      const sigmaLon = 1.4826 * lonStats.mad;

      const diffLat = Math.abs(points[i].lat - latStats.median);
      const diffLon = Math.abs(points[i].lon - lonStats.median);

      const isLatOutlier = sigmaLat > 1e-9 && diffLat > nSigma * sigmaLat;
      const isLonOutlier = sigmaLon > 1e-9 && diffLon > nSigma * sigmaLon;

      if (isLatOutlier || isLonOutlier) {
        result.push({
          ...points[i],
          lat: latStats.median,
          lon: lonStats.median
        });
      } else {
        result.push(points[i]);
      }
    }
    return result;
  },

  /**
   * DBSCAN-inspired sequential clustering of stationary periods.
   * Collapses clusters of points within `epsilon` metres into their centroid.
   */
  applyDBSCAN(points, epsilon, minPts) {
    if (points.length < minPts) return points;
    const n = points.length;
    const result = points.map(p => ({ ...p }));

    let i = 0;
    while (i < n) {
      let j = i;
      let sumLat = result[i].lat;
      let sumLon = result[i].lon;
      let count = 1;

      while (j + 1 < n) {
        const nextLat = result[j + 1].lat;
        const nextLon = result[j + 1].lon;
        const avgLat = sumLat / count;
        const avgLon = sumLon / count;

        const dist = GpsFilter.haversineDistance(avgLat, avgLon, nextLat, nextLon);
        if (dist <= epsilon) {
          j++;
          sumLat += nextLat;
          sumLon += nextLon;
          count++;
        } else {
          break;
        }
      }

      if (count >= minPts) {
        const centroidLat = sumLat / count;
        const centroidLon = sumLon / count;
        for (let k = i; k <= j; k++) {
          result[k].lat = centroidLat;
          result[k].lon = centroidLon;
        }
      }

      i = j + 1;
    }
    return result;
  },

  /**
   * Zero-phase 1D Kalman filter smoothing on Lat and Lon.
   * Forward pass followed by backward pass for zero phase lag.
   *
   * @param {number} Q_m2 — process noise variance (metres²)
   * @param {number} R_m2 — measurement noise variance (metres²)
   */
  applyKalman(points, Q_m2, R_m2) {
    if (points.length < 2) return points;
    const n = points.length;

    // Convert R and Q from metres squared to degrees squared.
    // Latitude: 1° ≈ 111,320 m (constant).
    // Longitude: 1° ≈ 111,320 × cos(lat) m — varies with latitude.
    // Use the mean latitude of the track for a reasonable approximation.
    const meanLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const cosLat = Math.cos(meanLat * Math.PI / 180);
    const M_TO_DEG_LAT = 1.0 / 111320.0;
    const M_TO_DEG_LON = 1.0 / (111320.0 * cosLat);
    const M2_TO_DEG2_LAT = M_TO_DEG_LAT * M_TO_DEG_LAT;
    const M2_TO_DEG2_LON = M_TO_DEG_LON * M_TO_DEG_LON;

    const R_LAT = R_m2 * M2_TO_DEG2_LAT;
    const R_LON = R_m2 * M2_TO_DEG2_LON;
    const Q_LAT = Q_m2 * M2_TO_DEG2_LAT;
    const Q_LON = Q_m2 * M2_TO_DEG2_LON;

    // Forward pass
    const forwardLats = new Array(n);
    const forwardLons = new Array(n);

    let xLat = points[0].lat;
    let xLon = points[0].lon;
    let PLat = 1.0;
    let PLon = 1.0;

    for (let i = 0; i < n; i++) {
      const pPLat = PLat + Q_LAT;
      const pPLon = PLon + Q_LON;

      const kLat = pPLat / (pPLat + R_LAT);
      const kLon = pPLon / (pPLon + R_LON);

      xLat = xLat + kLat * (points[i].lat - xLat);
      xLon = xLon + kLon * (points[i].lon - xLon);

      PLat = (1 - kLat) * pPLat;
      PLon = (1 - kLon) * pPLon;

      forwardLats[i] = xLat;
      forwardLons[i] = xLon;
    }

    // Backward pass for zero phase lag
    const result = new Array(n);
    let bxLat = forwardLats[n - 1];
    let bxLon = forwardLons[n - 1];
    let bPLat = 1.0;
    let bPLon = 1.0;

    for (let i = n - 1; i >= 0; i--) {
      const pPLat = bPLat + Q_LAT;
      const pPLon = bPLon + Q_LON;

      const kLat = pPLat / (pPLat + R_LAT);
      const kLon = pPLon / (pPLon + R_LON);

      bxLat = bxLat + kLat * (forwardLats[i] - bxLat);
      bxLon = bxLon + kLon * (forwardLons[i] - bxLon);

      bPLat = (1 - kLat) * pPLat;
      bPLon = (1 - kLon) * pPLon;

      result[i] = {
        ...points[i],
        lat: bxLat,
        lon: bxLon
      };
    }

    return result;
  },

  /**
   * Ramer-Douglas-Peucker (RDP) trajectory simplification.
   * Reduces point count while preserving the overall shape.
   */
  applyRDP(points, tolerance) {
    if (tolerance <= 0.001 || points.length < 3) return points;

    const getPerpendicularDistance = (p, s, e) => {
      const latRad = s.lat * Math.PI / 180;
      const cosLat = Math.cos(latRad);

      const xS = 0;
      const yS = 0;
      const xE = (e.lon - s.lon) * 111320.0 * cosLat;
      const yE = (e.lat - s.lat) * 111320.0;
      const xP = (p.lon - s.lon) * 111320.0 * cosLat;
      const yP = (p.lat - s.lat) * 111320.0;

      const lineLen2 = (xE - xS) * (xE - xS) + (yE - yS) * (yE - yS);
      if (lineLen2 === 0) {
        return Math.sqrt(xP * xP + yP * yP);
      }

      let t = ((xP - xS) * (xE - xS) + (yP - yS) * (yE - yS)) / lineLen2;
      t = Math.max(0, Math.min(1, t));

      const projX = xS + t * (xE - xS);
      const projY = yS + t * (yE - yS);

      const dx = xP - projX;
      const dy = yP - projY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const rdpRecurse = (pts, startIdx, endIdx) => {
      let maxDist = 0;
      let index = -1;

      for (let i = startIdx + 1; i < endIdx; i++) {
        const dist = getPerpendicularDistance(pts[i], pts[startIdx], pts[endIdx]);
        if (dist > maxDist) {
          maxDist = dist;
          index = i;
        }
      }

      if (maxDist > tolerance) {
        const results1 = rdpRecurse(pts, startIdx, index);
        const results2 = rdpRecurse(pts, index, endIdx);
        return results1.slice(0, results1.length - 1).concat(results2);
      } else {
        return [pts[startIdx], pts[endIdx]];
      }
    };

    return rdpRecurse(points, 0, points.length - 1);
  }
};
