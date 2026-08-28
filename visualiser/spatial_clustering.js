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
    const dy = (parseFloat(lat1) - parseFloat(lat2)) * scale.degToMeterLat;
    const dx = (parseFloat(lon1) - parseFloat(lon2)) * scale.degToMeterLon;
    return dx * dx + dy * dy;
  }



  /**
   * Group peaks into clusters based on proximity.
   * Any two peaks within `maxDistanceMeters` of each other will be in the same cluster.
   *
   * @param {Array<{lat: number, lon: number}>} peaks - List of peak data objects.
   * @param {number} maxDistanceMeters - Grouping threshold in meters.
   * @returns {Array<Array<object>>} Array of clusters, where each cluster is an array of peak objects.
   */
  static clusterPeaks(peaks, maxDistanceMeters = 35, boundaryRadius = 18, sigma = 15) {
    if (!peaks || peaks.length === 0) return [];

    const limit = isNaN(parseFloat(maxDistanceMeters)) ? 35 : parseFloat(maxDistanceMeters);
    const bRad = isNaN(parseFloat(boundaryRadius)) ? 18 : parseFloat(boundaryRadius);
    const sig = isNaN(parseFloat(sigma)) ? 15 : parseFloat(sigma);

    const n = peaks.length;

    // Parse lat/lon once to avoid millions of parseFloat calls in nested loops
    const parsedPeaks = peaks.map(p => ({
      lat: parseFloat(p.lat),
      lon: parseFloat(p.lon),
      orig: p
    }));

    // Calculate an average latitude to scale longitude distance accurately
    const latMid = parsedPeaks.reduce((sum, p) => sum + p.lat, 0) / n;
    const scale = GSRSpatialClustering._getGeodesicScale(latMid);

    // Initialize clusters: each peak is initially in its own cluster
    const clusters = parsedPeaks.map((p, idx) => ({
      indices: [idx],
      points: [p.orig]
    }));

    // Precompute the distance matrix between all peaks in a single flat array
    const peakDist = new Float64Array(n * n);
    const scaleLat = scale.degToMeterLat;
    const scaleLon = scale.degToMeterLon;

    for (let i = 0; i < n; i++) {
      const pI = parsedPeaks[i];
      const iOffset = i * n;
      for (let j = i + 1; j < n; j++) {
        const pJ = parsedPeaks[j];
        const dy = (pI.lat - pJ.lat) * scaleLat;
        const dx = (pI.lon - pJ.lon) * scaleLon;
        const d = Math.sqrt(dx * dx + dy * dy);
        peakDist[iOffset + j] = d;
        peakDist[j * n + i] = d;
      }
    }

    // Function to calculate the merge condition threshold for a cluster
    const getClusterRadius = (size) => {
      if (size <= 1) return bRad * 1.05;
      return Math.sqrt(bRad * bRad + 2 * sig * sig * Math.log(size)) * 1.05;
    };

    // Cache cluster radii to avoid Math.log / Math.sqrt in the hot loop
    const radii = new Float64Array(n);
    radii.fill(bRad * 1.05);

    // Maintain a cluster-to-cluster distance matrix in a single flat array
    const clusterDist = new Float64Array(n * n);
    clusterDist.set(peakDist);

    // Maintain bestCandidate array: for each cluster i, bestCandidate[i] stores the target cluster j
    // and its merge violation score.
    const bestCandidate = new Array(n);

    // Active status tracker (replaces slow Set allocations)
    const active = new Uint8Array(n);
    active.fill(1);
    let activeCount = n;

    const updateBestCandidate = (i) => {
      let maxScore = -Infinity;
      let target = -1;
      const rI = radii[i];
      const rowOffset = i * n;
      for (let j = 0; j < n; j++) {
        if (j === i || active[j] === 0) continue;
        const rJ = radii[j];
        const threshold = Math.max(limit, rI + rJ);
        const score = threshold - clusterDist[rowOffset + j];
        if (score > maxScore) {
          maxScore = score;
          target = j;
        }
      }
      bestCandidate[i] = { target, score: maxScore };
    };

    // Initially calculate best candidates for all clusters
    for (let i = 0; i < n; i++) {
      updateBestCandidate(i);
    }

    while (activeCount > 1) {
      let maxScore = -Infinity;
      let mergeI = -1;

      // Find the cluster with the highest merge violation score
      for (let i = 0; i < n; i++) {
        if (active[i] === 0) continue;
        const candidate = bestCandidate[i];
        if (candidate && candidate.score > maxScore) {
          maxScore = candidate.score;
          mergeI = i;
        }
      }

      // If the maximum score is not positive, no more violations exist
      if (maxScore <= 0 || mergeI === -1) {
        break;
      }

      const mergeJ = bestCandidate[mergeI].target;

      // Merge cluster mergeJ into mergeI
      clusters[mergeI].points.push(...clusters[mergeJ].points);
      clusters[mergeI].indices.push(...clusters[mergeJ].indices);

      // Deactivate mergeJ
      active[mergeJ] = 0;
      activeCount--;

      // Update cluster boundary radius for the expanded mergeI cluster
      radii[mergeI] = getClusterRadius(clusters[mergeI].points.length);

      // Update the cluster-to-cluster distance matrix for mergeI
      const rowI = mergeI * n;
      const rowJ = mergeJ * n;
      for (let k = 0; k < n; k++) {
        if (active[k] === 0 || k === mergeI) continue;
        const d = Math.min(clusterDist[rowI + k], clusterDist[rowJ + k]);
        clusterDist[rowI + k] = d;
        clusterDist[k * n + mergeI] = d;
      }

      // Update bestCandidate for mergeI
      updateBestCandidate(mergeI);

      // Update other active clusters k in O(1) time each
      const rMergeI = radii[mergeI];
      for (let k = 0; k < n; k++) {
        if (active[k] === 0 || k === mergeI) continue;

        const rK = radii[k];
        const threshold = Math.max(limit, rK + rMergeI);
        const score = threshold - clusterDist[k * n + mergeI];

        if (bestCandidate[k].target === mergeI || bestCandidate[k].target === mergeJ) {
          bestCandidate[k] = { target: mergeI, score };
        } else {
          if (score > bestCandidate[k].score) {
            bestCandidate[k] = { target: mergeI, score };
          }
        }
      }
    }

    // Return the points of active clusters
    const result = [];
    for (let idx = 0; idx < n; idx++) {
      if (active[idx] === 1) {
        result.push(clusters[idx].points);
      }
    }
    return result;
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
   *   behavior for existing callers.
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
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    cluster.forEach(p => {
      const latVal = parseFloat(p.lat);
      const lonVal = parseFloat(p.lon);
      if (latVal < minLat) minLat = latVal;
      if (latVal > maxLat) maxLat = latVal;
      if (lonVal < minLon) minLon = lonVal;
      if (lonVal > maxLon) maxLon = lonVal;
    });

    const latMid = (minLat + maxLat) / 2;
    const scale = GSRSpatialClustering._getGeodesicScale(latMid);
    
    // Calculate required padding dynamically to prevent superposition boundary clipping at grid edges
    const peakCount = cluster.length;
    const paddingMeters = Math.sqrt(rThreshold * rThreshold + 2 * s * s * Math.log(Math.max(1, peakCount))) + 15;
    const padLat = paddingMeters / scale.degToMeterLat;
    const padLon = paddingMeters / scale.degToMeterLon;
    
    const bounds = {
      minLat: minLat - padLat,
      maxLat: maxLat + padLat,
      minLon: minLon - padLon,
      maxLon: maxLon + padLon
    };

    const rows = 70;
    const cols = 70;
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));

    // Precompute row latitudes and column longitudes to avoid arithmetic inside nested loops
    const lats = [];
    for (let r = 0; r < rows; r++) {
      lats.push(bounds.minLat + (r / (rows - 1)) * (bounds.maxLat - bounds.minLat));
    }
    const lons = [];
    for (let c = 0; c < cols; c++) {
      lons.push(bounds.minLon + (c / (cols - 1)) * (bounds.maxLon - bounds.minLon));
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

    const latStep = (bounds.maxLat - bounds.minLat) / (rows - 1);
    const lonStep = (bounds.maxLon - bounds.minLon) / (cols - 1);
    const cutoffLatDeg = cutoffMeters / scale.degToMeterLat;
    const cutoffLonDeg = cutoffMeters / scale.degToMeterLon;
    const rRadius = Math.max(1, Math.ceil(cutoffLatDeg / latStep));
    const cRadius = Math.max(1, Math.ceil(cutoffLonDeg / lonStep));

    // Calculate density at each grid cell, one peak's window at a time.
    for (let i = 0; i < m; i++) {
      const pk = cluster[i];
      const w = weightForPeak(pk);
      const pkLat = parseFloat(pk.lat);
      const pkLon = parseFloat(pk.lon);
      const centerRow = Math.round((pkLat - bounds.minLat) / latStep);
      const centerCol = Math.round((pkLon - bounds.minLon) / lonStep);
      const rMin = Math.max(0, centerRow - rRadius);
      const rMax = Math.min(rows - 1, centerRow + rRadius);
      const cMin = Math.max(0, centerCol - cRadius);
      const cMax = Math.min(cols - 1, centerCol + cRadius);

      for (let r = rMin; r <= rMax; r++) {
        const lat = lats[r];
        const gridRow = grid[r];
        for (let c = cMin; c <= cMax; c++) {
          const dSq = GSRSpatialClustering._getDistanceMetersSq(lat, lons[c], pk.lat, pk.lon, scale);
          if (dSq > cutoffDSq) continue;
          gridRow[c] += w * Math.exp(-dSq / twoSigmaSq);
        }
      }
    }

    // Solve for isolevel: where density = Math.exp(-rThreshold^2 / (2 * s * s))
    const isolevel = Math.exp(-(rThreshold * rThreshold) / (twoSigmaSq));

    // Run marching squares to extract contour lines
    if (typeof MarchingSquares === 'undefined') {
      console.warn("MarchingSquares is not defined. Cannot generate concave blobs.");
      return [];
    }
    const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, isolevel);
    
    // Stitch segments into continuous paths
    const paths = GSRSpatialClustering.stitchSegments(segments);

    // Filter out degenerate paths and empty islands (loops that contain no peak points)
    return paths.filter(path => {
      if (path.length < 3) return false;
      return cluster.some(peak => GeoUtils.pointInPolygon(peak.lat, peak.lon, path));
    });
  }

  /**
   * Stitch short line segments from Marching Squares into continuous closed/open paths.
   */
  static stitchSegments(segments) {
    if (!segments || segments.length === 0) return [];
    
    const remaining = [...segments];
    const paths = [];
    const EPS = 1e-6; // lat/lon tolerance (roughly ~10cm)
    
    const distance = (p1, p2) => Math.hypot(p1.lat - p2.lat, p1.lon - p2.lon);
    
    while (remaining.length > 0) {
      let current = remaining.shift();
      let path = [current[0], current[1]];
      let added = true;
      
      while (added) {
        added = false;
        const endPoint = path[path.length - 1];
        
        for (let i = 0; i < remaining.length; i++) {
          const seg = remaining[i];
          if (distance(endPoint, seg[0]) < EPS) {
            path.push(seg[1]);
            remaining.splice(i, 1);
            added = true;
            break;
          } else if (distance(endPoint, seg[1]) < EPS) {
            path.push(seg[0]);
            remaining.splice(i, 1);
            added = true;
            break;
          }
        }
        
        if (!added) {
          // Try matching at the start
          const startPoint = path[0];
          for (let i = 0; i < remaining.length; i++) {
            const seg = remaining[i];
            if (distance(startPoint, seg[0]) < EPS) {
              path.unshift(seg[1]);
              remaining.splice(i, 1);
              added = true;
              break;
            } else if (distance(startPoint, seg[1]) < EPS) {
              path.unshift(seg[0]);
              remaining.splice(i, 1);
              added = true;
              break;
            }
          }
        }
      }
      
      // Filter out degenerate paths (must have at least 3 points to form a polygon)
      if (path.length >= 3) {
        paths.push(path);
      }
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
