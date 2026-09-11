"""
Second-smallest NeuroKit2 alignment check: the first actual algorithm each
side runs on the (now confirmed-identical, see check_signal_loading.py) raw
signal - cleaning/smoothing, before tonic/phasic decomposition or peak
detection touch it.

Unlike check_signal_loading.py this is NOT a pass/fail exact-match check:
our GSRAnalyzer cleans with a 0.5s zero-phase moving-average box filter
(GSR_DEFAULT.lpfWindow) and NeuroKit2's eda_clean(method='neurokit') is a
4th-order 3Hz Butterworth low-pass - two different, both legitimate, filter
designs. This reports how far apart they land (correlation, RMSE) so later
stages (tonic/phasic, peaks) have a known baseline to compare against - if a
later stage's disagreement is no worse than this one, the divergence lives
entirely in the cleaning-filter choice; if it's much worse, something new
was introduced downstream.

Usage: python3 check_cleaning_agreement.py path/to/biomap_027.csv
       (normally invoked via check_cleaning_agreement.sh, not directly)
"""
import json
import sys
from pathlib import Path

import pandas as pd
import neurokit2 as nk

sys.path.insert(0, str(Path(__file__).parent))
from run_neurokit import to_microsiemens  # noqa: E402


def main():
    if len(sys.argv) != 2:
        print('Usage: python3 check_cleaning_agreement.py path/to/track.csv', file=sys.stderr)
        sys.exit(1)

    csv_path = sys.argv[1]
    df = pd.read_csv(csv_path, comment='#')
    eda = to_microsiemens(df['gsr_raw'].astype(float), 'gsr_raw')
    ts = df['timestamp'].values

    dt = pd.Series(ts).diff()
    dt = dt[dt > 0]
    sampling_rate = 1.0 / dt.mean() if len(dt) else 10.0

    cleaned = nk.eda_clean(eda, sampling_rate=sampling_rate, method='neurokit')

    json.dump({
        'sampling_rate': sampling_rate,
        'n_samples': len(df),
        'cleaned': [float(v) for v in cleaned],
    }, sys.stdout)


if __name__ == '__main__':
    main()
