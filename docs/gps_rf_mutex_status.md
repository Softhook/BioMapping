# GPS-quality / GSR-RF mutex fix — status

> **Living document.** Update as remaining items are closed or new ones are
> found. Referenced from: `modules/gsr_sensor.c`, `tests/test_gsr_sensor.c`,
> `run_tests.sh`.

## The bug this was about

Track 112 (and others recorded after the "only 2 threads" merge, `069e505`)
showed degraded GPS quality — mean `hacc_m` measurably worse than the
cleanest pre-merge RF walk — despite the Flipper's live on-screen accuracy
reading looking fine. Root cause, traced in full earlier in this
investigation:

- `gsr_sensor_worker()`'s RF section ran its SPI retune (`em_scan_rf_set_band()`,
  four chained CC1101 transactions) **while holding `gsr->mutex`** — the same
  mutex the main thread needed every tick, via `gsr_sensor_get_rf_snapshot()`
  and every other GSR accessor.
- CC1101 SPI transactions bottom out in `furi_hal_spi_bus_end_txrx()`, which
  has a **documented, firmware-level, unbounded busy-wait** (`UNUSED(timeout); // FIXME`
  in stock and Momentum firmware alike — see `em_scan/em_scan_rf_crash_investigation.md`).
- `EventTypeTick` and `EventTypeUart` share one FreeRTOS queue drained by the
  main thread. Any stall in Tick processing (blocked on `gsr->mutex`) delayed
  draining the next queued UART event — degrading NMEA parsing timing without
  ever showing a bad number on the live screen, which just displays whatever
  status was freshest at the instant you glanced at it.

## Is it fully resolved?

**The mechanism that caused it — RF's SPI work sharing a mutex the main
thread needs every tick — is fixed and verified. A real on-device walk to
confirm the *end-to-end* GPS track quality improvement has not been done in
this conversation; see "What is NOT yet confirmed" below before calling this
fully closed.**

### What was fixed

1. **Split into two mutexes** (`modules/gsr_sensor.c`): `mutex` guards the ADC
   ring buffer/PGA/calibration state; `rf_mutex` guards only the 3-float RF
   snapshot. Neither is ever held across a `furi_hal_i2c_*`/`furi_hal_subghz_*`
   call — confirmed by direct code trace, not just by convention.
2. **RF sampling paced to ~10 Hz** (`RF_SAMPLE_INTERVAL_MS`) instead of every
   ADC iteration, and dwell extended to 3s (`RF_DWELL_MS`) — cuts how often
   the app ever touches the buggy SPI path at all, the only mitigation
   available for a bug that lives in firmware this app can't patch.
3. **`biomap_session.c`'s Tick handler** no longer special-cases fetching the
   RF snapshot before `app->mutex` — that inconsistency (same call nested
   under `app->mutex` in the render callback but fetched before it in the
   Tick handler) was itself a symptom of the underlying coupling. Now both
   callers treat it the same way, safely.
4. **A second, independent bug found during review and fixed**: 11
   diagnostics accessors (`gsr_sensor_get_worker_hz()` etc.) were reading
   fields under a false "same thread as `tick()`" assumption — their only
   real caller is the GUI render thread. Added `gsr->mutex` protection to
   both the reads and the two write-back sites in `tick()` that were
   missing it.
5. **A TOCTOU gap found in the fix itself, then fixed**: the RF-disable path
   originally just polled a `rf_spi_busy` flag with a fixed delay; a plain
   flag read left a narrow window where disable could race an in-flight SPI
   call. Fixed by making the worker's "decide to sample, then mark busy"
   step share `rf_mutex` with disable's rendezvous, converting it from "very
   unlikely to race" to "provably ordered."
6. **Three flags converted from `volatile bool` to `_Atomic bool`**
   (`running`, `rf_enabled`, `rf_spi_busy`) after a ThreadSanitizer run
   found they were genuine data races per the C11 memory model — "single-core
   ARM, probably fine" was an assumption, not a guarantee. Costs nothing at
   runtime; makes the guarantee real.

### Verification performed

- **ThreadSanitizer**: 0 races, 10+ consecutive clean runs, including a
  stress test (`test_rf_enable_disable_stress_no_race`, 200 rapid
  enable/disable cycles with no delay) specifically built to maximize the
  chance of exposing the TOCTOU-class race if it ever recurs.
- **Direct regression tests** for the actual bug mechanism:
  `test_rf_snapshot_read_not_blocked_by_slow_spi_call` and
  `test_gsr_path_not_blocked_by_slow_rf_spi_call` use a mocked, artificially
  slow (150ms) SPI call to prove `gsr_sensor_get_rf_snapshot()` and
  `gsr_sensor_tick()`/`get_raw()` stay under 20ms regardless — **this is
  the test that would have failed outright against the original,
  pre-split code.**
