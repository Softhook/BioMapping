"""Cardputer board layout: where every part sits and how every track runs.

This is the file to edit when moving parts or re-routing; layout.py turns it
into the .kicad_pcb. Units are mm, y points down (KiCad's convention).

PLACE     REF -> (x, y, rotation in degrees, face "F" front or "B" back)
TRACKS    (face, width, points[, {"bevel": mm}]). A point is "REF.pad" or
          (x, y); a leading "net:NAME" names the net when the track starts at
          a bare point.
BEVEL     every square corner at a bare point is cut at 45 degrees, this
          many mm along each side (layout.bevel: never at a pad or a joint,
          at most 45% of a run). A track's own "bevel" overrides it.
VIAS      (net, x, y)
KEEPOUT   (face, (x1, y1, x2, y2)): "GPS keep clear" areas that refuse tracks
GUARD     (face, [(x, y), ...]): 0.5 V guard copper around the amplifier input
STITCH    ((x1, y1, x2, y2), pitch): ground-via grids
LABELS    face -> [(text, x, y, size)] printed on the board
MASK_MARGIN  REF -> mm: solder mask opened this much wider than each pad
outline() draws the board edge"""
from ..rules import SIG, PWR, TEXT

# The board lives inside a printed back case (hardware/case/), where the
# floor of M5Stack's own back used to be. Coordinates are the Cardputer's
# own: x 0..84 along its length, y 0 at the EXT socket edge, as seen from the
# Cardputer's side. The board spans x 2.1..81.9, y 2.1..51.9, with the
# case's big rounded corners at the EXT edge; the case wall stands 0.5 mm
# clear of its edge all round. F = inner face, against the Cardputer's
# battery (bare except the cable socket J1); B = outer face, towards the case
# floor, with everything else on it.
#
# Four holes, all fixed by the Cardputer: H3 and H4 take the case's two long
# screw posts, which stand where M5Stack's back screws in (x 13 and 54.5,
# 18 mm from the EXT edge); the board rests on their ledges. H1 and H2 take
# M2 screws into two shorter posts and hold the board in the case. They sit
# where the inner face has room for a screw head: near the corner on the GPS
# side, and below the headphone socket on the other.
#
# J1, the cable socket, sits on the inner face in the strip between the EXT
# edge and the battery, where M5Stack's back had its Lego tubes (so nothing
# of the Cardputer's comes down that far), with its mouth facing into the
# board. Each pin drops through a via to the outer face. Left to right: the
# GPS pair, ground, 5 V, the I2C pair, ground and the ADC's ready line.
#
# The GPS pair runs left along the top edge to the GPS, 5 V runs left under
# it to the regulator (U3) above the GPS. The regulator's 3.3 V leaves it in
# two branches: down and left to the GPS, and a spine down the left of the
# GSR circuit, passing left of the screw post. The I2C pair and the ready line
# go straight down right of the post; the I2C pair turns left in the channel
# between the post and the ADC (U2) and comes down the ADC's left side, where
# the pull-ups R6/R7 reach across from the spine. SDA passes between R7's
# pads, as it must cross SCL's pull-up to reach the lower pin.
PLACE = {
    "J1": (59.5, 5.4, 0, "F"),          # pin 1 (GPS TX) at x 55.125 ... pin 8 (ready) at x 63.875
    "H1": (6.8, 6.8, 0, "F"), "H2": (75.0, 18.0, 0, "F"),
    "H3": (13.0, 18.0, 0, "F"), "H4": (54.5, 18.0, 0, "F"),
    # 5 V -> 3.3 V in a column above the GPS: filter FB1 (5 V comes in at its top pad),
    # regulator U3 with its input capacitor C4 below it, output capacitor C5 beside its
    # output pin
    "FB1": (44.25, 9.3, -90, "B"),
    "U3": (45.0, 13.0, 0, "B"), "C4": (42.5, 15.85, 0, "B"),
    "C5": (48.3, 14.9, -90, "B"),
    # I2C pull-ups to 3.3 V (the Cardputer has none on G3/G5), lying across from the
    # spine to their wire. SDA runs between R7's pads
    "R6": (51.61, 24.4, 0, "B"), "R7": (51.61, 27.2, 0, "B"),
    # GPS, turned so its serial pins (13, 14) face up towards the cable, its VCC pin
    # (17) faces the regulator on the right, and its V_IO and backup pins (2, 3) face
    # the free space below. Each capacitor bridges its pin and the GND pad beside it
    "U4": (30.5, 33.0, 90, "B"),
    "C7": (39.6, 30.15, 90, "B"),                  # beside VCC pad 17 and GND pad 16
    "C6": (33.35, 42.1, 0, "B"),                   # under V_IO pad 2 and GND pad 1
    "C8": (29.55, 42.1, 180, "B"),                 # under V_BCKP pad 3 and GND pad 4
    "TP2": (39.9, 33.3, 0, "B"), "TP1": (21.1, 33.0, 0, "B"),   # beside RESET pad 18 and SAFEBOOT pad 8
    # a ground pad under each, 1.2 mm apart: tweezers across the pair, or a scope's ground
    "TP7": (39.9, 36.0, 0, "B"), "TP6": (21.1, 35.7, 0, "B"),
    # each serial resistor sits at the end that drives its wire: TX just above the GPS's TX
    # pin, RX just after the cable socket
    "R10": (30.5, 22.6, 90, "B"), "R9": (51.9, 6.55, 0, "B"),
    # backup cell charger in a row below the module, the cell itself to its left
    "D1": (36.0, 47.0, 0, "B"), "R8": (32.4, 47.0, 180, "B"),
    "BT1": (26.5, 47.0, 0, "B"),
    # GSR circuit, right to left along the signal: cuffs (right edge) -> R4 -> C2/R5 -> op-amp
    # U1 -> ADC U2 just above it. The cuff socket's opening is 0.75 mm inside the
    # right edge, behind a window in the case wall; its tabs keep the 0.5 mm copper-edge gap
    "J2": (76.75, 37.0, 270, "B"),
    "R4": (69.8, 38.0, 180, "B"),                  # in line with the cuff-2 pin
    "R3": (70.5, 33.4, 90, "B"),                   # cuff 1 to ground, just above its pin
    # feedback: C2's input pad level with R4, R5's level with U1 pin 2
    "C2": (66.7, 36.52, 90, "B"), "R5": (64.5, 35.45, 90, "B"),
    "U1": (59.7, 37.0, 180, "B"),
    # 0.5 V bias divider in a column beside the op-amp's bias input (pin 5)
    "R1": (53.3, 41.4, 0, "B"), "R2": (53.3, 38.9, 180, "B"), "C9": (53.3, 36.5, 180, "B"),
    "C1": (56.2, 33.2, 180, "B"),                  # right over the op-amp supply pin 8
    # ADC just above the op-amp: its inputs (pins 4, 5) face right, straight above the
    # op-amp's output and reference; its I2C and supply pins face left, towards the
    # spine. C3 sits under its supply pin 8
    "U2": (57.6, 29.3, 180, "B"), "C3": (52.7, 30.4, 180, "B"),
    # test pads in one row between the ADC and the op-amp: 0.5 V, GSR output, ground;
    # the first two sit on their wires
    "TP4": (59.7, 32.2, 0, "B"), "TP3": (62.18, 32.2, 0, "B"), "TP5": (64.7, 32.2, 0, "B"),
    # the ADC's ready line, on its wire on the way down (the only other places to probe it
    # are the ADC's 0.5 mm pins and the cable socket, which is under the battery side)
    "TP8": (63.875, 24.0, 0, "B"),
}
TRACKS = [
    # ── the cable socket's pins (inner face) down to their vias ──
    ("F", SIG, ["J1.1", (55.125, 5.15)]),
    ("F", SIG, ["J1.2", (56.375, 5.15)]),
    ("F", SIG, ["J1.3", (57.625, 5.15)]),
    ("F", PWR, ["J1.4", (58.875, 5.15)]),
    ("F", SIG, ["J1.5", (60.125, 5.15)]),
    ("F", SIG, ["J1.6", (61.375, 5.15)]),
    ("F", SIG, ["J1.7", (62.625, 5.15)]),
    ("F", SIG, ["J1.8", (63.875, 5.15)]),
    # ── 5 V: left under the GPS pair to FB1, then down to the regulator ──
    ("B", PWR, ["net:+5V_EXT", (58.875, 5.15), (58.875, 8.24), "FB1.1"]),
    ("B", PWR, ["FB1.2", (41.55, 10.36), (41.55, 15.85), "C4.1"]),     # down the left of U3
    ("B", PWR, [(41.55, 12.05), "U3.3"]),                              # EN, tied to IN
    ("B", PWR, [(41.55, 13.95), "U3.1"]),                              # IN
    ("B", SIG, ["U3.2", (42.5, 13.0)]),                                # ground pin to its via
    ("B", PWR, ["C4.2", (44.4, 16.95)]),
    ("B", PWR, ["U3.5", "C5.1"]),
    ("B", PWR, ["C5.2", (48.3, 17.0)]),
    # ── GPS: 3.3 V down from the regulator's output pin, across at 45 degrees and down
    # to VCC (pin 17) through C7 ──
    ("B", PWR, ["U3.5", (46.14, 17.6), (41.5, 22.24), (41.5, 31.1), "C7.1", "U4.17"]),
    ("B", PWR, ["C7.2", "U4.16"]),
    # V_IO (pin 2): on down round the module's bottom-right corner, through C6
    ("B", PWR, [(41.5, 31.1), (41.5, 44.0), (32.4, 44.0), "C6.1", "U4.2"]),
    ("B", PWR, ["C6.2", "U4.1"]),
    # backup cell: charged from the V_IO wire through D1 and R8
    ("B", SIG, [(37.05, 44.0), "D1.2"]),
    ("B", SIG, ["D1.1", "R8.1"]),
    ("B", SIG, ["U4.3", "C8.1", (30.5, 49.03), "BT1.1"]),
    ("B", SIG, ["R8.2", (30.5, 47.0)]),
    ("B", PWR, ["C8.2", "U4.4"]),
    ("B", SIG, ["U4.18", (39.9, 33.0)]),                  # straight into TP2 (which sits 0.3 lower, clear of C7)
    ("B", SIG, ["U4.8", "TP1.1"]),
    # serial: from the cable's two left-hand vias along the top edge, then two parallel
    # 45-degree runs down to the top of the module, TX outside RX
    ("B", SIG, ["U4.13", "R10.1"]),
    ("B", SIG, ["R10.2", (30.5, 13.0), (38.35, 5.15), (55.125, 5.15)]),
    ("B", SIG, ["U4.14", (32.4, 14.9), (40.75, 6.55), "R9.1"]),
    ("B", SIG, ["R9.2", (56.375, 6.55), (56.375, 5.15)]),
    # ── I2C: straight down right of the screw post, left along the channel above the ADC,
    # then down its left side. SDA above SCL along the channel and outside it on the way
    # down, so they reach the ADC's pins 9 and 10 without crossing. Each wire steps left
    # by one resistor gap halfway down: R6 reaches SDA above the step, R7 reaches SCL
    # below it, with SDA passing between R7's pads ──
    ("B", SIG, ["net:I2C_SDA", (60.125, 5.15), (60.125, 22.6), (52.52, 22.6), (52.52, 25.4),
                (51.61, 26.31), (51.61, 28.8), "U2.9"]),
    ("B", SIG, ["net:I2C_SCL", (61.375, 5.15), (61.375, 23.3), (53.43, 23.3), (53.43, 25.4),
                (52.52, 26.31), (52.52, 28.3), "U2.10"]),
    # ── 3V3 to the GSR side: a spine from C5 down the left of the screw post and the GSR
    # circuit; the pull-ups' 3.3 V pads sit on it ──
    ("B", PWR, ["C5.1", (49.5, 13.95), (49.5, 21.0), (50.7, 22.2), (50.7, 41.4), "R1.1"]),
    ("B", SIG, ["net:+3V3", (50.7, 29.3), "U2.8"]),                  # ADC supply pin, under SDA
    ("B", SIG, [(53.65, 29.3), "C3.1"]),                              # C3 right under it
    ("B", PWR, ["C3.2", (51.75, 31.75)]),
    ("B", PWR, ["net:+3V3", (50.7, 35.09), "U1.8"]),
    ("B", PWR, ["U1.8", "C1.1"]),                          # C1 right over the op-amp supply pin
    ("B", PWR, ["C1.2", (55.25, 32.05)]),
    # ── GSR signal path ──
    ("B", SIG, ["J2.2", "R4.1"]),                          # cuff 2: straight in
    ("B", SIG, ["J2.1", (70.5, 36.0), "R3.1"]),
    ("B", SIG, ["R3.2", (70.5, 31.2)]),
    ("B", SIG, ["R4.2", "C2.1", (66.14, 38.0), "R5.1", "U1.2"]),   # amplifier input: R4, C2, R5, U1 pin 2
    ("B", SIG, ["C2.2", (66.2, 34.54), "R5.2", (62.18, 34.54)]),   # C2 and R5 back onto the output wire
    ("B", SIG, ["U1.1", "TP3.1", (62.18, 29.8), "U2.4"]),           # GSR straight up to the ADC
    ("B", SIG, ["U1.3", (59.7, 37.64), "U1.6"]),           # 0.5 V reference under the chip
    ("B", SIG, ["U1.6", "U1.7"]),
    ("B", SIG, [(59.7, 37.64), "TP4.1", "U2.5"]),          # ... and straight up to the ADC
    ("B", SIG, ["R1.2", "R2.1", "C9.1"]),                  # bias divider
    ("B", SIG, ["U1.5", "R2.1"]),
    ("B", PWR, ["R2.2", "C9.2"]),
    ("B", PWR, ["U1.4", (62.18, 40.0)]),                   # ground pin to its via, just outside the guard
    ("B", SIG, ["TP5.1", (64.7, 30.6)]),
    # ── ADC ground and the ready line ──
    # ADDR (pin 1) and GND (pin 3) share a via under the chip, leaving the ready pin
    # (pin 2, between them) free to leave sideways
    ("B", SIG, ["U2.1", (58.5, 28.3), (58.5, 29.3)], {"bevel": 0}),   # square: a cut corner nears the ready pin
    ("B", SIG, ["U2.3", (58.5, 29.3)]),
    # the ready line straight down from its via, outside the I2C pair, through TP8, then
    # left into the ADC's right side
    ("B", SIG, ["net:ADC_READY", (63.875, 5.15), "TP8.1", (63.875, 28.8), "U2.2"]),
]
VIAS = [
    # the cable socket's pins, one via each, in front of the pins (under the socket)
    ("GPS_TX_TO_HOST", 55.125, 5.15), ("HOST_TX_TO_GPS", 56.375, 5.15), ("GND", 57.625, 5.15),
    ("+5V_EXT", 58.875, 5.15), ("I2C_SDA", 60.125, 5.15), ("I2C_SCL", 61.375, 5.15),
    ("GND", 62.625, 5.15), ("ADC_READY", 63.875, 5.15),
    ("GND", 42.5, 13.0), ("GND", 44.4, 16.95), ("GND", 48.3, 17.0),
    ("GND", 58.5, 29.3), ("GND", 51.75, 31.75), ("GND", 55.25, 32.05), ("GND", 52.4, 37.7),
    ("GND", 62.18, 40.0), ("GND", 70.5, 31.2), ("GND", 64.7, 30.6),
    # down the middle of the strip between the two serial wires: the stitching grid misses
    # it, and without a via its ground copper would be dropped as a loose piece
    ("GND", 38.9, 6.5), ("GND", 35.9, 9.5), ("GND", 32.9, 12.5), ("GND", 31.45, 18.0),
]
BEVEL = 0.8

