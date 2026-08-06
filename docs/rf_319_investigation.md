# Technical Investigation: Adding 319 MHz as a Fourth Frequency Band

This document details the feasibility, system impact, and concrete code changes required to add a fourth sub-GHz frequency band (**319 MHz**) to the BioMapping logging and visualization pipeline.

---

## 1. Executive Summary

Adding **319 MHz** (a frequency widely used in North American wireless security sensors and garage door openers) is highly feasible. 

The implementation spans:
1. **Flipper Zero C Firmware:** Sweeping, calibrating, logging, and displaying the new band on the LCD.
2. **Host-Side C Tests:** Updating mock arrays and diagnostic verification suites.
3. **GSR Web Analyzer:** Parsing the new CSV column, adding it to the EM Fog Index, and providing Leaflet Map overlays.

### Hardware & RF Constraints
* **Antenna Performance:** The Flipper Zero's internal CC1101 antenna matching network is optimized for 433, 868, and 915 MHz. As noted in the codebase, lower frequencies (300–446 MHz) suffer from impedance mismatch and show a higher self-noise floor (~-76 dBm) compared to high-frequency bands (~-91.5 dBm).
* **Calibration Squelch Ceiling:** When validating Faraday box calibrations for 319 MHz, the ceiling (`em_scan_cal_max_floor_dbm`) must be relaxed to **-70.0 dBm** or **-72.0 dBm** (instead of the -90.0 dBm ceiling used for 815/868/915 MHz) so calibrations can pass on typical hardware.
* **Sweep Timing:** Each band retune, AGC stabilization, and dwell window takes time (~6–8 ms for retune/warmup, ~22 ms for max-hold dwell). Bumping the frequency count from 3 to 4 increases the full round-robin sweep cycle duration from ~300 ms to **~400 ms** (4 ticks at 10 Hz), which remains negligible at walking speeds.

---

## 2. Codebase Impact & Implementation Plan

Below is the structured list of files that would need modifications:

### A. Flipper Zero Firmware (C)

#### [MODIFY] [`modules/em_scan_rf.h`](file:///Users/softhook/Documents/GitHub/BioMapping/modules/em_scan_rf.h)
* Bump `EM_SCAN_NUM_FREQS` from `3` to `4`.
* Update documentation regarding the added band.

```diff
-#define EM_SCAN_NUM_FREQS 3
+#define EM_SCAN_NUM_FREQS 4
```

#### [MODIFY] [`modules/em_scan_rf.c`](file:///Users/softhook/Documents/GitHub/BioMapping/modules/em_scan_rf.c)
* Add `319000000` to the `em_scan_freq_hz` array.
* Add `"319"` to the `em_scan_freq_label` array.

```diff
 const uint32_t em_scan_freq_hz[EM_SCAN_NUM_FREQS] = {
-    815000000, 868350000, 915000000,
+    319000000, 815000000, 868350000, 915000000,
 };
 const char* const em_scan_freq_label[EM_SCAN_NUM_FREQS] = {
-    "815", "868", "915",
+    "319", "815", "868", "915",
 };
```

#### [MODIFY] [`modules/em_scan_cal.h`](file:///Users/softhook/Documents/GitHub/BioMapping/modules/em_scan_cal.h)
* Bump `EM_SCAN_CAL_VERSION` from `3` to `4` (since the on-disk calibration struct size changes).

```diff
-#define EM_SCAN_CAL_VERSION        3           // Bumped: reduced to 3 high bands (815, 868, 915 MHz), EM_SCAN_NUM_FREQS 6->3
+#define EM_SCAN_CAL_VERSION        4           // Bumped: added 319 MHz, EM_SCAN_NUM_FREQS 3->4
```

#### [MODIFY] [`modules/em_scan_cal.c`](file:///Users/softhook/Documents/GitHub/BioMapping/modules/em_scan_cal.c)
* Add a relaxed noise floor ceiling for 319 MHz (`-70.0f` dBm) to allow calibration to succeed despite antenna impedance mismatch.

