"""Generate the KiCad schematics, project files and BOMs for the BioMapping
boards: the Flipper board, the Cardputer board and the Cardputer's flex tail
(a flexible strip soldered to the Cardputer board, with the EXT header on its
other end).

Two separate descriptions of each board live here:
  * FLIPPER / CARDPUTER / CARDPUTER_TAIL parts tables - which pin connects to which net.
    This is the intent.
  * draw_* functions - where each symbol sits on the sheet and how the wires
    run. This is the drawing.
check_sch.py and check_netlist.py prove the drawing matches the parts
tables pin for pin."""
import json, math, os, uuid

from . import rules
from .boards import LAYOUTS

G = 2.54                                   # schematic grid (100 mil)

# IDs are derived from the board name and a counter, not drawn at random, so
# regenerating an unchanged board writes an identical file and git diffs show
# only real changes.
_ID_NS = uuid.UUID("5b0e0c86-6f63-4c43-9d3e-8e5d0f0b1a11")
_ids = {"board": "", "n": 0}

def reset_ids(board):
    _ids.update(board=board, n=0)

def U():
    _ids["n"] += 1
    return str(uuid.uuid5(_ID_NS, f'{_ids["board"]}:{_ids["n"]}'))

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
CAP_POL = CAP + poly((-1.778, 1.778), (-0.762, 1.778), width=0.254) + poly((-1.27, 2.286), (-1.27, 1.27), width=0.254)
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
    "CP": two_pin_v("C_Polarized", "C", CAP_POL),
    "FB": two_pin_v("FerriteBead", "FB", BEAD),
    "BT": two_pin_v("Battery_Cell", "BT", CELL, "+", "-"),
    "D": sym("D_Schottky", "D", {1: dict(
        pins=[pin("1", "K", 3.81, 0, 180, 1.27), pin("2", "A", -3.81, 0, 0, 1.27)],
        body=(poly((1.27, 1.27), (1.27, -1.27), width=0.254) + poly((1.27, 1.27), (1.778, 1.27), (1.778, 1.016))
              + poly((1.27, -1.27), (0.762, -1.27), (0.762, -1.016))
              + poly((-1.27, 1.27), (1.27, 0), (-1.27, -1.27), (-1.27, 1.27)) + poly((-2.54, 0), (2.54, 0), width=0)))},
        show_numbers=False),
    "OPA2333": sym("OPA2333", "U", {
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
FP_TP = "TestPoint:TestPoint_Pad_D1.0mm"
PREC = "Sets the GSR scale. Use 0.1% parts"

# What to buy for each value: (manufacturer, manufacturer part number, LCSC
# number). LCSC is the parts store JLCPCB assembles from; "" = LCSC has none.
# The everyday resistors and capacitors are JLCPCB "basic" parts (no extra
# fitting fee).
BUY = {
    "4.7k":          ("UNI-ROYAL", "0805W8F4701T5E", "C17673"),
    "3.3k":          ("UNI-ROYAL", "0805W8F3301T5E", "C26010"),
    "470":           ("UNI-ROYAL", "0805W8F4700T5E", "C17710"),
    "47k 0.1%":      ("RESI", "PTFR0805B47K0P9", "C479101"),
    "56k 0.1%":      ("RESI", "PTFR0805B56K0P9", "C2849276"),
    "10k 0.1%":      ("RESI", "PTFR0805B10K0P9", "C478887"),
    "4.7k 0.1%":     ("RESI", "PTFR0805B4K70P9", "C2849257"),
    "100nF":         ("YAGEO", "CC0805KRX7R9BB104", "C49678"),
    "1uF":           ("Samsung", "CL21B105KBFNNNE", "C28323"),
    "100nF C0G":     ("FH (Guangdong Fenghua)", "1206CG104J500NT", "C46348"),
    "10uF":          ("Samsung", "CL21A106KAYNNNE", "C15850"),
    "10uF tantalum": ("Kyocera AVX", "TAJP106M010RNJ", "C1952866"),
    "600R@100MHz":   ("Sunlord", "GZ2012D601TF", "C1017"),
    "OPA2333AIDR":   ("Texas Instruments", "OPA2333AIDR", "C38732"),
    "ADS1115IDGSR":  ("Texas Instruments", "ADS1115IDGSR", "C37593"),
    "TLV75533PDBVR": ("Texas Instruments", "TLV75533PDBVR", "C404027"),
    "RB751V-40":     ("Jiangsu Changjing", "RB751V-40", "C77353"),
    "SAM-M10Q-00B":  ("u-blox", "SAM-M10Q-00B", ""),
    "MS421R":        ("Seiko Instruments", "MS421R-IV03E", ""),
    "Grove GSR finger cuffs": ("JST", "S2B-PH-SM4-TB(LF)(SN)", "C295747"),
    "Flipper GPIO 9-18": ("XKB Connection", "X2530WR-10-PTSN", "C400348"),
    "Flipper GPIO 1-8":  ("", "", ""),
    "Cardputer ADV EXT header": ("", "", ""),
    "JST GH 8-pin socket": ("JST", "SM08B-GHS-TB(LF)(SN)", ""),
}

def part(ref, key, value, fp, pins, note=""):
    mfr, mpn, lcsc = BUY.get(value, ("", "", ""))
    return dict(ref=ref, key=key, value=value, fp=fp, pins=pins, note=note, mfr=mfr, mpn=mpn, lcsc=lcsc)

def gsr_core(adc_ready=None, tantalum_bias=False):
    """The validated GSR circuit (docs/wiring_guide.md), shared by both boards.
    adc_ready names the net on the ADC's ALERT/RDY pin (None: not connected).
    tantalum_bias: C9 is a tantalum part instead of a ceramic one. A ceramic
    capacitor turns knocks into small voltages, and anything added to the
    0.5 V shows in the GSR; the Cardputer's C9 sits behind its keyboard and
    speaker."""
    bias_cap = (part("C9", "CP", "10uF tantalum", "Capacitor_Tantalum_SMD:CP_EIA-2012-15_AVX-P",
                     {"1": "BIAS_DIV", "2": "GND"},
                     "Smooths the 0.5 V bias: noise on 3.3 V would otherwise change the GSR gain. "
                     "Tantalum, + (pad 1) to the 0.5 V: a ceramic one turns knocks into small voltages")
                if tantalum_bias else
                part("C9", "C", "10uF", FP_C, {"1": "BIAS_DIV", "2": "GND"},
                     "Smooths the 0.5 V bias: noise on 3.3 V would otherwise change the GSR gain"))
    return [
        part("J2", "Conn_1x02", "Grove GSR finger cuffs", "Connector_JST:JST_PH_S2B-PH-SM4-TB_1x02-1MP_P2.00mm_Horizontal",
             {"1": "ELECTRODE_1", "2": "ELECTRODE_2"},
             "JST PH 2.0 mm side-entry socket for the Grove GSR finger-cuff plug. Surface-mount; the two side tabs only hold it down"),
        part("R3", "R", "4.7k 0.1%", FP_R, {"1": "ELECTRODE_1", "2": "GND"},
             "Skin current limit. The firmware subtracts R3 + R4 = 9.4k: use 0.1% parts"),
        part("R4", "R", "4.7k 0.1%", FP_R, {"1": "ELECTRODE_2", "2": "TIA_IN"},
             "Skin current limit. The firmware subtracts R3 + R4 = 9.4k: use 0.1% parts"),
        part("U1", "OPA2333", "OPA2333AIDR", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
             {"1": "GSR_SIGNAL", "2": "TIA_IN", "3": "REF_0V5", "4": "GND",
              "5": "BIAS_DIV", "6": "REF_0V5", "7": "REF_0V5", "8": "+3V3"},
             "Zero-drift op-amp: offset under 10 uV, so the 0.5 V across the skin stays exact. "
             "Same pins as the MCP6002 on the prototype"),
        part("R5", "R", "47k 0.1%", FP_R, {"1": "TIA_IN", "2": "GSR_SIGNAL"}, "TIA gain. " + PREC),
        part("C2", "C", "100nF C0G", "Capacitor_SMD:C_1206_3216Metric", {"1": "TIA_IN", "2": "GSR_SIGNAL"}, "TIA filter (~34 Hz). C0G/NP0 only. 1206 size: 100 nF C0G is hard to find in 0805"),
        part("R1", "R", "56k 0.1%", FP_R, {"1": "+3V3", "2": "BIAS_DIV"}, "0.5 V bias. " + PREC),
        part("R2", "R", "10k 0.1%", FP_R, {"1": "BIAS_DIV", "2": "GND"}, "0.5 V bias. " + PREC),
        bias_cap,
        part("C1", "C", "100nF", FP_C, {"1": "+3V3", "2": "GND"}, "Op-amp decoupling: against U1 pins 8 and 4"),
        part("U2", "ADS1115", "ADS1115IDGSR", "Package_SO:MSOP-10_3x3mm_P0.5mm",
             {"4": "GSR_SIGNAL", "5": "REF_0V5", "6": None, "7": None, "3": "GND",
              "8": "+3V3", "9": "I2C_SDA", "10": "I2C_SCL", "1": "GND", "2": adc_ready}, "I2C address 0x48 (ADDR to GND)"),
        part("C3", "C", "100nF", FP_C, {"1": "+3V3", "2": "GND"}, "ADC decoupling: against U2 pins 8 and 3"),
        part("TP3", "TP", "GSR", FP_TP, {"1": "GSR_SIGNAL"}, "Test pad: amplifier output"),
        part("TP4", "TP", "0.5V", FP_TP, {"1": "REF_0V5"}, "Test pad: 0.5 V reference"),
        part("TP5", "TP", "GND", FP_TP, {"1": "GND"}, "Test pad: ground, for the meter or scope"),
    ] + ([part("TP8", "TP", "RDY", FP_TP, {"1": adc_ready},
               "Test pad: ADC reading-ready pulses (860 a second), for a scope or logic analyser")]
         if adc_ready else [])

def gps_block(backup_cap="100nF"):
    """u-blox SAM-M10Q on the board, wired like the SparkFun GPS-21834 breakout.
    backup_cap is C8 on the backup pin: SparkFun's 100 nF, or more to cover the
    short current burst when the GPS switches over to the cell (u-blox warns
    against a high resistance on that pin, and the cell's own is about 600 ohm)."""
    return [
        part("U4", "SAM-M10Q", "SAM-M10Q-00B", "RF_GPS:ublox_SAM-M8Q",
             {"17": "+3V3", "2": "+3V3", "3": "GPS_BCKP", "13": "GPS_TXD", "14": "GPS_RXD",
              "18": "GPS_RESET_N", "8": "GPS_SAFEBOOT_N", "19": None, "7": None, "9": None, "12": None,
              **{n: "GND" for n in ["1", "4", "5", "6", "10", "11", "15", "16", "20"]}},
             "GPS with built-in patch antenna. Pin-compatible with the SAM-M8Q footprint. Needs the ground plane around it. LCSC has none: buy from Mouser or Digi-Key and send to the assembler"),
        part("C6", "C", "10uF", FP_C, {"1": "+3V3", "2": "GND"}, "GPS supply reservoir"),
        part("C7", "C", "100nF", FP_C, {"1": "+3V3", "2": "GND"}, "GPS decoupling: against U4 VCC"),
        part("D1", "D", "RB751V-40", "Diode_SMD:D_SOD-323", {"2": "+3V3", "1": "BCKP_CHG"},
             "Stops the backup cell feeding the 3.3 V rail. Low-leakage type (0.5 uA max): a power "
             "Schottky leaks several uA back from the cell, on top of the GPS's own 28 uA"),
        part("R8", "R", "3.3k", FP_R, {"1": "BCKP_CHG", "2": "GPS_BCKP"}, "Backup cell charge current limit"),
        part("BT1", "BT", "MS421R", "BioMap:Seiko_MS421R_IV03E", {"1": "GPS_BCKP", "2": "GND"},
             "Rechargeable 3 V 1.5 mAh backup cell, reflow-solderable (as on SparkFun GPS-21834). Rated 10 uA at most; "
             "the switched-off GPS draws 28 uA, so it keeps satellite data for about a day at most. Farnell 3534555"),
        part("C8", "C", backup_cap, FP_C, {"1": "GPS_BCKP", "2": "GND"}, "Backup supply decoupling"),
        part("R9", "R", "470", FP_R, {"1": "GPS_RXD", "2": "HOST_TX_TO_GPS"}, "Series resistor on GPS RX"),
        part("R10", "R", "470", FP_R, {"1": "GPS_TXD", "2": "GPS_TX_TO_HOST"}, "Series resistor on GPS TX"),
        part("TP1", "TP", "SAFEBOOT/PPS", "TestPoint:TestPoint_Pad_1.5x1.5mm", {"1": "GPS_SAFEBOOT_N"},
             "Also the GPS time pulse: joined inside the module to TIMEPULSE through 1k, so once the GPS "
             "has the time it goes high for 0.1 s at the start of each second. Short to TP6 (GND) at "
             "power-up for safeboot mode. Nothing may pull it low at power-up"),
        part("TP2", "TP", "RESET", "TestPoint:TestPoint_Pad_1.5x1.5mm", {"1": "GPS_RESET_N"},
             "Short to TP7 (GND) to reset the GPS. Clears its stored data: the next fix is a cold start"),
        *[part(ref, "TP", "GND", "TestPoint:TestPoint_Pad_1.5x1.5mm", {"1": "GND"},
               "Ground beside TP1 (TP6) and TP2 (TP7): tweezers across the pair, or a scope's ground")
          for ref in ("TP6", "TP7")],
    ]

FLIPPER = gsr_core() + gps_block() + [
    part("J4", "Conn_1x10", "Flipper GPIO 9-18", "Connector_PinHeader_2.54mm:PinHeader_1x10_P2.54mm_Horizontal",
         {"1": "+3V3", "2": None, "3": "GND", "4": None, "5": "HOST_TX_TO_GPS", "6": "GPS_TX_TO_HOST",
          "7": "I2C_SDA", "8": "I2C_SCL", "9": None, "10": "GND"},
         "Flipper pins 9-18: 9 3V3, 11 GND, 13 USART TX, 14 USART RX, 15 PC1 SDA, 16 PC0 SCL, 18 GND. Through-hole"),
    part("J1", "Conn_1x08", "Flipper GPIO 1-8", "Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Horizontal",
         {**{str(i): None for i in range(1, 8)}, "8": "GND"}, "Flipper pins 1-8 (1 = 5V, 8 = GND). Holds the board. Through-hole. Any 2.54 mm right-angle 1x8 male header (e.g. X2530WR-08-PTSN)"),
    part("R6", "R", "4.7k", FP_R, {"1": "+3V3", "2": "I2C_SDA"}, "I2C pull-up"),
    part("R7", "R", "4.7k", FP_R, {"1": "+3V3", "2": "I2C_SCL"}, "I2C pull-up"),
]

# The flex tail's pads (the tail board only; the Cardputer board now takes a
# cable instead, below). Tail pad k sat on the old board's landing pad k.
TAIL_NETS = {"1": "ADC_READY", "2": "GND", "3": "+5V_EXT", "4": "I2C_SCL", "5": "I2C_SDA", "6": "GND",
             "7": "HOST_TX_TO_GPS", "8": "GPS_TX_TO_HOST"}

# The board sits inside a printed back case (hardware/case/README.md) and
# meets the Cardputer through a short cable: its wires are soldered inside the
# Cardputer onto the EXT header's legs, and its plug latches into J1, a JST GH
# socket on the board's inner face. The ADS1115 keeps an I2C bus of its own,
# on G3 (SCL) and G5 (SDA), the two ends of the header's hidden row. The pin
# order suits the board: the GPS pair leaves towards the GPS on the left,
# then ground, 5 V, the I2C pair, a second ground and the ADC's ready line
# (G4: no wire yet, the firmware doesn't use it). Each wire's EXT leg:
CABLE_NETS = {"1": "GPS_TX_TO_HOST", "2": "HOST_TX_TO_GPS", "3": "GND", "4": "+5V_EXT",
              "5": "I2C_SDA", "6": "I2C_SCL", "7": "GND", "8": "ADC_READY"}
CABLE_LEGS = {"1": "G15", "2": "G13", "3": "GND", "4": "5VO", "5": "G5", "6": "G3", "7": "GND", "8": "G4"}

CARDPUTER = gsr_core(adc_ready="ADC_READY", tantalum_bias=True) + gps_block(backup_cap="1uF") + [
    part("J1", "Conn_1x08", "JST GH 8-pin socket", "Connector_JST:JST_GH_SM08B-GHS-TB_1x08-1MP_P1.25mm_Horizontal",
         CABLE_NETS,
         "Cable socket on the INNER face (towards the Cardputer), soldered by hand. Latching, side entry, "
         "4.25 mm tall. Pin to EXT leg: " + ", ".join(f"{k} {v}" for k, v in CABLE_LEGS.items())),
    part("FB1", "FB", "600R@100MHz", "Inductor_SMD:L_0805_2012Metric", {"1": "+5V_EXT", "2": "+5V_F"},
         "Blocks the Cardputer's boost-converter switching noise"),
    part("C4", "C", "10uF", FP_C, {"1": "+5V_F", "2": "GND"}, "Regulator input capacitor"),
    part("U3", "TLV75533", "TLV75533PDBVR", "Package_TO_SOT_SMD:SOT-23-5",
         {"1": "+5V_F", "3": "+5V_F", "2": "GND", "5": "+3V3", "4": None},
         "5 V to 3.3 V regulator (LDO), 500 mA, 1% accuracy, low noise"),
    part("C5", "C", "10uF", FP_C, {"1": "+3V3", "2": "GND"}, "Regulator output capacitor"),
    part("R6", "R", "4.7k", FP_R, {"1": "+3V3", "2": "I2C_SDA"},
         "I2C pull-up to the board's own 3.3 V: the Cardputer has none on G5"),
    part("R7", "R", "4.7k", FP_R, {"1": "+3V3", "2": "I2C_SCL"},
         "I2C pull-up to the board's own 3.3 V: the Cardputer has none on G3"),
    *[part(ref, "MH", "M2", "MountingHole:MountingHole_2.2mm_M2", {},
           "M2 x 5 mm screw from the inner face into a post of the printed case: holds the board in the case")
      for ref in ("H1", "H2")],
    *[part(ref, "MH", "4.8 mm", "BioMap:MountingHole_4.8mm", {},
           "One of the case's two long screw posts (4 mm) passes through here; the board rests on its ledge")
      for ref in ("H3", "H4")],
]
# No pull-up on ADC_READY (the ADS1115's ALERT/RDY pin is open-drain): the
# firmware turns on the ESP32's own pull-up on G4.

CARDPUTER_TAIL = [
    part("J1", "Conn_2x07", "Cardputer ADV EXT header", "BioMap:PinHeader_2x07_P2.54mm_Vertical_Stiffener",
         {"1": None, "2": None, "3": "ADC_READY", "4": "GND", "5": "I2C_SCL", "6": "+5V_EXT", "7": None,
          "8": None, "9": None, "10": None, "11": None, "12": "HOST_TX_TO_GPS",
          "13": "I2C_SDA", "14": "GPS_TX_TO_HOST"},
         "M5 pin table numbering: 3 G4 (ADC ready), 4 GND, 5 G6 SCL, 6 5V OUT, 12 G13, 13 G5 SDA, 14 G15. "
         "Pin 2 is 5V IN - never connect. Pins 8 and 10 (G8/G9, the Cardputer's own I2C bus) stay open. "
         "CHECK numbering and mirroring before ordering. Through-hole, "
         "through the tail's stiffened end. Any 2.54 mm straight 2x7 male header"),
    part("J2", "Conn_1x08", "Flex tail solder pads", "BioMap:FlexTail_Solder_1x08_P1.50mm", TAIL_NETS,
         "Plated pads with 0.7 mm holes, soldered onto the Cardputer board's landing pads. Pad k = board pad k"),
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
        self._place(ref, p["key"], x, y, rot, unit, p["value"], p["fp"], p["note"],
                    p["key"] not in ("MH", "TP"))
        self.items[-1].update(txt=txt, mfr=p["mfr"], mpn=p["mpn"], lcsc=p["lcsc"])
        self.placed_units.add((ref, unit))

    def _place(self, ref, key, x, y, rot, unit, value, fp, note, in_bom):
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
                               note=note, in_bom=in_bom, pins=[p["num"] for p in pins]))

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
        self._place(f"#PWR0{self.npwr:02d}", kind, end[0], end[1], rot, 1, kind, "", "", False)
        return end

    def flag(self, at):
        self.npwr += 1
        p = self.P(at)
        self._place(f"#FLG0{self.npwr:02d}", "PWR_FLAG", p[0], p[1], 0, 1, "PWR_FLAG", "", "", False)

    def nc(self, *pinrefs):
        for p in pinrefs:
            self.ncs.append(self.pins[p])

    def frame(self, x1, y1, w, h, title, note=""):
        x2, y2 = r3(x1 + w), r3(y1 + h)
        self.gfx.append(f'(rectangle (start {x1} {y1}) (end {x2} {y2}) (stroke (width 0.25) (type dash) '
                        f'(color 120 120 120 1)) (fill (type none)) (uuid "{U()}"))')
        self.text(r3(x1 + 2.54), r3(y1 + 6.35), title, 2.0, bold=True)
        lines = [note] if isinstance(note, str) else note
        for i, line in enumerate(reversed([l for l in lines if l])):
            self.text(r3(x1 + 2.54), r3(y2 - 2.54 - 2.54 * i), line)

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
             '(comment 1 "Generated by hardware/pcbtools/schematic.py - check before ordering"))',
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
             f'(dnp no) (uuid "{U()}")']
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
        for k, field in (("mfr", "Manufacturer"), ("mpn", "MPN"), ("lcsc", "LCSC")):
            if it.get(k):
                prop(field, it[k], x, y, shown=False)
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
        if key in ("R", "C", "CP", "FB", "BT"):
            if rot in (0, 180):
                return x + 2.54, y - 1.27, "left", 2.54       # upright part: text to the right
            return x, y - 2.8, "", 5.6                         # level part: name above, value below
        if key == "D":
            return x, y - 2.8, "", 5.6
        if key == "TP":
            return x, y - 6.4, "", -2.0
        if key == "OPA2333":
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
    minus, out = s.pins["U1.2"], s.pins["U1.1"]
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
            "56k / 10k from 3.3 V = 0.50 V, smoothed by C9. C1 sits against U1 pins 8 and 4.")
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
    # C9 across R2 smooths the bias (further out when tantalum, for its longer value)
    cx = rx - (g(7.5) if s.parts["C9"]["key"] == "CP" else g(5))
    s.put("C9", cx, plus[1] + g(4) + 1.27)
    s.wire((rx, plus[1]), (cx, plus[1]), "C9.1")
    s.power("C9.2", "GND")
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