# GPS keep-clear: no tracks on the inner layer near the module, none under it on the outer face
KEEPOUT = [("F", (13.0, 15.5, 48.0, 50.5)), ("B", (25.2, 27.7, 35.8, 38.3))]

# 0.5 V guard: around R4, C2, R5, the input pin U1.2 and the cuff-2 wire and pin,
# including the strip between the two cuff pins. It joins the reference at U1
# pin 3, right beside the input pin. It reaches round the far end of the cuff-2
# pin (between the socket's tabs), so the copper beside the input wire joins the
# copper on its other side; cut off, that part would be dropped as a loose piece.
GUARD = ("B", [(77.4, 43.5), (62.6, 43.5), (62.6, 35.8), (69.9, 35.8), (69.9, 36.4), (77.4, 36.4)])

# u-blox's footprint drawing opens the mask 0.05 mm past each GPS pad, so a
# slightly misplaced mask can't cover a pad edge (under the module, a bad
# joint can't be seen or reached)
MASK_MARGIN = {"U4": 0.05}

# a closer grid under the GPS module (u-blox: fill the ground under it with vias)
STITCH = [((26.5, 29.0, 34.5, 37.0), 2.0), ((3.0, 3.0, 49.5, 51.0), 3.0), ((52.5, 1.75, 81.0, 51.0), 5.0)]

