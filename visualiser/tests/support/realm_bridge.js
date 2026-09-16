/**
 * Shared boot machinery for the test harnesses (tests/support/boot_app.js
 * for index.html, tests/support/boot_live.js for live.html). Both boot a
 * jsdom window, bridge it onto Node's `global` (a dynamically-`import()`ed
 * ES module necessarily executes in Node's own real global realm — there is
 * no way to make `import()` target a separate `vm.createContext`), then
 * `import()` every file in a fixed load-order list into that shared realm.
 *
 * All 93 src/ files are real ES modules (the ES-module migration —
 * tests/manual/esm_migration/README.md — is done), so nothing here mixes
 * module and non-module loading paths any more; every app-to-app reference
 * is a real `import` statement, resolved by the module graph itself. What's
 * left is purely a TEST convenience: many existing tests read a class/
 * singleton back via `window.X` or `global.X` after boot instead of doing
 * their own `require()`/`import()` of the exact file — reflectOntoGlobal()
 * below exists for them, not for the app's own cross-file resolution.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');

// Node's ESM resolver caches a module by its exact resolved URL for the
// process lifetime — without busting, a SECOND `bootApp()`/`bootLive()` call
// in the same test file would reuse the FIRST call's module instances,
// silently skipping every file's top-level side effect (e.g. notices.mjs's
// `window.addEventListener('error', ...)`, which needs to re-register on
// THIS boot's fresh window; live_tile_cache.mjs's `L.tileLayer.cache =
// function(){...}`, which needs to re-attach to THIS boot's fresh `L` mock).
// One process-wide resolve hook — synchronous, in-thread (`module.registerHooks`,
// not the worker-thread `module.register`, so it can read `bootGeneration`
// directly with no message-passing) — appends the CURRENT generation's query
// to every resolution under this project's own src/ tree, whichever of
// loadScriptFile's own top-level `import()` calls or a nested static
// `import` inside another src/ file triggered it. Both converge on the
// identical resolved URL, hence the identical cached instance, for the life
// of one boot. Registered once at module load (this file is only require()d
// once per process).
let bootGeneration = 0;
const SRC_ROOT = pathToFileURL(
  path.join(__dirname, '..', '..') + path.sep,
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (
      result.url.startsWith(SRC_ROOT) &&
      result.url.endsWith('.mjs') &&
      !result.url.includes('?t=')
    ) {
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
  const fn = function () {
    return superMock();
  };
  const handler = {
    get(target, prop) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally')
        return undefined; // never look like a Promise/thenable
      if (prop === Symbol.toPrimitive)
        return (hint) => (hint === 'string' ? '' : 0);
      if (prop === Symbol.iterator) return function* () {}; // empty iterator — a for-of over a mock just does nothing
      if (!(prop in target)) target[prop] = superMock();
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    apply() {
      return superMock();
    },
    construct() {
      return superMock();
    },
  };
  return new Proxy(fn, handler);
}

// Real Node identifiers a jsdom window would never legitimately shadow —
// skipped so the bridge can never clobber the host runtime itself.
const RESERVED_NODE_GLOBALS = new Set([
  'global',
  'globalThis',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Buffer',
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
 * see NATIVE_GLOBAL_KEYS) rather than a one-time value copy: test code
 * routinely reassigns a window property AFTER boot (a mock Leaflet swapped
 * in post-setup, `window.mouseX` updated per drag tick, `window.constrain`
 * overridden per test) and expects a bare identifier reference inside
 * already-loaded app code to see the new value — which only works if
 * `global.X` keeps forwarding to whatever `window.X` currently holds, not a
 * snapshot taken at boot.
 */
function installJsdomGlobals(window) {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (RESERVED_NODE_GLOBALS.has(key)) continue;
    if (key === 'window' || key === 'document') continue;
    if (NATIVE_GLOBAL_KEYS.has(key) && !FORCE_BRIDGE_OVER_NATIVE.has(key))
      continue;
    Object.defineProperty(global, key, {
      configurable: true,
      enumerable: true,
      get() {
        return window[key];
      },
      set(v) {
        window[key] = v;
      },
    });
  }
  global.window = window;
  global.document = window.document;
}

// Node's native setTimeout/setInterval (bare `setTimeout(...)` in e.g.
// manager/arousal_places.js's debounce resolves to these — `setTimeout`
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
global.clearTimeout = (id) => {
  pendingTimers.delete(id);
  return realClearTimeout(id);
};
global.setInterval = (...args) => {
  const id = realSetInterval(...args);
  pendingTimers.add(id);
  return id;
};
global.clearInterval = (id) => {
  pendingTimers.delete(id);
  return realClearInterval(id);
};

function clearLeakedTimersFromPreviousBoot() {
  for (const id of pendingTimers) realClearTimeout(id);
  pendingTimers.clear();
}

/**
 * Loads one script-order entry (a real ES module) into the shared realm:
 * `import()` it (cache-busted by the resolve hook above) and reflect its
 * exports onto both `global` (so a bare identifier reference — none left in
 * real src/ code, but plenty of test code still does this — resolves) and
 * `window` (true browser `<script>` semantics for anything that reads a
 * module's exports back via `window.X`, and what sketch.mjs's p5 "global
 * mode" functions need — see src/app_entry.mjs's own header comment for how
 * the real browser handles that).
 */
// A plain `Object.assign(target, source)` INVOKES any getter on `source`
// and copies the resulting VALUE as a fresh data property — losing
// liveness for a real ES module namespace object's exports (genuinely live
// bindings — reflect a later `export let x` reassignment inside the
// module). Fixed with a live getter/setter that re-reads `source[name]` on
// every access instead: a namespace object's own properties are non-
// writable, so the setter silently no-ops on an external write (matching
// real browser ESM semantics) — confirmed empirically (`mod.x = 99` neither
// throws nor changes `mod.x` read back). `configurable: true` is forced
// regardless of the source's own (a module namespace's own properties are
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
  for (const name of Object.keys(Object.getOwnPropertyDescriptors(source))) {
    if (target === global) reflectedGlobalNames.add(name);
    Object.defineProperty(target, name, {
      get() {
        return source[name];
      },
      set(v) {
        source[name] = v;
      },
      configurable: true,
      enumerable: true,
    });
  }
}

async function loadScriptFile(appDir, relFile, window) {
  const absPath = path.join(appDir, relFile);
  const mod = await import(pathToFileURL(absPath).href);
  reflectOntoGlobal(mod, global);
  reflectOntoGlobal(mod, window);
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
  clearPreviousBoot,
  loadScriptFile,
};
