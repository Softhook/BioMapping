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
   * Upsamples a 2D value grid (e.g. the coarse gridResolution×gridResolution
   * surface generateContourSurface interpolates) to a higher target
   * resolution, for smoother Marching Squares tracing than the raw grid
   * would allow. Bicubic where a cell's full 4x4 neighborhood is valid
   * (non-null) data; bilinear (weighted by whichever corners are valid) as a
   * fallback at masked/boundary cells, where a full bicubic neighborhood
   * isn't available.
   *
   * The `sumWt > 1e-6` threshold below (rather than e.g. requiring majority
   * coverage) matters for the shape of the resulting mask boundary: since
   * bilinear weights vary continuously across a cell, a stricter threshold
   * would cut through that gradient unevenly and produce a visibly ragged
   * boundary at the edge of the valid-data region, rather than a smooth one.
   */
  static upsampleGrid(srcGrid, targetRows, targetCols) {
    const rows = srcGrid.length;
    const cols = srcGrid[0].length;
    const upsampled = Array.from({ length: targetRows }, () => new Array(targetCols).fill(null));

    function cubicInterpolate(p0, p1, p2, p3, t) {
      return 0.5 * (
        (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
        (-p0 + p2) * t +
        2 * p1
      );
    }

    for (let r = 0; r < targetRows; r++) {
      const srcR = (r / (targetRows - 1)) * (rows - 1);
      const r0 = Math.floor(srcR);
      const dr = srcR - r0;

      for (let c = 0; c < targetCols; c++) {
        const srcC = (c / (targetCols - 1)) * (cols - 1);
        const c0 = Math.floor(srcC);
        const dc = srcC - c0;

        // Check if we can perform bicubic interpolation (4x4 neighborhood must be fully in-bounds and non-null)
        let useBicubic = false;
        if (r0 - 1 >= 0 && r0 + 2 < rows && c0 - 1 >= 0 && c0 + 2 < cols) {
          useBicubic = true;
          for (let i = -1; i <= 2; i++) {
            for (let j = -1; j <= 2; j++) {
              const val = srcGrid[r0 + i][c0 + j];
              if (val === null || isNaN(val)) {
                useBicubic = false;
                break;
              }
            }
            if (!useBicubic) break;
          }
        }

        if (useBicubic) {
          const p = [];
          for (let i = -1; i <= 2; i++) {
            p[i + 1] = [];
            const rowIdx = r0 + i;
            for (let j = -1; j <= 2; j++) {
              p[i + 1][j + 1] = srcGrid[rowIdx][c0 + j];
            }
          }

          const rVals = [];
          for (let i = 0; i < 4; i++) {
            rVals[i] = cubicInterpolate(p[i][0], p[i][1], p[i][2], p[i][3], dc);
          }

          upsampled[r][c] = cubicInterpolate(rVals[0], rVals[1], rVals[2], rVals[3], dr);
        } else {
          // Bilinear fallback for boundary/masked cells
          const r1 = Math.min(rows - 1, r0 + 1);
          const c1 = Math.min(cols - 1, c0 + 1);

          const v00 = srcGrid[r0][c0];
          const v01 = srcGrid[r0][c1];
          const v10 = srcGrid[r1][c0];
          const v11 = srcGrid[r1][c1];

          let sumVal = 0;
          let sumWt = 0;

          const w00 = (1 - dr) * (1 - dc);
          const w01 = (1 - dr) * dc;
          const w10 = dr * (1 - dc);
          const w11 = dr * dc;

          if (v00 !== null && !isNaN(v00)) { sumVal += v00 * w00; sumWt += w00; }
          if (v01 !== null && !isNaN(v01)) { sumVal += v01 * w01; sumWt += w01; }
          if (v10 !== null && !isNaN(v10)) { sumVal += v10 * w10; sumWt += w10; }
          if (v11 !== null && !isNaN(v11)) { sumVal += v11 * w11; sumWt += w11; }

          if (sumWt > 1e-6) {
            upsampled[r][c] = sumVal / sumWt;
          } else {
            upsampled[r][c] = null;
          }
        }
      }
    }
    return upsampled;
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
    const coverageWeighting = contourParams.coverageWeighting !== undefined ? contourParams.coverageWeighting : GSR_CONST.COLLECTIVE.coverageWeighting;
    // Defaults to true — the "Standardize arousal range" checkbox ships checked (see
    // index.html), so a caller that omits this entirely should get the same on-by-default
    // behavior as the UI, not silently fall back to unnormalized.
    const useNormalization = contourParams.normalizeZScore !== undefined ? contourParams.normalizeZScore : true;

    const blurIterations = contourParams.blurIterations !== undefined
      ? contourParams.blurIterations
      : (GSR_CONST.COLLECTIVE.blurIterations !== undefined ? GSR_CONST.COLLECTIVE.blurIterations : 3);
    const upsampledResolution = contourParams.upsampledResolution !== undefined
      ? contourParams.upsampledResolution
      : (GSR_CONST.COLLECTIVE.upsampledResolution !== undefined ? GSR_CONST.COLLECTIVE.upsampledResolution : 160);
    const softening = (contourParams && contourParams.softening !== undefined)
      ? contourParams.softening
      : (GSR_CONST.COLLECTIVE.softening !== undefined ? GSR_CONST.COLLECTIVE.softening : 0.0);
    const temporalSmoothingWindow = (contourParams && contourParams.temporalSmoothingWindow !== undefined)
      ? contourParams.temporalSmoothingWindow
      : (GSR_CONST.COLLECTIVE.temporalSmoothingWindow !== undefined ? GSR_CONST.COLLECTIVE.temporalSmoothingWindow : 0.0);

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
    // [start, end) index ranges into `points` for each track, used below to compute the
    // coverage field per-track (see "Coverage field" block) without re-deriving track
    // boundaries — a track contributed no points is simply omitted.
    const trackPointRanges = [];

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

      // Implement O(N) running-sum moving average
      function getSmoothArray(arr, windowSize) {
        if (!arr || arr.length === 0) return new Float64Array(0);
        const result = new Float64Array(arr.length);
        const half = Math.floor(windowSize / 2);
        let sum = 0;
        let count = 0;
        
        // Initialize sum for initial window [0, half - 1]
        for (let j = 0; j < Math.min(arr.length, half); j++) {
          const v = arr[j] ? arr[j].val : null;
          if (v !== null && !isNaN(v)) {
            sum += v;
            count++;
          }
        }
        
        for (let j = 0; j < arr.length; j++) {
          // Add element entering window on the right
          const rightIdx = j + half;
          if (rightIdx < arr.length) {
            const v = arr[rightIdx] ? arr[rightIdx].val : null;
            if (v !== null && !isNaN(v)) {
              sum += v;
              count++;
            }
          }
          // Remove element leaving window on the left
          const leftIdx = j - half - 1;
          if (leftIdx >= 0) {
            const v = arr[leftIdx] ? arr[leftIdx].val : null;
            if (v !== null && !isNaN(v)) {
              sum -= v;
              count--;
            }
          }
          result[j] = count > 0 ? sum / count : 0;
        }
        return result;
      }

      const Fs = t.analyzer.sampleRate || 10.0;
      const windowSize = Math.round(Fs * temporalSmoothingWindow);
      const doSmoothing = windowSize > 1;

      const smoothPhasic = doSmoothing ? getSmoothArray(phasic, windowSize) : null;
      const smoothTonic = doSmoothing ? getSmoothArray(tonic, windowSize) : null;
      const smoothAUC = doSmoothing ? getSmoothArray(phasicAUC, windowSize) : null;
      const smoothArousal = doSmoothing ? getSmoothArray(arousalIndex, windowSize) : null;

      const baseFsStep = Math.max(1, Math.round(Fs));
      const step       = baseFsStep * globalStride;

      const trackStartIdx = points.length;
      for (let i = 0; i < rawData.length; i += step) {
        const coords = t.analyzer.getCoordinates(i);
        if (coords) {
          points.push({
            lat: coords.lat,
            lon: coords.lon,
            phasic: doSmoothing ? smoothPhasic[i] : (phasic[i] ? phasic[i].val : 0),
            tonic: doSmoothing ? smoothTonic[i] : (tonic[i] ? tonic[i].val : 0),
            phasicAUC: doSmoothing ? smoothAUC[i] : (phasicAUC[i] ? phasicAUC[i].val : 0),
            arousalIndex: doSmoothing ? smoothArousal[i] : (arousalIndex[i] ? arousalIndex[i].val : 0)
          });
        }
      }
      if (points.length > trackStartIdx) {
        trackPointRanges.push({ start: trackStartIdx, end: points.length });
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

    // Coverage field — how many distinct participant tracks actually passed near each cell,
    // used to fade the rendered surface's opacity where the reading is backed by little
    // evidence (see the coverageWeighting param above). This answers a different question
    // than the value grid below: not "what's the arousal here" but "how much do we actually
    // know about this spot." Gated on coverageWeighting > 0 so leaving the slider off costs
    // nothing (same style as the topographySource !== 'peaks' gate below).
    //
    // Per-track max, not per-sample sum: a track that lingered at one spot for ten minutes at
    // 10Hz would otherwise dump thousands of correlated samples into one cell and look like
    // "heavy coverage" when it's really one person standing still. Splatting each track's own
    // samples with `max` first (so a track contributes at most its single closest approach to
    // a cell, regardless of how long it dwelled there or how many samples fell nearby), then
    // summing those per-track maxima across tracks, turns this into "how many distinct people
    // came near this spot" rather than "how many samples landed near this spot."
    let coverageRatioGrid = null;
    let upsampledCoverageRatioGrid = null;
    if (coverageWeighting > 0) {
      const coverageRadius = isolationRadius * 1.5; // same spatial scale as the IDW/envelope radius below
      const coverageSigma = coverageRadius / 3;
      const twoCovSigmaSq = 2 * coverageSigma * coverageSigma;
      const coverageGrid = new Float64Array(rows * cols);
      const trackMaxArr = new Float64Array(rows * cols); // reused scratch, reset per track below

      for (const range of trackPointRanges) {
        let touchedMinR = rows, touchedMaxR = -1, touchedMinC = cols, touchedMaxC = -1;
        for (let pi = range.start; pi < range.end; pi++) {
          const p = points[pi];
          const w = cellWindowFor(p.lat, p.lon, coverageRadius);
          if (w.rMin < touchedMinR) touchedMinR = w.rMin;
          if (w.rMax > touchedMaxR) touchedMaxR = w.rMax;
          if (w.cMin < touchedMinC) touchedMinC = w.cMin;
          if (w.cMax > touchedMaxC) touchedMaxC = w.cMax;
          for (let r = w.rMin; r <= w.rMax; r++) {
            const gridLat = gridLatOf(r);
            const rowOff = r * cols;
            for (let c = w.cMin; c <= w.cMax; c++) {
              const d = getDistanceMeters(gridLat, gridLonOf(c), p.lat, p.lon);
              if (d > coverageRadius) continue;
              const decay = Math.exp(-(d * d) / twoCovSigmaSq);
              const idx = rowOff + c;
              if (decay > trackMaxArr[idx]) trackMaxArr[idx] = decay;
            }
          }
        }
        // Fold this track's max-decay field into the running total, then reset only the
        // cells it touched (cheaper than clearing the whole scratch array every track).
        if (touchedMaxR >= touchedMinR) {
          for (let r = touchedMinR; r <= touchedMaxR; r++) {
            const rowOff = r * cols;
            for (let c = touchedMinC; c <= touchedMaxC; c++) {
              const idx = rowOff + c;
              if (trackMaxArr[idx] > 0) {
                coverageGrid[idx] += trackMaxArr[idx];
                trackMaxArr[idx] = 0;
              }
            }
          }
        }
      }

      // Percentile rank, not a fixed headcount threshold — deliberately relative to how
      // covered the REST of this loaded dataset is, not an absolute "3 people is confident"
      // rule. Matches the percentile-based contour levels further down for the same reason:
      // it self-scales whether the collective has 2 tracks or 200, rather than needing a
      // tuned constant that's meaningful for one dataset size and useless for another.
      const sortedCoverageVals = [];
      for (let idx = 0; idx < rows * cols; idx++) {
        if (nearTrack[idx]) sortedCoverageVals.push(coverageGrid[idx]);
      }
      sortedCoverageVals.sort((a, b) => a - b);

      const rankFn = (typeof StatsMath !== 'undefined' && StatsMath.percentileRank) ? StatsMath.percentileRank : null;
      coverageRatioGrid = Array.from({ length: rows }, () => new Array(cols).fill(null));
      for (let r = 0; r < rows; r++) {
        const rowOff = r * cols;
        for (let c = 0; c < cols; c++) {
          const idx = rowOff + c;
          if (!nearTrack[idx]) continue;
          coverageRatioGrid[r][c] = rankFn ? rankFn(coverageGrid[idx], sortedCoverageVals) : 1;
        }
      }
      upsampledCoverageRatioGrid = (upsampledResolution > gridResolution)
        ? GSRCollectiveManager.upsampleGrid(coverageRatioGrid, upsampledResolution, upsampledResolution)
        : coverageRatioGrid;
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
      // Envelope (local-max) contributions are distance-decayed with the same Gaussian
      // shape as the "Peak Stress Hotspots" KDE, sigma tied to idwRadius so it reaches
      // ~0 near the cutoff. Without this, a raw (non-decayed) max would stay flat right
      // out to idwRadius and then hard-cut off — since the IDW mean term *does* decay
      // continuously with distance, blending a flat plateau against it produces a dip
      // right at the crowded source point (where many low-value samples pull the mean
      // down) and a ring of falsely elevated value at the plateau's edge. Decaying the
      // envelope the same way keeps its peak exactly at the source point and lets both
      // terms fall off together.
      const envelopeSigma = idwRadius / 3;
      const twoEnvSigmaSq = 2 * envelopeSigma * envelopeSigma;
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
            if (softening === 0 && d < 1e-3) {
              exactMatchVal[idx] = pointVal;
              hasExactMatch[idx] = 1;
              continue;
            }
            if (d <= idwRadius) {
              const wt = 1.0 / Math.pow(d + softening, idwExponent);
              sumWeightedVal[idx] += wt * pointVal;
              sumWeight[idx] += wt;
              const envelopeVal = pointVal * Math.exp(-(d * d) / twoEnvSigmaSq);
              if (envelopeVal > localMaxArr[idx]) localMaxArr[idx] = envelopeVal;
            }
          }
        }
      }
    }

    const alpha = (contourParams && contourParams.peakPreservation !== undefined)
      ? contourParams.peakPreservation
      : (GSR_CONST.COLLECTIVE.peakPreservation !== undefined ? GSR_CONST.COLLECTIVE.peakPreservation : 0.5);

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
    // any contour is extracted.
    let currentGrid = grid;
    for (let iter = 0; iter < blurIterations; iter++) {
      const blurred = Array.from({ length: rows }, () => new Array(cols).fill(null));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (currentGrid[r][c] === null || isNaN(currentGrid[r][c])) {
            blurred[r][c] = currentGrid[r][c];
            continue;
          }
          let sum = 0, weight = 0;
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= rows) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc;
              if (cc < 0 || cc >= cols) continue;
              const v = currentGrid[rr][cc];
              if (v === null || isNaN(v)) continue;
              // Tent-shaped 3x3 kernel ([1,2,1;2,4,2;1,2,1]/16 when all 9 neighbors are
              // valid) — a mild blur that reduces single-cell noise without washing out
              // real hotspot shape spanning multiple cells.
              const w = (dr === 0 && dc === 0) ? 4 : ((dr === 0 || dc === 0) ? 2 : 1);
              sum += v * w;
              weight += w;
            }
          }
          blurred[r][c] = weight > 0 ? sum / weight : currentGrid[r][c];
        }
      }
      currentGrid = blurred;
    }
    grid = currentGrid;

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

    // Perform Bilinear upsampling on the blurred 40x40 grid to get a high-resolution 160x160 grid
    const upsampledGrid = (upsampledResolution > gridResolution)
      ? GSRCollectiveManager.upsampleGrid(grid, upsampledResolution, upsampledResolution)
      : grid;
    const upsampledRows = upsampledGrid.length;
    const upsampledCols = upsampledGrid[0].length;

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

    // Single grid traversal for all levels on the upsampled high-resolution grid.
    const sortedLevels = levelEntries.map(e => e.level).sort((a, b) => a - b);
    const multiResult = MarchingSquares.getContourLinesMulti(upsampledGrid, upsampledRows, upsampledCols, bounds, sortedLevels);

    for (const { level, ratio } of levelEntries) {
      const segments = multiResult.get(level) || [];
      if (segments.length > 0) {
        contours.push({ level, ratio, segments });
      }
    }

    return { contours, grid, upsampledGrid, minVal, maxVal, bounds, sortedVals, upsampledCoverageRatioGrid };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRCollectiveManager };
}
if (typeof window !== 'undefined') {
  window.GSRCollectiveManager = GSRCollectiveManager;
}
