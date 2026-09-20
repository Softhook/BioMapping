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
   *  (parallel pavements each carry their own node for the same crossing).
   *  Kept tight: distinct junctions a few metres apart are real, and the
   *  analysis handles overlapping windows itself.  Metres, not fix counts:
   *  the matcher's fixes are spatially thinned (~3 m) in the app but ~1 Hz
   *  in raw logs, so an index gap would mean different things in each. */
  MERGE_M: 3,
  /** Consecutive fixes near one node further apart than this (m of track)
   *  are separate visits to it. */
  VISIT_GAP_M: 6,

  nodeKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
  },

  /** True when the two ways share at least one vertex. */
  waysShareNode(coordsA, coordsB) {
    if (!coordsA || !coordsB) return false;
    const keys = new Set(coordsA.map((c) => this.nodeKey(c.lat, c.lon)));
    return coordsB.some((c) => keys.has(this.nodeKey(c.lat, c.lon)));
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
    return { nodes, wayNodes };
  },

  /**
   * Classify every junction the matched track passes.
   *
   * @param {Array<{idx:number,time:number,lat:number,lon:number,wayId:*,dist?:number,rawLat?:number,rawLon?:number}>} pts
   *   matched fixes in time order (snapped position + way).  When rawLat/rawLon
   *   are given, a passage is only turn/straight/reverse if snapped and raw agree.
   * @param {Array} ways Overpass ways covering the track.
   * @returns {Array<object>} one entry per passage, time-ordered:
   *   {key, lat, lon, i, idx, time, iBefore, iAfter, kind, degree, decision,
   *    turnAngleDeg, rawTurnAngleDeg, inWay, outWay, inClass, outClass}
   *   kind: 'choice' | 'change' | 'choice+change'
   *   decision: 'straight' | 'turn' | 'reverse' | 'ambiguous'
   */
  classifyPassages(pts, ways) {
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
        const p = this._passage(pts, n, best.i);
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
    return this._mergeNearby(
      passages.sort((a, b) => a.i - b.i),
      cum,
    );
  },

  /** Collapse passages within MERGE_M of track into one, keeping the richest node. */
  _mergeNearby(sorted, cum) {
    const rank = (p) => (p.kind === 'choice+change' ? 1e3 : 0) + p.degree;
    const out = [];
    for (const p of sorted) {
      const last = out[out.length - 1];
      if (last && cum[p.i] - cum[last.i] <= this.MERGE_M) {
        if (rank(p) > rank(last)) out[out.length - 1] = p;
      } else {
        out.push(p);
      }
    }
    return out;
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
  _passage(pts, n, i) {
    const arm = (dir) => {
      let dist = 0;
      let j = i;
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
      for (let k = from; k <= to; k++) {
        const w = this._onWay(pts[k]) ? pts[k].wayId : null;
        if (w != null && n.ways.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
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

    const inClass = this.characterOf(n.ways.get(inWay));
    const outClass = this.characterOf(n.ways.get(outWay));
    const choice = n.degree >= 3;
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
    if (pts[i].rawLat != null) {
      const rb = (a, b) =>
        GeoUtils.bearingDeg(a.rawLat, a.rawLon, b.rawLat, b.rawLon);
      rawTurn = wrap(rb(pts[i], pts[iAfter]) - rb(pts[iBefore], pts[i]));
      if (this._label(rawTurn) !== decision) decision = 'ambiguous';
    }

    return {
      key: n.key,
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
