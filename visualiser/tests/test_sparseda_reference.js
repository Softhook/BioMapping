'use strict';

const assert = require('assert');
const test = require('node:test');
const path = require('path');
const fs = require('fs');

const SCRDeconvolution = require('../src/signal/deconvolution.js');

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sparseda_reference.json'), 'utf8'));

function relRMSE(a, b) {
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    num += d * d;
    den += b[i] * b[i];
  }
  return Math.sqrt(num / Math.max(den, 1e-30));
}

test('SparsEDA matches the reference implementation on an 8 Hz fixture', () => {
  const res = SCRDeconvolution.deconvolve(Float64Array.from(ref.signal), ref.sr, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 1.0,
    dminSec: 1.25,
    rho: 0.025,
    tauSlow: 2.0,
    tauFast: 0.75,
    kernelSec: 10.0
  });

  assert.ok(res.converged, 'reference fixture should converge');
  assert.strictEqual(res.applyRescale, false, 'reference SparsEDA path should not use matching-pursuit rescaling');

  const driverErr = relRMSE(res.driver, ref.driver);
  const tonicErr = relRMSE(res.tonic, ref.tonic);
  const mseErr = relRMSE(res.mse, ref.mse);

  assert.ok(driverErr < 1e-10, `driver relRMSE should be < 1e-10, got ${driverErr.toExponential(2)}`);
  assert.ok(tonicErr < 1e-10, `tonic relRMSE should be < 1e-10, got ${tonicErr.toExponential(2)}`);
  assert.ok(mseErr < 1e-10, `mse relRMSE should be < 1e-10, got ${mseErr.toExponential(2)}`);

  const refNonzero = ref.driver.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  const jsNonzero = Array.from(res.driver).reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
  assert.strictEqual(jsNonzero, refNonzero, 'driver sparsity pattern should match the reference');
});

test('SparsEDA keeps original array length when internally resampling 10 Hz input to the 8 Hz reference rate', () => {
  const n = 1200;
  const sr = 10;
  const t = new Float64Array(n);
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i / sr;
    signal[i] = 2.0 + 0.08 * Math.sin(t[i] / 12);
  }
  const kernel = SCRDeconvolution.buildSCRFKernel(sr, 2.0, 0.75, 10.0);
  const driver = new Float64Array(n);
  driver[120] = 0.25;
  driver[420] = 0.18;
  driver[760] = 0.22;
  const phasic = SCRDeconvolution.convolve(driver, kernel);
  for (let i = 0; i < n; i++) signal[i] += phasic[i];

  const res = SCRDeconvolution.deconvolve(signal, sr, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 1.0,
    dminSec: 1.25,
    rho: 0.025,
    tauSlow: 2.0,
    tauFast: 0.75,
    kernelSec: 10.0
  });

  assert.strictEqual(res.driver.length, n);
  assert.strictEqual(res.clean.length, n);
  assert.strictEqual(res.tonic.length, n);
  assert.ok(Array.from(res.driver).some(v => v > 0), 'resampled 10 Hz input should still produce sparse driver events');
});
