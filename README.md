# BioMapping 2.0

Christian Nold, 2026 · Build & software guide (ADS1115 transimpedance amplifier)

## 1. Introduction

BioMapping 2.0 records and visualises your body's physiological arousal, mapped precisely to geographical location, as you walk through a landscape. It is a high fidelity successor to Christian Nold's original Bio Mapping project (2004).

A Flipper Zero logs three streams:

- **Galvanic Skin Response (GSR)** — via a sensitive **transimpedance amplifier (TIA)** and a dedicated 16-bit ADS1115 ADC.
- **Location** — via a u-blox SAM-M10Q GNSS module, sub-meter accuracy.
- **Environmental RF** — SubGHz band activity at 815 / 868 / 915 MHz.

- **[Visualiser](visualiser/index.html)** (§8) — a browser page that decomposes the signal into tonic/phasic components, detects arousal peaks, and renders your route on a map coloured by arousal. Collective mode builds an interpolated contour surface across one or more walks.
- **[Live view](visualiser/live.html)** (§9) — a browser page that receives GPS + GSR over Bluetooth in real time while you walk.

---

## 2. Installing the App

Targets the official (stock) Flipper Zero firmware, currently stock release `1.4.3` (API 87.1). It uses only public SDK APIs, so it also runs on the API-compatible forks.

### Option A — prebuilt `.fap`

