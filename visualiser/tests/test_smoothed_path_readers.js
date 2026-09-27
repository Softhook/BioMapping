/**
 * The smoothed GPS path (analyzer.filteredGps — what the map draws) is built
 * on demand by GpsPipeline.ensureFilteredGps, and the analyses that need
 * positions read it instead of the parser's straight-line fill.
 *
 * Run: node --test tests/test_smoothed_path_readers.js
 */
const assert = require('node:assert');
const test = require('node:test');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
const { GpsPipeline } = require('../src/gps/gps_pipeline.mjs');
const { NDVISampler } = require('../src/osm/ndvi_sampler.mjs');
const { GSRArousalPlaces } = require('../src/spatial/arousal_places.mjs');

/**
 * A 10 Hz walk heading north at ~1.1 m/s with a GPS fix every 10 rows. One
 * fix is thrown 60 m sideways (a multipath-style jump) and the rows between
 * fixes carry the parser's straight-line fill, as the CSV parser leaves them.
 */
function walkAnalyzer() {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const isFix = i % 10 === 0;
    const lat = 51.5 + i * 1e-6;
    const lon = -0.1 + (i === 200 ? 0.00085 : 0);
    rows.push({
      time: i / 10,
      val: 1,
      lat,
      lon,
      hdop: 1,
      fixType: 3,
      speedKts: 2.1,
      course: 0,
      hasGps: true,
      _isGpsFix: isFix,
    });
  }
  const a = new GSRAnalyzer();
  a.raw = rows;
  return a;
}

test('ensureFilteredGps builds the smoothed path on the analyzer', () => {
  const a = walkAnalyzer();
  assert.strictEqual(a.filteredGps.length, 0);
  const fixes = GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  assert.ok(fixes.length > 0);
  assert.strictEqual(a.filteredGps.length, a.raw.length);
  // getCoordinates now answers from the smoothed path, not the raw row.
  const c = a.getCoordinates(200);
  assert.deepStrictEqual(c, {
    lat: a.filteredGps[200].lat,
    lon: a.filteredGps[200].lon,
  });
  assert.notStrictEqual(c.lon, a.raw[200].lon, 'the sideways jump is smoothed');
});

test('ensureFilteredGps skips the work when nothing changed, rebuilds when it did', () => {
  const a = walkAnalyzer();
  const first = GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  const path = a.filteredGps;
  assert.strictEqual(
    GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 }),
    first,
  );
  assert.strictEqual(a.filteredGps, path);

  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 1.5 });
  assert.notStrictEqual(a.filteredGps, path, 'a new maxSpeed rebuilds');
});

test('ensureFilteredGps leaves a track with no fixes alone', () => {
  const a = new GSRAnalyzer();
  a.raw = [{ time: 0, lat: NaN, lon: NaN }];
  assert.deepStrictEqual(GpsPipeline.ensureFilteredGps(a, {}), []);
  assert.strictEqual(a.filteredGps.length, 0);
  assert.strictEqual(a.getCoordinates(0), null);
});

test('NDVI sampling positions are the smoothed path, built even if the map never drew the walk', () => {
  const a = walkAnalyzer();
  const positions = NDVISampler._trackPositions({
    analyzer: a,
    gpsFilterParams: { maxHdop: 3, maxSpeed: 3 },
  });
  assert.strictEqual(positions.length, a.raw.length);
  for (const { index, pt } of positions) {
    assert.strictEqual(pt.lat, a.filteredGps[index].lat);
    assert.strictEqual(pt.lon, a.filteredGps[index].lon);
  }
});

test('Arousal Places scores dwell against the smoothed path, raw rows only as fallback', () => {
  const a = walkAnalyzer();
  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  const trk = {
    id: 't',
    raw: a.raw,
    filteredGps: a.filteredGps,
    phasic: [],
    latency: 0,
  };
  const flat = GSRArousalPlaces._getOrBuildFastCoords(trk);
  assert.strictEqual(flat.lats[200], a.filteredGps[200].lat);
  assert.strictEqual(flat.lons[200], a.filteredGps[200].lon);

  // A row where the path is blank falls back to the raw row.
  const holed = a.filteredGps.slice();
  holed[5] = { lat: NaN, lon: NaN };
  const flat2 = GSRArousalPlaces._getOrBuildFastCoords({
    ...trk,
    filteredGps: holed,
  });
  assert.strictEqual(flat2.lats[5], a.raw[5].lat);
  assert.strictEqual(flat2.flags[5], 1);
});
