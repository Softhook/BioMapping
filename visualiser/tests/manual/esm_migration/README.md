# ES-module migration tooling (steps 1-2)

See `docs/visualizer_modularity_plan.md`'s "drop dual-mode for real ES
modules" section and the plan this session ran from for full context.
Everything here is prep/tooling — no `src/` or `tests/` file has been
converted yet. Nothing here is wired into `npm test`.

## `build_import_manifest.js` (step 1)

Parses all 93 files in `boot_app.js`'s `SCRIPT_ORDER` with `espree` +
`eslint-scope` (added as devDependencies for this tooling only) and, for
each file, finds every identifier it references but never declares itself
— i.e. what it currently relies on the shared browser/vm global scope to
resolve. Cross-references those against every file's own top-level
declarations to propose which file each should be imported from.

Run: `node tests/manual/esm_migration/build_import_manifest.js` — writes
`import_manifest.json` (gitignored-free, regenerate as needed; not meant to
be hand-edited) and prints two things that need human attention before
converting any file:
- **ambiguous**: a name declared in more than one file (currently: none —
  the codebase has no naming collisions across all 93 files).
- **unmatched**: a referenced name matching no declaration anywhere.
  Currently zero after adding every real browser/vendor global this
  surfaced (see `KNOWN_GLOBALS`/`P5_GLOBAL_NAMES` in the script) — re-run
  after any `src/` change and treat a newly unmatched name as a signal to
  either extend the whitelist (real global) or investigate (possible typo).

`import_manifest.json`'s `manifest` field is the actual per-file import
list to work from during the real step-3 conversion — e.g.
`manifest["src/map/globe3d_peaks.js"]` lists `HEIGHT_CAPABLE_METRICS` and
`GSRGlobeManager`, both `from: "src/map/globe3d.js"`.

## `pilot/` (step 2)

Proves the chosen test-harness replacement technique — jsdom window built
as today, its properties bridged onto Node's `global`, then a dynamic
`import()` of the real entry module, replacing `vm.createContext` +
`SCRIPT_ORDER` — against a few small files before rewriting the real
`boot_app.js`/`boot_live.js`. Run: `node --test tests/manual/esm_migration/pilot/test_pilot.js`.

Two real bugs were found and fixed while building this (not hypothetical —
both reproduced before the fix, see the comments in `boot_pilot.js`):

1. **The bridge must plain-overwrite `global.window`/`global.document` on
   every call, not install them as one-time accessors.** `bootPilot()` is
   called once per test with a fresh jsdom window each time (mirrors
   `bootApp()`'s existing "each call is fully isolated" contract). An
   accessor (getter/setter) installed against the *first* window's closure
   silently no-ops on later calls, since it tries to reassign a
   non-writable property on the *original* jsdom `Window` — every module
   bare-referencing `document` then keeps resolving to test #1's DOM
   forever, caught by a later test reading back an empty (wrong-document)
   `textContent`.
2. **Everything else on `window` should be copied onto `global` only if
   `global` doesn't already have that name** — i.e. prefer Node's own
   native Web-API implementations (`performance`, `fetch`, `crypto`, `URL`,
   `TextEncoder`, `structuredClone`, `Event`/`EventTarget`, all native in
   modern Node) over jsdom's. Blindly overwriting `global.performance` with
   `window.performance` caused infinite recursion: jsdom's own
   `Performance.now()` calls back into the ambient `performance` global to
   compute a relative timestamp, which after the clobber resolved to
   itself.
3. **Cache-busting (the `import(url + '?t=n')` replacement for
   `require.cache` deletion) only refreshes the exact specifier you bust.**
   Busting an *entry* module doesn't isolate a module it reaches via a
   plain, non-busted `import ... from './x.mjs'` — Node's loader still
   caches that by its own URL, shared across every busted entry variant. A
   test that needs one specific module fresh (replacing what
   `test_globe3d.js` etc. do today) must `import()` that module directly
   with the busted specifier, not rely on busting a parent that re-exports
   it.

`geo_utils.mjs` is a real converted copy of `src/gps/geo_utils.js` (a true
leaf, zero cross-file references) proving a pure-function file converts and
imports cleanly. `notice_core.mjs`/`notice_augment.mjs`/`entry.mjs` are
synthetic, modelling the `ui.js`-style "core file imports and composes its
augment files" pattern plus a bare `document` reference, standing in for a
real subsystem without pulling in Leaflet/p5/Cesium stubbing just to prove
the mechanism.

## Next (step 3, not started)

Convert `src/` bottom-up through the dependency graph using the manifest
above, verifying each layer against a real (non-pilot) rewrite of
`boot_app.js` built on the now-proven technique. This is the bulk of the
migration and will span multiple sessions — see the plan for the full
sequencing and the atomic-browser-cutover constraint (step 5).
