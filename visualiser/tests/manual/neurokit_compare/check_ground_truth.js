/**
 * Ground-truth detector race: unlike every other check in this
 * investigation (which only ever asks "does ours agree with NeuroKit2's"),
 * this asks "which one is actually closer to a KNOWN answer". The tracks are
 * synthetic (generate_ground_truth.py, using NeuroKit2's own canonical SCR
 * generator - see that file's docstring for why this stays a genuinely
 * independent ground truth rather than something either detector was tuned
 * against), so the true peak count, timing AND amplitude are known exactly,
 * not inferred.
 *
 * Scores four methods against the same ground truth on the same track:
 * our Full-Scan, our Prominence, our cvxEDA, and NeuroKit2's own default
 * detector (already run via run_neurokit.py, reused as-is). Each match gets
 * two verdicts: did it find the response (recall/precision/timing, as
 * before), and separately, for responses it DID find, how close was its
 * measured amplitude to the known injected amplitude - finding a peak at
 * the right time with the wrong size is a different failure mode than
 * missing it outright, and the old timing-only score couldn't see it.
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
const minGapOverride = Number.parseFloat(process.env.BIOMAP_PEAK_MIN_GAP);
if (Number.isFinite(minGapOverride) && minGapOverride > 0) {
  global.GSR_CONST.PEAK_MIN_GAP = minGapOverride;
}

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
const thresholdOverride = Number.parseFloat(process.env.BIOMAP_PEAK_THRESHOLD);
const detectorThresholdPatch = Number.isFinite(thresholdOverride) && thresholdOverride >= 0
  ? { peakThreshold: thresholdOverride }
  : {};
const gaitFilterOverride = process.env.BIOMAP_USE_GAIT_FILTER === '1';
const detectorDefaults = { ...D, useGaitFilter: gaitFilterOverride, ...detectorThresholdPatch };

// Amplitude accuracy over matched (TP) pairs only - a false positive or a
// miss has no true amplitude to compare against, so those cases are outside
// this function's scope by construction (score() already counts them).
function amplitudeStats(pairs) {
  const n = pairs.length;
  if (n === 0) return { n: 0, meanAbsErr: NaN, meanRelErr: NaN, r: NaN };
  let sumAbs = 0, sumRelAbs = 0;
  let sumD = 0, sumT = 0, sumDT = 0, sumD2 = 0, sumT2 = 0;
  for (const [detected, trueAmp] of pairs) {
    const err = detected - trueAmp;
    sumAbs += Math.abs(err);
    sumRelAbs += Math.abs(err) / trueAmp;
    sumD += detected; sumT += trueAmp; sumDT += detected * trueAmp;
    sumD2 += detected * detected; sumT2 += trueAmp * trueAmp;
  }
  const meanD = sumD / n, meanT = sumT / n;
  const cov = sumDT / n - meanD * meanT;
  const varD = sumD2 / n - meanD * meanD;
  const varT = sumT2 / n - meanT * meanT;
  return {
    n,
    meanAbsErr: sumAbs / n,
    meanRelErr: sumRelAbs / n,
    r: cov / Math.sqrt(varD * varT),
  };
}

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
  return { tp, fn, fp, recall, precision, f1, meanDelta, deltas, ampPairs, amp: amplitudeStats(ampPairs) };
}

function aggregateStats(resultsList) {
  let tp = 0, fn = 0, fp = 0, totalTrue = 0, totalDetected = 0;
  const allDeltas = [];
  const allAmpPairs = [];
  for (const s of resultsList) {
    tp += s.tp;
    fn += s.fn;
    fp += s.fp;
    totalTrue += (s.tp + s.fn);
    totalDetected += (s.tp + s.fp);
    allDeltas.push(...s.deltas);
    allAmpPairs.push(...s.ampPairs);
  }
  const recall = totalTrue ? tp / totalTrue : NaN;
  const precision = totalDetected ? tp / totalDetected : NaN;
  const f1 = (recall + precision) > 0 ? 2 * recall * precision / (recall + precision) : 0;
  const meanDelta = allDeltas.length ? allDeltas.reduce((s, d) => s + d, 0) / allDeltas.length : NaN;
  return { tp, fn, fp, recall, precision, f1, meanDelta, amp: amplitudeStats(allAmpPairs) };
}

function fmt(label, s) {
  const pct = (x) => Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(1) + '%';
  const base = `  ${label.padEnd(20)} recall ${pct(s.recall).padStart(6)}  precision ${pct(s.precision).padStart(6)}  F1 ${s.f1.toFixed(3)}  TP ${String(s.tp).padStart(4)} FN ${String(s.fn).padStart(4)} FP ${String(s.fp).padStart(4)}  mean|delta| ${Number.isNaN(s.meanDelta) ? 'n/a' : s.meanDelta.toFixed(3) + 's'}`;
  const a = s.amp;
  const ampStr = a.n ? `amp: meanAbsErr ${a.meanAbsErr.toFixed(3)}uS  meanRelErr ${(100 * a.meanRelErr).toFixed(1)}%  r ${a.r.toFixed(4)}` : 'amp: n/a (no TPs)';
  return `${base}\n  ${' '.repeat(20)} ${ampStr}`;
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node check_ground_truth.js <ground_truth_dir> <neurokit.json> [track1.csv ...]');
  console.error('   or: node check_ground_truth.js <ground_truth.json> <neurokit.json> <track.csv>');
  process.exit(1);
}

const compareTonicVariants = process.env.BIOMAP_COMPARE_TONIC === '1';
const DETECTORS = compareTonicVariants
  ? [
      ['Prominence (EMA 45s)',       { usePeakProminence: true, tonicMethod: 'lpf', tonicWindow: 45 }],
      ['Prominence (EMA 30s)',       { usePeakProminence: true, tonicMethod: 'lpf', tonicWindow: 30 }],
      ['Prominence (EMA 60s)',       { usePeakProminence: true, tonicMethod: 'lpf', tonicWindow: 60 }],
      ['Prominence (Median 30s)',    { usePeakProminence: true, tonicMethod: 'median', tonicWindow: 30 }],
      ['Prominence (Median 20s)',    { usePeakProminence: true, tonicMethod: 'median', tonicWindow: 20 }],
      ['Prominence (Median 45s)',    { usePeakProminence: true, tonicMethod: 'median', tonicWindow: 45 }],
      ['Prominence (10th-%ile 15s)', { usePeakProminence: true, tonicMethod: 'percentile', tonicWindow: 15 }],
      ['Prominence (10th-%ile 10s)', { usePeakProminence: true, tonicMethod: 'percentile', tonicWindow: 10 }],
      ['Prominence (10th-%ile 30s)', { usePeakProminence: true, tonicMethod: 'percentile', tonicWindow: 30 }],
      ['Full-Scan (EMA 45s)',        { tonicMethod: 'lpf', tonicWindow: 45 }],
      ['Full-Scan (Median 30s)',     { tonicMethod: 'median', tonicWindow: 30 }],
      ['Full-Scan (10th-%ile 15s)',  { tonicMethod: 'percentile', tonicWindow: 15 }],
      ['cvxEDA (B-spline)',          { useCvxEDA: true }],
      ['Deconvolution (MP)',         { useDeconvolution: true }],
    ]
  : [
      ['Full-Scan',      {}],
      ['Prominence',     { usePeakProminence: true }],
      ['cvxEDA',         { useCvxEDA: true }],
      ['Deconvolution',  { useDeconvolution: true }],
    ];

const firstArg = args[0];
const isDir = fs.existsSync(firstArg) && fs.statSync(firstArg).isDirectory();

let trackFiles = [];
let nkPath = '';

if (isDir) {
  const groundTruthDir = firstArg;
  nkPath = args[1];
  if (args.length > 2) {
    trackFiles = args.slice(2).map(p => path.resolve(p));
  } else {
    trackFiles = fs.readdirSync(groundTruthDir)
      .filter(f => f.endsWith('.csv'))
      .sort()
      .map(f => path.join(groundTruthDir, f));
  }
} else {
  if (args.length < 3) {
    console.error('Usage: node check_ground_truth.js <ground_truth.json> <neurokit.json> <track.csv>');
    process.exit(1);
  }
  const [gtPath, nkP, csvPath] = args;
  nkPath = nkP;
  trackFiles = [{ gtPath: path.resolve(gtPath), csvPath: path.resolve(csvPath) }];
}

const nkAll = JSON.parse(fs.readFileSync(nkPath, 'utf8'));
const aggregateMap = {};
for (const [label] of DETECTORS) {
  aggregateMap[label] = [];
}
aggregateMap['NeuroKit2 (default)'] = [];
aggregateMap['NeuroKit2 (cvxEDA)'] = [];
let totalTrueSCRs = 0;

for (const item of trackFiles) {
  const csvPath = typeof item === 'string' ? item : item.csvPath;
  const stem = path.basename(csvPath, '.csv');
  const gtPath = typeof item === 'string'
    ? path.join(path.dirname(csvPath), `${stem}.ground_truth.json`)
    : item.gtPath;

  if (!fs.existsSync(gtPath)) {
    console.warn(`Skipping ${stem}: ground-truth file not found: ${gtPath}`);
    continue;
  }

  const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'));
  const trueScrs = gt.scrs;
  totalTrueSCRs += trueScrs.length;
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const nk = nkAll[stem];

  console.log(`=== ${stem}: ${trueScrs.length} true SCRs injected (duration ${gt.params.duration}s, noise ${gt.params.noise}, scr_number ${gt.params.scr_number}; BioMapping gait filter ${detectorDefaults.useGaitFilter ? 'on' : 'off'}; peak gap ${global.GSR_CONST.PEAK_MIN_GAP}s) ===`);

  for (const [label, patch] of DETECTORS) {
    const a = new GSRAnalyzer();
    a.parseCSV(csvText);
    a.analyze({ ...detectorDefaults, ...patch }, 0);
    const times = a.peaks.map(p => p.time);
    const amps = a.peaks.map(p => p.amplitude);
    const s = score(times, amps, trueScrs);
    aggregateMap[label].push(s);
    console.log(fmt(label, s));
  }

  if (nk) {
    const s = score(nk.peak_times || [], nk.peak_amplitudes || [], trueScrs);
    aggregateMap['NeuroKit2 (default)'].push(s);
    console.log(fmt('NeuroKit2 (default)', s));
    if (nk.cvxeda_peak_times && nk.cvxeda_peak_times.length > 0) {
      const sCvx = score(nk.cvxeda_peak_times, nk.cvxeda_peak_amplitudes || [], trueScrs);
      aggregateMap['NeuroKit2 (cvxEDA)'].push(sCvx);
      console.log(fmt('NeuroKit2 (cvxEDA)', sCvx));
    }
  } else {
    console.log('  (no NeuroKit2 result for this track)');
  }
  console.log();
}

const firstDetectorLabel = DETECTORS[0][0];
if (aggregateMap[firstDetectorLabel] && aggregateMap[firstDetectorLabel].length > 1) {
  const trackCount = aggregateMap[firstDetectorLabel].length;
  console.log(`================================================================================`);
  console.log(`=== Aggregate across all ${trackCount} ground-truth tracks (${totalTrueSCRs} total true SCRs) ===`);
  console.log(`================================================================================`);
  for (const [label] of DETECTORS) {
    const agg = aggregateStats(aggregateMap[label]);
    console.log(fmt(label, agg));
  }
  if (aggregateMap['NeuroKit2 (default)'].length > 0) {
    const agg = aggregateStats(aggregateMap['NeuroKit2 (default)']);
    console.log(fmt('NeuroKit2 (default)', agg));
  }
  if (aggregateMap['NeuroKit2 (cvxEDA)'].length > 0) {
    const agg = aggregateStats(aggregateMap['NeuroKit2 (cvxEDA)']);
    console.log(fmt('NeuroKit2 (cvxEDA)', agg));
  }
  console.log();
}
