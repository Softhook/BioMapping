"""Layout limits: rules about the measured layout numbers (measure.py) that
`./pcb build`, `layout` and `check` test after the design rules check.

Each rule has a hard limit and, optionally, a target:
  * over the limit  -> counted as a problem; the command fails
  * past the limit but short of the target -> a reminder only, never a failure

Two kinds of limit:
  * from a source (u-blox's manual, SparkFun's board): a real requirement
  * "no worse than today": set just past today's value so a layout change
    that makes things worse is caught. Tighten these when the layout improves.

Each rule: (number name from measure.numbers, "max" or "min", limit, target or
None, why). A limit or target can be {board: value} where the boards differ."""
from .measure import numbers

RULES = [
    # ── decoupling: each 100 nF capacitor close to its chip's supply AND ground pins ──
    ("C1-U1 supply", "max", 3.5, None, "op-amp supply decoupling; no worse than today"),
    ("C1-U1 ground", "max", 3.5, None, "op-amp decoupling return path; no worse than today"),
    ("C3-U2 supply", "max", 3.5, None, "ADC supply decoupling; no worse than today"),
    ("C3-U2 ground", "max", 4.5, None, "ADC decoupling return path; no worse than today"),
    ("C7-U4 supply", "max", 4.0, None, "GPS decoupling, bridging VCC and the GND pad beside it"),
    ("C7-U4 ground", "max", 4.0, None, "GPS decoupling, bridging VCC and the GND pad beside it"),
    ("C5-U3 supply", "max", 3.0, None, "regulator output capacitor (Cardputer); no worse than today"),
    ("C5-U3 ground", "max", 3.0, None, "regulator output capacitor (Cardputer); no worse than today"),
    # ── GSR signal path: short copper picks up less noise ──
    ("amplifier input", "max", 10.0, None, "carries the tiny skin current; the most noise-sensitive wire"),
    ("GSR_SIGNAL", "max", 17.0, None, "amplifier output to the ADC and test pad TP3; no worse than today"),
    ("0.5 V ref", "max", 19.0, None, "reference shared by amplifier and ADC, and test pad TP4; "
                                     "no worse than today"),
    ("bias divider", "max", 8.0, None, "R1/R2 and smoothing capacitor C9 to the reference buffer; "
                                       "no worse than today"),
    ("0.5 V guard copper", "min", 40, None, "the guard round the amplifier input must stay one solid "
                                            "piece (about 46 mm2): a layout change that breaks it up shrinks it"),
    # ── GPS ground plane (u-blox SAM-M10Q integration manual) ──
    ("GPS plane ground vias", "min", 100, None, "ground stitched across the 50 x 50 mm plane; "
                                                "SparkFun's 40 mm board has about 100"),
    ("under-GPS ground vias", "min", 10, None, "u-blox asks for vias filling the ground under the module"),
]


def _for_board(value, name):
    return value.get(name) if isinstance(value, dict) else value


def check(name, pcb_path):
    """Test one saved board against RULES. Prints failures and reminders;
    returns the number of failures."""
    n = numbers(pcb_path)
    fails, short, tested = [], [], 0
    for key, kind, limit, target, why in RULES:
        limit, target = _for_board(limit, name), _for_board(target, name)
        if key not in n or limit is None:
            continue                        # e.g. C5 exists only on the Cardputer
        tested += 1
        v = n[key]
        worse = (lambda a, b: a > b) if kind == "max" else (lambda a, b: a < b)
        sign, unit = (">", "<=") if kind == "max" else ("<", ">=")
        mm = "" if "vias" in key else " mm2" if "copper" in key else " mm"
        if worse(v, limit):
            fails.append(f"    FAIL {key}: {v}{mm} {sign} limit {limit}{mm}  ({why})")
        elif target is not None and worse(v, target):
            short.append(f"    target {key}: {v}{mm}, aim {unit} {target}{mm}")
    print(f"  Layout limits: {tested - len(fails)} of {tested} passed"
          + (f", {len(short)} short of target" if short else ""))
    for line in fails + short:
        print(line)
    return len(fails)
