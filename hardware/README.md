# BioMapping circuit boards (KiCad)

Two KiCad 10 projects. Both carry the same GSR circuit as [docs/wiring_guide.md](../docs/wiring_guide.md) and the u-blox SAM-M10Q GPS module, soldered straight onto the board (no breakout board):

| Folder | Plugs into | Board | Power |
|---|---|---|---|
| `biomap_flipper/` | Flipper Zero GPIO | 72 × 52 mm, stands up from the Flipper's top edge | Flipper's 3.3 V (pin 9) |
| `biomap_cardputer/` | Flex tail, soldered on | 84 × 54 mm, exactly the device's back; two M2 × 4 mm screws | Own 3.3 V regulator (TLV75533), fed from EXT 5 V out |
| `biomap_cardputer_tail/` | Cardputer ADV EXT socket | Flexible strip, 24 mm long; stiff 20 × 8 mm plug end | Carries EXT's 5 V, ground, I2C and serial lines to the Cardputer board |

All three boards are placed and routed. KiCad's checks pass on all of them: the wiring check (ERC) and the design rules check (DRC) show 0 errors and 0 warnings, nothing is unconnected, and each board matches its schematic.

## How the schematic is drawn

Each schematic is one A3 sheet split into labelled blocks:

1. Skin sensor (current-to-voltage amplifier)
2. 0.5 V reference and op-amp supply
3. Analogue-to-digital converter
4. Header (Flipper) or flex tail pads (Cardputer)
5. GPS
6. 5 V to 3.3 V regulator (Cardputer only)

Inside a block, parts are joined by drawn wires. Between blocks, a signal is carried by a name tag (a "net label"), for example `GSR_SIGNAL` or `I2C_SDA`: every tag with the same name is the same wire. 3.3 V and GND use the usual power symbols.

## How the boards are laid out

Each board has two halves.

- **GSR half.** The parts follow the signal: cuffs, then R3/R4, then the op-amp, then the ADC. The cuff socket sits at the board edge with its opening 0.75 mm inside it, so nothing sticks out past the edge and the plug can be pushed in and pulled out straight, with fingers free to grip it. The amplifier's input wire, which carries the tiny skin current and is the most sensitive to noise, is under 10 mm long (about 7 mm on the Cardputer). Each 100 nF supply capacitor sits close to the power pin of its chip: C1 and C3 about 2 mm (each right beside the pin), C7 about 3.7 mm (bridging the GPS supply pad and the ground pad next to it). The ground ends of C1 and C3 reach ground through a via right beside the capacitor, and the chips' ground pins have their own via within 1.6 mm, so each loop is about 2.3–2.7 mm in all (see `./pcb measure`).
- **0.5 V guard.** A patch of copper held at 0.5 V surrounds the amplifier's input wire, R4, C2, R5 and the cuff-2 wire. That wiring also sits at about 0.5 V, so no current can leak between it and the guard. Without the guard, ground copper 0.3 mm away could leak a little current through flux left on the board, and that current would be added to the skin reading. The flux can't simply be washed off, because the GPS module mustn't be washed. The guard joins the reference at U1 pin 3, right beside the input pin 2. Ground copper is kept out of the guard's area: even U1's own ground pin takes its via just outside it.
- **Test pads.** TP3 (GSR output), TP5 (ground) beside it, and TP4 (0.5 V reference), for a meter or scope when checking a new board.
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
- **Precision resistors suggested** for R1, R2 and R5 (0.1%), and a **C0G capacitor** for C2. These set the GSR scale directly. R3 and R4, the two 4.7k skin current limiters, are 0.1% too: the firmware subtracts exactly 9.4k for them, and with 1% parts that sum could be up to 94 Ω out, enough to read very sweaty skin (around 10k) up to about 1% low.
- **Op-amp: TI OPA2333AIDR** (U1), a "zero-drift" op-amp. Its input error is under 10 µV, against up to 4.5 mV for the MCP6002 on the hand-built prototype, so the 0.5 V across the skin stays exact and doesn't drift with temperature. It has the same pins as the MCP6002. Buy TI's own part: LCSC also lists cheaper copies from other makers with different specs.
- **C9 (10 µF) across R2** smooths the 0.5 V bias. The bias is taken from 3.3 V, and the GSR reading scales with it, so without C9 any wobble on 3.3 V would show up in the reading.
Each board's `bom.csv` lists every part with its maker, maker's part number and LCSC number (LCSC is the parts store JLCPCB assembles from). Identical parts share one row. The everyday resistors and capacitors are JLCPCB "basic" parts, which have no extra fitting fee.

