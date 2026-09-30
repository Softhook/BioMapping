/**
 * Response delay: the tests written before the build. Each one states a rule
 * from the Solution design in docs/time_offsets_review.md. Tests for a step
 * not built yet are marked `todo`, so they run and report but don't fail the
 * suite; each step removes the marks for what it delivers.
 *
 * The rule: the slider moves all body data (GSR, tonic, phasic, peaks,
 * hotspots, the indices) by the same amount against all place data
 * (position, speed, OSM, NDVI, EM fog). It changes where body data appears,
 * never what it is.
 *
 * What the tests expect the build to provide:
 *   src/signal/response_delay.mjs  ResponseDelay { MIN_S, MAX_S, DEFAULT_S,
 *                                  STEP_S, normalise(s) }
 *   analyzer.setResponseDelay(s)   the project's slider value, in seconds
 *   analyzer.placeOf(i)            where reading i goes: the position at
 *                                  (its time − delay), interpolated, or null
 *   analyzer.placeRowOf(i)         the place row at (its time − delay), or −1
 *   analyzer.readingAt(j)          the reading place row j shows: the row at
 *                                  (its time + delay), or −1
 * analyzer.getCoordinates(j) stays the plain position of row j (place code).
 *
 * Not covered here, and checked in the real app instead (step 2): the 3D wall,
 * the graph drawing, and hovering. Live stays on skin time; the existing live
 * tests must keep passing unchanged.
 *
 * Run: node --test tests/test_response_delay.js
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { GpsPipeline } = require('../src/gps/gps_pipeline.mjs');
const {
  GSRCollectiveManager,
} = require('../src/spatial/collective_manager.mjs');
const {
  EnvironmentalStats,
} = require('../src/spatial/environmental_stats.mjs');
const {
  straightWalkCsv,
  isoWalkCsv,
} = require('./support/response_delay_walks.js');

const STEP3 = 'Timestamp fixes not built yet (step 3)';
const HZ = 10;
const rows = (s) => Math.round(s * HZ);

/** A made-up walk, parsed, with its smoothed path and analysis. */
function walk(opts = {}, delay = null) {
  const a = new GSRAnalyzer();
  a.parseCSV(straightWalkCsv(opts));
  if (delay != null) a.setResponseDelay(delay);
  GpsPipeline.ensureFilteredGps(a, GSR_CONST.GPS_DEFAULT);
  a.analyze({ ...GSR_CONST.GSR_DEFAULT, hotspotPercentile: 1 });
  return a;
}

const close = (x, y, tol, msg) =>
  assert.ok(Math.abs(x - y) <= tol, `${msg}: ${x} vs ${y}`);
const samePlace = (p, q, msg) => {
  assert.ok(p && q, `${msg}: missing place`);
  close(p.lat, q.lat, 1e-9, `${msg} (lat)`);
  close(p.lon, q.lon, 1e-9, `${msg} (lon)`);
};

// ── The slider ──────────────────────────────────────────────────────────────

test('slider: 0 to 8 s, default 2 s; out-of-range values are clamped, junk falls back', () => {
  const { ResponseDelay } = require('../src/signal/response_delay.mjs');
  assert.strictEqual(ResponseDelay.MIN_S, 0);
  assert.strictEqual(ResponseDelay.MAX_S, 8);
  assert.strictEqual(ResponseDelay.DEFAULT_S, 2);
  assert.strictEqual(ResponseDelay.STEP_S, 0.1);
  assert.strictEqual(ResponseDelay.normalise(0), 0);
  assert.strictEqual(ResponseDelay.normalise(3.5), 3.5);
  assert.strictEqual(ResponseDelay.normalise(12), 8);
  assert.strictEqual(ResponseDelay.normalise(-1), 0);
  assert.strictEqual(ResponseDelay.normalise(NaN), 2);
  assert.strictEqual(ResponseDelay.normalise(undefined), 2);
});

test('slider in the page: "Response delay", 0–8 s in 0.1 s steps, starting at 2 s', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const input = html.match(/<input[^>]*id="responseDelay"[^>]*>/);
  assert.ok(input, 'a #responseDelay slider');
  for (const [attr, val] of [
    ['min', '0'],
    ['max', '8'],
    ['step', '0.1'],
    ['value', '2'],
  ]) {
    assert.match(input[0], new RegExp(`${attr}="${val}(\\.0)?"`), attr);
  }
  assert.match(html, />\s*Response delay\s*</);
  assert.doesNotMatch(
    html,
    /id="gpsPeakLatency"/,
    'the old per-walk slider is gone',
  );
});

