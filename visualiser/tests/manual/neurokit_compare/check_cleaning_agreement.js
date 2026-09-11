/**
 * Second-smallest NeuroKit2 alignment check (JS side) - see
 * check_cleaning_agreement.py for what this proves and why it's not a
 * pass/fail exact-match check the way check_signal_loading.js is.
 *
 * Runs our real GSRAnalyzer up to (and no further than) the cleaning stage -
 * this.filtered, the median+LPF output feeding tonic/phasic decomposition -
 * and reports correlation/RMSE against NeuroKit2's eda_clean() output on the
 * same (confirmed-identical) raw signal.
 *
 * Usage (normally via check_cleaning_agreement.sh, not directly):
 *   node check_cleaning_agreement.js <python.json> <track.csv>
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

function stats(a, b) {
  const n = Math.min(a.length, b.length);
  let maxDiff = 0, sumAbs = 0, sumSq = 0;
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    const d = Math.abs(x - y);
    maxDiff = Math.max(maxDiff, d);
    sumAbs += d; sumSq += d * d;
    sumA += x; sumB += y; sumAB += x * y; sumA2 += x * x; sumB2 += y * y;
  }
  const meanA = sumA / n, meanB = sumB / n;
  const cov = sumAB / n - meanA * meanB;
  const varA = sumA2 / n - meanA * meanA;
  const varB = sumB2 / n - meanB * meanB;
  return {
    n,
    maxDiff,
    meanAbsDiff: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
    r: cov / Math.sqrt(varA * varB),
  };
}

const [, , jsonPath, csvPath] = process.argv;
if (!jsonPath || !csvPath) {
  console.error('Usage: node check_cleaning_agreement.js <python.json> <track.csv>');
  process.exit(1);
}

const py = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const csvText = fs.readFileSync(csvPath, 'utf8');

const a = new GSRAnalyzer();
a.parseCSV(csvText);
a.analyze({ ...D }, 0);
const ourCleaned = a.filtered.map(d => d.val);

const name = path.basename(csvPath, '.csv');
const s = stats(ourCleaned, py.cleaned);

console.log(`=== ${name}: cleaning-stage agreement (ours: 0.5s box LPF, medianSize=${D.medianSize}  vs  NeuroKit2: eda_clean 4th-order 3Hz Butterworth) ===`);
console.log(`  n=${s.n}  max|diff|=${s.maxDiff.toFixed(4)}uS  mean|diff|=${s.meanAbsDiff.toFixed(4)}uS  RMSE=${s.rmse.toFixed(4)}uS  r=${s.r.toFixed(4)}`);
