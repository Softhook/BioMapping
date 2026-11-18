# GSR resistor sweep: what we found (18 November 2026)

## The short version

- The new sweep is **not** worse because of a firmware bug. We checked the
  maths on the device by hand, and it is doing exactly what it should.
- The bias correction was **never going to help the high-resistance end**.
  It fixes errors that grow with the reading. The high-end error is a
  fixed few nS that doesn't grow with the reading.
- The high end (1–9 MΩ) depends almost entirely on one number from the
  calibration: the **offset**. On the prototype board that offset is very
  large (116 nS), and small changes in a calibration run move it by
  several nS. At 9 MΩ (111 nS) a few nS is several percent.
- August reading +2.7 % at 9 MΩ and today +9.9 % is most likely
  **two different calibration runs landing in different places**, not one
  firmware being better than the other.
- **Confirmed later the same day:** with nothing connected, the board reads
  −313 counts, a true zero error of about 104 nS. The saved calibration
  assumed 116 nS. That 12 nS difference accounts for the high end almost
  exactly (see "Still to explore", item 2).
- **Fixed the same evening:** the wizard now measures the zero directly.
  A new sweep (`reference_test_results3.csv`) has every point from 10 kΩ to
  9 MΩ within ±0.7 %. See "Result with the new calibration" below.

## Why the bias correction doesn't help the high end

There are two kinds of error:

- **Scale errors** make every reading a fixed *percentage* too high or too
  low. A wrong 0.5 V bias is one of these: if the bias is 0.3 % low, every
  reading is 0.3 % high.
- **Offset errors** add or take away a fixed *number of nS*. 6 nS is
  nothing at 10 kΩ (100 000 nS) but over 5 % at 9 MΩ (111 nS).

The bias correction removes a scale error. The high-end problem is an
offset error. So the bias correction can help the low and middle range
(and it may have: 10 kΩ went from −0.54 % to −0.17 %), but it can't touch
the top end. That expectation was wrong from the start.

## Why the offset is so shaky on this board

The prototype reads about **116 nS too low before calibration**. It looks
like a fixed error of about 2.6 mV at the converter's input. The likely
sources are the MCP6002 op-amp (it can be up to 4.5 mV off) or the
protoboard. The calibration adds the 116 nS back.

But the calibration never measures that 116 nS directly. It measures
47 kΩ, 100 kΩ and 470 kΩ (about 2 000 to 21 000 nS), draws a straight line
through them, and **extends the line down to zero**. Extending a line that
far magnifies small errors:

| If this calibration point reads 0.1 % high | the 9 MΩ reading moves by |
|---|---|
| 47 kΩ | about +6 nS (+5 %) |
| 100 kΩ | about −4 nS (−4 %) |
| 470 kΩ | about −2 nS (−2 %) |

0.1 % is the tolerance of the calibration resistors. The same resistors
are used every time, so their tolerance gives a fixed error. It explains
why the high end can be a few nS out, but not why two runs differ.

The runs did differ. Two wizard runs today gave:

| Run | Gain | Offset | 470 kΩ would read |
|---|---|---|---|
| Photo of the "Success" screen | 1.002 | 109 nS | about 2 128 (correct) |
| The one saved and used for the sweep | 1.001 | 116 nS | about 2 133 |

The saved run is the one the sweep used, which is why everything above
about 68 kΩ reads 5 to 11 nS high.

## What we ruled out (tested on the device)

- **The radio scan:** GSR Only mode, which has no radio, read the same.
- **The menu beep upsetting the bias reading:** turning sound off changed
  nothing.
- **When the bias is read:** starting a recording re-reads it, and the
  reading didn't move.
- **The firmware applying the calibration wrongly:** by hand,
  gain × (reading from Mean and Vb) + offset matches the Filt line.

## Mistakes in the investigation

- An early comparison ("everything is +6 nS since August") compared two
  sweeps with different calibrations. It looked convincing but wasn't a
  fair test.
- The beep theory was announced too confidently, before there was any
  evidence for it.
- "Calibration should be accurate to 1 nS everywhere" came from an
  idealised model that ignored resistor tolerance and run-to-run changes.
  It was too optimistic.

## Also found and changed

- The "cuffs disconnected" check first used gain × uncalibrated reading,
  leaving out the offset, because a 116 nS offset would have made an open
  circuit look connected. With the new calibration there is no offset any
  more (the zero is removed before the conversion), so the check now uses
  the fully calibrated value, and high resistances on this prototype no
  longer read as disconnected.
- `reference_test_results2.csv` and `reference_test_results3.csv` have
  their minus signs back and a date line. The spreadsheet that makes them
  drops the sign of the error, so most of the readings were actually low.

