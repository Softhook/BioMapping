/**
 * Unit tests for storage.js (GSRStorage, sliderVal) — settings management,
 * localStorage-adjacent preset import/export, and slider-value
 * parsing/fallback logic.
 *
 * Run: node --test tests/test_storage.js  (or `npm test` for the whole suite)
 */

const assert = require('node:assert');
const test = require('node:test');

const GSR_CONST_MOCK = require('./mock_constants.js');

// storage.js calls alert(...) directly in a few places (export/import error
// paths) and Node has no `alert` global — stub it once here and let
// individual tests inspect calls via `alertCalls`.
let alertCalls = [];
global.alert = (msg) => {
  alertCalls.push(msg);
};

// localStorage isn't used directly by storage.js today, but stub it
// defensively per the task brief in case any code path touches it.
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { GSRStorage, sliderVal } = require('../src/ui/storage.mjs');

// storage.mjs holds real static imports of AppState/GSR_CONST/GSREvents/
// GSRTrackManager/GSRUI/GSRFileSaver — a `global.X = {...}` full-replacement
// shadow (this file's old bare-global pattern) no longer reaches any of
// them (ES-module migration), so every reset/override below mutates the
// REAL singleton's own properties in place instead. `delete
// global.GSREvents` (etc.) used to simulate "not loaded yet" for storage.js's
// `typeof X !== 'undefined'` guards; those guards are now structurally
// always-true (a real import can't be undefined), so the equivalent reset
// is an EMPTY object — the guard's second half (`typeof X.method ===
// 'function'`) still gates correctly on a method that doesn't exist.
const { AppState: RealAppState } = require('../src/core/app_state.mjs');
const { GSR_CONST: RealGSRConst } = require('../src/core/constants.mjs');
const { GSREvents: RealGSREvents } = require('../src/ui/events.mjs');
const {
  GSRTrackManager: RealGSRTrackManager,
} = require('../src/ui/tracks.mjs');
const { GSRUI: RealGSRUI } = require('../src/ui/ui.mjs');
const {
  GSRFileSaver: RealGSRFileSaver,
} = require('../src/core/file_saver.mjs');

function setSingletonShape(target, shape) {
  for (const k of Object.keys(target)) delete target[k];
  return Object.assign(target, shape);
}

function el(value) {
  return { value: String(value) };
}

function resetGlobals() {
  alertCalls = [];
  global.AppState = setSingletonShape(RealAppState, {});
  global.GSR_CONST = setSingletonShape(
    RealGSRConst,
    JSON.parse(JSON.stringify(GSR_CONST_MOCK)),
  );
  setSingletonShape(RealGSREvents, {});
  setSingletonShape(RealGSRTrackManager, {});
  setSingletonShape(RealGSRUI, {});
  setSingletonShape(RealGSRFileSaver, {});
}

// ── sliderVal() ──────────────────────────────────────────────────────────

test('sliderVal: returns fallback unchanged when el is null and fallback is non-string', () => {
  assert.strictEqual(sliderVal(null, 42), 42);
});

test('sliderVal: parses string fallback through fn when el is null', () => {
  assert.strictEqual(sliderVal(null, '3.5'), 3.5);
  assert.strictEqual(sliderVal(null, '7', parseInt), 7);
});

test('sliderVal: reads and parses el.value with default parseFloat', () => {
  assert.strictEqual(sliderVal(el('2.75'), 0), 2.75);
});

test('sliderVal: uses custom parser fn (parseInt) when supplied', () => {
  assert.strictEqual(sliderVal(el('9.9'), 0, parseInt), 9);
});

// ── GSRStorage.readGsrSliderValues() ────────────────────────────────────

test('readGsrSliderValues: returns null when AppState.sliders is missing', () => {
  resetGlobals();
  global.AppState = {};
  assert.strictEqual(GSRStorage.readGsrSliderValues(), null);
});

test('readGsrSliderValues: returns null when the mandatory medianSize slider is missing', () => {
  resetGlobals();
  global.AppState.sliders = { lpfWindow: el(1) };
  assert.strictEqual(GSRStorage.readGsrSliderValues(), null);
});

