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
from ..rules import SIG, PWR

# y = 0 is the Cardputer's bottom edge (EXT socket edge). The board covers
# the back (y 0..54) plus a tab (y < 0) holding the angled header. F = face
# against the Cardputer (only the header), B = outer face with everything else.
PLACE = {
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
    "C8": (56.2, 45.2, 180, "B"), "BT1": (49.8, 45.2, 0, "B"),
    # GSR circuit: the Flipper layout mirrored (x -> 82 - x, y -> y + 12), cuffs on the left edge.
    # The cuff socket is the exception: its opening is 0.75 mm inside the left edge, so nothing
    # sticks out and the plug can be pulled straight off; its tabs keep the 0.5 mm copper-edge gap
    "J2": (5.15, 30.0, 90, "B"),
    "R4": (14.4, 26.0, 0, "B"), "R3": (14.4, 35.0, 0, "B"),
    "R5": (16.4, 31.3, -90, "B"), "C2": (14.1, 31.3, -90, "B"),
    "U1": (22.0, 30.0, 0, "B"),
    "R1": (28.4, 25.6, 180, "B"), "R2": (28.4, 28.1, 0, "B"), "C1": (26.0, 33.6, 0, "B"),
    "C9": (28.4, 30.4, 0, "B"),                    # right under R2, across it
    "U2": (22.0, 39.0, -90, "B"), "C3": (22.7, 43.9, -90, "B"),    # right under ADC supply pin 8
    # test pads: GSR output and ground side by side, 0.5 V beside the ADC
    "TP3": (17.8, 35.0, 0, "B"), "TP5": (17.8, 37.4, 0, "B"), "TP4": (25.0, 38.0, 0, "B"),
    "R6": (17.5, 45.0, 90, "B"), "R7": (15.0, 45.0, 90, "B"),
}
TRACKS = [
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
    ("B", SIG, ["C8.1", (57.15, 47.23), "BT1.1"]),
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
    ("B", PWR, ["net:+3V3", (33.0, 31.91), "U1.8"]),
    ("B", PWR, ["U1.8", (25.05, 31.91), "C1.1"]),          # C1 right under the op-amp supply pin
    ("B", PWR, ["C1.2", (28.15, 33.6)]),
    ("B", PWR, ["net:+3V3", (33.0, 42.95), "C3.1"]),
    ("B", SIG, ["U2.8", (22.0, 42.95), "C3.1"]),
    ("B", PWR, ["C3.2", (22.7, 45.95)]),
    ("B", SIG, ["R6.1", (17.5, 47.5)]),
    # ── GSR signal path ──
    ("B", SIG, ["J2.2", (12.4, 29.0), (12.4, 27.4), "R4.1"]),
    ("B", SIG, ["J2.1", (12.4, 31.0), (12.4, 33.6), "R3.1"]),
    ("B", SIG, ["R4.2", (15.31, 28.0), "C2.1"]),
    ("B", SIG, ["C2.1", "R5.1", (18.5, 30.39), "U1.2"]),
    ("B", SIG, ["U1.1", (17.8, 31.91), (17.5, 32.21), "R5.2", "C2.2"]),
    ("B", SIG, [(17.8, 31.91), (17.8, 33.5), (22.5, 33.5), "U2.4"]),
    ("B", SIG, ["U1.3", "U1.6"]),
    ("B", SIG, ["U1.6", "U1.7"]),
    ("B", SIG, [(23.0, 29.36), "U2.5"]),
    ("B", SIG, ["R1.2", "R2.1", "U1.5"]),
    ("B", SIG, ["R2.1", "C9.1"]),
    ("B", PWR, ["R2.2", "C9.2"]),
    ("B", PWR, ["U1.4", (19.52, 27.0)]),                   # ground pin to its via, just outside the guard
    ("B", SIG, [(17.8, 33.5), "TP3.1"]),
    ("B", SIG, [(23.0, 35.2), (25.0, 35.2), "TP4.1"]),
    # ── ADC and I2C ──
    ("B", SIG, ["U2.3", (22.0, 35.4), (19.7, 35.4)]),
    ("B", SIG, ["U2.1", (21.0, 35.4)]),
    ("B", SIG, ["U2.9", (21.5, 43.2), (17.5, 43.2), "R6.2"]),
    ("B", SIG, ["U2.10", (21.0, 42.4), (15.0, 42.4), "R7.2"]),
    ("F", SIG, ["net:I2C_SCL", (19.8, 42.4), (30.6, 42.4), (30.6, 1.0), (39.46, 1.0), "J1.10"]),
    ("F", SIG, ["net:I2C_SDA", (18.8, 43.2), (31.6, 43.2), (31.6, 2.0), (42.0, 2.0), "J1.8"]),
]
VIAS = [
    ("+3V3", 53.14, 4.4), ("+3V3", 33.0, 4.4), ("I2C_SCL", 19.8, 42.4), ("I2C_SDA", 18.8, 43.2),
    ("GND", 49.6, 1.5), ("GND", 44.9, 2.45), ("GND", 55.2, 5.5), ("GND", 74.8, 24.0),
    ("GND", 19.7, 35.4), ("GND", 21.5, 35.4), ("GND", 19.52, 27.0), ("GND", 29.32, 29.2), ("GND", 28.15, 33.6),
    ("GND", 22.7, 45.95), ("GND", 15.31, 37.0),
]
# GPS keep-clear: no tracks on the inner layer near the module, none under it on the outer face
KEEPOUT = [("F", (40.5, 12.5, 75.5, 47.5)), ("B", (52.7, 24.7, 63.3, 35.3))]

# 0.5 V guard: around R4, C2, R5, the input pin U1.2 and the cuff-2 wire to J2.
# It joins the reference at U1 pin 3, right beside the input pin.
GUARD = ("B", [(19.0, 23.2), (5.95, 23.2), (5.95, 30.0), (13.0, 30.0), (13.0, 31.4), (19.0, 31.4)])

STITCH = [((34.5, 1.5, 82.5, 52.5), 3.0), ((1.5, 1.5, 33.0, 52.5), 5.0)]

LABELS = {"B": [("BioMapping 2 - Cardputer GSR + GPS", 17.0, 51.5, 0.9), ("rev A  2026-11", 17.0, 50.1, 0.8), ("GSR", 19.8, 34.3, 0.8),
                ("GPS: keep this side clear of metal", 58.0, 51.6, 0.8),
                ("CUFFS", 4.8, 35.6, 0.8), ("SAFEBOOT", 45.0, 32.6, 0.8),
                ("RESET", 71.0, 32.2, 0.8), ("5V to 3.3V", 51.0, 6.6, 0.8)]}


def outline(add_seg, add_arc):
    r = 3.0
    add_seg((0, 0), (28, 0)); add_seg((28, 0), (28, -9)); add_seg((28, -9), (56, -9))
    add_seg((56, -9), (56, 0)); add_seg((56, 0), (84, 0))
    add_seg((84, 0), (84, 54 - r)); add_arc((84 - r, 54 - r), (84, 54 - r), 90)
    add_seg((84 - r, 54), (r, 54)); add_arc((r, 54 - r), (r, 54), 90)
    add_seg((0, 54 - r), (0, 0))
