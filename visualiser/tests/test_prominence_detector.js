/**
 * Combined peak detector regression suite (params.usePeakProminence →
 * GSRAnalyzer._detectPeaksCombined).
 *
 * usePeakProminence now selects the UNION of the two detectors:
 *   - the default trough-to-peak detectPeaks() output as the base list,
 *   - each apex snapped to the most topographically-prominent local maximum
 *     within ±PEAK_MIN_GAP (fixes markers stranded on a compound rise's
 *     shoulder by the greedy left→right scan),
 *   - plus the prominence detector's above-threshold maxima that sit more than
 *     PEAK_MIN_GAP from every base peak (the compound-burst SCRs the greedy
 *     scan skipped past).
 *
 * These tests pin:
 *   - it produces well-formed peak objects (same shape as detectPeaks) and a
 *     numeric prominence field on every peak
 *   - the result is a superset of the trough-to-peak list (never fewer peaks)
 *   - every peak sits on a phasic local maximum
 *   - min-gap is respected; peak rate stays physiologically plausible
 *   - the shared _topographicProminence sweep runs once (perf guard)
 *   - it does not touch deconvolution state
 *
 * Run: node visualiser/tests/test_prominence_detector.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`), `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'),    'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'),    'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'),    'GSRCSVParser');
loadModule(path.join(__dirname, '../src/signal/analyzer.js'),      'GSRAnalyzer');
const { GSRAnalyzer } = global;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  FAIL:', msg); }
}

const csvText = fs.readFileSync(path.join(__dirname, '../../tracks/biomap_053.csv'), 'utf8');

// All shape/quality gates off so the comparison isolates the detector core.
const GATES_OFF = {
  minPeakQuality: 0, shapeMinSnr: 0,
  shapeMinRiseTime: 0, shapeMaxRiseTime: 0,
  shapeMinHalfRecovery: 0, shapeMaxHalfRecovery: 0, shapeMaxSkewRatio: 0,
};

function analyze(patch) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...global.GSR_CONST.GSR_DEFAULT, ...GATES_OFF, ...patch });
  return a;
}

console.log('Loading track biomap_053.csv...');
const trough   = analyze({ usePeakProminence: false });
const combined = analyze({ usePeakProminence: true });
const durMin = (combined.raw[combined.raw.length - 1].time - combined.raw[0].time) / 60;

console.log(`\n── default (LPF ${global.GSR_CONST.GSR_DEFAULT.lpfWindow}s), gates off`);
console.log(`   trough: ${trough.peaks.length}   combined: ${combined.peaks.length} (${(combined.peaks.length / durMin).toFixed(1)}/min)`);

assert(combined.peaks.length > 0, 'combined detector finds peaks on track 053');

// Union property: combined is a superset of trough-to-peak — never fewer, and
// close (rescues are a small minority of the list).
assert(combined.peaks.length >= trough.peaks.length,
  `combined is never smaller than trough-to-peak (${combined.peaks.length} >= ${trough.peaks.length})`);
const ratio = combined.peaks.length / trough.peaks.length;
assert(ratio <= 1.35,
  `combined adds only a modest number of rescues (ratio ${ratio.toFixed(2)} <= 1.35)`);

// Every trough-to-peak peak is still represented in the combined list, within
// one PEAK_MIN_GAP (apex-fix can shift a marker by up to that).
const cTimes = combined.peaks.map(p => p.time).sort((a, b) => a - b);
const gapS = global.GSR_CONST.PEAK_MIN_GAP;
const coveredCount = trough.peaks.filter(tp =>
  cTimes.some(ct => Math.abs(ct - tp.time) <= gapS)).length;
assert(coveredCount / trough.peaks.length >= 0.97,
  `>=97% of trough-to-peak peaks survive into the combined list (${coveredCount}/${trough.peaks.length})`);

// Combined mode ignores the morphology sliders (rise / half-recovery / skew) —
// _detectPeaksCombined forces them off, and the UI hides them. Tightening them
// hard must not change the combined output.
const combinedTightShape = analyze({
  usePeakProminence: true,
  shapeMinRiseTime: 1.0, shapeMaxRiseTime: 3.0,
  shapeMaxHalfRecovery: 4.0, shapeMaxSkewRatio: 0.8,
});
assert(combinedTightShape.peaks.length === combined.peaks.length,
  `combined mode ignores the shape sliders (tightened ${combinedTightShape.peaks.length} === default ${combined.peaks.length})`);

// The mechanism the prominence side adds shows on the RAW signal (LPF 0): the
// greedy trough-to-peak scan skips past compound-burst apices there, so the
// union recovers materially more.
const troughRaw   = analyze({ ...global.GSR_CONST.GSR_DEFAULT, lpfWindow: 0, usePeakProminence: false });
const combinedRaw = analyze({ ...global.GSR_CONST.GSR_DEFAULT, lpfWindow: 0, usePeakProminence: true });
console.log(`── raw (LPF 0), default gates    trough: ${troughRaw.peaks.length}   combined: ${combinedRaw.peaks.length}`);
assert(combinedRaw.peaks.length > troughRaw.peaks.length * 1.15,
  `on the raw signal, combined recovers >15% more on track 053 (${combinedRaw.peaks.length} vs ${troughRaw.peaks.length})`);

// Combined-mode rescues are gated by prominence, NOT by Min SNR — a rescue's
// amplitude is measured saddle-style so its SNR is deflated, and applying the
// SNR floor to it would delete the compound-burst event the rescue exists to
// recover. On the raw signal a large fraction of rescues sit below SNR 1.5, so
// raising Min SNR hard must not collapse the rescue margin (combined − trough).
const rawSnr = (snr, prom) => analyze({
  ...global.GSR_CONST.GSR_DEFAULT, lpfWindow: 0, usePeakProminence: prom, shapeMinSnr: snr,
}).peaks.length;
const marginLoSnr = rawSnr(1.5, true) - rawSnr(1.5, false);
const marginHiSnr = rawSnr(4.0, true) - rawSnr(4.0, false);
console.log(`── raw, rescue margin (combined − trough)   Min SNR 1.5: ${marginLoSnr}   Min SNR 4.0: ${marginHiSnr}`);
assert(marginLoSnr > 0 && marginHiSnr >= marginLoSnr * 0.7,
  `raising Min SNR does not collapse the rescue margin (${marginHiSnr} vs ${marginLoSnr})`);

// Peak-object shape parity with detectPeaks().
const keys = ['index', 'time', 'value', 'amplitude', 'onsetIndex', 'onsetTime',
              'recoveryIndex', 'halfRecoveryTime', 'riseTime', 'onsetSlope',
              'decaySlope', 'skewnessRatio', 'fwhm', 'snr', 'label', 'excluded',
              'qualityScore', 'salienceScore'];
const sample = combined.peaks[0];
assert(keys.every(k => k in sample), 'peak objects carry the full detectPeaks() field set');
assert(combined.peaks.every(p => typeof p.prominence === 'number' && p.prominence >= 0),
  'every peak carries a non-negative prominence field');

// Structural invariants.
assert(combined.peaks.every(p => p.onsetIndex <= p.index),
  'onset index never sits after the apex');
assert(combined.peaks.every(p => p.recoveryIndex === -1 || p.recoveryIndex > p.index),
  'recovery index, when found, sits after the apex');
assert(combined.peaks.every(p => p.amplitude > 0), 'all amplitudes positive');
assert(combined.peaks.every(p => Number.isFinite(p.time) && Number.isFinite(p.value)),
  'time/value finite for every peak');

// Every marker sits on a phasic local maximum (the apex-fix guarantee).
const pv = combined.phasic.map(d => d.val);
assert(combined.peaks.every(p =>
  p.index <= 0 || p.index >= pv.length - 1 ||
  (pv[p.index] >= pv[p.index - 1] && pv[p.index] >= pv[p.index + 1])),
  'every combined marker sits on a phasic local maximum');

// Minimum gap between consecutive peaks.
let minGap = Infinity;
for (let i = 1; i < cTimes.length; i++) minGap = Math.min(minGap, cTimes[i] - cTimes[i - 1]);
assert(minGap >= gapS - 1e-6,
  `no two peaks closer than PEAK_MIN_GAP: min gap = ${minGap.toFixed(3)}s`);

// Physiologically plausible rate on a busy walking track.
const rate = combined.peaks.length / durMin;
assert(rate > 1 && rate < 45, `peak rate plausible for a busy track: ${rate.toFixed(1)}/min`);

// Perf guard: the O(n log n) topographic-prominence sweep runs exactly once
// per analyze(), not once per detector.
let promSweeps = 0;
const a2 = new GSRAnalyzer();
a2.parseCSV(csvText);
const origTP = a2._topographicProminence.bind(a2);
a2._topographicProminence = (v) => { promSweeps++; return origTP(v); };
a2.analyze({ ...global.GSR_CONST.GSR_DEFAULT, ...GATES_OFF, usePeakProminence: true });
assert(promSweeps === 1, `combined detector runs one prominence sweep per analyze (got ${promSweeps})`);

// Deconvolution state left untouched.
assert(combined.phasicDriver.length === 0 && combined.phasicClean.length === 0 && combined.phasicDriverPeaks.length === 0,
  'combined path leaves deconvolution state empty');
assert(combined._phasicOrig === null, 'combined path clears any stale pre-deconvolution phasic backup');

// Precedence: combined wins when both flags are set.
const both = analyze({ usePeakProminence: true, useDeconvolution: true });
assert(both.phasicDriverPeaks.length === 0,
  'usePeakProminence overrides useDeconvolution when both are on');

// Short-signal guard.
const tiny = new GSRAnalyzer();
tiny.parseCSV('timestamp,gsr_raw\n0,1.0\n0.1,1.0\n');
tiny.analyze({ ...global.GSR_CONST.GSR_DEFAULT, usePeakProminence: true });
assert(Array.isArray(tiny.peaks) && tiny.peaks.length === 0, 'n<3 signal yields an empty peak list, no throw');

console.log('\n============================================================');
console.log(`Combined detector suite: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
