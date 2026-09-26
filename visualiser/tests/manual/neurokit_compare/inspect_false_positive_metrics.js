/**
 * Compares Full-Scan peak metrics for known true SCRs and false detections.
 * Usage: node inspect_false_positive_metrics.js <track.csv> <ground_truth.json>
 */

const fs = require('node:fs');
const path = require('node:path');

global.window = global;
global.GSR_CONST = require('../../../src/core/constants.mjs').GSR_CONST;

const { loadModule } = require('../../support/load_module.js');

const SRC = path.join(__dirname, '../../../src/signal');
loadModule(path.join(SRC, 'dwt_filter.mjs'));
loadModule(path.join(SRC, 'gsr_filter.mjs'));
loadModule(path.join(SRC, 'cvxeda.mjs'));
loadModule(path.join(SRC, 'deconvolution.mjs'));
loadModule(path.join(SRC, 'csv_parser.mjs'));
loadModule(path.join(SRC, 'analyzer.mjs'));

const [, , csvPath, truthPath] = process.argv;
if (!csvPath || !truthPath) {
  console.error(
    'Usage: node inspect_false_positive_metrics.js <track.csv> <ground_truth.json>',
  );
  process.exit(1);
}

const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8')).scrs;
const analyzer = new global.GSRAnalyzer();
analyzer.parseCSV(fs.readFileSync(csvPath, 'utf8'));
// These synthetic tracks are stationary (no physical locomotion), so the
// gait low-pass filter is disabled here too — same convention as
// check_ground_truth.js/compare.js/benchmark_precision_rules.js — to avoid
// attenuating genuine low-amplitude responses with a filter meant for
// ambulatory motion artefacts, not present in this signal.
analyzer.analyze({ ...global.GSR_CONST.GSR_DEFAULT, useGaitFilter: false }, 0);
const usedTruth = new Array(truth.length).fill(false);
const groups = { truePositive: [], falsePositive: [] };

for (const peak of analyzer.peaks) {
  let bestIndex = -1;
  let bestDelta = Infinity;
  for (let index = 0; index < truth.length; index++) {
    if (usedTruth[index]) continue;
    const delta = Math.abs(peak.time - truth[index].time);
    if (delta < bestDelta) {
      bestIndex = index;
      bestDelta = delta;
    }
  }
  if (bestIndex >= 0 && bestDelta <= 1.0) {
    usedTruth[bestIndex] = true;
    groups.truePositive.push(peak);
  } else {
    groups.falsePositive.push(peak);
  }
}

function summary(peaks, key) {
  const values = peaks
    .map((peak) => peak[key])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return 'n/a';
  const median = values[Math.floor(values.length / 2)];
  return `median ${median.toFixed(3)}, range ${values[0].toFixed(3)}-${values.at(-1).toFixed(3)}`;
}

console.log(
  `=== ${path.basename(csvPath, '.csv')}: Full-Scan metrics against known truth ===`,
);
for (const [label, peaks] of Object.entries(groups)) {
  console.log(`  ${label}: ${peaks.length}`);
  for (const key of [
    'amplitude',
    'prominence',
    'riseTime',
    'halfRecoveryTime',
    'onsetSlope',
    'snr',
    'qualityScore',
  ]) {
    console.log(`    ${key.padEnd(17)} ${summary(peaks, key)}`);
  }
}
