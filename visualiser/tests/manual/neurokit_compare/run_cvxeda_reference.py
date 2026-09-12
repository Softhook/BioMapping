"""
Batch processing using the REAL upstream lciti/cvxEDA.py reference solver
(fetched live from GitHub, same convention as
tests/manual/gen_cvxeda_reference.py) - not BioMapping's own JS port
(cvxeda.js) and not NeuroKit2's wrapper around the same idea. This is the
comparator that most directly answers "does BioMapping's 2026-09-12
driver-based peak-detection fix generalise to the literal reference
implementation's numbers, or only to our own port's" (see
neurokit_comparison_plan.md items 19-20 and eda_decomposition_analysis.md
§3.B/E).

Two independent, from-scratch Python peak-pickers are applied to the SAME
reference decomposition, differing ONLY in where candidate apex positions
come from - every other gate (trough-to-peak amplitude floor, SNR) is
identical between them, so this is a controlled ablation of exactly the
one variable BioMapping's 2026-09-12 fix changed, not a comparison muddied
by also changing how strict the final gate is:
  - 'naive': candidates are every local maximum of the smoothed
    reconstruction r = M*q (a blind scan) - BioMapping's own pre-fix
    algorithm, and the convention most toolboxes' default peak-picker uses.
  - 'driver': candidates are local maxima of the sparse driver p = A*q,
    each resolved to its true apex in the reconstruction via a
    kernel-offset search window - BioMapping's current shipped algorithm
    (Ledalab-CDA-style; see analyzer.js's cvxEDA branch).
Both then apply the identical amplitude (trough-to-peak >= peakThreshold)
and SNR (amplitude / local noise floor >= shapeMinSnr) gates, at BioMapping's
own production values, mirroring analyzer.js's _detectPeaksFromCurve and
_computeNoiseFloor exactly (ported by hand below, not by importing JS) so
this is a genuinely independent re-implementation, not a call into
BioMapping's own code running on someone else's numbers.

Manual/occasional script, not run in CI: needs numpy, scipy, cvxopt, pandas,
and network access to fetch the reference solver from GitHub (same
requirement as gen_cvxeda_reference.py).

Usage: python3 run_cvxeda_reference.py path/to/biomap_027.csv [more.csv ...]
       (normally invoked via run.sh/check_ground_truth.sh, not directly)
"""
import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

# The reference cvxEDA() clears cvxopt.solvers.options and rebuilds it from
# its own {'reltol': 1e-9} default plus whatever `options=` kwarg is passed
# in (see its source: old_options = cv.solvers.options.copy(); ...clear();
# ...update(default_options); ...update(options)) - so setting
# cvxopt.solvers.options['show_progress'] beforehand has no effect; it must
# go through that kwarg instead. Without this, cvxopt's Newton-iteration log
# prints straight to stdout, which IS this script's JSON payload.
CVXOPT_OPTIONS = {'show_progress': False}

REF_URL = 'https://raw.githubusercontent.com/lciti/cvxEDA/main/python/cvxeda/cvxEDA.py'

# Mirrors production's own cvxEDA config (GSR_CONST.CVXEDA in constants.js)
# and the driver-detection values promoted in neurokit_comparison_plan.md
# item 20, so this script's 'driver' variant is testing the SAME algorithm
# at the SAME settings BioMapping ships, just against the reference solver's
# output instead of cvxeda.js's.
TAU_SLOW = 2.0
TAU_FAST = 0.7
DELTA_KNOT_SEC = 10.0
ALPHA = 2e-3
GAMMA = 1e-2
KERNEL_SEC = 10.0
CVX_MIN_IMPULSE_GAP_SEC = 0.8
CVX_APEX_SEARCH_HALF_WIN_SEC = 1.0
IMPULSE_THRESHOLD = 0.005   # driver candidate floor (production cvxImpulseThreshold default)
PEAK_THRESHOLD = 0.045      # production peakThreshold - final amplitude gate, BOTH variants
MIN_SNR = 2.5               # production shapeMinSnr - final SNR gate, BOTH variants
MAX_RISE_TIME_SEC = 4.0     # production PEAK_SHAPE.MAX_RISE_TIME - onset walk-back bound
SHARED_MIN_IMPULSE_GAP_SEC = 0.5  # production SCRF.minImpulseGapSec - _detectPeaksFromCurve's OWN second gap check on the resolved candidate list

RESISTANCE_MIN_AVG = 50000
MICROSIEMENS_MIN_AVG = 100
MICROSIEMENS_MAX_AVG = 50000


