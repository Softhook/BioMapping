/**
 * GPS Filter Pipeline — standalone helper functions for trajectory cleaning, gating, and display downsampling.
 */
import { GeoUtils } from './geo_utils.mjs';
import { GpsFilter } from './gps_filter.mjs';

// Absolute distance ceiling for a "plausible" gap, regardless of how much
// time it spans — guards a long gap between two points that happen to be
// close together but were actually reached by a real detour (e.g. a
// building walk-through), not a straight line.
const GPS_GAP_MAX_DIST_M = 100;

export const GpsPipeline = {
  /**
   * Is the gap between two consecutive GPS points a plausible piece of the
   * same continuous walk, safe to connect with a straight line/chord? Used
   * by both reconstructFilteredGps (10Hz interpolation vs NaN) and the map
   * renderer's path-segment breaking (_renderPathSegments in
   * manager/path.mjs) so "is this gap trustworthy" is answered once instead
   * of each place picking its own threshold and disagreeing — the two used
   * to independently allow a gap through as long as it was time-wise "not
   * too old" (30s), with no read on the distance actually implied, so an
   * anchor pair a filter stage had already flagged as physically
   * implausible (e.g. a huge jump in a fraction of a second) still got
   * rendered as a straight line.
   *
   * @param {number} distM - straight-line distance between the two points (m)
   * @param {number} dt - time between them (s)
   * @param {number} maxSpeed - plausible speed ceiling (m/s)
   */
  isPlausibleGap(distM, dt, maxSpeed) {
    const impliedSpeedMs = dt > 0 ? distM / dt : Infinity;
    return impliedSpeedMs <= maxSpeed && distM <= GPS_GAP_MAX_DIST_M;
  },

  /**
   * HDOP gate: rejects GPS anchors with poor satellite geometry.
   * Points without HDOP data are always kept.
   */
  applyHdopGate(pts, maxHdop = 3.0) {
    return pts.filter((d) => isNaN(d.hdop) || d.hdop <= maxHdop);
  },

  /**
   * Fix-type gate: rejects "no fix" (type 1).
   * Points without fix_type (value 0) are kept.
   */
  applyFixTypeGate(pts, minFixType = 2) {
    if (minFixType < 2) return pts;
    return pts.filter(
      (d) => d.fixType == null || d.fixType === 0 || d.fixType >= minFixType,
    );
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
      if (
        sg &&
        !isNaN(sg.alpha) &&
        sg.alpha > 0 &&
        !isNaN(sg.roadLat) &&
        !isNaN(sg.roadLon)
      ) {
        result.push({
          ...pt,
          lat: sg.alpha * sg.roadLat + (1 - sg.alpha) * pt.lat,
          lon: sg.alpha * sg.roadLon + (1 - sg.alpha) * pt.lon,
        });
      } else {
        result.push(pt);
      }
    }
    return result;
  },

  /**
   * Reconstruct full 10 Hz filtered GPS path.
   *
   * @param {number} [maxSpeed] - plausible speed ceiling (m/s), the same
   *   value fed to applySpeedFilter/Kalman Q — used to decide whether a gap
   *   between anchors is safe to draw as a straight chord.
   */
  reconstructFilteredGps(analyzer, data, gpsPoints, maxSpeed = 3.0) {
    const filteredGps = new Array(data.length);
    const filteredMap = new Map();
    gpsPoints.forEach((p) => {
      filteredMap.set(p.origIdx, { lat: p.lat, lon: p.lon });
    });

    const validIndices = gpsPoints.map((p) => p.origIdx).sort((a, b) => a - b);
    if (validIndices.length === 0) {
      for (let i = 0; i < data.length; i++)
        filteredGps[i] = { lat: NaN, lon: NaN };
      analyzer.filteredGps = filteredGps;
      return;
    }

    // Fill before first
    const firstIdx = validIndices[0];
    const firstCoord = filteredMap.get(firstIdx);
    for (let i = 0; i < firstIdx; i++)
      filteredGps[i] = { lat: firstCoord.lat, lon: firstCoord.lon };

    // Interpolate between valid points, leaving gaps too implausible to draw
    // as a straight chord as NaN. A flat 30s time-only rule fabricates ~42m
    // of invented path at walking pace while needlessly blanking a genuine
    // 30s+ stop where the anchors barely moved — gate on the gap's own
    // implied speed/distance instead (see isPlausibleGap).
    for (let k = 0; k < validIndices.length - 1; k++) {
      const idxA = validIndices[k],
        idxB = validIndices[k + 1];
      const cA = filteredMap.get(idxA),
        cB = filteredMap.get(idxB);
      filteredGps[idxA] = { lat: cA.lat, lon: cA.lon };
      const timeGap = data[idxB].time - data[idxA].time;
      const gapDistM = GeoUtils.haversineMeters(cA.lat, cA.lon, cB.lat, cB.lon);
      if (!GpsPipeline.isPlausibleGap(gapDistM, timeGap, maxSpeed)) {
        for (let i = idxA + 1; i < idxB; i++) {
          filteredGps[i] = { lat: NaN, lon: NaN };
        }
      } else {
        for (let i = idxA + 1; i < idxB; i++) {
          const ratio = (i - idxA) / (idxB - idxA);
          filteredGps[i] = {
            lat: cA.lat + ratio * (cB.lat - cA.lat),
            lon: cA.lon + ratio * (cB.lon - cA.lon),
          };
        }
      }
    }

    // Fill after last
    const lastIdx = validIndices[validIndices.length - 1];
    const lastCoord = filteredMap.get(lastIdx);
    for (let i = lastIdx; i < data.length; i++)
      filteredGps[i] = { lat: lastCoord.lat, lon: lastCoord.lon };

    analyzer.filteredGps = filteredGps;
  },

  /**
   * Cached version of reconstructFilteredGps.
   */
  reconstructFilteredGpsCached(analyzer, data, gpsPoints, maxSpeed = 3.0) {
    const n = gpsPoints.length;
    if (n === 0) {
      if (!analyzer._filteredGpsCacheKey) {
        GpsPipeline.reconstructFilteredGps(analyzer, data, gpsPoints, maxSpeed);
        analyzer._filteredGpsCacheKey = 'empty';
      }
      return;
    }
    // O(n) rolling hash over every point so a mid-track edit that leaves the
    // first/mid/last points untouched still invalidates the cache (a plain
    // first/mid/last sample missed exactly that case).
    let hash = 0;
    for (let i = 0; i < n; i++) {
      const p = gpsPoints[i];
      hash = (Math.imul(hash, 31) + p.origIdx) | 0;
      hash = (Math.imul(hash, 31) + Math.round(p.lat * 1e7)) | 0;
      hash = (Math.imul(hash, 31) + Math.round(p.lon * 1e7)) | 0;
    }
    const key = `${hash}|${n}|${maxSpeed}`;
    if (analyzer._filteredGpsCacheKey === key) return;

    GpsPipeline.reconstructFilteredGps(analyzer, data, gpsPoints, maxSpeed);
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
    const hasForced = !!(forceIndexSet && forceIndexSet.size > 0);
    const included = hasForced ? new Set() : null;

    for (let i = 0; i < count; i += step) {
      picked.push(i);
      if (hasForced) included.add(i);
    }
    if (count > 0 && (count - 1) % step !== 0) {
      picked.push(count - 1);
      if (hasForced) included.add(count - 1);
    }

    if (hasForced) {
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
      gpsPoints.length,
      step,
      (i) => gpsPoints[i].origIdx,
      forceIndexSet,
    );
    return positions.map((i) => ({ ...gpsPoints[i] }));
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
    if (!data || data.length === 0 || !filteredGps || filteredGps.length === 0)
      return [];

    const validIndices = [];
    for (let i = 0; i < data.length; i++) {
      const fg = filteredGps[i];
      if (fg && !isNaN(fg.lat) && !isNaN(fg.lon)) validIndices.push(i);
    }
    const totalValid = validIndices.length;
    if (totalValid === 0) return [];

    const step = doDownsample ? Math.max(1, Math.round(sampleRate)) : 1;
    const positions = GpsPipeline._pickDownsampleIndices(
      totalValid,
      step,
      (i) => validIndices[i],
      forceIndexSet,
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
        isRfPeak: !!forceIndexSet?.has(rawIdx),
      };
    }

    return draw;
  },
};
