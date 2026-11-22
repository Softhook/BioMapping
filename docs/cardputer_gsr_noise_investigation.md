# Cardputer GSR noise: where we are (22 November 2026)

Notes for picking the investigation up again. Most figures come from
`scripts/gsr_noise_check.py` (see "How to repeat the analysis"). The
rest are worked out from them: the ADC ranges, the µV figures and the
10-second averages in section 4.

## The short version

- **With the same board, resistor and supply, the Cardputer reads about as
  well as a Flipper.** On 220 kΩ the Cardputer is 0.6–0.8 nS between its
  drops. The two Flippers, each powering the board themselves, are 0.4 and
  0.6 nS.
- **Most of the trouble comes from the board being powered by something
  other than the device reading it.** That set-up gives sudden jumps in
  the reading. 7 of the 8 such recordings have them, on a Flipper's power
  and on the bench supply. Flippers powering their own board show none in
  three recordings, and a few small ones in the fourth.
- **The Flipper's dip is every 10 seconds, not every second.** One row
  reads low after each SD card write: about 10 nS on 47 kΩ and 1 nS on
  220 kΩ.
- **The Cardputer's once-a-second dip is real** (it is there in every
  second) and still unexplained. It didn't show in the last two Cardputer
  recordings.
- **Moving the ADS1115 to its own I2C bus fixed the 600k noise.** It is
  0.26 nS, the Flipper's level.
- **The floor is about 7 µV per row at the ADC, on every ADC range.** That
  is 0.45 nS on 47 kΩ and 0.33 nS on 220 kΩ.
- **None of this matters for skin readings.** A small skin response is
  10–50 nS. The biggest effect left on a working set-up is about 2 nS.

## Bench set-up

- **One prototype board, shared by all three devices.** It is on jumper
  wires: dual op-amp, ADS1115 breakout with its own pull-up resistors, and
  the 56 kΩ / 10 kΩ bias divider. A test resistor stands in for the
  fingers. The wires are moved from device to device for each test.
- **The Cardputer has no 3.3 V on its connectors,** so when it reads the
  board, a Flipper powers it. In `biomap_0009_nodate.csv` a bench supply
  powered it instead, with the Flipper disconnected.
- **On the Cardputer the ADS1115 is on G5/G6** since 21 Nov (`28670a3`).
  The wires were twisted at the same time.
- **The devices:** the Cardputer, and two Flippers called Walflow and
  And4lo7h.
- **Battery:** every device ran on battery on 22 Nov. The Cardputer was
  also on battery for 0005, 0006 and 0009. Not known for the earlier
  files.
- **GSR Only, with Debug Fields on,** so the window spread (hum) column is
  written. The Flipper files have it from the 220 kΩ set on.
- **A second GSR board** is available and hasn't been used yet.

## Recordings

Noise is the standard deviation after removing a straight-line trend. Hum
is the window spread column (`gsr_spread_ns`). The `nodate` files are from
the Cardputer, which has no clock. A time with ~ is when the file was
saved or copied.

### The Cardputer, 20–22 Nov

The dip is how far the deepest tenth-of-a-second slot sits below the rest,
with its slot in brackets. Jumps are the sudden level changes the script
finds: how many, and how big.

