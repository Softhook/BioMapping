#!/usr/bin/env python3
"""Independent check: parse a generated .kicad_sch, rebuild the nets from the
geometry (pin ends, wires, labels), and compare with the intended nets."""
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
            cur.append(t.strip('"'))
    assert not stack, "unbalanced parentheses"
    assert len(cur) == 1
    return cur[0]

def find(node, key):
    return [c for c in node if isinstance(c, list) and c and c[0] == key]

def main(sch_path, expected):
    tree = parse(open(sch_path).read())
    libs = {}
    for sym in find(find(tree, "lib_symbols")[0], "symbol"):
        pins = {}
        for sub in find(sym, "symbol"):
            for p in find(sub, "pin"):
                at = find(p, "at")[0]
                pins[find(p, "number")[0][1]] = (float(at[1]), float(at[2]))
        libs[sym[1]] = pins
    parent = {}
    def f(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    def join(a, b): parent[f(a)] = f(b)
    pt = lambda x, y: (round(float(x), 2), round(float(y), 2))
    pin_pts = {}
    for inst in find(tree, "symbol"):
        lib = find(inst, "lib_id")[0][1]
        at = find(inst, "at")[0]
        ref = [p[2] for p in find(inst, "property") if p[1] == "Reference"][0]
        for num, (x, y) in libs[lib].items():
            pin_pts[(ref, num)] = pt(float(at[1]) + x, float(at[2]) - y)
    for w in find(tree, "wire"):
        xy = find(find(w, "pts")[0], "xy")
        join(pt(*xy[0][1:]), pt(*xy[1][1:]))
    for lab in find(tree, "label"):
        at = find(lab, "at")[0]
        join(pt(at[1], at[2]), "NET:" + lab[1])
    ncs = {pt(*find(n, "at")[0][1:]) for n in find(tree, "no_connect")}
    errors = 0
    for key, want in expected.items():
        ref, num = key.split(".")
        p = pin_pts[(ref, num)]
        if want is None:
            ok = p in ncs
            got = "NC" if ok else "?"
        else:
            root = f(p)
            names = {n for n in parent if isinstance(n, str) and f(n) == root}
            got = ",".join(sorted(names)) or "unconnected"
            ok = names == {"NET:" + want}
        if not ok:
            errors += 1
            print(f"MISMATCH {key}: want {want}, got {got}")
    assert set(expected) == {f"{r}.{n}" for r, n in pin_pts}, "pin set differs"
    nets = {}
    for key, n in expected.items():
        if n: nets.setdefault(n, []).append(key)
    for n, members in sorted(nets.items()):
        flag = "  <-- only one pin!" if len(members) < 2 else ""
        print(f"  {n:16s} {' '.join(sorted(members))}{flag}")
    print(f"{sch_path}: {len(expected)} pins checked, {errors} mismatches")
    return errors

if __name__ == "__main__":
    out = sys.argv[1]
    exp = json.load(open(sys.argv[2]))
    sys.exit(sum(main(f"{out}/{k}/{k}.kicad_sch", v) for k, v in exp.items()))
