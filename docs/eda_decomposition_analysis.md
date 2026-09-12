# EDA Decomposition: Implementation Analysis & Competing Approaches

> **Architecture & Algorithmic Reference.**
> Documents the signal processing, decomposition, and peak-detection pipelines in
> `visualiser/src/signal/`, compared against published literature and competing scientific toolboxes
> (NeuroKit2, Ledalab, cvxEDA, PsPM, BioSPPy).
> Companion to `environmental_stress_literature_review.md` and `peak_density_vs_spatial_clustering.md`.

---

## 1. System Pipeline Architecture

BioMapping processes ambulatory electrodermal activity (EDA) recorded during unrestrained urban walking.
The complete data flow executes in real-time in modern browser JavaScript without server-side dependencies:

```
Raw CSV Stream (10 Hz)
  │
  ▼
[1. Signal Calibration & Unit Normalization]
  • Auto-detects raw ADC codes vs. direct microSiemens (µS)
  • Clamps non-negative physiological conductance: SC(t) ≥ 0
  │
  ▼
[2. Cleaning & Ambulatory Gait Filter]
  • Artifact Median Filter (optional, rank-based nonlinear spike removal)
  • Linkwitz-Riley 4th-Order Lowpass (LR4, 1.0 Hz, zero-phase cascaded Butterworth)
    ↳ Rejects 1.4–2.0 Hz footstep impact tremor while preserving true SCR peak amplitudes
  │
  ▼
[3. Phasic / Tonic Decomposition]
  ├─ Baseline Pipeline: Zero-phase EMA, sliding median, or sliding 10th-percentile tonic
  │    ↳ Phasic residual: SC_phasic(t) = max(0, SC_clean(t) − SC_tonic(t))
  ├─ cvxEDA Pipeline (Greco et al. 2016): Joint convex QP via interior-point Newton solver
  │    ↳ Decomposes y = A·r + C·l + ε (sparse driver r, B-spline tonic l)
  ├─ Matching Pursuit Pipeline (Bach & Staib 2015): Greedy Bateman kernel deconvolution
  └─ SparsEDA Pipeline (Hernando-Gallego et al. 2018): multi-width dictionary deconvolution
       (implemented, config-only — see §3.D)
  │
  ▼
[4. Discrete Peak Detection]
  ├─ Full-Scan (Default): Non-greedy trough-to-peak scan + SNR & Peak Quality gating
  ├─ Topographic Prominence: Scale-free persistence scan with boundary-saddle correction
  ├─ cvxEDA Driver: Peak picking on sparse driver impulses
  └─ Deconvolution Driver: Peak picking on reconstructed driver curve
  │
  ▼
[5. Feature Extraction & Continuous Metrics]
  • Peak amplitudes (µS), rise times (10–90%), half-recovery times (t_50), quality scores
  • Continuous Arousal: Phasic AUC vs. Driver ISCR (Benedek & Kaernbach 2010b)
```

---

## 2. Walking Gait Artefact & Production LR4 Filter

### The Ambulatory Challenge
Ambulatory EDA recordings are subject to repetitive motion contamination. Each footstep impact induces a mechanical micro-tremor in electrode-skin contact impedance. 

On ambulatory recordings with brisk walking, such as **Track 24** (`biomap_024.csv`, 17.4 minutes sustained walking at a mean GPS speed of 1.28 m/s):
- **Resonance Peak**: Spectral decomposition of the raw phasic signal reveals a sharp footstep resonance peak centered at **1.8 Hz** (cadence power = 64.29, matching physical step frequency $1.1 + 0.6 \cdot v = 1.87$ Hz).
- **Tremor Excursions**: Measured footstep vibration has an RMS magnitude of **0.026 µS** and typical peak-to-peak excursions of **0.073 µS** (up to 0.23 µS).
- **False Peak Induction**: Because the standard physiological SCR threshold (`peakThreshold`) is **0.015 µS**, mechanical footstep tremor is **nearly 5× larger than the threshold**. On unfiltered raw data, this tremor hallucinates **484 peaks** (over 160 false footstep cycles).

### Comparison of Filtering Approaches

| Filter Design | Order / Cutoff | Passband Fidelity | Stopband Rolloff | Footstep Ripple Suppression | Phase Delay | Transient Ringing |
|---|---|---|---|---|---|---|
| **Raw (No LPF)** | None | 100% | 0 dB | None (484 peaks) | 0 | None |
| **Box Moving Average** | 0.5s window ($f_{\text{null}} = 2.0$ Hz) | Blunts sharp SCR apices by 6–10% | Sinc sidelobes pass 21% @ 3 Hz | Incomplete (12 ripple cycles leak) | Zero-phase | None |
| **Wide Box Average** | 1.1s window ($f_{\text{null}} = 0.9$ Hz) | **Destroys 26% of signal amplitude** | Sinc sidelobes pass 12.08 power | Drops 91 real SCRs | Zero-phase | Heavy smearing |
| **Butterworth Order 4** | 4th order, 0.8 Hz | Flat passband | −80 dB/dec | Strong | Zero-phase | **Underdamped ringing ($Q = 1.31$)** |
| **Linkwitz-Riley 4 (LR4)** | **Cascaded o2, 1.0 Hz** | **>95% SCR amplitude preserved** | **−80 dB/dec monotonic** | **Complete (0.0% brisk gait share)** | **Zero-phase** | **Critically damped ($Q = 0.7071$)** |

