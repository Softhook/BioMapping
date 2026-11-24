/**
 * HeartRate (src/signal/heart_rate.mjs): the pulse ripple in the GSR.
 *
 * Made-up signals check the rules: a pulse buried in noise and slow sweat
 * changes is found at the right rate; plain noise, a once-a-second device
 * dip and walking are not. Real recordings in ../../tracks (gitignored, only
 * on machines that have them) check the same on skin and the test
 * resistors; those tests skip when the files are missing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { HeartRate } = require('../src/signal/heart_rate.mjs');

const FS = 10;

/** Repeatable noise (mulberry32 + Box–Muller). */
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

/**
 * µS signal: 5 µS level, slow sweat wander, noise (nS), and optionally a
 * pulse at `bpm` (nS) with its double, and a once-a-second dip (nS).
 */
function synth({
  seconds = 180,
  bpm = 0,
  pulseNs = 0,
  noiseNs = 1,
  dipNs = 0,
  seed = 1,
}) {
  const n = seconds * FS;
  const g = rng(seed);
  const vals = new Float64Array(n);
  const times = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    times[i] = t;
    let ns = 5000 + 200 * Math.sin((2 * Math.PI * t) / 90) + noiseNs * g();
    // Two sweat responses: quick rise, slow fall.
    for (const t0 of [50, 120]) {
      const d = t - t0;
      if (d > 0) ns += 150 * (1 - Math.exp(-d / 1.5)) * Math.exp(-d / 8);
    }
    if (bpm) {
      // The rate wanders a little, like a real one.
      const f = (bpm + 2 * Math.sin((2 * Math.PI * t) / 25)) / 60;
      ph += (2 * Math.PI * f) / FS;
      ns += pulseNs * (Math.sin(ph) + 0.4 * Math.sin(2 * ph + 0.7));
    }
    if (dipNs && i % FS === 3) ns -= dipNs;
    vals[i] = ns / 1000;
  }
  return { vals, times };
}

test('finds a 75/min pulse buried in noise and sweat changes', () => {
  const { vals, times } = synth({ bpm: 75, pulseNs: 1.5, noiseNs: 1.5 });
  const r = HeartRate.analyse(vals, times, FS);
  assert.ok(Math.abs(r.summary.bpm - 75) < 2, `typical rate ${r.summary.bpm}`);
  assert.ok(
    r.summary.foundSec / r.summary.totalSec > 0.6,
    `found in ${r.summary.foundSec} of ${r.summary.totalSec} s`,
  );
  // Roughly one beat per expected beat in the found time.
  const expected = (r.summary.foundSec * 75) / 60;
  assert.ok(
    r.beats.length > expected * 0.8 && r.beats.length < expected * 1.2,
    `${r.beats.length} beats, expected about ${expected.toFixed(0)}`,
  );
  // Blank outside found stretches, a rate inside them.
  assert.ok(r.bpm.some(Number.isFinite));
  for (const b of r.beats) assert.ok(Number.isFinite(r.bpm[b.index]));
});

test('finds a fast resting pulse (105/min) too', () => {
  const { vals, times } = synth({ bpm: 105, pulseNs: 1.5, noiseNs: 1.5 });
  const r = HeartRate.analyse(vals, times, FS);
  assert.ok(Math.abs(r.summary.bpm - 105) < 2, `typical rate ${r.summary.bpm}`);
});

test('plain noise and sweat changes: no pulse', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { vals, times } = synth({ noiseNs: 1.5, seed });
    const r = HeartRate.analyse(vals, times, FS);
    assert.strictEqual(r.summary.foundSec, 0, `seed ${seed}`);
    assert.strictEqual(r.beats.length, 0);
    assert.ok(Number.isNaN(r.summary.bpm));
  }
});

test('a once-a-second device dip is not read as a 60/min pulse', () => {
  const { vals, times } = synth({ noiseNs: 0.4, dipNs: 2.5 });
  const r = HeartRate.analyse(vals, times, FS);
  assert.strictEqual(r.summary.foundSec, 0);
});

test('stretches where GPS says the walker is moving are left out', () => {
  // A footstep-like rhythm at 105/min, while walking at 1.3 m/s.
  const { vals, times } = synth({ bpm: 105, pulseNs: 5, noiseNs: 1 });
  const moving = new Float64Array(vals.length).fill(1.3);
  const r = HeartRate.analyse(vals, times, FS, { speedMps: moving });
  assert.strictEqual(r.summary.foundSec, 0);
  assert.ok(r.summary.movingSec > 0);
  // Standing still for the second half: found there only.
  const half = new Float64Array(vals.length).fill(Number.NaN);
  for (let i = 0; i < vals.length / 2; i++) half[i] = 1.3;
  const r2 = HeartRate.analyse(vals, times, FS, { speedMps: half });
  assert.ok(r2.summary.foundSec > 0);
  for (let i = 0; i < vals.length / 2 - 8 * FS; i++)
    assert.ok(!Number.isFinite(r2.bpm[i]), `rate at ${i / FS} s while moving`);
});

