const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');

const { loadModule } = require('./support/load_module.js');

loadModule(path.join(__dirname, '../src/signal/dwt_filter.js'), 'DWT');
loadModule(path.join(__dirname, '../src/signal/gsr_filter.js'), 'GsrFilter');
loadModule(
  path.join(__dirname, '../src/signal/deconvolution.js'),
  'SCRDeconvolution',
);
loadModule(path.join(__dirname, '../src/signal/csv_parser.js'), 'GSRCSVParser');
loadModule(
  path.join(__dirname, '../src/signal/response_dynamics.js'),
  'ResponseDynamics',
);
loadModule(path.join(__dirname, '../src/signal/analyzer.js'), 'GSRAnalyzer');

const { GSRAnalyzer, SCRDeconvolution } = global;
const SR = 10;

function buildSyntheticCSV(scrs, durationSec, tonicLevel = 2.0) {
  const n = Math.round(durationSec * SR);
  const kernel = SCRDeconvolution.buildSCRFKernel(SR, 2.0, 0.75, 10.0);
  const phasic = new Float64Array(n);
  const rows = ['time,gsr'];
  for (const scr of scrs) {
    const onset = Math.round(scr.onsetSec * SR);
    for (let k = 0; k < kernel.length && onset + k < n; k++) {
      phasic[onset + k] += scr.amplitude * kernel[k];
    }
  }
  for (let i = 0; i < n; i++)
    rows.push(`${(i / SR).toFixed(3)},${(tonicLevel + phasic[i]).toFixed(6)}`);
  return rows.join('\n');
}

test('GSRAnalyzer uses the reference SparsEDA path on a synthetic track', () => {
  const csvText = buildSyntheticCSV(
    [
      { onsetSec: 15, amplitude: 0.22 },
      { onsetSec: 45, amplitude: 0.18 },
      { onsetSec: 75, amplitude: 0.2 },
    ],
    110,
  );

  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(csvText);
  analyzer.analyze({
    ...global.GSR_CONST.GSR_DEFAULT,
    tonicMethod: 'percentile',
    tonicWindow: 15,
    peakThreshold: 0.02,
    minPeakQuality: 0.0,
    shapeMinSnr: 0,
    useDeconvolution: true,
    deconvAlgorithm: 'sparseda',
  });

  assert.strictEqual(analyzer.phasicDriver.length, analyzer.raw.length);
  assert.strictEqual(analyzer.phasicClean.length, analyzer.raw.length);
  assert.strictEqual(typeof analyzer.phasicDeconvTruncated, 'boolean');
  assert.ok(
    analyzer.phasicDriver.some((d) => d.val > 0),
    'SparsEDA should produce sparse driver activity',
  );
  assert.strictEqual(
    analyzer.phasicDriverPeaks.length,
    analyzer.phasicDriver.filter((d) => d.val > 0).length,
    'SparsEDA analyzer should preserve the solver-kept driver events',
  );
  assert.ok(
    analyzer.peaks.length >= 3,
    `expected at least 3 detected peaks, got ${analyzer.peaks.length}`,
  );
});

test('GSRAnalyzer activates SparsEDA via useSparsEDA: true toggle directly', () => {
  const csvText = buildSyntheticCSV(
    [
      { onsetSec: 20, amplitude: 0.25 },
      { onsetSec: 50, amplitude: 0.2 },
    ],
    80,
  );

  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(csvText);
  analyzer.analyze({
    ...global.GSR_CONST.GSR_DEFAULT,
    tonicMethod: 'percentile',
    tonicWindow: 15,
    peakThreshold: 0.02,
    minPeakQuality: 0.0,
    shapeMinSnr: 0,
    useSparsEDA: true,
  });

  assert.strictEqual(analyzer._driverAlgorithm, 'sparseda');
  assert.strictEqual(analyzer.phasicDriver.length, analyzer.raw.length);
  assert.strictEqual(analyzer.phasicClean.length, analyzer.raw.length);
  assert.ok(
    analyzer.phasicDriver.some((d) => d.val > 0),
    'useSparsEDA should produce sparse driver activity',
  );
  assert.ok(
    analyzer.peaks.length >= 2,
    `expected at least 2 detected peaks, got ${analyzer.peaks.length}`,
  );
});

test('SparsEDA annotates peaks with speed profiling and generates track dynamics stats', () => {
  const csvText = buildSyntheticCSV(
    [
      { onsetSec: 15, amplitude: 0.25 },
      { onsetSec: 35, amplitude: 0.3 },
      { onsetSec: 55, amplitude: 0.2 },
      { onsetSec: 75, amplitude: 0.28 },
    ],
    100,
  );

  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(csvText);
  analyzer.analyze({
    ...global.GSR_CONST.GSR_DEFAULT,
    tonicMethod: 'percentile',
    tonicWindow: 15,
    peakThreshold: 0.02,
    minPeakQuality: 0.0,
    shapeMinSnr: 0,
    useSparsEDA: true,
  });

  assert.ok(
    analyzer.peaks.length >= 4,
    `expected at least 4 peaks, got ${analyzer.peaks.length}`,
  );
  assert.ok(analyzer.sparsedaStats, 'sparsedaStats should be defined');
  assert.ok(typeof analyzer.sparsedaStats.dominantSpeed === 'string');
  assert.ok(typeof analyzer.sparsedaStats.meanScaleFactor === 'number');
  assert.strictEqual(typeof analyzer.sparsedaStats.speedCounts, 'object');

  for (const peak of analyzer.peaks) {
    assert.ok(peak.speedLabel, `peak at ${peak.time} should have speedLabel`);
    assert.ok(
      typeof peak.scaleFactor === 'number',
      `peak at ${peak.time} should have numeric scaleFactor`,
    );
    assert.ok(
      peak.bandIdx >= 0 && peak.bandIdx <= 4,
      `peak at ${peak.time} should have valid bandIdx`,
    );
  }
});

test('SparsEDA runs without premature truncation on the fixture track', () => {
  const fixturePath = path.join(__dirname, '../fixtures/default_processed.csv');
  assert.ok(fs.existsSync(fixturePath), 'fixture file must exist');

  const csvText = fs.readFileSync(fixturePath, 'utf8');
  const analyzer = new GSRAnalyzer();
  analyzer.parseCSV(csvText);
  analyzer.analyze({
    ...global.GSR_CONST.GSR_DEFAULT,
    peakThreshold: 0.02,
    minPeakQuality: 0.0,
    shapeMinSnr: 0,
    useSparsEDA: true,
  });

  assert.strictEqual(
    analyzer.phasicDeconvTruncated,
    false,
    'Continuous track should not be flagged as truncated',
  );
  assert.ok(
    analyzer.peaks.length > 50,
    `Expected > 50 peaks with fixed LARS on fixture track, got ${analyzer.peaks.length}`,
  );
  assert.ok(analyzer.sparsedaStats, 'Track dynamics stats should be computed');
  assert.ok(
    analyzer.sparsedaStats.dominantSpeed,
    'Dominant speed should be computed',
  );

  const tonicAboveSignal = analyzer.tonic.filter(
    (d, i) => d.val > analyzer.filtered[i].val + 1e-6,
  ).length;
  assert.strictEqual(
    tonicAboveSignal,
    0,
    'SparsEDA tonic baseline must never exceed the filtered signal (lower envelope)',
  );
});
