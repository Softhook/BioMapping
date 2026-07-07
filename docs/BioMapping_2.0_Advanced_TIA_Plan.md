# BioMapping 2.0 
# Christian Nold 2026

The Complete Build & Software Guide (ADS1115 Transimpedance Amplifier Edition)

## 1. Introduction: What is BioMapping 2.0?
BioMapping 2.0 is a new version of Christian Nold's Bio Mapping project for the **Flipper Zero**. 
It allows you to walk through a city or landscape and record your body's physiological arousal mapped precisely to geographical coordinates. 

It translates your Galvanic Skin Response (GSR) fluctuations into **topographical elevation** within a GPX file. When you import your walk into Google Earth, your route will look flat while you were at your baseline, but "mountains" will appear where you experienced stress or arousal, and "valleys" or craters will map your deep relaxation.

This version of the device uses a dedicated 16-bit **ADS1115** Analog-to-Digital Converter combined with a robust and stable **Transimpedance Amplifier (TIA)** circuit. By utilising a rail-to-rail dual op-amp for active voltage buffering and hardware low-pass filtering, we achieve a precise, robust and noise-resistant way to measure the tiny changes in human sweat gland activity.

---

## 2. Hardware Requirements
To build this, you need the following physical components:

**Core Boards:**
* **Flipper Zero**
* **L76K GNSS Prototyping Shield:** Gives you a pre-wired GPS module alongside a blank 126-hole grid to build your custom circuit.
* **ADS1115 Breakout Board:** A high-precision 16-bit I2C ADC chip.

**Active Components:**
* **1x rail-to-rail dual op-amp** (MCP602, MCP6002, MCP6042, or equivalent 3.3V CMOS dual op-amp)

**Passive Components:**
* **1x 56kΩ Resistor** (For the voltage divider 0.1% tolerance metal film)
* **1x 10kΩ Resistor** (For the voltage divider 0.1% tolerance metal film)
* **1x 47kΩ Resistor** (For the TIA gain/feedback 1% tolerance metal film)
* **2x 4.7kΩ Resistors** (For safety inline with the electrodes 1% tolerance metal film)
* **2x 100nF (0.1µF) Ceramic Capacitors** (One for power bypass, one for the feedback filter)

**Biometric Interface:**
* **GSR Finger Electrodes:** Standard biometric finger clips or simple velcro strips with aluminum foil/copper tape.

---

## 3. The Wiring Guide & Hardware Surgery (Step-by-Step)

### Phase 1: Freeing the I2C Bus (Trace Cuts)
The two copper traces connecting **Pin 15 (PC1)** and **Pin 16 (PC0)** to the L76K GPS module have been physically cut. These pins are for exclusive use by the ADS1115 I2C bus.

* Pin 15 (PC1) — **no longer connected to GPS** → used for I2C **SDA**
* Pin 16 (PC0) — **no longer connected to GPS** → used for I2C **SCL**

### Phase 2: GPS Hardware Reroute
No additional wiring is needed. The L76K cannot be put to sleep via software, so no STANDBY or RESET wires need to be soldered. The GPS runs continuously. Software reset commands are available over UART for error recovery — see **Section 4a**.

### Phase 3: Installing the Biometric Sensor Circuit
Mount the ADS1115 and the dual op-amp onto the prototyping grid. Both channels are used (one as a voltage follower for V_ref, one as the TIA).

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
3. **Simple-Mean Oversampling:** All 100 buffer entries (spanning the full 100 ms decimation interval) are averaged directly. The background worker polls at ~1000 Hz while the ADS1115 converts at 860 SPS, so ~14 % of entries are duplicate reads — these don't bias the mean but yield an effective unique-sample count of ~86. The 100 ms window duration cancels sinusoidal 50/60 Hz mains hum perfectly (100 ms = 5 cycles of 50 Hz = 6 cycles of 60 Hz). The simple mean provides √86 ≈ 9.27× effective noise reduction against the Gaussian noise sources that dominate the ADC front-end. Empirical testing (873-sample recording) confirmed zero I2C glitches — all large tick-to-tick jumps were sustained physiological SCR onsets, not noise spikes that would benefit from trimming.
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
Writing data to the Flipper's SD card takes a few milliseconds. If we write every measurement to the card, the app will freeze up.

**The Solution:** The app uses different logging rates depending on mode:

- **GPS+GSR mode:** Each 10 Hz tick formats a CSV row into the in-memory batch buffer. Every 5th tick (when the GPS 2 Hz fix is freshest), a full 13-column row with lat, lon, alt, hdop, vdop, wdop, sats, fix, fix_type, speed_kts, and course_deg is formatted. On the remaining 8 ticks, a partial row with only timestamp and gsr_raw is formatted (GPS/velocity columns are empty). The entire batch of 10 rows is flushed to the SD card once per second in a single `storage_file_write()` call, exactly like GSR-only mode.

