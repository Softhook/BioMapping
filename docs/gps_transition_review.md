# Critical Review: Transition to u-blox SAM-M10Q GNSS Module

This document provides a critical review of the transition plan from the Quectel L76K GNSS module to the **SparkFun u-blox SAM-M10Q GPS Breakout**. It details the hardware constraints, protocol changes, and critical bugs identified in the existing codebase that must be fixed to support the new u-blox module.

---

## 1. Hardware & Electrical Review

### Power Specifications & Flipper GPIO
* **Operating Voltage**: The u-blox SAM-M10Q runs on a nominal **3.3V** supply (range: 2.7V to 3.6V).
* **Logic Level**: **3.3V CMOS** logic. This is directly compatible with the STM32 logic levels on the Flipper Zero. No level-shifters or voltage regulators are required.
* **Power Draw**: The SAM-M10Q draws approximately **15 mA** during active tracking (continuous 4-constellation reception). The Flipper Zero's 3.3V power rail (available on Pin 9) can safely source up to **150 mA**, meaning the power draw is well within the Flipper's safe operating limits.

### Integrated Patch Antenna Considerations
* **Orientation**: The SAM-M10Q has an integrated 15x15mm ceramic patch antenna on the top side of the module. Unlike the L76K (which has a U.FL connector for an external active antenna), the SAM-M10Q must be physically oriented with the top of the board facing the sky.
* **Shielding Risk**: Ceramic patch antennas are highly sensitive to detuning and attenuation when blocked by materials. The Flipper Zero enclosure, if it contains shielding or is placed inside a pocket/backpack, will severely degrade the signal. The user must be instructed to mount the module externally or under an RF-transparent plastic window.

### Backup Battery & Hot Starts
* **RTC Power**: The SparkFun breakout includes an onboard rechargeable lithium battery (MS621FE or equivalent) connected to the `V_BCKP` pin. This preserves the Real-Time Clock (RTC) and satellite ephemeris data in the module's SRAM when main power is removed.
* **Startup Behavior**: 
  * If the board is brand new (battery is flat), the first start will be a **Cold Start** (taking 20–30 seconds under open sky).
  * Once the battery is charged (charges automatically when Flipper provides 3.3V), subsequent power cycles will trigger a **Hot Start** (fixing in < 1 second).
  * **Critical Note**: No software hot-start command is required to benefit from this; the module automatically loads BBR (Battery-Backed RAM) contents if `V_BCKP` has maintained voltage.

---

## 2. Serial Protocol & Baud Rate Transition Review

