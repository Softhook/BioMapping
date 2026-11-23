#!/usr/bin/env python3
"""
BioMapping GPS/GSR Track Analyzer
Usage: python3 scripts/analyze_track.py biomap_XXX.csv

Analyzes GPS quality metrics, GSR signal characteristics, and cross-track
comparisons.  Designed for rapid iteration during firmware and algorithm
development.
"""

import argparse
import csv
import math
from collections import Counter


def read_csv_rows(path):
    """Read a BioMapping track CSV into a list of row dicts.

    Tolerant of a stranded pre-allocated tail: an interrupted recording
    that never reached sd_logger_stop()'s truncate step (crash/battery
    pull/SD card removed) leaves the file padded out to
    SD_LOGGER_PREALLOC_BYTES with whatever undefined bytes were already on
    the SD card (the firmware's SD pre-allocation). Three
    precautions against that:
      - errors="replace" so a non-UTF-8 byte in that tail doesn't crash the
        whole read the way open()'s default strict decoding would.
      - csv.Error is caught per-row: the csv module raises this outright
        (independent of the decoding above) on things like an embedded NUL
        byte, which undefined tail content can easily contain.
      - stop at the first row whose column count doesn't match the header --
        garbage bytes won't happen to keep splitting into well-formed rows
        for long, so this reliably finds the real end of data instead of
        trying to parse megabytes of noise as CSV.
    Either failure is treated the same way: stop there, keep everything
    read so far.
    """
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [line for line in f if not line.strip().startswith('#')]

    if not lines:
        return []

    reader = csv.reader(lines)
    header = next(reader)
    rows = []
    while True:
        try:
            fields = next(reader)
        except (StopIteration, csv.Error):
            break
        if len(fields) != len(header):
            break
        rows.append(dict(zip(header, fields)))
    return rows


def num(row, key, kind=float):
    """A row's value as a number; 0 when the column is missing or blank."""
    return kind(row.get(key, '0') or '0')


# ── GSR statistics ────────────────────────────────────────────────────
def extract_valid_gsr(rows):
    """The gsr_raw values above 0 (0 or blank marks a row with no reading)."""
    vals = []
    for r in rows:
        try:
            v = num(r, 'gsr_raw')
        except (ValueError, TypeError):
            continue
        if v > 0:
            vals.append(v)
    return vals


def compute_basic_stats(vals):
    """Mean, standard deviation and CV% of a signal."""
    if len(vals) < 2:
        return 0.0, 0.0, 0.0
    mean = sum(vals) / len(vals)
    std = math.sqrt(sum((v - mean)**2 for v in vals) / len(vals))
    cv_pct = (std / mean * 100) if mean > 0 else 0.0
    return mean, std, cv_pct


def compute_diff_stats(vals):
    """Mean absolute and RMS change from one value to the next."""
    if len(vals) < 2:
        return 0.0, 0.0
    diffs = [vals[i] - vals[i-1] for i in range(1, len(vals))]
    mean_abs_d = sum(abs(d) for d in diffs) / len(diffs)
    diff_rms = math.sqrt(sum(d*d for d in diffs) / len(diffs))
    return mean_abs_d, diff_rms