- **GPS-only mode:** One 13-column CSV row is written directly to the SD card twice per second (no batch buffer, since there's no high-frequency GSR data). The `gsr_raw` column is always 0.

---

## 4b. Multi-Rate Architecture: 10 Hz GSR, 2 Hz GPS

The app operates two independent data pipelines because GSR and GPS have fundamentally different time characteristics:

| Signal | Sample Rate | Why |
|---|---|---|
| **GSR** | 10 Hz (tick) | Skin conductance changes in 0.5–5 seconds — 10 Hz captures physiological events with headroom |
| **GPS** | 2 Hz (NMEA) | The L76K GPS module outputs position fixes twice per second over UART |

### Timestamp Sources

CSV timestamps are ISO 8601 UTC (`2026-06-29T13:42:59Z`) sourced from two places depending on mode:

| Mode | Timestamp Source | Resolution |
|---|---|---|
| **GPS+GSR** / **GPS-only** (GPS active) | L76K GPS battery-backed RTC — available from the first valid RMC/GGA sentence, often before a full position fix | 1 second |
| **GSR-only** (no GPS) | Flipper Zero internal RTC (`furi_hal_rtc_get_datetime`) | 1 second |

In GPS+GSR mode, if the GPS module hasn't produced a valid date/time yet (cold start), the Flipper's internal RTC is used as a fallback until the GPS time becomes available. In GSR-only mode, the Flipper RTC is always used — ensure it is set to UTC before recording for consistent timestamps.

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

**Post-decimation smoothing rationale:** The 100-sample boxcar average is the pre-decimation (anti-aliasing) filter — it provides ~4 dB at the 5 Hz Nyquist frequency and perfectly cancels sinusoidal 50/60 Hz mains hum (100 ms = 5 cycles of 50 Hz = 6 cycles of 60 Hz). Aliasing from the 860→10 Hz downsampling cannot be undone, but a post-decimation first-order IIR at 3 Hz (α = 0.848) attenuates both real high-frequency GSR and any aliased noise that leaked into the 0–5 Hz band. Since >95 % of GSR signal power is below 1 Hz, the net SNR improves: real phasic GSR at 2 Hz loses <0.5 dB, while broadband EMI (BLE radio, switching artifacts) that passed through the boxcar sidelobes is suppressed. The IIR costs one multiply-add per tick (~3 CPU cycles) and introduces ~50 ms phase lag at 1 Hz — invisible for GSR where phasic responses have 1–3 s rise times.  See `smooth_iir_filter()` in `biomap_session.c`.

### GPS Signal Chain

```
L76K GPS @ 1 Hz  ──►  UART interrupt handler
                              │
                     NMEA sentence parser
                              │
                     GpsStatus struct (lat, lon, alt, sats, fix)
                              │
                     Read on 1-second boundary, write to CSV
```

### CSV Formats

**GPS+GSR mode (13 columns, 10 Hz mixed):**
```
timestamp,lat,lon,alt,hdop,vdop,wdop,sats,fix,fix_type,speed_kts,course_deg,gsr_raw
2026-06-29T13:42:59Z,51.50720,-0.12760,12.3,1.2,1.5,1.1,8,1,3,2.40,185.0,4523   ← 5th tick: full 13-column GPS row
2026-06-29T13:42:59Z,,,,,,,,,,,,4528                                          ← other ticks: GSR only, GPS columns empty
2026-06-29T13:42:59Z,,,,,,,,,,,,4521
...
```

**GSR-only mode (3 columns, 10 Hz):**
```
timestamp,tick,gsr_raw
2026-06-29T13:42:59Z,0,4523
2026-06-29T13:42:59Z,1,4528
2026-06-29T13:42:59Z,2,4521
...
```
Each row is a point reading of skin conductance in nanosiemens with a sub-second tick counter (0–9 within each second). The 10 Hz resolution allows offline re-analysis with different filter parameters.

---

## 4a. GPS Error Recovery via PCAS Commands

The L76K GPS runs continuously — it cannot be put to sleep via software. The L76K uses Quectel's **PCAS** protocol. The only software control available is sending reset commands over UART to recover from a GPS hang or force a fresh satellite lock.

```c
// Helper — send a PCAS command over the GPS UART
static void gps_send_pcas(const char* cmd) {
    furi_hal_uart_tx(FuriHalUartIdLPUART1, (uint8_t*)cmd, strlen(cmd));
}
```

### Reset Commands

| Action | Command | When to use |
|---|---|---|
| **Hot Start** | `$PCAS10,0*1C\r\n` | GPS is outputting stale/frozen data — restarts quickly using cached satellite info |
| **Factory Reset** | `$PCAS10,3*1F\r\n` | GPS is completely hung or unresponsive — clears everything and starts fresh |

```c
// GPS outputting stale data — hot restart, keeps satellite cache for fast re-lock:
gps_send_pcas("$PCAS10,0*1C\r\n");

// GPS completely hung — factory reset, clears all data:
gps_send_pcas("$PCAS10,3*1F\r\n");
```

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

On the live display graph, the derivative is shown with its natural sign — arousal spikes upward, relaxation dips below center. For the GPX export (Section 6), only the **magnitude** of change matters: both rapid rises and rapid drops produce high elevation values.

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

---

## 6. The GPX File Export

### Recording: CSV, not GPX

When the user presses "Record", the app writes to a **CSV file** (`/ext/biomapping/biomap_001.csv`), not a GPX file. This keeps the recording simple and preserves the raw GSR data for offline re-analysis. The GPX file is produced **post-recording** by the built-in converter.

**GPS+GSR mode CSV (13 columns, 10 Hz mixed):**
```
timestamp,lat,lon,alt,hdop,vdop,wdop,sats,fix,fix_type,speed_kts,course_deg,gsr_raw
2026-06-29T13:42:59Z,51.50720,-0.12760,12.3,1.2,1.5,1.1,8,1,3,2.40,185.0,4523   ← full GPS row
2026-06-29T13:42:59Z,,,,,,,,,,,,4528                                          ← GSR-only row
```

**GSR-only mode CSV (3 columns, 10 Hz):**
```
timestamp,tick,gsr_raw
2026-06-29T13:42:59Z,0,4523
2026-06-29T13:42:59Z,1,4528
```

### Post-Processing: CSV → GPX Converter

From the main menu, selecting "Convert CSV→GPX" runs a two-pass converter (`gpx_converter.c`):

1. **Pass 1 (Scan):** Reads the CSV, applies SMA smoothing (configurable window `GPX_RATE_WINDOW`, default 80), tracks the global maximum rate-of-change across the entire walk.
2. **Pass 2 (Write):** Re-reads the CSV, re-runs the identical SMA, normalises each |rate| to the range [0, 255] against the global maximum, and writes GPX trackpoints with the normalised rate as `<ele>`.

The converter only outputs trackpoints for rows with a valid GPS fix (lat/lon non-zero, fix quality > 0). GSR-only CSVs are rejected with a clear error message — they contain no GPS coordinates.

For GPS+GSR recordings, the GPX file encodes the GSR rate-of-change as elevation:

* **0** = calm / steady GSR (no emotional event)
* **255** = maximum GSR change (strongest emotional event)

Both rapid rises AND rapid drops in GSR produce high elevation — only the magnitude of change matters, not the direction. The elevation is an unsigned integer in the range [0, 255].

**The resulting file structure looks like this:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bio Mapping">
  <trk>
    <name>Bio Mapping Walk</name>
    <trkseg>
      <!-- This point is flat baseline (Neutral) -->
      <trkpt lat="51.507200" lon="-0.127600">
        <ele>0</ele> 
        <time>2026-06-05T13:33:12Z</time>
      </trkpt>
      
      <!-- This point shows a massive stress spike (Arousal = Mountain) -->
      <trkpt lat="51.507250" lon="-0.127650">
        <ele>145</ele> 
        <time>2026-06-05T13:33:13Z</time>
      </trkpt>

      <!-- This point shows a rapid relaxation drop (also a Mountain — magnitude matters) -->
      <trkpt lat="51.507300" lon="-0.127700">
        <ele>96</ele> 
        <time>2026-06-05T13:33:14Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
```

---

## 7. The User Interface

The Flipper's 128x64 black-and-white screen shows different information depending on the active mode.

### GPS+GSR Mode

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

### GPS-Only Mode

```
┌───────────────────────┐
│ Bio Mapping        [■]│   ← Recording indicator
│ biomap_001.csv        │
│ 13:42:59 UTC          │   ← GPS time and date
│ 2026-06-16            │
│ 51.55636              │   ← Latitude
│ -0.07136              │   ← Longitude
│ Sats:6  Q:1           │   ← Satellite count and fix quality
└───────────────────────┘
```

### GSR-Only Mode

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

* `OK (Center Button)`: Starts and stops recording. In GPS+GSR mode writes 13-column CSV at 10 Hz (mixed full/partial rows). In GSR-only mode writes 3-column CSV at 10 Hz.
* `Left/Right`: Changes the time scale of the graph (scroll speed). Left zooms out (slower), Right zooms in (faster).
* `Up/Down`: Zooms in and out on the vertical sensitivity of the graph.
* `Back`: Safely closes the file and returns to the menu.

---

## 8. Menus and Options

### Main Menu

```
┌─────────────────────────────┐
│  Bio Mapping                │
│  ▓ GPS + GSR           ▓   │   ← selected item (inverse bar)
│    GPS Only                 │
│    GSR Only                 │
│    Convert CSV to GPX       │
│    Options                  │
│                             │
└─────────────────────────────┘
```

| Menu Item | Action |
|---|---|
| **GPS + GSR** | Enters recording view with both GPS and GSR active. Writes 13-column CSV (mixed rate: 10 Hz GSR, 2 Hz GPS coordinates). |
| **GPS Only** | Enters recording view with GPS only — no GSR sensor initialised. Writes 13-column CSV with `gsr_raw` = 0 at 2 Hz. |
| **GSR Only** | Enters recording view with GSR only — no GPS initialised. Writes 3-column CSV at 10 Hz. |
| **Convert CSV to GPX** | Scans for `biomap_*.csv` files and converts selected file to GPX (see Section 6). |
| **Options** | Opens the Options screen (see below). |

### Options Screen

```
┌─────────────────────────────┐
│  Options                    │
│  ▓ Reset GPS           ▓   │   ← selected (inverse bar)
│    Auto-zoom GSR   ON      │   ← toggleable
│    Backlight           ON  │   ← toggleable
│                             │
│    Press Back to return     │
└─────────────────────────────┘
```

| Option | OK Action |
|---|---|
| **Reset GPS** | Sends a PCAS10 hot-start command (`$PCAS10,0*1C\r\n`) to the L76K GPS module. Useful if GPS is outputting stale/frozen data. Leaves a green flash on success, red on failure. |
| **Auto-zoom GSR** | Toggles auto-zoom ON/OFF. When enabled, the graph's vertical scale adjusts automatically to keep peaks visible. When disabled, manual Up/Down zoom controls the scale. Toggling back ON resets the zoom to 1.0× and re-seeds the auto-zoom peak tracker. |
| **Backlight** | Toggles the Flipper's backlight between auto-dimming (OFF) and always-on (ON). Useful for walks in bright sunlight or dark environments. |

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

| Event | LED | Meaning |
|---|---|---|
| Recording started | Solid red | SD file opened and header written |
| CSV row written (GPS+GSR mode) | Green flash (100 ms) | Data saved to SD |
| CSV batch flushed (GSR-only mode) | Green flash (100 ms) | 10 rows flushed to SD |
| Write error | Solid red (until reset) | SD card full or filesystem error — recording stopped |
| GPS hot start OK | Green flash (100 ms) | Reset command sent successfully |
| GPS hot start failed | Red flash (100 ms) | GPS module not responding |
| Session end (normal) | LED off | Backlight restored to auto |

---

## 10. File Storage

All files are stored on the SD card under `/ext/biomapping/`:

**CSV files:** `biomap_001.csv` through `biomap_999.csv` (auto-incrementing, wraps at 999).
- 13-column format: `timestamp,lat,lon,alt,hdop,vdop,wdop,sats,fix,fix_type,speed_kts,course_deg,gsr_raw` (GPS+GSR and GPS-only modes)
- 3-column format: `timestamp,tick,gsr_raw` (GSR-only mode)
- Row size: ~100 bytes (13-column full) or ~30 bytes (partial row)
- Expected file size for 1-hour walk: ~1.15 MB (GPS+GSR) or ~1.3 MB (GSR-only)

**GPX files:** Generated by the converter, same index as the source CSV.

---

## 11. Converter Tuning

The GPX converter has two tunable constants that control how GSR data is mapped to GPX elevation:

```c
#define GPX_RATE_WINDOW     80     // SMA samples — bigger = smoother rate
#define GPX_MAX_ABS_RATE    2000.0f // cap |rate| in nS/sec — prevents sensor
                                    // glitches from hijacking the elevation scale
```

These are defined in `modules/gpx_converter.h` and can be adjusted before building:

- **GPX_RATE_WINDOW** (default 80): Simple Moving Average window size. The SMA buffer is pre-warmed with the first GSR sample so trackpoints begin immediately — there is no warm-up gap at the start of the recording. A larger window produces smoother elevation but responds slower to sudden changes. A smaller window reacts faster but may capture more noise.

- **GPX_MAX_ABS_RATE** (default 2000.0): The absolute rate-of-change in nS/sec beyond which any value is clamped. This prevents a single sensor glitch (e.g. static discharge from clothing) from setting the global maximum rate and compressing the rest of the walk into the bottom of the [0, 255] range. The default 2000 nS/sec is calibrated for the TIA circuit with 47 kΩ feedback and 9.4 kΩ safety resistors.

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
| Sources | 7 source files across 2 directories |
