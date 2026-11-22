#!/usr/bin/env python3
"""GSR noise check for bench recordings on a fixed test resistor.

Usage:
    python3 scripts/gsr_noise_check.py tracks/a.csv ["tracks/b c.csv" ...]

For each file it prints:
  - the reading, the ADC range the firmware will have used, and what one
    ADC step is worth in nS on that range
  - noise: standard deviation after removing a straight-line trend, the
    same without the SD-write rows, the 20-second-window figure (the
    calibration wizard's measure), and 30-second stretches
  - the once-a-second dip: rows lined up by their tenth of a second, the
    deepest slot, and how big chance alone would make it
  - the 10-second line-up: rows lined up by their place in each 10-second
    block, to tell a dip in every second from one in every tenth second
    (the Flipper's SD card write lands on the first row of each tenth
    second)
  - the slow wave: share of the noise slower than 0.1 Hz, and the
    strongest period between 12 and 40 s
  - jumps: sudden level changes that hold for a while
  - frozen rows: runs of nearly equal rows, as after a main-loop stall,
    with a separate look at the first SD write (10 s)
  - the window spread column (gsr_spread_ns), when the file has it, and
    how the hum and the reading move together

If the sensor was lost (an I2C failure or a zero reading), only the part
before it is used. Rows must be the firmware's 10 a second. Needs numpy.
Written up in docs/cardputer_gsr_noise_investigation.md.
"""
import sys

import numpy as np

ROW_S = 0.1
NORM = {2: 8, 3: 4, 4: 2, 5: 1}  # normalised counts per ADC step, by PGA index
LOW_THRESH = 4096                 # the autoranger's range-up threshold (ADC steps)
VOLTS_PER_COUNT = 7.8125e-6       # one normalised count at the ADC
JUMP_SIDE_ROWS = 15               # 1.5 s either side of a jump
JUMP_SIGMAS = 6                   # a jump must be this many times the step measure's own noise
FROZEN_NS = 0.2                   # rows this close count as "nearly equal" (files print 0.1 nS)


def load(path):
    bias_mv, names, rows = None, None, []
    for line in open(path):
        if line.startswith('#'):
            if 'GSR Bias' in line:
                bias_mv = float(line.split('used_mv:')[1].split(',')[0])
            continue
        if names is None:
            names = line.strip().split(',')
            continue
        v = line.strip().split(',')
        if len(v) == len(names):
            rows.append(v)
    cols = {name: np.array([float(r[i]) if r[i] else np.nan for r in rows])
            for i, name in enumerate(names)}
    return bias_mv, cols


def ns_from_counts(c, b):  # gsr_tia_counts_to_ns_at_bias() in core/gsr_sensor.h
    return c * 5e6 / (15.04e6 * b - 47.0 * c)


def counts_from_ns(g, b):
    return 15.04e6 * b * g / (5e6 + 47.0 * g)


