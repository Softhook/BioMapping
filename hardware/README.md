# BioMapping circuit boards (KiCad)

Two KiCad 10 projects. Both carry the same GSR circuit as [docs/wiring_guide.md](../docs/wiring_guide.md) and the u-blox SAM-M10Q GPS module, soldered straight onto the board (no breakout board):

| Folder | Plugs into | Board | Power |
|---|---|---|---|
| `biomap_flipper/` | Flipper Zero GPIO | 80 × 52 mm, stands up from the Flipper's top edge | Flipper's 3.3 V (pin 9) |
| `biomap_cardputer/` | Cardputer ADV EXT socket | 84 × 54 mm (the device's back) plus a 9 mm tab; two M2 × 4 mm screws | Own 3.3 V regulator (TLV75533), fed from EXT 5 V out |

Both boards are placed and routed. KiCad's checks pass on both: the wiring check (ERC) and the design rules check (DRC) show 0 errors and 0 warnings, nothing is unconnected, and each board matches its schematic.

## How the schematic is drawn

Each schematic is one A3 sheet split into labelled blocks:

1. Skin sensor (current-to-voltage amplifier)
2. 0.5 V reference and op-amp supply
3. Analogue-to-digital converter
4. Header (Flipper or Cardputer)
5. GPS
6. 5 V to 3.3 V regulator (Cardputer only)

Inside a block, parts are joined by drawn wires. Between blocks, a signal is carried by a name tag (a "net label"), for example `GSR_SIGNAL` or `I2C_SDA`: every tag with the same name is the same wire. 3.3 V and GND use the usual power symbols.

## How the boards are laid out

Each board has two halves.

- **GSR half.** The parts follow the signal: cuffs, then R3/R4, then the op-amp, then the ADC. The cuff socket is on the board edge. The amplifier's input wire, which carries the tiny skin current and is the most sensitive to noise, is 10 mm long. Each 100 nF supply capacitor sits close to the power pin of its chip: C1 and C3 about 3 mm, C7 about 3.7 mm.
- **GPS half.** The module sits in the middle of an unbroken ground area of about 50 × 52 mm (Flipper) or 52 × 54 mm (Cardputer). Small parts sit right beside the pins they serve. C7 bridges the module's supply pin and the ground pin next to it.

Long runs (I2C and the 3.3 V feed) go along the board edge on the other copper layer, outside the GPS area. Ground fills both copper layers, joined by a grid of vias: 3 mm apart around the GPS, 5 mm elsewhere. KiCad has a "GPS keep clear" zone that refuses new traces under and around the module, so hand edits can't break this by accident.

## The GPS ground plane

The SAM-M10Q's antenna uses the board's ground as part of the antenna. u-blox's integration manual (in `docs/datasheets/`) asks for:

- a solid ground plane of 50 × 50 mm, with the module in the middle; performance drops a lot below 40 × 40 mm
- no signal traces under the module, and ground vias filling the plane under it
- nothing taller than 3 mm within 10 mm of the module
- a plastic case at least 5 mm from the antenna

SparkFun's breakout is 40.6 × 40.6 mm, the minimum, with ground on both layers and about 100 vias. These boards give the module a larger ground area. The module's own circuit copies SparkFun's:

- 100 nF on the supply (plus a 10 µF reservoir, which SparkFun doesn't have)
- a rechargeable backup cell (BT1, Seiko MS421R, the same cell SparkFun uses), charged through D1 and a 3.3 kΩ resistor, with 100 nF
- 470 Ω in series with TX and RX

Two test pads, SAFEBOOT and RESET, take the place of SparkFun's header pins. The firmware needs no change: it uses the same serial pins as before.

## Parts

- **ADS1115 as a bare chip** (MSOP-10). The Flipper board has its own I2C pull-up resistors (R6, R7). On the Cardputer these are marked "do not fit", because its bus already has pull-ups.
- **Precision resistors suggested** for R1, R2 and R5 (0.1%), and a **C0G capacitor** for C2. These set the GSR scale directly.
Each board's `bom.csv` lists every part with its maker, maker's part number and LCSC number (LCSC is the parts store JLCPCB assembles from). Identical parts share one row. The everyday resistors and capacitors are JLCPCB "basic" parts, which have no extra fitting fee.

Everything is surface-mount and suits machine assembly, except the angled pin headers.

- **Finger cuffs:** JST PH 2-pin side-entry socket, surface-mount (J2, S2B-PH-SM4-TB). Its two side tabs only hold it down.
- **GPS:** u-blox SAM-M10Q-00B (U4), on KiCad's standard SAM-M8Q footprint; u-blox says the two modules are pin-compatible. **LCSC has none in stock**, so buy them from Mouser or Digi-Key and send them to the assembler.
- **Backup cell:** Seiko MS421R-IV03E (rechargeable, 3 V, 1.5 mAh, 4.8 mm). It can go through the soldering oven, so a machine fits it like any other part. It is the cell on SparkFun's SAM-M10Q board, and its footprint (`BioMap.pretty/Seiko_MS421R_IV03E`) copies SparkFun's pads. With the GPS switched off it draws 28 µA, so the cell keeps satellite data for about two days. Not stocked by LCSC; Farnell 3534555.
- **C2** is 1206 size, because 100 nF C0G capacitors are hard to find in 0805.
- **Flipper header:** two angled through-hole pieces, pins 1–8 and 9–18, 17.78 mm apart, to match the gap in the Flipper's GPIO. Through-hole is kept on purpose: these joints hold the board in place.
- **Cardputer header:** one angled through-hole 2 × 7 header on the tab, pointing into the EXT socket.

## Check before ordering (both boards)

- **Soldering the GPS module.** Its pads sit underneath it, so it needs an oven, hotplate or hot air. Follow u-blox's soldering profile and use no-clean flux. Don't wash the board afterwards with water, alcohol or an ultrasonic cleaner; the manual warns that each one can damage the module.
- **Backup cell footprint.** It is copied from SparkFun's production design, not from Seiko's drawing. Before ordering, compare it with the IV03E terminal drawing on Seiko's MS421R page: the small corner tab is + (pad 1), the long tab is −.
- **Which way the antenna faces.** The antenna works best facing the sky. On the Flipper, the board stands up from the top edge, so the antenna faces sideways while the Flipper lies flat and faces up when the Flipper is held upright. On the Cardputer, it faces out from the back.

## Check before ordering (Cardputer)

These come from M5Stack's dimension drawing and 3D models, not from a real device.

- **Header height.** The angled header holds its pins about 1.3 mm and 3.8 mm above the board. The socket rows look to be about 4.5 mm and 7 mm above the Cardputer's back, so the header needs lifting by about 3 mm (for example with a plastic spacer).
- **Which row is which.** The board assumes the even-numbered row (GND, 5 V out, SDA, SCL, G13, G15) is the one nearest the back. Check with a multimeter before plugging in. Pin 2 is 5 V *in* and must stay unconnected.
- **Screws.** Use M2 × 4 mm only. M5Stack warns that longer screws can damage the board inside.

## Regenerating

`tools/run_all.sh` rebuilds both boards from scratch. It needs KiCad 10 and nothing else. The steps:

1. `gen_kicad.py` draws the schematics.
2. `check_sch.py` reads the drawing itself (without KiCad) and checks every pin against the intended connections.
3. `check_netlist.py` does the same check again on KiCad's own netlist of the drawing. The two checks work differently, so a fault one misses the other should catch.
4. ERC (KiCad's wiring check).
5. `build_pcb.py` places every part, draws every trace and adds the ground fills.
6. DRC (KiCad's design rules check).

Part positions and traces are written out in `build_pcb.py`; no autorouter is involved. **Running the scripts overwrites the boards**, so don't run them once you have edited the boards by hand in KiCad.

They also overwrite each `.kicad_pro` with a bare one. If you have opened the projects in KiCad, put your saved settings back afterwards with `git checkout -- biomap_*/*.kicad_pro` (the design rules are the same in both).

Other tools in `tools/`, used while making the layout:

| Tool | What it does |
|---|---|
| `build_one.sh <board>` | Rebuilds one board and lists DRC problems by kind. The quick loop while moving parts or traces in `build_pcb.py`. Add `--dump` to print every pad's position and net. |
| `render.sh [folder]` | Draws pictures of both schematics and both faces of each board (default folder `tools/out`, which git ignores). Needs ImageMagick. |
| `measure_pcb.py [folder]` | Prints the numbers that matter for noise: each decoupling capacitor's distance to its chip's supply pin *and* ground pin, and copper lengths on the GSR wires and the long wires. Run with KiCad's Python. |
| `compare_measure.sh [git-ref]` | The `measure_pcb.py` numbers for a committed version (default: the last commit) next to the working copy, so you can see whether a layout change helped. Leaves your files alone. |
| `dump_parts.sh <board> [REF ...]` | Pad positions, nets and keep-out boxes for just the parts you name, e.g. `dump_parts.sh biomap_flipper U1 C1`. Use before moving a part. |
| `drc_details.sh <board>` | Every design-rules problem on the saved board, with the parts and positions involved (`build_one.sh` only counts them). |
| `eagle_parts.py <file>` | Reads Eagle files such as SparkFun's open designs, without Eagle: the parts list, `--nets REF` for what a part connects to, `--package NAME` for footprint pad shapes. This is how the MS421R cell and its pads were found. |
| `probe_footprint.py` | Shows where a footprint's pads land at each rotation, on either face. Back-face parts come out mirrored, so this is how to choose a rotation. Also reads our own footprints (`BioMap` library). Run with KiCad's Python. |
| `find_bad_sch_items.py <file>` | When KiCad only says "Failed to load schematic", lists which items in the file it rejects. |
| `route_pcb.py` | The earlier Freerouting autorouter step (DSN export, SES import, ground fills). Not used now; kept in case autorouting is wanted again. Needs Java and `freerouting.jar`. |

KiCad's Python is at `/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3`.
