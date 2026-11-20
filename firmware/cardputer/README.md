# BioMapping on the Cardputer ADV

The BioMapping firmware for the M5Stack Cardputer ADV. It is being built up step by step (see section 7 of [docs/cardputer_port.md](../../docs/cardputer_port.md)). So far it records GSR to the SD card in GSR Only mode, through the shared code in [`../core/`](../core/). There is no GPS, calibration or menu yet, and the screen is a plain status page.

The shared code is built straight from `../core/` and `../vendor/minmea/`; nothing is copied into this folder. Our own code and `core/` are built with warnings treated as errors.

## Build and flash

From this folder:

```
pio run -t upload        # flash over USB-C
pio device monitor       # watch the log
```

If `pio` isn't found, use `~/.platformio/penv/bin/pio`. If flashing fails, hold the Cardputer's G0 button while plugging in USB, then try again.

## Keys

The Flipper's six buttons are:

| Flipper | Cardputer |
|---|---|
| Up, Down, Left, Right | `;` `.` `,` `/` (the keys with arrows printed on them), with or without Fn |
| OK | Enter |
| Back | Esc (the `` ` `` key) or Del |

## Using it

It starts in GSR Only mode. Put a microSD card in first.

- **Enter** starts a recording, and stops it. Files go in `biomapping/` on the card, with the same columns and check lines as the Flipper's.
- **Esc** (or Del) ends the session; Enter then starts a new one.
- Any other key is only counted ("keys" on the screen), for the typing test.

Until GPS time arrives (step 9) the Cardputer doesn't know the date, so file names count from `biomap_1970-01-01_00-00-00.csv` after each power-up, and the header's start time is 0. A name already on the card gets "_2", "_3" and so on, so nothing is overwritten. There is no calibration yet either, so readings carry the board's zero offset (about 100 nS low on the prototype).

## Getting the files off

The card is built in, so the recordings are read over the USB link. With the Cardputer plugged in and not recording, send a line over its serial port (115200 baud):

- `ls` lists `biomapping/` with each file's size.
- `cat NAME` sends one file: a `BEGIN NAME SIZE` line, the file's bytes, then `END`.

## What the screen shows

| Line | What it means |
|---|---|
| GSR Only, ready / REC 00:01:23 | The mode, and whether it is recording (orange while an SD write is being retried; "REC STOPPED" if the card failed for good) |
| The reading | Skin conductance in nS, "Cuffs off" with nothing connected, or "No GSR sensor" if the ADC didn't answer |
| File name | The recording's file (without "biomap_"), or "SD card ready" / "No SD card" |
| SD max, buf, fails | The slowest SD write so far, the bytes waiting to be written, and failed writes |
| GSR …/s, dup, ok, i2c | GSR reads a second, the share that repeated the last reading, the share that worked, and the slowest I2C call |
| keys | Every key press |

The same figures go to the USB log once a second (`pio device monitor`).

If the shared code ever stops on a broken rule, the screen turns red and shows the message, as the Flipper's crash screen does. Restart the Cardputer.

## Files

| File | What it does |
|---|---|
| `src/main.cpp` | Start-up, the main loop and the status screen |
| `src/session_cardputer.cpp` | The device functions for the shared session, and its 10 Hz tick |
| `src/gsr_cardputer.cpp` | The GSR thread, reading the ADS1115 through M5's I2C driver |
| `src/sd_cardputer.cpp` | The SD card, written in whole 512-byte blocks |
| `src/cues_cardputer.cpp` | The Flipper's sounds |
| `src/serial_files.cpp` | The `ls` and `cat` commands for reading recordings over USB |
| `src/keys.cpp` | The Cardputer's keys as the Flipper's six buttons |
| `src/core_fatal.cpp` | What happens when the shared code stops on a broken rule |
