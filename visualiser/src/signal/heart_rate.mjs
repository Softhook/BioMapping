/**
 * HeartRate — finds the heartbeat, or the footsteps, that show up as a
 * tiny ripple in the GSR.
 *
 * With fingers in the cuffs each heartbeat nudges the reading by about
 * 1–3 nS (on a reading of thousands of nS), at the pulse rate plus an exact
 * double of it. See docs/gsr_pulse_observation_2026_11_21.md. When walking,
 * the footsteps make a much bigger ripple at about the same rate (95–115 a
 * minute), so the two are read as opposites: where the GPS says the walker
 * is moving, the rhythm is read as steps; everywhere else (indoors with no
 * GPS fix, or standing still) as the pulse. Without GPS speed walking can't
 * be ruled out, and the summary says how much of the pulse time had none.
 *
 * Steps:
 *   1. Keep only the fast part of the signal: Butterworth high-pass at
 *      0.7 Hz (4th order, zero-phase), then a 3 Hz low-pass.
 *   2. Remove anything locked to the device's 1-second tick. Some boards
 *      dip by ~2.5 nS once a second (see the doc above), which would read
 *      as a perfect 60 a minute. For each row position within the second,
 *      the average over the surrounding 20 s is subtracted. A pulse that
 *      isn't exactly 60 a minute drifts through the positions and averages
 *      away, so it survives.
 *   3. Every second, take a 16 s window: Hann window, FFT, and divide the
 *      power by its own running median over ±0.35 Hz. A sloping background
 *      (slow sweat changes leaking through the high-pass) then reads about
 *      1 everywhere, and only a real peak stands out.
 *   4. Score each rate from 45 to 132 a minute by its peak plus half its
 *      double, and follow the best path through time with a penalty for
 *      jumping (Viterbi), so the rate can't hop about from window to
 *      window. This is done twice: once over the still windows (pulse) and
 *      once over the moving ones (steps), so neither leaks into the other.
 *   5. "Found" over the ±10 s around a window needs all three: the typical
 *      peak is at least 6 times its background, at least 80 % of the
 *      windows' own strongest peak sits within 4 a minute of the path, and
 *      the path moves by no more than 10 a minute. Found stretches shorter
 *      than 15 s are dropped. On the test resistor recordings this finds
 *      nothing, except one with strong mains hum from another device's
 *      supply. Windows where the pulse wave barely moves (no skin contact)
 *      are not looked at.
 *   6. Beats (or steps): within found stretches, the highest point of the
 *      wave in each beat, at least 0.6 of a beat apart, timed to a fraction
 *      of a row by fitting a parabola through the top three rows.
 *
 * The beat marks show when the fingertip reading peaks, which is some time
 * after the heart beats; only the rate is meaningful, not the exact timing.
 * Steps faster than 132 a minute (running) are not looked for.
 *
 * Pure module — no DOM, no AppState.
 */
import { GsrFilter } from './gsr_filter.mjs';
import { SpectralEDA } from './spectral_eda.mjs';

