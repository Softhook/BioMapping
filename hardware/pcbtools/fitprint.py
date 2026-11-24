"""A full-size paper copy of the Cardputer board, to cut out and lay on
the opened Cardputer before ordering: do the two big holes sit over the
Cardputer's screw inserts, and does the cable socket (J1, on the board's
inner face) sit over flat board, clear of the EXT socket, the headphone
socket and the battery plug?

The board is drawn as seen from outside (the parts' face, printing readable),
the way you see it when it lies on the opened Cardputer. Around it is the
Cardputer's own outline, the line to cut along: the board sits 2.1 mm inside
it, in the printed case. J1 and its pads are on the hidden face, so they are
drawn as seen through the paper. One A4 page, with a 100 mm ruler in each
direction to prove the printer didn't scale it.

KiCad itself draws the page, from a copy of the board with the tracks and
copper fill left out (they would only be ink): every pad, hole, part outline
and printed label stays, at exactly 1:1."""
import os
import sys
import tempfile

import pcbnew

from .kicad import OUT, board_file, cli

PDF = os.path.join(OUT, "biomap_cardputer_print.pdf")
LAYERS = "F.Cu,F.SilkS,F.Fab,B.Cu,B.Fab,Edge.Cuts,Dwgs.User,Cmts.User"   # B: the hidden face's J1
NOTES = pcbnew.Cmts_User          # our own words, ruler and screw marks

# Where things go on the page (A4 landscape, 297 x 210 mm, y down), in mm:
# the Cardputer outline's top-left corner and the ruler's corner.
BOARD_AT = (25, 62)
RULER_AT = (180, 190)
# The Cardputer's outline (M5Stack's back at its rim; see hardware/case/), in the
# board's coordinates: 84 x 54 mm, corners 7.7 mm on the EXT edge, 3 mm on the other
DEVICE = (0.0, 0.0, 84.0, 54.0, 7.7, 3.0)

MM = pcbnew.FromMM


def V(x, y):
    return pcbnew.VECTOR2I(MM(x), MM(y))


def xy(v):
    return pcbnew.ToMM(v.x), pcbnew.ToMM(v.y)


def copy_in(dst, src):
    """Copies of src's parts and drawings, added to dst. Pads lose their nets,
    which belong to the other board."""
    out = []
    for fp in src.GetFootprints():
        c = fp.Duplicate(False).Cast()
        dst.Add(c)
        for p in c.Pads():
            p.SetNetCode(0)
        out.append(c)
    for d in src.GetDrawings():
        c = d.Duplicate()
        dst.Add(c)
        out.append(c)
    return out


def device_outline(board):
    """The Cardputer's own outline, as lines on the notes layer: the cutting line."""
    x0, y0, x1, y1, rt, rb = DEVICE
    out = []
    def seg(a, b):
        sh = pcbnew.PCB_SHAPE(board); sh.SetShape(pcbnew.SHAPE_T_SEGMENT)
        sh.SetStart(V(*a)); sh.SetEnd(V(*b)); sh.SetLayer(NOTES); sh.SetWidth(MM(0.25))
        board.Add(sh); out.append(sh)
    def arc(c, start, ang):
        sh = pcbnew.PCB_SHAPE(board); sh.SetShape(pcbnew.SHAPE_T_ARC)
        sh.SetCenter(V(*c)); sh.SetStart(V(*start)); sh.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(ang, pcbnew.DEGREES_T), True)
        sh.SetLayer(NOTES); sh.SetWidth(MM(0.25)); board.Add(sh); out.append(sh)
    seg((x0 + rt, y0), (x1 - rt, y0)); arc((x1 - rt, y0 + rt), (x1 - rt, y0), 90)
    seg((x1, y0 + rt), (x1, y1 - rb)); arc((x1 - rb, y1 - rb), (x1, y1 - rb), 90)
    seg((x1 - rb, y1), (x0 + rb, y1)); arc((x0 + rb, y1 - rb), (x0 + rb, y1), 90)
    seg((x0, y1 - rb), (x0, y0 + rt)); arc((x0 + rt, y0 + rt), (x0, y0 + rt), 90)
    return out


def outline_box(items, layer=pcbnew.Edge_Cuts):
    """(x1, y1, x2, y2) of the outline lines (board edge, or another layer) among items."""
    box = None
    for it in items:
        if isinstance(it, pcbnew.PCB_SHAPE) and it.GetLayer() == layer:
            if box is None:
                box = it.GetBoundingBox()
            else:
                box.Merge(it.GetBoundingBox())
    return (*xy(box.GetOrigin()), *xy(box.GetEnd()))


def seen_from_outside(items, x):
    """Turn items over about the vertical line at x, as if seen from the other
    face: the parts' face comes to the front and its printing reads the right way."""
    for it in items:
        it.Flip(V(x, 0), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)


