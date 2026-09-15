/**
 * Regression coverage for renderer.js's plain-require() export surface.
 *
 * renderer_chrome.js, renderer_markers.js, renderer_bands.js and
 * renderer_interaction.js all converted to real ES modules (each now a
 * static `import { ... } from './renderer.mjs'`, composing itself onto
 * GSRRenderer as a top-level side effect) — the require-branch
 * global-stamping trick this file used to exercise (see git history for the
 * original bug this caught: a bare-identifier augment silently resolving to
 * `global.X = undefined` because renderer.js's module.exports didn't
 * actually contain the name) is structurally impossible to get wrong once
 * bare identifiers are real lexical import bindings, so that loop is gone;
 * what's left is the smoke test confirming renderer.mjs still exports every
 * name its (now former) augments needed.
 */
const assert = require('assert');
const test = require('node:test');

test('renderer.js exports every module-level name its augment files read bare', () => {
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
