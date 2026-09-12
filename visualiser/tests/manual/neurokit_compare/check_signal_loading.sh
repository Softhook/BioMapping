#!/usr/bin/env bash
# Smallest possible NeuroKit2 alignment check: confirms our GSRCSVParser and
# NeuroKit2's own loading path agree on the raw EDA signal, sample-for-sample,
# before any filtering/decomposition/peak-picking. Run this first - if it
# fails, nothing run.sh reports (detector agreement) can be trusted.
#
# Requires a Python env with pandas (default: ~/neurokit/.venv, override with
# NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_signal_loading.sh                      # default track set
#   ./check_signal_loading.sh biomap_019 biomap_105 # explicit tracks (by stem)
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

STATUS=0
for name in "${TRACK_NAMES[@]}"; do
  f="$TRACKS_DIR/$name.csv"
  if [ ! -f "$f" ]; then
    echo "Track not found: $f" >&2
    exit 1
  fi
  TMP_JSON="$(mktemp -t signal_loading.XXXXXX.json)"
  "$NEUROKIT_PYTHON" "$HERE/check_signal_loading.py" "$f" > "$TMP_JSON"
  node "$HERE/check_signal_loading.js" "$TMP_JSON" "$f" || STATUS=1
  rm -f "$TMP_JSON"
done

exit $STATUS
