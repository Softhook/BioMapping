/**
 * Comprehensive regression test suite for the BioMapping GSR analyser refactoring.
 *
 * Tests all pure functions from the five extracted modules:
 *   geo_utils.js, stats_math.js, map_colors.js, gps_pipeline.js
 *
 * Run: node tests/test_refactor.js
 */

// ── Bootstrap: emulate browser global scope ────────────────────────────────
// The analyser modules hang off 'window' in the browser. We replicate the
// minimal global scope needed so the modules load cleanly under Node.

// Stub for functions/modules that the tested modules may reference but
// that we aren't testing directly here.
global.GSR_CONST = require('./mock_constants.js');

// ── Load modules under test ─────────────────────────────────────────────────
// The analyser modules use `const Name = { ... }` at the top level.
// Under vm.runInThisContext (sloppy mode), replacing `const Name =` with
// `global.Name =` makes the modules' internal references (e.g. GeoUtils.EARTH_RADIUS_M)
// resolve through the global object chain, and the test file accesses them
// via the same `global.Name` references.
const _vm = require('node:vm');

const { loadModule } = require('./support/load_module.js');

// Load order must match index.html dependencies.
loadModule(`${__dirname}/../src/gps/geo_utils.js`, 'GeoUtils');
loadModule(`${__dirname}/../src/signal/stats_math.js`, 'StatsMath');
loadModule(`${__dirname}/../src/map/map_colors.js`, 'MapColors');
loadModule(`${__dirname}/../src/gps/gps_pipeline.js`, 'GpsPipeline');

const GeoUtils = global.GeoUtils;
const StatsMath = global.StatsMath;
const MapColors = global.MapColors;
const GpsPipeline = global.GpsPipeline;

// ── Test helpers ────────────────────────────────────────────────────────────
let passed = 0,
  failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`  FAIL: ${msg}`);
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    return;
  }
  failed++;
  console.error(
    `  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertClose(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
    return;
  }
  failed++;
  console.error(
    `  FAIL: ${msg} — expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
  );
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
  assert(
    d > 340000 && d < 345000,
    `haversineMeters London→Paris ~343 km (got ${d.toFixed(0)})`,
  );
}

// 1c. haversineMeters — antipodal points (~20,037 km)
{
  const d = GeoUtils.haversineMeters(0, 0, 0, 180);
  assert(
    d > 20000000 && d < 20050000,
    `haversineMeters antipodal ~20,037 km (got ${d.toFixed(0)})`,
  );
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
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 2 },
    { lat: 2, lon: 2 },
    { lat: 2, lon: 0 },
  ];
  assert(
    GeoUtils.pointInPolygon(1, 1, square),
    'pointInPolygon — inside square',
  );
}

// 1h. pointInPolygon — outside square
{
  const square = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 2 },
    { lat: 2, lon: 2 },
    { lat: 2, lon: 0 },
  ];
  assert(
    !GeoUtils.pointInPolygon(3, 3, square),
    'pointInPolygon — outside square',
  );
}

// 1i. pointInPolygon — array format [lat, lon]
{
  const tri = [
    [0, 0],
    [0, 2],
    [2, 0],
  ];
  assert(
    GeoUtils.pointInPolygon(0.5, 0.5, tri),
    'pointInPolygon — array coords format',
  );
}

// 1j. EARTH_RADIUS_M constant
assertEq(GeoUtils.EARTH_RADIUS_M, 6371000, 'EARTH_RADIUS_M = 6,371,000');

// 1k. METERS_PER_DEG_LAT constant
assertEq(GeoUtils.METERS_PER_DEG_LAT, 111320, 'METERS_PER_DEG_LAT = 111,320');

// ────────────────────────────────────────────────────────────────────────────
//  2. stats_math.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── stats_math.js ──');

// 2a. calculatePearsonCorrelation — perfect positive
{
  const x = [1, 2, 3, 4, 5];
  const y = [2, 4, 6, 8, 10];
  const { r, p } = StatsMath.calculatePearsonCorrelation(x, y);
  assertClose(r, 1.0, 1e-10, 'Pearson perfect positive → r=1');
  // For r=1, t = r*sqrt((n-2)/(1-r²)) is infinite, so p = 0.
  assertEq(p, 0, 'Pearson perfect positive r=1 → p=0 (infinite t)');
}

