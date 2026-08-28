/**
 * Unit tests for tracks.js (GSRTrackManager) — track library management:
 * file loading, track add/remove/switch/rename, and per-track parameter
 * persistence. This file previously had zero test coverage despite owning
 * exactly the class of "state that must be remembered to stay in sync" bug
 * class flagged in docs/archive/visualizer_architecture_refactor_plan.md §1.2.
 *
 * No jsdom — plain manual mocks for document/AppState/GSRAnalyzer/etc.,
 * matching the pattern established in tests/test_collective_project.js.
 *
 * GSRTrackManager.renderTrackList() itself builds a full <li> DOM tree per
 * track (checkboxes, rename inputs, edit/delete buttons with listeners) and
 * is NOT in this file's coverage list — it's pure DOM construction with no
 * state-correctness logic of its own. Several methods under test here
 * (switchActiveTrack, deleteTrack, startRenameTrack/cancelRenameTrack) call
 * it as a side effect, so it's stubbed to a no-op for the duration of this
 * file to keep those tests focused on the state changes that matter, rather
 * than on reproducing renderTrackList's DOM tree in a mock. This is a
 * deliberate isolation choice, not a coverage gap for the methods this task
 * asks for.
 *
 * Run: node --test tests/test_tracks.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

// ── Minimal global stubs so tracks.js's top-level/module references resolve
//    under plain Node (none of these exist outside a browser). ─────────────
global.window = global;
global.alert = (msg) => { global.__lastAlert = msg; };
global.confirm = () => true;
global.noLoop = () => {};
global.loop = () => {};
global.windowResized = () => {};
global.requestAnimationFrame = () => {};

global.GSR_CONST = require('./mock_constants.js');

global.GSREvents = { initializeLabels: () => {} };
global.GSRUI = {
  updatePeaksTable: () => {},
  updateStatsPanel: () => {},
  updateDeconvTruncationWarning: () => {},
  resetView: () => {},
  runAnalysis: () => {},
  refreshOsmControls: () => {},
  updateCollectiveMap: () => { global.__collectiveMapUpdated = true; },
  showUnsavedLabelsModal: (name, id, cb) => { global.__unsavedModal = { name, id, cb }; },
};
global.GSRRenderer = { drawPlaceholder: () => {} };

// deleteTrack() unconditionally calls saveActiveGpsParams(), which reads
// GSRStorage.readGpsSliderValues() — provide an inert default so tests that
// don't care about GPS-param persistence don't need to stub it themselves.
// Tests that DO care override global.GSRStorage and restore this default
// afterwards (see defaultGSRStorage below).
const defaultGSRStorage = { readGsrSliderValues: () => ({}), readGpsSliderValues: () => ({}) };
global.GSRStorage = defaultGSRStorage;

/**
 * Fake GSRAnalyzer — exposes exactly the surface tracks.js reads/writes:
 * .raw, .peaks, .importedFilterParams/.importedGpsFilterParams (parseCSV
 * output), .recordingStartTime, and the two date-formatting helpers used by
 * renderTrackList's meta line (unused here since renderTrackList is
 * stubbed, but kept for shape-completeness).
 *
 * parseCSV's behavior is driven entirely by the input text so each test can
 * choose success / "imported settings" / throw without needing a real CSV
 * parser:
 *   - text === '__THROW__'        -> throws (simulates a bad CSV)
 *   - text === '__IMPORTED__'     -> sets importedFilterParams/importedGpsFilterParams
 *   - anything else               -> plain two-point raw series
 */
class FakeAnalyzer {
  constructor() {
    this.raw = [];
    this.peaks = [];
    this.importedFilterParams = null;
    this.importedGpsFilterParams = null;
    this.recordingStartTime = 0;
    this.rawMinMaxCached = null;
  }
  parseCSV(text) {
    if (text === '__THROW__') throw new Error('bad csv');
    if (text === '__IMPORTED__') {
      this.importedFilterParams = { peakThreshold: 0.5, useDeconvolution: false };
      this.importedGpsFilterParams = { smoothing: 0.9 };
    }
    this.raw = [{ time: 0 }, { time: 42 }];
  }
  formatDateShort() { return 'Jan 1'; }
  formatTimeOnly() { return '00:00'; }
}
global.GSRAnalyzer = FakeAnalyzer;

function makeMockElement() {
  return {
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    dataset: {},
    addEventListener() {},
    appendChild() {},
    removeAttribute() {},
    setAttribute() {},
    querySelector() { return null; },
    focus() {},
    select() {},
    innerHTML: '',
    innerText: '',
  };
}

// Default document stub — getElementById returns null (all call sites that
// hit it in the covered methods guard with `if (el)`/`if (!el) return;`),
// createElement returns a generic mock element. Tests that need to observe
// a specific element (setFileStatus, startRenameTrack) override
// getElementById/querySelector locally and restore afterwards.
global.document = {
  getElementById: () => null,
  createElement: () => makeMockElement(),
  querySelector: () => null,
  head: { appendChild() {} },
  body: { appendChild() {} },
};

const { GSRTrackManager } = require('../tracks.js');
const { GSRCollectiveManager } = require('../collective_manager.js');

// renderTrackList is DOM construction, not state logic — see file header.
GSRTrackManager.renderTrackList = () => { global.__renderCount = (global.__renderCount || 0) + 1; };

