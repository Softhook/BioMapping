# Moving BioMapping 2 to the M5Stack Cardputer ADV

This document describes what it would take to run BioMapping 2 on an M5Stack Cardputer ADV instead of a Flipper Zero, and what that change would mean for the project.

It assumes **the EM (radio) scan is dropped**. The device would record GSR and GPS only, which is the existing `GPS+GSR` mode.

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

**How it's made:** circuit board makers such as JLCPCB and PCBWay make flexible circuits from the same kind of drawing files as normal boards. They add the stiff plate behind the plug end. A first batch of 5 seems to cost roughly $15–25, a few days slower than normal boards. You then solder the header into the plug end, lay the solder end on the main board's pads, and touch each pad with the iron: the solder runs through each hole onto the pad below. A strip of Kapton tape over the joint stops bending from pulling on the solder.

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

**Still to do:** check which parts are within 2 mm of the board edge, to see how much Option B would actually need to move.

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

Pin 2 ("5V in") is for powering the Cardputer *from* a Cap. It should not be used here.

#### Why the regulator matters more than usual: the 0.5 V bias

The GSR circuit makes its 0.5 V bias from the 3.3 V supply with a resistor divider (56 kΩ and 10 kΩ, see [wiring_guide.md](wiring_guide.md)). The firmware assumes this bias is exactly 0.5 V when it converts readings into nanosiemens ([gsr_sensor.c](../firmware/modules/gsr_sensor.c)). So **any error in the 3.3 V supply becomes the same percentage error in every GSR reading.** For example, a supply 2% low gives readings 2% low.

The published accuracy (±0.1% over most of the range) was measured on the Flipper's 3.3 V supply. With a new regulator:

- choose a **low-noise, accurate** regulator (±1% or better), not the cheapest one
- run the resistor-grid test again on the new device, and if needed correct for the measured bias in the firmware

This is also a chance to improve on the Flipper. A dedicated, quiet regulator on the Cap keeps the GSR circuit away from the noise of the Cardputer's own 3.3 V supply, which powers the ESP32 and its radio.

#### The I2C bus is shared with the Cardputer's own parts

Unofficial sources say EXT pins 8 and 9 (G8, G9) are the same I2C bus the Cardputer uses internally for its keyboard controller (TCA8418), audio chip (ES8311) and motion sensor (BMI270) **(check)**. Their addresses do not clash with the ADS1115 at 0x48, so sharing should work. But:

- the bus speed and any extra pull-up resistors must suit all of these parts
- one user reported that I2C on EXT pins 8 and 9 did not work as expected in one particular app (Bus Pirate). The cause is unknown, so test this early.

If the shared bus causes trouble, the ADS1115 can go on the Grove port instead (G2 and G1 as a separate I2C bus). The M10Q stays on the EXT serial pins.

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

There are two ways to remove the dependence on the exact supply voltage, so that the GSR accuracy no longer rests on the regulator:

- **Measure the bias instead of assuming it (firmware only).** The 0.5 V bias is already wired to the ADS1115 (input AIN1). Every so often, the firmware could switch the ADS1115 to measure AIN1 against ground and use the measured bias in the conversion instead of the fixed 0.5 V. The ADS1115 has its own internal reference, so this measurement does not depend on the supply. No hardware change is needed. The cost is an occasional extra conversion and a little more code in [gsr_sensor.c](../firmware/modules/gsr_sensor.c). This would also help on the Flipper.
- **Feed the bias divider from a voltage reference chip (hardware).** A small precision reference IC (for example a 2.5 V or 3.0 V shunt reference) powers only the 56 kΩ / 10 kΩ divider. The bias then stays fixed whatever the supply does. One extra part, and the divider values change to keep 0.5 V.

High-frequency switching ripple matters less than slow drift. The amplifier's 47 kΩ / 100 nF feedback forms a roughly 34 Hz low-pass filter, and the ADS1115's own digital filter rejects fast noise as well. What really affects accuracy is the DC level of the bias and any slow drift, which is exactly what the two fixes above deal with.

#### Header pin numbers