### Mathematical Specification of the Production LR4 Filter
BioMapping implements the gait filter via `GsrFilter.applyZeroPhaseLinkwitzRiley(signal, cutoffHz, sampleRate)`:
1. **Transfer Function**: An LR4 filter is formed by cascading two identical 2nd-order Butterworth low-pass filters in series:
   $$H_{\text{LR4}}(s) = \left[ H_{\text{Butter2}}(s) \right]^2 = \left[ \frac{\omega_c^2}{s^2 + \sqrt{2}\omega_c s + \omega_c^2} \right]^2$$
2. **Damping Factor ($Q$)**: Standard 4th-order Butterworth filters factor into two biquads with quality factors $Q_1 = 0.5412$ and $Q_2 = 1.3065$. Because $Q_2 > 0.7071$, standard Butterworth filters exhibit resonant peaking in the frequency domain and ringing in the time domain. In contrast, LR4 cascades two $Q = 1/\sqrt{2} \approx 0.7071$ stages, ensuring **critical damping** with no resonant peaking.
3. **Zero-Phase Forward-Backward Execution (`filtfilt`)**: The signal is filtered forward, reversed, and filtered again. This squares the magnitude response while cancelling all phase distortion:
   $$|H_{\text{ZP-LR4}}(\omega)| = |H_{\text{LR4}}(\omega)|^2 = \frac{1}{\left(1 + (\omega / \omega_c)^4\right)^2}$$
   - Passband attenuation at $f_c = 1.0$ Hz is exactly −6.0 dB.
   - Stopband attenuation rolls off at −80 dB/decade (−48 dB/octave zero-phase), providing 99.2% attenuation at the 1.8 Hz footstep cadence.
   - Forward-backward filtering ensures zero sample delay, aligning SCR onsets and peaks perfectly with GPS coordinates.

### Empirical Validation on Real Walking Tracks

#### Track 24 (`biomap_024.csv`, 17.4 min sustained brisk walk, mean speed 1.28 m/s):
- **Raw (No LPF)**: 484 peaks, summed amplitude 38.4 µS, mean quality 0.679, brisk gait energy share 42.1%.
- **Prior Box 0.5s**: 315 peaks, summed amplitude 27.2 µS, mean quality 0.758, brisk gait energy share 2.3% (leaked 12 ripple cycles).
- **Manual Fix (Box 1.1s)**: 224 peaks, summed amplitude 20.2 µS (−26% loss), mean quality 0.743 (wiped out 91 genuine physiological peaks).
- **Butterworth o4 (0.8 Hz)**: 319 peaks, summed amplitude 29.4 µS, mean quality 0.759 (underdamped ringing on noise spikes).
- **Production LR4 (1.0 Hz)**: **311 peaks**, summed amplitude **28.4 µS**, max peak **4.56 µS**, mean quality **0.761** (highest across all filters), brisk gait energy share **0.0%**.
  - Restores **+6.0% amplitude** on genuine matched peaks over Box 0.5s.
  - Suppresses all 12 footstep ripple cycles without destroying genuine response energy.

#### Track 59 (`biomap_059.csv`, 52.7 min variable-speed walk, mean speed 0.97 m/s):
- Brisk-pace gait band share reduced from **36.5%** (raw) to **0.0%** (LR4).
- Mean peak quality: **0.771** (highest).
- Total amplitude: **142.0 µS** (vs. 107.0 µS under Box 1.1s).

---

## 3. Phasic / Tonic Decomposition Implementations

All EDA decomposition models share the physiological assumption:
$$y(t) = \text{tonic}(t) + \text{phasic}(t) + \varepsilon(t) = s(t) + [x(t) * h(t)] + \varepsilon(t)$$
where $s(t)$ is the slowly varying Skin Conductance Level (SCL), $x(t) \ge 0$ is the non-negative sympathetic sudomotor burst driver, and $h(t)$ is the biexponential Bateman impulse response function (SCRF):
$$h(t) = e^{-t / \tau_{\text{slow}}} - e^{-t / \tau_{\text{fast}}} \quad (t \ge 0)$$

BioMapping provides three distinct decomposition engines:

### A. Baseline Sequential Decomposition (EMA / Median / Percentile)
- **Tonic Extraction**: `tonicMethod` selects a zero-phase Exponential Moving Average (`'lpf'`, the default), a sliding median (`'median'`), or a sliding 10th-percentile filter (`'percentile'`) over a `tonicWindow`-second window, followed by a shared local-floor repositioning pass (±6 s running min, 4 s smoothed) that keeps the tonic from ever riding above the signal.
- **Phasic Extraction**: $SC_{\text{phasic}}(t) = \max(0, SC_{\text{clean}}(t) - SC_{\text{tonic}}(t))$.
- **Characteristics**: Fast, $O(n)$ deterministic execution, highly robust for real-time visualization and general spatial mapping.

