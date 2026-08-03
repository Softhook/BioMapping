# Host-Side Testing

> **Living document.** Update the "Status" section as coverage changes.
> Referenced from: `tests/shims/furi_hal.h`, `run_tests.sh`.

## What this is

Some firmware source files can be compiled and unit-tested on a Mac/Linux
host compiler (`gcc`) instead of the Flipper Zero ARM toolchain, without
touching real hardware. `run_tests.sh` builds and runs all of it.

## Running modes

Use the harness in two modes so it stays practical during day-to-day work:

- `./run_tests.sh --quick`
: Fast local pass, skips the ThreadSanitizer binary.
- `./run_tests.sh --full`
: Full suite, including ThreadSanitizer (default).

Equivalent env toggles:

- `RUN_TESTS_MODE=quick ./run_tests.sh`
- `RUN_TESTS_TSAN=no ./run_tests.sh`

Run `./run_tests.sh --help` for all options.

There are two different techniques in play, depending on whether the file
touches hardware:

### 1. Pure logic — no shimming needed

`biomap_pipeline.c` (and the types/constants it depends on in
`biomap_types.h`) has zero Flipper SDK includes — it's just math (IIR
filter, EMA smoothing, calibration fitting, CSV formatting) operating on
plain structs. It compiles on a host compiler exactly as it ships to the
device. `tests/test_firmware.c` links it directly.

### 2. Driver code — shim the SDK itself, not the driver

`modules/gps_uart.c` calls the real Flipper SDK directly —
`furi_hal_serial_*`, `furi_mutex_*`, `furi_stream_buffer_*`,
`furi_message_queue_put`, `furi_get_tick`, `FURI_LOG_*`, `expansion_*` —
same as what ships in the Flipper build. **The driver file is not written
against any custom interface.** For host tests, `tests/shims/` provides
fake headers with the same names and signatures as the real SDK
(`furi.h`, `furi_hal.h`, `expansion/expansion.h`) so that when
`gps_uart.c`'s `#include <furi_hal.h>` resolves during a host compile, it
picks up the fake instead of the real thing (via `-I tests/shims` placed
ahead of everything else on the include path — see `run_tests.sh`).
`tests/shims/furi_hal_mock.c` simulates a single USART1 peripheral well
enough that a test can inject bytes as if they'd arrived from the ISR
(`furi_hal_mock_feed_byte`/`_string`), and the real, unmodified
`gps_uart_process_rx()` drains and parses them for real.

`modules/gsr_sensor.c` needs one more piece: it owns a real background
`FuriThread` that polls I2C continuously and writes into a ring buffer the
main thread's `gsr_sensor_tick()` reads from. A single-threaded fake
wouldn't exercise any of that — `FuriMutex` and `FuriThread` in
`tests/shims/furi.h` are backed by real `pthread`s, and the I2C mock in
`furi_hal_mock.c` is fully atomic, so the real worker thread runs
concurrently with the test's main thread, same as it does on device.

---

## Why this instead of a custom HAL layer

An earlier version of this (2026-07-22) went a different way: `gps_uart.c`
and `gsr_sensor.c` were rewritten against custom interfaces
(`modules/hal_uart.h`, `hal_i2c.h`, `hal_time.h`) with a `_flipper.c`
backend implementing each one, so a second MCU target could in principle
swap in its own backend file. That's a real portability mechanism, but it
came at a cost that turned out not to be worth paying yet: **6 new
production files** across two peripherals, plus a parallel set of test
mocks for the custom interfaces — 12 new files total, none of which map
onto anything a reader familiar with the Flipper SDK would recognize.

Reverted the same day in favour of what's described above: fake the SDK,
not the driver. Net result for `modules/`: **zero new files** — `gps_uart.c`
looks exactly like it did before any of this started. The cost moved
entirely into `tests/`, and even there it's now shaped like the real SDK
(`furi.h`, `furi_hal.h`) rather than a bespoke interface only this project
has.

