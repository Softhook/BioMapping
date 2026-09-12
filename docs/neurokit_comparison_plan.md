# BioMapping and NeuroKit2 Comparison Plan

## Purpose

Use NeuroKit2 as a diagnostic reference, not as the definition of correct
EDA/SCR detection. The primary accuracy target is known injected SCR events in
the synthetic ground-truth suite. Any change must be assessed for recall,
precision, F1, timing error, and amplitude error across clean, noisy, walking,
and closely spaced-response scenarios.

## Current Production Position

- **Default detector:** BioMapping Full-Scan.
- **Gait filter:** enabled by default: zero-phase 1 Hz LR4 low-pass.
- **Peak floor:** 0.015 uS.
- **Minimum inter-peak gap:** 1.3 seconds.
- **NeuroKit2:** diagnostic comparator only.

Do not replace these defaults solely to increase NeuroKit2 agreement.

## What We Tested

### Pipeline alignment

The comparison harness aligns raw units, timestamps, sample rate, and cvxEDA
normalization. BioMapping's gait-aware filter is intentionally different from
NeuroKit2's 3 Hz Butterworth cleaning, and their default tonic/phasic
decompositions differ. This makes a direct default-output match inappropriate
as an accuracy target.

Cleaning output still closely agrees on the reference tracks: correlation is
at least 0.9999. The default filter-family phasic signals do not: correlation
against NeuroKit2's high-pass phasic signal ranges from 0.515 to 0.794.

### NeuroKit2 peak selection

On BioMapping's exact phasic curve, both implementations produce the same
local maxima and the same topographic prominence values. NeuroKit2's decisive
difference is its per-recording relative threshold: it retains peaks with
prominence at least 10% of that recording's maximum.

This increases precision by discarding smaller peaks, but removes known true
responses:

| Known clean data | BioMapping Full-Scan | NeuroKit2 relative prominence |
|---|---:|---:|
| Sparse, 6 SCRs | 100% recall, 3 false positives, F1 0.800 | 83.3% recall, 0 false positives, F1 0.909 |
| Dense, 40 SCRs | 100% recall, 9 false positives, F1 0.899 | 82.5% recall, 0 false positives, F1 0.904 |

Therefore, do not adopt NeuroKit2's 10%-of-maximum threshold as BioMapping's
production rule.

### Gait filter

The LR4 gait filter should remain enabled for ambulatory recordings. It is more
robust than NeuroKit2's default on synthetic gait/motion artefacts, while
preserving genuine SCR amplitude better than the prior box filter. On clean,
stationary synthetic data, disabling it yields the most accurate timing and
amplitude measurement, so gait filtering should remain a motion-specific tool,
not a method for matching NeuroKit2.

### Refractory-window experiments

A broad 4-second minimum peak gap improved evenly spaced synthetic data but
failed on both real tracks and clustered known events:

- On four real tracks, Full-Scan agreement recall fell from 93.6% to 71.6%.
- In `synth_compound_clean`, Full-Scan fell from 11/12 known responses at the
  production 1.3-second gap to 6/12 at 4 seconds.

Keep the 1.3-second production gap. Do not use a global broad merge to suppress
tail ripples.

### Global amplitude, SNR, and quality gates

- NeuroKit2-style relative gating removes many extras but reduces real-track
  agreement recall from 92.6% to 50.3%.
- A global 0.1 uS threshold performed well only on the current synthetic suite;
  on real tracks it reduced Full-Scan agreement recall to 65.9%.
- A 0.05 uS threshold still reduced recall to 79.4%.
- Sweeping existing SNR and quality controls made only a marginal improvement;
  the current quality score did not discriminate through 0.4.

### Clean Indoor Stationary Reference (`biomap_live_2026-09-10T17-20-02-105Z`)

An indoor recording with no physical locomotion (speed 0.1 kts, 1,414 samples @ 3.33 Hz,
~7 minutes) serves as the primary real-world clean stationary reference, complementing
the ambulatory outdoor recordings. For fair comparison with NeuroKit2 on clean stationary
and synthetic data, the comparison testing harness (`compare.js`, `run.sh`, `check_ground_truth.js`)
defaults the gait low-pass filter to **off** (`useGaitFilter: false`, overridable via
`BIOMAP_USE_GAIT_FILTER=1`).

With the gait filter off on this clean indoor track:
- **Raw signal loading:** passes with zero timestamp difference and $r = 1.000000$
  (timestamps normalized relative to session start).
