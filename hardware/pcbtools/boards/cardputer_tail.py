"""Cardputer flex tail: a flexible strip that carries the EXT wires from
the header to the Cardputer board, with no sockets. Same conventions as
cardputer.py, but this is a FLEX board (see MARKINGS for the factory notes).

Laid flat, it has three parts (y down):
  * solder end (y 0.8 to 7): 8 plated pads with 0.7 mm holes, ending 0.5 mm
    short of the tip. It lies on the Cardputer board's landing pads J1, whose
    ends stick out 1.0 mm past the tip, and is soldered through the holes.
  * bendy strip (y 7 to 16): folds round the Cardputer's bottom edge. 13 mm
    wide up to y 14, widening to 20 mm by y 15, so the stiffener's edge at
    y 16 crosses straight, full-width flex. Copper on F only here, so it
    bends easily.
  * plug end (y 16 to 24, 20 mm wide): a 1 mm FR4 stiffener on F, with the
    straight 2 x 7 header through it, pushed into the EXT socket. Its F pads
    are covered, since the stiffener is glued over them; the pins are
    soldered on B.

F is the face towards the Cardputer all the way along: at the plug end it
faces the device's edge (the header's plastic body), and once folded it lies
on the board. Seen from F, x here = 54 - x on the Cardputer board, so the
header (x 4.4 to 19.6) lines up with the EXT socket and tail pad k lands on
board pad k. y 16 (top of the stiffener) is 1 mm in from the Cardputer's
back; the header's even row (GND, 5 V out, SDA, SCL, G13, G15) is 4.5 mm in,
its odd row 7 mm in. The header's plastic body (2.5 mm) and the stiffener
(1 mm) hold the flex about 3.6 mm out from the device's edge, so the fold
needs about 2.7 mm up (1 mm to the back, 1.6 mm of board, the flex itself)
and 3.6 mm across: about 6.3 mm of the 9 mm strip, leaving 2-3 mm of slack.
With the pin ends on B, the plug end stands about 5.5 mm out from the edge
(less if the pins are trimmed after soldering).

The wires run down F in this order (seen from F, left to right): ADC
ready, GND, 5 V, SCL, SDA, GND, G13, G15. The ADS1115 has an I2C bus of its
own, on pins in the odd row: SCL on pin 5 (G6) and SDA on pin 13 (G5). Both
come out between the even row's pins on F, under the stiffener: SCL between
pins 6 and 8, SDA along the gap between the two rows and out between pins 8
and 10, so they reach the strip in the order the board wants with no via.
Pins 8 and 10 (G8/G9, the Cardputer's own I2C bus with the keyboard on it)
stay unconnected. The ADC ready line also comes from the odd row (pin 3,
G4), passing between pins 2 and 4. The second ground (pad 6) sits between
the I2C and GPS serial wires, so the serial wires have a ground right beside
them; it drops through a via and runs along B, above the even row, to the
header's GND pin. Two ground joints also mean one bad joint can't cut the
board's ground. 5 V and both grounds are power width. Every track crosses the
stiffener's edge (y 16) straight, and nothing turns, and no via sits, within
1 mm of it: that edge is where the flex bends hardest, and the factory glues
the stiffener on a few tenths of a mm either way. No track runs between the
header's two rows on B, the face where the pins are soldered by hand. Pin 2
(5 V in) stays unconnected."""
from ..rules import SIG, PWR, TEXT

PLACE = {
    "J1": (4.38, 22.04, 90, "F"),    # even row (pin 2 ... 14) at y 19.5, odd row at y 22.04
    "J2": (12.0, 2.5, 0, "F"),       # pad k at x 5.25 + 1.5 k: READY, GND, 5V, SCL, SDA, GND, G13, G15
}
TRACKS = [
    # ── on F: straight down the strip, turning only once 1 mm inside the stiffener ──
    ("F", SIG, ["J2.1", (6.75, 17.0), (5.65, 18.1), (5.65, 20.77), "J1.3"]),   # ADC ready, between pins 2 and 4
    ("F", PWR, ["J2.2", (8.25, 17.0), "J1.4"]),                       # GND
    ("F", PWR, ["J2.3", (9.75, 17.0), "J1.6"]),                       # 5 V
    ("F", SIG, ["J2.7", (15.75, 17.0), "J1.12"]),                     # G13, to the GPS
    ("F", SIG, ["J2.8", (17.25, 17.0), "J1.14"]),                     # G15, from the GPS
    # ── the ADC's own I2C bus, from the odd row: out between the even row's pins ──
    ("F", SIG, ["J2.4", (11.25, 17.0), (10.73, 17.52), (10.73, 20.77), "J1.5"]),    # SCL (G6), between pins 6 and 8
    ("F", SIG, ["J2.5", (12.75, 17.0), (13.27, 17.52), (13.27, 20.77),              # SDA (G5): between pins 8 and 10,
                (18.35, 20.77), "J1.13"]),                                          # then along the gap between the rows
    # ── second ground: pad 6 down F to a via, then along B above the even row to the GND pin ──
    ("F", PWR, ["J2.6", (14.25, 17.4)]),
    ("B", PWR, ["net:GND", (14.25, 17.4), (6.92, 17.4), "J1.4"]),
]
VIAS = [("GND", 14.25, 17.4)]
BEVEL = 0.8                # square corners cut at 45 degrees (see cardputer.py)
KEEPOUT = []
STITCH = []
GROUND_POUR = False        # solid copper would make the strip stiff and crack where it bends
LABELS = {"F": [("THIS SIDE DOWN", 12.0, 10.0, TEXT)],
          "B": [("EXT TAIL rev F", 12.0, 11.5, TEXT)]}
# notes for the flex factory, on the drawings layer
MARKINGS = [
    ((2.0, 16.0, 22.0, 24.0), "STIFFENER: FR4 1.0 mm, on F (header side), drilled for the header"),
    ((5.5, 7.0, 18.5, 16.0), "BEND AREA: copper on F only"),
]


def outline(add_seg, add_arc):
    """Strip 13 mm wide (x 5.5 to 18.5), plug end 20 mm wide (x 2 to 22),
    rounded corners (only 0.4 mm at the soldered tip, to keep 0.5 mm of flex
    round the end pads), and 1 mm fillets where the strip widens, 1 mm short
    of the stiffener, so the fold at the stiffener's edge never meets a corner
    that could start a tear."""
    add_seg((5.9, 0.8), (18.1, 0.8)); add_arc((18.1, 1.2), (18.1, 0.8), 90)
    add_seg((18.5, 1.2), (18.5, 14)); add_arc((19.5, 14), (18.5, 14), -90)
    add_seg((19.5, 15), (21, 15)); add_arc((21, 16), (21, 15), 90)
    add_seg((22, 16), (22, 23)); add_arc((21, 23), (22, 23), 90)
    add_seg((21, 24), (3, 24)); add_arc((3, 23), (3, 24), 90)
    add_seg((2, 23), (2, 16)); add_arc((3, 16), (2, 16), 90)
    add_seg((3, 15), (4.5, 15)); add_arc((4.5, 14), (4.5, 15), -90)
    add_seg((5.5, 14), (5.5, 1.2)); add_arc((5.9, 1.2), (5.5, 1.2), 90)
