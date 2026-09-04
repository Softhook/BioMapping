/**
 * Unit tests for map legend rendering (map.js updateLegend) in single and collective modes.
 *
 * Run: node --test tests/test_map_legend.js
 */

const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

test('Map Legend: single mode - default gsr metric', () => {
  const { window, document } = bootApp();
  window.setup();
  
  const legendDiv = document.createElement('div');
  window.AppState.mapManager._legendControl = {
    getContainer: () => legendDiv
  };
  
  // Set viewMode to single
  window.AppState.viewMode = 'single';
  window.AppState.mapManager.activeColoringMetric = 'gsr';
  window.AppState.mapManager._legendMinVal = 1.2;
  window.AppState.mapManager._legendMaxVal = 4.8;
  
  window.AppState.mapManager.updateLegend();
  
  const html = legendDiv.innerHTML;
  assert.ok(html.includes('GSR Signal (Raw)'), 'Should contain GSR Signal title');
  assert.ok(html.includes('1.2'), 'Should display min value');
  assert.ok(html.includes('4.8'), 'Should display max value');
  assert.ok(html.includes('hsl(120,90%,50%)'), 'Should use correct HSL green');
});

test('Map Legend: single mode - em_fog metric', () => {
  const { window, document } = bootApp();
  window.setup();
  
  const legendDiv = document.createElement('div');
  window.AppState.mapManager._legendControl = {
    getContainer: () => legendDiv
  };
  
  window.AppState.viewMode = 'single';
  window.AppState.mapManager.activeColoringMetric = 'em_fog';
  window.AppState.mapManager._legendMinVal = 10;
  window.AppState.mapManager._legendMaxVal = 90;
  
  window.AppState.mapManager.updateLegend();
  
  const html = legendDiv.innerHTML;
  assert.ok(html.includes('EM Fog Index (0-100)'), 'Should contain EM Fog Index title');
  assert.ok(html.includes('10'), 'Should display min value');
  assert.ok(html.includes('90'), 'Should display max value');
  assert.ok(html.includes('hsl(220,90%,55%)'), 'Should use EM Fog start color');
  assert.ok(html.includes('hsl(300,90%,55%)'), 'Should use EM Fog end color');
});

test('Map Legend: collective mode - Phasic AUC topography', () => {
  const { window, document } = bootApp();
  window.setup();
  
  const legendDiv = document.createElement('div');
  window.AppState.mapManager._legendControl = {
    getContainer: () => legendDiv
  };
  
  window.AppState.viewMode = 'collective';
  window.AppState.mapManager._collectiveTopographySource = 'auc';
  window.AppState.mapManager._legendMinVal = 0.5;
  window.AppState.mapManager._legendMaxVal = 2.5;
  
  window.AppState.mapManager.updateLegend();
  
  const html = legendDiv.innerHTML;
  assert.ok(html.includes('Phasic AUC (ISCR)'), 'Should contain Phasic AUC title');
  assert.ok(html.includes('0.500 μS·s'), 'Should format min value with unit');
  assert.ok(html.includes('2.5 μS·s'), 'Should format max value with unit');
});

test('GSRUI.drawRegressionScatterPlot: data source resolution matches viewMode', () => {
  const { window } = bootApp();
  window.setup();

  const fakeCanvas = window.document.createElement('canvas');
  fakeCanvas.width = 100;
  fakeCanvas.height = 100;
  // Mock clientWidth/clientHeight so the resize check passes
  Object.defineProperties(fakeCanvas, {
    clientWidth: { value: 100 },
    clientHeight: { value: 100 }
  });
  window.document.getElementById('regressionCanvas').replaceWith(fakeCanvas);
  fakeCanvas.id = 'regressionCanvas';

  // Stub drawRegressionScatter to verify the parameters it was called with
  let lastX = null, lastY = null;
  window.GSRUI.drawRegressionScatter = (canvas, xVals, yVals) => {
    lastX = xVals;
    lastY = yVals;
  };

  // Mock cached stats on single track and collective manager
  window.AppState.analyzer._cachedEnvStats = {
    allData: [
      { osm_green_pct_50m: 10, phasic: 1.5, tonic: 1.0 },
      { osm_green_pct_50m: 20, phasic: 2.0, tonic: 1.2 }
    ]
  };
  window.AppState.collectiveManager._cachedEnvStats = {
    allData: [
      { osm_green_pct_50m: 40, phasic: 5.5, tonic: 3.0 },
      { osm_green_pct_50m: 50, phasic: 6.0, tonic: 3.2 },
      { osm_green_pct_50m: 60, phasic: 6.5, tonic: 3.4 }
    ]
  };

  // 1. Single Mode
  window.AppState.viewMode = 'single';
  window.GSRUI.drawRegressionScatterPlot();
  
  assert.strictEqual(lastX.length, 2, 'Should resolve to single-track cache');
  assert.strictEqual(lastX[0], 10);
  assert.strictEqual(lastX[1], 20);

  // 2. Collective Mode
  window.AppState.viewMode = 'collective';
  window.GSRUI.drawRegressionScatterPlot();

  assert.strictEqual(lastX.length, 3, 'Should resolve to collective-track cache');
  assert.strictEqual(lastX[0], 40);
  assert.strictEqual(lastX[1], 50);
  assert.strictEqual(lastX[2], 60);
});

