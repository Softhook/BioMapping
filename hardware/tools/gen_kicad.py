#!/usr/bin/env python3
"""Generate the KiCad schematics, project files and BOMs for the BioMapping
Flipper and Cardputer boards.

Two separate descriptions of each board live here:
  * PARTS tables - which pin connects to which net. This is the intent.
  * draw_* functions - where each symbol sits on the sheet and how the wires
    run. This is the drawing.
check_netlist.py exports KiCad's own netlist of the drawing and proves it
matches the PARTS tables pin for pin.

usage: gen_kicad.py <hardware-dir> <expected.json>"""
import json, math, os, sys, uuid

G = 2.54                                   # schematic grid (100 mil)

def U():
    return str(uuid.uuid4())

FONT = '(effects (font (size 1.27 1.27)))'
FONT_HIDE = '(effects (font (size 1.27 1.27)) hide)'

# ── Symbol library ────────────────────────────────────────────────────────
# Library coordinates have y pointing up. A pin's angle is the direction
# from its connection point toward the symbol body.

def pin(num, name, x, y, ang, length=G, kind="passive", hide=False):
    return dict(num=num, name=name, x=x, y=y, ang=ang, len=length, kind=kind, hide=hide)

def poly(*pts, width=0.254, fill="none"):
    xy = " ".join(f"(xy {x} {y})" for x, y in pts)
    return f'(polyline (pts {xy}) (stroke (width {width}) (type default)) (fill (type {fill})))'

def rect(x1, y1, x2, y2, fill="none", width=0.254):
    return (f'(rectangle (start {x1} {y1}) (end {x2} {y2}) '
            f'(stroke (width {width}) (type default)) (fill (type {fill})))')

def circle(cx, cy, r, fill="none"):
    return f'(circle (center {cx} {cy}) (radius {r}) (stroke (width 0.254) (type default)) (fill (type {fill})))'

def sym(name, ref, units, common="", power=False, show_names=False, show_numbers=True):
    return dict(name=name, ref=ref, units=units, common=common, power=power,
                show_names=show_names, show_numbers=show_numbers)

def two_pin_v(name, ref, body, n1="~", n2="~"):
    """Vertical two-pin part: pin 1 at the top, pin 2 at the bottom."""
    return sym(name, ref, {1: dict(pins=[pin("1", n1, 0, 3.81, 270, 1.27), pin("2", n2, 0, -3.81, 90, 1.27)],
                                   body=body)}, show_numbers=False)

RES = rect(-1.016, -2.54, 1.016, 2.54)
CAP = (poly((-2.032, -0.762), (2.032, -0.762), width=0.508) + poly((-2.032, 0.762), (2.032, 0.762), width=0.508)
       + poly((0, 2.54), (0, 0.762), width=0) + poly((0, -2.54), (0, -0.762), width=0))
BEAD = (rect(-1.27, -2.54, 1.27, 2.54) + poly((0, 2.54), (0, 2.54)))
CELL = (poly((-2.032, 0.762), (2.032, 0.762), width=0.508) + poly((-1.016, -0.254), (1.016, -0.254), width=0.508)
        + poly((0, 2.54), (0, 0.762), width=0) + poly((0, -2.54), (0, -0.254), width=0)
        + poly((1.27, 2.286), (2.286, 2.286), width=0.254) + poly((1.778, 1.778), (1.778, 2.794), width=0.254))

def box(name, ref, left=(), right=(), top=(), bottom=(), width=None):
    """IC drawn as a box. Each side lists (number, name) in order: left/right
    from the top down, top/bottom from left to right. An entry whose number is
    a list is a stack of pins (e.g. many GND pads) drawn as one."""
    rows = max(len(left), len(right), 1)
    cols = max(len(top), len(bottom), 1)
    h = math.ceil((rows + 1) / 2) * 2 * G
    w = max(width or 0, math.ceil((cols + 1) / 2) * 2 * G)
    pins = []
    def add(entry, x, y, ang):
        nums, nm = entry
        if isinstance(nums, str):
            nums = [nums]
        for i, n in enumerate(nums):
            pins.append(pin(n, nm, x, y, ang, hide=i > 0))
    for i, e in enumerate(left):
        add(e, -w / 2 - G, h / 2 - G * (i + 1), 0)
    for i, e in enumerate(right):
        add(e, w / 2 + G, h / 2 - G * (i + 1), 180)
    for i, e in enumerate(top):
        add(e, (2 * i - len(top) + 1) * G, h / 2 + G, 270)
    for i, e in enumerate(bottom):
        add(e, (2 * i - len(bottom) + 1) * G, -h / 2 - G, 90)
    return sym(name, ref, {1: dict(pins=pins, body=rect(-w / 2, h / 2, w / 2, -h / 2, fill="background"))},
               show_names=True)

def header(name, n, side="right"):
    ents = [(str(i), f"Pin_{i}") for i in range(1, n + 1)]
    s = box(name, "J", left=ents if side == "left" else (), right=ents if side == "right" else (), width=5.08)
    s["show_names"] = False
    return s

def opamp_unit(minus, plus, out):
    tri = poly((-5.08, 5.08), (5.08, 0), (-5.08, -5.08), (-5.08, 5.08), fill="background")
    return dict(pins=[pin(minus, "-", -7.62, 2.54, 0), pin(plus, "+", -7.62, -2.54, 0),
                      pin(out, "~", 7.62, 0, 180)], body=tri)

def power_sym(name, kind="power_in", shape="up"):
    if shape == "up":
        body = poly((0, 0), (0, 1.27)) + poly((-0.762, 1.27), (0, 2.54), (0.762, 1.27), (-0.762, 1.27))
    elif shape == "gnd":
        body = poly((0, 0), (0, -1.27), (1.27, -1.27), (0, -2.54), (-1.27, -1.27), (0, -1.27))
    else:  # flag
        body = poly((0, 0), (0, 1.27), (-1.016, 1.905), (0, 2.54), (1.016, 1.905), (0, 1.27))
    ang = 270 if shape == "gnd" else 90
    return sym(name, "#PWR" if kind == "power_in" else "#FLG",
               {1: dict(pins=[pin("1", name, 0, 0, ang, 0, kind, hide=True)], body=body)},
               power=True, show_numbers=False)

