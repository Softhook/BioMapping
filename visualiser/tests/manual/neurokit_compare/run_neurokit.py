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
import math
import os
import sys
from pathlib import Path

import pandas as pd
import neurokit2 as nk
from scipy.signal import find_peaks, peak_prominences

HERE = Path(__file__).resolve().parent

# Literature-tuned absolute peak floor: the methodologically rigorous minority
# of published NeuroKit2 EDA studies (Gamboa et al. 2025, PMC11946426; Xu et
# al. 2026, PMC13306266; Sullivan et al. 2026, PMC12828444) override NK2's
# default eda_peaks() relative-prominence gate (10% of that recording's own
# largest peak - see eda_phasic_cvxeda_standardized below for why NK2's own
# cvxEDA reference already suffers from this) with an ABSOLUTE threshold in
# the classical Boucsein (2012) / SPR range, applied to the cvxEDA phasic
# signal via scipy.signal.find_peaks rather than nk.eda_peaks(). This mirrors
# that literature practice, not BioMapping's own production peakThreshold
# (0.045 uS, tuned against a different onset-to-peak amplitude definition -
# see neurokit_comparison_plan.md item 13).
LITERATURE_ABSOLUTE_PEAK_US = 0.02  # Gamboa et al. 2025's enforced floor
LITERATURE_REFRACTORY_S = 1.0  # Xu et al. 2026's distance=fs convention


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
    if len(ts) > 0:
        ts = ts - ts[0]

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
    # NeuroKit2's own SCR_Amplitude can come back NaN for peaks too close to
    # a signal edge to compute an onset-relative amplitude (its internal
    # feature extraction returns NaN rather than dropping the peak); a NaN
    # literal is not valid JSON, so it must be filtered here or json.dumps()
    # below emits a token `NaN` that breaks every downstream JSON.parse.
    peak_pairs = [(i, a) for i, a in zip(info.get('SCR_Peaks', []), info.get('SCR_Amplitude', [])) if 0 <= i < len(ts) and math.isfinite(a)]
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
    cvxeda_lit_peak_times = []
    cvxeda_lit_peak_amplitudes = []
    try:
        cleaned = nk.eda_clean(eda, sampling_rate=sampling_rate)
        phasic_df = eda_phasic_cvxeda_standardized(cleaned, sampling_rate)
        phasic_vals = phasic_df['EDA_Phasic'].values
        _, cvx_info = nk.eda_peaks(phasic_vals, sampling_rate=sampling_rate)
        cvx_pairs = [(i, a) for i, a in zip(cvx_info.get('SCR_Peaks', []), cvx_info.get('SCR_Amplitude', [])) if 0 <= i < len(ts) and math.isfinite(a)]
        cvxeda_peak_times = [float(ts[i]) for i, _ in cvx_pairs]
        cvxeda_peak_amplitudes = [float(a) for _, a in cvx_pairs]

        # Literature-tuned comparator: same cvxEDA phasic signal, but peak-pick
        # with scipy.signal.find_peaks against an absolute prominence floor and
        # refractory distance instead of nk.eda_peaks()'s relative gate - see
        # LITERATURE_ABSOLUTE_PEAK_US above for citations. Prominence (not raw
        # height) matches what the cited papers actually threshold on.
        distance_samples = max(1, round(LITERATURE_REFRACTORY_S * sampling_rate))
        lit_idx, _ = find_peaks(phasic_vals, prominence=LITERATURE_ABSOLUTE_PEAK_US, distance=distance_samples)
        if len(lit_idx) > 0:
            lit_prominences = peak_prominences(phasic_vals, lit_idx)[0]
            cvxeda_lit_peak_times = [float(ts[i]) for i in lit_idx if 0 <= i < len(ts)]
            cvxeda_lit_peak_amplitudes = [float(p) for i, p in zip(lit_idx, lit_prominences) if 0 <= i < len(ts)]
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
        'cvxeda_lit_peak_times': cvxeda_lit_peak_times,
        'cvxeda_lit_peak_amplitudes': cvxeda_lit_peak_amplitudes,
    }


CACHE_DIR = Path(os.environ.get('NEUROKIT_CACHE_DIR', HERE / '.cache' / 'neurokit'))
NO_CACHE = os.environ.get('NO_CACHE') == '1'


def main():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    csv_paths = [Path(p) for p in sys.argv[1:]]
    for idx, csv_path in enumerate(csv_paths, 1):
        name = csv_path.stem
        if csv_path.stat().st_size == 0:
            print(f'[{idx}/{len(csv_paths)}] Skipping empty {name}', file=sys.stderr)
            continue

        cache_file = CACHE_DIR / f'{name}.json'
        if not NO_CACHE and cache_file.exists() and cache_file.stat().st_mtime >= csv_path.stat().st_mtime:
            try:
                with open(cache_file, 'r') as f:
                    out[name] = json.load(f)
                if len(csv_paths) > 6:
                    print(f'[{idx}/{len(csv_paths)}] {name} (cached)', file=sys.stderr)
                continue
            except Exception:
                pass

        print(f'[{idx}/{len(csv_paths)}] Processing {name}...', file=sys.stderr)
        try:
            res = process(csv_path)
            out[name] = res
            with open(cache_file, 'w') as f:
                json.dump(res, f)
        except Exception as exc:  # noqa: BLE001 - report and continue the batch
            print(f'  FAILED: {exc}', file=sys.stderr)
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
