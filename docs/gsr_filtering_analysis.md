# GSR Filtering Analysis

> **Living document.** Written 2026-07-22 using the host test
> infrastructure (see `docs/host_testing.md`) plus a standalone
> frequency-response tool. Update the Recommendations section's status as
> items land.
> Reproduce/rerun the sweep with: `gcc -Wall -Wextra -I . -o /tmp/a biomap_pipeline.c tests/analyze_gsr_filtering.c -lm && /tmp/a`

## Why this exists

The question that started this: is the GSR oversampling/decimation
approach correct, is there room to improve SNR, and is the 50 Hz mains
filtering doing what its comments claim? Answering that meant actually
tracing the signal chain end to end and measuring the real filters'
frequency response against the real code, not just reading the comments.

## The signal chain, as it actually is (not as the comments describe it)

There are **two separate, independent paths** from the ADS1115 to
anywhere a human or a CSV file sees a number. This split is the single
most important thing to understand before touching any filtering code —
several of the findings below come directly from the two paths being
treated as one in the code's comments.

```
ADS1115 (860 SPS, real hardware)
        │
        ▼
gsr_sensor_worker()  — background FuriThread, polls I2C, writes ring buffer
        │
        ├──────────────────────────────┬─────────────────────────────────
        ▼                               ▼
gsr_sensor_get_raw()                    gsr_sensor_get_raw_sample_ns()
  100-sample boxcar average             single most recent sample —
  → TIA → calibration                   "no decimation, no averaging"
        │                                       │
        ▼                                       ▼
   CSV (logged, scientific data)      pipeline_update_display()
                                         IIR (fc~3Hz) → EMA (fc~0.35Hz)
                                                │
                                                ▼
                                       on-screen graph (cosmetic only)
```

`biomap_session.c:handle_recording_tick()` is where this split happens —
`raw` (boxcar output) goes to `batch_csv_row()`; `raw_sample` (single,
unaveraged) goes to `pipeline_update_display()`. The comment on
`pipeline_smooth_iir()` in `biomap_pipeline.c` says it "Runs at 10 Hz
AFTER the 100:1 boxcar decimation" — that's describing the CSV path's
data, but the function is actually only ever called with the *other*
path's data. See Finding 2.

---

## Finding 1 — the CSV boxcar's mains rejection depends on an unverified assumption

The 100-sample average in `gsr_sensor_tick()` is a rectangular boxcar. A
boxcar of `N` samples taken at true rate `Fs` has exact nulls at every
multiple of `Fs/N`. For a single window to null *both* 50 Hz and 60 Hz,
`Fs/N` must divide both — the largest number that does is
`gcd(50,60) = 10`, so `Fs` must be **exactly** `10 × 100 = 1000 Hz`.

The worker's write rate is nominally ~1000 Hz (`furi_delay_ms(1)` per
loop), but the code's own comments already note ~14% duplicate reads
because the ADS1115 only converts at 860 SPS, and every loop iteration
also pays for the actual I2C transaction on top of the 1 ms delay. Nobody
has measured what the true average write rate is. It's an assumption the
design leans on, not a verified fact. Here's how much that assumption
matters if it's off by even a little:

