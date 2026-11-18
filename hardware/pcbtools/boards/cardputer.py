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
# tail's solder end lies over them from the edge to y 7 (the printed outline).
PLACE = {
    "J1": (42.0, 4.5, 180, "B"),       # pad 1 (5 V) at x 47.25 ... pad 8 (GPS TX) at x 36.75
    "H1": (14, 4, 0, "F"), "H2": (70, 4, 0, "F"),
    # 5 V -> 3.3 V, just right of the tail
    "FB1": (55.9, 2.4, 0, "B"), "C4": (56.5, 6.45, 180, "B"),
    "U3": (61.5, 5.5, 0, "B"), "C5": (64.7, 7.36, -90, "B"),
    # GPS on the right half; serial pads face the header tab
    "U4": (58.0, 30.0, 90, "B"),
    "C7": (68.4, 27.15, 90, "B"),                  # bridges VCC pad 17 and GND pad 16
    "C6": (72.45, 24.0, 0, "B"),
    "TP2": (68.4, 30.3, 0, "B"), "TP1": (47.4, 30.0, 0, "B"),
    "R10": (58.0, 19.0, 90, "B"), "R9": (60.5, 19.0, 90, "B"),
    "D1": (64.4, 44.5, 0, "B"), "R8": (60.4, 44.5, 180, "B"),
    "C8": (56.2, 45.2, 180, "B"), "BT1": (49.8, 45.2, 0, "B"),
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
    "R7": (29.6, 44.4, 90, "B"), "R6": (32.1, 44.4, 90, "B"),     # I2C pull-ups, not fitted here
}
TRACKS = [
    # ── 5 V -> 3.3 V: from the tail's 5 V pad straight across to the regulator ──
    ("B", PWR, ["J1.1", (52.5, 4.5), (52.5, 2.4), "FB1.1"]),
    ("B", PWR, ["FB1.2", (58.0, 2.4), (60.36, 2.4), "U3.3"]),          # EN, from above
    ("B", PWR, [(58.0, 2.4), (58.0, 6.45), "U3.1"]),                   # IN, from the left
    ("B", PWR, [(58.0, 6.45), "C4.1"]),
    ("B", SIG, ["U3.2", (59.1, 5.5)]),
    ("B", PWR, ["U3.5", "C5.1"]),
    # ── GPS ──
    ("B", PWR, ["C5.1", (71.5, 6.41), (71.5, 41.0), (59.9, 41.0), "U4.2"]),
    ("B", PWR, [(71.5, 28.1), "C7.1", "U4.17"]),
    ("B", PWR, ["C7.2", "U4.16"]),
    ("B", PWR, [(71.5, 24.0), "C6.1"]),
    ("B", SIG, ["D1.2", (65.65, 41.0)]),
    ("B", SIG, ["D1.1", "R8.1"]),
    ("B", SIG, ["R8.2", (58.0, 43.0), "U4.3"]),
    ("B", SIG, ["R8.2", "C8.1"]),
    ("B", SIG, ["C8.1", (57.15, 47.23), "BT1.1"]),
    ("B", SIG, ["U4.18", "TP2.1"]),
    ("B", SIG, ["U4.8", "TP1.1"]),
    ("B", SIG, ["U4.13", "R10.1"]),
    ("B", SIG, ["U4.14", (59.9, 21.0), (60.5, 20.4), "R9.1"]),
    ("B", SIG, ["R10.2", (58.0, 14.0), (36.75, 14.0), "J1.8"]),
    ("B", SIG, ["R9.2", (60.5, 12.5), (38.25, 12.5), "J1.7"]),
    # ── 3V3 to the GSR side: inner face under the tail, then down the right of the circuit ──
    ("B", PWR, ["U3.5", (62.64, 8.4)]),
    ("F", PWR, ["net:+3V3", (62.64, 8.4), (33.6, 8.4)]),
    ("B", PWR, ["net:+3V3", (33.6, 8.4), (33.6, 45.31), "R6.1", "R7.1"]),
    ("B", PWR, ["net:+3V3", (33.6, 25.6), "R1.1"]),
    ("B", PWR, ["net:+3V3", (33.6, 31.91), "U1.8"]),
    ("B", PWR, ["U1.8", "C1.1"]),                          # C1 right under the op-amp supply pin
    ("B", PWR, ["C1.2", (26.65, 34.95)]),
    ("B", PWR, ["net:+3V3", (33.6, 37.4), (30.35, 37.4), "C3.1"]),
    ("B", SIG, ["U2.8", (30.35, 39.5), "C3.1"]),                    # ADC supply pin into C3
    ("B", PWR, ["C3.2", (32.4, 40.15)]),
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
    ("B", SIG, ["U2.10", (29.6, 40.5), (29.6, 41.9), "R7.2"]),
    ("B", SIG, ["U2.9", (30.6, 40.0), (30.6, 41.9), "R6.2"]),
    ("F", SIG, ["net:I2C_SCL", (29.6, 41.9), (29.6, 40.5), (30.6, 39.5), (30.6, 10.6), (41.25, 10.6)]),
    ("F", SIG, ["net:I2C_SDA", (30.6, 41.9), (31.6, 40.9), (31.6, 11.6), (44.25, 11.6)]),
    ("B", SIG, ["J1.5", (41.25, 10.6)]),
    ("B", SIG, ["J1.3", (44.25, 11.6)]),
]
VIAS = [
    ("+3V3", 62.64, 8.4), ("+3V3", 33.6, 8.4), ("I2C_SCL", 29.6, 41.9), ("I2C_SDA", 30.6, 41.9),
    ("I2C_SCL", 41.25, 10.6), ("I2C_SDA", 44.25, 11.6),
    ("GND", 59.1, 5.5), ("GND", 54.4, 6.45), ("GND", 64.7, 9.5), ("GND", 74.8, 24.0),
    ("GND", 19.72, 27.0), ("GND", 26.65, 34.95), ("GND", 29.5, 29.3), ("GND", 22.8, 40.0),
    ("GND", 32.4, 40.15), ("GND", 11.4, 35.8), ("GND", 17.2, 36.6),
]
# GPS keep-clear: no tracks on the inner layer near the module, none under it on the outer face
KEEPOUT = [("F", (40.5, 12.5, 75.5, 47.5)), ("B", (52.7, 24.7, 63.3, 35.3))]

