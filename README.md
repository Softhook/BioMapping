# BioMapping 2.0 
# Christian Nold 2026

The Complete Build & Software Guide (ADS1115 Transimpedance Amplifier Edition)

## 1. Introduction: What is BioMapping 2.0?
BioMapping 2.0 is a new version of Christian Nold's Bio Mapping project for the **Flipper Zero**. 
It allows you to walk through a city or landscape and record your body's physiological arousal mapped precisely to geographical coordinates. 

The Flipper logs your Galvanic Skin Response (GSR) together with GPS coordinates and SubGHz RF environmental spectrum levels (815/868/915 MHz) to a CSV file on the SD card. You then load that CSV into the included browser-based visualiser (`visualiser/index.html`), which decomposes the signal into tonic/phasic components, detects arousal peaks, correlates RF noise density (rendered via its own RF fluid canvas), and renders your route on a map **coloured by arousal**. In collective mode it builds an interpolated (IDW) contour surface across one or more walks, so calm stretches read as a flat "baseline" landscape while stress or arousal rises into "mountains" and deep relaxation drops into "valleys".

This version of the device uses a dedicated 16-bit **ADS1115** Analog-to-Digital Converter combined with a robust and stable **Transimpedance Amplifier (TIA)** circuit. By utilising a rail-to-rail dual op-amp for active voltage buffering and hardware low-pass filtering, we achieve a precise, robust and noise-resistant way to measure the tiny changes in human sweat gland activity. All background sampling (GSR ADC reads at 860 SPS and interleaved SubGHz RF band sweeps) is handled by a **single unified background worker thread** (`GsrSensorWorker` in [`modules/gsr_sensor.c`](modules/gsr_sensor.c)).

The firmware supports two GPS modules, selected at compile time via `GPS_MODULE` in [`biomap_config.h`](biomap_config.h):
* **u-blox SAM-M10Q** (`GPS_MODULE_M10Q`, the compile-time default) — integrated patch antenna, up to 10 Hz update rate, Software Standby power saving, AssistNow autonomous orbit prediction
* **Quectel L76K** (`GPS_MODULE_L76K`, older alternative, still supported) — external U.FL antenna, up to 5 Hz update rate, PCAS protocol

See [`m10q_capabilities.md`](docs/m10q_capabilities.md) for the full M10Q implementation reference.

---

## 2. Hardware Requirements
To build this, you need the following physical components:

**Core Boards:**
* **Flipper Zero**
* **u-blox SAM-M10Q GNSS Breakout** (default) or **L76K GNSS Prototyping Shield** (older alternative, still supported): Provides GPS positioning. The SAM-M10Q has an integrated 15×15 mm ceramic patch antenna (no external antenna needed), boots at 9600 baud, and supports 10 Hz updates with 4-constellation concurrent reception (GPS+Galileo+GLONASS+BeiDou). The L76K shield also provides a blank 126-hole grid for your custom circuit.
* **Flipper Zero Prototyping Board:** Only needed with the SAM-M10Q breakout, since it (unlike the L76K shield) doesn't include a built-in prototyping grid. Mounts the ADS1115 and op-amp biometric circuit — see Phase 3 below.
* **ADS1115 Breakout Board:** A high-precision 16-bit I2C ADC chip.

**Active Components:**
* **1x rail-to-rail dual op-amp** (MCP602, MCP6002, MCP6042, or equivalent 3.3V CMOS dual op-amp)

**Passive Components:**
* **1x 56kΩ Resistor** (For the voltage divider 0.1% tolerance metal film)
* **1x 10kΩ Resistor** (For the voltage divider 0.1% tolerance metal film)
* **1x 47kΩ Resistor** (For the TIA gain/feedback 0.1% tolerance metal film)
* **2x 4.7kΩ Resistors** (For safety inline with the electrodes 0.1% tolerance metal film)
* **2x 100nF (0.1µF) Ceramic Capacitors** (One for power bypass, one for the feedback filter)

**Biometric Interface:**
* **GSR Finger Electrodes:** Standard biometric finger clips or simple velcro strips with aluminum foil/copper tape.

---

## 3. The Wiring Guide & Hardware Surgery (Step-by-Step)

### Phase 1: Freeing the I2C Bus (Trace Cuts)
With the default SAM-M10Q breakout, no trace cuts are needed — it connects via UART only and does not occupy Pin 15 (PC1) / Pin 16 (PC0), leaving them free for the ADS1115 I2C bus.

If using the older L76K shield instead: the two copper traces connecting **Pin 15 (PC1)** and **Pin 16 (PC0)** to the GPS module must be physically cut. These pins are for exclusive use by the ADS1115 I2C bus.

* Pin 15 (PC1) — **no longer connected to GPS** → used for I2C **SDA**
* Pin 16 (PC0) — **no longer connected to GPS** → used for I2C **SCL**