// 2b. calculatePearsonCorrelation — perfect negative
{
  const x = [1, 2, 3, 4, 5];
  const y = [10, 8, 6, 4, 2];
  const { r } = StatsMath.calculatePearsonCorrelation(x, y);
  assertClose(r, -1.0, 1e-10, 'Pearson perfect negative → r=-1');
}

// 2c. calculatePearsonCorrelation — no correlation
{
  const x = [1, 2, 3, 4, 5];
  const y = [5, 2, 5, 2, 5];
  const { r } = StatsMath.calculatePearsonCorrelation(x, y);
  assert(
    r > -0.7 && r < 0.7,
    `Pearson no correlation r≈0 (got ${r.toFixed(4)})`,
  );
}

// 2d. calculatePearsonCorrelation — empty input
{
  const { r, p } = StatsMath.calculatePearsonCorrelation([], []);
  assertEq(r, 0, 'Pearson empty → r=0');
  assertEq(p, 1, 'Pearson empty → p=1');
}

// 2e. calculatePearsonCorrelation — single element
{
  const { r } = StatsMath.calculatePearsonCorrelation([5], [5]);
  assertEq(r, 0, 'Pearson single → r=0 (den=0)');
}

// 2f. calculateLinearRegression — perfect fit
{
  const x = [1, 2, 3, 4, 5];
  const y = [3, 5, 7, 9, 11]; // y = 2x + 1
  const { m, c, r2 } = StatsMath.calculateLinearRegression(x, y);
  assertClose(m, 2.0, 1e-10, 'LinReg slope → 2');
  assertClose(c, 1.0, 1e-10, 'LinReg intercept → 1');
  assertClose(r2, 1.0, 1e-10, 'LinReg r² → 1');
}

// 2g. calculateLinearRegression — flat line
{
  const x = [1, 2, 3];
  const y = [5, 5, 5];
  const { m, c } = StatsMath.calculateLinearRegression(x, y);
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
  assert(
    c.includes('hsl(120'),
    `getHslColor(-0.5) clamps → hue=120 (got ${c})`,
  );
}

// 3f. getColorForValue — mid value in range
{
  const c = MapColors.getColorForValue(5, 0, 10);
  assert(c.includes('hsl(60'), `getColorForValue(5,0,10) → yellow (got ${c})`);
}

// 3g. getColorForValue — min==max returns default green
{
  const c = MapColors.getColorForValue(5, 5, 5);
  assertEq(
    c,
    'hsl(120, 90%, 50%)',
    'getColorForValue min==max → default green',
  );
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
assertEq(
  MapColors.getColorForMetric('inPark', 1, 0, 1),
  '#00e575',
  'inPark=1 → green',
);
assertEq(
  MapColors.getColorForMetric('inPark', 0, 0, 1),
  '#666666',
  'inPark=0 → gray',
);

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
  const _lut3 = MapColors.getColorLut('gsr', 0, 200);
  assertEq(
    MapColors._colorLutCache.size,
    2,
    'colorLutCache has 2 entries for different ranges',
  );
}

// ────────────────────────────────────────────────────────────────────────────
//  4. gps_pipeline.js — gates and RDP
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── gps_pipeline.js: gates + RDP ──');

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

// 4p. applyRDP — simplifies a zigzag to endpoints
{
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 0.0001, lon: 0.00005 }, // slight zig
    { lat: 0, lon: 0.0001 }, // slight zag
    { lat: 0.001, lon: 0.001 }, // far away
  ];
  const result = GpsPipeline.applyRDP(pts, 50); // 50 m tolerance
  assert(
    result.length >= 2,
    `RDP returns at least endpoints (got ${result.length})`,
  );
}

// 4q. applyRDP — zero tolerance → passthrough
{
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 1, lon: 1 },
    { lat: 2, lon: 2 },
  ];
  const result = GpsPipeline.applyRDP(pts, 0);
  assertEq(result, pts, 'RDP zero tolerance → passthrough');
}

// ────────────────────────────────────────────────────────────────────────────
//  5. gps_pipeline.js
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── gps_pipeline.js ──');

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