test('readGsrSliderValues: parses mandatory sliders and falls back to GSR_DEFAULT for optional ones', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(3),
    lpfWindow: el(0.5),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
  };
  const result = GSRStorage.readGsrSliderValues();
  const D = GSR_CONST_MOCK.GSR_DEFAULT;
  const PS = GSR_CONST_MOCK.PEAK_SHAPE;

  assert.strictEqual(result.medianSize, 3);
  assert.strictEqual(result.lpfWindow, 0.5);
  assert.strictEqual(result.tonicMethod, 'lpf');
  assert.strictEqual(result.tonicWindow, 45);
  assert.strictEqual(result.peakThreshold, 0.02);

  // Optional sliders absent -> fall back to GSR_DEFAULT / PEAK_SHAPE.
  assert.strictEqual(result.minPeakQuality, D.minPeakQuality);
  assert.strictEqual(result.hotspotPercentile, D.hotspotPercentile);
  assert.strictEqual(result.shapeMinSnr, PS.MIN_SNR);
  assert.strictEqual(result.useDeconvolution, false);
  assert.strictEqual(result.usePeakProminence, false);
});

test('readGsrSliderValues: hotspotPercentile is divided by 100 when read from the (0-100) slider', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
    hotspotPercentile: el(5), // 5% on the slider
  };
  const result = GSRStorage.readGsrSliderValues();
  assert.strictEqual(result.hotspotPercentile, 0.05);
});

test('readGsrSliderValues: useDeconvolution reflects checkbox .checked state', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
    useDeconvolution: { checked: true },
  };
  assert.strictEqual(GSRStorage.readGsrSliderValues().useDeconvolution, true);
});

test('readGsrSliderValues: usePeakProminence reflects checkbox .checked state', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
    usePeakProminence: { checked: true },
  };
  assert.strictEqual(GSRStorage.readGsrSliderValues().usePeakProminence, true);
});

test('readGsrSliderValues: shapeMinSnr is read straight from the slider value', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
    shapeMinSnr: { value: '2.2', dataset: {} },
  };
  const result = GSRStorage.readGsrSliderValues();
  assert.strictEqual(result.shapeMinSnr, 2.2);
});

// ── GSRStorage.readGpsSliderValues() ────────────────────────────────────

test('readGpsSliderValues: returns null (not a throw) when AppState.sliders is undefined', () => {
  // Regression test: unlike readGsrSliderValues/readContourSliderValues, this
  // used to have no `!S` guard and would throw a TypeError reading S.gpsMaxHdop
  // off undefined — which broke exportPreset()'s "no active slider settings"
  // alert path when sliders hadn't been wired up yet.
  resetGlobals();
  assert.strictEqual(GSRStorage.readGpsSliderValues(), null);
});

test('readGpsSliderValues: falls back to GPS_DEFAULT for every field when sliders are absent', () => {
  resetGlobals();
  global.AppState.sliders = {};
  const result = GSRStorage.readGpsSliderValues();
  const D = GSR_CONST_MOCK.GPS_DEFAULT;
  assert.strictEqual(result.maxHdop, D.maxHdop);
  assert.strictEqual(result.maxSpeed, D.maxSpeed);
  assert.strictEqual(result.rdpTolerance, D.rdpTolerance);
  assert.strictEqual(result.downsample, D.downsample ? 1 : 0);
  assert.strictEqual(result.trackWeight, D.trackWeight);
  assert.strictEqual(result.peakLatency, D.peakLatency);
  assert.strictEqual(result.placeMergeDistance, 35);
  assert.strictEqual(result.maxArousalPlaces, 20);
});

test('readGpsSliderValues: reads values from present sliders', () => {
  resetGlobals();
  global.AppState.sliders = {
    gpsMaxHdop: el(5),
    gpsMaxSpeed: el(4),
    gpsRDP: el(1.5),
    gpsDownsample: el(1),
    gpsTrackWeight: el(8),
    gpsPeakLatency: el(3),
    placeMergeDistance: el(50),
    maxArousalPlaces: el(12),
  };
  const result = GSRStorage.readGpsSliderValues();
  assert.strictEqual(result.maxHdop, 5);
  assert.strictEqual(result.maxSpeed, 4);
  assert.strictEqual(result.rdpTolerance, 1.5);
  assert.strictEqual(result.downsample, 1);
  assert.strictEqual(result.trackWeight, 8);
  assert.strictEqual(result.peakLatency, 3);
  assert.strictEqual(result.placeMergeDistance, 50);
  assert.strictEqual(result.maxArousalPlaces, 12);
});

