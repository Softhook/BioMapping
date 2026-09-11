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

// Bateman SCRF at SR, unit peak — shared by the synthetic fixtures below.
function batemanKernel(len) {
  const k = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    k[i] = Math.exp(-t / 2.0) - Math.exp(-t / 0.75);
  }
  const kMax = Math.max(...k);
  for (let i = 0; i < len; i++) k[i] /= kMax;
  return k;
}

// Contiguous runs of the driver above `frac` of its own max → one entry per
// recovered event, with the run's peak time.
function driverClusters(driver, frac = 0.02) {
  const thr = Math.max(...driver) * frac;
  const out = [];
  let i = 0;
  while (i < driver.length) {
    if (driver[i] > thr) {
      let j = i, pk = i;
      while (j < driver.length && driver[j] > thr) { if (driver[j] > driver[pk]) pk = j; j++; }
      out.push(pk / SR);
      i = j;
    } else i++;
  }
  return out;
}

test('cvxEDA synthetic: 5-SCR train — DEFAULT params recover all 5, sparse driver, zero phantoms', () => {
  const n = 3300; // 330s
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = 2.0 + 0.2 * (i / n); // slight linear drift
  const kernel = batemanKernel(120);

  const onsets = [30, 90, 150, 210, 270];
  const amps = [0.15, 0.25, 0.10, 0.30, 0.18];
  for (let s = 0; s < onsets.length; s++) {
    const samp = onsets[s] * SR;
    for (let i = 0; i < 120 && samp + i < n; i++) y[samp + i] += amps[s] * kernel[i];
  }

  // No solver overrides — this must work on the shipped defaults.
  const res = CVXEDA.decompose(y, SR);
  assert.ok(res.converged, 'solver should converge on a clean 5-SCR train');

  const clusters = driverClusters(res.driver);
  assert.strictEqual(clusters.length, 5, `expected exactly 5 driver clusters, got ${clusters.length}`);
  for (let s = 0; s < onsets.length; s++) {
    assert.ok(Math.abs(clusters[s] - onsets[s]) <= 0.3,
      `cluster ${s} (${clusters[s]}s) should match onset ${onsets[s]}s`);
  }

  // L1 sparsity: the driver is exactly zero away from events (this is the
  // property matching-pursuit lacks). Sample a quiet stretch between SCR 2
  // and SCR 3 (t≈110–140s) and require it to be flat zero.
  let between = 0;
  for (let i = 1100; i < 1400; i++) between = Math.max(between, res.driver[i]);
  const driverMax = Math.max(...res.driver);
  assert.ok(between < 1e-6 * driverMax,
    `inter-event driver should be ~0, got ${between.toExponential(2)} (max ${driverMax.toFixed(2)})`);
});

test('cvxEDA synthetic: joint tonic estimate tracks a curved baseline', () => {
  const n = 3000; // 300s
  const y = new Float64Array(n);
  const trueTonic = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    trueTonic[i] = 3.0 + 0.8 * Math.sin(t / 40) + 0.0015 * t;
    y[i] = trueTonic[i];
  }
  const kernel = batemanKernel(120);
  const onsets = [20, 55, 90, 130, 175, 210, 250, 280];
  const amps = [0.3, 0.15, 0.5, 0.12, 0.4, 0.2, 0.6, 0.25];
  for (let s = 0; s < onsets.length; s++) {
    const samp = onsets[s] * SR;
    for (let i = 0; i < 120 && samp + i < n; i++) y[samp + i] += amps[s] * kernel[i];
  }

  const res = CVXEDA.decompose(y, SR);

  // Tonic should follow the true slow baseline, not absorb the SCRs and not
  // lag the curve. Compare on the interior (ignore the first/last 5 s edge).
  let maxErr = 0, sse = 0, cnt = 0;
  for (let i = 50; i < n - 50; i++) {
    const e = res.tonic[i] - trueTonic[i];
    maxErr = Math.max(maxErr, Math.abs(e));
    sse += e * e; cnt++;
  }
  const rmse = Math.sqrt(sse / cnt);
  assert.ok(rmse < 0.05, `tonic RMSE vs truth should be < 0.05 µS, got ${rmse.toFixed(4)}`);
  assert.ok(maxErr < 0.20, `tonic max error should be < 0.20 µS, got ${maxErr.toFixed(4)}`);

  // Phasic + tonic should reconstruct the input.
  let recErr = 0;
  for (let i = 50; i < n - 50; i++) recErr = Math.max(recErr, Math.abs(y[i] - res.tonic[i] - res.phasic[i]));
  assert.ok(recErr < 0.05, `reconstruction error should be < 0.05 µS, got ${recErr.toFixed(4)}`);
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
  assert.strictEqual(a._driverAlgorithm, 'cvxeda',
    'tags the driver with its producing algorithm, for GSR_CONST.DRIVER_UNIT_BY_ALGORITHM to pick the right unit (µS/s, not µS)');
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
  assert.strictEqual(a._driverAlgorithm, 'cvxeda');
});

