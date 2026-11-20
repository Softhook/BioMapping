#!/usr/bin/env python3
"""Compare GSR noise between the Flipper and the Cardputer bench program.

Works out the same noise number from both:

    noise = the highest minus the lowest of the ten 100 ms values in one
            second (peak to peak, in nS), for seconds where all ten were
            valid readings.

The Cardputer bench program already logs this number every second
(noise_pp_ns). For a Flipper recording it is worked out here from blocks of
ten rows of gsr_raw.

Bench logs are split by the noise-test settings (Bluetooth, backlight, SD
card), so one log with tests switched on and off gives one row per setting.
The second either side of a change is left out, and so is a tone test.

Usage:
    python3 scripts/bench_noise.py FLIPPER.csv BENCH_LOG.txt [more files...]
    python3 scripts/bench_noise.py --from 60 --to 600 BENCH_LOG.txt

--from/--to keep only that part of each file, in seconds from its start.

Compare like with like: the same resistor across the electrodes on both
devices. Noise grows with the reading, so a different resistor gives a
different number for reasons that have nothing to do with the device.
"""

import argparse
import csv
import math
import statistics
import sys

VALID_MIN_NS = 100.0  # below this a reading counts as open circuit (as in the firmware)
BLOCK = 10            # 100 ms rows per second
TONE_SECONDS = 4      # a tone test watches 3 s; its result arrives just after
BENCH_HEADER_START = "ms,ads_present,"
# The bench program prints its header only at start-up, so a log saved after
# that has none. Lines with exactly these columns are read with this header.
BENCH_COLUMNS = (
    "ms,ads_present,gsr_ns,raw_counts,zero_counts,pga,reads_per_s,ads_i2c_errors,"
    "pga_changes,max_gap_ms,noise_pp_ns,bias_mv,gps_locked,gps_good_per_s,"
    "gps_bad_per_s,gps_fix,gps_used,gps_heard,gps_in_view,gps_best_cno,"
    "gps_top4_cno,gps_hdop,gps_utc,gps_ttff_s,batt_mv,key_presses,"
    "bt,backlight,sd_mode,sd_write_ms,sd_sync_ms,tone_jump_ns,tone_settle_ms").split(",")
BL_TEXT = {"0": "screen off", "255": "backlight full"}
SD_TEXT = {"1": "plain", "2": "8 MB reserved", "3": "reserved, whole sectors", "4": "reserved, sectors, 40 MHz"}
BT_TEXT = {"0": "", "1": "Bluetooth advertising", "2": "Bluetooth sending"}


