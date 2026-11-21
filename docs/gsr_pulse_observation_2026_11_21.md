# Heartbeat and a once-a-second dip in the Cardputer GSR (21 November 2026)

## The short version

- **The heartbeat shows up in the GSR.** With fingers in the cuffs, the
  Cardputer picks up a small, steady ripple at about **78–81 beats a
  minute**. It is tiny: about 3 nS on a reading of about 5,600 nS
  (0.05 %). A sweat response is hundreds to thousands of nS, so the pulse
  doesn't get in the way of the analysis.
- **There is also a once-a-second dip that is not the heartbeat.** In
  recordings with GPS on, one reading in every ten drops by about 2.4 nS,
  exactly once a second. It is caused by something in the device, most
  likely the GPS. It is also tiny (0.01 %).
- Neither needs a fix. Both are only visible because the graph zooms in on
  a very flat signal.

## The once-a-second dip

Recordings: `biomap_2026-11-20_23-04-31.csv` (129 s) and
`biomap_2026-11-21_08-30-13.csv` (98 s), both GPS + GSR, both with the
47 kΩ test resistor fitted rather than fingers. They read about
21,130 nS (47.3 kΩ) and move by only about ±2 nS, which skin never does.

What it looks like:

- The frequency analysis shows sharp spikes at exactly 1, 2, 3, 4 and 5
  times a second. That is what a short drop repeated once a second looks
  like. A heartbeat would give one broad bump that moves about, not a
  spike at exactly 60 a minute.
- Lining the readings up on each second shows the drop in the same tenth
  of a second for the whole recording, about 2.4 nS deep.
- The drop sits at a different point in the second in the two files. So
  it follows the device's running clock (`millis()`), not the start of the
  recording.

What it isn't: the once-a-second recording light (`BioMapCueHeartbeat`)
does nothing on the Cardputer, which has no light and plays no sound for
that cue.

What it probably is: the GSR-only recording below has no dip at all. The
USB status line (`log_second()` in
[main.cpp](../firmware/cardputer/src/main.cpp)) and the screen clock
were running in both, so the GPS is the most likely cause, probably its
once-a-second burst of messages. **Not yet proved.** To prove it, record
with the 47 kΩ resistor in GPS + GSR mode and then in GSR-only mode, and
compare.

## The heartbeat

Recording: `biomap_1970-01-01_00-29-07.csv` on the card (the clock wasn't
set from GPS), GSR only, 122 s, fingers in the cuffs, sitting still.
Readings 4,900–7,900 nS, with several normal sweat responses.

To look for a pulse, the slow sweat changes were filtered out first,
leaving only what changes faster than about 0.7 times a second.

- **A separate peak at 1.30–1.40 a second (78–84 a minute),** with
  clearly less on both sides of it (1.20–1.25 and above 1.45). So it is
  not spill-over from the slow sweat changes.
- **A smaller peak at 2.7 a second,** exactly double. A repeating pulse
  shape makes this.
- **Steady over time:** in 20-second chunks the strongest peak sits at
  78–84 a minute in most chunks. The chunks where it doesn't are the ones
  with a big sweat response or movement.
- **Two different filters agree.** Subtracting a 1.5 s moving average
  and taking the difference between neighbouring readings both show the
  peak. With the second filter, 1.28–1.45 a second has 6–8 times the
  power of the bands either side.
- **Size:** about 3 nS in the calm middle of the recording (20–100 s).
- It is **not at exactly 60 a minute** and doesn't appear in the
  resistor recordings, so it isn't the device.

The likely reason: each heartbeat slightly changes the blood in the
fingertips under the cuffs, which nudges the skin contact a little.

**Not yet checked:** the rate against a pulse counted by hand at the
same time.

## How the analysis was done

Plain numpy on the `gsr_raw` column at 10 readings a second: averaged
frequency analysis over 20 s windows (Hann window, 50 % overlap), and
averaging the readings by their tenth-of-a-second position within each
second to find anything tied to the device's clock.