// ── GSRStorage.readContourSliderValues() ────────────────────────────────

test('readContourSliderValues: returns null when contourControls or gridResolution is missing', () => {
  resetGlobals();
  assert.strictEqual(GSRStorage.readContourSliderValues(), null);
  global.AppState.contourControls = { contourCount: el(10) };
  assert.strictEqual(GSRStorage.readContourSliderValues(), null);
});

test('readContourSliderValues: parses all contour surface sliders', () => {
  resetGlobals();
  global.AppState.contourControls = {
    gridResolution: el(40),
    contourCount: el(8),
    isolationRadius: el(50),
    idwExponent: el(2),
    surfaceOpacity: el(0.4),
    hillshadeStrength: el(0.3),
  };
  const result = GSRStorage.readContourSliderValues();
  assert.deepStrictEqual(result, {
    gridResolution: 40,
    contourCount: 8,
    isolationRadius: 50,
    idwExponent: 2,
    peakPreservation: global.GSR_CONST.COLLECTIVE.peakPreservation,
    coverageWeighting: global.GSR_CONST.COLLECTIVE.coverageWeighting,
    surfaceOpacity: 0.4,
    hillshadeStrength: 0.3,
  });
});

// ── GSRStorage.buildGpsParams() ──────────────────────────────────────────

test('buildGpsParams: builds the renderer-facing subset and converts downsample to boolean', () => {
  resetGlobals();
  global.AppState.sliders = {
    gpsMaxHdop: el(5),
    gpsMaxSpeed: el(4),
    gpsRDP: el(1.5),
    gpsDownsample: el(1),
    gpsPeakLatency: el(3),
  };
  const params = GSRStorage.buildGpsParams();
  assert.strictEqual(params.downsample, true);
  assert.strictEqual(params.maxHdop, 5);
  assert.strictEqual(params.maxSpeed, 4);
  assert.strictEqual(params.rdpTolerance, 1.5);
  assert.strictEqual(params.peakLatency, 3);
  assert.strictEqual(
    params.trackWeight,
    GSR_CONST_MOCK.GPS_DEFAULT.trackWeight,
  );
});

test('buildGpsParams: downsample=0 maps to false', () => {
  resetGlobals();
  global.AppState.sliders = { gpsDownsample: el(0) };
  assert.strictEqual(GSRStorage.buildGpsParams().downsample, false);
});

// ── GSRStorage.exportPreset() / downloadPresetJson() ────────────────────

test('exportPreset: alerts and does not throw when no active slider settings are found', async () => {
  resetGlobals();
  global.AppState.sliders = {}; // readGsrSliderValues() -> null (no medianSize)
  await GSRStorage.exportPreset('mytest');
  assert.strictEqual(alertCalls.length, 1);
  assert.match(alertCalls[0], /No active slider settings/);
});

test('exportPreset: alerts (does not throw) when AppState.sliders is entirely undefined', async () => {
  // Regression test: readGpsSliderValues() used to throw a TypeError here
  // instead of returning null, crashing exportPreset() before it could reach
  // its own `if (!gsr || !gps)` guard.
  resetGlobals();
  await GSRStorage.exportPreset('mytest');
  assert.strictEqual(alertCalls.length, 1);
  assert.match(alertCalls[0], /No active slider settings/);
});

test('exportPreset: builds a preset and hands it to downloadPresetJson via GSRFileSaver.saveFile', async () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
  };
  global.AppState.contourControls = {
    gridResolution: el(40),
    contourCount: el(8),
    isolationRadius: el(50),
    idwExponent: el(2),
    surfaceOpacity: el(0.4),
  };
  global.AppState.activeTrackId = null;

  let saved = null;
  global.GSRFileSaver = setSingletonShape(RealGSRFileSaver, {
    saveFile: async (jsonStr, suggestedName) => {
      saved = { jsonStr, suggestedName };
    },
  });

  await GSRStorage.exportPreset('My Custom Name');

  assert.strictEqual(alertCalls.length, 0);
  assert.ok(saved, 'GSRFileSaver.saveFile should have been called');
  const parsed = JSON.parse(saved.jsonStr);
  assert.strictEqual(parsed.type, 'BioMappingPreset');
  assert.strictEqual(parsed.name, 'My Custom Name');
  assert.ok(parsed.gsr && parsed.gps && parsed.contour);
  assert.match(
    saved.suggestedName,
    /^biomapping_preset_My_Custom_Name_\d{4}-\d{2}-\d{2}\.json$/,
  );
});

