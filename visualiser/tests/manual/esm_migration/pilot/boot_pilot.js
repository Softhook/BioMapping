/**
 * Prototype replacement for tests/support/boot_app.js's vm.createContext +
 * SCRIPT_ORDER approach, proving the ES-module migration's chosen technique
 * before it's applied to the real (93-file) app: build a jsdom window
 * exactly as today, copy its properties onto Node's `global` (the standard
 * "jsdom-global" technique — https://github.com/rstacruz/jsdom-global), then
 * a single dynamic `import()` of the real entry module. No vm realm, no
 * SCRIPT_ORDER: the import graph is its own source of truth for load order.
 *
 * `busta` (optional) appends a cache-busting query string to the import()
 * specifier, standing in for the real migration's need to re-import a
 * module fresh per test case (replacing today's `require.cache` deletion
 * trick used by test_globe3d.js etc.).
 */
const path = require('path');
const { JSDOM } = require('jsdom');

// Real Node identifiers a jsdom window would never legitimately shadow —
// skipped so a bridge call can never clobber the host runtime itself.
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

/**
 * Plain per-call overwrite (`global[key] = window[key]`), NOT an accessor
 * (getter/setter) bridge. An accessor bridge only binds correctly on the
 * FIRST call: `bootPilot()` is meant to be called once per test with a
 * fresh jsdom window each time (mirrors bootApp()'s existing "each call is
 * fully isolated" contract), and once `global.document`'s accessor was
 * installed pointing at window #1, a later `global.document = window2.document`
 * just invokes window #1's captured setter — which tries to reassign
 * `window1.document`, a non-writable property on a real jsdom Window, so it
 * silently no-ops (this file isn't itself an ES module, so it's not
 * automatically strict-mode) and every module bare-referencing `document`
 * keeps resolving to window #1 forever. Caught via test_pilot.js's second
 * test actually reading back a mismatched (empty) textContent — a real bug,
 * not a hypothetical, which is exactly why this prototype step exists.
 */
function installJsdomGlobals(window) {
  const installed = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    if (RESERVED_NODE_GLOBALS.has(key)) continue;
    if (key === 'window' || key === 'document') continue; // always rebound below, every call
    // Modern Node already natively implements several Web APIs jsdom also
    // exposes on `window` (performance, fetch, crypto, URL, TextEncoder,
    // structuredClone, Event/EventTarget...). Skip anything already present
    // on `global` rather than overwriting it with jsdom's version: jsdom's
    // own Performance-impl calls back into the ambient `performance` global
    // to compute its `now()` — clobbering it with jsdom's own wrapper made
    // that call resolve to itself, an infinite recursion caught by this
    // prototype's second test run (RangeError: Maximum call stack size
    // exceeded), not a hypothetical.
    if (key in global) continue;
    global[key] = window[key];
    installed.push(key);
  }
  global.window = window;
  global.document = window.document;
  return installed;
}

async function bootPilot({ cacheBust, entry = 'entry.mjs' } = {}) {
  const dom = new JSDOM('<div id="notice"></div>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  installJsdomGlobals(dom.window);

  const entryPath = path.join(__dirname, entry);
  // Node's ESM loader caches by exact resolved specifier. Busting the entry
  // alone only refreshes the entry module itself — anything it reaches via
  // a plain (non-busted) `import ... from './x.mjs'` is a normal static
  // specifier and still resolves to whatever module record that URL cached
  // first, shared across every bootPilot() call in the process. A test that
  // needs ONE specific module fresh (replacing today's require.cache
  // deletion trick, e.g. test_globe3d.js resetting GSRGlobeManager) must
  // import that module directly with the busted specifier, not rely on
  // busting a parent/entry that merely re-exports it.
  const specifier = cacheBust ? `${entryPath}?t=${cacheBust}` : entryPath;
  const mod = await import(specifier);

  return { window: dom.window, document: dom.window.document, mod };
}

module.exports = { bootPilot, installJsdomGlobals };
