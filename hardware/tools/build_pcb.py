"""Build a placed (unrouted) .kicad_pcb from a KiCad netlist. Run with KiCad's Python.
usage: build_pcb.py <board-name> <project-dir>"""
import math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcbnew
from check_sch import parse, find

FPDIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"
MM = pcbnew.FromMM

def V(x, y):
    return pcbnew.VECTOR2I(MM(x), MM(y))

# ── Placement tables: ref -> (x, y, rotation_deg, side)  side 'F' or 'B' ──
# Coordinates are as seen from the F (top) side.

# Cardputer: y = 0 is the Cardputer's bottom edge (the EXT socket edge).
# The board covers the back (y 0..54) plus a tab (y < 0) holding the angled header.
# F = face against the Cardputer back (only the angled header lives there),
# B = outer face with all the parts and the GPS breakout.
CARDPUTER = {
    "J1": (42 + 7.62, -6.58, -90, "F"),   # pins point +y into the EXT socket
    "H1": (14, 4, 0, "F"), "H2": (70, 4, 0, "F"),
    "FB1": (22, 6.5, 0, "B"), "C4": (27, 9.5, 90, "B"), "U3": (32, 9, 0, "B"), "C5": (37, 9.5, 90, "B"),
    "R1": (21, 18, 0, "B"), "R2": (21, 22, 0, "B"), "C1": (12, 18, 0, "B"),
    "U1": (14, 26, 0, "B"),
    "R5": (8, 34, 90, "B"), "C2": (11.5, 34, 90, "B"),
    "U2": (27, 31, 0, "B"), "C3": (27, 25.5, 0, "B"),
    "R6": (31, 39, 90, "B"), "R7": (35, 39, 90, "B"),
    "R3": (15, 44, 0, "B"), "R4": (15, 48, 0, "B"),
    "J2": (6.3, 47, 90, "B"),              # JST side entry, opening faces left edge
    "J3": (37.5, 18, 180, "B"),              # GPS wire pads
}
CARDPUTER_GPS = (41.8, 11.5)               # top-left of the 40.64 mm breakout outline

# Flipper: board stands up out of the Flipper's top edge. y = H is the Flipper edge.
FH, FW = 52.0, 80.0
F1X = FW / 2 + 29.21                       # Flipper pin 1 x (pins run right to left)
FLIPPER = {
    "J1": (F1X, FH - 4.04, -90, "F"),              # Flipper pins 1-8
    "J4": (F1X - 2 * 17.78, FH - 4.04, -90, "F"),  # Flipper pins 9-18
    "J3": (46.5, 12, 0, "F"),
    "C1": (58, 7, 0, "F"), "R1": (64, 7, 0, "F"), "R2": (70, 7, 0, "F"),
    "U1": (59, 15, 0, "F"),
    "R5": (52, 22, 90, "F"), "C2": (55.5, 22, 90, "F"),
    "U2": (68, 18, 0, "F"), "C3": (74, 14, 90, "F"),
    "R6": (62, 26, 0, "F"), "R7": (62, 30, 0, "F"),
    "R3": (68, 30, 0, "F"), "R4": (68, 34, 0, "F"),
    "J2": (FW - 6.3, 33, 90, "F"),          # JST side entry, opening faces right edge
}
FLIPPER_GPS = (2.0, 2.0)

def outline_cardputer(add_seg, add_arc):
    r = 3.0
    pts = []
    # main 84 x 54 rectangle with rounded far corners, plus a 28 mm wide tab on the top edge
    add_seg((0, 0), (28, 0)); add_seg((28, 0), (28, -9)); add_seg((28, -9), (56, -9))
    add_seg((56, -9), (56, 0)); add_seg((56, 0), (84, 0))
    add_seg((84, 0), (84, 54 - r)); add_arc((84 - r, 54 - r), (84, 54 - r), 90)
    add_seg((84 - r, 54), (r, 54)); add_arc((r, 54 - r), (r, 54), 90)
    add_seg((0, 54 - r), (0, 0))

def outline_flipper(add_seg, add_arc):
    r = 3.0
    add_seg((r, 0), (FW - r, 0)); add_arc((FW - r, r), (FW - r, 0), 90)
    add_seg((FW, r), (FW, FH)); add_seg((FW, FH), (0, FH)); add_seg((0, FH), (0, r))
    add_arc((r, r), (0, r), 90)

BOARDS = {
    "biomap_cardputer": (CARDPUTER, outline_cardputer, CARDPUTER_GPS, "B"),
    "biomap_flipper": (FLIPPER, outline_flipper, FLIPPER_GPS, "F"),
}

