/**
 * CSV integrity-bracket verification (GSRCSVParser._verifyIntegrity / _crc32).
 *
 * Mirrors the device side in firmware/modules/sd_logger.c: a
 * "# Integrity: crc32 v1" marker line plus a "# End rows:… bytes:… crc32:…"
 * trailer. See docs/csv_schema.md "Integrity Bracket".
 *
 * Run: node --test visualiser/tests/test_csv_integrity.js
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global;
global.GSR_CONST = require('./mock_constants.js');
global.GSRAnalyzer = { calcEmFog: () => NaN };

const { GSRCSVParser } = require('../src/signal/csv_parser.js');

// ── helpers ────────────────────────────────────────────────────────────────

const REGION =
  '# Integrity: crc32 v1\n' +
  '# RecordingStartTime:1000000000\n' +
  'timestamp,gsr_raw\n' +
  '0.0,100\n' +
  '0.1,101\n' +
  '0.2,102\n';
const DATA_ROWS = 3;

function trailer({ rows = DATA_ROWS, bytes, crc, endTime = 1000000050,
                   overflows = 0, flushFails = 0 } = {}) {
  const region = REGION;
  bytes = bytes !== undefined ? bytes : new TextEncoder().encode(region).length;
  crc = crc !== undefined ? crc : GSRCSVParser._crc32(region);
  const crcHex = (crc >>> 0).toString(16).padStart(8, '0');
  let line = `# End rows:${rows} bytes:${bytes} crc32:${crcHex}`;
  if (endTime !== null) line += ` end_time:${endTime}`;
  line += ` overflows:${overflows} flush_fails:${flushFails}\n`;
  return region + line;
}

// headerLineCount for REGION = 3 (# Integrity, # RecordingStartTime, column row)
const HEADER_LINES = 3;
const verify = (csv, hasMarker = true) =>
  GSRCSVParser._verifyIntegrity(csv, hasMarker, HEADER_LINES);

// ── _crc32 known-answer ────────────────────────────────────────────────────

test('_crc32 matches the standard CRC-32 check value', () => {
  assert.strictEqual(GSRCSVParser._crc32('123456789'), 0xCBF43926);
  // Same result whether fed a string or its UTF-8 bytes.
  assert.strictEqual(
    GSRCSVParser._crc32(new TextEncoder().encode('123456789')),
    0xCBF43926
  );
});

// ── _verifyIntegrity ──────────────────────────────────────────────────────

test('a well-formed bracket verifies', () => {
  const r = verify(trailer());
  assert.strictEqual(r.status, 'verified');
  assert.strictEqual(r.endTime, 1000000050);
  assert.strictEqual(r.overflows, 0);
  assert.strictEqual(r.flushFails, 0);
});

test('a flipped data byte is caught as corrupt (checksum)', () => {
  const good = trailer();
  const bad = good.replace('0.1,101', '0.1,999');
  const r = verify(bad);
  assert.strictEqual(r.status, 'corrupt');
  assert.match(r.detail, /checksum/);
});

test('an inserted row is caught as corrupt (row count)', () => {
  const good = trailer();
  const bad = good.replace('0.2,102\n# End', '0.2,102\n0.3,103\n# End');
  const r = verify(bad);
  assert.strictEqual(r.status, 'corrupt');
  assert.match(r.detail, /row count/);
});

test('truncated data with the trailer still attached is corrupt', () => {
  const good = trailer();
  const bad = good.replace('0.1,101\n0.2,102\n# End', '0.1,101\n# End');
  const r = verify(bad);
  assert.strictEqual(r.status, 'corrupt');
});

test('marker present but no trailer -> incomplete', () => {
  const r = verify(REGION);
  assert.strictEqual(r.status, 'incomplete');
  assert.match(r.detail, /did not stop cleanly/);
});

test('no marker and no trailer -> none', () => {
  const plain = 'timestamp,gsr_raw\n0.0,100\n0.1,101\n';
  const r = GSRCSVParser._verifyIntegrity(plain, false, 1);
  assert.strictEqual(r.status, 'none');
});

test('continuity counters surface on an otherwise-verified file', () => {
  const r = verify(trailer({ overflows: 2, flushFails: 1 }));
  assert.strictEqual(r.status, 'verified');
  assert.strictEqual(r.overflows, 2);
  assert.strictEqual(r.flushFails, 1);
  assert.match(r.detail, /SD pressure/);
});

test('end_time token may be absent (RTC unset)', () => {
  const r = verify(trailer({ endTime: null }));
  assert.strictEqual(r.status, 'verified');
  assert.strictEqual(r.endTime, null);
});

test('a byte-count-only mismatch is still corrupt', () => {
  // Correct crc + rows, wrong bytes.
  const r = verify(trailer({ bytes: 999999 }));
  assert.strictEqual(r.status, 'corrupt');
  assert.match(r.detail, /byte count/);
});

// ── integration through parse() ───────────────────────────────────────────

test('parse() attaches the integrity result', () => {
  const res = GSRCSVParser.parse(trailer());
  assert.ok(res.integrity);
  assert.strictEqual(res.integrity.status, 'verified');
});

test('parse() flags a tampered file', () => {
  const bad = trailer().replace('0.0,100', '0.0,500');
  const res = GSRCSVParser.parse(bad);
  assert.strictEqual(res.integrity.status, 'corrupt');
});

test('parse() reports none for a pre-integrity CSV', () => {
  const plain =
    '# RecordingStartTime:1000000000\n' +
    'timestamp,gsr_raw\n0.0,100\n0.1,101\n0.2,102\n';
  const res = GSRCSVParser.parse(plain);
  assert.strictEqual(res.integrity.status, 'none');
});