test('exportPreset: falls back to the active track name (minus extension) when no filenameBase is given', async () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
  };
  global.AppState.activeTrackId = 'trk1';
  global.AppState.collectiveManager = {
    getTrack: (id) => (id === 'trk1' ? { name: 'session_walk.csv' } : null),
  };
  let saved = null;
  global.GSRFileSaver = setSingletonShape(RealGSRFileSaver, {
    saveFile: async (jsonStr, suggestedName) => {
      saved = { jsonStr, suggestedName };
    },
  });

  await GSRStorage.exportPreset();

  const parsed = JSON.parse(saved.jsonStr);
  assert.strictEqual(parsed.name, 'session_walk');
});

test("downloadPresetJson: sanitizes the filename base and stamps today's date", async () => {
  resetGlobals();
  let saved = null;
  global.GSRFileSaver = setSingletonShape(RealGSRFileSaver, {
    saveFile: async (jsonStr, suggestedName) => {
      saved = { jsonStr, suggestedName };
    },
  });
  await GSRStorage.downloadPresetJson({ a: 1 }, 'Weird Name!! #1');
  assert.match(
    saved.suggestedName,
    /^biomapping_preset_Weird_Name____1_\d{4}-\d{2}-\d{2}\.json$/,
  );
  assert.deepStrictEqual(JSON.parse(saved.jsonStr), { a: 1 });
});

// ── GSRStorage.importPresetFile() ────────────────────────────────────────

// Minimal manual FileReader stub — storage.js only calls readAsText() and
// relies on onload(event) with event.target.result holding the text.
class FakeFileReader {
  readAsText(file) {
    setTimeout(() => {
      if (file.__error) {
        if (this.onerror) this.onerror(file.__error);
        return;
      }
      this.onload({ target: { result: file.__content } });
    }, 0);
  }
}

test('importPresetFile: does nothing when file is falsy', () => {
  resetGlobals();
  global.FileReader = FakeFileReader;
  assert.doesNotThrow(() =>
    GSRStorage.importPresetFile(null, () => {
      throw new Error('callback should not be invoked');
    }),
  );
});

test('importPresetFile: parses valid JSON and calls applyPreset, invoking callback(true, preset)', async () => {
  resetGlobals();
  global.FileReader = FakeFileReader;
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
  };
  const preset = { type: 'BioMappingPreset', gsr: { medianSize: 7 }, gps: {} };
  const file = { __content: JSON.stringify(preset) };

  const result = await new Promise((resolve) => {
    GSRStorage.importPresetFile(file, (success, parsedPreset) =>
      resolve({ success, parsedPreset }),
    );
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.parsedPreset.gsr.medianSize, 7);
  assert.strictEqual(global.AppState.sliders.medianSize.value, 7);
});

