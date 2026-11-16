#!/bin/zsh
# Draw pictures of the schematics and boards, to check a layout by eye.
#   usage: render.sh [output-dir]      (default: tools/out, which git ignores)
# Makes, per board: <board>_sch.png (whole A3 sheet), <board>_F.png and
# <board>_B.png (copper + printed labels, back face drawn mirrored as seen
# from behind). Needs KiCad 10, ImageMagick (magick) and macOS Quick Look.
# Note: Quick Look crops wide A3 sheets, so schematics go through PDF instead.
set -e
cd "$(dirname "$0")"
K=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
OUT=${1:-out}
mkdir -p $OUT
for b in biomap_flipper biomap_cardputer; do
  $K sch export pdf -o $OUT/${b}_sch.pdf ../$b/$b.kicad_sch >/dev/null 2>&1
  magick -density 150 $OUT/${b}_sch.pdf -background white -flatten $OUT/${b}_sch.png
  for side in F B; do
    if [ $side = F ]; then L="F.Cu,F.SilkS,Edge.Cuts"; M=""; else L="B.Cu,B.SilkS,Edge.Cuts"; M="--mirror"; fi
    $K pcb export svg --mode-single $M --layers $L --fit-page-to-board -o $OUT/${b}_$side.svg ../$b/$b.kicad_pcb >/dev/null 2>&1
    qlmanage -t -s 2000 -o $OUT $OUT/${b}_$side.svg >/dev/null 2>&1
    mv $OUT/${b}_$side.svg.png $OUT/${b}_$side.png
  done
  rm -f $OUT/${b}_sch.pdf $OUT/${b}_F.svg $OUT/${b}_B.svg
done
echo "pictures in $(cd $OUT && pwd)"
