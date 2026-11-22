"""Ground check (./pcb ground): how far apart the board's ground points move
when current flows through the ground copper. Needs KiCad's Python (pcbnew)
and numpy.

The GSR reading rests on the 0.5 V across the skin, and that 0.5 V lies
between two ground points: the cuff's ground (R3) and the ground under the
bias divider (R2, C9). Current crossing the ground copper between them, from
the GPS for example, adds a small voltage to the 0.5 V and so changes the
reading. This works out how much.

Both copper faces are cut into 0.1 mm squares. Neighbouring squares of
ground copper on one face are joined by the copper's resistance, and each
ground via joins the two faces. The landing pads lead through the flex
tail's ground wires (their resistance worked out from the tail board) and
the EXT header pin to the Cardputer's ground, which is 0 V. A current goes
in at some pads, flows out through the tail, and the voltage of every square
is solved.

Before the board, the same model solves a plain copper strip whose
resistance can be summed by hand, so a fault in the model shows up at once.
--break-test reruns the GPS case on deliberately worse versions of the
board, to show that the model notices a bad ground."""
import math
import os
import subprocess
import sys
import time

import pcbnew

from .kicad import HARDWARE, KICAD_PYTHON, board_file

try:
    import numpy as np
except ImportError:
    np = None

STEP = 0.1                  # mm: size of one square
RS_BOARD = 0.49e-3          # ohms per square of 35 um (1 oz) copper, the usual rigid-board default
RS_FLEX = 0.96e-3           # ohms per square of 18 um copper, the usual flex default
R_VIA = 1.5e-3              # one via: 0.35 mm drill, about 18 um plating, 1.6 mm board
R_JOINT = 0.5e-3            # a tail pad soldered over its landing pad
R_PIN = 0.015               # the EXT header pin in its socket (header makers give 20 mOhm at most)
GPS_A = 0.010               # SAM-M10Q datasheet table 14: 10 mA tracking, 13 mA searching
ADC_NOISE_UV = 7.0          # the ADC's noise per reading, docs/cardputer_gsr_noise_investigation.md
BIAS_V = 0.5                # across skin + R3 + R4

# Per board: which landing pad takes which tail pad, the tail's ground pin,
# and how far up the landing pads the tail's tip reaches (the solder joint).
# breaks: deliberately worse boards for --break-test. "exits_at" moves the
# tail's ground to these outer-face boxes; "cut" removes a strip of ground
# copper from both faces; "no_face" removes a whole face.
SETUP = {
    "biomap_cardputer": {
        "tail": "biomap_cardputer_tail", "exits": {"J1.2": "J2.2", "J1.6": "J2.6"}, "pin": "J1.4",
        "tip_y": 6.2,
        "breaks": [
            ("the Cardputer's ground joined at the cuff end (x 75-77) instead of the middle",
             {"exits_at": [(75.05, 2.0, 75.95, 6.0), (76.55, 2.0, 77.45, 6.0)]}),
            ("both faces cut along y 12 from the left edge to x 50, so the GPS current has to "
             "go round past the GSR circuit", {"cut": (0.0, 11.85, 50.0, 12.15)}),
            ("no inner face at all", {"no_face": "F"}),
        ],
    },
}

mm, MM = pcbnew.ToMM, pcbnew.FromMM
LAYERS = (pcbnew.F_Cu, pcbnew.B_Cu)


def ohms(value):
    """A part's value as a number: '56k 0.1%' -> 56000.0, '10uF' -> 1e-05."""
    v = value.split()[0].rstrip("FΩ")
    scale = {"k": 1e3, "M": 1e6, "m": 1e-3, "u": 1e-6, "n": 1e-9, "p": 1e-12}
    return float(v[:-1]) * scale[v[-1]] if v[-1] in scale else float(v)


# ── copper as squares ──

