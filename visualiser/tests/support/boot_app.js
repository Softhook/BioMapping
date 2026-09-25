/**
 * Smoke-test harness: boots the REAL app (real index.html DOM + every real
 * src/*.mjs source module, unmodified, in the exact order src/app_entry.mjs
 * imports them) inside jsdom, with a hand-rolled stand-in for the CDN
 * libraries (Leaflet, p5, JSZip) instead of loading them for real.
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
 * Every src/ file is a real ES module (the ES-module migration —
 * tests/manual/esm_migration/README.md — is done): `bootApp()` dynamically
 * `import()`s each one in SCRIPT_ORDER, in the same jsdom-bridged realm (see
 * realm_bridge.js) so post-boot test code can read a class/singleton back
 * via `window.X`/`global.X` without doing its own `require()`. `bootApp()`
 * is async as a direct consequence — dynamic `import()` has no synchronous
 * form in Node.
 */

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { installMatchMedia } = require('./matchmedia_stub.js');
const {
  superMock,
  installJsdomGlobals,
  clearPreviousBoot,
  loadScriptFile,
} = require('./realm_bridge.js');

const APP_DIR = path.join(__dirname, '..', '..');

// Real module load order, mirroring src/app_entry.mjs's own import list
// (local app files only — the 4 CDN libraries are stubbed instead). Kept in
// sync with it by tests/test_html_wiring.js.
const SCRIPT_ORDER = [
  'src/core/notices.mjs',
  'src/core/app_state.mjs',
  'src/core/fullscreen.mjs',
  'src/core/layout_manager.mjs',
  'src/core/constants.mjs',
  'src/gps/geo_utils.mjs',
  'src/spatial/spatial_grid.mjs',
  'src/core/file_saver.mjs',
  'src/signal/stats_math.mjs',
  'src/osm/overpass_client.mjs',
  'src/osm/osm_cache.mjs',
  'src/signal/dwt_filter.mjs',
  'src/signal/deconvolution.mjs',
  'src/signal/cvxeda.mjs',
  'src/signal/csv_parser.mjs',
  'src/signal/spectral_eda.mjs',
  'src/signal/analyzer_time_format.mjs',
  'src/signal/response_dynamics.mjs',
  'src/signal/analyzer.mjs',
  'src/osm/osm_enrichment.mjs',
  'src/osm/ndvi_sampler.mjs',
  'src/gps/map_match.mjs',
  'src/signal/gsr_filter.mjs',
  'src/render/marching_squares.mjs',
  'src/map/hillshade.mjs',
  'src/spatial/spatial_clustering.mjs',
  'src/spatial/arousal_places.mjs',
  'src/spatial/collective_manager.mjs',
  'src/map/basemap.mjs',
  'src/map/map_colors.mjs',
  'src/gps/gps_pipeline.mjs',
  'src/map/map_markers.mjs',
  'src/live/live_binary_parser.mjs',
  'src/live/live_state.mjs',
  'src/live/live_bluetooth.mjs',
  'src/live/live_csv.mjs',
  'src/live/live_tile_cache.mjs',
  'src/live/live_graph.mjs',
  'src/live/live_map.mjs',
  'src/live/live_view.mjs',
  'src/render/label_placement.mjs',
  'src/render/bezier_spline.mjs',
  'src/render/contour_ring_geometry.mjs',
  'src/map/map_exporter.mjs',
  'src/render/rf_fluid_renderer.mjs',
  'src/map/map_popups.mjs',
  'src/map/map_base.mjs',
  'src/map/manager/layers.mjs',
  'src/map/manager/process.mjs',
  'src/map/manager/viewport.mjs',
  'src/map/manager/legend.mjs',
  'src/map/manager/osm.mjs',
  'src/map/manager/rf_fluid.mjs',
  'src/map/manager/path.mjs',
  'src/map/manager/peaks.mjs',
  'src/map/manager/arousal_places.mjs',
  'src/map/manager/collective.mjs',
  'src/map/manager/toggles.mjs',
  'src/map/manager/render.mjs',
  'src/map/map.mjs',
  'src/map/globe3d/exporters.mjs',
  'src/map/globe3d/rf_expanse.mjs',
  'src/map/globe3d/buildings.mjs',
  'src/map/globe3d/globe3d_base.mjs',
  'src/map/globe3d/osm.mjs',
  'src/map/globe3d/rf.mjs',
  'src/map/globe3d/peaks.mjs',
  'src/map/globe3d/toggles.mjs',
  'src/map/globe3d/navigation.mjs',
  'src/map/globe3d/tour.mjs',
  'src/map/globe3d.mjs',
  'src/map/globe3d_view.mjs',
  'src/ui/storage.mjs',
  'src/ui/events.mjs',
  'src/ui/events_gsr_analysis.mjs',
  'src/ui/events_timeline.mjs',
  'src/ui/events_file_export.mjs',
  'src/ui/events_gps.mjs',
  'src/ui/events_map_panel.mjs',
  'src/ui/events_presets.mjs',
  'src/ui/events_enrichment.mjs',
  'src/ui/events_environmental_dashboard.mjs',
  'src/ui/events_view_switcher.mjs',
  'src/ui/events_surface_switcher.mjs',
  'src/ui/events_modals.mjs',
  'src/ui/tracks.mjs',
  'src/spatial/collective_project.mjs',
  'src/ui/ui.mjs',
  'src/ui/ui_peaks_table.mjs',
  'src/ui/ui_stats_panel.mjs',
  'src/ui/ui_collective_map.mjs',
  'src/ui/ui_export.mjs',
  'src/ui/ui_osm_overlay.mjs',
  'src/ui/ui_enrichment.mjs',
  'src/ui/ui_correlation_table.mjs',
  'src/ui/ui_road_profile.mjs',
  'src/ui/ui_environmental_dashboard.mjs',
  'src/ui/ui_modals.mjs',
  'src/render/renderer.mjs',
  'src/render/renderer_bands.mjs',
  'src/render/renderer_curve.mjs',
  'src/render/renderer_markers.mjs',
  'src/render/renderer_interaction.mjs',
  'src/render/renderer_chrome.mjs',
  'src/render/sketch.mjs',
];

