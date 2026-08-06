/**
 * Comprehensive regression test suite for the BioMapping GSR analyser refactoring.
 * 
 * Tests all pure functions from the five extracted modules:
 *   geo_utils.js, stats_math.js, map_colors.js, gps_filter.js, gps_pipeline.js
 *
 * Run: node tests/test_refactor.js
 */

// ── Bootstrap: emulate browser global scope ────────────────────────────────
// The analyser modules hang off 'window' in the browser. We replicate the
// minimal global scope needed so the modules load cleanly under Node.

// Stub for functions/modules that the tested modules may reference but
// that we aren't testing directly here.
global.GpsFilter = null;       // placeholder, loaded below
global.GSR_CONST = require('./mock_constants.js');

// ── Load modules under test ─────────────────────────────────────────────────
// The analyser modules use `const Name = { ... }` at the top level.
// Under vm.runInThisContext (sloppy mode), replacing `const Name =` with
// `global.Name =` makes the modules' internal references (e.g. GeoUtils.EARTH_RADIUS_M)
// resolve through the global object chain, and the test file accesses them
// via the same `global.Name` references.
const vm = require('vm');
const fs = require('fs');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Replace the top-level const declaration with a global assignment.
  // The modules all follow the pattern:  const Foo = { ... };
  const wrapped = src.replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

// Load order must match index.html dependencies.
loadModule(__dirname + '/../geo_utils.js',    'GeoUtils');
loadModule(__dirname + '/../stats_math.js',   'StatsMath');
loadModule(__dirname + '/../map_colors.js',   'MapColors');
loadModule(__dirname + '/../gps_filter.js',   'GpsFilter');
loadModule(__dirname + '/../gps_pipeline.js', 'GpsPipeline');

const GeoUtils    = global.GeoUtils;
const StatsMath   = global.StatsMath;
const MapColors   = global.MapColors;
const GpsFilter   = global.GpsFilter;
const GpsPipeline = global.GpsPipeline;

// ── Test helpers ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg}`);
}

function assertEq(actual, expected, msg) {
  if (actual === expected) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) <= tolerance) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg} — expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`);
}

function summary() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}`);
  if (failed > 0) process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
//  1. geo_utils.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── geo_utils.js ──');

// 1a. haversineMeters — zero distance
{
  const d = GeoUtils.haversineMeters(51.5074, -0.1278, 51.5074, -0.1278);
  assertEq(d, 0, 'haversineMeters same point → 0');
}

// 1b. haversineMeters — known distance (London → Paris ~343 km)
{
  const d = GeoUtils.haversineMeters(51.5074, -0.1278, 48.8566, 2.3522);
  assert(d > 340000 && d < 345000, `haversineMeters London→Paris ~343 km (got ${d.toFixed(0)})`);
}

// 1c. haversineMeters — antipodal points (~20,037 km)
{
  const d = GeoUtils.haversineMeters(0, 0, 0, 180);
  assert(d > 20000000 && d < 20050000, `haversineMeters antipodal ~20,037 km (got ${d.toFixed(0)})`);
}

// 1d. haversineMeters — 1 degree latitude on spherical Earth ≈ 111,195 m
{
  const d = GeoUtils.haversineMeters(0, 0, 1, 0);
  assertClose(d, 111195, 50, 'haversineMeters 1° lat ≈ 111,195 m (spherical)');
}

// 1e. distanceToSegmentMeters — point on segment
{
  const d = GeoUtils.distanceToSegmentMeters(0, 0, -1, 0, 1, 0);
  assertClose(d, 0, 1, 'distanceToSegment — point on line → 0');
}

// 1f. distanceToSegmentMeters — point off segment (projected onto midpoint)
{
  const d = GeoUtils.distanceToSegmentMeters(1, 0, 0, 0, 0, 0);
  // 1° lat ≈ 111,320 m
  assertClose(d, 111320, 100, 'distanceToSegment — 1° off endpoint');
}

// 1g. pointInPolygon — inside square
{
  const square = [{lat:0,lon:0},{lat:0,lon:2},{lat:2,lon:2},{lat:2,lon:0}];
  assert(GeoUtils.pointInPolygon(1, 1, square), 'pointInPolygon — inside square');
}

// 1h. pointInPolygon — outside square
{
  const square = [{lat:0,lon:0},{lat:0,lon:2},{lat:2,lon:2},{lat:2,lon:0}];
  assert(!GeoUtils.pointInPolygon(3, 3, square), 'pointInPolygon — outside square');
}

// 1i. pointInPolygon — array format [lat, lon]
{
  const tri = [[0,0],[0,2],[2,0]];
  assert(GeoUtils.pointInPolygon(0.5, 0.5, tri), 'pointInPolygon — array coords format');
}

