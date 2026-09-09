/**
 * Prominence peak detector regression suite (params.usePeakProminence →
 * GSRAnalyzer._detectPeaksByProminence).
 *
 * One non-greedy pass: a response is any phasic local maximum whose TOPOGRAPHIC
 * PROMINENCE >= peakThreshold — conductance rose at least that much above the
 * level it last recovered to. A refractory-period non-max suppression
 * (PEAK_MIN_GAP) is applied on top; the only per-peak gate is Min Peak Quality.
 * Every peak carries both `prominence` (the size metric, drives hotspot ranking)
 * and trough-to-peak `amplitude` (measured from a threshold-aware saddle onset).
 *
 * These tests pin:
 *   - every peak clears the prominence gate and sits on a local maximum
 *   - well-formed peak objects (full detectPeaks() field set + numeric prominence)
 *   - structural invariants (onset <= apex, recovery > apex, amplitude > 0)
 *   - PEAK_MIN_GAP respected; peak rate physiologically plausible
 *   - morphology sliders and Min SNR do not change the output; Min Peak Quality does
 *   - one _topographicProminence sweep per analyze()
 *   - deconvolution state untouched; precedence over deconvolution
 *   - a sub-threshold crest wiggle does not collapse the response's amplitude
 *     (threshold-aware onset) — regression for the demo-track "P1"
 *   - hotspot ranking uses prominence in this mode
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
const D = global.GSR_CONST.GSR_DEFAULT;
const THR = D.peakThreshold;
const GAP = global.GSR_CONST.PEAK_MIN_GAP;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  FAIL:', msg); }
}

const csvText = fs.readFileSync(path.join(__dirname, '../../tracks/biomap_053.csv'), 'utf8');

function analyze(patch) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...D, ...patch }, 0);
  return a;
}

console.log('Loading track biomap_053.csv...');
const trough = analyze({ usePeakProminence: false });
const prom   = analyze({ usePeakProminence: true });
const durMin = (prom.raw[prom.raw.length - 1].time - prom.raw[0].time) / 60;
console.log(`\n── LPF ${D.lpfWindow}s   trough: ${trough.peaks.length}   prominence: ${prom.peaks.length} (${(prom.peaks.length / durMin).toFixed(1)}/min)`);

assert(prom.peaks.length > 0, 'prominence detector finds peaks on track 053');

// It is a re-derivation of the same signal, not a superset: shoulders fold into
// their summits (fewer), a few stacked SCRs the greedy scan skipped are added.
const ratio = prom.peaks.length / trough.peaks.length;
assert(ratio > 0.7 && ratio < 1.2,
  `count stays within a sane band of trough-to-peak (ratio ${ratio.toFixed(2)})`);

// The detection rule: every peak's topographic prominence clears peakThreshold.
assert(prom.peaks.every(p => typeof p.prominence === 'number' && p.prominence >= THR - 1e-9),
  `every peak's prominence >= peakThreshold (${THR})`);

// Every large isolated trough-to-peak SCR (>= 3s from any neighbour, amp >= 0.3)
// is still found within one PEAK_MIN_GAP — folding shoulders must not drop
// genuine standalone responses.
const tT = trough.peaks.map(p => p.time).sort((a, b) => a - b);
const isolatedBig = trough.peaks.filter((p, k) =>
  p.amplitude >= 0.3 &&
  (k === 0 || p.time - tT[k - 1] >= 3) &&
  (k === tT.length - 1 || tT[k + 1] - p.time >= 3));
const pT = prom.peaks.map(p => p.time);
const keptBig = isolatedBig.filter(p => pT.some(t => Math.abs(t - p.time) <= GAP)).length;
assert(isolatedBig.length > 0 && keptBig === isolatedBig.length,
  `every isolated large SCR is retained (${keptBig}/${isolatedBig.length})`);

// Morphology sliders (rise / half-recovery / skew) and Min SNR do not gate this
// mode; only Min Peak Quality does.
const tightShape = analyze({
  usePeakProminence: true,
  shapeMinRiseTime: 1.0, shapeMaxRiseTime: 3.0, shapeMaxHalfRecovery: 4.0,
  shapeMaxSkewRatio: 0.8, shapeMinSnr: 4.0,
});
assert(tightShape.peaks.length === prom.peaks.length,
  `shape sliders + Min SNR do not change the output (${tightShape.peaks.length} === ${prom.peaks.length})`);
const highQ = analyze({ usePeakProminence: true, minPeakQuality: 0.7 });
assert(highQ.peaks.length < prom.peaks.length,
  `Min Peak Quality does gate (${highQ.peaks.length} < ${prom.peaks.length})`);
assert(highQ.peaks.every(p => p.qualityScore >= 0.7), 'and it is actually applied per peak');

// Peak-object shape parity with detectPeaks().
const keys = ['index', 'time', 'value', 'amplitude', 'onsetIndex', 'onsetTime',
              'recoveryIndex', 'halfRecoveryTime', 'riseTime', 'onsetSlope',
              'decaySlope', 'skewnessRatio', 'fwhm', 'snr', 'label', 'excluded',
              'qualityScore', 'salienceScore', 'prominence'];
assert(keys.every(k => k in prom.peaks[0]), 'peak objects carry the full field set + prominence');

// Structural invariants.
const pv = prom.phasic.map(d => d.val);
assert(prom.peaks.every(p => p.onsetIndex <= p.index), 'onset index never after the apex');
assert(prom.peaks.every(p => p.recoveryIndex === -1 || p.recoveryIndex > p.index),
  'recovery index, when found, after the apex');
assert(prom.peaks.every(p => p.amplitude > 0), 'all amplitudes positive');
assert(prom.peaks.every(p => Number.isFinite(p.time) && Number.isFinite(p.value)), 'time/value finite');
assert(prom.peaks.every(p =>
  p.index <= 0 || p.index >= pv.length - 1 ||
  (pv[p.index] >= pv[p.index - 1] && pv[p.index] >= pv[p.index + 1])),
  'every marker sits on a phasic local maximum');

// Refractory-period separation.
let minGap = Infinity;
for (let i = 1; i < pT.length; i++) minGap = Math.min(minGap, prom.peaks[i].time - prom.peaks[i - 1].time);
assert(minGap >= GAP - 1e-6, `no two peaks closer than PEAK_MIN_GAP (min ${minGap.toFixed(3)}s)`);

// Physiologically plausible rate.
const rate = prom.peaks.length / durMin;
assert(rate > 1 && rate < 45, `peak rate plausible (${rate.toFixed(1)}/min)`);

// Perf guard: one topographic-prominence sweep per analyze().
let sweeps = 0;
const a2 = new GSRAnalyzer();
a2.parseCSV(csvText);
const origTP = a2._topographicProminence.bind(a2);
a2._topographicProminence = (v) => { sweeps++; return origTP(v); };
a2.analyze({ ...D, usePeakProminence: true });
assert(sweeps === 1, `one prominence sweep per analyze (got ${sweeps})`);

// Deconvolution state untouched; precedence over deconvolution.
assert(prom.phasicDriver.length === 0 && prom.phasicClean.length === 0 && prom.phasicDriverPeaks.length === 0,
  'prominence path leaves deconvolution state empty');
assert(prom._phasicOrig === null, 'prominence path clears any stale pre-deconvolution phasic backup');
const both = analyze({ usePeakProminence: true, useDeconvolution: true });
assert(both.phasicDriverPeaks.length === 0, 'usePeakProminence overrides useDeconvolution when both are on');

// ── A sub-threshold crest wiggle must not collapse the response's amplitude ──
// The demo-track "P1" SCR (~1067 s, ~4.5 µS) carries a ~0.01 µS double-bump at
// its crest. The prominence pass sits on the higher sub-peak; a naive saddle
// walk-back from there stops in the notch and trough-to-peak amplitude reads as
// the notch depth (~0.05 µS). The threshold-aware onset walks through notches
// shallower than peakThreshold, so the amplitude is measured from the real
// onset and the event stays the track's largest response and a hotspot.
{
  const demoCsv = fs.readFileSync(path.join(__dirname, '../fixtures/default_processed.csv'), 'utf8');
  const off = new GSRAnalyzer(); off.parseCSV(demoCsv);
  off.analyze({ ...D, usePeakProminence: false }, 0);
  const on = new GSRAnalyzer(); on.parseCSV(demoCsv);
  on.analyze({ ...D, usePeakProminence: true }, 0);

  const biggestOff = off.peaks.reduce((a, b) => (b.amplitude > a.amplitude ? b : a));
  const p1 = on.peaks
    .filter(p => Math.abs(p.time - biggestOff.time) <= GAP)
    .sort((a, b) => b.prominence - a.prominence)[0];
  assert(p1 != null, `P1 (t=${biggestOff.time.toFixed(1)}s) is detected in prominence mode`);
  assert(p1 && p1.amplitude >= biggestOff.amplitude * 0.9,
    `P1 amplitude is not collapsed by the crest wiggle (${p1 && p1.amplitude.toFixed(3)} vs ${biggestOff.amplitude.toFixed(3)})`);
  assert(p1 && Math.abs(p1.prominence - p1.amplitude) < 0.25,
    'P1 prominence and trough-to-peak amplitude agree for this isolated response');
  assert(p1 && on.memorableEvents.includes(p1),
    'P1 is selected as a hotspot in prominence mode');

  // Hotspot ranking uses prominence here: the top hotspot is the most prominent
  // active peak (spacing permitting), not necessarily the largest amplitude.
  const mostProm = on.peaks.filter(p => !p.excluded)
    .reduce((a, b) => (b.prominence > a.prominence ? b : a));
  assert(on.memorableEvents[0] && on.memorableEvents[0].prominence >= mostProm.prominence - 1e-9,
    'the first hotspot is the most prominent active peak');
}

// ── Threshold-aware onset: a synthetic crest notch below peakThreshold is
//    walked through; one above it is not. ──
{
  const a = new GSRAnalyzer();
  // rise 0 -> 1.0 over 20 samples, notch of depth `d` at the crest, tiny tail.
  const mk = (d) => {
    const v = [];
    for (let k = 0; k < 20; k++) v.push(k * 0.05);          // 0 .. 0.95
    v.push(1.00); v.push(1.00 - d); v.push(1.00 - d + 0.001); v.push(1.02); // crest + notch + higher tip
    for (let k = 0; k < 20; k++) v.push(1.02 - k * 0.05);   // decay
    return v;
  };
  const reachedBase = (d) => a._findOnsetIndex(mk(d), 23, 50, THR) === 0;
  assert(reachedBase(THR * 0.5) === true,
    'a notch shallower than peakThreshold is walked through to the true onset');
  assert(reachedBase(THR * 5) === false,
    'a notch deeper than peakThreshold stops the walk-back (distinct partial recovery)');
  // Legacy path (minDip 0) is unchanged: stops at the first local minimum.
  assert(a._findOnsetIndex(mk(THR * 0.5), 23, 50) === 21,
    'minDip=0 keeps the original behaviour (stops at the first local minimum)');
}

// Short-signal guard.
const tiny = new GSRAnalyzer();
tiny.parseCSV('timestamp,gsr_raw\n0,1.0\n0.1,1.0\n');
tiny.analyze({ ...D, usePeakProminence: true });
assert(Array.isArray(tiny.peaks) && tiny.peaks.length === 0, 'n<3 signal yields an empty peak list, no throw');

console.log('\n============================================================');
console.log(`Prominence detector suite: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
