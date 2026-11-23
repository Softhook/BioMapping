"""Draw pictures of the schematics and boards, to check a layout by eye.

Per board: <board>_sch.png (the whole A3 sheet), <board>_F.png and
<board>_B.png (copper and printed labels; the back face is drawn mirrored,
as seen from behind). Needs ImageMagick (magick) and macOS Quick Look.
Quick Look crops wide A3 sheets, so schematics go through PDF instead."""
import os
import subprocess

from .kicad import BOARDS, OUT, board_file, cli


def render(out=OUT, names=BOARDS):
    os.makedirs(out, exist_ok=True)
    for b in names:
        pdf = os.path.join(out, f"{b}_sch.pdf")
        cli("sch", "export", "pdf", "-o", pdf, board_file(b, ".kicad_sch"), check=True)
        subprocess.run(["magick", "-density", "150", pdf, "-background", "white", "-flatten",
                        os.path.join(out, f"{b}_sch.png")], check=True)
        os.remove(pdf)
        for side, layers in (("F", "F.Cu,F.SilkS,Edge.Cuts"), ("B", "B.Cu,B.SilkS,Edge.Cuts")):
            svg = os.path.join(out, f"{b}_{side}.svg")
            cli("pcb", "export", "svg", "--mode-single", *(["--mirror"] if side == "B" else []),
                "--layers", layers, "--fit-page-to-board", "-o", svg, board_file(b, ".kicad_pcb"), check=True)
            subprocess.run(["qlmanage", "-t", "-s", "2000", "-o", out, svg], check=True, capture_output=True)
            os.replace(svg + ".png", os.path.join(out, f"{b}_{side}.png"))
            os.remove(svg)
    print(f"pictures in {out}")
