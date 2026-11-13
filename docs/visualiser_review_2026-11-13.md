# Visualiser review — 13 November 2026

A fresh pass over the visualiser (and the new demo page) looking for things
that need refactoring or fixing. Checked against the decisions already
recorded in earlier reviews, so nothing here re-opens something already
settled or vetoed.

## After the fixes

Items 1–7 are fixed. Items 8 and 9 are left as they are, as the review
suggested (split them only if they start getting in the way). The two open
decisions below still need an answer from you.

After the changes: `npm run lint`, `npm run lint:deps` and
`npm run lint:unused` are clean, and `npm test` gives the same result as
before (1869 pass, 0 fail, 19 skipped).

## What was checked

- `npm run lint` (Biome), `npm run lint:deps` (dependency-cruiser) and
  `npm run lint:unused` (knip): all clean.
- `npm test`: 1869 pass, 0 fail, 19 skipped (all environment- or data-gated,
  e.g. ImageMagick not installed, GPS files with no fixes).
- Pattern sweeps across `src/`: HTML escaping at every `innerHTML` site
  (only numbers and internal labels are interpolated; road names go through
  escape helpers), `localStorage` access (all behind `SafeStorage` or
  try/catch), `JSON.parse` (all guarded), promise chains (all have `.catch`),
  event listeners (globe add/remove balanced; the rest are one-time wiring).
- A close read of the newest, least-reviewed code: the 12 Nov performance
  refactor (`map_base.mjs`, `response_delay.mjs` — both careful and correct,
  with cache-staleness guards and fallbacks) and the new front-page demo.

The main codebase is in very good shape. The real findings are almost all in
the new demo page, plus one possible lost piece of work.

## Explicit errors

### ✅ 1. Possibly lost work: the self-update feature is gone
**Done:** the feature is no longer wanted. The empty `tests/manual/update_check/` folder is removed and nothing else in the repo refers to it.

The service-worker self-update built on the morning of 13 Nov
(`visualiser/sw.js`, `src/ui/app_update.mjs`, `src/core/build_info.mjs`,
`scripts/stamp_build.mjs`, a publish job in `.github/workflows/ci.yml`) is
not in the repo: no commit, no stash, and the files are not on disk. The only
trace left is an empty `visualiser/tests/manual/update_check/` folder.
**If you deleted it on purpose, remove the empty folder; if not, the work is
lost and needs redoing.**

### ✅ 2. Demo page: typo in visible text
**Done:** now reads "without".

`index.html:54` — "often **wihtout** you noticing" should be "without".

### ✅ 3. Demo page: the text-card fallback dies if Cesium fails to load
**Done:** the viewer set-up now checks that Cesium loaded, and the angle helper `D` is plain maths instead of `Cesium.Math.toRadians`, so nothing touches Cesium outside the guard. Checked in Chrome with `Cesium.js` blocked: no errors, text cards keep cycling.

`demo/demo.mjs` catches a failure to *construct* the viewer (no WebGL) and
promises "showing the text cards only" — but line 381
(`const D = Cesium.Math.toRadians;`) runs at module level outside that
guard. If the Cesium script itself fails to load (offline, blocked CDN-less
vendor file missing), this line throws and the whole page dies, text cards
included. Move the `Cesium.*` references behind the same guard, or bail out
to a static page when `typeof Cesium === 'undefined'`.

### ✅ 4. Demo page: walk.json fetch has no error handling
**Done:** the fetch checks `r.ok` and catches failures. With no walk the page skips the 3D view, the fly-through overlay and the closing stats line, and just runs the text cards. Checked in Chrome with `walk.json` returning a 404 (and with both files missing): no errors.

`demo/demo.mjs:90` — `const walk = await fetch('demo/walk.json').then((r) => r.json());`
has no `.catch` and no `response.ok` check. A 404 (served as an HTML error
page) or a network failure kills the whole module at the top-level await, so
nothing on the page works — again including the text cards that are supposed
to survive. Check `r.ok` and fall back the same way as for a missing viewer.

### ✅ 5. Demo page: "sub-meter GPS precision"
**Done:** now reads "GPS — accurate to a few metres."

`index.html:42`. Two problems: the project uses UK spelling in visible text
("metre"), and the claim overstates the hardware — the receiver's own
reported accuracy is already known to be 3–4× optimistic. Suggest something
like "GPS accurate to a few metres".

## Refactoring worth doing

### ✅ 6. Move the path-overlap maths out of `map_base.mjs`
**Done:** moved to `src/map/path_overlap.mjs` as `PathOverlap.buildCells` / `.pooledAccessor` / `.retraces`. `manager/path.mjs` and both tests now use it. `map_base.mjs` is down from 464 to ~200 lines.

Already on the roadmap as a cosmetic move, but the 12 Nov performance work
grew that block (the 3×3 cell cache, the pooled accessor, the new
`valuesFor` bulk path), so `map_base.mjs` is now carrying ~250 lines of pure
grid maths plus its performance machinery. It is self-contained, already has
its own test file (`test_path_overlap_pooling.js`), and nothing else in
`map_base.mjs` touches it. Good next-touch candidate.

### ✅ 7. `sketch.mjs` is regrowing
**Done:** mouse, wheel and cursor handling moved to `src/render/sketch_input.mjs` (~290 lines), including the canvas listeners that `setup()` used to add inline. `sketch.mjs` keeps `setup()` and drawing (~890 lines).

It was split once (the `draw()` split), but both November interface commits
added to it again and it is back up to ~1,160 lines. It is the page-wide p5
input hub (every wheel, touch and mouse event on the page goes through it,
with the `event.target` guards), so it accumulates by nature. Worth splitting
the input handling from the drawing before the next feature lands there,
in the same style as the earlier renderer splits.

### 8. Not done (optional): `ndvi_sampler.mjs` still mixes five jobs
1,408 lines even after the TIFF decoder was extracted. It holds credential /
provider config, tile-grid maths, the LRU tile cache, the rate-limited fetch
pool with backoff, and track sampling. Each is a clean seam with tests
already in place. Nothing is wrong with it — only split it if it starts
getting in the way.

### 9. Not done (optional): `styles.css` is one 5,000-line file
Works fine for a no-build app; split by panel only if editing it becomes
annoying.

## Decisions still open (carried over, not new)

- **Error toasts** auto-dismiss after 8 s (`notices.mjs:269`) where `alert()`
  used to wait for a click. Decide whether red errors should stay until
  clicked (warnings still fading).
- **GPS quality diagnostics** remain queued from the GPS pipeline review.

## Deliberately not raised

Large files that earlier reviews decided to keep whole (`analyzer.mjs`,
`live_view.mjs`, `globe3d_view.mjs`, the deconvolution pipeline), the
demo page's small copies of visualiser helpers (colour ramp, distance,
moving average — fine for a standalone page), and anything previously
vetoed (ISCR labels, Rise Speed hint, backward-compatibility shims).
