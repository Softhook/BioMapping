/**
 * Shared CARTO basemap helpers — the single source of truth for the raster
 * basemap URL, attribution and key resolution used by:
 *   GSRMapManager.initMap()        src/map/map.js
 *   initLiveMap()                  src/live/live_map.js
 *   BASEMAP_PROVIDERS              src/map/globe3d.js
 *
 * The key resolution (BIOMAP_CONFIG.cartoApiKey → localStorage → ?key=) was
 * previously copy-pasted into all three, with the drift hazard pinned by
 * tests/test_html_wiring.js. Loaded as a classic <script> before all three
 * consumers (see index.html / live.html's script list).
 */

export const CARTO_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>';

export const GSRBasemap = {
  /**
   * Resolve the CARTO key (config.local.js's BIOMAP_CONFIG.cartoApiKey, then
   * a guarded localStorage fallback) and build the {s}/{z}/{x}/{y} tile URL
   * template for a style slug (e.g. 'light_all', 'dark_all'). CARTO requires
   * a free key on its raster basemaps; without one the tiles still load but
   * carry an "API key required" watermark. localStorage access can throw
   * (file:// with site data disabled — live.html is opened that way), so it's
   * guarded.
   */
  cartoTileUrl(styleSlug) {
    let cartoKey = (typeof window !== 'undefined' && window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.cartoApiKey) || '';
    if (!cartoKey) {
      try { cartoKey = localStorage.getItem('bioMappingCartoApiKey') || ''; } catch (e) { /* no-op */ }
    }
    return `https://{s}.basemaps.cartocdn.com/${styleSlug}/{z}/{x}/{y}.png` +
      (cartoKey ? '?key=' + encodeURIComponent(cartoKey) : '');
  },

  /**
   * Raster tile options shared by the 2D map and the live follow-map. Fresh
   * object per call so callers can extend it (map.js adds crossOrigin).
   */
  tileOptions() {
    return { maxZoom: 22, maxNativeZoom: 19, attribution: CARTO_ATTRIBUTION };
  },
};
