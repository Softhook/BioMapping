#!/bin/zsh
# Layout numbers (measure_pcb.py) for a committed version next to the
# current working copy, to see whether a layout change helped.
#   usage: compare_measure.sh [git-ref]      (default HEAD)
# The old boards are copied out with `git show` into a temporary folder, so
# your working files are never touched.
set -e
cd "$(dirname "$0")"
P=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
REF=${1:-HEAD}
OLD=$(mktemp -d)
for b in biomap_flipper biomap_cardputer; do
  mkdir -p $OLD/$b
  git show ${REF}:hardware/$b/$b.kicad_pcb > $OLD/$b/$b.kicad_pcb
done
echo "=== $REF"
$P measure_pcb.py $OLD 2>/dev/null
echo "=== working copy"
$P measure_pcb.py 2>/dev/null
rm -rf $OLD
