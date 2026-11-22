# BioMapping CSV Schema

> **Canonical reference.** Update this file whenever the column list changes.
> Referenced from: `core/biomap_session.c`, `sd_logger.h`, `analyzer.mjs`, `scripts/analyze_track.py`.
>
> The live receiver's CSV export (`visualiser/src/live/live_csv.mjs`) and wire
> decoder (`visualiser/src/live/live_binary_parser.mjs`) are locked to the
> firmware save format by `visualiser/tests/test_firmware_csv_contract.js`,
> which reads the firmware source directly and fails on any drift — run
> `npm test` in `visualiser/` after changing the format on either side.

---

## File Naming

```
/ext/biomapping/biomap_2026-11-19_14-32-05.csv
/ext/biomapping/biomap_2026-11-19_14-32-05_2.csv  (same start second as an existing file)
```

Each file is named after the time the recording started, read from the
Flipper's clock (local time, no time zone). The order follows ISO 8601
(year, month, day, hour, minute, second), so files sort by time. "-" stands
in for ":" because ":" is not allowed in file names on the SD card. If a file
with the same name already exists, `_2`, `_3` and so on is added before `.csv`,
so an older recording is never overwritten. The same clock reading is written
to the `# RecordingStartTime` header line.

---

## Metadata Header Lines

Each CSV begins with comment lines (prefixed `#`) before the column header:

```
# RecordingStartTime:<unix_epoch_seconds>
# DeviceName:<flipper_device_name>
# Band Floors (dBm): 815:<float>,868:<float>,915:<float>
# GPSChipID:<word1 word2 word3 word4 word5>
# GSR Calibration: gain:<float>,zero_counts:<float>,r2:<float>,noise_ns:<float>,<float>,<float>,cal_time:<unix_epoch_seconds>
# GSR Bias: measured_mv:<float|none>,used_mv:<float>
```

Emitted in the order shown above (`core/biomap_session.c`,
`build_header()`). `RecordingStartTime` and `DeviceName` are always
present; the other four are conditional (see below).

`RecordingStartTime` is `0` if the Flipper RTC has never been set.

`DeviceName` is always present — the Flipper's user-visible name
(`furi_hal_version_get_name_ptr()`, Settings > System > Device Name),
for tracing which physical unit recorded a given file. Empty
(`# DeviceName:`) only if the HAL returns no name.

`GPSChipID` is a 5-word mnemonic phrase (e.g. `axis slang boast putt
chunk`) derived from the u-blox SAM-M10Q module's unique chip identifier,
retrieved via a binary UBX-SEC-UNIQID poll during GPS init and rendered
using the EFF short wordlist (`core/eff_short_wordlist.h`) instead of
the raw 12-hex-digit value — see `gps_uart_get_chip_id()`'s doc comment in
`core/gps_uart.h` for the exact derivation. `1296^5 == 6^20 >= 2^48`,
so this is a lossless, collision-free encoding of the full 48-bit chip
ID, not just a recognisable approximation. It only
appears when GPS is active for the session **and** the poll actually got a
valid response — best-effort (the poll gets one retry, then gives up), so
this line may be absent even in a GPS-bearing session if the module didn't
answer. Once
found, the ID is cached for the rest of the app session, so if it's present
on one recording it should be present on every recording after that until
the app is closed.

The `# Band Floors` line only appears when RF is active for the session (GPS +
GSR + RF or GPS + RF) **and** an RF calibration exists (`build_header()`,
`core/biomap_session.c`).

`GSR Calibration` records the calibration applied inside `GsrSensor` before
`gsr_raw` is ever computed (`gsr_sensor_set_calibration()`) — the only
record of what transform produced the logged values:
`gsr_raw = gain × TIA(counts − zero_counts)`. `zero_counts` is the board's
open-circuit reading (normalised ADC counts, 7.8125 µV each), measured by
the wizard's first step with nothing connected and removed before the nS
conversion; `gain` is a fit through the origin on the three resistors. It
appears only when a calibration is active — a `biomap.cal` was loaded or one
was set through the calibration wizard (`cal_active`, `biomap.c`). An
uncalibrated recording (gain 1.0, no zero removed) omits the line.

`r2` is the wizard's least-squares fit goodness (0..1) and `noise_ns` is the
per-resistor σ (nanosiemens, 470k/100k/47k order) from its pre-flight
noise/resolution check — see `CalNoiseGrade` (`biomap_format.h`) and
the `CalDwell` accumulator (`core/biomap_format.h`). These
are written as the actual measured numbers, not the Excellent/Acceptable/
Poor label the wizard screens show, so a recording's data quality is
reportable and comparable across tracks straight from the CSV. Both ride on
the same `cal_active` gate as `gain`/`zero_counts` — an uncalibrated recording has
no fit or noise data to report, so the whole line is omitted.

