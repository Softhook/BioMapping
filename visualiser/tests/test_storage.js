/**
 * Unit tests for storage.js (GSRStorage, sliderVal, shapeSliderVal) —
 * settings management, localStorage-adjacent preset import/export, and
 * slider-value parsing/fallback logic.
 *
 * Run: node --test tests/test_storage.js  (or `npm test` for the whole suite)
 */

const assert = require('assert');
const test = require('node:test');

const GSR_CONST_MOCK = require('./mock_constants.js');

// storage.js calls alert(...) directly in a few places (export/import error
// paths) and Node has no `alert` global — stub it once here and let
// individual tests inspect calls via `alertCalls`.
let alertCalls = [];
global.alert = (msg) => { alertCalls.push(msg); };

// localStorage isn't used directly by storage.js today, but stub it
// defensively per the task brief in case any code path touches it.
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { GSRStorage, sliderVal, shapeSliderVal } = require('../src/ui/storage.js');

function el(value) {
  return { value: String(value) };
}

function resetGlobals() {
  alertCalls = [];
  global.AppState = {};
  global.GSR_CONST = JSON.parse(JSON.stringify(GSR_CONST_MOCK));
  delete global.GSREvents;
  delete global.GSRTrackManager;
  delete global.GSRUI;
  delete global.GSRFileSaver;
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

// ── shapeSliderVal() ─────────────────────────────────────────────────────

test('shapeSliderVal: returns fallback when el is null', () => {
  assert.strictEqual(shapeSliderVal(null, 1.23), 1.23);
});

test('shapeSliderVal: prefers dataset.customValue over el.value when present', () => {
  const lockedEl = { value: '999', dataset: { customValue: '4.5' } };
  assert.strictEqual(shapeSliderVal(lockedEl, 0), 4.5);
});

test('shapeSliderVal: falls back to el.value via sliderVal when dataset.customValue is absent', () => {
  const plainEl = { value: '6.5', dataset: {} };
  assert.strictEqual(shapeSliderVal(plainEl, 0), 6.5);
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
  assert.strictEqual(result.dwtLevel, D.dwtLevel);
  assert.strictEqual(result.minPeakQuality, D.minPeakQuality);
  assert.strictEqual(result.hotspotPercentile, D.hotspotPercentile);
  assert.strictEqual(result.shapeMinRiseTime, PS.MIN_RISE_TIME);
  assert.strictEqual(result.shapeMaxRiseTime, PS.MAX_RISE_TIME);
  assert.strictEqual(result.shapeMinHalfRecovery, PS.MIN_HALF_RECOVERY);
  assert.strictEqual(result.shapeMaxHalfRecovery, PS.MAX_HALF_RECOVERY);
  assert.strictEqual(result.shapeMinSnr, PS.MIN_SNR);
  assert.strictEqual(result.shapeMaxSkewRatio, PS.SKEWNESS_RATIO_MAX);
  assert.strictEqual(result.useDeconvolution, false);
});

test('readGsrSliderValues: hotspotPercentile is divided by 100 when read from the (0-100) slider', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'),
    tonicWindow: el(45), peakThreshold: el(0.02),
    hotspotPercentile: el(5), // 5% on the slider
  };
  const result = GSRStorage.readGsrSliderValues();
  assert.strictEqual(result.hotspotPercentile, 0.05);
});

test('readGsrSliderValues: useDeconvolution reflects checkbox .checked state', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'),
    tonicWindow: el(45), peakThreshold: el(0.02),
    useDeconvolution: { checked: true },
  };
  assert.strictEqual(GSRStorage.readGsrSliderValues().useDeconvolution, true);
});

test('readGsrSliderValues: shape sliders read the locked dataset.customValue when present', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'),
    tonicWindow: el(45), peakThreshold: el(0.02),
    shapeMinRiseTime: { value: '999', dataset: { customValue: '1.1' } },
    shapeMinSnr: { value: '2.2', dataset: {} }, // shapeMinSnr never locks — uses sliderVal directly
  };
  const result = GSRStorage.readGsrSliderValues();
  assert.strictEqual(result.shapeMinRiseTime, 1.1);
  assert.strictEqual(result.shapeMinSnr, 2.2);
});

