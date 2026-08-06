/**
 * GSRLayoutManager
 * Centralized manager for window sizing, ResizeObservers, and panel/browser fullscreen overlays.
 */
const GSRLayoutManager = {
  // Active panel-fullscreen exit callbacks
  _activePanelExits: new Set(),
  _canvasObserver: null,
  _mapObserver: null,
  _regressionObserver: null,

  /**
   * Cross-browser Fullscreen API helpers.
   */
  Fullscreen: {
    get active() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
    },
    request(el) {
      const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
      if (fn) return fn.call(el).catch(() => {});
      return null;
    },
    exit() {
      const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
      if (fn) return fn.call(document).catch(() => {});
      return null;
    },
    onChange(fn) {
      document.addEventListener('fullscreenchange', fn);
      document.addEventListener('webkitfullscreenchange', fn);
      document.addEventListener('mozfullscreenchange', fn);
    }
  },

  /**
   * Initialize layout observers and event listeners.
   */
  init() {
    this.setupResizeObservers();
    this.setupBrowserFullscreen();
    this.setupPanelFullscreen('btnGsrFullscreen', 'gsrPanel');
    this.setupPanelFullscreen('btnMapFullscreen', 'mapPanel', (isFs) => {
      AppState.isMapFullscreen = isFs;
    });
    this.setupPanelFullscreen('btnEventsFullscreen', 'eventsPanel');
    this.setupPanelFullscreen('btnEnvFullscreen', 'environmentalPanel');
  },

  /**
   * Set up ResizeObservers for dynamic container layout tracking.
   */
  setupResizeObservers() {
    const canvasContainer = document.getElementById('canvasContainer');
    if (canvasContainer) {
      this._canvasObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
          const w = entry.contentRect.width;
          const h = entry.contentRect.height;
          this.resizeCanvas(w, h);
        }
      });
      this._canvasObserver.observe(canvasContainer);
    }

    const mapElement = document.getElementById('map');
    if (mapElement) {
      this._mapObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
          const w = entry.contentRect.width;
          const h = entry.contentRect.height;
          this.resizeMap(w, h);
        }
      });
      this._mapObserver.observe(mapElement);
    }

    const regressionContainer = document.querySelector('.regression-chart-container');
    if (regressionContainer) {
      this._regressionObserver = new ResizeObserver(() => {
        if (typeof GSRUI !== 'undefined' && typeof GSRUI.drawRegressionScatterPlot === 'function') {
          GSRUI.drawRegressionScatterPlot();
        }
      });
      this._regressionObserver.observe(regressionContainer);
    }
  },

  /**
   * Resize the p5.js canvas container.
   */
  resizeCanvas(w, h) {
    if (w > 0 && h > 0 && typeof resizeCanvas === 'function') {
      GSRRenderer.clearThemeCache();
      resizeCanvas(w, h);
      redraw();
    }
  },

  /**
   * Trigger Leaflet map container layout update.
   */
  resizeMap(w, h) {
    if (w > 0 && h > 0 && AppState.mapManager && AppState.mapManager.map) {
      AppState.mapManager.map.invalidateSize();
    }
  },

  /**
   * Bind browser fullscreen button triggers.
   */
  setupBrowserFullscreen() {
    const btn = document.getElementById('btnFullscreen');
    const el = document.querySelector('.app-container');
    if (!btn || !el) return;

    const toggleIcon = (fs) => {
      const ic = btn.querySelector('i');
      if (ic) ic.className = fs ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
      btn.classList.toggle('is-fullscreen', fs);
      AppState.isBrowserFullscreen = fs;
    };

    btn.addEventListener('click', () => {
      if (this.Fullscreen.active) {
        this.Fullscreen.exit();
      } else {
        // Exit any individual panel fullscreen states first
        this.exitAllPanelFullscreen();
        this.Fullscreen.request(el);
      }
    });

    this.Fullscreen.onChange(() => toggleIcon(this.Fullscreen.active));

    // Keyboard shortcut F/f to toggle browser fullscreen
    document.addEventListener('keydown', (e) => {
      if (e.key === 'f' || e.key === 'F') {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        btn.click();
      }
    });
  },

  /**
   * Bind specific section panel fullscreen modes.
   */
  setupPanelFullscreen(btnId, panelId, onStateChange) {
    const btn   = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) return;

    let overlay = null;
    let marker  = null;
    let isFs    = false;

    const getOverlayParent = () => {
      const fsEl = document.querySelector('.app-container');
      return (this.Fullscreen.active && fsEl) ? fsEl : document.body;
    };

    const enter = () => {
      isFs = true;
      btn.classList.add('is-fullscreen');
      const icon = btn.querySelector('i');
      if (icon) icon.classList.replace('fa-expand', 'fa-compress');

      if (panel.classList.contains('collapsed')) {
        panel.classList.remove('collapsed');
      }

      // Create a zero-space DOM comment marker to remember the original sibling position
      marker = document.createComment(`panel-fs-${panelId}`);
      panel.parentNode.insertBefore(marker, panel);

      overlay = document.createElement('div');
      overlay.className = 'panel-fullscreen-overlay';
      overlay.appendChild(panel);
      getOverlayParent().appendChild(overlay);

      this._activePanelExits.add(exit);
      if (onStateChange) onStateChange(true);
    };

    const exit = () => {
      if (!isFs) return;
      isFs = false;
      btn.classList.remove('is-fullscreen');
      const icon = btn.querySelector('i');
      if (icon) icon.classList.replace('fa-compress', 'fa-expand');

      if (marker && marker.parentNode) {
        marker.parentNode.insertBefore(panel, marker);
        marker.remove();
        marker = null;
      }

      if (overlay && overlay.parentNode) {
        overlay.remove();
        overlay = null;
      }

      this._activePanelExits.delete(exit);
      if (onStateChange) onStateChange(false);
    };

    btn.addEventListener('click', () => {
      if (isFs) exit();
      else enter();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isFs) {
        e.preventDefault();
        exit();
      }
    });
  },

  /**
   * Helper to close all panel-level fullscreens before browser fullscreen transition.
   */
  exitAllPanelFullscreen() {
    this._activePanelExits.forEach((exitFn) => exitFn());
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRLayoutManager };
}
if (typeof window !== 'undefined') {
  window.GSRLayoutManager = GSRLayoutManager;
}
