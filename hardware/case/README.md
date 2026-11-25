# Cardputer ADV: printed back case

A new back for the Cardputer ADV, printed in one piece. It replaces M5Stack's own back and holds two things: the Cardputer's battery, as before, and our GSR + GPS board underneath it. The board is wired to the Cardputer inside the case, so there is no flex tail and nothing sticks out.

**Status (24 November 2026, evening):** drawn, not yet printed or ordered. The circuit board (rev G) is laid out to fit inside the case, and its checks pass (`./pcb check cardputer`: no ERC or DRC problems, all 18 layout limits met). The case's STL files are made from `cardputer_back.scad`. In 3D, the board, every part, both plugs and the screw heads clear the case (`./pcb case`). Both checks were run again after the last changes below.

An outside review of the case and board (24 November) was acted on the same day. Its four open questions are now decided:

- No wrist strap: the strap corner and its pin are gone, and that corner is a plain rounded corner.
- The device is carried GPS side up. `Bio Mapping 2` and a shallow rounded outline over the module are pressed into the outside of the floor.
- About 10 will be made, soldered by hand.
- If the open EXT socket is a problem, a sticker goes over it.

Since the review, J1 has moved 3.1 mm towards the EXT socket (now centred at x 59.5), away from the headphone socket. [viewer.html](viewer.html) shows the case and board in 3D in a browser.

Still to do before printing: measurement 1 (it sets the long screws) and measurement 7 (the cuff plug). Before ordering the board: measurement 2 and Test 1. See "What is still open".

