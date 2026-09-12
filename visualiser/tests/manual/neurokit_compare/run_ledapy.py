"""
Batch Ledalab (via its Python port, Ledapy) processing for the
detector-comparison benchmark (see compare.js/check_ground_truth.js in this
folder). For each track CSV given on the command line, runs Ledalab's
Continuous Decomposition Analysis (CDA, the `sdeco` deconvolution) and emits
its own native discrete SCR table as JSON on stdout, keyed by track name.

Why this comparator matters specifically: Ledalab's CDA is the direct
precedent for BioMapping's own 2026-09-12 cvxEDA peak-detection fix (see
analyzer.js's cvxEDA branch, and neurokit_comparison_plan.md items 19-20) -
CDA detects discrete SCRs directly in its deconvolved driver signal, not in
the smoothed reconstruction, which is exactly the design BioMapping adopted.
Comparing against Ledapy's own output is the most direct test of whether
that choice tracks an established toolbox's behaviour or is specific to
BioMapping's own implementation.

Literature-tuned preset (`ledapy_lit_*` fields, see neurokit_comparison_plan.md
item 22): two rounds of tuning went into this.

Round 1 (sigPeak/smoothwin only) found `leda2.settings.sigPeak` does NOT
filter `leda2.analysis.peakTime`/`amp` at all - tracing deconv_apply() in
ledapy's own deconvolution.py shows that table is every local min/max pair
of the driver (`utils.get_peaks(driver)`), gated only by a negligible
0.001 uS floor; sigPeak only feeds the tonic segmentation step. Tuning
`smoothwin_sdeco` (driver smoothing) plus a post-hoc absolute amplitude
floor got to F1 0.560 (from 0.091 default) - a real gain, but still far
behind BioMapping/NeuroKit2.

Round 2 found the bigger gap: this script was feeding Ledalab's naive,
non-regularized point-deconvolution completely UNSMOOTHED raw conductance
data, unlike every other detector in this comparison (NeuroKit2's own
`eda_clean()`, BioMapping's own filter stage) which all clean their input
before decomposition. Naive deconvolution divides by the kernel's frequency
response, so it amplifies whatever high-frequency noise survives into the
driver - Ledalab's own documented workflow expects a smoothed/cleaned
conductance signal, not synthetic-noise-injected raw data. Adding a 4th-order
Butterworth low-pass (0.5 Hz cutoff - well below NeuroKit2's 3 Hz cleaning
cutoff, because naive deconvolution needs much more headroom than a
direct-detection method) before decomposition, combined with the round-1
`smoothwin_sdeco`/amplitude-floor tuning, raised the clean 3-seed/210-SCR
suite from F1 0.560 to **F1 0.847** (recall 81.9%, precision 87.8%) -
essentially matching NeuroKit2's own default (F1 0.840). Still behind
BioMapping's own detectors (F1 0.966-0.973); see the doc for the full sweep.

Manual/occasional script, not run in CI: needs `pip install ledapy` (pulls
numpy/scipy/sympy) in the same Python environment run_neurokit.py uses.

Usage: python3 run_ledapy.py path/to/biomap_027.csv [more.csv ...]
       (normally invoked via run.sh/check_ground_truth.sh, not directly)
"""
import json
import math
import os
import sys
from pathlib import Path

import pandas as pd
from scipy.signal import butter, filtfilt
import ledapy
from ledapy import leda2, deconvolution

# Literature-tuned preset knobs (see module docstring above for how these
# were derived) - overridable via env vars for future re-sweeps.
LEDAPY_LIT_PREFILTER_HZ = float(os.environ.get('LEDAPY_LIT_PREFILTER_HZ', '0.5'))
LEDAPY_LIT_SMOOTHWIN = float(os.environ.get('LEDAPY_LIT_SMOOTHWIN', '0.5'))
LEDAPY_LIT_MIN_AMP = float(os.environ.get('LEDAPY_LIT_MIN_AMP', '0.1'))

# Same auto unit-detection as run_neurokit.py - see that file's comment for
# why this conversion (not the bare gsr_raw column) must happen before
# handing data to any reference toolbox.
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


