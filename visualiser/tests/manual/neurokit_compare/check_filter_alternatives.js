/**
 * Filter-alternatives race: production's 0.5s box LPF exists to knock down
 * a ~1-3Hz walking-gait/tremor artefact (see the `lpfWindow` comment in
 * constants.js) - but check_ground_truth.js's amplitude-accuracy scoring
 * found that same filter systematically UNDERESTIMATES true SCR amplitude
 * by ~28% (regression slope 0.72, r=0.9999 - a clean linear attenuation
 * traced directly to the box filter itself: lpfWindow=0 -> slope 0.98).
 * A prior investigation (see project_adaptive_gait_notch_removed memory)
 * already tried an adaptive tracked biquad notch and found no config beat
 * the plain box filter on peak-count + quality, concluding no filter tuned
 * blind on the GSR signal alone (no IMU/step channel exists) can perfectly
 * separate gait from genuine phasic activity by frequency.
 *
 * This asks a narrower question: independent of that separability ceiling,
 * is there a filter DESIGN that suppresses the same gait-band energy while
 * doing less collateral damage to genuine SCR amplitude than a plain box
 * average? Candidates include a real Butterworth lowpass and Linkwitz-Riley LR4
 * (now shipped as the `useGaitFilter` toggle - see GSR_CONST.GAIT_FILTER) and
 * BioSPPy's boxzen cascade. Savitzky-Golay was tested here too during the
 * investigation but never beat Butterworth/LR4 at gait rejection at any window
 * and was removed from production (2026-09-12); its candidates are gone from
 * this file too.
 *
 * Scores each candidate on the ORIGINAL 4 ground-truth scenarios (recall/
 * precision/amplitude accuracy, unchanged) AND the new synth_gait_tremor
 * scenario (does it suppress the tremor's spurious peaks the way the box
 * filter does, without the box filter's amplitude penalty?).
 *
 * Usage (normally via check_filter_alternatives.sh, not directly):
 *   node check_filter_alternatives.js <ground_truth_dir> <neurokit.json>
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

const originalBoxLPF = GsrFilter.applyZeroPhaseMovingAverage.bind(GsrFilter);

// decomposeTonicPhasic (gsr_filter.js) makes its OWN internal call to
// this.applyZeroPhaseMovingAverage for its local-floor offset curve (a fixed
// 4s window, unrelated to whichever main-LPF candidate this file is
// swapping in) - sharing the same function slot the candidates below
// override. Left alone, every non-box candidate would silently also replace
// that unrelated internal smoothing step with itself, which production code
// never does (its offset-smoothing always uses the real box filter,
// regardless of which main LPF stage is active). Wrap decomposeTonicPhasic
// once so its internal call is pinned to the real box filter for the
// duration of that call only, then restores whatever the current candidate
// installed - this is what actually makes "the ONLY pipeline stage that
// differs between candidates" (this file's own doc comment, below) true.
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

// ── Whittaker-Eilers smoother: penalized least squares, not a sliding
// window at all. Solves (I + lambda * D2'D2) z = y for z, where D2 is the
// second-order difference operator - trading fidelity to the raw data
// against a roughness penalty (curvature), continuously tuned by lambda
// instead of a discrete window length. No edge-padding hack needed (unlike
// the box/Savitzky-Golay filters above): the penalized least-squares
// formulation is well-posed all the way to the array boundary on its own.
// D2'D2 is pentadiagonal (bandwidth 2); built by accumulating each D2 row's
// outer product (avoids hand-deriving closed-form edge coefficients) and
// solved via banded Cholesky - O(n), verified to 1e-14 against a dense
// Gaussian-elimination reference before use here.
function buildD2TD2(n) {
  const diag0 = new Float64Array(n);
  const diag1 = new Float64Array(Math.max(0, n - 1));
  const diag2 = new Float64Array(Math.max(0, n - 2));
  for (let k = 0; k <= n - 3; k++) {
    const cols = [k, k + 1, k + 2];
    const vals = [1, -2, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const i = cols[a], j = cols[b];
        if (j < i) continue;
        const v = vals[a] * vals[b];
        if (j === i) diag0[i] += v;
        else if (j === i + 1) diag1[i] += v;
        else diag2[i] += v;
      }
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
    if (i + 1 < n) {
      let s1 = a1[i];
      if (i >= 1) s1 -= l1[i - 1] * l2[i - 1];
      l1[i] = s1 / l0[i];
    }
    if (i + 2 < n) l2[i] = a2[i] / l0[i];
  }
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = y[i];
    if (i >= 1) s -= l1[i - 1] * w[i - 1];
    if (i >= 2) s -= l2[i - 2] * w[i - 2];
    w[i] = s / l0[i];
  }
  const z = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = w[i];
    if (i + 1 < n) s -= l1[i] * z[i + 1];
    if (i + 2 < n) s -= l2[i] * z[i + 2];
    z[i] = s / l0[i];
  }
  return z;
}

// ── Zero-phase Linkwitz-Riley LR4 & Butterworth are now SHIPPED (gsr_filter.js's
// applyZeroPhaseLinkwitzRiley & applyZeroPhaseButterworth, wired into analyzer.js behind
// the useGaitFilter toggle - on by default, independent of GPS presence) - candidates below
// call the real production function directly, both to sweep cutoffs and as
// a regression check that the shipped implementation still reproduces the
// numbers this investigation was validated against.

// ── BioSPPy's production EDA-cleaning pipeline: Butterworth 5Hz order-4
// lowpass, then smoothed with a "boxzen" kernel (boxcar then Parzen window,
// each size 0.75*fs, mirror-padded) - see biosppy/signals/eda.py +
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
  const pre = prefilterHz ? GsrFilter.applyZeroPhaseButterworth(arr, prefilterHz, 4, fs) : arr;
  const size = Math.max(3, Math.round(sizeSec * fs));
  const afterBox = convolveSameMirror(pre, boxcarWindow(size));
  return convolveSameMirror(afterBox, parzenWindow(size));
}

// ── Amplitude/timing scoring - identical convention to check_ground_truth.js
const TOL = 1.0;

function amplitudeStats(pairs) {
  const n = pairs.length;
  if (n === 0) return { n: 0, meanAbsErr: NaN, meanRelErr: NaN, r: NaN, slope: NaN };
  let sumAbs = 0, sumRelAbs = 0;
  let sumD = 0, sumT = 0, sumDT = 0, sumD2 = 0, sumT2 = 0;
  for (const [detected, trueAmp] of pairs) {
    const err = detected - trueAmp;
    sumAbs += Math.abs(err);
    sumRelAbs += Math.abs(err) / trueAmp;
    sumD += detected; sumT += trueAmp; sumDT += detected * trueAmp;
    sumD2 += detected * detected; sumT2 += trueAmp * trueAmp;
  }
  const meanD = sumD / n, meanT = sumT / n;
  const cov = sumDT / n - meanD * meanT;
  const varD = sumD2 / n - meanD * meanD;
  const varT = sumT2 / n - meanT * meanT;
  return { n, meanAbsErr: sumAbs / n, meanRelErr: sumRelAbs / n, r: cov / Math.sqrt(varD * varT), slope: cov / varT };
}

function score(oursTimes, oursAmps, trueScrs) {
  const usedTrue = new Array(trueScrs.length).fill(false);
  const deltas = [];
  const ampPairs = [];
  oursTimes.forEach((t, oi) => {
    let best = -1, bestD = Infinity;
    trueScrs.forEach((tt, ti) => {
      if (usedTrue[ti]) return;
      const d = Math.abs(tt.time - t);
      if (d < bestD) { bestD = d; best = ti; }
    });
    if (best !== -1 && bestD <= TOL) {
      usedTrue[best] = true;
      deltas.push(bestD);
      if (oursAmps[oi] != null) ampPairs.push([oursAmps[oi], trueScrs[best].amplitude]);
    }
  });
  const tp = deltas.length;
  const fn = trueScrs.length - tp;
  const fp = oursTimes.length - tp;
  return {
    tp, fn, fp,
    recall: trueScrs.length ? tp / trueScrs.length : NaN,
    precision: oursTimes.length ? tp / oursTimes.length : NaN,
    amp: amplitudeStats(ampPairs),
  };
}

function fmt(label, s) {
  const pct = (x) => Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(1) + '%';
  const a = s.amp;
  const ampStr = a.n ? `slope ${a.slope.toFixed(3)}  r ${a.r.toFixed(4)}  meanRelErr ${(100 * a.meanRelErr).toFixed(1)}%` : 'n/a (no TPs)';
  return `  ${label.padEnd(22)} recall ${pct(s.recall).padStart(6)}  precision ${pct(s.precision).padStart(6)}  TP ${String(s.tp).padStart(3)} FP ${String(s.fp).padStart(4)}  amp: ${ampStr}`;
}

// ── Candidate filters. Each swaps GsrFilter.applyZeroPhaseMovingAverage for
// the run's duration then restores it - the ONLY pipeline stage that
// differs between candidates, isolating the comparison to that one stage
// exactly like check_prominence_agreement.js/check_onset_agreement.js
// isolate their own single stage.
const useOriginalBox = () => { GsrFilter.applyZeroPhaseMovingAverage = originalBoxLPF; };
// lambda has no "window in samples" equivalent - it's a continuous roughness
// penalty, not a discrete width - so these candidates ignore the ws argument
// analyzer.js computes from lpfWindow entirely; lpfWindow is set to a dummy
// nonzero value below purely so it reads sensibly in the per-scenario header.
const useWhittaker = (lambda) => () => { GsrFilter.applyZeroPhaseMovingAverage = (arr) => whittakerSmooth(arr, lambda); };
// Synthetic tracks are generated at OUTPUT_SAMPLING_RATE=10Hz (matches the
// real biomap_* tracks) - see generate_ground_truth.py.
const SYNTH_SAMPLE_RATE = 10;
const useButterworth = (cutoffHz, order) => () => { GsrFilter.applyZeroPhaseMovingAverage = (arr) => GsrFilter.applyZeroPhaseButterworth(arr, cutoffHz, order, SYNTH_SAMPLE_RATE); };
const useBoxzen = (sizeSec, prefilterHz) => () => { GsrFilter.applyZeroPhaseMovingAverage = (arr) => boxzenSmooth(arr, sizeSec, SYNTH_SAMPLE_RATE, prefilterHz); };
// Hybrid: Butterworth's steep rolloff kills the gait band with near-perfect
// amplitude fidelity, but its narrow transition band lets far more general
// sensor noise through than the box filter's broad attenuation does (see
// the dense_clean/sparse_noisy precision collapse in the Butterworth rows
// below) - mop that up with a short box pass after it.
const useButterworthPlusBox = (cutoffHz, order, boxSec) => () => {
  GsrFilter.applyZeroPhaseMovingAverage = (arr) => {
    const afterButter = GsrFilter.applyZeroPhaseButterworth(arr, cutoffHz, order, SYNTH_SAMPLE_RATE);
    return originalBoxLPF(afterButter, Math.round(boxSec * SYNTH_SAMPLE_RATE));
  };
};
const useLR4 = (cutoffHz) => () => {
  GsrFilter.applyZeroPhaseMovingAverage = (arr) => GsrFilter.applyZeroPhaseLinkwitzRiley(arr, cutoffHz, SYNTH_SAMPLE_RATE);
};

const CANDIDATES = [
  // ── Linear smoothing family (frequency-domain separation) ──
  ['none (lpfWindow=0)', useOriginalBox, { lpfWindow: 0, usePeakProminence: true }],
  ['box 0.5s (box filter default)', useOriginalBox, { lpfWindow: 0.5, usePeakProminence: true }],
  ['box 0.7s', useOriginalBox, { lpfWindow: 0.7, usePeakProminence: true }],
  ['box 0.9s', useOriginalBox, { lpfWindow: 0.9, usePeakProminence: true }],
  ['box 1.1s (manual gait fix)', useOriginalBox, { lpfWindow: 1.1, usePeakProminence: true }],
  // ── Whittaker-Eilers (penalized least squares, global roughness penalty
  // instead of a sliding window - see whittakerSmooth's doc comment above).
  ['whittaker lambda=5', useWhittaker(5), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=25', useWhittaker(25), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=50', useWhittaker(50), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=75', useWhittaker(75), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=100', useWhittaker(100), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=150', useWhittaker(150), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=200', useWhittaker(200), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=350', useWhittaker(350), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=500', useWhittaker(500), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=1000', useWhittaker(1000), { lpfWindow: 1, usePeakProminence: true }],
  ['whittaker lambda=5000', useWhittaker(5000), { lpfWindow: 1, usePeakProminence: true }],
  // ── Literature candidates (web research): NeuroKit2/BioSPPy's own
  // EDA-cleaning filter is a zero-phase Butterworth lowpass (3Hz / 5Hz
  // respectively) - real-track testing (check_gait_isolation.js) found this
  // design's steeper rolloff beats both the box filter and Whittaker by a
  // wide margin on real gait, so re-checked here against the synthetic
  // ground truth too.
  ['butterworth 2.0Hz order4', useButterworth(2.0, 4), { lpfWindow: 1, usePeakProminence: true }],
  ['butterworth 1.5Hz order4', useButterworth(1.5, 4), { lpfWindow: 1, usePeakProminence: true }],
  ['butterworth 1.2Hz order4', useButterworth(1.2, 4), { lpfWindow: 1, usePeakProminence: true }],
  ['butterworth 1.0Hz order4', useButterworth(1.0, 4), { lpfWindow: 1, usePeakProminence: true }],
  ['butterworth 0.8Hz order4', useButterworth(0.8, 4), { lpfWindow: 1, usePeakProminence: true }],
  ['butterworth 1.2Hz order2', useButterworth(1.2, 2), { lpfWindow: 1, usePeakProminence: true }],
  ['butterworth 1.0Hz order2', useButterworth(1.0, 2), { lpfWindow: 1, usePeakProminence: true }],
  ['butterworth 0.8Hz order2', useButterworth(0.8, 2), { lpfWindow: 1, usePeakProminence: true }],
  // BioSPPy's actual production EDA pipeline: Butterworth 5Hz order4, then
  // boxcar+Parzen cascade smoothing (size 0.75*fs is BioSPPy's own default).
  ['boxzen 0.75s (biosppy default)', useBoxzen(0.75, 5), { lpfWindow: 1, usePeakProminence: true }],
  ['boxzen 1.1s', useBoxzen(1.1, 5), { lpfWindow: 1, usePeakProminence: true }],
  ['boxzen 1.5s', useBoxzen(1.5, 5), { lpfWindow: 1, usePeakProminence: true }],
  // ── Hybrid: Butterworth gait-notch + short box mop-up for residual noise
  // (see useButterworthPlusBox doc comment above for why).
  ['butter 1.0Hz o4 + box 0.1s', useButterworthPlusBox(1.0, 4, 0.1), { lpfWindow: 1, usePeakProminence: true }],
  ['butter 1.0Hz o4 + box 0.2s', useButterworthPlusBox(1.0, 4, 0.2), { lpfWindow: 1, usePeakProminence: true }],
  ['butter 1.0Hz o4 + box 0.3s', useButterworthPlusBox(1.0, 4, 0.3), { lpfWindow: 1, usePeakProminence: true }],
  ['butter 0.8Hz o4 + box 0.2s', useButterworthPlusBox(0.8, 4, 0.2), { lpfWindow: 1, usePeakProminence: true }],
  ['butter 0.8Hz o4 + box 0.3s', useButterworthPlusBox(0.8, 4, 0.3), { lpfWindow: 1, usePeakProminence: true }],
  ['butter 1.0Hz o2 + box 0.1s', useButterworthPlusBox(1.0, 2, 0.1), { lpfWindow: 1, usePeakProminence: true }],
  ['butter 1.0Hz o2 + box 0.2s', useButterworthPlusBox(1.0, 2, 0.2), { lpfWindow: 1, usePeakProminence: true }],
  ['butter 0.8Hz o2 + box 0.1s', useButterworthPlusBox(0.8, 2, 0.1), { lpfWindow: 1, usePeakProminence: true }],
  ['LR4 0.9Hz (cascaded o2)', useLR4(0.9), { lpfWindow: 1, usePeakProminence: true }],
  ['LR4 1.0Hz (cascaded o2)', useLR4(1.0), { lpfWindow: 1, usePeakProminence: true }],
  ['LR4 1.1Hz (cascaded o2)', useLR4(1.1), { lpfWindow: 1, usePeakProminence: true }],
  ['LR4 1.0Hz + box 0.2s', () => { GsrFilter.applyZeroPhaseMovingAverage = (arr) => originalBoxLPF(GsrFilter.applyZeroPhaseLinkwitzRiley(arr, 1.0, 10), 2); }, { lpfWindow: 1, usePeakProminence: true }],
  // ── Shape-matched / model-based family (separates by matching a canonical
  // SCR kernel, not by frequency at all - a periodic tremor doesn't resemble
  // the asymmetric bi-exponential SCR shape regardless of its frequency, so
  // in principle these should reject it without touching genuine SCR
  // amplitude the way any linear smoother must). Tested both with the box
  // LPF still upstream (production combination today) and with it OFF
  // (lpfWindow=0), to isolate whether the shape-matching stage alone, given
  // unsmoothed input, can do the separation job by itself. Explicit
  // usePeakProminence:false is required - it otherwise wins precedence over
  // useDeconvolution/useCvxEDA in analyzer.js's detector selection.
  ['MP deconv, no LPF', useOriginalBox, { lpfWindow: 0, usePeakProminence: false, useDeconvolution: true }],
  ['MP deconv + box 0.5s', useOriginalBox, { lpfWindow: 0.5, usePeakProminence: false, useDeconvolution: true }],
  ['cvxEDA, no LPF', useOriginalBox, { lpfWindow: 0, usePeakProminence: false, useCvxEDA: true }],
  ['cvxEDA + box 0.5s', useOriginalBox, { lpfWindow: 0.5, usePeakProminence: false, useCvxEDA: true }],
  // ── SHIPPED gait filter: GSR_DEFAULT (Linkwitz-Riley LR4 1.0Hz)
  ['SHIPPED useGaitFilter:true', useOriginalBox, { useGaitFilter: true, usePeakProminence: true }],
];

const [, , gtDir, nkPath] = process.argv;
if (!gtDir) {
  console.error('Usage: node check_filter_alternatives.js <ground_truth_dir> [neurokit.json]');
  process.exit(1);
}

const files = fs.readdirSync(gtDir).filter(f => f.endsWith('.csv'));
const nkAll = nkPath && fs.existsSync(nkPath) ? JSON.parse(fs.readFileSync(nkPath, 'utf8')) : {};

// lpfWindow is in SECONDS in GSR_DEFAULT but analyzer.js converts to samples
// itself (params.lpfWindow * this.sampleRate) before calling
// applyZeroPhaseMovingAverage - so windowSize arriving at our override is
// already in SAMPLES.
for (const file of files) {
  const name = path.basename(file, '.csv');
  const csvText = fs.readFileSync(path.join(gtDir, file), 'utf8');
  const gt = JSON.parse(fs.readFileSync(path.join(gtDir, `${name}.ground_truth.json`), 'utf8'));
  const trueScrs = gt.scrs;

  console.log(`=== ${name}: ${trueScrs.length} true SCRs (duration ${gt.params.duration}s, noise ${gt.params.noise}${gt.params.gait_freq ? `, gait ${gt.params.gait_freq}Hz@${gt.params.gait_amplitude}uS` : ''}) ===`);

  for (const [label, installFilter, patch] of CANDIDATES) {
    installFilter();
    const a = new GSRAnalyzer();
    a.parseCSV(csvText);
    a.analyze({ ...D, medianSize: 0, useGaitFilter: false, usePeakProminence: false, useCvxEDA: false, useDeconvolution: false, ...patch }, 0);
    const times = a.peaks.map(p => p.time);
    const amps = a.peaks.map(p => p.amplitude);
    console.log(fmt(label, score(times, amps, trueScrs)));
  }
  GsrFilter.applyZeroPhaseMovingAverage = originalBoxLPF;

  const nk = nkAll[name];
  if (nk) console.log(fmt('NeuroKit2 (ref, 3Hz Butterworth)', score(nk.peak_times, nk.peak_amplitudes || [], trueScrs)));
  console.log();
}