SYMS = {
    "R": two_pin_v("R", "R", RES),
    "C": two_pin_v("C", "C", CAP),
    "FB": two_pin_v("FerriteBead", "FB", BEAD),
    "BT": two_pin_v("Battery_Cell", "BT", CELL, "+", "-"),
    "D": sym("D_Schottky", "D", {1: dict(
        pins=[pin("1", "K", 3.81, 0, 180, 1.27), pin("2", "A", -3.81, 0, 0, 1.27)],
        body=(poly((1.27, 1.27), (1.27, -1.27), width=0.254) + poly((1.27, 1.27), (1.778, 1.27), (1.778, 1.016))
              + poly((1.27, -1.27), (0.762, -1.27), (0.762, -1.016))
              + poly((-1.27, 1.27), (1.27, 0), (-1.27, -1.27), (-1.27, 1.27)) + poly((-2.54, 0), (2.54, 0), width=0)))},
        show_numbers=False),
    "MCP6002": sym("MCP6002", "U", {
        1: opamp_unit("2", "3", "1"),
        2: opamp_unit("6", "5", "7"),
        3: dict(pins=[pin("8", "V+", 0, 5.08, 270), pin("4", "V-", 0, -5.08, 90)],
                body=rect(-1.27, 2.54, 1.27, -2.54, fill="background"))}),
    "ADS1115": box("ADS1115", "U",
                   left=[("4", "AIN0"), ("5", "AIN1"), ("6", "AIN2"), ("7", "AIN3")],
                   right=[("9", "SDA"), ("10", "SCL"), ("1", "ADDR"), ("2", "ALERT/RDY")],
                   top=[("8", "VDD")], bottom=[("3", "GND")], width=22.86),
    "SAM-M10Q": box("SAM-M10Q", "U",
                    left=[("18", "RESET_N"), ("8", "SAFEBOOT_N"), ("19", "EXTINT"), ("7", "TIMEPULSE")],
                    right=[("13", "TXD"), ("14", "RXD"), ("9", "SDA"), ("12", "SCL")],
                    top=[("17", "VCC"), ("2", "V_IO"), ("3", "V_BCKP")],
                    bottom=[(["1", "4", "5", "6", "10", "11", "15", "16", "20"], "GND")], width=30.48),
    "TLV75533": box("TLV75533PDBV", "U", left=[("1", "IN"), ("3", "EN")], right=[("5", "OUT"), ("4", "NC")],
                    bottom=[("2", "GND")], width=15.24),
    "Conn_1x02": header("Conn_01x02", 2),
    "Conn_1x08": header("Conn_01x08", 8),
    "Conn_1x10": header("Conn_01x10", 10),
    "Conn_2x07": dict(box("Conn_02x07_Odd_Even", "J", left=[(str(i), f"Pin_{i}") for i in range(1, 15, 2)],
                          right=[(str(i), f"Pin_{i}") for i in range(2, 15, 2)], width=5.08), show_names=False),
    "TP": sym("TestPoint", "TP", {1: dict(pins=[pin("1", "1", 0, 0, 90, 0)],
                                          body=circle(0, 2.032, 0.762) + poly((0, 0), (0, 1.27), width=0))},
              show_numbers=False),
    "MH": sym("MountingHole", "H", {1: dict(pins=[], body=circle(0, 0, 1.27))}, show_numbers=False),
    "+3V3": power_sym("+3V3"),
    "GND": power_sym("GND", shape="gnd"),
    "PWR_FLAG": power_sym("PWR_FLAG", "power_out", shape="flag"),
}

def lib_symbol(key, prefix="BioMap:"):
    s = SYMS[key]
    nm = s["name"]
    out = [f'(symbol "{prefix}{nm}"']
    if s["power"]:
        out.append('(power)')
    if not s["show_numbers"]:
        out.append('(pin_numbers hide)')
    out.append('(pin_names (offset 0.762))' if s["show_names"] else '(pin_names (offset 0) hide)')
    out.append('(exclude_from_sim no) (in_bom yes) (on_board yes)')
    for k, v in [("Reference", s["ref"]), ("Value", nm), ("Footprint", ""), ("Datasheet", ""), ("Description", "")]:
        eff = FONT if k in ("Reference", "Value") else FONT_HIDE
        out.append(f'(property "{k}" "{v}" (at 0 0 0) {eff})')
    if s["common"]:
        out.append(f'(symbol "{nm}_0_1" {s["common"]})')
    for u, d in s["units"].items():
        out.append(f'(symbol "{nm}_{u}_1" {d["body"]}')
        for p in d["pins"]:
            out.append(f'(pin {p["kind"]} line (at {p["x"]:.3f} {p["y"]:.3f} {p["ang"]}) (length {p["len"]})'
                       + (' hide' if p["hide"] else '')
                       + f' (name "{p["name"]}" {FONT}) (number "{p["num"]}" {FONT}))')
        out.append(')')
    out.append(')')
    return " ".join(out)

# ── Board contents: part -> footprint and pin -> net (None = no connect) ──

FP_R = "Resistor_SMD:R_0805_2012Metric"
FP_C = "Capacitor_SMD:C_0805_2012Metric"
PREC = "Sets the GSR scale. Use 0.1% parts"

def part(ref, key, value, fp, pins, note=""):
    return dict(ref=ref, key=key, value=value, fp=fp, pins=pins, note=note)

