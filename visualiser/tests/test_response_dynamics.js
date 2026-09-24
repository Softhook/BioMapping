const test = require('node:test');
const assert = require('node:assert');

const { ResponseDynamics } = require('../src/signal/response_dynamics.mjs');
global.ResponseDynamics = ResponseDynamics;

// Load real constants.js
const { GSR_CONST } = require('../src/core/constants.mjs');
global.GSR_CONST = GSR_CONST;

const { SCRDeconvolution } = require('../src/signal/deconvolution.mjs');
global.SCRDeconvolution = SCRDeconvolution;
const { GsrFilter } = require('../src/signal/gsr_filter.mjs');
global.GsrFilter = GsrFilter;

const { MapColors } = require('../src/map/map_colors.mjs');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');

test('Response Dynamics: ResponseDynamics domain module unit tests', () => {
  // 1. Canonical labels (ascending speed factor)
  assert.deepStrictEqual(ResponseDynamics.SPEED_LABELS, [
    'Very drawn-out',
    'Drawn-out',
    'Typical',
    'Brief',
    'Sharp',
  ]);

  // 2. Band resolution
  assert.strictEqual(ResponseDynamics.getBand(0.5).label, 'Very drawn-out');
  assert.strictEqual(ResponseDynamics.getBand(0.75).label, 'Drawn-out');
  assert.strictEqual(ResponseDynamics.getBand(1.0).label, 'Typical');
  assert.strictEqual(ResponseDynamics.getBand(1.25).label, 'Brief');
  assert.strictEqual(ResponseDynamics.getBand(1.5).label, 'Sharp');
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

  const tipBrief = ResponseDynamics.formatTooltip(1.25);
  assert.strictEqual(tipBrief.valueStr, '1.25x (Brief)');
  assert.strictEqual(tipBrief.color, '#f97316');

  // 6. Peak tagging & statistics (fallback path: no kernels, so the
  // strongest atom's own label is used)
  const dummyPeaks = [
    { index: 10, amplitude: 0.5 },
    { index: 50, amplitude: 0.8 },
  ];
  const dummyDrivers = [
    { index: 8, amplitude: 0.5, speedLabel: 'Sharp', scaleFactor: 1.5 },
    { index: 48, amplitude: 0.8, speedLabel: 'Drawn-out', scaleFactor: 0.75 },
  ];
  const stats = ResponseDynamics.tagPeaks(dummyPeaks, dummyDrivers, 4);
  assert.strictEqual(dummyPeaks[0].speedLabel, 'Sharp');
  assert.strictEqual(dummyPeaks[0].scaleFactor, 1.5);
  assert.strictEqual(dummyPeaks[1].speedLabel, 'Drawn-out');
  assert.strictEqual(dummyPeaks[1].scaleFactor, 0.75);
  assert.strictEqual(stats.totalTaggedPeaks, 2);
  assert.strictEqual(stats.speedCounts.Sharp, 1);
  assert.strictEqual(stats.speedCounts['Drawn-out'], 1);
});

test('Response Dynamics: tagPeaks picks the tallest bump, not the biggest slow-band coefficient', () => {
  // A slow-band atom needs a larger coefficient than a fast-band one for the
  // same bump (unit-energy kernels), so raw coefficients must not decide.
  const peaks = [{ index: 20, onsetIndex: 10 }];
  const drivers = [
    { index: 12, amplitude: 1.0, height: 0.31, speedLabel: 'Sharp' },
    { index: 11, amplitude: 1.5, height: 0.27, speedLabel: 'Very drawn-out' },
  ];
  ResponseDynamics.tagPeaks(peaks, drivers, 10);
  assert.strictEqual(peaks[0].speedLabel, 'Sharp');
});

test('Response Dynamics: speedFor allows for size — a bigger response is expected to rise more slowly', () => {
  const RD = ResponseDynamics;
  const rise = RD.REFERENCE_RISE_SEC;
  assert.strictEqual(RD.speedFor(rise, RD.REFERENCE_HEIGHT).scaleFactor, 1);
  const big = RD.speedFor(rise, RD.REFERENCE_HEIGHT * 5).scaleFactor;
  const small = RD.speedFor(rise, RD.REFERENCE_HEIGHT / 5).scaleFactor;
  assert.ok(big > 1 && small < 1, `big ${big}, small ${small}`);
  // No height: no size term.
  assert.strictEqual(RD.speedFor(rise).scaleFactor, 1);
});

