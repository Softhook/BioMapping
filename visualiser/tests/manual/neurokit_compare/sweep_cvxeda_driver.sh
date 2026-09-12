#!/usr/bin/env bash
# Sweeps the driver-domain candidate-detection parameters the cvxEDA peak
# detector added 2026-09-12 (see eda_detection_benchmark.md item 19):
# cvxImpulseThreshold (driver amplitude floor), cvxMinImpulseGapSec (driver
# refractory gap), cvxApexSearchHalfWinSec (apex-resolution search window).
# Decomposition (the expensive cvxEDA solve) runs once per track; the sweep
# itself only re-scans the cached driver/curve, so this is fast.
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python) only to generate tracks -
# NeuroKit2 itself is not invoked in the sweep.
#
# Usage:
#   ./sweep_cvxeda_driver.sh                  # clean suite, 3 seeds (default)
#   CLEAN_ONLY=0 ./sweep_cvxeda_driver.sh      # full 10-scenario suite, 1 seed
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEUROKIT_PYTHON="${NEUROKIT_PYTHON:-$HOME/neurokit/.venv/bin/python}"

if [ ! -x "$NEUROKIT_PYTHON" ]; then
  echo "NeuroKit2 python not found at $NEUROKIT_PYTHON (set NEUROKIT_PYTHON=/path/to/python)" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t cvxeda_sweep.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

CLEAN_ONLY="${CLEAN_ONLY:-1}"
if [ "$CLEAN_ONLY" = "1" ]; then
  export GROUND_TRUTH_NUM_SEEDS="${GROUND_TRUTH_NUM_SEEDS:-3}"
else
  export GROUND_TRUTH_NUM_SEEDS="${GROUND_TRUTH_NUM_SEEDS:-1}"
fi

echo "Generating synthetic ground-truth tracks (num_seeds=$GROUND_TRUTH_NUM_SEEDS)..." >&2
"$NEUROKIT_PYTHON" "$HERE/generate_ground_truth.py" "$WORK_DIR" >&2

FILES=("$WORK_DIR"/*.csv)
if [ "$CLEAN_ONLY" = "1" ]; then
  FILES=(
    "$WORK_DIR"/synth_sparse_clean*.csv
    "$WORK_DIR"/synth_dense_clean*.csv
    "$WORK_DIR"/synth_compound_clean*.csv
    "$WORK_DIR"/synth_low_slow_clean*.csv
  )
fi

node "$HERE/sweep_cvxeda_driver.js" "${FILES[@]}"
