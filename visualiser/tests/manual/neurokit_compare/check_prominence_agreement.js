/**
 * Peak-detection algorithm check, isolated from decomposition: does our
 * topographic-prominence computation (_topographicProminence(), the core of
 * _detectPeaksByProminence()) agree with NeuroKit2's own prominence
 * computation (signal_findpeaks()'s "Height" field, which its default EDA
 * peak detector - eda_findpeaks(method='neurokit') -> signal_findpeaks(...,
 * relative_height_min=0.1, relative_max=True) - gates on)?
 *
 * Both sides are fed the exact same phasic curve (ours, from our default LPF
 * decomposition), so any disagreement here is purely about the prominence
 * ALGORITHM, not about decomposition or thresholding differences. NOTE:
 * NeuroKit2's amplitude_min=0.1 gate is relative to the largest prominence
 * IN THE TRACK (10% of it), not an absolute uS value - see
 * docs/eda_decomposition_analysis.md's "Precedent" section. Earlier
 * peak-count comparisons in this harness treated 0.1 as if it were an
 * absolute threshold like our own peakThreshold; that was an
 * apples-to-oranges simplification. This check sidesteps the gating
 * question entirely and compares raw prominence values before any
 * threshold is applied.
 *
 * Usage (normally via check_prominence_agreement.sh, not directly):
 *   node check_prominence_agreement.js dump <track.csv> <out.json>
 *   node check_prominence_agreement.js compare <out.json> <nk_result.json>
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

const mode = process.argv[2];

if (mode === 'dump') {
  const csvPath = process.argv[3];
  const outPath = process.argv[4];
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D }, 0);
  const vals = a.phasic.map(d => d.val);
  const times = a.phasic.map(d => d.time);
  const prom = a._topographicProminence(vals);

  // Local maxima, same definition _detectPeaksByProminence/_detectPeaksFullScan
  // use: vals[i] > vals[i-1] && vals[i] >= vals[i+1].
  const localMaxima = [];
  for (let i = 1; i < vals.length - 1; i++) {
    if (vals[i] > vals[i - 1] && vals[i] >= vals[i + 1]) {
      localMaxima.push({ index: i, time: times[i], value: vals[i], prominence: prom[i] });
    }
  }

  fs.writeFileSync(outPath, JSON.stringify({
    sampling_rate: a.sampleRate,
    phasic: vals,
    local_maxima: localMaxima,
  }));
  console.error(`Dumped ${vals.length} phasic samples, ${localMaxima.length} local maxima -> ${outPath}`);
} else if (mode === 'compare') {
  const oursPath = process.argv[3];
  const nkPath = process.argv[4];
  const ours = JSON.parse(fs.readFileSync(oursPath, 'utf8'));
  const nk = JSON.parse(fs.readFileSync(nkPath, 'utf8'));

  // NeuroKit2's signal_findpeaks() Peaks/Height arrays, run with no gating
  // (see check_prominence_agreement.py) so every local max it finds is
  // reported - index them by sample position for direct lookup.
  const nkProm = new Map();
  for (let i = 0; i < nk.peaks.length; i++) nkProm.set(nk.peaks[i], nk.heights[i]);

  const name = path.basename(process.argv[5] || '', '.csv');
  console.log(`=== ${name}: prominence-computation agreement (same phasic curve, no gating) ===`);
  console.log(`  our local maxima: ${ours.local_maxima.length}  NeuroKit2 local maxima: ${nk.peaks.length}`);

  let matched = 0, indexMismatch = 0;
  const pairs = [];
  for (const lm of ours.local_maxima) {
    if (nkProm.has(lm.index)) {
      matched++;
      pairs.push([lm.prominence, nkProm.get(lm.index)]);
    } else {
      indexMismatch++;
    }
  }
  console.log(`  same local-maximum index found by both: ${matched}/${ours.local_maxima.length} (mismatch: ${indexMismatch})`);

  if (pairs.length > 0) {
    const n = pairs.length;
    let maxDiff = 0, sumAbs = 0, sumSq = 0, sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
    for (const [a_, b_] of pairs) {
      const d = Math.abs(a_ - b_);
      maxDiff = Math.max(maxDiff, d);
      sumAbs += d; sumSq += d * d;
      sumA += a_; sumB += b_; sumAB += a_ * b_; sumA2 += a_ * a_; sumB2 += b_ * b_;
    }
    const meanA = sumA / n, meanB = sumB / n;
    const cov = sumAB / n - meanA * meanB;
    const varA = sumA2 / n - meanA * meanA;
    const varB = sumB2 / n - meanB * meanB;
    const r = cov / Math.sqrt(varA * varB);
    console.log(`  prominence value agreement: n=${n}  max|diff|=${maxDiff.toExponential(3)}uS  mean|diff|=${(sumAbs / n).toExponential(3)}uS  RMSE=${Math.sqrt(sumSq / n).toExponential(3)}uS  r=${r.toFixed(6)}`);
  }
} else {
  console.error('Usage: node check_prominence_agreement.js dump <track.csv> <out.json>');
  console.error('       node check_prominence_agreement.js compare <out.json> <nk_result.json> [track.csv]');
  process.exit(1);
}
