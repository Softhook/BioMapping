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
      for (let i = 0; i < data.length; i++) {
        const coords = t.analyzer.getCoordinates(i);
        if (coords) {
          if (coords.lat < minLat) minLat = coords.lat;
          if (coords.lat > maxLat) maxLat = coords.lat;
          if (coords.lon < minLon) minLon = coords.lon;
          if (coords.lon > maxLon) maxLon = coords.lon;
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
    const useNormalization = contourParams.normalizeZScore !== undefined ? contourParams.normalizeZScore : false;

    const bounds = this.getBounds();
    if (!bounds) return [];

    // Expand bounds by the isolationRadius buffer (with a 20% margin) to ensure that the
    // contour surface interpolator is not chopped off at the grid margins.
    const tempLatMid = (bounds.minLat + bounds.maxLat) / 2;
    const mToLat = 111320.0;
    const mToLon = 111320.0 * Math.cos(tempLatMid * Math.PI / 180);
    const latExpansion = (isolationRadius * 1.2) / mToLat;
    const lonExpansion = (isolationRadius * 1.2) / mToLon;
    bounds.minLat -= latExpansion;
    bounds.maxLat += latExpansion;
    bounds.minLon -= lonExpansion;
    bounds.maxLon += lonExpansion;

    const active = this.getActiveTracks();
    if (active.length === 0) return [];

    // Adaptive downsampling — target ~20k points for ~30 ms loop
    let totalRawPoints = 0;
    active.forEach(t => totalRawPoints += t.analyzer.raw.length);
    const globalStride = Math.max(1, Math.round(totalRawPoints / GSR_CONST.CONTOUR_MAX_POINTS));

    const points = [];
    const peaks  = [];

    for (const t of active) {
      const rawData    = t.analyzer.raw;
      const phasic     = useNormalization ? (t.analyzer.phasicZ || []) : (t.analyzer.phasic || []);
      const tonic      = useNormalization ? (t.analyzer.tonicZ  || []) : (t.analyzer.tonic  || []);
      const baseFsStep = Math.max(1, Math.round(t.analyzer.sampleRate || 10.0));
      const step       = baseFsStep * globalStride;

      for (let i = 0; i < rawData.length; i += step) {
        const coords = t.analyzer.getCoordinates(i);
        if (coords) {
          points.push({ 
            lat: coords.lat, 
            lon: coords.lon, 
            phasic: (phasic[i] ? phasic[i].val : 0), 
            tonic: (tonic[i] ? tonic[i].val : 0) 
          });
        }
      }

      // If normalizing, scale peak amplitudes by the cached standard deviation of the participant's phasic values.
      // This is a standard psychophysiological normalization (SCR amplitude in units of background variance).
      const phasicStd = useNormalization ? (t.analyzer.phasicStd || 1) : 1;

      t.analyzer.peaks.forEach(pk => {
        if (pk.excluded) return;
        const coords = t.analyzer.getCoordinates(pk.index);
        if (coords) {
          const amplitude = useNormalization ? (pk.amplitude / phasicStd) : pk.amplitude;
          peaks.push({ lat: coords.lat, lon: coords.lon, amplitude });
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
          let localMax = -Infinity;
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
              if (val > localMax) localMax = val;
            }
          }
          if (!exactMatch) {
            if (sumWeight > 0) {
              const weightedMean = sumWeightedVal / sumWeight;
              // Blend the smooth IDW mean with the local peak envelope (the highest single
              // value recorded nearby) so a lone transient spike survives the merge instead
              // of being averaged down toward its calmer neighborhood — pure IDW mean was
              // the main reason isolated peaks disappeared from the surface entirely.
              const alpha = GSR_CONST.COLLECTIVE.peakPreservation !== undefined ? GSR_CONST.COLLECTIVE.peakPreservation : 0.5;
              grid[r][c] = (1 - alpha) * weightedMean + alpha * localMax;
            } else {
              grid[r][c] = null;
            }
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

    // Collect every valid (non-masked) grid value to build percentile-based contour levels.
    // Equal-interval levels (old behavior: minVal + k * (maxVal-minVal)/(n+1)) waste most of
    // their resolution on the flat low-arousal majority whenever a handful of hotspots pull
    // maxVal far above the rest of the surface — nine of ten lines end up bunched on top of
    // each other describing baseline, and the actual peak area gets one or two lines total.
    // Percentile levels instead guarantee the levels are spread across where the data's
    // *distribution* actually varies, regardless of the raw magnitude spread.
    const sortedVals = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (v !== null && !isNaN(v)) sortedVals.push(v);
      }
    }
    sortedVals.sort((a, b) => a - b);

    const contours = [];
    const seenLevels = new Set();
    for (let k = 1; k <= contourCount; k++) {
      const percentile = k / (contourCount + 1);
      const idx = Math.min(sortedVals.length - 1, Math.max(0, Math.round(percentile * (sortedVals.length - 1))));
      const level = sortedVals.length > 0 ? sortedVals[idx] : minVal;

      // Skip duplicate levels — common when a large flat region shares the same interpolated
      // value, which would otherwise draw a redundant (or contour-less) line at that level.
      const levelKey = level.toFixed(6);
      if (seenLevels.has(levelKey)) continue;
      seenLevels.add(levelKey);

      const segments = MarchingSquares.getContourLines(grid, rows, cols, bounds, level);
      if (segments.length > 0) {
        // ratio = percentile rank (not magnitude ratio), so line color reflects "how high is
        // this relative to the rest of the surface" rather than "how high on a scale that's
        // mostly empty".
        contours.push({ level, ratio: percentile, segments });
      }
    }

    return { contours, grid, minVal, maxVal, bounds, sortedVals };
  }
}