// ── The join ────────────────────────────────────────────────────────────────

test('join at 0 s: every reading is placed where it was taken', () => {
  const a = walk({}, 0);
  for (let i = 0; i < a.raw.length; i++) {
    samePlace(a.placeOf(i), a.getCoordinates(i), `reading ${i}`);
    assert.strictEqual(a.placeRowOf(i), i);
    assert.strictEqual(a.readingAt(i), i);
  }
});

test('join at 2 s: a reading is placed where the walker was 2 s earlier', () => {
  const a = walk({}, 2);
  for (let i = rows(2); i < a.raw.length; i++) {
    assert.strictEqual(a.placeRowOf(i), i - rows(2), `reading ${i}`);
    samePlace(a.placeOf(i), a.getCoordinates(i - rows(2)), `reading ${i}`);
  }
});

test('join between rows: the place is interpolated, so dragging moves things smoothly', () => {
  const a = walk({}, 2.05);
  for (const i of [100, 500, 1200]) {
    const p = a.getCoordinates(i - 20);
    const q = a.getCoordinates(i - 21);
    const mid = { lat: (p.lat + q.lat) / 2, lon: (p.lon + q.lon) / 2 };
    samePlace(a.placeOf(i), mid, `reading ${i} halfway between rows`);
  }
});

test('join the other way: a place shows the reading from 2 s later', () => {
  const a = walk({}, 2);
  const n = a.raw.length;
  for (let j = 0; j < n - rows(2); j++) {
    assert.strictEqual(a.readingAt(j), j + rows(2), `place ${j}`);
  }
  for (let j = n - rows(2); j < n; j++) {
    assert.strictEqual(a.readingAt(j), -1, `place ${j}: no reading yet`);
  }
  for (let i = rows(2); i < n; i++) {
    assert.strictEqual(a.readingAt(a.placeRowOf(i)), i, `round trip ${i}`);
  }
});

test('edges: readings in the first 2 s have no place (it would be before the recording)', () => {
  const a = walk({}, 2);
  for (let i = 0; i < rows(2); i++) {
    assert.strictEqual(a.placeOf(i), null, `reading ${i}`);
    assert.strictEqual(a.placeRowOf(i), -1, `reading ${i}`);
  }
});

test('edges: a reading whose place had no GPS fix has no place', () => {
  const a = walk({ warmupS: 15 }, 2);
  const firstFix = rows(15);
  for (let i = 0; i < a.raw.length; i++) {
    const placed = a.placeOf(i) !== null;
    assert.strictEqual(placed, i - rows(2) >= firstFix, `reading ${i}`);
  }
});

// ── Where, never what ───────────────────────────────────────────────────────

const bodyFacts = (a) =>
  JSON.stringify({
    peaks: a.peaks.map((p) => [p.index, p.amplitude, !!p.excluded]),
    hotspots: a.memorableEvents.map((p) => p.index),
  });

test('moving the slider changes nothing about the body data', () => {
  const a = walk({}, 0);
  const at0 = bodyFacts(a);
  for (const d of [0.5, 2, 3.7, 8, 0]) {
    a.setResponseDelay(d); // a slider move: no re-analysis
    assert.strictEqual(bodyFacts(a), at0, `after moving to ${d} s`);
    assert.strictEqual(bodyFacts(walk({}, d)), at0, `fresh load at ${d} s`);
  }
});

test('hotspots come only from peaks that have a place at every setting (0–8 s)', () => {
  // A response 3 s in has no place once the slider passes ~4 s, so it must
  // not be a hotspot (it would vanish while dragging).
  const a = walk({ responsesAt: [3, 40, 80, 120, 160] }, 2);
  assert.ok(
    a.peaks.some((p) => p.time < 8),
    'the early peak is still detected (a body fact)',
  );
  assert.ok(a.memorableEvents.length > 0);
  for (const p of a.memorableEvents) {
    for (const d of [0, 4, 8]) {
      a.setResponseDelay(d);
      assert.ok(a.placeOf(p.index), `hotspot at ${p.time} s placed at ${d} s`);
    }
  }
});

