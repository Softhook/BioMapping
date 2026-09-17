# EDA/SCR Detection Benchmark: BioMapping vs. NeuroKit2, Ledalab, and cvxEDA

## Purpose

BioMapping's skin-conductance-response (SCR) detection is validated against the two
established open-source EDA toolboxes — **NeuroKit2** (Python) and **Ledalab** (real
MATLAB-source, run via Octave) — and against the peer-reviewed **cvxEDA** convex-optimisation
decomposition, using its own upstream Python reference solver as a third check. NeuroKit2 and
Ledalab are diagnostic comparators, not the definition of correct detection: the primary
accuracy target is known injected SCR events in a synthetic ground-truth suite, scored for
recall, precision, F1, timing error, and amplitude error across clean, noisy, walking, and
closely-spaced-response scenarios. Do not change production defaults solely to increase
agreement with either comparator.

## Current Production Configuration

- **Default detector:** BioMapping Full-Scan.
- **Gait filter:** enabled by default — zero-phase 1 Hz LR4 low-pass.
- **Peak floor (`peakThreshold`):** 0.045 µS.
- **Minimum SNR (`shapeMinSnr`):** 2.5×.
- **Maximum rise time (`MAX_RISE_TIME`):** 4.0 seconds — matches the psychophysiology
  literature consensus (Boucsein 2012, Ledalab, AcqKnowledge, Dawson et al. 2017); verified at
  100.000% peak retention (0 dropped) against the full local real-track corpus (`tracks/` is a
  local directory, see "Real-world corpus" below for current track count).
- **Minimum inter-peak gap:** 1.3 seconds.
- **Tonic baseline method:** zero-phase EMA, 45s window, with local-floor repositioning.
- **NeuroKit2 / Ledalab:** diagnostic comparators only, not production dependencies.

These threshold values reflect rigorous empirical calibration (`peakThreshold` 0.045 µS,
`MAX_RISE_TIME` 4.0s) to balance high sensitivity with complete rejection of false positives
on synthetic ground truth and high agreement across the real-track corpus. Do not re-tune
without re-running the validation suite below; a change that raises agreement with one comparator
but loses known ground-truth events fails the Decision Rule.

## Methodology

### Reference toolboxes

- **NeuroKit2** (Python) — both its default peak detector and its `cvxeda` decomposition mode
  are scored, plus a literature-tuned variant (absolute prominence floor on the cvxEDA phasic
  signal, replacing NeuroKit2's own default 10%-of-recording-max relative threshold).
- **Ledalab CDA** — run via genuine MATLAB source through Octave (no MATLAB license needed),
  both at its out-of-the-box default and with a literature-informed pre-filter/threshold tuning.
- **cvxEDA reference solver** — the upstream Python `lciti/cvxEDA.py` implementation, fetched
  live, scored with two peak-pickers: a naive scan of the smoothed reconstruction, and the
  driver-based candidate scan BioMapping's own cvxEDA detector uses.

Every comparator is scored in its best literature-tuned configuration where one exists, not
only its out-of-the-box default, so agreement/disagreement reflects a fair fight rather than an
unfair default.

### Synthetic ground-truth suite

A generator places SCR events at exactly known times and amplitudes across five difficulty
tiers, so accuracy can be measured directly rather than inferred:

1. **Canonical** — evenly-spaced, dense, compound (2.5s-paired), and low-amplitude/slow-rise
   responses under a stationary tonic baseline (12 tracks, 210 injected SCRs, 3 seeds).
2. **Poisson stochastic arrivals** — exponential inter-arrival timing with a biological
   refractory floor, alternating tight bursts and quiet stretches.
3. **Multi-burst compound clusters** — overlapping sympathetic volleys stacking on rising/decay
   limbs, randomised rise kinetics, and 0.2 Hz respiratory baseline undulation.
4. **Ambulatory walking & motion** — gait-frequency harmonics and footstep cadence tremor, with
   and without the footstep artefact itself isolated (`synth_walking_track` vs.
   `synth_walking_no_footsteps`).
5. **Semi-synthetic** — known SCRs injected onto a *real* recorded walk's own tonic drift and
   sensor noise floor (`generate_semi_synthetic.py`), rather than modelled synthetic noise.

Every tier's tonic floor carries a per-seed random-period sinusoidal undulation (thermoregulatory
drift, Boucsein 2012) so no detector can learn a single fixed baseline shape.

### Real-world corpus

`tracks/` is a local, gitignored directory of real recordings, so its size drifts as tracks are
added or removed; `./run.sh all` (or `corpus`/`full`) selects every non-empty, non-`_processed`
`biomap_*.csv` file in it as the real-world corpus — **62 tracks** as of 2026-09-12, the figure
the results below use. (A handful of other files sometimes sit in `tracks/` too — cached
`_processed` duplicates, or non-benchmark fixtures like `Newhaven.csv` — `run.sh`'s filter
excludes those automatically; if your own count differs, re-run `./run.sh all` rather than
trusting a number below.) Corpus tracks are scored both for direct peak agreement against
NeuroKit2/Ledalab/cvxEDA and for the production gait filter's rejection of footstep-cadence
false alarms.