def process(csv_path):
    df = pd.read_csv(csv_path, comment='#')
    eda = to_microsiemens(df['gsr_raw'].astype(float), 'gsr_raw')
    ts = df['timestamp'].values
    if len(ts) > 0:
        ts = ts - ts[0]

    dt = pd.Series(ts).diff()
    dt = dt[dt > 0]
    sampling_rate = 1.0 / dt.mean() if len(dt) else 10.0

    # leda2 is process-global mutable state (a direct port of Ledalab's
    # MATLAB globals) - reset() is mandatory between tracks, otherwise the
    # previous track's settings/results bleed into this one.
    leda2.reset()
    default_sig_peak = leda2.settings.sigPeak  # Ledalab's own out-of-the-box value (0.001 - see module docstring: doesn't actually gate the final SCR list)
    ledapy.runner.getResult(eda.values, 'phasicdriver', sampling_rate, downsample=1, optimisation=0)

    # leda2.analysis.{peakTime,amp} is Ledalab CDA's own discrete SCR table,
    # built from its deconvolved driver via utils.get_peaks() in
    # deconv_apply() - this is Ledalab's answer to "how many discrete
    # responses were there", at its own default sensitivity, the same
    # "untouched defaults" baseline run_neurokit.py measures for NeuroKit2.
    peak_times = leda2.analysis.peakTime
    peak_amps = leda2.analysis.amp
    pairs = [(float(t), float(a)) for t, a in zip(peak_times, peak_amps)
             if math.isfinite(t) and math.isfinite(a) and 0 <= t <= (ts[-1] if len(ts) else 0)]

    # Literature-tuned preset: pre-smooth the raw conductance signal (see
    # module docstring round 2 - naive point deconvolution amplifies
    # whatever noise survives into it, so it needs cleaner input than
    # direct-detection methods, not just a post-hoc filter), then re-run
    # with a wider driver-smoothing window (ledapy.runner.getResult() calls
    # leda2.reset() as its own first line, which would silently discard a
    # setting applied beforehand - so this replicates getResult()'s body by
    # hand to set smoothwin_sdeco AFTER reset()/import_data() but BEFORE
    # sdeco() actually reads it), then applies a post-hoc absolute amplitude
    # floor to the raw candidate list (see module docstring round 1: sigPeak
    # itself never reaches this gate).
    filt_b, filt_a = butter(4, LEDAPY_LIT_PREFILTER_HZ / (sampling_rate / 2), btype='low')
    eda_smoothed = filtfilt(filt_b, filt_a, eda.values)
    leda2.reset()
    leda2.current.do_optimize = 0
    ledapy.runner.import_data(eda_smoothed, sampling_rate, 1)
    leda2.settings.smoothwin_sdeco = LEDAPY_LIT_SMOOTHWIN
    deconvolution.sdeco(0)
    lit_pairs = [(float(t), float(a)) for t, a in zip(leda2.analysis.peakTime, leda2.analysis.amp)
                 if math.isfinite(t) and math.isfinite(a) and 0 <= t <= (ts[-1] if len(ts) else 0)
                 and a >= LEDAPY_LIT_MIN_AMP]

    return {
        'sampling_rate': sampling_rate,
        'n_samples': len(df),
        'ledapy_peak_times': [p[0] for p in pairs],
        'ledapy_peak_amplitudes': [p[1] for p in pairs],
        'ledapy_sig_peak_default': default_sig_peak,
        'ledapy_lit_peak_times': [p[0] for p in lit_pairs],
        'ledapy_lit_peak_amplitudes': [p[1] for p in lit_pairs],
        'ledapy_lit_prefilter_hz': LEDAPY_LIT_PREFILTER_HZ,
        'ledapy_lit_smoothwin': LEDAPY_LIT_SMOOTHWIN,
        'ledapy_lit_min_amp': LEDAPY_LIT_MIN_AMP,
    }


def main():
    out = {}
    for csv_path in sys.argv[1:]:
        name = Path(csv_path).stem
        print(f'Processing {name}...', file=sys.stderr)
        try:
            out[name] = process(csv_path)
        except Exception as exc:  # noqa: BLE001 - report and continue the batch
            print(f'  FAILED: {exc}', file=sys.stderr)
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
