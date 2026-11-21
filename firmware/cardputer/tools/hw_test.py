#!/usr/bin/env python3
"""Automated on-device tests for the Cardputer, driven over USB serial.

The Cardputer reads the same keys from the serial port as from its keyboard
(; . , / for the arrows, Enter for OK, Esc for Back) and prints a status line
once a second. This script restarts the device before each test so the menus
start from a known place, presses keys, and checks what it prints.

Run from firmware/cardputer with the Cardputer plugged in:
    ~/.platformio/penv/bin/python tools/hw_test.py            # all automatic tests
    ~/.platformio/penv/bin/python tools/hw_test.py gsr_only   # one test
    ~/.platformio/penv/bin/python tools/hw_test.py --usb      # also check a file on the card
    ~/.platformio/penv/bin/python tools/hw_test.py --list
    add -v to see every line the Cardputer prints

The --usb test (csv_check) needs one key press on the Cardputer itself: the U
key that lends the SD card to the computer works only on its own keyboard.

Needs: the GSR board fitted. Settings it changes (Auto-zoom, Debug Fields)
are put back before it finishes. Recordings it makes are left on the card
(named biomap_1970-01-01_... unless the clock was set from GPS).
"""

import glob
import json
import os
import zlib
import re
import subprocess
import sys
import time

import serial

ESPTOOL = os.path.expanduser("~/.platformio/packages/tool-esptool/esptool")
# record_60s leaves its file's name and length here for csv_check (kept in
# .pio/, which git ignores, so csv_check can be run later on its own).
LAST_RECORDING = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".pio",
                              "hw_test_last_recording.json")

UP, DOWN, LEFT, RIGHT, OK, BACK = ";", ".", ",", "/", "\r", "\x1b"
MAIN_MENU = ["GPS + GSR", "GSR Only", "Live Stream", "Wi-Fi Files", "Options"]
OPTIONS = ["GPS Profile", "Super-S", "Cold Reset GPS", "Auto-zoom GSR", "GSR Calibration",
           "Backlight", "Sound", "Diagnostics", "Debug Fields"]

STATUS_RE = re.compile(r"^t=\d+ ")
BANNER = "BioMapping Cardputer start"
# The banner counts as a fault only after the first one (an unplanned restart).
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
        """Restart the app: 1200-baud touch drops it into the bootloader,
        then a watchdog reset runs the app again from the top."""
        if self.ser:
            self.ser.close()
            self.ser = None
        before = sorted(self.ports())
        check(before, "no Cardputer serial port found (is it plugged in?)")
        app_port = before[0]
        boot = None
        for _ in range(3):                  # the 1200-baud touch is occasionally missed
            s = serial.Serial(app_port, 1200)
            s.dtr = False
            time.sleep(0.2)
            s.close()
            end = time.time() + 5
            while time.time() < end and not boot:
                time.sleep(0.2)
                now = self.ports()
                if now and app_port not in now:
                    boot = sorted(now)[0]
            if boot:
                break
        check(boot, "Cardputer did not enter its bootloader")
        time.sleep(0.3)
        r = subprocess.run([ESPTOOL, "--port", boot, "--after", "watchdog-reset", "chip-id"],
                           capture_output=True, text=True)
        check(r.returncode == 0, "esptool could not reset the Cardputer:\n" + r.stdout[-500:])
        self.log = []
        self.press_mark = 0
        self.t0 = time.time()
        self._open()
        self.wait_for(BANNER, 8, allow_fault=True)
        self.wait_for(STATUS_RE.pattern, 6)   # main loop running

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
            l.startswith(BANNER) for _, l in self.log[:i])

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
        if l.startswith("[Settings] Loaded settings:"):
            return parse_status(l.split(":", 1)[1])
    raise Fail("no '[Settings] Loaded settings' line at start-up")


def check_gsr_healthy(rows, what):
    check(rows, f"{what}: no status lines")
    hz = [r["hz"] for r in rows]
    okp = [r["ok"] for r in rows]
    check(min(hz) >= 900, f"{what}: GSR reading rate dropped to {min(hz):.0f}/s (want >= 900)")
    check(min(okp) >= 99.0, f"{what}: I2C success fell to {min(okp):.1f}% (want >= 99)")
    peak = max(r["i2c_peak"] for r in rows)
    check(peak <= 20, f"{what}: slowest I2C read {peak:.0f} ms (want <= 20)")


def set_debug_fields(dev, on):
    """Restart, then set Debug Fields to `on` (it is saved to the card)."""
    dev.restart()
    if bool(read_settings_line(dev)["debug"]) != on:
        open_options_item(dev, "Debug Fields")
        dev.press(OK)
        dev.pump(0.5)
        dev.restart()
        check(bool(read_settings_line(dev)["debug"]) == on, "Debug Fields did not save")


