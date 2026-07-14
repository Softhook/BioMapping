# BioMapping — Outstanding Refactoring Work

> **Created:** 2026-07-14
> **Scope:** Firmware (C), Python tooling, and the browser-based JS analyser.
> **Method:** Every item below was checked against the current source (file:line
> references given). Items already closed in `docs/refactoring_analysis.md` are
> **not** repeated here — this document lists only what still needs doing.

## How to read this

The repo already maintains a living review, `docs/refactoring_analysis.md`, where
the large majority of items are marked ✅ applied. This document is the
complement: the work that is **still open**, split into two groups.

- **NEW** — issues verified in this pass that are either absent from the living
  doc or only partially closed by it.
- **CARRIED-OVER** — items the living doc already tracks as deferred/backlog,
  re-verified against the current code so you know they are still real.

Firmware C is in good shape and is **not** the focus; almost all outstanding work
is in the JS analyser, which is where the size and duplication live.

---

## Module size snapshot (verified)

| File | Lines | Note |
|---|---|---|
| `gsr-map-analyzer/map.js` | 1493 | Largest file in the repo — multi-responsibility |
| `gsr-map-analyzer/ui.js` | 1390 | God object (living doc §3.1, deferred) |
| `gsr-map-analyzer/analyzer.js` | 1216 | Core pipeline + CSV parsing |
| `gsr-map-analyzer/osm_enrichment.js` | 1178 | Geometry + Overpass networking + enrichment |
| `gsr-map-analyzer/events.js` | 711 | Event bindings |
| `modules/gps_uart.c` | 769 | Firmware — well-sectioned, no action |
| `biomap_session.c` | 667 | Firmware — well-sectioned, no action |

The living doc's decomposition section (§3.1) targets **only** `ui.js`, but
`map.js` (1493) is actually the largest module and `osm_enrichment.js` (1178) is
close behind. Both warrant the same treatment (see N4/N5 below).

---

## NEW findings (verified this pass)

### N1 — JS analyser parses CSV columns the firmware never writes (`vdop`, `wdop`)

**Files:** `gsr-map-analyzer/analyzer.js`, `gsr-map-analyzer/gps_filter.js`

The canonical schema (`docs/csv_schema.md`) and the firmware writer emit exactly
ten columns: `timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw`
(`biomap_session.c` header). Despite that, the analyser still recognises and
branches on two columns that no BioMapping CSV contains:

- `analyzer.js:263-264, 296-300, 364-365, 399-400` — allocates `vdopColIndex` /
  `wdopColIndex`, matches header names `'vdop'` / `'wdop'`, parses them, and stores
  `vdop` / `wdop` on every point.
- `gps_filter.js:123, 311` — the DOP-selection logic *prefers* `pt.wdop` when
  present (`!isNaN(pt.wdop) && pt.wdop > 0 && pt.wdop < 50.0`).

Verification of what the firmware actually produces:

- **`wdop`** is never computed anywhere in the firmware — it is a phantom. Because
  the column is always absent, `pt.wdop` is always `NaN`, so the preferred branch
  in `gps_filter.js` is **dead** for every real recording.
- **`vdop`** *is* computed internally (`modules/gps_uart.c:217-219`, sentinel at
  `:445`) but is **not written to the CSV**. The analyser's `vdop` column parse is
  therefore also dead for real files.

**Why it matters:** this is misleading dead code — a reader of `gps_filter.js`
would reasonably assume `wdop` is a real, preferred quality metric. It also means
the DOP filter silently never uses its "best" input.

**Fix:** remove the `vdop`/`wdop` index detection and the `pt.wdop` preference
branch, leaving `pdop`→`hdop` as the real fallback chain. (Note: `analyze_track.py`
had the same stale `alt`/`wdop` reads and was already cleaned in this session, so
Python is now consistent with the schema; the JS is the remaining offender.)

### N2 — No single, code-level source of truth for the CSV schema

**Files:** `gsr-map-analyzer/analyzer.js` (header-name matching), `docs/csv_schema.md` (doc only)

N1 is a symptom; this is the root cause. `docs/csv_schema.md` is the "canonical"
schema, but it is a **document**, not code. The analyser rediscovers columns by
fuzzy header-name matching (`h === 'vdop'`, `h.includes('alt')`, …) rather than
from a shared definition, so nothing prevents parser and firmware from drifting
apart — which is exactly what happened with `vdop`/`wdop`/`alt`.

