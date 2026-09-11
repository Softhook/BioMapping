'use strict';

const assert = require('assert');
const test = require('node:test');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp('class ' + varName + '\\s*{'), 'global.' + varName + ' = class ' + varName + ' {')
    .replace(new RegExp('const ' + varName + '\\s*='), 'global.' + varName + ' =');
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'), 'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'), 'GsrFilter');
loadModule(path.join(__dirname, '../src/signal/deconvolution.js'), 'SCRDeconvolution');
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'), 'GSRCSVParser');
loadModule(path.join(__dirname, '../src/signal/analyzer.js'), 'GSRAnalyzer');

const { GSRAnalyzer, SCRDeconvolution } = global;
const SR = 10;

function buildSyntheticCSV(scrs, durationSec, tonicLevel = 2.0) {
  const n = Math.round(durationSec * SR);
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 10.0);
  const phasic = new Float64Array(n);
  const rows = ['time,gsr'];
  for (const scr of scrs) {
    const onset = Math.round(scr.onsetSec * SR);
    for (let k = 0; k < kernel.length && onset + k < n; k++) {
      phasic[onset + k] += scr.amplitude * kernel[k];
    }
  }
  for (let i = 0; i < n; i++) rows.push(`${(i / SR).toFixed(3)},${(tonicLevel + phasic[i]).toFixed(6)}`);
  return rows.join('\n');
}

test('GSRAnalyzer uses the reference SparsEDA path on a synthetic track', () => {
  const csvText = buildSyntheticCSV([
    { onsetSec: 15, amplitude: 0.22 },
    { onsetSec: 45, amplitude: 0.18 },
    { onsetSec: 75, amplitude: 0.20 }
  ], 110);

  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(csvText);
  analyzer.analyze({
    ...global.GSR_CONST.GSR_DEFAULT,
    tonicMethod: 'percentile',
    tonicWindow: 15,
    peakThreshold: 0.02,
    minPeakQuality: 0.0,
    shapeMinSnr: 0,
    useDeconvolution: true,
    deconvAlgorithm: 'sparseda'
  });

  assert.strictEqual(analyzer.phasicDriver.length, analyzer.raw.length);
  assert.strictEqual(analyzer.phasicClean.length, analyzer.raw.length);
  assert.strictEqual(typeof analyzer.phasicDeconvTruncated, 'boolean');
  assert.ok(analyzer.phasicDriver.some(d => d.val > 0), 'SparsEDA should produce sparse driver activity');
  assert.strictEqual(
    analyzer.phasicDriverPeaks.length,
    analyzer.phasicDriver.filter(d => d.val > 0).length,
    'SparsEDA analyzer should preserve the solver-kept driver events'
  );
  assert.ok(analyzer.peaks.length >= 3, `expected at least 3 detected peaks, got ${analyzer.peaks.length}`);
});