class Grid:
    def __init__(self, width, height):
        self.nx, self.ny = int(round(width / STEP)), int(round(height / STEP))
        self.n = self.nx * self.ny
        self.xc = (np.arange(self.nx) + 0.5) * STEP
        self.yc = (np.arange(self.ny) + 0.5) * STEP

    def empty(self):
        return np.zeros((self.ny, self.nx), bool)

    def raster(self, poly, mask):
        """Add a SHAPE_POLY_SET to mask: each square whose centre lies inside."""
        for i in range(poly.OutlineCount()):
            rings = [poly.Outline(i)] + [poly.Hole(i, h) for h in range(poly.HoleCount(i))]
            edges = []
            for ch in rings:
                pts = np.array([(mm(ch.CPoint(k).x), mm(ch.CPoint(k).y)) for k in range(ch.PointCount())])
                edges.append(np.column_stack([pts, np.roll(pts, -1, 0)]))
            x1, y1, x2, y2 = np.concatenate(edges).T
            rows = np.where((self.yc >= min(y1.min(), y2.min())) & (self.yc <= max(y1.max(), y2.max())))[0]
            if not len(rows):
                continue
            y = self.yc[rows][:, None]
            cross = ((y1 <= y) & (y < y2)) | ((y2 <= y) & (y < y1))
            with np.errstate(divide="ignore", invalid="ignore"):
                xs = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            for r, row in enumerate(rows):
                xr = np.sort(xs[r][cross[r]])
                for a, b in zip(xr[0::2], xr[1::2]):       # inside between each pair of crossings
                    j0, j1 = int(np.ceil(a / STEP - 0.5)), int(np.floor(b / STEP - 0.5))
                    if j1 >= j0:
                        mask[row, max(j0, 0):min(j1, self.nx - 1) + 1] = True


def shape(item, layer):
    p = pcbnew.SHAPE_POLY_SET()
    item.TransformShapeToPolygon(p, layer, 0, MM(0.005), pcbnew.ERROR_INSIDE)
    return p


class Copper:
    """The ground copper of a saved board: a grid of squares per face (index 0
    inner/F, 1 outer/B), the ground vias, and the squares of every ground pad
    as indices into both faces' squares laid end to end."""

    def __init__(self, path):
        b = self.board = pcbnew.LoadBoard(path)
        bb = b.GetBoardEdgesBoundingBox()
        self.grid = g = Grid(mm(bb.GetRight()), mm(bb.GetBottom()))
        self.faces = np.zeros((2, g.ny, g.nx), bool)
        for z in b.Zones():
            if not z.GetIsRuleArea() and z.GetNetname() == "GND":
                for li, L in enumerate(LAYERS):
                    if z.IsOnLayer(L):
                        g.raster(z.GetFilledPolysList(L), self.faces[li])
        self.vias = []
        for t in b.GetTracks():
            if t.GetNetname() != "GND":
                continue
            if t.GetClass() == "PCB_VIA":
                self.vias.append((mm(t.GetPosition().x), mm(t.GetPosition().y)))
            for li, L in enumerate(LAYERS):
                if t.IsOnLayer(L):
                    g.raster(shape(t, L), self.faces[li])
        self.pads, self.parts = {}, {}
        for fp in b.GetFootprints():
            self.parts[fp.GetReference()] = fp
            for p in fp.Pads():
                if p.GetNetname() != "GND":
                    continue
                cells = []
                for li, L in enumerate(LAYERS):
                    if p.IsOnLayer(L):
                        m = g.empty(); g.raster(shape(p, L), m)
                        self.faces[li] |= m
                        cells.append(li * g.n + np.flatnonzero(m.ravel()))
                self.pads[f"{fp.GetReference()}.{p.GetNumber()}"] = np.concatenate(cells)

    def value(self, ref):
        return ohms(self.parts[ref].GetValue())


# ── the resistor network and its solver ──