test('importPresetFile: invalid JSON triggers alert and callback(false, null)', async () => {
  resetGlobals();
  global.FileReader = FakeFileReader;
  const file = { __content: '{not valid json' };

  const result = await new Promise((resolve) => {
    GSRStorage.importPresetFile(file, (success, parsedPreset) =>
      resolve({ success, parsedPreset }),
    );
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.parsedPreset, null);
  assert.strictEqual(alertCalls.length, 1);
  assert.match(alertCalls[0], /Invalid preset file format/);
});

// ── GSRStorage.syncSliderValueDisplays() ─────────────────────────────────

test('syncSliderValueDisplays: no-op (does not throw) when GSREvents.initializeLabels is not a function', () => {
  // GSREvents is a real static import now (ES-module migration) — it can
  // never be `undefined`, so the "not loaded yet" case this guards against
  // is an empty GSREvents (what resetGlobals() leaves it as), not an
  // undefined one; storage.mjs's `typeof GSREvents.initializeLabels ===
  // 'function'` half of the guard still gates on that correctly.
  resetGlobals();
  assert.doesNotThrow(() => GSRStorage.syncSliderValueDisplays());
});

test('syncSliderValueDisplays: calls GSREvents.initializeLabels when available', () => {
  resetGlobals();
  let called = false;
  global.GSREvents = setSingletonShape(RealGSREvents, {
    initializeLabels: () => {
      called = true;
    },
  });
  GSRStorage.syncSliderValueDisplays();
  assert.strictEqual(called, true);
});

// ── GSRStorage.applyPreset() ─────────────────────────────────────────────

test('applyPreset: alerts and returns false for a falsy preset', () => {
  resetGlobals();
  assert.strictEqual(GSRStorage.applyPreset(null), false);
  assert.strictEqual(alertCalls.length, 1);
  assert.match(alertCalls[0], /Invalid preset file/);
});

test('applyPreset: returns false (no alert) when AppState.sliders is missing', () => {
  resetGlobals();
  global.AppState = {}; // no .sliders
  assert.strictEqual(GSRStorage.applyPreset({ gsr: {}, gps: {} }), false);
  assert.strictEqual(alertCalls.length, 0);
});

test('applyPreset: writes GSR/GPS/contour values onto the matching slider elements', () => {
  resetGlobals();
  const S = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(0),
    peakThreshold: el(0),
    minPeakQuality: el(0),
    hotspotPercentile: el(0),
    gpsMaxSpeed: el(0),
  };
  const C = { gridResolution: el(0), contourCount: el(0) };
  global.AppState.sliders = S;
  global.AppState.contourControls = C;

  const preset = {
    gsr: {
      medianSize: 5,
      lpfWindow: 0.3,
      tonicMethod: 'median',
      hotspotPercentile: 0.03,
    },
    gps: { maxSpeed: 4.5 },
    contour: { gridResolution: 30, contourCount: 6 },
  };

  const ok = GSRStorage.applyPreset(preset);
  assert.strictEqual(ok, true);
  assert.strictEqual(S.medianSize.value, 5);
  assert.strictEqual(S.lpfWindow.value, 0.3);
  assert.strictEqual(S.tonicMethod.value, 'median');
  // hotspotPercentile <= 1.0 -> treated as a fraction, scaled *100 for display
  assert.strictEqual(S.hotspotPercentile.value, 3);
  assert.strictEqual(S.gpsMaxSpeed.value, 4.5);
  assert.strictEqual(C.gridResolution.value, 30);
  assert.strictEqual(C.contourCount.value, 6);
});

test('applyPreset: hotspotPercentile > 1.0 is treated as already being a percentage', () => {
  resetGlobals();
  const S = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(0),
    peakThreshold: el(0),
    hotspotPercentile: el(0),
  };
  global.AppState.sliders = S;
  GSRStorage.applyPreset({ gsr: { hotspotPercentile: 4 }, gps: {} });
  assert.strictEqual(S.hotspotPercentile.value, 4);
});

test('applyPreset: shapeMinSnr writes straight to the slider value', () => {
  resetGlobals();
  const S = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(0),
    peakThreshold: el(0),
    useDeconvolution: { checked: false },
    shapeMinSnr: { value: '0', dataset: {} },
  };
  global.AppState.sliders = S;

  GSRStorage.applyPreset({
    gsr: { useDeconvolution: true, shapeMinSnr: 5.5 },
    gps: {},
  });

  assert.strictEqual(S.useDeconvolution.checked, true);
  assert.strictEqual(S.shapeMinSnr.value, 5.5);
  assert.strictEqual(S.shapeMinSnr.dataset.customValue, undefined);
});

test('applyPreset: usePeakProminence overrides useDeconvolution when both are enabled', () => {
  resetGlobals();
  const S = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(0),
    peakThreshold: el(0),
    useDeconvolution: { checked: false },
    usePeakProminence: { checked: false },
  };
  global.AppState.sliders = S;

  GSRStorage.applyPreset({
    gsr: { useDeconvolution: true, usePeakProminence: true },
    gps: {},
  });

  assert.strictEqual(S.usePeakProminence.checked, true);
  assert.strictEqual(S.useDeconvolution.checked, false);
});

test('applyPreset: useCvxEDA enables cvxEDA and turns off deconvolution', () => {
  resetGlobals();
  const S = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(0),
    peakThreshold: el(0),
    useDeconvolution: { checked: true },
    usePeakProminence: { checked: false },
    useCvxEDA: { checked: false },
  };
  global.AppState.sliders = S;

  GSRStorage.applyPreset({
    gsr: { useDeconvolution: true, useCvxEDA: true },
    gps: {},
  });

  assert.strictEqual(S.useCvxEDA.checked, true);
  assert.strictEqual(S.useDeconvolution.checked, false);
});

