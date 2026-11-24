"""Everything a factory needs to make (and, for the main boards, assemble) a
board, written to out/fab/<board>/:

  <board>_gerbers.zip     the drawings of each layer (Gerber files) and the
                          drill files: upload this to make the bare board
  <board>_bom_jlcpcb.csv  the parts list, in JLCPCB's format
  <board>_cpl_jlcpcb.csv  where the machine puts each part, in JLCPCB's format
  ORDER.txt               the choices to make on the order form, and what to
                          check in the factory's preview
  gerbers/                the zip's contents, to open in KiCad's GerbView

The flex tail has no parts list or placement file: it is a bare flex board,
and its header is soldered by hand.

The board is checked first (the same checks as ./pcb check), and nothing is
written if any fails: files from a board with a fault are worse than none."""
import csv
import os
import shutil
import tempfile
import zipfile

from . import pipeline
from .kicad import HARDWARE, OUT, board_file, cli

FAB_OUT = os.path.join(OUT, "fab")

RIGID = ["F.Cu", "B.Cu", "F.Paste", "B.Paste", "F.Silkscreen", "B.Silkscreen", "F.Mask", "B.Mask", "Edge.Cuts"]
# The tail: no paste (nothing is machine-soldered). The mask layers become the
# coverlay openings, and the drawings layer carries the stiffener's outline.
FLEX = ["F.Cu", "B.Cu", "F.Silkscreen", "B.Silkscreen", "F.Mask", "B.Mask", "Edge.Cuts", "User.Drawings"]

# JLCPCB's machines take some footprints at a different zero angle from
# KiCad's. Their placement preview shows any part that comes out turned: put
# its footprint name here with the degrees to add, and every later order is
# right. Empty until a preview shows one.
ROTATION_FIX = {}

OVEN = [
    "Oven limits (send these with the GPS modules):",
    "  - GPS (U4): one pass only, module facing up, at most 245 C, 40-60 s above 217 C",
    "    (u-blox integration manual, section 5.3).",
    "  - GPS: keep it in its sealed bag until it is fitted (moisture level 4). After about",
    "    72 hours out of the bag it must be baked dry first.",
    "  - Backup cell (BT1): two oven passes at most.",
    "  - Don't wash the board afterwards (water, alcohol or ultrasonic): it can damage the GPS.",
]
CONSIGNED = [
    "Not stocked by LCSC: U4 (u-blox SAM-M10Q-00B) and BT1 (Seiko MS421R-IV03E, Farnell 3534555).",
    "Send them to JLCPCB yourself, or order them through JLCPCB's global sourcing.",
]

BOARDS = {
    "biomap_cardputer": dict(layers=RIGID, assembled=True, notes=[
        "Surface finish: ENIG suggested. Its pads are flat, which suits the GPS's pads underneath",
        "it and the ADC's 0.5 mm pins.",
        "Copper: 1 oz (35 um), as ./pcb ground assumes.",
        "Assembly: every machine-fitted part is on the BOTTOM face. Choose 'Bottom' as the",
        "assembly side.",
        "J1, the cable socket (JST SM08B-GHS-TB), is on the TOP face and is left out of the parts",
        "list: solder it by hand (hardware/case/README.md). The test pads have no part.",
        *CONSIGNED, *OVEN]),
    "biomap_flipper": dict(layers=RIGID, assembled=True, notes=[
        "Surface finish: ENIG suggested (flat pads for the GPS and the ADC's 0.5 mm pins).",
        "Assembly: top face. J1 and J4 are through-hole headers: the factory fits them for an",
        "extra fee, or leave them out of the parts list and solder them yourself.",
        *CONSIGNED, *OVEN]),
    "biomap_cardputer_tail": dict(layers=FLEX, assembled=False, notes=[
        "Order as a FLEX board: 2 layers, polyimide, with coverlay on both sides.",
        "Stiffener: FR4, 1.0 mm, on the F (top) side over the plug end, drilled for the header.",
        "Its outline is the 'STIFFENER' rectangle in the drawings-layer file",
        "(*-User_Drawings.gbr in the zip): tell the factory that file is the stiffener drawing.",
        "Surface finish: ENIG.",
        "No assembly: the 2 x 7 header is soldered by hand (hardware/README.md, 'Soldering it on').",
        "Not used by the Cardputer board since rev G (a cable inside the printed case instead).",
    ]),
}


def gerbers(name, pcb, folder, layers):
    cli("pcb", "export", "gerbers", "-o", folder + os.sep, "--layers", ",".join(layers),
        "--subtract-soldermask", "--no-x2", "--no-netlist", "--check-zones", pcb, check=True)
    cli("pcb", "export", "drill", "-o", folder + os.sep, "--format", "excellon",
        "--excellon-units", "mm", "--excellon-zeros-format", "decimal",
        "--excellon-oval-format", "alternate", "--excellon-separate-th",
        "--drill-origin", "absolute", pcb, check=True)
    files = sorted(os.listdir(folder))
    missing = [ly for ly in layers if not any(ly.replace(".", "_") in f for f in files)]
    if missing or not any(f.endswith(".drl") for f in files):
        raise SystemExit(f"{name}: KiCad didn't write every file (missing: {missing or 'drill'})")
    return files