| File | When | Resistor, mode | Board power | Noise | Dip | Jumps | Hum | Bias |
|---|---|---|---|---|---|---|---|---|
| `biomap_2026-11-20_23-04-31.csv` | 20 Nov 23:04 | 47k, GPS + GSR, old bus | Flipper | 3.0 nS | −2.7 (.1) | 4 of 4.5–6.7 nS | – | 497.3 mV |
| `biomap_2026-11-21_08-30-13.csv` | 21 Nov 08:30 | 47k, GPS + GSR, old bus | Flipper | 2.3 nS | −2.5 (.0) | 3 of 4.5–5.8 nS | – | 497.0 mV |
| `biomap_0003_nodate.csv` | 21 Nov ~22:08 | **600k**, GSR Only | Flipper | 0.26 nS | none | none | – | 497.7 mV |
| `biomap_0005_nodate.csv` | 21 Nov ~23:16 | 47k, GSR Only | Flipper | 2.1 nS | −2.6 (.3) | 18 of 1.9–4.9 nS | – | 496.9 mV |
| `biomap_0006_nodate.csv` | 21 Nov ~23:56 | 47k, GSR Only | Flipper | 0.73 nS | none | none | 21.8 nS | 498.1 mV |
| `biomap_0009_nodate.csv` | 22 Nov ~00:15 | 47k, GSR Only | **bench supply** | 1.5 nS | −1.0 (.2–.3) | 7 of 2.6–3.4 nS | 83.8 nS | 504.8 mV |
| `biomap_0010_nodate.csv` | 22 Nov ~09:35 | 47k, GSR Only | Flipper | 4.3 nS | none | 6 of 6.5–12 nS | 14.2 nS | 496.7 mV |
| `biomap_0012 220_nodate.csv` | 22 Nov, 220k set | **220k**, GSR Only | Walflow | 0.86 nS | none | 3 of 1.6–2.4 nS | 4.5 nS | 497.0 mV |

- **Firmware:** the two old-bus files were made with older builds and no
  calibration, which is why they read about 0.7% lower. 0003 used the
  own-bus build. 0005 most likely used `03fdf3b` (exact 100 ms window).
  0006, 0009, 0010 and 0012 used `0298ad8` (spread column).
- **Every file closed cleanly:** each has its `# End` line, with no lost
  rows. The files with debug columns also show no gain changes during the
  recording.
- **The fingers-on GSR-only file can't show the dip.**
  (`biomap_2026-11-21_cardputer_00-29-07.csv`, about 5,600 nS.) Skin moves
  so much that the per-second line-up is only good to ±9 nS.

### Three devices on one board, 22 Nov

Same board and the same resistor, moved from device to device. "Own" means
the reading device powers the board itself. The bias shows whose supply it
was: Walflow's reads 497–498 mV and And4lo7h's 494–495 mV.

| File | Reads | Resistor | Board power | Noise | 10 s SD dip | Once a second | Jumps | Hum | Bias |
|---|---|---|---|---|---|---|---|---|---|
| `biomap_2026-11-22_09-22-542.csv` | Walflow | 47k | own | 1.18 nS (0.51 without SD rows) | −9.4 nS | none | none | – | 497.9 mV |
| `biomap_2026-11-22_10-29-54.csv` | And4lo7h | 47k | own | 1.23 nS (0.47 without SD rows) | −10.2 nS | none | none | – | 495.0 mV |
| `biomap_0010_nodate.csv` | Cardputer | 47k | a Flipper | 4.3 nS | none | none | 6 of 6.5–12 nS | 14.2 nS (230 µV) | 496.7 mV |
| `biomap_2026-11-22_10-12-02 220.csv` | Walflow | 220k | own | 0.40 nS | −1.1 nS | −0.39 nS (.0) | none | 8.4 nS (180 µV) | 497.1 mV |
| `biomap_2026-11-22_10-22-58 220.csv` | And4lo7h | 220k | Walflow | 4.6 nS (first 58 s) | unclear | unclear | 2 of 8.6–9.4 nS | 209 nS (4.5 mV) | 497.0 mV |
| `biomap_0012 220_nodate.csv` | Cardputer | 220k | Walflow | 0.86 nS | none | none | 3 of 1.6–2.4 nS | 4.5 nS (96 µV) | 497.0 mV |
| `biomap_2026-11-22_10-37-12 220.csv` | And4lo7h | 220k | own | 0.74 nS (0.6 after 30 s) | −1.0 nS | −0.15 nS (.1–.2) | 6 of 1.2–2.4 nS, 4 in the first 31 s | 29 nS (620 µV) | 494.2 mV |

- **And4lo7h on Walflow's power lost the sensor at about 59.5 s.** The I2C
  error count climbs to 206 and the reading drops to 0, so a wire most
  likely came off. The script uses the rows up to 1 s before the first
  I2C error, the first 58 s.
- **And4lo7h on its own power wobbles by about ±1.5 nS for the first 30 s,**
  while the hum changes too. That looks like a hand moving away after
  pressing start. After that it holds 0.6 nS.
