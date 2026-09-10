/**
 * buildLiveCsv — serialises a live session's accumulated packets to
 * docs/csv_schema.md's canonical GPS+GSR schema (11 columns), byte-compatible
 * with a track the firmware's SD logger writes: the same
 * `# Integrity: crc32 v1` marker line, the same per-row number formatting as
 * firmware/biomap_format.c's biomap_format_gps_row(), and the same
 * `# End rows:… bytes:… crc32:… end_time:… overflows:… flush_fails:…`
 * trailer with a real CRC32 over the file body. The visualiser verifies that
 * bracket on import (GSRCSVParser._verifyIntegrity) — a live export now
 * passes as "complete and unmodified" exactly like a recorded file.
 *
 * Pure: takes the packet array and a wall-clock reference, returns the full
 * CSV text. The save-location dialog lives with the caller (live_view.js's
 * exportCsv() → GSRFileSaver.saveFile), so this half is trivially testable.
 *
 * Two honest, unavoidable deviations from a firmware-written file — the BLE
 * wire packet (docs/csv_schema.md §"Live Stream BLE Binary Packet Format")
 * simply doesn't carry the data:
 *   • hacc_m is always the trailing empty field (no horizontal accuracy on
 *     the wire) rather than a value or the 99.9 sentinel.
 *   • no `# GSR Calibration: gain:…,offset:…` line — the gain/offset are
 *     applied firmware-side before gsr_raw is packed (so gsr_raw IS already
 *     calibrated, same as a recorded track), but the coefficients aren't
 *     transmitted, so we can't reproduce that metadata line.
 * lat/lon are the empty string (never "NaN") on a no-fix sample, and every
 * other GPS column is left empty on that row too — matching
 * biomap_format_gps_row()'s `"%.2f,,,,,,,,,%.1f,"` no-fix branch.
 *
 * @param {object[]} packets  LiveState.packets entries
 * @param {number}   nowMs    Date.now() at export time
 * @returns {string} CSV text, newline-terminated
 */

// CRC32 (reflected, polynomial 0xEDB88320 — the zlib/PNG variant). Produces
// bytes identical to firmware/modules/sd_logger.c's crc32_feed() and the
// visualiser's own GSRCSVParser._crc32 (src/signal/csv_parser.js). Inlined
// here rather than reused from csv_parser.js so the standalone live.html
// doesn't have to pull that whole module in (it drags GSR_CONST + GSRAnalyzer)
// just for this one helper.
let _crc32Table = null;
function _liveCrc32(bytes) {
  if (!_crc32Table) {
    _crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ _crc32Table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// firmware/modules/sd_logger.c SD_LOGGER_INTEGRITY_LINE — the file's first
// line, folded into the CRC the trailer carries.
const LIVE_INTEGRITY_MARKER = '# Integrity: crc32 v1\n';
// firmware/biomap_config.h BIOMAP_CSV_COLS_GPS_GSR_PROD, verbatim.
const LIVE_CSV_COLUMNS =
  'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m\n';

function buildLiveCsv(packets, nowMs) {
  const nowEpoch = Math.floor(nowMs / 1000);
  const startEpoch = nowEpoch - Math.floor(packets.at(-1)?.timestamp || 0);

  // Body = marker + metadata header + column header + every data row. This is
  // exactly the byte range the trailer's crc32/bytes/rows describe (the CRC
  // region ends at the '\n' that terminates the last row — see
  // docs/csv_schema.md "Integrity Bracket").
  let body =
    LIVE_INTEGRITY_MARKER +
    `# RecordingStartTime:${startEpoch}\n` +
    '# DeviceName:LiveStream\n' +
    LIVE_CSV_COLUMNS;

  for (const p of packets) {
    if (p.valid) {
      // biomap_format_gps_row(), valid-fix branch:
      // "%.2f,%.7f,%.7f,%.1f,%.1f,%d,%d,%.2f,%.1f,%.1f,%.1f" — note speed_kts
      // is 2 dp, everything else GPS-side is 1 dp. hacc_m (final field) is
      // left empty (see the file header).
      body +=
        `${p.timestamp.toFixed(2)},${p.lat.toFixed(7)},${p.lon.toFixed(7)},` +
        `${p.hdop.toFixed(1)},${p.pdop.toFixed(1)},${p.sats},${p.fixType},` +
        `${p.speedKts.toFixed(2)},${p.courseDeg.toFixed(1)},${p.gsrRaw.toFixed(1)},\n`;
    } else {
      // biomap_format_gps_row(), no-fix branch: "%.2f,,,,,,,,,%.1f," — only
      // timestamp and gsr_raw carry a value, every GPS column is empty.
      body += `${p.timestamp.toFixed(2)},,,,,,,,,${p.gsrRaw.toFixed(1)},\n`;
    }
  }

  const bodyBytes = new TextEncoder().encode(body);
  const crcHex = _liveCrc32(bodyBytes).toString(16).padStart(8, '0');

  // firmware/modules/sd_logger.c sd_logger_write_trailer():
  // "# End rows:%lu bytes:%lu crc32:%08lx %soverflows:%lu flush_fails:%lu\n".
  // A live session has no SD card, so overflows/flush_fails are a truthful 0.
  const trailer =
    `# End rows:${packets.length} bytes:${bodyBytes.length} crc32:${crcHex} ` +
    `end_time:${nowEpoch} overflows:0 flush_fails:0\n`;

  return body + trailer;
}

if (typeof window !== 'undefined') window.buildLiveCsv = buildLiveCsv;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildLiveCsv };
}