// p5 "global mode" functions/constants referenced as bare identifiers by
// renderer.js/sketch.js (grepped from source, not guessed).
const P5_GLOBAL_NAMES = [
  'background',
  'beginShape',
  'color',
  'constrain',
  'curveVertex',
  'endShape',
  'fill',
  'line',
  'noFill',
  'noLoop',
  'noStroke',
  'push',
  'pop',
  'rect',
  'redraw',
  'resizeCanvas',
  'stroke',
  'strokeWeight',
  'text',
  'textAlign',
  'textSize',
  'textStyle',
  'vertex',
  'loop',
  // p5 mouse/canvas state, also referenced bare — must exist on `window` at
  // boot time so installJsdomGlobals's live accessor bridge picks them up; a
  // test that later does `window.mouseX = ...` then needs no extra wiring to
  // be seen by sketch.js's bare `mouseX` reference.
  'saveCanvas',
  'drawingContext',
  'winMouseX',
  'winMouseY',
  'mouseX',
  'mouseY',
  'circle',
  'textWidth',
  'width',
  'height',
];
const P5_CONSTANTS = {
  CENTER: 'center',
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'top',
  BOTTOM: 'bottom',
  CLOSE: 'close',
  BOLD: 'bold',
  NORMAL: 'normal',
};

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
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window;

  installMatchMedia(window, { compact });
  window.L = superMock();
  // jsdom doesn't implement ResizeObserver (a real browser API) — a no-op
  // stand-in is enough since these tests don't simulate element resizing.
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom doesn't implement the Blob-URL pair either (browser-only, used by
  // file_saver.js's direct-download fallback) — a no-op stand-in is enough
  // since these tests don't need the resulting URL to be dereferenceable.
  window.URL.createObjectURL =
    window.URL.createObjectURL || (() => 'blob:mock-url');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});

  for (const name of P5_GLOBAL_NAMES) window[name] = superMock();
  for (const [name, value] of Object.entries(P5_CONSTANTS))
    window[name] = value;
  // createCanvas needs a real DOM node: sketch.js calls real DOM APIs on the
  // result (`.elt.addEventListener(...)`, `.elt.oncontextmenu = ...`), which
  // a generic superMock would harmlessly no-op but a real jsdom <canvas>
  // handles faithfully (real listeners actually fire on real dispatched
  // events, useful if a later test wants to simulate a canvas interaction).
  window.createCanvas = (w, h) => ({
    parent: () => {},
    elt: window.document.createElement('canvas'),
    width: w,
    height: h,
  });
  window.map = (value, start1, stop1, start2, stop2) =>
    start2 + (stop2 - start2) * ((value - start1) / (stop1 - start1)); // p5's real remap semantics — cheap and worth getting right since it's plain arithmetic

  window.JSZip = superMock();

  installJsdomGlobals(window);

  for (const file of SCRIPT_ORDER) {
    await loadScriptFile(APP_DIR, file, window);
  }

  return { window, document: window.document };
}

module.exports = { bootApp, SCRIPT_ORDER };
