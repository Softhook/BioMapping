# Host-Side Testing

> **Living document.** Update the "Status" section as coverage changes.
> Referenced from: `tests/shims/furi_hal.h`, `run_tests.sh`.

## What this is

Some firmware source files can be compiled and unit-tested on a Mac/Linux
host compiler (`gcc`) instead of the Flipper Zero ARM toolchain, without
touching real hardware. `run_tests.sh` builds and runs all of it.

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
  gsr_sensor.h / .c             — ADS1115 I2C, calls furi_hal_i2c_* directly (untested — see Status)
  sd_logger.h / .c, sound.h     — untested

tests/
  test_firmware.c               — pipeline / calibration / CSV host tests
  test_gps_uart.c                — gps_uart.c host tests, via the shims below
  shims/
    furi.h                      — fakes the Furi-core calls gps_uart.c makes
                                   directly (mutex, stream buffer, message
                                   queue, log, tick, record registry)
    furi_hal.h / furi_hal_mock.c — fakes furi_hal_serial_* (one simulated
                                   USART1) + the test-injection API
    expansion/expansion.h       — no-op stub (gps_uart.c disables/re-enables
                                   the Expansion Service around USART1)
    input/input.h                — InputEvent stub (only needed because
                                   biomap_events.h pulls it in)
    notification/notification_messages.h — opaque NotificationApp stub

run_tests.sh                    — builds + runs both host test binaries
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
5. If the driver owns a background thread (like `gsr_sensor.c`'s worker),
   think hard before faking `FuriThread` for real concurrency — that's a
   bigger step (see Status below for why `gsr_sensor.c` doesn't have this
   yet).

---

## Status

| File | Touches hardware | Host-tested |
|---|---|---|
| `biomap_pipeline.c` | No | ✅ `tests/test_firmware.c` |
| `modules/gps_uart.c` | Yes (`furi_hal_serial_*`) | ✅ `tests/test_gps_uart.c` |
| `modules/gsr_sensor.c` | Yes (`furi_hal_i2c_*`, `FuriThread`) | ❌ — see below |
| `modules/sd_logger.c` | Yes (`Storage`/`File`) | ❌ |
| `modules/sound.h` | Yes (`furi_hal_speaker_*`) | ❌ |

`gsr_sensor.c` is deliberately untested (decided 2026-07-22, unchanged by
the HAL-layer revert). Its interesting behaviour — PGA autoranging, TIA
conversion, disconnect debounce — only runs inside a background
`FuriThread` that polls I2C at ~1 kHz and writes into a ring buffer the
main-thread `tick()` reads from. Testing it for real means faking
`FuriThread`/`FuriMutex` with actual concurrency (e.g. `pthread`) so the
real worker runs against a fake I2C peripheral — a bigger step than
`gps_uart.c`'s single-threaded byte-feeding, and judged not worth it yet.
The I2C code is verified only by the real `ufbt` build.

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
