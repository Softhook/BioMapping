/**
 * GPS Filter Pipeline — standalone helper functions for trajectory cleaning, gating, and display downsampling.
 */
const GpsPipeline = {

  /**
   * HDOP gate: rejects GPS anchors with poor satellite geometry.
   * Points without HDOP data are always kept.
   */
  applyHdopGate(pts, maxHdop = 3.0) {
    return pts.filter(d => isNaN(d.hdop) || d.hdop <= maxHdop);
  },

  /**
   * Fix-type gate: rejects "no fix" (type 1).
   * Points without fix_type (value 0) are kept.
   */
  applyFixTypeGate(pts, minFixType = 2) {
    if (minFixType < 2) return pts;
    return pts.filter(d => d.fixType == null || d.fixType === 0 || d.fixType >= minFixType);
  },

  /**
   * Pre-Kalman GPS filters (run before snap+enrich pass).
   */
  applyPreKalmanFilters(pts, smoothing = 0.5, maxSpeed = 3.0) {
    pts = GpsFilter.applyStopAveraging(pts);
    pts = GpsFilter.applySpeedFilter(pts, maxSpeed);
    pts = GpsFilter.applyVelocitySmoothing(pts, smoothing);
    return pts;
  },

  /**
   * Post-Kalman snap correction.
   */
  applySnapCorrection(gpsPoints, snappedGps) {
    if (!snappedGps) return gpsPoints;
    const result = [];
    for (const pt of gpsPoints) {
      const sg = snappedGps[pt.origIdx];
      if (sg && !isNaN(sg.alpha) && sg.alpha > 0 && !isNaN(sg.roadLat) && !isNaN(sg.roadLon)) {
        result.push({
          ...pt,
          lat: sg.alpha * sg.roadLat + (1 - sg.alpha) * pt.lat,
          lon: sg.alpha * sg.roadLon + (1 - sg.alpha) * pt.lon
        });
      } else {
        result.push(pt);
      }
    }
    return result;
  },

  /**
   * Reconstruct full 10 Hz filtered GPS path.
   */
  reconstructFilteredGps(analyzer, data, gpsPoints) {
    const filteredGps = new Array(data.length);
    const filteredMap = new Map();
    gpsPoints.forEach(p => filteredMap.set(p.origIdx, { lat: p.lat, lon: p.lon }));

    const validIndices = gpsPoints.map(p => p.origIdx).sort((a, b) => a - b);
    if (validIndices.length === 0) {
      for (let i = 0; i < data.length; i++) filteredGps[i] = { lat: NaN, lon: NaN };
      analyzer.filteredGps = filteredGps;
      return;
    }

    // Fill before first
    const firstIdx = validIndices[0];
    const firstCoord = filteredMap.get(firstIdx);
    for (let i = 0; i < firstIdx; i++) filteredGps[i] = { lat: firstCoord.lat, lon: firstCoord.lon };

    // Interpolate between valid points, leaving large gaps (>30s) as NaN
    const GPS_INTERP_MAX_GAP_S = 30;
    for (let k = 0; k < validIndices.length - 1; k++) {
      const idxA = validIndices[k], idxB = validIndices[k + 1];
      const cA = filteredMap.get(idxA), cB = filteredMap.get(idxB);
      filteredGps[idxA] = { lat: cA.lat, lon: cA.lon };
      const timeGap = data[idxB].time - data[idxA].time;
      if (timeGap > GPS_INTERP_MAX_GAP_S) {
        for (let i = idxA + 1; i < idxB; i++) {
          filteredGps[i] = { lat: NaN, lon: NaN };
        }
      } else {
        for (let i = idxA + 1; i < idxB; i++) {
          const ratio = (i - idxA) / (idxB - idxA);
          filteredGps[i] = { lat: cA.lat + ratio * (cB.lat - cA.lat), lon: cA.lon + ratio * (cB.lon - cA.lon) };
        }
      }
    }

    // Fill after last
    const lastIdx = validIndices[validIndices.length - 1];
    const lastCoord = filteredMap.get(lastIdx);
    for (let i = lastIdx; i < data.length; i++) filteredGps[i] = { lat: lastCoord.lat, lon: lastCoord.lon };

    analyzer.filteredGps = filteredGps;
  },

  /**
   * Cached version of reconstructFilteredGps.
   */
  reconstructFilteredGpsCached(analyzer, data, gpsPoints) {
    const n = gpsPoints.length;
    if (n === 0) {
      if (!analyzer._filteredGpsCacheKey) {
        GpsPipeline.reconstructFilteredGps(analyzer, data, gpsPoints);
        analyzer._filteredGpsCacheKey = 'empty';
      }
      return;
    }
    // Include lat/lon of first, mid, and last point so the cache invalidates
    // when the Kalman filter output changes (slider-driven Q/R changes).
    const first = gpsPoints[0], mid = gpsPoints[Math.floor(n / 2)], last = gpsPoints[n - 1];
    const key = `${first.origIdx}|${first.lat.toFixed(6)},${first.lon.toFixed(6)}|${mid.origIdx}|${mid.lat.toFixed(6)},${mid.lon.toFixed(6)}|${last.origIdx}|${last.lat.toFixed(6)},${last.lon.toFixed(6)}|${n}`;
    if (analyzer._filteredGpsCacheKey === key) return;

    GpsPipeline.reconstructFilteredGps(analyzer, data, gpsPoints);
    analyzer._filteredGpsCacheKey = key;
  },

  /**
   * Pick the positions [0, count) that survive display decimation: every `step`-th
   * position, always the last, plus any position whose origIdx is in forceIndexSet.
   * Shared by downsampleForDisplay() (operates on built point objects) and
   * buildDrawPoints() (operates on the raw valid-index list) so the stride /
   * trailing-point / forced-merge rule lives in exactly one place.
   *
   * @param {number} count - number of candidate positions
   * @param {number} step - decimation stride (1 = keep everything)
   * @param {function(number): number} origIdxAt - maps a position to its raw row index
   * @param {Set<number>} [forceIndexSet] - raw row indices that must survive the stride
   * @returns {number[]} chosen positions, ascending by origIdx
   */
  _pickDownsampleIndices(count, step, origIdxAt, forceIndexSet) {
    const picked = [];
    const included = new Set();
    for (let i = 0; i < count; i += step) {
      picked.push(i);
      included.add(i);
    }
    if (count > 0 && (count - 1) % step !== 0) {
      picked.push(count - 1);
      included.add(count - 1);
    }

    if (forceIndexSet && forceIndexSet.size > 0) {
      let addedForced = false;
      for (let i = 0; i < count; i++) {
        if (included.has(i)) continue;
        if (forceIndexSet.has(origIdxAt(i))) {
          picked.push(i);
          addedForced = true;
        }
      }
      if (addedForced) picked.sort((a, b) => origIdxAt(a) - origIdxAt(b));
    }

    return picked;
  },

  /**
   * Downsample already-built point objects for Leaflet display.
   *
   * The live 2D-map path uses buildDrawPoints() instead — the fused variant that
   * builds and decimates in one pass from raw rows. This form is kept for callers
   * that already hold a full point array (globe3d, e2e/unit tests).
   *
   * @param {Set<number>} [forceIndexSet] - analyzer.raw row indices (matched
   *   against each point's .origIdx) that must survive the stride even when
   *   they'd otherwise be skipped — see GSRAnalyzer._detectRfPeakIndices().
   */
  downsampleForDisplay(gpsPoints, sampleRate, doDownsample, forceIndexSet) {
    const step = doDownsample ? Math.max(1, Math.round(sampleRate)) : 1;
    const positions = GpsPipeline._pickDownsampleIndices(
      gpsPoints.length, step, i => gpsPoints[i].origIdx, forceIndexSet
    );
    return positions.map(i => ({ ...gpsPoints[i] }));
  },

  /**
   * Build drawPoints directly from raw data and the 10 Hz filteredGps array,
   * selecting downsampled indices first so only surviving points are constructed
   * with the full field set. Equivalent to building all valid points and then
   * calling downsampleForDisplay(), but avoids allocating and copying thousands
   * of full-width objects that are immediately thrown away.
   *
   * @param {Array<object>} data - raw CSV row objects
   * @param {Array<{lat: number, lon: number}>} filteredGps - reconstructed GPS coords
   * @param {number} sampleRate - decimation rate (caller supplies the fallback, e.g. `analyzer.sampleRate || 10.0`)
   * @param {boolean} doDownsample - whether downsampling is active
   * @param {Set<number>} [forceIndexSet] - indices forced to survive downsampling (RF peaks)
   * @returns {Array<object>} drawPoints
   */
  buildDrawPoints(data, filteredGps, sampleRate, doDownsample, forceIndexSet) {
    if (!data || data.length === 0 || !filteredGps || filteredGps.length === 0) return [];

    const validIndices = [];
    for (let i = 0; i < data.length; i++) {
      const fg = filteredGps[i];
      if (fg && !isNaN(fg.lat) && !isNaN(fg.lon)) validIndices.push(i);
    }
    const totalValid = validIndices.length;
    if (totalValid === 0) return [];

    const step = doDownsample ? Math.max(1, Math.round(sampleRate)) : 1;
    const positions = GpsPipeline._pickDownsampleIndices(
      totalValid, step, i => validIndices[i], forceIndexSet
    );

    const draw = new Array(positions.length);
    for (let j = 0; j < positions.length; j++) {
      const rawIdx = validIndices[positions[j]];
      const fg = filteredGps[rawIdx];
      draw[j] = {
        ...data[rawIdx],
        lat: fg.lat,
        lon: fg.lon,
        origIdx: rawIdx,
        // isRfPeak is tagged on the point (not looked up by origIdx downstream)
        // so it survives collective mode's concatenation of multiple tracks'
        // drawPoints, where origIdx collides across tracks — see
        // RFFluidRenderer._precalculateSpatialFans().
        isRfPeak: !!(forceIndexSet && forceIndexSet.has(rawIdx))
      };
    }

    return draw;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GpsPipeline };
}
if (typeof window !== 'undefined') {
  window.GpsPipeline = GpsPipeline;
}
