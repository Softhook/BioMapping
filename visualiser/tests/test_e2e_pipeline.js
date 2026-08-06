/**
 * End-to-end pipeline test — loads a real BioMapping CSV track and exercises
 * the full data flow: CSV parse → GPS filter pipeline → reconstructed path.
 *
 * Run: node tests/test_e2e_pipeline.js
 */

const fs   = require('fs');
const path = require('path');

// ── Load analyser modules into global scope ─────────────────────────────────
// Same bootstrap as test_refactor.js.
const vm = require('vm');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(
      new RegExp(`class ${varName}\\s*{`),
      `global.${varName} = class ${varName} {`
    )
    .replace(
      new RegExp(`const ${varName}\\s*=`),
      `global.${varName} =`
    );
  vm.runInThisContext(wrapped, { filename: filePath });
}

// Mock GSR_CONST (same as mock_constants.js)
global.GSR_CONST = require('./mock_constants.js');

loadModule(path.join(__dirname, '../geo_utils.js'),    'GeoUtils');
loadModule(path.join(__dirname, '../stats_math.js'),   'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),   'MapColors');
loadModule(path.join(__dirname, '../gps_filter.js'),   'GpsFilter');
loadModule(path.join(__dirname, '../gps_pipeline.js'), 'GpsPipeline');
loadModule(path.join(__dirname, '../dwt_filter.js'),   'DWT');       // needed by analyzer.js
loadModule(path.join(__dirname, '../gsr_filter.js'),   'GsrFilter');  // needed by analyzer.js
loadModule(path.join(__dirname, '../csv_parser.js'),   'GSRCSVParser');       // needed by analyzer.js

const { GeoUtils, StatsMath, MapColors, GpsFilter, GpsPipeline, GsrFilter } = global;

// ── Load GSRAnalyzer class ──────────────────────────────────────────────────
// The analyzer assigns itself to window.GSRAnalyzer at the end.
global.window = global;
const analyzerSrc = fs.readFileSync(path.join(__dirname, '../analyzer.js'), 'utf8');
vm.runInThisContext(analyzerSrc, { filename: 'analyzer.js' });
const GSRAnalyzer = global.GSRAnalyzer;

// ── Test helpers ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) passed++; else { failed++; console.error('  FAIL:', msg); } }
function assertEq(a, b, msg) { if (a === b) passed++; else { failed++; console.error('  FAIL:', msg, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); } }
function assertClose(a, b, tol, msg) { if (Math.abs(a-b) <= tol) passed++; else { failed++; console.error('  FAIL:', msg, `expected ~${b}, got ${a}`); } }

// ────────────────────────────────────────────────────────────────────────────
//  LOAD & PARSE
// ────────────────────────────────────────────────────────────────────────────
console.log('── Loading track ──');

const csvPath = path.join(__dirname, '../../tracks/biomap_048.csv');
const csvText = fs.readFileSync(csvPath, 'utf8');

const analyzer = new GSRAnalyzer();
analyzer.parseCSV(csvText);

const raw = analyzer.raw;
console.log(`  Rows: ${raw.length}`);
console.log(`  Sample rate: ${analyzer.sampleRate.toFixed(1)} Hz`);

// ────────────────────────────────────────────────────────────────────────────
//  1. Verify CSV schema — no phantom columns (N1)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── 1. CSV schema (N1/N2) ──');

// Check that parsed points don't have vdop or wdop fields
const firstPoint = raw[0];
assert(!('vdop' in firstPoint), 'No vdop field on parsed points (N1)');
assert(!('wdop' in firstPoint), 'No wdop field on parsed points (N1)');
assert(!('alt'  in firstPoint), 'No alt field on parsed points (N1)');

// Check that the 11 canonical columns are present (N2)
const CSV_COLUMNS = GSR_CONST.CSV_COLUMNS;
assertEq(CSV_COLUMNS.length, 11, 'CSV_COLUMNS has 11 canonical columns');
for (const col of CSV_COLUMNS) {
  // All points should have these canonical fields (via parser)
  if (col === 'timestamp') {
    assert('time' in firstPoint, `Canonical field 'timestamp' mapped to 'time'`);
  } else if (col === 'gsr_raw') {
    assert('val' in firstPoint, `Canonical field 'gsr_raw' mapped to 'val'`);
  } else if (col === 'speed_kts') {
    assert('speedKts' in firstPoint, `Canonical field 'speed_kts' mapped to 'speedKts'`);
  } else if (col === 'course_deg') {
    assert('course' in firstPoint, `Canonical field 'course_deg' mapped to 'course'`);
  } else if (col === 'fix_type') {
    assert('fixType' in firstPoint, `Canonical field 'fix_type' mapped to 'fixType'`);
  } else if (col === 'hacc_m') {
    assert('hacc' in firstPoint, `Canonical field 'hacc_m' mapped to 'hacc'`);
  } else {
    assert(col in firstPoint, `Canonical field '${col}' present on parsed point`);
  }
}

// This fixture track (tracks/biomap_048.csv) predates CSV schema v1.2, so it
// has no hacc_m column — confirm the parser degrades to NaN rather than
// crashing or defaulting to a value that would look like a valid accuracy.
assert(isNaN(firstPoint.hacc), 'hacc is NaN when the source CSV predates the hacc_m column (v1.1 fixture)');

// Count GPS fixes
const gpsFixes = raw.filter(p => p._isGpsFix && !isNaN(p.lat) && !isNaN(p.lon));
console.log(`  GPS fixes in track: ${gpsFixes.length} / ${raw.length}`);

// ────────────────────────────────────────────────────────────────────────────
//  2. Run GPS filter pipeline (N3/N4/N5)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── 2. GPS filter pipeline ──');

// Collect GPS points (same logic as map.js:_collectGpsPoints)
function collectGpsPoints(data) {
  const pts = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i]._isGpsFix && !isNaN(data[i].lat) && !isNaN(data[i].lon)) {
      pts.push({ ...data[i], origIdx: i });
    }
  }
  return pts;
}

