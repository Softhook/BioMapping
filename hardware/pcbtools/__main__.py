"""Command line for the BioMapping circuit-board tools. Run through the
hardware/pcb launcher, which starts KiCad's own Python:

    ./pcb <command> [options]        ./pcb <command> --help for details"""
import argparse
import os
import sys
import tempfile

from .kicad import BOARDS, board_file, board_name, export_netlist, hide_kicad_noise


def boards_arg(p, help_text="flipper, cardputer or tail (default: all three)"):
    p.add_argument("boards", nargs="*", metavar="board", help=help_text)


def chosen(args):
    return tuple(board_name(b) for b in args.boards) or BOARDS


def cmd_build(args):
    from . import pipeline
    return pipeline.build(chosen(args))


def cmd_layout(args):
    from . import measure, pipeline
    problems = pipeline.build(chosen(args), regenerate=False)
    measure.measure(names=chosen(args))
    return problems


def cmd_check(args):
    from . import pipeline
    return pipeline.check(chosen(args))


def cmd_drc(args):
    from . import pipeline
    return sum(pipeline.drc(b, details=True) for b in chosen(args))


def cmd_measure(args):
    from . import measure
    if args.compare:
        measure.compare(args.compare)
    else:
        measure.measure()


def cmd_ground(args):
    from . import ground
    return sum(ground.check(b, args.picture, args.break_test) for b in (tuple(board_name(b) for b in args.boards)
                                                                       or ("biomap_cardputer",)))


def cmd_parts(args):
    from . import layout
    name = board_name(args.board)
    with tempfile.TemporaryDirectory() as tmp:
        net = os.path.join(tmp, name + ".net")
        export_netlist(board_file(name, ".kicad_sch"), net)
        _, fps, _ = layout.new_board(name, net)
        unknown = set(args.refs) - set(fps)
        if unknown:
            sys.exit(f"no such part on {name}: {' '.join(sorted(unknown))}")
        layout.dump_parts(fps, set(args.refs))


def cmd_render(args):
    from . import render
    render.render(args.out or render.DEFAULT_OUT, chosen(args))


def cmd_fab(args):
    from . import fab
    return fab.make(chosen(args))


def cmd_print(args):
    from . import fitprint
    return fitprint.make(args.out or fitprint.OUT)


def cmd_footprint(args):
    from . import footprint
    side, pads = "F", args.pads
    if pads and pads[0] in ("F", "B"):
        side, pads = pads[0], pads[1:]
    footprint.probe(args.library, args.footprint, side, pads)


def cmd_eagle(args):
    from . import eagle
    eagle.main(args.file, args.nets, args.package)


def cmd_debug_sch(args):
    from . import debug_sch
    debug_sch.main(args.file)


