/**
 * Rows before the first GPS fix (or after the last) can't be placed on the
 * map, so they must not change anything on it:
 *  - the group map measures each walk against its normal level from the part
 *    of the walk with a position (collective_manager.mjs);
 *  - the hotspot count is a percentile of the peaks that can be placed
 *    (analyzer._selectMemorableEvents).
 *
 * Run: node --test tests/test_gps_part_baseline.js
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
global.MarchingSquares =
  require('../src/render/marching_squares.mjs').MarchingSquares;

const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { GsrFilter } = require('../src/signal/gsr_filter.mjs');
const {
  GSRCollectiveManager,
} = require('../src/spatial/collective_manager.mjs');

const csvText = fs.readFileSync(
  path.join(__dirname, '../fixtures/default_processed.csv'),
  'utf8',
);
const WARMUP = 1500; // 150 s with no position

// The fixture, analysed, with a synthetic path and no position for the
// first WARMUP rows. `bump` shifts every warm-up value; derived series are
// rebuilt the way analyze() builds them.
function warmupWalk(bump) {
  const a = new GSRAnalyzer();
  a.parseCSV(csvText);
  a.analyze(GSR_CONST.GSR_DEFAULT, 0);
  a.filteredGps = [];
  a.raw.forEach((r, i) => {
    r.lat = i < WARMUP ? NaN : 51.5 + (i - WARMUP) * 2e-6;
    r.lon = i < WARMUP ? NaN : -0.1 + ((i * 7) % 50) * 2e-6;
  });
  for (const key of [
    'tonic',
    'phasic',
    'phasicAUC',
    'filtered',
    'peakDensity',
  ]) {
    a[key] = a[key].map((d, i) => ({
      time: d.time,
      val: i < WARMUP ? d.val + bump : d.val,
    }));
  }
  a.tonicZ = GsrFilter.standardizeSignal(a.tonic);
  a.phasicZ = GsrFilter.standardizeSignal(a.phasic);
  a.phasicStd = GsrFilter.calculateStats(a.phasic.map((d) => d.val)).std;
  const ai = GSR_CONST.AROUSAL_INDEX;
  a.arousalIndex = a.computeCombinedArousalIndex(
    ai.wTonic,
    ai.wPhasic,
    a.phasicAUC,
  );
  const tri = GSR_CONST.TRI_INDEX;
  a.triIndex = a.computeTriIndex(
    tri.wTonic,
    tri.wPhasic,
    tri.wDensity,
    a.phasicAUC,
    a.peakDensity,
  );
  return a;
}

function surface(a, topographySource) {
  const cm = new GSRCollectiveManager();
  cm.addTrack({
    id: 'w',
    enabled: true,
    analyzer: a,
    gpsFilterParams: { peakLatency: 0 },
  });
  const r = cm.generateContourSurface({
    topographySource,
    normalizeZScore: true,
    gridResolution: 12,
    temporalSmoothingWindow: 0, // no smoothing across the warm-up boundary
  });
  return JSON.stringify(r.grid);
}

const calm = warmupWalk(0);
const wild = warmupWalk(50); // warm-up readings wildly different

for (const src of [
  'phasic',
  'tonic',
  'auc',
  'gsr',
  'peak_density',
  'arousal_index',
  'tri_index',
  'peaks',
]) {
  test(`group map (${src}): warm-up readings don't move the walk's normal level`, () => {
    assert.strictEqual(surface(wild, src), surface(calm, src));
  });
}

test('hotspot count is a percentile of the peaks that can be placed', () => {
  const a = new GSRAnalyzer();
  // 10 peaks 1 km apart (no spacing rule kicks in); 5 have no position.
  a.raw = Array.from({ length: 10 }, (_, i) => ({
    time: i,
    lat: i < 5 ? NaN : 51.5 + i * 0.01,
    lon: i < 5 ? NaN : -0.1,
  }));
  a.filteredGps = [];
  a.peaks = a.raw.map((_r, i) => ({ index: i, time: i, amplitude: 10 - i }));
  const hot = a._selectMemorableEvents({ hotspotPercentile: 0.4 }, 0);
  // 40 % of the 5 placeable peaks, not of all 10.
  assert.strictEqual(hot.length, 2);
  assert.deepStrictEqual(
    hot.map((p) => p.index),
    [5, 6],
  );
});
