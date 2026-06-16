# Decouple GSR and GPS — Final Plan

## Overview

Refactor BioMapping so GPS and GSR are independently toggleable at runtime. All recording writes raw data to **CSV** (7 columns). GPX files are produced **post-recording** by a converter that applies signal processing to the raw GSR data.

### App Flow

```
┌─────────────────────┐
│   BioMapping 3.0    │
│                     │
│  ▸ GPS + GSR        │
│    GPS Only         │
│    GSR Only         │
│    Convert CSV→GPX  │
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│  Main recording     │     Records to CSV:
│  screen             │ ──► biomap_042.csv
│                     │
│  OK = start/stop    │
│  Back = menu        │
└─────────────────────┘
        │
        ▼  (later, from menu)
┌─────────────────────┐
│  Convert CSV→GPX    │
│                     │     Reads biomap_042.csv
│  Select a CSV file  │ ──► Writes biomap_042.gpx
│                     │
└─────────────────────┘
```

---

## CSV Format (7 columns, final)

```
timestamp,lat,lon,alt,sats,fix,gsr_raw
2026-06-05T13:33:12Z,51.507200,-0.127600,12.3,8,1,4523
2026-06-05T13:33:13Z,51.507250,-0.127650,12.1,8,1,4510
2026-06-05T13:33:14Z,0,0,0,0,0,4480
```

| Column | Type | Source | Notes |
|---|---|---|---|
| `timestamp` | ISO 8601 UTC string | GPS NMEA time when GPS active; Flipper RTC otherwise | L76K has battery-backed RTC so UTC time is available quickly even before full satellite fix |
| `lat` | float (6 dp) | GGA/RMC sentence | `0` when GPS disabled or no fix |
| `lon` | float (6 dp) | GGA/RMC sentence | `0` when GPS disabled or no fix |
| `alt` | float (1 dp) | GGA sentence | `0` when GPS disabled or no fix |
| `sats` | int | GGA sentence | `0` when GPS disabled |
| `fix` | int (0/1/2) | GGA sentence | `0` = no fix/disabled, `1` = GPS, `2` = DGPS |
| `gsr_raw` | int16 (−32768…32767) | ADS1115 differential read | `0` when GSR disabled or unavailable. Raw ADC value — no smoothing or scaling applied |

**Row size:** ~70 bytes typical. At 1 row/second, a 1-hour walk produces ~250 KB. Trivial for SD card.

### Timestamps

- **GPS active:** The L76K GNSS shield has a battery-backed RTC. Once the module has had a satellite fix, it retains accurate UTC time even across power cycles. The time arrives in every RMC/GGA NMEA sentence, so it's available almost immediately — often before a full position fix.
- **GPS inactive (GSR-only mode):** Falls back to the Flipper's own RTC via `furi_hal_rtc_get_datetime()`. The Flipper's RTC is set by the user and may not be UTC, but it provides monotonic second-resolution timing.

---

## Proposed Changes

### New Files

#### [NEW] [biomap_config.h](file:///Users/softhook/Documents/GitHub/BioMapping/biomap_config.h)
Runtime mode enum and shared constants:
```c
typedef enum {
    BioMapModeGpsGsr = 0,  // Both enabled
    BioMapModeGpsOnly,     // GPS track, no biometrics
    BioMapModeGsrOnly,     // Waveform viewer, no location
} BioMapMode;
```

---

#### [NEW] [modules/gpx_converter.h](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gpx_converter.h)
#### [NEW] [modules/gpx_converter.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gpx_converter.c)

Post-processing converter that reads a `biomap_*.csv` file and produces a `biomap_*.gpx` file.

**API:**
```c
GpxConverter* gpx_converter_alloc(Storage* storage);
void          gpx_converter_free(GpxConverter* conv);
int           gpx_converter_scan(GpxConverter* conv);           // find CSV files
const char*   gpx_converter_get_name(GpxConverter* conv, int i); // for menu
bool          gpx_converter_run(GpxConverter* conv, const char* csv_filename);
```

