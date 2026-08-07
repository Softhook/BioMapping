'use strict';
/**
 * Real A/B timing for GSRAnalyzer.analyze() — the pipeline that reruns on
 * every settled GSR-slider-drag frame (rafCoalesced to one per animation
 * frame, but still a full recompute; see events.js's bindGsrSlider()). Not a
 * regression test (no assertions) — a measurement script, following the
 * `_probe_*.js` / `_bench_render_perf.js` convention in this directory. Run
 * manually:
 *
 *   node tests/manual/_bench_analyzer_perf.js
 *
 * Found via this same approach (docs/visualizer_architecture_refactor_plan.md
 * Phase 8): analyze() -> detectPeaks() -> _calculateShapeMetrics() ->
 * _computeNoiseFloor() used to rebuild `this.filtered.map(d => d.val)` — a
 * full-array copy of the WHOLE track — on every call, despite only reading a
 * small +/-halfWindow slice. Called once per candidate peak (hundreds per
 * real track), this dwarfed every other stage of analyze() combined
 * (filtering, tonic/phasic decomposition, continuous metrics, display
 * cache) on real tracks with more than a few thousand rows. Fixed to index
 * directly into this.filtered. This script proves the fix against real
 * track CSVs from ../tracks/, using the same loadModule() harness
 * tests/test_analyzer_refactoring.js already uses for direct, no-DOM
 * GSRAnalyzer testing (no bootApp()/jsdom needed here — analyze() has no
 * rendering dependency).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TRACKS_DIR = path.join(__dirname, '..', '..', '..', 'tracks');

global.window = global;
global.GSR_CONST = require('../mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src.replace(
    new RegExp(`class ${varName}\\s*{`),
    `global.${varName} = class ${varName} {`
  ).replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '..', '..', 'geo_utils.js'), 'GeoUtils');
loadModule(path.join(__dirname, '..', '..', 'stats_math.js'), 'StatsMath');
loadModule(path.join(__dirname, '..', '..', 'map_colors.js'), 'MapColors');
loadModule(path.join(__dirname, '..', '..', 'gps_filter.js'), 'GpsFilter');
loadModule(path.join(__dirname, '..', '..', 'gps_pipeline.js'), 'GpsPipeline');
loadModule(path.join(__dirname, '..', '..', 'dwt_filter.js'), 'DWT');
loadModule(path.join(__dirname, '..', '..', 'gsr_filter.js'), 'GsrFilter');
loadModule(path.join(__dirname, '..', '..', 'deconvolution.js'), 'SCRDeconvolution');

const { GSRAnalyzer } = require('../../analyzer.js');
const { GSRCSVParser } = require('../../csv_parser.js');

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function bench(fn, warmup, iters) {
  for (let i = 0; i < warmup; i++) fn();
  const samples = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { median: median(samples), min: Math.min(...samples), max: Math.max(...samples), n: iters };
}

function loadTrack(filename) {
  const analyzer = new GSRAnalyzer();
  const csv = fs.readFileSync(path.join(TRACKS_DIR, filename), 'utf8');
  analyzer.parseCSV(csv);
  const filterParams = JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));
  return { analyzer, filterParams };
}

const FILES = ['biomap_048.csv', 'biomap_019.csv', 'biomap_016.csv'];

console.log('── analyze() on real tracks: full pipeline, dominated (pre-fix) by _computeNoiseFloor() ──\n');

for (const file of FILES) {
  const { analyzer, filterParams } = loadTrack(file);
  const result = bench(() => analyzer.analyze(filterParams, 0), 3, 8);
  console.log(
    `  ${file.padEnd(22)} rows=${String(analyzer.raw.length).padStart(6)}  peaks=${String(analyzer.peaks.length).padStart(5)}` +
    `  median=${result.median.toFixed(2).padStart(8)}ms  min=${result.min.toFixed(2).padStart(7)}ms  max=${result.max.toFixed(2).padStart(7)}ms`
  );
}

console.log(`
  This runs once per settled frame of ANY of the 12 GSR sliders
  (events.js's bindGsrSlider(), rafCoalesced but not cached/skipped for
  any of them) — there is no caching layer above analyze() the way
  map.js's _getOrBuildDrawPoints() caches the GPS pipeline. A large real
  track's per-drag-frame cost is what this number represents.
`);