/** Builds a fresh AppState-shaped object backed by a real GSRCollectiveManager. */
function freshAppState(overrides) {
  const base = {
    collectiveManager: new GSRCollectiveManager(),
    activeTrackId: null,
    analyzer: null,
    viewMode: 'single',
    mapManager: null,
    sliders: {},
    fileInput: null,
    dropZone: null,
    trackColorIndex: 0,
    trackColors: ['#005bc4', '#d10024', '#008f3c'],
    getNextTrackColor() {
      const c = this.trackColors[this.trackColorIndex];
      this.trackColorIndex = (this.trackColorIndex + 1) % this.trackColors.length;
      return c;
    },
    _renamingTrackId: null,
    // Mirrors the real AppState.on/emit (app_state.js) — deleteTrack()
    // notifies via 'trackRemoved' rather than calling consumers by name; see
    // the Phase 3 pilot note in docs/archive/visualizer_architecture_refactor_plan.md.
    // Production wires the real listeners once in sketch.js's setup(), which
    // this file deliberately never calls (see file header) — tests that care
    // about a 'trackRemoved' side effect register the matching listener
    // themselves, mirroring what setup() does.
    _listeners: {},
    on(event, fn) {
      (this._listeners[event] = this._listeners[event] || []).push(fn);
    },
    emit(event, ...args) {
      (this._listeners[event] || []).forEach(fn => fn(...args));
    },
  };
  return Object.assign(base, overrides);
}

function makeTrack(id, overrides) {
  return Object.assign({
    id,
    name: id,
    color: '#000000',
    enabled: true,
    analyzer: new FakeAnalyzer(),
    filterParams: {},
    gpsFilterParams: {},
  }, overrides);
}

function resetSpies() {
  global.__lastAlert = null;
  global.__collectiveMapUpdated = false;
  global.__unsavedModal = null;
  global.__renderCount = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// getActiveTracks
// ═══════════════════════════════════════════════════════════════════════

test('getActiveTracks: filters to only enabled tracks, delegating to the collective manager', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.collectiveManager.addTrack(makeTrack('t1', { enabled: true }));
  global.AppState.collectiveManager.addTrack(makeTrack('t2', { enabled: false }));
  global.AppState.collectiveManager.addTrack(makeTrack('t3', { enabled: true }));

  const active = GSRTrackManager.getActiveTracks();
  assert.deepStrictEqual(active.map(t => t.id), ['t1', 't3']);
  delete global.AppState;
});

test('getActiveTracks: empty when no tracks are loaded', () => {
  resetSpies();
  global.AppState = freshAppState();
  assert.deepStrictEqual(GSRTrackManager.getActiveTracks(), []);
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// switchActiveTrack
// ═══════════════════════════════════════════════════════════════════════

test('switchActiveTrack: makes the target track active, loads its analyzer, and computes totalDuration', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1');
  const t2 = makeTrack('t2');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.collectiveManager.addTrack(t2);
  t1.analyzer.parseCSV('anything'); // raw = [{time:0},{time:42}]

  GSRTrackManager.switchActiveTrack('t1');

  assert.strictEqual(global.AppState.activeTrackId, 't1');
  assert.strictEqual(global.AppState.analyzer, t1.analyzer);
  assert.strictEqual(global.AppState.totalDuration, 42);
  delete global.AppState;
});

test('switchActiveTrack: switching between two loaded tracks updates AppState.analyzer each time', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1');
  const t2 = makeTrack('t2');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.collectiveManager.addTrack(t2);

  GSRTrackManager.switchActiveTrack('t1');
  assert.strictEqual(global.AppState.activeTrackId, 't1');
  assert.strictEqual(global.AppState.analyzer, t1.analyzer);

  GSRTrackManager.switchActiveTrack('t2');
  assert.strictEqual(global.AppState.activeTrackId, 't2');
  assert.strictEqual(global.AppState.analyzer, t2.analyzer);
  delete global.AppState;
});

test('switchActiveTrack: an unknown trackId sets activeTrackId but leaves AppState.analyzer untouched (early return)', () => {
  // Documents current behavior: `AppState.activeTrackId = trackId;` runs
  // unconditionally before the `getTrack` lookup/guard, so a bogus id still
  // gets recorded as "active" even though nothing else about the switch
  // happens. Not asserted as a bug (not a crash, no test coverage asked for
  // a fix) — just pinned down since it's exactly the kind of state-drift
  // this file is supposed to guard against.
  resetSpies();
  global.AppState = freshAppState();
  const prevAnalyzer = global.AppState.analyzer;
  GSRTrackManager.switchActiveTrack('does-not-exist');
  assert.strictEqual(global.AppState.activeTrackId, 'does-not-exist');
  assert.strictEqual(global.AppState.analyzer, prevAnalyzer);
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// deleteTrack
// ═══════════════════════════════════════════════════════════════════════

test('deleteTrack: removing a non-active track leaves the active track untouched and drops only that entry', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1'), t2 = makeTrack('t2'), t3 = makeTrack('t3');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.collectiveManager.addTrack(t2);
  global.AppState.collectiveManager.addTrack(t3);
  global.AppState.activeTrackId = 't1';
  global.AppState.analyzer = t1.analyzer;

  GSRTrackManager.deleteTrack('t3');

  assert.deepStrictEqual(global.AppState.collectiveManager.tracks.map(t => t.id), ['t1', 't2']);
  assert.strictEqual(global.AppState.activeTrackId, 't1', 'active track pointer unchanged');
  assert.strictEqual(global.AppState.analyzer, t1.analyzer);
  delete global.AppState;
});

test('deleteTrack: removing the active track switches active to the first remaining track, no orphaned entries', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1'), t2 = makeTrack('t2'), t3 = makeTrack('t3');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.collectiveManager.addTrack(t2);
  global.AppState.collectiveManager.addTrack(t3);
  global.AppState.activeTrackId = 't2';
  global.AppState.analyzer = t2.analyzer;

  GSRTrackManager.deleteTrack('t2');

  assert.deepStrictEqual(global.AppState.collectiveManager.tracks.map(t => t.id), ['t1', 't3']);
  assert.strictEqual(global.AppState.activeTrackId, 't1', 'falls back to the new first track');
  assert.strictEqual(global.AppState.analyzer, t1.analyzer);
  delete global.AppState;
});