def gsr_core():
    """The validated GSR circuit (docs/wiring_guide.md), shared by both boards."""
    return [
        part("J2", "Conn_1x02", "Grove GSR finger cuffs", "Connector_JST:JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal",
             {"1": "ELECTRODE_1", "2": "ELECTRODE_2"}, "JST PH 2.0 mm side-entry socket for the Grove GSR finger-cuff plug"),
        part("R3", "R", "4.7k", FP_R, {"1": "ELECTRODE_1", "2": "GND"}, "Skin current limit"),
        part("R4", "R", "4.7k", FP_R, {"1": "ELECTRODE_2", "2": "TIA_IN"}, "Skin current limit"),
        part("U1", "MCP6002", "MCP6002-I/SN", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
             {"1": "GSR_SIGNAL", "2": "TIA_IN", "3": "REF_0V5", "4": "GND",
              "5": "BIAS_DIV", "6": "REF_0V5", "7": "REF_0V5", "8": "+3V3"}),
        part("R5", "R", "47k 0.1%", FP_R, {"1": "TIA_IN", "2": "GSR_SIGNAL"}, "TIA gain. " + PREC),
        part("C2", "C", "100nF C0G", FP_C, {"1": "TIA_IN", "2": "GSR_SIGNAL"}, "TIA filter (~34 Hz). C0G/NP0 only"),
        part("R1", "R", "56k 0.1%", FP_R, {"1": "+3V3", "2": "BIAS_DIV"}, "0.5 V bias. " + PREC),
        part("R2", "R", "10k 0.1%", FP_R, {"1": "BIAS_DIV", "2": "GND"}, "0.5 V bias. " + PREC),
        part("C1", "C", "100nF", FP_C, {"1": "+3V3", "2": "GND"}, "Op-amp decoupling: against U1 pins 8 and 4"),
        part("U2", "ADS1115", "ADS1115IDGSR", "Package_SO:MSOP-10_3x3mm_P0.5mm",
             {"4": "GSR_SIGNAL", "5": "REF_0V5", "6": None, "7": None, "3": "GND",
              "8": "+3V3", "9": "I2C_SDA", "10": "I2C_SCL", "1": "GND", "2": None}, "I2C address 0x48 (ADDR to GND)"),
        part("C3", "C", "100nF", FP_C, {"1": "+3V3", "2": "GND"}, "ADC decoupling: against U2 pins 8 and 3"),
    ]

def gps_block():
    """u-blox SAM-M10Q on the board, wired like the SparkFun GPS-21834 breakout."""
    return [
        part("U4", "SAM-M10Q", "SAM-M10Q-00B", "RF_GPS:ublox_SAM-M8Q_HandSolder",
             {"17": "+3V3", "2": "+3V3", "3": "GPS_BCKP", "13": "GPS_TXD", "14": "GPS_RXD",
              "18": "GPS_RESET_N", "8": "GPS_SAFEBOOT_N", "19": None, "7": None, "9": None, "12": None,
              **{n: "GND" for n in ["1", "4", "5", "6", "10", "11", "15", "16", "20"]}},
             "GPS with built-in patch antenna. Pin-compatible with the SAM-M8Q footprint. Needs the ground plane around it"),
        part("C6", "C", "10uF", FP_C, {"1": "+3V3", "2": "GND"}, "GPS supply reservoir"),
        part("C7", "C", "100nF", FP_C, {"1": "+3V3", "2": "GND"}, "GPS decoupling: against U4 VCC"),
        part("D1", "D", "PMEG4005EJ", "Diode_SMD:D_SOD-323_HandSoldering", {"2": "+3V3", "1": "BCKP_CHG"},
             "Stops the backup cell feeding the 3.3 V rail"),
        part("R8", "R", "3.3k", FP_R, {"1": "BCKP_CHG", "2": "GPS_BCKP"}, "Backup cell charge current limit"),
        part("BT1", "BT", "MS621FE", "Battery:BatteryHolder_Seiko_MS621F", {"1": "GPS_BCKP", "2": "GND"},
             "Rechargeable 3 V backup cell (Seiko MS621FE-FL11E). Keeps satellite data for fast starts"),
        part("C8", "C", "100nF", FP_C, {"1": "GPS_BCKP", "2": "GND"}, "Backup supply decoupling"),
        part("R9", "R", "470", FP_R, {"1": "GPS_RXD", "2": "HOST_TX_TO_GPS"}, "Series resistor on GPS RX"),
        part("R10", "R", "470", FP_R, {"1": "GPS_TXD", "2": "GPS_TX_TO_HOST"}, "Series resistor on GPS TX"),
        part("TP1", "TP", "SAFEBOOT", "TestPoint:TestPoint_Pad_1.5x1.5mm", {"1": "GPS_SAFEBOOT_N"},
             "Short to GND at power-up to recover the GPS firmware"),
        part("TP2", "TP", "RESET", "TestPoint:TestPoint_Pad_1.5x1.5mm", {"1": "GPS_RESET_N"},
             "Short to GND to reset the GPS"),
    ]

FLIPPER = gsr_core() + gps_block() + [
    part("J4", "Conn_1x10", "Flipper GPIO 9-18", "Connector_PinHeader_2.54mm:PinHeader_1x10_P2.54mm_Horizontal",
         {"1": "+3V3", "2": None, "3": "GND", "4": None, "5": "HOST_TX_TO_GPS", "6": "GPS_TX_TO_HOST",
          "7": "I2C_SDA", "8": "I2C_SCL", "9": None, "10": "GND"},
         "Flipper pins 9-18: 9 3V3, 11 GND, 13 USART TX, 14 USART RX, 15 PC1 SDA, 16 PC0 SCL, 18 GND"),
    part("J1", "Conn_1x08", "Flipper GPIO 1-8", "Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Horizontal",
         {**{str(i): None for i in range(1, 8)}, "8": "GND"}, "Flipper pins 1-8 (1 = 5V, 8 = GND). Holds the board"),
    part("R6", "R", "4.7k", FP_R, {"1": "+3V3", "2": "I2C_SDA"}, "I2C pull-up"),
    part("R7", "R", "4.7k", FP_R, {"1": "+3V3", "2": "I2C_SCL"}, "I2C pull-up"),
]

