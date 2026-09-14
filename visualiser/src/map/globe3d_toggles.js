/**
 * GSRGlobeManager — layer visibility toggles + entity clearing.
 * Prototype-augment split from globe3d.js: loaded after globe3d.js, adds
 * these methods to GSRGlobeManager.prototype.
 *
 * Mirrors the 2D map's show/clear surface (see map_manager_toggles.js /
 * map_manager_layers.js) for the 3D peak/hotspot/cluster/track layers.
 * clearAll() is the one teardown entry point a track switch or context loss
 * calls, and reaches across into the OSM/RF augment files' own clear methods.

 * Dual-mode export (like globe3d.js's own tail): under a browser <script> tag
 * or the shared vm context (tests/support/boot_app.js), GSRGlobeManager is a
 * live global and this assigns straight onto its prototype. Under plain
 * CommonJS require() (tests/test_globe3d.js's per-test isolation harness,
 * which requires globe3d.js fresh for each test instead of booting the whole
 * app), module.exports hands back the method object instead so the caller can
 * Object.assign it onto the freshly-required class itself.
 */
(function () {
  const __methods = {

  /**
   * Toggle 3D peak spires
   */
  togglePeaks(visible, minQuality = 0.0) {
    this.showPeaks = visible;
    this.minPeakQuality = minQuality;
    this.clearPeakEntities();
    if ((this.showPeaks || this.showLabels) && this.currentAnalyzer) {
      this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
    }
    this._requestRender();
  },

  /**
   * Toggle the floating peak labels. With spires off, this still keeps the
   * labelled peaks on screen (same as the 2D map's "Labels" toggle).
   */
  toggleLabels(visible) {
    this.showLabels = visible;
    this.clearPeakEntities();
    if ((this.showPeaks || this.showLabels) && this.currentAnalyzer) {
      this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
    }
    this._requestRender();
  },

  /**
   * Toggle the memorable-event hotspot markers (analyzer.memorableEvents).
   */
  toggleHotspots(visible) {
    this.showHotspots = visible;
    this.clearHotspotEntities();
    if (visible && this.currentAnalyzer) {
      this._renderHotspots(this.currentAnalyzer);
    }
    this._requestRender();
  },

  /**
   * Toggle the spatial-cluster ground blobs (hulls handed in by the 2D view via
   * renderData({ clusterPolygons })).
   */
  toggleClusters(visible) {
    this.showClusters = visible;
    this.clearClusterEntities();
    if (visible) this._renderClusterBlobs();
    this._clusterBlobSig = this._clusterBlobSignature(); // keep _syncClusterBlobs in step
    this._requestRender();
  },

  /**
   * Clear the batched wall primitive and the ground-path entity.
   */
  clearTrackEntities() {
    if (!this.viewer) return;
    if (this.wallPrimitive) {
      this.viewer.scene.primitives.remove(this.wallPrimitive);
      this.wallPrimitive = null;
    }
    this.trackEntities.forEach(ent => this.viewer.entities.remove(ent));
    this.trackEntities = [];
  },

  /**
   * Clear peak spire entities
   */
  clearPeakEntities() {
    if (this._peakPoints && typeof this._peakPoints.removeAll === 'function') {
      this._peakPoints.removeAll();
    }
    if (this._peakLabels && typeof this._peakLabels.removeAll === 'function') {
      this._peakLabels.removeAll();
    }
    if (this.viewer && this.viewer.entities && typeof this.viewer.entities.remove === 'function') {
      this.peakEntities.forEach(ent => {
        // The batched circle primitives are already gone via removeAll() above;
        // only the latency-connector entities need an explicit entity remove.
        if (ent && !ent._isPeakPointPrimitive) this.viewer.entities.remove(ent);
      });
    }
    this.peakEntities = [];
    // The focus-hidden circle (focusOnPeakLocation) is one of the entities just
    // removed — drop the stale ref so the next focus doesn't touch it.
    this._focusHiddenPeakPoint = null;
  },

  /** Clear the memorable-event hotspot entities. */
  clearHotspotEntities() {
    if (this._hotspotLabels && typeof this._hotspotLabels.removeAll === 'function') {
      this._hotspotLabels.removeAll();
    }
    if (this.viewer && this.viewer.entities && typeof this.viewer.entities.remove === 'function') {
      this.hotspotEntities.forEach(ent => {
        // Batched star labels are gone via removeAll() above; nothing else is
        // pushed here today, but guard the same way for the entity fallback.
        if (ent && !ent._isHotspotLabelPrimitive) this.viewer.entities.remove(ent);
      });
    }
    this.hotspotEntities = [];
  },

  /** Clear the spatial-cluster ground-blob entities. */
  clearClusterEntities() {
    if (!this.viewer) return;
    this.clusterEntities.forEach(ent => this.viewer.entities.remove(ent));
    this.clusterEntities = [];
  },

  /**
   * Clear all entities
   */
  clearAll() {
    this.clearTrackEntities();
    this.clearPeakEntities();
    this.clearHotspotEntities();
    this.clearClusterEntities();
    this.clearOsmBuildingEntities();
    this.clearRfEntities();
    this._clusterBlobSig = null; // force the next _syncClusterBlobs to rebuild
    if (this.scrubEntity) this.scrubEntity.show = false;
  }

  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = __methods;
  } else {
    Object.assign(GSRGlobeManager.prototype, __methods);
  }
})();
