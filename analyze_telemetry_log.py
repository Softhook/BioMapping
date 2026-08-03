#!/usr/bin/env python3
"""
Analyze BioMap serial telemetry logs.

Supports both older telemetry lines:
  telemetry tick_dt=... gps_drop=... flush=... fill=...

and newer lines with windowed diagnostics:
  telemetry tick_dt=... tick_max=... ovr150=... flush_last=... flush_max=...

Usage:
  python3 analyze_telemetry_log.py tracks/seriallog.txt
  python3 analyze_telemetry_log.py tracks/seriallog.txt --events 20
  python3 analyze_telemetry_log.py tracks/seriallog.txt --tick-threshold 150
"""

from __future__ import annotations

import argparse
import math
import re
from statistics import mean
from typing import Dict, Iterable, List, Tuple


TELEMETRY_RE = re.compile(r"(\d+)\s+\[[A-Z]\]\[BioMap\]\s+telemetry\s+(.*)$")
HEARTBEAT_RE = re.compile(r"(\d+)\s+\[[A-Z]\]\[BioMap\]\s+heartbeat\s+(.*)$")


def _parse_number(raw: str):
    raw = raw.strip().rstrip(",")
    if raw == "":
        return None
    try:
        if any(ch in raw for ch in ".eE"):
            return float(raw)
        return int(raw)
    except ValueError:
        return raw


def _parse_kv_blob(blob: str) -> Dict[str, object]:
    out: Dict[str, object] = {}
    for tok in blob.split():
        if "=" not in tok:
            continue
        key, value = tok.split("=", 1)
        out[key.strip()] = _parse_number(value)
    return out


def load_log(path: str) -> Tuple[List[Dict[str, object]], List[Dict[str, object]]]:
    telemetry: List[Dict[str, object]] = []
    heartbeat: List[Dict[str, object]] = []

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = TELEMETRY_RE.match(line)
            if m:
                ts_ms = int(m.group(1))
                fields = _parse_kv_blob(m.group(2))
                fields["ts_ms"] = ts_ms
                telemetry.append(fields)
                continue

            m = HEARTBEAT_RE.match(line)
            if m:
                ts_ms = int(m.group(1))
                fields = _parse_kv_blob(m.group(2))
                fields["ts_ms"] = ts_ms
                heartbeat.append(fields)

    return telemetry, heartbeat


def _numeric_series(rows: Iterable[Dict[str, object]], key: str) -> List[float]:
    vals: List[float] = []
    for row in rows:
        v = row.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            vals.append(float(v))
    return vals


def _percentile(sorted_vals: List[float], q: float) -> float:
    if not sorted_vals:
        return math.nan
    if q <= 0:
        return sorted_vals[0]
    if q >= 100:
        return sorted_vals[-1]
    pos = (len(sorted_vals) - 1) * (q / 100.0)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return sorted_vals[lo]
    frac = pos - lo
    return sorted_vals[lo] * (1.0 - frac) + sorted_vals[hi] * frac


def _stats(vals: List[float]) -> Dict[str, float]:
    if not vals:
        return {}
    s = sorted(vals)
    return {
        "min": s[0],
        "mean": mean(s),
        "p50": _percentile(s, 50),
        "p95": _percentile(s, 95),
        "p99": _percentile(s, 99),
        "max": s[-1],
    }


def _fmt(x: float) -> str:
    if math.isnan(x):
        return "nan"
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return f"{x:.2f}"


def _find_counter_jumps(rows: List[Dict[str, object]], key: str) -> List[Tuple[int, int, int]]:
    out: List[Tuple[int, int, int]] = []
    prev = None
    for row in rows:
        cur = row.get(key)
        if not isinstance(cur, (int, float)):
            continue
        cur_i = int(cur)
        if prev is not None and cur_i > prev:
            out.append((int(row["ts_ms"]), prev, cur_i))
        prev = cur_i
    return out


def _find_spikes(rows: List[Dict[str, object]], key: str, threshold: float) -> List[Tuple[int, float]]:
    out: List[Tuple[int, float]] = []
    for row in rows:
        v = row.get(key)
        if isinstance(v, (int, float)) and float(v) >= threshold:
            out.append((int(row["ts_ms"]), float(v)))
    return out