Download `biomap.fap` from the [Releases](https://github.com/Softhook/BioMapping/releases) page.


### Option B — build from source

Needs [`ufbt`](https://pypi.org/project/ufbt/), the micro Flipper Build Tool.

---

## 3. Hardware Requirements

**Core boards**
* **Flipper Zero**
* **SparkFun u-blox SAM-M10Q GNSS Breakout** — GPS positioning. Integrated 15×15 mm ceramic patch antenna (no external antenna), boots at 9600 baud, 10 Hz updates, 4-constellation reception (GPS + Galileo + GLONASS + BeiDou).
* **Flipper Zero Prototyping Board** — mounts the ADS1115 and op-amp circuit (see §4).
* **ADS1115 Breakout Board** — 16-bit I²C ADC.

**Active components**
* 1× rail-to-rail dual op-amp (MCP602 / MCP6002 / MCP6042 or equivalent 3.3 V CMOS dual op-amp)

**Passive components** (all 0.1% tolerance metal-film resistors)
* 1× 56 kΩ — voltage divider
* 1× 10 kΩ — voltage divider
* 1× 47 kΩ — TIA gain / feedback
* 2× 4.7 kΩ — electrode safety (inline)
* 2× 100 nF (0.1 µF) ceramic capacitors — one power bypass, one feedback filter

**Biometric interface**
* GSR finger electrodes — biometric finger clips, or velcro strips with foil / copper tape.

---

## 4. Wiring Guide

### Phase 1: The I2C Bus
The SAM-M10Q connects via UART, leaving Pin 15 / Pin 16 free for the ADS1115 I²C bus.

* Pin 15 (PC1) — I2C **SDA**
* Pin 16 (PC0) — I2C **SCL**

### Phase 2: GPS Wiring
No wiring beyond UART TX/RX and 3.3V/GND. 

### Phase 3: Installing the Biometric Sensor Circuit
Mount the ADS1115 and the dual op-amp onto the Flipper Zero Prototyping Board. Both op-amp channels are used — one as a voltage follower for V_ref, one as the TIA.

**Standard 8-pin dual op-amp pinout** (MCP602, MCP6002, MCP6042, and equivalents):
```
Pin 1 = Out A     Pin 8 = 3.3V
Pin 2 = In- A     Pin 7 = Out B
Pin 3 = In+ A     Pin 6 = In- B
Pin 4 = GND       Pin 5 = In+ B
```

* **Power & I2C (ADS1115):**
  * `VDD` -> **Pin 9 (3.3V)**
  * `GND` -> **Pin 8 (GND)**
  * `ADDR` -> **Pin 8 (GND)** *(hardcodes the I2C address to 0x48)*
  * `SDA` -> **Pin 15 (PC1)**
  * `SCL` -> **Pin 16 (PC0)**

* **Power & bypass (dual op-amp):**
  * Pin 8 -> **Pin 9 (3.3V)**
  * Pin 4 -> **Pin 8 (GND)**
  * **Mandatory:** solder one **100nF capacitor** directly across Pin 8 and Pin 4 to filter digital power spikes from the Flipper.

* **Generate the 0.5V bias (V_ref) with Op-Amp B (voltage follower):**
  * **56kΩ** from 3.3V to In+ B (pin 5).
  * **10kΩ** from In+ B (pin 5) to GND.
  * Tie Out B (pin 7) directly to In- B (pin 6).
  * *Pin 7 is now a buffered 0.5V reference (V_ref).*

* **Build the TIA with Op-Amp A:**
  * Connect V_ref (from Out B) to In+ A (pin 3).
  * Tie the **47kΩ** and the second **100nF capacitor** in parallel between Out A (pin 1) and In- A (pin 2). This is both the amplifier gain and a hardware low-pass filter against 50/60 Hz mains hum.

* **Connect electrodes & safety resistors:**
  * Electrode 1 (GND): GND -> **4.7kΩ** -> wire -> foil/finger 1.
  * Electrode 2 (signal): foil/finger 2 -> wire -> **4.7kΩ** -> In- A (pin 2).
  * *These resistors (9.4 kΩ total) keep skin current safe while holding the TIA output within ADC range across the full span of human skin resistance.*

* **Differential connection to ADS1115:**
  * **AIN0** -> Out A (pin 1) — the amplified GSR signal.
  * **AIN1** -> Out B (pin 7) — the clean 0.5V V_ref.

The ADS1115 subtracts the 0.5V virtual-ground offset, isolating the amplified skin-current data while rejecting system noise.

---

## 5. Recording Modes

Selected from the main menu:

```
┌─────────────────────────────┐
│  Bio Mapping                │
│  ▓ GPS + GSR + RF      ▓   │   ← selected item (inverse bar)
│    GPS + GSR                │
│    GPS + RF                 │
│    GSR Only                 │
│    Live Stream              │
│    Options                  │
└─────────────────────────────┘
```

| Mode | What it does | Output |
|---|---|---|
| **GPS + GSR + RF** | GPS, GSR and RF scanning all active. Each row carries the most recent GPS fix (carried forward, not interpolated). | 14-column CSV @ 10 Hz |
| **GPS + GSR** | GPS and GSR, RF off. | 11-column CSV @ 10 Hz |
| **GPS + RF** | GPS and RF, no GSR sensor (`gsr_raw` = `0.0`). Internally `BioMapModeGpsOnly` — despite the name it still scans RF. | 14-column CSV @ 10 Hz |
| **GSR Only** | GSR waveform only, no GPS driver (module put into Software Standby to save power). | 2-column CSV @ 10 Hz |
| **Live Stream** | GPS + GSR streamed over Bluetooth in real time — **nothing is written to the SD card**. See §9. | BLE, ~300 ms packets |
| **Options** | Opens the Options screen (§11). | — |

Diagnostics is reached via **Options → Diagnostics** (§11), not the main menu.

---

## 6. Software Architecture

### Repository Layout

```
firmware/            Flipper Zero app — the ufbt project root (run `ufbt` from here)
  application.fam      build manifest
  biomap*.c/.h         app translation units (session, GUI, render, pipeline, RF cal)
  biomap_config.h      compile-time options (debug fields, …)
  modules/            self-contained hardware drivers (GPS, GSR, SD, EM scan, BT)
  vendor/minmea/      third-party NMEA parser (unmodified upstream)
  tests/             host-side unit tests + shims (`./firmware/run_tests.sh`)
  tests/benchmarks/  standalone characterisation / benchmark programs
visualiser/          browser-based post-processing & map viewer (own package.json)
scripts/             Python analysis helpers for recordings and telemetry logs
docs/                design notes, investigations, datasheets, CSV schema
tracks/              local recordings & logs (git-ignored, not part of the repo)
```



### Reading the ADS1115 with Dynamic PGA Auto-Ranging

To capture the full dynamic range of human skin resistance, the software runs active **PGA (Programmable Gain Amplifier) auto-ranging** on the differential pins (AIN0, AIN1). `gsr_sensor.c` reads the ADS1115 at 860 SPS on a background thread and applies:

1. **Dynamic gain scaling:**
   - **Range down (avoid clipping):** if the absolute differential exceeds 30,000 counts (~91.5% of full scale), the PGA index is decreased immediately (e.g. ±0.512V → ±1.024V).
   - **Range up (more resolution):** if the absolute reading stays below 4,096 counts (~12.5%) for 5 consecutive ticks, the PGA index is increased (e.g. ±2.048V → ±1.024V).
2. **Output normalization:** all readings are normalized back to the ±0.256V range (1 LSB = 7.8125 µV) regardless of the active hardware gain, so downstream filters see a consistent signal.
3. **Simple-mean oversampling:** the decimation window is time-based — exactly the last 100 ms (≈40–50 samples at the ~400–500 Hz worker rate). 100 ms is 5 cycles of 50 Hz / 6 cycles of 60 Hz, so it cancels mains hum regardless of sample count, for a ≈6.7× noise reduction. Empirical testing (873-sample recording) found no I²C glitches — large tick-to-tick jumps were real SCR onsets, not noise.
4. **Conductance conversion:** the filtered voltage is converted to skin conductance in nanosiemens (nS) via the TIA equation (§7).

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

### SD Card Batching

Writing to the SD card takes a few milliseconds — sometimes much longer on a real card (see `docs/gps_rf_mutex_status.md`). Writing every sample individually would stall the app.

Instead, each 10 Hz tick formats its CSV row into an in-memory buffer, and the batch is flushed in one `storage_file_write()` + `storage_file_sync()` every `FLUSH_INTERVAL` (10 s) — ~100 rows per flush. The recording LED blinks once per second, independent of flush cadence.

The log file is pre-allocated to its expected full size at record start (`BIOMAP_SD_PREALLOC`, `firmware/modules/sd_logger.c`) and trimmed to the real length at stop, reducing filesystem overhead from incremental growth (see `docs/gps_rf_mutex_status.md`, "option E").

Row content per mode:
- **GPS + GSR / GPS + GSR + RF:** every tick carries the most recent GPS fix, carried forward (not interpolated to the GSR timestamp).
- **GPS + RF:** a GPS row every tick; `gsr_raw` is always `0.0`.
- **GSR Only:** a 2-column row (`timestamp`, `gsr_raw`); no GPS driver initialised.

### Multi-Rate Architecture

Two independent pipelines, because GSR and GPS have different time characteristics:

| Signal | Sample rate | Why |
|---|---|---|
| **GSR** | 10 Hz (tick) | Skin conductance changes in 0.5–5 s — 10 Hz captures physiological events with headroom |
| **GPS (CSV rows)** | 10 Hz (`GPS_CSV_HZ`) | Rows are written at the tick rate in every GPS mode |
| **GPS (module fixes)** | up to 10 Hz | The SAM-M10Q updates position over UART at up to 10 Hz. If no new fix arrives on a tick, the row repeats the most recent fix |

### Timestamps

Each row's first column (`timestamp`) is **relative time in seconds since the recording started**, written as a float with 0.1 s resolution (`%.2f`, e.g. `12.30`) — *not* an ISO 8601 string. The absolute start time is written once in the metadata header as a Unix epoch:

```
# RecordingStartTime:1751204579
# Band Floors (dBm): 815:-91.5,868:-91.5,915:-91.5
```

The `# Band Floors` line only appears when RF is active for the session (GPS + GSR + RF or GPS + RF) **and** an RF calibration exists — it is the per-band noise floor from RF Calibration (§11), used by the visualiser to normalise RSSI.

| Field | Source | Notes |
|---|---|---|
| `RecordingStartTime` (header) | Flipper RTC (`furi_hal_rtc_get_datetime`) at record start, as Unix epoch (UTC) | `0` if the RTC has never been set |
| `timestamp` (per row) | Monotonic 10 Hz tick counter | Seconds since record start |

Set the Flipper RTC to UTC before recording. Absolute wall-clock time for any row is `RecordingStartTime + timestamp`.

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

**Post-decimation smoothing:** the 100 ms boxcar is the anti-aliasing filter (≈4 dB at the 5 Hz Nyquist, full mains-hum rejection). Aliasing from the 860→10 Hz downsample can't be undone, but a first-order IIR at 3 Hz (α = 0.848) after decimation suppresses aliased noise and broadband EMI (BLE radio, switching artifacts) that leaked through the boxcar sidelobes. Since >95% of GSR power is below 1 Hz, net SNR improves — real phasic GSR at 2 Hz loses <0.5 dB. Cost: one multiply-add per tick, ~50 ms phase lag at 1 Hz. See `smooth_iir_filter()` in `biomap_session.c`.

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

Every mode has a **production** schema (below) and a wider **debug** schema with diagnostic columns appended, chosen per session by **Options → Debug Fields** (off by default). [`docs/csv_schema.md`](docs/csv_schema.md) is the canonical, versioned reference for every column; these are representative examples.

**GPS + GSR + RF (14 columns, 10 Hz):**
```
# RecordingStartTime:1751204579
# Band Floors (dBm): 815:-91.5,868:-91.5,915:-91.5
timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,rssi_868,rssi_915
0.00,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4523.0,2.4,-91.5,-88.0,-95.0
0.10,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4528.0,2.3,-91.5,-88.0,-95.0
...
```

**GPS + GSR (11 columns, 10 Hz):**
```
# RecordingStartTime:1751204579
timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m
0.00,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4523.0,2.4
0.10,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4528.0,2.3
...
```
When there is no valid fix on a tick, `lat`/`lon` and the other GPS columns are left empty (e.g. `0.30,,,,,,,,,4519.0,`) so the visualiser treats the row as a GPS gap rather than a `(0,0)` coordinate. `hacc_m` is horizontal accuracy in meters, from the `$PUBX,00` message; it stays `99.9` until the module reports an estimate.

**GPS + RF (14 columns, 10 Hz):** same shape as GPS + GSR + RF, but `gsr_raw` is always `0.0` — no GSR sensor is initialised.

**GSR Only (2 columns, 10 Hz):**
```
# RecordingStartTime:1751204579
timestamp,gsr_raw
0.00,4523.0
0.10,4528.0
...
```
Each row is a point reading of skin conductance in nS at 10 Hz, allowing offline re-analysis with different filter parameters.

### Debug Fields

**Options → Debug Fields** (off by default, persisted, takes effect on the *next* recording) appends diagnostic columns to every mode's rows — added incrementally during firmware development to track timing/reliability issues (`docs/gps_rf_mutex_status.md`), not needed for normal use. With it on, GPS + GSR / GPS + GSR + RF grow to 27/30 columns and GSR Only to 9:

| Column | Meaning |
|---|---|
| `tick_dt_ms` | Real elapsed ms since the previous tick (contention/stall diagnostic) |
| `gps_rx_drops`, `nmea_fail`, `gps_reinit_count` | Cumulative GPS UART error counters (GPS-bearing modes only) |
| `gsr_hz` | GSR worker's real achieved sample rate |
| `i2c_peak_ms`, `rf_rssi_peak_ms`, `rf_retune_peak_ms` | Worst single GSR I2C / RF SPI call this session |
| `flush_peak_ms` | Worst single SD batch flush (write+sync) this session |
| `log_fill_bytes`, `log_fill_peak_bytes`, `log_overflow_count`, `log_flush_fail_count` | SD logger batch-buffer occupancy and continuity-risk counters |
| `pga_change_count`, `i2c_consec_fail` | GSR auto-ranging gain switches / consecutive I2C failure run length |
| `prealloc_ms` | Duration of the one-shot SD log-file pre-allocation at record start |

All are lifetime-max or cumulative-since-start except `prealloc_ms`. See [`docs/csv_schema.md`](docs/csv_schema.md) for the authoritative column order and [`docs/gps_rf_mutex_status.md`](docs/gps_rf_mutex_status.md) for what each one diagnoses.

---

## 7. Signal Processing

Raw voltage reflects baseline sweat level. What matters is **sudden change** — spikes in arousal or drops into relaxation. Two operations on the 10 Hz stream find it:

1. **Smoothing (EMA):** `Smoothed = 0.2 × Raw + 0.8 × Previous_Smoothed`
2. **Derivative (rate of change):** `Rate = Smoothed − Previous_Smoothed`

### What the On-Screen Graph Shows

The live graph shows the **derivative**, not absolute conductance — a deliberate choice for a tiny screen.

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

- **Line at center** = conductance stable (no arousal, no relaxation)
- **Line spikes up** = conductance rising (stress / arousal)
- **Line dips below center** = conductance falling (relaxation / recovery)

The absolute value is shown as a number at the top-right (e.g. `4523 nS`), so you get both views at once. The CSV records the absolute nS value — the derivative is display-only.

In the TIA setup:
* **Stress (resistance drops):** conductance increases, more current through the feedback resistor, `V_out` rises, differential read increases, `Rate` goes strongly positive.
* **Relaxation (resistance climbs):** current drops, `V_out` falls toward `V_ref`, `Rate` goes negative.

For arousal mapping in the visualiser (§8), only the **magnitude** of change matters — rapid rises and rapid drops both read as high arousal.

### TIA Conductance Equation

The filtered, normalised ADC reading (`N`, counts at the ±0.256 V reference) converts to skin conductance in nS:

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
4. Convert: `G_nS = 10⁹ / R_skin`
5. Simplifying: `G_nS = N × 5,000,000 / (15,040,000 − N × 47)`

When `N` approaches zero (open circuit / disconnected electrodes), conductance is clamped to 0. When `N` exceeds 319,000 (near the denominator singularity at `N ≈ 320,000`), the value is clamped to prevent overflow.

### Hardware Accuracy

Accuracy was evaluated against a precision metal-film reference resistor grid (10 kΩ to 9 MΩ) — full sweep in [`docs/reference_test_results.csv`](docs/reference_test_results.csv). Within the physiological range:

* **Error ≤ ±0.10%:** 47 kΩ – 1 MΩ ($1{,}000 \le G \le 21{,}277$ nS) — **99.05%** of active-wear track data.
* **Error ≤ ±0.50%:** 22 kΩ – 2.2 MΩ ($455 \le G \le 45{,}455$ nS) — **99.75%**.
* **Error ≤ ±1.00%:** 15 kΩ – 4.7 MΩ ($213 \le G \le 66{,}667$ nS) — **99.89%**.
* **Open-circuit limit:** below 100 nS ($> 10\text{ M}\Omega$) the device reports an open circuit (electrodes disconnected / air).

**Versus commercial EDA systems** (Shimmer3 GSR+, BIOPAC EDA100C):

* **Method:** constant voltage (0.5 V bias) — matches both BIOPAC and Shimmer3.
* **Resolution:** BioMapping 2.0 **< 0.5 nS** (16-bit delta-sigma ADC + 100 ms decimation); BIOPAC EDA100C 0.7 nS; Shimmer3 variable (12-bit ADC, worse at low conductance).
* **Accuracy error:** BioMapping 2.0 ≤ ±0.10% (47 kΩ–1 MΩ), ≤ ±0.50% (22 kΩ–2.2 MΩ), ≤ ±1.00% (15 kΩ–4.7 MΩ); Shimmer3 ±3% (22 kΩ–680 kΩ) rising to ±10% (10 kΩ–4.7 MΩ); BIOPAC laboratory-grade (dependent on skin prep and gel).

---

## 8. The Visualiser

Recordings are visualised off-device by [`visualiser/index.html`](visualiser/index.html) — open it directly in a browser (no server) and drag one or more `biomap_*.csv` files onto it.

It:

1. **Loads** the CSV, honouring the `#` metadata header and relative-seconds `timestamp`, skipping rows with empty `lat`/`lon` (GPS gaps).
2. **Filters** the GSR signal (median / low-pass) and decomposes it into tonic and phasic components (DWT).
3. **Detects peaks** with shape-quality scoring to isolate genuine arousal events.
4. **Maps** the track on a Leaflet base map, coloured by arousal.
5. **Collective mode:** overlays multiple tracks, builds an inverse-distance-weighted (IDW) contour surface, and can enrich against OpenStreetMap features (road class, green space, buildings).

Both rapid rises **and** rapid drops in GSR read as high arousal — only the magnitude of change matters. [`docs/csv_schema.md`](docs/csv_schema.md) is the canonical column reference.

---

## 9. Live Streaming over Bluetooth

**Live Stream** mode streams GPS + GSR to a browser in real time over Bluetooth LE, for watching a walk unfold on a laptop or phone as it happens. Nothing is recorded on the device in this mode — there is no SD file.

**On the Flipper:** select **Live Stream** from the main menu. The screen shows BLE status (`Advertising` / `Connected`), the dropped-packet count, and live GSR / GPS readouts. The firmware claims Flipper's stock BLE serial profile and sends a 45-byte packed binary packet every 300 ms (`BT_STREAM_INTERVAL_MS`). Design notes: [`docs/bluetooth_serial_investigation.md`](docs/bluetooth_serial_investigation.md).

**In the browser:** open [`visualiser/live.html`](visualiser/live.html) and press **Connect** to pair with the Flipper. It shows a rolling GSR graph and a Leaflet map coloured by arousal, flags dropped-packet gaps, and can **Export CSV** in the same 11-column GPS + GSR schema as a recorded track.

**Browser support:** Web Bluetooth needs desktop Chrome / Edge or Android Chrome / Edge. Safari (any platform) and Firefox are not supported, so there is no iPhone path.

---

## 10. User Interface

The Flipper's 128×64 screen adapts to the active mode.

### GPS + GSR

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

### GPS + GSR + RF / GPS + RF

Same GSR derivative graph and GPS status, plus a per-band RSSI panel down the left edge (`draw_rf_panel_left()`, `biomap_render.c`) — one bar per SubGHz band (815 / 868 / 915 MHz) showing level above that band's calibrated noise floor. In GPS + RF mode (no GSR sensor), the freed space shows GPS status instead of a graph.

### GSR Only

```
┌───────────────────────┐
│ Bio Mapping            │
│ GSR: 4523 nS           │   ← absolute conductance (every 0.5 s)
│ ┌───────────────────┐ │
│ │      ~~~          │ │   ← GSR derivative graph (rate-of-change)
│ │  ~~/   \──        │ │      Same derivative view as GPS+GSR mode
│ │ /         \──     │ │
│ │/              \──  │ │
│ └───────────────────┘ │
└───────────────────────┘
```

### Recording Controls

| Button | Action |
|---|---|
| **OK** | Start/stop recording to CSV. Green LED flash on each successful write. |
| **Up** | Increase vertical sensitivity (zoom in on GSR amplitude). Disables auto-zoom. |
| **Down** | Decrease vertical sensitivity (zoom out). Disables auto-zoom. |
| **Left** | Expand time scale (slower scroll). Doubles the window per pixel. |
| **Right** | Contract time scale (faster scroll). Halves the window per pixel. |
| **Back** | Stop recording (if active) and return to the main menu. |

---

## 11. Menus & Options

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

| Option | Action |
|---|---|
| **GPS Profile** | Cycles the GPS dynamic navigation model (Up/Down): Pedestrian (default), Wrist-worn, Vehicle, Stationary, Sea, Bike, Flight — tunes the chip's motion filtering for the activity. |
| **Reset GPS** | Sends a hot-start command (binary `UBX-CFG-RST` packet). Useful if GPS is outputting stale/frozen data. Green flash on success, red on failure, plus a tone (§13). |
| **Auto-zoom GSR** | Toggles auto-zoom. On: the graph's vertical scale tracks peaks automatically. Off: manual Up/Down zoom. Toggling back on resets zoom to 1.0× and re-seeds the peak tracker. |
| **GSR Calibration** | Shows status (`YES`/`NO`). OK opens the calibration submenu (below). |
| **RF Calibration** | Shows the RF Faraday noise-floor calibration status (`YES`/`NO`). OK opens a submenu with the same shape as GSR Calibration — run the wizard, view the per-band floors, or reset. The result becomes the `# Band Floors` header line. |
| **Backlight** | Toggles the backlight between auto-dimming (OFF) and always-on (ON). |
| **Sound** | Toggles UI audio (default ON). Always plays its own confirmation click, even when switching off, so muting is audible. |
| **Diagnostics** | Enters diagnostic mode — live raw values and sensor health, no recording or graphs. |
| **Debug Fields** | Toggles the extra diagnostic CSV columns (off by default). Persisted; takes effect on the *next* recording. See [Debug Fields](#debug-fields) in §6. |

### GSR Calibration Submenu

* **Start Wizard** — launches the 3-point calibration wizard.
* **Reset to Default** — deletes the custom calibration file, restoring gain 1.0 / offset 0.0.

#### GSR Calibration Wizard

The wizard walks you through connecting three reference resistors to the electrodes, then solves a linear least-squares fit ($y = \text{gain} \times x + \text{offset}$) in the conductance domain (nS).

* **Calibration points:**
  * **Step 1/3 (low):** 470 kΩ resistor. Target 2127.66 nS. Gate $[200, 3000]$ nS.
  * **Step 2/3 (mid):** 100 kΩ resistor. Target 10000.0 nS. Gate $[3000, 25000]$ nS.
  * **Step 3/3 (high):** 47 kΩ resistor. Target 21276.6 nS. Gate $[5000, 45000]$ nS.
* **Measurement:** on OK, the wizard flushes the buffer for 1 s (10 ticks), then gathers 20 samples over 2 s. Min and max are discarded before averaging. Fewer than 12 in-gate samples fails the step.
* **Fit & validation:** least-squares regression, validated as gain $\in [0.2, 5.0]$, offset $\in [-20000, +20000]$ nS, $R^2 \ge 0.95$. The results screen shows gain, $R^2$, and offset. **OK** saves to `/ext/biomapping/biomap.cal`; **Back** discards.

### Diagnostics Screen

A real-time numerical view of the raw biometric outputs and circuit status — useful for verifying hardware signal integrity without logging. It shows:

* **PGA:** active ADS1115 gain index (0–5): `0` ±6.144V, `1` ±4.096V, `2` ±2.048V (start), `3` ±1.024V, `4` ±0.512V, `5` ±0.256V (max sensitivity).
* **Cal:** custom calibration active (`yes`/`no`).
* **Raw:** single-sample skin conductance in nS via the TIA equation.
* **Filt:** 100 ms boxcar-averaged conductance in nS, before IIR/EMA filtering.
* **Sngl:** raw single-sample normalized ADC count (pre-TIA, normalized to ±0.256 V).
* **Mean:** 100 ms mean normalized ADC count (pre-TIA, oversampling-window snapshot).

### Menu / Options Controls

| Button | Action |
|---|---|
| **Up / Down** | Move selection. |
| **OK** | Select the item / toggle the option. |
| **Back** | Return to the previous screen. |

---

## 12. Notification LEDs

While recording, the LED blinks once per second (a "heartbeat"), independent of the SD flush interval:

| Event | LED | Meaning |
|---|---|---|
| Recording, sensor OK | Green blink (500 ms), 1×/s | Normal recording heartbeat |
| Recording, electrodes disconnected | Red blink (500 ms), 1×/s | GSR reads open-circuit — check the electrodes |
| Recording, GPS has no fix | Blue blip (100 ms) after the heartbeat | Waiting for a GPS fix (GPS modes only) |
| Write error | Solid red (until reset) | SD card full or filesystem error — recording stopped |
| Recording stopped | LED cleared | Blink sequence stopped; backlight restored to auto |
| GPS hot start OK (Reset GPS) | Green blink (100 ms) | Reset command sent |
| GPS hot start failed (Reset GPS) | Red blink (100 ms) | GPS module not responding |

---

## 13. Audio Feedback

The piezo speaker gives short tones for key state changes — recording start/stop, mode changes, mid-recording alerts — so they are audible without looking at the screen. Implemented in [`firmware/modules/sound.h`](firmware/modules/sound.h). Toggle in **Options → Sound** (default ON); every tone respects the setting except the Sound toggle's own confirmation click.

| Event | Tone |
|---|---|
| Menu navigation (Up/Down), manual graph zoom (only when **not** recording) | Short neutral click |
| Back / cancel | Short click, lower-pitched than navigation |
| Select an item, enter a mode/submenu, confirm a calibration step, calibration-resistor measurement passing its gate | Bright confirm click |
| Auto-zoom / Backlight toggled | Two-pitch tone — higher for ON, lower for OFF |
| GSR Calibration → Reset to Default | Three-note descending tone |
| **Recording started** | Rising two-note chirp (E5 → B5) |
| **Recording stopped** (OK toggle, or Back while recording) | Falling two-note chirp (B5 → E5) |
| GPS hot start succeeded, calibration fit succeeded | Three-note ascending success run |
| GPS hot start failed, calibration measurement/fit failed, recording failed to start | Two-note descending error tone |
| SD write failure (recording stops), GSR electrodes disconnect | Low double-beep — edge-triggered once per disconnect episode, not repeated |

GPS fix/no-fix state has **no** audio cue — it changes too often in normal use for a tone to stay useful; the badge/LED covers it.

**GSR safety.** The piezo shares the 3.3V rail with the ADS1115/TIA front-end, so on a breadboard build a tone is a plausible noise source on the GSR signal. Three things keep tones out of the recorded data:
- **Zoom clicks are silent while recording** (audible only before/after a session).
- **Recording start** plays its chirp, then holds for a fixed settle period before `recording.active` goes true, so the first logged sample can't include audio-era ADC readings. The settle period is sized against the GSR ring buffer depth (`SENSOR_BUFFER_SIZE`) with RTOS-jitter headroom — see `GSR_TONE_SETTLE_MS` in `firmware/biomap_session.c`.
- **Recording stop** fully closes the CSV file *before* the stop chirp plays, on every path.

The GSR-disconnect warning tone is the one exception — it fires while `recording.active` stays true (a disconnect doesn't stop recording). Lower-risk, since readings during a disconnect are outside the valid range and excluded from analysis anyway.

---

## 14. File Storage

All files live on the SD card under `/ext/biomapping/`.

**CSV files:** `biomap_001.csv` through `biomap_999.csv` (auto-incrementing, wraps at 999). Every file begins with `#`-prefixed metadata (`# RecordingStartTime:<unix_epoch>`, and — only when RF was active and calibrated — `# Band Floors (dBm): …`), then the column header. See [CSV Formats](#csv-formats) (§6) and [Debug Fields](#debug-fields).

Approximate size per hour at 10 Hz:

| Mode | Production | Debug Fields on |
|---|---|---|
| GPS + GSR (11 col) | ~2.1 MB/hr | larger (~16 more columns per row) |
| GPS + GSR + RF / GPS + RF (14 col) | ~2.8 MB/hr | ~4.4 MB/hr (measured) |
| GSR Only (2 col) | ~0.4 MB/hr | larger (~7 more columns per row) |

The log file is pre-allocated at record start and trimmed at stop (§6, SD Card Batching), so free space briefly looks lower during a recording than the numbers above until it stops.

See [`docs/csv_schema.md`](docs/csv_schema.md) for canonical column definitions and sentinel values.

---

## 15. Tuning

**Firmware (compile-time).** The GPS logging quality gate is in `firmware/biomap_types.h`:

```c
#define GPS_HDOP_GATE   5.0f   // rows with HDOP above this log empty lat/lon
```

Deliberately permissive — logging up to HDOP 5.0 preserves urban-canyon fixes the visualiser can reject later. Signal-processing constants (`SMOOTH_IIR_A`/`_B`, `DISPLAY_EMA_A`/`_B`, PGA thresholds) are also in `firmware/biomap_types.h` / `firmware/modules/gsr_sensor.h`.

**Visualiser (post-processing).** Filtering, peak detection, and the GPS quality filter are adjustable in the visualiser's UI at runtime — no rebuild. Its default HDOP filter (2.0) is stricter than the firmware gate (5.0); see the HDOP-gate note in [`docs/csv_schema.md`](docs/csv_schema.md).

---

## 16. Application Metadata

| Field | Value |
|---|---|
| App ID | `biomap` |
| Name | Bio Mapping |
| Type | External (FAP) |
| Entry point | `biomap_app` |
| Requires | `gui`, `storage`, `notification`, `expansion`, `bt` |
| Stack size | 4 KB |
| Category | GPIO |
| Sources | 13 source files under `firmware/` (`biomap.c`, `biomap_gui.c`, `biomap_session.c`, `biomap_render.c`, `biomap_pipeline.c`, `biomap_rf_cal.c`, `vendor/minmea/minmea.c`, `modules/gps_uart.c`, `modules/gsr_sensor.c`, `modules/sd_logger.c`, `modules/em_scan_rf.c`, `modules/em_scan_cal.c`, `modules/bt_stream.c`) |