test('hotspots are chosen with the smoothed path already built (finding 2)', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(straightWalkCsv());
  a.setResponseDelay(2);
  a.analyze(GSR_CONST.GSR_DEFAULT); // no ensureFilteredGps() call first
  assert.strictEqual(a.filteredGps.length, a.raw.length);
});

/** Group-map points for one walk and source. */
function groupPoints(a, topographySource) {
  const cm = new GSRCollectiveManager();
  cm.addTrack({ id: 'w', enabled: true, analyzer: a, gpsFilterParams: {} });
  const params = cm._resolveContourParams({
    topographySource,
    normalizeZScore: true,
    temporalSmoothingWindow: 0,
  });
  return cm._collectContourPoints(cm.getActiveTracks(), params);
}

/** Row whose plain position is at this longitude (the walk goes due east). */
function rowAtLon(a, lon) {
  let lo = 0;
  let hi = a.raw.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a.getCoordinates(mid).lon < lon) lo = mid + 1;
    else hi = mid;
  }
  const best = [lo - 1, lo]
    .filter((k) => k >= 0)
    .sort(
      (x, y) =>
        Math.abs(a.getCoordinates(x).lon - lon) -
        Math.abs(a.getCoordinates(y).lon - lon),
    )[0];
  close(a.getCoordinates(best).lon, lon, 1e-9, 'point sits on a path row');
  return best;
}

for (const src of [
  'phasic',
  'tonic',
  'gsr',
  'auc',
  'peak_density',
  'arousal_index',
  'tri_index',
]) {
  test(`group map (${src}): each reading keeps its value; only its place moves 2 s back`, () => {
    const a = walk({}, 0);
    const byRow0 = new Map();
    for (const p of groupPoints(a, src).points) {
      byRow0.set(rowAtLon(a, p.lon), p.val);
    }
    a.setResponseDelay(2);
    let matched = 0;
    for (const p of groupPoints(a, src).points) {
      const m = rowAtLon(a, p.lon); // place row; its reading is 2 s later
      if (!byRow0.has(m + rows(2))) continue;
      close(p.val, byRow0.get(m + rows(2)), 1e-9, `place row ${m}`);
      matched++;
    }
    assert.ok(matched > 100, `compared ${matched} points`);
  });
}

test('group map peaks: each peak placed the slider amount back, at the same size', () => {
  const a = walk({}, 0);
  const size0 = groupPoints(a, 'peaks').peaks.map((p) => p.amplitude);
  const active = a.peaks.filter((p) => !p.excluded);
  for (const d of [0, 2, 5]) {
    a.setResponseDelay(d);
    const pk = groupPoints(a, 'peaks').peaks;
    assert.deepStrictEqual(
      pk.map((p) => p.amplitude),
      size0,
      `sizes at ${d} s`,
    );
    pk.forEach((p, k) => {
      samePlace(
        p,
        a.getCoordinates(active[k].index - rows(d)),
        `peak ${k} at ${d} s`,
      );
    });
  }
});

// ── Everything in sync ──────────────────────────────────────────────────────

test('path colour: body data colours the place it came from; place data stays put', () => {
  const { superMock } = require('./support/realm_bridge.js');
  const { GSRMapPath } = require('../src/map/manager/path.mjs');
  const a = walk({}, 2);
  const drawPoints = GpsPipeline.buildDrawPoints(
    a.raw,
    a.filteredGps,
    a.sampleRate,
    false,
    new Set(),
  );
  const mm = Object.create(GSRMapPath.prototype);
  mm.map = null;
  const savedL = global.L;
  global.L = superMock();
  /** The value the path uses for each draw point, for one colour metric. */
  const colourValues = (metric) => {
    mm.activeColoringMetric = metric;
    try {
      mm._renderPathSegments(drawPoints, 5, a, null);
    } catch {
      // Drawing needs a real map; the value lookup is kept before that.
    }
    return drawPoints.map((dp) => mm._lastPathGetVal(dp));
  };
  try {
    const body = {
      gsr: (r) => a.raw[r].val,
      phasic: (r) => a.phasic[r].val,
      tonic: (r) => a.tonic[r].val,
      phasicAUC: (r) => a.phasicAUC[r].val,
      peakDensity: (r) => a.peakDensity[r].val,
      arousalIndex: (r) => a.arousalIndex[r].val,
      triIndex: (r) => a.triIndex[r].val,
    };
    for (const [metric, readingValue] of Object.entries(body)) {
      const got = colourValues(metric);
      drawPoints.forEach((dp, k) => {
        const r = a.readingAt(dp.origIdx);
        if (r < 0) {
          assert.ok(
            got[k] == null || Number.isNaN(got[k]),
            `${metric}: place ${dp.origIdx} has no reading yet, so no colour`,
          );
        } else {
          assert.strictEqual(
            got[k],
            readingValue(r),
            `${metric} at place ${dp.origIdx}`,
          );
        }
      });
    }
    const hdop = colourValues('hdopQuality');
    drawPoints.forEach((dp, k) => {
      assert.strictEqual(hdop[k], a.raw[dp.origIdx].hdop, 'HDOP is place data');
    });
  } finally {
    global.L = savedL;
  }
});

