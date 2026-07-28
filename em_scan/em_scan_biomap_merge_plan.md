# Merging em_scan into BioMapping (combined data stream)

This is a plan doc, not a spec — see [em_scan_worker_integration_plan.md](em_scan_worker_integration_plan.md) for the original (superseded) interleaved-worker proposal, and [em_scan_calibration_plan.md](em_scan_calibration_plan.md) / [em_scan_calibration_findings.md](em_scan_calibration_findings.md) for the Faraday calibration's own history.

## Context

`em_scan` started as a standalone Flipper app to field-test a dedicated CC1101 RF-worker thread in isolation, deliberately kept away from BioMapping's GSR worker until proven on hardware. That gate has been passed — walk-test recordings exist (including track 83, recorded after reducing from 7 to 3 bands: 815/868/915 MHz), and the flush cadence / `RecordingState` / error-handling patterns have already been converged onto BioMapping's own conventions this session.

The confirmed integration direction: **RF scanning becomes an additional data stream inside the existing `biomap` app** — GPS+GSR+RF correlated in one CSV row per walk — not a separate mode with its own CSV. This matches the original EM-Fog-as-GSR-context motivation. The standalone `em_scan` app is retired once its logic is folded in.

A structural problem was found while investigating this: `em_scan/application.fam` builds a fully separate app whose `modules/gps_uart.c`/`modules/sd_logger.c` sources resolve to **`em_scan/modules/`** — a byte-identical but physically duplicated fork of the top-level `modules/` (confirmed via `diff`, zero divergence today but nothing enforces that). This merge is also the fix for that.

**Before starting**: `git status` shows uncommitted local changes already sitting in `em_scan/` from this session (`em_scan.c`, `em_scan_cal.c/.h`, `em_scan_rf.c/.h`, `em_scan_rf_worker.c`, `tests/test_em_scan_cal.c`) plus an untracked `em_scan/biomap_083.csv`. Commit or stash that baseline first so the merge work has a clean diff to reason about.

## Facts verified before writing this plan (not assumptions)

- `python3 -m ufbt`'s source globbing (`fbt_extapps.py` / `sconsrecursiveglob.py`) resolves `sources=[...]` paths relative to the app's own directory (where `application.fam` lives). For the root `biomap` app that's the repo root, so `"em_scan/em_scan_rf.c"` etc. work exactly like the existing `"modules/gps_uart.c"` entry does today. **No file moves needed** to add these sources to the main app's build.
- Current Options menu (`biomap_gui.c:186-235`, `run_options_screen`): 0=Reset GPS, 1=Auto-zoom toggle, 2=Backlight toggle, 3=GSR Calibration, 4=Diagnostics, 5=Sound toggle, 6=GPS Profile cycle. `OPTIONS_COUNT=7` (biomap.h:103).
- `em_scan_rf.c/h`, `em_scan_rf_worker.c/h`, `em_scan_cal.c/h` are already fully independent of `EmScanApp` — reusable as-is, no changes needed to the logic itself.
- GSR worker thread priority defaults to `FuriThreadPriorityNormal` (never set explicitly, per `modules/gsr_sensor.c`); RF worker is explicitly `Low`. Already scheduler-safe for coexistence — no change needed there.
- `em_scan_cal.bin` already persists at `/ext/biomapping/em_scan_cal.bin`, the same directory `biomap` already uses.

## Design decisions

**Resolved**: no on-screen RF display during recording, in any phase — CSV-only. The live RSSI stream never needs to show up on the recording screen; both existing layouts (GpsGsr's graph, GpsOnly's stacked detail lines) are already tight, and there's no requirement to free up space for it. This removes the "Rendering" phase from this plan entirely (see Phasing below) — Phase 1 makes no `biomap_render.c` changes at all. (The Faraday calibration wizard in Phase 2 still needs its own screens — prep countdown, sampling progress, pass/fail — same as it always would; this decision is specifically about the live per-row RSSI readout, not the wizard's necessary UI. `em_scan_calc_fog_index()`, previously used only for a live on-screen fog number, is dropped from the port entirely — nothing in this plan needs it.)

Still to confirm while implementing:

1. **RF snapshot storage**: fetch `em_scan_rf_worker_get_snapshot()` fresh wherever needed (CSV row builder) rather than caching arrays on `Session`. This matches how GSR values are already fetched fresh (`gsr_sensor_get_raw()` etc.) rather than cached per-tick — avoids a second copy of the same data going stale in two places. **Recommended.**
2. **`em_scan_rf_init()`/`_deinit()` scope**: these were written for once-per-app-lifetime use (CC1101 power state). Calling them once per recording session instead (bookended like GSR's alloc/free) fits biomap's "only pay for what's active" pattern and sidesteps needing to coordinate the RF worker thread against the calibration wizard's short dwell touching the same radio — recording sessions and the calibration wizard are already mutually exclusive UI states. **Recommended, but needs hardware confirmation**: does a 2nd/3rd session's RF worker produce sane values, or does repeated init/deinit leave the CC1101 in a stale state?
3. **Calibration wizard control-flow style**: em_scan.c's wizard is tick/timer-driven (`EmScanModeCalPrep`/`CalSampling` advance once per `EventTypeTick` over a 30s+20s window). BioMapping's existing GSR wizard (`run_calibration_wizard`) is a **blocking loop** (`furi_delay_ms()` calls directly in `calibration_wizard_measure()`). Recommend rewriting the RF wizard to match the GSR wizard's blocking-loop style rather than porting em_scan.c's state machine verbatim — it's the closer precedent and avoids standing up a second independent timer/tick loop for something that only runs for ~50 seconds. **This is a rewrite of the control flow, not a mechanical port — confirm before implementing.**

## Phasing

Three independently buildable/testable phases (down from four — the on-screen rendering phase was dropped, see Design decisions above). Each ends with a `python3 -m ufbt` build from repo root before moving to the next — the only mechanical verification available here (no GUI test shims, no hardware-in-the-loop).

### Phase 1 — RF worker + CSV columns (flat floor, no calibration UI yet)

**`biomap_config.h`**
- Add:
  ```c
  // rssi_815/868/915 order must match em_scan_freq_label[] in em_scan_rf.c —
  // if that array changes, this header string needs to change too.
  #define BIOMAP_CSV_COLS_GPS_GSR_RF \
      "timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,rssi_868,rssi_915\n"
  ```

**`biomap_types.h`**
- Add `has_rf(mode)` inline helper, initially identical to `has_gps` (`GpsGsr`/`GpsOnly`) — a separate name so RF's gating is one documented toggle point, not an alias that could silently diverge from GPS gating later.
- Add `#define RF_WORKER_PARK_MS 300` next to `TICK_HZ`/`FLUSH_INTERVAL` (moved from em_scan.c's own `EM_SCAN_WORKER_PARK_MS`, which is being deleted).

**`biomap.h`**
- Include `"em_scan_rf.h"` / `"em_scan_rf_worker.h"`.
- `Session`: add `EmScanRfWorker* rf_worker;` — no cached RSSI arrays (see open call #1).
- `BioMapApp`: add `bool rf_scan_enabled;` (Options toggle, default `true`) — a safety valve to run a plain GPS+GSR walk without the RF thread/CC1101 active, consistent with the existing `sound_enabled`/`backlight_on`/`zoom_enabled` toggles. This is beyond the literal ask but cheap and pattern-consistent — say if you'd rather wire the worker unconditionally to `has_rf(mode)` instead.

**`biomap.c`**
- No app-lifetime CC1101 init needed if going with per-session init/deinit (open call #2, recommended).

**`biomap_session.c`**
- `run_recording_session()`, after the existing `s->gsr = has_gsr(mode) ? ... : NULL;` block:
  ```c
  if(has_rf(mode) && app->rf_scan_enabled) {
      em_scan_rf_init();
      s->rf_worker = em_scan_rf_worker_alloc(RF_WORKER_PARK_MS);
      em_scan_rf_worker_start(s->rf_worker);
  } else {
      s->rf_worker = NULL;
  }
  ```
- `session_deinit()`: add
  ```c
  if(s->rf_worker) {
      em_scan_rf_worker_free(s->rf_worker); // stops + joins internally
      s->rf_worker = NULL;
      em_scan_rf_deinit();
  }
  ```
- Header selection (`key_toggle_recording()`, ~line 333-335) becomes a 3-way branch instead of a ternary:
  ```c
  const char* cols;
  if(s->mode == BioMapModeGsrOnly)      cols = BIOMAP_CSV_COLS_GSR_ONLY;
  else if(s->rf_worker)                 cols = BIOMAP_CSV_COLS_GPS_GSR_RF;
  else                                   cols = BIOMAP_CSV_COLS_GPS_GSR;
  ```
  Using `s->rf_worker != NULL` as the single source of truth (not `has_rf(mode)` alone) correctly reflects the `rf_scan_enabled` toggle too — matches the existing pattern where `s->gsr`/`s->gps` non-NULL-ness already gates everything downstream.
- `format_gps_csv_row()` signature grows one parameter:
  ```c
  static bool format_gps_csv_row(Session* s, const GpsPosition* pos,
                                  double rel, float raw, const float* rf_rssi);
  ```
  `rf_rssi` is `NULL` when RF isn't active for the session, otherwise a fresh 3-element snapshot fetched at the call site. All three existing snprintf branches (has-velocity / no-velocity / gps-not-ok) need `,%.1f,%.1f,%.1f` appended when `rf_rssi != NULL`, unchanged otherwise. Both call sites (`batch_csv_row`, `handle_recording_tick`'s GpsOnly branch) fetch the snapshot via `em_scan_rf_worker_get_snapshot()` right before calling, only when `s->rf_worker` is set.
- **Why Diagnostics/GsrOnly are safe by construction**: `has_rf(mode)` is defined identically to `has_gps(mode)`, so `s->rf_worker` can only be non-NULL for GpsGsr/GpsOnly. Diagnostics never allocates a worker (even though it shares `batch_csv_row`'s `!has_gsr` guard path with other modes), so `rf_rssi` stays NULL there and its row/header stay exactly as they are today — no special-casing needed beyond the one `s->rf_worker` check already threaded through.
- **Data-shape note for later analysis**: the RF worker round-robins one band per ~`RF_WORKER_PARK_MS`×3 ≈ 900ms rotation, while CSV rows log every 100ms — so a given band's value repeats across several consecutive rows until its next turn. Same characteristic em_scan.c's own CSV always had; not a bug, just worth noting for whoever does spatial-correlation analysis.

**`biomap_gui.c` / `biomap_render.c`**
- Append one Options item (index 7): "RF Scan" enabled/disabled toggle, flipping `app->rf_scan_enabled` — same toggle pattern as auto-zoom/backlight/sound (`run_options_screen`'s `switch(ctx.selection)`, plus the corresponding label in `options_render`'s item list and its `ON`/`OFF` state overlay). `OPTIONS_COUNT` 7 → 8. Introducing the field and its toggle together in the same phase keeps Phase 1 self-contained — otherwise `rf_scan_enabled` would exist but be undisableable without a recompile until Phase 2.

**`application.fam`** (root)
- Add sources: `"em_scan/em_scan_rf.c"`, `"em_scan/em_scan_rf_worker.c"`.

No calibration wizard in this phase — `em_scan_cal_load()` returns "not calibrated," RF logs raw RSSI regardless (no floor comparison needed for logging; the only use of calibration data is the CSV header's "Band Floors" line, added in Phase 2).

**Verification**: `python3 -m ufbt` clean build. Manual review of the 3 CSV branches for column-count parity (a good candidate to also host-test — see §Testing). Real hardware walk test to confirm RF worker doesn't starve GSR and that per-session init/deinit behaves across 2+ sessions (open call #2).

### Phase 2 — Faraday calibration wizard

- `BioMapApp` gets two new fields, following the existing `cal_active`/`cal_gain`/`cal_offset` precedent: `EmScanCal rf_cal_data; bool rf_calibrated;`. Loaded at startup via a new `biomap_load_rf_calibration(app)` (distinct name from the existing GSR-only `biomap_load_calibration` — not renaming that one, it's tested/working code with an ambiguous name that isn't worth touching for this).
- New file **`biomap_rf_cal.c`** (kept separate from `biomap_gui.c`, which is already 561 lines and owns 3 GSR-calibration-adjacent flows — adding ~250 lines of ported wizard logic there would push it past 800) with `void run_rf_calibration_menu(BioMapApp* app)` and `void run_rf_calibration_wizard(BioMapApp* app)`, declared in biomap.h alongside the GSR equivalents.
- New render functions (`rf_calibration_menu_render`, `rf_calibration_wizard_prep_render`, `..._sampling_render`, `..._stats_render`) go in `biomap_render.c`, matching the existing control-flow/drawing split.
- Control flow: rewritten to the GSR wizard's blocking-loop style (open call #3), not em_scan.c's tick-driven state machine — reuses `em_scan_rf_dwell_band()` + `em_scan_cal_compute_stats()` + `em_scan_cal_max_floor_dbm[]` + `em_scan_cal_save()`, all unchanged pure logic.
- `key_toggle_recording()`'s header assembly (biomap_session.c ~line 336-338) needs to conditionally append a "Band Floors" line when `app->rf_calibrated`, mirroring em_scan.c's own `em_scan_build_header()` conditional (`# Band Floors (dBm): 815:-90.0,868:-90.0,915:-90.0`) — this was the one place calibration data actually feeds into the CSV, and it was missing from Phase 1's header-selection bullet since no calibration exists yet at that point.
- Options menu: append one more item (index 8, after Phase 1's index-7 "RF Scan" toggle) — "RF Calibration" → `run_rf_calibration_menu(app)`, then re-push `options_render` afterward exactly like case 3 (GSR Calibration) already does. `OPTIONS_COUNT` 8 → 9.
- `application.fam`: add `"em_scan/em_scan_cal.c"`, `"biomap_rf_cal.c"`.

**Verification**: `python3 -m ufbt` build; `run_tests.sh`'s existing `test_em_scan_cal` target continues to pass unmodified (it already exercises `em_scan_cal.c`'s pure logic against `storage_mock`, and this phase doesn't change that file); manual review of the rewritten wizard control flow; hardware test of the actual wizard flow (Faraday box present).

### Phase 3 — Retire the standalone app

- Delete `em_scan/em_scan.c` (logic now lives in `biomap_session.c`/`biomap_rf_cal.c`/`biomap_render.c`).
- Delete `em_scan/modules/` (confirmed byte-identical forks) and `em_scan/application.fam`.
- Keep `em_scan_rf.c/h`, `em_scan_rf_worker.c/h`, `em_scan_cal.c/h` living under `em_scan/` (no path churn on paths just landed in Phase 1/2's `application.fam`) and the calibration docs for history.
- **Explicit go-ahead required before executing** — this deletes a working, hardware-validated app entry point. Treat as its own checkpoint after Phase 1+2 have actually been flashed and walked with, not something to do reflexively right after Phase 2 lands.

## Testing / verification summary

**Realistic without hardware:**
- `python3 -m ufbt` from repo root, every phase.
- `./run_tests.sh` should keep passing unchanged throughout (none of these phases touch `biomap_pipeline.c`, `modules/gps_uart.c`, `modules/gsr_sensor.c`, `modules/sd_logger.c`, or `em_scan_cal.c`'s actual logic).
- Worth adding in Phase 1: a small host-side test (in `tests/test_firmware.c`) asserting column-count parity between `BIOMAP_CSV_COLS_GPS_GSR_RF` and each of `format_gps_csv_row`'s 3 branches — directly targets the "header/row column mismatch" failure mode this plan is careful to avoid by construction, cheaply, without hardware.
- Manual review: the 3-way header-selection branch, the 3 snprintf branches, and the Options index additions (7→8 in Phase 1, 8→9 in Phase 2) for off-by-ones.

**Needs real hardware, no way around it:**
- `em_scan_rf.c`/`em_scan_rf_worker.c` call `furi_hal_subghz_*` directly — no host shim exists or is planned; this was already true before the merge.
- RF worker (`Low`) actually coexisting with the GSR worker (`Normal`) under real scheduling load, not just "priorities look right on paper."
- Per-session `em_scan_rf_init()`/`_deinit()` repeated across multiple sessions in one app run (Phase 1's biggest genuinely-new-behavior risk).
- The rewritten blocking-loop calibration wizard's actual timing/UX (Phase 2).
- End-to-end CSV correctness on a real walk — RF columns land correctly, round-robin staleness looks as expected in a real file.

## Critical files

- `biomap_session.c`, `biomap.h`, `biomap_config.h`, `biomap_types.h`, `application.fam`, `biomap_gui.c`, `biomap_render.c` (Phase 1 — GUI files only for the Options toggle, no recording-screen rendering)
- `biomap_gui.c`, `biomap_render.c`, new `biomap_rf_cal.c` (Phase 2 — new calibration wizard screens)
- `em_scan/em_scan_rf.c/h`, `em_scan/em_scan_rf_worker.c/h`, `em_scan/em_scan_cal.c/h` (reused as-is, Phases 1-2)
- `em_scan/em_scan.c`, `em_scan/modules/`, `em_scan/application.fam` (deleted, Phase 3)
