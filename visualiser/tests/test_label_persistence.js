const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src.replace(
    new RegExp(`class ${varName}\\s*{`),
    `global.${varName} = class ${varName} {`
  ).replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/gps/geo_utils.js'),          'GeoUtils');
loadModule(path.join(__dirname, '../src/signal/stats_math.js'),         'StatsMath');
loadModule(path.join(__dirname, '../src/map/map_colors.js'),         'MapColors');
loadModule(path.join(__dirname, '../src/gps/gps_filter.js'),         'GpsFilter');
loadModule(path.join(__dirname, '../src/gps/gps_pipeline.js'),       'GpsPipeline');
loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'),         'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'),         'GsrFilter');
loadModule(path.join(__dirname, '../src/spatial/spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../src/render/marching_squares.js'),   'MarchingSquares');
loadModule(path.join(__dirname, '../src/spatial/collective_manager.js'), 'GSRCollectiveManager');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'),      'SCRDeconvolution');

const { GSRAnalyzer } = require('../src/signal/analyzer.js');

console.log('── Testing Peak Label Persistence & Store ──');

// Load sample track CSV
const csvPath = path.join(__dirname, '../fixtures/default_processed.csv');
let csvData = '';
if (fs.existsSync(csvPath)) {
  csvData = fs.readFileSync(csvPath, 'utf8');
} else {
  csvData = "Time (s),Raw Conductance (uS)\n0.0,1.0\n0.1,1.0\n0.2,1.5\n0.3,2.0\n0.4,1.8\n0.5,1.0\n0.6,1.0\n0.7,2.5\n0.8,3.0\n0.9,2.2\n1.0,1.0";
}

const analyzer = new GSRAnalyzer();
analyzer.parseCSV(csvData);
const params = JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));
params.peakThreshold = 0.01;
analyzer.analyze(params);

assert(analyzer.peaks.length > 0, 'Should detect peaks in sample track');
const firstPeak = analyzer.peaks[0];
const targetTime = firstPeak.time;

// Assign label to first peak
analyzer.setPeakLabel(targetTime, 'Test Event Alpha');
firstPeak.label = 'Test Event Alpha';

console.log(`Labeled peak at t=${targetTime.toFixed(2)}s with "Test Event Alpha"`);

// 1. Re-analyze with slight parameter change (shape filter change)
params.shapeMinRiseTime = 0.2;
analyzer.analyze(params);

const reanalyzedPeak = analyzer.peaks.find(p => Math.abs(p.time - targetTime) <= 0.5);
assert(reanalyzedPeak, 'Peak should still exist after re-analysis');
assert.strictEqual(reanalyzedPeak.label, 'Test Event Alpha', 'Peak label must persist across parameter changes');
console.log('✓ Label persisted across parameter tweak');

// 2. Filter out peak with very high threshold
params.peakThreshold = 999.0;
analyzer.analyze(params);
// 3. Restore low threshold
params.peakThreshold = 0.01;
analyzer.analyze(params);
const restoredPeak = analyzer.peaks.find(p => Math.abs(p.time - targetTime) <= 0.5);
assert(restoredPeak, 'Peak should reappear after restoring threshold');
assert.strictEqual(restoredPeak.label, 'Test Event Alpha', 'Peak label must reappear when peak returns');
console.log('✓ Label restored after temporary peak hiding');

// 4. Test explicit label clearing
restoredPeak.label = '';
analyzer.setPeakLabel(restoredPeak.time, '');
analyzer.analyze(params);
const clearedPeak = analyzer.peaks.find(p => Math.abs(p.time - targetTime) <= 0.5);
assert(clearedPeak, 'Peak exists');
assert.strictEqual(clearedPeak.label, '', 'Label should be cleared');
console.log('✓ Label explicitly cleared');

console.log('============================================================');
console.log('Label Persistence Unit Test: Passed cleanly');
console.log('============================================================');