def bom_rows(name):
    """The board's parts list (bom.csv, written by ./pcb build), minus the bare
    pads, which have no part to fit, and the parts soldered by hand."""
    with open(os.path.join(HARDWARE, name, "bom.csv"), newline="") as f:
        return [r for r in csv.DictReader(f) if r["Fit"] not in ("bare pad", "by hand")]


def write_bom(rows, path):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Comment", "Designator", "Footprint", "LCSC Part #"])
        for r in rows:
            comment = r["Value"] if r["MPN"] in ("", r["Value"]) else f"{r['Value']} ({r['MPN']})"
            w.writerow([comment, ",".join(r["Designator"].split()), r["Footprint"], r["LCSC"]])


def write_cpl(pcb, refs, path):
    """KiCad's placement file, cut to the fitted parts and renamed to
    JLCPCB's columns. Rotation 0-360, plus any ROTATION_FIX."""
    with tempfile.TemporaryDirectory() as tmp:
        pos = os.path.join(tmp, "pos.csv")
        cli("pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both",
            "-o", pos, pcb, check=True)
        with open(pos, newline="") as f:
            placed = {r["Ref"]: r for r in csv.DictReader(f)}
    unplaced = sorted(set(refs) - set(placed))
    if unplaced:
        raise SystemExit(f"in the parts list but not on the board: {' '.join(unplaced)}")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for ref in sorted(refs, key=lambda r: (r.rstrip("0123456789"), int("0" + r[len(r.rstrip("0123456789")):]))):
            r = placed[ref]
            rot = (float(r["Rot"]) + ROTATION_FIX.get(r["Package"], 0)) % 360
            w.writerow([ref, f"{float(r['PosX']):.4f}mm", f"{float(r['PosY']):.4f}mm",
                        "Top" if r["Side"] == "top" else "Bottom", f"{rot:g}"])


def board_facts(pcb):
    import pcbnew
    b = pcbnew.LoadBoard(pcb)
    box = b.GetBoardEdgesBoundingBox()
    return (pcbnew.ToMM(box.GetWidth()), pcbnew.ToMM(box.GetHeight()),
            pcbnew.ToMM(b.GetDesignSettings().GetBoardThickness()), b.GetCopperLayerCount())


def write_order(name, pcb, folder, spec, rows):
    w, h, thick, layers = board_facts(pcb)
    rigid = "" if spec["layers"] is FLEX else f", {thick:g} mm FR4"
    lines = [f"{name}: order notes (written by ./pcb fab)", "",
             f"Upload: {name}_gerbers.zip",
             f"Board: {layers} copper layers, {w:.1f} x {h:.1f} mm{rigid}", ""]
    lines += spec["notes"]
    if spec["assembled"]:
        polar = [ref for r in rows for ref in r["Designator"].split()
                 if ref.rstrip("0123456789") in ("U", "D", "BT", "J", "Q")]
        lines += ["", f"Parts list: {name}_bom_jlcpcb.csv   Placement: {name}_cpl_jlcpcb.csv",
                  "In the placement preview, check that every part sits on its pads, and the pin 1",
                  f"dot, stripe or + side of: {' '.join(polar)}.",
                  "A part that comes out turned: fix it there, and add its footprint to",
                  "ROTATION_FIX in hardware/pcbtools/fab.py so the next order is right."]
    with open(os.path.join(folder, "ORDER.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")


def make(names):
    problems = pipeline.check(names)
    if problems:
        print(f"\nnot writing factory files: fix the {problems} problem(s) first")
        return problems
    for name in names:
        spec = BOARDS[name]
        pcb = board_file(name, ".kicad_pcb")
        folder = os.path.join(FAB_OUT, name)
        shutil.rmtree(folder, ignore_errors=True)
        gfolder = os.path.join(folder, "gerbers")
        os.makedirs(gfolder)
        files = gerbers(name, pcb, gfolder, spec["layers"])
        with zipfile.ZipFile(os.path.join(folder, f"{name}_gerbers.zip"), "w", zipfile.ZIP_DEFLATED) as z:
            for f in files:
                z.write(os.path.join(gfolder, f), f)
        rows = []
        if spec["assembled"]:
            rows = bom_rows(name)
            write_bom(rows, os.path.join(folder, f"{name}_bom_jlcpcb.csv"))
            write_cpl(pcb, [ref for r in rows for ref in r["Designator"].split()],
                      os.path.join(folder, f"{name}_cpl_jlcpcb.csv"))
        write_order(name, pcb, folder, spec, rows)
        print(f"== {name}: {len(files)} files in the zip"
              + (f", {sum(len(r['Designator'].split()) for r in rows)} parts to place" if rows else "")
              + f"\n   {os.path.relpath(folder)}/  (read ORDER.txt before ordering)")
    return 0