Everything is surface-mount and suits machine assembly, except the angled pin headers.

- **Finger cuffs:** JST PH 2-pin side-entry socket, surface-mount (J2, S2B-PH-SM4-TB). Its two side tabs only hold it down.
- **GPS:** u-blox SAM-M10Q-00B (U4), on KiCad's standard SAM-M8Q footprint; u-blox says the two modules are pin-compatible. **LCSC has none in stock**, so buy them from Mouser or Digi-Key and send them to the assembler.
- **Backup cell:** Seiko MS421R-IV03E (rechargeable, 3 V, 1.5 mAh, 4.8 mm). It can go through the soldering oven, so a machine fits it like any other part. It is the cell on SparkFun's SAM-M10Q board, and its footprint (`BioMap.pretty/Seiko_MS421R_IV03E`) copies SparkFun's pads. With the GPS switched off it draws 28 µA, so the cell keeps satellite data for about two days. Not stocked by LCSC; Farnell 3534555.
- **C2** is 1206 size, because 100 nF C0G capacitors are hard to find in 0805.
- **Flipper header:** two angled through-hole pieces, pins 1–8 and 9–18, 17.78 mm apart, to match the gap in the Flipper's GPIO. Through-hole is kept on purpose: these joints hold the board in place.
- **Cardputer connection:** a flex tail (see below).

## How the Cardputer connects

The Cardputer board screws flat onto the back and has no header or socket. A **flex tail** (`biomap_cardputer_tail/`) joins it to the EXT socket. This is a flexible circuit: a strip of thin polyimide plastic with the copper wires inside, made to our own shape.

- **Plug end** (20 × 8 mm): a 1 mm FR4 stiffener is glued on the side facing the Cardputer, and a straight 2 × 7 header is soldered through it. It stands against the Cardputer's bottom edge with the header in the EXT socket.
- **Bendy strip** (13 mm wide, 9 mm long): folds round the bottom edge. It has copper on one side only, and no copper fill, so it bends easily. About 1 mm of slack is built in.
- **Solder end** (13 × 7 mm): 8 plated pads, 1.5 mm apart, each with a 0.5 mm hole. It lies flat on the Cardputer board's landing pads (J1) inside the printed outline, and is soldered there for good.

Why a soldered tail: a header fixed to the main board would have to line up with the socket in three directions at once, and sockets for a separate cable stand about 2.5 mm tall. The tail takes up any mismatch, and nothing on the Cardputer board stands taller than the flex, about 0.2 mm. The only thing you unplug is the header from EXT; the board and its tail come off together.

- **Wire order:** tail pad *k* lies on board pad *k*, the same signal. A ground wire runs between the signals: 5 V, GND, SDA, GND, SCL, GND, G13, G15. On the tail the three ground wires join the header's GND pin on the outer face, inside the stiffened end, where nothing bends.
- **Ordering the tail:** order it as a 2-layer flex board (JLCPCB, PCBWay), with coverlay on both sides and a 1.0 mm FR4 stiffener on the F side over the plug end. The stiffener outline and notes are on the drawings layer (`Dwgs.User`). Choose ENIG (gold) pads: they solder well and don't tarnish. A first batch of 5 seems to be roughly $15–25, but check the instant quote.
- **Soldering it on:**
  1. Solder the header into the plug end first.
  2. Tin the landing pads on the Cardputer board lightly (if the assembler applied paste there, they already are).
  3. Lay the tail's solder end over them, F side down ("THIS SIDE DOWN" is printed there), inside the printed outline, and hold it with heat-resistant tape.
  4. Touch each pad with the iron and a little solder: it runs through the hole onto the pad below, and you can see every joint has taken.
  5. Put a strip of Kapton tape over the joint, so bending the tail never pulls on the solder.

## Check before ordering (both boards)

