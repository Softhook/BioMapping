# Merging em_scan into BioMapping (combined data stream)

This is a plan doc, not a spec — see [em_scan_worker_integration_plan.md](em_scan_worker_integration_plan.md) for the original (superseded) interleaved-worker proposal, and [em_scan_calibration_plan.md](em_scan_calibration_plan.md) / [em_scan_calibration_findings.md](em_scan_calibration_findings.md) for the Faraday calibration's own history.

## Implementation status (updated 2026-07-28)

**Phase 1 and Phase 2 are implemented, built, and undergoing active real-hardware iteration.** Phase 3 (retire the standalone app) is still deliberately deferred — see its section below, the reasoning for waiting has gotten stronger, not weaker, since this was written. The rest of this document is left mostly as originally written (useful record of the reasoning), with status markers and corrections added inline, plus two new sections at the bottom: **"Findings from real hardware testing"** and **"RF staleness: routes forward"** — read those for current state before assuming anything below is still just a plan.

## Context

`em_scan` started as a standalone Flipper app to field-test a dedicated CC1101 RF-worker thread in isolation, deliberately kept away from BioMapping's GSR worker until proven on hardware. That gate has been passed — walk-test recordings exist (including track 83, recorded after reducing from 7 to 3 bands: 815/868/915 MHz), and the flush cadence / `RecordingState` / error-handling patterns have already been converged onto BioMapping's own conventions this session.

The confirmed integration direction: **RF scanning becomes an additional data stream inside the existing `biomap` app** — GPS+GSR+RF correlated in one CSV row per walk — not a separate mode with its own CSV. This matches the original EM-Fog-as-GSR-context motivation. The standalone `em_scan` app is retired once its logic is folded in.

~~A structural problem was found while investigating this: `em_scan/application.fam` builds a fully separate app whose `modules/gps_uart.c`/`modules/sd_logger.c` sources resolve to **`em_scan/modules/`** — a byte-identical but physically duplicated fork of the top-level `modules/` (confirmed via `diff`, zero divergence today but nothing enforces that). This merge is also the fix for that.~~ **Correction (found 2026-07-28, mid-implementation): this was wrong.** `em_scan/modules/{gps_uart,sd_logger}.c/h`, `sound.h`, `util.h` are **symlinks** to the top-level `modules/` files (dated Jul 24-27, predating this merge work) — not physical duplicates. `diff` reporting them identical was because they're literally the same inode, not because nothing had drifted yet. No de-duplication cleanup is needed; editing `modules/*.c` already updates both apps' builds. (This mistake happened because the original investigation only ran `diff`, not `ls -la`/`file` — worth remembering that "diff reports identical" and "is the same file" are different claims.)

**Before starting**: done — this was completed before Phase 1 began.

## Facts verified before writing this plan (not assumptions)

- `python3 -m ufbt`'s source globbing (`fbt_extapps.py` / `sconsrecursiveglob.py`) resolves `sources=[...]` paths relative to the app's own directory (where `application.fam` lives). For the root `biomap` app that's the repo root, so `"em_scan/em_scan_rf.c"` etc. work exactly like the existing `"modules/gps_uart.c"` entry does today. **No file moves needed** to add these sources to the main app's build.
- Current Options menu (`biomap_gui.c:186-235`, `run_options_screen`): 0=Reset GPS, 1=Auto-zoom toggle, 2=Backlight toggle, 3=GSR Calibration, 4=Diagnostics, 5=Sound toggle, 6=GPS Profile cycle. `OPTIONS_COUNT=7` (biomap.h:103). **Now 9** — items 7 ("RF Scan" toggle) and 8 ("RF Calibration") were appended per Phases 1-2 below.
- `em_scan_rf.c/h`, `em_scan_rf_worker.c/h`, `em_scan_cal.c/h` are already fully independent of `EmScanApp` — reusable as-is, no changes needed to the logic itself.
- GSR worker thread priority defaults to `FuriThreadPriorityNormal` (never set explicitly, per `modules/gsr_sensor.c`); RF worker is explicitly `Low`. Already scheduler-safe for coexistence — no change needed there.
- `em_scan_cal.bin` already persists at `/ext/biomapping/em_scan_cal.bin`, the same directory `biomap` already uses.

