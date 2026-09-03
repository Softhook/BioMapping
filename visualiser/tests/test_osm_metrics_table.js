/**
 * Unit tests for GSR_CONST.OSM_METRICS (constants.js) — the single source of
 * truth for the 8 OSM enrichment fields' key<->field<->label mapping, used
 * by map.js's legend/_getMetricKey and ui.js's correlation dashboard/
 * regression-scatter axis labels (previously 4 separately hardcoded lists).
 *
 * Run: node --test tests/test_osm_metrics_table.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// constants.js declares `const GSR_CONST = {...}` with no module.exports (it's
// a plain <script>-tag global in the browser) — every other test loads
// mock_constants.js instead and never the real file directly. Load it via
// vm.runInThisContext (same pattern as every other test's `loadModule`
// helper) into a distinctly-named global rather than `global.GSR_CONST`
// itself, so it can't clash with whatever other test files in the same
// `node --test` run already assigned that name to (their own mock).
// Deliberately NOT vm.createContext — that creates a genuinely separate
// realm with its own Array/Object prototypes, which makes every
// assert.deepStrictEqual below fail on prototype identity even when every
// property matches.
const constantsSrc = fs.readFileSync(path.join(__dirname, '../src/core/constants.js'), 'utf8');
vm.runInThisContext(
  constantsSrc.replace('const GSR_CONST', 'global.__REAL_GSR_CONST__'),
  { filename: 'constants.js' }
);
const GSR_CONST = global.__REAL_GSR_CONST__;

const MOCK_GSR_CONST = require('./mock_constants.js');

test('OSM_METRICS has exactly 8 entries, matching the 8 osm_* fields written by osm_enrichment.js', () => {
  assert.strictEqual(GSR_CONST.OSM_METRICS.length, 8);
});

test('OSM_METRICS kinds: roadClass is categorical, inPark is binary, the other 6 are continuous', () => {
  const categorical = GSR_CONST.OSM_METRICS.filter(m => m.kind === 'categorical');
  const binary = GSR_CONST.OSM_METRICS.filter(m => m.kind === 'binary');
  const continuous = GSR_CONST.OSM_METRICS.filter(m => m.kind === 'continuous');
  assert.deepStrictEqual(categorical.map(m => m.key), ['roadClass'], 'only roadClass is multi-level categorical (excluded from the correlation UI)');
  assert.deepStrictEqual(binary.map(m => m.key), ['inPark'], 'inPark is a 0/1 field — point-biserial-correlatable, so it IS in the correlation/scatter UI');
  assert.strictEqual(continuous.length, 6, 'the other 6 fields are continuous');
  // ui.js's correlation/scatter feature lists filter on continuous || binary.
  assert.strictEqual(continuous.length + binary.length, 7);
});

test('every entry has a non-empty key, field, label, and a valid kind', () => {
  for (const m of GSR_CONST.OSM_METRICS) {
    assert.ok(m.key && typeof m.key === 'string', `entry missing a string key: ${JSON.stringify(m)}`);
    assert.ok(m.field && typeof m.field === 'string', `entry ${m.key} missing a string field`);
    assert.ok(m.field.startsWith('osm_'), `entry ${m.key}'s field "${m.field}" should start with osm_`);
    assert.ok(m.label && typeof m.label === 'string', `entry ${m.key} missing a string label`);
    assert.ok(['categorical', 'binary', 'continuous'].includes(m.kind), `entry ${m.key} has an unrecognised kind: ${m.kind}`);
  }
});

test('only distMajorRoad and distWater carry a unit (both "m") — the two fields ui.js\'s scatter axis labels append "(m)" to', () => {
  const withUnit = GSR_CONST.OSM_METRICS.filter(m => m.unit);
  assert.deepStrictEqual(withUnit.map(m => m.key).sort(), ['distMajorRoad', 'distWater']);
  for (const m of withUnit) assert.strictEqual(m.unit, 'm');
});

test('keys are unique', () => {
  const keys = GSR_CONST.OSM_METRICS.map(m => m.key);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('fields are unique', () => {
  const fields = GSR_CONST.OSM_METRICS.map(m => m.field);
  assert.strictEqual(new Set(fields).size, fields.length);
});

// tests/mock_constants.js hand-mirrors constants.js for the Node test
// environment (constants.js isn't require()-able as-is everywhere it's
// used — see mock_constants.js's own header). Nothing enforces the two
// stay in sync, so a change to one without the other is exactly the kind
// of silent-desync bug this table was extracted to prevent — guard it here.
test('mock_constants.js\'s OSM_METRICS stays in sync with the real constants.js', () => {
  assert.deepStrictEqual(MOCK_GSR_CONST.OSM_METRICS, GSR_CONST.OSM_METRICS);
});