**Be clear about the trade-off this makes:** this does *not* give you
"swap one file to target a different MCU." A future port to different
hardware means rewriting `gps_uart.c`'s `furi_hal_serial_*` calls directly,
same as any file that's never been touched (`gsr_sensor.c`, `sd_logger.c`,
`sound.h`). What it *does* give you is confidence that the parsing/protocol
logic is correct — verified by tests that exercise the real driver code —
independent of whether the firmware ever targets a different MCU. If actual
MCU portability becomes a goal again, that's a separate, larger effort with
its own design questions (probably closer to what the reverted approach was
trying to do) — this document doesn't claim to deliver it, and no file here
should be read as a step toward it.

---

## Directory map

```
modules/                       — unchanged, no test-only content, no HAL files
  gps_uart.h / .c               — NMEA parsing + framing, calls furi_hal_serial_* directly
  gsr_sensor.h / .c             — ADS1115 I2C + PGA autoranging, calls furi_hal_i2c_*/FuriThread directly
  sd_logger.h / .c              — auto-indexing CSV writer, calls Storage/File directly
  sound.h                       — untested

tests/
  test_firmware.c               — pipeline / calibration / CSV host tests
  test_gps_uart.c                — gps_uart.c host tests, via the shims below
  test_gsr_sensor.c              — gsr_sensor.c host tests, real worker thread + all
  test_sd_logger.c               — sd_logger.c host tests, via an in-memory
                                   virtual filesystem (storage_mock.c)
  analyze_gsr_filtering.c        — investigative tool, not pass/fail: measures
                                   the real IIR+EMA frequency response and the
                                   boxcar mains-notch's rate sensitivity. See
                                   docs/gsr_filtering_analysis.md.
  shims/
    furi.h                      — fakes the Furi-core calls these drivers make
                                   directly: mutex + thread (real pthreads —
                                   see "Why this instead" below), stream buffer,
                                   message queue, log, tick, record registry
    furi_hal.h / furi_hal_mock.c — fakes furi_hal_serial_* (one simulated
                                   USART1) and furi_hal_i2c_* (one simulated
                                   I2C bus/ADS1115), plus both test-injection APIs
    storage/storage.h / storage_mock.c — fakes storage_file_*/storage_dir_*
                                   with a real in-memory filesystem (paths ->
                                   byte buffers), plus test-injection APIs to
                                   pre-seed files and force open/write failures
    expansion/expansion.h       — no-op stub (gps_uart.c disables/re-enables
                                   the Expansion Service around USART1)
    input/input.h                — InputEvent stub (only needed because
                                   biomap_events.h pulls it in)
    notification/notification_messages.h — opaque NotificationApp stub

run_tests.sh                    — builds + runs all four host test binaries
```

---

## How to add a shim for another driver

Same idea, whatever peripheral it is:

1. Look at exactly which SDK functions the driver calls directly (e.g.
   `gsr_sensor.c` calls `furi_hal_i2c_acquire/read_mem/write_mem/release`
   plus `FuriThread`/`FuriMutex`).