test('GSRUI._percentile: robust axis-clip bounds used by the regression scatter', () => {
  const { window } = bootApp();
  const P = window.GSRUI._percentile;

  assert.strictEqual(P([], 0.5), 0, 'empty array → 0');
  assert.strictEqual(P([7], 0.5), 7, 'singleton → the value');

  const asc = Array.from({ length: 101 }, (_, i) => i); // 0..100
  assert.strictEqual(P(asc, 0), 0, '0th percentile is the min');
  assert.strictEqual(P(asc, 1), 100, '100th percentile is the max');
  assert.strictEqual(P(asc, 0.5), 50, 'median of 0..100 is 50');
  assert.strictEqual(P(asc, 0.02), 2, '2nd percentile clips low outliers');
  assert.strictEqual(P(asc, 0.98), 98, '98th percentile clips high outliers');

  // Unsorted input must not be mutated.
  const src = [9, 1, 5, 3, 7];
  const copy = [...src];
  P(src, 0.5);
  assert.deepStrictEqual(src, copy, 'input array left unsorted');

  // _percentileSorted takes an already-sorted array and does not re-sort/copy.
  const PS = window.GSRUI._percentileSorted;
  assert.strictEqual(PS([10, 20, 30, 40], 0.5), 25, 'sorted median by interpolation');
  assert.strictEqual(PS([], 0.5), 0, 'empty → 0');
});

test('GSRUI.drawRegressionScatter: continuous X plots points + trend + badge, binary X draws per-group boxes, empty data plots nothing (fake 2D context)', () => {
  const { window } = bootApp();
  // jsdom has no real canvas 2D context — record calls on a permissive stub so
  // the drawing logic (percentile clip, density loop, binary box-and-whisker
  // branch, badge) is exercised end to end.
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'measureText') return () => ({ width: 20 });
      if (prop === 'canvas') return { width: 300, height: 200 };
      return (...args) => { calls.push([prop, ...args]); };
    },
    set: () => true
  });
  const canvas = { width: 300, height: 200, getContext: () => ctx };

  const opsFor = (fn) => { calls.length = 0; fn(); return calls.map(c => c[0]); };

  const xCont = Array.from({ length: 500 }, (_, i) => (i % 97) + (i > 480 ? 5000 : 0)); // + a few spikes
  const yCont = Array.from({ length: 500 }, (_, i) => Math.sin(i / 11) + (i % 5) * 0.2);
  const contOps = opsFor(() =>
    window.GSRUI.drawRegressionScatter(canvas, xCont, yCont, 0.01, 1, 0.04, 'X', 'Y', false));
  assert.ok(contOps.includes('arc'), 'continuous path plots point markers (ctx.arc)');
  assert.ok(contOps.includes('fillText'), 'continuous path draws axis labels / R² badge (ctx.fillText)');
  assert.ok(contOps.includes('stroke') || contOps.includes('lineTo'), 'continuous path draws the OLS trend line');

  const xBin = Array.from({ length: 400 }, (_, i) => (i % 3 === 0 ? 1 : 0));
  const yBin = Array.from({ length: 400 }, (_, i) => (i % 3 === 0 ? 2 + (i % 7) * 0.1 : 1 + (i % 7) * 0.1));
  const binOps = opsFor(() =>
    window.GSRUI.drawRegressionScatter(canvas, xBin, yBin, 0.9, 1, 0.2, 'In Park', 'Phasic', true));
  assert.ok(binOps.filter(o => o === 'rect' || o === 'fillRect' || o === 'strokeRect').length >= 2,
    'binary path draws a box-and-whisker box per group (>= 2 rect ops)');
  assert.ok(binOps.includes('fillText'), 'binary path still draws the point-biserial r badge');

  const emptyOps = opsFor(() =>
    window.GSRUI.drawRegressionScatter(canvas, [], [], 0, 0, 0, 'X', 'Y', false));
  assert.ok(!emptyOps.includes('arc'), 'empty data path plots no point markers');
});
