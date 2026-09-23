/**
 * GSRUI — modal dialogs. Service object spread into GSRUI (ui.mjs), so `this`
 * is GSRUI at call time. The Escape/backdrop/button listeners live in
 * events_modals.mjs.
 *
 * Covers the Street View modal (tabbed embed + API key entry).
 */
import { SafeStorage } from '../core/safe_storage.mjs';

export const ModalsUI = {
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

    titleEl.textContent = label
      ? `Street-Level View — ${label}`
      : 'Street-Level View';
    coordsEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    // Set Mapillary embed URL
    mapillaryIframe.src = `https://www.mapillary.com/embed?lat=${lat}&lng=${lon}&z=18`;

    // Set Google Maps external link (fallback) using viewpoint API to support heading orientation
    googleLink.href =
      'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' +
      lat +
      ',' +
      lon +
      '&heading=' +
      cleanHeading.toFixed(0);

    // Set Mapillary external link
    mapillaryExtLink.href = `https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=18`;

    // Show the modal first so that the browser does not pause/optimise away the iframe loading
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Set Mapillary embed URL (now loaded while modal is visible)
    mapillaryIframe.src = `https://www.mapillary.com/embed?lat=${lat}&lng=${lon}&z=18`;

    // Reset Google iframe
    if (googleIframe) googleIframe.src = '';

    // Start on Google tab (left)
    this.switchStreetViewTab('google');

    // Restore saved API key into input field
    const keyInput = document.getElementById('svApiKeyInput');
    const savedKey = SafeStorage.get('bioMappingGoogleMapsKey');
    if (keyInput && savedKey) {
      keyInput.value = savedKey;
    }
  },

  /**
   * Close the street-level imagery modal overlay.
   * If event is provided (click on overlay background), only close if clicking the backdrop.
   */
  closeStreetViewModal(event) {
    if (event && event.target !== document.getElementById('streetviewModal'))
      return;
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
    const googleIframeContainer = document.getElementById(
      'svGoogleIframeContainer',
    );
    const googleIframe = document.getElementById('svGoogleIframe');
    const googleFallback = document.getElementById('svGoogleFallback');

    mapillaryTab.classList.toggle('active', tab === 'mapillary');
    googleTab.classList.toggle('active', tab === 'google');
    iframeContainer.style.display = tab === 'mapillary' ? '' : 'none';
    googleContainer.style.display = tab === 'google' ? '' : 'none';

    if (tab === 'google' && this._svLat != null && this._svLon != null) {
      const apiKey = SafeStorage.get('bioMappingGoogleMapsKey');
      if (apiKey) {
        googleIframeContainer.style.display = '';
        googleFallback.style.display = 'none';

        let cleanHeading = 0;
        if (
          typeof this._svHeading === 'number' &&
          !isNaN(this._svHeading) &&
          isFinite(this._svHeading)
        ) {
          cleanHeading = this._svHeading;
        }

        const embedUrl =
          'https://www.google.com/maps/embed/v1/streetview?key=' +
          encodeURIComponent(apiKey) +
          '&location=' +
          this._svLat +
          ',' +
          this._svLon +
          '&heading=' +
          cleanHeading.toFixed(0) +
          '&pitch=0&fov=90';

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
      SafeStorage.set('bioMappingGoogleMapsKey', key);
      if (msg) {
        msg.style.display = '';
        setTimeout(() => {
          msg.style.display = 'none';
        }, 3000);
      }
    }
  },
};
