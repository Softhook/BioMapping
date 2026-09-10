/**
 * buildLiveCsv — serialises a live session's accumulated packets to
 * docs/csv_schema.md's canonical GPS+GSR schema (11 columns) with the two
 * mandatory metadata header lines, so a live walk exports byte-compatible
 * with a recorded track.
 *
 * Pure: takes the packet array and a wall-clock reference, returns the full
 * CSV text. The <a download> plumbing stays with the caller (live.html's
 * exportCsv()), so this half is trivially testable.
 *
 * hacc_m is always the trailing empty field — the wire packet (§5) never
 * carries horizontal accuracy, so this is an honest "not measured" rather
 * than a guessed value. lat/lon are the empty string (never "NaN") on a
 * no-fix sample, per docs/csv_schema.md §"GPS Column Sentinel Behaviour".
 *
 * @param {object[]} packets  LiveState.packets entries
 * @param {number}   nowMs    Date.now() at export time
 * @returns {string} CSV text, newline-terminated
 */
function buildLiveCsv(packets, nowMs) {
  const rows = ['timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m'];
  const startEpoch = Math.floor(nowMs / 1000) - Math.floor(packets.at(-1)?.timestamp || 0);
  for (const p of packets) {
    const lat = p.valid ? p.lat.toFixed(7) : '';
    const lon = p.valid ? p.lon.toFixed(7) : '';
    rows.push([
      p.timestamp.toFixed(2), lat, lon,
      p.hdop.toFixed(1), p.pdop.toFixed(1), p.sats, p.fixType,
      p.speedKts.toFixed(1), p.courseDeg.toFixed(1), p.gsrRaw.toFixed(1), '',
    ].join(','));
  }
  const header = `# RecordingStartTime:${startEpoch}\n# DeviceName:LiveStream\n`;
  return header + rows.join('\n') + '\n';
}

if (typeof window !== 'undefined') window.buildLiveCsv = buildLiveCsv;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildLiveCsv };
}
