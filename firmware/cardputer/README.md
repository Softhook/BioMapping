# BioMapping on the Cardputer ADV

The BioMapping firmware for the M5Stack Cardputer ADV. Steps 1–11 of the port plan are complete (validation and side-by-side walks are next; see [docs/cardputer_port.md](../../docs/cardputer_port.md)). It boots into a colour main menu (`GPS + GSR`, `GSR Only`, `Live Stream`, `Wi-Fi Files`, `GSR Audio`, `Options`), includes the full **Options** menu and 4-step **GSR Calibration Wizard**, persists settings and calibration to `/sd/biomapping/` on the built-in SD card, streams live BLE packets to the visualiser's **Live** tab, and draws the live GSR graph and Diagnostics screens through the shared code in [`../core/`](../core/).

The shared code is built straight from `../core/` and `../vendor/minmea/`; nothing is copied into this folder. Our own code and `core/` are built with warnings treated as errors.

## Build and flash

From this folder:

```
pio run -t upload        # flash over USB-C
pio device monitor       # watch the log
```

If `pio` isn't found, use `~/.platformio/penv/bin/pio`. The Cardputer uses its chip's own USB serial port, so flashing resets it by itself; if it ever won't connect, hold the G0 button while plugging in USB.

## Testing on the device

[`tools/hw_test.py`](tools/hw_test.py) tests the Cardputer automatically over the USB cable. It restarts the Cardputer before each test, presses keys over the serial port and checks what it prints. With the GSR board fitted, from this folder:

```
~/.platformio/penv/bin/python tools/hw_test.py            # all automatic tests, about 8 minutes
~/.platformio/penv/bin/python tools/hw_test.py gsr_only   # one test (--list shows them all)
```

Add `-v` to see every line the Cardputer prints. The tests put back any settings they change (Auto-zoom, Debug Fields), and leave their short test recordings on the card. Don't run `pio device monitor` at the same time: only one program can use the port.

## Keys

The Flipper's six buttons are:

| Flipper | Cardputer |
|---|---|
| Up, Down, Left, Right | `;` `.` `,` `/` (the keys with arrows printed on them), with or without Fn |
| OK | Enter |
| Back | Esc (the `` ` `` key) or Del |

The same keys also work typed into a serial monitor on the computer (`pio device monitor`): `;` `.` `,` `/` for the arrows, Enter for OK, and Esc or `` ` `` for Back. One Enter is one OK, whichever line ending the monitor sends.

## Using it

At power-up, while the start-up animation plays, it wakes the GPS, reads the time from the GPS module's backup clock, and leaves the GPS running so it can start finding satellites. It then loads saved settings and calibration from the SD card and shows the **Bio Mapping** main menu.

The GPS keeps running on the menu and between GPS sessions, so going back into `GPS + GSR` doesn't have to find the satellites again. It is put to sleep when you open something that doesn't use it (`GSR Only`, `Diagnostics`, `GSR Calibration`, `Wi-Fi Files`, `GSR Audio`), and stays asleep until the next GPS session.

- **`GPS + GSR`** — sets up the GPS module (waking it first if it is asleep), opens the live GSR waveform screen, and records 11-column `GPS+GSR` CSV files.
- **`GSR Only`** — puts the GPS to sleep, opens the live GSR waveform screen, and records 2-column `GSR Only` CSV files.
- **`Live Stream`** — starts the GPS and GSR sensors and advertises over Bluetooth Low Energy (`Cardputer`) with the visualiser's Live service and notify characteristic UUIDs (52-byte MTU for 49-byte packets every 300 ms). Bluetooth is switched on only while Live Stream is open. Leaving with **Esc** disconnects any phone or browser and switches Bluetooth off completely.
- **`Wi-Fi Files`** — turns on a Wi-Fi hotspot (`BioMapping-XXXX`, open — no password) and starts a small web server at `http://192.168.4.1` for downloading or deleting `.csv` recordings (one by one or all at once as a streamed `.zip`) from a phone, tablet, or laptop. Shows a **Join Wi-Fi** QR code first and automatically switches to the **Open page** QR code as soon as a device connects (use Left / Right to switch manually). Wi-Fi is switched off completely when you press **Esc**, or by itself after 10 minutes with no device connected (the screen counts down, e.g. `Off in 9 min`).
- **`GSR Audio`** — puts the GPS to sleep (just like `GSR Only`) and opens a completely separate sound-listening mode (no recording, no Bluetooth, no Wi-Fi) that turns the wearer's skin signal into smooth 48 kHz sound through the built-in speaker or 3.5 mm headphones. Silent until fingers settle on the cuffs:
  - **Left / Right** (`,` / `/`), **Tab**, or the top **G0** button switches between five relaxing soundscapes: **`DRONE`** (warm chordal hum), **`BREATH`** (slow ~6-breaths/min ocean surf and chord tide), **`CHORD`** (steady ambient chord whose upper harmonic layers gently open and close without sliding pitch), **`BOWLS`** (soft felt-mallet singing bowls on steady warm notes), and **`RAIN`** (gentle warm rainfall over a distant pad).
  - **Up / Down** (`;` / `.`, or `[` / `]`) adjusts how strongly the sound responds to GSR changes (`10%`–`150%` in `10%` steps, default `100%`).
  - **`-` / `+`** (`-` and `=`) turns volume down or up in `10%` logarithmic steps (`0%`–`100%`, `6 dB` per step down to a whisper-quiet `-54 dB` at `10%`).
  - **Enter** mutes or unmutes; **Esc** fades out cleanly, stops the sound task and sensor, frees all audio memory, and returns to the main menu (leaving the GPS asleep, as after `GSR Only`).
- **`Options`** — configures and saves:
  - **GPS Profile** (`PED`, `WRIST`, `VEHICLE`, `STATION`, `SEA`, `BIKE`, `FLIGHT`)
  - **Super-S** (`AUTO` / `OFF`)
  - **Cold Reset GPS** (sends the M10Q a cold-start reset to clear its backup RAM, then puts it to sleep so it can't relearn anything before the next GPS session)
  - **Auto-zoom GSR** (`ON` / `OFF`)
  - **GSR Calibration** (`YES >` / `NO >`) → `Start Wizard`, `Reset to Default`, `Show Current`
  - **Backlight** (`ON` / `DIM`)
  - **Sound** (`ON` / `OFF`)
  - **Diagnostics** (opens the live raw/filtered GSR, PGA, worker Hz, and bias voltage screen)
  - **Debug Fields** (`ON` / `OFF`)

Inside a session:

- **Enter** starts a recording, and stops it. Files go in `biomapping/` on the card, with the same columns and check lines as the Flipper's. Record on battery: unplug the USB cable before the electrodes go on someone (see [Electrode Safety](../../README.md#electrode-safety)).
- **Up / Down** (`;` / `.`) zoom the GSR graph vertically; **Left / Right** (`,` / `/`) change the time span.
- **Esc** (or Del) stops any active recording and returns to the main menu. The GPS stays as it was: running after a GPS session, asleep after `GSR Only`.
- Any other key is counted (`keys` in the USB log), for the typing test.

**The clock.** The Cardputer has no clock chip of its own, so it gets the time from the GPS module. The module keeps time on its backup battery for about 1.5–2 days with the Cardputer off. At power-up the Cardputer reads that clock, so the menu and `GSR Only` have the right date and time straight away, even indoors. If the backup battery has run down, the time comes from the GPS once it hears its first satellite, which is usually well before a position fix. Times are UK time (GMT in winter, BST in summer, switching automatically), and the clock is set again whenever it is 2 s or more out from GPS time. In GPS+GSR mode, Enter won't start a recording before the time is known: it gives the error sound and shows a `Waiting for GPS time...` banner. GSR Only records anyway; with no time yet, the name says `nodate` instead of a date and the header's start time is 0.

**File names.** Every recording gets the next recording number, then its start date and time: `biomap_0042_2026-11-21_14-32-05.csv`, or `biomap_0043_nodate.csv` with no GPS time. The number goes up by one for every recording and is kept in the Cardputer's own memory, so it carries on after the card is emptied. That is how the Wi-Fi Files page always lists the newest recording first, dated or not. Files from before the numbers are listed below all numbered ones. A name already on the card gets "_2", "_3" and so on, so nothing is overwritten.

## Getting the files off

The SD card stays inside the Cardputer. To get the files onto a computer, phone or tablet, choose **Wi-Fi Files** on the main menu:

- Scan the first QR code to join the `BioMapping-XXXX` Wi-Fi network. To join by hand instead, pick `BioMapping-XXXX` in your Wi-Fi list; there is no password.
- Once connected, most phones and laptops pop up the file page by themselves, like a café Wi-Fi sign-in page. You can see and delete files there.
- A Mac's or iPhone's pop-up can't save files: press **Open in browser to download** and the page opens in your normal browser. If it doesn't, click **Done** (you stay on the Cardputer's Wi-Fi) and type `192.168.4.1` into your browser.
- The screen also switches to a second QR code for `http://192.168.4.1` (you can also switch between the two QR codes with Left / Right).
- Open that address in your browser (Chrome, Safari or any other) to download individual `.csv` files, tap **Download All as ZIP** for a single archive of every recording, or delete old files. (With more than 256 recordings the page lists only the newest 256, but the ZIP still has all of them.)
- To choose where downloads are saved, turn on **Ask where to save each file before downloading** in Chrome's settings (under Downloads). Chrome then opens the folder you used last time.
- On a Mac or Linux computer, `python3 scripts/workshop_collect.py --web` opens a page with a **Choose folder** button that copies every new recording straight into that folder. It joins the Cardputer's Wi-Fi by itself, skips recordings already in the folder, checks each file's checksum, and then switches the computer back to its usual Wi-Fi. It remembers the folder and Wi-Fi name for next time. Without `--web`, the same script does this in the terminal (`-o` sets the folder).
- Press **Esc** when done to stop the server and turn Wi-Fi completely off before recording. If you forget, it turns itself off after 10 minutes with no device connected.

## Files

| File | What it does |
|---|---|
| `src/main.cpp` | Start-up, the main loop, and the once-a-second USB log |
| `src/splash_cardputer.cpp` | Animated start-up screen (space -> 3D Earth -> London -> body -> Bio Mapping 2 logo & title) with bell melody, running while the GPS starts and its backup clock is read |
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
| `src/gps_cardputer.cpp` | The serial port to the M10Q, held from start-up to power-off; start-up and backup-clock read, sleep for non-GPS modes, the wake-up check, and Cold Reset GPS |
| `src/clock_cardputer.cpp` | The clock, set from the GPS module's backup clock at start-up and from GPS time after that, in UK time |
| `src/clock_local.c` | UK local time and keeping the start's UTC offset across a recording (plain C, host-tested) |
| `src/clock_rule.c` | When the clock is set from GPS time (plain C, host-tested) |
| `src/tick_schedule.c` | The 10 Hz tick schedule, catch-up after a stall, and GPS byte slicing (plain C, host-tested) |
| `src/wake_watch.c` | The wake-up wait's "first clean byte" check (plain C, host-tested) |
| `src/sd_cardputer.cpp` | The SD card, written in whole 512-byte blocks from a task of its own (so a slow card never holds up the GSR) |
| `src/write_queue.c` | The queue of bytes waiting for the card (plain C, host-tested) |
| `src/cues_cardputer.cpp` | The Flipper's sounds |
| `src/gsr_audio.c` | Standalone 48 kHz GSR audification: footstep filter, baseline centering, sensitivity scaling, and the `DRONE`, `BREATH`, `CHORD`, `BOWLS`, and `RAIN` soundscapes (plain C, host-tested) |
| `src/gsr_audio_cardputer.cpp` | Standalone `GSR Audio` screen, dedicated Core 0 48 kHz speaker driver, sensitivity (`10%`–`150%`) and logarithmic `10%` volume controls |
| `src/keys.cpp` | The Cardputer's keys as the Flipper's six buttons, plus the TCA8418 keyboard unstick check |
| `src/core_fatal.cpp` | What happens when the shared code stops on a broken rule |
| `tools/hw_test.py` | Automated tests on the real Cardputer over USB (see "Testing on the device") |