def detect_outliers(vals, std, window=50):
    """How many values sit more than 3 sigma from their local median."""
    outliers = 0
    for i in range(window, len(vals) - window):
        local_sorted = sorted(vals[i-window:i+window+1])
        median = local_sorted[len(local_sorted)//2]
        if abs(vals[i] - median) > 3 * std:
            outliers += 1
    return outliers


# ── Reports ───────────────────────────────────────────────────────────
def analyze_gps(gps, total_rows):
    """Print a GPS quality report. gps: the rows that have a position."""
    if not gps:
        print("No GPS data found.")
        return

    hdops = [h for h in (num(r, 'hdop') for r in gps) if h > 0]
    pdops = [p for p in (num(r, 'pdop') for r in gps) if p > 0]
    spds = [num(r, 'speed_kts') for r in gps]
    sats = [s for s in (num(r, 'sats', int) for r in gps) if s > 0]

    print(f"GPS fixes: {len(gps)}")
    if total_rows:
        print(f"CSV rows: {total_rows} ({len(gps)/total_rows*100:.1f}% GPS density)")
    print(f"Time: {gps[0]['timestamp']} -> {gps[-1]['timestamp']}")

    if hdops:
        print(f"\nHDOP:  min={min(hdops):.1f}  max={max(hdops):.1f}  mean={sum(hdops)/len(hdops):.2f}")
    else:
        print("\nHDOP:  no HDOP data found")

    if pdops:
        print(f"PDOP:  min={min(pdops):.1f}  max={max(pdops):.1f}  mean={sum(pdops)/len(pdops):.2f}")

    if sats:
        print(f"Sats:  min={min(sats)}  max={max(sats)}  mean={sum(sats)/len(sats):.1f}")
    else:
        print("Sats:  no satellite data found")

    print(f"Speed: min={min(spds):.1f}  max={max(spds):.1f}  mean={sum(spds)/len(spds):.1f} kts")
    slow = sum(1 for s in spds if s * 0.514444 < 0.3)
    print(f"       Slow (<0.3 m/s): {slow}/{len(spds)} ({100*slow/len(spds):.1f}%)")

    # Spatial extent
    lats = [float(r['lat']) for r in gps]
    lons = [float(r['lon']) for r in gps]
    dlat = (max(lats) - min(lats)) * 111320
    dlon = (max(lons) - min(lons)) * 111320 * math.cos(math.radians(sum(lats) / len(lats)))
    spread = math.sqrt(dlat**2 + dlon**2)
    print(f"Area:  {spread:.0f}m  ({dlat:.0f}m NS x {dlon:.0f}m EW)")

    # Fix types
    ft = Counter(r.get('fix_type', '').strip() for r in gps if r.get('fix_type', '').strip())
    if ft:
        print(f"Fix:   {dict(ft)}")

    # HDOP distribution
    if hdops:
        print("\nHDOP distribution:")
        for lo, hi in [(0, 1.0), (1.0, 1.5), (1.5, 2.0), (2.0, 3.0), (3.0, 5.0), (5.0, 999)]:
            c = sum(1 for h in hdops if lo < h <= hi)
            label = f"{lo}-{hi}" if hi < 999 else f">{lo}"
            print(f"  {label:>8}: {c:4d} ({100*c/len(hdops):5.1f}%)")

    # Time-based HDOP/sats
    print("\nQuality over time (200-pt windows):")
    window = 200
    for w in range(0, len(gps), window):
        chunk = gps[w:w+window]
        hd = [h for h in (num(r, 'hdop') for r in chunk) if h > 0]
        st = [s for s in (num(r, 'sats', int) for r in chunk) if s > 0]
        ts = chunk[0]['timestamp'][11:19]
        hd_str = f"HDOP={min(hd):.1f}-{max(hd):.1f} avg={sum(hd)/len(hd):.1f}" if hd else "HDOP=N/A"
        st_str = f"sats={min(st)}-{max(st)} avg={sum(st)/len(st):.1f}" if st else "sats=N/A"
        print(f"  #{w:4d} {ts}  {hd_str}  {st_str}")


def analyze_gsr(rows):
    """Print GSR signal characteristics, for judging noise."""
    vals = extract_valid_gsr(rows)

    if len(vals) < 2:
        print("No GSR data found.")
        return

    print(f"\nGSR samples: {len(vals)}")
    print(f"Range: {min(vals):.1f} – {max(vals):.1f}")
    mean, std, cv_pct = compute_basic_stats(vals)
    print(f"Mean: {mean:.1f}")
    print(f"StdDev: {std:.1f}")
    print(f"Coefficient of variation: {cv_pct:.1f}%")

    # High-frequency noise
    mean_abs_d, diff_rms = compute_diff_stats(vals)
    print(f"Point-to-point delta: mean={mean_abs_d:.1f}  RMS={diff_rms:.1f}")

    outliers = detect_outliers(vals, std)
    print(f"Outliers (>3σ from local median): {outliers}/{len(vals)} ({100*outliers/len(vals):.2f}%)")


def compare_gsr_noise(path_a, label_a, path_b, label_b):
    """Compare GSR noise between two tracks (e.g. two hardware set-ups)."""
    print(f"\n{'='*60}")
    print(f"GSR NOISE COMPARISON: {label_a} vs {label_b}")
    print(f"{'='*60}")

    results = {}
    for path, label in [(path_a, label_a), (path_b, label_b)]:
        vals = extract_valid_gsr(read_csv_rows(path))
        if len(vals) < 2:
            print(f"\n{label}: not enough GSR data to compare")
            return
        mean, std, cv_pct = compute_basic_stats(vals)
        _, diff_rms = compute_diff_stats(vals)
        results[label] = {
            'samples': len(vals),
            'mean': mean, 'std': std,
            'cv_pct': cv_pct,
            'diff_rms': diff_rms,
            'range': max(vals) - min(vals)
        }

    print(f"\n  {'Metric':<23}  {'A':>10}  {'B':>20}    Δ%")
    print("-" * 64)

    for metric, fmt in [('samples', 'd'), ('mean', '.1f'), ('std', '.1f'),
                        ('cv_pct', '.1f'), ('diff_rms', '.1f'), ('range', '.1f')]:
        a = results[label_a][metric]
        b = results[label_b][metric]
        if a == 0:
            continue
        delta = (b - a) / a * 100
        arrow = "↑" if delta > 2 else "↓" if delta < -2 else "→"
        print(f"  {metric:<23}  {a:>10{fmt}}  {b:>20{fmt}}  {arrow} {delta:+.1f}%")

    a_cv = results[label_a]['cv_pct']
    b_cv = results[label_b]['cv_pct']
    a_dr = results[label_a]['diff_rms']
    b_dr = results[label_b]['diff_rms']
    print("\nInterpretation:")
    if b_cv > a_cv * 1.2:
        print(f"  ⚠ GSR noise (CV) is {b_cv/a_cv:.1f}x higher at {label_b} — possible electrical interference")
    elif b_cv < a_cv * 0.8:
        print(f"  ✓ GSR noise (CV) is LOWER at {label_b}")
    else:
        print("  → GSR noise (CV) is comparable")

    if b_dr > a_dr * 1.2:
        print(f"  ⚠ Point-to-point jitter is {b_dr/a_dr:.1f}x higher at {label_b}")
    elif b_dr < a_dr * 0.8:
        print(f"  ✓ Point-to-point jitter is LOWER at {label_b}")
    else:
        print("  → Point-to-point jitter is comparable")


# ── Main ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="BioMapping GPS/GSR Track Analyzer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Single track:
  python3 analyze_track.py biomap_001.csv
Two tracks (compares GSR noise):
  python3 analyze_track.py biomap_001.csv --compare biomap_002.csv
"""
    )
    parser.add_argument("track", help="Path to biomap_XXX.csv recording file")
    parser.add_argument("-c", "--compare", help="Path to second biomap_YYY.csv for GSR noise comparison")
    args = parser.parse_args()

    rows = read_csv_rows(args.track)
    print(f"\n{'='*60}")
    print(f"TRACK: {args.track}")
    print(f"{'='*60}")
    analyze_gps([r for r in rows if r.get('lat', '').strip()], len(rows))
    analyze_gsr(rows)

    if args.compare:
        compare_gsr_noise(args.track, f"{args.track} (A)", args.compare, f"{args.compare} (B)")


if __name__ == '__main__':
    main()
