/**
 * Constant-velocity Kalman + RTS smoother (src/gps/gps_cv_kalman.mjs).
 *
 * The first test is the correctness proof: for a linear-Gaussian model the
 * RTS smoother's output is exactly the least-squares solution of every
 * measurement and dynamics equation at once, so it is checked against a
 * brute-force dense solve of that system. The rest are real-walk
 * situations: noise, a multipath jump, a signal gap, a stop, a corner and a
 * lost track.
 *
 * Run: node --test tests/test_gps_cv_kalman.js
 */

const assert = require('node:assert');
const test = require('node:test');
const { GpsCvKalman } = require('../src/gps/gps_cv_kalman.mjs');
const { GpsFilter } = require('../src/gps/gps_filter.mjs');
const { GeoUtils } = require('../src/gps/geo_utils.mjs');

const LAT0 = 51.5;
const LON0 = -0.1;
const { degToMeterLat: M_LAT, degToMeterLon: M_LON } =
  GeoUtils.getGeodesicScale(LAT0);
const MS_TO_KTS = 1 / 0.514444;

/** Deterministic Gaussian noise (mulberry32 + Box-Muller). */
function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () =>
    Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** A fix at east/north metres from the origin. */
function fix(t, e, n, extra = {}) {
  return {
    time: t,
    lat: LAT0 + n / M_LAT,
    lon: LON0 + e / M_LON,
    hacc: 3,
    ...extra,
  };
}

/** Doppler fields for a velocity (m/s east, north). */
function doppler(vE, vN) {
  const s = Math.hypot(vE, vN);
  const course = ((Math.atan2(vE, vN) * 180) / Math.PI + 360) % 360;
  return { speedKts: s * MS_TO_KTS, course };
}

function toEN(p) {
  return { e: (p.lon - LON0) * M_LON, n: (p.lat - LAT0) * M_LAT };
}

function errM(p, e, n) {
  const q = toEN(p);
  return Math.hypot(q.e - e, q.n - n);
}

