/**
 * GSRMapManager — viewport / navigation. Prototype-augment split from map.js:
 * loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype.
 *
 * Auto-zoom-to-extent (_fitBounds / _flyOrFitBounds), the toolbar zoom/fit
 * buttons (zoomIn / zoomOut / fitToTrack), the graph-scrub position indicator
 * (setScrubPosition, moving this.scrubMarker), and _getTrackSetSignature (the
 * "did the active track set change" check the fit-bounds heuristic uses).
 *
 * Depends on the global L (resolved at call time).
 */
Object.assign(GSRMapManager.prototype, {

  _getTrackSetSignature(collectiveManager) {
    if (!collectiveManager) return '';
    const active = collectiveManager.getActiveTracks ? collectiveManager.getActiveTracks() : [];
    return active.map(t => t.id).sort().join(',');
  },

  _fitBounds(drawPoints, opts = {}) {
    if (!this.map || !drawPoints || drawPoints.length === 0) return;
    this._flyOrFitBounds(drawPoints.map(p => [p.lat, p.lon]), opts);
  },

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
  },

  /**
   * Zoom the map in by one level.
   */
  zoomIn() {
    if (this.map) {
      this.map.zoomIn();
    }
  },

  /**
   * Zoom the map out by one level.
   */
  zoomOut() {
    if (this.map) {
      this.map.zoomOut();
    }
  },

  /**
   * Zoom and pan the map to fit the current polyline track extent.
   */
  fitToTrack() {
    const paths = this.getRenderLayers().paths;
    if (this.map && paths.length > 0) {
      const group = new L.featureGroup(paths);
      this._flyOrFitBounds(group.getBounds());
    }
  },

  /**
   * Jump the map straight to a peak's location and park the scrub dot there.
   * Driven by the SCR Events table: a row click takes the user directly to the
   * spot, with no popup. Reuses the graph-scrub marker as the single "you are
   * here" indicator, so it shows even when the peak-marker layer is hidden (the
   * next graph hover repositions it). A bad index / NaN coords is a no-op.
   */
  focusOnPeakLocation(peakIdx, analyzer, gpsParams) {
    if (!this.map || !analyzer || !analyzer.peaks) return;
    const peak = analyzer.peaks[peakIdx];
    if (!peak) return;
    const peakLatency = (gpsParams && gpsParams.peakLatency) || 0;
    const coords = analyzer.getCoordinates(this._resolveLatencyIndex(analyzer, peak, peakLatency));
    if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;

    this.setScrubPosition(coords.lat, coords.lon, false);

    // Pan at the current zoom rather than flyTo(): a pure pan moves _mapPane by
    // one CSS transform, carrying every pane (base tiles, GSR path, and the RF
    // fluid canvas in rfFluidPane) in lockstep. flyTo()'s zoom-flight animation
    // drives a per-frame _move() loop that never fires zoomanim/moveend, so the
    // RF surface — which only re-anchors on those — visibly lags the track and
    // snaps into place at the end.
    const latlng = [coords.lat, coords.lon];
    if (typeof this.map.panTo === 'function') {
      this.map.panTo(latlng, { animate: true, duration: 0.6, easeLinearity: 0.25 });
    } else {
      this.map.setView(latlng, this.map.getZoom());
    }
  },

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

});
