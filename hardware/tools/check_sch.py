#!/usr/bin/env python3
"""Independent check that does not use KiCad: parse a generated .kicad_sch,
rebuild the nets from the drawing itself (pin ends, wires, junctions, labels,
power symbols) and compare them with the intended nets in expected.json.
check_netlist.py does the same job through KiCad's own netlist; the two agree.
usage: check_sch.py <hardware-dir> <expected.json>"""
import json, math, re, sys

def parse(text):
    toks = re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', text)
    stack, cur = [], []
    for t in toks:
        if t == "(":
            stack.append(cur); cur = []
        elif t == ")":
            done = cur; cur = stack.pop(); cur.append(done)
        else:
            cur.append(t.strip('"'))
    assert not stack, "unbalanced parentheses"
    assert len(cur) == 1
    return cur[0]

def find(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]

def rotate(x, y, rot):
    c, s = round(math.cos(math.radians(rot))), round(math.sin(math.radians(rot)))
    return x * c - y * s, x * s + y * c

def main(sch_path, expected):
    tree = parse(open(sch_path).read())
    libs = {}                              # lib name -> {unit: {pin: (x, y)}}, plus power flag
    power = set()
    for sym in find(find(tree, "lib_symbols")[0], "symbol"):
        name = sym[1]
        if find(sym, "power"):
            power.add(name)
        units = {}
        for sub in find(sym, "symbol"):
            unit = int(sub[1].rsplit("_", 2)[-2])          # NAME_<unit>_<style>
            for p in find(sub, "pin"):
                at = find(p, "at")[0]
                units.setdefault(unit, {})[find(p, "number")[0][1]] = (float(at[1]), float(at[2]))
        libs[name] = units
    parent = {}
    def f(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    def join(a, b):
        parent[f(a)] = f(b)
    pt = lambda x, y: (round(float(x), 2), round(float(y), 2))
    pin_pts = {}
    points = set()
    for inst in find(tree, "symbol"):
        lib = find(inst, "lib_id")[0][1]
        at = find(inst, "at")[0]
        rot = float(at[3]) if len(at) > 3 else 0
        unit = int(find(inst, "unit")[0][1])
        props = {p[1]: p[2] for p in find(inst, "property")}
        pins = dict(libs[lib].get(0, {}), **libs[lib].get(unit, {}))
        for num, (x, y) in pins.items():
            rx, ry = rotate(x, y, rot)
            p = pt(float(at[1]) + rx, float(at[2]) - ry)
            points.add(p)
            if lib in power:
                if props["Value"] != "PWR_FLAG":
                    join(p, "NET:" + props["Value"])
            else:
                pin_pts[(props["Reference"], num)] = p
    wires = []
    for w in find(tree, "wire"):
        xy = find(find(w, "pts")[0], "xy")
        a, b = pt(*xy[0][1:]), pt(*xy[1][1:])
        wires.append((a, b)); points.update((a, b))
        join(a, b)
    for j in find(tree, "junction"):
        points.add(pt(*find(j, "at")[0][1:3]))
    # anything ending on the middle of a wire joins it (KiCad marks these with a dot)
    for p in points:
        for a, b in wires:
            if (a[0] == b[0] == p[0] and min(a[1], b[1]) < p[1] < max(a[1], b[1])) or \
               (a[1] == b[1] == p[1] and min(a[0], b[0]) < p[0] < max(a[0], b[0])):
                join(p, a)
    for lab in find(tree, "label"):
        at = find(lab, "at")[0]
        join(pt(at[1], at[2]), "NET:" + lab[1])
    ncs = {pt(*find(n, "at")[0][1:3]) for n in find(tree, "no_connect")}
    assert set(expected) == {f"{r}.{n}" for r, n in pin_pts}, "pin set differs"
    names_of = lambda root: {n for n in parent if isinstance(n, str) and f(n) == root}
    groups = {}
    for key, want in expected.items():
        if want is not None:
            groups.setdefault(want, set()).add(key)
    errors = 0
    for net, keys in sorted(groups.items()):
        roots = {f(pin_pts[tuple(k.split("."))]) for k in keys}
        drawn = {f"{r}.{n}" for (r, n), p in pin_pts.items() if f(p) in roots}
        names = names_of(next(iter(roots))) if len(roots) == 1 else set()
        # a labelled net must carry exactly this name; an unlabelled one just the right pins
        if len(roots) != 1 or drawn != keys or (names and names != {"NET:" + net}):
            errors += 1
            if len(roots) > 1:
                print(f"MISMATCH {net}: drawn as {len(roots)} separate pieces, should be one: {sorted(keys)}")
            else:
                print(f"MISMATCH {net}: want {sorted(keys)}, drawn {sorted(drawn)}, names {sorted(names)}")
    for key, want in expected.items():
        p = pin_pts[tuple(key.split("."))]
        if want is None and p not in ncs:
            errors += 1
            print(f"MISMATCH {key}: should carry a no-connect flag")
    for net, keys in sorted(groups.items()):
        flag = "  <-- only one pin!" if len(keys) < 2 else ""
        print(f"  {net:16s} {' '.join(sorted(keys))}{flag}")
    print(f"{sch_path}: {len(expected)} pins checked, {errors} mismatches")
    return errors

if __name__ == "__main__":
    out = sys.argv[1]
    exp = json.load(open(sys.argv[2]))
    sys.exit(1 if sum(main(f"{out}/{k}/{k}.kicad_sch", v) for k, v in exp.items()) else 0)