- **Cleaning agreement:** identical raw passthrough ($n = 1414$, max diff $0.0000$ uS,
  RMSE $0.0000$ uS, $r = 1.0000$).
- **Full-Scan agreement recall:** **100.0%** (43/43 matched, 0 missed, mean \|delta\| **0.035s**).
- **Prominence agreement recall:** **100.0%** (43/43 matched, 0 missed, mean \|delta\| **0.035s**).
- **cvxEDA agreement recall:** **100.0%** (30/30 matched, 0 missed, mean \|delta\| **0.040s**).
- **cvxEDA decomposition agreement:** tonic $r = 0.9973$, phasic $r = 0.9888$.
- **Topographic prominence algorithm:** produces 145/145 identical local maxima with
  NeuroKit2 ($r = 1.000000$, mean \|diff\| = 0.000 uS).
- **NeuroKit2 relative threshold:** an isolated 2.54 uS peak elevates NeuroKit2's 10%
  threshold to 0.254 uS, discarding 109 of 145 local maxima and missing 7 responses that
  BioMapping successfully identifies (dropping recall to 83.7%).
- **Commands default:** `./run.sh` and diagnostic scripts now default directly to this
  clean indoor reference track (pass `all` to run across all 5 recordings).

Do not change production threshold, SNR, or quality defaults based on these
experiments.

## Ground-Truth Suite

The generator uses NeuroKit2's canonical SCR waveform but explicitly places
every event and records its true time and injected amplitude. It includes:

- sparse clean and sparse noisy;
- dense clean and dense noisy;
- clean and noisy compound pairs, with paired responses 2.5 seconds apart;
- clean and noisy low-amplitude, slower-rise responses (`synth_low_slow_clean`, `synth_low_slow_noisy`), calibrated from real-track peak distributions (`biomap_053`: median amplitude 0.036 uS, median rise 1.5s, median onset slope 0.025 uS/s);
- gait tremor;
- walking with speed-dependent gait artefact.

The compound scenarios are required regression checks for any false-positive
reduction: a valid improvement must not erase nearby genuine responses.
The low-amplitude, slow-rise scenarios prevent rejection rules from overfitting
to canonical large/fast responses and erasing weak genuine physiological SCRs.

The generator supports multi-seed generation (`--num-seeds N` or `GROUND_TRUTH_NUM_SEEDS=N`)
and held-out seed offsets (`--seed-offset S`) to test across multiple independent noise
realizations rather than a single realization.

## Commands

Run from `visualiser/tests/manual/neurokit_compare`.

```sh
# Full known-answer three-way detector comparison (with aggregate summary).
./check_ground_truth.sh

# Multi-seed evaluation across 3 independent noise realizations (30 tracks, 510 true SCRs).
GROUND_TRUTH_NUM_SEEDS=3 ./check_ground_truth.sh

# Clean stationary cases, with BioMapping's gait filter disabled.
CLEAN_ONLY=1 BIOMAP_USE_GAIT_FILTER=0 ./check_ground_truth.sh

# Experimental peak-gap check. Do not treat this as production configuration.
BIOMAP_PEAK_MIN_GAP=4 ./check_ground_truth.sh

# BioMapping versus NeuroKit2 diagnostic on four real reference tracks.
./run.sh

# Benchmark-only threshold experiment.
BIOMAP_PEAK_THRESHOLD=0.05 ./run.sh

# Compare NeuroKit2's prominence selection on BioMapping's own phasic curve.
./check_prominence_agreement.sh biomap_053

# Sweep existing amplitude, SNR, and quality gates against known truth.
./check_gate_sweep.sh

# Inspect Full-Scan true-versus-false peak metrics on generated known truth.
# Generate the suite first, then pass any CSV and JSON to:
node ./inspect_false_positive_metrics.js <track.csv> <ground_truth.json>
```

## False-Positive Metric Inspection

### Compound noisy (`synth_compound_noisy`)

On `synth_compound_noisy`, Full-Scan finds all 12 true responses and 97 false
positives. The distribution medians show that false detections are generally
smaller and slower, but overlap the weakest true responses:

| Metric | True responses, median (range) | False positives, median (range) |
|---|---:|---:|
| Amplitude (uS) | 0.434 (0.062-1.718) | 0.035 (0.016-0.120) |
| Prominence (uS) | 0.587 (0.062-1.998) | 0.029 (0.001-0.121) |
| Onset slope (uS/s) | 0.395 (0.057-1.562) | 0.033 (0.016-0.092) |
| SNR | 23.613 (4.848-99.206) | 13.883 (5.213-41.650) |
| Quality score | 0.914 (0.683-1.000) | 0.751 (0.594-0.848) |

