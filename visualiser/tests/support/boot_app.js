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
 * way — see convert_file.js), this loader loads each one of two ways:
 *   - not yet converted (still .js): `vm.runInThisContext(src)`, run in
 *     NODE'S OWN real global realm — NOT a separate `vm.createContext`
 *     (Pattern A's existing tests already establish this technique: a
 *     separate context breaks Array/Object prototype identity across
 *     `assert.deepStrictEqual`; running in this realm keeps it correct).
 *   - already converted (.mjs exists): `await import()`, the real ES
 *     module — which necessarily executes in this SAME real Node realm
 *     too, so a not-yet-converted file's bare reference to an
 *     already-converted name still resolves, via the explicit
 *     `Object.assign(global, mod)` bridge below (this loader's equivalent
 *     of the old `window.X = X` exposure, temporary and test-only — never
 *     written into any real src/ file).
 * Both paths therefore share ONE realm, which is what makes mixing
 * converted and unconverted files during the migration possible at all.
 * `bootApp()` becomes async as a direct consequence — dynamic `import()`
 * has no synchronous form in Node.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const espree = require('espree');
const { JSDOM } = require('jsdom');
const { installMatchMedia } = require('./matchmedia_stub.js');
const { topLevelDeclaredNames } = require('../manual/esm_migration/lib/top_level_names.js');

const APP_DIR = path.join(__dirname, '..', '..');

// Real script load order, copied from index.html's own <script src="...">
// list (local app files only — the 4 CDN libraries are stubbed instead).
// Kept byte-for-byte in sync with index.html by tests/support/test_script_order.js.
// NOTE: during the ES-module migration this stays the list of ORIGINAL .js
// paths — resolveFile() below transparently swaps in a file's .mjs sibling
// once it's been converted, so this array itself needs no edits per file.
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
  // boot time so installJsdomGlobals's live accessor bridge (below) picks
  // them up; a test that later does `window.mouseX = ...` then needs no
  // extra wiring to be seen by sketch.js's bare `mouseX` reference.
  'saveCanvas', 'drawingContext', 'winMouseX', 'winMouseY', 'mouseX', 'mouseY',
  'circle', 'textWidth', 'width', 'height',
];
const P5_CONSTANTS = { CENTER: 'center', LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom', CLOSE: 'close', BOLD: 'bold', NORMAL: 'normal' };

// CAUTION if reusing this outside bootApp()'s jsdom context: `new Blob([superMock()])`
// against Node's *native* global Blob crashes the whole process with a native
// V8 assertion ("Incorrect Blob initialization type") instead of throwing a
// catchable error — verified directly. It does NOT crash inside bootApp()'s
// tests because window.Blob is jsdom's own pure-JS Blob polyfill, force-
// bridged onto `global.Blob` (see FORCE_BRIDGE_OVER_NATIVE below — Node's
// own native Blob is a different, already-global class that installJsdomGlobals
// otherwise leaves untouched), which coerces the mock via its parts'
// Symbol.toPrimitive/toString instead of hitting Node's native code path.
// Don't pass a superMock() to Node's native `Blob` constructor directly
// (e.g. in a test that doesn't go through jsdom).
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

// Real Node identifiers a jsdom window would never legitimately shadow —
// skipped so the bridge can never clobber the host runtime itself.
const RESERVED_NODE_GLOBALS = new Set([
  'global', 'globalThis', 'process', 'require', 'module', 'exports',
  '__dirname', '__filename', 'Buffer',
]);

// Captured once, at module load — before any bootApp() call has run — so it
// reflects only what Node itself natively provides (`performance`, `fetch`,
// `crypto`, `URL`, `TextEncoder`, `structuredClone`...), never a name our
// OWN bridge installed on an earlier bootApp() call. installJsdomGlobals
// uses this (not a live `key in global` check) to decide which window
// properties to leave Node's native implementation of alone — a live check
// would also match, and wrongly skip redefining, our own bridge's leftover
// accessors from a previous call.
const NATIVE_GLOBAL_KEYS = new Set(Object.getOwnPropertyNames(global));

// Names where the opposite of NATIVE_GLOBAL_KEYS's default applies: jsdom's
// own polyfill must win over Node's native implementation, not the other way
// round — see the CAUTION comment above superMock(). `URL` joins `Blob` for
// the same reason: Node's native `URL.createObjectURL` does a real
// `instanceof Blob` check against Node's OWN native Blob class, which throws
// given a jsdom Blob instance (bootApp() patches the missing
// createObjectURL/revokeObjectURL pair onto jsdom's own `window.URL`, not
// Node's — see bootApp() — so bare `URL` needs to resolve there too).
const FORCE_BRIDGE_OVER_NATIVE = new Set(['Blob', 'URL']);

/**
 * Bridges a jsdom window onto Node's `global`, proven in
 * tests/manual/esm_migration/pilot/boot_pilot.js before use here.
 * `window`/`document` are plain-overwritten on EVERY call (bootApp() is
 * called once per test with a fresh jsdom window each time — an accessor
 * bridge only binds correctly on the first call, since a later
 * `global.document = window2.document` would just invoke window #1's
 * captured setter instead of rebinding `global` itself).
 *
 * Everything else on `window` gets a live, bidirectional accessor on
 * `global` (skipped only for a name Node itself already natively provides —
 * see NATIVE_GLOBAL_KEYS) rather than a one-time value copy: test code and
 * app code both routinely reassign a window property AFTER boot (a mock
 * Leaflet swapped in post-setup, `window.mouseX` updated per drag tick,
 * `window.constrain` overridden per test) and expect a bare identifier
 * reference inside already-loaded app code to see the new value — which
 * only works if `global.X` keeps forwarding to whatever `window.X` current
 * holds, not a snapshot taken at boot.
 */
function installJsdomGlobals(window) {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (RESERVED_NODE_GLOBALS.has(key)) continue;
    if (key === 'window' || key === 'document') continue;
    if (NATIVE_GLOBAL_KEYS.has(key) && !FORCE_BRIDGE_OVER_NATIVE.has(key)) continue;
    Object.defineProperty(global, key, {
      configurable: true,
      enumerable: true,
      get() { return window[key]; },
      set(v) { window[key] = v; },
    });
  }
  global.window = window;
  global.document = window.document;
}

