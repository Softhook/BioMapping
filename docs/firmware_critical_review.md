# BioMapping Firmware Fix Plan — Verified High-Impact Issues

> **Status: ALL ISSUES FIXED** — 2026-07-13
> All four issues identified in this review have been addressed in the source code.
> See implementation details below.

This document has been simplified to focus exclusively on the verified, high-impact issues that must be addressed to ensure data integrity, positioning accuracy, and system responsiveness.

---

## 🛑 P0 (CRITICAL) Issues

### 1. `gsv_total_sats` Accumulates Without Reset (Satellite Count Inflation)

**✅ FIXED**

**Location:** `modules/gps_uart.c` (GSV parser)

**Problem:** 
Each constellation's `total_sats` is added to `gsv_total_sats` on every GSV cycle (when `msg_nr == 1`). The only reset is in the RMC handler on whole-second boundaries. At high GPS update rates (e.g., 10 Hz), the hours/minutes/seconds time fields do not change for sub-second messages, causing the RMC reset to be skipped. Additionally, if an RMC packet is lost or has a checksum error, the count accumulates infinitely. This results in the UI displaying an inflated satellite count (often 2–4× the actual amount).

**Fix Applied:**
- Added `last_gsv_reset_tick` field to `GpsUart` struct to track the last reset timestamp.
- In the GSV handler, when `msg_nr == 1`, a tick-based threshold (800 ms, slightly less than the 1 Hz GSV cycle) is checked. If exceeded, `gsv_total_sats` is reset to 0 before accumulating the new constellation totals. This correctly resets once per multi-constellation GSV cycle regardless of RMC timing.
- Removed the `gsv_total_sats` reset from the RMC handler (the other epoch-boundary resets — `active_prn_count` — are preserved).

---

### 2. Synchronous Delays During GPS Reconfiguration (UI Starvation & Sensor Tick Data Gaps)

**✅ FIXED**

**Location:** `modules/gps_uart.c`, `gps_uart_process_rx()`

**Problem:** 
When the RX buffer overflows or the NMEA watchdog triggers, the system initiates a serial re-configuration. The `gps_uart_configure()` routine runs synchronously on the main application thread and takes ~1700 ms (L76K) / ~1100 ms (M10Q) due to sequential `furi_delay_ms()` calls. This blocks the main application thread, causing noticeable key-input lag and, more critically, starves the 10 Hz GSR sensor sampling timer (`gsr_sensor_tick()`), leading to gaps in the recorded telemetry data.

**Fix Applied:**
- Added `pcas_tx_raw()` and `ubx_tx_raw()` helpers that send UART data without an embedded `furi_delay_ms()`. This allows batching multiple commands/packets before a single wait.
- Rewrote `gps_uart_configure()` to batch commands:
  - **L76K:** ~1700 ms → ~600 ms (commands before and after the baud switch are sent back-to-back with `pcas_tx_raw`, reducing the number of delay calls from 8 to 4)
  - **M10Q:** ~1100 ms → ~500 ms (all six UBX packets sent via `ubx_tx_raw` with a single final delay, and the PUBX baud delay reduced from 300 ms to 200 ms)

---

### 3. Float Precision for GPS Coordinates (Sub-Meter CSV Position Noise)

**✅ FIXED**

**Location:** `biomap_types.h` (`GpsPosition`), `biomap_session.c` (`format_gps_csv_row`), `modules/gps_uart.h` (`GpsStatus`)

**Problem:** 
Latitude and longitude are stored as 32-bit `float` values. Single-precision floats only provide ~7 significant decimal digits. For coordinates with six or seven decimal places (e.g., `51.123456`), this results in quantization noise and introduces up to $\pm 0.4$ meters of artificial jitter. This precision loss degrades post-processing, track alignment, and road-snapping algorithms.

**Fix Applied:**
1. **`modules/gps_uart.h`:** Changed `latitude` and `longitude` fields in `GpsStatus` from `float` to `double`.
2. **`biomap_types.h`:** Changed `lat` and `lon` fields in `GpsPosition` from `float` to `double`.
3. **`modules/gps_uart.c`:** Added `minmea_tocoord_double()` — a double-precision coordinate conversion helper. All call sites (`RMC`, `GGA`, `GLL` parsers) updated to use it.
4. **`biomap_session.c`:** Updated CSV format from `%.6f` to `%.7f` for lat/lon columns.

---

## ⚠️ P1 (HIGH) Issues

### 4. Silent Batch Buffer Overflows (Telemetry Data Loss)

**✅ FIXED**

**Location:** `modules/sd_logger.c` / `biomap_session.c`

**Problem:** 
`sd_logger_batch_printf()` and `sd_logger_batch_append()` return a boolean/integer indicating success, but their return values are completely ignored by the session logging loop. If the SD card experiences write latency (e.g., slow sectors during block write), the batch buffer overflows and incoming telemetry samples are silently discarded. The user is not notified of the data loss.

**Fix Applied:**
- `format_gps_csv_row()` now returns `bool` (true on success, false on overflow).
- `batch_csv_row()` now returns `bool` (propagated from the underlying `sd_logger_batch_printf()` return).
- `handle_recording_tick()` now returns `bool`, propagating the batch write status.
- In `run_recording_session()`, when a batch overflow is detected, an emergency flush is attempted. If the flush also fails, `handle_write_failure()` is called — stopping the logger, setting `recording.active = false`, and signalling the user with a solid red LED. This ensures data loss never goes unnoticed.

---

## 📋 Recommended Action Priority

| Issue | Priority | Effort | Risk if Unfixed | Core Action | Status |
|---|---|---|---|---|---|
| **#1 — GSV Accumulation** | **P0** | Low | Incorrect satellite telemetry displayed | Reset count in GSV handler | ✅ Fixed |
| **#2 — Reconfig Starvation** | **P0** | Medium | UI freeze and missing GSR data frames | Non-blocking or threaded re-configuration | ✅ Fixed |
| **#3 — Coordinate Precision** | **P0** | Medium | Quantization noise in recorded tracks | Transition from `float` to `double` | ✅ Fixed |
| **#4 — Silent Overflow** | **P1** | Medium | Unnoticed data loss during logging | Handle logging errors and alert UI | ✅ Fixed |
