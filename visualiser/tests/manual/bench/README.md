# Track-parametrised benchmark runner

Real production functions, timed against real track CSVs, one table per area,
one row per track. Built because the walks differ enormously — a 6k-row indoor
clip and a 40k-row / 900-peak city loop hit the same code paths 10–40× apart,
and a single-track headline number hides that.

```
node tests/manual/bench/run.js [area ...] [options]
```

Nothing here runs in `npm test`. Every number is a measurement, not an assertion.

## Options

| flag | meaning |
|---|---|
| `--tracks=<spec>` | comma list of **set names** and/or **filenames**. Default `default`. |
| `--areas=a,b` | same as positional area names |
| `--iters=N` / `--warmup=N` | override per-area loop counts |
| `--json` | machine-readable results on stdout (progress on stderr) — diff two runs to catch regressions |
| `--list` | print areas + track sets, exit |

### Track sets

| set | tracks | shape |
|---|---|---|
| `tiny` | biomap_048 | ~5.9k rows, 140 peaks, 3 clusters |
| `small` | biomap_113 | ~11k rows, 332 peaks, 13 clusters |
| `medium` | biomap_015, Newhaven | ~14–15k rows |
| `large` | biomap_016, biomap_059, biomap_019 | 35–41k rows, up to 900 peaks / 19 clusters |
| `default` | biomap_048, biomap_113, biomap_015, biomap_016 | a deliberate spread |
| `all` | every CSV on disk (~68) | slow |

`--tracks=large`, `--tracks=biomap_016,biomap_113`, `--tracks=small,large` all work.
Filenames may omit `.csv`.

## Areas

| area | what it times | trigger in the app |
|---|---|---|
| `analyze` | `GSRAnalyzer.analyze()` HIT (peak/shape slider) vs MISS (filter slider) | every settled GSR-slider frame |
| `signal-metrics` | peakDensity + phasicAUC + arousalIndex + triIndex | graphView change |
| `arousal-places` | `compactClusters` + `buildPlaces` + every `getConcaveBlob`, split out | peak/merge slider, exclusion toggle |
| `label-placement` | `GSRLabelManager.computeLabelPositions` at 25 / 100 / all peaks labelled | every peak-marker render |
| `gps-pipeline` | `_getOrBuildDrawPoints` for a GPS-slider frame (kalmanR nudged each iter so the whole cache chain, reconstruct included, genuinely misses) | every GPS-slider frame |
| `render-single` | `renderData()` full · `refreshPeakMarkers()` warm-cache · forced miss | single-track map redraw |
| `graph-draw` | p5 `draw()` at full zoom and a 60 s window (16.6 ms = one 60fps frame) | every hover / scrub / redraw |
| `contour-surface` | `generateContourSurface()` IDW vs "peaks" KDE | collective contour slider |
| `render-collective` | `renderCollectiveData()` **cold**, with the `buildPlaces` portion broken out | enter collective / add track / exclusion / merge slider |

`contour-surface` and `render-collective` consume the whole resolved track set
as one fixture (one row); the rest are one row per track.

## Caveats

- **Mock Leaflet.** Layer add/remove is modelled with Maps/Arrays, no real DOM.
  Pure-compute numbers (`analyze`, `arousal-places`, `label-placement`,
  `signal-metrics`, `gps-pipeline`) are faithful. Anything that builds map
  layers (`render-single` warm, `render-collective`) understates a real
  browser — the browser adds marker/polygon DOM cost on top.
- **Fresh boot + track reload per area.** `analyze()` mutates its analyzer;
  `renderData()` warms the GPS + Arousal Places caches; `generateContourSurface`
  reads a warm `filteredGps`. Sharing one context across areas silently made
  later areas look 3–6× faster (measured). Cost: ~150 ms boot + one
  `analyze()` per track, per area. A `default` run is ~19 s.
- **`primeGps`.** Areas that read peak coordinates (`arousal-places`,
  `label-placement`, `contour-surface`) run the GPS filter pipeline once first,
  because `analyzer.getCoordinates` prefers `filteredGps` and every production
  render path builds it before reading peaks — skip it and you'd cluster/place
  on raw GPS, drifting from what the app renders.
- **Medians only.** Each cell is a median of `iters` runs. Cold-JIT on a fresh
  boot widens the spread; bump `--iters` if a number looks noisy.

## Adding an area

Append to the array in `areas.js`:

```js
{
  name: 'my-area',
  title: 'one line shown above the table',
  perTrack: true,                       // false → gets ctx.tracks, returns rows[]
  columns: [{ key: 'foo', label: 'foo ms' }],
  run({ h, window, mapManager, map, track, tracks, GSR_CONST, opts }) {
    const r = h.bench(() => realProductionFn(track.analyzer), { iters: 10 });
    return { foo: r.median };           // perTrack: one object; else [{track, foo}]
  },
}
```

`h.bench(fn, {warmup, iters})` → `{median, mean, min, max, p95, n}`.
Time the shipping function, never a reimplementation.
