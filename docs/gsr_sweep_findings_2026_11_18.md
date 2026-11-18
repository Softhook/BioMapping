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

- The "cuffs disconnected" check now uses gain × uncalibrated reading. It
  still leaves out the offset, because a 116 nS offset would make an open
  circuit look connected. On this prototype, anything above about 5 MΩ
  still reads as disconnected. That comes from the board, not the check.
- `reference_test_results2.csv` now has its minus signs back and a date
  line.

## Still to explore

1. **Repeatability.** Run the wizard three times in a row without touching
   the leads during measurement, and write down Gain and Offset each time.
   This tells us how much the offset really moves between runs. It is the
   single most useful next number.
2. ~~Check the model directly.~~ **Done, and it confirms the model.** With
   nothing connected, `Mean:` reads **−313 counts**, so the board's real
   zero error is about **104 nS**, not the 116 nS the saved calibration
   used. Putting −313 counts into the model reproduces the measured high
   end to within 1–4 nS (9 MΩ: model 123, measured 122; 4.7 MΩ: model 224,
   measured 222). Both of today's wizard runs overshot the true offset
   (109 and 116 against ~104), so extending the line to zero tends to land
   too high, not just wobble. With the correct offset, 9 MΩ would read
   about 110 nS (−1 %) on this same board.
3. **Measure the zero point instead of extending a line to it.** This is
   now the leading fix. An open circuit is exactly 0 nS, with no resistor
   tolerance. A wizard step with the cuffs open could measure the zero
   counts, then remove them *before* the nS conversion, which is where the
   error actually happens. The fit would then only have to find the gain.
   One snag: the conversion clamps negative counts to 0, so this needs the
   raw counts. **Built (uncommitted, not yet tried on the device):** the
   wizard now starts with a "disconnect everything" step, removes the zero
   in counts before the conversion, and fits a gain only. The saved
   calibration and the CSV header carry `zero_counts` instead of `offset`
   (calibration file v6, so the wizard must be re-run once). In simulation,
   the prototype with a 2 mV offset and a 47k resistor 0.1 % off reads
   9 MΩ within 0.15 %; the old method was off by about 5 % on the same
   input. Still to do: re-run the wizard, then re-sweep.
4. **Weighting the fit.** The current fit treats a 6 nS miss at 47 kΩ the
   same as a 6 nS miss at 470 kΩ, so the 470 kΩ point barely steers the
   offset. A fit that weights by percentage error would pin the
   low-conductance end better. Try it on the numbers first, before changing
   anything.
5. **Did the bias correction actually help the low end?** One sweep each
   isn't enough. What the bias correction really protects against is drift
   (battery level, temperature, speaker load), so a fair test is the same
   resistor read over time or at different battery levels, not another
   sweep.
6. **The new PCB.** The OPA2333 should cut the 116 nS offset to almost
   nothing, and the 0.5 V guard blocks board leakage. Most of the
   high-end problem should go away there. Repeat the sweep on it before
   spending effort on items 3 and 4.
