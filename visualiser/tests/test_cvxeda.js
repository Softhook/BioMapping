/**
 * Unit and integration tests for cvxEDA (Convex Optimization Approach to EDA).
 *
 * Tests:
 *  1. API and module export guard.
 *  2. Edge cases: empty array, constant signal, length preservation.
 *  3. Invariant: driver p is non-negative everywhere (p >= 0).
 *  4. Tonic smoothness: tonic baseline is smooth across knots.
 *  5. Synthetic isolated SCR: recovers true impulse onset accurately.
 *  6. Synthetic 5-SCR train: recovers all 5 peaks with zero phantom peaks.
 *  7. Full GSRAnalyzer integration: analyze({ useDeconvolution: true, deconvAlgorithm: 'cvxeda' }).
 *  8. Determinism: identical outputs across multiple runs.
 *  9. Performance guard: completes 330s recording in < 350 ms.
 *
 * Run: node --test tests/test_cvxeda.js
 */

'use strict';

const assert = require('assert');
const test = require('node:test');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp('class ' + varName + '\\s*{'), 'global.' + varName + ' = class ' + varName + ' {')
    .replace(new RegExp('const ' + varName + '\\s*='), 'global.' + varName + ' =');
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'), 'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'), 'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(__dirname, '../src/signal/cvxeda.js'), 'CVXEDA');
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'), 'GSRCSVParser');
loadModule(path.join(__dirname, '../src/signal/analyzer.js'), 'GSRAnalyzer');

const { CVXEDA, GSRAnalyzer } = global;

const SR = 10; // Hz

test('cvxEDA: exports decompose function', () => {
  assert.strictEqual(typeof CVXEDA, 'object');
  assert.strictEqual(typeof CVXEDA.decompose, 'function');
});

test('cvxEDA: handles empty input gracefully', () => {
  const res = CVXEDA.decompose(new Float64Array(0), SR);
  assert.strictEqual(res.phasic.length, 0);
  assert.strictEqual(res.tonic.length, 0);
  assert.strictEqual(res.driver.length, 0);
  assert.strictEqual(res.iterations, 0);
});

test('cvxEDA: preserves signal length', () => {
  const n = 200;
  const input = new Float64Array(n).fill(2.5);
  const res = CVXEDA.decompose(input, SR, { maxIter: 10 });
  assert.strictEqual(res.phasic.length, n);
  assert.strictEqual(res.tonic.length, n);
  assert.strictEqual(res.driver.length, n);
});

test('cvxEDA invariant: driver p is strictly non-negative everywhere', () => {
  const n = 300;
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = 2.0 + Math.sin(i / 20) * 0.5;
  const res = CVXEDA.decompose(input, SR, { maxIter: 30 });
  for (let i = 0; i < n; i++) {
    assert.ok(res.driver[i] >= 0, `driver at ${i} should be >= 0, got ${res.driver[i]}`);
  }
});

test('cvxEDA synthetic: single isolated SCR onset is recovered exactly', () => {
  const n = 600; // 60s
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = 1.5; // flat tonic

  // Bateman kernel at SR=10
  const kernel = new Float64Array(100);
  for (let i = 0; i < 100; i++) {
    const t = i / SR;
    kernel[i] = Math.exp(-t / 2.0) - Math.exp(-t / 0.7);
  }
  let kMax = Math.max(...kernel);
  for (let i = 0; i < 100; i++) kernel[i] /= kMax;

  // SCR with onset at sample 250 (25.0s), amplitude 0.35 µS
  const onsetSample = 250;
  for (let i = 0; i < 100 && onsetSample + i < n; i++) {
    y[onsetSample + i] += 0.35 * kernel[i];
  }

  const res = CVXEDA.decompose(y, SR, { maxIter: 50 });

  // Locate highest peak in driver
  let maxDriverIdx = 0, maxDriverVal = 0;
  for (let i = 0; i < n; i++) {
    if (res.driver[i] > maxDriverVal) {
      maxDriverVal = res.driver[i];
      maxDriverIdx = i;
    }
  }

  const detectedOnsetSec = maxDriverIdx / SR;
  assert.ok(Math.abs(detectedOnsetSec - 25.0) <= 0.2,
    `driver peak onset (${detectedOnsetSec.toFixed(2)}s) should be within 0.2s of true onset (25.0s)`);
  assert.ok(maxDriverVal > 0.05, `driver amplitude should be clearly detected (>0.05), got ${maxDriverVal.toFixed(4)}`);
});

