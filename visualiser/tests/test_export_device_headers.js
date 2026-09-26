/**
 * The device's own header lines (calibration, band floors, device/chip IDs)
 * must be carried into the processed export and survive a second save; the
 * integrity bracket must not, since the processed file isn't the untouched
 * recording it vouched for.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
const { GSRAnalyzer } = require('../src/signal/analyzer.mjs');

const DEVICE_LINES = [
  '# DeviceName:Walflow',
  '# Band Floors (dBm): 815:-91.5,868:-91.5,915:-91.5',
  '# GPSChipID:axis slang boast putt chunk',
  '# GSR Calibration: gain:1.0037,offset:103.0993,r2:1.0000,noise_ns:0.87,1.12,2.68',
];
const body = fs
  .readFileSync(
    path.join(__dirname, '../fixtures/default_processed.csv'),
    'utf8',
  )
  .split('\n')
  .filter((l) => !l.startsWith('#'))
  .join('\n');
const DEVICE_CSV = [
  '# Integrity: crc32 v1',
  '# RecordingStartTime:1785503000',
  ...DEVICE_LINES,
  body,
].join('\n');

const params = () => structuredClone(GSR_CONST.GSR_DEFAULT);
const gpsParams = () => structuredClone(GSR_CONST.GPS_DEFAULT);

function loadAndExport(text) {
  const a = new GSRAnalyzer();
  a.parseCSV(text);
  a.analyze(params(), 0);
  return { a, csv: a.exportToCSV(params(), gpsParams()) };
}
const headerLines = (csv) => csv.split('\n').filter((l) => l.startsWith('#'));

test('device header lines are copied into the processed export', () => {
  const { csv } = loadAndExport(DEVICE_CSV);
  const lines = headerLines(csv);
  for (const l of DEVICE_LINES) assert.ok(lines.includes(l), `missing: ${l}`);
  assert.ok(!lines.some((l) => l.startsWith('# Integrity')));
  assert.ok(!lines.some((l) => l.startsWith('# End')));
  assert.strictEqual(
    lines.filter((l) => l.startsWith('# RecordingStartTime:')).length,
    1,
  );
});

test('device header lines survive a second save, once each, and band floors reload', () => {
  const first = loadAndExport(DEVICE_CSV).csv;
  const { a, csv } = loadAndExport(first);
  const lines = headerLines(csv);
  for (const l of DEVICE_LINES) {
    assert.strictEqual(lines.filter((x) => x === l).length, 1, l);
  }
  for (const k of ['FilterParams', 'GpsFilterParams']) {
    assert.strictEqual(
      lines.filter((l) => l.startsWith(`# ${k}:`)).length,
      1,
      `${k} duplicated`,
    );
  }
  assert.deepStrictEqual(a.bandFloors, { 815: -91.5, 868: -91.5, 915: -91.5 });
});