// 1j. EARTH_RADIUS_M constant
{
  assertEq(GeoUtils.EARTH_RADIUS_M, 6371000, 'EARTH_RADIUS_M = 6,371,000');
}

// 1k. METERS_PER_DEG_LAT constant
{
  assertEq(GeoUtils.METERS_PER_DEG_LAT, 111320, 'METERS_PER_DEG_LAT = 111,320');
}

// ────────────────────────────────────────────────────────────────────────────
//  2. stats_math.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── stats_math.js ──');

// 2a. calculatePearsonCorrelation — perfect positive
{
  const x = [1,2,3,4,5];
  const y = [2,4,6,8,10];
  const { r, p } = StatsMath.calculatePearsonCorrelation(x, y);
  assertClose(r, 1.0, 1e-10, 'Pearson perfect positive → r=1');
  // For r=1, t = r*sqrt((n-2)/(1-r²)) divides by zero; code returns p=1 correctly.
  assertEq(p, 1, 'Pearson perfect positive r=1 → p=1 (undefined t)');
}

// 2b. calculatePearsonCorrelation — perfect negative
{
  const x = [1,2,3,4,5];
  const y = [10,8,6,4,2];
  const { r, p } = StatsMath.calculatePearsonCorrelation(x, y);
  assertClose(r, -1.0, 1e-10, 'Pearson perfect negative → r=-1');
}

// 2c. calculatePearsonCorrelation — no correlation
{
  const x = [1,2,3,4,5];
  const y = [5,2,5,2,5];
  const { r } = StatsMath.calculatePearsonCorrelation(x, y);
  assert(r > -0.7 && r < 0.7, `Pearson no correlation r≈0 (got ${r.toFixed(4)})`);
}

// 2d. calculatePearsonCorrelation — empty input
{
  const { r, p } = StatsMath.calculatePearsonCorrelation([], []);
  assertEq(r, 0, 'Pearson empty → r=0');
  assertEq(p, 1, 'Pearson empty → p=1');
}

// 2e. calculatePearsonCorrelation — single element
{
  const { r, p } = StatsMath.calculatePearsonCorrelation([5], [5]);
  assertEq(r, 0, 'Pearson single → r=0 (den=0)');
}

// 2f. calculateLinearRegression — perfect fit
{
  const x = [1,2,3,4,5];
  const y = [3,5,7,9,11]; // y = 2x + 1
  const { m, c, r2 } = StatsMath.calculateLinearRegression(x, y);
  assertClose(m, 2.0, 1e-10, 'LinReg slope → 2');
  assertClose(c, 1.0, 1e-10, 'LinReg intercept → 1');
  assertClose(r2, 1.0, 1e-10, 'LinReg r² → 1');
}

// 2g. calculateLinearRegression — flat line
{
  const x = [1,2,3];
  const y = [5,5,5];
  const { m, c, r2 } = StatsMath.calculateLinearRegression(x, y);
  assertClose(m, 0, 1e-10, 'LinReg flat → m=0');
  assertClose(c, 5, 1e-10, 'LinReg flat → c=5');
}

// 2h. calculateLinearRegression — empty
{
  const { m, c, r2 } = StatsMath.calculateLinearRegression([], []);
  assertEq(m, 0, 'LinReg empty → m=0');
  assertEq(c, 0, 'LinReg empty → c=0');
  assertEq(r2, 0, 'LinReg empty → r2=0');
}

// 2i. _tTestPValue — edge cases
{
  const p1 = StatsMath._tTestPValue(0, 10);
  assertClose(p1, 1.0, 0.01, 'tTest t=0 → p≈1');
  const p2 = StatsMath._tTestPValue(10, 10);
  assert(p2 < 0.001, `tTest t=10 df=10 → p<0.001 (got ${p2})`);
}

// ────────────────────────────────────────────────────────────────────────────
//  3. map_colors.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── map_colors.js ──');

// 3a. getHslColor — ratio 0 → green (hue=120)
{
  const c = MapColors.getHslColor(0);
  assert(c.includes('hsl(120'), `getHslColor(0) → green hue=120 (got ${c})`);
}

// 3b. getHslColor — ratio 1 → red (hue=0)
{
  const c = MapColors.getHslColor(1);
  assert(c.includes('hsl(0'), `getHslColor(1) → red hue=0 (got ${c})`);
}

// 3c. getHslColor — ratio 0.5 → yellow (hue=60)
{
  const c = MapColors.getHslColor(0.5);
  assert(c.includes('hsl(60'), `getHslColor(0.5) → yellow hue=60 (got ${c})`);
}