test('dashboard: each reading meets the place data from 2 s earlier — tonic and speed too', () => {
  const a = walk({}, 2);
  // Place data that names its own row, so the pairing can be read back.
  a.raw.forEach((r, i) => {
    r.osm_dist_major_road = i + 0.5;
    r.speedKts = i * 0.001;
  });
  a.isEnriched = true;
  // The second argument is today's per-walk latency; the build drops it.
  const samples = EnvironmentalStats.buildSamples(
    [{ id: 'w', analyzer: a }],
    () => 2,
  );
  assert.ok(samples.length > 100);
  for (const s of samples) {
    const i = a.findClosestIndex(s.time); // the reading
    const place = a.placeRowOf(i);
    assert.ok(place >= 0, `reading at ${s.time} s has a place`);
    assert.strictEqual(s.osm_dist_major_road, place + 0.5, 'the pairing');
    assert.strictEqual(
      s.tonicEnv,
      undefined,
      'tonic uses the same pairing, not one of its own',
    );
    close(
      s.tonicSpeed,
      a.raw[place].speedKts * 0.514444,
      1e-9,
      "tonic's speed is taken at the place too",
    );
    const t = a.raw[place].time;
    const win = a.raw.filter((r) => r.time > t - 1 && r.time <= t);
    const speed =
      (win.reduce((sum, r) => sum + r.speedKts, 0) / win.length) * 0.514444;
    close(s.speed, speed, 1e-6, 'speed is place data, taken at the place');
  }
});

test('3D wall: height and colour at a place come from its reading; EM fog stays put', () => {
  global.Cesium = global.Cesium || {};
  const { GSRGlobeBase } = require('../src/map/globe3d/globe3d_base.mjs');
  const { GSRGlobe3DExport } = require('../src/map/globe3d/exporters.mjs');
  const a = walk({}, 2);
  // EM fog series (place data) that names its own row.
  a.em_fog = a.raw.map((r, i) => ({ time: r.time, val: i % 50 }));
  const wall = (metric) =>
    GSRGlobeBase.prototype._getMetricSeries.call({}, a, metric);
  const phasic = wall('phasic');
  const exported = GSRGlobe3DExport.resolveSeries(a, 'phasic');
  const fog = wall('em_fog');
  for (let j = 0; j < a.raw.length; j++) {
    const r = a.readingAt(j);
    const want = r >= 0 ? a.phasic[r].val : null;
    assert.strictEqual(phasic[j], want, `wall at place ${j}`);
    assert.strictEqual(exported[j], want, `exported wall at place ${j}`);
    assert.strictEqual(fog[j], j % 50, `EM fog at place ${j} is not moved`);
  }
});

// ── Nothing shifts time on its own ──────────────────────────────────────────

test('no code outside the join shifts time itself', () => {
  const FORBIDDEN = [
    /\bstimulusIndexAt\b/,
    /\bresolveLatencyIndex\b/,
    /\bPhysioLatency\b/,
    /\bpeakLatency\b/,
    /\btrk\.latency\b/,
    /\blags?\.(phasic|tonic)\b/,
  ];
  const JOIN = path.join('src', 'signal', 'response_delay.mjs');
  const hits = [];
  const walkDir = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walkDir(f);
      else if (f.endsWith('.mjs') && !f.endsWith(JOIN)) {
        fs.readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, k) => {
            if (FORBIDDEN.some((re) => re.test(line))) {
              hits.push(
                `${path.relative(path.join(__dirname, '..'), f)}:${k + 1}`,
              );
            }
          });
      }
    }
  };
  walkDir(path.join(__dirname, '..', 'src'));
  assert.deepStrictEqual(hits, [], 'time shifted outside the join');
});

