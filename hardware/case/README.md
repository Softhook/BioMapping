# Cardputer ADV: printed back case

A new back for the Cardputer ADV, printed in one piece. It replaces M5Stack's own back and holds two things: the Cardputer's battery, as before, and our GSR + GPS board underneath it. The board is wired to the Cardputer inside the case, so there is no flex tail and nothing sticks out.

**Status (23 November 2026):** planning. Nothing is drawn or ordered yet. The wiring is chosen (see "The electrical connection"), but Test 1 still has to confirm it on the prototype. The circuit board changes wait until the tests and measurements below are done.

## Why replace the back instead of adding a cover

We also looked at keeping M5Stack's back and screwing a cover over it, with our board in between. Replacing the back is better:

- **Nothing sticks out.** The flex tail's plug would stand 4–5 mm out from the screen edge. Wires inside the case take its place.
- **The shape matches.** The Cardputer is 84 × 54 mm only at the seam halfway up. Its back narrows a little and its edges are rounded, so a flat 84 × 54 mm board laid on the back would show its corners. A new back can follow the device's own shape.
- **The screws hold properly.** The new back uses the two screws that hold M5Stack's back on, which go straight into the Cardputer. The other screw points (meant for M5Stack's add-ons) sit at the bottom of slots almost 4 mm deep, which a flat board can't reach without spacers.
- **It is a little thinner**, by about 1.5 mm.