### Phase 2: GPS Hardware Reroute
**SAM-M10Q (default):** No additional wiring needed beyond UART TX/RX and 3.3V/GND. The M10Q supports Software Standby (~46 µA) via UBX command — no dedicated STANDBY or RESET wires required. Wake-up is triggered by a falling edge on the UART RX pin. See [`m10q_capabilities.md`](docs/m10q_capabilities.md#53-software-standby-power-management--wake-up) for the sleep/wake protocol.

**L76K (older alternative):** No additional wiring needed. The L76K cannot be put to sleep via software, so no STANDBY or RESET wires need to be soldered. The GPS runs continuously. Software reset commands are available over UART for error recovery — see **Section 4a**.

### Phase 3: Installing the Biometric Sensor Circuit
Mount the ADS1115 and the dual op-amp onto the prototyping grid — the L76K shield's built-in grid, or, with the default SAM-M10Q breakout, the separate Flipper Zero Prototyping Board. Both channels are used (one as a voltage follower for V_ref, one as the TIA).

**Standard 8-pin dual op-amp pinout** (MCP602, MCP6002, MCP6042, and equivalents):
```
Pin 1 = Out A     Pin 8 = 3.3V
Pin 2 = In- A     Pin 7 = Out B
Pin 3 = In+ A     Pin 6 = In- B
Pin 4 = GND       Pin 5 = In+ B
```

* **Power & I2C (ADS1115):**
  * `VDD` on ADS1115 -> **Pin 9 (3.3V)**
  * `GND` on ADS1115 -> **Pin 8 (GND)**
  * `ADDR` on ADS1115 -> **Pin 8 (GND)** *(Hardcodes the I2C address to 0x48)*
  * `SDA` on ADS1115 -> **Pin 15 (PC1)**
  * `SCL` on ADS1115 -> **Pin 16 (PC0)**
 

* **Power & Bypass (dual op-amp):**
  * Pin 8 -> **Pin 9 (3.3V)**
  * Pin 4 -> **Pin 8 (GND)**
  * **Mandatory:** Solder one **100nF capacitor** directly across Pin 8 and Pin 4 to filter digital power spikes from the Flipper.

* **Generate the 0.5V Bias (V_ref) using Op-Amp B (Voltage Follower):**
  * Solder the **56kΩ Resistor** from 3.3V to the op-amp's In+ B (pin 5).
  * Solder the **10kΩ Resistor** from In+ B (pin 5) to GND.
  * Tie Out B (pin 7) directly to In- B (pin 6).
  * *Result: Pin 7 is now a buffered 0.5V Reference (V_ref).*

* **Build the Transimpedance Amplifier (TIA) using Op-Amp A:**
  * Connect V_ref (from Out B) to the op-amp's In+ A (pin 3).
  * Tie the **47kΩ Resistor** and the second **100nF Capacitor** in parallel between Out A (pin 1) and In- A (pin 2). This acts as both the amplifier gain and a hardware low-pass filter to destroy 50/60Hz mains hum.

* **Connect Electrodes & Safety Resistors:**
  * Electrode 1 (GND): GND -> **4.7kΩ Resistor** -> Wire -> Foil/Finger 1.
  * Electrode 2 (SIGNAL): Foil/Finger 2 -> Wire -> **4.7kΩ Resistor** -> op-amp In- A (pin 2).
  * *These resistors (9.4 kΩ total) ensure maximum skin current is safe while keeping the TIA output within the ADC range for the full span of human skin resistance.*

* **Differential Connection to ADS1115:**
  * Connect **ADS1115 AIN0** to op-amp Out A (pin 1) (The amplified GSR signal).
  * Connect **ADS1115 AIN1** to op-amp Out B (pin 7) (The clean 0.5V V_ref).

By routing the signals this way, the ADS1115 subtracts the 0.5V virtual ground offset perfectly, isolating the amplified skin current data while completely rejecting external system noise!

---

## 4. Software Architecture

Writing this app in C is highly efficient with the ADS1115 in differential mode. We configure the ADS1115 to measure the exact difference between A0 and A1.

### Reading the ADS1115 with Dynamic PGA Auto-Ranging
To capture the full dynamic range of human skin resistance with maximum sensitivity and resolution, the software implements active **PGA (Programmable Gain Amplifier) Auto-Ranging** using the normal differential pins (AIN0 and AIN1) on the ADS1115.

The core module `gsr_sensor.c` runs a background thread to read the ADS1115 at 860 SPS, applying the following logic:
1. **Dynamic Gain Scaling:** 
   - **Range Down (Avoid Clipping):** If the absolute differential voltage exceeds 30,000 counts (~91.5% of full scale), the PGA gain index is immediately decreased (e.g. from ±0.512V to ±1.024V) to widen the range.
   - **Range Up (Increase Resolution):** If the absolute reading remains below 4,096 counts (~12.5% of full scale) for 5 consecutive ticks, the PGA gain index is increased (e.g. from ±2.048V to ±1.024V) to narrow the range.
2. **Output Normalization:** To ensure downstream filters (EMA and Derivative) receive a consistent signal, all hardware readings are normalized back to a common baseline of the ±0.256V range (where 1 LSB = 7.8125 µV) regardless of the active hardware gain setting.
3. **Simple-Mean Oversampling:** Rather than averaging a fixed sample count (which would double in duration if the worker thread rate varied), the decimation window is strictly time-based, spanning exactly the last 100 ms. Because the worker thread rate averages ~400–500 Hz on real Flipper Zero hardware, this window contains approximately 40 to 50 samples tick-to-tick. A 100 ms window duration cancels sinusoidal 50/60 Hz mains hum perfectly (100 ms = 5 cycles of 50 Hz = 6 cycles of 60 Hz) regardless of sample count. The resulting noise-reduction factor is $\approx 6.7\times$ (scaling with $\sqrt{N}$), providing a highly stable baseline. Empirical testing (873-sample recording) confirmed zero I2C glitches — all large tick-to-tick jumps were sustained physiological SCR onsets, not noise spikes that would benefit from trimming.
4. **Conductance Conversion:** The filtered voltage is translated into physical skin conductance in nanosiemens (nS) using the TIA circuit equation.

Here is the core logic for writing the dynamic PGA configuration and reading the raw ADC conversion registers:

```c
// Configure the ADS1115 config register dynamically:
// - MUX = 000 (AIN0-AIN1 differential mode)
// - PGA = active PGA gain index (ranges from 0x80 to 0x8A dynamically)
// - MODE = 0 (Continuous conversion mode)
// - DR = 111 (860 samples per second)
uint8_t cfg[2] = { 0x80u | (active_pga << 1), 0xE3 }; 
furi_hal_i2c_write_mem(&furi_hal_i2c_handle_external, ADS1115_I2C_ADDR, ADS1115_CONFIG_REG, cfg, 2, 50);

// Read the raw 16-bit differential conversion value
uint8_t data[2];
furi_hal_i2c_read_mem(&furi_hal_i2c_handle_external, ADS1115_I2C_ADDR, ADS1115_CONV_REG, data, 2, 50);
int16_t hw_val = (int16_t)((data[0] << 8) | data[1]);
```

### Challenge: SD Card Lag
Writing data to the Flipper's SD card takes a few milliseconds — occasionally much longer on a real card (see `docs/gps_rf_mutex_status.md` for the full investigation into this). If we write every measurement to the card individually, the app will freeze up.

**The Solution:** Every mode formats its CSV row into an in-memory batch buffer every 10 Hz tick, and the batch is flushed to the SD card in one `storage_file_write()` + `storage_file_sync()` call every `FLUSH_INTERVAL` (= 10) seconds — ~100 rows per flush at 10 Hz. The recording LED blinks once per second, decoupled from the flush cadence.

- **GPS + GSR + RF / GPS + GSR modes:** Every tick carries the **most recent** GPS fix — the latest parsed position is used as-is (carried forward), not interpolated to the GSR timestamp. A full GPS+GSR row (11 core columns, +3 RF columns in GPS+GSR+RF) is formatted each tick.
- **GPS + RF mode:** A GPS row is written every tick; there is no high-frequency GSR data, so `gsr_raw` is always `0.0`.
- **GSR Only mode:** A 2-column row (`timestamp`,`gsr_raw`) is written every tick; no GPS driver is initialised (the module is put into Software Standby on M10Q hardware to save power).

The SD log file is also pre-allocated once, up front, to its expected full size when a recording starts (`BIOMAP_SD_PREALLOC`, `modules/sd_logger.c`), then trimmed back down to the real data length when the recording stops — this reduces filesystem overhead from the file growing incrementally across a long recording. See `docs/gps_rf_mutex_status.md`'s "option E" entries for the investigation behind this.

---

## 4b. Multi-Rate Architecture: 10 Hz GSR, 10 Hz GPS

The app operates two independent data pipelines because GSR and GPS have fundamentally different time characteristics:

| Signal | Sample Rate | Why |
|---|---|---|
| **GSR** | 10 Hz (tick) | Skin conductance changes in 0.5–5 seconds — 10 Hz captures physiological events with headroom |
| **GPS (CSV rows)** | 10 Hz (`GPS_CSV_HZ`) | CSV rows are written at the 10 Hz tick rate in every GPS mode. |
| **GPS (module fixes)** | up to 10 Hz | The module updates position over UART at up to 10 Hz (SAM-M10Q, default) or up to 5 Hz (L76K). When the module is slower than 10 Hz, consecutive CSV rows repeat the most recent fix. |

### Timestamp Sources

Each CSV row's first column (`timestamp`) is a **relative time in seconds since the start of the recording**, written as a float with 0.1 s resolution (`%.2f`, e.g. `12.30`) — it is *not* an ISO 8601 string. The **absolute** start time is written once, in the file's metadata header, as a Unix epoch:

```
# RecordingStartTime:1751204579
# Band Floors (dBm): 815:-91.5,868:-91.5,915:-91.5
```

The `# Band Floors` line only appears when RF is active for the session (GPS + GSR + RF or GPS + RF) **and** an RF calibration exists — it's the per-band noise floor from RF Calibration (Section 8), used by the visualiser to normalise RSSI readings.

| Field | Source | Notes |
|---|---|---|
| `RecordingStartTime` (header) | Flipper Zero internal RTC (`furi_hal_rtc_get_datetime`) at record start, converted to Unix epoch (UTC) | `0` if the Flipper RTC has never been set |
| `timestamp` (per row) | Monotonic 10 Hz tick counter | Seconds since record start; add to `RecordingStartTime` for absolute UTC |

Set the Flipper RTC to UTC before recording so that `RecordingStartTime` is meaningful. Absolute wall-clock time for any row is `RecordingStartTime + timestamp`.

### GSR Signal Chain

```
ADS1115 @ 860 SPS  ──►  Background worker thread
                              │
                     Ring buffer (128 samples)
                              │
                     gsr_sensor_tick() @ 10 Hz
                              │
                     ┌────────┴────────┐
                     │                 │
               Simple mean        PGA autoranging
               (100 samples)      (hysteretic, 5-tick)
                     │                 │
                     └────────┬────────┘
                              │
                     TIA equation → nanosiemens (nS)
                              │
                     IIR low-pass fc≈3 Hz
                     (post-decimation smoothing, α=0.848)
                              │
                     ┌────────┴────────┐
                     │                 │
               EMA α=0.2          Graph derivative
               (display smooth)   (rate-of-change)
                     │                 │
                 1 Hz CSV            graph_buf[]
                 (all modes)         (derivative display)
```

**Post-decimation smoothing rationale:** The 100 ms boxcar average is the pre-decimation (anti-aliasing) filter — it provides ~4 dB at the 5 Hz Nyquist frequency and perfectly cancels sinusoidal 50/60 Hz mains hum (100 ms = 5 cycles of 50 Hz = 6 cycles of 60 Hz). Aliasing from the 860→10 Hz downsampling cannot be undone, but a post-decimation first-order IIR at 3 Hz (α = 0.848) attenuates both real high-frequency GSR and any aliased noise that leaked into the 0–5 Hz band. Since >95 % of GSR signal power is below 1 Hz, the net SNR improves: real phasic GSR at 2 Hz loses <0.5 dB, while broadband EMI (BLE radio, switching artifacts) that passed through the boxcar sidelobes is suppressed. The IIR costs one multiply-add per tick (~3 CPU cycles) and introduces ~50 ms phase lag at 1 Hz — invisible for GSR where phasic responses have 1–3 s rise times.  See `smooth_iir_filter()` in `biomap_session.c`.

### GPS Signal Chain

```
M10Q GPS @ 10 Hz  ──►  UART interrupt handler
                              │
                     NMEA sentence parser
                              │
                     GpsStatus struct (lat, lon, alt, sats, fix)
                              │
                     Read on each tick, write to CSV batch
```

### CSV Formats

Every mode has two variants: a **production** schema (the columns below) and a wider **debug** schema with diagnostic columns appended. Which one gets written is chosen per-session by **Options > Debug Fields** (off by default) — see [Debug Fields](#debug-fields) below. [`docs/csv_schema.md`](docs/csv_schema.md) is the canonical, versioned reference for every column; this section shows representative examples.

**GPS + GSR + RF mode (14 columns, 10 Hz):**
```
# RecordingStartTime:1751204579
# Band Floors (dBm): 815:-91.5,868:-91.5,915:-91.5
timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,rssi_868,rssi_915
0.00,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4523.0,2.4,-91.5,-88.0,-95.0
0.10,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4528.0,2.3,-91.5,-88.0,-95.0
...
```

**GPS + GSR mode (11 columns, 10 Hz):**
```
# RecordingStartTime:1751204579
timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m
0.00,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4523.0,2.4
0.10,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4528.0,2.3
0.20,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4521.0,2.5
...
```
When there is no valid fix this tick, `lat`/`lon` and all other GPS columns are left empty (e.g. `0.30,,,,,,,,,4519.0,`) so the visualiser treats the row as a GPS gap rather than a `(0,0)` coordinate. `hacc_m` (horizontal accuracy in meters, from `$PUBX,00`) is **M10Q-only** — it stays `99.9` (unknown) on L76K hardware.

**GPS + RF mode (14 columns, 10 Hz):** same shape as GPS + GSR + RF above, but `gsr_raw` is always `0.0` — no GSR sensor is initialised in this mode.

**GSR Only mode (2 columns, 10 Hz):**
```
# RecordingStartTime:1751204579
timestamp,gsr_raw
0.00,4523.0
0.10,4528.0
0.20,4521.0
...
```
Each row is a point reading of skin conductance in nanosiemens at 10 Hz. This resolution allows offline re-analysis with different filter parameters.

### Debug Fields

**Options > Debug Fields** (off by default, persisted, takes effect on the *next* recording) appends diagnostic columns to every mode's rows — added incrementally over the course of firmware development to track down real timing/reliability issues (see `docs/gps_rf_mutex_status.md`), not needed for normal use. With it on, GPS + GSR / GPS + GSR + RF grow to 27/30 columns and GSR Only grows to 9, adding:

| Column | Meaning |
|---|---|
| `tick_dt_ms` | Real elapsed ms since the previous tick (contention/stall diagnostic) |
| `gps_rx_drops`, `nmea_fail`, `gps_reinit_count` | Cumulative GPS UART error counters (GPS-bearing modes only) |
| `gsr_hz` | GSR worker's real achieved sample rate |
| `i2c_peak_ms`, `rf_rssi_peak_ms`, `rf_retune_peak_ms` | Worst single GSR I2C / RF SPI call ever seen this session |
| `flush_peak_ms` | Worst single SD batch flush (write+sync) ever seen this session |
| `log_fill_bytes`, `log_fill_peak_bytes`, `log_overflow_count`, `log_flush_fail_count` | SD logger batch-buffer occupancy and continuity-risk counters |
| `pga_change_count`, `i2c_consec_fail` | Cumulative GSR auto-ranging gain switches / consecutive I2C failure run length |
| `prealloc_ms` | How long the one-shot SD log-file pre-allocation took at recording start |

All are lifetime-max or cumulative-since-start except `prealloc_ms`, which is set once and stays constant for the file. See [`docs/csv_schema.md`](docs/csv_schema.md) for the authoritative column order and [`docs/gps_rf_mutex_status.md`](docs/gps_rf_mutex_status.md) for what each one was added to diagnose.

---

## 4a. GPS Error Recovery

The GPS module can be reset via a software hot-start command to recover from stale or frozen data.

**SAM-M10Q (UBX protocol):** Sends a binary `UBX-CFG-RST` packet over UART at 115200 baud. This performs a controlled GNSS-only reset without affecting the Flipper interface. See [`m10q_capabilities.md`](docs/m10q_capabilities.md#52-binary-configuration-packets-ubx-protocol) item 7 for the full hex packet.

```c
// M10Q hot start — binary UBX-CFG-RST packet
static const uint8_t ubx_cfg_rst_hot[] = {
    0xB5, 0x62, 0x06, 0x04, 0x04, 0x00, 0x00, 0x00, 0x02, 0x00, 0x10, 0x68
};
ubx_tx(g, ubx_cfg_rst_hot, sizeof(ubx_cfg_rst_hot));
```

**L76K (legacy — PCAS protocol):** Sends ASCII PCAS commands. The L76K cannot be put to sleep via software.

| Action | Command | When to use |
|---|---|---|
| **Hot Start** | `$PCAS10,0*1C\r\n` | GPS is outputting stale/frozen data — restarts quickly using cached satellite info |
| **Factory Reset** | `$PCAS10,3*1F\r\n` | GPS is completely hung or unresponsive — clears everything and starts fresh |

---

## 5. Signal Processing: Finding Mountains and Valleys

Raw differential voltage numbers reflect your baseline sweat levels. We only care about **sudden changes** (spikes in arousal or drops into relaxation). 

To find this, we use two math concepts operating on the 10 Hz data stream:

1. **Smoothing (Exponential Moving Average):** Raw electrical data is noisy. We smooth it out.
   `Smoothed_Value = (0.2 * Raw_Value) + (0.8 * Previous_Smoothed_Value)`
2. **Derivative (Rate of Change):** We subtract the previous smoothed value from the current smoothed value.
   `Rate_of_Change = Smoothed_Value - Previous_Smoothed_Value`

### What the On-Screen Graph Shows

The live graph on the Flipper's display shows the **derivative** (rate-of-change), not the absolute skin conductance. This is an intentional design choice for a tiny screen:

```
     ┌───────────────────────┐
     │    ┌──┐               │   ← arousal onset: conductance rises
     │    │  │               │       derivative spikes upward
     │  ──┘  └────────── ── │   ← baseline: flat line at center
     │          ┌──┐         │       (rate-of-change is zero)
     │          │  │         │   ← relaxation: conductance drops
     └──────────┘  └─────────┘       derivative dips below center
        0          30      60 s
```

- **Line at center** = conductance is stable (no arousal, no relaxation)
- **Line spikes up** = conductance rising (stress / arousal)
- **Line dips below center** = conductance falling (relaxation / recovery)

The absolute conductance value is displayed as a number at the top-right of the screen (e.g. `4523 nS`), giving you both views simultaneously. The CSV file records the absolute nS value — the derivative is only used for the live display.

In our TIA setup:
* **Stress Response (Resistance Drops):** Skin conductance increases, pushing more current through the feedback resistor. `V_out` rises, making the differential read increase. `Rate_of_Change` goes heavily positive.
* **Relaxation (Resistance Climbs):** Current drops, `V_out` falls closer to `V_ref`. `Rate_of_Change` goes negative.

On the live display graph, the derivative is shown with its natural sign — arousal spikes upward, relaxation dips below center. For the arousal mapping in the visualiser (Section 6), only the **magnitude** of change matters: both rapid rises and rapid drops read as high arousal.

### TIA Conductance Equation

The filtered and normalised ADC reading (`N`, in counts at the ±0.256 V reference) is converted to skin conductance in nanosiemens (nS) using the circuit parameters:

$$G_{nS} = \frac{N \times 5{,}000{,}000}{15{,}040{,}000 - N \times 47}$$

**Derivation:**

| Parameter | Value |
|---|---|
| V_ref (voltage divider) | 0.5 V = 3.3 V × 10 kΩ / (56 kΩ + 10 kΩ) |
| R_f (TIA feedback) | 47 kΩ |
| R_safety (two 4.7 kΩ in series) | 9.4 kΩ |
| ADC LSB at ±0.256 V | 7.8125 µV = 1/128,000 V |

1. TIA output: `V_diff = V_out − V_ref = I_skin × R_f = (V_ref / (R_skin + R_safety)) × R_f`
2. In ADC counts: `N = V_diff / 7.8125×10⁻⁶`
3. Solve for skin resistance: `R_skin = 3,008,000,000 / N − 9,400`
4. Convert to nanosiemens: `G_nS = 10⁹ / R_skin`
5. Simplifying: `G_nS = N × 5,000,000 / (15,040,000 − N × 47)`

When `N` approaches zero (open circuit / disconnected electrodes), conductance is clamped to 0. When `N` exceeds 319,000 (near the denominator singularity at `N = 15,040,000 / 47 ≈ 320,000`), the value is clamped to prevent overflow.

### Hardware Accuracy & Comparison to Commercial Devices
The device's accuracy was evaluated using a precision metal-film reference resistor grid (10 kΩ to 9 MΩ). Within the active wear/physiological range, the device exhibits exceptional accuracy and sensitivity:

*   **Ultra-High Accuracy Zone (Error $\le$ ±0.10%):** **47 kΩ to 1 MΩ** (Conductance: $1,000\text{ nS} \le G \le 21,277\text{ nS}$). In this range, where **99.05%** of all active-wear track data falls, the calibration error is virtually non-existent.
*   **High Accuracy Zone (Error $\le$ ±0.50%):** **22 kΩ to 2.2 MΩ** (Conductance: $455\text{ nS} \le G \le 45,455\text{ nS}$). This covers **99.75%** of all active-wear track data.
*   **Acceptable Accuracy Zone (Error $\le$ ±1.00%):** **15 kΩ to 4.7 MΩ** (Conductance: $213\text{ nS} \le G \le 66,667\text{ nS}$). This covers **99.89%** of all active-wear track data.
*   **Open-Circuit Limit:** Below 100 nS ($> 10\text{ M}\Omega$), the device detects an open-circuit state (electrodes disconnected/air).

#### Comparison with Commercial EDA Systems

To put this performance into perspective, here is how the BioMapping 2.0 device compares to prominent research-grade devices (such as the Shimmer3 GSR+ wearable and the laboratory-standard BIOPAC EDA100C) in terms of resolution and accuracy error:

*   **Measurement Method:** Constant Voltage ($0.5\text{ V}$ bias), which matches the standard methodology used by both BIOPAC and Shimmer3.
*   **GSR Resolution:** 
    *   **BioMapping 2.0:** **$< 0.5\text{ nS}$** (enabled by a 16-bit delta-sigma ADC and 100 ms time-based decimation filtering).
    *   **BIOPAC (EDA100C):** **$0.7\text{ nS}$** sensitivity.
    *   **Shimmer3 GSR+:** Variable resolution (utilizes a lower 12-bit ADC, which decreases precision at low skin conductance ranges).
*   **Accuracy Error:**
    *   **BioMapping 2.0:** **$\le$ ±0.10%** error in the primary range ($47\text{ k}\Omega - 1\text{ M}\Omega$), **$\le$ ±0.50%** in the wide range ($22\text{ k}\Omega - 2.2\text{ M}\Omega$), and **$\le$ ±1.00%** across the extreme range ($15\text{ k}\Omega - 4.7\text{ M}\Omega$).
    *   **Shimmer3 GSR+:** **±3%** error in the primary range ($22\text{ k}\Omega - 680\text{ k}\Omega$) and **±10%** error across the wide range ($10\text{ k}\Omega - 4.7\text{ M}\Omega$).
    *   **BIOPAC (EDA100C):** High laboratory-grade accuracy (dependent on careful skin preparation and conductive gel application).

---

## 6. Recording & Post-Processing

### Recording: CSV on the SD Card

When the user presses "Record", the app writes a **CSV file** (`/ext/biomapping/biomap_001.csv`, next free index). This keeps the recording simple and preserves the raw GSR data for offline re-analysis. Visualisation is produced **post-recording** by the browser-based visualiser (see below). See [Section 4b's CSV Formats](#csv-formats) for the current column layouts per mode, and [`docs/csv_schema.md`](docs/csv_schema.md) for the canonical, versioned column reference.

### Post-Processing: The Browser-Based Visualiser

Post-processing happens off-device in the included web visualiser. Open [`visualiser/index.html`](visualiser/index.html) directly in a browser (no server required) and drag-and-drop one or more `biomap_*.csv` files onto it.

The visualiser:

1. **Loads** the CSV, honouring the `#`-prefixed metadata header and the relative-seconds `timestamp` column, and skipping rows with empty `lat`/`lon` (GPS gaps).
2. **Filters** the GSR signal (median / low-pass) and decomposes it into tonic and phasic components (DWT).
3. **Detects peaks** with shape-quality scoring to isolate genuine arousal events.
4. **Maps** the track on a Leaflet base map, **coloured by arousal** — arousal is shown as colour.
5. **Collective mode:** overlays multiple tracks, builds an inverse-distance-weighted (IDW) contour surface, and can enrich the data against OpenStreetMap features (road class, green space, buildings).

Both rapid rises **and** rapid drops in GSR register as high arousal — only the magnitude of change matters, not the direction. See [`docs/csv_schema.md`](docs/csv_schema.md) for the canonical column definitions the visualiser reads.

---

## 7. The User Interface

The Flipper's 128x64 black-and-white screen shows different information depending on the active mode.

### GPS + GSR Mode

```
┌───────────────────────┐
│ Bio Mapping            │
│ ┌───────────────────┐ │
│ │      ~~~          │ │   ← GSR derivative graph (rate-of-change)
│ │  ~~/   \──        │ │      Spikes up = arousal, dips = relaxation
│ │ /         \──     │ │      Full width of screen
│ │/              \──  │ │
│ └───────────────────┘ │
└───────────────────────┘
```

### GPS + GSR + RF / GPS + RF Modes

Same GSR derivative graph and GPS status as above, plus a live per-band RSSI panel down the left edge of the screen (`draw_rf_panel_left()`, `biomap_render.c`) — one bar per SubGHz band (815/868/915 MHz) showing signal level above that band's calibrated noise floor. In GPS + RF mode (no GSR sensor), the freed screen space is used for GPS status instead of a GSR graph.

### GSR Only Mode

```
┌───────────────────────┐
│ Bio Mapping            │
│ GSR: 4523 nS           │   ← Absolute conductance (updated every 0.5 s)
│ ┌───────────────────┐ │
│ │      ~~~          │ │   ← GSR derivative graph (rate-of-change)
│ │  ~~/   \──        │ │      Same derivative view as GPS+GSR mode
│ │ /         \──     │ │
│ │/              \──  │ │
│ └───────────────────┘ │
└───────────────────────┘
```

### Controls

* `OK (Center Button)`: Starts and stops recording. See [Section 4b's CSV Formats](#csv-formats) for the column layout each mode writes.
* `Left/Right`: Changes the time scale of the graph (scroll speed). Left zooms out (slower), Right zooms in (faster).
* `Up/Down`: Zooms in and out on the vertical sensitivity of the graph.
* `Back`: Safely closes the file and returns to the menu.

---

## 8. Menus and Options

### Main Menu

```
┌─────────────────────────────┐
│  Bio Mapping                │
│  ▓ GPS + GSR + RF      ▓   │   ← selected item (inverse bar)
│    GPS + GSR                │
│    GPS + RF                 │
│    GSR Only                 │
│    Options                  │
└─────────────────────────────┘
```

| Menu Item | Action |
|---|---|
| **GPS + GSR + RF** | Enters recording view with GPS, GSR, and RF scanning all active. Writes a 14-column CSV at 10 Hz (11 GPS+GSR columns + `rssi_815`/`rssi_868`/`rssi_915`); each row carries the most recent GPS fix (carried forward, not interpolated). |
| **GPS + GSR** | Enters recording view with GPS and GSR active, RF off. Writes an 11-column CSV at 10 Hz. |
| **GPS + RF** | Enters recording view with GPS and RF active, no GSR sensor initialised. Writes a 14-column CSV at 10 Hz with `gsr_raw` = `0.0`. (`BioMapModeGpsOnly` internally — despite the name, this mode still scans RF.) |
| **GSR Only** | Enters recording view with GSR only — no GPS driver initialised. Writes a 2-column CSV at 10 Hz. The GPS module is placed into Software Standby (M10Q) to save power. |
| **Options** | Opens the Options screen (see below). |

Diagnostics is not on the main menu — it's reached via **Options > Diagnostics** (below).

### Options Screen

```
┌─────────────────────────────┐
│  Options                    │
│  ▓ GPS Profile   Pedestrian▓│   ← selected (inverse bar), cycles with Up/Down
│    Reset GPS                │
│    Auto-zoom GSR       ON   │   ← toggleable
│    GSR Calibration    YES   │   ← YES = custom calibration loaded, NO = default
│    RF Calibration     YES   │   ← YES = custom calibration loaded, NO = default
│    Backlight            ON  │   ← toggleable
│    Sound                ON  │   ← toggleable
│    Diagnostics               │   ← enters diagnostic view
│    Debug Fields         OFF │   ← toggleable
└─────────────────────────────┘
```

| Option | OK Action |
|---|---|
| **GPS Profile** | Cycles the GPS module's dynamic navigation model (Up/Down): Pedestrian (default), Wrist-worn, Vehicle, Stationary, Sea, Bike, or Flight — tunes the GPS chip's internal motion filtering for the activity type. |
| **Reset GPS** | Sends a hot-start command to the GPS module. SAM-M10Q: binary `UBX-CFG-RST` packet. L76K: `$PCAS10,0*1C\r\n` ASCII command. Useful if GPS is outputting stale/frozen data. Leaves a green flash on success, red on failure — and plays a success/error tone (see [Audio Feedback](#audio-feedback) below). |
| **Auto-zoom GSR** | Toggles auto-zoom ON/OFF. When enabled, the graph's vertical scale adjusts automatically to keep peaks visible. When disabled, manual Up/Down zoom controls the scale. Toggling back ON resets the zoom to 1.0× and re-seeds the auto-zoom peak tracker. |
| **GSR Calibration** | Displays the current calibration status (`YES` if custom calibration is active, or `NO` for default). Pressing OK opens the calibration submenu to start the wizard or reset (see below). |
| **RF Calibration** | Displays the current RF Faraday noise-floor calibration status (`YES`/`NO`). Pressing OK opens a submenu with the same shape as GSR Calibration — start the wizard, view the current per-band floors, or reset to default. The result becomes the `# Band Floors` line in a session's CSV header. |
| **Backlight** | Toggles the Flipper's backlight between auto-dimming (OFF) and always-on (ON). Useful for walks in bright sunlight or dark environments. |
| **Sound** | Toggles UI audio feedback ON/OFF (default ON). This toggle always plays its own confirmation click, even when switching sound OFF, so muting is itself audible. All other tones respect this setting. |
| **Diagnostics** | Enters diagnostic mode to view live raw values and sensor health metrics directly (no recording or graphs). |
| **Debug Fields** | Toggles whether recordings include the extra diagnostic CSV columns (off by default). Persisted, but only takes effect on the *next* recording started, not one already in progress. See [Debug Fields](#debug-fields) in Section 4b for the full column list. |

### GSR Calibration Submenu

Selecting **GSR Calibration** opens a submenu:
* **Start Wizard:** Launches the 3-point calibration wizard.
* **Reset to Default:** Deletes the custom calibration file and restores the default gain ($1.0$) and offset ($0.0$).

#### GSR Calibration Wizard

The Calibration Wizard walks you through connecting three precise reference resistors to the electrodes. The wizard uses these points to solve a linear least-squares fit ($y = \text{gain} \times x + \text{offset}$) in the conductance domain (nanosiemens).

* **Calibration Points & Expected Values:**
  * **Step 1/3 (Low):** Connect a **$470\text{ k}\Omega$** resistor. Target: $2127.66\text{ nS}$. Range gate: $[200, 3000]\text{ nS}$.
  * **Step 2/3 (Mid):** Connect a **$100\text{ k}\Omega$** resistor. Target: $10000.0\text{ nS}$. Range gate: $[3000, 25000]\text{ nS}$.
  * **Step 3/3 (High):** Connect a **$47\text{ k}\Omega$** resistor. Target: $21276.6\text{ nS}$. Range gate: $[5000, 45000]\text{ nS}$.

* **Measurement Protocol:**
  * When you press **OK** at each step, the wizard flushes the signal buffer for $1$ second ($10$ ticks) to clear old values.
  * It then gathers $20$ samples over $2$ seconds.
  * Outliers are trimmed by discarding the minimum and maximum samples before computing the average.
  * If fewer than $12$ samples fall inside the gate range for a step, the measurement fails.

* **Fit & Validation:**
  * Once all three points are collected, the wizard calculates a least-squares linear regression.
  * It validates the fit: **Gain** must be between $0.2\text{x}$ and $5.0\text{x}$, **Offset** must be between $-20000\text{ nS}$ and $+20000\text{ nS}$, and the goodness-of-fit coefficient **$R^2$** must be $\ge 0.95$ (ensuring high linearity).
  * If validation succeeds, it displays the results screen showing:
    * **Gain:** Scaling adjustment factor (ideal is $1.0\text{x}$).
    * **$R^2$:** Linearity coefficient (ideal is $1.0000$).
    * **Offset:** Baseline offset in nanosiemens (nS).
  * Press **OK** to save the values to `/ext/biomapping/biomap.cal`, or **Back** to discard.

### Diagnostics Screen

The **Diagnostics** screen provides a real-time numerical view of the raw biometric sensor outputs and circuit status. It is highly useful for verifying hardware signal integrity and component behavior without generating CSV logs or graphs.

It displays the following variables in real-time:
* **PGA:** The active Programmable Gain Amplifier hardware range index of the ADS1115 ($0$ to $5$), which adjusts dynamically:
  * `0`: $\pm6.144\text{ V}$
  * `1`: $\pm4.096\text{ V}$
  * `2`: $\pm2.048\text{ V}$ (default starting point)
  * `3`: $\pm1.024\text{ V}$
  * `4`: $\pm0.512\text{ V}$
  * `5`: $\pm0.256\text{ V}$ (maximum sensitivity)
* **Cal:** Shows whether custom calibration is active (`yes` or `no`).
* **Raw:** Single-sample real-time skin conductance in nanosiemens (nS) computed using the TIA equation.
* **Filt:** The $100\text{ ms}$ boxcar-averaged (decimated) skin conductance in nanosiemens (nS) before post-decimation IIR/EMA filtering is applied.
* **Sngl:** The raw single-sample normalized ADC count (pre-TIA conversion, normalized to the $\pm0.256\text{ V}$ range).
* **Mean:** The $100\text{ ms}$ mean normalized ADC count (pre-TIA conversion, snapshot of the oversampling window).

### Full Control Reference


#### Recording View

| Button | Action |
|---|---|
| **OK** | Start/stop recording to CSV. Green LED flash on each successful write. |
| **Up** | Increase vertical sensitivity (zoom in on GSR amplitude). Disables auto-zoom. |
| **Down** | Decrease vertical sensitivity (zoom out). Disables auto-zoom. |
| **Left** | Expand time scale (slower scroll). Doubles the window per pixel. |
| **Right** | Contract time scale (faster scroll). Halves the window per pixel. |
| **Back** | Stop recording (if active) and return to main menu. |

#### Menu / Options View

| Button | Action |
|---|---|
| **Up** | Move selection up. |
| **Down** | Move selection down. |
| **OK** | Select the highlighted item / toggle the highlighted option. |
| **Back** | Return to previous screen. |

---

## 9. Notification LEDs

The Flipper Zero's RGB LED provides status feedback throughout the session:

While recording, the LED blinks once per second (a "heartbeat"), independent of the SD flush interval:

| Event | LED | Meaning |
|---|---|---|
| Recording, sensor OK | Green blink (500 ms), 1× per second | Normal recording heartbeat |
| Recording, electrodes disconnected | Red blink (500 ms), 1× per second | GSR sensor reads open-circuit — check the finger electrodes |
| Recording, GPS has no fix | Blue blip (100 ms) after the heartbeat | Waiting for a GPS fix (GPS modes only) |
| Write error | Solid red (until reset) | SD card full or filesystem error — recording stopped |
| Recording stopped | LED cleared | Blink sequence stopped; backlight restored to auto |
| GPS hot start OK (Reset GPS) | Green blink (100 ms) | Reset command sent successfully |
| GPS hot start failed (Reset GPS) | Red blink (100 ms) | GPS module not responding |

---

## 9a. Audio Feedback

The Flipper's piezo speaker gives short tones for key/state changes, so the important ones — recording start/stop, mode changes, and mid-recording alerts — are audible without looking at the screen. Implemented in [`modules/sound.h`](modules/sound.h) using the same `furi_hal_speaker_acquire/start/stop/release` pattern as other Flipper Zero FAP apps. Toggle in **Options > Sound** (default ON); every tone in the app respects this setting except the Sound toggle's own confirmation click, which always plays so muting is itself audible.

| Event | Tone |
|---|---|
| Menu/list navigation (Up/Down), manual graph zoom (Up/Down/Left/Right, only when **not** recording) | Short neutral click |
| Back / cancel | Short click, lower-pitched than navigation (audibly distinct "direction") |
| Select a menu item, enter a mode/submenu, confirm a calibration step, single calibration-resistor measurement passing its gate | Bright confirm click |
| Auto-zoom / Backlight toggled | Two-pitch tone — higher for ON, lower for OFF |
| GSR Calibration > Reset to Default | Three-note descending tone, distinct from a plain toggle |
| **Recording started** | Rising two-note chirp (E5 → B5) |
| **Recording stopped** (OK toggle, or Back while recording) | Falling two-note chirp (B5 → E5) — the mirror image of start |
| GPS hot start (Reset GPS) succeeded, calibration fit succeeded | Three-note ascending success run |
| GPS hot start failed, calibration measurement/fit failed, recording failed to start (header/SD error) | Two-note descending error tone |
| SD write failure (recording stops), GSR electrodes disconnect | Low double-beep warning — edge-triggered once per disconnect episode, not repeated every second, so a loose electrode doesn't nag for the rest of the walk |

GPS fix/no-fix state deliberately has **no** audio cue — it changes too often in normal use (urban canyons, trees) for a tone to stay useful; the badge/LED already covers it.

**GSR safety.** The piezo speaker shares the 3.3V rail with the ADS1115/TIA front-end, so on a breadboard build a tone is a plausible source of electrical noise on the GSR signal. Three things keep tones out of the recorded data:
- **Zoom clicks are silent while recording** (audible only when adjusting zoom before/after a recording session) — see the table row above.
- **Recording start** plays its chirp, then holds for a fixed settle period before `recording.active` goes true, so the first logged sample can't include audio-era ADC readings. The settle period is sized against the GSR ring buffer depth (`SENSOR_BUFFER_SIZE` in `modules/gsr_sensor.h`) with headroom for RTOS scheduling jitter — see `GSR_TONE_SETTLE_MS` in `biomap_session.c`.
- **Recording stop** (OK, or Back while recording) fully closes the CSV file *before* the stop chirp plays, whichever path triggers it — never after.

The GSR-disconnect warning tone is the one remaining exception: it fires while `recording.active` stays true (a disconnect doesn't stop the recording). This is treated as lower-risk since the readings during a disconnect are already outside the valid GSR range and expected to be excluded from analysis regardless of the tone.

---

## 10. File Storage

All files are stored on the SD card under `/ext/biomapping/`:

**CSV files:** `biomap_001.csv` through `biomap_999.csv` (auto-incrementing, wraps at 999). Every file begins with `#`-prefixed metadata lines (`# RecordingStartTime:<unix_epoch>`, and, only when RF was active and calibrated, `# Band Floors (dBm): 815:<f>,868:<f>,915:<f>`) followed by the column-name header. See [Section 4b's CSV Formats](#csv-formats) for the exact column layout per mode, and [Debug Fields](#debug-fields) for the optional diagnostic columns.

Approximate file size per hour of recording, production (Debug Fields off) vs. debug schema, at the 10 Hz row rate:

| Mode | Production | With Debug Fields on |
|---|---|---|
| GPS + GSR (11 col) | ~2.1 MB/hr | larger — debug columns add ~16 more per row |
| GPS + GSR + RF / GPS + RF (14 col) | ~2.8 MB/hr | ~4.4 MB/hr (measured; see `docs/gps_rf_mutex_status.md`) |
| GSR Only (2 col) | ~0.4 MB/hr | larger — debug columns add ~7 more per row |

The SD log file is pre-allocated to roughly its expected size at recording start and trimmed to the real size at stop (see Section 4's "Challenge: SD Card Lag"), so free-space usage during a recording will briefly look larger than the numbers above until the recording is stopped.

See [`docs/csv_schema.md`](docs/csv_schema.md) for the canonical column definitions and sentinel values.

---

## 11. Tuning

Tuning lives in two places:

**Firmware (compile-time).** The GPS logging quality gate is defined in `biomap_types.h`:

```c
#define GPS_HDOP_GATE   5.0f   // rows with HDOP above this log empty lat/lon
```

This is deliberately permissive: logging up to HDOP 5.0 preserves urban-canyon fixes that the visualiser can optionally reject later. The signal-processing constants (`SMOOTH_IIR_A`/`_B`, `DISPLAY_EMA_A`/`_B`, PGA thresholds) are also defined in `biomap_types.h` / `modules/gsr_sensor.h`.

**Visualiser (post-processing).** Filtering, peak detection, and the GPS quality filter are adjustable in the web visualiser's UI at runtime — no rebuild required. The visualiser's default HDOP filter is stricter (2.0) than the firmware logging gate (5.0); see the HDOP-gate note in [`docs/csv_schema.md`](docs/csv_schema.md).

---

## 12. Application Metadata

The app is packaged as a Flipper Zero `.fap` file:

| Field | Value |
|---|---|
| App ID | `biomap` |
| Name | Bio Mapping |
| Type | External (FAP) |
| Entry point | `biomap_app` |
| Requires | `gui`, `storage`, `notification`, `expansion` |
| Stack size | 4 KB |
| Category | GPIO |
| Sources | 12 source files across 2 directories (`biomap.c`, `biomap_gui.c`, `biomap_session.c`, `biomap_render.c`, `biomap_pipeline.c`, `biomap_rf_cal.c`, `minmea.c`, `modules/gps_uart.c`, `modules/gsr_sensor.c`, `modules/sd_logger.c`, `modules/em_scan_rf.c`, `modules/em_scan_cal.c`) |
