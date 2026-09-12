#!/usr/bin/env bash
# Peak-detection algorithm check: does our topographic-prominence computation
# (_topographicProminence(), which _detectPeaksByProminence() gates) agree
# with NeuroKit2's own (signal_findpeaks()'s "Height" field, which
# eda_findpeaks(method='neurokit') gates with relative_height_min)? Both run
# on the exact same phasic curve, so this isolates the prominence ALGORITHM
# from decomposition and thresholding differences - see
# check_prominence_agreement.js for the full rationale.
#
# Requires a Python env with neurokit2 (default: ~/neurokit/.venv, override
# with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_prominence_agreement.sh                      # default tracks
#   ./check_prominence_agreement.sh biomap_019 biomap_105 # explicit tracks
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
  OURS_JSON="$(mktemp -t prominence_ours.XXXXXX.json)"
  NK_JSON="$(mktemp -t prominence_nk.XXXXXX.json)"
  node "$HERE/check_prominence_agreement.js" dump "$f" "$OURS_JSON"
  "$NEUROKIT_PYTHON" "$HERE/check_prominence_agreement.py" "$OURS_JSON" > "$NK_JSON"
  node "$HERE/check_prominence_agreement.js" compare "$OURS_JSON" "$NK_JSON" "$f"
  rm -f "$OURS_JSON" "$NK_JSON"
done