### B. cvxEDA Convex Optimization (Greco et al. 2016)
Implemented in `visualiser/src/signal/cvxeda.js` and accessible via the `useCvxEDA` toggle:
- **Optimization Formulation**: Solves the Quadratic Program:
  $$\min_{q, l} \frac{1}{2}\|Mq + Cd + Bl - y\|_2^2 + \alpha \mathbf{1}^T A q + \frac{\gamma}{2}\|l\|_2^2 \quad \text{s.t.} \quad Aq \ge 0$$
  where $q$ is the ARMA-parameterized driver, $C$ and $B$ represent the cubic B-spline tonic basis and linear drift, and $A$ enforces non-negativity of the driver ($r = Aq \ge 0$).
- **Solver Architecture**: Not an ADMM approximation — an in-browser port of the *same* algorithm CVXOPT uses for the reference implementation, a Mehrotra predictor-corrector primal-dual interior-point method:
  - Each Newton step solves $(M^T M + A^T \text{diag}(z/s) A) \Delta x = \text{rhs}$ for $x = [q; d; l]$ via a direct banded Cholesky factor on the pentadiagonal $q$-block.
  - The small coupled drift/spline unknowns ($2 + n_B$ dimensions) are eliminated by a Schur complement, rebuilt every Newton step since the per-sample weight changes every step.
  - Typical tracks converge in **10–25 Newton iterations** (maxIter cap 50, rarely bound) — far fewer than a first-order ADMM solver needs for comparable accuracy.
- **Parameter Calibration**:
  - Input is $z$-score standardized ($zero\text{ mean}, unit\text{ variance}$) to preserve paper-calibrated penalties.
  - $\alpha = 2 \times 10^{-3}$ in production (`GSR_CONST.CVXEDA.alpha`): scaled up from the paper's 25 Hz default ($8 \times 10^{-4}$) to account for BioMapping's 10 Hz acquisition rate — the same inter-event sparsity needs a proportionally stronger penalty at the lower rate.
  - $\gamma = 10^{-2}$: enforces smoothness on the second derivative of the tonic B-spline.
