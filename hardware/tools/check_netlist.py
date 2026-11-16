#!/usr/bin/env python3
"""Prove that a drawn schematic connects exactly what gen_kicad.py intended.

Reads the netlist KiCad itself exports from the schematic (so it sees the
drawing the way KiCad does) and compares it with expected.json, pin by pin.
usage: check_netlist.py <expected.json> <board-name> <netlist.net>"""
import json, re, sys

def parse(text):
    toks = re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text)
    stack, cur = [], []
    for t in toks:
        if t == "(":
            stack.append(cur); cur = []
        elif t == ")":
            done = cur; cur = stack.pop(); cur.append(done)
        else:
            cur.append(t[1:-1] if t.startswith('"') else t)
    assert not stack, "unbalanced parentheses"
    return cur[0]

def find(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]

def main(expected, net_path):
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
    print(f"{net_path}: {len(expected)} pins, {len(want_groups)} nets, {errors} mismatches")
    return errors

if __name__ == "__main__":
    exp = json.load(open(sys.argv[1]))[sys.argv[2]]
    sys.exit(1 if main(exp, sys.argv[3]) else 0)
