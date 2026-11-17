#!/bin/zsh
# Run KiCad's design rules check on a saved board and print every problem
# with the parts, pads and positions involved (build_one.sh only counts them).
#   usage: drc_details.sh biomap_flipper|biomap_cardputer
set -e
cd "$(dirname "$0")"
K=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
b=$1
RPT=$(mktemp)
$K pcb drc --schematic-parity -o $RPT ../$b/$b.kicad_pcb 2>/dev/null | grep -i found
grep -A3 "^\[" $RPT | grep -v -e "^--" -e "Rule:" -e "Local override" || echo "no problems"
rm -f $RPT
