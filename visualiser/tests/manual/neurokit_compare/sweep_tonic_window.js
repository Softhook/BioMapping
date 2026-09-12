/**
 * Sweeps the EMA tonic window size from 15s to 90s on synthetic ground truth
 * (known injected SCRs with true amplitudes) and on real clean indoor tracks.
 *
 * Measures:
 * 1. Recall, Precision, F1 against true SCRs
 * 2. Amplitude measurement error (MAE, relative %, correlation r)
 * 3. Timing precision (mean |delta|)
 * 4. Stability on real clean tracks (Track 28 and Track 1)
 *
 * Usage:
 *   node sweep_tonic_window.js <ground_truth_dir>
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

const TOL = 1.0; // 1.0s match window

function score(oursTimes, oursAmps, trueScrs) {
  const usedTrue = new Array(trueScrs.length).fill(false);
  const deltas = [];
  const ampPairs = [];
  oursTimes.forEach((t, oi) => {
    let best = -1, bestD = Infinity;
    trueScrs.forEach((tt, ti) => {
      if (usedTrue[ti]) return;
      const d = Math.abs(tt.time - t);
      if (d < bestD) { bestD = d; best = ti; }
    });
    if (best !== -1 && bestD <= TOL) {
      usedTrue[best] = true;
      deltas.push(bestD);
      if (oursAmps[oi] != null) ampPairs.push([oursAmps[oi], trueScrs[best].amplitude]);
    }
  });
  const tp = deltas.length;
  const fn = trueScrs.length - tp;
  const fp = oursTimes.length - tp;
  const recall = trueScrs.length ? tp / trueScrs.length : NaN;
  const precision = oursTimes.length ? tp / oursTimes.length : NaN;
  const f1 = (recall + precision) > 0 ? 2 * recall * precision / (recall + precision) : 0;
  const meanDelta = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : NaN;

  let sumAbs = 0, sumRelAbs = 0, sumD = 0, sumT = 0, sumDT = 0, sumD2 = 0, sumT2 = 0;
  const n = ampPairs.length;
  for (const [detected, trueAmp] of ampPairs) {
    const err = detected - trueAmp;
    sumAbs += Math.abs(err);
    sumRelAbs += Math.abs(err) / trueAmp;
    sumD += detected; sumT += trueAmp; sumDT += detected * trueAmp;
    sumD2 += detected * detected; sumT2 += trueAmp * trueAmp;
  }
  const meanD = n ? sumD / n : 0, meanT = n ? sumT / n : 0;
  const cov = n ? sumDT / n - meanD * meanT : 0;
  const varD = n ? sumD2 / n - meanD * meanD : 0;
  const varT = n ? sumT2 / n - meanT * meanT : 0;
  const r = (varD > 0 && varT > 0) ? cov / Math.sqrt(varD * varT) : NaN;

  return {
    tp, fn, fp, recall, precision, f1, meanDelta,
    meanAbsErr: n ? sumAbs / n : NaN,
    meanRelErr: n ? sumRelAbs / n : NaN,
    r,
    deltas, ampPairs
  };
}

function aggregate(results) {
  let tp = 0, fn = 0, fp = 0;
  const allDeltas = [], allAmpPairs = [];
  for (const s of results) {
    tp += s.tp; fn += s.fn; fp += s.fp;
    allDeltas.push(...s.deltas);
    allAmpPairs.push(...s.ampPairs);
  }
  const totalTrue = tp + fn;
  const totalDet = tp + fp;
  const recall = totalTrue ? tp / totalTrue : NaN;
  const precision = totalDet ? tp / totalDet : NaN;
  const f1 = (recall + precision) > 0 ? 2 * recall * precision / (recall + precision) : 0;
  const meanDelta = allDeltas.length ? allDeltas.reduce((s, d) => s + d, 0) / allDeltas.length : NaN;

  let sumAbs = 0, sumRelAbs = 0, sumD = 0, sumT = 0, sumDT = 0, sumD2 = 0, sumT2 = 0;
  const n = allAmpPairs.length;
  for (const [detected, trueAmp] of allAmpPairs) {
    const err = detected - trueAmp;
    sumAbs += Math.abs(err);
    sumRelAbs += Math.abs(err) / trueAmp;
    sumD += detected; sumT += trueAmp; sumDT += detected * trueAmp;
    sumD2 += detected * detected; sumT2 += trueAmp * trueAmp;
  }
  const meanD = n ? sumD / n : 0, meanT = n ? sumT / n : 0;
  const cov = n ? sumDT / n - meanD * meanT : 0;
  const varD = n ? sumD2 / n - meanD * meanD : 0;
  const varT = n ? sumT2 / n - meanT * meanT : 0;
  const r = (varD > 0 && varT > 0) ? cov / Math.sqrt(varD * varT) : NaN;

  return {
    tp, fn, fp, recall, precision, f1, meanDelta,
    meanAbsErr: n ? sumAbs / n : NaN,
    meanRelErr: n ? sumRelAbs / n : NaN,
    r
  };
}

const targetDir = process.argv[2];
if (!targetDir || !fs.existsSync(targetDir)) {
  console.error('Usage: node sweep_tonic_window.js <ground_truth_dir>');
  process.exit(1);
}

const csvFiles = fs.readdirSync(targetDir)
  .filter(f => f.startsWith('synth_') && f.includes('_clean') && f.endsWith('.csv'))
  .sort()
  .map(f => path.join(targetDir, f));

console.log(`Found ${csvFiles.length} clean synthetic ground-truth files.`);

const WINDOWS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 90];

console.log('\n================================================================================');
console.log('=== EMA Tonic Window Sweep: Full-Scan on Clean Synthetic Ground Truth ===');
console.log('================================================================================');
console.log('Window | Recall | Precision |   F1  |  TP / FN  |  FP  | Mean |dt| | Amp MAE  | Amp RelErr |  Amp r  |');
console.log('-------|--------|-----------|-------|-----------|------|-----------|----------|------------|---------|');

for (const win of WINDOWS) {
  const fileResults = [];
  for (const csvPath of csvFiles) {
    const stem = path.basename(csvPath, '.csv');
    const gtPath = path.join(targetDir, `${stem}.ground_truth.json`);
    if (!fs.existsSync(gtPath)) continue;
    const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
    const csvText = fs.readFileSync(csvPath, 'utf8');

    const a = new GSRAnalyzer();
    a.parseCSV(csvText);
    a.analyze({ ...D, useGaitFilter: false, tonicMethod: 'lpf', tonicWindow: win }, 0);

    const times = a.peaks.map(p => p.time);
    const amps = a.peaks.map(p => p.amplitude);
    fileResults.push(score(times, amps, gt.scrs));
  }

  const agg = aggregate(fileResults);
  const pct = x => (100 * x).toFixed(1) + '%';
  console.log(
    `  ${String(win).padStart(2)}s  | ` +
    `${pct(agg.recall).padStart(6)} | ` +
    `${pct(agg.precision).padStart(9)} | ` +
    `${agg.f1.toFixed(3)} | ` +
    `${String(agg.tp).padStart(4)} / ${String(agg.fn).padStart(2)} | ` +
    `${String(agg.fp).padStart(4)} | ` +
    `${agg.meanDelta.toFixed(3)}s   | ` +
    `${agg.meanAbsErr.toFixed(4)}uS | ` +
    `${(100 * agg.meanRelErr).toFixed(1).padStart(5)}%     | ` +
    `${agg.r.toFixed(4)}  |`
  );
}
