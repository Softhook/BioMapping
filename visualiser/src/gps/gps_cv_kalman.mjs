/**
 * Constant-velocity Kalman filter + Rauch-Tung-Striebel smoother for GPS
 * tracks — the app's GPS filter (docs/gps_filtering_pipeline.md §3.2).
 *
 * Model (Bar-Shalom, Li & Kirubarajan, "Estimation with Applications to
 * Tracking and Navigation", §6.2 — continuous white-noise acceleration):
 *   state      x = [e, n, vE, vN] in metres / m·s⁻¹ on a local flat
 *              east/north plane around the first fix
 *   transition F = [I  dt·I; 0  I]
 *   process    Q = q·[dt³/3·I  dt²/2·I; dt²/2·I  dt·I]   (q in m²/s³)
 *   measured   position fix (per-fix noise from hAcc / DOP —
 *              GpsFilter.measurementVarianceM2) and the chip's Doppler
 *              speed + course as a velocity vector.
 *
 * The chip logs 5–10 fixes a second, already smoothed by its own navigation
 * filter, so neighbouring fixes share most of their error. Treating each as
 * independent makes the filter far too sure of itself: it then gates out the
 * chip's own corrections and has to restart. Each fix's noise is therefore
 * scaled by NOISE_CORR_S / (spacing to the previous fix), so one
 * NOISE_CORR_S-long run of fixes carries the weight of one independent fix —
 * the usual variance-inflation treatment of time-correlated measurement
 * noise. 3 s was chosen on the real walks, scored by distance to the nearest
 * mapped street: it removed every restart spike on the u-blox tracks.
 *
 * Each measurement passes a χ² innovation gate (2 DOF, 99.73 %) before it is
 * used; a rejected one is simply skipped, the standard treatment. Because the
 * prediction carries velocity, a multipath jump sideways of the direction of
 * travel stands out even when its own reported speed looks plausible, and a
 * signal gap needs no special handling — the prediction walks on at the last
 * speed and its uncertainty grows as dt³.
 *
 * After RESET_AFTER consecutive rejected position fixes the filter has lost
 * the track (a real jump it cannot explain, e.g. a re-acquisition after a
 * long outage), so it restarts on the current fix. The smoother runs
 * separately on each stretch between restarts.
 *
 * Stops are pinned before filtering: the fixes of a stop are all moved to
 * its mean position. The chip's own position drifts several metres over a
 * long stop while its speed stays near zero, and the filter alone reads that
 * slow drift as slow movement (biomap_032b: a 3½-minute stop drew a 10 m
 * loop). Treating the zero speed as a tight velocity measurement instead
 * still left a 4 m line. The stop rule follows the receiver's own "static
 * hold" (u-blox M10 integration manual §2.2.5), done here afterwards so the
 * dot is the mean of the whole stop rather than wherever the stop began, and
 * the raw recording keeps its wander:
 *   - a stop starts when the Doppler speed is ≤ STOP_SPEED_KTS, and only
 *     ends when it rises above STOP_EXIT_KTS (2×, as the chip does) — so a
 *     shuffle does not split one stop into two dots;
 *   - it also ends when the fixes move more than STOP_MOVE_M within
 *     STOP_MOVE_WINDOW_S (walking off slower than the chip's speed shows:
 *     032b's first 30 s), cut back to where that movement began, or a fix
 *     strays STOP_MAX_DIST_M from the stop's mean (a safety net);
 *   - only stops lasting STOP_MIN_S are pinned (the chip's "wait" stage), so
 *     slow walking is never pinned in short steps.
 * Values chosen on the u-blox walks: none changed the street distance;
 * exiting at 3× pinned real walking, 1.5 m / 5 s split real stops.
 * Fixes without a speed are never pinned.
 */

import { GeoUtils } from './geo_utils.mjs';
import { GpsFilter } from './gps_filter.mjs';

const KNOTS_TO_MS = 0.514444;
const DEG = Math.PI / 180;

