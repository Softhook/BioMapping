/**
 * Unit tests for fractional and adaptive low-pass filters.
 *
 * Run: node visualiser/tests/test_fractional_filters.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const assert = require('assert');

// ── Bootstrap scope ─────────────────────────────────────────────────────────
global.window = global;
global.GSR_CONST = require('./mock_constants.js');
global.GSRAnalyzer = {
  calcEmFog: () => 0.0
};

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

loadModule(path.join(__dirname, '../src/signal/stats_math.js'),         'StatsMath');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'),         'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'),         'GSRCSVParser');

const { GsrFilter, GSRCSVParser } = global;

// ── Run Tests ───────────────────────────────────────────────────────────────

function runTests() {
  console.log('Running test: Fractional Zero-Phase Moving Average...');
  
  // Test 1: Fractional window sizes produce distinct results
  const data = [10.0, 12.0, 15.0, 12.0, 10.0, 8.0, 9.0, 12.0, 14.0, 11.0, 10.0];
  const out4 = GsrFilter.applyZeroPhaseMovingAverage(data, 4.0);
  const out5 = GsrFilter.applyZeroPhaseMovingAverage(data, 5.0);
  
  assert.strictEqual(out4.length, data.length);
  assert.strictEqual(out5.length, data.length);
  
  // Verify they are different (they used to both round to 5 samples and be identical)
  let differ = false;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(out4[i] - out5[i]) > 1e-5) {
      differ = true;
      break;
    }
  }
  assert.ok(differ, '0.4s (4.0 samples) and 0.5s (5.0 samples) should produce different filter outputs');
  console.log('  -> PASSED (outputs differ as expected)');

  // Test 2: Adaptive filter runs successfully
  console.log('Running test: Adaptive Zero-Phase Moving Average...');
  const windowSizes = [3.0, 3.2, 3.4, 3.6, 3.8, 4.0, 4.2, 4.4, 4.6, 4.8, 5.0];
  const outAdaptive = GsrFilter.applyAdaptiveZeroPhaseMovingAverage(data, windowSizes);
  assert.strictEqual(outAdaptive.length, data.length);
  outAdaptive.forEach(v => assert.ok(!isNaN(v) && v !== undefined));
  console.log('  -> PASSED');

  // Test 3: Rolling gait period estimation on Track 24 CSV
  console.log('Running test: Rolling Gait Estimator on Track 24...');
  const csvPath = path.join(__dirname, '../../tracks/biomap_024.csv');
  const csvText = fs.readFileSync(csvPath, 'utf8');
  
  const parseResult = GSRCSVParser.parse(csvText);
  assert.ok(parseResult.raw && parseResult.raw.length > 0);
  
  const gsrVals = parseResult.raw.map(r => r.val).filter(v => v > 0);
  assert.ok(gsrVals.length > 100);
  
  const sampleRate = parseResult.sampleRate || 10.0;
  // Estimate with default window size 5.0
  const estimates = GsrFilter.estimateGaitPeriods(gsrVals, sampleRate, 5.0);
  
  assert.strictEqual(estimates.length, gsrVals.length);
  
  // Calculate average estimate
  const avgEstimate = estimates.reduce((a, b) => a + b, 0) / estimates.length;
  console.log(`  -> Average estimated window size: ${avgEstimate.toFixed(3)} samples (${(sampleRate/avgEstimate).toFixed(2)} Hz)`);
  
  // The walking step rate peak is around 1.88 Hz (~5.32 samples).
  // The adaptive filter convolved with the stride period (2 * step period) which is ~10.64 samples.
  // Let's assert that the mean estimate is close to the stride range (9.0 to 11.5)
  assert.ok(avgEstimate >= 9.0 && avgEstimate <= 11.5, `Stride estimate ${avgEstimate} should be near 10.6 samples`);
  console.log('  -> PASSED');
  
  console.log('\nAll fractional filter tests passed successfully!');
}

try {
  runTests();
} catch (err) {
  console.error('Test Suite Failed:', err);
  process.exit(1);
}
