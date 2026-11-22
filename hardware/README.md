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

- **GSR half.** The parts follow the signal: cuffs, then R3/R4, then the op-amp, then the ADC. The cuff socket sits at the board edge with its opening 0.75 mm inside it, so nothing sticks out past the edge and the plug can be pushed in and pulled out straight, with fingers free to grip it. The amplifier's input wire, which carries the tiny skin current and is the most sensitive to noise, is under 10 mm long (about 7 mm on the Cardputer). Each 100 nF supply capacitor sits close to the power pin of its chip: C1 and C3 about 2 mm (each right beside the pin), C7 about 3.7 mm on the Flipper and 2.5 mm on the Cardputer (bridging the GPS supply pad and the ground pad next to it). The ground ends of C1 and C3 reach ground through a via right beside the capacitor, and the chips' ground pins have their own via within 1.6 mm, so each loop is about 2.3–2.7 mm in all (see `./pcb measure`).
- **0.5 V guard.** A patch of copper held at 0.5 V surrounds the amplifier's input wire, R4, C2, R5 and the cuff-2 wire. That wiring also sits at about 0.5 V, so no current can leak between it and the guard. Without the guard, ground copper 0.3 mm away could leak a little current through flux left on the board, and that current would be added to the skin reading. The flux can't simply be washed off, because the GPS module mustn't be washed. The guard joins the reference at U1 pin 3, right beside the input pin 2. Ground copper is kept out of the guard's area: even U1's own ground pin takes its via just outside it.
- **Test pads.** TP3 (GSR output), TP5 (ground) beside it, and TP4 (0.5 V reference), for a meter or scope when checking a new board. A meter between TP3 and TP4 reads exactly what the ADC reads, so it checks the amplifier without trusting the ADC or the firmware. Expect about 0.50 V from TP4 to TP5. From TP3 to TP4, expect about 0 V with the cuffs unplugged, 0.417 V with 47k in the cuff socket, 0.215 V with 100k and 0.049 V with 470k. A scope on TP3 shows hum before the ADC and the firmware's averaging smooth it. A scope on mains power joins the board to earth, which can change the hum itself; a battery scope doesn't.
- **The test pads can't calibrate the board.** The reading compares the GSR output with the 0.5 V, and the same ADC measures both, so any error in the ADC's own scale cancels out. What sets the accuracy is R5, R3 + R4 and the zero, and the pads come after R3 and R4. The calibration wizard, with resistors in the cuff socket, tests the whole path. If a wizard result looks odd, TP3 shows whether the amplifier or the ADC is off.
- **GPS half.** The module sits in the middle of an unbroken ground area of about 50 × 52 mm (Flipper) or 52 × 54 mm (Cardputer). Small parts sit right beside the pins they serve. C7 bridges the module's supply pin and the ground pin next to it. On the Cardputer the module is turned so its serial pins face the flex tail, its supply pin (VCC) faces the regulator, and its second supply pin (V_IO) and backup pin face the empty space below it. There C6 (10 µF) bridges V_IO and the ground pin next to it, and C8 does the same for the backup pin. The backup cell sits just below the module, beside its charger (D1, R8). Each serial resistor sits at the end that drives its wire: R10 at the GPS (TX), R9 at the flex tail (RX).

On the Flipper, long runs (I2C and the 3.3 V feed) go along the board edge on the other copper layer, outside the GPS area. The Cardputer needs none: every track is on the outer face (see "How the Cardputer board is laid out" below). Ground fills both copper layers, joined by a grid of vias: 3 mm apart around the GPS, 5 mm elsewhere, and 2 mm apart under the Cardputer's GPS module. KiCad has a "GPS keep clear" zone that refuses new traces under and around the module, so hand edits can't break this by accident.

## The GPS ground plane

The SAM-M10Q's antenna uses the board's ground as part of the antenna. u-blox's integration manual (in `docs/datasheets/`) asks for:

- a solid ground plane of 50 × 50 mm, with the module in the middle; performance drops a lot below 40 × 40 mm
- no signal traces under the module, and ground vias filling the plane under it
- nothing taller than 3 mm within 10 mm of the module
- a plastic case at least 5 mm from the antenna

SparkFun's breakout is 40.6 × 40.6 mm, the minimum, with ground on both layers and about 100 vias. These boards give the module a larger ground area. The module's own circuit copies SparkFun's:

- 100 nF on the supply (plus a 10 µF reservoir, which SparkFun doesn't have)
- a rechargeable backup cell (BT1, Seiko MS421R, the same cell SparkFun uses), charged through D1 and a 3.3 kΩ resistor (Seiko asks for at least 3 kΩ when charging from 3.3 V), with a capacitor (C8) on the backup pin
- 470 Ω in series with TX and RX

C8 is 100 nF on the Flipper, as on SparkFun's board, and 1 µF on the Cardputer. When the power goes off, the module switches its backup pin over to the cell and draws a short burst of current. u-blox warns that a high resistance on that pin makes the voltage dip. The cell's own resistance is about 600 Ω, so the bigger capacitor gives that burst more to draw on.

On the Cardputer, the solder mask round the module's pads opens 0.05 mm wider than each pad, as in u-blox's footprint drawing. A slightly misplaced mask then can't cover a pad edge, which under the module can't be seen or reached. The Flipper board still has the mask flush with its pads.

Two test pads, SAFEBOOT/PPS and RESET, take the place of SparkFun's header pins. Each has a ground pad 1.2 mm from it (TP6, TP7), so tweezers can bridge the pair and a scope's ground has somewhere to go. Each pad's name is printed beside it. The firmware needs no change: it uses the same serial pins as before.

- **TP1, SAFEBOOT/PPS.** Inside the module, the SAFEBOOT pin is joined to the time pulse output through 1 kΩ (u-blox integration manual, section 3.2.3). The firmware leaves the time pulse at u-blox's default, so once the GPS knows the time, this pad goes high for 0.1 s at the start of every second ("PPS", pulse per second). Before that, and while the GPS sleeps, it stays low. On a scope you see the pulse; on a meter the number jumps once a second. So it shows the GPS has the time without looking at either screen, and it marks the true start of each second for timing tests. Held to ground (TP6) while the GPS powers up, it starts the GPS in safeboot mode. That is almost never needed, because this GPS's own program is fixed in the chip. It also means nothing may pull this pad low at power-up, an LED to ground for example: the GPS would start in safeboot mode and seem dead. A meter or a scope is fine.
- **TP2, RESET.** Bridged to TP7, it resets the GPS. That clears the GPS's stored data, so the next fix is a cold start. It is rarely needed: Options > Cold Reset GPS wipes the same stored data over the serial line, and the firmware never saves settings into the GPS, so turning the power off and on clears any bad setting. It is for a GPS that stops answering even then.
- On the Cardputer these pads face outwards. A metal object lying across a pair would reset the GPS, or start it in safeboot mode at power-up: one more reason to keep metal off this side.

## Parts

- **ADS1115 as a bare chip** (MSOP-10). Both boards have their own I2C pull-up resistors (R6, R7, 4.7 kΩ to the board's 3.3 V). On the Cardputer the ADC has an I2C bus of its own (G5 and G6), and the Cardputer has no pull-ups on those pins.
- **Precision resistors suggested** for R1, R2 and R5 (0.1%), and a **C0G capacitor** for C2. These set the GSR scale directly. R3 and R4, the two 4.7k skin current limiters, are 0.1% too: the firmware subtracts exactly 9.4k for them, and with 1% parts that sum could be up to 94 Ω out, enough to read very sweaty skin (around 10k) up to about 1% low.
- **Op-amp: TI OPA2333AIDR** (U1), a "zero-drift" op-amp. Its input error is under 10 µV, against up to 4.5 mV for the MCP6002 on the hand-built prototype, so the 0.5 V across the skin stays exact and doesn't drift with temperature. It has the same pins as the MCP6002. Buy TI's own part: LCSC also lists cheaper copies from other makers with different specs.
- **C9 (10 µF) across R2** smooths the 0.5 V bias. The bias is taken from 3.3 V, and the GSR reading scales with it, so without C9 any wobble on 3.3 V would show up in the reading.

Each board's `bom.csv` lists every part with its maker, maker's part number and LCSC number (LCSC is the parts store JLCPCB assembles from). Identical parts share one row. The everyday resistors and capacitors are JLCPCB "basic" parts, which have no extra fitting fee.

Everything is surface-mount and suits machine assembly, except the angled pin headers.

- **Finger cuffs:** JST PH 2-pin side-entry socket, surface-mount (J2, S2B-PH-SM4-TB). Its two side tabs only hold it down.
- **GPS:** u-blox SAM-M10Q-00B (U4), on KiCad's standard SAM-M8Q footprint; u-blox says the two modules are pin-compatible. **LCSC has none in stock**, so buy them from Mouser or Digi-Key and send them to the assembler.
- **Backup cell:** Seiko MS421R-IV03E (rechargeable, 3 V, 1.5 mAh, 4.8 mm). It can go through the soldering oven, so a machine fits it like any other part. It is the cell on SparkFun's SAM-M10Q board, and its footprint (`BioMap.pretty/Seiko_MS421R_IV03E`) copies SparkFun's pads. Seiko rates the cell for 3 µA in normal use and 10 µA at most, but with the GPS switched off the module draws 28 µA from it. That doesn't harm the cell, but it gets less of its stored charge out, so expect it to keep satellite data for about a day at most. After a longer time off, the GPS takes longer to find its first position. Not stocked by LCSC; Farnell 3534555.
- **C2** is 1206 size, because 100 nF C0G capacitors are hard to find in 0805.
- **Flipper header:** two angled through-hole pieces, pins 1–8 and 9–18, 17.78 mm apart, to match the gap in the Flipper's GPIO. Through-hole is kept on purpose: these joints hold the board in place.
- **Cardputer connection:** a flex tail (see below).

## How the Cardputer board is laid out

Seen from the outside, the GSR circuit is on the left half and the GPS on the right. (In KiCad, which shows the board from the Cardputer's side, it is the other way round.) The flex tail lands in the middle of the bottom edge and delivers the wires in this order: the two GPS serial wires at the GPS end, ground, SDA, SCL, 5 V, ground, and the ADC's ready line at the GSR end. The regulator sits straight below the 5 V pad. The two I2C wires have to get past the 5 V wire to reach the GSR side. They do it by running between the two pads of the ferrite bead FB1, which sits in the 5 V wire, so they need no copper on the inner face. The regulator's 3.3 V goes out in two branches, one straight across at 45 degrees to the GPS and one under the I2C wires to the GSR circuit. The two GPS serial wires also run as a parallel 45-degree pair from the tail to the top of the module, with ground vias between them. The I2C pull-ups R6 and R7 stand between the I2C wires and that second branch, beside the regulator. SDA runs under R7's body, between its two pads, so R7 can reach SCL on the far side of SDA. So no wire crosses another, and the inner face is solid ground with no tracks at all.

The GSR circuit is laid out as on the previous version, turned round as one block, so the cuff socket is on the far short edge from the GPS. The ADC sits just above the op-amp. The op-amp's output and the 0.5 V reference run straight up to it, side by side, with test pads TP4 (0.5 V) and TP3 (GSR output) on them and TP5 (ground) beside them. The test pads have no printed names, because there is no room: from the GPS side they are 0.5 V, GSR output, ground.

**The ADC's ready line.** The ADS1115's ALERT/RDY pin goes to EXT pin 3 (G4). The ADC can pulse it each time a new reading is ready, so the firmware can read exactly 860 readings a second, with none missed and none read twice (see `docs/cardputer_port.md`, "GSR reading speed"). The pin can only pull the line low, so it needs a pull-up resistor. The board has none: the firmware turns on the ESP32's own pull-up on G4. The firmware also has to switch the ADC's ready mode on (set the top bit of the high threshold register and clear it in the low one). Test pad TP8 (printed RDY) sits on the ready line just above the ADC, for a scope or logic analyser while that is being set up, with TP5 as its ground. Without it, the only places to touch the line would be the ADC's 0.5 mm pins and the tail joint, which is taped over.

## How the Cardputer connects

The Cardputer board screws flat onto the back and has no header or socket. A **flex tail** (`biomap_cardputer_tail/`) joins it to the EXT socket. This is a flexible circuit: a strip of thin polyimide plastic with the copper wires inside, made to our own shape.

- **Plug end** (20 × 8 mm): a 1 mm FR4 stiffener is glued on the side facing the Cardputer, and a straight 2 × 7 header is soldered through it from the outer side (the pads under the stiffener are covered). It stands against the Cardputer's bottom edge with the header in the EXT socket, about 5.5 mm out from the edge with the pin ends; trim the pin ends after soldering to bring that down to about 3.6 mm. A cover has to leave room for it.
- **Bendy strip** (9 mm long, 13 mm wide, widening to 20 mm just before the stiffener): folds round the bottom edge. It has copper on one side only, and no copper fill, so it bends easily. The widening ends 1 mm before the stiffener, so the fold at the stiffener's edge crosses straight flex, with no corner to start a tear. The header's body and the stiffener hold the flex about 3.6 mm out from the Cardputer's edge; the fold round to the board uses about 6.3 mm of the strip, leaving 2–3 mm of slack.
- **Solder end** (13 × 6.2 mm): 8 plated pads, 1.5 mm apart, each with a 0.7 mm hole. It lies flat on the Cardputer board's landing pads (J1) between the printed lines, and is soldered there for good. The tail ends 0.5 mm past its pads, and each landing pad runs on 1.0 mm past the tail's tip, so the iron can heat both pads at once and you can see the solder fillet form at the end of every pad. The landing pads are 0.9 mm wide, leaving 0.6 mm between neighbours, so a solder bridge is less likely. That matters most between pad 3 (5 V) and pad 4 (SCL): a bridge there would put 5 V on the Cardputer's G6 pin.

Why a soldered tail: a header fixed to the main board would have to line up with the socket in three directions at once, and sockets for a separate cable stand about 2.5 mm tall. The tail takes up any mismatch, and nothing on the Cardputer board stands taller than the flex, about 0.2 mm. The only thing you unplug is the header from EXT; the board and its tail come off together.

- **Wire order:** tail pad *k* lies on board pad *k*, the same signal. From pad 1: ADC ready (G4), GND, 5 V, SCL, SDA, GND, G13, G15. The ADC has an I2C bus of its own on G6 (SCL, header pin 5) and G5 (SDA, pin 13). Both pins are in the header's far row, so the tail brings them out between the near row's pins on the inner face, under the stiffener: SCL between pins 6 and 8, SDA along the gap between the two rows and out between pins 8 and 10. No via is needed. Pins 8 and 10 (G8 and G9, the Cardputer's own I2C bus, which the keyboard uses) are left unconnected. The second ground (pad 6) gives the GPS serial wires a ground right beside them, and means one bad joint can't cut the board's ground. It drops through a via and runs along the outer face, above the near row, to the header's GND pin. 5 V and both grounds are 0.5 mm wide, the signals 0.25 mm. Every wire crosses the stiffener's edge in a straight line, and no via and no bend in a wire lies within 1 mm of that edge. That edge is where the flex bends hardest, and the factory may glue the stiffener a few tenths of a mm off. No track runs between the header's two rows on the outer face, where the pins are soldered by hand, so a slightly misplaced cover film can't leave a bare track beside a pin. The ready line also comes from the far row (pin 3) and passes between pins 2 and 4 on the inner face, under the stiffener.
- **Ordering the tail:** order it as a 2-layer flex board (JLCPCB, PCBWay), with coverlay on both sides and a 1.0 mm FR4 stiffener on the F side over the plug end. The stiffener outline and notes are on the drawings layer (`Dwgs.User`). Choose ENIG (gold) pads: they solder well and don't tarnish. A first batch of 5 seems to be roughly $15–25, but check the instant quote.
- **Soldering it on:**
  1. Solder the header into the plug end first.
  2. Tin the landing pads on the Cardputer board lightly (if the assembler applied paste there, they already are).
  3. Lay the tail's solder end over them, F side down ("THIS SIDE DOWN" is printed there), between the printed lines, with the landing pads' ends showing past the tail's tip. Hold it with heat-resistant tape.
  4. Put the iron where the tail's tip meets the landing pad, so it heats both, and feed a little solder: it runs through the hole onto the pad below and forms a fillet at the pad's end. A smooth fillet there shows the joint has taken. The two ground pads (2 and 6) join the ground copper through two thin spokes each, not solid copper, so they heat up nearly as fast as the others.
  5. Before plugging into the Cardputer, check with a multimeter (beep or ohms setting) between each pair of neighbouring pads. None should beep, especially 5 V (pad 3) and SCL (pad 4).
  6. Put a strip of Kapton tape over the joint, so bending the tail never pulls on the solder.

## Check before ordering (both boards)

- **Soldering the GPS module.** Its pads sit underneath it, so it needs an oven or a hotplate. u-blox advises against a hot air gun, which can overheat and damage the module. Follow u-blox's soldering profile and use no-clean flux. Don't wash the board afterwards with water, alcohol or an ultrasonic cleaner; the manual warns that each one can damage the module.
- **Oven limits to give the factory.** You send the GPS modules and backup cells to the factory yourself, so send these limits with them. Every part sits on one face, so one pass through the oven is all the board needs.
  - GPS: one pass only, module facing up, at most 245 °C, with 40–60 s above 217 °C (u-blox integration manual, section 5.3).
  - GPS: keep it in its sealed bag until it is fitted. It soaks up damp from the air (moisture level 4). After about 72 hours out of the bag it has to be baked dry first, or it can crack inside in the oven.
  - Backup cell: two oven passes at most, with the temperature measured on top of the cell (Seiko's catalogue).
- **Backup cell footprint.** It is copied from SparkFun's production design, not from Seiko's drawing. Before ordering, compare it with the IV03E terminal drawing on Seiko's MS421R page: the small corner tab is + (pad 1), the long tab is −.
- **Which way the antenna faces.** The antenna works best facing the sky. On the Flipper, the board stands up from the top edge, so the antenna faces sideways while the Flipper lies flat and faces up when the Flipper is held upright. On the Cardputer, it faces out from the back.

## Check before ordering (Cardputer)

These come from M5Stack's dimension drawing and 3D models, not from a real device. `./pcb print` makes a full-size paper copy to check them with (see "Paper fit test" below).

- **Which way the EXT socket faces.** The tail assumes the socket opens out of the bottom edge, with its rows about 4.5 mm and 7 mm in from the back, as M5Stack's 3D model suggests. M5Stack's written docs only say it is "on the underside". Small errors in these numbers don't matter much, because the flex takes them up. But if the socket actually opens into the back face, the tail's shape has to change and the main board needs a cut-out over it.
- **Which row is which.** The tail assumes the even-numbered row (GND, 5 V out, G13, G15) is the one nearest the back, and the odd row (G4, G6 and G5: pins 3, 5 and 13) is behind it. Check with a multimeter before plugging in. Pin 2 is 5 V *in* and must stay unconnected. If it turns out wrong, only the tail needs remaking.
- **Room along the bottom edge.** Check that nothing else on that edge (a port or button) is in the way of the tail's plug end. It is 20 mm wide, centred on the EXT socket.
- **The tail's length.** It is drawn with 2–3 mm of slack round the edge, if the socket's face is flush with the edge (more if it is set in). Check the fold on a real Cardputer before ordering many; a longer strip is a one-line change in `cardputer_tail.py`.
- **Screws.** Use M2 × 4 mm only. M5Stack warns that longer screws can damage the board inside.

## Paper fit test (Cardputer)

`./pcb print` writes `out/biomap_cardputer_print.pdf`: the board and its tail at full size on one A4 page, seen from outside (the face you see on the back of the Cardputer).

- Print it at 100% ("Actual size"), not "Fit to page", then measure the two 100 mm rulers on the page. Printers are often slightly off, so check before trusting the fit.
- The board is drawn with the tail laid out flat where it really lies. Cut both out as one piece and fold the tail round the bottom edge to the EXT socket. The tail is also drawn on its own.
- The + marks are the centres of the two M2 screw holes.
- Paper is thinner than the 1.6 mm board. For a truer fold, glue the print onto card about that thick.
- KiCad draws the page from the board files, so it always matches the current layout. Tracks and copper fill are left out to save ink.

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
| `pcbtools/limits.py` | Layout limits: how far each decoupling capacitor may be from its chip, how long the GSR wires may be, how many ground vias the GPS needs, how much track may cut the ground plane. |
| `pcbtools/` (the rest) | The machinery: building the board, the checks, measuring, the ground check, pictures. |
| `biomap_*/` | The KiCad files the tools write. |
| `out/` | Pictures and full check reports. Git ignores it. |

### Changing a layout

1. Look at the parts you want to move: `./pcb parts flipper U1 C1` prints their pad positions, nets and keep-out boxes.
2. Edit their positions or traces in `pcbtools/boards/flipper.py`.
3. Run `./pcb layout flipper`. It rebuilds the board, runs KiCad's design rules check (DRC), tests the layout limits and prints the layout numbers.
4. If DRC finds problems, `./pcb drc flipper` lists each one with the parts and positions involved.
5. `./pcb measure --compare` shows the numbers for the last commit next to yours, so you can see whether the change helped.
6. `./pcb render` draws pictures into `out/` to check by eye.

Units are mm and y points down, as in KiCad. Write tracks with square corners: on the Cardputer board and tail, `BEVEL` at the top of the layout file cuts every square corner at 45 degrees when the board is built (never at a pad or where another track joins). A track can set its own size, or `{"bevel": 0}` to stay square where a cut corner would come too close to a pad. For a part on the back face, `./pcb footprint RF_GPS ublox_SAM-M8Q B 13 17` shows where its pads land at each rotation (back-face parts come out mirrored).

### Commands

| Command | What it does | Changes files? |
|---|---|---|
| `build [board]` | Rebuilds everything: draws the schematics, checks them, lays out the boards, checks the boards. | Yes, all KiCad files |
| `layout [board]` | The quick loop: lays the board out again from the saved schematic, runs DRC, prints the layout numbers. | Yes, the `.kicad_pcb` |
| `check [board]` | Checks the saved files: schematic against the intended connections (two independent ways), KiCad's wiring check (ERC), DRC and the layout limits. | No |
| `drc [board]` | Every DRC problem, with parts and positions. | No |
| `measure [--compare [git-ref]]` | Each decoupling capacitor's distance to its chip's supply *and* ground pin; copper length on the GSR wires and the long wires. | No |
| `ground [--picture] [--break-test]` | The Cardputer board's ground: how far apart the GSR's ground points move when the GPS or the ADC sends current through the ground copper, plus the ground's pieces and the biggest gap between ground vias (see "Ground check" below). Takes a few minutes. | Only `out/` (`--picture`) |
| `parts <board> [REF ...]` | Pad positions, nets and keep-out boxes, as the layout places them. | No |
| `render [board] [--out folder]` | Pictures of the schematic and both faces of each board. | Only `out/` |
| `print [--out file]` | A full-size PDF of the Cardputer board and its tail, to print and hold against a real Cardputer (see "Paper fit test"). | Only `out/` |
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

One rule is about copper area rather than distance: the 0.5 V guard must stay one solid piece of about 80 mm² (Flipper) or 86 mm² (Cardputer). If a layout change splits it up, KiCad drops the pieces that aren't joined to the reference, and the area falls below the limit.

Another counts the track length on the ground-plane face (the face with no parts). Every track there cuts the ground that the wires on the other face send their return current through. On the Cardputer there are none, and the limit is 0: the flex tail delivers the wires in the board's order, the I2C wires pass between FB1's pads, and SDA passes between R7's pads, so every track stays on the outer face.

### Ground check

`./pcb ground` checks the Cardputer board's ground copper by working out the current through it, not just its shape. The GSR reading rests on the 0.5 V across the skin, and that 0.5 V lies between two ground points: the cuff's ground (R3) and the ground under the bias divider (R2, C9). Current crossing the ground between them adds a little to the 0.5 V and so changes the reading.

The tool cuts both copper faces into 0.1 mm squares, joins them through the vias, and leads the tail's two ground wires (their resistance taken from the tail board) through the header pin to the Cardputer's ground. Then it sends the GPS's 10 mA (its datasheet's tracking current) in at the GPS's ground pads, and separately the 0.7 mA the ADC sinks when it holds SDA low, and works out the voltage everywhere. It prints how far apart the two ground points move, what that does to a reading on a 47k resistor and on skin, and how it compares with the ADC's own noise (about 7 µV per reading). On today's board the GPS moves them 0.5 µV apart: about 0.03 nS on 47k, and 13 times smaller than the ADC's noise. The GSR circuit sits beside the path the GPS current takes to the tail, not on it.

It also prints how many separate pieces of ground each face has, with how many vias each, any wire on the outer face with no ground under it on the inner face, and the point on the board farthest from a ground via.

So that the numbers can be trusted:

- Every run first solves a plain copper strip, whose resistance can be added up by hand, and shows both numbers. They must match.
- `--break-test` runs the GPS case again on three deliberately worse boards: the Cardputer's ground joined at the cuff end, both faces cut so the GPS current has to go round past the GSR circuit, and no inner face. The first two raise the error 3 to 4 times. Without the inner face, the bias divider's ground is cut off completely, because its patch of outer-face ground reaches the rest only through the inner face.
- `--picture` draws the voltage of both faces into `out/biomap_cardputer_ground.png`, 1 µV per colour step.

The copper thickness isn't set anywhere, so the tool assumes the usual factory defaults: 35 µm on the board and 18 µm on the flex tail. It also assumes 15 mΩ for the header pin. Change them at the top of `pcbtools/ground.py` if the boards are ordered differently. The results scale with them. The tool needs numpy in KiCad's Python; if it is missing, the command prints the line that installs it.

Rebuilding an unchanged design gives identical files, so `git diff` shows only what really changed.

**Rebuilding overwrites the boards and schematics**, so don't run `build` or `layout` after editing the boards by hand in KiCad: those edits would be lost. Your KiCad project settings (`.kicad_pro`) are kept; only the design rules in them are updated.