/** Does this SCRIPT_ORDER entry have a converted (.mjs) sibling yet? Resolves to whichever exists — never both, by construction (convert_file.js deletes the .js when it writes the .mjs). */
function resolveFile(relFile) {
  const mjsRel = relFile.replace(/\.js$/, '.mjs');
  if (fs.existsSync(path.join(APP_DIR, mjsRel))) return { rel: mjsRel, converted: true };
  return { rel: relFile, converted: false };
}

// A not-yet-converted file's top-level `class`/`const`/`let` declarations
// live in the realm's shared global LEXICAL environment when run via
// `vm.runInThisContext` (this is exactly the real-browser `<script>` tag
// semantics the realm-model switch relies on for cross-file bare-identifier
// references — see this file's header comment). That lexical environment
// persists for the whole Node process, and — unlike plain global-object
// properties — cannot be redeclared: a second bootApp() call re-running the
// same file's source throws `SyntaxError: Identifier 'X' has already been
// declared`. Fixed by running each file's source inside a fresh function
// scope every call (so its declarations never touch the shared lexical
// environment) and reflecting its real top-level names onto `global`
// afterwards as plain, freely-overwritable object properties — which is how
// later bare-identifier lookups still resolve them. Never written into any
// real src/ file; a test-harness-only technique, same spirit as the
// `Object.assign(global, mod)` bridge used for already-converted files below.
const wrappedSourceCache = new Map(); // absolute file path -> { wrapped, declaredNames }

// Node's native setTimeout/setInterval (bare `setTimeout(...)` in e.g.
// map_manager_arousal_places.js's debounce resolves to these — `setTimeout`
// is in NATIVE_GLOBAL_KEYS, left unbridged on purpose) are shared across the
// whole process, unlike jsdom's own window-scoped timers which get torn
// down with the window. A timer a test doesn't explicitly wait out or
// cancel keeps running after that test ends, and its callback still
// resolves bare identifiers (e.g. `GSRSpatialClustering`) through the one
// shared `global`, which by the time it fires may point at a LATER
// bootApp() call's fresh class — a timer leaked from test A can silently
// re-invoke, and increment a spy installed by, test B. Patched once here
// (not per bootApp() call) so every bootApp() call can sweep away whatever
// the PREVIOUS one left running before handing out a fresh window —
// restoring the "each call is fully isolated" contract bootApp() already
// promises in its own doc comment below. Safe to wrap unconditionally:
// every call still delegates to the real timer, just tracked.
const pendingTimers = new Set();
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setTimeout = (...args) => {
  const id = realSetTimeout(...args);
  pendingTimers.add(id);
  return id;
};
global.clearTimeout = (id) => { pendingTimers.delete(id); return realClearTimeout(id); };
global.setInterval = (...args) => {
  const id = realSetInterval(...args);
  pendingTimers.add(id);
  return id;
};
global.clearInterval = (id) => { pendingTimers.delete(id); return realClearInterval(id); };

function clearLeakedTimersFromPreviousBoot() {
  for (const id of pendingTimers) realClearTimeout(id);
  pendingTimers.clear();
}

function wrapForRepeatedExecution(absPath, src) {
  let entry = wrappedSourceCache.get(absPath);
  if (entry) return entry;
  const ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
  const declaredNames = [...topLevelDeclaredNames(ast.body)];
  const returnExpr = declaredNames.length ? `{${declaredNames.join(',')}}` : '{}';
  // No newline between `{` and `${src}`: keeps every line of src at its
  // original line number in stack traces (only the wrapper's own closing
  // lines are appended after src's final line).
  const wrapped = `(function(){${src}\n;return ${returnExpr};\n})()`;
  entry = { wrapped, declaredNames };
  wrappedSourceCache.set(absPath, entry);
  return entry;
}

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
  clearLeakedTimersFromPreviousBoot();
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
    const { rel, converted } = resolveFile(file);
    if (converted) {
      const mod = await import(path.join(APP_DIR, rel));
      // Test-harness-only compat shim, mirroring the old window.X = X
      // exposure: makes a converted file's exports resolvable as bare
      // identifiers by any file further down SCRIPT_ORDER that hasn't
      // converted yet. Never written into any real src/ file.
      Object.assign(global, mod);
    } else {
      const absPath = path.join(APP_DIR, rel);
      const src = fs.readFileSync(absPath, 'utf8');
      const { wrapped } = wrapForRepeatedExecution(absPath, src);
      const bridge = vm.runInThisContext(wrapped, { filename: rel });
      // Reflect onto both realms: `global` so a later not-yet-converted
      // file's bare identifier reference resolves (the actual cross-file
      // dependency this whole bridge exists for), and `window` because some
      // test code and some src files (e.g. sketch.js's p5 "global mode"
      // `function setup(){}`) read these back via `window.X` — true browser
      // `<script>` semantics for a bare top-level function/var declaration,
      // which the old `vm.createContext(window)` model got for free by
      // literally making `window` the context's global object.
      Object.assign(global, bridge);
      Object.assign(window, bridge);
    }
  }

  return { window, document: window.document };
}

module.exports = { bootApp, superMock, SCRIPT_ORDER };
