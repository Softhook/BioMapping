"""
Batch REAL MATLAB-source Ledalab (github.com/ledalab/ledalab), run via GNU
Octave (free, no MATLAB license needed), for the detector-comparison
benchmark (see compare.js/check_ground_truth.js in this folder). Replaces
the earlier `run_ledapy.py`/`ledapy` (a third-party, unmaintained "partial
Python port" - see eda_detection_benchmark.md items 21-22) now that item 23
proved Octave can run Ledalab's own source directly and gives numerically
faithful results: this talks to the genuine toolbox, not a re-implementation
of unknown fidelity.

For each track CSV given on the command line, emits both:
  - `ledalab_peak_times`/`ledalab_peak_amplitudes` - Ledalab's own default
    CDA output (`optimize=0`, no pre-processing), matching Ledalab's
    out-of-the-box settings exactly. Known to be a bad comparator on its own
    (F1 ~0.09 on the clean synthetic suite - see item 23): naive point-
    deconvolution genuinely produces this many candidate peaks on noisy
    data before any significance criterion is applied.
  - `ledalab_lit_peak_times`/`ledalab_lit_peak_amplitudes` - the
    literature-tuned preset from item 22/23: a 4th-order Butterworth
    low-pass (0.5 Hz) applied before decomposition, `smoothwin_sdeco = 0.5`
    (vs. Ledalab's own 0.2 default), and a 0.1 uS floor on the reconvolved
    SCR amplitude - the same quantity Ledalab's own `export_scrlist.m`
    applies its own amplitude criterion to (confirmed via the actual
    MATLAB source, not guessed).

Requires:
  - GNU Octave (`brew install octave` on macOS) on PATH, or set
    OCTAVE_BIN=/path/to/octave.
  - A local clone of the real Ledalab source: `git clone
    https://github.com/ledalab/ledalab ~/ledalab`, or set LEDALAB_DIR to
    wherever it lives. One Octave-compatibility patch is needed in that
    clone (unrelated to the analysis itself - a settings-cache helper calls
    `prefdir(1)`, which Octave's `prefdir` doesn't accept an argument for):
    change `main/save_ledamem.m`'s `prefdir(1)` to `prefdir()`.

Manual/occasional script, not run in CI. Each invocation spawns one Octave
process (`ledalab_batch_run.m`) that processes every given track in a single
session, since Octave startup itself is the dominant cost otherwise.

Usage: python3 run_ledalab.py path/to/biomap_027.csv [more.csv ...]
       (normally invoked via run.sh/check_ground_truth.sh, not directly)
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd
from scipy.signal import butter, filtfilt

HERE = Path(__file__).resolve().parent
OCTAVE_BIN = os.environ.get('OCTAVE_BIN', 'octave-cli' if shutil.which('octave-cli') else 'octave')
LEDALAB_DIR = os.environ.get('LEDALAB_DIR', str(Path.home() / 'ledalab'))
LIT_PREFILTER_HZ = float(os.environ.get('LEDALAB_LIT_PREFILTER_HZ', '0.5'))
LIT_MIN_AMP = float(os.environ.get('LEDALAB_LIT_MIN_AMP', '0.1'))

RESISTANCE_MIN_AVG = 50000
MICROSIEMENS_MIN_AVG = 100
MICROSIEMENS_MAX_AVG = 50000


def to_microsiemens(raw_vals, header_name):
    avg_val = raw_vals.mean()
    header_lower = (header_name or '').lower()
    is_resistance_header = 'resistance' in header_lower or 'ohms' in header_lower
    if is_resistance_header or avg_val > RESISTANCE_MIN_AVG:
        return raw_vals.apply(lambda v: (1000000.0 / v) if v > 0 else 0.0)
    if MICROSIEMENS_MIN_AVG < avg_val <= MICROSIEMENS_MAX_AVG:
        return raw_vals / 1000.0
    return raw_vals


def load_pairs(csv_path):
    if not csv_path.exists():
        return []
    pairs = []
    with open(csv_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            t, a = line.split(',')
            pairs.append((float(t), float(a)))
    return pairs


CACHE_DIR = Path(os.environ.get('LEDALAB_CACHE_DIR', HERE / '.cache' / 'ledalab'))
NO_CACHE = os.environ.get('NO_CACHE') == '1'


def main():
    csv_paths = [Path(p) for p in sys.argv[1:]]
    if not csv_paths:
        print('Usage: python3 run_ledalab.py <track.csv> [more.csv ...]', file=sys.stderr)
        sys.exit(1)

    if shutil.which(OCTAVE_BIN) is None:
        print(f'octave not found ({OCTAVE_BIN}) - install with `brew install octave`', file=sys.stderr)
        sys.exit(1)
    if not (Path(LEDALAB_DIR) / 'Ledalab.m').exists():
        print(f'Real Ledalab source not found at {LEDALAB_DIR}/Ledalab.m - '
              f'clone it with `git clone https://github.com/ledalab/ledalab {LEDALAB_DIR}` '
              f'(see this script\'s docstring for the one Octave-compatibility patch it needs)',
              file=sys.stderr)
        sys.exit(1)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    pending_paths = []

    for idx, csv_path in enumerate(csv_paths, 1):
        name = csv_path.stem
        if csv_path.stat().st_size == 0:
            print(f'[{idx}/{len(csv_paths)}] Skipping empty {name}', file=sys.stderr)
            continue

        cache_file = CACHE_DIR / f'{name}.json'
        if not NO_CACHE and cache_file.exists() and cache_file.stat().st_mtime >= csv_path.stat().st_mtime:
            try:
                with open(cache_file, 'r') as f:
                    out[name] = json.load(f)
                if len(csv_paths) > 6:
                    print(f'[{idx}/{len(csv_paths)}] {name} (cached)', file=sys.stderr)
                continue
            except Exception:
                pass
        pending_paths.append(csv_path)

    if not pending_paths:
        json.dump(out, sys.stdout)
        return

    work_dir = Path(tempfile.mkdtemp(prefix='run_ledalab_'))
    names = []
    end_times = {}
    try:
        for csv_path in pending_paths:
            name = csv_path.stem
            print(f'Preparing {name} for Ledalab...', file=sys.stderr)
            try:
                df = pd.read_csv(csv_path, comment='#')
                eda = to_microsiemens(df['gsr_raw'].astype(float), 'gsr_raw').values
                ts = df['timestamp'].values
                if len(ts) > 0:
                    ts = ts - ts[0]
                dt = pd.Series(ts).diff()
                dt = dt[dt > 0]
                sr = 1.0 / dt.mean() if len(dt) else 10.0

                if len(df) < 50 or eda.std() < 1e-6:
                    print(f'  Skipping flat/tiny track {name} (N={len(df)}, std={eda.std():.2e})', file=sys.stderr)
                    track_res = {
                        'ledalab_peak_times': [],
                        'ledalab_peak_amplitudes': [],
                        'ledalab_lit_peak_times': [],
                        'ledalab_lit_peak_amplitudes': [],
                        'ledalab_lit_prefilter_hz': LIT_PREFILTER_HZ,
                        'ledalab_lit_min_amp': LIT_MIN_AMP,
                    }
                    out[name] = track_res
                    with open(CACHE_DIR / f'{name}.json', 'w') as f:
                        json.dump(track_res, f)
                    continue

                pd.DataFrame({'t': ts, 'eda': eda}).to_csv(
                    work_dir / f'{name}_raw.txt', sep='\t', header=False, index=False)

                filt_b, filt_a = butter(4, LIT_PREFILTER_HZ / (sr / 2), btype='low')
                eda_smoothed = filtfilt(filt_b, filt_a, eda)
                pd.DataFrame({'t': ts, 'eda': eda_smoothed}).to_csv(
                    work_dir / f'{name}_prefiltered.txt', sep='\t', header=False, index=False)

                names.append(name)
                end_times[name] = ts[-1] if len(ts) else 0.0
            except Exception as exc:  # noqa: BLE001 - report and continue the batch
                print(f'  FAILED to prepare {name}: {exc}', file=sys.stderr)

        if names:
            octave_cmd = (
                f"addpath('{HERE}'); "
                f"ledalab_batch_run('{LEDALAB_DIR}', '{work_dir}', '{','.join(names)}')"
            )
            print(f'Running real Ledalab (via Octave) over {len(names)} track(s)...', file=sys.stderr)
            result = subprocess.run(
                [OCTAVE_BIN, '--no-gui', '--eval', octave_cmd],
                capture_output=True, text=True, timeout=3600,
                cwd=work_dir,
            )
            for line in result.stdout.splitlines():
                print(f'  {line}', file=sys.stderr)
            if result.returncode != 0:
                print(f'octave exited {result.returncode}:\n{result.stderr}', file=sys.stderr)

            for name in names:
                default_pairs = load_pairs(work_dir / f'{name}_default_peaks.csv')
                tuned_pairs_all = load_pairs(work_dir / f'{name}_tuned_peaks.csv')
                end_t = end_times.get(name, 0.0)
                default_pairs = [(t, a) for t, a in default_pairs
                                  if math.isfinite(t) and math.isfinite(a) and 0 <= t <= end_t]
                tuned_pairs = [(t, a) for t, a in tuned_pairs_all
                                if math.isfinite(t) and math.isfinite(a) and 0 <= t <= end_t
                                and a >= LIT_MIN_AMP]
                track_res = {
                    'ledalab_peak_times': [p[0] for p in default_pairs],
                    'ledalab_peak_amplitudes': [p[1] for p in default_pairs],
                    'ledalab_lit_peak_times': [p[0] for p in tuned_pairs],
                    'ledalab_lit_peak_amplitudes': [p[1] for p in tuned_pairs],
                    'ledalab_lit_prefilter_hz': LIT_PREFILTER_HZ,
                    'ledalab_lit_min_amp': LIT_MIN_AMP,
                }
                out[name] = track_res
                with open(CACHE_DIR / f'{name}.json', 'w') as f:
                    json.dump(track_res, f)

        json.dump(out, sys.stdout)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == '__main__':
    main()
