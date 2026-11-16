"""Build a placed and hand-routed .kicad_pcb from a KiCad netlist.
Run with KiCad's Python.  usage: build_pcb.py <board-name> <project-dir> [--dump]

Every part position and every track is written out below by hand, so the
layout follows the signal path. No autorouter is involved. Ground is two
copper pours (one per side) joined by stitching vias."""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pcbnew
from check_netlist import parse, find

FPDIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"
MM = pcbnew.FromMM

def V(x, y):
    return pcbnew.VECTOR2I(MM(x), MM(y))

# Track widths (mm)
SIG, PWR = 0.25, 0.5
VIA_D, VIA_DRILL = 0.7, 0.35

# ═══ Flipper ═══════════════════════════════════════════════════════════════
# The board stands up from the Flipper's top edge. y = 52 is the edge that
# meets the Flipper; all parts sit on the front (F). Left half: GPS on a
# 50 x 52 mm ground plane. Right half: the GSR circuit, cuffs on the right edge.
FH, FW = 52.0, 80.0
F1X = FW / 2 + 29.21                      # Flipper pin 1 x (pins run right to left)
FLIPPER = {
    "J1": (F1X, FH - 4.04, -90, "F"),              # Flipper pins 1-8
    "J4": (F1X - 2 * 17.78, FH - 4.04, -90, "F"),  # Flipper pins 9-18
    # GPS centred on the left half; its serial pads face the header
    "U4": (25.0, 20.0, -90, "F"),
    "C7": (35.3, 22.85, -90, "F"),                 # bridges VCC pad 17 and GND pad 16
    "C6": (38.95, 26.0, 0, "F"),
    "TP2": (35.9, 19.2, 0, "F"), "TP1": (14.4, 20.0, 0, "F"),
    "D1": (30.6, 6.0, 0, "F"), "R8": (25.6, 6.0, 180, "F"),
    "C8": (21.6, 5.3, 180, "F"), "BT1": (17.4, 5.3, 0, "F"),
    "R10": (25.0, 31.0, -90, "F"), "R9": (27.5, 31.0, -90, "F"),
    # GSR circuit: cuffs (right edge) -> R3/R4 -> U1 -> U2 below it
    "J2": (FW - 6.3, 18.0, 90, "F"),
    "R4": (69.9, 16.0, 180, "F"), "R3": (69.9, 22.0, 180, "F"),
    "R5": (65.6, 19.3, -90, "F"), "C2": (67.6, 19.3, -90, "F"),
    "U1": (60.0, 18.0, 180, "F"),
    "R1": (53.6, 13.6, 0, "F"), "R2": (53.6, 16.1, 180, "F"), "C1": (55.0, 22.1, -90, "F"),
    "U2": (60.0, 27.0, -90, "F"), "C3": (57.0, 30.6, -90, "F"),
    "R6": (64.5, 33.0, 90, "F"), "R7": (67.0, 33.0, 90, "F"),
}
# Tracks: (layer, width, points). A point is "REF.pad" or (x, y); a leading
# "net:NAME" names the net when the track starts at a bare point.
FLIPPER_TRACKS = [
    # ── GPS ──
    ("F", PWR, ["J4.1", (33.65, 44.5), (38.0, 40.15), (38.0, 9.5), (26.9, 9.5), "U4.2"]),   # 3V3 up the side to V_IO
    ("F", PWR, [(38.0, 21.9), "C7.1", "U4.17"]),          # 3V3 into VCC through C7
    ("F", PWR, ["C7.2", "U4.16"]),                         # C7 straight back to the next GND pad
    ("F", PWR, [(38.0, 26.0), "C6.1"]),
    ("F", SIG, ["D1.2", (31.85, 9.5)]),                    # backup charger: 3V3 -> D1 -> R8
    ("F", SIG, ["D1.1", "R8.1"]),
    ("F", SIG, ["R8.2", (24.69, 7.6), (25.0, 7.9), "U4.3"]),
    ("F", SIG, ["R8.2", "C8.1"]),
    ("F", SIG, ["C8.1", (22.55, 3.3), (17.4, 3.3), "BT1.1"]),
    ("F", SIG, ["U4.18", "TP2.1"]),
    ("F", SIG, ["U4.8", "TP1.1"]),
    ("F", SIG, ["U4.13", "R10.1"]),
    ("F", SIG, ["U4.14", (26.9, 28.9), (27.5, 29.5), "R9.1"]),
    ("F", SIG, ["R10.2", (25.0, 40.0), (20.95, 44.05), "J4.6"]),
    ("F", SIG, ["R9.2", (27.5, 40.0), (23.49, 44.01), "J4.5"]),
    # ── 3V3 to the GSR side: back layer along the bottom, then up the left of the circuit ──
    ("B", PWR, ["J4.1", (33.65, 45.6), (50.5, 45.6)]),
    ("F", PWR, ["net:+3V3", (50.5, 45.6), (50.5, 13.6), "R1.1"]),
    ("F", PWR, ["net:+3V3", (50.5, 19.91), (55.0, 19.91), "C1.1"]),
    ("F", PWR, ["U1.8", (55.0, 19.91)]),
    ("F", PWR, ["net:+3V3", (50.5, 30.3), (57.0, 30.3), "C3.1"]),
    ("F", SIG, ["U2.8", (60.0, 30.3), (57.0, 30.3)]),
    ("F", SIG, ["net:+3V3", (50.5, 35.5), (67.0, 35.5), "R7.1"]),
    ("F", SIG, ["R6.1", (64.5, 35.5)]),
    # ── GSR signal path ──
    ("F", SIG, ["J2.2", "R4.1"]),
    ("F", SIG, ["J2.1", (72.6, 18.0), (70.81, 19.79), "R3.1"]),
    ("F", SIG, ["R4.2", (67.6, 16.0), "C2.1"]),             # TIA input node: R4, C2, R5, U1 pin 2
    ("F", SIG, ["C2.1", "R5.1", (63.5, 18.39), "U1.2"]),
    ("F", SIG, ["U1.1", (64.2, 19.91), (64.5, 20.21), "R5.2", "C2.2"]),
    ("F", SIG, [(64.2, 19.91), (64.2, 21.5), (59.5, 21.5), "U2.4"]),
    ("F", SIG, ["U1.3", "U1.6"]),                           # 0.5 V reference under the chip
    ("F", SIG, ["U1.6", "U1.7"]),
    ("F", SIG, [(59.0, 17.36), "U2.5"]),
    ("F", SIG, ["R1.2", "R2.1", "U1.5"]),
    # ── ADC and I2C ──
    ("F", SIG, ["U2.3", (60.0, 23.4), (62.3, 23.4)]),
    ("F", SIG, ["U2.1", (61.0, 23.4)]),
    ("F", SIG, ["U2.9", (60.5, 31.2), (64.5, 31.2), "R6.2"]),
    ("F", SIG, ["U2.10", (61.0, 30.4), (67.0, 30.4), "R7.2"]),
    ("B", SIG, ["net:I2C_SCL", (62.2, 30.4), (62.2, 42.6), (15.87, 42.6), "J4.8"]),
    ("B", SIG, ["net:I2C_SDA", (63.2, 31.2), (63.2, 43.8), (18.41, 43.8), "J4.7"]),
]
FLIPPER_VIAS = [
    ("+3V3", 50.5, 45.6), ("I2C_SCL", 62.2, 30.4), ("I2C_SDA", 63.2, 31.2),
    ("GND", 62.3, 23.4), ("GND", 64.4, 16.09), ("GND", 52.0, 17.6), ("GND", 55.0, 24.3),
    ("GND", 57.0, 32.8), ("GND", 68.99, 23.6), ("GND", 36.6, 24.4), ("GND", 40.9, 27.2),
]
# GPS keep-clear: no tracks on the back layer near the module, none under it on the front
FLIPPER_KEEPOUT = [("B", (0.5, 0.5, 45.0, 40.0)), ("F", (19.7, 14.7, 30.3, 25.3))]

