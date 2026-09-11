/**
 * Detector-comparison benchmark: our GSRAnalyzer peak detectors (Full-Scan,
 * Prominence, cvxEDA) vs NeuroKit2, across a set of tracks. Reads the
 * NeuroKit2 JSON produced by run_neurokit.py and reports per-track and
 * aggregate agreement (matched/missed/extra, timing offset).
 *
 * Each detector is matched against the NeuroKit2 reference from the same
 * decomposition family (see DETECTORS below) - Full-Scan/Prominence against
 * NeuroKit2's default highpass-filter decomposition, cvxEDA against
 * NeuroKit2's own eda_phasic(method='cvxeda'). Comparing cvxEDA against the
 * default reference would confound "different decomposition algorithm" with
 * "different peak-picking rule".
 *
 * This is a reference-comparison tool, not a pass/fail regression test:
 * NeuroKit2 and our detectors use different peak-picking rules by design
 * (see project notes on the Prominence/Full-Scan/cvxEDA detectors), so the
 * useful signal is whether agreement holds steady across runs, not a fixed
 * target number.
 *
 * Usage (normally via run.sh, not directly):
 *   node compare.js <neurokit.json> <track1.csv> [track2.csv ...]
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
loadModule(path.join(SRC, 'deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(SRC, 'csv_parser.js'),    'GSRCSVParser');
loadModule(path.join(SRC, 'analyzer.js'),      'GSRAnalyzer');
const { GSRAnalyzer } = global;
const D = global.GSR_CONST.GSR_DEFAULT;

const TOL = 1.0; // seconds - a peak within this window of a NeuroKit2 peak counts as a match

// Each of our detectors is checked against the NeuroKit2 reference that
// shares its decomposition family, not just NeuroKit2's default output:
// Full-Scan/Prominence both decompose with a plain LPF tonic estimate, the
// same family as NeuroKit2's default highpass method (`peak_times`); our
// cvxEDA detector uses sparse convex-optimisation deconvolution, so it is
// checked against NeuroKit2's own eda_phasic(method='cvxeda') peaks
// (`cvxeda_peak_times`) instead - otherwise "cvxEDA" would silently be
// scored against a differently-decomposed signal.
const DETECTORS = [
  ['Full-Scan',  {},                        'peak_times'],
  ['Prominence', { usePeakProminence: true }, 'peak_times'],
  ['cvxEDA',     { useCvxEDA: true },       'cvxeda_peak_times'],
];

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
    if (best !== -1 && bestD <= TOL) {
      usedNk[best] = true;
      matches.push({ ourTime: t, nkTime: nkTimes[best], delta: t - nkTimes[best] });
    }
  });
  const matchedOurTimes = new Set(matches.map(m => m.ourTime));
  return {
    matches,
    missed: nkTimes.filter((_, ni) => !usedNk[ni]),
    extra: oursTimes.filter(t => !matchedOurTimes.has(t)),
  };
}

const [, , jsonPath, ...trackPaths] = process.argv;
if (!jsonPath || trackPaths.length === 0) {
  console.error('Usage: node compare.js <neurokit.json> <track1.csv> [track2.csv ...]');
  process.exit(1);
}
const nkData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const aggregate = {};
DETECTORS.forEach(([label]) => { aggregate[label] = { matched: 0, nkTotal: 0, extra: 0, deltas: [] }; });

for (const trackPath of trackPaths) {
  const name = path.basename(trackPath, '.csv');
  const nk = nkData[name];
  if (!nk) { console.warn(`\n(no NeuroKit2 data for ${name}, skipping)`); continue; }

  const csvText = fs.readFileSync(trackPath, 'utf8');
  console.log(`\n=== ${name}  (${nk.n_samples} samples @ ${nk.sampling_rate.toFixed(2)}Hz | NeuroKit2 default: ${nk.peak_times.length} peaks, NeuroKit2 cvxEDA: ${nk.cvxeda_peak_times.length} peaks) ===`);

  for (const [label, patch, refField] of DETECTORS) {
    const nkTimes = nk[refField];
    const a = new GSRAnalyzer();
    a.parseCSV(csvText);
    a.analyze({ ...D, ...patch }, 0);
    const oursTimes = a.peaks.map(p => p.time);
    const r = matchPeaks(oursTimes, nkTimes);
    const meanAbsDelta = r.matches.length
      ? r.matches.reduce((s, m) => s + Math.abs(m.delta), 0) / r.matches.length
      : NaN;

    if (nkTimes.length === 0) {
      console.log(`  ${label.padEnd(10)} ${String(oursTimes.length).padStart(3)} peaks | (no NeuroKit2 ${refField} reference available)`);
      continue;
    }
    console.log(`  ${label.padEnd(10)} ${String(oursTimes.length).padStart(3)} peaks | vs ${refField.padEnd(17)} | matched ${String(r.matches.length).padStart(2)}/${nkTimes.length} | missed ${r.missed.length} | extra ${r.extra.length} | mean|delta| ${Number.isNaN(meanAbsDelta) ? 'n/a' : meanAbsDelta.toFixed(3) + 's'}`);

    const agg = aggregate[label];
    agg.matched += r.matches.length;
    agg.nkTotal += nkTimes.length;
    agg.extra += r.extra.length;
    agg.deltas.push(...r.matches.map(m => Math.abs(m.delta)));
  }
}

console.log('\n=== Aggregate across all tracks ===');
for (const [label, , refField] of DETECTORS) {
  const agg = aggregate[label];
  const recall = agg.nkTotal ? (100 * agg.matched / agg.nkTotal).toFixed(1) : 'n/a';
  const meanDelta = agg.deltas.length
    ? (agg.deltas.reduce((s, d) => s + d, 0) / agg.deltas.length).toFixed(3)
    : 'n/a';
  console.log(`  ${label.padEnd(10)} vs ${refField.padEnd(17)} recall ${recall}% (${agg.matched}/${agg.nkTotal})  extra total ${agg.extra}  mean|delta| ${meanDelta}s`);
}