- Real ARM toolchain compile (`-Wall -Wextra -Werror`, actual Flipper SDK
  headers): clean on every touched file.
- Full host test suite (`./run_tests.sh`): passing, run repeatedly for
  stability, not just once.

### What is NOT yet confirmed

- **No new on-device GPS+RF walk has been recorded and analyzed against
  this fix.** Everything above verifies the *mechanism* (no mutex held
  across SPI, no thread blocks on another's hardware call) in isolation, on
  a host compiler, with mocked hardware. It does not by itself prove the
  *original symptom* (elevated `hacc_m`, track-112-style degradation) is
  gone on a real device in real conditions. The original diagnosis was built
  by analyzing real recorded tracks (099 vs 112) — closing the loop means
  doing the same comparison on a track recorded with this fix in place.
  **This is the single most important remaining step before calling the bug
  closed, not just the mechanism fixed.**
- A `python3 -m ufbt launch` build was started manually mid-session; no
  result was reported back in this conversation, so it isn't known whether
  that build succeeded or what it showed on hardware.

### 2026-07-31: track 113 recorded with the fix — inconclusive, not closed

Track 113 was recorded on-device with this fix in place and analyzed
against 112 (pre-fix) and 099 (pre-merge baseline). Result: **did not
confirm the fix, but didn't contradict it either** — the CSV data available
at the time couldn't distinguish "no contention occurred" from "contention
occurred but left no CSV-visible trace."

- `hacc_m` did not improve: 113 mean 1.20m / median 1.10m vs 112's
  1.14m / 1.00m — statistically no better, arguably marginally worse. 099's
  0.82m mean turned out to be a confounded comparison, not a clean
  baseline: it was recorded at a different site with ~31 mean satellites
  tracked vs 112/113's ~17, so its better numbers are likely site geometry,
  not code.
- 113 had one real ~7s total GPS fix loss (t=169–176s) plus a rough patch
  of elevated PDOP (up to 18.9) and low sat count (down to 6), but *only*
  in the first ~200s of an 1130s walk — after that it's clean/comparable to
  112 for the rest of the walk. Concentrated-then-clean is more consistent
  with an environmental cause (obstruction at the start point) than a
  recurring software stall, but this is circumstantial, not proof.
- No corrupted/teleporting positions, no abnormal frozen-position runs, and
  `gsr_raw` (real ADC worker output) changed on essentially every tick in
  both 112 and 113 (mean run length 1.00, zero runs ≥1s) — no footprint of
  a worker/main-thread stall by this proxy either.
- **The real blocker**: the CSV `timestamp` column is `total_ticks/10` — a
  sequence counter, not a wall-clock capture. It would look identical
  ("perfectly uniform 0.1s spacing") whether the main loop ran in real time
  or stalled and caught up in a burst. None of the above evidence is a
  direct measurement of contention; it's all inference.

**Fix**: added four real, measured diagnostic CSV columns (`tick_dt_ms`,
`gps_rx_drops`, `nmea_fail`, `gsr_hz`) so the next recording can answer this
directly instead of by inference — see `biomap_types.h`'s `RowDiag` doc
comment, `modules/gps_uart.h`'s doc comments on the two new accessors, and
`biomap_session.c`'s `format_gps_csv_row`/`get_row_diag`. Verified: real ARM
toolchain build (`-Wall -Wextra -Werror`) clean, full host test suite
passing including new `test_nmea_fail_counter`/`test_rx_stream_drop_counter`
in `tests/test_gps_uart.c` and updated `test_csv_formatting` in
`tests/test_firmware.c`.

**Still needed, not done in this session**: an actual recording with these
fields. A normal walk risks being clean by luck rather than by proof, since
RF's 10Hz/3s-dwell pacing already minimizes SPI exposure — the
recommended test is a same-session, same-route **RF-off vs RF-on A/B**
recording (`gsr_sensor_set_rf_enabled()` already supports this), ideally
with RF's dwell/pacing temporarily shortened on the RF-on leg to stress the
SPI path rather than hope a casual walk happens to hit it. Until that
exists, this bug stays open per the note at the top of this section.

### 2026-08-03: track 116 recorded, real stalls found — added per-call attribution columns

Track 116 (1824s, RF on throughout) recorded three real `tick_dt_ms`
spikes (216ms, 789ms, and a 957ms stall with `gps_rx_drops` jumping 0→102
in the same row) — the direct evidence the "still needed" step above was
asking for. But `tick_dt_ms` alone can't say which of the worker thread's
three candidate blocking calls (I2C read/write, RF RSSI poll, RF band
retune) actually caused it — only that *something* on that thread did.

Added three more `RowDiag` columns for exactly that: `i2c_peak_ms`,
`rf_rssi_peak_ms`, `rf_retune_peak_ms` (`biomap_types.h`, populated in
`biomap_session.c`'s `get_row_diag()`, sourced from new lifetime-max
counters in `gsr_sensor.c` timed with `furi_get_tick()` immediately around
each of the four call sites — see `gsr_sensor.h`'s
`gsr_sensor_get_i2c_peak_ms()`/`_rf_rssi_peak_ms()`/`_rf_retune_peak_ms()`
doc comments). `i2c_peak_ms` covers both I2C call sites (routine read and
the rarer PGA-change config write), since the two never happen in the same
loop iteration.

Covered by three new host tests (`tests/test_gsr_sensor.c`) mirroring the
existing slow-SPI-call tests: each injects a real delay into exactly one
of the three underlying mock calls and asserts both that the matching
column reports it and that the other two stay near zero — proving
discrimination, not just detection. Required adding delay-injection mocks
for I2C and `em_scan_rf_set_band()` (`tests/shims/furi_hal_mock.c`) — only
the RF RSSI mock had one before. Real-recording verification (does one of
these light up on the next long walk, and does it point at retune the
occurrence-rate argument favored) is still outstanding — that's the actual
close-out step, not the columns existing.

## Other open items

Ranked by what would most change confidence in this fix, not by effort.

1. **[RESOLVED 2026-07-30] `session_deinit()` held `app->mutex` across `gsr_sensor_free()`**
   (`biomap_session.c`). This was fixed by copying `s->logger`, `s->gsr`, and `s->gps` to local pointers and clearing them in the `Session` struct under `app->mutex`, then releasing `app->mutex` before executing the blocking `_free()` functions. This prevents the GUI thread from blocking on `app->mutex` if the worker thread takes time to join during teardown.
1a. **[RESOLVED 2026-07-31] `run_cal_submenu()`'s `selection` was an unguarded
   cross-thread `int`** (`biomap_gui.c`/`biomap_render.c`). Same bug class as
   #2 below (a stack-local read by `draw_cal_submenu()` on the GUI render
   thread while the main thread's key-handling loop writes it) but in the
   shared GSR/RF calibration submenu, missed by both the 2026-07-29 and
   2026-07-30 audits since `WizardState`/`RfCalWizardState` covered the
   *wizard* screens, not this submenu. Unlike those two (which have no
   `BioMapApp*` and so needed their own dedicated mutex), this one is now a
   `CalSubmenuContext {app, selection}` (`biomap.h`) guarded by the existing
   `app->mutex`, matching `MenuContext`/`OptionsContext`'s established
   pattern. Verified: real ARM toolchain build (`-Wall -Wextra -Werror`)
   clean, full host test suite passing (this code path isn't exercised by
   the host harness — no `Canvas`/`ViewPort` mocks — so this is a build/
   regression check, not new coverage).
2. **`WizardState`'s mutex fix (GSR calibration wizard) has zero test
   coverage.** It lives in `biomap_gui.c`/`biomap_render.c`, which need
   real Flipper `Canvas`/`ViewPort` types this host-test harness doesn't
   mock. The fix itself was verified by code review (every write site now
   locked, matching `RfCalWizardState`'s already-proven pattern), not by
   an automated test.
3. **The TOCTOU-gap stress test increases confidence but doesn't formally
   prove absence of the race.** A deterministic proof would need a
   test-only synchronization hook inside `gsr_sensor_worker()` itself
   (to pause it exactly between reading `rf_enabled` and setting
   `rf_spi_busy`) — that's production-code instrumentation purely for
   testability, not added, and worth a deliberate decision before adding.
4. **No test proves a slow/stuck I2C call doesn't block RF's snapshot
   read** (the reverse direction of the two tests that do exist). Lower
   priority: I2C was never part of the reported bug, and it's already
   structurally unprotected by any RF-related mutex — this is a coverage
   gap, not a known or suspected defect.
5. **The underlying firmware SPI busy-wait itself is not fixable from
   this app.** `furi_hal_spi_bus_end_txrx()` (stock and Momentum firmware,
   confirmed byte-identical) discards its `timeout` parameter. Reducing
   exposure (10 Hz RF pacing) is the only lever available from app code —
   this is a permanent, accepted risk, not a to-do item.
6. **Cosmetic, optional**: `gsr->available` is set `true` unconditionally
   at alloc (right after a `furi_check` that would already have aborted on
   allocation failure) and never set `false` anywhere — every
   `if(!gsr->available) return;` guard in every accessor is dead code.
   Not a bug; removing it means touching ~20 call sites plus the public
   `gsr_sensor_available()` API for zero behavior change. Left alone
   deliberately.
