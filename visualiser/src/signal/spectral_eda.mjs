/**
 * SpectralEDA — EDASymp (0.045–0.25 Hz) spectral sympathetic index.
 *
 * A pure, dependency-free module implementing the Posada-Quintero & Chon
 * (2016, 2020) frequency-domain sympathetic-arousal index as exposed by
 * NeuroKit2's `nk.eda_sympathetic(method='posada2016')`, plus a sliding-window
 * extension that turns the scalar index into a continuous per-sample series
 * for the graph / map colouring.
 *
 * Faithful to NeuroKit2's reference chain (verified against it in
 * tests/manual/neurokit_compare/check_edasymp.js — see
 * docs/edasymp_spectral_investigation_proposal.md):
 *
 *   1. Chebyshev Type I low-pass, order 8, 1 dB ripple, 0.8 Hz (forward).
 *   2. Chebyshev Type I low-pass, order 8, 0.05 dB ripple, 0.8 Hz (zero-phase
 *      filtfilt — mirrors scipy.signal.decimate's anti-alias stage).
 *   3. Decimate to 2 Hz.
 *   4. Butterworth high-pass, order 8, 0.01 Hz (zero-phase).
 *   5. Welch periodogram: nperseg = 128 (64 s @ 2 Hz), 50 % overlap, periodic
 *      Blackman window, nfft = 256, density scaling, mean averaging.
 *   6. Band power = trapezoidal integral of the PSD over [0.045, 0.25) Hz.
 *
 * The Chebyshev/Butterworth SOS designs here are bit-compatible with
 * scipy.signal.cheby1 / scipy.signal.butter (same magnitude response — see
 * the design notes on each helper). `sosfiltfilt` replicates scipy's odd
 * reflection padding and steady-state initial conditions so the edge
 * behaviour matches too.
 *
 * Exported as an ES module (`export const SpectralEDA = { ... }`), imported
 * directly by analyzer.mjs and live_entry.mjs.
 */
