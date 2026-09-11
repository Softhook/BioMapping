#!/usr/bin/env bash
# Third-smallest NeuroKit2 alignment check: tonic/phasic decomposition, the
# stage after cleaning (check_cleaning_agreement.sh) and before peak
# detection (compare.js / run.sh). See check_decomposition_agreement.py for
# the two decomposition families compared and why only the cvxEDA pairing
# is expected to closely agree.
#
# Requires a Python env with neurokit2 + pandas + cvxopt (default:
# ~/neurokit/.venv, override with NEUROKIT_PYTHON=/path/to/python).
#
# Set CVXEDA_ALPHA=8e-4 to run the cvxEDA-family comparison with our alpha
# matched to NeuroKit2/the paper's default, instead of BioMapping's tuned
# production value (2e-3) - an implementation-fidelity check ("do the two
# solvers converge to the same point") separate from "does production config
# match the reference". See check_decomposition_agreement.js for why.
#
# Usage:
#   ./check_decomposition_agreement.sh                      # default tracks
#   ./check_decomposition_agreement.sh biomap_019 biomap_105 # explicit tracks
#   CVXEDA_ALPHA=8e-4 ./check_decomposition_agreement.sh     # fidelity mode
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

for name in "${TRACK_NAMES[@]}"; do
  f="$TRACKS_DIR/$name.csv"
  if [ ! -f "$f" ]; then
    echo "Track not found: $f" >&2
    exit 1
  fi
  TMP_JSON="$(mktemp -t decomposition_agreement.XXXXXX.json)"
  "$NEUROKIT_PYTHON" "$HERE/check_decomposition_agreement.py" "$f" > "$TMP_JSON"
  node "$HERE/check_decomposition_agreement.js" "$TMP_JSON" "$f"
  rm -f "$TMP_JSON"
done
