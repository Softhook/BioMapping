/**
 * Unit tests for deconvolution.js (SCRDeconvolution) — Benedek & Kaernbach
 * nonnegative matching-pursuit deconvolution of the phasic skin-conductance
 * signal, independent of the analyzer pipeline.
 *
 * The pipeline-level suites (test_deconvolution_053.js, test_deconvolution_059.js,
 * test_all_pipelines.js) already exercise this module indirectly through
 * GSRAnalyzer.analyze({ useDeconvolution: true }) on real tracks; this file
 * covers each exported function directly with synthetic signals whose true
 * driver positions/amplitudes are known in advance, plus edge cases (empty
 * signal, all-zero signal, single sample, boundary-clamped onsets) that real
 * tracks never isolate cleanly.
 *
 * Run: node --test tests/test_deconvolution.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const SCRDeconvolution = require('../deconvolution.js');

const SR = 10; // Hz, matches the project's standard GSR sample rate

// ═════════════════════════════════════════════════════════════════════════
// buildSCRFKernel()
// ═════════════════════════════════════════════════════════════════════════

test('buildSCRFKernel: length matches ceil(kernelSec * sampleRate)', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 5.0);
  assert.strictEqual(kernel.length, Math.ceil(5.0 * SR));
});

test('buildSCRFKernel: starts at zero (SCRF(0) = e^0 - e^0 = 0)', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  assert.ok(Math.abs(kernel[0]) < 1e-12);
});

test('buildSCRFKernel: is normalised so the peak value is exactly 1.0', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  let max = -Infinity;
  for (const v of kernel) if (v > max) max = v;
  assert.ok(Math.abs(max - 1.0) < 1e-12);
});

test('buildSCRFKernel: rises to a single peak then monotonically decays (bi-exponential shape)', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  let peakIdx = 0;
  for (let i = 1; i < kernel.length; i++) if (kernel[i] > kernel[peakIdx]) peakIdx = i;

  for (let i = 1; i <= peakIdx; i++) {
    assert.ok(kernel[i] >= kernel[i - 1] - 1e-12, `kernel should rise monotonically up to the peak at ${i}`);
  }
  for (let i = peakIdx + 1; i < kernel.length; i++) {
    assert.ok(kernel[i] <= kernel[i - 1] + 1e-12, `kernel should decay monotonically after the peak at ${i}`);
  }
});

test('buildSCRFKernel: returns a Float64Array', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  assert.ok(kernel instanceof Float64Array);
});

test('buildSCRFKernel: default parameters match Benedek & Kaernbach Table 1 (tauSlow=2.0, tauFast=0.75)', () => {
  const withDefaults = SCRDeconvolution.buildSCRFKernel(SR);
  const explicit = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 5.0);
  assert.deepStrictEqual(Array.from(withDefaults), Array.from(explicit));
});

test('buildSCRFKernel: a larger tauSlow produces a longer decay tail (more energy late in the kernel)', () => {
  const fastDecay = SCRDeconvolution.buildSCRFKernel(SR, 1.0, 0.75, 8.0);
  const slowDecay = SCRDeconvolution.buildSCRFKernel(SR, 4.0, 0.75, 8.0);
  const tailIdx = Math.floor(fastDecay.length * 0.75);
  assert.ok(slowDecay[tailIdx] > fastDecay[tailIdx],
    'slower tauSlow should retain more amplitude late in the kernel');
});

// ═════════════════════════════════════════════════════════════════════════
// convolve()
// ═════════════════════════════════════════════════════════════════════════

test('convolve: zero driver produces zero output of the same length', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  const driver = new Float64Array(30);
  const out = SCRDeconvolution.convolve(driver, kernel);
  assert.strictEqual(out.length, 30);
  assert.ok(Array.from(out).every(v => v === 0));
});

test('convolve: a single unit impulse reproduces the kernel shape, causally shifted', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  const driver = new Float64Array(80);
  driver[10] = 1.0;
  const out = SCRDeconvolution.convolve(driver, kernel);

  // Nothing before the impulse (causal FIR).
  for (let i = 0; i < 10; i++) assert.strictEqual(out[i], 0);
  // out[10 + j] === kernel[j] for a unit impulse.
  for (let j = 0; j < kernel.length && 10 + j < out.length; j++) {
    assert.ok(Math.abs(out[10 + j] - kernel[j]) < 1e-12, `out[${10 + j}] should equal kernel[${j}]`);
  }
});

test('convolve: output is truncated to the driver length even when the kernel would extend beyond it', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 5.0); // 50 samples
  const driver = new Float64Array(20);
  driver[15] = 1.0; // kernel would extend to sample 15+49=64, well past driver.length=20
  const out = SCRDeconvolution.convolve(driver, kernel);
  assert.strictEqual(out.length, 20);
});

test('convolve: scales linearly with driver amplitude', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  const driver1 = new Float64Array(40); driver1[5] = 1.0;
  const driver2 = new Float64Array(40); driver2[5] = 3.0;
  const out1 = SCRDeconvolution.convolve(driver1, kernel);
  const out2 = SCRDeconvolution.convolve(driver2, kernel);
  for (let i = 0; i < 40; i++) {
    assert.ok(Math.abs(out2[i] - 3 * out1[i]) < 1e-9);
  }
});

test('convolve: is additive across two well-separated impulses (superposition)', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 2.0); // short 20-sample kernel
  const driverA = new Float64Array(60); driverA[5] = 1.0;
  const driverB = new Float64Array(60); driverB[40] = 1.0;
  const driverBoth = new Float64Array(60); driverBoth[5] = 1.0; driverBoth[40] = 1.0;
  const outA = SCRDeconvolution.convolve(driverA, kernel);
  const outB = SCRDeconvolution.convolve(driverB, kernel);
  const outBoth = SCRDeconvolution.convolve(driverBoth, kernel);
  for (let i = 0; i < 60; i++) {
    assert.ok(Math.abs(outBoth[i] - (outA[i] + outB[i])) < 1e-9, `sample ${i} should be additive`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// deconvolve()
// ═════════════════════════════════════════════════════════════════════════

test('deconvolve: all-zero phasic converges immediately with zero iterations and an all-zero driver', () => {
  const phasic = new Float64Array(50);
  const result = SCRDeconvolution.deconvolve(phasic, SR);
  assert.strictEqual(result.iterations, 0);
  assert.ok(Array.from(result.driver).every(v => v === 0));
  assert.strictEqual(result.impulseLog.length, 0);
});

test('deconvolve: empty phasic array does not throw and returns empty structures', () => {
  const result = SCRDeconvolution.deconvolve(new Float64Array(0), SR);
  assert.strictEqual(result.driver.length, 0);
  assert.strictEqual(result.iterations, 0);
  assert.strictEqual(result.impulseLog.length, 0);
});

test('deconvolve: recovers the true position and amplitude of a single isolated synthetic SCR', () => {
  const n = 120;
  const trueDriver = new Float64Array(n);
  trueDriver[30] = 1.2;
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 5.0);
  const phasic = SCRDeconvolution.convolve(trueDriver, kernel);

  const result = SCRDeconvolution.deconvolve(phasic, SR, { maxIter: 20 });
  assert.strictEqual(result.iterations, 1, 'a single clean isolated atom should converge in one MP iteration');
  assert.strictEqual(result.impulseLog.length, 1);
  assert.strictEqual(result.impulseLog[0].trueIndex, 30);
  assert.ok(Math.abs(result.impulseLog[0].amplitude - 1.2) < 1e-9,
    'a perfectly clean single-atom signal should be recovered with the exact input amplitude');
});

test('deconvolve: negative-index onsets (SCR apex within kPeakIdx samples of t=0) are clamped into driver[0]', () => {
  // An artificial spike right at sample 0 (not shaped like the kernel at all)
  // forces the residual's global maximum to sit at index 0, which is closer
  // to t=0 than the kernel's own peak offset (kPeakIdx) — so impIdx =
  // maxIdx - kPeakIdx must go negative. See deconvolve()'s doc comment on
  // clampedImpIdx.
  const n = 60;
  const phasic = new Float64Array(n);
  phasic[0] = 5.0;
  const result = SCRDeconvolution.deconvolve(phasic, SR, { maxIter: 3 });
  assert.strictEqual(result.impulseLog.length, 1);
  assert.ok(result.impulseLog[0].trueIndex < 0, 'true onset should be modeled as predating the recording');
  assert.strictEqual(result.impulseLog[0].clampedIndex, 0, 'driver storage position must be clamped to 0');
  assert.strictEqual(result.driver[0], result.impulseLog[0].amplitude);
});

test('deconvolve: respects the maxIter budget on a signal that would otherwise need more iterations', () => {
  // Many separated, low-amplitude spikes just above convTol force one MP
  // iteration each; capping maxIter well below that count must bound
  // result.iterations to exactly maxIter (49 spikes are available, so the
  // budget — not convergence — is what stops the loop). An `<=` check here
  // would pass even if the maxIter loop bound were silently broken, since
  // nothing else in the algorithm could push iterations past 5 by accident;
  // asserting the exact count makes this a real regression guard.
  const n = 500;
  const phasic = new Float64Array(n);
  for (let i = 10; i < n; i += 10) phasic[i] = 0.5; // 49 separated spikes
  const result = SCRDeconvolution.deconvolve(phasic, SR, { maxIter: 5, convTol: 0.001 });
  assert.strictEqual(result.iterations, 5, 'maxIter=5 with 49 available spikes should use the full budget');
});

test('deconvolve: convTol stops iteration once the residual max falls below threshold', () => {
  const n = 60;
  const phasic = new Float64Array(n);
  phasic[20] = 0.0005; // below a convTol of 0.001
  const result = SCRDeconvolution.deconvolve(phasic, SR, { convTol: 0.001, maxIter: 50 });
  assert.strictEqual(result.iterations, 0, 'a residual entirely below convTol should never place an atom');
});

test('deconvolve: driver stays non-negative throughout (nonnegative deconvolution)', () => {
  // NOTE: deconvolve()'s return value has no `residual` field to inspect —
  // this only checks `driver`, which is structurally guaranteed to be >= 0
  // regardless of overlap (it only ever accumulates maxVal*lr with
  // maxVal >= 0). Kept as a documentation/regression guard, not a
  // discriminating test of the overlap-handling logic itself.
  const n = 200;
  const trueDriver = new Float64Array(n);
  trueDriver[40] = 0.9;
  trueDriver[42] = 0.6; // overlapping atoms — exercises residual subtraction across atoms
  trueDriver[150] = 1.3;
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  const phasic = SCRDeconvolution.convolve(trueDriver, kernel);
  const result = SCRDeconvolution.deconvolve(phasic, SR, { maxIter: 50 });
  assert.ok(Array.from(result.driver).every(v => v >= 0), 'driver must be nonnegative everywhere');
});

test('deconvolve: returns the same kernel buildSCRFKernel would produce for the given options', () => {
  const phasic = new Float64Array(30);
  const opts = { tauSlow: 1.5, tauFast: 0.5, kernelSec: 3.0 };
  const result = SCRDeconvolution.deconvolve(phasic, SR, opts);
  const expectedKernel = SCRDeconvolution.buildSCRFKernel(SR, opts.tauSlow, opts.tauFast, opts.kernelSec);
  assert.deepStrictEqual(Array.from(result.kernel), Array.from(expectedKernel));
});

test('deconvolve: single-sample phasic array does not throw', () => {
  assert.doesNotThrow(() => {
    const result = SCRDeconvolution.deconvolve(new Float64Array([0.5]), SR, { maxIter: 5 });
    assert.strictEqual(result.driver.length, 1);
  });
});

test('deconvolve: a signal with no positive samples places zero impulses', () => {
  // NOTE: this does NOT actually exercise the "Clamp input" line
  // (residual[i] = Math.max(0, phasic[i])) — the max-search below it
  // initializes maxVal to 0 and only accepts strictly-greater values, so a
  // negative sample can never win regardless of whether it was clamped
  // first. The clamp is presently redundant with that threshold; this test
  // only documents the end-to-end guarantee that negative/zero-only input
  // yields no impulses, which holds either way.
  const phasic = new Float64Array(30);
  phasic[10] = -3.0; // physically invalid input
  const result = SCRDeconvolution.deconvolve(phasic, SR, { maxIter: 10 });
  assert.strictEqual(result.iterations, 0, 'an entirely-negative-or-zero phasic should never place an atom');
});

// ═════════════════════════════════════════════════════════════════════════
// detectImpulses()
// ═════════════════════════════════════════════════════════════════════════

test('detectImpulses: empty/all-zero driver returns no impulses', () => {
  assert.deepStrictEqual(SCRDeconvolution.detectImpulses(new Float64Array(0), SR), []);
  assert.deepStrictEqual(SCRDeconvolution.detectImpulses(new Float64Array(40), SR), []);
});

test('detectImpulses: finds well-separated local maxima above threshold', () => {
  const driver = new Float64Array(60);
  driver[10] = 0.5;
  driver[40] = 0.8;
  const impulses = SCRDeconvolution.detectImpulses(driver, SR, 0.005, 0.5);
  assert.strictEqual(impulses.length, 2);
  assert.strictEqual(impulses[0].index, 10);
  assert.strictEqual(impulses[0].amplitude, 0.5);
  assert.strictEqual(impulses[1].index, 40);
  assert.strictEqual(impulses[1].amplitude, 0.8);
});

test('detectImpulses: filters out sub-threshold peaks', () => {
  const driver = new Float64Array(40);
  driver[20] = 0.001; // below default threshold 0.005
  const impulses = SCRDeconvolution.detectImpulses(driver, SR);
  assert.strictEqual(impulses.length, 0);
});

test('detectImpulses: time field is index / sampleRate', () => {
  const driver = new Float64Array(40);
  driver[25] = 1.0;
  const [imp] = SCRDeconvolution.detectImpulses(driver, SR);
  assert.strictEqual(imp.time, 25 / SR);
});

test('detectImpulses: within minGapSec, keeps the larger-amplitude candidate (non-max suppression by amplitude)', () => {
  // Two local maxima 0.3s apart (< default 0.5s minGap): a smaller one first,
  // a bigger one second. Per the doc comment, proper NMS resolves this by
  // amplitude — the bigger one must survive regardless of scan order.
  const driver = new Float64Array(60);
  driver[10] = 0.3; // smaller, earlier
  driver[13] = 0.9; // bigger, 0.3s later — within minGapSec=0.5
  const impulses = SCRDeconvolution.detectImpulses(driver, SR, 0.005, 0.5);
  assert.strictEqual(impulses.length, 1, 'the two close candidates should collapse to one via NMS');
  assert.strictEqual(impulses[0].index, 13, 'the larger-amplitude candidate must win, not the earlier one');
});

test('detectImpulses: candidates farther apart than minGapSec are both kept', () => {
  const driver = new Float64Array(60);
  driver[10] = 0.3;
  driver[30] = 0.2; // 2.0s later, well past minGapSec=0.5
  const impulses = SCRDeconvolution.detectImpulses(driver, SR, 0.005, 0.5);
  assert.strictEqual(impulses.length, 2);
});

test('detectImpulses: result is sorted ascending by index', () => {
  const driver = new Float64Array(80);
  driver[60] = 0.6;
  driver[5] = 0.4;
  driver[35] = 0.9;
  const impulses = SCRDeconvolution.detectImpulses(driver, SR, 0.005, 0.5);
  const indices = impulses.map(i => i.index);
  const sorted = [...indices].sort((a, b) => a - b);
  assert.deepStrictEqual(indices, sorted);
});

test('detectImpulses: a peak at the very first or last sample is still detected (boundary local-max check)', () => {
  const driverStart = new Float64Array(40);
  driverStart[0] = 0.5;
  const atStart = SCRDeconvolution.detectImpulses(driverStart, SR);
  assert.strictEqual(atStart.length, 1);
  assert.strictEqual(atStart[0].index, 0);

  const driverEnd = new Float64Array(40);
  driverEnd[39] = 0.5;
  const atEnd = SCRDeconvolution.detectImpulses(driverEnd, SR);
  assert.strictEqual(atEnd.length, 1);
  assert.strictEqual(atEnd[0].index, 39);
});

// ═════════════════════════════════════════════════════════════════════════
// reconstructPhasic()
// ═════════════════════════════════════════════════════════════════════════

test('reconstructPhasic: empty impulse list produces an all-zero signal of length n', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR);
  const clean = SCRDeconvolution.reconstructPhasic([], 50, kernel);
  assert.strictEqual(clean.length, 50);
  assert.ok(Array.from(clean).every(v => v === 0));
});

test('reconstructPhasic: a single non-negative-index impulse reproduces amplitude * kernel starting at its index', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 2.0); // 20-sample kernel
  const n = 60;
  const clean = SCRDeconvolution.reconstructPhasic([{ index: 15, amplitude: 2.0 }], n, kernel);
  for (let i = 0; i < 15; i++) assert.strictEqual(clean[i], 0);
  for (let j = 0; j < kernel.length; j++) {
    assert.ok(Math.abs(clean[15 + j] - 2.0 * kernel[j]) < 1e-12);
  }
});

test('reconstructPhasic: a negative-index impulse contributes only its visible (post-t=0) tail', () => {
  // Mirrors deconvolve()'s own residual-subtraction clamping (see reconstructPhasic's
  // doc comment): index=-12 means the modeled onset is 12 samples before t=0, so only
  // kernel[12:] should appear, starting at clean[0].
  const kernel = SCRDeconvolution.buildSCRFKernel(SR); // default 50-sample kernel
  const n = 30;
  const clean = SCRDeconvolution.reconstructPhasic([{ index: -12, amplitude: 5.0 }], n, kernel);
  assert.ok(Math.abs(clean[0] - 5.0 * kernel[12]) < 1e-12, 'clean[0] should be amplitude * kernel[12], not kernel[0]');
  for (let j = 12; j < kernel.length && j - 12 < n; j++) {
    assert.ok(Math.abs(clean[j - 12] - 5.0 * kernel[j]) < 1e-12);
  }
});

test('reconstructPhasic: multiple well-separated impulses sum without leaking into each other (no overlap)', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 2.0); // 20-sample kernel
  const n = 60;
  const clean = SCRDeconvolution.reconstructPhasic(
    [{ index: 0, amplitude: 1.0 }, { index: 30, amplitude: 1.0 }], n, kernel
  );
  // The two 20-sample kernel copies (at 0 and 30) never overlap, so the gap
  // between them (samples 20-29) must be exactly zero.
  for (let i = 20; i < 30; i++) assert.strictEqual(clean[i], 0);
  for (let j = 0; j < kernel.length; j++) assert.ok(Math.abs(clean[j] - kernel[j]) < 1e-12);
  for (let j = 0; j < kernel.length; j++) assert.ok(Math.abs(clean[30 + j] - kernel[j]) < 1e-12);
});

test('reconstructPhasic: overlapping impulses sum additively (superposition, not replacement)', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 5.0); // 50-sample kernel
  const n = 60;
  const cleanSingle = SCRDeconvolution.reconstructPhasic([{ index: 5, amplitude: 1.0 }], n, kernel);
  const cleanDouble = SCRDeconvolution.reconstructPhasic(
    [{ index: 5, amplitude: 1.0 }, { index: 5, amplitude: 1.0 }], n, kernel
  );
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(cleanDouble[i] - 2 * cleanSingle[i]) < 1e-9, `sample ${i} should sum linearly`);
  }
});

test('reconstructPhasic: contribution is truncated at signal length n', () => {
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 5.0); // 50-sample kernel
  const n = 20;
  const clean = SCRDeconvolution.reconstructPhasic([{ index: 10, amplitude: 1.0 }], n, kernel);
  assert.strictEqual(clean.length, 20, 'output must not exceed n even though the kernel would extend past it');
});

// ═════════════════════════════════════════════════════════════════════════
// End-to-end round trip: deconvolve() -> reconstructPhasic() recovers a
// clean synthetic single-SCR signal closely.
// ═════════════════════════════════════════════════════════════════════════

test('round trip: deconvolve + reconstructPhasic (using trueIndex) recovers a clean isolated synthetic SCR', () => {
  const n = 150;
  const trueDriver = new Float64Array(n);
  trueDriver[50] = 1.0;
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 5.0);
  const phasic = SCRDeconvolution.convolve(trueDriver, kernel);

  const result = SCRDeconvolution.deconvolve(phasic, SR, { maxIter: 20 });
  const impulses = result.impulseLog.map(l => ({ index: l.trueIndex, amplitude: l.amplitude }));
  const clean = SCRDeconvolution.reconstructPhasic(impulses, n, result.kernel);

  // Tolerance of 1e-6 rather than an exact match: two independent floating-point
  // paths (matching-pursuit fit vs. direct convolution) accumulate different
  // rounding, though for a single clean isolated atom they should agree almost
  // exactly.
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(clean[i] - phasic[i]));
  assert.ok(maxDiff < 1e-6, `reconstructed signal should closely match the original for a single clean atom, got maxDiff=${maxDiff}`);
});

// ═════════════════════════════════════════════════════════════════════════
// Export guard sanity
// ═════════════════════════════════════════════════════════════════════════

test('module export: SCRDeconvolution exposes exactly the documented public API', () => {
  assert.strictEqual(typeof SCRDeconvolution.buildSCRFKernel, 'function');
  assert.strictEqual(typeof SCRDeconvolution.convolve, 'function');
  assert.strictEqual(typeof SCRDeconvolution.deconvolve, 'function');
  assert.strictEqual(typeof SCRDeconvolution.detectImpulses, 'function');
  assert.strictEqual(typeof SCRDeconvolution.reconstructPhasic, 'function');
});