class Network:
    """Squares joined to their neighbours, vias joining the faces, and each
    exit (squares, wire resistance) leading to the header pin, which is joined
    to 0 V through R_PIN. Unknowns: every square of both faces, then one per
    exit, then the pin."""

    def __init__(self, grid, faces, vias, exits):
        self.grid, self.faces = grid, faces
        n = grid.n
        g = 1.0 / RS_BOARD
        self.links = [(g * (m[:, :-1] & m[:, 1:]), g * (m[:-1, :] & m[1:, :])) for m in faces]
        fi, gv = [], []
        for x, y in vias:
            j0, j1 = int((x - 0.3) / STEP), int((x + 0.3) / STEP) + 1
            i0, i1 = int((y - 0.3) / STEP), int((y + 0.3) / STEP) + 1
            under = [i * grid.nx + j for i in range(max(i0, 0), min(i1, grid.ny)) for j in range(max(j0, 0), min(j1, grid.nx))
                     if math.hypot(grid.xc[j] - x, grid.yc[i] - y) <= 0.2 and faces[0].flat[i * grid.nx + j]
                     and faces[1].flat[i * grid.nx + j]]
            if under:                   # a via with copper missing on one face joins nothing
                fi += under; gv += [1.0 / R_VIA / len(under)] * len(under)
        self.vf, self.vg = np.array(fi, int), np.array(gv, float)
        self.exits = [(np.asarray(c, int), 1.0 / R_JOINT / max(len(c), 1), 1.0 / r) for c, r in exits]
        self.size = 2 * n + len(self.exits) + 1
        self.pin = self.size - 1
        self.diag = self._diagonal()

    def _diagonal(self):
        n = self.grid.n
        d = np.zeros(self.size)
        for li, (gx, gy) in enumerate(self.links):
            f = np.zeros(self.faces[li].shape)
            f[:, :-1] += gx; f[:, 1:] += gx; f[:-1, :] += gy; f[1:, :] += gy
            d[li * n:(li + 1) * n] = f.ravel()
        d[self.vf] += self.vg; d[n + self.vf] += self.vg
        for k, (cells, gc, gw) in enumerate(self.exits):
            d[cells] += gc
            d[2 * n + k] = gc * len(cells) + gw
            d[self.pin] += gw
        d[self.pin] += 1.0 / R_PIN
        d[d == 0] = 1.0                       # squares without copper: left at 0
        return d

    def apply(self, v):
        n = self.grid.n
        out = np.zeros_like(v)
        for li, (gx, gy) in enumerate(self.links):
            X = v[li * n:(li + 1) * n].reshape(self.faces[li].shape)
            O = out[li * n:(li + 1) * n].reshape(X.shape)
            d = gx * (X[:, :-1] - X[:, 1:]); O[:, :-1] += d; O[:, 1:] -= d
            d = gy * (X[:-1, :] - X[1:, :]); O[:-1, :] += d; O[1:, :] -= d
            O[~self.faces[li]] += X[~self.faces[li]]
        d = self.vg * (v[self.vf] - v[n + self.vf])
        out[self.vf] += d; out[n + self.vf] -= d
        for k, (cells, gc, gw) in enumerate(self.exits):
            e = 2 * n + k
            d = gc * (v[cells] - v[e])
            out[cells] += d
            out[e] += -d.sum() + gw * (v[e] - v[self.pin])
            out[self.pin] += gw * (v[self.pin] - v[e])
        out[self.pin] += v[self.pin] / R_PIN
        return out

    def solve(self, currents, tol=1e-10):
        """Voltages for the given current into each unknown (conjugate
        gradients, each unknown scaled by its own diagonal)."""
        with np.errstate(all="ignore"):       # numpy's Mac maths library raises false alarms in dot products
            x = np.zeros(self.size); r = currents.astype(float); z = r / self.diag; p = z.copy()
            rz, target = np.dot(r, z), tol * np.linalg.norm(currents)
            for _ in range(50000):
                Ap = self.apply(p)
                a = rz / np.dot(p, Ap)
                x += a * p; r -= a * Ap
                if np.linalg.norm(r) < target:
                    return x
                z = r / self.diag
                rz, old = np.dot(r, z), rz
                p = z + (rz / old) * p
        sys.exit("ground model: the solver did not settle")


def strip_check():
    """A 10 x 1 mm strip of outer-face copper, current in at one end and out
    through an exit at the other: returns (model, hand sum) in ohms."""
    g = Grid(30, 20)
    faces = np.zeros((2, g.ny, g.nx), bool)
    faces[1, 100:110, 100:200] = True
    col = lambda j: g.n + np.arange(100, 110) * g.nx + j
    wire = 0.03
    net = Network(g, faces, [], [(col(100), wire)])
    cur = np.zeros(net.size); cur[col(199)] = 1.0 / 10
    v = net.solve(cur)
    return v[col(199)].mean(), 99 * RS_BOARD / 10 + R_JOINT + wire + R_PIN


# ── the flex tail's ground wires ──