// 5c2. isPlausibleGap — shared gap criterion used by both reconstructFilteredGps
// (interpolate vs blank) and the map renderer's path-segment breaking
// (manager/path.js's _renderPathSegments)
// Walking pace, well under maxSpeed → plausible
assert(
  GpsPipeline.isPlausibleGap(10, 8, 3.0),
  'isPlausibleGap: slow, short gap is plausible',
);
// Implied speed (100m/1s = 100 m/s) far exceeds maxSpeed → not plausible,
// even though the gap itself is short in time — this is exactly the
// biomap_029/maxSpeed=1 bug: a huge jump in a fraction of a second used
// to sail through a time-only gate.
assert(
  !GpsPipeline.isPlausibleGap(100, 1, 3.0),
  'isPlausibleGap: implausible implied speed rejected regardless of how short the time gap is',
);
// Under the absolute distance ceiling (100m) but still too fast → rejected
assert(
  !GpsPipeline.isPlausibleGap(95, 10, 3.0),
  'isPlausibleGap: under the distance ceiling but implied speed still too high',
);
// Over the absolute distance ceiling even at a plausible average speed → rejected
assert(
  !GpsPipeline.isPlausibleGap(150, 100, 3.0),
  'isPlausibleGap: distance ceiling rejects a long real detour disguised as a low average speed',
);
// Zero elapsed time with nonzero distance → infinite implied speed → rejected
assert(
  !GpsPipeline.isPlausibleGap(5, 0, 3.0),
  'isPlausibleGap: zero dt with real distance is never plausible',
);

// 5c2b. isImpossibleJump — lenient render-break rule: only jumps no real
// track (or snap/multipath error) could produce; noisy real data stays joined.
// 500 m in 1 s: impossible
assert(GpsPipeline.isImpossibleJump(500, 1), 'impossible jump breaks');
assert(
  GpsPipeline.isImpossibleJump(60, 0),
  'zero dt with real distance breaks',
);
// Bad reception / snap offsets: 30 m in 1 s (30 m/s but under the distance floor)
assert(!GpsPipeline.isImpossibleJump(30, 1), 'tens-of-metres wobble is kept');
// 12 m/s over 10 s = 120 m: fast (above walking maxSpeed) but plausible, kept
assert(!GpsPipeline.isImpossibleJump(120, 10), 'fast-but-possible gap is kept');
// Stopped / tiny move
assert(!GpsPipeline.isImpossibleJump(0, 1), 'no movement is kept');

// 5c3. Hermite reconstruction helpers — velocity vector, tangent clamp, curve
{
  const scale = GeoUtils.getGeodesicScale(51.5);

  // _velocityDegPerSec: NaN speed or course -> null (triggers the linear fallback)
  assert(
    GpsPipeline._velocityDegPerSec(NaN, 90, scale) === null,
    '_velocityDegPerSec: NaN speed -> null',
  );
  assert(
    GpsPipeline._velocityDegPerSec(2, NaN, scale) === null,
    '_velocityDegPerSec: NaN course -> null',
  );
  // Course 0 (NMEA: due north) -> pure latitude component, ~zero longitude
  {
    const v = GpsPipeline._velocityDegPerSec(2, 0, scale);
    assert(
      v.vLat > 0,
      '_velocityDegPerSec: course 0 has positive lat component',
    );
    assertClose(
      v.vLon,
      0,
      1e-12,
      '_velocityDegPerSec: course 0 has ~zero lon component',
    );
  }
  // Course 90 (due east) -> pure longitude component, ~zero latitude
  {
    const v = GpsPipeline._velocityDegPerSec(2, 90, scale);
    assertClose(
      v.vLat,
      0,
      1e-12,
      '_velocityDegPerSec: course 90 has ~zero lat component',
    );
    assert(
      v.vLon > 0,
      '_velocityDegPerSec: course 90 has positive lon component',
    );
  }

  // _clampHermiteTangent: small tangent (under the limit) passes through unchanged
  {
    const v = { vLat: 0.0001, vLon: 0 };
    const clamped = GpsPipeline._clampHermiteTangent(v, 1.0, 1.0); // chordMagDeg=1, dtTotal=1 -> limit=1 (K=1.0)
    assertEq(
      clamped.vLat,
      v.vLat,
      '_clampHermiteTangent: under-limit tangent unchanged (lat)',
    );
    assertEq(
      clamped.vLon,
      v.vLon,
      '_clampHermiteTangent: under-limit tangent unchanged (lon)',
    );
  }
  // Oversized tangent gets scaled down to exactly the limit magnitude
  {
    const v = { vLat: 10, vLon: 0 };
    const chordMagDeg = 0.001;
    const clamped = GpsPipeline._clampHermiteTangent(v, chordMagDeg, 1.0);
    assertClose(
      Math.hypot(clamped.vLat, clamped.vLon),
      chordMagDeg, // K=1.0
      1e-9,
      '_clampHermiteTangent: oversized tangent scaled down to the K*chord limit',
    );
  }
  // Zero-magnitude tangent (stationary anchor) passes through as-is, no divide-by-zero
  {
    const clamped = GpsPipeline._clampHermiteTangent(
      { vLat: 0, vLon: 0 },
      1.0,
      1.0,
    );
    assertEq(
      clamped.vLat,
      0,
      '_clampHermiteTangent: zero tangent stays zero (lat)',
    );
    assertEq(
      clamped.vLon,
      0,
      '_clampHermiteTangent: zero tangent stays zero (lon)',
    );
  }

  // _hermitePoint: boundary conditions — t=0 reproduces cA exactly, t=1 reproduces cB exactly,
  // regardless of the tangents (standard Hermite spline property).
  {
    const cA = { lat: 51.5, lon: -0.1 };
    const cB = { lat: 51.501, lon: -0.099 };
    const m0 = { vLat: 0.0005, vLon: 0.0002 };
    const m1 = { vLat: -0.0003, vLon: 0.0004 };
    const p0 = GpsPipeline._hermitePoint(cA, cB, m0, m1, 10, 0);
    assertClose(p0.lat, cA.lat, 1e-12, '_hermitePoint: t=0 reproduces cA.lat');
    assertClose(p0.lon, cA.lon, 1e-12, '_hermitePoint: t=0 reproduces cA.lon');
    const p1 = GpsPipeline._hermitePoint(cA, cB, m0, m1, 10, 1);
    assertClose(p1.lat, cB.lat, 1e-12, '_hermitePoint: t=1 reproduces cB.lat');
    assertClose(p1.lon, cB.lon, 1e-12, '_hermitePoint: t=1 reproduces cB.lon');
  }
}

