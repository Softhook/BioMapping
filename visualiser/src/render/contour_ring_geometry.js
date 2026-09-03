/**
 * Contour/isoband ring geometry — turns raw Marching Squares segments into
 * closed, fillable rings (including holes for interior "no data" islands).
 * Pure geographic (lat/lon) point-array geometry: no SVG, no projection, no
 * DOM. Extracted out of map_exporter.js, which now only smooths/projects/
 * serializes the rings this module produces.
 */
class ContourRingGeometry {

  // ═══════════════════════════════════════════════════════════════════
  //  Loops
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Turn a raw, ordered array of {lat, lon, ...} points into a closed "loop":
   * each point gets a cumulative arc-length `t` (real distance in degrees from
   * points[0], increasing around the loop), and the loop remembers its total
   * length (arc back from the last point to the first, closing it), plus its
   * own bounding-box diagonal (`diag`) — used to scale how far a boundary
   * walk or tangent-extrapolated tip pushes outward.
   */
  static toLoop(rawPoints) {
    if (!rawPoints || rawPoints.length === 0) return { points: [], length: 0, diag: 0 };
    let t = 0;
    const b = (typeof GeoUtils !== 'undefined' && typeof GeoUtils.computeBounds === 'function')
      ? GeoUtils.computeBounds(rawPoints)
      : { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
    const points = rawPoints.map((p, i) => {
      if (i > 0) {
        const prev = rawPoints[i - 1];
        t += Math.hypot(p.lat - prev.lat, p.lon - prev.lon);
      }
      return { ...p, t };
    });
    const first = points[0], last = points[points.length - 1];
    const closingLen = Math.hypot(first.lat - last.lat, first.lon - last.lon);
    const diag = Math.hypot(b.maxLat - b.minLat, b.maxLon - b.minLon) || 1e-9;
    return { points, length: last.t + closingLen, diag };
  }

  /**
   * The literal bounding rectangle as a loop, at grid resolution — this is the
   * only "boundary" that exists for a fully-populated grid (no masked cells),
   * and it's always included even when a data mask is also present.
   */
  static buildRectangleLoop(grid, rows, cols, bounds) {
    const latSpan = bounds.maxLat - bounds.minLat, lonSpan = bounds.maxLon - bounds.minLon;
    const raw = [];
    for (let c = 0; c < cols; c++) raw.push({ lat: bounds.maxLat, lon: bounds.minLon + (c / (cols - 1)) * lonSpan, val: grid[rows - 1][c], normal: { lat: 1, lon: 0 } });
    for (let r = rows - 2; r >= 0; r--) raw.push({ lat: bounds.minLat + (r / (rows - 1)) * latSpan, lon: bounds.maxLon, val: grid[r][cols - 1], normal: { lat: 0, lon: 1 } });
    for (let c = cols - 2; c >= 0; c--) raw.push({ lat: bounds.minLat, lon: bounds.minLon + (c / (cols - 1)) * lonSpan, val: grid[0][c], normal: { lat: -1, lon: 0 } });
    for (let r = 1; r <= rows - 2; r++) raw.push({ lat: bounds.minLat + (r / (rows - 1)) * latSpan, lon: bounds.minLon, val: grid[r][0], normal: { lat: 0, lon: -1 } });
    return this.toLoop(raw);
  }

  /**
   * Traces the "coastline" between valid (real number) and masked (null)
   * grid cells — e.g. the edge of a GPS track's isolationRadius corridor in
   * collective_manager.js's generateContourSurface, where most of the grid
   * outside the walked path is deliberately left null.
   *
   * Mirrors MarchingSquares' own cell-marching loop on a binary valid/invalid
   * field, tagging each traced point with the real DATA value of whichever
   * corner is valid and the true local outward direction.
   */
  static traceMaskBoundary(grid, rows, cols, bounds) {
    const isValid = (r, c) => grid[r][c] !== null && grid[r][c] !== undefined && !isNaN(grid[r][c]);
    const minLat = bounds.minLat, maxLat = bounds.maxLat, minLon = bounds.minLon, maxLon = bounds.maxLon;
    const pos = (r, c) => ({
      lat: minLat + (r / (rows - 1)) * (maxLat - minLat),
      lon: minLon + (c / (cols - 1)) * (maxLon - minLon)
    });
    const edgePoint = (r1, c1, r2, c2) => {
      const p1 = pos(r1, c1), p2 = pos(r2, c2);
      const v1Valid = isValid(r1, c1);
      const validPos = v1Valid ? p1 : p2, nullPos = v1Valid ? p2 : p1;
      const validVal = v1Valid ? grid[r1][c1] : grid[r2][c2];
      const dir = { lat: nullPos.lat - validPos.lat, lon: nullPos.lon - validPos.lon };
      const len = Math.hypot(dir.lat, dir.lon) || 1e-9;
      return {
        lat: (p1.lat + p2.lat) / 2, lon: (p1.lon + p2.lon) / 2,
        val: validVal,
        normal: { lat: dir.lat / len, lon: dir.lon / len }
      };
    };

    const segs = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const vNW = isValid(r, c), vNE = isValid(r, c + 1), vSE = isValid(r + 1, c + 1), vSW = isValid(r + 1, c);
        let idx = 0;
        if (vNW) idx |= 8;
        if (vNE) idx |= 4;
        if (vSE) idx |= 2;
        if (vSW) idx |= 1;
        if (idx === 0 || idx === 15) continue;

        const T = () => edgePoint(r, c, r, c + 1);
        const R = () => edgePoint(r, c + 1, r + 1, c + 1);
        const B = () => edgePoint(r + 1, c, r + 1, c + 1);
        const L = () => edgePoint(r, c, r + 1, c);

        switch (idx) {
          case 1:  segs.push([B(), L()]); break;
          case 2:  segs.push([R(), B()]); break;
          case 3:  segs.push([R(), L()]); break;
          case 4:  segs.push([T(), R()]); break;
          case 5:  segs.push([T(), R()]); segs.push([B(), L()]); break;
          case 6:  segs.push([T(), B()]); break;
          case 7:  segs.push([T(), L()]); break;
          case 8:  segs.push([L(), T()]); break;
          case 9:  segs.push([B(), T()]); break;
          case 10: segs.push([L(), B()]); segs.push([T(), R()]); break;
          case 11: segs.push([R(), T()]); break;
          case 12: segs.push([L(), R()]); break;
          case 13: segs.push([B(), R()]); break;
          case 14: segs.push([L(), B()]); break;
        }
      }
    }
    return segs;
  }

  /**
   * Corner-cuts a closed sequence of {lat, lon, val, normal} points the same
   * way GeoUtils.chaikinSmooth does, but also blends `val` and `normal` along
   * with position (chaikinSmooth only knows about lat/lon and would silently
   * drop them). This prevents staircase raster artefacts on mask boundaries.
   */
  static smoothLoopPoints(points, iterations = 2) {
    if (!points || points.length < 3) return points || [];
    let pts = points;
    for (let iter = 0; iter < iterations; iter++) {
      const n = pts.length;
      const next = [];
      const blend = (a, b, f) => a + (b - a) * f;
      for (let i = 0; i < n; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % n];
        const mk = (f) => {
          const nlat = blend(p0.normal.lat, p1.normal.lat, f);
          const nlon = blend(p0.normal.lon, p1.normal.lon, f);
          const nlen = Math.hypot(nlat, nlon) || 1e-9;
          return {
            lat: blend(p0.lat, p1.lat, f),
            lon: blend(p0.lon, p1.lon, f),
            val: blend(p0.val ?? 0, p1.val ?? 0, f),
            normal: { lat: nlat / nlen, lon: nlon / nlen }
          };
        };
        next.push(mk(0.25), mk(0.75));
      }
      pts = next;
    }
    return pts;
  }

  /**
   * Replaces each point's outward normal with one derived from the *smoothed
   * loop's own local tangent* (perpendicular to it), rather than the raw
   * per-cell valid→null direction traceMaskBoundary computed.
   */
  static recomputeSmoothNormals(points) {
    const n = points.length;
    if (n < 3) return points;
    return points.map((p, i) => {
      const prev = points[(i - 1 + n) % n];
      const next = points[(i + 1) % n];
      const tangent = { lat: next.lat - prev.lat, lon: next.lon - prev.lon };
      const len = Math.hypot(tangent.lat, tangent.lon) || 1e-9;
      const perpA = { lat: -tangent.lon / len, lon: tangent.lat / len };
      const dot = perpA.lat * p.normal.lat + perpA.lon * p.normal.lon;
      const chosen = dot >= 0 ? perpA : { lat: -perpA.lat, lon: -perpA.lon };
      return { ...p, normal: chosen };
    });
  }

  /**
   * All the closed boundary loops an open isoline path could plausibly need
   * to close against: the literal bounding rectangle, always, plus one loop
   * per disconnected masked-data "island" if the grid has any null cells.
   */
  static buildBoundaryLoops(grid, rows, cols, bounds) {
    const loops = [this.buildRectangleLoop(grid, rows, cols, bounds)];

    const hasNull = grid.some(row => row.some(v => v === null || v === undefined || isNaN(v)));
    if (!hasNull) return loops;

    const segs = this.traceMaskBoundary(grid, rows, cols, bounds);
    if (!segs.length) return loops;

    const stitched = (typeof GSRSpatialClustering !== 'undefined' && typeof GSRSpatialClustering.stitchSegments === 'function')
      ? GSRSpatialClustering.stitchSegments(segs)
      : segs.map(s => [s[0], s[1]]);

    stitched.forEach(path => {
      if (!path || path.length < 3) return;
      const first = path[0], last = path[path.length - 1];
      const closed = Math.hypot(first.lat - last.lat, first.lon - last.lon) < 1e-9;
      if (!closed) return;
      const smoothed = this.recomputeSmoothNormals(this.smoothLoopPoints(path.slice(0, -1), 3));
      loops.push(this.toLoop(smoothed));
    });

    return loops;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Extrapolation & closure
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Extend one or both ends of an open curve past the real boundary along its
   * own tangent, so it reads as continuing naturally into an unbounded field
   * instead of stopping dead at the edge.
   *
   * `extrapStart`/`extrapEnd` let a caller skip extrapolating a given end: that
   * matters when this end is about to be joined to a `boundaryWalk` stretch
   * (see closeOpenPaths) rather than directly to another path's own
   * extrapolated tip. boundaryWalk already tapers its own push down to zero
   * right at the point where it meets the real curve, so adding a further
   * Far/Near tip *there too* would mean the ring goes real-boundary-point →
   * (boundaryWalk, tapering back up) → Far → Near → real-boundary-point again —
   * a non-monotonic zigzag that reads as a needle-like spike once smoothed.
   * Skipping extrapolation on that end leaves a single, smooth, monotonic taper
   * (owned entirely by boundaryWalk) instead of two independent ones stacked
   * back-to-back.
   */
  static tangentExtrapolate(pts, diag, extrapStart = true, extrapEnd = true, startNormal = null, endNormal = null) {
    if (!pts || pts.length < 2) return pts || [];

    const unit = (v) => {
      const len = Math.hypot(v.lat, v.lon) || 1e-9;
      return { lat: v.lat / len, lon: v.lon / len };
    };

    // `normalWeight` grows from near to far, so the two extrapolated points
    // aren't collinear with the path's local tangent — the continuation curves
    // gently outward rather than shooting away as a dead-straight line.
    const blendedDir = (from, to, normal, normalWeight) => {
      const tangent = unit({ lat: to.lat - from.lat, lon: to.lon - from.lon });
      const n = normal || { lat: 0, lon: 0 };
      return unit({ lat: tangent.lat + n.lat * normalWeight, lon: tangent.lon + n.lon * normalWeight });
    };

    const n = pts.length;
    // How far the visible continuation reaches past the real edge before
    // curving into the closure — a fraction of the *relevant* boundary's own
    // diagonal.
    const L1 = 0.12 * diag, L2 = 0.28 * diag;
    const extend = (from, dir, dist) => ({ lat: from.lat + dir.lat * dist, lon: from.lon + dir.lon * dist });

    const head = [];
    if (extrapStart) {
      const nearDir = blendedDir(pts[Math.min(1, n - 1)], pts[0], startNormal, 0.35);
      const farDir  = blendedDir(pts[Math.min(1, n - 1)], pts[0], startNormal, 0.7);
      head.push(extend(pts[0], farDir, L2), extend(pts[0], nearDir, L1));
    }
    const tail = [];
    if (extrapEnd) {
      const nearDir = blendedDir(pts[Math.max(0, n - 2)], pts[n - 1], endNormal, 0.35);
      const farDir  = blendedDir(pts[Math.max(0, n - 2)], pts[n - 1], endNormal, 0.7);
      tail.push(extend(pts[n - 1], nearDir, L1), extend(pts[n - 1], farDir, L2));
    }

    return [...head, ...pts, ...tail];
  }

  /**
   * Close the open isoline paths that get cut off at the edge of the grid/map
   * extent. Each open end is extended past the edge along its own tangent
   * (tangentExtrapolate).
   *
   * Where two ends need to be joined and the correct side is not the nearby one,
   * the real grid values sampled along that boundary stretch are reused as a chain
   * of data points nudged outward.
   *
   * @param {Array} openPaths - open isoline paths (each an array of {lat,lon,...})
   * @param {Array} loops - pre-built boundary loops (see buildBoundaryLoops) —
   *   always loops[0] is the bounding rectangle, loops[1:] are mask islands.
   * @param {number} level - the isoband level these paths trace, used to pick
   *   which side of a rectangle-loop boundary stretch is "inside".
   * @returns {Array} closed point rings ready to be smoothed and filled.
   */
  static closeOpenPaths(openPaths, loops, level) {
    if (!openPaths || openPaths.length === 0) return [];
    if (!loops || loops.length === 0) return [];

    const getLL = (p) => ({
      lat: p.lat !== undefined ? p.lat : p[0],
      lon: p.lon !== undefined ? p.lon : (p.lng !== undefined ? p.lng : p[1])
    });

    const nearestOnLoop = (loop, latlon) => {
      let best = null;
      loop.points.forEach(p => {
        const d = Math.hypot(p.lat - latlon.lat, p.lon - latlon.lon);
        if (!best || d < best.d) best = { d, t: p.t, normal: p.normal };
      });
      return best;
    };

    const endpoints = [];
    openPaths.forEach((path, idx) => {
      const first = getLL(path[0]);
      const last = getLL(path[path.length - 1]);
      let bestLoopIdx = 0, bestScore = Infinity, bestFirst = null, bestLast = null;
      loops.forEach((loop, li) => {
        if (loop.points.length === 0) return;
        const nf = nearestOnLoop(loop, first);
        const nl = nearestOnLoop(loop, last);
        const score = nf.d + nl.d;
        if (score < bestScore) { bestScore = score; bestLoopIdx = li; bestFirst = nf; bestLast = nl; }
      });
      if (!bestFirst) return;
      endpoints.push({ t: bestFirst.t, loopIdx: bestLoopIdx, normal: bestFirst.normal, pathIdx: idx, which: 'start' });
      endpoints.push({ t: bestLast.t, loopIdx: bestLoopIdx, normal: bestLast.normal, pathIdx: idx, which: 'end' });
    });
    if (endpoints.length === 0) return [];

    const rings = [];
    const byLoop = new Map();
    endpoints.forEach(e => {
      if (!byLoop.has(e.loopIdx)) byLoop.set(e.loopIdx, []);
      byLoop.get(e.loopIdx).push(e);
    });

    byLoop.forEach((groupEndpoints, loopIdx) => {
      const loop = loops[loopIdx];
      const sorted = groupEndpoints.slice().sort((a, b) => a.t - b.t);
      const n = sorted.length;
      if (n === 0) return;
      const L = loop.length || 1e-9;
      const L2 = 0.28 * (loop.diag || 1e-9);
      const isMaskLoop = loopIdx !== 0;

      const endpointIndex = new Map();
      sorted.forEach((e, i) => endpointIndex.set(`${e.pathIdx}:${e.which}`, i));

      const T_EPS = 1e-7;
      const sampleLoopVal = (tRaw) => {
        const t = ((tRaw % L) + L) % L;
        const pts = loop.points;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          if (Math.abs(a.t - t) < T_EPS) return a.val;
          const b = pts[(i + 1) % pts.length];
          const bt = (i === pts.length - 1) ? b.t + L : b.t;
          if (Math.abs(bt - t) < T_EPS) return b.val;
          if (t >= a.t && t <= bt) {
            if (a.val === null || b.val === null || isNaN(a.val) || isNaN(b.val)) return null;
            const span = (bt - a.t) || 1e-9;
            return a.val + (b.val - a.val) * ((t - a.t) / span);
          }
        }
        return pts.length ? pts[0].val : null;
      };

      const boundaryWalk = (tFrom, tTo) => {
        let span = tTo - tFrom;
        while (span <= 1e-9) span += L;
        const nodes = loop.points
          .map(node => ({ node, rel: (((node.t - tFrom) % L) + L) % L }))
          .filter(({ rel }) => rel > 1e-9 && rel < span - 1e-9)
          .sort((a, b) => a.rel - b.rel);
        if (nodes.length === 0) return [];

        if (isMaskLoop) {
          return nodes.map(({ node }) => ({ lat: node.lat, lon: node.lon }));
        }

        let localMax = 0;
        nodes.forEach(({ node }) => {
          const excess = (node.val === null || isNaN(node.val)) ? 0 : Math.max(0, node.val - level);
          if (excess > localMax) localMax = excess;
        });

        return nodes.map(({ node, rel }) => {
          const relPos = rel / span;
          const envelope = Math.sin(Math.PI * relPos);
          const excess = (node.val === null || isNaN(node.val)) ? 0 : Math.max(0, node.val - level);
          const dataFrac = localMax > 1e-9 ? excess / localMax : 0;
          const dist = L2 * envelope * (0.3 + 0.7 * dataFrac);
          return { lat: node.lat + node.normal.lat * dist, lon: node.lon + node.normal.lon * dist };
        });
      };

      const arcInsideForward = new Array(n);
      for (let i = 0; i < n; i++) {
        const tA = sorted[i].t;
        let tB = sorted[(i + 1) % n].t;
        if (tB <= tA) tB += L;
        const v = sampleLoopVal((tA + tB) / 2);
        arcInsideForward[i] = v !== null && v >= level;
      }

      const usedEndpoint = new Array(n).fill(false);

      for (let s = 0; s < n; s++) {
        if (usedEndpoint[s]) continue;

        const segments = [];
        let curIdx = s;
        let closedOk = false;
        let guard = 0;

        while (guard++ <= n + 2) {
          if (usedEndpoint[curIdx]) { closedOk = false; break; }
          usedEndpoint[curIdx] = true;

          const ep = sorted[curIdx];
          const path = openPaths[ep.pathIdx];
          let curvePts, otherIdx;
          if (ep.which === 'start') {
            curvePts = path.map(getLL);
            otherIdx = endpointIndex.get(`${ep.pathIdx}:end`);
          } else {
            curvePts = path.slice().reverse().map(getLL);
            otherIdx = endpointIndex.get(`${ep.pathIdx}:start`);
          }
          if (otherIdx === undefined) { closedOk = false; break; }
          usedEndpoint[otherIdx] = true;

          const prevIdx = (otherIdx - 1 + n) % n;
          const forward = arcInsideForward[otherIdx];
          const backward = arcInsideForward[prevIdx];

          let nextIdx, boundaryPts;
          if (forward && !backward) {
            nextIdx = (otherIdx + 1) % n;
            boundaryPts = boundaryWalk(sorted[otherIdx].t, sorted[nextIdx].t);
          } else if (backward && !forward) {
            nextIdx = prevIdx;
            boundaryPts = boundaryWalk(sorted[nextIdx].t, sorted[otherIdx].t).reverse();
          } else if (forward) {
            nextIdx = (otherIdx + 1) % n;
            boundaryPts = boundaryWalk(sorted[otherIdx].t, sorted[nextIdx].t);
          } else { closedOk = false; break; }

          segments.push({ curvePts, boundaryPtsAfter: boundaryPts, startNormal: ep.normal, endNormal: sorted[otherIdx].normal });

          if (nextIdx === s) { closedOk = true; break; }
          curIdx = nextIdx;
        }

        const ring = [];
        if (closedOk) {
          // Second pass: now that every segment's neighbours are known,
          // extend each path's own ends past the boundary along its tangent
          // *only* where it joins directly to another path's tip (no
          // boundary-walk stretch in between).
          const m = segments.length;
          for (let i = 0; i < m; i++) {
            const prevBoundary = segments[(i - 1 + m) % m].boundaryPtsAfter;
            const extrapStart = prevBoundary.length === 0;
            const extrapEnd = segments[i].boundaryPtsAfter.length === 0;
            ring.push(...this.tangentExtrapolate(
              segments[i].curvePts, loop.diag, extrapStart, extrapEnd,
              segments[i].startNormal, segments[i].endNormal
            ));
            ring.push(...segments[i].boundaryPtsAfter);
          }
        }

        if (closedOk && ring.length >= 3) rings.push(ring);
      }
    });

    return rings;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Interior holes
  // ═══════════════════════════════════════════════════════════════════

  /**
   * A mask loop (loops[1:] — loops[0] is always the literal bounding
   * rectangle) traces the edge of a "no data" island: e.g. a park a GPS track
   * walks around but never crosses. closeOpenPaths only ever consumes a mask
   * loop to CLOSE an open isoline that touches it — an island with no isoline
   * path reaching it at all (nothing crosses this level anywhere near it)
   * would otherwise never be referenced again, and would silently get painted
   * over solid instead of staying an unfilled hole.
   *
   * Finds, for each ring, which mask loops fall geometrically inside it and
   * should be cut out as holes.
   *
   * A ring that was itself closed via closeOpenPaths often directly
   * incorporates long stretches of a mask loop's own points (boundaryWalk
   * copies them verbatim) — that loop's centroid then trivially tests as
   * "inside" the ring, which would misidentify the ring's own boundary as a
   * hole of itself. Guarded with an area check: a genuine interior island is
   * always meaningfully smaller than the ring it punches a hole in, never
   * comparable to it.
   *
   * @param {Array} rings - closed rings for one isoband level (see closeOpenPaths / raw closed isolines)
   * @param {Array} loops - pre-built boundary loops (see buildBoundaryLoops)
   * @returns {Array<Array>} one hole-list per ring (parallel to `rings`), each a list of point arrays
   */
  static findInteriorHoles(rings, loops) {
    return rings.map(ring => {
      const ringArea = GeoUtils.shoelaceArea(ring);
      const holes = [];
      for (let i = 1; i < loops.length; i++) {
        const loopPts = loops[i].points;
        if (!loopPts || loopPts.length < 3) continue;
        const loopArea = GeoUtils.shoelaceArea(loopPts);
        if (loopArea > ringArea * 0.5) continue; // too close in size — likely the ring's own boundary, not an interior island
        let cLat = 0, cLon = 0;
        loopPts.forEach(p => { cLat += p.lat; cLon += p.lon; });
        cLat /= loopPts.length; cLon /= loopPts.length;
        if (GeoUtils.pointInPolygon(cLat, cLon, ring)) {
          holes.push(loopPts.map(p => ({ lat: p.lat, lon: p.lon })));
        }
      }
      return holes;
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Orchestration
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Full pipeline from raw per-level Marching Squares segments to closed,
   * hole-aware isoband rings: stitch segments into paths, split into
   * already-closed vs. edge-cut-off (open) paths, close the open ones against
   * the grid/mask boundary loops, and detect interior holes.
   *
   * @param {Array<{level:number, ratio:number, segments:Array}>} contours
   * @param {number[][]} grid - the (possibly upsampled) value grid contours were traced on
   * @param {number} rows
   * @param {number} cols
   * @param {{minLat,minLon,maxLat,maxLon}} bounds
   * @returns {Array<{ratio:number, rings:Array, holesByRingIndex:Array<Array>}>}
   */
  static buildIsobandRings(contours, grid, rows, cols, bounds) {
    const loops = this.buildBoundaryLoops(grid, rows, cols, bounds);

    return contours.map(c => {
      const stitchedPaths = (typeof GSRSpatialClustering !== 'undefined' && typeof GSRSpatialClustering.stitchSegments === 'function')
        ? GSRSpatialClustering.stitchSegments(c.segments)
        : (c.segments || []).map(seg => [seg[0], seg[1]]);

      const isClosedPath = (rawPath) => rawPath.length >= 3 &&
        Math.abs((rawPath[0].lat ?? rawPath[0][0]) - (rawPath[rawPath.length - 1].lat ?? rawPath[rawPath.length - 1][0])) < 1e-9 &&
        Math.abs((rawPath[0].lon ?? rawPath[0][1]) - (rawPath[rawPath.length - 1].lon ?? rawPath[rawPath.length - 1][1])) < 1e-9;

      const closedPaths = [];
      const openPaths = [];
      stitchedPaths.forEach(rawPath => {
        if (!rawPath || rawPath.length < 2) return;
        (isClosedPath(rawPath) ? closedPaths : openPaths).push(rawPath);
      });

      // Edge-touching rings — closed against real grid boundary loops.
      const closedFromOpen = this.closeOpenPaths(openPaths, loops, c.level);

      const rings = [...closedPaths, ...closedFromOpen];
      const holesByRingIndex = this.findInteriorHoles(rings, loops);

      return { ratio: c.ratio, rings, holesByRingIndex };
    });
  }
}

if (typeof window !== 'undefined') window.ContourRingGeometry = ContourRingGeometry;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ContourRingGeometry };
}