test('deleteTrack: removing the last remaining track clears activeTrackId and resets the analyzer', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.activeTrackId = 't1';
  global.AppState.analyzer = t1.analyzer;
  let clearAllCalled = false;
  global.AppState.mapManager = { clearAll() { clearAllCalled = true; } };
  // Mirrors the listener sketch.js's setup() registers for real (see
  // app_state.js's AppState.on/emit and the Phase 3 pilot note in
  // docs/archive/visualizer_architecture_refactor_plan.md) — this file never boots
  // the real app, so the test registers it itself.
  global.AppState.on('trackRemoved', () => {
    if (global.AppState.collectiveManager.tracks.length === 0) global.AppState.mapManager.clearAll();
  });

  GSRTrackManager.deleteTrack('t1');

  assert.deepStrictEqual(global.AppState.collectiveManager.tracks, []);
  assert.strictEqual(global.AppState.activeTrackId, null);
  assert.ok(global.AppState.analyzer instanceof FakeAnalyzer, 'a fresh analyzer replaces the deleted one');
  assert.notStrictEqual(global.AppState.analyzer, t1.analyzer);
  assert.strictEqual(clearAllCalled, true, 'map is cleared when the library goes empty');
  delete global.AppState;
});

test('deleteTrack: unknown trackId is a no-op', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.activeTrackId = 't1';

  GSRTrackManager.deleteTrack('does-not-exist');

  assert.deepStrictEqual(global.AppState.collectiveManager.tracks.map(t => t.id), ['t1']);
  assert.strictEqual(global.AppState.activeTrackId, 't1');
  delete global.AppState;
});

test('deleteTrack: a track with hasUnsavedLabels defers to the confirmation modal instead of deleting immediately', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1', { hasUnsavedLabels: true });
  const t2 = makeTrack('t2');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.collectiveManager.addTrack(t2);
  global.AppState.activeTrackId = 't1';

  GSRTrackManager.deleteTrack('t1');

  // Nothing removed yet — the modal callback hasn't fired.
  assert.deepStrictEqual(global.AppState.collectiveManager.tracks.map(t => t.id), ['t1', 't2']);
  assert.ok(global.__unsavedModal, 'showUnsavedLabelsModal was invoked');
  assert.strictEqual(global.__unsavedModal.id, 't1');
  assert.strictEqual(global.__unsavedModal.name, 't1');

  // Simulate the user confirming deletion from the modal.
  global.__unsavedModal.cb();
  assert.deepStrictEqual(global.AppState.collectiveManager.tracks.map(t => t.id), ['t2']);
  delete global.AppState;
});

