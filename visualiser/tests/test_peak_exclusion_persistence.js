/**
 * A peak the user excluded must stay excluded across re-analysis (even when
 * a slider drag hides it for a moment), across save → reload (even while
 * hidden), and a re-included imported exclusion must stay re-included.
 * Real recording, default settings (smoothing 0).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');

const CSV = fs.readFileSync(
  path.join(__dirname, '../fixtures/default_processed.csv'),
  'utf8',
);
const params = (o = {}) =>
  Object.assign(structuredClone(GSR_CONST.GSR_DEFAULT), o);

function load(text = CSV, p = params()) {
  const a = new GSRAnalyzer();
  a.parseCSV(text);
  a.analyze(p, 0);
  return a;
}
const reload = (a, p) =>
  load(a.exportToCSV(p, structuredClone(GSR_CONST.GPS_DEFAULT)));
const peakAt = (a, t) => a.peaks.find((pk) => Math.abs(pk.time - t) < 0.05);
const smallest = (a) =>
  a.peaks.reduce((m, pk) => (pk.amplitude < m.amplitude ? pk : m));

test('an exclusion survives a threshold drag that hides the peak and back', () => {
  const a = load();
  const small = smallest(a);
  a.setPeakExcluded(a.peaks.indexOf(small), true);

  a.analyze(params({ peakThreshold: small.amplitude * 1.5 }), 0);
  assert.strictEqual(peakAt(a, small.time), undefined, 'peak is hidden');
  a.analyze(params(), 0);
  assert.strictEqual(peakAt(a, small.time).excluded, true);
});

test('an excluded peak hidden by a higher threshold is kept on save', () => {
  const a = load();
  const small = smallest(a);
  a.setPeakExcluded(a.peaks.indexOf(small), true);
  const high = params({ peakThreshold: small.amplitude * 1.5 });
  a.analyze(high, 0);

  const b = reload(a, high);
  b.analyze(params(), 0);
  assert.strictEqual(peakAt(b, small.time).excluded, true);
  assert.strictEqual(b.peaks.filter((pk) => pk.excluded).length, 1);
});

test('re-including an imported exclusion is not undone by the next re-analysis', () => {
  const a = load();
  const t = a.peaks[4].time;
  a.setPeakExcluded(4, true);
  const b = reload(a, params());
  assert.strictEqual(peakAt(b, t).excluded, true, 'import kept it');

  b.setPeakExcluded(b.peaks.indexOf(peakAt(b, t)), false);
  b.analyze(params(), 0);
  assert.strictEqual(peakAt(b, t).excluded, false);
});