def tail_wires(setup):
    """Resistance of each tail ground wire, from its tail pad to the header's
    ground pin, following the tail board's tracks. Returns {landing pad: ohms}."""
    b = pcbnew.LoadBoard(board_file(setup["tail"], ".kicad_pcb"))
    pads = {f"{fp.GetReference()}.{p.GetNumber()}": p for fp in b.GetFootprints() for p in fp.Pads()}
    end = pads[setup["pin"]].GetPosition()
    end = (end.x, end.y)
    tracks = [((t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y), mm(t.GetLength()) / mm(t.GetWidth()))
              for t in b.GetTracks() if t.GetClass() == "PCB_TRACK" and t.GetNetname() == "GND"]
    out = {}
    for land, tail_pad in setup["exits"].items():
        at = pads[tail_pad].GetPosition(); at = (at.x, at.y)
        used, squares = set(), 0.0
        while at != end:
            k = next((k for k, (s, e, _) in enumerate(tracks) if k not in used and at in (s, e)), None)
            if k is None:
                sys.exit(f"ground model: can't follow the tail's ground wire from {tail_pad} to {setup['pin']}")
            s, e, sq = tracks[k]
            used.add(k); squares += sq; at = e if at == s else s
        out[land] = squares * RS_FLEX
    return out


# ── the check ──