// ── The shift is never saved into the data ──────────────────────────────────

const withoutDelayLine = (csv) =>
  csv
    .split('\n')
    .filter((l) => !l.startsWith('# ResponseDelay:'))
    .join('\n');

test('export at 2 s is the export at 0 s, plus the delay written in the header', () => {
  const a = walk({}, 0);
  const csv0 = a.exportToCSV(GSR_CONST.GSR_DEFAULT, GSR_CONST.GPS_DEFAULT);
  a.setResponseDelay(2);
  const csv2 = a.exportToCSV(GSR_CONST.GSR_DEFAULT, GSR_CONST.GPS_DEFAULT);
  assert.match(csv2, /^# ResponseDelay:2(\.0)?$/m);
  assert.strictEqual(withoutDelayLine(csv2), withoutDelayLine(csv0));
});

test('reloading an export gives the same places — no double shift', () => {
  const a = walk({}, 2);
  const b = new GSRAnalyzer();
  b.parseCSV(a.exportToCSV(GSR_CONST.GSR_DEFAULT, GSR_CONST.GPS_DEFAULT));
  b.setResponseDelay(2);
  GpsPipeline.ensureFilteredGps(b, GSR_CONST.GPS_DEFAULT);
  assert.strictEqual(b.raw.length, a.raw.length);
  for (let i = 0; i < a.raw.length; i += 7) {
    const p = a.placeOf(i);
    const q = b.placeOf(i);
    if (!p) {
      assert.strictEqual(q, null, `reading ${i}`);
      continue;
    }
    close(p.lat, q.lat, 1e-6, `reading ${i} lat`);
    close(p.lon, q.lon, 1e-6, `reading ${i} lon`);
  }
});

// ── Timestamps (step 3) ─────────────────────────────────────────────────────

test('old clock-text files: every row stays inside its own labelled second', {
  todo: STEP3,
}, () => {
  const { csv, labels } = isoWalkCsv();
  const a = new GSRAnalyzer();
  a.parseCSV(csv);
  a.raw.forEach((r, i) => {
    const offset = r.time - (labels[i] - labels[0]);
    assert.ok(
      offset >= 0 && offset < 1,
      `row ${i}: ${offset.toFixed(3)} s into its second`,
    );
  });
});

test('device hold-up: readings stamped more than 0.5 s from their real time get no place', {
  todo: STEP3,
}, () => {
  // Normal 100 ms ticks, a start-up delay on the first row (as in every real
  // file; it shifts the whole walk equally, so it doesn't count), then a 3 s
  // hold-up at row 600 caught up by a burst of instant ticks.
  const tickDt = (i) => {
    if (i === 0) return 533;
    if (i === 600) return 3000;
    if (i > 600 && i < 630) return 0;
    return 100;
  };
  const a = walk({ tickDt }, 0);
  // Real time runs ahead of the label from row 600 by 2.9 s, catching up by
  // 0.1 s a row: more than 0.5 s off for rows 600–623.
  for (let i = 600; i <= 623; i++) {
    assert.strictEqual(a.placeOf(i), null, `row ${i}`);
  }
  for (const i of [100, 590, 624, 640, 1500]) {
    assert.ok(a.placeOf(i), `row ${i} is on time`);
  }
});

test('dashboard: "the last second" is one second at any sample rate', {
  todo: STEP3,
}, () => {
  const a = walk({ hz: 10 / 3 }, 0); // live-stream rate
  a.isEnriched = true;
  const samples = EnvironmentalStats.buildSamples(
    [{ id: 'w', analyzer: a }],
    () => 0,
  );
  assert.ok(samples.length > 100);
  for (const s of samples) {
    const win = a.raw.filter((r) => r.time > s.time - 1 && r.time <= s.time);
    const mean = win.reduce((sum, r) => sum + r.val, 0) / win.length;
    close(s.val, mean, 1e-9, `sample at ${s.time} s`);
  }
});
