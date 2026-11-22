/**
 * map.mjs and ui.mjs load with a plain require() (as every test loads them)
 * and export their class / object.
 */
const assert = require('node:assert');
const test = require('node:test');

test('map.mjs exports GSRMapManager', async () => {
  const { GSRMapManager } = require('../src/map/map.mjs');
  assert.strictEqual(typeof GSRMapManager, 'function');
});

test('ui.mjs exports GSRUI', async () => {
  const { GSRUI } = require('../src/ui/ui.mjs');
  assert.strictEqual(typeof GSRUI, 'object');
});
