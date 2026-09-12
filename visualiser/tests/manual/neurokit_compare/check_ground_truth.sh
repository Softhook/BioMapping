#!/usr/bin/env bash
# Ground-truth detector race: generates synthetic tracks with a KNOWN true
# SCR count/timing (NeuroKit2's own canonical response function, placed
# under our control - see generate_ground_truth.py), then scores our three
# detectors AND NeuroKit2's own default detector against that known answer.
# The one check in this investigation that asks "who's actually right",
# not "who agrees with whom".
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_ground_truth.sh
#   CLEAN_ONLY=1 BIOMAP_USE_GAIT_FILTER=0 ./check_ground_truth.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEUROKIT_PYTHON="${NEUROKIT_PYTHON:-$HOME/neurokit/.venv/bin/python}"

if [ ! -x "$NEUROKIT_PYTHON" ]; then
  echo "NeuroKit2 python not found at $NEUROKIT_PYTHON (set NEUROKIT_PYTHON=/path/to/python)" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t ground_truth.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Generating synthetic ground-truth tracks..." >&2
"$NEUROKIT_PYTHON" "$HERE/generate_ground_truth.py" "$WORK_DIR"

FILES=("$WORK_DIR"/*.csv)
if [ "${CLEAN_ONLY:-0}" = "1" ]; then
  FILES=("$WORK_DIR"/synth_sparse_clean.csv "$WORK_DIR"/synth_dense_clean.csv)
fi

echo "Running NeuroKit2 over ${#FILES[@]} synthetic track(s)..." >&2
NK_JSON="$WORK_DIR/neurokit.json"
"$NEUROKIT_PYTHON" "$HERE/run_neurokit.py" "${FILES[@]}" > "$NK_JSON"

for f in "${FILES[@]}"; do
  name="$(basename "$f" .csv)"
  gt="$WORK_DIR/$name.ground_truth.json"
  node "$HERE/check_ground_truth.js" "$gt" "$NK_JSON" "$f"
  echo
done
