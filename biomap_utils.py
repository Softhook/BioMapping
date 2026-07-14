import math

def extract_valid_gsr(rows):
    """Extract float GSR values > 0 from a list of CSV dict rows."""
    vals = []
    for r in rows:
        try:
            v = float(r.get('gsr_raw', '0') or '0')
            if v > 0:
                vals.append(v)
        except (ValueError, TypeError):
            pass
    return vals

def compute_basic_stats(vals):
    """Compute mean, std deviation, and CV% of a signal."""
    if len(vals) < 2:
        return 0.0, 0.0, 0.0
    mean = sum(vals) / len(vals)
    variance = sum((v - mean)**2 for v in vals) / len(vals)
    std = math.sqrt(variance)
    cv_pct = (std / mean * 100) if mean > 0 else 0.0
    return mean, std, cv_pct

def compute_diff_stats(vals):
    """Compute point-to-point differences, mean absolute delta, delta std, and RMS."""
    if len(vals) < 2:
        return [], [], 0.0, 0.0, 0.0
    diffs = [vals[i] - vals[i-1] for i in range(1, len(vals))]
    abs_diffs = [abs(d) for d in diffs]
    mean_abs_d = sum(abs_diffs) / len(abs_diffs) if abs_diffs else 0.0
    mean_diff = sum(diffs) / len(diffs) if diffs else 0.0
    delta_std = math.sqrt(sum((d - mean_diff)**2 for d in diffs) / len(diffs)) if diffs else 0.0
    diff_rms = math.sqrt(sum(d*d for d in diffs) / len(diffs)) if diffs else 0.0
    return diffs, abs_diffs, mean_abs_d, delta_std, diff_rms

def detect_outliers(vals, std, window=50):
    """Detect outliers (>3 sigma from local median)."""
    outliers = 0
    for i in range(window, len(vals) - window):
        local = vals[i-window:i+window+1]
        local_sorted = sorted(local)
        median = local_sorted[len(local_sorted)//2]
        if abs(vals[i] - median) > 3 * std:
            outliers += 1
    return outliers

def detect_spikes(vals, threshold=50):
    """Detect I2C spike-and-reverse anomalies."""
    spikes = 0
    for i in range(1, len(vals) - 1):
        d1 = vals[i] - vals[i-1]
        d2 = vals[i+1] - vals[i]
        if abs(d1) > threshold and abs(d2) > threshold and d1 * d2 < 0:
            spikes += 1
    return spikes

def compute_window_stds(vals, win_size=10):
    """Compute standard deviation in sliding windows."""
    wstds = []
    for i in range(0, len(vals) - (win_size - 1)):
        win = vals[i:i+win_size]
        wm = sum(win) / win_size
        wstds.append(math.sqrt(sum((v-wm)**2 for v in win) / win_size))
    return wstds

def find_flat_regions(vals, max_delta=15, min_run=10):
    """Identify regions with low tick-to-tick variation."""
    flat_regions = []
    in_flat = False
    flat_start = 0
    for i in range(1, len(vals)):
        if abs(vals[i] - vals[i-1]) < max_delta:
            if not in_flat:
                in_flat = True
                flat_start = i-1
        else:
            if in_flat:
                run = i - flat_start
                if run >= min_run:
                    flat_regions.append((flat_start, i))
                in_flat = False
    if in_flat:
        run = len(vals) - flat_start
        if run >= min_run:
            flat_regions.append((flat_start, len(vals)))
    return flat_regions

def compute_flat_stds(vals, flat_regions, min_run=10):
    """Compute standard deviation in identified flat regions."""
    flat_stds = []
    for a, b in flat_regions:
        win = vals[a:b]
        if len(win) >= min_run:
            wm = sum(win) / len(win)
            flat_stds.append(math.sqrt(sum((v-wm)**2 for v in win) / len(win)))
    return flat_stds
