'use strict';

const assert = require('assert');
const test   = require('node:test');
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
const { GSRCSVParser } = require('../src/signal/csv_parser.js');

const FIX_CSV = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'default_processed.csv'), 'utf8');
const P = () => JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));

test('prefix-cache hit memoizes phasicAUC and arousalIndex references while recomputing triIndex', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);
  const baseParams = P();

  a.analyze(baseParams);
  const auc1 = a.phasicAUC;
  const ai1 = a.arousalIndex;
  const tri1 = a.triIndex;
  const peaks1 = a.peaks;

  // Peak slider change (prefix cache hit)
  a.analyze({ ...baseParams, peakThreshold: 0.20 });
  const auc2 = a.phasicAUC;
  const ai2 = a.arousalIndex;
  const tri2 = a.triIndex;
  const peaks2 = a.peaks;

  assert.strictEqual(auc1, auc2, 'phasicAUC array reference should be reused on prefix cache hit');
  assert.strictEqual(ai1, ai2, 'arousalIndex array reference should be reused on prefix cache hit');
  assert.notStrictEqual(peaks1, peaks2, 'peaks must recompute on peak threshold change');
  assert.notStrictEqual(tri1, tri2, 'triIndex must recompute because peak density changed');
});

test('prefix-cache miss (filter parameter change) recomputes all continuous metrics', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);
  const baseParams = P();

  a.analyze(baseParams);
  const auc1 = a.phasicAUC;
  const ai1 = a.arousalIndex;

  // Filter parameter change (prefix cache miss)
  a.analyze({ ...baseParams, lpfWindow: baseParams.lpfWindow + 1.0 });
  const auc2 = a.phasicAUC;
  const ai2 = a.arousalIndex;

  assert.notStrictEqual(auc1, auc2, 'phasicAUC should recompute when filter params change');
  assert.notStrictEqual(ai1, ai2, 'arousalIndex should recompute when filter params change');
});

test('deconvolution toggling recomputes against phasicClean and restores pristine on toggle-off', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);
  const baseParams = {
    ...P(),
    usePeakProminence: false,
    useDeconvolution: false,
  };

  // 1. Standard mode
  a.analyze(baseParams);
  const pristineAUC = a.phasicAUC;
  const pristineAI = a.arousalIndex;
  const pristineAUCVal0 = a.phasicAUC[0].val;

  // 2. Toggle deconvolution ON
  a.analyze({ ...baseParams, useDeconvolution: true });
  const deconvAUC = a.phasicAUC;
  const deconvAI = a.arousalIndex;
  assert.notStrictEqual(deconvAUC, pristineAUC, 'deconvolution must recompute phasicAUC from phasicClean');
  assert.notStrictEqual(deconvAI, pristineAI, 'deconvolution must recompute arousalIndex');

  // 3. Toggle deconvolution back OFF (prefix cache hit)
  a.analyze(baseParams);
  assert.strictEqual(a.phasicAUC, pristineAUC, 'switching back to non-deconv mode should restore pristine phasicAUC');
  assert.strictEqual(a.arousalIndex, pristineAI, 'switching back to non-deconv mode should restore pristine arousalIndex');
  assert.strictEqual(a.phasicAUC[0].val, pristineAUCVal0, 'pristine values must remain unaltered');
});

function scanRange(arr) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i].val;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return { min: mn, max: mx };
}

test('_wasDeconv clears on a non-deconvolution prefix-cache miss and the pristine range fast path is taken', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);
  const base = { ...P(), usePeakProminence: false, useDeconvolution: false };

  a.analyze(base);

  // Toggle deconvolution on (prefix-cache hit — same filter params).
  a.analyze({ ...base, useDeconvolution: true });
  assert.strictEqual(a._wasDeconv, true, 'deconvolution run sets _wasDeconv');

  // Filter-param change => prefix-cache MISS, deconvolution back off.
  a.analyze({ ...base, lpfWindow: base.lpfWindow + 1.0 });
  assert.strictEqual(a._wasDeconv, false, 'a non-deconv prefix-cache miss must clear stale deconvolution state');

  // The pristine phasicAUC/arousalIndex ranges must be exposed via the cached
  // fast path (identity), and they must match a manual scan of the arrays.
  assert.strictEqual(a._globalRange.phasicAUC, a._prefixCache.aucRange, 'non-deconv path reuses the cached AUC range object');
  assert.strictEqual(a._globalRange.arousalIndex, a._prefixCache.aiRange, 'non-deconv path reuses the cached arousalIndex range object');
  assert.deepStrictEqual(a._globalRange.phasicAUC, scanRange(a.phasicAUC), 'cached AUC range matches the array');
  assert.deepStrictEqual(a._globalRange.arousalIndex, scanRange(a.arousalIndex), 'cached arousalIndex range matches the array');
});

test('_wasDeconv does not leak across a fresh parseCSV / series-pool rebuild', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);
  a.analyze({ ...P(), useDeconvolution: true });
  assert.strictEqual(a._wasDeconv, true);

  a.parseCSV(FIX_CSV);                       // new raw array => pool rebuilt on next analyze
  a.analyze({ ...P(), useDeconvolution: false });

  assert.strictEqual(a._wasDeconv, false, 'series-pool rebuild clears stale deconvolution state');
  assert.deepStrictEqual(a._globalRange.phasicAUC, scanRange(a.phasicAUC));
  assert.deepStrictEqual(a._globalRange.arousalIndex, scanRange(a.arousalIndex));
});

test('deconvolution mode recomputes _globalRange from the deconvolved arrays, not the pristine cache', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);
  const base = { ...P(), usePeakProminence: false, useDeconvolution: false };

  a.analyze(base);
  const pristineAucRange = { ...a._globalRange.phasicAUC };

  a.analyze({ ...base, useDeconvolution: true });
  assert.strictEqual(a._wasDeconv, true);

  // Live range is derived from the deconvolved arrays…
  assert.deepStrictEqual(a._globalRange.phasicAUC, scanRange(a.phasicAUC));
  assert.deepStrictEqual(a._globalRange.arousalIndex, scanRange(a.arousalIndex));
  // …and is NOT the still-pristine cached range object.
  assert.notStrictEqual(a._globalRange.phasicAUC, a._prefixCache.aucRange,
    'deconv range must not alias the pristine prefix cache');
  assert.notDeepStrictEqual(a._globalRange.phasicAUC, pristineAucRange,
    'deconvolution changes the phasic signal, so its AUC range should move');
});

test('timeline overview raw range uses _rawGlobalRange and matches manual scan', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(FIX_CSV);
  a.analyze(P());

  assert.ok(a._rawGlobalRange, '_rawGlobalRange should exist on analyzer');
  let manualMin = Infinity, manualMax = -Infinity;
  for (let i = 0; i < a.raw.length; i++) {
    const val = a.raw[i].val;
    if (val < manualMin) manualMin = val;
    if (val > manualMax) manualMax = val;
  }
  assert.strictEqual(a._rawGlobalRange.min, manualMin);
  assert.strictEqual(a._rawGlobalRange.max, manualMax);
});

