#!/usr/bin/env python3
"""
BioMapping GPS/GSR Track Analyzer
Usage: python3 analyze_track.py biomap_XXX.csv

Analyzes GPS quality metrics, GSR signal characteristics, and cross-track
comparisons.  Designed for rapid iteration during firmware and algorithm
development.
"""

import csv, math, sys
from collections import defaultdict, Counter
from datetime import datetime


def load_gps_rows(path):
    """Return list of (csv_row_index, row_dict) for rows with GPS coordinates."""
    with open(path) as f:
        lines = [line for line in f if not line.strip().startswith('#')]
        rows = list(csv.DictReader(lines))
    return [(i, r) for i, r in enumerate(rows) if r.get('lat', '').strip()], rows


def analyze_gps(gps_rows):
    """Print comprehensive GPS quality report."""
    if isinstance(gps_rows, tuple):
        gps = gps_rows[0]
        total_csv = len(gps_rows[1])
    else:
        gps = gps_rows
        total_csv = 0

    if not gps:
        print("No GPS data found.")
        return

    hdops = [float(r.get('hdop', '0') or '0') for _, r in gps if float(r.get('hdop', '0') or '0') > 0]
    pdops = [float(r.get('pdop', '0') or '0') for _, r in gps if float(r.get('pdop', '0') or '0') > 0]
    spds = [float(r.get('speed_kts', '0') or '0') for _, r in gps]
    sats = [int(r.get('sats', '0') or '0') for _, r in gps if int(r.get('sats', '0') or '0') > 0]
    alts = [float(r.get('alt', '0') or '0') for _, r in gps if r.get('alt', '').strip()]
    wdops = [float(r.get('wdop', '0') or '0') for _, r in gps if float(r.get('wdop', '0') or '0') > 0]
    real_wdop = [w for w in wdops if w < 90]

    print(f"GPS fixes: {len(gps)}")
    if total_csv:
        print(f"CSV rows: {total_csv} ({len(gps)/total_csv*100:.1f}% GPS density)")
    print(f"Time: {gps[0][1]['timestamp']} -> {gps[-1][1]['timestamp']}")

    if hdops:
        print(f"\nHDOP:  min={min(hdops):.1f}  max={max(hdops):.1f}  mean={sum(hdops)/len(hdops):.2f}")
    else:
        print("\nHDOP:  no HDOP data found")

    if pdops:
        print(f"PDOP:  min={min(pdops):.1f}  max={max(pdops):.1f}  mean={sum(pdops)/len(pdops):.2f}")

    if real_wdop:
        print(f"WDOP:  min={min(real_wdop):.1f}  max={max(real_wdop):.1f}  mean={sum(real_wdop)/len(real_wdop):.2f}")
        stuck = sum(1 for w in wdops if w >= 90)
        if stuck > 0:
            print(f"       {stuck}/{len(wdops)} sentinel (99.9) — GSV data missing")

    if sats:
        print(f"Sats:  min={min(sats)}  max={max(sats)}  mean={sum(sats)/len(sats):.1f}")
    else:
        print("Sats:  no satellite data found")

    print(f"Speed: min={min(spds):.1f}  max={max(spds):.1f}  mean={sum(spds)/len(spds):.1f} kts")
    slow = sum(1 for s in spds if s * 0.514444 < 0.3)
    print(f"       Slow (<0.3 m/s): {slow}/{len(spds)} ({100*slow/len(spds):.1f}%)")

    if alts:
        print(f"Alt:   min={min(alts):.1f}  max={max(alts):.1f}  range={max(alts)-min(alts):.1f}m")

    # Spatial extent
    lats = [float(r['lat']) for _, r in gps]
    lons = [float(r['lon']) for _, r in gps]
    dlat = (max(lats) - min(lats)) * 111320
    dlon = (max(lons) - min(lons)) * 111320 * math.cos(math.radians(sum(lats) / len(lats)))
    spread = math.sqrt(dlat**2 + dlon**2)
    print(f"Area:  {spread:.0f}m  ({dlat:.0f}m NS x {dlon:.0f}m EW)")

    # Fix types
    ft = Counter(r.get('fix_type', '').strip() for _, r in gps if r.get('fix_type', '').strip())
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
        hd = [float(r.get('hdop', '0') or '0') for _, r in chunk if float(r.get('hdop', '0') or '0') > 0]
        st = [int(r.get('sats', '0') or '0') for _, r in chunk if int(r.get('sats', '0') or '0') > 0]
        ts = chunk[0][1]['timestamp'][11:19]
        hd_str = f"HDOP={min(hd):.1f}-{max(hd):.1f} avg={sum(hd)/len(hd):.1f}" if hd else "HDOP=N/A"
        st_str = f"sats={min(st)}-{max(st)} avg={sum(st)/len(st):.1f}" if st else "sats=N/A"
        print(f"  #{w:4d} {ts}  {hd_str}  {st_str}")

    return gps


