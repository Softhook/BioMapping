/**
 * Smoke-test harness: boots the REAL app (real index.html DOM + every real
 * visualiser/*.js source file, unmodified, in the exact order
 * index.html loads them) inside jsdom, with a hand-rolled stand-in for the
 * CDN libraries (Leaflet, p5, JSZip) instead of loading them for
 * real.
 *
 * This is deliberately NOT trying to be a faithful Leaflet/p5 reimplementation
 * — per-function unit coverage of the DOM/Leaflet/p5 rendering glue
 * (map.js/ui.js/events.js/sketch.js/layout_manager.js) was explicitly scoped
 * OUT in favor of lighter smoke coverage: "does the real app boot and run its
 * core flows without throwing." `superMock()` below is a universal auto-mock:
 * any property access or function call on it returns another superMock,
 * infinitely chainable, never throws, and numeric coercion (Symbol.toPrimitive)
 * resolves to 0 so downstream arithmetic (canvas sizing, coordinate math)
 * degrades to harmless zeros instead of throwing or producing NaN-typed
 * errors. That's intentional — it means every Leaflet/p5 call the app makes
 * "succeeds" harmlessly without us having to hand-implement Leaflet/p5's API
 * surface. The tradeoff: these tests catch "the app throws an uncaught
 * exception" and "app-level state ends up wrong" bugs, NOT "the map renders
 * the wrong pixels" bugs — that class of bug is out of scope here by design
 * (see docs/archive/visualizer_test_coverage_plan.md).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const APP_DIR = path.join(__dirname, '..', '..');

// Real script load order, copied from index.html's own <script src="...">
// list (local app files only — the 4 CDN libraries are stubbed instead).
// Kept byte-for-byte in sync with index.html by tests/support/test_script_order.js.
const SCRIPT_ORDER = [
  'src/core/notices.js', 'src/core/app_state.js', 'src/core/layout_manager.js', 'src/core/constants.js',
  'src/gps/geo_utils.js', 'src/spatial/spatial_grid.js', 'src/core/file_saver.js',
  'src/signal/stats_math.js', 'src/osm/overpass_client.js', 'src/osm/osm_cache.js', 'src/signal/dwt_filter.js', 'src/signal/deconvolution.js',
  'src/signal/csv_parser.js', 'src/signal/analyzer_time_format.js', 'src/signal/analyzer.js', 'src/osm/osm_enrichment.js', 'src/gps/map_match.js', 'src/signal/gsr_filter.js', 'src/render/marching_squares.js',
  'src/map/hillshade.js', 'src/spatial/spatial_clustering.js', 'src/spatial/collective_manager.js', 'src/gps/gps_filter.js', 'src/map/map_colors.js', 'src/gps/gps_pipeline.js',
  'src/render/label_placement.js', 'src/render/bezier_spline.js', 'src/render/contour_ring_geometry.js', 'src/map/map_exporter.js', 'src/render/rf_fluid_renderer.js', 'src/map/map_popups.js', 'src/map/map.js', 'src/map/map_manager_process.js', 'src/map/map_manager_legend.js', 'src/map/map_manager_layers.js', 'src/map/map_manager_osm.js', 'src/map/map_manager_rf_fluid.js', 'src/map/map_manager_viewport.js', 'src/map/map_manager_render.js', 'src/map/map_manager_path.js', 'src/map/map_manager_peaks.js', 'src/map/map_manager_collective.js', 'src/map/map_manager_toggles.js',
  'src/map/globe3d/exporters.js', 'src/map/globe3d/rf_expanse.js', 'src/map/globe3d/buildings.js',
  'src/map/globe3d.js', 'src/map/globe3d_view.js', 'src/ui/storage.js',
  'src/ui/events.js', 'src/ui/tracks.js', 'src/spatial/collective_project.js', 'src/ui/ui.js', 'src/render/renderer.js', 'src/render/sketch.js',
];

// p5 "global mode" functions/constants referenced as bare identifiers by
// renderer.js/sketch.js (grepped from source, not guessed).
const P5_GLOBAL_NAMES = [
  'background', 'beginShape', 'color', 'constrain', 'curveVertex',
  'endShape', 'fill', 'line', 'noFill', 'noLoop', 'noStroke', 'push', 'pop',
  'rect', 'redraw', 'resizeCanvas', 'stroke', 'strokeWeight', 'text', 'textAlign',
  'textSize', 'textStyle', 'vertex', 'loop',
];
const P5_CONSTANTS = { CENTER: 'center', LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom', CLOSE: 'close' };

// CAUTION if reusing this outside bootApp()'s jsdom context: `new Blob([superMock()])`
// against Node's *native* global Blob crashes the whole process with a native
// V8 assertion ("Incorrect Blob initialization type") instead of throwing a
// catchable error — verified directly. It does NOT crash inside bootApp()'s
// tests today because vm.runInContext(..., window) resolves `Blob` to jsdom's
// own pure-JS Blob polyfill (window.Blob !== Node's global Blob), which
// coerces the mock via its parts' Symbol.toPrimitive/toString instead of
// hitting Node's native code path. Don't pass a superMock() to Node's native
// `Blob` constructor directly (e.g. in a test that doesn't go through jsdom).
function superMock() {
  const fn = function () { return superMock(); };
  const handler = {
    get(target, prop) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined; // never look like a Promise/thenable
      if (prop === Symbol.toPrimitive) return (hint) => (hint === 'string' ? '' : 0);
      if (prop === Symbol.iterator) return function* () {}; // empty iterator — a for-of over a mock just does nothing
      if (!(prop in target)) target[prop] = superMock();
      return target[prop];
    },
    set(target, prop, value) { target[prop] = value; return true; },
    apply() { return superMock(); },
    construct() { return superMock(); },
  };
  return new Proxy(fn, handler);
}

/**
 * Boots the real app in a fresh jsdom window and returns { window, document }.
 * Each call is fully isolated (new jsdom instance, new AppState, etc).
 */
