# Moving BioMapping 2 to the M5Stack Cardputer ADV

This document describes what it would take to run BioMapping 2 on an M5Stack Cardputer ADV instead of a Flipper Zero, and what that change would mean for the project.

It assumes **the EM (radio) scan is dropped**. The device would record GSR and GPS only, which is the existing `GPS+GSR` mode.

The same backpack board should also work on the **CardputerZero**, a Linux version of the Cardputer with the same shape. Section 10 covers what that changes.

Some hardware details below come from M5Stack's documentation and retailer pages, not from a device on the bench. They are marked **(check)**.

---

## 1. Why consider it

The Flipper Zero works well, but it was not designed for this job. The Cardputer ADV is a small ESP32-S3 computer, about the size of a credit card, with:

- a 240×135 colour screen (the Flipper's is 128×64, black and white)
- a full keyboard (the Flipper has a direction pad and a Back button)
- a 1,750 mAh battery
- a microSD card slot
- Bluetooth and Wi-Fi
- a Grove port and a 14-pin expansion header (called "EXT") on the back

The questions are whether the move is worth the work, and what changes for the people using the device.

---

## 2. Hardware

### What stays the same

The sensors do not change:

- **GSR:** the same transimpedance amplifier circuit and ADS1115 converter, connected over I2C.
- **GPS:** the same u-blox SAM-M10Q, connected over a serial port (UART).

Because the sensors are the same, the readings should match the Flipper's, as long as the power supply is clean (see section 5).

### Where the electronics go

The Cardputer ADV's 14-pin EXT header sits on the back of the device **(check)**. It carries I2C, UART, SPI, 5 V and ground, but **no 3.3 V** (see "Power and connections" below). M5Stack's own add-on boards (they call them "Caps") lie flat against the back, so the electronics can sit underneath and the device keeps its shape.

Options:

1. **A ready-made proto board.** The [Cardputer Prototyping Bread Board Expansion](https://lectronz.com/products/cardputer-prototyping-bread-board-expansion) on Lectronz plugs into the EXT header. It is not clear whether it lies flat under the device or sticks out past the edge, or whether it was made for the ADV. The listing says it ships to the US only. Ask the seller before buying.
2. **A home-made Cap.** Standard perfboard (2.54 mm hole spacing), cut to the size of the back, with a 2×7 female header. Use M5Stack's official mechanical drawings for the header position, not photos.
3. **Later, a printed circuit board.** Once the perfboard layout works, it can become a small custom PCB. This matters for workshops (see section 6).

The Grove port is not enough on its own. It has two signal pins, so it can carry the GPS *or* the I2C bus, not both. Using EXT for everything keeps the Grove port free.

### How the printed board reaches the EXT socket: a flex tail

The printed board (`hardware/biomap_cardputer/`) is exactly the size of the Cardputer's back, 84 × 54 mm, and is held by two M2 screws. It has no header or socket. Instead, a **flex tail** (`hardware/biomap_cardputer_tail/`) joins it to the EXT socket. This is a flexible circuit: a strip of thin plastic with the copper wires inside, like the ribbons inside a phone or camera, but made to our own shape.

- **The plug end** has a thin stiff plate glued to it, with a straight 2 × 7 pin header soldered through. It stands against the Cardputer's bottom edge, with the header pushed into EXT.
- **The bendy strip** in the middle folds round the bottom edge.
- **The solder end** lies flat on the main board, just inside the edge, and is soldered there for good through 8 small plated holes.

**Why this way?** It's the lowest and cleanest connection: nothing on the main board stands taller than the flex itself, about 0.2 mm, and there are no sockets to buy. A header fixed to the main board would have to line up with the socket in three directions at once, and a small mistake in M5Stack's drawings would bend the pins. The flex takes up any mismatch, so the main board only has to fit its screws. If the tail turns out wrong on a real device (for example, the socket rows are the other way round), only the tail needs remaking, not the GPS board.

**How it's made:** circuit board makers such as JLCPCB and PCBWay make flexible circuits from the same kind of drawing files as normal boards. They add the stiff plate behind the plug end. A first batch of 5 seems to cost roughly $15–25, a few days slower than normal boards. You then solder the header into the plug end, lay the solder end on the main board's pads, whose ends stick out past the tail's tip, and touch the iron where each pad meets the tip: the solder runs through each hole onto the pad below and forms a fillet you can see. A strip of Kapton tape over the joint stops bending from pulling on the solder.

**Still to check on a real Cardputer:** that the EXT socket opens out of the bottom edge (M5Stack's 3D model suggests it does; their docs only say "underside"), which row of the socket is which, that no port or button on that edge gets in the way, and that the tail's fold round the edge is comfortable.

Full details are in [hardware/README.md](../hardware/README.md), under "How the Cardputer connects".

### How other people attach boards to the back

- **M5Stack's own Caps** (LoRa-1262, CC1101 & NFC) are not full-size boards. Each is an L-shaped plastic block, 84 × 24 mm, that sits at one end of the device. Its pins push into the EXT socket from the edge, and two tabs wrap under the back and take two M2 × 4 mm screws. [M5Stack's drawing of the LoRa Cap](https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/1208/U214-00-cap1262-model-size.pdf) puts these screws 14 mm in from each side and 56 mm apart, the same as our H1 and H2.
- **PALPack** (Valleytech, [GitHub](https://github.com/valleytechsolutions/PALPack)) is a 65.5 × 36.5 mm board joined by ordinary pin headers through a small adapter board that swaps the pin order. It needs its own 3.3 V regulator too, and puts its GPS on G13/G15 like ours.
- **Which edge?** In [M5Stack's drawing of the Cardputer ADV](https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/1178/K132-Adv-cardputer-ADV.pdf), the two M2 holes (and so the EXT socket) are at the **screen end** of the device. That is the edge this document and `cardputer.py` call the "bottom edge", because it is at the bottom when you look at the back. The positions in our layout match the drawing; only the name could confuse someone holding the device the normal way up.

### A case over the board

Someone has made a 3D-printed case for a Cardputer backpack: a box with the same outline as the Cardputer, so its sides sit flush with the device. Two screws go into the Cardputer's M2 holes and four more hold the lid on. We could do something similar in one of two ways.

**Option A: board inside a box.** The walls sit outside the board, so the board must shrink by the wall thickness plus a little play on every side. With 1.6–2 mm printed walls and about 0.3 mm play, that is roughly 79.5 × 49.5 mm. The layout would need redoing, the cuff socket would end up about 2 mm behind the outer wall (the plug may not go fully in unless the wall has a deep cut-out), and the box needs its own way to hold the board.

**Option B: the board is the floor of the case (preferred).** The board stays 84 × 54 mm, and the printed part is just a cover whose walls stand on the board's outer edge. The edges are still flush, with the board showing as a thin stripe between the Cardputer and the cover. This needs:

- a strip about 2 mm wide round the edge kept clear of parts, for the walls to stand on;
- a cut-out in the wall for the cuff socket, and a gap where the flex tail folds round the edge;
- longer screws through the cover and board into the Cardputer. The part that goes into the Cardputer must stay about 4 mm, as longer screws can damage the board inside, so screw length = cover + board + 4 mm, with the heads sunk into the cover.

Our tallest parts are only a few mm high, so the cover could be about 5–6 mm deep. Plastic does not block the GPS signal, but keep metal (screws, labels, paint with metal in it) away from the area over the GPS.

**Edge strip checked:** no parts sit in the 2 mm edge strip, so Option B needs no parts moved. The closest are FB1 and U3, about 3.6 mm from the EXT edge. Two things for whoever designs the cover:

- **Screw recesses.** The screw holes are 4 mm from the EXT edge, and they can't move because they must match the Cardputer's. A recess for a typical M2 head (3.8–4 mm across) is about 4.2–4.4 mm wide, so it reaches 0.1–0.2 mm into a 2 mm wall. Either let the wall be that bit thinner at the two screws, or use button-head screws (about 3.5 mm across), whose recess just clears the wall.
- **Printed text.** The "GPS: keep this side clear of metal" line has been moved inwards so it no longer runs under the bottom wall. The cover hides all the text on the outer face anyway.

### Power and connections

Our board (op-amp, ADS1115, M10Q) runs on 3.3 V. On the Flipper it takes 3.3 V from GPIO pin 9.

**The Cardputer ADV does not offer 3.3 V on either external connector.** According to [M5Stack's official pinout](https://docs.m5stack.com/en/products/sku/K132-Adv), the EXT header has only 5 V (pin 2 "5V in" and pin 6 "5V out") and ground (pin 4). The Grove port is the same: 5 V and ground only.

So the Cap needs **its own 3.3 V regulator**, a small chip that turns the 5 V into a steady 3.3 V. That is one part plus two capacitors.

The signal pins are fine as they are. The ESP32 uses 3.3 V logic, the same as the Flipper, so the I2C and serial lines connect directly with no level shifting.

EXT pins we would use:

| EXT pin | Signal | ESP32 pin | Connects to |
|---|---|---|---|
| 6 | 5V out | — | Input of the new 3.3 V regulator |
| 4 | GND | — | Common ground for everything |
| 8 | I2C SDA | G8 | ADS1115 SDA |
| 10 | I2C SCL | G9 | ADS1115 SCL |
| 12 | UART TX | G13 | M10Q RX |
| 14 | UART RX | G15 | M10Q TX |
| 3 | G4 | G4 | ADS1115 ALERT/RDY (pulses when a reading is ready; needs the ESP32's pull-up on) |

Pin 2 ("5V in") is for powering the Cardputer *from* a Cap. It should not be used here.

#### Why the regulator matters more than usual: the 0.5 V bias

The GSR circuit makes its 0.5 V bias from the 3.3 V supply with a resistor divider (56 kΩ and 10 kΩ, see [wiring_guide.md](wiring_guide.md)). Every GSR reading is in proportion to this bias, so a supply 2% low would give readings 2% low if the firmware assumed exactly 0.5 V.

It doesn't assume it. The firmware already measures the bias on the ADS1115 (AIN1 against ground) and uses the measured value when it converts readings into nanosiemens ([gsr_sensor.h](../firmware/core/gsr_sensor.h), "0.5 V bias measurement"). It measures at start-up, at the start of each recording (the value goes in the file's header), when a phone first connects for Live Stream, and before each resistor in the calibration wizard. It never measures in the middle of a recording, because a new value would put a step in the data. So a supply that is simply a little off is already corrected.

What the regulator still decides is how steady the supply stays **during** a recording, since the bias is measured only at the start. The published accuracy (±0.1% over most of the range) was measured on the Flipper's 3.3 V supply. With a new regulator:

- choose a **low-noise, stable** regulator, not the cheapest one
- run the resistor-grid test again on the new device

This is also a chance to improve on the Flipper. A dedicated, quiet regulator on the Cap keeps the GSR circuit away from the noise of the Cardputer's own 3.3 V supply, which powers the ESP32 and its radio.

#### The I2C bus is shared with the Cardputer's own parts

M5Stack's own pin table ([Cardputer-Adv docs](https://docs.m5stack.com/en/core/Cardputer-Adv)) confirms that the EXT header's I2C pins (pin 8 = G8 = SDA, pin 10 = G9 = SCL) are the same bus the Cardputer uses for its own parts:

| Part | Address | Source |
|---|---|---|
| Keyboard controller (TCA8418) | 0x34 | several community sources; it also has its own "key pressed" signal on G11 |
| Audio chip (ES8311) | usually 0x18 | chip datasheet default, not stated by M5Stack |
| Motion sensor (BMI270) | usually 0x68 or 0x69 | chip datasheet default, not stated by M5Stack |
| GSR converter (ADS1115) | 0x48 | our board (ADDR tied to GND) |

None of the addresses clash, so sharing works electrically.

**What went wrong for other people.** In the Bruce firmware, an RFID reader on G8/G9 failed while the same reader worked on the Grove port ([issue #2143](https://github.com/BruceDevices/firmware/issues/2143)). The firmware's author explained why: the keyboard was driven by one I2C driver (`Wire1`) and the reader by a second one (`Wire`), both on the same two pins. Two drivers fighting over one bus can stop the keyboard working. This is a software mistake, not a hardware fault. A Cardputer ADV test project shares the keyboard's driver with its add-on deliberately for the same reason ([cardputer-adv-tests](https://github.com/AndyAiCardputer/cardputer-adv-tests)).

**Rules for our code:**

- **One driver for the whole bus: M5Stack's.** M5Stack's keyboard code, its audio set-up and our ADS1115 code all use the same I2C driver (`M5.In_I2C`). That driver already has its own lock: each read or write holds the bus from start to finish, and another thread waits until it is done. This holds whichever thread the call comes from. We checked this in the M5GFX source for the version we use (0.3.0) and in older versions. So the GSR thread can call it directly, with no extra lock of ours. Two things to keep to:
  - Only the GSR thread talks to the ADS1115. Its steps (set the input, wait, read) can then have keyboard reads between them without harm, because the ADS1115 keeps its own settings.
  - Never open a second driver on the same pins (see "Gotchas for the Cardputer code").

  The keyboard only reads the bus after a key press (the keyboard chip signals it on G11), so it rarely makes the GSR thread wait, and then only for a fraction of a millisecond.
- **Bus speed.** All four parts support 400 kHz. At 860 readings a second, the GSR reads keep the bus busy roughly 40% of the time at 100 kHz and about 10% at 400 kHz (an estimate). The keyboard only uses the bus when a key is pressed, so there is room either way, but 400 kHz leaves more.
- **Pull-up resistors.** The Cardputer already has them: the [official schematic](https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/1178/Sch_M5CardputerAdv_v1.0_2025_06_20_17_19_58.pdf) (page 2, beside the keyboard chip) shows 3.3 kΩ from G8 (R35) and G9 (R36) to the Cardputer's 3.3 V. That value suits 400 kHz with our short flex tail added, so our board has no pull-ups of its own. They run from the Cardputer's 3.3 V, not our regulator's, which is fine: the ADS1115's I2C pins accept up to 5.5 V whatever its own supply. To check a real unit, switch the Cardputer on with nothing plugged into the EXT header and measure the voltage from SDA and from SCL to GND. Each should read about 3.3 V, which shows the pull-ups are there. Measuring resistance with the power off is less reliable: the protection diodes in the chips on the bus can let the meter's current through and give a low reading.
- **Test early.** In the first Cardputer step, read the ADS1115 and the keyboard together before building anything else. Also leave it running for an hour and check that the keys still respond: one Cardputer app reported the keyboard stopping after 10–20 minutes ([issue #12](https://github.com/Mr-PauI/Gameboy-Enhanced-Firmware-m5stack-cardputer-/issues/12)). Found since: a race in M5Cardputer 1.1.1's keyboard reader, now worked round (section 9, "Second review").

If the shared bus still causes trouble, the ADS1115 can go on the Grove port instead (G2 and G1 as a separate I2C bus). The Bruce report shows that port working when G8/G9 did not. The M10Q stays on the EXT serial pins.

#### What the official schematic shows

M5Stack publishes the [Cardputer ADV schematic](https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/1178/Sch_M5CardputerAdv_v1.0_2025_06_20_17_19_58.pdf). It shows how both supply rails are made:

- **5V out** comes from a boost converter (SY7088) fed by the battery, followed by a diode. It is set to about 5.3 V, so after the diode the header sees about **4.9 V**. It is on whenever the Cardputer is switched on, on battery or USB, and the converter can easily supply the 30–40 mA our board needs. It is a *switching* supply, so it carries some high-frequency ripple.
- **The Cardputer's own 3.3 V** comes from a separate switching regulator (SY8089), also fed by the battery. It is set by two resistors to about 3.32 V. It powers the keyboard controller, the audio chip, the motion sensor, the SD card and the I2C pull-up resistors.

The same 3.3 V rail does reach a few physical points, but none of them is on an external connector:

| Where | What it is | Practical? |
|---|---|---|
| Pin 28 ("3V3") of the StampS3A module | The compute module's 3.3 V pin | Possible, but means opening the case and soldering a wire to the module. |
| FPC1, an internal 8-pin ribbon socket | Carries GND, 3.3 V, 5 V, G7, G8 and G9 | A fine-pitch (0.5 mm) ribbon connector inside the case. Hard to use by hand, and it may not be fitted **(check)**. |
| The Grove I2C pull-up resistors (R3, R10) or the SD card supply | Tiny surface-mount parts | Not a sensible place to solder a wire. |

I did not find anyone online who has tapped 3.3 V out of the ADV for an add-on.

#### Options for a clean 3.3 V

1. **Regulator on the Cap, fed from 5V out (recommended).** A low-noise linear regulator (LDO) cleans up most of the boost converter's ripple. Its input-to-output headroom is about 1.6 V, which is plenty. Add a ferrite bead and a 10 µF capacitor on the input to block the switching noise the regulator lets through at high frequency.
2. **Tap the Cardputer's own 3.3 V.** This saves one part but is worse on every count: it means opening the case, it is a switching supply shared with the SD card, audio and keyboard, and its accuracy depends on M5Stack's resistor tolerances.
3. **Make the GSR reading independent of the supply.** See the next section. This could be combined with option 1 or option 2.

#### Making the bias voltage stop mattering

- **Measure the bias instead of assuming it (firmware, already done).** See "Why the regulator matters more than usual" above. This corrects a supply that is off by a fixed amount, on the Flipper as well. It does not follow drift during a recording, as it is measured only at the start.
- **Feed the bias divider from a voltage reference chip (hardware, not done).** A small precision reference IC (for example a 2.5 V or 3.0 V shunt reference) powers only the 56 kΩ / 10 kΩ divider. The bias then stays fixed whatever the supply does, during a recording too. One extra part, and the divider values change to keep 0.5 V. Only worth it if the resistor-grid test shows drift on a real device.

High-frequency switching ripple matters less than slow drift. The amplifier's 47 kΩ / 100 nF feedback forms a roughly 34 Hz low-pass filter, and the ADS1115's own digital filter rejects fast noise as well. What really affects accuracy is the DC level of the bias, which the measurement corrects, and slow drift during a recording, which a steady regulator keeps small.

#### Current draw and battery life

These are estimates from the datasheets, not measurements.

| Part | Normal | Short peaks |
|---|---|---|
| SAM-M10Q, finding satellites | about 15–20 mA | up to about 40–50 mA |
| SAM-M10Q, with a fix | about 10–12 mA | — |
| ADS1115, op-amp and bias divider | about 1–2 mA | — |
| **Our board in total** | **about 15–25 mA** | **about 50 mA** |

The regulator is a linear type, so it draws the same current from 5V out as it gives at 3.3 V. M5Stack is said to advise keeping the whole device under about 1 A (this comes from a Reddit post, not an official spec). The Cardputer itself uses about 120–155 mA, so our board takes only a few percent of what is left. Unlike LoRa or nRF24 radios, which pull about 490 mA when they transmit, a GPS only listens, so it has no big current spikes.

**Battery life.** The boost converter turns the battery's 3.7 V or so into 5 V and loses some power doing it, so our 25 mA costs about 35–40 mA from the battery. Added to the Cardputer's own 120–155 mA, that is about 160–195 mA in all. On the 1,750 mAh battery this gives very roughly **8–10 hours** of recording, probably a little less with the screen on and Bluetooth streaming. To check it on a real device, put a USB power meter in the charge port and compare with and without the board fitted.

#### Header pin numbers

The schematic and the online pin table number the EXT header differently. The schematic counts 1–7 down one side and 8–14 down the other; the online table alternates sides. The schematic also labels G13 "GPS-RX" and G15 "GPS-TX" (meaning they connect to the GPS module's RX and TX), which suggests the header was designed with a GPS in mind. **Wire by signal name (5VOUT, GND, SDA, SCL, G13, G15), not by pin number,** and confirm with a multimeter before connecting anything.

### Things to check on the hardware

- **Power budget.** A community wiki warns that drawing too much current through EXT can make the Cardputer reset. GSR and GPS together should be well within limits, but measure the M10Q's current while it is first finding satellites.
- **Component height.** Tall parts stop a Cap sitting flat. Use low-profile parts or a taller header.
- **Which way up it is carried.** The GPS antenna sits on the back board, so it faces the sky only when the Cardputer is carried screen-down, and then the screen can't be seen while walking. This is an open problem to solve before boards are ordered. See "For people using the device" in section 6.
- **Supply noise.** The ESP32's radio and power supply are noisier than the Flipper's. The existing 100 nF capacitor across the op-amp supply ([wiring_guide.md](wiring_guide.md)) is still needed, and may not be enough. Compare recordings against the Flipper before trusting the new device.

---

## 3. Software: the overall approach

The Flipper app is about 7,400 lines of C written against the Flipper's own system library. That library does not exist on the Cardputer, so the code cannot run as it is.

But much of it is not really about the Flipper. The signal processing, the CSV format, the GPS setup commands, the GSR gain rules and most of the session logic are plain calculations. Only the parts that touch hardware (threads, the serial port, I2C, files, Bluetooth, the screen, the LED) are Flipper-specific.

### The approach: one shared core, one folder per device

Everything stays in this repo, inside `firmware/`, split into three folders:

```
firmware/
  application.fam      ← stays here; the Flipper build still runs from firmware/
  core/                ← shared plain C, no device code at all
  flipper/             ← Flipper-only code
  cardputer/           ← Cardputer project (PlatformIO)
  vendor/minmea/
  tests/
```

- **`core/`** holds code that works things out but never touches hardware:
  - signal processing and the CSV format (already free of Flipper code today)
  - GPS logic: building the M10Q setup commands, reading its replies, the standby rules
  - GSR logic: gain switching, settling, converting to nanosiemens
  - session logic: start and stop, what each second does, building rows, which events happen
  - the screen layout, drawn through a small drawing interface
- **`flipper/`** holds what only the Flipper has: the app entry point, threads, the serial port, I2C, the SD card, Bluetooth, the LED and sounds, and all of the radio (EM) scan code.
- **`cardputer/`** holds the same kinds of parts, written for the ESP32.

### How the shared code talks to each device

- **The shared code never runs threads, and normally never waits.** It works step by step: "here is a new reading, update yourself", "here are the GPS bytes that arrived", "one second has passed".
- **One exception: the GPS start-up and sleep sequences.** These are timed by nature. For example: send at 9600 baud, wait 200 ms, switch to 115200, wait 50 ms, send the sleep command ([gps_uart.c](../firmware/core/gps_uart.c)). This sequence is confirmed on real hardware, and rewriting it as a step-by-step machine would risk breaking it. So the shared code may ask the device for "the time now" and "wait N ms", but only in these sequences. They already run on the main thread.
- **Two smaller waits in the GSR code.** When the GSR sensor starts, it checks the chip is there and reads the 0.5 V bias (about 25 ms). And the bias check at the start of a recording waits up to 200 ms for the GSR thread to finish it. Both waits were already there on the Flipper; they now ask the device to wait.
- **One wait in the session code.** After the recording-start sound, the session waits 200 ms so the GSR readings taken during the sound have left the buffer before the first row. Also already there on the Flipper.
- **Each device runs its own loop and threads** and feeds the shared code. Both devices keep the same two-thread design: a main thread and a GSR thread. The GSR thread just calls the shared "one pass" function in a loop, with a 1 ms pause after each pass.
- **Each device supplies a few small functions:**
  - I2C: read or write a register
  - serial port: send bytes, change speed
  - file: open, write, close
  - screen drawing: about 6–8 basic drawing calls (lines, boxes, text and so on)
  - a clock, and a wait (for the GPS sequences and the GSR waits above only)
  - a lock, so the main thread and the GSR thread take turns on the GSR readings. The shared code never runs a thread itself, but its data is shared between two of them.
  - optionally, writing a log line
  - stopping with a message when a rule is broken, such as a missing pointer (the Flipper crashes with the message)
  - responding to a named event such as "recording started" or "write error"

### Why not the other ways

- **A separate copy of the firmware for the ESP32.** The two copies would drift apart. Every fix would need making twice, and sooner or later one would be forgotten.
- **A fake Flipper library on the ESP32** (rewriting the Flipper's own calls for the ESP32 and compiling the Flipper app unchanged). This is tempting, because the host tests already fake the Flipper this way ([firmware/tests/shims/](../firmware/tests/shims/)). But the screen, keys and notifications don't map well, and the Cardputer code would be shaped around Flipper ideas forever.

With a shared core, each device has its own small, natural code, and the shared part is written and tested once. The shared code can be tested on a computer without the fake Flipper headers, because it contains no device code.

### Build tools

- **Flipper.** `application.fam` stays in `firmware/` and lists the files it needs from `core/` and `flipper/`. It already lists its files one by one, so the Flipper build ignores the Cardputer files. `ufbt` is still run from `firmware/`.
- **Cardputer.** PlatformIO with the Arduino setup:
  - M5Stack's own libraries for the screen, keyboard and SD card work there directly.
  - Its clock counts in 1 ms steps. The GSR thread pauses for 1 ms between readings. With the default 10 ms steps in Espressif's own toolkit (ESP-IDF), that pause would round down to nothing, the thread would never really rest, and the watchdog would restart the device. The bench program ([cardputer_bench](../firmware/cardputer_bench/)) confirms the Arduino setup works this way: with a 1 ms pause it reads the ADS1115 about 900 times a second.
  - The shared C code builds unchanged.

  The alternative is ESP-IDF itself. It is cleaner but more work to set up the screen and keyboard.

### Can the Cardputer run the threads?

Yes, easily. The Flipper runs the main thread, the GSR thread and its own Bluetooth on a single 64 MHz core with 256 KB of RAM. The Cardputer ADV's ESP32-S3 has two 240 MHz cores and 512 KB of RAM. It has no extra PSRAM memory chip (confirmed on the bench), but it doesn't need one. Points to get right:

- **The 1 ms pause** described under "Build tools".
- **The shared I2C bus.** The GSR converter shares a bus with the keyboard and audio chip (see section 2), so the two threads take turns on it. M5Stack's I2C driver already makes them take turns, one read or write at a time, so we add no lock of our own. The GSR code already takes and releases the bus around each read and write; on the Cardputer that step just calls M5Stack's driver.
- **GPS can stay on the main thread.** The ESP32's serial driver stores incoming bytes by itself, so the main loop can collect them each pass. A separate GPS thread would also be fine.
- **Stack sizes.** ESP32 library calls need more stack than the Flipper's. Give each thread about 4 KB instead of 2 KB.

### Gotchas for the Cardputer code

None of these stops the port, but each would cause a confusing fault if missed.

- **Bluetooth message size.** Each live packet is 49 bytes ([bt_stream.h](../firmware/modules/bt_stream.h)). By default, ESP32 Bluetooth sends only 20 bytes per message. The Cardputer must ask for bigger messages when a connection opens. Otherwise packets arrive cut short and the Live tab shows nothing. It must also use the same service and characteristic IDs that the visualiser looks for (see "Bluetooth" in section 4).
- **One I2C driver, not two.** M5Stack's own library already uses the I2C bus for the keyboard and audio chip. If the GSR code opens the same pins through a second, separate driver (such as Arduino's `Wire`), the two fight over the bus and readings go wrong at random. The GSR code must go through the same driver as M5Stack's library.
- **Keep the GPS serial port open all the time.** A sleeping M10Q wakes on any signal on its receive wire. On the Flipper, letting go of the port left that wire floating, and the module woke within seconds ([gps_uart_flipper.c](../firmware/flipper/gps_uart_flipper.c), [gps_sleep_investigation.md](../research/archive/gps_sleep_investigation.md)). The Cardputer must do what the Flipper does: open the port when the app starts and hold it until the app exits.
- **C-only features in shared headers.** The Arduino setup compiles its own code as C++. [bt_stream.h](../firmware/modules/bt_stream.h) uses `_Atomic`, a C-only feature that C++ cannot read. Keep such details inside `.c` files, so every shared header can be read by both. Shared headers also need the usual `extern "C"` wrapper.
- **The 1 ms pause.** See "Build tools" above.

---

## 4. Software: piece by piece

| Part | Current files | Shared in `core/` | Written for each device | Size |
|---|---|---|---|---|
| Signal processing, CSV format, settings | `biomap_pipeline.c`, `biomap_format.c`, `biomap_config.h`, minmea | All of it. Already free of Flipper code. | Nothing | Small (a move) |
| GSR sensor | `gsr_sensor.c` | ADS1115 gain switching, settling rules, conversion to nanosiemens, the zero reading from the calibration wizard's Zero step, and the 0.5 V bias check at the start of each recording (written to the `# GSR Bias` header line) | The GSR thread and the I2C read/write | Small |
| GPS | `gps_uart.c` | M10Q setup commands, reading its replies, speed change and standby/wake rules, parsing (minmea) | Sending bytes and collecting the bytes that arrive. The Flipper gets them one at a time from an interrupt; the ESP32's serial driver stores them for the main loop. | Medium |
| Session | `biomap_session.c` | Start and stop, what each second does, building CSV rows, which events happen | The main loop, locks and screen refresh | Medium |
| Notifications | `biomap_session.c`, `biomap.c` | Named events ("recording started", "GPS fix", "write error"), including the rules about when sounds may play | The response: LED and sounds on the Flipper, beeps on the Cardputer (no vibration motor) | Small |
| Screen | `biomap_render.c` (~1,000 lines) | The current screen layout, drawn through 10 basic drawing calls. The recording screen is done (step 6, `core/biomap_screen.c`); the menus wait for step 10. | Those drawing calls, stretched to fit the screen, using the same fonts. See below. | Medium |
| Keys and menus | `biomap_gui.c` | Possibly the menu logic | Reading keys | Small to medium |
| SD card | `sd_logger.c` | Batching rows, the `# End` check line, file names, whole-block writes (done, step 8: `core/sd_logger.c`) | Opening, writing and closing files. The Cardputer writes in whole 512-byte blocks (see "SD card pauses" in section 5). | Small |
| Bluetooth live stream | `bt_stream.c` (~180 lines) | Packet format (already shared) | The Bluetooth code. The bench used Arduino's standard Bluetooth library with the message size raised to 52 bytes, which is enough; NimBLE would also work. | Medium |
| Clock | `biomap.c` | | Reading the time. See below. | Small code change, but it changes how the device behaves |
| EM scan | `em_scan_rf.c`, `em_scan_cal.c`, `em_scan_sampler.c`, `biomap_rf_cal.c` | Nothing | Stays in `flipper/` only | None |
| Flipper-only extras | `biomap.c` | | The "expansion" calls stay in `flipper/` | None |
| Build setup | `application.fam`, `run_tests.sh` | | `application.fam` lists files from `core/` and `flipper/`. A new PlatformIO project in `cardputer/`. | Small |

### Bluetooth: no visualiser change needed

The visualiser's Live tab finds the Flipper by the Flipper's Bluetooth serial service IDs ([live_bluetooth.mjs](../visualiser/src/live/live_bluetooth.mjs)). It already lists every nearby device rather than filtering by the name "Flipper". If the Cardputer advertises the same service and characteristic IDs and sends the same packet format, the Live tab will connect to it without changes. It must also allow messages of at least 49 bytes (see "Gotchas" in section 3).

Those IDs have not yet been checked against a real Flipper either (see the note in [live_bluetooth.mjs](../visualiser/src/live/live_bluetooth.mjs)). Whatever IDs the Flipper turns out to use, the Cardputer should copy them.

### Screen and keys

The screen code uses only about 10 drawing calls (text, lines, boxes, dots, fonts, invert). There are two routes:

- **Quick route.** The screen layout moves into `core/` and draws through a small drawing interface. The Cardputer supplies those calls and stretches every position to fill its screen. It comes almost for free once the layout is shared.

  Simple doubling does not fit: 128×2 is 256 pixels, but the Cardputer screen is only 240 wide. Because the layout draws with calls such as "line from here to there" and "text at this spot", not ready-made pixels, the Cardputer can instead stretch each position by 240/128 (about 1.9) and draw lines and boxes with its own pen.

  Text needs care. The layout measures text widths in 11 places to position things, using the Flipper's two fonts. Those fonts come from u8g2, a common font collection, and M5Stack's screen library can use u8g2 fonts too. Using the same font files keeps every width identical, so nothing moves or overlaps. Text drawn this way stays at its Flipper size unless the font is drawn larger.
- **Redesign.** Lay out the screens again for a colour 240×135 display, in `cardputer/` only. It looks much better, but it is the largest single task in the port.

Recommendation: do the quick route first and redesign once everything else works.

The app uses the Flipper's six buttons: Up, Down, Left, Right, OK and Back. They map naturally onto the Cardputer's arrow keys, Enter and Esc.

### The clock

The Flipper keeps the time when switched off. The Cardputer ADV has no battery-backed clock chip (confirmed on the bench), so it loses the time when powered down.

The firmware reads the clock in one place ([biomap.c](../firmware/biomap.c)), so the code change is small. The real effect is on behaviour: the time has to come from the GPS. That means:

- a recording started before the first GPS fix has no correct wall-clock time
- the file name and the session start time may need to be set, or corrected, once GPS time arrives

The M10Q gives accurate time with its first fix, so in practice this is a short delay at the start of a walk. **Decided: the time and date come from the GPS.** Still to choose: "don't start recording until GPS time is known", or "start anyway and fix the timestamps later".

### GSR reading speed (later, not part of the first port)

The ADS1115's top speed is 860 readings a second, and it already runs at that speed on the Flipper. But the Flipper only collects some of them: often about 300 a second, at best 400–500 (the `gsr_hz` column). Its loop can only pause in whole milliseconds, and the rest of the app takes its share of the single slow core.

The Cardputer could collect nearly all of them, in one of two ways:

- **A precise timer.** The ESP32's hardware timers are precise to a microsecond, so the GSR thread can read about every 1.2 ms instead of every "1 ms" step. That gives roughly 800 readings a second, almost all of them new. It is not perfect: the ADS1115's own clock can run up to 10% slow, so now and then a reading is missed or read twice. The existing duplicate counter already detects this. No hardware change is needed.
- **The ADC's "ready" pin.** The ADS1115 pulses its ALERT/RDY pin each time a new reading is ready. Waiting for that pulse gives exactly 860 a second, none missed, none read twice. The Cardputer board (rev C and later) connects this pin to EXT pin 3 (G4) through the flex tail. The pin can only pull the line low, so the firmware must turn on G4's internal pull-up, and must switch the ADC's ready mode on (top bit of Hi_thresh set, top bit of Lo_thresh clear).

**What it would gain.** Each CSV row averages 100 ms of readings. More readings in that window reduce the ADC's own random noise: going from about 300 to about 800 a second cuts it by roughly 40% (√(800/300) ≈ 1.6). The gain on noise from the skin and the amplifier is smaller, because the amplifier's filter (about 34 Hz) already smooths out quick changes, so readings taken close together are mostly the same reading. The skin signal itself changes over seconds, so nothing in it is missed at the slower rate.

**Why it waits.** The side-by-side walks (section 5) are meant to show that the two devices give the same results. If the Cardputer reads at a different rate from the start, any difference is harder to explain. So the first port uses the same reading code as the Flipper, with its 1 ms pause. Its rate may still differ from the Flipper's, but `gsr_hz` records it in every file, so the difference can be seen. Expect more repeated readings than on the Flipper. The faster ESP32 may get round the loop close to 1,000 times a second, but the ADS1115 only makes 860 new readings a second, so at least 1 in 7 reads (about 14%) will fetch a reading already taken. That is harmless: a repeat counts that reading twice in the 100 ms average, which wastes a little of the averaging but doesn't push the result up or down. The duplicate counter in [gsr_sensor.c](../firmware/core/gsr_sensor.c) shows the rate (7–11% on the Flipper). Once the two devices agree, try the precise timer as a separate test, and compare noise on the resistor-grid test before and after. If it is worth having, switch to the ready pin, which the board already wires to G4.

### Getting recordings off the SD card: USB drive and Wi-Fi Files

Popping the microSD card out of the Cardputer ADV after every walk is fiddly, and the old serial `ls`/`cat` commands needed a terminal script. Two ideas from [pocket-wui](https://github.com/AFetisa/pocket-wui) (MIT licence, built for the Cardputer / ESP32-S3) solve this cleanly:

1. **Built-in USB thumb drive mode (done in [`sd_cardputer.cpp`](../firmware/cardputer/src/sd_cardputer.cpp)).**
   - The ESP32-S3's native USB port (`ARDUINO_USB_MODE=0` with `ARDUINO_USB_CDC_ON_BOOT=1`) presents both the serial log (`USBCDC`) and a USB Mass Storage drive (`USBMSC`) over the same USB-C cable.
   - While BioMapping owns the card, `mediaPresent(false)` tells the computer the drive slot is empty.
   - Pressing **`U`** (whenever not recording) lends the card to the computer (`mediaPresent(true)`), forwarding raw 512-byte sector reads and writes through `SD.readRAW()` and `SD.writeRAW()`. The card appears in Finder / Explorer as a normal USB drive with all `.csv` files in `biomapping/`.
   - **Why lending is triggered by `U` rather than automatic whenever a session ends (`Esc`):** if the drive mounted on the computer every time `Esc` was pressed, starting a new session on the Cardputer without ejecting on the computer first would yank the mounted disk away and trigger a macOS *"Disk Not Ejected Properly"* warning (or risk FAT corruption if the computer was writing spotlight/trash metadata). With `U`, lending only happens when asked for, and **Enter** refuses to start a recording while the computer has the card.
   - When the user clicks **Eject** on the computer (detected via `onStartStop` with `!start && load_eject`), unplugs the USB cable for 3 seconds, or presses **`U`** twice within 3 seconds on the Cardputer (the first press only warns `Eject on computer first!`, because taking the card while the computer has it open can lose changes the computer hasn't written yet), the firmware sets `mediaPresent(false)`, waits under a mutex for any in-flight USB sector read or write to finish, and calls `SD.end()` + `SD.begin()` so FatFs drops its cached directory sectors and sees any files deleted or changed on the computer.

2. **Wi-Fi Files plan (for phones, tablets, or workshops without a USB cable).**
   - **Rule: Wi-Fi must never run during a recording or session.** The ESP32's Wi-Fi transmitter draws sharp current bursts (hundreds of mA) right next to the GSR front-end and drains the battery quickly. Wi-Fi must stay completely off (`WiFi.mode(WIFI_OFF)`) at boot and throughout every recording session.
   - **Option A — Separate app via M5Launcher (zero firmware work):** install [M5Launcher](https://github.com/bmorcelli/M5Stick-Launcher) on the Cardputer and keep both `BioMapping.bin` and a pre-built `PocketWUI.bin` from [pocket-wui Releases](https://github.com/AFetisa/pocket-wui/releases) on the SD card. Reboot into PocketWUI whenever full browser file management, WebDAV, or USB drive mode is wanted.
   - **Option B — Built-in "Wi-Fi Files" screen (step 13 / after step 10's menu):**
     - Add a **Wi-Fi Files** item on the main menu (only reachable when no recording session is open).
     - Entering **Wi-Fi Files** turns Wi-Fi on as its own hotspot (for example `BioMapping-XXXX`, or joins a saved workshop Wi-Fi network from a small config file on the SD card) and shows the web address (`http://192.168.4.1`) and a QR code on the Cardputer screen.
     - A small built-in web page lists the `.csv` files in `/sd/biomapping/` with:
       - One-tap download for any single `.csv` file.
       - **"Download all as ZIP"**, borrowing [`pocket-wui`'s `src/zipstream.h` and `src/zipstream.cpp`](https://github.com/AFetisa/pocket-wui/blob/main/src/zipstream.cpp) (~220 lines of standalone C++ that stream an uncompressed Store-mode `.zip` archive straight from the SD card over HTTP with CRC-32 data descriptors, using zero extra RAM or temporary SD space).
       - Optional delete button for clearing old walks after downloading.
     - Pressing **Esc** to leave the **Wi-Fi Files** screen stops the web server and calls `WiFi.softAPdisconnect(true)` and `WiFi.mode(WIFI_OFF)` before returning to the main menu, so the radio is guaranteed off before any GSR session can start.

### CSV format

Nothing needs to change. The `GPS+GSR` format (11 columns) already exists and is documented in [csv_schema.md](csv_schema.md). The visualiser already handles files without the RF columns, because the EM features only switch on when those columns are present.

---

## 5. Testing and validation

The firmware has been through a lot of real-hardware fixes. The logic carries over, but timings depend on the hardware, so each fix needs re-checking on the new device. The main ones:

- **GSR accuracy.** The published accuracy figures in the README come from a resistor-grid test on the Flipper. That test should be repeated on the Cardputer before the same accuracy is claimed.
- **ADS1115 gain-switch settling.** Check that readings taken just after a gain change are still being held back correctly.
- **M10Q standby and startup.** Check that the M10Q still powers down and wakes correctly.
- **Bench noise tests: laptop on battery, one device on USB.** A laptop on its charger leaks mains hum onto its USB ground. With a MacBook on its charger, a 1 MΩ resistor jittered by about 18 nS instead of under 1 nS; unplugging the charger cured it. Plug only one device into the laptop at a time. Still to check: whether charging the Cardputer from a wall charger during a recording does the same.
- **Noise from sound and Bluetooth.** The Flipper code already waits after a tone before trusting GSR readings again (`GSR_TONE_SETTLE_MS`), so the speaker affects the reading even there. On the Cardputer, sound goes through an audio chip and amplifier, and Bluetooth comes from a different radio. Measure both, and check whether that wait is still long enough. Live Stream mode, with Bluetooth sending all the time, matters most.
  - **Done on the bench (prototype board):** Bluetooth sending a Live Stream packet every 300 ms, every backlight level, and the recording-start chirp had no effect on the GSR reading. The chirp test was compared against the same measurement with no sound; both settled within the same time (about 2.9 nS of normal wander), so the 200 ms wait is long enough on the Cardputer.
  - **Still to do:** the keyboard and the GSR thread sharing the I2C bus (needs the real firmware, step 8), and the Cardputer's own 5 V supply feeding the board's regulator (needs the first printed board; the bench board ran from the Flipper's 3.3 V).
- **SD card pauses.** On the Flipper, writes to the card pause the main thread for 20–60 ms. The ESP32 will have its own pauses. No data is lost, because the GSR thread is separate, but measure the timings again. Both devices reserve 8 MB of file space at the start of a recording ([sd_logger.c](../firmware/core/sd_logger.c)).
  - **Measured on the bench** (about 12 KB every 10 s, the size of one batch): plain writes 34 ms typical / 87 ms worst; with 8 MB reserved 24 / 40 ms; reserved plus writes of exactly 24 whole 512-byte blocks 15 / 57 ms; the same at 40 MHz instead of 25 MHz 14 / 16 ms. The first write after the card is mounted can take about 300 ms once.
  - **For the Cardputer firmware:** reserve the space and write whole 512-byte blocks, carrying any leftover bytes into the next batch. This stays in `cardputer/`, so the Flipper is unchanged. The faster 40 MHz card speed only helps the worst case and is optional. SD writing did not change the GSR noise.
- **Side-by-side walks.** Record the same walk with both devices worn together. Load both files into the visualiser and compare the GSR traces and GPS tracks.
- **Host tests.** The shared code in `core/` is tested on a computer once, for both devices, without fake Flipper headers. The existing tests of the Flipper-only parts keep using `tests/shims/`.

---

## 6. Implications

### For people using the device

- **Carried screen-down.** The GPS antenna on the back board has to face the sky, so the Cardputer is carried with its screen facing down, where it can't be seen while walking. This is the main drawback of the current board design. Options: test real walks face-up against face-down first (the bench program shows the strongest GPS signal and the satellites used, to compare), use a phone as the screen through the Live tab, or move or turn the GPS so it faces the same way as the screen.
- **Easier to read.** A colour screen with more room makes status (GPS fix, signal quality, recording time) clearer.
- **Typing in the field.** The keyboard opens up something the Flipper can't do: typing short notes during a walk ("loud lorry", "crossed the main road"). This fits the project's aim of annotating data together. It is a possible later feature, not part of the port.
- **Battery.** The battery is larger, but the ESP32 draws more power than the Flipper's chip. Battery life needs measuring, not assuming.
- **Less awkward to carry.** The Flipper Zero is known as a "hacking tool". It has faced customs seizures and proposed bans in some countries. The Cardputer looks like an ordinary gadget, which makes travelling with it and handing it to workshop participants simpler.

### For workshops and other builders

- **Cost.** A Cardputer ADV costs much less than a Flipper Zero, which matters when equipping a group.
- **Building many devices.** A single plug-on Cap, especially as a printed board, is quicker and more reliable to build in quantity than wiring onto a Flipper prototyping board.
- **Installing the firmware.** On the Flipper, you copy a `.fap` file to the SD card. On the Cardputer, firmware is usually flashed over USB from a computer. Community launcher apps can load firmware from the SD card, but that adds a step. The README's Quick Start would need a Cardputer section.

### For the data

- **Same sensors, same format.** Recordings from the two devices should be directly comparable, but only once the side-by-side tests in section 5 confirm it.
- **No EM data.** Walks recorded on the Cardputer have no RF columns, so the EM Fog and RF views in the visualiser stay empty for them. Mixing Flipper and Cardputer walks in a collective map works, but the EM layer only covers the Flipper walks. If EM is wanted later, M5Stack sells a Cap with the same CC1101 radio chip, though it takes the whole back of the device.

### For maintaining the code

This is the biggest long-term decision:

- **Replace the Flipper.** One firmware to maintain. EM scanning is lost.
- **Keep both.** Two firmwares that share `core/` (section 3), each with its own device folder. Any fix to the shared core reaches both devices. Device-specific fixes (serial port, screen, Bluetooth) are made twice.

The folder layout works either way. If the Flipper is retired later, `flipper/` is simply deleted.

---

## 7. Suggested order of work

The Flipper keeps working after every step. The host tests run after each step, and the steps marked "Flipper check" need a test on a real Flipper.

Steps 1–6 prepare the shared core on the Flipper. They also tidy the Flipper code, so they are worth doing even if the port stops there. Section 9 tracks their progress.

| # | Step | Result |
|---|---|---|
| 1 | Create the folders. Move the files that are already plain C (signal processing, CSV format, settings, minmea). Fix `application.fam`, `run_tests.sh` and the test paths. | Same Flipper app, new layout |
| 2 | Move the GSR logic into `core/`, including the Zero step's reading and the bias check at recording start. The smallest real step. | Flipper check |
| 3 | Move the GPS logic into `core/`. The risky part is the standby/wake sequence, which has been confirmed on real hardware. | Flipper check |
| 4 | Named events instead of LED patterns, with sounds included. | |
| 5 | Split the session into shared logic plus the Flipper loop. | Flipper check |
| 6 | Make the screen layout shared, drawn through the small drawing interface. | Flipper check |
| 7 | Start the Cardputer project: it builds `core/`, shows something on screen and reads keys. | First Cardputer code |
| 8 | Cardputer: GSR to SD card, written in whole 512-byte blocks. Compare a recording with the Flipper, and check typing doesn't disturb the GSR. | A useful device |
| 9 | Cardputer: GPS, plus the clock rule from section 4. | A GPS+GSR logger |
| 10 | Cardputer: screen (quick route) and keys. | |
| 11 | Cardputer: Bluetooth live stream. Test the visualiser's Live tab. | Done (see section 9) |
| 12 | The resistor-grid test and side-by-side walks (section 5). | Trusted results |
| 13 | Later, optional: faster GSR reading (section 4), Wi-Fi Files screen with streaming ZIP download (section 4), redesign the screen, add a printed Cap, add field notes. | |

---

## 8. Open decisions

- Replace the Flipper, or keep both devices?
- Screen: quick route first, or go straight to a redesign?
- Clock: the time comes from the GPS (decided). Still open: block recording until GPS time is known, or fix the time afterwards?
- Carrying: how to see the screen while the GPS antenna faces the sky (see section 6)?
- Electronics: buy a ready-made proto board, or build a home-made Cap?
- ~~Which device to bring up first at step 7: the Cardputer ADV or the CardputerZero (see section 10)?~~ Decided: the Cardputer ADV only, for now.

---

## 9. Preparing the Flipper code (work done so far)

Before starting the port itself, the Flipper firmware is being reshaped so that more of it can be shared. Each step keeps the Flipper working exactly as before.

### Step 1 done: `core/` folder created

The plain C files moved to [firmware/core/](../firmware/core/): `biomap_pipeline.c/.h` (signal processing), `biomap_format.c/.h` (CSV format and the calibration fit), `biomap_config.h` (settings) and `biomap_types.h` (the shared data types, which the others need). `application.fam`, `run_tests.sh`, the test files and the links in the docs point to the new places.

- **One small code change.** `biomap_format.c` still used the Flipper's warning-log call when a calibration fit failed. That log line now lives in the Flipper code that calls the fit ([biomap_gui.c](../firmware/biomap_gui.c)), so `core/` has no Flipper code at all. Its test build no longer needs the fake Flipper headers.
- **minmea stays in `vendor/minmea/`**, as in the folder plan above. It is already plain C, and third-party code is easier to update where it is.
- **No `flipper/` folder yet.** Git cannot store an empty folder. The Flipper files move into it as steps 2–6 split each one. (Step 2 created it.)

Checked: all host tests pass, the Flipper app builds, and each `core/` file builds on its own with no other folders on the include path. Nothing changed in how the app behaves, so no Flipper check is needed.

### Already done: radio scan out of the GSR code (checked on a real Flipper, see below)

The radio (EM) scan used to be written into the middle of the GSR sensor code ([gsr_sensor.c](../firmware/core/gsr_sensor.c)). It now lives in its own file, [em_scan_sampler.c](../firmware/modules/em_scan_sampler.c). It still runs on the GSR thread, at the same moments as before. No new thread was added. The GSR loop has one line that says "if there is another job, give it a turn". On the Flipper the session hands it the radio scan. On the Cardputer nothing is handed over, so the GSR code contains no radio code at all.

**To check on a real Flipper:** run an EM mode for a minute, check that the radio bars move, then leave the mode and check that the app exits cleanly.

**Known weak points, left as they are for now:**

- **The order things are freed in matters, and only a comment says so.** The GSR sensor must be freed before the radio sampler, because the GSR thread calls into the sampler. Today there is one place that does this, and it does it in the right order. If someone gets it the wrong way round, the device could crash at random.
- **An older gap came across unchanged.** If turning the radio off takes too long (more than 100 ms) and the radio is turned straight back on, the start-up could overlap the radio's last reading. The app never does this today: the radio is only turned off once, at the end of a session. The fix would be a short wait before turning it back on. This is noted in the code.
- ~~**The screen can read the module pointers while a session is starting.**~~ Fixed in step 5: the session now sets all the module pointers together, with the main lock held.
- **The radio sampler's tests sit inside the GSR tests** (`test_gsr_sensor.c`), not in a file of their own.
- **This step alone does not make the code run on the Cardputer.** The GSR code still used the Flipper's own I2C calls (fixed by step 2 below), and the session and screen code still include the radio modes (steps 5 and 6).

### Step 2 done: GSR logic in `core/` (checked on a real Flipper, see below)

All of the GSR logic now lives in [core/gsr_sensor.c](../firmware/core/gsr_sensor.c): gain switching, the settling waits, the bias check, the 100 ms averaging, the conversion to nanosiemens, the calibration zero and gain, disconnect detection, and every diagnostic figure. It has no Flipper code. It reaches the hardware only through a short list of functions the device hands it ([core/gsr_sensor.h](../firmware/core/gsr_sensor.h), `GsrPlatform`): read or write an I2C register, the time in milliseconds, a wait, a lock, and an optional log line.

The calibration wizard's averaging is shared too: `CalDwell` in [core/biomap_format.c](../firmware/core/biomap_format.c). It takes each tick's reading over the 20 s dwell, keeps the ones inside the gate, and gives the mean, the spread (σ) and whether enough readings passed. The Zero step and each resistor step use it. What stays in the Flipper's wizard ([biomap_gui.c](../firmware/biomap_gui.c)) is the screens, the keys, the countdown and the 100 ms waits between readings. Those were two near-identical loops, one per kind of step; they are now one (`calibration_wizard_dwell()`). That loop is Flipper code, so the host tests don't run it; the wizard run in the Flipper check below covers it.

Not moved in this step: the few lines that choose which bias value goes in a recording's `# GSR Bias` header line. The bias check itself is shared, but that choice sits in the middle of building the file header in [biomap_session.c](../firmware/core/biomap_session.c), so it moves with the session in step 5. (Done in step 5.)

The Flipper side, [flipper/gsr_sensor_flipper.c](../firmware/flipper/gsr_sensor_flipper.c), is about 150 lines: those functions written with the Flipper's own calls, and the GSR thread. The thread calls the shared "one pass" function, gives the radio scan its turn after each normal read, and pauses 1 ms, exactly as before. The rest of the app calls the same `gsr_sensor_*` functions as before: one `#include` changed, and one diagnostic read-out was renamed (below).

A new [core/core_check.h](../firmware/core/core_check.h) gives the shared code a way to stop on a broken rule (a missing pointer). Each device supplies the stop; the Flipper's is [flipper/core_fatal.c](../firmware/flipper/core_fatal.c), which crashes with the message as `furi_check` did.

Checked:

- All host tests pass, including the 47 GSR tests and their ThreadSanitizer run. The GSR tests were not changed (apart from one `#include` and one renamed read-out, below), and they now run the shared code through the real Flipper side, so they show the behaviour is the same.
- Raising one gain-switching number in the shared file makes a GSR test fail, so the tests really reach the moved code.
- Three new tests cover the wizard's averaging. One replays the wizard's previous averaging code on 50 runs of made-up readings and checks the shared version gives exactly the same numbers, to the last bit. Moving one gate edge by a hair makes a test fail.
- `run_tests.sh` now compiles every `core/` file with no fake Flipper headers available, so Flipper code can't creep back in.
- `run_tests.sh` also builds a small C++ program against every `core/` header and links it to the C-compiled `core/` files, as the Cardputer's Arduino code will. This found that the step 1 headers (`biomap_format.h`, `biomap_pipeline.h`) lacked the `extern "C"` wrapper; they have it now. Taking the wrapper out again makes the check fail.
- The Flipper app builds with no warnings.

Small differences, none expected to show:

- **The I2C bus is taken and released around each single read or write.** Before, the start-up code held it across the first read and the bias set-up write. Nothing else uses that bus on the Flipper.
- **The I2C peak time now includes any wait for the bus**, because taking the bus is inside the timed call. On the Flipper nothing else waits for that bus, so the figure should be the same.
- **The last-sample read-outs start at 0** instead of whatever was in memory, for the moment before the first 10 Hz tick.
- **Stack use on the GSR thread is about the same.** Measured with the Flipper's own compiler: the GSR read path uses 8 bytes more than before; the radio scan path, the deepest, about 80 bytes less.
- **The clock is in milliseconds.** The shared code asks the device for the time in ms, because several figures assume it (the stale-read count, the I2C peak column, the duplicate gap). The Flipper's clock already counts in ms; its GSR start-up now checks this. One read-out was renamed to match: `gsr_sensor_get_duplicate_gap_min_ms()`.
- **The gain-change log line is written after the lock is released**, so on the Cardputer a slow serial log can't hold up the GSR thread.

**To check on a real Flipper:** record for a few minutes with fingers on, and check the GSR value, the gain changes and the `# GSR Bias` line look as before. Run the whole calibration wizard (Zero step and the three resistors) and check the result screen looks as before. Open Diagnostics and check the GSR thread's free stack, worker Hz (~500) and I2C peak. Then run an EM mode for a minute (radio bars move, app exits cleanly), which also covers the radio scan check above.

### Step 3 done: GPS logic in `core/` (checked on a real Flipper, see below)

All of the GPS logic now lives in [core/gps_uart.c](../firmware/core/gps_uart.c): the M10Q set-up commands and checking each reply, the wake-up wait, the sleep sequence at app start and at the end of each session, the speed change to 115200, the chip ID, reading NMEA lines and every sentence's rules, the 5 s watchdog and the reconfigure after it. It has no Flipper code. It reaches the hardware only through the functions the device hands it ([core/gps_uart.h](../firmware/core/gps_uart.h), `GpsPlatform`): set the serial speed, send bytes, start or stop receiving, take the bytes received so far, throw them away, "has the module answered yet?", "please call me again soon", the time in milliseconds, a wait, a lock, and an optional log line.

The timed sequences (wake, speed change, sleep) are kept as waits, in the same order with the same pauses, as section 3 planned. They were confirmed on real hardware, so they were moved, not rewritten.

The Flipper side, [flipper/gps_uart_flipper.c](../firmware/flipper/gps_uart_flipper.c), is about 330 lines: those functions written with the Flipper's own serial calls, the receive interrupt that puts each byte into a buffer and tells the main loop, holding USART1 for the app's whole life (and switching the Expansion Service off meanwhile), and the "idle" byte count that shows whether the module stayed asleep between sessions. The rest of the app calls the same `gps_uart_*` functions as before; only one `#include` changed.

The rule "open the serial port once at app start and hold it until exit" now sits in the shared header too, next to the sleep sequence, so the Cardputer code is told about it where it will look.

Checked:

- All host tests pass. The 39 GPS tests were not changed (apart from one `#include`), and they now run the shared code through the real Flipper side.
- **Old and new side by side.** A throwaway program ran the old and the new GPS code through the same script: app start with a module that answers, a session start with replies to the wake byte and the chip ID poll, NMEA lines, a burst of junk lines, a buffer overflow and its reconfigure, a cold start, the end of the session, the idle count, closing the port, and a session with no port. A second session covered the module accepting one setup command and rejecting another, and the watchdog firing. It printed every byte sent, the speed it was sent at, every status figure and counter after each stage, and every log line (45 of them). The two printouts were identical.
- Two deliberate breaks each made a test fail: moving the watchdog from 5 s to 6 s, and changing one flag bit in the sleep command.
- `run_tests.sh` compiles `core/gps_uart.c` with no fake Flipper headers, and the C++ check now includes the GPS header (minmea is built for it too, as [tests/minmea_host.c](../firmware/tests/minmea_host.c)).
- The Flipper app builds with no warnings.
- **The shared code also builds for the ESP32.** All `core/` files and minmea compile with the Cardputer's own compiler (the one PlatformIO installed for the bench program), with warnings on. minmea's own `timegm()` doesn't clash there: the ESP32's system headers don't declare one. The compiler warned that one counter in the NMEA reader might be used before it is set. That can't happen (the first pass always sets it), but it now starts at 0 so the warning is gone.

Small differences, none expected to show:

- **Log lines go through the shared code's log function.** The text is the same. The "First GSA talker" line is now written just after the lock is released instead of while it is held, so on the Cardputer a slow serial log can't hold up `gps_uart_get_status()`.
- **Main-thread stack, about 120 bytes more at the deepest point** (a reconfigure that logs a missing reply), measured with the Flipper's own compiler. That is the shared code formatting its log line before handing it over. The main thread has 4 KB.
- **The serial port is only shut down if it was started.** Before, the code knew from the order of calls that it always had been; now the Flipper side keeps a flag. Same calls on the Flipper.
- **The watchdog's 5 s is in milliseconds**, as with the GSR clock. The Flipper's clock already counts in ms; the GPS start-up now checks this.
- **The dropped-bytes count is read through the shared code.** It is counted where the bytes arrive (on the Flipper, the receive interrupt), and the shared `gps_uart_get_rx_drop_count()` asks the device for it, so the session can keep writing it to the CSV once it is shared in step 5. It reads 0 when there is no port, as before.

Known weak points, left for later steps:

- **The wake-up wait may not carry over to the Cardputer as it is (step 9).** At app start and each session start, the shared code waits for the first *clean* byte from the module: one with no error flag. A garbled byte can come from a module still starting up, so it doesn't count. The Flipper's serial driver reports an error flag with each byte; the ESP32's Arduino serial driver reports errors through a separate callback, not per byte. If the Cardputer counted every byte, a garbled one could end the wait too early. The speed-change command would then go out before the module listens, the module would stay at 9600, miss the sleep command sent at 115200, and stay awake. To decide at step 9: use the ESP32's error callback to throw away the bytes around an error, or have the shared code judge the byte itself (for example, wait for an NMEA `$`). The second would change the Flipper too, so it would need its own Flipper check.
- **The watchdog only retries once.** After any reconfigure, the watchdog is off until a valid NMEA sentence arrives, so a reconfigure that fails is never tried again. This was already so before step 3, and the code comments say the single recovery is deliberate.
- **The shared GPS code is only tested through the Flipper side.** No test drives it with a plain fake device, so the rules the header sets for each device (for example "never change the serial speed while receiving") are not checked anywhere. Worth adding before step 9.

**To check on a real Flipper:** start the app and check in the log that the module answers the wake byte and that "Idle: GPS silent (stayed asleep)" appears when a session starts. Record GPS+GSR outside for a few minutes: the fix arrives, the position, satellites, hAcc and SBAS look as before, and the `# GPSChipID` header line is filled in. End the session and check the module goes back to sleep (idle count 0 at the next session). Also try Options > Cold Reset GPS once.

### Step 4 done: named events ("cues")

Every moment the device tells the user about, with its LED or its speaker, now has a name in [core/biomap_cues.h](../firmware/core/biomap_cues.h): 20 of them, such as "recording started", "recording stopped but its last seconds are missing", "SD write stopped", "heartbeat", "no GPS fix", and the key clicks. In the code they are called *cues*, so they aren't confused with the main loop's key and timer events. The app's code now says which cue happened; it no longer picks LED patterns or tone pitches itself.

The same header holds the rules about sound, which every device must follow:

1. Light-only cues return at once, so they may be sent anywhere, even with the app's main lock held.
2. A cue with a sound waits until the sound ends (up to about 300 ms), so it must never be sent with the main lock held, or the screen freezes.
3. No sound while a recording is active, because the speaker puts noise on the GSR reading. (So the start sound plays before the recording starts, with a short settle wait after it; stop sounds play once the file is closed; key clicks during a recording are left out; and problems mid-recording, such as fingers off or an SD retry, are light-only.)
4. Every sound obeys Options > Sound, except the Sound toggle itself.

These rules were already followed on the Flipper, but only explained in comments scattered across the session code. They are now in one place for the Cardputer code to read. The code that enforces rule 3 (for example, leaving out the zoom click) is still in the session, and moves with it in step 5.

The Flipper's response to each cue is in one file, [flipper/biomap_cues_flipper.c](../firmware/flipper/biomap_cues_flipper.c): a table of LED patterns and tones. The tones themselves are unchanged in [flipper/sound.h](../firmware/flipper/sound.h) (moved from `modules/`). The Cardputer will write its own version of this one file (beeps, its own light).

Checked:

- All host tests pass, and the Flipper app builds with no warnings.
- **A new test, [tests/test_cues.c](../firmware/tests/test_cues.c),** runs every cue through the Flipper file and records what reaches the LED and the speaker. It checks each one against a table written from the code the cues replaced, not from the new file: the same LED pattern, the same tones in the same order, and the light before the sound where there are both. It checks pitch and volume, but not how long each tone lasts (the test fakes don't record waits). It also checks that the six light-only cues never touch the speaker, with Sound on or off, and that Sound off silences every tone but keeps every light. Three deliberate breaks each make it fail: giving "no GPS fix" a click, giving "SD retrying" the wrong colour, and lowering the key-click volume.
- Every call was replaced one for one. The 36 key-feedback calls in the menus and calibration screens were replaced by a script that matched each old call to its cue, and the session's calls were checked by reading the full before-and-after.

One small difference, not expected to show:

- **Stopping a recording with the Back key now also turns the status light off**, as stopping with OK always did. (Before, only OK sent the Flipper's "stop blinking" message. The firmware source, `notification_app.c` in version 1.4.3, shows that message switches off every LED colour the app has set, after any blink already showing.) Leaving the recording screen turns the light off a moment later anyway, so nothing visible changes. The same goes for the last-resort stop when the screen closes with a recording still running.

Known weak points, left for later steps:

- **The sound rules are written down, not checked.** Nothing in the code stops a cue with a sound being sent with the main lock held (rule 2) or during a recording (rule 3). A scan of every cue call found none that breaks either rule today. *Step 5 now checks both for every cue the session sends (see below). Cues sent from the menus and calibration screens are still unchecked, but none of those run during a recording or with the lock held.*
- **Live Stream keeps its clicks (decided).** Rule 3 covers recordings to the SD card only. In Live Stream the GSR goes live to the phone while the OK and zoom clicks still play, which could put a small blip in the live trace. Kept as it is, at the user's choice (2026-11-20).

No Flipper check is needed beyond the ones for steps 2 and 3: the recording and GPS checks there hear the start and stop sounds and see the heartbeat. To be thorough, listen once for the key clicks in the menu and watch for the blue blink before GPS has a fix.

### Flipper check of steps 2–4 (20 November 2026)

Run on a real Flipper with the build from step 4 (commit `5ade1be`), with the log open (`ufbt cli`, then `log info`).

Passed:

- **App start.** No crash. The GPS answered the wake byte (after 2 ms, because it was already awake: the previous run had let go of the port) and was put to sleep.
- **GPS sleep and wake.** At each session start the log showed `Idle: GPS silent (stayed asleep)`, both after app start (74 s asleep) and between two sessions. The GPS woke from real sleep in 236 ms.
- **GPS setup.** Every setup command was accepted at the first try (no warnings in the log), in about 0.4 s. The chip ID was read once per app run, as intended.
- **GSR start-up.** The ADS1115 was found, the 0.5 V bias read 497.3–497.4 mV, and the gain search stepped up normally.
- **A GPS+GSR recording** (`tracks/biomap_2026-11-20_20-22-26.csv`, 12.5 s). The header has the `# GPSChipID` and `# GSR Bias` lines and the calibration line. 126 rows, exactly one every 0.1 s, GSR 5,300–6,100 nS. The end line shows no overflows and no write failures, and the visualiser's integrity check reports it complete and unmodified.
- **EM mode.** The radio bars moved and the app exited cleanly, so the radio scan running on the GSR thread, and freeing the two in the right order, work on the device.
- **Options > Cold Reset GPS.** Green blink (the success cue); the GPS board's own light went off for a second as the module restarted.
- **Calibration wizard,** all four steps. Gain 1.00, R² 1.00, zero −321 (previously −335.4, about 0.1 mV apart). The worst noise was 2.39 nS, against 0.40 nS for the previous calibration. Still well inside the 10 nS limit. The Flipper was on USB to the MacBook while it was charging, which put hum on the GSR reading on the Cardputer bench too, so that is the likely cause; the wizard's averaging gives bit-identical results to the old code in the host tests. To confirm: repeat the wizard on battery.

Not yet seen:

- **A recording with a GPS fix.** The test recording was indoors, so the position columns were empty. Reading positions was moved unchanged and the old-vs-new comparison ran it with real NMEA sentences; a recording on the next walk will confirm it on the device.
- **Sounds.** Sound was off in Options during the check, so the cues were seen (heartbeat, cold reset blink) but not heard.
- **Diagnostics.** The GSR thread's free stack, worker rate and I2C peak were not read. The Raw and Filt lines seemed to update faster than before; the screen redraw (twice a second) and the GSR worker loop are unchanged in the code, and the question was set aside for now.

### Step 5 done: session logic in `core/`

What a recording screen does is now shared, in [core/biomap_session.c](../firmware/core/biomap_session.c):

- what each key does: OK starts or stops a recording, Back stops it and leaves, the arrows zoom the graph;
- starting a recording: the bias check, building the file header (with the `# GSR Bias` line that step 2 left behind), opening the file, the start sound and the 200 ms settle wait;
- stopping one: closing the file first, then the stop sound, or the warning sound if the last write failed;
- what each 10 Hz tick does: updating the GSR display and graph, building the CSV row, the Live Stream packet;
- what each second does: the heartbeat light, the "no GPS fix" blip, the SD write every 10 s, and the rules for riding out a failing SD card or stopping for good;
- the debug-field figures and the once-a-second telemetry log line.

It has no Flipper code. The device hands it a list of functions ([core/biomap_session.h](../firmware/core/biomap_session.h), `SessionPlatform`): the main lock, the clock, a wait, show a cue, a log line, the date and time, the recording file (start, add a row, write to the card, close), and the optional extras (the radio reading, extra debug figures, and for Live Stream "is a phone connected?" and "send this packet"). The settings it needs (sound, debug fields, the calibration) are read once when the session starts.

The Flipper side, [flipper/biomap_session_flipper.c](../firmware/flipper/biomap_session_flipper.c), is about 350 lines: those functions written with the Flipper's calls, starting and freeing the modules (GPS, GSR, radio, SD file, Bluetooth), and the event loop. The loop is now short: GPS bytes go to the GPS code, key presses to `session_core_key()`, ticks to `session_core_tick()`, and the screen is redrawn when either says so. The screen code reads the shared part as `a->session.core`.

The Live Stream packet layout (`bt_stream_pack_packet()`) moved from the Flipper's Bluetooth file into [core/biomap_format.c](../firmware/core/biomap_format.c), since the Cardputer must send exactly the same bytes. The visualiser's contract test now reads it there, and the session header lines from the new session file.

**The sound rules are now checked** for every cue the session sends (they were only followed before):

- Rule 2: a cue with a sound sent while the session holds the main lock stops the app with a message. This would be a programming mistake, never a user action. Log lines are checked the same way.
- Rule 3: a cue with a sound during a recording is left out. This is now how the zoom click is muted while recording; before, the zoom code did it by hand.

Checked:

- All host tests pass, and the Flipper app builds with no warnings.
- **Old and new side by side.** A throwaway program ran the old session file and the new split through the same scripted key presses and ticks, with the same pretend GPS, GSR, radio, Bluetooth and clock, and the real SD file code on a pretend card. 14 scenarios: every mode; zoom keys before and during a recording; two recordings in one session; a GPS fix that comes and goes; fingers off and back on; debug fields on and off; sound on and off; the SD card failing then recovering after 5 failed writes; failing for 6 writes in a row (recording stopped); the buffer filling while the card fails; a failed restart and a clean one afterwards; Back and OK while the last write fails; the clock not set; no GSR sensor; and Live Stream with the bias check failing once, a phone reconnecting, and the bias check giving up after 3 tries. It printed every cue (and whether the lock was held), every log line, every wait, every redraw, every Bluetooth packet byte, the final session state and every file written, byte for byte. The two printouts were identical (6,897 lines).
- Two deliberate breaks each changed that printout: stopping one SD failure later, and letting key clicks play during a recording.
- **A new test, [tests/test_session.c](../firmware/tests/test_session.c),** runs the shared session with a pretend device and no Flipper headers: the file header, the settle wait, start failures, rows and the 10 s write, the radio columns, the muted clicks, both sound-rule checks, every way of stopping, the SD ride-out and stop rules, debug fields, Live Stream and Diagnostics. Each pretend device function checks whether the lock is held, so moving a slow call (an SD write, a sound, a Bluetooth send) under the lock fails the test. Four deliberate breaks each make it fail: clicks during a recording, stopping one SD failure late, an SD write under the lock, and dropping the settle wait.
- **The same test with a real GSR sensor and GPS** (added after review). The real shared GSR and GPS code runs on a pretend ADS1115 and a pretend GPS module. The pretend ADS1115 answers by which input and gain were last chosen; the pretend GPS answers every set-up packet and the chip ID request. The GSR worker, which has its own thread on a real device, is run by hand between ticks and during waits. This covers what the first version couldn't: the `# GSR Bias` line (a fresh reading, one out of range, one that times out), the `# GPSChipID` line, the green and red heartbeat and the blue "no GPS fix" blip, the GSR reading on screen and in the rows, the graph not spiking when fingers go back on, and Live Stream's bias check (once, not on a reconnect, and given up after 3 tries). Five more deliberate breaks each make it fail: ignoring the last good bias value, removing the spike guard, no blue blip, no red heartbeat, and repeating the Live Stream bias check.
- The shared session builds for the ESP32-S3 with the Cardputer's own compiler, and the C++ check now includes its header.

Small differences, none expected to show:

- **Light-only cues now pass the real Sound setting** instead of "off". They never touch the speaker, so nothing changes (the step 4 cue test checks this).
- **Back while recording takes the main lock twice instead of once** (once to mark the screen as closing, once to stop the recording). The screen could draw one frame in between; it would look the same.
- **The last-resort stop when leaving the screen** (which normal use never reaches, because Back already stops the recording) now plays its warning after the file is closed, not before, like every other stop.
- **OK always asks for a redraw**, including when the header didn't fit (which can't happen with today's settings).
- **The calibration is read without the main lock** when the GSR sensor starts. Only the main thread ever changes it.
- **Main-thread stack:** the recording-start path is about 32 bytes deeper than before, and the tick path about 240 bytes lighter, measured with the Flipper's own compiler. The main thread has 4 KB.

Known weak points:

- **The Flipper's event loop and module start-up are not host-tested.** The old-vs-new program covered them once, but it is not kept. The Flipper check below covers them on the device.
- **Radio modes on a device without a radio.** A radio mode's file header always lists the radio columns, so a device with no radio reading function would write rows without them, and the visualiser would read the columns out of line. The session now stops with a message if a radio mode that records is started with no radio reading function. Note that **GPS Only counts as a radio mode** (`has_rf()`: on the Flipper it records the radio too), so the Cardputer can't offer GPS Only as it is. If it ever should, GPS Only needs a no-radio file layout first.

**To check on a real Flipper:** record GPS+GSR for a minute with sound on: the start sound, the heartbeat, the stop sound, and a file with the usual header lines (including `# GSR Bias` and `# GPSChipID`). Press the zoom keys before recording (clicks) and during it (no clicks, graph still zooms). Start and stop a second recording in the same session. Try GSR only and GPS + RF once each, Diagnostics (OK only clicks), and Live Stream with the visualiser's Live tab (packets arrive; the log shows the "Live Stream bias" line once). Leave each screen with Back and check the app returns to the menu cleanly.

### Step 6 done: the recording screen in `core/`

The recording screen is now shared, in [core/biomap_screen.c](../firmware/core/biomap_screen.c): the graph, the top bar (GPS badge, elapsed time, nS value), the radio panel, the GPS + RF details, Diagnostics, Live Stream, the recording mark and the "REC STOPPED" banner. It is still laid out in the Flipper's 128 × 64 coordinates, and it draws through ten calls ([core/biomap_screen.h](../firmware/core/biomap_screen.h), `ScreenDraw`): clear, set font, text, text width, dot, line, filled box, outline box and swap colours. The Cardputer will supply those ten and stretch each position to its screen (the quick route in section 4).

**The rule for a stretched screen** (written in the header): every number going in or out of those calls is in the 128 × 64 layout's units, never the device's own pixels. That includes the text width the device reports, because the layout right-aligns and centres text by it. So the Cardputer, stretching by about 1.9, multiplies each position by 1.9 when drawing and divides each text width by 1.9 before reporting it. If it reported its real width, the nS value would end about 30 pixels short of the right edge and the elapsed time would sit off-centre. A dot is one layout pixel, drawn as a small block: the graph is one dot per column, and single device pixels would leave gaps.

It reads the shared session for everything it shows, plus a few things the session doesn't hold, which the device hands over each frame (`ScreenExtras`): the recording's file name, the latest radio reading, and Live Stream's Bluetooth state and dropped-packet count. The radio panel's floors now come from the settings the session read at its start, not from the app. They are the same values, because radio calibration can't run during a session.

The Flipper side, [flipper/biomap_screen_flipper.c](../firmware/flipper/biomap_screen_flipper.c), is about 100 lines: the ten calls written with the Flipper's canvas, and the screen callback, which takes the main lock and gathers the extras.

**Only the recording screen moved.** The main menu, Options and the calibration screens stay in [biomap_render.c](../firmware/biomap_render.c). The Cardputer's interface may end up quite different from the Flipper's (it has a full keyboard), and the menus are the part most likely to change, so they wait until the Cardputer's screens are decided (step 10). The radio calibration screens stay Flipper-only either way.

Checked:

- All host tests pass, the Flipper app builds with no warnings, and the shared screen builds for the ESP32-S3 with the Cardputer's own compiler and from C++.
- **Old and new side by side.** A throwaway program drew every frame twice, with the old screen code (from git) and the new shared one, and recorded every drawing call each made: every text with its position, every dot, line and box. It used the real shared session with the pretend GSR sensor and GPS from the session test, in all 7 screen kinds: GPS + GSR + RF with and without a radio calibration, GPS + GSR, GPS + RF, GSR Only, Live Stream and Diagnostics. Each was taken through no fix and a fix, zooming, recording, losing the fix, fingers off and back on at a much higher reading, a moving signal, a made-up graph with every step size and points far off the scale, elapsed times in seconds, minutes and hours, the SD retry blink, the radio at both ends of its scale, three file names, every Bluetooth state, the "REC STOPPED" banner, and the modules missing. The two records were identical: 268 frames, 19,582 drawing calls. Five deliberate breaks each showed up as a difference: the recording mark moved 1 px, minutes written differently, the graph's gap-filling a pixel late, the graph clipped a pixel off, and the radio bars 1 px shorter. (The gap-filling break was missed at first, because no frame had neighbouring graph points exactly 2 px apart; the made-up graph was added for it.)
- **New tests in [tests/test_session.c](../firmware/tests/test_session.c)** draw the screen on a pretend screen that checks every call stays on the 128 × 64 screen and that colour swaps come in pairs. They check the top bar's positions, the recording mark and its blink, the banner, the cuffs-off message, the radio bars against calibrated and default floors, the file name in GPS + RF mode, and Live Stream's lines. Five deliberate breaks each make them fail.
- **Stack**, measured with the Flipper's compiler, on the GUI thread: the Flipper wrapper uses 88 bytes, the shared drawing function 176 and the text formatting under it 76, so about 340 bytes at the deepest. The old code's deepest point was about 268 bytes (192 + 76): 72 bytes more now.

Deliberate differences:

- **GPS + RF: the recording's start time is now in the top bar.** While recording, this screen used to show five lines in the GPS pane: the start time from the file name, the UTC time, latitude, longitude, and accuracy with fix type. The pane only holds four, so the last line ("2.2m 3D") was drawn at y 65, below the 64-pixel screen, and never seen. The start time now sits top left in the top bar (empty in this mode apart from the recording box), where the GSR modes show their GPS badge or time span. The four GPS lines stay where they are whether or not a recording is running. The old-vs-new comparison, run again, differs only in this mode's recording frames, by exactly this.
- **A missing GPS module no longer stops the app.** In the GPS + GSR modes, with the GSR sensor there but no GPS module, the old top bar asked the missing module for its status, which stops the app. It now shows "No fix". On the Flipper this can't happen (since step 5 the session gets both modules at the same moment), but the Cardputer's start-up code is new.

**One list of radio band names.** The names "815", "868" and "915" were written out separately in the screen's labels, the file's `# Band Floors` line and the Flipper's radio code. They now come from one list beside `RF_BAND_COUNT` in [core/biomap_config.h](../firmware/core/biomap_config.h). The CSV column names (`rssi_815`…) stay spelled out, because they are the file format, and the session test checks they agree with the list. The `# Band Floors` line is byte-for-byte unchanged (the header test checks it).

**To check on a real Flipper** (together with step 5's check above): each recording screen looks as before. GPS + GSR: the badge, the elapsed time and the nS value along the top, the graph, the zoom label, and the recording box while recording. GPS + GSR + RF: the three radio bars and their labels on the left. GPS + RF: while recording, the start time (e.g. "14-32-05") top left, and the four GPS lines in the pane, the last (accuracy and fix type) now visible at the bottom. GSR Only: the time span top left. Take the finger cuffs off once ("Finger cuffs disconnected"). Diagnostics and Live Stream as before. The menus and calibration screens haven't changed.

### Step 7 done: the Cardputer project

The Cardputer now has its own project, [firmware/cardputer/](../firmware/cardputer/) (PlatformIO, with the same library versions as the bench program). It builds every file in `core/` and minmea straight from where they are, with warnings treated as errors, and shows a start screen. See its [README](../firmware/cardputer/README.md).

- **Keys.** The Flipper's six buttons are `;` `.` `,` `/` for Up, Down, Left and Right (the keys with arrows printed on them, with or without Fn), Enter for OK, and Esc (the `` ` `` key) or Del for Back ([keys.cpp](../firmware/cardputer/src/keys.cpp)). The start screen shows the last button pressed.
- **The shared code runs.** The start screen shows a file name stamp made by the shared code.
- **When the shared code stops on a broken rule**, the Cardputer's `core_fatal()` turns the screen red and shows the message, as the Flipper's crash screen does ([core_fatal.cpp](../firmware/cardputer/src/core_fatal.cpp)).

Checked: it builds with no warnings from our code or `core/`. The only things the shared code needs from outside are the ordinary C library, the compiler's own maths helpers and `core_fatal()`: nothing Flipper-specific is left. The host tests pass and the Flipper app still builds.

**To check on a real Cardputer:** flash it, see the start screen ("Core: 2026-11-20_14-32-05" in green), press each of the six buttons and see its name appear, and press a letter key to see "other keys" count up.

### Step 8 done: GSR to the SD card

The Cardputer now records in GSR Only mode, through the same shared session code as the Flipper. It writes the same CSV files, in a `biomapping` folder on its SD card.

**The SD logger is now shared.** The recording file's code (the row buffer, the `# Integrity` and `# End` lines with their CRC check, the "_2", "_3" file names, the 8 MB space reserved at the start) moved from `modules/sd_logger.c` to [core/sd_logger.c](../firmware/core/sd_logger.c). Each device supplies seven file calls (`SdPlatform`): create a new file, write, save, move, cut off, close, and the clock. The Flipper's are in [flipper/sd_logger_flipper.c](../firmware/flipper/sd_logger_flipper.c), using its storage service as before.

**Whole 512-byte blocks.** The shared logger has one option, the block size. The Flipper passes 0 and writes every row at each flush (every 10 seconds), as before. The Cardputer passes 512: each flush writes up to the last whole block of the file and keeps the rest (less than 512 bytes) for the next flush. The final write before a stop asks for everything, part-block included, so the session's retry and its "recording incomplete" warning work as on the Flipper. Blocks are counted from the start of the file, header included, so every write ends exactly on a block of the card. After a failed write, the next try writes everything that is waiting, so a success really means the card took it all. The finished file is byte for byte what the Flipper's way would write.

**The Cardputer side**, in [firmware/cardputer/src/](../firmware/cardputer/src/):

- **GSR thread** ([gsr_cardputer.cpp](../firmware/cardputer/src/gsr_cardputer.cpp)): the shared worker pass and a 1 ms pause, as on the Flipper, on the same processor core as the main loop and above it in priority. The ADS1115 is read through M5's own I2C driver (`M5.In_I2C`), the one the keyboard uses. That driver locks the bus around every transfer, so the keyboard and the GSR thread take turns.
- **SD card** ([sd_cardputer.cpp](../firmware/cardputer/src/sd_cardputer.cpp)): Arduino's SD library mounts the card at 25 MHz. The card is built in and can't be taken out while the Cardputer runs, so it is mounted once. The file is written with the plain file calls underneath it, because Arduino's own file type can't cut a file off (needed to remove the unused reserved space) and its buffering would split the whole blocks up again.
- **Sounds** ([cues_cardputer.cpp](../firmware/cardputer/src/cues_cardputer.cpp)): the Flipper's tones, note for note. There is no status light yet, so the light-only cues do nothing; the screen shows the same states.
- **Session** ([session_cardputer.cpp](../firmware/cardputer/src/session_cardputer.cpp)): the device functions for the shared session and the 10 Hz tick. After a pause (a slow SD write) the missed ticks are run at once, up to 64 (about 6 s), as the Flipper's event queue does, so no row goes missing and the time column stays right. Settings are the Flipper's defaults (sound on, auto zoom on, debug fields off). The `# DeviceName` header line says `Cardputer`.
- **Screen** ([main.cpp](../firmware/cardputer/src/main.cpp)): a plain status page, not the recording screen (that is step 10). It shows the state and elapsed time, the reading, the file name, the SD card's slowest write, the GSR reads per second with the share of repeats and failures, and a key count. The same figures go to the USB log once a second.

Not there yet, by design: no calibration (the wizard needs the Cardputer's screens, step 10), so readings carry the board's zero offset, about 100 nS low on the prototype; no clock, so files are named from 1970-01-01_00-00-00 and the header's start time is 0 until GPS time arrives in step 9 (now done, see below); and only GSR Only mode.

Checked:

- **Old and new SD logger side by side.** A throwaway program ran 400 random recordings through the old Flipper logger (from git) and the new shared one, on the pretend SD card the tests use: name clashes, a card that won't open, a full card, failed writes, writes that stop part-way, slow writes, rows too big for the buffer, and stopping with and without an end time. It recorded every file call with its result, every result the logger returned, and every finished file. The two records were identical: 370,207 lines. Three deliberate breaks each showed up (reserved space 1 byte longer, a part-done write keeping 1 byte too many, carrying on to the next file name after a real failure).
- **The existing 31 SD logger tests** pass against the new code unchanged, through the Flipper side.
- **New tests in [tests/test_sd_blocks.c](../firmware/tests/test_sd_blocks.c)** check the whole-block option on a pretend card that records where each write starts and ends: every periodic write ends on a block and follows on from the last; less than a block waits for the stop; after a failure the retry writes everything; writes that stop part-way at 27 different points. Each time the finished file matches the Flipper's way byte for byte. Four deliberate breaks each make them fail.
- The Cardputer program builds with no warnings (our code and `core/` treat warnings as errors). All host tests pass, the visualiser's firmware tests pass, and the Flipper app builds with no warnings.

**To check on a real Cardputer** (with the board connected, the laptop on battery and a microSD card in):

1. The start screen says "GSR Only" and "ready", shows a reading, and "SD card ready". With nothing connected it says "Cuffs off".
2. Press Enter. The recording chirp plays and the top right shows `REC 00:00:01` counting up. Record for a few minutes with a fixed resistor (1 MΩ), then press Enter again (the stop chirp).
3. On a computer, open the file in `biomapping/` on the card and drop it into the visualiser: it should load with no warning about the `# End` line.
4. **Typing test.** Record again with the resistor, and type steadily for a minute (letters only: Enter would stop the recording). The reading and the "GSR …/s" and "ok" figures shouldn't change. Save the USB log (`pio device monitor | tee typing.txt`) for a closer look.
5. **Flipper comparison.** Record 2–3 minutes with the same resistor on the Flipper (GSR Only), and compare the two files' readings. Expect the Cardputer to read about 100 nS lower until it has a calibration.
6. Esc ends the session; Enter starts a new one.

**Checked on a real Cardputer (20 November 2026)**, three GSR Only recordings of a 47k resistor (19–50 s each), fetched over USB with the `ls` and `cat` commands (the card is built in):

- Every file's `# End` line matches its contents (rows, bytes, CRC), and no row is missing. The header has `DeviceName:Cardputer` and a bias of 497.3–497.4 mV.
- The reading averaged 21,135–21,138 nS in all three. From one second to the next it moved by 3.6, 3.8 and 1.4 nS (spread of the 1-second averages); the whole of the last recording stayed within 16 nS, about 0.08 %. The Flipper's calibration wizard measured 2.68 nS on 47k in one saved calibration. The user judged the screen numbers fine once the status page showed the same value as the Flipper (the 100 ms average in whole nS; it had shown a smoothed value with one decimal place, whose last digit changed on nearly every update).
- The GSR thread reads about 1,000 times a second, with about 17 % repeats, as expected (section 4, "GSR reading speed").
- One SD write in the last recording took 433 ms (the bench's worst was 57 ms). No row was lost. Likely cause found since: the reserved space was not saved before the recording started (section 9, "Second review").

Still to check: the typing test, a side-by-side Flipper file of the same resistor, and a long recording.

**The Flipper needs a check too**, because its SD logger moved (together with steps 5 and 6): make a short recording and check the file loads in the visualiser with no `# End` warning.

### Step 9 done: GPS and the clock

The Cardputer now records in GPS+GSR mode too, through the same shared GPS code as the Flipper ([core/gps_uart.c](../firmware/core/gps_uart.c)). Nothing in `core/` changed.

**Decisions (user, 20 November 2026):**

- **Wait for GPS time.** In GPS+GSR mode, Enter won't start a recording until the clock has been set from the GPS: it gives the error sound and the screen says "Waiting for GPS time". GSR Only still records; it uses GPS time if it was found since power-up, otherwise the file is named from 1970 and the start time is 0, as before.
- **UK time.** File names and start times are UK time: GMT in winter, BST from the last Sunday of March to the last Sunday of October, switching on its own. This matches a Flipper set to UK time. As on the Flipper, the header's start time is worked out from the local time.
- **Tab switches the mode** (GPS+GSR or GSR Only) when no session is open, until the menus come in step 10. It starts in GPS+GSR.

**The Cardputer side**, in [firmware/cardputer/src/](../firmware/cardputer/src/):

- **GPS** ([gps_cardputer.cpp](../firmware/cardputer/src/gps_cardputer.cpp)): UART 1 on G13 (out to the module) and G15 (in from it), with an 8 KB receive buffer. As on the Flipper, the port is opened once at start-up, the module is put to sleep, and the port is held until power-off. Bytes are parsed on the main loop. Between sessions, stray bytes are counted, and the count is logged when the next session starts ("Idle: GPS silent"). The first second after the sleep command isn't counted, so at power-up, when the first session starts straight away, it says "Idle: not checked" instead.
- **The wake-up check** (the open point from step 3), in [wake_watch.c](../firmware/cardputer/src/wake_watch.c). The ESP32's serial driver reports a garbled byte through a separate callback, not with the byte.
  - **The framing-error report is switched on by hand.** The driver leaves it off: its interrupt mask, read from the compiled driver, is 0x80195, without the framing-error bit (0x8). A byte at the wrong speed is mostly a framing error, so without it the check would see almost nothing. `gps_cardputer_port_open()` switches it on.
  - **The report comes before the byte.** It comes as soon as the byte reaches the serial chip, but the byte can only be read once the line has been quiet for a byte's time, or once the chip holds a set number of bytes. So after a report, every byte read is thrown away for a guard time, and the wait goes on. After that, a byte counts as clean once the next look a millisecond later brings no report either. A report left from before the wait starts is kept, not cleared, so it is guarded against too.
  - **During the wait, the chip hands bytes over every 4** (120 while streaming, Arduino's default, for fewer interrupts). So a byte can be read within about 4 ms of arriving at 9600, the guard is 30 ms, and the "Wake: first byte after" figure is close to the Flipper's. With 120 it could have been up to 125 ms late.
  - When reports came during a wait, the log says how many ("Wake: N garbled-byte reports during the wait").
  - This is done on the Cardputer side only, so the Flipper is unchanged.
- **Lost bytes.** The ESP32's driver says when bytes were lost, but not how many, so the Cardputer's `gps_rx_drops` counts the times, not the bytes. Only the chip's own receive queue overflowing loses bytes. When the driver's 8 KB buffer is full, it keeps the bytes and stops taking more off the chip until the main loop reads some; that is a near miss, counted separately and shown as `gps_full` in the USB log (`gps_lost` is the CSV's `gps_rx_drops`).
- **Rows after a pause.** After a slow SD write, the missed rows are written at once (up to 64). The GPS bytes that came in during the pause are parsed a slice at a time between them, so each row gets about the position of its own moment. Before, all of them got the same position, and the next row jumped. The Flipper does this by itself: its GPS and row events wait in one queue, in the order they came.
- **The clock** ([clock_cardputer.cpp](../firmware/cardputer/src/clock_cardputer.cpp), rule in [clock_rule.c](../firmware/cardputer/src/clock_rule.c)): set from the RMC time once there is a real satellite fix (status A, not an estimate), and set again if it drifts 2 s or more from GPS time. The GPS time read is the last sentence's, which can be old, so it is only used when it has moved forward since the last look and no GPS bytes are waiting to be parsed, and the clock is only set when two looks in a row agree on how far out it is. Without this, a loose GPS cable would pull the clock back to the moment the GPS went quiet every 2 s (so a recording's end time and the next file's name would be wrong), and a long pause of the main loop would set it back for a second. The summer-time rule was checked on a computer at both 2026 switch-overs. Within one recording the end time keeps the UTC offset of the start, so a recording across a clock change doesn't get an end time an hour off (in October it would have ended before it started). The Flipper's clock doesn't change by itself, so this matches it. A file started in the repeated hour in October may get the same name as one from an hour before; it gets "_2", as any clash does.
- **Tests** ([tests/test_cardputer_rules.c](../firmware/tests/test_cardputer_rules.c), run by `run_tests.sh`): both rules, on the computer. Clock: the first set, no fix, a GPS time that stops for a minute, an old sentence after a pause, the midnight date mix-up, a real 3 s drift, a backlog. Wake: a clean byte, a report before and after the garbled byte, every byte garbled, a report from before the start, the clock wrapping. Three deliberate breaks each make them fail (no "moved forward" check, a reset on one look, no guard). Since the second review the tick schedule and GPS slices ([tick_schedule.c](../firmware/cardputer/src/tick_schedule.c)) and local time with the kept UTC offset ([clock_local.c](../firmware/cardputer/src/clock_local.c)) are plain C and tested too: ticks on time, a 450 ms stall, a recording start, a 10 s stall, the `millis()` wrap, the slices; both 2026 clock changes, an hour-long recording across each, and the clock not yet set. Five deliberate breaks each make one fail.
- **Screen**: a GPS line (fix, satellites, hAcc), the time and position, and "no GPS time" in the top line while recording is held back.

**Checked on a real Cardputer (20 November 2026)**, with the same M10Q as the Flipper (chip ID "axis slang boast putt chunk"):

- At start-up the module was set up at 115200 and every setup command was accepted. It got a fix within seconds (indoors by a window, 6–8 satellites, hAcc 0.7–1.3 m), and the clock was set from GPS.
- After Esc, ten seconds or so, and Enter: "Idle: GPS silent (stayed asleep)", then "Wake: first byte after 271 ms" (the Flipper: 236 ms).
- GSR reading unchanged with GPS running: about 1,000 reads a second, 14 % repeats, 100 % ok.

After review (21 November 2026) the wake-up check, the clock rule, the lost-byte count, the rows after a pause, the clock change and the idle log were changed as above. None of it has been checked on the Cardputer yet. To check:

1. Each session start should still say "Wake: first byte after" a few hundred ms (now nearer the Flipper's 236 ms), with no garbled-byte reports.
2. The clock should be set ("[Clock] set from GPS") about 2 s after the fix.
3. Unplugging the GPS mid-session must not print "[Clock] reset from GPS".
4. **The garbled-byte check, on purpose:** start a GPS+GSR session (the module is then awake at 115200), and press the Cardputer's reset button (if the module stays powered through it; otherwise this check can't be done this way). At start-up the sleep sequence first listens at 9600, so every byte is at the wrong speed. The log should say "Wake: N garbled-byte reports" and "Wake: no reply within 1500 ms", and then "Idle: GPS silent" after the next Esc, a wait and Enter (the sequence still puts the module to sleep). Before this change the wait would have ended at once.

Still to check: a GPS+GSR recording loaded in the visualiser (two recordings were made, with the right UK-time names and complete `# End` lines; see "GPS+GSR recordings" below); Enter before a fix (error sound and "Waiting for GPS time"); a cold start outdoors (time to first fix); a long recording, watching `gps_rx_drops` and the slow SD writes.

**Second review (21 November 2026).** Fixed, with host tests where the code is plain C:

- **Duplicate rows at the start of every recording, on both devices.** Starting takes about 0.5–0.8 s (bias check, file, sound, settle), and the tick schedule kept running through it, so the wait was treated as a stall: the file began with 5–8 rows written at once, all reading the same GSR window, and every later time was that much early. Old Flipper files with debug fields show it (row 0's `tick_dt_ms` 620–730, then 5–7 rows 0–14 ms apart). Now the Cardputer starts its schedule again once the recording starts, and the Flipper drops the ticks its timer queued during the start (each tick now carries its time). The shared code also starts the tick gap and the 10-second flush count again, so row 0 shows no gap and the first card write comes a full 10 s in.
- **The 433 ms SD write (step 8).** The shared logger didn't save the file after reserving its 8 MB, so that work waited in the cache until the first flush, 10 s into the recording. The bench program saved it straight away, and saw 57 ms at worst. It is now saved before the start sound. Likely the cause; to confirm on the Cardputer.
- **The GPS slice after a pause** wasn't one: the shared reader takes up to 384 bytes a pass and keeps lines it hasn't parsed in its own buffer, which the slicing didn't see. Reads are now held to the slice, and passes go on until the held lines are parsed.
- **GSR gain and disconnect counts after a pause.** Each caught-up tick reads the same latest window, and each one added to the 5-window count before the gain goes up and the 20-window disconnect count. A tick less than 50 ms after the last counted one no longer counts. Both devices.
- **Wake check:** a byte that isn't NMEA text now counts as garbled, since output at 115200 read at 9600 doesn't always raise a framing-error report. A garbled-byte report left over from before a silent sleep is cleared, so it no longer makes the next wake ignore its first 30 ms.
- **The keyboard that stops after 10–20 minutes** (section 2) is a race in M5Cardputer 1.1.1's keyboard reader: a key event at the wrong moment, or one failed status read, leaves G11 held low with the reader waiting for a change that never comes. The main loop now restarts the keyboard if G11 stays low for 20 loop passes and 100 ms, and logs "[Keys] warning: keyboard had stopped".
- **USB thumb drive mode (replacing the serial `ls` and `cat` commands).** Pressing **`U`** outside a recording now lends the SD card to a plugged-in computer as a normal USB thumb drive (`USBMSC` over native TinyUSB alongside `USBCDC` serial logging, modeled on [`pocket-wui`'s `src/usb.cpp`](https://github.com/AFetisa/pocket-wui/blob/main/src/usb.cpp)). Ejecting on the computer (or pressing **`U`** twice, as a warned fallback) takes the card back and remounts `/sd` so the Cardputer sees any deleted or changed files. Recording is refused while the computer has the card.

Not changed: the GPS sleeping at power-up only to wake at once for the first session (about 1 s; step 10's menu ends it), the UK time zone, and the Cardputer calibration (both step 10 decisions). To check on the Cardputer: a recording with debug fields on should start at `0.00` with `tick_dt_ms` 0, then about 100 for every row after it; the first SD write should be well under 100 ms; wake still reports a first byte after a few hundred ms. On the Flipper: the same recording start check, since the Flipper loop changed.

**GPS+GSR recordings on a real Cardputer (20–21 November 2026)**, a fixed 47k resistor, the Cardputer on USB to the MacBook with the MacBook on battery: `tracks/biomap_2026-11-20_23-04-31.csv` (129 s) and `tracks/biomap_2026-11-21_08-30-13.csv` (98 s).

- **The files are complete.** Exactly one row every 0.1 s, no gaps, and the `# End` line shows no overflows and no write failures. File names and `# RecordingStartTime` agree (UK time, which is GMT in November).
- **GPS.** A 3D fix on every row, 7–9 satellites, hAcc 0.4–1.2 m. Sitting still, the position wandered about 7 m (21 Nov) and 14 m (20 Nov).
- **The reading is steady.** It averaged 21,138 nS (20 Nov) and 21,134 nS (21 Nov), so the two days agree within 4 nS. Each 10-second stretch on 21 Nov averaged between 21,132 and 21,136 nS, so there is no drift. Row-to-row spread was about ±2.4 nS (about 0.01 %), and about 5 nS from top to bottom within a second. The 21 Nov file has no spikes. The 20 Nov file has one short blip at 105.4 s: up to +50 nS for 0.3 s, cause unknown.
- **It reads 0.67 % low, as expected without a calibration.** A perfect 47k is 21,277 nS (1 ÷ 47,000), so the Cardputer reads about 143 nS low. About 104 nS of that is the prototype board's zero offset (measured on the Flipper as −313 counts with the cuffs open), which the wizard's Zero step will remove. The other ~40 nS (about 0.2 %) is the size of normal gain and resistor error before the gain is calibrated. The bias was 497.3 and 497.0 mV.
- **The 21 Nov header has no `# GPSChipID` line**, though the 20 Nov one does. Explained: on the bench the GPS board was powered separately and was still switched off when the first GPS session started; the firmware only asks for the chip ID once per power-up, so that one check ran while the GPS had no power. Once the GPS was switched on, the 5-second watchdog set it up normally without asking for the ID again. On a real backpack board powered from the Cardputer's `5V out`, the GPS is always powered when the Cardputer is on.

Still to check: the same 47k once the Cardputer has its calibration wizard (step 10), to see how close it reads after calibration.

### Step 10 done: colour menus, Options, calibration wizard, and the recording screen

The Cardputer now boots into its own colour menu system on the 240 × 135 screen ([menu_cardputer.cpp](../firmware/cardputer/src/menu_cardputer.cpp)), draws the shared recording screen ([screen_cardputer.cpp](../firmware/cardputer/src/screen_cardputer.cpp)), and saves settings and GSR calibration on the built-in SD card ([settings_cardputer.cpp](../firmware/cardputer/src/settings_cardputer.cpp)).

- **Boot into the main menu.** At start-up the GPS is put to sleep and stays asleep until a `GPS + GSR` or `Live Stream` session (or `Options > Cold Reset GPS`) is chosen, ending the power-up sleep-then-immediate-wake from steps 8–9. The main menu offers `GPS + GSR`, `GSR Only`, `Live Stream`, and `Options`, with a status bar showing SD card / USB thumb drive state, GPS clock status, and battery voltage.
- **Options and persistence on the SD card.** All Flipper options (except `RF Calibration`, since the Cardputer has no radio scan) are present: `GPS Profile`, `Super-S`, `Cold Reset GPS`, `Auto-zoom GSR`, `GSR Calibration`, `Backlight` (`ON` / `DIM`), `Sound`, `Diagnostics`, and `Debug Fields`. `biomap.settings` and `biomap.cal` are stored in `/sd/biomapping/` using the shared record formats, magic numbers, versions, checksums, and atomic `.tmp` + rename writes (`core/biomap_format.h`). They are also reloaded when the SD card returns from USB thumb drive mode.
- **Non-blocking 4-step GSR Calibration Wizard.** Runs on the main loop at 10 Hz using the shared `CalDwell`, `calibration_wizard_compute_fit()`, and `calibration_noise_grade()` in [core/biomap_format.c](../firmware/core/biomap_format.c): open-circuit Zero step (2 s flush so autoranging reaches PGA 5, then 20 s dwell), followed by 470k, 100k, and 47k resistor steps (1 s flush, fresh 0.5 V bias check, 2-tick settle, then 20 s dwell with live progress bar and live reading). Pressing Esc cancels immediately at any point.
- **The recording screen.** [screen_cardputer.cpp](../firmware/cardputer/src/screen_cardputer.cpp) supplies the ten `ScreenDraw` functions ([core/biomap_screen.h](../firmware/core/biomap_screen.h)) for the top bar and Diagnostics, and renders the live GSR graph natively at 240 × 135 as a smooth 30 FPS Catmull-Rom cubic spline with zero-phase 3-tap binomial denoising and sub-tick fractional scrolling. Also fixed a double-negation in [core/biomap_pipeline.c](../firmware/core/biomap_pipeline.c) where `pipeline_update_graph()` stored `-rate` and the screen subtracted it from `cy` a second time, which had drawn rising GSR downward instead of upward.

### Step 11 done: Bluetooth Live Stream

The Cardputer now supports **Live Stream** mode from the main menu (`GPS + GSR`, `GSR Only`, `Live Stream`, `Options`), streaming the shared 49-byte binary packets (`bt_stream_pack_packet()`, [core/biomap_format.c](../firmware/core/biomap_format.c)) over Bluetooth Low Energy every 300 ms ([bt_cardputer.cpp](../firmware/cardputer/src/bt_cardputer.cpp)).

- **BLE service, characteristic, and MTU.** Advertises under the name `Cardputer` with the exact service UUID (`8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000`) and notify/read characteristic UUID (`19ed82ae-ed21-4c9d-4145-228e61fe0000`) that the visualiser's Live tab looks for ([live_bluetooth.mjs](../visualiser/src/live/live_bluetooth.mjs)), and sets `BLEDevice::setMTU(BT_STREAM_PACKET_SIZE + 3)` (52 bytes) so 49-byte packets are never cut to the 20-byte BLE default.
- **Radio lifecycle.** The BLE stack stays off until `Live Stream` is opened. If the phone or browser disconnects while the session is open, advertising resumes automatically so the visualiser's auto-reconnect picks the stream back up. Pressing Esc to leave `Live Stream` stops advertising and disconnects any connected client.
- **Session and screen wiring.** [session_cardputer.cpp](../firmware/cardputer/src/session_cardputer.cpp) supplies `live_connected` and `live_send` to `SessionPlatform` (so the shared session runs its first-connect 0.5 V bias check and packs a 49-byte update every 3 ticks), and logs `bt_telemetry tick_dt=... bt_tx_peak_ms=... bt_drop=...` once a second when debug fields are enabled. [screen_cardputer.cpp](../firmware/cardputer/src/screen_cardputer.cpp) passes the live BLE link state (`Advertising` / `Connected`) and drop count to `screen_draw_session()`.

**Checked on a real Cardputer (21 November 2026):**

- Entered `Live Stream` from the main menu: the GPS woke after 239 ms (`Idle: GPS silent (stayed asleep)`, chip ID `axis slang boast putt chunk`), the GSR probe succeeded (`0.4970 V` bias, ~995–1,000 Hz worker rate, 14–15 % duplicates, 100 % ok), and BLE started advertising (`ble=2`).
- Connected over Bluetooth Low Energy from the Mac (`CoreBluetooth` client scanning for `8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000` and subscribing to `19ed82ae-ed21-4c9d-4145-228e61fe0000`):
  - On first connect, `[Session] Live Stream bias: measured 496.9 mV, using 496.9 mV` was logged once, and the link state changed to `Connected` (`ble=3`, `ble_peak=0` ms, no new drops while connected).
  - Reconnecting a second time did not repeat the bias check, as intended (`live_bias_checked`).
  - Every notification arrived as a full 49-byte packet (`magic=BN`, `len=49`) at 300 ms intervals (`113.7 s`, `114.0 s`, `114.3 s`, `114.6 s`, `114.9 s`) with live GSR (`7,602–7,749 nS`) and a live GPS fix (`51.555918, -0.071124`, 5 satellites, HDOP 2.6, PDOP 2.8, speed 0.3–0.6 kt).
  - Disconnecting returned the Cardputer to `Advertising` (`ble=2`), and pressing Esc closed the session, stopped BLE advertising, and put the GPS back to sleep (with the Cardputer's clock now set from the GPS fix to `2026-11-21_09:26:51`).

### Next steps

The remaining preparation follows steps 1–6 of the order of work in section 7:

1. ~~Create `core/` and `flipper/`, and move the files that are already plain C.~~ Done (see above).
2. ~~Move the GSR logic into `core/`, including the Zero step's reading and the bias check.~~ Done and checked on a Flipper (see above).
3. ~~Move the GPS logic into `core/`.~~ Done and checked on a Flipper (see above); a recording with a GPS fix is still to be seen.
4. ~~Named events instead of LED patterns, with sounds included.~~ Done (see above).
5. ~~Split the session into shared logic plus the Flipper loop.~~ Done (see above); needs its Flipper check.
6. ~~Make the screen layout shared.~~ The recording screen is done (see above); the menus wait for step 10. Needs its Flipper check, together with step 5's.

---

## 10. The CardputerZero

M5Stack also makes the **CardputerZero**. It is the same size and shape as the Cardputer ADV (84 × 54 mm), but inside it is a Raspberry Pi CM0 (a small Raspberry Pi) running Linux, not an ESP32. The aim is for the same backpack board to work on both.

Most details below come from [M5Stack's CardputerZero docs](https://docs.m5stack.com/en/CardputerZero) and [usage guide](https://docs.m5stack.com/en/compute/cardputerzero/usage), and from [someone who ran M5Stack's LoRa/GPS Cap on a Zero](https://github.com/oumike/camillia-mt/issues/155). The docs are still being written. Points not yet seen on a real device are marked **(check)**.

### Hardware: the backpack should fit

**The same Caps work on both.** M5Stack lists its LoRa-1262 Cap (which has a GPS on it) and its CC1101 Cap for both devices. The LoRa Cap's GPS uses the same two serial pins as ours. So the EXT pins we use carry the same signals in the same places:

| EXT pin | Signal | Cardputer ADV | CardputerZero (Linux name) |
|---|---|---|---|
| 4 | GND | — | — |
| 6 | 5V out | always on | **off by default** |
| 8 | I2C SDA | G8 | GPIO2, `/dev/i2c-1` |
| 10 | I2C SCL | G9 | GPIO3, `/dev/i2c-1` |
| 12 | Serial, to M10Q RX | G13 | GPIO15, `/dev/serial0` |
| 14 | Serial, from M10Q TX | G15 | GPIO14, `/dev/serial0` |

What this means for the board:

- **Still no 3.3 V on EXT.** The board's own 3.3 V regulator is needed on the Zero too.
- **5V out starts switched off.** The board gets no power until it is switched on, either by the user (Settings > ExtPort) or by our app. The app should switch it on at start-up and check that the ADS1115 answers.
- **Never drive the GPS while the board has no power.** The Pi's serial transmit pin (GPIO14) sits at 3.3 V whenever it is not sending. If 5V out is off at that moment, the pin pushes up to about 6 mA through R9 (470 Ω) into the unpowered GPS's RX pin and partly powers the module through it. u-blox says this can damage the module for good ([SAM-M10Q integration manual](datasheets/sam-m10q_integrationmanual.pdf), Table 23). The board has no buffer to stop this, so the app must:
  - leave the serial port off at boot: no Linux serial console on `serial0`, and GPIO14 left as an input until the app has switched 5V out on;
  - only then set GPIO14 to its serial function and open `/dev/serial0`;
  - before switching 5V out off (including on exit), close the port and set GPIO14 back to an input.

  This doesn't cover someone turning ExtPort off in Settings while the app has the port open, so the app should check the ExtPort state and close the port as soon as it goes off. The ADV doesn't need any of this: its 5V out comes on with the device.
- **The serial pin labels look swapped.** M5Stack's Zero docs label pin 12 "UART_RXD" and pin 14 "UART_TXD". The ADV docs label pin 12 as the ESP32's TX. They seem to be labelling the same wires from opposite ends, because the same GPS Cap works on both. Wire by the table above, and check with a multimeter before connecting anything **(check)**.
- **No plugging in or out with the power on.** M5Stack says the Zero does not support it.
- **The signals use 3.3 V logic**, like the ESP32 and the Flipper, so no level shifting is needed.

**Still to check on a real Zero:**

- that the two M2 screw holes and the EXT socket are in the same places as on the ADV (no mechanical drawing has been published yet)
- where the 8 MP camera is; if it is on the back, our board would cover it (the "Lite" version has no camera)
- whether the Zero's greater thickness (23.1 mm) changes the cover design in section 2
- that the flex tail folds round the edge in the same way

### Software: a third device folder

The ESP32 code planned for the ADV will not run on the Zero. The Zero needs its own folder next to the others:

```
firmware/
  core/
  flipper/
  cardputer/        ← Cardputer ADV (ESP32)
  cardputerzero/    ← CardputerZero (Linux)
```

**The shared core suits Linux well.** Each device supplies a few basic actions (section 3), and Linux has a standard way to do each of them:

| Action | On the Zero |
|---|---|
| I2C read/write | `/dev/i2c-1` |
| Serial port | `/dev/serial0` |
| Files | ordinary C file calls |
| Threads | pthreads |
| Clock and wait | `clock_gettime`, `nanosleep` |

The host tests already build the plain-C code on a normal computer, so `core/` should build on the Zero unchanged. This is a further reason to finish steps 1–6 first. It also means **nothing ESP32- or Arduino-specific may go into `core/`**: the 1 ms tick, M5Stack's libraries and `Wire` belong in `cardputer/` only.

**Points to get right on the Zero:**

- **The shared I2C bus.** The Zero's I2C1 also carries the keyboard controller (0x34), the clock chip (0x32), the audio chip (0x10) and an I/O expander (0x4F). The ADS1115 at 0x48 does not clash. Linux itself makes everyone take turns on the bus, so the ADV's "two drivers fighting" problem does not arise. The bus probably runs at the Raspberry Pi's usual 100 kHz and may need setting to 400 kHz **(check)**.
- **The serial port.** Make sure Linux is not using `/dev/serial0` for a login console **(check)**. The rule from section 3 still applies: keep the port open for the whole time the app runs, so the sleeping M10Q is not woken by a floating wire.
- **Timing is less steady.** Linux can pause the GSR thread now and then to run something else. No rows are lost, and `gsr_hz` records the real reading rate, but this makes the side-by-side walks (section 5) even more important.
- **Bluetooth is the hardest part.** It goes through Linux's Bluetooth system (BlueZ), which is quite different from the Flipper's and the ESP32's. It must still use the same service IDs and allow 49-byte messages (section 4).
- **The screen is an unknown.** It is 320 × 170, larger than the ADV's 240 × 135. We do not yet know what M5Stack's own apps use to draw, so the "quick route" drawing calls (section 4) still need a home on the Zero **(check)**.

### What gets easier

- **The clock.** The Zero has a battery-backed clock chip (RX8130CE), so the ADV's "no time until the GPS has a fix" problem (section 4) does not apply.
- **Saving to the SD card.** Linux handles files well. The power switch shuts Linux down before cutting the power, so a recording can be closed properly.
- **Installing.** Apps can come from M5Stack's Store or be copied onto the device, with no flashing from a computer.

### What gets worse for users

- **Battery life.** One comparison puts the Zero at about 2.5 W while doing nothing, roughly five times what the ADV draws. That could cut a long walk short. Measure it with GPS and GSR running before relying on it.
- **Start-up time.** Linux has to boot before recording can start.

### Effect on the order of work

Steps 1–6 (section 7) do not change. At step 7, choose which device to bring up first:

- **The Zero first.** Linux is close to how the host tests already run, so I2C, serial, files and threads should be quick. Bluetooth and the screen are the risky parts.
- **The ADV first.** This is better understood, and its Bluetooth and screen libraries are already known to work.

Steps 7–12 are then repeated for the second device. The core is shared, so this mostly means writing the device's own small set of functions and repeating the checks in section 5.