// ── GSRStorage.readGpsSliderValues() ────────────────────────────────────

test('readGpsSliderValues: returns null (not a throw) when AppState.sliders is undefined', () => {
  // Regression test: unlike readGsrSliderValues/readContourSliderValues, this
  // used to have no `!S` guard and would throw a TypeError reading S.gpsSmoothing
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
  assert.strictEqual(result.smoothing, D.smoothing);
  assert.strictEqual(result.kalmanR, D.kalmanR);
  assert.strictEqual(result.maxHdop, D.maxHdop);
  assert.strictEqual(result.maxSpeed, D.maxSpeed);
  assert.strictEqual(result.rdpTolerance, D.rdpTolerance);
  assert.strictEqual(result.downsample, D.downsample ? 1 : 0);
  assert.strictEqual(result.trackWeight, D.trackWeight);
  assert.strictEqual(result.peakLatency, D.peakLatency);
  assert.strictEqual(result.clusterProximity, 35);
  assert.strictEqual(result.clusterBoundaryRadius, 5);
});

test('readGpsSliderValues: reads values from present sliders', () => {
  resetGlobals();
  global.AppState.sliders = {
    gpsSmoothing: el(0.9), gpsKalmanR: el(20), gpsMaxHdop: el(5),
    gpsMaxSpeed: el(4), gpsRDP: el(1.5), gpsDownsample: el(1),
    gpsTrackWeight: el(8), gpsPeakLatency: el(3),
    clusterProximity: el(50), clusterBoundaryRadius: el(10),
  };
  const result = GSRStorage.readGpsSliderValues();
  assert.strictEqual(result.smoothing, 0.9);
  assert.strictEqual(result.kalmanR, 20);
  assert.strictEqual(result.maxHdop, 5);
  assert.strictEqual(result.maxSpeed, 4);
  assert.strictEqual(result.rdpTolerance, 1.5);
  assert.strictEqual(result.downsample, 1);
  assert.strictEqual(result.trackWeight, 8);
  assert.strictEqual(result.peakLatency, 3);
  assert.strictEqual(result.clusterProximity, 50);
  assert.strictEqual(result.clusterBoundaryRadius, 10);
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
    gridResolution: el(40), contourCount: el(8),
    isolationRadius: el(50), idwExponent: el(2), surfaceOpacity: el(0.4),
  };
  const result = GSRStorage.readContourSliderValues();
  assert.deepStrictEqual(result, {
    gridResolution: 40, contourCount: 8, isolationRadius: 50,
    idwExponent: 2, peakPreservation: global.GSR_CONST.COLLECTIVE.peakPreservation,
    coverageWeighting: global.GSR_CONST.COLLECTIVE.coverageWeighting, surfaceOpacity: 0.4,
  });
});

// ── GSRStorage.buildGpsParams() ──────────────────────────────────────────

test('buildGpsParams: builds the renderer-facing subset and converts downsample to boolean', () => {
  resetGlobals();
  global.AppState.sliders = {
    gpsSmoothing: el(0.9), gpsKalmanR: el(20), gpsMaxHdop: el(5),
    gpsMaxSpeed: el(4), gpsRDP: el(1.5), gpsDownsample: el(1),
    gpsPeakLatency: el(3),
  };
  const params = GSRStorage.buildGpsParams();
  assert.strictEqual(params.downsample, true);
  assert.strictEqual(params.smoothing, 0.9);
  assert.strictEqual(params.kalmanR, 20);
  assert.strictEqual(params.maxHdop, 5);
  assert.strictEqual(params.maxSpeed, 4);
  assert.strictEqual(params.rdpTolerance, 1.5);
  assert.strictEqual(params.peakLatency, 3);
  assert.strictEqual(params.trackWeight, GSR_CONST_MOCK.GPS_DEFAULT.trackWeight);
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
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'),
    tonicWindow: el(45), peakThreshold: el(0.02),
  };
  global.AppState.contourControls = {
    gridResolution: el(40), contourCount: el(8),
    isolationRadius: el(50), idwExponent: el(2), surfaceOpacity: el(0.4),
  };
  global.AppState.activeTrackId = null;

  let saved = null;
  global.GSRFileSaver = {
    saveFile: async (jsonStr, suggestedName) => { saved = { jsonStr, suggestedName }; },
  };

  await GSRStorage.exportPreset('My Custom Name');

  assert.strictEqual(alertCalls.length, 0);
  assert.ok(saved, 'GSRFileSaver.saveFile should have been called');
  const parsed = JSON.parse(saved.jsonStr);
  assert.strictEqual(parsed.type, 'BioMappingPreset');
  assert.strictEqual(parsed.name, 'My Custom Name');
  assert.ok(parsed.gsr && parsed.gps && parsed.contour);
  assert.match(saved.suggestedName, /^biomapping_preset_My_Custom_Name_\d{4}-\d{2}-\d{2}\.json$/);
});

