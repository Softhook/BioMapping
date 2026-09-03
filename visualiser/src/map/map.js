// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

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

class GSRMapManager {
  constructor(mapContainerId) {
    this.containerId = mapContainerId;
    this.map = null;
    this.contourLayers = [];
    this.osmLayers = [];
    // Phase 1 (slice 3): legacy fallback for layers rendered without a managed
    // track (bare analyzer direct-add path); rendered tracks own their layers
    // in track._ownedLayers instead.
    this._unownedLayers = [];
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

    // Phase 1 (slice 2): the set of track layerGroups THIS manager has rendered
    // (trackId -> track). Clearing iterates this set rather than re-reading
    // AppState.collectiveManager.tracks, so a track removed from the manager
    // can never leave an orphaned layerGroup behind (the collective-view drift
    // bug this slice fixes).
    this._renderedTrackGroups = new Map();

    // Remember what the viewport was last auto-fit to, so renderData/renderCollectiveData
    // can tell "a genuinely new track/track-set just became active" (re-fit is wanted) apart
    // from "the same track is being redrawn because a filter slider moved" (re-fit would yank
    // the user back out to full-extent zoom on every tweak — see _fitBounds callers below).
    this._lastFitBoundsTrackId = null;
    this._lastFitBoundsTrackSet = null;

    // Overlap-aware path colour (see _overlapPooledAccessor). _refreshPathOnZoom
    // uses these to skip the path rebuild on a zoom that can't change the
    // overlap outcome: whether the last path can retrace itself at all, its
    // pooled-outcome fingerprint, and the inputs needed to recompute that
    // fingerprint cheaply at a new zoom.
    this._pathHasRetrace = false;
    this._lastPathZoom = null;
    this._lastPathOverlapSig = 0;
    this._lastPathTrackWeight = 5;
    this._lastPathGetVal = null;
    this._lastPathIsCategorical = false;

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
      preferCanvas: true,
      zoomSnap: 0.25,
      zoomDelta: 0.25,
      maxZoom: 22
    }).setView([0, 0], 2);

    if (this.map.attributionControl) {
      this.map.attributionControl.setPrefix(false);
    }

    // Light Map Style (OpenStreetMap base, CartoDB Positron)
    // Kept as this.baseTileLayer (not just addTo(this.map) and discarded) so
    // GSRMapExporter can force it to prefetch tiles beyond the live viewport
    // before an SVG export — see exportToSvg's isoband-canvas-expansion
    // handling and map_exporter.js's _ensureTileCoverage doc comment.
    // CARTO now requires a (free) key on its raster basemaps; without one the
    // tiles still load but carry an "API key required" watermark. Key comes
    // from config.local.js (window.BIOMAP_CONFIG) or localStorage — see
    // config.local.example.js. localStorage access can throw (file://, site
    // data disabled), so guard it.
    let cartoKey = (window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.cartoApiKey) || '';
    if (!cartoKey) {
      try { cartoKey = localStorage.getItem('bioMappingCartoApiKey') || ''; } catch (e) { /* no-op */ }
    }
    const cartoUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' +
      (cartoKey ? '?key=' + encodeURIComponent(cartoKey) : '');
    this.baseTileLayer = L.tileLayer(cartoUrl, {
      maxZoom: 22,
      maxNativeZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      crossOrigin: true
    }).addTo(this.map);

    // Leaflet's default attribution prefix includes a 🇺🇦 flag alongside the
    // "Leaflet" credit link (added in v1.8.0). Keep the credit link, drop the
    // flag — same text Leaflet itself renders by default, minus the emoji.
    if (this.map.attributionControl) {
      this.map.attributionControl.setPrefix(false);
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

    // Overlap-aware path colour depends on the on-screen stroke width, which
    // changes with zoom — re-run the path renderer once the zoom settles (see
    // _refreshPathOnZoom, which cheap-outs when the outcome can't have changed).
    this.map.on('zoomend', () => this._refreshPathOnZoom());
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
   * Update the legend to reflect the current colouring metric and data range.
   */
  updateLegend() {
    if (!this._legendControl) return;
    const el = this._legendControl.getContainer();
    if (!el) return;
    el.innerHTML = this.buildLegendHtml();
  }

  /**
   * Build the legend's inner HTML for the current colouring metric / data range /
   * view mode. Split out of updateLegend() so the 3D globe can render the exact
   * same legend (see globe3d_view.js _updateLegend).
   * @returns {string}
   */
  buildLegendHtml() {
    const isCollective = (typeof AppState !== 'undefined' && AppState.viewMode === 'collective');
    let html = '';

    if (isCollective) {
      const topoSource = this._collectiveTopographySource || 'phasic';
      const topoCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.TOPOGRAPHY_SOURCES && GSR_CONST.TOPOGRAPHY_SOURCES[topoSource]) || null;
      const title = (topoCfg && topoCfg.label) || 'Topography';
      const unit = (topoCfg && topoCfg.unit !== undefined) ? topoCfg.unit : ' μS';

      const minV = this._legendMinVal;
      const maxV = this._legendMaxVal;

      const gradient = 'linear-gradient(90deg, hsl(120,90%,50%), hsl(60,90%,50%), hsl(0,90%,50%))';

      const fmt = (v) => {
        if (v >= 100) return v.toFixed(0);
        if (v >= 1) return v.toFixed(1);
        return v.toFixed(3);
      };

      const leftLabel  = fmt(minV) + unit;
      const rightLabel = fmt(maxV) + unit;

      html = `
        <div class="legend-title">${title}</div>
        <div class="legend-scale">
          <div class="legend-gradient" style="background:${gradient}"></div>
          <div class="legend-labels"><span>${leftLabel}</span><span>${rightLabel}</span></div>
        </div>`;
    } else {
      const metric = this.activeColoringMetric || 'gsr';

      // OSM entries (roadClass..amenityCount) come from the shared
      // GSR_CONST.OSM_METRICS table (constants.js) — single source of truth
      // for the key<->field<->label mapping, also used by _getMetricKey()
      // below and ui.js's correlation dashboard.
      const metricNames = {
        'gsr':              'GSR Arousal (Raw)',
        'phasic':           'Phasic (SCR)',
        'tonic':            'Tonic Baseline (SCL)',
        'peakDensity':      'Peak Density (NS-SCR)',
        'phasicAUC':        'Phasic AUC (ISCR)',
        'arousalIndex':     'Combined Arousal Index',
        'triIndex':         'Tri Index',
        'em_fog':           'EM Fog Index (0-100)',
        'emFog':            'EM Fog Index (0-100)',
        'hdopQuality':      'GPS Accuracy (HDOP)'
      };
      GSR_CONST.OSM_METRICS.forEach(m => { metricNames[m.key] = m.label; });

      const title = metricNames[metric] || metric;

      if (metric === 'roadClass') {
        const allRoadLabels = MapColors.ROAD_COLORS;
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
          case 'em_fog':
          case 'emFog':
            gradient = 'linear-gradient(90deg, hsl(220,90%,55%), hsl(300,90%,55%))';
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

    return html;
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
   * Clear the RF fluid canvas — shared by clearMap() and clearCollectiveLayers()
   * so the two "which layers am I clearing" branches can't drift apart and
   * leave one of them holding stale RF data (see clearAll()).
   *
   * Uses clear() rather than setData([], null): clearMap()/clearCollectiveLayers()
   * run at the START of every render pass (renderData()/renderCollectiveData()),
   * which then immediately calls setData()/setDataForTracks() again with the real
   * per-track data a few lines later in the same synchronous pass. setData([], null)
   * would prune RFFluidRenderer's per-track fan-cast cache (Phase 5) via that empty
   * call's own active-track-set bookkeeping, forcing every track to recompute right
   * after — defeating the cache on every single re-render. clear() only blanks the
   * visible canvas; the fan cache survives until the real setData call right after.
   */
  _clearRfFluid() {
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.clear();
    }
  }

  /**
   * Phase 1 (slice 1): return (creating it if needed) the track's single
   * render handle — an L.layerGroup() added to the map that owns all of this
   * track's path/peak/hotspot layers. Null tracks (a bare analyzer rendered
   * outside the track manager) fall back to the legacy direct-to-map path.
   * @private
   */
  _getTrackLayerGroup(track) {
    if (!track) return null;
    // Phase 1 (slice 3): each track also owns the full registry of its render
    // layers (visible + hidden) so toggles can restore hidden ones; the group
    // itself only holds the currently-visible layers.
    if (!track._ownedLayers) track._ownedLayers = [];
    if (!track.layerGroup) {
      track.layerGroup = L.layerGroup().addTo(this.map);
    }
    // Remember what we rendered so clearMap can remove it even if the track is
    // no longer in the collective manager (see clearMap).
    this._renderedTrackGroups.set(track.id, track);
    return track.layerGroup;
  }

  /**
   * Phase 1 (slice 2): forget a track's rendered group without touching the
   * map (used by deleteTrack after it has already removed the group).
   * @private
   */
  _forgetTrackGroup(trackId) {
    this._renderedTrackGroups.delete(trackId);
  }

  /**
   * Phase 1 (slice 3): the currently-rendered per-track layers, derived from
   * the track layerGroups this manager owns (the old flat arrays were
   * removed). The SVG exporter and fitToTrack rely on this.
   * @returns {{ paths: Array, peakMarkers: Array, hotspots: Array }}
   */
  getRenderLayers() {
    const paths = [];
    const peakMarkers = [];
    const hotspots = [];
    const classify = (l) => {
      const kind = l._gsrKind;
      if (kind === 'path' || kind === 'collectivePath') {
        paths.push(l);
      } else if (kind === 'peak' || kind === 'connector' || kind === 'collectivePeak' || kind === 'collectiveConnector') {
        peakMarkers.push(l);
      } else if (kind === 'hotspot') {
        hotspots.push(l);
      }
    };
    for (const track of this._renderedTrackGroups.values()) {
      if (!track || !track.layerGroup) continue;
      for (const l of track.layerGroup.getLayers()) classify(l);
    }
    for (const l of this._unownedLayers) classify(l);
    return { paths, peakMarkers, hotspots };
  }

  /**
   * Phase 1 (slice 3): resolve the rendered marker for a peak index (used by
   * focusOnPeak). Searches the track layerGroups; returns null when the peak's
   * marker isn't currently rendered (e.g. hidden or no group).
   */
  getPeakMarkerByIndex(idx) {
    for (const l of this._allTrackLayers()) {
      if ((l._gsrKind === 'peak' || l._gsrKind === 'collectivePeak') && l._gsrPeakIndex === idx) {
        return l;
      }
    }
    return null;
  }

  /**
   * Phase 1 (slice 3): record a layer as owned by a track (or, in the legacy
   * no-track fallback, by this manager) so visibility toggles can find ALL
   * created layers — the layerGroup only holds the currently-visible ones.
   * @private
   */
  _registerTrackLayer(track, layer) {
    if (track && track._ownedLayers) track._ownedLayers.push(layer);
    else this._unownedLayers.push(layer);
  }

  /**
   * Phase 1 (slice 3): every per-track render layer this manager has created
   * (visible or hidden), across all rendered tracks + the legacy fallback.
   * @private
   */
  _allTrackLayers() {
    const layers = [];
    for (const track of this._renderedTrackGroups.values()) {
      if (track && track._ownedLayers) layers.push(...track._ownedLayers);
    }
    if (this._unownedLayers) layers.push(...this._unownedLayers);
    return layers;
  }

  /**
   * Phase 1 (slice 2/3): remove every per-track layerGroup this manager has
   * rendered from the map and null the track handle. Shared by clearMap and
   * clearCollectiveLayers so a group can't linger when either clear path runs.
   * @private
   */
  _clearRenderedTrackGroups() {
    if (!this.map) return;
    for (const track of this._renderedTrackGroups.values()) {
      if (track && track.layerGroup) {
        if (this.map.hasLayer(track.layerGroup)) this.map.removeLayer(track.layerGroup);
        track.layerGroup = null;
      }
      if (track) track._ownedLayers = [];
    }
    this._renderedTrackGroups.clear();
    // Legacy no-track fallback layers were added straight to the map
    // (never into a group) — removeLayer() each one before dropping the
    // array, or they're stranded on the map forever with no reference left
    // to find or clear them by (see _registerTrackLayer/getRenderLayers).
    for (const layer of this._unownedLayers) {
      if (this.map.hasLayer(layer)) this.map.removeLayer(layer);
    }
    this._unownedLayers = [];
  }

  /**
   * Reset path and markers on map
   */
  clearMap() {
    if (!this.map) return;

    // Phase 1 (slice 2): clear exactly what THIS manager rendered. Iterating
    // _renderedTrackGroups — rather than re-reading AppState.collectiveManager
    // .tracks — means a track removed from the manager can't leave an orphaned
    // layerGroup behind (the collective-view drift bug this slice fixes).
    // Removal = map.removeLayer(track.layerGroup), one call.
    this._clearRenderedTrackGroups();

    // Aggregates (spatial clusters, OSM shapes) + RF fluid + legend are
    // map-level, owned by GSRMapManager rather than any single track.
    this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    this.clearOsmShapes();

    if (this.map.hasLayer(this.scrubMarker)) {
      this.map.removeLayer(this.scrubMarker);
    }

    this._clearRfFluid();

    // Reset legend
    this._legendMinVal = 0;
    this._legendMaxVal = 0;
    this._legendUniqueVals = null;
    this.hasRfData = false;
    this.updateLegend();
  }

  /**
   * Wipe every rendered map layer — single-track and collective, RF included.
   * The single entry point for "the map should show nothing" (no active track,
   * no active track set, whole library cleared) so callers never have to
   * remember which pair of clear*() methods to call together.
   */
  clearAll() {
    this.clearMap();
    this.clearCollectiveLayers();
  }

  // GPS pipeline processing (_hashGpsParams / _snapFingerprint /
  // _getOrBuildDrawPoints / _collectGpsPoints) is split out into
  // map_manager_process.js — a prototype augment loaded right after this file.

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

    // Phase 1 (slice 1): resolve the active track's layerGroup — its single
    // render handle. Path/peak/hotspot layers below are added INTO this group
    // (which is on the map), never directly onto the map. When there is no
    // managed track for this analyzer (e.g. cacheKey 'single' fallback), the
    // renderers fall back to the legacy direct-to-map path.
    const activeTrack = (typeof AppState !== 'undefined' && AppState.collectiveManager)
      ? AppState.collectiveManager.getTrack(AppState.activeTrackId)
      : null;
    const layerGroup = this._getTrackLayerGroup(activeTrack);

    // Use cached GPS pipeline result (cache keyed by active track id)
    const cacheKey = AppState.activeTrackId || 'single';
    const { drawPoints } = this._getOrBuildDrawPoints(cacheKey, analyzer, p);
    const hasPath = drawPoints.length > 0;

    // Only auto-fit the viewport when a different track just became active (or the caller
    // explicitly asks for it) — not on every re-render, otherwise nudging a GSR/GPS filter
    // slider yanks the map back out to full-extent zoom and you lose whatever detail view
    // you'd zoomed into to actually see the slider's effect.
    const isNewTrack = cacheKey !== this._lastFitBoundsTrackId;
    if (hasPath) {
      if (options.fitBounds || isNewTrack) {
        this._fitBounds(drawPoints, { animate: true, duration: 0.45 });
        this._lastFitBoundsTrackId = cacheKey;
        if (!this._lastFitBoundsTrackSet && typeof AppState !== 'undefined' && AppState.collectiveManager) {
          this._lastFitBoundsTrackSet = this._getTrackSetSignature(AppState.collectiveManager);
        }
      }
      this._lastDrawPoints = drawPoints;
      if (this.rfFluidRenderer) {
        this.rfFluidRenderer.setData(drawPoints, analyzer.osmGeoms);
      }
      this._updateRfFluidButtonState(!!(analyzer && analyzer.hasRfData));
      this._renderPathSegments(drawPoints, p.trackWeight || 5, analyzer, activeTrack);
    } else {
      // Every GPS fix was dropped by the quality gates (e.g. all HDOP values
      // exceed the gate), so there is no filtered path to draw. Peak/hotspot
      // markers resolve their own coordinates from the RAW data (independent of
      // the filter pipeline — see analyzer.getCoordinates), so they can still
      // be placed: never leave a blank map for a track that has detectable
      // peaks. (Beware regression risk: any earlier `drawPoints.length === 0`
      // early-return here silently hid every layer for such tracks.)
      this._lastDrawPoints = [];
      if (this.rfFluidRenderer) {
        this.rfFluidRenderer.setData([], null);
      }
      this._updateRfFluidButtonState(false);
    }

    // Peak markers (with latency compensation)
    this._renderPeakMarkers(analyzer, data, p.peakLatency || 0, activeTrack);

    // Hotspot markers — the small top-2%-by-amplitude "memorable event" subset,
    // rendered as a separate, visually distinct layer (see _renderHotspotMarkers).
    this._renderHotspotMarkers(analyzer, p.peakLatency || 0, activeTrack);

    // Apply the active peak/label/hotspot toggle styles
    this.updateMarkerVisibility();

    // When the path was fully gated out but peaks/hotspots rendered, fit the
    // view to them so the user can actually see the track's events (otherwise
    // the map would stay at whatever stale viewport it had).
    if (!hasPath && (options.fitBounds || isNewTrack)) {
      const peakLayers = this.getRenderLayers().peakMarkers;
      const coords = peakLayers
        .filter(m => m._latlng && !isNaN(m._latlng.lat) && !isNaN(m._latlng.lng))
        .map(m => [m._latlng.lat, m._latlng.lng]);
      if (coords.length > 0) {
        this._flyOrFitBounds(coords);
        this._lastFitBoundsTrackId = cacheKey;
      }
    }

    // Let the 3D globe (if mounted) pull the fresh drawPoints / metric / legend
    // range. See src/map/globe3d_view.js.
    if (typeof AppState !== 'undefined' && AppState.emit) AppState.emit('map:rendered');
  }

  /**
   * Remove every layer whose `_gsrKind` is in `kindSet` from the map and from
   * the track's layerGroup, and drop it from the track's `_ownedLayers`
   * registry (the surviving layers are kept). Shared by the refresh*()
   * partial-render methods below, which each strip one kind-family before
   * re-running a single renderer.
   */
  _stripOwnedLayersByKind(track, kindSet) {
    const keep = [];
    for (const layer of (track._ownedLayers || [])) {
      if (kindSet.has(layer._gsrKind)) {
        if (this.map.hasLayer(layer)) this.map.removeLayer(layer);
        if (track.layerGroup && track.layerGroup.hasLayer(layer)) {
          track.layerGroup.removeLayer(layer);
        }
      } else {
        keep.push(layer);
      }
    }
    track._ownedLayers = keep;
  }

  /**
   * Helper to strip track layers by kind set, run a render callback, and emit map:rendered.
   * Consolidates the partial-render pipeline for single-track and collective-track refreshes.
   * @private
   */
  _refreshTrackLayers(track, kindSet, renderFn, updateVisibility = false) {
    this._stripOwnedLayersByKind(track, kindSet);
    renderFn();
    if (updateVisibility) this.updateMarkerVisibility();
    if (typeof AppState !== 'undefined' && AppState.emit) AppState.emit('map:rendered');
  }

  /**
   * Re-render ONLY the active track's peak markers (+ connector lines +
   * spatial-cluster blobs) instead of the full renderData() path/peak/hotspot
   * rebuild. For changes that only affect peak data — e.g. a label edit,
   * which changes at most one on-map label chip plus label-collision layout
   * for the rest — renderData()'s full clearMap()+rebuild is disproportionate
   * cost (see docs/archive/visualizer_rendering_perf_routes.md §2.2): rebuilding
   * every path polyline segment and every hotspot marker for a text-only
   * change on tracks with hundreds/thousands of peaks.
   *
   * Falls back to the full renderData() when there's no resolvable managed
   * track (the legacy no-track fallback — see _getTrackLayerGroup's doc
   * comment): that path's layers aren't tagged per-track, so a scoped
   * removal isn't possible, and it's rare enough not to be worth a second
   * removal mechanism.
   *
   * Cluster blobs (`this.clusterLayers`) are a manager-wide array, not
   * track-scoped — _renderPeakMarkers() always appends to it without
   * clearing first (clearMap()/clearCollectiveLayers() own that job), so it
   * must be cleared here too or a second call would leave duplicate blobs on
   * the map. UNLESS options.skipClustering is set (see below), in which
   * case the existing cluster blobs are already correct and left untouched
   * — same reasoning as leaving path/hotspot layers alone.
   *
   * @param {object} [options] – { skipClustering: bool }. Pass true only
   *   when the caller's change is provably invisible to
   *   GSRSpatialClustering.clusterPeaks() (lat/lon/amplitude per non-excluded
   *   peak — see _renderPeakMarkers()'s own doc comment) — a label edit
   *   qualifies (ui.js: updatePeakLabel()), an exclusion toggle does NOT
   *   (ui.js: togglePeakExclusion() must omit this / pass false, since
   *   excluding a peak changes clusterPeaks()'s input set). Found and added
   *   via real A/B benchmarking (docs/archive/visualizer_rendering_perf_routes.md
   *   §2.4) — clustering was ~33ms of a ~36ms single-track refresh, the
   *   reason this method was only ~1.1x faster than a full renderData()
   *   rebuild for a label edit despite already skipping path/hotspot work.
   */
  refreshPeakMarkers(analyzer, gpsParams, options) {
    if (!this.map || !analyzer) return;
    const p = gpsParams || {};
    const opts = options || {};

    const activeTrack = (typeof AppState !== 'undefined' && AppState.collectiveManager)
      ? AppState.collectiveManager.getTrack(AppState.activeTrackId)
      : null;

    if (!activeTrack) {
      this.renderData(analyzer, gpsParams);
      return;
    }

    if (!opts.skipClustering) {
      this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    }

    this._refreshTrackLayers(
      activeTrack,
      new Set(['peak', 'connector']),
      () => this._renderPeakMarkers(analyzer, analyzer.raw, p.peakLatency || 0, activeTrack, { skipClustering: !!opts.skipClustering }),
      true
    );
  }

  /**
   * Re-render ONLY the active track's path segments — used by the map-
   * colouring-metric dropdown, which changes how the path is coloured but
   * leaves peak/hotspot positions and popups untouched (see
   * docs/archive/visualizer_rendering_perf_routes.md §2.2). Same shape as
   * refreshPeakMarkers(): remove just the 'path' layers from the track's
   * owned-layers registry and layerGroup, then re-run the path renderer.
   *
   * Falls back to the full renderData() for the legacy no-track case, same
   * reason as refreshPeakMarkers() — those layers aren't tagged per-track.
   */
  refreshPath(analyzer, gpsParams) {
    if (!this.map || !analyzer) return;
    const p = gpsParams || {};

    const activeTrack = (typeof AppState !== 'undefined' && AppState.collectiveManager)
      ? AppState.collectiveManager.getTrack(AppState.activeTrackId)
      : null;

    if (!activeTrack) {
      this.renderData(analyzer, gpsParams);
      return;
    }

    const cacheKey = AppState.activeTrackId || 'single';
    const { drawPoints } = this._getOrBuildDrawPoints(cacheKey, analyzer, p);
    // No path today (e.g. every GPS fix gated out) — nothing to recolor, and
    // renderData()'s own no-path branch already left peak/hotspot markers as
    // the only rendered layers, so there's nothing here to touch either.
    if (drawPoints.length === 0) return;

    this._refreshTrackLayers(
      activeTrack,
      new Set(['path']),
      () => this._renderPathSegments(drawPoints, p.trackWeight || 5, analyzer, activeTrack),
      false
    );
  }

  _getTrackSetSignature(collectiveManager) {
    if (!collectiveManager) return '';
    const active = collectiveManager.getActiveTracks ? collectiveManager.getActiveTracks() : [];
    return active.map(t => t.id).sort().join(',');
  }

  _fitBounds(drawPoints, opts = {}) {
    if (!this.map || !drawPoints || drawPoints.length === 0) return;
    this._flyOrFitBounds(drawPoints.map(p => [p.lat, p.lon]), opts);
  }

  /**
   * Animate the map to a bounds (LatLngBounds or a [lat, lon] pair array),
   * preferring flyToBounds and degrading to fitBounds. Pass `fly: false` in
   * opts to force fitBounds. Shared by every auto-zoom-to-extent call site.
   */
  _flyOrFitBounds(bounds, opts = {}) {
    if (!this.map || !bounds) return;
    const fitOpts = {
      padding: [30, 30],
      maxZoom: 17,
      animate: true,
      duration: 0.45,
      easeLinearity: 0.25,
      ...opts
    };
    if (typeof this.map.flyToBounds === 'function' && fitOpts.fly !== false) {
      this.map.flyToBounds(bounds, fitOpts);
    } else if (typeof this.map.fitBounds === 'function') {
      this.map.fitBounds(bounds, fitOpts);
    }
  }

  /**
   * Enable/disable the RF Fluid toggle button + mode select for the active
   * view (single-track or collective). Shared so collective mode doesn't
   * leave the button stuck disabled from whatever the last single-track
   * render happened to set it to.
   */
  _updateRfFluidButtonState(hasRf) {
    this.hasRfData = hasRf;
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
        // Re-sync the button's pressed state (and the renderer's visibility)
        // to the real RF-fluid toggle. Without this, a no-RF track earlier
        // cleared the button's 'active' class while showRFFluid stayed true
        // (and the renderer stayed visible), so a later RF render — e.g. a
        // collective view where one track has RF data — drew the fluid behind
        // an "unpressed" button with no way to turn it off.
        btnToggleRFFluid.classList.toggle('active', !!this.showRFFluid);
        if (this.rfFluidRenderer) {
          this.rfFluidRenderer.setVisible(!!this.showRFFluid);
        }
      }
    }
    if (rfFluidMode) {
      if (!hasRf) {
        rfFluidMode.setAttribute('disabled', 'disabled');
      } else {
        rfFluidMode.removeAttribute('disabled');
      }
    }
  }

  _getMetricKey(metric) {
    // OSM entries (roadClass..amenityCount) come from the shared
    // GSR_CONST.OSM_METRICS table (constants.js) — see the legend's
    // metricNames above for the other consumer of that same table.
    const keys = {
      'gsr': 'val',
      'hdopQuality': 'hdop',
      'em_fog': 'em_fog'
      // Note: phasic/tonic/peakDensity/phasicAUC/arousalIndex are NOT looked
      // up via this key — see DERIVED_METRIC_SERIES in _renderPathSegments.
      // They live in per-sample analyzer arrays (analyzer.phasic[i], etc.),
      // not on the drawPoint objects themselves, and drawPoints are cached
      // across GSR re-analyses (keyed only on GPS params), so baking them in
      // here would go stale the moment a GSR slider changes without a GPS
      // param also changing.
    };
    GSR_CONST.OSM_METRICS.forEach(m => { keys[m.key] = m.field; });
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
    
    let points = this._lastDrawPoints || [];
    if ((!points || points.length === 0) && typeof AppState !== 'undefined' && AppState.viewMode === 'collective' && AppState.collectiveManager) {
      const activeTracks = AppState.collectiveManager.getActiveTracks();
      const combinedPoints = [];
      activeTracks.forEach(t => {
        const p = t.gpsFilterParams || {};
        const { drawPoints } = this._getOrBuildDrawPoints(t.id, t.analyzer, p);
        if (drawPoints) combinedPoints.push(...drawPoints);
      });
      if (combinedPoints.length > 0) {
        points = combinedPoints;
        this._lastDrawPoints = combinedPoints;
      }
    }

    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setData(points, geoms);
    }

    this.osmLayers = [];

    // Group same-style shapes into a single ring array per category, instead
    // of one Leaflet Path layer per feature. Areas with dense OSM building
    // coverage can hand back thousands of ways/relations; each one used to
    // become its own L.polygon (own layer registration, own onAdd/_project
    // pass, own entry in the map's layer table). Rings within a category
    // never overlap each other (they're distinct real-world buildings/parks/
    // water bodies), so a single multi-ring L.polygon per category renders
    // pixel-identical output — canvas/SVG fill and stroke both treat each
    // disjoint ring independently regardless of winding — while cutting the
    // layer count from N features down to at most 3 (park/water/building).
    const ringsByCategory = { park: [], water: [], building: [] };
    const STYLES = {
      park:     { color: '#2d6a4f', fillColor: '#52b788', fillOpacity: 0.15, weight: 1 },
      water:    { color: '#0077b6', fillColor: '#90e0ef', fillOpacity: 0.25, weight: 1 },
      building: { color: '#4a4e69', fillColor: '#9a8c98', fillOpacity: 0.1,  weight: 1 }
    };

    geoms.ways.concat(geoms.relations).forEach(geom => {
      const tags = geom.tags;
      if (!tags) return;

      const isPark = tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'nature_reserve' || tags.leisure === 'playground' || tags.landuse === 'grass' || tags.landuse === 'forest' || tags.landuse === 'meadow' || tags.landuse === 'recreation_ground' || tags.landuse === 'village_green' || tags.natural === 'wood' || tags.natural === 'scrub' || tags.natural === 'grassland' || tags.natural === 'heath';
      const isWater = tags.natural === 'water' || tags.natural === 'wetland' || tags.waterway === 'river' || tags.waterway === 'canal' || tags.waterway === 'stream' || tags.waterway === 'drain' || tags.waterway === 'ditch' || tags.landuse === 'basin' || tags.landuse === 'reservoir';
      const isBuilding = !!tags.building;

      const category = isPark ? 'park' : (isWater ? 'water' : (isBuilding ? 'building' : null));
      if (!category) return;

      const rings = ringsByCategory[category];
      if (geom.type === 'way' && geom.coordinates.length > 2) {
        rings.push(geom.coordinates.map(pt => [pt.lat, pt.lon]));
      } else if (geom.type === 'relation' && geom.outerWays) {
        geom.outerWays.forEach(way => {
          rings.push(way.coordinates.map(pt => [pt.lat, pt.lon]));
        });
      }
    });

    for (const category of Object.keys(ringsByCategory)) {
      const rings = ringsByCategory[category];
      if (rings.length === 0) continue;
      const poly = L.polygon(rings, STYLES[category]).addTo(this.map);
      this.osmLayers.push(poly);
    }
  }

  clearOsmShapes() {
    if (this.osmLayers) {
      this.osmLayers.forEach(layer => this.map.removeLayer(layer));
    }
    this.osmLayers = [];
  }

  /**
   * Pass 1 of overlap-aware colour: bin the draw points into a grid of
   * `radiusM` cells, accumulate each cell's metric sum/count, and — walking the
   * path in time order — flag the cells where the path RE-ENTERS a place it
   * had left more than `revisitGapS` seconds ago. For each point the 3×3 block
   * around its cell is checked for a "stale" touch (last seen > revisitGapS
   * ago); when found, both the stale cell and the current cell are flagged, so
   * two passes that run alongside each other in *adjacent* cells (GPS noise
   * between visits) are still caught, not just pixel-exact re-walks.
   *
   * The re-entry test is on *elapsed time*, so a path merely wiggling across a
   * cell boundary (re-touches milliseconds apart) is never a revisit — no
   * grid-straddle false positive, and no sorting. One linear pass, 9 map reads
   * per point, one small object per occupied cell.
   *
   * @param {Array<{lat:number, lon:number, time:number}>} drawPoints
   * @param {(p:object) => number} getVal
   * @param {number} radiusM  cell edge in metres
   * @param {number} revisitGapS
   * @returns {{ cells: Map<string,{cr,cc,sum,count,lastT,revisited}>,
   *            rLat:number, rLon:number, anyRevisited:boolean } | null}
   * @private
   */
  static _buildOverlapCells(drawPoints, getVal, radiusM, revisitGapS) {
    if (!Array.isArray(drawPoints) || drawPoints.length < 4 || !(radiusM > 0)) return null;
    if (typeof GeoUtils === 'undefined' || typeof GeoUtils.getGeodesicScale !== 'function') return null;

    const sc = GeoUtils.getGeodesicScale(drawPoints[drawPoints.length >> 1].lat);
    const mLat = sc.degToMeterLat || 111320;
    const mLon = Math.abs(sc.degToMeterLon) > 1 ? Math.abs(sc.degToMeterLon) : 1;
    const rLat = radiusM / mLat;
    const rLon = radiusM / mLon;

    const cells = new Map();
    let anyRevisited = false;
    for (let i = 0; i < drawPoints.length; i++) {
      const p = drawPoints[i];
      const v = getVal(p);
      if (v === undefined || v === null || (typeof v === 'number' && isNaN(v))) continue;
      const t = p.time;
      const cr = Math.floor(p.lat / rLat);
      const cc = Math.floor(p.lon / rLon);
      const k = cr + '|' + cc;

      // Re-entry? Scan the 3×3 block (including this cell) for a stale touch.
      let reentry = false;
      if (isFinite(t)) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nb = cells.get((cr + dr) + '|' + (cc + dc));
            if (nb && isFinite(nb.lastT) && t - nb.lastT > revisitGapS) {
              nb.revisited = true;
              reentry = true;
            }
          }
        }
      }

      let c = cells.get(k);
      if (!c) { c = { cr, cc, sum: 0, count: 0, lastT: t, revisited: false }; cells.set(k, c); }
      if (reentry) { c.revisited = true; anyRevisited = true; }
      if (isFinite(t)) c.lastT = t;
      c.sum += v;
      c.count++;
    }
    return { cells, rLat, rLon, anyRevisited };
  }

  /**
   * Build a metric accessor `(drawPoint) => value` that, where the walk
   * genuinely retraces itself, returns the mean of the active metric across a
   * small neighbourhood instead of that point's own value — so a re-walked
   * street shows one combined colour rather than whichever visit was drawn
   * last. Elsewhere it falls straight through to `getVal`.
   *
   * `radiusM` is the caller's "same spot" distance — the stroke's on-screen
   * width in metres (see _overlapRadiusMetres) — so a spot counts as
   * overlapping exactly when the two drawn lines visually merge. Detection and
   * cell sums come from `_buildOverlapCells` (straddle-safe, sort-free). Each
   * revisited cell is then coloured by the mean over its 3×3 block, which
   * keeps the colour smooth along a re-walked street instead of blocky per
   * cell and softens the ends of the overlap.
   *
   * Returns `null` when nothing overlaps (or the path is too short / GeoUtils
   * absent) so the caller keeps its plain accessor and non-overlapping paths
   * stay byte-identical.
   *
   * @param {Array<{lat:number, lon:number, time:number}>} drawPoints
   * @param {(p:object) => number} getVal
   * @param {{radiusM?:number, revisitGapS?:number}|null} [opts]
   * @returns {((p:object) => number) | null}
   * @private
   */
  static _overlapPooledAccessor(drawPoints, getVal, opts) {
    const radiusM = (opts && opts.radiusM > 0) ? opts.radiusM : 7;
    const revisitGapS = (opts && opts.revisitGapS > 0) ? opts.revisitGapS : 15;

    const built = GSRMapManager._buildOverlapCells(drawPoints, getVal, radiusM, revisitGapS);
    if (!built || !built.anyRevisited) return null;

    const { cells, rLat, rLon } = built;
    const pooled = new Map(); // "cr|cc" -> mean metric over the 3×3 block

    for (const c of cells.values()) {
      if (!c.revisited) continue;
      let sum = 0, count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nb = cells.get((c.cr + dr) + '|' + (c.cc + dc));
          if (nb) { sum += nb.sum; count += nb.count; }
        }
      }
      if (count > 0) pooled.set(c.cr + '|' + c.cc, sum / count);
    }
    if (pooled.size === 0) return null;

    // Order-independent 32-bit fingerprint of the outcome. `_refreshPathOnZoom`
    // compares it to the last render's so a zoom that doesn't actually change
    // which stretches overlap (most small zoom steps) skips the path rebuild —
    // the rebuild is what visually jerks.
    let sig = pooled.size | 0;
    for (const [k, v] of pooled) {
      let h = Math.round(v * 1000) | 0;
      for (let i = 0; i < k.length; i++) h = (Math.imul(h, 31) + k.charCodeAt(i)) | 0;
      sig = (sig + h) | 0;
    }

    const fn = (p) => {
      if (!p) return getVal(p);
      const m = pooled.get(Math.floor(p.lat / rLat) + '|' + Math.floor(p.lon / rLon));
      return (m !== undefined) ? m : getVal(p);
    };
    fn.sig = sig;
    return fn;
  }

  /**
   * Cheap gate: does the path ever come back to within `radiusM` of its own
   * earlier route after a > `revisitGapS` gap? Pass 1 only (no pooling). Used
   * to decide whether a zoom change could ever create/destroy an overlap — if
   * not, the zoomend hook can skip re-rendering entirely.
   * @private
   */
  static _pathRetraces(drawPoints, opts) {
    const radiusM = (opts && opts.radiusM > 0) ? opts.radiusM : 60;
    const revisitGapS = (opts && opts.revisitGapS > 0) ? opts.revisitGapS : 15;
    const built = GSRMapManager._buildOverlapCells(drawPoints, () => 1, radiusM, revisitGapS);
    return !!(built && built.anyRevisited);
  }

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
  }

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
  }

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

  // Note: cartographic label placement + HTML builders live in GSRLabelManager
  // (label_placement.js); peak-popup DOM builders in MapPopups (map_popups.js).

  _renderPeakMarkers(analyzer, data, peakLatency, track, options) {
    options = options || {};
    const layerGroup = track ? track.layerGroup : null;
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
          // Bump labelled markers above unlabelled markers and path layers
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

      // Phase 1 (slice 3): tag the peak index so focusOnPeak can resolve the
      // marker without the old flat array.
      marker._gsrPeakIndex = index;

      // Phase 1 (slice 1/3): the marker belongs to the track's layerGroup
      // REGARDLESS of whether it's currently visible. Tagging it only inside
      // the `shouldAdd` gate left hidden-at-render markers untagged, so
      // toggling them on later fell back to the legacy direct-to-map path and
      // they escaped the group — surviving track removal (removal only takes
      // the group). Tag always; add to the group only when visible.
      //
      // _gsrKind must be set unconditionally (not just in the layerGroup
      // branch) — getRenderLayers()/getPeakMarkerByIndex()/
      // updateMarkerVisibility() all classify layers by _gsrKind, including
      // ones rendered via the legacy no-track fallback below. Leaving it
      // unset there made fallback-rendered peaks invisible to all three
      // (found via refreshPeakMarkers()'s fallback-path test — see
      // _createHotspotMarker for the pattern this now matches).
      marker._gsrKind = 'peak';
      const shouldAdd = this.showPeaks || (this.showLabels && marker.hasLabel);
      if (layerGroup) {
        marker._gsrLayerGroup = layerGroup;
        if (shouldAdd) {
          layerGroup.addLayer(marker);
        }
      } else if (shouldAdd) {
        marker.addTo(this.map);
      }

      // Dim excluded peak markers
      if (peak.excluded) {
        marker.setOpacity(0.35);
      }

      marker.bindPopup(() => MapPopups.buildSinglePeakPopup(analyzer, peak, index, coords, marker));

      marker.on('click', () => {
        GSRUI.focusOnPeak(index, 'map');
      });

      this._registerTrackLayer(track, marker);
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
        });
        // Same unconditional-_gsrKind fix as the peak marker above.
        conn._gsrKind = 'connector';
        if (layerGroup) {
          conn._gsrLayerGroup = layerGroup;
          layerGroup.addLayer(conn);
        } else {
          conn.addTo(this.map);
        }
        this._registerTrackLayer(track, conn);
      }
    }

    // Render cluster boundaries. Skipped when options.skipClustering is set
    // (refreshPeakMarkers()'s label-edit path — see its own doc comment):
    // clusterPeaks() only reads lat/lon/amplitude per active peak, none of
    // which a label edit touches, so recomputing here is provably wasted —
    // found via real A/B benchmarking (docs/archive/visualizer_rendering_perf_routes.md
    // §2.4), where this was ~33ms of a ~36ms single-track refresh, the
    // reason that refresh was only ~1.1x faster than a full renderData()
    // despite skipping path/hotspot rebuilding entirely. An exclusion toggle
    // DOES change this method's input (activePeaks filters on ap.peak.excluded),
    // so it must keep recomputing — refreshPeakMarkers() only passes
    // skipClustering for the label-edit call site, not the exclusion one.
    if (!options.skipClustering) {
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

        this._renderClusters(clusters, refAmplitude, sigma, boundaryRadius);
      }
    }
  }

  /**
   * Build the shared Leaflet divIcon for every hotspot marker on the map —
   * single-track (_renderHotspotMarkers) and collective/multi-track
   * (renderCollectiveData) both call it, so the two views can't drift apart
   * visually. The glyph is a red star (★, .hotspot-star), consistent across the
   * GSR graph, the 2D map and the 3D globe (peaks are a small circle
   * everywhere; hotspots are a star). Behind it sits the expanding pulse-glow
   * ring (.hotspot-glow-ring, styles.css): peak markers are static (see
   * drawPeakMarkers() in renderer.js), so the animation is reserved for the
   * small curated hotspot set, to draw the eye to what matters.
   * @private
   */
  static _buildHotspotIcon() {
    return L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:28px;height:28px;">' +
        '<div class="hotspot-glow-ring" style="position:absolute;top:0;left:0;"></div>' +
        '<div class="hotspot-star" style="position:absolute;top:0;left:0;width:28px;height:28px;">★</div>' +
        '</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
  }

  /**
   * Build the shared Leaflet divIcon for every unlabelled, non-hotspot peak
   * marker — single-track (_renderPeakMarkers) and collective/multi-track
   * (renderCollectiveData) both call it, so a peak looks identical on both
   * views: small, quality-neutral --color-peak red dot, no per-track colour, no
   * animation. In collective view you tell tracks apart by clicking a marker
   * (the popup shows the track name), not by dot colour.
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
  _renderClusters(clusters, refAmplitude, sigma, boundaryRadius) {
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

  /**
   * Internal helper to construct and initialise a Leaflet hotspot marker.
   * @private
   */
  _createHotspotMarker(analyzer, peak, peakLatency, popupCallback, clickCallback, track) {
    const index = analyzer.peaks.indexOf(peak);
    if (index < 0) return null;

    const coords = this._hotspotMarkerCoords(analyzer, peak, peakLatency);
    if (!coords) return null;

    const layerGroup = track ? track.layerGroup : null;
    const hotspotIcon = GSRMapManager._buildHotspotIcon();
    const marker = L.marker([coords.lat, coords.lon], { icon: hotspotIcon });
    marker.setZIndexOffset(1500); // Above both regular peak dots and labels
    // Phase 1 (slice 1): single-track hotspots render into the track's
    // layerGroup. Collective callers don't pass a group → legacy direct add.
    // The group is tagged ALWAYS (even when currently hidden) so toggling the
    // hotspot on later routes it through the group — tagging only inside the
    // `showHotspots` gate made hidden hotspots fall back to direct-to-map adds
    // that survived the track's removal.
    marker._gsrKind = 'hotspot';
    if (layerGroup) {
      marker._gsrLayerGroup = layerGroup;
      if (this.showHotspots) {
        layerGroup.addLayer(marker);
      }
    } else if (this.showHotspots) {
      marker.addTo(this.map);
    }
    this._registerTrackLayer(track, marker);

    marker.bindPopup(() => popupCallback(index, coords, marker));
    if (clickCallback) {
      marker.on('click', () => clickCallback(index));
    }
    return marker;
  }

  _renderHotspotMarkers(analyzer, peakLatency, track) {
    const events = analyzer.memorableEvents;
    if (!events || events.length === 0) return;

    events.forEach(peak => {
      const marker = this._createHotspotMarker(
        analyzer,
        peak,
        peakLatency,
        (index, coords, m) => MapPopups.buildSinglePeakPopup(analyzer, peak, index, coords, m),
        (index) => GSRUI.focusOnPeak(index, 'map'),
        track
      );
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

    events.forEach(peak => {
      const marker = this._createHotspotMarker(
        analyzer,
        peak,
        peakLatency,
        (index, coords, m) => MapPopups.buildCollectivePeakPopup(track, peak, index, coords.lat, coords.lon, m),
        null,
        track
      );
    });
  }

  /**
   * Render one track's collective-mode peak dot markers + connector lines,
   * with 360° label-collision avoidance scoped to just this track's own
   * peaks (collectiveLabelCandidates/collectiveAllPeaks are per-call, not
   * shared across tracks — a label change on one track can't perturb
   * another track's layout). Shared by renderCollectiveData() (full
   * rebuild, passes activePeaksSink so non-excluded peaks feed the global
   * clustering pass) and refreshCollectivePeakMarkers() (label-edit-only
   * partial refresh, passes null — see that method's doc comment for why
   * skipping the clustering push is correct there).
   * @private
   */
  _renderCollectiveTrackPeaks(track, layerGroup, trackColor, peakLatency, activePeaksSink) {
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
        if (activePeaksSink && !peak.excluded) {
          activePeaksSink.push({
            lat: coords.lat,
            lon: coords.lon,
            amplitude: peak.amplitude
          });
        }
      }
    });

    // 360° collision avoidance for collective labels
    const collectivePositions = GSRLabelManager.computeLabelPositions(collectiveLabelCandidates);

    // Compact dot-only icon for unlabelled peaks — the same shared icon
    // single-track peaks use (GSRMapManager._buildPeakIcon()), not
    // per-track-coloured, so a peak looks identical regardless of which view
    // it's shown in.
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
          // Bump labelled markers above everything else on the map
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

      marker.bindPopup(() => MapPopups.buildCollectivePeakPopup(track, peak, index, lat, lon, marker));

      // Phase 1 (slice 2/3): collective peak markers render into this track's
      // own layerGroup; the peak index is tagged so focusOnPeak can resolve it.
      // Tag the group ALWAYS (even when currently hidden) so toggling the
      // marker on later routes it through the group — tagging only when
      // visible made hidden markers fall back to direct-to-map adds that
      // survived the track's removal.
      marker._gsrKind = 'collectivePeak';
      marker._gsrPeakIndex = index;
      marker._gsrLayerGroup = layerGroup;
      const shouldAdd = this.showPeaks || (this.showLabels && marker.hasLabel);
      if (shouldAdd) {
        layerGroup.addLayer(marker);
      }
      // Dim excluded peak markers
      if (peak.excluded) {
        marker.setOpacity(0.35);
      }
      this._registerTrackLayer(track, marker);
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
        });
        conn._gsrKind = 'collectiveConnector';
        conn._gsrLayerGroup = layerGroup;
        layerGroup.addLayer(conn);
        this._registerTrackLayer(track, conn);
      }
    }
  }

  /**
   * Re-render ONLY one track's collective-mode peak dot markers + connector
   * lines — used by updatePeakLabel() in collective view. A label edit only
   * ever changes that one peak's label chip/popup plus this track's own
   * 360° label-collision layout (see _renderCollectiveTrackPeaks's doc
   * comment: that layout is computed per-track, not globally) — nothing
   * else in collective mode reads peak.label. Path, hotspots, clusters, and
   * the contour surface are all left untouched by reference.
   *
   * Deliberately NOT reused for togglePeakExclusion() in collective mode:
   * `excluded` IS read by both the global clustering pass
   * (allActivePeaksAcrossTracks in renderCollectiveData()) and
   * generateContourSurface() (collective_manager.js, when topographySource
   * is 'peaks') — both full-dataset computations across every active track,
   * not per-track, so an exclusion toggle still needs the full
   * renderCollectiveData() rebuild to stay correct. See the Phase 6 step 2
   * investigation note in docs/archive/visualizer_architecture_refactor_plan.md.
   *
   * Falls back to GSRUI.updateCollectiveMap() (the full rebuild) when the
   * track isn't a currently-active/rendered one (no layerGroup to refresh
   * into) — same reasoning as refreshPeakMarkers()'s no-track fallback.
   */
  refreshCollectivePeakMarkers(track, peakLatency) {
    if (!this.map) return;
    if (!track || !track.layerGroup) {
      if (typeof GSRUI !== 'undefined' && typeof GSRUI.updateCollectiveMap === 'function') {
        GSRUI.updateCollectiveMap();
      }
      return;
    }

    const layerGroup = track.layerGroup;
    const trackColor = track.color || '#0ea5e9';

    this._refreshTrackLayers(
      track,
      new Set(['collectivePeak', 'collectiveConnector']),
      () => this._renderCollectiveTrackPeaks(track, layerGroup, trackColor, peakLatency || 0, null),
      true
    );
  }

  /**
   * Resolve the raw-sample index a marker should be positioned at, applying
   * the optional GPS-latency shift (find the GPS fix at peak.time -
   * peakLatency instead of peak.time itself, falling back to peak.index if
   * nothing is found there). Shared by _renderPeakMarkers(),
   * _renderHotspotMarkers() and _renderCollectiveTrackHotspots().
   * @private
   */
  _resolveLatencyIndex(analyzer, peak, peakLatency) {
    if (analyzer && typeof analyzer.resolveLatencyIndex === 'function') {
      return analyzer.resolveLatencyIndex(peak, peakLatency);
    }
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
    let boundaryRadius = AppState.sliders.clusterBoundaryRadius ? parseFloat(AppState.sliders.clusterBoundaryRadius.value) : 5;
    if (isNaN(boundaryRadius)) boundaryRadius = 5;

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
    const paths = this.getRenderLayers().paths;
    if (this.map && paths.length > 0) {
      const group = new L.featureGroup(paths);
      this._flyOrFitBounds(group.getBounds());
    }
  }

  // Layer visibility toggles (togglePeaks / toggleLabels / toggleHotspots /
  // updateMarkerVisibility / _toggleLayer / toggleClusters / toggleIsolines /
  // toggleSurface / toggleTracks) live in map_manager_toggles.js, which
  // prototype-augments GSRMapManager right after this file loads.

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
    // Phase 1 (slice 3): the collective per-track layers live in the track
    // layerGroups — clear them here too (idempotent with clearMap) so the
    // "uncheck the last track" path (which calls this without a re-render)
    // can't leave a stale group behind.
    this._clearRenderedTrackGroups();
    this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    this.clearContours();
    this._clearRfFluid();
    // There is no graph to scrub in collective view — drop any scrub indicator
    // left over from single-track hover. clearMap covers the full clearAll()
    // path; this covers the 0-active-tracks path, which only calls
    // clearCollectiveLayers() (and noLoop() stops handleScrubber from hiding it).
    if (this.scrubMarker && this.map && this.map.hasLayer(this.scrubMarker)) {
      this.map.removeLayer(this.scrubMarker);
    }
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
    if (this.coverageOverlay) {
      this.map.removeLayer(this.coverageOverlay);
      this.coverageOverlay = null;
    }
  }

  /**
   * Render all active tracks overlaid simultaneously, then draw contour lines.
   */
  renderCollectiveData(collectiveManager, contourParams = {}, peakLatency) {
    this.clearAll(); // Clear single-track drawing + prior collective layers

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
    // Phase 5: per-track drawPoints/osmGeoms references (not concatenated) so
    // RFFluidRenderer.setDataForTracks() can reuse cached fan-cast geometry
    // for tracks whose data didn't change (see that method's doc comment).
    const rfTracksData = [];

    // 1. Draw dashed, semi-transparent paths for each track
    activeTracks.forEach(track => {
      const data = track.analyzer.raw;
      const p = track.gpsFilterParams || {};

      // Phase 1 (slice 2): each active track owns a layerGroup; all of this
      // track's collective layers (path, peaks, connectors, hotspots) render
      // into it, so removal/deactivation of the track reduces to
      // map.removeLayer(track.layerGroup).
      const layerGroup = this._getTrackLayerGroup(track);

      // Use cached GPS pipeline (cache keyed by track id)
      const { drawPoints } = this._getOrBuildDrawPoints(track.id, track.analyzer, p);
      if (drawPoints.length > 0) {
        collectiveDrawPoints.push(...drawPoints);
        rfTracksData.push({ id: track.id, drawPoints, osmGeoms: track.analyzer && track.analyzer.osmGeoms });
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
      // Phase 1 (slice 2): the collective path renders into this track's own
      // layerGroup, never directly onto the map. Tag the group ALWAYS (even
      // when showTracks is off) so toggling the Tracks control back on routes
      // the path through the group — tagging only when visible made paths
      // fall back to direct-to-map adds that survived the track's removal.
      poly._gsrKind = 'collectivePath';
      poly._gsrLayerGroup = layerGroup;
      if (this.showTracks) {
        layerGroup.addLayer(poly);
      }
      this._registerTrackLayer(track, poly);

      // 2. Draw peak dot markers — 360° label placement with collision avoidance
      this._renderCollectiveTrackPeaks(track, layerGroup, trackColor, peakLatency, allActivePeaksAcrossTracks);

      // Hotspot markers for this track — same shared icon/styling as the
      // single-track view (_renderHotspotMarkers), deliberately NOT
      // track-coloured like the regular collective peak dots above: a
      // hotspot's whole point is to stand out as "one of the biggest events,
      // in any track," so it keeps the fixed hotspot-red across every track
      // rather than blending into that track's own color scheme.
      this._renderCollectiveTrackHotspots(track, peakLatency);
    });

    if (collectiveDrawPoints.length > 0) {
      this._lastDrawPoints = collectiveDrawPoints;
    }
    if (this.rfFluidRenderer && rfTracksData.length > 0) {
      this.rfFluidRenderer.setDataForTracks(rfTracksData);
    }
    this._updateRfFluidButtonState(activeTracks.some(t => t.analyzer && t.analyzer.hasRfData));

    // Render collective global clusters across all active tracks
    if (allActivePeaksAcrossTracks.length > 0 && typeof GSRSpatialClustering !== 'undefined') {
      // Retrieve dynamic clustering parameters from UI sliders
      const { boundaryRadius, sigma, effectiveProximity } = this._getClusteringParams();

      const refAmplitude = this._meanAmplitude(allActivePeaksAcrossTracks);
      const clusters = GSRSpatialClustering.clusterPeaks(allActivePeaksAcrossTracks, effectiveProximity, boundaryRadius, sigma);
      this._renderClusters(clusters, refAmplitude, sigma, boundaryRadius);
    }

    // 3. Zoom and Pan Map to fit collective bounding envelope — but only when the active
    // track set actually changed (tracks added/removed/toggled). Re-fitting on every contour
    // slider tweak would reset the zoom the user had picked to inspect a specific area.
    if (trackSetSignature !== this._lastFitBoundsTrackSet) {
      const bounds = collectiveManager.getBounds();
      if (bounds && this.map) {
        const bbox = [
          [bounds.minLat, bounds.minLon],
          [bounds.maxLat, bounds.maxLon]
        ];
        this._flyOrFitBounds(bbox, { padding: [40, 40] });
      }
      this._lastFitBoundsTrackSet = trackSetSignature;
      if (!this._lastFitBoundsTrackId && typeof AppState !== 'undefined' && AppState.activeTrackId) {
        this._lastFitBoundsTrackId = AppState.activeTrackId;
      }
    }

    // 4. Calculate and render topographic contour lines
    this.renderContours(collectiveManager, contourParams);

    // Apply the active peak/label toggle styles
    this.updateMarkerVisibility();

    // Update legend for collective view
    this.updateLegend();

    if (typeof AppState !== 'undefined' && AppState.emit) AppState.emit('map:rendered');
  }

  /**
   * Call contour generation math and draw vector polyline boundaries
   */
  renderContours(collectiveManager, contourParams) {
    this.clearContours();

    const surfaceData = collectiveManager.generateContourSurface(contourParams);
    if (!surfaceData || !surfaceData.contours) {
      this._collectiveTopographySource = null;
      this._legendMinVal = 0;
      this._legendMaxVal = 0;
      return;
    }
    this.surfaceData = surfaceData;

    const { contours, grid, minVal, maxVal, bounds, sortedVals, upsampledCoverageRatioGrid } = surfaceData;
    this._collectiveTopographySource = contourParams.topographySource;
    this._legendMinVal = minVal;
    this._legendMaxVal = maxVal;
    const { surfaceOpacity = 0.40 } = contourParams;
    const hillshadeStrength = contourParams.hillshadeStrength !== undefined ? contourParams.hillshadeStrength : 0.0;
    const coverageWeighting = contourParams.coverageWeighting !== undefined ? contourParams.coverageWeighting : 0.0;

    // 1. Draw shaded continuous surface overlay.
    //    The overlay is created whenever there is surface data — it is NOT gated
    //    on the button's showShadedSurface state. Gating creation meant a
    //    re-render while the surface was hidden (e.g. deleting a track with the
    //    surface off) ran clearContours() (which nulls surfaceOverlay) and then
    //    skipped recreating it, so toggleSurface(true)'s `if (!this.surfaceOverlay)
    //    return;` had nothing to re-add and the surface never came back. Visibility
    //    is a pure add/remove of this overlay via this.showSurface — same pattern
    //    as the isoline/track toggles, which also always create their layers.
    const activeGrid = surfaceData.upsampledGrid || grid;
    if (activeGrid && activeGrid.length > 0 && bounds) {
      const rows = activeGrid.length;
      const cols = activeGrid[0].length;

      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');

      // Remember for GSRMapExporter's SVG export, which recomputes this same
      // shading over its own vector mesh (map_exporter.js _buildVectorMesh)
      // and needs to match what's currently on screen.
      this._hillshadeStrength = hillshadeStrength;

      const drawCell = (r, c, ratio, lightness) => {
        ctx.fillStyle = MapColors.getHslColor(ratio, 100, lightness);
        ctx.fillRect(c, rows - 1 - r, 1, 1);
      };

      if (hillshadeStrength <= 0) {
        // True zero-overhead path at 0% strength: no ratio grid, no
        // Hillshade.compute() slope/aspect pass, no per-cell shade blend —
        // just Hillshade.valueRatio() (an O(1), allocation-free lookup) per
        // cell at a fixed 50% lightness, the same cost class as the
        // pre-hillshade single-pass loop this replaced.
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const val = activeGrid[r][c];
            if (val === null || isNaN(val)) continue;
            drawCell(r, c, Hillshade.valueRatio(val, minVal, maxVal, sortedVals, StatsMath.percentileRank), 50);
          }
        }
      } else {
        // ratioGrid is the SAME field that drives both the fill hue below
        // and, in generateContourSurface(), where the isoline levels
        // themselves land (both percentile-based, not linear-value-based —
        // see that method's comment on why: it keeps bands/lines spread
        // across where the distribution actually varies instead of bunching
        // on a flat majority). shadeValueGrid() hillshades that SAME ratio
        // field, not the raw value, so the relief is the literal same
        // surface the isolines and colors are drawn from.
        const hc = GSR_CONST.HILLSHADE;
        const { ratioGrid, shade } = Hillshade.shadeValueGrid(activeGrid, rows, cols, {
          minVal, maxVal, sortedVals, rankFn: StatsMath.percentileRank,
          exaggeration: hc.exaggeration, azimuthDeg: hc.azimuthDeg, altitudeDeg: hc.altitudeDeg
        });

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const ratio = ratioGrid[r][c];
            if (ratio === null) continue;
            // Lightness carries the hillshade relief (dark = shadowed, bright =
            // sun-facing); hue/saturation still carry the data value via `ratio`.
            const lightness = Hillshade.blendLightness(shade[r * cols + c], hillshadeStrength, hc.minLightness, hc.maxLightness);
            drawCell(r, c, ratio, lightness);
          }
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

      // 1b. Coverage hatch — a SEPARATE raster layer, not baked into the color canvas
      // above. That canvas is intentionally small and gets stretched with smooth
      // interpolation (bicubic-upsampled, blurred) so the color gradient looks continuous —
      // exactly the wrong scaling mode for a crisp overlay pattern, which would blur into
      // grey mush at most zoom levels if it shared that canvas. Instead this draws its own
      // raster at a finer resolution, and .collective-coverage-hatch (styles.css) forces
      // nearest-neighbour scaling on just this layer, so the lines stay crisp at any zoom
      // while the color layer underneath keeps its smooth blur.
      //
      // Diagonal lines, not a checkerboard: a checkerboard's alternating cells read via
      // brightness CONTRAST BETWEEN NEIGHBORING cells — which the color data underneath
      // (itself varying cell to cell) visually collides with, breaking the grid up into
      // noise. A continuous diagonal stroke carries its own orientation regardless of what
      // color it crosses, so it stays legible as "this is a texture laid over the data"
      // instead of blending into the data's own variation.
      if (coverageWeighting > 0 && upsampledCoverageRatioGrid) {
        // Rendered at a multiple of the data grid's own resolution — fine, dense lines read
        // as "quite high resolution" hatching rather than a handful of chunky diagonal
        // staircase steps; the coverage lookup below just maps each hatch pixel back down to
        // its data cell, so this costs more canvas fill calls but no extra coverage math.
        const HATCH_SCALE = 3;
        const hatchCols = cols * HATCH_SCALE;
        const hatchRows = rows * HATCH_SCALE;
        const LINE_SPACING = 5; // hatch-canvas px between diagonal line starts
        const LINE_WIDTH = 2;   // hatch-canvas px wide

        const hatchCanvas = document.createElement('canvas');
        hatchCanvas.width = hatchCols;
        hatchCanvas.height = hatchRows;
        const hctx = hatchCanvas.getContext('2d');
        hctx.fillStyle = 'rgba(43, 40, 35, 0.6)';
        for (let hr = 0; hr < hatchRows; hr++) {
          const r = Math.floor(hr / HATCH_SCALE);
          const covRow = upsampledCoverageRatioGrid[r];
          if (!covRow) continue;
          // Points where (hr + hc) is constant form a 45° diagonal; testing that sum modulo
          // a period draws repeating parallel diagonal bands with no separate pattern tile.
          for (let hc = 0; hc < hatchCols; hc++) {
            if ((hr + hc) % LINE_SPACING >= LINE_WIDTH) continue;
            const c = Math.floor(hc / HATCH_SCALE);
            const covRatio = covRow[c];
            // Below the confidence threshold — the slider value, read directly as a
            // percentile rank (see generateContourSurface()'s coverage block).
            if (covRatio === null || covRatio === undefined || covRatio >= coverageWeighting) continue;
            hctx.fillRect(hc, hatchRows - 1 - hr, 1, 1);
          }
        }
        this.coverageOverlay = L.imageOverlay(hatchCanvas.toDataURL(), imageBounds, {
          opacity: 1,
          interactive: false,
          className: 'collective-coverage-hatch'
        });
        if (this.showSurface) this.coverageOverlay.addTo(this.map);
      }
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
      const topoCfg = (typeof GSR_CONST !== 'undefined' && GSR_CONST.TOPOGRAPHY_SOURCES && GSR_CONST.TOPOGRAPHY_SOURCES[contourParams.topographySource]) || null;
      const unit = (topoCfg && topoCfg.unit !== undefined) ? topoCfg.unit : ' μS';

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
          weight: 0.75,
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

        // Aggregate layer (owned by GSRMapManager, not any single track) — tagged
        // so tests/exporter can tell it apart from per-track render layers.
        poly._gsrKind = 'contour';
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRMapManager, DERIVED_METRIC_SERIES };
}
if (typeof window !== 'undefined') {
  window.GSRMapManager = GSRMapManager;
}
