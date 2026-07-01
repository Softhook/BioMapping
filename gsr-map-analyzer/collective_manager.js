/**
 * Multi-track Spatial Aggregation for Collective Map Surface.
 * Extracted from analyzer.js — pure spatial concern, no GSR analysis logic.
 */

class GSRCollectiveManager {
  constructor() {
    this.tracks = []; // { id, name, color, enabled, analyzer, filterParams }
  }

  addTrack(track) { this.tracks.push(track); }

  removeTrack(id) { this.tracks = this.tracks.filter(t => t.id !== id); }

  getTrack(id) { return this.tracks.find(t => t.id === id); }

  getActiveTracks() { return this.tracks.filter(t => t.enabled); }

  /**
   * Tight bounding box enclosing all enabled paths (with 10 % padding).
   */
  getBounds() {
    const active = this.getActiveTracks();
    if (active.length === 0) return null;

    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    let hasCoords = false;

    for (const t of active) {
      const data = t.analyzer.raw;
      const filteredGps = t.analyzer.filteredGps || [];
      for (let i = 0; i < data.length; i++) {
        let lat = NaN, lon = NaN;
        if (filteredGps[i] && !isNaN(filteredGps[i].lat)) {
          lat = filteredGps[i].lat;
          lon = filteredGps[i].lon;
        } else if (data[i] && !isNaN(data[i].lat)) {
          lat = data[i].lat;
          lon = data[i].lon;
        }
        if (!isNaN(lat) && !isNaN(lon)) {
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          hasCoords = true;
        }
      }
    }
    if (!hasCoords) return null;

    const latSpan = maxLat - minLat;
    const lonSpan = maxLon - minLon;
    const latPad = latSpan > 0 ? latSpan * 0.10 : 0.001;
    const lonPad = lonSpan > 0 ? lonSpan * 0.10 : 0.001;
    return { minLat: minLat - latPad, maxLat: maxLat + latPad, minLon: minLon - lonPad, maxLon: maxLon + lonPad };
  }

  /**
   * Interpolate path values into a grid and extract topographic contour isolines.
   * Uses IDW (Inverse Distance Weighting) for continuous metrics or Gaussian kernel density for peaks.
   */
  generateContourSurface(contourParams) {
    if (!contourParams) contourParams = {};
    // Use explicit !== undefined checks so falsy values (0, false, '') are not silently overridden
    const gridResolution  = contourParams.gridResolution  !== undefined ? contourParams.gridResolution  : GSR_CONST.COLLECTIVE.gridResolution;
    const isolationRadius = contourParams.isolationRadius !== undefined ? contourParams.isolationRadius : GSR_CONST.COLLECTIVE.isolationRadius;
    const topographySource = contourParams.topographySource !== undefined ? contourParams.topographySource : 'phasic';
    const contourCount    = contourParams.contourCount    !== undefined ? contourParams.contourCount    : GSR_CONST.COLLECTIVE.contourCount;
    const idwExponent     = contourParams.idwExponent     !== undefined ? contourParams.idwExponent     : GSR_CONST.COLLECTIVE.idwExponent;

    const bounds = this.getBounds();
    if (!bounds) return [];

    const active = this.getActiveTracks();
    if (active.length === 0) return [];

    // Adaptive downsampling — target ~20k points for ~30 ms loop
    let totalRawPoints = 0;
    active.forEach(t => totalRawPoints += t.analyzer.raw.length);
    const globalStride = Math.max(1, Math.round(totalRawPoints / 20000));

    const points = [];
    const peaks  = [];

    for (const t of active) {
      const rawData    = t.analyzer.raw;
      const filteredGps = t.analyzer.filteredGps || [];
      const phasic     = t.analyzer.phasic || [];
      const tonic      = t.analyzer.tonic  || [];
      const baseFsStep = Math.max(1, Math.round(t.analyzer.sampleRate || 10.0));
      const step       = baseFsStep * globalStride;

      for (let i = 0; i < rawData.length; i += step) {
        let lat = NaN, lon = NaN;
        if (filteredGps[i] && !isNaN(filteredGps[i].lat)) {
          lat = filteredGps[i].lat;
          lon = filteredGps[i].lon;
        } else if (rawData[i] && !isNaN(rawData[i].lat)) {
          lat = rawData[i].lat;
          lon = rawData[i].lon;
        }
        if (!isNaN(lat) && !isNaN(lon)) {
          points.push({ lat, lon, phasic: (phasic[i] ? phasic[i].val : 0), tonic: (tonic[i] ? tonic[i].val : 0) });
        }
      }

      t.analyzer.peaks.forEach(pk => {
        const matchingRow = rawData[pk.index];
        let lat = NaN, lon = NaN;
        if (filteredGps[pk.index] && !isNaN(filteredGps[pk.index].lat)) {
          lat = filteredGps[pk.index].lat;
          lon = filteredGps[pk.index].lon;
        } else if (matchingRow && !isNaN(matchingRow.lat)) {
          lat = matchingRow.lat;
          lon = matchingRow.lon;
        }
        if (!isNaN(lat) && !isNaN(lon)) {
          peaks.push({ lat, lon, amplitude: pk.amplitude });
        }
      });
    }

    if (points.length === 0) return [];

    const rows = gridResolution;
    const cols = gridResolution;
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(null));

