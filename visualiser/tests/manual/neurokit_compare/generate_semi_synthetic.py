#!/usr/bin/env python3
"""
Semi-Synthetic Ground-Truth Generator (generate_semi_synthetic.py)
-----------------------------------------------------------------
Creates realistic physiological EDA benchmark tracks using an authentic recorded
human walk (visualiser/fixtures/default_processed.csv) as the physical donor substrate.

Instead of artificial Gaussian noise, this semi-synthetic generator preserves:
1. Real Human Tonic Baseline & Thermal Drift from the donor recording.
2. Real Flipper Zero Hardware ADC Quantization Steps (0.1 nS resolution).
3. Real Edinburgh GPS walking coordinates, velocity, satellite DOP, and RF metadata.
4. Genuine mechanical micro-fluctuations and movement tremors.

Superimposed onto this donor substrate are mathematically known, physiologically advanced SCRs:
- Multi-burst sympathetic volleys with Peripheral Sweat-Gland Refractory Fatigue & Habituation.
- Bi-exponential recovery limbs (Two-Compartment Skin Model: fast duct evacuation + slow diffusion tail).
- Mechanical / Respiratory Pre-Inflection Notches ("Sigh Dips" preceding rises).
- Post-Stimulus Persistent Tonic Stepping (pore moisture retention).

Outputs:
  - synth_semi_real_demo.csv   (BioMapping-compatible CSV with full GPS route)
  - synth_semi_real_demo.json  (Exact ground-truth timestamps, amplitudes, and event metadata)
"""

import sys
import os
import json
import argparse
import numpy as np
import pandas as pd
from scipy.signal import butter, filtfilt

DEFAULT_DONOR_CSV = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '../../../fixtures/default_processed.csv')
)

def extract_donor_substrate(df, fs=10.0):
    """
    Extracts the clean donor substrate from a real recording:
    1. Converts raw Flipper sensor readings (nS) to microSiemens (uS).
    2. Separates authentic tonic drift and sensor noise floor from existing natural peaks.
    3. Reconstructs a clean physiological substrate retaining real thermal drift and ADC jitter.
    """
    gsr_raw_uS = df['gsr_raw'].to_numpy(dtype=np.float64) / 1000.0  # nS -> uS
    n = len(gsr_raw_uS)
    t = df['timestamp'].to_numpy(dtype=np.float64)

    # 1. Low-pass filter at 0.02 Hz to capture slow human thermal & hydration drift
    cutoff_hz = 0.02
    b, a = butter(2, cutoff_hz / (fs / 2.0), btype='low')
    # Pad reflection to eliminate edge transients
    pad_len = min(n - 1, int(30 * fs))
    tonic_drift = filtfilt(b, a, gsr_raw_uS, padlen=pad_len)

    # 2. Phasic residual (donor natural phasic activity + real sensor noise)
    phasic_donor = gsr_raw_uS - tonic_drift

    # 3. Suppress natural peaks (>0.03 uS) to leave only the real sensor noise floor & ADC steps
    # Running 10th-percentile over a 15-second window captures the true baseline trough
    win_samples = int(15.0 * fs)
    rolling_min = pd.Series(phasic_donor).rolling(win_samples, center=True, min_periods=1).quantile(0.10).to_numpy()
    
    # Detrended sensor floor / contact noise (genuine Flipper hardware ADC steps + contact micro-jitter)
    contact_noise = phasic_donor - rolling_min
    # Clip any large natural spikes to isolate the authentic noise floor (<0.025 uS)
    contact_noise = np.clip(contact_noise, -0.02, 0.02)
    # Remove any DC bias from clipping
    contact_noise -= np.mean(contact_noise)

    # Baseline substrate = slow real thermal drift + real contact/ADC noise
    substrate = tonic_drift + contact_noise
    return substrate, t, gsr_raw_uS

