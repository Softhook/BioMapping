/**
 * Tests for the overlap-aware path recolour that follows a zoom
 * (src/map/manager/path.mjs):
 *   _schedulePathRefreshOnZoom — waits until zooming has stopped, once
 *   _refreshPathOnZoom         — hands its overlap pooling to the redraw
 *                                instead of computing it twice
 *
 * Runs the real vendored Leaflet inside jsdom (fixed-size container, SVG
 * renderer — jsdom has no canvas).
 *
 * Run: node --test tests/test_path_zoom_refresh.js
 */

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
const { window } = dom;
window.eval(
  fs.readFileSync(
    path.join(__dirname, '..', 'vendor', 'leaflet', 'leaflet.js'),
    'utf8',
  ),
);
global.L = window.L;
L.Browser.any3d = true; // see test_smooth_wheel_zoom.js
global.GeoUtils = require('../src/gps/geo_utils.mjs').GeoUtils;

const { GSRMapManager } = require('../src/map/map.mjs');
const { GSRMapBase } = require('../src/map/map_base.mjs');
const { AppState } = require('../src/core/app_state.mjs');
const {
  enableSmoothWheelZoom,
  SMOOTH_ZOOM_MAP_OPTIONS,
} = require('../src/map/smooth_wheel_zoom.mjs');

const LAT0 = 51.5;
const LON0 = -0.12;
const SC = global.GeoUtils.getGeodesicScale(LAT0);

// Out along a street and back ~2 minutes later with a different metric, a few
// metres to one side: a retrace whose pooling depends on the overlap radius
// (so on the zoom).
function thereAndBack() {
  const pt = (xM, yM, t, val) => ({
    lat: LAT0 + yM / SC.degToMeterLat,
    lon: LON0 + xM / SC.degToMeterLon,
    time: t,
    val, // the field the 'gsr' colouring reads
  });
  const dp = [];
  for (let i = 0; i <= 40; i++) dp.push(pt(i * 3, 0, i, 1 + (i % 7) / 3));
  for (let i = 40; i >= 0; i--)
    dp.push(pt(i * 3, 4, 200 + (40 - i), 6 - (i % 5)));
  return dp;
}

function makeManager() {
  const el = window.document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  window.document.body.appendChild(el);
  const map = L.map(el, {
    ...SMOOTH_ZOOM_MAP_OPTIONS,
    preferCanvas: false,
    fadeAnimation: false,
    zoomAnimation: false,
  }).setView([LAT0, LON0 + 60 / SC.degToMeterLon], 19);
  enableSmoothWheelZoom(map);

  const mm = Object.create(GSRMapManager.prototype);
  mm.map = map;
  mm.activeColoringMetric = 'gsr';
  mm.updateLegend = () => {};
  mm._registerTrackLayer = () => {};
  mm._lastDrawPoints = thereAndBack();
  // Stand-in for refreshPath(): clear the drawn path and render it again.
  mm.refreshPath = () => {
    for (const l of drawnPolylines(map)) map.removeLayer(l);
    mm._renderPathSegments(mm._lastDrawPoints, 5, AppState.analyzer, null);
  };
  AppState.analyzer = {};
  AppState.viewMode = 'single';
  return mm;
}

const drawnPolylines = (map) => {
  const out = [];
  map.eachLayer((l) => {
    if (l instanceof L.Polyline) out.push(l);
  });
  return out;
};
const picture = (map) =>
  drawnPolylines(map).map((l) => ({
    color: l.options.color,
    latlngs: l.getLatLngs().map((p) => [p.lat, p.lng]),
  }));

test('the zoom refresh pools the overlap once and draws the same path as a fresh render', () => {
  const mm = makeManager();
  mm.refreshPath(); // first render at zoom 19
  mm.map.setZoom(16.3, { animate: false });

  const pooled = GSRMapBase._overlapPooledAccessor;
  let calls = 0;
  GSRMapBase._overlapPooledAccessor = (...args) => {
    calls++;
    return pooled(...args);
  };
  try {
    const before = picture(mm.map);
    mm._refreshPathOnZoom();
    const refreshed = picture(mm.map);
    assert.notDeepStrictEqual(
      refreshed,
      before,
      'the zoom changed the colours',
    );
    assert.strictEqual(calls, 1, 'pooling computed once, not twice');

    mm.refreshPath(); // from scratch, no hand-off
    assert.deepStrictEqual(refreshed, picture(mm.map), 'identical result');
    assert.strictEqual(mm._zoomOverlapHandoff, null, 'hand-off cleared');
  } finally {
    GSRMapBase._overlapPooledAccessor = pooled;
  }
});

test('the zoom refresh waits for zooming to stop, and runs once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mm = makeManager();
  let runs = 0;
  mm._refreshPathOnZoom = () => runs++;

  // A burst of zooms: each end restarts the wait.
  mm._schedulePathRefreshOnZoom();
  t.mock.timers.tick(100);
  mm._schedulePathRefreshOnZoom();
  t.mock.timers.tick(100);
  mm._schedulePathRefreshOnZoom();
  t.mock.timers.tick(249);
  assert.strictEqual(runs, 0, 'still waiting');
  t.mock.timers.tick(1);
  assert.strictEqual(runs, 1, 'once, after the last zoom');

  // A new zoom starting cancels a pending run.
  mm._schedulePathRefreshOnZoom();
  mm._cancelPathRefreshOnZoom();
  t.mock.timers.tick(1000);
  assert.strictEqual(runs, 1, 'cancelled');

  // Fingers still on the map: keep waiting until they lift.
  const el = mm.map.getContainer();
  el.dispatchEvent(
    new window.PointerEvent('pointerdown', { pointerId: 7, bubbles: true }),
  );
  mm._schedulePathRefreshOnZoom();
  t.mock.timers.tick(1000);
  assert.strictEqual(runs, 1, 'held while a finger is down');
  el.dispatchEvent(
    new window.PointerEvent('pointerup', { pointerId: 7, bubbles: true }),
  );
  t.mock.timers.tick(250);
  assert.strictEqual(runs, 2, 'runs once the finger lifts');
});