// 5d. reconstructFilteredGps — interpolates between anchors
{
  const mockAnalyzer = { filteredGps: null };
  const data = [
    { time: 0 },
    { time: 1 },
    { time: 2 },
    { time: 3 },
    { time: 4 },
  ];
  // ~8m diagonal over 4s (~2 m/s) — within the default 3.0 m/s plausibility
  // gate, unlike a 0.004° (~445m) jump which would now correctly be
  // rejected as an implausible ~111 m/s implied speed (see the speed-aware
  // gap rule in reconstructFilteredGps).
  const gpsPoints = [
    { lat: 0, lon: 0, origIdx: 0 },
    { lat: 0.00005, lon: 0.00005, origIdx: 4 },
  ];
  GpsPipeline.reconstructFilteredGps(mockAnalyzer, data, gpsPoints);
  const fg = mockAnalyzer.filteredGps;
  assertEq(fg.length, 5, 'reconstructFilteredGps fills full array');
  assertEq(fg[0].lat, 0, 'reconstructFilteredGps first anchor');
  assertEq(fg[4].lat, 0.00005, 'reconstructFilteredGps last anchor');
  // Middle points should be interpolated
  assert(
    fg[2].lat > 0 && fg[2].lat < 0.00005,
    'reconstructFilteredGps interpolates middle',
  );
}

// 5e. reconstructFilteredGps — large gap → NaN
{
  const mockAnalyzer = { filteredGps: null };
  const data = [{ time: 0 }, { time: 10 }, { time: 50 }, { time: 60 }];
  const gpsPoints = [
    { lat: 0, lon: 0, origIdx: 0 },
    { lat: 10, lon: 10, origIdx: 3 },
  ];
  GpsPipeline.reconstructFilteredGps(mockAnalyzer, data, gpsPoints);
  const fg = mockAnalyzer.filteredGps;
  // ~1,570km over 60s is wildly implausible at any maxSpeed → NaN
  assert(isNaN(fg[1].lat), 'reconstructFilteredGps NaN on large gap');
}

