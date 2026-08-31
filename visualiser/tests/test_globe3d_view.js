/**
 * Boots the real index.html app (jsdom, Cesium absent) and checks the 2D↔3D
 * surface switcher: it swaps the map panel for the globe panel and shows the
 * matching sidebar card, without throwing when Cesium can't load.
 *
 * See tests/support/boot_app.js for the harness; src/map/globe3d_view.js and
 * src/ui/events.js (bindSurfaceSwitcher) for the code under test.
 */

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { bootApp } = require('./support/boot_app.js');

const APP_DIR = path.join(__dirname, '..');

// ── Vendored CesiumJS (no runtime CDN — BioMapping runs offline) ────────────

test('CesiumJS is vendored locally and globe3d_view loads it from disk, not a CDN', () => {
  for (const rel of ['vendor/cesium/Cesium.js', 'vendor/cesium/Widgets/widgets.css']) {
    assert.ok(fs.existsSync(path.join(APP_DIR, rel)), `missing vendored file: ${rel}`);
  }
  const viewSrc = fs.readFileSync(path.join(APP_DIR, 'src/map/globe3d_view.js'), 'utf8');
  const baseMatch = viewSrc.match(/const CESIUM_BASE\s*=\s*'([^']+)'/);
  assert.ok(baseMatch, 'CESIUM_BASE constant not found');
  assert.ok(!/^https?:/.test(baseMatch[1]), `CESIUM_BASE must be a local path, got ${baseMatch[1]}`);
  assert.ok(!/cdn\.jsdelivr|cesium\.com|unpkg/.test(viewSrc), 'globe3d_view still references a Cesium CDN');
});

const vis = (window, id) => {
  const el = window.document.getElementById(id);
  return el && el.style.display !== 'none';
};

// ── 3D track export moved to the main Export Options panel ─────────────────

test('CZML/KML export live in the main Export Options card; the 3D Snapshot is gone', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;

  const card = doc.getElementById('exportCard');
  assert.ok(card.querySelector('#exportCzmlBtn'), 'CZML button in the main export card');
  assert.ok(card.querySelector('#exportKmlBtn'), 'KML button in the main export card');
  for (const gone of ['g3dBtnSnapshot', 'g3dBtnCzml', 'g3dBtnKml']) {
    assert.strictEqual(doc.getElementById(gone), null, `#${gone} removed from the 3D card`);
  }
  // enable/disable with track load
  assert.ok(window.GSRTrackManager.EXPORT_BUTTON_IDS.includes('exportCzmlBtn'));
  assert.ok(window.GSRTrackManager.EXPORT_BUTTON_IDS.includes('exportKmlBtn'));
});

test('export3DTrack: downloads only for a single track with drawPoints', () => {
  const { window } = bootApp();
  window.setup();
  const AppState = window.AppState;

  let downloaded = null;
  window.GSRGlobe3DExport.download = (text, name) => { downloaded = { text, name }; };

  // no track → no download
  AppState.analyzer = null;
  AppState.mapManager._lastDrawPoints = null;
  window.GSREvents.export3DTrack('czml');
  assert.strictEqual(downloaded, null, 'nothing to export without a track');

  // single track with drawPoints → CZML download with the wall geometry
  AppState.viewMode = 'single';
  AppState.analyzer = { raw: [{ gsr: 1 }, { gsr: 2 }], phasic: [{ val: 1 }, { val: 2 }] };
  AppState.mapManager._lastDrawPoints = [
    { lat: 51.5, lon: -0.1, origIdx: 0 }, { lat: 51.6, lon: -0.2, origIdx: 1 },
  ];
  AppState.mapManager.activeColoringMetric = 'phasic';
  window.GSREvents.export3DTrack('czml');
  assert.ok(downloaded && /\.czml$/.test(downloaded.name), 'czml file downloaded');
  assert.match(downloaded.text, /"cartographicDegrees"/);

  // collective scope → no download (merged drawPoints don't map to AppState.analyzer)
  downloaded = null;
  AppState.viewMode = 'collective';
  window.GSREvents.export3DTrack('kml');
  assert.strictEqual(downloaded, null, 'collective scope is not exported');
});

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

// ── Scrub sync (graph <-> 3D globe) ────────────────────────────────────────

/** A spy stand-in for GSRGlobeManager, enough for the scrub paths. */
function spyManager() {
  return {
    calls: [],
    setScrubPosition(lat, lon) { this.calls.push(['set', lat, lon]); },
    followScrub(lat, lon) { this.calls.push(['follow', lat, lon]); },
    releaseFollowScrub() { this.calls.push(['release']); },
    _wakeRenderLoop() {},
    _requestRender() {},
  };
}

test('_onScrub: graph source moves the cursor AND drives the follow-cam', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  V.isActive = true;
  V.manager = spyManager();
  V._lastScrubKey = null;

  V._onScrub({ lat: 51.5, lon: -0.1, index: 7, source: 'graph' });
  assert.deepStrictEqual(V.manager.calls, [['set', 51.5, -0.1], ['follow', 51.5, -0.1]]);
});

test('_onScrub: globe (self) source moves the cursor but never the camera', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  V.isActive = true;
  V.manager = spyManager();
  V._lastScrubKey = null;

  V._onScrub({ lat: 51.5, lon: -0.1, index: 7, source: 'globe' });
  assert.deepStrictEqual(V.manager.calls, [['set', 51.5, -0.1]]);
});

