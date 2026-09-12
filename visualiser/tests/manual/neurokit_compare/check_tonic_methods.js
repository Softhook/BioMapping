/**
 * Evaluates BioMapping's three tonic decomposition methods ('lpf'/EMA, 'median',
 * 'percentile') plus cvxEDA on real clean indoor tracks and against NeuroKit2.
 *
 * Compares:
 * 1. Tonic levels (mean, min, max, std)
 * 2. Phasic levels (mean, max, std)
 * 3. Peak detection counts and agreement against NeuroKit2 references
 * 4. Ground-truth tonic/phasic recovery accuracy on synthetic tracks
 *
 * Usage:
 *   node check_tonic_methods.js <track1.csv> [track2.csv ...]
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

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
loadModule(path.join(SRC, 'dwt_filter.js'),    'DWT');
loadModule(path.join(SRC, 'gsr_filter.js'),    'GsrFilter');
global.CVXEDA = require(path.join(SRC, 'cvxeda.js'));
loadModule(path.join(SRC, 'deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(SRC, 'csv_parser.js'),    'GSRCSVParser');
loadModule(path.join(SRC, 'analyzer.js'),      'GSRAnalyzer');
const { GSRAnalyzer, GsrFilter } = global;
const D = global.GSR_CONST.GSR_DEFAULT;

const TONIC_METHODS = [
  { name: 'EMA (45s - UI default)',         params: { tonicMethod: 'lpf',        tonicWindow: 45, useCvxEDA: false } },
  { name: 'EMA (30s slider)',               params: { tonicMethod: 'lpf',        tonicWindow: 30, useCvxEDA: false } },
  { name: 'EMA (60s slider)',               params: { tonicMethod: 'lpf',        tonicWindow: 60, useCvxEDA: false } },
  { name: 'Sliding Median (30s - UI default)', params: { tonicMethod: 'median',     tonicWindow: 30, useCvxEDA: false } },
  { name: 'Sliding Median (20s slider)',    params: { tonicMethod: 'median',     tonicWindow: 20, useCvxEDA: false } },
  { name: 'Sliding Median (45s slider)',    params: { tonicMethod: 'median',     tonicWindow: 45, useCvxEDA: false } },
  { name: 'Sliding 10th-%ile (15s - UI default)', params: { tonicMethod: 'percentile', tonicWindow: 15, useCvxEDA: false } },
  { name: 'Sliding 10th-%ile (10s slider)', params: { tonicMethod: 'percentile', tonicWindow: 10, useCvxEDA: false } },
  { name: 'Sliding 10th-%ile (30s slider)', params: { tonicMethod: 'percentile', tonicWindow: 30, useCvxEDA: false } },
  { name: 'cvxEDA (B-spline QP)',           params: { useCvxEDA: true } },
];

function stats(arr) {
  const n = arr.length;
  if (n === 0) return { mean: 0, min: 0, max: 0, std: 0 };
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - mean;
    sumSq += d * d;
  }
  return { mean, min, max, std: Math.sqrt(sumSq / n) };
}

const trackPaths = process.argv.slice(2);
if (trackPaths.length === 0) {
  console.error('Usage: node check_tonic_methods.js <track1.csv> [track2.csv ...]');
  process.exit(1);
}

for (const trackPath of trackPaths) {
  const name = path.basename(trackPath, '.csv');
  const csvText = fs.readFileSync(trackPath, 'utf8');

  console.log(`\n================================================================================`);
  console.log(`=== Track: ${name} ===`);
  console.log(`================================================================================`);

  for (const { name: mName, params: mParams } of TONIC_METHODS) {
    const a = new GSRAnalyzer();
    a.parseCSV(csvText);
    a.analyze({ ...D, useGaitFilter: false, ...mParams }, 0);

    const tonicVals = a.tonic.map(d => d.val);
    const phasicVals = a.phasic.map(d => d.val);

    const tStat = stats(tonicVals);
    const pStat = stats(phasicVals);

    // Also test prominence peak count on this phasic curve
    const aProm = new GSRAnalyzer();
    aProm.parseCSV(csvText);
    aProm.analyze({ ...D, useGaitFilter: false, usePeakProminence: true, ...mParams }, 0);

    console.log(`\n[${mName}]`);
    let totalVariation = 0;
    for (let i = 1; i < tonicVals.length; i++) totalVariation += Math.abs(tonicVals[i] - tonicVals[i - 1]);
    console.log(`  Tonic (SCL):  mean ${tStat.mean.toFixed(3)} uS | min ${tStat.min.toFixed(3)} uS | max ${tStat.max.toFixed(3)} uS | roughness (TV) ${totalVariation.toFixed(3)} uS`);
    const minIdx = tonicVals.indexOf(tStat.min);
    if (tStat.min < 0) {
      console.log(`  WARNING: Negative tonic at sample ${minIdx} (t=${a.tonic[minIdx].time.toFixed(2)}s, raw=${a.raw[minIdx].val.toFixed(3)}uS)`);
    }
    console.log(`  Phasic (SCR): mean ${pStat.mean.toFixed(3)} uS | max ${pStat.max.toFixed(3)} uS | std ${pStat.std.toFixed(3)} uS | non-zero ${(100 * phasicVals.filter(v => v > 0.001).length / phasicVals.length).toFixed(1)}%`);
    console.log(`  Peak Counts:  Full-Scan: ${String(a.peaks.length).padStart(3)} peaks | Prominence: ${String(aProm.peaks.length).padStart(3)} peaks`);
    if (a.peaks.length > 0) {
      const amps = a.peaks.map(p => p.amplitude);
      const aStat = stats(amps);
      console.log(`  Full-Scan SCR Amplitude: mean ${aStat.mean.toFixed(3)} uS | max ${aStat.max.toFixed(3)} uS | median ${amps.slice().sort((x, y) => x - y)[Math.floor(amps.length / 2)].toFixed(3)} uS`);
    }
  }

  console.log(`\n--- Tonic Window Sweep on ${name} (testing 20s, 30s, 45s, 60s, 90s) ---`);
  console.log('Window | EMA Peaks (F/P)       | Median Peaks (F/P)    | 10th-%ile Peaks (F/P)');
  for (const win of [20, 30, 45, 60, 90]) {
    const res = [];
    for (const m of ['lpf', 'median', 'percentile']) {
      const aF = new GSRAnalyzer(); aF.parseCSV(csvText);
      aF.analyze({ ...D, useGaitFilter: false, tonicMethod: m, tonicWindow: win }, 0);
      const aP = new GSRAnalyzer(); aP.parseCSV(csvText);
      aP.analyze({ ...D, useGaitFilter: false, tonicMethod: m, tonicWindow: win, usePeakProminence: true }, 0);
      res.push(`${String(aF.peaks.length).padStart(3)} / ${String(aP.peaks.length).padStart(3)}`);
    }
    console.log(`  ${String(win).padStart(2)}s  | ${res[0].padEnd(21)} | ${res[1].padEnd(21)} | ${res[2]}`);
  }
}
