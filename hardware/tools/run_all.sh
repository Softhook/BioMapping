#!/bin/zsh
# Regenerate both boards from scratch:
#   schematic -> netlist check -> ERC -> placed + routed PCB -> DRC.
# Overwrites the KiCad files in ../biomap_flipper and ../biomap_cardputer.
set -e
cd "$(dirname "$0")"
P=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
K=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
OUT=$(mktemp -d)
python3 gen_kicad.py .. $OUT/expected.json
python3 check_sch.py .. $OUT/expected.json | grep -v "^  "     # check without KiCad
for b in biomap_flipper biomap_cardputer; do
  echo "== $b"
  $K sch export netlist --format kicadsexpr -o ../$b/$b.net ../$b/$b.kicad_sch >/dev/null 2>&1
  python3 check_netlist.py $OUT/expected.json $b ../$b/$b.net
  $K sch erc -o $OUT/$b.erc.rpt ../$b/$b.kicad_sch 2>/dev/null | grep -i violation || true
  grep "ERC messages" $OUT/$b.erc.rpt
  $P build_pcb.py $b ../$b 2>/dev/null | grep -v "^ "
  $K pcb drc --schematic-parity -o $OUT/$b.drc.rpt ../$b/$b.kicad_pcb 2>&1 | grep -i "found"
  rm -f ../$b/$b.net
done
rm -rf $OUT
