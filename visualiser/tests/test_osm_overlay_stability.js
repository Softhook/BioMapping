/**
 * OSM overlay stability across render cycles.
 *
 * The overlay (2D vector shapes) is area-scoped, not path-scoped: a GSR/GPS
 * slider re-render must not disturb it. The fix is simply that clearMap() no
 * longer clears it — so renderData()'s clear+rebuild leaves it in place — and
 * GSRUI.syncOsmOverlay() only runs on real changes (track switch, enrichment,
 * surface switch, "no tracks" reset), never from the render loop.
 *
 * Run: node --test tests/test_osm_overlay_stability.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { bootApp } = require('./support/boot_app.js');

const way = (id, tags) => ({
  type: 'way', id, tags,
  coordinates: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }],
});

function setup() {
  const { window: w } = bootApp();
  w.setup();
  const mgr = w.AppState.mapManager;
  mgr.map = mgr.map || {};
  mgr.map.removeLayer = mgr.map.removeLayer || (() => {});
  mgr.map.hasLayer = mgr.map.hasLayer || (() => false);
  mgr.map.addLayer = mgr.map.addLayer || (() => {});
  w.L.polygon = () => ({ addTo() { return this; } });

  const drawSpy = [];
  const realDraw = mgr.drawOsmShapes.bind(mgr);
  mgr.drawOsmShapes = (g) => { drawSpy.push(g); return realDraw(g); };

  w.AppState.viewMode = 'single';
  w.AppState.surfaceView = 'map';
  return { w, mgr, drawSpy };
}

test('clearMap() no longer tears down the OSM overlay', () => {
  const { mgr } = setup();
  mgr.drawOsmShapes({ ways: [way('a', { building: 'yes' })], relations: [] });
  assert.ok(mgr.osmLayers.length > 0);

  mgr.clearMap();

  assert.ok(mgr.osmLayers.length > 0, 'OSM polygons survive a clearMap() (and so a full renderData() rebuild)');
});

test('syncOsmOverlay: a track switch redraws for the new geometry, clears for none', () => {
  const { w, mgr, drawSpy } = setup();
  const GSRUI = w.GSRUI;
  const geomsA = { ways: [way('a', { building: 'yes' })], relations: [] };
  const geomsB = { ways: [way('b', { building: 'yes' })], relations: [] };
  GSRUI._osmOverlayOn = true;

  w.AppState.analyzer = { raw: [{ lat: 51, lon: -0.1 }], osmGeoms: geomsA };
  GSRUI.syncOsmOverlay();
  assert.strictEqual(drawSpy.at(-1), geomsA);

  w.AppState.analyzer = { raw: [{ lat: 51, lon: -0.1 }], osmGeoms: geomsB };
  GSRUI.syncOsmOverlay();
  assert.strictEqual(drawSpy.at(-1), geomsB, 'redrawn for the new track');

  w.AppState.analyzer = { raw: [{ lat: 51, lon: -0.1 }] }; // no osmGeoms
  GSRUI.syncOsmOverlay();
  assert.strictEqual(mgr.osmLayers.length, 0, 'overlay cleared for a track with no geometry');
});

test('clearAllTracks resets the OSM toggle and clears the overlay', () => {
  const { w, mgr } = setup();
  const GSRUI = w.GSRUI;
  w.AppState.analyzer = { raw: [{ lat: 51, lon: -0.1 }], osmGeoms: { ways: [way('a', { building: 'yes' })], relations: [] } };
  GSRUI._osmOverlayOn = true;
  GSRUI.syncOsmOverlay();
  assert.ok(mgr.osmLayers.length > 0);

  w.AppState.collectiveManager = w.AppState.collectiveManager || { tracks: [] };
  w.GSRTrackManager.clearAllTracks();

  assert.strictEqual(GSRUI._osmOverlayOn, false, 'toggle reset');
  assert.strictEqual(mgr.osmLayers.length, 0, 'overlay cleared');
});