test('deleteTrack: updates the collective map when in collective view mode', () => {
  resetSpies();
  global.AppState = freshAppState({ viewMode: 'collective' });
  const t1 = makeTrack('t1');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.activeTrackId = 't1';
  // Mirrors the listener sketch.js's setup() registers for real — see the
  // note on the previous deleteTrack test above.
  global.AppState.on('trackRemoved', () => {
    if (global.AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
  });

  GSRTrackManager.deleteTrack('t1');

  assert.strictEqual(global.__collectiveMapUpdated, true);
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// clearAllTracks
// ═══════════════════════════════════════════════════════════════════════

test('clearAllTracks: empties the track list, clears the active pointer, resets the analyzer and color index', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.collectiveManager.addTrack(makeTrack('t1'));
  global.AppState.collectiveManager.addTrack(makeTrack('t2'));
  global.AppState.activeTrackId = 't2';
  global.AppState.trackColorIndex = 2;
  let clearAllCalled = false;
  global.AppState.mapManager = { clearAll() { clearAllCalled = true; } };

  GSRTrackManager.clearAllTracks();

  assert.deepStrictEqual(global.AppState.collectiveManager.tracks, []);
  assert.strictEqual(global.AppState.activeTrackId, null);
  assert.ok(global.AppState.analyzer instanceof FakeAnalyzer);
  assert.strictEqual(global.AppState.trackColorIndex, 0, 'color palette restarts like a fresh page load');
  assert.strictEqual(clearAllCalled, true);
  delete global.AppState;
});

test('clearAllTracks: safe to call on an already-empty library (no mapManager)', () => {
  resetSpies();
  global.AppState = freshAppState();
  assert.doesNotThrow(() => GSRTrackManager.clearAllTracks());
  assert.deepStrictEqual(global.AppState.collectiveManager.tracks, []);
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// startRenameTrack / finishRenameTrack / cancelRenameTrack
// ═══════════════════════════════════════════════════════════════════════

/** Wires up document.querySelector to resolve `li[data-track-id="<id>"]` to a fake <li>. */
function mockRenameDom(trackId, initialName) {
  const nameSpan = makeMockElement();
  const nameInput = makeMockElement();
  nameInput.value = initialName;
  let focusCalled = false, selectCalled = false;
  nameInput.focus = () => { focusCalled = true; };
  nameInput.select = () => { selectCalled = true; };
  const item = makeMockElement();
  item.querySelector = (sel) => {
    if (sel === '.track-name') return nameSpan;
    if (sel === '.track-name-input') return nameInput;
    return null;
  };
  const prevQS = global.document.querySelector;
  global.document.querySelector = (sel) => (sel === `li[data-track-id="${trackId}"]` ? item : null);
  return {
    nameSpan, nameInput,
    focused: () => focusCalled,
    selected: () => selectCalled,
    restore: () => { global.document.querySelector = prevQS; },
  };
}

test('startRenameTrack: swaps the name span for the input, pre-fills and focuses it', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1', { name: 'Morning Walk' });
  global.AppState.collectiveManager.addTrack(t1);
  const dom = mockRenameDom('t1', 'Morning Walk');

  GSRTrackManager.startRenameTrack('t1');

  assert.strictEqual(global.AppState._renamingTrackId, 't1');
  assert.strictEqual(dom.nameSpan.style.display, 'none');
  assert.strictEqual(dom.nameInput.style.display, '');
  assert.strictEqual(dom.nameInput.value, 'Morning Walk');
  assert.strictEqual(dom.focused(), true);
  assert.strictEqual(dom.selected(), true);

  dom.restore();
  delete global.AppState;
});

test('startRenameTrack: unknown trackId is a no-op (never sets _renamingTrackId)', () => {
  resetSpies();
  global.AppState = freshAppState();
  GSRTrackManager.startRenameTrack('does-not-exist');
  assert.strictEqual(global.AppState._renamingTrackId, null);
  delete global.AppState;
});

test('startRenameTrack: sets _renamingTrackId even when the DOM row is missing (item not found)', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1');
  global.AppState.collectiveManager.addTrack(t1);
  // document.querySelector default stub returns null -> item not found branch.
  GSRTrackManager.startRenameTrack('t1');
  assert.strictEqual(global.AppState._renamingTrackId, 't1');
  delete global.AppState;
});

test('startRenameTrack: starting a rename while another is in progress cancels the first', () => {
  // `_renamingTrackId` ends up as 't2' either way (startRenameTrack
  // unconditionally overwrites it at the end), so that alone can't tell
  // apart "cancelRenameTrack() ran first" from "the cancel branch was
  // deleted". cancelRenameTrack() has one distinguishing side effect —
  // it calls renderTrackList() — so assert that too, via the __renderCount
  // spy already installed for renderTrackList (see resetSpies()/line 132).
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1'), t2 = makeTrack('t2');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.collectiveManager.addTrack(t2);
  global.AppState._renamingTrackId = 't1'; // pretend t1 is already being renamed
  const dom = mockRenameDom('t2', 't2');

  GSRTrackManager.startRenameTrack('t2');

  assert.strictEqual(global.AppState._renamingTrackId, 't2', 'rename moved to the new target');
  assert.strictEqual(global.__renderCount, 1, 'cancelRenameTrack() should have run for t1, re-rendering the list once');
  dom.restore();
  delete global.AppState;
});

test('finishRenameTrack: saves the new name and clears the renaming flag', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1', { name: 'Old Name' });
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState._renamingTrackId = 't1';

  GSRTrackManager.finishRenameTrack('t1', 'New Name');

  assert.strictEqual(t1.name, 'New Name');
  assert.strictEqual(global.AppState._renamingTrackId, null);
  delete global.AppState;
});

test('finishRenameTrack: does not itself trim/validate — callers (keydown/blur handlers) are responsible', () => {
  // finishRenameTrack has no validation of its own; trimming and the
  // "empty falls back to the old name" behavior happen at the DOM-handler
  // call site (`nameInput.value.trim() || track.name`, see renderTrackList),
  // not inside finishRenameTrack. Calling it directly with an empty string
  // therefore does set an empty name — documenting current behavior, not a bug.
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1', { name: 'Old Name' });
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState._renamingTrackId = 't1';

  GSRTrackManager.finishRenameTrack('t1', '');

  assert.strictEqual(t1.name, '');
  delete global.AppState;
});

test('finishRenameTrack: ignores a stale call for a track that is no longer the one being renamed', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1', { name: 'Original' });
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState._renamingTrackId = 't2'; // renaming moved on to a different track

  GSRTrackManager.finishRenameTrack('t1', 'Should Not Apply');

  assert.strictEqual(t1.name, 'Original');
  assert.strictEqual(global.AppState._renamingTrackId, 't2');
  delete global.AppState;
});

