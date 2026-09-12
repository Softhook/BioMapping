#!/usr/bin/env bash
# Recovery-time (half-decay) algorithm check: does our forward-scan
# _findRecoveryIndex agree with NeuroKit2's closest-value segment search
# (eda_peaks.py::_eda_peaks_getfeatures)? Both run on the exact same
# phasic curve and the exact same peaks/onsets/amplitudes - see
# check_recovery_agreement.js for rationale.
#
# Requires a Python env with neurokit2 (default: ~/neurokit/.venv, override
# with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_recovery_agreement.sh                      # default tracks
#   ./check_recovery_agreement.sh biomap_019 biomap_105 # explicit tracks
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKS_DIR="$(cd "$HERE/../../../../tracks" && pwd)"
NEUROKIT_PYTHON="${NEUROKIT_PYTHON:-$HOME/neurokit/.venv/bin/python}"

if [ ! -x "$NEUROKIT_PYTHON" ]; then
  echo "NeuroKit2 python not found at $NEUROKIT_PYTHON (set NEUROKIT_PYTHON=/path/to/python)" >&2
  exit 1
fi

TRACK_NAMES=("$@")
if [ ${#TRACK_NAMES[@]} -eq 0 ]; then
  TRACK_NAMES=(biomap_live_2026-09-10T17-20-02-105Z)
elif [ "${1:-}" = "all" ]; then
  TRACK_NAMES=(biomap_live_2026-09-10T17-20-02-105Z biomap_019 biomap_027 biomap_053 biomap_059)
fi

for name in "${TRACK_NAMES[@]}"; do
  f="$TRACKS_DIR/$name.csv"
  if [ ! -f "$f" ]; then
    echo "Track not found: $f" >&2
    exit 1
  fi
  OURS_JSON="$(mktemp -t recovery_ours.XXXXXX.json)"
  NK_JSON="$(mktemp -t recovery_nk.XXXXXX.json)"
  node "$HERE/check_recovery_agreement.js" dump "$f" "$OURS_JSON"
  "$NEUROKIT_PYTHON" "$HERE/check_recovery_agreement.py" "$OURS_JSON" > "$NK_JSON"
  node "$HERE/check_recovery_agreement.js" compare "$OURS_JSON" "$NK_JSON" "$f"
  rm -f "$OURS_JSON" "$NK_JSON"
done
