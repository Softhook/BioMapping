/**
 * Unit tests for collective_project.js (GSRCollectiveProject) — collective
 * map session export/import to a re-importable .zip bundle.
 *
 * The pure helpers (_sanitizeName/_pickValues/_applyValues/_buildManifest)
 * are tested directly. exportProject()/importProject() are heavily
 * integrated with globals (AppState, document, alert, confirm, JSZip,
 * GSRTrackManager, GSRFileSaver, GSRAnalyzer, GSRUI) — those are stubbed
 * with minimal manual mocks here rather than pulled in for real, so these
 * are closer to integration tests of the control flow than pure unit tests.
 *
 * Run: node --test tests/test_collective_project.js
 */

const assert = require('assert');
const test = require('node:test');

// ── Minimal global stubs so collective_project.js's top-level references
//    resolve under plain Node (none of these exist outside a browser). ──────
global.window = global;
global.document = { getElementById: () => null };
global.alert = () => {};
global.confirm = () => true;

const { GSRCollectiveProject } = require('../collective_project.js');

// ── _sanitizeName ────────────────────────────────────────────────────────
test('_sanitizeName: strips a file extension and replaces disallowed characters', () => {
  assert.strictEqual(GSRCollectiveProject._sanitizeName('My Walk #1.csv'), 'My_Walk__1');
});

test('_sanitizeName: falls back to "track" for empty/undefined input', () => {
  assert.strictEqual(GSRCollectiveProject._sanitizeName(''), 'track');
  assert.strictEqual(GSRCollectiveProject._sanitizeName(undefined), 'track');
});

test('_sanitizeName: leaves already-safe names untouched (minus extension)', () => {
  assert.strictEqual(GSRCollectiveProject._sanitizeName('morning_walk-01.csv'), 'morning_walk-01');
});

// ── _pickValues ──────────────────────────────────────────────────────────
test('_pickValues: reads .checked for checkbox controls and .value for others', () => {
  const controls = {
    a: { type: 'checkbox', checked: true },
    b: { type: 'text', value: '42' },
  };
  const out = GSRCollectiveProject._pickValues(controls, ['a', 'b']);
  assert.deepStrictEqual(out, { a: true, b: '42' });
});

test('_pickValues: skips keys with no matching control and returns {} for null controls', () => {
  assert.deepStrictEqual(GSRCollectiveProject._pickValues(null, ['a', 'b']), {});
  const out = GSRCollectiveProject._pickValues({ a: { type: 'text', value: '1' } }, ['a', 'missing']);
  assert.deepStrictEqual(out, { a: '1' });
});

// ── _applyValues ─────────────────────────────────────────────────────────
test('_applyValues: writes .checked for checkbox controls and .value for others', () => {
  const controls = {
    a: { type: 'checkbox', checked: false },
    b: { type: 'text', value: '' },
  };
  GSRCollectiveProject._applyValues(controls, { a: true, b: '99' });
  assert.strictEqual(controls.a.checked, true);
  assert.strictEqual(controls.b.value, '99');
});

test('_applyValues: is a no-op for missing controls or undefined values, and does not throw on null args', () => {
  assert.doesNotThrow(() => GSRCollectiveProject._applyValues(null, { a: 1 }));
  assert.doesNotThrow(() => GSRCollectiveProject._applyValues({ a: { value: 'x' } }, null));
  const controls = { a: { type: 'text', value: 'unchanged' } };
  GSRCollectiveProject._applyValues(controls, { a: undefined, missing: 5 });
  assert.strictEqual(controls.a.value, 'unchanged');
});

test('_applyValues: coerces truthy/falsy values to boolean for checkboxes', () => {
  const controls = { a: { type: 'checkbox', checked: false } };
  GSRCollectiveProject._applyValues(controls, { a: 1 });
  assert.strictEqual(controls.a.checked, true);
  GSRCollectiveProject._applyValues(controls, { a: 0 });
  assert.strictEqual(controls.a.checked, false);
});