def generate_biexponential_scr(amplitude, rise_time=1.4, tau_fast=4.0, tau_slow=28.0, w_slow=0.20, fs=10.0):
    """
    Generates a realistic bi-exponential two-compartment SCR pulse:
    - Fast ductal clearance (tau_fast)
    - Slow stratum corneum moisture diffusion tail (tau_slow with weight w_slow)
    - Finite rise time from onset to apex
    """
    # Duration sufficient to capture the long diffusion tail
    duration = max(35.0, tau_slow * 1.6)
    dt = 1.0 / fs
    t_pulse = np.arange(0, duration, dt)
    
    # Sigmoidal onset rise (smooth biological ramp)
    tau_rise = rise_time / 2.5
    rise_factor = 1.0 - np.exp(-(t_pulse / tau_rise) ** 2)
    
    # Two-compartment recovery decay
    decay_curve = (1.0 - w_slow) * np.exp(-t_pulse / tau_fast) + w_slow * np.exp(-t_pulse / tau_slow)
    
    scr = rise_factor * decay_curve
    # Find true apex
    peak_idx = np.argmax(scr)
    max_val = scr[peak_idx]
    if max_val > 0:
        scr = (scr / max_val) * amplitude
        
    return scr, peak_idx, t_pulse

def build_semi_synthetic_track(donor_path=DEFAULT_DONOR_CSV, seed=42):
    """
    Builds the complete semi-synthetic track on top of the real demo recording.
    """
    rng = np.random.RandomState(seed)

    # Read the donor CSV, preserving header comments
    with open(donor_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
        
    comment_lines = [line for line in lines if line.startswith('#')]
    df = pd.read_csv(donor_path, comment='#')
    
    fs = 10.0
    total_samples = len(df)
    total_duration = df['timestamp'].iloc[-1]
    
    substrate, t_arr, _ = extract_donor_substrate(df, fs=fs)
    synthetic_eda = np.copy(substrate)
    
    injected_scrs = []
    
    # ── Define Structured Physiological Event Clusters ───────────────────────
    # We distribute varied physiological events across the ~1130s walk:
    # 1. Clean isolated textbook responses with variable rise kinetics.
    # 2. Multi-burst sympathetic volleys exhibiting biological refractory fatigue.
    # 3. Respiratory sigh pre-inflection dips.
    # 4. Large emotional jolts causing post-stimulus tonic baseline stepping.
    # 5. Low-slow subtle micro-responses near the detection boundary.
    
    # Scheduled cluster start times (spaced across the 1130s recording)
    cluster_schedule = [
        # (onset_time, cluster_type, base_amplitude)
        (35.0,   'isolated_standard',        0.45),
        (75.0,   'isolated_slow_rise',       0.30),
        (130.0,  'sigh_notched',             0.55),
        (185.0,  'multi_burst_doublet',      0.65),  # 2 bursts: 2nd habituated
        (250.0,  'tonic_step_jolt',          1.20),  # Large jolt with baseline step
        (320.0,  'low_slow_subtle',          0.055), # Boundary subtle response
        (370.0,  'multi_burst_triplet',      0.75),  # 3 rapid bursts with severe fatigue
        (440.0,  'isolated_standard',        0.40),
        (495.0,  'sigh_notched',             0.35),
        (560.0,  'multi_burst_doublet',      0.50),
        (630.0,  'low_slow_subtle',          0.065),
        (690.0,  'tonic_step_jolt',          1.40),  # Second large jolt with baseline reset
        (760.0,  'multi_burst_triplet',      0.80),
        (830.0,  'isolated_standard',        0.50),
        (890.0,  'sigh_notched',             0.40),
        (960.0,  'multi_burst_doublet',      0.55),
        (1030.0, 'low_slow_subtle',          0.060),
        (1080.0, 'isolated_standard',        0.35),
    ]

    for onset_sec, c_type, base_amp in cluster_schedule:
        onset_idx = int(round(onset_sec * fs))
        if onset_idx >= total_samples:
            continue
            
        if c_type in ('isolated_standard', 'isolated_slow_rise', 'low_slow_subtle'):
            rise_time = 2.4 if c_type == 'isolated_slow_rise' else (1.8 if c_type == 'low_slow_subtle' else 1.3)
            scr, p_idx, t_pulse = generate_biexponential_scr(
                amplitude=base_amp,
                rise_time=rise_time,
                tau_fast=4.5,
                tau_slow=30.0,
                w_slow=0.22,
                fs=fs
            )
            end_idx = min(total_samples, onset_idx + len(scr))
            synthetic_eda[onset_idx:end_idx] += scr[:end_idx - onset_idx]
            
            peak_time = t_arr[min(total_samples - 1, onset_idx + p_idx)]
            injected_scrs.append({
                'time': round(float(peak_time), 3),
                'amplitude': round(float(base_amp), 4),
                'rise_time': round(float(rise_time), 2),
                'type': c_type
            })

        elif c_type == 'sigh_notched':
            # Pre-inflection sigh notch: 0.03 uS negative deflection 0.3s before onset
            notch_duration_sec = 0.35
            notch_len = int(round(notch_duration_sec * fs))
            notch_start = max(0, onset_idx - notch_len)
            notch_t = np.linspace(0, np.pi, onset_idx - notch_start)
            notch_dip = 0.035 * np.sin(notch_t)
            synthetic_eda[notch_start:onset_idx] -= notch_dip
            
            # Followed immediately by sympathetic rise
            rise_time = 1.4
            scr, p_idx, _ = generate_biexponential_scr(
                amplitude=base_amp,
                rise_time=rise_time,
                tau_fast=4.0,
                tau_slow=28.0,
                fs=fs
            )
            end_idx = min(total_samples, onset_idx + len(scr))
            synthetic_eda[onset_idx:end_idx] += scr[:end_idx - onset_idx]
            
            peak_time = t_arr[min(total_samples - 1, onset_idx + p_idx)]
            injected_scrs.append({
                'time': round(float(peak_time), 3),
                'amplitude': round(float(base_amp), 4),
                'rise_time': round(float(rise_time), 2),
                'type': 'sigh_notched'
            })

        elif c_type == 'multi_burst_doublet':
            # Primary burst
            rise1 = 1.3
            scr1, p_idx1, _ = generate_biexponential_scr(base_amp, rise_time=rise1, fs=fs)
            end_idx1 = min(total_samples, onset_idx + len(scr1))
            synthetic_eda[onset_idx:end_idx1] += scr1[:end_idx1 - onset_idx]
            
            peak_time1 = t_arr[min(total_samples - 1, onset_idx + p_idx1)]
            injected_scrs.append({
                'time': round(float(peak_time1), 3),
                'amplitude': round(float(base_amp), 4),
                'rise_time': round(float(rise1), 2),
                'type': 'burst_primary'
            })
            
            # Secondary burst 1.3s later with 30% refractory fatigue (A2 = 0.70 * A1)
            gap_sec = 1.3
            onset_sec2 = onset_sec + gap_sec
            onset_idx2 = int(round(onset_sec2 * fs))
            amp2 = base_amp * 0.70
            rise2 = 1.1
            scr2, p_idx2, _ = generate_biexponential_scr(amp2, rise_time=rise2, fs=fs)
            end_idx2 = min(total_samples, onset_idx2 + len(scr2))
            synthetic_eda[onset_idx2:end_idx2] += scr2[:end_idx2 - onset_idx2]
            
            peak_time2 = t_arr[min(total_samples - 1, onset_idx2 + p_idx2)]
            injected_scrs.append({
                'time': round(float(peak_time2), 3),
                'amplitude': round(float(amp2), 4),
                'rise_time': round(float(rise2), 2),
                'type': 'burst_secondary_habituated'
            })

        elif c_type == 'multi_burst_triplet':
            # Primary burst
            rise1 = 1.2
            scr1, p_idx1, _ = generate_biexponential_scr(base_amp, rise_time=rise1, fs=fs)
            end_idx1 = min(total_samples, onset_idx + len(scr1))
            synthetic_eda[onset_idx:end_idx1] += scr1[:end_idx1 - onset_idx]
            injected_scrs.append({
                'time': round(float(t_arr[min(total_samples - 1, onset_idx + p_idx1)]), 3),
                'amplitude': round(float(base_amp), 4),
                'rise_time': round(float(rise1), 2),
                'type': 'burst_primary'
            })
            
            # 2nd burst: 1.2s gap, 30% fatigue (A2 = 0.70 * A1)
            onset_sec2 = onset_sec + 1.2
            onset_idx2 = int(round(onset_sec2 * fs))
            amp2 = base_amp * 0.70
            rise2 = 1.1
            scr2, p_idx2, _ = generate_biexponential_scr(amp2, rise_time=rise2, fs=fs)
            end_idx2 = min(total_samples, onset_idx2 + len(scr2))
            synthetic_eda[onset_idx2:end_idx2] += scr2[:end_idx2 - onset_idx2]
            injected_scrs.append({
                'time': round(float(t_arr[min(total_samples - 1, onset_idx2 + p_idx2)]), 3),
                'amplitude': round(float(amp2), 4),
                'rise_time': round(float(rise2), 2),
                'type': 'burst_secondary_habituated'
            })
            
            # 3rd burst: 1.5s after 2nd, 55% fatigue (A3 = 0.45 * A1)
            onset_sec3 = onset_sec2 + 1.5
            onset_idx3 = int(round(onset_sec3 * fs))
            amp3 = base_amp * 0.45
            rise3 = 1.0
            scr3, p_idx3, _ = generate_biexponential_scr(amp3, rise_time=rise3, fs=fs)
            end_idx3 = min(total_samples, onset_idx3 + len(scr3))
            synthetic_eda[onset_idx3:end_idx3] += scr3[:end_idx3 - onset_idx3]
            injected_scrs.append({
                'time': round(float(t_arr[min(total_samples - 1, onset_idx3 + p_idx3)]), 3),
                'amplitude': round(float(amp3), 4),
                'rise_time': round(float(rise3), 2),
                'type': 'burst_tertiary_habituated'
            })

        elif c_type == 'tonic_step_jolt':
            # Large surge + persistent post-stimulus baseline elevation (0.08 uS residual hydration)
            rise_time = 1.6
            scr, p_idx, _ = generate_biexponential_scr(
                amplitude=base_amp,
                rise_time=rise_time,
                tau_fast=5.5,
                tau_slow=40.0,
                w_slow=0.30,
                fs=fs
            )
            end_idx = min(total_samples, onset_idx + len(scr))
            synthetic_eda[onset_idx:end_idx] += scr[:end_idx - onset_idx]
            
            # Add persistent baseline step decaying over ~90 seconds
            step_amp = base_amp * 0.10
            step_duration = int(round(90.0 * fs))
            step_end = min(total_samples, onset_idx + step_duration)
            t_step = np.linspace(0, 90.0, step_end - onset_idx)
            synthetic_eda[onset_idx:step_end] += step_amp * np.exp(-t_step / 45.0)
            
            peak_time = t_arr[min(total_samples - 1, onset_idx + p_idx)]
            injected_scrs.append({
                'time': round(float(peak_time), 3),
                'amplitude': round(float(base_amp), 4),
                'rise_time': round(float(rise_time), 2),
                'type': 'tonic_step_jolt'
            })

    # Sort ground-truth SCRs chronologically
    injected_scrs.sort(key=lambda s: s['time'])

    # ── Re-apply Flipper Zero Hardware ADC Quantization ───────────────────────
    # The Flipper Zero hardware records conductance in nS with 0.1 nS resolution (0.0001 uS).
    # Convert synthetic uS back to nS and round to 1 decimal place (exact hardware step format).
    gsr_raw_ns_quantized = np.round(synthetic_eda * 1000.0, 1)
    df['gsr_raw'] = gsr_raw_ns_quantized

    metadata = {
        'params': {
            'donor_track': os.path.basename(donor_path),
            'duration': round(float(total_duration), 1),
            'scr_number': len(injected_scrs),
            'sampling_rate': fs,
            'features': [
                'real_human_donor_baseline',
                'flipper_hardware_adc_quantization',
                'biexponential_twocompartment_recovery',
                'refractory_fatigue_habituation',
                'respiratory_sigh_notches',
                'post_stimulus_tonic_stepping',
                'real_edinburgh_walking_gps_route'
            ]
        },
        'scrs': injected_scrs
    }
    
    return df, metadata, comment_lines

def main():
    parser = argparse.ArgumentParser(description="Generate Semi-Synthetic Ground Truth from Demo Track")
    parser.add_argument("output_dir", help="Directory where output .csv and .json will be written")
    parser.add_argument("--donor", default=DEFAULT_DONOR_CSV, help="Path to donor CSV file")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    stem = "synth_semi_real_demo"
    out_csv = os.path.join(args.output_dir, f"{stem}.csv")
    out_json = os.path.join(args.output_dir, f"{stem}.ground_truth.json")

    print(f"Loading donor track: {args.donor}...")
    df, metadata, comment_lines = build_semi_synthetic_track(donor_path=args.donor, seed=args.seed)
    
    print(f"Injecting {len(metadata['scrs'])} physiological events across {metadata['params']['duration']}s...")
    
    # Write CSV with comment headers
    with open(out_csv, 'w', encoding='utf-8') as f:
        for c in comment_lines:
            f.write(c)
        df.to_csv(f, index=False)
        
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2)

    print(f"Wrote semi-synthetic track: {out_csv}")
    print(f"Wrote ground-truth metadata: {out_json}")
    print(f"Successfully generated {len(metadata['scrs'])} ground-truth SCRs.")

if __name__ == '__main__':
    main()
