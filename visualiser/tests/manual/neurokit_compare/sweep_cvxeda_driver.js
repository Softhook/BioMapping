/**
 * Sweeps the driver-domain candidate-detection parameters behind the cvxEDA
 * peak detector's 2026-09-12 fix (see eda_detection_benchmark.md item 19:
 * candidates come from local maxima in the sparse driver p = A·q, each
 * resolved to its true apex in the reconstructed curve r = M·q via a
 * kernel-offset search window, Ledalab-CDA-style). That change fixed the
 * worst of cvxEDA's false-positive problem but left three knobs at values
 * borrowed from the matching-pursuit path's own defaults, untuned for
 * cvxEDA's own driver statistics:
 *   - cvxImpulseThreshold   - driver amplitude floor for a candidate
 *   - cvxMinImpulseGapSec   - minimum gap between driver candidates
 *   - cvxApexSearchHalfWinSec - +/- window searched for the true curve apex
 *
 * The expensive part (the cvxEDA convex solve) runs exactly once per track;
 * this script then re-derives driver-domain candidates and re-runs
 * _detectPeaksFromCurve() (the analyzer's own method, not a re-implementation)
 * for every grid point directly against the cached driver/curve arrays, so
 * the sweep itself is cheap. This is an investigation tool, not a production
 * setting chooser: validate any promoted candidate against real tracks too
 * (this script only scores the synthetic ground-truth suite).
 *
 * Usage (normally via sweep_cvxeda_driver.sh, not directly):
 *   node sweep_cvxeda_driver.js <track1.csv> [track2.csv ...]
 *   (each <stem>.ground_truth.json must sit alongside its .csv)
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
const { GSRAnalyzer, SCRDeconvolution } = global;

const D = { ...global.GSR_CONST.GSR_DEFAULT, useGaitFilter: process.env.BIOMAP_USE_GAIT_FILTER === '1' };
const scf = global.GSR_CONST.SCRF;
const cvxCfg = global.GSR_CONST.CVXEDA || {};
const tauSlow = cvxCfg.tauSlow ?? scf.tauSlow;
const tauFast = cvxCfg.tauFast ?? scf.tauFast;
const TOL = 1.0; // seconds - same match window used throughout this investigation

function score(peakTimes, trueScrs) {
  const used = new Array(trueScrs.length).fill(false);
  let tp = 0;
  for (const time of peakTimes) {
    let best = -1, bestDelta = Infinity;
    for (let index = 0; index < trueScrs.length; index++) {
      if (used[index]) continue;
      const delta = Math.abs(trueScrs[index].time - time);
      if (delta < bestDelta) { bestDelta = delta; best = index; }
    }
    if (best !== -1 && bestDelta <= TOL) { used[best] = true; tp++; }
  }
  return { tp, fn: trueScrs.length - tp, fp: peakTimes.length - tp };
}

function summarize(result) {
  const recall = result.tp / (result.tp + result.fn);
  const precision = result.tp / (result.tp + result.fp);
  const f1 = recall + precision ? 2 * recall * precision / (recall + precision) : 0;
  return { ...result, recall, precision, f1 };
}

// Mirrors the candidate-generation block in analyzer.js's
// _runDeconvolutionPipeline cvxEDA branch exactly (driver local-max scan +
// min-gap, then apex resolution via a kernel-offset search window) so this
// sweep's numbers are faithful to what production code would actually do at
// each grid point, not an approximation of it.
function resolveCvxCandidates(driverVals, cleanVals, sampleRate, kPeakIdx, thresh, minGapSec, apexHalfWinSec) {
  const n = driverVals.length;
  const minGap = Math.max(1, Math.round(minGapSec * sampleRate));
  const apexHalfWin = Math.max(1, Math.round(apexHalfWinSec * sampleRate));
  const driverIdx = [];
  let lastPIdx = -minGap;
  for (let i = 1; i < n - 1; i++) {
    if (driverVals[i] >= thresh && driverVals[i] >= driverVals[i - 1] && driverVals[i] >= driverVals[i + 1]) {
      if (i - lastPIdx >= minGap) { driverIdx.push(i); lastPIdx = i; }
    }
  }
  return driverIdx.map((index) => {
    const predicted = Math.min(n - 1, index + kPeakIdx);
    const lo = Math.max(0, index, predicted - apexHalfWin);
    const hi = Math.min(n - 1, predicted + apexHalfWin);
    let bestIdx = Math.max(index, predicted), bestVal = cleanVals[bestIdx] || 0;
    for (let j = lo; j <= hi; j++) {
      if (cleanVals[j] > bestVal) { bestVal = cleanVals[j]; bestIdx = j; }
    }
    return bestIdx;
  });
}

const [, , ...trackPaths] = process.argv;
if (trackPaths.length === 0) {
  console.error('Usage: node sweep_cvxeda_driver.js <track1.csv> [track2.csv ...]');
  process.exit(1);
}

// Decompose each track exactly once (production defaults, useCvxEDA: true),
// then cache the driver/curve arrays the sweep needs - the convex solve
// dominates cost per track and must not be re-run per grid point.
const tracks = [];
for (const csvPath of trackPaths) {
  const stem = path.basename(csvPath, '.csv');
  const gtPath = path.join(path.dirname(csvPath), `${stem}.ground_truth.json`);
  if (!fs.existsSync(gtPath)) { console.warn(`Skipping ${stem}: no ground-truth file`); continue; }
  const truth = JSON.parse(fs.readFileSync(gtPath, 'utf8')).scrs;

  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(fs.readFileSync(csvPath, 'utf8'));
  analyzer.analyze({ ...D, useCvxEDA: true }, 0);

  const kernel = SCRDeconvolution.buildSCRFKernel(analyzer.sampleRate, tauSlow, tauFast, scf.kernelSec || 5.0);
  const kPeakIdx = analyzer._kernelPeakOffset(kernel);

  tracks.push({
    name: stem,
    analyzer,
    truth,
    driverVals: analyzer.phasicDriver.map(d => d.val),
    cleanVals: analyzer.phasic.map(d => d.val),
    times: analyzer.phasic.map(d => d.time),
    kPeakIdx,
  });
}
console.log(`Decomposed ${tracks.length} track(s); sweeping driver-detection parameters...`);

const threshValues = [0.002, 0.003, 0.005, 0.008, 0.012, 0.02, 0.03, 0.05];
const minGapSecValues = [0.3, 0.5, 0.8, 1.0, 1.3];
const apexHalfWinSecValues = [0.25, 0.4, 0.5, 0.75, 1.0];

const candidates = [];
for (const cvxImpulseThreshold of threshValues) {
  for (const cvxMinImpulseGapSec of minGapSecValues) {
    for (const cvxApexSearchHalfWinSec of apexHalfWinSecValues) {
      const total = { tp: 0, fn: 0, fp: 0 };
      const perTrack = [];
      for (const track of tracks) {
        const candidateIndices = resolveCvxCandidates(
          track.driverVals, track.cleanVals, track.analyzer.sampleRate, track.kPeakIdx,
          cvxImpulseThreshold, cvxMinImpulseGapSec, cvxApexSearchHalfWinSec
        );
        const peaks = track.analyzer._detectPeaksFromCurve(
          track.cleanVals, track.times, D, new Map(), new Set(), candidateIndices
        );
        const result = score(peaks.map(p => p.time), track.truth);
        total.tp += result.tp; total.fn += result.fn; total.fp += result.fp;
        perTrack.push({ name: track.name, ...result });
      }
      candidates.push({ cvxImpulseThreshold, cvxMinImpulseGapSec, cvxApexSearchHalfWinSec, ...summarize(total), perTrack });
    }
  }
}

candidates.sort((left, right) => right.f1 - left.f1 || right.recall - left.recall || right.precision - left.precision);
// Current production values: scf.impulseThreshold (shared with MP, 0.005
// default), scf.minImpulseGapSec (0.5 default), and the hardcoded 0.5s apex
// window - i.e. the grid point nearest (0.005, 0.5, 0.5).
const production = candidates.find(c =>
  c.cvxImpulseThreshold === (scf.impulseThreshold ?? 0.005) &&
  c.cvxMinImpulseGapSec === (scf.minImpulseGapSec ?? 0.5) &&
  c.cvxApexSearchHalfWinSec === 0.5
);
const best = candidates[0];

function print(label, c) {
  const pct = v => `${(v * 100).toFixed(1)}%`;
  console.log(`${label}: impulseThreshold=${c.cvxImpulseThreshold}, minGap=${c.cvxMinImpulseGapSec}s, apexWin=+/-${c.cvxApexSearchHalfWinSec}s`);
  console.log(`  recall ${pct(c.recall)}  precision ${pct(c.precision)}  F1 ${c.f1.toFixed(3)}  TP ${c.tp} FN ${c.fn} FP ${c.fp}`);
}

console.log(`\n=== cvxEDA driver-detection parameter sweep across ${tracks.length} ground-truth tracks ===`);
if (production) print('Current production (inherited MP defaults)', production);
print('Best in-sample candidate', best);
console.log('\nTop ten candidates:');
for (const c of candidates.slice(0, 10)) {
  console.log(`  impulseThreshold=${c.cvxImpulseThreshold}, minGap=${c.cvxMinImpulseGapSec}s, apexWin=+/-${c.cvxApexSearchHalfWinSec}s: F1 ${c.f1.toFixed(3)}, recall ${(c.recall * 100).toFixed(1)}%, precision ${(c.precision * 100).toFixed(1)}%, FP ${c.fp}`);
}

// Decision-Rule check (see eda_detection_benchmark.md): a candidate that
// trades away compound-burst recall is disqualified regardless of its
// aggregate F1 - compound responses are the regression check for any
// false-positive-reduction change in this investigation.
function compoundRecallLoss(candidate) {
  let productionTp = 0, candidateTp = 0;
  if (!production) return null;
  for (const t of candidate.perTrack) {
    if (!t.name.startsWith('synth_compound')) continue;
    candidateTp += t.tp;
    const prodTrack = production.perTrack.find(pt => pt.name === t.name);
    if (prodTrack) productionTp += prodTrack.tp;
  }
  return { productionTp, candidateTp };
}
console.log('\nCompound-scenario recall check (top ten vs. production):');
for (const c of candidates.slice(0, 10)) {
  const loss = compoundRecallLoss(c);
  const flag = loss && loss.candidateTp < loss.productionTp ? `  <-- LOSES compound recall (${loss.productionTp}->${loss.candidateTp})` : '';
  console.log(`  impulseThreshold=${c.cvxImpulseThreshold}, minGap=${c.cvxMinImpulseGapSec}s, apexWin=+/-${c.cvxApexSearchHalfWinSec}s: compound TP ${loss ? loss.candidateTp : 'n/a'}${flag}`);
}
