# BioMapping 2.0

*Christian Nold, 2026 — a high-fidelity successor to the original Bio Mapping project (2004).*

BioMapping 2.0 records your Galvanic Skin Response, mapped precisely to geographical location, as you walk through a landscape. The visualiser detects skin-conductance response peaks in the recording and groups them into spatial clusters, marking where along the route those events occurred.

It has two parts:

- **[The Firmware](#the-firmware)** — a Flipper Zero app driving a custom biometric sensor circuit, logging to the SD card as CSV.
- **[The Visualiser](#the-visualiser)** — browser pages that turn a recording into a map ([`visualiser/index.html`](visualiser/index.html)), or show the walk live over Bluetooth as it happens ([`visualiser/live.html`](visualiser/live.html)).

## What It Records

| Stream | Sensor | Notes |
|---|---|---|
| **Galvanic Skin Response (GSR)** | Transimpedance amplifier + 16-bit ADS1115 ADC | Constant-voltage (0.5 V bias); logged as skin conductance in nanosiemens (nS) |
| **Location** | u-blox SAM-M10Q GNSS | Sub-meter accuracy, up to 10 Hz, 4-constellation (GPS + Galileo + GLONASS + BeiDou) |
| **Environmental RF** | Flipper SubGHz radio | Band activity at 815 / 868 / 915 MHz |

Everything is logged to `/ext/biomapping/*.csv` at 10 Hz. A Live Stream mode sends GPS + GSR over Bluetooth instead of recording.

## How It Compares

The GSR front-end is built to research-grade specification and measured against a precision metal-film resistor grid (10 kΩ – 9 MΩ), full sweep in [`docs/reference_test_results.csv`](docs/reference_test_results.csv).

| | BioMapping 2.0 | Shimmer3 GSR+ |
|---|---|---|
| Method | Constant voltage, 0.5 V | Constant voltage, 0.5 V |
| Resolution | **< 0.5 nS** (16-bit ADC + 100 ms decimation) | Variable (12-bit ADC, worse at low conductance) |
| Accuracy error (primary range) | **≤ ±0.10%** (47 kΩ – 1 MΩ) | ±3% (22 kΩ – 680 kΩ) |
| Accuracy error (wide range) | ≤ ±0.50% (22 kΩ – 2.2 MΩ) | ±10% (10 kΩ – 4.7 MΩ) |
| Accuracy error (extreme range) | ≤ ±1.00% (15 kΩ – 4.7 MΩ) | — |

Accuracy zones by the fraction of real-world track data that falls inside them:

- **≤ ±0.10%** — 47 kΩ – 1 MΩ ($1{,}000$–$21{,}277$ nS): 99.05% of data
- **≤ ±0.50%** — 22 kΩ – 2.2 MΩ ($455$–$45{,}455$ nS): 99.75%
- **≤ ±1.00%** — 15 kΩ – 4.7 MΩ ($213$–$66{,}667$ nS): 99.89%
- Below 100 nS ($>10$ MΩ) the device reports an open circuit (electrodes disconnected / air).

## Repository

```
firmware/     Flipper Zero app (ufbt project root)
visualiser/   browser post-processing + live view (own package.json)
scripts/      Python analysis helpers for recordings and telemetry logs
docs/         design notes, investigations, datasheets, CSV schema
tracks/       local recordings & logs (git-ignored)
```

---

# The Firmware

A Flipper Zero app (`biomap.fap`, category GPIO) that drives the sensor circuit and logs to the SD card.

## Installing

A Flipper external app (FAP) for stock firmware; also runs on the API-compatible forks (Momentum, Unleashed, RogueMaster). Download `biomap.fap` from the [Releases](https://github.com/Softhook/BioMapping/releases) page, or build from `firmware/` with [`ufbt`](https://pypi.org/project/ufbt/).

Run the host unit tests with `./run_tests.sh` from `firmware/`.

## Hardware Requirements

**Core boards**
* **Flipper Zero**
* **SparkFun u-blox SAM-M10Q GNSS Breakout** — GPS positioning. Integrated 15×15 mm ceramic patch antenna (no external antenna), boots at 9600 baud, 10 Hz updates.
* **Flipper Zero Prototyping Board** — mounts the ADS1115 and op-amp circuit.
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

## Wiring Guide

![BioMapping 2 TIA GSR circuit schematic — power-supply bypass, 0.5 V reference buffer (op-amp B), transimpedance amplifier (op-amp A), and differential connection to the ADS1115 over the Flipper I²C bus.](docs/gsr_circuit.png)

The schematic above is the reference for the three phases below; the editable source is [`docs/gsr_circuit.psd`](docs/gsr_circuit.psd).

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

## Recording Modes

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
| **Live Stream** | GPS + GSR streamed over Bluetooth in real time — **nothing is written to the SD card**. See [Live View](#live-view). | BLE, ~300 ms packets |
| **Options** | Opens the Options screen. | — |

Diagnostics is reached via **Options → Diagnostics**, not the main menu.

## Using the Device

Pick a mode from the main menu and press **OK** to start and stop recording. While recording, the arrow keys scale the on-screen graph (Up/Down = amplitude, Left/Right = time); **Back** stops and returns to the menu.

The graph shows the GSR **rate of change** (the derivative of skin conductance), not the absolute level. The two RF modes (GPS + GSR + RF and GPS + RF) add a per-band RSSI panel down the left edge. The CSV always stores the **absolute** conductance in nS; the derivative is display-only.

The RGB LED gives a once-per-second heartbeat while recording: green = OK, red = electrodes reading open-circuit, solid red = SD/filesystem error (recording stopped). Short tones mark recording start/stop, mode changes, and errors — mute them in **Options → Sound**.

## Options

Backlight, sound, and auto-zoom are self-explanatory toggles. The rest:

- **GPS Profile** — dynamic navigation model: Pedestrian (default), Wrist-worn, Vehicle, Stationary, Sea, Bike, Flight.
- **Reset GPS** — hot-start command; use if GPS data looks stale or frozen.
- **GSR Calibration** — 3-point wizard (below); shows `YES` when a custom calibration is loaded.
- **RF Calibration** — per-band Faraday noise-floor wizard; its result becomes the `# Band Floors` line in the CSV header.
- **Debug Fields** — appends diagnostic columns to recordings (off by default, applies to the next recording). Column list in [`docs/csv_schema.md`](docs/csv_schema.md).
- **Diagnostics** — live raw sensor values (PGA range, single-sample and 100 ms-mean conductance), no recording.

### GSR Calibration Wizard

Connect three reference resistors to the electrodes in turn; the wizard solves a linear fit ($y = \text{gain} \times x + \text{offset}$) in nS.

- **Points:** 470 kΩ → 2127.66 nS; 100 kΩ → 10000.0 nS; 47 kΩ → 21276.6 nS.
- Each step gathers 20 samples over 2 s (min/max discarded) and must pass a range gate; the final fit must hold gain $\in [0.2, 5.0]$, offset $\in [\pm20000]$ nS, $R^2 \ge 0.95$.
- **OK** saves to `/ext/biomapping/biomap.cal`; **Reset to Default** restores gain 1.0 / offset 0.0.

### Signal integrity note

The piezo speaker shares the 3.3 V rail with the sensor front-end, so on a breadboard build a tone can inject noise. The firmware keeps tones out of recorded data — zoom clicks are silent while recording, the start chirp settles before the first sample, and the file is closed before the stop chirp. The one exception is the electrode-disconnect warning (those readings are out of range and excluded from analysis anyway).

## Recordings on the SD Card

Files are written to `/ext/biomapping/` as `biomap_001.csv` … `biomap_999.csv` (auto-incrementing, wraps at 999). Each row is one 10 Hz tick.

**Header.** Every file starts with `#`-prefixed metadata lines, then the column header:

```
# RecordingStartTime:1751204579
# DeviceName:Clara
# Band Floors (dBm): 815:-91.5,868:-91.5,915:-91.5
# GPSChipID:axis slang boast putt chunk
# GSR Calibration: gain:1.0234,offset:-152.7000
timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,rssi_868,rssi_915
0.00,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4523.0,2.4,-91.5,-88.0,-95.0
0.10,51.5072000,-0.1276000,1.2,1.5,8,3,2.40,185.0,4528.0,2.3,-91.5,-88.0,-95.0
```

- `RecordingStartTime` and `DeviceName` are always present, in that order. `RecordingStartTime` is a Unix epoch (UTC) from the Flipper RTC (`0` if the RTC was never set — set it to UTC before recording); `DeviceName` is the Flipper's user-visible name, empty if the HAL returns none.
- The other three lines are conditional: `# Band Floors` when RF is active **and** an RF calibration exists (the visualiser uses it to normalise RSSI); `# GPSChipID` (a 5-word mnemonic for the M10Q's unique ID) in GPS modes once the chip answers the poll, M10Q builds only; `# GSR Calibration` (the `gain`/`offset` nS fit) only when a custom calibration is loaded. Full detail in [`docs/csv_schema.md`](docs/csv_schema.md).
- `timestamp` is **relative seconds since record start** (0.1 s resolution) — absolute time for a row is `RecordingStartTime + timestamp`.
- When there's no GPS fix on a tick, `lat`/`lon` and the other GPS columns are left empty (e.g. `0.30,,,,,,,,,4519.0,`) so the visualiser reads a gap rather than a `(0,0)` point. `hacc_m` is horizontal accuracy in meters; it stays `99.9` until the module reports an estimate.

**Column count per mode:** GPS + GSR + RF and GPS + RF → 14; GPS + GSR → 11; GSR Only → 2 (`timestamp,gsr_raw`). GPS + RF rows carry `gsr_raw` = `0.0`. [`docs/csv_schema.md`](docs/csv_schema.md) is the canonical, versioned column reference; **Options → Debug Fields** appends further diagnostic columns.

**Approximate size per hour at 10 Hz:** GPS + GSR ≈ 2.1 MB; GPS + GSR + RF / GPS + RF ≈ 2.8 MB; GSR Only ≈ 0.4 MB. The log file is pre-allocated at record start and trimmed at stop, so free space briefly looks lower during a recording.

## Circuit Reference

See the [schematic](docs/gsr_circuit.png) in the Wiring Guide for the component layout referenced below.

The filtered, normalised ADC reading (`N`, counts at the ±0.256 V reference) converts to skin conductance in nS:

$$G_{nS} = \frac{N \times 5{,}000{,}000}{15{,}040{,}000 - N \times 47}$$

| Parameter | Value |
|---|---|
| V_ref (voltage divider) | 0.5 V = 3.3 V × 10 kΩ / (56 kΩ + 10 kΩ) |
| R_f (TIA feedback) | 47 kΩ |
| R_safety (two 4.7 kΩ in series) | 9.4 kΩ |
| ADC LSB at ±0.256 V | 7.8125 µV = 1/128,000 V |

Derivation: `V_diff = I_skin × R_f = (V_ref / (R_skin + R_safety)) × R_f`; `N = V_diff / 7.8125×10⁻⁶`; so `R_skin = 3,008,000,000 / N − 9,400` and `G_nS = 10⁹ / R_skin`, which simplifies to the equation above. `N ≤ 0` (open circuit) clamps to 0; `N > 319,000` (near the denominator singularity) is clamped to prevent overflow.

**On-device signal chain:** the ADS1115 is read at 860 SPS on a background thread with hysteretic PGA auto-ranging; each 10 Hz tick takes a time-based 100 ms mean (cancels 50/60 Hz mains hum), converts to nS, then applies a 3 Hz IIR low-pass. The live graph derives its rate-of-change from an EMA (`0.2 × new + 0.8 × previous`).

```mermaid
flowchart LR
    E["GSR electrodes"] --> FE["Analogue front-end<br/>TIA + 0.5 V reference buffer"]
    FE --> ADC["ADS1115<br/>860 SPS, background thread<br/>hysteretic PGA auto-ranging"]
    ADC --> MEAN["100 ms time-based mean<br/>cancels 50/60 Hz mains hum"]
    MEAN --> CONV["Convert counts to nS"]
    CONV --> IIR["3 Hz IIR low-pass"]
    IIR --> CSV["CSV @ 10 Hz<br/>absolute conductance (nS)"]
    IIR --> EMA["EMA smoothing<br/>0.2 new + 0.8 previous"]
    EMA --> GRAPH["Rate-of-change<br/>live on-screen graph"]
```

## Tuning (firmware)

The firmware applies no record-time GPS quality gate — every fix the receiver reports is logged, HDOP and all, so urban-canyon data is preserved for the visualiser to accept or reject later. Rows with no fix write empty `lat`/`lon`.

Signal-processing and display constants are compile-time `#define`s in `firmware/biomap_types.h` (tick rate, the 3 Hz smoothing IIR coefficients, the display EMA, auto-zoom behaviour) and `firmware/modules/gsr_sensor.h` (ADS1115 address, the open-circuit / rail-saturation nS bounds).

## Application Metadata

| Field | Value |
|---|---|
| App ID | `biomap` |
| Name | Bio Mapping |
| Type | External FAP, category GPIO |
| Requires | `gui`, `storage`, `notification`, `expansion`, `bt` |
| Stack size | 4 KB |

---

# The Visualiser

Browser software under [`visualiser/`](visualiser/) — no server, no build step to run it. It has two entry points.

## Post-Processing

[`visualiser/index.html`](visualiser/index.html) — open it directly in a browser and drag one or more `biomap_*.csv` files onto it. It:

1. **Loads** the CSV, honouring the `#` metadata header and relative-seconds `timestamp`, skipping rows with empty `lat`/`lon` (GPS gaps).
2. **Filters** the GSR signal (median + low-pass) and decomposes it into tonic and phasic components — low-pass by default, or a Daubechies-db3 DWT.
3. **Detects peaks** on the phasic signal with trough-to-peak shape-quality scoring (an optional SCR deconvolution mode, Benedek & Kaernbach 2010, replaces this step).
4. **Maps** the track on a Leaflet base map and places a marker at each detected peak.
5. **Clusters** the peaks by geographic proximity into boundary blobs styled by peak severity. **Collective mode** does this across multiple overlaid tracks and adds an inverse-distance-weighted (IDW) contour surface, optionally enriched against OpenStreetMap features (road class, green space, buildings).

```mermaid
flowchart LR
    CSV["biomap_*.csv<br/>(one or more)"] --> LOAD["Load<br/>honour # metadata header<br/>skip empty lat/lon (GPS gaps)"]
    LOAD --> FILT["Filter GSR<br/>median + low-pass"]
    FILT --> SPLIT["Tonic / phasic split<br/>low-pass default, or db3 DWT"]
    SPLIT --> PEAK["Peak detection<br/>trough-to-peak shape scoring"]
    PEAK --> MAP["Leaflet map<br/>peak markers on the track"]
    MAP --> CLUST["Spatial peak clusters<br/>proximity-grouped blobs"]
    CLUST --> Q{"Collective mode?"}
    Q -->|no| SINGLE["Single-track map"]
    Q -->|yes| COLL["Overlay multiple tracks<br/>IDW contour surface<br/>enrich vs OpenStreetMap features"]
```

Filtering, peak detection, and the GPS quality filter are all adjustable in the UI at runtime — no rebuild. The firmware logs every GPS fix; the HDOP filter (default 3.0) is applied here, at display time, and is non-destructive.

## Live View

[`visualiser/live.html`](visualiser/live.html) — receives GPS + GSR from the Flipper's **Live Stream** mode over Bluetooth LE in real time, for watching a walk unfold on a laptop or phone as it happens.

- **On the Flipper:** select **Live Stream**. The screen shows BLE status (`Advertising` / `Connected`), the dropped-packet count, and live GSR / GPS readouts. It sends a 45-byte packed binary packet every 300 ms over the stock BLE serial profile. Design notes: [`docs/archive/bluetooth_serial_investigation.md`](docs/archive/bluetooth_serial_investigation.md).
- **In the browser:** open `live.html`, press **Connect**, and pair with the Flipper. It shows a rolling GSR graph and a Leaflet map of the track, flags dropped-packet gaps, and can **Export CSV** in the same 11-column GPS + GSR schema as a recorded track.
- **Browser support:** Web Bluetooth needs desktop Chrome / Edge or Android Chrome / Edge. Safari (any platform) and Firefox are unsupported — there is no iPhone path.

## CSV Schema

[`docs/csv_schema.md`](docs/csv_schema.md) is the canonical, versioned definition of every column and sentinel value, shared by the firmware writer and both visualiser pages.

## Licence

Bio Mapping is open for community, artistic, and educational use under the **Bio Mapping Community Licence 1.0**.

In short: You are free to build your own Bio Mapping devices for personal use, research, and workshops (including charging participants for materials). You cannot manufacture or sell Bio Mapping hardware or software commercially without written permission. See `LICENCE.md` for full details.
