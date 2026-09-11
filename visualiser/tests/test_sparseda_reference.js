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

test('SparsEDA matches the reference implementation on an 8 Hz fixture with solver-aligned parameters', () => {
  const res = SCRDeconvolution.deconvolve(Float64Array.from(ref.signal), ref.sr, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 0.01,
    dminSec: 1.25,
    rho: 0.025,
    tauSlow: 2.0,
    tauFast: 0.5,
    kernelSec: 10.0
  });

  assert.strictEqual(typeof res.converged, 'boolean');
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
    epsilon: 0.01,
    dminSec: 1.25,
    rho: 0.025,
  });

  assert.strictEqual(res.driver.length, n);
  assert.strictEqual(res.clean.length, n);
  assert.strictEqual(res.tonic.length, n);
  assert.ok(Array.from(res.driver).some(v => v > 0), 'resampled 10 Hz input should still produce sparse driver events');
});

test('SparsEDA also round-trips 4 Hz input through the fixed 8 Hz solver rate', () => {
  const n = 480;
  const sr = 4;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = 2.0 + 0.05 * Math.sin(i / 9);
  signal[80] += 0.30;
  signal[240] += 0.20;

  const res = SCRDeconvolution.deconvolve(signal, sr, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 0.01,
    dminSec: 1.25,
    rho: 0.025
  });

  assert.strictEqual(res.driver.length, n);
  assert.strictEqual(res.clean.length, n);
  assert.strictEqual(res.tonic.length, n);
});

test('SparsEDA treats a positive flat signal as a zero-driver solution', () => {
  const signal = new Float64Array(640);
  signal.fill(2.0);

  const res = SCRDeconvolution.deconvolve(signal, 8, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 1.0,
    dminSec: 1.25,
    rho: 0.025
  });

  assert.ok(res.converged, 'flat signal should terminate cleanly');
  assert.strictEqual(res.iterations, 0, 'flat signal should not activate the dictionary');
  assert.ok(Array.from(res.driver).every(v => v === 0), 'flat signal should produce no sparse driver');
});

test('One-sample SparsEDA input returns algorithm-consistent tonic output', () => {
  const res = SCRDeconvolution.deconvolve(Float64Array.of(2.5), 10, {
    algorithm: 'sparseda'
  });

  assert.strictEqual(res.driver.length, 1);
  assert.strictEqual(res.clean.length, 1);
  assert.strictEqual(res.tonic.length, 1);
  assert.strictEqual(res.driver[0], 0);
  assert.strictEqual(res.clean[0], 0);
  assert.strictEqual(res.tonic[0], 2.5);
  assert.strictEqual(res.applyRescale, false);
});

test('SparsEDA pruning keeps clean consistent with the kept driver', () => {
  const res = SCRDeconvolution.deconvolve(Float64Array.from(ref.signal), ref.sr, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 0.01,
    dminSec: 1.25,
    rho: 2.0,
    tauSlow: 2.0,
    tauFast: 0.5,
    kernelSec: 10.0
  });

  const nonzeroDriver = Array.from(res.driver).filter(v => v > 0).length;
  const maxClean = Math.max(...Array.from(res.clean));
  assert.strictEqual(nonzeroDriver, 0, 'sanity check: rho=2 should prune every driver event');
  assert.strictEqual(maxClean, 0, 'clean reconstruction should also drop to zero when no driver event is kept');
});

test('SparsEDA epsilon remains an active stop threshold', () => {
  const strict = SCRDeconvolution.deconvolve(Float64Array.from(ref.signal), ref.sr, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 0.01,
    dminSec: 1.25,
    rho: 0.025,
    tauSlow: 2.0,
    tauFast: 0.5,
    kernelSec: 10.0
  });
  const loose = SCRDeconvolution.deconvolve(Float64Array.from(ref.signal), ref.sr, {
    algorithm: 'sparseda',
    maxIter: 40,
    epsilon: 1e6,
    dminSec: 1.25,
    rho: 0.025,
    tauSlow: 2.0,
    tauFast: 0.5,
    kernelSec: 10.0
  });

  assert.ok(loose.iterations < strict.iterations, `looser epsilon should stop earlier (${loose.iterations} < ${strict.iterations})`);
});
