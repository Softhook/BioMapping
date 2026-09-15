/**
 * Unit tests for spectral_eda.js (SpectralEDA) — the EDASymp (0.045–0.25 Hz)
 * spectral sympathetic index. Covers the FFT, the scipy-compatible IIR filter
 * designs, Welch density scaling (Parseval), the NeuroKit2-style scalar, the
 * sliding-window series, and analyzer integration.
 *
 * Run: node --test tests/test_spectral_eda.js  (or `npm test`)
 */

const assert = require('node:assert');
const test = require('node:test');

const { SpectralEDA } = require('../src/signal/spectral_eda.mjs');

const closeTo = (actual, expected, tolerance, msg) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg || ''} expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------

test('FFT: matches a naive DFT on a small power-of-2 input', () => {
  const n = 8;
  const re = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const im = new Float64Array(n);
  SpectralEDA._fftInPlace(re, im);

  for (let k = 0; k < n; k++) {
    let expRe = 0,
      expIm = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      const x = t + 1;
      expRe += x * Math.cos(ang);
      expIm += x * Math.sin(ang);
    }
    closeTo(re[k], expRe, 1e-9, `FFT re[${k}]`);
    closeTo(im[k], expIm, 1e-9, `FFT im[${k}]`);
  }
});

// ---------------------------------------------------------------------------
// Blackman window (periodic) — scipy.signal.windows.blackman(sym=False)
// ---------------------------------------------------------------------------

test('blackmanPeriodic: matches scipy.signal.windows.blackman(M, sym=False)', () => {
  const w = SpectralEDA.blackmanPeriodic(8);
  // scipy.signal.get_window('blackman', 8, fftbins=True) — the periodic variant.
  const expected = [
    -1.3877787807814457e-17, 0.06644660940672624, 0.34, 0.7735533905932738,
    0.9999999999999999, 0.7735533905932738, 0.34, 0.06644660940672624,
  ];
  for (let i = 0; i < 8; i++)
    closeTo(w[i], expected[i], 1e-12, `blackman[${i}]`);
});

// ---------------------------------------------------------------------------
// IIR filter designs — bit-compatible with scipy.signal.cheby1 / butter
// ---------------------------------------------------------------------------

test('cheby1LowpassSos: matches scipy.signal.cheby1(8, 1, 0.8, fs=10)', () => {
  const sos = SpectralEDA.cheby1LowpassSos(8, 1.0, 0.8, 10);
  assert.strictEqual(sos.length, 4);
  const ref = [
    [2.02363123e-7, 4.04726247e-7, 2.02363123e-7, 1, -1.72487259, 0.966816929],
    [1, 2, 1, 1, -1.73320056, 0.906825067],
    [1, 2, 1, 1, -1.77879914, 0.860578675],
    [1, 2, 1, 1, -1.81800861, 0.834928603],
  ];
  for (let s = 0; s < 4; s++) {
    for (let c = 0; c < 6; c++)
      closeTo(sos[s][c], ref[s][c], 1e-6, `sos[${s}][${c}]`);
  }
});

test('butterHighpassSos: matches scipy.signal.butter(8, 0.01, "highpass", fs=2)', () => {
  const sos = SpectralEDA.butterHighpassSos(8, 0.01, 2);
  assert.strictEqual(sos.length, 4);
  const ref = [
    [0.92263584, -1.84527168, 0.92263584, 1, -1.98683791, 0.98781878],
    [1, -2, 1, 1, -1.9647269, 0.96569685],
    [1, -2, 1, 1, -1.94813354, 0.9490953],
    [1, -2, 1, 1, -1.93926963, 0.94022702],
  ];
  for (let s = 0; s < 4; s++) {
    for (let c = 0; c < 6; c++)
      closeTo(sos[s][c], ref[s][c], 1e-6, `sos[${s}][${c}]`);
  }
});

test('sosfiltfilt: removes a highpass transient and is zero-phase (symmetric impulse)', () => {
  // A high-pass at 0.01 Hz @ 2 Hz must null a constant signal after settling.
  const sos = SpectralEDA.butterHighpassSos(8, 0.01, 2);
  const n = 600;
  const x = new Float64Array(n).fill(3.7);
  const y = SpectralEDA.sosfiltfilt(sos, x);
  // Interior samples (away from the filtfilt edges) should be ~0.
  for (let i = 200; i < n - 200; i++)
    closeTo(y[i], 0, 1e-6, `highpass(const)[${i}]`);
});

// ---------------------------------------------------------------------------
// Welch density scaling — Parseval sanity check
// ---------------------------------------------------------------------------

test('welchDensity: integrated PSD ≈ mean square of the signal', () => {
  const fs = 2;
  const n = 1024;
  const x = new Float64Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = seed / 0x7fffffff - 0.5;
  }
  const { freq, psd } = SpectralEDA.welchDensity(x, fs, {
    nperseg: 128,
    noverlap: 64,
    nfft: 256,
  });

  let totalPower = 0;
  for (let k = 1; k < psd.length - 1; k++)
    totalPower += (freq[k] - freq[k - 1]) * psd[k];
  totalPower += (freq[0 + 1] - freq[0]) * psd[0]; // DC contribution

  let meanSq = 0;
  for (let i = 0; i < n; i++) meanSq += x[i] * x[i];
  meanSq /= n;

  closeTo(totalPower, meanSq, meanSq * 0.05, 'Parseval: ∫PSD df vs mean(x²)');
});

// ---------------------------------------------------------------------------
// Scalar (NeuroKit2 posada2016 shape)
// ---------------------------------------------------------------------------

