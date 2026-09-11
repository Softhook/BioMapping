/**
 * Ground-truth detector race: unlike every other check in this
 * investigation (which only ever asks "does ours agree with NeuroKit2's"),
 * this asks "which one is actually closer to a KNOWN answer". The tracks are
 * synthetic (generate_ground_truth.py, using NeuroKit2's own canonical SCR
 * generator - see that file's docstring for why this stays a genuinely
 * independent ground truth rather than something either detector was tuned
 * against), so the true peak count and timing are known exactly, not
 * inferred.
 *
 * Scores four methods against the same ground truth on the same track:
 * our Full-Scan, our Prominence, our cvxEDA, and NeuroKit2's own default
 * detector (already run via run_neurokit.py, reused as-is).
 *
 * Usage (normally via check_ground_truth.sh, not directly):
 *   node check_ground_truth.js <ground_truth.json> <neurokit.json> <track.csv>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.GSR_CONST = require('../../mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`), `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}

const SRC = path.join(__dirname, '../../../src/signal');
loadModule(path.join(SRC, 'dwt_filter.js'), 'DWT');
loadModule(path.join(SRC, 'gsr_filter.js'), 'GsrFilter');
global.CVXEDA = require(path.join(SRC, 'cvxeda.js'));
loadModule(path.join(SRC, 'deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(SRC, 'csv_parser.js'), 'GSRCSVParser');
loadModule(path.join(SRC, 'analyzer.js'), 'GSRAnalyzer');
const { GSRAnalyzer } = global;
const D = global.GSR_CONST.GSR_DEFAULT;

const TOL = 1.0; // seconds - same match window used throughout this investigation

function score(oursTimes, trueTimes) {
  const usedTrue = new Array(trueTimes.length).fill(false);
  const deltas = [];
  oursTimes.forEach((t) => {
    let best = -1, bestD = Infinity;
    trueTimes.forEach((tt, ti) => {
      if (usedTrue[ti]) return;
      const d = Math.abs(tt - t);
      if (d < bestD) { bestD = d; best = ti; }
    });
    if (best !== -1 && bestD <= TOL) { usedTrue[best] = true; deltas.push(bestD); }
  });
  const tp = deltas.length;
  const fn = trueTimes.length - tp;
  const fp = oursTimes.length - tp;
  const recall = trueTimes.length ? tp / trueTimes.length : NaN;
  const precision = oursTimes.length ? tp / oursTimes.length : NaN;
  const f1 = (recall + precision) > 0 ? 2 * recall * precision / (recall + precision) : 0;
  const meanDelta = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : NaN;
  return { tp, fn, fp, recall, precision, f1, meanDelta };
}

function fmt(label, s) {
  const pct = (x) => Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(1) + '%';
  return `  ${label.padEnd(20)} recall ${pct(s.recall).padStart(6)}  precision ${pct(s.precision).padStart(6)}  F1 ${s.f1.toFixed(3)}  TP ${String(s.tp).padStart(3)} FN ${String(s.fn).padStart(3)} FP ${String(s.fp).padStart(3)}  mean|delta| ${Number.isNaN(s.meanDelta) ? 'n/a' : s.meanDelta.toFixed(3) + 's'}`;
}

const [, , gtPath, nkPath, csvPath] = process.argv;
if (!gtPath || !nkPath || !csvPath) {
  console.error('Usage: node check_ground_truth.js <ground_truth.json> <neurokit.json> <track.csv>');
  process.exit(1);
}

const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
const trueTimes = gt.true_peak_times;
const csvText = fs.readFileSync(csvPath, 'utf8');
const name = path.basename(csvPath, '.csv');
const nkAll = JSON.parse(fs.readFileSync(nkPath, 'utf8'));
const nk = nkAll[name];

console.log(`=== ${name}: ${trueTimes.length} true SCRs injected (duration ${gt.params.duration}s, noise ${gt.params.noise}, scr_number ${gt.params.scr_number}) ===`);

const DETECTORS = [
  ['Full-Scan', {}],
  ['Prominence', { usePeakProminence: true }],
  ['cvxEDA', { useCvxEDA: true }],
];

const results = {};
for (const [label, patch] of DETECTORS) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D, ...patch }, 0);
  const times = a.peaks.map(p => p.time);
  const s = score(times, trueTimes);
  results[label] = s;
  console.log(fmt(label, s));
}
if (nk) {
  const s = score(nk.peak_times, trueTimes);
  results['NeuroKit2'] = s;
  console.log(fmt('NeuroKit2 (default)', s));
} else {
  console.log('  (no NeuroKit2 result for this track)');
}