CARDPUTER = gsr_core() + gps_block() + [
    part("J1", "Conn_2x07", "Cardputer ADV EXT", "Connector_PinHeader_2.54mm:PinHeader_2x07_P2.54mm_Horizontal",
         {"1": None, "2": None, "3": None, "4": "GND", "5": None, "6": "+5V_EXT", "7": None,
          "8": "I2C_SDA", "9": None, "10": "I2C_SCL", "11": None, "12": "HOST_TX_TO_GPS",
          "13": None, "14": "GPS_TX_TO_HOST"},
         "M5 pin table numbering: 4 GND, 6 5V OUT, 8 G8 SDA, 10 G9 SCL, 12 G13, 14 G15. "
         "Pin 2 is 5V IN - never connect. CHECK numbering and mirroring before ordering"),
    part("FB1", "FB", "600R@100MHz", "Inductor_SMD:L_0805_2012Metric", {"1": "+5V_EXT", "2": "+5V_F"},
         "Blocks the Cardputer's boost-converter switching noise"),
    part("C4", "C", "10uF", FP_C, {"1": "+5V_F", "2": "GND"}, "Regulator input capacitor"),
    part("U3", "TLV75533", "TLV75533PDBVR", "Package_TO_SOT_SMD:SOT-23-5",
         {"1": "+5V_F", "3": "+5V_F", "2": "GND", "5": "+3V3", "4": None},
         "5 V to 3.3 V regulator (LDO), 500 mA, 1% accuracy, low noise"),
    part("C5", "C", "10uF", FP_C, {"1": "+3V3", "2": "GND"}, "Regulator output capacitor"),
    part("H1", "MH", "M2", "MountingHole:MountingHole_2.2mm_M2", {}, "M2 x 4 mm screw into Cardputer back"),
    part("H2", "MH", "M2", "MountingHole:MountingHole_2.2mm_M2", {}, "M2 x 4 mm screw into Cardputer back"),
    part("R6", "R", "4.7k DNP", FP_R, {"1": "+3V3", "2": "I2C_SDA"}, "Leave unfitted: the Cardputer bus already has pull-ups"),
    part("R7", "R", "4.7k DNP", FP_R, {"1": "+3V3", "2": "I2C_SCL"}, "Leave unfitted: the Cardputer bus already has pull-ups"),
]

# ── Drawing helpers ───────────────────────────────────────────────────────

DIRS = {0: (1, 0), 90: (0, 1), 180: (-1, 0), 270: (0, -1)}     # lib coords, y up

def r3(v):
    return round(v + 0.0, 3)

def rotate(v, rot):
    """Rotate a lib-coordinate (y up) vector anticlockwise by rot degrees."""
    c, s = round(math.cos(math.radians(rot))), round(math.sin(math.radians(rot)))
    return v[0] * c - v[1] * s, v[0] * s + v[1] * c