let gpsPoints = collectGpsPoints(raw);
const initialCount = gpsPoints.length;
assert(initialCount > 0, `GPS fix points found: ${initialCount}`);

// ── 2a. HDOP gate ──
const maxHdop = 2.0;
const hasHdop = gpsPoints.some(p => !isNaN(p.hdop));
if (hasHdop) {
  gpsPoints = GpsPipeline.applyHdopGate(gpsPoints, maxHdop);
  assert(gpsPoints.length <= initialCount, `HDOP gate: ${initialCount} → ${gpsPoints.length}`);
} else {
  console.log('  Skipping HDOP gate (no HDOP data in CSV)');
}

// ── 2b. Fix-type gate ──
// Old-format CSVs (biomap_030) have all fix_type=1 ("no fix").
// The gate's minFixType=2 would filter everything — skip it for old tracks.
const hasValidFixes = gpsPoints.some(p => (p.fixType || 0) >= 2);
if (hasValidFixes) {
  gpsPoints = GpsPipeline.applyFixTypeGate(gpsPoints);
} else {
  console.log('  Skipping fix-type gate (all fix_type < 2, old-format CSV)');
}
console.log(`  After gates: ${gpsPoints.length} GPS anchors`);

// ── 2c. Pre-Kalman filters ──
const smoothing = 0.5;
const maxSpeed = 3.0;
gpsPoints = GpsPipeline.applyPreKalmanFilters(gpsPoints, smoothing, maxSpeed);
assert(gpsPoints.length > 0, 'Pre-Kalman filters preserve points');
console.log(`  After pre-Kalman: ${gpsPoints.length} points`);

// ── 2d. Kalman filter ──
const kalmanR = 10;
const kalmanResult = GpsFilter.applyKalman(gpsPoints, smoothing, kalmanR);
assertEq(kalmanResult.length, gpsPoints.length, 'Kalman preserves point count');