**Fix:** define the column list once as a JS constant (e.g.
`GSR_CONST.CSV_COLUMNS` in `constants.js`) mirroring `csv_schema.md`, and have
`analyzer.js` build its column-index map from that list. When the schema changes,
one edit updates the doc-mirroring constant and the parser together. This closes
the loop that §5.2 of the living doc opened (§5.2 created the canonical doc but did
not remove the divergent hand-rolled parsing).

### N3 — Great-circle distance is implemented three times (resolves the living doc's unverified item)

**Files:** `gps_filter.js:14`, `map_match.js:462`, `osm_enrichment.js:147`

The living doc lists "Haversine duplication" in its *Removed Items* table with the
note *"never verified … should not be in this document."* It is now verified: the
same haversine great-circle formula (Earth radius 6 371 000 m) exists under three
different names in three modules:

- `GpsFilter.haversineDistance()` — `gps_filter.js:14`
- `_haversineM()` — `map_match.js:462`
- `haversine()` — `osm_enrichment.js:147` (with `EARTH_RADIUS_M` at `:10`)

`osm_enrichment.js` additionally carries pure geometry helpers `distanceToSegment`
(`:161`) and `pointInPolygon` (`:188`) that belong with them.

**Fix:** extract a small dependency-free `geo_utils.js` exposing
`haversineMeters`, `distanceToSegmentMeters`, and `pointInPolygon`, and have the
three modules call it. This is low-risk (pure functions, easily unit-tested) and
removes three copies of a formula that must otherwise stay in sync by hand.

### N4 — GPS display-filter pipeline is split across `map.js` and `gps_filter.js`

**Files:** `gsr-map-analyzer/map.js`, `gsr-map-analyzer/gps_filter.js`

GPS filtering has no single home. `gps_filter.js` owns the Kalman/RTS smoother
(`applyKalman`, `gps_filter.js:93`) and speed logic, but `map.js` — nominally the
*rendering* module — contains a full parallel filtering pipeline:

- `_applyHdopGate` (`map.js:440`)
- `_applyFixTypeGate` (`map.js:449`)
- `_applyPreKalmanFilters` (`map.js:468`)
- `_reconstructFilteredGps` (`map.js:499`) + interpolation/gap handling
- `_applySnapCorrection` (`map.js:481`), `_downsampleForDisplay` (`map.js:544`)

So a change to how positions are gated or interpolated may need edits in two
files, and the map renderer carries ~200 lines that are not about drawing.

**Fix:** move the gate/pre-filter/reconstruction/downsample methods into
`gps_filter.js` (or a new `gps_pipeline.js`), leaving `map.js` to consume a
finished point list. Best done **after** N3, since these methods lean on the
haversine helper.

### N5 — `map.js` and `osm_enrichment.js` are multi-responsibility modules

**Files:** `gsr-map-analyzer/map.js` (1493), `gsr-map-analyzer/osm_enrichment.js` (1178)

Beyond N4, `GSRMapManager` (`map.js`) bundles at least four separable concerns:
Leaflet map + legend (`initMap`, `_initLegend`, `updateLegend`), colour mapping
(`_getHslColor`, `getColorForValue`, `_getColorLut`, `getColorForMetric`), a
draw-point cache with fingerprint hashing (`_hashGpsParams`, `_snapFingerprint`,
`_getOrBuildDrawPoints`), and the GPS pipeline from N4.

`osm_enrichment.js` mixes three concerns: pure geometry (N3), Overpass API
networking (`_enforceRateLimit :306`, `_backoffMs :322`, `_retryAfterMs :331`,
`fetchOSMData :340`, `buildQuery :266`), and the enrichment logic itself.

**Suggested split (incremental, one module per PR):**

| From | Extract | Into |
|---|---|---|
| `map.js` | colour scale / LUT helpers | `map_colors.js` |
| `map.js` | GPS gate/interp/downsample (N4) | `gps_pipeline.js` |
| `osm_enrichment.js` | haversine / segment / polygon (N3) | `geo_utils.js` |
| `osm_enrichment.js` | Overpass fetch + rate-limit/backoff | `overpass_client.js` |

Each leaves the origin module a thinner coordinator, mirroring the pattern the
living doc already proposes for `ui.js`.

---

## CARRIED-OVER open items (re-verified, still valid)

### C1 — `ui.js` god object (living doc §3.1, ⏳ deferred)