def print_summary(
    telemetry: List[Dict[str, object]],
    heartbeat: List[Dict[str, object]],
    event_limit: int,
    tick_threshold: float,
) -> None:
    print("=" * 72)
    print("BioMap Telemetry Log Summary")
    print("=" * 72)

    print(f"Telemetry rows: {len(telemetry)}")
    print(f"Heartbeat rows: {len(heartbeat)}")

    if telemetry:
        t0 = int(telemetry[0]["ts_ms"])
        t1 = int(telemetry[-1]["ts_ms"])
        dur_s = (t1 - t0) / 1000.0
        print(f"Telemetry span: {t0} -> {t1} ms ({dur_s:.1f}s)")

    if heartbeat:
        sd_dry_vals = sorted(set(int(v) for v in _numeric_series(heartbeat, "sd_dry")))
        if sd_dry_vals:
            print(f"Heartbeat sd_dry values: {sd_dry_vals}")

    if not telemetry:
        print("No telemetry rows found.")
        return

    print("\nCore distributions:")
    for key in [
        "tick_dt",
        "tick_max",
        "flush",
        "flush_last",
        "flush_max",
        "flush_peak",
        "fill",
        "peak",
        "gsr_hz",
    ]:
        vals = _numeric_series(telemetry, key)
        if not vals:
            continue
        st = _stats(vals)
        print(
            f"  {key:10s} min={_fmt(st['min']):>6s}"
            f" mean={_fmt(st['mean']):>6s}"
            f" p95={_fmt(st['p95']):>6s}"
            f" p99={_fmt(st['p99']):>6s}"
            f" max={_fmt(st['max']):>6s}"
        )

    print("\nCounter final values:")
    last = telemetry[-1]
    for key in [
        "gps_drop",
        "nmea_fail",
        "over",
        "flfail",
        "ovr150",
        "ovr250",
        "ovr500",
    ]:
        v = last.get(key)
        if isinstance(v, (int, float)):
            print(f"  {key:10s} {int(v)}")

    print("\nDetected events:")
    event_rows: List[str] = []

    for key in ["gps_drop", "nmea_fail", "over", "flfail", "ovr150", "ovr250", "ovr500"]:
        jumps = _find_counter_jumps(telemetry, key)
        for ts_ms, prev, cur in jumps:
            event_rows.append(f"{ts_ms:>10d} ms  counter {key} {prev}->{cur}")

    if _numeric_series(telemetry, "tick_max"):
        for ts_ms, v in _find_spikes(telemetry, "tick_max", tick_threshold):
            event_rows.append(f"{ts_ms:>10d} ms  tick_max spike {v:.1f} ms")
    else:
        for ts_ms, v in _find_spikes(telemetry, "tick_dt", tick_threshold):
            event_rows.append(f"{ts_ms:>10d} ms  tick_dt spike {v:.1f} ms")

    for key, label in [("flush_max", "flush_max"), ("flush_last", "flush_last"), ("flush", "flush")]:
        if _numeric_series(telemetry, key):
            for ts_ms, v in _find_spikes(telemetry, key, tick_threshold):
                event_rows.append(f"{ts_ms:>10d} ms  {label} spike {v:.1f} ms")
            break

    if not event_rows:
        print("  none")
    else:
        event_rows.sort()
        print(f"  showing first {min(event_limit, len(event_rows))} of {len(event_rows)}")
        for row in event_rows[:event_limit]:
            print("  " + row)


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze BioMap telemetry serial logs")
    parser.add_argument("log_path", help="Path to serial log text file")
    parser.add_argument("--events", type=int, default=25, help="Max events to print (default: 25)")
    parser.add_argument(
        "--tick-threshold",
        type=float,
        default=150.0,
        help="Spike threshold in ms for tick/flush events (default: 150)",
    )
    args = parser.parse_args()

    telemetry, heartbeat = load_log(args.log_path)
    print_summary(telemetry, heartbeat, max(1, args.events), args.tick_threshold)


if __name__ == "__main__":
    main()