test('SparsEDA: each atom is labelled from its template rise time', () => {
  const FS = 10;
  const bat = (t, ts, tf) =>
    t <= 0 ? 0 : Math.exp(-t / ts) - Math.exp(-t / tf);
  const topAtom = (stretch) => {
    const y = new Float64Array(60 * FS);
    for (let i = 0; i < y.length; i++)
      y[i] = bat(i / FS - 10, 2 * stretch, 0.5 * stretch);
    const r = SCRDeconvolution.deconvolve(y, FS, {
      algorithm: 'sparseda',
      zeroBaseline: true,
      rho: 0,
    });
    return r.impulseLog.reduce((a, b) => (b.height > a.height ? b : a));
  };
  const quick = topAtom(0.5);
  const mid = topAtom(1.0);
  const slow = topAtom(1.5);
  assert.strictEqual(quick.durationScale, 0.5);
  assert.strictEqual(slow.durationScale, 1.5);
  assert.strictEqual(quick.speedLabel, 'Sharp');
  assert.ok(quick.scaleFactor > mid.scaleFactor);
  assert.ok(mid.scaleFactor > slow.scaleFactor);
});

test('Response Dynamics: peak rise time is measured beyond the dictionary range, and very sharp rises are flagged', () => {
  // Three isolated responses: compressed (true 10%-to-apex rise 0.45 s),
  // dictionary-standard (0.89 s), and three times slower (2.67 s) — far
  // slower than the slowest dictionary kernel (1.34 s). The model alone
  // can't express that; the signal-side measurement must.
  const FS = 10;
  const bat = (t, ts, tf) =>
    t <= 0 ? 0 : Math.exp(-t / ts) - Math.exp(-t / tf);
  const events = [
    [10, 0.5],
    [40, 1.0],
    [70, 3.0],
  ];
  const y = new Float64Array(110 * FS);
  for (const [t0, s] of events)
    for (let i = 0; i < y.length; i++) y[i] += bat(i / FS - t0, 2 * s, 0.5 * s);
  const r = SCRDeconvolution.deconvolve(y, FS, {
    algorithm: 'sparseda',
    zeroBaseline: true,
    rho: 0,
  });
  const drivers = r.impulseLog.map((e) => ({ ...e, index: e.trueIndex }));
  const peaksFor = () =>
    events.map(([t0]) => {
      let apex = t0 * FS;
      while (y[apex + 1] > y[apex]) apex++;
      return { index: apex, onsetIndex: t0 * FS };
    });
  const kinetics = { bandKernels: r.bandKernels, workRate: r.workRate };

  const modelOnly = peaksFor();
  ResponseDynamics.tagPeaks(modelOnly, drivers, FS, kinetics);
  const peaks = peaksFor();
  ResponseDynamics.tagPeaks(peaks, drivers, FS, { ...kinetics, signal: y });

  const [quick, standard, slow] = peaks;
  assert.ok(quick.speedRiseTime < standard.speedRiseTime);
  assert.ok(standard.speedRiseTime < slow.speedRiseTime);
  assert.ok(
    Math.abs(slow.speedRiseTime - 2.67) < 0.3,
    `slow rise ${slow.speedRiseTime} (model alone ${modelOnly[2].speedRiseTime})`,
  );
  assert.ok(modelOnly[2].speedRiseTime < slow.speedRiseTime);
  assert.strictEqual(slow.speedLabel, 'Very drawn-out');
  assert.strictEqual(quick.speedLabel, 'Sharp');
  assert.strictEqual(quick.possibleArtefact, true);
  assert.strictEqual(standard.possibleArtefact, false);
  assert.strictEqual(slow.possibleArtefact, false);
});

test('Response Dynamics: constants definitions', () => {
  assert.ok(
    GSR_CONST.LOWER_GRAPH_MODES.responseDynamics,
    'responseDynamics is registered in LOWER_GRAPH_MODES',
  );
  assert.strictEqual(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics.unit, 'μS');
  assert.strictEqual(GSR_CONST.LOWER_GRAPH_MODES.responseDynamics.decimals, 3);

  assert.ok(
    GSR_CONST.SPARSEDA_SPEED_COLORS,
    'SPARSEDA_SPEED_COLORS is defined',
  );
  for (const s of ResponseDynamics.SPEED_LABELS) {
    assert.ok(
      GSR_CONST.SPARSEDA_SPEED_COLORS[s],
      `Color exists for speed ${s}`,
    );
  }
});

