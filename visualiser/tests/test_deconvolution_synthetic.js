/**
 * Synthetic ground-truth tests for the deconvolution pipeline.
 *
 * The core problem with testing deconvolution on real walking tracks is that
 * we don't know the true answer — we only know what other detectors say, which
 * is the thing we're trying to improve on. Synthetic data solves this:
 *
 *   1. We generate a clean EDA signal by convolving N impulses at KNOWN times
 *      with the Bateman SCRF kernel (the same kernel deconvolution uses).
 *   2. We add a flat tonic baseline and optionally small noise.
 *   3. We run the full GSRAnalyzer in deconvolution mode.
 *   4. We check that it recovers the correct number of peaks at approximately
 *      the correct positions (within a ±kernel_peak_offset tolerance).
 *
 * This gives us a test where we KNOW the right answer without relying on
 * agreement with other detectors or visual inspection.
 *
 * Run: node --test tests/test_deconvolution_synthetic.js
 */

'use strict';

const assert = require('assert');
const test = require('node:test');
const path = require('path');
const vm = require('vm');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const fs = require('fs');
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp('class ' + varName + '\\s*{'), 'global.' + varName + ' = class ' + varName + ' {')
    .replace(new RegExp('const ' + varName + '\\s*='), 'global.' + varName + ' =');
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'), 'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'), 'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'), 'GSRCSVParser');
loadModule(path.join(__dirname, '../src/signal/analyzer.js'), 'GSRAnalyzer');
const { GSRAnalyzer } = global;

const SR = 10;

// ─── Synthetic signal builder ───────────────────────────────────────────────

function buildSyntheticCSV(scrs, durationSec, tonicLevel, noiseSd) {
  if (tonicLevel === undefined) tonicLevel = 2.0;
  if (noiseSd === undefined) noiseSd = 0;

  const n = Math.round(durationSec * SR);
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);

  let kPeakIdx = 0;
  for (let i = 1; i < kernel.length; i++) if (kernel[i] > kernel[kPeakIdx]) kPeakIdx = i;

  const phasic = new Float64Array(n);
  for (let s = 0; s < scrs.length; s++) {
    const onsetSample = Math.round(scrs[s].onsetSec * SR);
    const amp = scrs[s].amplitude;
    for (let k = 0; k < kernel.length && onsetSample + k < n; k++) {
      phasic[onsetSample + k] += amp * kernel[k];
    }
  }

  // Deterministic xorshift32 noise.
  let rng = 0xdeadbeef;
  function nextRand() {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return (rng >>> 0) / 0xffffffff - 0.5;
  }

  const rows = ['time,gsr'];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const noise = noiseSd > 0 ? noiseSd * nextRand() : 0;
    rows.push(t.toFixed(3) + ',' + (tonicLevel + phasic[i] + noise).toFixed(6));
  }

  const kPeakSec = kPeakIdx / SR;
  const truePeakTimes = scrs.map(function(s) { return s.onsetSec + kPeakSec; });

  return { csvText: rows.join('\n'), truePeakTimes: truePeakTimes };
}

function analyzeDeconv(csvText, extra) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  const params = Object.assign({}, global.GSR_CONST.GSR_DEFAULT, {
    tonicMethod: 'percentile', tonicWindow: 15,
    peakThreshold: 0.020, minPeakQuality: 0.0, shapeMinSnr: 0,
    useDeconvolution: true
  }, extra || {});
  a.analyze(params);
  return a;
}

function analyzeBaseline(csvText, extra) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  const params = Object.assign({}, global.GSR_CONST.GSR_DEFAULT, {
    tonicMethod: 'percentile', tonicWindow: 15,
    peakThreshold: 0.020, minPeakQuality: 0.0, shapeMinSnr: 0,
    useDeconvolution: false
  }, extra || {});
  a.analyze(params);
  return a;
}

// ─── Isolated SCR tests ────────────────────────────────────────────────────

