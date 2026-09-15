# ES-module migration (branch `esm-migration`)

See `docs/visualizer_modularity_plan.md`'s "drop dual-mode for real ES
modules" section and the plan this session ran from for full context.
**Current status: layer 0 (24 of 93 files) converted and wired into
`npm test`, suite green. Layers 1-7 (69 files) not yet started — see "Next
steps" near the end of this file for the exact resume point, including the
full layer-1 file list.**

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

## Step 3: converting src/ (IN PROGRESS — layer 0/8 done, see "Next steps" below)

`convert_file.js` (committed) mechanically converts one file: strips the
dual-mode tail (keeping a real composition side effect like
`Object.assign(GSRUI, __methods)` where the tail has one), adds
`export`/`import`, verified byte-for-byte against 93/93 files two
independent ways (see its own header comment). `node convert_file.js
<relFile> [--write]` — `--write` renames to `.mjs` and deletes the `.js`
(package.json has no `"type":"module"` yet, deferred to the final cutover —
see the plan doc).

`scc_layers.json` is the real dependency order to convert in: 93 files
resolve to 8 topological layers (0 = leaves, 7 = most composite), with
exactly two circular clusters that must convert as one atomic batch each —
a 2-file `analyzer.js`↔`csv_parser.js` cycle (layer 3) and a 13-file
UI/live/render "app glue" cycle (layer 6: `ui.js`, `events.js`, `tracks.js`,
`storage.js`, `sketch.js`, `live_view.js`, `live_graph.js`, `live_map.js`,
`collective_project.js`, `map_exporter.js`, `map_popups.js`,
`globe3d_view.js`, `layout_manager.js`). ES modules handle these natively
via live bindings; just don't try to convert only *part* of a cycle.

### `boot_app.js`'s realm-model rewrite — DONE, suite verified green (2026-09-15)

Why it needed rewriting at all: a dynamically-`import()`ed converted file
necessarily executes in Node's own real global realm (no way to make
`import()` target a separate `vm.createContext`), so for a not-yet-converted
file to still see an already-converted file's exports as a bare global (and
vice versa), BOTH must run in that same real realm. The old
`vm.createContext(window)` model can't do that. The new model: jsdom window
bridged onto Node's `global` (the technique proven in `pilot/`), then per
`SCRIPT_ORDER` entry — `.mjs` exists (converted) → `await import()` +
`Object.assign(global, mod)` (a test-harness-only compat shim, never written
into a real src file); still `.js` → `vm.runInThisContext(...)`, run in
Node's own realm (this is exactly Pattern A's existing technique, already
proven across many passing tests). `bootApp()` is now `async` — a direct,
unavoidable consequence (`import()` has no sync form). 17 test files / ~88
call sites were mechanically converted to `async`/`await` for this (and 2
`vm.runInContext(expr, context)` reads of the old `context` return value
replaced with plain `vm.runInThisContext(expr)`, since no separate vm
context exists to hand back any more).

**First full-suite run since the rewrite surfaced 3 real bugs in the realm
model itself** (not file-conversion issues — exactly the class of thing this
step was expected to find; each is now fixed in `boot_app.js`, none worked
around in a test):

