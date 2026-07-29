# RF-mode crash investigation (2026-07-29)

Three separate `furi_check failed` crashes during one sustained outdoor
GPS+GSR+RF walk — tracks 97, 98, 99. This is the same still-unresolved
crash class already logged in `em_scan_biomap_merge_plan.md` as "Real
on-device crash #2" (bare `furi_check failed`, no further detail), now
recurring with a possible new lead. This doc is the focused, standalone
record of that specific investigation thread — see
`em_scan_biomap_merge_plan.md` for the broader Phase 1+2 merge history.

## Timeline of this walk

| Track | Duration before crash | File signature | Notes |
|---|---|---|---|
| 97 | 519.9s (~8.7 min) | Full data, ends abruptly | `rssi_815` elevated at -80 to -82 dBm continuously for the last several minutes, right up to the last row |
| 98 | ~0-5s | **0 bytes** — no header, no data | Crashed before the first batch flush |
| 99 | 144.9s (~2.4 min) | Full data, ends abruptly | `rssi_868` jumps -101.5 → -92.5 dBm in the last two logged rows (144.70→144.80s), right before the crash |

Prior context: track 91 (459.8s, GPS+GSR+RF, heap-logging diagnostic
active) completed cleanly with a flat heap — the diagnostic was removed in
commit `9dfdac6` ("no stalls") right before this walk, so this walk
produced no new diagnostic evidence of its own beyond what's in the CSVs
already.

## Fixes applied this session