test('finishRenameTrack: unknown trackId is a no-op after clearing the renaming flag', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState._renamingTrackId = 'ghost';
  assert.doesNotThrow(() => GSRTrackManager.finishRenameTrack('ghost', 'X'));
  assert.strictEqual(global.AppState._renamingTrackId, null);
  delete global.AppState;
});

test('cancelRenameTrack: clears the renaming flag without touching the track name', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1', { name: 'Untouched' });
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState._renamingTrackId = 't1';

  GSRTrackManager.cancelRenameTrack();

  assert.strictEqual(global.AppState._renamingTrackId, null);
  assert.strictEqual(t1.name, 'Untouched', 'cancel leaves the original name intact');
  delete global.AppState;
});

test('cancelRenameTrack: no-op when nothing is being renamed', () => {
  resetSpies();
  global.AppState = freshAppState();
  assert.doesNotThrow(() => GSRTrackManager.cancelRenameTrack());
  assert.strictEqual(global.AppState._renamingTrackId, null);
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// saveActiveTrackParams / loadActiveTrackParams
// ═══════════════════════════════════════════════════════════════════════

test('saveActiveTrackParams: reads slider values via GSRStorage and stores them on the active track', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.activeTrackId = 't1';
  const params = { peakThreshold: 0.03, useDeconvolution: true };
  global.GSRStorage = { readGsrSliderValues: () => params };

  GSRTrackManager.saveActiveTrackParams();

  assert.strictEqual(t1.filterParams, params);
  global.GSRStorage = defaultGSRStorage;
  delete global.AppState;
});

test('saveActiveTrackParams: no-op when there is no active track', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.GSRStorage = { readGsrSliderValues: () => ({ x: 1 }) };
  assert.doesNotThrow(() => GSRTrackManager.saveActiveTrackParams());
  global.GSRStorage = defaultGSRStorage;
  delete global.AppState;
});

test('loadActiveTrackParams + saveActiveTrackParams round-trip a params object through the sliders', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.sliders = {
    peakThreshold: { value: null, dataset: {} },
    useDeconvolution: { checked: false, dataset: {} },
  };
  const t1 = makeTrack('t1', { filterParams: { peakThreshold: 0.045, useDeconvolution: false } });
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.activeTrackId = 't1';

  GSRTrackManager.loadActiveTrackParams(t1);

  assert.strictEqual(global.AppState.sliders.peakThreshold.value, 0.045);
  assert.strictEqual(global.AppState.sliders.useDeconvolution.checked, false);

  // Now round-trip back out via save.
  global.GSRStorage = {
    readGsrSliderValues: () => ({
      peakThreshold: global.AppState.sliders.peakThreshold.value,
      useDeconvolution: global.AppState.sliders.useDeconvolution.checked,
    }),
  };
  GSRTrackManager.saveActiveTrackParams();
  assert.deepStrictEqual(t1.filterParams, { peakThreshold: 0.045, useDeconvolution: false });

  global.GSRStorage = defaultGSRStorage;
  delete global.AppState;
});

test('loadActiveTrackParams: when useDeconvolution is on, shape* keys (except shapeMinSnr) go to dataset.customValue instead of .value', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.sliders = {
    shapeMinRiseTime: { value: 1, dataset: {} },
    shapeMinSnr: { value: 1, dataset: {} },
    peakThreshold: { value: 1, dataset: {} },
    useDeconvolution: { checked: false, dataset: {} },
  };
  const params = {
    useDeconvolution: true,
    shapeMinRiseTime: 2.5,
    shapeMinSnr: 4.0,
    peakThreshold: 0.09,
  };

  GSRTrackManager.loadActiveTrackParams({ filterParams: params });

  assert.strictEqual(global.AppState.sliders.shapeMinRiseTime.dataset.customValue, 2.5, 'shape* -> dataset.customValue');
  assert.strictEqual(global.AppState.sliders.shapeMinRiseTime.value, 1, '.value left untouched');
  assert.strictEqual(global.AppState.sliders.shapeMinSnr.value, 4.0, 'shapeMinSnr is excluded from the dataset-only rule');
  assert.strictEqual(global.AppState.sliders.shapeMinSnr.dataset.customValue, undefined);
  assert.strictEqual(global.AppState.sliders.peakThreshold.value, 0.09, 'non-shape keys always go to .value');
  assert.strictEqual(global.AppState.sliders.useDeconvolution.checked, true);
  delete global.AppState;
});

test('loadActiveTrackParams: clears a stale dataset.customValue when useDeconvolution is off', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.sliders = {
    shapeMinRiseTime: { value: 1, dataset: { customValue: 9.9 } },
  };
  GSRTrackManager.loadActiveTrackParams({ filterParams: { shapeMinRiseTime: 3.0, useDeconvolution: false } });
  assert.strictEqual(global.AppState.sliders.shapeMinRiseTime.value, 3.0);
  assert.strictEqual('customValue' in global.AppState.sliders.shapeMinRiseTime.dataset, false);
  delete global.AppState;
});