def analyze_gsr(rows):
    """Analyze GSR signal characteristics for noise assessment."""
    vals = []
    for r in rows:
        try:
            v = float(r.get('gsr_raw', '0') or '0')
            if v > 0:
                vals.append(v)
        except:
            pass

    if len(vals) < 2:
        print("No GSR data found.")
        return

    print(f"\nGSR samples: {len(vals)}")
    print(f"Range: {min(vals):.1f} – {max(vals):.1f}")
    mean = sum(vals) / len(vals)
    print(f"Mean: {mean:.1f}")

    # Compute standard deviation
    variance = sum((v - mean)**2 for v in vals) / len(vals)
    std = math.sqrt(variance)
    print(f"StdDev: {std:.1f}")
    print(f"Coefficient of variation: {std/mean*100:.1f}%")

    # High-frequency noise: compute first-difference RMS
    diffs = [abs(vals[i] - vals[i-1]) for i in range(1, len(vals))]
    diff_rms = math.sqrt(sum(d*d for d in diffs) / len(diffs))
    diff_mean = sum(diffs) / len(diffs)
    print(f"Point-to-point delta: mean={diff_mean:.1f}  RMS={diff_rms:.1f}")

    # Detect outliers (>3 sigma from local median)
    window = 50
    outliers = 0
    for i in range(window, len(vals) - window):
        local = vals[i-window:i+window+1]
        local.sort()
        median = local[len(local)//2]
        if abs(vals[i] - median) > 3 * std:
            outliers += 1
    print(f"Outliers (>3σ from local median): {outliers}/{len(vals)} ({100*outliers/len(vals):.2f}%)")

    return vals


def compare_gsr_noise(path_a, label_a, path_b, label_b):
    """Compare GSR noise between two tracks (e.g. different baud rates)."""
    print(f"\n{'='*60}")
    print(f"GSR NOISE COMPARISON: {label_a} vs {label_b}")
    print(f"{'='*60}")

    results = {}
    for path, label in [(path_a, label_a), (path_b, label_b)]:
        with open(path) as f:
            rows = list(csv.DictReader(f))
        vals = []
        for r in rows:
            try:
                v = float(r.get('gsr_raw', '0') or '0')
                if v > 0: vals.append(v)
            except: pass

        if len(vals) < 2: continue
        mean = sum(vals) / len(vals)
        std = math.sqrt(sum((v-mean)**2 for v in vals) / len(vals))
        diffs = [abs(vals[i]-vals[i-1]) for i in range(1, len(vals))]
        diff_rms = math.sqrt(sum(d*d for d in diffs) / len(diffs))

        results[label] = {
            'samples': len(vals),
            'mean': mean, 'std': std,
            'cv_pct': std/mean*100,
            'diff_rms': diff_rms,
            'range': max(vals) - min(vals)
        }

    # Print comparison table
    print(f"\n{'Metric':<25} {'>'*10} {label_a:<20} {'>'*10} {label_b:<20} {'>'*10} Δ%")
    print("-" * 95)

    for metric, fmt in [('samples', 'd'), ('mean', '.1f'), ('std', '.1f'),
                          ('cv_pct', '.1f'), ('diff_rms', '.1f'), ('range', '.1f')]:
        a = results[label_a][metric]
        b = results[label_b][metric]
        if a == 0: continue
        delta = (b - a) / a * 100
        arrow = "↑" if delta > 2 else "↓" if delta < -2 else "→"
        a_str = f"{a:{fmt}}" if isinstance(a, float) else str(a)
        b_str = f"{b:{fmt}}" if isinstance(b, float) else str(b)
        print(f"  {metric:<23}  {a_str:>10}  {b_str:>20}  {arrow} {delta:+.1f}%")

    # Interpretation
    a_cv = results[label_a]['cv_pct']
    b_cv = results[label_b]['cv_pct']
    a_dr = results[label_a]['diff_rms']
    b_dr = results[label_b]['diff_rms']
    print(f"\nInterpretation:")
    if b_cv > a_cv * 1.2:
        print(f"  ⚠ GSR noise (CV) is {b_cv/a_cv:.1f}x higher at {label_b} — possible electrical interference")
    elif b_cv < a_cv * 0.8:
        print(f"  ✓ GSR noise (CV) is LOWER at {label_b}")
    else:
        print(f"  → GSR noise (CV) is comparable between baud rates")

    if b_dr > a_dr * 1.2:
        print(f"  ⚠ Point-to-point jitter is {b_dr/a_dr:.1f}x higher at {label_b}")
    elif b_dr < a_dr * 0.8:
        print(f"  ✓ Point-to-point jitter is LOWER at {label_b}")
    else:
        print(f"  → Point-to-point jitter is comparable")


# ── Main ──────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 analyze_track.py <biomap_XXX.csv> [compare_biomap_YYY.csv]")
        print("  Single track: full GPS + GSR analysis")
        print("  Two tracks:    compare GSR noise between them (e.g. baud rate test)")
        sys.exit(1)

    path = sys.argv[1]
    gps_rows, all_rows = load_gps_rows(path)
    print(f"\n{'='*60}")
    print(f"TRACK: {path}")
    print(f"{'='*60}")
    analyze_gps((gps_rows, all_rows))
    analyze_gsr(all_rows)

    if len(sys.argv) >= 3:
        compare_gsr_noise(path, f"{path} (9600 baud)", sys.argv[2], f"{sys.argv[2]} (115200 baud)")
