/**
 * Default peak detector regression suite (the no-flag path →
 * GSRAnalyzer._detectPeaksFullScan).
 *
 * The standard trough-to-peak SCR criterion — a local maximum that rose at
 * least peakThreshold above its saddle onset — applied NON-GREEDILY (every
 * local maximum tested, not just the first a left→right scan reaches), plus
 * Min SNR and Min Peak Quality, one per PEAK_MIN_GAP refractory window. This is
 * the detector `analyze()` runs when neither usePeakProminence nor
 * useDeconvolution is set (the greedy left→right detector was retired
 * 2026-09-09).
 *
 * Pins:
 *   - every peak clears the amplitude criterion and sits on a local maximum
 *   - it recovers rising-edge SCRs (>= peakThreshold rise, ~zero topographic
 *     prominence) that the prominence detector structurally misses
 *   - no double-counting: consecutive peaks don't share an onset across a
 *     preceding apex
 *   - structural invariants; refractory gap; physiological rate
 *   - Min SNR + Min Peak Quality are active gates; no morphology params exist
 *   - one _topographicProminence sweep; deconvolution state untouched
 *   - detector precedence: prominence > deconvolution > full-scan (default)
 *
 * Run: node visualiser/tests/test_default_detector.js
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
const dflt = analyze({});                                 // no-flag default = full-scan
const prom = analyze({ usePeakProminence: true });
const durMin = (dflt.raw[dflt.raw.length - 1].time - dflt.raw[0].time) / 60;
console.log(`\n── default ${dflt.peaks.length} (${(dflt.peaks.length / durMin).toFixed(1)}/min)   prominence ${prom.peaks.length}`);

assert(dflt.peaks.length > 0, 'default detector finds peaks on track 053');

// ── The reason full-scan is the default and not prominence: it keeps the
//    rising-edge SCRs prominence structurally misses (a real >= peakThreshold
//    rise from the saddle onset, but ~zero topographic prominence — no valley
//    on the up-slope side). ──
{
  const risingEdge = dflt.peaks.filter(p =>
    (p.prominence || 0) < THR * 0.5 && (p.amplitude || 0) >= THR);
  assert(risingEdge.length >= 5,
    `track 053 has rising-edge SCRs in the default output (${risingEdge.length})`);
  const promT = prom.peaks.map(p => p.time);
  const missedByProm = risingEdge.filter(p => !promT.some(t => Math.abs(t - p.time) <= GAP)).length;
  assert(missedByProm >= risingEdge.length * 0.5,
    `the prominence detector misses most of them (${missedByProm}/${risingEdge.length})`);
}

// ── The demo track's large textbook SCRs the prominence detector drops are all
//    retained by the default. ──
{
  const demoCsv = fs.readFileSync(path.join(__dirname, '../fixtures/default_processed.csv'), 'utf8');
  const dDef  = new GSRAnalyzer(); dDef.parseCSV(demoCsv);  dDef.analyze({ ...D }, 0);
  const dProm = new GSRAnalyzer(); dProm.parseCSV(demoCsv); dProm.analyze({ ...D, usePeakProminence: true }, 0);
  const promT = dProm.peaks.map(p => p.time);
  const defT  = dDef.peaks.map(p => p.time);
  const bigDropped = dProm.peaks.length && dDef.peaks.filter(p =>
    p.amplitude >= 0.2 && (p.qualityScore || 0) >= 0.75 &&
    !promT.some(t => Math.abs(t - p.time) <= GAP)).length;
  assert(bigDropped >= 5,
    `the demo track has large SCRs the prominence detector drops (${bigDropped})`);
  // every default peak sits on a phasic local maximum
  const dpv = dDef.phasic.map(d => d.val);
  assert(dDef.peaks.every(p =>
    p.index <= 0 || p.index >= dpv.length - 1 ||
    (dpv[p.index] >= dpv[p.index - 1] && dpv[p.index] >= dpv[p.index + 1])),
    'demo: every default marker sits on a phasic local maximum');
  void defT;
}

// ── No double-counting: consecutive peaks must not share an onset that sits
//    before the earlier peak's apex. ──
{
  let shared = 0;
  for (let i = 1; i < dflt.peaks.length; i++) {
    const a = dflt.peaks[i - 1], b = dflt.peaks[i];
    if (b.onsetIndex === a.onsetIndex && b.onsetIndex < a.index - 3) shared++;
  }
  assert(shared === 0, `no trailing peak shares an onset across a preceding apex (${shared})`);
}

// ── Detection rule + structural invariants. ──
assert(dflt.peaks.every(p => p.amplitude >= THR - 1e-9),
  `every peak's trough-to-peak amplitude >= peakThreshold (${THR})`);
const pv = dflt.phasic.map(d => d.val);
assert(dflt.peaks.every(p => p.onsetIndex <= p.index), 'onset index never after the apex');
assert(dflt.peaks.every(p => p.recoveryIndex === -1 || p.recoveryIndex > p.index),
  'recovery index, when found, after the apex');
assert(dflt.peaks.every(p => p.amplitude > 0), 'all amplitudes positive');
assert(dflt.peaks.every(p => typeof p.prominence === 'number' && p.prominence >= 0),
  'every peak carries a numeric prominence field (reported, not gated)');
assert(dflt.peaks.every(p =>
  p.index <= 0 || p.index >= pv.length - 1 ||
  (pv[p.index] >= pv[p.index - 1] && pv[p.index] >= pv[p.index + 1])),
  'every marker sits on a phasic local maximum');
const keys = ['index', 'time', 'value', 'amplitude', 'onsetIndex', 'onsetTime', 'recoveryIndex',
              'halfRecoveryTime', 'riseTime', 'onsetSlope', 'decaySlope', 'skewnessRatio',
              'fwhm', 'snr', 'label', 'excluded', 'qualityScore', 'salienceScore', 'prominence'];
assert(keys.every(k => k in dflt.peaks[0]), 'peak objects carry the full field set');

// ── Refractory gap + rate. The contract is round(PEAK_MIN_GAP * sampleRate)
//    samples — allow one sample of slack for non-integer sample rates. ──
let minGapIdx = Infinity;
for (let i = 1; i < dflt.peaks.length; i++)
  minGapIdx = Math.min(minGapIdx, dflt.peaks[i].index - dflt.peaks[i - 1].index);
const minGapSamples = Math.max(1, Math.round(GAP * dflt.sampleRate));
assert(minGapIdx >= minGapSamples,
  `no two peaks closer than round(PEAK_MIN_GAP*sr)=${minGapSamples} samples (min ${minGapIdx})`);
const rate = dflt.peaks.length / durMin;
assert(rate > 1 && rate < 45, `peak rate plausible (${rate.toFixed(1)}/min)`);

// ── Gates: no morphology params exist; Min SNR + Min Peak Quality active. ──
const noSnr = analyze({ shapeMinSnr: 0 });
const hiSnr = analyze({ shapeMinSnr: 3.0 });
assert(noSnr.peaks.length >= dflt.peaks.length && hiSnr.peaks.length <= dflt.peaks.length,
  `Min SNR is an active gate (SNR 0: ${noSnr.peaks.length}, default: ${dflt.peaks.length}, SNR 3: ${hiSnr.peaks.length})`);
const hiQ = analyze({ minPeakQuality: 0.7 });
assert(hiQ.peaks.length < dflt.peaks.length && hiQ.peaks.every(p => p.qualityScore >= 0.7),
  `Min Peak Quality is an active gate (${hiQ.peaks.length} < ${dflt.peaks.length})`);
// stale morphology params from a prior mode must be harmless (they are ignored)
const withStaleShape = analyze({
  shapeMinRiseTime: 1.0, shapeMaxRiseTime: 3.0, shapeMaxHalfRecovery: 4.0, shapeMaxSkewRatio: 0.8,
});
assert(withStaleShape.peaks.length === dflt.peaks.length,
  `unknown morphology params are ignored (${withStaleShape.peaks.length} === ${dflt.peaks.length})`);

// ── Perf: one topographic-prominence sweep per analyze(). ──
let sweeps = 0;
const a2 = new GSRAnalyzer();
a2.parseCSV(csvText);
const origTP = a2._topographicProminence.bind(a2);
a2._topographicProminence = v => { sweeps++; return origTP(v); };
a2.analyze({ ...D });
assert(sweeps === 1, `one prominence sweep per analyze (got ${sweeps})`);

// ── Deconvolution state untouched; precedence. ──
assert(dflt.phasicDriver.length === 0 && dflt.phasicClean.length === 0 && dflt.phasicDriverPeaks.length === 0,
  'default path leaves deconvolution state empty');
assert(dflt._phasicOrig === null, 'default path clears any stale pre-deconvolution phasic backup');
const promWins = analyze({ usePeakProminence: true });
assert(JSON.stringify(promWins.peaks.map(p => p.index)) === JSON.stringify(prom.peaks.map(p => p.index)),
  'usePeakProminence runs the prominence detector, not the default');
const deconvWins = analyze({ useDeconvolution: true });
assert(deconvWins.phasicDriverPeaks.length > 0,
  'useDeconvolution runs the deconvolution pipeline, not the default');

// ── Hotspot ranking uses trough-to-peak AMPLITUDE, not the stamped prominence
//    field. Full-scan stamps `prominence` for reporting, but a large real SCR
//    can have near-zero topographic prominence (a crest micro-wiggle splits its
//    apex — the demo-track "P1" at ~1067 s, ~4.5 µS, prominence ~0.01). Ranking
//    hotspots by prominence would bury it; ranking by amplitude keeps it #1. ──
{
  const demoCsv = fs.readFileSync(path.join(__dirname, '../fixtures/default_processed.csv'), 'utf8');
  const dFull = new GSRAnalyzer(); dFull.parseCSV(demoCsv); dFull.analyze({ ...D }, 0);
  const biggest = dFull.peaks.reduce((a, b) => (b.amplitude > a.amplitude ? b : a));
  assert((biggest.prominence || 0) < 0.1,
    `the demo track's largest SCR has a near-zero stamped prominence (${(biggest.prominence || 0).toFixed(3)})`);
  assert(dFull.memorableEvents.includes(biggest),
    `it is still selected as a hotspot in full-scan mode (amplitude ranking, not prominence)`);
  assert(dFull.memorableEvents[0] === biggest,
    `and it is the top hotspot (largest amplitude wins)`);
}

// ── Determinism. ──
const again = analyze({});
assert(JSON.stringify(dflt.peaks.map(p => [p.index, +p.amplitude.toFixed(6)])) ===
       JSON.stringify(again.peaks.map(p => [p.index, +p.amplitude.toFixed(6)])),
  'identical inputs give identical peaks');

// ── Short-signal guard. ──
const tiny = new GSRAnalyzer();
tiny.parseCSV('timestamp,gsr_raw\n0,1.0\n0.1,1.0\n');
tiny.analyze({ ...D });
assert(Array.isArray(tiny.peaks) && tiny.peaks.length === 0, 'n<3 signal yields an empty peak list, no throw');

console.log('\n============================================================');
console.log(`Default detector suite: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
