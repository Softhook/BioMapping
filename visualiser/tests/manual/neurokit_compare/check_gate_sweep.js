/**
 * Scores the existing Full-Scan SNR and quality gates against every generated
 * ground-truth track. This is an investigation tool, not a production setting
 * chooser: validate its best candidate on held-out labelled recordings.
 *
 * Usage: node check_gate_sweep.js <ground_truth_dir>
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
const TOL = 1.0;

function score(peakTimes, trueScrs) {
  const used = new Array(trueScrs.length).fill(false);
  let tp = 0;
  for (const time of peakTimes) {
    let best = -1;
    let bestDelta = Infinity;
    for (let index = 0; index < trueScrs.length; index++) {
      if (used[index]) continue;
      const delta = Math.abs(trueScrs[index].time - time);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = index;
      }
    }
    if (best !== -1 && bestDelta <= TOL) {
      used[best] = true;
      tp++;
    }
  }
  return { tp, fn: trueScrs.length - tp, fp: peakTimes.length - tp };
}

function summarize(result) {
  const recall = result.tp / (result.tp + result.fn);
  const precision = result.tp / (result.tp + result.fp);
  const f1 = recall + precision ? 2 * recall * precision / (recall + precision) : 0;
  return { ...result, recall, precision, f1 };
}

const [, , groundTruthDir] = process.argv;
if (!groundTruthDir) {
  console.error('Usage: node check_gate_sweep.js <ground_truth_dir>');
  process.exit(1);
}

const tracks = fs.readdirSync(groundTruthDir)
  .filter(file => file.endsWith('.csv'))
  .sort()
  .map(file => {
    const stem = path.basename(file, '.csv');
    return {
      name: stem,
      csv: fs.readFileSync(path.join(groundTruthDir, file), 'utf8'),
      truth: JSON.parse(fs.readFileSync(path.join(groundTruthDir, `${stem}.ground_truth.json`), 'utf8')).scrs,
    };
  });

const thresholdValues = [0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.075, 0.1];
const snrValues = [0, 1.5, 2, 2.5, 3, 4, 5, 6];
const qualityValues = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
const candidates = [];

for (const peakThreshold of thresholdValues) {
  for (const shapeMinSnr of snrValues) {
    for (const minPeakQuality of qualityValues) {
      const total = { tp: 0, fn: 0, fp: 0 };
      const perTrack = [];
      for (const track of tracks) {
        const analyzer = new GSRAnalyzer();
        analyzer.parseCSV(track.csv);
        analyzer.analyze({ ...D, peakThreshold, shapeMinSnr, minPeakQuality }, 0);
        const result = score(analyzer.peaks.map(peak => peak.time), track.truth);
        total.tp += result.tp;
        total.fn += result.fn;
        total.fp += result.fp;
        perTrack.push({ name: track.name, ...summarize(result) });
      }
      candidates.push({ peakThreshold, shapeMinSnr, minPeakQuality, ...summarize(total), perTrack });
    }
  }
}

candidates.sort((left, right) => right.f1 - left.f1 || right.recall - left.recall || right.precision - left.precision);
const production = candidates.find(candidate => candidate.peakThreshold === D.peakThreshold && candidate.shapeMinSnr === D.shapeMinSnr && candidate.minPeakQuality === D.minPeakQuality);
const best = candidates[0];

function print(label, candidate) {
  const pct = value => `${(value * 100).toFixed(1)}%`;
  console.log(`${label}: amplitude >= ${candidate.peakThreshold}uS, SNR >= ${candidate.shapeMinSnr}, quality >= ${candidate.minPeakQuality}`);
  console.log(`  recall ${pct(candidate.recall)}  precision ${pct(candidate.precision)}  F1 ${candidate.f1.toFixed(3)}  TP ${candidate.tp} FN ${candidate.fn} FP ${candidate.fp}`);
  for (const track of candidate.perTrack) {
    console.log(`  ${track.name.padEnd(22)} recall ${pct(track.recall)}  precision ${pct(track.precision)}  F1 ${track.f1.toFixed(3)}`);
  }
}

console.log(`=== Full-Scan gate sweep across ${tracks.length} ground-truth tracks ===`);
print('Production defaults', production);
print('Best in-sample candidate', best);
console.log('\nTop five candidates:');
for (const candidate of candidates.slice(0, 5)) {
  console.log(`  amplitude >= ${candidate.peakThreshold}uS, SNR >= ${candidate.shapeMinSnr}, quality >= ${candidate.minPeakQuality}: F1 ${candidate.f1.toFixed(3)}, recall ${(candidate.recall * 100).toFixed(1)}%, precision ${(candidate.precision * 100).toFixed(1)}%`);
}

// A candidate is rejected only when it is BOTH small and slow. Unlike a plain
// threshold, this leaves a small but fast true SCR and a slow but substantial
// one untouched. These are benchmark-only post-detection experiments.
const combinedAmplitudeFloors = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1];
const combinedSlopeFloors = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1];
const baselineByTrack = new Map();
const peakSets = new Map();
for (const track of tracks) {
  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(track.csv);
  analyzer.analyze({ ...D }, 0);
  const baseline = score(analyzer.peaks.map(peak => peak.time), track.truth);
  baselineByTrack.set(track.name, baseline.tp);
  peakSets.set(track.name, analyzer.peaks);
}

const combinedCandidates = [];
for (const amplitudeFloor of combinedAmplitudeFloors) {
  for (const slopeFloor of combinedSlopeFloors) {
    const total = { tp: 0, fn: 0, fp: 0 };
    let retainsBaselineRecall = true;
    for (const track of tracks) {
      const kept = peakSets.get(track.name).filter(peak =>
        !(peak.amplitude < amplitudeFloor && peak.onsetSlope < slopeFloor));
      const result = score(kept.map(peak => peak.time), track.truth);
      total.tp += result.tp;
      total.fn += result.fn;
      total.fp += result.fp;
      if (result.tp !== baselineByTrack.get(track.name)) retainsBaselineRecall = false;
    }
    combinedCandidates.push({ amplitudeFloor, slopeFloor, retainsBaselineRecall, ...summarize(total) });
  }
}

const safeCombined = combinedCandidates
  .filter(candidate => candidate.retainsBaselineRecall)
  .sort((left, right) => right.f1 - left.f1 || right.precision - left.precision);
console.log('\n=== Combined small-and-slow post-detection experiment ===');
if (safeCombined.length === 0) {
  console.log('  No candidate retained the production detector\'s true-positive count on every scenario.');
} else {
  for (const candidate of safeCombined.slice(0, 5)) {
    console.log(`  reject when amplitude < ${candidate.amplitudeFloor}uS AND slope < ${candidate.slopeFloor}uS/s: F1 ${candidate.f1.toFixed(3)}, recall ${(candidate.recall * 100).toFixed(1)}%, precision ${(candidate.precision * 100).toFixed(1)}%, FP ${candidate.fp}`);
  }
}