def percentile(vals, p):
    s = sorted(vals)
    k = (len(s) - 1) * p
    lo = math.floor(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def in_window(t, args):
    return (args.start is None or t >= args.start) and (args.end is None or t <= args.end)


def read_flipper(path, lines, args):
    rows = csv.DictReader(l for l in lines if not l.startswith("#"))
    if not rows.fieldnames or "gsr_raw" not in rows.fieldnames:
        return None
    vals = []
    for r in rows:
        try:
            t = float(r["timestamp"])
            v = float(r["gsr_raw"])
        except (TypeError, ValueError):
            continue
        if in_window(t, args):
            vals.append(v)
    noise, levels = [], []
    for i in range(0, len(vals) - BLOCK + 1, BLOCK):
        block = vals[i:i + BLOCK]
        if all(v >= VALID_MIN_NS for v in block):
            noise.append(max(block) - min(block))
            levels.append(sum(block) / BLOCK)
    return {"Flipper": (noise, levels)}, []


def setting_label(r):
    parts = []
    bt = BT_TEXT.get(r.get("bt") or "0", "")
    if bt:
        parts.append(bt)
    bl = r.get("backlight")
    if bl and bl != "128":
        parts.append(BL_TEXT.get(bl, f"backlight {bl}"))
    sd = r.get("sd_mode", "0")
    if sd and sd != "0":
        parts.append(f"SD writing ({SD_TEXT.get(sd, sd)})")
    return "Cardputer" + (": " + ", ".join(parts) if parts else ": all tests off")


def read_bench(path, lines, args):
    """Return per-setting (noise, levels), the tone results and SD write times."""
    header = BENCH_COLUMNS
    seconds = []
    sd_writes = {}  # mode -> [(total ms, save ms)]  # (t, label, noise or None, level, tone result or None)
    for line in lines:
        line = line.strip()
        if line.startswith(BENCH_HEADER_START):
            header = line.split(",")
            continue
        if not line or line.startswith("#"):
            continue
        fields = line.split(",")
        if len(fields) != len(header):
            continue  # a half-printed line or something that isn't the log
        r = dict(zip(header, fields))
        try:
            t = int(r["ms"]) / 1000.0
            gsr = float(r["gsr_ns"])
            noise = float(r["noise_pp_ns"])
        except ValueError:
            continue
        try:
            wr, mode = int(r.get("sd_write_ms") or 0), r.get("sd_mode", "0")
            if wr and mode != "0" and in_window(t, args):
                sd_writes.setdefault(mode, []).append((wr, int(r.get("sd_sync_ms") or 0)))
        except ValueError:
            pass
        tone = None
        if r.get("tone_jump_ns"):
            tone = (t, float(r["tone_jump_ns"]), int(r["tone_settle_ms"]))
        ok = not math.isnan(noise) and gsr >= VALID_MIN_NS and in_window(t, args)
        seconds.append((t, setting_label(r), noise if ok else None, gsr, tone))

    # Leave out the second either side of a setting change, and tone tests.
    skip = set()
    for i in range(1, len(seconds)):
        if seconds[i][1] != seconds[i - 1][1]:
            skip.update((i - 1, i))
    tones = []
    for i, s in enumerate(seconds):
        if s[4]:
            tones.append(s[4])
            skip.update(range(max(0, i - TONE_SECONDS), i + 1))

    groups = {}
    for i, (t, label, noise, gsr, _) in enumerate(seconds):
        if noise is None or i in skip:
            continue
        g = groups.setdefault(label, ([], []))
        g[0].append(noise)
        g[1].append(gsr)
    return groups, tones, sd_writes


def read_file(path, args):
    with open(path, errors="replace") as f:
        lines = f.read().splitlines()
    if any(l.startswith(BENCH_HEADER_START) or len(l.split(",")) == len(BENCH_COLUMNS) for l in lines):
        return read_bench(path, lines, args)
    got = read_flipper(path, lines, args)
    if got is None:
        sys.exit(f"{path}: not a bench log or a Flipper recording (no gsr_raw column)")
    return got + ({},)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--from", dest="start", type=float, help="ignore everything before this many seconds")
    ap.add_argument("--to", dest="end", type=float, help="ignore everything after this many seconds")
    args = ap.parse_args()

    rows, all_tones, all_sd = [], [], []
    for path in args.files:
        groups, tones, sd_writes = read_file(path, args)
        name = path.rsplit("/", 1)[-1]
        for label, (noise, levels) in groups.items():
            rows.append((name, label, noise, levels))
        all_tones += [(name,) + t for t in tones]
        all_sd += [(name, m, w) for m, w in sorted(sd_writes.items())]

    print("Noise = how far the 100 ms values spread within one second (nS, peak to peak).")
    print("Typical = the middle second; 9 in 10 = 9 out of 10 seconds are at or below this.\n")
    w = max([len(f"{n}  {l}") for n, l, _, _ in rows] + [10])
    print(f"{'File and setting':<{w}}  {'seconds':>7}  {'typical':>8}  {'9 in 10':>8}  {'worst':>7}  {'reading':>10}")
    for name, label, noise, levels in rows:
        if not noise:
            print(f"{name + '  ' + label:<{w}}  {0:>7}  (no seconds with all ten readings valid)")
            continue
        print(f"{name + '  ' + label:<{w}}  {len(noise):>7}  {statistics.median(noise):>8.2f}"
              f"  {percentile(noise, 0.9):>8.2f}  {max(noise):>7.2f}  {statistics.mean(levels):>7.0f} nS")

    means = [statistics.mean(l) for _, _, n, l in rows if n]
    if len(means) > 1 and (max(means) - min(means)) / min(means) > 0.05:
        print("\nWarning: the readings differ by more than 5%. Was the same resistor used?")
    if any(0 < len(n) < 60 for _, _, n, _ in rows):
        print("\nUnder a minute of data in some rows: run each setting for 2-3 minutes for a fair number.")

    if all_sd:
        print("\nSD card writes (one every 10 s; the Flipper pauses 20-60 ms for its write):")
        for name, mode, w in all_sd:
            tot = [x[0] for x in w]
            sav = [x[1] for x in w]
            print(f"  {name}  {SD_TEXT.get(mode, mode)}: {len(w)} writes, typical {statistics.median(tot):.0f} ms"
                  f" (saving {statistics.median(sav):.0f} ms of it), longest {max(tot)} ms")

    if all_tones:
        print("\nTone tests (the Flipper waits 200 ms after its chirp before trusting the GSR):")
        for name, t, jump, settle in all_tones:
            when = f"at {int(t // 60)}:{int(t % 60):02d}"
            if settle < 0:
                print(f"  {name} {when}: jumped {jump:.2f} nS, still not settled after 3 s")
            else:
                verdict = "within the 200 ms wait" if settle <= 200 else "LONGER than the 200 ms wait"
                print(f"  {name} {when}: jumped {jump:.2f} nS, settled {settle} ms after the chirp ({verdict})")


if __name__ == "__main__":
    main()