# ═══ Cardputer ═════════════════════════════════════════════════════════════
# y = 0 is the Cardputer's bottom edge (EXT socket edge). The board covers
# the back (y 0..54) plus a tab (y < 0) holding the angled header. F = face
# against the Cardputer (only the header), B = outer face with everything else.
CARDPUTER = {
    "J1": (42 + 7.62, -6.58, -90, "F"),   # pins point +y into the EXT socket
    "H1": (14, 4, 0, "F"), "H2": (70, 4, 0, "F"),
    # 5 V -> 3.3 V, right under the header's 5 V pin
    "FB1": (46.4, -1.6, 0, "B"), "C4": (47.0, 2.45, 180, "B"),
    "U3": (52.0, 1.5, 0, "B"), "C5": (55.2, 3.36, -90, "B"),
    # GPS on the right half; serial pads face the header tab
    "U4": (58.0, 30.0, 90, "B"),
    "C7": (68.4, 27.15, 90, "B"),                  # bridges VCC pad 17 and GND pad 16
    "C6": (72.45, 24.0, 0, "B"),
    "TP2": (68.4, 30.3, 0, "B"), "TP1": (47.4, 30.0, 0, "B"),
    "R10": (58.0, 19.0, 90, "B"), "R9": (60.5, 19.0, 90, "B"),
    "D1": (64.4, 44.5, 0, "B"), "R8": (60.4, 44.5, 180, "B"),
    "C8": (56.2, 45.2, 180, "B"), "BT1": (52.0, 45.2, 0, "B"),
    # GSR circuit: the Flipper layout mirrored (x -> 82 - x, y -> y + 12), cuffs on the left edge
    "J2": (8.3, 30.0, 90, "B"),
    "R4": (12.1, 28.0, 0, "B"), "R3": (12.1, 34.0, 0, "B"),
    "R5": (16.4, 31.3, -90, "B"), "C2": (14.4, 31.3, -90, "B"),
    "U1": (22.0, 30.0, 0, "B"),
    "R1": (28.4, 25.6, 180, "B"), "R2": (28.4, 28.1, 0, "B"), "C1": (27.0, 34.1, -90, "B"),
    "U2": (22.0, 39.0, -90, "B"), "C3": (25.0, 42.6, -90, "B"),
    "R6": (17.5, 45.0, 90, "B"), "R7": (15.0, 45.0, 90, "B"),
}
CARDPUTER_TRACKS = [
    # ── 5 V -> 3.3 V ──
    ("B", PWR, ["J1.6", (44.54, -1.6), "FB1.1"]),
    ("B", PWR, ["FB1.2", (48.5, -1.6), (50.86, -1.6), "U3.3"]),       # EN, from above
    ("B", PWR, [(48.5, -1.6), (48.5, 2.45), "U3.1"]),                  # IN, from the left
    ("B", PWR, [(48.5, 2.45), "C4.1"]),
    ("B", SIG, ["U3.2", (49.6, 1.5)]),
    ("B", PWR, ["U3.5", "C5.1"]),
    # ── GPS ──
    ("B", PWR, ["C5.1", (57.5, 2.45), (61.5, 6.45), (71.5, 6.45), (71.5, 41.0), (59.9, 41.0), "U4.2"]),
    ("B", PWR, [(71.5, 28.1), "C7.1", "U4.17"]),
    ("B", PWR, ["C7.2", "U4.16"]),
    ("B", PWR, [(71.5, 24.0), "C6.1"]),
    ("B", SIG, ["D1.2", (65.65, 41.0)]),
    ("B", SIG, ["D1.1", "R8.1"]),
    ("B", SIG, ["R8.2", (58.0, 43.0), "U4.3"]),
    ("B", SIG, ["R8.2", "C8.1"]),
    ("B", SIG, ["C8.1", (57.15, 47.4), (52.0, 47.4), "BT1.1"]),
    ("B", SIG, ["U4.18", "TP2.1"]),
    ("B", SIG, ["U4.8", "TP1.1"]),
    ("B", SIG, ["U4.13", "R10.1"]),
    ("B", SIG, ["U4.14", (59.9, 21.0), (60.5, 20.4), "R9.1"]),
    ("B", SIG, ["R10.2", (58.0, 14.0), (34.38, 14.0), "J1.14"]),
    ("B", SIG, ["R9.2", (60.5, 12.5), (36.92, 12.5), "J1.12"]),
    # ── 3V3 to the GSR side: inner layer under the tab, then down the right of the circuit ──
    ("B", PWR, ["U3.5", (53.14, 4.4)]),
    ("F", PWR, ["net:+3V3", (53.14, 4.4), (33.0, 4.4)]),
    ("B", PWR, ["net:+3V3", (33.0, 4.4), (33.0, 47.5), (15.0, 47.5), "R7.1"]),
    ("B", PWR, ["net:+3V3", (33.0, 25.6), "R1.1"]),
    ("B", PWR, ["net:+3V3", (33.0, 31.91), (27.0, 31.91), "C1.1"]),
    ("B", PWR, ["U1.8", (27.0, 31.91)]),
    ("B", PWR, ["net:+3V3", (33.0, 42.3), (25.0, 42.3), "C3.1"]),
    ("B", SIG, ["U2.8", (22.0, 42.3), (25.0, 42.3)]),
    ("B", SIG, ["R6.1", (17.5, 47.5)]),
    # ── GSR signal path ──
    ("B", SIG, ["J2.2", "R4.1"]),
    ("B", SIG, ["J2.1", (9.4, 30.0), (11.19, 31.79), "R3.1"]),
    ("B", SIG, ["R4.2", (14.4, 28.0), "C2.1"]),
    ("B", SIG, ["C2.1", "R5.1", (18.5, 30.39), "U1.2"]),
    ("B", SIG, ["U1.1", (17.8, 31.91), (17.5, 32.21), "R5.2", "C2.2"]),
    ("B", SIG, [(17.8, 31.91), (17.8, 33.5), (22.5, 33.5), "U2.4"]),
    ("B", SIG, ["U1.3", "U1.6"]),
    ("B", SIG, ["U1.6", "U1.7"]),
    ("B", SIG, [(23.0, 29.36), "U2.5"]),
    ("B", SIG, ["R1.2", "R2.1", "U1.5"]),
    # ── ADC and I2C ──
    ("B", SIG, ["U2.3", (22.0, 35.4), (19.7, 35.4)]),
    ("B", SIG, ["U2.1", (21.0, 35.4)]),
    ("B", SIG, ["U2.9", (21.5, 43.2), (17.5, 43.2), "R6.2"]),
    ("B", SIG, ["U2.10", (21.0, 42.4), (15.0, 42.4), "R7.2"]),
    ("F", SIG, ["net:I2C_SCL", (19.8, 42.4), (30.6, 42.4), (30.6, 1.0), (39.46, 1.0), "J1.10"]),
    ("F", SIG, ["net:I2C_SDA", (18.8, 43.2), (31.6, 43.2), (31.6, 2.0), (42.0, 2.0), "J1.8"]),
]
CARDPUTER_VIAS = [
    ("+3V3", 53.14, 4.4), ("+3V3", 33.0, 4.4), ("I2C_SCL", 19.8, 42.4), ("I2C_SDA", 18.8, 43.2),
    ("GND", 49.6, 1.5), ("GND", 44.9, 2.45), ("GND", 55.2, 5.5), ("GND", 74.8, 24.0),
    ("GND", 19.7, 35.4), ("GND", 17.6, 28.09), ("GND", 29.31, 29.4), ("GND", 27.0, 36.3),
    ("GND", 25.0, 44.8), ("GND", 13.01, 35.6),
]
# GPS keep-clear: no tracks on the inner layer near the module, none under it on the outer face
CARDPUTER_KEEPOUT = [("F", (40.5, 12.5, 75.5, 47.5)), ("B", (52.7, 24.7, 63.3, 35.3))]