// 5e2. reconstructFilteredGps — Hermite bends toward measured heading at a corner
{
  const mockAnalyzer = { filteredGps: null };
  const data = [];
  for (let i = 0; i <= 10; i++) data.push({ time: i });
  // Anchor A heading due east (90°); anchor B arrives heading due north (0°) —
  // a real corner. Doppler speed/course live on the raw `data` rows, not on
  // gpsPoints (reconstructFilteredGps reads them from data[idxA]/data[idxB]).
  data[0].speedKts = 3;
  data[0].course = 90;
  data[10].speedKts = 3;
  data[10].course = 0;

  const gpsPoints = [
    { lat: 51.5, lon: -0.1, origIdx: 0 },
    { lat: 51.5005, lon: -0.0997, origIdx: 10 },
  ];
  GpsPipeline.reconstructFilteredGps(mockAnalyzer, data, gpsPoints, 10.0);
  const fg = mockAnalyzer.filteredGps;
  const mid = fg[5];
  const lerpMidLat = (gpsPoints[0].lat + gpsPoints[1].lat) / 2;
  const lerpMidLon = (gpsPoints[0].lon + gpsPoints[1].lon) / 2;
  assert(
    Math.abs(mid.lat - lerpMidLat) > 1e-7 ||
      Math.abs(mid.lon - lerpMidLon) > 1e-7,
    'reconstructFilteredGps: Hermite midpoint at a corner differs from the plain straight-chord midpoint',
  );
  // Endpoints are exact regardless of the curve in between (Hermite boundary property)
  assertEq(
    fg[0].lat,
    gpsPoints[0].lat,
    'reconstructFilteredGps: Hermite still reproduces anchor A exactly',
  );
  assertEq(
    fg[10].lat,
    gpsPoints[1].lat,
    'reconstructFilteredGps: Hermite still reproduces anchor B exactly',
  );
}

// 5e3. reconstructFilteredGps — falls back to plain lerp when speed/course are missing
{
  const mockAnalyzer = { filteredGps: null };
  const data = [];
  for (let i = 0; i <= 10; i++) data.push({ time: i }); // no speedKts/course fields at all
  const gpsPoints = [
    { lat: 51.5, lon: -0.1, origIdx: 0 },
    { lat: 51.5005, lon: -0.0997, origIdx: 10 },
  ];
  GpsPipeline.reconstructFilteredGps(mockAnalyzer, data, gpsPoints, 10.0);
  const fg = mockAnalyzer.filteredGps;
  const mid = fg[5];
  const lerpMidLat = (gpsPoints[0].lat + gpsPoints[1].lat) / 2;
  const lerpMidLon = (gpsPoints[0].lon + gpsPoints[1].lon) / 2;
  assertClose(
    mid.lat,
    lerpMidLat,
    1e-12,
    'reconstructFilteredGps: no speed/course data -> exact plain lerp (unchanged fallback behaviour)',
  );
  assertClose(
    mid.lon,
    lerpMidLon,
    1e-12,
    'reconstructFilteredGps: no speed/course -> exact plain lerp (lon)',
  );
}

// 5e4. reconstructFilteredGps — falls back to plain lerp when the endpoint
// tangents are much slower than the chord's own average velocity (e.g. real
// fixes dropped mid-segment by the HDOP/fix-type gate, so the anchors sit
// further apart than either one's own instantaneous speed implies). A naive
// Hermite curve there has to speed up mid-segment to still land on cB,
// which can exceed maxSpeed locally even though the chord average doesn't
// (found via tracks/biomap_029.csv producing extra broken 2D path segments
// that the 3D globe — which doesn't apply this same local-speed check — did
// not show).
{
  const mockAnalyzer = { filteredGps: null };
  const data = [];
  for (let i = 0; i <= 8; i++) data.push({ time: i * 0.1 });
  data[0].speedKts = 0;
  data[0].course = 0;
  data[8].speedKts = 0;
  data[8].course = 0;

  const cA = { lat: 51.5, lon: -0.1 };
  const cB = { lat: 51.5 + 2.16 / 111320, lon: -0.1 }; // ~2.16 m north over 0.8s -> avg 2.7 m/s
  const gpsPoints = [
    { ...cA, origIdx: 0 },
    { ...cB, origIdx: 8 },
  ];
  GpsPipeline.reconstructFilteredGps(mockAnalyzer, data, gpsPoints, 3.0);
  const fg = mockAnalyzer.filteredGps;

  for (let i = 0; i <= 8; i++) {
    const ratio = i / 8;
    assertClose(
      fg[i].lat,
      cA.lat + ratio * (cB.lat - cA.lat),
      1e-12,
      `reconstructFilteredGps: slow-tangent/fast-chord segment falls back to plain lerp at i=${i}`,
    );
  }
}