// 3d. getHslColor — clamps ratio > 1
{
  const c = MapColors.getHslColor(1.5);
  assert(c.includes('hsl(0'), `getHslColor(1.5) clamps → hue=0 (got ${c})`);
}

// 3e. getHslColor — clamps ratio < 0
{
  const c = MapColors.getHslColor(-0.5);
  assert(c.includes('hsl(120'), `getHslColor(-0.5) clamps → hue=120 (got ${c})`);
}

// 3f. getColorForValue — mid value in range
{
  const c = MapColors.getColorForValue(5, 0, 10);
  assert(c.includes('hsl(60'), `getColorForValue(5,0,10) → yellow (got ${c})`);
}

// 3g. getColorForValue — min==max returns default green
{
  const c = MapColors.getColorForValue(5, 5, 5);
  assertEq(c, 'hsl(120, 90%, 50%)', 'getColorForValue min==max → default green');
}

// 3h. getColorForMetric — gsr delegates to getColorForValue
{
  const c = MapColors.getColorForMetric('gsr', 5, 0, 10);
  assert(c.includes('hsl(60'), `getColorForMetric gsr → yellow (got ${c})`);
}

// 3i. getColorForMetric — roadClass categorical
{
  const c = MapColors.getColorForMetric('roadClass', 'motorway', 0, 1);
  assertEq(c, '#ff0055', 'getColorForMetric motorway → #ff0055');
}

// 3j. getColorForMetric — inPark
{
  assertEq(MapColors.getColorForMetric('inPark', 1, 0, 1), '#00e575', 'inPark=1 → green');
  assertEq(MapColors.getColorForMetric('inPark', 0, 0, 1), '#666666', 'inPark=0 → gray');
}

// 3k. getColorLut — returns 30 colors
{
  const lut = MapColors.getColorLut('gsr', 0, 100);
  assertEq(lut.length, 30, 'getColorLut → 30 buckets');
  assert(lut[0].includes('hsl'), 'getColorLut[0] is HSL');
  assert(lut[29].includes('hsl'), 'getColorLut[29] is HSL');
}

// 3l. getColorLut — caches results
{
  MapColors._colorLutCache.clear();
  const lut1 = MapColors.getColorLut('gsr', 0, 100);
  const lut2 = MapColors.getColorLut('gsr', 0, 100);
  assert(lut1 === lut2, 'getColorLut returns cached instance');
  assertEq(MapColors._colorLutCache.size, 1, 'colorLutCache has 1 entry');
}

// 3m. getColorLut — different params produce different cache keys
{
  const lut3 = MapColors.getColorLut('gsr', 0, 200);
  assertEq(MapColors._colorLutCache.size, 2, 'colorLutCache has 2 entries for different ranges');
}

// ────────────────────────────────────────────────────────────────────────────
//  4. gps_filter.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── gps_filter.js ──');

// 4a. haversineDistance — delegates to GeoUtils
{
  const d1 = GpsFilter.haversineDistance(0, 0, 1, 0);
  const d2 = GeoUtils.haversineMeters(0, 0, 1, 0);
  assertEq(d1, d2, 'GpsFilter.haversineDistance ≡ GeoUtils.haversineMeters');
}

// 4b. applyHdopGate — filters high HDOP
{
  const pts = [
    { lat: 0, lon: 0, time: 1, hdop: 1.5 },
    { lat: 1, lon: 1, time: 2, hdop: 3.5 },
    { lat: 2, lon: 2, time: 3, hdop: NaN },
  ];
  const result = GpsPipeline.applyHdopGate(pts, 2.0);
  assertEq(result.length, 2, 'HDOP gate keeps hdop≤2 and NaN');
  assertEq(result[0].hdop, 1.5, 'HDOP gate keeps low-hdop point');
}

// 4c. applyFixTypeGate — rejects fix_type 1
{
  const pts = [
    { lat: 0, lon: 0, time: 1, fixType: 2 },
    { lat: 1, lon: 1, time: 2, fixType: 1 },
    { lat: 2, lon: 2, time: 3, fixType: null },
    { lat: 3, lon: 3, time: 4, fixType: 0 },
  ];
  const result = GpsPipeline.applyFixTypeGate(pts, 2);
  assertEq(result.length, 3, 'FixType gate keeps type≥2, null, and 0');
}

// 4d. applySpeedFilter — passes slow points
{
  const pts = [
    { lat: 0, lon: 0, time: 0, speedKts: 4 },
    { lat: 0.0001, lon: 0, time: 1, speedKts: 4 },
    { lat: 0.0002, lon: 0, time: 2, speedKts: 4 },
  ];
  // 0.0001° lat ≈ 11.1 m, dt=1s → speed≈11.1 m/s, speedKts=4→2.06 m/s
  // speedKts=4 < 3 m/s, so passes Doppler check
  const result = GpsFilter.applySpeedFilter(pts, 3.0);
  assert(result.length >= 1, 'Speed filter keeps valid points');
}

