/**
 * Full-scan peak detector regression suite (params.useFullScanDetector →
 * GSRAnalyzer._detectPeaksFullScan).
 *
 * The standard trough-to-peak SCR criterion — a local maximum that rose at
 * least peakThreshold above its saddle onset — applied NON-GREEDILY (every
 * local maximum tested, not just the first the left→right scan reaches), plus
 * Min SNR and Min Peak Quality, one per PEAK_MIN_GAP refractory window.
 *
 * Pins:
 *   - every peak clears the amplitude criterion and sits on a local maximum
 *   - it is a superset of the greedy default detector (never fewer, ~+2-3%)
 *   - it recovers the rising-edge SCRs the prominence detector structurally
 *     misses (its whole reason to exist)
 *   - no double-counting: consecutive peaks don't share an onset across a
 *     preceding apex
 *   - structural invariants; refractory gap; physiological rate
 *   - morphology sliders inert; Min SNR + Min Peak Quality active
 *   - one _topographicProminence sweep; deconvolution state untouched;
 *     precedence prominence > full-scan > deconvolution
 *
 * Run: node visualiser/tests/test_fullscan_detector.js
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
const D = global.GSR_CONST.GSR_DEFAULT;
const THR = D.peakThreshold;
const GAP = global.GSR_CONST.PEAK_MIN_GAP;

let passed = 0, failed = 0;
const assert = (c, m) => { c ? passed++ : (failed++, console.error('  FAIL:', m)); };

const csvText = fs.readFileSync(path.join(__dirname, '../../tracks/biomap_053.csv'), 'utf8');
const analyze = patch => {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D, ...patch }, 0);
  return a;
};

console.log('Loading track biomap_053.csv...');
const trough   = analyze({});                                 // greedy default
const prom     = analyze({ usePeakProminence: true });
const fullScan = analyze({ useFullScanDetector: true });
const durMin = (fullScan.raw[fullScan.raw.length - 1].time - fullScan.raw[0].time) / 60;
console.log(`\n── trough ${trough.peaks.length}   prominence ${prom.peaks.length}   full-scan ${fullScan.peaks.length} (${(fullScan.peaks.length / durMin).toFixed(1)}/min)`);

assert(fullScan.peaks.length > 0, 'full-scan finds peaks on track 053');

// ── Superset of the greedy default: never fewer, and every default peak is
//    represented within one refractory window. ──
const dT = trough.peaks.map(p => p.time).sort((a, b) => a - b);
const fT = fullScan.peaks.map(p => p.time).sort((a, b) => a - b);
assert(fullScan.peaks.length >= trough.peaks.length,
  `never fewer than the greedy default (${fullScan.peaks.length} >= ${trough.peaks.length})`);
const covered = trough.peaks.filter(tp => fT.some(t => Math.abs(t - tp.time) <= GAP)).length;
assert(covered === trough.peaks.length,
  `100% of default peaks are retained (${covered}/${trough.peaks.length})`);
const ratio = fullScan.peaks.length / trough.peaks.length;
assert(ratio > 1.0 && ratio < 1.15, `adds only a modest number of compound-burst peaks (ratio ${ratio.toFixed(2)})`);

// ── The reason it exists: recover the rising-edge SCRs the prominence detector
//    drops. On the demo track those are numerous and large. ──
{
  const demoCsv = fs.readFileSync(path.join(__dirname, '../fixtures/default_processed.csv'), 'utf8');
  const dOff = new GSRAnalyzer(); dOff.parseCSV(demoCsv); dOff.analyze({ ...D }, 0);
  const dProm = new GSRAnalyzer(); dProm.parseCSV(demoCsv); dProm.analyze({ ...D, usePeakProminence: true }, 0);
  const dFull = new GSRAnalyzer(); dFull.parseCSV(demoCsv); dFull.analyze({ ...D, useFullScanDetector: true }, 0);
  const promT = dProm.peaks.map(p => p.time);
  const fullT = dFull.peaks.map(p => p.time);
  // large, textbook default SCRs that the prominence detector misses
  const missedByProm = dOff.peaks.filter(p =>
    p.amplitude >= 0.2 && (p.qualityScore || 0) >= 0.75 &&
    !promT.some(t => Math.abs(t - p.time) <= GAP));
  assert(missedByProm.length >= 5,
    `the demo track has rising-edge SCRs the prominence detector misses (${missedByProm.length})`);
  const recovered = missedByProm.filter(p => fullT.some(t => Math.abs(t - p.time) <= GAP)).length;
  assert(recovered === missedByProm.length,
    `full-scan recovers all of them (${recovered}/${missedByProm.length})`);
}

// ── No double-counting: consecutive peaks must not share an onset that sits
//    before the earlier peak's apex. ──
{
  let shared = 0;
  for (let i = 1; i < fullScan.peaks.length; i++) {
    const a = fullScan.peaks[i - 1], b = fullScan.peaks[i];
    if (b.onsetIndex === a.onsetIndex && b.onsetIndex < a.index - 3) shared++;
  }
  assert(shared === 0, `no trailing peak shares an onset across a preceding apex (${shared})`);
}

// ── Detection rule + structural invariants. ──
assert(fullScan.peaks.every(p => p.amplitude >= THR - 1e-9),
  `every peak's trough-to-peak amplitude >= peakThreshold (${THR})`);
const pv = fullScan.phasic.map(d => d.val);
assert(fullScan.peaks.every(p => p.onsetIndex <= p.index), 'onset index never after the apex');
assert(fullScan.peaks.every(p => p.recoveryIndex === -1 || p.recoveryIndex > p.index),
  'recovery index, when found, after the apex');
assert(fullScan.peaks.every(p => p.amplitude > 0), 'all amplitudes positive');
assert(fullScan.peaks.every(p => typeof p.prominence === 'number' && p.prominence >= 0),
  'every peak carries a numeric prominence field (reported, not gated)');
assert(fullScan.peaks.every(p =>
  p.index <= 0 || p.index >= pv.length - 1 ||
  (pv[p.index] >= pv[p.index - 1] && pv[p.index] >= pv[p.index + 1])),
  'every marker sits on a phasic local maximum');
const keys = ['index', 'time', 'value', 'amplitude', 'onsetIndex', 'onsetTime', 'recoveryIndex',
              'halfRecoveryTime', 'riseTime', 'onsetSlope', 'decaySlope', 'skewnessRatio',
              'fwhm', 'snr', 'label', 'excluded', 'qualityScore', 'salienceScore', 'prominence'];
assert(keys.every(k => k in fullScan.peaks[0]), 'peak objects carry the full field set');

// ── Refractory gap + rate. The contract is round(PEAK_MIN_GAP * sampleRate)
//    samples — same sample-space rounding every detector uses — so allow one
//    sample of slack when a non-integer sample rate makes that < PEAK_MIN_GAP s.
let minGapIdx = Infinity;
for (let i = 1; i < fullScan.peaks.length; i++)
  minGapIdx = Math.min(minGapIdx, fullScan.peaks[i].index - fullScan.peaks[i - 1].index);
const minGapSamples = Math.max(1, Math.round(GAP * fullScan.sampleRate));
assert(minGapIdx >= minGapSamples,
  `no two peaks closer than round(PEAK_MIN_GAP*sr)=${minGapSamples} samples (min ${minGapIdx})`);
const rate = fullScan.peaks.length / durMin;
assert(rate > 1 && rate < 45, `peak rate plausible (${rate.toFixed(1)}/min)`);

// ── Gates: morphology sliders inert; Min SNR + Min Peak Quality active. ──
const tightShape = analyze({
  useFullScanDetector: true,
  shapeMinRiseTime: 1.0, shapeMaxRiseTime: 3.0, shapeMaxHalfRecovery: 4.0, shapeMaxSkewRatio: 0.8,
});
assert(tightShape.peaks.length === fullScan.peaks.length,
  `rise / half-recovery / skew sliders do not change the output (${tightShape.peaks.length} === ${fullScan.peaks.length})`);
const noSnr = analyze({ useFullScanDetector: true, shapeMinSnr: 0 });
const hiSnr = analyze({ useFullScanDetector: true, shapeMinSnr: 3.0 });
assert(noSnr.peaks.length >= fullScan.peaks.length && hiSnr.peaks.length <= fullScan.peaks.length,
  `Min SNR is an active gate (SNR 0: ${noSnr.peaks.length}, default: ${fullScan.peaks.length}, SNR 3: ${hiSnr.peaks.length})`);
const hiQ = analyze({ useFullScanDetector: true, minPeakQuality: 0.7 });
assert(hiQ.peaks.length < fullScan.peaks.length && hiQ.peaks.every(p => p.qualityScore >= 0.7),
  `Min Peak Quality is an active gate (${hiQ.peaks.length} < ${fullScan.peaks.length})`);

// ── Perf: one topographic-prominence sweep per analyze(). ──
let sweeps = 0;
const a2 = new GSRAnalyzer();
a2.parseCSV(csvText);
const origTP = a2._topographicProminence.bind(a2);
a2._topographicProminence = v => { sweeps++; return origTP(v); };
a2.analyze({ ...D, useFullScanDetector: true });
assert(sweeps === 1, `one prominence sweep per analyze (got ${sweeps})`);

// ── Deconvolution state untouched; precedence. ──
assert(fullScan.phasicDriver.length === 0 && fullScan.phasicClean.length === 0 && fullScan.phasicDriverPeaks.length === 0,
  'full-scan path leaves deconvolution state empty');
assert(fullScan._phasicOrig === null, 'full-scan path clears any stale pre-deconvolution phasic backup');
const promWins = analyze({ useFullScanDetector: true, usePeakProminence: true });
assert(promWins.peaks.length === prom.peaks.length,
  'usePeakProminence takes precedence over useFullScanDetector');
const fullOverDeconv = analyze({ useFullScanDetector: true, useDeconvolution: true });
assert(fullOverDeconv.phasicDriverPeaks.length === 0,
  'useFullScanDetector takes precedence over useDeconvolution');

// ── Determinism. ──
const again = analyze({ useFullScanDetector: true });
assert(JSON.stringify(fullScan.peaks.map(p => [p.index, +p.amplitude.toFixed(6)])) ===
       JSON.stringify(again.peaks.map(p => [p.index, +p.amplitude.toFixed(6)])),
  'identical inputs give identical peaks');

// ── Short-signal guard. ──
const tiny = new GSRAnalyzer();
tiny.parseCSV('timestamp,gsr_raw\n0,1.0\n0.1,1.0\n');
tiny.analyze({ ...D, useFullScanDetector: true });
assert(Array.isArray(tiny.peaks) && tiny.peaks.length === 0, 'n<3 signal yields an empty peak list, no throw');

console.log('\n============================================================');
console.log(`Full-scan detector suite: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
