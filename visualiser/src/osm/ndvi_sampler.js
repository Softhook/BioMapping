/**
 * NDVISampler — Satellite NDVI Sampling via Copernicus Sentinel Hub
 *
 * Samples the real Sentinel-2 vegetation index — (B08-B04)/(B08+B04) — at
 * each GPS fix in a track, by requesting a single-band FLOAT32 GeoTIFF from
 * a *custom evalscript layer* on a Copernicus Data Space Sentinel Hub
 * instance (WMS, FORMAT=image/tiff;depth=32f) and decoding the float grid
 * directly. There is no colour-based inference anywhere in this path — the
 * stock Sentinel Hub `VEGETATION_INDEX` layer only ever returns a *rendered*
 * colour-ramp visualisation (regardless of requested format), which cannot
 * be reversed back into a real index value, so sampling requires its own raw
 * layer (see getRawLayerId(), default 'NDVI_RAW'; the evalscript and setup
 * steps are in docs/environmental_enrichment_plan.md §2E). Sampling refuses
 * to run without a configured Copernicus instance — it does not fall back to
 * guessing a value from someone else's rendered image.
 *
 *   - Point NDVI (`ndvi`): the raster pixel directly underfoot.
 *   - 50m Buffer Mean NDVI (`ndvi_50m`): circular mean over a buffer radius.
 *
 * A point with no usable pixel (cloud-masked, tile fetch failure, no data
 * this far from tracked coverage) is left as NaN and step-held from the
 * previous genuine reading — never fabricated from an unrelated column.
 *
 * The optional on-map NDVI overlay (map_manager_osm.js: showNdviLayer) is
 * rendered directly from this same raw raster — paintGreyscaleTile() maps
 * each decoded float to a grey pixel (low NDVI = black, high = white) — so
 * the picture and the sampled numbers are provably the same data, not two
 * independent server-side computations that could disagree. There is no
 * separate "rendered NDVI" layer any more. Without a Copernicus instance
 * configured at all, the map overlay falls back to plain imagery (EOX
 * cloudless, NASA GIBS, a custom XYZ template) shown as-is for visual
 * reference only — none of those feed the `ndvi`/`ndvi_50m` columns.
 *
 * Performance & reliability:
 *   - LRU in-memory tile cache (`_tileCache`) for instant multi-track and
 *     re-sampling reuse.
 *   - Bounded network concurrency pool (`_fetchRawTilePool`) with per-
 *     provider rate-limit tracking and exponential backoff, to avoid socket
 *     exhaustion and 429s.
 *   - Pre-computed circular pixel-offset masks (`_getCircularPixelOffsets`)
 *     for fast radial buffer extraction.
 *   - Credentials (instance ID / raw layer ID) live in localStorage or
 *     config.local.js only — never committed to git.
 */

