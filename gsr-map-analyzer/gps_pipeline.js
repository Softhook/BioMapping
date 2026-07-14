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
   * Downsample points for Leaflet display.
   */
  downsampleForDisplay(gpsPoints, sampleRate, doDownsample) {
    const step = doDownsample ? Math.max(1, Math.round(sampleRate)) : 1;
    const draw = [];
    for (let i = 0; i < gpsPoints.length; i += step) {
      draw.push({ ...gpsPoints[i] });
    }
    if (gpsPoints.length > 0 && (gpsPoints.length - 1) % step !== 0) {
      draw.push({ ...gpsPoints[gpsPoints.length - 1] });
    }
    return draw;
  }
};
