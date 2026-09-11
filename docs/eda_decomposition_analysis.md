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

## Cleaning-Stage Comparison vs NeuroKit2 (2026-09-11)

Before comparing decomposition/peak-detection algorithms at all, it's worth
confirming the two sides even agree on the signal they're decomposing. A new
reproducible harness at `visualiser/tests/manual/neurokit_compare/` checks
this incrementally, one pipeline stage at a time, rather than jumping
straight to comparing detected peaks:

1. `check_signal_loading.*` — the raw µS signal, before any filtering.
   **Exact agreement** (r=1.000000, zero diff) across all 4 test tracks,
   once both sides applied the same raw→µS auto-unit-conversion
   (`GSRCSVParser`'s conversion rule was missing on the Python side; it's
   now ported into `run_neurokit.py::to_microsiemens()`).
2. `check_cleaning_agreement.*` — our 0.5s zero-phase box-average low-pass
   (`GSR_DEFAULT.lpfWindow`, `medianSize=0` by default) vs NeuroKit2's
   `eda_clean(method='neurokit')` (4th-order 3Hz Butterworth, zero-phase
   `sosfiltfilt`). **r≈0.9999–1.0000, RMSE 0.006–0.021µS** across all 4
   tracks — different filter designs, nearly identical real-world output.

### Why they agree despite being different filter designs

Computed frequency response directly, not just inferred from the 4 tracks
tested (which could simply be lucky):

| freq | ours (0.5s box) | NeuroKit2 (Butterworth, 3Hz) |
|---|---|---|
| 1 Hz | 64% passes | ~100% passes |
| 1.5 Hz | 30% passes | ~100% passes |
| 2 Hz | 0% (exact null) | 96% passes |
| 3 Hz | 21% passes (sidelobe) | 71% (its cutoff, −3dB) |
| 4 Hz | 0% (exact null) | 30% passes |
| 5 Hz (Nyquist @ 10Hz) | 9% passes | 16% passes |

These are tuned for different problems, neither strictly better:

- **Ours** is a targeted notch aimed at the 1–3Hz band the project already
  flags as a walking-gait/tremor artifact range (see the `lpfWindow`
  comment in `constants.js` — "raise toward 1.0–1.2s to also cancel a
  walking-gait artefact"). NeuroKit's filter is essentially transparent in
  that same band (~100% passes at 1–1.5Hz) — it wouldn't touch a gait
  artifact at all.
- **NeuroKit2's** is a clean, monotonic broadband lowpass with no
  sidelobes — better protection against genuine high-frequency noise
  (electrical interference, ADC glitches) above ~4Hz, where our box
  filter's sidelobes let 9–21% back through instead of continuing to fall
  off.

The empirical r≈0.9999 match says BioMapping's actual field recordings
don't carry much energy in the 3–5Hz band where the two filters would
disagree — consistent with EDA being physiologically a low-frequency
signal. It's not evidence the sidelobe weakness never matters, only that
it hasn't shown up on the 4 tracks tested so far.

### The existing "Artifact Median Filter" already covers the gap, if enabled

The theoretical weak spot above — brief high-frequency contamination (a
loose-electrode spike, an RF blip) leaking through the box filter's
sidelobes — is exactly what a median filter is for, and BioMapping already
ships one: the **"Artifact Median Filter"** slider in the UI
(`GSR_DEFAULT.medianSize`, `GsrFilter.applyMedianFilter`), **off by default**
(`medianSize: 0`). Unlike a linear lowpass (box or Butterworth alike), a
median filter is nonlinear and rank-based — it removes short impulsive
spikes cleanly instead of smearing/ringing them across the window, which is
precisely the case a Butterworth-style filter *also* wouldn't handle well
for a 1–2 sample spike. If a track ever surfaces genuine high-frequency
contamination that the LPF's sidelobes let through, enabling the median
filter (it already runs first in the pipeline — median → LPF →
tonic/phasic) is the more targeted fix, not swapping the LPF for a
Butterworth design.

No pipeline change is recommended purely on the theoretical analysis above —
worth revisiting if a specific track ever shows the sidelobe leakage
actually mattering. Re-run the comparison on new tracks with
`visualiser/tests/manual/neurokit_compare/check_cleaning_agreement.sh`.

## Decomposition-Stage Comparison vs NeuroKit2 (2026-09-11)

Next stage down the harness:
`check_decomposition_agreement.{py,js,sh}` compares actual tonic/phasic
output, not just detected peaks, for the two decomposition families:

- **highpass family** (different algorithms by design — our LPF+EMA
  tonic vs NeuroKit2's highpass-filter decomposition): phasic r ranges
  0.51–0.79 across the 4 tracks. Expected; not investigated further, since
  the two approaches were never meant to match.
- **cvxEDA family** (same published algorithm, Greco et al. 2016, both
  sides): phasic r *should* be near-1.0 — and initially wasn't. First run
  showed r=0.999 on the shortest track but as low as **r=0.856** on the
  longest, degrading with what looked like track length.

### Root cause: an unstandardized-input bug in the comparison harness, not a solver problem

The instinct was to suspect our custom cvxEDA solver (banded Cholesky +
Schur complement) numerically drifting from NeuroKit2's `cvxopt`
interior-point solver on larger problems. That turned out to be a red
herring. `cvxeda.js` always z-scores (standardizes to zero mean, unit
variance) its input before solving — its own docstring says this "keeps
the published α = 8e-4 meaningful" — because cvxEDA's `alpha`/`gamma` are
**absolute** penalty weights calibrated in the paper for unit-variance
input. NeuroKit2's `eda_phasic(method='cvxeda')` does **not** standardize
internally — its own docs' worked example calls it as
`eda_phasic(nk.standardize(eda_signal), ...)`, i.e. standardizing is left
to the caller. The harness was calling it on the raw µS-scale signal
directly.

The correlation between divergence and track length was actually
divergence tracking each track's raw signal std (how far from 1µS, not how
long the recording is):

| track | signal std (µS) | phasic r (unstandardized) |
|---|---|---|
| biomap_027 | 0.54 | 0.999 |
| biomap_053 | 0.66 | 0.982 |
| biomap_019 | 4.09 | 0.922 |
| biomap_059 | 2.43 | 0.856 |

Fix: `run_neurokit.py` gained `eda_phasic_cvxeda_standardized()` — z-score
the cleaned signal, call NeuroKit2's cvxEDA, un-standardize the result —
mirroring `cvxeda.js`'s own convention exactly. After the fix, all 4
tracks land at **phasic r ≥ 0.948, tonic r ≥ 0.998**. The peak-level
comparison (`run.sh`) improved correspondingly (cvxEDA recall 93.9%→94.7%,
mean timing offset 0.149s→0.129s). This also confirms the two independent
cvxEDA implementations (ours and NeuroKit2's) genuinely do converge to
close to the same optimum when given a like-for-like input — the earlier
scare was entirely a harness scaling mismatch, not evidence of numerical
divergence in either real implementation.

### Closing the rest of the gap: alpha, and a genuine numerical floor

Post-fix phasic r ranged 0.948–0.998 — good, but not "nearly 100%". The
remaining gap traced almost entirely to one further difference:
BioMapping's production `alpha` (`GSR_CONST.CVXEDA.alpha` = 2e-3) is
*intentionally* scaled up 2.5× from the paper/NeuroKit2 default (8e-4), to
compensate for our 10Hz sample rate vs the paper's 25Hz (see the comment on
`CVXEDA.alpha` in `constants.js`). That's a deliberate product choice, not
a bug — but it means production and the reference are, on purpose, solving
slightly different optimization problems.

`check_decomposition_agreement.js` now takes a `CVXEDA_ALPHA` env var to
separate the two questions this conflates: run with production's alpha
(default, no env var) to see "how far does our tuned config sit from the
reference"; run with `CVXEDA_ALPHA=8e-4` to see "is our solver's math
actually correct" (alpha held equal to NeuroKit2's). The second question is
the one that answers "can we get nearly 100% agreement":

| track | phasic r (production α=2e-3) | phasic r (matched α=8e-4) | tonic r (matched) |
|---|---|---|---|
| biomap_019 | 0.989 | 0.995 | 0.9999 |
| biomap_027 | 0.998 | 0.999 | 0.9999 |
| biomap_053 | 0.978 | 0.980 | 0.9990 |
| biomap_059 | 0.948 | 0.982 | 0.9995 |

Tonic agreement is essentially exact (r≥0.999) once alpha is held equal.
The remaining few-percent phasic gap (worst case biomap_059, r=0.982) is a
genuine numerical floor, not a further parameter mismatch: both solvers
report converged (`a.phasicDeconvTruncated === false`, no Newton-iteration
cap hit) on every track, so what's left is two independently-implemented
convex solvers — our banded-Cholesky/Schur-complement Newton solver vs
`cvxopt`'s general interior-point method — landing at very slightly
different points of the same strictly-convex optimum, at the level of
floating-point/solver-implementation noise. That's not practically closable
without literally sharing a solver, and r≥0.98 with matched alpha is
already strong confirmation the port is correct.

**Practical takeaway:** the production alpha=2e-3 vs reference alpha=8e-4
gap (0.948 vs 0.982 on the worst track) is the one lever left that's
actually a choice rather than a floor — worth a conscious decision (keep
2e-3 for the sample-rate-compensation reasoning, or revisit it) rather than
something to silently tune away.

## Peak-Detection Algorithm Comparison vs NeuroKit2 (2026-09-11) — bug found and fixed

Last stage: does our **Prominence** detector's peak-picking logic
(`_detectPeaksByProminence`, gated on `_topographicProminence()`) agree with
NeuroKit2's default peak detector? Its own docs' factual-accuracy note
(above, "Precedent" section) already established the exact algorithm:
`eda_findpeaks(method='neurokit')` → `signal_findpeaks(eda_phasic,
relative_height_min=0.1, relative_max=True)` — every local maximum scored by
**topographic prominence** (SciPy's `peak_prominences`), gated at 10% of the
single largest prominence *in that recording* (relative to the track's own
max, not an absolute µS value or an SD-based threshold — an earlier
in-session comparison that read NeuroKit2's `amplitude_min=0.1` as an
absolute 0.1µS floor was wrong on this point).

Since both sides use the same underlying concept (topographic prominence),
`check_prominence_agreement.{py,js,sh}` isolates the computation itself:
dump our phasic curve, run *both* our `_topographicProminence()` and
NeuroKit2's `signal_findpeaks()` (ungated) on the identical array, and diff
the raw prominence value at every local maximum — no thresholding, no
decomposition differences, just "is this one number right".

**First run found a real, narrow bug.** All 4 tracks found the exact same
set of local maxima (680/680, 39/39, 396/396, 1494/1494 — index-for-index
match), and the vast majority of prominence values agreed almost exactly
(r=1.000, 0.998, 1.000 on three tracks) — but biomap_053 scored r=0.854,
dragged down by exactly 2 of its 396 points with large absolute errors
(0.84µS and 0.045µS). Traced to source: both were peaks where **one side
never encounters a taller point before running out of signal** — the
track's single global maximum (nothing taller anywhere), and a small bump
14 samples from the very start (nothing taller in `[0,13]`). The correct
convention (SciPy's, and the textbook definition) measures such a peak
against the *higher* of its two one-sided floors; `_topographicProminence()`
instead fell back to the **entire recording's global minimum** for these
points — always ≤ the correct reference, so it silently **overstated**
prominence for any peak sitting near a track boundary or the track's own
peak. Practically low-stakes (it can only inflate, never suppress, and
these are already the recording's most extreme points, so they'd clear a
threshold either way) but a genuine deviation from the standard, not a
design choice — worth aligning.

**Fix**, applied directly in `_topographicProminence()`: after the existing
union-find sweep (correct for the interior-peak case, confirmed by the
existing near-1.0 agreement), a second O(n) pass computes prefix/suffix
running max+min once, identifies exactly the affected samples — any peak
where one or both sides never meet a taller point — and replaces their
value with `max(their true one-sided floor, whatever the sweep found on the
other side)`, matching SciPy's definition exactly. Verified against a
from-scratch reimplementation before touching production code, then
confirmed through the real fixed source:

| track | prominence r (before) | prominence r (after) |
|---|---|---|
| biomap_019 | 1.000000 | 1.000000 |
| biomap_027 | 0.995432 | 1.000000 |
| biomap_053 | 0.853583 | 1.000000 |
| biomap_059 | 0.998423 | 1.000000 |

All 4 tracks now match NeuroKit2's own computation **exactly** (r=1.000000,
zero difference, bit-for-bit on every local maximum). Full test suite
(`npm test`, 1217 tests) still green after the change — the fix only ever
touches boundary/global-max points, which no existing test hardcodes exact
prominence values for.

## Onset-Detection Comparison vs NeuroKit2 (2026-09-11) — no bug, one point in our favour

Same isolation pattern (`check_onset_agreement.{py,js,sh}`): same phasic
curve, does our Full-Scan onset walk (`_findOnsetIndex(vals, i,
maxOnsetSteps, minDip=0)` — "stop at the first preceding local minimum,
however shallow", bounded to `MAX_RISE_TIME=5s` and to `vals > 0`) agree
with NeuroKit2's own onset convention (`signal_findpeaks`'s `"Onsets"`
field: run `scipy.signal.find_peaks(-signal)` once for every strict local
minimum in the whole curve, then for each peak take the closest one with a
strictly smaller index)?

**Result: 99.5–100% exact index match on all 4 tracks** (677/680, 39/39,
394/396, 1490/1494). Every mismatch traces to one of three understood,
non-bug causes:

1. **Our `MAX_RISE_TIME` cap (5s) bites, NeuroKit's unbounded search doesn't**
   — the large majority of mismatches, always a small (0.2–0.7s) difference
   since by definition the true onset is just past our search bound.
2. **The very first candidate peak in a recording** has no strictly-smaller-
   index trough at all for NeuroKit's convention to return — nothing to
   compare against, not a disagreement (1 case, biomap_053).
3. **One genuinely interesting case (biomap_019, peak at t=2161.2s):**
   NeuroKit reported an onset **1447 seconds** earlier (t=709.2s). Root
   cause: `scipy.signal.find_peaks` collapses an entire flat plateau into a
   single reported extremum (its documented plateau-handling behaviour) —
   and BioMapping's phasic curve is clipped to exactly 0 between real SCRs
   (`phasic = max(0, signal − tonic)`), so a long quiet stretch registers as
   *one* trough for the whole quiet period, wherever scipy happens to place
   it, rather than not counting as a trough or being handled locally per
   peak. Any peak following a long quiet stretch before the next real
   trough then inherits that single, arbitrarily distant point as its
   "nearest" one. Our bounded, floor-aware walk (`vals[onsetIdx] > 0`, capped
   at 5s) never exhibits this failure mode — it's a case where our approach
   is more robust for this specific clipped-at-zero signal shape, not
   something to align to NeuroKit's convention.

No fix applied — this was a validation pass, and it passed with the
mismatches explained rather than mysterious.

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

> **Implemented (2026-09-10).** `visualiser/src/signal/cvxeda.js` +
> `analyzer.js` cvxEDA branch, behind the "cvxEDA" detector toggle. It is a
> faithful port of the reference `cvxEDA.py` `qp` path: the identical QP
> (`½‖Mq+Cd+Bl−y‖² + α·1ᵀAq + ½γ‖l‖²` s.t. `Aq ≥ 0`) with the same Bateman
> ARMA, cubic B-spline tonic and linear drift. CVXOPT's interior-point
> solver is replaced by ADMM on the single inequality (`z = Aq`, `z ≥ 0`);
> the x-step is solved *directly* — the pentadiagonal `MᵀM + ρAᵀA` block by a
> banded Cholesky, the drift/spline unknowns by a Schur complement refactored
> only when the adaptive-ρ rule moves ρ — so every iteration is O(n). Over-
> relaxation (Boyd §3.4.3) plus a residual-plateau stop converge a typical
> 300 s track in ~400 iters / <100 ms; a 60-min track in ~1–2 s. It is fed
> the **full filtered SC signal** (tonic included) and its B-spline tonic
> replaces `this.tonic` for the run; the prefix cache swaps the EMA tonic
> back when the toggle is turned off. Discrete peaks are still read off the
> phasic reconstruction by `_detectPeaksFromCurve` (shared with the MP path).
>
> α is set to **2×10⁻³**, not the paper's 8×10⁻⁴: that constant is quoted at
> 25 Hz and BioMapping samples at 10 Hz, where the same inter-event sparsity
> needs a proportionally stronger L1 term (≈ 8×10⁻⁴ · 25/10). The z-score
> normalisation (NeuroKit's cvxEDA wrapper does the same) keeps that constant
> meaningful across skin-conductance ranges.
>
> **The earlier build (commit 8523a35) did not work:** its ADMM used a
> 10-iteration unpreconditioned CG inner solve against the `ρAᵀA` block
> (condition number ~n⁴), so `q` never moved far from zero and the phasic
> reconstruction came out at ~⅓ amplitude — peak counts far below every other
> detector. The direct factor fixes this; the reconstruction now matches the
> input to a few ×10⁻³ µS and the driver is 99%+ exact zeros.

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
>
> **Revised again (2026-09, visual audit):** the peak output *is* partly
> broken, but not by "noise atoms". Auditing deconv markers against the raw
> phasic on biomap_113 / 053 / 059 found **12–34 % of deconv markers have no
> visible bump in the raw phasic**, and **0–32 clear raw bumps per track have
> no marker**. Both come from one cause: the fixed canonical kernel is the
> wrong *shape* for real SCRs, and the decay-rate mismatch **varies
> event-to-event on the same participant** (big SCRs recover slower). Two
> concrete windows on biomap_113:
> - **t≈57–62 s** — one broad SCR with a slow smooth decay in the raw phasic.
>   The canonical τ_slow=2 s kernel decays faster than the real tail, so after
>   MP subtracts it a positive residual hump remains; MP tiles the slow decay
>   with 3–4 successive canonical kernels whose *sum ripples*. Each ripple crest
>   → a phantom marker. The "shoulder of a bigger SCR" markers (the largest
>   phantom category) are all this.
> - **t≈149–151 s** — the raw phasic clearly re-rises 0.20 µS into a second
>   SCR. Here the canonical kernel decays *slower* than the real prior SCR, so
>   the big atom's modelled tail stays elevated and *exactly cancels* the small
>   next atom's rise (MP even placed a 0.15-amplitude atom at t=149.7) — no
>   local maximum forms in the reconstruction → missed peak.
>
> The peak list is read by a naive local-max scan of the reconstruction
> (`_detectPeaksFromCurve`), which faithfully turns every mismatch ripple into
> a peak and every mismatch cancellation into a gap. Fixing *amplitudes*
> (refit, below) cannot touch either — the errors are shape- and
> extraction-driven. The leverage is to take peak *positions* from the raw
> phasic (which shows these events correctly) and use deconvolution only to
> *split* a raw bump that is genuinely ≥ 2 superposed SCRs — inverting the
> current "trust the reconstruction, sanity-check against the raw" design.

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

### 6. Phasic AUC integrates the convolved curve, not the deconvolved driver (ISCR divergence)

The code header in `deconvolution.js` and literature review in
`environmental_stress_literature_review.md` §5.B / `peak_density_vs_spatial_clustering.md` §3
claim to implement the **Integrated Skin Conductance Response (ISCR)** from
**Benedek & Kaernbach (2010b)** (*J. Neurosci. Methods* 190:80–91).

However, in the paper, ISCR is explicitly defined as the **time-integral of the
deconvolved phasic driver signal**:

$$\text{ISCR} = \int_{\text{window}} driver_{\text{phasic}}(t) \, dt$$

In BioMapping (`analyzer.js:computePhasicAUC`):
- In non-deconvolution modes, it integrates the raw tonic-subtracted phasic signal
  $SC_{\text{phasic}}(t)$.
- In deconvolution mode (`useDeconvolution: true`), it deconvolves to find
  `phasicDriver`, but then reconstructs the smooth convolved phasic signal
  `phasicClean` ($driver * IRF$) and integrates *that* curve instead.
- The docstring in `analyzer.js:1900-1911` admits this is an *"ISCR-inspired
  continuous metric, not a reproduction of Benedek & Kaernbach's (2010) published
  Integrated Skin Conductance Response"*, even while project documentation and UI
  legends cite it as true ISCR.

#### Empirical Evaluation: Does a True Phasic Driver ISCR Add Anything Meaningful?

To investigate whether integrating the driver rather than the convolved curve produces
meaningful differences, we benchmarked sliding-window integrals across three real
recordings (`biomap_113`, `biomap_053`, `biomap_059`):

| Recording | Window | Clean Phasic AUC (µS·s) | Driver ISCR (µS) | Ratio (AUC / Driver) | Pearson $r$ |
|---|---|---|---|---|---|
| **biomap_113** (busy walk, 11k samples) | 30s | Mean 12.83, Max 48.68 | Mean 0.36, Max 1.42 | **3.56s** | **0.9667** |
| | 10s | — | — | 3.56s | **0.8869** |
| | 5s  | — | — | 3.56s | **0.7797** |
| **biomap_053** (moderate walk, 9k samples) | 30s | Mean 2.12, Max 6.49 | Mean 0.06, Max 0.19 | **3.38s** | **0.9555** |
| | 10s | — | — | 3.35s | **0.8866** |
| | 5s  | — | — | 3.35s | **0.7649** |
| **biomap_059** (long 61m walk, 36k samples) | 30s | Mean 6.27, Max 29.29 | Mean 0.18, Max 0.87 | **3.54s** | **0.9677** |
| | 10s | — | — | 3.54s | **0.8703** |
| | 5s  | — | — | 3.54s | **0.7229** |

#### Key Takeaways:

1. **Analytical Scale Factor ($\approx 3.55\text{ s}$):**
   The ratio between Clean Phasic AUC and Driver ISCR is mathematically fixed at
   $\approx 3.55\text{ s}$. This is not an artifact; it is the exact analytical area
   under the normalized Bateman kernel:
   $$\int_0^\infty IRF(t) \, dt \approx 3.55\text{ s} \quad (\text{for } \tau_{\text{slow}}=2.0\text{s}, \tau_{\text{fast}}=0.75\text{s})$$
   Because each driver impulse of height $A$ produces a response of total integrated
   area $3.55 \times A$, integrating the convolved curve inflates the total energy by
   $\approx 3.55\times$ relative to the impulse sum.

2. **At a 30s Sliding Window: Driver ISCR Adds Very Little ($r \approx 0.97$):**
   When using a 30-second moving window, the window is so much wider than the
   kernel decay tail (~5–7s) that the sliding box absorbs almost all tail energy
   regardless. Phasic AUC and Driver ISCR are almost perfectly collinear ($r = 0.956\text{--}0.968$).
   For large-scale spatial heatmaps or regression against environmental features,
   a 30s driver ISCR is practically identical to a rescaled Phasic AUC.

3. **At Tighter Windows (5s–10s) and Spatial Attribution: Meaningful Difference ($r \approx 0.72\text{--}0.88$):**
   Where the driver genuinely adds value is **spatial precision**:
   - At a typical walking speed of $1.4\text{ m/s}$, an SCR's 5–7 second recovery
     tail creates **7 to 10 meters of forward "spatial smear"** along the pedestrian track.
     Phasic AUC attributes stress to the sidewalk several meters *after* an intersection
     as the sweat slowly reabsorbs.
   - Driver ISCR concentrates the arousal at the exact onset of the event, eliminating
     the spatial drag.
   - For short dwell-time calculations (e.g. 5–10s pause at a pedestrian crossing) or
     short stimulus response windows, the two metrics diverge significantly ($r \approx 0.72$).

4. **Boundary Behavior (Extensive AUC vs. Intensive Rate):**
   `computePhasicAUC` computes a cumulative time integral $\int_{t-15}^{t+15} phasic(\tau) d\tau$.
   At the boundaries of a recording (the first and last 15s), the window naturally contains
   fewer observed seconds because no data exists outside $[0, T]$.
   Attempting to "normalize" this by scaling by $\frac{30}{\Delta t_{\text{eff}}}$ (e.g. $2\times$ at $t=0$)
   treats AUC as an intensive mean rate rather than an extensive cumulative sum: if an acute
   SCR peak occurs within the first 15 seconds (e.g. at $t=3\text{s}$), multiplying by $2\times$
   assumes the event lasted twice as long and artificially doubles its energy, causing the AUC curve
   to shoot up dramatically at track ends. Zero-padded window integration (the current unscaled code)
   is the mathematically standard behavior for moving integrals of finite-duration recordings.

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

### Tier 1 — Per-recording kernel fitting

**The idea:** estimate this recording's own `(τ_slow, τ_fast)` and deconvolve
with the fitted kernel instead of the fixed 2.0 / 0.75 s population defaults, to
address the per-participant variability problem CDA was designed to solve.

> ## Attempted and rejected (2026-09-02)
>
> Two objectives were fully implemented (`SCRDeconvolution.fitKernel` + a
> `deconvFitKernel` UI toggle) and benchmarked against **all 64 real
> `biomap_*` recordings**. Neither produced a usable feature; the code was
> reverted. What was tried, and what it did:
>
> **1. Minimise leftover residual** (the original proposal — grid-search
> `(τ_slow, τ_fast)`, run a short Matching-Pursuit pass per pair, keep the pair
> with the least unexplained signal).
> *Result:* degenerate. Leftover residual after a fixed-length MP pass is
> **monotonically decreasing in both τ_slow and τ_fast** — a wider kernel
> removes more energy per atom — so the search lands on the largest kernel on
> the grid regardless of the signal (demo track → τ_slow 4.5, τ_fast 1.3, peak
> count halved). "Fewest iterations to convergence" as a cheaper proxy has the
> same bias. Not fixable by adjusting bounds; the objective itself just tracks
> kernel area.
>
> **2. Empirical template fit** — find the track's clean isolated SCRs, average
> them into a template, grid-search the Bateman shape that matches it by
> peak-aligned RMSE. Recovers the generating τ *exactly* on synthetic SCRs
> (single Bateman + noise). On real data:
>
> | gating | tracks fitted / 64 | τ behaviour | peak-count change vs default |
> |---|---|---|---|
> | loose — fit τ_slow+τ_fast, 4 s isolation, mean template | 30 | τ_fast pinned to the search ceiling on 18/30; τ_slow drifts high (median 3.3 s, several near the 6 s cap) | **median −40 %**, 23/30 move >15 % |
> | strict — fit τ_slow only (τ_fast fixed), 8 s isolation, median template, RMS reject gate | 1 | sane (τ_slow 3.2 s) | −28 % |
> | middle — 5–6 s isolation, RMS ≤ 0.10–0.15 | 5 | sane (τ_slow 2.0–3.2 s) | median −17 %, 4/5 move >15 % |
>
> There is no setting that fits a useful fraction of tracks *and* leaves the
> analysis roughly intact:
> - **Loose gating** admits contaminated templates — an SCR sitting on the
>   decaying tail of the previous one looks like it has a slower decay, so the
>   fit drifts to a broad kernel that merges peaks in the reconstruction and
>   collapses the count. Same failure as objective 1, milder.
> - **Strict gating** (long isolation window, near-zero pre-onset pedestal
>   required, RMS reject) fixes the drift — the few fits it produces are
>   physiologically sane — but only **1 of 64** recordings has enough clean,
>   isolated, canonical SCRs to pass. The feature becomes inert.
>
> **Root cause:** free-walking ambulatory recordings don't contain enough
> clean, isolated, single SCRs to characterise an individual's response shape.
> Motion, gait ripple, and overlapping response tails contaminate almost every
> candidate. This is exactly why Ledalab CDA and cvxEDA fit τ against
> **controlled recordings with known stimulus onsets**, not field data —
> and why DCM (Tier 4) uses physiological priors instead of trusting the
> signal alone.
>
> **Conclusion:** per-recording kernel fitting is not viable on this dataset.
> The fixed population kernel (τ_slow 2.0 s, τ_fast 0.75 s) stands. If
> inter-individual τ ever needs addressing, it would take either a calibration
> segment (a few cued deep breaths / startle responses at recording start) or
> cross-recording empirical Bayes over the same participant — not a fit from a
> single free walk.

### Tier 1½ — Prominence detector × deconvolution hybrid *(recommended near-term direction)*

> **Detector line-up as shipped (2026-09-09).** The greedy left→right
> trough-to-peak detector was **retired**. The **default** discrete detector is
> now **Full-Scan** (`_detectPeaksFullScan`) — the same trough-to-peak amplitude
> criterion tested non-greedily against every local maximum, gated by amplitude
> + Min SNR + Min Peak Quality (the rise/half-recovery/skew shape sliders were
> removed: a corpus audit showed they preferentially dropped the compound-burst
> and rising-edge SCRs Full-Scan exists to recover, and the skew ratio was
> miscalibrated for LPF'd ambulatory data). **Prominence**
> (`_detectPeaksByProminence`) and **SCR Deconvolution** remain as opt-in
> alternatives; precedence is prominence > deconvolution > full-scan. The
> hybrid options below (still unbuilt) would combine deconvolution with one of
> the two raw detectors.

The 2026-09 visual audit (§1 "What It Gets Wrong") showed the deconv **peak
list** is the weak link, not the amplitude estimate: `_detectPeaksFromCurve`
reads peaks off the reconstruction — a re-render made of fixed-shape kernels —
so kernel-shape mismatch becomes phantom markers (ripple crests where MP tiled
a slow real decay with several fast kernels) and missed markers (a real
re-rise cancelled by a mis-decaying neighbour's modelled tail).

`_detectPeaksByProminence` has the primitive that fixes this:
`_topographicProminence` measures every bump's height above its bounding
saddles in one O(n log n) sweep — exactly the "own event vs. shoulder of a
bigger one" test, computed on the **raw phasic**, immune to tonic drift, no
baseline-return assumption. On both audited failure cases it does the right
thing on the raw signal: the t≈57–62 s ripple-shoulders have ~0 prominence
(smooth decay, no saddle) → rejected; the t≈150.4 s re-rise has prominence
≥ `peakThreshold` → kept. What it *cannot* do is split a single raw bump that
is really 2+ fused SCRs with no saddle between them — the one case
deconvolution is uniquely good at (MP finds residual after subtracting the
first kernel and places a second atom under the same bump).

Three ways to combine, smallest to largest:

**A. Just use the prominence detector for the discrete peak list.** No new
algorithm. The audit says it already tracks the raw signal better than
deconv-mode markers on tracks 113 / 053 / 059. Deconvolution's `phasicClean`
reconstruction can still feed the continuous metrics (phasic AUC / ISCR /
arousal index). *Blocker:* the detector toggles are mutually exclusive
(`events.js` `detectorToggles`; the `if/else if` chain in `analyzer.js`
`analyze()`), so "prominence peaks + deconvolved continuous signal" is not
currently expressible — needs a small wiring change to allow both.

**B. Raw-phasic prominence as veto + rescue on the deconv markers** *(~60–100
LOC; recommended)*. Keep deconv's reconstruction and separation, but after
`_detectPeaksFromCurve`:
- **Veto**: drop a reconstruction marker if the *raw* phasic is smooth and
  monotone through it (no local saddle / rise within ±~1 s) — that is the
  ripple-tiling signature. Do **not** veto on low raw prominence alone: the
  second SCR of a correctly-split fused bump legitimately has low raw
  prominence.
- **Rescue**: where the raw phasic has a local max with prominence ≥
  `peakThreshold` and no deconv marker within ±~1 s, add one (recovers the
  cancellation gaps like t≈150.4 s).

  Leaves amplitude / AUC untouched — it only fixes marker *existence*, which is
  what the audit flagged. Testable against the audit numbers (12–34 % phantom,
  0–32 missed per track).

**C. Full hybrid — prominence for positions, deconv driver as a splitter**
*(~150–250 LOC, new detection path)*. The prominence detector produces the
peak list; for each peak, if the gated deconv driver placed ≥ 2 well-separated
significant atoms within its onset→recovery span **and** the bump is wider /
more asymmetric than one canonical SCR, replace it with one peak per atom.
*Hard part:* split amplitudes — apportioning one prominence peak's amplitude
between two sub-SCRs has no clean answer (options: ratio by atom amplitude, or
height off a 2-atom mini-reconstruction), and it is a fresh heuristic needing
the same per-track visual validation the audit used.

**Recommendation: B.** C's amplitude ambiguity buys little on a minority of
peaks; A is a one-line policy change once the toggle wiring allows it and is
worth trying first to see whether the split cases even matter on this data.
Any of these must be checked track-by-track against the raw phasic before
shipping — the failure modes here do not show up in aggregate counts. See
*Precedent* below for how this sits relative to the published methods.

#### Precedent, and how to position it

**Is the hybrid in the literature?** Not as a named method — there is no
citable "prominence × deconvolution" EDA algorithm. The ingredients are all
established, so the honest framing is a **detector-assignment policy**, not a
new algorithm: route each sub-question to the method with the right inductive
bias — topographic prominence on the phasic for *does an SCR exist here, and
when* (scale-free, kernel-free, no baseline-return assumption; formally the
0-dimensional persistence of the signal's sublevel-set filtration),
constrained deconvolution only for *is this one event or two fused under a
single envelope*.

**1 — Prominence-on-phasic is the toolbox-standard discrete detector, not an
exotic choice.** NeuroKit2's default pipeline is `eda_phasic()` →
`eda_peaks(method="neurokit")`, which calls `eda_findpeaks()` →
`signal_findpeaks(eda_phasic, relative_height_min=0.1, relative_max=True)`.
`signal_findpeaks` scores every local maximum by its **topographic prominence**
(via SciPy `peak_prominences`) and width (`peak_widths`); the default EDA
method's only active gate is prominence **≥ 0.1 × the largest prominence in the
signal** (i.e. relative to the signal's own maximum, *not* to its SD, and not a
fixed µS value). Width and inter-peak-distance filters exist in
`signal_findpeaks` but are **not enabled** by the default EDA path. Autonomate
(Green et al. 2014) is an earlier unsupervised trough-to-peak scorer offered as
an automated alternative to model-based decomposition. So **Option A is not a
new method — it is adopting the mainstream discrete detector (prominence-gated
phasic local maxima) and declining to read discrete events off the driver.**
Low-risk framing: "discrete SCR counting is aligned with NeuroKit2-style phasic
peak detection; deconvolution is retained for the continuous driver and for
overlap resolution."

> **Factual-accuracy note (2026-09-09).** An earlier version of this paragraph
> said NeuroKit2's default gates on "prominence, width and inter-peak distance"
> and that the prominence threshold is "commonly a fraction of, or one, phasic
> SD, stated outright in `arXiv:2506.06378`." Checked against source: (a) the
> default `method="neurokit"` path passes only `relative_height_min` — width and
> distance are available but off by default; (b) the threshold is relative to
> the signal's **maximum** prominence, not its SD; (c) `arXiv:2506.06378`
> (Tsirmpas et al., now *Sensors* 25:4406, 2025) only states it used "the
> NeuroKit2 peak detection algorithm with default parameters" — it does **not**
> state an SD-based prominence threshold. A one-SD (or fraction-of-SD)
> prominence criterion does appear elsewhere in EDA practice, but that citation
> does not support it. The load-bearing claim — prominence-gated phasic local
> maxima is the mainstream discrete detector — stands; the specifics above were
> wrong and are corrected here. BioMapping's own `_detectPeaksByProminence`
> gates on an **absolute** prominence threshold (`peakThreshold`, µS) plus a
> refractory-distance NMS and the composite Min Peak Quality score — closer to
> NeuroKit's structure than to its exact relative-to-max default.

**2 — The kernel-mismatch concern, and the "don't auto-fit" conclusion, are
independently established in calcium-imaging spike inference** — the same
generative model (sparse non-negative events ∗ fixed biexponential + slow
drift + noise). Pachitariu, Stringer & Harris (2018, *J. Neurosci.*): simple
unconstrained non-negative deconvolution is remarkably robust and matches
supervised CNNs, while **adding constraints and auto-calibrating kernel
parameters makes performance worse** — direct external support for this
document's Tier 1 rejection (per-recording τ fitting) and its Tier 2
conclusion (keep the solver simple; the joint-NNLS refit was a regression).
Berens et al. (2018, spikefinder) found many methods competitive with no
single winner. Where that field does treat response-*shape* variability, it is
with a physiological model carrying an amplitude-dependent decay nonlinearity
(MLspike, Deneux et al. 2016) — exactly this document's "big SCRs recover
slower" observation. What that field largely does *not* do is reconcile the
discrete event list against the raw trace, because it has
ground-truth-calibrated kernels and far less motion contamination than
free-walking EDA. That gap is where the hybrid's actual novelty sits.

**3 — Multi-scale deconvolution is the EDA literature's own answer to
kernel-shape variability.** SparsEDA (Hernando-Gallego et al. 2018, *IEEE
JBHI*): non-negative sparse deconvolution over an **overcomplete dictionary of
SCR shapes of different widths**, choosing a width per impulse, joint SCL+SCR.
It is both a Tier 2 alternative to "one fixed Bateman" and evidence that shape
mismatch is a recognised problem with an accepted treatment — a dictionary,
not a τ fit.

**Positioning against the model-based-vs-peak-scoring debate.** Bach (2014)
found model-based scoring (PsPM/SCRalyze) more sensitive than Ledalab
peak-scoring *for detecting condition differences given known stimulus
onsets*. Kuhn et al. (2022, *Psychophysiology*) — the most comprehensive
independent comparison to date (7 quantification approaches, two fear-
conditioning datasets) — reached a more cautious verdict: **no single approach
is universally "best"**, effect sizes are broadly comparable, and trough-to-peak
scoring remains competitive. So the framing here is *not* "trough-to-peak is
obsolete" (an overstatement this project's other docs occasionally lean toward)
— it is that the discrete detectors differ mostly at the margins, and the
prominence detector is the one with the clearest mainstream-toolbox lineage. The
hybrid does not contradict Bach (2014) either: with no onset times and a kernel
that cannot be fitted on field data, the model's *positional* output degrades
to reconstruction ripple, so phasic prominence becomes the more robust source
of event timing — while deconvolution is kept where it still adds unique value
(splitting fused SCRs, feeding the continuous metrics).

**What could honestly be claimed.** Something modest and engineering-flavoured:
a **reconciliation layer** (Option B — veto ripple-tiled reconstruction
markers with no phasic saddle, rescue phasic peaks the reconstruction
cancelled) plus the **ambulatory-field-data framing**. The deconvolution
toolboxes were validated on lab recordings with cued stimuli; the contribution
here is showing, over 64 free-walking recordings, that per-participant τ
fitting is infeasible and that pure deconvolution's *discrete* output inherits
kernel-shape mismatch as ripple, then quantifying the fix against a raw-phasic
audit (12–34 % phantom markers, 0–32 missed per track). That is a methods /
validation note, not a method paper.

### Tier 2 — Replace the solver (~450–550 LOC, no external library — see feasibility notes)

**Orthogonal Matching Pursuit (OMP) / joint amplitude refit**: after MP fixes the
atom positions, re-solve all the atom amplitudes together by non-negative least
squares (`min ‖Ka − y‖²  s.t. a ≥ 0`), keeping MP's positions.

> **Attempted and rejected (2026-09).** Implemented as a post-hoc ISRA
> multiplicative-update NNLS over the MP positions (`refineAmplitudesNNLS`),
> replacing the global `sum(phasic)/sum(clean)` rescale. It recovers true
> amplitudes exactly on synthetic overlapping SCRs and the 64-track benchmark
> showed a near-zero *median* peak-count change — but per-track inspection
> found it **systematically merges small SCRs into adjacent large ones**.
> Worked example, biomap_113 @ 692 s: the raw phasic has a clean ~1.2 s
> rise-and-fall (~0.15 µS prominence) 3 s before a large (~2 µS) SCR. MP places
> a 0.18-amplitude atom there and the legacy path detects the peak. The joint
> NNLS crushes that atom to 0.03 — because in global L2 terms the big
> neighbour's kernel tail "explains" the small bump's energy well enough that
> zeroing the atom barely moves the residual — so the reconstruction has no
> bump there and the peak vanishes. Same pattern at 378 s and elsewhere.
> Root causes, in order of importance:
> 1. **Wrong thing to fix.** The visible marker errors (§1 above) are
>    kernel-*shape* mismatch tiled into a rippling reconstruction, then read by
>    a naive local-max scan. Re-fitting amplitudes touches neither the shape nor
>    the extractor, so it can't remove a ripple crest or fill a cancellation
>    gap.
> 2. **Wrong norm.** Global L2 is dominated by the big-amplitude regions; a
>    0.15 µS SCR next to a 2 µS one contributes ~1/180 of the squared error, so
>    the optimiser trades its fidelity away for a negligible gain on the big
>    one. MP's greedy per-residual-peak placement is scale-free by comparison —
>    every local bump gets an atom sized to *its own* scale — and a uniform
>    global rescale preserves that structure. The refit's global fit destroyed
>    it (0.15 → 0.03 at t≈692 s), completing a cancellation MP had left
>    half-done.
> 3. **Removed accidental regularisation.** MP never revisits an atom, so it
>    can't collapse two atoms into one; the refit can and does. Since
>    deconvolution mode exists precisely to *separate* overlapping events, a
>    refit that re-merges them is a regression regardless of aggregate-energy
>    accuracy.
>
> The legacy MP + global-rescale path stands.

**ADMM Non-Negative LASSO** (cvxEDA's phasic component algorithm): replaces
`deconvolve()` with a proper sparse solver. The ADMM update alternates between a
ridge-regression step and a soft-threshold step (`max(u − λ/ρ, 0)`). Eliminates
spurious inter-event atoms by design via the L1 prior. No external library required.
A principled default for λ is `σ·√(2·log(n))` where σ is the estimated noise std.
Note the joint-refit result above is a caution here too: an L1/L2 objective that
is not carefully weighted will merge small SCRs near large ones the same way —
the sparsity prior would have to be gentle enough to keep sub-threshold-but-real
atoms.

### Tier 3 — Joint tonic + phasic optimisation (~500 LOC)

Full cvxEDA equivalence: add a B-spline tonic model alongside the L1 sparse phasic,
solve jointly via ADMM. Eliminates the sequential tonic-first step.

> **Done (2026-09-10)** — this is what `cvxeda.js` now is; see the boxed note
> under *The Four Competing Methods → cvxEDA* above. It ships as an opt-in
> detector, not the default: the discrete peak list is still read off the
> phasic reconstruction, so the kernel-shape-mismatch caveats in §1 ("What It
> Gets Wrong") apply to it too. Its clear wins are the **joint tonic** (no
> sequential EMA-first error path) and the **genuinely sparse driver** for the
> continuous metrics (ISCR/AUC).

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
11. **Makowski et al. (2021)** — NeuroKit2. *Behav. Res. Methods* 53:1689–1696. ← `eda_phasic` → `eda_peaks(method="neurokit")` → `signal_findpeaks` prominence-gated (relative-to-max) phasic-local-maximum detector (Tier 1½ Option A).
12. **Green, Kragel, Fecteau & LaBar (2014)** — Autonomate, unsupervised SCR scoring. *Int. J. Psychophysiol.* 91(3):186–193.
13. **Hernando-Gallego, Luengo & Artés-Rodríguez (2018)** — SparsEDA: non-negative sparse deconvolution over a multi-width SCR dictionary. *IEEE J. Biomed. Health Inform.* 22(5). ← literature's answer to kernel-shape variability.
14. **Pachitariu, Stringer & Harris (2018)** — robustness of spike deconvolution; simple NND wins, kernel auto-calibration is counterproductive. *J. Neurosci.* 38(37):7976–7985. ← calcium-imaging analogue of Tiers 1–2.
15. **Berens et al. (2018)** — spikefinder community benchmark of spike inference. *PLOS Comput. Biol.* 14(5):e1006157.
16. **Deneux et al. (2016)** — MLspike: physiological model with amplitude-dependent decay nonlinearity. *Nat. Commun.* 7:12190. ← "big SCRs recover slower" as a modelled nonlinearity.
17. **Tsirmpas et al. (2025)** — Transformer-Based Decomposition of Electrodermal Activity. *arXiv:2506.06378* / *Sensors* 25:4406. ← evaluates SCR frequency with "NeuroKit2 peak detection, default parameters"; does *not* itself specify an SD-based prominence threshold (see 2026-09-09 accuracy note in Tier 1½).
18. **Kuhn et al. (2022)** — Navigating the manyverse of SCR quantification: trough-to-peak vs baseline-correction vs model-based (Ledalab, PsPM). *Psychophysiology* 59:e14058. ← independent 7-approach comparison; no single approach universally best, trough-to-peak remains competitive.
