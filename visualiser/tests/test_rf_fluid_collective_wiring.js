/**
 * Phase 5 (docs/archive/visualizer_architecture_refactor_plan.md) integration test:
 * GSRMapManager.renderCollectiveData() must hand RFFluidRenderer per-track
 * {id, drawPoints, osmGeoms} entries (via setDataForTracks()), not a single
 * pre-concatenated blob (the old setData(collectiveDrawPoints, combinedGeoms)
 * call). The per-track entries are what let RFFluidRenderer's own fan-cast
 * cache (tests/test_rf_fluid_lifecycle.js) actually pay off across re-renders
 * — concatenating first would build a fresh array reference on every single
 * call regardless of whether any underlying track changed, defeating that
 * cache entirely.
 *
 * Boots the REAL app (see tests/support/boot_app.js) with its default
 * superMock() Leaflet stand-in — unlike test_map_layer_ownership.js's
 * recording-Leaflet harness, superMock answers every Leaflet/canvas call
 * harmlessly, so RFFluidRenderer constructs for real here and can be spied on
 * directly, without needing a real 2D canvas context.
 *
 * Run: node --test tests/test_rf_fluid_collective_wiring.js
 */

const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

function rfCsv(latBase, lonBase) {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    const t = (i * 0.1).toFixed(2);
    const lat = (latBase + i * 0.0001).toFixed(6);
    const lon = (lonBase + i * 0.0001).toFixed(6);
    const rssi815 = (-90 + i * 3).toFixed(1);
    rows.push(`${t},${lat},${lon},2.0,3,${rssi815},-91.5,-91.5`);
  }
  return [
    'timestamp,lat,lon,hdop,fix_type,rssi_815,rssi_868,rssi_915',
    ...rows,
  ].join('\n');
}

function addTrack(window, id, name, csvText) {
  const analyzer = new window.GSRAnalyzer();
  analyzer.parseCSV(csvText);
  const track = window.GSRTrackManager.createTrackObject(id, name, '#ff0000', analyzer);
  analyzer.analyze(track.filterParams, 0);
  window.AppState.collectiveManager.addTrack(track);
  return track;
}

function bootCollectiveWithTwoTracks() {
  const { window } = bootApp();
  // jsdom canvases have no 2d context by default; renderCollectiveData()'s
  // contour-surface rasterization (map.js renderContours(), unrelated to RF
  // fluid) needs one — same stub test_map_layer_ownership.js uses.
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
  window.setup();
  const trackA = addTrack(window, 'A', 'A.csv', rfCsv(51.5074, -0.1278));
  const trackB = addTrack(window, 'B', 'B.csv', rfCsv(51.51, -0.13));
  window.AppState.viewMode = 'collective';
  const mapManager = window.AppState.mapManager;
  assert.ok(mapManager.rfFluidRenderer, 'fixture sanity check: RFFluidRenderer should construct under the default superMock Leaflet');
  return { window, mapManager, trackA, trackB };
}

test('renderCollectiveData wires per-track drawPoints/osmGeoms into RFFluidRenderer.setDataForTracks, not a concatenated setData blob', () => {
  const { window, mapManager } = bootCollectiveWithTwoTracks();

  const setDataForTracksCalls = [];
  const setDataCalls = [];
  mapManager.rfFluidRenderer.setDataForTracks = (tracksData) => { setDataForTracksCalls.push(tracksData); };
  mapManager.rfFluidRenderer.setData = (dp, og) => { setDataCalls.push({ dp, og }); };

  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  assert.strictEqual(setDataForTracksCalls.length, 1, 'renderCollectiveData should call setDataForTracks exactly once');
  assert.strictEqual(setDataCalls.length, 0, 'renderCollectiveData must NOT use the single-blob setData() path');

  const tracksData = setDataForTracksCalls[0];
  assert.strictEqual(tracksData.length, 2, 'one entry per active track');
  // tracksData is a vm-context (jsdom Realm) array — deepStrictEqual's
  // reference-equality check on cross-realm Array instances fails even for
  // identical-looking arrays, so compare via a plain join instead.
  const ids = tracksData.map(t => t.id).sort().join(',');
  assert.strictEqual(ids, 'A,B');
  tracksData.forEach(t => {
    assert.ok(Array.isArray(t.drawPoints) && t.drawPoints.length > 0, `track ${t.id} should carry a non-empty drawPoints array`);
  });
});

test('renderCollectiveData re-renders reuse the same per-track drawPoints reference for an unchanged track', () => {
  const { window, mapManager, trackB } = bootCollectiveWithTwoTracks();

  const calls = [];
  mapManager.rfFluidRenderer.setDataForTracks = (tracksData) => { calls.push(tracksData); };

  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  assert.strictEqual(calls.length, 2);
  const firstA = calls[0].find(t => t.id === 'A');
  const secondA = calls[1].find(t => t.id === 'A');
  assert.strictEqual(secondA.drawPoints, firstA.drawPoints,
    'an unrelated re-render (no param change on A) must hand RFFluidRenderer the SAME drawPoints reference for A, so its fan-cast cache can skip recomputing A');

  // Now change ONLY track B's GPS params (a plausible "drag B's smoothing
  // slider" scenario) and re-render a third time.
  trackB.gpsFilterParams = { ...trackB.gpsFilterParams, smoothing: (trackB.gpsFilterParams.smoothing || 0.5) + 0.3 };
  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  assert.strictEqual(calls.length, 3);
  const thirdA = calls[2].find(t => t.id === 'A');
  const thirdB = calls[2].find(t => t.id === 'B');
  const secondB = calls[1].find(t => t.id === 'B');
  assert.strictEqual(thirdA.drawPoints, firstA.drawPoints,
    'track A is still unrelated to the change on B and must keep the same drawPoints reference');
  assert.notStrictEqual(thirdB.drawPoints, secondB.drawPoints,
    'track B\'s own GPS param change must produce a new drawPoints reference so its fan cast actually recomputes');
});

test('_clearRfFluid (via clearAll at the top of renderCollectiveData) blanks the canvas through clear(), not the single-blob setData([], null)', () => {
  const { window, mapManager } = bootCollectiveWithTwoTracks();

  let clearCalls = 0;
  let setDataCalls = 0;
  mapManager.rfFluidRenderer.clear = () => { clearCalls++; };
  mapManager.rfFluidRenderer.setData = () => { setDataCalls++; };
  mapManager.rfFluidRenderer.setDataForTracks = () => {};

  mapManager.renderCollectiveData(window.AppState.collectiveManager, { showShadedSurface: false }, 0);

  assert.ok(clearCalls > 0, 'clearAll()->clearMap()/clearCollectiveLayers() should blank the RF canvas via clear()');
  assert.strictEqual(setDataCalls, 0, 'the clear-before-render safety net must not go through setData([], null) (would prune the per-track fan cache)');
});
