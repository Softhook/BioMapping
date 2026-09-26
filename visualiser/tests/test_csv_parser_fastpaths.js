/**
 * GSRCSVParser.parse() fast paths: quote-free line split, single-pass GSR
 * stats / flat-signal rule, imported peak labels, RF/OSM column skipping.
 *
 * Run: node --test visualiser/tests/test_csv_parser_fastpaths.js
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
global.GSRAnalyzer = { calcEmFog: () => NaN };

const { GSRCSVParser } = require('../src/signal/csv_parser.mjs');

function csv(header, rows) {
  return `${header}\n${rows.join('\n')}\n`;
}
function series(n, f) {
  return Array.from({ length: n }, (_, i) => `${(i * 0.1).toFixed(1)},${f(i)}`);
}
const flatWarn = (r) => (r.warnings || []).some((w) => w.includes('flat'));

test('_parseCsvLine: quote-free fast path matches quoted parser', () => {
  assert.deepStrictEqual(GSRCSVParser._parseCsvLine('a,b,,d'), [
    'a',
    'b',
    '',
    'd',
  ]);
  assert.deepStrictEqual(GSRCSVParser._parseCsvLine('a,"b,c",d'), [
    'a',
    'b,c',
    'd',
  ]);
  assert.deepStrictEqual(GSRCSVParser._parseCsvLine('"x""y",z'), ['x"y', 'z']);
});

test('flat-signal warning: constant trace warns', () => {
  const r = GSRCSVParser.parse(
    csv(
      'timestamp,gsr_raw',
      series(100, () => 500),
    ),
  );
  assert.ok(flatWarn(r));
});

test('flat-signal warning: two-level step (<=3 distinct, large spread) still warns', () => {
  const r = GSRCSVParser.parse(
    csv(
      'timestamp,gsr_raw',
      series(100, (i) => (i < 50 ? 100 : 200)),
    ),
  );
  assert.ok(flatWarn(r));
});

test('flat-signal warning: genuinely varying trace does not warn', () => {
  const r = GSRCSVParser.parse(
    csv(
      'timestamp,gsr_raw',
      series(100, (i) => 500 + Math.sin(i / 5) * 40 + i),
    ),
  );
  assert.ok(!flatWarn(r));
});

test('flat-signal warning: fewer than 50 rows is never flagged', () => {
  const r = GSRCSVParser.parse(
    csv(
      'timestamp,gsr_raw',
      series(20, () => 500),
    ),
  );
  assert.ok(!flatWarn(r));
});

test('rows carry no import scratch keys; imported labels/exclusions are captured by time', () => {
  const rows = series(60, (i) => 500 + i).map((l, i) => {
    if (i === 10) return `${l},1,"Cafe",0`;
    if (i === 20) return `${l},1,,1`;
    // Non-peak rows carry the label / exclusion of a peak that wasn't
    // detected when the file was saved, so both are kept.
    if (i === 30) return `${l},0,"Hidden",1`;
    if (i === 40) return `${l},0,,1`;
    return `${l},0,,0`;
  });
  const r = GSRCSVParser.parse(
    csv('timestamp,gsr_raw,is_peak,peak_label,peak_excluded', rows),
  );
  const list = r.raw;
  assert.ok(Array.isArray(list));
  for (const row of list.slice(0, 5)) {
    assert.ok(!('_importLabel' in row) && !('_importExcluded' in row));
  }
  assert.deepStrictEqual(
    [...r.importedPeakLabels.values()],
    ['Cafe', 'Hidden'],
  );
  assert.strictEqual(r.importedPeakExcluded.size, 3);
});

test('RF columns: present -> parsed; absent -> NaN with no RF flag', () => {
  const withRf = GSRCSVParser.parse(
    csv(
      'timestamp,gsr_raw,rssi_434,rssi_868',
      series(60, (i) => `${500 + i},-80,-90`),
    ),
  );
  const l1 = withRf.raw;
  assert.strictEqual(l1[0].rssi_434, -80);
  assert.strictEqual(l1[0].rssi_868, -90);
  assert.ok(Number.isNaN(l1[0].rssi_300));

  const without = GSRCSVParser.parse(
    csv(
      'timestamp,gsr_raw',
      series(60, (i) => 500 + i),
    ),
  );
  const l2 = without.raw;
  assert.ok(Number.isNaN(l2[0].rssi_434));
  assert.ok(Number.isNaN(l2[0].em_fog));
});

test('OSM columns: present -> parsed; absent -> null/NaN', () => {
  const r = GSRCSVParser.parse(
    csv(
      'timestamp,gsr_raw,osm_road_class,osm_dist_water',
      series(60, (i) => `${500 + i},primary,12.5`),
    ),
  );
  const l = r.raw;
  assert.strictEqual(l[0].osm_road_class, 'primary');
  assert.strictEqual(l[0].osm_dist_water, 12.5);
  assert.ok(Number.isNaN(l[0].osm_dist_major_road));
});

test('processed-CSV reimport reads the Pre-Kalman fixes, not the filtered Latitude/Longitude', () => {
  const header =
    'Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude,PeakLabel,PeakExcluded,Latitude,Longitude,Pre-Kalman Latitude,Pre-Kalman Longitude';
  const rows = Array.from(
    { length: 50 },
    (_, i) =>
      `${(i * 0.1).toFixed(1)},${1 + i * 0.01},1,1,0,0,,,,51.000000,0.000000,52.000000,1.000000`,
  );
  const r = GSRCSVParser.parse(csv(header, rows));
  assert.strictEqual(r.raw[10].lat, 52);
  assert.strictEqual(r.raw[10].lon, 1);
});

test('processed-CSV reimport without Pre-Kalman columns reads Latitude/Longitude', () => {
  const header =
    'Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude,PeakLabel,PeakExcluded,Latitude,Longitude';
  const rows = Array.from(
    { length: 50 },
    (_, i) =>
      `${(i * 0.1).toFixed(1)},${1 + i * 0.01},1,1,0,0,,,,51.000000,0.500000`,
  );
  const r = GSRCSVParser.parse(csv(header, rows));
  assert.strictEqual(r.raw[10].lat, 51);
  assert.strictEqual(r.raw[10].lon, 0.5);
});

test('sample rate: one early logging gap does not skew the estimate', () => {
  const times = [];
  for (let i = 0; i < 120; i++) times.push(i * 0.1 + (i >= 20 ? 5 : 0)); // 5 s dropout at 2 s
  const rows = times.map((t, i) => `${t.toFixed(1)},${1 + (i % 7) * 0.01}`);
  const r = GSRCSVParser.parse(csv('timestamp,gsr_raw', rows));
  assert.ok(Math.abs(r.sampleRate - 10) < 1e-6, `sampleRate ${r.sampleRate}`);
});
