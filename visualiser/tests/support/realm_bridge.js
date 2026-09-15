/**
 * Shared realm-model machinery for the ES-module migration test harnesses
 * (tests/support/boot_app.js for index.html, tests/support/boot_live.js for
 * live.html). Both boot a jsdom window and load a list of real src/ files,
 * some not-yet-converted (dual-mode tail, `vm.runInThisContext`), some
 * already-converted (real ES module, dynamic `import()`) — and a
 * dynamically-`import()`ed file necessarily executes in Node's own real
 * global realm (no way to make `import()` target a separate
 * `vm.createContext`), so for a not-yet-converted file to still see an
 * already-converted file's exports as a bare global (and vice versa), BOTH
 * must run in that SAME real realm. That one shared realm is what this
 * module bridges a jsdom window onto and what makes mixing converted and
 * unconverted files during the migration possible at all. See
 * tests/manual/esm_migration/pilot/boot_pilot.js for where the base
 * technique was first proven, and this project's git history for the two
 * bugs it surfaced when actually exercised at scale (recorded in each
 * function's own comment below).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const espree = require('espree');
const { pathToFileURL } = require('url');
const { registerHooks } = require('module');
const { topLevelDeclaredNames, topLevelMutableNames } = require('../manual/esm_migration/lib/top_level_names.js');

// Node's ESM resolver caches a module by its exact resolved URL for the
// process lifetime. Busting only loadScriptFile's OWN `import()` call for a
// SCRIPT_ORDER entry (a per-call query string, as this used to do) isn't
// enough once one converted file statically imports ANOTHER converted
// file: that internal `import ... from './x.mjs'` specifier carries no
// query string, so it resolves — and caches — completely independently of
// whatever busted URL loadScriptFile used for x.mjs's own entry. Caught by
// live_bluetooth.mjs's `import { LiveState } from './live_state.mjs'`:
// LiveConnectionController's bare-global `LiveState.setStatus('connecting')`
// and the manager's `this._setStatus('connected')` (which goes through its
// own static-imported LiveState binding) were silently mutating two
// different objects — the connect() flow looked permanently stuck
// "connecting" from the test's/global's point of view.
//
// Fixed with one process-wide resolve hook — synchronous, in-thread
// (`module.registerHooks`, not the worker-thread `module.register`, so it
// can read `bootGeneration` directly with no message-passing) — that
// appends the CURRENT generation's query to EVERY resolution under this
// project's own src/ tree, whether reached via loadScriptFile's top-level
// `import()` or a nested static `import` inside an already-converted file.
// Both paths then resolve to the identical URL, so Node's module cache
// hands back the identical instance, for the life of one boot. Registered
// once at module load (this file is only require()d once per process).
let bootGeneration = 0;
const SRC_ROOT = pathToFileURL(path.join(__dirname, '..', '..') + path.sep).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith(SRC_ROOT) && result.url.endsWith('.mjs') && !result.url.includes('?t=')) {
      return { ...result, url: `${result.url}?t=${bootGeneration}` };
    }
    return result;
  },
});

// CAUTION if reusing this outside a booted jsdom window: `new Blob([superMock()])`
// against Node's *native* global Blob crashes the whole process with a native
// V8 assertion ("Incorrect Blob initialization type") instead of throwing a
// catchable error — verified directly. It does NOT crash inside a booted
// harness because window.Blob is jsdom's own pure-JS Blob polyfill, force-
// bridged onto `global.Blob` (see FORCE_BRIDGE_OVER_NATIVE below — Node's
// own native Blob is a different, already-global class that installJsdomGlobals
// otherwise leaves untouched), which coerces the mock via its parts'
// Symbol.toPrimitive/toString instead of hitting Node's native code path.
// Don't pass a superMock() to Node's native `Blob` constructor directly
// (e.g. in a test that doesn't go through a booted harness).
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

// Captured once, at module load — before any harness has booted anything —
// so it reflects only what Node itself natively provides (`performance`,
// `fetch`, `crypto`, `URL`, `TextEncoder`, `structuredClone`...), never a
// name our OWN bridge installed on an earlier boot. installJsdomGlobals uses
// this (not a live `key in global` check) to decide which window properties
// to leave Node's native implementation of alone — a live check would also
// match, and wrongly skip redefining, our own bridge's leftover accessors
// from a previous call.
const NATIVE_GLOBAL_KEYS = new Set(Object.getOwnPropertyNames(global));

// Names where the opposite of NATIVE_GLOBAL_KEYS's default applies: jsdom's
// own polyfill must win over Node's native implementation, not the other way
// round — see the CAUTION comment above superMock(). `URL` joins `Blob` for
// the same reason: Node's native `URL.createObjectURL` does a real
// `instanceof Blob` check against Node's OWN native Blob class, which throws
// given a jsdom Blob instance (both harnesses patch the missing
// createObjectURL/revokeObjectURL pair onto jsdom's own `window.URL`, not
// Node's, so bare `URL` needs to resolve there too). `navigator` similarly —
// Node (21+) has its own bare-bones native `navigator` global (just
// `userAgent` etc.), completely unrelated to jsdom's `window.navigator`
// that boot_live.js/boot_app.js attach `.bluetooth`/`.geolocation`/
// `.wakeLock` mocks onto; without forcing the bridge, a bare `navigator.X`
// reference in src code silently resolves to Node's real, mock-less one.
// `fetch` for the same reason again — a test overriding `window.fetch` to
// count/fake network calls (e.g. cacheCurrentMapArea() tests) is invisible
// to a bare `fetch(...)` call in src code, which would otherwise resolve to
// Node's own real, network-hitting native fetch.
const FORCE_BRIDGE_OVER_NATIVE = new Set(['Blob', 'URL', 'navigator', 'fetch']);

/**
 * Bridges a jsdom window onto Node's `global`, proven in
 * tests/manual/esm_migration/pilot/boot_pilot.js before use here.
 * `window`/`document` are plain-overwritten on EVERY call (a harness boots
 * once per test with a fresh jsdom window each time — an accessor bridge
 * only binds correctly on the first call, since a later `global.document =
 * window2.document` would just invoke window #1's captured setter instead
 * of rebinding `global` itself).
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

/** Does this script-order entry have a converted (.mjs) sibling yet? Resolves to whichever exists — never both, by construction (convert_file.js deletes the .js when it writes the .mjs). `appDir` is the repo's visualiser/ root. */
function resolveFile(appDir, relFile) {
  const mjsRel = relFile.replace(/\.js$/, '.mjs');
  if (fs.existsSync(path.join(appDir, mjsRel))) return { rel: mjsRel, converted: true };
  return { rel: relFile, converted: false };
}

