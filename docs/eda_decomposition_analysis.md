# EDA Decomposition: Implementation Analysis & Competing Approaches

> **Living document.** Added 2026-09-02. Covers the algorithmic properties of
> the deconvolution pipeline in `visualiser/src/signal/deconvolution.js` and
> `analyzer.js:_runDeconvolutionPipeline`, compared against the published EDA
> decomposition literature. Companion to `environmental_stress_literature_review.md`
> §5.B (ISCR/CDA conceptual rationale) and `peak_density_vs_spatial_clustering.md`
> §3 (Phasic AUC); those sections describe *what* the decomposition aims to do
> and *why*, while this document analyses *how correctly the implementation does
> it* and what the most significant algorithmic gaps are.

---

## What the Pipeline Claims vs. What It Is

The code header in `deconvolution.js` cites:

> *Benedek, M., & Kaernbach, C. (2010). A continuous measure of phasic
> electrodermal activity. J. Neurosci. Methods, 190(1), 80–91.*

That paper describes **CDA (Continuous Decomposition Analysis)**: frequency-domain
deconvolution with per-participant Bateman kernel fitting, producing a *continuous*
driver signal. The implementation does neither of those things.

Benedek & Kaernbach published **two** papers in 2010:

| Paper | Method | Algorithm |
|---|---|---|
| *Psychophysiology* 47:647–658 | **DDA** — discrete decomposition | NNLS (globally optimal) |
| *J. Neurosci. Methods* 190:80–91 | **CDA** — continuous decomposition | Frequency-domain pseudoinverse + per-participant τ fitting |

BioMapping's pipeline:

1. Estimates tonic via EMA/percentile (sequential, not joint with phasic)
2. Runs **Matching Pursuit** on the phasic residual — greedy, iterative, atom-based

This is closest to **Bach & Staib (2015)** (*Psychophysiology* 52:1106–1112), who
used Matching Pursuit as a fast approximation to PsPM's DCM for inferring tonic
sympathetic arousal. **Bach & Staib validated it for counting spontaneous
fluctuations as a tonic arousal index — not for measuring phasic SCR amplitudes.**
Applying it as an amplitude-accurate phasic peak detector is an extrapolation beyond
that paper's validation scope.

---

## The Four Competing Methods

All share the same generative model: `y(t) = [x(t) ∗ h(t)] + tonic(t)`, where
`h(t)` is the Bateman biexponential SCRF and `x(t)` is the sparse non-negative
neural driver to be recovered.

### Ledalab DDA — NNLS (B&K 2010a)

Solves: `min ‖H·x − y‖²  s.t. x ≥ 0`  (Non-Negative Least Squares)

`H` is the convolution (Toeplitz) matrix. NNLS (Lawson-Hanson active-set algorithm)
finds the **globally optimal** non-negative driver in one pass. Sequential: tonic
estimated first as a polynomial/smooth baseline, then phasic deconvolved. Most
similar to BioMapping's pipeline structure; differing only in the solver (NNLS vs. MP).

### Ledalab CDA — frequency-domain deconvolution (B&K 2010b)

1. Optimises `(τ_fast, τ_slow)` **per participant** by minimising reconstruction error
2. Deconvolves via `X(f) = Y(f) / H(f)` (Tikhonov regularised)
3. Projects to non-negativity (global minimum shift)

Output: a **continuous** driver signal (µS/s). The recommended CDA metric is
**ISCR** — integrated driver over a stimulus window — not discrete peak amplitudes.
CDA jointly estimates tonic and phasic via the reconvolution residual.

**Critical difference**: CDA fits τ per participant. τ_slow ranges from ~1.5–6s
across healthy adults (Benedek & Kaernbach 2010a; Boucsein 2012). BioMapping uses a
fixed τ_slow=2.0s for everyone.

### PsPM GLM / DCM (Bach et al. 2010, 2013)

**GLM**: Convolves a canonical SCRF with *known stimulus onset times* to build a
design matrix; fits by OLS. Requires known event timings — **inapplicable to
ambulatory free-walking data**. Not a candidate for BioMapping.

**DCM**: Full Bayesian generative model of the autonomic pathway, inverted via
Variational Bayes. Estimates the latent neural driver and SCRF shape parameters
jointly with physiological priors, allowing inter-individual SCRF adaptation.
Validated against direct microneurography (Gerster et al. 2018: LTI model explains
~95% of SCR variance below ~0.6 Hz stimulation). Gold-standard accuracy; orders of
magnitude slower than any other method; not browser-feasible.

