/**
 * HMM-Viterbi Map Matcher — global sequence map matching.
 *
 * Based on: Newson & Krumm 2009, "Hidden Markov Map Matching Through
 * Noise and Sparseness", ACM SIGSPATIAL GIS.
 *
 * Rather than snapping each GPS fix independently (greedy), this considers
 * the entire sequence at once.  For each GPS fix, up to MAX_CANDS candidate
 * road segments within MATCH_RADIUS are identified.  The Viterbi algorithm
 * then finds the globally most-likely path through those candidates by
 * maximising emission × transition probabilities in log-space.
 *
 * Emission probability:
 *   Gaussian centred on the road segment.  A fix 4 m from the road is far
 *   more likely than one 25 m away.
 *   log p(z | r) = −0.5·(d/σ)² − log(σ√2π)
 *
 * Transition probability:
 *   Exponential penalty on the discrepancy between the straight-line GPS
 *   distance and the approximate route distance between two candidate
 *   positions.  Staying on the same road = tiny discrepancy = high
 *   probability.  Jumping to a parallel street = large discrepancy
 *   (the route would need to go around the block) = low probability.
 *   log p(rⱼ | rᵢ) = −|d_GPS − d_route| / β − log β
 *
 * The combination of these two probabilities across the full sequence means:
 *   • One noisy GPS fix near a side street won't pull the path off the
 *     main road if all other fixes are clearly on the main road.
 *   • Genuine turns are detected correctly because the sequence of
 *     emission probabilities shifts to the new road after the turn.
 *
 * Design notes (pedestrian use):
 *   • Same-way d_route uses polygon tracing (_wayDistance); cross-way
 *     transit uses endpoint-junction routing (_routeDistViaJunction).
 *   • Cross-way routing only considers way endpoints — mid-segment
 *     T-junctions are not detected.  Ways that meet in the middle of
 *     another way will be treated as disconnected (1000 m penalty).
 *   • No explicit OSM-node connectivity check — endpoint proximity
 *     (≤ 5 m) serves as a proxy for a shared junction.  This is
 *     reliable for OSM data where junction nodes are snapped to the
 *     same coordinate.  Acceptable for pedestrian tracks where
 *     disconnected roads typically have large discrepancies.
 *   • MAX_GAP_S expects raw[i].time in seconds (not milliseconds or ISO
 *     strings).  If timestamps are in a different unit the chain-breaking
 *     threshold will be wrong.
 */
