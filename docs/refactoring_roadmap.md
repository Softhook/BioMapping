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
- **Deconvolution split by method**: `signal/sparseda.mjs` (SparsEDA solver,
  LASSO, dictionary, resampling), `signal/matching_pursuit.mjs`, and
  `signal/deconvolution.mjs` keeping the shared kernel/convolve/impulse/
  reconstruct helpers and `deconvolve()` as the single entry point. Matching
  pursuit returns its impulses and `deconvolve()` rebuilds the clean phasic,
  so the files don't import each other. Header now says matching pursuit is
  the default, not legacy. Verified byte-identical on all 73 tracks with both
  algorithms, and `check_ground_truth.sh` gives an identical report.
- **`draw()` split** in `render/sketch.mjs` into `_layoutFrame`,
  `_signalRange`, `_metricSeries`/`_metricRange`, `_refreshForceIndices`,
  `_drawContextBands`, `_drawSignalView` and `_drawMetricView` (`draw()` is
  now ~15 lines). Verified in headless Chromium: canvas pixels identical
  before/after for 27 views/states (every graph view, phasic overlay, raw
  off, matching-pursuit and SparsEDA driver/Rise Speed, zoomed in) at both
  the normal short height and full screen (timeline bar shown). Capture the
  canvas with `toDataURL`, not an element screenshot: the CSS hotspot pulse
  ring overlaps the canvas and makes screenshots differ run to run.

---

## To do (in suggested order)

### 1. Merge `refactor-phase1` into `main`
Before merging, check the "Map area ready offline" popup on the live page in a
real browser (the only new message not yet seen on screen).

### 7. Split `ui/tracks.mjs`
~755 lines mixing file loading and the sidebar track list. Separate the file
loading (CSV/zip/demo) from the list rendering. Lower value than items 2–6.

### 8. GPS gaps filled twice — done: analyses now use the drawn path
Measured on the 58 tracks with GPS (default settings), parser position vs
`filteredGps`: at real fixes median 0.6 m / p95 9 m (Kalman smoothing); on
filled rows between fixes median 1.4 m / p95 16 m; more than 5 s into a
mid-walk dropout median 10 m / p95 33 m; before the first / after the last
fix median 13 m / p95 60 m.

The parser's straight-line fill stays (it is the fallback where the smoothed
path is blank). `GpsPipeline.ensureFilteredGps()` now builds the smoothed path
on demand, and the map, the scrub dot, Arousal Places dwell/energy, NDVI
sampling and the Environmental dashboard all read it (map output identical on
all 58 tracks; Arousal Places: same places on all 53 tracks with peaks,
ranking changed on 12).

Still open:
- **GPS warm-up rows.** Rows before the first fix (up to 4½ min) have no real
  position; both paths pin them to the first position. Arousal Places then
  credits that time's skin responses to whichever place the pinned point falls
  in — this caused the largest ranking moves (e.g. biomap_016's #2 → #13).
  Probably those rows should count as "no position".
- ~~OSM enrichment~~ done: enrichment now map-matches and evaluates from
  the smoothed path before any road snap (`GpsPipeline.unsnappedPath`), and
  computes its metrics at the positions it snaps to. It deliberately does not
  take the drawn path, whose snap pull came from the previous enrichment.
  Input moved median 0.7 m / p95 12 m at the ~1 Hz evaluation points (6 %
  of points by more than 10 m; search radius 50 m). Because the Max HDOP
  and Max Speed sliders shape that path, releasing either re-runs enrichment
  from the already-loaded OSM data (as the snap radius slider does).

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
