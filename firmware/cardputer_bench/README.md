# Cardputer bench test

A small test program for checking that the Flipper prototyping board (GSR circuit + GPS) works on an M5Stack Cardputer ADV, wired with jumper leads. It is not the real firmware.

## Wiring

Power the prototyping board from a separate 3.3 V supply (for example the Flipper's pin 9 and GND, with the board **not** plugged into the Flipper). Do not connect either of the Cardputer's 5 V pins.

| Cardputer EXT | Prototyping board |
|---|---|
| GND | GND (connect this first; it is shared with the 3.3 V supply's GND) |
| G8 (SDA) | SDA (Flipper pin 15) |
| G9 (SCL) | SCL (Flipper pin 16) |
| G13 | GPS RX |
| G15 | GPS TX |

Match the wires by signal name, not pin number, and check with a multimeter before switching on.

**Run the laptop on battery while testing.** A laptop charger has no earth pin and leaks a little mains hum onto the laptop's ground. Anything plugged into the laptop's USB shares that ground, and the GSR input picks the hum up. With a MacBook on its charger, a 1 MΩ resistor jittered by about 18 nS where it should be under 1 nS. Unplugging the charger cured it. For the same reason, plug only one device into the laptop: the Flipper on its battery while the Cardputer is on USB, or the other way round.

**Switch the 3.3 V supply on first and off last.** Once the program is running, the Cardputer holds G13 at 3.3 V whenever it is not sending. If the prototyping board has no power at that moment, G13 feeds current into the GPS's RX pin and partly powers the module through it. u-blox warns this can damage the module for good. If you can't control the order, unplug the G13 wire before switching the 3.3 V supply off.

## Build and flash

Install PlatformIO (the VS Code extension or `pip install platformio`), then from this folder:

```
pio run -t upload        # flash over USB-C
pio device monitor       # watch the once-a-second log
```

PlatformIO came with the VS Code extension, so if `pio` isn't found, use `~/.platformio/penv/bin/pio`.

If flashing fails, hold the Cardputer's G0 button while plugging in USB, then try again.

## What the screen shows

The I2C address list, PSRAM and clock lines are gone: those questions are answered (the ADC at `48` doesn't clash; no PSRAM; no clock chip).

| Line | What it means | Good result |
|---|---|---|
| Bias, supply | The board's 0.5 V reference, and the 3.3 V supply worked out from it | About 500 mV and 3.30 V (green) |
| GSR | Skin conductance with the board's zero removed, and the resistance that means | `open circuit` with nothing connected; 1 MΩ reads about 1,000 nS / 1.00 Mohm. Yellow until a zero is set |
| Zero / Noise | Before a zero: the raw open-circuit reading. After: how much the 100 ms values jump about within a second (nS, peak to peak), and the saved zero | With a fixed resistor, noise well under 1 nS |
| reads/s, err, gap, pga | Reads a second, failed I2C reads, the longest gap between two reads, and the ADC's range | About 900/s; errors stay at 0; gap stays in the tens of ms |
| Sats | Satellites used in the fix / heard (with a signal) / in view | Outdoors: used climbs to 8+ |
| Fix / signal | Time from start-up to the first fix, HDOP, and the strongest signal (dB-Hz) | Strongest signal 35+ in open sky; below about 25 is weak |
| Batt, boot | Battery voltage, how many times the Cardputer has started, and why it last started | `power on`, `USB` or `software` are fine. `BROWNOUT` (red) means the power dipped and reset it |

The bottom line shows which noise tests are on (yellow when on) and the time since start-up.

Keys:

| Key | What it does |
|---|---|
| **Z** | Sets the zero (see below) |
| **G** | Shows the GSR graph (press again to go back) |
| **R** | Resets the error count, the longest gap, the longest SD write and the key count |
| **B** | Bluetooth on/off (see "Noise tests") |
| **T** | Plays the Flipper's recording-start chirp and measures the jump |
| **S** | The same measurement as T, with no sound, to compare against |
| **L** | Steps the backlight: 128, 255, 64, 16, off, then back to 128 |
| **W** | SD card writing: each press tries the next way of writing (1–4), then off |

The graph shows the last 22 seconds, one point every 100 ms (the same window as one row of a real recording). The scale fits itself to what's on screen, and the numbers at the bottom give the range shown. Gaps mean open circuit.

### Setting the zero

The board reads slightly negative with nothing connected (about 100 nS low on this prototype). The Flipper firmware removes this with the calibration wizard's Zero step; this does the same.

1. Disconnect everything from the electrodes.
2. Press **Z**. It averages for 3 seconds.
3. "Zero saved" appears. The zero is kept in flash, so it survives power-off. If something was still connected, it says "Zero refused" and keeps the old one.

There is no gain step, so readings can still be off by the tolerance of the 47k resistor (about 1%).

## What to try

1. **Zero, then a known resistor.** 1 MΩ across the electrodes should now read close to 1,000 nS.
2. **Keyboard and GSR together.** With a resistor across the electrodes, type for a while, using number keys so none of the test keys fires. Noise and errors shouldn't change.
3. **Long run.** Press R, leave it for an hour, then check: errors 0, gap still small, boot count unchanged, keys still respond.
4. **GPS by a window or outdoors.** Note the first-fix time and the best signal. For the antenna test (doc section 6), compare the best signal and "used" count with the GPS facing up and facing down.
5. **GPS power.** If the boot line ever shows `BROWNOUT`, the GPS's current draw reset the Cardputer.

## Noise tests

These check whether the Cardputer's own parts disturb the GSR reading. Each key switches on one thing the real firmware does. Leave each setting for 2–3 minutes with a fixed resistor across the electrodes (1 MΩ, then 10 MΩ), and save the USB log.

- **B, Bluetooth.** The footer shows `BT adv` while it waits for a phone. To copy Live Stream, connect with a phone app such as nRF Connect, find "BioMap bench", and turn on notifications for its one characteristic. The footer then shows `BT conn`, and the Cardputer sends a 49-byte packet every 300 ms, as Live Stream does. Pressing B again stops all sending, but the radio stays switched on. For a "Bluetooth never started" comparison, restart the Cardputer.
- **T and S, tone.** T plays the two-note chirp the Flipper plays when a recording starts. It needs a resistor across the electrodes and 2 seconds of valid readings first. The spread of those 2 seconds (highest minus lowest) counts as normal. For the next 3 seconds it watches the 100 ms values, then shows the biggest move and when the reading last went outside the normal spread, counted from the end of the chirp: `Tone 3.78nS 100ms`, or `>3s` if it never stayed inside. The Flipper waits 200 ms after its chirp before it trusts the GSR again. S does exactly the same without playing anything. Ordinary jitter and slow wander also show up as a "move", so a T result only means something next to S results. Press T and S in turn, four or five times each, a few seconds apart. If T looks like S, the speaker has no real effect. If T moves clearly more, or takes longer than 200 ms to settle while S doesn't, the Cardputer needs a longer wait than the Flipper. The timing is only as fine as the 100 ms values.
- **L, backlight.** The levels between off and full dim the screen by switching it on and off very fast, which can disturb the supply. At "off" the screen is dark but the log still runs. Press L again to bring it back.
- **W, SD card.** Needs a microSD card in the Cardputer's slot. Every 10 seconds it writes about 12 KB to `/bench_sd_test.csv` in one go, about what a recording writes, then saves the file. Each press of W tries the next way of writing, starting the file again from empty:
  1. **plain:** add to the end of the file.
  2. **reserved:** first reserve 8 MB of space, as the Flipper does when a recording starts. The card's file table then doesn't need changing on every write.
  3. **sectors:** as 2, but each write is exactly 24 whole 512-byte blocks.
  4. **40 MHz:** as 3, with the card running faster (25 MHz in 1–3).

  The footer shows the mode and its longest write (`SD2 45ms`), and after each write the third line shows its time and how much of it went on saving. The Flipper pauses for 20–60 ms. While a write runs the reading pauses, so the gap and reads/s get worse. That is a side effect of this test program running everything on one thread; the real firmware reads the GSR on its own thread. Give each mode at least a minute (6 writes).

### Comparing with the Flipper

Record 2–3 minutes on the Flipper with the same resistor, then run:

```
python3 scripts/bench_noise.py FLIPPER_FILE.csv cardputer_log.txt
```

(from the repo's top folder). It works out the same noise number from the Flipper file and splits the Cardputer log into one row per setting. It leaves out the second either side of each change, and tone tests, and lists the tone tests separately, chirp and silent side by side. It warns if the readings differ by more than 5%, which usually means a different resistor. `--from` and `--to` (seconds) keep only part of a file.

To save the log: `pio device monitor | tee cardputer_log.txt`.

**Power for these tests.** With the board powered from the Flipper, these tests only show what the Cardputer's radio, speaker, screen and SD card put onto the shared ground and I2C wires. They say nothing about the Cardputer's own power supply. For that, power the board from a low-noise 3.3 V regulator fed from the Cardputer's 5V OUT, as in the real design, and run them again. Never connect 5V OUT to the board directly.

## If something is wrong

- **"ADC not found":** check SDA/SCL aren't swapped, the board has 3.3 V, and the grounds are joined.
- **"GPS no data … 0 B/s":** nothing is arriving. Check that G15 goes to the GPS **TX**.
- **"GPS no data" with bytes arriving:** the speed is wrong or the line is noisy. It switches between 9600 and 115200 every 3 seconds by itself.
- **Bias far from 500 mV:** the 3.3 V supply is off, or the bias resistors are wrong.

The log on the USB serial port is a CSV line every second, so you can save it and look at a long run afterwards.
