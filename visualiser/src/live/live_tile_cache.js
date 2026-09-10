/**
 * Offline tile caching for the live map — a Leaflet TileLayer subclass
 * backed by the Cache Storage API, plus the URL helpers it and
 * cacheCurrentMapArea() share. Loaded as a classic <script> AFTER Leaflet
 * (it calls L.TileLayer.extend at load time) and registers
 * L.tileLayer.cache(url, options).
 *
 * Pure helpers (no DOM, no module state): normalizeTileCacheUrl,
 * buildTileUrl, latLngToTileCoords — all require()-able for tests. The
 * subclass touches document/caches/fetch/URL directly, same as it did
 * inline in live.html.
 */

// Fold the CDN subdomain and drop the query string (the CARTO ?key=...), so
// every subdomain — and any key rotation — maps to one cache entry per tile.
function normalizeTileCacheUrl(url) {
  return url
    .replace(/https:\/\/[a-d]\.basemaps\.cartocdn\.com/, 'https://a.basemaps.cartocdn.com')
    .replace(/\?.*$/, '');
}

// Builds a tile URL for an arbitrary z/x/y directly from the layer's raw URL
// template, rather than through Leaflet's own TileLayer.getTileUrl(coords).
// That matters here specifically: real Leaflet's getTileUrl() IGNORES
// coords.z and substitutes the layer's own currently-displayed zoom instead
// (TileLayer.js's _getZoomForUrl() reads this._tileZoom, never the argument)
// — harmless during normal panning (Leaflet only ever asks for tiles at the
// zoom it's actually showing, so coords.z and _tileZoom always agree), but
// cacheCurrentMapArea() deliberately asks for zoom levels ABOVE the current
// one to pre-fetch detail for offline zooming-in. Going through getTileUrl()
// there would stamp every one of those requests with the CURRENT zoom's `z`
// while keeping the target zoom's x/y — a mismatched, invalid tile request
// the CDN 400s (and, lacking CORS headers on that error response, the
// browser reports as a blocked-by-CORS failure instead of the real cause).
function buildTileUrl(urlTemplate, x, y, z) {
  const retina = ((typeof window !== 'undefined' && window.devicePixelRatio || 1) > 1) ? '@2x' : '';
  return urlTemplate
    .replace('{s}', 'a') // any subdomain serves identical tiles; cache keys are normalized to 'a' anyway
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
    .replace('{r}', retina);
}

function latLngToTileCoords(latlng, zoom) {
  const lat = latlng.lat;
  const lon = latlng.lng;
  const x = Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
  return { x, y };
}

// ==========================================================================
// Custom Leaflet TileLayer subclass with a Cache Storage API backend.
// Normalizes the subdomain to 'a' to maximise cache reuse and minimise
// downloads. Registered as L.tileLayer.cache(url, options).
// ==========================================================================
if (typeof L !== 'undefined' && L.TileLayer) {
  const L_TileLayer_Cache = L.TileLayer.extend({
    createTile: function (coords, done) {
      const tile = document.createElement('img');
      L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
      L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));

      if (this.options.crossOrigin || this.options.crossOrigin === '') {
        tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
      }

      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      // Set initial source to a transparent 1x1 GIF to prevent flashing a broken image placeholder
      tile.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

      const url = this.getTileUrl(coords);
      const cacheUrl = normalizeTileCacheUrl(url);

      if (typeof caches !== 'undefined') {
        const cacheName = 'leaflet-map-tiles';
        caches.open(cacheName).then((cache) => {
          cache.match(cacheUrl).then((response) => {
            if (response) {
              response.blob().then((blob) => {
                const objUrl = URL.createObjectURL(blob);
                tile.src = objUrl;
                tile._objUrl = objUrl;
              });
            } else {
              fetch(url).then((netResponse) => {
                if (netResponse.ok) {
                  cache.put(cacheUrl, netResponse.clone());
                  netResponse.blob().then((blob) => {
                    const objUrl = URL.createObjectURL(blob);
                    tile.src = objUrl;
                    tile._objUrl = objUrl;
                  });
                } else {
                  tile.src = url;
                }
              }).catch(() => {
                tile.src = url;
              });
            }
          }).catch(() => {
            tile.src = url;
          });
        }).catch(() => {
          tile.src = url;
        });
      } else {
        tile.src = url;
      }

      return tile;
    },

    _cleanTile: function (tile) {
      if (tile._objUrl) {
        URL.revokeObjectURL(tile._objUrl);
        delete tile._objUrl;
      }
    },

    _removeTile: function (id) {
      const tile = this._tiles[id];
      if (tile) {
        this._cleanTile(tile.el);
      }
      L.TileLayer.prototype._removeTile.call(this, id);
    }
  });

  L.tileLayer.cache = function (url, options) {
    return new L_TileLayer_Cache(url, options);
  };
}

if (typeof window !== 'undefined') {
  window.normalizeTileCacheUrl = normalizeTileCacheUrl;
  window.buildTileUrl = buildTileUrl;
  window.latLngToTileCoords = latLngToTileCoords;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeTileCacheUrl, buildTileUrl, latLngToTileCoords };
}
