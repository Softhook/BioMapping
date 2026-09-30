/**
 * GSRMapManager — colour-coded path segment rendering. Prototype-augment split
 * from map.js: loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype.
 *
 * _renderPathSegments() splits the drawPoints into constant-colour runs (by
 * metric bucket, breaking at GPS gaps) and draws each as an L.polyline;
 * _overlapRadiusMetres() / _refreshPathOnZoom() drive the overlap-aware
 * recolour where the walk retraces itself and the strokes visually merge. The
 * pooling primitives it calls (_buildOverlapCells / _overlapPooledAccessor /
 * _pathRetraces) stay as statics on GSRMapManager in map.js — they are pure
 * functions covered directly by tests/test_path_overlap_pooling.js.
 *
 * Depends on the globals L, GSR_CONST, AppState, GSRStorage and MapColors
 * (resolved at call time).
 */

// Map-colouring metrics backed by a per-sample analyzer array (analyzer.phasic[i],
// analyzer.tonic[i], etc.) rather than a static field already present on the
// drawPoint objects. Looked up live at render time via origIdx — see
// _renderPathSegments — rather than baked into the GPS-cached drawPoints,
// since those are cached across GSR re-analyses keyed only on GPS params and
// would otherwise go stale the moment a GSR slider changes.
import { AppState } from '../../core/app_state.mjs';
import { GSR_CONST } from '../../core/constants.mjs';
import { GeoUtils } from '../../gps/geo_utils.mjs';
import { GpsPipeline } from '../../gps/gps_pipeline.mjs';
import { GSRStorage } from '../../ui/storage.mjs';
import { GSRMapBase } from '../map_base.mjs';
import { MapColors } from '../map_colors.mjs';
import { isUserMovingMap } from '../smooth_wheel_zoom.mjs';
import { GSRMapRfFluid } from './rf_fluid.mjs';

const DERIVED_METRIC_SERIES = {
  phasic: 'phasic',
  tonic: 'tonic',
  peakDensity: 'peakDensity',
  phasicAUC: 'phasicAUC',
  arousalIndex: 'arousalIndex',
  triIndex: 'triIndex',
  edasymp: 'edasymp',
  responseDynamics: 'responseDynamics',
  em_fog: 'em_fog',
  emFog: 'em_fog',
};

// Colour metrics that are body data (from the skin). A place on the path shows
// the reading its Response delay later (analyzer.readingAt), so the colour
// lines up with the peak markers. Everything else — EM fog, HDOP, OSM and
// satellite metrics — is place data and stays where it was measured.
const BODY_METRICS = new Set([
  'gsr',
  'phasic',
  'tonic',
  'peakDensity',
  'phasicAUC',
  'arousalIndex',
  'triIndex',
  'edasymp',
  'responseDynamics',
]);

// Where a place has no reading yet (the last Response-delay seconds of the
// route: the recording ended before its response could arrive), the path is
// drawn in this neutral grey rather than a colour from the scale.
const NO_READING_COLOUR = '#9ca3af';

// Distance-to-feature OSM metrics use a 999 "none within radius" sentinel
// (osm_enrichment.js SENTINEL_DIST). It must not enter the colour range —
// otherwise real 0..~100 m distances collapse into the first couple of buckets
// and the whole path reads as one colour.
const DISTANCE_METRICS = new Set(['distMajorRoad', 'distWater', 'distGreen']);

/** True when `v` is not a real measurement for `metric` (NaN/missing/sentinel). */
const isNoDataValue = (metric, v) => {
  if (v === undefined || v === null || (typeof v === 'number' && isNaN(v)))
    return true;
  if (DISTANCE_METRICS.has(metric)) return v >= 999;
  return false;
};

// How long after a zoom settles the overlap recolour waits (see
// _schedulePathRefreshOnZoom).
const PATH_REFRESH_DELAY_MS = 250;

export class GSRMapPath extends GSRMapRfFluid {
  /**
   * The ground distance (metres) that the rendered track stroke spans at the
   * map's current zoom — i.e. the centre-line gap at which two strokes of
   * `trackWeight` px just touch. This is the "same spot" radius for
   * overlap-aware colour, so it scales with the width slider and the zoom.
   * Capped at GSR_CONST.PATH_OVERLAP.maxRadiusM; returns 0 (⇒ pooling skipped)
   * when the map isn't ready, the path is too short, or the projection maths
   * can't run.
   * @private
   */
  _overlapRadiusMetres(drawPoints, trackWeight) {
    if (!this.map || !Array.isArray(drawPoints) || drawPoints.length < 4)
      return 0;
    const OV = GSR_CONST.PATH_OVERLAP;
    const w = trackWeight > 0 ? trackWeight : 5;
    const factor = OV.widthFactor;
    const mid = drawPoints[drawPoints.length >> 1];
    try {
      const a = L.latLng(mid.lat, mid.lon);
      const ap = this.map.latLngToLayerPoint(a);
      const b = this.map.layerPointToLatLng(L.point(ap.x + 1, ap.y));
      const mPerPx = a.distanceTo(b);
      if (!(mPerPx > 0)) return 0;
      const cap = OV.maxRadiusM;
      return Math.min(w * mPerPx * factor, cap);
    } catch (_e) {
      return 0;
    }
  }

