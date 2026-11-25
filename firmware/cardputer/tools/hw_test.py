#!/usr/bin/env python3
"""Automated on-device tests for the Cardputer, driven over USB serial.

The Cardputer reads the same keys from the serial port as from its keyboard
(; . , / for the arrows, Enter for OK, Esc for Back) and prints a status line
once a second. This script restarts the device before each test so the menus
start from a known place, presses keys, and checks what it prints.

Run from firmware/cardputer with the Cardputer plugged in:
    ~/.platformio/penv/bin/python tools/hw_test.py            # all automatic tests
    ~/.platformio/penv/bin/python tools/hw_test.py gsr_only   # one test
    ~/.platformio/penv/bin/python tools/hw_test.py --list
    add -v to see every line the Cardputer prints

Needs: the GSR board fitted. It turns Sound off and leaves it off. Other
settings it changes (Auto-zoom, Debug Fields) are put back before it
finishes. Recordings it makes are left on the card
(named biomap_1970-01-01_... unless the clock was set from GPS).
"""

import glob
import os
import re
import subprocess
import sys
import time

import serial

ESPTOOL = os.path.expanduser("~/.platformio/packages/tool-esptool/esptool")

UP, DOWN, LEFT, RIGHT, OK, BACK = ";", ".", ",", "/", "\r", "\x1b"
MAIN_MENU = ["GPS + GSR", "GSR Only", "Live Stream", "Wi-Fi Files", "GSR Audio", "Options"]
OPTIONS = ["GPS Profile", "Super-S", "Cold Reset GPS", "Auto-zoom GSR", "GSR Calibration",
           "Backlight", "Sound", "Diagnostics", "Debug Fields"]

STATUS_RE = re.compile(r"^t=\d+ ")
BANNER = "BioMapping Cardputer start"
# The start-up animation plays before the first status line: about 16 s
# from the reset.
STARTUP_TIMEOUT = 60
# The banner counts as a fault only after a status line (an unplanned
# restart). The one at power-on goes out before the computer has the port
# open again, so it is usually missed.
FAULT_RE = re.compile(r"Guru Meditation|core_fatal|abort\(\)|Backtrace:|assert failed")


class Fail(Exception):
    pass


def check(cond, msg):
    if not cond:
        raise Fail(msg)


def parse_status(line):
    """'t=5 rec=0 ns=1.00 ...' -> {'t': 5.0, 'rec': 0.0, ...}"""
    out = {}
    for part in line.split():
        if "=" in part:
            k, v = part.split("=", 1)
            try:
                out[k] = float(v)
            except ValueError:
                out[k] = v
    return out


