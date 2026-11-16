#!/bin/zsh
# Regenerate both boards from scratch: schematic -> netlist -> placed PCB -> routed PCB -> DRC
set -e
cd "$(dirname "$0")"
P=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
JAVA=/opt/homebrew/opt/openjdk/bin/java
K=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
python3 gen_kicad.py .. expected.json && python3 check_sch.py .. expected.json | grep -v "^  "
for b in biomap_flipper biomap_cardputer; do
  $K sch erc -o $b.erc.rpt ../$b/$b.kicad_sch 2>/dev/null | grep -i violation
  $K sch export netlist --format kicadsexpr -o ../$b/$b.net ../$b/$b.kicad_sch >/dev/null 2>&1
  $P build_pcb.py $b ../$b 2>/dev/null | grep -v "^  "
  $P route_pcb.py export ../$b/$b.kicad_pcb $b.dsn 2>/dev/null
  $JAVA -jar freerouting.jar -de $b.dsn -do $b.ses -mp 40 --gui.enabled=false > $b.fr.log 2>&1
  $P route_pcb.py finish ../$b/$b.kicad_pcb $b.ses 2>/dev/null
  echo "== $b DRC"; $K pcb drc --schematic-parity -o $b.drc.rpt ../$b/$b.kicad_pcb 2>&1 | grep -i "found"
done