test('exportPreset: falls back to the active track name (minus extension) when no filenameBase is given', async () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'),
    tonicWindow: el(45), peakThreshold: el(0.02),
  };
  global.AppState.activeTrackId = 'trk1';
  global.AppState.collectiveManager = {
    getTrack: (id) => (id === 'trk1' ? { name: 'session_walk.csv' } : null),
  };
  let saved = null;
  global.GSRFileSaver = { saveFile: async (jsonStr, suggestedName) => { saved = { jsonStr, suggestedName }; } };

  await GSRStorage.exportPreset();

  const parsed = JSON.parse(saved.jsonStr);
  assert.strictEqual(parsed.name, 'session_walk');
});

test('downloadPresetJson: sanitizes the filename base and stamps today\'s date', async () => {
  resetGlobals();
  let saved = null;
  global.GSRFileSaver = { saveFile: async (jsonStr, suggestedName) => { saved = { jsonStr, suggestedName }; } };
  await GSRStorage.downloadPresetJson({ a: 1 }, 'Weird Name!! #1');
  assert.match(saved.suggestedName, /^biomapping_preset_Weird_Name____1_\d{4}-\d{2}-\d{2}\.json$/);
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
  assert.doesNotThrow(() => GSRStorage.importPresetFile(null, () => {
    throw new Error('callback should not be invoked');
  }));
});

test('importPresetFile: parses valid JSON and calls applyPreset, invoking callback(true, preset)', async () => {
  resetGlobals();
  global.FileReader = FakeFileReader;
  global.AppState.sliders = {
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'),
    tonicWindow: el(45), peakThreshold: el(0.02),
  };
  const preset = { type: 'BioMappingPreset', gsr: { medianSize: 7 }, gps: {} };
  const file = { __content: JSON.stringify(preset) };

  const result = await new Promise((resolve) => {
    GSRStorage.importPresetFile(file, (success, parsedPreset) => resolve({ success, parsedPreset }));
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
    GSRStorage.importPresetFile(file, (success, parsedPreset) => resolve({ success, parsedPreset }));
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.parsedPreset, null);
  assert.strictEqual(alertCalls.length, 1);
  assert.match(alertCalls[0], /Invalid preset file format/);
});

// ── GSRStorage.syncSliderValueDisplays() ─────────────────────────────────

test('syncSliderValueDisplays: no-op (does not throw) when GSREvents is undefined', () => {
  resetGlobals();
  assert.doesNotThrow(() => GSRStorage.syncSliderValueDisplays());
});

test('syncSliderValueDisplays: calls GSREvents.initializeLabels when available', () => {
  resetGlobals();
  let called = false;
  global.GSREvents = { initializeLabels: () => { called = true; } };
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
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'), tonicWindow: el(0),
    peakThreshold: el(0), dwtLevel: el(0), minPeakQuality: el(0), hotspotPercentile: el(0),
    gpsSmoothing: el(0), gpsKalmanR: el(0),
  };
  const C = { gridResolution: el(0), contourCount: el(0) };
  global.AppState.sliders = S;
  global.AppState.contourControls = C;

  const preset = {
    gsr: { medianSize: 5, lpfWindow: 0.3, tonicMethod: 'dwt', dwtLevel: 4, hotspotPercentile: 0.03 },
    gps: { smoothing: 0.8, kalmanR: 15 },
    contour: { gridResolution: 30, contourCount: 6 },
  };

  const ok = GSRStorage.applyPreset(preset);
  assert.strictEqual(ok, true);
  assert.strictEqual(S.medianSize.value, 5);
  assert.strictEqual(S.lpfWindow.value, 0.3);
  assert.strictEqual(S.tonicMethod.value, 'dwt');
  assert.strictEqual(S.dwtLevel.value, 4);
  // hotspotPercentile <= 1.0 -> treated as a fraction, scaled *100 for display
  assert.strictEqual(S.hotspotPercentile.value, 3);
  assert.strictEqual(S.gpsSmoothing.value, 0.8);
  assert.strictEqual(S.gpsKalmanR.value, 15);
  assert.strictEqual(C.gridResolution.value, 30);
  assert.strictEqual(C.contourCount.value, 6);
});

