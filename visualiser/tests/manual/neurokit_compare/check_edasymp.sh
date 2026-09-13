#!/usr/bin/env bash
# EDASymp (0.045-0.25 Hz spectral sympathetic index) comparison: BioMapping's
# SpectralEDA (visualiser/src/signal/spectral_eda.js) against NeuroKit2's
# nk.eda_sympathetic(method='posada2016').
#
# NeuroKit2's posada2016 returns ONE scalar per recording (Welch PSD integral
# over the band, nperseg=128 @ 2 Hz = 64 s). Our standalone metric is the
# sliding-window extension of that same integral; this check compares the
# whole-recording scalar so the two implementations are apples-to-apples.
# Expect per-track ratio ≈ 1.0 (empirically 1.01-1.03 on BioMapping tracks —
# the residual is NeuroKit2's 400 Hz FFT resample + its decimate() filtfilt
# edge handling, both irrelevant inside the 0.045-0.25 Hz band) and
# cross-track r ≈ 1.0.
#
# Requires a Python env with neurokit2 + pandas (default: ~/neurokit/.venv,
# override with NEUROKIT_PYTHON=/path/to/python).
#
# Usage:
#   ./check_edasymp.sh                      # default track set
#   ./check_edasymp.sh biomap_019 biomap_105 # explicit tracks
#   ./check_edasymp.sh all                   # full default set
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
  TRACK_NAMES=(biomap_019 biomap_024 biomap_027 biomap_028 biomap_053 biomap_059 biomap_live_2026-09-10T17-20-02-105Z)
elif [ "${1:-}" = "all" ]; then
  TRACK_NAMES=(biomap_019 biomap_024 biomap_027 biomap_028 biomap_053 biomap_059 biomap_live_2026-09-10T17-20-02-105Z)
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

TMP_JSON="$(mktemp -t edasymp_agreement.XXXXXX.json)"
"$NEUROKIT_PYTHON" "$HERE/check_edasymp.py" "${FILES[@]}" > "$TMP_JSON"
node "$HERE/check_edasymp.js" "$TMP_JSON" "$TRACKS_DIR"
rm -f "$TMP_JSON"
