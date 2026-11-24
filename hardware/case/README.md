# Cardputer ADV: printed back case

A new back for the Cardputer ADV, printed in one piece. It replaces M5Stack's own back and holds two things: the Cardputer's battery, as before, and our GSR + GPS board underneath it. The board is wired to the Cardputer inside the case, so there is no flex tail and nothing sticks out.

**Status (24 November 2026):** drawn, not yet printed or ordered. The circuit board (rev G) is laid out to fit inside the case, and its checks pass. The case's STL files are made from `cardputer_back.scad`, and two checks pass: in 3D, the board, every part and both plugs clear the case; and the top 6.5 mm, which meets the Cardputer, is nowhere thicker than M5Stack's own back. Still to do before printing: measurement 1 (it sets the long screws). Before ordering the board: measurement 2 and Test 1. See "What is still open".

![The case, seen from the open side: the EXT opening in the near wall, the headphone slot at the left end, the strap corner with its pin at the back left, the cuff window in the left wall, the two long screw posts with their ledges, and the two posts for the board's screws](cardputer_back.png)

## Why replace the back instead of adding a cover

We also looked at keeping M5Stack's back and screwing a cover over it, with our board in between. Replacing the back is better:

- **Nothing sticks out.** The flex tail's plug would stand 4–5 mm out from the screen edge. Wires inside the case take its place.
- **The shape matches.** The Cardputer is 84 × 54 mm only at the seam. Its back narrows a little and its edges are rounded, so a flat 84 × 54 mm board laid on the back would show its corners. A new back can follow the device's own shape.
- **The screws hold properly.** The new back uses the two screws that hold M5Stack's back on, which go straight into the Cardputer. The other screw points (meant for M5Stack's add-ons) sit at the bottom of slots almost 4 mm deep, which a flat board can't reach without spacers.
- **It is a little thinner**, by about 1.5 mm.

