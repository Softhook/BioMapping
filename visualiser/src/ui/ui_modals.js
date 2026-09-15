/**
 * GSRUI — modal dialogs. Object-augment split from ui.js: loaded
 * immediately after ui.js, adds these methods to the shared GSRUI object.
 *
 * Covers the Street View modal (tabbed embed + API key entry) and the
 * export-preset save modal.
 */
(function () {
const __methods = {

  /**
   * Open the street-level imagery modal overlay at the given coordinates.
   * Shows Mapillary by default; Google Street View embed if API key is set.
   */
  openStreetView(lat, lon, label, heading) {
    const modal = document.getElementById('streetviewModal');
    const mapillaryIframe = document.getElementById('svIframe');
    const googleIframe = document.getElementById('svGoogleIframe');
    const googleLink = document.getElementById('svGoogleLink');
    const mapillaryExtLink = document.getElementById('svMapillaryExtLink');
    const coordsEl = document.getElementById('svModalCoords');
    const titleEl = document.getElementById('streetviewModalTitle');

    if (!modal || !mapillaryIframe) return;

    // Resolve heading defensively to a finite number
    let cleanHeading = 0;
    if (typeof heading === 'number' && !isNaN(heading) && isFinite(heading)) {
      cleanHeading = heading;
    } else if (typeof heading === 'string') {
      const parsed = parseFloat(heading);
      if (!isNaN(parsed) && isFinite(parsed)) cleanHeading = parsed;
    }

    // Store coords and heading for tab switching
    this._svLat = lat;
    this._svLon = lon;
    this._svHeading = cleanHeading;

    titleEl.textContent = label ? 'Street-Level View — ' + label : 'Street-Level View';
    coordsEl.textContent = lat.toFixed(5) + ', ' + lon.toFixed(5);

    // Set Mapillary embed URL
    mapillaryIframe.src = 'https://www.mapillary.com/embed?lat=' + lat + '&lng=' + lon + '&z=18';

    // Set Google Maps external link (fallback) using viewpoint API to support heading orientation
    googleLink.href = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + lat + ',' + lon + '&heading=' + cleanHeading.toFixed(0);

    // Set Mapillary external link
    mapillaryExtLink.href = 'https://www.mapillary.com/app/?lat=' + lat + '&lng=' + lon + '&z=18';

    // Show the modal first so that the browser does not pause/optimise away the iframe loading
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Set Mapillary embed URL (now loaded while modal is visible)
    mapillaryIframe.src = 'https://www.mapillary.com/embed?lat=' + lat + '&lng=' + lon + '&z=18';

    // Reset Google iframe
    if (googleIframe) googleIframe.src = '';

    // Start on Google tab (left)
    GSRUI.switchStreetViewTab('google');

    // Restore saved API key into input field
    const keyInput = document.getElementById('svApiKeyInput');
    const savedKey = localStorage.getItem('bioMappingGoogleMapsKey');
    if (keyInput && savedKey) {
      keyInput.value = savedKey;
    }
  },

  /**
   * Close the street-level imagery modal overlay.
   * If event is provided (click on overlay background), only close if clicking the backdrop.
   */
  closeStreetViewModal(event) {
    if (event && event.target !== document.getElementById('streetviewModal')) return;
    const modal = document.getElementById('streetviewModal');
    const mapillaryIframe = document.getElementById('svIframe');
    const googleIframe = document.getElementById('svGoogleIframe');
    if (modal) modal.style.display = 'none';
    if (mapillaryIframe) mapillaryIframe.src = '';
    if (googleIframe) googleIframe.src = '';
    this._svLat = null;
    this._svLon = null;
    this._svHeading = null;
    document.body.style.overflow = '';
  },

  /**
   * Switch between Mapillary (embedded) and Google Street View tabs.
   * If a Google Maps API key is saved, embeds Street View via the free Maps Embed API.
   */
  switchStreetViewTab(tab) {
    const mapillaryTab = document.getElementById('svTabMapillary');
    const googleTab = document.getElementById('svTabGoogle');
    const iframeContainer = document.getElementById('svIframeContainer');
    const googleContainer = document.getElementById('svGoogleContainer');
    const googleIframeContainer = document.getElementById('svGoogleIframeContainer');
    const googleIframe = document.getElementById('svGoogleIframe');
    const googleFallback = document.getElementById('svGoogleFallback');

    mapillaryTab.classList.toggle('active', tab === 'mapillary');
    googleTab.classList.toggle('active', tab === 'google');
    iframeContainer.style.display = tab === 'mapillary' ? '' : 'none';
    googleContainer.style.display = tab === 'google' ? '' : 'none';

    if (tab === 'google' && this._svLat != null && this._svLon != null) {
      const apiKey = localStorage.getItem('bioMappingGoogleMapsKey');
      if (apiKey) {
        googleIframeContainer.style.display = '';
        googleFallback.style.display = 'none';

        let cleanHeading = 0;
        if (typeof this._svHeading === 'number' && !isNaN(this._svHeading) && isFinite(this._svHeading)) {
          cleanHeading = this._svHeading;
        }

        const embedUrl = 'https://www.google.com/maps/embed/v1/streetview?key=' + encodeURIComponent(apiKey)
          + '&location=' + this._svLat + ',' + this._svLon + '&heading=' + cleanHeading.toFixed(0) + '&pitch=0&fov=90';
        
        // Defer setting the source to allow the browser layout engine to paint
        // the newly visible iframe container first. This resolves lazy-loading deferrals in modern browsers.
        setTimeout(() => {
          googleIframe.src = embedUrl;
        }, 0);
      } else {
        googleIframeContainer.style.display = 'none';
        googleFallback.style.display = '';
        googleIframe.src = '';
      }
    }
  },

  /**
   * Save the Google Maps API key from the input field to localStorage.
   */
  saveGoogleMapsKey() {
    const input = document.getElementById('svApiKeyInput');
    const msg = document.getElementById('svKeySavedMsg');
    if (!input) return;
    const key = input.value.trim();
    if (key) {
      localStorage.setItem('bioMappingGoogleMapsKey', key);
      if (msg) {
        msg.style.display = '';
        setTimeout(function() { msg.style.display = 'none'; }, 3000);
      }
    }
  },

  /**
   * Open the Export Preset Save Menu Modal Overlay.
   */
  openExportPresetModal(defaultName) {
    const modal = document.getElementById('exportPresetModal');
    const input = document.getElementById('presetFileNameInput');
    const summary = document.getElementById('presetModalSummary');
    if (!modal) return;

    if (input) {
      const activeTrack = AppState.activeTrackId ? AppState.collectiveManager.getTrack(AppState.activeTrackId) : null;
      input.value = defaultName || (activeTrack ? activeTrack.name.replace(/\.[^/.]+$/, "") : "custom_preset");
    }

    if (summary && typeof GSRStorage !== 'undefined') {
      const gsr = GSRStorage.readGsrSliderValues() || {};
      const gps = GSRStorage.readGpsSliderValues() || {};
      const detectorStr = gsr.useCvxEDA ? 'cvxEDA' : (gsr.useSparsEDA ? 'SparsEDA' : (gsr.useDeconvolution ? 'Deconv (MP)' : (gsr.usePeakProminence ? 'Prominence' : 'Default')));
      summary.innerHTML = `
        <strong>Active Preset Parameters to Export:</strong><br>
        • <strong>GSR:</strong> Median size=${gsr.medianSize}s, LPF window=${gsr.lpfWindow}s, Baseline=${gsr.tonicMethod} (${gsr.tonicWindow}s), Peak threshold=${gsr.peakThreshold}μS, Detector=${detectorStr}<br>
        • <strong>GPS:</strong> Smoothing=${gps.smoothing}, Kalman R=${gps.kalmanR}, Max HDOP=${gps.maxHdop}, Peak latency=${gps.peakLatency}s
      `;
    }

    modal.style.display = 'flex';
  },

  closeExportPresetModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('exportPresetModal');
    if (modal) modal.style.display = 'none';
  },

  confirmExportPreset() {
    const input = document.getElementById('presetFileNameInput');
    const name = input ? input.value.trim() || 'preset' : 'preset';
    const gsr = GSRStorage.readGsrSliderValues();
    const gps = GSRStorage.readGpsSliderValues();
    if (!gsr || !gps) return;
    const preset = {
      type: "BioMappingPreset",
      version: 1,
      name: name,
      exportedAt: new Date().toISOString(),
      gsr: gsr,
      gps: gps,
      contour: GSRStorage.readContourSliderValues()
    };
    GSRStorage.downloadPresetJson(preset, name);
    this.closeExportPresetModal();
  },

};

if (typeof module !== 'undefined' && module.exports) {
  Object.assign(global, require('./ui.mjs'));
  module.exports = __methods;
} else {
  Object.assign(GSRUI, __methods);
}
})();
