"""Cardputer board layout: where every part sits and how every track runs.

This is the file to edit when moving parts or re-routing; layout.py turns it
into the .kicad_pcb. Units are mm, y points down (KiCad's convention).

PLACE     REF -> (x, y, rotation in degrees, face "F" front or "B" back)
TRACKS    (face, width, points). A point is "REF.pad" or (x, y); a leading
          "net:NAME" names the net when the track starts at a bare point.
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
PLACE = {
    "J1": (42.0, 4.5, 180, "B"),       # pad 1 (5 V) at x 47.25 ... pad 8 (GPS TX) at x 36.75
    "H1": (14, 4, 0, "F"), "H2": (70, 4, 0, "F"),
    # 5 V -> 3.3 V, in one line to the right of the tail: filter FB1, regulator U3 with its
    # input capacitor C4 under it, output capacitor C5 beside its output pin
    "FB1": (50.7, 4.5, 0, "B"),
    "U3": (57.5, 5.45, 0, "B"), "C4": (55.0, 8.3, 0, "B"),
    "C5": (60.7, 7.35, -90, "B"),
    # GPS on the right half, turned so its VCC pin (17) faces the regulator above it,
    # its serial pins (13, 14) face the tail and its V_IO and backup pins (2, 3) face
    # the free right-hand side. Each capacitor bridges its pin and the GND pad beside it
    "U4": (58.0, 30.0, 180, "B"),
    "C7": (55.15, 20.9, 180, "B"),                 # over VCC pad 17 and GND pad 16
    "C6": (67.1, 27.15, 90, "B"),                  # beside V_IO pad 2 and GND pad 1
    "C8": (67.1, 30.95, -90, "B"),                 # beside V_BCKP pad 3 and GND pad 4
    "TP2": (58.4, 20.6, 0, "B"), "TP1": (58.0, 39.4, 0, "B"),   # over RESET pad 18, under SAFEBOOT pad 8
    # each serial resistor sits at the end that drives its wire: TX at the GPS, RX at the tail
    "R10": (47.6, 30.0, 180, "B"), "R9": (38.25, 10.0, 90, "B"),
    # backup cell charger in a row to the right, the cell itself about 8 mm from the module
    "D1": (71.2, 21.0, 180, "B"), "R8": (74.9, 21.0, 0, "B"),
    "BT1": (77.8, 32.0, 180, "B"),
    # GSR circuit, left to right along the signal: cuffs (left edge) -> R4 -> C2/R5 -> op-amp U1
    # -> ADC U2 below it. The cuff socket's opening is 0.75 mm inside the left edge, so nothing
    # sticks out and the plug can be pulled straight off; its tabs keep the 0.5 mm copper-edge gap
    "J2": (5.15, 30.0, 90, "B"),
    "R4": (12.1, 29.0, 0, "B"),                    # in line with the cuff-2 pin
    "R3": (11.4, 33.6, -90, "B"),                  # cuff 1 to ground, just below its pin
    "C2": (15.2, 30.5, -90, "B"), "R5": (17.4, 31.55, -90, "B"),   # feedback, input pads level with U1 pin 2
    "U1": (22.2, 30.0, 0, "B"),
    # 0.5 V bias divider in a column beside the op-amp's bias input (pin 5)
    "R1": (28.6, 25.6, 180, "B"), "R2": (28.6, 28.1, 0, "B"), "C9": (28.6, 30.5, 0, "B"),
    "C1": (25.7, 33.8, 0, "B"),                    # right under the op-amp supply pin 8
    # ADC turned so its inputs face the op-amp and its I2C pins face away, towards the tail
    "U2": (26.4, 39.5, 0, "B"), "C3": (31.3, 38.9, 0, "B"),       # C3 beside ADC supply pin 8
    # test pads in one row: ground, GSR output, 0.5 V; the last two sit on their wires
    "TP5": (17.2, 35.0, 0, "B"), "TP3": (19.72, 35.0, 0, "B"), "TP4": (22.2, 35.0, 0, "B"),
}
TRACKS = [
    # ── 5 V -> 3.3 V: from the tail's 5 V pad straight across to the regulator ──
    ("B", PWR, ["J1.1", (47.25, 4.5), "FB1.1"]),
    ("B", PWR, ["FB1.2", (54.05, 4.5), "U3.3"]),                      # EN, tied to IN
    ("B", PWR, [(54.05, 4.5), (54.05, 6.4), "U3.1"]),                 # IN
    ("B", PWR, [(54.05, 6.4), "C4.1"]),
    ("B", SIG, ["U3.2", (55.0, 5.45)]),                                # ground pin to its via
    ("B", PWR, ["C4.2", (55.95, 9.5)]),
    ("B", PWR, ["U3.5", "C5.1"]),
    ("B", PWR, ["C5.2", (60.7, 9.45)]),
    # ── GPS: 3.3 V straight down from the regulator to VCC (pin 17) through C7 ──
    ("B", PWR, ["C5.1", (62.8, 6.4), (62.8, 18.0), (56.1, 18.0), "C7.1", "U4.17"]),
    ("B", PWR, ["C7.2", "U4.16"]),
    # V_IO (pin 2): round the module's top-right corner, through C6
    ("B", PWR, [(62.8, 18.0), (69.2, 18.0), (69.2, 28.1), "C6.1", "U4.2"]),
    ("B", PWR, ["C6.2", "U4.1"]),
    # backup cell: charged from the V_IO wire through D1 and R8
    ("B", SIG, [(69.2, 21.0), "D1.2"]),
    ("B", SIG, ["D1.1", "R8.1"]),
    ("B", SIG, ["R8.2", "BT1.1"]),
    ("B", SIG, ["U4.3", "C8.1", "BT1.1"]),
    ("B", PWR, ["C8.2", "U4.4"]),
    ("B", SIG, ["U4.18", "TP2.1"]),
    ("B", SIG, ["U4.8", "TP1.1"]),
    # serial: down the left of the module, inside the wires that leave the tail
    ("B", SIG, ["U4.13", "R10.1"]),
    ("B", SIG, ["R10.2", (44.7, 30.0), (44.7, 14.0), (36.75, 14.0), "J1.8"]),
    ("B", SIG, ["J1.7", "R9.2"]),
    ("B", SIG, ["R9.1", (38.25, 12.5), (46.0, 12.5), (46.0, 28.1), "U4.14"]),
    # ── 3V3 to the GSR side: its own branch from the regulator's output pin, down
    # between U3/C4 and C5, then west. It must cross the serial and I2C wires that
    # come down from the tail, so it hops to the inner face for 13 mm just below
    # the tail, then runs down the right of the GSR circuit, inside the I2C pair ──
    ("B", PWR, ["U3.5", (58.64, 10.9), (46.5, 10.9), (46.5, 8.4)]),
    ("F", PWR, ["net:+3V3", (46.5, 8.4), (33.6, 8.4)]),
    ("B", PWR, ["net:+3V3", (33.6, 8.4), (33.6, 37.4)]),
    ("B", PWR, ["net:+3V3", (33.6, 25.6), "R1.1"]),
    ("B", PWR, ["net:+3V3", (33.6, 31.91), "U1.8"]),
    ("B", PWR, ["U1.8", "C1.1"]),                          # C1 right under the op-amp supply pin
    ("B", PWR, ["C1.2", (26.65, 34.95)]),
    ("B", PWR, ["net:+3V3", (33.6, 37.4), (30.35, 37.4), "C3.1"]),
    ("B", SIG, ["U2.8", (30.35, 39.5), "C3.1"]),                    # ADC supply pin into C3
    ("B", PWR, ["C3.2", (33.3, 38.9)]),
    # ── GSR signal path ──
    ("B", SIG, ["J2.2", "R4.1"]),                          # cuff 2: straight in
    ("B", SIG, ["J2.1", (11.4, 31.0), "R3.1"]),
    ("B", SIG, ["R3.2", (11.4, 35.8)]),
    ("B", SIG, ["R4.2", "C2.1", "R5.1", "U1.2"]),          # amplifier input: R4, C2, R5, U1 pin 2
    ("B", SIG, ["C2.2", "R5.2", "U1.1"]),                  # amplifier output back through C2 and R5
    ("B", SIG, ["U1.1", "TP3.1", (19.72, 39.0), "U2.4"]),           # GSR to the ADC
    ("B", SIG, ["U1.3", (22.2, 29.36), "U1.6"]),           # 0.5 V reference under the chip
    ("B", SIG, ["U1.6", "U1.7"]),
    ("B", SIG, [(22.2, 29.36), "TP4.1", (22.2, 38.5), "U2.5"]),
    ("B", SIG, ["R1.2", "R2.1", "C9.1"]),                  # bias divider
    ("B", SIG, ["U1.5", "R2.1"]),
    ("B", PWR, ["R2.2", "C9.2"]),
    ("B", PWR, ["U1.4", (19.72, 27.0)]),                   # ground pin to its via, just outside the guard
    ("B", SIG, ["TP5.1", (17.2, 36.6)]),
    # ── ADC and I2C ──
    ("B", SIG, ["U2.3", (23.3, 39.5), (22.8, 40.0)]),
    ("B", SIG, ["U2.1", (23.3, 40.5), (22.8, 40.0)]),
    # I2C on the outer face: out of the ADC under C3, then north beside the 3V3 line.
    # Just below the tail it hops to the inner face to pass under the serial wires,
    # and swaps order there (SDA is the inner wire here but the outer pad at the tail)
    ("B", SIG, ["U2.9", (34.7, 40.0), (34.7, 9.4)]),
    ("B", SIG, ["U2.10", (35.5, 40.5), (35.5, 10.6)]),
    ("F", SIG, ["net:I2C_SDA", (34.7, 9.4), (44.25, 9.4)]),
    ("F", SIG, ["net:I2C_SCL", (35.5, 10.6), (41.25, 10.6)]),
    ("B", SIG, ["J1.3", (44.25, 9.4)]),
    ("B", SIG, ["J1.5", (41.25, 10.6)]),
]
VIAS = [
    ("+3V3", 46.5, 8.4), ("+3V3", 33.6, 8.4),
    ("I2C_SDA", 34.7, 9.4), ("I2C_SDA", 44.25, 9.4), ("I2C_SCL", 35.5, 10.6), ("I2C_SCL", 41.25, 10.6),
    ("GND", 55.0, 5.45), ("GND", 55.95, 9.5), ("GND", 60.7, 9.45),
    ("GND", 19.72, 27.0), ("GND", 26.65, 34.95), ("GND", 29.5, 29.3), ("GND", 22.8, 40.0),
    ("GND", 33.3, 38.9), ("GND", 11.4, 35.8), ("GND", 17.2, 36.6),
]
# GPS keep-clear: no tracks on the inner layer near the module, none under it on the outer face
KEEPOUT = [("F", (40.5, 12.5, 75.5, 47.5)), ("B", (52.7, 24.7, 63.3, 35.3))]

# 0.5 V guard: around R4, C2, R5, the input pin U1.2 and the cuff-2 wire and pin,
# including the strip between the two cuff pins. It joins the reference at U1
# pin 3, right beside the input pin. It reaches round the far end of the cuff-2
# pin (between the socket's tabs), so the copper under the input wire joins the
# copper above it; cut off, that lower part would be dropped as a loose piece.
GUARD = ("B", [(4.5, 23.5), (19.3, 23.5), (19.3, 31.2), (12.0, 31.2), (12.0, 30.6), (4.5, 30.6)])

# a closer grid under the GPS module (u-blox: fill the ground under it with vias)
STITCH = [((54.0, 26.0, 62.0, 34.0), 2.0), ((34.5, 1.5, 82.5, 52.5), 3.0), ((1.5, 1.5, 33.0, 52.5), 5.0)]

# The title block sits in the free corner above the GSR circuit, below screw
# hole H1, its lines between the rows of ground vias (y 6.5, 11.5, 16.5, 21.5).
LABELS = {"B": [("Bio Mapping 2", 16.5, 9.0, 1.8), ("Christian Nold, 2004 - 2026", 16.5, 14.0, 1.2),
                ("rev B  2026-11", 16.5, 19.0, TEXT),
                ("GPS: keep this side clear of metal", 58.0, 51.0, TEXT),
                ("CUFFS", 4.8, 35.6, TEXT), ("BODY <> WORLD", 16.5, 46.5, 1.2), ("SAFEBOOT", 58.0, 42.0, TEXT),
                ("RESET", 62.3, 20.6, TEXT), ("5V to 3.3V", 65.0, 10.0, TEXT),
                ("FLEX TAIL: SOLDER HERE", 42.0, 15.8, TEXT)]}


def outline(add_seg, add_arc):
    """The Cardputer's back: 84 x 54 mm, corners rounded so nothing overhangs."""
    r = 3.0
    add_seg((r, 0), (84 - r, 0)); add_arc((84 - r, r), (84 - r, 0), 90)
    add_seg((84, r), (84, 54 - r)); add_arc((84 - r, 54 - r), (84, 54 - r), 90)
    add_seg((84 - r, 54), (r, 54)); add_arc((r, 54 - r), (r, 54), 90)
    add_seg((0, 54 - r), (0, r)); add_arc((r, r), (0, r), 90)