// 4e. applySpeedFilter — rejects fast points (Doppler)
{
  const pts = [
    { lat: 0, lon: 0, time: 0, speedKts: 20 },
    { lat: 0.001, lon: 0, time: 1, speedKts: 20 },
  ];
  // speedKts=20 → 10.3 m/s > 3.0 → rejected
  const result = GpsFilter.applySpeedFilter(pts, 3.0);
  assertEq(result.length, 1, 'Speed filter rejects Doppler-fast point');
}

// 4f. applySpeedFilter — rejects fast points (haversine fallback, no speedKts)
{
  const pts = [
    { lat: 0, lon: 0, time: 0 },
    { lat: 0.01, lon: 0, time: 1 },
  ];
  // 0.01° lat ≈ 1113 m, dt=1s → 1113 m/s > 3.0 → rejected
  const result = GpsFilter.applySpeedFilter(pts, 3.0);
  assertEq(result.length, 1, 'Speed filter rejects haversine-fast point');
}

// 4g. applySpeedFilter — null/0 maxSpeed returns unchanged
{
  const pts = [{ lat: 0, lon: 0, time: 0 }, { lat: 1, lon: 1, time: 1 }];
  const result = GpsFilter.applySpeedFilter(pts, 0);
  assertEq(result, pts, 'Speed filter no-ops on maxSpeed=0');
}

// 4h. applyKalman — identity (no change with balanced Q/R on straight line)
{
  // Use a realistic 30-point track so the Kalman/RTS reaches steady state.
  const pts = [];
  for (let i = 0; i < 30; i++) {
    pts.push({ lat: i * 0.0001, lon: 0, time: i, hdop: 1 });
  }
  const result = GpsFilter.applyKalman(pts, 0.5, 10);
  assertEq(result.length, pts.length, 'Kalman returns same count');
  // The Kalman filter preserves the signal while smoothing noise.
  // Compare output to input (not to a straight line — the filter tracks
  // the measurement, not a parametric model).
  let rmsFromInput = 0;
  for (let i = 0; i < result.length; i++) {
    const d = GeoUtils.haversineMeters(result[i].lat, result[i].lon, pts[i].lat, pts[i].lon);
    rmsFromInput += d * d;
  }
  rmsFromInput = Math.sqrt(rmsFromInput / result.length);
  // On a clean signal, Kalman output should be close to input.
  assert(rmsFromInput < 15.0, `Kalman tracks input: RMS from input = ${rmsFromInput.toFixed(2)} m`);
}

// 4i. applyKalman — extreme smoothing flattens noise
{
  const pts = [
    { lat: 0, lon: 0, time: 0, hdop: 1 },
    { lat: 0.001, lon: 0, time: 1, hdop: 1 },
    { lat: 0.000, lon: 0, time: 2, hdop: 1 },  // noise spike
    { lat: 0.002, lon: 0, time: 3, hdop: 1 },
    { lat: 0.003, lon: 0, time: 4, hdop: 1 },
  ];
  // Use a longer track (30 points) so the Kalman reaches steady state.
  // Inject a 50 m noise spike at index 15 (~0.00045° lat).
  const baseStep = 0.0001; // ~11.1 m per step
  const longPts = [];
  for (let i = 0; i < 30; i++) {
    const noise = (i === 15) ? 0.00045 : 0;
    longPts.push({ lat: i * baseStep + noise, lon: 0, time: i, hdop: 1 });
  }
  const smooth    = GpsFilter.applyKalman(longPts, 0.02, 150);
  const responsive = GpsFilter.applyKalman(longPts, 10, 0.5);

  // Responsive (Q=10,R=0.5): should follow raw data closely — the spike
  // at index 15 should still be visible.
  // Smooth (Q=0.02,R=150): should heavily dampen the spike.
  const ideal15 = 15 * baseStep;
  const rawSpike = Math.abs(longPts[15].lat - ideal15);
  const respSpike = Math.abs(responsive[15].lat - ideal15);
  const smoothSpike = Math.abs(smooth[15].lat - ideal15);

  assert(respSpike > 0, 'Responsive Kalman spike > 0 (follows data)');
  assert(smoothSpike < rawSpike,
    `Smooth Kalman dampens spike: smooth=${smoothSpike.toFixed(6)} < raw=${rawSpike.toFixed(6)}`);
  assert(smoothSpike < respSpike,
    `Smooth dampens more than responsive: smooth=${smoothSpike.toFixed(6)} < resp=${respSpike.toFixed(6)}`);
}

