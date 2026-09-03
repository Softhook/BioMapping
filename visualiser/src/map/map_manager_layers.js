/**
 * GSRMapManager — per-track layer ownership + map teardown. Prototype-augment
 * split from map.js: loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype.
 *
 * The Phase 1 ownership model: every render layer belongs to its track's
 * L.layerGroup (this._getTrackLayerGroup), and the full set — visible AND
 * hidden — is recorded in track._ownedLayers so visibility toggles can restore
 * hidden ones (layers rendered outside any track fall back to
 * this._unownedLayers). this._renderedTrackGroups tracks which groups this
 * manager put on the map so clearMap() can remove exactly those, even a track
 * that has since left the collective manager. getRenderLayers() /
 * getPeakMarkerByIndex() are the read side used by the SVG exporter,
 * fitToTrack() and focusOnPeak(). clearMap() / clearAll() are the teardown
 * entry points.
 *
 * Depends on the global L, and (via the prototype) clearOsmShapes /
 * _clearRfFluid / updateLegend / clearCollectiveLayers from the other augments.
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Remove all layers in the array from the map and clear the array.
   */
  _clearLayerGroup(arr) {
    if (!this.map) return;
    if (arr) arr.forEach(item => this.map.removeLayer(item));
    return [];
  },

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
  },

  /**
   * Phase 1 (slice 2): forget a track's rendered group without touching the
   * map (used by deleteTrack after it has already removed the group).
   * @private
   */
  _forgetTrackGroup(trackId) {
    this._renderedTrackGroups.delete(trackId);
  },

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
  },

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
  },

  /**
   * Phase 1 (slice 3): record a layer as owned by a track (or, in the legacy
   * no-track fallback, by this manager) so visibility toggles can find ALL
   * created layers — the layerGroup only holds the currently-visible ones.
   * @private
   */
  _registerTrackLayer(track, layer) {
    if (track && track._ownedLayers) track._ownedLayers.push(layer);
    else this._unownedLayers.push(layer);
  },

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
  },

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
  },

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

    // The SCR-table locator dot (focusOnPeakLocation) is placed straight on
    // the map, outside any track group — drop it on a rebuild like scrubMarker.
    if (this._peakFocusMarker && this.map.hasLayer(this._peakFocusMarker)) {
      this.map.removeLayer(this._peakFocusMarker);
    }

    this._clearRfFluid();

    // Reset legend
    this._legendMinVal = 0;
    this._legendMaxVal = 0;
    this._legendUniqueVals = null;
    this.hasRfData = false;
    this.updateLegend();
  },

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

});
