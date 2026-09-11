#!/usr/bin/env bash
# Prominence detector, gated NeuroKit2's actual way: per-track 10%-of-own-max
# prominence, instead of BioMapping's fixed absolute peakThreshold. See
# check_relative_threshold.js for why this redoes an earlier, mistaken
# absolute-threshold sweep properly.
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_relative_threshold.sh                      # default track set
#   ./check_relative_threshold.sh biomap_019 biomap_105 # explicit tracks
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
  TRACK_NAMES=(biomap_019 biomap_027 biomap_053 biomap_059)
fi

FILES=()
for name in "${TRACK_NAMES[@]}"; do
  f="$TRACKS_DIR/$name.csv"
  if [ ! -f "$f" ]; then
    echo "Track not found: $f" >&2
    exit 1
  fi
  FILES+=("$f")
done

TMP_JSON="$(mktemp -t relative_threshold.XXXXXX.json)"
trap 'rm -f "$TMP_JSON"' EXIT

echo "Running NeuroKit2 over ${#FILES[@]} track(s)..." >&2
"$NEUROKIT_PYTHON" "$HERE/run_neurokit.py" "${FILES[@]}" > "$TMP_JSON"

node "$HERE/check_relative_threshold.js" "$TMP_JSON" "${FILES[@]}"
