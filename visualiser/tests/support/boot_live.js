/**
 * Boots the REAL live.html (real DOM + its one inline <script> block,
 * unmodified) inside jsdom, mirroring tests/support/boot_app.js's approach
 * for index.html: parse the real file, stub the browser/hardware APIs it
 * can't have in Node (Leaflet, Web Bluetooth, Geolocation, Cache Storage,
 * fetch, canvas 2D, Wake Lock, Fullscreen), then run the real script text
 * in that DOM's context.
 *
 * live.html's own logic is a single inline block (its only <script src>
 * deps are gsr_filter.js and live_binary_parser.js), so unlike boot_app.js
 * there's no SCRIPT_ORDER — the two deps then the inline block are
 * extracted and run in order. Its top-level `const`/`class`/`function`
 * declarations (LiveState, GSRLiveBluetoothManager, resetSession,
 * goToLatLon, normalizeTileCacheUrl, ...) are NOT copied onto `window`
 * (plain classic-script `let`/`const` never is) — reach them through the
 * returned `context` with vm.runInContext('someName', context), the same
 * pattern test_map_layer_ownership.js already uses against boot_app.js's
 * context to null out bindings before boot.
 *
 * Scope, matching docs/archive/visualizer_test_coverage_plan.md's philosophy for
 * boot_app.js: this is for exercising real logic (gap detection, session
 * reset, tile-cache bookkeeping, location validation) without throwing —
 * NOT a faithful Leaflet reimplementation and NOT real Bluetooth GATT.
 * The Leaflet mock below tracks just enough (added layers, setView/panTo
 * calls, real L.TileLayer.extend() inheritance so `instanceof` checks in
 * cacheCurrentMapArea() work) to make assertions on live.html's own logic,
 * not on Leaflet's.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const LIVE_HTML_PATH = path.join(__dirname, '..', '..', 'live.html');
// live.html's <head> loads this via <script src="gsr_filter.js"> before its
// own inline <script> block runs — drawGraph() calls GsrFilter.* assuming
// it's already a page-level global by the time it executes. gsr_filter.js
// has no module.exports/window.X dual-export (unlike map_colors.js/
// gps_pipeline.js/live_binary_parser.js — it's only ever loaded as a
// classic <script>), so it can't be require()'d; running its real source
// in this same vm context first reproduces that real load order exactly.
const GSR_FILTER_PATH = path.join(__dirname, '..', '..', 'src', 'signal', 'gsr_filter.js');
// Also loaded via <script src> in live.html's <head>, before the inline
// block — the inline script does `new GSRLiveBinaryParser(...)` assuming
// it's already a page-level global. Run its real source in the vm context
// first, same as gsr_filter.js, to reproduce that load order.
const LIVE_BINARY_PARSER_PATH = path.join(__dirname, '..', '..', 'src', 'live', 'live_binary_parser.js');

function makeLeafletMock() {
  class Layer {
    addTo(map) { map._layers.push(this); this._map = map; return this; }
    setLatLng(latlng) { this._latlng = latlng; return this; }
    setStyle(style) { this._style = style; return this; }
  }
  class Polyline extends Layer {
    constructor(latlngs, options) { super(); this.latlngs = latlngs; this.options = options; }
  }
  class CircleMarker extends Layer {
    constructor(latlng, options) { super(); this.latlng = latlng; this.options = options; }
  }
  class TileLayer {
    // `_url` matches real Leaflet's own TileLayer property name exactly —
    // live.html's cacheCurrentMapArea() reads tileLayerInstance._url
    // directly (see buildTileUrl()'s doc comment for why it can't go
    // through getTileUrl() instead).
    constructor(urlTemplate, options) { this._url = urlTemplate; this.options = options || {}; this._tileZoom = undefined; }
    // Minimal subset of Leaflet's real {s}/{z}/{x}/{y}/{r} templating —
    // enough to produce a real-looking basemaps.cartocdn.com URL. This
    // DELIBERATELY reproduces real Leaflet's actual quirk (confirmed
    // against leaflet@1.9.4's source): the URL's {z} comes from the
    // layer's own _tileZoom (kept in sync with the map's current zoom by
    // addTo()/FakeMap.setView() below), NOT from coords.z — coords.z is
    // silently ignored, same as the real TileLayer.getTileUrl()/
    // _getZoomForUrl(). A mock that instead honored coords.z would be
    // "nicer" than the real library and could never catch live.html
    // going back to calling this method from cacheCurrentMapArea() (see
    // buildTileUrl()'s doc comment there for why it can't).
    getTileUrl(coords) {
      const subdomain = ['a', 'b', 'c', 'd'][Math.abs(coords.x + coords.y) % 4];
      const z = this._tileZoom !== undefined ? this._tileZoom : coords.z;
      return this._url
        .replace('{s}', subdomain)
        .replace('{z}', z)
        .replace('{x}', coords.x)
        .replace('{y}', coords.y)
        .replace('{r}', '');
    }
    addTo(map) { map._layers.push(this); this._map = map; this._tileZoom = map._zoom; return this; }
    // Real Leaflet's class-extension mechanism, minimally: a subclass whose
    // instances satisfy `instanceof L.TileLayer` — cacheCurrentMapArea()
    // relies on exactly that to find the active tile layer via eachLayer().
    static extend(members) {
      class Extended extends this {}
      Object.assign(Extended.prototype, members);
      return Extended;
    }
  }

  class FakeMap {
    constructor(elementId, options) {
      this._elementId = elementId;
      this.options = options;
      this._layers = [];
      this._center = { lat: 0, lng: 0 };
      this._zoom = 2;
      this.attributionControl = { setPrefix() {} };
      this.calls = { setView: [], panTo: [], invalidateSize: 0 };
    }
    setView(latlng, zoom) {
      this._center = { lat: latlng[0], lng: latlng[1] };
      this._zoom = zoom;
      this.calls.setView.push({ latlng, zoom });
      // Real Leaflet syncs every attached TileLayer's _tileZoom to the
      // map's current zoom on view changes — see the TileLayer class
      // comment above for why getTileUrl()'s use of that (over the
      // coords.z you pass it) matters.
      this._layers.forEach((layer) => { if (layer._tileZoom !== undefined) layer._tileZoom = zoom; });
      return this;
    }
    panTo(latlng, opts) {
      this._center = { lat: latlng[0], lng: latlng[1] };
      this.calls.panTo.push({ latlng, opts });
      return this;
    }
    getZoom() { return this._zoom; }
    getCenter() { return this._center; }
    // A small fixed-size box around the current center — real enough for
    // cacheCurrentMapArea()'s tile-enumeration math to produce a bounded,
    // deterministic set of tiles without needing real Leaflet's projection.
    getBounds() {
      const { lat, lng } = this._center;
      return {
        getNorthWest: () => ({ lat: lat + 0.01, lng: lng - 0.01 }),
        getSouthEast: () => ({ lat: lat - 0.01, lng: lng + 0.01 }),
      };
    }
    invalidateSize() { this.calls.invalidateSize++; }
    eachLayer(fn) { this._layers.forEach(fn); }
  }

  const tileLayerFn = (urlTemplate, options) => new TileLayer(urlTemplate, options);
  return {
    map: (elementId, options) => new FakeMap(elementId, options),
    tileLayer: tileLayerFn,
    polyline: (latlngs, options) => new Polyline(latlngs, options),
    circleMarker: (latlng, options) => new CircleMarker(latlng, options),
    TileLayer,
    DomEvent: { on: () => {} },
    Util: { bind: (fn, ctx) => fn.bind(ctx) },
  };
}

// A same-realm CacheStorage + fetch stand-in (see boot_app.js's Blob-realm
// caution comment for why this matters) — real enough for
// cacheCurrentMapArea()/createTile()'s cache.match/put bookkeeping, backed
// by a plain in-memory Map instead of a real disk cache.
function installCacheStorage(window) {
  window.Response = class {
    constructor(body, init = {}) {
      this._body = body;
      this.status = init.status === undefined ? 200 : init.status;
      this.ok = this.status >= 200 && this.status < 300;
    }
    clone() { return new window.Response(this._body, { status: this.status }); }
    async blob() { return this._body; }
  };

  const namedStores = new Map();
  window.caches = {
    async open(name) {
      if (!namedStores.has(name)) namedStores.set(name, new Map());
      const store = namedStores.get(name);
      return {
        async match(url) { return store.has(url) ? store.get(url) : undefined; },
        async put(url, response) { store.set(url, response); },
        async keys() { return [...store.keys()].map((url) => ({ url })); },
      };
    },
  };

  // Default fetch: succeeds instantly with a tiny fake body. Tests that
  // care about network-call counts (e.g. "does re-caching skip tiles it
  // already has") replace window.fetch with their own counting wrapper.
  window.fetch = async () => new window.Response('fake-tile-bytes', { status: 200 });
}

function installCanvas2DStub(window) {
  const noop = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform: noop, clearRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, stroke: noop, fill: noop, fillText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    save: noop, restore: noop,
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
  });
}

/**
 * Boots the real live.html in a fresh jsdom window.
 * Returns { window, document, context } — see file header for why `context`
 * (not `window`) is how tests reach live.html's own top-level bindings.
 */