class Sheet:
    def __init__(self, parts):
        self.parts = {p["ref"]: p for p in parts}
        self.items = []          # symbol instances
        self.pins = {}           # "REF.num" (or "#PWR..") -> (x, y)
        self.outs = {}           # "REF.num" -> outward direction (dx, dy), sheet coords
        self.wires = []
        self.labels = []
        self.ncs = []
        self.gfx = []
        self.npwr = 0
        self.placed_units = set()

    # symbols
    def put(self, ref, x, y, rot=0, unit=1, txt=None):
        """Place a part. Two-pin parts: rot 0 = pin 1 on top, rot 90 = pin 1 on the left.
        txt = (dx, dy, justify) moves the reference/value text off the wires."""
        p = self.parts[ref]
        self._place(ref, p["key"], x, y, rot, unit, p["value"], p["fp"], p["note"], "DNP" in p["value"],
                    p["key"] not in ("MH", "TP"))
        self.items[-1]["txt"] = txt
        self.placed_units.add((ref, unit))

    def _place(self, ref, key, x, y, rot, unit, value, fp, note, dnp, in_bom):
        pins = SYMS[key]["units"][unit]["pins"]
        for p in pins:
            lx, ly = rotate((p["x"], p["y"]), rot)
            pos = (r3(x + lx), r3(y - ly))
            bx, by = rotate(DIRS[p["ang"]], rot)
            if ref.startswith("#"):
                self.pins[ref] = pos
            else:
                self.pins[f"{ref}.{p['num']}"] = pos
                self.outs[f"{ref}.{p['num']}"] = (-bx, by)
        self.items.append(dict(ref=ref, key=key, x=r3(x), y=r3(y), rot=rot, unit=unit, value=value, fp=fp,
                               note=note, dnp=dnp, in_bom=in_bom, pins=[p["num"] for p in pins]))

    def P(self, a):
        return self.pins[a] if isinstance(a, str) else (r3(a[0]), r3(a[1]))

    def wire(self, *pts, vfirst=False):
        """Wire through the given points (pin names like 'R1.2' or (x, y)).
        A diagonal step becomes an L, horizontal first unless vfirst."""
        ps = [self.P(p) for p in pts]
        out = [ps[0]]
        for b in ps[1:]:
            a = out[-1]
            if a[0] != b[0] and a[1] != b[1]:
                out.append((a[0], b[1]) if vfirst else (b[0], a[1]))
            out.append(b)
        for a, b in zip(out, out[1:]):
            if a != b:
                self.wires.append((a, b))
        return out[-1]

    def stub(self, pinref, n=1):
        x, y = self.pins[pinref]
        dx, dy = self.outs[pinref]
        end = (r3(x + dx * G * n), r3(y + dy * G * n))
        self.wire(pinref, end)
        return end

    def label(self, at, net, n=1, d=None):
        """Net label at the end of a stub from a pin, or at a bare point facing d."""
        if isinstance(at, str):
            d = d or self.outs[at]
            end = self.stub(at, n)
        else:
            end = self.P(at)
        ang, just = {(-1, 0): (180, "right"), (1, 0): (0, "left"),
                     (0, -1): (90, "left"), (0, 1): (270, "right")}[tuple(d)]
        self.labels.append((net, end, ang, just))
        return end

    def power(self, at, kind, n=1):
        """Power symbol at the end of a stub from a pin, pointing away from the
        pin (so a GND on a sideways pin lies on its side), or upright at a point."""
        rot = 0
        if isinstance(at, str):
            d = self.outs[at]
            end = self.stub(at, n)
            body = (0, -1) if kind == "GND" else (0, 1)              # lib direction of the body
            rot = next(r for r in (0, 90, 180, 270)
                       if (lambda v: (v[0], -v[1]))(rotate(body, r)) == tuple(d))
        else:
            end = self.P(at)
        self.npwr += 1
        self._place(f"#PWR0{self.npwr:02d}", kind, end[0], end[1], rot, 1, kind, "", "", False, False)
        return end

    def flag(self, at):
        self.npwr += 1
        p = self.P(at)
        self._place(f"#FLG0{self.npwr:02d}", "PWR_FLAG", p[0], p[1], 0, 1, "PWR_FLAG", "", "", False, False)

    def nc(self, *pinrefs):
        for p in pinrefs:
            self.ncs.append(self.pins[p])

    def frame(self, x1, y1, w, h, title, note=""):
        x2, y2 = r3(x1 + w), r3(y1 + h)
        self.gfx.append(f'(rectangle (start {x1} {y1}) (end {x2} {y2}) (stroke (width 0.25) (type dash) '
                        f'(color 120 120 120 1)) (fill (type none)) (uuid "{U()}"))')
        self.text(r3(x1 + 2.54), r3(y1 + 6.35), title, 2.0, bold=True)
        if note:
            self.text(r3(x1 + 2.54), r3(y2 - 2.54), note)

    def text(self, x, y, s, size=1.27, bold=False):
        b = " bold" if bold else ""
        self.gfx.append(f'(text "{s}" (exclude_from_sim no) (at {x} {y} 0) '
                        f'(effects (font (size {size} {size}){b}) (justify left bottom)) (uuid "{U()}"))')

    def finalise(self):
        """Split wires wherever another wire or a pin ends on them, and put a
        junction dot wherever three or more things meet."""
        def inside(p, a, b):
            if a[0] == b[0] == p[0]:
                return min(a[1], b[1]) < p[1] < max(a[1], b[1])
            if a[1] == b[1] == p[1]:
                return min(a[0], b[0]) < p[0] < max(a[0], b[0])
            return False
        ends = {e for w in self.wires for e in w} | set(self.pins.values())
        i = 0
        while i < len(self.wires):
            a, b = self.wires[i]
            p = next((p for p in ends if inside(p, a, b)), None)
            if p:
                self.wires[i:i + 1] = [(a, p), (p, b)]
            else:
                i += 1
        count = {}
        for w in self.wires:
            for e in w:
                count[e] = count.get(e, 0) + 1
        for p in self.pins.values():
            if p in count:
                count[p] += 1
        self.junctions = [p for p, n in count.items() if n >= 3]

    def emit(self, name, root, title):
        self.finalise()
        used = sorted({it["key"] for it in self.items})
        o = ['(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")',
             f'(uuid "{root}")', '(paper "A3")',
             f'(title_block (title "{title}") (company "BioMapping") '
             '(comment 1 "Generated by hardware/tools/gen_kicad.py - check before ordering"))',
             '(lib_symbols ' + " ".join(lib_symbol(k) for k in used) + ')']
        for p in self.junctions:
            o.append(f'(junction (at {p[0]} {p[1]}) (diameter 0) (color 0 0 0 0) (uuid "{U()}"))')
        for p in self.ncs:
            o.append(f'(no_connect (at {p[0]} {p[1]}) (uuid "{U()}"))')
        for a, b in self.wires:
            o.append(f'(wire (pts (xy {a[0]} {a[1]}) (xy {b[0]} {b[1]})) (stroke (width 0) (type default)) (uuid "{U()}"))')
        for net, (x, y), ang, just in self.labels:
            o.append(f'(label "{net}" (at {x} {y} {ang}) (fields_autoplaced yes) '
                     f'(effects (font (size 1.27 1.27)) (justify {just} bottom)) (uuid "{U()}"))')
        o.extend(self.gfx)
        for it in self.items:
            o.extend(self._instance(name, root, it))
        o.append('(sheet_instances (path "/" (page "1"))))')
        return "\n".join(o) + "\n"

    def _instance(self, name, root, it):
        s = SYMS[it["key"]]
        x, y, rot = it["x"], it["y"], it["rot"]
        pw = it["ref"].startswith("#")
        o = [f'(symbol (lib_id "BioMap:{s["name"]}") (at {x} {y} {rot}) (unit {it["unit"]}) '
             f'(exclude_from_sim no) (in_bom {"yes" if it["in_bom"] else "no"}) (on_board {"no" if pw else "yes"}) '
             f'(dnp {"yes" if it["dnp"] else "no"}) (uuid "{U()}")']
        fa = (-rot) % 360          # field angles are relative to the symbol: undo its rotation
        def prop(k, v, px, py, shown=True, just=""):
            eff = (f'(effects (font (size 1.27 1.27)){f" (justify {just})" if just else ""})' if shown else FONT_HIDE)
            o.append(f'(property "{k}" "{v}" (at {r3(px)} {r3(py)} {fa}) {eff})')
        if pw:
            prop("Reference", it["ref"], x, y, shown=False)
            if it["key"] == "PWR_FLAG":
                prop("Value", "PWR_FLAG", x, y, shown=False)
            else:
                body = (0, -1) if it["key"] == "GND" else (0, 1)
                bx, by = rotate(body, rot)
                dist = 4.3 if by else 3.0 + 1.0 * len(it["value"])
                prop("Value", it["value"], x + bx * dist, y - by * dist)
        else:
            tx, ty, just, gap = self._text_spot(it)
            prop("Reference", it["ref"], tx, ty, just=just)
            prop("Value", it["value"], tx, ty + gap, just=just)
        prop("Footprint", it["fp"], x, y, shown=False)
        prop("Datasheet", "", x, y, shown=False)
        prop("Description", "", x, y, shown=False)
        if it["note"]:
            prop("Note", it["note"], x, y, shown=False)
        for n in it["pins"]:
            o.append(f'(pin "{n}" (uuid "{U()}"))')
        o.append(f'(instances (project "{name}" (path "/{root}" (reference "{it["ref"]}") (unit {it["unit"]})))))')
        return o

    def _text_spot(self, it):
        """Where the reference and value text go: (x, y, justify, gap to value)."""
        key, x, y, rot = it["key"], it["x"], it["y"], it["rot"]
        if it.get("txt"):
            dx, dy, just = it["txt"]
            return x + dx, y + dy, just, 2.0
        if key in ("R", "C", "FB", "BT"):
            if rot in (0, 180):
                return x + 2.54, y - 1.27, "left", 2.54       # upright part: text to the right
            return x, y - 2.8, "", 5.6                         # level part: name above, value below
        if key == "D":
            return x, y - 2.8, "", 5.6
        if key == "TP":
            return x, y - 6.4, "", -2.0
        if key == "MCP6002":
            if it["unit"] < 3:
                return x + 1.27, y - 7.6, "left", 2.0
            return x + 2.54, y - 1.27, "left", 2.54
        if key == "MH":
            return x + 2.54, y - 1.27, "left", 2.54
        top = min([py for k, (px, py) in self.pins.items() if k.split(".")[0] == it["ref"]] + [y])
        return x, top - 7.1, "", 2.0

