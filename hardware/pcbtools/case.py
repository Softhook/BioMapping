"""The printed back case for the Cardputer board (hardware/case/): ./pcb case.

1. Writes hardware/case/board.scad: what the case needs to know about the
   saved Cardputer board (its edge, holes, cuff socket, and every part as a
   box of its outline and height).
2. Builds the STL files with OpenSCAD from hardware/case/cardputer_back.scad.
3. Checks the fit in 3D: the board in its place and on its way in from the
   rim, every part, the cable plug, the cuff plug and the board's screw heads
   must not touch the case anywhere. OpenSCAD works out the overlap; it must
   come out empty.
4. Checks the GPS's distance to the metal in each screw hole (u-blox: 10 mm
   from metal): the long screws' heads, and the heat-set inserts in the
   board's two posts. Both sit at the same height as the GPS module.

Needs KiCad's Python (pcbnew) and OpenSCAD (a 2025 or later build: set
OPENSCAD to its program if it is somewhere unusual)."""
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

import pcbnew

from .kicad import HARDWARE, board_file

CASE = os.path.join(HARDWARE, "case")
SCAD = os.path.join(CASE, "cardputer_back.scad")
BOARD_SCAD = os.path.join(CASE, "board.scad")
STLS = {"cardputer_back.stl": "back", "cardputer_back_rim_test.stl": "rim_test"}
PICTURE = os.path.join(CASE, "cardputer_back.png")

# Tallest point of each part above the board, mm: makers' maxima where known.
# 2.0 covers every small resistor, capacitor and chip on the board.
HEIGHT = {"U4": 6.8,     # SAM-M10Q: 6.3 typical, 6.8 at most (u-blox datasheet)
          "J2": 6.0,     # JST PH side-entry socket: not in KiCad's 3D library, so generous
          "J1": 4.25,    # JST GH side-entry socket (KiCad's 3D model)
          "BT1": 2.2}    # Seiko MS421R with its tabs
SMALL = 2.0
PAD = 0.1                # bare test pads
MODULE = 15.5            # SAM-M10Q body, square
# The widest metal at the GPS's height in each hole, as a radius: an M2 screw
# head (4 mm) for the long screws, an M2 heat-set insert (3.6 mm) in the
# board's posts
METAL_R = {"H1": 1.8, "H2": 1.8, "H3": 2.0, "H4": 2.0}
GPS_METAL_MM = 10.0      # u-blox: keep metal 10 mm from the module


def openscad():
    for p in (os.environ.get("OPENSCAD"), shutil.which("openscad"),
              "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"):
        if p and os.path.exists(p):
            return p
    sys.exit("OpenSCAD not found: install it (brew install --cask openscad@snapshot) or set OPENSCAD")


def mm(v):
    return round(pcbnew.ToMM(v), 3)


def board_numbers(pcb):
    """The board's edge, holes, cuff socket and part boxes, from the saved board."""
    b = pcbnew.LoadBoard(pcb)
    poly = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(poly, True)
    ring = poly.Outline(0)
    edge = [(mm(ring.CPoint(i).x), mm(ring.CPoint(i).y)) for i in range(ring.PointCount())]
    fps = {fp.GetReference(): fp for fp in b.GetFootprints()}
    holes, parts = {}, {"B": [], "F": []}
    for ref, fp in sorted(fps.items()):
        pos = fp.GetPosition()
        if ref.startswith("H"):
            holes[ref] = (mm(pos.x), mm(pos.y), mm(fp.Pads()[0].GetDrillSize().x))
            continue
        side = "B" if fp.IsFlipped() else "F"
        bb = fp.GetCourtyard(pcbnew.B_CrtYd if side == "B" else pcbnew.F_CrtYd).BBox()
        h = HEIGHT.get(ref, PAD if ref.startswith("TP") else SMALL)
        parts[side].append((mm(bb.GetLeft()), mm(bb.GetTop()), mm(bb.GetRight()), mm(bb.GetBottom()), h, ref))
    j2 = next(p for p in parts["B"] if p[5] == "J2")
    j1 = next(p for p in parts["F"] if p[5] == "J1")
    u4 = fps["U4"].GetPosition()
    return dict(edge=edge, holes=holes, parts=parts, thickness=mm(b.GetDesignSettings().GetBoardThickness()),
                cuff=(j2[2], round((j2[1] + j2[3]) / 2, 3), round(j2[3] - j2[1], 3)),   # mouth (+x), centre, width
                cable=(round((j1[0] + j1[2]) / 2, 3), j1[3]),          # mouth faces +y
                gps=(mm(u4.x), mm(u4.y)))