function bootLive() {
  const html = fs.readFileSync(LIVE_HTML_PATH, 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;

  window.L = makeLeafletMock();
  window.confirm = () => true;
  window.alert = () => {};
  installCacheStorage(window);
  installCanvas2DStub(window);

  window.navigator.bluetooth = undefined; // present-but-unavailable by default; tests opt in per-case
  window.navigator.geolocation = {
    getCurrentPosition: (success) => success({ coords: { latitude: 51.5074, longitude: -0.1278 } }),
  };
  window.navigator.wakeLock = { request: async () => ({ released: false, release: async () => {} }) };
  window.document.documentElement.requestFullscreen = () => Promise.resolve();
  window.document.exitFullscreen = () => Promise.resolve();
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:mock-url');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});

  const inlineScriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!inlineScriptMatch) throw new Error('live.html: could not find its inline <script> block');

  const context = vm.createContext(window);
  vm.runInContext(fs.readFileSync(GSR_FILTER_PATH, 'utf8'), context, { filename: 'gsr_filter.js' });
  vm.runInContext(fs.readFileSync(LIVE_BINARY_PARSER_PATH, 'utf8'), context, { filename: 'live_binary_parser.js' });
  vm.runInContext(inlineScriptMatch[1], context, { filename: 'live.html (inline script)' });

  return { window, document: window.document, context };
}

module.exports = { bootLive };
