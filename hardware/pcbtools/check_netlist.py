"""Prove that a drawn schematic connects exactly what schematic.py intended.

Reads the netlist KiCad itself exports from the schematic (so it sees the
drawing the way KiCad does) and compares it with the intended nets, pin by
pin. check_sch.py does the same job without KiCad; the two should agree."""
from .sexpr import parse, find

def check(expected, net_path, label=None):
    """expected: {"REF.pin": net name or None}. Returns the number of mismatches."""
    tree = parse(open(net_path).read())
    got = {}                                  # "REF.pin" -> net name
    for n in find(find(tree, "nets")[0], "net"):
        name = find(n, "name")[0][1].lstrip("/")
        for nd in find(n, "node"):
            ref, pn = find(nd, "ref")[0][1], find(nd, "pin")[0][1]
            if not ref.startswith("#"):
                got[f"{ref}.{pn}"] = name
    errors = 0
    # every intended net must be one KiCad net holding exactly the same pins
    want_groups = {}
    for key, net in expected.items():
        if net is not None:
            want_groups.setdefault(net, set()).add(key)
    got_groups = {}
    for key, net in got.items():
        got_groups.setdefault(net, set()).add(key)
    for net, pins in sorted(want_groups.items()):
        names = {got.get(p, "unconnected") for p in pins}
        name = names.pop() if len(names) == 1 else None
        # KiCad names a net from a label or power symbol; wire-only nets get "Net-(...)"
        if name is None or got_groups.get(name) != pins or (name != net and not name.startswith("Net-(")):
            errors += 1
            print(f"MISMATCH {net}: want {sorted(pins)}")
            for p in sorted(pins):
                print(f"    {p} is on {got.get(p, 'nothing')}")
            extra = set().union(*(got_groups.get(got.get(p), set()) for p in pins)) - pins
            if extra:
                print(f"    extra pins on {net}: {sorted(extra)}")
    # pins meant to be unconnected must sit alone
    for key, net in expected.items():
        if net is None and key in got and not got[key].startswith("unconnected-"):
            if len(got_groups[got[key]]) > 1:
                errors += 1
                print(f"MISMATCH {key}: should be unconnected, is on {got[key]}")
    missing = set(expected) - set(got)
    if missing:
        errors += 1
        print(f"pins missing from the netlist: {sorted(missing)}")
    print(f"{label or net_path}: {len(expected)} pins, {len(want_groups)} nets, {errors} mismatches")
    return errors
