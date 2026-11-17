"""Print the layout numbers that matter for noise, for both boards:
how far each decoupling capacitor sits from its chip's supply pin and its
ground pin, and how long the copper is on the sensitive and the long nets.
Needs KiCad's Python (pcbnew)."""
import os
import subprocess
import tempfile
import pcbnew

from .kicad import BOARDS, HARDWARE, REPO, board_file

# capacitor -> (chip supply pin, chip ground pin). Distances are pad centre
# to pad centre: cap pad 1 to the supply pin, cap pad 2 to the ground pin.
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
    dist = lambda a, c: round(pcbnew.ToMM((pads[a] - pads[c]).EuclideanNorm()), 1)
    n = {}
    for c, (sup, gnd) in DECOUPLING.items():
        if (c, "1") in pads:
            n[f"{c}-{sup[0]} supply"] = dist((c, "1"), sup)
            n[f"{c}-{gnd[0]} ground"] = dist((c, "2"), gnd)
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
    # ground vias around the GPS module: in the 50 x 50 mm plane u-blox asks
    # for, and in the 16 x 16 mm square under the module itself
    gps = next(fp for fp in b.GetFootprints() if fp.GetReference() == "U4").GetPosition()
    gx, gy = pcbnew.ToMM(gps.x), pcbnew.ToMM(gps.y)
    within = lambda half: sum(abs(x - gx) <= half and abs(y - gy) <= half for x, y in gnd_vias)
    n["GPS plane ground vias"] = within(25)
    n["under-GPS ground vias"] = within(8)
    return n


def measure(root=HARDWARE, names=BOARDS):
    """root: a folder holding biomap_flipper/ and biomap_cardputer/ (default: this checkout)."""
    for name in names:
        n = numbers(board_file(name, ".kicad_pcb", root))
        print(name)
        print("  decoupling: " + ", ".join(
            f"{c}-{sup[0]} supply {n[f'{c}-{sup[0]} supply']} / ground {n[f'{c}-{gnd[0]} ground']} mm"
            for c, (sup, gnd) in DECOUPLING.items() if f"{c}-{sup[0]} supply" in n))
        print("  GSR copper: " + ", ".join(f"{label} {n[label]:.1f} mm" for label, _ in GSR_NETS))
        print("  long nets: " + ", ".join(f"{label} {n[label]}" for label, _ in LONG_NETS) + f" mm; vias {n['vias']}")
        print(f"  GPS ground vias: {n['GPS plane ground vias']} in the 50 x 50 mm plane, "
              f"{n['under-GPS ground vias']} under the module")

def compare(ref):
    """The numbers for a committed version (git ref) above those for the working copy.
    The old boards are copied out with `git show` into a temporary folder, so
    the working files are never touched."""
    with tempfile.TemporaryDirectory() as old:
        for name in BOARDS:
            os.makedirs(os.path.join(old, name))
            rel = os.path.relpath(board_file(name, ".kicad_pcb"), REPO)
            with open(board_file(name, ".kicad_pcb", old), "w") as f:
                f.write(subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=REPO, check=True,
                                       capture_output=True, text=True).stdout)
        print(f"=== {ref}")
        measure(old)
    print("=== working copy")
    measure()