1. **`modules/sd_logger.c` — header write wasn't synced.** `open_log_file()`
   wrote the CSV header via `storage_file_write()` but never called
   `storage_file_sync()` afterward (unlike `sd_logger_batch_flush()`, which
   already had this fix for the same reason — see merge-plan finding #7).
   A crash within the first `FLUSH_INTERVAL` (5s) of recording — exactly
   what track 98 shows — loses the header too, since FatFs can hold a
   "successful" write in cache indefinitely until close or sync. **Fixed**:
   sync immediately after the header write, same best-effort/log-on-failure
   treatment as the batch path.

2. **Diagnostics reinstated, redesigned to avoid the previous stall.**
   `handle_second_boundary()` (`biomap_session.c`) again logs a
   `#`-prefixed line once/sec during recording — heap free/min plus two new
   stack high-water-mark getters:
   - `em_scan_rf_worker_get_stack_space()` (`em_scan_rf_worker.c/.h`)
   - `gsr_sensor_get_stack_space()` (`modules/gsr_sensor.c/.h`)

   Unlike the old (removed) version, this only appends to the existing SD
   batch buffer via `sd_logger_batch_printf()` — no forced extra
   `sd_logger_batch_flush()`/sync every second. The old version's forced
   sync, called every second while `app->mutex` was held, very plausibly
   *was* the real cause of the UI stalls `9dfdac6` set out to fix (a
   blocking SD sync inside the same critical section
   `biomap_render_callback()` needs to draw). This version rides the normal
   5s `FLUSH_INTERVAL` cadence instead, so it can't reintroduce that.

3. **RF worker stack bumped 3072B → 4096B** (`em_scan_rf_worker.c`,
   `em_scan_rf_worker_start()`). Cheap prophylactic insurance — this thread
   is the one genuinely new thread the RF merge introduced, and its stack
   size has been guessed twice now (2048→3072→4096) without ever being
   measured. The new stack-space diagnostic above is what will actually
   measure it on the next walk.

4. **`session_deinit()` (`biomap_session.c`) now holds `app->mutex` across
   its whole teardown block.** `biomap_render_callback()` runs on the GUI
   service's own thread and acquires `app->mutex` before reading
   `s->gsr`/`s->gps`; every other Session mutation in this file already
   held that mutex for exactly this reason, but teardown didn't. Normally a
   vanishingly narrow window, but `em_scan_rf_worker_free()`'s
   `furi_thread_join()` can block this thread for up to
   `RF_WORKER_PARK_MS` (300ms) mid-teardown — the slowest step in the whole
   function, and one that didn't exist before RF joined the app. Fixed for
   correctness regardless of whether it explains this crash.

5. **RF calibration wizard race (separate bug, not crash-related).**
   Forensic sweep of all cross-thread state found `RfCalWizardState`
   (`biomap_rf_cal.c`'s `run_rf_calibration_wizard()`) was read by the GUI
   thread (`rf_calibration_wizard_*_render` in `biomap_render.c`) with
   **zero synchronization**, while the main thread rewrote
   `rssi_dbm[]`/`seconds_left` every ~100ms in the sampling loop. Real,
   confirmed race — but cosmetic (garbled displayed numbers, no
   pointers/heap involved) and not exercised during a recording walk (RF
   worker isn't even running during this wizard). **Fixed**: added
   `w.mutex` to `RfCalWizardState` (`biomap.h`), guarding every write
   (`biomap_rf_cal.c`) and every read (`biomap_render.c`, snapshotted under
   the lock before drawing).

All host tests (`./run_tests.sh`, 81 assertions) pass after these changes.
Note: `biomap.h`/`biomap_rf_cal.c`/`biomap_render.c` aren't part of the
host test harness (ARM-only, no `ufbt` toolchain available here) — verified
by hand (brace balance, exit-path tracing for the new mutex alloc/free).

## Forensic cross-thread audit (full results)

Threads in this app: main app thread, GSR worker (I2C), RF worker (subghz),
GUI service render thread, GPS UART ISR, Furi timer daemon (only posts Tick
events).

**Clean, single conduit confirmed:**
- `EmScanRfWorker` → `w->mutex` guards `rssi_dbm`/`peak_hold_dbm`/`running`.
- `GpsUart` → `status_mutex` guards `GpsStatus`; the ISR only touches
  lock-free primitives (stream buffer, a `volatile bool`, the message
  queue) — never the parsed status fields directly.
- `GsrSensor` → `gsr->mutex` guards the sensor's "live" cross-thread state
  (buffer, counters, connected, raw, PGA state, cal state).
- `Session`/`BioMapApp` → `app->mutex` guards everything, consistently, on
  both the write (main thread) and read (GUI thread) sides — recording
  screen, menu, options, calibration-summary screens, and now
  `session_deinit()`.
- Swept every source file for hidden shared `static` locals — found only
  two mutable ones (`biomap_rf_cal.c`'s `samples[][]`,
  `biomap_session.c`'s CSV `row[300]`), both already correctly documented
  and verified main-thread-only.

**Fragile but currently safe:** `GsrSensor`'s "tick-only, no mutex needed"
diagnostic fields (`worker_hz_cached`, `duplicate_rate_cached`, etc.) are
documented in `gsr_sensor.c` as single-thread (main-thread) only, but
`biomap_render.c`'s Diagnostics screen actually reads them from the GUI
thread. Safe today only because both sides happen to hold `app->mutex` — a
different mutex than `gsr->mutex`, a fact `gsr_sensor.c` has no way to
enforce or even see. Not a live bug; a latent trap if anything ever reads
these without holding `app->mutex`. Not fixed — flagging for awareness.

**Confirmed and fixed:** the RF calibration wizard race (see item 5 above).

## The RF-signal correlation (the actual new lead)

Christian noticed the crashes happened in a geographic area where 815 MHz
activity was detected, and asked whether real RF detection changes
anything (voltage spikes, data volume, new access). Checked the recovered
CSVs directly:

- **Track 97**: `rssi_815` sustained at -80 to -82 dBm for the last several
  minutes before the crash — well above the ~-91.5 to -101 dBm quiet floor
  documented elsewhere in the project's notes.
- **Track 99**: `rssi_868` jumps -101.5 → -92.5 dBm in the literal last two
  rows before the crash — a fresh detection event landing right at the
  boundary.

Both crashes coincide with an actively elevated signal on one of the three
monitored bands, not the quiet ambient floor every prior clean walk (track
91, track 96) was measured against. This is a real, data-backed
correlation — the strongest lead so far, better than anything found by
reading the code in isolation.

**Ruled out in application code**: nothing in `em_scan_rf_park_band()` or
the CSV/peak-hold logic branches on RSSI *value*. Polling is on a fixed
timer regardless of what's read; peak-hold is a plain float compare;
`%.1f` CSV formatting is actually *shorter* for extreme values, not longer
(no buffer-overflow angle).

**Hypothesis considered and disproven — GDO0/EXTI interrupt storm.**
Initial theory: the async OOK preset
(`subghz_device_cc1101_preset_ook_650khz_async_regs`) causes the CC1101's
GDO0 pin to toggle at the data rate when real OOK-modulated RF is present,
and if that's wired to an MCU-side interrupt, real signal would produce
genuine ISR activity that steady noise never does — a plausible mechanism
for stack pressure that only appears under real signal.

**Verified against the real SDK headers** (`~/.ufbt/current/sdk_headers`,
cached locally) **and disproven**: `furi_hal_subghz.h` documents GPIO/timer
capture setup as happening *only* inside `furi_hal_subghz_start_async_rx()`
("Initializes GPIO and TIM2 for timings capture") and torn down only by
`furi_hal_subghz_stop_async_rx()`. Neither `em_scan_rf.c` nor
`em_scan_rf_worker.c` ever calls either function — this app only calls
`furi_hal_subghz_rx()` (a plain state-transition strobe) and polls
`furi_hal_subghz_get_rssi()`. So no EXTI, no TIM2 capture, no GDO0
interrupt callback is ever registered here, regardless of whether real RF
is in the air. The "async" in the preset's name refers to the CC1101's own
internal OOK modulation mode, not Flipper's `async_rx` API — loading the
preset doesn't implicitly wire up an MCU-side interrupt.

**A follow-up "research summary" proposing driver-level fixes was also
checked against the real headers and rejected**: it recommended
`furi_hal_subghz_acquire()`/`furi_hal_subghz_release()` (Option B) — these
functions **do not exist anywhere in the SDK** (verified by listing all 30
functions declared in `furi_hal_subghz.h`). It also internally contradicted
itself on which timer is involved (TIM2 vs. TIM17 for the same claimed
mechanism, in the same document). Given one of its two concrete proposed
fixes calls a nonexistent function, the whole document was treated as
unreliable (likely LLM-hallucinated, real symbol names stitched into a
plausible-sounding but unverified story) and **not implemented**.

## Second external review — mixed results

A follow-up audit of this document itself raised four points. Evaluated
each against the code:

1. **RAM volatility loses pre-crash diagnostic data — correct, fixed.** A
   crash wipes RAM, so anything sitting in the batch buffer since the last
   5s flush (including the diagnostic line that would explain a stack
   overflow) is lost. **Fixed**: `handle_second_boundary()`
   (`biomap_session.c`) now force-flushes immediately if either worker's
   logged stack headroom drops below 512B, instead of always waiting for
   the normal `FLUSH_INTERVAL`. Same bounded-rare-blocking-call trade-off
   already used elsewhere in this function — a stall only when things are
   already going bad is an acceptable cost.
2. **CC1101 RXFIFO_OVERFLOW — mechanism questionable, fix adopted anyway.**
   CC1101's `PKT_FORMAT` field selects FIFO-buffered vs. async-serial mode;
   they're mutually exclusive, so the async-serial preset this app uses
   should bypass FIFO buffering for RX data entirely, and this app never
   reads FIFO data anyway (only the separate, always-live RSSI register).
   So "the FIFO overflows" isn't a coherent failure mode as stated. But
   `furi_hal_subghz_flush_rx()` **is** a real SDK function, and calling it
   (right after `idle()`, before retuning) is free and can't hurt. **Added**
   to both `em_scan_rf_dwell_band()` and `em_scan_rf_park_band()` in
   `em_scan_rf.c` as cheap defensive hygiene — not because the mechanism is
   confirmed, but because there's no reason not to.
3. **GsrSensorWorker's 1024B stack — stated justification wrong, general
   point adopted anyway.** The review claimed the mains-hum DFT
   (`cosf`/`sinf`) and PGA-autoranging logic run on this thread under
   pressure. Checked `gsr_sensor_worker()` directly: it's I2C reads plus
   plain integer arithmetic, no floats at all. That DFT/autoranging logic
   is actually in `gsr_sensor_tick()`, which runs on the **main thread**
   (4096B stack), not here — the claim is factually wrong. But the
   underlying idea (this size was also never measured, same as the RF
   worker's) is fair, and bumping it is equally cheap insurance. **Bumped**
   1024B → 2048B in `gsr_sensor_alloc()` (`modules/gsr_sensor.c`), with the
   correction recorded in the code comment.
4. **GPS NMEA bursts → event/timer queue overflow → `furi_check` — doesn't
   hold up, not implemented.** `EVENT_QUEUE_DEPTH` is already 64,
   sized specifically for GPS UART bursts per an existing code comment. All
   the relevant `furi_message_queue_put()` calls (the GPS ISR's, the timer
   callback's) use a `0` (non-blocking) timeout — FreeRTOS returns an error
   code on a full non-blocking put, it doesn't assert. This mechanism isn't
   consistent with how the code actually handles a full queue.

## Bug found in the diagnostic itself (2026-07-29)

While checking whether other useful debug instrumentation should be added,
cross-referencing `furi_thread_get_stack_space()`'s real signature against
the cached SDK headers (`~/.ufbt/current/sdk_headers/f7_sdk/furi/core/thread.h`)
found that `em_scan_rf_worker_get_stack_space()` and
`gsr_sensor_get_stack_space()` (added earlier this session) were passing
the wrong handle type. The real signature is:

```c
uint32_t furi_thread_get_stack_space(FuriThreadId thread_id);
```

`FuriThreadId` is the underlying RTOS handle, obtained via
`furi_thread_get_id(FuriThread* thread)` — a distinct value from the
`FuriThread*` wrapper struct pointer itself. Both getters were passing
`w->thread`/`gsr->thread` (the `FuriThread*`) directly. Since
`FuriThreadId` is `typedef void*`, this compiled with zero warnings — C
allows any pointer to convert to `void*` silently — but it meant the stack
diagnostic added specifically to investigate this crash was reading the
watermark of the wrong handle the entire time. **Fixed** in both getters:
now call `furi_thread_get_id()` first and pass that through, with a
NULL-check per that function's own documented "NULL if not running"
behavior. Also fixed the host-test shim (`tests/shims/furi.h`) to model
the same two-handle distinction. All 81 host-test assertions still pass.

This means **any stack-space numbers in tracks logged before this fix are
not reliable** and shouldn't be used to draw conclusions — the diagnostic
wasn't measuring what it claimed to until this point.

## FURI_NDEBUG confirmed, and furi_assert() promoted to furi_check() (2026-07-29)

Checked `python3 -m ufbt launch`'s actual compiler invocations
(`.vscode/compile_commands.json`) across all 13 of this app's source
files: every single one defines `-DFURI_NDEBUG` and none defines
`-DFURI_DEBUG`. Cross-referenced against the real macro definitions in
`furi/core/check.h`:

```c
#define furi_check(...) ...          // unconditional, no #ifdef guard
#ifdef FURI_DEBUG
  #define __furi_assert(e, m) do { if(!(e)) __furi_crash(m); } while(0)
#else
  #define __furi_assert(e, m) do { ((void)(e)); ((void)(m)); } while(0)
#endif
```

Confirmed: every `furi_assert()` in this codebase — 58 total, across
`gsr_sensor.c`, `gps_uart.c`, `sd_logger.c`, `em_scan_rf_worker.c`,
`biomap.c` — has been a pure no-op on every real walk, including every
prior track (91's clean run and 97-99's crashes). None of them has ever
actually checked anything in the field. Also confirmed this app never
calls `furi_check()` directly anywhere, so the "furi_check failed" crash
text is conclusive: it's coming from inside Furi's own kernel/HAL
internals, not from anything this app's code directly triggers.

**Action taken**: promoted the asserts on the walk-relevant hot path to
`furi_check()` with descriptive messages, since these conditions should
never fail under correct operation (cost nothing extra when they don't)
and would be exactly the diagnostic signal wanted if one ever does (most
likely evidence of memory corruption from a stack overflow reaching a
struct pointer).

- `em_scan_rf_worker.c`: all 7 existing asserts promoted (alloc, start x2,
  stop, get_snapshot x2, get_stack_space), plus one brand-new check added
  on the mutex-alloc result (never checked at all before) — 8 `furi_check()`
  call sites total.
- `gsr_sensor.c`: the asserts in the 10 functions the normal
  (non-Diagnostics) walk path actually calls — `gsr_sensor_alloc()` (which
  has two separate checks: the struct malloc and its mutex alloc), `free()`,
  `is_connected()`, `get_raw()`, `get_raw_sample_ns()`,
  `get_raw_sample_count()`, `get_stack_space()`, `tick()`,
  `set_calibration()`, `set_mains_hum_enabled()` — 11 `furi_check()` call
  sites total. The remaining 14 Diagnostics-only accessors
  (`get_worker_hz()`, `get_success_rate()`, etc., plus `lock_pga()`) were
  deliberately left as plain `furi_assert()` — a normal walk never calls
  them, so promoting them wouldn't help this investigation and isn't worth
  the churn.
- `tests/shims/furi.h` updated with a `furi_check()` shim (both 1-arg and
  2-arg call forms) so the host tests still build. All 81 assertions still
  pass.

**Final tally, app-wide** (verified by direct grep, not estimated): 19 real
`furi_check()` call sites — 8 in `em_scan_rf_worker.c`, 11 in
`gsr_sensor.c`. 39 `furi_assert()` calls remain untouched: 15 in
`gsr_sensor.c` (the Diagnostics-only accessors listed above), 9 in
`sd_logger.c`, 8 in `gps_uart.c`, 7 in `biomap.c`, 1 in `em_scan.c` (the
retired standalone app, not part of the `biomap.fap` build). Those weren't
touched this pass — out of scope for this specific investigation, not
evaluated for whether they're worth promoting too.

If the next walk's crash shows one of these specific messages instead of
a bare "furi_check failed," that directly identifies which pointer/struct
was corrupted, rather than needing to infer it.

## Tracks 100-103: both leading hypotheses refuted (2026-07-29)

First real walk with the fixed stack diagnostic, the promoted `furi_check()`
calls, and the RF `flush_rx()` addition all active. Tracks 100, 101, 102
crashed; track 103 (655s) was stopped manually, no crash. Run directly from
the Flipper's own app menu (not `ufbt launch` this time — same build either
way, doesn't change anything about `FURI_NDEBUG`).

**Stack pressure — conclusively refuted.** Both worker threads' logged
stack headroom is flat and healthy across every track, crashed or not:

| Track | Duration | Outcome | RF stack free | GSR stack free |
|---|---|---|---|---|
| 100 | 178.8s | crashed | 3596/4096 B | 1660/2048 B |
| 101 | 19.9s | crashed | 3596-3604/4096 B | 1660/2048 B |
| 102 | 34.9s | crashed | 3596-3604/4096 B | 1660/2048 B |
| 103 | 655.3s | stopped manually | 3596-3604/4096 B | 1660/2048 B |

Identical numbers whether a session crashed in 20 seconds or ran clean for
655 — 20x longer than the shortest crash. Neither thread ever used more
than ~500B (RF) or ~390B (GSR) of its budget. This was the leading
hypothesis for the whole investigation, resting entirely on the fact these
sizes had only ever been guessed, never measured. Now measured, directly,
across four sessions including three crashes: it's not stack pressure on
either worker thread.

**RF-signal-elevation correlation — also refuted, more decisively than
first written up.** Track 103 passed through elevated-RF conditions
(>-85 dBm) **333 times on 815 MHz and 781 times on 915 MHz** over its 655
clean seconds, without crashing once. Track 101 crashed at floor-level RSSI
(-93.5/-91.5/-91.5 dBm) and never once saw an elevated reading anywhere in
its entire 20-second file (max across the whole file: -91.5 dBm on every
band). Track 102: identical story, max -91.5 dBm across its entire
35-second file, never elevated at all. Track 100 *did* see real elevation
during its run — 815 peaked at -72 dBm — but re-checked the timing
precisely rather than just eyeballing the tail: the elevated window ran
from t=70.4s to t=129.9s, then RSSI dropped back to floor and *stayed*
there for the next 49 seconds before the crash at t=178.8s. That's not
ambiguous (an earlier pass here called it that from only checking the last
few rows) — it's a clean non-correlation, same as 101 and 102. Across all
6 crashes now on record, only 2 (97, 99) showed elevation at the actual
crash moment; the other 4 (98 — no data, 100, 101, 102) didn't. Most likely
coincidental, not causal.

**Heap**: flat within every session (single value throughout each track,
consistent with every prior finding — no leak). **GPS fix quality**: no
common pattern across the three crashes — tracks 100 and 101 show clean,
stable fixes (steady sats/hdop, valid speed) right up to the crash; track
102 shows the known cosmetic sats-oscillation bug (18↔8↔20) in its last
~1.5s, but that doesn't appear in the other two, so it's not shared either.

**Crash timing**: 20s / 35s / 179s this round vs. 5s / 145s / 520s last
time — still no fixed-count or fixed-duration signature across either
batch.

**Crash screen text: still bare "furi_check failed," all three times.**
This is the most important negative result. None of the 19 `furi_check()`
calls promoted in `em_scan_rf_worker.c`/`gsr_sensor.c` fired — ruling out
a corrupted `w`/`gsr` pointer reaching any of those specific entry points.
Combined with the flat stack/heap, this crash is not happening at the
API-boundary checks this pass added. It's either:
1. Inside Furi's own kernel/HAL internals (a check this app doesn't
   control and can't instrument at the application level) — still the
   single most consistent explanation across everything ruled out so far.
2. Inside the RF/GSR worker threads' actual loop bodies
   (`em_scan_rf_worker_thread_fn()`, `gsr_sensor_worker()`) — neither has
   any check at all, only their wrapper API functions do, so corruption or
   a fault occurring mid-loop (e.g. during `em_scan_rf_park_band()` or the
   I2C read chain) would never touch any of the checks added this pass.
3. Somewhere never instrumented at all: **the main application thread's own
   stack has still never been measured**, despite being flagged as worth
   adding two turns ago. With both worker threads now cleared, this is the
   most likely remaining stack-related candidate, if it's stack-related at
   all.
4. Genuinely electrical/hardware (brownout, EMI) — can't be ruled in or out
   by any software diagnostic.

## Main-thread stack-space logging added (2026-07-29)

Implemented the gap flagged above: `handle_second_boundary()`
(`biomap_session.c`) now also logs the main application thread's own
stack headroom, via `furi_thread_get_stack_space(furi_thread_get_id(furi_thread_get_current()))`
— `furi_thread_get_current()` is always valid here since this function
only ever runs on the main thread itself. Diagnostic line format changed
from `# heap:free=%u min=%u stack:rf=%u gsr=%u` to
`# heap:free=%u min=%u stack:main=%u rf=%u gsr=%u` (main added first, ahead
of rf/gsr, matching call order). The low-stack force-flush safety net
(added earlier this session) now also triggers on `stack_main < 512`,
alongside the existing RF/GSR checks — same 512B coarse threshold, same
reasoning (a crash wipes RAM, so the one line that would explain a main-
thread stack issue needs to reach disk before that happens, not wait for
the normal 5s cadence).

This is the last of the three threads active during a normal walk
(main/RF/GSR) to get stack instrumentation. If the next walk still shows
all three flat and healthy, that closes out stack pressure as an
explanation entirely — for every thread this app runs, not just the two
that were originally suspected — and narrows the remaining candidates down
to: something inside Furi's own kernel/HAL internals, something inside the
RF/GSR worker loop bodies specifically (still no checks there — see the
tracks 100-103 section above), or genuinely electrical/hardware.

**Note for reading future tracks**: the diagnostic line's column order
changed this pass (`main` inserted before `rf`/`gsr`) — tracks 100-103 and
everything before them used the old 2-field `stack:rf=... gsr=...` format;
anything from this point forward uses the new 3-field
`stack:main=... rf=... gsr=...` format. Don't parse both formats with the
same fixed offsets.

## Four more theories evaluated (2026-07-29)

A follow-up proposed four detailed theories with specific test plans.
Checked each against the real SDK/code before deciding what to act on.

**Theory 1: SPI bus contention between the CC1101 (SubGHz) and the SD
card.** Claimed both share "SPI1," and that `em_scan_rf_worker`'s tight
polling loop contending with `sd_logger`'s writes could hit an internal
`furi_check()` inside `furi_hal_spi`. **Core premise is factually wrong**
— checked `furi_hal_spi_config.h` directly:

```c
/** Furi Hal Spi Bus R (Radio: CC1101, Nfc, External)*/
extern FuriHalSpiBus furi_hal_spi_bus_r;
/** Furi Hal Spi Bus D (Display, SdCard) */
extern FuriHalSpiBus furi_hal_spi_bus_d;
```

CC1101 is on bus **R**; the SD card is on bus **D**, alongside the
display — two physically separate SPI peripherals, not a shared bus. The
proposed Experiment C (a shared `app->spi_mutex` around RF and SD calls)
would be serializing access to buses that don't actually contend, so even
if it happened to make crashes stop, that wouldn't prove SPI contention —
more likely it would've coincidentally changed timing enough to dodge
something unrelated. **Not implemented.** One genuinely relevant fact did
turn up while checking this, though: `furi_hal_spi_acquire()`/`_release()`
are documented as `@warning calls furi_crash() on programming error` — a
real, confirmed crash path inside the SPI HAL, just reachable only by
misusing a *single* bus handle (e.g. double-acquire), not by the
cross-bus mechanism this theory describes. Worth remembering as a category
of remaining Furi-internal explanation, not as evidence for this specific
theory.

**Theory 2: SD card flash write/GC stalls blocking the main thread for
hundreds of ms.** Grounded in real, well-documented SD card behavior
(unlike Theory 1) and directly testable. **Implemented** (see next
section) — this is the one theory from this batch worth actually
instrumenting for. The theory's own Experiment B (remove
`storage_file_sync()` from the 5s path to see if crashes stop) was
rejected: that sync fixes a *confirmed* bug (0-byte files on crash — see
finding #7 and tracks 86/98) — removing it to test an *unconfirmed* one
means a stall-triggered crash during the test would make data loss worse
without proving anything, since the sync being tested away is also what
makes the diagnostic line itself durable. Measure first, don't remove the
safety net to go looking.

**Theory 3: Main-thread stack overflow.** Already the subject of the
previous section — Experiment A (log `stack:main`) is done. Holding off on
Experiment B (bump `application.fam`'s `stack_size` to 8KB) until there's
real data, per the same reasoning already applied to the RF worker's stack
(guessed wrong twice — 2048→3072→4096 — before being measured and shown to
never have been the problem; no reason to repeat that pattern here without
evidence first).

**Theory 4: Power rail voltage sag from combined SD write + SubGHz RX +
GPS + backlight current draw.** Can't be confirmed or refuted by anything
in this repo — it's a hardware question, not a code question. But the
proposed field experiment (backlight off, swap to a better/industrial SD
card) costs nothing and is reasonable to just try on a walk regardless of
whether it definitively "proves" the mechanism.

## SD write/sync latency instrumentation added (2026-07-29)

Implemented Theory 2's Experiment A. `modules/sd_logger.c` now times both
`storage_file_write()` and `storage_file_sync()` (in `open_log_file()`'s
header write and in `sd_logger_batch_flush()`'s batch write, using a new
`sd_logger_elapsed_ms()` helper) and tracks the **worst latency seen so
far this session** — a running max, not the latest instantaneous reading,
so a single slow flush several seconds before a crash isn't missed between
1-second diagnostic log lines. New getters `sd_logger_get_max_write_ms()`
and `sd_logger_get_max_sync_ms()` (`modules/sd_logger.h`), wired into
`handle_second_boundary()`'s diagnostic line.

**Diagnostic line format changed again**: from
`# heap:free=... min=... stack:main=... rf=... gsr=...` to
`# heap:free=... min=... stack:main=... rf=... gsr=... sd:write_ms=... sync_ms=...`.
Tracks 100-103 and everything before used the 2-field stack-only format
(see the earlier note on this); anything using the previous 3-field
stack format (added this same day, before this change) won't have the
`sd:` suffix at all. Check which format a given track uses before parsing.

Also found and fixed a build gap while wiring this up: `test_sd_logger.c`
never defined `furi_test_tick` (the host shim's backing storage for
`furi_get_tick()`) because `sd_logger.c` never called it before — linker
failed with an undefined symbol. Fixed by adding the same
`uint32_t furi_test_tick = 1;` definition `test_gps_uart.c` and
`test_gsr_sensor.c` already use for the same reason. All 81 host-test
assertions pass.

**Separately noted**: `modules/sd_logger.c`'s `furi_assert()` calls have
also been promoted to `furi_check()` (all 9 of them), matching the pattern
already applied to `em_scan_rf_worker.c` and `gsr_sensor.c`. Only
`gps_uart.c` (8) and `biomap.c` (7) remain unpromoted now.

## Track 104: stationary indoor crash — the cleanest negative result yet (2026-07-29)

Deliberately run as an isolation test: recording left indoors, stationary
(no walking at all), with the GSR finger cuffs physically disconnected.
Ran 444.9 seconds (~7.4 min) and crashed — the first crash captured with
every piece of instrumentation built this session active simultaneously
(main-thread stack, RF/GSR stack, SD write/sync latency).

Every single measured resource was healthy for the entire session:

- **Heap**: flat (83208/82952 free/min — same shape as every prior track).
- **All three thread stacks flat and healthy for 444.9s straight.**
  `stack:main` settles at 2476B free (of 4096) within the first few
  seconds and never moves again for the rest of the session. RF (3596B)
  and GSR (1660B) match every prior track exactly.
- **SD write/sync latency**: climbs gradually (write 4→86ms, sync
  14→46ms) — consistent with normal SD card write-latency variance
  (occasional slower writes as background flash housekeeping kicks in),
  nowhere near the >300ms stall Theory 2 predicted as a smoking gun.
- **RF signal**: max across all three bands, the *entire* session:
  exactly -91.5 dBm — pinned at the quiet floor throughout, zero
  elevation anywhere. Another clean data point against the already-dead
  RF-correlation theory.
- **GSR reading**: rock-stable at 16.9 nS for 4427 of ~4429 rows —
  confirms the cuffs were disconnected, but 16.9 nS is comfortably inside
  the "valid" range (`GSR_VALID_MIN_NS`=0.1 to `GSR_VALID_MAX_NS`=75000),
  so `gsr_sensor_is_connected()` would have read true the whole session —
  the disconnect/debounce code path was never actually exercised by this
  test, worth knowing if that mattered to the isolation intent.
- **Crash screen: still bare "furi_check failed."** Confirmed directly —
  none of the ~28 promoted `furi_check()` calls (RF worker, GSR sensor,
  SD logger combined) fired.

**Implication**: indoors, stationary, no cuffs, 7+ minutes, every
app-measurable resource healthy throughout — and it still crashed. This
rules out outdoor/walking-specific causes entirely (vibration, real GPS
motion solutions, temperature, actual RF exposure) on top of everything
already ruled out from tracks 100-103. Combined with the wide, seemingly
random spread of crash timings across every track so far (5s, 20s, 35s,
145s, 179s, 444.9s, 520s — no trend, no threshold-crossing pattern in any
resource) — this now looks much more consistent with a genuine
intermittent race condition or fault with a roughly constant per-unit-time
probability, not a slow resource exhaustion. Resource-usage diagnostics
have been checked thoroughly and repeatedly turned up nothing; adding more
of the same kind is unlikely to be the way this gets solved from here.

## Current status / open questions

> **Superseded — see "Overall status" at the end of this document for the
> current picture.** This section reflects the state of the investigation
> before the SPI busy-wait bug was identified, before Momentum vs. stock
> firmware was checked, and before the GSR+RF-concurrency and UART-redraw
> hypotheses were tested and refuted. Left in place rather than rewritten,
> per this doc's own practice of recording superseded findings instead of
> deleting them — but don't treat the numbered list below as the current
> state of things.

- **Every app-measurable hypothesis has now been ruled out.** Heap, all
  three thread stacks (main, RF, GSR), RF signal strength, SD write/sync
  latency, GSR connection state, GPS fix quality, and outdoor/walking-
  specific factors have all been directly checked against real data across
  seven crashes and two clean long runs, and none of them show a pattern.
  Theory 1 (SPI contention) is ruled out on inspection (wrong bus premise).
  None of the ~28 promoted `furi_check()` calls has ever fired. This is
  real, substantial progress in eliminating explanations — but the actual
  root cause is still open, and the remaining candidates are no longer
  things this app's own instrumentation can resolve.
- **What's left, roughly in order of how actionable it is**:
  1. Something inside Furi's own kernel/HAL internals — a check this app
     doesn't control and genuinely cannot instrument from application code.
  2. Something inside the RF/GSR worker threads' actual loop bodies
     (`em_scan_rf_worker_thread_fn()`, `gsr_sensor_worker()`) specifically —
     neither has any check at all, only their wrapper API functions do.
     There isn't much more to meaningfully check inside them (they're
     simple SPI/I2C polling loops), but it's the one code-level blind spot
     that hasn't been directly measured.
  3. A genuinely intermittent hardware fault (marginal solder joint, a
     flaky component, thermal drift, or something similarly not tied to
     motion) — track 104 shows this doesn't require walking/vibration to
     trigger.
- **Worth checking if available**: Flipper Zero can sometimes retain a
  crash log / register dump across a reboot, viewable via qFlipper or a
  serial CLI session, which would show the actual PC/backtrace at the
  crash — categorically more specific than anything a CSV-based diagnostic
  can produce. Worth checking what your firmware exposes here before
  adding further app-level instrumentation, since that path has now been
  pushed about as far as it can go.
- Consider promoting `gps_uart.c`'s remaining `furi_assert()` calls too —
  the last app-level module active throughout a walk not yet covered.
  Not done yet; ask before doing a broader sweep, same as every targeted
  pass so far. Given the pattern so far (every promoted check has come
  back silent), low expectation this changes anything, but it's cheap.
- **Do not** apply speculative CC1101 register-level changes (e.g. IOCFG0
  high-impedance), nonexistent HAL API calls, or a cross-bus SPI mutex for
  buses that don't actually share hardware — the async preset was
  deliberately chosen for wideband ambient RF capture, and changing it has
  a real cost to what the tool measures, for hypotheses that were already
  weak and are now dead.

## Track 105: a genuinely new failure signature — "ViewPort lockup", not a crash screen (2026-07-29)

Christian ran a tethered live-debug session (USB serial, `ufbt` CLI attached)
and the Flipper locked up — but this time **no crash screen appeared**.
Recording had just started (GPS+GSR+RF mode). The serial log shows:

```
88301 [I][SdLogger] Recording to /ext/biomapping/biomap_105.csv
88697 [W][ViewPort] ViewPort lockup: see applications/services/gui/view_port.c:196
121572 [D][BleGap] Start: 4
...(BLE advertising fires again every 60s, exactly on schedule, for the
    next several minutes — 121572, 181575, 241577, 301580)...
```

The Python-side `OSError: [Errno 6] Device not configured` at the end is
just the USB serial connection dying when Christian power-cycled the frozen
device — not an on-device event.

**What "ViewPort lockup" actually means.** Checked the real firmware source
(`applications/services/gui/view_port.c` in flipperdevices/flipperzero-
firmware) directly rather than guessing from the log text alone:

```c
void view_port_update(ViewPort* view_port) {
    // We are not going to lockup system, but will notify you instead
    // Make sure that you don't call viewport methods inside of another
    // mutex, especially one that is used in draw call
    if(furi_mutex_acquire(view_port->mutex, 2) != FuriStatusOk) {
        FURI_LOG_W(TAG, "ViewPort lockup: see %s:%d", __FILE__, __LINE__ - 3);
    }
    if(view_port->gui && view_port->is_enabled) gui_update(view_port->gui);
    furi_mutex_release(view_port->mutex);
}
```

The same pattern (2-tick non-blocking probe on `view_port->mutex`, same log
line) also guards `view_port_draw()` and `view_port_get_orientation()`. This
is a **different mutex from `app->mutex`** — it's Furi's own internal
per-ViewPort lock, owned by the GUI service. The firmware comment itself
names the classic cause: calling a `view_port_*` function while already
holding another mutex that the app's own draw callback also needs to
acquire — an AB-BA deadlock between `app->mutex` and `view_port->mutex`.

**Audited against that specific pattern — clean.** Checked every
`view_port_update()` call site in `biomap_session.c`, `biomap_gui.c`, and
`biomap_rf_cal.c` against every `furi_mutex_acquire()`/`furi_mutex_release()`
pair in those files (main recording loop, `key_toggle_recording()`,
`handle_recording_key()`, the zoom helpers, the RF calibration wizard).
Every single one releases `app->mutex` (or `w.mutex` in the RF cal wizard)
*before* calling `view_port_update()` — no case found where a `view_port_*`
call happens while the app is still holding its own mutex. This app does
not exhibit the AB-BA pattern the firmware comment warns about.

**What this does and doesn't tell us:**
- A lone "ViewPort lockup" line, by itself, isn't proof of a full deadlock —
  it's a 2ms non-blocking probe, so one miss can just mean the GUI thread
  was transiently busy drawing that exact frame; `view_port_update()`
  continues either way (it still calls `gui_update()` and unconditionally
  releases the mutex regardless of whether the acquire actually succeeded).
- But the device then stayed **frozen for several minutes** (only the
  independent BLE advertising timer kept firing on schedule, proving the
  RTOS scheduler and kernel timers were still alive) — that's a real,
  sustained hang, not a one-frame skip.
- Since the app's own mutex discipline checks out clean everywhere audited,
  the sustained hang itself isn't explained by anything in this app's code.
  It's consistent with — and mildly reinforces — the existing leading
  candidates from the tracks 100-104 section above: something inside Furi's
  own GUI-service/kernel internals, the display/SPI driver, or genuinely
  electrical/hardware, rather than opening a new app-level lead to chase.

**Open question, not yet investigated**: whether running tethered to a live
USB debug session (as opposed to a normal untethered walk) is itself a
contributing factor — none of tracks 91/96-104 were run this way. Worth
checking if it recurs specifically under `ufbt` CLI/serial debug sessions
versus normal standalone operation.

## Idle isolation test: locks up with zero SD/recording activity (2026-07-29)

Follow-up test, still tethered to the live USB debug session: sat on the
GPS+GSR+RF recording screen for ~15 minutes **without ever pressing OK to
start recording**. It locked up anyway.

```
601181 [I][GpsUart] M10Q running at 115200 baud, 10 Hz, GSV@1Hz
601182 [I][GsrSensor] Probe OK
601191-601196 [I][EmScan] freq[0..2] configured (815/868/915 MHz)
601740-602743 [I][GsrSensor] PGA 2→3→4→5 (autorange settles)
601240, 661247, 721250, ... 1501285 [D][BleGap] Start: 4 / set_non_discoverable
  (16 cycles, ~60003-60007ms apart, dead-on schedule for the full 900s)
--- USB disconnects (device power-cycled by hand) ---
```

**What this session actually exercised — corrected from my first read.**
I initially said `handle_recording_tick()` "does almost nothing" when
`recording.active` is false. Re-checked the function directly
(`biomap_session.c:693-738`) and that's wrong: for GSR modes it
unconditionally runs `gsr_sensor_tick()` (autoranging), fetches the raw
sample, and calls `pipeline_update_display()`/`pipeline_update_graph()`
(IIR filtering, graph ring-buffer push) **every tick regardless of
recording state** — all of it inside the same `app->mutex` critical section
`biomap_render_callback()` needs. Only the trailing `batch_csv_row()` call
is gated on `s->recording.active`. So this was not an idle no-op session —
the full GSR sampling/filtering/graph pipeline, RF worker polling, and GPS
parsing all ran exactly as in a real walk, at the same 10 Hz tick rate,
through the same mutex-guarded path.

What's actually different from a recording session is narrower than "doing
nothing": zero `storage_file_open/write/sync` calls, zero CSV row
formatting (`batch_csv_row`/`format_gps_csv_row` both early-return before
doing any work), zero diagnostic batch writes (`handle_second_boundary()`
also early-returns immediately when not recording), and the
recording-start chirp+200ms-settle sequence in `key_toggle_recording()`
never ran because OK was never pressed.

**SD/storage: eliminated, cleanly this time.** Track 104 already showed a
recording session could hang while stationary/disconnected; this goes
further — literally zero storage calls of any kind happened this entire
900-second session, and it still locked up. Theory 2 (SD flash write/GC
stalls) is now fully closed out, not just deprioritized.

**Still fully live and unchanged as suspects:** RF worker thread (CC1101
polling), GSR worker thread + the main-thread GSR pipeline math above, GPS
UART, and the Tick/render loop itself — none of these are gated by
recording state, so none of them are eliminated by this test.

**Retracting my in-conversation claim that the missing "ViewPort lockup"
line this time was itself meaningful.** That warning fires from a 2ms
non-blocking probe on Furi's internal `view_port->mutex` (see the track 105
section above) — whether it trips depends on exact scheduling luck, i.e.
whether some thread happens to call a `view_port_*` function during the
same few milliseconds another thread is mid-draw. Its absence here doesn't
establish a different failure mechanism than track 105; it's equally
consistent with the identical underlying stall simply not lining up with
that specific race window this time. Not treating this as a distinct
failure signature without better evidence.

**A real gap, only clear in hindsight: we don't know when in this 900s
window the freeze actually started.** Track 105 had a precise trigger (the
recording-start event) pinning its freeze to ~396ms after a specific log
line. This session has no equivalent heartbeat — the only periodic
evidence of liveness is BLE's own 60s re-advertise timer (proves the kernel
scheduler stayed alive throughout, nothing more), because
`handle_second_boundary()`'s diagnostic line is gated on `recording.active`
*and* only ever went to the SD card, never the serial log, even when
recording. So this freeze could have happened seconds after GSR PGA
settled (~602743, ~1.5s in — structurally close to track 105's timing) or
only after 14 more minutes of clean operation; this log cannot distinguish
those, and that ambiguity matters for whether this and track 105 are even
comparable events.

**Confound still open:** both this test and track 105 were run tethered to
the live USB debug session. Neither isolates whether tethered debugging
itself is a contributing factor — that's still untested.

**Worth considering (not yet implemented, needs sign-off first):** a
periodic `FURI_LOG` heartbeat independent of `recording.active` — something
the second-boundary handler doesn't currently have, since its one existing
diagnostic line only fires while recording and only reaches the SD card.
Without it, any future idle-session freeze remains untimeable from the log
alone, the same gap this test just ran into.

## Heartbeat added; RF-off/RF-on A/B test; a real firmware bug identified (2026-07-29)

### Heartbeat instrumentation

Implemented the suggestion above. `handle_second_boundary()`
(`biomap_session.c`) now logs an unconditional once-per-second line —
`[I][BioMap] heartbeat heap:free=... min=... stack:main=... rf=... gsr=...`
— regardless of `recording.active`, via `FURI_LOG_I` (serial only, not
`sd_logger`, so it exists even with no file open). The stack/heap gathering
that already existed for the recording-only SD diagnostic line was moved to
the top of the function and is now shared by both the heartbeat and the SD
line, rather than computed twice.

**Field-naming trap worth flagging for future reading of these logs**: the
`rf=`/`gsr=` fields are each worker thread's *stack headroom in bytes*, not
sensor readings. `gsr=1660` does not mean anything about conductance; `rf=0`
during an RF-off session means "no RF worker thread exists," not "0 dBm."
This was a direct carry-over from the older recording-only diagnostic line,
which was always about stack space, not sensor data — flagged after it
briefly read as a live GSR value in conversation.

### RF Scan toggle made persistent

Unrelated to the crash mechanism itself, but load-bearing for this test
methodology: `rf_scan_enabled` (and every other Options toggle — zoom,
backlight, sound, GPS profile) previously reset to hardcoded defaults on
every app launch, since only calibration data was ever saved to SD. Added
`BioMapSettings` (`biomap.h`/`biomap.c`) — same magic/version/checksum/
atomic-rename shape as `BioMapCalibration` — persisted to
`/ext/biomapping/biomap.settings`, loaded at startup, saved immediately
after each toggle in `biomap_gui.c`. Without this, "RF off" couldn't
actually be held constant across the relaunches this test needed.

### RF-off test: clean, repeated

Tethered, idle (no recording), RF Scan turned off via Options. Repeated
runs, heartbeat firing steadily throughout: heap pinned at
`free=76920 min=72200` for the entire duration, never moving. No lockup.

### RF-on test: ~636s clean, then locked up — with heartbeat evidence this time

Same conditions, RF Scan back on. Heartbeat fired every ~1000ms, heap flat
(`72336/72200`), RF/GSR/main stack all flat, from session start
(`1022051`) through `1658050` — **636 seconds**, comparable to but still
short of track 103's previously-longest clean run (655.3s, also RF-on,
pre-heartbeat). Then: nothing. No further heartbeat line, no "ViewPort
lockup" warning, no gap-then-resume — a hard, total stop after a perfectly
regular cadence. Christian confirmed the screen was frozen and the physical
buttons were unresponsive (couldn't even trigger the backlight), then
power-cycled the device (the `OSError: Device not configured` in the
Python trace is that power-cycle killing the USB serial connection, not an
on-device event).

This is the first failure captured with the heartbeat active, and it
changes what we know in one specific way: previous lockups (track 105, the
idle test) only had evidence the **GUI/render thread** was stuck (a
`view_port_update()` miss, or silence). This time, the **main application
thread itself** stopped — the heartbeat runs from inside the same
Tick-event loop that also dispatches button input, and it didn't degrade or
skip a beat before stopping; it simply never printed again. That's
consistent with a hard block on a blocking call somewhere in that thread's
per-tick path, not a gradual slowdown.

One caveat on the "confirms RF" read: 636s is still inside the range
track 103 already showed can run clean with RF on (655.3s), so on its own
this doesn't prove RF is a deterministic trigger rather than the same
"roughly random per-unit-time" pattern already established across 7+ prior
crashes. It's one more data point in a now much larger set that all share
RF-on, not proof by itself.

**Heap: reconfirmed as a non-factor, with the cleanest data yet.** Both
runs this round show heap completely pinned — not just "flat within normal
variance" the way earlier tracks described it, but the exact same
`free`/`min` value on every single heartbeat line for the run's entire
duration (RF-off: `76920/72200` unchanged across repeated runs; RF-on:
`72336/72200` unchanged across all 636 seconds up to the last line before
the freeze). This is a stronger result than the "Current status" section's
earlier heap conclusion (which was based on the coarser 5s-interval SD
diagnostic, only while recording) — it's now confirmed at 1-second
resolution, during idle sessions, immediately up to the moment of failure.
Heap exhaustion/leak is not a live hypothesis at this point by any
reasonable reading of the data.

### Verified against Momentum, not stock — same mechanism either way

Christian is running Momentum firmware, not the official Flipper build.
Re-checked both the `view_port_update()` lockup mechanism and the SubGHz
HAL directly against Momentum's actual source
(`Next-Flip/Momentum-Firmware`, `dev` branch) rather than assuming the
stock analysis carried over. The `view_port.c` "ViewPort lockup" probe is
byte-for-byte identical between stock and Momentum — the track 105 analysis
holds unchanged.

### The actual finding: an unbounded busy-wait in the SPI driver, confirmed in BOTH stock and Momentum firmware

`furi_hal_spi.c`'s `furi_hal_spi_bus_end_txrx()` — called at the end of
every SPI transaction on any bus, including the CC1101's:

```c
static void furi_hal_spi_bus_end_txrx(const FuriHalSpiBusHandle* handle, uint32_t timeout) {
    UNUSED(timeout); // FIXME
    while(LL_SPI_GetTxFIFOLevel(handle->bus->spi) != LL_SPI_TX_FIFO_EMPTY)
        ;
    while(LL_SPI_IsActiveFlag_BSY(handle->bus->spi))
        ;
    while(LL_SPI_GetRxFIFOLevel(handle->bus->spi) != LL_SPI_RX_FIFO_EMPTY) {
        LL_SPI_ReceiveData8(handle->bus->spi);
    }
}
```

A `timeout` parameter exists, is passed all the way down from
`furi_hal_subghz_idle()`/`_rx()`/`set_frequency()`/`get_rssi()`, and is
discarded on the first line — the firmware's own author left the `//
FIXME`. The two `while` loops spin on raw SPI peripheral status flags with
no time bound and no escape path. Diffed directly against the stock
`flipperdevices/flipperzero-firmware` `dev` branch copy of the same
file: **identical, not a Momentum-specific bug** — Momentum forked this
file unchanged from upstream. (Earlier in conversation this was
mis-described as Momentum-specific before the stock diff was actually run
— corrected here.)

This sits underneath every CC1101 register access, called ~100+ times/sec
by `em_scan_rf_worker_thread_fn()`'s `em_scan_rf_park_band()` loop
(`em_scan_rf_worker.c`/`em_scan_rf.c`) whenever RF scanning is active, and
literally never otherwise — the one piece of hardware access this app
performs continuously only when RF is on. Under a genuine SPI/CC1101
hardware glitch (electrical noise, a timing edge case), this loop has no
mechanism to ever return.

**What this does and doesn't explain — being honest about the gap rather
than overclaiming a clean story:**
- It's a real, concrete, firmware-acknowledged (`FIXME`) unbounded wait,
  reachable only through code this app's RF worker thread calls
  continuously and only while RF scanning is on. Strongest concrete
  mechanism found in this whole investigation for *why the RF worker
  thread specifically* could hang forever.
- It plausibly explains the classic bare `furi_check failed` crashes too
  (tracks 97-102, 104): `furi_hal_subghz_idle()`/`_rx()`/`set_frequency()`
  each wrap a *different* CC1101-status wait
  (`cc1101_wait_status_state(..., 10000)`) in `furi_check()` — a timeout
  there produces exactly the bare, message-less crash text seen throughout
  this doc, from a check this app doesn't own and can't instrument (per
  the "Current status" section above, written before this was found).
- **What it does NOT yet explain**: why this specific incident froze the
  main application thread and GUI too, not just left RF data stale.
  `w->mutex` (`em_scan_rf_worker.c`) — the only thing standing between the
  main thread and the RF worker's state — is never held during the actual
  SPI call, only briefly before and after it (confirmed by re-reading
  `em_scan_rf_worker_thread_fn()`). The RF worker also runs at
  `FuriThreadPriorityLow`, and this busy-wait isn't inside any critical
  section — under normal preemptive scheduling, a stuck low-priority thread
  spinning in a plain `while` loop shouldn't prevent the main thread or GUI
  service from running at all. No lock chain in this app's own code
  connects "RF worker thread stuck in SPI" to "main thread stops
  responding to input." Either there's a lower-level hardware effect
  (shared clock/DMA/interrupt state) invisible from source, or the RF hang
  and the full-system freeze are two symptoms of one deeper trigger rather
  than a direct cause-and-effect chain — genuinely unresolved, not
  papered over.

### Can this app fix it?

No, not directly. `furi_hal_spi_bus_end_txrx()` is compiled into the
firmware itself; a `.fap` app only links against the firmware's exported
HAL API at runtime and has no mechanism to override or patch an internal
HAL function. Actually fixing the bug means patching firmware source and
building/flashing a full custom firmware image — a materially bigger,
riskier undertaking than app development (different toolchain than `ufbt`,
real risk of a bad flash, and any patch needs re-applying on every upstream
Momentum/stock update unless it's upstreamed and merged).

What this app's own code *can* do, none of it implemented yet, pending
Christian's call:
- Keep RF Scan defaulting to (or staying) off — now backed by both a clean
  A/B result and a concrete, real mechanism, not just correlation.
- Reduce CC1101 polling frequency to lower exposure — real cost, already
  documented elsewhere in this project as "RF staleness," a metric
  previous changes were reverted over (see `em_scan_biomap_merge_plan.md`).
  Lowers probability, does not eliminate the underlying bug.
- A liveness watchdog on the RF worker (e.g., timestamp its last successful
  read; if stale beyond some threshold, treat RF as failed and warn/disable
  it) — only useful if the main thread genuinely stays unaffected when the
  RF thread hangs, which is exactly the part not yet confirmed above. If
  the main thread hangs too, a watchdog on another thread doesn't help the
  user recover; it could only be useful for something more drastic (e.g.,
  forcing a device reboot on suspected RF stall), which is a real behavior
  change with false-positive risk, not a minor addition.
- Upstreaming a real fix to `furi_hal_spi_bus_end_txrx()` (honor the
  `timeout` parameter that's already threaded through every call site)
  is possible in principle — it's open source and the bug is already
  self-flagged — but that's a decision for Christian to make, not
  something to act on unilaterally, and it wouldn't help this device
  without a firmware update regardless.

## Three follow-up questions checked against real source (2026-07-29)

### Negative finding: power rail voltage sag (Theory 4) — contradicted by the tether split

Theory 4 (power rail sag under combined SD+RF+GPS+backlight draw) was
never tested directly (its own proposed experiment — backlight off, swap
SD card — was never run). But the tether/lockup split from this session is
itself evidence against it, for the freeze-type failures specifically:
tethered means running on stable, regulated USB 5V with the battery
supplementing rather than solely supplying load, i.e. *less* sag risk than
battery-only operation, not more. Every lockup on record (track 105, both
idle tests, the RF-on 636s run) happened tethered; every classic
`furi_check failed` crash screen (tracks 97-102, 104) happened untethered,
on battery. If voltage sag under load were driving the freezes, the
opposite pattern would be expected. **Recording this as a negative
finding**: power rail sag is not a plausible explanation for the freeze
failure mode. It remains formally untested (not actively refuted) for the
original `furi_check failed` crash class, since that class has so far only
been observed under the one condition (untethered/battery) where sag would
be expected to matter most anyway.

### Bluetooth: a real, verified mechanism found — but the timing doesn't cleanly fit yet

Checked whether Bluetooth (visibly active every session — `[D][BleGap]
Start: 4` / `set_non_discoverable success` on a rigid 60s cadence in every
log collected, crash or clean) could be involved, against Momentum's real
source rather than speculating.

**Confirmed, directly in source:**
- That 60s cadence is real and exact: `gap.c`'s `INITIAL_ADV_TIMEOUT` is
  literally `60000` (ms). `gap_advertise_start()` re-arms this timer at
  its own end on every firing, so it repeats indefinitely for the entire
  session — not a one-time startup event. Each firing calls
  `aci_gap_set_non_discoverable()` then `aci_gap_set_discoverable()` —
  real commands crossing to the separate BLE radio coprocessor (Flipper
  Zero's STM32WB55 is a genuine dual-core chip: an M4 application core
  running this app, and a separate M0+ core running the BLE stack,
  communicating via shared-memory IPC).
- `FuriTimer` (`furi/core/timer.c`) is a direct wrapper around FreeRTOS's
  `xTimerCreateStatic`. This matters architecturally: FreeRTOS software
  timers are foundationally designed so that **every timer callback in
  the entire system runs sequentially on one single shared "timer
  service" task** — not one thread per timer. This app's own Tick timer
  (`biomap_timer_callback`) and BLE's GAP advertise timer both go through
  this exact same shared mechanism. `biomap_timer_callback` itself is
  already written defensively around this — it does a non-blocking
  `furi_message_queue_put(ctx, &ev, 0)` specifically because, per its own
  existing comment, "software timer callbacks run in the system timer
  daemon task. Blocking here would stall all OS timers." That comment
  turns out to be describing a real, verified architectural fact, not
  just caution.
- `ble_glue.c` (the CPU1-CPU2 command transport) has a `shci_mtx` acquired
  with `FuriWaitForever` in at least one code path. If BLE's side of that
  channel ever blocks — e.g. CPU2 unresponsive — whatever CPU1 thread is
  waiting on it blocks forever.

**The mechanism this adds up to, if it's real**: if any FreeRTOS software
timer callback anywhere in the system ever blocks indefinitely, it starves
every other timer in the system, silently, with no crash — because
they're all served by the same single thread. That would explain the
heartbeat's exact failure signature (perfectly regular, then a hard total
stop with zero degradation) far better than a gradual hang would, and
plausibly explains the backlight/button unresponsiveness too, if
Notification service LED/backlight sequencing also runs on a `FuriTimer`
(not directly confirmed, but a reasonable read given the existing
"Incorrect BacklightEnforce use" log line elsewhere in every session).

**What's NOT confirmed, stated plainly:**
- Whether the GAP advertising call specifically (`aci_gap_set_discoverable`
  et al.) is the one that can actually block on `shci_mtx` — only that
  `shci_mtx` exists and is used with `FuriWaitForever` somewhere in the
  same file. Didn't trace the exact call chain from `gap.c` into
  `ble_glue.c` to close this link.
- Why CPU2 (the BLE coprocessor) would become unresponsive in the first
  place, or why that would specifically correlate with RF scanning being
  on. A physically plausible bridge exists (CC1101 and the BLE radio are
  separate RF front ends but share a board and possibly a noise/thermal
  environment — real-world coexistence effects between co-located radios
  are a known category of problem), but this is reasoning from general
  RF-engineering plausibility, not something verified in source.
- **A real complication the log timing itself raises**: if BLE's own
  60s timer callback were the one getting stuck, the freeze should show up
  as a `Start: N` line printed with no matching `set_non_discoverable
  success` right after it (caught mid-call). That's not what's in the
  logs — the last complete BLE cycle before the RF-on freeze was at
  `1621395/1621396`, and the freeze happened around `1658-1659`, roughly
  37 seconds later, well before the next 60s firing would even have been
  due (~`1681395`). No partial/hanging BLE line anywhere. That's more
  consistent with *something else* jamming the shared timer thread first
  (with BLE's advertise timer simply never getting a turn afterward, as a
  downstream casualty) than with BLE's own periodic call being the direct
  trigger — which undercuts the cleanest version of this theory, even
  though the shared-timer-thread mechanism itself is solidly verified.

**Next test that would actually discriminate**: disable Bluetooth entirely
(if Momentum's settings allow it) and repeat the RF-on soak test. If it
still locks up with BLE off, this whole theory is dead regardless of how
solid the underlying mechanism looks on paper. If it runs clean, that's
strong support for it.

### Why did standalone em_scan never crash, if this is a firmware bug?

A fair, important challenge to the whole "pre-existing firmware bug"
framing: if `furi_hal_spi_bus_end_txrx()`'s unbounded wait has always been
there, why did the original standalone em_scan app — RF scanning alone,
no GPS/GSR/SD/biomap around it — apparently never hit it?

This doesn't require the firmware-bug theory to be wrong; a marginal,
timing/electrical-noise-sensitive hardware race is exactly the kind of bug
whose *trigger probability*, not existence, depends heavily on operating
conditions. Several honest, non-exclusive reconciling explanations, none
of them confirmed:
- **Far more concurrent load now.** Standalone em_scan ran the CC1101 SPI
  loop essentially alone. The merged app runs it alongside a GPS UART ISR,
  a GSR I2C worker, periodic SD card writes, and a 10Hz main-thread tick
  doing pipeline math and display updates — all sharing one CPU, one power
  rail, and (per the previous section) one shared timer service thread.
  More simultaneous peripheral activity is a more electrically and
  timing-noisy environment, which is exactly the kind of condition that
  would make a marginal hardware race more likely to actually manifest,
  without the bug itself being new.
- **Tethering is a new variable, not something standalone em_scan was
  necessarily tested under for extended periods.** Every lockup on record
  happened tethered; if standalone em_scan testing was mostly untethered
  or short-duration tethered sessions, "never crashed" may partly reflect
  never having been exposed to the condition under which crashes have
  actually occurred, rather than evidence the merge introduced something.
- **Simple exposure/duration.** The "roughly random per-unit-time
  probability" model already established for the crash class in this doc
  means total cumulative RF-scanning minutes matters. This investigation
  alone has now accumulated far more instrumented RF-on runtime than
  standalone em_scan testing likely ever did.
- **Can't fully rule out the merge itself contributing something app-level**
  that combines with the firmware bug rather than the firmware bug being
  wholly sufficient on its own — the mutex/lock audits earlier in this doc
  were thorough but not infallible, and "the firmware bug alone explains
  everything" hasn't been proven, only argued as the most consistent
  explanation found so far.

**Genuinely unresolved** — this is a real point of healthy skepticism
against the leading theory, not something to wave away. The test that
would help most: deliberately reproduce something closer to standalone
em_scan's original conditions (RF scanning alone, no GPS/GSR/SD
concurrently, but tethered, for a comparably long duration to the RF-on
runs that have failed) and see whether it still locks up. If it does,
that weakens "concurrent load" as the explanation and strengthens
"tethering itself" or "just needed more RF runtime." If it doesn't, that
supports concurrent load as a real contributing factor, not just the
firmware bug in isolation.

## Sharpened: diffed standalone em_scan.c against the merged app directly (2026-07-29)

Christian pushed back on the vague "more concurrent load" framing above:
the real question is what specifically changed in the em_scan → BioMapping
merge. `em_scan.c` (the retired standalone app) is still in the repo,
never deleted — diffed it directly against the current
`em_scan_rf_worker.c`/`biomap_session.c` rather than continuing to
speculate.

**Confirmed unchanged**: the RF worker itself is the exact same code.
Standalone `em_scan.c`'s `EmScanModeNormal` already called
`em_scan_rf_worker_alloc/start/stop/get_snapshot()` — the identical
functions biomap uses today — with the identical park duration
(`EM_SCAN_WORKER_PARK_MS` / `RF_WORKER_PARK_MS`, both `300`). The SPI
busy-wait bug (previous section) was exactly as reachable from the
standalone app. That part of the merge changed nothing.

**Confirmed genuinely new**: `EmScanApp` (the standalone struct) has no
GSR field at all — no `GsrSensor*`, nothing. Standalone em_scan only ever
ran GPS + the RF worker + SD logging, concurrently, nothing else. Every
RF-on test in this investigation has used biomap's GPS+GSR+RF mode, which
adds a dedicated `GsrSensorWorker` thread doing continuous
`furi_hal_i2c_acquire/read_mem/write_mem/release` calls, plus per-tick GSR
IIR/graph-buffer math on the main thread — running the whole time,
concurrently with the RF worker's SPI polling. That combination — RF
worker + GSR worker, different buses (SPI vs. I2C), same chip, same
session — never existed before the merge.

This is also consistent with a cross-check already in hand: the RF-off
idle test *still had GSR running* (GPS+GSR+RF mode, RF toggled off) and
stayed clean, meaning GSR alone isn't sufficient either. It's specifically
the RF+GSR combination that's new, not GSR in isolation or RF in
isolation.

**The test this points to directly**: run RF scanning with GPS but *no*
GSR — closer to reproducing standalone em_scan's actual conditions than
anything tried so far — for a comparable tethered duration. Not yet run.

## Main menu redesigned to make GSR/RF combinations explicit (2026-07-29)

Directly motivated by the above: the previous menu (GPS + GSR / GPS Only /
GSR Only / Options) combined with a separate Options > RF Scan toggle
meant "GPS + GSR" could silently be running with or without RF depending
on a global setting from a different screen — exactly the ambiguity that
made "what changed" hard to pin down, and made the isolated-RF-without-GSR
test above impossible to reach without an extra menu detour. Changed to
four explicit main-menu modes, RF Scan option removed entirely:

- **GPS + GSR + RF** (new `BioMapModeGpsGsrRf`) — everything on.
- **GPS + GSR** (`BioMapModeGpsGsr`, redefined) — RF now always off for
  this mode, no toggle.
- **GPS + RF** (`BioMapModeGpsOnly`, relabeled) — no GSR at all. This is
  the exact condition the section above identifies as untested and most
  useful to run next.
- **GSR Only** (`BioMapModeGsrOnly`) — unchanged, never had RF.

`has_gps`/`has_gsr`/`has_rf` (`biomap_types.h`) updated accordingly; every
other call site in the app already keyed off those three predicates
rather than switching on the mode enum directly, so no other logic needed
to change. `rf_scan_enabled` removed from `BioMapApp` and from
`BioMapSettings` (persisted-settings version bumped 1→2 — an old v1 file
on disk just fails the version check and falls back to defaults, same as
any other format change). Diagnostics mode (reached via Options, not the
main menu) keeps `has_rf()` unconditionally true now, losing the
"toggle RF Scan, re-enter Diagnostics" A/B comparison the old toggle
enabled there — an accepted, direct consequence of removing the toggle
everywhere, not a separate decision.

Builds clean (`ufbt build`) and all host tests still pass (81 assertions)
— unaffected, since none of this touches the host-tested modules.

## GPS + RF test result: negative finding on GSR, and a real fix (2026-07-29)

First real-hardware run of the new "GPS + RF" mode — the test the previous
section identified as the most useful next step (RF + GPS, deliberately no
GSR, closest reproduction of standalone em_scan's original conditions).

**Negative finding: rules out the GSR+RF-concurrency hypothesis.** It
hung. The heartbeat line captured mid-session confirms `gsr=0` — no GSR
worker thread existed at all this session. The previous doc section's
leading theory ("RF worker + GSR worker running concurrently is the one
concrete thing the merge introduced") is now refuted by direct test: GSR
wasn't running, and it hung anyway. Recorded here as a negative result,
not deleted, per the standing instruction to keep negative findings in
this doc rather than only the ones that pan out.

**What the log actually showed, and the correction to an in-conversation
misread.** Before the hang, the log showed dozens of "ViewPort lockup"
warnings in tight clusters (e.g. 3 within 15ms, 6 within 31ms) — a
different pattern from every prior lockup (which showed either one such
line or none at all, then silence). A heartbeat line printed successfully
in the middle of this flurry, which was initially taken as proof the app
wasn't frozen. That's only valid for the instant it printed — Christian
confirmed the session did hang, afterward. Retracting the "this is just
harmless noise" read.

**Root cause of the warning burst, found by diffing against standalone
em_scan.c again.** `biomap_session.c`'s `EventTypeUart` handler used to
contain:

```c
if(ev.type == EventTypeUart && s->gps) {
    gps_uart_process_rx(s->gps);
    if(!has_gsr(s->mode))
        view_port_update(s->vp);
    continue;
}
```

`modules/gps_uart.c`'s UART IRQ debounces posting `EventTypeUart` (a
`rx_pending` guard prevents one-per-byte at 115200 baud), but a single GPS
fix cycle still arrives as several separate NMEA sentences in a tight
burst, not evenly spaced — enough to post multiple debounced UART events
within a few milliseconds of each other, matching the log's clustering
exactly. Every one of those events called `view_port_update()`, but
**only** in modes where `has_gsr()` is false — today, only GPS+RF. Every
other mode takes a different branch and never calls
`view_port_update()` from here at all, relying solely on the Tick
handler's own unconditional 10 Hz call. GPS+RF was therefore the only
mode capable of bursting `view_port_update()` calls far above the ~10 Hz
rate every other mode is bounded to.

Checked standalone `em_scan.c`'s equivalent handler directly (not from
memory): `if(ev.type == EventTypeUart) { if(app->gps)
gps_uart_process_rx(app->gps); continue; }` — **it never called
`view_port_update()` from the UART branch at all**, in any mode, ever.
This is a genuine behavioral difference the merge introduced, not
something standalone em_scan did.

**Fix applied**: removed the `view_port_update()` call from the UART
branch entirely (`biomap_session.c`), for every mode, matching standalone
em_scan.c's original pattern. The Tick handler already calls
`view_port_update(s->vp)` unconditionally every tick regardless of mode —
so GPS-only/GPS+RF screens still redraw at that same bounded 10 Hz rate;
the only cost is up to one tick (~100 ms) of extra latency before a fresh
GPS reading reaches the screen, in exchange for never bursting redraw
calls faster than every other mode already handles safely. Builds clean,
all 81 host-test assertions still pass (this code isn't part of the host
harness, but nothing else changed).

**What this does and doesn't claim to fix**: this directly addresses a
real, confirmed, merge-introduced difference from standalone em_scan that
was actively spamming `view_port_update()`/`view_port->mutex` contention
right before a real hang — a legitimate fix regardless of anything else.
It does **not** claim to be a complete explanation for every lockup in
this doc: GSR-inclusive modes never took this code path at all (the branch
was always skipped for `has_gsr()==true`), so this can't explain track 105
or the RF-on 636s freeze, both of which were GPS+GSR+RF sessions. Those
remain open, most likely explained by the SPI busy-wait firmware bug
documented earlier. This fix is specifically scoped to whatever this
GPS+RF-only mechanism contributed on top of that.

**Next test**: repeat GPS+RF, tethered, comparable duration, with this fix
in place. If it now runs clean, this specific burst-redraw mechanism was
sufficient on its own to explain the GPS+RF hang, independent of the SPI
firmware bug. If it still hangs, this fix was necessary-but-not-sufficient
and the firmware-level SPI busy-wait (or something else) is still doing
the real damage in this mode too — not yet run.

## GPS + RF retest with the fix: 1033s clean, then the same hard stop (2026-07-29)

Fix confirmed real, but not complete. Session ran `568808` → last heartbeat
`1602228` — **1033 seconds (~17.2 minutes)**, `gsr=0` throughout (no GSR
worker at all), heap and every stack completely flat the entire time. Then
it stopped: no gap, no warning, no "ViewPort lockup" line (that mechanism
is gone now), just the same signature every hard hang in this doc has
shown — perfectly regular right up to the last heartbeat, then nothing.

**The fix helped a lot, genuinely.** Pre-fix, GPS+RF was hanging within
~33 seconds (the ViewPort-lockup-spam session). Post-fix: ~31x longer
before failing. Keeping the fix — it removed a real, confirmed,
merge-introduced difference from standalone em_scan, and the improvement
is too large to be noise.

**But it's not sufficient on its own.** This is now the cleanest isolation
in the whole investigation: no GSR worker (`gsr=0`), no UART-triggered
redraw spam (removed), just GPS + the RF worker, and it still hung, same
signature as every GSR-inclusive failure (track 105, the 636s GPS+GSR+RF
run). That rules out both "GSR+RF concurrency" (already refuted last
section) and "the UART redraw spam" as *sufficient* explanations on their
own — RF alone, cleanly isolated from everything else this app's code
controls, is enough to eventually hang. This is the strongest evidence yet
that the SPI busy-wait firmware bug (documented earlier — `furi_hal_spi_
bus_end_txrx()`'s `UNUSED(timeout); // FIXME`) is the actual root cause,
not something in this app's own logic.

**Also a new data point for duration**: 1033s beats track 103's previous
longest clean RF-on run (655.3s) by a wide margin. Combined with the wide
existing spread (33s to 1033s+ across everything tested with RF active),
this continues to look like a roughly-random, per-unit-time failure
probability rather than anything threshold- or duration-based — consistent
with a marginal hardware race that can go a long time before misfiring,
not a resource that runs out.

**Where this leaves things**: the two concrete, app-level contributing
factors identified in this investigation (GSR+RF concurrency load, UART
redraw spam) have both now been tested and neither is necessary for the
hang to occur — RF alone is sufficient. The remaining root-cause
candidates are back to what the firmware-level sections above already
identified: the SPI busy-wait bug specifically, or something else in
Furi's own kernel/HAL internals not reachable from application code. No
further app-level fix is obviously available from here without either
patching firmware (not something a `.fap` app can do — see the "Can this
app fix it?" section above) or reducing RF exposure/duration as a
mitigation rather than a fix.

## Overall status (2026-07-29)

Read this section first if picking the investigation back up — it
supersedes the "Current status / open questions" section from partway
through this doc, which predates most of what's below.

**What's confirmed:**
- Not heap, not stack (any of main/RF/GSR threads), not SD/storage I/O,
  not RSSI signal value/strength, not GSR connection state, not GPS fix
  quality, not power-rail sag (the tether split argues against it for the
  freeze failures specifically), not outdoor/walking-specific factors, not
  the RF calibration wizard race (found and fixed, but cosmetic/unrelated).
- Not GSR+RF concurrency specifically, and not the UART-triggered
  `view_port_update()` redraw spam (fixed, real improvement, but RF alone
  still hangs without it — see the two sections immediately above).
- A real, concrete, unbounded busy-wait exists in the shared SPI driver
  (`furi_hal_spi_bus_end_txrx()`, `UNUSED(timeout); // FIXME`), confirmed
  identical in both stock Flipper firmware and Momentum, sitting directly
  in the RF worker's hot path and nowhere else this app touches. This is
  the strongest concrete mechanism found for why RF specifically is the
  one common thread across every failure in this entire document.

**What's still open:**
- Why a stuck RF worker thread would freeze the *entire* app (main thread,
  GUI, even backlight/button response) rather than just leave RF readings
  stale — no lock chain in this app's own code explains that jump (see the
  SPI busy-wait section's "what it does NOT explain"). The shared-FreeRTOS-
  timer-thread mechanism (BLE section) is the best candidate found so far,
  but its one discriminating test — disable Bluetooth, repeat an RF-on
  soak — was never actually run. **This is the single highest-value test
  still outstanding.**
- Why standalone em_scan never reportedly crashed under what's now shown to
  be a near-identical resource profile (GPS + RF worker, no GSR). Tethering
  and cumulative exposure/duration remain the least-tested, most plausible
  remaining explanations — standalone usage was very unlikely to have run
  tethered for 1000+ continuous seconds the way this investigation's tests
  have.

**What can't be done from this app**: the actual bug lives in firmware
this app doesn't control. No polling-frequency reduction, watchdog, or
app-level workaround changes that — see "Can this app fix it?" above for
why, and its cost/benefit list for the options that do exist (reduce
exposure, accept the risk, or pursue an upstream firmware fix, which is a
real possibility given the bug is open-source and already self-flagged,
but is Christian's call, not something to act on unilaterally).

**Recommended next step, in order**: (1) the BLE-off RF-on soak test —
cheap, already designed, the one thing left that could meaningfully change
the picture rather than add another data point to an already-established
pattern; (2) if that doesn't resolve it, treat this as settled at "known
intermittent firmware-level risk, roughly random per-unit-time, ranging
from seconds to 1000+ seconds observed" and make it an operational
decision (accept the risk for fieldwork needing RF, avoid RF scanning when
not needed, or pursue the upstream fix) rather than continuing to search
for an app-level cause that the evidence increasingly says doesn't exist.
