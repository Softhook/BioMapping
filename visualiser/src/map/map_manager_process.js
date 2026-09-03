/**
 * GSRMapManager — GPS pipeline processing. Prototype-augment split from map.js:
 * loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype. They turn an analyzer's raw rows + GPS filter params
 * into the `drawPoints` array every renderer works from, and cache the result
 * (this._gpsCache, keyed by track id + a params/snap fingerprint) so nudging a
 * GSR slider doesn't re-run the expensive filter chain.
 *
 * Depends on the globals GpsPipeline and GpsFilter (resolved at call time).
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Hash GPS filter params for cache key comparison.
   * Only hashes params that affect the GPS pipeline output.
   */
  _hashGpsParams(p) {
    return `${p.maxHdop || 3.0}|${p.smoothing || 0.5}|${p.kalmanR || 10}|${p.maxSpeed || 3.0}|${p.downsample ? 1 : 0}|${p.rdpTolerance || 0}`;
  },

  /**
   * Lightweight fingerprint of road-snap data so the cache invalidates
   * when OSM enrichment produces different snap results.
   */
  _snapFingerprint(snappedGps) {
    if (!snappedGps) return 'nosnap';
    const keys = Object.keys(snappedGps);
    const n = keys.length;
    if (n === 0) return 'nosnap';
    // Hash: count + first + mid + last alpha values
    const first = snappedGps[keys[0]];
    const mid   = snappedGps[keys[Math.floor(n / 2)]];
    const last  = snappedGps[keys[n - 1]];
    const fa = (first && typeof first.alpha === 'number') ? first.alpha.toFixed(3) : '?';
    const ma = (mid   && typeof mid.alpha === 'number')   ? mid.alpha.toFixed(3)   : '?';
    const la = (last  && typeof last.alpha === 'number')  ? last.alpha.toFixed(3)  : '?';
    return `${n}|${fa}|${ma}|${la}`;
  },

  /**
   * Run the full GPS filter pipeline and cache the result.
   * Returns { gpsPoints, drawPoints } — cached when params AND snap data
   * haven't changed.  Callers MUST NOT mutate the returned arrays.
   *
   * @param {string} cacheKey  – unique key for this track+params combo
   * @param {GSRAnalyzer} analyzer
   * @param {object} p         – GPS filter params
   * @returns {{ gpsPoints: Array, drawPoints: Array }}
   */
  _getOrBuildDrawPoints(cacheKey, analyzer, p) {
    const paramsHash = this._hashGpsParams(p);
    const snapFp    = this._snapFingerprint(analyzer.snappedGps);
    const cached = this._gpsCache.get(cacheKey);

    if (cached && cached.paramsHash === paramsHash && cached.snapFingerprint === snapFp) {
      // Return cached references — callers MUST NOT mutate
      return { gpsPoints: cached.gpsPoints, drawPoints: cached.drawPoints };
    }

    // ── Expensive GPS pipeline (only runs when params change) ──
    const data = analyzer.raw;
    let gpsPoints = this._collectGpsPoints(data);
    if (gpsPoints.length === 0) {
      this._gpsCache.set(cacheKey, { paramsHash, snapFingerprint: snapFp, gpsPoints: [], drawPoints: [] });
      return { gpsPoints: [], drawPoints: [] };
    }

    gpsPoints = GpsPipeline.applyHdopGate(gpsPoints, p.maxHdop || 3.0);
    gpsPoints = GpsPipeline.applyFixTypeGate(gpsPoints);

    const smoothing = p.smoothing || 0.5;
    const kalmanR   = p.kalmanR || 10;
    gpsPoints = GpsPipeline.applyPreKalmanFilters(gpsPoints, smoothing, p.maxSpeed || 3.0);

    if (analyzer.snappedGps) {
      gpsPoints = GpsPipeline.applySnapCorrection(gpsPoints, analyzer.snappedGps);
    }

    gpsPoints = GpsFilter.applyKalman(gpsPoints, smoothing, kalmanR);

    // Reconstruct full 10 Hz filtered GPS path (cached on analyzer)
    GpsPipeline.reconstructFilteredGpsCached(analyzer, data, gpsPoints);

    // Build drawPoints from the 10 Hz reconstructed filtered GPS path
    const filteredGps = analyzer.filteredGps;
    let drawPoints = [];
    for (let i = 0; i < data.length; i++) {
      const fg = filteredGps[i];
      if (fg && !isNaN(fg.lat) && !isNaN(fg.lon)) {
        drawPoints.push({
          ...data[i],
          lat: fg.lat,
          lon: fg.lon,
          origIdx: i,
          // Tagged directly (rather than looked up by origIdx downstream) so the
          // flag survives collective mode's concatenation of multiple tracks'
          // drawPoints, where origIdx collides across tracks — see
          // RFFluidRenderer._precalculateSpatialFans().
          isRfPeak: !!(analyzer.rfPeakIndices && analyzer.rfPeakIndices.has(i))
        });
      }
    }

    drawPoints = GpsPipeline.downsampleForDisplay(drawPoints, analyzer.sampleRate || 10.0, p.downsample === true || p.downsample === 1, analyzer.rfPeakIndices);
    drawPoints = GpsFilter.applyRDP(drawPoints, p.rdpTolerance || 0, analyzer.rfPeakIndices);

    this._gpsCache.set(cacheKey, { paramsHash, snapFingerprint: snapFp, gpsPoints, drawPoints });
    return { gpsPoints, drawPoints };
  },

  _collectGpsPoints(data) {
    const pts = [];
    for (let i = 0; i < data.length; i++) {
      // Only collect actual GPS fixes (not interpolated points) so the
      // Kalman filter processes the true measurement rate (1-2 Hz) rather
      // than the 10 Hz interpolated grid, preventing artificial covariance
      // deflation and sluggish corner tracking.
      const d = data[i];
      if (d._isGpsFix && !isNaN(d.lat) && !isNaN(d.lon)) {
        // Deliberately NOT a full `{ ...d, origIdx: i }` spread: this array
        // (and every filter stage between here and reconstructFilteredGps —
        // gate/speed/velocity/stop-averaging/Kalman) only ever reads the
        // fields listed below, and it's discarded once reconstructFilteredGps
        // pulls lat/lon back out (no caller of _getOrBuildDrawPoints ever
        // destructures `gpsPoints`, only `drawPoints`, which is built
        // separately from the raw row — see that method). Spreading the full
        // ~29-field CSV row (rssi_*/osm_*/em_fog/val/etc., none of them read
        // downstream) here and at every subsequent filter's own `{...pt}`
        // copy was ~35-40% of this pipeline's real cost on a large track —
        // found by profiling, not guessed (docs/archive/visualizer_rendering_perf_routes.md §2.7).
        pts.push({
          lat: d.lat, lon: d.lon, time: d.time,
          hdop: d.hdop, pdop: d.pdop, hacc: d.hacc,
          speedKts: d.speedKts, course: d.course, fixType: d.fixType,
          origIdx: i
        });
      }
    }
    return pts;
  }

});