### cvxEDA — convex optimisation (Greco et al. 2016, *IEEE Trans. Biomed. Eng.* 63:797)

Decomposes `y = p + s + ε`:
- `p = A·r` — phasic: sparse driver `r ≥ 0` convolved with fixed Bateman IRF `A`
- `s = C·l` — tonic: cubic spline with B-spline coefficients `l`
- `ε` — white Gaussian noise

Minimises:

```
½‖ε‖² + α‖r‖₁ + (γ/2)‖D²l‖²
```

- **α‖r‖₁** — L1 norm on the driver: promotes **sparsity**. Most driver values
  become exactly zero; a few large values mark SCR events. Bayesian interpretation:
  Laplace prior on `r`, encoding the physiological truth that SCRs are rare events.
- **(γ/2)‖D²l‖²** — L2 smoothness on the tonic spline second derivative.
- Solved to **global optimum** via ADMM.

**The L1 prior is the key gap** relative to BioMapping. Without it, MP continues
placing small atoms in inter-event residuals and noise tails indefinitely. The L1
prior suppresses these to exactly zero by design.

Default parameters (at 25 Hz): α ≈ 8×10⁻⁴, γ ≈ 10⁻². Fixed — not adaptively tuned.
A principled default for λ is `σ·√(2·log(n))` (universal LASSO threshold).

---

## Structural Comparison

| | BioMapping | Ledalab DDA | Ledalab CDA | cvxEDA | PsPM DCM |
|---|---|---|---|---|---|
| Algorithm | Greedy MP | NNLS | Freq. domain + τ fit | Convex L1+L2 (ADMM) | Variational Bayes |
| Tonic/phasic joint? | ❌ Sequential | ❌ Sequential | ✅ Joint | ✅ Joint | ✅ Joint |
| Sparsity prior | ❌ None | ❌ Non-neg only | ❌ Non-neg only | ✅ L1 | ✅ Bayesian |
| Globally optimal | ❌ Greedy | ✅ NNLS | ✅ Pseudoinverse | ✅ Convex | ✅ (approx.) |
| Per-participant τ | ❌ Fixed | ❌ Fixed | ✅ Optimised | ❌ Fixed | ✅ Bayesian priors |
| Noise model | ❌ None | ❌ None | ❌ None | ✅ AWGN | ✅ Full |
| Requires event times | ❌ No | ❌ No | ❌ No | ❌ No | ❌ No |
| Browser-feasible JS | ✅ | Feasible | Feasible | Needs solver | No |

---

## The Fixed-Kernel / Inter-Individual Variability Problem

This critique applies equally to BioMapping, cvxEDA, and DDA.