# 0.5 V guard: around R4, C2, R5, the input pin U1.2 and the cuff-2 wire to J2.
# It joins the reference at U1 pin 3, right beside the input pin.
GUARD = ("B", [(6.0, 23.5), (19.3, 23.5), (19.3, 31.2), (12.0, 31.2), (12.0, 30.0), (6.0, 30.0)])

STITCH = [((34.5, 1.5, 82.5, 52.5), 3.0), ((1.5, 1.5, 33.0, 52.5), 5.0)]

# The title block sits in the free corner above the GSR circuit, below screw
# hole H1, its lines between the rows of ground vias (y 6.5, 11.5, 16.5, 21.5).
LABELS = {"B": [("Bio Mapping 2", 16.5, 9.0, 1.8), ("Christian Nold, 2004 - 2026", 16.5, 14.0, 1.2),
                ("rev B  2026-11", 16.5, 19.0, TEXT),
                ("GPS: keep this side clear of metal", 58.0, 51.6, TEXT),
                ("CUFFS", 4.8, 35.6, TEXT), ("SAFEBOOT", 45.0, 32.6, TEXT),
                ("RESET", 71.0, 32.2, TEXT), ("5V to 3.3V", 60.5, 11.3, TEXT),
                ("FLEX TAIL: SOLDER HERE", 42.0, 9.0, TEXT)]}


def outline(add_seg, add_arc):
    """The Cardputer's back: 84 x 54 mm, corners rounded so nothing overhangs."""
    r = 3.0
    add_seg((r, 0), (84 - r, 0)); add_arc((84 - r, r), (84 - r, 0), 90)
    add_seg((84, r), (84, 54 - r)); add_arc((84 - r, 54 - r), (84, 54 - r), 90)
    add_seg((84 - r, 54), (r, 54)); add_arc((r, 54 - r), (r, 54), 90)
    add_seg((0, 54 - r), (0, r)); add_arc((r, r), (0, r), 90)