1. **Top-level `class`/`const`/`let` can't be redeclared in a shared realm.**
   V8's global *lexical* environment (unlike the global *object*) persists
   for the process and rejects a second `vm.runInThisContext('class X{}')` —
   `SyntaxError: Identifier 'X' has already been declared`, hit on literally
   the 2nd `bootApp()` call. Fixed by running each not-yet-converted file's
   source inside a fresh function scope every call (`wrapForRepeatedExecution`
   in `boot_app.js`) so its declarations never touch the shared lexical
   environment, then reflecting its real top-level names (found via espree —
   `tests/manual/esm_migration/lib/top_level_names.js`, extracted out of
   `build_import_manifest.js` so both share one implementation, verified
   byte-identical manifest output after the extraction) onto both `global`
   (for a later file's bare reference) and `window` (some src/test code
   reads these back via `window.X` — true browser `<script>` semantics for a
   bare top-level function/var, which the old `vm.createContext(window)`
   model got for free since `window` WAS the context's global object there).
2. **A `window.X = ...` assignment made AFTER boot never reached `global`.**
   `installJsdomGlobals` only did a one-time value copy at boot; test code
   routinely swaps a mock in post-boot (`window.L = recordingLeafletMock`,
   `window.mouseX = ...` per drag tick) and expects a bare identifier inside
   already-loaded app code to see it. Fixed by making every bridged name a
   live, bidirectional `Object.defineProperty` accessor onto `global` instead
   of a snapshot — plus a couple of p5 pseudo-globals (`mouseX`, `winMouseX`,
   `BOLD`, etc.) that were missing from `P5_GLOBAL_NAMES`/`P5_CONSTANTS`
   entirely, so they didn't exist on `window` at boot for the accessor to
   even pick up. `Blob`/`URL` needed the opposite of the default rule (jsdom's
   polyfill must win over Node's native one, not vice versa — see the
   `FORCE_BRIDGE_OVER_NATIVE` comment) — Node's native `URL.createObjectURL`
   does a real `instanceof Blob` check that throws given a jsdom Blob.
3. **A `setTimeout` a test doesn't wait out leaks into a LATER test.** Node's
   native timers (bare `setTimeout` in e.g. `map_manager_arousal_places.js`'s
   debounce) are process-wide, not window-scoped — a timer from test A left
   running fires during test B's window and, since its callback resolves
   `GSRSpatialClustering` etc. through the one shared `global`, silently
   re-invokes (and can increment a spy on) test B's fresh class. Fixed by
   wrapping `global.setTimeout`/`setInterval` once to track every outstanding
   timer, and sweeping the previous generation at the top of every
   `bootApp()` call — restores the "each call is fully isolated" contract
   the function's own doc comment already promised.

Suite verified 1345/1345 green twice in a row, zero files converted, before
committing this checkpoint (`5f1c6c9`).

### Prep work done before any layer-0 file converted (commit `cadc0a1`)

34 lightweight (non-jsdom) unit test files each hand-rolled their own local
`loadModule(filePath, varName)` helper (regex-rewrite the dual-mode source,
`vm.runInThisContext` it) to pull in individual `src/` files without booting
the full app via `boot_app.js`. Every one would have broken the moment its
target file(s) converted, and several load a dozen files each — so all 34
were pointed at one shared `tests/support/load_module.js` instead (mirrors
`boot_app.js`'s own `resolveFile()` rule: `.js` still there → the same
regex+vm technique; `.mjs` exists → plain synchronous `require()` — Node
natively supports `require()`-ing a real ES module with no top-level await,
verified against this project's converted files — kept deliberately
*synchronous*, since several of these 34 files are plain top-level scripts
with no `node:test` wrapping at all and can't be made async). Zero files
converted at this point; pure refactor, suite still 1345/1345 before and
after.

### Layer 0 (24 files) — DONE (commit `0d038b1`)

Every layer-0 leaf converted: `notices.js` (previous checkpoint) plus
`response_dynamics`, `fullscreen`, `geo_utils`, `file_saver`,
`analyzer_time_format`, `stats_math`, `spectral_eda`, `hillshade`,
`spatial_grid`, `marching_squares`, `bezier_spline`, `basemap`, `renderer`,
`overpass_client`, `live_state`, `live_tile_cache`, `map_markers`,
`live_csv`, `live_binary_parser`, `dwt_filter`,
`map/globe3d/{exporters,rf_expanse,buildings}`.

`boot_live.js` got the identical realm-model rewrite `boot_app.js` already
had — required once layer 0 included several `live/*.js` files
`LIVE_SCRIPT_ORDER` also loads. The shared realm-model machinery
(`installJsdomGlobals`, `resolveFile`, `wrapForRepeatedExecution`,
`loadScriptFile`, the timer-leak sweep) was extracted out of `boot_app.js`
into `tests/support/realm_bridge.js` so both harnesses use one
implementation instead of drifting — `boot_app.js` itself was refactored to
call into it too (behavior-preserving, verified before touching
`boot_live.js`).

Doing this rewrite for real (not just boot_app.js in isolation) surfaced
several more realm-model bugs, all fixed in `realm_bridge.js` — general
fixes, not specific to this batch, so future layers shouldn't hit them
again:

1. **A converted file's real top-level side effect only ran on the FIRST
   import in the process.** Node's ES module loader caches a module by its
   resolved specifier for the process lifetime — `live_tile_cache.mjs`'s
   `L.tileLayer.cache = function(){...}` (needs to re-attach to THIS boot's
   fresh `L` mock) and `notices.mjs`'s `window.addEventListener('error', ...)`
   (needs to re-register on THIS boot's fresh window) only fired once,
   ever. Fixed with a cache-busting `?t=n` query string on every `import()`
   call, forcing a genuinely fresh module instance (and therefore a fresh
   top-level run) on every boot — matching what
   `wrapForRepeatedExecution` already guaranteed for not-yet-converted
   files.
2. **A `class`/`function` reflected as get-only (from the `const`-crash fix
   in the previous checkpoint) silently swallowed a legitimate test-side
   reassignment.** Several tests deliberately null out a not-yet-converted
   file's top-level class via `vm.runInThisContext('RFFluidRenderer =
   undefined;')` to opt out of a feature (`test_map_layer_ownership.js`'s
   `bootWithRecordingL`) — a get-only accessor no-ops that write in sloppy
   mode instead of applying it, so the real class stayed in place and the
   test's mock (missing `getPane`) got hit for real. Verified empirically
   that unlike `const`, reassigning a `class`/`function`/`let`/`var`
   top-level binding from a SEPARATE, later `vm.runInThisContext` script
   does NOT throw (`vm.runInThisContext('class Foo{}');
   vm.runInThisContext('Foo = undefined;')` succeeds silently) — so
   `topLevelMutableNames()` (`tests/manual/esm_migration/lib/
   top_level_names.js`) now includes class/function declarations too;
   only a real `const` stays get-only.
3. **Node's own native `navigator`/`fetch` were silently winning over
   jsdom's `window.navigator`/`window.fetch`.** Same class of bug as the
   `Blob`/`URL` fix from the previous checkpoint, just not caught until a
   test that overrides `window.navigator.bluetooth` or `window.fetch`
   actually ran — extended `FORCE_BRIDGE_OVER_NATIVE` to cover both.
4. **A converted file's exports were reflected onto `global` but not
   `window`.** Several tests read a module's own exports via
   `const { X } = window` (matching pre-conversion behavior, where the
   wrapped-file branch already bridged both) — `loadScriptFile`'s converted
   branch now reflects onto both too.
5. **The big one: a name loaded by only ONE harness's boot leaked into the
   other.** `boot_app.js`'s `SCRIPT_ORDER` and `boot_live.js`'s
   `LIVE_SCRIPT_ORDER` overlap but differ — e.g. `GSRLayoutManager` loads
   only via `boot_app.js`. Once both share one realm, a name from a
   PREVIOUS `bootApp()` call stayed on `global` as a live property forever
   (nothing ever clears it), so a LATER `bootLive()` boot in the same
   process — `test_fullscreen_restore.js` calls both — silently inherited
   it and took the wrong branch (`live_view.js`'s FAB fullscreen handler
   prefers `GSRLayoutManager.enterLiveDisplayMode` over
   `GSRFullscreen.request` whenever the former is merely *defined*, not
   actually relevant to the standalone-live-view scenario). Fixed by
   tracking every name ever reflected onto `global` and sweeping all of
   them at the top of every boot (either harness) — same reasoning as the
   `setTimeout` leak sweep in the previous checkpoint; both are now one
   `clearPreviousBoot()` entry point.

Two test-authored bugs the realm-model change also exposed, fixed in the
test files themselves (not app code): `test_live_app.js`'s
`recordingTimers()` patched `window.setTimeout`, but a bare
`setTimeout(...)` call in not-yet-converted app code resolves through
`global.setTimeout` (`realm_bridge.js`'s own leak-tracking wrapper around
the real native timer) — so the override recorded nothing and the real,
multi-second backoff delays actually ran (several tests took 3-23 REAL
seconds until this was fixed). And two of its inline
`vm.runInThisContext` snippets declared `const __orig = ...` in two
different tests, colliding with the same top-level-redeclaration
restriction `wrapForRepeatedExecution` works around for real `src/` files —
changed to `var` (redeclaration-safe, verified empirically) since these are
one-off test snippets, not files worth wrapping.

Suite verified 1345/1345 green three times in a row before committing.

### Next steps, in order

1. **Layer 1 (9 files, all independent leaves — order doesn't matter):**
   `src/core/constants.js`, `src/signal/gsr_filter.js`,
   `src/signal/deconvolution.js`, `src/map/map_colors.js`,
   `src/osm/osm_cache.js`, `src/gps/gps_filter.js`,
   `src/live/live_bluetooth.js`, `src/spatial/arousal_places.js`,
   `src/render/label_placement.js`. Same process as layer 0: `node
   tests/manual/esm_migration/convert_file.js <file> --write`, then re-run
   `npm test` — the loadModule/boot_app.js/boot_live.js loaders should now
   need ZERO further edits per file (that was the whole point of this
   checkpoint's prep work), but a handful of test files still directly
   `require('../src/X.js')` or `readFileSync` raw source for
   content-matching assertions (grep the file's basename across `tests/`
   the same way this checkpoint did) — expect a few of those per layer,
   fix inline as they surface, don't defer. If `npm test` surfaces a NEW
   realm-model bug class (not one of the 5 above), fix it in
   `realm_bridge.js`, not with a workaround in a test.
2. Continue layer by layer: 2 (6 files), 3 (13 files — **one 2-file SCC:
   `analyzer.js`↔`csv_parser.js`, convert as one atomic batch**), 4 (4
   files), 5 (1 file), 6 (22 files — **one 13-file SCC: `ui.js`,
   `events.js`, `tracks.js`, `storage.js`, `sketch.js`, `live_view.js`,
   `live_graph.js`, `live_map.js`, `collective_project.js`,
   `map_exporter.js`, `map_popups.js`, `globe3d_view.js`,
   `layout_manager.js` — convert as one atomic batch**), 7 (14 files, the
   most composite — last layer, includes `index.html`'s eventual final
   entry points).
3. Once every file is converted: the atomic browser cutover (index.html →
   single `<script type="module">`, `boot_app.js`/`boot_live.js` themselves
   rewritten one more time to a real dynamic-import-based loader instead of
   the migration-era realm bridge, `package.json` gets `"type": "module"`)
   — this is the step where the app goes from "intentionally
   non-functional in the browser mid-migration" back to working, and where
   this branch is finally safe to merge to `main`. Not attempted yet.
