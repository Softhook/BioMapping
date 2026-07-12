# M10Q Implementation Reference: u-blox SAM-M10Q GNSS Module

> **Status: IMPLEMENTED (2026-07-12).**  All bugs fixed, all features shipped.
> Compile with `#define GPS_MODULE GPS_MODULE_M10Q` in `biomap_config.h`.

This document provides a complete reference for the u-blox SAM-M10Q integration in the BioMapping Flipper Zero application. It covers hardware constraints, protocol configuration, constellation mapping, power management, and AssistNow autonomous orbit prediction.

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
  $PUBX,41,1,0007,0002,115200,0*19\r\n
  ```
  Parameters: `portID=1` (UART1), `inProtMask=0007` (NMEA+UBX+RTCM input — UBX input must be enabled so binary UBX config packets work), `outProtMask=0002` (NMEA output **only**).  The u-blox bitmask is: 0=no output, 1=UBX, 2=NMEA, 3=UBX+NMEA.  Setting `0001` would disable all NMEA output — the parser would receive zero valid sentences.
* **Timing Sensitivity**: When switching the baud rate, the Flipper must wait long enough to ensure the command is fully transmitted over the TX line at 9600 bps before the Flipper changes its own USART1 baud rate to 115200. The existing 300 ms delay (`furi_delay_ms(300)`) is sufficient to prevent synchronization loss.

> **⚠️ Checksum note**: The correct checksum for `$PUBX,41,1,0007,0002,115200,0` is `*19`. Using `outProtMask=0001` (UBX-only — disables NMEA) produces `*1A` — do not use this variant as it would disable all NMEA output the parser needs.

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

## 4. M10Q Configuration Sequence (IMPLEMENTED)

Executed in `gps_uart_configure()` in [`modules/gps_uart.c`](../modules/gps_uart.c).

### Step 1 — At 9600 baud (ASCII NMEA)

Send the PUBX baud switch command, then wait before reconfiguring the STM32 USART:

```
$PUBX,41,1,0007,0002,115200,0*19\r\n   ← baud switch; inProt=NMEA+UBX, outProt=NMEA only
[wait 300 ms]
[reconfigure STM32 USART1 to 115200]
[flush RX stream buffer, restart async RX]
[wait 100 ms]
```

### Step 2 — At 115200 baud (binary UBX packets)

All packets include the full `B5 62` sync header and verified Fletcher-8 checksums.

#### 1. Set Update Rate to 10 Hz (`UBX-CFG-RATE`)
Sets the measurement period to 100 ms. SAM-M10Q datasheet Table 1: 10 Hz is the high-performance-mode maximum for the default 4-constellation config.
* **Hex**: `B5 62 06 08 06 00 64 00 01 00 01 00 7A 12`

#### 2. Disable NMEA GLL (`UBX-CFG-MSG`)
* **Hex**: `B5 62 06 01 03 00 F0 01 00 FB 11`

#### 3. Disable NMEA VTG (`UBX-CFG-MSG`)
* **Hex**: `B5 62 06 01 03 00 F0 05 00 FF 19`

#### 4. Throttle NMEA GSV to 1 Hz (`UBX-CFG-MSG`)
* **Hex**: `B5 62 06 01 03 00 F0 03 0A 07 1F`

#### 5. Set Dynamic Model to Pedestrian (`UBX-CFG-NAV5`)
`mask=0x0001`, `dynModel=0x03` (Pedestrian). For wrist/handheld use, substitute `dynModel=0x08` (Wrist).
* **Pedestrian**: `B5 62 06 24 28 00 01 00 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 56 3E`

#### 6. Enable AssistNow Autonomous (`UBX-CFG-VALSET`)
Key `CFG-ANA-USE_ANA` (`0x10230001`) = 1, stored in RAM. Enables autonomous orbit prediction — the module computes ephemeris extensions in the background whenever it has a valid lock. Reduces TTFF on subsequent cold starts from ~23 s to ~4 s.
* **Hex**: `B5 62 06 8A 09 00 00 01 00 00 01 00 23 10 01 CF C0`
* See Section 8 for details.

#### 7. Hot Start Reset (`UBX-CFG-RST`)
Controlled software reset (GNSS only). Used by `gps_uart_send_hot_start()`.
* **Hex**: `B5 62 06 04 04 00 00 00 02 00 10 68`

#### 8. Software Standby (`UBX-RXM-PMREQ`)
Forces the module into Software Standby (~46 µA). Used in `gps_uart_free()` and during GSR-only sessions.
* **Hex**: `B5 62 02 41 10 00 00 00 00 00 00 00 00 00 02 00 00 00 01 00 00 00 56 2F`
* Parameters: `duration=0` (infinite), `flags.force=1`, `flags.backup=0` (Software Standby), `wakeupSources.uartrx=1`.
* See Section 9 for details.

### Init sequence code reference

```c
// gps_uart_configure() — M10Q path
pubx_tx(g, "$PUBX,41,1,0007,0002,115200,0*19\r\n");
furi_delay_ms(300);
// switch host to 115200
ubx_tx(g, ubx_cfg_rate_10hz, sizeof(ubx_cfg_rate_10hz));
ubx_tx(g, ubx_cfg_msg_gll_off, sizeof(ubx_cfg_msg_gll_off));
ubx_tx(g, ubx_cfg_msg_vtg_off, sizeof(ubx_cfg_msg_vtg_off));
ubx_tx(g, ubx_cfg_msg_gsv_1hz, sizeof(ubx_cfg_msg_gsv_1hz));
ubx_tx(g, ubx_cfg_nav5_pedestrian, sizeof(ubx_cfg_nav5_pedestrian));
ubx_tx(g, ubx_cfg_assistnow_autonomous, sizeof(ubx_cfg_assistnow_autonomous));
```

---

## 5. Risk Mitigation (All Resolved)

* **Risk 1 — Legacy `UBX-CFG-` commands deprecated** ✅: M10 SPG 5.10 still accepts legacy commands. CFG-VALSET migration is a future task.

* **Risk 2 — `outProto` bitmask** ✅: Fixed 2026-07-12 — `0001` (UBX-only) changed to `0002` (NMEA-only). Verified against u-blox spec: 0=no output, 1=UBX, 2=NMEA, 3=UBX+NMEA.

* **Risk 3 — PUBX command not acknowledged** ✅: NMEA watchdog (5 s timeout → hot start + reconfigure) detects and recovers from silent baud mismatch. Watchdog now arms immediately at alloc (`last_valid_nmea_tick = furi_get_tick()`) — a botched initial baud switch triggers one-shot recovery rather than permanent desync. See Section 7.2.

---

## 6. Firmware Implementation (All Implemented)

### 6.1 `gps_uart_configure()` — IMPLEMENTED ✅

The function uses `#if GPS_MODULE == GPS_MODULE_M10Q` preprocessor guards. Full M10Q init sequence as described in Section 4. L76K path preserved and unchanged.