# ── Sheet layouts ─────────────────────────────────────────────────────────
# Sheet coordinates in mm, y down, on the 2.54 mm grid. Each block sits in a
# dashed frame; blocks talk to each other through net labels.

def g(n):
    return r3(n * G)

ROW1, ROW2 = g(10), g(57)            # frame tops
H1, H2 = g(44), g(42)                # frame heights

def draw_tia(s, x0, y0):
    s.frame(x0, y0, g(58), H2, "1  Skin sensor: current-to-voltage amplifier",
            "R3 + R4 (9.4 kOhm) keep skin current safe. R5 || C2 set the gain (47 kOhm) and a ~34 Hz low-pass.")
    jx, jy = x0 + g(8), y0 + g(22)
    s.put("J2", jx, jy, txt=(-2.54, 8.0, "left"))
    p1, p2 = s.pins["J2.1"], s.pins["J2.2"]
    # electrode 1 -> R3 -> GND, one row up
    ry = p1[1] - g(5)
    s.put("R3", p1[0] + g(5), ry, rot=90)
    s.wire("J2.1", (p1[0] + g(2), p1[1]), (p1[0] + g(2), ry), "R3.1")
    s.power("R3.2", "GND", n=1)
    # electrode 2 -> R4 -> TIA input
    s.put("R4", p2[0] + g(5), p2[1], rot=90)
    s.wire("J2.2", "R4.1")
    ux = p2[0] + g(18)                         # U1A "-" input sits on electrode 2's row
    s.put("U1", ux, p2[1] + g(1), unit=1)
    minus, plus, out = s.pins["U1.2"], s.pins["U1.3"], s.pins["U1.1"]
    node = (minus[0] - g(4), minus[1])
    s.wire("R4.2", node, "U1.2")
    # feedback: R5 and C2 in parallel above the amplifier
    oc = (out[0] + g(2), out[1])
    r5y, c2y = out[1] - g(6), out[1] - g(10)
    s.put("R5", ux, r5y, rot=90)
    s.put("C2", ux, c2y, rot=90)
    s.wire(node, (node[0], r5y), "R5.1")
    s.wire((node[0], r5y), (node[0], c2y), "C2.1")
    s.wire("C2.2", (oc[0], c2y), (oc[0], r5y), oc)
    s.wire("R5.2", (oc[0], r5y))
    s.wire("U1.1", oc, (oc[0] + g(6), oc[1]))
    s.label((oc[0] + g(6), oc[1]), "GSR_SIGNAL", d=(1, 0))
    # + input: the 0.5 V reference
    s.label("U1.3", "REF_0V5", n=3)

def draw_ref(s, x0, y0):
    s.frame(x0, y0, g(40), H2, "2  0.5 V reference and op-amp supply",
            "56k / 10k from 3.3 V = 0.50 V. C1 sits against U1 pins 8 and 4.")
    ux, uy = x0 + g(26), y0 + g(15)
    s.put("U1", ux, uy, unit=2)
    plus, minus, out = s.pins["U1.5"], s.pins["U1.6"], s.pins["U1.7"]
    rx = x0 + g(9)
    s.put("R1", rx, plus[1] - g(4) - 1.27)
    s.put("R2", rx, plus[1] + g(4) + 1.27)
    s.power("R1.1", "+3V3")
    s.power("R2.2", "GND")
    s.wire("R1.2", "R2.1")
    s.wire((rx, plus[1]), "U1.5")
    # follower: output straight back to the "-" input
    top = minus[1] - g(3)
    oc = (out[0] + g(2), out[1])
    s.wire("U1.6", (minus[0] - g(2), minus[1]), (minus[0] - g(2), top), (oc[0], top), oc)
    s.wire("U1.7", oc, (oc[0] + g(3), oc[1]))
    s.label((oc[0] + g(3), oc[1]), "REF_0V5", d=(1, 0))
    # op-amp supply and its decoupling capacitor
    px, py = ux, y0 + g(32)
    s.put("U1", px, py, unit=3)
    s.put("C1", px - g(8), py)
    s.power("U1.8", "+3V3"); s.power("U1.4", "GND")
    s.power("C1.1", "+3V3"); s.power("C1.2", "GND")

