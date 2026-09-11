/**
 * Onset-detection algorithm check, isolated the same way prominence was
 * (check_prominence_agreement.js): same phasic curve, same set of candidate
 * points, compare only the ONE piece of logic in question.
 *
 * Ours: _findOnsetIndex(vals, i, maxOnsetSteps, minDip=0) - the Full-Scan
 * detector's onset walk, minDip=0 mode ("stop at the first preceding local
 * minimum, however shallow", bounded to MAX_RISE_TIME=5s and to vals>0).
 * NeuroKit2: signal_findpeaks()'s "Onsets" field - for every candidate peak,
 * the CLOSEST strictly-smaller-index trough from scipy.signal.find_peaks(
 * -signal) run once over the whole curve (unbounded search distance, no
 * floor cutoff). Both describe the same everyday concept ("where did this
 * response start rising from") via different mechanisms, so this checks
 * whether they actually agree in practice, not just in wording.
 *
 * Usage (normally via check_onset_agreement.sh, not directly):
 *   node check_onset_agreement.js dump <track.csv> <out.json>
 *   node check_onset_agreement.js compare <out.json> <nk_result.json> [track.csv]
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
const GSR_CONST = global.GSR_CONST;

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
  const sr = a.sampleRate;
  const maxOnsetSteps = Math.round(GSR_CONST.PEAK_SHAPE.MAX_RISE_TIME * sr);

  // Same local-maximum definition the prominence check and both real
  // detectors use.
  const results = [];
  for (let i = 1; i < vals.length - 1; i++) {
    if (vals[i] > vals[i - 1] && vals[i] >= vals[i + 1]) {
      const onsetIdx = a._findOnsetIndex(vals, i, maxOnsetSteps, 0);
      results.push({ peakIndex: i, peakTime: times[i], onsetIndex: onsetIdx, onsetTime: times[onsetIdx] });
    }
  }

  fs.writeFileSync(outPath, JSON.stringify({
    sampling_rate: sr,
    max_onset_steps: maxOnsetSteps,
    phasic: vals,
    times,
    ours: results,
  }));
  console.error(`Dumped ${vals.length} phasic samples, ${results.length} onset queries -> ${outPath}`);
} else if (mode === 'compare') {
  const oursPath = process.argv[3];
  const nkPath = process.argv[4];
  const ours = JSON.parse(fs.readFileSync(oursPath, 'utf8'));
  const nk = JSON.parse(fs.readFileSync(nkPath, 'utf8'));
  const nkOnsetByPeak = new Map();
  for (let i = 0; i < nk.peak_index.length; i++) nkOnsetByPeak.set(nk.peak_index[i], nk.onset_index[i]);

  const name = path.basename(process.argv[5] || '', '.csv');
  console.log(`=== ${name}: onset-detection agreement (same phasic curve, minDip=0 vs NeuroKit2 nearest-trough) ===`);

  let exact = 0, within1s = 0, total = 0, noNkTrough = 0, capped = 0;
  let sumAbsTimeDiff = 0, maxAbsTimeDiff = 0, diffCount = 0;
  for (const r of ours.ours) {
    if (!nkOnsetByPeak.has(r.peakIndex)) continue;
    total++;
    const nkOnsetIdx = nkOnsetByPeak.get(r.peakIndex);
    if (nkOnsetIdx === r.onsetIndex) { exact++; within1s++; continue; }
    if (nkOnsetIdx < 0) { noNkTrough++; continue; } // no smaller-index trough exists at all (peak near recording start) - not a disagreement, nothing to compare against
    const dt = Math.abs(ours.times[r.onsetIndex] - ours.times[nkOnsetIdx]);
    sumAbsTimeDiff += dt; diffCount++;
    maxAbsTimeDiff = Math.max(maxAbsTimeDiff, dt);
    if (dt <= 1.0) within1s++;
    if (r.peakIndex - r.onsetIndex >= ours.max_onset_steps - 1) capped++;
  }

  console.log(`  candidates compared: ${total}`);
  console.log(`  exact index match: ${exact}/${total} (${(100 * exact / total).toFixed(1)}%)`);
  console.log(`  within 1.0s: ${within1s}/${total} (${(100 * within1s / total).toFixed(1)}%)`);
  console.log(`  mean|onset time diff| (real mismatches only): ${diffCount ? (sumAbsTimeDiff / diffCount).toFixed(4) : 0}s  max: ${maxAbsTimeDiff.toFixed(4)}s`);
  if (noNkTrough > 0) console.log(`  no comparison possible (no smaller-index trough exists - peak near recording start): ${noNkTrough}`);
  if (capped > 0) console.log(`  mismatches where our walk hit the MAX_RISE_TIME cap (${(ours.max_onset_steps / ours.sampling_rate).toFixed(1)}s): ${capped}`);
} else {
  console.error('Usage: node check_onset_agreement.js dump <track.csv> <out.json>');
  console.error('       node check_onset_agreement.js compare <out.json> <nk_result.json> [track.csv]');
  process.exit(1);
}