| Assumed worker rate | Gain @ 50 Hz | Gain @ 60 Hz |
|---|---|---|
| 1000 Hz (design assumption) | −240 dB (exact null) | −240 dB (exact null) |
| 950 Hz | −27.0 dB | −27.4 dB |
| 900 Hz | −24.9 dB | −27.6 dB |
| 860 Hz (the ADC's actual conversion rate) | −30.3 dB | −49.5 dB |
| 800 Hz | −28.8 dB | −27.4 dB |
| 769 Hz | −26.1 dB | −32.4 dB |

Off the exact assumption, rejection is still meaningful (~25–30 dB, a
20–30× reduction) but nowhere near the "nulls mains hum" the design
implies.

**Update 2026-07-22 — measured on real hardware via the rolling-window
`gsr_sensor_get_worker_hz()`: converges to ~500 Hz.** (Two earlier
readings, 396 then 497 Hz, were taken with the since-replaced
lifetime-average implementation — in hindsight they're consistent with a
value climbing toward ~500 Hz as the one-time alloc()-time overhead
became a smaller fraction of elapsed time, exactly the failure mode that
method was replaced for. Not proof, but it fits.)

500 Hz turns out to be a good rate to land near — better than 1000 Hz's
neighborhood was, in fact:

| Assumed/measured rate | Window span (N=100) | Gain @ 50 Hz | Gain @ 60 Hz |
|---|---|---|---|
| 1000 Hz (original design assumption) | 100 ms | −240 dB (exact null) | −240 dB (exact null) |
| **500 Hz (measured)** | **200 ms** | **−240 dB (exact null)** | **−240 dB (exact null)** |
| 495 Hz | 202 ms | −40.0 dB | −40.0 dB |
| 505 Hz | 198 ms | −40.0 dB | −40.0 dB |
| 490 / 510 Hz | ~204 / 196 ms | ~−34 dB | ~−35 dB |
| 480 / 520 Hz | ~208 / 192 ms | ~−30 dB | ~−32 dB |

500 Hz isn't an arbitrary point that happens to be less-bad than
1000 Hz's neighborhood — it's `1000/2`, one of a family of rates
(`1000/m` for integer `m`) that all give an **exact** simultaneous null
at both 50 and 60 Hz, for the same reason 1000 Hz itself does
(`gcd(50,60)=10` divides `Fs/N` in each case). And the notch here is
wide: even 5–10 Hz off-center it's still −30 to −40 dB, nothing like the
knife-edge the original 1000 Hz assumption implied. **Practical
conclusion: the mains-hum part of Finding 1 is essentially resolved** —
whatever's causing the real rate to sit near 500 Hz instead of 1000 Hz,
it isn't hurting mains rejection.

**But the window-span problem (the second half of Finding 1) is still
real, just smaller than the 396 Hz reading suggested.** `N=100` samples
at 500 Hz spans **200 ms**, not the 100 ms every comment (and the CSV
cadence, `TICK_HZ=10`) assumes — a 2× error, not the 2.5× the earlier
number implied, but still real: consecutive CSV rows still share half
their underlying samples rather than being independent 100 ms windows.
Recommendation 1b (below) still applies, just with lower urgency than it
looked like an hour ago.

**Update 2026-07-22 — confirmed via `gsr_sensor_get_success_rate()`:
`Hz:500 OK:100%`.** The `OK:100%` is the important part: it rules out
"the loop attempts faster but many reads silently fail" outright (that
would show as `OK:` well below 100%, per the test that validated this
arithmetic against a known 50%-failure injection,
`test_success_rate_reflects_real_failure_ratio`). The loop genuinely only
*attempts* ~500 reads/sec, and every one succeeds. This is a real,
deterministic 2× gap from the 1000 Hz design assumption, not measurement
noise and not a masked hardware failure.

**Leading explanation (still not isolated down to the exact mechanism,
but now much better supported since the failure-rate alternative is
ruled out):** `furi_delay_ms(1)` requesting a 1-tick delay on a 1 ms-tick
RTOS is a known source of ~2× delay in practice — `vTaskDelay(1)`-style
calls guarantee *at least* one tick but commonly cost close to two,
depending on where in the current tick period the call lands, and if the
rest of the loop body takes a fairly consistent duration each iteration
that phase relationship can lock in and repeat every cycle. Isolating it
precisely (as opposed to inferring it) would mean timestamping just the
delay call separately from just the I2C transaction — worth doing only
if someone wants to try recovering the lost 2×, e.g. by replacing
`furi_delay_ms(1)` with a plain scheduler yield (trades the loop's
current politeness — a bounded, predictable pace — for higher throughput
and higher CPU/bus usage; a real trade-off, not a free win, and not
attempted here).

Given 500 Hz already lands on an exact mains-null point, there's no
active problem forcing this investigation further — Finding 1's
window-span issue (Recommendation 1b) remains the more actionable
follow-up, since it's what protects against this same 2× gap landing on
a *bad* rate on a different device or firmware revision.

## Finding 2 — the on-screen display has no anti-aliasing at all, and the filter comment describing it is wrong

`gsr_sensor_get_raw_sample_ns()` is documented as returning "the most
recent ring-buffer entry" — a single ADC conversion, no averaging. That's
what feeds `pipeline_update_display()` (confirmed at
`biomap_session.c:505`, and explained there: *"Use the raw single-sample
value for the display so you see the unfiltered hardware reading"* — this
part is an intentional, reasonable design choice).

The problem is `biomap_pipeline.c`'s comment on `pipeline_smooth_iir()`,
which describes this filter as running "AFTER the 100:1 boxcar
decimation" and reasons about aliasing on that basis. It's describing the
CSV path's data, applied to a function that only ever receives the other
path's data. In reality: a single ADC sample, taken at 10 Hz, from an
~860 Hz-bandwidth source, with **zero** pre-filtering — real aliasing,
happening before the IIR ever sees the signal, and (as the same comment
correctly says elsewhere) "aliasing... is a one-way door": the IIR/EMA
downstream cannot remove content that already folded into the passband.
Net effect: the on-screen graph is meaningfully noisier than the logged
CSV data, including whatever mains hum is present, because it skips the
one filter that would have caught it.

## Finding 3 — the display cascade's real bandwidth is ~10x narrower than the IIR comment implies

Measured by running the actual `pipeline_update_display()` through a sine
sweep (not the idealized continuous-time formula it was derived from):

| Frequency | Cascade gain | dB |
|---|---|---|
| 0.1 Hz | 0.962 | −0.33 |
| 0.35 Hz | 0.710 | −2.98 |
| 1.0 Hz | 0.343 | −9.30 |
| 3.0 Hz | 0.112 | −19.04 |
| 4.9 Hz | 0.082 | −21.74 |

Combined cascade −3 dB point: **~0.35 Hz**, not the ~3 Hz the IIR-alone
comment states. Two things compound here:

1. The IIR's own `α = 1 − e^(−2π·3/10) ≈ 0.848` formula is a continuous-RC
   approximation that's only accurate when `fc ≪ Fs`. At `fc=3Hz, Fs=10Hz`
   that ratio is 30%, not small — the *actual* discrete filter's
   attenuation at 3 Hz is only **−1.9 dB**, and it never reaches −3 dB
   anywhere in the 0–5 Hz band on its own.
2. The EMA stage stacked after it (`α=0.2`) has its own, much lower
   corner (~0.36 Hz standalone) and dominates the cascade almost entirely
   — the IIR contributes only a few extra dB at the higher end (3–5 Hz).

Net: ~0.45s effective time constant for the display, not the ~50 ms the
IIR-only comment's phase-lag claim would suggest. Probably still fine
against 1–3s phasic GSR rise times, but worth knowing precisely rather
than assuming.

---

## Recommendations

### 1. Measure the real worker polling rate on hardware — ✅ implemented 2026-07-22, revised same day

This is the one fact that resolves Finding 1 from "unverified assumption"
to "known quantity" — and it can't be done through the host test harness,
because `tests/shims/furi.h`'s `furi_delay_ms()` is a no-op there, so the
simulated worker never reproduces real I2C transaction timing. Needed an
on-device build to actually read.

**First implementation** measured a lifetime average since
`gsr_sensor_alloc()` (`iter_count` / elapsed time since alloc). Two reads
in the same session — 396 Hz, then 497 Hz — exposed why that's the wrong
measurement strategy: a lifetime average converges slowly and stays
permanently diluted by the one-time probe/warm-up delay in `alloc()`, so
readings taken at different points in a session aren't comparable and a
single snapshot can't be trusted to represent the steady-state rate.

**Revised to a rolling ~1 s window instead.** `GsrSensor` gained
`iter_count` (mutex-protected, incremented by the worker), plus
`hz_window_start_tick`/`hz_window_start_count`/`worker_hz_cached` — all
three written only by `gsr_sensor_tick()` on the main thread (same
no-lock-needed pattern the existing `tick_mean_norm` field already uses).
Once per elapsed second, `tick()` computes the rate for the window that
just closed and caches it; `gsr_sensor_get_worker_hz()` is now a trivial
read of that cache. `iter_count` itself still increments only in the
branch that actually writes a new sample to the ring buffer (not on
PGA-change passes, which `continue` without writing) — that's the rate
the boxcar average actually experiences, which is what Finding 1 needs.
Deliberately independent of `gsr_sensor_tick()`'s `i2c_ok` early-return,
so the rate visibly drops toward zero on screen if the sensor
disconnects, rather than freezing at its last good value.

The reading shows on the `BioMapModeDiagnostics` screen (`biomap_render.c`)
as a sixth "Hz:NNN OK:NN%" line. **Still needs re-measuring on a real
device** — the 396/497/~500 Hz readings above were taken before this
success-rate addition existed.

The `OK:` half was added specifically because `worker_hz_cached` alone
can't distinguish two very different situations that produce the same
number: the loop genuinely only running at rate X (`OK:` near 100%), or
the loop attempting much faster but half the reads silently failing
(`OK:` well below 100%, and the *true* attempt rate is `Hz / (OK%/100)`)
— these have opposite implications (an RTOS characteristic to design
around vs. a real transport/wiring problem worth fixing) and the ~500 Hz
reading alone couldn't tell them apart. `iter_count` (successes) and the
new `attempt_count` (every read, success or fail) are both accumulated by
the worker under the existing mutex; `gsr_sensor_tick()`'s same rolling
window computes both `worker_hz_cached` and `success_rate_cached` from
them together. Once you have a device: open GSR Diagnostics and read
both numbers — `OK:` near 100% confirms the loop itself runs at roughly
`Hz`; `OK:` well below that points at intermittent I2C failures instead,
which is a different problem with a different fix.

The counting mechanism itself (not the real-world Hz value, which is
meaningless on host since `furi_delay_ms` is a no-op there) is now
covered by `test_worker_hz_accessor` in `tests/test_gsr_sensor.c` — it
asserts the accessor returns a positive, non-crashing value once the
worker has run, catching a regression that stops the counter
incrementing, even though the *rate* itself can only ever be trusted from
a real device. `test_success_rate_reflects_real_failure_ratio` goes
further: `tests/shims/furi_hal.h` gained
`furi_hal_i2c_mock_set_fail_every_nth(n)`, a deterministic
intermittent-failure mode (every Nth read fails, the rest succeed) —
setting `n=2` and confirming `gsr_sensor_get_success_rate()` reports
50.0% verifies the success-rate *arithmetic* against a known ratio, not
just that the accessor runs without crashing.

### 1b. Make the averaging window time-based, not sample-count-based — still worth doing, lower urgency than first thought

The real measurement (~500 Hz, see above) resolved the mains-hum half of
Finding 1 — by luck, 500 Hz lands on another exact-null rate. But it
confirmed a second, more fundamental problem the mains-hum discussion was
masking: `N=100` is a fixed *sample count*, and the window duration it
produces (`N / true_rate`) is only correct if `true_rate` happens to be
1000 Hz (or another member of that exact family). It measured ~500 Hz —
the window is running at ~200 ms, not the intended 100 ms. There's no
reason to expect the true rate to be stable across devices, temperature,
firmware revisions, or I2C bus retries on the *same* device, and the next
device that lands at, say, 550 Hz instead of 500 Hz would get real
mains-hum degradation with no warning. A fixed `N` tuned against one
measurement from one device is tuned against a moving target — this
recommendation is about the window-duration correctness generally, not
about fixing an active mains-hum problem anymore.

**How:** instead of `for(i = 0; i < 100; i++) sum += buffer[...]`,
accumulate however many samples have landed in the ring buffer since the
last tick, using timestamps rather than a hardcoded count:

```c
// Each worker write already happens under gsr->mutex — add a tick
// timestamp alongside gsr->buffer[write_idx] = norm:
gsr->sample_tick[gsr->write_idx] = furi_get_tick();
```

Then in `gsr_sensor_tick()`, walk backward from `write_idx` accumulating
samples *while their timestamp is within the target window* (e.g. 100 ms
= `furi_kernel_get_tick_frequency() / 10`), rather than for a fixed 100
iterations — the loop naturally averages over however many samples the
real rate produced in that span, whatever the real rate turns out to be.
This also directly fixes the mains-notch question from Finding 1: correct
window duration is a precondition for the boxcar's null-frequency math to
land anywhere near 50/60 Hz at all, on any device, without needing to
know or hand-tune against its true polling rate.

This is a slightly bigger change than Recommendation 2's coefficient swap
— it touches the ring buffer's shape (needs a parallel `sample_tick[]`
array, `SENSOR_BUFFER_SIZE` sized generously enough to hold >100ms of
history even at a slow measured rate like 396 Hz) — but it's the fix that
actually matches the problem this measurement found. Worth doing before
2, or combined with it (apply a Hann taper to whatever variable-length
window this produces, rather than to a fixed 100 samples).

