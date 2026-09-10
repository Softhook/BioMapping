/**
 * buildLiveCsv (src/live/live_csv.js) — the live session → CSV serialiser.
 *
 * The contract it has to hold: a live export must be byte-compatible with a
 * track the firmware's SD logger writes, so the visualiser imports and
 * integrity-verifies it exactly like a recorded file. These tests pin:
 *   • the `# Integrity: crc32 v1` marker as the first line,
 *   • per-row number formatting matching firmware/biomap_format.c
 *     biomap_format_gps_row() (valid-fix vs no-fix branches),
 *   • the `# End rows:… bytes:… crc32:… end_time:… overflows:… flush_fails:…`
 *     trailer with a CRC32 that actually covers the file body, and
 *   • a full round-trip: buildLiveCsv → GSRCSVParser.parse → integrity
 *     "verified", GSR samples intact.
 *
 * Run: node --test tests/test_live_csv.js  (or `npm test` for all)
 */

const test = require('node:test');
const assert = require('node:assert');

// GSRCSVParser needs these globals (see its file header / test_csv_integrity.js).
global.window = global;
global.GSR_CONST = require('./mock_constants.js');
global.GSRAnalyzer = { calcEmFog: () => NaN };

const { buildLiveCsv } = require('../src/live/live_csv.js');
const { GSRCSVParser } = require('../src/signal/csv_parser.js');

const NOW_MS = 1_700_000_123_456; // -> epoch seconds 1_700_000_123

function pkt(over = {}) {
  return {
    timestamp: 1.0, valid: true, lat: 51.5, lon: -0.12,
    hdop: 1.1, pdop: 1.7, sats: 8, fixType: 3,
    speedKts: 2.0, courseDeg: 90.0, gsrRaw: 1000.0, ...over,
  };
}

// ── Structure ──────────────────────────────────────────────────────────────

test('the first line is the firmware integrity marker, verbatim', () => {
  const csv = buildLiveCsv([pkt()], NOW_MS);
  assert.strictEqual(csv.split('\n')[0], '# Integrity: crc32 v1');
});

test('metadata + column header match a GPS+GSR recording', () => {
  const lines = buildLiveCsv([pkt({ timestamp: 12.6 })], NOW_MS).split('\n');
  assert.strictEqual(lines[1], '# RecordingStartTime:1700000111'); // 1700000123 - floor(12.6)
  assert.strictEqual(lines[2], '# DeviceName:LiveStream');
  assert.strictEqual(
    lines[3],
    'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m',
  );
});