2. Declare fakes for those, with the **same names and signatures as the
   real SDK** (check `~/.ufbt/current/sdk_headers/.../api_symbols.csv` for
   exact signatures — don't guess), in the matching shim header
   (`furi_hal.h` for `furi_hal_*` calls, extend `furi.h` for core Furi
   calls). Don't invent a new interface name — the whole point is that the
   driver file needs zero changes.
3. Implement the fake in a `_mock.c`, with real behaviour where it matters
   (the existing `furi.h` shim's `FuriStreamBuffer` is a genuine ring
   buffer, not a stub, because `gps_uart.c`'s RX framing logic depends on
   real partial-read semantics) and a test-injection API for whatever the
   test needs to control (a byte arriving, a register value, ...).
4. Write `tests/test_<driver>.c` against the driver's real public API and
   add it to `run_tests.sh`.
5. If the driver owns a background thread, decide whether the behaviour
   worth testing actually lives inside that thread. For `gsr_sensor.c` it
   does (autoranging, TIA conversion, and disconnect debounce all run
   inside the worker) — `tests/shims/furi.h`'s `FuriThread`/`FuriMutex` are
   real `pthread`s for exactly this reason, and any mock state the worker
   touches concurrently with the test (see `furi_hal_i2c_mock_*` in
   `furi_hal_mock.c`) must be atomic or otherwise properly synchronized —
   this is genuine concurrency, not single-threaded convenience. Because
   `furi_delay_ms()` is a no-op in the shim, a worker loop built around it
   spins essentially unthrottled; don't synchronize a test against it with
   a guessed `sleep()` duration — poll an atomic counter the mock
   increments (`wait_for_more_reads()` in `test_gsr_sensor.c`) until the
   worker has demonstrably done enough work, with a generous timeout that
   turns "something is broken" into a clear assertion failure instead of
   an indefinite hang.

---

## Status

| File | Touches hardware | Host-tested |
|---|---|---|
| `biomap_pipeline.c` | No | ✅ `tests/test_firmware.c` (33 tests) |
| `modules/gps_uart.c` | Yes (`furi_hal_serial_*`) | ✅ `tests/test_gps_uart.c` (14 tests) |
| `modules/gsr_sensor.c` | Yes (`furi_hal_i2c_*`, real `FuriThread`) | ✅ `tests/test_gsr_sensor.c` (9 tests) |
| `modules/sd_logger.c` | Yes (`Storage`/`File`) | ✅ `tests/test_sd_logger.c` (12 tests) |
| `modules/sound.h` | Yes (`furi_hal_speaker_*`) | ❌ |

`test_gps_uart.c` covers every NMEA sentence type `gps_uart_parse_line()`
dispatches on (RMC, GGA, GSA — including SBAS PRN detection, GSV —
elevation array + `gsv_fresh`, GLL — valid and void status), the
RX-buffer-full reinit path, the 5 s NMEA watchdog reinit, hot start,
standby, split-line buffering, and malformed/unrecognised input. Not
covered: the L76K-specific PCAS command path — `biomap_config.h` compiles
this firmware for M10Q only, so that `#if` branch isn't even part of this
binary; testing it would mean building a second variant with `GPS_MODULE`
flipped, not done here. Every sentence fixture's checksum was verified
with a throwaway `minmea_checksum()` probe before use, not hand-computed —
see the checksum bug below for why that matters.

`test_firmware.c` (extended 2026-07-24) now also covers `pipeline_update_graph`
(scroll-divider gating of the ring-buffer write, buffer wraparound, manual-zoom
timeout countdown/expiry with the peak reset that avoids a visual jump, the
`ZOOM_PEAK_FLOOR` clamp, and peak growth on a rising signal), `pipeline_unix_epoch`
(leap years, the century-non-leap-year rule, the RTC-unset sentinel, and
out-of-range month/day guards), `pipeline_rel_seconds`, and the `gps_year_expand`
Y2K pivot helper — previously declared and shipped but with zero test coverage.

`test_gsr_sensor.c` (added 2026-07-22, reversing the earlier decision to
skip it) covers: ADS1115 probe success/failure at `alloc()`, TIA
conversion against an independently-computed expected value, calibration
gain/offset application, PGA autoranging in both directions (5-tick
hysteresis ranging up, immediate ranging down on saturation), PGA lock
suppressing autoranging, and both disconnect paths — the `tick()`-level
20-consecutive-out-of-range debounce, and the worker-level
50-consecutive-I2C-failure trip, which are genuinely different code paths
(one runs on the main thread reading `raw`, the other runs inside the
worker reacting to transport failures) and needed separate tests. This
required the `pthread`-backed `FuriThread`/`FuriMutex` upgrade described
above — the real worker thread runs for every one of these tests, not a
stub standing in for it.

This checksum bug and this header-hygiene bug are why `test_gps_uart.c`
exists at all, not just a compiling build:

- **Bad NMEA checksum in a test fixture.** The GGA sentence
  `tests/test_firmware.c` uses for `test_nmea_parsing` had checksum `*50`;
  the real XOR is `*6C`. That test calls `minmea_parse_gga()` directly,
  bypassing the checksum check `gps_uart.c`'s real dispatch
  (`minmea_sentence_id()` → `minmea_check()`) performs — so it never
  noticed. `test_gps_uart.c` drives the real dispatch and caught it
  immediately. Both fixtures are now fixed.
- **Hidden transitive `#include`.** `gsr_sensor.c` never included
  `<furi.h>` itself — it only compiled because `gsr_sensor.h` happened to
  include it, and every `.c` file that includes the header got `furi.h`
  along for free. Removing the unused include from the header (while
  cleaning up the now-abandoned I2C HAL seam) broke the build immediately.
  Fixed by including `<furi.h>` where it's actually used.

Both were caught by actually compiling and running code, not by reviewing
a diff — the practical argument for this whole approach.

`test_sd_logger.c` (added 2026-07-24) drives the real `sd_logger.c` against
`storage_mock.c`, a genuine in-memory filesystem (paths mapped to growable
byte buffers) rather than a stub that always succeeds — `find_next_index()`'s
directory scan and the batch-write path both need real read-back behaviour
to be worth testing. Covers: auto-incrementing file index (first file, next
free index skipping gaps, wraparound past `LOGGER_MAX_INDEX` back to 001),
the distinct "directory doesn't exist yet" vs. "open fails" vs. "header
write fails" failure paths in `open_log_file()` (each must leave the logger
cleanly inactive, not half-open), `sd_logger_stop()` returning the logger to
a reusable state, the batch append/printf/flush round trip actually landing
bytes on "disk", and — driving the real function this time, not the
`test_firmware.c` mirror — `sd_logger_batch_printf()`'s truncation rollback
and `sd_logger_batch_append()`'s overflow rejection. `storage_sd_api.h`
pulling in `<furi.h>` transitively is the same "hidden transitive include"
shape as the `gsr_sensor.c` bug above; the shim's `storage/storage.h`
replicates it (`#include <furi.h>`) so `sd_logger.c` needs zero changes.

