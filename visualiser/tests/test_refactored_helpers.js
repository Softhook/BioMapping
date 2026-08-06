/**
 * Unit tests for functions extracted or newly named during the refactoring
 * session — covering areas with no prior direct test coverage:
 *
 *   1. GSRAnalyzer.calcEmFog()          — static pure function
 *   2. GSRAnalyzer._interpolateGPS()    — extracted from parseCSV()
 *   3. GpsFilter._kalmanForwardPass()   — split from applyKalman()
 *   4. GpsFilter._rtsBackwardPass()     — split from applyKalman()
 *
 * Run: node --test tests/test_refactored_helpers.js
 *      or: npm test  (picked up by the glob)
 */

'use strict';

const assert = require('assert');
const test   = require('node:test');
const fs     = require('fs');
const vm     = require('vm');
const path   = require('path');

// ── Loader helpers ────────────────────────────────────────────────────────────
global.window    = global;
global.GSR_CONST = require('./mock_constants.js');

function loadBrowserModule(relPath, varName) {
  const src     = fs.readFileSync(path.join(__dirname, relPath), 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`),  `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: relPath });
}

loadBrowserModule('../geo_utils.js',    'GeoUtils');
loadBrowserModule('../stats_math.js',   'StatsMath');
loadBrowserModule('../map_colors.js',   'MapColors');
loadBrowserModule('../gps_filter.js',   'GpsFilter');
loadBrowserModule('../gps_pipeline.js', 'GpsPipeline');
loadBrowserModule('../dwt_filter.js',   'DWT');
loadBrowserModule('../gsr_filter.js',   'GsrFilter');
loadBrowserModule('../deconvolution.js','SCRDeconvolution');
loadBrowserModule('../map_exporter.js', 'GSRMapExporter');
loadBrowserModule('../tracks.js',       'GSRTrackManager');
loadBrowserModule('../ui.js',           'GSRUI');

const analyzerSrc = fs.readFileSync(path.join(__dirname, '../analyzer.js'), 'utf8');
vm.runInThisContext(analyzerSrc, { filename: 'analyzer.js' });

const GpsFilter   = global.GpsFilter;
const GSRAnalyzer = global.GSRAnalyzer;
const GeoUtils    = global.GeoUtils;
const StatsMath   = global.StatsMath;
const GSRMapExporter = global.GSRMapExporter;
const GSRTrackManager = global.GSRTrackManager;
const GSRUI          = global.GSRUI;

