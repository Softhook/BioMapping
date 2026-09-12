/**
 * Real-track gait-isolation test — isolates the walking-footstep artefact
 * on real BioMapping data by evidence, then scores candidate filters
 * against it.
 *
 * The artefact is real human footstep impact, ~1.4-2.0Hz (each leg strikes
 * independently, so impact frequency runs ~2x stride frequency - ~1.6-2.2Hz
 * for a normal walking cadence). Verified two ways on biomap_059 (the
 * longest track, most walking time): (1) directly visible in the raw GSR
 * trace as a clean, consistent ~0.6s peak spacing (e.g. @ 711.5-715.5s),
 * and (2) a continuous sliding-window test (8s window, 4s step - 527
 * windows spanning a real speed gradient) correlating detrended 1.4-2.0Hz
 * band power directly against simultaneous GPS speed: Pearson r=0.248 (far
 * past significance at that n), with a monotonic dose-response - band
 * share 26.8% at medium pace (0.5-1.0 m/s) rising to 36.5% at brisk pace
 * (1.0-1.5 m/s). Each segment is detrended (subtract a 2s moving average)
 * before its periodogram is taken - the slow tonic/SCR-rise trend
 * dominates raw power and will otherwise mask this smaller but real
 * higher-frequency ripple entirely.
 *
 * Scores each candidate filter by how much it reduces this speed-
 * correlated 1.4-2.0Hz signal (both the correlation coefficient and the
 * medium-vs-brisk band-share gap), alongside whole-track peak count / mean
 * quality / summed amplitude cost (same metrics the 2026-09-04 adaptive-
 * gait-notch investigation used, for comparability).
 *
 * Usage: node check_gait_isolation.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.GSR_CONST = require('../../mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`), `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}

const SRC = path.join(__dirname, '../../../src/signal');
loadModule(path.join(SRC, 'dwt_filter.js'), 'DWT');
loadModule(path.join(SRC, 'gsr_filter.js'), 'GsrFilter');
global.CVXEDA = require(path.join(SRC, 'cvxeda.js'));
loadModule(path.join(SRC, 'deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(SRC, 'csv_parser.js'), 'GSRCSVParser');
loadModule(path.join(SRC, 'analyzer.js'), 'GSRAnalyzer');
const { GSRAnalyzer, GsrFilter } = global;
const D = global.GSR_CONST.GSR_DEFAULT;
const TRACKS_DIR = path.join(__dirname, '../../../../tracks');

const originalBoxLPF = GsrFilter.applyZeroPhaseMovingAverage.bind(GsrFilter);
const originalButterworth = GsrFilter.applyZeroPhaseButterworth.bind(GsrFilter);

// decomposeTonicPhasic (gsr_filter.js) makes its OWN internal call to
// this.applyZeroPhaseMovingAverage for its local-floor offset curve (a fixed
// 4s window, unrelated to whichever main-LPF candidate this test is
// swapping in) - sharing the same function slot the candidates below
// override. Left alone, every non-box candidate would silently also replace
// that unrelated internal smoothing step with itself, which production code
// never does (its offset-smoothing always uses the real box filter,
// regardless of which main LPF stage is active). Wrap decomposeTonicPhasic
// once so its internal call is pinned to the real box filter for the
// duration of that call only, then restores whatever the current candidate
// installed - this is what actually makes "only the main LPF stage differs
// between candidates" (this file's whole premise) true.
const originalDecompose = GsrFilter.decomposeTonicPhasic.bind(GsrFilter);
GsrFilter.decomposeTonicPhasic = function (...args) {
  const savedFn = GsrFilter.applyZeroPhaseMovingAverage;
  GsrFilter.applyZeroPhaseMovingAverage = originalBoxLPF;
  try {
    return originalDecompose(...args);
  } finally {
    GsrFilter.applyZeroPhaseMovingAverage = savedFn;
  }
};

// ── Whittaker-Eilers (verified against a dense-matrix reference to 1e-14 -
// see check_filter_alternatives.js in ../neurokit_compare/).
function buildD2TD2(n) {
  const diag0 = new Float64Array(n), diag1 = new Float64Array(Math.max(0, n - 1)), diag2 = new Float64Array(Math.max(0, n - 2));
  for (let k = 0; k <= n - 3; k++) {
    const cols = [k, k + 1, k + 2], vals = [1, -2, 1];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      const i = cols[a], j = cols[b];
      if (j < i) continue;
      const v = vals[a] * vals[b];
      if (j === i) diag0[i] += v; else if (j === i + 1) diag1[i] += v; else diag2[i] += v;
    }
  }
  return { diag0, diag1, diag2 };
}
function whittakerSmooth(y, lambda) {
  const n = y.length;
  if (n < 5) return [...y];
  const { diag0, diag1, diag2 } = buildD2TD2(n);
  const a0 = new Float64Array(n), a1 = new Float64Array(n - 1), a2 = new Float64Array(n - 2);
  for (let i = 0; i < n; i++) a0[i] = 1 + lambda * diag0[i];
  for (let i = 0; i < n - 1; i++) a1[i] = lambda * diag1[i];
  for (let i = 0; i < n - 2; i++) a2[i] = lambda * diag2[i];
  const l0 = new Float64Array(n), l1 = new Float64Array(n - 1), l2 = new Float64Array(n - 2);
  for (let i = 0; i < n; i++) {
    let s = a0[i];
    if (i >= 1) s -= l1[i - 1] * l1[i - 1];
    if (i >= 2) s -= l2[i - 2] * l2[i - 2];
    l0[i] = Math.sqrt(Math.max(s, 1e-300));
    if (i + 1 < n) { let s1 = a1[i]; if (i >= 1) s1 -= l1[i - 1] * l2[i - 1]; l1[i] = s1 / l0[i]; }
    if (i + 2 < n) l2[i] = a2[i] / l0[i];
  }
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = y[i]; if (i >= 1) s -= l1[i - 1] * w[i - 1]; if (i >= 2) s -= l2[i - 2] * w[i - 2]; w[i] = s / l0[i]; }
  const z = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = w[i]; if (i + 1 < n) s -= l1[i] * z[i + 1]; if (i + 2 < n) s -= l2[i] * z[i + 2]; z[i] = s / l0[i]; }
  return z;
}

// ── Zero-phase Linkwitz-Riley LR4 (cascaded Butterworth o2) is now SHIPPED
// (gsr_filter.js's applyZeroPhaseLinkwitzRiley, wired into analyzer.js behind
// the useGaitFilter toggle - on by default, independent of GPS presence) -
// this candidate list calls the real production function directly, both to
// sweep cutoffs and as a regression check that the shipped implementation
// still reproduces the numbers this investigation was validated against.

// ── BioSPPy's production EDA-cleaning pipeline: Butterworth 5Hz order-4
// lowpass, then smoothed with a "boxzen" kernel (boxcar then Parzen window,
// each size 0.75*fs, mirror-padded) — see biosppy/signals/eda.py +
// tools.smoother(). Both kernels are symmetric FIR, so a single convolution
// pass per stage is already zero-phase (no forward/backward trick needed).
function parzenWindow(M) {
  const w = new Array(M);
  const half = (M - 1) / 2;
  for (let idx = 0; idx < M; idx++) {
    const n = idx - half;
    const an = Math.abs(n) / (M / 2);
    w[idx] = Math.abs(n) <= (M - 1) / 4
      ? 1 - 6 * an * an * (1 - an)
      : 2 * Math.pow(1 - an, 3);
  }
  return w;
}
function boxcarWindow(M) { return new Array(M).fill(1); }
function convolveSameMirror(arr, kernel) {
  const n = arr.length, k = kernel.length;
  const sum = kernel.reduce((a, b) => a + b, 0);
  const norm = kernel.map(v => v / sum);
  const half = Math.floor(k / 2);
  const get = (i) => i < 0 ? arr[0] : i >= n ? arr[n - 1] : arr[i];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += norm[j] * get(i + j - half);
    out[i] = s;
  }
  return out;
}
function boxzenSmooth(arr, sizeSec, fs, prefilterHz) {
  const pre = prefilterHz ? originalButterworth(arr, prefilterHz, 4, fs) : arr;
  const size = Math.max(3, Math.round(sizeSec * fs));
  const afterBox = convolveSameMirror(pre, boxcarWindow(size));
  return convolveSameMirror(afterBox, parzenWindow(size));
}

function parseSpeed(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
  const header = lines[0].split(',');
  const iSpeed = header.indexOf('speed_kts');
  const speeds = new Array(lines.length - 1).fill(null);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const v = parseFloat(cols[iSpeed]);
    speeds[i - 1] = isNaN(v) ? null : v * 0.514444;
  }
  return speeds;
}

// Detrend (subtract a 2s moving average - short enough to preserve genuine
// footstep ripple, long enough to remove SCR/tonic-scale trend) + Hann
// window a single contiguous segment, returning the band power fraction at
// gaitFreqs relative to the segment's own total power in totalFreqs. Must
// run per-segment, never over concatenated/discontinuous ranges (that
// injects spurious low-frequency leakage at each artificial boundary).
function bandShareOfSegment(vals, sampleRate, gaitFreqs, totalFreqs) {
  const n = vals.length;
  const trendWin = Math.round(2.0 * sampleRate);
  const half = Math.floor(trendWin / 2);
  const detrended = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += vals[j];
    detrended[i] = vals[i] - s / (hi - lo + 1);
  }
  const win = new Array(n);
  let winEnergy = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    win[i] = detrended[i] * h;
    winEnergy += h * h;
  }
  const power = (freqs) => {
    let total = 0;
    for (const f of freqs) {
      let re = 0, im = 0;
      const w = 2 * Math.PI * f / sampleRate;
      for (let i = 0; i < n; i++) { re += win[i] * Math.cos(w * i); im -= win[i] * Math.sin(w * i); }
      total += (re * re + im * im) / winEnergy;
    }
    return total;
  };
  return power(gaitFreqs) / power(totalFreqs);
}

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return cov / Math.sqrt(vx * vy);
}

const GAIT_FREQS = [1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0];
const TOTAL_FREQS = [];
for (let f = 0.2; f <= 4.0; f += 0.1) TOTAL_FREQS.push(Math.round(f * 10) / 10);
const WINDOW_SEC = 8, STEP_SEC = 4;

function slidingSpeedCorrelation(phasicVals, speeds, sampleRate) {
  const windowSamples = Math.round(WINDOW_SEC * sampleRate);
  const stepSamples = Math.round(STEP_SEC * sampleRate);
  const speedSamples = [], shareSamples = [];
  for (let start = 0; start + windowSamples <= phasicVals.length; start += stepSamples) {
    const speedSeg = speeds.slice(start, start + windowSamples).filter(s => s != null);
    if (speedSeg.length < windowSamples * 0.8) continue;
    const meanSpeed = speedSeg.reduce((s, v) => s + v, 0) / speedSeg.length;
    const share = bandShareOfSegment(phasicVals.slice(start, start + windowSamples), sampleRate, GAIT_FREQS, TOTAL_FREQS);
    speedSamples.push(meanSpeed);
    shareSamples.push(share);
  }
  const r = pearson(speedSamples, shareSamples);
  const medium = shareSamples.filter((_, i) => speedSamples[i] >= 0.5 && speedSamples[i] < 1.0);
  const brisk = shareSamples.filter((_, i) => speedSamples[i] >= 1.0 && speedSamples[i] < 1.5);
  const mediumMean = medium.length ? medium.reduce((a, b) => a + b, 0) / medium.length : NaN;
  const briskMean = brisk.length ? brisk.reduce((a, b) => a + b, 0) / brisk.length : NaN;
  return { r, mediumMean, briskMean, n: speedSamples.length, nMedium: medium.length, nBrisk: brisk.length };
}

// biomap_059 is sampled at 10Hz (0.1s steps, confirmed from its CSV).
const TRACK_SAMPLE_RATE = 10;

// Savitzky-Golay was removed from production (2026-09-12): it barely
// touched the walking-gait artefact at any window tested, so once a real
// Butterworth gait filter existed there was no trade-off left where Savgol
// still won. Its candidates are gone from this sweep along with it.
//
// The shipped Linkwitz-Riley LR4 gait filter is now an explicit opt-in toggle
// (GSR_DEFAULT.useGaitFilter), not automatic on GPS presence - analyzer.js
// calls applyZeroPhaseLinkwitzRiley when a caller passes
// useGaitFilter:true. Every candidate below therefore just overrides the ONE
// function analyzer.js calls by default (applyZeroPhaseMovingAverage); only
// useProductionDefault below exercises the real toggle end-to-end.
//
// decomposeTonicPhasic (gsr_filter.js) makes its own separate internal call
// to this.applyZeroPhaseMovingAverage (for its local-floor offset curve, a
// 4s window unrelated to the main LPF stage this test overrides) - the
// wrapper above pins that call to the real box filter regardless of which
// candidate is currently installed, so "only the main LPF stage differs
// between candidates" is actually true.
const useNone = () => { GsrFilter.applyZeroPhaseMovingAverage = originalBoxLPF; };
const useBox = (windowSec) => () => {
  GsrFilter.applyZeroPhaseMovingAverage = (arr) => originalBoxLPF(arr, Math.round(windowSec * TRACK_SAMPLE_RATE));
};
const useWhittaker = (lambda) => () => { GsrFilter.applyZeroPhaseMovingAverage = (arr) => whittakerSmooth(arr, lambda); };
const useButterworth = (cutoffHz, order) => () => {
  GsrFilter.applyZeroPhaseMovingAverage = (arr) => originalButterworth(arr, cutoffHz, order, TRACK_SAMPLE_RATE);
};
const useBoxzen = (sizeSec, prefilterHz) => () => {
  GsrFilter.applyZeroPhaseMovingAverage = (arr) => boxzenSmooth(arr, sizeSec, TRACK_SAMPLE_RATE, prefilterHz);
};
// Hybrid: Butterworth's steep rolloff kills the gait band with near-perfect
// amplitude fidelity, but its narrow transition band lets far more general
// sensor noise through than the box filter's broad attenuation does (found
// via the synthetic non-gait scenarios in check_filter_alternatives.js) - so
// mop up that residual noise with a short box pass after it, short enough
// that it costs little of the amplitude fidelity Butterworth just bought.
const useButterworthPlusBox = (cutoffHz, order, boxSec) => () => {
  GsrFilter.applyZeroPhaseMovingAverage = (arr) => {
    const afterButter = originalButterworth(arr, cutoffHz, order, TRACK_SAMPLE_RATE);
    return originalBoxLPF(afterButter, Math.round(boxSec * TRACK_SAMPLE_RATE));
  };
};
const useLR4 = (cutoffHz) => () => {
  GsrFilter.applyZeroPhaseMovingAverage = (arr) => GsrFilter.applyZeroPhaseLinkwitzRiley(arr, cutoffHz, TRACK_SAMPLE_RATE);
};
// Restores the real box function - the real applyZeroPhaseLinkwitzRiley is
// exercised via the useGaitFilter:true param patch below instead, an
// end-to-end check against the real toggle + GSR_CONST.GAIT_FILTER rather
// than a hardcoded literal.
const useProductionDefault = () => { GsrFilter.applyZeroPhaseMovingAverage = originalBoxLPF; };

// Every candidate below pins useGaitFilter:false explicitly - D (GSR_DEFAULT)
// now ships useGaitFilter:true, and without the explicit override every
// candidate here would silently spread that true value in from D, take the
// useGaitFilter branch in analyzer.js, and run the real production
// filter instead of the one this candidate just installed (and which
// never gets called on the useGaitFilter:true branch).
const CANDIDATES = [
  ['none (lpfWindow=0)', useNone, { lpfWindow: 0, useGaitFilter: false }],
  ['box 0.5s (box filter default)', useBox(0.5), { lpfWindow: 1, useGaitFilter: false }],
  ['box 0.9s', useBox(0.9), { lpfWindow: 1, useGaitFilter: false }],
  ['box 1.1s (manual gait fix)', useBox(1.1), { lpfWindow: 1, useGaitFilter: false }],
  ['box 1.3s', useBox(1.3), { lpfWindow: 1, useGaitFilter: false }],
  ['whittaker lambda=50', useWhittaker(50), { lpfWindow: 1, useGaitFilter: false }],
  ['whittaker lambda=200', useWhittaker(200), { lpfWindow: 1, useGaitFilter: false }],
  ['whittaker lambda=1000', useWhittaker(1000), { lpfWindow: 1, useGaitFilter: false }],
  ['butterworth 2.0Hz order4', useButterworth(2.0, 4), { lpfWindow: 1, useGaitFilter: false }],
  ['butterworth 1.5Hz order4', useButterworth(1.5, 4), { lpfWindow: 1, useGaitFilter: false }],
  ['butterworth 1.2Hz order4', useButterworth(1.2, 4), { lpfWindow: 1, useGaitFilter: false }],
  ['butterworth 1.0Hz order4', useButterworth(1.0, 4), { lpfWindow: 1, useGaitFilter: false }],
  ['butterworth 0.8Hz order4', useButterworth(0.8, 4), { lpfWindow: 1, useGaitFilter: false }],
  ['butterworth 1.2Hz order2', useButterworth(1.2, 2), { lpfWindow: 1, useGaitFilter: false }],
  ['butterworth 1.0Hz order2', useButterworth(1.0, 2), { lpfWindow: 1, useGaitFilter: false }],
  ['boxzen 0.75s (biosppy default)', useBoxzen(0.75, 5), { lpfWindow: 1, useGaitFilter: false }],
  ['boxzen 1.1s', useBoxzen(1.1, 5), { lpfWindow: 1, useGaitFilter: false }],
  ['boxzen 1.5s', useBoxzen(1.5, 5), { lpfWindow: 1, useGaitFilter: false }],
  ['LR4 1.1Hz', useLR4(1.1), { lpfWindow: 1, useGaitFilter: false }],
  ['LR4 1.0Hz (production)', useLR4(1.0), { lpfWindow: 1, useGaitFilter: false }],
  ['LR4 0.9Hz', useLR4(0.9), { lpfWindow: 1, useGaitFilter: false }],
  ['LR4 0.8Hz', useLR4(0.8), { lpfWindow: 1, useGaitFilter: false }],
  // ── SHIPPED: GSR_DEFAULT.useGaitFilter:true + GSR_CONST.GAIT_FILTER
  // (LR4 1.0Hz) - should match the "LR4 1.0Hz (production)" row exactly;
  // exists as an end-to-end check against the real toggle + constant.
  ['SHIPPED useGaitFilter:true', useProductionDefault, { lpfWindow: 1, useGaitFilter: true }],
];

const targetTracks = process.argv.slice(2).length ? process.argv.slice(2) : ['biomap_024.csv', 'biomap_059.csv'];

for (const trackFile of targetTracks) {
  const csvPath = path.join(TRACKS_DIR, trackFile);
  if (!fs.existsSync(csvPath)) continue;
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const speeds = parseSpeed(csvPath);

  console.log(`\n=== ${trackFile}: speed-correlated 1.4-2.0Hz band, continuous sliding-window analysis ===\n`);
  for (const [label, installFilter, patch] of CANDIDATES) {
    installFilter();
    const a = new GSRAnalyzer();
    a.parseCSV(csvText);
    a.analyze({ ...D, medianSize: 0, ...patch }, 0);
    const phasicVals = a.phasic.map(d => d.val);
    const { r, mediumMean, briskMean, nMedium, nBrisk } = slidingSpeedCorrelation(phasicVals, speeds, a.sampleRate);
    const meanQuality = a.peaks.length ? a.peaks.reduce((s, p) => s + p.qualityScore, 0) / a.peaks.length : 0;
    const sumAmp = a.peaks.reduce((s, p) => s + p.amplitude, 0);
    console.log(`  ${label.padEnd(28)} r=${(isNaN(r)?'   NaN':r.toFixed(3)).padStart(6)}  medium%=${(100 * (mediumMean||0)).toFixed(1).padStart(5)}(n=${nMedium})  brisk%=${(100 * (briskMean||0)).toFixed(1).padStart(5)}(n=${nBrisk})  gap=${(100 * ((briskMean||0) - (mediumMean||0))).toFixed(1).padStart(5)}pp   |   peaks=${String(a.peaks.length).padStart(4)}  meanQuality=${meanQuality.toFixed(3)}  sumAmp=${sumAmp.toFixed(1)}`);
  }
}
GsrFilter.applyZeroPhaseMovingAverage = originalBoxLPF;
