# GPS Filter Review — Known Problems

**Written:** 2026-09-25 · **Scope:** the visualiser's GPS filter
([`gps_cv_kalman.mjs`](../visualiser/src/gps/gps_cv_kalman.mjs)) and the
stages around it ([`gps_pipeline.mjs`](../visualiser/src/gps/gps_pipeline.mjs)),
checked against the real u-blox M10Q walks in `tracks/`.
**Status:** problems written down, none fixed yet. For how the pipeline works
see [`gps_filtering_pipeline.md`](gps_filtering_pipeline.md).

A few terms used below:

- **Fix**: one position reported by the GPS chip. The M10Q gives 10 a second.
- **Kalman filter**: the step that combines each new fix with a prediction
  ("where the walker should be now, given where they were and how fast they
  were going") to get a smoother, more believable path.
- **Smoother (RTS)**: a second pass run backwards over the walk, so each
  point is also informed by the fixes that came after it.
- **Outlier check (χ² gate)**: before a fix is used, the filter asks "is
  this fix too far from where I expected?". If yes, the fix is skipped.
- **Restart**: after too many skipped fixes in a row, the filter gives up on
  its prediction and starts again from the current fix.
- **Doppler velocity**: the chip's own speed and direction reading. It is
  measured separately from the position.
- **hAcc**: the chip's own estimate of how accurate each position is, in
  metres.

---

## 1. Restarting after half a second lets bad stretches through (most important)

**What happens.** The filter restarts after 5 skipped fixes in a row
(`RESET_AFTER`). At 10 fixes a second that is only **0.5 seconds**. So:

1. A burst of bad fixes starts. This happens with signal reflections off
   buildings ("multipath"), which usually last for seconds, not a single fix.
2. The outlier check correctly skips the first 5 of them.
3. The filter then restarts **on the bad fix** and follows the bad fixes for
   the rest of the burst.
4. When good fixes come back, they now look like outliers. After 5 more
   skipped fixes, the filter restarts again, 0.5 s late.

So the whole bad stretch is drawn in full, as a spike. Also, the smoother
cannot smooth across a restart, so there is no benefit from the fixes on
either side.

**Evidence.** Fake bad fixes were added to four clean u-blox walks (113, 029,
032b, 112), at three places in each:

| Fake offset | How long | What the finished path did |
|---|---|---|
| 20 or 50 m | 1 fix | Skipped correctly, path unaffected (0 m) |
| 20 m | 0.5–1 s | Usually drawn in full (19–21 m spike), 2 restarts |
| 50 m | 1 s | Always drawn in full (46–56 m spike), 2 restarts |
| 30 m | 3 s | Mostly drawn in full (29–31 m), 2 restarts |
| 15 m | 3 s | Mixed: 1–5 m pull, or the full 15 m with 2 restarts |

A bad stretch that stays *inside* the outlier check's range (see §2) is
smoothed as intended: 10 m for 10 s pulled the path by about 4.5 m.

**Possible fix.** Base the restart on **time**, not a count of fixes (for
example, restart only after several seconds of skipped fixes). Also consider
restarting only when the skipped fixes agree with *each other* (a real jump
lands in one new place, while reflections scatter). Test on the injected-fault
harness above *and* the street-distance score before adopting it. See
[A/B before rewriting](#how-to-test-changes).

## 2. The outlier check's range is wide: about 13–21 m

**What happens.** Because 10 fixes a second from the chip share most of their
error, each fix is counted as 30 times noisier than the chip says
(`NOISE_CORR_S`, 3 s ÷ 0.1 s). This was deliberate, and it stopped the
restart spikes the old filter had. A side effect is that the outlier check
only skips a fix more than about **13–21 m** from the prediction (median per
walk: 113 → 20.8 m, 029 → 13.2 m, 032b → 17.0 m, 112 → 18.9 m), even though
hAcc is usually around 1 m. Bad stretches smaller than that are not
rejected. They are only averaged down, which pulls the path part of the way.

A standard health check on a Kalman filter compares how surprised it is by
each fix with how surprised it *expects* to be. On a healthy filter the
average score is about 2. Here it averages **0.01–0.5** on every walk. So
the filter considers the data much noisier than it really is from one fix to
the next.

**Why it is not simply "wrong".** hAcc describes the *absolute* error (how
far off the whole path might be). That error drifts slowly. Fix-to-fix jitter
is much smaller, so the low score is partly expected. The real question is
whether a tighter check would catch real reflections without bringing back
restarts. That needs testing, not a guess.

**Possible fix.** Use a separate, tighter range for the outlier check than
for the averaging weight. Only try this after §1 is fixed, because a tighter
check makes restarts more likely.

## 3. The chip's speed and direction count for more than its position

**What happens.** Positions get the "10 a second share their error"
treatment (§2), but the chip's speed and direction readings do not, even
though they come from the same internal filter in the chip and are just as
linked. In practice, the filter's speed and direction almost exactly copy
the chip's reading, and the drawn path is mostly "follow the chip's
direction", with positions only slowly correcting it. When the chip's
direction is off, the path cuts corners. On walk 032b the chip's direction
read 12–23° wrong for 40 s, and a bend was cut by up to 8 m (already noted in
`gps_filtering_pipeline.md`).

**Already tried.** Down-weighting the speed/direction readings ("velocity-noise
inflation") was tested on 2026-09-25 and not adopted, so this is known and
was a judgement call. It is listed because the two measurements are treated
inconsistently, and that should be a documented choice.

**Possible fix.** Get the chip's own speed and direction accuracy
(`UBX-NAV-PVT` `sAcc`/`headAcc`, see `todo.md` "Smaller notes") instead of
the fixed guesses (0.3 m/s, 15°).

## 4. Stop pinning can squash very slow walking into a dot

**What happens.** A "stop" starts when the chip's speed is at or below 0.5 knots
(0.26 m/s). It only ends when the speed goes above 1 knot, when the fixes
move more than 2 m in 5 s (0.4 m/s), or when a fix is 10 m from the stop's
average position. So walking steadily at under about 0.4 m/s,
once a stop has started, is not detected as movement. Up to about 20 m of it
can be pinned to one dot, with a jump into and out of the dot.

**How much it matters now.** This was serious on the L76K walks, where the
chip reported exactly 0 speed while walking slowly (walk 039: a 229 s "stop"
covering 26 m; stop pinning alone added two restarts and two 19–22 m jumps).
L76K support has been removed. On the u-blox walks, the pinned stops look
like real stops: the worst dot sits 7 m from a raw fix, during a 4-minute
wait on 032b. So this is a **low-priority** edge case now: a very slow
shuffle after standing still.

**Possible fix, if it ever shows up.** Also end a stop when the fixes move
steadily away over a longer window (for example, more than 4 m net over 20 s).

## 5. The points drawn between fixes use the chip's raw speed, not the filter's

**What happens.** `reconstructFilteredGps` fills the rows between two fixes
with a curve (a cubic Hermite curve) shaped by each end's speed and
direction. It uses the chip's **raw** readings, not the smoothed speed and
direction the filter has just worked out. This was the right choice
with the old filter, which didn't track speed. The new one does.

**How much it matters.** Very little on the M10Q: at 10 fixes a second almost
every row is a real fix, so there is hardly anything between them to fill.
It matters for gaps, and for walks exported from Live Stream (about 3
positions a second).

**Possible fix.** Return the smoothed velocity from `GpsCvKalman.run` and use
it for the curve.

## 6. Live Stream walks never have hAcc

**What happens.** The Bluetooth live packet
([`csv_schema.md`](csv_schema.md) "Live Stream BLE Binary Packet Format")
has no hAcc field, so walks saved from the Live view always have an empty
`hacc_m` column. The filter then falls back to guessing accuracy from
satellite geometry (DOP), which misses reflections. Now that L76K is gone,
this is the **only** case where a whole walk runs without hAcc. The other
fallback case is the first moments of a walk, before the chip's first
accuracy report.

**Possible fix.** Add a 4-byte hAcc float to the live packet (firmware
`bt_stream`, `live_binary_parser`, `live_csv.mjs`, and the contract test).

## 7. Smaller notes

- **Repeated fixes.** The firmware writes the chip's *latest* fix on every
  10 Hz row. Because of timing jitter, 0–28 % of u-blox rows repeat the
  previous fix, stamped 0.1 s later. The filter counts each one as a new
  fix. The effect is small (a lag well under a metre), but a repeated
  position could simply be skipped.
- **PDOP is preferred over HDOP** in the no-hAcc fallback. PDOP includes
  height error, so it is always ≥ HDOP and overstates side-to-side error.
  This errs on the safe side and only matters in the DOP fallback (§6).
- **hAcc is used as the error in each direction** (east and north). If the
  chip means it as a combined radius, the true per-direction error is about
  hAcc ÷ 1.4. This also errs on the safe side.
- **hAcc update rate (to confirm).** The firmware comment says `$PUBX,00` is
  enabled "at 1 Hz". But the command's rate field counts *position updates*,
  not seconds, and the logged hAcc sometimes changes twice within 0.15 s.
  So it most likely arrives with every fix, and the comment is wrong. Check
  against a raw NMEA capture before changing it.
- **The 0.5-knot stop threshold and 1-knot exit** match the chip's own
  "static hold" behaviour, and the chip's speed is never exactly 0 on the
  u-blox walks, so there is no problem there.

---

## What was checked and found correct

These parts were checked line by line against the textbook equations (Bar-Shalom
§6.2 for the motion model; Rauch–Tung–Striebel for the smoother):

- **Prediction step**: moving the state forward in time, `F·P·Fᵀ`, and the
  motion noise `Q = q·[dt³/3, dt²/2; dt²/2, dt]`, including every matrix
  index.
- **Update step**: the gain, the state update, the covariance update, and
  re-symmetrising against rounding.
- **Outlier threshold**: 11.83 is correct for 2 values at 99.73 % (the
  "3-sigma" level).
- **Speed/direction noise**: `σ_speed²·uuᵀ + (speed·σ_course)²·wwᵀ`, with u
  along the direction of travel and w across it. The off-diagonal
  `(σa² − σc²)·ue·un` is correct.
- **Smoother**: gain `C = Pf·Fᵀ·Pp⁻¹` and the backward pass. Smoothed
  separately between restarts, which is correct. (A brute-force test in
  `tests/test_gps_cv_kalman.js` also checks this.)
- **Flat-map conversion**: metres ↔ degrees around the first fix. It uses the
  same scale both ways, so converting there and back is exact whatever the
  walk's size.
- **Duplicate timestamps** (`dt = 0`): handled without dividing by zero.

## How to test changes

Follow the project's rule of testing the simple version against real data
before a full rewrite. The measurements above came from three throwaway
scripts, which should become a proper harness if §1 is picked up:

1. **Health check across all walks**: skipped fixes, restarts, pinned stops,
   and the average "surprise" score, per walk.
2. **Stop profile**: for each pinned stop, its duration, how far it moved,
   and the jumps into and out of the dot.
3. **Fake bad fixes**: add an offset of X m for Y s at several points in a
   clean walk, then measure how far the finished path moves and how many
   restarts it causes.

Every change should also be scored with the existing street-distance
comparison from `gps_filtering_pipeline.md` §3.2, so a fix for bad stretches
doesn't quietly make ordinary walks worse.