def cmd_autoroute(args):
    from . import autoroute
    {"export": autoroute.export, "finish": autoroute.finish}[args.step](args.pcb, args.file)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="./pcb", description=(
        "BioMapping circuit-board tools. The everyday loop: edit pcbtools/boards/<board>.py, "
        "run './pcb layout flipper', read the problems and numbers, repeat."))
    sub = ap.add_subparsers(dest="command", metavar="command")

    def add(name, fn, help_text, **kw):
        p = sub.add_parser(name, help=help_text, description=help_text, **kw)
        p.set_defaults(fn=fn)
        return p

    boards_arg(add("build", cmd_build,
                   "Rebuild everything from the Python descriptions: redraw the schematics, check them, "
                   "lay out the boards, check the boards. Overwrites the KiCad files (keeps your .kicad_pro settings)."))
    boards_arg(add("layout", cmd_layout,
                   "Quick loop while editing boards/<board>.py: lay out the board again from the saved "
                   "schematic, then show the board checks (DRC and layout limits) and the layout numbers. "
                   "Overwrites the .kicad_pcb."))
    boards_arg(add("check", cmd_check,
                   "Check the saved files without changing them: schematic vs intended connections (two ways), "
                   "ERC, DRC and the layout limits in limits.py. Exits with an error if anything is wrong."))
    boards_arg(add("drc", cmd_drc,
                   "Every design-rules problem on the saved board, with the parts and positions involved."))
    p = add("measure", cmd_measure,
            "Layout numbers that matter for noise: decoupling distances, GSR wire lengths, long-net lengths.")
    p.add_argument("--compare", metavar="GIT_REF", nargs="?", const="HEAD",
                   help="also show the numbers for a committed version (default: the last commit)")
    p = add("ground", cmd_ground,
            "How far apart the GSR's ground points move when the GPS (10 mA) or the ADC sends current "
            "through the ground copper, worked out over the whole copper; plus the ground's pieces, wires "
            "without ground under them, and the biggest gap between ground vias. Cardputer board only. "
            "Takes a few minutes. Needs numpy.")
    boards_arg(p, "cardputer (the default)")
    p.add_argument("--picture", action="store_true", help="also draw the ground's voltage into out/<board>_ground.png")
    p.add_argument("--break-test", action="store_true",
                   help="also rerun on deliberately worse boards, to show the model notices a bad ground")
    p = add("parts", cmd_parts, "Pad positions, nets and keep-out boxes of the named parts (all if none), "
                                "as the layout places them. Use before moving a part. Changes nothing.")
    p.add_argument("board", help="flipper, cardputer or tail")
    p.add_argument("refs", nargs="*", metavar="REF", help="e.g. U1 C1")
    p = add("render", cmd_render, "Pictures of each schematic and both faces of each board (needs ImageMagick).")
    boards_arg(p)
    p.add_argument("--out", help="output folder (default: hardware/out, which git ignores)")
    boards_arg(add("fab", cmd_fab,
                   "Factory files in out/fab/<board>/: Gerber and drill zip, JLCPCB parts list and placement "
                   "file, and ORDER.txt (order-form choices). Runs the full check first and writes nothing "
                   "if it fails."))
    p = add("print", cmd_print,
            "A full-size PDF of the Cardputer board and its flex tail, seen from outside, to print at 100%%, "
            "cut out and hold against a real Cardputer. With two 100 mm rulers to check the printer's scale.")
    p.add_argument("--out", help="PDF to write (default: hardware/out/biomap_cardputer_print.pdf)")
    p = add("footprint", cmd_footprint, "Where a footprint's pads land at each rotation, on either face. "
                                        "Back-face parts come out mirrored: use this to choose a rotation.")
    p.add_argument("library", help="e.g. RF_GPS, or BioMap for our own footprints")
    p.add_argument("footprint", help="e.g. ublox_SAM-M8Q")
    p.add_argument("pads", nargs="*", metavar="[F|B] pad",
                   help="F front (default) or B back, then only these pad numbers")
    p = add("eagle", cmd_eagle, "Read an Eagle .sch / .lbr file (e.g. SparkFun's open designs) without Eagle.")
    p.add_argument("file")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--nets", nargs="+", metavar="REF", help="the nets these parts sit on")
    g.add_argument("--package", metavar="NAME", help="a footprint's pads and shapes")
    p = add("debug-sch", cmd_debug_sch, "When KiCad only says 'Failed to load schematic', list which items it rejects.")
    p.add_argument("file")
    p = add("autoroute", cmd_autoroute, "The old Freerouting step (not used now): export a .dsn, or "
                                        "import a .ses and add the ground pours. Needs Java and freerouting.jar.")
    p.add_argument("step", choices=("export", "finish"))
    p.add_argument("pcb")
    p.add_argument("file", help=".dsn to write (export) or .ses to read (finish)")

    args = ap.parse_args(argv)
    if not args.command:
        ap.print_help()
        return 0
    if args.command not in ("eagle", "debug-sch"):
        hide_kicad_noise()
    problems = args.fn(args)
    if problems:
        print(f"\n{problems} problem(s) found")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