// ── 2e. Reconstruct 10 Hz path ──
GpsPipeline.reconstructFilteredGps(analyzer, raw, kalmanResult);
const filteredGps = analyzer.filteredGps;
assertEq(filteredGps.length, raw.length, 'Filtered GPS fills all rows');
const validFiltered = filteredGps.filter(p => !isNaN(p.lat) && !isNaN(p.lon));
assert(validFiltered.length > 0, `Filtered GPS has valid points: ${validFiltered.length}`);
console.log(`  Reconstructed path: ${validFiltered.length}/${raw.length} valid positions`);

// ── 2f. Build draw points ──
const drawPoints = [];
for (let i = 0; i < raw.length; i++) {
  const fg = filteredGps[i];
  if (fg && !isNaN(fg.lat) && !isNaN(fg.lon)) {
    drawPoints.push({ ...raw[i], lat: fg.lat, lon: fg.lon, origIdx: i });
  }
}
assert(drawPoints.length > 0, `Draw points built: ${drawPoints.length}`);

// Downsample
const drawDownsampled = GpsPipeline.downsampleForDisplay(drawPoints, 10, false);
assertEq(drawDownsampled.length, drawPoints.length, 'No-downsample preserves count');

// ────────────────────────────────────────────────────────────────────────────
//  3. Verify Kalman response to parameter changes (the slider bug)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── 3. Parameter sensitivity (slider bug regression) ──');

// Re-run from scratch with extreme params
function runPipeline(data, smoothingVal, kalmanRVal) {
  let pts = collectGpsPoints(data);
  if (pts.some(p => !isNaN(p.hdop))) pts = GpsPipeline.applyHdopGate(pts, 2.0);
  if (pts.some(p => (p.fixType || 0) >= 2)) pts = GpsPipeline.applyFixTypeGate(pts);
  pts = GpsPipeline.applyPreKalmanFilters(pts, smoothingVal, 3.0);
  pts = GpsFilter.applyKalman(pts, smoothingVal, kalmanRVal);
  return pts;
}

const smoothPts    = runPipeline(raw, 0.02, 150);
const responsivePts = runPipeline(raw, 10, 0.5);

// The two extremes should produce different Kalman outputs
let totalDiffSq = 0;
const minLen = Math.min(smoothPts.length, responsivePts.length);
for (let i = 0; i < minLen; i++) {
  const dLat = smoothPts[i].lat - responsivePts[i].lat;
  const dLon = smoothPts[i].lon - responsivePts[i].lon;
  totalDiffSq += dLat * dLat + dLon * dLon;
}
const rmsDiffDeg = Math.sqrt(totalDiffSq / minLen);
const rmsDiffM   = rmsDiffDeg * 111320;
assert(rmsDiffM > 0.1, `Smooth vs responsive differ: RMS = ${rmsDiffM.toFixed(2)} m (should be >0.1 m)`);
console.log(`  Smooth (Q=0.02,R=150) vs Responsive (Q=10,R=0.5): RMS difference = ${rmsDiffM.toFixed(2)} m`);

// ─── Verify the path actually changes with different params ───
// This is the critical test: if the cache key bug were still present,
// the reconstructed path would be identical for both param sets.
const mockAnalyzerA = { filteredGps: null, _filteredGpsCacheKey: null };
const mockAnalyzerB = { filteredGps: null, _filteredGpsCacheKey: null };

GpsPipeline.reconstructFilteredGpsCached(mockAnalyzerA, raw, smoothPts);
GpsPipeline.reconstructFilteredGpsCached(mockAnalyzerB, raw, responsivePts);

const fgA = mockAnalyzerA.filteredGps;
const fgB = mockAnalyzerB.filteredGps;

