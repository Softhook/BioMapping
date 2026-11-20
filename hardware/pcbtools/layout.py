"""Build a placed and hand-routed .kicad_pcb from a KiCad netlist and the
board's layout file (boards/flipper.py, cardputer.py, cardputer_tail.py). Needs KiCad's
Python (pcbnew).

Every part position and every track is written out by hand in the layout
file, so the layout follows the signal path. No autorouter is involved.
Ground is two copper pours (one per side) joined by stitching vias. A small
0.5 V "guard" pour surrounds the amplifier input, so no surface leakage
current can reach it (see add_guard)."""
import math, os
import pcbnew

from .boards import LAYOUTS
from .kicad import load_footprint
from .rules import CLEARANCE, SIG, TEXT, TEXT_LINE, VIA_D, VIA_DRILL
from .sexpr import parse, find

MM = pcbnew.FromMM

def V(x, y):
    return pcbnew.VECTOR2I(MM(x), MM(y))

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
        fp = load_footprint(lib, fpname)
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
            if find(fl, "name")[0][1] in ("Note", "Manufacturer", "MPN", "LCSC"):
                f = pcbnew.PCB_FIELD(fp, pcbnew.FIELD_T_USER, find(fl, "name")[0][1])
                f.SetText(fl[2] if len(fl) > 2 else ""); f.SetVisible(False)
                f.SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
                fp.Add(f)
        for p in fp.Pads():
            k = (ref, p.GetNumber())
            if k in padnet:
                p.SetNet(nets[padnet[k]])
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

def add_ground(board, gnd, guard=None):
    """A ground pour over the whole board on each copper layer, with the
    guard's area cut out, so ground can't fill the gaps the guard leaves
    between wires there."""
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
        if guard and layer == (pcbnew.F_Cu if guard[0] == "F" else pcbnew.B_Cu):
            ol.NewHole()
            for x, y in guard[1]:
                ol.Append(MM(x), MM(y), -1, 0)
        board.Add(z)

def add_guard(board, nets, guard):
    """Copper at the 0.5 V reference around the amplifier input and the cuff
    wire that feeds it. Those wires sit at 0.5 V too, so nothing leaks between
    them and the guard; without it, ground copper 0.3 mm away could leak
    current through flux left on the board (the GPS forbids washing it off),
    and that current would add to the skin reading. Beats the ground pour."""
    if not guard:
        return
    side, pts = guard
    z = pcbnew.ZONE(board)
    z.SetLayer(pcbnew.F_Cu if side == "F" else pcbnew.B_Cu); z.SetNet(nets["REF_0V5"])
    z.SetAssignedPriority(1); z.SetZoneName("0.5 V guard")
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)   # drop pieces walled off by wires
    z.SetLocalClearance(MM(0.3)); z.SetMinThickness(MM(0.25))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    ol = z.Outline(); ol.NewOutline()
    for x, y in pts:
        ol.Append(MM(x), MM(y))
    board.Add(z)

