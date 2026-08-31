/**
 * Boots the real index.html app (jsdom, Cesium absent) and checks the 2D↔3D
 * surface switcher: it swaps the map panel for the globe panel and shows the
 * matching sidebar card, without throwing when the Cesium CDN can't load.
 *
 * See tests/support/boot_app.js for the harness; src/map/globe3d_view.js and
 * src/ui/events.js (bindSurfaceSwitcher) for the code under test.
 */

const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

const vis = (window, id) => {
  const el = window.document.getElementById(id);
  return el && el.style.display !== 'none';
};

test('surface switcher swaps map/globe panels and their sidebar cards', () => {
  const { window } = bootApp();
  window.setup();

  const btnGlobe = window.document.getElementById('btnGlobeSurface');
  const btnMap = window.document.getElementById('btnMapSurface');
  assert.ok(btnGlobe && btnMap, 'both surface buttons exist');

  // starts on the 2D map
  assert.strictEqual(window.AppState.surfaceView, 'map');
  assert.ok(vis(window, 'mapPanel'));
  assert.ok(!vis(window, 'globe3dPanel'));

  // → 3D globe
  assert.doesNotThrow(() => btnGlobe.click());
  assert.strictEqual(window.AppState.surfaceView, 'globe');
  assert.ok(!vis(window, 'mapPanel'), 'map panel hidden in 3D');
  assert.ok(vis(window, 'globe3dPanel'), 'globe panel shown in 3D');
  assert.ok(vis(window, 'globe3dSettingsCard'), '3D settings card shown');
  assert.ok(!vis(window, 'mapDisplayCard'), 'map display card hidden in 3D');
  assert.ok(btnGlobe.classList.contains('active'));

  // panel-header mirrors the map: metric picker + fullscreen + zoom + peaks
  for (const id of ['globe3dColoringMetric', 'btnGlobe3dFullscreen', 'btnGlobe3dZoomIn',
                    'btnGlobe3dZoomOut', 'btnGlobe3dZoomExtent', 'btnGlobe3dPeaks']) {
    assert.ok(window.document.getElementById(id), `missing panel-header control #${id}`);
  }

  // → back to 2D
  assert.doesNotThrow(() => btnMap.click());
  assert.strictEqual(window.AppState.surfaceView, 'map');
  assert.ok(vis(window, 'mapPanel'));
  assert.ok(!vis(window, 'globe3dPanel'));
  assert.ok(vis(window, 'mapDisplayCard'));
  assert.ok(!vis(window, 'globe3dSettingsCard'));
});

test('globe panel metric picker proxies #mapColoringMetric', () => {
  const { window } = bootApp();
  window.setup();
  window.document.getElementById('btnGlobeSurface').click();

  const g = window.document.getElementById('globe3dColoringMetric');
  const mapSel = window.document.getElementById('mapColoringMetric');
  let mapChanges = 0;
  mapSel.addEventListener('change', () => { mapChanges++; });

  g.value = 'tonic';
  assert.doesNotThrow(() => g.dispatchEvent(new window.Event('change')));
  assert.strictEqual(mapSel.value, 'tonic', 'forwarded to the 2D map select');
  assert.ok(mapChanges >= 1, 'the map select handler ran');
});

test('_editPeakLabel mounts the map peak popup in the globe container and closes it', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;

  // one analysed peak + a stub _buildPeakPopup that returns a real node
  window.AppState.analyzer = {
    peaks: [{ time: 42, label: '', index: 3 }],
    getCoordinates: () => ({ lat: 51.5, lon: -0.1 }),
  };
  let built = null;
  window.AppState.mapManager._buildPeakPopup = (opts) => {
    built = opts;
    const el = window.document.createElement('div');
    el.className = 'map-popup-card';
    el.appendChild(window.document.createElement('textarea'));
    return el;
  };

  window.document.getElementById('btnGlobeSurface').click(); // 3D active, els.container cached

  assert.doesNotThrow(() => V._editPeakLabel(0, { x: 30, y: 20 }));
  assert.strictEqual(built.index, 0, '_buildPeakPopup got the analyzer.peaks index');
  const pop = window.document.getElementById('globe3dPeakPopup');
  assert.ok(pop && pop.querySelector('.map-popup-card'), 'popup mounted with the map card');
  assert.ok(pop.querySelector('.globe3d-peak-popup-close'), 'has a close button');

  V._closePeakPopup();
  assert.strictEqual(window.document.getElementById('globe3dPeakPopup'), null, 'closed');
});

test('_pushFromMap fits the globe to the track only when the active track changed', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;

  window.AppState.analyzer = { raw: [{}, {}] };
  window.AppState.viewMode = 'collective';
  window.AppState.activeTrackId = 'track-a';
  window.AppState.mapManager._legendMinVal = 0;
  window.AppState.mapManager._legendMaxVal = 1;

  const flew = [];
  V.manager = { renderData: (_a, _p, o) => flew.push(!o.isPreview) };
  V._lastTrackId = null;

  V._pushFromMap();                 // first sight of track-a → fit
  V._pushFromMap();                 // same track, e.g. a slider drag → no fit
  window.AppState.activeTrackId = 'track-b';
  V._pushFromMap();                 // picked another track in the list → fit
  V._pushFromMap({ fly: true });    // explicit request (surface opened) → fit

  assert.deepStrictEqual(flew, [true, false, true, true]);
  V.manager = null;
});

test('GSRGlobe3DView.init is idempotent and exposes the read-only push API', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  assert.ok(V);
  assert.doesNotThrow(() => V.init());          // second call is a no-op
  assert.strictEqual(typeof V.activate, 'function');
  assert.strictEqual(typeof V.deactivate, 'function');
  assert.strictEqual(typeof V._editPeakLabel, 'function');
  // no manager until the 3D surface is actually opened + Cesium loads
  assert.strictEqual(V.manager, null);
});