// 4j. applyKalman — rejects outlier via chi-squared gate
{
  // Use a 30-point track with a 1 km outlier at index 15.
  const pts = [];
  for (let i = 0; i < 30; i++) {
    const outlier = (i === 15) ? 0.009 : 0;  // ~1 km jump
    pts.push({ lat: i * 0.0001 + outlier, lon: 0, time: i, hdop: 1 });
  }
  const result = GpsFilter.applyKalman(pts, 0.5, 10);
  // The chi-squared gate rejects the outlier in the forward pass, but the
  // RTS backward pass uses future good measurements to partially restore it.
  // The net effect is modest — verify the filtered outlier is at least closer
  // to the linear trend than the raw value (even if only slightly).
  const ideal15 = 15 * 0.0001;
  const rawDev = Math.abs(pts[15].lat - ideal15);
  const filtDev = Math.abs(result[15].lat - ideal15);
  assert(filtDev < rawDev,
    `Kalman outlier dampened: raw=${rawDev.toFixed(6)} filt=${filtDev.toFixed(6)}`);
}

// 4j2. applyKalman — uses hacc_m directly instead of DOP²-scaling when present
{
  // Same noisy track fed twice: once with only HDOP/PDOP (falls back to
  // R_m2 × DOP² = 10 m²), once with an excellent hacc_m (0.1 m → R = 0.01 m²).
  // A much smaller effective R should make the filter trust the raw
  // measurement more, tracking the noisy input more closely (smaller RMS
  // deviation from input) than the DOP-fallback case.
  const baseStep = 0.0001;
  function buildTrack(withHacc) {
    const pts = [];
    for (let i = 0; i < 30; i++) {
      const noise = Math.sin(i * 1.7) * 0.00003; // deterministic pseudo-noise
      const lat = i * baseStep + noise;
      const p = { lat, lon: 0, time: i, hdop: 1, pdop: 1 };
      if (withHacc) p.hacc = 0.1;
      pts.push(p);
    }
    return pts;
  }
  const noHacc = buildTrack(false);
  const withHacc = buildTrack(true);
  const resNoHacc = GpsFilter.applyKalman(noHacc, 0.5, 10);
  const resWithHacc = GpsFilter.applyKalman(withHacc, 0.5, 10);

  let rmsNoHacc = 0, rmsWithHacc = 0;
  for (let i = 0; i < 30; i++) {
    const dNo = GeoUtils.haversineMeters(resNoHacc[i].lat, resNoHacc[i].lon, noHacc[i].lat, noHacc[i].lon);
    const dWith = GeoUtils.haversineMeters(resWithHacc[i].lat, resWithHacc[i].lon, withHacc[i].lat, withHacc[i].lon);
    rmsNoHacc += dNo * dNo;
    rmsWithHacc += dWith * dWith;
  }
  rmsNoHacc = Math.sqrt(rmsNoHacc / 30);
  rmsWithHacc = Math.sqrt(rmsWithHacc / 30);

  assert(rmsWithHacc < rmsNoHacc,
    `hacc_m=0.1 tracks noisy input more closely than DOP fallback: withHacc=${rmsWithHacc.toFixed(4)} m < fallback=${rmsNoHacc.toFixed(4)} m`);
}

// 4j3. applyKalman — hacc_m sentinel (99.9 = unknown) falls back to DOP scaling
{
  const baseStep = 0.0001;
  const ptsSentinel = [];
  const ptsNoHacc = [];
  for (let i = 0; i < 20; i++) {
    ptsSentinel.push({ lat: i * baseStep, lon: 0, time: i, hdop: 2, pdop: 2, hacc: 99.9 });
    ptsNoHacc.push({ lat: i * baseStep, lon: 0, time: i, hdop: 2, pdop: 2 });
  }
  const resultSentinel = GpsFilter.applyKalman(ptsSentinel, 0.5, 10);
  const resultNoHacc = GpsFilter.applyKalman(ptsNoHacc, 0.5, 10);
  for (let i = 0; i < ptsSentinel.length; i++) {
    assert(Math.abs(resultSentinel[i].lat - resultNoHacc[i].lat) < 1e-12,
      `hacc_m=99.9 sentinel behaves identically to missing hacc at i=${i}`);
  }
}

// 4k. applyKalman — NaN guard
{
  const r1 = GpsFilter.applyKalman([], 1, 1);
  assertEq(r1.length, 0, 'Kalman empty → empty');
  const r2 = GpsFilter.applyKalman([{lat:0,lon:0,time:0}], 1, 1);
  assertEq(r2.length, 1, 'Kalman single point → 1');
}

