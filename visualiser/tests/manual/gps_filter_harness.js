/**
 * GPS filter harness — scores filter variants on the real u-blox walks
 * (docs/gps_filter_review.md "How to test changes").
 *
 *   node tests/manual/gps_filter_harness.js [variant ...]
 *
 * For each variant (a set of GpsCvKalman constant overrides, see VARIANTS)
 * it reports:
 *   - street distance: the filtered path's distance to the nearest mapped
 *     street, sampled every 2 m (OSM data from tests/manual/.cache/, so only
 *     walks inside a cached area are scored) — both at the filtered fixes
 *     and along the drawn 10 Hz path (reconstructFilteredGps, which also
 *     fills the rows between fixes);
 *   - health: rejected fixes, restarts, pinned stops, and the mean position
 *     "surprise" score (NIS — about 2 on a filter whose noise model fits);
 *   - fake bad fixes: an offset of X m for Y s at 30/50/70 % of four clean
 *     walks — how far the finished path moves from the variant's own clean
 *     run, and how many extra restarts it causes. "~" cases fade the offset
 *     in and out over R s instead of switching it on at once, as a
 *     reflection usually does;
 *   - real jumps: the rest of the walk shifted by X m — how long the path
 *     takes to follow.
 *
 * Baseline is always the current code (no overrides).
 */
const fs = require('node:fs');
const path = require('node:path');

const V = path.resolve(__dirname, '../..');
const { GSRAnalyzer } = require(`${V}/src/signal/analyzer.mjs`);
const { GpsPipeline } = require(`${V}/src/gps/gps_pipeline.mjs`);
const { GpsCvKalman: K } = require(`${V}/src/gps/gps_cv_kalman.mjs`);
const { GeoUtils: G } = require(`${V}/src/gps/geo_utils.mjs`);
const { GSR_CONST } = require(`${V}/src/core/constants.mjs`);

const TRACKS = path.resolve(V, '../tracks');
const CACHE = path.resolve(__dirname, '.cache');
const INJECT_WALKS = [
  'biomap_113.csv',
  'biomap_029.csv',
  'biomap_032b.csv',
  'biomap_112.csv',
];
// [offset m, duration s, fade-in/out s (optional)]
const INJECT_CASES = [
  [20, 0],
  [50, 0],
  [20, 0.5],
  [20, 1],
  [50, 1],
  [30, 3],
  [15, 3],
  [10, 10],
  [30, 10],
  [20, 20],
  [20, 5, 2],
  [30, 10, 3],
  [20, 10, 3],
  [10, 20, 5],
];
// Real jumps: the whole walk shifts by X m from one point on (e.g. the chip
// correcting itself). Reported: seconds the path stays > 3 m from the truth.
const STEP_CASES = [15, 30, 100];

// Variants to compare: name → GpsCvKalman overrides. Add candidates here.
const VARIANTS = {
  base: {},
  // What §1 replaced (restart after 0.5 s, on the current fix) is no longer
  // expressible as an override; its results are in docs/gps_filter_review.md.
  restart5s: { RESET_AFTER_S: 5 },
  restart20s: { RESET_AFTER_S: 20 },
};

// --- helpers -----------------------------------------------------------------

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const quantile = (s, f) => s[Math.floor(f * (s.length - 1))];

function withOverrides(ov, fn) {
  const keep = {};
  for (const k of Object.keys(ov)) {
    keep[k] = K[k];
    K[k] = ov[k];
  }
  try {
    return fn();
  } finally {
    Object.assign(K, keep);
  }
}

// Record the position NIS of every update (accepted or not).
let nisLog = null;
const origUpdate = K._update;
K._update = function (x, P, k, z0, z1, rA, rB, rC) {
  if (k === 0 && nisLog) {
    const y0 = z0 - x[0];
    const y1 = z1 - x[1];
    const s00 = P[0] + rA;
    const s01 = P[1] + rB;
    const s11 = P[5] + rC;
    const det = s00 * s11 - s01 * s01;
    nisLog.push((y0 * y0 * s11 - 2 * y0 * y1 * s01 + y1 * y1 * s00) / det);
  }
  return origUpdate.call(this, x, P, k, z0, z1, rA, rB, rC);
};

function loadWalk(file) {
  const an = new GSRAnalyzer();
  an.parseCSV(fs.readFileSync(path.join(TRACKS, file), 'utf8'));
  const p = GSR_CONST.GPS_DEFAULT;
  const pts = GpsPipeline.applyFixTypeGate(
    GpsPipeline.applyHdopGate(GpsPipeline.collectFixes(an.raw), p.maxHdop),
  );
  return { file, an, pts, maxSpeed: p.maxSpeed };
}

// --- street distance ---------------------------------------------------------

const cacheFiles = fs
  .readdirSync(CACHE)
  .filter((f) => /^osm_.*\.json$/.test(f))
  .map((f) => {
    const [a, b, c, d] = f.slice(4, -5).split('_').map(Number);
    return { f: path.join(CACHE, f), a, b, c, d };
  });
const streetCache = new Map();

