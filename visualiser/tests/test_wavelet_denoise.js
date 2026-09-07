/**
 * Unit tests for the DWT wavelet library (visualiser/src/signal/dwt_filter.js):
 *   - DWT.decompose / DWT.reconstructFull  — full (details-included) round-trip
 *   - DWT.denoise(signal, {sampleRate, mode, shifts})  — cycle-spun db3 soft
 *     threshold, per-band BayesShrink
 *
 * The module is not currently wired into the analysis pipeline; these tests
 * keep it correct for reuse.
 *
 * Run: node --test tests/test_wavelet_denoise.js   (or npm test)
 */

'use strict';

const assert = require('assert');
const test   = require('node:test');

const DWT = require('../src/signal/dwt_filter.js');

// ── synthetic signal builders ──────────────────────────────────────────────
function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; }; }
function scr(t, t0, amp, tRise, tDecay) {
  if (t < t0) return 0;
  const d = t - t0;
  return amp * (1 - Math.exp(-d / tRise)) * Math.exp(-d / tDecay);
}
function noisySCRTrace(n, Fs, noiseAmp, seed) {
  const rnd = lcg(seed || 1);
  const clean = [], noisy = [];
  for (let i = 0; i < n; i++) {
    const t = i / Fs;
    const b = 0.5 + scr(t, n * 0.25 / Fs, 2.5, 0.8, 2.5) + scr(t, n * 0.6 / Fs, 3.0, 0.9, 2.0);
    clean.push(b);
    noisy.push(b + rnd() * noiseAmp);
  }
  return { clean, noisy };
}
const apexIdx = (a) => { let mi = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[mi]) mi = i; return mi; };
const variance = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length; };

// ═══════════════════════ DWT.reconstructFull round-trip ════════════════════

test('reconstructFull: decompose → reconstructFull recovers the signal to ~1e-9', () => {
  for (const n of [512, 777, 2000, 9000]) {
    const x = Array.from({ length: n }, (_, i) => 3 + 0.001 * i + 0.7 * Math.sin(i / 9) + 0.2 * Math.sin(i / 2.3));
    for (const L of [3, 4, 5]) {
      const c = DWT.decompose(x, L);
      const rt = DWT.reconstructFull(c, L);
      assert.strictEqual(rt.length, n);
      let mx = 0;
      for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(x[i] - rt[i]));
      assert.ok(mx < 1e-9, `n=${n} L=${L}: round-trip error ${mx.toExponential(2)}`);
    }
  }
});

// ═══════════════════════════════ DWT.denoise ═══════════════════════════════

test('denoise: length preserved for even, odd, near-2^levels, and long inputs', () => {
  for (const n of [400, 401, 15, 16, 17, 9000]) {
    const x = Array.from({ length: n }, (_, i) => Math.sin(i / 5) + (i % 3) * 0.1);
    assert.strictEqual(DWT.denoise(x, { sampleRate: 10, mode: 'light', shifts: 4 }).length, n);
  }
});

test("denoise: mode 'off' is an exact identity copy", () => {
  const x = noisySCRTrace(2000, 10, 0.1, 2).noisy;
  const out = DWT.denoise(x, { mode: 'off' });
  assert.deepStrictEqual(out, x);
  assert.notStrictEqual(out, x);
});

test('denoise: a flat signal passes through unchanged', () => {
  const x = new Array(1000).fill(4.2);
  const out = DWT.denoise(x, { sampleRate: 10, mode: 'strong', shifts: 8 });
  for (const v of out) assert.ok(Math.abs(v - 4.2) < 1e-6);
});

test('denoise: a linear ramp is near-passthrough (db3 kills linear detail)', () => {
  const n = 1000;
  const x = Array.from({ length: n }, (_, i) => 1 + 0.01 * i);
  const out = DWT.denoise(x, { sampleRate: 10, mode: 'strong', shifts: 8 });
  let mx = 0;
  for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(out[i] - x[i]));
  assert.ok(mx < 1e-3, `ramp deviation ${mx}`);
});

test('denoise: reduces broadband white-noise variance (light < 0.6x, strong < 0.4x)', () => {
  const { clean, noisy } = noisySCRTrace(4000, 10, 0.12, 5);
  const vIn = variance(noisy.map((v, i) => v - clean[i]));
  const vL = variance(DWT.denoise(noisy, { sampleRate: 10, mode: 'light', shifts: 8 }).map((v, i) => v - clean[i]));
  const vS = variance(DWT.denoise(noisy, { sampleRate: 10, mode: 'strong', shifts: 16 }).map((v, i) => v - clean[i]));
  assert.ok(vL < 0.6 * vIn, `light residual variance ${(vL / vIn).toFixed(2)}x`);
  assert.ok(vS < 0.4 * vIn, `strong residual variance ${(vS / vIn).toFixed(2)}x`);
  assert.ok(vS <= vL + 1e-9, 'strong denoises at least as hard as light');
});

