/**
 * Junction graph + passage classification — pure, no DOM.
 *
 * A junction here is a node where a walker either had a CHOICE (three or more
 * road-ends meet) or the road's CHARACTER changes (highway class, surface or
 * lit status differs between the way they arrive on and the way they leave on).
 *
 * Overpass geometry carries no node ids, so nodes are identified by
 * coordinate (OSM stores 7 dp, so a 6 dp key is an exact match with slack).
 * Unlike the map matcher's endpoint-proximity proxy, this sees mid-way
 * T-junctions: the joining way's end coincides with a vertex of the through way.
 *
 * Shared by the map matcher (is a side-road run a real turn or a glitch?) and
 * the junction-response analysis (did they turn or carry on, and what did GSR
 * do either side?).
 */
import { GeoUtils } from './geo_utils.mjs';

export const Junctions = {
  /** A fix must be within this of a junction node to count as passing it. */
  PASS_RADIUS_M: 15,
  /** Distance travelled either side of the node used to measure bearings. */
  ARM_M: 25,
  /** Minimum arm length (m) for a bearing to be trusted. */
  MIN_ARM_M: 15,
  /** |turn| at or below this is "straight". */
  STRAIGHT_MAX_DEG: 25,
  /** |turn| at or above this is a "turn"; between the two is ambiguous. */
  TURN_MIN_DEG: 40,
  /** |turn| at or above this is a "reverse" (walked back the way they came). */
  REVERSE_MIN_DEG: 135,
  /** A fix further than this (m) from its matched way is off the network and
   *  says nothing about which road the walker was on. */
  MAX_WAY_DIST_M: 20,
  /** Passages within this many metres of track of each other are one decision
   *  (wide crossroads, dual-carriageway intersections, pedestrian crossing islands,
   *  and parallel pavements each carry multiple nodes for the same intersection).
   *  Merged within 15–20 m so multi-node crossroads do not collide and get
   *  dropped under window clipping. */
  MERGE_M: 20,
  /** Maximum diameter/span (m) of a single crossroads cluster along the track.
   *  Prevents chaining along a whole street if nodes are closely spaced. */
  MAX_CLUSTER_SPAN_M: 25,
  /** Highway tags that are non-thoroughfares and must not create fake junctions. */
  NON_ROAD_HIGHWAY: new Set([
    'bus_stop',
    'platform',
    'street_lamp',
    'traffic_signals',
    'crossing',
    'stop',
    'give_way',
    'milestone',
    'speed_camera',
    'passing_place',
    'turning_circle',
    'turning_loop',
    'mini_roundabout',
    'motorway_junction',
    'elevator',
    'emergency_bay',
    'rest_area',
    'services',
    'proposed',
    'construction',
    'planned',
  ]),
  /** Consecutive fixes near one node further apart than this (m of track)
   *  are separate visits to it. */
  VISIT_GAP_M: 6,
  /** Minimum distance (m) a mid-block control fix must be from any candidate junction node. */
  CONTROL_MIN_NODE_DIST_M: 30,
  /** Minimum distance (m of track) a control fix must be from any detected junction passage. */
  CONTROL_MIN_PASSAGE_DIST_M: 30,
  /** Minimum distance (m of track) between consecutive control samples along the same road. */
  CONTROL_SPACING_M: 25,

  nodeKey(lat, lon) {
    if (
      lat == null ||
      lon == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return '';
    }
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
  },

  /** True when the two ways share at least one vertex. */
  waysShareNode(coordsA, coordsB) {
    if (!coordsA || !coordsB) return false;
    const keys = new Set(
      coordsA.map((c) => this.nodeKey(c?.lat, c?.lon)).filter(Boolean),
    );
    return coordsB.some((c) => {
      const k = this.nodeKey(c?.lat, c?.lon);
      return k !== '' && keys.has(k);
    });
  },

  /** Highway class / surface / lit — what a walker perceives as "the road". */
  characterOf(way) {
    const t = way?.tags || {};
    return `${t.highway || ''}|${t.surface || ''}|${t.lit || ''}`;
  },

  /**
   * Index every node shared by two or more ways, or touched by a way end
   * (a candidate junction).  `degree` counts road-ends: a through vertex adds
   * 2, a way end adds 1, so a side road joining a through road gives 3.
   *
   * @param {Array} ways Overpass ways ({id, tags, coordinates})
   * @returns {{nodes: Map<string, object>, wayNodes: Map<*, string[]>}}
   */
  buildIndex(ways) {
    const nodes = new Map();
    for (const w of ways) {
      if (
        w.type !== 'way' ||
        !w.tags?.highway ||
        this.NON_ROAD_HIGHWAY.has(w.tags.highway) ||
        !w.coordinates ||
        w.coordinates.length < 2
      ) {
        continue;
      }
      const last = w.coordinates.length - 1;
      w.coordinates.forEach((c, i) => {
        const key = this.nodeKey(c.lat, c.lon);
        let n = nodes.get(key);
        if (!n) {
          n = { key, lat: c.lat, lon: c.lon, degree: 0, ways: new Map() };
          nodes.set(key, n);
        }
        n.degree += i === 0 || i === last ? 1 : 2;
        n.ways.set(w.id, w);
      });
    }
    // A node touched by a single way can't be a junction.
    const wayNodes = new Map();
    for (const [key, n] of nodes) {
      if (n.ways.size < 2) {
        nodes.delete(key);
        continue;
      }
      for (const id of n.ways.keys()) {
        if (!wayNodes.has(id)) wayNodes.set(id, []);
        wayNodes.get(id).push(key);
      }
    }

    // 2D Junction clustering: group junction nodes connected along any way within MERGE_M,
    // bounded by MAX_CLUSTER_SPAN_M to prevent runaway single-linkage chaining along a street.
    const clusters = new Map();
    for (const key of nodes.keys()) {
      clusters.set(key, new Set([key]));
    }

    const pairs = [];
    for (const nodeKeys of wayNodes.values()) {
      for (let a = 0; a < nodeKeys.length; a++) {
        const nA = nodes.get(nodeKeys[a]);
        if (!nA) continue;
        for (let b = a + 1; b < nodeKeys.length; b++) {
          const nB = nodes.get(nodeKeys[b]);
          if (!nB) continue;
          const d = GeoUtils.haversineMeters(nA.lat, nA.lon, nB.lat, nB.lon);
          if (d <= this.MERGE_M) {
            pairs.push({ keyA: nodeKeys[a], keyB: nodeKeys[b], d });
          }
        }
      }
    }

    pairs.sort((p1, p2) => p1.d - p2.d);

    for (const { keyA, keyB } of pairs) {
      const cA = clusters.get(keyA);
      const cB = clusters.get(keyB);
      if (!cA || !cB || cA === cB) continue;

      let canMerge = true;
      for (const u of cA) {
        const nU = nodes.get(u);
        if (!nU) continue;
        for (const v of cB) {
          const nV = nodes.get(v);
          if (!nV) continue;
          if (
            GeoUtils.haversineMeters(nU.lat, nU.lon, nV.lat, nV.lon) >
            this.MAX_CLUSTER_SPAN_M
          ) {
            canMerge = false;
            break;
          }
        }
        if (!canMerge) break;
      }

      if (canMerge) {
        for (const v of cB) {
          cA.add(v);
          clusters.set(v, cA);
        }
      }
    }

    // Assign canonical clusterKey, clusterSize, clusterWays, and clusterDegree to each node
    const uniqueClusters = new Set(clusters.values());
    for (const compSet of uniqueClusters) {
      const comp = [...compSet].sort();
      const canonical = comp[0];
      const clusterWays = new Map();
      let maxDegree = 0;
      for (const k of comp) {
        const nd = nodes.get(k);
        if (nd) {
          if (nd.degree > maxDegree) maxDegree = nd.degree;
          for (const [wid, wobj] of nd.ways) {
            clusterWays.set(wid, wobj);
          }
        }
      }
      for (const k of comp) {
        const nd = nodes.get(k);
        if (nd) {
          nd.clusterKey = canonical;
          nd.clusterSize = comp.length;
          nd.clusterWays = clusterWays;
          nd.clusterDegree = maxDegree;
        }
      }
    }

    return { nodes, wayNodes };
  },

  /**
   * Classify every junction the matched track passes.
   *
   * @param {Array<{idx:number,time:number,lat:number,lon:number,wayId:*,dist?:number,rawLat?:number,rawLon?:number}>} pts
   *   matched fixes in time order (snapped position + way).  When rawLat/rawLon
   *   are given, a passage is only turn/straight/reverse if snapped and raw agree.
   * @param {Array} ways Overpass ways covering the track.
   * @param {object} [opts] Options ({ includeControl?: boolean })
   * @returns {Array<object>} one entry per passage, time-ordered:
   *   {key, lat, lon, i, idx, time, iBefore, iAfter, kind, degree, decision,
   *    turnAngleDeg, rawTurnAngleDeg, inWay, outWay, inClass, outClass}
   *   kind: 'choice' | 'change' | 'choice+change' | 'control'
   *   decision: 'straight' | 'turn' | 'reverse' | 'ambiguous' | 'control'
   */
  classifyPassages(pts, ways, opts = {}) {
    const { nodes, wayNodes } = this.buildIndex(ways);
    const R = this.PASS_RADIUS_M;

    // Cumulative track distance at each fix, so gaps are in metres.
    const cum = new Array(pts.length).fill(0);
    for (let k = 1; k < pts.length; k++) {
      cum[k] =
        cum[k - 1] +
        GeoUtils.haversineMeters(
          pts[k - 1].lat,
          pts[k - 1].lon,
          pts[k].lat,
          pts[k].lon,
        );
    }

    // 1. Candidate (node, fix) pairs, only checking nodes on the fix's own way.
    const byNode = new Map();
    pts.forEach((p, i) => {
      if (!this._onWay(p) || !wayNodes.has(p.wayId)) return;
      for (const key of wayNodes.get(p.wayId)) {
        const n = nodes.get(key);
        const d = GeoUtils.haversineMeters(p.lat, p.lon, n.lat, n.lon);
        if (d > R) continue;
        if (!byNode.has(key)) byNode.set(key, []);
        byNode.get(key).push({ i, d });
      }
    });

    // 2. Split each node's hits into separate visits, keep the closest fix.
    const passages = [];
    for (const [key, hits] of byNode) {
      const n = nodes.get(key);
      let run = [hits[0]];
      const flush = () => {
        const best = run.reduce((a, b) => (b.d < a.d ? b : a));
        const p = this._passage(pts, n, best.i, cum);
        if (p) passages.push(p);
      };
      for (let h = 1; h < hits.length; h++) {
        if (cum[hits[h].i] - cum[hits[h - 1].i] > this.VISIT_GAP_M) {
          flush();
          run = [];
        }
        run.push(hits[h]);
      }
      flush();
    }
    const juncs = this._mergeNearby(
      passages.sort((a, b) => a.i - b.i),
      cum,
      pts,
    );
    if (opts.includeControl) {
      const controls = this.findControlPassages(pts, ways, juncs, cum, {
        nodes,
        wayNodes,
      });
      return [...juncs, ...controls].sort((a, b) => a.i - b.i);
    }
    return juncs;
  },

  /**
   * Identify mid-block control passages along straight road segments away from any junction.
   *
   * @param {Array} pts matched fixes in time order
   * @param {Array} ways Overpass ways covering the track
   * @param {Array} juncPassages already classified junction passages
   * @param {number[]} [cum] cumulative track distance array (optional, computed if missing)
   * @param {object} [cache] pre-built { nodes, wayNodes } index
   * @returns {Array<object>} control passages
   */
  findControlPassages(pts, ways, juncPassages = [], cum = null, cache = null) {
    if (!pts || pts.length < 2) return [];
    if (!cum) {
      cum = new Array(pts.length).fill(0);
      for (let k = 1; k < pts.length; k++) {
        cum[k] =
          cum[k - 1] +
          GeoUtils.haversineMeters(
            pts[k - 1].lat,
            pts[k - 1].lon,
            pts[k].lat,
            pts[k].lon,
          );
      }
    }

    const { nodes, wayNodes } = cache || this.buildIndex(ways);
    const wayMap = new Map();
    for (const w of ways) {
      if (w?.id != null) wayMap.set(w.id, w);
    }

    const controls = [];
    let lastControlCum = -Infinity;

    const arm = (i, dir) => {
      let j = i;
      const targetWay = pts[i].wayId;
      while (
        j + dir >= 0 &&
        j + dir < pts.length &&
        Math.abs(cum[j + dir] - cum[i]) < this.ARM_M
      ) {
        if (pts[j + dir].wayId !== targetWay) break;
        j += dir;
      }
      return Math.abs(cum[j] - cum[i]) >= this.MIN_ARM_M ? j : -1;
    };

    const brg = (a, b) => GeoUtils.bearingDeg(a.lat, a.lon, b.lat, b.lon);
    const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!this._onWay(p)) continue;
      const w = wayMap.get(p.wayId);
      if (!w) continue;

      // 1. Spacing from previous control passage
      if (cum[i] - lastControlCum < this.CONTROL_SPACING_M) continue;

      // 2. Distance along track from any junction passage or cluster extent
      let nearJunc = false;
      for (const jp of juncPassages) {
        const juncMin = jp.iBefore != null ? cum[jp.iBefore] : cum[jp.i];
        const juncMax = jp.iAfter != null ? cum[jp.iAfter] : cum[jp.i];
        if (
          cum[i] >= juncMin - this.CONTROL_MIN_PASSAGE_DIST_M &&
          cum[i] <= juncMax + this.CONTROL_MIN_PASSAGE_DIST_M
        ) {
          nearJunc = true;
          break;
        }
      }
      if (nearJunc) continue;

      // 3. Spatial distance from any candidate junction node on this way
      const nodeKeys = wayNodes.get(p.wayId) || [];
      let tooCloseToNode = false;
      for (const key of nodeKeys) {
        const n = nodes.get(key);
        if (!n) continue;
        const d = GeoUtils.haversineMeters(p.lat, p.lon, n.lat, n.lon);
        if (d < this.CONTROL_MIN_NODE_DIST_M) {
          tooCloseToNode = true;
          break;
        }
      }
      if (tooCloseToNode) continue;

      // 4. Arms before and after must stay on this way and be straight
      const iBefore = arm(i, -1);
      const iAfter = arm(i, 1);
      if (iBefore < 0 || iAfter < 0) continue;

      const bIn = brg(pts[iBefore], pts[i]);
      const bOut = brg(pts[i], pts[iAfter]);
      const turn = wrap(bOut - bIn);
      if (this._label(turn) !== 'straight') continue;

      let rawTurn = null;
      if (
        p.rawLat != null &&
        p.rawLon != null &&
        pts[iBefore]?.rawLat != null &&
        pts[iBefore]?.rawLon != null &&
        pts[iAfter]?.rawLat != null &&
        pts[iAfter]?.rawLon != null
      ) {
        const rb = (a, b) =>
          GeoUtils.bearingDeg(a.rawLat, a.rawLon, b.rawLat, b.rawLon);
        rawTurn = wrap(rb(pts[i], pts[iAfter]) - rb(pts[iBefore], pts[i]));
        if (this._label(rawTurn) !== 'straight') continue;
      }

      const charStr = this.characterOf(w);
      controls.push({
        key: `ctrl_${p.wayId}_${p.time}`,
        lat: p.lat,
        lon: p.lon,
        i,
        idx: p.idx,
        time: p.time,
        iBefore,
        iAfter,
        kind: 'control',
        degree: 2,
        decision: 'control',
        turnAngleDeg: turn,
        rawTurnAngleDeg: rawTurn,
        inWay: p.wayId,
        outWay: p.wayId,
        inClass: charStr,
        outClass: charStr,
      });
      lastControlCum = cum[i];
    }

    return controls;
  },

  /**
   * Collapse passages within MERGE_M of track into one unified junction.
   * Wide crossroads, dual-carriageway intersections, pedestrian crossing islands,
   * and parallel pavements produce multiple candidate nodes along the path within 15–20 m.
   * Grouping them avoids self-collision under window clipping and preserves
   * the overall crossing decision.
   */
  _mergeNearby(sorted, cum, pts = null) {
    if (!sorted || sorted.length === 0) return [];

    const rank = (p) =>
      (p.kind === 'choice+change' ? 1e3 : 0) +
      (p.decision === 'turn' ? 500 : 0) +
      (p.degree ?? 0);

    const clusters = [];
    let currentCluster = [sorted[0]];

    for (let k = 1; k < sorted.length; k++) {
      const p = sorted[k];
      const prev = sorted[k - 1];
      const clusterStart = currentCluster[0];
      const gapToPrev = cum[p.i] - cum[prev.i];
      const spanFromStart = cum[p.i] - cum[clusterStart.i];

      if (
        gapToPrev <= this.MERGE_M &&
        spanFromStart <= this.MAX_CLUSTER_SPAN_M
      ) {
        currentCluster.push(p);
      } else {
        clusters.push(currentCluster);
        currentCluster = [p];
      }
    }
    clusters.push(currentCluster);

    return clusters.map((cluster) => {
      if (cluster.length === 1) {
        const p = cluster[0];
        return {
          ...p,
          timeEnter: p.time,
          timeExit: p.time,
          clusterSpanM: 0,
          mergedCount: 1,
        };
      }

      // Representative passage is the richest/most definitive node in the cluster
      const best = cluster.reduce((a, b) => (rank(b) > rank(a) ? b : a));

      // Deterministic canonical cluster key: lexicographically lowest node/cluster key
      const canonicalKey = [
        ...new Set(cluster.map((p) => p.clusterKey || p.key)),
      ].sort()[0];

      // Span approach and exit arms across the entire crossroads cluster
      const iBefore = Math.min(...cluster.map((p) => p.iBefore));
      const iAfter = Math.max(...cluster.map((p) => p.iAfter));
      const maxDegree = Math.max(...cluster.map((p) => p.degree ?? 0));
      const hasChoice = cluster.some((p) => p.kind?.includes('choice'));
      const hasChange = cluster.some((p) => p.kind?.includes('change'));
      const kind =
        hasChoice && hasChange
          ? 'choice+change'
          : hasChoice
            ? 'choice'
            : 'change';

      // Overall trajectory deflection across the whole multi-node crossroads
      const brg = (a, b) => GeoUtils.bearingDeg(a.lat, a.lon, b.lat, b.lon);
      const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
      let clusterTurnAngle = null;
      let clusterDecision = null;
      let clusterRawTurnAngle = null;

      if (
        pts?.[iBefore] &&
        pts[iAfter] &&
        pts[cluster[0].i] &&
        pts[cluster[cluster.length - 1].i]
      ) {
        const bIn = brg(pts[iBefore], pts[cluster[0].i]);
        const bOut = brg(pts[cluster[cluster.length - 1].i], pts[iAfter]);
        clusterTurnAngle = wrap(bOut - bIn);
        clusterDecision = this._label(clusterTurnAngle);

        if (
          pts[cluster[0].i].rawLat != null &&
          pts[cluster[0].i].rawLon != null &&
          pts[cluster[cluster.length - 1].i].rawLat != null &&
          pts[cluster[cluster.length - 1].i].rawLon != null &&
          pts[iBefore]?.rawLat != null &&
          pts[iBefore]?.rawLon != null &&
          pts[iAfter]?.rawLat != null &&
          pts[iAfter]?.rawLon != null
        ) {
          const rb = (a, b) =>
            GeoUtils.bearingDeg(a.rawLat, a.rawLon, b.rawLat, b.rawLon);
          const rbIn = rb(pts[iBefore], pts[cluster[0].i]);
          const rbOut = rb(pts[cluster[cluster.length - 1].i], pts[iAfter]);
          clusterRawTurnAngle = wrap(rbOut - rbIn);
        }
      }

      // The overall path through the crossroads decides. A single node's arms
      // overlap the rest of the cluster, so a jog between staggered nodes reads
      // as a turn at one node even when the walker carried straight on; the
      // per-node labels are only a fallback when the overall angle can't be measured.
      let decision = best.decision;
      if (clusterDecision != null) {
        decision = clusterDecision;
      } else if (cluster.some((p) => p.decision === 'turn')) {
        decision = 'turn';
      } else if (cluster.some((p) => p.decision === 'reverse')) {
        decision = 'reverse';
      } else if (cluster.some((p) => p.decision === 'straight')) {
        decision = 'straight';
      }

      if (
        clusterRawTurnAngle != null &&
        this._label(clusterRawTurnAngle) !== decision
      ) {
        decision = 'ambiguous';
      }

      const turnPassages = cluster.filter((p) => p.decision === 'turn');
      const turnPassage =
        turnPassages.length > 0
          ? turnPassages.reduce((a, b) =>
              Math.abs(b.turnAngleDeg ?? 0) > Math.abs(a.turnAngleDeg ?? 0)
                ? b
                : a,
            )
          : null;
      const turnAngleDeg =
        clusterTurnAngle ??
        (turnPassage ? turnPassage.turnAngleDeg : best.turnAngleDeg);
      const rawTurnAngleDeg =
        clusterRawTurnAngle != null
          ? clusterRawTurnAngle
          : turnPassage
            ? turnPassage.rawTurnAngleDeg
            : best.rawTurnAngleDeg;

      // Temporal anchor: anchor time to the entrance of the crossroads cluster
      // so the "before" approach window is strictly prior to entering the junction.
      const timeEnter = cluster[0].time;
      const timeExit = cluster[cluster.length - 1].time;
      const clusterSpanM =
        cum[cluster[cluster.length - 1].i] - cum[cluster[0].i];

      return {
        ...best,
        key: canonicalKey,
        time: timeEnter,
        timeEnter,
        timeExit,
        clusterSpanM,
        degree: maxDegree,
        kind,
        decision,
        turnAngleDeg,
        rawTurnAngleDeg,
        inWay: cluster[0].inWay,
        outWay: cluster[cluster.length - 1].outWay,
        inClass: cluster[0].inClass,
        outClass: cluster[cluster.length - 1].outClass,
        iBefore,
        iAfter,
        mergedCount: cluster.length,
      };
    });
  },

  _onWay(p) {
    return p.wayId != null && !(p.dist > this.MAX_WAY_DIST_M);
  },

  _label(turnDeg) {
    const abs = Math.abs(turnDeg);
    if (abs <= this.STRAIGHT_MAX_DEG) return 'straight';
    if (abs >= this.REVERSE_MIN_DEG) return 'reverse';
    if (abs >= this.TURN_MIN_DEG) return 'turn';
    return 'ambiguous';
  },

  /** Build one passage at fix index i of node n, or null if not a real one. */
  _passage(pts, n, i, cum = null) {
    const arm = (dir) => {
      let j = i;
      if (cum) {
        while (
          j + dir >= 0 &&
          j + dir < pts.length &&
          Math.abs(cum[j + dir] - cum[i]) < this.ARM_M
        ) {
          j += dir;
        }
        return Math.abs(cum[j] - cum[i]) >= this.MIN_ARM_M ? j : -1;
      }
      let dist = 0;
      while (j + dir >= 0 && j + dir < pts.length && dist < this.ARM_M) {
        dist += GeoUtils.haversineMeters(
          pts[j].lat,
          pts[j].lon,
          pts[j + dir].lat,
          pts[j + dir].lon,
        );
        j += dir;
      }
      return dist >= this.MIN_ARM_M ? j : -1;
    };
    const iBefore = arm(-1);
    const iAfter = arm(1);
    if (iBefore < 0 || iAfter < 0) return null;

    const dominantWay = (from, to) => {
      const counts = new Map();
      const waysMap = n.clusterWays || n.ways;
      for (let k = from; k <= to; k++) {
        const w = this._onWay(pts[k]) ? pts[k].wayId : null;
        if (w != null && waysMap.has(w))
          counts.set(w, (counts.get(w) || 0) + 1);
      }
      let best = null;
      let bc = 0;
      for (const [w, c] of counts) {
        if (c > bc) {
          best = w;
          bc = c;
        }
      }
      return best;
    };
    const inWay = dominantWay(iBefore, i);
    const outWay = dominantWay(i, iAfter);
    if (inWay == null || outWay == null) return null;

    const waysMap = n.clusterWays || n.ways;
    const inClass = this.characterOf(waysMap.get(inWay));
    const outClass = this.characterOf(waysMap.get(outWay));
    const choice = (n.clusterDegree ?? n.degree) >= 3;
    const change = inClass !== outClass;
    if (!choice && !change) return null;

    const brg = (a, b) => GeoUtils.bearingDeg(a.lat, a.lon, b.lat, b.lon);
    const bIn = brg(pts[iBefore], pts[i]);
    const bOut = brg(pts[i], pts[iAfter]);
    const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
    const turn = wrap(bOut - bIn);
    let decision = this._label(turn);

    // Snapping can add or hide a corner, so when the raw fixes are supplied
    // the walker only counts as having turned (or not) if both agree.
    let rawTurn = null;
    if (
      pts[i].rawLat != null &&
      pts[i].rawLon != null &&
      pts[iBefore]?.rawLat != null &&
      pts[iBefore]?.rawLon != null &&
      pts[iAfter]?.rawLat != null &&
      pts[iAfter]?.rawLon != null
    ) {
      const rb = (a, b) =>
        GeoUtils.bearingDeg(a.rawLat, a.rawLon, b.rawLat, b.rawLon);
      rawTurn = wrap(rb(pts[i], pts[iAfter]) - rb(pts[iBefore], pts[i]));
      if (this._label(rawTurn) !== decision) decision = 'ambiguous';
    }

    return {
      key: n.clusterKey || n.key,
      nodeKey: n.key,
      clusterKey: n.clusterKey || n.key,
      lat: n.lat,
      lon: n.lon,
      i,
      idx: pts[i].idx,
      time: pts[i].time,
      iBefore,
      iAfter,
      kind: choice && change ? 'choice+change' : choice ? 'choice' : 'change',
      degree: n.degree,
      decision,
      turnAngleDeg: turn,
      rawTurnAngleDeg: rawTurn,
      inWay,
      outWay,
      inClass,
      outClass,
    };
  },
};
