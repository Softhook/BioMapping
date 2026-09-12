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
+ noise model (signal_distort) - means we know the true peak time AND true
injected amplitude of every response, which is the entire point of a
ground-truth test.

Outputs, per track: a BioMapping-format CSV (timestamp,gsr_raw - the minimal
columns GSRCSVParser needs) and a ground-truth JSON (true peak time +
amplitude per SCR, plus generation params), both under a directory this
script's caller supplies.

Usage: python3 generate_ground_truth.py <output_dir>
       (normally invoked via check_ground_truth.sh, not directly)
"""
import argparse
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
    # Six paired responses 2.5s apart. This is the adversarial clean case for
    # refractory-period changes: the true events are close enough that a broad
    # merge can erase one, but remain individually labelled by construction.
    {'name': 'synth_compound_clean', 'duration': 360, 'scr_number': 12, 'noise': 0.01, 'drift': 0.001,
     'peak_starts': [20, 22.5, 75, 77.5, 130, 132.5, 185, 187.5, 240, 242.5, 295, 297.5], 'seed': 5},
    {'name': 'synth_compound_noisy', 'duration': 360, 'scr_number': 12, 'noise': 0.05, 'drift': 0.001,
     'peak_starts': [20, 22.5, 75, 77.5, 130, 132.5, 185, 187.5, 240, 242.5, 295, 297.5], 'seed': 7},
    # Low-amplitude, slower-rise responses represent the real-track physiological
    # class (calibrated against biomap_053: median amplitude 0.036 uS, median
    # rise time 1.5s, median onset slope 0.025 uS/s) that a candidate rejection
    # rule (such as a small-and-slow gate) must not silently discard.
    {'name': 'synth_low_slow_clean', 'duration': 360, 'scr_number': 12, 'noise': 0.01, 'drift': 0.001,
     'amplitude_range': (0.025, 0.2), 'scr_window_sec': 40, 'seed': 8},
    {'name': 'synth_low_slow_noisy', 'duration': 360, 'scr_number': 12, 'noise': 0.05, 'drift': 0.001,
     'amplitude_range': (0.025, 0.2), 'scr_window_sec': 40, 'seed': 9},
    # Isolates the walking-gait artefact the lpfWindow comment in constants.js
    # names as the reason the box LPF exists: real footstep impact, ~1.7Hz
    # (each leg strikes independently, so impact frequency runs ~2x stride
    # frequency - ~1.6-2.2Hz for a normal walking cadence). Verified against
    # real BioMapping recordings, not assumed - see
    # visualiser/tests/manual/gait_isolation/check_gait_isolation.js for the
    # methodology (a continuous sliding-window test correlating detrended
    # 1.4-2.0Hz band power against simultaneous GPS speed on a real track:
    # Pearson r=0.248, far past significance, with a monotonic dose-response
    # as pace increases) and the direct visual confirmation (a clean,
    # consistent ~0.6s peak spacing in the raw GSR trace).
    # 0.08uS matches "low-level motion tremor" (constants.js) - small next to
    # true SCR amplitudes (0.1-2.0uS) but well above peakThreshold (0.015uS),
    # so an unfiltered detector should mistake several tremor cycles for SCRs.
    {'name': 'synth_gait_tremor', 'duration': 300, 'scr_number': 6, 'noise': 0.01, 'drift': 0.001,
     'gait_freq': 1.7, 'gait_amplitude': 0.08, 'seed': 6},
    # Mirrors real-track walking gait: alternating stationary rest intervals
    # and variable-speed walking bouts (0.5m/s slow, 0.8m/s medium, 1.3m/s brisk).
    # Footstep impact frequency (1.1 + 0.6*v Hz) and tremor amplitude track walking
    # speed dynamically, allowing sliding-window gait-isolation tests to correlate
    # band power directly against simultaneous speed on ground truth.
    {'name': 'synth_walking_track', 'duration': 480, 'scr_number': 24, 'noise': 0.015, 'drift': 0.001,
     'walking_profile': True, 'seed': 42},
]

OUTPUT_SAMPLING_RATE = 10   # match the real biomap_* tracks (10Hz)
GEN_SAMPLING_RATE = 100     # generate at this rate, then downsample - see below

# _eda_simulate_scr() returns a shape normalized to peak=1.0 - every SCR
# eda_simulate() (NeuroKit2's own or ours below) ever injects is identical
# height unless scaled. That made timing-only ground truth possible but left
# no way to ask "did the detector get the SIZE right, not just the time" -
# each injected SCR is scaled by a random true amplitude drawn from this
# range instead. Range picked to span what check_relative_threshold.sh found
# across the 4 real biomap_* tracks (max prominence 0.12-4.57uS); log-uniform
# so small near-threshold responses (production peakThreshold=0.015uS) get
# equal footing with large ones instead of a linear draw burying them.
TRUE_AMPLITUDE_RANGE = (0.1, 2.0)  # uS

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
#
# SCR_WINDOW_SEC controls the SAME real-time-per-t-unit ratio, for a
# different reason: at the default `length=None` (-> 9*sampling_rate, i.e.
# always exactly a 9-SECOND pulse no matter what sampling_rate you pick -
# `length` and `sampling_rate` together are what map the fixed 0-90 t-axis
# onto real seconds, not sampling_rate alone), the resulting SCR's own
# onset-to-peak rise time - as measured by NeuroKit2's OWN eda_process()
# SCR_RiseTime, not a guess - is ~0.36s. That's ~5x narrower than BOTH the
# 0.75s/0.7s tauFast this project's two kernel-matched methods (SCRDeconvolution
# in analyzer.js, cvxeda.js) assume, AND the "responses rise over 1-3s"
# physiological assumption GSR_DEFAULT's own lpfWindow comment in
# constants.js is built on - discovered while investigating why matching-
# pursuit deconvolution scored WORSE on amplitude than the plain box filter
# on this ground truth (see check_filter_alternatives.js): its kernel was
# being matched against a pulse 5x narrower than what it was designed for,
# which would bias ANY kernel-shaped method regardless of implementation
# quality. Passing an explicit `length` longer than the default
# `9*sampling_rate` stretches the WHOLE canonical shape (rise, decay, and
# time_peak's effective position all scale together, since they're all
# expressed in the same t-units) to a realistic real-world duration without
# touching any of _eda_simulate_scr()'s own shape parameters - confirmed
# empirically: length=20*sampling_rate -> eda_process's own SCR_RiseTime
# lands at 0.74s, matching tauFast almost exactly.
SCR_WINDOW_SEC = 20


def generate_track(duration, scr_number, noise, drift, seed, gait_freq=0, gait_amplitude=0,
                   walking_profile=False, peak_starts=None, amplitude_range=TRUE_AMPLITUDE_RANGE,
                   scr_window_sec=SCR_WINDOW_SEC):
    """Mirrors nk.eda_simulate()'s own body exactly (see module docstring for
    why this isn't just a call to that function), tracking each SCR's true
    peak time as it's placed. Generates at GEN_SAMPLING_RATE; caller
    downsamples to OUTPUT_SAMPLING_RATE."""
    rng = np.random.default_rng(seed)
    sr = GEN_SAMPLING_RATE
    length = duration * sr
    t_full = np.arange(length) / sr

    # Build speed profile if walking scenario
    speed_ms = None
    if walking_profile:
        speed_ms = np.zeros(length)
        for i, t in enumerate(t_full):
            if 60 <= t < 180:
                speed_ms[i] = 0.8 + 0.1 * np.sin(2 * np.pi * 0.05 * t)
            elif 240 <= t < 360:
                speed_ms[i] = 1.3 + 0.15 * np.sin(2 * np.pi * 0.05 * t)
            elif 360 <= t < 420:
                speed_ms[i] = 0.5 + 0.08 * np.sin(2 * np.pi * 0.05 * t)

    eda = np.full(length, 1.0)
    eda += drift * np.linspace(0, duration, length)
    time = [0, duration]

    start_peaks = peak_starts if peak_starts is not None else np.linspace(
        10 if walking_profile else 0,
        duration - 20 if walking_profile else duration,
        scr_number,
        endpoint=False)
    true_scrs = []

    for start_peak in start_peaks:
        relative_time_peak = float(np.abs(rng.normal(0, 5, size=1))[0] + 3.0745)
        scr = _eda_simulate_scr(sampling_rate=sr, length=int(scr_window_sec * sr), time_peak=relative_time_peak)
        true_amplitude = float(np.exp(rng.uniform(np.log(amplitude_range[0]), np.log(amplitude_range[1]))))
        scr = scr * true_amplitude
        time_scr = [start_peak, start_peak + scr_window_sec]
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
            # true_amplitude is the INJECTED height, not necessarily what a
            # detector should measure in the merged signal: in the dense
            # scenario a response landing on a still-decaying predecessor's
            # tail sits on a raised local baseline, so its measured
            # peak-minus-onset amplitude legitimately reads higher than
            # true_amplitude alone - the same superposition effect real
            # overlapping SCRs produce, not a ground-truth error.
            true_scrs.append({'time': true_time, 'amplitude': true_amplitude})

        eda = signal_merge(signal1=eda, signal2=scr, time1=time, time2=time_scr)

    if walking_profile:
        # Gait oscillation: frequency and amplitude scale dynamically with walking speed
        inst_freq = np.where(speed_ms > 0.1, 1.1 + 0.6 * speed_ms, 0.0)
        inst_amp = np.where(speed_ms > 0.1, 0.07 * (speed_ms / 1.0), 0.0)
        phase = 2 * np.pi * np.cumsum(inst_freq) / sr
        eda += inst_amp * np.sin(phase)
    elif gait_freq > 0 and gait_amplitude > 0:
        # Slow amplitude wobble (0.05Hz, ~20s period) so it's not a pure tone
        # a naive fixed-frequency notch could null perfectly - real stride
        # amplitude varies with terrain/fatigue/pace changes.
        envelope = 1.0 + 0.3 * np.sin(2 * np.pi * 0.05 * t_full)
        eda += gait_amplitude * envelope * np.sin(2 * np.pi * gait_freq * t_full)

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
    speed_kts_out = None
    if speed_ms is not None:
        speed_ms_out = np.interp(t_out, t_gen, speed_ms)
        speed_kts_out = speed_ms_out / 0.514444

    return eda_out, speed_kts_out, sorted(true_scrs, key=lambda s: s['time'])


def parse_args():
    parser = argparse.ArgumentParser(description='Generate ground-truth synthetic EDA tracks.')
    parser.add_argument('output_dir', help='Directory to write CSV and JSON files to.')
    parser.add_argument('--num-seeds', type=int, default=int(os.environ.get('GROUND_TRUTH_NUM_SEEDS', '1')),
                        help='Number of seed realizations to generate per scenario (default: 1, or GROUND_TRUTH_NUM_SEEDS).')
    parser.add_argument('--seed-offset', type=int, default=int(os.environ.get('GROUND_TRUTH_SEED_OFFSET', '0')),
                        help='Seed offset added to base scenario seed (default: 0, or GROUND_TRUTH_SEED_OFFSET).')
    return parser.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)

    for scn in SCENARIOS:
        for s_idx in range(args.num_seeds):
            seed = scn['seed'] + s_idx * 1000 + args.seed_offset
            track_name = scn['name'] if args.num_seeds == 1 else f"{scn['name']}_s{s_idx + 1}"

            eda, speed_kts, true_scrs = generate_track(
                scn['duration'], scn['scr_number'], scn['noise'], scn['drift'], seed,
                gait_freq=scn.get('gait_freq', 0), gait_amplitude=scn.get('gait_amplitude', 0),
                walking_profile=scn.get('walking_profile', False), peak_starts=scn.get('peak_starts'),
                amplitude_range=scn.get('amplitude_range', TRUE_AMPLITUDE_RANGE),
                scr_window_sec=scn.get('scr_window_sec', SCR_WINDOW_SEC)
            )
            n = len(eda)
            ts = np.arange(n) / OUTPUT_SAMPLING_RATE

            data = {'timestamp': ts, 'gsr_raw': eda}
            if speed_kts is not None:
                data['speed_kts'] = speed_kts
            df = pd.DataFrame(data)
            csv_path = os.path.join(args.output_dir, f"{track_name}.csv")
            df.to_csv(csv_path, index=False)

            gt_path = os.path.join(args.output_dir, f"{track_name}.ground_truth.json")
            params = {**scn, 'seed': seed, 'seed_index': s_idx, 'seed_offset': args.seed_offset}
            json.dump({
                'sampling_rate': OUTPUT_SAMPLING_RATE,
                'n_samples': n,
                'scrs': true_scrs,
                'params': params,
            }, open(gt_path, 'w'))

            print(f"{track_name}: {n} samples, {len(true_scrs)} true SCRs -> {csv_path}", file=sys.stderr)


if __name__ == '__main__':
    main()
