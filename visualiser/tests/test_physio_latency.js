/**
 * Unit tests for physio_latency.mjs and Analyzer.stimulusIndexAt — the single
 * source of the GSR response-lag numbers. Run: node --test tests/test_physio_latency.js
 */
const assert = require('node:assert');
const test = require('node:test');

const { PhysioLatency } = require('../src/signal/physio_latency.mjs');

test('lags: phasic is the slider value, tonic is ×4 capped at 30 s', () => {
  assert.deepStrictEqual(PhysioLatency.lags(2), { phasic: 2, tonic: 8 });
  assert.deepStrictEqual(PhysioLatency.lags(5), { phasic: 5, tonic: 20 });
  assert.strictEqual(PhysioLatency.lags(10).tonic, 30);
});

test('normalise: 0 is a real value; junk falls back to the default', () => {
  assert.strictEqual(PhysioLatency.normalise(0), 0);
  assert.strictEqual(PhysioLatency.normalise(-3), 0);
  assert.strictEqual(PhysioLatency.normalise(NaN), 2);
  assert.strictEqual(PhysioLatency.normalise(undefined), 2);
});

test('fromSlider: reads gpsPeakLatency, honours 0, default when absent', () => {
  const orig = global.document;
  try {
    global.document = { getElementById: () => ({ value: '3.5' }) };
    assert.strictEqual(PhysioLatency.fromSlider(), 3.5);
    global.document = { getElementById: () => ({ value: '0' }) };
    assert.strictEqual(PhysioLatency.fromSlider(), 0);
    global.document = { getElementById: () => null };
    assert.strictEqual(PhysioLatency.fromSlider(), 2);
  } finally {
    global.document = orig;
  }
});

test('Analyzer.stimulusIndexAt: sample `lag` s earlier, clamped at the start', () => {
  const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');
  const a = Object.create(GSRAnalyzer.prototype);
  a.raw = Array.from({ length: 100 }, (_, i) => ({ time: i }));
  assert.strictEqual(a.stimulusIndexAt(50, 2), 48);
  assert.strictEqual(a.stimulusIndexAt(50, 0), 50);
  assert.strictEqual(a.stimulusIndexAt(1, 5), 0);
});
