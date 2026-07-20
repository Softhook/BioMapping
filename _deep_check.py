import csv, math

def load_gsr(path):
    rows = []
    with open(path) as f:
        for line in f:
            if line.startswith('#'): continue
            if line.startswith('timestamp'): continue
            parts = line.strip().split(',')
            if len(parts) >= 10:
                try:
                    gsr = float(parts[9])
                    if gsr > 0:
                        rows.append(gsr)
                except: pass
    return rows

gsr53 = load_gsr('tracks/biomap_053.csv')
gsr48 = load_gsr('tracks/biomap_048.csv')

# HIGH-RES DFT: scan 0.1-5.0 Hz with 0.01 Hz steps, 600-sample windows
# Use median of 5 different windows across the recording
print("=== High-resolution DFT (0.01 Hz steps, 5 windows, median amplitude) ===")

def dft_amp(data, freq, fs=10.0):
    N = len(data)
    xm = (N-1)/2.0
    ym = sum(data)/N
    num = sum((i-xm)*(data[i]-ym) for i in range(N))
    den = sum((i-xm)**2 for i in range(N))
    slope = num/den if den else 0
    intercept = ym - slope*xm
    w = [data[i] - (slope*i + intercept) for i in range(N)]
    omega = 2*math.pi*freq/fs
    re = sum(w[i]*math.cos(omega*i) for i in range(N))
    im = sum(w[i]*math.sin(omega*i) for i in range(N))
    return math.sqrt(re*re+im*im)/N*2

for label, data in [('048', gsr48), ('053', gsr53)]:
    n = len(data)
    windows = [n//5, n//4, n//3, 2*n//5, n//2]
    
    # Collect DFT amplitudes across all windows for each frequency
    all_peaks = []
    
    for freq_hz in [f/100.0 for f in range(10, 501)]:  # 0.1 to 5.0 Hz
        amps = []
        for ws in windows:
            w = data[ws:ws+600]
            if len(w) >= 600:
                amps.append(dft_amp(w, freq_hz))
        if amps:
            med = sorted(amps)[len(amps)//2]
            all_peaks.append((freq_hz, med))
    
    # Print top 20 peaks
    all_peaks.sort(key=lambda x: -x[1])
    print(f'\n{label} top DFT peaks (0.1-5.0 Hz):')
    for freq, amp in all_peaks[:25]:
        marker = ''
        if 0.8 <= freq <= 2.5:
            marker = ' <-- cardiac/walking band'
        if amp > 5:
            print(f'  {freq:.2f} Hz ({freq*60:.0f} BPM): {amp:.1f} nS{marker}')

# Also: full autocorrelation sweep for lags 1-100
print()
print("=== Full autocorrelation: lags 1-100 ===")
for label, data in [('048', gsr48), ('053', gsr53)]:
    n = len(data)
    start = n // 3
    window = data[start:start+600]
    wmean = sum(window) / len(window)
    
    # Find local maxima in autocorrelation
    ac = []
    for lag in range(1, 101):
        pairs = len(window) - lag
        sum_xy = sum((window[i]-wmean)*(window[i+lag]-wmean) for i in range(pairs))
        sum_xx = sum((window[i]-wmean)**2 for i in range(pairs))
        sum_yy = sum((window[i+lag]-wmean)**2 for i in range(pairs))
        r = sum_xy/math.sqrt(sum_xx*sum_yy) if sum_xx>0 and sum_yy>0 else 0
        ac.append(r)
    
    # Detect the "decay rate" — at what lag does r drop to 0.5?
    half_lag = next((i+1 for i, r in enumerate(ac) if r < 0.5), 100)
    
    print(f'{label}: autocorrelation half-life at lag {half_lag} ({half_lag/10:.1f}s)')
    
    # Look for bumps: where does second derivative indicate a local flattening?
    # Compare 053 vs 048 at lags 3-8 specifically
    print(f'  Lag 3-8 detail:')
    for lag in range(3, 9):
        print(f'    lag={lag} freq={10/lag:.2f}Hz r={ac[lag-1]:.4f}')

# Try a completely different approach: bandpass filter and look for zero-crossings
print()
print("=== Zero-crossing analysis (2nd-order difference as highpass) ===")
for label, data in [('048', gsr48), ('053', gsr53)]:
    # Second difference as a crude highpass (removes trend, leaves wiggle)
    d2 = [data[i+2] - 2*data[i+1] + data[i] for i in range(len(data)-2)]
    # Count zero crossings
    crossings = 0
    for i in range(1, len(d2)):
        if (d2[i] > 0 and d2[i-1] <= 0) or (d2[i] < 0 and d2[i-1] >= 0):
            crossings += 1
    # crossings per second
    hz_est = crossings / (len(data) / 10.0) / 2  # divide by 2 because each cycle has 2 crossings
    print(f'{label}: estimated dominant freq from zero-crossings: {hz_est:.2f} Hz')
    
    # Also: stdev of d2
    import statistics
    print(f'{label}: stdev of 2nd diff: {statistics.stdev(d2):.1f} nS')

# Finally: look at VERY specific windows that might show the pattern
# Try 5-second windows across the recording, compute DFT at each
print()
print("=== Scanning 5-second (50-tick) windows for periodic content ===")
for label, data in [('048', gsr48), ('053', gsr53)]:
    n = len(data)
    periodic_windows = 0
    best_freqs = []
    for start in range(0, n-50, 25):  # step by 2.5s
        w = data[start:start+50]
        # Check autocorrelation at lag corresponding to ~1-3 Hz
        wmean = sum(w)/len(w)
        ac_lags = {}
        for lag in [3, 4, 5, 6, 7, 8, 10]:
            pairs = 50 - lag
            sum_xy = sum((w[i]-wmean)*(w[i+lag]-wmean) for i in range(pairs))
            sum_xx = sum((w[i]-wmean)**2 for i in range(pairs))
            sum_yy = sum((w[i+lag]-wmean)**2 for i in range(pairs))
            r = sum_xy/math.sqrt(sum_xx*sum_yy) if sum_xx>0 and sum_yy>0 else 0
            ac_lags[lag] = r
        
        # Check if any lag has r > 0.3 while neighbors are lower
        for lag in [4, 5, 6, 7]:
            prev_r = ac_lags.get(lag-1, 0)
            next_r = ac_lags.get(lag+1, 0)
            curr_r = ac_lags[lag]
            if curr_r > 0.35 and curr_r > prev_r and curr_r > next_r:
                periodic_windows += 1
                best_freqs.append(10.0/lag)
    
    print(f'{label}: {periodic_windows}/{ (n-50)//25 } windows show periodic content')
    if best_freqs:
        from collections import Counter
        freq_counts = Counter(round(f, 1) for f in best_freqs)
        print(f'  Top frequencies: {freq_counts.most_common(5)}')