// ── Shared helpers ────────────────────────────────────────────────────────────
const closeTo = (actual, expected, tol, msg) => {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg || ''} — got ${actual}, expected within ±${tol} of ${expected}`);
};

const pt = (lat, lon, t, extra = {}) => ({ lat, lon, time: t, ...extra });

function straightTrack(lat0, lon0, lat1, lon1, n, dtSec = 1) {
  return Array.from({ length: n }, (_, i) => {
    const f = n > 1 ? i / (n - 1) : 0;
    return pt(lat0 + f * (lat1 - lat0), lon0 + f * (lon1 - lon0), i * dtSec);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  1. GSRAnalyzer.calcEmFog
// ══════════════════════════════════════════════════════════════════════════════

test('calcEmFog: all bands missing → NaN', () => {
  assert.ok(isNaN(GSRAnalyzer.calcEmFog({})));
});

test('calcEmFog: all bands at floor (−100 dBm default) → 0', () => {
  const row = { rssi_300: -100, rssi_315: -100, rssi_434: -100,
                rssi_446: -100, rssi_815: -100, rssi_868: -100, rssi_915: -100 };
  closeTo(GSRAnalyzer.calcEmFog(row), 0, 0.01, 'all-at-floor → 0');
});

test('calcEmFog: all bands at ceiling (−30 dBm) → 100', () => {
  const row = { rssi_300: -30, rssi_315: -30, rssi_434: -30,
                rssi_446: -30, rssi_815: -30, rssi_868: -30, rssi_915: -30 };
  closeTo(GSRAnalyzer.calcEmFog(row), 100, 0.01, 'all-at-ceiling → 100');
});

test('calcEmFog: single band at ceiling → 100', () => {
  closeTo(GSRAnalyzer.calcEmFog({ rssi_868: -30 }), 100, 0.01, 'single ceiling → 100');
});

test('calcEmFog: single band at floor → 0', () => {
  closeTo(GSRAnalyzer.calcEmFog({ rssi_868: -100 }), 0, 0.01, 'single floor → 0');
});

test('calcEmFog: midpoint (−65 dBm, floor −100) → 50', () => {
  // norm = (-65−(-100)) / (-30−(-100)) = 35/70 = 0.5 → sqrt(0.25)*100 = 50
  closeTo(GSRAnalyzer.calcEmFog({ rssi_868: -65 }), 50, 0.5, 'midpoint → 50');
});

test('calcEmFog: value above ceiling is clamped to 100', () => {
  closeTo(GSRAnalyzer.calcEmFog({ rssi_868: 0 }), 100, 0.01, 'above ceiling clamped');
});

test('calcEmFog: custom bandFloors shift the scale', () => {
  // floor=−80: norm at −55 = (−55−(−80))/(−30−(−80)) = 25/50 = 0.5 → 50
  closeTo(GSRAnalyzer.calcEmFog({ rssi_868: -55 }, { '868': -80 }), 50, 0.5, 'custom floor');
});

test('calcEmFog: NaN band values are skipped, valid ones still counted', () => {
  closeTo(GSRAnalyzer.calcEmFog({ rssi_300: NaN, rssi_868: -30 }), 100, 0.01, 'NaN bands skipped');
});

test('calcEmFog: two bands (norm=0 and norm=1) → RMS = 70.71', () => {
  // sqrt((0²+1²)/2)*100 = 70.71
  closeTo(GSRAnalyzer.calcEmFog({ rssi_300: -100, rssi_868: -30 }), 70.71, 0.5, 'RMS of 0 and 1');
});

// ══════════════════════════════════════════════════════════════════════════════
//  2. GSRAnalyzer._interpolateGPS
// ══════════════════════════════════════════════════════════════════════════════

function makeAnalyzer() { return new GSRAnalyzer(); }

function makeRows(pts) {
  return pts.map(p => ({
    lat: p.lat, lon: p.lon, time: p.time,
    sats: 0, hdop: NaN, pdop: NaN,
    fixType: 0, speedKts: NaN, course: NaN, hasGps: false
  }));
}

test('_interpolateGPS: empty array → no-op', () => {
  const rows = [];
  makeAnalyzer()._interpolateGPS(rows);
  assert.strictEqual(rows.length, 0);
});

test('_interpolateGPS: all NaN rows → hasGps remains false', () => {
  const rows = makeRows([{ lat: NaN, lon: NaN, time: 0 }, { lat: NaN, lon: NaN, time: 1 }]);
  makeAnalyzer()._interpolateGPS(rows);
  assert.ok(rows.every(r => r.hasGps === false));
});

test('_interpolateGPS: rows before first fix are constant-filled from first fix', () => {
  const rows = makeRows([
    { lat: NaN,  lon: NaN,  time: 0 },
    { lat: NaN,  lon: NaN,  time: 1 },
    { lat: 51.5, lon: -0.1, time: 2 },
    { lat: 51.6, lon: -0.2, time: 3 },
  ]);
  makeAnalyzer()._interpolateGPS(rows);
  assert.strictEqual(rows[0].lat, 51.5, 'row 0 lat filled from first fix');
  assert.strictEqual(rows[0].lon, -0.1, 'row 0 lon filled from first fix');
  assert.strictEqual(rows[1].lat, 51.5, 'row 1 lat filled from first fix');
  assert.ok(rows[0].hasGps === true);
  assert.ok(rows[1].hasGps === true);
});

test('_interpolateGPS: rows after last fix are constant-filled from last fix', () => {
  const rows = makeRows([
    { lat: 51.5, lon: -0.1, time: 0 },
    { lat: 51.6, lon: -0.2, time: 1 },
    { lat: NaN,  lon: NaN,  time: 2 },
    { lat: NaN,  lon: NaN,  time: 3 },
  ]);
  makeAnalyzer()._interpolateGPS(rows);
  assert.strictEqual(rows[2].lat, 51.6, 'row 2 lat filled from last fix');
  assert.strictEqual(rows[3].lon, -0.2, 'row 3 lon filled from last fix');
  assert.ok(rows[2].hasGps === true);
  assert.ok(rows[3].hasGps === true);
});

test('_interpolateGPS: gap between two fixes is linearly interpolated', () => {
  // Use clearly non-zero anchor coords so neither is treated as a sentinel
  const rows = makeRows([
    { lat: 10,  lon: 10,  time: 0 },
    { lat: NaN, lon: NaN, time: 1 },
    { lat: NaN, lon: NaN, time: 2 },
    { lat: 13,  lon: 13,  time: 3 },
  ]);
  makeAnalyzer()._interpolateGPS(rows);
  // ratio at t=1: 1/3 → lat=10 + 1/3*3 = 11
  closeTo(rows[1].lat, 11.0, 1e-10, 'gap t=1 lat');
  closeTo(rows[1].lon, 11.0, 1e-10, 'gap t=1 lon');
  // ratio at t=2: 2/3 → lat=12
  closeTo(rows[2].lat, 12.0, 1e-10, 'gap t=2 lat');
  closeTo(rows[2].lon, 12.0, 1e-10, 'gap t=2 lon');
  assert.ok(rows[1].hasGps === true);
  assert.ok(rows[2].hasGps === true);
});

test('_interpolateGPS: real fix rows get hasGps = true', () => {
  const rows = makeRows([{ lat: 51.0, lon: 0, time: 0 }, { lat: 52.0, lon: 0, time: 1 }]);
  makeAnalyzer()._interpolateGPS(rows);
  assert.ok(rows[0].hasGps === true);
  assert.ok(rows[1].hasGps === true);
});

test('_interpolateGPS: sentinel (0,0) treated as no-fix, filled from real fix', () => {
  // Coordinates (0,0) satisfy abs < 0.0001 — treated as a sentinel, not a real fix
  const rows = makeRows([
    { lat: 0,    lon: 0,    time: 0 },
    { lat: 51.0, lon: -0.1, time: 1 },
  ]);
  makeAnalyzer()._interpolateGPS(rows);
  assert.strictEqual(rows[0].lat, 51.0, 'sentinel row filled from real fix');
  assert.strictEqual(rows[0].lon, -0.1);
});

// ══════════════════════════════════════════════════════════════════════════════
//  3. GpsFilter._kalmanForwardPass
// ══════════════════════════════════════════════════════════════════════════════

function kalmanSetup(R_m2 = 10, Q_m2 = 1) {
  const M2 = (1 / 111320) * (1 / 111320);
  return {
    Q_LAT: Q_m2 * M2, Q_LON: Q_m2 * M2,
    R_LAT_BASE: R_m2 * M2, R_LON_BASE: R_m2 * M2,
    getRLat: () => R_m2 * M2,
    getRLon: () => R_m2 * M2,
  };
}

test('_kalmanForwardPass: output arrays match input length', () => {
  const pts = straightTrack(0, 0, 0.01, 0.01, 10);
  const { Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon } = kalmanSetup();
  const out = GpsFilter._kalmanForwardPass(pts, Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon);
  assert.strictEqual(out.forwardLats.length, 10);
  assert.strictEqual(out.fwdCovLat.length, 10);
});

test('_kalmanForwardPass: index 0 output equals index 0 input', () => {
  const pts = straightTrack(51.5, -0.1, 51.51, -0.09, 5);
  const { Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon } = kalmanSetup();
  const out = GpsFilter._kalmanForwardPass(pts, Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon);
  assert.strictEqual(out.forwardLats[0], pts[0].lat);
  assert.strictEqual(out.forwardLons[0], pts[0].lon);
});

test('_kalmanForwardPass: covariances are all non-negative', () => {
  const pts = straightTrack(0, 0, 0.1, 0.1, 20);
  const { Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon } = kalmanSetup();
  const out = GpsFilter._kalmanForwardPass(pts, Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon);
  assert.ok(out.fwdCovLat.every(v => v >= 0), 'fwdCovLat all ≥ 0');
  assert.ok(out.fwdCovLon.every(v => v >= 0), 'fwdCovLon all ≥ 0');
});

test('_kalmanForwardPass: chi-squared outlier causes covariance inflation', () => {
  // 10-degree jump will fail the chi-squared gate → P inflated 5×
  const pts = [pt(0, 0, 0), pt(0.0001, 0.0001, 1), pt(10, 10, 2), pt(0.0002, 0.0002, 3)];
  const { Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon } = kalmanSetup(1, 0.1);
  const out = GpsFilter._kalmanForwardPass(pts, Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon);
  assert.ok(out.fwdCovLat[2] > out.fwdCovLat[1], 'outlier inflates P at index 2');
});

test('_kalmanForwardPass: stationary signal → output stays on the stationary value', () => {
  const pts = Array.from({ length: 10 }, (_, i) => pt(51.5, -0.1, i));
  const { Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon } = kalmanSetup(1, 0.01);
  const out = GpsFilter._kalmanForwardPass(pts, Q_LAT, Q_LON, R_LAT_BASE, R_LON_BASE, getRLat, getRLon);
  out.forwardLats.forEach((v, i) => closeTo(v, 51.5, 1e-6, `lat[${i}]`));
  out.forwardLons.forEach((v, i) => closeTo(v, -0.1, 1e-6, `lon[${i}]`));
});

// ══════════════════════════════════════════════════════════════════════════════
//  4. GpsFilter._rtsBackwardPass
// ══════════════════════════════════════════════════════════════════════════════

function runForward(pts, R_m2 = 10, Q_m2 = 1) {
  const s = kalmanSetup(R_m2, Q_m2);
  const fwd = GpsFilter._kalmanForwardPass(pts, s.Q_LAT, s.Q_LON, s.R_LAT_BASE, s.R_LON_BASE, s.getRLat, s.getRLon);
  return { ...fwd, Q_LAT: s.Q_LAT, Q_LON: s.Q_LON };
}

const M_TO_DEG_LAT = 1 / 111320;

test('_rtsBackwardPass: output length equals input length', () => {
  const pts = straightTrack(51.5, -0.1, 51.51, -0.09, 8);
  const { forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON } = runForward(pts);
  const r = GpsFilter._rtsBackwardPass(pts, forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON, 10, M_TO_DEG_LAT);
  assert.strictEqual(r.length, pts.length);
});

test('_rtsBackwardPass: last output equals last forward output', () => {
  const pts = straightTrack(51.5, -0.1, 51.51, -0.09, 8);
  const { forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON } = runForward(pts);
  const r = GpsFilter._rtsBackwardPass(pts, forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON, 10, M_TO_DEG_LAT);
  const n = pts.length;
  assert.strictEqual(r[n - 1].lat, forwardLats[n - 1]);
  assert.strictEqual(r[n - 1].lon, forwardLons[n - 1]);
});

test('_rtsBackwardPass: non-positional fields copied from input points', () => {
  const pts = straightTrack(51.5, -0.1, 51.51, -0.09, 5)
    .map((p, i) => ({ ...p, time: i, hdop: 1.2, myField: 42 }));
  const { forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON } = runForward(pts);
  const r = GpsFilter._rtsBackwardPass(pts, forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON, 10, M_TO_DEG_LAT);
  r.forEach((row, i) => {
    assert.strictEqual(row.time, i, `time at ${i}`);
    assert.strictEqual(row.hdop, 1.2, `hdop at ${i}`);
    assert.strictEqual(row.myField, 42, `myField at ${i}`);
  });
});

test('_rtsBackwardPass: displacement from raw GPS clamped to 3σ', () => {
  // Build a scenario where forward outputs are meaningfully far from raw GPS
  // so the clamp has a chance to fire. A low-Q / high-R track where the
  // forward filter lags behind a fast-moving point reveals the clamp behaviour.
  //
  // We verify the invariant: no output point is further from its raw GPS input
  // than 3σ (= 3*sqrt(R_m2)) metres, which is the documented guarantee.
  // Note: the very last point (index n-1) is the starting point of the RTS pass
  // and is not smoothed/clamped by it, so we only check indices 0 to n-2.
  const R_m2 = 1000;  // large noise budget → wide clamp = 3*sqrt(1000) ≈ 94.8 m
  const pts  = straightTrack(51.5, -0.1, 51.55, -0.05, 20);
  const { forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON } = runForward(pts, R_m2, 0.001);
  const r = GpsFilter._rtsBackwardPass(pts, forwardLats, forwardLons, fwdCovLat, fwdCovLon, Q_LAT, Q_LON, R_m2, M_TO_DEG_LAT);
  const maxDeg = 3 * Math.sqrt(R_m2) * M_TO_DEG_LAT;
  assert.strictEqual(r.length, pts.length, 'same length as input');
  for (let i = 0; i < pts.length - 1; i++) {
    const dLat = Math.abs(r[i].lat - pts[i].lat);
    assert.ok(dLat <= maxDeg + 1e-12,
      `point ${i}: displacement ${dLat.toExponential(3)} exceeds 3σ clamp ${maxDeg.toExponential(3)}`);
  }
});

test('applyKalman round-trip: split passes maintain end-to-end accuracy', () => {
  // Use a realistic walking speed track (~1.9 m/s) so the filter doesn't lag.
  // The RTS backward smoother shifts points away from their raw GPS
  // position, but every smoothed point should stay within 5 meters of the straight-line track.
  const pts = straightTrack(51.5, -0.1, 51.5006, -0.0994, 50);
  const result = GpsFilter.applyKalman(pts, 1, 10);
  assert.strictEqual(result.length, pts.length);
  result.forEach((r, i) => {
    const distM = Math.sqrt((r.lat - pts[i].lat) ** 2 + (r.lon - pts[i].lon) ** 2) * 111320;
    assert.ok(distM < 10, `point ${i}: ${distM.toFixed(2)} m from straight track (expected < 10 m)`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  5. Refactored New Helpers
// ══════════════════════════════════════════════════════════════════════════════

test('GeoUtils.projectPointToSegment: closest point on segment matches expected projection', () => {
  // segment from (0,0) to (0,2)
  // query point at (1,1) -> projected point should be at (0,1)
  const proj = GeoUtils.projectPointToSegment(1, 1, 0, 0, 0, 2);
  closeTo(proj.lat, 0, 1e-6, 'projected lat');
  closeTo(proj.lon, 1, 1e-6, 'projected lon');
  // distance in meters: 1 degree of latitude difference at equator (approx 111320m)
  closeTo(proj.distance, 111320, 100, 'projected distance');

  // distanceToSegmentMeters should match proj.distance
  const dist = GeoUtils.distanceToSegmentMeters(1, 1, 0, 0, 0, 2);
  closeTo(dist, proj.distance, 1e-6, 'distance matches');
});

test('StatsMath._computeSums: returns correct sum terms', () => {
  const x = [1, 2, 3];
  const y = [4, 5, 6];
  const sums = StatsMath._computeSums(x, y);
  assert.strictEqual(sums.sumX, 6);
  assert.strictEqual(sums.sumY, 15);
  assert.strictEqual(sums.sumXY, 32);
  assert.strictEqual(sums.sumX2, 14);
  assert.strictEqual(sums.sumY2, 77);

  // Pearson correlation check
  const corr = StatsMath.calculatePearsonCorrelation(x, y);
  closeTo(corr.r, 1.0, 1e-6, 'Pearson correlation coefficient');

  // Linear regression check
  const reg = StatsMath.calculateLinearRegression(x, y);
  closeTo(reg.m, 1.0, 1e-6, 'regression slope');
  closeTo(reg.c, 3.0, 1e-6, 'regression intercept');
});

test('GSRMapExporter._parseLatLng: parses array and object coordinates', () => {
  // Array format
  const arrayFormat = [51.5, -0.1];
  const parsed1 = GSRMapExporter._parseLatLng(arrayFormat);
  assert.strictEqual(parsed1.lat, 51.5);
  assert.strictEqual(parsed1.lon, -0.1);

  // Object format with lat/lon
  const objectFormat1 = { lat: 51.5, lon: -0.1 };
  const parsed2 = GSRMapExporter._parseLatLng(objectFormat1);
  assert.strictEqual(parsed2.lat, 51.5);
  assert.strictEqual(parsed2.lon, -0.1);

  // Object format with lat/lng
  const objectFormat2 = { lat: 51.5, lng: -0.1 };
  const parsed3 = GSRMapExporter._parseLatLng(objectFormat2);
  assert.strictEqual(parsed3.lat, 51.5);
  assert.strictEqual(parsed3.lon, -0.1);

  // Fallbacks
  const emptyParsed = GSRMapExporter._parseLatLng(null);
  assert.strictEqual(emptyParsed.lat, 0);
  assert.strictEqual(emptyParsed.lon, 0);
});

test('GSRTrackManager.createTrackObject: constructs valid track representation', () => {
  const analyzerMock = {
    importedFilterParams: { medianSize: 5 },
    importedGpsFilterParams: { smoothing: 0.1 }
  };
  const track = GSRTrackManager.createTrackObject('track_123', 'my_track.csv', '#ff0000', analyzerMock);
  assert.strictEqual(track.id, 'track_123');
  assert.strictEqual(track.name, 'my_track.csv');
  assert.strictEqual(track.color, '#ff0000');
  assert.strictEqual(track.enabled, true);
  assert.strictEqual(track.analyzer, analyzerMock);
  assert.strictEqual(track.filterParams.medianSize, 5);
  assert.strictEqual(track.gpsFilterParams.smoothing, 0.1);
  assert.strictEqual(track.settingsSource, 'imported');
});

test('GSRUI resolution and marking helpers function correctly', () => {
  const mockAnalyzer = { peaks: [ { time: 10, label: 'test' } ], setPeakLabel() {} };
  const mockTrack = { id: 'track_123', analyzer: mockAnalyzer, hasUnsavedLabels: false };

  global.AppState = {
    activeTrackId: 'track_123',
    analyzer: mockAnalyzer,
    collectiveManager: {
      getTrack(trackId) {
        if (trackId === 'track_123') return mockTrack;
        return null;
      }
    }
  };

  // Test _resolveTrackAndAnalyzer in single/collective mode
  const resolvedSingle = GSRUI._resolveTrackAndAnalyzer(null);
  assert.strictEqual(resolvedSingle.track, mockTrack);
  assert.strictEqual(resolvedSingle.analyzer, mockAnalyzer);

  const resolvedCollective = GSRUI._resolveTrackAndAnalyzer('track_123');
  assert.strictEqual(resolvedCollective.track, mockTrack);
  assert.strictEqual(resolvedCollective.analyzer, mockAnalyzer);

  // Test _markUnsavedLabels
  GSRUI._markUnsavedLabels(mockTrack);
  assert.strictEqual(mockTrack.hasUnsavedLabels, true);

  delete global.AppState;
});

test('GsrFilter.applyMedianFilter: delegates correctly to applyPercentileFilter', () => {
  const signal = [1, 20, 3, 40, 5, 60, 7];
  const GsrFilter = global.GsrFilter;
  
  const medResult = GsrFilter.applyMedianFilter(signal, 3);
  const pctResult = GsrFilter.applyPercentileFilter(signal, 3, 0.5);

  assert.deepStrictEqual(medResult, pctResult);
  assert.strictEqual(medResult[0], 20);
  assert.strictEqual(medResult[1], 3);
  assert.strictEqual(medResult[2], 20);
  assert.strictEqual(medResult[3], 5);
  assert.strictEqual(medResult[4], 40);
  assert.strictEqual(medResult[5], 7);
  assert.strictEqual(medResult[6], 60);
});

test('MapColors.ROAD_COLORS is populated and matches getColorForMetric', () => {
  const MapColors = global.MapColors;
  assert.ok(MapColors.ROAD_COLORS, 'ROAD_COLORS exists');
  assert.strictEqual(MapColors.ROAD_COLORS['motorway'], '#ff0055');
  assert.strictEqual(MapColors.ROAD_COLORS['primary'], '#ff6600');
  
  // Verify getColorForMetric maps correctly
  assert.strictEqual(MapColors.getColorForMetric('roadClass', 'motorway'), '#ff0055');
  assert.strictEqual(MapColors.getColorForMetric('roadClass', 'primary'), '#ff6600');
  assert.strictEqual(MapColors.getColorForMetric('roadClass', 'unknown_class'), '#666666'); // fallback
});

test('GSRAnalyzer peak detection helpers work correctly', () => {
  const analyzer = new GSRAnalyzer();
  analyzer.sampleRate = 10;
  // Mock filtered signal for noise floor check
  analyzer.filtered = Array.from({ length: 20 }, (_, i) => ({ val: 0.1 }));

  const vals =  [0.1, 0.1, 0.2, 0.5, 0.8, 0.4, 0.2, 0.1, 0.1];
  const times = [0,   0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

  const onsetIdx = analyzer._findOnsetIndex(vals, 4, 10);
  assert.strictEqual(onsetIdx, 0, 'onset index is at index 0 (value 0.1)');

  const amplitude = vals[4] - vals[onsetIdx];
  closeTo(amplitude, 0.7, 1e-6);

  const recoveryIdx = analyzer._findRecoveryIndex(vals, 4, onsetIdx, amplitude);
  assert.strictEqual(recoveryIdx, 5, 'recovery index is at index 5 (value 0.4)');

  const noiseHalfWin = 10;
  const metrics = analyzer._calculateShapeMetrics(vals, times, 4, onsetIdx, recoveryIdx, noiseHalfWin);
  closeTo(metrics.amplitude, 0.7, 1e-6);
  closeTo(metrics.riseTime, 0.4, 1e-6);
  closeTo(metrics.halfRecoveryTime, 0.1, 1e-6);
  closeTo(metrics.onsetSlope, 0.7 / 0.4, 1e-6);
  closeTo(metrics.decaySlope, (0.8 - 0.4) / 0.1, 1e-6);
});
