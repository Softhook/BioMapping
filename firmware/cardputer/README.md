# BioMapping on the Cardputer ADV

The BioMapping firmware for the M5Stack Cardputer ADV. It is being built up step by step (see section 7 of [docs/cardputer_port.md](../../docs/cardputer_port.md)). So far it records GPS+GSR or GSR Only to the SD card, through the shared code in [`../core/`](../core/), with the clock set from GPS time. There is no calibration or menu yet, and the screen is a plain status page.

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

It starts a GPS+GSR session at power-up. At start-up it first puts the GPS to sleep (up to about 2 s), and wakes it again when a GPS+GSR session starts.

- **Enter** starts a recording, and stops it. Files go in `biomapping/` on the card, with the same columns and check lines as the Flipper's.
- **Esc** (or Del) ends the session (the GPS goes back to sleep).
- With no session open, **Tab** switches between GPS+GSR and GSR Only, and **Enter** starts a session in that mode.
- **U** (when not recording) lends the SD card to a plugged-in computer as a USB thumb drive; press **U** again (or eject the drive on the computer) to take the card back.
- Any other key is only counted ("keys" on the screen), for the typing test.

**The clock.** The Cardputer has no clock chip, so it doesn't know the time after power-up until the GPS has a fix. It then sets its clock from GPS time, in UK time (GMT in winter, BST in summer, switching automatically). In GPS+GSR mode, Enter won't start a recording before that: it gives the error sound and shows "Waiting for GPS time". GSR Only records anyway, using GPS time if it was found since power-up; otherwise the file is named from `biomap_1970-01-01_00-00-00.csv` and the header's start time is 0. A name already on the card gets "_2", "_3" and so on, so nothing is overwritten.

There is no calibration yet, so readings carry the board's zero offset (about 100 nS low on the prototype).

## Getting the files off

The SD card stays inside the Cardputer, so press **U** (when not recording) while plugged into a computer over USB-C:

- The SD card mounts on the computer as a normal USB thumb drive, with all your `.csv` files inside the `biomapping/` folder.
- Drag the files directly into the visualiser or onto your computer.
- When you are done, **Eject** the drive on the computer (or press **U** on the Cardputer). The Cardputer takes the card back and remounts it so it sees any files you deleted or moved.
- While the computer has the card, the screen says `USB drive on computer` and **Enter** will not start a new recording until the drive is ejected or **U** is pressed.

For getting files onto a phone or tablet without a cable (the planned **Wi-Fi Files** screen, or running `PocketWUI` alongside BioMapping through M5Launcher), see section 4 of [docs/cardputer_port.md](../../docs/cardputer_port.md).

## What the screen shows

| Line | What it means |
|---|---|
| GPS+GSR, ready / no GPS time / REC 00:01:23 | The mode, and whether it is recording (orange while an SD write is being retried; "REC STOPPED" if the card failed for good). "no GPS time": a recording can't start yet |
| The reading | Skin conductance in nS, "Cuffs off" with nothing connected, or "No GSR sensor" if the ADC didn't answer |
| File name | The recording's file (without "biomap_"), "USB drive on computer" while lent over USB, or "SD card ready" / "No SD card" |
| GPS 3D, sats, hAcc | The fix, satellites in use and the module's accuracy estimate; "GPS no fix", "GPS asleep" (between sessions) or "GPS off" (GSR Only) |
| 23:03:05, position | UK time from the GPS ("--:--:--" until then), and latitude and longitude once there is a fix |
| SD, buf, fail, keys | The slowest SD write so far, the bytes waiting to be written, failed writes, and every key press |
| GSR …/s, dup, ok, i2c | GSR reads a second, the share that repeated the last reading, the share that worked, and the slowest I2C call |

The same figures go to the USB log once a second (`pio device monitor`).

If the shared code ever stops on a broken rule, the screen turns red and shows the message, as the Flipper's crash screen does. Restart the Cardputer.

## Files

| File | What it does |
|---|---|
| `src/main.cpp` | Start-up, the main loop and the status screen |
| `src/session_cardputer.cpp` | The device functions for the shared session, and its 10 Hz tick |
| `src/gsr_cardputer.cpp` | The GSR thread, reading the ADS1115 through M5's I2C driver |
| `src/gps_cardputer.cpp` | The serial port to the M10Q, held from start-up to power-off, and the wake-up check |
| `src/clock_cardputer.cpp` | The clock, set from GPS time, in UK time |
| `src/clock_rule.c` | When the clock is set from GPS time (plain C, tested on the computer) |
| `src/wake_watch.c` | The wake-up wait's "first clean byte" check (plain C, tested on the computer) |
| `src/sd_cardputer.cpp` | The SD card, written in whole 512-byte blocks, plus the **U** key's USB thumb drive mode |
| `src/cues_cardputer.cpp` | The Flipper's sounds |
| `src/keys.cpp` | The Cardputer's keys as the Flipper's six buttons |
| `src/core_fatal.cpp` | What happens when the shared code stops on a broken rule |