class Device:
    def __init__(self):
        self.ser = None
        self.log = []          # every line since the last restart: (time, text)
        self.t0 = time.time()
        self.press_mark = 0    # log position when the last key was sent

    # ---- port handling ----
    @staticmethod
    def ports():
        return set(glob.glob("/dev/cu.usbmodem*"))

    def _open(self, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            for p in sorted(self.ports()):
                try:
                    self.ser = serial.Serial(p, 115200, timeout=0.05)
                    return
                except serial.SerialException:
                    pass
            time.sleep(0.1)
        raise Fail("Cardputer serial port did not come back")

    def restart(self):
        """Restart the app: esptool resets the chip through its own USB serial
        port (into the bootloader and straight out with a watchdog reset), so
        it runs again from the top."""
        if self.ser:
            self.ser.close()
            self.ser = None
        r = None
        for _ in range(3):                  # the port can vanish for a moment while it restarts
            end = time.time() + 10
            now = sorted(self.ports())
            while not now and time.time() < end:
                time.sleep(0.2)
                now = sorted(self.ports())
            check(now, "no Cardputer serial port found (is it plugged in?)")
            r = subprocess.run([ESPTOOL, "--port", now[0], "--after", "watchdog-reset", "chip-id"],
                               capture_output=True, text=True)
            if r.returncode == 0:
                break
            time.sleep(1)
        check(r.returncode == 0, "esptool could not reset the Cardputer:\n" + r.stdout[-500:])
        self.log = []
        self.press_mark = 0
        self.t0 = time.time()
        self._open()
        # Main loop running, after the start-up animation.
        self.wait_for(STATUS_RE.pattern, STARTUP_TIMEOUT)

    # ---- reading ----
    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            raw = self.ser.readline()
            if not raw:
                continue
            line = raw.decode(errors="replace").rstrip()
            self.log.append((time.time() - self.t0, line))
            if VERBOSE:
                print(f"      {time.time() - self.t0:6.2f} {line}")

    def _is_fault(self, i, line):
        if FAULT_RE.search(line):
            return True
        return line.startswith(BANNER) and any(
            STATUS_RE.match(l) for _, l in self.log[:i])

    def wait_for(self, pattern, timeout, allow_fault=False, start=None):
        """Wait for a line matching `pattern`, looking from `start` (default:
        just before the last key press, so lines that came in while the keys
        were being sent count)."""
        if start is None:
            start = self.press_mark
        end = time.time() + timeout
        rx = re.compile(pattern)
        while time.time() < end:
            self.pump(0.1)
            for i, (_, line) in enumerate(self.log[start:], start):
                if not allow_fault and self._is_fault(i, line):
                    raise Fail(f"device fault or restart: {line}")
                if rx.search(line):
                    return line
        raise Fail(f"did not see /{pattern}/ within {timeout}s")

    def since(self, mark):
        return [l for _, l in self.log[mark:]]

    def mark(self):
        return len(self.log)

    def statuses(self, mark):
        return [parse_status(l) for l in self.since(mark) if STATUS_RE.match(l)]

    def no_faults(self, mark=0):
        for i, (_, l) in enumerate(self.log[mark:], mark):
            if self._is_fault(i, l):
                raise Fail(f"device fault or restart: {l}")

    # ---- keys ----
    def press(self, keys, gap=0.15):
        self.press_mark = len(self.log)
        for k in keys:
            self.ser.write(k.encode())
            self.ser.flush()
            self.pump(gap)


# ---- menu helpers (state is known because every test starts from a restart) ----

def open_main(dev, item):
    dev.press(DOWN * MAIN_MENU.index(item) + OK)


def open_options_item(dev, item):
    open_main(dev, "Options")
    dev.press(DOWN * OPTIONS.index(item))


def read_settings_line(dev):
    for l in dev.since(0):
        if l.startswith("[Settings] In use:"):
            return parse_status(l.split(":", 1)[1])
    raise Fail("no '[Settings] In use' line at start-up")


def check_gsr_healthy(rows, what):
    check(rows, f"{what}: no status lines")
    hz = [r["hz"] for r in rows]
    okp = [r["ok"] for r in rows]
    check(min(hz) >= 900, f"{what}: GSR reading rate dropped to {min(hz):.0f}/s (want >= 900)")
    check(min(okp) >= 99.0, f"{what}: I2C success fell to {min(okp):.1f}% (want >= 99)")
    peak = max(r["i2c_peak"] for r in rows)
    check(peak <= 20, f"{what}: slowest I2C read {peak:.0f} ms (want <= 20)")


def set_option(dev, field, item, on):
    """Restart, then set the on/off Options `item` to `on` (it is saved to the
    card). `field` is its name in the "[Settings] In use" line. Returns what
    it was before."""
    dev.restart()
    was = bool(read_settings_line(dev)[field])
    if was != on:
        open_options_item(dev, item)
        dev.press(OK)
        dev.pump(0.5)
        dev.restart()
        check(bool(read_settings_line(dev)[field]) == on, f"{item} did not save")
    return was


def set_debug_fields(dev, on):
    set_option(dev, "debug", "Debug Fields", on)


# ---- tests ----

def test_boot(dev):
    """Starts cleanly: banner, settings loaded, GPS brought up, status every second."""
    dev.restart()
    dev.pump(4)
    lines = dev.since(0)
    read_settings_line(dev)
    check(any(l.startswith("[GPS] Wake:") for l in lines),
          "GPS wake step did not run at start-up")
    bad = [l for l in lines if "error" in l.lower() or "warning" in l.lower()]
    check(not bad, "warnings at start-up: " + " | ".join(bad))
    ts = [r["t"] for r in dev.statuses(0)]
    check(len(ts) >= 4, f"only {len(ts)} status lines in ~5 s")
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    check(all(g == 1 for g in gaps), f"status line skipped a second: {ts}")
    dev.no_faults()


def test_gsr_only(dev):
    """GSR Only: sensor found, reads ~1000/s, no I2C errors, nothing recorded."""
    dev.restart()
    m = dev.mark()
    open_main(dev, "GSR Only")
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(6)
    rows = dev.statuses(m)[2:]          # skip the start-up second or two
    check_gsr_healthy(rows, "GSR Only")
    check(all(r["rec"] == 0 for r in rows), "recording started without Enter")
    dev.press(BACK)
    dev.pump(2)
    last = dev.statuses(m)[-1]
    check(last["hz"] == 0, "GSR reader still running after Esc")
    dev.no_faults()


def test_record_crlf(dev):
    """One Enter is one OK whatever line ending is sent ("\\r\\n" must not toggle twice)."""
    dev.restart()
    open_main(dev, "GSR Only")
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(2)
    dev.press_mark = dev.mark()
    dev.ser.write(b"\r\n")
    dev.wait_for(r"\[SD\] Recording to ", 3)
    dev.pump(2.5)
    check(dev.statuses(0)[-1]["rec"] == 1, "\\r\\n toggled recording twice (started then stopped)")
    m = dev.press_mark = dev.mark()
    dev.ser.write(b"\n")
    dev.wait_for(r"\[SD\] Stopped ", 3)
    dev.pump(1.5)
    check(dev.statuses(m)[-1]["rec"] == 0, "recording still on after second Enter")
    dev.press(BACK)
    dev.pump(1)
    dev.no_faults()


def record_gsr_only(dev, seconds):
    """Inside GSR Only: Enter, record for `seconds`, Enter. Returns the file
    name and how long it really recorded (from the start and stop lines)."""
    dev.press(OK)
    start = dev.wait_for(r"\[SD\] Recording to ", 3)
    t_start = next(t for t, l in reversed(dev.log) if l == start)
    name = start.split("Recording to ", 1)[1]
    dev.pump(seconds)
    dev.press(OK)
    stop = dev.wait_for(r"\[SD\] Stopped " + re.escape(name), 3)
    t_stop = next(t for t, l in reversed(dev.log) if l == stop)
    return name, t_stop - t_start


def test_record_60s(dev):
    """A 60 s GSR Only recording: no SD failures, no overflow, steady sensor."""
    dev.restart()
    open_main(dev, "GSR Only")
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(2)
    m = dev.mark()
    name, _ = record_gsr_only(dev, 60)
    dev.pump(1.5)
    rows = [r for r in dev.statuses(m) if r["rec"] == 1]
    check(len(rows) >= 58, f"only {len(rows)} recording seconds seen")
    check_gsr_healthy(rows, "recording")
    last = dev.statuses(m)[-1]
    check(last["fails"] == 0, f"{last['fails']:.0f} SD write failures")
    # SD cards stall now and then (wear levelling); a few hundred ms is
    # normal. Missed ticks are caught up for up to TICK_SCHEDULE_MAX_DUE
    # (64 ticks, 6.4 s; tick_schedule.h), so only a stall near that loses
    # anything.
    check(last["sd_peak"] <= 3000, f"slowest SD write {last['sd_peak']:.0f} ms (want <= 3000)")
    bad = [l for l in dev.since(m) if "overflow" in l.lower() or "flush failed" in l.lower()]
    check(not bad, "SD trouble: " + " | ".join(bad))
    dev.press(BACK)
    dev.pump(1)
    dev.no_faults()
    print(f"      file {name}, slowest SD write {last['sd_peak']:.0f} ms")


def test_gps_gsr(dev):
    """GPS + GSR: GPS streams with no lost bytes, Enter waits for GPS time,
    and GSR Only puts the GPS to sleep (checked when re-entering GPS + GSR)."""
    dev.restart()
    m = dev.mark()
    open_main(dev, "GPS + GSR")
    dev.wait_for(r"\[GSR\] I2C Probe OK", 5)
    dev.pump(8)
    rows = [r for r in dev.statuses(m) if "gps_fix" in r][1:]
    check(rows, "no GPS fields in the status line")
    check_gsr_healthy(rows, "GPS + GSR")
    last = rows[-1]
    check(last["gps_lost"] == 0, f"{last['gps_lost']:.0f} GPS bytes lost")
    check(last["gps_full"] == 0, f"GPS buffer filled {last['gps_full']:.0f} times")
    clock_set = "time" in last
    m2 = dev.mark()
    dev.press(OK)
    dev.pump(2.5)
    rec = dev.statuses(m2)[-1]["rec"]
    if clock_set:
        check(rec == 1, "clock is set but Enter didn't start recording")
        dev.press(OK)
        dev.wait_for(r"\[SD\] Stopped ", 3)
    else:
        check(rec == 0, "recording started without GPS time")
        check(not any("Recording to" in l for l in dev.since(m2)),
              "file opened without GPS time")
    # Enter GSR Only to put the GPS to sleep, then wake it back in GPS + GSR
    # and verify the idle watch confirmed it stayed silent.
    dev.press(BACK)
    dev.pump(0.5)
    dev.press(DOWN + OK)                # GSR Only sleeps the GPS
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(4)
    dev.press(BACK)
    dev.pump(0.5)
    dev.press(UP + OK)                  # back to GPS + GSR
    idle = dev.wait_for(r"\[GPS\]( warning:)? Idle:", 6)
    check("GPS silent" in idle, "GPS was not asleep during GSR Only: " + idle)
    dev.pump(2)
    dev.press(BACK)
    dev.pump(1)
    dev.no_faults()
    print(f"      fix={last['gps_fix']:.0f} sats={last['sats']:.0f} clock_set={clock_set}")


# Each Live Stream session loses about 1 KB that the BLE library never frees
# (its service and characteristic; see switch_off() in bt_cardputer.cpp).
# The test lets that through and fails if it grows.
KNOWN_BLE_LEAK_BYTES = 1100


def test_gps_reset_in_session(dev):
    """Restart in the middle of GPS + GSR: start-up recovers cleanly at 115200,
    and GSR Only puts it to sleep so the next restart wakes it at 9600."""
    dev.restart()
    open_main(dev, "GPS + GSR")
    dev.wait_for(r"M10Q running at 115200", 10)
    dev.pump(2)
    dev.restart()                       # GPS left awake at 115200, 10 Hz
    dev.pump(1)
    lines = dev.since(0)
    check(any(l.startswith("[GPS] Wake: no reply at 9600") for l in lines),
          "start-up didn't notice the GPS was left awake at 115200")
    bad = [l for l in lines if "warning" in l.lower() or "error" in l.lower()]
    check(not bad, "warnings at start-up: " + " | ".join(bad))
    # Put it to sleep via GSR Only; next start-up has to wake it at 9600.
    open_main(dev, "GSR Only")
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(1)
    dev.restart()
    check(any(l.startswith("[GPS] Wake: first byte") for l in dev.since(0)),
          "GPS was still awake: GSR Only sleep didn't take")


def test_wifi_files_cycles(dev, cycles=5):
    """Wi-Fi Files hotspot on/off repeatedly: Wi-Fi turns on and fully off each
    time without crashing or leaking memory, and GSR Only still works after."""
    dev.restart()
    open_main(dev, "Wi-Fi Files")
    heaps_off = []
    for i in range(cycles):
        if i:
            dev.press(OK)               # main menu still has Wi-Fi Files selected
        dev.wait_for(r"\[WiFi\] on: ap=BioMapping-[0-9A-F]{4} ip=192\.168\.4\.1", 5)
        dev.pump(1.5)
        last = dev.statuses(0)[-1]
        check(last.get("wifi") == 1, "no wifi=1 status field while Wi-Fi Files is open")
        dev.press(BACK)
        off = dev.wait_for(r"\[WiFi\] off \(free heap \d+\)", 5)
        heaps_off.append(int(re.search(r"free heap (\d+)", off).group(1)))
        dev.pump(0.8)
    per = (heaps_off[1] - heaps_off[-1]) / max(1, cycles - 2)
    print(f"      free memory after each stop: {heaps_off} ({per:.0f} bytes lost per visit)")
    check(per <= 2048, f"losing {per:.0f} bytes per Wi-Fi Files visit")
    # Confirm Bluetooth (Live Stream) -> Wi-Fi Files -> GSR Only all work cleanly
    # in the same boot without rebooting.
    dev.press(UP + OK)                  # Wi-Fi Files -> Live Stream
    dev.wait_for(r"\[BLE\] on: advertising", 5)
    dev.pump(1.5)
    dev.press(BACK)
    dev.wait_for(r"\[BLE\] off \(free heap \d+\)", 5)
    dev.pump(0.8)

    dev.press(DOWN + OK)                # Live Stream -> Wi-Fi Files
    dev.wait_for(r"\[WiFi\] on: ap=BioMapping-[0-9A-F]{4} ip=192\.168\.4\.1", 5)
    dev.pump(1.0)
    dev.press(BACK)
    dev.wait_for(r"\[WiFi\] off \(free heap \d+\)", 5)
    dev.pump(0.8)

    # This order used to run out of memory for the recording (core_fatal
    # "SdLogger: NULL logger alloc"), so record a few seconds too.
    dev.press(UP * 2 + OK)              # Wi-Fi Files -> Live Stream -> GSR Only
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(1.5)
    last = dev.statuses(0)[-1]
    check("wifi" not in last, "wifi field still present inside GSR Only")
    m = dev.mark()
    record_gsr_only(dev, 3)
    dev.pump(0.5)
    short = [l for l in dev.since(m) if "no memory" in l]
    check(not short, "short of memory after Live Stream + Wi-Fi: " + " | ".join(short))
    dev.press(BACK)
    dev.pump(0.5)
    dev.no_faults()


def test_live_stream_cycles(dev, cycles=8):
    """Live Stream on/off repeatedly: Bluetooth turns on and fully off each time
    and memory loss stays at the known ~1 KB per session."""
    dev.restart()
    open_main(dev, "Live Stream")
    heaps_off = []
    for i in range(cycles):
        if i:
            dev.press(OK)               # main menu still has Live Stream selected
        dev.wait_for(r"\[BLE\] on: advertising", 5)
        dev.pump(2.5)
        last = dev.statuses(0)[-1]
        check("ble" in last, "no ble field while streaming")
        dev.press(BACK)
        off = dev.wait_for(r"\[BLE\] off \(free heap \d+\)", 5)
        heaps_off.append(int(re.search(r"free heap (\d+)", off).group(1)))
        dev.pump(1)
    per = (heaps_off[1] - heaps_off[-1]) / (cycles - 2)
    print(f"      free memory after each stop: {heaps_off} ({per:.0f} bytes lost per session)")
    check(per <= KNOWN_BLE_LEAK_BYTES,
          f"losing {per:.0f} bytes per Live Stream session (known leak is about 1012)")
    dev.no_faults()


def test_session_cycles(dev, cycles=15):
    """Open and close GSR Only (with a short recording) many times quickly: no crash,
    no leak. Uses Debug Fields' heartbeat line for the memory figure."""
    set_debug_fields(dev, True)
    try:
        open_main(dev, "GSR Only")
        for i in range(cycles):
            if i:
                dev.press(OK)
            dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
            dev.pump(1.2)
            dev.press(OK)
            dev.wait_for(r"\[SD\] Recording to ", 3)
            dev.pump(1.2)
            dev.press(BACK)
            dev.wait_for(r"\[SD\] Stopped ", 3)
            dev.pump(1.2)
        # The heartbeat prints only inside a session; keep the last one before each stop.
        frees = []
        cur = None
        for l in dev.since(0):
            mm = re.match(r"heartbeat heap:free=(\d+) min=(\d+) stack:main=(\d+) gsr=(\d+)", l)
            if mm:
                cur = tuple(int(x) for x in mm.groups())
            elif l.startswith("[SD] Stopped") and cur:
                frees.append(cur)
                cur = None
        check(len(frees) >= cycles - 2, f"only {len(frees)} heartbeat readings")
        free = [f[0] for f in frees]
        print(f"      free memory per session: {free}")
        print(f"      lowest ever {min(f[1] for f in frees)}, stack spare main={min(f[2] for f in frees)}"
              f" gsr={min(f[3] for f in frees)}")
        check(free[1] - free[-1] <= 2048, f"free memory fell {free[1] - free[-1]} bytes (leak?)")
        check(min(f[2] for f in frees) >= 512, "main stack nearly full")
        check(min(f[3] for f in frees) >= 256, "GSR thread stack nearly full")
        dev.no_faults()
    finally:
        set_debug_fields(dev, False)


def test_key_flood(dev):
    """200 random keys inside a recording session: no crash, sensor keeps up."""
    import random
    rnd = random.Random(1)
    dev.restart()
    open_main(dev, "GSR Only")
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(1.5)
    dev.press(OK)
    dev.wait_for(r"\[SD\] Recording to ", 3)
    m = dev.mark()
    keys = "".join(rnd.choice([UP, DOWN, LEFT, RIGHT]) for _ in range(200))
    dev.press(keys, gap=0.01)
    dev.pump(3)
    rows = dev.statuses(m)
    check(all(r["rec"] == 1 for r in rows), "recording stopped during the key flood")
    check_gsr_healthy(rows, "key flood")
    dev.press(OK)
    dev.wait_for(r"\[SD\] Stopped ", 3)
    dev.press(BACK)
    dev.pump(1)
    dev.no_faults()


def test_diagnostics(dev):
    """Options > Diagnostics opens a GSR session and Esc leaves it."""
    dev.restart()
    open_options_item(dev, "Diagnostics")
    dev.press(OK)
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    m = dev.mark()                      # from here, not from the menus
    dev.pump(4)
    check_gsr_healthy(dev.statuses(m)[1:], "Diagnostics")  # skip its first second
    dev.press(BACK)
    dev.pump(2)
    check(dev.statuses(m)[-1]["hz"] == 0, "GSR still running after leaving Diagnostics")
    dev.no_faults()


def test_gsr_audio(dev, cycles=4):
    """Standalone GSR Audio mode: sleeps GPS, 5 soundscapes, 10-150% sens, log volume, zero leak."""
    dev.restart()
    open_main(dev, "GSR Audio")
    heaps_off = []
    for i in range(cycles):
        if i:
            dev.press(OK)
        dev.wait_for(r"\[Audio\] on: mode=(DRONE|BREATH|CHORD|BOWLS|RAIN) rate=48000", 3)
        m = dev.mark()
        dev.pump(3.5)
        rows = dev.statuses(m)[1:]
        check_gsr_healthy(rows, "GSR Audio")
        check(all(r.get("audio") == 1 for r in rows), "missing audio=1 in GSR Audio mode")
        check(all("gps_fix" not in r for r in rows), "GPS session active inside GSR Audio")
        if i == 0:
            for expected in ["BREATH", "CHORD", "BOWLS", "RAIN", "DRONE"]:
                dev.press(RIGHT)
                dev.wait_for(rf"\[Audio\] mode={expected} vol=80% sens=100%", 2)
            dev.press(UP)
            dev.wait_for(r"\[Audio\] mode=DRONE vol=80% sens=110%", 2)
            dev.press(DOWN)
            dev.wait_for(r"\[Audio\] mode=DRONE vol=80% sens=100%", 2)
            dev.press("+")
            dev.wait_for(r"\[Audio\] mode=DRONE vol=90% sens=100%", 2)
            dev.press("-")
            dev.wait_for(r"\[Audio\] mode=DRONE vol=80% sens=100%", 2)
            dev.press(OK)
            dev.wait_for(r"\[Audio\] mode=MUTED", 2)
            dev.press(OK)
            dev.wait_for(r"\[Audio\] mode=DRONE", 2)
        dev.press(BACK)
        off = dev.wait_for(r"\[Audio\] off \(free heap \d+\)", 3)
        heaps_off.append(int(re.search(r"free heap (\d+)", off).group(1)))
        dev.pump(1.2)
        last = dev.statuses(0)[-1]
        check(last["hz"] == 0, "GSR reader still running after leaving GSR Audio")
        check("audio" not in last, "audio=1 still present after leaving GSR Audio")
    per = (heaps_off[1] - heaps_off[-1]) / max(1, cycles - 2)
    print(f"      free memory after each stop: {heaps_off} ({per:.0f} bytes lost per visit)")
    check(per <= 256, f"losing {per:.0f} bytes per GSR Audio visit")
    # Verify GPS stayed completely asleep during GSR Audio (same idle-watch check as GSR Only).
    dev.press(UP * 4 + OK)              # GSR Audio (index 4) -> GPS + GSR (index 0)
    idle = dev.wait_for(r"\[GPS\]( warning:)? Idle:", 6)
    check("GPS silent" in idle, "GPS was not asleep during GSR Audio: " + idle)
    dev.pump(1)
    dev.press(BACK)
    dev.pump(1)
    dev.no_faults()


def test_settings_persist(dev):
    """Auto-zoom toggled in Options survives a restart; then put back."""
    dev.restart()
    before = read_settings_line(dev)["zoom"]
    try:
        open_options_item(dev, "Auto-zoom GSR")
        dev.press(OK)
        dev.pump(0.5)
        dev.restart()
        after = read_settings_line(dev)["zoom"]
        check(after != before, f"Auto-zoom was {before:.0f}, still {after:.0f} after toggle + restart")
    finally:
        dev.restart()
        if read_settings_line(dev)["zoom"] != before:
            open_options_item(dev, "Auto-zoom GSR")
            dev.press(OK)
            dev.pump(0.5)
            dev.restart()
            check(read_settings_line(dev)["zoom"] == before, "could not put Auto-zoom back")


def _stalled_request(path):
    """Opens a connection to the Cardputer's web page, asks for `path`, and
    then never reads the reply, with a tiny receive window, so the reply backs
    up as it does when a phone drops off the hotspot part-way through."""
    import socket
    sk = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sk.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 256)
    sk.settimeout(3)
    sk.connect(("192.168.4.1", 80))
    sk.sendall(f"GET {path} HTTP/1.1\r\nHost: 192.168.4.1\r\n\r\n".encode())
    return sk


