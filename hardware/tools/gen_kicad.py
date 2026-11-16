#!/usr/bin/env python3
"""Generate KiCad 8 projects (schematic + project file) for the BioMapping
Flipper and Cardputer boards. Every pin gets a short wire stub and a net label,
so connectivity is defined by net names only."""
import json, os, sys, uuid

OUT = sys.argv[1]

def U():
    return str(uuid.uuid4())

FONT = '(effects (font (size 1.27 1.27)))'
FONT_HIDE = '(effects (font (size 1.27 1.27)) hide)'

# ── Symbol library ────────────────────────────────────────────────────────
# Each symbol: list of pins (number, name, x, y, angle) in library coords
# (y up). angle = direction from connection point toward the body.

def two_pin(name, ref, body):
    pins = [("1", "~", 0, 3.81, 270), ("2", "~", 0, -3.81, 90)]
    return dict(name=name, ref=ref, pins=pins, body=body, pin_len=1.27,
                hide_names=True)

RES_BODY = '(rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))'
CAP_BODY = ('(polyline (pts (xy -2.032 -0.762) (xy 2.032 -0.762)) (stroke (width 0.508) (type default)) (fill (type none)))'
            '(polyline (pts (xy -2.032 0.762) (xy 2.032 0.762)) (stroke (width 0.508) (type default)) (fill (type none)))'
            '(polyline (pts (xy 0 2.54) (xy 0 0.762)) (stroke (width 0) (type default)) (fill (type none)))'
            '(polyline (pts (xy 0 -2.54) (xy 0 -0.762)) (stroke (width 0) (type default)) (fill (type none)))')
FB_BODY = '(rectangle (start -1.27 -2.54) (end 1.27 2.54) (stroke (width 0.254) (type default)) (fill (type outline)))'

def box(name, ref, left, right, width=15.24):
    """IC drawn as a box. left/right: lists of (number, name) top to bottom."""
    n = max(len(left), len(right))
    h = (n + 1) * 2.54
    top = h / 2
    pins = []
    for i, (num, nm) in enumerate(left):
        pins.append((num, nm, -width / 2 - 2.54, top - 2.54 * (i + 1), 0))
    for i, (num, nm) in enumerate(right):
        pins.append((num, nm, width / 2 + 2.54, top - 2.54 * (i + 1), 180))
    body = (f'(rectangle (start {-width/2} {top}) (end {width/2} {-top}) '
            '(stroke (width 0.254) (type default)) (fill (type background)))')
    return dict(name=name, ref=ref, pins=pins, body=body, pin_len=2.54,
                hide_names=False)

def header(name, ref, n, cols=1):
    if cols == 1:
        return box(name, ref, [(str(i), f"Pin_{i}") for i in range(1, n + 1)], [], width=7.62)
    left = [(str(i), f"Pin_{i}") for i in range(1, n + 1, 2)]
    right = [(str(i), f"Pin_{i}") for i in range(2, n + 1, 2)]
    return box(name, ref, left, right, width=7.62)

SYMS = {
    "R": two_pin("R", "R", RES_BODY),
    "C": two_pin("C", "C", CAP_BODY),
    "FB": two_pin("FerriteBead", "FB", FB_BODY),
    "MCP6002": box("MCP6002", "U", [("3", "+IN_A"), ("2", "-IN_A"), ("1", "OUT_A"), ("4", "VSS")],
                   [("5", "+IN_B"), ("6", "-IN_B"), ("7", "OUT_B"), ("8", "VDD")]),
    "ADS1115": box("ADS1115", "U", [("4", "AIN0"), ("5", "AIN1"), ("6", "AIN2"), ("7", "AIN3"), ("3", "GND")],
                   [("8", "VDD"), ("9", "SDA"), ("10", "SCL"), ("1", "ADDR"), ("2", "ALERT/RDY")]),
    "TLV75533": box("TLV75533PDBV", "U", [("1", "IN"), ("3", "EN"), ("2", "GND")],
                    [("5", "OUT"), ("4", "NC")]),
    "Conn_1x02": header("Conn_01x02", "J", 2),
    "Conn_1x04": header("Conn_01x04", "J", 4),
    "Conn_1x08": header("Conn_01x08", "J", 8),
    "Conn_1x10": header("Conn_01x10", "J", 10),
    "MH": dict(name="MountingHole", ref="H", pins=[], pin_len=0, hide_names=True,
               body='(circle (center 0 0) (radius 1.27) (stroke (width 0.254) (type default)) (fill (type none)))'),
    "Conn_2x07": header("Conn_02x07_Odd_Even", "J", 14, cols=2),
}