const MapMatcher = {

  /** GPS position error std dev (metres).  Newson & Krumm use 4.07 m. */
  SIGMA_M: 4.07,

  /** Exponential transition rate parameter (metres).
   *  Larger β → more tolerant of route-vs-GPS distance mismatches.
   *  3–5 m works well for walking-speed tracks. */
  BETA_M: 3.0,

  /** Route-distance penalty (metres) applied when two ways have no
   *  shared junction (disconnected).  With β = 3.0 this adds ≈ −334
   *  log-units, making cross-way transitions effectively impossible
   *  without a valid junction. */
  DISCONNECTED_PENALTY_M: 1000,

  /** Maximum candidate segments per GPS fix. */
  MAX_CANDS: 10,

  /** Candidate search radius (metres). */
  MATCH_RADIUS: 50,

  /** Time gap (seconds) between consecutive eval points above which the
   *  Viterbi transition is broken (sequence restarts from emission only). */
  MAX_GAP_S: 30,

  /**
   * Run HMM-Viterbi map matching over a sequence of GPS evaluation points.
   *
   * @param {Array}  evalPoints  — [{idx, lat, lon, nearby}] where nearby is the
   *                               spatial-index query result for that point.
   * @param {Array}  raw         — full raw data array (used for .time values).
   * @param {number} [matchRadius] — override for MATCH_RADIUS in metres.
   * @returns {Map<number, object>}  Map from raw-array index to snapped position:
   *   { lat, lon, roadLat, roadLon, alpha, wayId, dist }
   */
  match(evalPoints, raw, matchRadius) {
    const radius = (matchRadius != null) ? matchRadius : this.MATCH_RADIUS;
    const n = evalPoints.length;
    if (n === 0) return new Map();

    // ── 1. Build candidate lists ─────────────────────────────────────────
    const allCands = new Array(n);
    for (let i = 0; i < n; i++) {
      const pt = evalPoints[i];
      const rawPt = raw[pt.idx] || {};
      const speedMs = (!isNaN(rawPt.speedKts)) ? rawPt.speedKts * 0.514444 : NaN;
      const courseDeg = (!isNaN(rawPt.course)) ? rawPt.course : NaN;
      allCands[i] = this._getCandidates(pt.lat, pt.lon, pt.nearby, radius, speedMs, courseDeg);
    }

    // ── 2. Viterbi forward pass (log-probabilities) ──────────────────────
    // V[t] = Float64Array of log-probs for each candidate at time t.
    // B[t] = Int32Array of backpointers into allCands[t-1].
    const V = new Array(n);
    const B = new Array(n);

    // Initialise from first point using emission only.
    {
      const c0 = allCands[0];
      V[0] = new Float64Array(c0.length);
      for (let j = 0; j < c0.length; j++) {
        V[0][j] = this._logEmit(c0[j].dist, c0[j].bearingDiffRad);
      }
      B[0] = null;
    }

    for (let t = 1; t < n; t++) {
      const prevCands = allCands[t - 1];
      const currCands = allCands[t];
      const vPrev     = V[t - 1];

      if (currCands.length === 0) {
        V[t] = new Float64Array(0);
        B[t] = null;
        continue;
      }

      // If the GPS sequence has a large time gap, break the Markov chain —
      // the transition probability should not carry across a 30 s gap.
      const tPrev = (raw[evalPoints[t - 1].idx] || {}).time || 0;
      const tCurr = (raw[evalPoints[t    ].idx] || {}).time || 0;
      const broken = (tCurr - tPrev > this.MAX_GAP_S) || prevCands.length === 0;

      const gLat1 = evalPoints[t - 1].lat, gLon1 = evalPoints[t - 1].lon;
      const gLat2 = evalPoints[t    ].lat, gLon2 = evalPoints[t    ].lon;

      const vCurr = new Float64Array(currCands.length);
      const bCurr = new Int32Array(currCands.length).fill(-1);

      for (let j = 0; j < currCands.length; j++) {
        const logE = this._logEmit(currCands[j].dist, currCands[j].bearingDiffRad);

        if (broken) {
          // No valid transition — initialise from emission alone.
          vCurr[j] = logE;
          bCurr[j] = -1;
          continue;
        }

        let bestScore = -Infinity;
        let bestPrev  = -1;

        for (let i = 0; i < prevCands.length; i++) {
          if (!isFinite(vPrev[i])) continue;
          const logT = this._logTrans(
            prevCands[i], currCands[j],
            gLat1, gLon1, gLat2, gLon2
          );
          const score = vPrev[i] + logT;
          if (score > bestScore) {
            bestScore = score;
            bestPrev  = i;
          }
        }

        // If no valid predecessor was found (all vPrev[i] were non-finite
        // or prevCands was empty), restart from emission alone.  bestPrev
        // stays −1 so the backtrace detects the broken chain correctly.
        vCurr[j] = (bestPrev >= 0 ? bestScore : 0) + logE;
        bCurr[j] = bestPrev;
      }

      V[t] = vCurr;
      B[t] = bCurr;
    }

    // ── 3. Backtrace ─────────────────────────────────────────────────────
    const path = new Int32Array(n).fill(-1);

    // Best candidate at the last time step.
    {
      const vLast = V[n - 1];
      let best = -1, bestV = -Infinity;
      for (let j = 0; j < vLast.length; j++) {
        if (vLast[j] > bestV) { bestV = vLast[j]; best = j; }
      }
      path[n - 1] = best;
    }

    for (let t = n - 2; t >= 0; t--) {
      const nextIdx = path[t + 1];
      const bArr    = B[t + 1];

      // Safeguard against indexing errors and check if chain is broken
      if (nextIdx < 0 || bArr === null || nextIdx >= bArr.length || bArr[nextIdx] < 0 || allCands[t + 1].length === 0) {
        let best = -1, bestV = -Infinity;
        const vt = V[t];
        for (let j = 0; j < vt.length; j++) {
          if (vt[j] > bestV) { bestV = vt[j]; best = j; }
        }
        path[t] = best;
      } else {
        path[t] = bArr[nextIdx];
      }
    }

    // ── 4. Build result map (raw-array index → snapped position) ─────────
    const results = new Map();

    for (let t = 0; t < n; t++) {
      const pt    = evalPoints[t];
      const ci    = path[t];
      const cands = allCands[t];

      if (ci < 0 || cands.length === 0) {
        // No suitable road nearby — pass through the raw GPS fix unchanged.
        results.set(pt.idx, {
          lat: pt.lat, lon: pt.lon,
          roadLat: pt.lat, roadLon: pt.lon,
          alpha: 0, wayId: null, dist: Infinity
        });
        continue;
      }

      const cand  = cands[ci];
      const alpha = this._snapAlpha(cand.dist, radius);

      results.set(pt.idx, {
        lat:     alpha * cand.snapLat + (1 - alpha) * pt.lat,
        lon:     alpha * cand.snapLon + (1 - alpha) * pt.lon,
        roadLat: cand.snapLat,
        roadLon: cand.snapLon,
        alpha,
        wayId:   cand.wayId,
        dist:    cand.dist
      });
    }

    return results;
  },

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Find and rank candidate road segments for a GPS fix.
   * Projects the fix onto every segment of every highway way within
   * radiusM metres and returns up to MAX_CANDS, sorted by effective
   * distance (nearest road-class-adjusted segment first).
   */
  _getCandidates(lat, lon, nearby, radiusM, speedMs, courseDeg) {
    const cosLat = Math.cos(lat * Math.PI / 180);
    const MDEG   = 111320;

    const candidates = [];

    for (const geom of nearby) {
      if (geom.type !== 'way' || !geom.tags || !geom.tags.highway) continue;
      if (!geom.coordinates || geom.coordinates.length < 2) continue;

      const classPenalty = this._ROAD_CLASS_PENALTY[geom.tags.highway] || 0;
      const coords       = geom.coordinates;

      // Metre-equivalent Cartesian for the query point.
      const qx = lon * cosLat;
      const qy = lat;

      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const ax = a.lon * cosLat, ay = a.lat;
        const bx = b.lon * cosLat, by = b.lat;

        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;

        let t = 0;
        if (l2 > 1e-12) {
          t = ((qx - ax) * dx + (qy - ay) * dy) / l2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }

        const projX = ax + t * dx;
        const projY = ay + t * dy;

        const dLat = (projY - qy) * MDEG;
        const dLon = (projX - qx) * MDEG;
        const dist = Math.sqrt(dLat * dLat + dLon * dLon);

        if (dist > radiusM) continue;

        let effDist = dist + classPenalty;
        let bearingDiffRad = NaN;

        // Apply bearing penalty if user is moving to rank candidates better
        if (!isNaN(speedMs) && speedMs >= 0.3 && !isNaN(courseDeg)) {
          const courseRad = courseDeg * Math.PI / 180;
          const segBearing = this._segmentBearing(a.lat, a.lon, b.lat, b.lon);
          bearingDiffRad = Math.min(
            this._angularDiff(courseRad, segBearing),
            this._angularDiff(courseRad, segBearing + Math.PI)
          );
          // Scale bearing penalty (0.7 weight * normalized difference * 25m radius)
          effDist += 0.7 * (bearingDiffRad / Math.PI) * 25;
        }

        candidates.push({
          wayId:    geom.id,
          segIdx:   i,
          snapLat:  projY,
          snapLon:  projX / cosLat,
          dist,
          effDist,
          endpoints: [coords[0], coords[coords.length - 1]],
          coords:   coords,
          bearingDiffRad
        });
      }
    }

    candidates.sort((a, b) => a.effDist - b.effDist);
    return candidates.slice(0, this.MAX_CANDS);
  },

  /**
   * Log emission probability for a candidate.
   * Gaussian centred on the perpendicular distance from the GPS fix to the
   * road segment (Newson & Krumm 2009 §3.1).  Bearing is handled during
   * candidate ranking (effDist) but deliberately excluded here to avoid
   * double-counting.
   */
  _logEmit(dist, _bearingDiffRad) {
    const s = this.SIGMA_M;
    return -0.5 * (dist / s) * (dist / s) - Math.log(s * Math.sqrt(2 * Math.PI));
  },

  /**
   * Log transition probability (Newson & Krumm 2009).
   * Calculates route distance using topological road-network distance.
   */
  _logTrans(c1, c2, gLat1, gLon1, gLat2, gLon2) {
    const dGPS = this._haversineM(gLat1, gLon1, gLat2, gLon2);
    
    let dRoute;
    if (c1.wayId === c2.wayId) {
      dRoute = this._wayDistance(c1, c2);
    } else {
      dRoute = this._routeDistViaJunction(c1, c2);
    }

    let dt;
    if (dRoute === Infinity) {
      // Disconnected ways — apply a heavy topological penalty.
      dt = this.DISCONNECTED_PENALTY_M;
    } else {
      dt = Math.abs(dGPS - dRoute);
    }

    const beta = this.BETA_M;
    return -(dt / beta) - Math.log(beta);
  },

  /**
   * Trace exact path distance along a way's segments between two candidate snaps.
   */
  _wayDistance(c1, c2) {
    if (c1.wayId !== c2.wayId) return Infinity;
    const coords = c1.coords;
    const i = c1.segIdx;
    const j = c2.segIdx;

    if (i === j) {
      return this._haversineM(c1.snapLat, c1.snapLon, c2.snapLat, c2.snapLon);
    }

    let dist = 0;
    if (i < j) {
      dist += this._haversineM(c1.snapLat, c1.snapLon, coords[i + 1].lat, coords[i + 1].lon);
      for (let k = i + 1; k < j; k++) {
        dist += this._haversineM(coords[k].lat, coords[k].lon, coords[k + 1].lat, coords[k + 1].lon);
      }
      dist += this._haversineM(coords[j].lat, coords[j].lon, c2.snapLat, c2.snapLon);
    } else {
      dist += this._haversineM(c1.snapLat, c1.snapLon, coords[i].lat, coords[i].lon);
      for (let k = i - 1; k > j; k--) {
        dist += this._haversineM(coords[k + 1].lat, coords[k + 1].lon, coords[k].lat, coords[k].lon);
      }
      dist += this._haversineM(coords[j + 1].lat, coords[j + 1].lon, c2.snapLat, c2.snapLon);
    }
    return dist;
  },

  /**
   * Approximate route distance from a point on c1 to a point on c2,
   * travelling through their nearest shared junction.
   *
   * LIMITATION: Only considers way endpoints.  Mid-segment junctions
   * (e.g. a T-junction where one way ends in the middle of another)
   * are not detected and will return Infinity.
   */
  _routeDistViaJunction(c1, c2) {
    const ends1 = c1.endpoints;
    const ends2 = c2.endpoints;

    let minD = Infinity;
    let bestE1 = null;
    let bestE2 = null;

    for (const e1 of ends1) {
      for (const e2 of ends2) {
        const d = this._haversineM(e1.lat, e1.lon, e2.lat, e2.lon);
        if (d < minD) {
          minD = d;
          bestE1 = e1;
          bestE2 = e2;
        }
      }
    }

    // Ways are considered connected if their nearest endpoints are
    // within 5 m — tight enough that only genuine OSM junction nodes
    // (snapped to the same coordinate) pass.  Larger values risk
    // false connections between nearby but unconnected parallel roads.
    if (minD > 5) {
      return Infinity;
    }

    // Determine which endpoint of each way is the junction and compute
    // the distance from the candidate snap to that endpoint along the way.
    // Use value equality (lat + lon) rather than reference equality so
    // the comparison survives coordinate cloning.
    const isStart1 = bestE1.lat === c1.coords[0].lat && bestE1.lon === c1.coords[0].lon;
    const junctionCand1 = {
      wayId: c1.wayId,
      coords: c1.coords,
      segIdx: isStart1 ? 0 : c1.coords.length - 2,
      snapLat: bestE1.lat,
      snapLon: bestE1.lon
    };
    const d1 = this._wayDistance(c1, junctionCand1);

    const isStart2 = bestE2.lat === c2.coords[0].lat && bestE2.lon === c2.coords[0].lon;
    const junctionCand2 = {
      wayId: c2.wayId,
      coords: c2.coords,
      segIdx: isStart2 ? 0 : c2.coords.length - 2,
      snapLat: bestE2.lat,
      snapLon: bestE2.lon
    };
    const d2 = this._wayDistance(junctionCand2, c2);

    return d1 + minD + d2;
  },

  /**
   * Snap blend weight α ∈ [0, 1]:
   *   α = 1.0  when d = 0 (fix is right on the road)
   *   α = 0.0  when d ≥ radiusM (fix is at or beyond the search boundary)
   * Cosine roll-off in between (smooth, no discontinuity).
   */
  _snapAlpha(dist, radiusM) {
    if (dist <= 0)         return 1.0;
    if (dist >= radiusM)   return 0.0;
    return 0.5 * (1 + Math.cos(Math.PI * dist / radiusM));
  },

  _haversineM(lat1, lon1, lat2, lon2) {
    return GeoUtils.haversineMeters(lat1, lon1, lat2, lon2);
  },

  _segmentBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    return Math.atan2(y, x);
  },

  _angularDiff(a, b) {
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  },

  /**
   * Road-class score adjustment (metres).
   * Negative values boost pedestrian infrastructure; positive values
   * penalise high-speed roads that a pedestrian is unlikely to be on.
   */
  _ROAD_CLASS_PENALTY: {
    'motorway':      20,  'trunk':        15,  'primary':      10,
    'secondary':      5,  'tertiary':      3,
    'residential':    0,  'unclassified':  0,  'living_street': 0,
    'service':        0,  'track':        -2,  'cycleway':     -3,
    'pedestrian':    -5,  'steps':        -2,  'bridleway':    -2,
    'footway':       -8,  'path':         -8
  }
};