`GSR Bias` records the 0.5 V bias that drives the skin current, measured
when the recording started (AIN1 against ground, `gsr_sensor.h`). The skin
reading is directly proportional to this bias, and the bias follows the
3.3 V supply, so `gsr_raw` is computed with the measured value rather than
an assumed 500 mV. It is measured once, before the first row (the mean of
16 readings over about 16 ms), and the same value is used for the whole
file — never updated mid-recording, so it can't put a step in the data.
Short wobbles on the 3.3 V supply are smoothed out by C9 on the board
(over about 85 ms) before the bias is read; a supply dip that lasts longer
than that at the moment of the check would still be captured.

- `measured_mv` is what the check read, or `none` if it failed (I2C error,
  or no answer within 200 ms).
- `used_mv` is the bias applied to every row. It equals `measured_mv` when
  the reading was in range (450–550 mV). Otherwise it is the last good value
  from earlier in the session, or 500.0 if there has been none — so a
  difference between the two flags a wiring or supply problem.

The line appears in every recording with GSR (GSR-only, GPS + GSR, GPS + GSR
+ RF). The bias correction is applied before the calibration fit in
`GSR Calibration`; calibrations saved before it existed (version 4) are
rejected, and the wizard must be run again.

`cal_time` is when the calibration was saved (Unix epoch seconds, same units
as `RecordingStartTime`; `BioMapCalibration.timestamp` in `biomap_format.h`),
so an old recording can be traced back to the calibration behind it. It is
`0` if the Flipper's clock was unset when the calibration was saved.

---

## Integrity Bracket

Every recording is wrapped by two lines so the visualiser (or any external
tool) can tell a complete, unaltered file from a truncated or corrupted one
(`core/sd_logger.c`, `SD_LOGGER_INTEGRITY_LINE` / `sd_logger_write_trailer()`).

**First line of the file** — the marker, always present:

```
# Integrity: crc32 v1
```

It announces that a trailer is expected and names the algorithm/version so
the format can evolve without breaking older parsers.

**Last line of the file** — the trailer, written by `sd_logger_stop()` once
the final batch has flushed:

```
# End rows:<n> bytes:<n> crc32:<8 hex digits> [end_time:<unix_epoch_seconds>] overflows:<n> flush_fails:<n>
```

| Field | Meaning |
|---|---|
| `rows` | Number of data rows (`\n` count after the column header). Truncation check. |
| `bytes` | Byte length of the CRC-covered region: the marker line + metadata header + column header + every data row, i.e. everything from byte 0 up to (not including) this trailer line. |
| `crc32` | CRC32 (reflected, polynomial `0xEDB88320`, same as `em_scan_cal.c`) over exactly those `bytes` bytes. Lower-case, zero-padded to 8 digits. |
| `end_time` | Wall-clock time at stop, Unix epoch seconds. **Omitted entirely** (not written as `0`) when the RTC is unset — same convention as `RecordingStartTime`. Pair with `RecordingStartTime` for an authoritative recording duration. |
| `overflows` | Rows that could not be buffered during the recording (actual data loss under SD pressure). `0` for a healthy recording. |
| `flush_fails` | SD write/sync failures during the recording, even if a later retry recovered. `> 0` flags a file that hit SD pressure. |

Verification on import:

- **No marker, no trailer** — a pre-integrity file (or one written by other
  tooling). Nothing to check.
- **Marker present, no trailer** — the recording never stopped cleanly (flat
  battery, crash, card pulled mid-write). The rows that are present are
  still usable; the tail may be missing.
- **Trailer present, `crc32` / `rows` / `bytes` disagree with the data** —
  the file was truncated or altered after the Flipper wrote it.
- **Trailer present and everything matches** — complete and unmodified since
  the Flipper wrote it. (This is corruption detection, not tamper
  protection: a plain CRC can be recomputed by whoever edited the file.)

The CRC region is byte-exact: the trailer line is always preceded by a
`\n` that terminates the last data row (`sd_logger_stop()` inserts one if a
partial row somehow reached the file), so a consumer can split on the last
`\n# End ` and CRC everything before that `\n` inclusive.

---

## Debug Field Toggle

