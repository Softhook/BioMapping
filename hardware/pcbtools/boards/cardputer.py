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
outline() draws the board edge"""
from ..rules import SIG, PWR, TEXT

# y = 0 is the Cardputer's bottom edge (the EXT socket edge). The board is
# exactly the Cardputer's back, 84 x 54 mm. F = face against the Cardputer
# (bare), B = outer face with everything on it. J1 is the row of landing pads
# for the flex tail (cardputer_tail.py), centred on the EXT header (x 42); the
# tail's solder end lies over them from the edge to y 6.2 (the printed lines),
# and each pad runs on past the tail's tip to y 7.2, where the iron can reach it.
#
# The tail delivers the wires in the order this board wants. Left to right:
# GPS serial for the GPS on the left, a second ground, then SDA, SCL, 5 V,
# ground and the ADC's ready line. The regulator sits straight below the 5 V
# pad, and the two I2C wires cross the 5 V wire by passing between the pads of
# the ferrite bead FB1, so nothing runs on the inner face. The regulator's
# 3.3 V leaves it in two branches: down and left to the GPS, and right, under
# the I2C wires, to the GSR circuit. The I2C pull-ups R6/R7 sit between the
# I2C wires and that branch; SDA passes under R7's body, between its pads,
# so R7 can reach SCL above it without a crossing.
PLACE = {
    "J1": (42.0, 4.5, 180, "B"),       # pad 8 (GPS TX) at x 36.75 ... pad 1 (ADC ready) at x 47.25
    "H1": (14, 4, 0, "F"), "H2": (70, 4, 0, "F"),
    # 5 V -> 3.3 V in a column straight below the 5 V pad: filter FB1 (the I2C wires pass
    # between its pads), regulator U3 with its input capacitor C4 below it, output
    # capacitor C5 beside its output pin
    "FB1": (44.25, 9.3, -90, "B"),
    "U3": (45.0, 13.0, 0, "B"), "C4": (42.5, 15.85, 0, "B"),
    "C5": (48.3, 14.9, -90, "B"),
    # I2C pull-ups to 3.3 V (the Cardputer has none on G5/G6), standing upright, 3.3 V pad at
    # the bottom. R7's top pad sits on SCL and SDA runs under its body; R6's top pad sits just
    # under SDA
    "R7": (50.0, 9.57, 90, "B"), "R6": (52.1, 11.11, 90, "B"),
    # GPS on the left half, turned so its serial pins (13, 14) face the tail above, its VCC
    # pin (17) faces the regulator on the right, and its V_IO and backup pins (2, 3) face
    # the free space below. Each capacitor bridges its pin and the GND pad beside it
    "U4": (26.0, 30.0, 90, "B"),
    "C7": (35.1, 27.15, 90, "B"),                  # beside VCC pad 17 and GND pad 16
    "C6": (28.85, 39.1, 0, "B"),                   # under V_IO pad 2 and GND pad 1
    "C8": (25.05, 39.1, 180, "B"),                 # under V_BCKP pad 3 and GND pad 4
    "TP2": (35.4, 30.3, 0, "B"), "TP1": (16.6, 30.0, 0, "B"),   # beside RESET pad 18 and SAFEBOOT pad 8
    # each serial resistor sits at the end that drives its wire: TX just above the GPS's TX
    # pin, RX just below the tail's RX pad
    "R10": (26.0, 19.6, 90, "B"), "R9": (38.25, 9.4, 90, "B"),
    # backup cell charger in a row below the module, the cell itself to its left
    "D1": (31.5, 44.0, 0, "B"), "R8": (27.9, 44.0, 180, "B"),
    "BT1": (22.0, 44.0, 0, "B"),
    # GSR circuit, right to left along the signal: cuffs (right edge) -> R4 -> C2/R5 -> op-amp
    # U1 -> ADC U2 just above it. The cuff socket's opening is 0.75 mm inside the
    # right edge, so nothing sticks out and the plug can be pulled straight off; its tabs keep
    # the 0.5 mm copper-edge gap
    "J2": (78.85, 28.0, 270, "B"),
    "R4": (71.9, 29.0, 180, "B"),                  # in line with the cuff-2 pin
    "R3": (72.6, 24.4, 90, "B"),                   # cuff 1 to ground, just above its pin
    # feedback: C2's input pad level with R4, R5's level with U1 pin 2
    "C2": (68.8, 27.52, 90, "B"), "R5": (66.6, 26.45, 90, "B"),
    "U1": (61.8, 28.0, 180, "B"),
    # 0.5 V bias divider in a column beside the op-amp's bias input (pin 5)
    "R1": (55.4, 32.4, 0, "B"), "R2": (55.4, 29.9, 180, "B"), "C9": (55.4, 27.5, 180, "B"),
    "C1": (58.3, 24.2, 180, "B"),                  # right over the op-amp supply pin 8
    # ADC just above the op-amp: its inputs (pins 4, 5) face right, straight above the
    # op-amp's output and reference; its I2C and supply pins face left, towards the wires
    # coming from the tail. C3 sits under its supply pin 8
    "U2": (59.7, 20.3, 180, "B"), "C3": (54.8, 21.4, 180, "B"),
    # test pads in one row between the ADC and the op-amp: 0.5 V, GSR output, ground;
    # the first two sit on their wires
    "TP4": (61.8, 23.2, 0, "B"), "TP3": (64.28, 23.2, 0, "B"), "TP5": (66.8, 23.2, 0, "B"),
}
TRACKS = [
    # ── 5 V -> 3.3 V: from the tail's 5 V pad straight down to the regulator ──
    ("B", PWR, ["J1.3", "FB1.1"]),
    ("B", PWR, ["FB1.2", (41.55, 10.36), (41.55, 15.85), "C4.1"]),     # down the left of U3
    ("B", PWR, [(41.55, 12.05), "U3.3"]),                              # EN, tied to IN
    ("B", PWR, [(41.55, 13.95), "U3.1"]),                              # IN
    ("B", SIG, ["U3.2", (42.5, 13.0)]),                                # ground pin to its via
    ("B", PWR, ["C4.2", (44.4, 16.95)]),
    ("B", PWR, ["U3.5", "C5.1"]),
    ("B", PWR, ["C5.2", (48.3, 17.0)]),
    # ── GPS: 3.3 V down from the regulator's output pin, then straight across at 45 degrees
    # to VCC (pin 17) through C7 ──
    ("B", PWR, ["U3.5", (46.14, 17.6), (37.0, 26.74), (37.0, 28.1), "C7.1", "U4.17"]),
    ("B", PWR, ["C7.2", "U4.16"]),
    # V_IO (pin 2): on down round the module's bottom-right corner, through C6
    ("B", PWR, [(37.0, 28.1), (37.0, 41.0), (27.9, 41.0), "C6.1", "U4.2"]),
    ("B", PWR, ["C6.2", "U4.1"]),
    # backup cell: charged from the V_IO wire through D1 and R8
    ("B", SIG, [(32.55, 41.0), "D1.2"]),
    ("B", SIG, ["D1.1", "R8.1"]),
    ("B", SIG, ["U4.3", "C8.1", (26.0, 46.03), "BT1.1"]),
    ("B", SIG, ["R8.2", (26.0, 44.0)]),
    ("B", PWR, ["C8.2", "U4.4"]),
    ("B", SIG, ["U4.18", (35.4, 30.0)]),                  # straight into TP2 (which sits 0.3 lower, clear of C7)
    ("B", SIG, ["U4.8", "TP1.1"]),
    # serial: from the two left-hand tail pads to the top of the module, two parallel
    # 45-degree runs, TX outside RX
    ("B", SIG, ["U4.13", "R10.1"]),
    ("B", SIG, ["R10.2", (36.75, 7.94), "J1.8"]),
    ("B", SIG, ["J1.7", "R9.2"]),
    ("B", SIG, ["R9.1", (27.9, 20.66), "U4.14"]),
    # ── I2C: down from the tail, right between FB1's pads, then down to the ADC's left side.
    # SCL above SDA across the top, SDA inside SCL on the way down, so they reach the
    # ADC's pins 10 and 9 without crossing ──
    ("B", SIG, ["J1.4", (42.75, 9.03), (54.6, 9.03), (54.6, 19.3), "U2.10"]),
    ("B", SIG, ["J1.5", (41.25, 9.57), (54.0, 9.57), (54.0, 19.8), "U2.9"]),
    # pull-ups: each top pad up to its I2C wire, each bottom pad down to the GSR's 3.3 V branch
    ("B", SIG, ["R7.2", (50.0, 9.03)]),
    ("B", SIG, ["R7.1", (50.0, 13.95)]),
    ("B", SIG, ["R6.2", (52.1, 9.57)]),
    ("B", SIG, ["R6.1", (52.1, 13.95)]),
    # ── 3V3 to the GSR side: its own branch from C5, right under the I2C wires, then a
    # spine down the left of the GSR circuit ──
    ("B", PWR, ["C5.1", (52.8, 13.95), (52.8, 32.4), "R1.1"]),
    ("B", SIG, ["net:+3V3", (52.8, 20.3), "U2.8"]),                  # ADC supply pin, under SDA
    ("B", SIG, [(55.75, 20.3), "C3.1"]),                              # C3 right under it
    ("B", PWR, ["C3.2", (53.85, 22.75)]),
    ("B", PWR, ["net:+3V3", (52.8, 26.09), "U1.8"]),
    ("B", PWR, ["U1.8", "C1.1"]),                          # C1 right over the op-amp supply pin
    ("B", PWR, ["C1.2", (57.35, 23.05)]),
    # ── GSR signal path ──
    ("B", SIG, ["J2.2", "R4.1"]),                          # cuff 2: straight in
    ("B", SIG, ["J2.1", (72.6, 27.0), "R3.1"]),
    ("B", SIG, ["R3.2", (72.6, 22.2)]),
    ("B", SIG, ["R4.2", "C2.1", (68.24, 29.0), "R5.1", "U1.2"]),   # amplifier input: R4, C2, R5, U1 pin 2
    ("B", SIG, ["C2.2", (68.3, 25.54), "R5.2", (64.28, 25.54)]),   # C2 and R5 back onto the output wire
    ("B", SIG, ["U1.1", "TP3.1", (64.28, 20.8), "U2.4"]),           # GSR straight up to the ADC
    ("B", SIG, ["U1.3", (61.8, 28.64), "U1.6"]),           # 0.5 V reference under the chip
    ("B", SIG, ["U1.6", "U1.7"]),
    ("B", SIG, [(61.8, 28.64), "TP4.1", "U2.5"]),          # ... and straight up to the ADC
    ("B", SIG, ["R1.2", "R2.1", "C9.1"]),                  # bias divider
    ("B", SIG, ["U1.5", "R2.1"]),
    ("B", PWR, ["R2.2", "C9.2"]),
    ("B", PWR, ["U1.4", (64.28, 31.0)]),                   # ground pin to its via, just outside the guard
    ("B", SIG, ["TP5.1", (66.8, 21.6)]),
    # ── ADC ground and the ready line ──
    # ADDR (pin 1) and GND (pin 3) share a via under the chip, leaving the ready pin
    # (pin 2, between them) free to leave sideways
    ("B", SIG, ["U2.1", (60.6, 19.3), (60.6, 20.3)], {"bevel": 0}),   # square: a cut corner nears the ready pin
    ("B", SIG, ["U2.3", (60.6, 20.3)]),
    # the ready line along the top, outside the I2C wires, then across at 45 degrees and down
    # the right of the ADC
    ("B", SIG, ["J1.1", (47.25, 7.6), (55.6, 7.6), (63.4, 15.4), (63.4, 19.8), "U2.2"]),
    # the tail's two ground pads straight down to a via each
    ("B", SIG, ["J1.2", (45.75, 8.0)]),
    ("B", SIG, ["J1.6", (39.75, 8.0)]),
]
VIAS = [
    ("GND", 45.75, 8.0), ("GND", 39.75, 8.0),
    ("GND", 42.5, 13.0), ("GND", 44.4, 16.95), ("GND", 48.3, 17.0),
    ("GND", 60.6, 20.3), ("GND", 53.85, 22.75), ("GND", 57.35, 23.05), ("GND", 54.5, 28.7),
    ("GND", 64.28, 31.0), ("GND", 72.6, 22.2), ("GND", 66.8, 21.6),
    # down the middle of the strip between the two serial wires: the stitching grid misses
    # it, and without a via its ground copper would be dropped as a loose piece
    ("GND", 36.0, 10.625), ("GND", 33.0, 13.625), ("GND", 30.0, 16.625),
]
BEVEL = 0.8

# GPS keep-clear: no tracks on the inner layer near the module, none under it on the outer face
KEEPOUT = [("F", (8.5, 12.5, 43.5, 47.5)), ("B", (20.7, 24.7, 31.3, 35.3))]

# 0.5 V guard: around R4, C2, R5, the input pin U1.2 and the cuff-2 wire and pin,
# including the strip between the two cuff pins. It joins the reference at U1
# pin 3, right beside the input pin. It reaches round the far end of the cuff-2
# pin (between the socket's tabs), so the copper beside the input wire joins the
# copper on its other side; cut off, that part would be dropped as a loose piece.
GUARD = ("B", [(79.5, 34.5), (64.7, 34.5), (64.7, 26.8), (72.0, 26.8), (72.0, 27.4), (79.5, 27.4)])

# a closer grid under the GPS module (u-blox: fill the ground under it with vias)
STITCH = [((22.0, 26.0, 30.0, 34.0), 2.0), ((1.5, 1.5, 49.5, 52.5), 3.0), ((52.5, 1.5, 82.5, 52.5), 5.0)]

# The title block sits in the free space under the GSR circuit, its lines
# between the rows of ground vias (y 36.5, 41.5, 46.5, 51.5).
LABELS = {"B": [("Bio Mapping 2", 66.0, 39.0, 1.8), ("Christian Nold, 2004 - 2026", 66.0, 44.0, 1.2),
                ("rev F  2026-11", 66.0, 49.0, TEXT),
                ("GPS: keep this side clear of metal", 26.0, 51.0, TEXT),
                ("CUFFS", 79.2, 22.4, TEXT), ("BODY <> WORLD", 71.5, 14.0, 1.2), ("SAFEBOOT", 14.0, 33.0, TEXT),
                ("RESET", 37.0, 32.6, TEXT), ("5V to 3.3V", 38.5, 18.6, TEXT),
                ("FLEX TAIL", 55.0, 3.0, TEXT), ("SOLDER HERE", 55.0, 5.0, TEXT)]}


def outline(add_seg, add_arc):
    """The Cardputer's back: 84 x 54 mm, corners rounded so nothing overhangs."""
    r = 3.0
    add_seg((r, 0), (84 - r, 0)); add_arc((84 - r, r), (84 - r, 0), 90)
    add_seg((84, r), (84, 54 - r)); add_arc((84 - r, 54 - r), (84, 54 - r), 90)
    add_seg((84 - r, 54), (r, 54)); add_arc((r, 54 - r), (r, 54), 90)
    add_seg((0, 54 - r), (0, r)); add_arc((r, r), (0, r), 90)
