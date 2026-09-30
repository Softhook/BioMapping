/**
 * Direct tests for spatial/environmental_stats.mjs — the Environmental
 * Analysis maths, called without the dashboard UI or any DOM. The UI-level
 * behaviour (caching, FDR, road-class skipping, Bonferroni) is covered by
 * test_env_dashboard_cache.js; this file covers what only shows up with
 * several walks: how the verdict is graded by how many walks there are.
 *
 * Run: node --test tests/test_environmental_stats.js
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
const { loadModule } = require('./support/load_module.js');
loadModule(path.join(__dirname, '../src/gps/geo_utils.mjs'));
loadModule(path.join(__dirname, '../src/gps/gps_pipeline.mjs'));

const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const {
  EnvironmentalStats,
} = require('../src/spatial/environmental_stats.mjs');

const csvText = fs.readFileSync(
  path.join(__dirname, '../fixtures/default_processed.csv'),
  'utf8',
);

// One analysed copy of the fixture; each walk gets its own shallow copy with
// a different environment pattern, so per-walk correlations differ.
const base = new GSRAnalyzer();
base.parseCSV(csvText);
base.analyze(GSR_CONST.GSR_DEFAULT, 0);

function walk(id, seed) {
  const a = Object.create(base);
  a.raw = base.raw.map((pt, i) => ({
    ...pt,
    osm_road_class: ['residential', 'path', 'primary'][(i + seed) % 3],
    // Prime periods: the 1 Hz sampling takes every 10th row, so a period
    // dividing 10 would read as a constant.
    osm_dist_major_road: 20 + ((i * (seed + 1)) % 53),
    osm_in_park: (i + seed) % 7 === 0,
    osm_green_pct_50m: ((i + seed * 13) % 100) / 100,
  }));
  a.isEnriched = true;
  return { id, analyzer: a };
}

const walks = (n) => Array.from({ length: n }, (_, k) => walk(`w${k}`, k));
const row = (stats, key) => stats.correlationMatrix.find((r) => r.key === key);

test('compute: runs with no DOM at all', () => {
  assert.strictEqual(typeof document, 'undefined');
  const stats = EnvironmentalStats.compute(walks(1), () => 0);
  assert.ok(stats.allData.length > 0);
  assert.ok(stats.correlationMatrix.length > 0);
  assert.ok(stats.roadProfile.length > 0);
  assert.ok(
    stats.roadProfile.every((p) => !('_sePhasic' in p)),
    'internal SE is dropped from the result',
  );
});

test('correlationMatrix: verdict is graded by walk count (1 → single, 2 → fewWalks, 3–4 → provisional, 5+ → meta)', () => {
  const expect = [
    [1, 'single'],
    [2, 'fewWalks'],
    [3, 'metaProvisional'],
    [4, 'metaProvisional'],
    [5, 'meta'],
  ];
  for (const [n, method] of expect) {
    const r = row(
      EnvironmentalStats.compute(walks(n), () => 0),
      'osm_dist_major_road',
    );
    assert.strictEqual(r.mPhasic, method, `${n} walks → ${method}`);
    assert.strictEqual(r.featureWalks, n);
    if (method === 'fewWalks') {
      assert.ok(Number.isNaN(r.pPhasic), 'few walks: effect size only, no p');
      assert.ok(Number.isNaN(r.qPhasic), 'few walks: no q either');
    }
    if (method === 'metaProvisional') {
      assert.ok(Number.isFinite(r.pPhasic), 'provisional keeps its p');
      assert.ok(Number.isNaN(r.qPhasic), 'but gets no FDR q');
    }
  }
});

test('correlationMatrix: speed-adjusted tonic channel follows the same grading', () => {
  const r = row(
    EnvironmentalStats.compute(walks(3), () => 0),
    'osm_dist_major_road',
  );
  assert.strictEqual(r.mTonicSpeedAdj, 'metaProvisional');
  assert.ok(Number.isFinite(r.rTonicSpeedAdj));
});

// A walk whose first `blankRows` rows have no position (GPS warm-up).
function walkWithWarmup(blankRows) {
  const w = walk('warm', 0);
  w.analyzer.raw = w.analyzer.raw.map((pt, i) =>
    i < blankRows ? { ...pt, lat: NaN, lon: NaN } : pt,
  );
  return w;
}

test('roadProfile: peaks at moments with no position are not counted', () => {
  const BLANK = 200; // 20 s; the fixture has peaks inside it
  const w = walkWithWarmup(BLANK);
  const a = w.analyzer;
  const live = a.peaks.filter((p) => !p.excluded);
  const positioned = live.filter((p) => p.index >= BLANK).length;
  assert.ok(live.length > positioned, 'fixture has warm-up peaks');

  const { roadProfile } = EnvironmentalStats.compute([w], () => 0);
  const counted = roadProfile.reduce(
    (s, r) => s + Math.round((r.peakRate * r.timeSpent) / 60),
    0,
  );
  assert.strictEqual(counted, positioned);
});

test('peakCountsPerSample: a 15 s bin shared with the warm-up counts only positioned peaks', () => {
  const BLANK = 200; // t = 20 s, inside the 15-30 s bin
  const w = walkWithWarmup(BLANK);
  const a = w.analyzer;
  const allData = EnvironmentalStats.buildSamples([w], () => 0);
  const counts = EnvironmentalStats.peakCountsPerSample([w], allData);
  const first = allData[0];
  const bin = Math.floor(first.time / 15);
  const inBin = (p) => !p.excluded && Math.floor(p.time / 15) === bin;
  assert.ok(
    a.peaks.some((p) => inBin(p) && p.index < BLANK),
    'fixture has a warm-up peak in the first positioned bin',
  );
  assert.strictEqual(
    counts[0],
    a.peaks.filter((p) => inBin(p) && p.index >= BLANK).length,
  );
});

test('compareRoadExtremes: null with fewer than two road classes', () => {
  assert.strictEqual(EnvironmentalStats.compareRoadExtremes([]), null);
  assert.strictEqual(
    EnvironmentalStats.compareRoadExtremes([
      { name: 'path', meanPhasic: 1, _sePhasic: { se: 0.1, df: 10 } },
    ]),
    null,
  );
});