CSV debug columns are controlled by **Options > Debug Fields** on the device
(`BioMapApp::debug_fields_enabled`, persisted in `biomap.settings`) — a
runtime toggle, **off by default**. This replaced the old
`BIOMAP_DEBUG_FIELDS` compile-time switch (`biomap_config.h`) on 2026-08-05:
both the production and debug column sets (`BIOMAP_CSV_COLS_*_PROD` /
`_DEBUG`) are always compiled into the firmware now, so switching this no
longer requires a rebuild — just an Options-menu toggle before starting a
recording. Since it's read once at `session_core_init()` (mirroring
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
- `prealloc_ms` (all three variants) — one-shot SD log-file pre-allocation duration at recording start, session-constant rather than a lifetime-max like the columns above
- `gsr_spread_ns` (all three variants, last column) — how far the readings inside the row's 100 ms GSR window spread out

### Debug Column Definitions

| Column | Type | Unit | Description |
|---|---|---|---|
| `tick_dt_ms` | uint32 | ms | Measured wall-clock time between consecutive main loop Tick events (ideal = 100 ms at 10 Hz). |
| `gps_rx_drops` | uint32 | bytes | Cumulative UART bytes dropped due to RX stream buffer capacity exhaustion. |
| `nmea_fail` | uint32 | count | Cumulative NMEA sentences that failed checksum verification or parsing. |
| `gps_reinit_count` | uint32 | count | Cumulative count of full GPS module re-initialization/recovery cycles. |
| `gsr_hz` | float | Hz | Rolling measured sample rate of the background GSR I2C worker thread (~400–500 Hz). |
| `i2c_peak_ms` | uint32 | ms | Worst single I2C transaction duration (read or PGA change) recorded this session. |
| `rf_rssi_peak_ms` | uint32 | ms | Worst single SubGHz RSSI read SPI transaction duration recorded this session. |
| `rf_retune_peak_ms` | uint32 | ms | Worst single SubGHz band-retune SPI transaction duration recorded this session. |
| `flush_peak_ms` | uint32 | ms | Worst single SD batch flush (write + sync) duration recorded this session. |
| `log_fill_bytes` | uint32 | bytes | Current SD logger batch buffer occupancy in memory. |
| `log_fill_peak_bytes` | uint32 | bytes | Peak high-water mark of SD logger batch buffer memory usage this session. |
| `log_overflow_count` | uint32 | rows | Cumulative data rows dropped due to batch buffer overflow during SD stalls. |
| `log_flush_fail_count` | uint32 | count | Cumulative count of failed SD write/sync flush attempts (batch retained for retry). |
| `pga_change_count` | uint32 | count | ADC programmable gain amplifier (PGA) auto-ranging range switches in the most recent ~1 s window (`gsr_sensor_get_pga_change_count()`). Not cumulative: a single switch shows as `1` for about ten rows, starting up to 1 s after it happened. |
| `i2c_consec_fail` | uint32 | count | Current run length of consecutive I2C read failures (0 = healthy; 50 = disconnect trip). |
| `prealloc_ms` | uint32 | ms | Duration of one-shot SD log file pre-allocation seek/extend at recording start. |
| `gsr_spread_ns` | float | nS | Standard deviation of the ADC readings inside this row's 100 ms window (the ones averaged into `gsr_raw`), converted to nS at the row's reading (`gsr_sensor_get_window_spread_ns()`). Mains hum that the average cancels still shows here: hum of RMS *h* in the readings gives a spread of about *h*. A burst of odd readings inside one window shows as one row with a much larger spread. The ADC's own noise sets the floor. |

---

## Column Definitions

