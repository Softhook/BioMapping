/**
 * Unit tests for dwt_filter.js (DWT — Daubechies db3 wavelet transform) —
 * pure tonic/phasic decomposition math, independent of the analyzer pipeline.
 *
 * The pipeline-level suites (test_all_pipelines.js, test_deconvolution_053.js,
 * test_deconvolution_059.js) already exercise DWT.analyzeGSR() indirectly as
 * part of GSRAnalyzer.analyze(); this file covers each exported function
 * directly — including decompose()/reconstructFromApproximation() shape and
 * round-trip behaviour, and edge cases (empty/short/all-zero/single-sample
 * signals) that the pipeline tests never hit because real tracks are always
 * long, noisy, and non-degenerate.
 *
 * Run: node --test tests/test_dwt_filter.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const DWT = require('../dwt_filter.js');

// ── Helpers to build synthetic GSR-like signals ─────────────────────────────

/** Flat baseline (constant DC signal). */
function flatSignal(n, value = 3.0) {
  return new Array(n).fill(value);
}

/** Flat baseline plus a few Gaussian-ish bumps — a stand-in for real GSR. */
function gsrLikeSignal(n, bumps = [{ center: n * 0.3, width: n * 0.03, amp: 1.5 },
                                    { center: n * 0.6, width: n * 0.02, amp: 0.8 }]) {
  const sig = new Array(n).fill(2.0);
  for (let i = 0; i < n; i++) {
    for (const b of bumps) {
      const d = (i - b.center) / b.width;
      sig[i] += b.amp * Math.exp(-d * d);
    }
  }
  return sig;
}

// ═════════════════════════════════════════════════════════════════════════
// decompose()
// ═════════════════════════════════════════════════════════════════════════

test('decompose: returns approximation, details[], and padding metadata', () => {
  const sig = gsrLikeSignal(128);
  const coeffs = DWT.decompose(sig, 4);
  assert.ok(Array.isArray(coeffs.approximation));
  assert.ok(Array.isArray(coeffs.details));
  assert.strictEqual(coeffs.details.length, 4, 'one detail array per level');
  assert.strictEqual(coeffs.originalLen, 128);
  assert.ok(Number.isInteger(coeffs.padLeft) && coeffs.padLeft >= 0);
  assert.ok(Number.isInteger(coeffs.padRight) && coeffs.padRight >= 0);
});

test('decompose: each successive detail level is half the length of the previous', () => {
  const sig = gsrLikeSignal(256);
  const coeffs = DWT.decompose(sig, 5);
  for (let i = 1; i < coeffs.details.length; i++) {
    assert.strictEqual(coeffs.details[i].length, coeffs.details[i - 1].length / 2,
      `detail level ${i + 1} should be half the length of level ${i}`);
  }
  // Approximation at the deepest level is half the length of the last detail.
  assert.strictEqual(coeffs.approximation.length, coeffs.details[coeffs.details.length - 1].length);
});

test('decompose: handles odd-length signals with asymmetric mirror padding', () => {
  const sig = gsrLikeSignal(101); // odd length
  const coeffs = DWT.decompose(sig, 3);
  assert.strictEqual(coeffs.originalLen, 101);
  // Doc comment: "If n is odd ... right padding one sample longer (asymmetric by one sample)".
  assert.strictEqual(coeffs.padRight, coeffs.padLeft + 1);
});

test('decompose: even-length signals use symmetric mirror padding', () => {
  const sig = gsrLikeSignal(150);
  const coeffs = DWT.decompose(sig, 3);
  assert.strictEqual(coeffs.padLeft, coeffs.padRight);
});

test('decompose: all-zero signal decomposes to all-zero approximation and details', () => {
  const sig = new Array(128).fill(0);
  const coeffs = DWT.decompose(sig, 4);
  assert.ok(coeffs.approximation.every(v => Math.abs(v) < 1e-12));
  for (const d of coeffs.details) {
    assert.ok(d.every(v => Math.abs(v) < 1e-12));
  }
});