def draw_adc(s, x0, y0):
    s.frame(x0, y0, g(48), H2, "3  Analogue-to-digital converter",
            "Measures GSR_SIGNAL against REF_0V5 (AIN0 - AIN1). ADDR to GND = I2C address 0x48.")
    ux, uy = x0 + g(24), y0 + g(23)
    s.put("U2", ux, uy, txt=(2.54, -14.5, "left"))
    s.label("U2.4", "GSR_SIGNAL", n=4)
    s.label("U2.5", "REF_0V5", n=4)
    s.nc("U2.6", "U2.7", "U2.2")
    s.label("U2.9", "I2C_SDA", n=4)
    s.label("U2.10", "I2C_SCL", n=4)
    s.power("U2.1", "GND", n=2)
    s.power("U2.3", "GND")
    vdd = s.pins["U2.8"]
    rail = (vdd[0], vdd[1] - g(8))
    cx = vdd[0] - g(6)
    s.put("C3", cx, rail[1] + g(2) + 1.27)
    s.wire("U2.8", rail, (cx, rail[1]), "C3.1")
    s.power(rail, "+3V3")
    s.power("C3.2", "GND")

def draw_gps(s, x0, y0):
    s.frame(x0, y0, g(66), H1, "5  GPS: u-blox SAM-M10Q with built-in antenna",
            "VCC and V_IO tied. The backup cell keeps satellite data, so the GPS restarts in seconds.")
    ux, uy = x0 + g(30), y0 + g(26)
    s.put("U4", ux, uy, txt=(5.08, 10.6, "left"))
    vcc, vio, bck = s.pins["U4.17"], s.pins["U4.2"], s.pins["U4.3"]
    rail = vcc[1] - g(8)
    # 3.3 V rail across the top: two capacitors, VCC, V_IO, then the backup charger
    c6x, c7x, px = x0 + g(6), x0 + g(11), x0 + g(17)
    for ref, x in (("C6", c6x), ("C7", c7x)):
        s.put(ref, x, rail + g(3) + 1.27)
        s.wire((x, rail), f"{ref}.1")
        s.power(f"{ref}.2", "GND")
    s.wire((c6x, rail), (vio[0] + g(4), rail))
    s.power((px, rail), "+3V3")
    s.wire("U4.17", (vcc[0], rail))
    s.wire("U4.2", (vio[0], rail))
    s.put("D1", vio[0] + g(4) + 3.81, rail)                  # anode on the rail
    s.put("R8", s.pins["D1.1"][0] + g(1) + 3.81, rail, rot=90)
    s.wire("D1.1", "R8.1")
    node = (s.pins["R8.2"][0] + g(2), rail)
    btx, c8x = node[0] + g(4), node[0] + g(8)
    s.wire("R8.2", node, (c8x, rail))
    s.wire(node, (node[0], bck[1] - g(3)), (bck[0], bck[1] - g(3)), "U4.3")
    for ref, x in (("BT1", btx), ("C8", c8x)):
        s.put(ref, x, rail + g(3) + 1.27)
        s.wire((x, rail), f"{ref}.1")
        s.power(f"{ref}.2", "GND")
    # serial port through 470 ohm resistors, on separate rows
    txd, rxd = s.pins["U4.13"], s.pins["U4.14"]
    s.put("R10", txd[0] + g(5) + 3.81, txd[1], rot=90)
    s.wire("U4.13", "R10.1")
    s.label("R10.2", "GPS_TX_TO_HOST", n=3)
    ry = uy + g(5)
    s.put("R9", txd[0] + g(5) + 3.81, ry, rot=90)
    s.wire("U4.14", (rxd[0] + g(2), rxd[1]), (rxd[0] + g(2), ry), "R9.1")
    s.label("R9.2", "HOST_TX_TO_GPS", n=3)
    s.nc("U4.9", "U4.12", "U4.19", "U4.7")
    # reset and safeboot test pads
    s.put("TP2", s.pins["U4.18"][0] - g(4), s.pins["U4.18"][1])
    s.wire("U4.18", "TP2.1")
    s.put("TP1", s.pins["U4.8"][0] - g(9), s.pins["U4.8"][1])
    s.wire("U4.8", "TP1.1")
    s.power("U4.1", "GND")

def draw_pullups(s, x, y):
    """I2C pull-ups as a small cluster joined by labels (no crossing wires)."""
    for i, (ref, net) in enumerate((("R6", "I2C_SDA"), ("R7", "I2C_SCL"))):
        s.put(ref, x + g(6 * i), y)
        s.power(f"{ref}.1", "+3V3")
        s.label(f"{ref}.2", net, n=1)

def draw_flipper_conn(s, x0, y0):
    s.frame(x0, y0, g(38), H1, "4  Flipper Zero GPIO",
            "Both headers are right-angled. J1 carries only GND; it holds the board steady.")
    jx = x0 + g(8)
    s.put("J4", jx, y0 + g(16))
    s.power("J4.1", "+3V3", n=2)
    s.flag((s.pins["J4.1"][0] + G, s.pins["J4.1"][1]))
    s.power("J4.3", "GND", n=2)
    s.power("J4.10", "GND", n=2)
    s.flag((s.pins["J4.10"][0] + G, s.pins["J4.10"][1]))
    s.nc("J4.2", "J4.4", "J4.9")
    for pn, net in (("5", "HOST_TX_TO_GPS"), ("6", "GPS_TX_TO_HOST"), ("7", "I2C_SDA"), ("8", "I2C_SCL")):
        s.label(f"J4.{pn}", net, n=4)
    s.put("J1", jx, y0 + g(33))
    s.nc(*[f"J1.{i}" for i in range(1, 8)])
    s.power("J1.8", "GND", n=2)
    draw_pullups(s, x0 + g(26), y0 + g(29))