class Case:
    def __init__(self, copper, setup, wires):
        self.c, self.setup, self.wires = copper, setup, wires
        r1, r2 = copper.value("R1"), copper.value("R2")
        self.k = r2 / (r1 + r2)                               # share of 3.3 V at the bias point
        self.r34 = copper.value("R3") + copper.value("R4")
        self.corner = 1 / (2 * math.pi * (r1 * r2 / (r1 + r2)) * copper.value("C9"))

    def exits(self, faces, boxes=None):
        g = self.c.grid
        if boxes:                       # a deliberately moved exit: outer-face copper in each box
            X, Y = np.meshgrid(g.xc, g.yc)
            return [(g.n + np.flatnonzero((faces[1] & (X > x1) & (X < x2) & (Y > y1) & (Y < y2)).ravel()),
                     r) for (x1, y1, x2, y2), r in zip(boxes, self.wires.values())]
        out = []
        for land, r in self.wires.items():
            cells = self.c.pads[land]
            ys = g.yc[(cells % g.n) // g.nx]
            out.append((cells[ys <= self.setup["tip_y"]], r))
        return out

    def run(self, sources, faces=None, boxes=None):
        """sources: [(pads, amps)], each current shared equally between its pads.
        Returns (all voltages, {pad: mean voltage or None if cut off})."""
        faces = self.c.faces if faces is None else faces
        net = Network(self.c.grid, faces, self.c.vias, self.exits(faces, boxes))
        cur = np.zeros(net.size)
        for pads, amps in sources:
            for p in pads:
                cells = self.c.pads[p]
                cur[cells] += amps / len(pads) / len(cells)
        v = net.solve(cur)
        at = {}
        for p in ("R3.2", "R2.2", "C9.2", "U3.2"):
            vals = v[self.c.pads[p]]
            at[p] = None if not vals.any() else vals.mean()   # 0 V exactly: nothing joins it to ground
        return v, at

    def error(self, at):
        """Error in the 0.5 V across the skin (V): for slow changes, the bias
        point follows R2's ground (and, by its share, the regulator's ground,
        which 3.3 V rides on); for changes faster than C9's corner, C9 holds
        it to C9's ground. Both are measured against the cuff's ground, R3."""
        slow = (1 - self.k) * at["R2.2"] + self.k * at["U3.2"] - at["R3.2"]
        fast = at["C9.2"] - at["R3.2"]
        return slow, fast

    def describe(self, at):
        cut = [p for p, x in at.items() if x is None]
        if cut:
            print(f"    cut off from ground: {', '.join(cut)}")
            return None
        slow, fast = self.error(at)
        worst = max(abs(slow), abs(fast))
        print(f"    cuff ground (R3) {1e6 * at['R3.2']:.1f} uV, bias ground (R2) {1e6 * at['R2.2']:.1f} uV "
              f"above the Cardputer's ground pin")
        print(f"    error in the 0.5 V across the skin: {1e6 * slow:+.2f} uV for slow changes, "
              f"{1e6 * fast:+.2f} uV for changes faster than {self.corner:.0f} Hz")
        for name, r in (("a 47k resistor", 47e3), ("200k skin", 200e3)):
            print(f"      = {1e9 / r * worst / BIAS_V * (1 + self.r34 / r):.3f} nS on {name} ({1e9 / r:.0f} nS)")
        print(f"      the ADC's own noise is about {ADC_NOISE_UV:.0f} uV per reading: "
              f"{ADC_NOISE_UV / max(1e6 * worst, 1e-3):.0f} times this")
        return worst


def picture(path, copper, v, case_name):
    """Both faces coloured by voltage, 10 steps, inner face on top, both as
    KiCad shows them (from the inner face's side). Needs ImageMagick."""
    g = copper.grid
    faces = [v[li * g.n:(li + 1) * g.n].reshape(g.ny, g.nx) for li in (0, 1)]
    live = np.concatenate([f[m & (f != 0)] for f, m in zip(faces, copper.faces)])
    lo, hi = live.min(), live.max()
    ramp = np.array([[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]], float)

    def colour(X, m):
        t = (np.floor(np.clip((X - lo) / (hi - lo), 0, 0.999) * 10) + 0.5) / 10 * (len(ramp) - 1)
        k = np.minimum(t.astype(int), len(ramp) - 2); f = (t - k)[..., None]
        rgb = ramp[k] * (1 - f) + ramp[k + 1] * f
        rgb[m & (X == 0)] = (150, 150, 150)               # copper joined to nothing
        rgb[~m] = (235, 235, 235)
        return rgb.astype(np.uint8)

    white = lambda h: np.full((h, g.nx, 3), 255, np.uint8)
    bar = colour(np.tile(np.linspace(lo, hi, g.nx), (30, 1)), np.ones((30, g.nx), bool))
    img = np.concatenate([white(50), colour(faces[0], copper.faces[0]), white(50),
                          colour(faces[1], copper.faces[1]), white(30), bar, white(40)])
    ppm = path + ".ppm"
    with open(ppm, "wb") as f:
        f.write(b"P6 %d %d 255\n" % (img.shape[1], img.shape[0])); f.write(img.tobytes())
    step = (hi - lo) / 10 * 1e6
    text = [("black", 10, 35, "Inner face (against the Cardputer), as KiCad shows it"),
            ("black", 10, 50 + g.ny + 35, "Outer face (the parts)"),
            ("black", 10, img.shape[0] - 12, f"{1e6 * lo:.0f} uV"),
            ("black", g.nx - 80, img.shape[0] - 12, f"{1e6 * hi:.0f} uV"),
            ("black", g.nx // 4, img.shape[0] - 12, f"{case_name}: each colour step {step:.1f} uV")]
    for ref, label in (("U4", "GPS"), ("U1", "GSR")):
        if ref in copper.parts:
            pos = copper.parts[ref].GetPosition()
            x, y = int(mm(pos.x) / STEP) - 20, int(mm(pos.y) / STEP)
            text += [("white", x, 50 + y, label), ("white", x, 100 + g.ny + y, label)]
    args = ["magick", ppm]
    font = "/System/Library/Fonts/Helvetica.ttc"
    if os.path.exists(font):
        args += ["-font", font, "-pointsize", "22"]
        for fill, x, y, s in text:
            args += ["-fill", fill, "-annotate", f"+{x}+{y}", s]
    subprocess.run(args + [path], check=True)
    os.remove(ppm)
    print(f"  picture: {os.path.relpath(path)}")


def check(name, pictures=False, breaks=False):
    """Run the ground check on one board. Returns the number of problems: a
    model that fails its strip check, or a GSR ground point cut off."""
    if np is None:
        sys.exit(f"./pcb ground needs numpy for KiCad's Python:\n  {KICAD_PYTHON} -m pip install --user numpy")
    if name not in SETUP:
        sys.exit(f"the ground check is set up for {', '.join(SETUP)} only")
    setup, problems = SETUP[name], 0
    print(name)
    model, hand = strip_check()
    ok = abs(model - hand) < 1e-3 * hand
    problems += not ok
    print(f"  model check: a 10 x 1 mm copper strip comes out {1e3 * model:.3f} mOhm, "
          f"summed by hand {1e3 * hand:.3f} mOhm{'' if ok else '  <- MODEL FAULT'}")

    c = Copper(board_file(name, ".kicad_pcb"))
    g = c.grid
    describe_copper(c)

    wires = tail_wires(setup)
    case = Case(c, setup, wires)
    gps = [p for p in c.pads if p.startswith("U4.")]
    adc_amps = 3.3 / c.value("R6")
    print("  (each case takes about a minute)")
    t = time.time()
    v, at = case.run([(gps, GPS_A)])
    print(f"  GPS drawing {1e3 * GPS_A:.0f} mA ({time.time() - t:.0f} s):")
    base = case.describe(at)
    problems += base is None
    if base is not None:
        r = " and ".join(f"{1e3 * x:.0f}" for x in wires.values())
        print(f"    the whole board sits {1e3 * at['R3.2']:.2f} mV above the Cardputer's ground: "
              f"tail ground wires {r} mOhm, header pin {1e3 * R_PIN:.0f} mOhm")
    if pictures:
        os.makedirs(os.path.join(HARDWARE, "out"), exist_ok=True)
        picture(os.path.join(HARDWARE, "out", f"{name}_ground.png"), c, v, f"GPS drawing {1e3 * GPS_A:.0f} mA")
    t = time.time()
    _, at = case.run([(["U2.3"], adc_amps)])
    print(f"  ADC holding SDA low against its pull-up, {1e3 * adc_amps:.1f} mA ({time.time() - t:.0f} s):")
    problems += case.describe(at) is None

    if breaks and base is not None:
        print("  break test: the GPS case again on deliberately worse boards")
        for label, change in setup["breaks"]:
            faces = c.faces.copy()
            if "cut" in change:
                x1, y1, x2, y2 = change["cut"]
                X, Y = np.meshgrid(g.xc, g.yc)
                faces[:, (X > x1) & (X < x2) & (Y > y1) & (Y < y2)] = False
            if "no_face" in change:
                faces[{"F": 0, "B": 1}[change["no_face"]]] = False
            print(f"   {label}:")
            _, at = case.run([(gps, GPS_A)], faces, change.get("exits_at"))
            worst = case.describe(at)
            if worst is not None:
                print(f"    = {worst / base:.1f} times the real board")
    return problems


def describe_copper(c):
    """Pieces of ground on each face, wires with no ground under them, and the
    farthest point from a ground via."""
    b, g = c.board, c.grid
    vec = lambda x, y: pcbnew.VECTOR2I(MM(float(x)), MM(float(y)))
    for li, (L, label) in enumerate(zip(LAYERS, ("inner face", "outer face"))):
        z = next((z for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() == "GND" and z.IsOnLayer(L)), None)
        if z is None:
            continue
        p = pcbnew.SHAPE_POLY_SET(z.GetFilledPolysList(L)); p.Unfracture()
        pieces = []
        for i in range(p.OutlineCount()):
            one = pcbnew.SHAPE_POLY_SET(); one.AddOutline(p.Outline(i))
            for h in range(p.HoleCount(i)):
                one.AddHole(p.Hole(i, h))
            pieces.append((one.Area() / 1e12, sum(one.Contains(vec(x, y)) for x, y in c.vias), p.HoleCount(i)))
        pieces.sort(reverse=True)
        print(f"  {label} ({b.GetLayerName(L)}): {len(pieces)} piece{'s' * (len(pieces) > 1)} of ground: "
              + ", ".join(f"{a:.1f} mm2 with {n} via{'s' * (n != 1)}" for a, n, _ in pieces)
              + (f"; holes in the largest: {pieces[0][2]}" if pieces else ""))
    # parts sit on the face with most footprints; its wires need ground under them on the other face
    on_b = sum(fp.IsFlipped() for fp in b.GetFootprints()) > len(b.GetFootprints()) / 2
    wire_layer, other = (pcbnew.B_Cu, c.faces[0]) if on_b else (pcbnew.F_Cu, c.faces[1])
    bare = set()
    for t in b.GetTracks():
        if t.GetClass() != "PCB_TRACK" or t.GetNetname() == "GND" or t.GetLayer() != wire_layer:
            continue
        s, e = t.GetStart(), t.GetEnd()
        for u in np.linspace(0, 1, max(2, int(mm(t.GetLength()) / 0.05))):
            x, y = mm(s.x) + u * (mm(e.x) - mm(s.x)), mm(s.y) + u * (mm(e.y) - mm(s.y))
            if not other[min(int(y / STEP), g.ny - 1), min(int(x / STEP), g.nx - 1)]:
                bare.add(t.GetNetname().lstrip("/"))
    print(f"  wires with no ground under them on the other face: {', '.join(sorted(bare)) or 'none'}")
    outline = pcbnew.SHAPE_POLY_SET(); b.GetBoardPolygonOutlines(outline, True)
    inside = g.empty(); g.raster(outline, inside)
    X, Y = np.meshgrid(g.xc, g.yc)
    far = np.full(inside.shape, np.inf)
    for x, y in c.vias:
        far = np.minimum(far, np.hypot(X - x, Y - y))
    far[~inside] = 0
    i, j = np.unravel_index(np.argmax(far), far.shape)
    print(f"  farthest point on the board from a ground via: {far[i, j]:.1f} mm, at ({g.xc[j]:.1f}, {g.yc[i]:.1f})")
