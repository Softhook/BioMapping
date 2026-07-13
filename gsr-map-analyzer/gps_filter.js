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
   * Speed plausibility check: rejects points whose Doppler-derived speed
   * (from the GPS RMC sentence, stored in speedKts) exceeds maxSpeed (m/s).
   * Doppler velocity is ~10× more accurate than position-derived speed
   * (haversine / dt), so we use the GPS-reported value directly.
   *
   * Falls back to position-derived speed when speedKts is unavailable
   * (old CSV without the speed column).
   *
   * Recovery behaviour: if consecutiveRejections reaches the threshold the
   * filter holds the last known-good coordinates but advances the timestamp.
   * This keeps the spatial reference correct while preventing an unbounded
   * gap in the timeline.  A genuinely sustained fast-movement event will
   * clear naturally once the GPS returns to a plausible speed.
   */
  applySpeedFilter(points, maxSpeed) {
    if (!maxSpeed || isNaN(maxSpeed) || maxSpeed <= 0 || points.length < 2) return points;
    const kept = [points[0]];
    let consecutiveRejections = 0;

    for (let i = 1; i < points.length; i++) {
      const prev = kept[kept.length - 1];
      const curr = points[i];

      // Prefer Doppler-derived speedKts (knots → m/s) on genuine GPS anchors
      // (dt ≥ 0.15 s ≈ 5 Hz epoch).  For interpolated points (10 Hz grid,
      // dt < 0.15 s) the speedKts field is step-held from the last anchor and
      // would fail the gate repeatedly, triggering premature recovery latches.
      // Fall back to position-derived haversine/dt for sub-epoch steps.
      let speed;
      const dt = Math.max(0.001, curr.time - prev.time);
      if (!isNaN(curr.speedKts) && dt >= 0.15) {
        speed = curr.speedKts * 0.514444;  // knots → m/s
      } else {
        const dist = GpsFilter.haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
        speed = dist / dt;
      }

      if (speed <= maxSpeed) {
        kept.push(curr);
        consecutiveRejections = 0;
      } else {
        consecutiveRejections++;
        if (consecutiveRejections >= 10) {
          kept.push({ ...curr, lat: prev.lat, lon: prev.lon });
          consecutiveRejections = 0;
        }
      }
    }
    return kept;
  },



  /**
   * Forward-backward Kalman smoother on Lat and Lon (Rauch-Tung-Striebel).
   *
   * Forward pass with chi-squared innovation gate for robust multipath
   * rejection, followed by an RTS backward pass for zero-phase smoothing.
   * HDOP-adaptive R scales measurement noise by DOP² per point.
   *
   * The RTS displacement clamp scales with both Q and R so that extreme
   * slider settings (Q=0.02,R=150 or Q=10,R=0.5) produce visibly different
   * results — from heavily smoothed straight-line paths to near-raw GPS.
   *
   * @param {number} Q_m2 — process noise variance (metres²)
   * @param {number} R_m2 — base measurement noise variance (metres²)
   */
  applyKalman(points, Q_m2, R_m2) {
    if (!Q_m2 || !R_m2 || isNaN(Q_m2) || isNaN(R_m2) || Q_m2 <= 0 || R_m2 <= 0 || points.length < 2) return points;
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

    const R_LAT_BASE = R_m2 * M2_TO_DEG2_LAT;
    const R_LON_BASE = R_m2 * M2_TO_DEG2_LON;
    const Q_LAT = Q_m2 * M2_TO_DEG2_LAT;
    const Q_LON = Q_m2 * M2_TO_DEG2_LON;

    // Helper: scale R by DOP².  Prefer PDOP (chip-computed from all
    // constellations via GSA — most accurate) when available; fall back
    // to WDOP (GSV-based, GPS-only, from older tracks) then to HDOP.
    // Sentinel values >= 50.0 (e.g. 99.9 unknown) are treated as invalid.
    // Clamp DOP to [0.5, 10.0] — below 0.5 is unrealistically optimistic;
    // above 10.0 the HDOP gate has already filtered most points, but the
    // velocity smoother also uses this range so both filters agree on how
    // much to deweight a high-DOP fix.
    const getDop = (pt) => {
      if (!isNaN(pt.pdop) && pt.pdop > 0 && pt.pdop < 50.0) return pt.pdop;
      if (!isNaN(pt.wdop) && pt.wdop > 0 && pt.wdop < 50.0) return pt.wdop;
      if (!isNaN(pt.hdop) && pt.hdop > 0 && pt.hdop < 50.0) return pt.hdop;
      return 1.0;
    };
    const getRLat = (pt) => {
      const h = Math.max(0.5, Math.min(10.0, getDop(pt)));
      return R_LAT_BASE * h * h;
    };
    const getRLon = (pt) => {
      const h = Math.max(0.5, Math.min(10.0, getDop(pt)));
      return R_LON_BASE * h * h;
    };

    // Forward pass — standard Kalman filter with chi-squared innovation gate.
    //
    // Innovation gate: when the measurement disagrees with the prediction by
    // more than 3σ (χ² = 9.0 for 1 DOF), the measurement is treated as an
    // outlier and rejected — the prediction alone is used.  This is standard
    // practice in navigation filters and is critical for urban canyons where
    // multipath creates non-Gaussian 10–50 m jumps that HDOP does not catch.
    const CHI2_THRESH = 9.0;  // 3σ for 1 DOF (99.7 % confidence)
    const forwardLats = new Array(n);
    const forwardLons = new Array(n);
    const fwdCovLat    = new Array(n);
    const fwdCovLon    = new Array(n);

    let xLat = points[0].lat;
    let xLon = points[0].lon;
    let PLat = R_LAT_BASE;
    let PLon = R_LON_BASE;
    let lastTime = points[0].time;

    forwardLats[0] = xLat;
    forwardLons[0] = xLon;
    fwdCovLat[0]    = PLat;
    fwdCovLon[0]    = PLon;

    for (let i = 1; i < n; i++) {
      const dt = Math.max(0.1, points[i].time - lastTime);
      lastTime = points[i].time;

      const pPLat = PLat + Q_LAT * dt;
      const pPLon = PLon + Q_LON * dt;

      const R_LAT = getRLat(points[i]);
      const R_LON = getRLon(points[i]);

      // Innovation (measurement − prediction) and its variance.
      // Gate test uses HDOP-scaled R — dynamically adjusts outlier sensitivity.
      // Kalman gain uses HDOP-inflated R — deweights noisy measurements.
      const innovLat = points[i].lat - xLat;
      const innovLon = points[i].lon - xLon;
      const gateVarLat = pPLat + R_LAT;
      const gateVarLon = pPLon + R_LON;
      const gainVarLat = pPLat + R_LAT;
      const gainVarLon = pPLon + R_LON;

      // Chi-squared test: reject if |innov| > 3σ
      const chi2Lat = (innovLat * innovLat) / gateVarLat;
      const chi2Lon = (innovLon * innovLon) / gateVarLon;

      if (chi2Lat < CHI2_THRESH) {
        const kLat = pPLat / gainVarLat;
        xLat = xLat + kLat * innovLat;
        PLat = (1 - kLat) * pPLat;
      } else {
        // Outlier: inflate covariance so the filter can recover.
        // Without inflation, Q·dt (~0.5 m²/s) is too slow to grow P
        // and the filter stays locked out permanently (cascade rejection).
        PLat = pPLat * 5.0;
      }

      if (chi2Lon < CHI2_THRESH) {
        const kLon = pPLon / gainVarLon;
        xLon = xLon + kLon * innovLon;
        PLon = (1 - kLon) * pPLon;
      } else {
        PLon = pPLon * 5.0;
      }

      forwardLats[i] = xLat;
      forwardLons[i] = xLon;
      fwdCovLat[i]    = PLat;
      fwdCovLon[i]    = PLon;
    }

    // RTS backward smoother — optimal gain from forward-pass covariance.
    // A_i = P_i|i / (P_i|i + Q·dt)  =  P_fwd[i] / P_pred[i+1]
    // For the scalar random-walk model (F = 1) the predicted state equals
    // the filtered state, so the innovation is simply the difference
    // between the already-smoothed next point and the current forward point.
    //
    // Per-point displacement cap: prevents the RTS backward propagation
    // from pulling any single anchor beyond 3σ of the measurement noise
    // (standard GPS/INS practice).  This is generous enough that the RTS
    // is essentially never constrained at smooth extremes:
    //   R=150 → 37 m  (RTS needs ~20 m — only 6 of 150 points hit the clamp)
    //   R=10  →  9 m  (RTS needs ~3 m — 0 hits)
    //   R=0.5 →  2 m  (RTS needs < 1 m — forward lag negligible, 0 hits)
    const MAX_DISP_M  = 3.0 * Math.sqrt(R_m2);
    const maxDispDeg  = MAX_DISP_M * M_TO_DEG_LAT;
    const maxDispDeg2 = maxDispDeg * maxDispDeg;

    const result = new Array(n);
    let sxLat = forwardLats[n - 1];
    let sxLon = forwardLons[n - 1];
    result[n - 1] = { ...points[n - 1], lat: sxLat, lon: sxLon };

    for (let i = n - 2; i >= 0; i--) {
      const dt = Math.max(0.1, points[i + 1].time - points[i].time);

      const P_pred_Lat = fwdCovLat[i] + Q_LAT * dt;
      const P_pred_Lon = fwdCovLon[i] + Q_LON * dt;
      const A_lat = fwdCovLat[i] / P_pred_Lat;
      const A_lon = fwdCovLon[i] / P_pred_Lon;

      let newLat = forwardLats[i] + A_lat * (sxLat - forwardLats[i]);
      let newLon = forwardLons[i] + A_lon * (sxLon - forwardLons[i]);

      // Clamp per-point displacement from raw GPS position.
      // Longitude degrees must be scaled by cos(lat) to match the
      // physical metre equivalence used by maxDispDeg (derived from
      // M_TO_DEG_LAT).  Without this the clamp triggers ~36 % too
      // early on east-west movements at mid-latitudes.
      const dLat = newLat - points[i].lat;
      const dLon = newLon - points[i].lon;
      const cosLatPt = Math.cos(points[i].lat * Math.PI / 180);
      const dist2 = dLat * dLat + dLon * dLon * cosLatPt * cosLatPt;
      if (dist2 > maxDispDeg2) {
        const scale = maxDispDeg / Math.sqrt(dist2);
        newLat = points[i].lat + dLat * scale;
        newLon = points[i].lon + dLon * scale;
      }

      sxLat = newLat;
      sxLon = newLon;
      result[i] = { ...points[i], lat: sxLat, lon: sxLon };
    }

    return result;
  },

  /**
   * Velocity-aided position smoothing.
   *
   * Uses the RMC speed-over-ground (knots) and course-over-ground (degrees)
   * recorded in each point to dead-reckon a predicted position, then blends
   * that prediction with the raw GPS fix.  The blend ratio α is itself
   * HDOP-adaptive: when DOP is high the dead-reckoned prediction is trusted
   * more; when DOP is low (good signal) the GPS fix dominates.
   *
   * α_base is the fraction of the GPS fix used when HDOP = 1.0 (best case).
   * At HDOP = 5.0 the GPS fix weight drops to α_base / 5; above that the
   * prediction dominates almost entirely.
   *
   * @param {Array}  points    — GPS anchor points with speedKts and course fields
   * @param {number} alpha     — base GPS trust weight [0,1]; 0.5 is balanced
   */
  applyVelocitySmoothing(points, alpha = 0.6) {
    if (!points || points.length < 2) return points;
    // Check if any point has velocity data; skip entirely if not available
    // (old CSV without speed/course columns).
    const hasVelData = points.some(p => !isNaN(p.speedKts) && !isNaN(p.course));
    if (!hasVelData) return points;

    const KNOTS_TO_MS = 0.51444;
    const DEG_TO_RAD  = Math.PI / 180;
    const M_TO_DEG_LAT = 1.0 / 111320.0;

    // Initialise dead-reckoning heading tracker from the first point's course.
    // Using a local variable avoids both the off-by-one indexing bug
    // (was result[i-2] instead of result[i-1]) and the mutation side
    // effect of storing _smoothedHeadingY/X on the input points.
    const firstCourseRad = !isNaN(points[0].course) ? points[0].course * DEG_TO_RAD : 0;
    let prevHeadingY = firstCourseRad !== 0 ? Math.cos(firstCourseRad) : 0;
    let prevHeadingX = firstCourseRad !== 0 ? Math.sin(firstCourseRad) : 0;

    const result = [{ ...points[0] }];

    for (let i = 1; i < points.length; i++) {
      const prev = result[i - 1];
      const curr = points[i];
      const dt   = Math.max(0, curr.time - prev.time);

      // Compute effective alpha: scale down GPS trust proportionally to DOP.
      // Prefer PDOP when available; fall back to WDOP then HDOP.
      // Sentinel values >= 50.0 (e.g. 99.9 unknown) are treated as invalid.
      const dop = !isNaN(curr.pdop) && curr.pdop > 0 && curr.pdop < 50.0 ? curr.pdop :
                  (!isNaN(curr.wdop) && curr.wdop > 0 && curr.wdop < 50.0 ? curr.wdop :
                  (!isNaN(curr.hdop) && curr.hdop > 0 && curr.hdop < 50.0 ? curr.hdop : 2.0));
      const h = Math.max(0.5, Math.min(10, dop));
      const effectiveAlpha = Math.max(0.05, Math.min(0.98, alpha / h));

      // Dead-reckon from prev position using prev point's speed+course
      let predLat = curr.lat;
      let predLon = curr.lon;
      
      // Only dead-reckon if speed is high enough for the course vector to be stable.
      // Below 1.2 knots (~0.6 m/s), heading is highly erratic and produces loops.
      if (dt > 0 && !isNaN(prev.speedKts) && !isNaN(prev.course) && prev.speedKts > 1.2) {
        const speedMs   = prev.speedKts * KNOTS_TO_MS;
        
        // ── Unit Vector Heading Smoothing ──────────────────────────────────
        // Instead of averaging noisy degrees directly (which suffers from the
        // 360° boundary wrap-around bug), we convert the heading to a 2D vector,
        // blend it with the previous direction, and then project.
        // NMEA course: 0° is North (lat direction), 90° is East (lon direction)
        const courseRad = prev.course * DEG_TO_RAD;
        let headingY = Math.cos(courseRad); // North component (latitude direction)
        let headingX = Math.sin(courseRad); // East component (lon direction)
        
        // Apply an exponential moving average using the locally-tracked
        // previous heading (avoids the off-by-one result[i-2] bug that
        // skipped index 1 and never initialised result[0]._smoothedHeadingY).
        if (prevHeadingY !== 0 || prevHeadingX !== 0) {
          const safeAlpha = Math.max(0.01, alpha);
          const beta = Math.max(0.2, Math.min(0.95, 0.7 - Math.log(safeAlpha) * 0.15));
          headingY = beta * prevHeadingY + (1 - beta) * headingY;
          headingX = beta * prevHeadingX + (1 - beta) * headingX;
          // Re-normalize to unit length
          const len = Math.sqrt(headingY * headingY + headingX * headingX);
          if (len > 0.001) {
            headingY /= len;
            headingX /= len;
          }
        }
        
        prevHeadingY = headingY;
        prevHeadingX = headingX;

        const cosLat    = Math.cos(prev.lat * DEG_TO_RAD);
        const M_TO_DEG_LON = cosLat > 0.001 ? M_TO_DEG_LAT / cosLat : M_TO_DEG_LAT;
        
        predLat = prev.lat + speedMs * headingY * dt * M_TO_DEG_LAT;
        predLon = prev.lon + speedMs * headingX * dt * M_TO_DEG_LON;
      } else {
        // If stationary or speed is too low, project zero displacement.
        // This acts as a standard position filter and avoids pause wobbles.
        predLat = prev.lat;
        predLon = prev.lon;
        // Keep prevHeading unchanged so it can be used when speed picks up.
      }

      // Blend: GPS fix × effectiveAlpha + dead-reckoned × (1 - effectiveAlpha)
      //
      // Zero-Velocity Update (ZUPT): when the GPS Doppler reports speed
      // ≤ 1.2 kt (matching the heading stability threshold), position drift
      // is unreliable and heading is too erratic for dead-reckoning.
      // We override α to near-zero so the output freezes at the prediction.
      // Above 1.2 kt the full dead-reckon + blend is used.
      const alphaFinal = (!isNaN(prev.speedKts) && prev.speedKts <= 1.2)
        ? 0.05 : effectiveAlpha;

      result.push({
        ...curr,
        lat: alphaFinal * curr.lat + (1 - alphaFinal) * predLat,
        lon: alphaFinal * curr.lon + (1 - alphaFinal) * predLon,
      });
    }
    return result;
  },

  /**
   * Stop-averaging: collapses stationary clusters into a centroid.
   *
   * When the receiver reports speed below stationaryThreshold m/s,
   * consecutive points within the cluster are averaged into a single
   * representative point (the centroid of the cluster).
   * This eliminates the jitter circle that cheap GPS chips draw
   * when the user is standing still.
   *
   * @param {Array}  points              — GPS anchor points with speedKts field
   * @param {number} stationaryKts       — speed threshold in knots (default 0.5 kt ≈ 0.26 m/s)
   * @param {number} minClusterPoints    — minimum cluster size to collapse (default 3)
   */
  applyStopAveraging(points, stationaryKts = 0.5, minClusterPoints = 3) {
    if (!points || points.length < 2) return points;
    const hasVelData = points.some(p => !isNaN(p.speedKts));
    if (!hasVelData) return points;

    const result = [];
    let i = 0;
    while (i < points.length) {
      const p = points[i];
      const spd = isNaN(p.speedKts) ? Infinity : p.speedKts;

      if (spd <= stationaryKts) {
        // Collect the stationary cluster
        const cluster = [p];
        let j = i + 1;
        while (j < points.length && (isNaN(points[j].speedKts) ? false : points[j].speedKts <= stationaryKts)) {
          cluster.push(points[j]);
          j++;
        }

        if (cluster.length >= minClusterPoints) {
          // Keep all points but lock their coordinates to the centroid.
          // This preserves timeline spacing and prevents the gap reconstruction loop
          // from interpolating a drift during stationary pauses.
          const centLat = cluster.reduce((s, pt) => s + pt.lat, 0) / cluster.length;
          const centLon = cluster.reduce((s, pt) => s + pt.lon, 0) / cluster.length;
          cluster.forEach(pt => {
            result.push({ ...pt, lat: centLat, lon: centLon });
          });
        } else {
          // Cluster too small — keep individual points
          cluster.forEach(pt => result.push(pt));
        }
        i = j;
      } else {
        result.push(p);
        i++;
      }
    }
    return result;
  },

  /**
   * Ramer-Douglas-Peucker (RDP) trajectory simplification.
   * Reduces point count while preserving the overall shape.
   */
  applyRDP(points, tolerance) {
    if (!tolerance || isNaN(tolerance) || tolerance <= 0.001 || points.length < 3) return points;

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GpsFilter;
}