- **Agreement with Reference**: Cross-checked numerically against real `cvxopt` output (`tests/test_cvxeda_reference.js`) — phasic/tonic relRMSE $\approx 10^{-6}$ (committed assertion: $< 10^{-4}$), driver relRMSE $< 10^{-3}$. Both being convex QP solves to the same KKT optimality certificate, this is expected: they converge to the same point, not merely a correlated one.
- **Discrete Peak Detection (Ledalab-CDA-style, 2026-09-12)**: The decomposition above is correct, but peak-picking directly on the smoothed reconstruction $r = Mq$ is not — cvxEDA's L1 penalty achieves sparsity via an optimisation constraint rather than a hard threshold, so small residual driver values between genuine events still convolve through the Bateman kernel into faint curve ripple that a naive local-maximum scan mistakes for extra SCRs (82 false positives / 69.4% precision on the clean synthetic suite). Following Ledalab's CDA method (Benedek & Kaernbach 2010a), candidate events are now detected directly in the sparse driver $p = Aq$ instead, each resolved to its true apex in the reconstructed curve via a kernel-offset search window (`analyzer.js`'s `_runDeconvolutionPipeline` cvxEDA branch, feeding a new `candidateIndices` parameter on `_detectPeaksFromCurve`; the matching-pursuit path is unaffected). Result on the same clean synthetic suite: false positives 82→43, precision 69.4%→81.1%, F1 0.778→0.845, amplitude $r$ 0.74→0.84, for a negligible recall cost (88.6%→88.1%). A follow-up sweep of the driver-candidate detection parameters (`neurokit_comparison_plan.md` item 20) found cvxEDA's own `minImpulseGapSec`/apex-search-window needed independent tuning from the inherited matching-pursuit values — promoted `cvxMinImpulseGapSec: 0.8`, `cvxApexSearchHalfWinSec: 1.0` to production, improving precision further (81.1%→84.1% clean, 49.3%→55.4% on the full 10-scenario suite) and amplitude accuracy ($r$ 0.84→0.89 clean, 0.86→0.90 full suite) for a further ~1pp aggregate recall cost concentrated in noisy/gait/walking scenarios (clean-suite and compound-burst recall were unaffected or improved). See `neurokit_comparison_plan.md` items 19–20 for the full before/after tables (synthetic and real-track). Still well behind Full-Scan/Prominence — this narrows, not closes, the gap.
- **Independent validation (2026-09-12, item 21)**: is this fix specific to BioMapping's own JS port, or a real property of cvxEDA? Re-implemented the same driver-based algorithm from scratch in Python, applied to the REAL upstream `lciti/cvxEDA.py` solver (not BioMapping's `cvxeda.js`) — `tests/manual/neurokit_compare/run_cvxeda_reference.py`. It reproduces BioMapping's own production numbers almost exactly (F1 0.858 vs. 0.860, 35 FP vs. 35 FP on the clean synthetic suite) and independently reproduces the pre-fix problem too when the same script's "naive" curve-scan variant is used instead (F1 0.778, 82 FP — matching BioMapping's own pre-fix numbers to three significant figures). Same conclusion from the real MATLAB-source Ledalab itself, run via Octave (`run_ledalab.py` — no MATLAB license needed, see `neurokit_comparison_plan.md` item 23): its CDA method is the literature precedent for detecting SCRs in the driver rather than the curve, confirming this is an established technique, not a BioMapping-specific one — though its own out-of-the-box sensitivity is so permissive (4.8-5.0% precision, thousands of false positives on 210 true SCRs) that it mainly reinforces this document's "default by inertia" theme in §3.E above. See `neurokit_comparison_plan.md` items 21-23 for the full tables, a debugging note on two real porting bugs this cross-check itself caught in the cvxEDA reference solver (an onset-walk-back guard and a missing strict-local-maximum check) before that comparison could be trusted, and item 23's direct validation that Ledalab's own numerics (not a third-party port) produce this same result.

### C. Matching Pursuit SCR Deconvolution (Bach & Staib 2015)
Implemented in `visualiser/src/signal/deconvolution.js` and accessible via the `useDeconvolution` toggle:
- **Algorithm**: Decomposes the phasic residual using greedy Matching Pursuit (Mallat & Zhang 1993) against a fixed Bateman dictionary ($\tau_{\text{slow}}=2.0$ s, $\tau_{\text{fast}}=0.75$ s, kernel length 10 s).
- **Residual Threshold**: Iteratively extracts atoms until the maximum residual drops below `convTol` (0.002 µS) or the iteration cap is reached.
- **Aggregate Rescaling**: To correct for aggregate energy inflation when adjacent kernel tails overlap, the reconstructed curve is rescaled by $\sum SC_{\text{phasic}} / \sum SC_{\text{clean}}$.

### D. SparsEDA Multi-Width Dictionary Deconvolution (Hernando-Gallego et al. 2018) — implemented, not adopted
Implemented in `visualiser/src/signal/deconvolution.js` (`algorithm: 'sparseda'`) as a direct port of the official reference solver (`fhernandogallego/sparsEDA`), config-selectable via `GSR_CONST.SCRF.deconvAlgorithm` but not wired to any UI toggle — the shipped "SCR Deconvolution" checkbox runs Matching Pursuit regardless of its label text.
- **Algorithm**: Joint SCL/SCR non-negative sparse deconvolution against an overcomplete dictionary of Bateman kernels at multiple widths, choosing a per-impulse width rather than fixing one canonical shape — the literature's own answer to inter-individual kernel-shape variability.
- **Why it isn't the production default**: A 2026-09-11 comparison against NeuroKit2's `eda_phasic(method='sparse')` on the same tracks (`biomap_019/027/053/059`) was inconclusive and logged as an open lead rather than a finding:
  - NeuroKit2's own SparsEDA port is unstable (crashed outright on `biomap_019`), consistent with its documented "sometimes it errors for unclear reasons" caveat.
  - Where it did run, phasic agreement was poor ($r = 0.20$–$0.37$, one tonic comparison at $r = -0.009$) — far below cvxEDA's cross-implementation agreement — pointing at a structural difference (dictionary construction, windowing, or kernel definition) between the two ports rather than a tuning mismatch.
  - The one concrete finding: `sparsedaEpsilon` was not the active stopping criterion on any tested track (every run reports `converged: false`, terminating on the `Kmax` iteration cap instead), so historical tuning commits chasing `epsilon` were likely chasing the wrong knob.
  - **Not pursued further per user decision (2026-09-11)**: messier than the other algorithm comparisons in this document, and this project's own SparsEDA port had already been independently validated against the reference implementation without relying on the NeuroKit2 cross-check. Revisit by comparing `_buildReferenceDictionary()` against NeuroKit2's `R` matrix construction in isolation before re-attempting the full decomposition comparison.

### E. Literature Consensus on NeuroKit2's Own Defaults — "default by inertia" vs. methodological divergence

A 2026-09-12 literature survey of published NeuroKit2 EDA studies found a sharp split rather
than a single consensus on how `nk.eda_process()` should actually be configured:

- **~65-70% of applied papers** call `nk.eda_process(eda_signal, sampling_rate=fs)` with every
  default untouched: 3.0 Hz Butterworth cleaning (skipped below 7 Hz, silently disabling
  cleaning on 4 Hz wearables like the Empatica E4/EmbracePlus), 0.05 Hz highpass decomposition,
  and `eda_peaks`' **relative** `amplitude_min=0.1` gate (10% of that one recording's own
  largest peak, not an absolute µS value).
