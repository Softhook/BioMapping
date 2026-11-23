# BioMapping on the Cardputer ADV

The BioMapping firmware for the M5Stack Cardputer ADV. Steps 1–11 of the port plan are complete (validation and side-by-side walks are next; see [docs/cardputer_port.md](../../docs/cardputer_port.md)). It boots into a colour main menu (`GPS + GSR`, `GSR Only`, `Live Stream`, `Options`), includes the full **Options** menu and 4-step **GSR Calibration Wizard**, persists settings and calibration to `/sd/biomapping/` on the built-in SD card, streams live BLE packets to the visualiser's **Live** tab, and draws the live GSR graph and Diagnostics screens through the shared code in [`../core/`](../core/).

The shared code is built straight from `../core/` and `../vendor/minmea/`; nothing is copied into this folder. Our own code and `core/` are built with warnings treated as errors.

## Build and flash

From this folder:

```
pio run -t upload        # flash over USB-C
pio device monitor       # watch the log
```

If `pio` isn't found, use `~/.platformio/penv/bin/pio`. If flashing fails with `No serial data received`, the running app hasn't let the computer reset it. Either hold the Cardputer's G0 button while plugging in USB, or put it in its bootloader from the computer (a 1200-baud "touch": open the port at 1200 baud and close it; a new `/dev/cu.usbmodem…` port appears), then flash to that port with `pio run -t upload --upload-port <new port>`.

## Testing on the device

[`tools/hw_test.py`](tools/hw_test.py) tests the Cardputer automatically over the USB cable. It restarts the Cardputer before each test, presses keys over the serial port and checks what it prints. With the GSR board fitted, from this folder:

```
~/.platformio/penv/bin/python tools/hw_test.py            # all automatic tests, about 8 minutes
~/.platformio/penv/bin/python tools/hw_test.py gsr_only   # one test (--list shows them all)
~/.platformio/penv/bin/python tools/hw_test.py csv_check  # check the last 60 s recording on the card
```

Add `-v` to see every line the Cardputer prints. `csv_check` (or `--usb` with the others) needs one press of **U** on the Cardputer, because only its own keyboard can lend the card: press U on the main menu, either before running it or when it asks. It checks the file's checksum, row count and timing, then ejects the card so the Cardputer takes it back. The tests put back any settings they change (Auto-zoom, Debug Fields), and leave their short test recordings on the card. Don't run `pio device monitor` at the same time: only one program can use the port.

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
- **`Wi-Fi Files`** — turns on a Wi-Fi hotspot (`BioMapping-XXXX`, open — no password) and starts a small web server at `http://192.168.4.1` for downloading or deleting `.csv` recordings (one by one or all at once as a streamed `.zip`) from a phone, tablet, or laptop. Shows a **Join Wi-Fi** QR code first and automatically switches to the **Open page** QR code as soon as a device connects (use Left / Right to switch manually). Wi-Fi is switched off completely when you press **Esc**, or by itself after 10 minutes with no device connected (the screen counts down, e.g. `Off in 9 min`).
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

- **Enter** starts a recording, and stops it. Files go in `biomapping/` on the card, with the same columns and check lines as the Flipper's. Record on battery: unplug the USB cable before the electrodes go on someone (see [Electrode Safety](../../README.md#electrode-safety)).
- **Up / Down** (`;` / `.`) zoom the GSR graph vertically; **Left / Right** (`,` / `/`) change the time span.
- **Esc** (or Del) stops any active recording and returns to the main menu (putting the GPS back to sleep).
- Any other key is counted (`keys` in the USB log), for the typing test.

On the main menu or in Options:

- **U** lends the SD card to a plugged-in computer as a USB thumb drive; eject the drive on the computer to take the card back. (**U** twice also takes it back, but can lose changes the computer hasn't saved yet.)

**The clock.** The Cardputer has no clock chip, so it doesn't know the time after power-up until the GPS has a fix. It then sets its clock from GPS time, in UK time (GMT in winter, BST in summer, switching automatically). In GPS+GSR mode, Enter won't start a recording before that: it gives the error sound and shows a `Waiting for GPS time...` banner. GSR Only records anyway, using GPS time if it was found since power-up; otherwise the name says `nodate` instead of a date and the header's start time is 0.

**File names.** Every recording gets the next recording number, then its start date and time: `biomap_0042_2026-11-21_14-32-05.csv`, or `biomap_0043_nodate.csv` with no GPS time. The number goes up by one for every recording and is kept in the Cardputer's own memory, so it carries on after the card is emptied. That is how the Wi-Fi Files page always lists the newest recording first, dated or not. Files from before the numbers are listed below all numbered ones. A name already on the card gets "_2", "_3" and so on, so nothing is overwritten.

## Getting the files off

The SD card stays inside the Cardputer, so press **U** on the main menu (or in Options) while plugged into a computer over USB-C. If the card can't be lent, the screen says why for 3 seconds: `Plug USB into a computer`, `No SD card to lend` or `Stop recording first`.

- The SD card mounts on the computer as a normal USB thumb drive, with all your `.csv` files (plus `biomap.settings` and `biomap.cal`) inside the `biomapping/` folder.
- Drag the `.csv` files directly into the visualiser or onto your computer.
- When you are done, **Eject** the drive on the computer. The Cardputer takes the card back, remounts it, and reloads settings and calibration so it sees any changes.
- Only if ejecting isn't possible, press **U** twice within 3 seconds. The first press shows `Eject on computer first!` as a warning; the second takes the card back. Doing this while the computer still has the drive open can lose changes it hasn't written yet, or damage the card's file list.
- While the computer has the card, the main menu shows `USB drive mounted on computer` and **Enter** will not start a new recording until the drive is ejected (or **U** is pressed twice).

To get files onto a phone, tablet, or laptop without a cable, choose **Wi-Fi Files** on the main menu:

- Scan the first QR code to join the `BioMapping-XXXX` Wi-Fi network. To join by hand instead, pick `BioMapping-XXXX` in your Wi-Fi list; there is no password.
- Once connected, most phones and laptops pop up the file page by themselves, like a café Wi-Fi sign-in page. You can see and delete files there.
- A Mac's or iPhone's pop-up can't save files: press **Open in browser to download** and the page opens in your normal browser. If it doesn't, click **Done** (you stay on the Cardputer's Wi-Fi) and type `192.168.4.1` into your browser.
- The screen also switches to a second QR code for `http://192.168.4.1` (you can also switch between the two QR codes with Left / Right).
- Open that address in your browser (Chrome, Safari or any other) to download individual `.csv` files, tap **Download All as ZIP** for a single archive of every recording, or delete old files. (With more than 256 recordings the page lists only the newest 256, but the ZIP still has all of them.)
- To choose where downloads are saved, turn on **Ask where to save each file before downloading** in Chrome's settings (under Downloads). Chrome then opens the folder you used last time.
- Press **Esc** when done to stop the server and turn Wi-Fi completely off before recording. If you forget, it turns itself off after 10 minutes with no device connected.

## Files

| File | What it does |
|---|---|
| `src/main.cpp` | Start-up, the main loop, USB thumb drive key handling, and the once-a-second USB log |
| `src/splash_cardputer.cpp` | Animated start-up screen (space -> 3D Earth -> London -> body -> Bio Mapping 2 logo & title) with bell melody, running while the GPS goes to sleep |
| `src/splash_anim.c` | Easing curves, timeline, 3D globe projection, simplified continents, favicon waveform path, and startup bell melody generator (plain C, host-tested) |
| `src/menu_cardputer.cpp` | The colour main menu, Options screen, and non-blocking 4-step GSR Calibration wizard |
| `src/screen_cardputer.cpp` | The shared recording screen (`core/biomap_screen.c`) stretched to 240 × 135 with colour accents and a native 30 FPS smooth GSR spline graph |
| `src/bt_cardputer.cpp` | Bluetooth Low Energy Live Stream server and 49-byte packet notifications for the visualiser's Live tab |
| `src/wifi_files_cardputer.cpp` | Open Wi-Fi hotspot (no password), web server, QR code screen, and single/ZIP CSV downloads |
| `src/recording_number.cpp` | The recording number at the front of every file name (kept in the Cardputer's flash) |
| `src/wifi_files_rules.c` | CSV filename checks, newest-first name order, hotspot name/QR formatting, JSON escaping, DOS timestamps, and the Apple sign-in pop-up rules (plain C, host-tested) |
| `src/zip_stream.c` | Single-pass uncompressed ZIP streamer with exact upfront size and CRC-32 (plain C, host-tested) |
| `src/settings_cardputer.cpp` | Loading and atomic saving of `biomap.settings` and `biomap.cal` in `/sd/biomapping/` |
| `src/session_cardputer.cpp` | The device functions for the shared session, and its 10 Hz tick |
| `src/gsr_cardputer.cpp` | The GSR thread, reading the ADS1115 through M5's I2C driver |
| `src/gps_cardputer.cpp` | The serial port to the M10Q, held from start-up to power-off, the wake-up check, and Cold Reset GPS |
| `src/clock_cardputer.cpp` | The clock, set from GPS time, in UK time |
| `src/clock_local.c` | UK local time and keeping the start's UTC offset across a recording (plain C, host-tested) |
| `src/clock_rule.c` | When the clock is set from GPS time (plain C, host-tested) |
| `src/tick_schedule.c` | The 10 Hz tick schedule, catch-up after a stall, and GPS byte slicing (plain C, host-tested) |
| `src/wake_watch.c` | The wake-up wait's "first clean byte" check (plain C, host-tested) |
| `src/sd_cardputer.cpp` | The SD card, written in whole 512-byte blocks from a task of its own (so a slow card never holds up the GSR), plus the **U** key's USB thumb drive mode |
| `src/write_queue.c` | The queue of bytes waiting for the card (plain C, host-tested) |
| `src/cues_cardputer.cpp` | The Flipper's sounds |
| `src/keys.cpp` | The Cardputer's keys as the Flipper's six buttons, plus the TCA8418 keyboard unstick check |
| `src/core_fatal.cpp` | What happens when the shared code stops on a broken rule |
| `tools/hw_test.py` | Automated tests on the real Cardputer over USB (see "Testing on the device") |