test('applyPreset: invokes GSREvents layout hook and syncs slider displays', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(0),
    peakThreshold: el(0),
  };
  const calls = [];
  global.GSREvents = setSingletonShape(RealGSREvents, {
    updateTonicMethodLayout: () => calls.push('layout'),
    initializeLabels: () => calls.push('labels'),
  });
  GSRStorage.applyPreset({ gsr: {}, gps: {} });
  assert.deepStrictEqual(calls, ['layout', 'labels']);
});

test("applyPreset: commits to the open walk only, never another walk's settings", () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(2),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
    gpsPeakLatency: el(1.5),
  };
  global.AppState.activeTrackId = 'trk1';
  global.AppState.viewMode = 'collective';

  let analyzeArgs = null;
  const track = {
    analyzer: {
      analyze: (params, pl) => {
        analyzeArgs = { params, pl };
      },
    },
  };
  const other = { analyzer: { analyze: () => {} } };
  global.AppState.collectiveManager = {
    tracks: [track, other],
    getTrack: (id) => (id === 'trk1' ? track : null),
  };

  const uiCalls = [];
  global.GSRTrackManager = setSingletonShape(RealGSRTrackManager, {
    renderTrackList: () => uiCalls.push('renderTrackList'),
  });
  global.GSRUI = setSingletonShape(RealGSRUI, {
    runAnalysis: () => uiCalls.push('runAnalysis'),
  });

  const ok = GSRStorage.applyPreset({ gsr: {}, gps: {} });

  assert.strictEqual(ok, true);
  assert.strictEqual(track.filterParams.medianSize, 2);
  assert.ok(track.gpsFilterParams);
  assert.strictEqual(analyzeArgs.pl, 1.5);
  assert.strictEqual(other.filterParams, undefined, 'other walk untouched');
  assert.strictEqual(other.gpsFilterParams, undefined, 'other walk untouched');
  assert.deepStrictEqual(uiCalls, ['renderTrackList', 'runAnalysis']);
});

test('applyPreset (single view): commits only to the active track', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(2),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
  };
  global.AppState.activeTrackId = 'trk1';
  global.AppState.viewMode = 'single';
  const track = { analyzer: { analyze: () => {} } };
  const other = { analyzer: { analyze: () => {} } };
  global.AppState.collectiveManager = {
    tracks: [track, other],
    getTrack: (id) => (id === 'trk1' ? track : null),
  };
  global.GSRTrackManager = setSingletonShape(RealGSRTrackManager, {
    renderTrackList: () => {},
  });
  global.GSRUI = setSingletonShape(RealGSRUI, { runAnalysis: () => {} });

  assert.strictEqual(GSRStorage.applyPreset({ gsr: {}, gps: {} }), true);
  assert.strictEqual(track.filterParams.medianSize, 2);
  assert.strictEqual(other.filterParams, undefined, 'other track untouched');
});

test('applyPreset: changed OSM/snap radii re-enrich once, after the walk is re-analysed', () => {
  resetGlobals();
  const fired = [];
  const radiusEl = (value, name) => ({
    value: String(value),
    dispatchEvent: (e) => fired.push(`${name}:${e.type}`),
  });
  global.AppState.sliders = {
    medianSize: el(2),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
    osmRadius: radiusEl(50, 'osm'),
    gpsSnapRadius: radiusEl(25, 'snap'),
  };
  global.AppState.activeTrackId = 'trk1';
  global.AppState.viewMode = 'single';
  const track = { analyzer: { analyze: () => {} } };
  global.AppState.collectiveManager = { getTrack: () => track };
  global.GSRTrackManager = setSingletonShape(RealGSRTrackManager, {
    renderTrackList: () => {},
  });
  const uiCalls = [];
  global.GSRUI = setSingletonShape(RealGSRUI, {
    runAnalysis: () => uiCalls.push('runAnalysis'),
    hasOsmData: () => true,
    enrichTrack: (force) => uiCalls.push(`enrichTrack:${force}`),
  });

  GSRStorage.applyPreset({
    gsr: {},
    gps: {},
    enrichment: { osmRadius: 80, snapRadius: 40 },
  });

  assert.strictEqual(global.AppState.sliders.osmRadius.value, 80);
  assert.strictEqual(global.AppState.sliders.gpsSnapRadius.value, 40);
  assert.deepStrictEqual(
    fired,
    ['osm:input', 'snap:input'],
    "labels update, but no per-slider 'change' (each would start its own enrichment)",
  );
  assert.deepStrictEqual(uiCalls, ['runAnalysis', 'enrichTrack:false']);
});