### Baud Rate Synchronization
* **Boot Default**: The SAM-M10Q boots at **9600 bps** by default.
* **Upgrade command**: The u-blox NMEA proprietary command to switch the baud rate to 115200 is:
  ```
  $PUBX,41,1,0007,0001,115200,0*1A\r\n
  ```
  Parameters: `portID=1` (UART1), `inProtMask=0007` (NMEA+UBX+RTCM input — UBX input must be enabled so binary UBX config packets work), `outProtMask=0001` (NMEA output **only** — the firmware's NMEA line parser does not handle UBX binary frames, so enabling UBX output (`0003`) would inject binary framing noise into the stream).
* **Timing Sensitivity**: When switching the baud rate, the Flipper must wait long enough to ensure the command is fully transmitted over the TX line at 9600 bps before the Flipper changes its own USART1 baud rate to 115200. The existing 300 ms delay (`furi_delay_ms(300)`) is sufficient to prevent synchronization loss.

> **⚠️ Checksum note**: The correct checksum for `$PUBX,41,1,0007,0001,115200,0` is `*1A`. Using `outProtMask=0003` (NMEA+UBX) produces `*18` — do not use this variant as it enables binary UBX output the parser cannot handle.

---

## 3. Parser & Constellation Mapping Review (Critical Code Bugs)

The u-blox M10 tracks **Galileo** in addition to GPS, GLONASS, and BeiDou. The current `gps_uart.c` codebase contained several L76K-specific assumptions that would cause bugs or data collisions. Both have been fixed.

### Bug A: Galileo GSA — missing `system_id == 3` branch (FIXED)

By default, the u-blox module outputs multi-constellation sentences using the **`GN`** talker ID (e.g. `$GNGSA`).
In [modules/gps_uart.c](../modules/gps_uart.c), the GSA parser maps PRNs using `SystemID`. Without an explicit Galileo branch, `system_id == 3` fell to the `else` branch, setting `talker_id` to `GN`. In `gps_get_constellation_offset()`, the GN handler's PRN 1–32 fallback returned GPS offset 0. Because Galileo PRNs (1–36) overlap GPS PRNs (1–32), Galileo satellite data would silently overwrite GPS satellite data in `sat_elevation`, corrupting WDOP.

**Fix applied** — explicit branch added:
```c
} else if(frame.system_id == 3) {
    talker_id[0] = 'G'; talker_id[1] = 'A'; // Galileo — offset 350
}
```

### Bug A (Part 2): Galileo GSV — `GA` talker not handled in offset function (FIXED)

The M10Q outputs `$GAGSV` sentences for Galileo satellite elevations. `gps_get_constellation_offset()` had no `GA` handler, so Galileo GSV data fell through all conditions and returned offset 0 (GPS), storing elevations at GPS PRN indices and corrupting WDOP for any track with Galileo in view.

**Fix applied**:
```c
// Galileo: GA — spec Table 16: IDs 1-36
// Offset 350 places Galileo indices at 351-386, clear of all other bands.
if(talker_id[0] == 'G' && talker_id[1] == 'A') return 350;
```

**Complete constellation offset map:**

| Talker | Constellation | PRN range | Array offset | Index range |
|--------|---------------|-----------|--------------|-------------|
| `GP`   | GPS / SBAS / QZSS | 1–32 / 120–158 / 193–197 | 0 | 1–197 |
| `GL`   | GLONASS | 65–88 | +235 | 300–323 |
| `BD`/`GB` | BeiDou | 1–63 | +210 | 211–273 |
| `GA`   | Galileo | 1–36 | +350 | 351–386 |

All indices fit within `sat_elevation[512]`. ✓

---

## 4. Proposed Configuration Sequence

### Step 1 — At 9600 baud (ASCII NMEA)

Send the PUBX baud switch command, then wait before reconfiguring the STM32 USART:

```
$PUBX,41,1,0007,0001,115200,0*1A\r\n   ← baud switch; inProt=NMEA+UBX, outProt=NMEA only
[wait 300 ms]
[reconfigure STM32 USART1 to 115200]
[flush RX stream buffer, restart async RX]
[wait 100 ms]
```

### Step 2 — At 115200 baud (binary UBX packets)

All packets below include the full `B5 62` sync header and verified Fletcher-8 checksums. Send each via a `ubx_tx()` helper (see Section 6.2).

#### 1. Set Update Rate to 10 Hz (`UBX-CFG-RATE`)
Sets the measurement period to 100 ms. SAM-M10Q datasheet Table 1 lists 10 Hz as the high-performance-mode maximum for the default 4-constellation config (GPS+GAL+BDS B1C+GLO). No separate HP-mode enable packet is needed — setting the rate via `UBX-CFG-RATE` is sufficient on M10 SPG 5.10 firmware. The module's power overhead at 10 Hz is negligible in the context of the Flipper Zero's overall ~200 mA system draw.
* **Hex**: `B5 62 06 08 06 00 64 00 01 00 01 00 7A 12`

#### 2. Disable NMEA GLL (`UBX-CFG-MSG`)
NMEA message ID for GLL is `0x01`. Verified against u-blox interface description (protocol class 0xF0): 0x00=GGA, **0x01=GLL**, 0x02=GSA, 0x03=GSV, 0x04=RMC, 0x05=VTG, 0x07=GST, 0x09=GBS.
* **Hex**: `B5 62 06 01 03 00 F0 01 00 FB 11`

#### 3. Disable NMEA VTG (`UBX-CFG-MSG`)
NMEA message ID for VTG is `0x05`.
* **Hex**: `B5 62 06 01 03 00 F0 05 00 FF 19`

#### 4. Throttle NMEA GSV to 1 Hz (`UBX-CFG-MSG`)
NMEA message ID for GSV is `0x03`. Outputs GSV once every 10th navigation epoch (100 ms × 10 = 1 Hz at 10 Hz nav rate):
* **Hex**: `B5 62 06 01 03 00 F0 03 0A 07 1F`

#### 5. Set Navigation Model to Pedestrian (`UBX-CFG-NAV5`)
`mask=0x0001` (dynModel field only), `dynModel=0x03` (Pedestrian). All other fields zeroed (unchanged). M10Q protocol version 34+ requires the 40-byte payload (not 36-byte legacy). For an arm-worn device, substitute `dynModel=0x08` (Wrist) — change byte at offset 6 and update checksums accordingly.
* **Pedestrian**: `B5 62 06 24 28 00 01 00 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 56 3E`
* **Wrist**:       `B5 62 06 24 28 00 01 00 08 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 5B FC`

#### 6. Hot Start Reset (`UBX-CFG-RST`)
Controlled software reset (GNSS only) without resetting Flipper interface. Replaces the PCAS10 command used in `gps_uart_send_hot_start()` (see Section 6.3):
* **Hex**: `B5 62 06 04 04 00 00 00 02 00 10 68`

> **Note on constellation config**: The SAM-M10Q factory default enables GPS, GLONASS, Galileo, and BeiDou simultaneously. If a module arrives with Galileo disabled, send a `UBX-CFG-VALSET` message setting key `CFG-SIGNAL-GAL_ENA` (`0x10310021`) = 1. Use u-center to generate and verify this packet for your specific module firmware version, then add it to the init sequence.

---

## 5. Software Risk Mitigation & Backup Plan

* **Risk 1 — Legacy `UBX-CFG-` commands rejected**: u-blox M10 firmware (protocol versions 34+) deprecates legacy `UBX-CFG-` commands in favour of Key-Value configuration blocks (`UBX-CFG-VALSET`). If `UBX-CFG-RATE` or `UBX-CFG-NAV5` are rejected (ACK-NAK response), fall back to `UBX-CFG-VALSET` messages with the appropriate keys (e.g. `CFG-RATE-MEAS = 0x30210001` for update rate). Use u-center to generate the correct VALSET packet for the installed firmware version.

* **Risk 2 — Binary framing in NMEA stream**: If UBX binary frames ever appear in the NMEA stream (wrong `outProtMask`), `minmea_sentence_id()` returns `MINMEA_UNKNOWN` and bytes are silently discarded. However, a binary frame arriving mid-NMEA-sentence can corrupt the current line. Guard: confirm `outProtMask=0001` in the PUBX command. If spurious framing is observed in serial logs, add a `B5 62` byte-pair rejection in the line accumulator in `gps_uart_process_rx()`.

* **Risk 3 — PUBX command not acknowledged**: The PUBX baud command has no ACK response. Verify success by confirming NMEA sentences resume at 115200 within 500 ms of the STM32 USART reconfiguration. The NMEA watchdog (5 s timeout → hot start) will detect and recover from a silent baud mismatch.

---

## 6. Firmware Implementation Notes

### 6.1 `gps_uart_configure()` — Complete Redesign Required

The existing function sends Quectel PCAS ASCII commands which are not understood by the M10Q. All PCAS commands must be replaced with UBX equivalents. Structural change:

```
// L76K (current):
//   pcas_tx(g, "$PCAS04,7*1E\r\n");    // constellations
//   pcas_tx(g, "$PCAS03,...\r\n");      // sentence filter
//   pcas_tx(g, "$PCAS01,5*19\r\n");    // 115200 baud
//   pcas_tx(g, "$PCAS02,200*1D\r\n");  // 5 Hz

// M10Q (required):
//   pubx_tx(g, "$PUBX,41,1,0007,0001,115200,0*1A\r\n"); // baud (ASCII, at 9600)
//   [reconfigure USART]
//   ubx_tx(g, ubx_cfg_rate_5hz, sizeof(...));    // 5 Hz
//   ubx_tx(g, ubx_cfg_msg_gll_off, sizeof(...)); // disable GLL
//   ubx_tx(g, ubx_cfg_msg_vtg_off, sizeof(...)); // disable VTG
//   ubx_tx(g, ubx_cfg_msg_gsv_1hz, sizeof(...)); // GSV @ 1 Hz
//   ubx_tx(g, ubx_cfg_nav5_pedestrian, sizeof(...)); // nav model
```

The `pubx_tx()` helper can reuse the existing `pcas_tx()` body (ASCII string + `strlen`). The new `ubx_tx()` helper must use an explicit length (not `strlen`) — see Section 6.2.

### 6.2 New `ubx_tx()` Helper Required

Binary UBX packets cannot use `strlen()` — frames contain embedded `\0` bytes. Add:

```c
static void ubx_tx(GpsUart* g, const uint8_t* data, size_t len) {
    furi_hal_serial_tx(g->serial_handle, data, len);
    furi_delay_ms(100);
}
```

Store each packet as a `static const uint8_t` array in `gps_uart.c`.

### 6.3 `gps_uart_send_hot_start()` — Replace PCAS10 with UBX-CFG-RST

Currently sends `$PCAS10,0*1C\r\n` (L76K-only). For M10Q, replace with the binary hot-start packet from Section 4.6:

```c
static const uint8_t ubx_cfg_rst_hot[] = {
    0xB5, 0x62, 0x06, 0x04, 0x04, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x10, 0x68
};
// call ubx_tx(g, ubx_cfg_rst_hot, sizeof(ubx_cfg_rst_hot));
```

### 6.4 Module Selection — Compile-Time Define

The L76K and M10Q use different physical hardware (U.FL external antenna vs integrated ceramic patch). Since the user controls which board is attached, runtime autodetection adds unnecessary complexity and risk (destructive probing, misdetection fallback, extra boot latency).

A single `#define` in `biomap_config.h` selects the module at compile time:

```c
#define GPS_MODULE_L76K  1
#define GPS_MODULE_M10Q  2
#define GPS_MODULE       GPS_MODULE_M10Q  // ← change this when swapping hardware
```

`gps_uart_configure()` and `gps_uart_send_hot_start()` use `#if GPS_MODULE ==` preprocessor guards to compile only the relevant code path. A `#error` directive catches invalid values.

**Benefits over autodetection:**
- No destructive probing (`$PCAS10,0` hot start on L76K detection)
- No risk of misdetection sending UBX binary packets to an L76K
- ~1 s faster boot (no 4-phase probe state machine)
- Smaller binary (~80 bytes saved from removed probe code)

---

## 7. End-to-End Coherence Check

The table below confirms each layer of the stack is consistent after the M10Q transition. The CSV format is unchanged, so the analyser requires no modifications.

| Layer | Current State (L76K) | M10Q Required Change |
|-------|----------------------|----------------------|
| **Hardware baud** | 115200 (`$PCAS01,5`) | 115200 (`$PUBX,41,1,0007,0001,...*1A`) — same rate, different command |
| **Update rate** | 5 Hz (`$PCAS02,200`) | 10 Hz (`UBX-CFG-RATE` 100 ms) — HP-mode maximum per datasheet Table 1; no separate HP-enable packet required on SPG 5.10 |
| **Constellations** | GPS+BeiDou+GLONASS (`$PCAS04,7`) | GPS+GLONASS+BeiDou+Galileo (M10Q default; verify with `UBX-CFG-GNSS` if needed) |
| **Sentence filter** | `$PCAS03` (GGA+GSA+RMC+GSV@1Hz) | `UBX-CFG-MSG` — same set, same rates |
| **Navigation model** | None (L76K Portable only) | Pedestrian or Wrist via `UBX-CFG-NAV5` at init |
| **Hot start** | `$PCAS10,0*1C` | `UBX-CFG-RST` binary packet |
| **Galileo GSA (system_id=3)** | ❌ Bug: fell to GN/GPS fallback — Galileo PRNs corrupted sat_elevation | ✅ Fixed: explicit `GA` branch, offset 350 |
| **Galileo GSV (`$GAGSV`)** | ❌ Bug: `GA` talker returned offset 0 — WDOP incorrect | ✅ Fixed: `GA` → offset 350 in `gps_get_constellation_offset` |
| **WDOP accuracy** | Correct for GPS/GLONASS/BeiDou | Improves automatically — Galileo sats now land at correct `sat_elevation` indices |
| **CSV format** | v2.3: 13 cols (timestamp, lat/lon/alt, hdop/vdop/wdop, sats, fix_quality, fix_type, speed_kts, course_deg, gsr_raw) | **No change** — M10Q outputs identical NMEA sentences |
| **CSV logging trigger** | `tick_counter % 2 == 0` (5 Hz at 10 Hz tick rate) | No change |
| **HDOP gate** | 5.0 (`GPS_HDOP_GATE`) | No change — HDOP scale is module-independent |
| **Analyser CSV parsing** | Auto-detects columns by header name | No change |
| **Kalman / velocity smoother** | Uses `wdop`, `speed_kts`, `course_deg` | No change |
| **Road snap** | Uses filtered GPS points | No change |
