# SD writer thread experiment — tried, tested, abandoned (2026-08-03)

> **Status: abandoned.** The code described here is being reverted. This
> file is the intentionally-kept record of what was built, how it was
> verified, and what the on-device data actually showed — written because
> the code itself won't be in the tree to answer these questions later.
> Raw evidence referenced below (`tracks/biomap_118.csv` through `_122.csv`,
> `tracks/seriallog.txt`, `tracks/seriallog2.txt`) should be kept even
> though it's data, not code.

## The problem this was trying to solve

Real recordings (tracks 116, 117, 118) showed genuine `tick_dt_ms` stalls
of up to ~950ms on the main app thread, landing almost exactly on the
once-per-`FLUSH_INTERVAL` (10s) SD batch-flush tick. `i2c_peak_ms`/
`rf_rssi_peak_ms`/`rf_retune_peak_ms` (GSR-worker-thread hardware call
timings) stayed at 1-7ms throughout every one of these tracks, ruling out
RF and I2C. Track 118 gave a direct, same-row confirmation: `flush_peak_ms`
(a timer wrapped around `sd_logger_batch_flush()`'s `storage_file_write()`
+ `storage_file_sync()`) jumped from 102→949 in the exact row `tick_dt_ms`
spiked to 973. Two independent verification agents, given only the raw
CSV, reached the same conclusion independently.

External research (an embeddedrelated.com SD-over-SPI thread; PX4's own
flight-controller logging docs) confirmed this is a known, inherent
characteristic of SD cards behind an SPI interface — occasional
multi-hundred-ms "busy" stalls while the card does internal
garbage-collection/housekeeping, worse on SPI ("slow mode," which Flipper
Zero specifically uses to save power) than the SDIO mode phones/computers
use. Not a bug unique to this app, but real and measured here regardless.

## What was built

The chosen fix (of several options considered — see
`docs/archive/gps_rf_mutex_status.md`'s "SD flush mitigation options" entry for
the full list) was to move the actual `storage_file_write()`/
`storage_file_sync()` off the main thread onto a dedicated background
writer thread inside `modules/sd_logger.c`, so a slow SD card would block
only that thread, never the Tick/GPS-UART/GUI-redraw path.

**Design:**
- Double-buffered (`gsr_batch[2][12288]`, was a single 12288-byte buffer).
  The caller always fills `cur_buf`; `sd_logger_batch_flush()` hands that
  buffer to the writer thread and switches to the other one, but only once
  the other buffer is confirmed free. If the writer thread was still busy
  with it, the flush was skipped that call (data stays put, retried next
  time) rather than blocking.
- Two `FuriMessageQueue`s (`to_writer`/`from_writer`) carried buffer
  ownership across the thread boundary — no mutex, and no manual atomics
  for the buffer-tracking state either (`cur_buf`, `gsr_batch_len[]`,
  `buf_free[]` were touched only by the calling thread; each buffer's
  contents were touched by the caller while filling, then exclusively by
  the writer thread once handed off, never both at once — verified
  race-free by a dedicated ThreadSanitizer pass, `test_sd_logger_tsan` in
  `run_tests.sh`, clean across repeated runs).
- The writer thread was created once (`sd_logger_alloc()`) and destroyed
  once (`sd_logger_free()`), mirroring `GsrSensor`'s existing worker
  thread — not recreated per recording. Between flushes it blocked on
  `furi_message_queue_get(..., FuriWaitForever)`, costing nothing.
- `sd_logger_stop()` still synchronously waited (via the ack queue, not
  `furi_thread_join()`, since the thread stayed alive for a future
  recording) for the writer to flush whatever was left and close the file
  — every caller in `biomap_session.c` depends on the file being closed
  by the time `stop()` returns.
- **Deliberate trade, chosen explicitly when asked, not an oversight**: a
  write/sync failure was no longer reported back to the caller —
  `sd_logger_batch_flush()` always returned `>= 0`. Before this, a
  broken/full/pulled SD card was detected synchronously and stopped the
  recording with a red-LED alert (`handle_write_failure()`, and a
  warning-tone branch in three call sites via `flush_before_stop()`) —
  both removed, since they could never fire again. A genuinely broken
  card would now fail silently.
- Removed the `flush_peak_ms` CSV column (`RowDiag`, `biomap_types.h`;
  `BIOMAP_CSV_COLS_*`, `biomap_config.h`) — it timed a call that no
  longer blocked the thread it was diagnosing a stall on.

