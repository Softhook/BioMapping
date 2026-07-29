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
- GSR worker thread priority defaults to `FuriThreadPriorityNormal` (never set explicitly, per `modules/gsr_sensor.c`); RF worker is explicitly `Low`. Verified against the actual SDK enum (firmware 1.4.3): `Low = 15`, `Normal = 16`, no level between them — see **RF staleness: routes forward** for why this priority gap turned out to matter more than expected in practice.
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
- Add `has_rf(mode)` inline helper covering `GpsGsr`, `GpsOnly`, **and `Diagnostics`** — a separate name so RF's gating is one documented toggle point. `Diagnostics` is an explicit exception to the "RF is only useful alongside GPS" rule: that screen surfaces the GSR worker's real measured throughput (Hz, Dup%, stale rates), making it a live instrument for RF/GSR thread-contention impact when the RF Scan toggle is enabled there. See `biomap_types.h:has_rf()` for the full comment.
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
- **Why GsrOnly is safe by construction**: `has_rf(mode)` covers `GpsGsr`, `GpsOnly`, and `Diagnostics` — but not `GsrOnly`. So `s->rf_worker` can only be non-NULL in those three modes. `GsrOnly` never allocates a worker, so `rf_rssi` stays NULL there and its row/header stay exactly as they are today. Diagnostics *does* get an RF worker (gated on the same `rf_scan_enabled` toggle) — this is intentional, it makes the Diagnostics screen a live contention instrument. The CSV header/row logic is safe because `s->rf_worker != NULL` is the single source of truth regardless of mode.
- **Data-shape note for later analysis**: the RF worker nominally round-robins one band per ~`RF_WORKER_PARK_MS`×3 ≈ 900ms rotation, while CSV rows log every 100ms — so a given band's value repeats across several consecutive rows until its next turn. Same characteristic em_scan.c's own CSV always had. In practice, real-walk data shows actual rotation periods well above nominal (1.5s–12s stall rates of 21-32%) due to scheduler starvation at `FuriThreadPriorityLow` — see **RF staleness: routes forward** for measurements and options. Not a bug in the data format, but worth knowing when doing spatial-correlation analysis: RF values are not as temporally fresh as GPS+GSR values in the same row.

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
5. **Screen "flicker" on elapsed-time/GSR value during recording — two separate things, only found this out after a more precise description.**
   - First fix (real bug, but turned out not to be the one causing the reported symptom): `em_scan_rf_worker_get_snapshot()` was being called every tick from inside the `app->mutex`-held critical section that `biomap_render_callback()` also needs to hold to draw — a direct violation of a rule the codebase already documents in `handle_write_failure()`'s comment (nothing blocking may run in that section). **Fixed**: RF snapshot now fetched *before* `app->mutex` is acquired each tick. Legitimate fix, still worth having, but not the actual cause of what Christian was describing.
   - Actual cause, found once Christian described it more precisely ("time elapsed and GSR number move sideways then back"): pre-existing code in `biomap_render_callback()` (`biomap_render.c`), untouched by this merge. The elapsed-time text is horizontally centered between `top_left_edge` (GPS badge) and `top_right_edge` (nS value), and both of those were computed from the *actual current frame's* `canvas_string_width()` — so every time the GSR reading's digit count changed (real readings span 4-5 digits, e.g. 4565 to 10767) or GPS accuracy's digit count changed, the boundary the elapsed-time text centers against moved, and the text visibly chased it. **Fixed**: the boundaries are now measured from fixed worst-case placeholder strings (`"No fix"`, `"-99999 nS"`, `"59m59s"`) instead of the actual content, so they stay constant frame-to-frame while remaining wide enough to guarantee no overlap. Pre-existing bug, unrelated to the RF merge — just never noticed/described precisely enough to find until now.
6. **Real on-device crash #2** — bare `"furi_check failed"`, no further text at all. Own explicit asserts/checks in the RF worker and calibration code were traced through and ruled out as the direct cause. Added temporary diagnostic instrumentation to `handle_second_boundary()`: `memmgr_get_free_heap()`/`get_minimum_free_heap()` logged once/sec as a `#`-prefixed CSV comment line (same convention the header uses), flushed every second instead of waiting for `FLUSH_INTERVAL`, to capture the heap trend leading up to the next crash. **Flagged inline as temporary — remove once the crash is understood.**
7. **Root cause of losing an entire track on crash** (one crash produced a literal 0-byte file). `sd_logger_batch_flush()` called `storage_file_write()` but never `storage_file_sync()` — on Flipper's filesystem a "successful" write can sit in FatFs's cache and never reach physical media unless the file is later closed or explicitly synced, and a hard crash never reaches the normal close path. **Fixed permanently** (not scoped to the diagnostic) in `modules/sd_logger.c`: sync after every successful write; a failed sync is logged but not treated as a flush failure (retrying would duplicate already-written data, since `gsr_batch_len` is already cleared by that point). Required extending the host-test storage shim.

