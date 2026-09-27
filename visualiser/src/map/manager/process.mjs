/**
 * GSRMapManager — GPS pipeline processing. Prototype-augment split from map.js:
 * loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype. They turn an analyzer's raw rows + GPS filter params
 * into the `drawPoints` array every renderer works from, and cache the result
 * (this._gpsCache, keyed by track id; valid while the display params and the
 * smoothed path's key are unchanged) so nudging a GSR slider doesn't re-run
 * the expensive filter chain.
 *
 * The stages themselves live in GpsPipeline (gps/gps_pipeline.mjs).
 */
import { GpsPipeline } from '../../gps/gps_pipeline.mjs';
import { GSRMapLayers } from './layers.mjs';

export class GSRMapProcess extends GSRMapLayers {
  /**
   * Hash GPS filter params for cache key comparison.
   * Only hashes params that affect the GPS pipeline output.
   */
  _hashGpsParams(p) {
    return `${p.maxHdop || 3.0}|${p.maxSpeed || 3.0}|${p.downsample ? 1 : 0}|${p.rdpTolerance || 0}`;
  }

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
    // Build (or confirm) the smoothed path with this map's settings first, so
    // analyzer.filteredGps — which peaks, the scrub dot and the analyses
    // read — is always the path being drawn, even if an analysis rebuilt it.
    const gpsPoints = GpsPipeline.ensureFilteredGps(analyzer, p);
    const pathKey = analyzer._pathKey;
    const cached = this._gpsCache.get(cacheKey);

    if (
      cached &&
      cached.paramsHash === paramsHash &&
      cached.pathKey === pathKey
    ) {
      // Return cached references — callers MUST NOT mutate
      return { gpsPoints: cached.gpsPoints, drawPoints: cached.drawPoints };
    }

    // ── Display points (only rebuilt when the path or display params change) ──
    const data = analyzer.raw;
    if (gpsPoints.length === 0) {
      this._gpsCache.set(cacheKey, {
        paramsHash,
        pathKey,
        gpsPoints: [],
        drawPoints: [],
      });
      return { gpsPoints: [], drawPoints: [] };
    }

    // Downsampled indices are picked before the full-width points are built
    // (saves ~125 ms of allocation per drag frame on a large walk).
    let drawPoints = GpsPipeline.buildDrawPoints(
      data,
      analyzer.filteredGps,
      analyzer.sampleRate || 10.0,
      p.downsample === true || p.downsample === 1,
      analyzer.rfPeakIndices,
    );
    drawPoints = GpsPipeline.applyRDP(
      drawPoints,
      p.rdpTolerance || 0,
      analyzer.rfPeakIndices,
    );

    this._gpsCache.set(cacheKey, {
      paramsHash,
      pathKey,
      gpsPoints,
      drawPoints,
    });
    return { gpsPoints, drawPoints };
  }
}
