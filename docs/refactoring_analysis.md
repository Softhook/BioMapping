# BioMapping — Codebase Refactoring Analysis

> **Last updated:** 2026-07-14 (v3 — changes applied)
> **Scope:** Full codebase — firmware (C), modules, Python tooling, JS web analyzer
> **Status:** Living document — ✅ = applied, ⏳ = deferred, 📋 = backlog

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Firmware (C) — Opportunities](#2-firmware-c--opportunities)
3. [JS Web Analyzer — Opportunities](#3-js-web-analyzer--opportunities)
4. [Python Tooling — Opportunities](#4-python-tooling--opportunities)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Priority Matrix](#6-priority-matrix)
7. [Removed Items & Rationale](#7-removed-items--rationale)
8. [Changelog](#8-changelog)

---

## 1. Architecture Overview

```
BioMapping/
├── biomap.c               ← App entry, lifecycle, hot-start
├── biomap.h               ← Central "fat" header pulling in entire SDK
├── biomap_types.h         ← Lightweight sub-structs & constants
├── biomap_config.h        ← GPS module compile-time selection + BioMapMode
├── biomap_events.h        ← Shared event union (PluginEvent)
├── biomap_session.c       ← 659-line recording session event loop
├── biomap_render.c        ← 333-line canvas rendering
├── biomap_gui.c           ← 187-line GUI callbacks & menu/options screens
├── modules/
│   ├── gps_uart.c         ← 767-line NMEA parser + serial management
│   ├── gps_uart.h
│   ├── gsr_sensor.c       ← 405-line ADS1115 reader + PGA autoranging
│   ├── gsr_sensor.h
│   ├── sd_logger.c        ← 195-line batched CSV writer
│   ├── sd_logger.h
│   └── util.h             ← Inline filename-index parser
├── minmea.c / minmea.h    ← Third-party NMEA library (vendor)
├── analyze_track.py       ← CLI GPS/GSR quality analysis
├── compare_noise.py       ← GSR noise comparison
└── gsr-map-analyzer/      ← Browser-based analyser (22 files, ~370 KB JS)
    ├── index.html         ← 1,350+ line monolith with inline CSS
    ├── constants.js       ← Shared magic numbers
    ├── app_state.js       ← Central mutable state
    ├── storage.js         ← LocalStorage + slider reads
    ├── analyzer.js        ← 1,217-line GSRAnalyzer class
    ├── ui.js              ← 1,370-line GSRUI god object
    ├── events.js          ← 927-line event bindings
    ├── map.js             ← 1,136-line GSRMapManager
    ├── gps_filter.js      ← 502-line GPS filter pipeline
    └── ...
```

**Overall health:**
- **Firmware (C):** Well-structured with good header separation and a clear data pipeline. One real UB bug (§2.5). Minor DRY opportunities.
- **JS Analyzer:** Architecture has improved significantly with `AppState`/`GSRStorage`/`GpsFilter` extraction, but `ui.js` is the remaining structural debt.
- **Python:** Functional but brittle at the edges.

---

## 2. Firmware (C) — Opportunities

### ✅ 2.1 Duplicate Serial Reinit Pattern — APPLIED

**File:** `modules/gps_uart.c` (lines 550–557 and 603–614)

**Problem:** The six-step sequence to restart the UART (stop async RX → deinit → reinit → reset stream buffer → restart async RX → delay → configure) appears **verbatim in two places**: the RX-buffer-full handler and the NMEA watchdog. The two copies must be kept in sync; any future addition (e.g. a flow-control step) has to be applied twice.

**Fix:** Extract into a single static helper:
```c
static void gps_uart_reinit(GpsUart* g, uint32_t baud) {
    furi_hal_serial_async_rx_stop(g->serial_handle);
    furi_hal_serial_deinit(g->serial_handle);
    furi_hal_serial_init(g->serial_handle, baud);
    g->rx_offset = 0;
    furi_stream_buffer_reset(g->rx_stream);
    furi_hal_serial_async_rx_start(g->serial_handle, gps_uart_irq_cb, g, false);
    furi_delay_ms(100);
    gps_uart_configure(g);
    g->last_valid_nmea_tick = 0;
}
```

---

### ✅ 2.2 Static Log-Once Variables Survive Session Resets — APPLIED

**File:** `modules/gps_uart.c` (lines 201–205, 286–291)

**Problem:** `static bool gsa_talker_logged = false;` and `static bool gsv_talker_logged = false;` are function-local statics inside `gps_uart_parse_line()`. Function-local statics in C survive the lifetime of the process — which on Flipper means they survive `gps_uart_free()` / `gps_uart_alloc()` cycles when the user returns to the menu and starts a new session. On a second session these diagnostic log lines fire silently with no output, making it much harder to debug issues that only appear after the first session.

**Fix:** Move them into `struct GpsUart` so they reset with the object:
```c
struct GpsUart {
    // ...existing fields...
    bool gsa_talker_logged;
    bool gsv_talker_logged;
};
```
Initialise both to `false` in `gps_uart_alloc()`.

---

### ✅ 2.3 Shared Physiological Validity Constants — APPLIED

**Files:** `biomap_session.c` (line 541), `modules/gsr_sensor.c` (lines 395–401)

**Problem:** The physiological validity gate `(raw >= 0.1f && raw <= 50000.0f)` is hardcoded in **two separate files** with different roles:
- `gsr_sensor.c`: 20-tick debounce for the "connected" flag
- `biomap_session.c`: instantaneous per-tick rejection to protect the display pipeline

If the physiological range is ever tuned (e.g. extending to 100 000 nS for high-conductance subjects) it must be updated in both places, with no compiler warning if one is missed. The JS analyzer also encodes these limits implicitly.

**Fix:** Define once in `gsr_sensor.h`:
```c
// Physiological skin conductance range (nanosiemens).
// Below GSR_VALID_MIN_NS: open circuit — finger cuffs disconnected.
// Above GSR_VALID_MAX_NS: rail saturation — hardware fault or shorts.
#define GSR_VALID_MIN_NS   0.1f
#define GSR_VALID_MAX_NS   50000.0f
```
Use both macros in `gsr_sensor.c` and `biomap_session.c`.

---

### ✅ 2.4 sd_logger.h Column Comment Is Stale — APPLIED

**File:** `modules/sd_logger.h` (line 5)

**Problem:** The header docstring says:
> `Columns: timestamp,lat,lon,alt,sats,fix,gsr_raw`

The actual CSV written by `biomap_session.c` is:
> `timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw`

The comment is wrong by **3 column names, 3 missing columns, and the wrong count** (7 vs 10). This is a maintenance hazard — anyone using the comment to write a parser will get it wrong.

**Fix:** Update the docstring to match reality. See §5.2 for the longer-term schema documentation plan.

---

### ✅ 2.5 rtc_to_unix_epoch — Out-of-Bounds Read on Unset RTC — APPLIED

**File:** `biomap_session.c` (lines 89–107)

> [!CAUTION]
> This is the only confirmed **undefined behaviour** in the firmware. It should be fixed before shipping to devices where the Flipper RTC may not have been set.

**Problem:** `rtc_to_unix_epoch()` indexes `days_before[dt->month - 1]`. The `DateTime` struct is obtained from `furi_hal_rtc_get_datetime()`. If the RTC has never been configured, `dt->month` can be `0`, making `dt->month - 1 = 255` (unsigned wrap), which is an **out-of-bounds read** on the 12-element `days_before` array.

The function then writes the garbage result into the CSV header as `# RecordingStartTime:<large garbage number>`. On Cortex-M4 this is unlikely to crash (the static array is in `.rodata` and adjacent memory is valid), but it produces a corrupted timestamp in the recording.

**Fix:**
```c
static uint32_t rtc_to_unix_epoch(const DateTime* dt) {
    // Guard against uninitialised RTC (month=0 causes days_before[-1] OOB read)
    if(dt->year < 2020 || dt->month < 1 || dt->month > 12 ||
       dt->day < 1    || dt->day   > 31) {
        FURI_LOG_W("BioMap", "RTC not set — epoch will be 0 in CSV header");
        return 0;
    }
    // ... rest of function unchanged
}
```

---

### 2.6 GPS Badge PDOP Formatting Duplicated

**File:** `biomap_render.c` (lines 131–136 in `render_gps_detail()` and lines 230–235 in `biomap_render_callback()`)

**Problem:** The logic _"if PDOP is below 99.0 format as `"%.1f"`, otherwise write `"--"`"_ appears in **both** rendering functions. This is 6 lines duplicated. If the sentinel threshold ever changes from 99.0 (e.g. to match `GPS_HDOP_GATE`) it must be updated in two places.

**Fix:**
```c
// Static helper — call from both render sites.
static void format_pdop_str(char* out, size_t outlen, float pdop) {
    if(pdop < 99.0f) snprintf(out, outlen, "%.1f", (double)pdop);
    else              strcpy(out, "--");
}
```

---

### 2.7 Unit Tests Are Absent for the Core Pipeline

**Files:** `biomap_session.c`, `gsr_sensor.c`

**Problem:** The following functions are deliberately pure and testable (plain structs, no Flipper SDK calls):
- `smooth_iir_filter()`
- `update_display_pipeline()`
- `update_graph_pipeline()`
- `rescale_graph_buf()`
- `gsr_sensor_tick()` (with a mock I2C buffer)

None have any tests. The auto-zoom and graph-rescale logic in particular are non-trivial; the zoom lerp, peak decay, and manual-timeout re-engagement interact in subtle ways that are difficult to verify by observation on the device.

**Recommendation:** Add a `tests/` directory with a host-native CMake target. This is the pre-condition for safely refactoring `update_graph_pipeline()` or the GSR pipeline in the future.

---

## 3. JS Web Analyzer — Opportunities

### 3.1 ⏳ ui.js Is a God Object — DEFERRED

> **Why deferred:** After reading all 1,370 lines, the internal coupling is tighter than the initial analysis suggested. `updateEnvironmentalDashboard` (lines 820–1029) contains 200 lines of statistics computation that calls `calculatePearsonCorrelation`, `drawRegressionScatterPlot`, and `renderRoadProfile` — all of which call each other. Splitting these into separate files without a shared statistics object would require designing a new interface. The decomposition is correct but needs careful interface design first to avoid regressions.
>
> **Pre-condition for resuming:** Define a `GSRStats` result object that the new `stats_display.js` can own, then extract the maths helpers (`calculatePearsonCorrelation`, `_tTestPValue`, `_regIncompleteBeta`, `calculateLinearRegression`) into a standalone `stats_math.js` module first.

**Problem:** `GSRUI` handles at least eight distinct responsibilities in a single object: triggering the analysis pipeline, orchestrating map re-renders, populating the peaks table, updating stats panels, exporting CSV/JSON/GeoJSON, rendering the environmental dashboard, coordinating collective mode, and managing fullscreen. Any change to export logic requires navigating 1,370 lines, and a bug in peak-table population sits next to fullscreen toggle code.

**Recommended decomposition:**

| New File | Extracted Responsibilities | Approximate Size |
|---|---|---|
| `analysis_pipeline.js` | `runAnalysis`, `rerunAnalysis`, pipeline coordination | ~150 lines |
| `stats_display.js` | `updateStats`, `updatePeaksTable`, environmental dashboard | ~300 lines |
| `export.js` | `exportCSV`, `exportJSON`, `exportGeoJSON` | ~200 lines |
| `fullscreen.js` | `toggleMapFullscreen`, `toggleBrowserFullscreen` | ~80 lines |
| `collective_ui.js` | `updateCollectiveMap`, collective aggregation | ~200 lines |

`GSRUI` then becomes a thin coordinator (~200 lines) delegating to the above. The decomposition is incremental — each module can be extracted in a single focused PR.

---

### ✅ 3.2 Slider Null-Guard Copy-Paste in storage.js — APPLIED

**File:** `gsr-map-analyzer/storage.js` (lines 26–34)

**Problem:** Every optional slider field in `readGsrSliderValues()` uses this pattern:
```js
dwtLevel: parseInt(S.dwtLevel ? S.dwtLevel.value : 6),
minPeakQuality: parseFloat(S.minPeakQuality ? S.minPeakQuality.value : 0.0),
```
This appears **9 times**, each hardcoding a default value inline. The defaults should match `GSR_CONST.GSR_DEFAULT`, but there is no enforcement — if a default changes in `constants.js` but not in `storage.js`, the slider will initialise correctly but `readGsrSliderValues()` will silently return the old default when the element is absent.

**Fix:** A one-line helper that pulls defaults from `GSR_CONST`:
```js
// In storage.js, before readGsrSliderValues():
const sliderVal = (el, key, parser = parseFloat) =>
  el ? parser(el.value) : parser(GSR_CONST.GSR_DEFAULT[key]);

// Usage becomes:
dwtLevel:      sliderVal(S.dwtLevel,      'dwtLevel', parseInt),
minPeakQuality: sliderVal(S.minPeakQuality, 'minPeakQuality'),
```

---

### ✅ 3.3 All JS Lives in the Global Scope — Documented (comment cross-references added)

> **Note:** Full namespace isolation (IIFE or ES Modules) remains on the backlog. The immediate risk (the 5 existing globals colliding with external libraries) is low since the app has no external JS dependencies beyond Leaflet and p5.js, both of which are well-namespaced.

**Files:** All `gsr-map-analyzer/*.js`

**Problem:** All 20 JS files are loaded as plain `<script>` tags. Every module (`GSRUI`, `GSRStorage`, `GpsFilter`, `AppState`, `GSRAnalyzer`, etc.) lives on `window`. Load order is enforced only by the order of tags in `index.html` — reordering any two tags can silently break the app. Any future third-party library (a new Leaflet plugin, a mapping library) that defines `AppState` or `GpsFilter` would silently overwrite the app's state.

**Short-term mitigation (low effort, no build system required):**
```js
// Wrap all app code in a single IIFE namespace in a new entry-point script
const BioMapping = (() => {
  // all modules already defined in their own files...
  return { GSRUI, GSRStorage, AppState, GpsFilter };
})();
```

**Long-term fix:** Migrate to ES Modules (`type="module"` `<script>` tags). This enforces explicit imports, eliminates load-order fragility, and opens the door to tree-shaking. Start with `constants.js` → `app_state.js` → `storage.js` progressively.

---

### ✅ 3.4 AppState Has No Validation on Critical Fields — Documented (backlog)

**File:** `gsr-map-analyzer/app_state.js`

**Problem:** `AppState` is a flat mutable object. Any of the 20 JS files can write `AppState.zoomFactor = -Infinity` or `AppState.analyzer = "oops"` without any error. State corruption bugs are silent until something breaks far downstream (usually a canvas draw crash). Currently there is no way to add a `console.trace()` to catch who overwrites a field.

**Improvement:** Add setter methods with range validation for the fields most likely to be corrupted (zoom, view times):
```js
setZoomFactor(z) {
  const clamped = Math.max(GSR_CONST.ZOOM_MIN, Math.min(GSR_CONST.ZOOM_MAX, z));
  this.zoomFactor = clamped;
},
setViewStart(t) {
  this.viewStartTime = Math.max(0, Math.min(t, this.totalDuration));
},
```
Existing read access (`AppState.zoomFactor`) continues to work unchanged.

---

### 3.5 Layout Constants Duplicated Between CSS and JS — 📋 BACKLOG

**Files:** `gsr-map-analyzer/constants.js` (lines 12–18), `gsr-map-analyzer/styles.css`, `gsr-map-analyzer/renderer.js`

**Problem:** `GSR_CONST.MARGIN`, `GSR_CONST.TIMELINE_HEIGHT`, and `GSR_CONST.TIMELINE_GAP` are defined in JS for canvas drawing. The same dimensions must be replicated in `styles.css` for the HTML layout and in the p5 renderer. A mismatch (e.g. changing `TIMELINE_HEIGHT` in `constants.js` but not in `styles.css`) causes the canvas drawing area to misalign with the CSS-laid-out panels — a subtle visual bug.

**Recommended fix:** Set CSS custom properties from JS at app startup, making JS the single source of truth:
```js
// In sketch.js setup() or equivalent:
const root = document.documentElement.style;
root.setProperty('--timeline-height', GSR_CONST.TIMELINE_HEIGHT + 'px');
root.setProperty('--margin-top',      GSR_CONST.MARGIN.top + 'px');
```
CSS then uses `var(--timeline-height)` instead of hardcoded pixels.

---

### 3.6 Test File in Production Source Directory — 📋 BACKLOG

**File:** `gsr-map-analyzer/test_dwt_clamp.js` — 7,641 bytes

**Problem:** A developer test script sits in the same directory as all production code. It is not referenced by `index.html` (so it doesn't execute in the browser), but it will be included in any bundler run, any "deploy the folder" operation, and any size audit.

**Fix:** Move to `gsr-map-analyzer/tests/` and add to `.gitignore` if it is a scratch file, or keep tracked if it documents algorithm validation.

---

## 4. Python Tooling — Opportunities

### ✅ 4.1 Bare `except` Clauses — APPLIED

**File:** `analyze_track.py` (lines 120–121, 172–173)

**Problem:**
```python
try:
    v = float(r.get('gsr_raw', '0') or '0')
    if v > 0: vals.append(v)
except:
    pass
```
Bare `except` catches **everything** — including `KeyboardInterrupt`, `SystemExit`, and `MemoryError`. This means:
- Pressing Ctrl-C during a slow analysis may not stop the script
- A genuine `KeyError` from a renamed column is swallowed silently
- Out-of-memory failures look like "no data"

**Fix:** Be explicit:
```python
except (ValueError, TypeError):
    pass
```

---

### 4.2 Redundant GSR Statistics in Two Scripts — 📋 BACKLOG

**Files:** `analyze_track.py`, `compare_noise.py`

**Problem:** Both scripts independently implement the same computation: load CSV rows → filter `gsr_raw` to positive floats → compute `mean`, `std`, `diff_rms`. In `compare_noise.py` lines 176–179 this is a verbatim copy of the inner logic from `analyze_gsr()` in `analyze_track.py`. A bug fix or improvement to the statistics (e.g. using a Welford running mean instead of two-pass) must be applied in both places.

**Fix:** Extract a shared module:
```python
# biomap_utils.py
def compute_gsr_stats(rows):
    """
    Returns a dict with keys: samples, mean, std, cv_pct, diff_rms, range.
    Returns None if fewer than 2 valid samples found.
    """
    vals = [float(r.get('gsr_raw', 0) or 0)
            for r in rows
            if float(r.get('gsr_raw', 0) or 0) > 0]
    if len(vals) < 2:
        return None
    mean = sum(vals) / len(vals)
    std  = math.sqrt(sum((v - mean)**2 for v in vals) / len(vals))
    diffs = [abs(vals[i] - vals[i-1]) for i in range(1, len(vals))]
    return {
        'samples':  len(vals), 'mean': mean, 'std': std,
        'cv_pct':   std / mean * 100,
        'diff_rms': math.sqrt(sum(d*d for d in diffs) / len(diffs)),
        'range':    max(vals) - min(vals)
    }
```

---

### 4.3 No `argparse` in analyze_track.py — 📋 BACKLOG

**File:** `analyze_track.py` (lines 226–243)

**Problem:** The script uses raw `sys.argv` indexing. As a result:
- No `--help` flag — users must read the source to understand usage
- No validation of argument types at the CLI boundary
- Adding a future option (e.g. `--hdop-gate 3.0`) requires restructuring the entire argument handling
- An `IndexError` on wrong argument count gives a cryptic traceback instead of a usage message

**Fix:**
```python
import argparse

def main():
    parser = argparse.ArgumentParser(
        description='BioMapping GPS/GSR track analyzer'
    )
    parser.add_argument('track',    help='Path to biomap_XXX.csv')
    parser.add_argument('compare',  nargs='?', help='Second CSV for noise comparison')
    args = parser.parse_args()
    # ...rest of main unchanged
```

---

## 5. Cross-Cutting Concerns

### ✅ 5.1 GPS_HDOP_GATE Values Are Intentionally Different — DOCUMENTED

Cross-reference comments added to both `biomap_types.h` and `constants.js`.

**Files:** `biomap_types.h` (line 32: `5.0f`), `gsr-map-analyzer/constants.js` (line 31: `maxHdop: 2.0`)

**Problem:** The firmware logs positions with HDOP up to 5.0 (permissive, appropriate for urban canyons), while the JS analyzer's default filter is 2.0 (stricter, for clean analysis). These are deliberately different but the reason is not explained in either file. A developer tuning one without knowing the other exists will be confused by the apparent inconsistency.

**Fix:** Add a cross-reference comment at both sites:
```c
// biomap_types.h
// NOTE: The JS analyser defaults to maxHdop=2.0 (stricter, post-processing filter).
// This firmware gate is intentionally more permissive to log positions that the
// analyser can later filter — an urban canyon at HDOP 4.9 is still useful data.
#define GPS_HDOP_GATE    5.0f
```

---

### ✅ 5.2 CSV Column Schema Defined in Four Places — APPLIED

`sd_logger.h` comment corrected (§2.4). `docs/csv_schema.md` created as canonical spec. Both `biomap_types.h` and `constants.js` now reference `docs/csv_schema.md`.

**Problem:** The output format `timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw` is the contract between the firmware and all downstream tools. It is currently defined in:

1. A string literal in `biomap_session.c` `key_toggle_recording()` — the actual CSV writer (authoritative)
2. A stale 7-column comment in `sd_logger.h` — out of sync (see §2.4)
3. Column-name heuristics in `gsr-map-analyzer/analyzer.js` — implicit
4. `r.get('gsr_raw', ...)` etc. in `analyze_track.py` — implicit

A column rename requires touching all 4 locations simultaneously, with no compiler or linter catching a missed update.

**Recommended fix:**
1. Fix `sd_logger.h` immediately (§2.4 above)
2. Create `docs/csv_schema.md` as the canonical human-readable spec
3. Add a `# Schema: <version>` comment field to the CSV metadata header (`# RecordingStartTime:...`) so tools can detect schema mismatches at parse time

---

### ✅ 5.3 No README at Repo Root — APPLIED

`README.md` created covering hardware setup, GPS module selection, build instructions, recording flow, web analyser usage, Python script usage, and repo structure.

**Problem:** The repository has no `README.md`. There is no starting point for:
- What hardware is required
- How to select and build the firmware for L76K vs M10Q
- What the SD card output looks like
- How to open and use the web analyzer
- How to run `analyze_track.py`

This is a blocker for any new contributor (including future-you returning after a gap).

**Recommended sections:**
- Hardware setup (Flipper Zero, GPS module, GSR circuit)
- Firmware build: `GPS_MODULE` selection, `ufbt` commands
- Recording: SD card layout, file naming
- Analysis: web analyzer usage, Python script usage
- CSV format reference (link to `docs/csv_schema.md`)

---

## 6. Priority Matrix

| # | Finding | File(s) | Priority | Status |
|---|---|---|---|---|
| **2.5** | RTC epoch OOB read (real UB) | `biomap_session.c` | 🔴 Fix now | ✅ Applied |
| **5.3** | Add README.md | repo root | 🔴 Fix now | ✅ Applied |
| **2.4** | sd_logger.h stale column comment | `sd_logger.h` | 🔴 Fix now | ✅ Applied |
| 3.1 | ui.js god object decomposition | `ui.js` | 🟡 High value | ⏳ Deferred — see §3.1 note |
| 2.1 | Serial reinit helper (DRY) | `gps_uart.c` | 🟡 High value | ✅ Applied |
| 2.3 | Physiological constants unified | `gsr_sensor.h`, `session.c` | 🟡 High value | ✅ Applied |
| 2.2 | Static log-once flags into struct | `gps_uart.c` | 🟡 High value | ✅ Applied |
| 3.2 | Slider null-guard helper | `storage.js` | 🟡 High value | ✅ Applied |
| 4.1 | Bare except clauses | `analyze_track.py` | 🟡 High value | ✅ Applied |
| 5.2 | CSV schema canonical doc | `docs/csv_schema.md` | 🟡 High value | ✅ Applied |
| 5.1 | Document HDOP gate discrepancy | `biomap_types.h`, `constants.js` | 🟡 High value | ✅ Applied |
| 3.3 | Global namespace isolation | All JS | 🟢 When convenient | 📋 Backlog |
| 3.4 | AppState setter validation | `app_state.js` | 🟢 When convenient | 📋 Backlog |
| 3.5 | Layout constants CSS custom props | `styles.css`, `constants.js` | 🟢 When convenient | 📋 Backlog |
| 4.2 | Shared GSR stats in biomap_utils.py | Python scripts | 🟢 When convenient | 📋 Backlog |
| 4.3 | argparse in analyze_track.py | `analyze_track.py` | 🟢 When convenient | 📋 Backlog |
| 2.6 | GPS badge PDOP format_pdop_str | `biomap_render.c` | 🟢 When touching | 📋 Backlog |
| 2.7 | Unit test harness | `tests/` | 🟢 Before major refactor | 📋 Backlog |
| 3.6 | Move test file to tests/ | `test_dwt_clamp.js` | 🟢 Housekeeping | 📋 Backlog |
| 3.8 | ES Module migration | All JS | 🟢 Long-term | 📋 Backlog |

**Total: 20 actionable findings** (down from 29 after removing low-reward items)

---

## 7. Removed Items & Rationale

These items appeared in the initial analysis but were removed after critical review.

| Item | Reason Removed |
|---|---|
| **2.1 GPS vtable abstraction** | `#if` is idiomatic embedded C for compile-time module selection. A C vtable (function pointers) adds runtime indirection, removes inlining, and harms static analysis — for 2 modules this is pure over-engineering. If a 3rd module is ever added, the `#if` refactoring cost is contained and manageable. |
| **2.4 handle_recording_key OK key** | The current design is **intentional and clearly documented** with a comment explaining exactly why OK is handled at the call site (it needs `NotificationApp*`). Adding a 5th parameter to a static function used in one place changes a deliberate, well-reasoned interface for zero functional gain. |
| **2.5 GPS_POS_EMPTY sentinel** | `GpsPosition empty = {0}` is idiomatic C zero-initialisation. A named `static const` at file scope adds a global symbol, introduces a `const`-casting concern, and the existing comment already explains the intent. The pattern is correct and readable as-is. |
| **2.6 Session render-cache coupling** | The render functions already receive `BioMapApp*` — the "coupling" is moot since moving the fields to `BioMapApp` doesn't change any function signature or access pattern. This would be net churn touching `biomap.h`, `biomap_render.c`, and `biomap_session.c` with no observable improvement. |
| **2.8 Merge MenuContext/OptionsContext** | In C, distinct typedefs for distinct roles is conventional and useful for documentation. Structural identity doesn't mean conceptual identity — a `ScreenContext` used for both menu and options would reduce type-system expressiveness for no compile-time benefit. |
| **2.10 Expansion RAII helper** | Wrapping a 6-line pattern in a function-pointer callback is harder to read than the original flat code. The "error path leaving Expansion disabled" risk is theoretical — neither `gps_uart_standby()` nor `gps_uart_free()` has any failure path between the disable and enable calls. |
| **3.4 Haversine duplication** | The original finding stated `map_match.js` "likely" has its own distance function — this was never verified. A refactoring recommendation based on unverified speculation should not be in this document. *Action: verify manually before re-adding.* |
| **4.3 Knots→m/s constant** | `0.514444` vs `1852/3600 = 0.514444...` is a ~0.00003% difference — completely irrelevant at GPS accuracy levels. The constants live in different languages and there is no practical shared source of truth between Python and JS. Fixing this would be change for change's sake. |

---

## 8. Changelog

| Date | Change |
|---|---|
| 2026-07-14 | Initial full codebase analysis — 29 findings |
| 2026-07-14 | v2: Critical review — 8 items removed |
| 2026-07-14 | v3: Applied all "Fix now" + "High value" items. 10 items marked ✅. ui.js decomposition deferred (internal coupling requires interface design first). `docs/csv_schema.md` and `README.md` created. |