  /**
   * zoomend hook: runs _refreshPathOnZoom once the user has stopped zooming.
   * The check and any redraw block the page for tens of ms (several times
   * that on a phone), so doing it the moment each zoom ends stalls the start
   * of the next pinch or scroll. Instead it waits PATH_REFRESH_DELAY_MS,
   * starts over if another zoom ends first, and waits again while fingers or
   * a zoom are still on the map. Cancelled by _cancelPathRefreshOnZoom
   * (zoomstart). The recolour only touches spots where the walk retraces
   * itself, so landing a moment after the zoom goes unnoticed.
   * @private
   */
  _schedulePathRefreshOnZoom() {
    this._cancelPathRefreshOnZoom();
    this._pathRefreshTimer = setTimeout(() => {
      this._pathRefreshTimer = null;
      if (this.map && isUserMovingMap(this.map)) {
        this._schedulePathRefreshOnZoom();
      } else {
        this._refreshPathOnZoom();
      }
    }, PATH_REFRESH_DELAY_MS);
  }

  /** @private */
  _cancelPathRefreshOnZoom() {
    clearTimeout(this._pathRefreshTimer);
    this._pathRefreshTimer = null;
  }

  /**
   * zoomend hook. The overlap-aware path colour keys off the stroke's
   * on-screen width in metres, which changes with zoom — but re-rendering the
   * path on every zoom step visibly jerks. So this only rebuilds when the
   * overlap outcome would actually change: it recomputes the cheap pooled
   * fingerprint (two linear passes, no Leaflet work) at the new zoom and bails
   * unless it differs from the last render's. Also no-ops in collective view,
   * before the first render, when the path provably never retraces itself, and
   * when the zoom level is unchanged. Called via _schedulePathRefreshOnZoom.
   * @private
   */
  _refreshPathOnZoom() {
    try {
      if (!this.map || typeof AppState.analyzer === 'undefined') return;
      if (AppState.viewMode === 'collective') return;
      if (this._pathHasRetrace === false) return;
      if (!this._lastDrawPoints || this._lastDrawPoints.length === 0) return;
      if (this._lastPathIsCategorical) return;
      if (!AppState.analyzer || typeof this._lastPathGetVal !== 'function')
        return;
      if (typeof this.map.getZoom !== 'function') return;
      const z = this.map.getZoom();
      if (z === this._lastPathZoom) return;

      // Would the overlap colouring actually change at this zoom? Only the
      // visual radius moved — the path points and metric are unchanged.
      const radiusM = this._overlapRadiusMetres(
        this._lastDrawPoints,
        this._lastPathTrackWeight,
      );
      let acc = null;
      if (radiusM > 0) {
        acc = GSRMapBase._overlapPooledAccessor(
          this._lastDrawPoints,
          this._lastPathGetVal,
          { radiusM, revisitGapS: GSR_CONST.PATH_OVERLAP.revisitGapS },
        );
      }
      const sig = acc ? acc.sig | 0 : 0;
      if (sig === this._lastPathOverlapSig) {
        this._lastPathZoom = z; // accept the new zoom, nothing to redraw
        return;
      }

      this._lastPathZoom = z;
      const params = GSRStorage.buildGpsParams();
      // Hand the overlap pooling just computed to the re-render, which would
      // otherwise redo it for the same points, metric and radius — the
      // costliest step of the redraw that ends every zoom.
      this._zoomOverlapHandoff = {
        drawPoints: this._lastDrawPoints,
        radiusM,
        acc,
      };
      try {
        this.refreshPath(AppState.analyzer, params);
      } finally {
        this._zoomOverlapHandoff = null;
      }
    } catch (_e) {
      /* a zoom must never break — worst case the overlap colour lags a step */
    }
  }