- **Soldering the GPS module.** Its pads sit underneath it, so it needs an oven, hotplate or hot air. Follow u-blox's soldering profile and use no-clean flux. Don't wash the board afterwards with water, alcohol or an ultrasonic cleaner; the manual warns that each one can damage the module.
- **Backup cell footprint.** It is copied from SparkFun's production design, not from Seiko's drawing. Before ordering, compare it with the IV03E terminal drawing on Seiko's MS421R page: the small corner tab is + (pad 1), the long tab is −.
- **Which way the antenna faces.** The antenna works best facing the sky. On the Flipper, the board stands up from the top edge, so the antenna faces sideways while the Flipper lies flat and faces up when the Flipper is held upright. On the Cardputer, it faces out from the back.

## Check before ordering (Cardputer)

These come from M5Stack's dimension drawing and 3D models, not from a real device.

- **Which way the EXT socket faces.** The tail assumes the socket opens out of the bottom edge, with its rows about 4.5 mm and 7 mm in from the back, as M5Stack's 3D model suggests. M5Stack's written docs only say it is "on the underside". Small errors in these numbers don't matter much, because the flex takes them up. But if the socket actually opens into the back face, the tail's shape has to change and the main board needs a cut-out over it.
- **Which row is which.** The tail assumes the even-numbered row (GND, 5 V out, SDA, SCL, G13, G15) is the one nearest the back. Check with a multimeter before plugging in. Pin 2 is 5 V *in* and must stay unconnected. If it turns out wrong, only the tail needs remaking.
- **Room along the bottom edge.** Check that nothing else on that edge (a port or button) is in the way of the tail's plug end. It is 20 mm wide, centred on the EXT socket.
- **The tail's length.** It is drawn with about 1 mm of slack round the edge. Check the fold on a real Cardputer before ordering many; a longer strip is a one-line change in `cardputer_tail.py`.
- **Screws.** Use M2 × 4 mm only. M5Stack warns that longer screws can damage the board inside.

## Tools

Everything is done with one command, `./pcb`, run from this folder. It needs KiCad 10 and nothing else (pictures also need ImageMagick). It runs KiCad's own Python for you. If KiCad isn't in `/Applications`, set `KICAD_APP` to your `KiCad.app`.

```
./pcb --help              list the commands
./pcb <command> --help    details of one command
```

### Where things live

| Path | What it holds |
|---|---|
| `pcbtools/boards/flipper.py`, `cardputer.py`, `cardputer_tail.py` | **The layouts.** Every part's position and every trace, written out by hand. This is what you edit to change a layout. |
| `pcbtools/schematic.py` | The parts lists (which pin joins which net, what to buy) and the schematic drawings. Edit this to change the circuit or the BOM. |
| `pcbtools/rules.py` | Track widths, via size and the 0.15 mm clearance, plus the extra DRC rules written to each board's `.kicad_dru` (below). |
| `pcbtools/limits.py` | Layout limits: how far each decoupling capacitor may be from its chip, how long the GSR wires may be, how many ground vias the GPS needs. |
| `pcbtools/` (the rest) | The machinery: building the board, the checks, measuring, pictures. |
| `biomap_*/` | The KiCad files the tools write. |
| `out/` | Pictures and full check reports. Git ignores it. |

### Changing a layout

1. Look at the parts you want to move: `./pcb parts flipper U1 C1` prints their pad positions, nets and keep-out boxes.
2. Edit their positions or traces in `pcbtools/boards/flipper.py`.
3. Run `./pcb layout flipper`. It rebuilds the board, runs KiCad's design rules check (DRC), tests the layout limits and prints the layout numbers.
4. If DRC finds problems, `./pcb drc flipper` lists each one with the parts and positions involved.
5. `./pcb measure --compare` shows the numbers for the last commit next to yours, so you can see whether the change helped.
6. `./pcb render` draws pictures into `out/` to check by eye.

Units are mm and y points down, as in KiCad. For a part on the back face, `./pcb footprint RF_GPS ublox_SAM-M8Q B 13 17` shows where its pads land at each rotation (back-face parts come out mirrored).

### Commands