Still 1390 lines. The living doc's deferral rationale and resumption plan remain
correct: extract the maths helpers (`calculatePearsonCorrelation`, `_tTestPValue`,
`_regIncompleteBeta`, `calculateLinearRegression`) into `stats_math.js` first,
then peel off `analysis_pipeline.js`, `stats_display.js`, `export.js`,
`fullscreen.js`, and `collective_ui.js`. No new analysis needed — just execution.
Sequence this **after** the N3 `geo_utils.js`/`stats_math.js` extraction pattern is
proven, since it's the same low-risk "pull pure helpers out first" move.

### C2 — No unit-test harness for the core pipeline (living doc §2.7, 📋 backlog)

Confirmed: the only test in the repo is `gsr-map-analyzer/tests/test_dwt_clamp.js`;
there is **no** host-native C test target. The pure, SDK-free firmware functions
named in §2.7 (`smooth_iir_filter`, `update_display_pipeline`,
`update_graph_pipeline`, `rescale_graph_buf`, `gsr_sensor_tick` with a mock I2C
buffer) still have zero coverage. This is the stated pre-condition for safely
doing any of the larger refactors above — **do it first** if you intend to touch
the GSR/graph pipeline.

### C3 — All analyser JS lives in global scope (living doc §3.3, 📋 backlog)

Confirmed: every module is loaded as a plain `<script>` and hangs off `window`;
load order is enforced only by tag order in `index.html`. The short-term IIFE
namespace and the long-term ES-module migration from §3.3 both still apply. This
becomes *more* valuable as you add the new small modules from N2–N5 (more files =
more load-order fragility), so consider the ES-module move as the umbrella that the
extractions land inside.

### C4 — GSR statistics duplicated across the two Python scripts (living doc §4.2, 📋 backlog)

Confirmed: `analyze_track.py` computes GSR stats in `analyze_gsr` (`:100`) and
`compare_gsr_noise` (`:146`), and `compare_noise.py` (191 lines) computes an
overlapping set again. Extract the shared metrics (mean, std, CV, point-to-point
delta/RMS, outlier count) into a `biomap_utils.py` imported by both.

---

## Firmware (C) — status

No outstanding structural refactors. The known real bug (RTC epoch out-of-bounds
read, living doc §2.5) is genuinely fixed — the guard against `month == 0` /
`year < 2020` is present in `rtc_to_unix_epoch` (`biomap_session.c`), preventing the
`days_before[-1]` read. `gps_uart.c` and `biomap_session.c` are long but cleanly
sectioned with a clear data pipeline. The one firmware item worth doing is **C2**
(test coverage) before any future pipeline change.

---

## Priority matrix

| # | Finding | Area | Effort | Priority |
|---|---|---|---|---|
| **N1** | Remove phantom `vdop`/`wdop` CSV parsing | JS | Low | 🔴 Do now (dead + misleading) |
| **N2** | Single code-level CSV schema constant | JS | Low–Med | 🟡 High value (prevents recurrence of N1) |
| **N3** | Extract shared `geo_utils.js` (3× haversine) | JS | Low | 🟡 High value |
| **C2** | C unit-test harness | Firmware | Med | 🟡 High value (gates other refactors) |
| **N4** | Consolidate GPS filter pipeline | JS | Med | 🟡 High value |
| **C4** | Shared `biomap_utils.py` GSR stats | Python | Low | 🟢 When convenient |
| **N5** | Split `map.js` / `osm_enrichment.js` | JS | Med–High | 🟢 Incremental |
| **C1** | Decompose `ui.js` | JS | High | 🟢 Incremental (has a plan) |
| **C3** | Namespace / ES-module migration | JS | Med | 🟢 Umbrella for the above |

**Suggested order:** N1 → N2 (stop the schema drift), then N3 and C2 (cheap,
enabling), then N4 → N5 → C1 under the C3 module migration.

---

## Verification appendix

What was checked to ground the above (so findings can be trusted, not taken on
faith):

- Module line counts via `wc -l` across all `*.js` / `*.c` / `*.py`.
- `vdop`/`wdop` parsing located in `analyzer.js`/`gps_filter.js`; confirmed the
  firmware writes neither (`wdop` absent everywhere; `vdop` computed in
  `gps_uart.c` but not in the CSV writer/header).
- Three haversine implementations located at `gps_filter.js:14`,
  `map_match.js:462`, `osm_enrichment.js:147`.
- `map.js` GPS-filter methods and `gps_filter.js` Kalman located by name.
- Test inventory: only `gsr-map-analyzer/tests/test_dwt_clamp.js`; no C target.
- RTC UB fix confirmed present in `rtc_to_unix_epoch` (`biomap_session.c`).
- No `TODO`/`FIXME`/`HACK` markers in source; `todo.txt` contains product notes
  only.
