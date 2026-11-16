"""Print the layout numbers that matter for noise, for both boards:
how far each supply capacitor sits from its chip's power pin, and how long
the copper is on the sensitive and the long nets.
Run with KiCad's Python from hardware/tools:  <kicad-python> measure_pcb.py"""
import os
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))

def main():
    for name in ("biomap_flipper", "biomap_cardputer"):
        b = pcbnew.LoadBoard(os.path.join(HERE, "..", name, name + ".kicad_pcb"))
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
        tia = next(k for k in length if "U1A" in k)       # the amplifier input has no label
        print(name)
        print(f"  supply caps to power pin: C1-U1 {dist(('C1', '1'), ('U1', '8'))} mm, "
              f"C3-U2 {dist(('C3', '1'), ('U2', '8'))} mm, C7-GPS {dist(('C7', '1'), ('U4', '17'))} mm")
        print(f"  copper: amplifier input {length[tia]:.0f} mm, GSR_SIGNAL {length['GSR_SIGNAL']:.0f}, "
              f"SDA {length['I2C_SDA']:.0f}, SCL {length['I2C_SCL']:.0f}, "
              f"GPS TX {length['GPS_TX_TO_HOST']:.0f}, GPS RX {length['HOST_TX_TO_GPS']:.0f}; vias {vias}")

if __name__ == "__main__":
    main()
