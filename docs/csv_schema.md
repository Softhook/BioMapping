# BioMapping CSV Schema

> **Canonical reference.** Update this file whenever the column list changes.
> Referenced from: `biomap_session.c`, `sd_logger.h`, `analyzer.js`, `scripts/analyze_track.py`.

---

## File Naming

```
/ext/biomapping/biomap_001.csv
/ext/biomapping/biomap_002.csv
...
/ext/biomapping/biomap_999.csv  (wraps back to 001)
```

---

## Metadata Header Lines

Each CSV begins with comment lines (prefixed `#`) before the column header:

```
# RecordingStartTime:<unix_epoch_seconds>
# DeviceName:<flipper_device_name>
# Band Floors (dBm): 815:<float>,868:<float>,915:<float>
# GPSChipID:<word1 word2 word3 word4 word5>
# GSR Calibration: gain:<float>,offset:<float>
```

Emitted in the order shown above (`biomap_session.c`,
`key_toggle_recording()`). `RecordingStartTime` and `DeviceName` are always
present; the other three are conditional (see below).

`RecordingStartTime` is `0` if the Flipper RTC has never been set.

`DeviceName` is always present — the Flipper's user-visible name
(`furi_hal_version_get_name_ptr()`, Settings > System > Device Name),
for tracing which physical unit recorded a given file. Empty
(`# DeviceName:`) only if the HAL returns no name.

`GPSChipID` is a 5-word mnemonic phrase (e.g. `axis slang boast putt
chunk`) derived from the u-blox SAM-M10Q module's unique chip identifier,
retrieved via a binary UBX-SEC-UNIQID poll during GPS init and rendered
using the EFF short wordlist (`modules/eff_short_wordlist.h`) instead of
the raw 12-hex-digit value — see `gps_uart_get_chip_id()`'s doc comment in
`modules/gps_uart.h` for the exact derivation. `1296^5 == 6^20 >= 2^48`,
so this is a lossless, collision-free encoding of the full 48-bit chip
ID, not just a recognisable approximation. It only
appears when GPS is active for the session **and** the poll actually got a
valid response — best-effort (the poll gets one retry, then gives up), so
this line may be absent even in a GPS-bearing session if the module didn't
answer. Not emitted at all on L76K builds (no UBX protocol support). Once
found, the ID is cached for the rest of the app session, so if it's present
on one recording it should be present on every recording after that until
the app is closed.

The `# Band Floors` line only appears when RF is active for the session (GPS +
GSR + RF or GPS + RF) **and** an RF calibration exists (`key_toggle_recording()`,
`biomap_session.c`).

`GSR Calibration` records the linear fit (`gain`, `offset` in nS) applied
inside `GsrSensor` before `gsr_raw` is ever computed
(`gsr_sensor_set_calibration()`) — the only record of what transform produced
the logged values. It appears only when a calibration is active — a
`biomap.cal` was loaded or one was set through the calibration wizard
(`cal_active`, `biomap.c`). An uncalibrated recording, which runs at the
identity fit (gain 1.0 / offset 0.0), omits the line.

---

## Debug Field Toggle

CSV debug columns are controlled by **Options > Debug Fields** on the device
(`BioMapApp::debug_fields_enabled`, persisted in `biomap.settings`) — a
runtime toggle, **off by default**. This replaced the old
`BIOMAP_DEBUG_FIELDS` compile-time switch (`biomap_config.h`) on 2026-08-05:
both the production and debug column sets (`BIOMAP_CSV_COLS_*_PROD` /
`_DEBUG`) are always compiled into the firmware now, so switching this no
longer requires a rebuild — just an Options-menu toggle before starting a
recording. Since it's read once at `session_init()` (mirroring
`zoom_enabled`'s lifecycle), a change only takes effect for the *next*
recording session, not one already in progress.

- Off (default): core schemas only.
- On: appends diagnostic columns to GPS+GSR, GPS+GSR+RF, and GSR-only rows.

Core production schemas:

- GPS+GSR: 11 columns (`timestamp`..`hacc_m`)
- GPS+GSR+RF: 14 columns (`timestamp`..`hacc_m` + `rssi_815/868/915`)
- GSR-only: 2 columns (`timestamp`,`gsr_raw`)

Debug-only appended columns when enabled:

- `tick_dt_ms`, `gps_rx_drops`, `nmea_fail`, `gps_reinit_count` (GPS-bearing modes only), `gsr_hz`
- `i2c_peak_ms`, `rf_rssi_peak_ms`, `rf_retune_peak_ms`
- `flush_peak_ms`, `log_fill_bytes`, `log_fill_peak_bytes`, `log_overflow_count`, `log_flush_fail_count`
- `pga_change_count`, `i2c_consec_fail` (all GSR-bearing modes, including GSR-only)
- `prealloc_ms` (all three variants) — one-shot SD log-file pre-allocation duration at recording start, session-constant rather than a lifetime-max like the columns above (`BIOMAP_SD_PREALLOC`, see `docs/archive/gps_rf_mutex_status.md`'s "option E" entries)

---

## Column Definitions

| # | Column | Type | Unit | Sentinel / Notes |
|---|---|---|---|---|
| 1 | `timestamp` | float | seconds (relative) | Seconds since recording start. Resolution = 0.1 s (TICK_HZ = 10). |
| 2 | `lat` | float | decimal degrees | **Empty string** if no valid GPS fix this tick. |
| 3 | `lon` | float | decimal degrees | **Empty string** if no valid GPS fix. |
| 4 | `hdop` | float | dimensionless | `99.9` = no fix or no GSA sentence yet. |
| 5 | `pdop` | float | dimensionless | `99.9` = no GSA sentence received. Chip-computed across all constellations. |
| 6 | `sats` | int | count | Visible satellites across all constellations (from GSV). `0` = no GSV received. |
| 7 | `fix_type` | int | enum | `1` = no fix, `2` = 2D fix, `3` = 3D fix (from GSA sentence). |
| 8 | `speed_kts` | float | knots | Doppler-derived speed from RMC. More accurate than position-derived. `0.0` if unavailable. |
| 9 | `course_deg` | float | degrees (true north) | True course over ground from RMC. `0.0` if unavailable. |
| 10 | `gsr_raw` | float | nanosiemens (nS) | Raw skin conductance. `0.0` if sensor unavailable. |
| 11 | `hacc_m` | float | meters | Horizontal accuracy from `$PUBX,00` Field 9. **Empty string** if no valid fix. `99.9` = no `$PUBX,00`. M10Q-only. |
| 12 | `rssi_815` | float | dBm | SubGHz 815 MHz instantaneous RSSI peak for most recent dwell on band. |
| 13 | `rssi_868` | float | dBm | SubGHz 868 MHz instantaneous RSSI peak for most recent dwell on band. |
| 14 | `rssi_915` | float | dBm | SubGHz 915 MHz instantaneous RSSI peak for most recent dwell on band. |


---

## GPS Column Sentinel Behaviour

`lat` and `lon` are **empty strings** (not `0.0`) when no fix exists. All other GPS columns use numeric sentinels. When parsing, check `row.get('lat', '').strip()` to test for GPS presence.

---

## HDOP Gate Design

The firmware applies **no** record-time HDOP threshold — every fix the receiver reports is logged, so urban-canyon data is never permanently discarded. HDOP filtering happens only downstream, in the visualiser:

| Context | Value | Location | Purpose |
|---|---|---|---|
| JS visualiser default | `3.0` | `constants.js GPS_DEFAULT.maxHdop` | Post-processing quality filter, user-adjustable, non-destructive |

---

## GSR Validity Range

| Condition | Range | Interpretation |
|---|---|---|
| Normal | 1 000 – 20 000 nS | Typical resting range (1–20 µS) |
| Open circuit | < 0.1 nS | Electrodes not attached (`GSR_VALID_MIN_NS`) |
| Rail saturation | > 75 000 nS | Hardware fault or shorts (`GSR_VALID_MAX_NS`)|

Defined in `modules/gsr_sensor.h` as `GSR_VALID_MIN_NS` and `GSR_VALID_MAX_NS`.

---

## Schema Version History

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-06 | Initial: `timestamp, lat, lon, alt, sats, fix, gsr_raw` (7 columns) |
| 1.1 | 2026-07 | Added `hdop, pdop, speed_kts, course_deg`; renamed `fix`→`fix_type`; removed `alt`; total 10 columns |
| 1.2 | 2026-07 | Added `hacc_m` (M10Q-only physical accuracy in meters, `$PUBX,00`); total 11 columns |
| 1.3 | 2026-07 | Added SubGHz RF columns (`rssi_815/868/915` & `rssi_peak_815/868/915`) for `GPS+GSR+RF` mode; total 17 columns |
| 1.4 | 2026-07 | Removed `rssi_peak_815/868/915` (decaying peak-hold) — redundant with raw RSSI for offline analysis; total 14 columns |
| 1.5 | 2026-08-05 | Debug-field review (see `docs/archive/gps_rf_mutex_status.md`): added `gps_reinit_count` (GPS-bearing debug modes) and `pga_change_count`/`i2c_consec_fail` (all GSR-bearing debug modes) — promoted from serial-only/Diagnostics-screen-only readings that never reached the CSV. No production (non-debug) column changes. |
| 1.6 | 2026-08-05 | `BIOMAP_DEBUG_FIELDS` compile-time switch replaced with a persisted runtime Options-menu toggle (`BioMapApp::debug_fields_enabled`, Options > Debug Fields), off by default. No column-list changes — same debug columns as 1.5, just switchable per-session without a rebuild. |
| 1.7 | 2026-08-05 | Added `prealloc_ms` (all three debug variants) alongside `BIOMAP_SD_PREALLOC` — see `docs/archive/gps_rf_mutex_status.md`. Also: the metadata header's old `# BioMapping v1.0` / `# GPS:<module>` lines don't reflect the current format — corrected above to `# RecordingStartTime:` + conditional `# Band Floors` line. |
| 1.8 | 2026-08-28 | Doc sync, no column changes: documented the `# GSR Calibration: gain:…,offset:…` metadata line (emitted since custom GSR calibration shipped) and corrected the metadata-header order to match `biomap_session.c`. Post-processing enrichment columns (`osm_*`, snapped GPS) are appended by the visualiser, not the firmware writer — see [`environmental_enrichment_plan.md`](environmental_enrichment_plan.md). |

---

## `hacc_m`: Direct Spatial Error in Meters

`hacc_m` lets downstream Kalman filters substitute unitless $\text{DOP}^2$ measurement noise scaling with exact physical measurement covariance ($R = \text{hacc\_m}^2$), improving track smoothing in urban multipath environments where HDOP/PDOP stay low but true position error spikes. See [`gps_filtering_pipeline.md`](gps_filtering_pipeline.md) §6 for the Kalman-side implementation. Since it's M10Q-only, downstream consumers must fall back to DOP²-scaling when `hacc_m` is empty or `99.9`.