- **The calibrated devices agree:** on 220 kΩ, Walflow reads 4,535.9 nS and
  the Cardputer 4,534.9 nS, 0.02% apart. And4lo7h isn't calibrated (see
  "Other answers").
- **File names:** the 220 kΩ files have " 220" added, with a space, so
  quote them in commands. Cardputer files carry a 1980 date, so they sort
  last by date.

## Comparing fairly

### The ADC range

A recording starts on ±2.048 V and steps to a finer range while the
reading is under 4,096 steps. For a fixed resistor that gives:

- **±2.048 V below 82 kΩ** (above 12,200 nS). 47 kΩ is here: 3.85 nS per
  ADC step.
- **±1.024 V from 82 to 173 kΩ.**
- **±0.512 V from 173 to 356 kΩ.** 220 kΩ is here: 0.73 nS per step.
- **±0.256 V above 356 kΩ** (below 2,810 nS). 600 kΩ is here: 0.34 nS per
  step.

Skin recordings in `tracks/` sit at 3,500–9,600 nS, about 105–285 kΩ. That
is the ±0.512 V and ±1.024 V ranges.

The calibration wizard measures 47 kΩ on ±0.512 V, because it comes down
from the open circuit and 100 kΩ steps. So its noise figures for 47 kΩ
aren't like-for-like with a 47 kΩ recording.

### The noise floor

- **On the Flipper the row-to-row noise is about 7–8 µV at the ADC, on
  every range:** 0.44 nS on 47 kΩ, 0.33 nS on 220 kΩ and about 0.3 nS on
  600 kΩ. So the floor is a fixed voltage, not one ADC step per reading.
  Counting it as one step per reading gives 0.45 nS on 47 kΩ, which
  matches, but only 0.09 nS on 220 kΩ, which is too low.
- **The Cardputer and And4lo7h (own power) are 10–11 µV on 220 kΩ.**

### The test resistor

- **220 kΩ is the standard test resistor.** It sits in the middle of the
  ±0.512 V range, so the autoranger never switches during a test. It is in
  the skin range, and it isn't a calibration point.
- **47 kΩ makes faults look bigger.** A supply wobble of 0.05% is 10.6 nS
  on 47 kΩ but 2.3 nS on 220 kΩ. A 23 Ω change in a joint in series with
  the resistor is 10 nS on 47 kΩ but 0.5 nS on 220 kΩ. So 47 kΩ is useful
  when hunting a supply or wiring fault.
- **47 kΩ being a calibration point doesn't matter for noise.**
  Calibration multiplies every reading by the same number and shifts it by
  the same amount. It only means 47 kΩ can't check accuracy, because the
  calibration was fitted there.
- **Use a metal film resistor,** soldered or firmly clamped, and leave it
  for two minutes after handling. The 47 kΩ Flipper files crept by
  0.7–1.7 nS over two minutes, which looks like the resistor settling in
  temperature.

## The parts of the noise

### 1. Quick jitter

This is the row-to-row wobble.

- **Cardputer:** 1.5–2.5 nS on 47 kΩ on the old bus, and 0.67–0.98 nS on
  the new one. 0.52 nS (11 µV) on 220 kΩ.
- **Flipper:** 0.44 nS on 47 kΩ, and 0.33–0.49 nS (7–10 µV) on 220 kΩ.

### 2. The Cardputer's once-a-second dip

**What we know**

- **Size:** one row a second reads 1–2.7 nS low on 47 kΩ (0.005–0.013%).
  In 0009 it is shared between two neighbouring rows. So it lasts up to
  about 100 ms, or falls near the boundary between two rows.
- **It is there in every second.** Lining rows up by their place in each
  10-second block shows the same dip in every second (0005: −2.0 to
  −2.6 nS in each of the ten). That sets it apart from the Flipper's
  10-second dip (section 3).
- **Fixed in time:** within a recording it stays in exactly the same tenth
  of a second for 2–3 minutes, with no drift. Whatever causes it keeps time
  very accurately, like a quartz clock.
- **Not tied to the recording start:** the slot differs from file to file.
  That fits something running on the Cardputer's own clock since it was
  switched on, or a once-a-second device nearby.
