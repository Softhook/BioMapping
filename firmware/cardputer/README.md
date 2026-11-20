# BioMapping on the Cardputer ADV

The BioMapping firmware for the M5Stack Cardputer ADV. It is being built up step by step (see section 7 of [docs/cardputer_port.md](../../docs/cardputer_port.md)). So far it builds the shared code in [`../core/`](../core/), shows a start screen and reads the keys. It does not record yet.

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

## What the start screen shows

- **Core:** a file name stamp made by the shared code (`2026-11-20_14-32-05`), to show the shared code runs.
- **Key:** the last of the six buttons pressed, and the key used.
- **buttons / other keys:** how many presses of the six buttons, and of any other key.

If the shared code ever stops on a broken rule, the screen turns red and shows the message, as the Flipper's crash screen does. Restart the Cardputer.

## Files

| File | What it does |
|---|---|
| `src/main.cpp` | Start-up, the main loop and the start screen |
| `src/keys.cpp` | The Cardputer's keys as the Flipper's six buttons |
| `src/core_fatal.cpp` | What happens when the shared code stops on a broken rule |