# ---- tests ----

def test_boot(dev):
    """Starts cleanly: banner, settings loaded, GPS put to sleep, status every second."""
    dev.restart()
    dev.pump(4)
    lines = dev.since(0)
    read_settings_line(dev)
    check(any(l.startswith("[GPS] Wake: first byte") for l in lines),
          "GPS did not answer during the start-up sleep step")
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


def check_csv(path, seconds):
    """A recording is complete and unchanged, and has a row for every tick."""
    data = open(path, "rb").read()
    check(data.startswith(b"# Integrity: crc32 v1\n"), "no integrity line at the top")
    body, _, trailer = data.rstrip(b"\n").rpartition(b"\n")
    body += b"\n"
    m = re.match(rb"# End rows:(\d+) bytes:(\d+) crc32:([0-9a-f]{8}) (?:end_time:\d+ )?"
                 rb"overflows:(\d+) flush_fails:(\d+)$", trailer)
    check(m, f"no '# End' line (did it stop cleanly?): {trailer[-120:]!r}")
    rows_t, bytes_t, crc_t, over, fails = (int(m.group(1)), int(m.group(2)),
                                           int(m.group(3), 16), int(m.group(4)), int(m.group(5)))
    check(len(body) == bytes_t, f"file has {len(body)} bytes before the End line, End says {bytes_t}")
    crc = zlib.crc32(body) & 0xFFFFFFFF
    check(crc == crc_t, f"checksum {crc:08x} doesn't match the End line's {crc_t:08x}")
    check(over == 0, f"{over} buffer overflows")
    check(fails == 0, f"{fails} failed SD writes")
    lines = [l for l in body.decode().splitlines() if l and not l.startswith("#")]
    # The header ends with the column names (no "#"), which the End line
    # doesn't count as a row.
    check(lines and not lines[0][:1].isdigit(), "no column-names line after the header")
    rows = lines[1:]
    check(len(rows) == rows_t, f"{len(rows)} data rows, End line says {rows_t}")
    times = [float(r.split(",", 1)[0]) for r in rows]
    steps = [b - a for a, b in zip(times, times[1:])]
    bad = [(i, round(st, 3)) for i, st in enumerate(steps) if abs(st - 0.1) > 0.006]
    check(not bad, f"time column doesn't step by 0.1 s at rows {bad[:5]}")
    # Rows are counted from ticks, so the time column is always continuous;
    # a lost tick would show up as fewer rows than the real recording time.
    want = seconds * 10
    check(abs(len(rows) - want) <= max(3, want * 0.01),
          f"{len(rows)} rows for {seconds:.1f} s of recording (want about {want:.0f})")
    return len(rows)


def find_card(timeout):
    end = time.time() + timeout
    while True:                         # looks at least once, even with timeout 0
        for vol in glob.glob("/Volumes/*/biomapping"):
            return os.path.dirname(vol)
        if time.time() >= end:
            return None
        time.sleep(0.5)


def test_csv_check(dev):
    """Lends the SD card over USB (you press U) and checks a recording for lost rows.

    Checks the last file record_60s made; without one, it makes a 30 s
    recording first. If the card is already on the computer (U pressed
    beforehand, from the main menu), it goes straight to the check. At the
    end it ejects the card so the Cardputer takes it back."""
    name = seconds = None
    if os.path.exists(LAST_RECORDING):
        with open(LAST_RECORDING) as f:
            last = json.load(f)
        name, seconds = last["name"], last["seconds"]
    vol = find_card(0)
    if vol:
        dev._open()
    else:
        dev.restart()
        if not name:
            open_main(dev, "GSR Only")
            dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
            dev.pump(2)
            name, seconds = record_gsr_only(dev, 30)
            dev.press(BACK)
            dev.pump(1)
        print("\a      >>> Press U on the Cardputer's keyboard now (main menu) <<<", flush=True)
        dev.press_mark = dev.mark()
        dev.wait_for(r"\[SD\] USB drive on", 300)
        vol = find_card(30)
        check(vol, "the card didn't appear under /Volumes")
    check(name, "no recording to check: run record_60s first")
    try:
        path = os.path.join(vol, "biomapping", name)
        check(os.path.exists(path), f"{name} not on the card")
        n = check_csv(path, seconds)
        print(f"      {name}: {n} rows for {seconds:.1f} s, checksum OK, nothing lost")
    finally:
        dev.press_mark = dev.mark()
        subprocess.run(["diskutil", "eject", vol], capture_output=True)
        dev.wait_for(r"\[SD\] USB drive off", 20)
    dev.no_faults()