test('loadActiveTrackParams: no-op for a null track or a track with no filterParams', () => {
  resetSpies();
  global.AppState = freshAppState();
  assert.doesNotThrow(() => GSRTrackManager.loadActiveTrackParams(null));
  assert.doesNotThrow(() => GSRTrackManager.loadActiveTrackParams({}));
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// saveActiveGpsParams / loadActiveGpsParams
// ═══════════════════════════════════════════════════════════════════════

test('saveActiveGpsParams: reads GPS slider values via GSRStorage and stores them on the active track', () => {
  resetSpies();
  global.AppState = freshAppState();
  const t1 = makeTrack('t1');
  global.AppState.collectiveManager.addTrack(t1);
  global.AppState.activeTrackId = 't1';
  const gpsParams = { smoothing: 0.8, kalmanR: 12 };
  global.GSRStorage = { readGpsSliderValues: () => gpsParams };

  GSRTrackManager.saveActiveGpsParams();

  assert.strictEqual(t1.gpsFilterParams, gpsParams);
  global.GSRStorage = defaultGSRStorage;
  delete global.AppState;
});

test('saveActiveGpsParams: no-op when there is no active track', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.GSRStorage = { readGpsSliderValues: () => ({}) };
  assert.doesNotThrow(() => GSRTrackManager.saveActiveGpsParams());
  global.GSRStorage = defaultGSRStorage;
  delete global.AppState;
});

test('loadActiveGpsParams: maps known GPS keys to their dedicated slider names', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.sliders = {
    gpsSmoothing: { value: null },
    gpsKalmanR: { value: null },
    gpsMaxHdop: { value: null },
    gpsMaxSpeed: { value: null },
    gpsRDP: { value: null },
    gpsDownsample: { value: null },
    gpsTrackWeight: { value: null },
    gpsPeakLatency: { value: null },
  };
  const gpsParams = {
    smoothing: 0.5, kalmanR: 10, maxHdop: 3.0, maxSpeed: 3.0,
    rdpTolerance: 1.5, downsample: true, trackWeight: 5, peakLatency: 2.0,
  };

  GSRTrackManager.loadActiveGpsParams({ gpsFilterParams: gpsParams });

  assert.strictEqual(global.AppState.sliders.gpsSmoothing.value, 0.5);
  assert.strictEqual(global.AppState.sliders.gpsKalmanR.value, 10);
  assert.strictEqual(global.AppState.sliders.gpsMaxHdop.value, 3.0);
  assert.strictEqual(global.AppState.sliders.gpsMaxSpeed.value, 3.0);
  assert.strictEqual(global.AppState.sliders.gpsRDP.value, 1.5, 'rdpTolerance -> gpsRDP (irregular mapping)');
  assert.strictEqual(global.AppState.sliders.gpsDownsample.value, true);
  assert.strictEqual(global.AppState.sliders.gpsTrackWeight.value, 5);
  assert.strictEqual(global.AppState.sliders.gpsPeakLatency.value, 2.0);
  delete global.AppState;
});

test('loadActiveGpsParams: falls back to the computed "gps"+CapKey slider name, then to the bare key', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.sliders = {
    gpsFoo: { value: null },   // computed fallback: 'foo' -> 'gpsFoo'
    bar: { value: null },      // no gpsBar slider exists -> falls back to bare 'bar'
  };

  GSRTrackManager.loadActiveGpsParams({ gpsFilterParams: { foo: 1, bar: 2, missing: 3 } });

  assert.strictEqual(global.AppState.sliders.gpsFoo.value, 1);
  assert.strictEqual(global.AppState.sliders.bar.value, 2);
  // 'missing' has neither gpsMissing nor missing slider -> silently skipped, no throw.
  delete global.AppState;
});

test('loadActiveGpsParams: undefined values in gpsFilterParams are skipped, not written as undefined', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.sliders = { gpsSmoothing: { value: 'sentinel' } };
  GSRTrackManager.loadActiveGpsParams({ gpsFilterParams: { smoothing: undefined } });
  assert.strictEqual(global.AppState.sliders.gpsSmoothing.value, 'sentinel');
  delete global.AppState;
});