// 5e5. gapSpeedMultiplier / reconstructFilteredGps — a gap whose implied
// speed exceeds maxSpeed is still blanked to NaN by default (raw GPS jitter
// isn't trustworthy), but is connected once both anchors were confidently
// road-snapped (a matched-road jump is more trustworthy than the same jump
// in raw GPS) — found via tracks/biomap_026.csv producing extra broken 2D
// segments at large Snap Radius values, worst at HMM-matcher junction
// candidate flips.
{
  assertEq(
    GpsPipeline.gapSpeedMultiplier(null, 0, 1),
    1,
    'gapSpeedMultiplier: no snappedGps -> multiplier 1',
  );
  assertEq(
    GpsPipeline.gapSpeedMultiplier({ 0: { alpha: 0.9 } }, 0, 1),
    1,
    'gapSpeedMultiplier: only one side snapped -> multiplier 1',
  );
  assert(
    GpsPipeline.gapSpeedMultiplier(
      { 0: { alpha: 0.9 }, 1: { alpha: 0.5 } },
      0,
      1,
    ) > 1,
    'gapSpeedMultiplier: both sides confidently snapped -> multiplier > 1',
  );
  assertEq(
    GpsPipeline.gapSpeedMultiplier(
      { 0: { alpha: 0 }, 1: { alpha: 0.5 } },
      0,
      1,
    ),
    1,
    'gapSpeedMultiplier: alpha=0 on one side (no actual pull) -> multiplier 1',
  );

  const data = [];
  for (let i = 0; i <= 5; i++) data.push({ time: i * 0.1 });
  const cA = { lat: 51.556, lon: -0.071 };
  const cB = { lat: 51.556 + 5 / 111320, lon: -0.071 }; // ~5m over 0.5s -> 10 m/s, fails maxSpeed=3.0
  const gpsPoints = [
    { ...cA, origIdx: 0 },
    { ...cB, origIdx: 5 },
  ];

  // 10 m/s over 5 m is noise-level, not impossible: connected with or without snap
  const unsnapped = { filteredGps: null, snappedGps: null };
  GpsPipeline.reconstructFilteredGps(unsnapped, data, gpsPoints, 3.0);
  assert(
    !isNaN(unsnapped.filteredGps[2].lat),
    'reconstructFilteredGps: fast-but-not-impossible gap stays connected',
  );

  // A genuinely impossible jump (~500 m in 0.5 s) is still blanked
  const farB = { lat: 51.556 + 500 / 111320, lon: -0.071 };
  const impossible = { filteredGps: null, snappedGps: null };
  GpsPipeline.reconstructFilteredGps(
    impossible,
    data,
    [
      { ...cA, origIdx: 0 },
      { ...farB, origIdx: 5 },
    ],
    3.0,
  );
  assert(
    isNaN(impossible.filteredGps[2].lat),
    'reconstructFilteredGps: impossible jump is blanked (NaN)',
  );
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
  assertEq(
    mockAnalyzer.filteredGps,
    null,
    'reconstructFilteredGpsCached hits cache (no recompute)',
  );
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
  assert(
    mockAnalyzer.filteredGps !== null,
    'reconstructFilteredGpsCached recomputes on different coords',
  );
  assert(
    mockAnalyzer._filteredGpsCacheKey !== key1,
    'reconstructFilteredGpsCached key changes on different coords',
  );
}

// 5h. downsampleForDisplay — no downsample → full array (copies)
{
  const pts = [
    { lat: 0, lon: 0 },
    { lat: 1, lon: 1 },
    { lat: 2, lon: 2 },
  ];
  const result = GpsPipeline.downsampleForDisplay(pts, 10, false);
  assertEq(result.length, 3, 'downsample off → full array');
}

// 5i. downsampleForDisplay — with downsample
{
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push({ lat: i, lon: i });
  const result = GpsPipeline.downsampleForDisplay(pts, 10, true);
  assert(
    result.length <= 12,
    `downsample 10 Hz → ≤12 points (got ${result.length})`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
//  6. Cross-module dependency verification
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── Cross-module dependencies ──');

// 6c. applyHdopGate handles empty arrays
assertEq(
  GpsPipeline.applyHdopGate([], 2.0).length,
  0,
  'HDOP gate empty → empty',
);

// 6d. applyFixTypeGate handles empty arrays
assertEq(
  GpsPipeline.applyFixTypeGate([], 2).length,
  0,
  'FixType gate empty → empty',
);

// 6e. applyFixTypeGate minFixType < 2 → passthrough
{
  const pts = [{ fixType: 1 }, { fixType: 0 }];
  const r = GpsPipeline.applyFixTypeGate(pts, 1);
  assertEq(r, pts, 'FixType gate minFixType<2 → passthrough');
}

// ────────────────────────────────────────────────────────────────────────────
summary();
