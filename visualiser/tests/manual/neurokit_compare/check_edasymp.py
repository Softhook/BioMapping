"""
EDASymp (0.045-0.25 Hz spectral sympathetic index) comparison - NeuroKit2
reference side.

Runs NeuroKit2's own `nk.eda_sympathetic(..., method='posada2016')` on each
track and emits the scalar indexes as JSON on stdout, keyed by track name.
The JS side (check_edasymp.js) computes BioMapping's SpectralEDA scalar on
the same raw signal and reports per-track ratio + cross-track correlation.

Why the comparison is a scalar (not a per-sample series): NeuroKit2's
posada2016 implementation returns ONE number per recording - the trapezoidal
integral of the Welch PSD (nperseg=128 @ 2 Hz = 64 s, 50 % overlap, periodic
Blackman window, nfft=256) over [0.045, 0.25) Hz. BioMapping's standalone
metric is the sliding-window extension of that same integral; the whole-
recording scalar is what must agree with NeuroKit2.

See docs/edasymp_spectral_investigation_proposal.md.

Usage: python3 check_edasymp.py track.csv [more.csv ...]
       (normally invoked via check_edasymp.sh, not directly)
"""
import json
import sys
from pathlib import Path

import pandas as pd
import numpy as np
import neurokit2 as nk

sys.path.insert(0, str(Path(__file__).parent))
from run_neurokit import to_microsiemens  # noqa: E402


def process(csv_path):
    df = pd.read_csv(csv_path, comment='#')
    eda = to_microsiemens(df['gsr_raw'].astype(float), 'gsr_raw')

    ts = df['timestamp'].values
    dt = pd.Series(ts).diff()
    dt = dt[dt > 0]
    sampling_rate = 1.0 / dt.mean() if len(dt) else 10.0

    res = nk.eda_sympathetic(eda, sampling_rate=sampling_rate, method='posada2016')

    symp = res['EDA_Sympathetic']
    symp_n = res['EDA_SympatheticN']
    return {
        'n_samples': len(df),
        'sampling_rate': float(sampling_rate),
        'eda_sympathetic': None if pd.isna(symp) else float(symp),
        'eda_sympathetic_n': None if pd.isna(symp_n) else float(symp_n),
    }


def main():
    if len(sys.argv) < 2:
        print('Usage: python3 check_edasymp.py track.csv [more.csv ...]', file=sys.stderr)
        sys.exit(1)

    out = {}
    for path in sys.argv[1:]:
        out[Path(path).stem] = process(path)
    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
