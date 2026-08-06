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
  assert.ok(html.includes('GSR Arousal (Raw)'), 'Should contain GSR Arousal title');
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