/** Solve A·x = b (dense, Gaussian elimination with partial pivoting). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function inv(A) {
  const n = A.length;
  return A.map((_, j) =>
    solve(
      A,
      A.map((_, i) => (i === j ? 1 : 0)),
    ),
  ).reduce(
    (acc, col, j) => {
      for (let i = 0; i < n; i++) acc[i][j] = col[i];
      return acc;
    },
    A.map(() => new Array(n).fill(0)),
  );
}

test('smoother equals the brute-force least-squares solution of the model', () => {
  // Seven fixes, uneven spacing, with and without Doppler — small enough
  // noise that the gate never fires, so the model is purely linear-Gaussian.
  const noise = rng(7);
  const pts = [];
  const times = [0, 1, 2.5, 3, 5, 6, 8];
  for (const t of times) {
    const e = 1.2 * t + noise();
    const n = 0.5 * t + noise();
    const extra =
      t === 2.5 ? {} : doppler(1.2 + 0.1 * noise(), 0.5 + 0.1 * noise());
    pts.push(fix(t, e, n, extra));
  }
  const K = GpsCvKalman;
  const q = K.ACCEL_PSD_WALK;
  const res = K.run(pts, { maxSpeed: 3, R_m2: 10 });
  assert.strictEqual(res.posRejected + res.velRejected + res.resets, 0);

  // Normal equations Σ Hᵀ W H x = Σ Hᵀ W z over the stacked state (4 per fix).
  const N = pts.length * 4;
  const A = Array.from({ length: N }, () => new Array(N).fill(0));
  const b = new Array(N).fill(0);
  // Add a residual r = Σ_j coef_j · x[idx_j] − z with 2×2 weight W between
  // two such residuals. Each "block" is a list of (idx, coef) rows.
  const addBlock = (rows, z, Rcov) => {
    const W = inv(Rcov);
    const m = rows.length;
    for (let a = 0; a < m; a++) {
      for (let c = 0; c < m; c++) {
        for (const [ia, ca] of rows[a]) {
          b[ia] += ca * W[a][c] * z[c];
          for (const [ic, cc] of rows[c]) A[ia][ic] += ca * W[a][c] * cc;
        }
      }
    }
  };

  const en = pts.map(toEN);
  // Prior on the first state, as _init sets it.
  const r0 = GpsFilter.measurementVarianceM2(pts[0], 10);
  const s0 = K.INIT_SPEED_SIGMA_MS ** 2;
  addBlock(
    [[[0, 1]], [[1, 1]]],
    [en[0].e, en[0].n],
    [
      [r0, 0],
      [0, r0],
    ],
  );
  addBlock(
    [[[2, 1]], [[3, 1]]],
    [0, 0],
    [
      [s0, 0],
      [0, s0],
    ],
  );
  for (let i = 0; i < pts.length; i++) {
    const o = 4 * i;
    if (i > 0) {
      // Dynamics per axis: [p_i − p_{i−1} − dt·v_{i−1}, v_i − v_{i−1}] ~ N(0, Q).
      const dt = pts[i].time - pts[i - 1].time;
      const Q = [
        [(q * dt ** 3) / 3, (q * dt ** 2) / 2],
        [(q * dt ** 2) / 2, q * dt],
      ];
      for (const ax of [0, 1]) {
        const p = o - 4;
        addBlock(
          [
            [
              [o + ax, 1],
              [p + ax, -1],
              [p + 2 + ax, -dt],
            ],
            [
              [o + 2 + ax, 1],
              [p + 2 + ax, -1],
            ],
          ],
          [0, 0],
          Q,
        );
      }
      const r = K.positionVarianceM2(pts, i, 10);
      addBlock(
        [[[o, 1]], [[o + 1, 1]]],
        [en[i].e, en[i].n],
        [
          [r, 0],
          [0, r],
        ],
      );
    }
    const v = K._dopplerVelocity(pts[i]);
    if (v) {
      addBlock(
        [[[o + 2, 1]], [[o + 3, 1]]],
        [v.vE, v.vN],
        [
          [v.rEE, v.rEN],
          [v.rEN, v.rNN],
        ],
      );
    }
  }
  const xs = solve(A, b);

  for (let i = 0; i < pts.length; i++) {
    const got = toEN(res.points[i]);
    assert.ok(
      Math.abs(got.e - xs[4 * i]) < 1e-6 &&
        Math.abs(got.n - xs[4 * i + 1]) < 1e-6,
      `fix ${i}: smoother (${got.e}, ${got.n}) vs least squares (${xs[4 * i]}, ${xs[4 * i + 1]})`,
    );
  }
});

test('straight walk: output is much closer to the truth than the raw fixes', () => {
  const noise = rng(1);
  const pts = [];
  const truth = [];
  for (let t = 0; t < 120; t++) {
    const e = 1.4 * t;
    truth.push([e, 0]);
    pts.push(
      fix(t, e + 3 * noise(), 3 * noise(), {
        ...doppler(1.4 + 0.2 * noise(), 0.2 * noise()),
      }),
    );
  }
  const out = GpsCvKalman.apply(pts);
  const rms = (arr) =>
    Math.sqrt(
      arr.reduce((s, p, i) => s + errM(p, truth[i][0], truth[i][1]) ** 2, 0) /
        arr.length,
    );
  const raw = rms(pts);
  const smooth = rms(out);
  assert.ok(
    smooth < raw / 2,
    `raw RMS ${raw.toFixed(2)} m, smoothed ${smooth.toFixed(2)} m`,
  );
});

test('a multipath jump with a plausible reported speed is rejected', () => {
  const noise = rng(2);
  const pts = [];
  for (let t = 0; t < 60; t++) {
    const e = 1.4 * t;
    // Fix 30 jumps 40 m sideways but its Doppler still says "walking east".
    const off = t === 30 ? 40 : 0;
    pts.push(fix(t, e + noise(), off + noise(), doppler(1.4, 0)));
  }
  const res = GpsCvKalman.run(pts);
  assert.strictEqual(res.posRejected, 1);
  assert.strictEqual(res.resets, 0);
  for (let t = 25; t <= 35; t++) {
    assert.ok(
      errM(res.points[t], 1.4 * t, 0) < 3,
      `fix ${t} is ${errM(res.points[t], 1.4 * t, 0).toFixed(1)} m off`,
    );
  }
});

test('a 20 s signal gap while walking needs no special handling', () => {
  const noise = rng(3);
  const pts = [];
  for (let t = 0; t < 80; t++) {
    if (t > 30 && t < 50) continue; // dropout
    pts.push(fix(t, 1.4 * t + noise(), noise(), doppler(1.4, 0)));
  }
  const res = GpsCvKalman.run(pts);
  assert.strictEqual(res.posRejected, 0, 'first fix after the gap was kept');
  assert.strictEqual(res.resets, 0);
  for (const p of res.points) {
    assert.ok(errM(p, 1.4 * p.time, 0) < 3);
  }
});

test('a stop holds still instead of wandering with the noise', () => {
  const noise = rng(4);
  const pts = [];
  for (let t = 0; t < 60; t++) {
    pts.push(fix(t, 3 * noise(), 3 * noise(), { speedKts: 0.1, course: 0 }));
  }
  const out = GpsCvKalman.apply(pts);
  const spread = (arr) => {
    const en = arr.map(toEN);
    const me = en.reduce((s, q) => s + q.e, 0) / en.length;
    const mn = en.reduce((s, q) => s + q.n, 0) / en.length;
    return Math.sqrt(
      en.reduce((s, q) => s + (q.e - me) ** 2 + (q.n - mn) ** 2, 0) / en.length,
    );
  };
  assert.ok(
    spread(out) < spread(pts) / 5,
    `raw ${spread(pts).toFixed(2)} m, smoothed ${spread(out).toFixed(2)} m`,
  );
});

test('a long stop with slowly drifting fixes draws a dot, not a loop', () => {
  // biomap_032b, 657–858 s: the chip's speed stayed under 0.3 m/s for
  // 3½ minutes while its position wandered ±5 m at 10 fixes a second.
  const pts = [];
  for (let i = 0; i < 2000; i++) {
    const t = i / 10;
    const e = 5 * Math.sin((2 * Math.PI * t) / 200);
    const n = 5 * Math.sin((2 * Math.PI * t) / 130);
    pts.push(fix(t, e, n, { speedKts: 0.05 }));
  }
  const res = GpsCvKalman.run(pts);
  assert.strictEqual(res.stopsPinned, 1);
  const en = res.points.map(toEN);
  let drawn = 0;
  for (let i = 1; i < en.length; i++) {
    drawn += Math.hypot(en[i].e - en[i - 1].e, en[i].n - en[i - 1].n);
  }
  assert.ok(drawn < 0.1, `drew ${drawn.toFixed(1)} m while standing still`);
});

test('a brief speed blip inside a stop does not split it', () => {
  // Enter at ≤ 0.5 kt, leave only above 1.0 kt: a 0.8 kt shuffle stays put.
  const pts = [];
  for (let i = 0; i < 300; i++) {
    const t = i / 10;
    const kts = t >= 14 && t < 15 ? 0.8 : 0.05;
    pts.push(fix(t, Math.sin(t / 5), Math.cos(t / 7), { speedKts: kts }));
  }
  assert.strictEqual(GpsCvKalman.run(pts).stopsPinned, 1);
});

test('walking off slower than the chip reports ends the stop where movement began', () => {
  // biomap_032b, 0–30 s: the chip said ~0.25 m/s (under the stop
  // threshold) while the fixes moved off at 0.5 m/s in a steady direction.
  const pts = [];
  for (let i = 0; i < 300; i++) {
    const t = i / 10;
    const n = t < 12 ? 0 : -0.5 * (t - 12);
    pts.push(fix(t, 0, n, { speedKts: t < 12 ? 0.05 : 0.45 }));
  }
  const pinned = GpsCvKalman._pinStops(pts, { stopsPinned: 0 });
  const lastPinned = pinned.findLastIndex((p, k) => p !== pts[k]);
  assert.ok(
    pts[lastPinned].time <= 12.5,
    `stop held until ${pts[lastPinned].time} s; walking began at 12 s`,
  );
});

test('fixes without a speed, or moving slowly, are never pinned', () => {
  const pts = [];
  for (let t = 0; t < 20; t++) pts.push(fix(t, 0.3 * t, 0, { speedKts: NaN }));
  for (let t = 20; t < 40; t++) pts.push(fix(t, 0.3 * t, 0, doppler(0.3, 0)));
  const res = GpsCvKalman.run(pts);
  assert.strictEqual(res.stopsPinned, 0);
  const travelled = toEN(res.points[39]).e - toEN(res.points[0]).e;
  assert.ok(travelled > 9, `only ${travelled.toFixed(1)} m of 11.7 m walked`);
});

test('a right-angle corner is followed, not cut', () => {
  const noise = rng(5);
  const pts = [];
  const truth = (t) => (t <= 30 ? [1.4 * t, 0] : [42, -1.4 * (t - 30)]);
  for (let t = 0; t <= 60; t++) {
    const [e, n] = truth(t);
    const v = t < 30 ? doppler(1.4, 0) : doppler(0, -1.4);
    pts.push(fix(t, e + noise(), n + noise(), v));
  }
  const res = GpsCvKalman.run(pts);
  assert.strictEqual(res.posRejected, 0);
  for (let t = 0; t <= 60; t++) {
    const [e, n] = truth(t);
    assert.ok(
      errM(res.points[t], e, n) < 3,
      `t=${t}: ${errM(res.points[t], e, n).toFixed(1)} m off`,
    );
  }
});

test('a real teleport restarts the track instead of rejecting it forever', () => {
  const noise = rng(6);
  const pts = [];
  for (let t = 0; t < 60; t++) {
    const e = t < 30 ? 1.4 * t : 500 + 1.4 * t; // re-acquired 500 m away
    pts.push(fix(t, e + noise(), noise(), doppler(1.4, 0)));
  }
  const res = GpsCvKalman.run(pts);
  assert.strictEqual(res.resets, 1);
  for (let t = 40; t < 60; t++) {
    assert.ok(errM(res.points[t], 500 + 1.4 * t, 0) < 3);
  }
});

test('input untouched, same length, other fields kept, short input passed through', () => {
  const pts = [fix(0, 0, 0, { origIdx: 5 }), fix(1, 1, 0, { origIdx: 9 })];
  const before = JSON.stringify(pts);
  const out = GpsCvKalman.apply(pts);
  assert.strictEqual(JSON.stringify(pts), before);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(
    out.map((p) => p.origIdx),
    [5, 9],
  );
  const one = [fix(0, 0, 0)];
  assert.strictEqual(GpsCvKalman.apply(one), one);
});
