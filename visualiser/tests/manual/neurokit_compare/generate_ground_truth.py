"""
Ground-truth synthetic EDA tracks for a genuine "who's actually correct"
test - the one thing missing from every comparison so far in this
investigation, which only ever checked "does ours agree with NeuroKit2's",
never "does either one match a known answer".

Uses NeuroKit2's own canonical SCR generator (Bach et al. 2010's response
function, exactly as nk.eda_simulate() builds it) rather than a from-scratch
reimplementation, so the ground truth stays genuinely independent of both
BioMapping's and NeuroKit2's own peak-detection assumptions - neither
detector was tuned against this specific shape. This inlines
eda_simulate()'s own logic (see neurokit2/eda/eda_simulate.py) instead of
calling it directly, for one reason only: eda_simulate() doesn't return
where it put each SCR. Placing them ourselves - same canonical waveform
(_eda_simulate_scr), same additive superposition (signal_merge), same drift
+ noise model (signal_distort) - means we know the true peak time of every
injected response, which is the entire point of a ground-truth test.

Outputs, per track: a BioMapping-format CSV (timestamp,gsr_raw - the minimal
columns GSRCSVParser needs) and a ground-truth JSON (true peak times +
generation params), both under a directory this script's caller supplies.

Usage: python3 generate_ground_truth.py <output_dir>
       (normally invoked via check_ground_truth.sh, not directly)
"""
import json
import os
import sys

import numpy as np
import pandas as pd
from neurokit2.eda.eda_simulate import _eda_simulate_scr
from neurokit2.signal import signal_merge, signal_distort

# A handful of scenarios spanning noise/density/duration, echoing the
# variety in the 4 real biomap_* tracks this whole investigation already
# used, so results here are informative alongside the earlier findings.
SCENARIOS = [
    # drift kept small in magnitude - eda_simulate()'s own default (-0.01)
    # can drift the 1.0 baseline negative over a long duration (not
    # physically real conductance, though it's how NeuroKit2's generator
    # itself behaves too); small drift here avoids that confounding the
    # peak-detection test with an unrelated negative-value edge case.
    {'name': 'synth_sparse_clean', 'duration': 300, 'scr_number': 6, 'noise': 0.01, 'drift': 0.001, 'seed': 1},
    {'name': 'synth_sparse_noisy', 'duration': 300, 'scr_number': 6, 'noise': 0.05, 'drift': 0.001, 'seed': 2},
    {'name': 'synth_dense_clean', 'duration': 600, 'scr_number': 40, 'noise': 0.01, 'drift': 0.001, 'seed': 3},
    {'name': 'synth_dense_noisy', 'duration': 600, 'scr_number': 40, 'noise': 0.05, 'drift': 0.001, 'seed': 4},
]

OUTPUT_SAMPLING_RATE = 10   # match the real biomap_* tracks (10Hz)
GEN_SAMPLING_RATE = 100     # generate at this rate, then downsample - see below

# _eda_simulate_scr()'s canonical-shape formula (neurokit2/eda/eda_simulate.py)
# builds an internal time axis spanning a FIXED range (0 to 90) regardless of
# the sampling_rate argument, but only allocates 9*sampling_rate samples to
# resolve it. At NeuroKit2's own default (1000Hz) that's 9000 samples across
# that range - plenty. Called directly at BioMapping's real hardware rate
# (10Hz) it collapses to just 90 samples across the same 0-90 range: the
# Gaussian rise (std=0.7 in those same units) becomes severely under-resolved
# and the "SCR" it produces doesn't resemble one at all (confirmed: every
# detector on both sides, including NeuroKit2's own, scored near 0% recall
# against it - not a detector bug, a generator misuse). Fix: generate at a
# high rate NeuroKit2's own formula is actually designed for, then downsample
# to 10Hz afterward, the way any real acquisition pipeline would.