def main(name, d):
    place, outline, gps, gps_side = BOARDS[name]
    net = parse(open(os.path.join(d, name + ".net")).read())
    board = pcbnew.BOARD()
    ds = board.GetDesignSettings()
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(MM(0.3)); nc.SetClearance(MM(0.15)); nc.SetViaDiameter(MM(0.7)); nc.SetViaDrill(MM(0.35))
    nets = {}
    for n in find(find(net, "nets")[0], "net"):
        nm = find(n, "name")[0][1]
        ni = pcbnew.NETINFO_ITEM(board, nm); board.Add(ni); nets[nm] = ni
    padnet = {}
    for n in find(find(net, "nets")[0], "net"):
        nm = find(n, "name")[0][1]
        for nd in find(n, "node"):
            padnet[(find(nd, "ref")[0][1], find(nd, "pin")[0][1])] = nm
    for c in find(find(net, "components")[0], "comp"):
        ref = find(c, "ref")[0][1]; val = find(c, "value")[0][1]
        lib, fpname = find(c, "footprint")[0][1].split(":")
        fp = pcbnew.FootprintLoad(f"{FPDIR}/{lib}.pretty", fpname)
        fp.SetReference(ref); fp.SetValue(val)
        fp.SetFPID(pcbnew.LIB_ID(lib, fpname))
        fp.SetPath(pcbnew.KIID_PATH("/" + find(c, "tstamps")[0][1]))
        x, y, rot, side = place[ref]
        board.Add(fp)
        if side == "B":
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(V(x, y))
        for fl in find(find(c, "fields")[0], "field") if find(c, "fields") else []:
            fname = find(fl, "name")[0][1]; fval = fl[2] if len(fl) > 2 else ""
            if fname in ("Note",):
                f = pcbnew.PCB_FIELD(fp, pcbnew.FIELD_T_USER, fname)
                f.SetText(fval); f.SetVisible(False); f.SetLayer(fp.GetLayer() == pcbnew.F_Cu and pcbnew.F_Fab or pcbnew.B_Fab)
                fp.Add(f)
        for p in fp.Pads():
            k = (ref, p.GetNumber())
            if k in padnet:
                p.SetNet(nets[padnet[k]])
        if "DNP" in val:
            fp.SetDNP(True)
    def add_seg(a, b):
        s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(V(*a)); s.SetEnd(V(*b)); s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1)); board.Add(s)
    def add_arc(c, start, ang):
        s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_ARC)
        s.SetCenter(V(*c)); s.SetStart(V(*start)); s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(ang, pcbnew.DEGREES_T), True)
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1)); board.Add(s)
    outline(add_seg, add_arc)
    # GPS breakout outline (silkscreen) - stuck on with a double-sided pad
    silk = pcbnew.F_SilkS if gps_side == "F" else pcbnew.B_SilkS
    gx, gy = gps
    s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_RECT)
    s.SetStart(V(gx, gy)); s.SetEnd(V(gx + 40.64, gy + 40.64)); s.SetLayer(silk); s.SetWidth(MM(0.15)); board.Add(s)
    t = pcbnew.PCB_TEXT(board); t.SetText("GPS breakout\n(sticky pad)"); t.SetPosition(V(gx + 20.32, gy + 20.32))
    t.SetLayer(silk); t.SetTextSize(V(1.5, 1.5)); t.SetMirrored(gps_side == "B"); board.Add(t)
    # geometry report: courtyard box of each connector
    for fp in board.GetFootprints():
        if fp.GetReference()[0] in "JH":
            bb = fp.GetCourtyard(pcbnew.F_CrtYd if not fp.IsFlipped() else pcbnew.B_CrtYd).BBox()
            pads = sorted((int(p.GetNumber()), round(pcbnew.ToMM(p.GetPosition().x), 2), round(pcbnew.ToMM(p.GetPosition().y), 2)) for p in fp.Pads() if p.GetNumber().isdigit())
            print(f"  {fp.GetReference():3s} side={'B' if fp.IsFlipped() else 'F'} courtyard x {pcbnew.ToMM(bb.GetLeft()):.2f}..{pcbnew.ToMM(bb.GetRight()):.2f} y {pcbnew.ToMM(bb.GetTop()):.2f}..{pcbnew.ToMM(bb.GetBottom()):.2f}  pads {pads[:2]}..{pads[-1:]}")
    path = os.path.join(d, name + ".kicad_pcb")
    pcbnew.SaveBoard(path, board)
    print("saved", path)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
