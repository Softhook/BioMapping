/**
 * Smallest possible NeuroKit2 alignment check (JS side) - see
 * check_signal_loading.py for what this proves and why it comes first.
 *
 * Loads one track through our real GSRCSVParser (the exact path the app
 * takes) and diffs the resulting raw signal against the JSON dumped by
 * check_signal_loading.py: same sample count, same timestamps, same
 * microsiemens values. No filtering, no peak detection - just "did both
 * sides load the same numbers".
 *
 * Usage (normally via check_signal_loading.sh, not directly):
 *   node check_signal_loading.js <python.json> <track.csv>
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

const [, , jsonPath, csvPath] = process.argv;
if (!jsonPath || !csvPath) {
  console.error('Usage: node check_signal_loading.js <python.json> <track.csv>');
  process.exit(1);
}

const py = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const csvText = fs.readFileSync(csvPath, 'utf8');

const a = new GSRAnalyzer();
a.parseCSV(csvText);
const oursTimes = a.raw.map(d => d.time);
const oursVals = a.raw.map(d => d.val);

const name = path.basename(csvPath, '.csv');
console.log(`=== ${name}: raw-signal load agreement ===`);

if (oursVals.length !== py.values.length) {
  console.log(`  SAMPLE COUNT MISMATCH: ours ${oursVals.length} vs python ${py.values.length}`);
  process.exit(1);
}
console.log(`  sample count: ${oursVals.length} (match)`);

let maxTimeDiff = 0;
for (let i = 0; i < oursTimes.length; i++) {
  maxTimeDiff = Math.max(maxTimeDiff, Math.abs(oursTimes[i] - py.timestamps[i]));
}
console.log(`  max |timestamp diff|: ${maxTimeDiff.toExponential(3)}s`);

let maxValDiff = 0, sumAbsDiff = 0, sumSq = 0, sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
const n = oursVals.length;
for (let i = 0; i < n; i++) {
  const a_ = oursVals[i], b_ = py.values[i];
  const d = Math.abs(a_ - b_);
  maxValDiff = Math.max(maxValDiff, d);
  sumAbsDiff += d;
  sumSq += d * d;
  sumA += a_; sumB += b_; sumAB += a_ * b_; sumA2 += a_ * a_; sumB2 += b_ * b_;
}
const meanAbsDiff = sumAbsDiff / n;
const rmse = Math.sqrt(sumSq / n);
const meanA = sumA / n, meanB = sumB / n;
const cov = sumAB / n - meanA * meanB;
const varA = sumA2 / n - meanA * meanA;
const varB = sumB2 / n - meanB * meanB;
const r = cov / Math.sqrt(varA * varB);

console.log(`  value max |diff|:  ${maxValDiff.toExponential(3)} uS`);
console.log(`  value mean |diff|: ${meanAbsDiff.toExponential(3)} uS`);
console.log(`  value RMSE:        ${rmse.toExponential(3)} uS`);
console.log(`  correlation r:     ${r.toFixed(6)}`);

const TOL = 1e-6;
const ok = maxTimeDiff < 1e-6 && maxValDiff < TOL;
console.log(ok
  ? `  RESULT: PASS - signals agree within ${TOL} uS, safe to build algorithm comparisons on top`
  : `  RESULT: MISMATCH - fix signal loading before trusting any downstream comparison`);
process.exit(ok ? 0 : 1);