test('applyPreset: hotspotPercentile > 1.0 is treated as already being a percentage', () => {
  resetGlobals();
  const S = { medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'), tonicWindow: el(0), peakThreshold: el(0), hotspotPercentile: el(0) };
  global.AppState.sliders = S;
  GSRStorage.applyPreset({ gsr: { hotspotPercentile: 4 }, gps: {} });
  assert.strictEqual(S.hotspotPercentile.value, 4);
});

test('applyPreset: shape sliders lock to dataset.customValue while useDeconvolution is on (except shapeMinSnr)', () => {
  resetGlobals();
  const S = {
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'), tonicWindow: el(0), peakThreshold: el(0),
    useDeconvolution: { checked: false },
    shapeMinRiseTime: { value: '0', dataset: {} }, shapeMaxRiseTime: { value: '0', dataset: {} },
    shapeMinHalfRecovery: { value: '0', dataset: {} }, shapeMaxHalfRecovery: { value: '0', dataset: {} },
    shapeMinSnr: { value: '0', dataset: {} }, shapeMaxSkewRatio: { value: '0', dataset: {} },
  };
  global.AppState.sliders = S;

  GSRStorage.applyPreset({
    gsr: {
      useDeconvolution: true,
      shapeMinRiseTime: 1.1, shapeMaxRiseTime: 2.2, shapeMinHalfRecovery: 3.3,
      shapeMaxHalfRecovery: 4.4, shapeMinSnr: 5.5, shapeMaxSkewRatio: 6.6,
    },
    gps: {},
  });

  assert.strictEqual(S.useDeconvolution.checked, true);
  assert.strictEqual(S.shapeMinRiseTime.dataset.customValue, 1.1);
  assert.strictEqual(S.shapeMaxRiseTime.dataset.customValue, 2.2);
  assert.strictEqual(S.shapeMinHalfRecovery.dataset.customValue, 3.3);
  assert.strictEqual(S.shapeMaxHalfRecovery.dataset.customValue, 4.4);
  assert.strictEqual(S.shapeMaxSkewRatio.dataset.customValue, 6.6);
  // shapeMinSnr is never locked — always written straight to .value
  assert.strictEqual(S.shapeMinSnr.value, 5.5);
  assert.strictEqual(S.shapeMinSnr.dataset.customValue, undefined);
});

test('applyPreset: shape sliders write directly to .value and clear any stale dataset.customValue when useDeconvolution is off', () => {
  resetGlobals();
  const S = {
    medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'), tonicWindow: el(0), peakThreshold: el(0),
    shapeMinRiseTime: { value: '0', dataset: { customValue: '999' } },
  };
  global.AppState.sliders = S;

  GSRStorage.applyPreset({ gsr: { useDeconvolution: false, shapeMinRiseTime: 1.5 }, gps: {} });

  assert.strictEqual(S.shapeMinRiseTime.value, 1.5);
  assert.strictEqual(S.shapeMinRiseTime.dataset.customValue, undefined);
});

test('applyPreset: invokes GSREvents layout/state hooks and syncs slider displays', () => {
  resetGlobals();
  global.AppState.sliders = { medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'), tonicWindow: el(0), peakThreshold: el(0) };
  const calls = [];
  global.GSREvents = {
    updateTonicMethodLayout: () => calls.push('layout'),
    updateDeconvolutionUIState: () => calls.push('deconv'),
    initializeLabels: () => calls.push('labels'),
  };
  GSRStorage.applyPreset({ gsr: {}, gps: {} });
  assert.deepStrictEqual(calls, ['layout', 'deconv', 'labels']);
});

test('applyPreset: commits parsed sliders to the active track and re-analyzes it', () => {
  resetGlobals();
  global.AppState.sliders = {
    medianSize: el(2), lpfWindow: el(0), tonicMethod: el('lpf'), tonicWindow: el(45), peakThreshold: el(0.02),
    gpsPeakLatency: el(1.5),
  };
  global.AppState.activeTrackId = 'trk1';
  global.AppState.viewMode = 'collective';

  let analyzeArgs = null;
  const track = {
    analyzer: { analyze: (params, pl) => { analyzeArgs = { params, pl }; } },
  };
  global.AppState.collectiveManager = { getTrack: (id) => (id === 'trk1' ? track : null) };

  const uiCalls = [];
  global.GSRTrackManager = { renderTrackList: () => uiCalls.push('renderTrackList') };
  global.GSRUI = {
    runAnalysis: () => uiCalls.push('runAnalysis'),
    updateCollectiveMap: () => uiCalls.push('updateCollectiveMap'),
  };

  const ok = GSRStorage.applyPreset({ gsr: {}, gps: {} });

  assert.strictEqual(ok, true);
  assert.ok(track.filterParams, 'track.filterParams should have been assigned');
  assert.strictEqual(track.filterParams.medianSize, 2);
  assert.ok(track.gpsFilterParams, 'track.gpsFilterParams should have been assigned');
  assert.ok(analyzeArgs, 'track.analyzer.analyze should have been called');
  assert.strictEqual(analyzeArgs.pl, 1.5);
  assert.deepStrictEqual(uiCalls, ['renderTrackList', 'runAnalysis', 'updateCollectiveMap']);
});

test('applyPreset: swallows an error thrown by track.analyzer.analyze() and still returns true', () => {
  resetGlobals();
  global.AppState.sliders = { medianSize: el(0), lpfWindow: el(0), tonicMethod: el('lpf'), tonicWindow: el(0), peakThreshold: el(0) };
  global.AppState.activeTrackId = 'trk1';
  const track = { analyzer: { analyze: () => { throw new Error('boom'); } } };
  global.AppState.collectiveManager = { getTrack: () => track };

  assert.doesNotThrow(() => {
    const ok = GSRStorage.applyPreset({ gsr: {}, gps: {} });
    assert.strictEqual(ok, true);
  });
});

// ── GSRStorage.getTrackSettingsStatus() ──────────────────────────────────

test('getTrackSettingsStatus: null track -> "standard"', () => {
  resetGlobals();
  assert.strictEqual(GSRStorage.getTrackSettingsStatus(null), 'standard');
});

test('getTrackSettingsStatus: track missing filterParams/gpsFilterParams -> "standard"', () => {
  resetGlobals();
  assert.strictEqual(GSRStorage.getTrackSettingsStatus({}), 'standard');
});

test('getTrackSettingsStatus: params matching defaults exactly -> "standard"', () => {
  resetGlobals();
  const D = GSR_CONST_MOCK.GSR_DEFAULT;
  const G = GSR_CONST_MOCK.GPS_DEFAULT;
  const track = {
    filterParams: {
      medianSize: D.medianSize, lpfWindow: D.lpfWindow, tonicMethod: D.tonicMethod,
      tonicWindow: D.tonicWindow, peakThreshold: D.peakThreshold, dwtLevel: D.dwtLevel,
      useDeconvolution: D.useDeconvolution,
    },
    gpsFilterParams: {
      smoothing: G.smoothing, kalmanR: G.kalmanR, maxHdop: G.maxHdop,
      maxSpeed: G.maxSpeed, rdpTolerance: G.rdpTolerance, peakLatency: G.peakLatency,
    },
  };
  assert.strictEqual(GSRStorage.getTrackSettingsStatus(track), 'standard');
});

test('getTrackSettingsStatus: default params + settingsSource "imported" -> "imported"', () => {
  resetGlobals();
  const D = GSR_CONST_MOCK.GSR_DEFAULT;
  const G = GSR_CONST_MOCK.GPS_DEFAULT;
  const track = {
    settingsSource: 'imported',
    filterParams: {
      medianSize: D.medianSize, lpfWindow: D.lpfWindow, tonicMethod: D.tonicMethod,
      tonicWindow: D.tonicWindow, peakThreshold: D.peakThreshold, dwtLevel: D.dwtLevel,
      useDeconvolution: D.useDeconvolution,
    },
    gpsFilterParams: {
      smoothing: G.smoothing, kalmanR: G.kalmanR, maxHdop: G.maxHdop,
      maxSpeed: G.maxSpeed, rdpTolerance: G.rdpTolerance, peakLatency: G.peakLatency,
    },
  };
  assert.strictEqual(GSRStorage.getTrackSettingsStatus(track), 'imported');
});

test('getTrackSettingsStatus: a GSR field differing from default -> "custom"', () => {
  resetGlobals();
  const D = GSR_CONST_MOCK.GSR_DEFAULT;
  const G = GSR_CONST_MOCK.GPS_DEFAULT;
  const track = {
    filterParams: {
      medianSize: D.medianSize + 1, lpfWindow: D.lpfWindow, tonicMethod: D.tonicMethod,
      tonicWindow: D.tonicWindow, peakThreshold: D.peakThreshold, dwtLevel: D.dwtLevel,
      useDeconvolution: D.useDeconvolution,
    },
    gpsFilterParams: {
      smoothing: G.smoothing, kalmanR: G.kalmanR, maxHdop: G.maxHdop,
      maxSpeed: G.maxSpeed, rdpTolerance: G.rdpTolerance, peakLatency: G.peakLatency,
    },
  };
  assert.strictEqual(GSRStorage.getTrackSettingsStatus(track), 'custom');
});

test('getTrackSettingsStatus: a GPS field differing from default -> "custom"', () => {
  resetGlobals();
  const D = GSR_CONST_MOCK.GSR_DEFAULT;
  const G = GSR_CONST_MOCK.GPS_DEFAULT;
  const track = {
    filterParams: {
      medianSize: D.medianSize, lpfWindow: D.lpfWindow, tonicMethod: D.tonicMethod,
      tonicWindow: D.tonicWindow, peakThreshold: D.peakThreshold, dwtLevel: D.dwtLevel,
      useDeconvolution: D.useDeconvolution,
    },
    gpsFilterParams: {
      smoothing: G.smoothing + 0.5, kalmanR: G.kalmanR, maxHdop: G.maxHdop,
      maxSpeed: G.maxSpeed, rdpTolerance: G.rdpTolerance, peakLatency: G.peakLatency,
    },
  };
  assert.strictEqual(GSRStorage.getTrackSettingsStatus(track), 'custom');
});

test('getTrackSettingsStatus: peakThreshold within 0.0001 tolerance still counts as "standard"', () => {
  resetGlobals();
  const D = GSR_CONST_MOCK.GSR_DEFAULT;
  const G = GSR_CONST_MOCK.GPS_DEFAULT;
  const track = {
    filterParams: {
      medianSize: D.medianSize, lpfWindow: D.lpfWindow, tonicMethod: D.tonicMethod,
      tonicWindow: D.tonicWindow, peakThreshold: D.peakThreshold + 0.00001, dwtLevel: D.dwtLevel,
      useDeconvolution: D.useDeconvolution,
    },
    gpsFilterParams: {
      smoothing: G.smoothing, kalmanR: G.kalmanR, maxHdop: G.maxHdop,
      maxSpeed: G.maxSpeed, rdpTolerance: G.rdpTolerance, peakLatency: G.peakLatency,
    },
  };
  assert.strictEqual(GSRStorage.getTrackSettingsStatus(track), 'standard');
});