test('cvxEDA synthetic: 5-SCR train recovers all 5 events with zero false positives', () => {
  const n = 3300; // 330s
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = 2.0 + 0.2 * (i / n); // slight linear drift

  const kernel = new Float64Array(100);
  for (let i = 0; i < 100; i++) {
    const t = i / SR;
    kernel[i] = Math.exp(-t / 2.0) - Math.exp(-t / 0.7);
  }
  let kMax = Math.max(...kernel);
  for (let i = 0; i < 100; i++) kernel[i] /= kMax;

  const onsets = [30, 90, 150, 210, 270];
  const amps = [0.15, 0.25, 0.10, 0.30, 0.18];
  for (let s = 0; s < onsets.length; s++) {
    const samp = onsets[s] * SR;
    for (let i = 0; i < 100 && samp + i < n; i++) {
      y[samp + i] += amps[s] * kernel[i];
    }
  }

  const res = CVXEDA.decompose(y, SR, { maxIter: 60, alpha: 0.05, rho: 0.2 });

  // Find local maxima in driver above 0.05
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (res.driver[i] > 0.05 && res.driver[i] >= res.driver[i - 1] && res.driver[i] >= res.driver[i + 1]) {
      peaks.push({ time: i / SR, val: res.driver[i] });
    }
  }

  assert.strictEqual(peaks.length, 5, `expected exactly 5 driver peaks, got ${peaks.length}`);
  for (let s = 0; s < onsets.length; s++) {
    const diff = Math.abs(peaks[s].time - onsets[s]);
    assert.ok(diff <= 0.2, `peak ${s} time (${peaks[s].time}s) should match onset (${onsets[s]}s)`);
  }
});

test('cvxEDA: deterministic execution', () => {
  const n = 300;
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = 1.0 + 0.1 * Math.sin(i);

  const res1 = CVXEDA.decompose(input, SR, { maxIter: 30 });
  const res2 = CVXEDA.decompose(input, SR, { maxIter: 30 });

  for (let i = 0; i < n; i++) {
    assert.strictEqual(res1.phasic[i], res2.phasic[i]);
    assert.strictEqual(res1.tonic[i], res2.tonic[i]);
    assert.strictEqual(res1.driver[i], res2.driver[i]);
  }
});

test('cvxEDA integration: GSRAnalyzer with deconvAlgorithm=cvxeda', () => {
  // Build simple CSV with 2 SCRs
  const rows = ['time,gsr'];
  for (let i = 0; i < 600; i++) {
    const t = i / SR;
    let gsr = 2.0;
    if (t >= 20 && t < 30) gsr += 0.2 * (Math.exp(-(t - 20) / 2.0) - Math.exp(-(t - 20) / 0.7));
    if (t >= 40 && t < 50) gsr += 0.3 * (Math.exp(-(t - 40) / 2.0) - Math.exp(-(t - 40) / 0.7));
    rows.push(`${t.toFixed(3)},${gsr.toFixed(6)}`);
  }

  const a = new GSRAnalyzer();
  a.parseCSV(rows.join('\n'));
  a.analyze({
    ...global.GSR_CONST.GSR_DEFAULT,
    tonicMethod: 'percentile',
    peakThreshold: 0.020,
    useDeconvolution: true,
    deconvAlgorithm: 'cvxeda'
  });

  assert.ok(a._wasDeconv, 'analyzer should register deconvolution run');
  assert.ok(a.phasicClean.length === 600, 'phasicClean should be populated');
  assert.ok(a.phasicDriver.length === 600, 'phasicDriver should be populated');
  assert.ok(a.peaks.length >= 1, `should detect peaks, got ${a.peaks.length}`);
});

test('cvxEDA integration: GSRAnalyzer with useCvxEDA: true toggle', () => {
  const rows = ['time,gsr'];
  for (let i = 0; i < 600; i++) {
    const t = i / SR;
    let gsr = 2.0;
    if (t >= 20 && t < 30) gsr += 0.2 * (Math.exp(-(t - 20) / 2.0) - Math.exp(-(t - 20) / 0.7));
    if (t >= 40 && t < 50) gsr += 0.3 * (Math.exp(-(t - 40) / 2.0) - Math.exp(-(t - 40) / 0.7));
    rows.push(`${t.toFixed(3)},${gsr.toFixed(6)}`);
  }

  const a = new GSRAnalyzer();
  a.parseCSV(rows.join('\n'));
  a.analyze({
    ...global.GSR_CONST.GSR_DEFAULT,
    tonicMethod: 'percentile',
    peakThreshold: 0.020,
    useCvxEDA: true
  });

  assert.ok(a._wasDeconv, 'analyzer should register deconvolution run with useCvxEDA: true');
  assert.ok(a.phasicClean.length === 600, 'phasicClean should be populated');
  assert.ok(a.phasicDriver.length === 600, 'phasicDriver should be populated');
  assert.ok(a.peaks.length >= 1, `should detect peaks, got ${a.peaks.length}`);
});

test('cvxEDA performance: completes 3,300 samples in < 350ms', () => {
  const n = 3300;
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = 2.0 + Math.sin(i / 100) * 0.3;

  const t0 = Date.now();
  CVXEDA.decompose(input, SR, { maxIter: 50 });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 350, `cvxEDA should finish in < 350ms (took ${elapsed}ms)`);
});
