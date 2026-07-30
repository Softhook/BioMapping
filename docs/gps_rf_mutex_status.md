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

## Other open items

Ranked by what would most change confidence in this fix, not by effort.

1. **`session_deinit()` still holds `app->mutex` across the entire
   `gsr_sensor_free()` call, including `furi_thread_join()`**
   (`biomap_session.c`). If the worker is ever wedged in the unbounded SPI
   busy-wait *during teardown*, the GUI thread stalls too. Pre-existing
   (the join-inside-`app->mutex` pattern predates this fix), narrower in
   blast radius than the original bug (a ~1-2s teardown window, not the
   whole active recording), and explicitly deferred earlier in this
   review with the user's agreement. **Real fix, not yet done**: null
   `s->logger`/`s->gsr`/`s->gps` under `app->mutex`, release the mutex,
   *then* call the `_free()` functions on locally-saved copies — mirrors
   the pattern the Tick handler already uses for SD flush.
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
