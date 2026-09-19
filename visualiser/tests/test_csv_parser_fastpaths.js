/**
 * GSRCSVParser.parse() fast paths: quote-free line split, single-pass GSR
 * stats / flat-signal rule, imported peak labels, RF/OSM column skipping.
 *
 * Run: node --test visualiser/tests/test_csv_parser_fastpaths.js
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');
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
    if (i === 30) return `${l},0,"ignored",1`;
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
  assert.strictEqual(r.importedPeakLabels.size, 1);
  assert.strictEqual([...r.importedPeakLabels.values()][0], 'Cafe');
  assert.strictEqual(r.importedPeakExcluded.size, 1);
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