export const HeartRate = {
  HIGHPASS_HZ: 0.7,
  LOWPASS_HZ: 3.0,
  WINDOW_SEC: 16,
  HOP_SEC: 1,
  NFFT: 1024,
  MIN_BPM: 45,
  MAX_BPM: 132,
  WHITEN_HZ: 0.35,
  JUMP_PENALTY: 0.4, // log-score lost per 1/min of change between windows
  MAX_JUMP_BPM: 15, // biggest change allowed between neighbouring windows
  CLOCK_AVG_SEC: 10, // ± seconds for the 1-second-tick average
  FOUND_HALF_SEC: 10,
  FOUND_MIN_SNR: 6,
  FOUND_MIN_AGREE: 0.8,
  FOUND_AGREE_BPM: 4,
  FOUND_MAX_SPREAD_BPM: 10,
  FOUND_MIN_RUN_SEC: 15,
  MOVING_MPS: 0.6,
  MIN_SAMPLE_RATE: 6, // below this the pulse (≈1.3 Hz) and its double can't both be seen
  // Smallest typical swing of the pulse wave (µS) a window must have to be
  // looked at: 0.05 nS, half the 0.1 nS steps the recordings are stored in.
  // A real pulse moves the reading by about 1–3 nS.
  MIN_PULSE_SD: 0.00005,
  // Warn that the rate may be footsteps when at least this share of the
  // found time had no GPS speed: enough to move the typical rate.
  FOOTSTEP_WARN_SHARE: 0.2,

  /**
   * Fast part of the signal (the "pulse wave"), in the input's units.
   * @param {ArrayLike<number>} vals
   * @param {number} fs
   * @returns {Float64Array}
   */
  pulseWave(vals, fs) {
    let x = SpectralEDA.sosfiltfilt(
      SpectralEDA.butterHighpassSos(4, HeartRate.HIGHPASS_HZ, fs),
      Float64Array.from(vals),
    );
    if (fs / 2 > HeartRate.LOWPASS_HZ + 0.2) {
      x = Float64Array.from(
        GsrFilter.applyZeroPhaseButterworth(
          Array.from(x),
          HeartRate.LOWPASS_HZ,
          4,
          fs,
        ),
      );
    }
    return HeartRate.removeClockLocked(x, fs);
  },

  /**
   * Subtract the average shape at each row position within the second,
   * over ±CLOCK_AVG_SEC. Only when there is a whole number of rows a
   * second; otherwise returns the input unchanged.
   * @param {Float64Array} x
   * @param {number} fs
   * @returns {Float64Array}
   */
  removeClockLocked(x, fs) {
    const P = Math.round(fs);
    if (Math.abs(P - fs) > 0.01 || P < 4) return x;
    const n = x.length;
    const half = Math.round(HeartRate.CLOCK_AVG_SEC * fs);
    const out = new Float64Array(n);
    const sum = new Float64Array(P);
    const cnt = new Float64Array(P);
    let tot = 0;
    let tc = 0;
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(n, i + half + 1);
      while (hi < b) {
        sum[hi % P] += x[hi];
        cnt[hi % P]++;
        tot += x[hi];
        tc++;
        hi++;
      }
      while (lo < a) {
        sum[lo % P] -= x[lo];
        cnt[lo % P]--;
        tot -= x[lo];
        tc--;
        lo++;
      }
      const k = i % P;
      out[i] = x[i] - (sum[k] / cnt[k] - tot / tc);
    }
    return out;
  },

  /**
   * Per-window analysis: the followed pulse rate and how clearly it shows.
   * @param {Float64Array} x - pulse wave
   * @param {number} fs
   * @param {(start:number, end:number) => boolean} [skip] - windows it
   *   returns true for (samples [start, end)) aren't analysed and read as
   *   "no pulse".
   * @returns {Array<{centre:number, bpm:number, snr:number, ownPeakBpm:number, skipped:boolean}>}
   *   centre = window-centre sample index (fractional)
   */
  analyseWindows(x, fs, skip) {
    const H = HeartRate;
    const n = x.length;
    const W = Math.round(H.WINDOW_SEC * fs);
    const hop = Math.max(1, Math.round(H.HOP_SEC * fs));
    if (n < W) return [];
    const nfft = Math.max(H.NFFT, 1 << Math.ceil(Math.log2(W)));
    const df = fs / nfft;
    const half = nfft >> 1;
    const kmin = Math.ceil(0.5 / df);
    const kmax = Math.min(half - 1, Math.floor((fs / 2 - 0.05) / df));
    const wh = Math.max(1, Math.round(H.WHITEN_HZ / df));

    // One state per 1/min, MIN_BPM..MAX_BPM; each takes its best FFT bin.
    const nStates = H.MAX_BPM - H.MIN_BPM + 1;
    const stateLo = new Int32Array(nStates);
    const stateHi = new Int32Array(nStates);
    for (let s = 0; s < nStates; s++) {
      const bpm = H.MIN_BPM + s;
      stateLo[s] = Math.max(kmin, Math.round((bpm - 0.5) / 60 / df));
      stateHi[s] = Math.min(kmax, Math.round((bpm + 0.5) / 60 / df));
    }

    const hann = new Float64Array(W);
    for (let i = 0; i < W; i++)
      hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
    const re = new Float64Array(nfft);
    const im = new Float64Array(nfft);
    const P = new Float64Array(half);
    const Pw = new Float64Array(half);
    const absDev = new Float64Array(W);
    const medBuf = new Float64Array(wh + 2);
    const BG_STEP = 4;
    const nBg = Math.floor((kmax - kmin) / BG_STEP) + 1;
    const bg = new Float64Array(nBg);

    /** @param {number} centre */
    const skippedFrame = (centre) => ({
      centre,
      skipped: true,
      score: new Float64Array(nStates).fill(1),
      bin: stateLo,
      peak: new Float32Array(nStates),
      off: new Float32Array(nStates),
    });
    const frames = [];
    for (let s0 = 0; s0 + W <= n; s0 += hop) {
      const centre = s0 + (W - 1) / 2;
      if (skip?.(s0, s0 + W)) {
        frames.push(skippedFrame(centre));
        continue;
      }
      let mean = 0;
      for (let i = 0; i < W; i++) mean += x[s0 + i];
      mean /= W;
      for (let i = 0; i < W; i++) absDev[i] = Math.abs(x[s0 + i] - mean);
      const sig = HeartRate._median(absDev) * 1.4826;
      // Too flat to hold a pulse: no skin contact (the reading sticks at one
      // value) or a disconnect bridged with a straight line. What is left is
      // rounding error, which the 1-second-tick step shapes into a false
      // 120 a minute.
      if (sig < H.MIN_PULSE_SD) {
        frames.push(skippedFrame(centre));
        continue;
      }
      // Clip at 4 robust SDs so one jump or twitch can't swamp the window.
      const lim = 4 * sig;
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < W; i++) {
        const v = x[s0 + i] - mean;
        re[i] = (v > lim ? lim : v < -lim ? -lim : v) * hann[i];
      }
      SpectralEDA._fftInPlace(re, im);
      for (let k = 0; k < half; k++) P[k] = re[k] * re[k] + im[k] * im[k];
      // Background = running median, worked out every BG_STEP bins and
      // joined by straight lines (it changes slowly, and this is the slow
      // part of the whole analysis).
      for (let k0 = kmin; k0 <= kmax; k0 += BG_STEP) {
        let m = 0;
        const a = Math.max(kmin, k0 - wh);
        const b = Math.min(kmax, k0 + wh);
        for (let j = a; j <= b; j += 2) medBuf[m++] = P[j];
        bg[(k0 - kmin) / BG_STEP] = HeartRate._median(medBuf.subarray(0, m));
      }
      Pw.fill(0);
      for (let k = kmin; k <= kmax; k++) {
        const u = (k - kmin) / BG_STEP;
        const i0 = Math.floor(u);
        const i1 = Math.min(i0 + 1, nBg - 1);
        const m = bg[i0] + (bg[i1] - bg[i0]) * (u - i0);
        Pw[k] = m > 0 ? P[k] / m : 0;
      }
      const score = new Float64Array(nStates);
      const bin = new Int32Array(nStates);
      const peak = new Float32Array(nStates);
      const off = new Float32Array(nStates);
      for (let s = 0; s < nStates; s++) {
        let best = -1;
        let bk = stateLo[s];
        for (let k = stateLo[s]; k <= stateHi[s]; k++) {
          const v = Pw[k] + (2 * k <= kmax ? 0.5 * Pw[2 * k] : 0);
          if (v > best) {
            best = v;
            bk = k;
          }
        }
        score[s] = best;
        bin[s] = bk;
        peak[s] = Math.max(Pw[bk - 1], Pw[bk], Pw[bk + 1]);
        // Where the peak really sits between bins: a parabola through
        // the bin and its two neighbours.
        const den = Pw[bk - 1] - 2 * Pw[bk] + Pw[bk + 1];
        off[s] =
          den < 0
            ? Math.max(
                -0.5,
                Math.min(0.5, (0.5 * (Pw[bk - 1] - Pw[bk + 1])) / den),
              )
            : 0;
      }
      frames.push({ centre, skipped: false, score, bin, peak, off });
    }

    // Viterbi: best path through the states with a penalty per 1/min of change.
    const F = frames.length;
    const back = new Array(F);
    let cost = new Float64Array(nStates);
    for (let s = 0; s < nStates; s++)
      cost[s] = Math.log(frames[0].score[s] + 1e-9);
    for (let f = 1; f < F; f++) {
      const nc = new Float64Array(nStates);
      const bk = new Int16Array(nStates);
      for (let j = 0; j < nStates; j++) {
        let best = -Infinity;
        let bi = j;
        const a = Math.max(0, j - H.MAX_JUMP_BPM);
        const b = Math.min(nStates - 1, j + H.MAX_JUMP_BPM);
        for (let i = a; i <= b; i++) {
          const c = cost[i] - H.JUMP_PENALTY * Math.abs(i - j);
          if (c > best) {
            best = c;
            bi = i;
          }
        }
        nc[j] = best + Math.log(frames[f].score[j] + 1e-9);
        bk[j] = bi;
      }
      cost = nc;
      back[f] = bk;
    }
    const path = new Int32Array(F);
    let j = 0;
    for (let s = 1; s < nStates; s++) if (cost[s] > cost[j]) j = s;
    path[F - 1] = j;
    for (let f = F - 1; f > 0; f--) path[f - 1] = back[f][path[f]];

    return frames.map((fr, f) => {
      const k = fr.bin[path[f]];
      const pk = fr.peak[path[f]];
      let own = 0;
      for (let s = 1; s < nStates; s++)
        if (fr.score[s] > fr.score[own]) own = s;
      return {
        centre: fr.centre,
        bpm: (k + fr.off[path[f]]) * df * 60,
        snr: pk,
        ownPeakBpm: fr.skipped ? NaN : fr.bin[own] * df * 60,
        skipped: fr.skipped,
      };
    });
  },

  /**
   * Which windows count as "pulse found" (see step 5 in the header).
   * @param {ReturnType<typeof HeartRate.analyseWindows>} win
   * @param {number} fs
   * @returns {boolean[]}
   */
  foundWindows(win, fs) {
    const H = HeartRate;
    const hopSec = Math.max(1, Math.round(H.HOP_SEC * fs)) / fs;
    const h = Math.max(1, Math.round(H.FOUND_HALF_SEC / hopSec));
    const ok = win.map((_, i) => {
      if (win[i].skipped) return false;
      const a = Math.max(0, i - h);
      const b = Math.min(win.length - 1, i + h);
      const snrs = [];
      let agree = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = a; k <= b; k++) {
        const w = win[k];
        snrs.push(w.snr);
        if (Math.abs(w.ownPeakBpm - w.bpm) < H.FOUND_AGREE_BPM) agree++;
        if (w.bpm < lo) lo = w.bpm;
        if (w.bpm > hi) hi = w.bpm;
      }
      return (
        H._median(snrs) >= H.FOUND_MIN_SNR &&
        agree / (b - a + 1) >= H.FOUND_MIN_AGREE &&
        hi - lo <= H.FOUND_MAX_SPREAD_BPM
      );
    });
    const minRun = Math.round(H.FOUND_MIN_RUN_SEC / hopSec);
    let st = -1;
    for (let i = 0; i <= ok.length; i++) {
      if (ok[i] && st < 0) st = i;
      if (!ok[i] && st >= 0) {
        if (i - st < minRun) for (let k = st; k < i; k++) ok[k] = false;
        st = -1;
      }
    }
    return ok;
  },

  /**
   * Beats: the top of the pulse wave once per beat inside found stretches.
   * @param {Float64Array} x - pulse wave
   * @param {Float64Array} bpm - per-sample pulse rate, NaN where not found
   * @returns {number[]} fractional sample indices
   */
  findBeats(x, bpm, fs) {
    const out = [];
    const n = x.length;
    let i = 1;
    while (i < n - 1) {
      if (!Number.isFinite(bpm[i])) {
        i++;
        continue;
      }
      // One found stretch: [s, e).
      const s = i;
      while (i < n && Number.isFinite(bpm[i])) i++;
      const e = i;
      let lastIdx = -Infinity;
      for (let k = Math.max(1, s); k < Math.min(n - 1, e); k++) {
        if (!(x[k] > x[k - 1] && x[k] >= x[k + 1])) continue;
        const period = (60 / bpm[k]) * fs;
        const half = Math.max(1, Math.floor(period * 0.5));
        // Must be the highest point within half a beat either side.
        let isTop = true;
        for (let j = Math.max(s, k - half); j <= Math.min(e - 1, k + half); j++)
          if (x[j] > x[k]) {
            isTop = false;
            break;
          }
        if (!isTop) continue;
        const a = x[k - 1];
        const b = x[k];
        const c = x[k + 1];
        const den = a - 2 * b + c;
        const frac =
          den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
        const pos = k + frac;
        if (pos - lastIdx < period * 0.6) continue;
        out.push(pos);
        lastIdx = pos;
      }
    }
    return out;
  },

  /**
   * Per-sample rate and beats from analysed windows (steps 5 and 6).
   * @param {Float64Array} x - pulse wave
   * @param {ArrayLike<number>} times
   * @param {number} fs
   * @param {ReturnType<typeof HeartRate.analyseWindows>} win
   * @returns {{bpm: Float64Array, beats: Array<{index:number,time:number,bpm:number}>,
   *   found: boolean[], typical: number, foundSec: number}}
   * @private
   */
  _rhythm(x, times, fs, win) {
    const H = HeartRate;
    const n = x.length;
    const found = H.foundWindows(win, fs);

    // Per sample: a straight line between neighbouring found windows'
    // rates; the first and last half-hop of a found stretch hold its end value.
    const bpm = new Float64Array(n).fill(NaN);
    const hop = Math.max(1, Math.round(H.HOP_SEC * fs));
    const foundRates = [];
    for (let f = 0; f < win.length; f++) {
      if (!found[f]) continue;
      foundRates.push(win[f].bpm);
      const c = win[f].centre;
      const next = f + 1 < win.length && found[f + 1] ? win[f + 1] : null;
      const prevFound = f > 0 && found[f - 1];
      const a = Math.max(0, Math.ceil(prevFound ? c : c - hop / 2));
      const b = Math.min(n - 1, Math.floor(next ? next.centre : c + hop / 2));
      for (let i = a; i <= b; i++) {
        bpm[i] = next
          ? win[f].bpm +
            ((win[f + 1].bpm - win[f].bpm) * (i - c)) / (next.centre - c)
          : win[f].bpm;
      }
    }

    const beatIdx = H.findBeats(x, bpm, fs);
    const beats = beatIdx.map((pos, k) => {
      const i0 = Math.floor(pos);
      const t =
        i0 + 1 < n
          ? times[i0] + (pos - i0) * (times[i0 + 1] - times[i0])
          : times[i0];
      // Rate from the gap to the previous beat, when it is one beat away.
      let b = NaN;
      if (k > 0) {
        const gap = pos - beatIdx[k - 1];
        const expect = (60 / bpm[i0]) * fs;
        if (gap < expect * 1.5) b = (60 * fs) / gap;
      }
      return { index: i0, time: t, bpm: b };
    });
    return {
      bpm,
      beats,
      found,
      typical: foundRates.length ? H._median(foundRates) : NaN,
      foundSec: (foundRates.length * hop) / fs,
    };
  },

  /**
   * Whole pipeline.
   * @param {ArrayLike<number>} vals - GSR in µS
   * @param {ArrayLike<number>} times - seconds
   * @param {number} fs - rows a second
   * @param {{speedMps?: ArrayLike<number>|null}} [opts] - per-sample GPS
   *   speed, NaN where unknown; windows whose median known speed is over
   *   MOVING_MPS are read as steps, all others as pulse.
   * @returns {{
   *   pulse: Float64Array, bpm: Float64Array, beats: Array<{index:number,time:number,bpm:number}>,
   *   summary: {bpm:number, foundSec:number, totalSec:number, movingSec:number, noSpeedSec:number},
   *   steps: {bpm: Float64Array, beats: Array<{index:number,time:number,bpm:number}>,
   *     summary: {bpm:number, foundSec:number}}
   * }}
   *   bpm/beats/summary are the pulse; noSpeedSec = pulse time with no GPS
   *   speed to show the walker was still. steps = the same for footsteps,
   *   only where GPS speed says the walker is moving.
   */
  analyse(vals, times, fs, opts = {}) {
    const H = HeartRate;
    const n = vals.length;
    const noSteps = () => ({
      bpm: new Float64Array(n).fill(NaN),
      beats: [],
      summary: { bpm: NaN, foundSec: 0 },
    });
    const empty = {
      pulse: new Float64Array(n),
      bpm: new Float64Array(n).fill(NaN),
      beats: [],
      summary: {
        bpm: NaN,
        foundSec: 0,
        totalSec: n / (fs || 1),
        movingSec: 0,
        noSpeedSec: 0,
      },
      steps: noSteps(),
    };
    if (
      !(fs >= H.MIN_SAMPLE_RATE) ||
      n < Math.round((H.WINDOW_SEC + H.FOUND_MIN_RUN_SEC) * fs)
    )
      return empty;

    const x = H.pulseWave(vals, fs);
    const speed =
      opts.speedMps && opts.speedMps.length === n ? opts.speedMps : null;
    // Whether GPS says the walker is moving over samples [a, b), worked out
    // once per window and shared by the pulse and steps passes.
    const movingMemo = new Map();
    const isMoving = (a, b) => {
      let m = movingMemo.get(a);
      if (m === undefined) {
        const known = [];
        for (let i = a; i < b; i++)
          if (Number.isFinite(speed[i])) known.push(speed[i]);
        m = known.length > 0 && H._median(known) > H.MOVING_MPS;
        movingMemo.set(a, m);
      }
      return m;
    };
    const win = H.analyseWindows(x, fs, speed ? isMoving : undefined);
    if (win.length === 0) return { ...empty, pulse: x };
    const pulse = H._rhythm(x, times, fs, win);
    let movingCount = 0;
    for (const m of movingMemo.values()) if (m) movingCount++;
    const steps = movingCount
      ? H._rhythm(
          x,
          times,
          fs,
          H.analyseWindows(x, fs, (a, b) => !isMoving(a, b)),
        )
      : null;

    // Pulse windows with no GPS speed in them: walking can't be ruled out
    // there, and footsteps beat at about the same rate as a pulse.
    const hop = Math.max(1, Math.round(H.HOP_SEC * fs));
    const W = Math.round(H.WINDOW_SEC * fs);
    let noSpeedCount = 0;
    for (let f = 0; f < win.length; f++) {
      if (!pulse.found[f]) continue;
      let known = false;
      if (speed) {
        const s0 = Math.round(win[f].centre - (W - 1) / 2);
        for (let i = s0; i < s0 + W && !known; i++)
          if (Number.isFinite(speed[i])) known = true;
      }
      if (!known) noSpeedCount++;
    }
    const hopSec = hop / fs;
    return {
      pulse: x,
      bpm: pulse.bpm,
      beats: pulse.beats,
      summary: {
        bpm: pulse.typical,
        foundSec: pulse.foundSec,
        totalSec: win.length * hopSec,
        movingSec: movingCount * hopSec,
        noSpeedSec: noSpeedCount * hopSec,
      },
      steps: steps
        ? {
            bpm: steps.bpm,
            beats: steps.beats,
            summary: { bpm: steps.typical, foundSec: steps.foundSec },
          }
        : noSteps(),
    };
  },

  /**
   * Whether to warn that the typical rate may be footsteps: enough of the
   * found time had no GPS speed to show the walker was still.
   * @param {{foundSec:number, noSpeedSec:number}|null|undefined} summary
   */
  mayBeFootsteps(summary) {
    return (
      !!summary &&
      summary.foundSec > 0 &&
      summary.noSpeedSec >= HeartRate.FOOTSTEP_WARN_SHARE * summary.foundSec
    );
  },

  /**
   * Median (sorts the array in place). A typed array sorts by number on
   * its own, which is much faster than a plain array's sort.
   * @param {number[]|Float64Array} a
   * @private
   */
  _median(a) {
    if (a.length === 0) return 0;
    if (ArrayBuffer.isView(a)) a.sort();
    else a.sort((p, q) => p - q);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
  },
};
