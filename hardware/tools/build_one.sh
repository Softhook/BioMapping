#!/bin/zsh
# Quick loop while editing one board's layout in build_pcb.py:
# rebuild that board from its current schematic, then run DRC and list the
# problems by kind.     usage: build_one.sh biomap_flipper|biomap_cardputer
# (Run run_all.sh first if the schematic itself changed.)
set -e
cd "$(dirname "$0")"
b=$1
P=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
K=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
RPT=$(mktemp)
$K sch export netlist --format kicadsexpr -o ../$b/$b.net ../$b/$b.kicad_sch >/dev/null 2>&1
$P build_pcb.py $b ../$b "${@:2}" 2>/dev/null | grep -v -E "^$"
rm -f ../$b/$b.net
$K pcb drc --schematic-parity -o $RPT ../$b/$b.kicad_pcb 2>&1 | grep -i found
grep -E "^\[" $RPT | sort | uniq -c | sort -rn
echo "full report: $RPT"