def running_mean(x, k):
    pad = np.pad(x, (k // 2, k - 1 - k // 2), mode='edge')
    return np.convolve(pad, np.ones(k) / k, 'valid')


def detrended_sd(t, g):
    return (g - np.polyval(np.polyfit(t, g, 1), t)).std()


def runs_of(mask):
    """(start, length) of each run of True in a boolean array."""
    out, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            out.append((start, i - start))
            start = None
    if start is not None:
        out.append((start, len(mask) - start))
    return out


def cut_at_sensor_loss(cols):
    """Keep only the rows from before the sensor was lost, less 1 s."""
    t, g = cols['timestamp'], cols['gsr_raw']
    lost = g <= 0
    if 'i2c_consec_fail' in cols:
        lost |= cols['i2c_consec_fail'] > 0
    if not lost.any():
        return cols, None
    first = int(np.argmax(lost))
    keep = t < t[first] - 1.0
    return {k: v[keep] for k, v in cols.items()}, t[first]


def adc_step(g_mean, b):
    # A recording starts on PGA 2 and ranges up while the reading is under
    # LOW_THRESH steps (the calibration zero is ignored here: it is well
    # under 1 % of the reading on these resistors).
    counts = counts_from_ns(g_mean, b)
    pga = 2
    while pga < 5 and counts / NORM[pga] < LOW_THRESH:
        pga += 1
    ns_per_count = ns_from_counts(counts + 0.5, b) - ns_from_counts(counts - 0.5, b)
    return pga, ns_per_count


def report_noise(t, g, sec, slot):
    n = len(g)
    detr = g - np.polyval(np.polyfit(t, g, 1), t)
    # Without the first row of each tenth second (the Flipper's SD write)
    # and the first and last row (start and stop).
    keep = ~((sec % 10 == 0) & (slot == 0) & (sec > 0))
    keep[0] = keep[-1] = False
    print(f"  noise {detr.std():.2f} nS ({detr.std() / g.mean() * 100:.4f} % of the reading), "
          f"whole recording within {np.ptp(g):.1f} nS")
    print(f"  without the SD-write rows: {detrended_sd(t[keep], g[keep]):.2f} nS")
    w20 = [g[i:i + 200].std(ddof=1) for i in range(0, n - 199, 200)]
    if w20:
        print(f"  20 s windows: median {np.median(w20):.2f} nS (range {min(w20):.2f}-{max(w20):.2f})")
    w30 = [detrended_sd(t[m], g[m]) for s in range(0, int(t[-1]) - 29, 30)
           for m in [(t >= s) & (t < s + 30)]]
    if w30:
        print("  30 s stretches: " + ', '.join(f'{v:.2f}' for v in w30) + " nS")


def report_dips(t, g, sec, slot, quick):
    n = len(g)
    prof = np.array([quick[slot == k].mean() for k in range(10)])
    k = int(np.argmin(prof))
    dip = prof[k] - np.delete(prof, k).mean()
    chance = 2 * quick.std() / np.sqrt(n / 10)
    print(f"  quick noise {quick[slot != k].std():.2f} nS (dip slot left out)")
    print("  by tenth of a second: " + ' '.join(f'{v:+.2f}' for v in prof)
          + f"  (chance ±{chance:.2f})")
    verdict = "DIP" if dip < -2 * chance else "no clear dip"
    blocks = [quick[(t >= s) & (t < s + 30) & (slot == k)].mean() for s in range(0, int(t[-1]) - 29, 30)]
    print(f"  {verdict}: {dip:+.2f} nS at .{k} s; per 30 s: " + ' '.join(f'{v:+.1f}' for v in blocks))

    # The 10-second line-up: the same slot in the tenth second and in the
    # other nine. A dip in every second is the same in both; the Flipper's
    # SD write is only in the tenth.
    def cell(tenth, s):
        m = (slot == s) & (sec > 0) & ((sec % 10 == 0) if tenth else (sec % 10 != 0))
        return quick[m].mean(), 2 * quick.std() / np.sqrt(max(m.sum(), 1))

    sd_row, sd_chance = cell(True, 0)
    sd_other, _ = cell(False, 0)
    sd_verdict = "DIP EVERY 10 s" if sd_row - sd_other < -2 * sd_chance else "no 10 s dip"
    print(f"  SD-write row (first row of each tenth second): {sd_row:+.2f} nS, same slot in "
          f"other seconds {sd_other:+.2f} (chance ±{sd_chance:.2f}): {sd_verdict}")
    if verdict == "DIP":
        in_tenth, _ = cell(True, k)
        in_other, other_chance = cell(False, k)
        where = ("in every second" if in_other < -2 * other_chance
                 else "only in the tenth second, not every second")
        print(f"    the dip at .{k}: {in_tenth:+.2f} nS in the tenth second, "
              f"{in_other:+.2f} in the others: {where}")


def report_slow(t, detr):
    n = len(detr)
    x = detr - detr.mean()
    power = np.abs(np.fft.rfft(x * np.hanning(n))) ** 2
    f = np.fft.rfftfreq(n, ROW_S)
    slow_share = power[(f > 0) & (f < 0.1)].sum() / power[1:].sum() * 100
    periods = np.linspace(12, 40, 300)
    amps = [abs(np.sum(x * np.exp(-2j * np.pi * t / p))) * 2 / n for p in periods]
    i = int(np.argmax(amps))
    print(f"  slow wave: {slow_share:.0f} % of the noise is slower than 0.1 Hz; "
          f"strongest {periods[i]:.1f} s, amplitude {amps[i]:.2f} nS")


def report_jumps(t, g):
    # The step at each row: the median of the 1.5 s after it minus the
    # median of the 1.5 s before. Medians ignore single-row dips such as
    # the SD write. A jump is a step well above what the row-to-row noise
    # alone would give that measure (a median of k rows has about 1.25
    # times the spread of a mean). The row-to-row noise comes from the
    # median absolute difference, so dips and jumps barely move it. The
    # first and last second are left out.
    k = JUMP_SIDE_ROWS
    if len(g) < 4 * k:
        return
    med = np.median(np.lib.stride_tricks.sliding_window_view(g, k), axis=1)
    idx = np.arange(k, len(g) - k + 1)
    step = med[idx] - med[idx - k]
    d = np.diff(g)
    row_sd = 1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)
    thresh = JUMP_SIGMAS * 1.2533 * row_sd * np.sqrt(2 / k)
    inside = (t[idx] >= 1.0) & (t[idx] <= t[-1] - 1.0)
    big = (np.abs(step) > thresh) & inside
    events = []
    for start, length in runs_of(big):
        j = start + int(np.argmax(np.abs(step[start:start + length])))
        if events and idx[j] - events[-1][0] < 20:  # one event per 2 s
            if abs(step[j]) > abs(events[-1][1]):
                events[-1] = (idx[j], step[j])
            continue
        events.append((idx[j], step[j]))
    if not events:
        print(f"  jumps: none (over {thresh:.2f} nS)")
        return
    sizes = np.abs([e[1] for e in events])
    print(f"  jumps (over {thresh:.2f} nS): {len(events)}, "
          f"{sizes.min():.1f}-{sizes.max():.1f} nS = {sizes.min() / g.mean() * 100:.3f}-"
          f"{sizes.max() / g.mean() * 100:.3f} % of the reading")
    print("    at " + ', '.join(f'{t[i]:.1f} s ({s:+.1f})' for i, s in events))


def report_frozen(t, g, spread):
    # After a main-loop stall the missed rows are written back to back,
    # all averaging nearly the same window, so the rows barely change, and
    # neither does the hum column. Quiet stretches of real readings can
    # also sit within FROZEN_NS, but their hum column keeps changing. So
    # with the hum column, a run counts as frozen when the hum barely
    # moves too. Without it, p is how often two neighbouring rows are this
    # close in this file, and a run of L such pairs happens by chance with
    # odds of about p**L at any one place: a run counts when it would be
    # expected less than 0.05 times anywhere in the file, or, at the one
    # place chosen in advance (the first SD write), when its odds are
    # under 1 in 100.
    near = np.abs(np.diff(g)) <= FROZEN_NS + 1e-6  # rows print to 0.1 nS
    p = near.mean()
    runs = [(s, L) for s, L in runs_of(near) if L >= 3]
    if spread is not None:
        ds = np.abs(np.diff(spread))
        typical = np.median(ds)

        def frozen(s, L, anywhere):
            return ds[s:s + L].max() <= 0.25 * typical
    else:
        def frozen(s, L, anywhere):
            return ((len(near) - L) * p ** L < 0.05) if anywhere else (p ** L < 0.01)

    how = "hum column still too" if spread is not None else "no hum column, by chance odds"
    found = [(s, L) for s, L in runs if frozen(s, L, True)]
    if found:
        print(f"  frozen rows ({how}): "
              + ', '.join(f'{L + 1} rows from {t[s]:.1f} s' for s, L in found))
    else:
        print(f"  frozen rows: none ({how})")
    # The first SD write lands at 10 s, so a shorter run there still counts.
    at_write = [(s, L) for s, L in runs if t[s] <= 11.0 and t[s + L] >= 9.5]
    if not at_write:
        print("    at the first SD write: no run of nearly equal rows")
        return
    s, L = max(at_write, key=lambda r: r[1])
    detail = f"chance about {p ** L:.0e} at one place"
    if spread is not None:
        detail += (f"; hum column changes by at most {ds[s:s + L].max():.2f} nS "
                   f"(typical {typical:.2f})")
    verdict = "FROZEN" if frozen(s, L, False) else "could be chance"
    print(f"    at the first SD write: {L + 1} nearly equal rows from {t[s]:.1f} s, "
          f"{detail}: {verdict}")


def report_spread(g, spread, sec, slot, k_dip, ns_per_count, ns_per_step):
    sp = spread[~np.isnan(spread)]
    volts = sp.mean() / ns_per_count * VOLTS_PER_COUNT
    print(f"  spread: mean {sp.mean():.1f} nS (1-99 % {np.percentile(sp, 1):.1f}-"
          f"{np.percentile(sp, 99):.1f}) = {sp.mean() / ns_per_step:.1f} ADC steps "
          f"= {volts * 1e6:.0f} µV RMS at the ADC")
    print(f"    if it were random, rows would wobble ~{sp.mean() / np.sqrt(73):.1f} nS "
          f"(73 independent readings a window)")
    print(f"    at the dip slot {spread[slot == k_dip].mean():.2f} nS, "
          f"elsewhere {spread[slot != k_dip].mean():.2f} nS")
    # Hum and reading second by second, each with its trend removed.
    secs = range(int(sec.max()))
    hum = np.array([spread[sec == s].mean() for s in secs])
    rd = np.array([g[sec == s].mean() for s in secs])
    x = np.arange(len(hum))
    hum_d = hum - np.polyval(np.polyfit(x, hum, 1), x)
    rd_d = rd - np.polyval(np.polyfit(x, rd, 1), x)
    print(f"    second by second the hum varies ±{hum_d.std():.2f} nS; link with the "
          f"reading {np.corrcoef(hum_d, rd_d)[0, 1]:+.2f}")


def report(path):
    bias_mv, cols = load(path)
    cols, lost_at = cut_at_sensor_loss(cols)
    t, g = cols['timestamp'], cols['gsr_raw']
    spread = cols.get('gsr_spread_ns')
    if spread is not None and np.all(np.isnan(spread)):
        spread = None
    n = len(g)
    b = (bias_mv or 500.0) / 500.0
    print(f"{path}  ({n} rows, {t[-1]:.0f} s, bias {bias_mv} mV)")
    if lost_at is not None:
        print(f"  sensor lost at {lost_at:.1f} s: using the rows before {lost_at - 1.0:.1f} s")

    pga, ns_per_count = adc_step(g.mean(), b)
    ns_per_step = ns_per_count * NORM[pga]
    fsr = {2: '2.048', 3: '1.024', 4: '0.512', 5: '0.256'}[pga]
    print(f"  reading {g.mean():.1f} nS; ADC range ±{fsr} V, one ADC step = {ns_per_step:.2f} nS")

    slot = np.round((t / ROW_S) % 10).astype(int) % 10
    sec = np.floor(t + 1e-6).astype(int)
    quick = g - running_mean(g, 20)  # minus a 2 s running mean

    report_noise(t, g, sec, slot)
    report_dips(t, g, sec, slot, quick)
    report_slow(t, g - np.polyval(np.polyfit(t, g, 1), t))
    report_jumps(t, g)
    report_frozen(t, g, spread)
    if spread is not None:
        k_dip = int(np.argmin([quick[slot == k].mean() for k in range(10)]))
        report_spread(g, spread, sec, slot, k_dip, ns_per_count, ns_per_step)
    print()


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        report(p)
