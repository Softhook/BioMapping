#!/usr/bin/env bash
# Onset-detection algorithm check: does our Full-Scan onset walk
# (_findOnsetIndex, minDip=0) agree with NeuroKit2's own onset logic
# (signal_findpeaks -> nearest strictly-smaller-index trough)? Both run on
# the exact same phasic curve - see check_onset_agreement.js for rationale.
#
# Requires a Python env with neurokit2 + scipy (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_onset_agreement.sh                      # default tracks
#   ./check_onset_agreement.sh biomap_019 biomap_105 # explicit tracks
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
  OURS_JSON="$(mktemp -t onset_ours.XXXXXX.json)"
  NK_JSON="$(mktemp -t onset_nk.XXXXXX.json)"
  node "$HERE/check_onset_agreement.js" dump "$f" "$OURS_JSON"
  "$NEUROKIT_PYTHON" "$HERE/check_onset_agreement.py" "$OURS_JSON" > "$NK_JSON"
  node "$HERE/check_onset_agreement.js" compare "$OURS_JSON" "$NK_JSON" "$f"
  rm -f "$OURS_JSON" "$NK_JSON"
done
