"""Read KiCad's bracketed text files (.kicad_sch, .net, ...) into nested lists.

    (net (name "GND") (node (ref "U1") (pin "4")))
becomes
    ["net", ["name", "GND"], ["node", ["ref", "U1"], ["pin", "4"]]]"""
import re

_TOKEN = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+')


def parse(text):
    stack, cur = [], []
    for t in _TOKEN.findall(text):
        if t == "(":
            stack.append(cur)
            cur = []
        elif t == ")":
            done = cur
            cur = stack.pop()
            cur.append(done)
        else:
            cur.append(t[1:-1] if t.startswith('"') else t)
    assert not stack and len(cur) == 1, "unbalanced parentheses"
    return cur[0]


def find(node, key):
    """The child lists of node that start with key."""
    return [c for c in node if isinstance(c, list) and c and c[0] == key]
