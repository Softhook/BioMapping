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

## Step 3: converting src/ (IN PROGRESS — see handoff below)

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
committing this checkpoint.

**Next steps, in order:**
1. Start real conversion: `node tests/manual/esm_migration/convert_file.js
   <file> --write` for each of `scc_layers.json`'s layer-0 files (24 files,
   all independent leaves — order within the layer doesn't matter). After
   each file (or small batch): re-run `npm test`; any test that plain-
   `require()`s or vm-loads that specific file directly (grep for the
   file's basename across `tests/`) needs its loader swapped for a plain
   `import()` in the SAME commit — this is "step 4" work, done file-by-file
   in lockstep with step 3, not deferred to the end.
2. Continue layer by layer. Layers 3 and 6 (see above) convert as one
   atomic batch each, everything else one file at a time.
3. `boot_live.js` needs the identical realm-model rewrite eventually
   (currently untouched, still old `vm.createContext(window)`) — do it
   whenever a `live/*.js` file (all in layer 6's big cycle) is about to
   convert, not before. Give it the same 3 fixes above proactively rather
   than rediscovering them via a second failing full-suite run.
