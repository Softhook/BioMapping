#!/usr/bin/env bash
# Generates the canonical synthetic suite, then sweeps BioMapping's existing
# Full-Scan SNR and quality gates against its known SCR events.
#
# Usage: ./check_gate_sweep.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEUROKIT_PYTHON="${NEUROKIT_PYTHON:-$HOME/neurokit/.venv/bin/python}"

if [ ! -x "$NEUROKIT_PYTHON" ]; then
  echo "NeuroKit2 python not found at $NEUROKIT_PYTHON (set NEUROKIT_PYTHON=/path/to/python)" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t gate_sweep.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

"$NEUROKIT_PYTHON" "$HERE/generate_ground_truth.py" "$WORK_DIR" >&2
node "$HERE/check_gate_sweep.js" "$WORK_DIR"