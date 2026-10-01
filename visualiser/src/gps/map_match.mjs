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
 *   distance and the route distance between two candidate positions.
 *   Staying on the same road = tiny discrepancy = high probability.
 *   Jumping to a parallel street = large discrepancy (the route would need
 *   to go around the block) = low probability.  Added to it: how far the
 *   step between the two snap points differs, as a vector, from the GPS
 *   step (_stepMismatchM).  Distance alone can't tell a snap point that
 *   stands still, or steps back as far as the walker stepped forward, from
 *   one that follows the walker; the step's direction can.
 *   log p(rⱼ | rᵢ) = −(|d_GPS − d_route| + |Δgps − Δsnap|) / β − log β
 *
 * The combination of these two probabilities across the full sequence means:
 *   • One noisy GPS fix near a side street won't pull the path off the
 *     main road if all other fixes are clearly on the main road.
 *   • Genuine turns are detected correctly because the sequence of
 *     emission probabilities shifts to the new road after the turn.
 *
 * Design notes (pedestrian use):
 *   • d_route is the shortest walk through the path network built from the
 *     candidate ways (_buildGraph): ways join wherever they share a node,
 *     at their ends or part-way along, as OSM junctions do.  Shared nodes
 *     are found by coordinate (Junctions.nodeKey), since OSM puts a
 *     junction's ways on the same node.  A way end left dangling within
 *     JOIN_GAP_M of another way's node is joined to it too.
 *   • Routes longer than the GPS step plus a margin aren't searched for
 *     (see _routeLimitM): they count as no route (DISCONNECTED_PENALTY_M).
 *   • MAX_GAP_S expects raw[i].time in seconds (not milliseconds or ISO
 *     strings).  If timestamps are in a different unit the chain-breaking
 *     threshold will be wrong.
 */
import { GSR_CONST } from '../core/constants.mjs';
import { GeoUtils } from './geo_utils.mjs';
import { Junctions } from './junctions.mjs';