### 2. Replace the rectangular boxcar with a windowed average

A rectangular (uniform-weight) boxcar has the sharp-but-fragile null
property behind Finding 1 — and significant sidelobes between nulls (only
~−13 dB at the first sidelobe), so it's not even doing a great job at
frequencies *near* 50/60 Hz that aren't hit exactly. A **Hann-windowed**
average trades some of the boxcar's √N noise-averaging efficiency for a
much wider, shallower dip around 50/60 Hz that doesn't require hitting an
exact rate.

**How:** replace the uniform weights in `gsr_sensor_tick()`'s summing loop
(currently `sum += v`) with precomputed Hann coefficients:

```c
// w[i] = 0.5 * (1 - cos(2*pi*i / (N-1))), normalized so sum(w) == 1.
// Computed once (e.g. in gsr_sensor_alloc()) — 100 cosine evaluations,
// negligible cost, avoids hand-typing 100 float literals into source.
```

Worth doing as a companion refactor at the same time: **extract the
weighted-average computation out of `gsr_sensor_tick()` into
`biomap_pipeline.c`** as a pure function (`buf[]`, `write_idx`, weights
in → averaged value out), the same way `pipeline_smooth_iir` was already
extracted from the display path. That makes the *new* windowing math
directly unit-testable in `tests/test_firmware.c` — deterministic, no
pthread/timing dependency at all — rather than only checkable via the
worker-thread harness (which, per Finding 1's own caveat, can't validate
real-world timing anyway). Re-run `tests/analyze_gsr_filtering.c` after
this change to see the new notch shape and confirm it's actually wider
and less fragile than the current rectangular one, not just theoretically.

