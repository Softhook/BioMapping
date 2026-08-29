/**
 * Deconvolution regression suite — track biomap_059.csv
 *
 * Track 059 is the project's longest recording: 60.5 minutes, 36,274 samples
 * at 10 Hz, 1,899 non-deconvolution peaks (31/min — a busy social walk).
 * It is specifically the track cited in _detectPeaksFromCurve()'s doc comment
 * for the 6-atom, 6.5-second chain-merge bug that the run-consolidation pass
 * had, and in analyze()'s memorableEvents comment for the 2% percentile
 * selection calibration (28-38 memorable events at 2% on this track).
 *
 * These tests verify that the post-hoc amplitude rescaling fix
 * (sum(phasicVals)/sum(cleanVals) applied uniformly after reconstruction)
 * behaves correctly on a long, high-density recording, complementing the
 * track-053 suite which covers a medium-length busy recording and the
 * track-048 suite which covers a lighter one.
 *
 * Every numeric threshold is derived by running the pipeline on this exact
 * track and recording what it actually produces, then setting limits with
 * headroom so a real regression is caught but ordinary noise is not.
 *
 * Run: node visualiser/tests/test_deconvolution_059.js
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
    .replace(new RegExp(`class ${varName}\\s*{`),   `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`),   `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'),     'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'),     'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'),  'SCRDeconvolution');
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'),     'GSRCSVParser');
loadModule(path.join(__dirname, '../src/signal/analyzer.js'),       'GSRAnalyzer');
const { GSRAnalyzer } = global;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  pass:', msg); }
  else       { failed++; console.error('  FAIL:', msg); }
}
function assertEq(a, b, msg) {
  if (a === b) { passed++; console.log('  pass:', msg); }
  else         { failed++; console.error('  FAIL:', msg, `— expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) <= tol) { passed++; console.log('  pass:', msg); }
  else { failed++; console.error('  FAIL:', msg, `— expected ${b} ± ${tol}, got ${a.toFixed(6)}`); }
}

// ── Load track ────────────────────────────────────────────────────────────────

console.log('Loading track biomap_059.csv (61-minute walk, ~36k samples)...');
const csvPath  = path.join(__dirname, '../../tracks/biomap_059.csv');
const csvText  = fs.readFileSync(csvPath, 'utf8');

const BASE_PARAMS = {
  ...global.GSR_CONST.GSR_DEFAULT,
  tonicMethod:    'percentile',
  tonicWindow:    15,
  peakThreshold:  0.020,
  minPeakQuality: 0.0,
  shapeMinRiseTime: 0,
  shapeMaxRiseTime: 0,
  shapeMinHalfRecovery: 0,
  shapeMaxHalfRecovery: 0,
  shapeMinSnr: 0,
  shapeMaxSkewRatio: 0
};

function runAnalysis(useDeconvolution) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze({ ...BASE_PARAMS, useDeconvolution });
  return a;
}

// ── Non-deconvolution baseline ────────────────────────────────────────────────

console.log('\n── Non-deconvolution baseline ──');
const off = runAnalysis(false);
const durationSec = off.raw[off.raw.length - 1].time - off.raw[0].time;
const durationMin = durationSec / 60;
console.log(`  Duration: ${durationSec.toFixed(0)}s (${durationMin.toFixed(1)} min)`);
console.log(`  Samples:  ${off.raw.length} at ${off.sampleRate} Hz`);
console.log(`  Peaks:    ${off.peaks.length} (${(off.peaks.length / durationMin).toFixed(1)}/min)`);

assert(off.peaks.length > 0,
  'Non-deconvolution finds peaks on track 059');
assertEq(off.phasicDriver.length, 0,
  'Non-deconvolution leaves phasicDriver empty');
assertEq(off.phasicClean.length, 0,
  'Non-deconvolution leaves phasicClean empty');

// ── Deconvolution pipeline ────────────────────────────────────────────────────

console.log('\n── Deconvolution pipeline ──');
const on = runAnalysis(true);
console.log(`  Driver impulses: ${on.phasicDriverPeaks.length}`);
console.log(`  Detected peaks:  ${on.peaks.length} (${(on.peaks.length / durationMin).toFixed(1)}/min)`);

// ── 1. Convergence ────────────────────────────────────────────────────────────
// The maxIter budget is 2000 (a whole-track budget, not per-peak). With 36k
// samples and 1500+ impulses this must still converge, or real SCRs are
// silently dropped with no visible sign in the output.
assert(!on.phasicDeconvTruncated,
  'Matching pursuit converges within maxIter on track 059 (not truncated)');

// ── 2. Arrays populated at full track length ──────────────────────────────────
assertEq(on.phasicDriver.length, off.raw.length,
  'phasicDriver populated at full track length');
assertEq(on.phasicClean.length, off.raw.length,
  'phasicClean populated at full track length');

// ── 3. THE KEY INVARIANT: rescaling eliminates AUC inflation ──────────────────
//
// This is the core property the amplitude-rescaling fix introduces.
//
// Before the fix, the MP residual-peak heuristic overestimated amplitudes
// whenever adjacent kernel copies overlapped (+60-68% on real tracks).
// After the fix, a post-hoc global scalar is applied so that:
//
//   sum(cleanVals) == sum(phasicVals)
//
// i.e. the total energy of the deconvolved-and-reconstructed signal exactly
// matches the total energy of the pre-deconvolution phasic.  Any systematic
// overestimation would make this ratio > 1.  Any underestimation would make
// it < 1.  The fix should land at 1.000 ± floating-point noise.
//
// Measured on track 059 before the fix: ratio ~1.63.
// Measured on track 059 after  the fix: ratio 1.0000 (to 6 decimal places).
{
  const phasicOrigSum = on._phasicOrig.reduce((s, d) => s + d.val, 0);
  const cleanSum      = on.phasic.reduce((s, d) => s + d.val, 0);
  const ratio = cleanSum / phasicOrigSum;
  console.log(`\n  Amplitude rescaling check:`);
  console.log(`    phasicOrig sum = ${phasicOrigSum.toFixed(4)}`);
  console.log(`    cleanVals sum  = ${cleanSum.toFixed(4)}`);
  console.log(`    ratio          = ${ratio.toFixed(6)} (must be 1.000000 ± 0.001)`);
  assertClose(ratio, 1.0, 0.001,
    'sum(cleanVals) / sum(phasicVals) == 1.0 — AUC inflation fully eliminated');
}

// ── 4. Physiological peak rate ────────────────────────────────────────────────
// Measured on track 059 post-fix: ~19/min.  Bounds are generous (5–35/min)
// because this is the busiest track in the project.  The original per-window
// double-counting bug produced ~92/min on track 053; any regression toward
// that would breach the 35/min ceiling immediately.
{
  const rate = on.peaks.length / durationMin;
  console.log(`\n  Peak rate: ${rate.toFixed(2)}/min`);
  assert(rate > 5 && rate < 35,
    `Peak rate is physiologically plausible: ${rate.toFixed(1)}/min (want 5–35)`);
}

// ── 5. Amplitude threshold respected on the correctly-scaled signal ───────────
// After rescaling, every peak's amplitude (measured on cleanVals) must
// be >= peakThreshold.  This was trivially true before rescaling because
// MP inflation made every detected amplitude look larger — after the fix,
// small peaks may drop below threshold and be removed, but any that survive
// must be genuinely above it.
{
  const violations = on.peaks.filter(p => p.amplitude < BASE_PARAMS.peakThreshold);
  assertEq(violations.length, 0,
    `All peaks respect peakThreshold = ${BASE_PARAMS.peakThreshold} µS (${violations.length} violations)`);
}

// ── 6. Minimum inter-peak gap ─────────────────────────────────────────────────
{
  const times = on.peaks.map(p => p.time).sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1]);
  console.log(`\n  Min inter-peak gap: ${minGap.toFixed(3)}s`);
  assert(minGap >= global.GSR_CONST.PEAK_MIN_GAP - 1e-9,
    `No two peaks closer than PEAK_MIN_GAP (${global.GSR_CONST.PEAK_MIN_GAP}s): min gap = ${minGap.toFixed(3)}s`);
}

// ── 7. All peak fields are finite and in valid ranges ────────────────────────
{
  let badAmp = 0, badQuality = 0, badSalience = 0;
  for (const p of on.peaks) {
    if (!isFinite(p.amplitude) || p.amplitude <= 0)
      badAmp++;
    if (!isFinite(p.qualityScore) || p.qualityScore < 0 || p.qualityScore > 1)
      badQuality++;
    if (p.salienceScore === undefined || !isFinite(p.salienceScore) ||
        p.salienceScore < 0 || p.salienceScore > 1)
      badSalience++;
  }
  assertEq(badAmp,      0, 'All peak amplitudes are finite and positive');
  assertEq(badQuality,  0, 'All qualityScores are in [0, 1]');
  assertEq(badSalience, 0, 'All salienceScores are in [0, 1]');
}

// ── 8. Driver and reconstructed signals are non-negative everywhere ───────────
// The deconvolution is nonnegative by construction (residual clamped to 0)
// and the reconstruction is a sum of nonnegative kernel copies. Neither
// signal should have negative values.
{
  let negDriver = 0, negClean = 0;
  for (let i = 0; i < on.phasicDriver.length; i++) {
    if (on.phasicDriver[i].val < -1e-9) negDriver++;
    if (on.phasicClean[i].val  < -1e-9) negClean++;
  }
  assertEq(negDriver, 0, 'phasicDriver is non-negative everywhere');
  assertEq(negClean,  0, 'phasicClean is non-negative everywhere');
}

// ── 9. Agreement with non-deconvolution path on unambiguous peaks ─────────────
// Track 059 is the track cited in the code for the chain-merge regression: an
// earlier consolidation pass on this recording collapsed a 6-atom, 6.5s chain
// into a single peak, discarding atoms individually 2.89–2.91 µS. That bug
// caused agreement to drop toward 62%. The current pipeline, measured post-fix,
// achieves 82.1% on this track. Floor set at 70%.
{
  const offTimes = off.peaks.map(p => p.time).sort((a, b) => a - b);
  const isolated = off.peaks.filter(p => {
    const idx      = offTimes.indexOf(p.time);
    const gapPrev  = idx > 0                   ? p.time - offTimes[idx - 1]    : Infinity;
    const gapNext  = idx < offTimes.length - 1 ? offTimes[idx + 1] - p.time   : Infinity;
    return Math.min(gapPrev, gapNext) >= 3.0;
  });
  let matched = 0;
  for (const p of isolated) {
    let best = Infinity;
    for (const q of on.peaks) best = Math.min(best, Math.abs(q.time - p.time));
    if (best <= 1.5) matched++;
  }
  const rate = isolated.length > 0 ? matched / isolated.length : 1;
  console.log(`\n  Agreement on isolated peaks: ${matched}/${isolated.length} (${(rate * 100).toFixed(1)}%)`);
  assert(isolated.length >= 30,
    `Enough isolated peaks for a meaningful check (${isolated.length} >= 30)`);
  assert(rate >= 0.70,
    `Decon agrees with detectPeaks() on >=70% of isolated peaks (got ${(rate * 100).toFixed(1)}%)`);
}

// ── 10. onsetValue matches cleanVals at onsetIndex ───────────────────────────
// Every peak's onsetValue must equal cleanVals[onsetIndex], the same curve
// the peak was measured from. A mismatch means onsetValue is being read from
// a different array (e.g. phasicOrig before the decon pipeline ran).
{
  const cleanVals = on.phasic.map(d => d.val);
  let mismatches = 0;
  for (const p of on.peaks) {
    if (Math.abs(p.onsetValue - (cleanVals[p.onsetIndex] || 0)) > 1e-9) mismatches++;
  }
  assertEq(mismatches, 0,
    'onsetValue matches cleanVals at onsetIndex for every peak on track 059');
}

// ── 11. Memorable events (percentile-based hotspot selection) ─────────────────
// Track 059 is the calibration track for the 2% percentile (see analyze()'s
// memorableEvents doc comment). Post-fix measured at 23 memorable events.
{
  const expectedCount = Math.max(1, Math.round(on.peaks.length * 0.02));
  assertEq(on.memorableEvents.length, expectedCount,
    `memorableEvents is top 2% of peaks by amplitude (expected ${expectedCount})`);
  assert(on.memorableEvents.length > 0,
    'Track 059 produces at least one memorable event');
  const allValid = on.memorableEvents.every(p => on.peaks.includes(p) && !p.excluded);
  assert(allValid, 'All memorableEvents are real, non-excluded peaks');
  let sortedOk = true;
  for (let i = 1; i < on.memorableEvents.length; i++) {
    if (on.memorableEvents[i].salienceScore > on.memorableEvents[i - 1].salienceScore) { sortedOk = false; break; }
  }
  assert(sortedOk, 'memorableEvents is sorted by descending salienceScore');
  console.log(`\n  Memorable events: ${on.memorableEvents.length}/${on.peaks.length}`);
}

// ── 12. Toggle state — no leakage between on/off runs ────────────────────────
// Running analyze() with useDeconvolution toggling off→on→off on ONE shared
// instance must reproduce an identical off-only result each time, with no
// stale driver/clean/phasicOrig state left behind.
{
  console.log('\n  Running toggle sequence (off→on→off)...');
  const tog = new GSRAnalyzer();
  tog.parseCSV(csvText);
  tog.analyze({ ...BASE_PARAMS, useDeconvolution: false });
  tog.analyze({ ...BASE_PARAMS, useDeconvolution: true  });
  tog.analyze({ ...BASE_PARAMS, useDeconvolution: false });
  assertEq(tog.phasicDriver.length, 0,
    'Toggle off clears phasicDriver on track 059');
  assertEq(tog.phasicClean.length, 0,
    'Toggle off clears phasicClean on track 059');
  assertEq(tog._phasicOrig, null,
    'Toggle off clears _phasicOrig on track 059');
  assertEq(tog.peaks.length, off.peaks.length,
    'Toggle off reproduces the exact non-deconvolution peak count');
}

// ── 13. Determinism: two independent runs give identical results ──────────────
// Guards against any mutable module-level state or PRNG-dependent behaviour
// that could make results differ between calls.
{
  console.log('\n  Running determinism check (two fresh instances)...');
  const a1 = new GSRAnalyzer(); a1.parseCSV(csvText); a1.analyze({ ...BASE_PARAMS, useDeconvolution: true });
  const a2 = new GSRAnalyzer(); a2.parseCSV(csvText); a2.analyze({ ...BASE_PARAMS, useDeconvolution: true });
  const sig1 = a1.peaks.map(p => `${p.index}:${p.amplitude.toFixed(6)}`).join(',');
  const sig2 = a2.peaks.map(p => `${p.index}:${p.amplitude.toFixed(6)}`).join(',');
  assertEq(sig1, sig2,
    'Two independent analyze(decon=true) runs on track 059 give identical peak lists');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`Track 059 deconvolution regression suite: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}`);
if (failed > 0) process.exit(1);
