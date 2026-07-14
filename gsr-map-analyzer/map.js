// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

class GSRMapManager {
  constructor(mapContainerId) {
    this.containerId = mapContainerId;
    this.map = null;
    this.pathSegments = [];
    this.peakMarkers = [];
    this.collectivePathSegments = [];
    this.collectivePeakMarkers = [];
    this.contourLayers = [];
    this.osmLayers = [];
    this.scrubMarker = null;
    this.showPeaks = true;
    this.showLabels = true;
    this.showClusters = true;
    this.clusterLayers = [];
    this.activeColoringMetric = 'gsr';
    this._legendControl = null;
    this._legendMinVal = 0;
    this._legendMaxVal = 0;
    this._legendUniqueVals = null;

    // ── Render caches ──────────────────────────────────────────────────
    // GPS filter cache: trackId -> { paramsHash, snapFingerprint, gpsPoints, drawPoints }
    this._gpsCache = new Map();
    // Color LUT cache: "metric|min|max" -> [30 HSL strings]
    this._colorLutCache = new Map();

    this.initMap();
    this._initLegend();
  }

  /**
   * Initialize Leaflet map with CartoDB Dark Matter tile layer
   */
  initMap() {
    // Default view zoomed out
    this.map = L.map(this.containerId, {
      zoomControl: false,
      scrollWheelZoom: true,
      preferCanvas: true
    }).setView([0, 0], 2);

    // Light Map Style (OpenStreetMap base, CartoDB Positron)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      crossOrigin: true
    }).addTo(this.map);

    // Initialise scrubbing indicator marker (pulsing blue circle)
    const scrubIcon = L.divIcon({
      className: 'scrub-marker-icon',
      html: '<div class="scrub-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    this.scrubMarker = L.marker([0, 0], { icon: scrubIcon });
  }

  /**
   * Initialise the Leaflet legend control in the bottom-right corner.
   */
  _initLegend() {
    const LegendControl = L.Control.extend({
      onAdd: () => {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = '<div class="legend-title">GSR Arousal</div><div class="legend-scale"><div class="legend-gradient" style="background: linear-gradient(90deg, hsl(120,90%,50%), hsl(60,90%,50%), hsl(0,90%,50%));"></div><div class="legend-labels"><span>Low</span><span>High</span></div></div>';
        return div;
      }
    });
    this._legendControl = new LegendControl({ position: 'bottomright' });
    this._legendControl.addTo(this.map);
  }

  /**
   * Update the legend to reflect the current coloring metric and data range.
   */
  updateLegend() {
    if (!this._legendControl) return;
    const el = this._legendControl.getContainer();
    if (!el) return;

    const metric = this.activeColoringMetric || 'gsr';

    const metricNames = {
      'gsr':              'GSR Arousal',
      'hdopQuality':      'GPS Accuracy (HDOP)',
      'roadClass':        'Road Class',
      'distMajorRoad':    'Distance to Major Road',
      'inPark':           'In Park / Green Space',
      'greenPct':         'Green Space %',
      'buildingDensity':  'Building Density',
      'distWater':        'Distance to Water',
      'treeDensity':      'Tree Density',
      'amenityCount':     'Amenity Count'
    };

    const title = metricNames[metric] || metric;

    if (metric === 'roadClass') {
      const allRoadLabels = {
        'motorway':       '#ff0055',
        'trunk':          '#ff4400',
        'primary':        '#ff6600',
        'secondary':      '#ffaa00',
        'tertiary':       '#ffd500',
        'residential':    '#0099ff',
        'pedestrian':     '#00ffc4',
        'footway':        '#00e575',
        'path':           '#80e500',
        'cycleway':       '#00ffd5',
        'living_street':  '#9b5de5',
        'service':        '#b8c0ff',
        'track':          '#a0522d',
        'unclassified':   '#8899aa',
        'steps':          '#cc9966'
      };
      let html = `<div class="legend-title">${title}</div><div class="legend-swatches">`;
      let count = 0;
      for (const [name, color] of Object.entries(allRoadLabels)) {
        if (this._legendUniqueVals && !this._legendUniqueVals.has(name)) continue;
        html += `<div class="legend-swatch-row"><span class="legend-swatch" style="background:${color}"></span>${name}</div>`;
        count++;
      }
      if (count === 0) html += '<div class="legend-swatch-row" style="color:#999">No data</div>';
      html += '</div>';
      el.innerHTML = html;
      return;
    }

    if (metric === 'inPark') {
      const hasYes = this._legendUniqueVals && this._legendUniqueVals.has(1);
      const hasNo  = this._legendUniqueVals && this._legendUniqueVals.has(0);
      let html = `<div class="legend-title">${title}</div><div class="legend-swatches">`;
      if (hasYes) html += '<div class="legend-swatch-row"><span class="legend-swatch" style="background:#00e575"></span>Yes</div>';
      if (hasNo)  html += '<div class="legend-swatch-row"><span class="legend-swatch" style="background:#666666"></span>No</div>';
      if (!hasYes && !hasNo) html += '<div class="legend-swatch-row" style="color:#999">No data</div>';
      html += '</div>';
      el.innerHTML = html;
      return;
    }

    // Continuous metrics — build gradient bar
    const minV = this._legendMinVal;
    const maxV = this._legendMaxVal;

    let gradient;
    switch (metric) {
      case 'greenPct':
        gradient = 'linear-gradient(90deg, hsl(30,80%,45%), hsl(130,80%,45%))';
        break;
      case 'buildingDensity':
        gradient = 'linear-gradient(90deg, hsl(120,85%,50%), hsl(60,85%,50%), hsl(0,85%,50%))';
        break;
      case 'distMajorRoad':
        gradient = 'linear-gradient(90deg, hsl(0,85%,50%), hsl(60,85%,50%), hsl(120,85%,50%))';
        break;
      case 'distWater':
        gradient = 'linear-gradient(90deg, hsl(200,80%,45%), hsl(100,80%,45%), hsl(30,80%,45%))';
        break;
      case 'treeDensity':
        gradient = 'linear-gradient(90deg, hsl(60,30%,45%), hsl(140,90%,45%))';
        break;
      case 'amenityCount':
        gradient = 'linear-gradient(90deg, hsl(240,85%,55%), hsl(120,85%,55%), hsl(0,85%,55%))';
        break;
      case 'hdopQuality':
        // Gradient left = best accuracy (green), right = worst (red)
        gradient = 'linear-gradient(90deg, hsl(120,90%,45%), hsl(60,90%,45%), hsl(0,90%,45%))';
        break;
      default: // gsr
        gradient = 'linear-gradient(90deg, hsl(120,90%,50%), hsl(60,90%,50%), hsl(0,90%,50%))';
        break;
    }

    // Format min/max nicely
    const fmt = (v) => {
      if (v >= 100) return v.toFixed(0);
      if (v >= 1) return v.toFixed(1);
      return v.toFixed(3);
    };

    const leftLabel  = metric === 'hdopQuality' ? `HDOP ${fmt(minV)} (best)` : fmt(minV);
    const rightLabel = metric === 'hdopQuality' ? `HDOP ${fmt(maxV)} (worst)` : fmt(maxV);

    el.innerHTML = `
      <div class="legend-title">${title}</div>
      <div class="legend-scale">
        <div class="legend-gradient" style="background:${gradient}"></div>
        <div class="legend-labels"><span>${leftLabel}</span><span>${rightLabel}</span></div>
      </div>`;
  }

  /**
   * Remove all layers in the array from the map and clear the array.
   */
  _clearLayerGroup(arr) {
    if (!this.map) return;
    if (arr) arr.forEach(item => this.map.removeLayer(item));
    return [];
  }

  /**
   * Reset path and markers on map
   */
  clearMap() {
    if (!this.map) return;
    this.pathSegments = this._clearLayerGroup(this.pathSegments);
    this.peakMarkers = this._clearLayerGroup(this.peakMarkers);
    this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    this.clearOsmShapes();

    if (this.map.hasLayer(this.scrubMarker)) {
      this.map.removeLayer(this.scrubMarker);
    }

    // Reset legend
    this._legendMinVal = 0;
    this._legendMaxVal = 0;
    this._legendUniqueVals = null;
    this.updateLegend();
  }

  _getHslColor(ratio, saturation = 100, lightness = 50) {
    const r = Math.max(0, Math.min(1, ratio));
    const hue = (1.0 - r) * 120;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }

  /**
   * Map value to HSL color (Green = 120 -> Yellow -> Red = 0)
   */
  getColorForValue(val, minVal, maxVal) {
    if (maxVal === minVal) return 'hsl(120, 90%, 50%)'; // default green
    const ratio = (val - minVal) / (maxVal - minVal);
    return this._getHslColor(ratio, 90, 50);
  }

  /**
   * Hash GPS filter params for cache key comparison.
   * Only hashes params that affect the GPS pipeline output.
   */
  _hashGpsParams(p) {
    return `${p.maxHdop || 2.0}|${p.smoothing || 0.5}|${p.kalmanR || 10}|${p.maxSpeed || 3.0}|${p.downsample ? 1 : 0}|${p.rdpTolerance || 0}`;
  }

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
    const fa = first ? first.alpha.toFixed(3) : '?';
    const ma = mid   ? mid.alpha.toFixed(3)   : '?';
    const la = last  ? last.alpha.toFixed(3)  : '?';
    return `${n}|${fa}|${ma}|${la}`;
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

    gpsPoints = this._applyHdopGate(gpsPoints, p.maxHdop || 2.0);
    gpsPoints = this._applyFixTypeGate(gpsPoints);

    const smoothing = p.smoothing || 0.5;
    const kalmanR   = p.kalmanR || 10;
    gpsPoints = this._applyPreKalmanFilters(gpsPoints, smoothing, p.maxSpeed || 3.0);

    if (analyzer.snappedGps) {
      gpsPoints = this._applySnapCorrection(gpsPoints, analyzer.snappedGps);
    }

    gpsPoints = GpsFilter.applyKalman(gpsPoints, smoothing, kalmanR);

    // Reconstruct full 10 Hz filtered GPS path (cached on analyzer)
    this._reconstructFilteredGpsCached(analyzer, data, gpsPoints);

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
          origIdx: i
        });
      }
    }

    drawPoints = this._downsampleForDisplay(drawPoints, analyzer.sampleRate || 10.0, p.downsample === true || p.downsample === 1);
    drawPoints = GpsFilter.applyRDP(drawPoints, p.rdpTolerance || 0);

    this._gpsCache.set(cacheKey, { paramsHash, snapFingerprint: snapFp, gpsPoints, drawPoints });
    return { gpsPoints, drawPoints };
  }

  /**
   * Cached version of _reconstructFilteredGps — avoids rebuilding the
   * 10 Hz interpolated path when the GPS pipeline hasn't changed.
   */
  _reconstructFilteredGpsCached(analyzer, data, gpsPoints) {
    // Use a lightweight hash of gpsPoints to detect actual changes
    const n = gpsPoints.length;
    if (n === 0) {
      if (!analyzer._filteredGpsCacheKey) {
        this._reconstructFilteredGps(analyzer, data, gpsPoints);
        analyzer._filteredGpsCacheKey = 'empty';
      }
      return;
    }
    // Hash: first + last + count + mid-point (fast identity check)
    const key = `${gpsPoints[0].origIdx}|${gpsPoints[n - 1].origIdx}|${n}|${gpsPoints[Math.floor(n / 2)].origIdx}`;
    if (analyzer._filteredGpsCacheKey === key) return;

    this._reconstructFilteredGps(analyzer, data, gpsPoints);
    analyzer._filteredGpsCacheKey = key;
  }

  /**
   * Build or retrieve a pre-computed color lookup table for a metric.
   * Returns an array of 30 CSS color strings.
   */
  _getColorLut(metric, minVal, maxVal) {
    const cacheKey = `${metric}|${minVal.toFixed(4)}|${maxVal.toFixed(4)}`;
    let lut = this._colorLutCache.get(cacheKey);
    if (lut) return lut;

    lut = new Array(30);
    const range = maxVal - minVal;
    for (let b = 0; b < 30; b++) {
      const ratio = range > 1e-9 ? (b + 0.5) / 30 : 0.5;
      lut[b] = this.getColorForMetric(metric, minVal + ratio * range, minVal, maxVal);
    }
    this._colorLutCache.set(cacheKey, lut);
    // Limit cache size
    if (this._colorLutCache.size > 50) {
      const firstKey = this._colorLutCache.keys().next().value;
      this._colorLutCache.delete(firstKey);
    }
    return lut;
  }

  /**
   * Render color-coded path segments and add stress peak markers.
   *
   * @param {GSRAnalyzer} analyzer
   * @param {object} [gpsParams] – GPS filter settings
   */
  renderData(analyzer, gpsParams) {
    if (!gpsParams) gpsParams = {};
    this.clearMap();

    const p = gpsParams;
    const data = analyzer.raw;
    if (!data || data.length === 0) return;

    // Use cached GPS pipeline result (cache keyed by active track id)
    const cacheKey = AppState.activeTrackId || 'single';
    const { drawPoints } = this._getOrBuildDrawPoints(cacheKey, analyzer, p);
    if (drawPoints.length === 0) return;

    // Render on Leaflet map
    this._fitBounds(drawPoints);
    this._renderPathSegments(drawPoints, p.trackWeight || 5);

    // Peak markers (with latency compensation)
    this._renderPeakMarkers(analyzer, data, p.peakLatency || 0);

    // Apply the active peak/label toggle styles
    this.updateMarkerVisibility();
  }

  /**
   * Invalidate GPS cache for a specific track (call when GPS params change).
   */
  invalidateGpsCache(trackId) {
    this._gpsCache.delete(trackId || 'single');
  }

  // ── Pipeline helpers ──────────────────────────────────────────────────────

  _collectGpsPoints(data) {
    const pts = [];
    for (let i = 0; i < data.length; i++) {
      // Only collect actual GPS fixes (not interpolated points) so the
      // Kalman filter processes the true measurement rate (1-2 Hz) rather
      // than the 10 Hz interpolated grid, preventing artificial covariance
      // deflation and sluggish corner tracking.
      if (data[i]._isGpsFix && !isNaN(data[i].lat) && !isNaN(data[i].lon)) {
        pts.push({ ...data[i], origIdx: i });
      }
    }
    return pts;
  }

  /**
   * HDOP gate: rejects GPS anchors with poor satellite geometry.
   * Default threshold 3.0 — the firmware already pre-filters at 5.0;
   * this provides a tighter second pass.  Points without HDOP data
   * (NaN, old CSV) are always kept.
   */
  _applyHdopGate(pts, maxHdop = 3.0) {
    return pts.filter(d => isNaN(d.hdop) || d.hdop <= maxHdop);
  }

  /**
   * Fix-type gate: rejects "no fix" (type 1).  2D fixes are kept —
   * they have excellent horizontal accuracy even without altitude.
   * Points without fix_type (old CSV, value 0) are always kept.
   */
  _applyFixTypeGate(pts, minFixType = 2) {
    if (minFixType < 2) return pts;
    return pts.filter(d => d.fixType == null || d.fixType === 0 || d.fixType >= minFixType);
  }

  /**
   * Pre-Kalman GPS filters (run before snap+enrich pass).
   *
   * 1. Stop averaging — collapses stationary jitter clusters
   * 2. Speed filter — rejects impossible jumps (Doppler speedKts, ≤3 m/s)
   * 3. Velocity-aided smoother — dead-reckons from Doppler, ZUPT at ≤0.5 kt
   *
   * Kalman RTS runs separately AFTER road snapping (if enabled) so it
   * smooths the bias-corrected trajectory rather than the raw drift.
   *
   * @param {Array}  pts       – GPS anchor points
   * @param {number} smoothing – process noise Q (0.1–2.0, default 0.5)
   * @param {number} maxSpeed  – max plausible speed in m/s (default 3.0)
   */
  _applyPreKalmanFilters(pts, smoothing = 0.5, maxSpeed = 3.0) {
    pts = GpsFilter.applyStopAveraging(pts);
    pts = GpsFilter.applySpeedFilter(pts, maxSpeed);
    pts = GpsFilter.applyVelocitySmoothing(pts, smoothing);
    return pts;
  }

  /**
   * Post-Kalman snap correction: for each GPS point, blend the
   * Kalman-smoothed position toward the snapped road position using the
   * alpha computed during enrichment.  Points without snap data or with
   * alpha=0 keep their Kalman-smoothed position unchanged.
   */
  _applySnapCorrection(gpsPoints, snappedGps) {
    const result = [];
    for (const pt of gpsPoints) {
      const sg = snappedGps[pt.origIdx];
      if (sg && !isNaN(sg.alpha) && sg.alpha > 0 && !isNaN(sg.roadLat) && !isNaN(sg.roadLon)) {
        // Re-blend: Kalman-smoothed position → road position using alpha
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
  }

  _reconstructFilteredGps(analyzer, data, gpsPoints) {
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

    // Interpolate between valid points, but leave large gaps as NaN so the
    // rendered path breaks instead of drawing a misleading straight line.
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
  }

  _downsampleForDisplay(gpsPoints, sampleRate, doDownsample) {
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

  _fitBounds(drawPoints) {
    const bounds = drawPoints.map(p => [p.lat, p.lon]);
    this.map.fitBounds(bounds, { padding: [30, 30] });
  }

  _getMetricKey(metric) {
    const keys = {
      'gsr': 'val',
      'hdopQuality': 'hdop',
      'roadClass': 'osm_road_class',
      'distMajorRoad': 'osm_dist_major_road',
      'inPark': 'osm_in_park',
      'greenPct': 'osm_green_pct_50m',
      'buildingDensity': 'osm_building_density_50m',
      'distWater': 'osm_dist_water',
      'treeDensity': 'osm_tree_density_50m',
      'amenityCount': 'osm_amenity_count_50m'
    };
    return keys[metric] || 'val';
  }

  getColorForMetric(metric, val, minVal, maxVal) {
    if (metric === 'gsr') {
      return this.getColorForValue(val, minVal, maxVal);
    }
    
    if (metric === 'roadClass') {
      const roadColors = {
        'motorway':       '#ff0055',
        'trunk':          '#ff4400',
        'primary':        '#ff6600',
        'secondary':      '#ffaa00',
        'tertiary':       '#ffd500',
        'residential':    '#0099ff',
        'pedestrian':     '#00ffc4',
        'footway':        '#00e575',
        'path':           '#80e500',
        'cycleway':       '#00ffd5',
        'living_street':  '#9b5de5',
        'service':        '#b8c0ff',
        'track':          '#a0522d',
        'unclassified':   '#8899aa',
        'steps':          '#cc9966'
      };
      return roadColors[val] || '#666666';
    }
    
    if (metric === 'inPark') {
      return val === 1 ? '#00e575' : '#666666';
    }

    if (metric === 'hdopQuality') {
      // Low HDOP = good accuracy (green), high HDOP = poor accuracy (red).
      // Sentinel 99.9 (no data) rendered gray.
      if (isNaN(val) || val >= 50) return '#888888';
      let ratio = 0;
      if (maxVal !== minVal) ratio = (val - minVal) / (maxVal - minVal);
      ratio = Math.max(0, Math.min(1, ratio));
      const hue = Math.round((1.0 - ratio) * 120);
      return `hsl(${hue}, 90%, 45%)`;
    }

    let ratio = 0;
    if (maxVal !== minVal) {
      ratio = (val - minVal) / (maxVal - minVal);
    }
    ratio = Math.max(0, Math.min(1, ratio));

    if (metric === 'greenPct') {
      // Brown (0%) to Green (100%)
      const hue = 30 + ratio * 100;
      return `hsl(${hue}, 80%, 45%)`;
    }
    
    if (metric === 'buildingDensity') {
      // Green (low density) to Red (high density)
      const hue = (1.0 - ratio) * 120;
      return `hsl(${hue}, 85%, 50%)`;
    }
    
    if (metric === 'distMajorRoad') {
      // Close (Red) to Far (Green)
      const hue = ratio * 120;
      return `hsl(${hue}, 85%, 50%)`;
    }
    
    if (metric === 'distWater') {
      // Close (Cyan/Blue) to Far (Brown/Gray)
      const hue = 200 - ratio * 170;
      return `hsl(${hue}, 80%, 45%)`;
    }
    
    if (metric === 'treeDensity') {
      // None (Gray) to Many (Emerald Green)
      const hue = 60 + ratio * 80;
      const sat = 30 + ratio * 60;
      return `hsl(${hue}, ${sat}%, 45%)`;
    }
    
    if (metric === 'amenityCount') {
      // None (Gray) to Many (Purple/Red)
      const hue = 240 - ratio * 240;
      return `hsl(${hue}, 85%, 55%)`;
    }
    
    return '#666666';
  }

  /**
   * Draw OSM vector geometry overlays (parks, water, buildings) on the map.
   * Accepts pre-built geoms (from analyzer.osmGeoms) to avoid redundant
   * geometry reconstruction.
   */
  drawOsmShapes(geoms) {
    this.clearOsmShapes();
    if (!geoms || !geoms.ways || !this.map) return;
    
    this.osmLayers = [];

    geoms.ways.concat(geoms.relations).forEach(geom => {
      const tags = geom.tags;
      if (!tags) return;

      const isPark = tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'nature_reserve' || tags.leisure === 'playground' || tags.landuse === 'grass' || tags.landuse === 'forest' || tags.landuse === 'meadow' || tags.landuse === 'recreation_ground' || tags.landuse === 'village_green' || tags.natural === 'wood' || tags.natural === 'scrub' || tags.natural === 'grassland' || tags.natural === 'heath';
      const isWater = tags.natural === 'water' || tags.natural === 'wetland' || tags.waterway === 'river' || tags.waterway === 'canal' || tags.waterway === 'stream' || tags.waterway === 'drain' || tags.waterway === 'ditch' || tags.landuse === 'basin' || tags.landuse === 'reservoir';
      const isBuilding = !!tags.building;

      let color = null;
      let fillColor = null;
      let fillOpacity = 0.15;

      if (isPark) {
        color = '#2d6a4f';
        fillColor = '#52b788';
      } else if (isWater) {
        color = '#0077b6';
        fillColor = '#90e0ef';
        fillOpacity = 0.25;
      } else if (isBuilding) {
        color = '#4a4e69';
        fillColor = '#9a8c98';
        fillOpacity = 0.1;
      }

      if (color) {
        if (geom.type === 'way' && geom.coordinates.length > 2) {
          const latlngs = geom.coordinates.map(pt => [pt.lat, pt.lon]);
          const poly = L.polygon(latlngs, { color, fillColor, fillOpacity, weight: 1 }).addTo(this.map);
          this.osmLayers.push(poly);
        } else if (geom.type === 'relation' && geom.outerWays) {
          geom.outerWays.forEach(way => {
            const latlngs = way.coordinates.map(pt => [pt.lat, pt.lon]);
            const poly = L.polygon(latlngs, { color, fillColor, fillOpacity, weight: 1 }).addTo(this.map);
            this.osmLayers.push(poly);
          });
        }
      }
    });
  }

  clearOsmShapes() {
    if (this.osmLayers) {
      this.osmLayers.forEach(layer => this.map.removeLayer(layer));
    }
    this.osmLayers = [];
  }

  _renderPathSegments(drawPoints, trackWeight) {
    const metric = this.activeColoringMetric || 'gsr';
    const key = this._getMetricKey(metric);
    const isCategorical = (metric === 'roadClass');
    const needsUnique = (isCategorical || metric === 'inPark');

    // ── Single pass over drawPoints (already downsampled) for min/max ──
    let minVal = Infinity, maxVal = -Infinity;
    const seen = needsUnique ? new Set() : null;

    for (let i = 0; i < drawPoints.length; i++) {
      const v = drawPoints[i][key];
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
    const colorLut = isCategorical ? null : this._getColorLut(metric, minVal, maxVal);

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
        const startVal = seg[batchStart][key];

        let startBucket = 0;
        if (!isCategorical) {
          const avgVal = (seg[batchStart][key] + seg[batchStart + 1][key]) / 2;
          startBucket = (avgVal - minVal) * (COLOR_BUCKETS / range);
          startBucket = startBucket < 0 ? 0 : (startBucket >= COLOR_BUCKETS ? COLOR_BUCKETS - 1 : startBucket | 0);
        }

        let batchEnd = batchStart + 1;
        while (batchEnd < seg.length - 1) {
          if (isCategorical) {
            if (seg[batchEnd][key] !== startVal) break;
          } else {
            const val = (seg[batchEnd][key] + seg[batchEnd + 1][key]) / 2;
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
          color = this.getColorForMetric(metric, startVal, minVal, maxVal);
        } else {
          const midIdx = (batchStart + batchEnd) >> 1;
          const midBucket = ((seg[midIdx][key] + seg[midIdx + 1][key]) / 2 - minVal) * (COLOR_BUCKETS / range);
          const b = midBucket < 0 ? 0 : (midBucket >= COLOR_BUCKETS ? COLOR_BUCKETS - 1 : midBucket | 0);
          color = colorLut[b];
        }

        this.pathSegments.push(
          L.polyline(latlngsBuf.slice(), { color, weight: trackWeight, opacity: 0.95 }).addTo(this.map)
        );

        batchStart = batchEnd;
      }
    }

    // Update legend with current metric and data range
    this.updateLegend();
  }

  // Note: Cartographic label placement algorithms and HTML builders moved to GSRLabelManager in label_placement.js

  _buildStreetViewButton(lat, lon, label) {
    const btn = L.DomUtil.create('button', 'btn-external-link streetview');
    btn.title = 'View street-level imagery';
    btn.innerHTML = '<i class="fa-solid fa-street-view"></i> Street View';
    L.DomEvent.on(btn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      GSRUI.openStreetView(lat, lon, label);
    });
    L.DomEvent.disableClickPropagation(btn);
    return btn;
  }

  /**
   * Shared popup builder used by both single-track and collective views.
   * @param {Object} opts
   * @param {string} opts.heading        - Popup header text
   * @param {Object} opts.analyzerRef    - GSRAnalyzer instance (for date/time formatting)
   * @param {Object} opts.peak           - Peak event object
   * @param {number} opts.index          - Peak index
   * @param {number} opts.lat            - Latitude
   * @param {number} opts.lon            - Longitude
   * @param {Object} opts.marker         - Leaflet marker (for closePopup)
   * @param {string} [opts.trackId]      - Track ID (collective); omitted for single
   * @param {string} [opts.extraClass]   - Extra CSS class, e.g. 'compact'
   */
  _buildPeakPopup(opts) {
    const { heading, analyzerRef, peak, index, lat, lon, marker, trackId, extraClass } = opts;
    const displayLabel = peak.label || '';
    const quality = getQualityLabel(peak.qualityScore);

    const container = L.DomUtil.create('div');
    container.className = 'map-popup-card' + (extraClass ? ' ' + extraClass : '');

    const headerRow = L.DomUtil.create('div', 'popup-header-row', container);
    const h4 = L.DomUtil.create('h4', '', headerRow);
    h4.textContent = heading;

    const table = L.DomUtil.create('table', 'popup-table', container);

    // --- Label row (editable) ---
    const trLabel = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trLabel).textContent = 'Label:';
    const tdLabel2 = L.DomUtil.create('td', '', trLabel);
    const input = L.DomUtil.create('input', 'popup-label-input', tdLabel2);
    input.type = 'text';
    input.value = displayLabel;
    input.placeholder = 'Enter label…';

    // --- Date row ---
    const trDate = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trDate).textContent = 'Date:';
    L.DomUtil.create('td', '', trDate).textContent = analyzerRef.formatDateUK(peak.time);

    // --- Time row ---
    const trTime = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trTime).textContent = 'Time:';
    L.DomUtil.create('td', '', trTime).textContent = analyzerRef.formatTimeOnly(peak.time);

    // --- Quality row ---
    const trQuality = L.DomUtil.create('tr', '', table);
    L.DomUtil.create('td', '', trQuality).textContent = 'Quality:';
    const tdQuality2 = L.DomUtil.create('td', '', trQuality);
    tdQuality2.innerHTML = '<span style="color:' + getQualityColor(peak.qualityScore) +
      ';font-weight:600;">' + quality.label + ' (' + quality.pct + '%)</span>';

    // --- Bottom row: external links (left) + exclude button (right) ---
    const bottomRow = L.DomUtil.create('div', 'popup-bottom-row', container);
    const links = L.DomUtil.create('div', 'popup-external-links', bottomRow);
    links.appendChild(this._buildStreetViewButton(
      lat, lon,
      displayLabel || ('Peak #' + (index + 1))
    ));

    const excludeBtn = L.DomUtil.create('button', 'btn-exclude-popup', bottomRow);
    excludeBtn.title = peak.excluded ? 'Include peak' : 'Exclude peak';
    excludeBtn.innerHTML = peak.excluded
      ? '<i class="fa-solid fa-plus"></i>'
      : '<i class="fa-solid fa-xmark"></i>';

    // --- Event handlers ---
    L.DomEvent.on(input, 'change', () => GSRUI.updatePeakLabel(index, input.value, trackId));
    L.DomEvent.on(input, 'keydown', (e) => {
      if (e.key === 'Enter') { GSRUI.updatePeakLabel(index, input.value, trackId); input.blur(); }
    });
    L.DomEvent.disableClickPropagation(input);

    L.DomEvent.on(excludeBtn, 'click', () => {
      GSRUI.togglePeakExclusion(index, trackId);
      marker.closePopup();
    });
    L.DomEvent.disableClickPropagation(excludeBtn);

    return container;
  }

  _buildSinglePeakPopup(analyzer, peak, index, coords, marker) {
    return this._buildPeakPopup({
      heading:     peak.label || ('#' + (index + 1)),
      analyzerRef: analyzer,
      peak:        peak,
      index:       index,
      lat:         coords.lat,
      lon:         coords.lon,
      marker:      marker
    });
  }

  _buildCollectivePeakPopup(track, peak, index, lat, lon, marker) {
    return this._buildPeakPopup({
      heading:     track.name,
      analyzerRef: track.analyzer,
      peak:        peak,
      index:       index,
      lat:         lat,
      lon:         lon,
      marker:      marker,
      trackId:     track.id,
      extraClass:  'compact'
    });
  }

  _renderPeakMarkers(analyzer, data, peakLatency) {
    const map = this.map;
    const labelCandidates = [];
    const allPeaks = [];

    // First pass: collect pixel positions
    analyzer.peaks.forEach((peak, index) => {
      // Original (unshifted) position — used for connector line
      const origCoords = analyzer.getCoordinates(peak.index);
      const origPt = origCoords ? map.latLngToLayerPoint([origCoords.lat, origCoords.lon]) : null;

      // Apply latency: find GPS position at (peak time - latency)
      let si = peak.index;
      if (peakLatency > 0) {
        const shiftedTime = Math.max(0, peak.time - peakLatency);
        si = analyzer.findClosestIndex(shiftedTime);
        if (si < 0) si = peak.index;
      }
      const coords = analyzer.getCoordinates(si);
      if (!coords) return;
      const pt = map.latLngToLayerPoint([coords.lat, coords.lon]);
      const origLatLon = origCoords ? [origCoords.lat, origCoords.lon] : null;
      allPeaks.push({ peak, index, coords, px: pt.x, py: pt.y, origPt, origLatLon });
      if (peak.label && peak.label.trim()) {
        labelCandidates.push({ idx: index, px: pt.x, py: pt.y, text: peak.label });
      }
    });

    // Compute 360° label positions
    const labelPositions = GSRLabelManager.computeLabelPositions(labelCandidates);

    // Compact dot-only icon for peaks without labels
    const simpleIcon = L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:24px;height:24px;"><div class="peak-glow-ring" style="position:absolute;top:0;left:0;"></div><div class="peak-dot" style="position:absolute;top:7px;left:7px;width:10px;height:10px;"></div></div>',
      iconSize: [24, 24], iconAnchor: [12, 12]
    });

    allPeaks.forEach(({ peak, index, coords, px, py }) => {
      const displayLabel = peak.label || '';

      let marker;
      const hasLabel = displayLabel && displayLabel.trim();
      if (hasLabel) {
        const dirResult = labelPositions.get(index);
        if (dirResult) {
          marker = L.marker([coords.lat, coords.lon], {
            icon: GSRLabelManager.buildLabelledIcon(px, py, displayLabel, dirResult)
          });
          // Bump labeled markers above unlabeled markers and path layers
          marker.setZIndexOffset(1000);
          marker.hasLabel = true;
        } else {
          // All 8 positions overlapped — fall back to dot-only
          marker = L.marker([coords.lat, coords.lon], { icon: simpleIcon });
          marker.hasLabel = false;
        }
      } else {
        marker = L.marker([coords.lat, coords.lon], { icon: simpleIcon });
        marker.hasLabel = false;
      }

      const shouldAdd = this.showPeaks || (this.showLabels && marker.hasLabel);
      if (shouldAdd) marker.addTo(this.map);

      // Dim excluded peak markers
      if (peak.excluded) {
        marker.setOpacity(0.35);
      }

      marker.bindPopup(() => this._buildSinglePeakPopup(analyzer, peak, index, coords, marker));

      this.peakMarkers.push(marker);
    });

    // Draw connector lines from original (unshifted) to shifted position
    if (peakLatency > 0) {
      for (const ap of allPeaks) {
        if (!ap.origLatLon) continue;
        const shiftedLatLon = [ap.coords.lat, ap.coords.lon];
        const conn = L.polyline([ap.origLatLon, shiftedLatLon], {
          color: '#f43f5e',
          weight: 1.5,
          opacity: 0.35,
          dashArray: '3, 5'
        }).addTo(this.map);
        this.peakMarkers.push(conn); // store so clearMap removes them
      }
    }

    // Render cluster boundaries
    const activePeaks = allPeaks.filter(ap => !ap.peak.excluded);
    if (activePeaks.length > 0 && typeof GSRSpatialClustering !== 'undefined') {
      const ptsForClustering = activePeaks.map(ap => ({
        lat: ap.coords.lat,
        lon: ap.coords.lon,
        amplitude: ap.peak.amplitude
      }));

      // Retrieve dynamic clustering parameters from UI sliders
      const { boundaryRadius, sigma, effectiveProximity } = this._getClusteringParams();

      // Group peaks within selected proximity limit
      const clusters = GSRSpatialClustering.clusterPeaks(ptsForClustering, effectiveProximity);

      clusters.forEach(cluster => {
        const paths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, boundaryRadius);
        paths.forEach(path => {
          const latlngs = path.map(p => [p.lat, p.lon]);
          const poly = L.polygon(latlngs, {
            color: '#f43f5e', // Use stress rose color for visual emphasis
            weight: 2,
            fillColor: '#f43f5e',
            fillOpacity: 0.12,
            dashArray: '4, 6',
            lineCap: 'round',
            lineJoin: 'round'
          });
          if (this.showClusters) poly.addTo(this.map);
          this.clusterLayers.push(poly);
        });
      });
    }
  }

  /**
   * Helper to retrieve validated clustering configuration parameters from sliders.
   * Ensures the proximity is mathematically constrained by the boundary radius to prevent visual overlaps.
   *
   * @private
   */
  _getClusteringParams() {
    let proximity = AppState.sliders.clusterProximity ? parseFloat(AppState.sliders.clusterProximity.value) : 35;
    if (isNaN(proximity)) proximity = 35;
    let boundaryRadius = AppState.sliders.clusterBoundaryRadius ? parseFloat(AppState.sliders.clusterBoundaryRadius.value) : 18;
    if (isNaN(boundaryRadius)) boundaryRadius = 18;

    return {
      proximity,
      boundaryRadius,
      sigma: boundaryRadius * 0.83,
      effectiveProximity: Math.max(proximity, boundaryRadius * 2.1)
    };
  }

  /**
   * Zoom the map in by one level.
   */
  zoomIn() {
    if (this.map) {
      this.map.zoomIn();
    }
  }

  /**
   * Zoom the map out by one level.
   */
  zoomOut() {
    if (this.map) {
      this.map.zoomOut();
    }
  }

  /**
   * Zoom and pan the map to fit the current polyline track extent.
   */
  fitToTrack() {
    if (this.map && this.pathSegments.length > 0) {
      const group = new L.featureGroup(this.pathSegments);
      this.map.fitBounds(group.getBounds(), { padding: [30, 30] });
    }
  }

  /**
   * Toggle the visibility of the stress peak markers on the map layer.
   */
  togglePeaks(visible) {
    this.showPeaks = visible;
    this.updateMarkerVisibility();
  }

  /**
   * Toggle the visibility of the stress peak labels (text) on the map layer.
   */
  toggleLabels(visible) {
    this.showLabels = visible;
    this.updateMarkerVisibility();
  }

  /**
   * Update Leaflet map layer inclusion and CSS class styles based on current peak/label toggles.
   */
  updateMarkerVisibility() {
    if (!this.map) return;

    const mapEl = document.getElementById(this.containerId);
    if (mapEl) {
      if (this.showPeaks) {
        mapEl.classList.remove('hide-map-peaks');
      } else {
        mapEl.classList.add('hide-map-peaks');
      }

      if (this.showLabels) {
        mapEl.classList.remove('hide-map-labels');
      } else {
        mapEl.classList.add('hide-map-labels');
      }
    }

    const allMarkers = [...this.peakMarkers, ...this.collectivePeakMarkers];
    allMarkers.forEach(m => {
      const shouldShow = this.showPeaks || (this.showLabels && m.hasLabel);
      if (shouldShow) {
        if (!this.map.hasLayer(m)) m.addTo(this.map);
      } else {
        if (this.map.hasLayer(m)) this.map.removeLayer(m);
      }
    });
  }

  /**
   * Toggle the visibility of the stress peak clusters on the map layer.
   */
  toggleClusters(visible) {
    this.showClusters = visible;
    const toggle = (m) => {
      if (visible) {
        if (!this.map.hasLayer(m)) m.addTo(this.map);
      } else {
        if (this.map.hasLayer(m)) this.map.removeLayer(m);
      }
    };
    this.clusterLayers.forEach(toggle);
  }

  /**
   * Set scrubbing indicator dot position
   */
  setScrubPosition(lat, lon, panTo = false) {
    if (isNaN(lat) || isNaN(lon)) {
      if (this.map.hasLayer(this.scrubMarker)) {
        this.map.removeLayer(this.scrubMarker);
      }
      return;
    }

    this.scrubMarker.setLatLng([lat, lon]);
    if (!this.map.hasLayer(this.scrubMarker)) {
      this.scrubMarker.addTo(this.map);
    }

    if (panTo) {
      const pos = [lat, lon];
      if (!this.map.getBounds().contains(pos)) {
        this.map.panTo(pos);
      }
    }
  }

  /**
   * Remove all collective track paths and peak markers from the map.
   */
  clearCollectiveLayers() {
    this.collectivePathSegments = this._clearLayerGroup(this.collectivePathSegments);
    this.collectivePeakMarkers = this._clearLayerGroup(this.collectivePeakMarkers);
    this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    this.clearContours();
  }

  /**
   * Remove only the topographic isolines layer from the map.
   */
  clearContours() {
    this.contourLayers = this._clearLayerGroup(this.contourLayers);
    if (this.surfaceOverlay) {
      this.map.removeLayer(this.surfaceOverlay);
      this.surfaceOverlay = null;
    }
  }

  /**
   * Render all active tracks overlaid simultaneously, then draw contour lines.
   */
  renderCollectiveData(collectiveManager, contourParams = {}, peakLatency) {
    this.clearMap(); // Clear single-track drawing
    this.clearCollectiveLayers();

    const activeTracks = collectiveManager.getActiveTracks();
    if (activeTracks.length === 0) return;

    const allActivePeaksAcrossTracks = [];

    // 1. Draw dashed, semi-transparent paths for each track
    activeTracks.forEach(track => {
      const data = track.analyzer.raw;
      const p = track.gpsFilterParams || {};

      // Use cached GPS pipeline (cache keyed by track id)
      const { drawPoints } = this._getOrBuildDrawPoints(track.id, track.analyzer, p);
      if (drawPoints.length < 2) return;

      const latlngs = drawPoints.map(pt => [pt.lat, pt.lon]);
      const trackColor = track.color || '#0ea5e9';

      const poly = L.polyline(latlngs, {
        color: trackColor,
        weight: 3,
        opacity: 0.35,
        dashArray: '5, 8'
      }).addTo(this.map);

      this.collectivePathSegments.push(poly);

      // 2. Draw peak dot markers — 360° label placement with collision avoidance
      const map = this.map;
      const collectiveLabelCandidates = [];
      const collectiveAllPeaks = [];

      // First pass: collect pixel positions (with latency compensation)
      track.analyzer.peaks.forEach((peak, index) => {
        // Original (unshifted) GPS position for connector line
        const origCoords = track.analyzer.getCoordinates(peak.index);

        // Shifted position (with latency)
        let si = peak.index;
        if (peakLatency > 0) {
          const shiftedTime = Math.max(0, peak.time - peakLatency);
          si = track.analyzer.findClosestIndex(shiftedTime);
          if (si < 0) si = peak.index;
        }
        const coords = track.analyzer.getCoordinates(si);
        if (coords) {
          const pt = map.latLngToLayerPoint([coords.lat, coords.lon]);
          collectiveAllPeaks.push({
            peak, index, lat: coords.lat, lon: coords.lon, px: pt.x, py: pt.y,
            origLatLon: origCoords ? [origCoords.lat, origCoords.lon] : null
          });
          if (peak.label && peak.label.trim()) {
            collectiveLabelCandidates.push({ idx: index, px: pt.x, py: pt.y, text: peak.label });
          }
          if (!peak.excluded) {
            allActivePeaksAcrossTracks.push({
              lat: coords.lat,
              lon: coords.lon,
              amplitude: peak.amplitude
            });
          }
        }
      });

      // 360° collision avoidance for collective labels
      const collectivePositions = GSRLabelManager.computeLabelPositions(collectiveLabelCandidates);

      // Compact dot-only icon for unlabeled peaks
      const collectiveSimpleIcon = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:12px;height:12px;"><div class="collective-peak-dot" style="width:10px;height:10px;border-radius:50%;background:${trackColor};box-shadow:0 1px 3px rgba(0,0,0,0.15);border:1.5px solid #fff;"></div></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      });

      collectiveAllPeaks.forEach(({ peak, index, lat, lon, px, py }) => {
        const displayLabel = peak.label || '';

        let marker;
        const hasLabel = displayLabel && displayLabel.trim();
        if (hasLabel) {
          const dirResult = collectivePositions.get(index);
          if (dirResult) {
            marker = L.marker([lat, lon], {
              icon: GSRLabelManager.buildCollectiveLabelledIcon(px, py, displayLabel, dirResult, trackColor)
            });
            // Bump labeled markers above everything else on the map
            marker.setZIndexOffset(1000);
            marker.hasLabel = true;
          } else {
            marker = L.marker([lat, lon], { icon: collectiveSimpleIcon });
            marker.hasLabel = false;
          }
        } else {
          marker = L.marker([lat, lon], { icon: collectiveSimpleIcon });
          marker.hasLabel = false;
        }

        marker.bindPopup(() => this._buildCollectivePeakPopup(track, peak, index, lat, lon, marker));
        
        const shouldAdd = this.showPeaks || (this.showLabels && marker.hasLabel);
        if (shouldAdd) marker.addTo(this.map);
        // Dim excluded peak markers
        if (peak.excluded) {
          marker.setOpacity(0.35);
        }
        this.collectivePeakMarkers.push(marker);
      });

      // Draw connector lines from original to shifted position (collective)
      if (peakLatency > 0) {
        for (const ap of collectiveAllPeaks) {
          if (!ap.origLatLon) continue;
          const shiftedLatLon = [ap.lat, ap.lon];
          const conn = L.polyline([ap.origLatLon, shiftedLatLon], {
            color: trackColor,
            weight: 1,
            opacity: 0.25,
            dashArray: '2, 4'
          }).addTo(this.map);
          this.collectivePeakMarkers.push(conn);
        }
      }
    });

    // Render collective global clusters across all active tracks
    if (allActivePeaksAcrossTracks.length > 0 && typeof GSRSpatialClustering !== 'undefined') {
      // Retrieve dynamic clustering parameters from UI sliders
      const { boundaryRadius, sigma, effectiveProximity } = this._getClusteringParams();

      const clusters = GSRSpatialClustering.clusterPeaks(allActivePeaksAcrossTracks, effectiveProximity);
      clusters.forEach(cluster => {
        const paths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, boundaryRadius);
        paths.forEach(path => {
          const latlngs = path.map(p => [p.lat, p.lon]);
          const poly = L.polygon(latlngs, {
            color: '#f43f5e', // Use stress rose color for visual emphasis across tracks
            weight: 2,
            fillColor: '#f43f5e',
            fillOpacity: 0.12,
            dashArray: '4, 6',
            lineCap: 'round',
            lineJoin: 'round'
          });
          if (this.showClusters) poly.addTo(this.map);
          this.clusterLayers.push(poly);
        });
      });
    }

    // 3. Zoom and Pan Map to fit collective bounding envelope
    const bounds = collectiveManager.getBounds();
    if (bounds) {
      this.map.fitBounds([
        [bounds.minLat, bounds.minLon],
        [bounds.maxLat, bounds.maxLon]
      ], { padding: [40, 40] });
    }

    // 4. Calculate and render topographic contour lines
    this.renderContours(collectiveManager, contourParams);

    // Apply the active peak/label toggle styles
    this.updateMarkerVisibility();
  }

  /**
   * Call contour generation math and draw vector polyline boundaries
   */
  renderContours(collectiveManager, contourParams) {
    this.clearContours();

    const surfaceData = collectiveManager.generateContourSurface(contourParams);
    if (!surfaceData || !surfaceData.contours) return;

    const { contours, grid, minVal, maxVal, bounds } = surfaceData;
    const { showShadedSurface = true, surfaceOpacity = 0.40 } = contourParams;

    // 1. Draw shaded continuous surface overlay
    if (showShadedSurface && grid && grid.length > 0 && bounds) {
      const rows = grid.length;
      const cols = grid[0].length;

      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');

      const valRange = maxVal - minVal;
      const rangeEpsilon = 1e-9;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const val = grid[r][c];
          if (val === null || isNaN(val)) {
            continue;
          }

          let ratio = 0;
          if (valRange > rangeEpsilon) {
            ratio = (val - minVal) / valRange;
          }

          ctx.fillStyle = this._getHslColor(ratio, 100, 50);

          // Flip row index vertically for canvas space
          const x = c;
          const y = rows - 1 - r;
          ctx.fillRect(x, y, 1, 1);
        }
      }

      const imageBounds = [
        [bounds.minLat, bounds.minLon],
        [bounds.maxLat, bounds.maxLon]
      ];

      this.surfaceOverlay = L.imageOverlay(canvas.toDataURL(), imageBounds, {
        opacity: surfaceOpacity,
        interactive: false,
        className: 'collective-surface-overlay'
      }).addTo(this.map);
    }

    // 2. Draw vector isoline boundaries
    contours.forEach(c => {
      const color = this._getHslColor(c.ratio, 100, 55);

      c.segments.forEach(seg => {
        const poly = L.polyline([
          [seg[0].lat, seg[0].lon],
          [seg[1].lat, seg[1].lon]
        ], {
          color: color,
          weight: 4.5,
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round'
        });

        const formattedVal = c.level.toFixed(3);
        const unit = (contourParams.topographySource === 'peaks') ? '' : ' μS';
        poly.bindTooltip(`Level: ${formattedVal}${unit}`, {
          sticky: true,
          className: 'contour-tooltip-label'
        });

        poly.addTo(this.map);
        this.contourLayers.push(poly);
      });
    });
  }
}

window.GSRMapManager = GSRMapManager;