**New instrumentation, added specifically because moving the write off
the main thread also removed the only way to tell if the SD card was
still stalling, just invisibly:**
- `flush_dur_ms` — an `_Atomic uint32_t` lifetime-max, timed on the writer
  thread itself around its write+sync call, read via
  `sd_logger_get_flush_dur_ms()`. Safe as plain load/store (no mutex) —
  the writer thread is the *only* writer, same reasoning already applied
  to `GsrSensor`'s atomic flags.
- `sd_logger_get_stack_space()` — the writer thread's free-stack
  headroom, mirroring `gsr_sensor_get_stack_space()`.
- Both wired into the existing once-a-second `FURI_LOG` heartbeat in
  `handle_second_boundary()` (serial log only, not a CSV column, to keep
  this minimal) — `heartbeat ... stack:main=... gsr=... sd=... flush_ms=...`.
- Later: `furi_thread_set_priority(l->writer, FuriThreadPriorityLow)` —
  see "what the data showed" below for why.

**Test infrastructure that had to be built to support this:**
- `tests/shims/furi.h`'s `FuriMessageQueue` was a stub (only counted
  `put()` calls, discarded the message — fine for `gps_uart.c`'s
  post-and-forget use, not enough for a real handoff). Replaced with a
  real, thread-safe, pthread-mutex+condvar-backed ring buffer, kept
  backward-compatible with `gps_uart.c`'s existing zero-initialized
  `FuriMessageQueue q = {0};` usage (a `capacity == 0` queue takes the old
  stub path; a properly `furi_message_queue_alloc()`'d one gets the real
  implementation).
- New tests in `tests/test_sd_logger.c`: writer-thread persistence across
  multiple start/stop cycles on one `SdLogger`, a failed write not
  wedging the pipeline, the busy-writer skip-and-recover path (using a
  real `usleep()`-based mock delay — `storage_mock_set_next_write_delay_ms()`
  — not just a fake-tick advance, since the writer now runs on a genuine
  background pthread), and `flush_dur_ms` actually capturing a slow write
  (same call-in-progress + fake-tick-advance pattern already established
  for `GsrSensor`'s peak_ms tests).
- Verified against the real Flipper ARM toolchain (`python3 -m ufbt`) at
  every step, not only the host shims — compiled and linked cleanly
  throughout, including the real `FuriThread`/`FuriMessageQueue`/
  `furi_thread_set_priority()` usage.

## What the on-device data actually showed

This is the part that mattered most, and it didn't confirm the fix.

**Track 119** (2143s, recorded with the writer thread in place): still
showed real `tick_dt_ms` stalls (up to 761ms), still landing almost
exactly on the 10s flush-cadence boundary (6 of 7 non-startup events at
`t mod 10 == 4.00`). The shape changed — smeared across 2-5 consecutive
ticks instead of one clean spike — but the correlation with flush timing
didn't go away.

**A tethered serial-log capture** (`tracks/seriallog.txt`, paired with a
fresh recording `tracks/biomap_121.csv`) confirmed `flush_dur_ms` worked
exactly as designed (clean monotonic staircase: 0→55→70→97→112→115→164ms
over the first ~147s) and then logged a genuine ~910ms SD write stall at
rec-relative t≈756.7s, no error, the write just took that long.

**Cross-referencing `biomap_121.csv` at that exact timestamp was the
decisive step**: rows 7560-7563 (t=756.0-756.3) showed `tick_dt_ms` =
145/147/294/279 — 865ms total against a 400ms baseline — landing at
essentially the same instant the writer thread logged its 910ms stall.
**The main thread was disrupted during the exact window the SD card
stalled. The separate thread did not insulate it.**

Working hypothesis: single-core CPU contention. If the underlying SD/SPI
wait doesn't yield the CPU (the same class of firmware limitation already
documented for the RF/CC1101 path — `furi_hal_spi_bus_end_txrx()`
discarding its timeout), an equal-priority writer thread spinning through
it can starve the main thread regardless of being "a separate thread."
Neither `GsrSensor`'s worker nor the new SD writer thread had ever called
`furi_thread_set_priority()` — both defaulted to `FuriThreadPriorityNormal`,
identical to the main thread. But the specific *shape* of the disruption
(four separate ticks each still completing, not one solid ~900ms gap
where the periodic Tick timer couldn't fire at all) argued against full
non-preemption — it looked more like competing for CPU than being locked
out, which is exactly the scenario a priority difference should fix.

**Change made in response**: `sd_logger_alloc()` set the writer thread to
`FuriThreadPriorityLow`, one level below the main thread's default.

**Re-tested with `tracks/seriallog2.txt` + `tracks/biomap_122.csv`**:
three real writer stalls this time (488ms, 509ms, 965ms). Result was
**mixed, not a fix**:

| writer-thread stall | main-thread disruption (CSV) | verdict |
|---|---|---|
| 488ms (t≈357s) | ~360ms + a smaller 154ms blip | partial absorption |
| 509ms (t≈367s) | ~354ms | more absorption (~150ms "saved") |
| 965ms (t≈1167s, the worst) | ~928ms across 4 ticks | almost no improvement |

The priority change helped for medium stalls but not for the largest,
most user-noticeable one — the case that actually matters most was
essentially unchanged.

## A second, unrelated, and bigger problem found along the way

Re-scanning `biomap_121.csv` more broadly (rather than only checking the
one timestamp the serial log flagged) turned up an 8-second-long cluster
at t=490.7-497.5s with individual rows up to **6,378ms** — far beyond
anything attributed to the SD flush. It repeats on a ~0.5s (2Hz) period,
not the 10s flush cadence, and `flush_dur_ms` in `seriallog.txt` stayed
completely flat through that entire window — proving it has nothing to do
with the SD write. `i2c_peak_ms`/`rf_rssi_peak_ms`/`rf_retune_peak_ms`,
`gps_rx_drops`, `nmea_fail`, `sats`, `hdop`/`pdop` all stayed normal
throughout too.

This matches the same period and catch-up signature as a much milder "2Hz
oscillation" first noticed in track 118 (there, topping out around
250ms) — logged at the time as a minor, unexplained curiosity. It now
looks like the same mechanism can scale to multi-second severity.
Leading (untested) hypothesis: contention around `view_port_update()`'s
2Hz redraw pacing in the Tick handler, possibly GUI/render-thread related
— not investigated further before this pivot.

