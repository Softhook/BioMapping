# Special Capabilities of u-blox SAM-M10Q (BioMapping Integration)

The **u-blox SAM-M10Q** is a state-of-the-art GNSS module. Beyond raw accuracy and 4-constellation concurrent tracking, it features several built-in hardware capabilities that we can leverage to enhance the **BioMapping** platform.

> **Status (2026-08-28).** **Shipped:** §1 dynamic platform model (selectable
> in Options → GPS Profile), §5 serial config + UBX-VALSET init +
> Software Standby for GSR-only mode, and the UBX-SEC-UNIQID chip-ID poll
> that produces the `# GPSChipID` CSV header line (see
> [`csv_schema.md`](csv_schema.md)). **Not built:** §2 jamming/spoofing
> detection, §3 Super-E power mode, §4 hardware odometer. §5's low-level
> details still match `firmware/modules/gps_uart.c`.

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

---

## 5. Technical Configuration & Standby Protocol (Firmware Integration Reference)

This section documents the low-level serial configuration, binary UBX configuration packets, and sleep/wake power management protocols utilized by the Flipper firmware to communicate with the SAM-M10Q module.

### 5.1 Serial Configuration & Baud Rate Switching
The SAM-M10Q module boots at a default speed of **9600 bps**. To handle 10 Hz high-rate updates, the firmware switches both the module and the Flipper Zero's USART1 interface to **115200 bps** during initialization:
1. The Flipper sends the u-blox NMEA proprietary baud-switch command at 9600 bps:
   ```
   $PUBX,41,1,0007,0002,115200,0*19\r\n
   ```
   *   `portID=1` (UART1)
   *   `inProtMask=0007` (NMEA+UBX+RTCM input — allows subsequent binary UBX config packets)
   *   `outProtMask=0002` (NMEA output only — **do not use `0001`** which would disable all NMEA output and prevent parsing)
   *   Checksum: `*19`
2. The Flipper waits for **300 ms** to ensure the command is fully transmitted over the serial line.
3. The Flipper reconfigures its internal USART1 interface to 115200 bps, flushes the RX stream, and starts the asynchronous receiver.

### 5.2 Binary Configuration Packets (UBX Protocol)
Once communicating at 115200 bps, the firmware configures the module via **`UBX-CFG-VALSET`** (the modern key-value configuration interface), each packet's `UBX-ACK-ACK`/`UBX-ACK-NAK` reply read back and confirmed before moving on. Legacy `UBX-CFG-MSG`/`CFG-RATE`/`CFG-NAV5` are absent from the M10 SPG 5.10 interface description's message reference (§3.10 lists only `CFG-CFG`, `CFG-RST`, `CFG-VALDEL`, `CFG-VALGET`, `CFG-VALSET`) — u-blox's own guidance is "users are strongly advised to only use the Configuration interface." All values are written to the RAM layer only (not persisted to BBR/Flash), matching the rest of this firmware's philosophy of reconfiguring fresh on every boot rather than relying on stored module state.

1.  **Set Update Rate to 10 Hz (`CFG-RATE-MEAS` + `CFG-RATE-NAV`)**: measurement period 100 ms, 1 measurement per navigation solution.
    *   *Hex*: `B5 62 06 8A 10 00 00 01 00 00 01 00 21 30 64 00 02 00 21 30 01 00 AB 2D`
2.  **NMEA output rates (`CFG-MSGOUT-NMEA_ID_GLL_UART1`=0, `..._VTG_UART1`=0, `..._GSV_UART1`=10)**: disables GLL/VTG, throttles GSV to 1 Hz (every 10th epoch at 10 Hz) — one packet, three keys.
    *   *Hex*: `B5 62 06 8A 13 00 00 01 00 00 CA 00 91 20 00 B1 00 91 20 00 C5 00 91 20 0A 01 E2`
3.  **Set Platform Model (`CFG-NAVSPG-DYNMODEL`)**: optimizes the positioning engine for the selected nav model (Pedestrian shown; value is user-selectable — see §1 above). `CFG-NAVSPG-DYNMODEL`'s enum values are numerically identical to the legacy `CFG-NAV5.dynModel` byte values.
    *   *Hex (Pedestrian, value 3)*: `B5 62 06 8A 09 00 00 01 00 00 21 00 11 20 03 EF 4C`
4.  **Enable AssistNow Autonomous (`CFG-ANA-USE_ANA`, already `UBX-CFG-VALSET`)**: activates self-contained background orbit prediction in the module's RAM, dropping cold-start TTFF to ~4 seconds on subsequent warm boots.
    *   *Hex*: `B5 62 06 8A 09 00 00 01 00 00 01 00 23 10 01 CF C0`
5.  **Enable `$PUBX,00` at 1 Hz (proprietary `NMEA-PUBX-RATE`, `$PUBX,40`)**: for live horizontal accuracy (hAcc). Sent as an ASCII command, not binary UBX — proprietary PUBX sentences have no VALSET key, and this one (§2.8.3) is still current in SPG 5.10, unlike `CFG-MSG`. (A binary `CFG-MSG` packet enabling this same sentence used to be sent redundantly alongside this command — removed as a straight duplicate.)
    *   *ASCII*: `$PUBX,40,00,1,1,0,0*1B`
6.  **Hot Start Reset (`UBX-CFG-RST`)**: Controlled GNSS-only reset for error recovery. Datasheet note: the module does not acknowledge this message (or may not finish sending the ACK before resetting on older firmware), so this one is fire-and-forget — no ACK/NAK confirmation.
    *   *Hex*: `B5 62 06 04 04 00 00 00 02 00 10 68`
7.  **Software Standby (`UBX-RXM-PMREQ`)**: Puts the module into low-power sleep (~46 µA) when inactive.
    *   *Hex*: `B5 62 02 41 10 00 00 00 00 00 00 00 00 00 02 00 00 00 01 00 00 00 56 2F`

### 5.3 Software Standby Power Management & Wake-up
To conserve battery, the module is placed in Software Standby when location services are inactive (e.g. during a GSR-only session):
*   **Sleep Path (`gps_uart_free`)**: The firmware transmits the `UBX-RXM-PMREQ` standby packet (detailed above), forcing immediate sleep.
*   **Wake-Up Path (`gps_uart_alloc`)**: To wake the module, the Flipper transmits a dummy `0xFF` byte at 9600 bps. The falling edge on the module's UART RX pin triggers a hardware wake-up.
*   **GSR-Only Mode**: The session manager allocations briefly initialize and immediately release the GPS handle, sending the module directly into standby for the session duration.

### 5.4 Galileo Constellation Offset Mapping
To prevent multi-constellation sat data collisions in the elevation tables:
*   Galileo `system_id == 3` GSA frames are explicitly mapped to the `GA` talker ID.
*   The `GA` talker is mapped to a PRN offset of `+350` in `gps_get_constellation_offset()`, storing Galileo PRNs 1–36 at array indices 351–386, clear of other bands.
