"""Design rules shared by the project files, the layout and the checks (mm)."""

CLEARANCE = 0.15          # the ADS1115's MSOP pad gap forces this
MIN_TRACK = 0.15
SIG, PWR = 0.25, 0.5      # track widths: signal, power
NETCLASS_TRACK = 0.3      # default width KiCad offers when you draw a new track by hand
VIA_D, VIA_DRILL = 0.7, 0.35
