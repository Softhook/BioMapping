#!/usr/bin/env bash
# Ground-truth detector race: generates synthetic tracks with a KNOWN true
# SCR count/timing (NeuroKit2's own canonical response function, placed
# under our control - see generate_ground_truth.py), then scores our three
# detectors AND three independent reference toolboxes' own detectors against
# that known answer: NeuroKit2 (run_neurokit.py), the REAL MATLAB-source
# Ledalab run via Octave (run_ledalab.py - see eda_detection_benchmark.md
# item 23; no MATLAB license needed), and the real upstream lciti/cvxEDA.py
# solver (run_cvxeda_reference.py, two peak-pickers). The one check in this
# investigation that asks "who's actually right", not "who agrees with
# whom".
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python). Octave+Ledalab and cvxopt
# are optional - if either is missing, that reference's rows are skipped
# with a warning rather than aborting the run (see run_ledalab.py's
# docstring for the Octave/Ledalab setup; cvxopt is also needed for
# NeuroKit2's own cvxeda_peak_times).
#
# Usage:
#   ./check_ground_truth.sh
#   CLEAN_ONLY=1 BIOMAP_USE_GAIT_FILTER=0 ./check_ground_truth.sh
#   GROUND_TRUTH_NUM_SEEDS=3 ./check_ground_truth.sh
#   CLEAN_ONLY=1 BIOMAP_USE_GAIT_FILTER=0 BIOMAP_PEAK_MIN_GAP=2 ./check_ground_truth.sh
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
if [ "${CLEAN_ONLY:-0}" = "1" ] || [ "${TIER:-}" = "canonical" ] || [ "${TIER:-}" = "clean" ]; then
  FILES=(
    "$WORK_DIR"/synth_sparse_clean*.csv
    "$WORK_DIR"/synth_dense_clean*.csv
    "$WORK_DIR"/synth_compound_clean*.csv
    "$WORK_DIR"/synth_low_slow_clean*.csv
  )
elif [ "${TIER:-}" = "poisson" ]; then
  FILES=(
    "$WORK_DIR"/synth_poisson_clean*.csv
    "$WORK_DIR"/synth_poisson_noisy*.csv
  )
elif [ "${TIER:-}" = "burst" ] || [ "${TIER:-}" = "complex" ]; then
  FILES=(
    "$WORK_DIR"/synth_burst_clusters_clean*.csv
    "$WORK_DIR"/synth_burst_clusters_noisy*.csv
  )
elif [ "${TIER:-}" = "gait" ] || [ "${TIER:-}" = "walking" ] || [ "${TIER:-}" = "tier4" ] || [ "${TIER:-}" = "4" ]; then
  FILES=(
    "$WORK_DIR"/synth_gait_tremor*.csv
    "$WORK_DIR"/synth_walking_track*.csv
  )
  export BIOMAP_USE_GAIT_FILTER="${BIOMAP_USE_GAIT_FILTER:-1}"
elif [ "${TIER:-}" = "semi" ] || [ "${TIER:-}" = "demo" ] || [ "${TIER:-}" = "5" ] || [ "${TIER:-}" = "tier5" ]; then
  echo "Generating semi-synthetic ground truth from demo donor track..." >&2
  "$NEUROKIT_PYTHON" "$HERE/generate_semi_synthetic.py" "$WORK_DIR"
  FILES=(
    "$WORK_DIR"/synth_semi_real_demo*.csv
  )
  export BIOMAP_USE_GAIT_FILTER="${BIOMAP_USE_GAIT_FILTER:-1}"
elif [ "${TIER:-}" = "walking_clean" ] || [ "${TIER:-}" = "walking_no_footsteps" ] || [ "${TIER:-}" = "walk_clean" ]; then
  FILES=(
    "$WORK_DIR"/synth_walking_no_footsteps*.csv
  )
  export BIOMAP_USE_GAIT_FILTER="${BIOMAP_USE_GAIT_FILTER:-0}"
fi

echo "Running NeuroKit2 over ${#FILES[@]} synthetic track(s)..." >&2
NK_JSON="$WORK_DIR/neurokit.json"
"$NEUROKIT_PYTHON" "$HERE/run_neurokit.py" "${FILES[@]}" > "$NK_JSON"

REFERENCE_JSONS=("$NK_JSON")

LEDALAB_DIR="${LEDALAB_DIR:-$HOME/ledalab}"
LEDALAB_JSON="$WORK_DIR/ledalab.json"
if command -v "${OCTAVE_BIN:-octave}" >/dev/null 2>&1 && [ -f "$LEDALAB_DIR/Ledalab.m" ]; then
  echo "Running real Ledalab (via Octave) over ${#FILES[@]} synthetic track(s)..." >&2
  if "$NEUROKIT_PYTHON" "$HERE/run_ledalab.py" "${FILES[@]}" > "$LEDALAB_JSON"; then
    REFERENCE_JSONS+=("$LEDALAB_JSON")
  else
    echo "run_ledalab.py failed - continuing without its rows" >&2
  fi
else
  echo "Octave/Ledalab not set up (see run_ledalab.py docstring: brew install octave," \
       "then git clone https://github.com/ledalab/ledalab \$LEDALAB_DIR) - skipping Ledalab rows" >&2
fi

CVXREF_JSON="$WORK_DIR/cvxeda_reference.json"
if "$NEUROKIT_PYTHON" -c "import cvxopt" >/dev/null 2>&1; then
  echo "Running the real lciti/cvxEDA.py reference solver over ${#FILES[@]} synthetic track(s)..." >&2
  if "$NEUROKIT_PYTHON" "$HERE/run_cvxeda_reference.py" "${FILES[@]}" > "$CVXREF_JSON"; then
    REFERENCE_JSONS+=("$CVXREF_JSON")
  else
    echo "run_cvxeda_reference.py failed - continuing without its rows" >&2
  fi
else
  echo "cvxopt not installed ('pip install cvxopt') - skipping cvxEDA reference-solver rows" >&2
fi

MERGED_JSON="$WORK_DIR/merged_reference.json"
node "$HERE/merge_reference_json.js" "$MERGED_JSON" "${REFERENCE_JSONS[@]}"

node "$HERE/check_ground_truth.js" "$WORK_DIR" "$MERGED_JSON" "${FILES[@]}"