- **Starts small in 0005:** it was about half size for the first 30 s
  (−1.2 nS), then −2.5 to −2.7 nS.
- **Comes and goes:** it is in 0005, 0009 and the two old-bus files. It
  isn't in 0006, 0010 or 0012. On 220 kΩ (0012) it would have shown as
  0.25–0.55 nS if it scales with the reading, or 1–2 nS if it is a fixed
  voltage. The line-up shows at most −0.13 nS, at the edge of chance.
- **Not one wild reading:** the window spread doesn't rise at the dip slot
  in 0009. One wild reading of 17 or more ADC steps would have shown.
  Smaller bursts can't be seen there, because the bench supply's hum is so
  large.

**Ruled out**

- **The GPS:** the dip appears in GSR Only (0005, 0009).
- **The Flipper and its supply:** the dip appears on the bench supply with
  the Flipper disconnected (0009).
- **USB and the Mac charger:** the Cardputer was on battery for 0005, 0006
  and 0009.
- **Wi-Fi Files:** it was added on 21 Nov at 16:45, after the first two
  dip recordings, and it switches off when its screen closes.
- **The exact 100 ms window change (`03fdf3b`):** the dip is the same size
  in recordings made before it.
- **Debug Fields:** the two old-bus dip files had Debug Fields off. 0006,
  0010 and 0012 had them on, with no dip.
- **The supply voltage:** an earlier hint was that the dip only appeared at
  a slightly lower bias. 0009 had the highest bias yet and still has the
  dip.
- **Probably not the USB status line** (`log_second()` in
  [main.cpp](../firmware/cardputer/src/main.cpp)) or the debug `heartbeat`
  line. With no computer listening, the USB write returns before sending
  anything. This was checked in `USBCDC::write` in the installed ESP32
  Arduino core (the firmware uses USB mode 0). A test build with both lines
  switched off would prove it.
- **Not clearly the resistor:** the 600k recording had no dip, but neither
  did 0006 on 47 kΩ.

**Still possible**

- Something on the Cardputer that runs once a second and holds up or
  disturbs the GSR readings. For example, the main loop's once-a-second
  jobs, or the ESP32's own background tasks.
- Something near the bench that ticks or blinks once a second. A quartz
  wall clock gives a small magnetic pulse every second.
- Nothing yet explains why it comes and goes.

### 3. The Flipper's dip every 10 seconds (SD card writes)

- **What:** one row reads low every 10 s. It is the first row after the
  firmware writes the saved rows to the card (`FLUSH_INTERVAL` in
  [biomap_types.h](../firmware/core/biomap_types.h)). The rows in between
  show nothing. In the script's tenth-of-a-second line-up it looks like a
  once-a-second dip of about 1 nS in slot .0. The 10-second line-up shows
  it is only in the tenth second.
- **Size:** about 10 nS on 47 kΩ (0.044–0.048% of the reading), and
  1.0–1.1 nS on 220 kΩ (0.022–0.024%).
- **Not the status light:** the heartbeat blink stays on for 500 ms, and
  the dip is one row.
- **Seen in all four Flipper files where the Flipper powers its own
  board.** The one Flipper file on another Flipper's power (And4lo7h on
  Walflow's) is too noisy to tell: −1.1 ± 1.1 nS over 5 writes.
- **The Cardputer writes to its card every 10 s too, and shows no dip
  there.** Its card isn't on the board's supply.
- **Likely cause:** the card's current briefly pulls down the Flipper's
  3.3 V, which the bias is made from. Not proven: the share of the reading
  halved between the 47 kΩ and 220 kΩ sets, which a pure supply dip
  wouldn't do. The 47 kΩ files have no debug columns, so the two sets may
  also differ in build or settings.
- **For skin:** one row every 10 s, about 1–2.5 nS at 5,000 nS.

### 4. Jumps (when the board is powered by something other than the reader)

The reading jumps to a new level within a row or two and holds it for
seconds, then jumps again.

**Where they are**

