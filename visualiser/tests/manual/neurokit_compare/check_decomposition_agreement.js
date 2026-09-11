/**
 * Third-smallest NeuroKit2 alignment check (JS side) - see
 * check_decomposition_agreement.py for the two decomposition families being
 * paired and why only the cvxEDA pairing is expected to closely agree.
 *
 * Runs our real GSRAnalyzer through decomposition twice - once with default
 * params (LPF + zero-phase-EMA tonic), once with useCvxEDA - and reports
 * correlation/RMSE for this.tonic/this.phasic against the matching NeuroKit2
 * reference on the same (confirmed-identical, see check_signal_loading.js)
 * raw signal.
 *
 * Usage (normally via check_decomposition_agreement.sh, not directly):
 *   node check_decomposition_agreement.js <python.json> <track.csv>
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

function fmt(label, s) {
  return `  ${label.padEnd(22)} n=${s.n}  max|diff|=${s.maxDiff.toFixed(4)}uS  mean|diff|=${s.meanAbsDiff.toFixed(4)}uS  RMSE=${s.rmse.toFixed(4)}uS  r=${s.r.toFixed(4)}`;
}

const [, , jsonPath, csvPath] = process.argv;
if (!jsonPath || !csvPath) {
  console.error('Usage: node check_decomposition_agreement.js <python.json> <track.csv>');
  process.exit(1);
}

const py = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const csvText = fs.readFileSync(csvPath, 'utf8');
const name = path.basename(csvPath, '.csv');

console.log(`=== ${name}: decomposition-stage agreement ===`);

// Default (LPF + zero-phase-EMA local-floor tonic) vs NeuroKit2 highpass
{
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D }, 0);
  const ourTonic = a.tonic.map(d => d.val);
  const ourPhasic = a.phasic.map(d => d.val);
  console.log(' -- highpass family (different algorithms by design) --');
  console.log(fmt('tonic vs hp_tonic', stats(ourTonic, py.hp_tonic)));
  console.log(fmt('phasic vs hp_phasic', stats(ourPhasic, py.hp_phasic)));
}

// cvxEDA vs NeuroKit2 cvxEDA - same published algorithm both sides.
//
// CVXEDA_ALPHA env var: BioMapping's production alpha (GSR_CONST.CVXEDA.alpha,
// 2e-3) is intentionally scaled up from the paper/NeuroKit2 default (8e-4) to
// compensate for our 10Hz sample rate vs the paper's 25Hz - see the comment
// on CVXEDA.alpha in constants.js. That's a deliberate product choice, not an
// implementation error, so the default run below leaves it in place and
// reports whatever gap it produces. Set CVXEDA_ALPHA=8e-4 to instead check
// IMPLEMENTATION fidelity - does our solver converge to the same point
// NeuroKit2's does, alpha held equal - which is the number that answers "is
// our cvxEDA port correct", separate from "does our tuned production config
// match the reference".
if (py.cvx_tonic && py.cvx_phasic) {
  const alphaOverride = process.env.CVXEDA_ALPHA ? parseFloat(process.env.CVXEDA_ALPHA) : null;
  const prevAlpha = global.GSR_CONST.CVXEDA.alpha;
  if (alphaOverride != null) global.GSR_CONST.CVXEDA.alpha = alphaOverride;
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D, useCvxEDA: true }, 0);
  global.GSR_CONST.CVXEDA.alpha = prevAlpha;
  const ourTonic = a.tonic.map(d => d.val);
  const ourPhasic = a.phasic.map(d => d.val);
  const alphaUsed = alphaOverride != null ? alphaOverride : prevAlpha;
  console.log(` -- cvxEDA family (same published algorithm both sides, alpha=${alphaUsed}${alphaOverride != null ? ' [CVXEDA_ALPHA override]' : ' [production default]'}) --`);
  console.log(fmt('tonic vs cvx_tonic', stats(ourTonic, py.cvx_tonic)));
  console.log(fmt('phasic vs cvx_phasic', stats(ourPhasic, py.cvx_phasic)));
} else {
  console.log(' -- cvxEDA family: no NeuroKit2 reference available (cvxopt missing?) --');
}