```diff
 const float em_scan_cal_max_floor_dbm[EM_SCAN_NUM_FREQS] = {
-    -90.0f, -90.0f, -90.0f, // 815/868/915 MHz
+    -70.0f, -90.0f, -90.0f, -90.0f, // 319 MHz ceiling is relaxed; 815/868/915 MHz are -90.0 dBm
 };
```

#### [MODIFY] [`biomap_config.h`](file:///Users/softhook/Documents/GitHub/BioMapping/biomap_config.h)
* Update CSV schemas to declare the `rssi_319` column in the headers.

```diff
 #define BIOMAP_CSV_COLS_GPS_GSR_RF_PROD \
     "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
-    "rssi_815,rssi_868,rssi_915\n"
+    "rssi_319,rssi_815,rssi_868,rssi_915\n"
 #define BIOMAP_CSV_COLS_GPS_GSR_RF_DEBUG \
     "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m," \
-    "rssi_815,rssi_868,rssi_915," \
+    "rssi_319,rssi_815,rssi_868,rssi_915," \
     "tick_dt_ms,gps_rx_drops,nmea_fail,gps_reinit_count,gsr_hz," \
```

#### [MODIFY] [`biomap_session.c`](file:///Users/softhook/Documents/GitHub/BioMapping/biomap_session.c)
* Adjust `format_gps_csv_row` to format and append four RSSI values.

```diff
     // Optional RF columns (raw per-band RSSI).
     int n2 = rf_rssi
-        ? snprintf(row + n, sizeof(row) - (size_t)n, ",%.1f,%.1f,%.1f",
-                   (double)rf_rssi[0], (double)rf_rssi[1], (double)rf_rssi[2])
+        ? snprintf(row + n, sizeof(row) - (size_t)n, ",%.1f,%.1f,%.1f,%.1f",
+                   (double)rf_rssi[0], (double)rf_rssi[1], (double)rf_rssi[2], (double)rf_rssi[3])
         : 0;
```

#### [MODIFY] [`biomap_render.c`](file:///Users/softhook/Documents/GitHub/BioMapping/biomap_render.c)
* **Left RF panel height adjustment (`draw_rf_panel_left`):**
  The vertical screen height available for the RF panel is 48 pixels (y=16 to y=64). With 3 bands, rows were 15px high with a 1px gap. To fit 4 bands, we must scale rows to **11px high** with a **1px gap** (`11 * 4 + 4 = 48`):

```diff
 static void draw_rf_panel_left(Canvas* c, BioMapApp* a, const float rssi_dbm[EM_SCAN_NUM_FREQS]) {
-    const int row_h = 15;
+    const int row_h = 11;
     const int row_gap = 1;
     const int panel_x = 1;
-    const int bar_h = 6;
+    const int bar_h = 3; // Slimmer bar height to prevent overlap with the text
```

* **Calibration Stats / Info Rendering (`rf_show_current_calibration_render`):**
  Currently, calibration info lists bands stacked vertically. Listing 4 bands vertically would exceed the 64px screen height. We must change the layout to print them side-by-side:

```diff
     } else {
         int y = 24;
-        y = draw_fmt(c, 0, y, "Band Floors (dBm):");
-        for(int i = 0; i < EM_SCAN_NUM_FREQS; i++) {
-            y = draw_fmt(c, 0, y, "%s: %.1f  (std %.2f)",
-                         em_scan_freq_label[i],
-                         (double)cal.noise_floor_dbm[i],
-                         (double)cal.noise_std_dev_db[i]);
-        }
+        y = draw_fmt(c, 0, y, "Floors: 319:%.0f  815:%.0f", 
+                     (double)cal.noise_floor_dbm[0], (double)cal.noise_floor_dbm[1]);
+        y = draw_fmt(c, 0, y, "        868:%.0f  915:%.0f", 
+                     (double)cal.noise_floor_dbm[2], (double)cal.noise_floor_dbm[3]);
     }
```