**Boucsein (2012, *Electrodermal Activity*, 2nd ed.)** documents:
- τ_slow (decay): population range **~1.5–6s+**. BioMapping uses 2.0s universally.
- τ_fast (rise): population range **~0.5–1.5s**. BioMapping uses 0.75s.
- Qualitatively different morphologies across individuals (Edelberg's "pore-opening
  component" vs. "diffusion component" produces spike-like vs. broad responses)
- ~5–10% of the healthy population are electrodermal non-responders

B&K 2010a explicitly showed that individual τ fits differ substantially from
population defaults. For slow responders (τ_slow ~4s), the fixed 2.0s kernel
decays too fast — MP sees residual energy in the tail and places a spurious second
atom. For fast responders (τ_slow ~1.2s), the 2.0s kernel over-predicts the tail,
causing amplitude underestimation.

Only **Ledalab CDA** and **PsPM DCM** address this. τ constants are already
configurable in `GSR_CONST.SCRF` — the infrastructure for per-recording fitting
already exists.

---

## What the Implementation Gets Right

1. **Global pass, not per-peak windows.** Correct; consistent with all published
   methods. The previous per-peak ±5s-window design caused the same physical SCR to
   be deconvolved twice from overlapping windows.

2. **kernelSec = 10s (5×τ_slow).** The earlier 5s truncation was dropping ~13% of
   kernel mass. The fix matches B&K's published convention.

3. **Post-hoc amplitude rescaling** (`sum(phasic)/sum(clean)`). A pragmatic correction
   for MP's aggregate energy inflation when adjacent kernels overlap. Correctly
   documented as fixing aggregate bias but not per-atom positional errors.

4. **Scanning the reconstructed curve for peaks** (replacing atom-level run-
   consolidation). The old chain-merging pass had a transitive-merge bug: a sequence
   of atoms each individually within the gap cap of its neighbour could span far
   beyond that cap end-to-end, causing genuine separate events to be merged.

5. **`phasicDeconvTruncated` flag.** Explicit diagnostic warning when the MP budget
   runs out before convergence — a signal quality indicator the published toolboxes
   don't provide.

6. **Configurable τ constants.** Precondition for empirical kernel fitting.

---

## What It Gets Wrong / Where the Gaps Are

### 1. MP vs. NNLS *(biggest algorithmic gap)*

MP places atoms greedily, one at a time. Once large real SCRs are explained, it
continues fitting inter-event residuals and noise tails as small spurious atoms. The
amplitude rescaling corrects aggregate energy but cannot remove false impulse
positions. On busy tracks this is the primary source of disagreement between
deconvolution-mode and trough-to-peak peak counts.

> **Correction (2026-09-02):** severity is bounded by downstream gating. The
> spurious atoms live in the *driver* signal, but four independent filters sit
> between the driver and any reported peak — `convTol` (0.002 µS) floors MP
> itself, `impulseThreshold` (0.005 µS) gates `detectImpulses()`, `resolveApex()`
> requires a genuine local rise in the *original* phasic near each impulse
> (`minApexVal`), and the user's `peakThreshold` gates the final peak list
> (`analyzer.js:694–698`). Most ghost atoms never become peaks. What they do
> reach is the reconstructed curve's *aggregate energy*, which is exactly what
> the `sum(phasic)/sum(clean)` rescale exists to patch. So MP→ADMM is a
> "make the model principled and drop the rescale hack" change, not a "fix
> broken peak output" change.

### 2. No L1 sparsity prior

There is nothing stopping MP from fitting residual noise into small atoms. `convTol`
(0.002 µS) halts it once residual max drops below threshold, but noise above that
threshold is still attributed to atoms. The L1 prior in cvxEDA suppresses sub-
threshold residuals to exactly zero without a manual threshold.

### 3. Sequential tonic estimation

EMA tonic first, then deconvolution on phasic residual. Tonic drift errors on long
recordings propagate into the deconvolution input. CDA and cvxEDA estimate both
jointly, eliminating this error path.

### 4. Fixed τ for all participants

Unlike CDA (which fits τ per participant), BioMapping uses τ_slow=2.0s, τ_fast=0.75s
universally. Given the documented τ_slow range of ~1.5–6s+ across healthy adults,
this is a meaningful source of per-participant amplitude and impulse-placement error.

### 5. Amplitude accuracy is aggregate, not per-peak

The global scalar `sum(phasic)/sum(clean)` removes mean inflation but preserves
relative per-peak errors. Two adjacent peaks, one over-estimated by 30% and one
under-estimated by 20%, remain in those proportions after rescaling.

---

## Upgrade Paths

> **Implementation-feasibility notes (2026-09-02).** Verified against the current
> tree before planning:
> - **No FFT exists in the codebase.** `dwt_filter.js` is a db3 Daubechies
>   lifting-scheme wavelet transform — no Cooley-Tukey, no `fft`/`ifft`, nothing
>   reusable. Any frequency-domain ADMM (Tier 2) must ship its own FFT (~200 LOC
>   with the real-signal wrapper, zero-padding and linear-convolution boundary
>   handling) **or** stay in the time domain with a banded Cholesky factor of
>   `(AᵀA + ρI)` (it is Toeplitz, half-bandwidth ≈ kernel length ≈ 100 samples at
>   10 Hz) — factor once, cheap back-substitution per iteration. Realistic Tier 2
>   size is ~450–550 LOC, not 200–350.
> - **`deconvolve()` does not return the residual** — only
>   `{ driver, kernel, iterations, impulseLog }`. Tier 1 kernel-fitting must score
>   candidates by reconstruct-and-diff from `impulseLog`, by the returned
>   `iterations` count, or by adding a residual return value.
> - Sample rate is **10 Hz** (`analyzer.js` `this.sampleRate = 10`, auto-detected).
>   cvxEDA's published α ≈ 8×10⁻⁴ is quoted at 25 Hz; use the
>   `σ·√(2·log n)` form with a MAD noise estimate rather than a transplanted
>   constant.
> - Test suite is **904 tests** (`npm test`, `node --test tests/*.js`). The
>   deconvolution regression fixtures are `test_deconvolution.js` (38 cases:
>   synthetic + track 048), `test_deconvolution_053.js`, `test_deconvolution_059.js`.
>   There is no "65-track benchmark report".
> - A **DWT-based tonic** already exists as an option (`tonicMethod: 'dwt'`,
>   `gsr_filter.js:394`) and is more drift-robust than the default zero-phase EMA —
>   relevant context for the Tier 3 "sequential tonic" critique.

### Tier 1 — Within the current architecture (~100 LOC)

**Empirical kernel fitting**: grid-search over `(τ_slow ∈ [1.0, 4.5], τ_fast ∈ [0.3,
1.3])`, run a short (≤50-iter) MP pass on each pair, pick the pair with minimum
reconstruction residual (or fewest iterations to `convTol`), then run the full pass.
~20–25 quick MP passes; expected total cost of 2–3× one full deconvolution.
Highest-impact single change: addresses the per-participant variability problem that
CDA was specifically designed to solve, using the τ constants already exposed in
`GSR_CONST.SCRF`.

> **Caveat:** field data has no ground-truth τ. Minimising self-reconstruction
> residual can be gamed by a longer τ_slow that absorbs baseline drift rather
> than fitting SCR morphology. cvxEDA/CDA fit τ against clean lab SCRs with known
> onsets; unsupervised fitting on ambulatory data is a weaker signal. Validation
> must check the *fitted τ distribution is physiologically plausible*
> (≈1.5–6 s for τ_slow), not just that residual dropped.

### Tier 2 — Replace the solver (~450–550 LOC, no external library — see feasibility notes)

**Orthogonal Matching Pursuit (OMP)**: after each atom is placed, refits all accepted
atoms jointly (small ≤k×k NNLS). Much better per-atom amplitude accuracy than plain
MP. Still O(n·k²) — feasible for k ≤ 300.

**ADMM Non-Negative LASSO** (cvxEDA's phasic component algorithm): replaces
`deconvolve()` with a proper sparse solver. The ADMM update alternates between a
ridge-regression step and a soft-threshold step (`max(u − λ/ρ, 0)`). Eliminates
spurious inter-event atoms by design via the L1 prior. No external library required.
A principled default for λ is `σ·√(2·log(n))` where σ is the estimated noise std.

### Tier 3 — Joint tonic + phasic optimisation (~500 LOC)

Full cvxEDA equivalence: add a B-spline tonic model alongside the L1 sparse phasic,
solve jointly via ADMM. Eliminates the sequential tonic-first step.

### Tier 4 — Individual kernel estimation (research-grade)

Bayesian estimation of `(τ_slow, τ_fast)` per participant with physiological priors,
closest to PsPM DCM. Requires either a calibration segment or empirical Bayes over
multiple recordings from the same participant.

---

## Key References

1. **Benedek & Kaernbach (2010a)** — DDA/NNLS. *Psychophysiology* 47:647–658.
2. **Benedek & Kaernbach (2010b)** — CDA/continuous driver. *J. Neurosci. Methods* 190:80–91. ← what the code header cites
3. **Bach, Flandin, Friston & Dolan (2010)** — PsPM GLM. *Int. J. Psychophysiol.* 75:349–356.
4. **Bach & Friston (2013)** — DCM for EDA. *Psychophysiology* 50:15–22.
5. **Bach & Staib (2015)** — Matching Pursuit for tonic arousal inference. *Psychophysiology* 52:1106–1112. ← closest to what BioMapping actually implements
6. **Greco, Valenza, Lanata, Scilingo & Citi (2016)** — cvxEDA. *IEEE Trans. Biomed. Eng.* 63:797–804.
7. **Gerster, Namer, Elam & Bach (2018)** — microneurography LTI validation. *Psychophysiology* 55:e12986.
8. **Amin & Faghih (2022)** — state-space EDA, most comprehensive recent comparison. *PLOS Comput. Biol.* 18:e1010070.
9. **Boucsein (2012)** — *Electrodermal Activity* (2nd ed.). Springer. ← inter-individual SCRF variability data.
10. **Mallat & Zhang (1993)** — Matching Pursuit algorithm. *IEEE Trans. Signal Process.* 41:3397–3415.
