#!/usr/bin/env python3
"""
BioMapping GPS/GSR Track Analyzer
Usage: python3 scripts/analyze_track.py biomap_XXX.csv

Analyzes GPS quality metrics, GSR signal characteristics, and cross-track
comparisons.  Designed for rapid iteration during firmware and algorithm
development.
"""

import csv, math, sys
from collections import defaultdict, Counter
from datetime import datetime
import biomap_utils


def read_csv_rows(path):
    """Read a BioMapping track CSV into a list of row dicts.

    Tolerant of a stranded pre-allocated tail: an interrupted recording
    that never reached sd_logger_stop()'s truncate step (crash/battery
    pull/SD card removed) leaves the file padded out to
    SD_LOGGER_PREALLOC_BYTES with whatever undefined bytes were already on
    the SD card (docs/archive/gps_rf_mutex_status.md, BIOMAP_SD_PREALLOC). Three
    precautions against that, mirroring analyze_telemetry_log.py's existing
    errors="replace" convention:
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
        except StopIteration:
            break
        except csv.Error:
            break
        if len(fields) != len(header):
            break
        rows.append(dict(zip(header, fields)))
    return rows


def load_gps_rows(path):
    """Return list of (csv_row_index, row_dict) for rows with GPS coordinates."""
    rows = read_csv_rows(path)
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

    if sats:
        print(f"Sats:  min={min(sats)}  max={max(sats)}  mean={sum(sats)/len(sats):.1f}")
    else:
        print("Sats:  no satellite data found")

    print(f"Speed: min={min(spds):.1f}  max={max(spds):.1f}  mean={sum(spds)/len(spds):.1f} kts")
    slow = sum(1 for s in spds if s * 0.514444 < 0.3)
    print(f"       Slow (<0.3 m/s): {slow}/{len(spds)} ({100*slow/len(spds):.1f}%)")

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
    vals = biomap_utils.extract_valid_gsr(rows)

    if len(vals) < 2:
        print("No GSR data found.")
        return

    print(f"\nGSR samples: {len(vals)}")
    print(f"Range: {min(vals):.1f} – {max(vals):.1f}")
    mean, std, cv_pct = biomap_utils.compute_basic_stats(vals)
    print(f"Mean: {mean:.1f}")
    print(f"StdDev: {std:.1f}")
    print(f"Coefficient of variation: {cv_pct:.1f}%")

    # High-frequency noise
    _, _, mean_abs_d, _, diff_rms = biomap_utils.compute_diff_stats(vals)
    print(f"Point-to-point delta: mean={mean_abs_d:.1f}  RMS={diff_rms:.1f}")

    # Detect outliers
    outliers = biomap_utils.detect_outliers(vals, std)
    print(f"Outliers (>3σ from local median): {outliers}/{len(vals)} ({100*outliers/len(vals):.2f}%)")

    return vals


def compare_gsr_noise(path_a, label_a, path_b, label_b):
    """Compare GSR noise between two tracks (e.g. different baud rates)."""
    print(f"\n{'='*60}")
    print(f"GSR NOISE COMPARISON: {label_a} vs {label_b}")
    print(f"{'='*60}")

    results = {}
    for path, label in [(path_a, label_a), (path_b, label_b)]:
        rows = read_csv_rows(path)
        vals = biomap_utils.extract_valid_gsr(rows)

        if len(vals) < 2: continue
        mean, std, cv_pct = biomap_utils.compute_basic_stats(vals)
        _, _, _, _, diff_rms = biomap_utils.compute_diff_stats(vals)

        results[label] = {
            'samples': len(vals),
            'mean': mean, 'std': std,
            'cv_pct': cv_pct,
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
def main():
    import argparse
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

    gps_rows, all_rows = load_gps_rows(args.track)
    print(f"\n{'='*60}")
    print(f"TRACK: {args.track}")
    print(f"{'='*60}")
    analyze_gps((gps_rows, all_rows))
    analyze_gsr(all_rows)

    if args.compare:
        compare_gsr_noise(args.track, f"{args.track} (A)", args.compare, f"{args.compare} (B)")

if __name__ == '__main__':
    main()

