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
arousal index). *Blocker:* `useDeconvolution` and `usePeakProminence` are
mutually-exclusive toggles today (`events.js:updateDeconvolutionUIState`,
`analyzer.js:411`), so "prominence peaks + deconvolved continuous signal" is
not currently expressible — needs a small wiring change to allow both.

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
`eda_findpeaks()`, whose `neurokit`/SciPy path takes local maxima of the
phasic gated by minimum prominence, width and inter-peak distance — the
prominence threshold commonly a fraction of, or one, phasic SD (stated
outright in recent transformer-based EDA decomposition work,
`arXiv:2506.06378`). Autonomate (Green et al. 2014) is an earlier unsupervised
trough-to-peak scorer offered as an automated alternative to model-based
decomposition. So **Option A is not a new method — it is adopting the
mainstream discrete detector and declining to read discrete events off the
driver.** Low-risk framing: "discrete SCR counting is aligned with
NeuroKit2-style phasic peak detection; deconvolution is retained for the
continuous driver and for overlap resolution."

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
onsets*. The hybrid does not contradict this: with no onset times and a kernel
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
11. **Makowski et al. (2021)** — NeuroKit2. *Behav. Res. Methods* 53:1689–1696. ← `eda_phasic` → `eda_findpeaks` prominence/width/distance discrete detector (Tier 1½ Option A).
12. **Green, Kragel, Fecteau & LaBar (2014)** — Autonomate, unsupervised SCR scoring. *Int. J. Psychophysiol.* 91(3):186–193.
13. **Hernando-Gallego, Luengo & Artés-Rodríguez (2018)** — SparsEDA: non-negative sparse deconvolution over a multi-width SCR dictionary. *IEEE J. Biomed. Health Inform.* 22(5). ← literature's answer to kernel-shape variability.
14. **Pachitariu, Stringer & Harris (2018)** — robustness of spike deconvolution; simple NND wins, kernel auto-calibration is counterproductive. *J. Neurosci.* 38(37):7976–7985. ← calcium-imaging analogue of Tiers 1–2.
15. **Berens et al. (2018)** — spikefinder community benchmark of spike inference. *PLOS Comput. Biol.* 14(5):e1006157.
16. **Deneux et al. (2016)** — MLspike: physiological model with amplitude-dependent decay nonlinearity. *Nat. Commun.* 7:12190. ← "big SCRs recover slower" as a modelled nonlinearity.
17. **Transformer-Based Decomposition of Electrodermal Activity** (2025) — *arXiv:2506.06378*. ← phasic peaks via a one-SD prominence threshold.
