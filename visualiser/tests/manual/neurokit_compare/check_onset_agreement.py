"""
Onset-detection algorithm check (Python side) - see check_onset_agreement.js
for what this isolates.

Reads the phasic curve + peak-index list check_onset_agreement.js dumped and
replicates NeuroKit2's own onset logic exactly (signal_findpeaks.py's
_signal_findpeaks_findbase): find every strict local minimum via
scipy.signal.find_peaks(-signal) once for the whole curve, then for each
peak index, the CLOSEST trough with strictly smaller index
(nk.find_closest(..., direction='smaller', strictly=True)).

Usage: python3 check_onset_agreement.py path/to/dumped.json > out.json
       (normally invoked via check_onset_agreement.sh, not directly)
"""
import json
import sys

import numpy as np
import scipy.signal
import neurokit2 as nk


def main():
    if len(sys.argv) != 2:
        print('Usage: python3 check_onset_agreement.py path/to/dumped.json', file=sys.stderr)
        sys.exit(1)

    dumped = json.load(open(sys.argv[1]))
    phasic = np.array(dumped['phasic'])
    peak_indices = [r['peakIndex'] for r in dumped['ours']]

    troughs, _ = scipy.signal.find_peaks(-1 * phasic)
    onsets = nk.find_closest(np.array(peak_indices), troughs, direction='smaller', strictly=True)

    json.dump({
        'peak_index': [int(p) for p in peak_indices],
        'onset_index': [int(o) if not np.isnan(o) else -1 for o in np.atleast_1d(onsets)],
    }, sys.stdout)


if __name__ == '__main__':
    main()