def outline_cardputer(add_seg, add_arc):
    r = 3.0
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
    "biomap_cardputer": (CARDPUTER, outline_cardputer, CARDPUTER_TRACKS, CARDPUTER_VIAS, CARDPUTER_KEEPOUT),
    "biomap_flipper": (FLIPPER, outline_flipper, FLIPPER_TRACKS, FLIPPER_VIAS, FLIPPER_KEEPOUT),
}

def load_parts(board, net_path, place):
    net = parse(open(net_path).read())
    nets = {}
    for n in find(find(net, "nets")[0], "net"):
        nm = find(n, "name")[0][1]
        ni = pcbnew.NETINFO_ITEM(board, nm); board.Add(ni); nets[nm.lstrip("/")] = ni
    padnet = {}
    for n in find(find(net, "nets")[0], "net"):
        nm = find(n, "name")[0][1].lstrip("/")
        for nd in find(n, "node"):
            padnet[(find(nd, "ref")[0][1], find(nd, "pin")[0][1])] = nm
    fps = {}
    for c in find(find(net, "components")[0], "comp"):
        ref = find(c, "ref")[0][1]; val = find(c, "value")[0][1]
        lib, fpname = find(c, "footprint")[0][1].split(":")
        fp = pcbnew.FootprintLoad(f"{FPDIR}/{lib}.pretty", fpname)
        fp.SetReference(ref); fp.SetValue(val)
        fp.SetFPID(pcbnew.LIB_ID(lib, fpname))
        fp.SetPath(pcbnew.KIID_PATH("/" + find(c, "tstamps")[0][1]))
        x, y, rot, side = place.get(ref, (100 + 5 * len(fps), 70, 0, "F"))
        board.Add(fp)
        if side == "B":
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.SetOrientationDegrees(rot)
        fp.SetPosition(V(x, y))
        for fl in (find(find(c, "fields")[0], "field") if find(c, "fields") else []):
            if find(fl, "name")[0][1] == "Note":
                f = pcbnew.PCB_FIELD(fp, pcbnew.FIELD_T_USER, "Note")
                f.SetText(fl[2] if len(fl) > 2 else ""); f.SetVisible(False)
                f.SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
                fp.Add(f)
        for p in fp.Pads():
            k = (ref, p.GetNumber())
            if k in padnet:
                p.SetNet(nets[padnet[k]])
        if "DNP" in val:
            fp.SetDNP(True)
        fps[ref] = fp
    return fps, nets

