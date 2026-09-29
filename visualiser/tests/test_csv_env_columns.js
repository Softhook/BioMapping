/**
 * OSM / NDVI environment columns: GSRCSVParser.OSM_COLUMNS / NDVI_COLUMNS
 * drive both parse() and AnalyzerExport.toCSV(), but parse() also names each
 * field in its row literal (one object shape per track — see the comment
 * there). These tests keep the two in step and check a save/reload keeps
 * every value.
 *
 * Run: node --test tests/test_csv_env_columns.js
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global;
const { GSR_CONST } = require('../src/core/constants.mjs');
const { GSRCSVParser } = require('../src/signal/csv_parser.mjs');
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');

const ENV = [...GSRCSVParser.OSM_COLUMNS, ...GSRCSVParser.NDVI_COLUMNS];

const deviceCsv = (n) => {
  let s = 'timestamp,gsr_raw\n';
  for (let i = 0; i < n; i++) {
    s += `${(i / 10).toFixed(1)},${5000 + 300 * Math.sin(i / 20) + (i % 7)}\n`;
  }
  return s;
};

test('every continuous OSM metric says how many decimals to save', () => {
  for (const c of GSRCSVParser.OSM_COLUMNS) {
    if (c.kind === 'continuous') {
      assert.ok(Number.isInteger(c.digits), `${c.field} has csvDigits`);
    }
  }
});

test('a parsed row has every environment field, empty, and no others', () => {
  const { raw } = GSRCSVParser.parse(deviceCsv(20));
  const row = raw[0];
  for (const c of ENV) {
    assert.ok(c.field in row, `row has ${c.field}`);
    if (c.kind === 'categorical') assert.strictEqual(row[c.field], null);
    else assert.ok(Number.isNaN(row[c.field]), `${c.field} is NaN`);
  }
  const envLike = Object.keys(row).filter(
    (k) => k.startsWith('osm_') || k.startsWith('ndvi'),
  );
  assert.deepStrictEqual(
    envLike,
    ENV.map((c) => c.field),
    'row literal lists the same fields, in the same order',
  );
});

test('save and reload keeps every environment value', () => {
  const a = new GSRAnalyzer();
  a.parseCSV(deviceCsv(400));
  a.raw.forEach((r, i) => {
    r.osm_road_class =
      i % 3 === 0 ? null : i % 3 === 1 ? 'primary' : 'foot, "way"';
    r.osm_in_park = i % 5 === 0 ? NaN : i % 2;
    for (const c of ENV) {
      if (c.kind === 'continuous') {
        r[c.field] = i % 4 === 0 ? NaN : ((i * 7.13) % 97) / 10;
      }
    }
  });
  a.isEnriched = true;
  a.analyze({ ...GSR_CONST.GSR_DEFAULT });
  const csv = a.exportToCSV(null, null);
  const header = csv.split('\n').find((l) => !l.startsWith('#'));
  assert.ok(
    header.endsWith(`,${ENV.map((c) => c.field).join(',')}`),
    'header ends with the environment columns in list order',
  );

  const b = new GSRAnalyzer();
  b.parseCSV(csv);
  assert.strictEqual(b.isEnriched, true);
  for (let i = 0; i < a.raw.length; i++) {
    for (const c of ENV) {
      const want = a.raw[i][c.field];
      const got = b.raw[i][c.field];
      if (c.kind === 'categorical') {
        assert.strictEqual(got, want, `row ${i} ${c.field}`);
      } else if (want === null || Number.isNaN(want)) {
        assert.ok(Number.isNaN(got), `row ${i} ${c.field} stays empty`);
      } else if (c.kind === 'binary') {
        assert.strictEqual(got, want, `row ${i} ${c.field}`);
      } else {
        assert.strictEqual(
          got,
          Number(want.toFixed(c.digits)),
          `row ${i} ${c.field} at ${c.digits} decimals`,
        );
      }
    }
  }
});