test('synthetic: single isolated SCR is recovered (count = 1)', function() {
  const b = buildSyntheticCSV([{ onsetSec: 30, amplitude: 0.2 }], 90);
  const a = analyzeDeconv(b.csvText);
  assert.strictEqual(a.peaks.length, 1, 'expected exactly 1 peak, got ' + a.peaks.length);
  const diff = Math.abs(a.peaks[0].time - b.truePeakTimes[0]);
  assert.ok(diff <= 2.0, 'peak time ' + a.peaks[0].time.toFixed(2) + 's should be within 2s of true apex ' + b.truePeakTimes[0].toFixed(2) + 's');
});

test('synthetic: five well-isolated SCRs are all recovered', function() {
  const scrs = [
    { onsetSec: 30, amplitude: 0.15 },
    { onsetSec: 90, amplitude: 0.25 },
    { onsetSec: 150, amplitude: 0.10 },
    { onsetSec: 210, amplitude: 0.30 },
    { onsetSec: 270, amplitude: 0.18 },
  ];
  const b = buildSyntheticCSV(scrs, 330);
  const a = analyzeDeconv(b.csvText);
  assert.strictEqual(a.peaks.length, scrs.length, 'expected ' + scrs.length + ' peaks, got ' + a.peaks.length);

  let matched = 0;
  for (let i = 0; i < b.truePeakTimes.length; i++) {
    let closest = Infinity;
    for (let j = 0; j < a.peaks.length; j++) closest = Math.min(closest, Math.abs(a.peaks[j].time - b.truePeakTimes[i]));
    if (closest <= 2.0) matched++;
  }
  assert.strictEqual(matched, scrs.length, 'all true peaks should be matched within ±2s (matched ' + matched + '/' + scrs.length + ')');
});

test('synthetic: peak dots sit exactly on phasicClean (alignment fix)', function() {
  const b = buildSyntheticCSV([{ onsetSec: 20, amplitude: 0.20 }, { onsetSec: 60, amplitude: 0.15 }], 100);
  const a = analyzeDeconv(b.csvText);
  assert.ok(a.peaks.length > 0, 'should find at least one peak');

  const cleanVals = a.phasic.map(function(d) { return d.val; });
  let maxDiff = 0;
  for (let i = 0; i < a.peaks.length; i++) {
    const diff = Math.abs(a.peaks[i].value - (cleanVals[a.peaks[i].index] || 0));
    if (diff > maxDiff) maxDiff = diff;
  }
  assert.ok(maxDiff < 1e-9, 'peak.value must exactly match phasicClean at peak.index (max diff = ' + maxDiff.toExponential(2) + ')');
});

test('synthetic: onsetValue matches phasicClean at onsetIndex', function() {
  const b = buildSyntheticCSV([{ onsetSec: 25, amplitude: 0.18 }, { onsetSec: 70, amplitude: 0.22 }], 120);
  const a = analyzeDeconv(b.csvText);
  const cleanVals = a.phasic.map(function(d) { return d.val; });
  let mismatches = 0;
  for (let i = 0; i < a.peaks.length; i++) {
    if (Math.abs(a.peaks[i].onsetValue - (cleanVals[a.peaks[i].onsetIndex] || 0)) > 1e-9) mismatches++;
  }
  assert.strictEqual(mismatches, 0, 'onsetValue must match phasicClean at onsetIndex for all peaks (' + mismatches + ' mismatches)');
});

test('synthetic: all peaks respect peakThreshold', function() {
  const threshold = 0.020;
  const b = buildSyntheticCSV([{ onsetSec: 20, amplitude: 0.15 }, { onsetSec: 70, amplitude: 0.08 }], 120);
  const a = analyzeDeconv(b.csvText, { peakThreshold: threshold });
  const violations = a.peaks.filter(function(p) { return p.amplitude < threshold; });
  assert.strictEqual(violations.length, 0, violations.length + ' peaks below threshold ' + threshold);
});

