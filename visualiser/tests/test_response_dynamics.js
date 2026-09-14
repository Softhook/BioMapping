const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ResponseDynamics } = require('../src/signal/response_dynamics.js');
global.ResponseDynamics = ResponseDynamics;

// Load real constants.js
const constantsSrc = fs.readFileSync(path.join(__dirname, '../src/core/constants.js'), 'utf8');
const GSR_CONST = vm.runInNewContext(constantsSrc + '\n; GSR_CONST;', { ResponseDynamics });
global.GSR_CONST = GSR_CONST;

const SCRDeconvolution = require('../src/signal/deconvolution.js');
global.SCRDeconvolution = SCRDeconvolution;
const { GsrFilter } = require('../src/signal/gsr_filter.js');
global.GsrFilter = GsrFilter;

const { MapColors } = require('../src/map/map_colors.js');
const { GSRAnalyzer } = require('../src/signal/analyzer.js');

test('Response Dynamics: ResponseDynamics domain module unit tests', () => {
  // 1. Canonical scales & labels
  assert.deepStrictEqual(ResponseDynamics.SCALE_FACTORS, [0.5, 0.75, 1.0, 1.25, 1.5]);
  assert.deepStrictEqual(ResponseDynamics.SPEED_LABELS, ['Very Slow', 'Slow', 'Standard', 'Fast', 'Very Fast']);

  // 2. Band resolution
  assert.strictEqual(ResponseDynamics.getBand(0.5).label, 'Very Slow');
  assert.strictEqual(ResponseDynamics.getBand(0.75).label, 'Slow');
  assert.strictEqual(ResponseDynamics.getBand(1.0).label, 'Standard');
  assert.strictEqual(ResponseDynamics.getBand(1.25).label, 'Fast');
  assert.strictEqual(ResponseDynamics.getBand(1.5).label, 'Very Fast');
  assert.strictEqual(ResponseDynamics.getBand(0.0), null);
  assert.strictEqual(ResponseDynamics.getBand(-1.0), null);
  assert.strictEqual(ResponseDynamics.getBand(NaN), null);

  // 3. Bucket index (0 for resting, 1..5 for speed bands)
  assert.strictEqual(ResponseDynamics.getBucketIndex(0.0), 0);
  assert.strictEqual(ResponseDynamics.getBucketIndex(NaN), 0);
  assert.strictEqual(ResponseDynamics.getBucketIndex(0.5), 1);
  assert.strictEqual(ResponseDynamics.getBucketIndex(0.75), 2);
  assert.strictEqual(ResponseDynamics.getBucketIndex(1.0), 3);
  assert.strictEqual(ResponseDynamics.getBucketIndex(1.25), 4);
  assert.strictEqual(ResponseDynamics.getBucketIndex(1.5), 5);

  // 4. Colors
  assert.strictEqual(ResponseDynamics.getColor(0.0), 'transparent');
  assert.strictEqual(ResponseDynamics.getColor(0.5), '#8b5cf6');
  assert.strictEqual(ResponseDynamics.getColor(1.0), '#10b981');
  assert.strictEqual(ResponseDynamics.getColor(1.5), '#ef4444');

  // 5. Tooltip formatting
  const tipRest = ResponseDynamics.formatTooltip(0.0, '#999999');
  assert.strictEqual(tipRest.valueStr, 'Resting');
  assert.strictEqual(tipRest.color, '#999999');

  const tipFast = ResponseDynamics.formatTooltip(1.25);
  assert.strictEqual(tipFast.valueStr, '1.25x (Fast)');
  assert.strictEqual(tipFast.color, '#f97316');

  // 6. Peak tagging & statistics
  const dummyPeaks = [
    { index: 10, amplitude: 0.5 },
    { index: 50, amplitude: 0.8 }
  ];
  const dummyDrivers = [
    { index: 8, amplitude: 0.5, speedLabel: 'Very Fast', scaleFactor: 1.5, bandIdx: 4 },
    { index: 48, amplitude: 0.8, speedLabel: 'Slow', scaleFactor: 0.75, bandIdx: 1 }
  ];
  const stats = ResponseDynamics.tagPeaks(dummyPeaks, dummyDrivers, 4);
  assert.strictEqual(dummyPeaks[0].speedLabel, 'Very Fast');
  assert.strictEqual(dummyPeaks[0].scaleFactor, 1.5);
  assert.strictEqual(dummyPeaks[1].speedLabel, 'Slow');
  assert.strictEqual(dummyPeaks[1].scaleFactor, 0.75);
  assert.strictEqual(stats.totalTaggedPeaks, 2);
  assert.strictEqual(stats.speedCounts['Very Fast'], 1);
  assert.strictEqual(stats.speedCounts['Slow'], 1);
});