def guard_outline(guard):
    poly = pcbnew.SHAPE_POLY_SET()
    if guard:
        poly.NewOutline()
        for x, y in guard[1]:
            poly.Append(MM(x), MM(y))
    return poly

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def add_stitching(board, nets, fps, pitch_regions, guard=None):
    """GND vias on a grid, skipping anywhere near copper of another net,
    near any part, near the board edge, or inside the 0.5 V guard."""
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
    guarded = guard_outline(guard)
    placed = 0
    for (x1, y1, x2, y2), pitch in pitch_regions:
        y = y1
        while y <= y2 + 1e-6:
            x = x1
            while x <= x2 + 1e-6:
                ok = outline.Contains(V(x, y)) and not (guard and guarded.Contains(V(x, y), -1, MM(1.0)))
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
    pad, no other part and no other label, turned on its side if it fits no
    other way. Adds the free board texts too."""
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
        # each part's printed outline: a label may overlap another part's courtyard
        # when nothing else fits, but never its printed lines
        silk_layer = pcbnew.B_SilkS if flipped else pcbnew.F_SilkS
        silk = [(ref, box_of(g, 0.1)) for ref, fp in fps.items() for g in fp.GraphicalItems()
                if g.GetLayer() == silk_layer]
        taken = []
        for txt, x, y, size in texts.get(side, []):
            tx = pcbnew.PCB_TEXT(board)
            tx.SetText(txt); tx.SetLayer(pcbnew.B_SilkS if flipped else pcbnew.F_SilkS)
            tx.SetTextSize(V(size, size)); tx.SetTextThickness(MM(max(size * 0.15, TEXT_LINE))); tx.SetMirrored(flipped)
            tx.SetPosition(V(x, y)); board.Add(tx)
            taken.append(box_of(tx, 0.2))
        # big parts first: they have the fewest free spots
        for ref in sorted(cy, key=lambda r: -(cy[r][2] - cy[r][0]) * (cy[r][3] - cy[r][1])):
            fp = fps[ref]
            rt = fp.Reference()
            rt.SetTextSize(V(TEXT, TEXT)); rt.SetTextThickness(MM(TEXT_LINE)); rt.SetKeepUpright(True)
            rt.SetTextAngleDegrees(0)
            c = cy[ref]
            cx, cyy = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
            spots = [(cx, c[1] - 0.6), (cx, c[3] + 0.6), (c[0] - 0.4, cyy), (c[2] + 0.4, cyy),
                     (c[0], c[1] - 0.6), (c[2], c[1] - 0.6), (c[0], c[3] + 0.6), (c[2], c[3] + 0.6)]
            best = None
            # flat first; turned on its side only where flat finds no room
            for angle, strict in ((0, True), (0, False), (90, True), (90, False)):
                rt.SetTextAngleDegrees(angle)
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
                    if any(hit(b, o) for r2, o in silk if r2 != ref):
                        continue
                    if strict and any(hit(b, o) for r2, o in cy.items() if r2 != ref):
                        continue
                    best = (sx, sy, angle)
                    break
                if best:
                    break
            if best:
                rt.SetTextAngleDegrees(best[2]); rt.SetPosition(V(best[0], best[1])); rt.SetVisible(True)
                taken.append(box_of(rt, 0.1))
            else:
                rt.SetVisible(False)
                print(f"  no room for label {ref}; hidden")

def new_board(name, net_path):
    """An empty board with the design rules and every part placed, no copper yet."""
    board = pcbnew.BOARD()
    nc = board.GetDesignSettings().m_NetSettings.GetDefaultNetclass()
    nc.SetTrackWidth(MM(SIG)); nc.SetClearance(MM(CLEARANCE)); nc.SetViaDiameter(MM(VIA_D)); nc.SetViaDrill(MM(VIA_DRILL))
    fps, nets = load_parts(board, net_path, LAYOUTS[name].PLACE)
    return board, fps, nets

def dump_parts(fps, refs=()):
    """Print pad positions, nets and courtyard (keep-out) boxes of the named parts (all if none)."""
    for ref in sorted(fps):
        if refs and ref not in refs:
            continue
        fp = fps[ref]
        print(ref, "side", "B" if fp.IsFlipped() else "F")
        for p in sorted(fp.Pads(), key=lambda p: p.GetNumber()):
            pos = p.GetPosition()
            print(f"   {p.GetNumber():>3} {pcbnew.ToMM(pos.x):7.2f} {pcbnew.ToMM(pos.y):7.2f}"
                  f"  {p.GetNetname():16s} size {pcbnew.ToMM(p.GetBoundingBox().GetWidth()):.2f}x{pcbnew.ToMM(p.GetBoundingBox().GetHeight()):.2f}")
        bb = fp.GetCourtyard(pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd).BBox()
        print(f"   courtyard x {pcbnew.ToMM(bb.GetLeft()):.2f}..{pcbnew.ToMM(bb.GetRight()):.2f} "
              f"y {pcbnew.ToMM(bb.GetTop()):.2f}..{pcbnew.ToMM(bb.GetBottom()):.2f}")

def add_outline(board, outline):
    def add_seg(a, b):
        s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(V(*a)); s.SetEnd(V(*b)); s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1)); board.Add(s)
    def add_arc(c, start, ang):
        s = pcbnew.PCB_SHAPE(board); s.SetShape(pcbnew.SHAPE_T_ARC)
        s.SetCenter(V(*c)); s.SetStart(V(*start)); s.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(ang, pcbnew.DEGREES_T), True)
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1)); board.Add(s)
    outline(add_seg, add_arc)

def solid_ground_pads(board):
    """Join these GND pads to the pour with solid copper, not thin spokes:
    the ADS1115 (U2) and the flex tail's landing pads, whose tight pitch
    leaves no room for spokes at the sides, and the GPS (U4), whose antenna
    uses the board's ground, so every ground pad should join it as fully as
    possible."""
    for fp in board.GetFootprints():
        if fp.GetReference() in ("U2", "U4") or str(fp.GetFPID().GetLibItemName()).startswith("FlexTail_Land"):
            for p in fp.Pads():
                if p.GetNetname().lstrip("/") == "GND":
                    p.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)

def add_markings(board, markings):
    """Outlines and notes for the factory on the drawings layer, e.g. where
    the flex tail's stiffener goes: (rectangle (x1, y1, x2, y2), note)."""
    for (x1, y1, x2, y2), note in markings:
        r = pcbnew.PCB_SHAPE(board); r.SetShape(pcbnew.SHAPE_T_RECT)
        r.SetStart(V(x1, y1)); r.SetEnd(V(x2, y2)); r.SetLayer(pcbnew.Dwgs_User); r.SetWidth(MM(0.1))
        board.Add(r)
        t = pcbnew.PCB_TEXT(board)
        t.SetText(note); t.SetLayer(pcbnew.Dwgs_User); t.SetTextSize(V(0.6, 0.6)); t.SetTextThickness(MM(0.09))
        t.SetPosition(V((x1 + x2) / 2, y2 + 1.0)); board.Add(t)

def build(name, net_path, pcb_path):
    """Lay out one board from its netlist and layout file and save it to pcb_path."""
    lay = LAYOUTS[name]
    # Fixed ID seed: an unchanged layout saves as an identical file, so git
    # diffs show only real changes.
    pcbnew.KIID.SeedGenerator(sum(map(ord, name)))
    board, fps, nets = new_board(name, net_path)
    add_outline(board, lay.outline)
    add_tracks(board, fps, nets, lay.TRACKS, lay.VIAS)
    add_keepouts(board, lay.KEEPOUT)
    guard = getattr(lay, "GUARD", None)
    n = add_stitching(board, nets, fps, lay.STITCH, guard)
    place_labels(board, fps, lay.LABELS)
    add_markings(board, getattr(lay, "MARKINGS", []))
    if getattr(lay, "GROUND_POUR", True):  # the flex tail has none: solid copper would stiffen the bend
        add_ground(board, nets["GND"], guard)
    add_guard(board, nets, guard)
    solid_ground_pads(board)
    board.BuildConnectivity()       # the fill needs it to tell connected guard copper from loose pieces
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(pcb_path, board)
    print(f"saved {os.path.relpath(pcb_path)}: {n} stitching vias")
