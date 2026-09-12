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

Manual/occasional script, not run in CI: needs `pip install ledapy` (pulls
numpy/scipy/sympy) in the same Python environment run_neurokit.py uses.

Usage: python3 run_ledapy.py path/to/biomap_027.csv [more.csv ...]
       (normally invoked via run.sh/check_ground_truth.sh, not directly)
"""
import json
import math
import sys
from pathlib import Path

import pandas as pd
import ledapy
from ledapy import leda2

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
    default_sig_peak = leda2.settings.sigPeak  # Ledalab's own out-of-the-box value (0.001 - effectively no floor, see run_ledapy_tuned below)
    ledapy.runner.getResult(eda.values, 'phasicdriver', sampling_rate, downsample=1, optimisation=0)

    # leda2.analysis.{peakTime,amp} is Ledalab CDA's own discrete SCR table,
    # built from its deconvolved driver by analyse.signpeak() - this is
    # Ledalab's answer to "how many discrete responses were there", at its
    # own default sensitivity, the same "untouched defaults" baseline
    # run_neurokit.py measures for NeuroKit2.
    peak_times = leda2.analysis.peakTime
    peak_amps = leda2.analysis.amp
    pairs = [(float(t), float(a)) for t, a in zip(peak_times, peak_amps)
             if math.isfinite(t) and math.isfinite(a) and 0 <= t <= (ts[-1] if len(ts) else 0)]

    return {
        'sampling_rate': sampling_rate,
        'n_samples': len(df),
        'ledapy_peak_times': [p[0] for p in pairs],
        'ledapy_peak_amplitudes': [p[1] for p in pairs],
        'ledapy_sig_peak_default': default_sig_peak,
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