## Conclusion

The SD writer thread is real, tested, race-free, and does provide partial
benefit for medium-length stalls — but it did not solve the worst-case
freeze, and a completely separate, more severe (6+ second) stall pattern
was found sitting in the same data, unrelated to SD flushing at all.
Given that, continuing to tune this approach (further priority
adjustments, chunking, etc.) wasn't judged worth the effort relative to
investigating the newly-found and larger problem. Decision: abandon
further work on the SD writer thread, revert the code, keep this
document plus the referenced track/log files as the record of what was
tried and why it didn't fully pan out.

## Files touched by this experiment (for reference against the revert)

- `modules/sd_logger.c` / `sd_logger.h` — the writer thread itself, double
  buffering, `flush_dur_ms`, `sd_logger_get_stack_space()`, priority setting
- `biomap_session.c` — removed `handle_write_failure()`/`flush_before_stop()`,
  extended the heartbeat log, updated Tick-handler comments
- `biomap_types.h` — removed `flush_peak_ms` from `RowDiag`
- `biomap_config.h` — removed `flush_peak_ms` from the CSV column headers
- `tests/shims/furi.h` — real `FuriMessageQueue`, `FuriThreadPriority` stub
- `tests/shims/storage_mock.c` / `storage/storage.h` — `write_in_progress`
  flag, real `usleep()`-based write-delay hook
- `tests/test_sd_logger.c` — full rewrite for the threaded design
- `tests/test_firmware.c`, `tests/test_em_scan_cal.c` — small follow-on
  fixes from the above
- `run_tests.sh` — added the `test_sd_logger` TSAN pass, `-lpthread`
- `docs/archive/gps_rf_mutex_status.md` — the full turn-by-turn history of this
  investigation (more granular than this summary)

## Raw evidence (data files, not code — not part of the revert)

- `tracks/biomap_118.csv` — first same-row `flush_peak_ms`/`tick_dt_ms`
  confirmation, and the first (milder) sighting of the 2Hz oscillation
- `tracks/biomap_119.csv` — post-writer-thread, stalls still
  flush-cadence-aligned
- `tracks/biomap_121.csv` + `tracks/seriallog.txt` — the paired CSV/serial
  capture that directly proved the writer thread wasn't insulating the
  main thread, and where the 6.4s unrelated cluster was found
- `tracks/biomap_122.csv` + `tracks/seriallog2.txt` — the post-priority-change
  re-test showing partial, incomplete improvement
