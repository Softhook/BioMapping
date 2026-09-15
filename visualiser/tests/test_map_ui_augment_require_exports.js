'use strict';

/**
 * Regression coverage for ui.js's plain-require() export surface.
 *
 * All 12 map_manager_*.js augments converted to real ES modules in the
 * ES-module migration — each is a plain `import ... from './map.mjs'` plus
 * `export const __methods = {...}` with a real `Object.assign(GSRMapManager
 * .prototype, __methods)` side effect, so requiring one directly now
 * attaches to the one real GSRMapManager with no test-side stamping needed;
 * this file's former MAP_PROTO_AUGMENTS loop (which existed only to work
 * around the pre-conversion dual-mode tail) is gone.
 *
 * ui.js hasn't converted yet (layer 7). Its 10 ui_*.js augments still carry
 * a dual-mode tail with a bare, unconditional `Object.assign(GSRUI, {...})`
 * — meant only for `bootApp()`'s shared vm context, where the assignment
 * always runs against the one shared GSRUI. That's why they can't be plain-
 * require()'d without the test stamping `global.GSRUI` itself first (see the
 * UI_AUGMENTS loop below) — unlike globe3d_*.js/renderer_*.js, which got the
 * require-branch treatment when test_globe3d.js needed it (see
 * docs/visualizer_modularity_plan.md's "Require/boot-up gotcha" section).
 * Several of them (ui_correlation_table.js, ui_enrichment.js, ui_export.js,
 * ui_modals.js, ui_osm_overlay.js,
 * ui_environmental_dashboard.js) reference GSRUI bare (not `this.`) from
 * within their own method bodies — exactly the self-reference shape that
 * produced a silent `global.X = undefined` in renderer.js until
 * test_renderer_require_exports.js caught it. This test exercises every
 * augment's require-branch directly so the same bug class fails loudly here
 * instead of waiting for some future plain-require() test to trip over a
 * ReferenceError.
 */
const assert = require('assert');
const test   = require('node:test');

const UI_AUGMENTS = [
  'ui_collective_map.js', 'ui_correlation_table.js', 'ui_enrichment.js',
  'ui_environmental_dashboard.js', 'ui_export.js', 'ui_modals.js', 'ui_osm_overlay.js',
  'ui_road_profile.js',
];

test('map.js exports GSRMapManager', async () => {
  const { GSRMapManager } = require('../src/map/map.mjs');
  assert.strictEqual(typeof GSRMapManager, 'function');
});

test('ui.js exports GSRUI', async () => {
  const { GSRUI } = require('../src/ui/ui.mjs');
  assert.strictEqual(typeof GSRUI, 'object');
});

for (const augment of UI_AUGMENTS) {
  test(`${augment}'s require-branch resolves GSRUI onto global and merges onto it`, async () => {
    // ui.js converted to a real ES module (ui.mjs) — same "can't be cache-
    // busted, has no module-level mutable state, so require it once and
    // stamp global.GSRUI itself" fix as map.mjs above.
    delete require.cache[require.resolve(`../src/ui/${augment}`)];
    delete global.GSRUI;

    const { GSRUI } = require('../src/ui/ui.mjs');
    global.GSRUI = GSRUI;
    const methods = require(`../src/ui/${augment}`);
    Object.assign(GSRUI, methods);

    assert.strictEqual(global.GSRUI, GSRUI);
    const names = Object.keys(methods);
    assert.ok(names.length > 0, `${augment} exports at least one member`);
    // Mostly methods, but a couple of augments (e.g. ui_osm_overlay.js's
    // _osmOverlayOn) also carry a plain state-default property — just assert
    // the key landed on GSRUI with the same value the source defines.
    for (const name of names) {
      assert.strictEqual(GSRUI[name], methods[name], `${augment}.${name} attached`);
    }
  });
}