test('loadActiveGpsParams: no-op for a null track or a track with no gpsFilterParams', () => {
  resetSpies();
  global.AppState = freshAppState();
  assert.doesNotThrow(() => GSRTrackManager.loadActiveGpsParams(null));
  assert.doesNotThrow(() => GSRTrackManager.loadActiveGpsParams({}));
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// setFileStatus
// ═══════════════════════════════════════════════════════════════════════

function mockFileStatusDom() {
  const dot = makeMockElement();
  const text = makeMockElement();
  const el = makeMockElement();
  el.querySelector = (sel) => (sel === '.status-dot' ? dot : sel === '.status-text' ? text : null);
  const prevGetById = global.document.getElementById;
  global.document.getElementById = (id) => (id === 'fileStatus' ? el : null);
  return { dot, text, restore: () => { global.document.getElementById = prevGetById; } };
}

test('setFileStatus: "success" sets the dot class and status text', () => {
  resetSpies();
  const dom = mockFileStatusDom();
  GSRTrackManager.setFileStatus('success', '3 Tracks Loaded');
  assert.strictEqual(dom.dot.className, 'status-dot success');
  assert.strictEqual(dom.text.innerText, '3 Tracks Loaded');
  dom.restore();
});

test('setFileStatus: "warning" sets the dot class and status text', () => {
  resetSpies();
  const dom = mockFileStatusDom();
  GSRTrackManager.setFileStatus('warning', 'No File Loaded');
  assert.strictEqual(dom.dot.className, 'status-dot warning');
  assert.strictEqual(dom.text.innerText, 'No File Loaded');
  dom.restore();
});

test('setFileStatus: forwards an arbitrary status type verbatim into the class name (e.g. "error")', () => {
  resetSpies();
  const dom = mockFileStatusDom();
  GSRTrackManager.setFileStatus('error', 'Something broke');
  assert.strictEqual(dom.dot.className, 'status-dot error');
  assert.strictEqual(dom.text.innerText, 'Something broke');
  dom.restore();
});

test('setFileStatus: does nothing (does not throw) when the #fileStatus element is missing', () => {
  resetSpies();
  const prevGetById = global.document.getElementById;
  global.document.getElementById = () => null;
  assert.doesNotThrow(() => GSRTrackManager.setFileStatus('success', 'x'));
  global.document.getElementById = prevGetById;
});

// ═══════════════════════════════════════════════════════════════════════
// handleFileSelect / handleIncomingFiles / loadFilesSequentially
//
// These load files via `new FileReader()` + `.readAsText()`. Real FileReader
// (and the browser File object it reads) doesn't exist in plain Node, so a
// minimal FileReader stand-in is installed that synchronously invokes
// `onload` with the mock file's `.content` as the read result — enough to
// exercise tracks.js's own control flow (one CSV per file, sequential
// chaining, error handling) without needing a real File/Blob or jsdom.
// ═══════════════════════════════════════════════════════════════════════

global.FileReader = class {
  readAsText(file) {
    if (typeof this.onload === 'function') {
      this.onload({ target: { result: file.content !== undefined ? file.content : '' } });
    }
  }
};

test('loadFilesSequentially: parses each file, adds a track, and switches active track to the newest one', () => {
  resetSpies();
  global.AppState = freshAppState();
  const files = [{ name: 'walk1.csv', content: 'time,gsr\n0,1\n' }];

  GSRTrackManager.loadFilesSequentially(files);

  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 1);
  const track = global.AppState.collectiveManager.tracks[0];
  assert.strictEqual(track.name, 'walk1.csv');
  assert.strictEqual(track.enabled, true);
  assert.strictEqual(track.settingsSource, 'standard');
  assert.strictEqual(global.AppState.activeTrackId, track.id, 'newly loaded track becomes active');
  delete global.AppState;
});

test('loadFilesSequentially: processes multiple files in order, each getting the next palette color', () => {
  resetSpies();
  global.AppState = freshAppState();
  const files = [
    { name: 'a.csv', content: 'x' },
    { name: 'b.csv', content: 'y' },
  ];

  GSRTrackManager.loadFilesSequentially(files);

  const tracks = global.AppState.collectiveManager.tracks;
  assert.strictEqual(tracks.length, 2);
  assert.deepStrictEqual(tracks.map(t => t.name), ['a.csv', 'b.csv']);
  assert.notStrictEqual(tracks[0].color, tracks[1].color, 'each track gets the next palette color');
  assert.strictEqual(global.AppState.activeTrackId, tracks[1].id, 'last-loaded file ends up active');
  delete global.AppState;
});

test('loadFilesSequentially: a processed CSV with imported params sets settingsSource to "imported" and uses those params', () => {
  resetSpies();
  global.AppState = freshAppState();
  GSRTrackManager.loadFilesSequentially([{ name: 'processed.csv', content: '__IMPORTED__' }]);

  const track = global.AppState.collectiveManager.tracks[0];
  assert.strictEqual(track.settingsSource, 'imported');
  assert.strictEqual(track.filterParams.peakThreshold, 0.5);
  assert.strictEqual(track.gpsFilterParams.smoothing, 0.9);
  delete global.AppState;
});

test('loadFilesSequentially: a parse error alerts, skips that file, and continues to the next one', () => {
  resetSpies();
  global.AppState = freshAppState();
  const files = [
    { name: 'bad.csv', content: '__THROW__' },
    { name: 'good.csv', content: 'ok' },
  ];

  GSRTrackManager.loadFilesSequentially(files);

  assert.ok(global.__lastAlert && global.__lastAlert.includes('bad.csv'), 'alert fired for the bad file');
  const tracks = global.AppState.collectiveManager.tracks;
  assert.strictEqual(tracks.length, 1, 'only the good file produced a track');
  assert.strictEqual(tracks[0].name, 'good.csv');
  delete global.AppState;
});

test('loadFilesSequentially: clears AppState.fileInput.value once all files are processed', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.fileInput = { value: 'stale-path' };
  GSRTrackManager.loadFilesSequentially([{ name: 'a.csv', content: 'x' }]);
  assert.strictEqual(global.AppState.fileInput.value, '');
  delete global.AppState;
});

test('handleFileSelect: forwards the selected files into handleIncomingFiles', () => {
  resetSpies();
  global.AppState = freshAppState();
  const e = { target: { files: [{ name: 'picked.csv', content: 'x' }] } };

  GSRTrackManager.handleFileSelect(e);

  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 1);
  assert.strictEqual(global.AppState.collectiveManager.tracks[0].name, 'picked.csv');
  delete global.AppState;
});

