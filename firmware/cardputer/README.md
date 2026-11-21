# BioMapping on the Cardputer ADV

The BioMapping firmware for the M5Stack Cardputer ADV. It is being built up step by step (see section 7 of [docs/cardputer_port.md](../../docs/cardputer_port.md)). It boots into a colour main menu (`GPS + GSR`, `GSR Only`, `Live Stream`, `Options`), includes the full **Options** menu and 4-step **GSR Calibration Wizard**, persists settings and calibration to `/sd/biomapping/` on the built-in SD card, streams live BLE packets to the visualiser's **Live** tab, and draws the live GSR graph and Diagnostics screens through the shared code in [`../core/`](../core/).

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

The same keys also work typed into a serial monitor on the computer (`pio device monitor`): `;` `.` `,` `/` for the arrows, Enter for OK, and Esc or `` ` `` for Back. One Enter is one OK, whichever line ending the monitor sends.

## Using it

At power-up it puts the GPS to sleep (up to about 2 s), loads saved settings and calibration from the SD card, and shows the **Bio Mapping** main menu:

- **`GPS + GSR`** — wakes and configures the GPS module, opens the live GSR waveform screen, and records 11-column `GPS+GSR` CSV files.
- **`GSR Only`** — opens the live GSR waveform screen with the GPS left asleep, and records 2-column `GSR Only` CSV files.
- **`Live Stream`** — wakes the GPS and GSR sensors and advertises over Bluetooth Low Energy (`Cardputer`) with the visualiser's Live service and notify characteristic UUIDs (52-byte MTU for 49-byte packets every 300 ms). Bluetooth is switched on only while Live Stream is open. Leaving with **Esc** disconnects any phone or browser and switches Bluetooth off completely.
- **`Options`** — configures and saves:
  - **GPS Profile** (`PED`, `WRIST`, `VEHICLE`, `STATION`, `SEA`, `BIKE`, `FLIGHT`)
  - **Super-S** (`AUTO` / `OFF`)
  - **Cold Reset GPS** (wakes the M10Q, sends a cold-start reset to clear backup RAM, and puts it back to sleep)
  - **Auto-zoom GSR** (`ON` / `OFF`)
  - **GSR Calibration** (`YES >` / `NO >`) → `Start Wizard`, `Reset to Default`, `Show Current`
  - **Backlight** (`ON` / `DIM`)
  - **Sound** (`ON` / `OFF`)
  - **Diagnostics** (opens the live raw/filtered GSR, PGA, worker Hz, and bias voltage screen)
  - **Debug Fields** (`ON` / `OFF`)

Inside a session:

- **Enter** starts a recording, and stops it. Files go in `biomapping/` on the card, with the same columns and check lines as the Flipper's.
- **Up / Down** (`;` / `.`) zoom the GSR graph vertically; **Left / Right** (`,` / `/`) change the time span.
- **Esc** (or Del) stops any active recording and returns to the main menu (putting the GPS back to sleep).
- Any other key is counted (`keys` in the USB log), for the typing test.

On the main menu or in Options:

- **U** lends the SD card to a plugged-in computer as a USB thumb drive; eject the drive on the computer to take the card back. (**U** twice also takes it back, but can lose changes the computer hasn't saved yet.)

**The clock.** The Cardputer has no clock chip, so it doesn't know the time after power-up until the GPS has a fix. It then sets its clock from GPS time, in UK time (GMT in winter, BST in summer, switching automatically). In GPS+GSR mode, Enter won't start a recording before that: it gives the error sound and shows a `Waiting for GPS time...` banner. GSR Only records anyway, using GPS time if it was found since power-up; otherwise the file is named from `biomap_1970-01-01_00-00-00.csv` and the header's start time is 0. A name already on the card gets "_2", "_3" and so on, so nothing is overwritten.

## Getting the files off

The SD card stays inside the Cardputer, so press **U** on the main menu (or in Options) while plugged into a computer over USB-C. If the card can't be lent, the screen says why for 3 seconds: `Plug USB into a computer`, `No SD card to lend` or `Stop recording first`.

- The SD card mounts on the computer as a normal USB thumb drive, with all your `.csv` files (plus `biomap.settings` and `biomap.cal`) inside the `biomapping/` folder.
- Drag the `.csv` files directly into the visualiser or onto your computer.
- When you are done, **Eject** the drive on the computer. The Cardputer takes the card back, remounts it, and reloads settings and calibration so it sees any changes.
- Only if ejecting isn't possible, press **U** twice within 3 seconds. The first press shows `Eject on computer first!` as a warning; the second takes the card back. Doing this while the computer still has the drive open can lose changes it hasn't written yet, or damage the card's file list.
- While the computer has the card, the main menu shows `USB drive mounted on computer` and **Enter** will not start a new recording until the drive is ejected (or **U** is pressed twice).

For getting files onto a phone or tablet without a cable (the planned **Wi-Fi Files** screen, or running `PocketWUI` alongside BioMapping through M5Launcher), see section 4 of [docs/cardputer_port.md](../../docs/cardputer_port.md).

## Files

| File | What it does |
|---|---|
| `src/main.cpp` | Start-up, the main loop, USB thumb drive key handling, and the once-a-second USB log |
| `src/menu_cardputer.cpp` | The colour main menu, Options screen, and non-blocking 4-step GSR Calibration wizard |
| `src/screen_cardputer.cpp` | The shared recording screen (`core/biomap_screen.c`) stretched to 240 × 135 with colour accents |
| `src/bt_cardputer.cpp` | Bluetooth Low Energy Live Stream server and 49-byte packet notifications for the visualiser's Live tab |
| `src/settings_cardputer.cpp` | Loading and atomic saving of `biomap.settings` and `biomap.cal` in `/sd/biomapping/` |
| `src/session_cardputer.cpp` | The device functions for the shared session, and its 10 Hz tick |
| `src/gsr_cardputer.cpp` | The GSR thread, reading the ADS1115 through M5's I2C driver |
| `src/gps_cardputer.cpp` | The serial port to the M10Q, held from start-up to power-off, the wake-up check, and Cold Reset GPS |
| `src/clock_cardputer.cpp` | The clock, set from GPS time, in UK time |
| `src/clock_local.c` | UK local time and keeping the start's UTC offset across a recording (plain C, host-tested) |
| `src/clock_rule.c` | When the clock is set from GPS time (plain C, host-tested) |
| `src/tick_schedule.c` | The 10 Hz tick schedule, catch-up after a stall, and GPS byte slicing (plain C, host-tested) |
| `src/wake_watch.c` | The wake-up wait's "first clean byte" check (plain C, host-tested) |
| `src/sd_cardputer.cpp` | The SD card, written in whole 512-byte blocks, plus the **U** key's USB thumb drive mode |
| `src/cues_cardputer.cpp` | The Flipper's sounds |
| `src/keys.cpp` | The Cardputer's keys as the Flipper's six buttons, plus the TCA8418 keyboard unstick check |
| `src/core_fatal.cpp` | What happens when the shared code stops on a broken rule |