// A not-yet-converted file's top-level `class`/`const`/`let` declarations
// live in the realm's shared global LEXICAL environment when run via
// `vm.runInThisContext` (this is exactly the real-browser `<script>` tag
// semantics the realm-model switch relies on for cross-file bare-identifier
// references — see this file's header comment). That lexical environment
// persists for the whole Node process, and — unlike plain global-object
// properties — cannot be redeclared: a second boot re-running the same
// file's source throws `SyntaxError: Identifier 'X' has already been
// declared`. Fixed by running each file's source inside a fresh function
// scope every call (so its declarations never touch the shared lexical
// environment) and reflecting its real top-level names onto `global`
// afterwards as plain, freely-overwritable object properties — which is how
// later bare-identifier lookups still resolve them. Never written into any
// real src/ file; a test-harness-only technique, same spirit as the
// `Object.assign(global, mod)` bridge used for already-converted files.
const wrappedSourceCache = new Map(); // absolute file path -> { wrapped, declaredNames }

function wrapForRepeatedExecution(absPath, src) {
  let entry = wrappedSourceCache.get(absPath);
  if (entry) return entry;
  const ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
  const declaredNames = [...topLevelDeclaredNames(ast.body)];
  const mutableNames = topLevelMutableNames(ast.body);
  // Getter/setter pairs, not a plain `{name}` shorthand snapshot: a file
  // like live_view.js reassigns its own top-level `let liveAnalyzer` from
  // inside a later-called function (mount() sets it once connected) — a
  // one-time snapshot at import time would freeze `global.liveAnalyzer` at
  // whatever it was (usually still `null`) forever, since that reassignment
  // only ever touches the closure's own binding, not the reflected copy. A
  // setter is generated for every name EXCEPT a `const` one
  // (topLevelMutableNames — see its own comment for why `class`/`function`
  // belong on the "gets a setter" side despite looking as immutable as
  // `const`). Generating a setter for a `const` throws "Assignment to
  // constant variable" the moment anything writes to the reflected global
  // on a LATER boot — including the declaring file's own dual-mode tail
  // (e.g. ndvi_sampler.js's `global.NDVISampler = NDVISampler;`), which by
  // then is writing through a STALE setter left over from an
  // earlier boot's now-orphaned closure.
  const returnExpr = declaredNames.length
    ? `{${declaredNames.map((n) => mutableNames.has(n)
      ? `get ${n}(){return ${n};},set ${n}(v){${n}=v;}`
      : `get ${n}(){return ${n};}`).join(',')}}`
    : '{}';
  // No newline between `{` and `${src}`: keeps every line of src at its
  // original line number in stack traces (only the wrapper's own closing
  // lines are appended after src's final line).
  const wrapped = `(function(){${src}\n;return ${returnExpr};\n})()`;
  entry = { wrapped, declaredNames };
  wrappedSourceCache.set(absPath, entry);
  return entry;
}