test('handleFileSelect: no-op when the file input has zero files', () => {
  resetSpies();
  global.AppState = freshAppState();
  const e = { target: { files: [] } };
  GSRTrackManager.handleFileSelect(e);
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 0);
  delete global.AppState;
});

test('handleFileSelect: shows the restore-fullscreen pill and resets the flag when a browser-FS save was pending', () => {
  resetSpies();
  global.AppState = freshAppState();
  let pillShown = false;
  // _showRestoreFsPill does real DOM + an 8s setTimeout — irrelevant to
  // handleFileSelect's own logic (whether it *decides* to call it), so it's
  // stubbed here rather than driven for real.
  const originalPill = GSRTrackManager._showRestoreFsPill;
  GSRTrackManager._showRestoreFsPill = () => { pillShown = true; };
  GSRTrackManager._browserFsSave = true;

  const e = { target: { files: [{ name: 'a.csv', content: 'x' }] } };
  GSRTrackManager.handleFileSelect(e);

  assert.strictEqual(pillShown, true);
  assert.strictEqual(GSRTrackManager._browserFsSave, false, 'flag reset before processing');
  GSRTrackManager._showRestoreFsPill = originalPill;
  delete global.AppState;
});

test('handleIncomingFiles: a lone .zip is routed to GSRCollectiveProject.importProject, not loadFilesSequentially', () => {
  resetSpies();
  global.AppState = freshAppState();
  global.AppState.fileInput = { value: 'stale' };
  let importedFile = null;
  global.GSRCollectiveProject = { importProject: (f) => { importedFile = f; } };

  GSRTrackManager.handleIncomingFiles([{ name: 'project.zip' }]);

  assert.strictEqual(importedFile.name, 'project.zip');
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 0, 'no CSV loading happened');
  assert.strictEqual(global.AppState.fileInput.value, '');
  delete global.GSRCollectiveProject;
  delete global.AppState;
});

test('handleIncomingFiles: a .zip mixed with loose CSVs wins — the CSVs are ignored entirely', () => {
  resetSpies();
  global.AppState = freshAppState();
  let importedFile = null;
  global.GSRCollectiveProject = { importProject: (f) => { importedFile = f; } };

  GSRTrackManager.handleIncomingFiles([
    { name: 'walk.csv', content: 'x' },
    { name: 'project.zip' },
  ]);

  assert.strictEqual(importedFile.name, 'project.zip');
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 0);
  delete global.GSRCollectiveProject;
  delete global.AppState;
});

test('handleIncomingFiles: non-zip files are loaded as tracks via loadFilesSequentially', () => {
  resetSpies();
  global.AppState = freshAppState();
  GSRTrackManager.handleIncomingFiles([{ name: 'walk.csv', content: 'x' }]);
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 1);
  assert.strictEqual(global.AppState.collectiveManager.tracks[0].name, 'walk.csv');
  delete global.AppState;
});

// ═══════════════════════════════════════════════════════════════════════
// loadDefaultTrack
// ═══════════════════════════════════════════════════════════════════════

async function flush() {
  // Let the fetch().then().then() promise chain (and its .catch) settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('loadDefaultTrack: fetches, parses, and loads the demo CSV as a new active track', async () => {
  resetSpies();
  global.AppState = freshAppState();
  global.fetch = async () => ({ ok: true, text: async () => 'time,gsr\n0,1\n0.1,2\n' });

  GSRTrackManager.loadDefaultTrack();
  await flush();

  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 1);
  const track = global.AppState.collectiveManager.tracks[0];
  assert.strictEqual(track.name, 'default_processed.csv');
  assert.strictEqual(global.AppState.activeTrackId, track.id);
  delete global.fetch;
  delete global.AppState;
});

test('loadDefaultTrack: an HTTP error alerts instead of throwing, and no track is added', async () => {
  resetSpies();
  global.AppState = freshAppState();
  global.fetch = async () => ({ ok: false, status: 404 });

  assert.doesNotThrow(() => GSRTrackManager.loadDefaultTrack());
  await flush();

  assert.ok(global.__lastAlert && global.__lastAlert.includes('Error loading demo data'), `got: ${global.__lastAlert}`);
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 0);
  delete global.fetch;
  delete global.AppState;
});

test('loadDefaultTrack: a network-level fetch rejection alerts instead of throwing', async () => {
  resetSpies();
  global.AppState = freshAppState();
  global.fetch = async () => { throw new Error('network down'); };

  assert.doesNotThrow(() => GSRTrackManager.loadDefaultTrack());
  await flush();

  assert.ok(global.__lastAlert && global.__lastAlert.includes('network down'), `got: ${global.__lastAlert}`);
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 0);
  delete global.fetch;
  delete global.AppState;
});

test('loadDefaultTrack: a CSV parse failure alerts with the "Error parsing demo data" message, not the fetch-failure one', async () => {
  resetSpies();
  global.AppState = freshAppState();
  global.fetch = async () => ({ ok: true, text: async () => '__THROW__' });

  GSRTrackManager.loadDefaultTrack();
  await flush();

  assert.ok(global.__lastAlert && global.__lastAlert.includes('Error parsing demo data'), `got: ${global.__lastAlert}`);
  assert.strictEqual(global.AppState.collectiveManager.tracks.length, 0);
  delete global.fetch;
  delete global.AppState;
});