def pad_of(fps, ref_pad):
    ref, num = ref_pad.split(".")
    return next(p for p in fps[ref].Pads() if p.GetNumber() == num)

def add_tracks(board, fps, nets, tracks, vias):
    layer = {"F": pcbnew.F_Cu, "B": pcbnew.B_Cu}
    for side, width, pts in tracks:
        net = None
        if isinstance(pts[0], str) and pts[0].startswith("net:"):
            net = nets[pts[0][4:]]
            pts = pts[1:]
        xy = []
        for p in pts:
            if isinstance(p, str):
                pad = pad_of(fps, p)
                net = net or pad.GetNet()
                assert pad.GetNet().GetNetname() == net.GetNetname(), (p, pad.GetNetname(), net.GetNetname())
                xy.append(pad.GetPosition())
            else:
                xy.append(V(*p))
        assert net, pts
        for a, b in zip(xy, xy[1:]):
            if a == b:
                continue
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(a); t.SetEnd(b); t.SetWidth(MM(width)); t.SetLayer(layer[side]); t.SetNet(net)
            board.Add(t)
    for netname, x, y in vias:
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(V(x, y)); v.SetWidth(MM(VIA_D)); v.SetDrill(MM(VIA_DRILL)); v.SetNet(nets[netname])
        board.Add(v)

