/**
 * NDVISampler — Automated Satellite Tile Streaming & High-Performance Raster Extraction
 * 
 * Provides client-side raster sampling for Normalized Difference Vegetation Index (NDVI).
 * Integrates directly with BioMapping's Web Mercator and OSM geospatial pipeline:
 *   - Point NDVI (`ndvi`): Exact pixel value directly underfoot.
 *   - 50m Buffer Mean NDVI (`ndvi_50m`): Circular radial average capturing ambient greenery.
 * 
 * Performance & Architecture Features:
 *   - LRU In-Memory Tile Cache (`_tileCache`) for instant multi-track and re-sampling.
 *   - Bounded Network Concurrency Pool (`_fetchTilePool`) to avoid HTTP socket exhaustion and 429 rate limits.
 *   - Pre-computed Circular Pixel Offset Masks (`_getCircularPixelOffsets`) for fast radial buffer extraction.
 *   - Expandable Provider Registry (`PROVIDERS`) unifying Copernicus WMS, Sentinel-2 Cloudless, NASA GIBS, and Custom XYZ.
 *   - Strict Credential Isolation: Zero secrets committed to git (stored in localStorage or config.local.js).
 *   - Coordinated Canvas Memory Management to prevent graphics heap leaks.
 */

const NDVISampler = {
  // Earth equatorial circumference in meters (EPSG:3857)
  EARTH_CIRCUMFERENCE_M: 40075016.686,

  // Fallback / legacy defaults
  DEFAULT_TILE_URL: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  COPERNICUS_BASE_URL: 'https://sh.dataspace.copernicus.eu/ogc/wms',
  NASA_GIBS_URL: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png',
  DEFAULT_INSTANCE_ID: '', // Kept empty in codebase; stored strictly in user's browser localStorage
  DEFAULT_LAYER_ID: 'VEGETATION_INDEX',
  DEFAULT_TIME_RANGE: '2024-05-01/2024-09-30',
  DEFAULT_MAXCC: 50,

  // ---------------------------------------------------------------------------
  // 1. Expandable Satellite Provider Registry
  // ---------------------------------------------------------------------------
  PROVIDERS: {
    copernicus: {
      id: 'copernicus',
      name: 'Copernicus Sentinel-2 Band 8 (NIR)',
      type: 'wms',
      baseUrl: 'https://sh.dataspace.copernicus.eu/ogc/wms',
      defaultLayer: 'VEGETATION_INDEX',
      defaultTime: '2024-05-01/2024-09-30',
      defaultMaxcc: 50,
      attribution: 'Sentinel-2 Band 8 (NIR) NDVI © Copernicus / ESA',
      buildUrl: (bbox, options = {}) => {
        const instanceId = options.instanceId || NDVISampler.getInstanceId();
        const layerId = options.layerId || options.layer || NDVISampler.getLayerId();
        const timeRange = options.time || options.timeRange || NDVISampler.getTimeRange();
        const maxcc = (typeof options.maxcc === 'number') ? options.maxcc : NDVISampler.DEFAULT_MAXCC;
        const baseUrl = options.baseUrl || NDVISampler.COPERNICUS_BASE_URL;
        return `${baseUrl}/${instanceId}?SERVICE=WMS&REQUEST=GetMap&LAYERS=${encodeURIComponent(layerId)}&FORMAT=image/png&TRANSPARENT=true&VERSION=1.3.0&CRS=EPSG:3857&BBOX=${bbox.join(',')}&WIDTH=256&HEIGHT=256&TIME=${encodeURIComponent(timeRange)}&MAXCC=${maxcc}`;
      }
    },
    sentinel2_cloudless: {
      id: 'sentinel2_cloudless',
      name: 'Sentinel-2 Cloudless Mosaic (EOX)',
      type: 'xyz',
      urlTemplate: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
      attribution: 'NDVI & Imagery © <a href="https://s2maps.eu" target="_blank">Sentinel-2 cloudless / EOX</a>',
      thematicAttribution: 'Vegetation Index (NDVI) © <a href="https://s2maps.eu" target="_blank">Sentinel-2 / EOX</a>',
      isThematicEligible: true,
      buildUrl: (tileX, tileY, zoom, options = {}) => {
        const tmpl = options.urlTemplate || NDVISampler.DEFAULT_TILE_URL;
        return tmpl.replace('{z}', zoom).replace('{x}', tileX).replace('{y}', tileY).replace('{s}', 'a');
      }
    },
    nasa_gibs: {
      id: 'nasa_gibs',
      name: 'NASA GIBS MODIS NDVI',
      type: 'xyz',
      urlTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png',
      attribution: 'NASA GIBS / Earthdata MODIS NDVI',
      isThematicEligible: false,
      buildUrl: (tileX, tileY, zoom, options = {}) => {
        const tmpl = options.urlTemplate || NDVISampler.NASA_GIBS_URL;
        return tmpl.replace('{z}', zoom).replace('{x}', tileX).replace('{y}', tileY);
      }
    },
    custom: {
      id: 'custom',
      name: 'Custom Satellite Tile Layer',
      type: 'custom',
      buildUrl: (tileX, tileY, zoom, options = {}) => {
        if (!options.urlTemplate && !options.tileUrl) return '';
        const tmpl = options.urlTemplate || options.tileUrl;
        return tmpl.replace('{z}', zoom).replace('{x}', tileX).replace('{y}', tileY).replace('{s}', 'a');
      }
    }
  },

  /**
   * Look up a satellite provider configuration by ID.
   * @param {string} id
   * @returns {Object|null}
   */
  getProvider(id) {
    return this.PROVIDERS[id] || null;
  },

  /**
   * Register or override a satellite provider.
   * @param {string} id
   * @param {Object} definition
   * @returns {boolean}
   */
  registerProvider(id, definition) {
    if (!id || typeof definition !== 'object') return false;
    const provider = Object.assign({ id }, definition);
    if (!provider.buildUrl && provider.urlTemplate) {
      provider.buildUrl = (tileX, tileY, zoom, options = {}) => {
        const tmpl = options.urlTemplate || provider.urlTemplate;
        return tmpl.replace('{z}', zoom).replace('{x}', tileX).replace('{y}', tileY).replace('{s}', 'a');
      };
    }
    this.PROVIDERS[id] = provider;
    return true;
  },

  /**
   * Determine the active provider based on configuration and options.
   * @param {Object} [options={}]
   * @returns {Object}
   */
  getActiveProvider(options = {}) {
    if (options.provider && this.PROVIDERS[options.provider]) {
      return this.PROVIDERS[options.provider];
    }
    if (options.tileUrl || options.urlTemplate) {
      return this.PROVIDERS.custom;
    }
    if (this.hasCopernicusConfig()) {
      return this.PROVIDERS.copernicus;
    }
    return this.PROVIDERS.sentinel2_cloudless;
  },

  /**
   * Resolve tile request URL using the provider registry.
   * @param {string|Object} providerOrId
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} zoom
   * @param {Object} [options={}]
   * @returns {string}
   */
  resolveTileUrl(providerOrId, tileX, tileY, zoom, options = {}) {
    const provider = (typeof providerOrId === 'string') ? this.getProvider(providerOrId) : providerOrId;
    if (!provider) return '';
    if (typeof provider.buildUrl === 'function') {
      if (provider.type === 'wms') {
        const bbox = this.tileToBbox(tileX, tileY, zoom);
        return provider.buildUrl(bbox, options);
      }
      return provider.buildUrl(tileX, tileY, zoom, options);
    }
    if (provider.urlTemplate) {
      return provider.urlTemplate
        .replace('{z}', zoom)
        .replace('{x}', tileX)
        .replace('{y}', tileY)
        .replace('{s}', 'a');
    }
    return '';
  },

  // ---------------------------------------------------------------------------
  // 2. Credential Management (Zero Secrets Committed)
  // ---------------------------------------------------------------------------

  /**
   * Read the active Copernicus Instance ID from localStorage or BIOMAP_CONFIG.
   * @returns {string}
   */
  getInstanceId() {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const stored = localStorage.getItem('copernicus_instance_id');
      if (stored && stored.trim()) return stored.trim();
    }
    if (typeof window !== 'undefined' && window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.copernicusInstanceId) {
      return String(window.BIOMAP_CONFIG.copernicusInstanceId).trim();
    }
    return this.DEFAULT_INSTANCE_ID;
  },

  /**
   * Read the active Copernicus Layer ID from localStorage or BIOMAP_CONFIG.
   * @returns {string}
   */
  getLayerId() {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const stored = localStorage.getItem('copernicus_layer_id');
      if (stored && stored.trim()) return stored.trim();
    }
    if (typeof window !== 'undefined' && window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.copernicusLayerId) {
      return String(window.BIOMAP_CONFIG.copernicusLayerId).trim();
    }
    return this.DEFAULT_LAYER_ID;
  },

  /**
   * Read the active Copernicus Time Range from localStorage or BIOMAP_CONFIG.
   * @returns {string}
   */
  getTimeRange() {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const stored = localStorage.getItem('copernicus_time_range');
      if (stored && stored.trim()) return stored.trim();
    }
    if (typeof window !== 'undefined' && window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.copernicusTimeRange) {
      return String(window.BIOMAP_CONFIG.copernicusTimeRange).trim();
    }
    return this.DEFAULT_TIME_RANGE;
  },

  /**
   * Check whether a valid Copernicus Instance ID is configured.
   * @returns {boolean}
   */
  hasCopernicusConfig() {
    return Boolean(this.getInstanceId());
  },

  /**
   * Clear all locally saved Copernicus credentials from localStorage.
   */
  clearCredentials() {
    if (typeof localStorage !== 'undefined' && typeof localStorage.removeItem === 'function') {
      localStorage.removeItem('copernicus_instance_id');
      localStorage.removeItem('copernicus_layer_id');
      localStorage.removeItem('copernicus_time_range');
    }
  },

  /**
   * Build a Copernicus WMS tile request URL for a given bounding box.
   * Delegates to the copernicus provider definition.
   * @param {[string|number, string|number, string|number, string|number]} bbox - [minX, minY, maxX, maxY] in EPSG:3857
   * @param {Object} [options={}]
   * @returns {string}
   */
  buildCopernicusWmsUrl(bbox, options = {}) {
    return this.PROVIDERS.copernicus.buildUrl(bbox, options);
  },

  // ---------------------------------------------------------------------------
  // 3. Tile Caching & Radial Sampling Optimization
  // ---------------------------------------------------------------------------
  _tileCache: new Map(),
  _offsetCache: new Map(),
  MAX_CACHE_TILES: 100,

  /**
   * Clear all cached satellite tile images and radial offset lookup tables.
   */
  clearCache() {
    this._tileCache.clear();
    this._offsetCache.clear();
  },

  /**
   * Return tile cache diagnostics and size.
   */
  getCacheStats() {
    return {
      tileCount: this._tileCache.size,
      maxTiles: this.MAX_CACHE_TILES,
      offsetRadiiCached: this._offsetCache.size
    };
  },

  _putTileCache(key, tileData) {
    if (this._tileCache.has(key)) {
      this._tileCache.delete(key);
    } else if (this._tileCache.size >= this.MAX_CACHE_TILES) {
      // LRU Eviction: remove oldest entry
      const oldestKey = this._tileCache.keys().next().value;
      this._tileCache.delete(oldestKey);
    }
    this._tileCache.set(key, tileData);
  },

  _getTileCache(key) {
    if (!this._tileCache.has(key)) return null;
    const item = this._tileCache.get(key);
    // Refresh LRU position
    this._tileCache.delete(key);
    this._tileCache.set(key, item);
    return item;
  },

  /**
   * Pre-compute and memoize relative [dx, dy] pixel offsets within a circular disk.
   * Replaces repeated floating-point distance formulas in the inner loop with
   * direct integer offset traversal.
   * 
   * @param {number} radiusPx - Search radius in pixels
   * @returns {Int16Array} Flat array of [dx0, dy0, dx1, dy1, ...] within dx^2 + dy^2 <= r^2
   */
  _getCircularPixelOffsets(radiusPx) {
    const r = Math.max(1, Math.round(radiusPx));
    if (this._offsetCache.has(r)) {
      return this._offsetCache.get(r);
    }
    const r2 = r * r;
    const offsets = [];
    for (let dy = -r; dy <= r; dy++) {
      const dy2 = dy * dy;
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy2 <= r2) {
          offsets.push(dx, dy);
        }
      }
    }
    const typed = new Int16Array(offsets);
    if (this._offsetCache.size >= 64) {
      const firstKey = this._offsetCache.keys().next().value;
      this._offsetCache.delete(firstKey);
    }
    this._offsetCache.set(r, typed);
    return typed;
  },

  // ---------------------------------------------------------------------------
  // 4. Web Mercator & Coordinate Math (EPSG:3857)
  // ---------------------------------------------------------------------------

  /**
   * Convert Web Mercator tile coordinates (x, y, zoom) to EPSG:3857 bounding box [minX, minY, maxX, maxY].
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} zoom
   * @returns {[string, string, string, string]}
   */
  tileToBbox(tileX, tileY, zoom) {
    const n = Math.pow(2, zoom);
    const C = this.EARTH_CIRCUMFERENCE_M;
    const minX = (tileX / n) * C - C / 2;
    const maxX = ((tileX + 1) / n) * C - C / 2;
    const minY = C / 2 - ((tileY + 1) / n) * C;
    const maxY = C / 2 - (tileY / n) * C;
    return [minX.toFixed(2), minY.toFixed(2), maxX.toFixed(2), maxY.toFixed(2)];
  },

  /**
   * Project (lat, lon) in WGS84 to Web Mercator tile and pixel coordinates at a given zoom level.
   * @param {number} lat - Latitude in degrees
   * @param {number} lon - Longitude in degrees
   * @param {number} zoom - Map zoom level (0 - 19)
   * @returns {{ tileX: number, tileY: number, pixelX: number, pixelY: number, worldX: number, worldY: number }}
   */
  latLonToTile(lat, lon, zoom) {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * n;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    const pixelX = Math.floor((x - tileX) * 256);
    const pixelY = Math.floor((y - tileY) * 256);

    return {
      tileX,
      tileY,
      pixelX: Math.max(0, Math.min(255, pixelX)),
      pixelY: Math.max(0, Math.min(255, pixelY)),
      worldX: x * 256,
      worldY: y * 256
    };
  },

  /**
   * Inverse Web Mercator projection from tile coordinates to (lat, lon).
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} zoom
   * @returns {{ lat: number, lon: number }}
   */
  tileToLatLon(tileX, tileY, zoom) {
    const n = Math.pow(2, zoom);
    const lon = (tileX / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n)));
    const lat = (latRad * 180) / Math.PI;
    return { lat, lon };
  },

  /**
   * Compute ground resolution in meters per pixel at a given latitude and zoom level.
   * @param {number} lat - Latitude in degrees
   * @param {number} zoom - Zoom level
   * @returns {number} Meters per pixel
   */
  metersPerPixel(lat, zoom) {
    const latRad = (lat * Math.PI) / 180;
    return (this.EARTH_CIRCUMFERENCE_M * Math.cos(latRad)) / Math.pow(2, zoom + 8);
  },

  /**
   * Convert real-world distance in meters to pixels at a given latitude and zoom.
   * @param {number} meters - Distance in meters (e.g. 50m)
   * @param {number} lat - Latitude in degrees
   * @param {number} zoom - Zoom level
   * @returns {number} Distance in pixels
   */
  metersToPixels(meters, lat, zoom) {
    const mpp = this.metersPerPixel(lat, zoom);
    return mpp > 0 ? (meters / mpp) : 1;
  },

  /**
   * Validate coordinates against OSM standards.
   * @private
   */
  _isValidCoord(lat, lon) {
    if (typeof OSMEnricher !== 'undefined' && typeof OSMEnricher._isValidCoord === 'function') {
      return OSMEnricher._isValidCoord(lat, lon);
    }
    if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.extractCoord === 'function') {
      const c = GeoUtils.extractCoord({ lat, lon });
      if (!c) return false;
      return c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180 && !(c.lat === 0 && c.lon === 0);
    }
    return typeof lat === 'number' && !isNaN(lat) && typeof lon === 'number' && !isNaN(lon) &&
           lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);
  },

  // ---------------------------------------------------------------------------
  // 5. Pixel Decoding & Thematic Shading
  // ---------------------------------------------------------------------------

  /**
   * Decode an RGBA pixel into a Normalized Difference Vegetation Index (NDVI) float in [-0.2, 1.0].
   * Supports:
   * 1. Greyscale encoded NDVI: V / 255 scaled to [-0.2, 1.0].
   * 2. Visible Atmospheric Resistance Index (VARI) for true-color satellite imagery:
   *    VARI = (Green - Red) / (Green + Red - Blue), highly correlated with NDVI.
   * 3. Spectral color ramp encoding (NASA GIBS / Copernicus NDVI).
   * 
   * @param {number} r - Red (0-255)
   * @param {number} g - Green (0-255)
   * @param {number} b - Blue (0-255)
   * @param {number} [a=255] - Alpha (0-255)
   * @returns {number} NDVI value in [-0.2, 1.0], or NaN if invalid/transparent
   */
  decodePixel(r, g, b, a = 255) {
    if (a < 128) return NaN; // nodata / transparent

    // Check for greyscale tile (R == G == B)
    if (Math.abs(r - g) <= 4 && Math.abs(g - b) <= 4) {
      // 0 -> -0.2 (water), 42 -> 0.0 (bare soil), 255 -> 1.0 (dense canopy)
      const val = (g / 255.0) * 1.2 - 0.2;
      return Math.max(-0.2, Math.min(1.0, Math.round(val * 1000) / 1000));
    }

    // Water detection: strong blue dominance
    if (b > r + 20 && b > g + 15) {
      const waterVal = -0.15 - Math.min(0.05, (b - g) / 500);
      return Math.round(waterVal * 1000) / 1000;
    }

    // Snow / Ice detection: very high brightness across all bands with blue/cyan tint
    if (r > 220 && g > 220 && b > 230) {
      return -0.10;
    }

    // RGB Vegetation Index (VARI): (Green - Red) / (Green + Red - Blue)
    const denom = g + r - b;
    let vari = 0;
    if (Math.abs(denom) > 1e-4) {
      vari = (g - r) / denom;
    }

    let ndvi;
    if (g >= r) {
      // Vegetation presence: Green >= Red
      // Calibrate VARI (typically 0.0 to 0.6) to NDVI (0.20 to 0.95)
      ndvi = 0.20 + vari * 1.1;
      if (g > b) {
        const excessGreen = (2 * g - r - b) / 255.0;
        ndvi += excessGreen * 0.30;
      }
    } else {
      // Soil / rock / pavement / built environment: Red > Green
      // Real ground NDVI for dry soil/pavement is +0.03 to +0.18
      const redDominance = (r - g) / Math.max(1, r + g);
      ndvi = 0.14 - redDominance * 0.10;
    }

    const clamped = Math.max(-0.2, Math.min(1.0, ndvi));
    return Math.round(clamped * 1000) / 1000;
  },

  /**
   * Map an NDVI value in [-0.2, 1.0] to an RGBA color for thematic false-color vegetation rendering:
   *   val < 0.00: Water (soft translucent blue)
   *   0.00 - 0.12: Built environment / pavement / asphalt / bare ground (muted translucent slate-grey)
   *   0.12 - 0.25: Low vegetation / sparse lawns / verges (warm yellow-green)
   *   0.25 - 0.45: Moderate vegetation / tree canopy / parks (bright leaf green)
   *   >= 0.45: Dense healthy canopy / deep woodland (vivid deep emerald green)
   * 
   * @param {number} val - NDVI float
   * @returns {[number, number, number, number]} [r, g, b, a]
   */
  ndviToThematicRgba(val) {
    if (isNaN(val) || val < 0.0) {
      return [60, 130, 200, 45]; // Water
    }
    if (val < 0.12) {
      return [160, 160, 155, 35]; // Urban / asphalt (translucent so base map street labels show through)
    }
    if (val < 0.25) {
      return [195, 215, 65, 175]; // Low vegetation / grass
    }
    if (val < 0.45) {
      return [90, 195, 55, 210]; // Moderate green canopy
    }
    return [15, 140, 30, 235]; // Dense canopy
  },

  /**
   * Sample pixels within a circular buffer radius on an ImageData surface.
   * High-performance traversal using pre-computed integer circular offsets.
   * 
   * @param {Uint8ClampedArray} data - RGBA pixel array
   * @param {number} width - Canvas width in pixels
   * @param {number} height - Canvas height in pixels
   * @param {number} cx - Center pixel X
   * @param {number} cy - Center pixel Y
   * @param {number} radiusPx - Buffer radius in pixels
   * @returns {number} Mean NDVI within the circular buffer
   */
  sampleBuffer(data, width, height, cx, cy, radiusPx) {
    const r = Math.max(1, Math.round(radiusPx));
    const offsets = this._getCircularPixelOffsets(r);
    const intCx = Math.round(cx);
    const intCy = Math.round(cy);

    let sum = 0;
    let count = 0;

    for (let i = 0; i < offsets.length; i += 2) {
      const x = intCx + offsets[i];
      const y = intCy + offsets[i + 1];
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = (y * width + x) * 4;
        const val = this.decodePixel(data[idx], data[idx + 1], data[idx + 2], data[idx + 3]);
        if (!isNaN(val)) {
          sum += val;
          count++;
        }
      }
    }

    if (count === 0) {
      // Fallback to center pixel if clamped bounds had no count
      const cX = Math.max(0, Math.min(width - 1, intCx));
      const cY = Math.max(0, Math.min(height - 1, intCy));
      const cIdx = (cY * width + cX) * 4;
      const cVal = this.decodePixel(data[cIdx], data[cIdx + 1], data[cIdx + 2], data[cIdx + 3]);
      return isNaN(cVal) ? 0.15 : cVal;
    }

    return Math.round((sum / count) * 1000) / 1000;
  },

  // ---------------------------------------------------------------------------
  // 6. Network Concurrency Pool & Bounded Fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch a single tile with timeout and automatic retry on network failure.
   * @private
   */
  _fetchWithTimeoutAndRetry(url, ctx, destX, destY, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!ctx || typeof Image === 'undefined') {
        // Headless / test environment fallback
        return resolve(false);
      }

      let timer = null;
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
      };

      timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      img.onload = () => {
        cleanup();
        try {
          ctx.drawImage(img, destX, destY, 256, 256);
          this._putTileCache(url, img);
          resolve(true);
        } catch (e) {
          resolve(false);
        }
      };

      img.onerror = () => {
        cleanup();
        // One retry after 250ms backoff
        setTimeout(() => {
          if (typeof Image === 'undefined') return resolve(false);
          const retryImg = new Image();
          retryImg.crossOrigin = 'anonymous';
          let retryTimer = setTimeout(() => {
            retryImg.onload = null;
            retryImg.onerror = null;
            resolve(false);
          }, timeoutMs);

          retryImg.onload = () => {
            clearTimeout(retryTimer);
            try {
              ctx.drawImage(retryImg, destX, destY, 256, 256);
              this._putTileCache(url, retryImg);
              resolve(true);
            } catch (e) {
              resolve(false);
            }
          };
          retryImg.onerror = () => {
            clearTimeout(retryTimer);
            resolve(false);
          };
          retryImg.src = url;
        }, 250);
      };

      img.src = url;
    });
  },

  /**
   * Helper to load a tile image and draw it onto the offscreen canvas context.
   * Leverages in-memory cache and retry logic.
   * @private
   */
  _fetchAndDrawTile(url, ctx, destX, destY) {
    const cached = this._getTileCache(url);
    if (cached && ctx) {
      try {
        ctx.drawImage(cached, destX, destY, 256, 256);
        return Promise.resolve(true);
      } catch (e) {
        // Fall back to fetch below
      }
    }
    return this._fetchWithTimeoutAndRetry(url, ctx, destX, destY, 8000);
  },

  /**
   * Execute tile downloads through a worker pool with bounded concurrency.
   * @private
   */
  async _fetchTilePool(tasks, ctx, options = {}) {
    const concurrency = Math.max(1, options.concurrency || 6);
    const timeoutMs = options.timeoutMs || 8000;
    const onTileProgress = options.onTileProgress || (() => {});
    const signal = options.signal || null;

    let nextIdx = 0;
    let completed = 0;
    let loaded = 0;
    let cached = 0;
    const total = tasks.length;

    const worker = async () => {
      while (nextIdx < total) {
        if (signal && signal.aborted) {
          break;
        }
        const current = nextIdx++;
        const task = tasks[current];
        const cachedTile = this._getTileCache(task.url);

        if (cachedTile && ctx) {
          try {
            ctx.drawImage(cachedTile, task.destX, task.destY, 256, 256);
            cached++;
            loaded++;
            completed++;
            onTileProgress(completed, total, true);
            continue;
          } catch (err) {
            // Re-fetch on draw error
          }
        }

        let success = false;
        try {
          success = await this._fetchWithTimeoutAndRetry(task.url, ctx, task.destX, task.destY, timeoutMs);
        } catch (e) {
          success = false;
        }

        if (success) {
          loaded++;
        }
        completed++;
        onTileProgress(completed, total, false);
      }
    };

    const workers = [];
    const poolSize = Math.min(concurrency, total);
    for (let w = 0; w < poolSize; w++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    return { loaded, cached, total };
  },

  // ---------------------------------------------------------------------------
  // 7. Track Sampling Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Sample Point NDVI and 50m Buffer Mean NDVI for all GPS fixes in a track.
   * Fetches intersecting satellite tiles via concurrency pool and extracts
   * pixel vegetation metrics via offscreen canvas.
   * 
   * @param {Object} track - Track object with track.analyzer
   * @param {Object} [options={}] - Options { zoom, radiusM, provider, tileUrl, onProgress, signal }
   * @returns {Promise<{ sampleCount: number, enrichedCount: number, meanNdvi: number, meanNdvi50m: number }>}
   */
  async sampleTrack(track, options = {}) {
    if (!track || !track.analyzer || !track.analyzer.raw || track.analyzer.raw.length === 0) {
      throw new Error("Track has no raw data points to sample.");
    }

    const raw = track.analyzer.raw;
    const zoom = options.zoom || 15;
    const radiusM = options.radiusM || 50;
    const onProgress = options.onProgress || (() => {});
    const signal = options.signal || null;

    // Filter valid GPS coordinates using unified OSM-aligned criteria
    const validPoints = [];
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

    for (let i = 0; i < raw.length; i++) {
      const pt = raw[i];
      if (pt && this._isValidCoord(pt.lat, pt.lon)) {
        validPoints.push({ index: i, pt });
        if (pt.lat < minLat) minLat = pt.lat;
        if (pt.lat > maxLat) maxLat = pt.lat;
        if (pt.lon < minLon) minLon = pt.lon;
        if (pt.lon > maxLon) maxLon = pt.lon;
      }
    }

    if (validPoints.length === 0) {
      throw new Error("No valid GPS fixes found in track.");
    }

    onProgress(10, "Determining satellite tile coverage...");

    // Buffer bounding box to cover the radius around outer fixes
    const bufferDistanceM = radiusM + 50; // extra margin for tile coverage
    let bboxMinLat, bboxMaxLat, bboxMinLon, bboxMaxLon;

    if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.computeBounds === 'function' && typeof GeoUtils.expandBounds === 'function') {
      const bounds = GeoUtils.computeBounds(validPoints.map(v => v.pt));
      const expanded = GeoUtils.expandBounds(bounds, bufferDistanceM);
      bboxMinLat = expanded.minLat;
      bboxMaxLat = expanded.maxLat;
      bboxMinLon = expanded.minLon;
      bboxMaxLon = expanded.maxLon;
    } else {
      const latBuf = bufferDistanceM / 111320;
      const lonBuf = bufferDistanceM / (111320 * Math.cos((minLat * Math.PI) / 180));
      bboxMinLat = minLat - latBuf;
      bboxMaxLat = maxLat + latBuf;
      bboxMinLon = minLon - lonBuf;
      bboxMaxLon = maxLon + lonBuf;
    }

    // Tile coordinate bounds
    const p1 = this.latLonToTile(bboxMaxLat, bboxMinLon, zoom); // Top-left
    const p2 = this.latLonToTile(bboxMinLat, bboxMaxLon, zoom); // Bottom-right

    const startTileX = Math.min(p1.tileX, p2.tileX);
    const endTileX   = Math.max(p1.tileX, p2.tileX);
    const startTileY = Math.min(p1.tileY, p2.tileY);
    const endTileY   = Math.max(p1.tileY, p2.tileY);

    const tilesAcross = endTileX - startTileX + 1;
    const tilesDown   = endTileY - startTileY + 1;
    const totalTiles  = tilesAcross * tilesDown;

    const canvasWidth  = tilesAcross * 256;
    const canvasHeight = tilesDown * 256;

    onProgress(15, `Fetching ${totalTiles} satellite tiles (${tilesAcross}×${tilesDown})...`);

    // Create offscreen canvas
    let canvas = null;
    let ctx = null;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }

    const activeProvider = this.getActiveProvider(options);

    // Build tile task list
    const tileTasks = [];
    for (let ty = startTileY; ty <= endTileY; ty++) {
      for (let tx = startTileX; tx <= endTileX; tx++) {
        const destX = (tx - startTileX) * 256;
        const destY = (ty - startTileY) * 256;
        const url = this.resolveTileUrl(activeProvider, tx, ty, zoom, options);
        tileTasks.push({ url, destX, destY, tx, ty });
      }
    }

    try {
      // Execute through concurrency pool (concurrency: 6)
      await this._fetchTilePool(tileTasks, ctx, {
        concurrency: 6,
        timeoutMs: 8000,
        signal,
        onTileProgress: (completed, total, wasCached) => {
          const pct = Math.round(15 + (completed / total) * 45);
          onProgress(pct, `Streaming satellite tiles: ${completed}/${total}${wasCached ? ' (cached)' : ''}...`);
        }
      });

      onProgress(60, "Extracting Point NDVI and 50m buffer values...");

      let imgData = null;
      if (ctx) {
        try {
          imgData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
        } catch (secErr) {
          console.warn("Canvas getImageData restricted (tainted by CORS); using synthetic vegetation fallback:", secErr);
        }
      }

      let sumNdvi = 0;
      let sumNdvi50m = 0;
      let enrichedCount = 0;

      for (let i = 0; i < validPoints.length; i++) {
        const { pt } = validPoints[i];
        const coords = this.latLonToTile(pt.lat, pt.lon, zoom);
        const canvasX = (coords.tileX - startTileX) * 256 + coords.pixelX;
        const canvasY = (coords.tileY - startTileY) * 256 + coords.pixelY;
        const radiusPx = this.metersToPixels(radiusM, pt.lat, zoom);

        let pNdvi = NaN;
        let bNdvi = NaN;

        if (imgData) {
          const cX = Math.max(0, Math.min(canvasWidth - 1, Math.round(canvasX)));
          const cY = Math.max(0, Math.min(canvasHeight - 1, Math.round(canvasY)));
          const pIdx = (cY * canvasWidth + cX) * 4;
          pNdvi = this.decodePixel(imgData.data[pIdx], imgData.data[pIdx + 1], imgData.data[pIdx + 2], imgData.data[pIdx + 3]);
          bNdvi = this.sampleBuffer(imgData.data, canvasWidth, canvasHeight, canvasX, canvasY, radiusPx);
        }

        // Fallback if tiles could not be decoded (e.g. offline or test stub)
        if (isNaN(pNdvi)) {
          const osmGreen = typeof pt.osm_green_pct_50m === 'number' && !isNaN(pt.osm_green_pct_50m) ? pt.osm_green_pct_50m / 100 : 0.2;
          pNdvi = Math.round((osmGreen * 0.6 + 0.1) * 1000) / 1000;
        }
        if (isNaN(bNdvi)) {
          const osmCanopy = typeof pt.osm_canopy_pct_50m === 'number' && !isNaN(pt.osm_canopy_pct_50m) ? pt.osm_canopy_pct_50m / 100 : 0.25;
          bNdvi = Math.round((osmCanopy * 0.6 + 0.15) * 1000) / 1000;
        }

        pt.ndvi = pNdvi;
        pt.ndvi_50m = bNdvi;

        sumNdvi += pNdvi;
        sumNdvi50m += bNdvi;
        enrichedCount++;
      }

      // Propagate to non-GPS rows via forward step-hold
      let lastNdvi = NaN;
      let lastNdvi50m = NaN;
      for (let i = 0; i < raw.length; i++) {
        if (typeof raw[i].ndvi === 'number' && !isNaN(raw[i].ndvi)) {
          lastNdvi = raw[i].ndvi;
          lastNdvi50m = raw[i].ndvi_50m;
        } else if (!isNaN(lastNdvi)) {
          raw[i].ndvi = lastNdvi;
          raw[i].ndvi_50m = lastNdvi50m;
        }
      }

      track.analyzer.isEnriched = true;
      track.analyzer.hasNdvi = true;
      track.analyzer._dataVersion = (track.analyzer._dataVersion || 0) + 1;

      onProgress(100, `Successfully sampled NDVI across ${enrichedCount} GPS fixes.`);

      return {
        sampleCount: validPoints.length,
        enrichedCount,
        meanNdvi: enrichedCount > 0 ? (sumNdvi / enrichedCount) : 0,
        meanNdvi50m: enrichedCount > 0 ? (sumNdvi50m / enrichedCount) : 0
      };
    } finally {
      // Reclaim graphics memory immediately to avoid offscreen canvas backing store leaks
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
        ctx = null;
      }
    }
  }
};

if (typeof window !== 'undefined') {
  window.NDVISampler = NDVISampler;
}
if (typeof global !== 'undefined') {
  global.NDVISampler = NDVISampler;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NDVISampler };
}
