"""One module per board, holding its hand-written layout (see flipper.py)."""
from . import cardputer, cardputer_tail, flipper

LAYOUTS = {"biomap_flipper": flipper, "biomap_cardputer": cardputer, "biomap_cardputer_tail": cardputer_tail}
