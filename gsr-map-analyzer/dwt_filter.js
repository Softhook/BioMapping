/**
 * Discrete Wavelet Transform (DWT) — Daubechies db3
 * ====================================================
 * Used for tonic/phasic decomposition of GSR signals.
 *
 * Theory:
 *   db3 (Daubechies 6-tap wavelet) decomposes a signal into
 *   frequency-dyadic sub-bands.  At each level k:
 *     Approximation A_k  =  0 … Fs/2^(k+1) Hz   (slow / tonic)
 *     Detail      D_k    =  Fs/2^(k+1) … Fs/2^k Hz  (fast / phasic)
 *
 *   For a 10 Hz GSR recording (default level 6):
 *     A₆ = 0–0.078 Hz   →  Tonic SCL
 *     D₂+…+D₆ = 0.078–2.5 Hz  →  Phasic SCRs  (D₁ noise excluded)
 *
 * Strategy for clean GSR decomposition:
 *   The DWT is used ONLY for the tonic estimate (reconstructed from the
 *   approximation coefficients at the deepest level).  The phasic is then
 *   derived by subtraction:  phasic = signal − tonic.
 *
 *   This avoids the wavelet reconstruction ringing that contaminates a
 *   detail-only reconstruction, while still giving a vastly superior tonic
 *   baseline (no phase lag, no SCR bleed-through) compared to sliding-window
 *   methods.
 *
 * Boundary handling: periodic (wrap-around) at the nearest power-of-2 length.
 * This guarantees perfect reconstruction:  decompose → reconstruct (with all
 * components) yields the original signal to machine precision.
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

  /**
   * Reconstruct from approximation only (all details zeroed), then trim
   * the mirror padding to return the original-length signal.
   *
   * @param {object} coeffs  result of decompose()
   * @param {number} levels
   * @returns {number[]}  reconstructed signal, length = coeffs.originalLen
   */
  function reconstructFromApproximation(coeffs, levels) {
    let result = coeffs.approximation.slice();

    for (let level = levels - 1; level >= 0; level--) {
      const det = new Array(coeffs.details[level].length).fill(0);
      const lenHere = result.length * 2;
      result = _inversePass(result, det, lenHere);
    }

    // Trim mirror padding (may be asymmetric when original n was odd)
    const start = coeffs.padLeft;
    const end = start + coeffs.originalLen;
    return result.slice(start, end);
  }

  /**
   * GSR-specific tonic/phasic decomposition using DWT.
   *
   * Strategy:
   *   Tonic  = reconstruct from approximation at deepest level only
   *   Phasic = signal − tonic    (subtraction, NOT detail-only reconstruction)
   *
   * This avoids wavelet ringing while giving a vastly superior tonic
   * baseline compared to sliding-window methods (no phase lag, no SCR
   * bleed-through, frequency-based separation).
   *
   * @param {number[]} signal  GSR values at 10 Hz (µS)
   * @param {number}   [levels=4]
   * @returns {{ tonic: number[], phasic: number[] }}
   */
  function analyzeGSR(signal, levels) {
    if (!levels || levels < 1) levels = 6;

    const minLen = 1 << levels;  // 2^levels
    if (!signal || signal.length < minLen) {
      return {
        tonic: signal ? [...signal] : [],
        phasic: signal ? new Array(signal.length).fill(0) : []
      };
    }

    const n = signal.length;
    const coeffs = decompose(signal, levels);
    const tonic = reconstructFromApproximation(coeffs, levels);

    const phasic = new Array(n);
    for (let i = 0; i < n; i++) {
      // Phasic conductance cannot physically be negative — clamp to zero.
      // DWT subtraction may occasionally dip below zero near sharp transients
      // or at boundaries; this enforces the physiological constraint.
      phasic[i] = Math.max(0, signal[i] - tonic[i]);
    }

    return { tonic, phasic };
  }

  /**
   * Frequency band labels for display / tooltips.
   */
  function levelLabels(sampleRateHz, levels) {
    const labels = [];
    for (let k = 1; k <= levels; k++) {
      const lo = sampleRateHz / Math.pow(2, k + 1);
      const hi = sampleRateHz / Math.pow(2, k);
      labels.push({
        level: k,
        approxBand: `0–${lo.toFixed(2)} Hz`,
        detailBand: `${lo.toFixed(2)}–${hi.toFixed(2)} Hz`,
        isNoise: k === 1
      });
    }
    return labels;
  }

  return { decompose, reconstructFromApproximation, analyzeGSR, levelLabels };
})();
