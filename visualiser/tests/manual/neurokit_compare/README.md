# BioMapping vs NeuroKit2 Benchmark Suite

This directory contains the comparative evaluation harness that benchmarks BioMapping's EDA signal processing algorithms against [NeuroKit2](https://github.com/neuropsychology/NeuroKit) and against independent synthetic ground truth.

See [`docs/neurokit_comparison_plan.md`](../../../../docs/neurokit_comparison_plan.md) and [`docs/eda_decomposition_analysis.md`](../../../../docs/eda_decomposition_analysis.md) for full scientific documentation and findings.

---

## 1. Prerequisites & Environment

The Python reference scripts require `neurokit2`, `pandas`, and `cvxopt` (needed for NeuroKit2's cvxEDA solver).
Set `NEUROKIT_PYTHON` if your virtual environment is located outside `~/neurokit/.venv`:

```bash
export NEUROKIT_PYTHON="$HOME/neurokit/.venv/bin/python"
```

---

## 2. Key Commands

### A. Full Detector Race Against Known Ground Truth (3-Way Test)
Generates synthetic tracks with known injected SCR parameters (amplitude, rise time, recovery, timing), runs both NeuroKit2 and BioMapping detectors, and computes Recall, Precision, F1, Timing Error ($\Delta t$), and Amplitude Error:

```bash
# Evaluate clean stationary tracks (gait filter OFF, unconfounded test):
CLEAN_ONLY=1 ./check_ground_truth.sh

# Run across 3 independent random seeds (12 tracks, 210 true SCRs):
CLEAN_ONLY=1 GROUND_TRUTH_NUM_SEEDS=3 ./check_ground_truth.sh

# Run all 10 scenarios including walking motion and noise:
./check_ground_truth.sh
```

### B. Real-Track Detector Comparison
Runs all four BioMapping detectors (**Full-Scan**, **Prominence**, **cvxEDA**, and **Deconvolution**) against NeuroKit2's default highpass and cvxEDA reference pipelines:

```bash
# Default track (quiet indoor recording biomap_live_2026-09-10T17-20-02-105Z, gait filter OFF):
./run.sh

# Specific recording:
./run.sh biomap_live_2026-09-10T17-20-02-105Z

# All historical tracks:
./run.sh all
```

### C. Isolated Pipeline Stage Verification Scripts
Each script isolates exactly one mathematical stage to test algorithmic agreement without upstream compounding:

1. **Signal Loading & Timestamps (`./check_signal_loading.sh`)**:
   Confirms byte-identical signal ingestion and zero timestamp offset ($r = 1.000000$).
2. **Signal Cleaning (`./check_cleaning_agreement.sh`)**:
   Tests BioMapping smoothing against NeuroKit2 4th-order 3Hz Butterworth `eda_clean` ($r = 1.0000$, $0.0000\,\mu\text{S}$ diff on stationary data).
3. **Decomposition (`./check_decomposition_agreement.sh`)**:
   Checks cvxEDA convex optimization agreement (Tonic $r = 0.9973$, Phasic $r = 0.9888$).
4. **Local Maxima & Prominence (`./check_prominence_agreement.sh`)**:
   Validates topographic prominence on identical phasic curves (145/145 local maxima match identically, $r = 1.000000$).
5. **Onset Detection (`./check_onset_agreement.sh`)**:
   Compares backward-walk onset search against NeuroKit2 nearest-trough (**145/145 exact index match**, $\Delta t = 0.0000\,\text{s}$).
6. **Recovery Half-Decay (`./check_recovery_agreement.sh`)**:
   Compares half-decay calculation (63/63 exact match; isolates NeuroKit2's `segment[0:argmin]` empty-slice bug where it drops 72 recoveries).
7. **Relative Threshold Sweep (`./check_relative_threshold.sh`)**:
   Evaluates the impact of NeuroKit2's 10% relative prominence floor on true event recall.

---

## 3. Environment Variable Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BIOMAP_USE_GAIT_FILTER` | `0` (off in comparison harness) | Set `1` to enable production LR4 1.0 Hz gait low-pass filter. |
| `BIOMAP_PEAK_THRESHOLD` | unset (falls back to production default, currently `0.050`) | Absolute SCR peak threshold in $\mu\text{S}$; set to override for benchmark-only experiments. |
| `BIOMAP_PEAK_MIN_GAP` | `1.3` | Minimum refractory gap between reported peaks in seconds. |
| `CLEAN_ONLY` | `0` | When `1`, runs only clean stationary scenarios in `check_ground_truth.sh`. |
| `GROUND_TRUTH_NUM_SEEDS` | `1` | Number of independent random seeds to generate for multi-seed statistical evaluation. |
| `GROUND_TRUTH_SEED_OFFSET`| `0` | Seed offset for held-out validation sets. |

---

## 4. Summary of Empirical Findings

1. **Synthetic Ground Truth (Clean Stationary, 210 SCRs across 3 seeds)**:
   - **BioMapping Full-Scan**: **99.5% Recall** (209/210, 1 miss), Mean $\Delta t = 0.030\,\text{s}$, Amplitude MAE $0.014\,\mu\text{S}$, Amplitude $r = 0.9984$.
   - **BioMapping Prominence**: **99.5% Recall** (209/210, 1 miss), Mean $\Delta t = 0.030\,\text{s}$, Amplitude $r = 0.9983$.
   - **BioMapping Deconvolution**: **96.2% Recall** (202/210, 8 misses), Amplitude $r = 0.9947$.
   - **BioMapping cvxEDA**: **98.1% Recall** (206/210, 4 misses).
   - **NeuroKit2 default**: **85.2% Recall** (**31 misses** due to 0.1 µS floor and 10% relative prominence gate).
   - **NeuroKit2 cvxEDA**: **51.4% Recall** (**102 misses**, missing almost half of all true SCRs on compound/dense tracks).

2. **Clean Indoor Reference Tracks (`biomap_live_2026-09-10T17-20-02-105Z` & `biomap_028`, 10,335 total samples)**:
   - **Prominence**: **100.0% Recall** (163/163 matched, 0 missed, mean $\Delta t = 0.062\,\text{s}$).
   - **cvxEDA**: **100.0% Recall** (130/130 matched, 0 missed, mean $\Delta t = 0.035\,\text{s}$).
   - **Full-Scan**: **99.4% Recall** (162/163 matched, 1 missed by 1.20s vs 1.0s window, mean $\Delta t = 0.052\,\text{s}$).
   - **Deconvolution**: **99.4% Recall** (162/163 matched, mean $\Delta t = 0.252\,\text{s}$).
   - Cleaning ($r = 1.0000$), prominences (520/520 identical), and onsets (519/520 exact match) demonstrate complete mathematical parity with NeuroKit2, while BioMapping avoids NeuroKit2's 10% relative-prominence truncation and recovery `argmin=0` slicing bug.
