/**
 * Multi-track Spatial Aggregation for Collective Map Surface.
 * Extracted from analyzer.js — pure spatial concern, no GSR analysis logic.
 */

class GSRCollectiveManager {
  constructor() {
    this.tracks = []; // { id, name, color, enabled, analyzer, filterParams }
  }

  addTrack(track) {
    // Phase 1 (slice 1): normalize tracks that predate the layerGroup field so
    // GSRMapManager can always rely on it being present (null = owns nothing).
    if (track && track.layerGroup === undefined) track.layerGroup = null;
    this.tracks.push(track);
  }

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
    // Defaults to true — the "Standardize arousal range" checkbox ships checked (see
    // index.html), so a caller that omits this entirely should get the same on-by-default
    // behavior as the UI, not silently fall back to unnormalized.
    const useNormalization = contourParams.normalizeZScore !== undefined ? contourParams.normalizeZScore : true;

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

      // Phasic AUC (ISCR) — continuous, threshold-independent alternative to
      // discrete peak counting (see docs/environmental_stress_literature_review.md
      // §5B/§5D). Z-score it per-track when normalizing, same convention as
      // phasic/tonic above, so cross-participant comparison stays fair.
      const aucRaw = t.analyzer.phasicAUC || [];
      let phasicAUC = aucRaw;
      if (useNormalization && aucRaw.length > 0) {
        const aucStats = GsrFilter.calculateStats(aucRaw.map(d => d.val));
        phasicAUC = aucRaw.map(d => ({ time: d.time, val: (d.val - aucStats.mean) / aucStats.std }));
      }

      // Combined Arousal Index is already a per-participant z-scored blend of
      // tonic + phasic AUC at computation time (computeCombinedArousalIndex in
      // analyzer.js), so it's used as-is regardless of the normalizeZScore
      // toggle — re-normalizing an already-standardized index would just
      // rescale it, not change its cross-participant comparability.
      const arousalIndex = t.analyzer.arousalIndex || [];

      const baseFsStep = Math.max(1, Math.round(t.analyzer.sampleRate || 10.0));
      const step       = baseFsStep * globalStride;