test('Response Dynamics: MapColors.getColorForMetric integration', () => {
  // Test Resting / Inactive (val <= 0 or NaN)
  const cRest = MapColors.getColorForMetric('responseDynamics', 0.0);
  assert.strictEqual(
    cRest,
    'transparent',
    '0.0 maps to transparent resting color',
  );

  const cNan = MapColors.getColorForMetric('responseDynamics', NaN);
  assert.strictEqual(
    cNan,
    'transparent',
    'NaN maps to transparent resting color',
  );

  // Test 0.5x (Very drawn-out, Purple)
  const c05 = MapColors.getColorForMetric('responseDynamics', 0.5);
  assert.strictEqual(c05, '#8b5cf6');

  // Test 1.0x (Typical, Green)
  const c10 = MapColors.getColorForMetric('responseDynamics', 1.0);
  assert.strictEqual(c10, '#10b981');

  // Test 1.5x (Sharp, Red)
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
    { index: 100, time: 25, scaleFactor: 1.5, amplitude: 0.5, excluded: false },
  ];
  analyzer.responseDynamics = analyzer.computeResponseDynamics();
  assert.strictEqual(analyzer.responseDynamics.length, n);
  assert.strictEqual(analyzer.responseDynamics[100].val, 1.5);
  assert.strictEqual(analyzer.responseDynamics[0].val, 0.0);
  assert.strictEqual(analyzer.responseDynamics[250].val, 0.0);

  const fastActiveCount = analyzer.responseDynamics.filter(
    (d) => d.val > 0,
  ).length;

  // Case 3: One slow peak (scale 0.5x) at index 100 (t=25s)
  analyzer.peaks = [
    { index: 100, time: 25, scaleFactor: 0.5, amplitude: 0.5, excluded: false },
  ];
  const dynSlow = analyzer.computeResponseDynamics();
  assert.strictEqual(dynSlow[100].val, 0.5);
  const slowActiveCount = dynSlow.filter((d) => d.val > 0).length;

  // Slower peak MUST have a significantly longer active footprint on the ground/track than fast peak
  assert.ok(
    slowActiveCount > fastActiveCount * 2,
    `Slow event footprint (${slowActiveCount}) should be >2x fast footprint (${fastActiveCount})`,
  );

  // Case 4: Reactivity to setPeakExcluded()
  analyzer.setPeakExcluded(0, true);
  // Since peak 0 is now excluded, responseDynamics should automatically update to resting baseline
  assert.strictEqual(
    analyzer.responseDynamics[100].val,
    0.0,
    'Excluded peak automatically clears response dynamics series',
  );

  // Case 5: _runDeconvolutionPipeline clears sparsedaStats and responseDynamics on re-run
  analyzer.sparsedaStats = { dummy: true };
  analyzer.responseDynamics = [{ time: 0, val: 1.0 }];
  analyzer._runDeconvolutionPipeline([], {
    deconvAlgorithm: 'matching_pursuit',
  });
  assert.strictEqual(
    analyzer.sparsedaStats,
    null,
    'sparsedaStats reset on switching deconv algorithm',
  );
  assert.deepStrictEqual(
    analyzer.responseDynamics,
    [],
    'responseDynamics reset on switching deconv algorithm',
  );
});

test('Response Dynamics: UI sync logic', () => {
  global.window = global;
  const { GSRUI } = require('../src/ui/ui.mjs');
  // ui_stats_panel.mjs holds a real static `import { AppState } from
  // '../core/app_state.mjs'` binding, not a bare global lookup — replacing
  // global.AppState wholesale is inert against it. Mutate the real
  // singleton's own fields in place instead (same pattern as layer 2's
  // GSR_CONST fix).
  const { AppState: RealAppState } = require('../src/core/app_state.mjs');
  const original = {
    analyzer: RealAppState.analyzer,
    sliders: RealAppState.sliders,
  };
  RealAppState.analyzer = { _driverAlgorithm: 'sparseda' };
  RealAppState.sliders = {
    graphView: {
      value: 'signal',
      querySelector: (sel) => {
        if (sel === 'option[value="responseDynamics"]')
          return { disabled: true };
        return null;
      },
    },
  };

  try {
    // Mock document
    const mapOption = { disabled: true };
    global.document = {
      getElementById: (id) => {
        if (id === 'graphView') return RealAppState.sliders.graphView;
        if (id === 'mapColoringMetric') {
          return {
            value: 'gsr',
            querySelector: (sel) => {
              if (sel === 'option[value="responseDynamics"]') return mapOption;
              return null;
            },
            dispatchEvent: () => {},
          };
        }
        return null;
      },
    };

    // 1. In SparsEDA mode: options should become enabled (disabled = false)
    GSRUI.syncResponseDynamicsOptions();
    assert.strictEqual(
      mapOption.disabled,
      false,
      'Map option should be enabled when SparsEDA is active',
    );

    // 2. When switching away from SparsEDA: options should become disabled
    RealAppState.analyzer._driverAlgorithm = 'matching_pursuit';
    let mapEventDispatched = false;
    const mapElem = {
      value: 'responseDynamics',
      querySelector: (sel) =>
        sel === 'option[value="responseDynamics"]' ? mapOption : null,
      dispatchEvent: () => {
        mapEventDispatched = true;
      },
    };
    global.document.getElementById = (id) =>
      id === 'mapColoringMetric' ? mapElem : RealAppState.sliders.graphView;

    GSRUI.syncResponseDynamicsOptions();
    assert.strictEqual(
      mapOption.disabled,
      true,
      'Map option should be disabled when SparsEDA is inactive',
    );
    assert.strictEqual(
      mapElem.value,
      'gsr',
      'Map selection should reset to gsr when SparsEDA is disabled',
    );
    assert.strictEqual(
      mapEventDispatched,
      true,
      'Map change event dispatched on reset',
    );
  } finally {
    Object.assign(RealAppState, original);
  }
});