def draw_cardputer_conn(s, x0, y0):
    s.frame(x0, y0, g(38), H1, "4  Cardputer ADV EXT header",
            "Pin 2 (5 V in) stays open. R6/R7 not fitted: the Cardputer has pull-ups.")
    jx = x0 + g(10)
    s.put("J1", jx, y0 + g(19))
    s.nc(*[f"J1.{i}" for i in (1, 3, 5, 7, 9, 11, 13, 2)])
    s.power("J1.4", "GND", n=2)
    s.flag((s.pins["J1.4"][0] + G, s.pins["J1.4"][1]))
    for pn, net in (("6", "+5V_EXT"), ("8", "I2C_SDA"), ("10", "I2C_SCL"),
                    ("12", "HOST_TX_TO_GPS"), ("14", "GPS_TX_TO_HOST")):
        s.label(f"J1.{pn}", net, n=4)
    draw_pullups(s, x0 + g(26), y0 + g(29))
    s.put("H1", x0 + g(6), y0 + g(33))
    s.put("H2", x0 + g(6), y0 + g(37))

def draw_regulator(s, x0, y0):
    s.frame(x0, y0, g(42), H1, "6  5 V to 3.3 V regulator",
            "FB1 blocks the Cardputer's switching noise; U3 makes a clean 3.3 V for everything.")
    line = y0 + g(16)
    s.put("FB1", x0 + g(10), line, rot=90)
    s.label(s.wire("FB1.1", (x0 + g(5), line)), "+5V_EXT", d=(-1, 0))
    ux = x0 + g(26)
    s.put("U3", ux, line + g(1))
    inp, en, out = s.pins["U3.1"], s.pins["U3.3"], s.pins["U3.5"]
    c4x, tie = x0 + g(15), inp[0] - g(2)
    s.put("C4", c4x, line + g(3) + 1.27)
    s.wire("FB1.2", (c4x, line), "U3.1")
    s.wire((c4x, line), "C4.1")
    s.wire((tie, line), (tie, en[1]), "U3.3")
    s.power("C4.2", "GND")
    s.power("U3.2", "GND")
    s.nc("U3.4")
    c5x = out[0] + g(4)
    s.put("C5", c5x, line + g(3) + 1.27)
    s.wire("U3.5", (c5x + g(4), line))
    s.wire((c5x, line), "C5.1")
    s.power("C5.2", "GND")
    s.power((c5x + g(4), line), "+3V3")
    s.flag((c5x + g(2), line))

def draw_sheet(name, parts):
    s = Sheet(parts)
    draw_tia(s, g(8), ROW2)
    draw_ref(s, g(69), ROW2)
    draw_adc(s, g(112), ROW2)
    if name == "biomap_flipper":
        draw_flipper_conn(s, g(8), ROW1)
        draw_gps(s, g(49), ROW1)
    else:
        draw_cardputer_conn(s, g(8), ROW1)
        draw_gps(s, g(49), ROW1)
        draw_regulator(s, g(118), ROW1)
    missing = {(p["ref"], u) for p in parts for u in SYMS[p["key"]]["units"]} - s.placed_units
    assert not missing, f"{name}: parts not drawn: {sorted(missing)}"
    return s

# ── Writer ────────────────────────────────────────────────────────────────

def write_project(out, name, title, parts):
    d = os.path.join(out, name)
    os.makedirs(d, exist_ok=True)
    root = U()
    s = draw_sheet(name, parts)
    with open(os.path.join(d, f"{name}.kicad_sch"), "w") as f:
        f.write(s.emit(name, root, title))
    with open(os.path.join(d, "BioMap.kicad_sym"), "w") as f:
        f.write('(kicad_symbol_lib (version 20231120) (generator "kicad_symbol_editor") (generator_version "8.0")\n'
                + "\n".join(lib_symbol(k, prefix="") for k in sorted(SYMS)) + ")\n")
    with open(os.path.join(d, "sym-lib-table"), "w") as f:
        f.write('(sym_lib_table (version 7)\n  (lib (name "BioMap") (type "KiCad") (uri "${KIPRJMOD}/BioMap.kicad_sym") (options "") (descr "BioMapping project symbols")))\n')
    with open(os.path.join(d, f"{name}.kicad_pro"), "w") as f:
        json.dump({"meta": {"filename": f"{name}.kicad_pro", "version": 3},
                   "board": {"design_settings": {"rules": {"min_clearance": 0.15, "min_track_width": 0.15},
                                                 "rule_severities": {"silk_edge_clearance": "ignore"}}},
                   "net_settings": {"meta": {"version": 3}, "classes": [
                       {"name": "Default", "clearance": 0.15, "track_width": 0.3,
                        "via_diameter": 0.7, "via_drill": 0.35, "wire_width": 6, "bus_width": 12,
                        "line_style": 0, "priority": 2147483647}]},
                   "sheets": [[root, "Root"]]}, f, indent=2)
    with open(os.path.join(d, "bom.csv"), "w") as f:
        f.write("Reference,Value,Footprint,Note\n")
        for p in parts:
            f.write(f'{p["ref"]},"{p["value"]}",{p["fp"]},"{p["note"]}"\n')
    return {f'{p["ref"]}.{n}': net for p in parts for n, net in p["pins"].items()}

if __name__ == "__main__":
    out = sys.argv[1]
    exp = {"biomap_flipper": write_project(out, "biomap_flipper", "BioMapping 2 - Flipper Zero board", FLIPPER),
           "biomap_cardputer": write_project(out, "biomap_cardputer", "BioMapping 2 - Cardputer ADV Cap", CARDPUTER)}
    json.dump(exp, open(sys.argv[2], "w"), indent=1)