![The case, seen from the open side: the EXT opening in the near wall, the headphone slot at the left end, the cuff window in the left wall, the two long screw posts with their ledges, and the two posts for the board's screws, and the pocket that thins the floor over the GPS](cardputer_back.png)

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
- **Openings.** The EXT socket's opening is in the screen edge, at x 32.7–51.3, from the rim down 5.1 mm. The headphone socket's slot is in the end wall, at y 7.75–13.25, from the rim down 5 mm, with a round bottom. The strap corner is the keyboard-edge corner at the headphone end. A thin wall cuts that corner off, and beyond it the corner is open from the rim down 3.5 mm, with a 1.8 mm pin to loop a strap round. Our back leaves this out (see below).
- **Inside.** A 1 mm rib near each end stops the battery sliding. There are Lego tubes and add-on screw slots along the screen edge, and nothing else.
- **The battery-free strip.** The battery starts about 22 mm in from the screen edge (from the photo). The strip between the screen edge and the battery holds the EXT socket's legs, the headphone socket, the battery plug and the two screw posts.

**About `adv3.stl`:** this is "Alternative Back Cover for M5Stack Cardputer Adv" from MakerWorld. Its main positions match M5Stack's model, but it is licensed for personal use only. This repository is public, so `adv3.stl` is listed in `.gitignore` and must never be committed. We don't need it: the new back is drawn from M5Stack's own model.

## The new back, layer by layer

From the Cardputer outwards (the numbers are the drawing's settings):

1. **Rim and battery layer (6.5 mm).** Copied from M5Stack's back: the outline, the wall faces, the two screw posts, the EXT opening and the headphone slot. Not copied: the Lego tubes, the add-on screw slots, the magnets, the battery ribs and the wrist-strap corner (closed off as a plain rounded corner). Its walls are nowhere thicker than M5Stack's, so nothing inside the Cardputer can touch them (see "How it was checked"). In its bottom 1.5 mm the EXT wall is thinner, as M5Stack's is beside its Lego tubes. Where it gets thicker again, ours slopes back at 45° instead of stepping, so it prints without an overhang; along the slope it is still thinner than M5Stack's.
2. **Our board (1.6 mm).** Its inner face sits exactly where the inner face of M5Stack's floor was. The battery keeps the same room it has now, and the board holds it in place, as M5Stack's floor did. A thin insulating sheet (Kapton) goes between the board and the battery. All the parts on the board face outwards, except the cable socket J1, which sits in the battery-free strip.
3. **Parts and GPS space.** This is the tallest part (the GPS module, 6.8 mm at most) plus a gap of 3 mm over it (3.8 mm right over the GPS, where the floor is thinner: see 4). u-blox asks for at least 5 mm between plastic and the antenna; 3 mm was chosen to keep the case thinner. Test 2 below checks whether that costs any signal; the gap is one setting (`gps_gap`).
4. **Floor (2 mm).** Plain plastic, with `Bio Mapping 2` debossed 0.4 mm into the outside. Over the GPS the floor is thinned to 1.2 mm by a pocket (18.5 mm square) cut into its inside face: less plastic over the antenna, and 0.8 mm more air, without making the case thicker. The pocket stays inside the shelf the board rests on, and prints without an overhang. A rounded outline round the GPS, one layer (0.2 mm) deep, marks it on the outside, so the thinnest plastic, under that outline, is 1.0 mm. The drawing refuses to build if any plastic over the GPS would be thinner than 1 mm (`gps_floor`, `min_floor`). No screws, labels or paint containing metal over the GPS. Use plain PETG or ASA: carbon-fibre, "silk", glitter or metallic-look filaments can contain particles that block GPS.

Below the battery layer the outside runs straight down, and the floor's edge is rounded as M5Stack's is. At the print bed each rounded edge turns into a 45° chamfer, so the first layers never overhang. The wall beside the board is 1.4 mm thick and stands 0.5 mm clear of the board's edge all round. That leaves room for the board's cutting tolerance (JLCPCB cuts edges to within ±0.2 mm) and for a print that comes out a little small. Below the board the wall is 1.2 mm thicker, which forms a shelf all round; the board's edge rests on 0.7 mm of it.

How thick the Cardputer becomes (19.6 mm today):

- with a 5 mm gap over the GPS (u-blox's advice): 33.5 mm
- with a 3 mm gap: 31.5 mm (the drawing as it is)
- with a 2 mm gap: 30.5 mm
- with an opening in the floor over the GPS, the module flush with the outside: about 27 mm (not drawn)

## Holding the board

- **The two long screw posts** run from the floor up to the rim, where M5Stack's posts are. Above the board they are 4 mm across, like M5Stack's, and pass through the board's 4.8 mm holes (H3, H4). The spare 0.4 mm allows for a print that shrinks a little over the 41.5 mm between the posts. Below the board they are 7 mm across, a ledge the board rests on.
- **The shelf** round the wall carries the board's edge everywhere except at the cuff socket.
- **Two M2 screws, 5 mm long** (H1, H2), go through the board into two posts of the case. They keep the board in when the back is off, and stop it rattling. H1 is near the corner on the GPS side; H2 is below the headphone socket, where the inner face has room for a screw head. The screws go into **M2 heat-set inserts** (two, up to 4 mm long, for a 3.2 mm hole), pressed into the posts with a soldering iron. The case will be opened often during the tests, and an insert's thread doesn't wear. Setting `board_screw_inserts = false` makes 1.7 mm holes instead, for the screws to cut their own thread. Printed, that hole comes out nearer 1.5 mm: an M2 screw forced into it can split the post along its layers, and the thread wears a little each time.
- The board goes in straight from the rim side, over the two posts.

## The long screws

- They go into the same two places as M5Stack's screws.
- **Length:** measure M5Stack's screws first (measurement 1). Each passes through 6 mm of the old back, so the old screw's length less 6 mm is how far a screw may go into the Cardputer. Set that as `screw_engage`, and the length you buy as `screw_len`. The drawing puts the head's seat at the right height and stops with a message if the screw is too short or too long. The default is M2 × 16 mm going in 3 mm: its head sits 6.9 mm up from the floor, at the bottom of a 4.4 mm hole.
- **Their holes are 2.4 mm**, against M5Stack's 2.2 mm. Each screw runs through 13 mm of case, and a printed hole comes out about 0.2 mm small. At 2.2 mm the screw would cut its own thread into the case, and that thread would then hold it back, so it couldn't pull the case tight onto the Cardputer.
- **A thin cover** closes the top of each head hole after printing; push a 2 mm drill or the screw through it (see "Printing").
- **Screwdriver:** the heads sit 7 mm deep in a 4.4 mm hole. Use a slim precision screwdriver, not a bit holder.
- **The GPS side.** The screw's head sits at the same height as the GPS module, 10.2 mm from it: just past u-blox's 10 mm, so an ordinary steel screw is fine. (`./pcb case` measures to the head, which is 2 mm wider than the screw.) The post's plastic ledge under the board comes to about 8.5 mm from the module. Plastic matters far less than metal, but Test 2 will show it if it does.

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

The ADC keeps its own I2C bus, as now. This is the quiet set-up measured on 21 November. The only change is that the clock wire moves from G6 to G3, because G6 is in the middle of the hidden row and hard to reach. The firmware already uses G3 (`GSR_SCL_PIN` in [gsr_cardputer.cpp](../../firmware/cardputer/src/gsr_cardputer.cpp)), so the prototype's clock flywire must move to G3 too (Test 1, step 1). The board has two pull-up resistors (R6, R7). The prototype needs none, because its ADC board has its own.

### What we checked about G3

Our notes used to say "leave G3 alone". On 23 November we checked why:

- **Inside the Cardputer, G3 goes nowhere else.** In M5Stack's circuit diagram for the ADV, G3 runs only from the processor module to EXT pin 1. No keyboard, sound, screen or power part uses it.
- **M5Stack calls that pin "RESET".** It is the reset wire for M5Stack's LoRa radio add-on. Our back replaces the place that add-on fits, so nothing else will use the pin. Other firmware written for that add-on might switch G3 on and off. That does no harm; the ADC ignores it.
- **The ESP32 chip looks at G3 when it starts.** This only counts if a special one-off setting has been burned into the chip, and normal chips don't have it. Even then, G3 only chooses how a debugging tool connects; the Cardputer starts normally either way. And our pull-up resistor holds G3 high, which picks the normal choice. Test 1 reads that setting from the chip to be sure. Reading it changes nothing.
- **M5Stack's software wiggles G3 for a moment at start-up.** To work out which M5Stack device it is running on, it briefly tries some other devices, and a few of those use pins 3, 5 and 6. Today's wiring already gets this on G5 and G6, and the prototype has worked fine, because our firmware only starts talking to the ADC afterwards. Test 1 checks that the ADC is found at every start.
- **The CardputerZero** would need a different back anyway, so this choice changes nothing there.

### Possible problems

1. **G3 sits right behind 5VI.** 5VI carries 5 V whenever USB is plugged in, because it feeds the battery charger. A blob of solder joining them would put 5 V on G3, which can only take 3.3 V, every time you charge, and could damage the Cardputer. Solder G3 with a fine tip and little solder, with a strip of Kapton slipped between the two rows of legs so solder can't reach 5VI. Then, **before plugging in USB**, check with a multimeter that G3 and 5VI are not connected (no beep).
2. **G5 sits right behind G15**, with G39 (the SD card) beside it. A blob there does no damage, but the GPS, the ADC or the SD card would stop working. Check G5 against G15 and G39 the same way.
3. **The two ADC wires start at opposite ends of the row**, about 15 mm apart, so they can't be twisted together right from the legs. Bring them together as soon as possible and twist them from there, with a ground wire. Over a few centimetres inside the case this shouldn't matter. Test 1 checks the noise.
4. **The ADC's "reading ready" wire (G4) stays unconnected.** G4 is in the middle of the hidden row. The firmware doesn't use it; it would only matter for faster GSR reading later. J1's pin 8 is kept for it.
5. **Two ways of numbering the pins.** M5Stack's diagram numbers the EXT pins differently from our notes. In our notes, pin 1 is G3, pin 5 is G6 and pin 13 is G5. In M5Stack's, G5 is pin 7. Go by the names (G3, G5, 5VI), not the numbers.

### Ruled out

- **ADC on G8/G9** (easy row): that is the Cardputer's own internal bus, shared with the keyboard, sound chip and motion sensor. Moving the ADC off it on 21 November cut the noise.
- **GPS over I2C:** it would need new GPS code and board changes, and G3 + G5 makes it unnecessary.

### The cable

- **The socket** is J1, a JST GH 8-pin side-entry socket (SM08B-GHS-TB, 1.25 mm pin spacing, 4.25 mm tall), on the board's inner face, centred at x 59.5 (between the EXT socket at x 51.3 and the headphone jack body at x 70.4, giving > 4 mm clearance to the headphone body and ~1.6 mm to the EXT socket). It sits in the battery-free strip where M5Stack's back had its Lego tubes, so nothing of the Cardputer's comes down that far. Its mouth faces into the board, so the plug lies over flat board, clear of the EXT socket's body and the headphone socket. Each pin's EXT leg is printed beside it. It is soldered by hand: the factory fits only the other face.
- **The plug** latches, so it won't shake loose while walking. Ready-made GH cables are easy to buy: cut one end off and solder those wires onto the legs.
- **Ignore the wire colours.** Ready-made GH cables often have a red wire on pin 1, but on J1 pin 1 is a GPS wire (G15), and 5 V is pin 4. Going by colour habit would put 5 V into the GPS. Before soldering, beep each wire with a multimeter from its pin on the plug to its cut end, and solder it to that pin's leg (the table above; the pin numbers are also printed beside J1).
- **Keep it short**, about 5–6 cm: from the plug, the wires turn back towards the EXT legs, about 2–3 cm away. Twist the ADC pair with one ground wire, and the GPS pair with the other.
- **Unplug the battery before soldering.** Cover the joints with heat-shrink or Kapton tape, and tape or glue the cable to the Cardputer's board, so pulling the plug can't pull on the joints.
- **Before switching on, check with a multimeter:** G3 not joined to 5VI, G5 not joined to G15 or G39, no short between 5VO and GND, and each wire on the right leg.

## Putting it together

1. Solder the cable inside the Cardputer (above) and check it with a multimeter.
2. Press the two M2 heat-set inserts into the case's two short posts with a soldering iron (once, when the case is new).
3. Put the board into the case from the rim side, parts face down, over the two long posts, and screw it down with the two M2 × 5 mm screws.
4. Cover the board's inner face with Kapton: all of the strip under the EXT legs (about x 32–52, y 5–18), and the area under the battery. The legs are bare metal, bent over the Cardputer's board, and one of them is 5VI, which is live whenever USB is plugged in. The board's inner face is ground copper under a thin coat of solder mask, and a sharp point of solder could push through it.
5. Plug the cable into J1, lay the wires flat, and plug the battery back in. Check that no wire lies on the edge of the battery: a wire trapped under it would be pressed into it.
6. Lay the case on the Cardputer, rim to rim. It must sit flat by itself; if it doesn't, find what is in the way. Then put the two long screws in from the floor side, with a slim precision screwdriver. Never force them.

## What is still open

The drawing is complete, but some of its numbers come from M5Stack's model and a photo, not from the real Cardputer:

| Measure or test | What it changes |
|---|---|
| 1. M5Stack's back screws: length and head diameter | `screw_len`, `screw_engage` (and `head_d` if the head is over 4.2 mm) |
| 2. In the battery-free strip: how tall these stand above the Cardputer's board: the EXT socket's bent legs, the headphone socket, the flat-cable socket beside J1 (labelled P1–P8), the white plastic clip of the front shell at the screen edge near J1 (about x 59–65), and the battery plug. With the paper copy (`./pcb print`) laid on: what lies under J1, under the plug and its wires in front of J1 (x 52–67, y 2–16), and under the two M2 screw heads | Whether J1 and H1/H2 can stay where they are. The screw heads need about 2 mm clear. The plug and the first bend of its wires stand about 4 mm above our board, which leaves about 2.5 mm to the Cardputer's board. The legs' height tells how thick the Kapton over them must be (step 4 of "Putting it together") |
| 3. The battery: its thickness and where it sits | Nothing, if it is the 6 mm its label says |
| 4. Inside M5Stack's back: any ribs or pads that touch the battery. Is the battery stuck to the Cardputer (tape or glue)? | M5Stack's ribs also stopped the battery sliding, and our back has none. If the battery is stuck down, nothing. If not, stick two small foam pads on our board's inner face at the battery's ends, where M5Stack's ribs were, so it can't slide towards H2's screw head or the EXT legs |
| 5. A close look at the hidden row: can a soldering iron reach G3 and G5 from the ends? | The wiring plan |
| 6. The prototype's GPS board: its size, and where the module sits on it | The Test 2 plates (not drawn yet) |
| 7. The cuff plug: push it fully into a loose J2 socket and measure how far its back end stands out from the socket's mouth. Also the socket's height above the board | Whether the finger scoop (`cuff_scoop`) is needed: the socket's mouth sits 2.7 mm inside the outside of the case, so a plug standing out less than about 5 mm leaves little to pinch, and people pull on the wires instead. The drawing guesses the socket is 6 mm tall (`cuff_h`), because KiCad has no 3D model of it |
| 8. M5Stack's real back: any clips, hooks or a lip along the keyboard edge | Both long screws are 18 mm from the screen edge and nothing holds the keyboard edge. That is fine for M5Stack's 8 mm back, but ours is almost three times as deep, so a knock or a twist can lever it open with much more force. If M5Stack's back has clips there, measure them and they go into the drawing |
| Test 1 | The ADC clock on G3, before the board is ordered |
| Test 2 | `gps_gap`, and so the thickness |
| Test 3 | The fit of the rim and the battery |

## Tests

You do the wiring and printing. I prepare the firmware and the test plates, then go through the files you send.

### Test 1: the ADC clock on G3 (confirms the wiring)

Use the prototype as it is now: ADC board on flywires, fixed 600 kΩ resistor in place of the finger cuffs. As usual, switch the prototype's power on before the Cardputer and off after it.

1. Move the clock flywire from EXT pin 5 (G6) to EXT pin 1 (G3). Pin 1 is in the same row, two holes along from pin 5, at the opposite end from pin 13 (G5). The data wire stays on pin 13 (G5).
2. Plug the Cardputer into the laptop. I flash the current firmware (clock on G3) and read the chip's start-up setting.
3. Unplug USB. Switch the Cardputer off and on 10 times. Each time it should start normally and show a GSR reading (ADC found).
4. Record 3 minutes in GSR Only mode without touching anything, everything on battery as before. I compare the noise with the 21 November recording (about 0.3 nS).
5. Plug USB back in. Check that it starts normally while charging and that I can still flash it.
6. Still on USB, start a recording. I restart the Cardputer from the laptop 10 times while it records, without switching it off (the same way new firmware is flashed). Each time it should start normally and find the ADC. This checks something step 3 can't: there the ADC loses power too. If the Cardputer restarts while it is reading the ADC, and the ADC stays powered, the ADC can get stuck holding its data wire low, and the Cardputer then says "ADC not found" until it is switched off and on. This can happen after a crash, after flashing over USB, or when M5Stack's start-up code briefly wiggles G3 and G5. If the ADC is ever missing, the usual fix is 9 pulses on the clock wire before the bus starts: about 15 lines in [gsr_cardputer.cpp](../../firmware/cardputer/src/gsr_cardputer.cpp).

### Test 2: how much gap the GPS needs (decides the thickness)

1. Print small test plates in the plastic the case will use, with legs that hold them above the GPS module: 2 mm thick at 0.5, 2, 3 and 5 mm, and one 1.2 mm thick at 3.8 mm (what the case does over the GPS). I'll draw them to fit the prototype's GPS board.
2. Go outdoors under open sky. Lay the Cardputer flat on something that isn't metal, GPS facing up, running the bench program and logging to a laptop on battery.
3. Three minutes each: no plate, then the 5 mm, 3 mm, 1.2 mm-at-3.8 mm, 2 mm and 0.5 mm plates. Then do the whole round twice more. The satellites move, so taking turns keeps the comparison fair.

Send me the log. I compare the signal strength of the four strongest satellites, and the number of satellites used. The case is drawn like the 1.2 mm-at-3.8 mm plate. If that costs real signal against the 5 mm plate, set `gps_gap` back to 5 (2 mm thicker); if 2 mm costs nothing, the case can be 1 mm thinner.

### Test 3: fit

Print `cardputer_back_rim_test.stl`: the battery layer of the new back (6.5 mm) on a 1 mm plate. The plate stands exactly where M5Stack's floor was, so nothing of the Cardputer can be there, and it joins the walls and both screw posts into one piece. It takes about an hour instead of several. Try it on the Cardputer with the battery in place. Check that the rim sits flat all round, the battery fits, the EXT socket and headphone socket line up with their openings, and the two screw holes sit over the screw inserts (an M2 screw should go in by hand). Also check the closed-off strap corner: M5Stack's back was open there from the rim down 3.5 mm, and ours is solid. It must meet the Cardputer's corner without a gap or a bump. Then print the whole back.

## Printing

- **Plastic:** PETG, or ASA. Not PLA: it softens at about 55 °C (a sunny car, or a warm battery in a pocket).
- **On the printer:** floor on the print bed, open side up. No supports are needed. The rounded bottom edges end in a 45° chamfer at the bed, and the step in the EXT wall and the top of the finger scoop slope at 45°. The only bridges are the top of the cuff window (about 10 mm) and a thin cover (0.3 mm) at the top of each long screw's head hole. Without the cover, the roof of the 4.4 mm head hole would be a ring with nothing under it, printed in mid-air; with it, the printer bridges straight across, and the 2.4 mm hole above stands on that bridge.
- **After printing,** push a 2 mm drill (or the long screw) through each cover.
- **The rim test** prints plate down.
- **Settings:** 0.4 mm nozzle, 0.2 mm layers, at least 4 wall lines so the walls print solid, and solid posts.
- **For a final version,** a print service (for example JLC3DP, in nylon) gives a stronger and more accurate part.

## How the files are made

`cardputer_back.scad` is an OpenSCAD drawing (free, text-based). The choices you might change are at its top: `gps_gap`, `floor_t`, `board_gap`, `ledge`, `screw_len`, `screw_engage`, `board_screw_inserts`, `cuff_scoop`, `gps_pocket`, `gps_floor`. It needs an OpenSCAD build from 2025 or later (`brew install --cask openscad@snapshot` on a Mac); the 2021 release is too old and blocked on recent macOS.

`board.scad` holds what the case needs to know about the circuit board: its edge, its four holes, the cuff socket, and every part as a box of its outline and height. It is written from the board file, so the case and the board can't drift apart. Don't edit it.

In `hardware/`, run:

```
./pcb case
```

It writes `board.scad`, builds `cardputer_back.stl` and `cardputer_back_rim_test.stl`, runs the fit check and prints the GPS's distance to the metal in each screw hole (the long screws' heads and the inserts, which sit at the GPS's height). It also draws the picture at the top of this page (`cardputer_back.png`). After changing the board (`./pcb layout cardputer`), run it again.

### How it was checked

- **Fit (every run of `./pcb case`).** OpenSCAD works out where the case overlaps any of these, and the overlap must be empty: the board in its place; the board on its way in from the rim; every part, as a box of its outline and height (6.8 mm for the GPS, 6 mm for the cuff socket, 4.25 mm for J1, 2 mm for small parts); the cable plug in front of J1; the cuff plug through its window; and the two screw heads. On 24 November it came out empty, and again that evening after J1 moved and the lettering was added. To prove the check works, it was run on two deliberately wrong cases: no gap over the GPS, and a 3 mm shelf. Both showed an overlap.
- **Against M5Stack's back (once, 24 November).** Both backs were cut into slices 0.05–6.4 mm below the rim, and drawn on a 0.05 mm grid. In each slice, the space M5Stack's back leaves for the Cardputer's insides was found by filling inwards from the middle. The new back has no material in that space at any of the 16 depths. As a check, a version with walls 1 mm too thick showed up at once (0.95 mm). M5Stack's model isn't kept in this repository, so this check isn't part of `./pcb case`: repeat it if the top 6.5 mm of the drawing changes.
- **After the review's changes (24 November).** The new top 6.5 mm was compared with the version checked above, in OpenSCAD: it adds no plastic anywhere (a version made 0.2 mm thicker all over showed 690 mm³ at once). The changes there only take plastic away: the slope in the EXT wall and the wider screw holes. Both STL files come out as one piece each.
- **After the strap corner was closed (24 November, evening).** This does add plastic to the top 6.5 mm, but only on the outside of that one corner, where M5Stack's back was open. The check above only looks at the space inside the walls, so it can't see this. Test 3 shows whether any part of the Cardputer's top half comes down into that corner.

## Files here

- `cardputer_back.scad`: the drawing.
- `board.scad`: the board's numbers, written by `./pcb case`.
- `cardputer_back.stl`: the back, ready for the slicer.
- `cardputer_back_rim_test.stl`: its battery layer on a 1 mm plate, for Test 3.
- `cardputer_back.png`: the picture at the top of this page, drawn by `./pcb case`.
- `viewer.html`: the case, board, screws and inserts in 3D. Open it in a browser. It has buttons for set views (back, side, cuff end, inside, board), can show the case see-through, and can load another STL file. The case model is stored inside the page, so it doesn't change when `./pcb case` runs. The Cardputer's top half (shell, keys, screen bezel, Stamp module) is M5Stack's own model (`Cardputer-Adv.stl`, MIT licence, © M5Stack), also stored inside the page; the screen and its picture are added. After changing the drawing, load the new `cardputer_back.stl` with **Load .stl**.
- `IMG_20261123_145254345_HDR.jpg`, `IMG_20261123_145307462_HDR.jpg`: the Cardputer ADV with its back removed, showing the battery, the EXT legs and their labels.
- `adv3.stl`: see the licence note above. Ignored by git.