def add_keepouts(board, keepouts):
    for side, (x1, y1, x2, y2) in keepouts:
        z = pcbnew.ZONE(board)
        z.SetIsRuleArea(True)
        z.SetLayer(pcbnew.F_Cu if side == "F" else pcbnew.B_Cu)
        z.SetDoNotAllowTracks(True); z.SetDoNotAllowVias(False); z.SetDoNotAllowPads(False)
        z.SetDoNotAllowZoneFills(False); z.SetDoNotAllowFootprints(False)
        z.SetZoneName("GPS keep clear")
        ol = z.Outline(); ol.NewOutline()
        for px, py in ((x1, y1), (x2, y1), (x2, y2), (x1, y2)):
            ol.Append(MM(px), MM(py))
        board.Add(z)

def add_ground(board, nets):
    gnd = nets["GND"]
    bb = board.GetBoardEdgesBoundingBox()
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        z = pcbnew.ZONE(board)
        z.SetLayer(layer); z.SetNet(gnd)
        z.SetLocalClearance(MM(0.3)); z.SetMinThickness(MM(0.25))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        z.SetThermalReliefGap(MM(0.4)); z.SetThermalReliefSpokeWidth(MM(0.4))
        ol = z.Outline(); ol.NewOutline()
        for x, y in ((bb.GetLeft(), bb.GetTop()), (bb.GetRight(), bb.GetTop()),
                     (bb.GetRight(), bb.GetBottom()), (bb.GetLeft(), bb.GetBottom())):
            ol.Append(x, y)
        board.Add(z)

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def add_stitching(board, nets, fps, pitch_regions):
    """GND vias on a grid, skipping anywhere near copper of another net,
    near any part, or near the board edge."""
    gnd = nets["GND"]
    obst = []      # (kind, geometry, margin)
    for t in board.GetTracks():
        if t.GetClass() == "PCB_VIA":            # every via, ground ones too (drill spacing)
            obst.append(("c", (pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)), VIA_D / 2))
        elif t.GetNetname() != "GND":
            s, e = t.GetStart(), t.GetEnd()
            obst.append(("s", tuple(pcbnew.ToMM(v) for v in (s.x, s.y, e.x, e.y)), pcbnew.ToMM(t.GetWidth()) / 2))
    rects = []
    for fp in fps.values():
        for p in fp.Pads():
            bb = p.GetBoundingBox()
            rects.append((pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()),
                          pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()), 0.45))
        if fp.GetReference() != "U4":          # vias under the GPS module are wanted
            for lyr in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
                bb = fp.GetCourtyard(lyr).BBox()
                if bb.GetWidth() > 0:
                    rects.append((pcbnew.ToMM(bb.GetLeft()), pcbnew.ToMM(bb.GetTop()),
                                  pcbnew.ToMM(bb.GetRight()), pcbnew.ToMM(bb.GetBottom()), 0.2))
    edges = []
    for d in board.GetDrawings():
        if d.GetLayer() == pcbnew.Edge_Cuts:
            s, e = d.GetStart(), d.GetEnd()
            edges.append(tuple(pcbnew.ToMM(v) for v in (s.x, s.y, e.x, e.y)))
    outline = pcbnew.SHAPE_POLY_SET()
    board.GetBoardPolygonOutlines(outline, True)
    placed = 0
    for (x1, y1, x2, y2), pitch in pitch_regions:
        y = y1
        while y <= y2 + 1e-6:
            x = x1
            while x <= x2 + 1e-6:
                ok = outline.Contains(V(x, y))
                r = VIA_D / 2
                ok = ok and all(seg_dist(x, y, *e) > r + 0.8 for e in edges)
                for kind, g, m in obst if ok else []:
                    dist = math.hypot(x - g[0], y - g[1]) if kind == "c" else seg_dist(x, y, *g)
                    if dist < r + m + 0.3:
                        ok = False; break
                for rx1, ry1, rx2, ry2, m in rects if ok else []:
                    if rx1 - r - m < x < rx2 + r + m and ry1 - r - m < y < ry2 + r + m:
                        ok = False; break
                if ok:
                    v = pcbnew.PCB_VIA(board)
                    v.SetPosition(V(x, y)); v.SetWidth(MM(VIA_D)); v.SetDrill(MM(VIA_DRILL)); v.SetNet(gnd)
                    board.Add(v)
                    obst.append(("c", (x, y), r))
                    placed += 1
                x += pitch
            y += pitch
    return placed

