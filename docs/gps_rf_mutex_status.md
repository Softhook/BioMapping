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
2. **The flush is synchronous on the main event-loop thread** (`run_recording_session()`'s Tick handler, `biomap_session.c`) — released from `app->mutex` first, but still on the thread that must then process the next Tick, drain GPS UART, and pace `view_port_update()`. The card being occasionally slow is normal; the whole app stalling because of it is a consequence of waiting for that call in-line on the one thread everything else depends on.
3. **The batch file grows by repeated `storage_file_write()` appends with no pre-allocation** (`sd_logger_batch_flush()`) — a flush that crosses a FAT cluster boundary also forces a FAT-table/directory-entry update at a different physical location on the card than the data itself, on top of the ~12KB data write.

**How other projects handle the same symptom** — none of them make the stall itself go away (it's the card's firmware, out of anyone's control); they all work around it:

- **Move the write off the time-critical path.** PX4's logger is its own dedicated module, not code running inline in the flight-control loop — the real-time-sensitive work is structurally isolated from SD I/O latency, so a slow `fsync` costs the logger a buffer, not the aircraft a control tick. Direct analogue here: item 2 above (flush on the main/GUI/input thread) is the one architectural choice with a real fix — moving `sd_logger_batch_flush()` onto its own worker thread would mean a slow flush delays the next SD write, not the next Tick/GPS-drain/redraw. This has NOT been implemented — noted here as the option, not a decision.
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

**A. Move the flush to a dedicated background thread** (the PX4-style fix).
Give the logger its own Furi thread that owns the SD file; the Tick
handler swaps a filled buffer into a queue instead of calling
`sd_logger_batch_flush()` itself. A slow `storage_file_write`/`sync` then
only delays the *next* SD write, never the Tick/GUI/UART path. This is the
only option that eliminates the freeze mechanism rather than reducing its
odds — but it's also the highest-effort, highest-risk option: needs
double-buffering (main thread keeps filling a fresh buffer while the
worker flushes the previous one), a handoff mechanism, and `SdLogger`
currently assumes a single caller thread, an assumption this would break.

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
(one `#define`), and now directly measurable with `flush_peak_ms` already
in place — could A/B a couple of values against real walks.

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

**Suggested order of attack**: try F first (cheap, might make this moot),
tune D a little while at it since it's nearly free, then treat something
like A as the real structural fix only if the freeze turns out to cost
something concrete (dropped GPS bytes, UART overflow) that justifies a
threading rework — right now it's a felt freeze, not a proven data-loss
problem, based on what's been measured so far.

### 2026-08-05: track 015 recorded — a real, distinct bug found (buffer-margin exhaustion, not the SD-stall mechanism above), fixed

Track 015 (1515s, the first recording made after the full `BIOMAP_DEBUG_FIELDS`
column set landed) showed `log_overflow_count` climbing by exactly 1 every
~10.0s from t=1009s (66% through the walk) to the end, never recovering —
one dropped sample per `FLUSH_INTERVAL` cycle for the last ~500s. This is
**not** the SD-write/sync stall documented above (that's inherent SD-over-SPI
latency); this is a fixed-size batch buffer with almost no real margin.

Root cause: `sd_logger.c`'s `gsr_batch` was sized (12288 bytes) against a
"~110-125 bytes/row typical case" estimate — only ~5 bytes/row of headroom
over its own best case. Several `BIOMAP_DEBUG_FIELDS` columns are lifetime
peak-hold/cumulative counters printed as bare `%u` (`log_fill_peak_bytes`,
`flush_peak_ms`, `log_overflow_count`) that gain digits as a recording runs
longer — each digit gained costs the shared buffer 100 bytes/cycle (100
rows/flush). Measured directly from the CSV: cycle totals crept from
11753 bytes (t=0) to 12283 bytes (cycle 99) and crossed the 12288 cap at
cycle 100 (row 10089) — and once `log_overflow_count` itself gained a digit
(crossing 9→10), that made the overflow self-reinforcing rather than
self-correcting.

**Fix**: `gsr_batch` doubled to 24576 bytes (`modules/sd_logger.c`), sized
against a ~169 bytes/row worst-case estimate (generous per-field digit
bounds) × 100 rows, with real margin left over for future columns. Same
total footprint as the double-buffered `gsr_batch[2][12288]` tried and
reverted earlier (`7e4bc3a`) — already proven to fit the Flipper's RAM.
Verified: full host test suite (`SD_LOGGER_BATCH_CAP` in
`tests/test_sd_logger.c` updated to match) and a real ARM toolchain build,
both clean.

### 2026-08-05: debug-field and serial-logging review — dead fields removed, three new CSV columns added

Prompted by the track 015 investigation above, reviewed every `RowDiag`/CSV
debug column and every `FURI_LOG_*`/`SD_LOG_*` call in the firmware for
whether it's actually reachable by post-hoc analysis — the channel every
real finding in this document has come from — versus serial-only (a channel
this project has never once used to diagnose a real issue).

**Removed** (serial-only, fully redundant with data already in the CSV,
zero test coverage found for any of them): `tick_dt_max_ms`,
`tick_over_150_count`, `tick_over_250_count`, `tick_over_500_count`
(`RecordingState`, `biomap_types.h`) — a windowed max and bucket counts
derived from `tick_dt_ms`, which is already logged raw every row; and
`flush_last_ms`/`flush_window_max_ms` (`sd_logger.c`/`.h`) — redundant with
`flush_peak_ms`'s own row-by-row progression in the CSV (see the track 118
entry above, which found the exact row a new worst flush occurred at using
exactly that column).

**Added** to `RowDiag`/CSV (`biomap_types.h`, `biomap_config.h`,
`biomap_session.c`): `gps_reinit_count` (new counter, `gps_uart.c`/`.h`,
mirrors `gps_rx_drops`/`nmea_fail`'s pattern exactly — increments once in
`gps_uart_reinit()`, covering both its call sites: RX-buffer-full and the
5s NMEA watchdog) so a GPS quality drop is no longer indistinguishable from
"the module got power-cycled N times"; and `pga_change_count`/
`i2c_consec_fail` (`gsr_sensor.c` — already-existing accessors, already
computed unconditionally in every mode, just never wired into the CSV)
directly explaining gain-change waveform artifacts and I2C/electrode
dropouts. Covered by new assertions in `tests/test_gps_uart.c`
(`test_rx_buffer_overflow_reconfigures`, `test_nmea_watchdog_reconfigures`)
and updated `tests/test_firmware.c` CSV-formatting/column-count tests.

**Deliberately not added** (real value, but not a clean same-pass fit):
`mains_hum_mag` — mode-gated for genuine CPU cost (2 trig calls × ~100
samples/tick), and Diagnostics mode currently shares `GPS_GSR_RF`'s CSV
header, so logging it there would print a misleading `0.0` for every
non-Diagnostics recording that never computes it. Needs a Diagnostics-
specific header variant first. `success_rate`/`duplicate_rate`/`stale_rate`
— pre-averaged ~1s rolling windows with no raw-count accessor to log
instead; promoting the rates would repeat the exact "log the bucket, not
the raw signal" mistake the removed `tick_over_*_count` fields made.
`gsr_raw`'s own repeat pattern in the CSV already partially covers
duplicate/stale detection in the meantime.

Full host test suite and a real ARM toolchain build both verified clean
after every change above.

### 2026-08-05: `BIOMAP_DEBUG_FIELDS` converted to a runtime Options toggle — introduced, then fixed, a real mutex-touch regression on the tick path

Requested change: stop requiring a firmware rebuild to see the debug CSV
columns above. `BIOMAP_DEBUG_FIELDS` (compile-time `#define`) replaced with
`BioMapApp::debug_fields_enabled` — a persisted Options-menu toggle
("Debug Fields"), **off by default**, snapshotted into
`Session::debug_fields_enabled` at `session_init()` (same lifecycle as
`zoom_enabled`). Both the `_PROD` and `_DEBUG` CSV column variants
(`biomap_config.h`) are now always compiled in; `key_toggle_recording()`
picks between them per-session from the runtime flag. Measured cost of
compiling both permanently: +536 bytes (~0.6%) `.fap` size — negligible.

**A real regression was introduced and then caught by review, directly
relevant to this document's whole subject.** `get_row_diag()`
(`biomap_session.c`) reads several `gsr_sensor_get_*()` accessors that
acquire `gsr->mutex`/`gsr->rf_mutex` (`worker_hz`, `i2c_peak_ms`,
`pga_change_count`, `consecutive_failures`, `rf_rssi_peak_ms`,
`rf_retune_peak_ms`). The first pass at the runtime conversion called it
**unconditionally** at three sites — `batch_csv_row()` and
`handle_recording_tick()`'s GPS-only branch (both 10 Hz, every recording
tick) and the 1 Hz heartbeat/telemetry block — regardless of
`debug_fields_enabled`. Under the old `BIOMAP_DEBUG_FIELDS=0` compile-time
build this code didn't exist at all; under the new runtime toggle, turning
Debug Fields **off (the default)** still touched these mutexes every tick,
computed a full `RowDiag`, and threw it away unused.

