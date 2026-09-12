#!/usr/bin/env bash
# Second-smallest NeuroKit2 alignment check: reports how closely our cleaning
# filter (0.5s zero-phase box LPF) and NeuroKit2's eda_clean() (4th-order 3Hz
# Butterworth) agree on the raw signal - see check_cleaning_agreement.py for
# why this is a correlation report, not a pass/fail check. Run
# check_signal_loading.sh first; this assumes the raw signal already matches.
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_cleaning_agreement.sh                      # default track set
#   ./check_cleaning_agreement.sh biomap_019 biomap_105 # explicit tracks
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
  TRACK_NAMES=(biomap_019 biomap_027 biomap_053 biomap_059 biomap_live_2026-09-10T17-20-02-105Z)
fi

for name in "${TRACK_NAMES[@]}"; do
  f="$TRACKS_DIR/$name.csv"
  if [ ! -f "$f" ]; then
    echo "Track not found: $f" >&2
    exit 1
  fi
  TMP_JSON="$(mktemp -t cleaning_agreement.XXXXXX.json)"
  "$NEUROKIT_PYTHON" "$HERE/check_cleaning_agreement.py" "$f" > "$TMP_JSON"
  node "$HERE/check_cleaning_agreement.js" "$TMP_JSON" "$f"
  rm -f "$TMP_JSON"
done