def place_labels(board, fps, texts):
    """Put each part's printed reference beside its part where it covers no
    pad, no other part and no other label. Adds the free board texts too."""
    def box_of(item, grow=0.0):
        bb = item.GetBoundingBox()
        return (pcbnew.ToMM(bb.GetLeft()) - grow, pcbnew.ToMM(bb.GetTop()) - grow,
                pcbnew.ToMM(bb.GetRight()) + grow, pcbnew.ToMM(bb.GetBottom()) + grow)
    def hit(a, b):
        return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
    outline = pcbnew.SHAPE_POLY_SET()
    board.GetBoardPolygonOutlines(outline, True)
    def inside(b):
        return all(outline.Contains(V(x, y)) for x in (b[0] - 0.3, b[2] + 0.3) for y in (b[1] - 0.3, b[3] + 0.3))
    for side in ("F", "B"):
        flipped = side == "B"
        pads = [box_of(p, 0.2) for fp in fps.values() for p in fp.Pads()
                if p.IsOnLayer(pcbnew.B_Cu if flipped else pcbnew.F_Cu)]
        cy = {}
        for ref, fp in fps.items():
            if fp.IsFlipped() == flipped:
                bb = fp.GetCourtyard(pcbnew.B_CrtYd if flipped else pcbnew.F_CrtYd).BBox()
                cy[ref] = tuple(pcbnew.ToMM(v) for v in (bb.GetLeft(), bb.GetTop(), bb.GetRight(), bb.GetBottom()))
        taken = []
        for txt, x, y, size in texts.get(side, []):
            tx = pcbnew.PCB_TEXT(board)
            tx.SetText(txt); tx.SetLayer(pcbnew.B_SilkS if flipped else pcbnew.F_SilkS)
            tx.SetTextSize(V(size, size)); tx.SetTextThickness(MM(size * 0.15)); tx.SetMirrored(flipped)
            tx.SetPosition(V(x, y)); board.Add(tx)
            taken.append(box_of(tx, 0.2))
        # big parts first: they have the fewest free spots
        for ref in sorted(cy, key=lambda r: -(cy[r][2] - cy[r][0]) * (cy[r][3] - cy[r][1])):
            fp = fps[ref]
            rt = fp.Reference()
            rt.SetTextSize(V(0.8, 0.8)); rt.SetTextThickness(MM(0.12)); rt.SetKeepUpright(True)
            rt.SetTextAngleDegrees(0)
            c = cy[ref]
            cx, cyy = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
            spots = [(cx, c[1] - 0.6), (cx, c[3] + 0.6), (c[0] - 0.4, cyy), (c[2] + 0.4, cyy),
                     (c[0], c[1] - 0.6), (c[2], c[1] - 0.6), (c[0], c[3] + 0.6), (c[2], c[3] + 0.6)]
            best = None
            for strict in (True, False):
                for sx, sy in spots:
                    rt.SetPosition(V(sx, sy))
                    bb = rt.GetBoundingBox()
                    w, h = pcbnew.ToMM(bb.GetWidth()), pcbnew.ToMM(bb.GetHeight())
                    # nudge so the text sits fully outside the courtyard on that side
                    if sy < c[1]: sy = c[1] - h / 2 - 0.15
                    elif sy > c[3]: sy = c[3] + h / 2 + 0.15
                    if sx < c[0]: sx = c[0] - w / 2 - 0.15
                    elif sx > c[2]: sx = c[2] + w / 2 + 0.15
                    rt.SetPosition(V(sx, sy))
                    b = box_of(rt, 0.1)
                    if not inside(b) or any(hit(b, p) for p in pads) or any(hit(b, o) for o in taken):
                        continue
                    if strict and any(hit(b, o) for r2, o in cy.items() if r2 != ref):
                        continue
                    best = (sx, sy)
                    break
                if best:
                    break
            if best:
                rt.SetPosition(V(*best)); rt.SetVisible(True)
                taken.append(box_of(rt, 0.1))
            else:
                rt.SetVisible(False)
                print(f"  no room for label {ref}; hidden")