- **~30-35%**, specifically the papers benchmarking against Ledalab/cvxEDA/BioSPPy or ambulatory
  field data, override these defaults in the same direction this project already has:
  - **Absolute peak threshold, not relative**: Gamboa et al. (2025) enforce a `0.02 µS` floor;
    Sullivan et al. (2026) use `0.05 µS` (citing Posada-Quintero & Chon 2020); Xu et al. (2026)
    bypass `nk.eda_peaks()` entirely for `scipy.signal.find_peaks(prominence=0.01, distance=fs)`.
    Greenlee et al. (2024) found NK2's relative gate costs **66% of true peaks** (51.3 vs.
    Ledalab's 169.0 on identical Empatica E4 data) when one large session peak inflates the 10%
    bar — the same failure mode §4.B below documents independently on BioMapping's own tracks
    (NK2's relative gate collapsing recall to 49.3% on an acute-stress track).
  - **cvxEDA over the 0.05 Hz highpass default**: Tsirmpas, Kwon, Xu, Sullivan, and Que (all
    2025-2026) select `method='cvxeda'` for decomposition rather than the default highpass split.
  - **Ambulatory low-pass cutoff tightened below the 3.0/5.0 Hz lab default**: field papers cite
    footstep impact tremor (1.4-2.0 Hz) passing a 3 Hz cutoff unattenuated, converging on a
    ~1.0 Hz critically-damped cutoff for motion-heavy recordings — independently matching
    BioMapping's own LR4 choice in §2 above, arrived at from this project's own gait-tremor
    measurements rather than from this literature.

This is supporting evidence, not new information that changes BioMapping's own defaults: the
project's absolute `peakThreshold`, ambulatory-tuned low-pass cutoff, and cvxEDA option were
already in place before this survey, and the survey shows they sit with the methodologically
rigorous minority of the field rather than the inertial default majority. Full source list in
`docs/neurokit_comparison_plan.md`'s Next Plan (item 17).

**What this motivated**: NeuroKit2's own `eda_peaks()` defaults are the documented bottleneck
behind the poor "NeuroKit2 (cvxEDA)" row in every benchmark table in this document and in
`neurokit_comparison_plan.md` (51.4% recall on the clean 3-way benchmark) — that number reflects
NK2's relative-gate peak-picker, not a limit of the cvxEDA decomposition it's picking peaks from.
`run_neurokit.py` now also emits `cvxeda_lit_peak_times`: the *same* NK2 cvxEDA phasic signal,
re-peak-picked with `scipy.signal.find_peaks(prominence=0.02, distance=1.0s)` per the Gamboa/Xu
methodology above, as a fairer "best-effort NeuroKit2" comparator than its own out-of-the-box
peak picker. Measured 2026-09-12 on the clean synthetic suite
(`CLEAN_ONLY=1 GROUND_TRUTH_NUM_SEEDS=3 ./check_ground_truth.sh`, 210 true SCRs):

| Detector | Recall | Precision | F1 | Amplitude \|r\| |
|---|---:|---:|---:|---:|
| **BioMapping Prominence** | 95.2% | **99.5%** | **0.973** | **0.9985** |
| NeuroKit2 (cvxEDA + literature abs. peaks) | **95.2%** | 79.4% | 0.866 | 0.7806 |
| NeuroKit2 (cvxEDA, NK2's own default peaks) | 51.4% | 94.7% | 0.667 | 0.7888 |

The absolute-threshold fix the literature applies recovers NK2's missing recall almost exactly
to BioMapping's own level (95.2% vs. 95.2%) — confirming the relative gate, not the decomposition,
was the bottleneck — but costs precision (79.4% vs. 99.5%) and amplitude accuracy (r = 0.78 vs.
0.9985): trading NK2's under-detection for over-detection rather than resolving it. BioMapping's
own SNR/quality gating on top of an absolute threshold reaches the literature's recall target
without that trade-off. Not yet re-run against real (non-synthetic) tracks or the noisy/gait
scenarios; see `neurokit_comparison_plan.md` Next Plan item 17 for the follow-up.

---

## 4. Discrete Peak Detection Algorithms

### A. Full-Scan Peak Detector (Production Default)
Implemented in `analyzer.js:_detectPeaksFullScan`:
- **Criterion**: Standard physiological trough-to-peak SCR identification evaluated non-greedily across every local maximum.
- **Onset Search**: Floor-bounded backward walk stopping at the first preceding trough where $v[i] > 0$, bounded by `MAX_RISE_TIME = 5.0` s.
- **Dual Gating**:
  1. **Amplitude Floor**: $\text{amplitude} = \text{peakValue} - \text{onsetValue} \ge \text{peakThreshold}$ ($0.015\,\mu\text{S}$).
  2. **Composite Peak Quality Score**: Evaluates morphology against physiological templates (rise time $0.5\text{--}4.0$ s, half-recovery $1.0\text{--}8.0$ s, and local SNR) into a single `qualityScore`, reported per peak and gated by the user-facing `minPeakQuality` slider — **shipped off (0.0) by default**, a recall-oriented choice; the amplitude floor and Min SNR (1.5) are the only gates active out of the box. Raise `minPeakQuality` per recording when precision matters more than recall.
- **Refractory Non-Maximum Suppression**: Enforces $\text{PEAK\_MIN\_GAP} = 1.0$ s between consecutive detections.

### B. Topographic Prominence Detector
Implemented in `analyzer.js:_detectPeaksByProminence`:
- **Persistence Measure**: Evaluates the height of each peak relative to the higher of its two bounding saddles (SciPy-aligned 0-dimensional persistence).
- **Boundary Saddle Handling**: Computes prefix and suffix running extrema so that global maxima and boundary peaks are referenced to the higher bounding floor rather than the global minimum.
- **Absolute vs. Relative Thresholding**:
  - NeuroKit2 gates peaks at 10% of the *largest prominence in that specific recording*. On field data with varying dynamic range, this relative gate collapses recall to 49.3% when an acute stress event sets an artificially high threshold.
  - BioMapping uses an **absolute prominence threshold** ($\text{peakThreshold} = 0.015\,\mu\text{S}$), preserving high recall (90.5%–100%) across quiet and intense walking periods.

---

## 5. Continuous Metrics & Spatial Attribution

In addition to discrete event counting, BioMapping calculates continuous arousal density along pedestrian paths:

### Clean Phasic AUC vs. Driver ISCR
Benedek & Kaernbach (2010b) defined the **Integrated Skin Conductance Response (ISCR)** as the time-integral of the deconvolved neural driver:
$$\text{ISCR} = \int_{t - W/2}^{t + W/2} \text{driver}(\tau) \, d\tau$$

In BioMapping (`analyzer.js:computePhasicAUC`):
- When deconvolution / cvxEDA is active, `computePhasicAUC` integrates the sparse neural driver (true ISCR).
- When in baseline mode, it integrates the clean phasic curve.

### Analytical Area Ratio ($\approx 3.55$ s)
The relationship between convolved Phasic AUC and Driver ISCR is governed by the area under the **peak-normalized** Bateman kernel (`buildSCRFKernel` scales so the kernel's peak value is 1.0, which is what makes driver amplitude match true SCR amplitude). The raw biexponential integrates to $\tau_{\text{slow}} - \tau_{\text{fast}} = 1.25\,\text{s}$, but dividing by the kernel's peak height ($\approx 0.347$ at $\tau_{\text{slow}}=2.0$ s, $\tau_{\text{fast}}=0.75$ s) gives:
$$\int_0^\infty h_{\text{norm}}(t) \, dt = \frac{\tau_{\text{slow}} - \tau_{\text{fast}}}{h_{\text{peak}}} \approx 3.55\,\text{s}$$
Integrating the convolved curve inflates total energy by $\approx 3.55\times$ relative to the impulse sum.

### Spatial Lag on Walking Tracks
- **Collinearity at 30 s Windows**: Over a standard 30-second moving window, the window is wide enough to absorb the full kernel recovery tail, resulting in near-perfect correlation ($r = 0.956\text{--}0.968$) between Phasic AUC and Driver ISCR.
- **Spatial Smear at Tight Windows (5–10 s)**: At a typical walking speed of $1.4\text{ m/s}$, an SCR's 5–7 second recovery tail creates **7 to 10 meters of forward spatial smear** along the GPS track. Phasic AUC attributes arousal to the sidewalk meters *after* an incident has passed. Driver ISCR concentrates energy at the exact geographic point of stimulus onset, resolving spatial drag for tight pedestrian dwell times ($r \approx 0.72\text{--}0.88$).

---

## 6. Comparison with Competing Scientific Toolboxes

| Feature | BioMapping (Production) | NeuroKit2 (Python) | Ledalab (MATLAB) | PsPM (MATLAB) | cvxEDA (Greco 2016) | BioSPPy (Python) |
|---|---|---|---|---|---|---|
| **Primary Platform** | Browser JS (Zero install) | Python (`scipy`, `cvxopt`) | MATLAB GUI | MATLAB / SPM | Python / MATLAB | Python |
| **Gait Artefact Filter** | **Linkwitz-Riley LR4 (1.0 Hz)** | Butterworth (3.0 Hz) | None (Butterworth) | None | None | Butterworth (5 Hz) + Boxzen |
| **Gait Band Attenuation** | **99.2% @ 1.8 Hz** | Transparent (~0% rejection) | Transparent | Transparent | Transparent | 85% @ 1.8 Hz |
| **Amplitude Preservation** | **>95% on genuine SCRs** | High | High | High | High | Blunted by Boxzen |
| **Decomposition** | EMA/Median/Percentile, cvxEDA, MP, SparsEDA | Highpass, cvxEDA, SparsEDA | DDA (NNLS), CDA (Freq) | GLM, DCM (Bayesian) | Convex QP (Interior-Point) | None (cleaning only) |
| **Joint SCL/SCR** | Yes (in cvxEDA mode) | Yes (in cvxEDA mode) | Yes (in CDA mode) | Yes (in DCM mode) | Yes | No |
| **Discrete Detector** | Full-Scan / Prominence | Topographic Prominence | Trough-to-peak / CDA | Model-based / Trough-peak | Peak scan on driver | None |
| **Threshold Type** | **Absolute (0.015 µS)** | Relative (10% track max) | Absolute (0.01–0.05 µS) | Statistical $t$-contrast | Absolute on driver | N/A |
| **Peak Quality Scoring** | **Composite (Rise/Decay/SNR)** | None | None | None | None | None |
| **Free-Walking Viable** | **Yes (Full ambulatory stack)** | Lab / Low-motion | Lab / Low-motion | Requires cued events | Lab / Low-motion | Partial |

### Three-Way Synthetic Ground-Truth Evaluation

Scored via independent synthetic ground-truth tracks with known injected SCR parameters:

#### 1. Clean Stationary Benchmark (12 tracks, 210 true injected SCRs, 3 seeds, gait filter OFF)
Evaluated across `synth_sparse_clean`, `synth_dense_clean`, `synth_compound_clean`, and `synth_low_slow_clean`:

| Algorithm / Family | True Positives | Missed (FN) | False Positives | Recall | Precision | F1 Score | Mean \|delta\| | Amplitude MAE | Amplitude r |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **BioMapping Full-Scan** (Default) | **209** | **1** | 111 | **99.5%** | 65.3% | **0.789** | **0.030s** | **0.014 µS** | **0.9984** |
| **BioMapping Prominence** | **209** | **1** | 170 | **99.5%** | 55.1% | 0.710 | **0.030s** | **0.013 µS** | **0.9983** |
| **BioMapping Deconvolution** (MP) | 202 | 8 | 127 | 96.2% | 61.4% | 0.750 | 0.053s | 0.113 µS | 0.9947 |
| **BioMapping cvxEDA** | 206 | 4 | 200 | 98.1% | 50.7% | 0.669 | 0.358s | 0.255 µS | 0.7393 |
| **NeuroKit2 (default)** | 179 | **31** | 11 | 85.2% | 94.2% | 0.895 | 0.029s | 0.022 µS | 0.9986 |
| **NeuroKit2 (cvxEDA)** | 108 | **102** | 1 | 51.4% | 99.1% | 0.677 | 0.193s | 0.323 µS | 0.7845 |

- **BioMapping Full-Scan** captures **99.5%** of all true SCRs with 0.030s timing accuracy and $r = 0.9984$ amplitude correlation.
- **NeuroKit2 default** misses **31 true responses (14.8% miss rate)** because its 0.1 µS floor and 10% relative prominence threshold discard subtle and clustered events.
- **NeuroKit2 cvxEDA** misses nearly half (**102 out of 210, 48.6% miss rate**) of all true events.

#### 2. Real Clean Stationary Reference Tracks (`biomap_live_2026-09-10T17-20-02-105Z` & `biomap_028`, 10,335 total samples)
Evaluated on quiet indoor recordings with the gait filter off to ensure an unconfounded comparison:
- **Cleaning Agreement**: $r = 1.0000$ against NeuroKit2 `eda_clean` across both tracks ($\text{mean}|\text{diff}| \le 0.0008\,\mu\text{S}$).
- **Candidate Prominences**: 520/520 local maxima match identically ($r = 1.000000$, error $< 10^{-6}\,\mu\text{S}$).
- **Onset Detection**: **519/520 (99.8%)** exact sample index match between BioMapping and NeuroKit2 (`SCR_Onsets`), with 0.0000s difference on non-capped walks.
- **Recovery Half-Decay**: 280/280 exact match where both found recovery. NeuroKit2 failed to find recovery on 178 peaks (72 on Track 1, 106 on Track 28) due to its internal Python slicing edge-case when `argmin = 0` in `segment[0:argmin]`, whereas BioMapping's forward walk resolves valid recovery points.
- **Detector Agreement**: Across both clean tracks (163 NeuroKit2 default peaks, 130 NeuroKit2 cvxEDA peaks), BioMapping achieves:
  - **Prominence**: **100.0% Recall** (163/163 matched, 0 missed, mean $\Delta t = 0.062\,\text{s}$).
  - **cvxEDA**: **100.0% Recall** (130/130 matched, 0 missed, mean $\Delta t = 0.035\,\text{s}$).
  - **Full-Scan**: **99.4% Recall** (162/163 matched, 1 missed by 1.20s vs 1.0s window, mean $\Delta t = 0.052\,\text{s}$).
  - **Deconvolution**: **99.4% Recall** (162/163 matched, mean $\Delta t = 0.252\,\text{s}$).

#### 3. Ambulatory Walking & Tremor Scenarios (Gait Filter Comparison)
1. **Dynamic Walking Scenario (`synth_walking_track`, 24 true SCRs, variable 0–1.3 m/s walking + pace-coupled gait tremor)**:
   - **BioMapping (LR4 + Prominence / Full-Scan)**:
     - Recall: **100.0%** (24 / 24 true SCRs detected)
     - Precision: **52.2%** (FP = 22)
     - F1 Score: **0.686**
     - Amplitude Relative Error: **5.7%** (slope = 0.940, $r = 0.9999$)
   - **NeuroKit2 (Default 3 Hz Butterworth)**:
     - Recall: **100.0%** (24 / 24 true SCRs detected)
     - Precision: **34.3%** (**46 FP**; >2× more false peaks due to transparent gait band)
     - F1 Score: **0.511**
     - Amplitude Relative Error: **16.3%** ($r = 0.9605$)

2. **Continuous Gait Tremor Scenario (`synth_gait_tremor`, 6 true SCRs, 1.7 Hz tremor)**:
   - **BioMapping (LR4)**: 5 false peaks (F1 = 0.706), amplitude error **5.2%**.
   - **NeuroKit2**: **384 false peaks** (F1 = 0.030) due to unattenuated footstep oscillation.

### The Inter-Individual Kernel Variability Reality
In literature, Ledalab CDA and PsPM DCM optimize response kernel time constants $(\tau_{\text{slow}}, \tau_{\text{fast}})$ per participant.
However, empirical benchmarks on ambulatory free-walking datasets establish that **unsupervised per-recording kernel fitting is degenerate on field data**:
- Overlapping response tails and pedestrian movement contaminate isolated SCR shapes. Loose fits drift to overly broad kernels that merge adjacent peaks and collapse valid counts by up to 40%.
- Strict isolation filters reject over 98% of field recordings due to lack of cued quiet baselines.
- Consequently, BioMapping uses the established physiological population default ($\tau_{\text{slow}}=2.0$ s, $\tau_{\text{fast}}=0.75$ s, Boucsein 2012), matching cvxEDA and modern robust spike deconvolution findings (Pachitariu et al. 2018).

---

## 7. Key References

1. **Greco, A., Valenza, G., Lanata, A., Scilingo, E. P., & Citi, L. (2016)**. *cvxEDA: A Convex Optimization Approach to Electrodermal Activity Processing*. IEEE Transactions on Biomedical Engineering, 63(4), 797–804.
2. **Benedek, M., & Kaernbach, C. (2010a)**. *Decomposition of skin conductance data by means of Nonnegative Deconvolution*. Psychophysiology, 47(4), 647–658.
3. **Benedek, M., & Kaernbach, C. (2010b)**. *A continuous measure of phasic electrodermal activity*. Journal of Neuroscience Methods, 190(1), 80–91.
4. **Bach, D. R., & Staib, M. (2015)**. *Comparison of skin conductance response measurement methods for tonic sympathetic arousal*. Psychophysiology, 52(8), 1106–1112.
5. **Bach, D. R., Flandin, G., Friston, K. J., & Dolan, R. J. (2010)**. *Modelling event-related skin conductance responses*. International Journal of Psychophysiology, 75(3), 349–356.
6. **Makowski, D., Pham, T., Lau, Z. J., et al. (2021)**. *NeuroKit2: An open-source Python toolbox for neurophysiological signal processing*. Behavior Research Methods, 53(4), 1689–1696.
7. **Boucsein, W. (2012)**. *Electrodermal Activity* (2nd ed.). Springer Science & Business Media.
8. **Linkwitz, S. H. (1976)**. *Active Crossover Networks for Noncoincident Drivers*. Journal of the Audio Engineering Society, 24(1), 2–8.
9. **Mallat, S. G., & Zhang, Z. (1993)**. *Matching pursuits with time-frequency dictionaries*. IEEE Transactions on Signal Processing, 41(12), 3397–3415.
10. **Kuhn, M., et al. (2022)**. *Navigating the manyverse of skin conductance response quantification: A data-driven comparison*. Psychophysiology, 59(10), e14058.
11. **Pachitariu, M., Stringer, C., & Harris, K. D. (2018)**. *Robustness of spike deconvolution for calcium imaging of neural populations*. Journal of Neuroscience, 38(37), 7976–7985.
12. **Hernando-Gallego, F., Luengo, D., & Artés-Rodríguez, A. (2018)**. *Feature Extraction of Galvanic Skin Responses by Non-Negative Sparse Deconvolution*. IEEE Journal of Biomedical and Health Informatics, 22(5), 1385–1394.
13. **Greenlee, T. et al. (2024)**. Developmental Psychobiology [PMC10901449]. NeuroKit2 vs. Ledalab on identical Empatica E4 data — relative-threshold peak loss.
14. **Gamboa, P. et al. (2025)**. Sensors [PMC11946426]. Multi-site EDA evaluation enforcing an absolute `0.02 µS` NeuroKit2 peak floor.
15. **Xu, K. et al. (2026)**. Sensors [PMC13306266]. EmbracePlus cognitive-load study bypassing `nk.eda_peaks()` for `scipy.signal.find_peaks(prominence=0.01, distance=fs)`.
16. **Sullivan, R. et al. (2026)**. Journal of Applied Behavior Analysis [PMC12828444]. NeuroKit2 for SCL/SCR split, Ledalab absolute `0.05 µS` threshold for peak extraction.
