# BioMapping

A Flipper Zero application for simultaneous GPS track recording and galvanic skin response (GSR/EDA) measurement. Logs geo-tagged physiological data to SD card, with a browser-based analyser for post-processing and visualisation.

---

## Hardware

| Component | Details |
|---|---|
| Flipper Zero | Any firmware version ≥ 0.87 |
| GPS module | Quectel **L76K** (default) or u-blox **SAM-M10Q** |
| GSR sensor | ADS1115-based TIA circuit on I2C (address 0x48) |
| SD card | Any capacity; FAT32 formatted |

The GPS module connects via the Flipper external GPIO header (USART1). The GSR sensor connects via I2C (pins 15/16 on the GPIO header). Both are powered from the 3.3 V rail.

---

## Firmware Build

### 1. Select GPS module

Edit [`biomap_config.h`](biomap_config.h):

```c
// Choose ONE:
#define GPS_MODULE  GPS_MODULE_L76K   // Quectel L76K (default)
#define GPS_MODULE  GPS_MODULE_M10Q   // u-blox SAM-M10Q / NEO-M10Q
```

### 2. Build with ufbt

```bash
# Install ufbt if needed
pip install ufbt

# Build and deploy over USB
ufbt launch
```

### 3. Manual SD copy (alternative)

```bash
ufbt build
# Copy build/f7-firmware/biomap.fap to /ext/apps/GPIO/ on the SD card
```

---

## Recording

1. Launch **Bio Mapping** from the GPIO apps menu.
2. Select **GPS mode** or **GPS + GSR** from the menu.
3. Press **OK** to start recording.
4. Press **OK** again to stop. The file is flushed and closed automatically.

**SD card output:**

```
/ext/biomapping/biomap_001.csv
/ext/biomapping/biomap_002.csv
...
```

Index auto-increments. See [`docs/csv_schema.md`](docs/csv_schema.md) for the full column specification.

---

## Web Analyser

Open [`gsr-map-analyzer/index.html`](gsr-map-analyzer/index.html) directly in a browser (no server required).

**Features:**
- Drag-and-drop CSV loading (multi-track supported)
- GSR filtering: median, LPF, tonic/phasic decomposition (DWT)
- Peak detection with shape quality scoring
- Leaflet map with GPS track coloured by arousal
- Collective mode: overlay multiple tracks with IDW contour surface
- OpenStreetMap enrichment: correlate arousal with road class, green space, buildings
- Export: processed CSV, GeoJSON, map PNG

**Quick start:**
1. Open `index.html` in Chrome or Firefox
2. Drop a `biomap_XXX.csv` file onto the drop zone
3. Click **Analyse** — adjust sliders to taste

---

## Python Analysis Script

```bash
# Single track: GPS quality report + GSR noise analysis
python3 analyze_track.py biomap_001.csv

# Two tracks: compare GSR noise (e.g. different baud rates)
python3 analyze_track.py biomap_001.csv biomap_002.csv
```

No dependencies beyond the Python standard library.

---

## CSV Format

See [`docs/csv_schema.md`](docs/csv_schema.md) for the authoritative field-by-field reference, including sentinel values, the HDOP gate design, and schema version history.

**Quick summary (10 columns):**
```
timestamp, lat, lon, hdop, pdop, sats, fix_type, speed_kts, course_deg, gsr_raw
```

---

## Repository Structure

```
BioMapping/
├── biomap.c / .h          ← App entry, lifecycle
├── biomap_session.c       ← Recording event loop + data pipeline
├── biomap_render.c        ← Canvas rendering
├── biomap_gui.c           ← Menu and options screens
├── biomap_config.h        ← GPS module selection (edit this)
├── biomap_types.h         ← Constants (HDOP gate, IIR coefficients, etc.)
├── modules/
│   ├── gps_uart.c/h       ← NMEA parser + serial management
│   ├── gsr_sensor.c/h     ← ADS1115 driver + PGA autoranging
│   ├── sd_logger.c/h      ← Batched CSV writer
│   └── util.h             ← Shared utilities
├── minmea.c/h             ← Third-party NMEA library
├── analyze_track.py       ← CLI GPS/GSR quality analysis
├── compare_noise.py       ← GSR noise comparison between tracks
├── docs/
│   ├── csv_schema.md      ← Authoritative CSV column spec
│   └── refactoring_analysis.md
└── gsr-map-analyzer/      ← Browser-based analyser (open index.html)
```
