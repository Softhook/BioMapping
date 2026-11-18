"""Print the layout numbers that matter for noise, for both boards:
how far each decoupling capacitor sits from its chip's supply pin and its
ground pin, and how long the copper is on the sensitive and the long nets.
Needs KiCad's Python (pcbnew).

The ground number follows the way the current really flows. A capacitor's
ground pad and its chip's ground pin are usually joined through the solid
ground layer: down a via near the capacitor, across the layer, and up a via
near the chip. The layer itself adds almost nothing, so what counts is the
two surface stretches to those vias. The ground number is the shorter of
that and the straight distance between the two pads (for a capacitor wired
straight to its pin, like C7 on the GPS)."""
import os
import subprocess
import tempfile
import pcbnew

from .kicad import BOARDS, HARDWARE, REPO, board_file

# capacitor -> (chip supply pin, chip ground pin). Distances are pad centre
# to pad centre: cap pad 1 to the supply pin; cap pad 2 to the ground pin
# either directly or through the ground layer (see above).
DECOUPLING = {
    "C1": (("U1", "8"), ("U1", "4")),      # op-amp
    "C3": (("U2", "8"), ("U2", "3")),      # ADC
    "C7": (("U4", "17"), ("U4", "16")),    # GPS
    "C5": (("U3", "5"), ("U3", "2")),      # regulator output (Cardputer only)
}
# sensitive GSR nets: the amplifier input has no label, so it is found by part name
GSR_NETS = [("amplifier input", "U1A"), ("GSR_SIGNAL", "GSR_SIGNAL"), ("0.5 V ref", "REF_0V5"),
            ("bias divider", "U1B")]
LONG_NETS = [("SDA", "I2C_SDA"), ("SCL", "I2C_SCL"), ("GPS TX", "GPS_TX_TO_HOST"), ("GPS RX", "HOST_TX_TO_GPS")]

def numbers(pcb_path):
    """The layout numbers for one saved board, by name (mm, or counts for vias)."""
    b = pcbnew.LoadBoard(pcb_path)
    pads = {(fp.GetReference(), p.GetNumber()): p.GetPosition()
            for fp in b.GetFootprints() for p in fp.Pads()}
    mm = lambda a, c: pcbnew.ToMM((a - c).EuclideanNorm())
    gnd_vias = [t.GetPosition() for t in b.GetTracks()
                if t.GetClass() == "PCB_VIA" and t.GetNetname().lstrip("/") == "GND"]
    to_via = lambda pad: min(mm(pads[pad], v) for v in gnd_vias)
    n = {}
    for c, (sup, gnd) in DECOUPLING.items():
        if (c, "1") in pads:
            n[f"{c}-{sup[0]} supply"] = round(mm(pads[(c, "1")], pads[sup]), 1)
            n[f"{c}-{gnd[0]} ground"] = round(min(mm(pads[(c, "2")], pads[gnd]),
                                                  to_via((c, "2")) + to_via(gnd)), 1)
    length, vias, gnd_vias = {}, 0, []
    for t in b.GetTracks():
        if t.GetClass() == "PCB_TRACK":
            k = t.GetNetname().lstrip("/")
            length[k] = length.get(k, 0) + pcbnew.ToMM(t.GetLength())
        else:
            vias += 1
            if t.GetNetname().lstrip("/") == "GND":
                gnd_vias.append((pcbnew.ToMM(t.GetPosition().x), pcbnew.ToMM(t.GetPosition().y)))
    for label, key in GSR_NETS:
        n[label] = round(sum(v for k, v in length.items() if key in k), 1)
    for label, key in LONG_NETS:
        n[label] = round(length.get(key, 0))
    n["vias"] = vias
    # copper tracks on the ground-plane face (the face without parts): each one
    # is a cut in the ground the other face's wires use as their return path
    on_f = sum(not fp.IsFlipped() for fp in b.GetFootprints())
    plane = pcbnew.B_Cu if on_f > len(b.GetFootprints()) / 2 else pcbnew.F_Cu
    n["ground-face tracks"] = round(sum(pcbnew.ToMM(t.GetLength()) for t in b.GetTracks()
                                        if t.GetClass() == "PCB_TRACK" and t.GetLayer() == plane), 1)
    gps = next((fp for fp in b.GetFootprints() if fp.GetReference() == "U4"), None)
    if gps is None:                     # the Cardputer's flex tail: connectors only
        return n
    # ground vias around the GPS module: in the 50 x 50 mm plane u-blox asks
    # for, and in the 16 x 16 mm square under the module itself
    gx, gy = pcbnew.ToMM(gps.GetPosition().x), pcbnew.ToMM(gps.GetPosition().y)
    within = lambda half: sum(abs(x - gx) <= half and abs(y - gy) <= half for x, y in gnd_vias)
    n["GPS plane ground vias"] = within(25)
    n["under-GPS ground vias"] = within(8)
    # filled copper of the 0.5 V guard round the amplifier input (mm^2)
    n["0.5 V guard copper"] = round(sum(z.GetFilledPolysList(z.GetLayer()).Area() for z in b.Zones()
                                        if z.GetZoneName() == "0.5 V guard") / 1e12, 1)
    return n


def measure(root=HARDWARE, names=BOARDS):
    """root: a folder holding the board folders (default: this checkout)."""
    for name in names:
        path = board_file(name, ".kicad_pcb", root)
        if not os.path.exists(path):
            print(f"{name}: not in this version")
            continue
        n = numbers(path)
        print(name)
        if "GPS plane ground vias" not in n:        # the flex tail: nothing noise-sensitive on it
            print(f"  connectors only; vias {n['vias']}")
            continue
        print("  decoupling: " + ", ".join(
            f"{c}-{sup[0]} supply {n[f'{c}-{sup[0]} supply']} / ground {n[f'{c}-{gnd[0]} ground']} mm"
            for c, (sup, gnd) in DECOUPLING.items() if f"{c}-{sup[0]} supply" in n))
        print("  GSR copper: " + ", ".join(f"{label} {n[label]:.1f} mm" for label, _ in GSR_NETS))
        print("  long nets: " + ", ".join(f"{label} {n[label]}" for label, _ in LONG_NETS) + f" mm; vias {n['vias']}")
        print(f"  tracks on the ground-plane face: {n['ground-face tracks']} mm")
        print(f"  GPS ground vias: {n['GPS plane ground vias']} in the 50 x 50 mm plane, "
              f"{n['under-GPS ground vias']} under the module; 0.5 V guard copper {n['0.5 V guard copper']} mm2")

def compare(ref):
    """The numbers for a committed version (git ref) above those for the working copy.
    The old boards are copied out with `git show` into a temporary folder, so
    the working files are never touched."""
    with tempfile.TemporaryDirectory() as old:
        for name in BOARDS:
            os.makedirs(os.path.join(old, name))
            rel = os.path.relpath(board_file(name, ".kicad_pcb"), REPO)
            r = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=REPO, capture_output=True, text=True)
            if r.returncode == 0:                   # a board added since ref is left out
                with open(board_file(name, ".kicad_pcb", old), "w") as f:
                    f.write(r.stdout)
        print(f"=== {ref}")
        measure(old)
    print("=== working copy")
    measure()