**Signal processing in `gpx_converter_run()`:**
1. Read CSV line by line
2. For each row, extract `gsr_raw` (int16)
3. Apply **EMA smoothing**: `smoothed = α × raw + (1−α) × prev_smoothed` (α = 0.2)
4. Compute **derivative**: `rate = smoothed − prev_smoothed`
5. Compute **elevation**: `elev = −rate × scale_factor`
6. For rows with valid GPS (`fix > 0, lat ≠ 0`): write `<trkpt>` with lat, lon, elevation, timestamp
7. Skip rows with no GPS fix (GSR-only rows can't be placed on a map)

This means the EMA/derivative constants (α, scale) live in the converter, making them tuneable without re-recording.

---

### Modified Files

---

#### [MODIFY] [biomap.c](file:///Users/softhook/Documents/GitHub/BioMapping/biomap.c)

**Structural change — two-phase app:**

**Phase 1: Launch menu**
- `Submenu` with 4 items: GPS+GSR, GPS Only, GSR Only, Convert CSV→GPX
- Back = exit app
- OK on a mode = enter recording view
- OK on Convert = run converter flow, return to menu

**Phase 2: Recording view (existing main loop, guarded by mode)**

App struct changes:
```c
typedef struct {
    BioMapMode mode;            // set at launch
    GpsUart*   gps;             // NULL when mode == GsrOnly
    GsrSensor* gsr;             // NULL when mode == GpsOnly
    SdLogger*  logger;
    uint32_t   recording_start; // furi_get_tick() at record start
    // ... rest as before
} BioMapApp;
```

Conditional init:
- OTG 5V power: only when `mode != GsrOnly`
- `gps_uart_alloc()`: only when `mode != GsrOnly`
- `gsr_sensor_alloc()`: only when `mode != GpsOnly`
- Expansion Service disable: only when GPS active

Event loop guards:
- `EventTypeUart`: only process when `app->gps != NULL`
- `gsr_sensor_tick()`: only call when `app->gsr != NULL`

1-second write:
```c
// Gather whatever data is available
float lat = 0, lon = 0, alt = 0;
int sats = 0, fix = 0;
int16_t gsr_raw = 0;

if(app->gps) {
    GpsStatus gps = gps_uart_get_status(app->gps);
    lat = gps.latitude; lon = gps.longitude; alt = gps.altitude;
    sats = gps.satellites_tracked; fix = gps.fix_quality;
}
if(app->gsr) {
    gsr_raw = gsr_sensor_get_raw(app->gsr);
}

sd_logger_write_row(app->logger, &gps_status_or_null, gsr_raw);
```

Render callback adapts to mode:
- **GPS+GSR**: current layout (GPS info left, waveform right)
- **GPS Only**: GPS info full width, no waveform
- **GSR Only**: "GSR Only" header, waveform uses full width

Shutdown: only free modules that were allocated.

---

#### [MODIFY] [sd_logger.h](file:///Users/softhook/Documents/GitHub/BioMapping/modules/sd_logger.h)
#### [MODIFY] [sd_logger.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/sd_logger.c)

**Simplified to a CSV writer.** All GPX logic removed.

- Remove `#include "gps_uart.h"` — no dependency on GpsStatus
- File extension: `.csv` instead of `.gpx`
- `sd_logger_start()`: write CSV header row
- `sd_logger_stop()`: just close the file (no XML footer)
- Replace `sd_logger_write_point()` with:

```c
void sd_logger_write_row(
    SdLogger*    logger,
    const char*  timestamp,    // ISO 8601 string
    float        lat,
    float        lon,
    float        alt,
    int          sats,
    int          fix,
    int16_t      gsr_raw
);
```

The caller (biomap.c) is responsible for formatting the timestamp from GPS or Flipper RTC.

---

#### [MODIFY] [gsr_sensor.h](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gsr_sensor.h)
- Remove `#define GSR_ENABLED 0` compile-time flag — always probe ADS1115 at runtime
- The existing `gsr_sensor_available()` check handles graceful degradation
- Update stale comments about I2C pin conflict (resolved by trace cuts)

#### [MODIFY] [gsr_sensor.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gsr_sensor.c)
- Remove `#if GSR_ENABLED` guards — always attempt I2C probe
- Remove EMA/derivative computation from `gsr_sensor_tick()` — just read and store raw value
- Remove `gsr_sensor_get_elevation_base()` and `gsr_sensor_reset_primer()` — elevation is now computed only by the GPX converter
- Keep `gsr_sensor_get_raw()` as the primary output

> [!NOTE]
> The real-time waveform graph still needs *something* to display. Since we're removing the EMA from the sensor module, `biomap.c` will maintain its own lightweight display-only smoothing in the graph ring buffer. This is purely visual — it's not stored or logged.

---

#### [MODIFY] [gps_uart.h](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gps_uart.h)
- Clean up stale comments referencing "no trace cuts", Pin 15/16 as STANDBY/RESET
- API unchanged

#### [MODIFY] [gps_uart.c](file:///Users/softhook/Documents/GitHub/BioMapping/modules/gps_uart.c)
- Clean up stale comments
- Code unchanged

---

#### [MODIFY] [application.fam](file:///Users/softhook/Documents/GitHub/BioMapping/application.fam)
- Add `modules/gpx_converter.c` to the sources list

---

#### [MODIFY] [biomap_events.h](file:///Users/softhook/Documents/GitHub/BioMapping/biomap_events.h)
- No changes needed. `EventTypeUart` stays defined; never posted when GPS isn't running.

---

## Summary of Module Dependencies (after refactor)

```
biomap.c
  ├── biomap_config.h     (mode enum)
  ├── biomap_events.h     (event types)
  ├── gps_uart.h          (optional, based on mode)
  ├── gsr_sensor.h        (optional, based on mode)
  ├── sd_logger.h         (CSV writer, no GPS/GSR knowledge)
  └── gpx_converter.h     (post-processing, no runtime deps)

sd_logger ──► (standalone, no module deps)
gpx_converter ──► (standalone, reads CSV files)
gps_uart ──► (standalone, UART + minmea)
gsr_sensor ──► (standalone, I2C)
```

No module depends on any other module. All coupling runs through `biomap.c`.

---

## Verification Plan

### Compilation
- Build with `ufbt` — verify clean compile

### Manual Verification
1. **GPS+GSR**: Record → verify CSV has all 7 columns populated with real data
2. **GPS Only**: Record → verify CSV has GPS columns, `gsr_raw` is `0`, no I2C bus access
3. **GSR Only**: Record → verify CSV has `gsr_raw` values, GPS columns are `0`, no OTG power, no UART
4. **Convert CSV→GPX**: Record a GPS+GSR walk → Convert → verify valid GPX with elevation from GSR
5. **Edge case**: Convert a GSR-only CSV → converter warns "no GPS data" and produces empty/minimal GPX
