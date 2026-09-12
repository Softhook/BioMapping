#!/usr/bin/env bash
# Runs the NeuroKit2 vs our-detectors comparison benchmark over a set of
# tracks. Manual/occasional, not run in CI - re-run after changing
# analyzer.js's peak detectors, or when adding new reference tracks, to see
# how detector agreement moved.
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./run.sh                                  # default track set
#   ./run.sh biomap_019 biomap_105             # explicit tracks (by stem)
#   BIOMAP_PEAK_THRESHOLD=0.1 ./run.sh         # benchmark-only gate experiment
#   BIOMAP_PEAK_MIN_GAP=4 ./run.sh              # benchmark-only refractory experiment
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

TMP_JSON="$(mktemp -t neurokit_compare.XXXXXX.json)"
trap 'rm -f "$TMP_JSON"' EXIT

echo "Running NeuroKit2 over ${#FILES[@]} track(s)..." >&2
"$NEUROKIT_PYTHON" "$HERE/run_neurokit.py" "${FILES[@]}" > "$TMP_JSON"

node "$HERE/compare.js" "$TMP_JSON" "${FILES[@]}"