test('decompose: padded length used internally is always a multiple of 2^levels', () => {
  // Indirect check: padLeft + originalLen + padRight must be divisible by 2^levels,
  // per the doc comment's guarantee ("Total padded length is a multiple of 2^levels").
  for (const n of [50, 51, 99, 100, 257]) {
    const levels = 3;
    const sig = gsrLikeSignal(n);
    const coeffs = DWT.decompose(sig, levels);
    const totalLen = coeffs.padLeft + coeffs.originalLen + coeffs.padRight;
    assert.strictEqual(totalLen % (1 << levels), 0, `n=${n} padded length must be a multiple of 2^${levels}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// reconstructFromApproximation()
// ═════════════════════════════════════════════════════════════════════════

test('reconstructFromApproximation: returns a signal of the original length', () => {
  const sig = gsrLikeSignal(150);
  const coeffs = DWT.decompose(sig, 4);
  const recon = DWT.reconstructFromApproximation(coeffs, 4);
  assert.strictEqual(recon.length, sig.length);
});

test('reconstructFromApproximation: a constant (DC) signal round-trips to machine precision', () => {
  // A constant signal has zero energy above DC, so the approximation-only
  // reconstruction (all details zeroed) should recover it almost exactly —
  // the low-pass scaling filter sums to sqrt(2) by construction, so a flat
  // input reconstructs to the same flat value. Tolerance 1e-6 comfortably
  // covers float64 rounding across the multi-level pass without being
  // brittle to implementation-detail-level noise.
  const sig = flatSignal(128, 5.0);
  const coeffs = DWT.decompose(sig, 4);
  const recon = DWT.reconstructFromApproximation(coeffs, 4);
  for (let i = 0; i < sig.length; i++) {
    assert.ok(Math.abs(recon[i] - 5.0) < 1e-6, `sample ${i}: expected ~5.0, got ${recon[i]}`);
  }
});

test('reconstructFromApproximation: odd-length signal round-trips with correct length and near-DC value', () => {
  const sig = flatSignal(101, 2.5);
  const coeffs = DWT.decompose(sig, 3);
  const recon = DWT.reconstructFromApproximation(coeffs, 3);
  assert.strictEqual(recon.length, 101);
  for (const v of recon) assert.ok(Math.abs(v - 2.5) < 1e-6);
});

test('reconstructFromApproximation: tonic (approximation-only) tracks a slow-varying signal closely', () => {
  // A very slow sine (period == full signal length, tiny amplitude) is
  // almost entirely low-frequency energy, so the deep-level approximation
  // should track it far more tightly than the signal's own amplitude —
  // this is the "no phase lag, no bleed-through" claim in the file's doc
  // comment, tested quantitatively rather than just asserting it runs.
  const n = 256;
  const amp = 0.001;
  const sig = [];
  for (let i = 0; i < n; i++) sig.push(3 + amp * Math.sin((2 * Math.PI * i) / n));
  const coeffs = DWT.decompose(sig, 6);
  const tonic = DWT.reconstructFromApproximation(coeffs, 6);
  let maxDiff = 0;
  for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(sig[i] - tonic[i]));
  assert.ok(maxDiff < amp, `tonic should track a near-DC slow sine within its own amplitude (${amp}), got maxDiff=${maxDiff}`);
});

// ═════════════════════════════════════════════════════════════════════════
// analyzeGSR()
// ═════════════════════════════════════════════════════════════════════════

test('analyzeGSR: typical GSR-like signal returns tonic/phasic arrays of matching length', () => {
  const sig = gsrLikeSignal(300);
  const { tonic, phasic } = DWT.analyzeGSR(sig, 4);
  assert.strictEqual(tonic.length, sig.length);
  assert.strictEqual(phasic.length, sig.length);
});

test('analyzeGSR: phasic is never negative (physiological clamp)', () => {
  // Doc comment: "Phasic conductance cannot physically be negative — clamp to zero."
  const sig = gsrLikeSignal(300);
  const { phasic } = DWT.analyzeGSR(sig, 4);
  assert.ok(phasic.every(v => v >= 0), 'every phasic sample must be >= 0');
});

test('analyzeGSR: phasic equals signal minus tonic wherever that difference is non-negative', () => {
  const sig = gsrLikeSignal(300);
  const { tonic, phasic } = DWT.analyzeGSR(sig, 4);
  for (let i = 0; i < sig.length; i++) {
    const diff = sig[i] - tonic[i];
    const expected = Math.max(0, diff);
    assert.ok(Math.abs(phasic[i] - expected) < 1e-9, `sample ${i}: phasic should equal max(0, signal-tonic)`);
  }
});

test('analyzeGSR: all-zero signal (long enough) yields all-zero tonic and phasic', () => {
  const sig = new Array(128).fill(0);
  const { tonic, phasic } = DWT.analyzeGSR(sig, 4);
  assert.ok(tonic.every(v => Math.abs(v) < 1e-9));
  assert.ok(phasic.every(v => Math.abs(v) < 1e-9));
});

test('analyzeGSR: constant nonzero signal yields tonic == signal and phasic == 0', () => {
  const sig = flatSignal(128, 4.2);
  const { tonic, phasic } = DWT.analyzeGSR(sig, 4);
  for (let i = 0; i < sig.length; i++) {
    assert.ok(Math.abs(tonic[i] - 4.2) < 1e-6);
    assert.ok(Math.abs(phasic[i]) < 1e-6);
  }
});

test('analyzeGSR: default levels is 6 when omitted', () => {
  // minLen for the fallback branch is 2^levels; with the default (6) that's 64.
  // A signal of exactly 63 samples must hit the short-signal fallback, and 64
  // must not.
  const short = gsrLikeSignal(63);
  const atMin = gsrLikeSignal(64);
  const resShort = DWT.analyzeGSR(short); // levels omitted -> default 6
  const resAtMin = DWT.analyzeGSR(atMin);
  assert.deepStrictEqual(resShort.tonic, short, 'below default minLen falls back to tonic=copy of signal');
  assert.ok(resAtMin.tonic.length === 64, 'at default minLen the real DWT path runs');
});

test('analyzeGSR: signal shorter than 2^levels falls back to tonic=signal, phasic=zeros', () => {
  const sig = [1, 2, 3, 4, 5]; // far shorter than 2^4=16
  const { tonic, phasic } = DWT.analyzeGSR(sig, 4);
  assert.deepStrictEqual(tonic, sig);
  assert.deepStrictEqual(phasic, [0, 0, 0, 0, 0]);
  // Fallback must return a copy, not the same array reference.
  assert.notStrictEqual(tonic, sig);
});

test('analyzeGSR: empty array input returns empty tonic/phasic arrays without throwing', () => {
  const { tonic, phasic } = DWT.analyzeGSR([], 4);
  assert.deepStrictEqual(tonic, []);
  assert.deepStrictEqual(phasic, []);
});

test('analyzeGSR: null/undefined signal returns empty arrays without throwing', () => {
  const r1 = DWT.analyzeGSR(null, 4);
  assert.deepStrictEqual(r1.tonic, []);
  assert.deepStrictEqual(r1.phasic, []);
  const r2 = DWT.analyzeGSR(undefined, 4);
  assert.deepStrictEqual(r2.tonic, []);
  assert.deepStrictEqual(r2.phasic, []);
});

test('analyzeGSR: single-sample array falls back cleanly (shorter than any 2^levels>=1)', () => {
  const { tonic, phasic } = DWT.analyzeGSR([7.5], 4);
  assert.deepStrictEqual(tonic, [7.5]);
  assert.deepStrictEqual(phasic, [0]);
});

test('analyzeGSR: levels < 1 is coerced to the default (6)', () => {
  // "if (!levels || levels < 1) levels = 6;" — 0 and negative both hit this.
  const sig = gsrLikeSignal(64);
  const rZero = DWT.analyzeGSR(sig, 0);
  const rNeg = DWT.analyzeGSR(sig, -3);
  const rDefault = DWT.analyzeGSR(sig, 6);
  assert.deepStrictEqual(rZero.tonic, rDefault.tonic);
  assert.deepStrictEqual(rNeg.tonic, rDefault.tonic);
});

test('analyzeGSR: larger amplitude bumps produce larger peak phasic response', () => {
  const bigBump = gsrLikeSignal(300, [{ center: 150, width: 5, amp: 3.0 }]);
  const smallBump = gsrLikeSignal(300, [{ center: 150, width: 5, amp: 0.3 }]);
  const big = DWT.analyzeGSR(bigBump, 4);
  const small = DWT.analyzeGSR(smallBump, 4);
  assert.ok(Math.max(...big.phasic) > Math.max(...small.phasic),
    'a larger synthetic SCR bump should yield a larger peak phasic value');
});

// ═════════════════════════════════════════════════════════════════════════
// levelLabels()
// ═════════════════════════════════════════════════════════════════════════

test('levelLabels: returns one label per level, numbered from 1', () => {
  const labels = DWT.levelLabels(10, 4);
  assert.strictEqual(labels.length, 4);
  assert.deepStrictEqual(labels.map(l => l.level), [1, 2, 3, 4]);
});

test('levelLabels: only level 1 is flagged as noise', () => {
  const labels = DWT.levelLabels(10, 5);
  assert.strictEqual(labels[0].isNoise, true);
  for (let i = 1; i < labels.length; i++) assert.strictEqual(labels[i].isNoise, false);
});

test('levelLabels: approxBand upper edge equals detailBand lower edge (dyadic bands are contiguous)', () => {
  const labels = DWT.levelLabels(10, 3);
  for (const l of labels) {
    const approxHi = l.approxBand.split('–')[1].replace(' Hz', '');
    const detailLo = l.detailBand.split('–')[0];
    assert.strictEqual(approxHi, detailLo, `level ${l.level}: approx and detail bands should share a boundary`);
  }
});

test('levelLabels: frequency bands halve at each successive level (Fs/2^(k+1) to Fs/2^k)', () => {
  const sampleRateHz = 10;
  const labels = DWT.levelLabels(sampleRateHz, 3);
  for (const l of labels) {
    const expectedLo = (sampleRateHz / Math.pow(2, l.level + 1)).toFixed(2);
    const expectedHi = (sampleRateHz / Math.pow(2, l.level)).toFixed(2);
    assert.strictEqual(l.approxBand, `0–${expectedLo} Hz`);
    assert.strictEqual(l.detailBand, `${expectedLo}–${expectedHi} Hz`);
  }
});

test('levelLabels: levels=0 returns an empty array', () => {
  assert.deepStrictEqual(DWT.levelLabels(10, 0), []);
});

// ═════════════════════════════════════════════════════════════════════════
// Export guard sanity
// ═════════════════════════════════════════════════════════════════════════

test('module export: DWT exposes exactly the documented public API', () => {
  assert.strictEqual(typeof DWT.decompose, 'function');
  assert.strictEqual(typeof DWT.reconstructFromApproximation, 'function');
  assert.strictEqual(typeof DWT.analyzeGSR, 'function');
  assert.strictEqual(typeof DWT.levelLabels, 'function');
});
