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

---

## Potential Future Schema Extension: `hacc_m` (Spatial Error in Meters)

* **Proposed Column:** `hacc_m` (float, horizontal accuracy in meters extracted from `$PUBX,00` Field 9).
* **Usage:** Allows downstream web/Python Kalman filters to substitute unitless $\text{HDOP}^2$ measurement noise scaling with exact physical measurement covariance ($R = \text{hacc\_m}^2$), improving track smoothing in urban multipath environments.
* **Compatibility Note:** The firmware parses `hacc` live for OLED display, but preserves the 10-column v1.1 schema for logging to maintain zero-overhead SD writes and full backward compatibility.