def draw_adc(s, x0, y0, ready=False):
    s.frame(x0, y0, g(48), H2, "3  Analogue-to-digital converter",
            "AIN0 - AIN1. ADDR to GND = address 0x48. ALERT/RDY: reading ready (Cardputer pull-up on G4)."
            if ready else "Measures GSR_SIGNAL against REF_0V5 (AIN0 - AIN1). ADDR to GND = I2C address 0x48.")
    ux, uy = x0 + g(24), y0 + g(23)
    s.put("U2", ux, uy, txt=(2.54, -14.5, "left"))
    s.label("U2.4", "GSR_SIGNAL", n=4)
    s.label("U2.5", "REF_0V5", n=4)
    s.nc("U2.6", "U2.7")
    if ready:
        s.label("U2.2", "ADC_READY", n=4)
    else:
        s.nc("U2.2")
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
    # test pads for a meter or scope
    ty = y0 + g(31)
    for i, (ref, net) in enumerate((("TP3", "GSR_SIGNAL"), ("TP4", "REF_0V5"), ("TP5", None))):
        s.put(ref, x0 + g(4 + 6 * i), ty)
        if net:
            s.label(f"{ref}.1", net, n=2)
        else:
            s.power(f"{ref}.1", "GND")
    if ready:                                  # below the ready pin's label, clear of U2's ground
        s.put("TP8", x0 + g(36), ty)
        s.label("TP8.1", "ADC_READY", n=2)

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
    # reset and safeboot test pads, each with a ground pad below it
    s.put("TP2", s.pins["U4.18"][0] - g(4), s.pins["U4.18"][1])
    s.wire("U4.18", "TP2.1")
    # TP1's long name to its left, clear of C7's GND above and TP2's text to its right
    s.put("TP1", s.pins["U4.8"][0] - g(9), s.pins["U4.8"][1], txt=(-1.27, -3.3, "right"))
    s.wire("U4.8", "TP1.1")
    for ref, tp in (("TP7", "TP2"), ("TP6", "TP1")):
        s.put(ref, s.pins[f"{tp}.1"][0], s.pins[f"{tp}.1"][1] + g(5))
        s.power(f"{ref}.1", "GND")
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

