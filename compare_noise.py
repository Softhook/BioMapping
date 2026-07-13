import csv, math

def load_csv(path):
    data = []
    with open(path) as f:
        lines = [line for line in f if not line.strip().startswith('#')]
        reader = csv.DictReader(lines)
        for row in reader:
            gsr = float(row['gsr_raw'])
            ts = row.get('timestamp','')
            data.append({'timestamp': ts, 'gsr_raw': gsr})
    return data

def analyze(label, data):
    n = len(data)
    gsr = [d['gsr_raw'] for d in data]
    first_nonzero = next((i for i,v in enumerate(gsr) if v > 0), 0)
    last_nonzero = next((i for i in range(n-1,-1,-1) if gsr[i] > 0), n-1)
    gsr_clean = gsr[first_nonzero:last_nonzero+1]
    n_clean = len(gsr_clean)

    diffs = [gsr_clean[i+1] - gsr_clean[i] for i in range(n_clean-1)]
    abs_diffs = [abs(d) for d in diffs]
    mean_abs_d = sum(abs_diffs)/len(abs_diffs)
    delta_std = math.sqrt(sum((d - sum(diffs)/len(diffs))**2 for d in diffs)/len(diffs))

    spikes = 0
    for i in range(1, n_clean-1):
        d1 = gsr_clean[i] - gsr_clean[i-1]
        d2 = gsr_clean[i+1] - gsr_clean[i]
        if abs(d1) > 50 and abs(d2) > 50 and d1 * d2 < 0:
            spikes += 1

    wstds = []
    for i in range(0, n_clean - 9):
        win = gsr_clean[i:i+10]
        wm = sum(win)/10
        wstds.append(math.sqrt(sum((v-wm)**2 for v in win)/10))

    flat_regions = []
    in_flat = False
    flat_start = 0
    for i in range(1, n_clean):
        if abs(gsr_clean[i] - gsr_clean[i-1]) < 15:
            if not in_flat:
                in_flat = True
                flat_start = i-1
        else:
            if in_flat:
                run = i - flat_start
                if run >= 10:
                    flat_regions.append((flat_start, i))
                in_flat = False
    if in_flat:
        run = n_clean - flat_start
        if run >= 10:
            flat_regions.append((flat_start, n_clean))

    flat_stds = []
    for a,b in flat_regions:
        win = gsr_clean[a:b]
        if len(win) >= 10:
            wm = sum(win)/len(win)
            flat_stds.append(math.sqrt(sum((v-wm)**2 for v in win)/len(win)))

    signal_range = max(gsr_clean) - min(gsr_clean)

    return {
        'label': label,
        'n_total': n,
        'n_clean': n_clean,
        'zeros': n - n_clean,
        'range': signal_range,
        'mean_abs_d': mean_abs_d,
        'delta_std': delta_std,
        'max_abs_d': max(abs_diffs),
        'spikes': spikes,
        'wstds_mean': sum(wstds)/len(wstds) if wstds else 0,
        'wstds_median': sorted(wstds)[len(wstds)//2] if wstds else 0,
        'wstds_p95': sorted(wstds)[int(len(wstds)*0.95)] if wstds else 0,
        'flat_mean': sum(flat_stds)/len(flat_stds) if flat_stds else 0,
        'flat_median': sorted(flat_stds)[len(flat_stds)//2] if flat_stds else 0,
        'flat_regions': len(flat_regions),
        'abs_diffs': abs_diffs,
        'gsr_clean': gsr_clean,
        'snr': signal_range / mean_abs_d if mean_abs_d > 0 else 0,
    }

pre  = analyze("PRE  (biomap_019 - 86-sample window)", load_csv('biomap_019.csv'))
post = analyze("POST (biomap_020 - 100-sample window)", load_csv('biomap_020.csv'))

print("=" * 72)
print("  SIDE-BY-SIDE: 86-sample vs 100-sample Oversampling")
print("=" * 72)

metrics = [
    ("Total rows in CSV",            "n_total",        "d",   ""),
    ("Clean samples (non-zero)",     "n_clean",        "d",   ""),
    ("Leading/trailing zeros",       "zeros",          "d",   ""),
    ("Signal range (nS)",            "range",          ".0f", ""),
    ("Mean |D| tick-to-tick (nS)",   "mean_abs_d",     ".1f", " <-- NOISE FLOOR"),
    ("Std of D (nS)",                "delta_std",      ".1f", ""),
    ("Max |D| (nS)",                 "max_abs_d",      ".1f", ""),
    ("I2C spike-and-reverse",        "spikes",         "d",   " <-- 0 = clean"),
    ("Mean 1s-window sigma (nS)",    "wstds_mean",     ".1f", ""),
    ("Median 1s-window sigma (nS)",  "wstds_median",   ".1f", ""),
    ("P95 1s-window sigma (nS)",     "wstds_p95",      ".1f", ""),
    ("Flat-region mean sigma (nS)",  "flat_mean",      ".1f", " <-- TRUE NOISE"),
    ("Flat-region median sigma (nS)","flat_median",    ".1f", ""),
    ("Flat regions found",           "flat_regions",   "d",   ""),
    ("SNR (range / noise)",          "snr",            ".0fx",""),
]

for name, key, fmt, note in metrics:
    v_pre = pre[key]
    v_post = post[key]
    change = ""
    if isinstance(v_pre, (int, float)) and isinstance(v_post, (int, float)) and v_pre != 0:
        pct = (v_post - v_pre) / v_pre * 100
        if abs(pct) > 0.5:
            arrow = "DOWN" if pct < 0 else "UP"
            change = "  %s %d%%" % (arrow, abs(pct))
    if fmt == "d":
        s = "  %10d  ->  %-10d%s   %s" % (v_pre, v_post, change, note)
    elif fmt == ".0f":
        s = "  %10.0f  ->  %-10.0f%s   %s" % (v_pre, v_post, change, note)
    elif fmt == ".0fx":
        s = "  %9.0fx  ->  %-9.0fx%s   %s" % (v_pre, v_post, change, note)
    else:
        s = "  %10.1f  ->  %-10.1f%s   %s" % (v_pre, v_post, change, note)
    print("  %-30s%s" % (name, s))

# |D| distribution
print()
print("=" * 72)
print("  |D| DISTRIBUTION COMPARISON")
print("=" * 72)
bins = [(0,5), (5,10), (10,20), (20,50), (50,100), (100,200), (200,500), (500,9999)]
print("  %12s  %8s  %8s  %8s" % ("Range", "PRE(86)", "POST(100)", "Change"))
print("  %12s  %8s  %8s  %8s" % ("-"*12, "-"*8, "-"*8, "-"*8))
for lo, hi in bins:
    c_pre  = sum(1 for d in pre['abs_diffs']  if lo <= d < hi)
    c_post = sum(1 for d in post['abs_diffs'] if lo <= d < hi)
    total_pre  = len(pre['abs_diffs'])
    total_post = len(post['abs_diffs'])
    pct_pre  = c_pre / total_pre * 100
    pct_post = c_post / total_post * 100
    label = ">=%d" % hi if hi == 9999 else "%d-%d" % (lo, hi)
    delta_pct = pct_post - pct_pre
    arrow = "UP" if delta_pct > 0 else "DOWN" if delta_pct < 0 else " "
    print("  %12s nS  %7.1f%%  %7.1f%%   %s%.1f%%" % (label, pct_pre, pct_post, arrow, abs(delta_pct)))

# Quiet-segment
print()
print("=" * 72)
print("  QUIET-SEGMENT NOISE (flat regions, no SCR contamination)")
print("=" * 72)
print("  PRE  (86-sample):  %.1f nS mean, %.1f nS median (%d regions)" % (
    pre['flat_mean'], pre['flat_median'], pre['flat_regions']))
print("  POST (100-sample): %.1f nS mean, %.1f nS median (%d regions)" % (
    post['flat_mean'], post['flat_median'], post['flat_regions']))
if pre['flat_mean'] > 0 and post['flat_mean'] > 0:
    improvement = (pre['flat_mean'] - post['flat_mean']) / pre['flat_mean'] * 100
    if improvement > 0:
        print("  -> True noise floor IMPROVED by %d%%" % improvement)
    elif improvement < 0:
        print("  -> True noise floor DEGRADED by %d%%" % abs(improvement))
    else:
        print("  -> No change")

# Tick noise
print()
print("=" * 72)
print("  TICK-TO-TICK NOISE (all samples, includes SCR edges)")
print("=" * 72)
print("  PRE  (86-sample):  %.1f nS mean |D|" % pre['mean_abs_d'])
print("  POST (100-sample): %.1f nS mean |D|" % post['mean_abs_d'])
if pre['mean_abs_d'] > 0:
    improvement = (pre['mean_abs_d'] - post['mean_abs_d']) / pre['mean_abs_d'] * 100
    if improvement > 0:
        print("  -> Tick noise IMPROVED by %d%%" % improvement)
    elif improvement < 0:
        print("  -> Tick noise DEGRADED by %d%%" % abs(improvement))

print()
print("=" * 72)
print("  VERDICT")
print("=" * 72)
print("  I2C glitches:     PRE=%d  POST=%d  (both clean)" % (pre['spikes'], post['spikes']))
print("  Tick noise mean:  %.1f -> %.1f nS" % (pre['mean_abs_d'], post['mean_abs_d']))
print("  Flat-region std:  %.1f -> %.1f nS" % (pre['flat_mean'], post['flat_mean']))
