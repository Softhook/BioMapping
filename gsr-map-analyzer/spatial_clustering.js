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
   * Helper to compute distance in meters between two lat/lon coordinates using precomputed scale factors.
   *
   * @param {number} lat1 - Point 1 latitude.
   * @param {number} lon1 - Point 1 longitude.
   * @param {number} lat2 - Point 2 latitude.
   * @param {number} lon2 - Point 2 longitude.
   * @param {{degToMeterLat: number, degToMeterLon: number}} scale - Scale factors.
   * @returns {number} Geodesic distance in meters.
   * @private
   */
  static _getDistanceMeters(lat1, lon1, lat2, lon2, scale) {
    const dy = (parseFloat(lat1) - parseFloat(lat2)) * scale.degToMeterLat;
    const dx = (parseFloat(lon1) - parseFloat(lon2)) * scale.degToMeterLon;
    return Math.sqrt(dx * dx + dy * dy);
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
   * Ray Casting Algorithm (Point-in-Polygon) to check if a lat/lon point lies inside a path boundary.
   *
   * @param {{lat: number, lon: number}} point - The point to test.
   * @param {Array<{lat: number, lon: number}>} polygon - The polygon path vertices.
   * @returns {boolean} True if the point is inside the polygon.
   * @private
   */
  static _isPointInPolygon(point, polygon) {
    const x = parseFloat(point.lon), y = parseFloat(point.lat);
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = parseFloat(polygon[i].lon), yi = parseFloat(polygon[i].lat);
      const xj = parseFloat(polygon[j].lon), yj = parseFloat(polygon[j].lat);
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
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

    // 1. Initialize clusters: each peak is initially in its own cluster
    const clusters = parsedPeaks.map((p, idx) => ({
      indices: [idx],
      points: [p.orig]
    }));

    // 2. Precompute the distance matrix between all peaks in a single flat array
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

    // Maintain a cluster-to-cluster distance matrix in a single flat array
    const clusterDist = new Float64Array(n * n);
    clusterDist.set(peakDist);

    // Maintain bestCandidate array: for each cluster i, bestCandidate[i] stores the index of the cluster j
    // that has the maximum merge violation score with i.
    const bestCandidate = new Array(n);

    const updateBestCandidate = (i, activeIndices) => {
      let maxScore = -Infinity;
      let target = -1;
      const rI = getClusterRadius(clusters[i].points.length);
      const rowOffset = i * n;
      for (const j of activeIndices) {
        if (j === i) continue;
        const rJ = getClusterRadius(clusters[j].points.length);
        const threshold = Math.max(limit, rI + rJ);
        const score = threshold - clusterDist[rowOffset + j];
        if (score > maxScore) {
          maxScore = score;
          target = j;
        }
      }
      bestCandidate[i] = { target, score: maxScore };
    };

    // Active indices of clusters
    const activeIndices = new Set(Array.from({ length: n }, (_, i) => i));

    // Initially calculate best candidates for all clusters
    for (let i = 0; i < n; i++) {
      updateBestCandidate(i, activeIndices);
    }

    while (activeIndices.size > 1) {
      let maxScore = -Infinity;
      let mergeI = -1;

      // Find the cluster with the highest merge violation score
      for (const i of activeIndices) {
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

      // Remove mergeJ from active indices
      activeIndices.delete(mergeJ);

      // Update the cluster-to-cluster distance matrix for mergeI
      const rowI = mergeI * n;
      const rowJ = mergeJ * n;
      for (const k of activeIndices) {
        if (k === mergeI) continue;
        const d = Math.min(clusterDist[rowI + k], clusterDist[rowJ + k]);
        clusterDist[rowI + k] = d;
        clusterDist[k * n + mergeI] = d;
      }

      // Update bestCandidate for mergeI by scanning active clusters
      updateBestCandidate(mergeI, activeIndices);

      // Update other clusters k in O(1) time each
      const rMergeI = getClusterRadius(clusters[mergeI].points.length);
      for (const k of activeIndices) {
        if (k === mergeI) continue;

        const rK = getClusterRadius(clusters[k].points.length);
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
    for (const idx of activeIndices) {
      result.push(clusters[idx].points);
    }
    return result;
  }

  /**
   * Generates rounded, concave boundary polygons for a cluster of peaks.
   * Uses a local density grid calculation and Marching Squares.
   *
   * @param {Array<{lat: number, lon: number}>} cluster - List of peaks in this cluster.
   * @param {number} sigma - Gaussian kernel standard deviation in meters.
   * @param {number} thresholdRadius - Desired boundary radius in meters around a single peak.
   * @returns {Array<Array<{lat: number, lon: number}>>} Array of paths (closed loops).
   */
  static getConcaveBlob(cluster, sigma = 15, thresholdRadius = 18) {
    if (!cluster || cluster.length === 0) return [];
    
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

    // Calculate density at each grid cell
    for (let r = 0; r < rows; r++) {
      const lat = lats[r];
      for (let c = 0; c < cols; c++) {
        const lon = lons[c];
        
        let density = 0;
        for (let i = 0; i < m; i++) {
          const pk = cluster[i];
          const dSq = GSRSpatialClustering._getDistanceMetersSq(lat, lon, pk.lat, pk.lon, scale);
          density += Math.exp(-dSq / twoSigmaSq);
        }
        grid[r][c] = density;
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
      return cluster.some(peak => GSRSpatialClustering._isPointInPolygon(peak, path));
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
window.GSRSpatialClustering = GSRSpatialClustering;
