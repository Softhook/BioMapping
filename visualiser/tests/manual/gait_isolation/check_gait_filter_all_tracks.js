/**
 * Corpus-wide A/B: shipped default (useGaitFilter:true, Butterworth 0.8Hz
 * order4) vs the prior default (box average, lpfWindow=0.5s) - same
 * comparison check_gait_isolation.js ran in depth on biomap_059 alone, run
 * here over every real track to see how the trade-off documented in
 * gsr_filter.js (great gait rejection / SCR-amplitude fidelity, but more
 * noise-driven false peaks on a track with little real walking) actually
 * lands across the corpus. Mean GPS speed per track is reported alongside
 * the peak-count delta so a walking-heavy vs mostly-stationary split can be
 * read directly off the table, without a synthetic ground truth.
 *
 * Usage: node check_gait_filter_all_tracks.js
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
const TRACKS_DIR = path.join(__dirname, '../../../../tracks');

function parseMeanSpeed(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
  const header = lines[0].split(',');
  const iSpeed = header.indexOf('speed_kts');
  if (iSpeed < 0) return null;
  let sum = 0, n = 0;
  for (let i = 1; i < lines.length; i++) {
    const v = parseFloat(lines[i].split(',')[iSpeed]);
    if (!isNaN(v)) { sum += v * 0.514444; n++; }
  }
  return n ? sum / n : null;
}

function runConfig(csvText, patch) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D, medianSize: 0, ...patch }, 0);
  const meanQuality = a.peaks.length ? a.peaks.reduce((s, p) => s + p.qualityScore, 0) / a.peaks.length : 0;
  const sumAmp = a.peaks.reduce((s, p) => s + p.amplitude, 0);
  return { peaks: a.peaks.length, meanQuality, sumAmp };
}

const GAIT_ON = { lpfWindow: 0, useGaitFilter: true };   // shipped default
const BOX_05  = { lpfWindow: 0.5, useGaitFilter: false }; // prior default

const files = fs.readdirSync(TRACKS_DIR)
  .filter(f => /^biomap_\d+\.csv$/.test(f))
  .sort();

console.log(`=== ${files.length} real tracks: useGaitFilter:true vs box 0.5s ===\n`);
console.log(
  'track'.padEnd(18) + 'meanSpeed'.padStart(10) + 'peaks(gait)'.padStart(13) + 'peaks(box)'.padStart(12) +
  'ratio'.padStart(8) + '  q(gait)'.padStart(10) + '  q(box)'.padStart(10) +
  'amp(gait)'.padStart(11) + 'amp(box)'.padStart(10)
);

const rows = [];
for (const file of files) {
  const csvPath = path.join(TRACKS_DIR, file);
  const csvText = fs.readFileSync(csvPath, 'utf8');
  let gait, box, meanSpeed;
  try {
    gait = runConfig(csvText, GAIT_ON);
    box = runConfig(csvText, BOX_05);
    meanSpeed = parseMeanSpeed(csvPath);
  } catch (e) {
    console.log(`${file.padEnd(18)}  ERROR: ${e.message}`);
    continue;
  }
  const ratio = box.peaks > 0 ? gait.peaks / box.peaks : (gait.peaks > 0 ? Infinity : 1);
  rows.push({ file, meanSpeed, gait, box, ratio });
  console.log(
    file.padEnd(18) +
    (meanSpeed == null ? 'n/a'.padStart(10) : meanSpeed.toFixed(2).padStart(10)) +
    String(gait.peaks).padStart(13) +
    String(box.peaks).padStart(12) +
    ratio.toFixed(2).padStart(8) +
    gait.meanQuality.toFixed(3).padStart(10) +
    box.meanQuality.toFixed(3).padStart(10) +
    gait.sumAmp.toFixed(1).padStart(11) +
    box.sumAmp.toFixed(1).padStart(10)
  );
}

const totalGait = rows.reduce((s, r) => s + r.gait.peaks, 0);
const totalBox = rows.reduce((s, r) => s + r.box.peaks, 0);
const meanRatio = rows.reduce((s, r) => s + (isFinite(r.ratio) ? r.ratio : 0), 0) / rows.length;
const medianRatio = rows.map(r => r.ratio).filter(isFinite).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
const meanQGait = rows.reduce((s, r) => s + r.gait.meanQuality, 0) / rows.length;
const meanQBox = rows.reduce((s, r) => s + r.box.meanQuality, 0) / rows.length;

console.log('\n=== Summary ===');
console.log(`total peaks:   gait=${totalGait}   box=${totalBox}   (${((totalGait / totalBox - 1) * 100).toFixed(1)}%)`);
console.log(`mean ratio (gait/box) per track: ${meanRatio.toFixed(2)}   median: ${medianRatio.toFixed(2)}`);
console.log(`mean quality:  gait=${meanQGait.toFixed(3)}   box=${meanQBox.toFixed(3)}`);

// Slowest-quartile vs fastest-quartile tracks by mean GPS speed - if the
// documented noise-driven false-peak cost dominates on low-walking tracks,
// the ratio should be visibly higher in the slow quartile.
const withSpeed = rows.filter(r => r.meanSpeed != null).sort((a, b) => a.meanSpeed - b.meanSpeed);
if (withSpeed.length >= 8) {
  const q = Math.floor(withSpeed.length / 4);
  const slow = withSpeed.slice(0, q);
  const fast = withSpeed.slice(-q);
  const avgRatio = (arr) => arr.reduce((s, r) => s + (isFinite(r.ratio) ? r.ratio : 0), 0) / arr.length;
  const avgSpeed = (arr) => arr.reduce((s, r) => s + r.meanSpeed, 0) / arr.length;
  console.log(`\nslowest quartile (n=${slow.length}, mean speed ${avgSpeed(slow).toFixed(2)} m/s): mean ratio ${avgRatio(slow).toFixed(2)}`);
  console.log(`fastest quartile (n=${fast.length}, mean speed ${avgSpeed(fast).toFixed(2)} m/s): mean ratio ${avgRatio(fast).toFixed(2)}`);
}

// Tracks where the gait filter increases peak count the most - candidates
// for "mostly stationary, filter mainly adding noise-driven peaks" rather
// than "real walking artefact correctly rejected".
const worst = [...rows].filter(r => isFinite(r.ratio)).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
console.log('\nLargest gait/box peak-count ratios (potential false-peak inflation):');
for (const r of worst) {
  console.log(`  ${r.file.padEnd(18)} ratio=${r.ratio.toFixed(2)}  meanSpeed=${r.meanSpeed == null ? 'n/a' : r.meanSpeed.toFixed(2)}  gaitPeaks=${r.gait.peaks}  boxPeaks=${r.box.peaks}`);
}

// Per-track average treats a 3-peak track the same as a 900-peak track,
// which can make a handful of noisy low-N tracks swing the headline number
// out of proportion to their actual weight in the corpus. Weighted mean
// (by peak count, box side) shows what the average PEAK actually looks
// like across the whole corpus instead.
const nonEmpty = rows.filter(r => r.box.peaks > 0 || r.gait.peaks > 0);
const weightedQ = (side) => {
  let num = 0, den = 0;
  for (const r of nonEmpty) { num += r[side].meanQuality * r[side].peaks; den += r[side].peaks; }
  return den ? num / den : 0;
};
console.log(`\nweighted mean quality (by peak count): gait=${weightedQ('gait').toFixed(3)}   box=${weightedQ('box').toFixed(3)}`);

// Quality delta vs track size - tests whether the drop concentrates in
// small/sparse tracks (static, or short) rather than being spread evenly.
const withDelta = nonEmpty.map(r => ({ ...r, qDelta: r.gait.meanQuality - r.box.meanQuality }));
const smallN = withDelta.filter(r => Math.min(r.gait.peaks, r.box.peaks) < 15);
const bigN = withDelta.filter(r => Math.min(r.gait.peaks, r.box.peaks) >= 15);
const avgDelta = (arr) => arr.length ? arr.reduce((s, r) => s + r.qDelta, 0) / arr.length : NaN;
console.log(`\nquality delta (gait-box), tracks with <15 peaks (n=${smallN.length}): mean ${avgDelta(smallN).toFixed(4)}`);
console.log(`quality delta (gait-box), tracks with >=15 peaks (n=${bigN.length}): mean ${avgDelta(bigN).toFixed(4)}`);

console.log('\nTracks where box quality beats gait quality by the most:');
const worstQ = [...withDelta].sort((a, b) => a.qDelta - b.qDelta).slice(0, 10);
for (const r of worstQ) {
  console.log(`  ${r.file.padEnd(18)} qDelta=${r.qDelta.toFixed(4)}  gaitPeaks=${r.gait.peaks}  boxPeaks=${r.box.peaks}  meanSpeed=${r.meanSpeed == null ? 'n/a' : r.meanSpeed.toFixed(2)}`);
}
