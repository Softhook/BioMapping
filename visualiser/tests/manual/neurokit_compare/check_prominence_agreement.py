"""
Peak-detection algorithm check (Python side) - see check_prominence_agreement.js
for what this isolates and why.

Reads the phasic curve check_prominence_agreement.js dumped (our own default
decomposition's output - identical input, not a NeuroKit2 signal) and runs
NeuroKit2's own signal_findpeaks() on it with NO gating (no relative_height_min),
so it reports the "Height" (== prominence) of every local maximum it finds -
the same underlying computation eda_findpeaks(method='neurokit') gates on with
relative_height_min=0.1, minus the gating itself.

Usage: python3 check_prominence_agreement.py path/to/dumped_phasic.json > out.json
       (normally invoked via check_prominence_agreement.sh, not directly)
"""
import json
import sys

import neurokit2 as nk


def main():
    if len(sys.argv) != 2:
        print('Usage: python3 check_prominence_agreement.py path/to/dumped_phasic.json', file=sys.stderr)
        sys.exit(1)

    dumped = json.load(open(sys.argv[1]))
    phasic = dumped['phasic']

    info = nk.signal_findpeaks(phasic)  # no gating - report every local max

    json.dump({
        'peaks': [int(i) for i in info['Peaks']],
        'heights': [float(h) for h in info['Height']],
    }, sys.stdout)


if __name__ == '__main__':
    main()
