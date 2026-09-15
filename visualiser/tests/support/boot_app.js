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
 *
 * ES-MODULE MIGRATION (see docs/visualizer_modularity_plan.md and
 * tests/manual/esm_migration/): as src/ files convert from the dual-mode
 * tail to real export/import (getting a temporary .mjs extension along the
 * way — see convert_file.js), tests/support/realm_bridge.js loads each one
 * of two ways — not yet converted (still .js): `vm.runInThisContext(src)`,
 * run in NODE'S OWN real global realm, NOT a separate `vm.createContext`
 * (Pattern A's existing tests already establish this technique: a separate
 * context breaks Array/Object prototype identity across
 * `assert.deepStrictEqual`; running in this realm keeps it correct); already
 * converted (.mjs exists): `await import()`, the real ES module — which
 * necessarily executes in this SAME real Node realm too, so a not-yet-
 * converted file's bare reference to an already-converted name still
 * resolves. Both paths therefore share ONE realm, which is what makes mixing
 * converted and unconverted files during the migration possible at all.
 * `bootApp()` is async as a direct consequence — dynamic `import()` has no
 * synchronous form in Node.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { installMatchMedia } = require('./matchmedia_stub.js');
const { superMock, installJsdomGlobals, clearPreviousBoot, loadScriptFile } = require('./realm_bridge.js');

const APP_DIR = path.join(__dirname, '..', '..');

// Real script load order, copied from index.html's own <script src="...">
// list (local app files only — the 4 CDN libraries are stubbed instead).
// Kept byte-for-byte in sync with index.html by tests/support/test_script_order.js.
// NOTE: during the ES-module migration this stays the list of ORIGINAL .js
// paths — realm_bridge.js's resolveFile() transparently swaps in a file's
// .mjs sibling once it's been converted, so this array itself needs no
// edits per file.
const SCRIPT_ORDER = [
  'src/core/notices.js', 'src/core/app_state.js', 'src/core/fullscreen.js', 'src/core/layout_manager.js', 'src/core/constants.js',
  'src/gps/geo_utils.js', 'src/spatial/spatial_grid.js', 'src/core/file_saver.js',
  'src/signal/stats_math.js', 'src/osm/overpass_client.js', 'src/osm/osm_cache.js', 'src/signal/dwt_filter.js', 'src/signal/deconvolution.js', 'src/signal/cvxeda.js',
  'src/signal/csv_parser.js', 'src/signal/spectral_eda.js', 'src/signal/analyzer_time_format.js', 'src/signal/response_dynamics.js', 'src/signal/analyzer.js', 'src/osm/osm_enrichment.js', 'src/osm/ndvi_sampler.js', 'src/gps/map_match.js', 'src/signal/gsr_filter.js', 'src/render/marching_squares.js',
  'src/map/hillshade.js', 'src/spatial/spatial_clustering.js', 'src/spatial/arousal_places.js', 'src/spatial/collective_manager.js', 'src/gps/gps_filter.js', 'src/map/basemap.js', 'src/map/map_colors.js', 'src/gps/gps_pipeline.js', 'src/map/map_markers.js',
  'src/live/live_binary_parser.js', 'src/live/live_state.js', 'src/live/live_bluetooth.js', 'src/live/live_csv.js', 'src/live/live_tile_cache.js', 'src/live/live_graph.js', 'src/live/live_map.js', 'src/live/live_view.js',
  'src/render/label_placement.js', 'src/render/bezier_spline.js', 'src/render/contour_ring_geometry.js', 'src/map/map_exporter.js', 'src/render/rf_fluid_renderer.js', 'src/map/map_popups.js', 'src/map/map.js', 'src/map/map_manager_process.js', 'src/map/map_manager_legend.js', 'src/map/map_manager_layers.js', 'src/map/map_manager_osm.js', 'src/map/map_manager_rf_fluid.js', 'src/map/map_manager_viewport.js', 'src/map/map_manager_render.js', 'src/map/map_manager_path.js', 'src/map/map_manager_peaks.js', 'src/map/map_manager_arousal_places.js', 'src/map/map_manager_collective.js', 'src/map/map_manager_toggles.js',
  'src/map/globe3d/exporters.js', 'src/map/globe3d/rf_expanse.js', 'src/map/globe3d/buildings.js',
  'src/map/globe3d.js', 'src/map/globe3d_osm.js', 'src/map/globe3d_rf.js', 'src/map/globe3d_peaks.js', 'src/map/globe3d_toggles.js', 'src/map/globe3d_navigation.js', 'src/map/globe3d_tour.js', 'src/map/globe3d_view.js', 'src/ui/storage.js',
  'src/ui/events.js', 'src/ui/tracks.js', 'src/spatial/collective_project.js', 'src/ui/ui.js',
  'src/ui/ui_peaks_table.js', 'src/ui/ui_stats_panel.js', 'src/ui/ui_collective_map.js',
  'src/ui/ui_export.js', 'src/ui/ui_osm_overlay.js', 'src/ui/ui_enrichment.js',
  'src/ui/ui_correlation_table.js', 'src/ui/ui_road_profile.js',
  'src/ui/ui_environmental_dashboard.js', 'src/ui/ui_modals.js',
  'src/render/renderer.js', 'src/render/renderer_bands.js', 'src/render/renderer_curve.js', 'src/render/renderer_markers.js', 'src/render/renderer_interaction.js', 'src/render/renderer_chrome.js', 'src/render/sketch.js',
];

// p5 "global mode" functions/constants referenced as bare identifiers by
// renderer.js/sketch.js (grepped from source, not guessed).
const P5_GLOBAL_NAMES = [
  'background', 'beginShape', 'color', 'constrain', 'curveVertex',
  'endShape', 'fill', 'line', 'noFill', 'noLoop', 'noStroke', 'push', 'pop',
  'rect', 'redraw', 'resizeCanvas', 'stroke', 'strokeWeight', 'text', 'textAlign',
  'textSize', 'textStyle', 'vertex', 'loop',
  // p5 mouse/canvas state, also referenced bare — must exist on `window` at
  // boot time so installJsdomGlobals's live accessor bridge picks them up; a
  // test that later does `window.mouseX = ...` then needs no extra wiring to
  // be seen by sketch.js's bare `mouseX` reference.
  'saveCanvas', 'drawingContext', 'winMouseX', 'winMouseY', 'mouseX', 'mouseY',
  'circle', 'textWidth', 'width', 'height',
];
const P5_CONSTANTS = { CENTER: 'center', LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom', CLOSE: 'close', BOLD: 'bold', NORMAL: 'normal' };

/**
 * Boots the real app in a fresh jsdom window and returns { window, document }.
 * Each call is fully isolated (new jsdom instance, new AppState, etc).
 *
 * @param {{compact?: boolean}} [opts] - `compact: true` simulates a mobile
 *   device for GSRLiveView.isCompactLayout() (and anything else reading
 *   window.matchMedia) via installMatchMedia(). Defaults to `false` (desktop)
 *   so every existing caller is unaffected.
 */
async function bootApp({ compact = false } = {}) {
  clearPreviousBoot();
  const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  // runScripts: "outside-only" parses the real DOM (every real element ID
  // intact) but does NOT execute any <script> tag itself — including the 4
  // CDN <script src="https://..."> tags, so no network access happens.
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const window = dom.window;

  installMatchMedia(window, { compact });
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

  installJsdomGlobals(window);

  for (const file of SCRIPT_ORDER) {
    await loadScriptFile(APP_DIR, file, window);
  }

  return { window, document: window.document };
}

module.exports = { bootApp, superMock, SCRIPT_ORDER };
