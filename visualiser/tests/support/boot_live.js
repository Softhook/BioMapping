/**
 * Boots the live view's real source files, unmodified, into a bare jsdom
 * document — mirroring tests/support/boot_app.js's approach for index.html,
 * but WITHOUT reading visualiser/live.html off disk. That file is just a
 * thin standalone host (load these same scripts, then
 * `GSRLiveView.mount(#liveRoot)`) — every real DOM element and event wiring
 * the tests exercise is built by GSRLiveView.mount() itself, not present in
 * live.html's raw markup, so this harness doesn't need the file to exist at
 * all; it builds an equivalent one-div document and calls mount() the same
 * way live.html's inline script (and index.html's view switcher) do. This
 * keeps the live_view test suite independent of whether the standalone page
 * is ever deleted.
 *
 * LIVE_SCRIPT_ORDER is the load order live.html's <head> currently uses,
 * kept in sync with the real file by test_html_wiring.js (which imports this
 * same array — the same cross-check boot_app.js's SCRIPT_ORDER gets against
 * index.html).
 *
 * ES-MODULE MIGRATION (see docs/visualizer_modularity_plan.md and
 * tests/manual/esm_migration/): loads each SCRIPT_ORDER entry through the
 * same tests/support/realm_bridge.js as boot_app.js — see that file's
 * header comment for the full realm-sharing rationale. A not-yet-converted
 * file's top-level `const`/`function` declarations (drawGraph in
 * live_graph.js, liveMap in live_map.js, resetSession / goToLatLon /
 * renderStatus in live_view.js, plus LiveState / GSRLiveBluetoothManager /
 * normalizeTileCacheUrl in their own modules) live in the shared realm's
 * lexical scope, not as a `window`/`global` property — reach them with
 * `vm.runInThisContext('someName')`, the same pattern
 * test_map_layer_ownership.js uses against boot_app.js. `bootLive()` is
 * async as a direct consequence of the shared realm bridge (dynamic
 * `import()` has no synchronous form).
 *
 * Scope, matching docs/archive/visualizer_test_coverage_plan.md's philosophy for
 * boot_app.js: this is for exercising real logic (gap detection, session
 * reset, tile-cache bookkeeping, location validation) without throwing —
 * NOT a faithful Leaflet reimplementation and NOT real Bluetooth GATT.
 * The Leaflet mock below tracks just enough (added layers, setView/panTo
 * calls, real L.TileLayer.extend() inheritance so `instanceof` checks in
 * cacheCurrentMapArea() work) to make assertions on the live view's own
 * logic, not on Leaflet's.
 */

const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { installMatchMedia } = require('./matchmedia_stub.js');
const { installJsdomGlobals, clearPreviousBoot, loadScriptFile } = require('./realm_bridge.js');

const APP_DIR = path.join(__dirname, '..', '..');

// Real script load order, copied from live.html's own <script src="..."> list
// (vendor/ Leaflet and config.js are stubbed/skipped instead — same call
// boot_app.js makes for index.html's CDN libs). Kept in sync with live.html
// by tests/test_html_wiring.js, which imports this exact array.
const LIVE_SCRIPT_ORDER = [
  'src/core/constants.js',
  'src/signal/gsr_filter.js',
  'src/signal/deconvolution.js',
  'src/signal/spectral_eda.js',
  'src/signal/analyzer_time_format.js',
  'src/signal/analyzer.js',
  'src/map/basemap.js',
  'src/map/map_colors.js',
  'src/gps/gps_pipeline.js',
  'src/core/file_saver.js',
  'src/live/live_binary_parser.js',
  'src/live/live_state.js',
  'src/live/live_bluetooth.js',
  'src/live/live_csv.js',
  'src/live/live_tile_cache.js',
  'src/live/live_graph.js',
  'src/live/live_map.js',
  'src/core/fullscreen.js',
  'src/map/map_markers.js',
  'src/live/live_view.js',
];

function makeLeafletMock() {
  class Layer {
    addTo(map) { map._layers.push(this); this._map = map; return this; }
    setLatLng(latlng) { this._latlng = latlng; return this; }
    setStyle(style) { this._style = style; return this; }
    remove() { if (this._map) this._map.removeLayer(this); return this; }
  }
  class Polyline extends Layer {
    constructor(latlngs, options) { super(); this.latlngs = latlngs; this.options = options; }
  }
  class CircleMarker extends Layer {
    constructor(latlng, options) { super(); this.latlng = latlng; this.options = options; }
  }
  class Marker extends Layer {
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
    removeLayer(layer) {
      const idx = this._layers.indexOf(layer);
      if (idx !== -1) this._layers.splice(idx, 1);
      return this;
    }
    on(event, handler) { return this; }
  }

  const tileLayerFn = (urlTemplate, options) => new TileLayer(urlTemplate, options);
  return {
    map: (elementId, options) => new FakeMap(elementId, options),
    tileLayer: tileLayerFn,
    polyline: (latlngs, options) => new Polyline(latlngs, options),
    circleMarker: (latlng, options) => new CircleMarker(latlng, options),
    // Peak/hotspot map markers (live view + GSRMapMarkers.build*Icon) — a
    // real Leaflet Marker + divIcon stand-in: `marker` tracks enough for the
    // live view's addTo/remove bookkeeping, and divIcon returns a faithful
    // `.options` bag so tests can assert which icon a marker was built with.
    marker: (latlng, options) => new Marker(latlng, options),
    divIcon: (options) => ({ options }),
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
    moveTo: noop, lineTo: noop, arc: noop, stroke: noop, fill: noop, fillText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    save: noop, restore: noop,
    strokeStyle: '', fillStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
  });
}

/**
 * Boots the live view's real source files into a bare one-div jsdom window,
 * then mounts GSRLiveView into it — the same two steps live.html's own
 * inline script performs, just without needing that file on disk.
 * Returns { window, document } — see file header for why a not-yet-
 * converted file's own top-level bindings need `vm.runInThisContext('someName')`
 * to reach, not a returned vm context (no separate context exists any more
 * in the shared-realm model).
 *
 * @param {{compact?: boolean}} [opts] - `compact: true` simulates a mobile
 *   device for GSRLiveView.isCompactLayout()'s matchMedia check. Defaults to
 *   `false` (desktop) so every existing caller is unaffected.
 */
async function bootLive({ compact = false } = {}) {
  clearPreviousBoot();
  const dom = new JSDOM('<!doctype html><html><body><div id="liveRoot"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;

  installMatchMedia(window, { compact });
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
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:mock-url');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  window.ResizeObserver = class {
    constructor(cb) { this._cb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.screen = window.screen || {};
  if (!window.screen.orientation) {
    const orientationListeners = [];
    window.screen.orientation = {
      type: 'portrait-primary',
      angle: 0,
      addEventListener: (type, fn) => { if (type === 'change') orientationListeners.push(fn); },
      removeEventListener: (type, fn) => {
        const idx = orientationListeners.indexOf(fn);
        if (idx !== -1) orientationListeners.splice(idx, 1);
      },
      dispatchEvent: (e) => {
        orientationListeners.forEach(fn => fn(e));
        return true;
      },
    };
  }

  installJsdomGlobals(window);

  for (const file of LIVE_SCRIPT_ORDER) {
    await loadScriptFile(APP_DIR, file, window);
  }
  vm.runInThisContext("GSRLiveView.mount(document.getElementById('liveRoot'))", { filename: 'boot_live.js (mount)' });

  return { window, document: window.document };
}

module.exports = { bootLive, LIVE_SCRIPT_ORDER };
