"""Flipper board layout: where every part sits and how every track runs.

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

# The board stands up from the Flipper's top edge. y = 52 is the edge that
# meets the Flipper; all parts sit on the front (F). Left: GPS on a 50 x 52 mm
# ground plane. Right: the GSR circuit, cuff socket in the top right corner. The
# right edge sits just past the header, so the board is only as wide as the GPS
# plane plus the GSR circuit.
FH, FW = 52.0, 72.0
F1X = 69.21                               # Flipper pin 1 x (pins run right to left)
PLACE = {
    "J1": (F1X, FH - 4.04, -90, "F"),              # Flipper pins 1-8
    "J4": (F1X - 2 * 17.78, FH - 4.04, -90, "F"),  # Flipper pins 9-18
    # GPS centred on the left half; its serial pads face the header
    "U4": (25.0, 20.0, -90, "F"),
    "C7": (35.3, 22.85, -90, "F"),                 # bridges VCC pad 17 and GND pad 16
    "C6": (38.95, 26.0, 0, "F"),
    "TP2": (35.9, 19.2, 0, "F"), "TP1": (14.4, 20.0, 0, "F"),
    # a ground pad beside each, 1.2 mm apart: tweezers across the pair, or a scope's ground.
    # TP7 goes above TP2, because C7 sits below it
    "TP7": (35.9, 16.5, 0, "F"), "TP6": (14.4, 22.7, 0, "F"),
    "D1": (30.6, 6.0, 0, "F"), "R8": (25.6, 6.0, 180, "F"),
    "C8": (21.6, 5.3, 180, "F"), "BT1": (15.0, 5.3, 0, "F"),
    "R10": (25.0, 31.0, -90, "F"), "R9": (27.5, 31.0, -90, "F"),
    # GSR circuit: cuffs (top right) -> R4 below them -> U1 -> U2 below it
    # cuff socket: its opening is 0.75 mm inside the right edge, so nothing sticks out
    # and the plug can be pulled straight off; its tabs keep the 0.5 mm copper-edge gap
    "J2": (FW - 5.15, 8.0, 90, "F"),
    "R4": (67.6, 14.0, 0, "F"),
    "R3": (59.9, 9.0, 180, "F"),                   # cuff 1 to ground, right beside its pin
    "R5": (65.6, 19.3, -90, "F"), "C2": (67.9, 19.3, -90, "F"),
    "U1": (60.0, 18.0, 180, "F"),
    "R1": (53.6, 13.6, 0, "F"), "R2": (53.6, 16.1, 180, "F"), "C1": (56.0, 21.6, 180, "F"),
    "C9": (53.6, 18.4, 180, "F"),                  # right under R2, across it
    "U2": (60.0, 27.0, -90, "F"), "C3": (59.3, 31.9, -90, "F"),   # right under ADC supply pin 8
    # test pads: GSR output and ground side by side, 0.5 V beside the ADC
    "TP3": (64.2, 23.0, 0, "F"), "TP5": (64.2, 25.4, 0, "F"), "TP4": (57.0, 26.0, 0, "F"),
    "R6": (64.5, 33.0, 90, "F"), "R7": (67.0, 33.0, 90, "F"),
}
TRACKS = [
    # ── GPS ──
    ("F", PWR, ["J4.1", (33.65, 44.5), (38.0, 40.15), (38.0, 9.5), (26.9, 9.5), "U4.2"]),   # 3V3 up the side to V_IO
    ("F", PWR, [(38.0, 21.9), "C7.1", "U4.17"]),          # 3V3 into VCC through C7
    ("F", PWR, ["C7.2", "U4.16"]),                         # C7 straight back to the next GND pad
    ("F", PWR, [(38.0, 26.0), "C6.1"]),
    ("F", SIG, ["D1.2", (31.85, 9.5)]),                    # backup charger: 3V3 -> D1 -> R8
    ("F", SIG, ["D1.1", "R8.1"]),
    ("F", SIG, ["R8.2", (24.69, 7.6), (25.0, 7.9), "U4.3"]),
    ("F", SIG, ["R8.2", "C8.1"]),
    ("F", SIG, ["C8.1", (22.55, 3.27), "BT1.1"]),
    ("F", SIG, ["U4.18", "TP2.1"]),
    ("F", SIG, ["U4.8", "TP1.1"]),
    ("F", SIG, ["U4.13", "R10.1"]),
    ("F", SIG, ["U4.14", (26.9, 28.9), (27.5, 29.5), "R9.1"]),
    ("F", SIG, ["R10.2", (25.0, 40.0), (20.95, 44.05), "J4.6"]),
    ("F", SIG, ["R9.2", (27.5, 40.0), (23.49, 44.01), "J4.5"]),
    # ── 3V3 to the GSR side: back layer along the bottom, then up the left of the circuit ──
    ("B", PWR, ["J4.1", (33.65, 45.6), (50.5, 45.6)]),
    ("F", PWR, ["net:+3V3", (50.5, 45.6), (50.5, 13.6), "R1.1"]),
    ("F", PWR, ["net:+3V3", (50.5, 19.91), "U1.8"]),
    ("F", PWR, ["U1.8", (56.95, 19.91), "C1.1"]),          # C1 right under the op-amp supply pin
    ("F", PWR, ["C1.2", (53.85, 21.6)]),
    ("F", PWR, ["net:+3V3", (50.5, 30.95), "C3.1"]),
    ("F", SIG, ["U2.8", (60.0, 30.95), "C3.1"]),
    ("F", PWR, ["C3.2", (59.3, 33.95)]),
    ("F", SIG, ["net:+3V3", (50.5, 35.5), (67.0, 35.5), "R7.1"]),
    ("F", SIG, ["R6.1", (64.5, 35.5)]),
    # ── GSR signal path ──
    ("F", SIG, ["J2.2", (67.0, 7.0), (67.0, 13.0), "R4.1"]),   # cuff 2 passes cuff 1's pin on the socket side
    ("F", SIG, ["J2.1", "R3.1"]),
    ("F", PWR, ["R3.2", (57.6, 9.0)]),
    ("F", SIG, ["R4.2", (68.51, 17.21), "C2.1"]),            # TIA input node: R4, C2, R5, U1 pin 2
    ("F", SIG, ["C2.1", "R5.1", (63.5, 18.39), "U1.2"]),
    ("F", SIG, ["U1.1", (64.2, 19.91), (64.5, 20.21), "R5.2", "C2.2"]),
    ("F", SIG, [(64.2, 19.91), (64.2, 21.5), (59.5, 21.5), "U2.4"]),
    ("F", SIG, ["U1.3", "U1.6"]),                           # 0.5 V reference under the chip
    ("F", SIG, ["U1.6", "U1.7"]),
    ("F", SIG, [(59.0, 17.36), "U2.5"]),
    ("F", SIG, ["R1.2", "R2.1", "U1.5"]),
    ("F", SIG, ["R2.1", "C9.1"]),
    ("F", PWR, ["R2.2", "C9.2"]),
    ("F", PWR, ["net:GND", (51.5, 17.25), (52.67, 17.25)]),
    ("F", PWR, ["U1.4", (62.48, 15.0)]),                   # ground pin to its via, just outside the guard
    ("F", SIG, [(64.2, 21.5), "TP3.1"]),
    ("F", SIG, [(59.0, 23.2), (57.0, 23.2), "TP4.1"]),
    # ── ADC and I2C ──
    ("F", SIG, ["U2.3", (60.0, 23.4), (62.3, 23.4)]),
    ("F", SIG, ["U2.1", (61.0, 23.4)]),
    ("F", SIG, ["U2.9", (60.5, 31.2), (64.5, 31.2), "R6.2"]),
    ("F", SIG, ["U2.10", (61.0, 30.4), (67.0, 30.4), "R7.2"]),
    ("B", SIG, ["net:I2C_SCL", (62.2, 30.4), (62.2, 42.6), (15.87, 42.6), "J4.8"]),
    ("B", SIG, ["net:I2C_SDA", (63.2, 31.2), (63.2, 43.8), (18.41, 43.8), "J4.7"]),
]
VIAS = [
    ("+3V3", 50.5, 45.6), ("I2C_SCL", 62.2, 30.4), ("I2C_SDA", 63.2, 31.2),
    ("GND", 62.3, 23.4), ("GND", 60.5, 23.4), ("GND", 62.48, 15.0), ("GND", 51.5, 17.25), ("GND", 53.85, 21.6),
    ("GND", 59.3, 33.95), ("GND", 57.6, 9.0), ("GND", 36.6, 24.4), ("GND", 40.9, 27.2),
]
# GPS keep-clear: no tracks on the back layer near the module, none under it on the front
KEEPOUT = [("B", (0.5, 0.5, 45.0, 40.0)), ("F", (19.7, 14.7, 30.3, 25.3))]

# 0.5 V guard: around R4, C2, R5, the input pin U1.2 and the cuff-2 wire and pin,
# including the strip between the two cuff pins. It joins the reference at U1
# pin 3, right beside the input pin. It reaches round the far end of the cuff-2
# pin, so that wire starts inside the guard rather than cutting it in two.
GUARD = ("F", [(61.2, 5.6), (FW - 0.5, 5.6), (FW - 0.5, 19.4),
               (63.0, 19.4), (63.0, 10.3), (61.2, 10.3)])

STITCH = [((1.5, 1.5, 46.0, 50.5), 3.0), ((47.5, 1.5, FW - 1.5, 50.5), 5.0)]

LABELS = {"F": [("BioMapping 2", 60.5, 38.4, TEXT), ("Flipper GSR + GPS", 60.5, 40.0, TEXT),
                ("rev A  2026-11", 60.5, 41.6, TEXT),
                ("GPS: keep this side clear of metal", 23.0, 37.5, TEXT),
                ("CUFFS", 66.0, 2.4, TEXT),
                # each GPS pad's name beside it, on the side away from the module, 0.3 mm
                # clear of its printed outline. RESET stands further off: TP2's own name
                # goes between, as C7, TP7 and the module leave it no other room
                ("SAFEBOOT/PPS", 7.25, 20.0, TEXT), ("GND", 11.4, 22.7, TEXT),
                ("RESET", 43.2, 19.2, TEXT), ("GND", 38.9, 16.5, TEXT)]}


def outline(add_seg, add_arc):
    r = 3.0
    add_seg((r, 0), (FW - r, 0)); add_arc((FW - r, r), (FW - r, 0), 90)
    add_seg((FW, r), (FW, FH)); add_seg((FW, FH), (0, FH)); add_seg((0, FH), (0, r))
    add_arc((r, r), (0, r), 90)
