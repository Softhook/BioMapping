'use strict';

const test   = require('node:test');
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

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
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'),      'SCRDeconvolution');
loadModule(path.join(__dirname, '../src/signal/analyzer_time_format.js'), 'AnalyzerTimeFormat');

const { GSRAnalyzer } = require('../src/signal/analyzer.js');
const FIX_CSV = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'default_processed.csv'), 'utf8');
const D = () => JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));

test('decoupled filter pipeline: Gait Filter ON + lpfWindow 0 retains pure LR4 output', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);

  // Analyze with default Gait Filter ON, lpfWindow 0
  a.analyze({ ...D(), useGaitFilter: true, lpfWindow: 0 });
  const filteredGaitOnly = a.filtered.map(d => d.val);

  // Directly calculate expected LR4 over raw data
  const rawVals = a.raw.map(d => d.val);
  const expectedLR4 = GsrFilter.applyZeroPhaseLinkwitzRiley(rawVals, 1.0, a.sampleRate);

  assert.strictEqual(filteredGaitOnly.length, expectedLR4.length);
  // Values should match within 1e-10
  for (let i = 0; i < 50; i++) {
    assert.ok(Math.abs(filteredGaitOnly[i] - expectedLR4[i]) < 1e-9, `mismatch at ${i}: ${filteredGaitOnly[i]} vs ${expectedLR4[i]}`);
  }
});

test('decoupled filter pipeline: Gait Filter ON + lpfWindow > 0 cascades smoothing (no longer ignored)', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);

  a.analyze({ ...D(), useGaitFilter: true, lpfWindow: 0 });
  const filteredGaitOnly = a.filtered.map(d => d.val);

  // Now enable low-pass smoothing in cascade
  a.analyze({ ...D(), useGaitFilter: true, lpfWindow: 0.5 });
  const filteredCascaded = a.filtered.map(d => d.val);

  // In the old implementation, filteredCascaded would be byte-identical because lpfWindow was bypassed.
  // In the new decoupled implementation, filteredCascaded is actively smoothed!
  let diffCount = 0;
  for (let i = 0; i < filteredGaitOnly.length; i++) {
    if (Math.abs(filteredGaitOnly[i] - filteredCascaded[i]) > 1e-5) {
      diffCount++;
    }
  }
  assert.ok(diffCount > 0, `lpfWindow > 0 should actively smooth the signal in cascade with Gait Filter (found ${diffCount} differences)`);
});

test('decoupled filter pipeline: Gait Filter OFF + lpfWindow > 0 applies standalone Butterworth smoothing', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);

  a.analyze({ ...D(), useGaitFilter: false, lpfWindow: 0.33, lpfCutoff: 3.0 });
  const filteredBW = a.filtered.map(d => d.val);

  const rawVals = a.raw.map(d => d.val);
  const expectedBW = GsrFilter.applyZeroPhaseButterworth(rawVals, 3.0, 4, a.sampleRate);

  for (let i = 0; i < 50; i++) {
    assert.ok(Math.abs(filteredBW[i] - expectedBW[i]) < 1e-9, `mismatch at ${i}`);
  }
});

test('decoupled filter pipeline: Gait Filter ON and Butterworth can be active at the same time', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);

  a.analyze({ ...D(), useGaitFilter: true, lpfWindow: 0.33, lpfCutoff: 3.0 });
  const filteredCascaded = a.filtered.map(d => d.val);

  const rawVals = a.raw.map(d => d.val);
  const expectedSmooth = GsrFilter.applyZeroPhaseButterworth(rawVals, 3.0, 4, a.sampleRate);
  const expectedCascaded = GsrFilter.applyZeroPhaseLinkwitzRiley(expectedSmooth, 1.0, a.sampleRate);

  for (let i = 0; i < 50; i++) {
    assert.ok(Math.abs(filteredCascaded[i] - expectedCascaded[i]) < 1e-9, `mismatch at ${i}`);
  }
});

test('decoupled filter pipeline: Hampel artifact removal cleans spike before low-pass stage', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);

  // Inject a large spike into raw data
  a.raw[20].val = 50.0;

  // With artifact removal active (Hampel):
  a.analyze({ ...D(), medianSize: 0.5, useGaitFilter: false, lpfWindow: 0 });
  const filtered = a.filtered.map(d => d.val);

  // Spike should be eliminated and close to neighbors
  assert.ok(filtered[20] < 10.0, `Spike of 50.0 was cleaned down to ${filtered[20]}`);
});