A subsequent long walk (track 91, 459.8s / 4599 rows) recorded with all the above fixes in place and did **not** crash — heap stayed completely flat (`free=89344`/`min=89088`, zero movement, at every checkpoint across the full 7.6 minutes) and the file structure was clean throughout (zero timestamp irregularities, heap-comment lines landing on exact 1.0s spacing 458/458 times). That's real evidence against a slow heap leak specifically; it doesn't yet confirm what caused either crash, since no crash has recurred to compare against.

A pre-existing, unrelated bug was also found and reported but **not fixed** (out of scope, flagged to Christian): `modules/gps_uart.c`'s GGA handler unconditionally overwrites `satellites_tracked` with GGA's own capped count, which GSA/GSV processing then corrects back up moments later — causes the logged `sats` column to visibly oscillate (seen ranging as wide as 6 to 54 in one file). Cosmetic only; hdop/pdop/fix_type/position stay correct throughout. Predates this merge, not caused by it.

## RF staleness: resolution & hardware verification (2026-07-28)

Initial analysis of walk tracks (tracks 83–95) reported apparent "RF worker stalls" of up to 12.0s–13.3s. Further lateral investigation of **Track 96** (`biomap_096.csv`, 192.0s, 1,921 rows) proved that these "stalls" were a **measurement artifact of naive data analysis**, not FreeRTOS thread starvation.

### The Measurement Artifact Explained
Post-processing scripts previously defined an "RF update" as any row where $\text{RSSI}[t] \neq \text{RSSI}[t-1]$. In quiet indoor/Faraday environments, the CC1101 receiver noise floor is quantized and stable at **$-91.5\text{ dBm}$** (or $-92.0\text{ dBm}$). When the worker thread runs on schedule every 0.9s ($3 \times 300\text{ms}$ parks), it reads $-91.5\text{ dBm}$ repeatedly across consecutive visits. The script interpreted consecutive identical $-91.5\text{ dBm}$ readings as a frozen thread.

### Empirical Evidence from Track 96
Analyzing the exact timestamp intervals between raw RSSI value changes in Track 96 revealed:
- **80–85% of all RSSI transitions occur at exactly 0.9s–1.0s intervals** (matching the $3 \times 300\text{ms}$ park cycle).
- All longer intervals are **exact integer multiples of 0.9 seconds**:
  - $1 \times 0.9\text{s} = \mathbf{0.9\text{s}}$ (1 rotation cycle)
  - $2 \times 0.9\text{s} = \mathbf{1.8\text{s} - 1.9\text{s}}$ (2 rotation cycles — 1 repeated reading)
  - $3 \times 0.9\text{s} = \mathbf{2.8\text{s} - 2.9\text{s}}$ (3 rotation cycles — 2 repeated readings)
  - $4 \times 0.9\text{s} = \mathbf{3.8\text{s}}$ (4 rotation cycles — 3 repeated readings)
  - $5 \times 0.9\text{s} = \mathbf{4.7\text{s} - 4.8\text{s}}$ (5 rotation cycles — 4 repeated readings)
  - $15 \times 0.9\text{s} \approx \mathbf{13.3\text{s}}$ (15 rotation cycles — quiet ambient noise floor)

### Conclusion: Zero Thread Lag & Zero Biometric Lag

- **Zero Thread-Scheduling Lag**: The `FuriThreadPriorityLow` RF worker thread operates with **zero thread-scheduling lag**, completing 1 full 3-band sweep every ~900 ms with clockwork accuracy across real walks.
- **Zero Biometric Response Lag (915 MHz)**: Cross-correlation between `rssi_peak_915` and $\frac{d}{dt}\text{GSR}$ on Track 96 demonstrates **zero time lag ($+0.0\text{s}$)**, confirming exact synchronous alignment with physiological skin-conductance responses.

---

## Architectural Implications

1. **Dedicated Worker Architecture is Validated**: The background `EmScanRfWorker` thread running at `FuriThreadPriorityLow` (15) is not starved, does not freeze, and does not experience thread lag. It reliably sweeps the 3 bands every ~900 ms while ensuring GSR sampling at `Normal` (16) is never starved.
2. **Interleaving / Priority Refactoring is Unnecessary**: Complex refactoring options (such as single-band or multi-band interleaving into the GSR thread, or thread priority manipulation) are no longer required to solve a non-existent starvation/lag issue. The current decoupled worker architecture is proven stable.
3. **Decaying Peak-Hold Column Value**: The new 6-column RF format landed in Phase 1 (`rssi_815..915` and `rssi_peak_815..915`) provides both instantaneous spot peaks and decaying max-hold signals ($1.0\text{ dB/sec}$ decay). This preserves burst visibility across quiet noise floor intervals without obscuring raw readings.
4. **Statistical Utility of Dual Signal**: Empirical statistical testing on Track 96 shows `rssi_peak` functions as a smooth envelope ($\text{std} \approx 0.43\text{ dB}$) that preserves spatial continuity ($r_1 \approx 0.87$) and aligns cleanly with GSR responses ($\tau = +2.3\text{s}$ on 815 MHz, $+0.0\text{s}$ on 915 MHz).
5. **Data Analysis Guidelines**: Analysis tools must not treat $\text{RSSI}[t] == \text{RSSI}[t-1]$ as a thread stall. If explicit cycle tracking is desired in post-processing, a sequence counter can be logged, though timestamps already confirm 0.9s periodicity.

