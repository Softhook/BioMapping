"""Show where a footprint's pads land for each rotation, on either face.
Parts on the back face come out mirrored, so this is the quick way to pick
the rotation that points a part's pins where you want them.
Run with KiCad's Python:
  <kicad-python> probe_footprint.py <Library> <Footprint> [B|F] [pad ...]
e.g.  probe_footprint.py RF_GPS ublox_SAM-M8Q B 13 17 2
      probe_footprint.py BioMap Seiko_MS421R_IV03E      (our own footprints)"""
import os
import sys
import pcbnew

FPDIR = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints"
LOCAL_LIBS = {"BioMap": os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "BioMap.pretty")}

def main(lib, name, side="F", *pads):
    for rot in (0, 90, 180, -90):
        board = pcbnew.BOARD()
        fp = pcbnew.FootprintLoad(LOCAL_LIBS.get(lib, f"{FPDIR}/{lib}.pretty"), name)
        board.Add(fp)
        if side == "B":
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        fp.SetOrientationDegrees(rot)
        out = [f"{p.GetNumber()}:({pcbnew.ToMM(p.GetPosition().x):.2f},{pcbnew.ToMM(p.GetPosition().y):.2f})"
               for p in fp.Pads() if not pads or p.GetNumber() in pads]
        bb = fp.GetCourtyard(pcbnew.B_CrtYd if side == "B" else pcbnew.F_CrtYd).BBox()
        print(f"rot {rot:4d}: {' '.join(sorted(out))}  courtyard x {pcbnew.ToMM(bb.GetLeft()):.1f}.."
              f"{pcbnew.ToMM(bb.GetRight()):.1f} y {pcbnew.ToMM(bb.GetTop()):.1f}..{pcbnew.ToMM(bb.GetBottom()):.1f}")

if __name__ == "__main__":
    main(*sys.argv[1:])
