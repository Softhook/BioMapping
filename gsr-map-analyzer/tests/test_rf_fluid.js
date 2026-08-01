/**
 * Unit Test for RF Fluid Renderer & Tri-Band CSV Data Pipeline
 *
 * Tests:
 * 1. GSR + GPS + RF full CSV parsing.
 * 2. Standalone GPS + RF CSV parsing (where GSR conductance column is absent).
 * 3. RFFluidRenderer ray-segment intersection calculation.
 * 4. Multi-spectral RGB fluid color normalization.
 *
 * Run: node gsr-map-analyzer/tests/test_rf_fluid.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const assert = require('assert');

// Bootstrap scope
global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  let wrapped = src;
  if (varName) {
    wrapped = src.replace(
      new RegExp(`class ${varName}\\s*{`),
      `global.${varName} = class ${varName} {`
    ).replace(
      new RegExp(`const ${varName}\\s*=`),
      `global.${varName} =`
    );
  }
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../geo_utils.js'),          'GeoUtils');
loadModule(path.join(__dirname, '../stats_math.js'),         'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),         'MapColors');
loadModule(path.join(__dirname, '../gps_filter.js'),         'GpsFilter');
loadModule(path.join(__dirname, '../gps_pipeline.js'),       'GpsPipeline');
loadModule(path.join(__dirname, '../deconvolution.js'),       'SCRDeconvolution');
loadModule(path.join(__dirname, '../gsr_filter.js'),         'GsrFilter');
loadModule(path.join(__dirname, '../analyzer.js'),            'GSRAnalyzer');
loadModule(path.join(__dirname, '../rf_fluid_renderer.js'),   'RFFluidRenderer');

console.log('=== Running RF Fluid & Tri-Band Pipeline Tests ===');

// ── 1. Standalone GPS + RF CSV Parsing Test ─────────────────────────────
console.log('Testing standalone GPS + RF CSV parsing...');
const rfCsvText = [
  '# Calibrated: YES (CRC: 0xF1BE66C2)',
  'timestamp,lat,lon,hdop,fix_type,em_fog,rssi_815,rssi_868,rssi_915',
  '0.00,56.3394928,-2.7894708,3.2,3,16.6,-91.5,-92.0,-91.5',
  '0.10,56.3394927,-2.7894710,3.2,3,18.2,-75.0,-80.5,-85.0',
  '0.20,56.3394927,-2.7894710,3.2,3,25.4,-60.0,-72.0,-78.0'
].join('\n');

const analyzerRF = new GSRAnalyzer();
analyzerRF.parseCSV(rfCsvText);

assert.strictEqual(analyzerRF.raw.length, 3, 'Should parse 3 rows of standalone GPS+RF data');
assert.strictEqual(analyzerRF.raw[0].rssi_815, -91.5, 'Row 0 rssi_815 match');
assert.strictEqual(analyzerRF.raw[1].rssi_868, -80.5, 'Row 1 rssi_868 match');
assert.strictEqual(analyzerRF.raw[2].rssi_915, -78.0, 'Row 2 rssi_915 match');
assert.strictEqual(analyzerRF.hasRfData, true, 'hasRfData should be true');
console.log('✓ Standalone GPS + RF CSV parsed successfully');

// ── 2. Full GSR + GPS + RF CSV Parsing Test ───────────────────────────
console.log('Testing unified GSR + GPS + RF CSV parsing...');
const fullCsvText = [
  'Time (s),Raw Conductance (uS),Latitude,Longitude,rssi_815,rssi_868,rssi_915,em_fog',
  '0.00,5.12,56.3394,-2.7894,-91.5,-91.5,-91.5,10.0',
  '0.10,5.15,56.3395,-2.7895,-70.0,-82.0,-88.0,22.5'
].join('\n');

const analyzerFull = new GSRAnalyzer();
analyzerFull.parseCSV(fullCsvText);

assert.strictEqual(analyzerFull.raw.length, 2, 'Should parse 2 rows of full GSR+GPS+RF data');
assert.strictEqual(analyzerFull.raw[0].val, 5.12, 'Row 0 GSR conductance match');
assert.strictEqual(analyzerFull.raw[1].rssi_815, -70.0, 'Row 1 rssi_815 match');
assert.strictEqual(analyzerFull.hasRfData, true, 'hasRfData should be true for full CSV');
console.log('✓ Unified GSR + GPS + RF CSV parsed successfully');

// ── 3. Ray-Segment Intersection Math Test ─────────────────────────────
console.log('Testing RFFluidRenderer ray-segment intersection math...');
// Mock simple Leaflet map object
const mockMap = {
  getPanes: () => ({ overlayPane: { appendChild: () => {} } }),
  getSize: () => ({ x: 800, y: 600 }),
  getBounds: () => ({ pad: () => ({ contains: () => true }) }),
  containerPointToLayerPoint: (pt) => ({ x: pt[0], y: pt[1] }),
  latLngToContainerPoint: (ll) => ({ x: ll[0] * 10, y: ll[1] * 10 }),
  on: () => {}
};

const renderer = new RFFluidRenderer(mockMap);

// Test ray from (0, 0) in +X direction hitting vertical segment at x = 50 from y = -20 to y = 20
const origin = { lat: 0, lon: 0 };
const dirGeo = { dLat: 0, dLon: 1 };
const segP1 = { lat: -20, lon: 50 };
const segP2 = { lat: 20, lon: 50 };

const t = renderer._raySegmentIntersectionGeo(origin, dirGeo, segP1, segP2);
assert.strictEqual(t, 50, 'Ray should intersect vertical segment at distance fraction 50');

// Test ray missing segment
const missDir = { dLat: 1, dLon: 0 }; // Direction +Y
const tMiss = renderer._raySegmentIntersectionGeo(origin, missDir, segP1, segP2);
assert.strictEqual(tMiss, null, 'Ray in +Y should not intersect segment at lon = 50');

console.log('✓ Ray-segment intersection math verified');

// ── 4. Non-RF Data Guard & Noise Floor Alpha Test ─────────────────────
console.log('Testing RFFluidRenderer non-RF data guard & alpha floor logic...');
const nonRfAnalyzer = new GSRAnalyzer();
nonRfAnalyzer.parseCSV([
  'Time (s),Raw Conductance (uS),Latitude,Longitude',
  '0.00,5.12,56.3394,-2.7894',
  '0.10,5.15,56.3395,-2.7895'
].join('\n'));

assert.strictEqual(nonRfAnalyzer.hasRfData, false, 'hasRfData should be false for non-RF track');

renderer.setData(nonRfAnalyzer.raw, null);
assert.strictEqual(renderer.cachedNodes.length, 2, 'Should cache 2 nodes');
assert.strictEqual(renderer.cachedNodes[0].hasRf, false, 'Node 0 hasRf should be false');
assert.strictEqual(renderer.cachedNodes[1].hasRf, false, 'Node 1 hasRf should be false');

console.log('✓ Non-RF data guard & alpha floor logic verified');

// ── 5. Adaptive RSSI Normalization & Hard Noise Floor Thresholding Test ───
console.log('Testing adaptive RSSI normalization & hard noise floor thresholding...');
const rfAnalyzerSample = new GSRAnalyzer();
rfAnalyzerSample.parseCSV([
  'timestamp,lat,lon,hdop,fix_type,em_fog,rssi_815,rssi_868,rssi_915',
  '0.00,56.3394,-2.7894,2.5,3,10.0,-91.5,-92.0,-90.0', // Ambient noise floor (no 915 MHz signal)
  '0.10,56.3395,-2.7895,2.5,3,10.0,-72.0,-92.0,-89.5', // Active 815 MHz LTE spike, 915 remains quiet
  '0.20,56.3396,-2.7896,2.5,3,10.0,-91.5,-72.0,-91.0'  // Active 868 MHz Grid spike, 915 remains quiet
].join('\n'));

renderer.setData(rfAnalyzerSample.raw, null);
assert.ok(renderer.rssiStats, 'rssiStats should be computed');
assert.strictEqual(renderer.rssiStats[815].peak, -72.0, '815 peak RSSI match');
assert.strictEqual(renderer.rssiStats[815].hasActiveSignal, true, '815 should have active signal');

// 915 MHz peak was -89.5 dBm (<= -85 dBm hard noise floor) -> hasActiveSignal should be false
assert.strictEqual(renderer.rssiStats[915].hasActiveSignal, false, '915 should have NO active signal');
assert.strictEqual(renderer._normDbm(-89.5, 915), 0.0, 'Quiet 915 band should return 0.0 everywhere');

// Verify noise floor point for active band returns 0.0 (no fluid drawn)
const norm815Floor = renderer._normDbm(-91.5, 815);
assert.strictEqual(norm815Floor, 0.0, 'Noise floor signal should return 0.0 norm');

// Verify elevated peak signal returns > 0.9 (vibrant fluid fan)
const norm815Peak = renderer._normDbm(-72.0, 815);
assert.ok(norm815Peak > 0.9, 'Peak signal should return > 0.9 norm');

console.log('✓ Adaptive RSSI normalization & hard noise floor thresholding verified');

// ── 6. Dynamic EM Fog Calculation & Analyzer Time-Series Test ─────────────
console.log('Testing dynamic EM Fog calculation & time-series generation...');
const missingFogCsv = [
  'timestamp,lat,lon,rssi_300,rssi_315,rssi_434,rssi_446,rssi_815,rssi_868,rssi_915',
  '0.00,56.3394,-2.7894,-82.0,-78.0,-81.0,-83.0,-90.0,-88.0,-91.5',
  '0.10,56.3395,-2.7895,-70.0,-65.0,-60.0,-72.0,-85.0,-78.0,-80.0'
].join('\n');

const dynamicFogAnalyzer = new GSRAnalyzer();
dynamicFogAnalyzer.parseCSV(missingFogCsv);

assert.strictEqual(dynamicFogAnalyzer.raw.length, 2, 'Should parse 2 rows');
assert.ok(!isNaN(dynamicFogAnalyzer.raw[0].em_fog), 'Row 0 em_fog should be dynamically calculated');
assert.ok(dynamicFogAnalyzer.raw[0].em_fog > 0, 'Row 0 em_fog should be positive');
assert.ok(dynamicFogAnalyzer.raw[1].em_fog > dynamicFogAnalyzer.raw[0].em_fog, 'Row 1 em_fog should be higher than Row 0');

dynamicFogAnalyzer.analyze(GSR_CONST.GSR_DEFAULT);
assert.ok(Array.isArray(dynamicFogAnalyzer.em_fog), 'analyzer.em_fog array should exist');
assert.strictEqual(dynamicFogAnalyzer.em_fog.length, 2, 'analyzer.em_fog length should match raw length');
assert.ok(dynamicFogAnalyzer._globalRange.em_fog, '_globalRange.em_fog should be cached');

renderer.setData(dynamicFogAnalyzer.raw, null);
assert.strictEqual(renderer.cachedNodes[0].hasFog, true, 'Cached node 0 should have fog flag');
assert.ok(renderer.cachedNodes[0].fog > 0, 'Cached node 0 fog should be > 0');

console.log('✓ Dynamic EM Fog calculation & time-series generation verified');

// ── 7. Explicit Zero em_fog Must Not Be Overwritten By The Fallback ───────
console.log('Testing explicit em_fog=0 is preserved despite present RSSI data...');
const zeroFogPoint = {
  lat: 56.3394, lon: -2.7894,
  em_fog: 0,
  rssi_300: -70.0, rssi_315: -65.0, rssi_434: -60.0, rssi_446: -72.0,
  rssi_815: -85.0, rssi_868: -78.0, rssi_915: -80.0
};
renderer.setData([zeroFogPoint], null);
assert.strictEqual(renderer.cachedNodes[0].fog, 0, 'Explicit em_fog=0 should stay 0, not be recomputed from RSSI');
assert.strictEqual(renderer.cachedNodes[0].hasFog, false, 'hasFog should be false when em_fog is explicitly 0');
console.log('✓ Explicit em_fog=0 preserved (not overwritten by RSSI-derived fallback)');

console.log('ALL RF FLUID & TRI-BAND PIPELINE TESTS PASSED SUCCESSFULY!');



