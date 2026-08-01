// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

// Map-coloring metrics backed by a per-sample analyzer array (analyzer.phasic[i],
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
  arousalIndex: 'arousalIndex'
};

class GSRMapManager {
  constructor(mapContainerId) {
    this.containerId = mapContainerId;
    this.map = null;
    this.pathSegments = [];
    this.peakMarkers = [];
    this.hotspotMarkers = [];
    this.collectivePathSegments = [];
    this.collectivePeakMarkers = [];
    this.collectiveHotspotMarkers = [];
    this.contourLayers = [];
    this.osmLayers = [];
    this.scrubMarker = null;
    this.showPeaks = true;
    this.showHotspots = true;
    this.showLabels = true;
    this.showClusters = true;
    this.showIsolines = true;
    this.showSurface = true;
    this.showTracks = true;
    this.showRFFluid = true;
    this.hasRfData = false;
    this.clusterLayers = [];
    this.activeColoringMetric = 'gsr';
    this._legendControl = null;
    this._legendMinVal = 0;
    this._legendMaxVal = 0;
    this._legendUniqueVals = null;

    // ── Render caches ──────────────────────────────────────────────────
    // GPS filter cache: trackId -> { paramsHash, snapFingerprint, gpsPoints, drawPoints }
    this._gpsCache = new Map();

    // Remember what the viewport was last auto-fit to, so renderData/renderCollectiveData
    // can tell "a genuinely new track/track-set just became active" (re-fit is wanted) apart
    // from "the same track is being redrawn because a filter slider moved" (re-fit would yank
    // the user back out to full-extent zoom on every tweak — see _fitBounds callers below).
    this._lastFitBoundsTrackId = null;
    this._lastFitBoundsTrackSet = null;

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

    // Leaflet's default attribution prefix includes a 🇺🇦 flag alongside the
    // "Leaflet" credit link (added in v1.8.0). Keep the credit link, drop the
    // flag — same text Leaflet itself renders by default, minus the emoji.
    if (this.map.attributionControl) {
      this.map.attributionControl.setPrefix(
        '<a href="https://leafletjs.com" title="A JS library for interactive maps">Leaflet</a>'
      );
    }

    // Initialise scrubbing indicator marker (pulsing blue circle)
    const scrubIcon = L.divIcon({
      className: 'scrub-marker-icon',
      html: '<div class="scrub-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    this.scrubMarker = L.marker([0, 0], { icon: scrubIcon });

    // Initialise static RF Fluid background renderer layer
    if (typeof RFFluidRenderer !== 'undefined') {
      this.rfFluidRenderer = new RFFluidRenderer(this.map, { visible: true });
    }
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
      'gsr':              'GSR Arousal (Raw)',
      'phasic':           'Phasic (SCR)',
      'tonic':            'Tonic Baseline (SCL)',
      'peakDensity':      'Peak Density (NS-SCR)',
      'phasicAUC':        'Phasic AUC (ISCR)',
      'arousalIndex':     'Combined Arousal Index',
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
    let html = '';

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
      html = `<div class="legend-title">${title}</div><div class="legend-swatches">`;
      let count = 0;
      for (const [name, color] of Object.entries(allRoadLabels)) {
        if (this._legendUniqueVals && !this._legendUniqueVals.has(name)) continue;
        html += `<div class="legend-swatch-row"><span class="legend-swatch" style="background:${color}"></span>${name}</div>`;
        count++;
      }
      if (count === 0) html += '<div class="legend-swatch-row" style="color:#999">No data</div>';
      html += '</div>';
    } else if (metric === 'inPark') {
      const hasYes = this._legendUniqueVals && this._legendUniqueVals.has(1);
      const hasNo  = this._legendUniqueVals && this._legendUniqueVals.has(0);
      html = `<div class="legend-title">${title}</div><div class="legend-swatches">`;
      if (hasYes) html += '<div class="legend-swatch-row"><span class="legend-swatch" style="background:#00e575"></span>Yes</div>';
      if (hasNo)  html += '<div class="legend-swatch-row"><span class="legend-swatch" style="background:#666666"></span>No</div>';
      if (!hasYes && !hasNo) html += '<div class="legend-swatch-row" style="color:#999">No data</div>';
      html += '</div>';
    } else {
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

      html = `
        <div class="legend-title">${title}</div>
        <div class="legend-scale">
          <div class="legend-gradient" style="background:${gradient}"></div>
          <div class="legend-labels"><span>${leftLabel}</span><span>${rightLabel}</span></div>
        </div>`;
    }

    // Append RF Fluid Legend if active and active track has RF data:
    if (this.showRFFluid && this.rfFluidRenderer && this.hasRfData) {
      const rfMode = this.rfFluidRenderer.options.mode;
      let rfHtml = '';
      if (rfMode === 'triband') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (Tri-Band)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#ff0000; border-radius:3px;"></span>
              815 MHz (LTE)
            </div>
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#00ff00; border-radius:3px;"></span>
              868 MHz (Grid)
            </div>
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#0000ff; border-radius:3px;"></span>
              915 MHz (ISM)
            </div>
          </div>`;
      } else if (rfMode === '815') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (815 MHz)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#ff0000; border-radius:3px;"></span>
              815 MHz Active
            </div>
          </div>`;
      } else if (rfMode === '868') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (868 MHz)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#00ff00; border-radius:3px;"></span>
              868 MHz Active
            </div>
          </div>`;
      } else if (rfMode === '915') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">RF Fluid (915 MHz)</div>
          <div class="legend-swatches">
            <div class="legend-swatch-row">
              <span class="legend-swatch" style="background:#0000ff; border-radius:3px;"></span>
              915 MHz Active
            </div>
          </div>`;
      } else if (rfMode === 'fog') {
        rfHtml = `
          <hr style="margin: 8px 0; border: 0; border-top: 1px dashed #ccc;" />
          <div class="legend-title" style="margin-bottom: 6px;">EM Fog Intensity</div>
          <div class="legend-scale">
            <div class="legend-gradient" style="background: linear-gradient(90deg, #0000ff, #ff0000);"></div>
            <div class="legend-labels"><span>Low</span><span>High</span></div>
          </div>`;
      }
      html += rfHtml;
    }

