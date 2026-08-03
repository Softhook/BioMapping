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

### 2026-08-03: track 117 recorded — the three new columns cleared themselves; culprit is the SD flush, not RF/I2C

Track 117 (362s, indoors — no GPS fix the whole recording) was the first
recording made with `i2c_peak_ms`/`rf_rssi_peak_ms`/`rf_retune_peak_ms` in
the CSV. It has exactly one real `tick_dt_ms` stall (930ms at t=29.0s,
against a ~100ms baseline with normal jitter up to ~107ms; a second
outlier at t=0.00s/663ms is startup, not investigated here). At that
930ms row, `i2c_peak_ms=2`, `rf_rssi_peak_ms=1`, `rf_retune_peak_ms=5` —
and those are the *lifetime maxes for the entire 362s track*. Since these
are never-reset running maximums, that rules out all three: none of them
ever got anywhere close to 930ms, on this thread, at any point in the
recording.

**Same freeze as track 116?** Re-examined track 116 (which predates these
columns) with that question in mind. Both tracks' stalls line up exactly
with the once-per-`FLUSH_INTERVAL` (10s) SD flush tick, not with anything
GSR/RF-related:

- Track 116: `tick_dt_ms` exceeds 108ms exactly 3 times in 18241 rows —
  216ms, 789ms, 957ms, at t=397.00s, 387.00s, 1177.00s. All three are
  `t mod 10 == 7`. Every one of the other 182 ticks landing on that same
  `mod 10 == 7` phase (i.e. every other flush) stayed at or near the
  100ms baseline (max 114ms) — and every non-flush, non-startup tick in
  the whole track (18058 of them) topped out at 108ms. So the anomalies
  are 3-for-185 *flush* ticks, 0-for-18058 everywhere else.
- Track 117: same check, phase `t mod 10 == 9` — the single 930ms stall
  is the only flush tick that spiked; the other 8 phases per second
  (non-flush ticks) topped out at 102-105ms.

That's occasional-flush-stall in both tracks, not RF/I2C — consistent
with `sd_logger_batch_flush()`'s own comment
(`biomap_session.c`/`sd_logger.c`) that `storage_file_write()`/
`storage_file_sync()` normally cost ~20-60ms but can run far longer on
real SD cards (flash wear-leveling/garbage-collection stalls are a known
SD failure mode, not something this codebase controls). Track 117 is too
short and GPS-fix-free to be the outstanding "long walk" verification
walk from the previous entry — it looks like a quick bench test that
happened to catch this by chance.

**Added a fourth column, `flush_peak_ms`**, for exactly this: a
lifetime-max real `furi_get_tick()` delta timed around
`sd_logger_batch_flush()`'s `storage_file_write()` + `storage_file_sync()`
pair (`modules/sd_logger.c`, new `flush_peak_ms` field + accessor
`sd_logger_get_flush_peak_ms()` in `sd_logger.h`), wired into `RowDiag`
(`biomap_types.h`), `get_row_diag()`/`format_gps_csv_row()`
(`biomap_session.c`), and the `BIOMAP_CSV_COLS_*` headers
(`biomap_config.h`). Same "never reset" convention as the other four
diagnostic columns.

Covered by a new host test,
`test_sd_logger_flush_peak_ms_detects_slow_flush`
(`tests/test_sd_logger.c`), mirroring the existing peak_ms tests: injects
an artificial delay into the mock's `storage_file_write()` (new
`storage_mock_set_next_write_delay_ticks()` in `tests/shims/storage_mock.c`
/`storage/storage.h`) and asserts the column reports it and a subsequent
fast flush doesn't lower it. `test_firmware.c`'s CSV-formatting and
header/row-column-count tests were updated for the new column (5th
diagnostic value, distinct from the other four so a column-order bug
would show up as a mismatch, not a false pass). Full host test suite
(`./run_tests.sh`) passes.