def write_board_scad(n, path=BOARD_SCAD):
    v = lambda p: "[" + ", ".join(f"{x:g}" if isinstance(x, (int, float)) else f'"{x}"' for x in p) + "]"
    rows = lambda ps: "[\n    " + ",\n    ".join(v(p) for p in ps) + "]"
    h = n["holes"]
    text = f"""// Written by ./pcb case from hardware/biomap_cardputer/biomap_cardputer.kicad_pcb.
// Don't edit: change the board, then run ./pcb case again.
// KiCad coordinates (mm): x along the Cardputer, y from the EXT edge, seen from
// the Cardputer's side.

board_t = {n["thickness"]:g};
board_outline = {rows(n["edge"])};
long_posts = [{v(h["H3"][:2])}, {v(h["H4"][:2])}];     // H3, H4: the case's long screw posts pass through
post_holes = {h["H3"][2]:g};                          // the board's holes for them
board_screws = [{v(h["H1"][:2])}, {v(h["H2"][:2])}];   // H1, H2: M2 screws into the case
board_screw_holes = {h["H1"][2]:g};
cuff_socket = {v(n["cuff"])};       // J2's mouth (faces +x), its centre line and its width
cable_socket = {v(n["cable"])};     // J1's mouth (faces +y, on the inner face) and its centre line
gps = {v(n["gps"])};
// [x0, y0, x1, y1, height, ref]: each part's outline (courtyard) and height
parts_B = {rows(n["parts"]["B"])};
parts_F = {rows(n["parts"]["F"])};
"""
    with open(path, "w") as f:
        f.write(text)


def run_scad(part, out, extra=()):
    """One OpenSCAD run; returns (ok, OpenSCAD's messages)."""
    fmt = ["--export-format=binstl"] if out.endswith(".stl") else []
    cmd = [openscad(), "--backend=manifold", *fmt, "-D", f'part="{part}"', "-o", out, *extra, SCAD]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode == 0 and os.path.exists(out), r.stderr


def echoes(text):
    return [m.group(1) for m in re.finditer(r'ECHO: "(.*)"', text)]


def gps_distances(n):
    """Nearest distance from the GPS module's body to the metal in each hole."""
    gx, gy = n["gps"]
    out = {}
    for ref, (x, y, _) in n["holes"].items():
        dx, dy = max(abs(x - gx) - MODULE / 2, 0), max(abs(y - gy) - MODULE / 2, 0)
        out[ref] = round(math.hypot(dx, dy) - METAL_R[ref], 1)
    return out


def make(picture=True):
    pcb = board_file("biomap_cardputer", ".kicad_pcb")
    n = board_numbers(pcb)
    write_board_scad(n)
    print(f"wrote {os.path.relpath(BOARD_SCAD)}: board edge {len(n['edge'])} points, "
          f"{len(n['parts']['B'])} parts on the outer face, {len(n['parts']['F'])} on the inner")
    problems = 0
    for name, part in STLS.items():
        ok, msg = run_scad(part, os.path.join(CASE, name))
        if not ok:
            print(msg)
            sys.exit(f"OpenSCAD could not build {name}")
        for e in echoes(msg):
            print("  " + e)
        print(f"built {os.path.relpath(os.path.join(CASE, name))}")
    with tempfile.TemporaryDirectory() as tmp:
        hit = os.path.join(tmp, "overlap.stl")
        ok, msg = run_scad("fit_check", hit)
        if "top level object is empty" in msg.lower():     # OpenSCAD's own words for "no overlap"
            print("  fit: board, parts, plugs and screw heads clear of the case, "
                  "and the board clears it on its way in")
        elif ok:
            problems += 1
            saved = os.path.join(HARDWARE, "out", "cardputer_back_overlap.stl")
            os.makedirs(os.path.dirname(saved), exist_ok=True)
            shutil.copy(hit, saved)
            print(f"  FIT: the board or a part touches the case: the overlap is in {os.path.relpath(saved)}")
        else:
            problems += 1
            print(f"  FIT: OpenSCAD could not run the fit check:\n{msg}")
    for ref, d in sorted(gps_distances(n).items()):
        metal = "insert" if ref in ("H1", "H2") else "long screw's head"
        flag = "" if d >= GPS_METAL_MM else f"  <- under {GPS_METAL_MM:g} mm"
        problems += d < GPS_METAL_MM
        print(f"  GPS to the {metal} in {ref}: {d} mm{flag}")
    if picture:
        os.makedirs(os.path.dirname(PICTURE), exist_ok=True)
        ok, msg = run_scad("back", PICTURE, ["--render", "--imgsize=1400,1000", "--viewall", "--autocenter",
                                             "--camera=0,0,0,40,0,200,0", "--colorscheme=Tomorrow"])
        print(f"  picture: {os.path.relpath(PICTURE)}" if ok else "  (no picture: " + msg.strip()[-200:] + ")")
    return problems