// ── _buildManifest ───────────────────────────────────────────────────────
test('_buildManifest: assembles version, active track index, tracks, settings and view toggles', () => {
  global.AppState = {
    collectiveManager: { tracks: [{ id: 't1' }, { id: 't2' }] },
    activeTrackId: 't2',
    viewMode: 'collective',
    sliders: { gpsPeakLatency: { type: 'text', value: '2.0' } },
    contourControls: { gridResolution: { type: 'text', value: '40' } },
  };
  const elById = {
    btnToggleMapPeaks: { classList: { contains: () => true } },
  };
  global.document.getElementById = (id) => elById[id] || null;

  const manifest = GSRCollectiveProject._buildManifest([{ id: 't1', file: '01_a.csv' }, { id: 't2', file: '02_b.csv' }]);

  assert.strictEqual(manifest.version, GSRCollectiveProject.MANIFEST_VERSION);
  assert.strictEqual(manifest.activeTrackIndex, 1, 'activeTrackId t2 is at index 1');
  assert.strictEqual(manifest.viewMode, 'collective');
  assert.strictEqual(manifest.tracks.length, 2);
  assert.strictEqual(manifest.settings.sliders.gpsPeakLatency, '2.0');
  assert.strictEqual(manifest.settings.contour.gridResolution, '40');
  assert.strictEqual(manifest.viewToggles.btnToggleMapPeaks, true);
  assert.ok(typeof manifest.exportedAt === 'string' && manifest.exportedAt.length > 0);

  delete global.AppState;
  global.document.getElementById = () => null;
});

test('_buildManifest: activeTrackIndex is -1 when the active track is not found in the track list', () => {
  global.AppState = {
    collectiveManager: { tracks: [{ id: 't1' }] },
    activeTrackId: 'does-not-exist',
    viewMode: 'single',
    sliders: {},
    contourControls: {},
  };
  const manifest = GSRCollectiveProject._buildManifest([]);
  assert.strictEqual(manifest.activeTrackIndex, -1);
  delete global.AppState;
});

// ── exportProject (integration-style, mocked globals) ───────────────────
test('exportProject: shows an alert and does not throw when JSZip is unavailable', async () => {
  delete global.JSZip;
  let alerted = null;
  global.alert = (msg) => { alerted = msg; };
  global.AppState = { collectiveManager: { tracks: [{}] } };

  await GSRCollectiveProject.exportProject();
  assert.ok(alerted && alerted.includes('Zip support failed to load'));

  delete global.AppState;
  global.alert = () => {};
});

test('exportProject: shows an alert when there are no tracks to export', async () => {
  global.JSZip = class {};
  let alerted = null;
  global.alert = (msg) => { alerted = msg; };
  global.AppState = { collectiveManager: { tracks: [] } };

  await GSRCollectiveProject.exportProject();
  assert.ok(alerted && alerted.includes('No tracks loaded to export'));

  delete global.AppState;
  delete global.JSZip;
  global.alert = () => {};
});

test('exportProject: builds a suggestedName from the current date and hands the zip blob to ' +
  'GSRFileSaver.saveFile (regression test for a fixed bug: `suggestedName` was previously ' +
  'referenced without ever being declared in exportProject — see collective_project.js history ' +
  'and git blame around the `stamp` variable for context)', async () => {
  global.JSZip = class {
    constructor() { this.files = {}; }
    file(name, content) { this.files[name] = content; }
    async generateAsync() { return 'fake-blob'; }
  };
  global.GSRTrackManager = { saveActiveTrackParams() {}, saveActiveGpsParams() {} };
  let saveFileCalled = false;
  let savedName = null;
  global.GSRFileSaver = { saveFile: async (blob, name) => { saveFileCalled = true; savedName = name; return true; } };

  const track = {
    name: 'Morning Walk',
    color: '#005bc4',
    enabled: true,
    analyzer: {
      filtered: [1, 2, 3], // non-empty so the backfill analyze() branch is skipped
      exportToCSV: () => 'time,gsr\n0,1\n',
    },
    filterParams: {},
    gpsFilterParams: {},
    hasUnsavedLabels: true,
  };
  global.AppState = {
    collectiveManager: { tracks: [track] },
    activeTrackId: null,
    viewMode: 'single',
    sliders: {},
    contourControls: {},
  };
  let alertMsg = null;
  global.alert = (msg) => { alertMsg = msg; };

  await GSRCollectiveProject.exportProject();

  assert.strictEqual(alertMsg, null, 'export should succeed without hitting the catch-all error alert');
  assert.strictEqual(saveFileCalled, true);
  assert.match(savedName, /^biomapping_project_\d{4}-\d{2}-\d{2}\.zip$/);
  assert.strictEqual(track.hasUnsavedLabels, false, 'a successful save should clear the unsaved-labels flag');

  delete global.JSZip;
  delete global.GSRTrackManager;
  delete global.GSRFileSaver;
  delete global.AppState;
  global.alert = () => {};
});

