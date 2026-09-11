"""
Batch NeuroKit2 EDA processing for the detector-comparison benchmark
(see compare.js in this folder). For each track CSV given on the command
line, runs nk.eda_process() and emits SCR peak/onset times as JSON on
stdout, keyed by track name.

Manual/occasional script, not run in CI: needs a Python environment with
neurokit2 + pandas + cvxopt installed (cvxopt is required for NeuroKit2's
own eda_phasic(method='cvxeda') - without it the cvxEDA reference peaks
come back empty). The project's own venv lives outside this repo, e.g.
~/neurokit/.venv - point NEUROKIT_PYTHON in run.sh at it, or just activate
it yourself before calling this directly.

Usage: python3 run_neurokit.py path/to/biomap_027.csv [more.csv ...]
       (normally invoked via run.sh, not directly)
"""
import json
import sys
from pathlib import Path

import pandas as pd
import neurokit2 as nk


# Mirrors GSRCSVParser's auto unit-detection in
# visualiser/src/signal/csv_parser.js (~line 755-769): our own analyzer never
# sees the bare gsr_raw column value - it converts to microsiemens first,
# picking resistance-to-conductance or a /1000 rescale based on the average
# magnitude. Skipping this here would feed NeuroKit2 raw ADC-scale values
# (thousands, not the single-digit-to-low-double-digit uS BioMapping tracks
# actually carry), silently invalidating amplitude-based comparisons like
# eda_peaks's amplitude_min=0.1uS and cvxEDA's alpha/gamma penalty weights,
# both of which assume real uS scale.
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

    dt = pd.Series(ts).diff()
    dt = dt[dt > 0]
    sampling_rate = 1.0 / dt.mean() if len(dt) else 10.0

    # Default pipeline: eda_process(method='neurokit') decomposes with a
    # highpass filter (NOT cvxEDA) then peak-picks on that. This is the
    # right reference for our filter-based detectors (Full-Scan, Prominence),
    # which likewise decompose with a plain LPF tonic estimate.
    _signals, info = nk.eda_process(eda, sampling_rate=sampling_rate)
    peak_idx = [i for i in info.get('SCR_Peaks', []) if 0 <= i < len(ts)]
    onset_idx = [i for i in info.get('SCR_Onsets', []) if 0 <= i < len(ts)]

    # cvxEDA-specific pipeline: NeuroKit2 has its own cvxEDA decomposition
    # (eda_phasic(method='cvxeda'), requires cvxopt) distinct from its
    # default highpass method. eda_process() has no method='cvxeda' shortcut
    # (it rejects the name as a cleaning method), so this replicates its
    # internal order by hand: clean first via eda_clean() - the same call
    # the default pipeline above makes, so both references start from the
    # same NeuroKit-smoothed signal - then decompose with cvxEDA instead of
    # the default highpass filter. Skipping eda_clean() here would silently
    # feed cvxEDA raw, unsmoothed data while the default reference gets
    # NeuroKit's 3 Hz Butterworth cleaning, breaking the like-for-like
    # comparison this reference exists for.
    cvxeda_peak_times = []
    try:
        cleaned = nk.eda_clean(eda, sampling_rate=sampling_rate)
        phasic_df = nk.eda_phasic(cleaned, sampling_rate=sampling_rate, method='cvxeda')
        _, cvx_info = nk.eda_peaks(phasic_df['EDA_Phasic'].values, sampling_rate=sampling_rate)
        cvx_idx = [i for i in cvx_info.get('SCR_Peaks', []) if 0 <= i < len(ts)]
        cvxeda_peak_times = [float(ts[i]) for i in cvx_idx]
    except Exception as exc:  # noqa: BLE001 - report and continue the batch
        print(f'  cvxEDA reference failed: {exc}', file=sys.stderr)

    return {
        'sampling_rate': sampling_rate,
        'n_samples': len(df),
        'peak_times': [float(ts[i]) for i in peak_idx],
        'onset_times': [float(ts[i]) for i in onset_idx],
        'cvxeda_peak_times': cvxeda_peak_times,
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