## Result with the new calibration

The wizard now measures the board's zero with nothing connected, removes
it before converting to nS, and fits a gain only (no offset). Sweep in
`reference_test_results3.csv`, signed errors:

| Range | August | 18 Nov (old method) | New |
|---|---|---|---|
| 10k–33k | −0.14 to −0.53 % | −0.17 to 0 % | −0.04 to −0.14 % |
| 47k–470k | about 0 % | +0.02 to +0.26 % | 0 to −0.28 % |
| 1–9 MΩ, average error | 0.98 % | 3.94 % | 0.45 % |
| 1–9 MΩ, worst point | +2.70 % | +9.91 % | −0.68 % |

**What improved**

- **The high end is fixed.** 9 MΩ went from +11 nS to 0 nS, and nothing
  from 1 MΩ up is more than 4 nS out. The 104 nS zero error is now being
  removed correctly.
- **The low end is the best of the three sweeps.** 10 kΩ reads −0.10 %
  (−0.53 % in August).

**What got slightly worse**

- **The middle (100k–470k) reads 0.1–0.3 % low.** In August it read about
  0 % there, because the old offset term let the line pass through all
  three calibration points. The gain-only fit can't do that, and it is
  mostly decided by the 47k point (the largest number).
- **It is a percentage error, not a leftover zero.** In nS it shrinks
  towards high resistance: about −11 nS at 100k, −6 nS at 470k, −4 nS at
  1 MΩ and 0 at 9 MΩ. A wrong zero would be the same number of nS
  everywhere.
- **Best guess: the converter's gain ranges (PGA) don't quite match each
  other.** The ADS1115 switches range as the reading changes; 47k is read
  on a different range from 470k and above, and one gain can't correct
  all of them. The errors fall into rough groups (47k–68k about 0 %,
  100k–270k about −0.1 %, 330k up about −0.2 to −0.7 %), which fits, but
  it is not yet checked.

**A limit on the high-end numbers:** the diagnostic screen shows whole nS,
which is itself ±0.5 nS. At 9 MΩ (111 nS) that is ±0.45 %, so the 1–9 MΩ
percentages are at the edge of what the screen can show, and "0.00 % at
9 MΩ" is partly luck.

**Not changed:** the README's "±0.1 % (calibrated)" accuracy claim. The
middle range is now −0.1 to −0.3 %, so it is a little optimistic for this
board.

## Still to explore

1. **Check the PGA idea (no code needed).** Repeat a few points (47k,
   100k, 470k, 1 MΩ) and note `PGA:` on the diagnostic screen for each. If
   the error steps where the PGA changes, the gain ranges are the cause.
   If it is, one fix is a separate gain per range, measured by the wizard;
   that needs a calibration point on each range, so think it through
   before building anything.
2. **Weighting the fit.** The gain-only fit is dominated by the 47k point.
   Weighting each point by its percentage error would share the error
   more evenly across 47k–470k (roughly −0.1 % everywhere instead of
   0 % at 47k and −0.28 % at 470k). Try it on these numbers first, before
   changing anything.
3. **Repeatability.** Run the wizard two or three times and note Gain and
   Zero each time. The zero should agree within a few counts (1 count is
   about 0.3 nS). If it does, the 18 Nov run-to-run problem has gone with
   the old method.
4. **Did the bias correction help the low end?** One sweep each still isn't
   enough. What it really protects against is drift (battery level,
   temperature, speaker load), so the fair test is the same resistor read
   over time or at different battery levels.
5. **The new PCB.** The OPA2333 should make the zero almost nothing, and
   the 0.5 V guard blocks board leakage. Repeat the sweep on it; the zero
   step should then read close to 0.

## Earlier investigation notes

- **Model check (done):** with nothing connected, `Mean:` read −313
  counts, a zero error of about 104 nS against the 116 nS the old
  calibration assumed. Putting −313 counts into the model reproduced the
  18 Nov high end to within 1–4 nS (9 MΩ: model 123, measured 122). Both
  of that day's wizard runs overshot the true offset (109 and 116 against
  ~104).
- **Measuring the zero directly (built):** the wizard starts with a
  "disconnect everything" step, removes the zero in counts before the
  conversion, and fits a gain only. The saved calibration and the CSV
  header carry `zero_counts` instead of `offset` (calibration file v6). In
  simulation, the prototype with a 2 mV offset and a 47k resistor 0.1 %
  off reads 9 MΩ within 0.15 %, against about 5 % for the old method.
  Confirmed on the device by the sweep above.
