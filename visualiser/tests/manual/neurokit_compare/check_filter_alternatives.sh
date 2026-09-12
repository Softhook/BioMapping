#!/usr/bin/env bash
# Filter-alternatives race: same synthetic ground-truth tracks as
# check_ground_truth.sh (regenerated fresh, now including synth_gait_tremor)
# scored against several candidate replacements for the production 0.5s box
# LPF - see check_filter_alternatives.js's docstring for why (that filter
# was found to systematically underestimate true SCR amplitude by ~28%).
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python).
#
# Usage: ./check_filter_alternatives.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEUROKIT_PYTHON="${NEUROKIT_PYTHON:-$HOME/neurokit/.venv/bin/python}"

if [ ! -x "$NEUROKIT_PYTHON" ]; then
  echo "NeuroKit2 python not found at $NEUROKIT_PYTHON (set NEUROKIT_PYTHON=/path/to/python)" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t filter_alt.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Generating synthetic ground-truth tracks..." >&2
"$NEUROKIT_PYTHON" "$HERE/generate_ground_truth.py" "$WORK_DIR"

FILES=("$WORK_DIR"/*.csv)

echo "Running NeuroKit2 over ${#FILES[@]} synthetic track(s)..." >&2
NK_JSON="$WORK_DIR/neurokit.json"
"$NEUROKIT_PYTHON" "$HERE/run_neurokit.py" "${FILES[@]}" > "$NK_JSON"

node "$HERE/check_filter_alternatives.js" "$WORK_DIR" "$NK_JSON"
