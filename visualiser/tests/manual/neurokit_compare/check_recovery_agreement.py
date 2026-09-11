"""
Recovery-time algorithm check (Python side) - see check_recovery_agreement.js
for what this isolates.

Replicates NeuroKit2's own recovery-finding logic exactly
(eda_peaks.py::_eda_peaks_getfeatures's recovery-time block), fed OUR
peaks/onsets/amplitudes (not NeuroKit2's own detection) so this is a pure
algorithm-isolation test, matching how check_prominence_agreement.py and
check_onset_agreement.py both work.

Usage: python3 check_recovery_agreement.py path/to/dumped.json > out.json
       (normally invoked via check_recovery_agreement.sh, not directly)
"""
import json
import sys

import numpy as np
import neurokit2 as nk


def main():
    if len(sys.argv) != 2:
        print('Usage: python3 check_recovery_agreement.py path/to/dumped.json', file=sys.stderr)
        sys.exit(1)

    dumped = json.load(open(sys.argv[1]))
    phasic = np.array(dumped['phasic'])
    ours = dumped['ours']
    peaks = [r['peakIndex'] for r in ours]
    amplitudes = [r['amplitude'] for r in ours]
    onsets = [r['onsetIndex'] for r in ours]

    recovery_percentage = 0.5
    recovery_index = [-1] * len(peaks)

    for i, peak_index in enumerate(peaks):
        recovery_value_target = phasic[onsets[i]] + amplitudes[i] * recovery_percentage

        if i + 1 < len(peaks):
            segment = phasic[peak_index:peaks[i + 1]]
        else:
            segment = phasic[peak_index:]

        if len(segment) == 0:
            continue
        argmin = int(np.argmin(segment))
        segment = segment[0:argmin]
        if len(segment) == 0:
            continue

        recovery_value = nk.find_closest(recovery_value_target, segment, direction='smaller', strictly=False)
        if np.isnan(recovery_value):
            continue

        if np.min(segment) < recovery_value:
            segment_index = int(np.where(segment == recovery_value)[0][0])
            recovery_index[i] = peak_index + segment_index

    json.dump({
        'peak_index': [int(p) for p in peaks],
        'recovery_index': recovery_index,
    }, sys.stdout)


if __name__ == '__main__':
    main()
