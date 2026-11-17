"""Print the layout numbers that matter for noise, for both boards:
how far each decoupling capacitor sits from its chip's supply pin and its
ground pin, and how long the copper is on the sensitive and the long nets.
Run with KiCad's Python from hardware/tools:
  <kicad-python> measure_pcb.py [hardware-dir]
hardware-dir defaults to this checkout; compare_measure.sh passes an older copy."""
import os
import sys
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))

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

def main(root):
    for name in ("biomap_flipper", "biomap_cardputer"):
        b = pcbnew.LoadBoard(os.path.join(root, name, name + ".kicad_pcb"))
        pads = {(fp.GetReference(), p.GetNumber()): p.GetPosition()
                for fp in b.GetFootprints() for p in fp.Pads()}
        dist = lambda a, c: round(pcbnew.ToMM((pads[a] - pads[c]).EuclideanNorm()), 1)
        length, vias = {}, 0
        for t in b.GetTracks():
            if t.GetClass() == "PCB_TRACK":
                n = t.GetNetname().lstrip("/")
                length[n] = length.get(n, 0) + pcbnew.ToMM(t.GetLength())
            else:
                vias += 1
        def net_len(key):
            return sum(v for k, v in length.items() if key in k)
        print(name)
        caps = [f"{c}-{sup[0]} supply {dist((c, '1'), sup)} / ground {dist((c, '2'), gnd)} mm"
                for c, (sup, gnd) in DECOUPLING.items() if (c, "1") in pads]
        print("  decoupling: " + ", ".join(caps))
        print("  GSR copper: " + ", ".join(f"{label} {net_len(k):.1f} mm" for label, k in GSR_NETS))
        print(f"  long nets: SDA {length['I2C_SDA']:.0f}, SCL {length['I2C_SCL']:.0f}, "
              f"GPS TX {length['GPS_TX_TO_HOST']:.0f}, GPS RX {length['HOST_TX_TO_GPS']:.0f} mm; vias {vias}")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, ".."))
