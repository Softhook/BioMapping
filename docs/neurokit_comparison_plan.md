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

Do not change production threshold, SNR, or quality defaults based on these
experiments.

## Ground-Truth Suite

The generator uses NeuroKit2's canonical SCR waveform but explicitly places
every event and records its true time and injected amplitude. It includes:

- sparse clean and sparse noisy;
- dense clean and dense noisy;
- clean and noisy compound pairs, with paired responses 2.5 seconds apart;
- gait tremor;
- walking with speed-dependent gait artefact.

The compound scenarios are required regression checks for any false-positive
reduction: a valid improvement must not erase nearby genuine responses.

## Commands

Run from `visualiser/tests/manual/neurokit_compare`.

```sh
# Full known-answer three-way detector comparison.
./check_ground_truth.sh

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
# Generate the suite first, then pass the compound noisy CSV and JSON to:
node ./inspect_false_positive_metrics.js <track.csv> <ground_truth.json>
```

## False-Positive Metric Inspection

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

This rejects a single absolute amplitude, prominence, slope, SNR, or quality
gate: each would remove at least some true low-amplitude compound responses.

The reusable diagnostic is
`visualiser/tests/manual/neurokit_compare/inspect_false_positive_metrics.js`.

## Next Plan

1. Evaluate a benchmark-only *combined* rule, such as rejecting a candidate
   only when both amplitude and onset slope are below calibrated floors.
2. Score it against every known-answer scenario, especially noisy compound
   pairs, low-amplitude responses, and walking data.
3. Reject the rule if it drops any compound-response recall; reduce its floors
   or discard it rather than trading recall for NeuroKit2 agreement.
4. Run the real-track NeuroKit2 diagnostic after a ground-truth result. Report
   agreement movement, but do not optimize the rule for agreement alone.
5. Only promote a setting to production after it succeeds on additional
   manually labelled real noisy segments or held-out synthetic seeds.

## Decision Rule

Prefer a change only when it improves known-answer performance across the full
suite, especially `synth_compound_noisy`, without reducing compound-response
recall. If it improves NeuroKit2 agreement but loses known events, reject it.