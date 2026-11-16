# BioMapping circuit boards (KiCad)

Two KiCad 10 projects. Both carry the same GSR circuit as [docs/wiring_guide.md](../docs/wiring_guide.md):

| Folder | Plugs into | Board | Power |
|---|---|---|---|
| `biomap_flipper/` | Flipper Zero GPIO | 80 × 52 mm, stands up from the Flipper's top edge | Flipper's 3.3 V (pin 9) |
| `biomap_cardputer/` | Cardputer ADV EXT socket | 84 × 54 mm (the device's back) plus a 9 mm tab; two M2 × 4 mm screws | Own 3.3 V regulator, fed from EXT 5 V out |

Both boards are placed and routed. KiCad's checks pass on both: the wiring check (ERC) and design rules check (DRC) show 0 errors, nothing is unconnected, and each board matches its schematic.

## Parts

- **ADS1115 as a bare chip** (MSOP-10) instead of a breakout board. The breakout used to supply the I2C pull-up resistors, so the Flipper board has its own (R6, R7). On the Cardputer these are marked "do not fit", because its bus already has pull-ups.
- **Precision resistors suggested** for R1, R2 and R5 (0.1%), and a **C0G capacitor** for C2. These set the GSR scale directly.
- **Finger cuffs:** JST PH 2-pin side-entry socket (J2) for the Grove GSR cuff plug.
- **GPS:** four solder pads (J3) for a short flexible lead to the SparkFun SAM-M10Q breakout: 1 = 3.3 V, 2 = GND, 3 = breakout TX, 4 = breakout RX. The breakout sticks onto the outlined area with a double-sided pad.
- **Flipper header:** two angled pieces, pins 1–8 and 9–18, 17.78 mm apart, to match the gap in the Flipper's GPIO.
- **Cardputer header:** one angled 2 × 7 header on the tab, pointing into the EXT socket.

## Check before ordering (Cardputer)

These come from M5Stack's dimension drawing and 3D models, not from a real device.

- **Header height.** The angled header holds its pins about 1.3 mm and 3.8 mm above the board. The socket rows look to be about 4.5 mm and 7 mm above the Cardputer's back, so the header needs lifting by about 3 mm (for example with a plastic spacer).
- **Which row is which.** The board assumes the even-numbered row (GND, 5 V out, SDA, SCL, G13, G15) is the one nearest the back. Check with a multimeter before plugging in. Pin 2 is 5 V *in* and must stay unconnected.
- **Inner face.** The through-hole joints of J2 and J3 poke through the face that touches the Cardputer. Trim them flush or cover them with tape.
- **Screws.** Use M2 × 4 mm only. M5Stack warns that longer screws can damage the board inside.

## Regenerating

`tools/` holds the scripts that made these files: schematic generator, placement, Freerouting routing, and checks (`run_all.sh`). They need KiCad 10, Java and `freerouting.jar` in `tools/`. **Running them overwrites the boards**, so don't run them once you have edited the boards by hand in KiCad.