test('denoise: SCR peak amplitude is retained (light within 5%, strong within 8%)', () => {
  const { clean, noisy } = noisySCRTrace(4000, 10, 0.10, 7);
  const ci = apexIdx(clean);
  const cAmp = clean[ci] - 0.5;
  for (const [mode, tol, K] of [['light', 0.05, 8], ['strong', 0.08, 16]]) {
    const out = DWT.denoise(noisy, { sampleRate: 10, mode, shifts: K });
    let localMax = -Infinity;
    for (let i = ci - 20; i <= ci + 20; i++) localMax = Math.max(localMax, out[i]);
    const ratio = (localMax - 0.5) / cAmp;
    assert.ok(Math.abs(ratio - 1) < tol, `${mode}: amplitude ratio ${ratio.toFixed(3)}`);
  }
});

test('denoise: SCR 10-90% rise time is not badly inflated (< 60% vs clean)', () => {
  const { clean, noisy } = noisySCRTrace(3000, 10, 0.10, 9);
  const rise = (a, onset, ap) => {
    const a0 = a[onset], amp = a[ap] - a0;
    let t10 = -1, t90 = -1;
    for (let i = onset; i <= ap; i++) {
      if (t10 < 0 && a[i] >= a0 + 0.1 * amp) t10 = i;
      if (a[i] >= a0 + 0.9 * amp) { t90 = i; break; }
    }
    return (t90 - t10) / 10;
  };
  const ciAp = apexIdx(clean);
  const onset = Math.round(3000 * 0.25) - 8;
  const rc = rise(clean, onset, ciAp);
  for (const mode of ['light', 'strong']) {
    const out = DWT.denoise(noisy, { sampleRate: 10, mode, shifts: 8 });
    const ro = rise(out, onset, apexIdx(out));
    assert.ok(ro < rc * 1.6, `${mode}: rise ${ro.toFixed(2)}s vs clean ${rc.toFixed(2)}s`);
  }
});

test('denoise: a lone spike is left largely intact with no ringing (it is not a spike remover)', () => {
  // A single-sample impulse spreads roughly half its energy into the
  // untouched approximation band, so detail-band shrinkage cannot remove it —
  // that is the median filter's job. What matters here is that the denoise
  // does not *smear* the spike into a wider artefact or ring around it.
  const { noisy } = noisySCRTrace(3000, 10, 0.05, 11);
  const i0 = 1500;
  const base = noisy[i0];
  const spiked = noisy.slice();
  spiked[i0] = base + 1.0;
  const out = DWT.denoise(spiked, { sampleRate: 10, mode: 'strong', shifts: 8 });
  assert.ok((out[i0] - base) > 0.4, `spike should survive detail-band shrinkage: ${(out[i0] - base).toFixed(2)}`);
  for (let k = 4; k <= 12; k++) {
    assert.ok(Math.abs(out[i0 - k] - spiked[i0 - k]) < 0.2, `ringing at neighbour -${k}`);
    assert.ok(Math.abs(out[i0 + k] - spiked[i0 + k]) < 0.2, `ringing at neighbour +${k}`);
  }
});

test('denoise: deterministic — identical inputs give byte-identical output', () => {
  const x = noisySCRTrace(2000, 10, 0.1, 13).noisy;
  assert.deepStrictEqual(
    DWT.denoise(x, { sampleRate: 10, mode: 'light', shifts: 8 }),
    DWT.denoise(x, { sampleRate: 10, mode: 'light', shifts: 8 })
  );
});

test('denoise: signal shorter than 2^levels returns an unmodified copy', () => {
  const x = [1, 2, 3, 4, 5, 6, 7];
  const out = DWT.denoise(x, { sampleRate: 10, mode: 'strong', shifts: 4 });
  assert.deepStrictEqual(out, x);
  assert.notStrictEqual(out, x);
});

test('denoise: loose idempotence — a second pass changes little', () => {
  const x = noisySCRTrace(3000, 10, 0.12, 17).noisy;
  const once = DWT.denoise(x, { sampleRate: 10, mode: 'light', shifts: 8 });
  const twice = DWT.denoise(once, { sampleRate: 10, mode: 'light', shifts: 8 });
  let mx = 0;
  for (let i = 0; i < x.length; i++) mx = Math.max(mx, Math.abs(twice[i] - once[i]));
  assert.ok(mx < 0.15, `second pass moved by ${mx.toFixed(3)}`);
});

test('denoise: unknown mode is treated as off (returns a copy)', () => {
  const x = noisySCRTrace(1000, 10, 0.1, 29).noisy;
  const out = DWT.denoise(x, { sampleRate: 10, mode: 'bogus' });
  assert.deepStrictEqual(out, x);
  assert.notStrictEqual(out, x);
});