def generate_track(duration, scr_number, noise, drift, seed):
    """Mirrors nk.eda_simulate()'s own body exactly (see module docstring for
    why this isn't just a call to that function), tracking each SCR's true
    peak time as it's placed. Generates at GEN_SAMPLING_RATE; caller
    downsamples to OUTPUT_SAMPLING_RATE."""
    rng = np.random.default_rng(seed)
    sr = GEN_SAMPLING_RATE
    length = duration * sr

    eda = np.full(length, 1.0)
    eda += drift * np.linspace(0, duration, length)
    time = [0, duration]

    start_peaks = np.linspace(0, duration, scr_number, endpoint=False)
    true_peak_times = []

    for start_peak in start_peaks:
        relative_time_peak = float(np.abs(rng.normal(0, 5, size=1))[0] + 3.0745)
        scr = _eda_simulate_scr(sampling_rate=sr, time_peak=relative_time_peak)
        time_scr = [start_peak, start_peak + 9]
        # The true peak position is NOT simply start_peak + relative_time_peak:
        # _eda_simulate_scr()'s shape formula runs its own internal time axis
        # 0-90 regardless of sampling_rate, convolved with a one-sided decay
        # kernel that shifts the rendered peak further still - the actual
        # relationship isn't a simple closed form. Measuring it directly off
        # the generated array (before any truncation below) sidesteps that
        # entirely and is exact, not an approximation.
        true_time = start_peak + float(np.argmax(scr)) / sr

        if time_scr[0] < 0:
            scr = scr[int(np.round(np.abs(time_scr[0]) * sr)):]
            time_scr[0] = 0
        if time_scr[1] > duration:
            scr = scr[0:int(np.round((duration - time_scr[0]) * sr))]
            time_scr[1] = duration

        if 0 <= true_time <= duration:
            true_peak_times.append(true_time)

        eda = signal_merge(signal1=eda, signal2=scr, time1=time, time2=time_scr)

    if noise > 0:
        eda = signal_distort(
            eda,
            sampling_rate=sr,
            noise_amplitude=noise,
            noise_frequency=[0.5, 1, 3],
            noise_shape='laplace',
            silent=True,
            random_state=seed + 1000,
        )

    # Downsample GEN_SAMPLING_RATE -> OUTPUT_SAMPLING_RATE by plain linear
    # interpolation - deliberately simple (no anti-alias filter) since the
    # noise added above is already low-frequency (<=3Hz, well under the 5Hz
    # Nyquist at 10Hz output) and this test isn't about aliasing.
    t_gen = np.arange(length) / sr
    t_out = np.arange(0, duration, 1.0 / OUTPUT_SAMPLING_RATE)
    eda_out = np.interp(t_out, t_gen, eda)

    return eda_out, sorted(true_peak_times)


def main():
    if len(sys.argv) != 2:
        print('Usage: python3 generate_ground_truth.py <output_dir>', file=sys.stderr)
        sys.exit(1)
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)

    for scn in SCENARIOS:
        eda, true_peaks = generate_track(scn['duration'], scn['scr_number'], scn['noise'], scn['drift'], scn['seed'])
        n = len(eda)
        ts = np.arange(n) / OUTPUT_SAMPLING_RATE

        df = pd.DataFrame({'timestamp': ts, 'gsr_raw': eda})
        csv_path = os.path.join(out_dir, f"{scn['name']}.csv")
        df.to_csv(csv_path, index=False)

        gt_path = os.path.join(out_dir, f"{scn['name']}.ground_truth.json")
        json.dump({
            'sampling_rate': OUTPUT_SAMPLING_RATE,
            'n_samples': n,
            'true_peak_times': true_peaks,
            'params': scn,
        }, open(gt_path, 'w'))

        print(f"{scn['name']}: {n} samples, {len(true_peaks)} true SCRs -> {csv_path}", file=sys.stderr)


if __name__ == '__main__':
    main()
