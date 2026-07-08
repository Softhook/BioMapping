/**
 * Road Snapping Engine — map-matching for GPS multipath correction.
 *
 * Pure functions called from osm_enrichment.js's evaluation loop.
 * Does NOT iterate points itself; the loop lives in enrichTrack().
 *
 * Design:
 *   - Metre-equivalent projection via internal Cartesian math
 *   - Bearing-constrained candidate ranking (heading penalty)
 *   - Transition plausibility check (Newson & Krumm 2009):
 *     rejects impossible road-to-road jumps
 *   - Confidence gate: refuses to snap when two roads are equally plausible
 *   - Minimum run-length gate: requires 3+ consecutive points within 12 m
 *   - Ramped alpha: smooth 0→1 entry over 5 steps, hard 1.0 lock, smooth 1→0 exit
 *   - Sticky way-ID prevents oscillation between parallel roads
 *   - Bearing penalty suppressed at < 0.3 m/s; way-ID never frozen
 */

const RoadSnapper = {

  /** Ramp over this many consecutive evaluation points at entry/exit. */
  RAMP_STEPS: 5,

  /** Require this many consecutive points within snap-IN before engaging. */
  MIN_RUN: 3,

  /**
   * Maximum allowed discrepancy (metres) between the haversine distance
   * between two consecutive GPS points and the approximate route distance
   * between their snapped positions on different ways (Newson & Krumm).
   */
  TRANSITION_DELTA: 30,

  /**
   * Confidence ratio.  The best candidate must be at least this much
   * better (× effective distance) than the second-best, or the snap
   * is refused entirely (ambiguous intersection).
   */
  CONFIDENCE_RATIO: 0.7,

  /**
   * Absolute confidence threshold (metres).  If the best candidate is
   * within this distance the confidence ratio is waived — we're
   * clearly close enough to that road.
   */
  CONFIDENCE_ABS: 5,

  /**
   * Snap a single GPS fix to the nearest highway segment.
   *
   * @param {number}  lat        — GPS latitude
   * @param {number}  lon        — GPS longitude
   * @param {number}  speedMs    — Doppler-derived speed in m/s (NaN if unknown)
   * @param {number}  courseDeg  — GPS course over ground in degrees (NaN if unknown)
   * @param {Array}   nearby     — spatial-index query result
   * @param {object}  state      — mutable state carried across calls:
   *   { wayId, prevWayId, prevGpsLat, prevGpsLon, prevSnapLat, prevSnapLon,
   *     wasSnapped, rampStep, hystTimer }
   * @param {object}  [params]   — overrides for SNAP constants
   * @returns {{ snapLat, snapLon, roadLat, roadLon, wayId, alpha, dist }}
   */
  snapOne(lat, lon, speedMs, courseDeg, nearby, state, params) {
    const p = params || {};
    const RAD_IN   = p.radiusIn   != null ? p.radiusIn   : GSR_CONST.SNAP.RADIUS_IN;
    const RAD_OUT  = p.radiusOut  != null ? p.radiusOut  : GSR_CONST.SNAP.RADIUS_OUT;
    const HEAD_W   = p.headingW   != null ? p.headingW   : GSR_CONST.SNAP.HEADING_W;
    const H_MARGIN = p.hystMargin != null ? p.hystMargin : GSR_CONST.SNAP.HYST_MARGIN;
    const H_SEC    = p.hystSec    != null ? p.hystSec    : GSR_CONST.SNAP.HYST_SEC;
    const SPD_GATE = p.speedGate  != null ? p.speedGate  : GSR_CONST.SNAP.SPEED_GATE;

    const moving = !isNaN(speedMs) && speedMs >= SPD_GATE;

    // ── Find best candidate road segment ───────────────────────────────
    const highwayWays = RoadSnapper._filterHighwayWays(nearby);
    if (highwayWays.length === 0) {
      return RoadSnapper._releaseSnap(lat, lon, state);
    }

    // Bearing penalty: suppress at low speed (course is stale/repeated)
    const effectiveHeadingW = moving ? HEAD_W : 0;
    const effectiveCourse = moving ? courseDeg : NaN;

    const candidates = RoadSnapper._rankCandidates(
      lat, lon, effectiveCourse, highwayWays, effectiveHeadingW
    );
    if (candidates.length === 0) {
      return RoadSnapper._releaseSnap(lat, lon, state);
    }

    // ── Confidence gate: refuse snap if ambiguous ──────────────────────
    let confident = true;  // single candidate or one clearly better
    if (candidates.length >= 2) {
      const bestD = candidates[0].effDist;
      const secondD = candidates[1].effDist;
      if (bestD >= RoadSnapper.CONFIDENCE_ABS &&
          secondD > 0 && bestD / secondD > RoadSnapper.CONFIDENCE_RATIO) {
        // Two roads similarly distant — ambiguous, don't snap
        confident = false;
        return RoadSnapper._releaseSnap(lat, lon, state);
      }
    }

    // ── Hysteresis: prefer locked way ──────────────────────────────────
    let best = candidates[0];
    if (state && state.wayId != null) {
      const locked = candidates.find(c => c.wayId === state.wayId);
      if (locked) {
        // Check if an alternative is significantly closer
        const alt = candidates.find(c => c.wayId !== state.wayId);
        if (alt) {
          const margin = locked.effDist - alt.effDist;
          if (margin > -H_MARGIN) {
            // Locked way is still best or within margin — keep it
            best = locked;
          } else if (margin <= -H_MARGIN) {
            // Alternative is clearly closer — check sustained
            if (!state.hystTimer || state.hystTimer.wayId !== alt.wayId) {
              state.hystTimer = { wayId: alt.wayId, startTime: Date.now() / 1000 };
            }
            if ((Date.now() / 1000) - state.hystTimer.startTime >= H_SEC) {
              best = alt;
              state.wayId = alt.wayId;
              state.hystTimer = null;
            } else {
              best = locked;  // not sustained yet — stay locked
            }
          }
        } else {
          best = locked;
        }
      }
    }

    // ── Transition plausibility (Newson & Krumm 2009) ─────────────────
    // When the chosen candidate is on a different way than the previous
    // point, verify the jump is physically possible along the road network.
    if (state && state.prevWayId != null && best.wayId !== state.prevWayId &&
        state.prevGpsLat != null && state.prevSnapLat != null) {

      // Build way lookup for the transition check
      const wayMap = new Map();
      for (const w of highwayWays) wayMap.set(w.id, w);

      const prevWay = wayMap.get(state.prevWayId);
      const currWay = wayMap.get(best.wayId);

      if (prevWay && currWay) {
        const implausible = RoadSnapper._transitionImplausible(
          state.prevGpsLat, state.prevGpsLon, lat, lon,
          state.prevSnapLat, state.prevSnapLon,
          best.snapLat, best.snapLon,
          prevWay, currWay
        );

        if (implausible) {
          // Jump is physically impossible — force stay on locked way
          const lockedInCandidates = candidates.find(c => c.wayId === state.prevWayId);
          if (lockedInCandidates) {
            best = lockedInCandidates;
          } else {
            // Locked way not even nearby — release snap entirely
            return RoadSnapper._releaseSnap(lat, lon, state);
          }
        }
      }
    }

    // Update way-ID — always, regardless of speed.
    // The bearing penalty is already suppressed at low speed;
    // freezing way-ID prevents legitimate transitions after stops.
    if (state) {
      // Save previous position for transition plausibility check
      state.prevWayId   = state.wayId;
      state.prevGpsLat  = lat;
      state.prevGpsLon  = lon;
      state.prevSnapLat = best.snapLat;
      state.prevSnapLon = best.snapLon;
      state.wayId = best.wayId;
    }

    // ── Minimum run-length gate + ramped alpha ─────────────────────────
    const inRange = best.dist < RAD_IN;
    const wasLocked = state && state.wasSnapped;

    if (!state) {
      // Stateless mode — simple cosine roll-off
      const alpha = inRange ? RoadSnapper._cosineRolloff(best.dist, RAD_IN) : 0;
      return RoadSnapper._buildResult(lat, lon, best, alpha);
    }

    // Initialise ramp step tracker
    if (state.rampStep == null) state.rampStep = 0;

    let alpha;

    if (wasLocked) {
      // ── Currently locked on a road ───────────────────────────────────
      if (best.dist < RAD_OUT) {
        // Still on road — stay at full snap
        alpha = 1.0;
        state.rampStep = RoadSnapper.RAMP_STEPS;  // keep ramp at max
      } else {
        // Leaving road — ramp down
        state.rampStep = Math.max(0, state.rampStep - 1);
        alpha = state.rampStep / RoadSnapper.RAMP_STEPS;
        if (alpha <= 0) {
          state.wasSnapped = false;
          state.wayId = null;
          alpha = 0;
        }
      }
    } else if (inRange) {
      // ── Not locked, but within snap-IN range — count consecutive hits ─
      //     Seed rampStep from any prior soft-pull alpha so the transition
      //     is continuous: soft pull → ramp entry with no jump.
      if (state.rampStep === 0 && (state._lastSoftAlpha || 0) > 0) {
        state.rampStep = Math.max(1, Math.round(state._lastSoftAlpha * RoadSnapper.RAMP_STEPS));
      }
      state.rampStep = Math.min(state.rampStep + 1, RoadSnapper.RAMP_STEPS);
      if (state.rampStep >= RoadSnapper.MIN_RUN) {
        // Sustained proximity — lock on and ramp up smoothly
        state.wasSnapped = true;
        const rampSpan = RoadSnapper.RAMP_STEPS - RoadSnapper.MIN_RUN + 1;
        alpha = (state.rampStep - RoadSnapper.MIN_RUN + 1) / rampSpan;
      } else if (state._lastSoftAlpha > 0) {
        // First ramp point coming from soft pull — carry the soft alpha
        // forward so the transition is seamless
        alpha = state._lastSoftAlpha;
        state._lastSoftAlpha = 0;
      } else {
        alpha = 0;
      }
    } else if (confident && best.dist < RAD_OUT) {
      // ── Not locked, beyond snap-IN but within snap-OUT, and confident ─
      //     about which road.  Apply cosine pull at 70 % strength —
      //     enough to visibly nudge multipath-drifting points back toward
      //     the road.  Saves alpha for ramp seeding when entering snap-in.
      alpha = RoadSnapper._cosineRolloff(best.dist, RAD_OUT);
      state._lastSoftAlpha = alpha;
      state.rampStep = 0;
    } else {
      // ── Not locked, not in range ─────────────────────────────────────
      state.rampStep = 0;
      state._lastSoftAlpha = 0;
      alpha = 0;
    }

    return RoadSnapper._buildResult(lat, lon, best, alpha);
  },

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** Reset snap state and return a no-snap result. */
  _releaseSnap(lat, lon, state) {
    if (state) {
      state.wasSnapped  = false;
      state.wayId       = null;
      state.prevWayId   = null;
      state.prevGpsLat  = null;
      state.prevGpsLon  = null;
      state.prevSnapLat = null;
      state.prevSnapLon = null;
      state.rampStep    = 0;
    }
    return { snapLat: lat, snapLon: lon, roadLat: lat, roadLon: lon,
             wayId: null, alpha: 0, dist: Infinity };
  },

  /** Build the return object from a candidate and alpha. */
  _buildResult(lat, lon, best, alpha) {
    const snapLat = alpha * best.snapLat + (1 - alpha) * lat;
    const snapLon = alpha * best.snapLon + (1 - alpha) * lon;
    return {
      snapLat, snapLon,
      roadLat: best.snapLat, roadLon: best.snapLon,
      wayId: best.wayId, alpha, dist: best.dist
    };
  },

  /**
   * Extract way-type geometries with highway tags from a spatial-index
   * query result.
   */
  _filterHighwayWays(nearby) {
    const ways = [];
    for (const geom of nearby) {
      if (geom.type === 'way' && geom.tags && geom.tags.highway && geom.coordinates && geom.coordinates.length >= 2) {
        ways.push(geom);
      }
    }
    return ways;
  },

  /**
   * Road-class penalty (metres) for walking-speed users.  Positive values
   * penalise roads the user is unlikely to be on; negative values boost
   * pedestrian-friendly infrastructure.
   */
  _ROAD_CLASS_PENALTY: {
    'motorway':      20,  'trunk':        15,  'primary':      10,
    'secondary':      5,  'tertiary':      3,
    'residential':    0,  'unclassified':  0,  'living_street': 0,
    'service':        0,  'track':        -2,  'cycleway':     -3,
    'pedestrian':    -5,  'steps':        -2,  'bridleway':    -2,
    'footway':       -8,  'path':         -8
  },

  /**
   * Project the GPS fix onto every segment of every candidate way,
   * apply the bearing penalty and road-class preference, and return
   * candidates sorted by effective distance (best first).
   */
  _rankCandidates(lat, lon, courseDeg, highwayWays, headingWeight) {
    const candidates = [];
    const hasCourse = !isNaN(courseDeg);
    const courseRad = hasCourse ? courseDeg * Math.PI / 180 : NaN;

    for (const way of highwayWays) {
      const coords = way.coordinates;
      const roadClass = (way.tags && way.tags.highway) ? way.tags.highway : null;
      const classPenalty = RoadSnapper._ROAD_CLASS_PENALTY[roadClass] || 0;

      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const proj = RoadSnapper._projectToSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);

        // Bearing penalty (bidirectional/undirected comparison)
        let effDist = proj.dist + classPenalty;
        if (hasCourse && headingWeight > 0) {
          const segBearing = RoadSnapper._segmentBearing(a.lat, a.lon, b.lat, b.lon);
          const delta = Math.min(
            RoadSnapper._angularDiff(courseRad, segBearing),
            RoadSnapper._angularDiff(courseRad, segBearing + Math.PI)
          );
          effDist += headingWeight * (delta / Math.PI) * GSR_CONST.SNAP.RADIUS_OUT;
        }

        candidates.push({
          wayId: way.id,
          wayTags: way.tags,
          snapLat: proj.snapLat,
          snapLon: proj.snapLon,
          dist: proj.dist,
          effDist
        });
      }
    }

    candidates.sort((a, b) => a.effDist - b.effDist);
    return candidates;
  },

  /**
   * Project a GPS point onto a line segment using metre-equivalent
   * coordinates (equirectangular approximation).
   *
   * Delegates the distance computation to OSMEnricher.distanceToSegment()
   * and extracts the projection point from the internal t parameter.
   */
  _projectToSegment(lat, lon, lat1, lon1, lat2, lon2) {
    const cosLat = Math.cos(((lat + lat1 + lat2) / 3) * Math.PI / 180);
    const METERS_PER_DEG = 111320;

    // Metre-equivalent Cartesian coordinates
    const x  = lon  * cosLat, y  = lat;
    const x1 = lon1 * cosLat, y1 = lat1;
    const x2 = lon2 * cosLat, y2 = lat2;

    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;

    let t = 0;
    if (l2 > 1e-12) {
      t = ((x - x1) * dx + (y - y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
    }

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    const snapLat = projY;
    const snapLon = projX / cosLat;

    // Distance in metres
    const dLat = (projY - y) * METERS_PER_DEG;
    const dLon = (projX - x) * METERS_PER_DEG;
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);

    return { snapLat, snapLon, t, dist };
  },

  /**
   * Forward azimuth (bearing) of segment A→B in radians [0, 2π).
   */
  _segmentBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

    return Math.atan2(y, x);
  },

  /**
   * C¹-continuous cosine roll-off blend weight.
   *   α = 0.5 * (1 + cos(π * d / radius))
   * Returns 0 when d >= radius.
   */
  _cosineRolloff(dist, radius) {
    if (dist >= radius) return 0;
    if (dist <= 0) return 1;
    return 0.5 * (1 + Math.cos(Math.PI * dist / radius));
  },

  /**
   * Smallest absolute angular difference, wrapped to [0, π].
   */
  _angularDiff(a, b) {
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  },

  /**
   * Check whether a transition from a snap on prevWay to a snap on
   * currWay is physically implausible (Newson & Krumm 2009).
   *
   * A transition is implausible if the GPS points moved only a short
   * distance but the road-network distance between the two snapped
   * positions is much larger — i.e. you'd need to teleport.
   */
  _transitionImplausible(prevGpsLat, prevGpsLon, currGpsLat, currGpsLon,
                          prevSnapLat, prevSnapLon, currSnapLat, currSnapLon,
                          prevWay, currWay) {
    // Same way — always plausible (walking along the same road)
    if (prevWay.id === currWay.id) return false;

    const gpsDist = RoadSnapper._haversineM(
      prevGpsLat, prevGpsLon, currGpsLat, currGpsLon);

    // If GPS moved far enough, the user could have physically reached
    // a different road — transition is plausible
    if (gpsDist >= RoadSnapper.TRANSITION_DELTA) return false;

    // Short GPS movement to a different way:
    // only plausible if the ways are connected (share a junction)
    if (RoadSnapper._waysAreConnected(prevWay, currWay)) {
      // Connected — but the route must go through the junction.
      // Use the actual path: prevSnap → junction → currSnap.
      const routeDist = RoadSnapper._routeDistViaJunction(
        prevSnapLat, prevSnapLon, currSnapLat, currSnapLon, prevWay, currWay);
      return Math.abs(routeDist - gpsDist) > RoadSnapper.TRANSITION_DELTA;
    }

    // Short GPS movement to an unconnected way — implausible teleport
    return true;
  },

  /**
   * Check whether two OSM ways share an endpoint within 15 metres
   * (heuristic for road-network junction).
   */
  _waysAreConnected(wayA, wayB) {
    const cA = wayA.coordinates, cB = wayB.coordinates;
    if (!cA || !cB || cA.length < 2 || cB.length < 2) return false;
    const endsA = [cA[0], cA[cA.length - 1]];
    const endsB = [cB[0], cB[cB.length - 1]];
    for (const ea of endsA) {
      for (const eb of endsB) {
        if (RoadSnapper._haversineM(ea.lat, ea.lon, eb.lat, eb.lon) <= 15) return true;
      }
    }
    return false;
  },

  /**
   * Approximate route distance from a point on prevWay to a point on
   * currWay, travelling through their nearest shared junction.
   * Used by the transition plausibility check for connected ways.
   */
  _routeDistViaJunction(prevSnapLat, prevSnapLon, currSnapLat, currSnapLon,
                         prevWay, currWay) {
    const cA = prevWay.coordinates, cB = currWay.coordinates;
    const endsA = [cA[0], cA[cA.length - 1]];
    const endsB = [cB[0], cB[cB.length - 1]];

    // Find the closest pair of endpoints (the junction)
    let minD = Infinity, jnLat, jnLon;
    for (const ea of endsA) {
      for (const eb of endsB) {
        const d = RoadSnapper._haversineM(ea.lat, ea.lon, eb.lat, eb.lon);
        if (d < minD) {
          minD = d;
          jnLat = (ea.lat + eb.lat) / 2;
          jnLon = (ea.lon + eb.lon) / 2;
        }
      }
    }

    // Route = prevSnap → junction + junction → currSnap
    const d1 = RoadSnapper._haversineM(prevSnapLat, prevSnapLon, jnLat, jnLon);
    const d2 = RoadSnapper._haversineM(currSnapLat, currSnapLon, jnLat, jnLon);
    return d1 + d2;
  },

  /**
   * Haversine distance in metres (lightweight).
   */
  _haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
};
