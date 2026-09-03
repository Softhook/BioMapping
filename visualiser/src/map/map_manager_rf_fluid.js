/**
 * GSRMapManager — RF Fluid overlay control. Prototype-augment split from map.js:
 * loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype.
 *
 * Thin control surface over this.rfFluidRenderer (RFFluidRenderer) plus the
 * #btnToggleRFFluid / #rfFluidMode DOM controls: blank the canvas on clear,
 * enable/disable + re-sync the button for the active view, and the four
 * show/mode/opacity/radius setters the UI calls. Own the show/hide state
 * (this.showRFFluid / this.hasRfData). updateLegend() lives in
 * map_manager_legend.js (resolved via the prototype).
 */
Object.assign(GSRMapManager.prototype, {

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
  },

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
  },

  toggleRFFluid(show) {
    this.showRFFluid = (show !== undefined) ? show : !this.showRFFluid;
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setVisible(this.showRFFluid);
    }
    this.updateLegend();
    return this.showRFFluid;
  },

  setRFFluidMode(mode) {
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setMode(mode);
    }
    this.updateLegend();
  },

  setRFFluidOpacity(opacity) {
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setOpacity(opacity);
    }
  },

  setRFFluidRadius(radius) {
    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setRadius(radius);
    }
  }

});
