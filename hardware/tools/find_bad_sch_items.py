#!/usr/bin/env python3
"""When KiCad says "Failed to load schematic" with no reason, find which
items in the file it rejects. Tries each top-level item on its own (with the
header and symbol library) and lists the ones that fail to load.
usage: find_bad_sch_items.py <file.kicad_sch>"""
import os, subprocess, sys, tempfile

K = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"

def top_level_items(text):
    body = text[text.index("(", 1):text.rindex(")")]
    items, depth, start, quoted = [], 0, 0, False
    for i, c in enumerate(body):
        if c == '"' and body[i - 1] != "\\":
            quoted = not quoted
        elif not quoted and c == "(":
            if depth == 0:
                start = i
            depth += 1
        elif not quoted and c == ")":
            depth -= 1
            if depth == 0:
                items.append(body[start:i + 1])
    return items

def loads(items, tmp):
    path = os.path.join(tmp, "t.kicad_sch")
    with open(path, "w") as f:
        f.write("(kicad_sch " + "\n".join(items) + ")\n")
    r = subprocess.run([K, "sch", "export", "netlist", "-o", os.path.join(tmp, "t.net"), path], capture_output=True)
    return r.returncode == 0

def main(path):
    items = top_level_items(open(path).read())
    head = [x for x in items if x.split()[0] in ("(version", "(generator", "(generator_version", "(uuid",
                                                 "(paper", "(lib_symbols", "(title_block")]
    with tempfile.TemporaryDirectory() as tmp:
        if loads(items, tmp):
            print("the whole file loads")
            return
        if not loads(head, tmp):
            print("the header or symbol library itself fails; check lib_symbols")
            return
        bad = [x for x in items if x not in head and not loads(head + [x], tmp)]
        print(f"{len(bad)} of {len(items)} items fail on their own:")
        for x in bad:
            print("  " + x[:160].replace("\n", " "))

if __name__ == "__main__":
    main(sys.argv[1])
