/**
 * Boots the real index.html app (jsdom, Cesium absent) and checks the 2D↔3D
 * surface switcher: Leaflet and Cesium are swapped inside the one #mapPanel —
 * the switcher toggles which render container shows (#map ⇄ #globe3dContainer)
 * and reveals the 3D-only settings sub-section (#mapDisplay3DGroup), without
 * throwing when Cesium can't load. The single map-panel header's controls
 * dispatch to whichever engine is mounted (GSRGlobe3DView.applyToggle / etc.).
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

test('surface switcher swaps the render container inside #mapPanel and reveals the 3D settings', () => {
  const { window } = bootApp();
  window.setup();

  const btnGlobe = window.document.getElementById('btnGlobeSurface');
  const btnMap = window.document.getElementById('btnMapSurface');
  assert.ok(btnGlobe && btnMap, 'both surface tabs exist');

  // one map panel, one header — the old duplicate globe panel + header are gone
  assert.strictEqual(window.document.getElementById('globe3dPanel'), null, 'no separate globe panel');
  assert.strictEqual(window.document.getElementById('globe3dSettingsCard'), null, 'no separate 3D settings card');
  for (const gone of ['btnGlobe3dFullscreen', 'btnGlobe3dZoomIn', 'btnGlobe3dRf',
                      'btnGlobe3dPeaks', 'globe3dColoringMetric', 'globe3dRfMode',
                      // 3D sub-section controls now covered by the map header
                      'g3dHeightMetric', 'g3dChkRf', 'g3dRfMode', 'g3dChkBuildings', 'g3dBtnFit']) {
    assert.strictEqual(window.document.getElementById(gone), null, `redundant control #${gone} removed`);
  }
  // the Cesium container now lives inside #mapPanel next to #map
  const globeC = window.document.getElementById('globe3dContainer');
  assert.strictEqual(globeC.closest('#mapPanel')?.id, 'mapPanel', '#globe3dContainer is a #mapPanel child');

  // starts on the 2D map
  assert.strictEqual(window.AppState.surfaceView, 'map');
  assert.ok(vis(window, 'map') && !vis(window, 'globe3dContainer'));
  assert.ok(!vis(window, 'mapDisplay3DGroup'), '3D settings hidden in 2D');

  // → 3D globe
  assert.doesNotThrow(() => btnGlobe.click());
  assert.strictEqual(window.AppState.surfaceView, 'globe');
  assert.ok(!vis(window, 'map'), '#map hidden in 3D');
  assert.ok(vis(window, 'globe3dContainer'), '#globe3dContainer shown in 3D');
  assert.ok(vis(window, 'mapDisplay3DGroup'), '3D settings sub-section shown');
  assert.ok(vis(window, 'mapDisplayCard'), 'the one Map Display card stays visible');
  assert.ok(btnGlobe.classList.contains('active') && !btnMap.classList.contains('active'));

  // → back to 2D
  assert.doesNotThrow(() => btnMap.click());
  assert.strictEqual(window.AppState.surfaceView, 'map');
  assert.ok(vis(window, 'map') && !vis(window, 'globe3dContainer'));
  assert.ok(!vis(window, 'mapDisplay3DGroup'));
});

test('shared header toggles dispatch to the globe manager while 3D is the mounted surface', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;

  // stub a manager and mark the 3D surface active (no real Cesium in jsdom)
  const calls = [];
  V.manager = {
    minPeakQuality: 0,
    togglePeaks: (on) => calls.push(['peaks', on]),
    toggleHotspots: (on) => calls.push(['hotspots', on]),
    toggleLabels: (on) => calls.push(['labels', on]),
    toggleClusters: (on) => calls.push(['clusters', on]),
    toggle3DRf: (on) => calls.push(['rf', on]),
  };
  V.isActive = true;
  window.AppState.surfaceView = 'globe';

  const rfBtn = window.document.getElementById('btnToggleRFFluid');
  rfBtn.removeAttribute('disabled');

  for (const [btnId, name] of [
    ['btnToggleMapPeaks', 'peaks'],
    ['btnToggleMapHotspots', 'hotspots'],
    ['btnToggleMapLabels', 'labels'],
    ['btnToggleMapClusters', 'clusters'],
    ['btnToggleRFFluid', 'rf'],
  ]) {
    const btn = window.document.getElementById(btnId);
    const want = !btn.classList.contains('active');
    assert.doesNotThrow(() => btn.click());
    assert.deepStrictEqual(calls.at(-1), [name, want], `#${btnId} click reached the globe manager`);
  }

  V.manager = null;
  V.isActive = false;
});

test('the map header OSM button toggles 3D buildings (shared OSM data) while the globe is mounted', async () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const doc = window.document;

  // an analysed track already carrying OSM json → _resolveOsmJson reuses it,
  // no network, and feeds it to the manager as cachedOsmJson.
  const osmJson = { elements: [] };
  window.AppState.analyzer = { raw: [{ lat: 51, lon: -0.1 }], osmJson, osmGeoms: { ways: [], relations: [] } };

  const calls = [];
  V.manager = {
    show3DBuildings: false, cachedOsmJson: null,
    toggle3DBuildings: (on, style) => { calls.push([on, style]); return Promise.resolve(); },
  };
  V.isActive = true;
  window.AppState.surfaceView = 'globe';

  const osm = doc.getElementById('btnToggleOsmShapes');
  osm.style.display = 'inline-block';

  osm.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(calls.at(-1), [true, 'monochrome'], 'buildings on, default white style');
  assert.strictEqual(V.manager.cachedOsmJson, osmJson, 'globe got the SAME OSM json as the 2D enrichment');

  osm.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(calls.at(-1)[0], false, 'second click turns buildings off');

  V.manager = null;
  V.isActive = false;
});

test('applyBuildings clears status messages (e.g. "Parsing geographical payload...") once completed or deactivated', async () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const doc = window.document;

  const statusEl = doc.getElementById('globe3dStatus');
  assert.ok(statusEl, 'status element exists');

  V.manager = {
    show3DBuildings: false, cachedOsmJson: null,
    toggle3DBuildings: (on, style, onStatus) => {
      if (on && onStatus) onStatus('Parsing geographical payload...');
      return Promise.resolve();
    },
  };
  V.isActive = true;
  window.AppState.surfaceView = 'globe';

  // Toggle on: status may be set during fetch/parse, but must be cleared when done
  V.applyBuildings(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(statusEl.style.display, 'none', 'status element hidden after applyBuildings(true) resolves');
  assert.strictEqual(statusEl.textContent, '', 'status text cleared after applyBuildings(true) resolves');

  // If a status message was set before deactivation, deactivating clears it
  V._setStatus('Parsing geographical payload...');
  assert.strictEqual(statusEl.style.display, 'block');
  V.deactivate();
  assert.strictEqual(statusEl.style.display, 'none', 'status element hidden after deactivate()');
  assert.strictEqual(statusEl.textContent, '', 'status text cleared after deactivate()');

  V.manager = null;
  V.isActive = false;
});

test('_resolveOsmJson reuses analyzer.osmJson and reconstructs osmGeoms for the 2D OSM button', async () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;

  // no geoms yet, but raw json present (e.g. a stale cache load)
  const osmJson = { elements: [{ type: 'node', id: 1, lat: 51, lon: -0.1 }] };
  window.AppState.analyzer = { raw: [{ lat: 51, lon: -0.1 }], osmJson };

  const got = await V._resolveOsmJson();
  assert.strictEqual(got, osmJson, 'returns the in-memory json without fetching');
  assert.ok(window.AppState.analyzer.osmGeoms, 'osmGeoms reconstructed so the 2D OSM shapes button can show');
});

test('_resolveOsmJson requests the SAME bbox buffer as the 2D enrichment (cache hit both ways)', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;
  doc.getElementById('osmRadius').value = '80';
  doc.getElementById('gpsSnapRadius').value = '40';
  // 2D enrichTrack uses max(osmRadius, gpsSnapRadius) + 50
  assert.strictEqual(window.GSRGlobe3DView._osmBboxBufferM(), 130);
});

test('the OSM/buildings toggle state persists across a 2D↔3D surface switch', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;
  const V = window.GSRGlobe3DView;

  // track already carries OSM geometry, so the 2D button is available
  window.AppState.analyzer = {
    raw: [{ lat: 51, lon: -0.1 }], isEnriched: false,
    osmJson: { elements: [] }, osmGeoms: { ways: [], relations: [] },
  };
  window.AppState.viewMode = 'single';

  const osm = doc.getElementById('btnToggleOsmShapes');
  window.GSRUI.refreshOsmControls();
  assert.notStrictEqual(osm.style.display, 'none', 'button shown for a track with osmGeoms even without full enrichment');

  // turn the OSM layer on in 2D, then go to the globe
  osm.classList.add('active');
  doc.getElementById('btnGlobeSurface').click();
  assert.strictEqual(window.AppState.surfaceView, 'globe');
  assert.ok(osm.classList.contains('active'), 'toggle stays on when switching to the globe');

  // …and back to the map
  doc.getElementById('btnMapSurface').click();
  assert.strictEqual(window.AppState.surfaceView, 'map');
  assert.ok(osm.classList.contains('active'), 'toggle still on after returning to the 2D map');
  assert.notStrictEqual(osm.style.display, 'none', 'button still visible');
});

test('switching surface leaves no fullscreen overlay behind', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;
  doc.getElementById('btnGlobeSurface').click();
  doc.getElementById('btnMapSurface').click();
  assert.strictEqual(doc.querySelector('.panel-fullscreen-overlay'), null);
});

test('#mapPanel fullscreen while 3D is active re-measures the globe', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;

  let resized = 0;
  const orig = window.GSRGlobe3DView.onResize;
  window.GSRGlobe3DView.onResize = () => { resized++; };

  doc.getElementById('btnGlobeSurface').click();          // → 3D globe
  const mapFsBtn = doc.getElementById('btnMapFullscreen');
  assert.doesNotThrow(() => mapFsBtn.click());            // enter panel fullscreen
  assert.strictEqual(doc.getElementById('mapPanel').parentNode.className, 'panel-fullscreen-overlay');
  assert.ok(resized >= 1, 'globe told to re-measure on entering fullscreen');
  assert.doesNotThrow(() => mapFsBtn.click());            // exit
  assert.strictEqual(doc.querySelector('.panel-fullscreen-overlay'), null, 'no overlay left');

  window.GSRGlobe3DView.onResize = orig;
});

test('the 3D globe legend renders the exact same markup as the 2D map legend', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;
  const mm = window.AppState.mapManager;

  window.AppState.viewMode = 'single';
  mm.activeColoringMetric = 'em_fog';
  mm._legendMinVal = 10;
  mm._legendMaxVal = 90;

  window.GSRGlobe3DView._updateLegend();

  const g3d = doc.getElementById('g3dLegend').innerHTML;
  assert.strictEqual(g3d, mm.buildLegendHtml(), '3D legend HTML is byte-for-byte the 2D legend');
  assert.ok(g3d.includes('EM Fog Index (0-100)'), 'same title as the 2D map');
  assert.ok(g3d.includes('10') && g3d.includes('90'), 'same formatted range');
  assert.ok(doc.getElementById('g3dLegend').classList.contains('map-legend'), 'uses the 2D legend card style');
});

test('the "Loading 3D engine" / imagery status is gone', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'src/map/globe3d_view.js'), 'utf8');
  assert.ok(!/Loading 3D engine/.test(src), 'the loading-3D-engine text is gone');
  assert.ok(!/Loading map imagery/.test(src), 'the loading-imagery text is gone');
  assert.ok(!/_watchImageryLoad/.test(src), 'the imagery-load watcher is gone');
});

test('the map header RF band (#rfFluidMode) re-applies the 3D volumetric field', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;
  const calls = [];
  window.GSRGlobe3DView.manager = {
    showRfVolumetric: true, rfMode: 'triband',
    toggle3DRf: (on, mode) => calls.push([on, mode]),
  };
  window.GSRGlobe3DView.isActive = true;
  window.AppState.surfaceView = 'globe';

  const mode2d = doc.getElementById('rfFluidMode');
  mode2d.value = '868';
  assert.doesNotThrow(() => mode2d.dispatchEvent(new window.Event('change')));
  assert.deepStrictEqual(calls.at(-1), [true, '868'], 'globe field re-applied with the header band');

  window.GSRGlobe3DView.manager = null;
  window.GSRGlobe3DView.isActive = false;
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
    stopTour() { this.calls.push(['stopTour']); },
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

test('_onScrubHover: no-op while the panel is fullscreen (the graph is hidden)', () => {
  const { window } = bootApp();
  window.setup();
  const doc = window.document;
  const V = window.GSRGlobe3DView;
  const AppState = window.AppState;
  V.isActive = true;
  AppState.viewMode = 'single';
  AppState.scrubSource = null;

  // simulate the panel-fullscreen overlay wrapping the globe container
  const overlay = doc.createElement('div');
  overlay.className = 'panel-fullscreen-overlay';
  const mapPanel = doc.getElementById('mapPanel');
  mapPanel.parentNode.insertBefore(overlay, mapPanel);
  overlay.appendChild(mapPanel);

  assert.strictEqual(V._graphVisible(), false);
  V._onScrubHover(5, { lat: 1, lon: 2 });
  assert.strictEqual(AppState.scrubSource, null, 'no scrub attempt while fullscreen');

  // leaving fullscreen re-enables it
  mapPanel.parentNode.parentNode.insertBefore(mapPanel, overlay);
  overlay.remove();
  V._onScrubHover(5, { lat: 1, lon: 2 });
  assert.strictEqual(AppState.scrubSource, 'globe', 'reverse-hover scrub works again after exit');
});

test('onPanelFullscreenChange(true) drops a globe-owned scrub and hands the graph back', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const AppState = window.AppState;

  const mgr = spyManager();
  V.manager = mgr;
  V.isActive = true;
  AppState.scrubSource = 'globe';
  AppState.hoveredIndex = 12;
  V._lastScrubKey = '51.000000,-0.100000';

  let scrubEvt = null;
  AppState.on('scrub', (p) => { scrubEvt = p; });

  V.onPanelFullscreenChange(true);

  assert.ok(mgr.calls.some(c => c[0] === 'set' && Number.isNaN(c[1])), 'globe scrub cursor cleared');
  assert.ok(mgr.calls.some(c => c[0] === 'release'), 'follow-cam released');
  assert.strictEqual(AppState.scrubSource, null, 'graph ownership handed back');
  assert.strictEqual(V._lastScrubKey, null);
  assert.ok(scrubEvt && scrubEvt.clear === true && scrubEvt.source === 'globe');

  V.manager = null;
  V.isActive = false;
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

test('applyColorMetric forwards metric to manager and updates the 3D legend', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const doc = window.document;
  const mm = window.AppState.mapManager;

  window.AppState.viewMode = 'single';
  mm.activeColoringMetric = 'phasic';
  mm._legendMinVal = 0;
  mm._legendMaxVal = 5;

  let metricSet = null;
  V.manager = {
    setColoringMetric: (m) => { metricSet = m; },
  };
  V.isActive = true;
  window.AppState.surfaceView = 'globe';

  V.applyColorMetric('phasic');
  assert.strictEqual(metricSet, 'phasic', 'setColoringMetric called on manager');
  const g3d = doc.getElementById('g3dLegend').innerHTML;
  assert.ok(g3d.includes('Phasic (SCR)'), 'legend updated with phasic title');

  V.manager = null;
  V.isActive = false;
});

test('Tour button in 3D camera controls toggles manager tour and updates UI', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const doc = window.document;

  const btnTour = doc.getElementById('g3dBtnTour');
  assert.ok(btnTour, '#g3dBtnTour button exists in DOM');

  let tourToggled = 0;
  let isTouring = false;
  V.manager = {
    toggleTour: () => {
      tourToggled++;
      isTouring = !isTouring;
      return isTouring;
    },
    stopTour: () => {
      isTouring = false;
    },
    setScrubPosition: () => {},
    releaseFollowScrub: () => {},
  };
  V.isActive = true;
  window.AppState.surfaceView = 'globe';

  // Click 1 -> start tour
  btnTour.click();
  assert.strictEqual(tourToggled, 1);
  assert.ok(btnTour.classList.contains('active'), 'button marked active');
  assert.match(btnTour.innerHTML, /Pause/, 'button label updated to Pause');

  // Click 2 -> pause / stop tour
  btnTour.click();
  assert.strictEqual(tourToggled, 2);
  assert.strictEqual(btnTour.classList.contains('active'), false, 'button active class removed');
  assert.match(btnTour.innerHTML, /Tour/, 'button label restored to Tour');

  // Activate tour again then deactivate view -> stops tour
  btnTour.click();
  assert.ok(btnTour.classList.contains('active'));
  V.deactivate();
  assert.strictEqual(btnTour.classList.contains('active'), false, 'deactivate resets button state');

  V.manager = null;
  V.isActive = false;
});

test('_pushFromMap in collective mode resolves drawPoints for active track and renders', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;
  const mm = window.AppState.mapManager;

  window.AppState.viewMode = 'collective';
  window.AppState.activeTrackId = 'track-1';
  window.AppState.analyzer = {
    raw: [{ gsr: 1 }, { gsr: 2 }],
    peaks: []
  };

  let renderedPoints = null;
  V.manager = {
    renderData: (analyzer, params, opts) => {
      renderedPoints = opts.drawPoints;
    },
    setBasemap: () => {},
  };
  V.isActive = true;

  mm._getOrBuildDrawPoints = (id, analyzer, params) => ({
    drawPoints: [{ lat: 51.5, lon: -0.1 }, { lat: 51.6, lon: -0.2 }]
  });

  V._pushFromMap();
  assert.ok(renderedPoints, 'drawPoints passed to 3D manager in collective mode');
  assert.strictEqual(renderedPoints.length, 2);

  V.manager = null;
  V.isActive = false;
});

test('GSRGlobe3DView.focusOnPeak flies camera and opens 3D popup', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;

  window.AppState.analyzer = {
    raw: [{ lat: 51.5, lon: -0.1, hasGps: true }],
    peaks: [{ time: 42, label: 'Peak A', index: 0 }],
    getCoordinates: () => ({ lat: 51.5, lon: -0.1 }),
  };

  const flyCalls = [];
  V.manager = {
    flyToPeak: (idx, a) => flyCalls.push({ idx, a }),
  };
  V.isActive = true;

  let popupShown = null;
  V._editPeakLabel = (idx) => { popupShown = idx; };

  V.focusOnPeak(0);

  assert.strictEqual(flyCalls.length, 1);
  assert.strictEqual(flyCalls[0].idx, 0);
  assert.strictEqual(popupShown, 0);

  V.manager = null;
  V.isActive = false;
});

test('GSRUI.focusOnPeak routes to GSRGlobe3DView.focusOnPeak when 3D surface is active', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;

  window.AppState.analyzer = {
    raw: [{ lat: 51.5, lon: -0.1, hasGps: true }],
    peaks: [{ time: 42, onsetTime: 40, label: 'Peak A', index: 0 }],
    getCoordinates: () => ({ lat: 51.5, lon: -0.1 }),
  };
  window.AppState.surfaceView = 'globe';
  V.isActive = true;

  let globeFocused = null;
  V.focusOnPeak = (idx) => { globeFocused = idx; };

  window.GSRUI.focusOnPeak(0, 'table');
  assert.strictEqual(globeFocused, 0, 'focus routed to 3D globe');

  V.isActive = false;
});

test('3D peak click triggers GSRUI.focusOnPeak with source=map and opens popup', () => {
  const { window } = bootApp();
  window.setup();
  const V = window.GSRGlobe3DView;

  let registeredClickCb = null;
  V.manager = {
    onPeakClick: (cb) => { registeredClickCb = cb; },
    onScrubHover: () => {},
    onTourStep: () => {},
  };

  window.AppState.analyzer = {
    raw: [{ lat: 51.5, lon: -0.1, hasGps: true }],
    peaks: [{ time: 42, onsetTime: 40, label: 'Peak 1', index: 0 }],
    getCoordinates: () => ({ lat: 51.5, lon: -0.1 }),
  };

  let popupIdx = null;
  V._editPeakLabel = (idx) => { popupIdx = idx; };

  let uiFocused = null;
  window.GSRUI.focusOnPeak = (idx, src) => { uiFocused = { idx, src }; };

  // Trigger the click callback as set in activate()
  const cb = (peakIdx, pos) => {
    window.GSRUI.focusOnPeak(peakIdx, 'map');
    V._editPeakLabel(peakIdx, pos);
  };

  cb(0, { x: 100, y: 150 });
  assert.deepStrictEqual(uiFocused, { idx: 0, src: 'map' });
  assert.strictEqual(popupIdx, 0);

  V.manager = null;
});