function streetScorer(pts) {
  const sample = pts.filter((_, i) => i % 50 === 0);
  const cf = cacheFiles.find((c) =>
    sample.every(
      (p) => c.a <= p.lat && p.lat <= c.c && c.b <= p.lon && p.lon <= c.d,
    ),
  );
  if (!cf) return null;
  if (!streetCache.has(cf.f)) {
    const els = JSON.parse(fs.readFileSync(cf.f, 'utf8')).elements;
    const nodes = new Map();
    for (const e of els) if (e.type === 'node') nodes.set(e.id, e);
    const ways = els
      .filter((e) => e.type === 'way' && e.tags?.highway)
      .map((w) => w.nodes.map((n) => nodes.get(n)).filter(Boolean));
    streetCache.set(cf.f, ways);
  }
  const ways = streetCache.get(cf.f);
  const lat0 = pts[0].lat;
  const mL = 111250;
  const mO = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const GRID = 20;
  const grid = new Map();
  for (const w of ways) {
    for (let i = 1; i < w.length; i++) {
      const s = [
        w[i - 1].lon * mO,
        w[i - 1].lat * mL,
        w[i].lon * mO,
        w[i].lat * mL,
      ];
      const gx0 = Math.floor(Math.min(s[0], s[2]) / GRID) - 1;
      const gx1 = Math.floor(Math.max(s[0], s[2]) / GRID) + 1;
      const gy0 = Math.floor(Math.min(s[1], s[3]) / GRID) - 1;
      const gy1 = Math.floor(Math.max(s[1], s[3]) / GRID) + 1;
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = `${gx},${gy}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(s);
        }
    }
  }
  const dist = (x, y) => {
    let best = 60;
    const cx = Math.floor(x / GRID);
    const cy = Math.floor(y / GRID);
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++) {
        const segs = grid.get(`${cx + dx},${cy + dy}`);
        if (!segs) continue;
        for (const [x1, y1, x2, y2] of segs) {
          const vx = x2 - x1;
          const vy = y2 - y1;
          const L = vx * vx + vy * vy;
          const t =
            L === 0
              ? 0
              : Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / L));
          best = Math.min(best, Math.hypot(x - x1 - t * vx, y - y1 - t * vy));
        }
      }
    return best;
  };
  return (P) => {
    const out = [];
    let prev = null;
    let acc = 0;
    for (const p of P) {
      const xy = [p.lon * mO, p.lat * mL];
      if (!prev) out.push(dist(...xy));
      else {
        acc += Math.hypot(xy[0] - prev[0], xy[1] - prev[1]);
        if (acc >= 2) {
          out.push(dist(...xy));
          acc = 0;
        }
      }
      prev = xy;
    }
    return out;
  };
}

// --- runs ----------------------------------------------------------------------

function corpus(walks, name, ov) {
  const pool = [];
  const drawnPool = [];
  const perWalk = [];
  let rej = 0;
  let resets = 0;
  let stops = 0;
  let n = 0;
  let maxJump = 0;
  const nisAll = [];
  let beatRaw = 0;
  for (const w of walks) {
    nisLog = [];
    const r = withOverrides(ov, () => K.run(w.pts, { maxSpeed: w.maxSpeed }));
    const drawnHolder = { snappedGps: null };
    GpsPipeline.reconstructFilteredGps(
      drawnHolder,
      w.an.raw,
      r.points,
      w.maxSpeed,
    );
    const drawn = drawnHolder.filteredGps.filter((p) => !Number.isNaN(p.lat));
    nisAll.push(...nisLog);
    nisLog = null;
    rej += r.posRejected;
    resets += r.resets;
    stops += r.stopsPinned;
    n += w.pts.length;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      if (b.time - a.time < 0.25)
        maxJump = Math.max(
          maxJump,
          G.haversineMeters(a.lat, a.lon, b.lat, b.lon),
        );
    }
    if (w.score) {
      const d = w.score(r.points);
      pool.push(...d);
      const m = median(d);
      perWalk.push(m);
      if (m < w.rawMedian) beatRaw++;
      drawnPool.push(...w.score(drawn));
    }
  }
  pool.sort((a, b) => a - b);
  drawnPool.sort((a, b) => a - b);
  const nisMean = nisAll.reduce((s, v) => s + v, 0) / nisAll.length;
  console.log(
    `${name.padEnd(14)} street med ${quantile(pool, 0.5).toFixed(2)} p90 ${quantile(pool, 0.9).toFixed(1)} p99 ${quantile(pool, 0.99).toFixed(1)}` +
      ` (drawn ${quantile(drawnPool, 0.5).toFixed(2)} / ${quantile(drawnPool, 0.9).toFixed(1)} / ${quantile(drawnPool, 0.99).toFixed(1)}) | beat raw ${beatRaw}/${perWalk.length}` +
      ` | rejected ${((100 * rej) / n).toFixed(2)}% restarts ${resets} stops ${stops} | NIS mean ${nisMean.toFixed(2)} | worst 0.1 s step ${maxJump.toFixed(1)} m`,
  );
}

function inject(walks, name, ov) {
  const rows = [];
  for (const [D, dur, fade = 0] of INJECT_CASES) {
    const pulls = [];
    let extra = 0;
    for (const w of walks) {
      const pts = w.pts;
      const base = withOverrides(ov, () =>
        K.run(pts, { maxSpeed: w.maxSpeed }),
      );
      const sc = G.getGeodesicScale(pts[0].lat);
      for (const fr of [0.3, 0.5, 0.7]) {
        const s = Math.floor(pts.length * fr);
        const p2 = pts.map((p) => ({ ...p }));
        for (
          let i = s;
          i < pts.length && pts[i].time - pts[s].time <= dur;
          i++
        ) {
          const t = pts[i].time - pts[s].time;
          const f = fade > 0 ? Math.min(1, t / fade, (dur - t) / fade) : 1;
          p2[i].lat += (f * D) / sc.degToMeterLat;
        }
        const r = withOverrides(ov, () => K.run(p2, { maxSpeed: w.maxSpeed }));
        let worst = 0;
        for (let i = 0; i < pts.length; i++) {
          const d = G.haversineMeters(
            r.points[i].lat,
            r.points[i].lon,
            base.points[i].lat,
            base.points[i].lon,
          );
          if (d > worst) worst = d;
        }
        pulls.push(worst);
        extra += r.resets - base.resets;
      }
    }
    const full = pulls.filter((p) => p > 0.8 * D).length;
    rows.push(
      `${fade ? '~' : ''}${D}m/${dur}s: med ${median(pulls).toFixed(1)} max ${Math.max(...pulls).toFixed(1)} full ${full}/${pulls.length} +rst ${extra}`,
    );
  }
  console.log(`${name.padEnd(14)} ${rows.join(' | ')}`);
}

function steps(walks, name, ov) {
  const rows = [];
  for (const D of STEP_CASES) {
    const late = [];
    for (const w of walks) {
      const pts = w.pts;
      const base = withOverrides(ov, () =>
        K.run(pts, { maxSpeed: w.maxSpeed }),
      );
      const sc = G.getGeodesicScale(pts[0].lat);
      for (const fr of [0.3, 0.5, 0.7]) {
        const s = Math.floor(pts.length * fr);
        const p2 = pts.map((p, i) =>
          i >= s ? { ...p, lat: p.lat + D / sc.degToMeterLat } : p,
        );
        const r = withOverrides(ov, () => K.run(p2, { maxSpeed: w.maxSpeed }));
        let lastBad = pts[s].time;
        for (let i = s; i < pts.length; i++) {
          const d = G.haversineMeters(
            r.points[i].lat,
            r.points[i].lon,
            base.points[i].lat + D / sc.degToMeterLat,
            base.points[i].lon,
          );
          if (d > 3) lastBad = pts[i].time;
        }
        late.push(lastBad - pts[s].time);
      }
    }
    rows.push(
      `${D}m step: wrong for med ${median(late).toFixed(1)} s, max ${Math.max(...late).toFixed(1)} s`,
    );
  }
  console.log(`${name.padEnd(14)} ${rows.join(' | ')}`);
}

// --- main ----------------------------------------------------------------------

const wanted = process.argv.slice(2);
const chosen = wanted.length
  ? Object.fromEntries(wanted.map((v) => [v, VARIANTS[v]]))
  : VARIANTS;
if (!chosen.base) chosen.base = {};

const files = fs
  .readdirSync(TRACKS)
  .filter((f) => /^biomap_\d+b?\.csv$/.test(f))
  .sort();
const walks = [];
const seen = new Set();
for (const f of files) {
  const w = loadWalk(f);
  if (w.pts.length < 50) continue;
  if (!w.pts.some((p) => p.hacc > 0 && p.hacc < 50)) continue; // u-blox only
  const key = `${w.pts.length}|${w.pts[0].lat}|${w.pts[0].lon}`;
  if (seen.has(key)) continue;
  seen.add(key);
  w.score = streetScorer(w.pts);
  if (w.score) w.rawMedian = median(w.score(w.pts));
  walks.push(w);
}
const scored = walks.filter((w) => w.score);
{
  const pool = scored.flatMap((w) => w.score(w.pts)).sort((a, b) => a - b);
  console.log(
    `u-blox walks ${walks.length}, street-scored ${scored.length}; raw street med ${quantile(pool, 0.5).toFixed(2)} p90 ${quantile(pool, 0.9).toFixed(1)} p99 ${quantile(pool, 0.99).toFixed(1)}\n`,
  );
}
for (const [name, ov] of Object.entries(chosen)) corpus(walks, name, ov);
console.log(
  '\nfake bad fixes (pull = worst move vs same variant clean; full = pull > 80 % of offset):',
);
const injWalks = walks.filter((w) => INJECT_WALKS.includes(w.file));
for (const [name, ov] of Object.entries(chosen)) inject(injWalks, name, ov);
console.log('\nreal jumps (whole walk shifted from one point on):');
for (const [name, ov] of Object.entries(chosen)) steps(injWalks, name, ov);
