# Special Capabilities of u-blox SAM-M10Q (BioMapping Integration)

The **u-blox SAM-M10Q** is a state-of-the-art GNSS module. Beyond raw accuracy and 4-constellation concurrent tracking, it features several built-in hardware capabilities that we can leverage to enhance the **BioMapping** platform.

---

## 1. Dynamic Platform Optimization ("Pedestrian" and "Wrist" Models)

### What it is
By default, GNSS modules are configured with a "Portable" dynamic model. This model makes balanced assumptions about velocity, acceleration, and vertical movement. 
However, u-blox provides specific navigation engines for walking/handheld states:
* **Pedestrian Model (ID 3)**: Optimised for low speed, low acceleration, and high altitude stability. It filters out high-frequency noise from micro-movements.
* **Wrist Model (ID 8)**: Specifically designed for arm-worn/wearable devices. It compensates for arm swing and rapid changes in antenna orientation, which are common when walking with a Flipper Zero in hand.

### How to configure it via Flipper
We can configure the navigation engine at startup in `gps_uart.c` by sending the `UBX-CFG-NAV5` binary packet to set the platform model to **Pedestrian (0x03)** or **Wrist (0x08)**.

---

## 2. Jamming and Spoofing Detection (Signal Security)

### What it is
The M10 chip has hardware-level frequency diagnostics. It monitors in-band power levels and signal correlation to detect:
* **RF Jamming**: High-power interference from cell towers, radio signals, or dedicated jammer devices.
* **GNSS Spoofing**: Attackers broadcasting fake GPS signals to mock locations.

### Potential Integration
The receiver reports these states inside the `UBX-MON-RF` (`jamInd` field) and `UBX-NAV-STATUS` (`spoofDetState` field) binary messages.
If we configure the Flipper to poll these messages, we can:
1. Show a warning icon on the Flipper screen (e.g. ⚠️ `Jammed` or `Spoofed`).
2. Log a `signal_integrity` column in the CSV (e.g. `0` = clean, `1` = jammed, `2` = spoofed) which the post-processing filter can use to automatically discard suspicious track points.

---

## 3. Super-E (Super-Efficient) Power Mode

### What it is
The SAM-M10Q normally runs in **Continuous Mode** (drawing ~15 mA).
However, u-blox has a proprietary **Super-E Mode** (`CFG-PM-OPERATEMODE = 1`) which aggressively power-cycles the internal RF frontend and DSP between epoch measurements while maintaining a continuous 1 Hz fix.
* **Power Savings**: Reduces current draw to **~8 mA** (nearly 50% savings).
* **Tradeoff**: Position accuracy decreases slightly (by about 0.2–0.5m CEP), which is completely negligible for pedestrian walk mapping.
* **Benefit**: Greatly extends the Flipper Zero battery life during long mapping sessions (8+ hours).

---

## 4. Odometer & Travelled Distance

### What it is
The M10 contains an internal hardware odometer that computes the total ground distance traveled by integrating positions at the hardware level.
* **Benefit**: Because it runs at the hardware level, it is not subject to the typical "walk jitter" accumulator error that naive software distance counters suffer from (where standing still adds fictitious distance due to coordinate drift).
* **Flipper Integration**: We can query this distance via a simple UBX command to show a highly accurate "Total Distance: X.XX km" directly on the BioMapping session display.

---

## 💡 Pro Tip: Configuring u-blox using Flipper as a USB-to-UART Bridge

Since the SparkFun breakout does not have a USB-C port, you don't need a separate USB-to-Serial adapter to configure the module on your computer. You can use your **Flipper Zero**!

1. Connect the SAM-M10Q to the Flipper GPIO pins (`3V3`, `GND`, `TX`, `RX`).
2. On the Flipper Zero, go to **Settings** -> **USB-UART Bridge**.
3. Select **USART1** (matching your pins 13/14) and set the baud rate to **9600** (or 115200 once configured).
4. Plug the Flipper into your PC via a USB cable.
5. Launch **u-center / u-center2** on your computer, select the Flipper's virtual COM port, and you will have full access to configure the M10's internal flash memory, save settings, and test firmware.