    el.innerHTML = html;
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
    this.hotspotMarkers = this._clearLayerGroup(this.hotspotMarkers);
    this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    this.clearOsmShapes();

    if (this.map.hasLayer(this.scrubMarker)) {
      this.map.removeLayer(this.scrubMarker);
    }

    // Reset legend
    this._legendMinVal = 0;
    this._legendMaxVal = 0;
    this._legendUniqueVals = null;
    this.hasRfData = false;
    this.updateLegend();
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
    const fa = (first && typeof first.alpha === 'number') ? first.alpha.toFixed(3) : '?';
    const ma = (mid   && typeof mid.alpha === 'number')   ? mid.alpha.toFixed(3)   : '?';
    const la = (last  && typeof last.alpha === 'number')  ? last.alpha.toFixed(3)  : '?';
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

    gpsPoints = GpsPipeline.applyHdopGate(gpsPoints, p.maxHdop || 2.0);
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
          origIdx: i
        });
      }
    }

    drawPoints = GpsPipeline.downsampleForDisplay(drawPoints, analyzer.sampleRate || 10.0, p.downsample === true || p.downsample === 1);
    drawPoints = GpsFilter.applyRDP(drawPoints, p.rdpTolerance || 0);

    this._gpsCache.set(cacheKey, { paramsHash, snapFingerprint: snapFp, gpsPoints, drawPoints });
    return { gpsPoints, drawPoints };
  }

  /**
   * Render color-coded path segments and add stress peak markers.
   *
   * @param {GSRAnalyzer} analyzer
   * @param {object} [gpsParams] – GPS filter settings
   * @param {object} [options] – { fitBounds: bool } force the auto-zoom-to-extent regardless
   *   of the new-track heuristic below. Not currently passed by any caller (the "Zoom to
   *   Extent" button calls fitToTrack() directly instead) — kept as an escape hatch for a
   *   future caller that needs to force a re-fit without faking a track-id change.
   */
  renderData(analyzer, gpsParams, options) {
    if (!gpsParams) gpsParams = {};
    options = options || {};
    this.clearMap();

    const p = gpsParams;
    const data = analyzer.raw;
    if (!data || data.length === 0) return;

    // Use cached GPS pipeline result (cache keyed by active track id)
    const cacheKey = AppState.activeTrackId || 'single';
    const { drawPoints } = this._getOrBuildDrawPoints(cacheKey, analyzer, p);
    if (drawPoints.length === 0) return;

    // Only auto-fit the viewport when a different track just became active (or the caller
    // explicitly asks for it) — not on every re-render, otherwise nudging a GSR/GPS filter
    // slider yanks the map back out to full-extent zoom and you lose whatever detail view
    // you'd zoomed into to actually see the slider's effect.
    const isNewTrack = cacheKey !== this._lastFitBoundsTrackId;
    if (options.fitBounds || isNewTrack) {
      this._fitBounds(drawPoints);
      this._lastFitBoundsTrackId = cacheKey;
    }
    this._lastDrawPoints = drawPoints;
    const hasRf = !!(analyzer && analyzer.hasRfData);
    this.hasRfData = hasRf;
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setData(drawPoints, analyzer.osmGeoms);
    }
    const btnToggleRFFluid = document.getElementById('btnToggleRFFluid');
    const rfFluidMode = document.getElementById('rfFluidMode');
    if (btnToggleRFFluid) {
      if (!hasRf) {
        btnToggleRFFluid.classList.remove('active');
        btnToggleRFFluid.setAttribute('disabled', 'disabled');
        btnToggleRFFluid.title = "No radio frequency data in active track";
      } else {
        btnToggleRFFluid.removeAttribute('disabled');
        btnToggleRFFluid.title = "Toggle static ray-casted 3-frequency RF fluid background";
      }
    }
    if (rfFluidMode) {
      if (!hasRf) {
        rfFluidMode.setAttribute('disabled', 'disabled');
      } else {
        rfFluidMode.removeAttribute('disabled');
      }
    }
    this._renderPathSegments(drawPoints, p.trackWeight || 5, analyzer);

    // Peak markers (with latency compensation)
    this._renderPeakMarkers(analyzer, data, p.peakLatency || 0);

    // Hotspot markers — the small top-2%-by-amplitude "memorable event" subset,
    // rendered as a separate, visually distinct layer (see _renderHotspotMarkers).
    this._renderHotspotMarkers(analyzer, p.peakLatency || 0);

    // Apply the active peak/label/hotspot toggle styles
    this.updateMarkerVisibility();
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
      // Note: phasic/tonic/peakDensity/phasicAUC/arousalIndex are NOT looked
      // up via this key — see DERIVED_METRIC_SERIES in _renderPathSegments.
      // They live in per-sample analyzer arrays (analyzer.phasic[i], etc.),
      // not on the drawPoint objects themselves, and drawPoints are cached
      // across GSR re-analyses (keyed only on GPS params), so baking them in
      // here would go stale the moment a GSR slider changes without a GPS
      // param also changing.
    };
    return keys[metric] || 'val';
  }



  /**
   * Draw OSM vector geometry overlays (parks, water, buildings) on the map.
   * Accepts pre-built geoms (from analyzer.osmGeoms) to avoid redundant
   * geometry reconstruction.
   */
  drawOsmShapes(geoms) {
    this.clearOsmShapes();
    if (!geoms || !geoms.ways || !this.map) return;
    
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setData(this._lastDrawPoints || [], geoms);
    }

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

  _renderPathSegments(drawPoints, trackWeight, analyzer) {
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

    // ── Single pass over drawPoints (already downsampled) for min/max ──
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
        const startVal = getVal(seg[batchStart]);

        let startBucket = 0;
        if (!isCategorical) {
          const avgVal = (getVal(seg[batchStart]) + getVal(seg[batchStart + 1])) / 2;
          startBucket = (avgVal - minVal) * (COLOR_BUCKETS / range);
          startBucket = startBucket < 0 ? 0 : (startBucket >= COLOR_BUCKETS ? COLOR_BUCKETS - 1 : startBucket | 0);
        }

        let batchEnd = batchStart + 1;
        while (batchEnd < seg.length - 1) {
          if (isCategorical) {
            if (getVal(seg[batchEnd]) !== startVal) break;
          } else {
            const val = (getVal(seg[batchEnd]) + getVal(seg[batchEnd + 1])) / 2;
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
          const midBucket = ((getVal(seg[midIdx]) + getVal(seg[midIdx + 1])) / 2 - minVal) * (COLOR_BUCKETS / range);
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
    const input = L.DomUtil.create('textarea', 'popup-label-input peak-popup-label-input', tdLabel2);
    input.rows = 1;
    input.value = displayLabel;
    input.placeholder = 'Enter label…';

    // Auto-size on render
    setTimeout(() => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }, 0);

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
    L.DomEvent.on(input, 'input', () => {
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
      GSRUI.handleLiveLabelInput(index, input.value, trackId);
    });
    L.DomEvent.on(input, 'change', () => GSRUI.updatePeakLabel(index, input.value, trackId));
    L.DomEvent.on(input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        GSRUI.updatePeakLabel(index, input.value, trackId);
        input.blur();
      }
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
      const si = this._resolveLatencyIndex(analyzer, peak, peakLatency);
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

    // Compact dot-only icon for peaks without labels. Minor styling to match
    // the graph's resting-state peak dots: small, no pulse animation — the
    // full peak census can run into the hundreds/thousands, so a subdued
    // marker keeps hotspots (see _renderHotspotMarkers) as the visually
    // dominant layer, mirroring the graph's peaks-vs-hotspots hierarchy.
    const simpleIcon = GSRMapManager._buildPeakIcon();

    allPeaks.forEach(({ peak, index, coords, px, py }) => {
      const displayLabel = peak.label || '';

      let marker;
      const hasLabel = displayLabel && displayLabel.trim();
      if (hasLabel) {
        const dirResult = labelPositions.get(index);
        if (dirResult) {
          marker = L.marker([coords.lat, coords.lon], {
            icon: GSRLabelManager.buildLabelledIcon(px, py, displayLabel, dirResult, { showGlow: false, dotPx: 6 })
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

      marker.on('click', () => {
        GSRUI.focusOnPeak(index, 'map');
      });

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

      // Mean peak amplitude across this track's active peaks — the reference point that
      // "severe" and "mild" are measured against, so blob size/color reflect intensity
      // rather than every cluster looking identical regardless of how bad it was.
      const refAmplitude = this._meanAmplitude(ptsForClustering);

      // Group peaks within selected proximity limit and boundary constraints
      const clusters = GSRSpatialClustering.clusterPeaks(ptsForClustering, effectiveProximity, boundaryRadius, sigma);

      clusters.forEach(cluster => {
        const paths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, boundaryRadius, refAmplitude);
        const style = this._severityStyleForCluster(cluster, refAmplitude);
        paths.forEach(path => {
          const latlngs = path.map(p => [p.lat, p.lon]);
          const poly = L.polygon(latlngs, {
            color: style.color,
            weight: style.weight,
            fillColor: style.color,
            fillOpacity: style.fillOpacity,
            dashArray: '4, 6',
            lineCap: 'round',
            lineJoin: 'round'
          });
          poly.bindTooltip(style.tooltip, { sticky: true, className: 'contour-tooltip-label' });
          if (this.showClusters) poly.addTo(this.map);
          this.clusterLayers.push(poly);
        });
      });
    }
  }

  /**
   * Build the shared Leaflet divIcon used for every hotspot marker on the
   * map — single-track (_renderHotspotMarkers) and collective/multi-track
   * (renderCollectiveData) both call this, so the two views can never drift
   * apart visually. Includes the expanding pulse-glow ring (.hotspot-glow-ring,
   * styles.css) that peak markers originally had — peaks themselves stay
   * static now (see drawPeakMarkers()'s doc comment in renderer.js for why),
   * but restoring it here for the much smaller, curated hotspot set is exactly
   * the "draw the eye to what matters" role that animation used to serve.
   * @private
   */
  static _buildHotspotIcon() {
    return L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:28px;height:28px;">' +
        '<div class="hotspot-glow-ring" style="position:absolute;top:0;left:0;"></div>' +
        '<div class="hotspot-dot" style="position:absolute;top:8px;left:8px;width:12px;height:12px;"></div>' +
        '</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
  }

  /**
   * Build the shared Leaflet divIcon used for every unlabeled, non-hotspot
   * peak marker — single-track (_renderPeakMarkers) and collective/multi-track
   * (renderCollectiveData) both call this, so a peak looks identical on both
   * views: small, quality-neutral --color-peak red dot, no track color, no
   * animation. Track color used to distinguish which track a collective-view
   * peak belonged to; that's dropped here in favor of matching the
   * single-track view exactly, per an explicit request to make the two
   * consistent — clicking a marker (its popup shows the track name) is now
   * how you tell tracks apart in collective view, not dot color.
   * @private
   */
  static _buildPeakIcon() {
    return L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:24px;height:24px;"><div class="peak-dot" style="position:absolute;top:9px;left:9px;width:6px;height:6px;"></div></div>',
      iconSize: [24, 24], iconAnchor: [12, 12]
    });
  }

  /**
   * Render the "hotspot" (memorable-event) marker layer on the map — the small,
   * amplitude-selected subset of peaks in analyzer.memorableEvents (see
   * analyzer.js's analyze() "Memorable-event view" section and the graph-panel
   * equivalent, GSRRenderer.drawHotspotMarkers()).
   *
   * Deliberately simpler than _renderPeakMarkers: no text labels, no spatial
   * clustering, no latency connector lines — just a distinct hotspot-red dot
   * per hotspot, click-to-focus, and the same popup used for regular peak
   * markers (since a hotspot IS a peak — analyzer.peaks.indexOf(peak) recovers
   * its real index for label-editing/exclusion/focus wiring).
   * @private
   */
  _renderHotspotMarkers(analyzer, peakLatency) {
    const events = analyzer.memorableEvents;
    if (!events || events.length === 0) return;

    const hotspotIcon = GSRMapManager._buildHotspotIcon();

    events.forEach(peak => {
      const index = analyzer.peaks.indexOf(peak);
      if (index < 0) return;

      const coords = this._hotspotMarkerCoords(analyzer, peak, peakLatency);
      if (!coords) return;

      const marker = L.marker([coords.lat, coords.lon], { icon: hotspotIcon });
      marker.setZIndexOffset(1500); // Above both regular peak dots and labels
      if (this.showHotspots) marker.addTo(this.map);

      marker.bindPopup(() => this._buildSinglePeakPopup(analyzer, peak, index, coords, marker));
      marker.on('click', () => {
        GSRUI.focusOnPeak(index, 'map');
      });

      this.hotspotMarkers.push(marker);
    });
  }

  /**
   * Collective/multi-track counterpart to _renderHotspotMarkers() — same
   * shared icon (GSRMapManager._buildHotspotIcon()) and position math
   * (_hotspotMarkerCoords()), so the two views can't visually drift apart.
   * Popup/interaction wiring follows the existing collective peak-marker
   * convention instead of the single-track one: bindPopup only, no
   * click-to-focus — collective view has no single "active track" for a
   * focus action to target (see the regular per-track peak markers built
   * just above this method's call site in renderCollectiveData()).
   * @private
   */
  _renderCollectiveTrackHotspots(track, peakLatency) {
    const analyzer = track.analyzer;
    const events = analyzer.memorableEvents;
    if (!events || events.length === 0) return;

    const hotspotIcon = GSRMapManager._buildHotspotIcon();

    events.forEach(peak => {
      const index = analyzer.peaks.indexOf(peak);
      if (index < 0) return;

      const coords = this._hotspotMarkerCoords(analyzer, peak, peakLatency);
      if (!coords) return;

      const marker = L.marker([coords.lat, coords.lon], { icon: hotspotIcon });
      marker.setZIndexOffset(1500);
      if (this.showHotspots) marker.addTo(this.map);

      marker.bindPopup(() => this._buildCollectivePeakPopup(track, peak, index, coords.lat, coords.lon, marker));

      this.collectiveHotspotMarkers.push(marker);
    });
  }

  /**
   * Resolve the raw-sample index a marker should be positioned at, applying
   * the optional GPS-latency shift (find the GPS fix at peak.time -
   * peakLatency instead of peak.time itself, falling back to peak.index if
   * nothing is found there). Shared by _renderPeakMarkers(),
   * _renderHotspotMarkers(), and _renderCollectiveTrackHotspots() — all
   * three used to each carry their own copy of this exact logic.
   * @private
   */
  _resolveLatencyIndex(analyzer, peak, peakLatency) {
    if (!(peakLatency > 0)) return peak.index;
    const shiftedTime = Math.max(0, peak.time - peakLatency);
    const si = analyzer.findClosestIndex(shiftedTime);
    return si >= 0 ? si : peak.index;
  }

  /**
   * Resolve the {lat, lon} position for a hotspot marker. Shared by both
   * _renderHotspotMarkers() and _renderCollectiveTrackHotspots().
   * @private
   */
  _hotspotMarkerCoords(analyzer, peak, peakLatency) {
    return analyzer.getCoordinates(this._resolveLatencyIndex(analyzer, peak, peakLatency));
  }

  /**
   * Mean amplitude across a set of {amplitude} peak objects. Used as the reference point
   * for relative-severity scaling of cluster geometry and styling.
   * @private
   */
  _meanAmplitude(pts) {
    if (!pts || pts.length === 0) return 0;
    let sum = 0;
    for (const p of pts) sum += (p.amplitude || 0);
    return sum / pts.length;
  }

  /**
   * Derive a visual style for a cluster blob based on how severe its peaks are relative to
   * the dataset's typical (mean) peak amplitude. Mild clusters render as small, faint amber
   * outlines; severe clusters render as bold, saturated deep-red outlines — so a glance at
   * the map distinguishes "notable" from "genuinely alarming" instead of every cluster
   * looking the same regardless of intensity.
   * @private
   */
  _severityStyleForCluster(cluster, refAmplitude) {
    const amps = cluster.map(p => p.amplitude || 0);
    const maxAmp = amps.length ? Math.max(...amps) : 0;
    let relMax = null;
    let ratio = 0.5; // fallback mid-intensity styling if no reference amplitude available
    if (refAmplitude > 0) {
      relMax = maxAmp / refAmplitude;
      // Map relative severity (~0.3x-3x the dataset average peak) onto a 0..1 visual band.
      ratio = Math.max(0, Math.min(1, (relMax - 0.3) / (3 - 0.3)));
    }

    const hue = 40 - ratio * 40;     // 40° amber  -> 0° red
    const sat = 75 + ratio * 20;     // 75%        -> 95%
    const light = 58 - ratio * 15;   // 58% (pale) -> 43% (deep)
    const color = `hsl(${hue}, ${sat}%, ${light}%)`;
    const fillOpacity = 0.08 + ratio * 0.42;
    const weight = 1.5 + ratio * 2.5;
    const peakWord = cluster.length === 1 ? 'peak' : 'peaks';
    const severityLabel = relMax === null ? '' : ` · ${relMax.toFixed(2)}x avg severity`;
    const tooltip = `${cluster.length} ${peakWord}${severityLabel}`;

    return { color, fillOpacity, weight, tooltip, ratio };
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
      effectiveProximity: proximity
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
   * Toggle the visibility of the hotspot (memorable-event) markers on the map layer.
   */
  toggleHotspots(visible) {
    this.showHotspots = visible;
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

      if (this.showHotspots) {
        mapEl.classList.remove('hide-map-hotspots');
      } else {
        mapEl.classList.add('hide-map-hotspots');
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

    const allHotspotMarkers = [...this.hotspotMarkers, ...this.collectiveHotspotMarkers];
    allHotspotMarkers.forEach(m => {
      if (this.showHotspots) {
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
   * Toggle the visibility of the collective topographic isoline (contour line) layer.
   */
  toggleIsolines(visible) {
    this.showIsolines = visible;
    const toggle = (m) => {
      if (visible) {
        if (!this.map.hasLayer(m)) m.addTo(this.map);
      } else {
        if (this.map.hasLayer(m)) this.map.removeLayer(m);
      }
    };
    this.contourLayers.forEach(toggle);
  }

  /**
   * Toggle the visibility of the collective shaded surface overlay.
   */
  toggleSurface(visible) {
    this.showSurface = visible;
    if (!this.surfaceOverlay) return;
    if (visible) {
      if (!this.map.hasLayer(this.surfaceOverlay)) this.surfaceOverlay.addTo(this.map);
    } else {
      if (this.map.hasLayer(this.surfaceOverlay)) this.map.removeLayer(this.surfaceOverlay);
    }
  }

  /**
   * Toggle the visibility of the individual track polylines drawn in collective mode.
   */
  toggleTracks(visible) {
    this.showTracks = visible;
    const toggle = (m) => {
      if (visible) {
        if (!this.map.hasLayer(m)) m.addTo(this.map);
      } else {
        if (this.map.hasLayer(m)) this.map.removeLayer(m);
      }
    };
    this.collectivePathSegments.forEach(toggle);
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
    this.collectiveHotspotMarkers = this._clearLayerGroup(this.collectiveHotspotMarkers);
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
    if (activeTracks.length === 0) {
      // Force a re-fit next time any track becomes active again — otherwise if the user
      // pans/zooms elsewhere while the collective view is empty, then reactivates the exact
      // same track set later, the stale signature below would wrongly look "unchanged" and
      // skip re-framing them.
      this._lastFitBoundsTrackSet = null;
      return;
    }

    // Signature of which tracks are active — used below to only auto-fit the viewport when
    // the active track set actually changed, not on every contour/cluster slider re-render.
    const trackSetSignature = activeTracks.map(t => t.id).sort().join(',');

    const allActivePeaksAcrossTracks = [];
    let collectiveDrawPoints = [];
    let collectiveWays = [], collectiveRelations = [];

    // 1. Draw dashed, semi-transparent paths for each track
    activeTracks.forEach(track => {
      const data = track.analyzer.raw;
      const p = track.gpsFilterParams || {};

      // Use cached GPS pipeline (cache keyed by track id)
      const { drawPoints } = this._getOrBuildDrawPoints(track.id, track.analyzer, p);
      if (drawPoints.length > 0) {
        collectiveDrawPoints.push(...drawPoints);
      }
      if (track.analyzer && track.analyzer.osmGeoms) {
        if (track.analyzer.osmGeoms.ways) collectiveWays.push(...track.analyzer.osmGeoms.ways);
        if (track.analyzer.osmGeoms.relations) collectiveRelations.push(...track.analyzer.osmGeoms.relations);
      }

      if (drawPoints.length < 2) return;

      const latlngs = drawPoints.map(pt => [pt.lat, pt.lon]);
      const trackColor = track.color || '#0ea5e9';

      const poly = L.polyline(latlngs, {
        color: trackColor,
        weight: 3,
        opacity: 0.35,
        dashArray: '5, 8'
      });
      if (this.showTracks) poly.addTo(this.map);

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
        const si = this._resolveLatencyIndex(track.analyzer, peak, peakLatency);
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

      // Compact dot-only icon for unlabeled peaks — same shared icon
      // single-track peaks use (GSRMapManager._buildPeakIcon()), not
      // track-colored, so a peak looks identical regardless of which view
      // it's shown in (see that method's doc comment for why track color
      // was dropped here).
      const collectiveSimpleIcon = GSRMapManager._buildPeakIcon();

      collectiveAllPeaks.forEach(({ peak, index, lat, lon, px, py }) => {
        const displayLabel = peak.label || '';

        let marker;
        const hasLabel = displayLabel && displayLabel.trim();
        if (hasLabel) {
          const dirResult = collectivePositions.get(index);
          if (dirResult) {
            marker = L.marker([lat, lon], {
              icon: GSRLabelManager.buildLabelledIcon(px, py, displayLabel, dirResult, { showGlow: false, dotPx: 6 })
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

      // Hotspot markers for this track — same shared icon/styling as the
      // single-track view (_renderHotspotMarkers), deliberately NOT
      // track-colored like the regular collective peak dots above: a
      // hotspot's whole point is to stand out as "one of the biggest events,
      // in any track," so it keeps the fixed hotspot-red across every track
      // rather than blending into that track's own color scheme.
      this._renderCollectiveTrackHotspots(track, peakLatency);
    });

    if (this.rfFluidRenderer && collectiveDrawPoints.length > 0) {
      const combinedGeoms = { ways: collectiveWays, relations: collectiveRelations };
      this.rfFluidRenderer.setData(collectiveDrawPoints, combinedGeoms);
    }

    // Render collective global clusters across all active tracks
    if (allActivePeaksAcrossTracks.length > 0 && typeof GSRSpatialClustering !== 'undefined') {
      // Retrieve dynamic clustering parameters from UI sliders
      const { boundaryRadius, sigma, effectiveProximity } = this._getClusteringParams();

      const refAmplitude = this._meanAmplitude(allActivePeaksAcrossTracks);
      const clusters = GSRSpatialClustering.clusterPeaks(allActivePeaksAcrossTracks, effectiveProximity, boundaryRadius, sigma);
      clusters.forEach(cluster => {
        const paths = GSRSpatialClustering.getConcaveBlob(cluster, sigma, boundaryRadius, refAmplitude);
        const style = this._severityStyleForCluster(cluster, refAmplitude);
        paths.forEach(path => {
          const latlngs = path.map(p => [p.lat, p.lon]);
          const poly = L.polygon(latlngs, {
            color: style.color,
            weight: style.weight,
            fillColor: style.color,
            fillOpacity: style.fillOpacity,
            dashArray: '4, 6',
            lineCap: 'round',
            lineJoin: 'round'
          });
          poly.bindTooltip(style.tooltip, { sticky: true, className: 'contour-tooltip-label' });
          if (this.showClusters) poly.addTo(this.map);
          this.clusterLayers.push(poly);
        });
      });
    }

    // 3. Zoom and Pan Map to fit collective bounding envelope — but only when the active
    // track set actually changed (tracks added/removed/toggled). Re-fitting on every contour
    // slider tweak would reset the zoom the user had picked to inspect a specific area.
    if (trackSetSignature !== this._lastFitBoundsTrackSet) {
      const bounds = collectiveManager.getBounds();
      if (bounds) {
        this.map.fitBounds([
          [bounds.minLat, bounds.minLon],
          [bounds.maxLat, bounds.maxLon]
        ], { padding: [40, 40] });
      }
      this._lastFitBoundsTrackSet = trackSetSignature;
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
    this.surfaceData = surfaceData;

    const { contours, grid, minVal, maxVal, bounds, sortedVals } = surfaceData;
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
      const useRankColor = sortedVals && sortedVals.length > 1;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const val = grid[r][c];
          if (val === null || isNaN(val)) {
            continue;
          }

          // Percentile-rank color ratio, consistent with the contour levels below: a cell's
          // color reflects where it sits in the surface's actual value distribution rather
          // than a linear min/max ratio, which gets swamped by the flat low-arousal majority
          // whenever a small number of cells spike far above the rest.
          let ratio;
          if (useRankColor) {
            ratio = StatsMath.percentileRank(val, sortedVals);
          } else {
            ratio = valRange > rangeEpsilon ? (val - minVal) / valRange : 0.5;
          }

          ctx.fillStyle = MapColors.getHslColor(ratio, 100, 50);

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
      });
      if (this.showSurface) this.surfaceOverlay.addTo(this.map);
    }

    // 2. Draw isoline curves. Marching Squares returns raw, unordered 2-point segments —
    // stitch them into continuous paths first (same stitching used for cluster blob
    // boundaries), then apply a light Chaikin smoothing pass so the grid-aligned corners
    // read as smooth curves rather than a jagged staircase. This also collapses what used
    // to be hundreds of separate thick, disconnected strokes per level into a handful of
    // thin, continuous lines.
    contours.forEach(c => {
      const color = MapColors.getHslColor(c.ratio, 100, 55);
      const formattedVal = c.level.toFixed(3);
      const topoUnits = { peaks: '', auc: ' μS·s', arousal_index: ' z' };
      const unit = topoUnits[contourParams.topographySource] !== undefined
        ? topoUnits[contourParams.topographySource]
        : ' μS';

      const stitchedPaths = (typeof GSRSpatialClustering !== 'undefined')
        ? GSRSpatialClustering.stitchSegments(c.segments)
        : c.segments.map(seg => [seg[0], seg[1]]);

      stitchedPaths.forEach(path => {
        if (!path || path.length < 2) return;

        const isClosed = path.length > 2 &&
          Math.abs(path[0].lat - path[path.length - 1].lat) < 1e-9 &&
          Math.abs(path[0].lon - path[path.length - 1].lon) < 1e-9;
        const smoothed = GeoUtils.chaikinSmooth(path, 3, isClosed);

        const poly = L.polyline(smoothed.map(p => [p.lat, p.lon]), {
          color: color,
          weight: 1.5,
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round',
          // Leaflet simplifies polyline vertices for rendering performance by default
          // (smoothFactor: 1.0). That simplification would strip out the extra points
          // Chaikin smoothing just added, undoing the smoothing. Disable it so every
          // smoothed vertex actually renders.
          smoothFactor: 0
        });

        poly.bindTooltip(`Level: ${formattedVal}${unit}`, {
          sticky: true,
          className: 'contour-tooltip-label'
        });

        if (this.showIsolines) poly.addTo(this.map);
        this.contourLayers.push(poly);
      });
    });
  }

  toggleRFFluid(show) {
    this.showRFFluid = (show !== undefined) ? show : !this.showRFFluid;
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setVisible(this.showRFFluid);
    }
    this.updateLegend();
    return this.showRFFluid;
  }

  setRFFluidMode(mode) {
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setMode(mode);
    }
    this.updateLegend();
  }

  setRFFluidOpacity(opacity) {
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setOpacity(opacity);
    }
  }

  setRFFluidRadius(radius) {
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setRadius(radius);
    }
  }
}

window.GSRMapManager = GSRMapManager;
