"""Export DSN / import SES / add ground pours. Run with KiCad's Python.
usage: route_pcb.py export|finish <pcb> <dsn-or-ses>"""
import sys
import pcbnew

MM = pcbnew.FromMM

def export(pcb, dsn):
    b = pcbnew.LoadBoard(pcb)
    assert pcbnew.ExportSpecctraDSN(b, dsn), "DSN export failed"

def finish(pcb, ses):
    b = pcbnew.LoadBoard(pcb)
    assert pcbnew.ImportSpecctraSES(b, ses), "SES import failed"
    gnd = b.FindNet("/GND") or b.FindNet("GND")
    bb = b.GetBoardEdgesBoundingBox()
    for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
        z = pcbnew.ZONE(b)
        z.SetLayer(layer); z.SetNet(gnd)
        z.SetLocalClearance(MM(0.3)); z.SetMinThickness(MM(0.25))
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
        z.SetThermalReliefGap(MM(0.4)); z.SetThermalReliefSpokeWidth(MM(0.4))
        ol = z.Outline(); ol.NewOutline()
        for x, y in ((bb.GetLeft(), bb.GetTop()), (bb.GetRight(), bb.GetTop()),
                     (bb.GetRight(), bb.GetBottom()), (bb.GetLeft(), bb.GetBottom())):
            ol.Append(x, y)
        b.Add(z)
    # the ADS1115 (0.5 mm pitch) has no room for two thermal spokes: connect its ground pads solid
    for fp in b.GetFootprints():
        if fp.GetReference() == "U2":
            for p in fp.Pads():
                if p.GetNetname() == gnd.GetNetname():
                    p.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(pcb, b)

if __name__ == "__main__":
    {"export": export, "finish": finish}[sys.argv[1]](sys.argv[2], sys.argv[3])