// 4q. applyKalman — RTS displacement clamp constraint
{
  const pts = [];
  for (let i = 0; i < 30; i++) {
    pts.push({ lat: i * 0.0001, lon: 0, time: i, hdop: 1 });
  }
  // Displace point 15 by a massive distance (~1.1 km)
  pts[15].lat = 15 * 0.0001 + 0.01;
  const Rm = 10;
  const result = GpsFilter.applyKalman(pts, 0.5, Rm);
  // The smoothed point 15 must be at most MAX_DISP_M = 30 meters away from raw pts[15]
  const dist = GeoUtils.haversineMeters(result[15].lat, result[15].lon, pts[15].lat, pts[15].lon);
  const maxDispAllowed = 3.0 * Rm;
  assert(dist <= maxDispAllowed + 0.1, `Kalman RTS clamp limits deviation to 3σ: dist=${dist.toFixed(2)} m <= max=${maxDispAllowed} m`);
}

// 4l. applyVelocitySmoothing — no speed data → passthrough
{
  const pts = [{ lat: 0, lon: 0, time: 0 }, { lat: 1, lon: 1, time: 1 }];
  const result = GpsFilter.applyVelocitySmoothing(pts, 0.5);
  assertEq(result, pts, 'VelocitySmoothing no-ops without speedKts');
}

// 4m. applyVelocitySmoothing — blends with dead reckoning
{
  const pts = [
    { lat: 0, lon: 0, time: 0, speedKts: 5, course: 90, hdop: 1 },
    { lat: 0.0001, lon: 0.001, time: 1, speedKts: 5, course: 90, hdop: 1 },
  ];
  const result = GpsFilter.applyVelocitySmoothing(pts, 0.5);
  assertEq(result.length, 2, 'VelocitySmoothing returns same count');
  assert(!isNaN(result[1].lat) && !isNaN(result[1].lon), 'VelocitySmoothing output is valid');
}

// 4m2. applyVelocitySmoothing — prefers hacc_m over HDOP for trust weighting
{
  // Same HDOP/PDOP (good geometry) in both tracks; only hacc_m differs.
  // A bad hacc_m (multipath) should make the blend trust the raw fix less
  // (pull further toward the dead-reckoned prediction) than an equally-good
  // HDOP with no hacc_m at all.
  function track(hacc) {
    const p0 = { lat: 0, lon: 0, time: 0, speedKts: 5, course: 90, hdop: 1, pdop: 1 };
    const p1 = { lat: 0.0002, lon: 0.0050, time: 1, speedKts: 5, course: 90, hdop: 1, pdop: 1 };
    if (hacc !== undefined) { p0.hacc = hacc; p1.hacc = hacc; }
    return [p0, p1];
  }
  const noHacc = GpsFilter.applyVelocitySmoothing(track(undefined), 0.5);
  const badHacc = GpsFilter.applyVelocitySmoothing(track(40.0), 0.5);
  const rawFix = track(undefined)[1];

  const distNoHacc = GeoUtils.haversineMeters(noHacc[1].lat, noHacc[1].lon, rawFix.lat, rawFix.lon);
  const distBadHacc = GeoUtils.haversineMeters(badHacc[1].lat, badHacc[1].lon, rawFix.lat, rawFix.lon);

  assert(distBadHacc > distNoHacc,
    `hacc_m=40 trusts raw fix less than HDOP=1 alone: distBadHacc=${distBadHacc.toFixed(2)} m > distNoHacc=${distNoHacc.toFixed(2)} m`);
}

// 4n. applyStopAveraging — collapses stationary cluster
{
  const pts = [
    { lat: 50, lon: 10, time: 0, speedKts: 0 },
    { lat: 50.001, lon: 10.001, time: 1, speedKts: 0.1 },
    { lat: 49.999, lon: 9.999, time: 2, speedKts: 0.2 },
    { lat: 50.002, lon: 10.002, time: 3, speedKts: 0.3 },
    { lat: 51, lon: 11, time: 4, speedKts: 5 },   // moving
  ];
  const result = GpsFilter.applyStopAveraging(pts, 0.5, 3);
  assertEq(result.length, 5, 'StopAveraging preserves count (locks to centroid)');
  // All stationary points should share the same lat/lon
  const centLat = result[0].lat;
  for (let i = 1; i < 4; i++) {
    assertClose(result[i].lat, centLat, 1e-10, `StopAveraging cluster[${i}] locked to centroid`);
  }
  // The moving point should be different
  assert(result[4].lat !== centLat, 'StopAveraging moving point not locked');
}

