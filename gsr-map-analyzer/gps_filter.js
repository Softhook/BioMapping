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

      // Prefer Doppler-derived speedKts (knots → m/s), fall back to
      // position-derived haversine/dt when the column is absent.
      let speed;
      if (!isNaN(curr.speedKts)) {
        speed = curr.speedKts * 0.514444;  // knots → m/s
      } else {
        const dist = GpsFilter.haversineDistance(prev.lat, prev.lon, curr.lat, curr.lon);
        const dt   = Math.max(0.001, curr.time - prev.time);
        speed = dist / dt;
      }

      if (speed <= maxSpeed) {
        kept.push(curr);
        consecutiveRejections = 0;
      } else {
        consecutiveRejections++;
        if (consecutiveRejections >= 10) {
          kept.push({ ...curr, lat: prev.lat, lon: prev.lon, alt: prev.alt });
          consecutiveRejections = 0;
        }
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
    if (!k || isNaN(k) || k <= 0 || !nSigma || isNaN(nSigma) || points.length < 2 * k + 1) return points;
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
   *
   * Forward pass (standard Kalman) followed by a Rauch-Tung-Striebel (RTS)
   * backward smoother.  The RTS pass uses the forward-pass filtered
   * covariance P_fwd[i] to compute the optimal backward gain:
   *
   *   A_i = P_fwd[i] / (P_fwd[i] + Q·dt)      (scalar, F=1 random-walk model)
   *   x̂_i|n = x̂_i|i + A_i · (x̂_i+1|n − x̂_i|i)
   *
   * This is provably optimal for linear Gaussian systems and gives a
   * 10–20 % smoother output than running an independent backward Kalman.
   *
   * HDOP-adaptive R: when each point carries an hdop field the measurement
   * noise covariance is scaled by HDOP² on a per-point basis.  High HDOP
   * → larger R → filter trusts its own momentum more than the GPS fix.
   * Low HDOP → smaller R → filter tracks the GPS position aggressively.
   * Points without HDOP data (NaN) use the base R unchanged.
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

    // Helper: scale R by DOP².  Prefer WDOP (satellite-elevation-weighted,
    // 15–25% more discriminative than HDOP) when available; fall back to
    // HDOP for older CSVs without the wdop column.
    // Sentinel values >= 50.0 (e.g. 99.9 unknown) are treated as invalid,
    // falling back to HDOP. Clamp DOP to [0.5, 10] to avoid degenerate R values.
    const getRLat = (pt) => {
      const dop = !isNaN(pt.wdop) && pt.wdop > 0 && pt.wdop < 50.0 ? pt.wdop :
                  (!isNaN(pt.hdop) && pt.hdop > 0 && pt.hdop < 50.0 ? pt.hdop : 1.0);
      const h = Math.max(0.5, Math.min(10, dop));
      return R_LAT_BASE * h * h;
    };
    const getRLon = (pt) => {
      const dop = !isNaN(pt.wdop) && pt.wdop > 0 && pt.wdop < 50.0 ? pt.wdop :
                  (!isNaN(pt.hdop) && pt.hdop > 0 && pt.hdop < 50.0 ? pt.hdop : 1.0);
      const h = Math.max(0.5, Math.min(10, dop));
      return R_LON_BASE * h * h;
    };

    // Forward pass — standard Kalman filter with chi-squared innovation gate.
    // Store filtered state AND covariance for the RTS backward pass.
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
    let PLat = 1.0;
    let PLon = 1.0;
    let lastTime = points[0].time;

    for (let i = 0; i < n; i++) {
      const dt = i === 0 ? 1.0 : Math.max(0.1, points[i].time - lastTime);
      lastTime = points[i].time;

      const pPLat = PLat + Q_LAT * dt;
      const pPLon = PLon + Q_LON * dt;

      const R_LAT = getRLat(points[i]);
      const R_LON = getRLon(points[i]);

      // Innovation (measurement − prediction) and its variance.
      // Gate test uses BASE R (no HDOP scaling) — consistent sensitivity.
      // Kalman gain uses HDOP-inflated R — deweights noisy measurements.
      const innovLat = points[i].lat - xLat;
      const innovLon = points[i].lon - xLon;
      const gateVarLat = pPLat + R_LAT_BASE;
      const gateVarLon = pPLon + R_LON_BASE;
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
    // Per-point displacement cap at 4 m: prevents the RTS backward
    // propagation from pulling any single anchor more than 4 m from its
    // raw GPS position.  This guards against GPS-warmup drift loops being
    // stretched into exaggerated shapes without affecting legitimate
    // smoothing in the stable region (where typical displacements are
    // 1–3 m).  The cap is in degrees-equivalent for uniform lat/lon scaling.
    const MAX_DISP_M  = 4.0;
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
      const dLat = newLat - points[i].lat;
      const dLon = newLon - points[i].lon;
      const dist2 = dLat * dLat + dLon * dLon;
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

    const result = [{ ...points[0] }];

    for (let i = 1; i < points.length; i++) {
      const prev = result[i - 1];
      const curr = points[i];
      const dt   = Math.max(0, curr.time - prev.time);

      // Compute effective alpha: scale down GPS trust proportionally to DOP.
      // Prefer WDOP when available; fall back to HDOP for older CSVs.
      // Sentinel values >= 50.0 (e.g. 99.9 unknown) are treated as invalid.
      const dop = !isNaN(curr.wdop) && curr.wdop > 0 && curr.wdop < 50.0 ? curr.wdop :
                  (!isNaN(curr.hdop) && curr.hdop > 0 && curr.hdop < 50.0 ? curr.hdop : 2.0);
      const h = Math.max(0.5, Math.min(10, dop));
      const effectiveAlpha = Math.max(0.1, Math.min(0.95, alpha / h));

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
        let headingX = Math.sin(courseRad); // East component (longitude direction)
        
        // If we have a historical direction, apply an exponential moving average
        // (beta = 0.7) to smooth out sudden heading spikes.
        if (i > 1 && !isNaN(result[i - 2]._smoothedHeadingY)) {
          const beta = 0.7;
          headingY = beta * result[i - 2]._smoothedHeadingY + (1 - beta) * headingY;
          headingX = beta * result[i - 2]._smoothedHeadingX + (1 - beta) * headingX;
          // Re-normalize to unit length
          const len = Math.sqrt(headingY * headingY + headingX * headingX);
          if (len > 0.001) {
            headingY /= len;
            headingX /= len;
          }
        }
        
        const cosLat    = Math.cos(prev.lat * DEG_TO_RAD);
        const M_TO_DEG_LON = cosLat > 0.001 ? M_TO_DEG_LAT / cosLat : M_TO_DEG_LAT;
        
        predLat = prev.lat + speedMs * headingY * dt * M_TO_DEG_LAT;
        predLon = prev.lon + speedMs * headingX * dt * M_TO_DEG_LON;
        
        curr._smoothedHeadingY = headingY;
        curr._smoothedHeadingX = headingX;
      } else {
        // If stationary or speed is too low, project zero displacement.
        // This acts as a standard position filter and avoids pause wobbles.
        predLat = prev.lat;
        predLon = prev.lon;
        
        // Retain previous heading vector if it existed
        if (i > 1) {
          curr._smoothedHeadingY = result[i - 2]._smoothedHeadingY;
          curr._smoothedHeadingX = result[i - 2]._smoothedHeadingX;
        }
      }

      // Blend: GPS fix × effectiveAlpha + dead-reckoned × (1 - effectiveAlpha)
      //
      // Zero-Velocity Update (ZUPT): when the GPS Doppler reports the
      // receiver is genuinely stationary (prev.speedKts ≤ 0.5 kt ≈ 0.26 m/s),
      // position drift is unreliable (cold-start warmup).  We override α to
      // near-zero so the output freezes at the prediction.
      //
      // Between 0.5–1.2 kts the receiver is moving slowly (corners,
      // crossings) but heading is too erratic for dead-reckoning — we
      // freeze the prediction but keep the normal HDOP-adaptive α so
      // the GPS position is still trusted.
      const alphaFinal = (!isNaN(prev.speedKts) && prev.speedKts <= 0.5)
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