# The title sits in the free corner on the GPS side, near the EXT edge; the
# credit line sits in the free space under the GSR circuit, between the rows of
# ground vias (y 46.75 and the edge). The inner face carries the cable's
# wiring, for whoever solders it inside the Cardputer.
# The board's revision, printed on both faces. Change it here whenever the board
# changes.
REV = "G"

LABELS = {"B": [("Bio Mapping 2", 19.0, 9.5, 1.8), (f"Christian Nold, 2004 - 2026  rev {REV}", 64.5, 49.25, TEXT),
                ("GPS: Keep this clear", 13.5, 49.25, TEXT),
                ("CUFFS", 77.1, 31.4, TEXT),
                # each GPS pad's name beside it, on the side away from the module, 0.3 mm
                # clear of its printed outline. RESET stands further off: TP2's own name
                # goes between, as C7, TP7 and the module leave it no other room
                ("SAFEBOOT/PPS", 13.95, 33.0, TEXT), ("GND", 18.1, 35.7, TEXT),
                ("RESET", 47.2, 33.3, TEXT), ("GND", 42.9, 36.0, TEXT),
                ("RDY", 66.5, 24.0, TEXT), ("5V to 3.3V", 37.0, 18.6, TEXT)],
          "F": [(f"Bio Mapping 2 - Cardputer rev {REV}", 18.45, 49.25, TEXT), ("www.biomapping.net", 70.9, 49.25, TEXT),
                ("CABLE TO EXT LEGS", 59.5, 9.25, TEXT),
                ("1 G15  2 G13  3 GND  4 5VO", 59.5, 12.9, TEXT),
                ("5 G5  6 G3  7 GND  8 G4", 59.5, 14.6, TEXT)]}

