/**
 * Prominence detector, gated NeuroKit2's way: does matching the ACTUAL
 * threshold convention (relative_height_min=0.1 * the largest prominence in
 * that specific recording - see eda_decomposition_analysis.md's "Precedent"
 * section and check_prominence_agreement.js) close the "extra peaks" gap
 * that run.sh/compare.js shows under BioMapping's production peakThreshold
 * (a fixed absolute 0.015uS)?
 *
 * An earlier pass in this investigation swept peakThreshold=0.1 as if
 * NeuroKit2's amplitude_min were an absolute uS floor - that was comparing
 * the wrong kind of number (NeuroKit2's gate is relative-to-track-max, not
 * absolute). This redoes it properly: per track, find our own max
 * topographic prominence (now exact vs NeuroKit2's, see
 * check_prominence_agreement.sh), gate our Prominence detector at 10% of
 * THAT, and compare against NeuroKit2's real peak set the same way
 * compare.js does for the fixed-threshold runs.
 *
 * Usage (normally via check_relative_threshold.sh, not directly):
 *   node check_relative_threshold.js <neurokit.json> <track1.csv> [track2.csv ...]
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

const RELATIVE_FRACTION = 0.1; // NeuroKit2's amplitude_min default
const TOL = 1.0; // seconds, same match window compare.js uses

function matchPeaks(oursTimes, nkTimes) {
  const usedNk = new Array(nkTimes.length).fill(false);
  const matches = [];
  oursTimes.forEach((t) => {
    let best = -1, bestD = Infinity;
    nkTimes.forEach((nt, ni) => {
      if (usedNk[ni]) return;
      const d = Math.abs(nt - t);
      if (d < bestD) { bestD = d; best = ni; }
    });
    if (best !== -1 && bestD <= TOL) { usedNk[best] = true; matches.push(Math.abs(t - nkTimes[best])); }
  });
  return {
    matched: matches.length,
    missed: nkTimes.length - matches.length,
    extra: oursTimes.length - matches.length,
    deltas: matches,
  };
}

const [, , jsonPath, ...trackPaths] = process.argv;
if (!jsonPath || trackPaths.length === 0) {
  console.error('Usage: node check_relative_threshold.js <neurokit.json> <track1.csv> [track2.csv ...]');
  process.exit(1);
}
const nkData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const aggAbs = { matched: 0, nkTotal: 0, extra: 0, deltas: [] };
const aggRel = { matched: 0, nkTotal: 0, extra: 0, deltas: [] };

for (const trackPath of trackPaths) {
  const name = path.basename(trackPath, '.csv');
  const nk = nkData[name];
  if (!nk) { console.warn(`(no NeuroKit2 data for ${name}, skipping)`); continue; }
  const csvText = fs.readFileSync(trackPath, 'utf8');

  // Pass 1: default absolute threshold (production config, for comparison).
  const aAbs = new GSRAnalyzer();
  aAbs.parseCSV(csvText);
  aAbs.analyze({ ...D, usePeakProminence: true }, 0);
  const absTimes = aAbs.peaks.map(p => p.time);
  const rAbs = matchPeaks(absTimes, nk.peak_times);

  // Pass 2: find this track's own max topographic prominence (same curve,
  // default LPF decomposition), gate at 10% of it - NeuroKit2's real rule.
  const vals = aAbs.phasic.map(d => d.val);
  const prom = aAbs._topographicProminence(vals);
  let maxProm = 0;
  for (let i = 1; i < vals.length - 1; i++) {
    if (vals[i] > vals[i - 1] && vals[i] >= vals[i + 1] && prom[i] > maxProm) maxProm = prom[i];
  }
  const relativeThreshold = RELATIVE_FRACTION * maxProm;

  const aRel = new GSRAnalyzer();
  aRel.parseCSV(csvText);
  aRel.analyze({ ...D, usePeakProminence: true, peakThreshold: relativeThreshold }, 0);
  const relTimes = aRel.peaks.map(p => p.time);
  const rRel = matchPeaks(relTimes, nk.peak_times);

  console.log(`=== ${name} (NeuroKit2: ${nk.peak_times.length} peaks | our max prominence: ${maxProm.toFixed(4)}uS -> relative threshold ${relativeThreshold.toFixed(4)}uS vs production ${D.peakThreshold}uS) ===`);
  console.log(`  absolute (production, ${D.peakThreshold}uS): ${absTimes.length} peaks | matched ${rAbs.matched}/${nk.peak_times.length} | missed ${rAbs.missed} | extra ${rAbs.extra}`);
  console.log(`  relative (NeuroKit2's own rule, ${relativeThreshold.toFixed(4)}uS): ${relTimes.length} peaks | matched ${rRel.matched}/${nk.peak_times.length} | missed ${rRel.missed} | extra ${rRel.extra}`);

  aggAbs.matched += rAbs.matched; aggAbs.nkTotal += nk.peak_times.length; aggAbs.extra += rAbs.extra; aggAbs.deltas.push(...rAbs.deltas);
  aggRel.matched += rRel.matched; aggRel.nkTotal += nk.peak_times.length; aggRel.extra += rRel.extra; aggRel.deltas.push(...rRel.deltas);
}

function summarize(label, agg) {
  const recall = agg.nkTotal ? (100 * agg.matched / agg.nkTotal).toFixed(1) : 'n/a';
  const meanDelta = agg.deltas.length ? (agg.deltas.reduce((s, d) => s + d, 0) / agg.deltas.length).toFixed(3) : 'n/a';
  console.log(`  ${label.padEnd(45)} recall ${recall}% (${agg.matched}/${agg.nkTotal})  extra total ${agg.extra}  mean|delta| ${meanDelta}s`);
}
console.log('\n=== Aggregate across all tracks ===');
summarize(`absolute threshold (production, ${D.peakThreshold}uS)`, aggAbs);
summarize(`relative threshold (NeuroKit2's rule, 10% of track max)`, aggRel);
