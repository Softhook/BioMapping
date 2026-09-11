"""
Regenerates tests/fixtures/cvxeda_reference.json — real ground truth from the
actual upstream `cvxEDA.py` reference (lciti/cvxEDA), used by
test_cvxeda_reference.js to check the JS interior-point solver against the
genuine article, not just against itself.

This is a manual/occasional script, not run in CI: it needs Python with
numpy + cvxopt (`pip install numpy cvxopt`) and network access to fetch the
current reference implementation from GitHub. Re-run it only if the fixture
needs regenerating (e.g. upstream changes its boundary handling again, or a
larger/different synthetic case is wanted).

Usage: python3 tests/manual/gen_cvxeda_reference.py
"""
import json
import sys
import urllib.request

import numpy as np

REF_URL = 'https://raw.githubusercontent.com/lciti/cvxEDA/main/python/cvxeda/cvxEDA.py'


def fetch_reference():
    src = urllib.request.urlopen(REF_URL, timeout=15).read().decode('utf-8')
    ns = {}
    exec(compile(src, 'cvxEDA_ref', 'exec'), ns)
    return ns['cvxEDA']


def bateman(t, t0, amp, tau1=0.7, tau0=2.0):
    out = np.zeros_like(t)
    mask = t > t0
    tt = t[mask] - t0
    out[mask] = amp * (np.exp(-tt / tau0) - np.exp(-tt / tau1))
    return out


def main():
    cvxEDA = fetch_reference()

    np.random.seed(42)
    sr = 10.0
    delta = 1.0 / sr
    n = 500

    t = np.arange(n) / sr
    y_raw = 2.0 + 0.3 * np.sin(t / 8.0) + 0.1 * (t / t[-1])
    for t0, amp in [(5.0, 1.2), (15.0, 0.8), (25.0, 1.5), (32.0, 0.5), (40.0, 0.3)]:
        y_raw = y_raw + bateman(t, t0, amp)
    y_raw = y_raw + 0.01 * np.sin(np.arange(n) * 1.9)  # deterministic pseudo-noise

    mean = y_raw.mean()
    std = y_raw.std(ddof=0)  # population std -- matches the JS's normalize:true convention
    y_z = (y_raw - mean) / std

    r, p, t_, l, d, e, obj = cvxEDA(y_z, delta, tau0=2.0, tau1=0.7, delta_knot=10.0,
                                     alpha=8e-4, gamma=1e-2)

    out = {
        'n': n, 'sr': sr,
        'y_z': y_z.tolist(),
        'r': r.tolist(), 'p': p.tolist(), 't': t_.tolist(),
        'l': l.tolist(), 'd': d.tolist(), 'e': e.tolist(), 'obj': float(np.ravel(obj)[0]),
    }
    out_path = 'tests/fixtures/cvxeda_reference.json'
    with open(out_path, 'w') as f:
        json.dump(out, f)
    print(f'wrote {out_path}: n={n}, nB={len(l)}, obj={out["obj"]:.6f}')


if __name__ == '__main__':
    sys.exit(main())