### Low-amplitude, slow-rise noisy (`synth_low_slow_noisy`)

On `synth_low_slow_noisy` (calibrated against `biomap_053`), Full-Scan finds
all 12 true responses and 57 false positives:

| Metric | True responses, median (range) | False positives, median (range) |
|---|---:|---:|
| Amplitude (uS) | 0.074 (0.041-0.196) | 0.022 (0.016-0.047) |
| Prominence (uS) | 0.090 (0.052-0.196) | 0.018 (0.001-0.059) |
| Onset slope (uS/s) | 0.047 (0.026-0.122) | 0.018 (0.010-0.036) |
| SNR | 30.537 (18.186-145.044) | 17.253 (7.341-60.945) |
| Quality score | 0.779 (0.714-0.878) | 0.748 (0.558-0.814) |

Notice that true responses have onset slopes down to 0.026 uS/s and amplitudes
down to 0.041 uS (and on real tracks down to 0.015 uS), while noise ripples
exhibit onset slopes up to 0.036 uS/s and amplitudes up to 0.047 uS. They
overlap in this low-energy regime, meaning any simple post-detection amplitude
or slope floor that eliminates noise ripples inevitably discards genuine weak
SCRs.

### Multi-Seed Aggregate Benchmark (30 tracks, 510 true SCRs)

Aggregated across 3 independent random seeds across all 10 scenarios
(`GROUND_TRUTH_NUM_SEEDS=3`):

| Detector | Recall | Precision | F1 | Mean \|delta\| | Amplitude r | Missed true SCRs |
|---|---:|---:|---:|---:|---:|---:|
| **BioMapping Full-Scan** | **98.8%** | 30.5% | 0.466 | 0.155s | **0.9935** | **6** (all compound) |
| **BioMapping Prominence** | 98.2% | 32.1% | 0.484 | 0.157s | 0.9934 | 9 |
| **BioMapping cvxEDA** | 98.0% | 35.1% | 0.517 | 0.246s | 0.9546 | 10 |
| **NeuroKit2 default** | 90.0% | 21.9% | 0.352 | 0.055s | 0.9907 | 50 |

On clean stationary tracks (`synth_*_clean`, gait filter off), Full-Scan
achieves **100% recall** (70/70 SCRs detected), 0.032s mean timing error,
and 0.015 uS mean absolute amplitude error, while NeuroKit2 default drops
12 genuine events (recall 82.9%, and only 50% on compound clean).

### Combined small-and-slow experiment: rejected

A benchmark-only rule rejected a peak only when both amplitude was below
0.1 uS and onset slope was below 0.06 uS/s. On the previous synthetic suite it
retained the production detector's true-positive count and reduced aggregate
false positives to 25. However:
- On real tracks, it reduced recall from 93.6% to 69.6%, heavily cutting
  `biomap_053` responses.
- On the newly calibrated `synth_low_slow_clean`, an amplitude >= 0.1 uS gate
  collapses recall to **16.7%** (missing 10 of 12 true clean responses).
- On `synth_compound_clean`, an amplitude >= 0.1 uS gate collapses recall to
  **58.3%**.

Do not promote this rule or its current floors.

## Next Plan

1. [x] **Add low-amplitude and slow-rise SCR cases to the generator**:
   Added `synth_low_slow_clean` and `synth_low_slow_noisy`, calibrated from
   real-track peak distributions (`biomap_053`).
2. [x] **Add held-out random seeds and aggregation**:
   Generator now supports `--num-seeds` and `--seed-offset`. Comparison harness
   aggregates across scenarios and seed runs.
3. [ ] **Obtain manually labelled real noisy segments** before proposing any
   new production rejection rule.
4. [ ] **Run the full known-answer suite and the real-track NeuroKit2 diagnostic**
   for each candidate rule. Report agreement movement, but do not optimize for it.
5. [ ] **Only promote a setting** after it succeeds on the expanded synthetic suite
   and labelled real segments without reducing compound-response recall.

## Decision Rule

Prefer a change only when it improves known-answer performance across the full
suite, especially `synth_compound_noisy`, without reducing compound-response
recall. If it improves NeuroKit2 agreement but loses known events, reject it.