      for (let i = 0; i < rawData.length; i += step) {
        const coords = t.analyzer.getCoordinates(i);
        if (coords) {
          points.push({
            lat: coords.lat,
            lon: coords.lon,
            phasic: (phasic[i] ? phasic[i].val : 0),
            tonic: (tonic[i] ? tonic[i].val : 0),
            phasicAUC: (phasicAUC[i] ? phasicAUC[i].val : 0),
            arousalIndex: (arousalIndex[i] ? arousalIndex[i].val : 0)
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
    let grid = Array.from({ length: rows }, () => new Array(cols).fill(null));

    const latMid = (bounds.minLat + bounds.maxLat) / 2;
    const DEG_TO_M_LAT = 111320.0;
    const DEG_TO_M_LON = 111320.0 * Math.cos(latMid * Math.PI / 180);

    const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
      const dy = (lat1 - lat2) * DEG_TO_M_LAT;
      const dx = (lon1 - lon2) * DEG_TO_M_LON;
      return Math.sqrt(dx * dx + dy * dy);
    };

    // Reference (mean) amplitude across all active peaks, for the same clamped
    // relative-severity weighting used by the cluster blobs (spatial_clustering.js
    // GSRSpatialClustering.relativeAmplitudeWeight) — see PEAK_KDE in constants.js for why
    // this needs to be shared rather than reimplemented here.
    let peaksRefAmplitude = 0;
    if (peaks.length > 0) {
      let sum = 0;
      for (const pk of peaks) sum += (pk.amplitude || 0);
      peaksRefAmplitude = sum / peaks.length;
    }
    const peakSigma = (typeof GSR_CONST !== 'undefined' && GSR_CONST.PEAK_KDE) ? GSR_CONST.PEAK_KDE.sigma : 15.0;

    let minVal = Infinity, maxVal = -Infinity;

    const latStep = rows > 1 ? (bounds.maxLat - bounds.minLat) / (rows - 1) : 0;
    const lonStep = cols > 1 ? (bounds.maxLon - bounds.minLon) / (cols - 1) : 0;
    const gridLatOf = (r) => bounds.minLat + (r / (rows - 1)) * (bounds.maxLat - bounds.minLat);
    const gridLonOf = (c) => bounds.minLon + (c / (cols - 1)) * (bounds.maxLon - bounds.minLon);
    // Window (in grid rows/cols) that could possibly fall within `meters` of
    // a point at (lat, lon) — used by both splats below to avoid touching
    // every cell for every point (see the perf note further down).
    const cellWindowFor = (lat, lon, meters) => {
      const radLatDeg = meters / DEG_TO_M_LAT;
      const radLonDeg = meters / DEG_TO_M_LON;
      const rRad = latStep > 0 ? Math.max(1, Math.ceil(radLatDeg / latStep)) : rows;
      const cRad = lonStep > 0 ? Math.max(1, Math.ceil(radLonDeg / lonStep)) : cols;
      const centerRow = latStep > 0 ? Math.round((lat - bounds.minLat) / latStep) : 0;
      const centerCol = lonStep > 0 ? Math.round((lon - bounds.minLon) / lonStep) : 0;
      return {
        rMin: Math.max(0, centerRow - rRad), rMax: Math.min(rows - 1, centerRow + rRad),
        cMin: Math.max(0, centerCol - cRad), cMax: Math.min(cols - 1, centerCol + cRad)
      };
    };

    // Boundary mask — is this cell within isolationRadius of ANY (sampled)
    // walk-track point? Splat each sampled point onto its own small window
    // of nearby cells instead of, per cell, scanning every sampled point
    // with an early break — same "is any point near" answer (see below),
    // computed without the O(rows*cols*sampledPoints) worst case (a cell
    // far from every track — which happens for most of the grid outside a
    // track's own corridor — used to scan the ENTIRE sampled point set
    // before concluding "not near").
    //
    // Equivalence: the original's fallback `minTrackDist > isolationRadius`
    // check only ever runs when `!isNearTrack` — i.e. no sampled point was
    // within isolationRadius — which by construction already means every
    // sampled distance exceeded isolationRadius, so minTrackDist (their min)
    // must exceed it too. The fallback condition is therefore always true
    // exactly when isNearTrack is false, making the mask equivalent to
    // "was any sampled point within isolationRadius of this cell" — which is
    // what the splat below computes directly. Verified empirically against
    // the original cell-major scan on real tracks, not just by this
    // derivation (see tests/test_collective_manager.js).
    const checkStep = Math.max(1, Math.floor(points.length / (rows * cols * 2)));
    const nearTrack = new Uint8Array(rows * cols);
    for (let i = 0; i < points.length; i += checkStep) {
      const p = points[i];
      const w = cellWindowFor(p.lat, p.lon, isolationRadius);
      for (let r = w.rMin; r <= w.rMax; r++) {
        const gridLat = gridLatOf(r);
        const rowOff = r * cols;
        for (let c = w.cMin; c <= w.cMax; c++) {
          const idx = rowOff + c;
          if (nearTrack[idx]) continue;
          const dist = getDistanceMeters(gridLat, gridLonOf(c), p.lat, p.lon);
          if (dist <= isolationRadius) nearTrack[idx] = 1;
        }
      }
    }

    // Continuous (non-peak) topography sources: raw phasic/tonic, or the
    // threshold-independent Phasic AUC / Combined Arousal Index. Same splat
    // restructuring as the boundary mask above — point-major instead of
    // cell-major — for the identical reason: the vast majority of
    // (cell, point) pairs are beyond isolationRadius*1.5 and get discarded
    // after computing a distance for nothing. Found via real A/B
    // benchmarking (docs/visualizer_architecture_refactor_plan.md Phase 7):
    // this was the dominant cost of generateContourSurface() on a real
    // 5-track collective fixture (up to CONTOUR_MAX_POINTS=20,000 points x
    // gridResolution^2 cells, unindexed).
    const sumWeightedVal = new Float64Array(rows * cols);
    const sumWeight = new Float64Array(rows * cols);
    const localMaxArr = new Float64Array(rows * cols).fill(-Infinity);
    const exactMatchVal = new Float64Array(rows * cols);
    const hasExactMatch = new Uint8Array(rows * cols);
    if (topographySource !== 'peaks') {
      const idwRadius = isolationRadius * 1.5;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const pointVal = topographySource === 'tonic' ? p.tonic :
                          topographySource === 'auc' ? p.phasicAUC :
                          topographySource === 'arousal_index' ? p.arousalIndex :
                          p.phasic;
        const w = cellWindowFor(p.lat, p.lon, idwRadius);
        for (let r = w.rMin; r <= w.rMax; r++) {
          const gridLat = gridLatOf(r);
          const rowOff = r * cols;
          for (let c = w.cMin; c <= w.cMax; c++) {
            const idx = rowOff + c;
            if (!nearTrack[idx] || hasExactMatch[idx]) continue;
            const d = getDistanceMeters(gridLat, gridLonOf(c), p.lat, p.lon);
            if (d < 1e-3) {
              exactMatchVal[idx] = pointVal;
              hasExactMatch[idx] = 1;
              continue;
            }
            if (d <= idwRadius) {
              const wt = 1.0 / Math.pow(d, idwExponent);
              sumWeightedVal[idx] += wt * pointVal;
              sumWeight[idx] += wt;
              if (pointVal > localMaxArr[idx]) localMaxArr[idx] = pointVal;
            }
          }
        }
      }
    }

    const alpha = GSR_CONST.COLLECTIVE.peakPreservation !== undefined ? GSR_CONST.COLLECTIVE.peakPreservation : 0.5;

    for (let r = 0; r < rows; r++) {
      const gridLat = gridLatOf(r);
      const rowOff = r * cols;
      for (let c = 0; c < cols; c++) {
        const idx = rowOff + c;
        if (!nearTrack[idx]) {
          grid[r][c] = null;
          continue;
        }
        const gridLon = gridLonOf(c);

        if (topographySource === 'peaks') {
          // Peak count is typically far smaller than the point set above
          // (dozens-to-hundreds vs up to 20,000) — left as a direct scan,
          // not restructured; see this phase's status note for why this
          // branch wasn't prioritized.
          let density = 0;
          for (const pk of peaks) {
            const d = getDistanceMeters(gridLat, gridLon, pk.lat, pk.lon);
            const weight = (typeof GSRSpatialClustering !== 'undefined')
              ? GSRSpatialClustering.relativeAmplitudeWeight(pk.amplitude, peaksRefAmplitude)
              : 1;
            density += weight * Math.exp(-(d * d) / (2 * peakSigma * peakSigma));
          }
          grid[r][c] = density;
        } else if (hasExactMatch[idx]) {
          grid[r][c] = exactMatchVal[idx];
        } else if (sumWeight[idx] > 0) {
          const weightedMean = sumWeightedVal[idx] / sumWeight[idx];
          // Blend the smooth IDW mean with the local peak envelope (the highest single
          // value recorded nearby) so a lone transient spike survives the merge instead
          // of being averaged down toward its calmer neighborhood — pure IDW mean was
          // the main reason isolated peaks disappeared from the surface entirely.
          grid[r][c] = (1 - alpha) * weightedMean + alpha * localMaxArr[idx];
        } else {
          grid[r][c] = null;
        }

        const val = grid[r][c];
        if (val !== null && !isNaN(val)) {
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }
    }

    if (minVal === Infinity || maxVal === -Infinity) return [];

    // Masked blur — smooths pure grid-quantization noise (the single-cell "wiggle" Marching
    // Squares traces literally, cell edge by cell edge) directly in the source field, before
    // any contour is extracted. This is safer than smoothing/simplifying the traced isolines
    // afterward: a per-line simplification pass moves each level's line independently and can
    // nudge two originally non-crossing, closely-spaced levels into crossing each other.
    // Isolines of one continuous scalar field are level sets of that same field and can
    // never cross regardless of how smooth it is, so blurring the field itself can only
    // reduce wiggle, never introduce a crossing artifact. Respects the null/no-data mask —
    // only valid cells contribute to a valid cell's blurred value — so the isolationRadius
    // boundary stays exactly where it was; a masked cell is never pulled toward its valid
    // neighbors nor vice versa.
    const blurred = Array.from({ length: rows }, () => new Array(cols).fill(null));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c] === null || isNaN(grid[r][c])) { blurred[r][c] = grid[r][c]; continue; }
        let sum = 0, weight = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            const v = grid[rr][cc];
            if (v === null || isNaN(v)) continue;
            // Tent-shaped 3x3 kernel ([1,2,1;2,4,2;1,2,1]/16 when all 9 neighbors are
            // valid) — a mild blur that reduces single-cell noise without washing out
            // real hotspot shape spanning multiple cells.
            const w = (dr === 0 && dc === 0) ? 4 : ((dr === 0 || dc === 0) ? 2 : 1);
            sum += v * w;
            weight += w;
          }
        }
        blurred[r][c] = weight > 0 ? sum / weight : grid[r][c];
      }
    }
    grid = blurred;

    // minVal/maxVal above were measured on the pre-blur grid; a weighted average can only
    // pull values toward their neighbors, never past the original extremes, but recompute
    // from the blurred grid anyway so the returned range (and the percentile levels below,
    // which read straight from `grid`) matches what's actually drawn.
    minVal = Infinity; maxVal = -Infinity;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (v !== null && !isNaN(v)) {
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
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
    const valRange = maxVal - minVal;

    // §C perf fix (2026-08-07): collect all unique levels first, then call
    // MarchingSquares.getContourLinesMulti() once (single O(R×C) grid pass)
    // instead of K separate getContourLines() calls (K × O(R×C)).
    // The dedup + fallback logic below is identical to the previous loop.
    const levelEntries = []; // [{ level, ratio }]
    for (let k = 1; k <= contourCount; k++) {
      const percentile = k / (contourCount + 1);
      const idx = Math.min(sortedVals.length - 1, Math.max(0, Math.round(percentile * (sortedVals.length - 1))));
      let level = sortedVals.length > 0 ? sortedVals[idx] : minVal;
      let ratio = percentile;

      let levelKey = level.toFixed(6);
      if (seenLevels.has(levelKey) && valRange > 1e-9) {
        // Fall back to a linear step across the value range if percentile rank hit a flat baseline plateau
        level = minVal + (k / (contourCount + 1)) * valRange;
        levelKey = level.toFixed(6);
        if (typeof StatsMath !== 'undefined' && typeof StatsMath.percentileRank === 'function' && sortedVals.length > 1) {
          ratio = StatsMath.percentileRank(level, sortedVals);
        }
      }

      if (seenLevels.has(levelKey)) continue;
      seenLevels.add(levelKey);
      levelEntries.push({ level, ratio });
    }

    // Single grid traversal for all levels.
    const sortedLevels = levelEntries.map(e => e.level).sort((a, b) => a - b);
    const multiResult = MarchingSquares.getContourLinesMulti(grid, rows, cols, bounds, sortedLevels);

    for (const { level, ratio } of levelEntries) {
      const segments = multiResult.get(level) || [];
      if (segments.length > 0) {
        contours.push({ level, ratio, segments });
      }
    }

    return { contours, grid, minVal, maxVal, bounds, sortedVals };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRCollectiveManager };
}
if (typeof window !== 'undefined') {
  window.GSRCollectiveManager = GSRCollectiveManager;
}