LABELS = {
    "biomap_flipper": {"F": [("BioMapping 2 - Flipper GSR + GPS", 65.2, 41.0, 0.9),
                             ("GPS: keep this side clear of metal", 23.0, 37.5, 0.8),
                             ("CUFFS", 76.0, 23.6, 0.8), ("SAFEBOOT", 12.4, 22.6, 0.8), ("RESET", 38.0, 17.2, 0.8)]},
    "biomap_cardputer": {"B": [("BioMapping 2 - Cardputer GSR + GPS", 17.0, 51.5, 0.9),
                               ("GPS: keep this side clear of metal", 58.0, 51.6, 0.8),
                               ("CUFFS", 4.8, 34.6, 0.8), ("SAFEBOOT", 45.0, 32.6, 0.8),
                               ("RESET", 71.0, 32.2, 0.8), ("5V to 3.3V", 51.0, 6.6, 0.8)]},
}

STITCH = {
    "biomap_flipper": [((1.5, 1.5, 46.0, 50.5), 3.0), ((47.5, 1.5, 78.5, 50.5), 5.0)],
    "biomap_cardputer": [((34.5, 1.5, 82.5, 52.5), 3.0), ((1.5, 1.5, 33.0, 52.5), 5.0)],
}

def main(name, d, dump=False):
    place, outline, tracks, vias, keepouts = BOARDS[name]
    board = pcbnew.BOARD()
    ds = board.GetDesignSettings()
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(MM(SIG)); nc.SetClearance(MM(0.15)); nc.SetViaDiameter(MM(VIA_D)); nc.SetViaDrill(MM(VIA_DRILL))
    fps, nets = load_parts(board, os.path.join(d, name + ".net"), place)
    if dump:
        for ref in sorted(fps):
            fp = fps[ref]
            print(ref, "side", "B" if fp.IsFlipped() else "F")
            for p in sorted(fp.Pads(), key=lambda p: p.GetNumber()):
                pos = p.GetPosition()
                print(f"   {p.GetNumber():>3} {pcbnew.ToMM(pos.x):7.2f} {pcbnew.ToMM(pos.y):7.2f}"
                      f"  {p.GetNetname():16s} size {pcbnew.ToMM(p.GetBoundingBox().GetWidth()):.2f}x{pcbnew.ToMM(p.GetBoundingBox().GetHeight()):.2f}")
            bb = fp.GetCourtyard(pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd).BBox()
            print(f"   courtyard x {pcbnew.ToMM(bb.GetLeft()):.2f}..{pcbnew.ToMM(bb.GetRight()):.2f} "
                  f"y {pcbnew.ToMM(bb.GetTop()):.2f}..{pcbnew.ToMM(bb.GetBottom()):.2f}")
    def add_seg(a, b):
        s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(V(*a)); s.SetEnd(V(*b)); s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1)); board.Add(s)
    def add_arc(c, start, ang):
        s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_ARC)
        s.SetCenter(V(*c)); s.SetStart(V(*start)); s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(ang, pcbnew.DEGREES_T), True)
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1)); board.Add(s)
    outline(add_seg, add_arc)
    add_tracks(board, fps, nets, tracks, vias)
    add_keepouts(board, keepouts)
    n = add_stitching(board, nets, fps, STITCH[name])
    place_labels(board, fps, LABELS[name])
    add_ground(board, nets)
    # the ADS1115's 0.5 mm pitch leaves no room for thermal spokes: join its GND pads solid
    for p in fps["U2"].Pads():
        if p.GetNetname() == "GND":
            p.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    path = os.path.join(d, name + ".kicad_pcb")
    pcbnew.SaveBoard(path, board)
    print(f"saved {path}: {n} stitching vias")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], dump="--dump" in sys.argv)