def move_to(items, at):
    """Shift items so the Cardputer outline's top-left corner sits at `at`."""
    x1, y1, _, _ = outline_box(items, NOTES)
    for it in items:
        it.Move(V(at[0] - x1, at[1] - y1))


def line(board, a, b, width=0.2):
    s = pcbnew.PCB_SHAPE(board)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(V(*a)); s.SetEnd(V(*b)); s.SetLayer(NOTES); s.SetWidth(MM(width))
    board.Add(s)


def words(board, x, y, text, size=2.5, centre=False):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(text); t.SetLayer(NOTES)
    t.SetTextSize(V(size, size)); t.SetTextThickness(MM(size * 0.13))
    t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_CENTER if centre else pcbnew.GR_TEXT_H_ALIGN_LEFT)
    t.SetPosition(V(x, y))
    board.Add(t)


def hide_fab_words(board):
    """The assembly drawing (Fab) layers repeat each part's name and value,
    over the printed ones: keep only their outlines of the part bodies."""
    fab = (pcbnew.F_Fab, pcbnew.B_Fab)
    for fp in board.GetFootprints():
        for t in [*fp.GetFields(), *fp.GraphicalItems()]:
            if isinstance(t, (pcbnew.PCB_TEXT, pcbnew.PCB_FIELD)) and t.GetLayer() in fab:
                t.SetVisible(False)


def screw_marks(board):
    """A cross on each unplated hole (the M2 screw holes), to line up with the
    screw inserts. KiCad already draws the hole's circle."""
    for fp in board.GetFootprints():
        for p in fp.Pads():
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                x, y = xy(p.GetPosition())
                line(board, (x - 2, y), (x + 2, y), 0.1)
                line(board, (x, y - 2), (x, y + 2), 0.1)


def ruler(board, at, length=100):
    """An L of two 100 mm rulers, ticks every 10 mm: printers can scale the two
    directions differently, so measure both."""
    x0, y0 = at
    line(board, (x0, y0), (x0 + length, y0))
    line(board, (x0, y0), (x0, y0 - length))
    for mm in range(0, length + 1, 10):
        tick = 4 if mm % 50 == 0 else 2
        line(board, (x0 + mm, y0), (x0 + mm, y0 + tick))
        line(board, (x0, y0 - mm), (x0 - tick, y0 - mm))
    for mm in (0, 50, 100):
        words(board, x0 + mm, y0 + 7, f"{mm}", 2.5, centre=True)
    words(board, x0 - 9, y0 - 50, "50", 2.5, centre=True)
    words(board, x0 - 9, y0 - 100, "100", 2.5, centre=True)
    words(board, x0 + 20, y0 - 8, "Each ruler must measure exactly 100 mm.", 2.2)


def make(out=PDF):
    board = pcbnew.LoadBoard(board_file("biomap_cardputer", ".kicad_pcb"))
    for t in list(board.GetTracks()):        # tracks and vias
        board.Delete(t)
    for z in list(board.Zones()):            # copper fill, guard and keep-out areas
        board.Delete(z)
    own = [*board.GetFootprints(), *board.GetDrawings()] + device_outline(board)
    seen_from_outside(own, DEVICE[2] / 2)
    move_to(own, BOARD_AT)

    hide_fab_words(board)
    screw_marks(board)
    ruler(board, RULER_AT)
    bx1, by1, bx2, by2 = outline_box(own, NOTES)
    words(board, 15, 15, "Bio Mapping 2: Cardputer board, full size", 4)
    for i, s in enumerate((
            "Print at 100% (\"Actual size\"), not \"Fit to page\". Then measure both rulers.",
            "Seen from outside, as it lies on the opened Cardputer. Cut along the outer line (the",
            "Cardputer's own outline) and lay it on, EXT edge to EXT edge. The two big + marks must sit",
            "over the two screw inserts. J1, the cable socket (on the hidden face, 4.25 mm tall),",
            "must sit over flat board, clear of the EXT socket, the headphone socket and the battery plug.")):
        words(board, 15, 25 + i * 5, s, 2.5)
    words(board, (bx1 + bx2) / 2, by2 + 6, "Board 79.8 x 49.8 mm inside the Cardputer's 84 x 54 mm outline",
          2.5, centre=True)
    words(board, (bx1 + bx2) / 2, by1 - 3, "EXT edge", 2.2, centre=True)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        pcb = os.path.join(tmp, "print.kicad_pcb")
        pcbnew.SaveBoard(pcb, board)
        cli("pcb", "export", "pdf", "--mode-single", "--black-and-white", "--drill-shape-opt", "2",
            "--scale", "1", "--layers", LAYERS, "-o", out, pcb, check=True)
    print(f"wrote {os.path.relpath(out)}: print it at 100% (Actual size) and measure both rulers")
    return 0