// Node's native setTimeout/setInterval (bare `setTimeout(...)` in e.g.
// map_manager_arousal_places.js's debounce resolves to these — `setTimeout`
// is in NATIVE_GLOBAL_KEYS, left unbridged on purpose) are shared across the
// whole process, unlike jsdom's own window-scoped timers which get torn
// down with the window. A timer a test doesn't explicitly wait out or
// cancel keeps running after that test ends, and its callback still
// resolves bare identifiers (e.g. `GSRSpatialClustering`) through the one
// shared `global`, which by the time it fires may point at a LATER boot's
// fresh class — a timer leaked from test A can silently re-invoke, and
// increment a spy installed by, test B. Patched once here (module load, not
// per boot, and shared by both harnesses so a timer either one leaks is
// swept by whichever boots next — test_fullscreen_restore.js uses both
// bootApp() and bootLive() in the same process) so every boot can sweep
// away whatever the PREVIOUS one left running before handing out a fresh
// window — restoring the "each call is fully isolated" contract both
// harnesses promise in their own doc comments. Safe to wrap
// unconditionally: every call still delegates to the real timer, just
// tracked.
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

// Node's ES module loader caches a module by its resolved specifier for the
// life of the process — a second `import()` of the SAME converted file (a
// LATER boot in the same test file) returns the cached module WITHOUT
// re-running its top-level code. Fine for a file that only declares
// classes/consts (Object.assign(global, mod) re-copies the same, still-
// correct values every time) but silently wrong for one with a real
// top-level side effect — e.g. live_tile_cache.mjs's `L.tileLayer.cache =
// function(){...}`, which needs to re-attach to THIS boot's fresh `L`
// mock, or notices.mjs's `window.addEventListener('error', ...)`, which
// needs to re-register on THIS boot's fresh window. Cache-busting (see the
// resolve hook + `bootGeneration` above this file's header comment) forces
// a genuinely fresh module instance — and therefore a fresh run of its
// top-level code — on every single boot, matching wrapForRepeatedExecution's
// same guarantee for not-yet-converted files below.

