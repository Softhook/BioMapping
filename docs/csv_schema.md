# BioMapping CSV Schema

> **Canonical reference.** Update this file whenever the column list changes.
> Referenced from: `biomap_session.c`, `sd_logger.h`, `analyzer.js`, `analyze_track.py`.

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
# BioMapping v1.0
# RecordingStartTime:<unix_epoch_seconds>
# GPS:L76K  (or GPS:M10Q)
```

`RecordingStartTime` is `0` if the Flipper RTC has never been set.

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

Two HDOP thresholds exist — **this is intentional:**

| Context | Value | Location | Purpose |
|---|---|---|---|
| Firmware logging gate | `5.0` | `biomap_types.h GPS_HDOP_GATE` | Permissive: log urban canyon data for post-analysis |
| JS analyser default | `2.0` | `constants.js GPS_DEFAULT.maxHdop` | Post-processing quality filter (user-adjustable) |

**Rationale:** Logging at 5.0 preserves data that the analyser can optionally reject. Logging at 2.0 would permanently discard urban canyon fixes.

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

---

## `hacc_m`: Direct Spatial Error in Meters

`hacc_m` lets downstream Kalman filters substitute unitless $\text{DOP}^2$ measurement noise scaling with exact physical measurement covariance ($R = \text{hacc\_m}^2$), improving track smoothing in urban multipath environments where HDOP/PDOP stay low but true position error spikes. See [`gps_filtering_pipeline.md`](gps_filtering_pipeline.md) §6 for the Kalman-side implementation. Since it's M10Q-only, downstream consumers must fall back to DOP²-scaling when `hacc_m` is empty or `99.9`.
