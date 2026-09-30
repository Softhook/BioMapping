/**
 * The smoothed GPS path (analyzer.filteredGps — what the map draws) is built
 * on demand by GpsPipeline.ensureFilteredGps, and the analyses that need
 * positions read it instead of the parser's straight-line fill. OSM
 * enrichment reads the same path minus the road-snap pull (which it makes).
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
const { OSMEnricher } = require('../src/osm/osm_enrichment.mjs');

/**
 * A 10 Hz walk heading north at ~1.1 m/s with a GPS fix every 10 rows. One
 * fix is thrown 60 m sideways (a multipath-style jump) and the rows between
 * fixes carry the parser's straight-line fill, as the CSV parser leaves them.
 */
function walkAnalyzer() {
  const rows = [];
  // Ends on a fix (row 400): rows after the last fix have no smoothed position.
  for (let i = 0; i <= 400; i++) {
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

test('OSM enrichment matches from the smoothed path, not the straight line', () => {
  const a = walkAnalyzer();
  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  const pos = OSMEnricher._enrichmentPositions(a);
  const at200 = pos.find((p) => p.idx === 200);
  assert.strictEqual(at200.lat, a.filteredGps[200].lat);
  assert.strictEqual(at200.lon, a.filteredGps[200].lon);
  assert.notStrictEqual(at200.lon, a.raw[200].lon);
});

test('OSM enrichment ignores an earlier road snap (no feedback loop)', () => {
  const a = walkAnalyzer();
  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  const before = OSMEnricher._enrichmentPositions(a).map((p) => [p.lat, p.lon]);

  // An earlier enrichment snapped every row 30 m east (fully trusted).
  a.snappedGps = a.raw.map((r) => ({
    roadLat: r.lat,
    roadLon: r.lon + 0.00043,
    alpha: 1,
  }));
  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 3 });
  assert.notDeepStrictEqual(
    a.filteredGps.map((p) => [p.lat, p.lon]),
    before,
    'the drawn path now carries the snap pull',
  );
  const after = OSMEnricher._enrichmentPositions(a).map((p) => [p.lat, p.lon]);
  assert.deepStrictEqual(after, before, 'enrichment input is unchanged');
});

test('a caller without GPS settings keeps the path on the settings it was built with', () => {
  const a = walkAnalyzer();
  GpsPipeline.ensureFilteredGps(a, { maxHdop: 3, maxSpeed: 1.5 });
  const path = a.filteredGps;
  GpsPipeline.ensureFilteredGps(a); // e.g. NDVI given a bare analyzer
  assert.strictEqual(a.filteredGps, path, 'not rebuilt with the defaults');
  assert.deepStrictEqual(a._pathParams, { maxHdop: 3, maxSpeed: 1.5 });
});
