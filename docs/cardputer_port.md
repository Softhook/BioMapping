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
- **Test early.** In the first Cardputer step, read the ADS1115 and the keyboard together before building anything else. Also leave it running for an hour and check that the keys still respond: one Cardputer app reported the keyboard stopping after 10–20 minutes, cause unknown ([issue #12](https://github.com/Mr-PauI/Gameboy-Enhanced-Firmware-m5stack-cardputer-/issues/12)).

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
- **One exception: the GPS start-up and sleep sequences.** These are timed by nature. For example: send at 9600 baud, wait 200 ms, switch to 115200, wait 50 ms, send the sleep command ([gps_uart.c](../firmware/modules/gps_uart.c)). This sequence is confirmed on real hardware, and rewriting it as a step-by-step machine would risk breaking it. So the shared code may ask the device for "the time now" and "wait N ms", but only in these sequences. They already run on the main thread.
- **Two smaller waits in the GSR code.** When the GSR sensor starts, it checks the chip is there and reads the 0.5 V bias (about 25 ms). And the bias check at the start of a recording waits up to 200 ms for the GSR thread to finish it. Both waits were already there on the Flipper; they now ask the device to wait.
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
- **Keep the GPS serial port open all the time.** A sleeping M10Q wakes on any signal on its receive wire. On the Flipper, letting go of the port left that wire floating, and the module woke within seconds ([gps_uart.c](../firmware/modules/gps_uart.c), [gps_sleep_investigation.md](../research/archive/gps_sleep_investigation.md)). The Cardputer must do what the Flipper does: open the port when the app starts and hold it until the app exits.
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
| Screen | `biomap_render.c` (~1,000 lines) | The current screen layout, drawn through 6–8 basic drawing calls | Those drawing calls, stretched to fit the screen, using the same fonts. See below. | Medium |
| Keys and menus | `biomap_gui.c` | Possibly the menu logic | Reading keys | Small to medium |
| SD card | `sd_logger.c` | Batching rows | Opening, writing and closing files. The Cardputer writes in whole 512-byte blocks (see "SD card pauses" in section 5). | Small |
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
- **SD card pauses.** On the Flipper, writes to the card pause the main thread for 20–60 ms. The ESP32 will have its own pauses. No data is lost, because the GSR thread is separate, but measure the timings again. Both devices reserve 8 MB of file space at the start of a recording ([sd_logger.c](../firmware/modules/sd_logger.c)).
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
| 11 | Cardputer: Bluetooth live stream. Test the visualiser's Live tab. | |
| 12 | The resistor-grid test and side-by-side walks (section 5). | Trusted results |
| 13 | Later, optional: faster GSR reading (section 4), redesign the screen, add a printed Cap, add field notes. | |

---

## 8. Open decisions

- Replace the Flipper, or keep both devices?
- Screen: quick route first, or go straight to a redesign?
- Clock: the time comes from the GPS (decided). Still open: block recording until GPS time is known, or fix the time afterwards?
- Carrying: how to see the screen while the GPS antenna faces the sky (see section 6)?
- Electronics: buy a ready-made proto board, or build a home-made Cap?
- Which device to bring up first at step 7: the Cardputer ADV or the CardputerZero (see section 10)?

---

## 9. Preparing the Flipper code (work done so far)

Before starting the port itself, the Flipper firmware is being reshaped so that more of it can be shared. Each step keeps the Flipper working exactly as before.

### Step 1 done: `core/` folder created

The plain C files moved to [firmware/core/](../firmware/core/): `biomap_pipeline.c/.h` (signal processing), `biomap_format.c/.h` (CSV format and the calibration fit), `biomap_config.h` (settings) and `biomap_types.h` (the shared data types, which the others need). `application.fam`, `run_tests.sh`, the test files and the links in the docs point to the new places.

- **One small code change.** `biomap_format.c` still used the Flipper's warning-log call when a calibration fit failed. That log line now lives in the Flipper code that calls the fit ([biomap_gui.c](../firmware/biomap_gui.c)), so `core/` has no Flipper code at all. Its test build no longer needs the fake Flipper headers.
- **minmea stays in `vendor/minmea/`**, as in the folder plan above. It is already plain C, and third-party code is easier to update where it is.
- **No `flipper/` folder yet.** Git cannot store an empty folder. The Flipper files move into it as steps 2–6 split each one. (Step 2 created it.)

Checked: all host tests pass, the Flipper app builds, and each `core/` file builds on its own with no other folders on the include path. Nothing changed in how the app behaves, so no Flipper check is needed.

### Already done: radio scan out of the GSR code (not yet tried on a real Flipper)

The radio (EM) scan used to be written into the middle of the GSR sensor code ([gsr_sensor.c](../firmware/core/gsr_sensor.c)). It now lives in its own file, [em_scan_sampler.c](../firmware/modules/em_scan_sampler.c). It still runs on the GSR thread, at the same moments as before. No new thread was added. The GSR loop has one line that says "if there is another job, give it a turn". On the Flipper the session hands it the radio scan. On the Cardputer nothing is handed over, so the GSR code contains no radio code at all.

**To check on a real Flipper:** run an EM mode for a minute, check that the radio bars move, then leave the mode and check that the app exits cleanly.

**Known weak points, left as they are for now:**

- **The order things are freed in matters, and only a comment says so.** The GSR sensor must be freed before the radio sampler, because the GSR thread calls into the sampler. Today there is one place that does this, and it does it in the right order. If someone gets it the wrong way round, the device could crash at random.
- **An older gap came across unchanged.** If turning the radio off takes too long (more than 100 ms) and the radio is turned straight back on, the start-up could overlap the radio's last reading. The app never does this today: the radio is only turned off once, at the end of a session. The fix would be a short wait before turning it back on. This is noted in the code.
- **The screen can read the module pointers while a session is starting.** The session sets the GSR and radio pointers without holding the main lock while the screen may already be drawing. This is safe on the Flipper's chip, but it is a pattern to avoid copying into new code.
- **The radio sampler's tests sit inside the GSR tests** (`test_gsr_sensor.c`), not in a file of their own.
- **This step alone does not make the code run on the Cardputer.** The GSR code still used the Flipper's own I2C calls (fixed by step 2 below), and the session and screen code still include the radio modes (steps 5 and 6).

### Step 2 done: GSR logic in `core/` (not yet tried on a real Flipper)

All of the GSR logic now lives in [core/gsr_sensor.c](../firmware/core/gsr_sensor.c): gain switching, the settling waits, the bias check, the 100 ms averaging, the conversion to nanosiemens, the calibration zero and gain, disconnect detection, and every diagnostic figure. It has no Flipper code. It reaches the hardware only through a short list of functions the device hands it ([core/gsr_sensor.h](../firmware/core/gsr_sensor.h), `GsrPlatform`): read or write an I2C register, the time in milliseconds, a wait, a lock, and an optional log line.

The calibration wizard's averaging is shared too: `CalDwell` in [core/biomap_format.c](../firmware/core/biomap_format.c). It takes each tick's reading over the 20 s dwell, keeps the ones inside the gate, and gives the mean, the spread (σ) and whether enough readings passed. The Zero step and each resistor step use it. What stays in the Flipper's wizard ([biomap_gui.c](../firmware/biomap_gui.c)) is the screens, the keys, the countdown and the 100 ms waits between readings. Those were two near-identical loops, one per kind of step; they are now one (`calibration_wizard_dwell()`). That loop is Flipper code, so the host tests don't run it; the wizard run in the Flipper check below covers it.

Not moved in this step: the few lines that choose which bias value goes in a recording's `# GSR Bias` header line. The bias check itself is shared, but that choice sits in the middle of building the file header in [biomap_session.c](../firmware/biomap_session.c), so it moves with the session in step 5.

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

### Next steps

The remaining preparation follows steps 1–6 of the order of work in section 7:

1. ~~Create `core/` and `flipper/`, and move the files that are already plain C.~~ Done (see above).
2. ~~Move the GSR logic into `core/`, including the Zero step's reading and the bias check.~~ Done (see above); needs the Flipper check.
3. Move the GPS logic into `core/`.
4. Named events instead of LED patterns, with sounds included.
5. Split the session into shared logic plus the Flipper loop.
6. Make the screen layout shared.

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