| # | Column | Type | Unit | Sentinel / Notes |
|---|---|---|---|---|
| 1 | `timestamp` | float | seconds (relative) | Seconds since recording start. Resolution = 0.1 s (TICK_HZ = 10). |
| 2 | `lat` | float | decimal degrees | **Empty string** if no valid GPS fix this tick. Only satellite fixes count: the receiver's own estimates after losing the satellites (GGA quality 6 / RMC mode `E`) are left empty. |
| 3 | `lon` | float | decimal degrees | **Empty string** if no valid GPS fix. |
| 4 | `hdop` | float | dimensionless | `99.9` = no fix or no GSA sentence yet. |
| 5 | `pdop` | float | dimensionless | `99.9` = no GSA sentence received. Chip-computed across all constellations. |
| 6 | `sats` | int | count | Satellites used in the position fix, all constellations (PUBX 00 `numSvs`; not capped at 12 like GGA). `0` = none used. |
| 7 | `fix_type` | int | enum | `1` = no fix, `2` = 2D fix, `3` = 3D fix (from GSA sentence). |
| 8 | `speed_kts` | float | knots | Doppler-derived speed from RMC. More accurate than position-derived. **Empty string** if unavailable. Logged even when `course_deg` is empty. |
| 9 | `course_deg` | float | degrees (true north) | True course over ground from RMC. **Empty string** if unavailable — including when nearly still, where the receiver stops reporting course but still reports speed. |
| 10 | `gsr_raw` | float | nanosiemens (nS) | Raw skin conductance. `0.0` if sensor unavailable. |
| 11 | `hacc_m` | float | meters | Horizontal accuracy from `$PUBX,00` Field 9. **Empty string** if no valid fix. `99.9` = no `$PUBX,00`. M10Q-only. |
| 12 | `rssi_815` | float | dBm | SubGHz 815 MHz instantaneous RSSI peak for most recent dwell on band. |
| 13 | `rssi_868` | float | dBm | SubGHz 868 MHz instantaneous RSSI peak for most recent dwell on band. |
| 14 | `rssi_915` | float | dBm | SubGHz 915 MHz instantaneous RSSI peak for most recent dwell on band. |


---

## Live Stream BLE Binary Packet Format

In **Live Stream** mode (`BioMapModeLiveStream`), data is streamed in real time over Bluetooth Low Energy using Flipper's stock serial profile rather than logged to SD. Packets are 49 bytes, little-endian, sent every ~300 ms (`BT_STREAM_INTERVAL_MS`).

| Offset | Size (Bytes) | Field | Type | Unit / Description |
|---|---|---|---|---|
| 0 | 2 | `magic` | `uint8[2]` | Synchronization bytes: `0x42 0x4E` ("BN"). |
| 2 | 4 | `timestamp_ms` | `uint32` | Milliseconds since stream start. |
| 6 | 8 | `lat` | `double` | Latitude in decimal degrees (IEEE 754 float64). |
| 14 | 8 | `lon` | `double` | Longitude in decimal degrees (IEEE 754 float64). |
| 22 | 4 | `gsr_raw` | `float` | Conductance in nanosiemens (nS) (IEEE 754 float32). |
| 26 | 4 | `hdop` | `float` | Horizontal Dilution of Precision (`99.9` = unknown). |
| 30 | 4 | `pdop` | `float` | Positional Dilution of Precision (`99.9` = unknown). |
| 34 | 4 | `speed_kts` | `float` | Speed over ground in knots. |
| 38 | 4 | `course_deg` | `float` | Course over ground in degrees true. |
| 42 | 1 | `sats` | `uint8` | Satellites used in the position fix (PUBX 00 `numSvs`), as the CSV `sats` column. |
| 43 | 1 | `fix_type` | `uint8` | GPS fix type: `1` = None, `2` = 2D, `3` = 3D. |
| 44 | 1 | `valid` | `uint8` | `1` = GPS fix valid, `0` = no fix. There is no GSR validity flag: `gsr_raw` is sent as read (`0.0` when the ADC is unreachable, the open-circuit floor when the cuffs are off). |
| 45 | 4 | `hacc_m` | `float` | u-blox horizontal accuracy in metres (`99.9` = unknown), exported as the CSV `hacc_m` column. |

Parsed client-side by `visualiser/src/live/live_binary_parser.mjs` (`GSRLiveBinaryParser`). The live viewer (`visualiser/live.html`) exports recorded live sessions into canonical CSV matching the 11-column GPS+GSR format above.

---

## GPS Column Sentinel Behaviour

`lat` and `lon` are **empty strings** (not `0.0`) when no fix exists. All other GPS columns use numeric sentinels. When parsing, check `row.get('lat', '').strip()` to test for GPS presence.

---

## HDOP Gate Design

The firmware applies **no** record-time HDOP threshold — every fix the receiver reports is logged, so urban-canyon data is never permanently discarded. HDOP filtering happens only downstream, in the visualiser:

| Context | Value | Location | Purpose |
|---|---|---|---|
| JS visualiser default | `3.0` | `constants.mjs GPS_DEFAULT.maxHdop` | Post-processing quality filter, user-adjustable, non-destructive |

---

## GSR Validity Range

| Condition | Range | Interpretation |
|---|---|---|
| Normal | 1 000 – 20 000 nS | Typical resting range (1–20 µS) |
| Open circuit | < 100 nS | Electrodes not attached (`GSR_VALID_MIN_NS`) |
| Rail saturation | > 75 000 nS | Hardware fault or shorts (`GSR_VALID_MAX_NS`)|

