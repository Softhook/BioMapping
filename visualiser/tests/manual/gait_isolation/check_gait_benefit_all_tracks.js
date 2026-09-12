/**
 * Corpus-wide test of the gait filter's actual STATED GOAL: does it reduce
 * the speed-correlated ~1.4-2.0Hz walking-footstep band power in the phasic
 * signal, relative to the box average? check_gait_isolation.js established
 * this mechanism in depth on biomap_059 alone (continuous sliding-window
 * band-power vs GPS-speed correlation, r=0.248 there). This runs the same
 * measurement (band share correlated with GPS speed, medium-vs-brisk pace
 * gap) across every real track with usable GPS speed data, to see whether
 * the intended benefit - not just "does it cost less than feared" - holds
 * up beyond the one track it was validated on.
 *
 * Usage: node check_gait_benefit_all_tracks.js
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

function parseSpeed(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
  if (lines.length < 2) return null;
  const header = lines[0].split(',');
  const iSpeed = header.indexOf('speed_kts');
  if (iSpeed < 0) return null;
  const speeds = new Array(lines.length - 1).fill(null);
  for (let i = 1; i < lines.length; i++) {
    const v = parseFloat(lines[i].split(',')[iSpeed]);
    speeds[i - 1] = isNaN(v) ? null : v * 0.514444;
  }
  return speeds;
}

// Detrend (subtract a 2s moving average) + Hann window a segment, returning
// the gait-band power fraction relative to the segment's own total power -
// identical method to check_gait_isolation.js.
function bandShareOfSegment(vals, sampleRate, gaitFreqs, totalFreqs) {
  const n = vals.length;
  const trendWin = Math.round(2.0 * sampleRate);
  const half = Math.floor(trendWin / 2);
  const detrended = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += vals[j];
    detrended[i] = vals[i] - s / (hi - lo + 1);
  }
  const win = new Array(n);
  let winEnergy = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    win[i] = detrended[i] * h;
    winEnergy += h * h;
  }
  const power = (freqs) => {
    let total = 0;
    for (const f of freqs) {
      let re = 0, im = 0;
      const w = 2 * Math.PI * f / sampleRate;
      for (let i = 0; i < n; i++) { re += win[i] * Math.cos(w * i); im -= win[i] * Math.sin(w * i); }
      total += (re * re + im * im) / winEnergy;
    }
    return total;
  };
  return power(gaitFreqs) / power(totalFreqs);
}

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? cov / denom : NaN;
}

const GAIT_FREQS = [1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0];
const TOTAL_FREQS = [];
for (let f = 0.2; f <= 4.0; f += 0.1) TOTAL_FREQS.push(Math.round(f * 10) / 10);
const WINDOW_SEC = 8, STEP_SEC = 4;

function slidingSpeedCorrelation(phasicVals, speeds, sampleRate) {
  const windowSamples = Math.round(WINDOW_SEC * sampleRate);
  const stepSamples = Math.round(STEP_SEC * sampleRate);
  const speedSamples = [], shareSamples = [];
  for (let start = 0; start + windowSamples <= phasicVals.length; start += stepSamples) {
    const speedSeg = speeds.slice(start, start + windowSamples).filter(s => s != null);
    if (speedSeg.length < windowSamples * 0.8) continue;
    const meanSpeed = speedSeg.reduce((s, v) => s + v, 0) / speedSeg.length;
    const share = bandShareOfSegment(phasicVals.slice(start, start + windowSamples), sampleRate, GAIT_FREQS, TOTAL_FREQS);
    speedSamples.push(meanSpeed);
    shareSamples.push(share);
  }
  const r = pearson(speedSamples, shareSamples);
  const medium = shareSamples.filter((_, i) => speedSamples[i] >= 0.5 && speedSamples[i] < 1.0);
  const brisk = shareSamples.filter((_, i) => speedSamples[i] >= 1.0 && speedSamples[i] < 1.5);
  const mediumMean = medium.length ? medium.reduce((a, b) => a + b, 0) / medium.length : NaN;
  const briskMean = brisk.length ? brisk.reduce((a, b) => a + b, 0) / brisk.length : NaN;
  return { r, mediumMean, briskMean, n: speedSamples.length, nMedium: medium.length, nBrisk: brisk.length };
}

function runPhasic(csvText, patch) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D, medianSize: 0, ...patch }, 0);
  return { phasicVals: a.phasic.map(d => d.val), sampleRate: a.sampleRate };
}

const NONE = { lpfWindow: 0, useGaitFilter: false };  // raw phasic, no stage-2 smoothing at all
const GAIT_ON = { lpfWindow: 0, useGaitFilter: true };
const BOX_05 = { lpfWindow: 0.5, useGaitFilter: false };

const files = fs.readdirSync(TRACKS_DIR)
  .filter(f => /^biomap_\d+\.csv$/.test(f))
  .sort();

console.log(`=== gait-band (1.4-2.0Hz) speed-correlation: raw vs box 0.5s vs gait filter, across ${files.length} real tracks ===\n`);
console.log(
  'track'.padEnd(18) + 'nWin'.padStart(6) +
  'r(raw)'.padStart(9) + 'r(box)'.padStart(9) + 'r(gait)'.padStart(9) +
  'brisk%(raw)'.padStart(13) + 'brisk%(box)'.padStart(13) + 'brisk%(gait)'.padStart(14)
);

const rows = [];
for (const file of files) {
  const csvPath = path.join(TRACKS_DIR, file);
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const speeds = parseSpeed(csvPath);
  if (!speeds) continue;
  let noneRes, gaitRes, boxRes;
  try {
    const noneP = runPhasic(csvText, NONE);
    const gaitP = runPhasic(csvText, GAIT_ON);
    const boxP = runPhasic(csvText, BOX_05);
    noneRes = slidingSpeedCorrelation(noneP.phasicVals, speeds, noneP.sampleRate);
    gaitRes = slidingSpeedCorrelation(gaitP.phasicVals, speeds, gaitP.sampleRate);
    boxRes = slidingSpeedCorrelation(boxP.phasicVals, speeds, boxP.sampleRate);
  } catch (e) {
    continue;
  }
  // Need enough windows, and some real speed spread, for the correlation to
  // mean anything - skip tracks that are all-stationary or too short.
  if (noneRes.n < 15 || isNaN(noneRes.r) || isNaN(gaitRes.r) || isNaN(boxRes.r)) continue;
  rows.push({ file, noneRes, gaitRes, boxRes });
  console.log(
    file.padEnd(18) + String(noneRes.n).padStart(6) +
    noneRes.r.toFixed(3).padStart(9) + boxRes.r.toFixed(3).padStart(9) + gaitRes.r.toFixed(3).padStart(9) +
    (100 * noneRes.briskMean).toFixed(1).padStart(13) +
    (100 * boxRes.briskMean).toFixed(1).padStart(13) +
    (100 * gaitRes.briskMean).toFixed(1).padStart(14)
  );
}

const meanAbsR = (side) => rows.reduce((s, r) => s + Math.abs(r[side].r), 0) / rows.length;
const meanBrisk = (side) => rows.reduce((s, r) => s + r[side].briskMean, 0) / rows.length * 100;
const improvedVsNone = (side) => rows.filter(r => Math.abs(r[side].r) < Math.abs(r.noneRes.r)).length;
const briskReducedVsNone = (side) => rows.filter(r => r[side].briskMean < r.noneRes.briskMean).length;

console.log(`\n=== Summary (${rows.length} tracks with usable speed variation) ===`);
console.log(`mean |r| (speed vs gait-band power):     raw=${meanAbsR('noneRes').toFixed(3)}   box=${meanAbsR('boxRes').toFixed(3)}   gait=${meanAbsR('gaitRes').toFixed(3)}`);
console.log(`mean brisk-pace gait-band share:          raw=${meanBrisk('noneRes').toFixed(1)}%   box=${meanBrisk('boxRes').toFixed(1)}%   gait=${meanBrisk('gaitRes').toFixed(1)}%`);
console.log(`tracks where box reduces brisk-pace band share vs raw:  ${briskReducedVsNone('boxRes')}/${rows.length}`);
console.log(`tracks where gait filter reduces brisk-pace band share vs raw: ${briskReducedVsNone('gaitRes')}/${rows.length}`);
console.log(`tracks where gait filter's brisk-pace band share is lower than box's: ${rows.filter(r => r.gaitRes.briskMean < r.boxRes.briskMean).length}/${rows.length}`);