### 6.2 `ubx_tx()` Helper — IMPLEMENTED ✅

```c
static void ubx_tx(GpsUart* g, const uint8_t* data, size_t len) {
    furi_hal_serial_tx(g->serial_handle, data, len);
    furi_delay_ms(100);
}
```

All UBX packets stored as `static const uint8_t` arrays in `gps_uart.c`. Declarations moved above `gps_uart_alloc` so the wake-up byte path can reference them.

### 6.3 `gps_uart_send_hot_start()` — IMPLEMENTED ✅

Sends `UBX-CFG-RST` binary packet instead of `$PCAS10,0`. Guarded by `#if GPS_MODULE == GPS_MODULE_M10Q`.

### 6.4 Module Selection — IMPLEMENTED ✅

```c
#define GPS_MODULE_L76K  1
#define GPS_MODULE_M10Q  2
#define GPS_MODULE       GPS_MODULE_M10Q  // ← change this when swapping hardware
```

Single compile-time define in `biomap_config.h`. No runtime autodetection.

---

## 11. End-to-End Coherence Check

The table below confirms each layer of the stack is consistent after the M10Q transition. The CSV format is unchanged, so the analyser requires no modifications.

| Layer | Current State (L76K) | M10Q Required Change |
|-------|----------------------|----------------------|
| **Hardware baud** | 115200 (`$PCAS01,5`) | 115200 (`$PUBX,41,1,0007,0002,...*19`) — same rate, different command; outProto=0002 = NMEA only |
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

---

## 7. Critical Bug Fixes (2026-07-12)

### 7.1 `outProto` Bitmask: `0001` → `0002`

**Bug**: The `$PUBX,41` baud switch command set `outProto=0001`. The u-blox spec defines this field as a bitmask: 0=no output, **1=UBX**, 2=NMEA, 3=UBX+NMEA. Setting `0001` configured the module to output **only binary UBX frames** — zero NMEA. The `minmea` parser received no valid `$Gx` sentences.

**Fix**: Changed `outProto=0002` (NMEA only), checksum `*1A` → `*19`.