What we give up: the Lego holes and the magnets (both are part of M5Stack's back). The EXT socket stays open on the outside, as before: its body fills the opening in the wall. Our cable is soldered to its legs inside.

## What M5Stack's model tells us

M5Stack publishes a 3D model of the Cardputer ADV, with its back as a separate part, under the MIT licence (free to use, with credit to M5Stack): `Products/K132-Adv_Cardputer-Adv/Structures/Cardputer-Adv.stl` in [M5Stack's M5_Hardware repository](https://github.com/m5stack/M5_Hardware). The new back is drawn from it. Measured from that model, in the circuit board's coordinates: x along the Cardputer, from the GPS end (0) to the headphone end (84), and y from the **screen edge** (the long edge with the EXT socket, 0) to the keyboard edge (54):

- **Depth.** The device is 19.6 mm thick. M5Stack's back is 8 mm of that. Between the back and the top there is 1 mm of the Cardputer's own circuit board edge, which the model leaves out. The back's rim is flat.
- **Floor.** The back's floor is 1.5 mm thick, and its inner face is 6.5 mm below the rim. The battery (6 mm thick: its label says 603075, so 6.0 × 30 × 75 mm) sits in that space with 0.5 mm to spare.
- **Outline.** It is 84 × 54 mm at the rim, with corners rounded 7.7 mm on the screen edge and 3 mm on the keyboard edge. The walls lean in 0.035 mm per mm for the top 4.5 mm. The floor's edge is rounded about 1 mm, and 3 mm along the keyboard edge.
- **Walls.** They are 1.5 mm thick at the ends and on the keyboard edge, and 1.9 mm on the screen edge (1.2 mm in its bottom 1.5 mm, beside the Lego tubes). At the screen edge's corners the Lego tubes make them thicker.
- **Screws.** Two screws hold the back on, both 18 mm in from the screen edge: one at x 13, on the battery-plug side, and one at x 54.5. Each runs in a 4 mm post with a 2.2 mm hole, 6 mm long, from the floor to the rim. The head sits in a 4.1 mm hole, 2 mm deep, in the floor. So the screw reaches into the Cardputer by its length less 6 mm.
- **Openings.** The EXT socket's opening is in the screen edge, at x 32.7–51.3, from the rim down 5.1 mm. The headphone socket's slot is in the end wall, at y 7.75–13.25, from the rim down 5 mm, with a round bottom. The strap corner is the keyboard-edge corner at the headphone end. A thin wall cuts that corner off, and beyond it the corner is open from the rim down 3.5 mm, with a 1.8 mm pin to loop a strap round.
- **Inside.** A 1 mm rib near each end stops the battery sliding. There are Lego tubes and add-on screw slots along the screen edge, and nothing else.
- **The battery-free strip.** The battery starts about 22 mm in from the screen edge (from the photo). The strip between the screen edge and the battery holds the EXT socket's legs, the headphone socket, the battery plug and the two screw posts.

**About `adv3.stl`:** this is "Alternative Back Cover for M5Stack Cardputer Adv" from MakerWorld. Its main positions match M5Stack's model, but it is licensed for personal use only. This repository is public, so `adv3.stl` is listed in `.gitignore` and must never be committed. We don't need it: the new back is drawn from M5Stack's own model.

## The new back, layer by layer

From the Cardputer outwards (the numbers are the drawing's settings):

1. **Rim and battery layer (6.5 mm).** Copied from M5Stack's back: the outline, the wall faces, the two screw posts, the EXT opening, the headphone slot and the strap corner. Not copied: the Lego tubes, the add-on screw slots, the magnets and the battery ribs. Its walls are nowhere thicker than M5Stack's, so nothing inside the Cardputer can touch them (see "How it was checked").
2. **Our board (1.6 mm).** Its inner face sits exactly where the inner face of M5Stack's floor was. The battery keeps the same room it has now, and the board holds it in place, as M5Stack's floor did. A thin insulating sheet (Kapton) goes between the board and the battery. All the parts on the board face outwards, except the cable socket J1, which sits in the battery-free strip.
3. **Parts and GPS space.** This is the tallest part (the GPS module, 6.8 mm at most) plus a gap of 5 mm over it. u-blox asks for at least 5 mm between plastic and the antenna. Test 2 below checks whether a smaller gap costs any signal; the gap is one setting (`gps_gap`).
4. **Floor (2 mm).** Plain plastic. No screws, labels or paint containing metal over the GPS.

Below the battery layer the outside runs straight down, and the floor's edge is rounded as M5Stack's is. At the print bed each rounded edge turns into a 45° chamfer, so the first layers never overhang. The wall beside the board is 1.6 mm thick. Below the board it is 1 mm thicker, which forms a shelf all round that the board's edge rests on.

How thick the Cardputer becomes (19.6 mm today):

- with a 5 mm gap over the GPS: 33.5 mm (the drawing as it is)
- with a 2 mm gap: 30.5 mm
- with an opening in the floor over the GPS, the module flush with the outside: about 27 mm (not drawn)

## Holding the board

- **The two long screw posts** run from the floor up to the rim, where M5Stack's posts are. Above the board they are 4 mm across, like M5Stack's, and pass through the board's 4.5 mm holes (H3, H4). Below the board they are 7 mm across, a ledge the board rests on.
- **The shelf** round the wall carries the board's edge everywhere except at the cuff socket.
- **Two M2 screws, 5 mm long** (H1, H2), go through the board into two posts of the case. They keep the board in when the back is off, and stop it rattling. H1 is near the corner on the GPS side; H2 is below the headphone socket, where the inner face has room for a screw head. By default the screws cut their own thread in a 1.7 mm hole. If the case will be opened often, set `board_screw_inserts = true`. The holes are then 3.2 mm for M2 heat-set inserts, pressed in with a soldering iron.
- The board goes in from the rim side, over the two posts. It has a notch at the strap corner so it can pass the strap corner's wall.

## The long screws

- They go into the same two places as M5Stack's screws.
- **Length:** measure M5Stack's screws first (measurement 1). Each passes through 6 mm of the old back, so the old screw's length less 6 mm is how far a screw may go into the Cardputer. Set that as `screw_engage`, and the length you buy as `screw_len`. The drawing puts the head's seat at the right height and stops with a message if the screw is too short or too long. The default is M2 × 16 mm going in 3 mm: its head sits 8.9 mm up from the floor, at the bottom of a 4.4 mm hole.
- **The GPS side.** The screw there is 10.5 mm from the GPS module, just past u-blox's 10 mm, so an ordinary steel screw is fine. The post's plastic ledge under the board comes to 8 mm from the module. Plastic matters far less than metal, but Test 2 will show it if it does.

## The electrical connection

### The plan: six wires, all in places a soldering iron can reach

Inside the Cardputer, the EXT socket's legs come down to its board in two rows (see the photos):

```
hidden row:  G3   G4   G6   G40  G14  G39  G5
easy row:    5VI  GND  5VO  G8   G9   G13  G15
```

Left and right are as in the first photo: 5VI at the left, near the headphone socket. Each hidden-row leg sits directly behind the easy-row leg below it: G3 behind 5VI, G5 behind G15.

We solder six wires. Four go on the easy row. The other two go on the two **ends** of the hidden row, which can be reached from the side:

| Wire | Leg | Where | J1 pin |
|---|---|---|---|
| GPS, GPS to Cardputer | G15 | easy row | 1 |
| GPS, Cardputer to GPS | G13 | easy row | 2 |
| Ground | GND | easy row | 3 and 7 (both wires on the one leg) |
| 5 V for our board | 5VO | easy row | 4 |
| ADC data (SDA) | G5 | hidden row, right-hand end | 5 |
| ADC clock (SCL) | G3 | hidden row, left-hand end | 6 |
| (ADC ready, not wired) | G4 | hidden row | 8 |

Leave every other leg alone. **5VI must never be connected**: it is the Cardputer's charging input. G40, G14 and G39 are the SD card's wires.

The ADC keeps its own I2C bus, as now. This is the quiet set-up measured on 21 November. The only change is that the clock wire moves from G6 to G3, because G6 is in the middle of the hidden row and hard to reach. The firmware change is one number (`GSR_SCL_PIN` in [gsr_cardputer.cpp](../../firmware/cardputer/src/gsr_cardputer.cpp)). It still says 6, as the prototype is wired: change it in Test 1. The board has two pull-up resistors (R6, R7). The prototype needs none, because its ADC board has its own.

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
4. **The ADC's "reading ready" wire (G4) stays unconnected.** G4 is in the middle of the hidden row. The firmware doesn't use it; it would only matter for faster GSR reading later. J1's pin 8 is kept for it.
5. **Two ways of numbering the pins.** M5Stack's diagram numbers the EXT pins differently from our notes. In our notes, pin 1 is G3, pin 5 is G6 and pin 13 is G5. In M5Stack's, G5 is pin 7. Go by the names (G3, G5, 5VI), not the numbers.

### Ruled out

- **ADC on G8/G9** (easy row): that is the Cardputer's own internal bus, shared with the keyboard, sound chip and motion sensor. Moving the ADC off it on 21 November cut the noise.
- **GPS over I2C:** it would need new GPS code and board changes, and G3 + G5 makes it unnecessary.

### The cable

- **The socket** is J1, a JST GH 8-pin side-entry socket (SM08B-GHS-TB, 1.25 mm pin spacing, 4.25 mm tall), on the board's inner face. It sits in the battery-free strip on the headphone side of the EXT socket, where M5Stack's back had its Lego tubes, so nothing of the Cardputer's comes down that far. Its mouth faces into the board, so the plug lies over flat board, clear of the EXT socket's body and the headphone socket. Each pin's EXT leg is printed beside it. It is soldered by hand: the factory fits only the other face.
- **The plug** latches, so it won't shake loose while walking. Ready-made GH cables are easy to buy: cut one end off and solder those wires onto the legs.
- **Keep it short**, about 5–6 cm: from the plug, the wires turn back towards the EXT legs, about 2–3 cm away. Twist the ADC pair with one ground wire, and the GPS pair with the other.
- **Unplug the battery before soldering.** Cover the joints with heat-shrink or Kapton tape, and tape or glue the cable to the Cardputer's board, so pulling the plug can't pull on the joints.
- **Before switching on, check with a multimeter:** G3 not joined to 5VI, G5 not joined to G15 or G39, no short between 5VO and GND, and each wire on the right leg.

## Putting it together

1. Solder the cable inside the Cardputer (above) and check it with a multimeter.
2. Put the board into the case from the rim side, parts face down, over the two long posts, and screw it down with the two M2 × 5 mm screws.
3. Put a sheet of Kapton on the board's inner face, around J1.
4. Plug the cable into J1, lay the wires flat, and plug the battery back in.
5. Lay the case on the Cardputer, rim to rim. Put the two long screws in from the floor side.

## What is still open

The drawing is complete, but some of its numbers come from M5Stack's model and a photo, not from the real Cardputer:

| Measure or test | What it changes |
|---|---|
| 1. M5Stack's back screws: length and head diameter | `screw_len`, `screw_engage` (and `head_d` if the head is over 4.2 mm) |
| 2. In the battery-free strip: how tall the EXT socket's legs, the headphone socket, the flat-cable socket beside it, and the battery plug stand above the Cardputer's board. With the paper copy (`./pcb print`) laid on: what lies under J1 and under the two M2 screw heads | Whether J1 and H1/H2 can stay where they are (they need about 2 mm clear) |
| 3. The battery: its thickness and where it sits | Nothing, if it is the 6 mm its label says |
| 4. Inside M5Stack's back: any ribs or pads that touch the battery | Nothing: the board takes the floor's place |
| 5. A close look at the hidden row: can a soldering iron reach G3 and G5 from the ends? | The wiring plan |
| 6. The prototype's GPS board: its size, and where the module sits on it | The Test 2 plates (not drawn yet) |
| Test 1 | The ADC clock on G3, before the board is ordered |
| Test 2 | `gps_gap`, and so the thickness |
| Test 3 | The fit of the rim |

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

### Test 3: fit

Print `cardputer_back_rim_test.stl`, the top 4 mm of the new back, and try it on the Cardputer. That takes about half an hour instead of several hours. Check that the rim sits flat all round, the EXT socket and headphone socket line up with their openings, and the two screw holes sit over the screw inserts. Then print the whole back.

## Printing

- **Plastic:** PETG, or ASA. Not PLA: it softens at about 55 °C (a sunny car, or a warm battery in a pocket).
- **On the printer:** floor on the print bed, open side up. No supports are needed: the rounded bottom edges end in a 45° chamfer at the bed, and the only bridges are the tops of the cuff window (about 10 mm) and of the screw-head holes.
- **Settings:** 0.4 mm nozzle, 0.2 mm layers, at least 4 wall lines so the walls print solid, and solid posts.
- **For a final version,** a print service (for example JLC3DP, in nylon) gives a stronger and more accurate part.

## How the files are made

`cardputer_back.scad` is an OpenSCAD drawing (free, text-based). The choices you might change are at its top: `gps_gap`, `floor_t`, `ledge`, `screw_len`, `screw_engage`, `board_screw_inserts`. It needs an OpenSCAD build from 2025 or later (`brew install --cask openscad@snapshot` on a Mac); the 2021 release is too old and blocked on recent macOS.

`board.scad` holds what the case needs to know about the circuit board: its edge, its four holes, the cuff socket, and every part as a box of its outline and height. It is written from the board file, so the case and the board can't drift apart. Don't edit it.

In `hardware/`, run:

```
./pcb case
```

It writes `board.scad`, builds `cardputer_back.stl` and `cardputer_back_rim_test.stl`, runs the fit check and prints the GPS's distance to each screw. It also draws the picture at the top of this page (`cardputer_back.png`). After changing the board (`./pcb layout cardputer`), run it again.

### How it was checked

- **Fit (every run of `./pcb case`).** OpenSCAD works out where the case overlaps any of these, and the overlap must be empty: the board in its place; the board on its way in from the rim; every part, as a box of its outline and height (6.8 mm for the GPS, 6 mm for the cuff socket, 4.25 mm for J1, 2 mm for small parts); the cable plug in front of J1; the cuff plug through its window; and the two screw heads. On 24 November it came out empty. To prove the check works, it was run on two deliberately wrong cases: no gap over the GPS, and a 3 mm shelf. Both showed an overlap.
- **Against M5Stack's back (once, 24 November).** Both backs were cut into slices 0.05–6.4 mm below the rim, and drawn on a 0.05 mm grid. In each slice, the space M5Stack's back leaves for the Cardputer's insides was found by filling inwards from the middle. The new back has no material in that space at any of the 16 depths. As a check, a version with walls 1 mm too thick showed up at once (0.95 mm). M5Stack's model isn't kept in this repository, so this check isn't part of `./pcb case`: repeat it if the top 6.5 mm of the drawing changes.

## Files here

- `cardputer_back.scad`: the drawing.
- `board.scad`: the board's numbers, written by `./pcb case`.
- `cardputer_back.stl`: the back, ready for the slicer.
- `cardputer_back_rim_test.stl`: its top 4 mm, for Test 3.
- `cardputer_back.png`: the picture at the top of this page, drawn by `./pcb case`.
- `IMG_20261123_145254345_HDR.jpg`, `IMG_20261123_145307462_HDR.jpg`: the Cardputer ADV with its back removed, showing the battery, the EXT legs and their labels.
- `adv3.stl`: see the licence note above. Ignored by git.