- **Board powered by something other than the reading device: 7 of 8
  recordings.**
  - Cardputer on a Flipper's power: both old-bus files (3–4 jumps of
    4.5–6.7 nS), 0005 (18 of 1.9–4.9 nS), 0010 (6 of 6.5–12 nS) and 0012
    (3 of 1.6–2.4 nS). 0006 had none.
  - Cardputer on the bench supply: 0009 (7 of 2.6–3.4 nS).
  - And4lo7h on Walflow's power: 2 of 8.6–9.4 nS, then the wires came
    off.
- **A Flipper powering its own board:** none in three recordings. And4lo7h
  on 220 kΩ had 4 in its first 31 s, while its hum changed too, which
  looks like a hand. After that it had two of 1.2 nS, just over the
  finder's threshold.

**What they look like**

- **In 0005 the reading switches between two levels about 4.5 nS apart,**
  for example from +1.4 to −3.6 nS at 20.5 s.
- **In 0010 the reading and the hum move opposite ways** at every jump:
  reading down, hum up. Second by second, the link between the two is
  −0.65.
- **In 0012 the reading drops by 1.6–1.9 nS for about 15 s three times**
  (20–35, 73–88 and 126–141 s, measured from 10 s averages). The jump
  finder catches three of the six edges; the others are just under its
  threshold. Two of the drops came with a short burst of hum (70–90 and
  120–130 s). Between the drops the Cardputer is 0.6–0.8 nS.

**What we know about the cause**

- **They act on the whole reading.** The 0010 jumps are 0.031–0.056% of
  the reading and the 0012 jumps 0.035–0.053%, about the same share on
  both resistors. That fits the bias moving, which needs about 1–2 mV of
  change on the 3.3 V supply. A joint in series with the resistor would
  give a share about 5 times smaller on 220 kΩ.
- **It isn't only a Flipper waking up.** 0009 was on the bench supply and
  still jumps. For 0012's 15-second drops, the powering Flipper waking is
  still a candidate. An idle Flipper turns its screen light off after its
  backlight time, and wakes on a button press. The Cardputer has no
  15-second timer: its screen brightness is a fixed ON or DIM setting
  ([settings_cardputer.cpp](../firmware/cardputer/src/settings_cardputer.cpp)),
  with no timeout.
- **What two-device set-ups share:** the reading device and the supply are
  joined only through the board's wires. Current from the I2C lines
  returns through the ground wire between them. A joint there that
  changes would move the board's ground or supply. Not tested.

### 5. The slow wave (Cardputer, 47 kΩ)

- **It is mostly the jumps.** The script's slow-wave figure found 0.9 nS
  in both old files, 1.5 nS in 0005, none in 0006, and 0.5 nS in 0009,
  with periods of 16–24 s that drift. Looking at the rows, those files all
  have jumps (section 4), and the jumps are what the figure picks up. 0006
  has neither.
- **Mains hum can add a small true slow wave on the bench supply.** If the
  mains runs slightly off 50 Hz, the bit of hum left after the 100 ms
  average makes a slow wave with this kind of period. The simulator says
  the average lets about 0.1% of the hum through. On the Flipper's supply
  that is about 0.02 nS. On the bench supply, with four times the hum, it
  could make 0.1–0.4 nS.

### 6. Mains hum (the window spread column)

- **The average removes nearly all of it.** On 0006, random noise the size
  of the spread would make the rows wobble by about 2.5 nS. They actually
  wobble by 0.67 nS. So almost all of the spread is a steady repeating
  signal that the 100 ms average cancels. Mains hum (50 Hz and its
  multiples) fits.
- **How much hum there is depends on the set-up far more than on the
  device.** At the ADC:
  - Cardputer: 96 µV (0012), 230 µV (0010), 350 µV (0006), and 1.4 mV on
    the bench supply (0009)
  - Walflow on its own power: 180 µV
  - And4lo7h on its own power: 620 µV. On Walflow's power: about 4.5 mV.
- **Hum changes go with the level changes** in section 4 and And4lo7h's
  first 30 s.
- **Probably picked up by the jumper wires and the test resistor.** Not
  yet tested by holding a hand near the wires.
- **Bench supply type unknown:** a switching supply, or one with its output
  tied to earth, would explain its extra hum.