test('synthetic: no two peaks closer than minImpulseGapSec', function() {
  const b = buildSyntheticCSV([
    { onsetSec: 30, amplitude: 0.2 },
    { onsetSec: 60, amplitude: 0.15 },
    { onsetSec: 90, amplitude: 0.18 }
  ], 130);
  const a = analyzeDeconv(b.csvText);
  const minGap = global.GSR_CONST.SCRF.minImpulseGapSec;
  const times = a.peaks.map(function(p) { return p.time; }).sort(function(x, y) { return x - y; });
  let minActualGap = Infinity;
  for (let i = 1; i < times.length; i++) minActualGap = Math.min(minActualGap, times[i] - times[i - 1]);
  assert.ok(times.length < 2 || minActualGap >= minGap - 1e-9,
    'min gap = ' + minActualGap.toFixed(3) + 's, must be >= ' + minGap + 's');
});

test('synthetic: phasicClean is non-negative everywhere', function() {
  const b = buildSyntheticCSV([
    { onsetSec: 20, amplitude: 0.15 },
    { onsetSec: 22, amplitude: 0.20 },
    { onsetSec: 60, amplitude: 0.10 }
  ], 100);
  const a = analyzeDeconv(b.csvText);
  const negVals = a.phasicClean.filter(function(d) { return d.val < -1e-9; });
  assert.strictEqual(negVals.length, 0,
    negVals.length + ' negative phasicClean samples (min=' + Math.min.apply(null, a.phasicClean.map(function(d) { return d.val; })).toFixed(6) + ')');
});

test('synthetic: deconvolution is deterministic', function() {
  const b = buildSyntheticCSV([{ onsetSec: 25, amplitude: 0.20 }, { onsetSec: 75, amplitude: 0.15 }], 120);
  const a1 = analyzeDeconv(b.csvText);
  const a2 = analyzeDeconv(b.csvText);
  assert.strictEqual(a1.peaks.length, a2.peaks.length, 'same peak count on two runs');
  for (let i = 0; i < a1.peaks.length; i++) {
    assert.strictEqual(a1.peaks[i].time, a2.peaks[i].time, 'peak[' + i + '].time differs between runs');
    assert.strictEqual(a1.peaks[i].amplitude, a2.peaks[i].amplitude, 'peak[' + i + '].amplitude differs between runs');
  }
});

// ─── Overlapping SCR tests ──────────────────────────────────────────────────

test('synthetic: single broad SCR does not produce multiple phantom peaks', function() {
  // The key regression test for Option B: one SCR should not ripple-tile into
  // 3-4 phantom peaks in the driver.
  const b = buildSyntheticCSV([{ onsetSec: 40, amplitude: 0.30 }], 120);
  const a = analyzeDeconv(b.csvText);
  assert.ok(a.peaks.length <= 2, 'a single synthetic SCR should produce at most 2 peaks in deconv mode, got ' + a.peaks.length);
});

test('synthetic: two SCRs 5s apart — deconvolution finds >= as many as baseline', function() {
  // 5s ISI: second SCR starts while first kernel is still decaying (~30% amplitude).
  // Deconvolution should find at least as many as the naive detector.
  const scrs = [{ onsetSec: 30, amplitude: 0.20 }, { onsetSec: 35, amplitude: 0.18 }];
  const b = buildSyntheticCSV(scrs, 90);
  const deconv = analyzeDeconv(b.csvText);
  const baseline = analyzeBaseline(b.csvText);
  assert.ok(deconv.peaks.length >= 1, 'deconvolution should find at least 1 peak');
  assert.ok(deconv.peaks.length >= baseline.peaks.length,
    'deconvolution (' + deconv.peaks.length + ') should find >= peaks than baseline (' + baseline.peaks.length + ')');
});

test('synthetic: noiseless single SCR — exactly 1 peak within 1.5s of true apex', function() {
  const b = buildSyntheticCSV([{ onsetSec: 50, amplitude: 0.25 }], 150);
  const a = analyzeDeconv(b.csvText);
  assert.strictEqual(a.peaks.length, 1, 'noiseless single SCR must produce exactly 1 peak, got ' + a.peaks.length);
  const diff = Math.abs(a.peaks[0].time - b.truePeakTimes[0]);
  assert.ok(diff <= 1.5, 'peak time ' + a.peaks[0].time.toFixed(2) + 's should be within 1.5s of true apex ' + b.truePeakTimes[0].toFixed(2) + 's');
});
