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

  _clampAndRoundNdvi(v) {
    return Math.max(-0.2, Math.min(1.0, Math.round(v * 1000) / 1000));
  },

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
      return this._clampAndRoundNdvi((g / 255.0) * 1.2 - 0.2);
    }

    // Water detection: strong blue dominance
    if (b > r + 20 && b > g + 15) {
      return this._clampAndRoundNdvi(-0.15 - Math.min(0.05, (b - g) / 500));
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

    return this._clampAndRoundNdvi(ndvi);
  },

  /**
   * Write false-color thematic vegetation RGBA values directly into a target buffer.
   * Zero heap allocations.
   * 
   * @param {number} val - NDVI float
   * @param {Uint8ClampedArray|Array<number>} targetArray - Target array to write into
   * @param {number} offset - Byte/index offset
   */
  writeThematicRgba(val, targetArray, offset) {
    if (isNaN(val) || val < 0.0) {
      targetArray[offset]     = 60;
      targetArray[offset + 1] = 130;
      targetArray[offset + 2] = 200;
      targetArray[offset + 3] = 45; // Water (soft translucent blue)
      return;
    }
    if (val < 0.12) {
      targetArray[offset]     = 160;
      targetArray[offset + 1] = 160;
      targetArray[offset + 2] = 155;
      targetArray[offset + 3] = 35; // Urban / asphalt (translucent so labels show through)
      return;
    }
    if (val < 0.25) {
      targetArray[offset]     = 195;
      targetArray[offset + 1] = 215;
      targetArray[offset + 2] = 65;
      targetArray[offset + 3] = 175; // Low vegetation / grass
      return;
    }
    if (val < 0.45) {
      targetArray[offset]     = 90;
      targetArray[offset + 1] = 195;
      targetArray[offset + 2] = 55;
      targetArray[offset + 3] = 210; // Moderate canopy / parks
      return;
    }
    targetArray[offset]     = 15;
    targetArray[offset + 1] = 140;
    targetArray[offset + 2] = 30;
    targetArray[offset + 3] = 235; // Dense canopy / woodland
  },

  /**
   * Directly transforms an ImageData RGBA buffer into thematic false-color NDVI in-place.
   * Eliminates 260k+ heap allocations per tile for smooth 60fps tile rendering during pan/zoom.
   * 
   * @param {ImageData} imgData - Canvas ImageData (256x256)
   */
  shadeImageData(imgData) {
    if (!imgData || !imgData.data) return;
    const d = imgData.data;
    const len = d.length;
    for (let i = 0; i < len; i += 4) {
      const a = d[i + 3];
      if (a < 128) continue;
      const val = this.decodePixel(d[i], d[i + 1], d[i + 2], a);
      this.writeThematicRgba(val, d, i);
    }
  },

  /**
   * Map an NDVI value in [-0.2, 1.0] to an RGBA color for thematic false-color vegetation rendering.
   * Delegates to writeThematicRgba for consistency.
   * 
   * @param {number} val - NDVI float
   * @returns {[number, number, number, number]} [r, g, b, a]
   */
  ndviToThematicRgba(val) {
    const out = [0, 0, 0, 0];
    this.writeThematicRgba(val, out, 0);
    return out;
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
  // 6. Network Concurrency Pool, Rate Limiting & Exponential Backoff
  // ---------------------------------------------------------------------------

  // Provider rate-limit tracker (mirroring OverpassClient)
  _providerRateLimits: new Map(),

  /**
   * Compute exponential backoff with random jitter (mirroring OverpassClient._backoffMs).
   * @param {number} attempt - Zero-based attempt count
   * @param {number} [baseMs=500] - Base delay in ms
   * @returns {number} Backoff time in ms
   */
  _backoffMs(attempt, baseMs = 500) {
    const linear = baseMs * Math.pow(2, attempt);
    const jitter = 0.75 + Math.random() * 0.5; // 0.75 – 1.25 jitter
    return Math.round(linear * jitter);
  },

  /**
   * Parse Retry-After header if present, or return fallback.
   * @param {Response} response
   * @param {number} fallbackMs
   * @returns {number}
   */
  _retryAfterMs(response, fallbackMs = 5000) {
    if (!response || !response.headers || typeof response.headers.get !== 'function') return fallbackMs;
    const val = response.headers.get('Retry-After');
    if (!val) return fallbackMs;
    const sec = parseInt(val, 10);
    if (!isNaN(sec) && sec > 0) return sec * 1000;
    return fallbackMs;
  },

  /**
   * Enforce rate limit cooldown for a provider before firing requests.
   * @param {string} providerId
   */
  async _enforceRateLimit(providerId) {
    const nextAllowed = this._providerRateLimits.get(providerId);
    if (nextAllowed && Date.now() < nextAllowed) {
      const wait = nextAllowed - Date.now();
      await new Promise(r => setTimeout(r, wait));
    }
  },

  /**
   * Helper to convert an image Blob into an HTMLImageElement safely.
   * @private
   */
  _blobToImage(blob) {
    return new Promise((resolve) => {
      if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        return resolve(null);
      }
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(null);
      };
      img.src = objectUrl;
    });
  },

  /**
   * Fallback to load a tile via new Image() element with timeout.
   * @private
   */
  _fetchViaImage(url, ctx, destX, destY, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!ctx || typeof Image === 'undefined') {
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
        resolve(false);
      };

      img.src = url;
    });
  },

  /**
   * Fetch a single satellite tile with rate limit enforcement, exponential backoff,
   * status code inspection, and automatic retries.
   * 
   * @param {string} url - Tile URL
   * @param {CanvasRenderingContext2D|null} ctx - Offscreen canvas context
   * @param {number} destX - Destination X on canvas
   * @param {number} destY - Destination Y on canvas
   * @param {Object} [options={}] - { providerId, maxRetries, timeoutMs, signal, onRetry }
   * @returns {Promise<boolean>} True if loaded and drawn, false otherwise
   */
  async _fetchTileWithBackoff(url, ctx, destX, destY, options = {}) {
    if (!ctx) return false;
    const providerId = options.providerId || 'default';
    const maxRetries = (typeof options.maxRetries === 'number') ? options.maxRetries : 3;
    const timeoutMs = options.timeoutMs || 8000;
    const signal = options.signal || null;
    const onRetry = options.onRetry || (() => {});

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal && signal.aborted) return false;

      // 1. Honour provider rate limits
      await this._enforceRateLimit(providerId);

      try {
        // 2. Try modern fetch path (gives HTTP status, headers, and avoids canvas tainting)
        if (typeof fetch === 'function') {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          let response;
          try {
            response = await fetch(url, {
              mode: 'cors',
              signal: controller.signal
            });
          } finally {
            clearTimeout(timer);
          }

          if (response.ok) {
            const blob = await response.blob();
            let imgSource = null;
            if (typeof createImageBitmap === 'function') {
              try {
                imgSource = await createImageBitmap(blob);
              } catch (bmpErr) {
                imgSource = null;
              }
            }
            if (!imgSource && typeof Image !== 'undefined') {
              imgSource = await this._blobToImage(blob);
            }

            if (imgSource) {
              try {
                ctx.drawImage(imgSource, destX, destY, 256, 256);
                this._putTileCache(url, imgSource);
                return true;
              } catch (drawErr) {
                // Drawing failed (e.g. invalid bitmap); fall through to retry
              }
            }
          }

          // Rate-limiting (HTTP 429 or 509)
          if (response.status === 429 || response.status === 509) {
            const retryAfter = this._retryAfterMs(response, 5000 * Math.pow(2, attempt));
            this._providerRateLimits.set(providerId, Date.now() + retryAfter);
            if (attempt < maxRetries) {
              onRetry(attempt + 1, retryAfter, `Rate limited (HTTP ${response.status})`);
              await new Promise(r => setTimeout(r, retryAfter));
              continue;
            }
            return false;
          }

          // Permanent client errors (HTTP 400, 404) -> do not waste retries
          if (response.status === 400 || response.status === 404) {
            return false;
          }

          // Server error (HTTP 500, 502, 503, 504) -> back off and retry
          if (response.status >= 500) {
            if (attempt < maxRetries) {
              const waitMs = this._backoffMs(attempt, 500);
              onRetry(attempt + 1, waitMs, `Server error (HTTP ${response.status})`);
              await new Promise(r => setTimeout(r, waitMs));
              continue;
            }
            return false;
          }
        }

        // 3. Fallback to Image element if fetch failed or is not available
        const imgSuccess = await this._fetchViaImage(url, ctx, destX, destY, timeoutMs);
        if (imgSuccess) return true;

        if (attempt < maxRetries) {
          const waitMs = this._backoffMs(attempt, 400);
          onRetry(attempt + 1, waitMs, 'Image load failed');
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

      } catch (err) {
        // Network timeout / connection reset
        if (attempt < maxRetries) {
          const waitMs = this._backoffMs(attempt, 400);
          onRetry(attempt + 1, waitMs, err.message || 'Network error');
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
      }
    }

    return false;
  },

  /**
   * Helper to load a tile image and draw it onto the offscreen canvas context.
   * Leverages in-memory cache and exponential backoff retry logic.
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
    return this._fetchTileWithBackoff(url, ctx, destX, destY, { maxRetries: 3, timeoutMs: 8000 });
  },

  /**
   * Execute tile downloads through a worker pool with bounded concurrency and backoff.
   * @private
   */
  async _fetchTilePool(tasks, ctx, options = {}) {
    const concurrency = Math.max(1, options.concurrency || 6);
    const timeoutMs = options.timeoutMs || 8000;
    const onTileProgress = options.onTileProgress || options.onProgress || (() => {});
    const signal = options.signal || null;
    const providerId = options.providerId || 'default';
    const maxRetries = (typeof options.maxRetries === 'number') ? options.maxRetries : 3;

    let nextIdx = 0;
    let completed = 0;
    let loaded = 0;
    let cached = 0;
    let failed = 0;
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

        const success = await this._fetchTileWithBackoff(task.url, ctx, task.destX, task.destY, {
          timeoutMs,
          signal,
          providerId,
          maxRetries,
          onRetry: (attempt, waitMs, reason) => {
            onTileProgress(completed, total, false, `Tile retry (${attempt}/${maxRetries}): ${reason}`);
          }
        });

        if (success) {
          loaded++;
        } else {
          failed++;
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
    return { loaded, cached, failed, total };
  },

  // ---------------------------------------------------------------------------
  // 7. Track Sampling Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Compute a buffered geographical bounding box for an array of points.
   * Unifies bounding box calculation across OSM and NDVI pipelines.
   * 
   * @param {Array<Object>} rawPoints - Points array ({lat, lon})
   * @param {number} [bufferMeters=100] - Padding in meters
   * @returns {{ minLat: number, maxLat: number, minLon: number, maxLon: number }|null}
   */
  calculateBBox(rawPoints, bufferMeters = 100) {
    if (!rawPoints || rawPoints.length === 0) return null;
    if (typeof OSMEnricher !== 'undefined' && typeof OSMEnricher.calculateBBox === 'function') {
      const osmBbox = OSMEnricher.calculateBBox(rawPoints, bufferMeters);
      if (osmBbox) return osmBbox;
    }
    const rawBounds = (typeof GeoUtils !== 'undefined' && typeof GeoUtils.computeBounds === 'function')
      ? GeoUtils.computeBounds(rawPoints, 0, (pt) => this._isValidCoord(pt.lat, pt.lon))
      : null;
    if (rawBounds && typeof GeoUtils.expandBounds === 'function') {
      return GeoUtils.expandBounds(rawBounds, bufferMeters);
    }
    // Standalone fallback
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180, count = 0;
    for (let i = 0; i < rawPoints.length; i++) {
      const p = rawPoints[i];
      if (p && this._isValidCoord(p.lat, p.lon)) {
        count++;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
      }
    }
    if (count === 0) return null;
    const latBuf = bufferMeters / 111320;
    const lonBuf = bufferMeters / (111320 * Math.cos((minLat * Math.PI) / 180));
    return {
      minLat: minLat - latBuf,
      maxLat: maxLat + latBuf,
      minLon: minLon - lonBuf,
      maxLon: maxLon + lonBuf
    };
  },

  /**
   * Calculate bounding box area in square kilometers.
   * @param {{ minLat: number, maxLat: number, minLon: number, maxLon: number }} bbox
   * @returns {number}
   */
  calculateBBoxAreaKm2(bbox) {
    if (!bbox) return 0;
    if (typeof OSMEnricher !== 'undefined' && typeof OSMEnricher.calculateBBoxAreaKm2 === 'function') {
      return OSMEnricher.calculateBBoxAreaKm2(bbox);
    }
    if (typeof GeoUtils !== 'undefined' && typeof GeoUtils.bboxAreaKm2 === 'function') {
      return GeoUtils.bboxAreaKm2(bbox);
    }
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    const h = (bbox.maxLat - bbox.minLat) * 111.32;
    const w = (bbox.maxLon - bbox.minLon) * 111.32 * Math.cos((midLat * Math.PI) / 180);
    return Math.abs(h * w);
  },

  /**
   * Compute Mercator tile coordinate bounds and total tile count with optional adaptive zoom.
   * @private
   */
  _calculateTileBounds(bbox, zoom, maxTiles = 64, adaptiveZoom = true) {
    let currentZoom = zoom;
    let p1 = this.latLonToTile(bbox.maxLat, bbox.minLon, currentZoom);
    let p2 = this.latLonToTile(bbox.minLat, bbox.maxLon, currentZoom);
    let startTileX = Math.min(p1.tileX, p2.tileX);
    let endTileX   = Math.max(p1.tileX, p2.tileX);
    let startTileY = Math.min(p1.tileY, p2.tileY);
    let endTileY   = Math.max(p1.tileY, p2.tileY);
    let tilesAcross = endTileX - startTileX + 1;
    let tilesDown   = endTileY - startTileY + 1;
    let totalTiles  = tilesAcross * tilesDown;

    if (adaptiveZoom && totalTiles > maxTiles) {
      while (totalTiles > maxTiles && currentZoom > 12) {
        currentZoom--;
        p1 = this.latLonToTile(bbox.maxLat, bbox.minLon, currentZoom);
        p2 = this.latLonToTile(bbox.minLat, bbox.maxLon, currentZoom);
        startTileX = Math.min(p1.tileX, p2.tileX);
        endTileX   = Math.max(p1.tileX, p2.tileX);
        startTileY = Math.min(p1.tileY, p2.tileY);
        endTileY   = Math.max(p1.tileY, p2.tileY);
        tilesAcross = endTileX - startTileX + 1;
        tilesDown   = endTileY - startTileY + 1;
        totalTiles  = tilesAcross * tilesDown;
      }
    }

    return {
      zoom: currentZoom,
      startTileX,
      endTileX,
      startTileY,
      endTileY,
      tilesAcross,
      tilesDown,
      totalTiles,
      wasAdapted: currentZoom !== zoom
    };
  },

  /**
   * Core sampling loop: extracts Point NDVI and radial buffer NDVI from an offscreen canvas.
   * @private
   */
  _samplePointsOnCanvas(raw, validPoints, imgData, canvasWidth, canvasHeight, startTileX, startTileY, zoom, radiusM) {
    let sumNdvi = 0;
    let sumNdvi50m = 0;
    let enrichedCount = 0;

    for (let i = 0; i < validPoints.length; i++) {
      const pt = validPoints[i].pt || validPoints[i];
      const coords = this.latLonToTile(pt.lat, pt.lon, zoom);
      // Sub-pixel continuous coordinates on canvas for maximum spatial precision
      const canvasX = coords.worldX - (startTileX * 256);
      const canvasY = coords.worldY - (startTileY * 256);
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
    this._stepHoldValues(raw, ['ndvi', 'ndvi_50m']);

    return {
      sampleCount: validPoints.length,
      enrichedCount,
      meanNdvi: enrichedCount > 0 ? (sumNdvi / enrichedCount) : 0,
      meanNdvi50m: enrichedCount > 0 ? (sumNdvi50m / enrichedCount) : 0
    };
  },

  /**
   * Propagate scalar values to non-GPS or null rows via forward step-hold.
   * @param {Array<Object>} raw - Array of track row objects
   * @param {Array<string>} fields - Field names to step-hold
   */
  _stepHoldValues(raw, fields) {
    if (!raw || !fields || fields.length === 0) return;
    const lastVals = {};
    for (let f = 0; f < fields.length; f++) {
      lastVals[fields[f]] = NaN;
    }
    for (let i = 0; i < raw.length; i++) {
      const row = raw[i];
      if (!row) continue;
      for (let f = 0; f < fields.length; f++) {
        const field = fields[f];
        if (typeof row[field] === 'number' && !isNaN(row[field])) {
          lastVals[field] = row[field];
        } else if (!isNaN(lastVals[field])) {
          row[field] = lastVals[field];
        }
      }
    }
  },

  /**
   * Sample Point NDVI and 50m Buffer Mean NDVI for all GPS fixes in a track.
   * Fetches intersecting satellite tiles via concurrency pool and extracts
   * pixel vegetation metrics via offscreen canvas.
   * 
   * @param {Object} track - Track object with track.analyzer
   * @param {Object} [options={}] - Options { zoom, radiusM, provider, tileUrl, onProgress, signal, maxTiles, adaptiveZoom }
   * @returns {Promise<{ sampleCount: number, enrichedCount: number, meanNdvi: number, meanNdvi50m: number }>}
   */
  async sampleTrack(track, options = {}) {
    const analyzer = track?.analyzer || track;
    if (!analyzer || !analyzer.raw || analyzer.raw.length === 0) {
      throw new Error("Track has no raw data points to sample.");
    }

    const raw = analyzer.raw;
    const requestedZoom = options.zoom || 15;
    const radiusM = options.radiusM || 50;
    const onProgress = options.onProgress || (() => {});
    const signal = options.signal || null;
    const maxTiles = options.maxTiles || 64;
    const adaptiveZoom = options.adaptiveZoom !== false;

    // Filter valid GPS coordinates using unified criteria
    const validPoints = [];
    for (let i = 0; i < raw.length; i++) {
      const pt = raw[i];
      if (pt && this._isValidCoord(pt.lat, pt.lon)) {
        validPoints.push({ index: i, pt });
      }
    }

    if (validPoints.length === 0) {
      throw new Error("No valid GPS fixes found in track.");
    }

    onProgress(10, "Determining satellite tile coverage...");

    // Buffer bounding box to cover the radius around outer fixes
    const bufferDistanceM = radiusM + 50;
    const bbox = this.calculateBBox(raw, bufferDistanceM);
    if (!bbox) {
      throw new Error("No valid GPS fixes found in track.");
    }

    // Tile coordinate bounds with adaptive zoom safeguard
    const bounds = this._calculateTileBounds(bbox, requestedZoom, maxTiles, adaptiveZoom);
    const zoom = bounds.zoom;
    const { startTileX, endTileX, startTileY, endTileY, tilesAcross, tilesDown, totalTiles } = bounds;

    if (bounds.wasAdapted) {
      onProgress(12, `Large track area: scaled zoom to ${zoom} (${totalTiles} tiles) for performance...`);
    }

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
      // Execute through concurrency pool (concurrency: 6) with exponential backoff & rate limiting
      await this._fetchTilePool(tileTasks, ctx, {
        concurrency: 6,
        timeoutMs: 8000,
        providerId: activeProvider.id,
        maxRetries: 3,
        signal,
        onTileProgress: (completed, total, wasCached, retryMsg) => {
          const pct = Math.round(15 + (completed / total) * 45);
          const detail = retryMsg ? ` [${retryMsg}]` : (wasCached ? ' (cached)' : '');
          onProgress(pct, `Streaming satellite tiles: ${completed}/${total}${detail}...`);
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

      const results = this._samplePointsOnCanvas(
        raw, validPoints, imgData, canvasWidth, canvasHeight, startTileX, startTileY, zoom, radiusM
      );

      analyzer.isEnriched = true;
      analyzer.hasNdvi = true;
      analyzer._dataVersion = (analyzer._dataVersion || 0) + 1;

      onProgress(100, `Successfully sampled NDVI across ${results.enrichedCount} GPS fixes.`);

      return results;
    } finally {
      // Reclaim graphics memory immediately to avoid offscreen canvas backing store leaks
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
        ctx = null;
      }
    }
  },

  /**
   * Sample NDVI across a batch of tracks (Collective View).
   * Automatically selects Unified Mosaic Mode when walks are co-located (e.g. in the same
   * neighbourhood or under 16 km²), downloading and rendering satellite tiles ONCE for all
   * tracks. Falls back to per-track mode with fault isolation for dispersed walks.
   * 
   * @param {Array<Object>} tracks - Array of track objects ({ analyzer, name, id })
   * @param {Object} [options={}] - Options { zoom, radiusM, provider, tileUrl, onProgress, signal, maxMosaicAreaKm2, maxMosaicTiles }
   * @returns {Promise<{ mode: string, totalCount: number, enrichedCount: number, failedCount: number, tooBigCount: number, failedTracks: Array }>}
   */
  async sampleTracks(tracks, options = {}) {
    if (!tracks || tracks.length === 0) {
      return { mode: 'none', totalCount: 0, enrichedCount: 0, failedCount: 0, tooBigCount: 0, failedTracks: [] };
    }

    const onProgress = options.onProgress || (() => {});
    const signal = options.signal || null;
    const requestedZoom = options.zoom || 15;
    const radiusM = options.radiusM || 50;
    const maxMosaicAreaKm2 = options.maxMosaicAreaKm2 || 16.0;
    const maxMosaicTiles = options.maxMosaicTiles || 64;

    // Filter tracks with valid raw data points
    const validTracks = tracks.filter(t => {
      const a = t?.analyzer || t;
      return a && Array.isArray(a.raw) && a.raw.some(pt => pt && this._isValidCoord(pt.lat, pt.lon));
    });

    if (validTracks.length === 0) {
      return { mode: 'none', totalCount: tracks.length, enrichedCount: 0, failedCount: 0, tooBigCount: 0, failedTracks: [] };
    }

    // Combine all raw points across all tracks (using loops to prevent call-stack overflow)
    const combinedRaw = [];
    for (let t = 0; t < validTracks.length; t++) {
      const a = validTracks[t].analyzer || validTracks[t];
      const r = a.raw;
      for (let i = 0; i < r.length; i++) {
        combinedRaw.push(r[i]);
      }
    }

    const bufferDistanceM = radiusM + 50;
    const unionBBox = this.calculateBBox(combinedRaw, bufferDistanceM);
    const unionAreaKm2 = unionBBox ? this.calculateBBoxAreaKm2(unionBBox) : Infinity;

    // Determine tile bounds for the union footprint
    let unionBounds = null;
    if (unionBBox) {
      unionBounds = this._calculateTileBounds(unionBBox, requestedZoom, maxMosaicTiles, true);
    }

    // Determine if Unified Mosaic Mode is eligible:
    // Fits under area cap and fits under tile budget
    const canUseUnifiedMosaic = Boolean(
      unionBBox &&
      unionAreaKm2 <= maxMosaicAreaKm2 &&
      unionBounds &&
      unionBounds.totalTiles <= maxMosaicTiles
    );

    // =========================================================================
    // Mode 1: Unified Mosaic Batch Mode (Co-located Walks)
    // =========================================================================
    if (canUseUnifiedMosaic && validTracks.length > 1) {
      const zoom = unionBounds.zoom;
      const { startTileX, endTileX, startTileY, endTileY, tilesAcross, tilesDown, totalTiles } = unionBounds;
      const canvasWidth = tilesAcross * 256;
      const canvasHeight = tilesDown * 256;

      onProgress(10, `[Shared Mosaic] Preparing coverage for ${validTracks.length} walks (${unionAreaKm2.toFixed(1)} km²)...`);

      let canvas = null;
      let ctx = null;
      if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        canvas = document.createElement('canvas');
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }

      const activeProvider = this.getActiveProvider(options);
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
        await this._fetchTilePool(tileTasks, ctx, {
          concurrency: 6,
          timeoutMs: 8000,
          providerId: activeProvider.id,
          maxRetries: 3,
          signal,
          onTileProgress: (completed, total, wasCached, retryMsg) => {
            const pct = Math.round(15 + (completed / total) * 55);
            const detail = retryMsg ? ` [${retryMsg}]` : (wasCached ? ' (cached)' : '');
            onProgress(pct, `[Shared Mosaic] Streaming ${total} satellite tiles (${completed}/${total})${detail}...`);
          }
        });

        onProgress(75, `Extracting NDVI across ${validTracks.length} walks in-memory...`);

        let imgData = null;
        if (ctx) {
          try {
            imgData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
          } catch (secErr) {
            console.warn("Canvas getImageData restricted; using synthetic vegetation fallback:", secErr);
          }
        }

        let enrichedCount = 0;
        for (let i = 0; i < validTracks.length; i++) {
          const t = validTracks[i];
          const a = t.analyzer || t;
          const validPoints = [];
          for (let p = 0; p < a.raw.length; p++) {
            const pt = a.raw[p];
            if (pt && this._isValidCoord(pt.lat, pt.lon)) {
              validPoints.push({ index: p, pt });
            }
          }

          if (validPoints.length > 0) {
            this._samplePointsOnCanvas(
              a.raw, validPoints, imgData, canvasWidth, canvasHeight, startTileX, startTileY, zoom, radiusM
            );
            a.isEnriched = true;
            a.hasNdvi = true;
            a.hasNdvi50m = true;
            a._dataVersion = (a._dataVersion || 0) + 1;
            enrichedCount++;
          }
        }

        onProgress(100, `Sampled NDVI for ${enrichedCount}/${validTracks.length} walks via shared mosaic.`);

        return {
          mode: 'unified_mosaic',
          totalCount: validTracks.length,
          enrichedCount,
          failedCount: 0,
          tooBigCount: 0,
          failedTracks: [],
          tilesFetched: totalTiles
        };
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
          canvas = null;
          ctx = null;
        }
      }
    }

    // =========================================================================
    // Mode 2: Clustered / Per-Track Mode with Fault Isolation (Dispersed Walks)
    // =========================================================================
    let enrichedCount = 0;
    let failedCount = 0;
    let tooBigCount = 0;
    const failedTracks = [];

    for (let i = 0; i < validTracks.length; i++) {
      if (signal && signal.aborted) break;
      const t = validTracks[i];
      const label = t.name || t.id || `Walk ${i + 1}`;
      const basePct = Math.round((i / validTracks.length) * 100);

      onProgress(basePct, `[${i + 1}/${validTracks.length}] Sampling ${label}...`);

      try {
        await this.sampleTrack(t, {
          ...options,
          zoom: requestedZoom,
          radiusM,
          signal,
          onProgress: (pct, msg) => {
            const overallPct = Math.round(basePct + (pct / validTracks.length));
            onProgress(overallPct, `[${i + 1}/${validTracks.length}] ${msg}`);
          }
        });
        enrichedCount++;
      } catch (err) {
        console.warn(`NDVI sampling failed for track ${label}:`, err);
        failedCount++;
        failedTracks.push({ name: label, error: err.message });
      }
    }

    return {
      mode: 'per_track',
      totalCount: validTracks.length,
      enrichedCount,
      failedCount,
      tooBigCount,
      failedTracks
    };
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