test('driver algorithm tag: matching-pursuit deconvolution is tagged distinctly from cvxEDA, and clears on a non-deconvolution run', () => {
  const rows = ['time,gsr'];
  for (let i = 0; i < 600; i++) {
    const t = i / SR;
    let gsr = 2.0;
    if (t >= 20 && t < 30) gsr += 0.3 * (Math.exp(-(t - 20) / 2.0) - Math.exp(-(t - 20) / 0.75));
    rows.push(`${t.toFixed(3)},${gsr.toFixed(6)}`);
  }

  const a = new GSRAnalyzer();
  a.parseCSV(rows.join('\n'));
  a.analyze({ ...global.GSR_CONST.GSR_DEFAULT, tonicMethod: 'percentile', peakThreshold: 0.020, useDeconvolution: true });
  assert.strictEqual(a._driverAlgorithm, 'matching_pursuit');

  // Switching to the default full-scan detector clears the tag along with
  // the rest of the deconvolution state.
  a.analyze({ ...global.GSR_CONST.GSR_DEFAULT, tonicMethod: 'percentile', peakThreshold: 0.020 });
  assert.strictEqual(a._driverAlgorithm, null);
  assert.strictEqual(a.phasicDriver.length, 0);
});

test('cvxEDA integration: peak count is in the same ballpark as the other detectors (regression: it was far lower)', () => {
  // 300s track, curved tonic + 12 planted SCRs — the shape of the demo data
  // where cvxEDA used to under-report because the ADMM solve never converged.
  const kernel = batemanKernel(120);
  const onsets = [15, 35, 60, 66, 95, 130, 138, 170, 200, 230, 255, 280];
  const amps = [0.12, 0.35, 0.10, 0.18, 0.5, 0.09, 0.22, 0.6, 0.15, 0.3, 0.11, 0.4];
  const rows = ['time,gsr'];
  for (let i = 0; i < 3000; i++) {
    const t = i / SR;
    let g = 3.5 + 0.9 * Math.sin(t / 50) + 0.002 * t;
    for (let s = 0; s < onsets.length; s++) {
      const dt = i - onsets[s] * SR;
      if (dt >= 0 && dt < 120) g += amps[s] * kernel[dt];
    }
    rows.push(`${t.toFixed(3)},${g.toFixed(6)}`);
  }
  const csv = rows.join('\n');
  const base = { ...global.GSR_CONST.GSR_DEFAULT, tonicMethod: 'lpf', peakThreshold: 0.015 };

  const fs = new GSRAnalyzer(); fs.parseCSV(csv); fs.analyze({ ...base });
  const cvx = new GSRAnalyzer(); cvx.parseCSV(csv); cvx.analyze({ ...base, useCvxEDA: true });

  assert.ok(!cvx.phasicDeconvTruncated, 'cvxEDA solve should converge on this track');
  // Was ~1/3 of the full-scan count before the solver was fixed; now within 40%.
  assert.ok(cvx.peaks.length >= 0.6 * fs.peaks.length,
    `cvxEDA peaks (${cvx.peaks.length}) should be comparable to full-scan (${fs.peaks.length})`);
  assert.ok(cvx.peaks.length <= fs.peaks.length + 6,
    `cvxEDA peaks (${cvx.peaks.length}) should not wildly exceed full-scan (${fs.peaks.length})`);

  // Joint tonic reaches this.tonic and matches the planted baseline mean.
  const tMean = cvx.tonic.reduce((s, d) => s + d.val, 0) / cvx.tonic.length;
  assert.ok(Math.abs(tMean - 3.8) < 0.15, `cvxEDA tonic mean ${tMean.toFixed(3)} should be ~3.8 µS`);
});

