/**
 * Unit tests for app_state.js (AppState) — central shared state object.
 * Covers the one real method (getNextTrackColor) and the three clamped
 * getter/setter pairs (viewStartTime, viewDuration, zoomFactor); the rest
 * of the object is plain data with no behavior to test.
 *
 * Run: node --test tests/test_app_state.js
 */

const assert = require('assert');
const test = require('node:test');

const { AppState } = require('../src/core/app_state.js');

test('getNextTrackColor: cycles through the palette in order and wraps around', () => {
  // Note: getNextTrackColor()'s body reads/writes `AppState.trackColors` /
  // `AppState.trackColorIndex` directly rather than `this.*`, so it always
  // operates on the real singleton regardless of what it's called on —
  // can't meaningfully test it against an isolated mock object.
  AppState.trackColors = ['#a', '#b', '#c'];
  AppState.trackColorIndex = 0;
  assert.strictEqual(AppState.getNextTrackColor(), '#a');
  assert.strictEqual(AppState.getNextTrackColor(), '#b');
  assert.strictEqual(AppState.getNextTrackColor(), '#c');
  assert.strictEqual(AppState.getNextTrackColor(), '#a', 'should wrap back to the first color');
  // restore the real 8-color palette for the next test in this file
  AppState.trackColors = [
    '#005bc4', '#d10024', '#008f3c', '#7b00cc',
    '#e59e00', '#cc0088', '#0099aa', '#e56a00'
  ];
  AppState.trackColorIndex = 0;
});

test('getNextTrackColor: on the real AppState singleton, cycles through all 8 default colors uniquely before repeating', () => {
  AppState.trackColorIndex = 0;
  const seen = new Set();
  for (let i = 0; i < 8; i++) seen.add(AppState.getNextTrackColor());
  assert.strictEqual(seen.size, 8, 'all 8 palette entries should be distinct');
  assert.strictEqual(AppState.getNextTrackColor(), AppState.trackColors[0], '9th call wraps to the first color again');
});

test('viewStartTime: clamps to [0, totalDuration]', () => {
  AppState.totalDuration = 100;
  AppState.viewStartTime = -50;
  assert.strictEqual(AppState.viewStartTime, 0);
  AppState.viewStartTime = 500;
  assert.strictEqual(AppState.viewStartTime, 100);
  AppState.viewStartTime = 42;
  assert.strictEqual(AppState.viewStartTime, 42);
});

test('viewStartTime: silently ignores non-number / NaN assignments', () => {
  AppState.totalDuration = 100;
  AppState.viewStartTime = 30;
  AppState.viewStartTime = 'not a number';
  assert.strictEqual(AppState.viewStartTime, 30, 'invalid assignment should be a no-op');
  AppState.viewStartTime = NaN;
  assert.strictEqual(AppState.viewStartTime, 30, 'NaN assignment should be a no-op');
});

test('viewDuration: clamps to [2.0, totalDuration] using the hardcoded fallback when GSR_CONST is not declared', () => {
  assert.strictEqual(typeof GSR_CONST, 'undefined', 'sanity: no bare GSR_CONST global in this test file\'s scope');
  AppState.totalDuration = 100;
  AppState.viewDuration = 0.1; // below the fallback min of 2.0
  assert.strictEqual(AppState.viewDuration, 2.0);
  AppState.viewDuration = 1000; // above totalDuration
  assert.strictEqual(AppState.viewDuration, 100);
  AppState.viewDuration = 40;
  assert.strictEqual(AppState.viewDuration, 40);
});

test('viewDuration: consults the real GSR_CONST.ZOOM_MIN_DURATION when it is declared (regression test ' +
  'for a fixed bug: the setter used to gate on `window.GSR_CONST`, which nothing in the app ever sets, ' +
  'so constants.js\'s ZOOM_MIN_DURATION was silently ignored — see app_state.js:65 history)', () => {
  global.GSR_CONST = { ZOOM_MIN_DURATION: 7, ZOOM_MIN: 1, ZOOM_MAX: 50 };
  AppState.totalDuration = 100;
  AppState.viewDuration = 1; // below the now-configured min of 7
  assert.strictEqual(AppState.viewDuration, 7);
  delete global.GSR_CONST;
});

test('viewDuration: silently ignores non-number / NaN assignments', () => {
  AppState.totalDuration = 100;
  AppState.viewDuration = 10;
  AppState.viewDuration = 'nope';
  assert.strictEqual(AppState.viewDuration, 10);
  AppState.viewDuration = NaN;
  assert.strictEqual(AppState.viewDuration, 10);
});

test('zoomFactor: clamps to [1.0, 50.0] using the hardcoded fallback when GSR_CONST is not declared', () => {
  AppState.zoomFactor = 0.01;
  assert.strictEqual(AppState.zoomFactor, 1.0);
  AppState.zoomFactor = 1000;
  assert.strictEqual(AppState.zoomFactor, 50.0);
  AppState.zoomFactor = 10;
  assert.strictEqual(AppState.zoomFactor, 10);
});

test('zoomFactor: consults the real GSR_CONST.ZOOM_MIN/ZOOM_MAX when it is declared (regression test ' +
  'for the same fixed window.GSR_CONST-vs-bare-GSR_CONST bug as viewDuration, app_state.js:75-76)', () => {
  global.GSR_CONST = { ZOOM_MIN_DURATION: 2, ZOOM_MIN: 3, ZOOM_MAX: 20 };
  AppState.zoomFactor = 0.5;
  assert.strictEqual(AppState.zoomFactor, 3, 'below the now-configured min of 3');
  AppState.zoomFactor = 999;
  assert.strictEqual(AppState.zoomFactor, 20, 'above the now-configured max of 20');
  delete global.GSR_CONST;
});

test('zoomFactor: silently ignores non-number / NaN assignments', () => {
  AppState.zoomFactor = 5;
  AppState.zoomFactor = 'nope';
  assert.strictEqual(AppState.zoomFactor, 5);
  AppState.zoomFactor = NaN;
  assert.strictEqual(AppState.zoomFactor, 5);
});

test('default state shape: key fields start with documented defaults', () => {
  const fresh = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'core', 'app_state.js'), 'utf8');
  // Sanity-check the defaults documented in the module comments are actually
  // present in source, since AppState is a singleton mutated by the tests
  // above and can't be freshly re-instantiated without re-parsing the file.
  assert.ok(fresh.includes("viewMode: 'single'"));
  assert.ok(fresh.includes('showRaw: true'));
  assert.ok(fresh.includes("lowerGraphMode: 'phasic'"));
});
