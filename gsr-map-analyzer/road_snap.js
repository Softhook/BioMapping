/**
 * Road Snapping Engine — map-matching for GPS multipath correction.
 *
 * Pure functions called from osm_enrichment.js's evaluation loop.
 * Does NOT iterate points itself; the loop lives in enrichTrack().
 *
 * Design:
 *   - Metre-equivalent projection via internal Cartesian math
 *   - Bearing-constrained candidate ranking (heading penalty)
 *   - Minimum run-length gate: requires 3+ consecutive points near same road
 *   - Ramped alpha: smooth 0→1 entry, hard 1.0 lock, smooth 1→0 exit
 *   - Sticky way-ID prevents oscillation between parallel roads
 *   - Speed gate freezes way-ID at < 0.3 m/s
 */

const RoadSnapper = {

  /** Ramp over this many consecutive evaluation points at entry/exit. */
  RAMP_STEPS: 3,

  /** Require this many consecutive points within snap-IN before engaging. */
  MIN_RUN: 2,

  /**
   * Snap a single GPS fix to the nearest highway segment.
   *
   * @param {number}  lat        — GPS latitude
   * @param {number}  lon        — GPS longitude
   * @param {number}  speedMs    — Doppler-derived speed in m/s (NaN if unknown)
   * @param {number}  courseDeg  — GPS course over ground in degrees (NaN if unknown)
   * @param {Array}   nearby     — spatial-index query result
   * @param {object}  state      — mutable state carried across calls:
   *   { wayId, wasSnapped, rampStep, hystTimer }
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

    const candidates = RoadSnapper._rankCandidates(
      lat, lon, moving ? courseDeg : NaN, highwayWays, HEAD_W
    );
    if (candidates.length === 0) {
      return RoadSnapper._releaseSnap(lat, lon, state);
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

    // Update way-ID (only when moving)
    if (state && moving) {
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
      state.rampStep = Math.min(state.rampStep + 1, RoadSnapper.RAMP_STEPS);
      if (state.rampStep >= RoadSnapper.MIN_RUN) {
        // Sustained proximity — lock on and ramp up
        state.wasSnapped = true;
        alpha = state.rampStep / RoadSnapper.RAMP_STEPS;
      } else {
        // Not enough consecutive hits yet — no snap
        alpha = 0;
      }
    } else {
      // ── Not locked, not in range ─────────────────────────────────────
      state.rampStep = 0;
      alpha = 0;
    }

    return RoadSnapper._buildResult(lat, lon, best, alpha);
  },

  // ── Internal helpers ─────────────────────────────────────────────────────

  /** Reset snap state and return a no-snap result. */
  _releaseSnap(lat, lon, state) {
    if (state) {
      state.wasSnapped = false;
      state.wayId = null;
      state.rampStep = 0;
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
   * Project the GPS fix onto every segment of every candidate way,
   * apply the bearing penalty, and return candidates sorted by
   * effective distance (best first).
   */
  _rankCandidates(lat, lon, courseDeg, highwayWays, headingWeight) {
    const candidates = [];
    const hasCourse = !isNaN(courseDeg);
    const courseRad = hasCourse ? courseDeg * Math.PI / 180 : NaN;

    for (const way of highwayWays) {
      const coords = way.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const proj = RoadSnapper._projectToSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);

        // Bearing penalty (bidirectional/undirected comparison)
        let effDist = proj.dist;
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
  }
};
