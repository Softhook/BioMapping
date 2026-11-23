"""The steps that turn the Python descriptions into KiCad files, and the
checks that prove the result is right. Each step returns the number of
problems it found, so the commands can fail loudly."""
import collections
import json
import os
import tempfile

from . import check_netlist, check_sch, schematic
from .kicad import BOARDS, HARDWARE, OUT, board_file, cli, export_netlist


def _report_path(name, kind):
    os.makedirs(OUT, exist_ok=True)
    return os.path.join(OUT, f"{name}.{kind}.json")


def check_schematic(name, tmp):
    """Both connection checks: our own reading of the drawing, then KiCad's netlist."""
    expected = schematic.expected_nets(name)
    sch = board_file(name, ".kicad_sch")
    errors = check_sch.check(sch, expected, label="  drawing vs intent")
    net = os.path.join(tmp, name + ".net")
    export_netlist(sch, net)
    errors += check_netlist.check(expected, net, label="  KiCad netlist vs intent")
    return errors, net


def erc(name):
    """KiCad's electrical rules check on the schematic."""
    rpt = _report_path(name, "erc")
    cli("sch", "erc", "--format", "json", "-o", rpt, board_file(name, ".kicad_sch"))
    found = [v for sheet in json.load(open(rpt))["sheets"] for v in sheet["violations"]]
    print(f"  ERC: {len(found)} problems" + (f"  (details: {os.path.relpath(rpt)})" if found else ""))
    for v in found:
        print(f"    {v['severity']}: {v['description']}")
    return len(found)


def drc(name, details=False):
    """KiCad's design rules check on the saved board, including whether it
    still matches the schematic. Prints a count per kind of problem, or
    every problem with the parts and positions involved if details is set."""
    rpt = _report_path(name, "drc")
    cli("pcb", "drc", "--schematic-parity", "--format", "json", "-o", rpt, board_file(name, ".kicad_pcb"))
    r = json.load(open(rpt))
    groups = {"design-rule problems": r["violations"], "unconnected items": r["unconnected_items"],
              "schematic mismatches": r["schematic_parity"]}
    total = sum(len(v) for v in groups.values())
    print("  DRC: " + ", ".join(f"{len(v)} {k}" for k, v in groups.items()))
    for kind, items in groups.items():
        if details:
            for v in items:
                print(f"    [{v['type']}] {v['description']}")
                for it in v.get("items", []):
                    pos = it.get("pos", {})
                    print(f"        {it['description']}  at ({pos.get('x', 0):.2f}, {pos.get('y', 0):.2f})")
        else:
            for t, n in collections.Counter(v["type"] for v in items).most_common():
                print(f"    {n:3d} x {t}")
    if total and not details:
        print(f"  details: ./pcb drc {name.split('_', 1)[1]}   (full report: {os.path.relpath(rpt)})")
    return total


def layout_limits(name):
    """The layout numbers against the rules in limits.py."""
    from . import limits                 # needs KiCad's Python
    return limits.check(name, board_file(name, ".kicad_pcb"))


def layout(name, net):
    """Place and route one board from its netlist and boards/<board>.py."""
    from . import layout as lay          # needs KiCad's Python
    lay.build(name, net, board_file(name, ".kicad_pcb"))


def build(names=BOARDS, regenerate=True):
    """regenerate: redraw both schematics first (otherwise use the saved ones).
    Then for each board: check the schematic, lay it out, check the board."""
    problems = 0
    if regenerate:
        schematic.generate(HARDWARE)
        print("schematics, symbol libraries, project files and BOMs written")
    with tempfile.TemporaryDirectory() as tmp:
        for name in names:
            print(f"== {name}")
            errors, net = check_schematic(name, tmp)
            errors += erc(name)
            if errors:
                print("  schematic has problems: board not rebuilt")
                problems += errors
                continue
            layout(name, net)
            problems += drc(name) + layout_limits(name)
    return problems


def check(names=BOARDS):
    """Check the saved files without changing them, including the layout limits."""
    problems = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name in names:
            print(f"== {name}")
            errors, _ = check_schematic(name, tmp)
            problems += errors + erc(name) + drc(name) + layout_limits(name)
    return problems
