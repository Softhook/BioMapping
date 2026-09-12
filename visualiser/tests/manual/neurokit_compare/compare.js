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
const minGapOverride = Number.parseFloat(process.env.BIOMAP_PEAK_MIN_GAP);
if (Number.isFinite(minGapOverride) && minGapOverride > 0) {
  global.GSR_CONST.PEAK_MIN_GAP = minGapOverride;
}

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
// Plain require(), not loadModule(): cvxeda.js already exports via
// module.exports (see its own tail), and it must be set as global.CVXEDA
// BEFORE analyzer.js loads below - analyzer.js's cvxEDA branch is gated on
// `typeof CVXEDA !== 'undefined'`, and its own internal fallback (a require
// call of the same module, guarded by try/catch) silently no-ops here
// (vm.runInThisContext code has no `require` in scope, so that try/catch
// always falls through). Skipping this line means every "cvxEDA" run below
// silently degrades to matching-pursuit deconvolution instead - which is
// what happened here previously.
global.CVXEDA = require(path.join(SRC, 'cvxeda.js'));
loadModule(path.join(SRC, 'deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(SRC, 'csv_parser.js'),    'GSRCSVParser');
loadModule(path.join(SRC, 'analyzer.js'),      'GSRAnalyzer');
const { GSRAnalyzer } = global;
const D = global.GSR_CONST.GSR_DEFAULT;

const TOL = 1.0; // seconds - a peak within this window of a NeuroKit2 peak counts as a match
const thresholdOverride = Number.parseFloat(process.env.BIOMAP_PEAK_THRESHOLD);
const detectorThresholdPatch = Number.isFinite(thresholdOverride) && thresholdOverride >= 0
  ? { peakThreshold: thresholdOverride }
  : {};
const smallSlowAmplitude = Number.parseFloat(process.env.BIOMAP_SMALL_SLOW_AMPLITUDE);
const smallSlowSlope = Number.parseFloat(process.env.BIOMAP_SMALL_SLOW_SLOPE);
const useSmallSlowGate = Number.isFinite(smallSlowAmplitude) && smallSlowAmplitude > 0 &&
  Number.isFinite(smallSlowSlope) && smallSlowSlope > 0;

const gaitFilterOverride = process.env.BIOMAP_USE_GAIT_FILTER === '1';
const detectorDefaults = {
  ...D,
  useGaitFilter: gaitFilterOverride,
  ...detectorThresholdPatch,
};

// Each of our detectors is checked against the NeuroKit2 reference that
// shares its decomposition family, not just NeuroKit2's default output:
// Full-Scan/Prominence both decompose with a plain LPF tonic estimate, the
// same family as NeuroKit2's default highpass method (`peak_times`); our
// cvxEDA detector uses sparse convex-optimisation deconvolution, so it is
// checked against NeuroKit2's own eda_phasic(method='cvxeda') peaks
// (`cvxeda_peak_times`) instead - otherwise "cvxEDA" would silently be
// scored against a differently-decomposed signal.
// Each of our detectors is run once per track, then compared against
// corresponding reference signals from NeuroKit2, Ledalab, and the upstream
// cvxEDA reference solver.
const OUR_DETECTORS = [
  ['Full-Scan',      detectorThresholdPatch],
  ['Prominence',     { ...detectorThresholdPatch, usePeakProminence: true }],
  ['cvxEDA',         { ...detectorThresholdPatch, useCvxEDA: true }],
  ['Deconvolution',  { ...detectorThresholdPatch, useDeconvolution: true }],
];

const COMPARISONS = [
  // 1. BioMapping vs NeuroKit2
  { category: 'BioMapping vs NeuroKit2', source: 'Full-Scan',     refField: 'peak_times',                 refLabel: 'NeuroKit2 default' },
  { category: 'BioMapping vs NeuroKit2', source: 'Prominence',    refField: 'peak_times',                 refLabel: 'NeuroKit2 default' },
  { category: 'BioMapping vs NeuroKit2', source: 'cvxEDA',        refField: 'cvxeda_peak_times',          refLabel: 'NeuroKit2 cvxEDA' },
  { category: 'BioMapping vs NeuroKit2', source: 'cvxEDA',        refField: 'cvxeda_lit_peak_times',      refLabel: 'NeuroKit2 cvxEDA (lit. abs)' },
  { category: 'BioMapping vs NeuroKit2', source: 'Deconvolution', refField: 'peak_times',                 refLabel: 'NeuroKit2 default' },

  // 2. BioMapping vs Ledalab
  { category: 'BioMapping vs Ledalab',   source: 'Full-Scan',     refField: 'ledalab_lit_peak_times',     refLabel: 'Ledalab CDA (lit-tuned)' },
  { category: 'BioMapping vs Ledalab',   source: 'Prominence',    refField: 'ledalab_lit_peak_times',     refLabel: 'Ledalab CDA (lit-tuned)' },
  { category: 'BioMapping vs Ledalab',   source: 'Deconvolution', refField: 'ledalab_lit_peak_times',     refLabel: 'Ledalab CDA (lit-tuned)' },
  { category: 'BioMapping vs Ledalab',   source: 'cvxEDA',        refField: 'ledalab_lit_peak_times',     refLabel: 'Ledalab CDA (lit-tuned)' },
  { category: 'BioMapping vs Ledalab',   source: 'Full-Scan',     refField: 'ledalab_peak_times',         refLabel: 'Ledalab CDA (default)' },

  // 3. BioMapping cvxEDA vs Upstream Reference cvxEDA Solver
  { category: 'BioMapping vs cvxEDA Ref', source: 'cvxEDA',       refField: 'cvxeda_ref_driver_peak_times', refLabel: 'cvxEDA ref (driver)' },
  { category: 'BioMapping vs cvxEDA Ref', source: 'cvxEDA',       refField: 'cvxeda_ref_naive_peak_times',  refLabel: 'cvxEDA ref (naive)' },

  // 4. Cross-Toolbox Agreement (External vs External)
  { category: 'Cross-Toolbox Agreement',  externalSource: 'ledalab_lit_peak_times',     sourceLabel: 'Ledalab (lit-tuned)', refField: 'peak_times',        refLabel: 'NeuroKit2 default' },
  { category: 'Cross-Toolbox Agreement',  externalSource: 'cvxeda_ref_driver_peak_times', sourceLabel: 'cvxEDA ref (driver)', refField: 'cvxeda_peak_times', refLabel: 'NeuroKit2 cvxEDA' },
];

function matchPeaks(oursTimes, refTimes) {
  const usedRef = new Array(refTimes.length).fill(false);
  const matches = [];
  oursTimes.forEach((t) => {
    let best = -1, bestD = Infinity;
    refTimes.forEach((rt, ri) => {
      if (usedRef[ri]) return;
      const d = Math.abs(rt - t);
      if (d < bestD) { bestD = d; best = ri; }
    });
    if (best !== -1 && bestD <= TOL) {
      usedRef[best] = true;
      matches.push({ ourTime: t, refTime: refTimes[best], delta: t - refTimes[best] });
    }
  });
  const matchedOurTimes = new Set(matches.map(m => m.ourTime));
  return {
    matches,
    missed: refTimes.filter((_, ri) => !usedRef[ri]),
    extra: oursTimes.filter(t => !matchedOurTimes.has(t)),
  };
}

const [, , jsonPath, ...trackPaths] = process.argv;
if (!jsonPath || trackPaths.length === 0) {
  console.error('Usage: node compare.js <merged_reference.json> <track1.csv> [track2.csv ...]');
  process.exit(1);
}
const refData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

console.log('=== Our preprocessing/smoothing settings (GSR_DEFAULT) ===');
console.log(`  gaitFilter=${detectorDefaults.useGaitFilter ? 'on' : 'off (comparison mode)'}  medianSize=${D.medianSize}s (${D.medianSize > 0 ? 'median filter ON' : 'median filter OFF'})  lpfWindow=${D.lpfWindow}s (zero-phase moving-average low-pass)`);
console.log(`  tonicMethod=${D.tonicMethod}  tonicWindow=${D.tonicWindow}s  peakThreshold=${detectorDefaults.peakThreshold}uS`);
console.log(`  peak minimum gap=${global.GSR_CONST.PEAK_MIN_GAP}s`);
if (Object.hasOwn(detectorThresholdPatch, 'peakThreshold')) {
  console.log(`  benchmark-only peakThreshold override=${detectorThresholdPatch.peakThreshold}uS`);
}
if (useSmallSlowGate) {
  console.log(`  benchmark-only small-and-slow gate: reject amplitude < ${smallSlowAmplitude}uS AND slope < ${smallSlowSlope}uS/s`);
}

const aggregate = {};
COMPARISONS.forEach((c) => {
  const key = `${c.category}::${c.source || c.sourceLabel}::${c.refLabel}`;
  aggregate[key] = { ...c, matched: 0, refTotal: 0, extra: 0, deltas: [] };
});

for (const trackPath of trackPaths) {
  const name = path.basename(trackPath, '.csv');
  const ref = refData[name];
  if (!ref) { console.warn(`\n(no reference data for ${name}, skipping)`); continue; }

  const csvText = fs.readFileSync(trackPath, 'utf8');

  // Compute all BioMapping detector peaks once per track
  const ourPeaksMap = {};
  for (const [label, patch] of OUR_DETECTORS) {
    const a = new GSRAnalyzer();
    a.parseCSV(csvText);
    a.analyze({ ...detectorDefaults, ...patch }, 0);
    const filteredPeaks = useSmallSlowGate && label !== 'cvxEDA'
      ? a.peaks.filter(p => !(p.amplitude < smallSlowAmplitude && p.onsetSlope < smallSlowSlope))
      : a.peaks;
    ourPeaksMap[label] = filteredPeaks.map(p => p.time);
  }

  // Summary header of available reference peak counts
  const refParts = [];
  if (Array.isArray(ref.peak_times)) refParts.push(`NK2 default: ${ref.peak_times.length}`);
  if (Array.isArray(ref.cvxeda_peak_times)) refParts.push(`NK2 cvxEDA: ${ref.cvxeda_peak_times.length}`);
  if (Array.isArray(ref.ledalab_lit_peak_times)) refParts.push(`Ledalab tuned: ${ref.ledalab_lit_peak_times.length}`);
  if (Array.isArray(ref.ledalab_peak_times)) refParts.push(`Ledalab default: ${ref.ledalab_peak_times.length}`);
  if (Array.isArray(ref.cvxeda_ref_driver_peak_times)) refParts.push(`cvxEDA ref driver: ${ref.cvxeda_ref_driver_peak_times.length}`);

  const srStr = ref.sampling_rate ? `@ ${ref.sampling_rate.toFixed(2)}Hz` : '';
  const nStr = ref.n_samples ? `${ref.n_samples} samples` : '';
  console.log(`\n=== ${name} (${[nStr, srStr].filter(Boolean).join(' ')} | ${refParts.join(' | ')}) ===`);

  let currentCategory = '';
  for (const c of COMPARISONS) {
    const refTimes = ref[c.refField];
    if (!Array.isArray(refTimes) || refTimes.length === 0) continue;

    let sourceTimes = [];
    let sourceName = '';
    if (c.externalSource) {
      sourceTimes = ref[c.externalSource] || [];
      sourceName = c.sourceLabel;
    } else {
      sourceTimes = ourPeaksMap[c.source] || [];
      sourceName = c.source;
    }

    const r = matchPeaks(sourceTimes, refTimes);
    const meanAbsDelta = r.matches.length
      ? r.matches.reduce((s, m) => s + Math.abs(m.delta), 0) / r.matches.length
      : NaN;
    const recallPct = (100 * r.matches.length / refTimes.length).toFixed(1);

    if (c.category !== currentCategory) {
      console.log(`  [${c.category}]`);
      currentCategory = c.category;
    }

    const deltaStr = Number.isNaN(meanAbsDelta) ? 'n/a' : `${meanAbsDelta.toFixed(3)}s`;
    console.log(`    ${sourceName.padEnd(16)} vs ${c.refLabel.padEnd(25)} | recall ${recallPct.padStart(5)}% (${String(r.matches.length).padStart(3)}/${String(refTimes.length).padStart(3)}) | missed ${String(r.missed.length).padStart(3)} | extra ${String(r.extra.length).padStart(3)} | mean|delta| ${deltaStr}`);

    const key = `${c.category}::${c.source || c.sourceLabel}::${c.refLabel}`;
    const agg = aggregate[key];
    if (agg) {
      agg.matched += r.matches.length;
      agg.refTotal += refTimes.length;
      agg.extra += r.extra.length;
      agg.deltas.push(...r.matches.map(m => Math.abs(m.delta)));
    }
  }
}

console.log('\n================================================================================');
console.log('=== Aggregate across all tracks ===');
console.log('================================================================================');
let currentAggCategory = '';
for (const c of COMPARISONS) {
  const key = `${c.category}::${c.source || c.sourceLabel}::${c.refLabel}`;
  const agg = aggregate[key];
  if (!agg || agg.refTotal === 0) continue;

  if (agg.category !== currentAggCategory) {
    console.log(`\n  [${agg.category}]`);
    currentAggCategory = agg.category;
  }

  const recall = (100 * agg.matched / agg.refTotal).toFixed(1);
  const meanDelta = agg.deltas.length
    ? (agg.deltas.reduce((s, d) => s + d, 0) / agg.deltas.length).toFixed(3)
    : 'n/a';
  const sourceName = agg.source || agg.sourceLabel;
  console.log(`    ${sourceName.padEnd(16)} vs ${agg.refLabel.padEnd(25)} recall ${recall.padStart(5)}% (${String(agg.matched).padStart(3)}/${String(agg.refTotal).padStart(3)})  extra ${String(agg.extra).padStart(4)}  mean|delta| ${meanDelta}s`);
}
console.log();