def lib_symbol(key):
    s = SYMS[key]
    nm = s["name"]
    out = [f'(symbol "BioMap:{nm}"']
    if s["hide_names"]:
        out.append('(pin_numbers hide) (pin_names (offset 0) hide)')
    else:
        out.append('(pin_names (offset 1.016))')
    out.append('(exclude_from_sim no) (in_bom yes) (on_board yes)')
    for k, v in [("Reference", s["ref"]), ("Value", nm), ("Footprint", ""),
                 ("Datasheet", ""), ("Description", "")]:
        eff = FONT if k in ("Reference", "Value") else FONT_HIDE
        out.append(f'(property "{k}" "{v}" (at 0 0 0) {eff})')
    out.append(f'(symbol "{nm}_0_1" {s["body"]})')
    out.append(f'(symbol "{nm}_1_1"')
    for num, pn, x, y, a in s["pins"]:
        out.append(f'(pin passive line (at {x:.3f} {y:.3f} {a}) (length {s["pin_len"]}) '
                   f'(name "{pn}" {FONT}) (number "{num}" {FONT}))')
    out.append('))')
    return " ".join(out)

def pin_geometry(key, px, py):
    """Return {pin_number: (end_x, end_y, outward_dx, outward_dy)} in sheet coords."""
    res = {}
    for num, _, x, y, a in SYMS[key]["pins"]:
        ex, ey = px + x, py - y            # library y is up, sheet y is down
        d = {0: (-1, 0), 180: (1, 0), 90: (0, 1), 270: (0, -1)}[a]
        res[num] = (round(ex, 3), round(ey, 3), d[0], d[1])
    return res

# ── Board definitions ─────────────────────────────────────────────────────
# part: (ref, symbol, value, footprint, x, y, {pin: net or None (=no connect)}, extra)

FP_R = "Resistor_SMD:R_0805_2012Metric"
FP_C = "Capacitor_SMD:C_0805_2012Metric"

def gsr_core(supply):
    """The validated GSR circuit (docs/wiring_guide.md), shared by both boards."""
    return [
        ("U1", "MCP6002", "MCP6002-I/SN", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", 110, 70,
         {"1": "GSR_SIGNAL", "2": "TIA_IN", "3": "REF_0V5", "4": "GND",
          "5": "BIAS_DIV", "6": "REF_0V5", "7": "REF_0V5", "8": supply}, {}),
        ("R1", "R", "56k 0.1%", FP_R, 60, 55, {"1": supply, "2": "BIAS_DIV"},
         {"Note": "Sets the 0.5 V bias. Use 0.1% or 0.5% parts: bias error = GSR error"}),
        ("R2", "R", "10k 0.1%", FP_R, 70, 55, {"1": "BIAS_DIV", "2": "GND"},
         {"Note": "Sets the 0.5 V bias. Use 0.1% or 0.5% parts: bias error = GSR error"}),
        ("R3", "R", "4.7k", FP_R, 60, 95, {"1": "ELECTRODE_1", "2": "GND"}, {"Note": "Skin current limit"}),
        ("R4", "R", "4.7k", FP_R, 70, 95, {"1": "ELECTRODE_2", "2": "TIA_IN"}, {"Note": "Skin current limit"}),
        ("R5", "R", "47k 0.1%", FP_R, 80, 95, {"1": "GSR_SIGNAL", "2": "TIA_IN"}, {"Note": "TIA gain"}),
        ("C1", "C", "100nF", FP_C, 80, 55, {"1": supply, "2": "GND"}, {"Note": "Place right at U1 pins 8 and 4"}),
        ("C2", "C", "100nF C0G", FP_C, 90, 95, {"1": "GSR_SIGNAL", "2": "TIA_IN"},
         {"Note": "TIA filter (~34 Hz) - C0G/NP0 for stability"}),
        ("U2", "ADS1115", "ADS1115IDGSR", "Package_SO:MSOP-10_3x3mm_P0.5mm", 160, 70,
         {"4": "GSR_SIGNAL", "5": "REF_0V5", "6": None, "7": None, "3": "GND",
          "8": supply, "9": "I2C_SDA", "10": "I2C_SCL", "1": "GND", "2": None}, {}),
        ("C3", "C", "100nF", FP_C, 90, 55, {"1": supply, "2": "GND"}, {"Note": "Place right at U2 pin 8"}),
        ("J2", "Conn_1x02", "Grove GSR finger cuffs", "Connector_JST:JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal", 40, 95,
         {"1": "ELECTRODE_1", "2": "ELECTRODE_2"},
         {"Note": "JST PH 2.0 mm side-entry socket for the Grove GSR finger-cuff plug - check plug fits"}),
        ("J3", "Conn_1x04", "GPS wires",
         "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical", 210, 70,
         {"1": supply, "2": "GND", "3": "GPS_TX_TO_HOST", "4": "HOST_TX_TO_GPS"},
         {"Note": "Solder pads for a short flexible lead to the SparkFun SAM-M10Q breakout. 1=3V3 2=GND 3=breakout TX 4=breakout RX"}),
    ]