/**
 * Loads one script-order entry into the shared realm: `.mjs` (converted) →
 * `await import()` (cache-busted by the resolve hook above) + `Object.assign(global, mod)`
 * (a test-harness-only compat shim, mirroring the old window.X = X exposure
 * — makes a converted file's exports resolvable as bare identifiers by any
 * file further down the order that hasn't converted yet; never written into
 * any real src/ file); still `.js` → wrapForRepeatedExecution +
 * vm.runInThisContext. Both branches reflect the result onto `global` (a
 * later not-yet-converted file's bare reference) AND `window` — some test
 * code and some src files (e.g. sketch.js's p5 "global mode" `function
 * setup(){}`) read these back via `window.X`, true browser `<script>`
 * semantics for a bare top-level declaration, and several tests read a
 * converted file's own exports the same way (`const { X } = window;`).
 */
// A plain `Object.assign(target, source)` INVOKES any getter on `source`
// and copies the resulting VALUE as a fresh data property — losing
// liveness. Both a real ES module namespace object's exports (genuinely
// live bindings — reflect a later `export let x` reassignment inside the
// module) and wrapForRepeatedExecution's getter/setter bridge (emulating
// the same liveness for a not-yet-converted file) need the DESCRIPTOR
// copied instead, so reads on `target` keep going through to the source's
// live binding. `configurable: true` is forced on the copy regardless of
// the source's own (a module namespace's own properties are
// non-configurable) — `target` here is `global`/`window`, which must stay
// redefinable across every later boot.
// Every name ever reflected onto `global` (not `window` — a fresh jsdom
// window never carries anything over). boot_app.js's SCRIPT_ORDER and
// boot_live.js's LIVE_SCRIPT_ORDER overlap but differ (e.g. GSRLayoutManager
// loads only via boot_app.js) — a name one harness's last boot set stays on
// `global` as a normal, live property forever otherwise, so a LATER
// boot_live.js boot that never itself loads GSRLayoutManager still finds
// `typeof GSRLayoutManager !== 'undefined'` true from a previous bootApp()
// call, silently taking a branch meant only for the in-app Live view (e.g.
// live_view.js's FAB fullscreen handler prefers GSRLayoutManager over
// GSRFullscreen whenever it's defined). Tracked here so every boot can wipe
// the slate clean first — restoring the "each call is fully isolated"
// contract both harnesses promise, the same reasoning as
// clearLeakedTimersFromPreviousBoot() above.
const reflectedGlobalNames = new Set();

function clearPreviousBootGlobals() {
  for (const name of reflectedGlobalNames) delete global[name];
  reflectedGlobalNames.clear();
}

function reflectOntoGlobal(source, target) {
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (target === global) reflectedGlobalNames.add(name);
    Object.defineProperty(target, name, { ...descriptor, configurable: true });
  }
}

async function loadScriptFile(appDir, relFile, window) {
  const { rel, converted } = resolveFile(appDir, relFile);
  const absPath = path.join(appDir, rel);
  if (converted) {
    const mod = await import(pathToFileURL(absPath).href);
    reflectOntoGlobal(mod, global);
    reflectOntoGlobal(mod, window);
  } else {
    const src = fs.readFileSync(absPath, 'utf8');
    const { wrapped } = wrapForRepeatedExecution(absPath, src);
    const bridge = vm.runInThisContext(wrapped, { filename: rel });
    reflectOntoGlobal(bridge, global);
    reflectOntoGlobal(bridge, window);
  }
}

// Single entry point both harnesses call at the very top of their boot
// function — sweeps every process-wide side effect a previous boot (of
// EITHER harness) could have left running or lying around, restoring the
// "each call is fully isolated" contract before building the fresh window.
function clearPreviousBoot() {
  bootGeneration++;
  clearLeakedTimersFromPreviousBoot();
  clearPreviousBootGlobals();
}

module.exports = {
  superMock,
  installJsdomGlobals,
  resolveFile,
  wrapForRepeatedExecution,
  clearPreviousBoot,
  loadScriptFile,
};