// ── importProject ────────────────────────────────────────────────────────
test('importProject: returns without doing anything when no file is given', async () => {
  // Regression: importProject() checks `typeof JSZip === 'undefined'` BEFORE
  // `!file` (collective_project.js:181-185). global.JSZip must be defined
  // here or this test actually falls through the JSZip-missing branch
  // instead of the `!file` early-return it claims to cover — which is
  // exactly what happened before this fix, since the previous test's
  // cleanup deletes global.JSZip.
  global.JSZip = class {};
  let alerted = false;
  global.alert = () => { alerted = true; };

  await assert.doesNotReject(GSRCollectiveProject.importProject(null));
  assert.strictEqual(alerted, false, 'a null file should be a silent no-op, not an alert');

  delete global.JSZip;
  global.alert = () => {};
});

test('importProject: shows an alert and does not throw when JSZip is unavailable', async () => {
  delete global.JSZip;
  let alerted = null;
  global.alert = (msg) => { alerted = msg; };

  await GSRCollectiveProject.importProject({ name: 'project.zip' });
  assert.ok(alerted && alerted.includes('Zip support failed to load'));

  global.alert = () => {};
});

test('importProject: rejects a zip with no manifest.json as an error, surfaced via alert', async () => {
  global.JSZip = { loadAsync: async () => ({ file: () => null }) };
  global.AppState = { collectiveManager: { tracks: [] } };
  let alertMsg = null;
  global.alert = (msg) => { alertMsg = msg; };

  await GSRCollectiveProject.importProject({ name: 'bad.zip' });
  assert.ok(alertMsg && alertMsg.includes('manifest.json is missing'));

  delete global.JSZip;
  delete global.AppState;
  global.alert = () => {};
});

test('importProject: rejects a manifest with an empty/missing tracks array', async () => {
  global.JSZip = {
    loadAsync: async () => ({
      file: (name) => name === 'manifest.json' ? { async: async () => JSON.stringify({ tracks: [] }) } : null,
    }),
  };
  global.AppState = { collectiveManager: { tracks: [] } };
  let alertMsg = null;
  global.alert = (msg) => { alertMsg = msg; };

  await GSRCollectiveProject.importProject({ name: 'empty.zip' });
  assert.ok(alertMsg && alertMsg.includes('manifest has no tracks'));

  delete global.JSZip;
  delete global.AppState;
  global.alert = () => {};
});

test('importProject: prompts for confirmation before replacing an existing non-empty track list', async () => {
  let dialogCalled = false;
  global.GSRNotices = { dialog: async () => { dialogCalled = true; return null; } }; // decline — import should abort
  global.JSZip = { loadAsync: async () => ({ file: () => null }) };
  global.AppState = { collectiveManager: { tracks: [{ id: 'existing' }] } };

  await GSRCollectiveProject.importProject({ name: 'project.zip' });
  assert.strictEqual(dialogCalled, true, 'the replace-tracks dialog was shown');
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 1, 'declining the dialog should leave existing tracks untouched');

  delete global.JSZip;
  delete global.AppState;
  delete global.GSRNotices;
});