let pathDiffSq = 0;
let compared = 0;
for (let i = 0; i < Math.min(fgA.length, fgB.length); i++) {
  if (!isNaN(fgA[i].lat) && !isNaN(fgB[i].lat)) {
    const dLat = fgA[i].lat - fgB[i].lat;
    const dLon = fgA[i].lon - fgB[i].lon;
    pathDiffSq += dLat * dLat + dLon * dLon;
    compared++;
  }
}
const pathRmsM = Math.sqrt(pathDiffSq / Math.max(1, compared)) * 111320;
assert(pathRmsM > 0.01, `Reconstructed paths differ: RMS = ${pathRmsM.toFixed(2)} m (cache invalidation works)`);
console.log(`  Reconstructed path difference: ${pathRmsM.toFixed(2)} m RMS (cache correctly invalidated)`);

// Also verify the cache key itself changed
assert(mockAnalyzerA._filteredGpsCacheKey !== mockAnalyzerB._filteredGpsCacheKey,
  'Cache keys differ between param sets');

// ────────────────────────────────────────────────────────────────────────────
//  4. Data integrity checks
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── 4. Data integrity ──');

// Verify Kalman output stays within reasonable bounds of raw GPS
for (let i = 0; i < Math.min(10, kalmanResult.length); i++) {
  const rawPt = gpsPoints[i];
  const kalPt = kalmanResult[i];
  const dist = GeoUtils.haversineMeters(rawPt.lat, rawPt.lon, kalPt.lat, kalPt.lon);
  assert(dist < 50, `Kalman point ${i} within 50 m of raw (${dist.toFixed(1)} m)`);
}

// Verify sample rate detection
assert(analyzer.sampleRate > 5 && analyzer.sampleRate < 20,
  `Sample rate detection: ${analyzer.sampleRate.toFixed(1)} Hz (expected 5-20)`);

// Verify GSR values
const gsrVals = raw.map(p => p.val).filter(v => !isNaN(v));
const gsrMin = Math.min(...gsrVals);
const gsrMax = Math.max(...gsrVals);
assert(gsrMin > 0, `GSR min > 0 (${gsrMin.toFixed(1)} µS)`);
assert(gsrMax < 100000, `GSR max < 100k (${gsrMax.toFixed(1)} µS)`);
console.log(`  GSR range: ${gsrMin.toFixed(1)} – ${gsrMax.toFixed(1)} µS`);

// ────────────────────────────────────────────────────────────────────────────
//  5. Haversine consistency across modules (N3)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── 5. Haversine consistency (N3) ──');

// All three module paths should give the same result
const testLat1 = raw[0].lat, testLon1 = raw[0].lon;
const testLat2 = raw[Math.floor(raw.length / 2)].lat, testLon2 = raw[Math.floor(raw.length / 2)].lon;

if (!isNaN(testLat1) && !isNaN(testLat2)) {
  const d1 = GeoUtils.haversineMeters(testLat1, testLon1, testLat2, testLon2);
  const d2 = GpsFilter.haversineDistance(testLat1, testLon1, testLat2, testLon2);
  assertClose(d1, d2, 0.001, 'GpsFilter.haversineDistance ≡ GeoUtils.haversineMeters');
}
// We can't test map_match._haversineM or osm_enrichment.haversine without
// loading those modules, but they both delegate via the same pattern.

// ────────────────────────────────────────────────────────────────────────────
//  6. GPS timing & monotonicity
// ────────────────────────────────────────────────────────────────────────────
console.log('\n── 6. Timing ──');

// Verify timestamps are monotonic after parsing
let timeReversals = 0;
for (let i = 1; i < raw.length; i++) {
  if (raw[i].time < raw[i-1].time) timeReversals++;
}
assertEq(timeReversals, 0, `Timestamps monotonic (${timeReversals} reversals)`);

const duration = raw[raw.length - 1].time - raw[0].time;
assert(duration > 0, `Track duration > 0: ${duration.toFixed(1)} s`);
console.log(`  Duration: ${duration.toFixed(1)} s (${(duration/60).toFixed(1)} min)`);

// ────────────────────────────────────────────────────────────────────────────
//  Summary
// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`End-to-end pipeline test: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}`);
if (failed > 0) process.exit(1);
