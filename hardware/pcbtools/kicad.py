"""Where KiCad and the boards live, and small helpers for running KiCad.

Every other module takes its paths from here, so a KiCad install somewhere
else needs only the KICAD_APP environment variable, e.g.
    KICAD_APP=~/Applications/KiCad.app ./pcb build"""
import os
import subprocess
import sys

HARDWARE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(HARDWARE)
OUT = os.path.join(HARDWARE, "out")     # pictures, check reports, factory files (git ignores it)

KICAD_APP = os.path.expanduser(os.environ.get("KICAD_APP", "/Applications/KiCad/KiCad.app"))
KICAD_CLI = os.path.join(KICAD_APP, "Contents/MacOS/kicad-cli")
KICAD_PYTHON = os.path.join(KICAD_APP, "Contents/Frameworks/Python.framework/Versions/Current/bin/python3")
FOOTPRINT_DIR = os.path.join(KICAD_APP, "Contents/SharedSupport/footprints")
LOCAL_FOOTPRINT_LIBS = {"BioMap": os.path.join(HARDWARE, "BioMap.pretty")}

BOARDS = ("biomap_flipper", "biomap_cardputer", "biomap_cardputer_tail")


def board_name(arg):
    """Accept 'flipper' as well as 'biomap_flipper', and 'tail' for the Cardputer's flex tail."""
    for b in BOARDS:
        if arg in (b, b.split("_", 1)[1]) or (arg == "tail" and b.endswith("_tail")):
            return b
    sys.exit(f"unknown board {arg!r}: use one of {', '.join(BOARDS)} (or flipper / cardputer / tail)")


def board_file(name, ext, root=HARDWARE):
    """Path of e.g. biomap_flipper/biomap_flipper.kicad_pcb under root."""
    return os.path.join(root, name, name + ext)


def footprint_lib_path(lib):
    return LOCAL_FOOTPRINT_LIBS.get(lib, os.path.join(FOOTPRINT_DIR, lib + ".pretty"))


def load_footprint(lib, name):
    import pcbnew
    return pcbnew.FootprintLoad(footprint_lib_path(lib), name)


def cli(*args, check=False):
    """Run kicad-cli and return (exit code, stdout + stderr as text)."""
    r = subprocess.run([KICAD_CLI, *args], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit(f"kicad-cli {' '.join(args)} failed:\n{r.stdout}{r.stderr}")
    return r.returncode, r.stdout + r.stderr


def export_netlist(sch, out):
    cli("sch", "export", "netlist", "--format", "kicadsexpr", "-o", out, sch, check=True)


def hide_kicad_noise():
    """KiCad's C++ code (loaded with pcbnew) writes debug chatter straight to
    the error stream. Send that stream to nowhere, but keep Python's own
    errors and tracebacks on screen through a copy of it."""
    sys.stderr.flush()
    visible = os.dup(2)
    with open(os.devnull, "w") as null:
        os.dup2(null.fileno(), 2)
    sys.stderr = os.fdopen(visible, "w", buffering=1)