What we give up: the Lego holes and the magnets (both are part of M5Stack's back), and the EXT socket on the outside (the new back covers it; our wires are soldered to its pins inside).

## What M5Stack's model tells us

M5Stack publishes a 3D model of the Cardputer ADV, with its back as a separate part, under the MIT licence (free to use, with credit to M5Stack): `Products/K132-Adv_Cardputer-Adv/Structures/Cardputer-Adv.stl` in [M5Stack's M5_Hardware repository](https://github.com/m5stack/M5_Hardware). The new back is drawn from it. Measured from that model, with positions given from the **screen edge** (the long edge with the EXT socket) and from the centre line:

- The device is 19.6 mm thick. M5Stack's back is 9 mm of that. The rest (screen, keyboard and electronics) is 10.6 mm.
- The back's floor is about 1.5 mm thick. Its inner face is 7.5 mm below the rim where the back meets the Cardputer. The battery (6 mm thick) sits in that space.
- The device is 84 × 54 mm only at the seam. The back narrows slightly towards the floor, and its bottom edges are rounded: about 1 mm on three sides, about 3 mm along the keyboard edge, and more at the two corners on the screen edge.
- Two screws hold the back on, 18 mm in from the screen edge: one 29 mm from the centre on the battery-plug side, one 12.5 mm from the centre on the headphone side. Each passes through 6 mm of the back before it reaches the Cardputer.
- Openings in the back: the EXT socket (middle of the screen edge), the headphone socket (end wall on the headphone side, near the screen edge), and a strap hole through the keyboard-edge corner at that same end.
- Inside, the battery starts about 22 mm in from the screen edge (estimated from the photo; to be measured). The strip between the screen edge and the battery holds the EXT socket's pins, the headphone socket, the battery plug and the two screw posts. In this document it is called **the battery-free strip**.

**About `adv3.stl`:** this is "Alternative Back Cover for M5Stack Cardputer Adv" from MakerWorld. Its main positions match M5Stack's model, but it is licensed for personal use only. This repository is public, so `adv3.stl` is listed in `.gitignore` and must never be committed. We don't need it: the new back is drawn from M5Stack's own model.

## The new back, layer by layer

From the Cardputer outwards:

1. **Rim and battery layer (7.5 mm).** Copied from M5Stack's back: the outline, the edge the Cardputer sits in, the two screw posts, the headphone opening and the strap hole. The EXT opening is closed. No Lego holes and no magnets.
2. **Our board (1.6 mm).** Its inner face sits exactly where the inner face of M5Stack's floor was. The battery keeps the same room it has now, and nothing presses on it. A thin insulating sheet (Kapton) goes between the board and the battery. All the parts on the board face outwards, as now, so the face towards the battery is flat.
3. **GPS space.** The GPS module is 6.3 mm tall (6.8 mm at most). u-blox asks for any plastic to stay at least 5 mm from its antenna. Test 2 below checks whether a smaller gap costs any signal.
4. **Floor (2 mm).** Plain plastic. No screws, labels or paint containing metal over the GPS.

The walls are 2 mm thick. Below the battery layer they carry straight down, and the bottom edge is rounded like M5Stack's. Inside, at the level of the board, there is room for a board about 79 × 49 mm with rounded corners. The exact size comes out of the drawing. Today's board is 84 × 54 mm, so it shrinks by about 2.5 mm each way.

How thick the Cardputer becomes (19.6 mm today):

- with a 5 mm gap over the GPS: about 33.5 mm
- with a 2 mm gap: about 30.5 mm
- with an opening in the floor over the GPS, the module flush with the outside: about 27 mm

## Holding the board: posts and screws

The board needs posts. Something has to set its height (so the GPS stays clear of the floor), stop it rocking, and keep it in the back when the Cardputer is lifted off. The plan:

- **The two long screw posts** run from the floor up to the Cardputer and pass through two holes in the board (about 5 mm across). Below the board each post is wider, so it forms a ledge the board rests on. Above the board they are about 4 mm across, like M5Stack's posts. They place the board sideways and carry it.
- **Four short corner posts** under the board's corners carry the rest. The board's edges have no parts on them, only copper, so the posts can rest there.
- **Two small screws** (M2, about 5 mm long) go through the board into the two corner posts on the screen edge. That is the battery-free strip, so the screw heads have room. They keep the board in when the back is off, and stop it rattling. If the case will be opened often, press brass threaded inserts (heat-set inserts) into those two posts with a soldering iron. Otherwise the screws can cut their own thread in the plastic.
- Every post stays at least 10 mm from the GPS module.

Printed clips were ruled out: they are fiddly at this size and snap off. Glue was ruled out because the board must come out for repairs.

The board needs four new holes: two for the long screw posts and two for the small screws. That goes into the circuit update.

## The long screws

- They go into the same two places as M5Stack's screws.
- **Length:** measure M5Stack's screws first. Each passes through 6 mm of the old back, so the old screw's length minus 6 mm is how far a screw may go into the Cardputer. The new screws are longer by the extra depth of the new back, probably 20–24 mm. The drawing will give the exact length.
- **The screw on the GPS side** would be about 7 mm from the GPS module in today's layout. u-blox asks for tall objects to stay 10 mm from it. The circuit update should move the GPS a few millimetres; then ordinary steel screws are fine on both sides. Until then, use a nylon screw on the GPS side.

## The electrical connection

### The plan: six wires, all in places a soldering iron can reach

Inside the Cardputer, the EXT socket's legs come down to its board in two rows (see the photos):

```
hidden row:  G3   G4   G6   G40  G14  G39  G5
easy row:    5VI  GND  5VO  G8   G9   G13  G15
```

Left and right are as in the first photo: 5VI at the left, near the headphone socket. Each hidden-row leg sits directly behind the easy-row leg below it: G3 behind 5VI, G5 behind G15.

We solder six wires. Four go on the easy row. The other two go on the two **ends** of the hidden row, which can be reached from the side:

| Wire | Pin | Where |
|---|---|---|
| Ground | GND | easy row |
| 5 V for our board | 5VO | easy row |
| GPS, Cardputer to GPS | G13 | easy row |
| GPS, GPS to Cardputer | G15 | easy row |
| ADC data (SDA) | G5 | hidden row, right-hand end |
| ADC clock (SCL) | G3 | hidden row, left-hand end |

Leave every other leg alone. **5VI must never be connected**: it is the Cardputer's charging input. G40, G14 and G39 are the SD card's wires.

The ADC keeps its own I2C bus, as now. This is the quiet set-up measured on 21 November. The only change is that the clock wire moves from G6 to G3, because G6 is in the middle of the hidden row and hard to reach. The firmware change is one number (`GSR_SCL_PIN` in [gsr_cardputer.cpp](../../firmware/cardputer/src/gsr_cardputer.cpp)). The board keeps its two pull-up resistors (R6, R7). The prototype needs none, because its ADC board has its own.

### What we checked about G3

Our notes used to say "leave G3 alone". On 23 November we checked why:

- **Inside the Cardputer, G3 goes nowhere else.** In M5Stack's circuit diagram for the ADV, G3 runs only from the processor module to EXT pin 1. No keyboard, sound, screen or power part uses it.
- **M5Stack calls that pin "RESET".** It is the reset wire for M5Stack's LoRa radio add-on. Our back replaces the place that add-on fits, so nothing else will use the pin. Other firmware written for that add-on might switch G3 on and off. That does no harm; the ADC ignores it.
- **The ESP32 chip looks at G3 when it starts.** This only counts if a special one-off setting has been burned into the chip, and normal chips don't have it. Even then, G3 only chooses how a debugging tool connects; the Cardputer starts normally either way. And our pull-up resistor holds G3 high, which picks the normal choice. Test 1 reads that setting from the chip to be sure. Reading it changes nothing.
- **M5Stack's software wiggles G3 for a moment at start-up.** To work out which M5Stack device it is running on, it briefly tries some other devices, and a few of those use pins 3, 5 and 6. Today's wiring already gets this on G5 and G6, and the prototype has worked fine, because our firmware only starts talking to the ADC afterwards. Test 1 checks that the ADC is found at every start.
- **The CardputerZero** would need a different back anyway, so this choice changes nothing there.

### Possible problems

1. **G3 sits right behind 5VI.** 5VI carries 5 V whenever USB is plugged in, because it feeds the battery charger. A blob of solder joining them would put 5 V on G3, which can only take 3.3 V, every time you charge, and could damage the Cardputer. Solder G3 with a fine tip and little solder. Then, **before plugging in USB**, check with a multimeter that G3 and 5VI are not connected (no beep).
2. **G5 sits right behind G15**, with G39 (the SD card) beside it. A blob there does no damage, but the GPS, the ADC or the SD card would stop working. Check G5 against G15 and G39 the same way.
3. **The two ADC wires start at opposite ends of the row**, about 15 mm apart, so they can't be twisted together right from the legs. Bring them together as soon as possible and twist them from there, with a ground wire. Over a few centimetres inside the case this shouldn't matter. Test 1 checks the noise.
4. **The ADC's "reading ready" wire (G4) stays unconnected.** G4 is in the middle of the hidden row. The firmware doesn't use it; it would only matter for faster GSR reading later.
5. **The documents still say G6.** When the circuit is updated, the hardware notes and `docs/cardputer_port.md` need G6 changed to G3.
6. **Two ways of numbering the pins.** M5Stack's diagram numbers the EXT pins differently from our notes. In our notes, pin 1 is G3, pin 5 is G6 and pin 13 is G5. In M5Stack's, G5 is pin 7. Go by the names (G3, G5, 5VI), not the numbers.

### Ruled out

- **ADC on G8/G9** (easy row): that is the Cardputer's own internal bus, shared with the keyboard, sound chip and motion sensor. Moving the ADC off it on 21 November cut the noise.
- **GPS over I2C:** it would need new GPS code and board changes, and G3 + G5 makes it unnecessary.

### The cable

- Use a **JST-GH** connector (1.25 mm pin spacing). It latches, so it won't shake loose while walking. Ready-made GH cables are easy to buy: cut one end off and solder those wires onto the legs.
- **8 pins:** GND, 5 V, ADC clock (G3), ADC data (G5), a second GND, GPS out (G13), GPS in (G15), and one spare. EXT has only one ground leg, so both ground wires go to it. Twist the ADC pair with one ground wire and the GPS pair with the other.
- **Keep it short**, about 4–6 cm. The socket goes on the board's inner face (bare today), in the battery-free strip close to the EXT legs. One small part on that face can be soldered by hand.
- **Unplug the battery before soldering.** Cover the joints with heat-shrink or Kapton tape, and tape or glue the cable to the Cardputer's board, so pulling the plug can't pull on the joints.
- **Before switching on, check with a multimeter:** G3 not joined to 5VI, G5 not joined to G15 or G39, no short between 5VO and GND, and each wire on the right pin.

## Tests

You do the wiring and printing. I prepare the firmware and the test plates, then go through the files you send.

### Test 1: the ADC clock on G3 (confirms the wiring)

Use the prototype as it is now: ADC board on flywires, fixed 600 kΩ resistor in place of the finger cuffs. As usual, switch the prototype's power on before the Cardputer and off after it.

1. Move the clock flywire from EXT pin 5 (G6) to EXT pin 1 (G3). Pin 1 is in the same row, two holes along from pin 5, at the opposite end from pin 13 (G5). The data wire stays on pin 13 (G5).
2. Plug the Cardputer into the laptop. I flash a test version with the clock on G3, and read the chip's start-up setting.
3. Unplug USB. Switch the Cardputer off and on 10 times. Each time it should start normally and show a GSR reading (ADC found).
4. Record 3 minutes in GSR Only mode without touching anything, everything on battery as before. I compare the noise with the 21 November recording (about 0.3 nS).
5. Plug USB back in. Check that it starts normally while charging and that I can still flash it.

### Test 2: how much gap the GPS needs (decides the thickness)

1. Print three small test plates, 2 mm thick, in the plastic the case will use, with legs that hold them 0.5, 2 and 5 mm above the GPS module. I'll draw them to fit the prototype's GPS board.
2. Go outdoors under open sky. Lay the Cardputer flat on something that isn't metal, GPS facing up, running the bench program and logging to a laptop on battery.
3. Three minutes each: no plate, then the 5 mm, 2 mm and 0.5 mm plates. Then do the whole round twice more. The satellites move, so taking turns keeps the comparison fair.

Send me the log. I compare the signal strength of the four strongest satellites, and the number of satellites used. If a smaller gap costs no real signal, the case can be thinner.

### Test 3: fit (after drawing)

Print only the top 4 mm of the new back and try it on the Cardputer. That takes about half an hour instead of several hours. Then print the whole back.

## Measurements needed

With calipers:

1. M5Stack's back screws: length and head diameter.
2. Inside the Cardputer, in the battery-free strip: how tall the EXT legs, the headphone socket and the battery plug stand above the Cardputer's board. This decides where the cable socket and the small screw heads can go.
3. The battery: its thickness, and where it sits (distance from the screen edge, and from each end).
4. Inside M5Stack's back: any ribs or pads that touch the battery.
5. A close look at the hidden row: can a soldering iron reach the G3 and G5 legs from the ends without touching 5VI or G15?
6. The prototype's GPS board: its size, and where the module sits on it (for the Test 2 plates).

## Printing

- **Plastic:** PETG, or ASA. Not PLA: it softens at about 55 °C (a sunny car, or a warm battery in a pocket).
- **On the printer:** floor on the print bed, open side up. With the post ledges shaped as cones, no supports are needed.
- **Settings:** 0.4 mm nozzle, 0.2 mm layers, at least 4 wall lines so the walls print solid, and solid posts.
- **For a final version,** a print service (for example JLC3DP, in nylon) gives a stronger and more accurate part.

## How the file will be made

A script in OpenSCAD (free, text-based). Changing a number, such as the GPS gap or the board size, remakes the file. It outputs an STL file for the slicer. Later the board's size and hole positions will come from the board layout ([hardware/pcbtools/boards/cardputer.py](../pcbtools/boards/cardputer.py)), so the case and the board can't drift apart.

Before printing, the new back, M5Stack's Cardputer model and a 3D export of our board are put together on screen and checked for anything overlapping.

## Order of work

1. Measurements 1–6.
2. Tests 1 and 2.
3. Choose the GPS gap.
4. Circuit update: smaller board, four new holes, cable socket on the inner face, ADC clock on G3, GPS moved away from the screw post.
5. Draw the case, print the fit test, then print the case.
6. Solder the cable inside the Cardputer and put it all together.

## Files here

- `IMG_20261123_145254345_HDR.jpg`, `IMG_20261123_145307462_HDR.jpg`: the Cardputer ADV with its back removed, showing the battery, the EXT legs and their labels.
- `adv3.stl`: see the licence note above. Ignored by git.