test('a reading stuck at one value (no skin contact) is not read as a pulse', () => {
  // Stuck at 16.9 nS with one spike, like biomap_121.csv. The rounding
  // error left after the spike, shaped by the 1-second-tick step, used to
  // read as a steady 60 or 120 a minute.
  const n = 600 * FS;
  const times = Float64Array.from({ length: n }, (_, i) => i / FS);
  const stuck = new Float64Array(n).fill(0.0169);
  stuck[1000] = 0.3;
  const r = HeartRate.analyse(stuck, times, FS);
  assert.strictEqual(r.summary.foundSec, 0);
  // Also a disconnect bridged with a straight line, in the middle of a pulse.
  const { vals } = synth({ bpm: 75, pulseNs: 1.5, noiseNs: 1.5, seconds: 600 });
  const a = 200 * FS;
  const b = 400 * FS;
  for (let i = a; i < b; i++)
    vals[i] =
      vals[a - 1] + ((vals[b] - vals[a - 1]) * (i - a + 1)) / (b - a + 1);
  const r2 = HeartRate.analyse(vals, times, FS);
  assert.ok(r2.summary.foundSec > 0, 'pulse still found either side');
  for (let i = a + 10 * FS; i < b - 10 * FS; i++)
    assert.ok(!Number.isFinite(r2.bpm[i]), `rate at ${i / FS} s on the line`);
});

test('found time without GPS speed is reported, for the footsteps warning', () => {
  const { vals, times } = synth({ bpm: 75, pulseNs: 1.5, noiseNs: 1.5 });
  const none = HeartRate.analyse(vals, times, FS);
  assert.ok(none.summary.foundSec > 0);
  assert.strictEqual(none.summary.noSpeedSec, none.summary.foundSec);
  // Standing still with GPS speed known throughout: nothing to warn about.
  const still = new Float64Array(vals.length).fill(0.1);
  const known = HeartRate.analyse(vals, times, FS, { speedMps: still });
  assert.ok(known.summary.foundSec > 0);
  assert.strictEqual(known.summary.noSpeedSec, 0);
  // Speed known only for the first half: part of the found time is unknown.
  const half = new Float64Array(vals.length).fill(Number.NaN);
  half.fill(0.1, 0, vals.length / 2);
  const part = HeartRate.analyse(vals, times, FS, { speedMps: half });
  assert.ok(part.summary.noSpeedSec > 0);
  assert.ok(part.summary.noSpeedSec < part.summary.foundSec);
});

test('too short or too slow a recording gives an empty result', () => {
  const short = synth({ seconds: 20, bpm: 75, pulseNs: 2 });
  const r = HeartRate.analyse(short.vals, short.times, FS);
  assert.strictEqual(r.summary.foundSec, 0);
  assert.strictEqual(r.bpm.length, short.vals.length);
  const slow = HeartRate.analyse(short.vals, short.times, 4);
  assert.strictEqual(slow.summary.foundSec, 0);
});

// ── Real recordings (local only) ─────────────────────────────────────────
const TRACKS = path.join(__dirname, '../../tracks');
const W = 'workshop_2026-11-23/BioMapping-3E5C_biomap_';

function loadCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let head = null;
  const t = [];
  const v = [];
  for (const L of lines) {
    if (!L || L[0] === '#') continue;
    if (!head) {
      head = L.split(',');
      continue;
    }
    const c = L.split(',');
    const ti = +c[head.indexOf('timestamp')];
    const g = +c[head.indexOf('gsr_raw')];
    if (Number.isFinite(ti) && Number.isFinite(g)) {
      t.push(ti);
      v.push(g / 1000);
    }
  }
  return { vals: v, times: t };
}

const SKIN = [
  // [file, typical rate low, high]
  ['biomap_0077_nodate.csv', 70, 78],
  ['biomap_2026-11-21_cardputer_00-29-07.csv', 78, 85],
  [`${W}0073_nodate.csv`, 70, 78],
];
const RESISTOR = [
  'biomap_0003_nodate.csv',
  'biomap_0005_nodate.csv',
  'biomap_0006_nodate.csv',
  'biomap_0009_nodate.csv',
  'biomap_0010_nodate.csv',
  'biomap_0012 220_nodate.csv',
  `${W}0014_nodate.csv`,
  `${W}0071_nodate.csv`,
  'biomap_2026-11-20_23-04-31.csv',
  'biomap_2026-11-21_08-30-13.csv',
  'biomap_2026-11-22_09-22-542.csv',
  'biomap_2026-11-22_10-12-02 220.csv',
  'biomap_2026-11-22_10-29-54.csv',
  'biomap_2026-11-22_10-37-12 220.csv',
];

for (const [file, lo, hi] of SKIN) {
  test(`skin recording ${file}: pulse ${lo}–${hi}/min`, (t) => {
    const p = path.join(TRACKS, file);
    if (!fs.existsSync(p)) return t.skip('recording not here');
    const { vals, times } = loadCsv(p);
    const r = HeartRate.analyse(vals, times, FS);
    assert.ok(
      r.summary.bpm >= lo && r.summary.bpm <= hi,
      `typical ${r.summary.bpm}`,
    );
    assert.ok(r.summary.foundSec / r.summary.totalSec > 0.5);
  });
}

test('test resistor recordings: no pulse', (t) => {
  let ran = 0;
  for (const file of RESISTOR) {
    const p = path.join(TRACKS, file);
    if (!fs.existsSync(p)) continue;
    const { vals, times } = loadCsv(p);
    const r = HeartRate.analyse(vals, times, FS);
    assert.strictEqual(r.summary.foundSec, 0, file);
    ran++;
  }
  if (!ran) t.skip('recordings not here');
});

test('footsteps warning: only when enough of the found time had no GPS speed', () => {
  const w = (foundSec, noSpeedSec) =>
    HeartRate.mayBeFootsteps({ foundSec, noSpeedSec });
  assert.strictEqual(w(100, 100), true);
  assert.strictEqual(w(100, 20), true);
  assert.strictEqual(w(665, 31), false); // like walk 059: a few seconds only
  assert.strictEqual(w(100, 0), false);
  assert.strictEqual(w(0, 0), false);
  assert.strictEqual(HeartRate.mayBeFootsteps(null), false);
});