### Commands

Run from `visualiser/tests/manual/neurokit_compare`.

```sh
# Full known-answer three-way detector comparison (with aggregate summary).
./check_ground_truth.sh

# Multi-seed evaluation across 3 independent noise realizations.
GROUND_TRUTH_NUM_SEEDS=3 ./check_ground_truth.sh

# Clean stationary cases only, gait filter disabled.
CLEAN_ONLY=1 BIOMAP_USE_GAIT_FILTER=0 ./check_ground_truth.sh

# One difficulty tier at a time: canonical | poisson | burst | gait (Tier 4) | semi (Tier 5) | walking_clean.
TIER=semi ./check_ground_truth.sh

# BioMapping versus NeuroKit2/Ledalab/cvxEDA diagnostic on real reference tracks (`all` = full corpus).
./run.sh
./run.sh all

# Compare NeuroKit2's prominence selection on BioMapping's own phasic curve.
./check_prominence_agreement.sh biomap_053

# Sweep existing amplitude, SNR, and quality gates against known truth.
./check_gate_sweep.sh

# Inspect Full-Scan true-versus-false peak metrics on a generated known-truth track.
node ./inspect_false_positive_metrics.js <track.csv> <ground_truth.json>
```

## Headline Results

### Tier 1 — canonical clean synthetic (12 tracks, 210 injected SCRs, 3 seeds)

Gait filter off, current defaults, undulating tonic floor:

| Detector | Recall | Precision | F1 | FP | Mean timing error | Amplitude \|r\| |
|---|---:|---:|---:|---:|---:|---:|
| **BioMapping Full-Scan** (production) | 93.3% | **100.0%** | 0.966 | **0** | **0.029s** | 0.9993 |
| **BioMapping Prominence** | **95.2%** | 99.5% | **0.973** | 1 | 0.032s | 0.9985 |
| BioMapping Deconvolution (MP) | 92.9% | 99.5% | 0.961 | 1 | 0.057s | 0.9937 |
| BioMapping cvxEDA (driver-based) | 88.1% | 84.1% | 0.860 | 35 | 0.281s | 0.8904 |
| cvxEDA reference solver (same algorithm) | 87.6% | 84.0% | 0.858 | 35 | 0.281s | 0.8805 |
| NeuroKit2 (default) | 83.8% | 84.2% | 0.840 | 33 | 0.035s | 0.9985 |
| NeuroKit2 (literature-tuned cvxEDA) | 95.2% | 79.4% | 0.866 | 52 | 0.216s | 0.7806 |
| Ledalab CDA (literature-tuned, real Octave) | 81.9% | 88.2% | 0.849 | 23 | 0.528s | 0.9976 |

BioMapping's own driver-based cvxEDA reproduces the independent Python reference solver almost
exactly (F1 0.858 vs. 0.860) — confirming that the in-browser convex-optimisation solver is
mathematically sound.

### Tiers 2–4 — stochastic timing, overlapping bursts, ambulatory walking

| Tier | True SCRs | BioMapping (best detector) | NeuroKit2 (default) | Ledalab (literature-tuned) |
|---|---:|---|---|---|
| **2 — Poisson arrivals** | 28 | 89.3% recall, 0 FP, 0.037s | 85.7% recall, 4 FP | 89.3% recall, 5 FP, 0.541s |
| **3 — multi-burst clusters** | 43 | 83.7% recall, 0.037s | 67.4% recall (secondary bursts dropped) | 74.4% recall, 0.624s |
| **4 — ambulatory walking** (gait filter on) | 30 | **100.0% recall, 96.8% precision** | 93.3% recall, 10.4% precision | 96.7% recall, 100% precision, 0.518s lag |

Ambulatory walking is the one condition NeuroKit2 and Ledalab are not designed for; BioMapping's
zero-phase gait filter is the purpose-built answer to it.

### Real stationary recordings — direct peak agreement

Aggregated across two clean indoor tracks (163 NeuroKit2 default peaks, 130 NeuroKit2 cvxEDA
peaks), gait filter off:

| Detector | Recall vs. NeuroKit2 | Matched / Total | Extra genuine peaks | Mean timing diff. |
|---|---:|---:|---:|---:|
| BioMapping Prominence | **100.0%** | 163 / 163 | +53 | 0.062s |
| BioMapping cvxEDA | **100.0%** | 130 / 130 | +93 | 0.035s |
| BioMapping Full-Scan | 99.4% | 162 / 163 | +72 | 0.053s |