test('Response Dynamics: constants definitions', () => {
  assert.ok(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics, 'responseDynamics is registered in LOWER_GRAPH_MODES');
  assert.strictEqual(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics.unit, 'μS');
  assert.strictEqual(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics.decimals, 3);

  assert.ok(GSR_CONST.SPARSEDA_SPEED_COLORS, 'SPARSEDA_SPEED_COLORS is defined');
  const speeds = ['Very Slow', 'Slow', 'Standard', 'Fast', 'Very Fast'];
  for (const s of speeds) {
    assert.ok(GSR_CONST.SPARSEDA_SPEED_COLORS[s], `Color exists for speed ${s}`);
  }
});

test('Response Dynamics: MapColors.getColorForMetric integration', () => {
  // Test Resting / Inactive (val <= 0 or NaN)
  const cRest = MapColors.getColorForMetric('responseDynamics', 0.0);
  assert.strictEqual(cRest, 'transparent', '0.0 maps to transparent resting color');

  const cNan = MapColors.getColorForMetric('responseDynamics', NaN);
  assert.strictEqual(cNan, 'transparent', 'NaN maps to transparent resting color');

  // Test 0.5x (Very Slow, Purple)
  const c05 = MapColors.getColorForMetric('responseDynamics', 0.5);
  assert.strictEqual(c05, '#8b5cf6');

  // Test 1.0x (Standard, Green)
  const c10 = MapColors.getColorForMetric('responseDynamics', 1.0);
  assert.strictEqual(c10, '#10b981');

  // Test 1.5x (Very Fast, Red)
  const c15 = MapColors.getColorForMetric('responseDynamics', 1.5);
  assert.strictEqual(c15, '#ef4444');
});

test('Response Dynamics: GSRAnalyzer delegation & peak exclusion reactivity', () => {
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
  analyzer.responseDynamics = analyzer.computeResponseDynamics();
  assert.strictEqual(analyzer.responseDynamics.length, n);
  assert.strictEqual(analyzer.responseDynamics[100].val, 1.5);
  assert.strictEqual(analyzer.responseDynamics[0].val, 0.0);
  assert.strictEqual(analyzer.responseDynamics[250].val, 0.0);

  const fastActiveCount = analyzer.responseDynamics.filter(d => d.val > 0).length;

  // Case 3: One slow peak (scale 0.5x) at index 100 (t=25s)
  analyzer.peaks = [
    { index: 100, time: 25, scaleFactor: 0.5, amplitude: 0.5, excluded: false }
  ];
  const dynSlow = analyzer.computeResponseDynamics();
  assert.strictEqual(dynSlow[100].val, 0.5);
  const slowActiveCount = dynSlow.filter(d => d.val > 0).length;

  // Slower peak MUST have a significantly longer active footprint on the ground/track than fast peak
  assert.ok(slowActiveCount > fastActiveCount * 2, `Slow event footprint (${slowActiveCount}) should be >2x fast footprint (${fastActiveCount})`);

  // Case 4: Reactivity to setPeakExcluded()
  analyzer.setPeakExcluded(0, true);
  // Since peak 0 is now excluded, responseDynamics should automatically update to resting baseline
  assert.strictEqual(analyzer.responseDynamics[100].val, 0.0, 'Excluded peak automatically clears response dynamics series');

  // Case 5: _runDeconvolutionPipeline clears sparsedaStats and responseDynamics on re-run
  analyzer.sparsedaStats = { dummy: true };
  analyzer.responseDynamics = [{ time: 0, val: 1.0 }];
  analyzer._runDeconvolutionPipeline([], { deconvAlgorithm: 'matching_pursuit' });
  assert.strictEqual(analyzer.sparsedaStats, null, 'sparsedaStats reset on switching deconv algorithm');
  assert.deepStrictEqual(analyzer.responseDynamics, [], 'responseDynamics reset on switching deconv algorithm');
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
