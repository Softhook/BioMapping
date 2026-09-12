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


# NeuroKit2's eda_phasic(method='cvxeda') does NOT standardize its input
# itself - its own docs' worked example calls it as
# eda_phasic(nk.standardize(eda_signal), ...), i.e. standardizing is on the
# caller. cvxEDA's alpha (L1 driver sparsity) and gamma (L2 tonic-spline
# smoothness) are ABSOLUTE penalty weights, calibrated in the reference paper
# for a unit-variance signal - feed it raw microsiemens-scale data instead
# and the same nominal alpha/gamma bite harder or softer depending on the
# track's actual signal std, purely as a side effect of scale.
#
# Our own cvxeda.js always z-scores internally before solving (its
# `normalize` option, default true - see that file's docstring: "keeps the
# published alpha=8e-4 meaningful"), so comparing it against an
# unstandardized NeuroKit2 run isn't apples-to-apples. This was found via
# check_decomposition_agreement.sh: cvxEDA-family phasic correlation ranged
# from 0.86 to 0.999 across 4 tracks, tracking each track's raw signal std
# (further from 1uS -> worse agreement) rather than anything track-length- or
# solver-quality-related. Standardizing first (mirroring cvxeda.js's own
# convention) closed most of that gap in direct testing.
def eda_phasic_cvxeda_standardized(cleaned, sampling_rate):
    mean = cleaned.mean()
    std = cleaned.std()
    if not (std > 1e-8):
        std = 1.0
    cleaned_z = (cleaned - mean) / std
    phasic_df = nk.eda_phasic(cleaned_z, sampling_rate=sampling_rate, method='cvxeda')
    phasic_df['EDA_Tonic'] = phasic_df['EDA_Tonic'] * std + mean
    phasic_df['EDA_Phasic'] = phasic_df['EDA_Phasic'] * std
    return phasic_df


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
    onset_idx = [i for i in info.get('SCR_Onsets', []) if 0 <= i < len(ts)]
    # Paired via zip, not two separate filtered list comps: SCR_Amplitude is
    # parallel to SCR_Peaks (same index, same order - NeuroKit2 computes both
    # in the same per-peak loop), and filtering each list independently would
    # silently misalign amplitude[i] with peak[i] the moment any peak index
    # fails the bounds check.
    peak_pairs = [(i, a) for i, a in zip(info.get('SCR_Peaks', []), info.get('SCR_Amplitude', [])) if 0 <= i < len(ts)]
    peak_idx = [i for i, _ in peak_pairs]
    peak_amplitudes = [float(a) for _, a in peak_pairs]

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
    cvxeda_peak_amplitudes = []
    try:
        cleaned = nk.eda_clean(eda, sampling_rate=sampling_rate)
        phasic_df = eda_phasic_cvxeda_standardized(cleaned, sampling_rate)
        _, cvx_info = nk.eda_peaks(phasic_df['EDA_Phasic'].values, sampling_rate=sampling_rate)
        cvx_pairs = [(i, a) for i, a in zip(cvx_info.get('SCR_Peaks', []), cvx_info.get('SCR_Amplitude', [])) if 0 <= i < len(ts)]
        cvxeda_peak_times = [float(ts[i]) for i, _ in cvx_pairs]
        cvxeda_peak_amplitudes = [float(a) for _, a in cvx_pairs]
    except Exception as exc:  # noqa: BLE001 - report and continue the batch
        print(f'  cvxEDA reference failed: {exc}', file=sys.stderr)

    return {
        'sampling_rate': sampling_rate,
        'n_samples': len(df),
        'peak_times': [float(ts[i]) for i in peak_idx],
        'peak_amplitudes': peak_amplitudes,
        'onset_times': [float(ts[i]) for i in onset_idx],
        'cvxeda_peak_times': cvxeda_peak_times,
        'cvxeda_peak_amplitudes': cvxeda_peak_amplitudes,
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