    const latMid = (bounds.minLat + bounds.maxLat) / 2;
    const DEG_TO_M_LAT = 111320.0;
    const DEG_TO_M_LON = 111320.0 * Math.cos(latMid * Math.PI / 180);

    const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
      const dy = (lat1 - lat2) * DEG_TO_M_LAT;
      const dx = (lon1 - lon2) * DEG_TO_M_LON;
      return Math.sqrt(dx * dx + dy * dy);
    };

    let minVal = Infinity, maxVal = -Infinity;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const gridLat = bounds.minLat + (r / (rows - 1)) * (bounds.maxLat - bounds.minLat);
        const gridLon = bounds.minLon + (c / (cols - 1)) * (bounds.maxLon - bounds.minLon);

        // Boundary mask — check proximity to any walk track
        // Sample at ~2x the stride of the contour grid to balance speed vs accuracy
        let isNearTrack = false;
        let minTrackDist = Infinity;
        const checkStep = Math.max(1, Math.floor(points.length / (rows * cols * 2)));
        for (let i = 0; i < points.length; i += checkStep) {
          const dist = getDistanceMeters(gridLat, gridLon, points[i].lat, points[i].lon);
          if (dist < minTrackDist) minTrackDist = dist;
          if (dist <= isolationRadius) { isNearTrack = true; break; }
        }
        if (!isNearTrack && minTrackDist > isolationRadius) {
          grid[r][c] = null;
          continue;
        }

        if (topographySource === 'peaks') {
          let density = 0;
          const sigma = 20.0;
          for (const pk of peaks) {
            const d = getDistanceMeters(gridLat, gridLon, pk.lat, pk.lon);
            density += pk.amplitude * Math.exp(-(d * d) / (2 * sigma * sigma));
          }
          grid[r][c] = density;
        } else {
          let sumWeightedVal = 0, sumWeight = 0;
          let exactMatch = false;
          for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const d = getDistanceMeters(gridLat, gridLon, p.lat, p.lon);
            if (d < 1e-3) {
              grid[r][c] = (topographySource === 'tonic') ? p.tonic : p.phasic;
              exactMatch = true;
              break;
            }
            if (d <= isolationRadius * 1.5) {
              const val = (topographySource === 'tonic') ? p.tonic : p.phasic;
              const w = 1.0 / Math.pow(d, idwExponent);
              sumWeightedVal += w * val;
              sumWeight += w;
            }
          }
          if (!exactMatch) {
            grid[r][c] = sumWeight > 0 ? (sumWeightedVal / sumWeight) : null;
          }
        }

        const val = grid[r][c];
        if (val !== null && !isNaN(val)) {
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }
    }

    if (minVal === Infinity || maxVal === -Infinity) return [];
    if (Math.abs(maxVal - minVal) < 1e-9) maxVal = minVal + 0.1;

    const contours = [];
    const levelStep = (maxVal - minVal) / (contourCount + 1);
    for (let k = 1; k <= contourCount; k++) {
      const level = minVal + k * levelStep;
      const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
      if (segments.length > 0) {
        contours.push({ level, ratio: (level - minVal) / (maxVal - minVal), segments });
      }
    }

    return { contours, grid, minVal, maxVal, bounds };
  }
}
