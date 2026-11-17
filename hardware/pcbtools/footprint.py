"""Show where a footprint's pads land for each rotation, on either face.
Parts on the back face come out mirrored, so this is the quick way to pick
the rotation that points a part's pins where you want them.
Reads KiCad's own libraries and ours (BioMap). Needs KiCad's Python."""
import pcbnew

from .kicad import load_footprint


def probe(lib, name, side="F", pads=()):
    for rot in (0, 90, 180, -90):
        board = pcbnew.BOARD()
        fp = load_footprint(lib, name)
        board.Add(fp)
        if side == "B":
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.SetOrientationDegrees(rot)
        out = [f"{p.GetNumber()}:({pcbnew.ToMM(p.GetPosition().x):.2f},{pcbnew.ToMM(p.GetPosition().y):.2f})"
               for p in fp.Pads() if not pads or p.GetNumber() in pads]
        bb = fp.GetCourtyard(pcbnew.B_CrtYd if side == "B" else pcbnew.F_CrtYd).BBox()
        print(f"rot {rot:4d}: {' '.join(sorted(out))}  courtyard x {pcbnew.ToMM(bb.GetLeft()):.1f}.."
              f"{pcbnew.ToMM(bb.GetRight()):.1f} y {pcbnew.ToMM(bb.GetTop()):.1f}..{pcbnew.ToMM(bb.GetBottom()):.1f}")
