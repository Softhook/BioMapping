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
const DERIVED_METRIC_SERIES = {
  phasic: 'phasic',
  tonic: 'tonic',
  peakDensity: 'peakDensity',
  phasicAUC: 'phasicAUC',
  arousalIndex: 'arousalIndex',
  triIndex: 'triIndex',
  em_fog: 'em_fog',
  emFog: 'em_fog'
};

Object.assign(GSRMapManager.prototype, {

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
    if (!this.map || !Array.isArray(drawPoints) || drawPoints.length < 4) return 0;
    const OV = (typeof GSR_CONST !== 'undefined' && GSR_CONST.PATH_OVERLAP) ? GSR_CONST.PATH_OVERLAP : {};
    const w = (trackWeight > 0) ? trackWeight : 5;
    const factor = (OV.widthFactor > 0) ? OV.widthFactor : 1;
    const mid = drawPoints[drawPoints.length >> 1];
    try {
      const a = L.latLng(mid.lat, mid.lon);
      const ap = this.map.latLngToLayerPoint(a);
      const b = this.map.layerPointToLatLng(L.point(ap.x + 1, ap.y));
      const mPerPx = a.distanceTo(b);
      if (!(mPerPx > 0)) return 0;
      const cap = (OV.maxRadiusM > 0) ? OV.maxRadiusM : 60;
      return Math.min(w * mPerPx * factor, cap);
    } catch (e) {
      return 0;
    }
  },

  /**
   * zoomend hook. The overlap-aware path colour keys off the stroke's
   * on-screen width in metres, which changes with zoom — but re-rendering the
   * path on every zoom step visibly jerks. So this only rebuilds when the
   * overlap outcome would actually change: it recomputes the cheap pooled
   * fingerprint (two linear passes, no Leaflet work) at the new zoom and bails
   * unless it differs from the last render's. Also no-ops in collective view,
   * before the first render, when the path provably never retraces itself, and
   * when the zoom level is unchanged. Runs synchronously off `zoomend` (which
   * already fires after the zoom animation) so any recolour lands with the
   * zoom, not delayed after it.
   * @private
   */
  _refreshPathOnZoom() {
    try {
      if (!this.map || typeof AppState === 'undefined' || typeof AppState.analyzer === 'undefined') return;
      if (AppState.viewMode === 'collective') return;
      if (this._pathHasRetrace === false) return;
      if (!this._lastDrawPoints || this._lastDrawPoints.length === 0) return;
      if (this._lastPathIsCategorical) return;
      if (!AppState.analyzer || typeof this._lastPathGetVal !== 'function') return;
      if (typeof this.map.getZoom !== 'function') return;
      const z = this.map.getZoom();
      if (z === this._lastPathZoom) return;

      // Would the overlap colouring actually change at this zoom? Only the
      // visual radius moved — the path points and metric are unchanged.
      const OV = (typeof GSR_CONST !== 'undefined' && GSR_CONST.PATH_OVERLAP) ? GSR_CONST.PATH_OVERLAP : {};
      const radiusM = this._overlapRadiusMetres(this._lastDrawPoints, this._lastPathTrackWeight);
      let sig = 0;
      if (radiusM > 0) {
        const acc = GSRMapManager._overlapPooledAccessor(
          this._lastDrawPoints, this._lastPathGetVal, { radiusM, revisitGapS: OV.revisitGapS || 15 });
        sig = acc ? (acc.sig | 0) : 0;
      }
      if (sig === this._lastPathOverlapSig) {
        this._lastPathZoom = z; // accept the new zoom, nothing to redraw
        return;
      }

      this._lastPathZoom = z;
      const params = (typeof GSRStorage !== 'undefined' && typeof GSRStorage.buildGpsParams === 'function')
        ? GSRStorage.buildGpsParams()
        : {};
      this.refreshPath(AppState.analyzer, params);
    } catch (e) {
      /* a zoom must never break — worst case the overlap colour lags a step */
    }
  },

  _renderPathSegments(drawPoints, trackWeight, analyzer, track) {
    const layerGroup = track ? track.layerGroup : null;
    const metric = this.activeColoringMetric || 'gsr';
    const key = this._getMetricKey(metric);
    const isCategorical = (metric === 'roadClass');
    const needsUnique = (isCategorical || metric === 'inPark');

    // Phasic/Tonic/Peak Density/Phasic AUC/Arousal Index live in per-sample
    // analyzer arrays, not on the (cached) drawPoint objects — see
    // DERIVED_METRIC_SERIES. Fall back to the static drawPoint[key] lookup
    // for everything else (raw GSR, HDOP, OSM enrichment fields).
    const derivedSeriesKey = DERIVED_METRIC_SERIES[metric];
    const derivedSeries = derivedSeriesKey && analyzer ? analyzer[derivedSeriesKey] : null;
    const getVal = derivedSeries
      ? (p) => (derivedSeries[p.origIdx] ? derivedSeries[p.origIdx].val : 0)
      : (p) => p[key];

    // Overlap-aware colour: where the walk retraces itself AND the two strokes
    // visually merge at this zoom, colour that spot by the mean of the active
    // metric across the overlap rather than last-visit-wins. The "same spot"
    // radius is the stroke's on-screen width in metres, so it tracks both the
    // width slider and the zoom (see _refreshPathOnZoom). Skipped for
    // categorical metrics — averaging category codes is meaningless.
    let valAt = getVal;
    let hasRetrace = false;
    let overlapSig = 0;
    if (!isCategorical && typeof GSR_CONST !== 'undefined' && GSR_CONST.PATH_OVERLAP) {
      const OV = GSR_CONST.PATH_OVERLAP;
      const gapS = OV.revisitGapS || 15;
      const maxR = OV.maxRadiusM || 60;
      const radiusM = this._overlapRadiusMetres(drawPoints, trackWeight);
      if (radiusM > 0) {
        const pooledAt = GSRMapManager._overlapPooledAccessor(drawPoints, getVal, { radiusM, revisitGapS: gapS });
        if (pooledAt) { valAt = pooledAt; hasRetrace = true; overlapSig = pooledAt.sig | 0; }
      }
      // If nothing pooled at the current radius, is a retrace even geometrically
      // possible at any zoom? Probe once at the max radius so _refreshPathOnZoom
      // can skip re-rendering this (common) case for free. A radius already at
      // the cap that found nothing has already answered "no".
      if (!hasRetrace) {
        hasRetrace = !(radiusM > 0 && radiusM >= maxR)
          && GSRMapManager._pathRetraces(drawPoints, { radiusM: maxR, revisitGapS: gapS });
      }
    }
    this._pathHasRetrace = hasRetrace;
    this._lastPathOverlapSig = overlapSig;
    this._lastPathTrackWeight = trackWeight;
    this._lastPathGetVal = getVal;
    this._lastPathIsCategorical = isCategorical;
    this._lastPathZoom = (this.map && typeof this.map.getZoom === 'function') ? this.map.getZoom() : null;

    // ── Single pass over drawPoints (already downsampled) for min/max ──
    // Uses the RAW value, not the pooled one, so the colour scale (and legend)
    // stay fixed to the real data range — pooling only recolours the
    // overlapping segments, it never rescales the whole path.
    let minVal = Infinity, maxVal = -Infinity;
    const seen = needsUnique ? new Set() : null;

    for (let i = 0; i < drawPoints.length; i++) {
      const v = getVal(drawPoints[i]);
      if (v === undefined || v === null) continue;

      if (!isCategorical && !isNaN(v)) {
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }

      if (needsUnique) seen.add(v);
    }

    if (!isCategorical) {
      if (minVal === Infinity) { minVal = 0; maxVal = 1; }
      if (maxVal === minVal) maxVal = minVal + 1;
    }

    // Store for legend
    this._legendMinVal = minVal;
    this._legendMaxVal = maxVal;
    this._legendUniqueVals = needsUnique ? seen : null;

    // Pre-compute color LUT for continuous metrics
    const range = maxVal - minVal;
    const COLOR_BUCKETS = 30;
    const colorLut = isCategorical ? null : MapColors.getColorLut(metric, minVal, maxVal);

    // Split drawPoints into continuous path segments, breaking at GPS gaps > 30 s.
    const GPS_PATH_GAP_S = 30;
    const segments = [[]];
    for (let i = 0; i < drawPoints.length; i++) {
      if (i > 0 && drawPoints[i].time - drawPoints[i - 1].time > GPS_PATH_GAP_S) {
        segments.push([]);
      }
      segments[segments.length - 1].push(drawPoints[i]);
    }

    // Reusable array for latlngs to reduce GC pressure
    const latlngsBuf = [];

    for (const seg of segments) {
      if (seg.length < 2) continue;

      let batchStart = 0;

      while (batchStart < seg.length - 1) {
        const startVal = valAt(seg[batchStart]);

        let startBucket = 0;
        if (!isCategorical) {
          const avgVal = (valAt(seg[batchStart]) + valAt(seg[batchStart + 1])) / 2;
          startBucket = (avgVal - minVal) * (COLOR_BUCKETS / range);
          startBucket = startBucket < 0 ? 0 : (startBucket >= COLOR_BUCKETS ? COLOR_BUCKETS - 1 : startBucket | 0);
        }

        let batchEnd = batchStart + 1;
        while (batchEnd < seg.length - 1) {
          if (isCategorical) {
            if (valAt(seg[batchEnd]) !== startVal) break;
          } else {
            const val = (valAt(seg[batchEnd]) + valAt(seg[batchEnd + 1])) / 2;
            const bucket = (val - minVal) * (COLOR_BUCKETS / range);
            const b = bucket < 0 ? 0 : (bucket >= COLOR_BUCKETS ? COLOR_BUCKETS - 1 : bucket | 0);
            if (b !== startBucket) break;
          }
          batchEnd++;
        }

        // Build latlngs directly into reusable buffer
        latlngsBuf.length = 0;
        for (let i = batchStart; i <= batchEnd; i++) {
          latlngsBuf.push([seg[i].lat, seg[i].lon]);
        }

        let color;
        if (isCategorical) {
          color = MapColors.getColorForMetric(metric, startVal, minVal, maxVal);
        } else {
          const midIdx = (batchStart + batchEnd) >> 1;
          const midBucket = ((valAt(seg[midIdx]) + valAt(seg[midIdx + 1])) / 2 - minVal) * (COLOR_BUCKETS / range);
          const b = midBucket < 0 ? 0 : (midBucket >= COLOR_BUCKETS ? COLOR_BUCKETS - 1 : midBucket | 0);
          color = colorLut[b];
        }

        // Phase 1 (slice 1): path segments render into the track's layerGroup
        // (on the map), never directly onto the map. `layerGroup` is null when
        // there is no managed track — fall back to the legacy direct add.
        const poly = L.polyline(latlngsBuf.slice(), { color, weight: trackWeight, opacity: 0.95 });
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

});
