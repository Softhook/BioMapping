"""Cardputer flex tail: a flexible strip that carries the six EXT wires from
the header to the Cardputer board, with no sockets. Same conventions as
cardputer.py, but this is a FLEX board (see MARKINGS for the factory notes).

Laid flat, it has three parts (y down):
  * solder end (y 0 to 7): 8 plated pads with 0.5 mm holes. It lies on the
    Cardputer board's landing pads J1 and is soldered through the holes.
  * bendy strip (y 7 to 16, 13 mm wide): folds round the Cardputer's bottom
    edge. Copper on F only here, so it bends easily.
  * plug end (y 16 to 24, 20 mm wide): a 1 mm FR4 stiffener on F, with the
    straight 2 x 7 header through it, pushed into the EXT socket.

F is the face towards the Cardputer all the way along: at the plug end it
faces the device's edge (the header's plastic body), and once folded it lies
on the board. Seen from F, x here = 54 - x on the Cardputer board, so the
header (x 4.4 to 19.6) lines up with the EXT socket and tail pad k lands on
board pad k. y 16 (top of the stiffener) is 1 mm in from the Cardputer's
back; the header's even row (GND, 5 V out, SDA, SCL, G13, G15) is 4.5 mm in,
its odd row 7 mm in. Laid flat, the strip leaves about 1 mm of slack round
the edge.

The signals run down F in the same order as the header pins, so nothing
crosses. The three ground wires between them drop through vias at the top of
the stiffened end and join the header's GND pin on B, where nothing bends."""
from ..rules import SIG, PWR, TEXT

PLACE = {
    "J1": (4.38, 22.04, 90, "F"),    # even row (pin 2 ... 14) at y 19.5, odd row at y 22.04
    "J2": (12.0, 2.5, 0, "F"),       # pad k at x 5.25 + 1.5 k: 5V, GND, SDA, GND, SCL, GND, G13, G15
}
TRACKS = [
    # ── signals: straight down the strip on F, then across to their header pins ──
    ("F", PWR, ["J2.1", (6.75, 17.8), "J1.6"]),        # 5 V
    ("F", SIG, ["J2.3", (9.75, 17.8), "J1.8"]),        # SDA
    ("F", SIG, ["J2.5", (12.75, 17.8), "J1.10"]),      # SCL
    ("F", SIG, ["J2.7", (15.75, 17.8), "J1.12"]),      # G13, to the GPS
    ("F", SIG, ["J2.8", (17.25, 17.8), "J1.14"]),      # G15, from the GPS
    # ── ground wires between them, down to vias on the stiffened end ──
    ("F", SIG, ["J2.2", (8.25, 17.0)]),
    ("F", SIG, ["J2.4", (11.25, 17.0)]),
    ("F", SIG, ["J2.6", (14.25, 17.0)]),
    ("B", SIG, ["net:GND", (14.25, 17.0), (6.92, 17.0), "J1.4"]),
]
VIAS = [("GND", 8.25, 17.0), ("GND", 11.25, 17.0), ("GND", 14.25, 17.0)]
KEEPOUT = []
STITCH = []
GROUND_POUR = False        # solid copper would make the strip stiff and crack where it bends
LABELS = {"F": [("THIS SIDE DOWN", 12.0, 10.0, TEXT)],
          "B": [("EXT TAIL rev B", 12.0, 11.5, TEXT)]}
# notes for the flex factory, on the drawings layer
MARKINGS = [
    ((2.0, 16.0, 22.0, 24.0), "STIFFENER: FR4 1.0 mm, on F (header side), drilled for the header"),
    ((5.5, 7.0, 18.5, 16.0), "BEND AREA: copper on F only"),
]


def outline(add_seg, add_arc):
    """Strip 13 mm wide (x 5.5 to 18.5), plug end 20 mm wide (x 2 to 22),
    rounded corners, and 1 mm fillets where the strip meets the plug end so a
    bend there can't start a tear."""
    add_seg((6.5, 0), (17.5, 0)); add_arc((17.5, 1), (17.5, 0), 90)
    add_seg((18.5, 1), (18.5, 15)); add_arc((19.5, 15), (18.5, 15), -90)
    add_seg((19.5, 16), (21, 16)); add_arc((21, 17), (21, 16), 90)
    add_seg((22, 17), (22, 23)); add_arc((21, 23), (22, 23), 90)
    add_seg((21, 24), (3, 24)); add_arc((3, 23), (3, 24), 90)
    add_seg((2, 23), (2, 17)); add_arc((3, 17), (2, 17), 90)
    add_seg((3, 16), (4.5, 16)); add_arc((4.5, 15), (4.5, 16), -90)
    add_seg((5.5, 15), (5.5, 1)); add_arc((6.5, 1), (5.5, 1), 90)