```
$PUBX,41,1,0007,0002,115200,0*19\r\n
```

### 7.2 NMEA Watchdog: Armed Too Late

**Bug**: `last_valid_nmea_tick` was initialized to `0` in `gps_uart_alloc`. The watchdog condition is `if(g->last_valid_nmea_tick > 0)`. If the initial `$PUBX,41` baud switch failed (corrupted at 9600 baud), the module stayed at 9600 while the Flipper switched to 115200. No valid NMEA was ever received, `last_valid_nmea_tick` stayed `0`, and the watchdog **never fired** — permanent desync.

**Fix**: Initialize `last_valid_nmea_tick = furi_get_tick()` in `gps_uart_alloc`. If boot-up sync fails, the watchdog triggers after 5 seconds, resets the host to 9600, and re-attempts configuration. Sets `last_valid_nmea_tick = 0` during recovery → one-shot retry (won't spam on disconnected module).

---

## 8. AssistNow Autonomous (IMPLEMENTED)

AssistNow Autonomous enables the M10Q to compute its own orbit predictions in the background whenever it has a valid satellite lock. These predictions are stored in RAM and survive Software Standby (but not power loss — BBR storage would require layer=2).

**Benefits:**
- Cold-start TTFF drops from ~23 s to ~4 s (datasheet Table 1)
- No external aiding data required — fully self-contained
- Predictions valid for up to 2 days after last fix

**Configuration packet** (`UBX-CFG-VALSET`):
```
B5 62 06 8A 09 00  00 01 00 00  01 00 23 10  01  CF C0
```
- Key: `0x10230001` = `CFG-ANA-USE_ANA`
- Value: `0x01` = enabled
- Layer: `0x01` = RAM (survives standby, lost on power cycle)

**Verification**: Checksum validated against Fletcher-8 algorithm. Packet sent during `gps_uart_configure()` after the nav5 model config.

---

## 9. Software Standby Power Management (IMPLEMENTED)

The M10Q supports Software Standby mode (~46 µA on V_IO, ~120 nA on VCC per datasheet Table 15), preserving RAM state including baud rate and constellation config. Wake-up is triggered by a falling edge on the UART RX pin.

### 9.1 Sleep Path (`gps_uart_free`)

When the GPS handle is released, the module is put into Software Standby:

```c
ubx_tx(g, ubx_rxm_pmreq_standby, sizeof(ubx_rxm_pmreq_standby));
```

**Standby packet** (`UBX-RXM-PMREQ`):
```
B5 62 02 41 10 00  00 00 00 00  00 00 00 00  02 00 00 00  01 00 00 00  56 2F
```
- `duration=0` (infinite sleep)
- `flags=0x02` (bit 1: force=1 — enter immediately, don't wait for pending ops)
- `flags` bit 0: backup=0 → Software Standby (not Hardware Backup)
- `wakeupSources=0x01` (bit 0: uartrx — wake on UART RX edge)

### 9.2 Wake-Up Path (`gps_uart_alloc`)

Before starting async RX, a dummy `0xFF` byte is sent at 9600 baud to trigger the UART RX edge detection:

```c
uint8_t dummy = 0xFF;
furi_hal_serial_tx(g->serial_handle, &dummy, 1);
furi_delay_ms(100);
```

**Known limitation**: On warm boot (module was sleeping at 115200), the 0xFF at 9600 causes a framing error on the module side. The edge detection still triggers wake-up, but the subsequent `$PUBX,41` at 9600 is lost. Since both sides are already at 115200 and `outProto=0002` is preserved in standby RAM, the UBX config packets that follow still get through correctly. This is functional but fragile — a future improvement would track the module's baud rate across sleep/wake cycles.

---

## 10. GSR-Only Session Integration (IMPLEMENTED)

In GSR-only recording mode, the GPS module is not needed during the session. To save power, `run_recording_session()` in [`biomap_session.c`](../biomap_session.c) briefly allocates and immediately frees the GPS handle:

```c
if(has_gps(mode)) {
    s->gps = gps_uart_alloc(app->event_queue, app->notifications);
} else {
    // GSR only: briefly allocate and free GPS to push it into Software Standby
    GpsUart* temp_gps = gps_uart_alloc(app->event_queue, app->notifications);
    if(temp_gps) {
        gps_uart_free(temp_gps);
    }
    s->gps = NULL;
}
```

This triggers the full alloc → configure → free → standby cycle, leaving the module in ~46 µA standby for the duration of the GSR recording. `session_deinit()` is NULL-guarded for `s->gps`.
