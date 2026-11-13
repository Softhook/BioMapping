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

But the port is smaller than that number suggests, for three reasons:

1. **Both devices run FreeRTOS.** The Flipper's system library is a thin wrapper around FreeRTOS, a small operating system for chips like these. The ESP32 runs FreeRTOS too, so most Flipper calls (threads, locks, queues, timers, delays) have a direct one-line equivalent.
2. **The app uses only about 40 different Flipper calls**, apart from screen drawing.
3. **The host tests already fake those calls.** The folder [firmware/tests/shims/](../firmware/tests/shims/) contains stand-in versions so the firmware can be tested on a computer.

So the plan is to write an ESP32 version of those ~40 calls (a "translation layer") and leave most of the app untouched. The signal processing, CSV format and GPS parsing would be the same code on both devices.

---

## 4. Software: piece by piece

| Part | Current files | What changes | Size |
|---|---|---|---|
| Remove EM scan | `em_scan_rf.c`, `em_scan_cal.c`, `biomap_rf_cal.c` (~530 lines) | Delete them, plus their hooks in the session and screen code. | Small |
| Threads, locks, queues, timers | all files | Each Flipper call becomes its FreeRTOS equivalent. | Small |
| SD card | `sd_logger.c` | Flipper file calls become standard C file functions. | Small |
| GSR sensor | `gsr_sensor.c` | Only the I2C read and write calls change. The ADS1115 logic, gain switching and settling rules stay the same. | Small |
| GPS | `gps_uart.c` | On the Flipper, a function runs each time a byte arrives. On the ESP32, a small task reads from the serial port instead. The M10Q setup commands and parsing (minmea) stay the same. | Medium |
| Bluetooth live stream | `bt_stream.c` (~180 lines) | Rewrite using the ESP32's Bluetooth library (NimBLE). | Medium |
| Screen and keys | `biomap_render.c`, `biomap_gui.c` (~1,650 lines) | See below. | Medium to large |
| Clock | `biomap.c` | See below. | Small code change, but it changes how the device behaves |
| Notifications | various | LED and vibration on the Flipper become speaker beeps. The Cardputer has no vibration motor. | Small |
| Flipper-only extras | `biomap.c` | The "expansion" calls are deleted. | Small |
| Build setup | new | A PlatformIO project for the Cardputer. Host tests keep working as they do now. | Small |

### Bluetooth: no visualiser change needed

The visualiser's Live tab finds the Flipper by the Flipper's Bluetooth serial service IDs ([live_bluetooth.mjs](../visualiser/src/live/live_bluetooth.mjs)). It already lists every nearby device rather than filtering by the name "Flipper". If the Cardputer advertises the same service and characteristic IDs and sends the same packet format, the Live tab will connect to it without changes.

### Screen and keys

The screen code uses only about 10 drawing calls (text, lines, boxes, dots, fonts, invert). There are two routes:

- **Quick route.** Recreate those 10 calls on the Cardputer. Draw the existing 128×64 screen into an off-screen image and scale it up to fill the display. It looks blocky but works almost straight away.
- **Redesign.** Lay out the screens again for a colour 240×135 display. It looks much better, but it is the largest single task in the port.

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
- **Side-by-side walks.** Record the same walk with both devices worn together. Load both files into the visualiser and compare the GSR traces and GPS tracks.
- **Host tests.** These run unchanged, because the shared code is the same.

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
- **Keep both.** Two firmwares that share one core of plain C (the pipeline, the format and the GPS parsing), each with its own translation layer. Any fix to the shared core reaches both devices. Device-specific fixes (GPS serial handling, screen, Bluetooth) are made twice.

If both are kept, the shared code should live in one folder that both builds use, never in two copies. Otherwise the two versions will drift apart.

---

## 7. Suggested order of work

Each step can be tested on its own, and the device is useful from step 3.

1. **Set up the project.** Create a separate `firmware_esp32/` folder so the Flipper version stays untouched. Add the build setup and the translation layer.
2. **GSR to SD card.** Get GSR readings logging to the SD card. Compare a recording with the Flipper.
3. **GPS.** Add the M10Q, including the clock rule from section 4. This gives a working GPS+GSR logger.
4. **Screen (quick route) and keys.**
5. **Bluetooth.** Add the live stream and test the visualiser's Live tab.
6. **Validation.** Run the resistor-grid test and the side-by-side walks.
7. **Later, optional.** Redesign the screen, add a printed Cap, add field notes.

---

## 8. Open decisions

- Replace the Flipper, or keep both devices?
- Screen: quick route first, or go straight to a redesign?
- Clock: block recording until GPS time is known, or fix the time afterwards?
- Electronics: buy a ready-made proto board, or build a home-made Cap?