Defined in `core/gsr_sensor.h` as `GSR_VALID_MIN_NS` and `GSR_VALID_MAX_NS`.

---

## Schema Version History

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-06 | Initial: `timestamp, lat, lon, alt, sats, fix, gsr_raw` (7 columns) |
| 1.1 | 2026-07 | Added `hdop, pdop, speed_kts, course_deg`; renamed `fix`→`fix_type`; removed `alt`; total 10 columns |
| 1.2 | 2026-07 | Added `hacc_m` (M10Q-only physical accuracy in meters, `$PUBX,00`); total 11 columns |
| 1.3 | 2026-07 | Added SubGHz RF columns (`rssi_815/868/915` & `rssi_peak_815/868/915`) for `GPS+GSR+RF` mode; total 17 columns |
| 1.4 | 2026-07 | Removed `rssi_peak_815/868/915` (decaying peak-hold) — redundant with raw RSSI for offline analysis; total 14 columns |
| 1.5 | 2026-08-05 | Debug-field review: added `gps_reinit_count` (GPS-bearing debug modes) and `pga_change_count`/`i2c_consec_fail` (all GSR-bearing debug modes) — promoted from serial-only/Diagnostics-screen-only readings that never reached the CSV. No production (non-debug) column changes. |
| 1.6 | 2026-08-05 | `BIOMAP_DEBUG_FIELDS` compile-time switch replaced with a persisted runtime Options-menu toggle (`BioMapApp::debug_fields_enabled`, Options > Debug Fields), off by default. No column-list changes — same debug columns as 1.5, just switchable per-session without a rebuild. |
| 1.7 | 2026-08-05 | Added `prealloc_ms` (all three debug variants) alongside `BIOMAP_SD_PREALLOC`. Also: corrected metadata header format to `# RecordingStartTime:` + conditional `# Band Floors` line. |
| 1.8 | 2026-08-28 | Doc sync, no column changes: documented the `# GSR Calibration: gain:…,offset:…` metadata line (emitted since custom GSR calibration shipped) and corrected the metadata-header order to match `biomap_session.c`. Post-processing enrichment columns (`osm_*`, snapped GPS) are appended by the visualiser, not the firmware writer. |
| 1.9 | 2026-08-30 | Added the **Integrity Bracket** (see section above): a `# Integrity: crc32 v1` marker as the first line of every file and a `# End rows:… bytes:… crc32:… [end_time:…] overflows:… flush_fails:…` trailer written on clean stop. No data-column changes. The visualiser verifies it on import and shows a per-track status tick. |
| 1.10 | 2026-09-16 | The calibration wizard's 3-step resistor ladder now doubles as a pre-flight noise/resolution check (per-resistor σ via a Welford accumulator over a 20 s dwell, gated against `CAL_NOISE_ACCEPTABLE_NS`); `# GSR Calibration` gained `r2:<float>,noise_ns:<float>,<float>,<float>` so a recording's fit goodness and noise floor are real reportable numbers, not just the wizard's Excellent/Acceptable/Poor label. No data-column changes. |
| 1.11 | 2026-09-26 | `# GSR Calibration` gained `cal_time:<unix_epoch_seconds>` (when the calibration was saved; `0` if the RTC was unset) for traceability. No data-column changes. |
| 1.12 | 2026-11-17 | Added `# GSR Bias: measured_mv:…,used_mv:…`: the 0.5 V bias measured at recording start and applied to `gsr_raw` for the whole file. GSR calibration file version 4 → 5 (old fits rejected). No data-column changes. |
| 1.13 | 2026-11-18 | `# GSR Calibration` now carries `zero_counts` (open-circuit zero, removed before the nS conversion) in place of `offset` (nS); the fit is gain-only. GSR calibration file version 5 → 6 (old fits rejected). No data-column changes. |
| 1.14 | 2026-11-21 | Added `gsr_spread_ns` as the last debug column in all three debug variants. No production (non-debug) column changes. |

---

## `hacc_m`: Direct Spatial Error in Meters

`hacc_m` lets downstream Kalman filters substitute unitless $\text{DOP}^2$ measurement noise scaling with exact physical measurement covariance ($R = \text{hacc\_m}^2$), improving track smoothing in urban multipath environments where HDOP/PDOP stay low but true position error spikes. See [`gps_filtering_pipeline.md`](gps_filtering_pipeline.md) §5 for the Kalman-side implementation. Since it's M10Q-only, downstream consumers must fall back to DOP²-scaling when `hacc_m` is empty or `99.9`.
