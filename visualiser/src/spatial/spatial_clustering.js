/**
 * GSR Spatial Clustering Utility.
 * Groups stress peaks by geodesic distance and computes smooth, concave boundary paths.
 */
class GSRSpatialClustering {
  /**
   * Helper to compute conversion factors from degrees to meters at a given latitude.
   *
   * @param {number} lat - Latitude in degrees.
   * @returns {{degToMeterLat: number, degToMeterLon: number}} Scaling factors.
   * @private
   */
  static _getGeodesicScale(lat) {
    if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.getGeodesicScale === 'function') {
      return GeoUtils.getGeodesicScale(lat);
    }
    const DEG_TO_M_LAT = 111320.0;
    const degToMeterLon = DEG_TO_M_LAT * Math.cos(parseFloat(lat) * Math.PI / 180);
    return { degToMeterLat: DEG_TO_M_LAT, degToMeterLon };
  }

  /**
   * Helper to compute squared geodesic distance in meters (saves Math.sqrt for performance).
   *
   * @param {number} lat1 - Point 1 latitude.
   * @param {number} lon1 - Point 1 longitude.
   * @param {number} lat2 - Point 2 latitude.
   * @param {number} lon2 - Point 2 longitude.
   * @param {{degToMeterLat: number, degToMeterLon: number}} scale - Scale factors.
   * @returns {number} Squared geodesic distance in meters.
   * @private
   */
  static _getDistanceMetersSq(lat1, lon1, lat2, lon2, scale) {
    if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.distanceMetersSq === 'function') {
      return GeoUtils.distanceMetersSq(lat1, lon1, lat2, lon2, scale);
    }
    const dy = (parseFloat(lat1) - parseFloat(lat2)) * scale.degToMeterLat;
    const dx = (parseFloat(lon1) - parseFloat(lon2)) * scale.degToMeterLon;
    return dx * dx + dy * dy;
  }



  /**
   * Compact spatial clustering for the Arousal Places layer.
   *
   * Density-ordered leader assignment: every peak's local density (neighbours
   * within `radiusMeters`) is computed, then peaks are visited densest-first —
   * each still-unassigned peak seeds a place and claims every still-unassigned
   * peak within `radiusMeters` of it.
   *
   * Unlike single-linkage agglomeration, this CANNOT chain: a long dense
   * corridor walked by many tracks breaks into a row of compact "beads" instead
   * of collapsing into one monster cluster whose centroid lands off every path.
   * That centroid-off-the-path failure was what made large clusters score zero
   * dwell/energy in arousal_places.js.
   *
   * `separationFactor` keeps those beads from overlapping each other on the map:
   * a peak may only seed a NEW bead when it is at least `separationFactor *
   * radiusMeters` from every bead already seeded. A peak that is closer than
   * that to an existing seed but was not claimed by its `radiusMeters` ball
   * (the "ring" between R and separationFactor*R) is absorbed by the nearest
   * existing bead rather than spawning an overlapping neighbour. So bead centres
   * are provably >= separationFactor*R apart, and a bead spans at most
   * 2*separationFactor*R.
   *
   * @param {Array<{lat: number, lon: number}>} peaks
   * @param {number} radiusMeters - Neighbourhood radius (the UI merge distance).
   * @param {number} [separationFactor=1.8] - Minimum centre-to-centre spacing
   *   between beads, as a multiple of radiusMeters. Values < 1 are clamped to 1
   *   (seeds at least one ball apart); NaN falls back to the default.
   * @returns {Array<Array<object>>} Clusters of the original peak objects.
   */
  static compactClusters(peaks, radiusMeters = 35, separationFactor = 1.8) {
    if (!peaks || peaks.length === 0) return [];
    const n = peaks.length;
    const R = (isNaN(parseFloat(radiusMeters)) || parseFloat(radiusMeters) <= 0)
      ? 35 : parseFloat(radiusMeters);
    const SEP = isNaN(parseFloat(separationFactor))
      ? 1.8 : Math.max(1, parseFloat(separationFactor));
    const sepR2 = (R * SEP) * (R * SEP);

    // Project to a local metric plane (metres) centred on the mean position.
    let latSum = 0, lonSum = 0;
    for (let i = 0; i < n; i++) { latSum += parseFloat(peaks[i].lat); lonSum += parseFloat(peaks[i].lon); }
    const latMid = latSum / n;
    const lonMid = lonSum / n;
    const scale = GSRSpatialClustering._getGeodesicScale(latMid);

    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = (parseFloat(peaks[i].lon) - lonMid) * scale.degToMeterLon;
      y[i] = (parseFloat(peaks[i].lat) - latMid) * scale.degToMeterLat;
    }

    // Uniform grid index, cell = R, so a neighbour query only scans a 3x3 block.
    const cell = R;
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      const k = Math.floor(x[i] / cell) + '|' + Math.floor(y[i] / cell);
      let arr = grid.get(k);
      if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(i);
    }
    const R2 = R * R;
    const neighbours = (i) => {
      const cx = Math.floor(x[i] / cell);
      const cy = Math.floor(y[i] / cell);
      const out = [];
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const arr = grid.get(gx + '|' + gy);
          if (!arr) continue;
          for (let a = 0; a < arr.length; a++) {
            const j = arr[a];
            const dx = x[j] - x[i];
            const dy = y[j] - y[i];
            if (dx * dx + dy * dy <= R2) out.push(j);
          }
        }
      }
      return out;
    };

    const density = new Int32Array(n);
    const neigh = new Array(n);
    for (let i = 0; i < n; i++) {
      neigh[i] = neighbours(i);
      density[i] = neigh[i].length;
    }

    const order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => (density[b] - density[a]) || (a - b));

    const assigned = new Uint8Array(n);
    const seeds = []; // { x, y, members }
    for (let o = 0; o < n; o++) {
      const seed = order[o];
      if (assigned[seed]) continue;

      // Nearest bead we have already seeded.
      let near = null, nearD2 = Infinity;
      for (const s of seeds) {
        const dx = x[seed] - s.x, dy = y[seed] - s.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearD2) { nearD2 = d2; near = s; }
      }

      if (near && nearD2 <= sepR2) {
        // Inside the R..SEP*R ring — absorb rather than seed an overlapping bead.
        assigned[seed] = 1;
        near.members.push(peaks[seed]);
        continue;
      }

      // New bead: claim every still-unassigned peak within R. `seed` itself is
      // always in neigh[seed] (dx=dy=0), so `members` is never empty.
      const members = [];
      for (const j of neigh[seed]) {
        if (!assigned[j]) { assigned[j] = 1; members.push(peaks[j]); }
      }
      seeds.push({ x: x[seed], y: y[seed], members });
    }
    return seeds.map(s => s.members);
  }

  /**
   * Relative-severity weight for a single peak's contribution to a spatial density field,
   * scaled against a reference (e.g. mean) amplitude across the active dataset. Clamped so a
   * single extreme outlier can't blow the boundary out indefinitely, and so a below-average
   * peak doesn't vanish from the density field entirely — it should shrink its footprint, not
   * erase it.
   *
   * This is the single source of truth for "how much does one peak count" in a spatial KDE —
   * shared by getConcaveBlob's per-cluster blob boundaries and
   * collective_manager.js's global "Peak Stress Hotspots" contour surface, so both spatial
   * views of "actual peaks" agree on the same peak's relative weight instead of each
   * hardcoding their own (previously: clamped-relative here vs raw-unclamped there).
   *
   * @param {number} amplitude - The peak's own amplitude.
   * @param {number|null} refAmplitude - Reference (e.g. mean) amplitude across the dataset.
   *   When missing/non-positive, or when amplitude is invalid, every peak weighs 1 (unweighted).
   * @returns {number} Clamped relative weight, in [GSR_CONST.PEAK_KDE.ampWeightMin, ampWeightMax].
   */
  static relativeAmplitudeWeight(amplitude, refAmplitude) {
    const min = (typeof GSR_CONST !== 'undefined' && GSR_CONST.PEAK_KDE) ? GSR_CONST.PEAK_KDE.ampWeightMin : 0.55;
    const max = (typeof GSR_CONST !== 'undefined' && GSR_CONST.PEAK_KDE) ? GSR_CONST.PEAK_KDE.ampWeightMax : 3.0;
    if (typeof refAmplitude !== 'number' || refAmplitude <= 0) return 1;
    if (typeof amplitude !== 'number' || isNaN(amplitude)) return 1;
    const rel = amplitude / refAmplitude;
    return Math.max(min, Math.min(max, rel));
  }

  /**
   * Generates rounded, concave boundary polygons for a cluster of peaks.
   * Uses a local density grid calculation and Marching Squares.
   *
   * @param {Array<{lat: number, lon: number}>} cluster - List of peaks in this cluster.
   * @param {number} sigma - Gaussian kernel standard deviation in meters.
   * @param {number} thresholdRadius - Desired boundary radius in meters around a single peak.
   * @param {number|null} [refAmplitude=null] - Reference (e.g. mean) peak amplitude across the
   *   whole active dataset. When supplied, each peak's contribution to the density field is
   *   scaled by its amplitude relative to this reference, so a cluster of severe reactions
   *   grows a larger boundary than a cluster of equally-numerous mild ones. When omitted
   *   (default), every peak contributes equally — this preserves the original unweighted
   *   behaviour for existing callers.
   * @returns {Array<Array<{lat: number, lon: number}>>} Array of paths (closed loops).
   */
  static getConcaveBlob(cluster, sigma = 15, thresholdRadius = 18, refAmplitude = null) {
    if (!cluster || cluster.length === 0) return [];

    // Per-peak relative-severity weighting — see relativeAmplitudeWeight() above for the
    // shared clamp rationale. Note this preserves the isolevel-reachability guarantee that
    // motivated the 0.55 floor (a lone peak's density should still reach the boundary
    // isolevel given the default sigma/thresholdRadius pairing), just centralized.
    const weightForPeak = (pk) => GSRSpatialClustering.relativeAmplitudeWeight(pk.amplitude, refAmplitude);
    
    let s = parseFloat(sigma);
    if (isNaN(s) || s <= 0) s = 15;
    let rThreshold = parseFloat(thresholdRadius);
    if (isNaN(rThreshold) || rThreshold <= 0) rThreshold = 18;

    // Find bounds of the cluster
    const rawBounds = (typeof GeoUtils !== 'undefined' && typeof GeoUtils.computeBounds === 'function')
      ? GeoUtils.computeBounds(cluster)
      : null;
    if (!rawBounds) return [];

    // Calculate required padding dynamically to prevent superposition boundary clipping at grid edges
    const peakCount = cluster.length;
    const paddingMeters = Math.sqrt(rThreshold * rThreshold + 2 * s * s * Math.log(Math.max(1, peakCount))) + 15;
    const bounds = (typeof GeoUtils !== 'undefined' && typeof GeoUtils.expandBounds === 'function')
      ? GeoUtils.expandBounds(rawBounds, paddingMeters)
      : rawBounds;

    const latMid = (bounds.minLat + bounds.maxLat) / 2;
    const scale = GSRSpatialClustering._getGeodesicScale(latMid);

    const rows = 70;
    const cols = 70;

    // Flat Float64Array instead of 70 separate JS arrays — better cache locality,
    // lower allocation/GC cost, and faster index arithmetic in the KDE inner loop.
    // Access: flatGrid[r * cols + c]  ≡  oldGrid[r][c]
    const flatGrid = new Float64Array(rows * cols); // zero-initialised

    // Precompute row latitudes and column longitudes to avoid arithmetic inside nested loops
    const lats = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
      lats[r] = bounds.minLat + (r / (rows - 1)) * (bounds.maxLat - bounds.minLat);
    }
    const lons = new Float64Array(cols);
    for (let c = 0; c < cols; c++) {
      lons[c] = bounds.minLon + (c / (cols - 1)) * (bounds.maxLon - bounds.minLon);
    }

    const twoSigmaSq = 2 * s * s;
    const m = cluster.length;

    // A Gaussian kernel's contribution is negligible far past a few sigma —
    // at 6 sigma it's exp(-18) ~= 1.5e-8, and even summed across every peak
    // in the cluster in the worst case that's still ~4-5 orders of magnitude
    // below a typical isolevel threshold (~1e-4 to 1e-5 with this codebase's
    // defaults). Standard Gaussian-kernel truncation practice, not an
    // approximation that changes the rendered contour.
    //
    // Found via real A/B benchmarking (docs/archive/visualizer_architecture_refactor_plan.md
    // Phase 7): on a real 5-track/822-peak collective fixture, ~94% of
    // (grid cell, peak) pairs fell beyond this cutoff, and this loop was the
    // dominant cost of a full collective re-render (~87ms of ~115ms). A
    // first pass just skipped Math.exp() for far pairs but kept the
    // cell-major loop (scan every cell for every peak, discard most) — that
    // only bought ~20%, because V8's Math.exp() itself turned out to be
    // cheap (~0.5ns/call); the real cost was the ~4M row/col/peak loop
    // iterations and _getDistanceMetersSq() calls, 94% of which computed a
    // distance only to immediately discard it. Restructured to loop peaks
    // first and "splat" each one's contribution only onto the small
    // row/col window that could possibly be within cutoffDSq of it — same
    // physics, but the skipped pairs are never iterated at all instead of
    // being iterated then discarded.
    const CUTOFF_SIGMA = 6;
    const cutoffMeters = CUTOFF_SIGMA * s;
    const cutoffDSq = cutoffMeters * cutoffMeters;

    // Calculate density at each grid cell, one peak's window at a time.
    for (let i = 0; i < m; i++) {
      const pk = cluster[i];
      const w = weightForPeak(pk);
      const pkLat = parseFloat(pk.lat);
      const pkLon = parseFloat(pk.lon);
      const { rMin, rMax, cMin, cMax } = (typeof SpatialGrid !== 'undefined' && typeof SpatialGrid.computeCellWindow === 'function')
        ? SpatialGrid.computeCellWindow(pkLat, pkLon, cutoffMeters, bounds, rows, cols, scale.degToMeterLat, scale.degToMeterLon)
        : {
            rMin: Math.max(0, Math.round((pkLat - bounds.minLat) / ((bounds.maxLat - bounds.minLat) / (rows - 1))) - Math.max(1, Math.ceil((cutoffMeters / scale.degToMeterLat) / ((bounds.maxLat - bounds.minLat) / (rows - 1))))),
            rMax: Math.min(rows - 1, Math.round((pkLat - bounds.minLat) / ((bounds.maxLat - bounds.minLat) / (rows - 1))) + Math.max(1, Math.ceil((cutoffMeters / scale.degToMeterLat) / ((bounds.maxLat - bounds.minLat) / (rows - 1))))),
            cMin: Math.max(0, Math.round((pkLon - bounds.minLon) / ((bounds.maxLon - bounds.minLon) / (cols - 1))) - Math.max(1, Math.ceil((cutoffMeters / scale.degToMeterLon) / ((bounds.maxLon - bounds.minLon) / (cols - 1))))),
            cMax: Math.min(cols - 1, Math.round((pkLon - bounds.minLon) / ((bounds.maxLon - bounds.minLon) / (cols - 1))) + Math.max(1, Math.ceil((cutoffMeters / scale.degToMeterLon) / ((bounds.maxLon - bounds.minLon) / (cols - 1)))))
          };

      const degLat = scale.degToMeterLat;
      const degLon = scale.degToMeterLon;

      for (let r = rMin; r <= rMax; r++) {
        const dy = (lats[r] - pkLat) * degLat;
        const dy2 = dy * dy;
        if (dy2 > cutoffDSq) continue;
        const rowOffset = r * cols;
        for (let c = cMin; c <= cMax; c++) {
          const dx = (lons[c] - pkLon) * degLon;
          const dSq = dy2 + dx * dx;
          if (dSq > cutoffDSq) continue;
          flatGrid[rowOffset + c] += w * Math.exp(-dSq / twoSigmaSq);
        }
      }
    }

    // Solve for isolevel: where density = Math.exp(-rThreshold^2 / (2 * s * s))
    const isolevel = Math.exp(-(rThreshold * rThreshold) / (twoSigmaSq));

    // Run marching squares to extract contour lines.
    // MarchingSquares.getContourLines expects grid[r][c] semantics — build a
    // lightweight row-accessor array that reads from the flat buffer without
    // copying data. Each element is a Float64Array view over its own row slice.
    if (typeof MarchingSquares === 'undefined') {
      console.warn("MarchingSquares is not defined. Cannot generate concave blobs.");
      return [];
    }
    const gridRows = [];
    for (let r = 0; r < rows; r++) {
      gridRows.push(flatGrid.subarray(r * cols, r * cols + cols));
    }
    const segments = MarchingSquares.getContourLines(gridRows, rows, cols, bounds, isolevel);

    // Stitch segments into continuous paths
    const paths = GSRSpatialClustering.stitchSegments(segments);

    // Filter out degenerate paths and empty islands (loops that contain no peak points)
    return paths.filter(path => {
      if (path.length < 3) return false;
      return cluster.some(peak => GeoUtils.pointInPolygon(peak.lat, peak.lon, path));
    });
  }

  /**
   * Stitch short Marching-Squares line segments into continuous closed/open paths.
   *
   * Two-phase, O(S):
   *   1. Resolve every segment endpoint to a shared node id. Points within EPS
   *      (~10 cm) collapse to one node; a spatial hash keyed on EPS-sized cells
   *      keeps the lookup O(1) per endpoint (probe the 3×3 cell neighbourhood so
   *      a pair straddling a cell edge still merges) instead of O(S) pairwise.
   *   2. Walk the resulting node/edge graph: each still-unused segment seeds a
   *      path that is extended from its tail, then its head, following any
   *      unused incident edge until none remain.
   *
   * The graph is used only to decide connectivity; the emitted vertices are the
   * original endpoint objects, so for any input without a genuine >2-way node
   * the output matches the previous pairwise-scan implementation exactly (the
   * two disagree only in how they partition segments at a true junction, where
   * neither order is canonical).
   */
  static stitchSegments(segments) {
    if (!segments || segments.length === 0) return [];

    const EPS = 1e-6;              // lat/lon coincidence tolerance (~10 cm)
    const EPS_SQ = EPS * EPS;
    const cellOf = (v) => Math.floor(v / EPS);

    // ── Phase 1: endpoints → node ids ──────────────────────────────────────
    const nodePos = [];           // nodeId → { lat, lon } of the first endpoint seen there
    const cellNodes = new Map();  // "cx,cy" → nodeId[]

    const nodeIdFor = (p) => {
      const cx = cellOf(p.lon), cy = cellOf(p.lat);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const ids = cellNodes.get((cx + dx) + ',' + (cy + dy));
          if (!ids) continue;
          for (let n = 0; n < ids.length; n++) {
            const q = nodePos[ids[n]];
            const dLat = p.lat - q.lat, dLon = p.lon - q.lon;
            if (dLat * dLat + dLon * dLon < EPS_SQ) return ids[n];
          }
        }
      }
      const id = nodePos.length;
      nodePos.push(p);
      const key = cx + ',' + cy;
      let ids = cellNodes.get(key);
      if (!ids) { ids = []; cellNodes.set(key, ids); }
      ids.push(id);
      return id;
    };

    const segEnds = new Array(segments.length); // segIdx → [nodeA, nodeB]
    const incident = [];                        // nodeId → segIdx[]
    for (let i = 0; i < segments.length; i++) {
      const a = nodeIdFor(segments[i][0]);
      const b = nodeIdFor(segments[i][1]);
      segEnds[i] = [a, b];
      (incident[a] || (incident[a] = [])).push(i);
      (incident[b] || (incident[b] = [])).push(i);
    }

    // ── Phase 2: walk edges into polylines ────────────────────────────────
    const usedSeg = new Uint8Array(segments.length);
    const nextFrom = (node) => {
      const inc = incident[node];
      if (inc) {
        for (let k = 0; k < inc.length; k++) {
          if (!usedSeg[inc[k]]) return inc[k];
        }
      }
      return -1;
    };

    const paths = [];
    for (let i = 0; i < segments.length; i++) {
      if (usedSeg[i]) continue;
      usedSeg[i] = 1;

      let headNode = segEnds[i][0], tailNode = segEnds[i][1];
      const pts = [segments[i][0], segments[i][1]]; // original endpoint objects

      for (let e = nextFrom(tailNode); e !== -1; e = nextFrom(tailNode)) {
        usedSeg[e] = 1;
        const [a, b] = segEnds[e];
        const far = a === tailNode ? 1 : 0; // endpoint of e away from the join
        tailNode = a === tailNode ? b : a;
        pts.push(segments[e][far]);
      }
      for (let e = nextFrom(headNode); e !== -1; e = nextFrom(headNode)) {
        usedSeg[e] = 1;
        const [a, b] = segEnds[e];
        const far = a === headNode ? 1 : 0;
        headNode = a === headNode ? b : a;
        pts.unshift(segments[e][far]);
      }

      if (pts.length >= 3) paths.push(pts);
    }

    return paths;
  }
}

// Make globally available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRSpatialClustering };
}
if (typeof window !== 'undefined') {
  window.GSRSpatialClustering = GSRSpatialClustering;
}