## Design decisions

**Resolved**: no on-screen RF display during recording, in any phase — CSV-only. The live RSSI stream never needs to show up on the recording screen; both existing layouts (GpsGsr's graph, GpsOnly's stacked detail lines) are already tight, and there's no requirement to free up space for it. This removes the "Rendering" phase from this plan entirely (see Phasing below) — Phase 1 makes no `biomap_render.c` changes at all. (The Faraday calibration wizard in Phase 2 still needs its own screens — prep countdown, sampling progress, pass/fail — same as it always would; this decision is specifically about the live per-row RSSI readout, not the wizard's necessary UI. `em_scan_calc_fog_index()`, previously used only for a live on-screen fog number, is dropped from the port entirely — nothing in this plan needs it.)

Resolved during implementation (all three went with the recommended option):

1. **RF snapshot storage**: ✅ done as recommended — fetched fresh at the call site, never cached on `Session`. Ended up mattering more than expected: an early version fetched the snapshot *inside* the `app->mutex`-held tick-handler critical section, which (via the snapshot's own internal mutex) turned out to be the root cause of a real on-screen flicker bug — see Findings below.
2. **`em_scan_rf_init()`/`_deinit()` scope**: ✅ done per-session, as recommended. Hardware confirmation is still genuinely open — multiple sessions have run back-to-back across many test walks with no observed CC1101 staleness (RSSI values stay physically plausible every time), but this hasn't been isolated/stress-tested as its own specific question.
3. **Calibration wizard control-flow style**: ✅ rewritten to the GSR wizard's blocking-loop style, as recommended. Works on real hardware — Faraday-box pass/fail cycle exercised successfully.

## Phasing

Three independently buildable/testable phases (down from four — the on-screen rendering phase was dropped, see Design decisions above). Each ends with a `python3 -m ufbt` build from repo root before moving to the next — the only mechanical verification available here (no GUI test shims, no hardware-in-the-loop).

### Phase 1 — RF worker + CSV columns (flat floor, no calibration UI yet) — ✅ DONE

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

### Phase 2 — Faraday calibration wizard — ✅ DONE

- `BioMapApp` gets two new fields, following the existing `cal_active`/`cal_gain`/`cal_offset` precedent: `EmScanCal rf_cal_data; bool rf_calibrated;`. Loaded at startup via a new `biomap_load_rf_calibration(app)` (distinct name from the existing GSR-only `biomap_load_calibration` — not renaming that one, it's tested/working code with an ambiguous name that isn't worth touching for this).
- New file **`biomap_rf_cal.c`** (kept separate from `biomap_gui.c`, which is already 561 lines and owns 3 GSR-calibration-adjacent flows — adding ~250 lines of ported wizard logic there would push it past 800) with `void run_rf_calibration_menu(BioMapApp* app)` and `void run_rf_calibration_wizard(BioMapApp* app)`, declared in biomap.h alongside the GSR equivalents.
- New render functions (`rf_calibration_menu_render`, `rf_calibration_wizard_prep_render`, `..._sampling_render`, `..._stats_render`) go in `biomap_render.c`, matching the existing control-flow/drawing split.
- Control flow: rewritten to the GSR wizard's blocking-loop style (open call #3), not em_scan.c's tick-driven state machine — reuses `em_scan_rf_dwell_band()` + `em_scan_cal_compute_stats()` + `em_scan_cal_max_floor_dbm[]` + `em_scan_cal_save()`, all unchanged pure logic.
- `key_toggle_recording()`'s header assembly (biomap_session.c ~line 336-338) needs to conditionally append a "Band Floors" line when `app->rf_calibrated`, mirroring em_scan.c's own `em_scan_build_header()` conditional (`# Band Floors (dBm): 815:-90.0,868:-90.0,915:-90.0`) — this was the one place calibration data actually feeds into the CSV, and it was missing from Phase 1's header-selection bullet since no calibration exists yet at that point.
- Options menu: append one more item (index 8, after Phase 1's index-7 "RF Scan" toggle) — "RF Calibration" → `run_rf_calibration_menu(app)`, then re-push `options_render` afterward exactly like case 3 (GSR Calibration) already does. `OPTIONS_COUNT` 8 → 9.
- `application.fam`: add `"em_scan/em_scan_cal.c"`, `"biomap_rf_cal.c"`.

**Verification**: `python3 -m ufbt` build; `run_tests.sh`'s existing `test_em_scan_cal` target continues to pass unmodified (it already exercises `em_scan_cal.c`'s pure logic against `storage_mock`, and this phase doesn't change that file); manual review of the rewritten wizard control flow; hardware test of the actual wizard flow (Faraday box present).

### Phase 3 — Retire the standalone app — still deliberately deferred

- Delete `em_scan/em_scan.c` (logic now lives in `biomap_session.c`/`biomap_rf_cal.c`/`biomap_render.c`).
- Delete `em_scan/application.fam`. (`em_scan/modules/*` are symlinks, not forks — see the Context correction above — so there's nothing to de-duplicate there; deleting `application.fam` alone stops the standalone app from being built.)
- Keep `em_scan_rf.c/h`, `em_scan_rf_worker.c/h`, `em_scan_cal.c/h` living under `em_scan/` (no path churn on paths already landed in Phase 1/2's `application.fam`) and the calibration docs for history.
- **Explicit go-ahead required before executing.** The reasoning for waiting has gotten *stronger* since this was written, not weaker: the standalone `em_scan` app is currently useful as an isolated test rig — e.g. it's what produced the RF-only baseline (track 83) that the RF-staleness comparison below depends on, and it remains available to test whether some future timing fix (see Routes forward) actually helps by isolating RF from GSR again. Don't retire it until the RF staleness question is closed out, not just until Phase 1+2 "work."

## Testing / verification summary

**Realistic without hardware:**
- `python3 -m ufbt` from repo root, every phase.
- `./run_tests.sh` should keep passing unchanged throughout (none of these phases touch `biomap_pipeline.c`, `modules/gps_uart.c`, `modules/gsr_sensor.c`, `modules/sd_logger.c`, or `em_scan_cal.c`'s actual logic).
- ~~Worth adding in Phase 1: a small host-side test (in `tests/test_firmware.c`) asserting column-count parity between `BIOMAP_CSV_COLS_GPS_GSR_RF` and each of `format_gps_csv_row`'s 3 branches~~ — **not added**: `test_firmware.c` turned out to have its own hand-duplicated, already-stale copy of `format_gps_csv_row` with a mock logger that overwrites a buffer per call rather than appending, incompatible with the real function's eventual two-call-then-merged structure without a mock refactor. Skipped rather than doing that refactor blind; flagged instead of silently dropped. The failure mode it targeted (header/row column mismatch) was never hit in practice — the actual bug that did surface in this area was different (see Findings below).
- Host shims were extended once, for a fix unrelated to this plan's original scope: `tests/shims/storage/storage.h` + `storage_mock.c` gained a `storage_file_sync` stub (trivial always-`true`, the mock has no separate cache to sync) after `modules/sd_logger.c` was changed to call it for real — see Findings.
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
- `em_scan/em_scan.c`, `em_scan/application.fam` (deleted, Phase 3 — `em_scan/modules/` are symlinks, nothing to delete there)
- `modules/sd_logger.c` (durability fix, not originally in scope — see Findings)

## Findings from real hardware testing (2026-07-28)

Phase 1+2 code compiled clean and passed host tests before ever touching hardware, same as this plan expected — but several real bugs only surfaced once actually flashed and walked with, exactly the class of thing the "Needs real hardware" list above predicted would be untestable any other way. In the order they were found:

1. **CSV row corruption risk.** An early version of `format_gps_csv_row()` split each row across two `sd_logger_batch_printf()` calls (GPS/GSR columns, then the RF suffix) to avoid duplicating all 3 GPS-fix branches. Each call is individually atomic against the shared SD buffer, but the *pair* wasn't — if the buffer filled between the two calls, the first call's bytes (no trailing newline) were already committed, and the next row would land on the same line. Not a rare edge case: the buffer routinely nears capacity right at `FLUSH_INTERVAL` boundaries by design. **Fixed** by building the whole row in a local buffer first, one `sd_logger_batch_append()` call — matches `em_scan_log_row()`'s original pattern, restores atomicity.
2. **Calibration wizard prep countdown could be silently skipped early.** Used `furi_message_queue_get(..., ~100ms timeout)` as its pacing clock; that call returns immediately on *any* queued event, not just Back/OK, so mashing an unrelated key (Up/Down, which do nothing there) would fast-forward the 30s wait without the explicit OK-to-skip. **Fixed**: non-blocking peek + fixed `furi_delay_ms(100)`, matching the sampling loop's already-correct pattern.
3. **768-byte array on the calibration wizard's stack**, several call-frames deep, in a thread with only 4KB total stack (`application.fam`'s `stack_size`). `em_scan.c`'s original avoided this via a heap-allocated app struct field; the ported wizard put it on the stack instead. **Fixed**: made `static`.
4. **Real on-device crash #1** — generic Furi crash screen, no further text, during the first *sustained outdoor* GPS+GSR+RF walk (prior short tests were ~2min indoors and didn't crash). Leading suspect: `em_scan_rf_worker`'s thread stack was explicitly self-flagged in its own comment as *"a guess, not a measured figure... never profiled on real hardware"* — first time it ever ran this long, this concurrently. **Mitigated** (not confirmed root cause): bumped 2048B→3072B.
5. **Screen flicker on elapsed-time/GSR value during recording.** Root-caused, not guessed: `em_scan_rf_worker_get_snapshot()` was being called every tick from inside the `app->mutex`-held critical section that `biomap_render_callback()` also needs to hold to draw — a direct violation of a rule the codebase already documents in `handle_write_failure()`'s comment (nothing blocking may run in that section). The snapshot call briefly blocks on the RF worker's own internal mutex; doing that every single tick, not occasionally, made an intermittent redraw delay likely. **Fixed**: RF snapshot now fetched *before* `app->mutex` is acquired each tick (safe — `s->rf_worker` is only ever written by the same thread, outside the tick loop's lifetime).
6. **Real on-device crash #2** — bare `"furi_check failed"`, no further text at all. Own explicit asserts/checks in the RF worker and calibration code were traced through and ruled out as the direct cause. Added temporary diagnostic instrumentation to `handle_second_boundary()`: `memmgr_get_free_heap()`/`get_minimum_free_heap()` logged once/sec as a `#`-prefixed CSV comment line (same convention the header uses), flushed every second instead of waiting for `FLUSH_INTERVAL`, to capture the heap trend leading up to the next crash. **Flagged inline as temporary — remove once the crash is understood.**
7. **Root cause of losing an entire track on crash** (one crash produced a literal 0-byte file). `sd_logger_batch_flush()` called `storage_file_write()` but never `storage_file_sync()` — on Flipper's filesystem a "successful" write can sit in FatFs's cache and never reach physical media unless the file is later closed or explicitly synced, and a hard crash never reaches the normal close path. **Fixed permanently** (not scoped to the diagnostic) in `modules/sd_logger.c`: sync after every successful write; a failed sync is logged but not treated as a flush failure (retrying would duplicate already-written data, since `gsr_batch_len` is already cleared by that point). Required extending the host-test storage shim.

A subsequent long walk (track 91, 459.8s / 4599 rows) recorded with all the above fixes in place and did **not** crash — heap stayed completely flat (`free=89344`/`min=89088`, zero movement, at every checkpoint across the full 7.6 minutes) and the file structure was clean throughout (zero timestamp irregularities, heap-comment lines landing on exact 1.0s spacing 458/458 times). That's real evidence against a slow heap leak specifically; it doesn't yet confirm what caused either crash, since no crash has recurred to compare against.

A pre-existing, unrelated bug was also found and reported but **not fixed** (out of scope, flagged to Christian): `modules/gps_uart.c`'s GGA handler unconditionally overwrites `satellites_tracked` with GGA's own capped count, which GSA/GSV processing then corrects back up moments later — causes the logged `sats` column to visibly oscillate (seen ranging as wide as 6 to 54 in one file). Cosmetic only; hdop/pdop/fix_type/position stay correct throughout. Predates this merge, not caused by it.

## RF staleness: routes forward

Separately from the crash investigation, real-walk data has consistently shown the RF worker falling further behind its nominal ~900ms round-robin cycle than expected, and the trend gets worse as more concurrent load stacks up — not a data-quality problem (RF values are always physically valid when they do update, checked against the documented -91.5dBm noise floor and plausible transition sizes), a data-*freshness* problem:

| Track | Conditions | % cycles stalled >1.5s | Worst single stall |
|---|---|---|---|
| 83 | RF only (standalone em_scan), indoor | ~14% | 2.9s |
| 84 | RF+GSR, indoor, ~2min | ~20% | 6.6s |
| 87 | RF+GSR+GPS, real walk, ~1min | 26-33% | 7.0s |
| 91 | RF+GSR+GPS, real walk, ~7.6min | 21-32% | **12.0s** |

Root cause understood: the RF worker runs at `FuriThreadPriorityLow`, deliberately below GSR's `Normal`, specifically so it can never starve GSR sampling — but the flip side of that guarantee is that RF gets starved by *everything* else (GSR, GPS UART processing, GUI redraws, notification calls), and evidently does, more so as real-world load increases. Checked: there is no priority level between `Low` (15) and `Normal` (16) in `FuriThreadPriority` — `Low` is already the highest rung below `Normal`, so there's no free middle-ground option to try.

Options considered, roughly cheapest/safest to most invasive:

1. **Do nothing / accept it, but make the staleness explicit in the data.** Tag each RF value with when it was actually last measured (e.g. a per-band "age" or the worker's own tick-count at last update), logged as extra CSV column(s) or folded into a single "max staleness this row" column. Doesn't change timing at all — just stops the CSV silently implying every row's RF value is fresh when it might be up to ~12s stale. Lowest risk, smallest change (`EmScanRfWorker` needs to start tracking a per-band last-update timestamp, not just the value), and lets downstream spatial-correlation analysis filter/weight by actual freshness instead of guessing. Doesn't fix anything, just stops hiding the problem.
2. **Isolate which contended resource is actually responsible before changing anything.** Nothing so far has distinguished "GSR's I2C polling is the dominant contender" from "GPS UART NMEA bursts are" from "notification/LED calls are." The Diagnostics-mode change from earlier this session (RF now runs there too, gated by the same toggle) makes this directly testable: Diagnostics has no GPS at all, so a GSR+RF-only run there vs. a GpsOnly+RF run (no GSR) vs. today's full GpsGsr+RF would separate the variables and point at which one to actually target. Purely investigative, not a fix, but cheap (no code change) and would make option 3 or 4 below evidence-based instead of a guess.
3. **Raise RF worker priority from `Low` to `Normal`** (matching GSR). Would very likely reduce RF staleness substantially, by directly undoing the reason it's starved. Directly reintroduces the exact risk the `Low` choice was made to avoid: RF's SPI-heavy busy loops could then starve GSR's I2C polling instead. Not a blind risk to take, though — it's now genuinely testable via Diagnostics mode's exposed GSR metrics (`worker_hz`, success/duplicate/stale rate): toggle RF Scan on/off in Diagnostics at `Normal` priority and read the numbers directly, same instrument built earlier this session for exactly this kind of question, just not yet used to test *this* specific change.
4. **Reduce `RF_WORKER_PARK_MS` (currently 300ms/band) or otherwise shrink the RF worker's per-visit footprint.** Considered and set aside earlier in this project (see the flush-cadence conversation this session, before Phase 1 began): slowing dwell down only dilutes a fixed absolute stall's *share* of a longer cycle, it doesn't shrink the stall itself — and speeding it up doesn't help either, since the bottleneck is scheduling starvation, not the worker's own per-band work being too slow. Not expected to move the needle; not recommended.
5. **Move RF sampling off a dedicated thread entirely**, back toward something bounded and synchronous with the main tick loop. This is what the original short `em_scan_rf_dwell_band()` (~22ms) did before the dedicated worker thread was built specifically to allow much longer, more sensitive per-band dwells for better burst-catching. Reverting undoes the entire reason the worker exists. Not recommended.

**Recommendation, if/when this becomes the priority to fix**: option 2 first (cheap, no code, directly informs whether option 3 is worth the GSR risk) — then either option 3 (if GSR metrics hold up under a `Normal`-priority test) or option 1 (if they don't, or if "fix the timing" turns out lower-value than "make the analysis honest about staleness"). Not started; this is deliberately left as a decision point, not committed to a direction — Christian asked to set this aside while the crash investigation was live.