The schematic and the online pin table number the EXT header differently. The schematic counts 1–7 down one side and 8–14 down the other; the online table alternates sides. The schematic also labels G13 "GPS-RX" and G15 "GPS-TX" (meaning they connect to the GPS module's RX and TX), which suggests the header was designed with a GPS in mind. **Wire by signal name (5VOUT, GND, SDA, SCL, G13, G15), not by pin number,** and confirm with a multimeter before connecting anything.

### Things to check on the hardware

- **Power budget.** A community wiki warns that drawing too much current through EXT can make the Cardputer reset. GSR and GPS together should be well within limits, but measure the M10Q's current while it is first finding satellites.
- **Component height.** Tall parts stop a Cap sitting flat. Use low-profile parts or a taller header.
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
- **Each device runs its own loop and threads** and feeds the shared code. Both devices keep the same two-thread design: a main thread and a GSR thread.
- **Each device supplies a few small functions:**
  - I2C: read or write a register
  - serial port: send bytes, change speed
  - file: open, write, close
  - screen drawing: about 6–8 basic drawing calls (lines, boxes, text and so on)
  - a clock, and a wait (for the GPS sequences above only)
  - responding to a named event such as "recording started" or "write error"

### Why not the other ways

- **A separate copy of the firmware for the ESP32.** The two copies would drift apart. Every fix would need making twice, and sooner or later one would be forgotten.
- **A fake Flipper library on the ESP32** (rewriting the Flipper's own calls for the ESP32 and compiling the Flipper app unchanged). This is tempting, because the host tests already fake the Flipper this way ([firmware/tests/shims/](../firmware/tests/shims/)). But the screen, keys and notifications don't map well, and the Cardputer code would be shaped around Flipper ideas forever.

With a shared core, each device has its own small, natural code, and the shared part is written and tested once. The shared code can be tested on a computer without the fake Flipper headers, because it contains no device code.

### Build tools

- **Flipper.** `application.fam` stays in `firmware/` and lists the files it needs from `core/` and `flipper/`. It already lists its files one by one, so the Flipper build ignores the Cardputer files. `ufbt` is still run from `firmware/`.
- **Cardputer.** PlatformIO with the Arduino setup:
  - M5Stack's own libraries for the screen, keyboard and SD card work there directly.
  - Its clock counts in 1 ms steps. The GSR thread pauses for 1 ms between readings. With the default 10 ms steps in Espressif's own toolkit (ESP-IDF), that pause would round down to nothing, the thread would never really rest, and the watchdog would restart the device.
  - The shared C code builds unchanged.

  The alternative is ESP-IDF itself. It is cleaner but more work to set up the screen and keyboard.

### Can the Cardputer run the threads?

Yes, easily. The Flipper runs the main thread, the GSR thread and its own Bluetooth on a single 64 MHz core with 256 KB of RAM. The Cardputer ADV's ESP32-S3 has two 240 MHz cores and 512 KB of RAM. It probably has no extra PSRAM memory chip **(check)**, but it doesn't need one. Points to get right:

- **The 1 ms pause** described under "Build tools".
- **The shared I2C bus.** If the GSR converter shares a bus with the keyboard (see section 2), the two threads take turns on it. The GSR code already takes and releases the bus around each read and write, so a lock fits in the same places.
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
| GSR sensor | `gsr_sensor.c` | ADS1115 gain switching, settling rules, conversion to nanosiemens | The GSR thread and the I2C read/write | Small |
| GPS | `gps_uart.c` | M10Q setup commands, reading its replies, speed change and standby/wake rules, parsing (minmea) | Sending bytes and collecting the bytes that arrive. The Flipper gets them one at a time from an interrupt; the ESP32's serial driver stores them for the main loop. | Medium |
| Session | `biomap_session.c` | Start and stop, what each second does, building CSV rows, which events happen | The main loop, locks and screen refresh | Medium |
| Notifications | `biomap_session.c`, `biomap.c` | Named events ("recording started", "GPS fix", "write error"), including the rules about when sounds may play | The response: LED and sounds on the Flipper, beeps on the Cardputer (no vibration motor) | Small |
| Screen | `biomap_render.c` (~1,000 lines) | The current screen layout, drawn through 6–8 basic drawing calls | Those drawing calls, stretched to fit the screen, using the same fonts. See below. | Medium |
| Keys and menus | `biomap_gui.c` | Possibly the menu logic | Reading keys | Small to medium |
| SD card | `sd_logger.c` | Batching rows | Opening, writing and closing files | Small |
| Bluetooth live stream | `bt_stream.c` (~180 lines) | Packet format (already shared) | The Bluetooth code. On the ESP32 it uses NimBLE. | Medium |
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

The Flipper keeps the time when switched off. The Cardputer ADV does not appear to have a battery-backed clock chip **(check)**, so it may lose the time when powered down.

The firmware reads the clock in one place ([biomap.c](../firmware/biomap.c)), so the code change is small. The real effect is on behaviour: the time has to come from the GPS. That means:

- a recording started before the first GPS fix has no correct wall-clock time
- the file name and the session start time may need to be set, or corrected, once GPS time arrives

The M10Q gives accurate time with its first fix, so in practice this is a short delay at the start of a walk. It still needs a clear rule, for example: "don't start recording until GPS time is known", or "start anyway and fix the timestamps later".

### CSV format

Nothing needs to change. The `GPS+GSR` format (11 columns) already exists and is documented in [csv_schema.md](csv_schema.md). The visualiser already handles files without the RF columns, because the EM features only switch on when those columns are present.

---

## 5. Testing and validation

The firmware has been through a lot of real-hardware fixes. The logic carries over, but timings depend on the hardware, so each fix needs re-checking on the new device. The main ones:

- **GSR accuracy.** The published accuracy figures in the README come from a resistor-grid test on the Flipper. That test should be repeated on the Cardputer before the same accuracy is claimed.
- **ADS1115 gain-switch settling.** Check that readings taken just after a gain change are still being held back correctly.
- **M10Q standby and startup.** Check that the M10Q still powers down and wakes correctly.
- **Noise from sound and Bluetooth.** The Flipper code already waits after a tone before trusting GSR readings again (`GSR_TONE_SETTLE_MS`), so the speaker affects the reading even there. On the Cardputer, sound goes through an audio chip and amplifier, and Bluetooth comes from a different radio. Measure both, and check whether that wait is still long enough. Live Stream mode, with Bluetooth sending all the time, matters most.
- **SD card pauses.** On the Flipper, writes to the card pause the main thread for 20–60 ms. The ESP32 will have its own pauses. No data is lost, because the GSR thread is separate, but measure the timings again. The ESP32 can also reserve file space in one quick step, which the Flipper cannot ([sd_logger.c](../firmware/modules/sd_logger.c)).
- **Side-by-side walks.** Record the same walk with both devices worn together. Load both files into the visualiser and compare the GSR traces and GPS tracks.
- **Host tests.** The shared code in `core/` is tested on a computer once, for both devices, without fake Flipper headers. The existing tests of the Flipper-only parts keep using `tests/shims/`.

---

## 6. Implications

### For people using the device

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
| 2 | Move the GSR logic into `core/`. The smallest real step. | Flipper check |
| 3 | Move the GPS logic into `core/`. The risky part is the standby/wake sequence, which has been confirmed on real hardware. | Flipper check |
| 4 | Named events instead of LED patterns, with sounds included. | |
| 5 | Split the session into shared logic plus the Flipper loop. | Flipper check |
| 6 | Make the screen layout shared, drawn through the small drawing interface. | Flipper check |
| 7 | Start the Cardputer project: it builds `core/`, shows something on screen and reads keys. | First Cardputer code |
| 8 | Cardputer: GSR to SD card. Compare a recording with the Flipper. | A useful device |
| 9 | Cardputer: GPS, plus the clock rule from section 4. | A GPS+GSR logger |
| 10 | Cardputer: screen (quick route) and keys. | |
| 11 | Cardputer: Bluetooth live stream. Test the visualiser's Live tab. | |
| 12 | The resistor-grid test and side-by-side walks (section 5). | Trusted results |
| 13 | Later, optional: redesign the screen, add a printed Cap, add field notes. | |

---

## 8. Open decisions

- Replace the Flipper, or keep both devices?
- Screen: quick route first, or go straight to a redesign?
- Clock: block recording until GPS time is known, or fix the time afterwards?
- Electronics: buy a ready-made proto board, or build a home-made Cap?

---

## 9. Preparing the Flipper code (work done so far)

Before starting the port itself, the Flipper firmware is being reshaped so that more of it can be shared. Each step keeps the Flipper working exactly as before.

### Already done: radio scan out of the GSR code (not yet tried on a real Flipper)

The radio (EM) scan used to be written into the middle of the GSR sensor code ([gsr_sensor.c](../firmware/modules/gsr_sensor.c)). It now lives in its own file, [em_scan_sampler.c](../firmware/modules/em_scan_sampler.c). It still runs on the GSR thread, at the same moments as before. No new thread was added. The GSR loop has one line that says "if there is another job, give it a turn". On the Flipper the session hands it the radio scan. On the Cardputer nothing is handed over, so the GSR code contains no radio code at all.

**To check on a real Flipper:** run an EM mode for a minute, check that the radio bars move, then leave the mode and check that the app exits cleanly.

**Known weak points, left as they are for now:**

- **The order things are freed in matters, and only a comment says so.** The GSR sensor must be freed before the radio sampler, because the GSR thread calls into the sampler. Today there is one place that does this, and it does it in the right order. If someone gets it the wrong way round, the device could crash at random.
- **An older gap came across unchanged.** If turning the radio off takes too long (more than 100 ms) and the radio is turned straight back on, the start-up could overlap the radio's last reading. The app never does this today: the radio is only turned off once, at the end of a session. The fix would be a short wait before turning it back on. This is noted in the code.
- **The screen can read the module pointers while a session is starting.** The session sets the GSR and radio pointers without holding the main lock while the screen may already be drawing. This is safe on the Flipper's chip, but it is a pattern to avoid copying into new code.
- **The radio sampler's tests sit inside the GSR tests** (`test_gsr_sensor.c`), not in a file of their own.
- **This step alone does not make the code run on the Cardputer.** The GSR code still uses the Flipper's own I2C calls, and the session and screen code still include the radio modes. Those are the next steps below.

### Next steps

The remaining preparation follows steps 1–6 of the order of work in section 7:

1. Create `core/` and `flipper/`, and move the files that are already plain C.
2. Move the GSR logic into `core/`.
3. Move the GPS logic into `core/`.
4. Named events instead of LED patterns, with sounds included.
5. Split the session into shared logic plus the Flipper loop.
6. Make the screen layout shared.
