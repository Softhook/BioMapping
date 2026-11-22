"""A full-size paper copy of the Cardputer board and its flex tail, to cut
out and hold against a real Cardputer before ordering: do the screw holes
sit over the screw inserts, does the tail reach the EXT socket, does the
board cover anything it shouldn't?

Everything is drawn as seen from outside, the way you see the board on the
back of the Cardputer: the parts' face, with its printing readable. One A4
page holds:
  * the board with the tail laid out flat where it really lies (turned
    180 degrees, tail pad k on board pad k), to cut out as one piece and
    fold round the bottom edge
  * the tail again on its own
  * a 100 mm ruler in each direction, to prove the printer didn't scale it

KiCad itself draws the page, from a copy of the two boards with the tracks
and copper fill left out (they would only be ink): every pad, hole, part
outline and printed label stays, at exactly 1:1."""
import os
import sys
import tempfile

import pcbnew

from .kicad import HARDWARE, board_file, cli

OUT = os.path.join(HARDWARE, "out", "biomap_cardputer_print.pdf")
LAYERS = "F.Cu,F.SilkS,F.Fab,Edge.Cuts,Dwgs.User,Cmts.User"
NOTES = pcbnew.Cmts_User          # our own words, ruler and screw marks

# Where things go on the page (A4 landscape, 297 x 210 mm, y down), in mm:
# the board's top-left corner, the lone tail's top-left corner, the ruler's corner.
BOARD_AT = (20, 58)
TAIL_AT = (128, 62)
RULER_AT = (180, 190)

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


def pad_centres(board, ref):
    fp = board.FindFootprintByReference(ref)
    return {p.GetNumber(): xy(p.GetPosition()) for p in fp.Pads()}


def tail_turn_centre(board, tail):
    """The point to turn the tail 180 degrees about so that each of its solder
    pads (J2) lands on the board's landing pad (J1) with the same number.
    Stops if any pad misses by more than 0.01 mm."""
    land, solder = pad_centres(board, "J1"), pad_centres(tail, "J2")
    (bx, by), (tx, ty) = land["1"], solder["1"]
    cx, cy = (bx + tx) / 2, (by + ty) / 2
    for k, (sx, sy) in solder.items():
        lx, ly = land[k]
        if abs(2 * cx - sx - lx) > 0.01 or abs(2 * cy - sy - ly) > 0.01:
            sys.exit(f"tail pad {k} doesn't land on board pad {k}: check J2 in cardputer_tail.py")
    return cx, cy


def outline_box(items):
    """(x1, y1, x2, y2) of the board-edge lines among items."""
    box = None
    for it in items:
        if isinstance(it, pcbnew.PCB_SHAPE) and it.GetLayer() == pcbnew.Edge_Cuts:
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
    """Shift items so their board outline's top-left corner sits at `at`."""
    x1, y1, _, _ = outline_box(items)
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


def make(out=OUT):
    board = pcbnew.LoadBoard(board_file("biomap_cardputer", ".kicad_pcb"))
    tail = pcbnew.LoadBoard(board_file("biomap_cardputer_tail", ".kicad_pcb"))
    for t in list(board.GetTracks()):        # tracks and vias
        board.Delete(t)
    for z in list(board.Zones()):            # copper fill, guard and keep-out areas
        board.Delete(z)
    own = [*board.GetFootprints(), *board.GetDrawings()]
    x1, _, x2, _ = outline_box(own)

    # the board, with the tail lying where it really goes
    cx, cy = tail_turn_centre(board, tail)
    laid = copy_in(board, tail)
    for it in laid:
        it.Rotate(V(cx, cy), pcbnew.EDA_ANGLE(180, pcbnew.DEGREES_T))
    seen_from_outside(own + laid, (x1 + x2) / 2)
    move_to(own + laid, BOARD_AT)

    # the tail on its own, solder end at the top
    alone = copy_in(board, tail)
    tx1, _, tx2, _ = outline_box(alone)
    seen_from_outside(alone, (tx1 + tx2) / 2)
    move_to(alone, TAIL_AT)

    hide_fab_words(board)
    screw_marks(board)
    ruler(board, RULER_AT)
    bx1, by1, bx2, by2 = outline_box(own + laid)
    lx1, ly1, lx2, ly2 = outline_box(alone)
    words(board, 15, 15, "Bio Mapping 2: Cardputer board and flex tail, full size", 4)
    for i, s in enumerate((
            "Print at 100% (\"Actual size\"), not \"Fit to page\". Then measure both rulers.",
            "Both drawings are seen from outside: the face you see on the back of the Cardputer.",
            "Cut round the outer line, tail and all, and fold the tail round the Cardputer's",
            "bottom edge to the EXT socket. The + marks are the centres of the two M2 screws.",
            "Paper is thinner than the 1.6 mm board: glue it onto card that thick for a truer fold.")):
        words(board, 15, 25 + i * 5, s, 2.5)
    words(board, (bx1 + bx2) / 2, by2 + 6, "Board 84 x 54 mm, with the tail laid out flat", 2.5, centre=True)
    words(board, (bx1 + bx2) / 2, by1 - 3, "EXT edge (the Cardputer's bottom edge)", 2.2, centre=True)
    words(board, (lx1 + lx2) / 2, ly1 - 3, "solder end", 2.2, centre=True)
    words(board, (lx1 + lx2) / 2, ly2 + 5, "plug end (stiffener behind)", 2.2, centre=True)
    words(board, (lx1 + lx2) / 2, ly2 + 11, "Tail on its own", 2.5, centre=True)

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        pcb = os.path.join(tmp, "print.kicad_pcb")
        pcbnew.SaveBoard(pcb, board)
        cli("pcb", "export", "pdf", "--mode-single", "--black-and-white", "--drill-shape-opt", "2",
            "--scale", "1", "--layers", LAYERS, "-o", out, pcb, check=True)
    print(f"wrote {os.path.relpath(out)}: print it at 100% (Actual size) and measure both rulers")
    return 0
