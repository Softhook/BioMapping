# GPS sleep investigation — 2026-09-25

Goal: when the app isn't using the SAM-M10Q GPS (menu, GSR-only), put it to
sleep to save its ~12–15 mA. Result: **not reliably achieved in software.**
This note records what was observed, so the next attempt starts from facts.

## Starting point (committed, 5aa9a21)

- Sleep command (UBX-RXM-PMREQ) corrected to the M10 spec: force flag +
  wake-on-UART-RX. Before that it never slept at all.
- Sent at the end of every GPS session (at 115200), and on entering
  GSR-only (wake the module, wait for its first byte, send at 9600).

## Observations on hardware

Evidence quality matters here — several early conclusions were wrong because
the measure was ambiguous.

**Reliable measures**
- Byte counting while the app still holds the serial port (temporary
  diagnostic).
- The module's boot banner (`$GNTXT … u-blox AG`) on wake: present = it was
  asleep and restarted; absent = it was already running.

**Unreliable measures (don't reuse)**
- Wake-up time alone. An awake module at 9600 answers anywhere in 0–600 ms,
  the same range as a restart.
- The board's PPS/fix LED. It stayed solid during a wake/restart loop, and it
  is also off when the module is awake without a fix.

**What the reliable measures showed**

| # | Observation | Confidence |
|---|---|---|
| 1 | Sleep sent mid-session at 115200 **is obeyed**: 0 bytes for 5 s afterwards, port held (2 of 2) | High |
| 2 | Some time after the port is released (≥5 s, before ~20 s), the module is awake again (2 of 2) | High |
| 3 | Sleep sent at 9600 to a freshly restarted module: module still talking 1.2 s later, 9 of 9 attempts (with a wait for a gap in its output first) | High |
| 4 | One success at 9600: reset → wake → sleep sent during the boot banner → still asleep 7 s later (1 of 2 tries) | Low (n=1) |
| 5 | Flipper's Expansion service fights the GPS for the pins: with Settings → Expansion Modules → Listen UART = USART, it retries a "connection" every ~3 ms while the GPS talks | High |
| 6 | `furi_hal_serial_deinit()` leaves the TX pin floating (analog, no pull), confirmed in the Flipper firmware source | High |
| 7 | "ViewPort lockup" warnings appear occasionally while the app blocks on GPS wake/sleep | Observed, not investigated |

**Not explained:** what wakes the module after #1, and why #3 fails.

## Changes tried today (all uncommitted)

| Change | Outcome |
|---|---|
| Pull-up on TX pin after release (for #6) | Sound in theory; its apparent success rested on the unreliable wake-time measure. Unproven. |
| Boot-banner detection in the wake log | Works; it is the reliable measure above. |
| Reset module to factory settings at session end, then sleep the GSR-only way | Mixed (#4). |
| Resend sleep until quiet (≤3×) | Made it worse: sent during boot output, which kept the module awake. |
| Wait for a gap in the output before each send | Still 9/9 failures (#3). Adds ~2 s at mode changes. |

## Simple ways forward

1. **Switch the GPS's power instead of sleeping it.** The GPS currently runs
   from pin 9 (3.3 V), which also powers the GSR circuit and can't be
   switched per-device. Pin 1 (5 V) *can* be switched by the app
   (`furi_hal_power_enable_otg()` / `_disable_otg()`). If the GPS board
   accepts 5 V (has an on-board regulator), moving its power wire to pin 1
   lets the app turn it fully off: 0 mA, no LED, and no reliance on the sleep
   command. Check first: that the board takes 5 V, whether it has a backup
   battery (for quick fixes after power-up), and what pin 1 does when USB is
   plugged in.
2. **Don't sleep it.** Remove the sleep logic and accept ~12–15 mA while the
   GPS isn't in use. Simplest code.
3. **Keep only the step shown to work (#1)** — sleep at session end — and
   accept that it may wake later. Partial saving, small code.

Also recommended regardless: set **Expansion Modules → Listen UART = None** on
devices with the GPS attached (#5).

## Decision (2026-09-25): hold the serial port for the app's whole life

No hardware changes. Today's experiments were reverted (saved as a patch
outside the repo), and the design was built around the one reliable
observation (#1): sleep sent at 115200 holds while the port is held.

- **App start** (`gps_uart_port_open()`): take USART1 and turn Expansion off
  until exit. Wake the module, move it to 115200 (`$PUBX,41` at 9600), then
  send sleep at 115200. It never sleeps from 9600 straight after a restart
  (#3).
- **GPS session end** (`gps_uart_free()`): send sleep at 115200 as before, but
  keep the port. The line idles steadily high, so nothing floats (#6) and
  Expansion can't touch the pins (#5).
- **GSR-only**: nothing to do. The module is already asleep.
- **App exit** (`gps_uart_port_close()`): release the port and turn Expansion
  back on. The module may wake after this. Nothing is recording then, but it
  costs battery until the app next opens.

**Hardware check.** Between sessions the held port counts any bytes from the
module. The log prints `Idle: GPS silent (stayed asleep)` or
`Idle: N bytes from GPS (it was awake)` when a GPS session starts or the app
exits. Check it after a few minutes on the menu and in GSR-only mode.
Fallback if it wakes anyway: controlled GNSS stop (UBX-CFG-RST resetMode 0x08,
integration manual §3.3). It keeps the configuration, and stray signals can't
restart it.

## Hardware results (2026-09-25): the sleep holds

Two runs on the device with the held-port build:

| Stretch | Log | Meaning |
|---|---|---|
| Menu (4 s), then GPS session | `Idle: 9 bytes`, then `Wake: first byte after 236 ms` | Asleep (see below) |
| Menu + GSR-only session (~15 s) | `Idle: GPS silent (stayed asleep)` | Asleep |
| Menu (53 s), then Live Stream | `Idle: 9 bytes`, then `Wake: first byte after 236 ms` | Asleep |

- **Wake-up time is consistent.** 236 ms every time it was woken from sleep,
  against 1–53 ms at app start, when it was already awake (it wakes after the
  app releases the port on exit, as expected).
- **The 9 bytes are not a wake-up.** They appeared only after the app-start
  sleep and were exactly 9 each time. An awake module sends hundreds of bytes
  a second, and each time it then needed a full restart to wake. They are
  leftovers from going to sleep. The idle counter now ignores the first
  second after a sleep command (`GPS_IDLE_SETTLE_MS`), so the log no longer
  reports them as "awake".
- **The fix LED is steadily on while the GPS sleeps.** This is normal. The LED
  follows the module's TIMEPULSE pin. When running, the module drives that pin
  low and pulses it on a fix. In software standby it becomes an input with a
  pull-up, so it sits high and the LED stays lit (SAM-M10Q datasheet Table 10,
  pin states). This also explains the earlier "LED stayed solid" observation
  above. A solid LED on the menu means the GPS is asleep, not that it has a
  fix.
