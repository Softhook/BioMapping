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
#   BIOMAP_SMALL_SLOW_AMPLITUDE=0.1 BIOMAP_SMALL_SLOW_SLOPE=0.06 ./run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKS_DIR="$(cd "$HERE/../../../../tracks" && pwd)"
NEUROKIT_PYTHON="${NEUROKIT_PYTHON:-$HOME/neurokit/.venv/bin/python}"

if [ ! -x "$NEUROKIT_PYTHON" ]; then
  echo "NeuroKit2 python not found at $NEUROKIT_PYTHON (set NEUROKIT_PYTHON=/path/to/python)" >&2
  exit 1
fi

TRACK_ARGS=("$@")
if [ ${#TRACK_ARGS[@]} -eq 0 ]; then
  TRACK_ARGS=(biomap_live_2026-09-10T17-20-02-105Z biomap_028)
fi

RAW_FILES=()
for arg in "${TRACK_ARGS[@]}"; do
  if [ "$arg" = "all" ] || [ "$arg" = "corpus" ] || [ "$arg" = "full" ]; then
    for f in "$TRACKS_DIR"/biomap_*.csv; do
      [ -s "$f" ] || continue
      [[ "$f" == *"_processed"* ]] && continue
      RAW_FILES+=("$f")
    done
  elif [ "$arg" = "ref" ] || [ "$arg" = "reference" ] || [ "$arg" = "6" ]; then
    for stem in biomap_live_2026-09-10T17-20-02-105Z biomap_028 biomap_019 biomap_027 biomap_053 biomap_059; do
      f="$TRACKS_DIR/$stem.csv"
      [ -f "$f" ] && RAW_FILES+=("$f")
    done
  elif [ -f "$arg" ]; then
    RAW_FILES+=("$arg")
  elif [ -f "$TRACKS_DIR/$arg" ]; then
    RAW_FILES+=("$TRACKS_DIR/$arg")
  elif [ -f "$TRACKS_DIR/$arg.csv" ]; then
    RAW_FILES+=("$TRACKS_DIR/$arg.csv")
  else
    echo "Track not found: $arg" >&2
    exit 1
  fi
done

# Deduplicate files while preserving order
FILES=()
for f in "${RAW_FILES[@]}"; do
  seen=0
  if [ ${#FILES[@]} -gt 0 ]; then
    for u in "${FILES[@]}"; do
      if [ "$u" = "$f" ]; then seen=1; break; fi
    done
  fi
  [ "$seen" -eq 0 ] && FILES+=("$f")
done

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No tracks to process." >&2
  exit 1
fi
echo "Running comparison benchmark over ${#FILES[@]} track(s)..." >&2

WORK_DIR="$(mktemp -d -t real_compare.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

REFERENCE_JSONS=()

if [ "${SKIP_NEUROKIT:-0}" != "1" ]; then
  echo "Running NeuroKit2 over ${#FILES[@]} track(s)..." >&2
  NK_JSON="$WORK_DIR/neurokit.json"
  if "$NEUROKIT_PYTHON" "$HERE/run_neurokit.py" "${FILES[@]}" > "$NK_JSON"; then
    REFERENCE_JSONS+=("$NK_JSON")
  fi
fi

LEDALAB_DIR="${LEDALAB_DIR:-$HOME/ledalab}"
LEDALAB_JSON="$WORK_DIR/ledalab.json"
OCTAVE_EXEC="${OCTAVE_BIN:-$(command -v octave-cli || command -v octave || echo octave)}"
if [ "${SKIP_LEDALAB:-0}" != "1" ] && command -v "$OCTAVE_EXEC" >/dev/null 2>&1 && [ -f "$LEDALAB_DIR/Ledalab.m" ]; then
  echo "Running real Ledalab (via Octave) over ${#FILES[@]} track(s)..." >&2
  if OCTAVE_BIN="$OCTAVE_EXEC" "$NEUROKIT_PYTHON" "$HERE/run_ledalab.py" "${FILES[@]}" > "$LEDALAB_JSON"; then
    REFERENCE_JSONS+=("$LEDALAB_JSON")
  else
    echo "run_ledalab.py failed - continuing without its rows" >&2
  fi
fi

CVXREF_JSON="$WORK_DIR/cvxeda_reference.json"
if [ "${SKIP_CVXEDA:-0}" != "1" ] && "$NEUROKIT_PYTHON" -c "import cvxopt" >/dev/null 2>&1; then
  echo "Running real lciti/cvxEDA.py reference solver over ${#FILES[@]} track(s)..." >&2
  if "$NEUROKIT_PYTHON" "$HERE/run_cvxeda_reference.py" "${FILES[@]}" > "$CVXREF_JSON"; then
    REFERENCE_JSONS+=("$CVXREF_JSON")
  else
    echo "run_cvxeda_reference.py failed - continuing without its rows" >&2
  fi
fi

if [ ${#REFERENCE_JSONS[@]} -eq 0 ]; then
  echo "No reference toolboxes produced output." >&2
  exit 1
fi

MERGED_JSON="$WORK_DIR/merged_reference.json"
node "$HERE/merge_reference_json.js" "$MERGED_JSON" "${REFERENCE_JSONS[@]}"

node "$HERE/compare.js" "$MERGED_JSON" "${FILES[@]}"
