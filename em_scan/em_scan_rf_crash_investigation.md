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

## Current status / open questions

- **No confirmed hypothesis remains standing.** Heap (flat), RF worker
  stack (flat), GSR worker stack (flat), RF signal strength (refuted by
  track 103), and GPS fix quality (no shared pattern) have all been
  directly checked against real data and ruled out. Theory 1 (SPI
  contention) is also now ruled out on inspection (wrong bus premise).
  This is real progress — narrowing down what it *isn't* — but the actual
  cause is still open.
- **Next walk should check, in order of what's new**:
  1. Does `stack:main` stay flat like the other two threads, or show
     pressure they didn't?
  2. Do `sd:write_ms`/`sync_ms` ever spike, and if so, does a spike land
     near a crash? This is genuinely new data no prior walk has.
- Consider promoting `gps_uart.c`'s remaining `furi_assert()` calls too —
  the last app-level module active throughout a walk not yet covered.
  Not done yet; ask before doing a broader sweep, same as every targeted
  pass so far.
- **Hardware/electrical explanations are now proportionally more likely**,
  precisely because every software-side hypothesis checked so far has come
  back negative. Nothing in this repo can confirm or rule that out — it
  would need physical hardware investigation (checking supply rail
  stability under load, reseating/testing the GPS and GSR boards
  independently, trying a different SD card, backlight off, etc.), not
  more log analysis.
- **Do not** apply speculative CC1101 register-level changes (e.g. IOCFG0
  high-impedance), nonexistent HAL API calls, or a cross-bus SPI mutex for
  buses that don't actually share hardware — the async preset was
  deliberately chosen for wideband ambient RF capture, and changing it has
  a real cost to what the tool measures, for hypotheses that were already
  weak and are now weaker still.
