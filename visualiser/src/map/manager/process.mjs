/**
 * GSRMapManager — GPS pipeline processing. Prototype-augment split from map.js:
 * loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype. They turn an analyzer's raw rows + GPS filter params
 * into the `drawPoints` array every renderer works from, and cache the result
 * (this._gpsCache, keyed by track id + a params/snap fingerprint) so nudging a
 * GSR slider doesn't re-run the expensive filter chain.
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
   * Fingerprint of road-snap data so the cache invalidates when OSM
   * enrichment produces different snap results. O(n) rolling hash over every
   * entry — a first/mid/last sample missed a mid-track re-snap that left
   * those three positions unchanged.
   */
  _snapFingerprint(snappedGps) {
    if (!snappedGps) return 'nosnap';
    const keys = Object.keys(snappedGps);
    const n = keys.length;
    if (n === 0) return 'nosnap';
    let hash = 0;
    for (const key of keys) {
      const sg = snappedGps[key];
      const alpha = sg && typeof sg.alpha === 'number' ? sg.alpha : -1;
      hash = (Math.imul(hash, 31) + Number(key)) | 0;
      hash = (Math.imul(hash, 31) + Math.round(alpha * 1e3)) | 0;
    }
    return `${n}|${hash}`;
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
    const snapFp = this._snapFingerprint(analyzer.snappedGps);
    const cached = this._gpsCache.get(cacheKey);

    if (
      cached &&
      cached.paramsHash === paramsHash &&
      cached.snapFingerprint === snapFp
    ) {
      // Return cached references — callers MUST NOT mutate
      return { gpsPoints: cached.gpsPoints, drawPoints: cached.drawPoints };
    }

    // ── Expensive GPS pipeline (only runs when params change) ──
    const data = analyzer.raw;
    const fixes = GpsPipeline.collectFixes(data);
    if (fixes.length === 0) {
      this._gpsCache.set(cacheKey, {
        paramsHash,
        snapFingerprint: snapFp,
        gpsPoints: [],
        drawPoints: [],
      });
      return { gpsPoints: [], drawPoints: [] };
    }

    const maxSpeed =
      typeof p?.maxSpeed === 'number' && !isNaN(p.maxSpeed) && p.maxSpeed > 0
        ? p.maxSpeed
        : 3.0;
    const gpsPoints = GpsPipeline.filterFixes(
      fixes,
      { maxHdop: p.maxHdop || 3.0, maxSpeed },
      analyzer.snappedGps,
    );

    // Back onto the 10 Hz grid (cached on the analyzer as filteredGps).
    GpsPipeline.reconstructFilteredGpsCached(
      analyzer,
      data,
      gpsPoints,
      maxSpeed,
    );

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
      snapFingerprint: snapFp,
      gpsPoints,
      drawPoints,
    });
    return { gpsPoints, drawPoints };
  }
}
