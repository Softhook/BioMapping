/**
 * GSRMapManager — single-track render orchestration. Prototype-augment split
 * from map.js: loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype.
 *
 * renderData() is the full single-track rebuild: clear, resolve the active
 * track's layerGroup, run the GPS pipeline, draw path + peak + hotspot layers
 * (via the map_manager_path.js / map_manager_peaks.js methods), fit the
 * viewport on a track change, emit 'map:rendered'. refreshPeakMarkers() /
 * refreshPath() are the partial re-renders (label edit, colour-metric change)
 * that strip one kind-family and re-run a single renderer via
 * _refreshTrackLayers() / _stripOwnedLayersByKind(); both fall back to a full
 * renderData() when there is no managed track.
 *
 * Depends on the global AppState (resolved at call time); everything else it
 * calls is another GSRMapManager prototype method.
 */
Object.assign(GSRMapManager.prototype, {

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
  },

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
  },

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
  },

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
  },

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

});