### 7. Frozen rows at the Cardputer's first SD write

- **In 0005, 0006 and 0010, 5–8 rows around 10 s hold nearly the same
  value.** In 0006 and 0010 the hum column barely moves either (at most
  0.03 and 0.10 nS, against a typical 0.53 and 1.15). 0005 has no hum
  column, so it rests on the odds alone (about 3 in 1,000 at that place).
- **Cause:** the main loop stalls for 0.5–0.8 s at the first card write.
  The missed rows are then written back to back, all averaging nearly the
  same latest 100 ms window (see the `COUNTED_WINDOW_GAP_MS` note in
  [gsr_sensor.c](../firmware/core/gsr_sensor.c)).
- **Only the first write:** the writes at 20 s, 30 s and so on are fine,
  and 0009 and 0012 had no freeze.
- **Not worth fixing for now:** it happens once per recording, near the
  start.

### 8. Small once-a-second dips on the Flippers (220 kΩ)

- **Walflow:** −0.39 nS in slot .0 of every second. **And4lo7h** on its own
  power: −0.15 nS in slots .1–.2.
- **Neither shows on 47 kΩ,** where the same share would have been about
  1.8 nS on Walflow.
- **Both 220 kΩ files had Debug Fields on,** which adds log lines once a
  second. But the slot differs between the two files. Cause unknown, and
  too small to matter.

## Other answers from this investigation

- **The exact 100 ms window (`03fdf3b`) can't have made anything worse.**
  In the hum simulator (`firmware/tests/benchmarks/gsr_hum_sim.c`, old
  `28670a3` code against new), the new window never lets more hum through.
  In one of the Cardputer's two timings it drops from 1.08% to 0.10%. In
  the other both are 0.11%.
- **Reading the ADC more slowly, like the Flipper, has no value.** Both
  devices run the ADC at 860 readings a second. The Cardputer reads it
  every 1 ms and the Flipper every 2 ms. More reads make the ADC's own
  noise about 20% lower (0.117 against 0.148 steps). The measured noise is
  about 1 step, so read speed isn't what limits it.
- **The USB status line is needed** by `firmware/cardputer/tools/hw_test.py`,
  and for live noise checks over USB. On battery it costs almost nothing.