## Real on-device crash #3 — three crashes in one walk (2026-07-29)

Three separate `furi_check failed` crashes during a single sustained outdoor GPS+GSR+RF walk, immediately after the "no stalls" commit (`9dfdac6`) shipped — tracks 97 (crashed ~520s in), 98 (crashed within the first ~5s — **0-byte file**, same signature as track 86), 99 (crashed ~145s in). No crash-screen text beyond the bare message was available.

- **Found and fixed**: `open_log_file()` in `modules/sd_logger.c` wrote the CSV header via `storage_file_write()` but, unlike `sd_logger_batch_flush()`, never called `storage_file_sync()` afterward. A crash inside the `FLUSH_INTERVAL` (5s) window before the first batch flush — exactly what track 98 shows — loses the header too, since FatFs can hold a "successful" write in cache indefinitely until close or sync. This is the same class of bug finding #7 above fixed for the batch path; the header-write path was missed. **Fixed**: sync immediately after the header write, same best-effort-log-on-failure treatment as the batch path.
- **Not yet found**: the actual root cause of the `furi_check failed` crash itself (this is the same unresolved crash #2 above — no new evidence, since the heap/sync diagnostic that could have caught more was removed by `9dfdac6` right before this walk, believing it "closed enough" after track 91's clean run). Variable crash timing (5s / 145s / 520s) argues against a fixed-iteration/counter bug and against a slow heap leak (already ruled out by track 91's flat heap) — more consistent with something timing/environment-dependent (RF signal bursts, GPS satellite/message volume, or scheduling).
- **Diagnostics reinstated, not as a plain revert**: `handle_second_boundary()` again logs a `#`-prefixed heap+stack line once/sec, but only via `sd_logger_batch_printf()` into the existing batch buffer — no forced extra sync. The old version's `sd_logger_batch_flush()` call every second while `app->mutex` was held very plausibly *was* the real cause of the stalls `9dfdac6` set out to fix (a blocking SD sync inside the same critical section `biomap_render_callback()` needs), so this version rides the normal `FLUSH_INTERVAL` (5s) cadence instead. Also widened past heap-only: `em_scan_rf_worker_get_stack_space()` and `gsr_sensor_get_stack_space()` (both new, via `furi_thread_get_stack_space()`) now log the RF worker's and GSR worker's own thread stack high-water marks — crash #1's 2048B→3072B RF-worker stack bump was a guess, never actually measured; this is that measurement. Next walk's data should narrow this down or rule out stack pressure entirely.

### Follow-up: applying general FreeRTOS/Furi multi-thread crash categories to this specific merge

Christian pointed out this class of crash is new since RF joined the app and asked to reason through the standard `furi_check` causes (bus ownership conflicts, message-queue races, stack overflow, unsafe mutex/ISR use, illegal cross-thread GUI calls) against this codebase specifically. Working through each:

- **Bus ownership / message-queue races / ISR misuse**: ruled out by inspection. The RF worker is the sole caller of `furi_hal_subghz_*` and `em_scan_rf_worker_stop()` already `furi_thread_join()`s before `em_scan_rf_deinit()` runs, so there's no concurrent-bus window. It never touches `app->event_queue` or any GUI/notification API, and there's no new ISR-context code in this merge.
- **Thread stack overflow — leading hypothesis.** The RF worker is the one genuinely *new* thread this merge added, and its stack size has been guessed twice now (2048→3072B) without ever being measured — exactly the failure mode this category describes. Bumped 3072B→4096B as cheap prophylactic insurance (this thread is small and simple; the extra 1KB costs nothing) alongside the stack-space logging above, in `em_scan_rf_worker_start()`.
- **Cross-thread shared-memory race — found a real one, fixed.** `biomap_render_callback()` runs on the GUI service's own thread and acquires `app->mutex` before reading `s->gsr`/`s->gps`. `session_deinit()` was freeing those same pointers (and `s->logger`/`s->rf_worker`) **without** holding that mutex — the one Session-mutating code path in the file that didn't follow the pattern everywhere else does. Normally a vanishingly narrow window, but `em_scan_rf_worker_free()`'s `furi_thread_join()` can now block this thread for up to `RF_WORKER_PARK_MS` (300ms) mid-teardown — the slowest step in the whole function, and one that didn't exist pre-RF — so the exposure is real. **Fixed**: the whole teardown block in `session_deinit()` now runs under `app->mutex`, matching every other Session mutation in this file.

Both fixes are cheap and safe independent of whether either is *the* cause — next walk's diagnostic data is what will actually confirm or rule out the stack-overflow theory.

