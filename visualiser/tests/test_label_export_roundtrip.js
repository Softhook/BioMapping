/**
 * Peak labels must survive save → reload even when the current settings
 * hide their peak, must not leave ghost copies behind after edits, and a
 * pasted line break must not split the exported row. Real recording,
 * default settings (smoothing 0).
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
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
const labelled = (a) => a.peaks.filter((pk) => pk.label?.trim());
const reload = (a, p) =>
  load(a.exportToCSV(p, structuredClone(GSR_CONST.GPS_DEFAULT)));

test('a label on a peak hidden by a higher threshold is kept on save and comes back on reload', () => {
  const a = load();
  for (const pk of labelled(a)) a.relabelPeak(pk, '');
  const small = a.peaks.reduce((m, pk) =>
    pk.amplitude < m.amplitude ? pk : m,
  );
  a.relabelPeak(small, 'my note');

  const high = params({ peakThreshold: small.amplitude * 1.5 });
  a.analyze(high, 0);
  assert.ok(!a.peaks.some((pk) => pk.label === 'my note'), 'peak is hidden');

  const b = reload(a, high);
  b.analyze(params(), 0);
  const back = b.peaks.filter((pk) => pk.label === 'my note');
  assert.strictEqual(back.length, 1);
  assert.ok(Math.abs(back[0].time - small.time) < 1.0);
});

test('editing labels after peaks shift leaves no ghost copies in the saved file', () => {
  const a = load();
  for (const pk of labelled(a)) a.relabelPeak(pk, '');
  for (let i = 0; i < a.peaks.length; i += 5)
    a.relabelPeak(a.peaks[i], `old${i}`);

  // Gait filter off/on moves peaks by a sample or two.
  a.analyze(params({ useGaitFilter: false }), 0);
  for (const pk of labelled(a))
    a.relabelPeak(pk, pk.label.replace('old', 'new'));
  a.analyze(params(), 0);
  a.analyze(params({ useGaitFilter: false }), 0);

  const csv = a.exportToCSV(params(), structuredClone(GSR_CONST.GPS_DEFAULT));
  assert.ok(!/old\d/.test(csv), 'an overwritten label was saved as a ghost');
  const b = reload(a, params({ useGaitFilter: false }));
  assert.deepStrictEqual(
    labelled(b)
      .map((pk) => pk.label)
      .sort(),
    labelled(a)
      .map((pk) => pk.label)
      .sort(),
  );
});

test('a pasted line break is folded to a space and does not split the saved row', () => {
  const a = load();
  const pk = a.peaks[3];
  a.relabelPeak(pk, 'busy\ncrossing');
  const b = reload(a, params());
  assert.strictEqual(b.raw.length, a.raw.length);
  assert.ok(b.peaks.some((p) => p.label === 'busy crossing'));
  const i = a.raw.findIndex((r) => r.time === pk.time);
  assert.ok(Math.abs(b.raw[i].lat - a.raw[i].lat) < 1e-5, 'row kept its GPS');
});

test('two nearby peaks with the same label: editing one leaves the other alone', () => {
  // Peaks drifted since labelling: A was stored at 10.0, B at 10.5.
  const a = new GSRAnalyzer();
  a.peaks = [
    { time: 10.3, label: 'bus' },
    { time: 10.6, label: 'bus' },
  ];
  a._userPeakLabels = new Map([
    [10.0, 'bus'],
    [10.5, 'bus'],
  ]);
  a.relabelPeak(a.peaks[0], 'lorry');
  assert.deepStrictEqual(
    [...a._userPeakLabels].sort((x, y) => x[0] - y[0]),
    [
      [10.3, 'lorry'],
      [10.5, 'bus'],
    ],
  );
});

test('two same-text labels near one visible peak: the unshown one is still exported', () => {
  const a = new GSRAnalyzer();
  a.peaks = [{ time: 10.3, label: 'bus' }]; // the other "bus" peak is hidden
  a._userPeakLabels = new Map([
    [10.0, 'bus'],
    [10.5, 'bus'],
  ]);
  assert.deepStrictEqual(a.hiddenPeakLabels(), [{ time: 10.0, label: 'bus' }]);
});
