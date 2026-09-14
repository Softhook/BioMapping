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

loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'), 'GsrFilter');
const { GsrFilter } = global;

test('applyHampelFilter: edge cases (empty array, null, window <= 1)', () => {
  assert.deepStrictEqual(GsrFilter.applyHampelFilter([], 5), []);
  const arr = [1.0, 2.0, 3.0];
  assert.deepStrictEqual(GsrFilter.applyHampelFilter(arr, 1), [1.0, 2.0, 3.0]);
  assert.deepStrictEqual(GsrFilter.applyHampelFilter(arr, 0), [1.0, 2.0, 3.0]);
  assert.deepStrictEqual(GsrFilter.applyHampelFilter(arr, NaN), [1.0, 2.0, 3.0]);
});

test('applyHampelFilter: eliminates isolated spike outliers on flat baseline', () => {
  // 15 points flat at 5.0, with an extreme positive spike at index 7 and negative at index 11
  const raw = [5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 15.0, 5.0, 5.0, 5.0, -5.0, 5.0, 5.0, 5.0];
  const cleaned = GsrFilter.applyHampelFilter(raw, 5);

  assert.strictEqual(cleaned.length, raw.length);
  assert.strictEqual(cleaned[7], 5.0, 'positive spike replaced with local median');
  assert.strictEqual(cleaned[11], 5.0, 'negative spike replaced with local median');
  assert.strictEqual(cleaned[0], 5.0);
  assert.strictEqual(cleaned[6], 5.0);
  assert.strictEqual(cleaned[8], 5.0);
});

test('applyHampelFilter: preserves true SCR peak apex without blunting (unlike median)', () => {
  // Simulate a realistic SCR: baseline 5.0, rises smoothly to 7.0 at apex (index 5), falls back
  const scr = [5.0, 5.2, 5.6, 6.2, 6.8, 7.0, 6.7, 6.3, 5.8, 5.4, 5.1];

  // Standard median blunts the apex
  const medianFiltered = GsrFilter.applyMedianFilter(scr, 5);
  const medianMax = Math.max(...medianFiltered);
  assert.ok(medianMax < 7.0, `Median filter blunted peak apex from 7.0 down to ${medianMax}`);

  // Hampel filter preserves the peak apex exactly because all points follow physiological rise
  const hampelFiltered = GsrFilter.applyHampelFilter(scr, 5);
  const hampelMax = Math.max(...hampelFiltered);
  assert.strictEqual(hampelMax, 7.0, 'Hampel filter preserved true SCR peak apex at 7.0');
  assert.deepStrictEqual(hampelFiltered, scr, 'All points on smooth SCR curve remain untouched by Hampel');
});

test('applyHampelFilter: removes spike sitting on an SCR peak while keeping peak', () => {
  // SCR curve with a 1-sample noise glitch on top of the crest (index 5 jumps from 7.0 to 14.0)
  const scrWithGlitch = [5.0, 5.2, 5.6, 6.2, 6.8, 14.0, 6.7, 6.3, 5.8, 5.4, 5.1];
  const cleaned = GsrFilter.applyHampelFilter(scrWithGlitch, 5);

  assert.ok(cleaned[5] < 10.0, `Glitch of 14.0 replaced with local median (${cleaned[5]})`);
  assert.ok(cleaned[5] >= 6.7, `Local median preserves peak height (~6.8)`);
});
