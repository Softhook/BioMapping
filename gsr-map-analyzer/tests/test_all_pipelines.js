/**
 * Comprehensive pipeline test suite — verifies all parts of the BioMapping data pipeline:
 * - GSR filters (GsrFilter, DWT)
 * - Peak detection algorithms (rise time, onset slope, half-recovery, SNR)
 * - Spatial clustering (GSRSpatialClustering)
 * - Marching Squares contouring (MarchingSquares)
 *
 * Run: node gsr-map-analyzer/tests/test_all_pipelines.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Bootstrap scope ─────────────────────────────────────────────────────────
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

loadModule(path.join(__dirname, '../geo_utils.js'),          'GeoUtils');
loadModule(path.join(__dirname, '../stats_math.js'),         'StatsMath');
loadModule(path.join(__dirname, '../map_colors.js'),         'MapColors');
loadModule(path.join(__dirname, '../gps_filter.js'),         'GpsFilter');
loadModule(path.join(__dirname, '../gps_pipeline.js'),       'GpsPipeline');
loadModule(path.join(__dirname, '../dwt_filter.js'),         'DWT');
loadModule(path.join(__dirname, '../gsr_filter.js'),         'GsrFilter');
loadModule(path.join(__dirname, '../spatial_clustering.js'), 'GSRSpatialClustering');
loadModule(path.join(__dirname, '../marching_squares.js'),   'MarchingSquares');

const {
  GeoUtils, StatsMath, MapColors, GpsFilter, GpsPipeline,
  DWT, GsrFilter, GSRSpatialClustering, MarchingSquares
} = global;

// Load GSRAnalyzer
const analyzerSrc = fs.readFileSync(path.join(__dirname, '../analyzer.js'), 'utf8');
vm.runInThisContext(analyzerSrc, { filename: 'analyzer.js' });
const GSRAnalyzer = global.GSRAnalyzer;

// ── Test framework ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('  FAIL:', msg);
  }
}
function assertEq(a, b, msg) {
  if (a === b) {
    passed++;
  } else {
    failed++;
    console.error('  FAIL:', msg, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) <= tol) {
    passed++;
  } else {
    failed++;
    console.error('  FAIL:', msg, `expected ~${b}, got ${a}`);
  }
}

// ── Load Real CSV track ──
console.log('Loading track biomap_048.csv...');
const csvPath = path.join(__dirname, '../../tracks/biomap_048.csv');
const csvText = fs.readFileSync(csvPath, 'utf8');
const analyzer = new GSRAnalyzer();
analyzer.parseCSV(csvText);

console.log(`  Parsed ${analyzer.raw.length} samples at ${analyzer.sampleRate.toFixed(1)} Hz`);

// ════════════════════════════════════════════════════════════════════════════
//  1. GSR FILTERS & TONIC/PHASIC DECOMPOSITION
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── 1. GSR Filter & DWT Decomposition ──');

const gsrRaw = analyzer.raw.map(d => d.val).filter(v => !isNaN(v));
assert(gsrRaw.length > 100, 'Track contains sufficient raw GSR points');

// Verify GsrFilter methods exist and are runnable
assert(typeof GsrFilter.applyMedianFilter === 'function', 'GsrFilter.applyMedianFilter is a function');
assert(typeof GsrFilter.applyZeroPhaseMovingAverage === 'function', 'GsrFilter.applyZeroPhaseMovingAverage is a function');
assert(typeof GsrFilter.applyPercentileFilter === 'function', 'GsrFilter.applyPercentileFilter is a function');
assert(typeof GsrFilter.applyZeroPhaseEMA === 'function', 'GsrFilter.applyZeroPhaseEMA is a function');

// Run filter tests
const medResult = GsrFilter.applyMedianFilter(gsrRaw, 5);
assertEq(medResult.length, gsrRaw.length, 'applyMedianFilter preserves length');

const smoothResult = GsrFilter.applyZeroPhaseMovingAverage(gsrRaw, 10);
assertEq(smoothResult.length, gsrRaw.length, 'applyZeroPhaseMovingAverage preserves length');

// Run full analysis pipeline with DWT
const analyzeParams = {
  ...GSR_CONST.GSR_DEFAULT,
  tonicMethod: 'dwt',
  dwtLevel: 6,
  peakThreshold: 0.05
};
analyzer.analyze(analyzeParams);

assert(analyzer.tonic.length === gsrRaw.length, 'Tonic decomposition matches signal length');
assert(analyzer.phasic.length === gsrRaw.length, 'Phasic decomposition matches signal length');

// Check that tonic component represents a smooth baseline (low frequency)
let tonicMaxDiff = 0;
for (let i = 1; i < analyzer.tonic.length; i++) {
  tonicMaxDiff = Math.max(tonicMaxDiff, Math.abs(analyzer.tonic[i].val - analyzer.tonic[i - 1].val));
}
assert(tonicMaxDiff < 5.0, `Tonic baseline is smooth: max step = ${tonicMaxDiff.toFixed(3)} µS`);

// Check that phasic component has values close to zero but fluctuating
const phasicVals = analyzer.phasic.map(d => d.val);
const phasicAvg = phasicVals.reduce((a, b) => a + b, 0) / phasicVals.length;
assertClose(phasicAvg, 0.1, 0.5, `Phasic average fluctuates near zero: avg = ${phasicAvg.toFixed(4)}`);

// Verify final clamp ensures zero negativity
const negativePhasic = phasicVals.filter(v => v < 0);
assertEq(negativePhasic.length, 0, 'Phasic final clamp prevents negative values');

// ════════════════════════════════════════════════════════════════════════════
//  2. PHASIC PEAK DETECTION ALGORITHMS
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. GSR Phasic Peak Detection ──');

assert(analyzer.peaks.length > 0, `Peaks detected in track: ${analyzer.peaks.length}`);
console.log(`  Detected ${analyzer.peaks.length} phasic peaks`);

// Verify peak shapes have all required physical metrics
const firstPeak = analyzer.peaks[0];
console.log('  Sample Peak Metrics:', {
  amplitude: firstPeak.amplitude.toFixed(3) + ' µS',
  riseTime: firstPeak.riseTime.toFixed(1) + ' s',
  halfRecoveryTime: firstPeak.halfRecoveryTime.toFixed(1) + ' s',
  onsetSlope: firstPeak.onsetSlope.toFixed(3),
  decaySlope: firstPeak.decaySlope.toFixed(3),
  snr: firstPeak.snr.toFixed(1),
  qualityScore: firstPeak.qualityScore.toFixed(2)
});

assert('amplitude' in firstPeak, 'Peak has amplitude metric');
assert('riseTime' in firstPeak, 'Peak has riseTime metric');
assert('halfRecoveryTime' in firstPeak, 'Peak has halfRecoveryTime metric');
assert('onsetSlope' in firstPeak, 'Peak has onsetSlope metric');
assert('decaySlope' in firstPeak, 'Peak has decaySlope');
assert('snr' in firstPeak, 'Peak has snr metric');
assert('qualityScore' in firstPeak, 'Peak has qualityScore');

// Check that peak quality scores fall in [0, 1] range
const outOfBoundsQuality = analyzer.peaks.filter(p => p.qualityScore < 0 || p.qualityScore > 1.0);
assertEq(outOfBoundsQuality.length, 0, 'All peak quality scores are between 0.0 and 1.0');

// ════════════════════════════════════════════════════════════════════════════
//  3. SPATIAL CLUSTERING ALGORITHMS
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. Spatial Peak Clustering ──');

// Mock a list of peaks with lat/lon coordinates
// We will assign coordinates from the parsed track to the detected peaks.
const mapPoints = analyzer.raw.filter(d => !isNaN(d.lat) && !isNaN(d.lon));
const spatialPeaks = [];
for (let i = 0; i < analyzer.peaks.length; i++) {
  const peak = analyzer.peaks[i];
  // Find a raw coordinate close to the peak onset time
  const matchingNode = mapPoints.find(n => Math.abs(n.time - peak.time) < 1.0);
  if (matchingNode) {
    spatialPeaks.push({
      ...peak,
      lat: matchingNode.lat,
      lon: matchingNode.lon
    });
  }
}

console.log(`  Map-matched peaks with lat/lon coordinates: ${spatialPeaks.length} / ${analyzer.peaks.length}`);

// Run spatial clustering
const maxDistanceMeters = 50; // group peaks within 50 meters
const clusters = GSRSpatialClustering.clusterPeaks(spatialPeaks, maxDistanceMeters);

assert(Array.isArray(clusters), 'GSRSpatialClustering.clusterPeaks returns an array of clusters');
console.log(`  Grouped peaks into ${clusters.length} spatial clusters`);

if (clusters.length > 0) {
  const firstCluster = clusters[0];
  assert(firstCluster.length >= 1, 'First cluster contains at least 1 peak');
  
  // Calculate centroid
  const sumLat = firstCluster.reduce((sum, p) => sum + p.lat, 0);
  const sumLon = firstCluster.reduce((sum, p) => sum + p.lon, 0);
  const centroid = { lat: sumLat / firstCluster.length, lon: sumLon / firstCluster.length };

  assert(!isNaN(centroid.lat) && !isNaN(centroid.lon), 'Cluster centroid is a valid coordinate');
  console.log(`  First cluster contains ${firstCluster.length} peaks at centroid: [${centroid.lat.toFixed(5)}, ${centroid.lon.toFixed(5)}]`);

  // Verify getConcaveBlob runs and returns a valid path
  const blob = GSRSpatialClustering.getConcaveBlob(firstCluster, 15, 18);
  assert(blob === null || Array.isArray(blob), 'getConcaveBlob returns a path array or null');
  if (Array.isArray(blob)) {
    assert(blob.length > 0, `getConcaveBlob returned concave boundary with ${blob.length} coordinates`);
  }
}

// Performance Benchmark: 1,000 synthetic peaks
console.log('\n── 3b. Clustering Performance Benchmark ──');
const syntheticPeaks = [];
for (let i = 0; i < 1000; i++) {
  syntheticPeaks.push({
    lat: 51.5 + (Math.random() - 0.5) * 0.05,
    lon: -0.07 + (Math.random() - 0.5) * 0.05
  });
}
const tStart = Date.now();
const testClusters = GSRSpatialClustering.clusterPeaks(syntheticPeaks, 50, 18, 15);
const tEnd = Date.now();
const duration = tEnd - tStart;
console.log(`  Clustered 1,000 peaks into ${testClusters.length} clusters in ${duration} ms`);
assert(duration < 25, `Clustered 1,000 peaks in under 25ms (actual: ${duration}ms)`);

// ════════════════════════════════════════════════════════════════════════════
//  4. MARCHING SQUARES CONTOURING ALGORITHMS
// ════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. Marching Squares Contouring ──');

// Construct a small 5x5 test density grid
const testGrid = [
  [0, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [0, 1, 2, 1, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 0]
];
const gridRows = 5;
const gridCols = 5;
const gridBounds = {
  getSouthWest: () => ({ lat: 51.50, lng: -0.10 }),
  getNorthEast: () => ({ lat: 51.51, lng: -0.09 })
};

// Run marching squares contour line tracing at isolevel=0.5
const contourLines = MarchingSquares.getContourLines(testGrid, gridRows, gridCols, gridBounds, 0.5);

assert(Array.isArray(contourLines), 'MarchingSquares.getContourLines returns an array of segments');
assert(contourLines.length > 0, `MarchingSquares traced ${contourLines.length} contour segment lines`);

if (contourLines.length > 0) {
  const firstSegment = contourLines[0];
  assert(Array.isArray(firstSegment) && firstSegment.length >= 2, 'Contour line segment is a valid coordinate array');
  assert(typeof firstSegment[0].lat === 'number' && typeof firstSegment[0].lon === 'number', 'Segment contains valid lat/lon nodes');
}

// ────────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`All Pipelines Verification: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}`);
if (failed > 0) process.exit(1);
