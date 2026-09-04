/**
 * Unit tests for the fractional-window zero-phase low-pass filter.
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

const { GsrFilter } = global;

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

  console.log('\nAll fractional filter tests passed successfully!');
}

try {
  runTests();
} catch (err) {
  console.error('Test Suite Failed:', err);
  process.exit(1);
}
