/**
 * Firmware ⇄ visualiser SAVE-PROTOCOL CONTRACT.
 *
 * The live view has to write a CSV byte-compatible with a file the Flipper's
 * SD logger writes, and decode a wire packet byte-identical to the one the
 * firmware packs. Both sides currently keep hand-copied mirrors of firmware
 * constants (visualiser/src/live/live_csv.js, .../live_binary_parser.js) —
 * nothing else stops them drifting when the firmware format changes.
 *
 * This test reads the firmware source directly and asserts the visualiser
 * still matches it:
 *   • the `# Integrity: crc32 v1` marker            (modules/sd_logger.c)
 *   • the GPS+GSR column header                     (biomap_config.h)
 *   • per-row number formatting, fix + no-fix       (biomap_format.c)
 *   • the `# End …` trailer's token layout          (modules/sd_logger.c)
 *   • the metadata header prefixes                  (biomap_session.c)
 *   • the 45-byte wire packet's field offsets       (modules/bt_stream.{c,h})
 *
 * When the firmware changes any of these, this test goes red with an
 * actionable message — reconcile visualiser/src/live/ (and
 * docs/csv_schema.md) against the new firmware source, update this test's
 * anchors if the firmware was refactored, and the two stay locked together.
 *
 * The firmware side has its own guard: biomap_format.c is LINKED by
 * firmware/tests/test_firmware.c (golden-output assertions), so it can't
 * silently diverge from its own format either. This closes the JS half.
 *
 * Run: node --test tests/test_firmware_csv_contract.js  (or `npm test`)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const FW = path.join(REPO, 'firmware');
const LIVE = path.join(__dirname, '..', 'src', 'live');

// A partial checkout (visualiser/ without firmware/) can't run this — skip
// loudly rather than fail. In the monorepo both are always present.
if (!fs.existsSync(FW)) {
  test('firmware ⇄ visualiser save-protocol contract', { skip: 'firmware/ not present in this checkout' }, () => {});
} else {
  runContractTests();
}

function runContractTests() {
  const { buildLiveCsv } = require('../src/live/live_csv.js');
  const { GSRCSVParser } = (() => {
    global.window = global;
    global.GSR_CONST = require('./mock_constants.js');
    global.GSRAnalyzer = { calcEmFog: () => NaN };
    return require('../src/signal/csv_parser.js');
  })();

  const readFw = (rel) => fs.readFileSync(path.join(FW, rel), 'utf8');
  const readLive = (name) => fs.readFileSync(path.join(LIVE, name), 'utf8');

  // Fail with an actionable message when a firmware anchor can't be found —
  // that means the firmware was refactored and this test + the visualiser
  // mirrors both need reconciling against the new source.
  function locate(text, re, whatAndFile) {
    const m = text.match(re);
    if (!m) {
      assert.fail(
        `SAVE-PROTOCOL CONTRACT: could not locate ${whatAndFile}. The ` +
        `firmware save format was refactored — re-anchor this test, then ` +
        `reconcile visualiser/src/live/ (live_csv.js / live_binary_parser.js) ` +
        `and docs/csv_schema.md against the current firmware source.`,
      );
    }
    return m;
  }

  // Concatenate adjacent C string literals, applying the escapes these
  // format strings actually use.
  function cStr(chunk) {
    return (chunk.match(/"(?:[^"\\]|\\.)*"/g) || [])
      .map((s) => s.slice(1, -1)
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
      .join('');
  }

  // The full logical line at the first line matching `anchor`, following C
  // backslash-newline continuations (for multi-line #defines).
  function logicalLine(src, anchor) {
    const lines = src.split('\n');
    let i = lines.findIndex((l) => anchor.test(l));
    if (i === -1) return null;
    const out = [lines[i]];
    while (/\\\s*$/.test(lines[i]) && i + 1 < lines.length) { i++; out.push(lines[i]); }
    return out.join('\n');
  }

  // One printf conversion spec → a regex fragment matching one formatted field.
  function specFrag(spec) {
    if (spec === '') return '';
    if (spec === '%d' || spec === '%u') return '-?\\d+';
    const f = spec.match(/^%\.(\d+)f$/);
    if (f) return `-?\\d+\\.\\d{${f[1]}}`;
    throw new Error(`SAVE-PROTOCOL CONTRACT: unhandled printf spec "${spec}" — extend specFrag().`);
  }

  const SAMPLE_NOW_MS = 1_700_000_123_456;
  const emptyExport = () => buildLiveCsv([], SAMPLE_NOW_MS).split('\n');

  // ── CSV: integrity marker ───────────────────────────────────────────────
  test('CSV: the integrity marker is verbatim firmware SD_LOGGER_INTEGRITY_LINE', () => {
    const sd = readFw('modules/sd_logger.c');
    const fwMarker = cStr(
      locate(sd, /#define\s+SD_LOGGER_INTEGRITY_LINE\s+("(?:[^"\\]|\\.)*")/,
             'SD_LOGGER_INTEGRITY_LINE in modules/sd_logger.c')[1],
    );
    const liveMarker = emptyExport()[0] + '\n';
    assert.strictEqual(liveMarker, fwMarker,
      'live_csv.js LIVE_INTEGRITY_MARKER has drifted from the firmware marker (version bump?)');
  });

  // ── CSV: column header ─────────────────────────────────────────────────
  test('CSV: the GPS+GSR column header equals firmware BIOMAP_CSV_COLS_GPS_GSR_PROD', () => {
    const cfg = readFw('biomap_config.h');
    const line = logicalLine(cfg, /#define\s+BIOMAP_CSV_COLS_GPS_GSR_PROD\b/);
    if (!line) {
      assert.fail('SAVE-PROTOCOL CONTRACT: BIOMAP_CSV_COLS_GPS_GSR_PROD not found in ' +
                  'biomap_config.h — reconcile live_csv.js LIVE_CSV_COLUMNS.');
    }
    const fwCols = cStr(line);
    const liveCols = emptyExport()[3] + '\n';
    assert.strictEqual(liveCols, fwCols,
      'live_csv.js LIVE_CSV_COLUMNS has drifted from the firmware GPS+GSR schema');
  });

  // ── CSV: per-row number formatting ────────────────────────────────────
  test('CSV: a valid-fix row matches biomap_format_gps_row()\'s printf layout', () => {
    const fmt = readFw('biomap_format.c');
    const fn = locate(fmt, /int\s+biomap_format_gps_row\s*\([\s\S]*?\n\}/,
                      'biomap_format_gps_row() in biomap_format.c')[0];
    // First snprintf literal in the function = the valid-fix + velocity branch
    // ("%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f,%.1f"). The firmware
    // also has a no-velocity branch that blanks speed_kts/course_deg, which
    // the BLE wire can't signal (speed/course arrive as 0, not NaN) — live
    // always emits the velocity form, so that's what we compare.
    const fwSpecs = cStr(
      locate(fn, /snprintf\([^,]+,[^,]+,\s*("(?:[^"\\]|\\.)*")/,
             'the valid-fix snprintf format in biomap_format_gps_row()')[1],
    ).split(',');
    assert.strictEqual(fwSpecs.length, 11, 'firmware valid-fix row is 11 columns');

    const row = buildLiveCsv([{
      timestamp: 0.3, valid: true, lat: 51.5074, lon: -0.1278,
      hdop: 1.2, pdop: 1.8, sats: 9, fixType: 3, speedKts: 3.4, courseDeg: 270, gsrRaw: 1234.5,
    }], SAMPLE_NOW_MS).split('\n')[4];

    // Columns 1–10 must match the firmware spec's precision exactly. Column 11
    // (hacc_m) is empty by design — the wire packet carries no horizontal
    // accuracy (documented in live_csv.js).
    const re = new RegExp('^' + fwSpecs.slice(0, 10).map(specFrag).join(',') + ',$');
    assert.match(row, re,
      `live valid-fix row "${row}" no longer matches firmware specs ${JSON.stringify(fwSpecs)}`);
  });

  test('CSV: a no-fix row matches biomap_format_gps_row()\'s empty-GPS-columns branch', () => {
    const fmt = readFw('biomap_format.c');
    const fn = locate(fmt, /int\s+biomap_format_gps_row\s*\([\s\S]*?\n\}/,
                      'biomap_format_gps_row() in biomap_format.c')[0];
    // The no-fix branch: "%.2f,,,,,,,,,%.1f," — timestamp + gsr_raw only.
    const fwSpecs = cStr(
      locate(fn, /snprintf\([^,]+,[^,]+,\s*("%\.2f,,+[^"]*")/,
             'the no-fix snprintf format in biomap_format_gps_row()')[1],
    ).split(',');

    const row = buildLiveCsv([{
      timestamp: 12.6, valid: false, lat: NaN, lon: NaN,
      hdop: 99.9, pdop: 99.9, sats: 0, fixType: 1, speedKts: 0, courseDeg: 0, gsrRaw: 800,
    }], SAMPLE_NOW_MS).split('\n')[4];

    const re = new RegExp('^' + fwSpecs.map(specFrag).join(',') + '$');
    assert.match(row, re,
      `live no-fix row "${row}" no longer matches firmware specs ${JSON.stringify(fwSpecs)}`);
  });

  // ── CSV: metadata header prefixes ────────────────────────────────────
  test('CSV: the metadata header lines match firmware biomap_session.c', () => {
    const sess = readFw('biomap_session.c');
    locate(sess, /"# RecordingStartTime:%lu\\n"/, '"# RecordingStartTime:" line in biomap_session.c');
    locate(sess, /"# DeviceName:%s\\n"/, '"# DeviceName:" line in biomap_session.c');
    const lines = emptyExport();
    assert.match(lines[1], /^# RecordingStartTime:\d+$/);
    assert.match(lines[2], /^# DeviceName:/);
  });

  // ── CSV: the "# End" trailer token layout ────────────────────────────
  test('CSV: the "# End" trailer token order matches sd_logger_write_trailer()', () => {
    const sd = readFw('modules/sd_logger.c');
    const endFmt = cStr(locate(sd, /("# End rows:[^"]*\\n")/,
                               'the "# End" trailer format in modules/sd_logger.c')[1]).trimEnd();
    // "# End rows:%lu bytes:%lu crc32:%08lx %soverflows:%lu flush_fails:%lu"
    // The bare "%s" slot is where end_time_tok ("end_time:%lu ") is spliced.
    const fwTokens = [];
    for (let part of endFmt.replace(/^# End\s+/, '').split(/\s+/)) {
      if (part.startsWith('%s')) { fwTokens.push('end_time'); part = part.slice(2); }
      const m = part.match(/^([a-z0-9_]+):/);
      if (m) fwTokens.push(m[1]);
    }
    assert.deepStrictEqual(fwTokens, ['rows', 'bytes', 'crc32', 'end_time', 'overflows', 'flush_fails'],
      'firmware trailer token list changed — update this expectation and live_csv.js');
    // crc32:%08lx  →  lower-case, zero-padded to 8 hex digits
    assert.ok(/crc32:%08lx/.test(endFmt), 'firmware crc32 token is still %08lx (lower hex, width 8)');

    const trailer = buildLiveCsv([{
      timestamp: 0, valid: false, lat: NaN, lon: NaN,
      hdop: 99.9, pdop: 99.9, sats: 0, fixType: 1, speedKts: 0, courseDeg: 0, gsrRaw: 1,
    }], SAMPLE_NOW_MS).trimEnd().split('\n').pop();
    const liveTokens = [...trailer.replace(/^# End\s+/, '').matchAll(/([a-z0-9_]+):/g)].map((m) => m[1]);
    assert.deepStrictEqual(liveTokens, fwTokens,
      `live trailer "${trailer}" token order no longer matches the firmware trailer`);
    assert.match(trailer, /crc32:[0-9a-f]{8}(?:\s|$)/,
      'live trailer crc32 must be 8 lower-case hex digits, like the firmware %08lx');
  });

  // ── CSV: a full round-trip still verifies ────────────────────────────
  test('CSV: buildLiveCsv output parses + integrity-verifies through GSRCSVParser', () => {
    const packets = [];
    for (let i = 0; i < 12; i++) {
      packets.push({
        timestamp: i * 0.3, valid: i % 4 !== 0,
        lat: i % 4 !== 0 ? 51.5 + i * 1e-4 : NaN,
        lon: i % 4 !== 0 ? -0.12 + i * 1e-4 : NaN,
        hdop: 1.1, pdop: 1.7, sats: 8, fixType: 3, speedKts: 1.5, courseDeg: 42, gsrRaw: 1000 + i,
      });
    }
    const result = GSRCSVParser.parse(buildLiveCsv(packets, SAMPLE_NOW_MS));
    assert.strictEqual(result.integrity.status, 'verified', result.integrity.detail);
    assert.strictEqual(result.raw.length, packets.length);
  });

  // ── WIRE: the 45-byte BLE packet ────────────────────────────────────
  test('WIRE: live_binary_parser.js field offsets + size match firmware bt_stream.{c,h}', () => {
    const btc = readFw('modules/bt_stream.c');
    const bth = readFw('modules/bt_stream.h');
    const parser = readLive('live_binary_parser.js');

    // Packet size.
    const fwSize = Number(locate(bth, /#define\s+BT_STREAM_PACKET_SIZE\s+(\d+)/,
                                 'BT_STREAM_PACKET_SIZE in modules/bt_stream.h')[1]);
    const jsSize = Number(locate(parser, /\bPACKET_SIZE\s*=\s*(\d+)/,
                                 'PACKET_SIZE in live_binary_parser.js')[1]);
    assert.strictEqual(jsSize, fwSize, 'wire packet size drifted');

    // Magic bytes (out[0]/out[1] = 0x..).
    const fwMagic = [];
    for (const m of btc.matchAll(/out\[([01])\]\s*=\s*0x([0-9a-fA-F]+)/g)) fwMagic[Number(m[1])] = parseInt(m[2], 16);
    const jsMagic = [
      Number(locate(parser, /MAGIC_0\s*=\s*(0x[0-9a-fA-F]+)/, 'MAGIC_0 in live_binary_parser.js')[1]),
      Number(locate(parser, /MAGIC_1\s*=\s*(0x[0-9a-fA-F]+)/, 'MAGIC_1 in live_binary_parser.js')[1]),
    ];
    assert.deepStrictEqual(jsMagic, fwMagic, 'wire magic bytes drifted');

    // Every packed-field byte offset on the firmware side: memcpy(out + N, …)
    // plus the trailing single-byte out[N] = … stores. Drop 0/1 (magic,
    // asserted above).
    const fwOffsets = new Set();
    for (const m of btc.matchAll(/memcpy\(out\s*\+\s*(\d+)\s*,/g)) fwOffsets.add(Number(m[1]));
    for (const m of btc.matchAll(/\bout\[(\d+)\]\s*=/g)) fwOffsets.add(Number(m[1]));
    fwOffsets.delete(0); fwOffsets.delete(1);

    // Parser side: DataView getter → byte width, keyed by offset.
    const WIDTH = { getUint8: 1, getInt8: 1, getUint16: 2, getInt16: 2, getUint32: 4, getInt32: 4, getFloat32: 4, getFloat64: 8 };
    const jsFields = [...parser.matchAll(/view\.(get\w+)\((\d+)/g)]
      .map((m) => ({ off: Number(m[2]), w: WIDTH[m[1]] }))
      .sort((a, b) => a.off - b.off);
    for (const f of jsFields) {
      assert.ok(f.w, `live_binary_parser.js uses an unmapped DataView getter at offset ${f.off}`);
    }

    assert.deepStrictEqual(
      [...new Set(jsFields.map((f) => f.off))].sort((a, b) => a - b),
      [...fwOffsets].sort((a, b) => a - b),
      'wire field byte offsets no longer match firmware bt_stream_pack_packet()',
    );

    // Parser fields must tile the packet contiguously from byte 2 (after the
    // magic pair) to PACKET_SIZE — this catches a field type/size change
    // that keeps the same start offset.
    let cursor = 2;
    for (const f of jsFields) {
      assert.strictEqual(f.off, cursor,
        `live_binary_parser.js field at offset ${f.off} leaves a gap/overlap (expected ${cursor})`);
      cursor += f.w;
    }
    assert.strictEqual(cursor, jsSize, 'live_binary_parser.js fields do not fill the packet exactly');
  });
}
