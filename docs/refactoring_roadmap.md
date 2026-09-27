# Visualiser Refactoring — To-Do List

Started from an outside audit on 2026-09-27. Every item below was checked
against the code before being kept; audit items that were wrong, already done,
or not worth the risk have been removed.

All work so far is on branch **`refactor-phase1`** (not yet merged to `main`).

---

## How to verify each item

Tests passing is not enough on its own. For anything that touches analysis
output:

1. Run `npm test` in `visualiser/` (1653 tests, 0 failures at last run).
2. Run the old code (a `git worktree` of the previous commit) and the new code
   over every recording in `tracks/` (73 files), dump the outputs to JSON and
   check they are byte-identical.
3. Break the changed code on purpose and confirm step 2 notices. RSSI values
   come in 0.5 dB steps, so an RF threshold change smaller than 0.5 dB won't
   show up.

For anything that changes drawing (plots, maps), take before/after screenshots
in a real browser (Playwright) and compare them.

Do one item at a time, one commit each.

---

## Done

- **Phase 1 hygiene** (`75f7ba8`, `2503ebf`): FFT size, EM-fog guard, honest
  `std` in `calculateStats`, shared `SUB_GHZ_BANDS`, shared detector-precedence
  helper, all `alert()` → `GSRNotices`, OSM cache retry, grid presets out of
  `draw()`, duplicate `fmtMaxSpeed` removed.
- **Phase 2** (`19b1b4d`): RF spike detection moved to `signal/rf_peaks.mjs`;
  analyzer uses `GeoUtils.haversineMeters`; every caller uses
  `GSRAnalyzer.resolveLatencyIndex` directly (fallback copies removed).
  Verified byte-identical on all 73 tracks.

---

## To do (in suggested order)

### 1. Merge `refactor-phase1` into `main`
Before merging, check the "Map area ready offline" popup on the live page in a
real browser (the only new message not yet seen on screen).

### 2. Pull the TIFF decoder out of `ndvi_sampler.mjs`
`osm/ndvi_sampler.mjs` lines ~427–627 (`_readTiffValue`, `_inflate`,
`parseFloat32Tiff`) are a hand-written FLOAT32 TIFF reader. Move it to its own
file (e.g. `osm/tiff_decoder.mjs`) with its own tests. Keep the Copernicus
error-reply detection at the start of `parseFloat32Tiff` in the NDVI sampler —
that part is service-specific, not TIFF. Self-contained, low risk.

### 3. Small NDVI tidy-up
- `NDVISampler.calculateBBox` has two fallback paths that can never run
  (`OSMEnricher.calculateBBox` always exists) — reduce it to a one-line
  delegate.
- `_backoffMs` / `_retryAfterMs` are copied in `ndvi_sampler.mjs` and
  `overpass_client.mjs` — share one copy.

### 4. Split metadata parsing out of `GSRCSVParser.parse()`
`parse()` in `signal/csv_parser.mjs` is ~760 lines. The `#` header-line
handling (RecordingStartTime, FilterParams, band floors, device lines…) is
pure text processing and can become its own function. Verify byte-identical
parse output over all 73 tracks.

### 5. Pull the NN-LASSO solver out of `deconvolution.mjs`
The linear-algebra helpers (`_norm2`, `_dot`, `_solveUpperTriangular`,
`_updateChol`, `_cholDelete`) and `_runReferenceLasso` are a general solver
inside the deconvolution model. Move them to their own file. Verify
byte-identical output, and run `check_ground_truth.sh` before and after.

### 6. Break up `draw()` in `render/sketch.mjs`
~590 lines in one function. Split into steps (layout, value ranges, axes,
curves, markers). Verify with before/after screenshots of every graph view
(signal, tonic, phasic, peak density, AUC, arousal index, driver).

### 7. Split `ui/tracks.mjs`
~755 lines mixing file loading and the sidebar track list. Separate the file
loading (CSV/zip/demo) from the list rendering. Lower value than items 2–6.

### 8. Investigate: GPS gaps are filled twice
`GSRCSVParser._interpolateGPS` draws straight lines between fixes for every raw
row; later `GpsPipeline` rebuilds the filtered path with Hermite curves. Find
out whether the parser's version is still needed. **A/B test on real tracks
before changing anything** — this is an investigation, not a move.

### Optional (cosmetic moves, only if touching the file anyway)
- Move the path-overlap code (`_buildOverlapCells` and friends, ~200 lines of
  pure maths) out of `map/map_base.mjs` into its own file.
- Move `_showRestoreFsPill` from `ui/tracks.mjs` into `core/fullscreen.mjs`.

---

## Small follow-ups

- **Decide:** error toasts auto-dismiss after 8 s, where `alert()` made you
  click OK. Should red errors stay until clicked (warnings still fade)?
- `live/live_map.mjs` still uses a blocking `confirm()` (line ~246); could
  become a `GSRNotices.dialog()`.
- `ui/ui_peaks_table.mjs:352` has a pre-existing lint warning
  (`useTemplate`).
