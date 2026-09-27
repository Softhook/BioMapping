# Visualiser Refactoring — To-Do List

Started from an outside audit on 2026-09-27. Every item below was checked
against the code before being kept; audit items that were wrong, already done,
or not worth the risk have been removed.

All work so far is on branch **`refactor-phase1`** (not yet merged to `main`).

---

## How to verify each item

Tests passing is not enough on its own. For anything that touches analysis
output:

1. Run `npm test` in `visualiser/` (1668 tests, 0 failures at last run).
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
- **TIFF decoder** moved out of `osm/ndvi_sampler.mjs` into
  `osm/tiff_decoder.mjs` with its own tests (`test_tiff_decoder.js`, adds
  big-endian / bad-magic / LZW cases). The Copernicus error-reply check stays
  in the NDVI sampler. Fixed on the way: the `ServiceException` pattern also
  matched the outer `<ServiceExceptionReport>` tag, so Copernicus error
  messages started with a stray `<ServiceException>` tag.
- **NDVI tidy-up**: `NDVISampler.calculateBBox` is a one-line delegate to
  `OSMEnricher.calculateBBox` (both fallbacks used the same validity check,
  so they could never find a point it had rejected). The two backoff /
  Retry-After copies are now one file, `osm/http_retry.mjs`, with its own
  tests (`test_http_retry.js`).
- **CSV metadata lines** split out of `GSRCSVParser.parse()` into
  `_parseMetadataLines()` with its own tests (`test_csv_metadata.js`).
  Verified byte-identical parse output on all 73 tracks. The Integrity
  marker only matters when a recording has no end line, which none of the
  73 tracks has, so a test for that case was added (`test_csv_integrity.js`).

---

## To do (in suggested order)

### 1. Merge `refactor-phase1` into `main`
Before merging, check the "Map area ready offline" popup on the live page in a
real browser (the only new message not yet seen on screen).

### 5. One file per deconvolution method
`signal/deconvolution.mjs` (~1440 lines) holds two separate published methods.
Give each its own file, the way `cvxeda.mjs` already is:

- **`signal/sparseda.mjs`** (~900 lines) — `_deconvolveSparsEDA` plus
  everything only it uses: `REFERENCE_STRETCHES`, `_buildReferenceDictionary`,
  `_runReferenceLasso`, the Cholesky/linear-algebra helpers (`_norm2`, `_dot`,
  `_solveUpperTriangular`, `_updateChol`, `_cholDelete`) and the resampling
  helpers (`_gcd`, `_resampledLength`, `_polyphaseResample`,
  `_linearResampleTo`, `_linearResampleBack`, `_resampleSparseDriverBack`).
  Keep the LASSO solver inside this file: it is a faithful port of the
  reference SparsEDA solver (sample-rate stopping rule, `strictReference`
  quirks), not a general-purpose tool, and nothing else uses it.
- **`signal/matching_pursuit.mjs`** (~90 lines) — `_deconvolveMP`.
- **`signal/deconvolution.mjs`** keeps what both share: `buildSCRFKernel`,
  `convolve`, `detectImpulses`, `reconstructPhasic`, and `deconvolve()` as the
  single entry point that picks the method — so `analyzer.mjs` doesn't change.

Also fix the file header: it calls matching pursuit "retained for backward
compatibility", but it is the **default** algorithm for the Deconvolution
detector (`deconvAlgorithm: 'matching_pursuit'` in `constants.mjs`).

Tests that reach into the helpers (`test_sparseda_detection.js` uses
`_updateChol` / `_cholDelete`) need their imports updated. Verify
byte-identical output over all 73 tracks with both algorithms, and run
`check_ground_truth.sh` before and after.

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