def test_record_60s(dev):
    """A 60 s GSR Only recording: no SD failures, no overflow, steady sensor."""
    dev.restart()
    open_main(dev, "GSR Only")
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(2)
    m = dev.mark()
    name, seconds = record_gsr_only(dev, 60)
    dev.pump(1.5)
    rows = [r for r in dev.statuses(m) if r["rec"] == 1]
    check(len(rows) >= 58, f"only {len(rows)} recording seconds seen")
    check_gsr_healthy(rows, "recording")
    last = dev.statuses(m)[-1]
    check(last["fails"] == 0, f"{last['fails']:.0f} SD write failures")
    # SD cards stall now and then (wear levelling); a few hundred ms is
    # normal. Missed ticks are caught up for up to TICK_SCHEDULE_MAX_DUE
    # (64 ticks, 6.4 s; tick_schedule.h), so only a stall near that loses
    # anything. csv_check confirms nothing was lost from the file itself.
    check(last["sd_peak"] <= 3000, f"slowest SD write {last['sd_peak']:.0f} ms (want <= 3000)")
    bad = [l for l in dev.since(m) if "overflow" in l.lower() or "flush failed" in l.lower()]
    check(not bad, "SD trouble: " + " | ".join(bad))
    dev.press(BACK)
    dev.pump(1)
    dev.no_faults()
    os.makedirs(os.path.dirname(LAST_RECORDING), exist_ok=True)
    with open(LAST_RECORDING, "w") as f:
        json.dump({"name": name, "seconds": seconds}, f)
    print(f"      file {name}, slowest SD write {last['sd_peak']:.0f} ms")


def test_gps_gsr(dev):
    """GPS + GSR: GPS streams with no lost bytes, Enter waits for GPS time, Esc sleeps the GPS.

    Enter only records if the clock was set from GPS; Esc must leave the GPS
    asleep (checked by going back in after a few seconds)."""
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
    # The "stayed asleep" check is reported when the GPS is next woken.
    dev.press(BACK)
    dev.pump(4)
    dev.press(OK)                       # main menu still on GPS + GSR
    idle = dev.wait_for(r"\[GPS\]( warning:)? Idle:", 6)
    check("GPS silent" in idle, "GPS was not asleep between sessions: " + idle)
    dev.pump(2)
    dev.press(BACK)
    dev.pump(1)
    dev.no_faults()
    print(f"      fix={last['gps_fix']:.0f} sats={last['sats']:.0f} clock_set={clock_set}")


# Each Live Stream session loses about 1 KB that the BLE library never frees
# (its service and characteristic; see switch_off() in bt_cardputer.cpp).
# The test lets that through and fails if it grows.
KNOWN_BLE_LEAK_BYTES = 1100


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

    dev.press(UP * 2 + OK)              # Wi-Fi Files -> Live Stream -> GSR Only
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(1.5)
    last = dev.statuses(0)[-1]
    check("wifi" not in last, "wifi field still present inside GSR Only")
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
    m = dev.mark()
    open_options_item(dev, "Diagnostics")
    dev.press(OK)
    dev.wait_for(r"\[GSR\] I2C Probe OK", 3)
    dev.pump(4)
    check_gsr_healthy(dev.statuses(m)[2:], "Diagnostics")
    dev.press(BACK)
    dev.pump(2)
    check(dev.statuses(m)[-1]["hz"] == 0, "GSR still running after leaving Diagnostics")
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


TESTS = [
    ("boot", test_boot),
    ("gsr_only", test_gsr_only),
    ("record_crlf", test_record_crlf),
    ("diagnostics", test_diagnostics),
    ("gps_gsr", test_gps_gsr),
    ("key_flood", test_key_flood),
    ("settings_persist", test_settings_persist),
    ("live_stream_cycles", test_live_stream_cycles),
    ("wifi_files_cycles", test_wifi_files_cycles),
    ("session_cycles", test_session_cycles),
    ("record_60s", test_record_60s),
    ("csv_check", test_csv_check),     # needs a U key press: only with --usb or by name
]
NEEDS_KEY_PRESS = {"csv_check"}

VERBOSE = "-v" in sys.argv


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--list" in sys.argv:
        for name, fn in TESTS:
            print(f"{name:20s} {fn.__doc__.splitlines()[0]}")
        return 0
    usb = "--usb" in sys.argv
    chosen = [(n, f) for n, f in TESTS
              if n in args or (not args and (usb or n not in NEEDS_KEY_PRESS))]
    unknown = set(args) - {n for n, _ in TESTS}
    if unknown:
        print("unknown test(s):", ", ".join(sorted(unknown)))
        return 2
    dev = Device()
    results = []
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
    passed = sum(ok for _, ok, _ in results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
