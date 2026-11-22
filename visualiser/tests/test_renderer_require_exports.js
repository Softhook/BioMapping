/**
 * renderer.mjs loads with a plain require() and exports the shared constants
 * and helpers the renderer_*.mjs files use.
 */
const assert = require('node:assert');
const test = require('node:test');

test('renderer.mjs exports the shared renderer constants and helpers', () => {
  const mod = require('../src/render/renderer.mjs');
  assert.strictEqual(typeof mod.GSRRenderer, 'object');
  assert.strictEqual(typeof mod.getQualityColor, 'function');
  assert.strictEqual(typeof mod.getQualityLabel, 'function');
  assert.strictEqual(typeof mod.EXCLUDED_STYLE, 'object');
  assert.strictEqual(typeof mod.NORMAL_DASH, 'object');
  assert.strictEqual(typeof mod.EXCLUDE_BTN, 'object');
  // Sanity on behaviour, not just presence.
  assert.strictEqual(mod.getQualityColor(0.9), '#008f3c');
  assert.deepStrictEqual(mod.getQualityLabel(0.9), { pct: 90, label: 'High' });
});
