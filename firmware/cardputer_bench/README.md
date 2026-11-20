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

The bottom line shows the keys and the time since start-up.

Keys: **Z** sets the zero (see below), **G** shows the GSR graph (press again to go back), **R** resets the error count, the longest gap and the key count.

The graph shows the last 22 seconds, one point every 100 ms (the same window as one row of a real recording). The scale fits itself to what's on screen, and the numbers at the bottom give the range shown. Gaps mean open circuit.

### Setting the zero

The board reads slightly negative with nothing connected (about 100 nS low on this prototype). The Flipper firmware removes this with the calibration wizard's Zero step; this does the same.

1. Disconnect everything from the electrodes.
2. Press **Z**. It averages for 3 seconds.
3. "Zero saved" appears. The zero is kept in flash, so it survives power-off. If something was still connected, it says "Zero refused" and keeps the old one.

There is no gain step, so readings can still be off by the tolerance of the 47k resistor (about 1%).

## What to try

1. **Zero, then a known resistor.** 1 MΩ across the electrodes should now read close to 1,000 nS.
2. **Keyboard and GSR together.** With a resistor across the electrodes, type for a while. Noise and errors shouldn't change.
3. **Long run.** Press R, leave it for an hour, then check: errors 0, gap still small, boot count unchanged, keys still respond.
4. **GPS by a window or outdoors.** Note the first-fix time and the best signal. For the antenna test (doc section 6), compare the best signal and "used" count with the GPS facing up and facing down.
5. **GPS power.** If the boot line ever shows `BROWNOUT`, the GPS's current draw reset the Cardputer.

## If something is wrong

- **"ADC not found":** check SDA/SCL aren't swapped, the board has 3.3 V, and the grounds are joined.
- **"GPS no data … 0 B/s":** nothing is arriving. Check that G15 goes to the GPS **TX**.
- **"GPS no data" with bytes arriving:** the speed is wrong or the line is noisy. It switches between 9600 and 115200 every 3 seconds by itself.
- **Bias far from 500 mV:** the 3.3 V supply is off, or the bias resistors are wrong.

The log on the USB serial port is a CSV line every second, so you can save it and look at a long run afterwards.