FLIPPER = gsr_core("+3V3") + [
    ("J1", "Conn_1x08", "Flipper GPIO 1-8", "Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Horizontal", 40, 140,
     {"1": None, "2": None, "3": None, "4": None, "5": None, "6": None, "7": None, "8": "GND"},
     {"Note": "Flipper pins 1-8 (1 = 5V, 8 = GND). 17.78 mm gap to pin 9"}),
    ("J4", "Conn_1x10", "Flipper GPIO 9-18", "Connector_PinHeader_2.54mm:PinHeader_1x10_P2.54mm_Horizontal", 40, 175,
     {"1": "+3V3", "2": None, "3": "GND", "4": None, "5": "HOST_TX_TO_GPS", "6": "GPS_TX_TO_HOST",
      "7": "I2C_SDA", "8": "I2C_SCL", "9": None, "10": "GND"},
     {"Note": "Flipper pins 9-18: 9 3V3, 11 GND, 13 USART1 TX, 14 USART1 RX, 15 PC1 SDA, 16 PC0 SCL, 18 GND"}),
    ("R6", "R", "4.7k", FP_R, 100, 150, {"1": "+3V3", "2": "I2C_SDA"},
     {"Note": "I2C pull-up (the ADS1115 breakout used to supply these)"}),
    ("R7", "R", "4.7k", FP_R, 110, 150, {"1": "+3V3", "2": "I2C_SCL"},
     {"Note": "I2C pull-up (the ADS1115 breakout used to supply these)"}),
]

CARDPUTER = gsr_core("+3V3") + [
    ("J1", "Conn_2x07", "Cardputer ADV EXT", "Connector_PinHeader_2.54mm:PinHeader_2x07_P2.54mm_Horizontal", 40, 150,
     {"1": None, "2": None, "3": None, "4": "GND", "5": None, "6": "+5V_EXT", "7": None,
      "8": "I2C_SDA", "9": None, "10": "I2C_SCL", "11": None, "12": "HOST_TX_TO_GPS",
      "13": None, "14": "GPS_TX_TO_HOST"},
     {"Note": "M5 online pin table numbering: 4 GND, 6 5V OUT, 8 G8 SDA, 10 G9 SCL, 12 G13, 14 G15. "
              "Pin 2 is 5V IN - never connect. CHECK numbering and mirroring before ordering"}),
    ("FB1", "FB", "600R@100MHz", "Inductor_SMD:L_0805_2012Metric", 100, 150, {"1": "+5V_EXT", "2": "+5V_F"},
     {"Note": "Blocks boost-converter switching noise"}),
    ("C4", "C", "10uF", FP_C, 110, 150, {"1": "+5V_F", "2": "GND"}, {}),
    ("U3", "TLV75533", "TLV75533PDBVR", "Package_TO_SOT_SMD:SOT-23-5", 140, 150,
     {"1": "+5V_F", "3": "+5V_F", "2": "GND", "5": "+3V3", "4": None},
     {"Note": "3.3 V LDO, 1% accuracy, low noise. Replaces AMS1117 (2% and noisy)"}),
    ("C5", "C", "1uF", FP_C, 170, 150, {"1": "+3V3", "2": "GND"}, {"Note": "LDO output cap"}),
    ("H1", "MH", "M2", "MountingHole:MountingHole_2.2mm_M2", 230, 150, {}, {"Note": "M2 x 4 mm screw into Cardputer back"}),
    ("H2", "MH", "M2", "MountingHole:MountingHole_2.2mm_M2", 240, 150, {}, {"Note": "M2 x 4 mm screw into Cardputer back"}),
    ("R6", "R", "4.7k DNP", FP_R, 190, 150, {"1": "+3V3", "2": "I2C_SDA"},
     {"Note": "Leave unfitted: the Cardputer bus already has pull-ups"}),
    ("R7", "R", "4.7k DNP", FP_R, 200, 150, {"1": "+3V3", "2": "I2C_SCL"},
     {"Note": "Leave unfitted: the Cardputer bus already has pull-ups"}),
]