  _renderPathSegments(drawPoints, trackWeight, analyzer, track) {
    const layerGroup = track ? track.layerGroup : null;
    const metric = this.activeColoringMetric || 'gsr';
    const key = this._getMetricKey(metric);
    // 'roadClass' is categorical, 'inPark' is 0/1 binary, and 'responseDynamics'
    // is discrete event-gated (0 = resting, >0 = speed multiplier).
    const isCategorical =
      metric === 'roadClass' ||
      metric === 'inPark' ||
      metric === 'responseDynamics';
    const needsUnique = isCategorical;

    // Phasic/Tonic/Peak Density/Phasic AUC/Arousal Index live in per-sample
    // analyzer arrays, not on the (cached) drawPoint objects — see
    // DERIVED_METRIC_SERIES. Fall back to the static drawPoint[key] lookup
    // for everything else (raw GSR, HDOP, OSM enrichment fields).
    const derivedSeriesKey = DERIVED_METRIC_SERIES[metric];
    const derivedSeries =
      derivedSeriesKey && analyzer ? analyzer[derivedSeriesKey] : null;
    const isBody = BODY_METRICS.has(metric);
    let getVal = derivedSeries
      ? (p) => (derivedSeries[p.origIdx] ? derivedSeries[p.origIdx].val : 0)
      : (p) => p[key];
    if (isBody && analyzer?.readingAt) {
      // Body data: the reading this place shows (null where the recording
      // ended before its response could arrive). Looked up once per place.
      const readingOf = new Int32Array(analyzer.raw.length).fill(-2);
      const series = derivedSeries || analyzer.raw;
      getVal = (p) => {
        let r = readingOf[p.origIdx];
        if (r === -2) r = readingOf[p.origIdx] = analyzer.readingAt(p.origIdx);
        if (r < 0) return null;
        return series[r] ? series[r].val : 0;
      };
    }

    // Overlap-aware colour: where the walk retraces itself AND the two strokes
    // visually merge at this zoom, colour that spot by the mean of the active
    // metric across the overlap rather than last-visit-wins. The "same spot"
    // radius is the stroke's on-screen width in metres, so it tracks both the
    // width slider and the zoom (see _refreshPathOnZoom). Skipped for
    // categorical metrics — averaging category codes is meaningless.
    let valAt = getVal;
    let hasRetrace = false;
    let overlapSig = 0;
    if (!isCategorical) {
      const OV = GSR_CONST.PATH_OVERLAP;
      const gapS = OV.revisitGapS;
      const maxR = OV.maxRadiusM;
      const radiusM = this._overlapRadiusMetres(drawPoints, trackWeight);
      if (radiusM > 0) {
        const handoff = this._zoomOverlapHandoff;
        const pooledAt =
          handoff?.drawPoints === drawPoints && handoff.radiusM === radiusM
            ? handoff.acc
            : GSRMapBase._overlapPooledAccessor(drawPoints, getVal, {
                radiusM,
                revisitGapS: gapS,
              });
        if (pooledAt) {
          valAt = pooledAt;
          hasRetrace = true;
          overlapSig = pooledAt.sig | 0;
        }
      }
      // If nothing pooled at the current radius, is a retrace even geometrically
      // possible at any zoom? Probe once at the max radius so _refreshPathOnZoom
      // can skip re-rendering this (common) case for free. A radius already at
      // the cap that found nothing has already answered "no".
      if (!hasRetrace) {
        hasRetrace =
          !(radiusM > 0 && radiusM >= maxR) &&
          GSRMapBase._pathRetraces(drawPoints, {
            radiusM: maxR,
            revisitGapS: gapS,
          });
      }
    }
    this._pathHasRetrace = hasRetrace;
    this._lastPathOverlapSig = overlapSig;
    this._lastPathTrackWeight = trackWeight;
    this._lastPathGetVal = getVal;
    this._lastPathIsCategorical = isCategorical;
    this._lastPathZoom =
      this.map && typeof this.map.getZoom === 'function'
        ? this.map.getZoom()
        : null;

    // ── Single pass over drawPoints (already downsampled) for min/max ──
    // Uses the RAW value, not the pooled one, so the colour scale (and legend)
    // stay fixed to the real data range — pooling only recolours the
    // overlapping segments, it never rescales the whole path.
    let minVal = Infinity,
      maxVal = -Infinity;
    const seen = needsUnique ? new Set() : null;

    for (let i = 0; i < drawPoints.length; i++) {
      const v = getVal(drawPoints[i]);
      if (v === undefined || v === null) continue;

      if (!isCategorical && !isNoDataValue(metric, v)) {
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }

      if (needsUnique) seen.add(v);
    }

    if (!isCategorical) {
      if (minVal === Infinity) {
        minVal = 0;
        maxVal = 1;
      }
      if (maxVal === minVal) maxVal = minVal + 1;
    }

    // Store for legend
    this._legendMinVal = minVal;
    this._legendMaxVal = maxVal;
    this._legendUniqueVals = needsUnique ? seen : null;

    // Pre-compute color LUT for continuous metrics
    const range = maxVal - minVal;
    const COLOR_BUCKETS = 30;
    const colorLut = isCategorical
      ? null
      : MapColors.getColorLut(metric, minVal, maxVal);

    // Break the polyline only at physically impossible jumps (see
    // GpsPipeline.isImpossibleJump). Blanked gaps and adjacent far-apart
    // anchors both reach here as neighbouring points, so this is the one
    // place that stops a straight line being drawn across them. Merely
    // noisy or snap-offset fixes are deliberately kept connected.
    const segments = [[]];
    for (let i = 0; i < drawPoints.length; i++) {
      if (i > 0) {
        const a = drawPoints[i - 1];
        const b = drawPoints[i];
        const distM = GeoUtils.haversineMeters(a.lat, a.lon, b.lat, b.lon);
        if (GpsPipeline.isImpossibleJump(distM, b.time - a.time)) {
          segments.push([]);
        }
      }
      segments[segments.length - 1].push(drawPoints[i]);
    }

    // Split off the stretches with no reading (body metrics only, see
    // NO_READING_COLOUR); the point where one ends starts the next, so the
    // line stays joined.
    if (isBody) {
      const split = [];
      for (const seg of segments) {
        let cur = [];
        let curNone = null;
        for (const pt of seg) {
          const none = getVal(pt) == null;
          if (curNone !== null && none !== curNone) {
            split.push(cur);
            cur = [cur[cur.length - 1]];
          }
          curNone = none;
          cur.push(pt);
        }
        split.push(cur);
      }
      segments.length = 0;
      segments.push(...split);
    }

    // Reusable array for latlngs to reduce GC pressure
    const latlngsBuf = [];

    for (const seg of segments) {
      if (seg.length < 2) continue;

      if (isBody && getVal(seg[seg.length - 1]) == null) {
        const poly = L.polyline(
          seg.map((pt) => [pt.lat, pt.lon]),
          { color: NO_READING_COLOUR, weight: trackWeight, opacity: 0.95 },
        );
        if (layerGroup) {
          poly._gsrLayerGroup = layerGroup;
          poly._gsrKind = 'path';
          layerGroup.addLayer(poly);
        } else {
          poly.addTo(this.map);
        }
        this._registerTrackLayer(track, poly);
        continue;
      }

      let batchStart = 0;

      while (batchStart < seg.length - 1) {
        const startVal = valAt(seg[batchStart]);

        let startBucket = 0;
        if (!isCategorical) {
          const avgVal =
            (valAt(seg[batchStart]) + valAt(seg[batchStart + 1])) / 2;
          startBucket = (avgVal - minVal) * (COLOR_BUCKETS / range);
          startBucket =
            startBucket < 0
              ? 0
              : startBucket >= COLOR_BUCKETS
                ? COLOR_BUCKETS - 1
                : startBucket | 0;
        }

        let batchEnd = batchStart + 1;
        while (batchEnd < seg.length - 1) {
          if (isCategorical) {
            if (valAt(seg[batchEnd]) !== startVal) break;
          } else {
            const val = (valAt(seg[batchEnd]) + valAt(seg[batchEnd + 1])) / 2;
            const bucket = (val - minVal) * (COLOR_BUCKETS / range);
            const b =
              bucket < 0
                ? 0
                : bucket >= COLOR_BUCKETS
                  ? COLOR_BUCKETS - 1
                  : bucket | 0;
            if (b !== startBucket) break;
          }
          batchEnd++;
        }

        // Build latlngs directly into reusable buffer
        latlngsBuf.length = 0;
        for (let i = batchStart; i <= batchEnd; i++) {
          latlngsBuf.push([seg[i].lat, seg[i].lon]);
        }

        if (metric === 'responseDynamics' && (!startVal || startVal <= 0)) {
          batchStart = batchEnd;
          continue;
        }

        let color;
        if (isCategorical) {
          color = MapColors.getColorForMetric(metric, startVal, minVal, maxVal);
        } else {
          const midIdx = (batchStart + batchEnd) >> 1;
          const midBucket =
            ((valAt(seg[midIdx]) + valAt(seg[midIdx + 1])) / 2 - minVal) *
            (COLOR_BUCKETS / range);
          const b =
            midBucket < 0
              ? 0
              : midBucket >= COLOR_BUCKETS
                ? COLOR_BUCKETS - 1
                : midBucket | 0;
          color = colorLut[b];
        }

        // Phase 1 (slice 1): path segments render into the track's layerGroup
        // (on the map), never directly onto the map. `layerGroup` is null when
        // there is no managed track — fall back to the legacy direct add.
        const poly = L.polyline(latlngsBuf.slice(), {
          color,
          weight: trackWeight,
          opacity: 0.95,
        });
        if (layerGroup) {
          poly._gsrLayerGroup = layerGroup;
          poly._gsrKind = 'path';
          layerGroup.addLayer(poly);
        } else {
          poly.addTo(this.map);
        }
        this._registerTrackLayer(track, poly);

        batchStart = batchEnd;
      }
    }

    // Update legend with current metric and data range
    this.updateLegend();
  }
}
