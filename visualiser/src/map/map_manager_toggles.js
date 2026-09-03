/**
 * GSRMapManager — layer visibility toggles. Prototype-augment split from
 * map.js: loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype. They own the show/hide state
 * (this.showPeaks / showLabels / showHotspots / showClusters / showIsolines /
 * showSurface / showTracks) and drive Leaflet layer inclusion + the
 * .hide-map-* CSS classes on the map container.
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Toggle the visibility of the stress peak markers on the map layer.
   */
  togglePeaks(visible) {
    this.showPeaks = visible;
    this.updateMarkerVisibility();
  },

  /**
   * Toggle the visibility of the stress peak labels (text) on the map layer.
   */
  toggleLabels(visible) {
    this.showLabels = visible;
    this.updateMarkerVisibility();
  },

  /**
   * Toggle the visibility of the hotspot (memorable-event) markers on the map layer.
   */
  toggleHotspots(visible) {
    this.showHotspots = visible;
    this.updateMarkerVisibility();
  },

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

    // Phase 1 (slice 1/2): markers owned by a track's layerGroup are toggled
    // through that group (child in/out of the group — the group is on the map,
    // so the marker appears/disappears with it). Collective markers now live in
    // per-track groups too; any layer without a group (legacy) is toggled
    // directly against the map.
    // Phase 1 (slice 3): the per-track flat arrays are gone — markers are owned
    // by each track's layerGroup. Toggle every rendered track's layers by role
    // (from the full registry, so hidden layers can be restored).
    const allMarkers = [];
    const allHotspotMarkers = [];
    for (const m of this._allTrackLayers()) {
      const kind = m._gsrKind;
      if (kind === 'peak' || kind === 'connector' || kind === 'collectivePeak' || kind === 'collectiveConnector') {
        allMarkers.push(m);
      } else if (kind === 'hotspot') {
        allHotspotMarkers.push(m);
      }
    }
    allMarkers.forEach(m => {
      this._toggleLayer(m, this.showPeaks || (this.showLabels && m.hasLabel));
    });
    allHotspotMarkers.forEach(m => {
      this._toggleLayer(m, this.showHotspots);
    });
  },

  /**
   * Phase 1 (slice 1/2): show/hide a single layer. If the layer is owned by a
   * track's layerGroup, toggle it in/out of that group (the group is on the
   * map, so the layer follows). Layers without a group (legacy direct-add) are
   * toggled against the map directly.
   * @private
   */
  _toggleLayer(m, show) {
    const group = m._gsrLayerGroup;
    if (group) {
      if (show) {
        if (!group.hasLayer(m)) group.addLayer(m);
      } else {
        if (group.hasLayer(m)) group.removeLayer(m);
      }
    } else if (show) {
      if (!this.map.hasLayer(m)) m.addTo(this.map);
    } else {
      if (this.map.hasLayer(m)) this.map.removeLayer(m);
    }
  },

  /**
   * Toggle the visibility of the stress peak clusters on the map layer.
   */
  toggleClusters(visible) {
    this.showClusters = visible;
    this.clusterLayers.forEach(m => this._toggleLayer(m, visible));
  },

  /**
   * Toggle the visibility of the collective topographic isoline (contour line) layer.
   */
  toggleIsolines(visible) {
    this.showIsolines = visible;
    this.contourLayers.forEach(m => this._toggleLayer(m, visible));
  },

  /**
   * Toggle the visibility of the collective shaded surface overlay.
   */
  toggleSurface(visible) {
    this.showSurface = visible;
    if (this.surfaceOverlay) {
      if (visible) {
        if (!this.map.hasLayer(this.surfaceOverlay)) this.surfaceOverlay.addTo(this.map);
      } else {
        if (this.map.hasLayer(this.surfaceOverlay)) this.map.removeLayer(this.surfaceOverlay);
      }
    }
    if (this.coverageOverlay) {
      if (visible) {
        if (!this.map.hasLayer(this.coverageOverlay)) this.coverageOverlay.addTo(this.map);
      } else {
        if (this.map.hasLayer(this.coverageOverlay)) this.map.removeLayer(this.coverageOverlay);
      }
    }
  },

  /**
   * Toggle the visibility of the individual track polylines drawn in collective mode.
   */
  toggleTracks(visible) {
    this.showTracks = visible;
    // Phase 1 (slice 3): the GPS "Tracks" toggle controls the COLLECTIVE track
    // paths (which live inside each track's layerGroup); iterate the full
    // registry rather than a flat array so paths can be restored after being
    // hidden. The single-track path ('path') is deliberately NOT toggled — it
    // always renders in single-track mode (it is the active track's essential
    // data view, and the Tracks button is hidden there anyway).
    for (const m of this._allTrackLayers()) {
      if (m._gsrKind === 'collectivePath') this._toggleLayer(m, visible);
    }
  }

});