**Still outstanding**: the next real recording with `flush_peak_ms`
present should confirm this call, not something else on the main thread
(GPS UART draining, view_port_update pacing, etc.), is what lights up at
the next stall — this entry's evidence is a strong statistical
correlation (every stall in both tracks landed on a flush tick, and
nothing else ever spiked that high), not a direct per-call timing on
this specific mechanism yet.

### 2026-08-03: hypothesis — is this an SD card characteristic or something our implementation does? (external research, no code change)

Assuming the flush hypothesis above holds, is 200-950ms of `storage_file_write()`/`storage_file_sync()` latency a known SD/FatFs behavior, or is something in this codebase making it worse? Looked for outside discussion of the same symptom before changing anything further.

**It's a well-documented characteristic of SD-over-SPI, and our numbers land right in the middle of the range others report.** In SPI mode, an SD card signals "busy" after a write by holding the DO line low until its internal controller finishes committing the data — normally under the local flash's already-erased blocks, but occasionally the card needs to garbage-collect/relocate data first, and the host has no way to distinguish the two cases except waiting:

- An embeddedrelated.com thread on SD-over-SPI: normal post-write busy waits are usually under a few ms, but *"long 'busy' times occasionally exceed 160 ms... in extreme cases, measured times up to 900 ms have been observed."* That's within a few percent of track 116/117's 789/930/957 ms outliers.
- PX4's own logging documentation (flight-controller firmware, same "real-time loop + SD card logger" shape as this project) puts it plainly: *"Most SD cards we tested exhibit multiple pauses per minute. This shows itself as a several 100 ms delay during a write command."* Their own benchmark table shows even SD cards they consider "reliable" have max per-block write times in the 8-60 ms range under good conditions, with worse cards spiking far higher — consistent with our normal ~20-60 ms budget occasionally blowing out to ~1 s.
- Flipper Zero specifically drives the microSD card over **SPI "slow mode"**, not the 4-bit SDIO mode phones/laptops use ([docs.flipper.net](https://docs.flipper.net/zero/basics/sd-card)) — a deliberate power-saving tradeoff on Flipper's part that makes this class of stall more likely here than on faster hardware, independent of anything in this codebase.

So: the *existence* of occasional multi-hundred-ms write stalls isn't a bug in this project — it's inherent to cheap/consumer flash behind an SPI interface, and it would show up on essentially any Flipper Zero app that writes to SD on a schedule like this.

**What our implementation does that shapes how often/how badly it bites** (real, own-code factors, not the card's fault):

1. **`storage_file_sync()` after every batch flush** (`modules/sd_logger.c`) forces the card to actually commit to physical media every `FLUSH_INTERVAL` (10s), rather than trusting FatFs's write cache and syncing less often. This is a deliberate durability choice (a crash/pull mid-recording should lose at most ~10s, not the whole file) — but it's also the single call most likely to catch the card mid-housekeeping, since `sync` is exactly what forces the card to finish committing rather than letting it buffer more.
2. **[RESOLVED 2026-08-03] The flush is synchronous on the main event-loop thread** (`run_recording_session()`'s Tick handler, `biomap_session.c`) — released from `app->mutex` first, but still on the thread that must then process the next Tick, drain GPS UART, and pace `view_port_update()`. The card being occasionally slow is normal; the whole app stalling because of it is a consequence of waiting for that call in-line on the one thread everything else depends on. Fixed by moving the actual `storage_file_write()`/`storage_file_sync()` onto `sd_logger.c`'s own background writer thread — see the "SD flush mitigation options" entry below (option A).
3. **The batch file grows by repeated `storage_file_write()` appends with no pre-allocation** (`sd_logger_batch_flush()`) — a flush that crosses a FAT cluster boundary also forces a FAT-table/directory-entry update at a different physical location on the card than the data itself, on top of the ~12KB data write.

**How other projects handle the same symptom** — none of them make the stall itself go away (it's the card's firmware, out of anyone's control); they all work around it:

- **Move the write off the time-critical path.** PX4's logger is its own dedicated module, not code running inline in the flight-control loop — the real-time-sensitive work is structurally isolated from SD I/O latency, so a slow `fsync` costs the logger a buffer, not the aircraft a control tick. Direct analogue here: item 2 above (flush on the main/GUI/input thread) was the one architectural choice with a real fix, and it's now **implemented** — `sd_logger_batch_flush()` hands a buffer off to its own writer thread instead of writing inline, so a slow flush delays the next SD write, not the next Tick/GPS-drain/redraw. See the "SD flush mitigation options" entry below (option A) for the design and verification.
- **Size the buffer to absorb the spike, not avoid it.** PX4's docs say plainly: *"PX4 uses bigger buffers on F7/H7 and read caching, which is enough to compensate for spikes in many poor cards."* The logic: if a stall is going to happen periodically regardless, give the in-RAM buffer enough headroom that a ~1s stall doesn't cause a data-loss overflow, even if it still costs latency. Our 12288-byte / ~100-row buffer already does this for data-loss purposes (a flush being late doesn't drop rows, `handle_recording_tick`'s overflow path is the fallback) — the open question is only about the app *freezing*, not about losing GSR/GPS samples.
- **Pre-allocate the file.** A recurring recommendation across embedded SD-logging discussions (PX4's guidance included) is to pre-allocate/pre-erase the log file's space up front rather than growing it write-by-write, specifically to avoid the FAT-metadata-update-plus-seek cost on an active recording. Directly addresses factor 3 above; not attempted here.
- **Card selection / benchmarking, not firmware changes at all.** PX4 ships a `sd_bench` tool and publishes a list of SD cards known not to exhibit write-time spikes (SanDisk Extreme U3, Samsung EVO Plus, in their testing) — i.e., some of this is solved by picking a better card rather than changing any code. Relevant here too: it's worth checking whether the SD card used for tracks 116/117 is a known-good one or an unbranded/cheap card, since Flipper's own docs specifically warn that off-brand cards are less stable over SPI.

**Not changed as a result of this entry** — this is research/documentation only, per the "hypothetically speaking" framing this was raised under. If the freezes turn out to matter enough in practice, the ranked options above (background-thread flush > bigger buffer > pre-allocated file > card swap) are the candidates to revisit, roughly in order of how directly each addresses "the app freezes," not "the card is occasionally slow" (which none of them eliminate).

### 2026-08-03: track 118 recorded — flush hypothesis directly confirmed (independently verified); RF/I2C get a real negative confirmation

Track 118 (1454s / ~24 min, real outdoor GPS+GSR+RF walk, live fix throughout)
was the first recording made with `flush_peak_ms` in the CSV. Unlike track
117's statistical/phase correlation, this one shows direct, same-row causation:

- Row 5270 (t=527.00s): `tick_dt_ms=973`, and `flush_peak_ms` jumps
  `102→949` **in that exact row**. 949+overhead ≈ 973 — the flush call
  alone accounts for essentially the entire stall.
- `i2c_peak_ms`/`rf_rssi_peak_ms`/`rf_retune_peak_ms` at that row: 3/2/6 —
  unchanged from surrounding rows. Their maxima across all 14,539 rows of
  the whole 24-minute track: 3ms / 2ms / 7ms. Never remotely close.
- Row 0's 675ms startup transient is unrelated (`flush_peak_ms=0` there,
  same as track 117's).

**Independently verified by two separate agents**, each given only the raw
CSV, the column semantics, and the surrounding source files — no access to
this document's conclusions, no shared context with each other. Both
converged on the identical row (5270), identical values (973/949), and the
identical conclusion (i2c/rf never approach any tick spike, anywhere in the
file). This upgrades the finding from single-analyst inference to an
independently reproduced result.

**Negative confirmation, combined across tracks 117+118** (~1816s / ~30 min
of real on-device recording with per-call attribution live, RF active in
both): `i2c_peak_ms` max 3ms, `rf_rssi_peak_ms` max 2ms, `rf_retune_peak_ms`
max 7ms — across the board, in real usage, since the mutex fix. That's a
direct, repeated, real-world negative result for the RF/I2C side of the
original bug (see "The bug this was about" at the top of this document):
RF's SPI retune and RSSI poll are not blocking anything, with wide margin
under the 100ms tick budget. This is real evidence, not just verified
mechanism-in-isolation — but it's ~30 minutes of data, not proof the
firmware-level unbounded SPI busy-wait (item 5, "Other open items" below)
can never fire; it just hasn't.

**New, separate, unexplained finding** (both agents surfaced this
independently in track 118, neither was asked to look for it specifically):
starting with sparse isolated occurrences around t≈607s and becoming a
continuous, unbroken pattern from t=1111.5s to the end of the recording
(the last ~342s), `tick_dt_ms` enters a regular 5-row (0.5s) cycle:
~150-157ms (peaking to 250ms right when it overlaps a flush tick) followed
by a ~45-52ms compensating dip — net ~200ms per 2-tick cycle, no drift.
Initially looked correlated with `sats` alternating (11↔19), but both
independent agents disproved that as the driver: the correlation vanishes
later in the file (`sats` steady at 21 through both phases in the last
~60s) and `sats` jitter appears earlier in the recording without
triggering the pattern. `fix_type`/`hdop`/`gps_rx_drops`/`nmea_fail` show
no discrete change at onset either. Logged as an open item below — minor
(no data loss, self-correcting, never exceeds ~250ms) but genuinely
unexplained, distinct from both the SD-flush and RF/I2C questions.

### 2026-08-03: SD flush mitigation options (proposed, none implemented)

With the flush confirmed as the real, sized cause of the freeze (track 118
entry above) and RF/I2C cleared, here are the candidate mitigations,
ordered cheapest/least-invasive to most structural. **None of these have
been implemented** — this is a menu to choose from, not a plan in progress.

**A. [IMPLEMENTED 2026-08-03] Move the flush to a dedicated background
thread** (the PX4-style fix). Give the logger its own Furi thread that owns
the SD file; the Tick handler swaps a filled buffer into a queue instead of
calling `sd_logger_batch_flush()` itself. A slow `storage_file_write`/`sync`
then only delays the *next* SD write, never the Tick/GUI/UART path. This is
the only option that eliminates the freeze mechanism rather than reducing
its odds.

Implemented in `modules/sd_logger.c`/`sd_logger.h`:

- **Double-buffered** (`gsr_batch[2][12288]`, was one 12288-byte buffer —
  the deliberate, minimal RAM cost of not blocking the caller). The caller
  always fills `cur_buf`; `sd_logger_batch_flush()` hands that buffer to
  the writer thread and switches to the other one, but only once the other
  buffer is confirmed free. If the writer thread is still busy with it
  when the next flush is due, the flush is **skipped** that call (returns
  0, data stays put and is retried next time) rather than blocking — same
  "some data-loss risk under duress" spirit the existing overflow path
  already accepted, not a new category of risk.
- **No mutex, and no manual atomics either.** Two `FuriMessageQueue`s
  (`to_writer`/`from_writer`) carry buffer ownership across the thread
  boundary — the same primitive the app's own event loop already uses.
  `cur_buf`, `gsr_batch_len[]`, and `buf_free[]` are touched only by the
  calling (main) thread; each `gsr_batch[N]`'s contents are touched by the
  caller while filling, then exclusively by the writer thread once handed
  off, never both at once. Verified, not just argued: a ThreadSanitizer
  pass (`run_tests.sh`'s new `test_sd_logger_tsan` target) reports zero
  races across all 15 host tests, run repeatedly.
- **Writer thread created once** (`sd_logger_alloc()`) **and destroyed
  once** (`sd_logger_free()`), mirroring `GsrSensor`'s worker thread
  (`modules/gsr_sensor.c`) — not recreated per recording. Between
  recordings and between flushes it just blocks on
  `furi_message_queue_get(..., FuriWaitForever)`, costing nothing; a new
  test (`test_sd_logger_writer_thread_persists_across_recordings`) proves
  a second start/stop cycle on the same `SdLogger` works with no extra
  alloc/free.
- **`sd_logger_stop()` still synchronously waits** for the writer to flush
  whatever's left and close the file (an ack-queue wait, not
  `furi_thread_join()`, since the thread itself stays alive for a future
  recording) — every caller in `biomap_session.c` assumes the file is
  fully closed by the time `stop()` returns, and that's still true; only
  the *periodic* in-recording flushes became asynchronous.

**Deliberate trade, explicitly chosen over a more complete version**: a
write/sync failure is no longer reported back to the caller.
`sd_logger_batch_flush()` always returns `>= 0` now. Before this, a
broken/full/pulled SD card was detected synchronously and stopped the
recording with a red-LED alert (`biomap_session.c`'s
`handle_write_failure()`, and the warning-tone branch in
`flush_before_stop()`'s three call sites) — both removed alongside this
change, since they could never fire again. **This safety behavior is
gone**: the writer thread just logs and moves on; a genuinely broken card
now fails silently rather than stopping the recording. Restoring it would
mean the writer reporting status back through the ack queue too — not
done here, a conscious choice for a minimal first version, made when
asked directly rather than assumed.

Also needed: a **real functional `FuriMessageQueue`** in the host test
shim (`tests/shims/furi.h`) — the previous one was a stub that only
counted `put()` calls and discarded the message (fine for `gps_uart.c`'s
post-and-forget use, not enough for a real handoff). Backward-compatible:
a zero-initialized queue (`FuriMessageQueue q = {0};`, what `gps_uart.c`'s
own tests already construct directly) still gets the old stub behavior;
only a properly `furi_message_queue_alloc()`'d queue gets the real
ring-buffer-plus-condvar implementation. Also added a real `usleep()`-based
write-delay hook to the storage mock
(`storage_mock_set_next_write_delay_ms()`, replacing the old fake-tick-only
version that timed the now-removed `flush_peak_ms`) so
`test_sd_logger_flush_skipped_while_writer_busy_then_recovers` can
genuinely exercise the busy-writer skip path against a real concurrent
thread, not just assert on logic in isolation.

`flush_peak_ms` (the column added earlier in this investigation, see the
track 118 entry above) was **removed** rather than kept: it timed a call
that no longer blocks the thread it was diagnosing a stall on, so keeping
it would mean instrumenting a problem that was fixed at the mechanism
level instead. Removed from `RowDiag` (`biomap_types.h`), the CSV headers
(`biomap_config.h`), `get_row_diag()`/`format_gps_csv_row()`
(`biomap_session.c`), and `sd_logger.h`'s accessor — the existing
`test_csv_header_matches_row_column_count` regression test (added
specifically to catch a header/row column-count mismatch) confirms the
removal was clean on both sides (18/21 columns, no/with RF).

**Verified**: full host test suite passes (`./run_tests.sh`, including the
new `test_sd_logger_tsan` target); real ARM toolchain build
(`python3 -m ufbt`) compiles and links cleanly against the actual Flipper
SDK headers, not just the host shims — `FuriThread`/`FuriMessageQueue`
usage in `sd_logger.c` is exercised against the real API surface, not only
mocked.

**Not yet done**: an actual on-device recording to confirm the freeze is
gone in practice, not just that the mechanism moved threads. The dropped
failure-detection behavior is also worth revisiting if a real SD failure
in the field turns out to matter more than the felt freeze did.

**C. Sync less often.** Skip `storage_file_sync()` on most flushes; only
sync every Nth flush or right before stopping the recording. `sync` is the
call most likely to catch the card mid-housekeeping, so this directly cuts
how often that's touched. Trades away durability — currently a crash/pull
loses at most ~10s of data (`FLUSH_INTERVAL`); this could push that to
30-60s+ depending on N. Doesn't eliminate the freeze, just makes hitting it
rarer.

**D. Tune `FLUSH_INTERVAL`/buffer size.** A dial, not a fix, and it cuts
both ways: smaller/more-frequent flushes reduce backlog-at-risk per event
but increase total exposure events; bigger/less-frequent reduces exposure
events but risks a bigger stall when one lands. Cheap to experiment with
(one `#define`). Less urgent now that A is done — the freeze itself no
longer reaches the caller — but the double-buffer's own backlog risk (how
much unflushed data piles up if the writer thread is genuinely stuck for
longer than a `FLUSH_INTERVAL`) is still shaped by this value.

**E. Pre-allocate the log file up front.** Avoids the FAT cluster/
metadata-update overhead when the file grows via repeated appends — one of
the three implementation factors from the SD-card-research entry above.
Moderate effort (need to confirm the storage API exposes a pre-allocate/
seek-extend primitive). Likely a secondary win at best — the data (track
118's 949ms) points at SD-internal garbage collection as the dominant
cause, not FAT overhead, so this alone probably won't close the gap.

**F. Card selection/preconditioning.** Swap to a known-good SD card (PX4
publishes ones like SanDisk Extreme U3/Samsung EVO Plus that don't show
write-time spikes in their testing) and/or reformat the current one. Zero
code change, cheap to test, could make the problem rare-to-vanishing if the
card in hand is just a bad one — but doesn't fix it for anyone else running
this firmware with a different card; it's a workaround for this specific
card, not the app.

**Suggested order of attack**: A (the structural fix) is done. C, D, and F
remain candidates if the writer thread's own failure modes (silent write
failures, backlog buildup under a genuinely stuck card) turn out to matter
in practice — F (a better card) is still the cheapest lever and would
reduce how often the writer thread's now-silent failure path fires at all.

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
   **[2026-08-03 update]** Real-world data now backs this up rather than
   just leaving it theoretical: tracks 117+118 (~30 min combined real
   recording, RF active, `i2c_peak_ms`/`rf_rssi_peak_ms`/`rf_retune_peak_ms`
   live) show these calls consistently taking 1-7ms, nowhere near the
   ~100ms tick budget — see the track 118 entry above. That's real headroom
   to pace RF more aggressively (shorter dwell / more frequent retune) if
   desired; the risk itself (firmware-level unbounded busy-wait) is still
   permanent and unproven-impossible, just not observed to matter in
   practice so far.
6. **[NEW 2026-08-03] Unexplained 2Hz `tick_dt_ms` oscillation, track 118,
   t=1111.5s to end of recording** (building up from sparse occurrences
   around t≈607s). See the track 118 entry above for the full pattern.
   Ruled out: `sats`/GSV-burst correlation (both independent verification
   agents found it doesn't hold up through the whole affected region).
   Not yet investigated: whether it's `view_port_update()`'s 2Hz redraw
   pacing getting heavier (the 5-row/0.5s period matches that call's
   cadence exactly), a GPS-fix-quality effect distinct from raw `sats`,
   or something else entirely. Low priority — no data loss, self-correcting,
   never exceeds ~250ms — but a real, reproducible pattern change, not
   noise.
7. **Cosmetic, optional**: `gsr->available` is set `true` unconditionally
   at alloc (right after a `furi_check` that would already have aborted on
   allocation failure) and never set `false` anywhere — every
   `if(!gsr->available) return;` guard in every accessor is dead code.
   Not a bug; removing it means touching ~20 call sites plus the public
   `gsr_sensor_available()` API for zero behavior change. Left alone
   deliberately.