| Command | What it does | Changes files? |
|---|---|---|
| `build [board]` | Rebuilds everything: draws the schematics, checks them, lays out the boards, checks the boards. | Yes, all KiCad files |
| `layout [board]` | The quick loop: lays the board out again from the saved schematic, runs DRC, prints the layout numbers. | Yes, the `.kicad_pcb` |
| `check [board]` | Checks the saved files: schematic against the intended connections (two independent ways), KiCad's wiring check (ERC), DRC and the layout limits. | No |
| `drc [board]` | Every DRC problem, with parts and positions. | No |
| `measure [--compare [git-ref]]` | Each decoupling capacitor's distance to its chip's supply *and* ground pin; copper length on the GSR wires and the long wires. | No |
| `parts <board> [REF ...]` | Pad positions, nets and keep-out boxes, as the layout places them. | No |
| `render [board] [--out folder]` | Pictures of the schematic and both faces of each board. | Only `out/` |
| `footprint <library> <name> [F\|B] [pad ...]` | Where a footprint's pads land at each rotation. Also reads our own footprints (`BioMap`). | No |
| `eagle <file> [--nets REF ...\|--package NAME]` | Reads Eagle files, such as SparkFun's open designs, without Eagle. This is how the MS421R cell and its pads were found. | No |
| `debug-sch <file>` | When KiCad only says "Failed to load schematic", lists which items it rejects. | No |
| `autoroute export\|finish <pcb> <file>` | The earlier Freerouting step, not used now. Kept in case autorouting is wanted again. Needs Java and `freerouting.jar`. | `finish` does |

`build`, `layout`, `check` and `drc` end with "N problem(s) found" and a failure exit code when anything is wrong, so they can be used as a test.

### What `build` does

1. Draws the schematics, symbol libraries and BOMs from `schematic.py`.
2. Reads the drawing itself (without KiCad) and checks every pin against the intended connections.
3. Does the same check again on KiCad's own netlist of the drawing. The two checks work differently, so a fault one misses the other should catch.
4. ERC (KiCad's wiring check).
5. Places every part, draws every trace and adds the ground fills, from `boards/<board>.py`. If any schematic check failed, this step is skipped.
6. DRC (KiCad's design rules check), including whether the board still matches the schematic.
7. The layout limits (below).

### Extra DRC rules

`build` writes a `.kicad_dru` file next to each board. KiCad's DRC reads it, both in `./pcb check` and in the PCB editor while you work. It adds:

- **JLCPCB's limits** that are stricter than KiCad's own: drilled holes at least 0.45 mm apart (vias 0.2 mm), at least 0.18 mm of copper round each plated pad hole, and printed text at least 1.0 mm tall with 0.15 mm lines (the sizes are set in `rules.py` as `TEXT` and `TEXT_LINE`). All three boards get these.
- **No ground track or via inside the 0.5 V guard.**
- **The skin-current wires** (amplifier input and cuff 2) kept 0.3 mm from all copper except the 0.5 V reference.

The last two apply to the Flipper and Cardputer boards only. They find those wires by the names KiCad gives them (`Net-(U1A--)`, `Net-(J2-Pin_2)`). If the schematic changes those names, change them in `rules.py` too, or the rule quietly tests nothing. Edit the rules in `rules.py`, not the `.kicad_dru` files, which `build` overwrites.

### Layout limits

DRC only checks that copper doesn't touch where it shouldn't. It doesn't notice a layout getting worse for noise: a capacitor moved 2 mm further from its chip still passes. `pcbtools/limits.py` catches that. Each rule has:

- a **limit**. Going past it fails the check.
- optionally a **target**. Falling short of it only prints a reminder.

Some limits come from a source: u-blox asks for ground vias filling the plane under the GPS, and SparkFun's 40 mm board has about 100. The rest are set just past today's values, so any change that makes things worse is caught. When a layout improves, tighten the limit to match, so the improvement can't be lost later.

One rule is about copper area rather than distance: the 0.5 V guard must stay one solid piece of about 80 mm² (Flipper) or 60 mm² (Cardputer, whose cuff socket is further from the op-amp). If a layout change splits it up, KiCad drops the pieces that aren't joined to the reference, and the area falls below the limit.

Rebuilding an unchanged design gives identical files, so `git diff` shows only what really changed.

**Rebuilding overwrites the boards and schematics**, so don't run `build` or `layout` after editing the boards by hand in KiCad: those edits would be lost. Your KiCad project settings (`.kicad_pro`) are kept; only the design rules in them are updated.
