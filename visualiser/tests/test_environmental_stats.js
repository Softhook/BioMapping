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
base.analyze(GSR_CONST.GSR_DEFAULT);

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
  // analyze() built the smoothed path too; blank it the same way.
  w.analyzer.filteredGps = base.filteredGps.map((c, i) =>
    i < blankRows ? { lat: NaN, lon: NaN } : c,
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

// A copy of the fixture walk with its own speed column and road classes.
function walkWith(id, perRow) {
  const a = Object.create(base);
  a.raw = base.raw.map((pt, i) => ({ ...pt, ...perRow(pt, i) }));
  a.isEnriched = true;
  return { id, analyzer: a };
}

test('buildSamples: a second with no speed reading has no speed, not 0 m/s', () => {
  const half = base.raw[Math.floor(base.raw.length / 2)].time;
  const w = walkWith('w', (pt) => ({
    osm_road_class: 'residential',
    speedKts: pt.time < half ? NaN : 2,
  }));
  w.analyzer.setResponseDelay?.(0);
  const samples = EnvironmentalStats.buildSamples([w]);
  const early = samples.filter((d) => d.time < half - 2);
  const late = samples.filter((d) => d.time > half + 2);
  assert.ok(early.length > 100 && late.length > 100);
  assert.ok(
    early.every((d) => Number.isNaN(d.speed) && Number.isNaN(d.tonicSpeed)),
    'no reading → blank',
  );
  assert.ok(late.every((d) => Math.abs(d.speed - 2 * 0.514444) < 1e-9));
});

test('speed adjustment uses only the seconds that have a speed reading', () => {
  const w = {
    xTonic: Array.from({ length: 30 }, (_, i) => i),
    tonic: Array.from({ length: 30 }, (_, i) => i * 2),
    speedTonic: Array.from({ length: 30 }, (_, i) =>
      i % 2 ? NaN : 1 + (i % 7),
    ),
  };
  const s = EnvironmentalStats._speedSeries(w);
  assert.strictEqual(s.z.length, 15);
  assert.ok(s.z.every(Number.isFinite));
  assert.deepStrictEqual(
    s.x,
    w.xTonic.filter((_, i) => i % 2 === 0),
  );
  // Too few readings cannot support an adjustment.
  const sparse = {
    ...w,
    speedTonic: w.speedTonic.map((v, i) => (i < 6 ? v : NaN)),
  };
  assert.strictEqual(EnvironmentalStats._speedSeries(sparse), null);
  const res = EnvironmentalStats._speedResiduals(s);
  assert.strictEqual(res.x.length, 15);
  assert.strictEqual(res.nCovariates, 1);
});

test('one walk with no speed at all: no speed-adjusted figure is reported', () => {
  const w = walkWith('w', (_pt, i) => ({
    osm_road_class: 'residential',
    osm_dist_major_road: 20 + ((i * 3) % 53),
    speedKts: NaN,
  }));
  const r = row(EnvironmentalStats.compute([w]), 'osm_dist_major_road');
  assert.ok(Number.isNaN(r.rTonicSpeedAdj));
});

test('collective speed adjustment excludes walks without usable speed', () => {
  const feature = { name: 'feature', key: 'feature', binary: false };
  const samples = (trackId, hasSpeed) =>
    Array.from({ length: 100 }, (_, i) => ({
      trackId,
      time: i,
      feature: (i * 13) % 17,
      tonic: ((i * 7) % 19) + ((i * 13) % 17),
      phasic: (i * 3) % 11,
      speed: hasSpeed ? (i * 5) % 13 : NaN,
      tonicSpeed: hasSpeed ? (i * 5) % 13 : NaN,
    }));
  const usable = samples('usable', true);
  const missing = samples('missing', false);
  const single = EnvironmentalStats._featureRow(feature, usable, []);
  const combined = EnvironmentalStats._featureRow(
    feature,
    usable.concat(missing),
    [],
  );
  assert.ok(Math.abs(combined.rTonicSpeedAdj - single.rTonicSpeedAdj) < 1e-9);
  assert.ok(Math.abs(combined.rTonicSpeedBase - single.rTonicSpeedBase) < 1e-9);
});

test('roadProfile: a walk with no road data (NDVI only) adds no "none" row', () => {
  const ndviOnly = walkWith('ndvi', () => ({
    osm_road_class: undefined,
    ndvi: 0.4,
    ndvi_50m: 0.4,
  }));
  const alone = EnvironmentalStats.compute([ndviOnly]);
  assert.deepStrictEqual(alone.roadProfile, []);
  assert.strictEqual(alone.roadComparison, null);

  const roads = walk('roads', 0);
  const justRoads = EnvironmentalStats.compute([roads]);
  const mixed = EnvironmentalStats.compute([roads, ndviOnly]);
  const brief = (p) => [p.name, p.timeSpent, p.peakRate];
  assert.deepStrictEqual(
    mixed.roadProfile.map(brief),
    justRoads.roadProfile.map(brief),
    'the NDVI-only walk changes nothing in the road profile',
  );
  assert.strictEqual(mixed.roadComparison.nWalks, 1);
});

test('roadComparison says how many walks it covers', () => {
  assert.strictEqual(
    EnvironmentalStats.compute(walks(1)).roadComparison.nWalks,
    1,
  );
  assert.strictEqual(
    EnvironmentalStats.compute(walks(3)).roadComparison.nWalks,
    3,
  );
});