test('applyPreset: unchanged radii do not re-enrich', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(2),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(45),
    peakThreshold: el(0.02),
    osmRadius: el(50),
    gpsSnapRadius: el(25),
  };
  const uiCalls = [];
  global.GSRUI = setSingletonShape(RealGSRUI, {
    hasOsmData: () => true,
    enrichTrack: () => uiCalls.push('enrichTrack'),
  });

  GSRStorage.applyPreset({
    gsr: {},
    gps: {},
    enrichment: { osmRadius: 50, snapRadius: 25 },
  });
  assert.deepStrictEqual(uiCalls, []);
});

test('resetCollectivePlaces: restores the shipped Arousal Places defaults', () => {
  resetGlobals();
  global.AppState.collectivePlaces = {
    placeMergeDistance: 99,
    maxArousalPlaces: 3,
  };
  GSRStorage.resetCollectivePlaces();
  assert.deepStrictEqual(global.AppState.collectivePlaces, {
    placeMergeDistance: global.GSR_CONST.AROUSAL_PLACES.mergeM,
    maxArousalPlaces: global.GSR_CONST.AROUSAL_PLACES.maxPlaces,
  });
});

test('applyPreset: swallows an error thrown by track.analyzer.analyze() and still returns true', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0),
    lpfWindow: el(0),
    tonicMethod: el('lpf'),
    tonicWindow: el(0),
    peakThreshold: el(0),
  };
  global.AppState.activeTrackId = 'trk1';
  const track = {
    analyzer: {
      analyze: () => {
        throw new Error('boom');
      },
    },
  };
  global.AppState.collectiveManager = { getTrack: () => track };
  // applyPreset() unconditionally calls GSRTrackManager.renderTrackList()
  // after the analyze() try/catch (GSRTrackManager is a real static import
  // now — always defined in practice, so storage.mjs's `typeof
  // GSRTrackManager !== 'undefined'` guard is effectively unconditional) —
  // stub it so this test stays focused on the analyze()-throws swallow
  // behaviour, not on reproducing every downstream UI call.
  global.GSRTrackManager = setSingletonShape(RealGSRTrackManager, {
    renderTrackList: () => {},
  });

  assert.doesNotThrow(() => {
    const ok = GSRStorage.applyPreset({ gsr: {}, gps: {} });
    assert.strictEqual(ok, true);
  });
});

// ── GSRStorage.writeGpsSliderValues() ───────────────────────────────────

test('writeGpsSliderValues: sets GPS slider values and handles mapped keys', () => {
  resetGlobals();
  const S = {
    gpsMaxHdop: el(0),
    gpsMaxSpeed: el(0),
    gpsRDP: el(0),
    gpsDownsample: el(0),
    gpsTrackWeight: el(0),
    gpsPeakLatency: el(0),
    placeMergeDistance: el(0),
    maxArousalPlaces: el(0),
  };
  global.AppState.sliders = S;

  GSRStorage.writeGpsSliderValues({
    maxHdop: 2.5,
    maxSpeed: 4.5,
    rdpTolerance: 1.2,
    downsample: 1,
    trackWeight: 3,
    peakLatency: 2.0,
    placeMergeDistance: 40,
    maxArousalPlaces: 15,
  });

  assert.strictEqual(S.gpsMaxHdop.value, 2.5);
  assert.strictEqual(S.gpsMaxSpeed.value, 4.5);
  assert.strictEqual(S.gpsRDP.value, 1.2);
  assert.strictEqual(S.gpsDownsample.value, 1);
  assert.strictEqual(S.gpsTrackWeight.value, 3);
  assert.strictEqual(S.gpsPeakLatency.value, 2.0);
  assert.strictEqual(S.placeMergeDistance.value, 40);
  assert.strictEqual(S.maxArousalPlaces.value, 15);
});
