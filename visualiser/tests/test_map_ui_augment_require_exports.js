/**
 * Regression coverage for map.js/ui.js's plain-require() export surface.
 *
 * All 12 map_manager_*.js and 10 ui_*.js augments converted to real ES
 * modules in the ES-module migration — each is a plain
 * `import ... from './map.mjs'` (or `./ui.mjs`) plus `export const
 * __methods = {...}` with a real `Object.assign(GSRMapManager.prototype,
 * __methods)` / `Object.assign(GSRUI, __methods)` side effect, so requiring
 * one directly now attaches to the one real GSRMapManager/GSRUI with no
 * test-side stamping needed. This file's former MAP_PROTO_AUGMENTS/
 * UI_AUGMENTS require-branch loops (which existed only to work around the
 * pre-conversion dual-mode tail, and to catch the bare-self-reference bug
 * class renderer.js hit once — see
 * docs/visualizer_modularity_plan.md's "Require/boot-up gotcha" section) are
 * gone; what's left is just the two smoke tests below confirming map.mjs/
 * ui.mjs still export their class/object.
 */
const assert = require('node:assert');
const test = require('node:test');

test('map.js exports GSRMapManager', async () => {
  const { GSRMapManager } = require('../src/map/map.mjs');
  assert.strictEqual(typeof GSRMapManager, 'function');
});

test('ui.js exports GSRUI', async () => {
  const { GSRUI } = require('../src/ui/ui.mjs');
  assert.strictEqual(typeof GSRUI, 'object');
});