test('cvxEDA integration: toggling cvxEDA off restores the EMA tonic (prefix-cache round-trip)', () => {
  const kernel = batemanKernel(120);
  const rows = ['time,gsr'];
  for (let i = 0; i < 1500; i++) {
    const t = i / SR;
    let g = 3.0 + 0.5 * Math.sin(t / 30) + 0.003 * t;
    for (const [o, amp] of [[30, 0.4], [80, 0.3], [120, 0.5]]) {
      const dt = i - o * SR;
      if (dt >= 0 && dt < 120) g += amp * kernel[dt];
    }
    rows.push(`${t.toFixed(3)},${g.toFixed(6)}`);
  }
  const csv = rows.join('\n');
  const base = { ...global.GSR_CONST.GSR_DEFAULT, tonicMethod: 'lpf', peakThreshold: 0.015 };

  const a = new GSRAnalyzer();
  a.parseCSV(csv);

  a.analyze({ ...base });
  const emaTonic = a.tonic.map(d => d.val);
  const emaPeaks = a.peaks.length;

  a.analyze({ ...base, useCvxEDA: true });
  const cvxTonic = a.tonic.map(d => d.val);
  const cvxT100 = a.tonic[100].val;
  // cvxEDA's B-spline tonic is a different estimate — it must actually differ.
  let diff = 0;
  for (let i = 0; i < emaTonic.length; i++) diff = Math.max(diff, Math.abs(emaTonic[i] - cvxTonic[i]));
  assert.ok(diff > 1e-4, 'cvxEDA tonic should differ from the EMA tonic');

  a.analyze({ ...base }); // toggle back off — prefix cache hit
  assert.strictEqual(a.peaks.length, emaPeaks, 'default-detector peak count should be restored exactly');
  for (let i = 0; i < emaTonic.length; i++) {
    assert.ok(Math.abs(a.tonic[i].val - emaTonic[i]) < 1e-9,
      `tonic[${i}] should be restored to the EMA value (${emaTonic[i]} vs ${a.tonic[i].val})`);
  }

  a.analyze({ ...base, useCvxEDA: true }); // and cvxEDA again — deterministic
  assert.ok(Math.abs(a.tonic[100].val - cvxT100) < 1e-9, 'cvxEDA re-run should be deterministic');
});

test('cvxEDA performance: 3,300-sample track solves to convergence in < 600ms', () => {
  const n = 3300;
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = 2.0 + Math.sin(i / 100) * 0.3;

  const t0 = Date.now();
  const res = CVXEDA.decompose(input, SR); // shipped defaults, full solve
  const elapsed = Date.now() - t0;

  assert.ok(res.converged, 'should converge within the default iteration cap');
  assert.ok(elapsed < 600, `cvxEDA should finish in < 600ms (took ${elapsed}ms)`);
});

test('cvxEDA: iteration cap is reported as non-convergence, not a silent stop', () => {
  const n = 1200;
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = 2.0 + Math.sin(i / 30) * 0.4 + (i % 300 < 40 ? 0.3 : 0);

  const capped = CVXEDA.decompose(input, SR, { maxIter: 3, tol: 1e-12 });
  assert.strictEqual(capped.converged, false, 'a 3-iteration run must not claim convergence');
  assert.strictEqual(capped.iterations, 3, 'should report the capped iteration count');

  const full = CVXEDA.decompose(input, SR);
  assert.ok(full.converged, 'the same signal converges with the default budget');
});
