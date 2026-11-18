"""Design rules shared by the project files, the layout and the checks (mm)."""

CLEARANCE = 0.15          # the ADS1115's MSOP pad gap forces this
MIN_TRACK = 0.15
SIG, PWR = 0.25, 0.5      # track widths: signal, power
NETCLASS_TRACK = 0.3      # default width KiCad offers when you draw a new track by hand
VIA_D, VIA_DRILL = 0.7, 0.35
TEXT, TEXT_LINE = 1.0, 0.15 # printed text: JLCPCB's smallest height and line width

# Custom rules, written to each board's .kicad_dru. KiCad's design rules check
# (DRC) reads that file, so `./pcb check` tests these, and so does the PCB
# editor while you work, the moment a rule is broken.

# JLCPCB's limits for 2-layer boards (jlcpcb.com/capabilities/pcb-capabilities)
# that are stricter than KiCad's defaults. Track width and gap need no rule:
# ours (0.15 mm) are already wider than theirs (0.10 mm).
MAKER_RULES = """
(rule "JLCPCB: drilled holes at least 0.45 mm apart"
  (constraint hole_to_hole (min 0.45mm)))

(rule "JLCPCB: vias at least 0.2 mm apart"
  (condition "A.Type == 'Via' && B.Type == 'Via'")
  (constraint hole_to_hole (min 0.2mm)))

(rule "JLCPCB: copper ring round a plated pad hole at least 0.18 mm"
  (condition "A.Type == 'Pad' && A.Pad_Type == 'Through-hole'")
  (constraint annular_width (min 0.18mm)))

(rule "JLCPCB: printed text at least 1.0 mm tall, with 0.15 mm lines"
  (condition "A.Layer == '*.Silkscreen'")
  (constraint text_height (min 1.0mm))
  (constraint text_thickness (min 0.15mm)))
"""

# The amplifier input and the cuff-2 wire feeding it carry the tiny skin
# current. The schematic draws them as plain wires, so KiCad names them after
# a pin: TIA_IN is "Net-(U1A--)", ELECTRODE_2 is "Net-(J2-Pin_2)". If those
# names ever change, change them here too, or these rules quietly test nothing.
GSR_RULES = """
(rule "Guard: no ground track or via inside the 0.5 V guard"
  (condition "A.NetName == 'GND' && A.intersectsArea('0.5 V guard')")
  (constraint disallow track via))

(rule "Skin-current wires: 0.3 mm from all copper except the 0.5 V reference"
  (condition "(A.NetName == 'Net-(U1A--)' || A.NetName == 'Net-(J2-Pin_2)') && B.NetName != '/REF_0V5'")
  (constraint clearance (min 0.3mm)))
"""


def custom_rules(has_guard):
    """The .kicad_dru text for one board. Boards without the GSR circuit (the
    flex tail) get only the board maker's limits."""
    return "(version 1)\n" + MAKER_RULES + (GSR_RULES if has_guard else "")
