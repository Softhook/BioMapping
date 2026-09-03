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

  // The map legend (_initLegend / updateLegend / buildLegendHtml) is split out
  // into map_manager_legend.js — a prototype augment loaded right after this
  // file. buildLegendHtml() is also called by globe3d_view.js so the 3D globe
  // shows the identical legend.

  /**
   * Remove all layers in the array from the map and clear the array.
   */
  _clearLayerGroup(arr) {
    if (!this.map) return;
    if (arr) arr.forEach(item => this.map.removeLayer(item));
    return [];
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

  _getMetricKey(metric) {
    // OSM entries (roadClass..amenityCount) come from the shared
    // GSR_CONST.OSM_METRICS table (constants.js) — map_manager_legend.js's
    // metricNames is the other consumer of that same table.
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

  // OSM vector overlays (drawOsmShapes / clearOsmShapes) are split out into
  // map_manager_osm.js — a prototype augment loaded right after this file.

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

  // GSRMapManager is completed by prototype-augment files loaded immediately
  // after this one (see index.html / boot_app.js SCRIPT_ORDER):
  //   map_manager_process.js   — GPS pipeline → drawPoints + cache
  //   map_manager_legend.js    — the bottom-right legend
  //   map_manager_osm.js       — OSM vector overlays
  //   map_manager_rf_fluid.js  — RF Fluid overlay control
  //   map_manager_viewport.js  — fit/zoom/scrub navigation
  //   map_manager_peaks.js     — peak / hotspot / cluster marker rendering
  //   map_manager_collective.js— collective / multi-track view + contours
  //   map_manager_toggles.js   — layer visibility toggles
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRMapManager, DERIVED_METRIC_SERIES };
}
if (typeof window !== 'undefined') {
  window.GSRMapManager = GSRMapManager;
}
