#!/bin/zsh
# Print pad positions, nets and keep-out (courtyard) boxes for just the
# parts you name, as build_pcb.py would place them. Use it before moving a
# part in build_pcb.py, to see where its pads and its neighbours' pads are.
#   usage: dump_parts.sh biomap_flipper|biomap_cardputer [REF ...]
#   e.g.   dump_parts.sh biomap_flipper U1 C1 R5 C2
# With no REFs it prints every part. Does not change the saved board
# (it rebuilds into a temporary folder).
set -e
cd "$(dirname "$0")"
P=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
K=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
b=$1; shift
TMP=$(mktemp -d)
$K sch export netlist --format kicadsexpr -o $TMP/$b.net ../$b/$b.kicad_sch >/dev/null 2>&1
want=" ${*} "
$P build_pcb.py $b $TMP --dump 2>/dev/null | awk -v want="$want" '
  /^[A-Z]+[0-9]+ side/ { show = (want == "  " || index(want, " " $1 " ") > 0) }
  /^saved/ { next }
  show'
rm -rf $TMP