function bootApp() {
  const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  // runScripts: "outside-only" parses the real DOM (every real element ID
  // intact) but does NOT execute any <script> tag itself — including the 4
  // CDN <script src="https://..."> tags, so no network access happens.
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;

  window.L = superMock();
  // jsdom doesn't implement ResizeObserver (a real browser API) — a no-op
  // stand-in is enough since these tests don't simulate element resizing.
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // jsdom doesn't implement the Blob-URL pair either (browser-only, used by
  // file_saver.js's direct-download fallback) — a no-op stand-in is enough
  // since these tests don't need the resulting URL to be dereferenceable.
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:mock-url');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});

  for (const name of P5_GLOBAL_NAMES) window[name] = superMock();
  for (const [name, value] of Object.entries(P5_CONSTANTS)) window[name] = value;
  // createCanvas needs a real DOM node: sketch.js calls real DOM APIs on the
  // result (`.elt.addEventListener(...)`, `.elt.oncontextmenu = ...`), which
  // a generic superMock would harmlessly no-op but a real jsdom <canvas>
  // handles faithfully (real listeners actually fire on real dispatched
  // events, useful if a later test wants to simulate a canvas interaction).
  window.createCanvas = (w, h) => ({ parent: () => {}, elt: window.document.createElement('canvas'), width: w, height: h });
  window.map = (value, start1, stop1, start2, stop2) =>
    start2 + (stop2 - start2) * ((value - start1) / (stop1 - start1)); // p5's real remap semantics — cheap and worth getting right since it's plain arithmetic

  window.JSZip = superMock();

  const context = vm.createContext(window);
  for (const file of SCRIPT_ORDER) {
    const src = fs.readFileSync(path.join(APP_DIR, file), 'utf8');
    vm.runInContext(src, context, { filename: file });
  }

  // `context` is exposed so tests can null out optional top-level class
  // bindings (e.g. RFFluidRenderer / GSRSpatialClustering) via
  // vm.runInContext before window.setup() — the app's own
  // `typeof X !== 'undefined'` guards make that a supported configuration.
  return { window, document: window.document, context };
}

module.exports = { bootApp, superMock, SCRIPT_ORDER };