### 3. Fix the `biomap_pipeline.c` comment

Cheap, and prevents the next person from reasoning about aliasing using
the wrong signal path. Proposed replacement for the
`pipeline_smooth_iir()` comment block:

```c
// ── Post-decimation smoothing IIR ──────────────────────────────────────
// First-order IIR, nominal fc ≈ 3 Hz via α = 1 - e^{-2π·3/10} ≈ 0.848 —
// note this approximation assumes fc << Fs and is optimistic at Fs=10Hz;
// measured attenuation at 3 Hz is only ~-1.9 dB, not -3 dB (see
// docs/gsr_filtering_analysis.md).
//
// IMPORTANT: called from biomap_session.c with the RAW SINGLE-SAMPLE
// value (gsr_sensor_get_raw_sample_ns()), not the boxcar-decimated one
// (gsr_sensor_get_raw()) — this is the display/graph path only; the
// boxcar-filtered value goes straight to CSV without passing through
// this filter at all (see handle_recording_tick() in biomap_session.c).
// That means there is NO anti-aliasing before this filter on the display
// path: it subsamples an ~860 Hz source at 10 Hz with no pre-filter, so
// aliasing (including 50/60 Hz mains hum) folds into the 0-5 Hz band
// before this filter ever sees it, and — aliasing being a one-way door —
// cannot be removed afterward. This is an intentional trade-off (the
// display shows the true instantaneous hardware reading) but means the
// on-screen graph is noisier than the logged CSV data, which uses a
// separate, actually-decimated signal path.
```

