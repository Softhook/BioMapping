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
   * Group peaks into clusters based on proximity.
   * Any two peaks within `maxDistanceMeters` of each other will be in the same cluster.
   *
   * @param {Array<{lat: number, lon: number}>} peaks - List of peak data objects.
   * @param {number} maxDistanceMeters - Grouping threshold in meters.
   * @returns {Array<Array<object>>} Array of clusters, where each cluster is an array of peak objects.
   */
  static clusterPeaks(peaks, maxDistanceMeters = 35) {
    if (!peaks || peaks.length === 0) return [];

    let limit = parseFloat(maxDistanceMeters);
    if (isNaN(limit)) limit = 35;

    const n = peaks.length;
    const adj = Array.from({ length: n }, () => []);

    // Calculate an average latitude to scale longitude distance accurately
    const latMid = peaks.reduce((sum, p) => sum + parseFloat(p.lat), 0) / n;
    const scale = GSRSpatialClustering._getGeodesicScale(latMid);

    // Build the adjacency graph
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dist = GSRSpatialClustering._getDistanceMeters(peaks[i].lat, peaks[i].lon, peaks[j].lat, peaks[j].lon, scale);
        if (dist <= limit) {
          adj[i].push(j);
          adj[j].push(i);
        }
      }
    }

    // BFS to find connected components (clusters)
    const visited = new Set();
    const clusters = [];

    for (let i = 0; i < n; i++) {
      if (!visited.has(i)) {
        const cluster = [];
        const queue = [i];
        visited.add(i);

        while (queue.length > 0) {
          const u = queue.shift();
          cluster.push(peaks[u]);
          for (const v of adj[u]) {
            if (!visited.has(v)) {
              visited.add(v);
              queue.push(v);
            }
          }
        }
        clusters.push(cluster);
      }
    }

    return clusters;
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
    
    // Add padding to ensure the grid covers the entire field where density is non-trivial
    const paddingMeters = rThreshold * 2.2;
    const padLat = paddingMeters / scale.degToMeterLat;
    const padLon = paddingMeters / scale.degToMeterLon;
    
    const bounds = {
      minLat: minLat - padLat,
      maxLat: maxLat + padLat,
      minLon: minLon - padLon,
      maxLon: maxLon + padLon
    };

    const rows = 35;
    const cols = 35;
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
    return GSRSpatialClustering.stitchSegments(segments);
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