# ── Writer ────────────────────────────────────────────────────────────────

def write_project(name, title, parts):
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    root = U()
    used = sorted({p[1] for p in parts})
    o = ['(kicad_sch (version 20231120) (generator "eeschema") (generator_version "8.0")',
         f'(uuid "{root}")', '(paper "A3")',
         f'(title_block (title "{title}") (company "BioMapping") (comment 1 "Generated starter - check before ordering"))',
         '(lib_symbols ' + " ".join(lib_symbol(k) for k in used) + ')']
    expected = {}   # (ref, pin) -> net
    for ref, key, val, fp, x, y, pins, extra in parts:
        x, y = round(round(x / 2.54) * 2.54, 2), round(round(y / 2.54) * 2.54, 2)
        s = SYMS[key]
        dnp = "yes" if "DNP" in val else "no"
        o.append(f'(symbol (lib_id "BioMap:{s["name"]}") (at {x} {y} 0) (unit 1) '
                 f'(exclude_from_sim no) (in_bom {"no" if key == "MH" else "yes"}) (on_board yes) (dnp {dnp}) (uuid "{U()}")')
        top = min([g[1] for g in pin_geometry(key, x, y).values()] or [y])
        o.append(f'(property "Reference" "{ref}" (at {x} {top - 4} 0) {FONT})')
        o.append(f'(property "Value" "{val}" (at {x} {top - 2} 0) {FONT})')
        o.append(f'(property "Footprint" "{fp}" (at {x} {y} 0) {FONT_HIDE})')
        o.append(f'(property "Datasheet" "" (at {x} {y} 0) {FONT_HIDE})')
        o.append(f'(property "Description" "" (at {x} {y} 0) {FONT_HIDE})')
        for k, v in extra.items():
            o.append(f'(property "{k}" "{v}" (at {x} {y} 0) {FONT_HIDE})')
        for num, *_ in s["pins"]:
            o.append(f'(pin "{num}" (uuid "{U()}"))')
        o.append(f'(instances (project "{name}" (path "/{root}" (reference "{ref}") (unit 1)))))')
        geo = pin_geometry(key, x, y)
        assert set(geo) == set(pins), (ref, set(geo) ^ set(pins))
        for num, net in pins.items():
            ex, ey, dx, dy = geo[num]
            expected[(ref, num)] = net
            if net is None:
                o.append(f'(no_connect (at {ex} {ey}) (uuid "{U()}"))')
                continue
            lx, ly = round(ex + dx * 2.54, 3), round(ey + dy * 2.54, 3)
            o.append(f'(wire (pts (xy {ex} {ey}) (xy {lx} {ly})) (stroke (width 0) (type default)) (uuid "{U()}"))')
            ang, just = {(-1, 0): (180, "right"), (1, 0): (0, "left"),
                         (0, -1): (90, "left"), (0, 1): (270, "right")}[(dx, dy)]
            o.append(f'(label "{net}" (at {lx} {ly} {ang}) (fields_autoplaced yes) '
                     f'(effects (font (size 1.27 1.27)) (justify {just} bottom)) (uuid "{U()}"))')
    o.append('(sheet_instances (path "/" (page "1"))))')
    with open(os.path.join(d, f"{name}.kicad_sch"), "w") as f:
        f.write("\n".join(o) + "\n")
    with open(os.path.join(d, "BioMap.kicad_sym"), "w") as f:
        f.write('(kicad_symbol_lib (version 20231120) (generator "kicad_symbol_editor") (generator_version "8.0")\n'
                + "\n".join(lib_symbol(k).replace('(symbol "BioMap:', '(symbol "', 1) for k in sorted(SYMS)) + ")\n")
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
    # BOM
    with open(os.path.join(d, "bom.csv"), "w") as f:
        f.write("Reference,Value,Footprint,Note\n")
        for ref, key, val, fp, *_ , extra in parts:
            f.write(f'{ref},"{val}",{fp},"{extra.get("Note", "")}"\n')
    return expected

if __name__ == "__main__":
    exp = {"biomap_flipper": write_project("biomap_flipper", "BioMapping 2 - Flipper Zero board", FLIPPER),
           "biomap_cardputer": write_project("biomap_cardputer", "BioMapping 2 - Cardputer ADV Cap", CARDPUTER)}
    json.dump({k: {f"{r}.{p}": n for (r, p), n in v.items()} for k, v in exp.items()},
              open(sys.argv[2], "w"), indent=1)