# The board's edge (the case draws its wall 0.5 mm outside it: hardware/case/):
# big rounded corners on the EXT edge (y 2.1), smaller ones on the keyboard edge,
# following the Cardputer's own shape.
EDGE = dict(x0=2.1, y0=2.1, x1=81.9, y1=51.9, r_ext=5.7, r_kbd=1.0)


def outline(add_seg, add_arc):
    """Inside the case wall: big rounded corners on the EXT edge (y 2.1), small
    ones on the keyboard edge (y 51.9), following the Cardputer's own shape."""
    x0, y0, x1, y1, rt, rb = (EDGE[k] for k in ("x0", "y0", "x1", "y1", "r_ext", "r_kbd"))
    add_seg((x0 + rt, y0), (x1 - rt, y0)); add_arc((x1 - rt, y0 + rt), (x1 - rt, y0), 90)
    add_seg((x1, y0 + rt), (x1, y1 - rb)); add_arc((x1 - rb, y1 - rb), (x1, y1 - rb), 90)
    add_seg((x1 - rb, y1), (x0 + rb, y1)); add_arc((x0 + rb, y1 - rb), (x0 + rb, y1), 90)
    add_seg((x0, y1 - rb), (x0, y0 + rt)); add_arc((x0 + rt, y0 + rt), (x0, y0 + rt), 90)
