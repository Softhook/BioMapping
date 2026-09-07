/**
 * Discrete Wavelet Transform (DWT) — Daubechies db3
 * ====================================================
 * db3 (Daubechies 6-tap wavelet) decomposes a signal into frequency-dyadic
 * sub-bands.  At each level k:
 *   Approximation A_k  =  0 … Fs/2^(k+1) Hz   (slow)
 *   Detail      D_k    =  Fs/2^(k+1) … Fs/2^k Hz  (fast)
 *
 * A self-contained wavelet library. NOT currently wired into the analysis
 * pipeline — kept for reuse. `denoise()` is translation-invariant wavelet
 * shrinkage: soft-thresholding the noise-dominated detail bands suppresses
 * broadband noise while leaving the approximation band (a signal's slow body)
 * untouched, so it disturbs sharp edges less than a wider linear low-pass
 * would. `decompose()` / `reconstructFull()` are the forward / inverse
 * transform on a mirror-padded, power-of-2 length; round-trip with all bands
 * recovers the original to machine precision.
 *
 * A/B tested against the plain 0.5 s moving-average low-pass on the real GSR
 * track corpus (2026-09): no measurable benefit for SCR peak detection, so it
 * was not adopted as a pipeline stage.
 */

const DWT = (() => {
  "use strict";

  // ── Daubechies db3 coefficients (EXACT PyWavelets values) ──────────────
  // Verified against pywt 'db3' — manual periodization forward DWT matches
  // pywt.dwt(x, 'db3', mode='periodization') to machine precision.
  //
  // Relationships:
  //   rec_lo[n] = dec_lo[N-1-n]  (time-reversed)
  //   dec_hi[n] = (-1)^(n+1) · dec_lo[N-1-n]
  //   rec_hi[n] = (-1)^n · dec_lo[n]
  //
  // All filters:   Σ = √2 (low-pass) or 0 (high-pass),  Σ² = 1
  //
  const DEC_LO = [    // analysis low-pass  (scaling function)
    0.0352262918857095,
   -0.0854412738820267,
   -0.1350110200102546,
    0.4598775021184915,
    0.8068915093110925,
    0.3326705529500826
  ];

  const DEC_HI = [    // analysis high-pass (wavelet function)
   -0.3326705529500826,
    0.8068915093110925,
   -0.4598775021184915,
   -0.1350110200102546,
    0.0854412738820267,
    0.0352262918857095
  ];

  const REC_LO = [    // synthesis low-pass  = reverse(DEC_LO)
    0.3326705529500826,
    0.8068915093110925,
    0.4598775021184915,
   -0.1350110200102546,
   -0.0854412738820267,
    0.0352262918857095
  ];

  const REC_HI = [    // synthesis high-pass = (-1)^n · DEC_LO[n]
    0.0352262918857095,
    0.0854412738820267,
   -0.1350110200102546,
   -0.4598775021184915,
    0.8068915093110925,
   -0.3326705529500826
  ];

  const Nf = DEC_LO.length;  // 6
  const HALF = Nf >>> 1;     // 3 (filter half-length)

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Proper modulo (not JS remainder) for positive wrap-around. */
  function _mod(idx, n) {
    return ((idx % n) + n) % n;
  }

  /**
   * Reflect an arbitrary integer index into [0, n-1] using symmetric
   * (whole-sample) reflection at both boundaries.
   *
   * Example for n=5: … 2 1 0|0 1 2 3 4|4 3 2 …
   *   idx:  -3 -2 -1  0 1 2 3 4  5 6 7
   *   out:   2  1  0  0 1 2 3 4  4 3 2
   */
  function _reflect(idx, n) {
    if (n <= 1) return 0;
    const period = 2 * n;
    const r = ((idx % period) + period) % period;
    return r < n ? r : period - 1 - r;
  }

  /**
   * Mirror-pad signal at both ends to absorb DWT boundary artifacts.
   * The padding is later trimmed after reconstruction.
   *
   * Two guarantees:
   *   1. padLen ≥ Nf × 2^(levels-1) — enough to contain the filter's
   *      boundary region at the deepest decomposition level.
   *   2. Total padded length is a multiple of 2^levels — required for
   *      periodization DWT (every intermediate cA must have even length).
   *
   * Uses symmetric (whole-sample) reflection so the padded signal is
   * continuous at the boundaries.
   */
  function _mirrorPad(signal, levels) {
    const n = signal.length;
    const minPad = Nf << (levels - 1);      // Nf * 2^(levels-1)
    const factor = 1 << levels;              // 2^levels

    // Find the smallest padLen ≥ minPad such that n + 2·padLen is a
    // multiple of 2^levels.  This guarantees every intermediate cA has
    // even length (since repeatedly halving a multiple of 2^levels
    // stays even until the last level).
    //
    // If n is odd, n + 2·padLen is always odd, which can never be a
    // multiple of an even factor.  In that case we make the right
    // padding one sample longer (asymmetric by one sample).
    let padLeft = minPad, padRight = minPad;
    let totalLen = n + padLeft + padRight;

    if (n % 2 === 0) {
      // n even → can use symmetric padding
      while (totalLen % factor !== 0) {
        padLeft++;
        padRight++;
        totalLen = n + padLeft + padRight;
      }
    } else {
      // n odd → need asymmetric padding (one side gets an extra sample)
      while (totalLen % factor !== 0) {
        padRight++;
        totalLen = n + padLeft + padRight;
        if (totalLen % factor === 0) break;
        padLeft++;
        totalLen = n + padLeft + padRight;
      }
    }

    const result = new Array(totalLen);

    // Left mirror pad (symmetric reflection)
    for (let i = 0; i < padLeft; i++) {
      result[i] = signal[_reflect(padLeft - 1 - i, n)];
    }

    // Original signal
    for (let i = 0; i < n; i++) {
      result[padLeft + i] = signal[i];
    }

    // Right mirror pad (symmetric reflection)
    for (let i = 0; i < padRight; i++) {
      result[padLeft + n + i] = signal[_reflect(n - 1 - i, n)];
    }

    return { data: result, padLen: padLeft, padRight };
  }

  /**
   * Single-level forward DWT with periodic boundary.
   * Implements pywt's periodization mode:
   *   cA[k] = Σⱼ DEC_LO[j] · x[(HALF + 2k - j) % n]
   *   cD[k] = Σⱼ DEC_HI[j] · x[(HALF + 2k - j) % n]
   *
   * Signal length n MUST be even.
   */
  function _forwardPass(signal) {
    const n = signal.length;
    const outLen = n >>> 1;
    const cA = new Float64Array(outLen);
    const cD = new Float64Array(outLen);

    for (let k = 0; k < outLen; k++) {
      let sA = 0, sD = 0;
      for (let j = 0; j < Nf; j++) {
        const idx = _mod(HALF + 2 * k - j, n);
        sA += DEC_LO[j] * signal[idx];
        sD += DEC_HI[j] * signal[idx];
      }
      cA[k] = sA;
      cD[k] = sD;
    }
    return { cA: Array.from(cA), cD: Array.from(cD) };
  }

  /**
   * Single-level inverse DWT with periodic boundary.
   *   x[(2k + j - HALF + 1) % n] += cA[k] · REC_LO[j] + cD[k] · REC_HI[j]
   */
  function _inversePass(cA, cD, n) {
    const result = new Float64Array(n);

    for (let k = 0; k < cA.length; k++) {
      for (let j = 0; j < Nf; j++) {
        const idx = _mod(2 * k + j - HALF + 1, n);
        result[idx] += cA[k] * REC_LO[j];
        result[idx] += cD[k] * REC_HI[j];
      }
    }
    return Array.from(result);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Multi-level forward DWT decomposition on a **mirror-padded** signal.
   * The padding absorbs boundary artifacts; callers trim after reconstruction.
   *
   * @param {number[]} signal
   * @param {number}   levels  (≥ 1)
   * @returns {{
   *   approximation: number[],     // cA at deepest level
   *   details:       number[][],   // [cD₁, cD₂, …, cD_L]
   *   originalLen:   number,       // original signal length (before pad)
   *   padLeft:       number,       // samples trimmed from left side
   *   padRight:      number        // samples trimmed from right side
   * }}
   */
  function decompose(signal, levels) {
    const originalLen = signal.length;

    // Mirror-pad to absorb boundary artifacts
    const { data: padded, padLen: padLeft, padRight } = _mirrorPad(signal, levels);

    // Padded length is guaranteed to be a multiple of 2^levels,
    // so every intermediate cA has even length — no per-level
    // evenness check needed.
    let current = padded;

    const details = [];
    for (let level = 0; level < levels; level++) {
      const { cA, cD } = _forwardPass(current);
      details.push(cD);
      current = cA;
    }

    return { approximation: current, details, originalLen, padLeft, padRight };
  }


  // ── Wavelet-shrinkage denoise (translation-invariant via cycle-spinning) ──

  function _median(arr) {
    if (arr.length === 0) return 0;
    const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
    const m = s.length >>> 1;
    return (s.length & 1) ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  /** Robust noise sigma from a detail band: MAD / 0.6745. */
  function _madSigma(detail) {
    const abs = new Array(detail.length);
    for (let i = 0; i < detail.length; i++) abs[i] = Math.abs(detail[i]);
    return _median(abs) / 0.6745;
  }

  /** Soft (shrinkage) threshold: pull toward zero by T, clamp at zero. */
  function _soft(x, T) {
    const a = Math.abs(x) - T;
    return a > 0 ? (x < 0 ? -a : a) : 0;
  }

  /** Circular shift: out[i] = a[(i - k) mod n]  (k > 0 shifts right). */
  function _roll(a, k) {
    const n = a.length;
    if (n === 0) return [];
    const s = ((k % n) + n) % n;
    if (s === 0) return Array.prototype.slice.call(a);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = a[(i - s + n) % n];
    return out;
  }

  /**
   * BayesShrink threshold for one detail band given the global noise sigma:
   *   T = σ² / σ_x ,  σ_x = sqrt(max(0, var(detail) − σ²))
   * A band whose variance does not exceed the noise floor carries no signal
   * and is killed outright (threshold above every coefficient).
   */
  function _bayesShrinkT(detail, sigma) {
    const n = detail.length;
    if (n === 0) return 0;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += detail[i];
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) { const d = detail[i] - mean; varSum += d * d; }
    const s2 = sigma * sigma;
    const sigX2 = (varSum / n) - s2;
    if (sigX2 <= 1e-12) {
      let mx = 0;
      for (let i = 0; i < n; i++) { const av = Math.abs(detail[i]); if (av > mx) mx = av; }
      return mx;
    }
    return s2 / Math.sqrt(sigX2);
  }

  /**
   * Multi-level inverse: feeds the (possibly thresholded) detail bands back
   * through _inversePass, then trims the mirror padding. Full inverse of
   * decompose() — with unmodified coeffs it round-trips to machine precision.
   *
   * @param {object} coeffs  result of decompose() (details may be modified)
   * @param {number} levels
   * @returns {number[]}  length = coeffs.originalLen
   */
  function reconstructFull(coeffs, levels) {
    let result = coeffs.approximation.slice();
    for (let level = levels - 1; level >= 0; level--) {
      const lenHere = result.length * 2;
      result = _inversePass(result, coeffs.details[level], lenHere);
    }
    const start = coeffs.padLeft;
    return result.slice(start, start + coeffs.originalLen);
  }

  /**
   * Translation-invariant wavelet-shrinkage denoise (db3, soft threshold,
   * per-band BayesShrink, cycle-spinning for shift-invariance).
   *
   * The approximation band (≤ ~0.3 Hz at 10 Hz — the SCR body + baseline) is
   * never touched, which keeps peak amplitudes intact; only the
   * noise-dominated detail bands are shrunk. 'light' shrinks D1–D2
   * (≥ ~1.25 Hz), 'strong' shrinks D1–D4 (≥ ~0.3 Hz) with heavier shrinkage
   * on D1–D2.
   *
   * @param {number[]} signal
   * @param {{sampleRate?: number, mode?: 'off'|'light'|'strong', shifts?: number}} [opts]
   * @returns {number[]}  same length as signal
   */
  function denoise(signal, opts) {
    opts = opts || {};
    const mode = opts.mode || 'off';
    const sampleRate = opts.sampleRate || 10;
    const n = signal ? signal.length : 0;
    if ((mode !== 'light' && mode !== 'strong') || n === 0) {
      return signal ? Array.prototype.slice.call(signal) : [];
    }

    // Frequency-anchor the depth so band edges stay fixed in Hz across sample
    // rates: the deepest detail band bottoms out near ~0.3 Hz. At 10 Hz → 4.
    const levels = Math.max(3, Math.min(6, Math.round(Math.log2(sampleRate / 0.6))));
    if (n < (1 << levels)) return Array.prototype.slice.call(signal);

    const cfg = (mode === 'strong')
      ? { bands: [1, 2, 3, 4], mult: (j) => (j <= 2 ? 1.6 : 1.0) }
      : { bands: [1, 2],       mult: () => 1.0 };

    const K = Math.max(1, (opts.shifts != null ? opts.shifts : 8) | 0);

    // Noise sigma: MAD of the finest detail band from the unshifted transform.
    const sigma = _madSigma(decompose(signal, levels).details[0]);
    if (!(sigma > 0)) return Array.prototype.slice.call(signal);

    const acc = new Float64Array(n);
    for (let s = 0; s < K; s++) {
      const c = decompose(_roll(signal, s), levels);
      for (let b = 0; b < cfg.bands.length; b++) {
        const j = cfg.bands[b];
        const d = c.details[j - 1];
        if (!d) continue;
        const T = _bayesShrinkT(d, sigma) * cfg.mult(j);
        for (let i = 0; i < d.length; i++) d[i] = _soft(d[i], T);
      }
      const rec = _roll(reconstructFull(c, levels), -s);
      for (let i = 0; i < n; i++) acc[i] += rec[i];
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = acc[i] / K;
    return out;
  }

  return { decompose, reconstructFull, denoise };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DWT;
}
if (typeof window !== 'undefined') {
  window.DWT = DWT;
}