export const SpectralEDA = {
  // The published sympathetic band (Posada-Quintero 2016). Upper bound is
  // exclusive — NeuroKit2's _signal_power_instant_compute uses `f < 0.25`.
  BAND_HZ: [0.045, 0.25],

  // Sliding-window defaults for the continuous series (the scalar path always
  // uses NeuroKit2's exact nperseg=128 @ 2 Hz = 64 s, 50 % overlap).
  WINDOW_SEC: 64,
  HOP_SEC: 5,

  // ─────────────────────────────────────────────────────────────────────────
  // FFT (radix-2, in-place, complex). Only power-of-2 lengths are used here
  // (Welch nfft = 256), so no Bluestein fallback is needed.
  // ─────────────────────────────────────────────────────────────────────────
  _fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang),
        wIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let curRe = 1,
          curIm = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k,
            b = i + k + half;
          const uRe = re[a],
            uIm = im[a];
          const vRe = re[b] * curRe - im[b] * curIm;
          const vIm = re[b] * curIm + im[b] * curRe;
          re[a] = uRe + vRe;
          im[a] = uIm + vIm;
          re[b] = uRe - vRe;
          im[b] = uIm - vIm;
          const nRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nRe;
        }
      }
    }
  },

  /**
   * Periodic Blackman window (scipy.signal.windows.blackman(..., sym=False)).
   * @param {number} n - window length
   * @returns {Float64Array}
   */
  blackmanPeriodic(n) {
    const w = new Float64Array(n);
    const k = (2 * Math.PI) / n;
    const k2 = (4 * Math.PI) / n;
    for (let i = 0; i < n; i++) {
      w[i] = 0.42 - 0.5 * Math.cos(k * i) + 0.08 * Math.cos(k2 * i);
    }
    return w;
  },

  /** Sum of squared window coefficients — the Welch density normaliser. @private */
  _windowSumSq(win) {
    let s = 0;
    for (let i = 0; i < win.length; i++) s += win[i] * win[i];
    return s;
  },

  /**
   * One-sided PSD density scale: 2 / (fs · Σw²). DC and Nyquist bins are NOT
   * doubled by the consumers (they multiply by 0.5), matching scipy's
   * _fft_helper one-sided convention. @private
   */
  _densityScale(fs, winSumSq) {
    return 2.0 / (fs * winSumSq);
  },

  /**
   * Window one segment of `x` into `re`, zero-pad to `nfft`, and run the
   * in-place radix-2 FFT. `re`/`im` are caller-owned scratch buffers of length
   * `nfft` (reused across windows to avoid per-window allocation). @private
   */
  _fftSegment(x, start, nperseg, nfft, win, re, im) {
    for (let i = 0; i < nperseg; i++) re[i] = x[start + i] * win[i];
    for (let i = nperseg; i < nfft; i++) {
      re[i] = 0;
      im[i] = 0;
    }
    for (let i = 0; i < nperseg; i++) im[i] = 0;
    SpectralEDA._fftInPlace(re, im);
  },

  /**
   * Trapezoidal integral of a single-window one-sided PSD over [fLow, fHigh)
   * directly from the FFT result (no intermediate PSD array). Upper bound is
   * exclusive to match NeuroKit2's _signal_power_instant_compute. @private
   */
  _bandPowerFromFft(re, im, nfft, fs, scale, fLow, fHigh) {
    const half = nfft >> 1;
    let total = 0;
    let prevF = null,
      prevP = null;
    for (let k = 0; k <= half; k++) {
      const f = (k * fs) / nfft;
      if (f >= fLow && f < fHigh) {
        let p = (re[k] * re[k] + im[k] * im[k]) * scale;
        if (k === 0 || k === half) p *= 0.5; // undo one-sided doubling
        if (prevF !== null) total += (f - prevF) * (p + prevP) * 0.5;
        prevF = f;
        prevP = p;
      }
    }
    return total;
  },

  /**
   * Welch PSD estimate matching scipy.signal.welch with
   * scaling='density', detrend=False, average='mean', nfft=2*nperseg.
   *
   * @param {Array<number>|Float64Array} x - real signal
   * @param {number} fs - sampling rate
   * @param {{nperseg?:number, noverlap?:number, nfft?:number}} opts
   * @returns {{freq: Float64Array, psd: Float64Array}}
   */
  welchDensity(x, fs, opts = {}) {
    const nperseg = opts.nperseg || 128;
    const noverlap = opts.noverlap != null ? opts.noverlap : nperseg >> 1;
    const nfft = opts.nfft || 2 * nperseg;
    const n = x.length;

    const win = SpectralEDA.blackmanPeriodic(nperseg);
    const scale = SpectralEDA._densityScale(fs, SpectralEDA._windowSumSq(win));

    const step = nperseg - noverlap;
    const nSeg = step > 0 ? Math.floor((n - noverlap) / step) : 0;
    const nBins = (nfft >> 1) + 1;

    const freq = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) freq[k] = (k * fs) / nfft;

    const psd = new Float64Array(nBins);
    if (nSeg <= 0) return { freq, psd };

    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    const half = nfft >> 1;

    for (let seg = 0; seg < nSeg; seg++) {
      SpectralEDA._fftSegment(x, seg * step, nperseg, nfft, win, re, im);
      for (let k = 0; k < nBins; k++) {
        let p = (re[k] * re[k] + im[k] * im[k]) * scale;
        if (k === 0 || k === half) p *= 0.5; // undo one-sided doubling
        psd[k] += p;
      }
    }
    for (let k = 0; k < nBins; k++) psd[k] /= nSeg;
    return { freq, psd };
  },

  /**
   * Trapezoidal integral of psd over [fLow, fHigh) — mirrors
   * neurokit2.signal.signal_power._signal_power_instant_compute
   * (np.trapezoid, upper bound exclusive, NaN when the power is 0).
   */
  trapzBand(psd, freq, fLow, fHigh) {
    let total = 0;
    let prevF = null,
      prevP = null;
    let any = false;
    for (let k = 0; k < freq.length; k++) {
      const f = freq[k];
      if (f >= fLow && f < fHigh) {
        any = true;
        if (prevF !== null) total += (f - prevF) * (psd[k] + prevP) * 0.5;
        prevF = f;
        prevP = psd[k];
      }
    }
    if (!any) return 0;
    return total === 0 ? NaN : total;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // IIR filter design (bilinear transform, SOS biquads)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Chebyshev Type I low-pass, return second-order sections [b0,b1,b2,a0,a1,a2].
   * Bit-compatible with scipy.signal.cheby1(order, rp, cutoff, 'lowpass',
   * fs=fs, output='sos') — verified against scipy.signal.sosfreqz across the
   * whole Nyquist range (ratio == 1.0 at every probe frequency).
   *
   * @param {number} order - filter order (even)
   * @param {number} rpDb - passband ripple in dB
   * @param {number} cutoffHz - digital cutoff (-rpDb point) in Hz
   * @param {number} fs - sampling rate in Hz
   * @returns {Array<Array<number>>} SOS rows
   */
  cheby1LowpassSos(order, rpDb, cutoffHz, fs) {
    const N = order;
    const eps = Math.sqrt(10 ** (rpDb / 10) - 1);
    const mu = Math.asinh(1 / eps) / N;

    // Analog prototype poles (normalized cutoff Ωc = 1).
    const poles = [];
    for (let k = 0; k < N; k++) {
      const theta = (Math.PI * (2 * k + 1)) / (2 * N);
      poles.push({
        re: -Math.sinh(mu) * Math.sin(theta),
        im: Math.cosh(mu) * Math.cos(theta),
      });
    }

    // Prewarped analog cutoff + bilinear transform s → z.
    const oc = 2 * fs * Math.tan((Math.PI * cutoffHz) / fs);
    const twoFs = 2 * fs;
    const zs = poles.map((p) => {
      const sRe = p.re * oc,
        sIm = p.im * oc;
      const dRe = twoFs - sRe,
        dIm = -sIm;
      const numRe = twoFs + sRe,
        numIm = sIm;
      const den = dRe * dRe + dIm * dIm;
      return {
        re: (numRe * dRe + numIm * dIm) / den,
        im: (numIm * dRe - numRe * dIm) / den,
      };
    });

    // Conjugate pairs: pole k pairs with pole N-1-k.
    const sos = [];
    for (let i = 0; i < N / 2; i++) {
      const zi = zs[i],
        zj = zs[N - 1 - i];
      const a1 = -(zi.re + zj.re);
      const a2 = zi.re * zj.re - zi.im * zj.im; // (zi*zj) real part; imag cancels
      // Zeros of a low-pass: two at z = -1 → numerator (1 + z^-1)^2.
      sos.push([1, 2, 1, 1, a1, a2]);
    }

    // Gain: target DC magnitude = 10^(-rp/20) for even N, 1 for odd N.
    const target = N % 2 === 0 ? 10 ** (-rpDb / 20) : 1.0;
    let dc = 1;
    for (const s of sos) dc *= (s[0] + s[1] + s[2]) / (s[3] + s[4] + s[5]);
    const g = target / dc;
    sos[0][0] *= g;
    sos[0][1] *= g;
    sos[0][2] *= g;
    return sos;
  },

  /**
   * Butterworth high-pass, return second-order sections [b0,b1,b2,a0,a1,a2].
   * Bit-compatible with scipy.signal.butter(order, cutoff, 'highpass',
   * fs=fs, output='sos') — verified against scipy.signal.sosfreqz.
   */
  butterHighpassSos(order, cutoffHz, fs) {
    const N = order;
    const oc = 2 * fs * Math.tan((Math.PI * cutoffHz) / fs);
    const twoFs = 2 * fs;

    // Low-pass prototype poles on the unit circle, then high-pass transform
    // s → Ωc / s, then bilinear.
    const zs = [];
    for (let k = 0; k < N; k++) {
      const theta = (Math.PI * (2 * k + 1)) / (2 * N);
      const lpRe = -Math.sin(theta),
        lpIm = Math.cos(theta);
      // high-pass pole: s = Ωc / p_lp
      const den = lpRe * lpRe + lpIm * lpIm;
      const sRe = (oc * lpRe) / den,
        sIm = (-oc * lpIm) / den;
      const dRe = twoFs - sRe,
        dIm = -sIm;
      const numRe = twoFs + sRe,
        numIm = sIm;
      const dn = dRe * dRe + dIm * dIm;
      zs.push({
        re: (numRe * dRe + numIm * dIm) / dn,
        im: (numIm * dRe - numRe * dIm) / dn,
      });
    }

    const sos = [];
    for (let i = 0; i < N / 2; i++) {
      const zi = zs[i],
        zj = zs[N - 1 - i];
      const a1 = -(zi.re + zj.re);
      const a2 = zi.re * zj.re - zi.im * zj.im;
      // Zeros of a high-pass: two at z = 1 → numerator (1 - z^-1)^2.
      sos.push([1, -2, 1, 1, a1, a2]);
    }

    // Gain: high-pass magnitude at Nyquist (z = -1) is 1.
    let nyq = 1;
    for (const s of sos) nyq *= (s[0] - s[1] + s[2]) / (s[3] - s[4] + s[5]);
    const g = 1 / nyq;
    sos[0][0] *= g;
    sos[0][1] *= g;
    sos[0][2] *= g;
    return sos;
  },

  /**
   * Steady-state initial conditions for sosfilt, mirroring
   * scipy.signal.sosfilt_zi (transposed direct form II). Returned per-section
   * [s0, s1] are later multiplied by the first sample value (step height).
   */
  _sosfiltZi(sos) {
    const zi = new Array(sos.length);
    let scale = 1.0;
    for (let s = 0; s < sos.length; s++) {
      const b0 = sos[s][0],
        b1 = sos[s][1],
        b2 = sos[s][2];
      const a0 = sos[s][3],
        a1 = sos[s][4],
        a2 = sos[s][5];
      const sumB = b0 + b1 + b2,
        sumA = a0 + a1 + a2;
      const yInf = sumB / sumA;
      const d1 = b1 - yInf * a1;
      const d2 = b2 - yInf * a2;
      zi[s] = [scale * (d1 + d2), scale * d2];
      scale *= sumB / sumA;
    }
    return zi;
  },

  /**
   * Forward-filter a signal through SOS biquads (transposed direct form II).
   * @param {Array<Array<number>>} sos
   * @param {Array<number>|Float64Array} x
   * @param {Array<Array<number>>|null} zi - per-section [s0,s1] initial states
   * @param {number} [scale=1] - multiply each section's initial state (step height)
   * @returns {Float64Array}
   */
  sosfilt(sos, x, zi = null, scale = 1) {
    const n = x.length;
    let y = x;
    for (let s = 0; s < sos.length; s++) {
      const b0 = sos[s][0],
        b1 = sos[s][1],
        b2 = sos[s][2];
      const a1 = sos[s][4],
        a2 = sos[s][5];
      let s0 = zi ? zi[s][0] * scale : 0;
      let s1 = zi ? zi[s][1] * scale : 0;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const xi = y[i];
        const yi = b0 * xi + s0;
        s0 = b1 * xi - a1 * yi + s1;
        s1 = b2 * xi - a2 * yi;
        out[i] = yi;
      }
      y = out;
    }
    return y instanceof Float64Array ? y : Float64Array.from(y);
  },

  /**
   * Zero-phase forward-backward SOS filtering — replicates
   * scipy.signal.sosfiltfilt's odd reflection padding and steady-state
   * initial conditions.
   */
  sosfiltfilt(sos, x) {
    const n = x.length;
    if (n === 0) return new Float64Array(0);

    let cntB2 = 0,
      cntA2 = 0;
    for (const s of sos) {
      if (s[2] === 0) cntB2++;
      if (s[5] === 0) cntA2++;
    }
    const ntaps = 2 * sos.length + 1 - Math.min(cntB2, cntA2);
    let edge = 3 * ntaps;
    if (n <= edge) {
      // scipy raises here; degrade gracefully for very short signals.
      edge = Math.max(0, n - 1);
      if (edge === 0) return Float64Array.from(x);
    }

    const ext = new Float64Array(n + 2 * edge);
    for (let i = 0; i < edge; i++) ext[i] = 2 * x[0] - x[edge - i];
    for (let i = 0; i < n; i++) ext[edge + i] = x[i];
    for (let i = 0; i < edge; i++)
      ext[edge + n + i] = 2 * x[n - 1] - x[n - 2 - i];

    const zi = SpectralEDA._sosfiltZi(sos);

    const yFwd = SpectralEDA.sosfilt(sos, ext, zi, ext[0]);
    const m = yFwd.length;
    const rev = new Float64Array(m);
    for (let i = 0; i < m; i++) rev[i] = yFwd[m - 1 - i];
    const yBwd = SpectralEDA.sosfilt(sos, rev, zi, yFwd[m - 1]);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = yBwd[m - 1 - (edge + i)];
    return out;
  },

  /**
   * Decimate `x` (sampled at `fs`) to 2 Hz. Integer-ratio path takes every
   * (fs/2)-th sample (the signal is already 0.8 Hz low-passed); non-integer
   * ratios fall back to linear interpolation.
   */
  _decimateTo2Hz(x, fs) {
    const ratio = fs / 2;
    if (ratio <= 1) return Float64Array.from(x);
    if (Number.isInteger(ratio)) {
      const step = ratio;
      const n = Math.floor((x.length - 1) / step) + 1;
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = x[i * step];
      return out;
    }
    const n = Math.max(0, Math.floor((x.length - 1) / ratio) + 1);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, x.length - 1);
      const frac = pos - i0;
      out[i] = x[i0] * (1 - frac) + x[i1] * frac;
    }
    return out;
  },

  /**
   * The full Posada-Quintero preprocessing chain: raw µS EDA → 2 Hz,
   * low-pass / high-pass filtered signal ready for Welch estimation.
   * @param {Array<number>|Float64Array} signal
   * @param {number} fs
   * @returns {Float64Array} 2 Hz preprocessed signal
   */
  posadaSignal(signal, fs) {
    if (!signal || signal.length < 2) return new Float64Array(0);
    // Stage A: Chebyshev I, order 8, 1 dB, 0.8 Hz, forward (scipy sosfilt).
    const a = SpectralEDA.sosfilt(
      SpectralEDA.cheby1LowpassSos(8, 1.0, 0.8, fs),
      signal,
    );
    // Stage B: Chebyshev I, order 8, 0.05 dB, 0.8 Hz, zero-phase (decimate's anti-alias).
    const b = SpectralEDA.sosfiltfilt(
      SpectralEDA.cheby1LowpassSos(8, 0.05, 0.8, fs),
      a,
    );
    // Decimate to 2 Hz.
    const d2 = SpectralEDA._decimateTo2Hz(b, fs);
    // Stage C: Butterworth, order 8, 0.01 Hz high-pass, zero-phase.
    return SpectralEDA.sosfiltfilt(
      SpectralEDA.butterHighpassSos(8, 0.01, 2),
      d2,
    );
  },

  /**
   * Whole-recording scalar index — NeuroKit2's `EDA_Sympathetic` /
   * `EDA_SympatheticN` (posada2016). Returns NaN for signals <= 64 s, exactly
   * like NeuroKit2.
   *
   * @param {Array<number>|Float64Array} signal - raw µS EDA values
   * @param {number} fs
   * @returns {{sympathetic: number, normalized: number}}
   */
  computeScalar(signal, fs) {
    if (!signal || signal.length <= fs * 64) {
      return { sympathetic: NaN, normalized: NaN };
    }
    const d2 = SpectralEDA.posadaSignal(signal, fs);
    const { freq, psd } = SpectralEDA.welchDensity(d2, 2, {
      nperseg: 128,
      noverlap: 64,
      nfft: 256,
    });
    const sympathetic = SpectralEDA.trapzBand(
      psd,
      freq,
      SpectralEDA.BAND_HZ[0],
      SpectralEDA.BAND_HZ[1],
    );

    let maxP = -Infinity;
    for (let k = 0; k < psd.length; k++) if (psd[k] > maxP) maxP = psd[k];
    let normalized = NaN;
    if (maxP > 0) {
      const psdN = new Float64Array(psd.length);
      for (let k = 0; k < psd.length; k++) psdN[k] = psd[k] / maxP;
      normalized = SpectralEDA.trapzBand(
        psdN,
        freq,
        SpectralEDA.BAND_HZ[0],
        SpectralEDA.BAND_HZ[1],
      );
    }
    return { sympathetic, normalized };
  },

  /**
   * Sliding-window EDASymp series — the standalone continuous metric.
   *
   * Preprocesses once (posadaSignal), then for each window of `windowSec`
   * (default 64 s = NeuroKit2's nperseg @ 2 Hz) stepped by `hopSec` computes a
   * single-window periodogram and integrates the [0.045, 0.25) Hz band. Each
   * output point is the window CENTRE time (seconds, on the input time base)
   * and its band power in µS².
   *
   * @param {Array<number>|Float64Array} signal - raw µS EDA values
   * @param {Array<number>} times - per-sample times in seconds (length == signal.length)
   * @param {number} fs - sampling rate
   * @param {{windowSec?:number, hopSec?:number}} [opts]
   * @returns {Array<{time: number, val: number}>}
   */
  computeSeries(signal, times, fs, opts = {}) {
    const n = signal.length;
    if (!signal || n < 2) return [];

    const windowSec = opts.windowSec || SpectralEDA.WINDOW_SEC;
    const hopSec = opts.hopSec || SpectralEDA.HOP_SEC;
    const fLow = SpectralEDA.BAND_HZ[0];
    const fHigh = SpectralEDA.BAND_HZ[1];

    const d2 = SpectralEDA.posadaSignal(signal, fs);
    const n2 = d2.length;
    // < 8 samples @ 2 Hz (= 4 s) is too short for a meaningful spectrum.
    if (n2 < 8) return [];

    // Window in 2 Hz samples (64 s → 128), clamped to the available length so
    // a sub-64 s recording still yields one full-length window rather than a
    // flat all-zero series.
    const nperseg = Math.min(Math.max(8, Math.round(windowSec * 2)), n2);
    // Fixed power-of-2 FFT (≥ 2·nperseg for nperseg ≤ 128) → 0.0078 Hz bins.
    const nfft = 256;
    const win = SpectralEDA.blackmanPeriodic(nperseg);
    const scale = SpectralEDA._densityScale(2, SpectralEDA._windowSumSq(win));

    const hop2 = Math.max(1, Math.round(hopSec * 2));
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);

    // Full windows only, centres stepped by hop2 samples.
    const out = [];
    const half = nperseg >> 1;
    for (let start = 0; start + nperseg <= n2; start += hop2) {
      // Window-centre time on the ORIGINAL time base. d2 sample `i` was taken
      // from source sample i·fs/2 (_decimateTo2Hz), so read its time off the
      // real timestamps: t0 + i/2 assumes perfectly even sampling and drifts
      // on a recording that drops samples (~2% at 9.8 Hz ⇒ ~36 s by 30 min).
      const tCenter = SpectralEDA._timeAtIndex(
        times,
        ((start + half) * fs) / 2,
      );

      SpectralEDA._fftSegment(d2, start, nperseg, nfft, win, re, im);
      const bandPower = SpectralEDA._bandPowerFromFft(
        re,
        im,
        nfft,
        2,
        scale,
        fLow,
        fHigh,
      );
      out.push({ time: tCenter, val: Number.isNaN(bandPower) ? 0 : bandPower });
    }
    return out;
  },

  /**
   * Time at fractional source-sample index `pos`, linearly interpolated
   * between timestamps and clamped to the recording's ends.
   * @private
   */
  _timeAtIndex(times, pos) {
    const n = times.length;
    if (pos <= 0) return times[0];
    if (pos >= n - 1) return times[n - 1];
    const i0 = Math.floor(pos);
    const f = pos - i0;
    return times[i0] + f * (times[i0 + 1] - times[i0]);
  },

  /**
   * Map a window-centre series (from computeSeries) onto a per-sample time
   * grid by linear interpolation with edge-hold. Result length == times.length.
   *
   * @param {Array<{time:number,val:number}>} series
   * @param {Array<number>} times - target sample times (seconds)
   * @returns {Array<{time:number,val:number}>}
   */
  mapToSamples(series, times) {
    const n = times.length;
    const out = new Array(n);
    if (n === 0) return out;
    if (!series || series.length === 0) {
      for (let i = 0; i < n; i++) out[i] = { time: times[i], val: 0 };
      return out;
    }
    if (series.length === 1) {
      for (let i = 0; i < n; i++)
        out[i] = { time: times[i], val: series[0].val };
      return out;
    }

    let si = 0;
    for (let i = 0; i < n; i++) {
      const t = times[i];
      // Advance to the bracketing pair.
      while (si < series.length - 2 && series[si + 1].time < t) si++;
      const a = series[si],
        b = series[si + 1];
      let val;
      if (t <= a.time) val = a.val;
      else if (t >= b.time) val = b.val;
      else {
        const span = b.time - a.time;
        val =
          span > 0 ? a.val + (b.val - a.val) * ((t - a.time) / span) : a.val;
      }
      out[i] = { time: t, val };
    }
    return out;
  },
};