def tail_pads(s, ref, x, y, nets=TAIL_NETS):
    """An 8-way connector: ground pins to GND symbols, the rest to labels."""
    s.put(ref, x, y)
    for pn, net in nets.items():
        if net is None:
            s.nc(f"{ref}.{pn}")
        elif net == "GND":
            s.power(f"{ref}.{pn}", "GND", n=2)
        else:
            s.label(f"{ref}.{pn}", net, n=4)

def draw_cardputer_conn(s, x0, y0):
    s.frame(x0, y0, g(38), H1, "4  Cable to the EXT header's legs",
            ["Wires to EXT legs: " + " ".join(f"{k} {v}" for k, v in CABLE_LEGS.items()) + ".",
             "R6/R7: the Cardputer has no pull-ups on G3/G5."])
    tail_pads(s, "J1", x0 + g(6), y0 + g(14), CABLE_NETS)
    s.flag((s.pins["J1.3"][0] + G, s.pins["J1.3"][1]))
    for i, ref in enumerate(("H1", "H2", "H3", "H4")):
        s.put(ref, x0 + g(6) + g(6) * (i % 2), y0 + g(31) + g(4) * (i // 2))
    draw_pullups(s, x0 + g(26), y0 + g(29))

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

def draw_tail(s):
    s.frame(g(8), ROW1, g(40), H1, "1  Cardputer ADV EXT header",
            "Pin 2 (5 V in) stays open. Straight header through the tail's stiffened end.")
    s.put("J1", g(18), ROW1 + g(19))
    s.nc(*[f"J1.{i}" for i in (1, 7, 9, 11, 2, 8, 10)])
    s.power("J1.4", "GND", n=2)
    s.flag((s.pins["J1.4"][0] + G, s.pins["J1.4"][1]))
    for pn, net in (("3", "ADC_READY"), ("5", "I2C_SCL"), ("13", "I2C_SDA"), ("6", "+5V_EXT"),
                    ("12", "HOST_TX_TO_GPS"), ("14", "GPS_TX_TO_HOST")):
        s.label(f"J1.{pn}", net, n=4)
    s.frame(g(52), ROW1, g(40), H1, "2  Solder pads onto the Cardputer board",
            "Pad k lies on the Cardputer board's landing pad k.")
    tail_pads(s, "J2", g(60), ROW1 + g(14))

def draw_sheet(name, parts):
    s = Sheet(parts)
    if name == "biomap_cardputer_tail":
        draw_tail(s)
        return s
    draw_tia(s, g(8), ROW2)
    draw_ref(s, g(69), ROW2)
    draw_adc(s, g(112), ROW2, ready=(name == "biomap_cardputer"))
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
    reset_ids(name)
    root = U()
    s = draw_sheet(name, parts)
    with open(os.path.join(d, f"{name}.kicad_sch"), "w") as f:
        f.write(s.emit(name, root, title))
    with open(os.path.join(d, "BioMap.kicad_sym"), "w") as f:
        f.write('(kicad_symbol_lib (version 20231120) (generator "kicad_symbol_editor") (generator_version "8.0")\n'
                + "\n".join(lib_symbol(k, prefix="") for k in sorted(SYMS)) + ")\n")
    with open(os.path.join(d, "sym-lib-table"), "w") as f:
        f.write('(sym_lib_table (version 7)\n  (lib (name "BioMap") (type "KiCad") (uri "${KIPRJMOD}/BioMap.kicad_sym") (options "") (descr "BioMapping project symbols")))\n')
    write_project_file(os.path.join(d, f"{name}.kicad_pro"), name, root)
    with open(os.path.join(d, f"{name}.kicad_dru"), "w") as f:
        f.write(rules.custom_rules(hasattr(LAYOUTS[name], "GUARD")))
    with open(os.path.join(d, "fp-lib-table"), "w") as f:
        f.write('(fp_lib_table (version 7)\n  (lib (name "BioMap") (type "KiCad") (uri "${KIPRJMOD}/../BioMap.pretty") (options "") (descr "BioMapping project footprints")))\n')
    # One row per distinct part, references grouped: the layout UK assemblers
    # and JLCPCB both take (JLCPCB reads the "LCSC" column).
    rows = {}
    for p in parts:
        if p["key"] == "MH":
            continue
        k = (p["value"], p["fp"], p["mpn"])
        rows.setdefault(k, []).append(p)
    def refkey(r):
        return (r.rstrip("0123456789"), int(r[len(r.rstrip("0123456789")):]))
    with open(os.path.join(d, "bom.csv"), "w") as f:
        f.write("Designator,Qty,Value,Footprint,Manufacturer,MPN,LCSC,Fit,Note\n")
        for (value, fp, mpn), ps in sorted(rows.items(), key=lambda kv: refkey(min((p["ref"] for p in kv[1]), key=refkey))):
            refs = " ".join(sorted((p["ref"] for p in ps), key=refkey))
            fit = ("bare pad" if ps[0]["key"] == "TP" or "FlexTail" in fp
                   else "through-hole" if "PinHeader" in fp
                   else "by hand" if "JST_GH" in fp else "SMD")
            notes = {p["note"] for p in ps}
            note = notes.pop() if len(notes) == 1 else ""      # mixed roles: see the schematic
            f.write(f'"{refs}",{len(ps)},"{value}",{fp.split(":")[1]},"{ps[0]["mfr"]}","{mpn}",{ps[0]["lcsc"]},{fit},"{note}"\n')

def write_project_file(path, name, root):
    """Write the design rules into the .kicad_pro. If KiCad has already saved
    the file, keep everything else in it (your settings) and only update the
    rules and the default net class."""
    pro = {}
    if os.path.exists(path):
        with open(path) as f:
            pro = json.load(f)
    pro.setdefault("meta", {"filename": f"{name}.kicad_pro", "version": 3})
    ds = pro.setdefault("board", {}).setdefault("design_settings", {})
    ds.setdefault("rules", {}).update(min_clearance=rules.CLEARANCE, min_track_width=rules.MIN_TRACK)
    ds.setdefault("rule_severities", {})["silk_edge_clearance"] = "ignore"
    ns = pro.setdefault("net_settings", {"meta": {"version": 3}, "classes": []})
    default = next((c for c in ns.setdefault("classes", []) if c.get("name") == "Default"), None)
    if default is None:
        default = {"name": "Default", "wire_width": 6, "bus_width": 12, "line_style": 0, "priority": 2147483647}
        ns["classes"].append(default)
    default.update(clearance=rules.CLEARANCE, track_width=rules.NETCLASS_TRACK,
                   via_diameter=rules.VIA_D, via_drill=rules.VIA_DRILL)
    pro["sheets"] = [[root, "Root"]]
    with open(path, "w") as f:
        json.dump(pro, f, indent=2)


TITLES = {"biomap_flipper": ("BioMapping 2 - Flipper Zero board", FLIPPER),
          "biomap_cardputer": ("BioMapping 2 - Cardputer ADV Cap", CARDPUTER),
          "biomap_cardputer_tail": ("BioMapping 2 - Cardputer ADV flex tail", CARDPUTER_TAIL)}


def expected_nets(name):
    """The intended connections: {"REF.pin": net name, or None for no connection}."""
    return {f'{p["ref"]}.{n}': net for p in TITLES[name][1] for n, net in p["pins"].items()}


def generate(root):
    """Write every board's schematics, symbol libraries, project files and BOMs under root."""
    for name, (title, parts) in TITLES.items():
        write_project(root, name, title, parts)