def to_microsiemens(raw_vals, header_name):
    avg_val = raw_vals.mean()
    header_lower = (header_name or '').lower()
    is_resistance_header = 'resistance' in header_lower or 'ohms' in header_lower
    if is_resistance_header or avg_val > RESISTANCE_MIN_AVG:
        return raw_vals.apply(lambda v: (1000000.0 / v) if v > 0 else 0.0)
    if MICROSIEMENS_MIN_AVG < avg_val <= MICROSIEMENS_MAX_AVG:
        return raw_vals / 1000.0
    return raw_vals


def fetch_reference():
    src = urllib.request.urlopen(REF_URL, timeout=15).read().decode('utf-8')
    ns = {}
    exec(compile(src, 'cvxEDA_ref', 'exec'), ns)
    return ns['cvxEDA']


def build_kernel(sample_rate, tau_slow, tau_fast, kernel_sec):
    n = max(2, int(round(kernel_sec * sample_rate)))
    t = np.arange(n) / sample_rate
    k = np.exp(-t / tau_slow) - np.exp(-t / tau_fast)
    k[k < 0] = 0.0
    return k


def onset_amplitude(curve, apex_idx, max_onset_steps):
    """Standard trough-to-peak walk-back - byte-for-byte port of
    analyzer.js's _findOnsetIndex minDip<=0 mode, INCLUDING its `onsetIdx <
    i` guard: without that guard, the break condition is checked against
    apex_idx itself on the very first iteration, which a non-strict local
    maximum (see gate()'s comment on why driver-resolved apexes need the
    separate strict-local-max check) can satisfy trivially, returning a
    bogus zero-step walk. Found 2026-09-12 by diffing this script's output
    against analyzer.js's OWN decomposition fed through these same
    functions - without this fix, candidates_driver() this script's own
    'driver' variant way over-counted."""
    onset_idx = apex_idx
    steps = 0
    while onset_idx > 0 and curve[onset_idx] > 0 and steps < max_onset_steps:
        if onset_idx < apex_idx and curve[onset_idx] < curve[onset_idx - 1]:
            break
        onset_idx -= 1
        steps += 1
    return onset_idx, curve[apex_idx] - curve[onset_idx]


def noise_floor(filtered, idx, half_window):
    """Lag-1-difference (von Neumann) noise estimator - direct Python port
    of analyzer.js's _computeNoiseFloor (same halfWindow convention, same
    1e-6 epsilon floor): std of successive sample differences in a
    +/-half_window slice of the PRE-decomposition signal, divided by
    sqrt(2). Trend-immune, so a tonic slope under the onset doesn't get
    mistaken for noise and deflate SNR."""
    n = len(filtered)
    start = max(1, idx - half_window)
    end = min(n - 1, idx + half_window)
    diffs = np.diff(filtered[start - 1:end + 1])
    if len(diffs) < 2:
        return 1e-6
    return max(1e-6, float(np.std(diffs)) / math.sqrt(2))


def candidates_naive(curve):
    """Blind local-maximum scan of the smoothed reconstruction - the
    pre-2026-09-12 algorithm, and the convention most toolboxes default to."""
    n = len(curve)
    return [i for i in range(1, n - 1) if curve[i] > curve[i - 1] and curve[i] >= curve[i + 1]]


def candidates_driver(driver, curve, sample_rate, k_peak_idx):
    """Ledalab-CDA-style: local maxima of the sparse driver, each resolved
    to its true apex in the reconstruction via a kernel-offset search
    window - BioMapping's current shipped algorithm (see module docstring)."""
    n = len(driver)
    min_gap = max(1, round(CVX_MIN_IMPULSE_GAP_SEC * sample_rate))
    apex_half_win = max(1, round(CVX_APEX_SEARCH_HALF_WIN_SEC * sample_rate))

    driver_idx = []
    last_idx = -min_gap
    for i in range(1, n - 1):
        if driver[i] < IMPULSE_THRESHOLD or driver[i] < driver[i - 1] or driver[i] < driver[i + 1]:
            continue
        if i - last_idx < min_gap:
            continue
        driver_idx.append(i)
        last_idx = i

    resolved = set()
    for i in driver_idx:
        predicted = min(n - 1, i + k_peak_idx)
        lo = max(0, i, predicted - apex_half_win)
        hi = min(n - 1, predicted + apex_half_win)
        window = curve[lo:hi + 1]
        resolved.add(lo + int(np.argmax(window)))
    return sorted(resolved)


