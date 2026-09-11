"""
Third-smallest NeuroKit2 alignment check: tonic/phasic decomposition, the
stage after cleaning (see check_cleaning_agreement.py) and before peak
detection. Two decomposition families are dumped, each paired with the one
of ours that shares its underlying algorithm (see compare.js's own
DETECTORS table for the same pairing rule):

  - 'highpass' family: NeuroKit2's default eda_phasic(method='highpass') vs
    our default LPF + zero-phase-EMA-with-local-floor-correction tonic.
    These are NOT the same algorithm - comparing them tells us how far two
    legitimately different decomposition approaches land from each other.
  - 'cvxeda' family: NeuroKit2's own eda_phasic(method='cvxeda') vs our
    cvxeda.js port of the same published algorithm (Greco et al. 2016).
    These SHOULD agree closely - both solve the same convex problem - so
    this pairing is the one place an exact-match expectation is reasonable.

Usage: python3 check_decomposition_agreement.py path/to/biomap_027.csv
       (normally invoked via check_decomposition_agreement.sh, not directly)
"""
import json
import sys
from pathlib import Path

import pandas as pd
import neurokit2 as nk

sys.path.insert(0, str(Path(__file__).parent))
from run_neurokit import to_microsiemens, eda_phasic_cvxeda_standardized  # noqa: E402


def main():
    if len(sys.argv) != 2:
        print('Usage: python3 check_decomposition_agreement.py path/to/track.csv', file=sys.stderr)
        sys.exit(1)

    csv_path = sys.argv[1]
    df = pd.read_csv(csv_path, comment='#')
    eda = to_microsiemens(df['gsr_raw'].astype(float), 'gsr_raw')
    ts = df['timestamp'].values

    dt = pd.Series(ts).diff()
    dt = dt[dt > 0]
    sampling_rate = 1.0 / dt.mean() if len(dt) else 10.0

    cleaned = nk.eda_clean(eda, sampling_rate=sampling_rate, method='neurokit')

    hp = nk.eda_phasic(cleaned, sampling_rate=sampling_rate, method='highpass')

    out = {
        'sampling_rate': sampling_rate,
        'n_samples': len(df),
        'hp_tonic': [float(v) for v in hp['EDA_Tonic'].values],
        'hp_phasic': [float(v) for v in hp['EDA_Phasic'].values],
        'cvx_tonic': None,
        'cvx_phasic': None,
    }

    try:
        cvx = eda_phasic_cvxeda_standardized(cleaned, sampling_rate)
        out['cvx_tonic'] = [float(v) for v in cvx['EDA_Tonic'].values]
        out['cvx_phasic'] = [float(v) for v in cvx['EDA_Phasic'].values]
    except Exception as exc:  # noqa: BLE001 - report and continue
        print(f'  cvxEDA reference failed: {exc}', file=sys.stderr)

    json.dump(out, sys.stdout)


if __name__ == '__main__':
    main()
