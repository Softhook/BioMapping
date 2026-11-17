"""The earlier Freerouting autorouter step. Not used now: the boards are
routed by hand in boards/*.py. Kept in case autorouting is wanted again.
Needs Java and freerouting.jar for the routing itself.

    export: write the board as a Specctra .dsn file for Freerouting
    finish: read Freerouting's .ses file back, add ground pours, fill"""
import pcbnew

from .layout import add_ground, solid_ground_pads


def export(pcb, dsn):
    b = pcbnew.LoadBoard(pcb)
    assert pcbnew.ExportSpecctraDSN(b, dsn), "DSN export failed"


def finish(pcb, ses):
    b = pcbnew.LoadBoard(pcb)
    assert pcbnew.ImportSpecctraSES(b, ses), "SES import failed"
    add_ground(b, b.FindNet("/GND") or b.FindNet("GND"))
    solid_ground_pads(b)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(pcb, b)