def gate(curve, filtered, candidate_idx, sample_rate):
    """Shared final gate for both variants - a faithful port of
    analyzer.js's _detectPeaksFromCurve, not an approximation:
      1. apex_idx must be a STRICT local maximum of curve (curr > prev AND
         curr >= next) - required because candidates_driver()'s apex is
         resolved via argmax() over a search window, which is not
         guaranteed to land on a genuine local maximum of the FULL curve.
         Skipping this check let bogus candidates reach onset_amplitude(),
         which (before the onset_idx < apex_idx guard fix above) could
         return a spurious amplitude for a non-peak position - see
         neurokit_comparison_plan.md item 21 for the debugging trail this
         produced (the driver variant massively over-counting on the real
         reference solver's output, traced to this and the onset-guard bug
         by re-running this script's own functions against analyzer.js's OWN
         decomposition and diffing against its OWN peak count).
      2. apex value >= 0.001 (analyzer.js's noise floor literal).
      3. trough-to-peak amplitude >= PEAK_THRESHOLD.
      4. SNR (amplitude / local noise floor) >= MIN_SNR.
      5. minimum gap since the last KEPT peak (GSR_CONST.SCRF.minImpulseGapSec,
         0.5s shared default - analyzer.js enforces this a second time on
         the already driver-gapped candidate list; see its
         _detectPeaksFromCurve candidate-list branch)."""
    max_onset_steps = round(MAX_RISE_TIME_SEC * sample_rate)
    noise_half_win = max(1, round(sample_rate))
    min_gap_samples = max(1, round(SHARED_MIN_IMPULSE_GAP_SEC * sample_rate))
    n = len(curve)

    kept = []
    last_accepted_idx = -min_gap_samples
    for apex_idx in sorted(set(candidate_idx)):
        if not (0 < apex_idx < n - 1):
            continue
        if not (curve[apex_idx] > curve[apex_idx - 1] and curve[apex_idx] >= curve[apex_idx + 1]):
            continue
        if curve[apex_idx] < 0.001:
            continue
        onset_idx, amplitude = onset_amplitude(curve, apex_idx, max_onset_steps)
        if amplitude < PEAK_THRESHOLD:
            continue
        floor = noise_floor(filtered, onset_idx, noise_half_win)
        if amplitude / floor < MIN_SNR:
            continue
        if apex_idx - last_accepted_idx < min_gap_samples:
            continue
        kept.append((apex_idx, amplitude))
        last_accepted_idx = apex_idx
    return kept


def process(csv_path, cvxEDA):
    df = pd.read_csv(csv_path, comment='#')
    eda = to_microsiemens(df['gsr_raw'].astype(float), 'gsr_raw').values
    ts = df['timestamp'].values
    if len(ts) > 0:
        ts = ts - ts[0]

    dt = pd.Series(ts).diff()
    dt = dt[dt > 0]
    sample_rate = 1.0 / dt.mean() if len(dt) else 10.0
    delta = 1.0 / sample_rate

    # z-score standardize, same convention cvxeda.js's normalize:true uses
    # and the same reason run_neurokit.py's eda_phasic_cvxeda_standardized
    # standardizes before calling NeuroKit2's cvxEDA wrapper: alpha/gamma are
    # absolute penalty weights calibrated for unit-variance input.
    mean = eda.mean()
    std = eda.std(ddof=0)
    if not (std > 1e-8):
        std = 1.0
    y_z = (eda - mean) / std

    r, p, _t, _l, _d, _e, _obj = cvxEDA(y_z, delta, tau0=TAU_SLOW, tau1=TAU_FAST,
                                         delta_knot=DELTA_KNOT_SEC, alpha=ALPHA, gamma=GAMMA,
                                         options=CVXOPT_OPTIONS)
    phasic = np.asarray(r).flatten() * std   # r = M*q, rescaled to native uS
    driver = np.asarray(p).flatten() * std   # p = A*q, same rescale

    kernel = build_kernel(sample_rate, TAU_SLOW, TAU_FAST, KERNEL_SEC)
    k_peak_idx = int(np.argmax(kernel))

    naive_kept = gate(phasic, eda, candidates_naive(phasic), sample_rate)
    driver_kept = gate(phasic, eda, candidates_driver(driver, phasic, sample_rate, k_peak_idx), sample_rate)

    return {
        'sampling_rate': sample_rate,
        'n_samples': len(df),
        'cvxeda_ref_naive_peak_times': [float(ts[i]) for i, _ in naive_kept],
        'cvxeda_ref_naive_peak_amplitudes': [float(a) for _, a in naive_kept],
        'cvxeda_ref_driver_peak_times': [float(ts[i]) for i, _ in driver_kept],
        'cvxeda_ref_driver_peak_amplitudes': [float(a) for _, a in driver_kept],
    }


def main():
    cvxEDA = fetch_reference()
    out = {}
    for csv_path in sys.argv[1:]:
        name = Path(csv_path).stem
        print(f'Processing {name}...', file=sys.stderr)
        try:
            out[name] = process(csv_path, cvxEDA)
        except Exception as exc:  # noqa: BLE001 - report and continue the batch
            print(f'  FAILED: {exc}', file=sys.stderr)
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
