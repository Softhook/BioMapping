"""One module per board, holding its hand-written layout (see flipper.py)."""
from . import cardputer, flipper

LAYOUTS = {"biomap_flipper": flipper, "biomap_cardputer": cardputer}
