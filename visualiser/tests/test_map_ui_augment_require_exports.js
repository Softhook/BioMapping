'use strict';

/**
 * Regression coverage for map.js/ui.js's plain-require() export surface.
 *
 * map_manager_*.js (12 files) and ui_*.js (10 files) were, until this split,
 * the only two topic-file augment families with NO dual-mode tail at all —
 * bare `Object.assign(GSRMapManager.prototype, {...})` / `Object.assign(GSRUI,
 * {...})`, unconditionally. That worked because every existing test reaches
 * them only via await bootApp()'s shared vm context, where the assignment always
 * runs against the one shared GSRMapManager/GSRUI. It meant neither family
 * could be plain-require()'d in isolation (a bare assign has nothing to
 * attach to under Node's per-module scope) — unlike globe3d_*.js/
 * renderer_*.js, which got the require-branch treatment when test_globe3d.js
 * needed it (see docs/visualizer_modularity_plan.md's "Require/boot-up
 * gotcha" section). Both families now carry the same dual-mode tail, and
 * several of them (map_manager_peaks.js, map_manager_path.js,
 * ui_correlation_table.js, ui_enrichment.js, ui_export.js, ui_modals.js,
 * ui_osm_overlay.js, ui_peaks_table.js, ui_stats_panel.js,
 * ui_environmental_dashboard.js) reference GSRMapManager/GSRUI bare (not
 * `this.`) from within their own method bodies — exactly the self-reference
 * shape that produced a silent `global.X = undefined` in renderer.js until
 * test_renderer_require_exports.js caught it. These tests exercise every
 * augment's require-branch directly so the same bug class fails loudly here
 * instead of waiting for some future plain-require() test to trip over a
 * ReferenceError.
 */
const assert = require('assert');
const test   = require('node:test');

const MAP_PROTO_AUGMENTS = [
  'map_manager_arousal_places.js', 'map_manager_collective.js', 'map_manager_layers.js',
  'map_manager_legend.js', 'map_manager_osm.js', 'map_manager_path.js', 'map_manager_process.js',
  'map_manager_render.js', 'map_manager_rf_fluid.js', 'map_manager_toggles.js', 'map_manager_viewport.js',
];

const UI_AUGMENTS = [
  'ui_collective_map.js', 'ui_correlation_table.js', 'ui_enrichment.js',
  'ui_environmental_dashboard.js', 'ui_export.js', 'ui_modals.js', 'ui_osm_overlay.js',
  'ui_peaks_table.js', 'ui_road_profile.js', 'ui_stats_panel.js',
];

test('map.js exports GSRMapManager', async () => {
  const { GSRMapManager } = require('../src/map/map.js');
  assert.strictEqual(typeof GSRMapManager, 'function');
});

test('ui.js exports GSRUI', async () => {
  const { GSRUI } = require('../src/ui/ui.js');
  assert.strictEqual(typeof GSRUI, 'object');
});

for (const augment of MAP_PROTO_AUGMENTS) {
  test(`${augment}'s require-branch resolves GSRMapManager onto global and merges onto the prototype`, async () => {
    // Fresh require each time so an augment loaded earlier in this process
    // can't leave a stale global.GSRMapManager behind that masks a broken stamp.
    delete require.cache[require.resolve('../src/map/map.js')];
    delete require.cache[require.resolve(`../src/map/${augment}`)];
    delete global.GSRMapManager;

    const { GSRMapManager } = require('../src/map/map.js');
    const methods = require(`../src/map/${augment}`);
    Object.assign(GSRMapManager.prototype, methods);

    assert.strictEqual(global.GSRMapManager, GSRMapManager);
    const names = Object.keys(methods);
    assert.ok(names.length > 0, `${augment} exports at least one method`);
    for (const name of names) {
      assert.strictEqual(typeof GSRMapManager.prototype[name], 'function', `${augment}.${name} attached`);
    }
  });
}

test("map_manager_peaks.js's require-branch resolves prototype AND static methods", async () => {
  delete require.cache[require.resolve('../src/map/map.js')];
  delete require.cache[require.resolve('../src/map/map_manager_peaks.js')];
  delete global.GSRMapManager;

  const { GSRMapManager } = require('../src/map/map.js');
  const { protoMethods, staticMethods } = require('../src/map/map_manager_peaks.js');
  Object.assign(GSRMapManager.prototype, protoMethods);
  Object.assign(GSRMapManager, staticMethods);

  assert.strictEqual(global.GSRMapManager, GSRMapManager);
  assert.ok(Object.keys(protoMethods).length > 0);
  assert.ok(Object.keys(staticMethods).length > 0);
  // _buildPeakIcon/_buildHotspotIcon are the two statics; _renderPeakMarkers
  // and _renderHotspotMarkers (prototype methods) call them as bare
  // `GSRMapManager._buildPeakIcon()` / `GSRMapManager._buildHotspotIcon()`.
  assert.strictEqual(typeof GSRMapManager._buildPeakIcon, 'function');
  assert.strictEqual(typeof GSRMapManager._buildHotspotIcon, 'function');
  assert.strictEqual(typeof GSRMapManager.prototype._renderPeakMarkers, 'function');
  assert.strictEqual(typeof GSRMapManager.prototype._renderHotspotMarkers, 'function');
});

for (const augment of UI_AUGMENTS) {
  test(`${augment}'s require-branch resolves GSRUI onto global and merges onto it`, async () => {
    delete require.cache[require.resolve('../src/ui/ui.js')];
    delete require.cache[require.resolve(`../src/ui/${augment}`)];
    delete global.GSRUI;

    const { GSRUI } = require('../src/ui/ui.js');
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
