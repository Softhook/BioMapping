/**
 * GSRRenderer — background context bands behind the signal graph (OSM road/
 * park classification, NDVI green-cover, EM-fog intensity).
 * Object-augment split from renderer.js: loaded after renderer.js, adds
 * these methods to the shared GSRRenderer object.
 *
 * Two band families share the RLE-segment-cache machinery
 * (_getBandSegments/_rleSegments for the discrete OSM classification,
 * _getContinuousBandSegments/_continuousColorAt for the continuous NDVI/
 * EM-fog gradients) but read from the same this._bandCache slots set up in
 * renderer.js itself.

 * Dual-mode export (like renderer.js's own tail): under a browser <script>
 * tag or the shared vm context (tests/support/boot_app.js), GSRRenderer is a
 * live global and this assigns straight onto it. Under plain CommonJS
 * require() (several dedicated band/curve test files require renderer.js
 * directly instead of booting the whole app), module.exports hands back the
 * method object instead so the caller can Object.assign it onto the
 * freshly-required object itself. The require-branch below copies renderer.js's
 * entire export surface onto `global` rather than naming individual identifiers
 * — renderer.js's module.exports is the single source of truth for what's
 * available bare; a name missing there is a bug in renderer.js's exports, not
 * something to patch around here.
 */
(function () {
  const __methods = {

  /**
   * Environmental classification for background bands and tooltip context.
   * Reuses MapColors' existing roadClass/inPark colouring (same lookup the
   * map's "Road Class" layer and legend use) so the graph bands never drift
   * from the map's colours.
   *
   * Priority: a vehicular road (OSMEnricher.isVehicularRoad — motorway down
   * to residential/service) always wins, since crossing traffic through a
   * park is still a distinct exposure. Below that, park wins over a bare
   * pedestrian/cycle path — a footway *inside* a park is park context, not
   * indistinguishable from the same footway tag on a grey urban street.
   *
   * "In park" itself isn't just the strict osm_in_park point-in-polygon
   * flag: a park's boundary and the footpaths through it are almost always
   * digitised in separate OSM edits, so a path frequently sits a few metres
   * outside the polygon it visually/physically runs through — the same
   * boundary-noise osm_dist_green exists to paper over elsewhere (see its
   * doc comment in osm_enrichment.js). A short edge tolerance on that
   * distance catches those paths without also pulling in "there's a park
   * somewhere down the street".
   */
  _classifyOsmContext(sample) {
    if (!sample) return null;
    const rc = sample.osm_road_class ? sample.osm_road_class.toLowerCase() : null;
    const road = rc ? {
      key: rc,
      label: rc.replace(/_/g, ' ').toUpperCase(),
      color: MapColors.getColorForMetric('roadClass', rc, 0, 1)
    } : null;

    if (road && OSMEnricher.isVehicularRoad(rc)) return road;

    const inPark = sample.osm_in_park === 1 || sample.osm_in_park === true ||
      (typeof sample.osm_dist_green === 'number' && sample.osm_dist_green <= GSRRenderer.PARK_EDGE_TOLERANCE_M);
    if (inPark) {
      return { key: 'park', label: 'PARK', color: MapColors.getColorForMetric('inPark', 1, 0, 1) };
    }
    return road;
  },

  /**
   * Cache-checked entry point for a background-band overlay's segments.
   * `cache` is one of this._bandCache's per-overlay slots; `build(raw,
   * cache)` does the actual work (and may stash extra state onto `cache`,
   * e.g. NDVI's value range) — only called when `analyzer` or its
   * `_dataVersion` has actually changed since the last call, so repeated
   * per-frame draws stay O(1).
   */
  _getBandSegments(cache, analyzer, build) {
    if (!analyzer || !analyzer.raw || analyzer.raw.length === 0) return null;

    const dataVersion = analyzer._dataVersion || 0;
    if (cache.analyzer === analyzer && cache.dataVersion === dataVersion && cache.segments !== null) {
      return cache.segments;
    }

    cache.analyzer = analyzer;
    cache.dataVersion = dataVersion;
    cache.segments = build(analyzer.raw, cache);
    return cache.segments;
  },

  /**
   * Run-length-encode classify(sample) across `raw` into contiguous
   * {cls, tStart, tEnd} segments — a background band is always "classify
   * every sample, merge consecutive runs of the same key"; only what
   * classify() returns (colour, label, ...) differs per overlay. `classify`
   * returns null for "no band here" (a gap), or an object with at least a
   * `key` used to detect a run boundary.
   */
  _rleSegments(raw, classify) {
    const n = raw.length;
    const segments = [];
    let curCls = classify(raw[0]);
    let curKey = curCls ? curCls.key : null;
    let segStart = raw[0].time;

    for (let i = 1; i < n; i++) {
      const cls = classify(raw[i]);
      const key = cls ? cls.key : null;
      if (key !== curKey) {
        if (curCls) segments.push({ cls: curCls, tStart: segStart, tEnd: raw[i].time });
        curCls = cls;
        curKey = key;
        segStart = raw[i].time;
      }
    }
    if (curCls) segments.push({ cls: curCls, tStart: segStart, tEnd: raw[n - 1].time });
    return segments;
  },

  /**
   * Pre-compute and cache contiguous environmental segments across the entire track.
   * Runs once when a track is loaded or re-enriched, keeping per-frame draw cost near zero.
   */
  _getOsmContextSegments(analyzer) {
    return this._getBandSegments(this._bandCache.osm, analyzer,
      (raw) => this._rleSegments(raw, (s) => this._classifyOsmContext(s)));
  },

  /**
   * Shared x-axis mapping for the background band renderers (OSM context,
   * NDVI) — both need the identical time→pixel math, only the per-segment
   * fill differs.
   */
  _bandViewport(tMin, tMax) {
    const tSpan = tMax - tMin;
    if (tSpan <= 0) return null;
    const xLeftMargin = GSR_CONST.MARGIN.left;
    const xRightMargin = width - GSR_CONST.MARGIN.right;
    const xScale = (xRightMargin - xLeftMargin) / tSpan;
    if (xScale <= 0) return null;
    return { xLeftMargin, xRightMargin, xScale };
  },

  /**
   * Shared per-segment walk for the background-band overlays: viewport
   * setup, out-of-view culling, and x1/x2/w pixel math are identical for
   * every band renderer. `paint(seg, x1, x2, w)` is called for each visible
   * segment and owns everything about how it actually looks.
   */
  _drawBandSegments(segments, tMin, tMax, paint) {
    if (!segments || segments.length === 0) return;
    const vp = this._bandViewport(tMin, tMax);
    if (!vp) return;
    const { xLeftMargin, xRightMargin, xScale } = vp;

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      // Skip segments outside current viewport
      if (seg.tEnd <= tMin || seg.tStart >= tMax) continue;

      const x1 = Math.max(xLeftMargin, xLeftMargin + (seg.tStart - tMin) * xScale);
      const x2 = Math.min(xRightMargin, xLeftMargin + (seg.tEnd - tMin) * xScale);
      const w = x2 - x1;
      if (w < 0.5) continue;

      paint(seg, x1, x2, w);
    }
  },

  /**
   * Draw OpenStreetMap environmental context background bands behind the GSR signal curves.
   * Renders subtle colored bands with boundary edges and optional top labels.
   */
  drawOsmContextBands(tMin, tMax, yTop, yBottom) {
    if (!AppState.analyzer) return;
    const segments = this._getOsmContextSegments(AppState.analyzer);
    const bandHeight = yBottom - yTop;

    this._drawBandSegments(segments, tMin, tMax, (seg, x1, x2, w) => {
      // Fill band rectangle
      noStroke();
      fill(MapColors.hexToRgba(seg.cls.color, 0.12));
      rect(x1, yTop, w, bandHeight);

      // Subtle vertical boundary lines on borders
      if (w >= 3) {
        stroke(MapColors.hexToRgba(seg.cls.color, 0.3));
        strokeWeight(1);
        line(x1, yTop, x1, yBottom);
        line(x2, yTop, x2, yBottom);
      }

      // Small category label at top of wide bands
      if (w >= 45) {
        noStroke();
        fill(this.getThemeColor('--canvas-text', '#444444') + '66');
        textAlign(LEFT, TOP);
        textSize(8);
        textStyle(BOLD);
        text(seg.cls.label, x1 + 4, yTop + 3);
        textStyle(NORMAL);
      }
    });
  },

  // Fill alpha for every continuous-gradient band (NDVI, EM Fog, ...).
  CONTINUOUS_BAND_ALPHA: 0.4,

  /**
   * Pre-compute and cache contiguous colour-bucket segments for a continuous
   * per-sample metric across the whole track — the continuous-metric
   * analogue of _getOsmContextSegments, sharing the same _getBandSegments
   * cache and _rleSegments RLE core. `metric` doubles as both the raw
   * sample field to read (raw[i][metric]) and the MapColors metric key, so
   * it reuses the exact same 30-bucket LUT (MapColors.getColorLut) and
   * track-wide min/max normalisation the map's own path colouring uses for
   * that metric (map_manager_path.js) — one shared gradient definition per
   * metric, not a second one invented for the graph. Real-world continuous
   * fields (NDVI, EM Fog) are typically step-held between sparse real
   * samples, so runs of the same bucket are usually many samples long,
   * keeping the RLE segment count small.
   */
  _getContinuousBandSegments(cache, analyzer, metric) {
    return this._getBandSegments(cache, analyzer, (raw) => {
      let minVal = Infinity, maxVal = -Infinity;
      for (let i = 0; i < raw.length; i++) {
        const v = raw[i][metric];
        if (typeof v === 'number' && !isNaN(v)) {
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      }
      if (minVal === Infinity) {
        // No data for this metric on this track yet.
        cache.range = null;
        return [];
      }
      if (maxVal === minVal) maxVal = minVal + 1;
      cache.range = { minVal, maxVal };

      const lut = MapColors.getColorLut(metric, minVal, maxVal);
      const buckets = lut.length;
      const span = maxVal - minVal;

      return this._rleSegments(raw, (s) => {
        const v = s[metric];
        if (typeof v !== 'number' || isNaN(v)) return null;
        const b = ((v - minVal) * buckets) / span;
        const bucket = b < 0 ? 0 : (b >= buckets ? buckets - 1 : b | 0);
        return { key: bucket, hsl: lut[bucket] };
      });
    });
  },

  /**
   * Draw a continuous-gradient background band behind the GSR signal curves
   * — same viewport/culling mechanics as drawOsmContextBands, but a
   * continuous colour ramp (no boundary strokes or text labels, since
   * bucket edges aren't meaningful category boundaries the way a road/park
   * change is).
   */
  _drawContinuousBand(segments, tMin, tMax, yTop, yBottom) {
    const bandHeight = yBottom - yTop;
    noStroke();
    this._drawBandSegments(segments, tMin, tMax, (seg, x1, x2, w) => {
      fill(MapColors.hexToRgba(MapColors.hslStringToHex(seg.cls.hsl), this.CONTINUOUS_BAND_ALPHA));
      rect(x1, yTop, w, bandHeight);
    });
  },

  /**
   * Continuous-metric value + swatch colour at one raw sample, for the
   * hover tooltip. Reuses the exact bucket/LUT the bands were drawn with
   * (via the same cache _getContinuousBandSegments populated) so the
   * tooltip swatch always matches what's on screen. Returns null when
   * there's no data for this metric at all, or this sample has none (still
   * step-holding before the first real fix).
   */
  _continuousColorAt(cache, analyzer, metric, sample) {
    if (!sample) return null;
    const v = sample[metric];
    if (typeof v !== 'number' || isNaN(v)) return null;
    this._getContinuousBandSegments(cache, analyzer, metric); // ensures cache.range is fresh
    const range = cache.range;
    if (!range) return null;
    const lut = MapColors.getColorLut(metric, range.minVal, range.maxVal);
    const span = range.maxVal - range.minVal;
    let b = span > 0 ? ((v - range.minVal) * lut.length) / span : lut.length / 2;
    b = b < 0 ? 0 : (b >= lut.length ? lut.length - 1 : b | 0);
    return { value: v, color: MapColors.hslStringToHex(lut[b]) };
  },

  _getNdviContextSegments(analyzer) {
    return this._getContinuousBandSegments(this._bandCache.ndvi, analyzer, 'ndvi_50m');
  },

  drawNdviContextBands(tMin, tMax, yTop, yBottom) {
    if (!AppState.analyzer) return;
    this._drawContinuousBand(this._getNdviContextSegments(AppState.analyzer), tMin, tMax, yTop, yBottom);
  },

  _ndviColorAt(analyzer, sample) {
    return this._continuousColorAt(this._bandCache.ndvi, analyzer, 'ndvi_50m', sample);
  },

  _getEmFogContextSegments(analyzer) {
    return this._getContinuousBandSegments(this._bandCache.emFog, analyzer, 'em_fog');
  },

  drawEmFogContextBands(tMin, tMax, yTop, yBottom) {
    if (!AppState.analyzer) return;
    this._drawContinuousBand(this._getEmFogContextSegments(AppState.analyzer), tMin, tMax, yTop, yBottom);
  },

  _emFogColorAt(analyzer, sample) {
    return this._continuousColorAt(this._bandCache.emFog, analyzer, 'em_fog', sample);
  },

  };

  if (typeof module !== 'undefined' && module.exports) {
    // ES-module migration: renderer.js gets a temporary .mjs extension when
    // converted (convert_file.js --write), deleting the .js — same
    // resolution rule as boot_app.js's resolveFile().
    const rendererPath = require('fs').existsSync(require('path').join(__dirname, 'renderer.mjs'))
      ? './renderer.mjs' : './renderer.js';
    Object.assign(global, require(rendererPath));
    module.exports = __methods;
  } else {
    Object.assign(GSRRenderer, __methods);
  }
})();