const NDVISampler = {
  // Earth equatorial circumference in meters (EPSG:3857)
  EARTH_CIRCUMFERENCE_M: 40075016.686,

  // Imagery providers for the optional visual map overlay (map_manager_osm.js).
  // None of these feed the ndvi/ndvi_50m sampling columns — see file docstring.
  DEFAULT_TILE_URL: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  COPERNICUS_BASE_URL: 'https://sh.dataspace.copernicus.eu/ogc/wms',
  NASA_GIBS_URL: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png',
  DEFAULT_INSTANCE_ID: '', // Kept empty in codebase; stored strictly in user's browser localStorage
  DEFAULT_RAW_LAYER_ID: 'NDVI_RAW',           // Raw FLOAT32 evalscript layer (sampling + map overlay)
  DEFAULT_TIME_RANGE: '2024-05-01/2024-09-30',
  DEFAULT_MAXCC: 50,

  // ---------------------------------------------------------------------------
  // 1. Imagery Provider Registry — visual map overlay fallback ONLY, used when
  // no Copernicus instance is configured at all (so there's no raw raster to
  // render). None of these feed the ndvi/ndvi_50m sampling columns.
  // ---------------------------------------------------------------------------
  PROVIDERS: {
    sentinel2_cloudless: {
      id: 'sentinel2_cloudless',
      name: 'Sentinel-2 Cloudless Mosaic (EOX) — true colour imagery',
      type: 'xyz',
      urlTemplate: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
      attribution: 'Satellite imagery (true colour) © <a href="https://s2maps.eu" target="_blank">Sentinel-2 cloudless / EOX</a> — not a vegetation index',
      buildUrl: (tileX, tileY, zoom, options = {}) => {
        const tmpl = options.urlTemplate || NDVISampler.DEFAULT_TILE_URL;
        return tmpl.replace('{z}', zoom).replace('{x}', tileX).replace('{y}', tileY).replace('{s}', 'a');
      }
    },
    nasa_gibs: {
      id: 'nasa_gibs',
      name: 'NASA GIBS MODIS NDVI (rendered, ~250m/8-day, real vegetation product)',
      type: 'xyz',
      urlTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png',
      attribution: 'NASA GIBS / Earthdata MODIS NDVI — coarse-resolution visualisation, not sampled',
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
   * Register or override a satellite provider (visual overlay only).
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
   * Determine the active *fallback imagery* provider for the visual map
   * overlay — only consulted when no Copernicus instance is configured, in
   * which case there's no raw raster to render and showNdviLayer falls back
   * to showing one of these as-is (see file docstring).
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
    return this.PROVIDERS.sentinel2_cloudless;
  },

  /**
   * Resolve a visual-overlay tile request URL using the provider registry.
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
   * Read the active raw-sampling layer ID — a custom evalscript layer that
   * outputs single-band FLOAT32 NDVI (see docs/environmental_enrichment_plan.md
   * §2E for the evalscript). Used for both sampling and the map overlay —
   * see file docstring.
   * @returns {string}
   */
  getRawLayerId() {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const stored = localStorage.getItem('copernicus_raw_layer_id');
      if (stored && stored.trim()) return stored.trim();
    }
    if (typeof window !== 'undefined' && window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.copernicusRawLayerId) {
      return String(window.BIOMAP_CONFIG.copernicusRawLayerId).trim();
    }
    return this.DEFAULT_RAW_LAYER_ID;
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
      localStorage.removeItem('copernicus_raw_layer_id');
      localStorage.removeItem('copernicus_time_range');
    }
  },

  /**
   * Build a Copernicus WMS request URL for the *raw* single-band FLOAT32 NDVI
   * layer (see getRawLayerId()). This is what sampleTrack/sampleTracks fetch.
   * @param {number} tileX
   * @param {number} tileY
   * @param {number} zoom
   * @param {Object} [options={}]
   * @returns {string}
   */
  buildRawTileUrl(tileX, tileY, zoom, options = {}) {
    const bbox = this.tileToBbox(tileX, tileY, zoom);
    const instanceId = options.instanceId || this.getInstanceId();
    const layerId = options.rawLayerId || this.getRawLayerId();
    const timeRange = options.time || options.timeRange || this.getTimeRange();
    const maxcc = (typeof options.maxcc === 'number') ? options.maxcc : this.DEFAULT_MAXCC;
    const baseUrl = options.baseUrl || this.COPERNICUS_BASE_URL;
    return `${baseUrl}/${instanceId}?SERVICE=WMS&REQUEST=GetMap&LAYERS=${encodeURIComponent(layerId)}` +
      `&FORMAT=${encodeURIComponent('image/tiff;depth=32f')}&VERSION=1.3.0&CRS=EPSG:3857` +
      `&BBOX=${bbox.join(',')}&WIDTH=256&HEIGHT=256&TIME=${encodeURIComponent(timeRange)}&MAXCC=${maxcc}`;
  },

  // ---------------------------------------------------------------------------
  // 3. Tile Caching & Radial Sampling Optimization
  // ---------------------------------------------------------------------------
  _tileCache: new Map(),
  _offsetCache: new Map(),
  MAX_CACHE_TILES: 100,

  /**
   * Clear all cached satellite tiles (raw float grids and visual images)
   * and radial offset lookup tables.
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
  // 5. Raw NDVI Raster Decoding (single-band FLOAT32 TIFF)
  // ---------------------------------------------------------------------------

  // Sentinel Hub nodata sentinel emitted by the NDVI_RAW evalscript (see file
  // docstring) for cloud/no-coverage pixels. Real NDVI is bounded [-1, 1].
  NODATA_SENTINEL_THRESHOLD: -1.5,

  /**
   * Whether a decoded raster value is a genuine NDVI reading rather than the
   * evalscript's nodata sentinel or a NaN from a missing/failed tile.
   * @param {number} v
   * @returns {boolean}
   */
  _isValidNdvi(v) {
    return typeof v === 'number' && !isNaN(v) && v > this.NODATA_SENTINEL_THRESHOLD;
  },

  /**
   * Read a single TIFF IFD entry's value(s), following the offset pointer
   * when the value doesn't fit inline (TIFF 6.0 §2, "Value/Offset").
   * @private
   */
  _readTiffValue(view, entryOffset, little) {
    const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    const type = view.getUint16(entryOffset + 2, little);
    const count = view.getUint32(entryOffset + 4, little);
    const elemSize = TYPE_SIZES[type] || 1;
    const totalSize = elemSize * count;
    const valueFieldOffset = entryOffset + 8;
    const dataOffset = totalSize <= 4 ? valueFieldOffset : view.getUint32(valueFieldOffset, little);

    const readOne = (off) => {
      switch (type) {
        case 1: case 6: case 7: return view.getUint8(off);
        case 3: case 8: return view.getUint16(off, little);
        case 4: case 9: return view.getUint32(off, little);
        case 11: return view.getFloat32(off, little);
        case 12: return view.getFloat64(off, little);
        default: return view.getUint32(off, little);
      }
    };

    const vals = [];
    for (let i = 0; i < count; i++) vals.push(readOne(dataOffset + i * elemSize));
    return count === 1 ? vals[0] : vals;
  },

  /**
   * Inflate a zlib/Deflate-compressed byte range using the platform's native
   * Streams API — no vendored decompression library needed.
   * @private
   * @param {ArrayBuffer} bytes
   * @returns {Promise<ArrayBuffer>}
   */
  async _inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser has no DecompressionStream support, needed to decode the compressed NDVI raster.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).arrayBuffer();
  },

  /**
   * Parse a baseline-TIFF byte buffer into a single-band FLOAT32 pixel grid.
   * Handles exactly what a Sentinel Hub WMS request with
   * FORMAT=image/tiff;depth=32f against a { bands: 1, sampleType: "FLOAT32" }
   * evalscript can produce: one IFD, strip-organised (not tiled) samples,
   * either uncompressed or Deflate/Adobe-Deflate compressed strips, either
   * byte order. This is not a general-purpose TIFF/GeoTIFF reader.
   *
   * @param {ArrayBuffer} buffer
   * @returns {Promise<{ width: number, height: number, data: Float32Array }>}
   */
  async parseFloat32Tiff(buffer) {
    const view = new DataView(buffer);
    const bom = view.getUint16(0, false);
    if (bom !== 0x4949 && bom !== 0x4D4D) {
      throw new Error('NDVI raster response is not a TIFF (bad byte-order marker) — check the raw layer ID and FORMAT.');
    }
    const little = bom === 0x4949;
    if (view.getUint16(2, little) !== 42) {
      throw new Error('NDVI raster response is not a TIFF (bad magic number).');
    }

    const ifdOffset = view.getUint32(4, little);
    const numEntries = view.getUint16(ifdOffset, little);
    const tags = {};
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tagId = view.getUint16(entryOffset, little);
      tags[tagId] = this._readTiffValue(view, entryOffset, little);
    }

    const width = tags[256];
    const height = tags[257];
    const bitsPerSample = Array.isArray(tags[258]) ? tags[258][0] : tags[258];
    const compression = tags[259] || 1;
    const samplesPerPixel = tags[277] || 1;
    const rowsPerStrip = tags[278] || height;
    const stripOffsets = Array.isArray(tags[273]) ? tags[273] : [tags[273]];
    const stripByteCounts = Array.isArray(tags[279]) ? tags[279] : [tags[279]];
    const sampleFormat = tags[339] ? (Array.isArray(tags[339]) ? tags[339][0] : tags[339]) : 1;

    if (!width || !height) {
      throw new Error('NDVI raster response has no usable image dimensions.');
    }
    if (samplesPerPixel !== 1 || bitsPerSample !== 32 || sampleFormat !== 3) {
      throw new Error(
        `NDVI raw layer returned an unexpected raster format (samples=${samplesPerPixel}, bits=${bitsPerSample}, ` +
        `sampleFormat=${sampleFormat}) — expected single-band FLOAT32. Check the evalscript on layer "${this.getRawLayerId()}".`
      );
    }

    // Decode each strip (Compression 1 = none, 5 = LZW unsupported here, 8/32946 = Deflate),
    // then concatenate into one contiguous pixel-data buffer.
    const pixelBytes = new Uint8Array(width * height * 4);
    let writeOffset = 0;
    for (let s = 0; s < stripOffsets.length; s++) {
      const raw = buffer.slice(stripOffsets[s], stripOffsets[s] + stripByteCounts[s]);
      let decoded;
      if (compression === 1) {
        decoded = raw;
      } else if (compression === 8 || compression === 32946) {
        decoded = await this._inflate(raw);
      } else {
        throw new Error(`NDVI raster uses unsupported TIFF compression ${compression} (only none/Deflate are handled).`);
      }
      pixelBytes.set(new Uint8Array(decoded), writeOffset);
      writeOffset += decoded.byteLength;
    }

    const pixelView = new DataView(pixelBytes.buffer);
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++) {
      data[i] = pixelView.getFloat32(i * 4, little);
    }

    return { width, height, data };
  },

  // Real-world NDVI over land rarely goes much below -0.2 (water/snow) or
  // above ~0.9 (densest canopy); [-1, 1] is the full theoretical range.
  NDVI_GREYSCALE_MIN: -1,
  NDVI_GREYSCALE_MAX: 1,

  /**
   * Render a decoded raw NDVI tile as a greyscale ImageData-equivalent
   * directly on a canvas context — an exact forward mapping of the same
   * float value used for sampling (low NDVI = black, high = white), not a
   * reconstruction or guess. Used by the map's NDVI overlay so the picture
   * and the sampled numbers are provably the same data (see file docstring).
   * Nodata/sentinel pixels are rendered fully transparent.
   *
   * @param {{width:number, height:number, data:Float32Array}} rasterTile
   * @param {CanvasRenderingContext2D} ctx
   */
  paintGreyscaleTile(rasterTile, ctx) {
    const { width, height, data } = rasterTile;
    const imgData = ctx.createImageData(width, height);
    const out = imgData.data;
    const range = this.NDVI_GREYSCALE_MAX - this.NDVI_GREYSCALE_MIN;

    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const o = i * 4;
      if (!this._isValidNdvi(v)) {
        out[o + 3] = 0; // transparent nodata
        continue;
      }
      const clamped = Math.max(this.NDVI_GREYSCALE_MIN, Math.min(this.NDVI_GREYSCALE_MAX, v));
      const grey = Math.round(((clamped - this.NDVI_GREYSCALE_MIN) / range) * 255);
      out[o] = grey;
      out[o + 1] = grey;
      out[o + 2] = grey;
      out[o + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
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
   * Fetch and decode one raw NDVI raster tile, with rate-limit enforcement,
   * exponential backoff, and status-code-aware retry. A malformed/unexpected
   * raster (wrong band count, bad TIFF, etc.) is a configuration problem, not
   * a transient failure, so it throws immediately rather than retrying.
   *
   * @param {string} url
   * @param {Object} [options={}] - { providerId, maxRetries, timeoutMs, signal, onRetry }
   * @returns {Promise<{width:number,height:number,data:Float32Array}|null>} null = exhausted retries on a transient failure
   */
  async _fetchRawTileWithBackoff(url, options = {}) {
    const providerId = options.providerId || 'copernicus_raw';
    const maxRetries = (typeof options.maxRetries === 'number') ? options.maxRetries : 3;
    const timeoutMs = options.timeoutMs || 8000;
    const signal = options.signal || null;
    const onRetry = options.onRetry || (() => {});

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal && signal.aborted) return null;
      await this._enforceRateLimit(providerId);

      let response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await fetch(url, { mode: 'cors', signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      } catch (networkErr) {
        if (attempt < maxRetries) {
          const waitMs = this._backoffMs(attempt, 400);
          onRetry(attempt + 1, waitMs, networkErr.message || 'Network error');
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`Could not reach the Copernicus WMS endpoint: ${networkErr.message || networkErr}`);
      }

      if (response.ok) {
        const buf = await response.arrayBuffer();
        // Format/config errors propagate straight to the caller — retrying
        // won't fix a missing or misconfigured evalscript layer.
        return await this.parseFloat32Tiff(buf);
      }

      if (response.status === 429 || response.status === 509) {
        const retryAfter = this._retryAfterMs(response, 5000 * Math.pow(2, attempt));
        this._providerRateLimits.set(providerId, Date.now() + retryAfter);
        if (attempt < maxRetries) {
          onRetry(attempt + 1, retryAfter, `Rate limited (HTTP ${response.status})`);
          await new Promise(r => setTimeout(r, retryAfter));
          continue;
        }
        return null;
      }

      if (response.status >= 500) {
        if (attempt < maxRetries) {
          const waitMs = this._backoffMs(attempt, 500);
          onRetry(attempt + 1, waitMs, `Server error (HTTP ${response.status})`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return null;
      }

      // 400/404/other client errors: not retryable — almost always a bad
      // instance ID or a raw layer that doesn't exist yet.
      throw new Error(
        `NDVI raw layer request failed (HTTP ${response.status}) — check that layer "${this.getRawLayerId()}" ` +
        `exists on the configured Copernicus instance (Satellite & NDVI Settings).`
      );
    }

    return null;
  },

  /**
   * Copy a decoded tile's float grid into its place in a larger mosaic grid.
   * @private
   */
  _writeTileIntoMosaic(tile, mosaic, mosaicWidth, destX, destY) {
    const { width, height, data } = tile;
    for (let y = 0; y < height; y++) {
      const srcStart = y * width;
      const dstStart = (destY + y) * mosaicWidth + destX;
      mosaic.set(data.subarray(srcStart, srcStart + width), dstStart);
    }
  },

  /**
   * Execute raw-tile downloads through a worker pool with bounded concurrency
   * and backoff, writing each decoded tile directly into a shared mosaic grid.
   * @private
   */
  async _fetchRawTilePool(tasks, mosaic, mosaicWidth, options = {}) {
    const concurrency = Math.max(1, options.concurrency || 6);
    const timeoutMs = options.timeoutMs || 8000;
    const onTileProgress = options.onTileProgress || options.onProgress || (() => {});
    const signal = options.signal || null;
    const providerId = options.providerId || 'copernicus_raw';
    const maxRetries = (typeof options.maxRetries === 'number') ? options.maxRetries : 3;

    let nextIdx = 0;
    let completed = 0;
    let loaded = 0;
    let cached = 0;
    let failed = 0;
    const total = tasks.length;

    const worker = async () => {
      while (nextIdx < total) {
        if (signal && signal.aborted) break;
        const current = nextIdx++;
        const task = tasks[current];
        const cachedTile = this._getTileCache(task.url);

        if (cachedTile) {
          this._writeTileIntoMosaic(cachedTile, mosaic, mosaicWidth, task.destX, task.destY);
          cached++;
          loaded++;
          completed++;
          onTileProgress(completed, total, true);
          continue;
        }

        const tile = await this._fetchRawTileWithBackoff(task.url, {
          timeoutMs,
          signal,
          providerId,
          maxRetries,
          onRetry: (attempt, waitMs, reason) => {
            onTileProgress(completed, total, false, `Tile retry (${attempt}/${maxRetries}): ${reason}`);
          }
        });

        if (tile) {
          this._putTileCache(task.url, tile);
          this._writeTileIntoMosaic(tile, mosaic, mosaicWidth, task.destX, task.destY);
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
   * Sample pixels within a circular buffer radius on a float NDVI grid.
   * High-performance traversal using pre-computed integer circular offsets.
   *
   * @param {Float32Array} data - NDVI grid values, row-major
   * @param {number} width - Grid width in pixels
   * @param {number} height - Grid height in pixels
   * @param {number} cx - Center pixel X
   * @param {number} cy - Center pixel Y
   * @param {number} radiusPx - Buffer radius in pixels
   * @returns {number} Mean NDVI within the circular buffer, or NaN if nothing valid was in range
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
        const val = data[y * width + x];
        if (this._isValidNdvi(val)) {
          sum += val;
          count++;
        }
      }
    }

    if (count === 0) {
      const cX = Math.max(0, Math.min(width - 1, intCx));
      const cY = Math.max(0, Math.min(height - 1, intCy));
      const cVal = data[cY * width + cX];
      return this._isValidNdvi(cVal) ? Math.round(cVal * 1000) / 1000 : NaN;
    }

    return Math.round((sum / count) * 1000) / 1000;
  },

  /**
   * Core sampling loop: extracts Point NDVI and radial buffer NDVI from a
   * decoded float grid. A point whose pixel is nodata/missing is left as NaN
   * — never fabricated from an unrelated column — and picked up later by
   * step-hold from the previous genuine reading.
   * @private
   */
  _samplePointsOnGrid(raw, validPoints, grid, gridWidth, gridHeight, startTileX, startTileY, zoom, radiusM) {
    let sumNdvi = 0;
    let sumNdvi50m = 0;
    let pointCount = 0;
    let bufferCount = 0;

    for (let i = 0; i < validPoints.length; i++) {
      const pt = validPoints[i].pt || validPoints[i];
      const coords = this.latLonToTile(pt.lat, pt.lon, zoom);
      const gridX = coords.worldX - (startTileX * 256);
      const gridY = coords.worldY - (startTileY * 256);
      const radiusPx = this.metersToPixels(radiusM, pt.lat, zoom);

      let pNdvi = NaN;
      let bNdvi = NaN;

      if (grid) {
        const cX = Math.max(0, Math.min(gridWidth - 1, Math.round(gridX)));
        const cY = Math.max(0, Math.min(gridHeight - 1, Math.round(gridY)));
        const pointVal = grid[cY * gridWidth + cX];
        pNdvi = this._isValidNdvi(pointVal) ? Math.round(pointVal * 1000) / 1000 : NaN;
        bNdvi = this.sampleBuffer(grid, gridWidth, gridHeight, gridX, gridY, radiusPx);
      }

      pt.ndvi = pNdvi;
      pt.ndvi_50m = bNdvi;

      if (!isNaN(pNdvi)) { sumNdvi += pNdvi; pointCount++; }
      if (!isNaN(bNdvi)) { sumNdvi50m += bNdvi; bufferCount++; }
    }

    // Propagate to non-GPS rows via forward step-hold
    this._stepHoldValues(raw, ['ndvi', 'ndvi_50m']);

    return {
      sampleCount: validPoints.length,
      enrichedCount: pointCount,
      meanNdvi: pointCount > 0 ? (sumNdvi / pointCount) : 0,
      meanNdvi50m: bufferCount > 0 ? (sumNdvi50m / bufferCount) : 0
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
   * Sample Point NDVI and 50m Buffer Mean NDVI for all GPS fixes in a track,
   * from the real NDVI raster (see file docstring). Requires a configured
   * Copernicus instance with a working raw layer — throws otherwise rather
   * than guessing from a rendered image.
   *
   * @param {Object} track - Track object with track.analyzer
   * @param {Object} [options={}] - Options { zoom, radiusM, onProgress, signal, maxTiles, adaptiveZoom, rawLayerId }
   * @returns {Promise<{ sampleCount: number, enrichedCount: number, meanNdvi: number, meanNdvi50m: number }>}
   */
  async sampleTrack(track, options = {}) {
    if (!this.hasCopernicusConfig()) {
      throw new Error(
        'Satellite NDVI sampling needs a Copernicus Sentinel Hub instance ID with a raw NDVI layer configured ' +
        '(Satellite & NDVI Settings) — see docs/environmental_enrichment_plan.md §2E for the evalscript and setup steps.'
      );
    }

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

    const gridWidth = tilesAcross * 256;
    const gridHeight = tilesDown * 256;
    const grid = new Float32Array(gridWidth * gridHeight).fill(NaN);

    onProgress(15, `Fetching ${totalTiles} NDVI raster tiles (${tilesAcross}×${tilesDown})...`);

    const tileTasks = [];
    for (let ty = startTileY; ty <= endTileY; ty++) {
      for (let tx = startTileX; tx <= endTileX; tx++) {
        const destX = (tx - startTileX) * 256;
        const destY = (ty - startTileY) * 256;
        const url = this.buildRawTileUrl(tx, ty, zoom, options);
        tileTasks.push({ url, destX, destY });
      }
    }

    // Execute through concurrency pool (concurrency: 6) with exponential backoff & rate limiting
    await this._fetchRawTilePool(tileTasks, grid, gridWidth, {
      concurrency: 6,
      timeoutMs: 8000,
      providerId: 'copernicus_raw',
      maxRetries: 3,
      signal,
      onTileProgress: (completed, total, wasCached, retryMsg) => {
        const pct = Math.round(15 + (completed / total) * 45);
        const detail = retryMsg ? ` [${retryMsg}]` : (wasCached ? ' (cached)' : '');
        onProgress(pct, `Streaming NDVI raster tiles: ${completed}/${total}${detail}...`);
      }
    });

    onProgress(60, "Extracting Point NDVI and 50m buffer values...");

    const results = this._samplePointsOnGrid(
      raw, validPoints, grid, gridWidth, gridHeight, startTileX, startTileY, zoom, radiusM
    );

    analyzer.isEnriched = true;
    analyzer.hasNdvi = true;
    analyzer.hasNdvi50m = true;
    analyzer._dataVersion = (analyzer._dataVersion || 0) + 1;

    onProgress(100, `Successfully sampled NDVI across ${results.enrichedCount} GPS fixes.`);

    return results;
  },

  /**
   * Sample NDVI across a batch of tracks (Collective View).
   * Automatically selects Unified Mosaic Mode when walks are co-located (e.g. in the same
   * neighbourhood or under 16 km²), downloading and decoding satellite tiles ONCE for all
   * tracks. Falls back to per-track mode with fault isolation for dispersed walks.
   *
   * @param {Array<Object>} tracks - Array of track objects ({ analyzer, name, id })
   * @param {Object} [options={}] - Options { zoom, radiusM, onProgress, signal, maxMosaicAreaKm2, maxMosaicTiles }
   * @returns {Promise<{ mode: string, totalCount: number, enrichedCount: number, failedCount: number, tooBigCount: number, failedTracks: Array }>}
   */
  async sampleTracks(tracks, options = {}) {
    if (!tracks || tracks.length === 0) {
      return { mode: 'none', totalCount: 0, enrichedCount: 0, failedCount: 0, tooBigCount: 0, failedTracks: [] };
    }

    if (!this.hasCopernicusConfig()) {
      throw new Error(
        'Satellite NDVI sampling needs a Copernicus Sentinel Hub instance ID with a raw NDVI layer configured ' +
        '(Satellite & NDVI Settings) — see docs/environmental_enrichment_plan.md §2E for the evalscript and setup steps.'
      );
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
      const gridWidth = tilesAcross * 256;
      const gridHeight = tilesDown * 256;
      const grid = new Float32Array(gridWidth * gridHeight).fill(NaN);

      onProgress(10, `[Shared Mosaic] Preparing coverage for ${validTracks.length} walks (${unionAreaKm2.toFixed(1)} km²)...`);

      const tileTasks = [];
      for (let ty = startTileY; ty <= endTileY; ty++) {
        for (let tx = startTileX; tx <= endTileX; tx++) {
          const destX = (tx - startTileX) * 256;
          const destY = (ty - startTileY) * 256;
          const url = this.buildRawTileUrl(tx, ty, zoom, options);
          tileTasks.push({ url, destX, destY });
        }
      }

      await this._fetchRawTilePool(tileTasks, grid, gridWidth, {
        concurrency: 6,
        timeoutMs: 8000,
        providerId: 'copernicus_raw',
        maxRetries: 3,
        signal,
        onTileProgress: (completed, total, wasCached, retryMsg) => {
          const pct = Math.round(15 + (completed / total) * 55);
          const detail = retryMsg ? ` [${retryMsg}]` : (wasCached ? ' (cached)' : '');
          onProgress(pct, `[Shared Mosaic] Streaming ${total} NDVI raster tiles (${completed}/${total})${detail}...`);
        }
      });

      onProgress(75, `Extracting NDVI across ${validTracks.length} walks in-memory...`);

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
          this._samplePointsOnGrid(
            a.raw, validPoints, grid, gridWidth, gridHeight, startTileX, startTileY, zoom, radiusM
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
