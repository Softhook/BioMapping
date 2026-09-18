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

// How much more speed a snap-corrected gap is allowed to imply before it's
// blanked/broken, relative to the plain maxSpeed ceiling. A jump between two
// anchors that were both confidently pulled onto mapped road geometry is
// more trustworthy than the same jump in raw GPS — at a junction the HMM
// matcher can snap adjacent fixes onto two different nearby ways, and the
// resulting straight-line distance overstates how implausible the move
// actually was. Still bounded by GPS_GAP_MAX_DIST_M either way.
const SNAP_GAP_SPEED_MULTIPLIER = 4;

const KNOTS_TO_MS = 0.51444;
const DEG_TO_RAD = Math.PI / 180;

// Cubic Hermite tangent overshoot guard: clamps each endpoint's velocity-
// derived tangent (deg/sec) to at most this multiple of the segment's own
// *average* velocity (chord length / segment duration), not the raw chord
// length — comparing a deg/sec tangent straight against a bare-degrees
// chord is a unit mismatch that only cancels out for ~1s segments; at
// shorter anchor spacing it barely restrains the tangent, letting the
// curve's local speed spike well above what either endpoint measured.
const HERMITE_TANGENT_CLAMP_K = 1.0;

export const GpsPipeline = {
  /**
   * Velocity vector (degrees/sec) from a Doppler speed+course reading, or
   * null when either field is unavailable (old CSV, no fix at that row).
   * NMEA course convention: 0° = North (lat direction), 90° = East (lon).
   */
  _velocityDegPerSec(speedKts, course, scale) {
    if (isNaN(speedKts) || isNaN(course)) return null;
    const speedMs = speedKts * KNOTS_TO_MS;
    const courseRad = course * DEG_TO_RAD;
    return {
      vLat: (speedMs * Math.cos(courseRad)) / scale.degToMeterLat,
      vLon: (speedMs * Math.sin(courseRad)) / scale.degToMeterLon,
    };
  },

  /**
   * Clamp a tangent vector's magnitude (deg/sec) to at most K * the chord's
   * own average velocity (chordMagDeg / dtTotal) — the overshoot guard.
   */
  _clampHermiteTangent(v, chordMagDeg, dtTotal) {
    const mag = Math.hypot(v.vLat, v.vLon);
    const limit = (HERMITE_TANGENT_CLAMP_K * chordMagDeg) / dtTotal;
    if (mag <= limit || mag === 0) return v;
    const scale = limit / mag;
    return { vLat: v.vLat * scale, vLon: v.vLon * scale };
  },

  /**
   * Position at parameter t∈[0,1] along a cubic Hermite curve from cA to cB,
   * using velocity-derived tangents m0/m1 (degrees/sec) scaled by the
   * segment duration dtTotal (sec).
   */
  _hermitePoint(cA, cB, m0, m1, dtTotal, t) {
    const t2 = t * t,
      t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return {
      lat:
        h00 * cA.lat +
        h10 * dtTotal * m0.vLat +
        h01 * cB.lat +
        h11 * dtTotal * m1.vLat,
      lon:
        h00 * cA.lon +
        h10 * dtTotal * m0.vLon +
        h01 * cB.lon +
        h11 * dtTotal * m1.vLon,
    };
  },

  /**
   * Build the candidate cubic Hermite fill-in points for one anchor-to-anchor
   * segment (idxA, idxB exclusive of both ends). Returns an array indexed
   * from i = idxA+1..idxB-1.
   */
  _buildHermiteSegment(data, idxA, idxB, cA, cB, v0, v1, chordMagDeg, timeGap) {
    const m0 = GpsPipeline._clampHermiteTangent(v0, chordMagDeg, timeGap);
    const m1 = GpsPipeline._clampHermiteTangent(v1, chordMagDeg, timeGap);
    const pts = [];
    for (let i = idxA + 1; i < idxB; i++) {
      const t = (data[i].time - data[idxA].time) / timeGap;
      pts.push(GpsPipeline._hermitePoint(cA, cB, m0, m1, timeGap, t));
    }
    return pts;
  },

  /**
   * Whether every consecutive pair in a candidate Hermite segment (anchors
   * included) is itself a plausible gap. A curve whose endpoint tangents
   * undershoot the chord's average velocity has to speed up mid-segment to
   * still land on cB — this catches that local overshoot even though both
   * anchors, and the chord as a whole, look fine.
   */
  _hermiteSegmentIsPlausible(
    data,
    idxA,
    idxB,
    cA,
    pts,
    cB,
    maxSpeed,
    speedMultiplier = 1,
  ) {
    let prevLat = cA.lat,
      prevLon = cA.lon,
      prevTime = data[idxA].time;
    for (let i = idxA + 1; i < idxB; i++) {
      const p = pts[i - idxA - 1];
      const dt = data[i].time - prevTime;
      const distM = GeoUtils.haversineMeters(prevLat, prevLon, p.lat, p.lon);
      if (!GpsPipeline.isPlausibleGap(distM, dt, maxSpeed, speedMultiplier))
        return false;
      prevLat = p.lat;
      prevLon = p.lon;
      prevTime = data[i].time;
    }
    const distM = GeoUtils.haversineMeters(prevLat, prevLon, cB.lat, cB.lon);
    return GpsPipeline.isPlausibleGap(
      distM,
      data[idxB].time - prevTime,
      maxSpeed,
      speedMultiplier,
    );
  },

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
   * @param {number} [speedMultiplier=1] - relax the speed ceiling by this
   *   factor (see SNAP_GAP_SPEED_MULTIPLIER) — the absolute distance cap
   *   still applies regardless.
   */
  isPlausibleGap(distM, dt, maxSpeed, speedMultiplier = 1) {
    const impliedSpeedMs = dt > 0 ? distM / dt : Infinity;
    return (
      impliedSpeedMs <= maxSpeed * speedMultiplier &&
      distM <= GPS_GAP_MAX_DIST_M
    );
  },

  /**
   * Speed-ceiling multiplier for the gap between two raw-data rows, keyed by
   * whether both ends were confidently pulled onto mapped road geometry
   * (see SNAP_GAP_SPEED_MULTIPLIER above). `snappedGps` is analyzer.snappedGps
   * — a Map/object from raw row index to `{ alpha, ... }`, or null when
   * road-snap isn't enabled.
   */
  gapSpeedMultiplier(snappedGps, origIdxA, origIdxB) {
    if (!snappedGps) return 1;
    const sgA = snappedGps.get
      ? snappedGps.get(origIdxA)
      : snappedGps[origIdxA];
    const sgB = snappedGps.get
      ? snappedGps.get(origIdxB)
      : snappedGps[origIdxB];
    return sgA?.alpha > 0 && sgB?.alpha > 0 ? SNAP_GAP_SPEED_MULTIPLIER : 1;
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
      const gapSpeedMult = GpsPipeline.gapSpeedMultiplier(
        analyzer.snappedGps,
        idxA,
        idxB,
      );
      if (
        !GpsPipeline.isPlausibleGap(gapDistM, timeGap, maxSpeed, gapSpeedMult)
      ) {
        for (let i = idxA + 1; i < idxB; i++) {
          filteredGps[i] = { lat: NaN, lon: NaN };
        }
      } else {
        // Cubic Hermite through the two anchors' own measured Doppler
        // speed+course, when both are available — a straight chord ignores
        // heading entirely and visibly cuts corners at speed; the Hermite
        // tangents bend the fill-in points to actually follow the measured
        // direction of travel at each end. Falls back to the plain lerp
        // (unchanged from before) when either anchor lacks speed/course
        // data (~2% of real segments, per corpus testing) — old CSVs or a
        // row with no Doppler reading.
        const scale = GeoUtils.getGeodesicScale((cA.lat + cB.lat) / 2);
        const v0 = GpsPipeline._velocityDegPerSec(
          data[idxA].speedKts,
          data[idxA].course,
          scale,
        );
        const v1 = GpsPipeline._velocityDegPerSec(
          data[idxB].speedKts,
          data[idxB].course,
          scale,
        );
        const chordMagDeg = Math.hypot(cB.lat - cA.lat, cB.lon - cA.lon);

        let hermitePts =
          v0 && v1 && chordMagDeg > 0
            ? GpsPipeline._buildHermiteSegment(
                data,
                idxA,
                idxB,
                cA,
                cB,
                v0,
                v1,
                chordMagDeg,
                timeGap,
              )
            : null;
        // A curve whose endpoint tangents are much slower than the chord's
        // own average velocity (e.g. real fixes dropped by the HDOP/fix-type
        // gate mid-segment, so the anchors sit further apart than either
        // anchor's own instantaneous speed implies) has to speed up through
        // the middle to still land on cB at t=1 — which can push a local
        // sub-step past maxSpeed even though both anchors and the chord
        // average are fine. The plain lerp can never do that (its fastest
        // sub-step is always the chord average), so fall back to it rather
        // than hand the renderer a locally-implausible curve.
        if (
          hermitePts &&
          !GpsPipeline._hermiteSegmentIsPlausible(
            data,
            idxA,
            idxB,
            cA,
            hermitePts,
            cB,
            maxSpeed,
            gapSpeedMult,
          )
        ) {
          hermitePts = null;
        }

        if (hermitePts) {
          for (let i = idxA + 1; i < idxB; i++) {
            filteredGps[i] = hermitePts[i - idxA - 1];
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