* **Active Sampling Screen (`rf_calibration_wizard_sampling_render`):**
  Draw the status of all 4 bands in a single line.

```diff
-    draw_fmt(c, 0, 37, "%s:%.0f %s:%.0f %s:%.0f",
-             em_scan_freq_label[0], (double)rssi_dbm[0],
-             em_scan_freq_label[1], (double)rssi_dbm[1],
-             em_scan_freq_label[2], (double)rssi_dbm[2]);
+    draw_fmt(c, 0, 37, "%s:%.0f %s:%.0f %s:%.0f %s:%.0f",
+             em_scan_freq_label[0], (double)rssi_dbm[0],
+             em_scan_freq_label[1], (double)rssi_dbm[1],
+             em_scan_freq_label[2], (double)rssi_dbm[2],
+             em_scan_freq_label[3], (double)rssi_dbm[3]);
```

---

### B. Unit & Integration Tests (C)

#### [MODIFY] [`tests/test_firmware.c`](file:///Users/softhook/Documents/GitHub/BioMapping/tests/test_firmware.c)
* Expand the test's static mock array size to `4` elements to mirror the new band count.

```diff
-    float rf_rssi[3] = {-91.5f, -88.0f, -90.5f};
+    float rf_rssi[4] = {-76.0f, -91.5f, -88.0f, -90.5f};
```

---

### C. Web Analyzer & Visualization (JS / HTML)

#### [MODIFY] [`gsr-map-analyzer/analyzer.js`](file:///Users/softhook/Documents/GitHub/BioMapping/gsr-map-analyzer/analyzer.js)
* Detect `rssi_319` from the CSV headers and parse it.
* Register `rssi_319` in the `BANDS` arrays for peak-prominence detection.
* Dynamically include `rssi_319` in `GSRAnalyzer.calcEmFog()`.

```javascript
// Inside _detectRfPeakIndices() and calcEmFog():
const BANDS = ['rssi_300', 'rssi_315', 'rssi_319', 'rssi_434', 'rssi_446', 'rssi_815', 'rssi_868', 'rssi_915'];
```

#### [MODIFY] [`gsr-map-analyzer/rf_fluid_renderer.js`](file:///Users/softhook/Documents/GitHub/BioMapping/gsr-map-analyzer/rf_fluid_renderer.js)
* Parse `rssi_319` from the nodes, compute its adaptive noise floors, and scale it within `_normDbm()`.
* Map 319 MHz to a distinct visualization color when rendering individual layers. For example, use **Vibrant Amber/Yellow (255, 200, 0)**:

```javascript
// Inside _calculateRssiStats():
let min319 = Infinity, max319 = -Infinity;
// Loop nodes and assign min/max for 319
// Add to this.rssiStats:
319: calcBandStats(min319, max319)

// Inside redraw() / render nodes:
} else if (mode === '319') {
  const n = node.has319 ? this._normDbm(node.r319, 319) : 0;
  rVal = 255; gVal = 200; bVal = 0; // Vibrant Yellow/Gold
  alpha = Math.min(1.0, n * 0.95);
}
```

#### [MODIFY] [`gsr-map-analyzer/index.html`](file:///Users/softhook/Documents/GitHub/BioMapping/gsr-map-analyzer/index.html)
* Add a select option to switch the fluid visualization mode to the 319 MHz channel:

```html
<select id="rfFluidMode" ...>
  <option value="triband" selected>Tri-Band RGB</option>
  <option value="319">319 MHz (Security)</option>
  <option value="815">815 MHz (LTE)</option>
  ...
</select>
```

#### [MODIFY] [`gsr-map-analyzer/map.js`](file:///Users/softhook/Documents/GitHub/BioMapping/gsr-map-analyzer/map.js)
* Update `updateLegend()` to draw the legend item for the 319 MHz channel when active.