export const MapMatcher = {
  /** GPS position error std dev (metres).  Newson & Krumm use 4.07 m. */
  SIGMA_M: 4.07,

  /** Exponential transition rate parameter (metres).
   *  Larger β → more tolerant of route-vs-GPS distance mismatches.
   *  3–5 m works well for walking-speed tracks. */
  BETA_M: 3.0,

  /** Route-distance penalty (metres) applied when no route joins two
   *  candidates within the search limit.  With β = 3.0 this adds ≈ −334
   *  log-units, making such transitions effectively impossible. */
  DISCONNECTED_PENALTY_M: 1000,

  /** A way end this close (m) to another way's node is treated as joined to
   *  it: paths are sometimes drawn up to a road without sharing its node. */
  JOIN_GAP_M: 5,

  /** Walking-speed limit on a snapped step (see _allowedStepM): the chip's
   *  own Doppler speed plus this margin (m/s)... */
  SPEED_MARGIN_MS: 1.0,

  /** ...plus this much distance (m), for corners and the 3 m thinning. */
  SPEED_SLACK_M: 5,

  /** Extra distance (m) searched beyond the GPS step and both candidates'
   *  distance from their fixes (see _routeLimitM). */
  ROUTE_SLACK_M: 20,

  /** Maximum candidate segments per GPS fix. */
  MAX_CANDS: 10,

  /** Candidate search radius (metres). */
  MATCH_RADIUS: 50,

  /** Time gap (seconds) between consecutive eval points above which the
   *  Viterbi transition is broken (sequence restarts from emission only),
   *  provided the walker also moved more than MAX_GAP_MOVE_M across it. */
  MAX_GAP_S: 30,

  /** A long gap only breaks the chain when the walker moved this far (m)
   *  across it.  Eval points are thinned to one per 3 m, so a walker
   *  standing still for 30 s leaves a long gap with no movement; restarting
   *  there let the match flip to another road at every pause.  (GPS dropouts
   *  are bridged in the smoothed path, so they don't leave gaps here.) */
  MAX_GAP_MOVE_M: 30,

  /** Minimum fix separation (m) for a bearing to be trusted. */
  MIN_CHORD_M: 6,

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
    const radius = matchRadius != null ? matchRadius : this.MATCH_RADIUS;
    const n = evalPoints.length;
    if (n === 0) return new Map();

    const allCands = this._collectAllCandidates(evalPoints, raw, radius);
    const graph = this._buildGraph(allCands, evalPoints);
    const { V, B } = this._viterbiForward(evalPoints, raw, allCands, graph);
    const path = this._viterbiBacktrace(V, B, allCands);
    return this._buildResultsMap(evalPoints, path, allCands, radius);
  },

  /**
   * 1. Build candidate road segment lists for each evaluation point.
   */
  _collectAllCandidates(evalPoints, raw, radius) {
    const n = evalPoints.length;
    const allCands = new Array(n);
    for (let i = 0; i < n; i++) {
      const pt = evalPoints[i];
      const rawPt = raw[pt.idx] || {};
      let speedMs = !isNaN(rawPt.speedKts) ? rawPt.speedKts * 0.514444 : NaN;
      // Prefer the heading implied by the fixes either side over the
      // reported course: it's available wherever there is movement and isn't
      // hostage to a stale or missing RMC course field.
      const chord = this._chordBearingDeg(evalPoints, i);
      const courseDeg = !isNaN(chord)
        ? chord
        : !isNaN(rawPt.course)
          ? rawPt.course
          : NaN;
      // Only stand in for a missing speed: a reported near-zero speed must
      // still suppress the heading term (wander while stationary can span
      // several metres and would otherwise fake a direction).
      if (!isNaN(chord) && isNaN(speedMs)) speedMs = 1;
      allCands[i] = this._getCandidates(
        pt.lat,
        pt.lon,
        pt.nearby,
        radius,
        speedMs,
        courseDeg,
      );
    }
    return allCands;
  },

  /**
   * 2. Viterbi forward pass (log-probabilities) across the sequence.
   * V[t] = Float64Array of log-probs for each candidate at time t.
   * B[t] = Int32Array of backpointers into allCands[t-1].
   */
  _viterbiForward(evalPoints, raw, allCands, graph) {
    const n = evalPoints.length;
    const V = new Array(n);
    const B = new Array(n);

    // Initialise from first point using emission only.
    const c0 = allCands[0];
    V[0] = new Float64Array(c0.length);
    for (let j = 0; j < c0.length; j++) {
      V[0][j] = this._logEmit(c0[j].dist, c0[j].bearingDiffRad);
    }
    B[0] = null;

    for (let t = 1; t < n; t++) {
      const prevCands = allCands[t - 1];
      const currCands = allCands[t];
      const vPrev = V[t - 1];

      if (currCands.length === 0) {
        V[t] = new Float64Array(0);
        B[t] = null;
        continue;
      }

      const gLat1 = evalPoints[t - 1].lat;
      const gLon1 = evalPoints[t - 1].lon;
      const gLat2 = evalPoints[t].lat;
      const gLon2 = evalPoints[t].lon;
      const dGPS = this._haversineM(gLat1, gLon1, gLat2, gLon2);

      // A long time gap across which the walker also moved far breaks the
      // Markov chain: the transition can't be judged across it.
      const tPrev = raw[evalPoints[t - 1].idx]?.time || 0;
      const tCurr = raw[evalPoints[t].idx]?.time || 0;
      const broken =
        (tCurr - tPrev > this.MAX_GAP_S && dGPS > this.MAX_GAP_MOVE_M) ||
        prevCands.length === 0;

      const vCurr = new Float64Array(currCands.length);
      const bCurr = new Int32Array(currCands.length).fill(-1);
      // Network distances from each previous candidate, searched on first use.
      const limit = this._routeLimitM(dGPS, prevCands, currCands);
      const routes = new Array(prevCands.length);
      const allowedM = this._allowedStepM(
        raw,
        evalPoints[t - 1].idx,
        evalPoints[t].idx,
      );

      for (let j = 0; j < currCands.length; j++) {
        const logE = this._logEmit(
          currCands[j].dist,
          currCands[j].bearingDiffRad,
        );

        if (broken) {
          // No valid transition — initialise from emission alone.
          vCurr[j] = logE;
          bCurr[j] = -1;
          continue;
        }

        let bestScore = -Infinity;
        let bestPrev = -1;

        for (let i = 0; i < prevCands.length; i++) {
          if (!isFinite(vPrev[i])) continue;
          if (!routes[i])
            routes[i] = this._routesFrom(graph, prevCands[i], limit);
          const logT = this._logTrans(
            dGPS,
            this._routeDist(prevCands[i], currCands[j], routes[i]),
            this._stepMismatchM(
              prevCands[i],
              currCands[j],
              gLat1,
              gLon1,
              gLat2,
              gLon2,
            ),
            allowedM,
          );
          const score = vPrev[i] + logT;
          if (score > bestScore) {
            bestScore = score;
            bestPrev = i;
          }
        }

        // If no valid predecessor was found (all vPrev[i] were non-finite
        // or prevCands was empty), restart from emission alone. bestPrev
        // stays −1 so the backtrace detects the broken chain correctly.
        vCurr[j] = (bestPrev >= 0 ? bestScore : 0) + logE;
        bCurr[j] = bestPrev;
      }

      V[t] = vCurr;
      B[t] = bCurr;
    }

    return { V, B };
  },

  /**
   * 3. Backtrace through backpointers to find the most probable sequence.
   */
  _viterbiBacktrace(V, B, allCands) {
    const n = V.length;
    const path = new Int32Array(n).fill(-1);

    // Best candidate at the last time step.
    const vLast = V[n - 1];
    let best = -1;
    let bestV = -Infinity;
    for (let j = 0; j < vLast.length; j++) {
      if (vLast[j] > bestV) {
        bestV = vLast[j];
        best = j;
      }
    }
    path[n - 1] = best;

    for (let t = n - 2; t >= 0; t--) {
      const nextIdx = path[t + 1];
      const bArr = B[t + 1];

      // Safeguard against indexing errors and check if chain is broken
      if (
        nextIdx < 0 ||
        bArr === null ||
        nextIdx >= bArr.length ||
        bArr[nextIdx] < 0 ||
        allCands[t + 1].length === 0
      ) {
        let bestCandidate = -1;
        let bestCandidateScore = -Infinity;
        const vt = V[t];
        for (let j = 0; j < vt.length; j++) {
          if (vt[j] > bestCandidateScore) {
            bestCandidateScore = vt[j];
            bestCandidate = j;
          }
        }
        path[t] = bestCandidate;
      } else {
        path[t] = bArr[nextIdx];
      }
    }

    return path;
  },

  /**
   * 4. Build result map (raw-array index → snapped position).
   */
  _buildResultsMap(evalPoints, path, allCands, radius) {
    const n = evalPoints.length;
    const results = new Map();

    for (let t = 0; t < n; t++) {
      const pt = evalPoints[t];
      const ci = path[t];
      const cands = allCands[t];

      if (ci < 0 || cands.length === 0) {
        // No suitable road nearby — pass through the raw GPS fix unchanged.
        results.set(pt.idx, {
          lat: pt.lat,
          lon: pt.lon,
          roadLat: pt.lat,
          roadLon: pt.lon,
          alpha: 0,
          wayId: null,
          dist: Infinity,
        });
        continue;
      }

      const cand = cands[ci];
      const alpha = this._snapAlpha(cand.dist, radius);

      results.set(pt.idx, {
        lat: alpha * cand.snapLat + (1 - alpha) * pt.lat,
        lon: alpha * cand.snapLon + (1 - alpha) * pt.lon,
        roadLat: cand.snapLat,
        roadLon: cand.snapLon,
        alpha,
        wayId: cand.wayId,
        dist: cand.dist,
      });
    }

    return results;
  },

  // ─── Internal helpers ────────────────────────────────────────────────────

  /**
   * Bearing (deg) of travel around eval point i, from the nearest fix at
   * least MIN_CHORD_M behind to the nearest at least MIN_CHORD_M ahead
   * (looking ≤ 8 fixes each way).  NaN when the walker hasn't moved enough.
   */
  _chordBearingDeg(pts, i) {
    const far = (dir) => {
      for (let k = 1; k <= 8; k++) {
        const j = i + dir * k;
        if (j < 0 || j >= pts.length) break;
        if (
          this._haversineM(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon) >=
          this.MIN_CHORD_M
        ) {
          return pts[j];
        }
      }
      return null;
    };
    const a = far(-1) || pts[i];
    const b = far(1) || pts[i];
    if (
      a === b ||
      this._haversineM(a.lat, a.lon, b.lat, b.lon) < this.MIN_CHORD_M
    ) {
      return NaN;
    }
    const br = this._segmentBearing(a.lat, a.lon, b.lat, b.lon);
    return ((br * 180) / Math.PI + 360) % 360;
  },

  /**
   * True when OSM says this road's pavements are mapped as their own ways
   * (sidewalk=separate, or sidewalk:left/right/both=separate) and it has no
   * other pavement — so a walker is never in its carriageway except to cross,
   * and crossings are mapped as ways too.
   */
  _pavementsMappedSeparately(tags) {
    const side = (k) => {
      const v = tags[`sidewalk:${k}`] ?? tags['sidewalk:both'];
      if (v != null) return v;
      const s = tags.sidewalk;
      if (s === 'separate') return 'separate';
      if (s === 'both' || s === 'yes' || s === k) return 'yes';
      return 'no';
    };
    const left = side('left');
    const right = side('right');
    return (
      (left === 'separate' || right === 'separate') &&
      left !== 'yes' &&
      right !== 'yes'
    );
  },

  /**
   * Find and rank candidate road segments for a GPS fix.
   * Projects the fix onto every segment of every highway way within
   * radiusM metres and returns up to MAX_CANDS, sorted by effective
   * distance (nearest road-class-adjusted segment first).
   */
  _getCandidates(lat, lon, nearby, radiusM, speedMs, courseDeg) {
    const candidates = [];

    for (const geom of nearby) {
      if (geom.type !== 'way' || !geom.tags || !geom.tags.highway) continue;
      if (!geom.coordinates || geom.coordinates.length < 2) continue;
      // A walker beside this road is on one of its mapped pavements, not in
      // the carriageway.  It stays in the path network (_buildGraph) for routing.
      if (this._pavementsMappedSeparately(geom.tags)) continue;

      const classPenalty = this._ROAD_CLASS_PENALTY[geom.tags.highway] || 0;
      const coords = geom.coordinates;

      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i],
          b = coords[i + 1];
        const proj = GeoUtils.projectPointToSegment(
          lat,
          lon,
          a.lat,
          a.lon,
          b.lat,
          b.lon,
        );
        const dist = proj.distance;

        if (dist > radiusM) continue;

        let effDist = dist + classPenalty;
        let bearingDiffRad = NaN;

        // Apply bearing penalty if user is moving to rank candidates better.
        // HEADING_W/SPEED_GATE come from GSR_CONST.SNAP (constants.js) — the single
        // source of truth for these two tuning values, so they can't drift out of sync
        // with each other the way they previously did as separately-hardcoded literals here.
        const speedGate = GSR_CONST.SNAP.SPEED_GATE;
        const headingW = GSR_CONST.SNAP.HEADING_W;
        if (!isNaN(speedMs) && speedMs >= speedGate && !isNaN(courseDeg)) {
          const courseRad = (courseDeg * Math.PI) / 180;
          const segBearing = this._segmentBearing(a.lat, a.lon, b.lat, b.lon);
          bearingDiffRad = Math.min(
            this._angularDiff(courseRad, segBearing),
            this._angularDiff(courseRad, segBearing + Math.PI),
          );
          // Scale bearing penalty (headingW weight * normalised difference * 25m radius)
          effDist += headingW * (bearingDiffRad / Math.PI) * 25;
        }

        candidates.push({
          wayId: geom.id,
          segIdx: i,
          snapLat: proj.lat,
          snapLon: proj.lon,
          dist,
          effDist,
          coords: coords,
          bearingDiffRad,
        });
      }
    }

    candidates.sort((a, b) => a.effDist - b.effDist);
    return candidates.slice(0, this.MAX_CANDS);
  },

  /**
   * Log emission probability for a candidate.
   * Gaussian centred on the perpendicular distance from the GPS fix to the
   * road segment (Newson & Krumm 2009 §3.1), plus a heading-mismatch penalty so a
   * side road crossed at right angles can't win at a junction.
   */
  _logEmit(dist, bearingDiffRad) {
    const s = this.SIGMA_M;
    return (
      -0.5 * (dist / s) * (dist / s) -
      Math.log(s * Math.sqrt(2 * Math.PI)) -
      this._headingPenalty(bearingDiffRad)
    );
  },

  /**
   * Log-penalty for travelling across a segment rather than along it.
   * Without this, passing a side-road junction lets the path dip onto the
   * side road whenever the fix is momentarily closer to it than to the main
   * road, even though the course never changed.  A dead zone absorbs course
   * noise and curved geometry; the cap keeps a wrong course from vetoing an
   * otherwise obvious road.  NaN (stationary / no course) → no penalty.
   */
  _headingPenalty(bearingDiffRad) {
    if (isNaN(bearingDiffRad)) return 0;
    const cfg = GSR_CONST.SNAP;
    const dead = (cfg.HEADING_DEAD_DEG * Math.PI) / 180;
    const sigma = (cfg.HEADING_SIGMA_DEG * Math.PI) / 180;
    const cap = cfg.HEADING_MAX_PENALTY;
    const excess = Math.max(0, bearingDiffRad - dead) / sigma;
    return Math.min(cap, 0.5 * excess * excess);
  },

  /**
   * Log transition probability (Newson & Krumm 2009): exponential in the
   * mismatch between the GPS step and the walk through the path network,
   * plus the step mismatch (see _stepMismatchM), plus how far the walk
   * through the network goes beyond what walking speed allows (allowedM,
   * see _allowedStepM).  dRoute = Infinity (no route found) takes
   * DISCONNECTED_PENALTY_M.
   */
  _logTrans(dGPS, dRoute, stepM = 0, allowedM = Infinity) {
    const dt =
      dRoute === Infinity
        ? this.DISCONNECTED_PENALTY_M
        : Math.abs(dGPS - dRoute) + Math.max(0, dRoute - allowedM);
    const beta = this.BETA_M;
    return -((dt + stepM) / beta) - Math.log(beta);
  },

  /**
   * Furthest (m) a walker plausibly went between raw rows i0 and i1: the
   * chip's mean Doppler speed over those rows, plus SPEED_MARGIN_MS, times
   * the time between them, plus SPEED_SLACK_M.  Doppler speed comes from the
   * signal's frequency, not the position, so it stays sound where buildings
   * throw the positions out; a snapped step that runs far ahead of it is the
   * matcher swapping paths, not the walker moving.  Rows without a speed
   * fall back to the default Max Speed.
   */
  _allowedStepM(raw, i0, i1) {
    const dt = (raw[i1]?.time ?? 0) - (raw[i0]?.time ?? 0);
    if (!(dt > 0)) return Infinity;
    let sum = 0;
    let n = 0;
    for (let i = i0; i <= i1; i++) {
      const kts = raw[i]?.speedKts;
      if (Number.isFinite(kts) && kts >= 0) {
        sum += kts * 0.514444;
        n++;
      }
    }
    const speed = n > 0 ? sum / n : GSR_CONST.GPS_DEFAULT.maxSpeed;
    return (speed + this.SPEED_MARGIN_MS) * dt + this.SPEED_SLACK_M;
  },

  /**
   * How far (m) the step from c1's snap point to c2's differs, as a vector,
   * from the GPS step between the two fixes.  0 when the snap moves exactly
   * as the walker did (e.g. a road parallel to the walk at a constant
   * offset).  A snap point held at a corner while the walker carries on, or
   * stepping sideways onto another road, costs the distance it falls out of
   * step.  Flat-earth metres: steps are a few metres long.
   */
  _stepMismatchM(c1, c2, gLat1, gLon1, gLat2, gLon2) {
    const my = GeoUtils.METERS_PER_DEG_LAT;
    const mx = my * Math.cos((gLat1 * Math.PI) / 180);
    const dx = (gLon2 - gLon1 - (c2.snapLon - c1.snapLon)) * mx;
    const dy = (gLat2 - gLat1 - (c2.snapLat - c1.snapLat)) * my;
    return Math.hypot(dx, dy);
  },

  /**
   * Path network of every way that appears as a candidate or near an eval
   * point (a road skipped as a candidate still links the paths around it): one graph node
   * per distinct coordinate (Junctions.nodeKey), so ways that share a node —
   * at their ends or part-way along — are joined there.  A dangling way end
   * is also joined to the nearest node of another way within JOIN_GAP_M.
   * @returns {Map<string, {lat:number, lon:number, edges:Array<{key:string, m:number}>, ways:Set}>}
   */
  _buildGraph(allCands, evalPoints = []) {
    const ways = new Map();
    for (const cands of allCands) {
      for (const c of cands)
        if (!ways.has(c.wayId)) ways.set(c.wayId, c.coords);
    }
    for (const pt of evalPoints) {
      for (const geom of pt.nearby || []) {
        if (
          geom.type === 'way' &&
          geom.tags?.highway &&
          geom.coordinates?.length >= 2 &&
          !ways.has(geom.id)
        ) {
          ways.set(geom.id, geom.coordinates);
        }
      }
    }
    const nodes = new Map();
    const nodeAt = (p) => {
      const key = Junctions.nodeKey(p.lat, p.lon);
      let n = nodes.get(key);
      if (!n) {
        n = { lat: p.lat, lon: p.lon, edges: [], ways: new Set() };
        nodes.set(key, n);
      }
      return key;
    };
    const link = (ka, kb, m) => {
      nodes.get(ka).edges.push({ key: kb, m });
      nodes.get(kb).edges.push({ key: ka, m });
    };
    for (const [id, coords] of ways) {
      let prev = nodeAt(coords[0]);
      nodes.get(prev).ways.add(id);
      for (let i = 1; i < coords.length; i++) {
        const key = nodeAt(coords[i]);
        nodes.get(key).ways.add(id);
        if (key !== prev) {
          const a = coords[i - 1];
          const b = coords[i];
          link(prev, key, this._haversineM(a.lat, a.lon, b.lat, b.lon));
        }
        prev = key;
      }
    }

    // Grid of nodes (cells ≈ 11 m tall, ≥ JOIN_GAP_M wide at UK latitudes)
    // so each dangling end only checks its neighbourhood.
    const CELL = 0.0001;
    const cellKey = (lat, lon) =>
      `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
    const grid = new Map();
    for (const [key, n] of nodes) {
      const ck = cellKey(n.lat, n.lon);
      if (!grid.has(ck)) grid.set(ck, []);
      grid.get(ck).push(key);
    }
    for (const [id, coords] of ways) {
      for (const p of [coords[0], coords[coords.length - 1]]) {
        const key = Junctions.nodeKey(p.lat, p.lon);
        const n = nodes.get(key);
        if (n.ways.size > 1) continue;
        let best = null;
        let bestM = this.JOIN_GAP_M;
        const ci = Math.floor(p.lat / CELL);
        const cj = Math.floor(p.lon / CELL);
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            for (const k2 of grid.get(`${ci + di},${cj + dj}`) || []) {
              const n2 = nodes.get(k2);
              if (n2.ways.has(id)) continue;
              const m = this._haversineM(p.lat, p.lon, n2.lat, n2.lon);
              if (m <= bestM) {
                bestM = m;
                best = k2;
              }
            }
          }
        }
        if (best) link(key, best, bestM);
      }
    }
    return nodes;
  },

  /**
   * How far to search the network for routes between two steps' candidates:
   * the GPS step, plus the furthest either step's candidates sit from their
   * fix (the route runs between snap points, not fixes), plus ROUTE_SLACK_M.
   */
  _routeLimitM(dGPS, prevCands, currCands) {
    let far = 0;
    for (const c of prevCands) far = Math.max(far, c.dist);
    let far2 = 0;
    for (const c of currCands) far2 = Math.max(far2, c.dist);
    return dGPS + far + far2 + this.ROUTE_SLACK_M;
  },

  /**
   * Network distance (m) from candidate c's snap point to every node within
   * limitM (Dijkstra).  The search starts at both ends of c's segment.
   * @returns {Map<string, number>}
   */
  _routesFrom(graph, c, limitM) {
    const done = new Map();
    const open = new Map();
    for (const p of [c.coords[c.segIdx], c.coords[c.segIdx + 1]]) {
      const key = Junctions.nodeKey(p.lat, p.lon);
      const m = this._haversineM(c.snapLat, c.snapLon, p.lat, p.lon);
      if (!(open.get(key) <= m)) open.set(key, m);
    }
    while (open.size > 0) {
      let key = null;
      let m = Infinity;
      for (const [k, v] of open) {
        if (v < m) {
          m = v;
          key = k;
        }
      }
      open.delete(key);
      if (m > limitM) break;
      done.set(key, m);
      for (const e of graph.get(key)?.edges || []) {
        if (done.has(e.key)) continue;
        const next = m + e.m;
        if (!(open.get(e.key) <= next)) open.set(e.key, next);
      }
    }
    return done;
  },

  /**
   * Walking distance (m) from c1's snap point to c2's, given c1's network
   * distances (_routesFrom).  Two snaps on the same segment are a straight
   * step.  Infinity when no route was found within the search limit.
   */
  _routeDist(c1, c2, routes) {
    if (c1.wayId === c2.wayId && c1.segIdx === c2.segIdx) {
      return this._haversineM(c1.snapLat, c1.snapLon, c2.snapLat, c2.snapLon);
    }
    let best = Infinity;
    for (const p of [c2.coords[c2.segIdx], c2.coords[c2.segIdx + 1]]) {
      const m = routes.get(Junctions.nodeKey(p.lat, p.lon));
      if (m !== undefined) {
        best = Math.min(
          best,
          m + this._haversineM(p.lat, p.lon, c2.snapLat, c2.snapLon),
        );
      }
    }
    return best;
  },

  /**
   * Snap blend weight α ∈ [0, 1]:
   *   α = 1.0  when d = 0 (fix is right on the road)
   *   α = 0.0  when d ≥ radiusM (fix is at or beyond the search boundary)
   * Cosine roll-off in between (smooth, no discontinuity).
   */
  _snapAlpha(dist, radiusM) {
    if (dist <= 0) return 1.0;
    if (dist >= radiusM) return 0.0;
    return 0.5 * (1 + Math.cos((Math.PI * dist) / radiusM));
  },

  _haversineM(lat1, lon1, lat2, lon2) {
    return GeoUtils.haversineMeters(lat1, lon1, lat2, lon2);
  },

  _segmentBearing(lat1, lon1, lat2, lon2) {
    return GeoUtils.bearingRad(lat1, lon1, lat2, lon2);
  },

  _angularDiff(a, b) {
    // Reduce to [0, 2π) first: course is [0, 2π) but atan2 bearings are
    // (−π, π], so |a − b| alone can exceed 2π and fold to a negative angle.
    const TWO_PI = 2 * Math.PI;
    let d = (((a - b) % TWO_PI) + TWO_PI) % TWO_PI;
    if (d > Math.PI) d = TWO_PI - d;
    return d;
  },

  /**
   * Road-class score adjustment (metres).
   * Negative values boost pedestrian infrastructure; positive values
   * penalise high-speed roads that a pedestrian is unlikely to be on.
   */
  _ROAD_CLASS_PENALTY: {
    motorway: 20,
    trunk: 15,
    primary: 10,
    secondary: 5,
    tertiary: 3,
    residential: 0,
    unclassified: 0,
    living_street: 0,
    service: 0,
    track: -2,
    cycleway: -3,
    pedestrian: -5,
    steps: -2,
    bridleway: -2,
    footway: -8,
    path: -8,
  },
};
