"""
Smallest possible NeuroKit2 alignment check: does the raw EDA signal each
side hands to its own algorithms actually agree, sample-for-sample, before
any filtering/decomposition/peak-picking happens?

This is deliberately the floor beneath compare.js (which compares detected
peaks after full pipelines). If this check fails, nothing built on top of it
- filter comparisons, tonic/phasic comparisons, peak comparisons - can be
trusted, because the two sides would not even be looking at the same numbers.

Reuses to_microsiemens() from run_neurokit.py rather than redefining it, so
the two tools can't drift out of sync on the unit-conversion rule.

Usage: python3 check_signal_loading.py path/to/biomap_027.csv
       (normally invoked via check_signal_loading.sh, not directly)
"""
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from run_neurokit import to_microsiemens  # noqa: E402


def main():
    if len(sys.argv) != 2:
        print('Usage: python3 check_signal_loading.py path/to/track.csv', file=sys.stderr)
        sys.exit(1)

    csv_path = sys.argv[1]
    df = pd.read_csv(csv_path, comment='#')
    eda = to_microsiemens(df['gsr_raw'].astype(float), 'gsr_raw')
    ts = df['timestamp'].values

    json.dump({
        'n_samples': len(df),
        'timestamps': [float(t) for t in ts],
        'values': [float(v) for v in eda],
    }, sys.stdout)


if __name__ == '__main__':
    main()
