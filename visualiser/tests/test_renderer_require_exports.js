'use strict';

/**
 * Regression coverage for renderer.js's plain-require() export surface.
 *
 * renderer_chrome.js, renderer_markers.js, and renderer_interaction.js each
 * reference module-level names (getQualityColor/getQualityLabel/
 * EXCLUDED_STYLE/NORMAL_DASH/EXCLUDE_BTN) as bare identifiers, resolvable
 * under the browser/vm path because they share renderer.js's lexical scope.
 * Under plain CommonJS require() (no test file requires these three augments
 * directly today, which is exactly how this went unnoticed) each augment's
 * require-branch stamps renderer.js's require()'d exports onto `global` to
 * fake that same resolution. That only works if renderer.js's module.exports
 * actually contains the name — it didn't for any of these five (only
 * GSRRenderer was exported), so every augment's stamp silently produced
 * `global.X = undefined` with no error until the method was actually called.
 * These tests exercise exactly the require-branch each augment takes,
 * independent of any drawing call, so a future re-narrowing of renderer.js's
 * exports (or a new augment file with the same bare-identifier shape) fails
 * loudly here instead of waiting for the next plain-require() test to trip
 * over a ReferenceError.
 */
const assert = require('assert');
const test   = require('node:test');

test('renderer.js exports every module-level name its augment files read bare', () => {
  const mod = require('../src/render/renderer.js');
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

for (const augment of ['renderer_bands.js', 'renderer_chrome.js', 'renderer_markers.js', 'renderer_interaction.js']) {
  test(`${augment}'s require-branch resolves every bare identifier it needs onto global`, () => {
    // Fresh require each time so an augment file loaded earlier in this
    // process can't leave a stale `global.X` behind that masks a broken stamp.
    delete require.cache[require.resolve('../src/render/renderer.js')];
    delete require.cache[require.resolve(`../src/render/${augment}`)];
    for (const name of ['GSRRenderer', 'getQualityColor', 'getQualityLabel', 'EXCLUDED_STYLE', 'NORMAL_DASH', 'EXCLUDE_BTN']) {
      delete global[name];
    }

    const { GSRRenderer } = require('../src/render/renderer.js');
    const methods = require(`../src/render/${augment}`);
    Object.assign(GSRRenderer, methods);

    // Every name renderer.js exports must now be resolvable as a bare
    // identifier in this augment's module scope — the same guarantee the
    // vm/browser path gives for free via shared lexical scope.
    assert.strictEqual(global.GSRRenderer, GSRRenderer);
    assert.strictEqual(typeof global.getQualityColor, 'function');
    assert.strictEqual(typeof global.getQualityLabel, 'function');
    assert.strictEqual(typeof global.EXCLUDED_STYLE, 'object');
    assert.strictEqual(typeof global.NORMAL_DASH, 'object');
    assert.strictEqual(typeof global.EXCLUDE_BTN, 'object');
  });
}
