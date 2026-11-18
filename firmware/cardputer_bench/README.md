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

If flashing fails, hold the Cardputer's G0 button while plugging in USB, then try again.

## What the screen shows

| Line | Good result |
|---|---|
| I2C | Lists `48` (ADS1115) and `34` (keyboard), plus the Cardputer's own chips |
| GSR | `open circuit` with nothing connected; a value in nS with a finger or resistor across the electrodes |
| reads/s, I2C errors | Several hundred reads a second; errors stay at 0 |
| Bias | About 500 mV. The supply figure next to it is worked out from this and should be about 3.30 V |
| GPS | Green, with good messages each second and few or no bad ones. Satellites appear after a minute or so outdoors or by a window |
| Keys | The count goes up and the last key changes every time you press one |

Keys: **S** scans the I2C bus again, **R** resets the counters.

## What to try

1. **Keyboard and GSR together.** Type while a finger is on the electrodes. The GSR value should stay steady and I2C errors should stay at 0.
2. **Long run.** Leave it for an hour, then press a few keys. They should still register.
3. **Known resistors.** A resistor across the electrodes should read roughly 1/R (for example, 1 MΩ ≈ 1,000 nS). This is a sanity check, not an accuracy test.
4. **GPS power.** Watch for the Cardputer restarting while the GPS searches for satellites.

## If something is wrong

- **ADS1115 not found:** check SDA/SCL aren't swapped, the board has 3.3 V, and the grounds are joined.
- **GPS "trying… 0 bytes/s":** nothing is arriving. Check that G15 goes to the GPS **TX**.
- **GPS "trying…" with bytes arriving but never going green:** the speed is wrong or the line is noisy. It switches between 9600 and 115200 every 3 seconds by itself.
- **Bias far from 500 mV:** the 3.3 V supply is off, or the bias resistors are wrong.

The log on the USB serial port is a CSV line every second, so you can save it and look at a long run afterwards.
