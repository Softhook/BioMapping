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

// ── §A A/B Bench: Monotonic Deque vs Nested Loop Window Min ──────────────────
console.log('── §A A/B Bench: Sliding-Window Minimum on real data (biomap_019.csv) ──\n');
{
  const { analyzer } = loadTrack('biomap_019.csv');
  const n = analyzer.raw.length;
  // Synthesize a dummy signal of same length
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.sin(i * 0.1) * 2;
  const halfWindow = Math.max(1, Math.round(6 * 10.0)); // ±6 s at 10Hz

  const runBruteForce = () => {
    const localOffsets = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(0, i - halfWindow);
      const e = Math.min(n - 1, i + halfWindow);
      let mn = Infinity;
      for (let j = s; j <= e; j++) {
        if (signal[j] < mn) mn = signal[j];
      }
      localOffsets[i] = mn;
    }
    return localOffsets;
  };

  const runMonotonicDeque = () => {
    const localOffsets = new Array(n);
    const bwd = new Array(n);
    const dq1 = [];
    for (let i = 0; i < n; i++) {
      if (dq1.length > 0 && dq1[0] < i - halfWindow) dq1.shift();
      while (dq1.length > 0 && signal[dq1[dq1.length - 1]] >= signal[i]) dq1.pop();
      dq1.push(i);
      bwd[i] = signal[dq1[0]];
    }
    const dq2 = [];
    for (let i = n - 1; i >= 0; i--) {
      if (dq2.length > 0 && dq2[0] > i + halfWindow) dq2.shift();
      while (dq2.length > 0 && signal[dq2[dq2.length - 1]] >= signal[i]) dq2.pop();
      dq2.push(i);
      localOffsets[i] = Math.min(bwd[i], signal[dq2[0]]);
    }
    return localOffsets;
  };

  const bruteResult = bench(runBruteForce, 5, 20);
  const dequeResult = bench(runMonotonicDeque, 5, 20);

  console.log(`  O(N×W) Nested Loop:   median=${bruteResult.median.toFixed(3)}ms`);
  console.log(`  O(N) Monotonic Deque: median=${dequeResult.median.toFixed(3)}ms`);
  console.log(`  → §A optimization is ${(bruteResult.median / dequeResult.median).toFixed(1)}x faster\n`);
}

// ── §B A/B Bench: computeCombinedArousalIndex optimizations ─────────────────
console.log('── §B A/B Bench: computeCombinedArousalIndex optimizations (biomap_019.csv) ──\n');
{
  const { analyzer } = loadTrack('biomap_019.csv');
  // run full analyze once to populate tonic/phasic
  const params = JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));
  analyzer.analyze(params, 0);

  // Old computeCombinedArousalIndex implementation (without precomputed AUC & using .map)
  const runOldArousalIndex = () => {
    const n = analyzer.phasic.length;
    if (n === 0) return [];
    const auc = analyzer.computePhasicAUC(30);
    const tonicVals = analyzer.tonic.map(d => d.val);
    const aucVals = auc.map(d => d.val);
    const tonicStats = GsrFilter.calculateStats(tonicVals);
    const aucStats = GsrFilter.calculateStats(aucVals);
    const arousalIndex = new Array(n);
    for (let i = 0; i < n; i++) {
      const tZ = (analyzer.tonic[i].val - tonicStats.mean) / tonicStats.std;
      const aZ = (aucVals[i] - aucStats.mean) / aucStats.std;
      arousalIndex[i] = {
        time: analyzer.phasic[i].time,
        val: (0.3 * tZ) + (0.7 * aZ)
      };
    }
    return arousalIndex;
  };

  const runNewArousalIndex = () => {
    return analyzer.computeCombinedArousalIndex(0.3, 0.7, analyzer.phasicAUC);
  };

  const oldResult = bench(runOldArousalIndex, 5, 20);
  const newResult = bench(runNewArousalIndex, 5, 20);

  console.log(`  Old (no precompute + maps): median=${oldResult.median.toFixed(3)}ms`);
  console.log(`  New (precomputed + inline): median=${newResult.median.toFixed(3)}ms`);
  console.log(`  → §B optimization is ${(oldResult.median / newResult.median).toFixed(1)}x faster\n`);
}