def _wait_for_mac_on_hotspot(dev, timeout=180):
    import socket
    print("      Join this Mac to the Cardputer's BioMapping-XXXX Wi-Fi now "
          f"(waiting up to {timeout} s)...")
    end = time.time() + timeout
    while time.time() < end:
        dev.pump(0.5)
        try:
            socket.create_connection(("192.168.4.1", 80), timeout=1).close()
            return
        except OSError:
            pass
    raise Fail("this Mac never reached 192.168.4.1 (not joined to the hotspot?)")


def _longest_status_gap(dev, mark):
    times = [t for t, l in dev.log[mark:] if STATUS_RE.match(l)]
    return max((b - a for a, b in zip(times, times[1:])), default=0.0), len(times)


def test_wifi_stalled_client(dev):
    """Wi-Fi Files with a device that stops reading mid-reply: the Cardputer keeps
    running (status line keeps coming), gives up within ~10 s, and Esc still works."""
    dev.restart()
    open_main(dev, "Wi-Fi Files")
    dev.wait_for(r"\[WiFi\] on: ap=BioMapping-[0-9A-F]{4}", 5)
    _wait_for_mac_on_hotspot(dev)
    dev.pump(2)

    # 1. Stalled page and file list, one after the other.
    for path in ["/", "/api/files", "/"]:
        m = dev.mark()
        sk = _stalled_request(path)
        dev.pump(25)
        gap, n = _longest_status_gap(dev, m)
        stopped = any("reply stopped" in l for l in dev.since(m))
        print(f"      GET {path}: longest pause in the status line {gap:.1f} s "
              f"({n} lines in 25 s), gave up on the stalled reply: {stopped}")
        sk.close()
        check(gap <= 12, f"Cardputer stopped running for {gap:.1f} s on a stalled GET {path}")
        dev.pump(1)

    # 2. Esc while a reply is stalled closes the screen at once.
    sk = _stalled_request("/")
    dev.pump(1.0)
    m = dev.mark()
    t = time.time()
    dev.press(BACK)
    dev.wait_for(r"\[WiFi\] off", 4, start=m)
    print(f"      Esc during a stalled reply: Wi-Fi off after {time.time() - t:.1f} s")
    sk.close()
    dev.pump(1)
    dev.no_faults()