- **Smoothing the 0.5 V bias:** about 10 µF across the bias divider's
  10 kΩ (op-amp B's input, pin 5). Written up in
  [cardputer_port.md](cardputer_port.md), "Making the bias voltage stop
  mattering". Not tried yet. It would soften the SD-write dip. The
  15-second drops are far too slow for it: only a steady supply, or a
  voltage reference for the bias, would stop those.
- **Calibration and a shared board:** each device stores its own
  calibration, but the calibration describes the board fitted when it was
  made. Recalibrate each device on a board before comparing readings
  between devices. Noise tests don't need calibration.
- **And4lo7h isn't calibrated.** It reads 0.75% low on 47 kΩ and 2.6% low
  on 220 kΩ. The missing zero offset (about 320 counts) is a bigger share
  of a smaller reading.
- **Walflow's current calibration (20 Nov) is noisy:** noise_ns 2.13, 2.14
  and 2.39 nS, against 0.11–0.54 nS on 18 and 19 Nov. The gain is fine
  (1.0004). Worth redoing on battery.
- **The board must have pull-ups for the Cardputer:** G5 and G6 have none
  on the Cardputer. The prototype uses the ADS1115 breakout's.

## Changes made

- **Pushed:** `28670a3` (ADS1115 on its own bus) and `03fdf3b` (exact
  100 ms window, and the graph follows the average).
- **Committed on main, not pushed:**
  - `0298ad8`: `gsr_spread_ns` debug column, the "not the GPS" docs fix
    and the capacitor note
  - this document, with `scripts/gsr_noise_check.py`
- **Flashed:** the Cardputer runs `0298ad8`. Both Flippers run a build with
  the spread column from the 220 kΩ set on.
- **Not committed:** `firmware/tests/benchmarks/gsr_hum_sim.c`, and the
  matching edits in `docs/cardputer_port.md` and
  `docs/gsr_pulse_observation_2026_11_21.md`.

## How to repeat the analysis

```
python3 scripts/gsr_noise_check.py tracks/biomap_0006_nodate.csv "tracks/biomap_0012 220_nodate.csv"
```

For each file the script prints:
- the reading, the ADC range and the nS per ADC step
- noise: overall, without the SD-write rows, in 20 s windows and in 30 s
  stretches
- the tenth-of-a-second line-up, with the dip, its slot and the chance
  level
- the 10-second line-up: the first row of each tenth second (the SD
  write) against the same slot in the other seconds, and whether the dip
  found above is in every second or only in the tenth
- the slow wave
- jumps: how many, how big (also as a share of the reading) and when
- frozen rows, with a separate look at the first SD write
- with the `gsr_spread_ns` column (Debug Fields on): the hum, and how it
  moves with the reading second by second

If the sensor was lost (an I2C error or a zero reading), the script uses
only the rows from more than 1 s before it, and says so.

Things to know:
- **The slow-wave figure also picks up jumps.** Check the jumps line before
  reading it as a wave.
- **Without the hum column, frozen rows rest on odds alone.** With it, a
  run only counts when the hum column barely moves too.
- **Quote file names that have spaces** (the 220 kΩ files).

To build the hum simulator, follow the build lines at the top of
`gsr_hum_sim.c`.

## Next steps, in order

1. **Find what makes the jumps:**
   - **Button-press test, for 0012's 15-second drops.** Record the
     Cardputer on 220 kΩ with a Flipper powering the board. At about 30,
     90 and 150 s, press a button on that Flipper and note the times. If
     the reading drops each time, for as long as its screen stays lit, the
     powering Flipper waking is the cause of those drops. Its backlight
     time is under Settings → LCD and Notifications → Backlight Time.
   - **Second ground wire.** With the board on another device's power, add
     a second, firm ground wire between the reading device and the board.
     If the jumps get rarer or smaller, the ground joint between the two
     is the cause.
2. **Give the Cardputer's board a steady supply of its own,** the way the
   printed board will: a small low-noise regulator fed from the Cardputer's
   5 V. This is the real like-for-like test. It also makes the Cardputer
   the only device on the board, like a Flipper powering itself, which is
   the set-up without jumps.
3. **Bench habits for every test:**
   - 220 kΩ, soldered or firmly clamped, left for two minutes after
     handling
   - each device powers the board itself where it can. When one device
     powers another's board, keep the powering one in a fixed state and
     don't touch it.
   - after pressing start, take your hand away and ignore the first 30 s
   - 3 minutes per recording, and at least two recordings per condition
   - Debug Fields on, so the hum column is written
4. **The Cardputer's once-a-second dip:** keep watching for it. If it comes
   back:
   - add a debug column for the number of readings in each window. If
     something holds up the GSR readings once a second, the dip rows will
     have fewer.
   - then make a test build with the once-a-second jobs (`log_second()` and
     the debug heartbeat) switched off.
5. **Calibrate And4lo7h, and recalibrate Walflow on battery,** on the board
   used for the tests.
6. **The second GSR board:** check it has pull-ups on SDA and SCL before
   using it with the Cardputer. Then run the same three-device set on it.
7. **Optional, as these are too small to matter for skin:**
   - The SD-write dip: one Flipper recording on another, idle Flipper's
     power, with good wiring. If the dip goes, the card's current on the
     supply is confirmed.
   - One Walflow recording with Debug Fields off, to see whether its small
     once-a-second dip goes.
   - The 10 µF bias capacitor.
   - Hum test: hold a hand near the wires without touching. The hum column
     should jump.

## Questions to answer

- During 0012, did anyone touch the powering Flipper or press its buttons?
- What is the second GSR board? The same circuit? On a breadboard, soldered
  or printed? Does it have pull-ups on SDA and SCL?
- Is the bench supply a switching or a linear one? Is its output tied to
  earth?
- Was anything different for 0006, the clean 47 kΩ Cardputer recording?
  Time, wires, anything switched on or off nearby?
- Recordings 0007, 0008 and 0011 aren't in `tracks/`. Were any of them
  useful?
