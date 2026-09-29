/**
 * GSRCSVParser._parseMetadataLines — the leading "#" lines of a CSV
 * (docs/csv_schema.md): recording start, saved filter settings, enrichment
 * radius, integrity marker, band floors and the device lines.
 *
 * Run: node --test tests/test_csv_metadata.js
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global;
const { GSR_CONST } = require('../src/core/constants.mjs');
const { GSRCSVParser } = require('../src/signal/csv_parser.mjs');

const meta = (header) =>
  GSRCSVParser._parseMetadataLines(
    `${header}timestamp,gsr_raw\n0.0,100\n`.split('\n'),
  );

test('a file with no "#" lines starts its data at line 0', () => {
  const m = meta('');
  assert.strictEqual(m.dataStartLine, 0);
  assert.strictEqual(m.recordingStartTime, 0);
  assert.strictEqual(m.importedFilterParams, null);
  assert.strictEqual(m.importedGpsFilterParams, null);
  assert.strictEqual(m.bandFloors, null);
  assert.strictEqual(m.hasIntegrityMarker, false);
  assert.deepStrictEqual(m.deviceHeaderLines, []);
});

test('reads every known line type from a device header', () => {
  const m = meta(
    '# Integrity: crc32 v1\n' +
      '# RecordingStartTime:1789208751\n' +
      '# DeviceName:Walflow\n' +
      '# GSR Calibration: gain:1.0048,offset:104.6042\n' +
      '# Band Floors (dBm): 815:-91.5,868:-90,915:-89.5\n',
  );
  assert.strictEqual(m.dataStartLine, 5);
  assert.strictEqual(m.recordingStartTime, 1789208751);
  assert.strictEqual(m.hasIntegrityMarker, true);
  assert.deepStrictEqual(m.bandFloors, { 815: -91.5, 868: -90, 915: -89.5 });
  // Device lines are kept verbatim (band floors included) for the export;
  // the lines parse() consumes itself are not.
  assert.deepStrictEqual(m.deviceHeaderLines, [
    '# DeviceName:Walflow',
    '# GSR Calibration: gain:1.0048,offset:104.6042',
    '# Band Floors (dBm): 815:-91.5,868:-90,915:-89.5',
  ]);
});

test('saved filter settings are filled out with the current defaults', () => {
  const m = meta(
    '# FilterParams: {"lpfWindow":3}\n' + '# GpsFilterParams: {}\n',
  );
  assert.strictEqual(m.importedFilterParams.lpfWindow, 3);
  assert.strictEqual(
    m.importedFilterParams.tonicMethod,
    GSR_CONST.GSR_DEFAULT.tonicMethod,
  );
  assert.deepStrictEqual(m.importedGpsFilterParams, {
    ...GSR_CONST.GPS_DEFAULT,
  });
});

test('a retired baseline method falls back to the default', () => {
  const m = meta('# FilterParams: {"tonicMethod":"dwt"}\n');
  assert.strictEqual(
    m.importedFilterParams.tonicMethod,
    GSR_CONST.GSR_DEFAULT.tonicMethod,
  );
});

test('unreadable values are ignored, not fatal', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const m = meta(
      '# RecordingStartTime:soon\n' + '# FilterParams: {not json\n',
    );
    assert.strictEqual(m.dataStartLine, 2);
    assert.strictEqual(m.recordingStartTime, 0);
    assert.strictEqual(m.importedFilterParams, null);
  } finally {
    console.warn = warn;
  }
});

test('the "# End" trailer line is not kept as a device line', () => {
  const m = meta('# End rows:1 bytes:10 crc32:00000000\n# DeviceName:X\n');
  assert.deepStrictEqual(m.deviceHeaderLines, ['# DeviceName:X']);
});