test('RecordingStartTime is wall-clock-now minus the last packet uptime, floored; no packets -> now', () => {
  assert.match(buildLiveCsv([], NOW_MS), /^# Integrity: crc32 v1\n# RecordingStartTime:1700000123\n/);
  // 1700000123 - floor(100.9) == 1700000023
  assert.match(buildLiveCsv([pkt({ timestamp: 100.9 })], NOW_MS), /\n# RecordingStartTime:1700000023\n/);
});

// ── Row formatting vs firmware/biomap_format.c ─────────────────────────────

test('a valid fix row matches biomap_format_gps_row() "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f,%.1f" (hacc empty)', () => {
  const csv = buildLiveCsv([pkt({
    timestamp: 0.3, lat: 51.5074, lon: -0.1278, hdop: 1.2, pdop: 1.8,
    sats: 9, fixType: 3, speedKts: 3.4, courseDeg: 270.0, gsrRaw: 1234.5,
  })], NOW_MS);
  const row = csv.split('\n')[4];
  assert.strictEqual(row, '0.30,51.5074000,-0.1278000,1.2,1.8,9,3,3.40,270.0,1234.5,');
});

test('a no-fix row matches biomap_format_gps_row() "%.2f,,,,,,,,,%.1f," — every GPS column empty', () => {
  const csv = buildLiveCsv([pkt({
    timestamp: 12.6, valid: false, lat: NaN, lon: NaN,
    hdop: 99.9, pdop: 99.9, sats: 0, fixType: 1, speedKts: 0, courseDeg: 0, gsrRaw: 800.0,
  })], NOW_MS);
  const row = csv.split('\n')[4];
  assert.strictEqual(row, '12.60,,,,,,,,,800.0,');
});

test('every data row carries exactly 11 fields (10 commas), fix or no fix', () => {
  const csv = buildLiveCsv(
    [pkt(), pkt({ valid: false, lat: NaN, lon: NaN })],
    NOW_MS,
  );
  for (const row of csv.split('\n').slice(4, 6)) {
    assert.strictEqual(row.split(',').length, 11, `11 fields: "${row}"`);
  }
});

// ── Trailer ───────────────────────────────────────────────────────────────

test('the trailer uses sd_logger_write_trailer()\'s token layout and a card-less session\'s honest zeros', () => {
  const csv = buildLiveCsv([pkt(), pkt({ timestamp: 1.3 })], NOW_MS);
  assert.match(
    csv,
    /\n# End rows:2 bytes:\d+ crc32:[0-9a-f]{8} end_time:1700000123 overflows:0 flush_fails:0\n$/,
  );
});

test('the trailer crc32 / bytes actually describe the file body (independent recompute)', () => {
  const csv = buildLiveCsv([pkt(), pkt({ timestamp: 1.3, valid: false, lat: NaN, lon: NaN })], NOW_MS);
  const cut = csv.lastIndexOf('\n# End ');
  const body = csv.slice(0, cut + 1); // includes the '\n' that ends the last row
  const m = csv.slice(cut + 1).match(/bytes:(\d+) crc32:([0-9a-f]{8})/);
  assert.strictEqual(Number(m[1]), new TextEncoder().encode(body).length, 'bytes token');
  assert.strictEqual(
    m[2],
    GSRCSVParser._crc32(new TextEncoder().encode(body)).toString(16).padStart(8, '0'),
    'crc32 token',
  );
});

// ── Full round-trip through the importer ──────────────────────────────────

test('buildLiveCsv output parses and integrity-verifies as a complete, unmodified file', () => {
  const packets = [];
  for (let i = 0; i < 20; i++) {
    packets.push(pkt({
      timestamp: i * 0.3,
      valid: i % 5 !== 0, // every 5th sample is a no-fix row
      lat: i % 5 !== 0 ? 51.5 + i * 1e-4 : NaN,
      lon: i % 5 !== 0 ? -0.12 + i * 1e-4 : NaN,
      gsrRaw: 1000 + i * 10,
    }));
  }
  const csv = buildLiveCsv(packets, NOW_MS);

  const result = GSRCSVParser.parse(csv);
  assert.strictEqual(result.integrity.status, 'verified', result.integrity.detail);
  assert.strictEqual(result.integrity.overflows, 0);
  assert.strictEqual(result.integrity.flushFails, 0);

  // The GSR series survives the round-trip (nS on the wire, ÷1000 -> µS on
  // import — csv_parser.js "Auto-detect Units"). Rows are `.raw`, value `.val`.
  assert.strictEqual(result.raw.length, packets.length);
  assert.ok(Math.abs(result.raw[0].val - 1.0) < 1e-6, 'first sample 1000 nS -> 1.0 µS');
  assert.ok(Math.abs(result.raw.at(-1).val - 1.19) < 1e-6, 'last sample 1190 nS -> 1.19 µS');
});

test('a corrupted body is caught by the round-trip (integrity "corrupt")', () => {
  const csv = buildLiveCsv([pkt(), pkt({ timestamp: 1.3 })], NOW_MS);
  const tampered = csv.replace('1000.0', '9999.0'); // change a gsr value, leave the trailer
  const result = GSRCSVParser.parse(tampered);
  assert.strictEqual(result.integrity.status, 'corrupt');
});