Checked whether this reintroduces the original bug this document is about
(RF SPI held across a mutex the main thread needs): it does not — every
`furi_hal_i2c_*` call in `gsr_sensor_worker()` releases `gsr->mutex` before
the hardware call, confirmed by direct read, so there's no long-hold-then-
block risk. But it's still real, unnecessary contention-surface on the
exact path this document has scrutinized more than any other, for zero
benefit in the default (off) configuration.

**Fix**: all three sites now read
`s->debug_fields_enabled ? get_row_diag(s) : (RowDiag){0}` (the 1 Hz
telemetry site additionally only enters its block — and only emits the
"telemetry" log line — when `debug_fields_enabled` is true). A second
review pass caught that the neighboring 1 Hz **heartbeat** block (heap/
stack introspection: `memmgr_get_free_heap()`, `furi_thread_get_stack_space()`,
`gsr_sensor_get_stack_space()`) had been left unconditional on the reasoning
that it touches no mutex — true, but beside the point: under the old
`BIOMAP_DEBUG_FIELDS=0` build neither heartbeat nor telemetry existed at
all, so "off" should mean the same zero-cost thing at runtime for both, not
just the mutex-touching half. Heartbeat is now gated identically to
telemetry. Verified: 3 consecutive clean host test runs and a clean ARM
toolchain build (confirmed against the project's real flag bar — `-Wall
-Wextra -Werror -Wredundant-decls -Wdouble-promotion -Wundef` etc., read
directly out of `compile_commands.json`, not assumed) after each fix,
including this final one.

**Known gap, not closed**: no host test can catch a regression like this.
`tests/test_firmware.c` exercises `format_gps_csv_row()` via a hand-
mirrored copy (documented as "mirrored, not linked" — the real
`biomap_session.c` needs the full Flipper SDK the host harness doesn't
provide), so it never calls the real `batch_csv_row()`/`get_row_diag()`/
`gsr_sensor_get_*()` accessors and structurally can't observe whether they
were skipped. This class of bug — an expensive call hiding behind a flag
that should but doesn't gate it — can currently only be caught by manual
review of this exact call-site pattern, not automated tests.

### 2026-08-05: track 016 recorded — buffer-margin fix holds, but the SD-flush stall now shows a within-recording progressive trend, not just isolated spikes

Track 016 (3546.6s / 59 min, 35,467 rows @ 10Hz, GPS+GSR+RF) is the first
full-length recording made since the track 015 buffer fix and the debug-field
additions above. Two findings, one reassuring and one new.

**Buffer-margin fix confirmed working.** `log_fill_peak_bytes` tops out at
13,066 of the 24,576-byte `gsr_batch` (53%), and `log_overflow_count`/
`log_flush_fail_count` both stay at 0 for the entire recording — no repeat
of track 015's overflow bug, real headroom left over.

**SD-flush stall reproduced, with a new pattern.** Same mechanism as tracks
116-118 (`flush_peak_ms` jump landing exactly on a `FLUSH_INTERVAL` boundary,
`i2c_peak_ms`/`rf_rssi_peak_ms`/`rf_retune_peak_ms` flat at the same row,
ruling those three out again). What's new is that the *baseline* flush cost
climbs over the course of this one continuous recording rather than jumping
once and holding steady:

- t=0-1220s: flush-boundary `tick_dt_ms` averages 94ms; `flush_peak_ms`
  (lifetime-max) plateaus at 152ms after the startup ramp
- t=1226s and t=1236s (back-to-back, one `FLUSH_INTERVAL` apart):
  `flush_peak_ms` steps 152→203→231ms, `tick_dt_ms` spikes to 208ms then 237ms
- t=2326-2336s: another spike (206ms, 224ms `tick_dt_ms`), `flush_peak_ms`
  already saturated at 231ms so no further lifetime-max movement
- From ~t=2350s to the end: the *baseline* itself keeps drifting up rather
  than settling back to the ~94-150ms pre-1220s range — by t>3000s,
  flush-boundary `tick_dt_ms` averages 162.6ms (max 203ms), ~70% above the
  early-recording average, and closing in on the 231ms lifetime peak

Worst single stall this track: 237ms (row 12360, t=1236.0s) — well under
track 118's 949-957ms outliers, and under item 6's ~250ms "no data loss,
self-correcting" threshold below. No overflow resulted; the 24,576-byte
buffer's real margin absorbed it. Consistent with mitigation option E's
FAT-cluster/write-amplification theory (line 362) — cost rising with file
size rather than one-off SD housekeeping — though a single track can't rule
out a card-specific effect (option F) instead.

**Not yet done**: no second long (~1hr+) track exists yet to confirm this
drift continues past 3546s rather than plateauing; the mechanism (and
whether it's file-size-driven vs. time-driven) is inferred from this one
recording, not confirmed by a repeat.

### 2026-08-05: option E ("pre-allocate the log file") researched and prototyped — rolling chunk approach recommended, not yet integrated

Follow-up to track 016's progressive-drift finding above: growing cost with
file size is the textbook signature of FAT fragmentation on repeated small
appends, not random SD jitter — confirmed against outside sources rather
than assumed. An embedded-logger writeup measured *"this card was formatted
with 32kb clusters... this results in 16 separate transactions. Every one of
these transactions incurs a 1ms write time when the card is busy"*
([SD optimisations, Hackaday.io](https://hackaday.io/project/160928-boson-frame-grabber/log/153612-sd-optimisations)),
and general SD-datalogging guidance treats pre-allocating the file's
expected size as standard practice specifically to avoid this
(*"reduces file-system metadata updates and mitigates performance noise due
to incremental extent allocation"* — see search summary in the conversation
this entry is drawn from; no single authoritative page, general consensus
across Arduino/Teensy datalogging forums).

**FatFs's purpose-built primitive for this, `f_expand()`, is not reachable
from a Flipper app.** Grepped the full app SDK (`~/.ufbt/current/sdk_headers/`
— every header shipped for building a `.fap`): no `f_expand` binding
anywhere, and `File` is declared as an opaque `typedef struct File File;`
with no member definition in any public header, so there's no way to reach
past the wrapper to a raw FatFs `FIL*` either — not just restricted to
built-in apps, structurally absent from the SDK surface. (A separate
"extract the internal FatFs handle via `storage_file_get_internal_pointer`"
idea floated during this same investigation doesn't hold up either — that
function doesn't exist anywhere in the SDK, and Flipper's storage subsystem
is a service the app talks to, not a direct synchronous FatFs wrapper it
could safely cast into even with firmware source access.)

**The one primitive actually available — `storage_file_seek()` past the
current file size — does work, confirmed against FatFs's own documentation**
([f_lseek](https://raw.githubusercontent.com/abbrev/fatfs/master/documents/doc/lseek.html)):
seeking past EOF in write mode expands the file size immediately, inside
that call (real allocation cost, real place to attribute a stall to), but
*"the file data in the expanded part is undefined... because no data is
written to the file in this process"* — not zero-filled. That has one
concrete implication for any real implementation: **the pre-allocated tail
must be trimmed with `storage_file_truncate()` before closing the file**, or
every track ends with a trailing block of garbage bytes past the real CSV
rows. Easy to do (`storage_file_truncate()` exists in the SDK), easy to
forget silently.

**Once vs. rolling**: a one-shot pre-allocation at recording start was
rejected as a poor fit — BioMapping tracks are stopped by the user, not
fixed-length (track 016 ran 59 min, track 015 ran 25 min), so any fixed
guess either wastes SD space or silently falls back to normal fragmented
growth once exceeded, with no signal that happened. A rolling/chunked
approach (extend by a fixed amount whenever headroom ahead of the real
write position drops low, checked once per flush cycle) fits an open-ended
recording without guessing a final size.

**Prototyped and tested** (`tests/test_sd_logger_prealloc.c`,
`tests/shims/storage/storage.h`/`storage_mock.c`) — a standalone
experiment, deliberately **not** wired into `modules/sd_logger.c` or the
live recording path (`biomap_session.c`), operating directly on the
Storage/File mock rather than through `SdLogger`'s public API. Added
`storage_file_seek`/`_tell`/`_truncate`/`_size` to the mock (previously
absent — nothing in `sd_logger.c` had ever called them), matching real
FatFs semantics including the undefined-content-on-expand behaviour above,
plus a `storage_mock_set_next_seek_extend_delay_ticks()` hook mirroring the
existing write-delay hook so a future test can model the allocation stall's
actual duration. Five tests, all passing:

- extension only triggers when headroom drops below the low-water mark, not on every check
- the real write position (and already-written data either side of an extension) survives an extension untouched — proves the seek-out-and-rewind pattern doesn't corrupt or gap the file
- skipping the truncate-at-stop step reproduces the garbage-tail drawback concretely (file padded to the full pre-allocated chunk, not the real bytes written) — a regression test for the exact mistake the naive version of this idea would make
- **the frequency claim, measured, not estimated**: simulating 800 flush cycles at track 016's own measured ~13,000 bytes/10s-cycle rate with a 1 MiB rolling chunk produced **11 extension events instead of up to 800** — a ~73x reduction in how often the allocation-cost path runs
- the seek-extend delay hook fires only on a real extension, not on every headroom check (needed so a later test can distinguish "how many times did this pay a cost" from "how many times was this merely checked")

**Not done**: real integration into `sd_logger.c`/`biomap_session.c`, and no
measurement yet of what a single extension call actually costs on real
hardware (the open question flagged in the earlier conversation — a 1 MiB
extension might itself be a non-trivial stall, and that determines whether
73x-fewer-but-individually-bigger stalls is actually a net win over
today's every-10s-but-small pattern). That's the next thing to measure
before deciding whether to integrate this for real.

### 2026-08-05: one-shot pre-allocation integrated for real (`BIOMAP_SD_PREALLOC`), pending on-device verification

Follow-up to the rolling-chunk prototype above: given the user's actual walk
lengths (20 min to just over an hour), track 016's own measured rate
(~72.04 KiB/min, computed from its real 4,360,599-byte file size / 3546.6s)
puts a realistic file at 1.4-6.3 MiB — small enough that a single upfront
pre-allocation sized for ~90 minutes covers nearly every real walk in one
allocation event, simpler than the rolling chunk for this project's actual
usage pattern. Implemented for real (not a prototype) to let the user test
it via `python3 -m ufbt` + flashing to their own device:

- `modules/sd_logger.c`: `SD_LOGGER_PREALLOC_BYTES` (8 MiB — ~90 min +
  margin). `open_log_file()` calls new `preallocate_log_file()` right after
  the header write+sync: `storage_file_seek()` past current EOF (the size-
  extend happens immediately, inside that call, real allocation cost timed
  with `furi_get_tick()`), then always rewinds to the real data boundary so
  the first batch flush lands contiguously. A seek that fails outright
  (disk-full fallback) is handled gracefully — recording continues with
  today's plain-append behavior rather than failing to start.
  `sd_logger_stop()` now calls `storage_file_truncate()` before closing,
  trimming the unused (undefined-content) tail back to the real data
  length — safe unconditionally, since batch flushes always leave the file
  position at the real end of data, so truncating to the current position
  is a no-op when nothing grew past it.
- New session-constant telemetry field `prealloc_ms` (`sd_logger_get_prealloc_ms()`,
  `RowDiag`, new CSV column in all three DEBUG schemas) — how long the
  one-shot pre-allocation took, the number needed to answer whether this is
  a net win over today's small-but-constant pattern.
- `biomap_config.h`'s new `BIOMAP_SD_PREALLOC` (default **1**, on) is a
  clean A/B switch, same shape as the existing `BIOMAP_SD_DRY_RUN` — flip to
  0 and rebuild for a same-device control walk if the comparison needs one.
- Six new host tests (`tests/test_sd_logger.c`) exercise the real,
  production `sd_logger_start()`/`sd_logger_stop()` path end to end:
  pre-allocation happens immediately at start, the tail is trimmed at stop,
  several post-preallocation flush cycles land contiguously with no
  gap/corruption, `prealloc_ms` re-measures per session rather than going
  stale, and a simulated full-card seek failure degrades gracefully instead
  of blocking recording. Existing tests that inspected file content before
  `sd_logger_stop()` needed updating (pre-allocation now genuinely changes
  file size mid-recording) — fixing those also caught a real latent
  buffer-overflow bug in `tests/test_firmware.c`'s `mock_logger_buf[256]`
  (`strcpy`'d from a `row[300]` source, silently one CSV column away from
  overflow already; caught the moment `prealloc_ms` pushed a debug row past
  256 bytes) — fixed by sizing the mock buffer to match its source with
  margin (320 bytes).
- Verified: full host test suite (`./run_tests.sh --full`, including
  ThreadSanitizer) and a real ARM toolchain build via `python3 -m ufbt`,
  both clean.

**Not verified yet — the actual point of this change**: whether it helps on
real hardware. No walk has been recorded with it. The user is testing this
themselves by flashing the built `.fap` and recording real walks; the
column to check is `prealloc_ms` (did the one-shot allocation cost
something reasonable, or was it itself a multi-second stall) alongside
`flush_peak_ms`/`tick_dt_ms`'s per-flush progression (does it stay flat
near track 016's early-recording ~94ms baseline instead of climbing to
~230ms the way track 016 did without this).

### 2026-08-05: tracks 017/018 recorded with `BIOMAP_SD_PREALLOC` on — cheap to run, but doesn't prevent the worst-case jump; working theory revised, not confirmed

Track 017 (19.2s, clean stop) first confirmed `prealloc_ms` on real hardware:
**21ms** — the one-shot 8 MiB allocation is cheap, not the multi-second risk
flagged as open in the previous entry. Too short to say anything about the
drift question itself.

Track 018 (1083.1s / 18.1 min, real GPS, clean stop, `prealloc_ms`=22ms —
consistent with track 017) is long enough to say something, and it's a
mixed result, not a clean win:

- **Steady-state flush cost is dramatically better while it holds.**
  `flush_peak_ms` settles at 55-60ms from t=478s to t=998s, vs. track 016's
  152ms steady state over the equivalent no-prealloc stretch — roughly
  2.5x lower, sustained for over 16 minutes.
- **But a sharp escalation still happened.** t=998s to t=1018s: three
  consecutive flush-boundary jumps, 60→98→193→**266ms** — higher than
  track 016 ever reached (231ms), reached with *less* data written
  (1.12 MiB vs. 1.38 MiB) and *less* wall-clock time (17.0 min vs. 20.4 min)
  than track 016's first jump. Same verification as every prior entry here:
  `i2c_peak_ms`/`rf_rssi_peak_ms`/`rf_retune_peak_ms` stayed completely flat
  through the whole window, ruling out GSR/RF again — this is the SD flush
  itself. No data lost (`log_overflow_count`/`log_flush_fail_count` stayed
  0 in both tracks).

**Working theory, revised — explicitly a theory, not a confirmed
conclusion**: pre-allocation targets FAT cluster-allocation overhead
specifically. If that overhead were the *whole* cause of the worst-case
jumps (not just the steady-state baseline), removing it should have
prevented the jump outright, not just lowered the floor while leaving a
separate escalation event intact. One plausible reading is a second,
independent mechanism — SD-card-internal garbage collection / wear-leveling
housekeeping, which lives in the flash controller below the filesystem and
which no amount of FAT-level pre-allocation can touch. This is consistent
with the two data points so far, but **it is not proven** — it's an
inference from n=1 comparison (one track with prealloc showing a jump
despite the fix), not a mechanism directly observed. Real alternatives not
ruled out: this specific SD card having a periodic housekeeping cadence
unrelated to either hypothesis, a coincidence, or something about this
particular walk (RF/GPS environment, temperature, card wear) unrelated to
either FAT or GC theories.

**Not established by this data**:
- Whether the 266ms jump would have kept climbing or plateaued — the file
  ends only 65s later (1083.1s total), too little to tell, unlike track
  016 where the equivalent jump was followed by ~38 more minutes showing it
  never recovered.
- Time-driven vs. size-driven trigger — track 018's jump came at both less
  elapsed time AND less data written than track 016's, so the two tracks
  don't cleanly separate these; more data points needed either way.
- Whether this generalizes — n=1 track with pre-allocation active is not
  enough to call the steady-state improvement (152ms→60ms) reliable either,
  though it's a promising sign on its own.

### 2026-08-06: state of play after tracks 017/018/019 — pre-allocation looks like it's working; a separate, pre-existing "2Hz" issue is still there but small

Three real recordings with `BIOMAP_SD_PREALLOC` on (017: 19s, 018: 18.1min,
019: 67.9min) are enough now to say something with more confidence than the
track 018 entry above could on its own. Two separate headline findings —
one encouraging, one a reminder that this investigation isn't closed.

**1. Pre-allocation appears to be working.**

- `prealloc_ms` is cheap and consistent: 21-22ms across all three tracks —
  the one-shot allocation is not itself a meaningful stall.
- Steady-state flush cost is dramatically lower: track 019 sits at
  97-100ms average flush-boundary tick time for the entire 68-minute
  recording (vs. track 016's 94ms→163ms *climb* over 59 minutes without
  pre-allocation) — the sustained, ever-worsening drift that was the
  original concern does not show up.
- Where escalation events still happen (track 018's 266ms jump, track
  019's two spikes at ~40min and ~55-60min), track 019's much longer tail
  answers the question track 018 couldn't: **they recover.** Every bucket
  after each spike returns to the ~100ms baseline, unlike track 016 where
  the equivalent jump never came back down for the rest of the recording.
  That's a real, qualitative difference in failure mode — occasional
  self-correcting stalls instead of permanent, compounding degradation —
  not just a smaller version of the same problem.
- No data lost in any of the three tracks (`log_overflow_count`/
  `log_flush_fail_count` stayed 0 throughout).
- Still open, not contradicted by any of this: whether pre-allocation is
  quietly costing more in total SD-card metadata churn than it saves (the
  8 MiB-vs-real-walk-size overshoot question raised earlier), since that
  isn't visible in `flush_peak_ms`/`tick_dt_ms` at all — see the
  instrumentation menu two entries below.

**2. The "2Hz" tick-delay pattern (open item #6 below) is real, still
unexplained, but small and independent of this investigation.**

Checked nine long tracks total (015, 016, 018, 019, 116, 118, 119, 121,
122) for `tick_dt_ms` delays that land nowhere near an SD flush. Splits
cleanly: **every track with `flush_peak_ms` in its CSV schema (015, 016,
018, 019, and the original track 118) shows the pattern; every track
without it (116, 119, 121, 122) doesn't** — no exceptions. It shows up
whether pre-allocation is on or off, so it isn't something this change
introduced or affects.

Where it appears, it grows from rare at the start of a recording to
frequent later on (e.g. track 019: ~16 occurrences in the first 5 minutes
vs. 200+ in the last 5). Two competing explanations for the
`flush_peak_ms`-presence correlation, neither confirmed: genuinely more
per-tick formatting cost from the larger debug-column set those tracks
share, or a confound — those tracks are chronologically later, on a card
with many more prior recordings on it, independent of column count. Not
distinguished yet; would need a same-card, same-walk, debug-fields-on-vs-off
comparison to tell them apart.

**Why "not particularly significant" is the right way to hold this**:
aggregate cost measured directly on track 019 is ~55 seconds over a
68-minute recording (~1.3% of total time), values stay in the 130-190ms
range (versus multi-hundred-ms for the SD-flush issue), and — same as
everything else in this document — no data loss. It doesn't change
anything concluded about pre-allocation above; it's a separate, older,
lower-priority thread that happened to become visible while investigating
this one.

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
   **[2026-08-06 update]** Confirmed present across 5 of 9 long tracks
   checked (015, 016, 018, 019, and this original track 118), absent in
   the other 4 (116, 119, 121, 122) — splits cleanly on whether
   `flush_peak_ms` is in the track's CSV schema, no exceptions. Independent
   of `BIOMAP_SD_PREALLOC` (shows up with it on or off). Two competing
   explanations, neither confirmed: more per-tick debug-column formatting
   cost, or a same-direction confound (those tracks are chronologically
   later, on a more-used card). See the "state of play" entry above for
   the full breakdown and aggregate cost (~1.3% of recording time).
7. **Cosmetic, optional**: `gsr->available` is set `true` unconditionally
   at alloc (right after a `furi_check` that would already have aborted on
   allocation failure) and never set `false` anywhere — every
   `if(!gsr->available) return;` guard in every accessor is dead code.
   Not a bug; removing it means touching ~20 call sites plus the public
   `gsr_sensor_available()` API for zero behavior change. Left alone
   deliberately.