test('_onScrub: clear hides the cursor and releases the follow-cam', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  V.isActive = true;
  V.manager = spyManager();
  V._lastScrubKey = '51.500000,-0.100000'; // a cursor is currently showing

  V._onScrub({ clear: true, source: 'graph' });
  const kinds = V.manager.calls.map((c) => c[0]);
  assert.ok(kinds.includes('release'));
  assert.ok(V.manager.calls.some((c) => c[0] === 'set' && Number.isNaN(c[1])));
  assert.strictEqual(V._lastScrubKey, null);

  // a second clear with nothing showing is a no-op (no repaint churn)
  V.manager.calls.length = 0;
  V._onScrub({ clear: true, source: 'graph' });
  assert.deepStrictEqual(V.manager.calls, []);
});

test('_onScrub: inactive surface ignores scrubs; identical non-graph coords dedupe', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  V.manager = spyManager();

  V.isActive = false;
  V._onScrub({ lat: 1, lon: 2, source: 'graph' });
  assert.deepStrictEqual(V.manager.calls, [], 'ignored while 2D map is showing');

  V.isActive = true;
  V._lastScrubKey = null;
  V._onScrub({ lat: 1, lon: 2, source: 'globe' });
  V._onScrub({ lat: 1, lon: 2, source: 'globe' }); // same spot, self source -> deduped
  assert.strictEqual(V.manager.calls.filter((c) => c[0] === 'set').length, 1);
});

test('_onScrubHover: takes cursor ownership, sets hoveredIndex, emits on the shared channel', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const AppState = window.AppState;
  V.isActive = true;
  AppState.viewMode = 'single';

  const seen = [];
  AppState.on('scrub', (p) => seen.push(p));

  V._onScrubHover(12, { lat: 51.5, lon: -0.1 });
  assert.strictEqual(AppState.scrubSource, 'globe');
  assert.strictEqual(AppState.hoveredIndex, 12);
  // (cross-realm object — compare fields, not deepStrictEqual which checks proto)
  assert.strictEqual(seen.at(-1).lat, 51.5);
  assert.strictEqual(seen.at(-1).lon, -0.1);
  assert.strictEqual(seen.at(-1).index, 12);
  assert.strictEqual(seen.at(-1).source, 'globe');

  V._onScrubHover(null);
  assert.strictEqual(AppState.scrubSource, null);
  assert.strictEqual(AppState.hoveredIndex, -1);
  assert.strictEqual(seen.at(-1).clear, true);
});

test('_onScrubHover: no-op outside single-track scope', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const AppState = window.AppState;
  V.isActive = true;
  AppState.viewMode = 'collective';
  AppState.scrubSource = null;

  V._onScrubHover(5, { lat: 1, lon: 2 });
  assert.strictEqual(AppState.scrubSource, null, 'collective view has no graph to scrub');
});

test('shared "scrub" event reaches BOTH the 2D map and the 3D globe', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const AppState = window.AppState;

  const mapCalls = [];
  AppState.mapManager.setScrubPosition = (lat, lon, panTo) => mapCalls.push([lat, lon, panTo]);

  V.isActive = true;
  V.manager = spyManager();
  V._lastScrubKey = null;

  AppState.emit('scrub', { lat: 51.5, lon: -0.12, index: 3, source: 'graph' });

  assert.deepStrictEqual(mapCalls, [[51.5, -0.12, true]], '2D map dot moved, panTo on');
  assert.ok(V.manager.calls.some((c) => c[0] === 'set' && c[1] === 51.5));
  assert.ok(V.manager.calls.some((c) => c[0] === 'follow'));
});

test('deactivate() clears the 3D cursor and hands ownership back to the graph', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const AppState = window.AppState;

  V.isActive = true;
  V.manager = spyManager();
  AppState.scrubSource = 'globe';
  AppState.hoveredIndex = 9;

  const seen = [];
  AppState.on('scrub', (p) => seen.push(p));

  V.deactivate();
  assert.strictEqual(AppState.scrubSource, null);
  assert.strictEqual(AppState.hoveredIndex, -1);
  assert.ok(V.manager.calls.some((c) => c[0] === 'release'));
  assert.ok(V.manager.calls.some((c) => c[0] === 'set' && Number.isNaN(c[1])));
  assert.ok(seen.some((p) => p.clear));
});

test('renderer.handleScrubber does not wipe a globe-owned hover (ownership token)', () => {
  const { window } = bootApp();
  window.setup();
  const AppState = window.AppState;

  // p5 globals the harness omits but handleScrubber's draw path needs
  window.circle = window.circle || (() => {});
  window.BOLD = 'bold'; window.NORMAL = 'normal';
  window.width = 800; window.height = 400;

  const n = 20;
  const mk = (f) => Array.from({ length: n }, (_, i) => ({ time: i, val: f(i) }));
  AppState.analyzer = {
    raw: Array.from({ length: n }, (_, i) => ({ time: i, val: 1, hasGps: true, lat: 51 + i * 1e-4, lon: -0.1 })),
    filtered: mk(() => 1), tonic: mk(() => 1), phasic: mk(() => 1),
    peaks: [], sampleRate: 4,
    findClosestIndex: () => 0,
  };

  AppState.scrubSource = 'globe';
  AppState.hoveredIndex = 6;

  const emitted = [];
  const origEmit = AppState.emit.bind(AppState);
  AppState.emit = (ev, ...a) => { if (ev === 'scrub') emitted.push(a[0]); return origEmit(ev, ...a); };

  assert.doesNotThrow(() =>
    window.GSRRenderer.handleScrubber(0, 19, 0, 1, 100, 0, 1, 110, 200));

  assert.strictEqual(AppState.hoveredIndex, 6, 'globe-owned hover survived the per-frame pass');
  assert.strictEqual(AppState.scrubSource, 'globe');
  assert.ok(!emitted.some((p) => p && p.clear), 'no spurious clear emitted');

  AppState.emit = origEmit;
});