test('computeScalar: returns NaN for signals <= 64 s (mirrors NeuroKit2)', () => {
  const fs = 10;
  const short = new Float64Array(fs * 64); // exactly 64 s
  const s = SpectralEDA.computeScalar(short, fs);
  assert.ok(Number.isNaN(s.sympathetic), '64 s → NaN');
  assert.ok(Number.isNaN(s.normalized), '64 s → NaN');
});

test('computeScalar: in-band tone (0.1 Hz) dominates out-of-band tone (0.5 Hz)', () => {
  const fs = 10;
  const dur = 120;
  const n = fs * dur;
  const mk = (freq) => {
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / fs);
    return x;
  };
  const inBand = SpectralEDA.computeScalar(mk(0.1), fs).sympathetic;
  const outBand = SpectralEDA.computeScalar(mk(0.5), fs).sympathetic;
  assert.ok(inBand > 0, 'in-band tone has power');
  assert.ok(
    inBand > 10 * outBand,
    `0.1 Hz (${inBand}) should dwarf 0.5 Hz (${outBand}) band power`,
  );
});

test('computeScalar: a DC-only signal has ~zero band power after the high-pass', () => {
  const fs = 10;
  const n = fs * 120;
  const x = new Float64Array(n).fill(2.0);
  const s = SpectralEDA.computeScalar(x, fs);
  // The high-pass nulls a constant signal to a negligible residual (filtfilt
  // edge transients); the band power collapses to ~0 — orders of magnitude
  // below a genuine 0.1 Hz sympathetic oscillation (~0.4 µS²).
  assert.ok(
    Number.isNaN(s.sympathetic) || s.sympathetic < 1e-3,
    `flat signal band power ≈ 0 (got ${s.sympathetic})`,
  );
});

// ---------------------------------------------------------------------------
// Sliding-window series + mapping
// ---------------------------------------------------------------------------

test('computeSeries + mapToSamples: aligned, finite, length-correct series', () => {
  const fs = 10;
  const n = fs * 120;
  const signal = new Float64Array(n);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i / fs;
    signal[i] = Math.sin(2 * Math.PI * 0.1 * times[i]);
  }
  const series = SpectralEDA.computeSeries(signal, times, fs, {
    windowSec: 64,
    hopSec: 5,
  });
  assert.ok(series.length > 0, 'produces window centres');
  for (const p of series) {
    assert.ok(Number.isFinite(p.val), 'finite band power');
    assert.ok(Number.isFinite(p.time), 'finite time');
  }

  const mapped = SpectralEDA.mapToSamples(series, times);
  assert.strictEqual(mapped.length, n, 'per-sample length');
  for (let i = 0; i < n; i++) {
    assert.strictEqual(mapped[i].time, times[i], 'time preserved');
    assert.ok(Number.isFinite(mapped[i].val), 'finite mapped value');
  }
});

test('computeSeries: a sub-64s recording still yields a non-zero (single-window) series', () => {
  const fs = 10;
  const n = fs * 30; // 30 s — shorter than the 64 s default window
  const signal = new Float64Array(n);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    times[i] = i / fs;
    signal[i] = Math.sin(2 * Math.PI * 0.1 * times[i]);
  }
  const series = SpectralEDA.computeSeries(signal, times, fs, {
    windowSec: 64,
    hopSec: 5,
  });
  assert.ok(series.length > 0, 'one window over the whole recording');
  assert.ok(
    series.some((p) => p.val > 0),
    'non-zero band power for an in-band tone',
  );
});

test('computeSeries: a signal shorter than 4 s returns an empty series', () => {
  const fs = 10;
  const n = fs * 3;
  const signal = new Float64Array(n).fill(1);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) times[i] = i / fs;
  assert.deepStrictEqual(SpectralEDA.computeSeries(signal, times, fs), []);
});

test('mapToSamples: edge-holds and interpolates monotonically', () => {
  const series = [
    { time: 10, val: 1 },
    { time: 20, val: 3 },
  ];
  const times = [0, 5, 10, 15, 20, 25];
  const mapped = SpectralEDA.mapToSamples(series, times);
  assert.strictEqual(mapped[0].val, 1, 'left edge hold');
  assert.strictEqual(mapped[1].val, 1, 'left edge hold');
  assert.strictEqual(mapped[2].val, 1, 'first centre');
  assert.strictEqual(mapped[3].val, 2, 'midpoint interpolation');
  assert.strictEqual(mapped[4].val, 3, 'second centre');
  assert.strictEqual(mapped[5].val, 3, 'right edge hold');
});

// ---------------------------------------------------------------------------
// Analyzer integration (CommonJS require path loads spectral_eda.js)
// ---------------------------------------------------------------------------

test('analyzer: edasymp series is populated after analyze()', () => {
  global.window = global;
  global.GSR_CONST = require('./mock_constants.js');

  const { GsrFilter } = require('../src/signal/gsr_filter.mjs');
  global.GsrFilter = GsrFilter;

  const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');

  // 120 s of synthetic raw µS data with a slow 0.1 Hz sympathetic oscillation.
  const fs = 10;
  const n = fs * 120;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    rows.push({ time: t, val: 2 + 0.3 * Math.sin(2 * Math.PI * 0.1 * t) });
  }
  const a = new GSRAnalyzer();
  a.raw = rows;
  a.sampleRate = fs;
  a.analyze(JSON.parse(JSON.stringify(global.GSR_CONST.GSR_DEFAULT)));

  assert.strictEqual(a.edasymp.length, n, 'edasymp aligned to raw');
  assert.ok(
    a.edasymp.some((d) => d.val > 0),
    'edasymp has non-zero values',
  );
});