TESTS = [
    ("boot", test_boot),
    ("gsr_only", test_gsr_only),
    ("record_crlf", test_record_crlf),
    ("diagnostics", test_diagnostics),
    ("gsr_audio", test_gsr_audio),
    ("gps_gsr", test_gps_gsr),
    ("gps_reset_in_session", test_gps_reset_in_session),
    ("key_flood", test_key_flood),
    ("settings_persist", test_settings_persist),
    ("live_stream_cycles", test_live_stream_cycles),
    ("wifi_files_cycles", test_wifi_files_cycles),
    ("session_cycles", test_session_cycles),
    ("record_60s", test_record_60s),
    ("wifi_stalled_client", test_wifi_stalled_client),  # needs this Mac on the hotspot: by name only
]
NEEDS_KEY_PRESS = {"wifi_stalled_client"}

VERBOSE = "-v" in sys.argv


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--list" in sys.argv:
        for name, fn in TESTS:
            print(f"{name:20s} {fn.__doc__.splitlines()[0]}")
        return 0
    chosen = [(n, f) for n, f in TESTS if n in args or (not args and n not in NEEDS_KEY_PRESS)]
    unknown = set(args) - {n for n, _ in TESTS}
    if unknown:
        print("unknown test(s):", ", ".join(sorted(unknown)))
        return 2
    dev = Device()
    results = []
    # No test listens for the sound, so it is turned off, and left off
    # afterwards. Turning it off makes one beep: the Sound toggle always sounds.
    set_option(dev, "sound", "Sound", False)
    run_tests(dev, chosen, results)
    passed = sum(ok for _, ok, _ in results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


def run_tests(dev, chosen, results):
    for name, fn in chosen:
        print(f"[ RUN  ] {name}: {fn.__doc__.splitlines()[0]}")
        t = time.time()
        try:
            fn(dev)
            results.append((name, True, ""))
            print(f"[  OK  ] {name} ({time.time() - t:.0f} s)")
        except Fail as e:
            results.append((name, False, str(e)))
            print(f"[ FAIL ] {name}: {e}")
            print("      last lines from the device:")
            for ts, l in dev.log[-12:]:
                print(f"      {ts:6.2f} {l}")


if __name__ == "__main__":
    sys.exit(main())
