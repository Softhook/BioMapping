'use strict';
/**
 * Regression coverage for the `_collectGpsPoints()` field-trimming fix
 * (docs/visualizer_rendering_perf_routes.md §2.7; map.js). Found via
 * profiling, not a read-through: `_collectGpsPoints()` used to spread the
 * FULL ~29-field raw CSV row (`{ ...data[i], origIdx: i }`) for every GPS
 * fix, and every filter stage between there and `reconstructFilteredGps()`
 * (gate/speed/velocity/stop-averaging/Kalman) re-spreads whatever shape it's
 * handed — so the extra fields (rssi_*, osm_*, em_fog, val, sats, hasGps,
 * _isGpsFix) got copied at every stage despite never being read by any of
 * them. The intermediate `gpsPoints` array is fully internal to
 * `_getOrBuildDrawPoints()` — no caller destructures it, only `drawPoints`,
 * which is built separately straight from the raw row — so trimming it is
 * safe. Run: node --test tests/test_gps_collect_points.js
 */

const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

// A CSV with the fields _collectGpsPoints's pipeline actually reads (lat,
// lon, hdop, pdop, hacc_m, speed_kts, course_deg, fix_type) PLUS several
// fields it must NOT carry through (rssi_815, osm_road_class, sats) — proof
// the trim drops the latter without disturbing the former.
function buildCsv(rows) {
  const header = 'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m,rssi_815,osm_road_class';
  const lines = rows.map((r, i) => {
    const t = (i * 0.1).toFixed(2);
    const lat = (51.5074 + i * 0.0001).toFixed(6);
    const lon = (-0.1278 + i * 0.0001).toFixed(6);
    return `${t},${lat},${lon},1.0,1.5,8,3,0.5,90,10000,3.0,-75.5,residential`;
  });
  return [header, ...lines].join('\n');
}
const SAMPLE_CSV = buildCsv(Array(20).fill(0));

const EXPECTED_KEYS = ['lat', 'lon', 'time', 'hdop', 'pdop', 'hacc', 'speedKts', 'course', 'fixType', 'origIdx'].sort();

function boot() {
  const { window, context } = bootApp();
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
  window.setup();
  return { window, mapManager: window.AppState.mapManager };
}

test('_collectGpsPoints: returns only the fields the GPS pipeline reads, not the full raw row', () => {
  const { window, mapManager } = boot();
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(SAMPLE_CSV);

  // Sanity: the raw row itself DOES carry the extra fields (proves the
  // fixture is exercising the trim, not just an already-narrow row).
  const rawKeys = Object.keys(analyzer.raw[0]);
  assert.ok(rawKeys.includes('rssi_815'), 'fixture sanity: raw row has rssi_815');
  assert.ok(rawKeys.includes('osm_road_class'), 'fixture sanity: raw row has osm_road_class');
  assert.ok(rawKeys.includes('sats'), 'fixture sanity: raw row has sats');

  const pts = mapManager._collectGpsPoints(analyzer.raw);
  assert.ok(pts.length > 0, 'fixture produces at least one GPS fix');

  for (const pt of pts) {
    assert.deepStrictEqual(Object.keys(pt).sort(), EXPECTED_KEYS,
      'gpsPoints entry must carry exactly the fields the pipeline reads, no more');
    assert.ok(!('rssi_815' in pt), 'rssi_815 must not leak into gpsPoints');
    assert.ok(!('osm_road_class' in pt), 'osm_road_class must not leak into gpsPoints');
    assert.ok(!('sats' in pt), 'sats must not leak into gpsPoints');
  }
});

test('_collectGpsPoints: preserves values for every field it does carry', () => {
  const { window, mapManager } = boot();
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(SAMPLE_CSV);

  const pts = mapManager._collectGpsPoints(analyzer.raw);
  const raw = analyzer.raw;
  for (const pt of pts) {
    const src = raw[pt.origIdx];
    assert.strictEqual(pt.lat, src.lat);
    assert.strictEqual(pt.lon, src.lon);
    assert.strictEqual(pt.time, src.time);
    assert.strictEqual(pt.hdop, src.hdop);
    assert.strictEqual(pt.pdop, src.pdop);
    assert.strictEqual(pt.hacc, src.hacc);
    assert.strictEqual(pt.speedKts, src.speedKts);
    assert.strictEqual(pt.course, src.course);
    assert.strictEqual(pt.fixType, src.fixType);
  }
});

test('_collectGpsPoints: full pipeline output (drawPoints) still carries every raw field untouched', () => {
  // The trim only touches the internal gpsPoints intermediate — drawPoints
  // (what every caller actually consumes, and what the coloring-metric
  // dropdown reads arbitrary raw fields like osm_road_class/rssi_815 from
  // dynamically via `_getMetricKey()`) is built straight from `data[i]`, not
  // from gpsPoints, so it must be completely unaffected.
  const { window, mapManager } = boot();
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(SAMPLE_CSV);
  const gpsParams = { maxHdop: 2.0, smoothing: 0.5, kalmanR: 10, maxSpeed: 30.0, rdpTolerance: 0, downsample: false };

  const { drawPoints } = mapManager._getOrBuildDrawPoints('test-track', analyzer, gpsParams);
  assert.ok(drawPoints.length > 0, 'pipeline produces draw points from the fixture');
  for (const dp of drawPoints) {
    const src = analyzer.raw[dp.origIdx];
    assert.strictEqual(dp.rssi_815, src.rssi_815, 'rssi_815 must survive into drawPoints (RF fluid renderer reads it)');
    assert.strictEqual(dp.osm_road_class, src.osm_road_class, 'osm_road_class must survive into drawPoints (coloring metric dropdown reads it)');
  }
});
