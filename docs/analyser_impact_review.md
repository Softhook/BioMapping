# Analyser Software & Interface Impact Review (I2C vs UART)

This document addresses:
1. The hardware protocol selection (I2C vs UART) for the u-blox SAM-M10Q GPS breakout.
2. A critical impact review of the new GPS data (e.g., higher satellite counts, lower DOPs, Galileo support) on the python and javascript post-processing analyser software.

---

## 1. Protocol Selection: Why UART is Selected Over I2C

The SparkFun SAM-M10Q GPS breakout board supports **both** I2C (via the Qwiic connector) and UART interfaces. However, **UART remains the highly recommended and correct choice for this Flipper Zero implementation**.

### Technical Arguments for UART

1. **Continuous Streaming vs. Polling Overhead**:
   * **UART**: The GPS module continuously streams NMEA ascii sentences as bytes over the TX line. The Flipper Zero's STM32 handles this asynchronously via a hardware ring buffer and serial interrupt service routine (ISR) in `gps_uart.c`. The CPU is only woken up when a new byte/sentence is available.
   * **I2C**: I2C is a master-slave protocol. The Flipper Zero would have to actively poll the u-blox register space at regular intervals to check if bytes are available. This introduces timing jitter, periodic polling CPU overhead, and added clock-line noise.

2. **Firmware Complexity**:
   * Changing the interface to I2C would require rewriting the Flipper's hardware driver module entirely (dropping the asynchronous USART serial ring buffer and implementing an I2C transaction sequence).
   * Keeping UART allows us to keep **100% of the existing serial ring buffer driver and `minmea` parser library**, changing only the initialization startup strings.

3. **Pin Expose Availability**:
   * The SparkFun SAM-M10Q breakout board exposes standard breadboard-compatible Plated-Through-Hole (PTH) pins directly on the sides: `3V3`, `GND`, `TX`, `RX`, `PPS`.
   * These UART pins can be directly wired to the Flipper Zero GPIO pins exactly like the L76K.

---

## 2. Analyser Software Compatibility Review

We reviewed both the Python and JavaScript tracking and analysis scripts:
* [analyze_track.py](file:///Users/softhook/Documents/GitHub/BioMapping/analyze_track.py)
* [compare_noise.py](file:///Users/softhook/Documents/GitHub/BioMapping/compare_noise.py)
* [gsr-map-analyzer/analyzer.js](file:///Users/softhook/Documents/GitHub/BioMapping/gsr-map-analyzer/analyzer.js)
* [gsr-map-analyzer/gps_filter.js](file:///Users/softhook/Documents/GitHub/BioMapping/gsr-map-analyzer/gps_filter.js)

### Findings

### A. Satellite Counts (Sats Column)
* **What changes**: With concurrent tracking of 4 constellations (GPS, GLONASS, Galileo, BeiDou), the tracked satellite count will increase from **10–18** (on L76K) to **22–35+** (on SAM-M10Q) under open skies.
* **Analyser Impact**: **No changes required**.
  * The Python script `analyze_track.py` processes `sats` using simple `min`/`max`/`mean` functions, which will display the new counts correctly.
  * The JS analyser `analyzer.js` splits columns dynamically by looking up the `"sats"` header and maps the integer value directly. It does not enforce any artificial ceiling on satellite counts.

### B. Dilution of Precision (HDOP / VDOP / WDOP)
* **What changes**: Higher satellite availability means the average dilution of precision will drop significantly (often < 1.0, e.g., 0.5 - 0.8).
* **Analyser Impact**: **No changes required**.
  * The Kalman filter implementation in `gps_filter.js` clamps the DOP value between `0.5` and `3.0` for noise scaling:
    ```js
    const dop = !isNaN(pt.wdop) && pt.wdop > 0 && pt.wdop < 50.0 ? pt.wdop :
                (!isNaN(pt.hdop) && pt.hdop > 0 && pt.hdop < 50.0 ? pt.hdop : 1.0);
    const h = Math.max(0.5, Math.min(3.0, dop));
    ```
    This floor of `0.5` prevents division-by-zero or overly optimistic noise scaling for extremely high-quality fixes. It is perfectly optimized for the M10's performance.

### C. GPX Converter Dynamic Headers
* **What changes**: The GPX converter runs inside Flipper Zero to write GPX files from the CSV log, encoding GSR rates in the `<ele>` tags.
* **Analyser Impact**: **No changes required**.
  * The Flipper C code in `gpx_converter.c` reads the CSV file header on launch and locates column indices dynamically:
    `parse_csv_header(line, &lat_idx, &lon_idx, &fix_idx, &raw_idx);`
  * Even if we add new columns or reorder them, the GPX converter will locate the `lat`, `lon`, `fix`, and `gsr_raw` columns automatically.

### D. WDOP Kalman Scaling
* **What changes**: The JS filter scales its measurement noise using `wdop` (Weighted DOP calculated from GSV elevation angles) as its primary input.
* **Analyser Impact**: **Crucial fix implemented in firmware**.
  * By adding proper Galileo mapping (`GA` talker and `SystemID == 3`) to the Flipper's WDOP calculator, the `wdop` values logged to the CSV file will remain mathematically valid and reflect the true sky geometry, ensuring the Kalman filter scales its noise appropriately. No changes are required on the JS side.