This surfaced a production bug, since fixed (2026-07-24): `sd_logger_batch_flush()`
used to zero `gsr_batch_len` right after the `storage_file_write()` call
regardless of whether the write actually succeeded, so a failed flush (e.g.
a full SD card) silently discarded the batch instead of leaving it for a
retry. It now only clears the buffer on confirmed success — see the
comment above `sd_logger_batch_flush()` in `modules/sd_logger.c`.
`test_sd_logger.c`'s `test_sd_logger_batch_flush_failure_preserves_buffer_for_retry`
asserts on this directly: fail a write, append more data on top, recover,
and confirm both the pre- and post-failure rows land on disk.

That fix only matters if callers actually retry, so `biomap_session.c` was
also audited: of its five `sd_logger_batch_flush()` call sites, two
(the periodic mid-recording flush in `handle_second_boundary`, and the
emergency flush on batch overflow) already checked the return value and
react to failure by stopping the recording with a red LED + warning tone —
deliberately not retried, since the batch buffer only holds ~5 s of
headroom, so retrying instead of stopping just delays the same outcome
while risking a worse, partial-row loss once appends start overflowing.
The other three — `session_deinit`, `key_toggle_recording`'s stop path, and
the Back-key stop path in `handle_recording_key` — are all *final* flushes
on a normal, user-initiated stop, and none of them checked the result. That
meant a failed final flush was indistinguishable from a clean stop: same
"recording stopped" tone, silently short file. All three now go through a
shared `flush_before_stop()` helper that retries once (covers a transient
SD-busy blip) and, if still failing, plays `biomap_sound_warning()` instead
of the ordinary stop chirp so a failed final flush is audibly distinct
from a clean stop. No host test exists for `biomap_session.c` itself (it's Flipper-SDK-heavy,
not pipeline-pure), so this path was verified by a full `ufbt build` rather
than a host test.

`modules/sound.h` (`furi_hal_speaker_*`) remains the one hardware-touching
file with no host test — it's a thin beep/tone wrapper with little logic
of its own to verify beyond "did it call the right SDK function."