### 4. Lengthen the boxcar window (lower priority, independent of the mains question)

More samples per average = better √N reduction of ordinary thermal/random
noise (going from N=100 to N=200 is a further √2 ≈ +3 dB). Doesn't fix
Finding 1's rate-sensitivity — the exact-null property depends on the
`Fs/N` ratio matching a divisor of 50 and 60, not on N alone — so treat
this as a separate, smaller lever for general noise floor, not a mains
fix. **How:** `SENSOR_BUFFER_SIZE` (currently 128, must stay a power of
two for the ring buffer's masking trick) would need to grow to at least
256 to hold a 200-sample window with headroom; the CSV's effective time
resolution/lag doubles from ~100 ms to ~200 ms, which should still be
negligible against 1–3s phasic GSR rise times.

---

## Suggested order

1 is done — measured ~500 Hz on real hardware (2026-07-22), which by luck
is another exact mains-null rate, so the mains-hum urgency that motivated
1b at first is gone. Current state: **3 ≈ 1b > 2 > 4**. 3 is a
documentation fix, costs nothing, do it whenever. 1b is still worth
doing — the window-duration problem (~200 ms vs. the intended 100 ms) is
real regardless of the mains-rejection outcome, and it's what protects
the *next* device that doesn't land as luckily as this one did — but it's
no longer fixing an active emergency, just closing a real gap before it
becomes one. 2 (Hann taper) is only worth doing once 1b lands (it's a
refinement of the windowing, not a substitute for fixing its duration).
4 is independent and can happen anytime.
