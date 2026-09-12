/**
 * Recovery-time (half-decay) algorithm check, isolated the same way
 * prominence/onset were: same phasic curve, same peaks/onsets/amplitudes fed
 * to both sides, so any disagreement is purely about the recovery-finding
 * LOGIC, not upstream detection differences (onset agreement was already
 * checked in check_onset_agreement.*, ~99.5-100% exact).
 *
 * Ours: _findRecoveryIndex(vals, i, onsetIdx, amplitude) - scan FORWARD from
 * the peak, return the first sample at or below the half-decay value; give
 * up (-1) if the signal starts rising again well above that value first
 * (PEAK_RECOVERY_BREAK guard - a new response intervened before recovery).
 * NeuroKit2: eda_peaks._eda_peaks_getfeatures() - segment the phasic curve
 * from this peak to the NEXT peak, truncate at the segment's own minimum
 * (to avoid matching into the next response's rise), then find the segment
 * VALUE closest to (but not above) the half-decay target - not necessarily
 * the first crossing.
 *
 * Usage (normally via check_recovery_agreement.sh, not directly):
 *   node check_recovery_agreement.js dump <track.csv> <out.json>
 *   node check_recovery_agreement.js compare <out.json> <nk_result.json> [track.csv]
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
const useGaitFilter = process.env.BIOMAP_USE_GAIT_FILTER === '1';
const D = { ...global.GSR_CONST.GSR_DEFAULT, useGaitFilter };
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

  const results = [];
  for (let i = 1; i < vals.length - 1; i++) {
    if (vals[i] > vals[i - 1] && vals[i] >= vals[i + 1]) {
      const onsetIdx = a._findOnsetIndex(vals, i, maxOnsetSteps, 0);
      const amplitude = vals[i] - vals[onsetIdx];
      const recoveryIdx = a._findRecoveryIndex(vals, i, onsetIdx, amplitude);
      results.push({ peakIndex: i, onsetIndex: onsetIdx, amplitude, recoveryIndex: recoveryIdx });
    }
  }

  fs.writeFileSync(outPath, JSON.stringify({
    sampling_rate: sr,
    phasic: vals,
    times,
    ours: results,
  }));
  console.error(`Dumped ${vals.length} phasic samples, ${results.length} recovery queries -> ${outPath}`);
} else if (mode === 'compare') {
  const oursPath = process.argv[3];
  const nkPath = process.argv[4];
  const ours = JSON.parse(fs.readFileSync(oursPath, 'utf8'));
  const nk = JSON.parse(fs.readFileSync(nkPath, 'utf8'));
  const nkByPeak = new Map();
  for (let i = 0; i < nk.peak_index.length; i++) nkByPeak.set(nk.peak_index[i], nk.recovery_index[i]);

  const name = path.basename(process.argv[5] || '', '.csv');
  console.log(`=== ${name}: recovery-time agreement (same phasic/onset/amplitude, ours=first-crossing vs NeuroKit2=closest-value) ===`);

  let bothFound = 0, bothNotFound = 0, exact = 0, within1s = 0;
  let oursFoundNkNot = 0, nkFoundOursNot = 0;
  let sumAbsTimeDiff = 0, maxAbsTimeDiff = 0, diffCount = 0;
  let total = 0;
  for (const r of ours.ours) {
    if (!nkByPeak.has(r.peakIndex)) continue;
    total++;
    const nkIdx = nkByPeak.get(r.peakIndex);
    const oursFound = r.recoveryIndex !== -1;
    const nkFound = nkIdx !== -1;
    if (!oursFound && !nkFound) { bothNotFound++; continue; }
    if (oursFound && !nkFound) { oursFoundNkNot++; continue; }
    if (!oursFound && nkFound) { nkFoundOursNot++; continue; }
    bothFound++;
    if (r.recoveryIndex === nkIdx) { exact++; within1s++; continue; }
    const dt = Math.abs(ours.times[r.recoveryIndex] - ours.times[nkIdx]);
    sumAbsTimeDiff += dt; diffCount++;
    maxAbsTimeDiff = Math.max(maxAbsTimeDiff, dt);
    if (dt <= 1.0) within1s++;
  }

  console.log(`  candidates compared: ${total}`);
  console.log(`  both found no recovery (agree): ${bothNotFound}`);
  console.log(`  both found a recovery point: ${bothFound}  (exact index match: ${exact}, within 1.0s: ${within1s})`);
  console.log(`  mean|time diff| where both found but differ: ${diffCount ? (sumAbsTimeDiff / diffCount).toFixed(4) : 0}s  max: ${maxAbsTimeDiff.toFixed(4)}s`);
  console.log(`  ours found a recovery, NeuroKit2 did not: ${oursFoundNkNot}`);
  console.log(`  NeuroKit2 found a recovery, ours did not: ${nkFoundOursNot}`);
} else {
  console.error('Usage: node check_recovery_agreement.js dump <track.csv> <out.json>');
  console.error('       node check_recovery_agreement.js compare <out.json> <nk_result.json> [track.csv]');
  process.exit(1);
}