export const GpsCvKalman = {
  /** Acceleration noise density (m²/s³) at walking pace (maxSpeed 3 m/s). */
  ACCEL_PSD_WALK: 0.5,
  /** 1σ error of the chip's Doppler speed (m/s). */
  SPEED_SIGMA_MS: 0.3,
  /** 1σ error of the chip's course (rad) once moving. */
  COURSE_SIGMA_RAD: 15 * DEG,
  /** Below this speed (m/s) the course is noise: only "about this slow" is used. */
  COURSE_MIN_SPEED_MS: 0.6,
  /** 1σ velocity uncertainty (m/s) at the start when no Doppler is available. */
  INIT_SPEED_SIGMA_MS: 3.0,
  /** χ² threshold, 2 DOF at 99.73 % (the 3σ equivalent). */
  GATE_CHI2: 11.83,
  /** Consecutive rejected position fixes after which the filter restarts. */
  RESET_AFTER: 5,
  /** Time (s) over which consecutive fixes' errors count as one — see header. */
  NOISE_CORR_S: 3,
  /** Doppler speed (knots, ≈ 0.26 m/s) at or below which a fix counts as stopped. */
  STOP_SPEED_KTS: 0.5,
  /** Shortest stop (s, first to last fix) that is pinned to one position. */
  STOP_MIN_S: 5,
  /** Once stopped, the speed (knots) the chip must exceed to end the stop. */
  STOP_EXIT_KTS: 1.0,
  /** A fix further than this (m) from the stop's mean position ends the stop. */
  STOP_MAX_DIST_M: 10,
  /** Moving more than STOP_MOVE_M (m) within STOP_MOVE_WINDOW_S (s) ends a stop. */
  STOP_MOVE_M: 2,
  STOP_MOVE_WINDOW_S: 5,

  /**
   * Position noise variance (m², per axis) for fix i: the shared hAcc/DOP
   * model, scaled up when fixes come faster than one per NOISE_CORR_S.
   */
  positionVarianceM2(points, i, R_m2) {
    const r = GpsFilter.measurementVarianceM2(points[i], R_m2);
    if (i === 0) return r;
    const dt = points[i].time - points[i - 1].time;
    return r * Math.max(1, this.NOISE_CORR_S / Math.max(dt, 0.01));
  },

  /**
   * Smooth a GPS track: returns a new array of `{ ...pt, lat, lon }`, one
   * per input point, input untouched (fewer than 2 points come back as is).
   *
   * @param {Array<{lat:number, lon:number, time:number}>} points
   * @param {{maxSpeed?:number, R_m2?:number}} [opts] - maxSpeed scales the
   *   acceleration noise as (maxSpeed/3)² (run/bike turn and speed up harder
   *   than a walk); R_m2 is the base variance for the DOP fallback.
   */
  apply(points, opts = {}) {
    return this.run(points, opts).points;
  },

  /**
   * As apply(), plus counts of what the gate and restart logic did — for
   * tests and diagnostics.
   *
   * @returns {{points:Array, posRejected:number, velRejected:number,
   *   velUsed:number, resets:number, stopsPinned:number}}
   */
  run(points, { maxSpeed = 3.0, R_m2 = 10 } = {}) {
    const n = points ? points.length : 0;
    const stats = {
      posRejected: 0,
      velRejected: 0,
      velUsed: 0,
      resets: 0,
      stopsPinned: 0,
    };
    if (n < 2) return { points, ...stats };
    points = this._pinStops(points, stats);

    const q = this.ACCEL_PSD_WALK * (maxSpeed / 3.0) ** 2;
    const lat0 = points[0].lat;
    const lon0 = points[0].lon;
    const { degToMeterLat: mLat, degToMeterLon: mLon } =
      GeoUtils.getGeodesicScale(lat0);

    // Per step: filtered state/covariance, and the prediction that led to it
    // (the smoother needs both).
    const xf = new Float64Array(4 * n);
    const Pf = new Float64Array(16 * n);
    const xp = new Float64Array(4 * n);
    const Pp = new Float64Array(16 * n);
    const dts = new Float64Array(n);
    const segStarts = [0];

    const x = new Float64Array(4);
    const P = new Float64Array(16);
    let rejectRun = 0;

    for (let i = 0; i < n; i++) {
      const pt = points[i];
      const e = (pt.lon - lon0) * mLon;
      const nn = (pt.lat - lat0) * mLat;

      if (i === 0 || rejectRun >= this.RESET_AFTER) {
        if (i > 0) {
          segStarts.push(i);
          stats.resets++;
        }
        this._init(x, P, pt, e, nn, R_m2);
        rejectRun = 0;
        xp.set(x, 4 * i);
        Pp.set(P, 16 * i);
      } else {
        const dt = Math.max(0, pt.time - points[i - 1].time);
        dts[i] = dt;
        this._predict(x, P, dt, q);
        xp.set(x, 4 * i);
        Pp.set(P, 16 * i);

        const r = this.positionVarianceM2(points, i, R_m2);
        if (this._update(x, P, 0, e, nn, r, 0, r)) {
          rejectRun = 0;
        } else {
          stats.posRejected++;
          rejectRun++;
        }
      }

      const v = this._dopplerVelocity(pt);
      if (v) {
        if (this._update(x, P, 2, v.vE, v.vN, v.rEE, v.rEN, v.rNN))
          stats.velUsed++;
        else stats.velRejected++;
      }

      xf.set(x, 4 * i);
      Pf.set(P, 16 * i);
    }

    // RTS backward pass, one restart-free stretch at a time.
    const xs = new Float64Array(xf);
    segStarts.push(n);
    for (let s = 0; s < segStarts.length - 1; s++) {
      this._smooth(xs, xf, Pf, xp, Pp, dts, segStarts[s], segStarts[s + 1]);
    }

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = {
        ...points[i],
        lat: lat0 + xs[4 * i + 1] / mLat,
        lon: lon0 + xs[4 * i] / mLon,
      };
    }
    return { points: out, ...stats };
  },

  /**
   * Copy of `points` with every stop (see header) moved to its mean
   * position; returns `points` itself when there is none.
   */
  _pinStops(points, stats) {
    const { degToMeterLat: mLat, degToMeterLon: mLon } =
      GeoUtils.getGeodesicScale(points[0].lat);
    const hasSpeed = (pt) => pt.speedKts >= 0;
    let out = points;
    let i = 0;
    while (i < points.length) {
      if (!(hasSpeed(points[i]) && points[i].speedKts <= this.STOP_SPEED_KTS)) {
        i++;
        continue;
      }
      // Stay stopped until the speed clearly rises, a fix strays from the
      // stop, or the fixes move steadily (walking off slower than the chip's
      // speed shows). The last ends the stop where that movement began.
      let lat = points[i].lat;
      let lon = points[i].lon;
      let j = i + 1;
      let end = -1;
      let w = i; // first fix within STOP_MOVE_WINDOW_S of fix j
      while (j < points.length) {
        const pt = points[j];
        if (!hasSpeed(pt) || pt.speedKts > this.STOP_EXIT_KTS) break;
        const m = j - i;
        const away = Math.hypot(
          (pt.lon - lon / m) * mLon,
          (pt.lat - lat / m) * mLat,
        );
        if (away > this.STOP_MAX_DIST_M) break;
        while (pt.time - points[w].time > this.STOP_MOVE_WINDOW_S) w++;
        const moved = Math.hypot(
          (pt.lon - points[w].lon) * mLon,
          (pt.lat - points[w].lat) * mLat,
        );
        if (moved > this.STOP_MOVE_M) {
          end = w;
          break;
        }
        lat += pt.lat;
        lon += pt.lon;
        j++;
      }
      if (end < 0) end = j;
      if (end > i && points[end - 1].time - points[i].time >= this.STOP_MIN_S) {
        lat = 0;
        lon = 0;
        for (let k = i; k < end; k++) {
          lat += points[k].lat;
          lon += points[k].lon;
        }
        lat /= end - i;
        lon /= end - i;
        if (out === points) out = points.slice();
        for (let k = i; k < end; k++) out[k] = { ...points[k], lat, lon };
        stats.stopsPinned++;
      }
      i = j;
    }
    return out;
  },

  /** Start (or restart) the track on fix `pt`, velocity from Doppler if any. */
  _init(x, P, pt, e, nn, R_m2) {
    P.fill(0);
    const r = GpsFilter.measurementVarianceM2(pt, R_m2);
    x[0] = e;
    x[1] = nn;
    x[2] = 0;
    x[3] = 0;
    P[0] = r;
    P[5] = r;
    const s2 = this.INIT_SPEED_SIGMA_MS ** 2;
    P[10] = s2;
    P[15] = s2;
  },

  /** x ← F·x, P ← F·P·Fᵀ + Q (white-noise acceleration, see header). */
  _predict(x, P, dt, q) {
    x[0] += dt * x[2];
    x[1] += dt * x[3];
    // F·P·Fᵀ with F = [I dt·I; 0 I] and P = [A B; Bᵀ D] in 2×2 blocks
    // (pos-pos, pos-vel, vel-vel) is [A + dt(B+Bᵀ) + dt²D, B + dt·D; Bᵀ + dt·D, D].
    const P0 = P.slice();
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const D = P0[(a + 2) * 4 + b + 2];
        P[a * 4 + b] =
          P0[a * 4 + b] +
          dt * (P0[a * 4 + b + 2] + P0[(a + 2) * 4 + b]) +
          dt * dt * D;
        P[a * 4 + b + 2] = P0[a * 4 + b + 2] + dt * D;
        P[(a + 2) * 4 + b] = P0[(a + 2) * 4 + b] + dt * D;
      }
    }
    const qpp = (q * dt * dt * dt) / 3;
    const qpv = (q * dt * dt) / 2;
    const qvv = q * dt;
    P[0] += qpp;
    P[5] += qpp;
    P[2] += qpv;
    P[8] += qpv;
    P[7] += qpv;
    P[13] += qpv;
    P[10] += qvv;
    P[15] += qvv;
  },

  /**
   * Gated update with a 2-D measurement of state elements (k, k+1) — k = 0
   * for position, 2 for velocity — with noise covariance [[rA, rB],[rB, rC]].
   * Returns false (state untouched) when the innovation fails the χ² gate.
   */
  _update(x, P, k, z0, z1, rA, rB, rC) {
    const y0 = z0 - x[k];
    const y1 = z1 - x[k + 1];
    const s00 = P[k * 4 + k] + rA;
    const s01 = P[k * 4 + k + 1] + rB;
    const s11 = P[(k + 1) * 4 + k + 1] + rC;
    const det = s00 * s11 - s01 * s01;
    if (!(det > 0)) return false;
    const i00 = s11 / det;
    const i01 = -s01 / det;
    const i11 = s00 / det;
    const nis = y0 * (i00 * y0 + i01 * y1) + y1 * (i01 * y0 + i11 * y1);
    if (!(nis < this.GATE_CHI2)) return false;

    // K = P·Hᵀ·S⁻¹ (4×2); PHt[r] = [P[r][k], P[r][k+1]].
    const K = new Float64Array(8);
    for (let r = 0; r < 4; r++) {
      const p0 = P[r * 4 + k];
      const p1 = P[r * 4 + k + 1];
      K[r * 2] = p0 * i00 + p1 * i01;
      K[r * 2 + 1] = p0 * i01 + p1 * i11;
    }
    for (let r = 0; r < 4; r++) x[r] += K[r * 2] * y0 + K[r * 2 + 1] * y1;

    // P ← P − K·H·P, then re-symmetrise against round-off.
    const HP = new Float64Array(8);
    for (let c = 0; c < 4; c++) {
      HP[c] = P[k * 4 + c];
      HP[4 + c] = P[(k + 1) * 4 + c];
    }
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        P[r * 4 + c] -= K[r * 2] * HP[c] + K[r * 2 + 1] * HP[4 + c];
      }
    }
    for (let r = 0; r < 4; r++) {
      for (let c = r + 1; c < 4; c++) {
        const m = 0.5 * (P[r * 4 + c] + P[c * 4 + r]);
        P[r * 4 + c] = m;
        P[c * 4 + r] = m;
      }
    }
    return true;
  },

  /**
   * The chip's Doppler speed + course as an east/north velocity with its
   * noise covariance, or null when the fix carries no usable speed. The
   * error is SPEED_SIGMA along the direction of travel and speed ×
   * COURSE_SIGMA across it. Below COURSE_MIN_SPEED the course is
   * meaningless, so the measurement becomes "velocity ≈ 0, give or take the
   * reported speed" — which is what holds a stop still.
   */
  _dopplerVelocity(pt) {
    if (!(pt.speedKts >= 0)) return null;
    const s = pt.speedKts * KNOTS_TO_MS;
    const sa2 = this.SPEED_SIGMA_MS ** 2;
    if (s < this.COURSE_MIN_SPEED_MS) {
      const r = sa2 + s * s;
      return { vE: 0, vN: 0, rEE: r, rEN: 0, rNN: r };
    }
    if (!Number.isFinite(pt.course)) return null;
    const c = pt.course * DEG; // clockwise from north
    const ue = Math.sin(c);
    const un = Math.cos(c);
    const sc2 = (s * this.COURSE_SIGMA_RAD) ** 2;
    // R = σa²·u·uᵀ + σc²·w·wᵀ with w = (un, −ue) perpendicular to u.
    return {
      vE: s * ue,
      vN: s * un,
      rEE: sa2 * ue * ue + sc2 * un * un,
      rEN: (sa2 - sc2) * ue * un,
      rNN: sa2 * un * un + sc2 * ue * ue,
    };
  },

  /**
   * RTS smoother over steps [start, end): x̂ₖ = xfₖ + Cₖ·(x̂ₖ₊₁ − xpₖ₊₁),
   * Cₖ = Pfₖ·Fᵀ·Ppₖ₊₁⁻¹. Only the mean is needed, so the smoothed covariance
   * is not propagated.
   */
  _smooth(xs, xf, Pf, xp, Pp, dts, start, end) {
    const PfFt = new Float64Array(16);
    const inv = new Float64Array(16);
    const C = new Float64Array(16);
    for (let k = end - 2; k >= start; k--) {
      const dt = dts[k + 1];
      // (Pf·Fᵀ)[r][c] = Pf[r][c] + dt·Pf[r][c+2] for the position columns c < 2.
      for (let r = 0; r < 4; r++) {
        const o = 16 * k + r * 4;
        PfFt[r * 4] = Pf[o] + dt * Pf[o + 2];
        PfFt[r * 4 + 1] = Pf[o + 1] + dt * Pf[o + 3];
        PfFt[r * 4 + 2] = Pf[o + 2];
        PfFt[r * 4 + 3] = Pf[o + 3];
      }
      if (!invert4(Pp, 16 * (k + 1), inv)) continue;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let m = 0; m < 4; m++) s += PfFt[r * 4 + m] * inv[m * 4 + c];
          C[r * 4 + c] = s;
        }
      }
      const d0 = xs[4 * (k + 1)] - xp[4 * (k + 1)];
      const d1 = xs[4 * (k + 1) + 1] - xp[4 * (k + 1) + 1];
      const d2 = xs[4 * (k + 1) + 2] - xp[4 * (k + 1) + 2];
      const d3 = xs[4 * (k + 1) + 3] - xp[4 * (k + 1) + 3];
      for (let r = 0; r < 4; r++) {
        xs[4 * k + r] =
          xf[4 * k + r] +
          C[r * 4] * d0 +
          C[r * 4 + 1] * d1 +
          C[r * 4 + 2] * d2 +
          C[r * 4 + 3] * d3;
      }
    }
  },
};

/**
 * Invert the 4×4 matrix stored at src[off..off+15] into out (Gauss-Jordan
 * with partial pivoting). Returns false if it is singular.
 */
function invert4(src, off, out) {
  const a = new Float64Array(32);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) a[r * 8 + c] = src[off + r * 4 + c];
    a[r * 8 + 4 + r] = 1;
  }
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(a[r * 8 + col]) > Math.abs(a[piv * 8 + col])) piv = r;
    }
    const pv = a[piv * 8 + col];
    if (!(Math.abs(pv) > 1e-300)) return false;
    if (piv !== col) {
      for (let c = 0; c < 8; c++) {
        const t = a[col * 8 + c];
        a[col * 8 + c] = a[piv * 8 + c];
        a[piv * 8 + c] = t;
      }
    }
    for (let c = 0; c < 8; c++) a[col * 8 + c] /= pv;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = a[r * 8 + col];
      if (f === 0) continue;
      for (let c = 0; c < 8; c++) a[r * 8 + c] -= f * a[col * 8 + c];
    }
  }
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) out[r * 4 + c] = a[r * 8 + 4 + c];
  }
  return true;
}
