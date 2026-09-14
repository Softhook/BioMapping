const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load real constants.js
const constantsSrc = fs.readFileSync(path.join(__dirname, '../src/core/constants.js'), 'utf8');
const GSR_CONST = vm.runInNewContext(constantsSrc + '\n; GSR_CONST;', {});
global.GSR_CONST = GSR_CONST;

const { MapColors } = require('../src/map/map_colors.js');
const { GSRAnalyzer } = require('../src/signal/analyzer.js');

test('Response Dynamics: constants definitions', () => {
  assert.ok(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics, 'responseDynamics is registered in LOWER_GRAPH_MODES');
  assert.strictEqual(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics.unit, 'x');
  assert.strictEqual(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics.decimals, 2);

  assert.ok(GSR_CONST.SPARSEDA_SPEED_COLORS, 'SPARSEDA_SPEED_COLORS is defined');
  const speeds = ['Very Slow', 'Slow', 'Standard', 'Fast', 'Very Fast'];
  for (const s of speeds) {
    assert.ok(GSR_CONST.SPARSEDA_SPEED_COLORS[s], `Color exists for speed ${s}`);
  }
});

test('Response Dynamics: MapColors.getColorForMetric', () => {
  // Test Resting / Inactive (val <= 0 or NaN)
  const cRest = MapColors.getColorForMetric('responseDynamics', 0.0);
  assert.strictEqual(cRest, 'transparent', '0.0 maps to transparent resting color');

  const cNan = MapColors.getColorForMetric('responseDynamics', NaN);
  assert.strictEqual(cNan, 'transparent', 'NaN maps to transparent resting color');

  // Test 0.5x (Very Slow, Purple)
  const c05 = MapColors.getColorForMetric('responseDynamics', 0.5);
  assert.ok(c05.startsWith('hsl(265,'), `0.5x maps to purple: ${c05}`);

  // Test 1.0x (Standard, Green)
  const c10 = MapColors.getColorForMetric('responseDynamics', 1.0);
  assert.ok(c10.startsWith('hsl(150,'), `1.0x maps to green: ${c10}`);

  // Test 1.5x (Very Fast, Red)
  const c15 = MapColors.getColorForMetric('responseDynamics', 1.5);
  assert.ok(c15.startsWith('hsl(0,'), `1.5x maps to red: ${c15}`);

  // Test out-of-bounds clamping
  const cLow = MapColors.getColorForMetric('responseDynamics', 0.1);
  assert.strictEqual(cLow, c05, 'Values below 0.5x are clamped to 0.5x');

  const cHigh = MapColors.getColorForMetric('responseDynamics', 3.0);
  assert.strictEqual(cHigh, c15, 'Values above 1.5x are clamped to 1.5x');
});

test('Response Dynamics: GSRAnalyzer.computeResponseDynamics event-gating', () => {
  const analyzer = new GSRAnalyzer();
  const n = 300;
  const sampleRate = 4;
  analyzer.sampleRate = sampleRate;
  analyzer.times = new Float64Array(n);
  for (let i = 0; i < n; i++) analyzer.times[i] = i / sampleRate;
  analyzer._driverAlgorithm = 'sparseda';

  // Case 1: No peaks -> all 0.0 (Resting)
  analyzer.peaks = [];
  const dynQuiet = analyzer.computeResponseDynamics();
  assert.strictEqual(dynQuiet.length, n);
  assert.strictEqual(dynQuiet[0].val, 0.0);
  assert.strictEqual(dynQuiet[50].val, 0.0);

  // Case 2: One fast peak (scale 1.5x) at index 100 (t=25s)
  analyzer.peaks = [
    { index: 100, time: 25, scaleFactor: 1.5, amplitude: 0.5, excluded: false }
  ];
  const dynFast = analyzer.computeResponseDynamics();
  assert.strictEqual(dynFast.length, n);
  // At the peak itself, speed is 1.5
  assert.strictEqual(dynFast[100].val, 1.5);
  // Far from peak (index 0 and index 250), speed is 0.0 (Resting)
  assert.strictEqual(dynFast[0].val, 0.0);
  assert.strictEqual(dynFast[250].val, 0.0);

  const fastActiveCount = dynFast.filter(d => d.val > 0).length;

  // Case 3: One slow peak (scale 0.5x) at index 100 (t=25s)
  analyzer.peaks = [
    { index: 100, time: 25, scaleFactor: 0.5, amplitude: 0.5, excluded: false }
  ];
  const dynSlow = analyzer.computeResponseDynamics();
  assert.strictEqual(dynSlow[100].val, 0.5);
  const slowActiveCount = dynSlow.filter(d => d.val > 0).length;

  // Slower peak MUST have a significantly longer active footprint on the ground/track than fast peak
  assert.ok(slowActiveCount > fastActiveCount * 2, `Slow event footprint (${slowActiveCount}) should be >2x fast footprint (${fastActiveCount})`);
});

test('Response Dynamics: UI sync logic', () => {
  const { GSRUI } = require('../src/ui/ui.js');
  global.AppState = {
    analyzer: {
      _driverAlgorithm: 'sparseda'
    },
    sliders: {
      graphView: {
        value: 'signal',
        querySelector: (sel) => {
          if (sel === 'option[value="responseDynamics"]') return { disabled: true };
          return null;
        }
      }
    }
  };

  // Mock document
  const mapOption = { disabled: true };
  global.document = {
    getElementById: (id) => {
      if (id === 'graphView') return global.AppState.sliders.graphView;
      if (id === 'mapColoringMetric') {
        return {
          value: 'gsr',
          querySelector: (sel) => {
            if (sel === 'option[value="responseDynamics"]') return mapOption;
            return null;
          },
          dispatchEvent: () => {}
        };
      }
      return null;
    }
  };

  // 1. In SparsEDA mode: options should become enabled (disabled = false)
  GSRUI.syncResponseDynamicsOptions();
  assert.strictEqual(mapOption.disabled, false, 'Map option should be enabled when SparsEDA is active');

  // 2. When switching away from SparsEDA: options should become disabled
  global.AppState.analyzer._driverAlgorithm = 'matching_pursuit';
  let mapEventDispatched = false;
  const mapElem = {
    value: 'responseDynamics',
    querySelector: (sel) => (sel === 'option[value="responseDynamics"]' ? mapOption : null),
    dispatchEvent: () => { mapEventDispatched = true; }
  };
  global.document.getElementById = (id) => (id === 'mapColoringMetric' ? mapElem : global.AppState.sliders.graphView);

  GSRUI.syncResponseDynamicsOptions();
  assert.strictEqual(mapOption.disabled, true, 'Map option should be disabled when SparsEDA is inactive');
  assert.strictEqual(mapElem.value, 'gsr', 'Map selection should reset to gsr when SparsEDA is disabled');
  assert.strictEqual(mapEventDispatched, true, 'Map change event dispatched on reset');
});