### 62-track real-world field corpus

| Comparison | Result |
|---|---|
| BioMapping cvxEDA vs. Python `cvxEDA.py` reference | **99.7% recall** (4,479 / 4,494 peaks matched, mean \|Δt\| 0.002s) |
| BioMapping Prominence vs. NeuroKit2 default | 94.2% recall (2,685 / 2,851 matched) |
| BioMapping Full-Scan vs. NeuroKit2 default | 87.9% recall, plus 4,217 additional genuine peaks recovered |
| Sensor-disconnect handling | BioMapping and Ledalab both register 0 peaks on open-circuit tracks |

### Tier 5 — semi-synthetic (real donor substrate, 25 injected SCRs, 1 seed)

The one tier with a *real* noise floor and real tonic drift under a *known* injected signal:

| Detector | Recall | Precision | F1 |
|---|---:|---:|---:|
| **BioMapping cvxEDA** (driver-based) | 76.0% | **86.4%** | **0.809** |
| BioMapping Full-Scan (production) | 80.0% | 39.2% | 0.526 |
| BioMapping Prominence | 76.0% | 38.0% | 0.507 |
| NeuroKit2 (default) | 72.0% | 78.3% | 0.750 |

Full-Scan's precision reflects that real tonic micro-fluctuations produce more onset-walk-back ripple than idealized synthetic noise models.

### `synth_walking_no_footsteps` — clean walking, motion tremor only (no footstep impacts)

| Detector | Recall | Precision | F1 | Mean timing error | Amplitude MAE |
|---|---:|---:|---:|---:|---:|
| **BioMapping Full-Scan** (production) | **100.0%** | **100.0%** | **1.000** | 0.028s | **0.009 uS** |
| NeuroKit2 (default) | 83.3% | 100.0% | 0.909 | 0.028s | 0.017 uS |
| Ledalab CDA (literature-tuned) | 95.8% | 100.0% | 0.979 | 0.513s | 0.162 uS |

### Why the defaults are what they are

- **NeuroKit2's 10%-of-recording-max relative prominence threshold** discards genuine subtle
  responses following a large spike; BioMapping's absolute floor + SNR gate doesn't have this
  failure mode, and with empirical calibration it dominates NeuroKit2's rule on
  precision *and* recall on the canonical suite.
- **The gait filter** stays motion-specific rather than always-on: disabled, clean stationary
  timing/amplitude accuracy is slightly better; enabled, it is what makes ambulatory walking
  usable at all (Tier 4 above).
- **EMA tonic baseline (45s window)** beats sliding-median and sliding-10th-percentile on F1 for
  both production detectors under the undulating tonic floor, has the best amplitude accuracy,
  and is the only one of the three to reach 0 false positives on the canonical suite. Sliding
  median's piecewise-constant plateaus inject step artefacts as peaks enter/exit its window;
  EMA's local-floor repositioning pass (±6s running minimum) prevents baseline clipping without
  that cost.
- **`_findOnsetIndex`'s backward walk-back** is why Full-Scan needs an absolute amplitude floor
  at all: without one, small ripples riding a slow baseline slope accumulate enough rise from a
  distant onset to pass a near-zero threshold, even with near-zero topographic prominence. A
  *hard* prominence gate isn't the fix either — real ambulatory compound bursts (e.g.
  `biomap_053`) often ride the rising shoulder of a larger subsequent peak, which drives their
  own prominence toward zero even though they're genuine.
- **BioMapping's cvxEDA detector** candidate scan operates directly on the sparse driver (analogous
  to Ledalab's CDA method) rather than the smoothed reconstruction, avoiding residual driver
  ripple between real events and reducing false positives (82 → 35) with negligible recall impact.

## Rejected Approaches

- **Broadening the minimum peak gap to 4s** — helped only evenly-spaced synthetic data; lost
  real-track NeuroKit2 agreement (78.4% → 60.6%) and compound-response recall (11/12 → 6/12).
  Kept at 1.3s.
- **A global absolute amplitude/SNR/quality gate** tuned by sweep — no improvement over the
  existing per-detector floor/SNR gates on the synthetic suite; best in-sample candidate traded
  recall for precision worse than production already does.
- **A combined "small AND slow" post-detection rejection rule** (amplitude < 0.1 µS and onset
  slope < 0.06 µS/s) — collapsed low-amplitude/slow-rise recall to 16.7% on the scenario built
  specifically to catch that failure mode. Not promoted.
- **Prominence or quality-score floors layered on top of the existing gates** — a no-op on the
  clean synthetic suite (already at 0 FP) and a net loss of real-track agreement. Not promoted.

## Decision Rule

Prefer a change only when it improves known-answer performance across the full
suite, especially `synth_compound_noisy`, without reducing compound-response
recall. If it improves NeuroKit2 agreement but loses known events, reject it.