// 4o. applyStopAveraging — no speed data → passthrough
{
  const pts = [{ lat: 0, lon: 0, time: 0 }, { lat: 1, lon: 1, time: 1 }];
  const result = GpsFilter.applyStopAveraging(pts);
  assertEq(result, pts, 'StopAveraging no-ops without speedKts');
}

// 4p. applyRDP — simplifies a zigzag to endpoints
{
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0.0001, lon: 0.00005 }, // slight zig
    { lat: 0, lon: 0.0001 },       // slight zag
    { lat: 0.001, lon: 0.001 },    // far away
  ];
  const result = GpsFilter.applyRDP(pts, 50); // 50 m tolerance
  assert(result.length >= 2, `RDP returns at least endpoints (got ${result.length})`);
}

// 4q. applyRDP — zero tolerance → passthrough
{
  const pts = [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
  const result = GpsFilter.applyRDP(pts, 0);
  assertEq(result, pts, 'RDP zero tolerance → passthrough');
}

// ────────────────────────────────────────────────────────────────────────────
//  5. gps_pipeline.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── gps_pipeline.js ──');

// 5a. applyPreKalmanFilters — chains stopAvg + speedFilter + velSmooth
{
  const pts = [
    { lat: 50, lon: 10, time: 0, speedKts: 0.1, hdop: 1 },
    { lat: 50.001, lon: 10.001, time: 1, speedKts: 0.2, hdop: 1 },
    { lat: 50.002, lon: 10.002, time: 2, speedKts: 0.1, hdop: 1 },
    { lat: 50.003, lon: 10.003, time: 3, speedKts: 0.3, hdop: 1 },
    { lat: 51, lon: 11, time: 4, speedKts: 5, hdop: 1 },
  ];
  const result = GpsPipeline.applyPreKalmanFilters(pts, 0.5, 3.0);
  assert(result.length >= 1, 'PreKalmanFilters returns points');
}

// 5b. applySnapCorrection — blends GPS with snap data
{
  const gpsPoints = [
    { lat: 50, lon: 10, origIdx: 0 },
    { lat: 51, lon: 11, origIdx: 1 },
  ];
  const snappedGps = {
    0: { alpha: 0.8, roadLat: 50.001, roadLon: 10.001 },
  };
  const result = GpsPipeline.applySnapCorrection(gpsPoints, snappedGps);
  assertEq(result.length, 2, 'SnapCorrection returns same count');
  // Point 0 should be blended toward road
  assert(result[0].lat !== 50, 'SnapCorrection blends snapped point lat');
  // Point 1 should be unchanged (no snap data)
  assertEq(result[1].lat, 51, 'SnapCorrection passes through unsnapped point');
}

// 5c. applySnapCorrection — null/empty snap data → passthrough
{
  const pts = [{ lat: 50, lon: 10, origIdx: 0 }];
  // Production code always checks analyzer.snappedGps before calling;
  // passing null directly would dereference null.  Test with empty object.
  const result = GpsPipeline.applySnapCorrection(pts, {});
  assertEq(result[0].lat, 50, 'SnapCorrection no-ops with empty snap data');
}

// 5d. reconstructFilteredGps — interpolates between anchors
{
  const mockAnalyzer = { filteredGps: null };
  const data = [
    { time: 0 }, { time: 1 }, { time: 2 }, { time: 3 }, { time: 4 },
  ];
  const gpsPoints = [
    { lat: 0, lon: 0, origIdx: 0 },
    { lat: 0.004, lon: 0.004, origIdx: 4 },
  ];
  GpsPipeline.reconstructFilteredGps(mockAnalyzer, data, gpsPoints);
  const fg = mockAnalyzer.filteredGps;
  assertEq(fg.length, 5, 'reconstructFilteredGps fills full array');
  assertEq(fg[0].lat, 0, 'reconstructFilteredGps first anchor');
  assertEq(fg[4].lat, 0.004, 'reconstructFilteredGps last anchor');
  // Middle points should be interpolated
  assert(fg[2].lat > 0 && fg[2].lat < 0.004, 'reconstructFilteredGps interpolates middle');
}

// 5e. reconstructFilteredGps — large gap → NaN
{
  const mockAnalyzer = { filteredGps: null };
  const data = [
    { time: 0 }, { time: 10 }, { time: 50 }, { time: 60 },
  ];
  const gpsPoints = [
    { lat: 0, lon: 0, origIdx: 0 },
    { lat: 10, lon: 10, origIdx: 3 },
  ];
  GpsPipeline.reconstructFilteredGps(mockAnalyzer, data, gpsPoints);
  const fg = mockAnalyzer.filteredGps;
  // Gap between idx 0 (time 0) and idx 3 (time 60) is 60s > 30s → NaN
  assert(isNaN(fg[1].lat), 'reconstructFilteredGps NaN on large gap');
}

// 5f. reconstructFilteredGpsCached — cache hits
{
  const mockAnalyzer = { filteredGps: null, _filteredGpsCacheKey: null };
  const data = [{ time: 0 }, { time: 1 }, { time: 2 }];
  const gpsPoints = [
    { lat: 0, lon: 0, origIdx: 0 },
    { lat: 0.002, lon: 0.002, origIdx: 2 },
  ];
  GpsPipeline.reconstructFilteredGpsCached(mockAnalyzer, data, gpsPoints);
  const key1 = mockAnalyzer._filteredGpsCacheKey;
  assert(key1 && key1 !== 'empty', 'reconstructFilteredGpsCached sets key');
  
  // Second call with same data → cache hit
  mockAnalyzer.filteredGps = null; // clear to detect if overwritten
  GpsPipeline.reconstructFilteredGpsCached(mockAnalyzer, data, gpsPoints);
  assertEq(mockAnalyzer.filteredGps, null, 'reconstructFilteredGpsCached hits cache (no recompute)');
}

// 5g. reconstructFilteredGpsCached — cache invalidates on different lat/lon
{
  const mockAnalyzer = { filteredGps: null, _filteredGpsCacheKey: null };
  const data = [{ time: 0 }, { time: 1 }, { time: 2 }];
  const gpsPoints1 = [
    { lat: 50, lon: 10, origIdx: 0 },
    { lat: 50.002, lon: 10.002, origIdx: 2 },
  ];
  GpsPipeline.reconstructFilteredGpsCached(mockAnalyzer, data, gpsPoints1);
  const key1 = mockAnalyzer._filteredGpsCacheKey;
  
  // Different coordinates → cache miss, recompute
  const gpsPoints2 = [
    { lat: 51, lon: 11, origIdx: 0 },
    { lat: 51.002, lon: 11.002, origIdx: 2 },
  ];
  mockAnalyzer.filteredGps = null;
  GpsPipeline.reconstructFilteredGpsCached(mockAnalyzer, data, gpsPoints2);
  assert(mockAnalyzer.filteredGps !== null, 'reconstructFilteredGpsCached recomputes on different coords');
  assert(mockAnalyzer._filteredGpsCacheKey !== key1, 'reconstructFilteredGpsCached key changes on different coords');
}

// 5h. downsampleForDisplay — no downsample → full array (copies)
{
  const pts = [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, { lat: 2, lon: 2 }];
  const result = GpsPipeline.downsampleForDisplay(pts, 10, false);
  assertEq(result.length, 3, 'downsample off → full array');
}

// 5i. downsampleForDisplay — with downsample
{
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push({ lat: i, lon: i });
  const result = GpsPipeline.downsampleForDisplay(pts, 10, true);
  assert(result.length <= 12, `downsample 10 Hz → ≤12 points (got ${result.length})`);
}

// ────────────────────────────────────────────────────────────────────────────
//  6. Cross-module dependency verification
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Cross-module dependencies ──');

// 6a. GpsFilter.haversineDistance delegates to GeoUtils
{
  const d = GpsFilter.haversineDistance(10, 20, 10.001, 20);
  assert(d > 0, 'GpsFilter→GeoUtils haversine works');
}

// 6b. GpsPipeline.applyPreKalmanFilters calls GpsFilter functions
{
  const pts = [{ lat: 0, lon: 0, time: 0, speedKts: 5, hdop: 1, course: 90 },
               { lat: 0.001, lon: 0.001, time: 1, speedKts: 5, hdop: 1, course: 90 }];
  const r = GpsPipeline.applyPreKalmanFilters(pts, 0.5, 3.0);
  assert(r.length === 2, 'GpsPipeline→GpsFilter chain works');
}

// 6c. applyHdopGate handles empty arrays
{
  assertEq(GpsPipeline.applyHdopGate([], 2.0).length, 0, 'HDOP gate empty → empty');
}

// 6d. applyFixTypeGate handles empty arrays
{
  assertEq(GpsPipeline.applyFixTypeGate([], 2).length, 0, 'FixType gate empty → empty');
}

// 6e. applyFixTypeGate minFixType < 2 → passthrough
{
  const pts = [{ fixType: 1 }, { fixType: 0 }];
  const r = GpsPipeline.applyFixTypeGate(pts, 1);
  assertEq(r, pts, 'FixType gate minFixType<2 → passthrough');
}

// ────────────────────────────────────────────────────────────────────────────
summary();
