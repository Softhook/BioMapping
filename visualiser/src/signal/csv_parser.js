/**
 * CSV parsing engine for the GSR track visualiser — variable-rate (10 Hz GSR,
 * up to 5 Hz GPS) CSV files with optional RF/OSM columns.
 *
 * Extracted from GSRAnalyzer (analyzer.js) so the parser can be tested
 * independently of the analysis engine. parse() is stateless and returns a
 * plain result object; the only analyzer coupling is reaching
 * GSRAnalyzer.calcEmFog for the dynamic EM-fog fallback.
 *
 * Dependencies: GSR_CONST global (constants.js / tests/mock_constants.js) for
 * column-keyword and unit-conversion thresholds; GSRAnalyzer.calcEmFog.
 *
 * Standalone — no DOM, no Leaflet, no p5.
 */

class GSRCSVParser {
  /**
   * Parse one CSV line into fields, honoring quoted commas and escaped quotes
   * (RFC4180 double-quote escaping).
   * @param {string} line - A single CSV data/header line
   * @returns {string[]} Parsed fields
   * @private
   */
  static _parseCsvLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields;
  }

  /**
   * Escape a value for CSV output using RFC4180-style double-quote escaping.
   * @param {*} val - Value to escape (null/undefined -> '')
   * @returns {string}
   * @private
   */
  static _csvEscape(val) {
    if (val === null || val === undefined) return '';
    const str = String(val).replace(/"/g, '""');
    return '"' + str + '"';
  }

  /**
   * CRC32 (reflected, polynomial 0xEDB88320 — the zlib/PNG variant) over a
   * byte sequence. Accepts a string (encoded as UTF-8, matching the bytes
   * the device wrote to the card) or a Uint8Array. Returns an unsigned
   * 32-bit integer. Mirrors sd_logger.c's crc32_feed() / em_scan_cal.c.
   * @param {string|Uint8Array} input
   * @returns {number}
   * @private
   */
  static _crc32(input) {
    let table = GSRCSVParser._crc32Table;
    if (!table) {
      table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      GSRCSVParser._crc32Table = table;
    }
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Verify the integrity bracket the device writes around a clean recording
   * (docs/csv_schema.md "Integrity Bracket"): a "# Integrity: crc32 v1"
   * marker as the first line and a "# End rows:… bytes:… crc32:… …" trailer
   * as the last. Never throws — returns a status the UI surfaces as a tick.
   *
   * @param {string} csvText - Full file contents.
   * @param {boolean} hasMarker - Whether a "# Integrity:" line was seen.
   * @param {number} headerLineCount - Lines before the first data row
   *        (# metadata lines + the column-name line).
   * @returns {{status:('verified'|'incomplete'|'corrupt'|'none'),
   *           detail:string, overflows?:number, flushFails?:number,
   *           endTime?:(number|null)}}
   * @private
   */
  static _verifyIntegrity(csvText, hasMarker, headerLineCount) {
    const trailerIdx = csvText.lastIndexOf('\n# End ');

    if (!hasMarker && trailerIdx === -1) {
      return { status: 'none', detail: 'This file carries no integrity data.' };
    }
    if (trailerIdx === -1) {
      return {
        status: 'incomplete',
        detail: 'Recording did not stop cleanly — no end marker was written ' +
                '(flat battery, crash, or card removed mid-write). The rows ' +
                'that are present are still usable; the tail may be missing.'
      };
    }

    // The CRC region is every byte up to and including the '\n' that ends
    // the last data row — the device guarantees the trailer starts its own
    // line. Encode as UTF-8 so a non-ASCII device name still hashes to the
    // same bytes the Flipper wrote.
    const region = csvText.slice(0, trailerIdx + 1);
    const regionBytes = new TextEncoder().encode(region);

    let trailerEnd = csvText.indexOf('\n', trailerIdx + 1);
    if (trailerEnd === -1) trailerEnd = csvText.length;
    const trailerLine = csvText.slice(trailerIdx + 1, trailerEnd);

    const tok = (name) => {
      const m = trailerLine.match(new RegExp('(?:^|\\s)' + name + ':([0-9a-fA-F]+)'));
      return m ? m[1] : null;
    };
    const rowsTok = tok('rows'), bytesTok = tok('bytes'), crcTok = tok('crc32');
    const ovfTok = tok('overflows'), ffTok = tok('flush_fails'), endTok = tok('end_time');

    const overflows = ovfTok !== null ? parseInt(ovfTok, 10) : 0;
    const flushFails = ffTok !== null ? parseInt(ffTok, 10) : 0;
    const endTime = endTok !== null ? parseInt(endTok, 10) : null;

    const problems = [];
    if (crcTok !== null) {
      const want = parseInt(crcTok, 16) >>> 0;
      if (want !== GSRCSVParser._crc32(regionBytes)) problems.push('checksum mismatch');
    }
    if (bytesTok !== null && parseInt(bytesTok, 10) !== regionBytes.length) {
      problems.push(`byte count (trailer ${parseInt(bytesTok, 10)}, file ${regionBytes.length})`);
    }
    if (rowsTok !== null) {
      let newlines = 0;
      for (let i = 0; i < region.length; i++) if (region.charCodeAt(i) === 10) newlines++;
      const dataRows = newlines - headerLineCount;
      if (parseInt(rowsTok, 10) !== dataRows) {
        problems.push(`row count (trailer ${parseInt(rowsTok, 10)}, file ${dataRows})`);
      }
    }

    if (problems.length > 0) {
      return {
        status: 'corrupt',
        detail: 'File changed since the Flipper wrote it — ' + problems.join('; ') + '.',
        overflows, flushFails, endTime
      };
    }

    let detail = 'Complete and unmodified since recording.';
    if (overflows > 0 || flushFails > 0) {
      detail += ` Recording hit SD pressure (${overflows} dropped row(s), ` +
                `${flushFails} write retr${flushFails === 1 ? 'y' : 'ies'}) — ` +
                `some samples may be missing mid-track.`;
    }
    return { status: 'verified', detail, overflows, flushFails, endTime };
  }

  /**
   * Interpolate GPS coordinates across a dense 10 Hz row list where anchors
   * arrive at the GPS fix rate (~1–5 Hz). Mutates rawDataList in-place:
   *
   * 1. Mark genuine fix rows (hasGps = true) and clear sentinel (0, 0) rows.
   * 2. Constant-fill rows before the first fix from the first fix's position.
   * 3. Linearly interpolate lat/lon between each pair of adjacent anchors;
   *    step-hold DOP, fix_type, speed and course from the prior anchor
   *    (they change too discontinuously to interpolate meaningfully).
   * 4. Constant-fill rows after the last fix from the last fix's position.
   *
   * @param {Array<object>} rawDataList - Mutable array of parsed row objects.
   * @private
   */
  static _interpolateGPS(rawDataList) {
    const gpsIndices = [];
    for (let i = 0; i < rawDataList.length; i++) {
      const d = rawDataList[i];
      if (!isNaN(d.lat) && !isNaN(d.lon) && (Math.abs(d.lat) > 0.0001 || Math.abs(d.lon) > 0.0001)) {
        d.hasGps = true;
        gpsIndices.push(i);
      } else {
        d.hasGps = false;
        d.lat = NaN;
        d.lon = NaN;
      }
    }

    if (gpsIndices.length === 0) return;

    // 1. Fill rows before the first fix
    const firstGps = rawDataList[gpsIndices[0]];
    for (let i = 0; i < gpsIndices[0]; i++) {
      Object.assign(rawDataList[i], {
        lat: firstGps.lat, lon: firstGps.lon, sats: firstGps.sats,
        hdop: firstGps.hdop, pdop: firstGps.pdop, fixType: firstGps.fixType,
        speedKts: firstGps.speedKts, course: firstGps.course, hasGps: true
      });
    }

    // 2. Linearly interpolate between adjacent anchors
    for (let k = 0; k < gpsIndices.length - 1; k++) {
      const idxA = gpsIndices[k];
      const idxB = gpsIndices[k + 1];
      const dA = rawDataList[idxA];
      const dB = rawDataList[idxB];
      const tA = dA.time, tB = dB.time;

      for (let i = idxA + 1; i < idxB; i++) {
        const d = rawDataList[i];
        const ratio = (d.time - tA) / (tB - tA);
        d.lat = dA.lat + ratio * (dB.lat - dA.lat);
        d.lon = dA.lon + ratio * (dB.lon - dA.lon);
        d.sats = dB.sats;
        // Step-hold DOP, fix_type, and velocity from the prior GPS anchor —
        // DOP reflects satellite geometry which changes slowly (~1 min).
        // Speed/course are held rather than interpolated since they can
        // jump discontinuously at corners; the velocity-aiding filter
        // uses the per-anchor values directly.
        d.hdop = dA.hdop; d.pdop = dA.pdop; d.fixType = dA.fixType;
        d.speedKts = dA.speedKts; d.course = dA.course; d.hasGps = true;
      }
    }

    // 3. Fill rows after the last fix
    const lastGps = rawDataList[gpsIndices[gpsIndices.length - 1]];
    const lastGpsIdx = gpsIndices[gpsIndices.length - 1];
    for (let i = lastGpsIdx + 1; i < rawDataList.length; i++) {
      Object.assign(rawDataList[i], {
        lat: lastGps.lat, lon: lastGps.lon, sats: lastGps.sats,
        hdop: lastGps.hdop, pdop: lastGps.pdop, fixType: lastGps.fixType,
        speedKts: lastGps.speedKts, course: lastGps.course, hasGps: true
      });
    }
  }

  /**
   * Row indices where at least one Sub-GHz band shows a momentary spike —
   * a local maximum at least RF_PEAK_PROMINENCE_DB above an adjacent sample.
   * The map pipeline (GpsPipeline.downsampleForDisplay / GpsFilter.applyRDP,
   * see map.js:_getOrBuildDrawPoints()) treats these as forced vertices so
   * brief 868/915MHz-class emissions can't be simplified away before they're
   * ever drawn — plain geometric RDP/stride decimation has no notion of RF
   * magnitude and will happily erase a spike that sits on an otherwise
   * straight/stationary stretch of track.
   * @param {Array<object>} data - Parsed row objects with rssi_* fields
   * @returns {Set<number>} Indices of momentary RF spikes
   * @private
   */
  static _detectRfPeakIndices(data) {
    const BANDS = ['rssi_300', 'rssi_315', 'rssi_434', 'rssi_446', 'rssi_815', 'rssi_868', 'rssi_915'];
    const PROMINENCE_DB = 3.5;
    const n = data.length;
    const peakIndices = new Set();

    for (const band of BANDS) {
      for (let i = 0; i < n; i++) {
        const v = data[i][band];
        if (typeof v !== 'number' || isNaN(v)) continue;

        const prev = i > 0 ? data[i - 1][band] : undefined;
        const next = i < n - 1 ? data[i + 1][band] : undefined;
        const prevValid = typeof prev === 'number' && !isNaN(prev);
        const nextValid = typeof next === 'number' && !isNaN(next);

        if (prevValid && v < prev) continue;
        if (nextValid && v < next) continue;

        const prominent = (prevValid && (v - prev) >= PROMINENCE_DB) ||
                           (nextValid && (v - next) >= PROMINENCE_DB);
        if (prominent) peakIndices.add(i);
      }
    }
    return peakIndices;
  }

  /**
   * Calculate EM Fog Index (0-100) from RSSI readings across Sub-GHz bands.
   * Canonical implementation: GSRAnalyzer.calcEmFog (analyzer.js) — the single
   * source of truth. parse() calls it for the dynamic EM-fog fallback.
   */

  /**
   * Parse a CSV string into raw time/value objects with GPS/RF/OSM columns.
   * Pure: does not touch analyzer state; everything is returned in the result.
   *
   * @param {string} csvText - Full CSV file contents.
   * @returns {{
   *   raw: Array<object>,
   *   isResistance: boolean,
   *   recordingStartTime: number,
   *   importedFilterParams: object|null,
   *   importedGpsFilterParams: object|null,
   *   enrichmentRadius: number|null,
   *   bandFloors: object|null,
   *   sampleRate: number,
   *   hasRfData: boolean,
   *   rfPeakIndices: Set<number>,
   *   isEnriched: boolean,
   *   warnings: Array<string>|null,
   *   importedPeakLabels: Map<number,string>,
   *   importedPeakExcluded: Map<number,boolean>
   * }}
   * @throws {Error} If the CSV is empty, has too few lines, or no valid data.
   */
  static parse(csvText) {
    let isResistance = false;
    let recordingStartTime = 0;
    let importedFilterParams = null;
    let importedGpsFilterParams = null;
    let enrichmentRadius = null;
    let bandFloors = null;
    let hasIntegrityMarker = false;

    // Split into lines
    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error("CSV file is empty or has too few lines.");
    }

    // Restore recordingStartTime and filter configurations from metadata comment lines
    let dataStartLine = 0;
    while (dataStartLine < lines.length && lines[dataStartLine].startsWith('#')) {
      const line = lines[dataStartLine].trim();
      if (line.startsWith('# RecordingStartTime:')) {
        // substring(prefix.length), not split(':')[1] — consistent with every
        // other metadata field below, and doesn't silently truncate if a
        // value ever contains its own colon (this field is currently always
        // a plain number, but the parsing shouldn't rely on that).
        const metaVal = parseFloat(line.substring('# RecordingStartTime:'.length));
        if (!isNaN(metaVal)) {
          recordingStartTime = metaVal;
        }
      } else if (line.startsWith('# FilterParams:')) {
        try {
          importedFilterParams = JSON.parse(line.substring('# FilterParams:'.length).trim());
        } catch (e) {
          console.warn("Failed to parse FilterParams metadata:", e);
        }
      } else if (line.startsWith('# GpsFilterParams:')) {
        try {
          importedGpsFilterParams = JSON.parse(line.substring('# GpsFilterParams:'.length).trim());
        } catch (e) {
          console.warn("Failed to parse GpsFilterParams metadata:", e);
        }
      } else if (line.startsWith('# EnrichmentRadius:')) {
        const radVal = parseFloat(line.substring('# EnrichmentRadius:'.length));
        if (!isNaN(radVal)) {
          enrichmentRadius = radVal;
        }
      } else if (line.startsWith('# Integrity:')) {
        // Marker announcing the "# End" trailer (docs/csv_schema.md
        // "Integrity Bracket"). Its presence is all we need here — the
        // trailer itself carries the algorithm token.
        hasIntegrityMarker = true;
      } else if (line.includes('Band Floors (dBm):')) {
        const parts = line.split('Band Floors (dBm):')[1];
        if (parts) {
          bandFloors = {};
          parts.split(',').forEach(pair => {
            const kv = pair.split(':').map(s => s.trim());
            if (kv.length === 2 && kv[0] && !isNaN(parseFloat(kv[1]))) {
              bandFloors[kv[0]] = parseFloat(kv[1]);
            }
          });
        }
      }
      dataStartLine++;
    }

    // Read headers
    const headerLine = lines[dataStartLine];
    const headers = GSRCSVParser._parseCsvLine(headerLine).map(h => h.trim().toLowerCase());

    // Guess column indices from canonical CSV_COLUMNS
    const csvCols = GSR_CONST.CSV_COLUMNS;
    const colIndices = {};
    for (const colName of csvCols) {
      colIndices[colName] = -1;
    }

    // Map headers to canonical names
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      // Time Column (timestamp, time, etc.)
      if (GSR_CONST.TIME_KEYWORDS.some(kw => h.includes(kw))) {
        if (colIndices['timestamp'] === -1) colIndices['timestamp'] = i;
      }
      // GSR Column (gsr_raw, gsr, etc.)
      else if (GSR_CONST.GSR_KEYWORDS.some(kw => h.includes(kw)) && !GSR_CONST.TIME_KEYWORDS.some(kw => h.includes(kw))) {
        if (colIndices['gsr_raw'] === -1) colIndices['gsr_raw'] = i;
      }
      // Lat / Lon — skip 'alt' (altitude) which includes 'lat' as a substring
      else if (h === 'alt' || h === 'vdop' || h === 'wdop') {
        // These are either firmware columns never written (vdop/wdop) or
        // legacy columns no longer in the canonical schema (alt).  Explicitly
        // skip so 'alt' doesn't false-match h.includes('lat') below.
      }
      else if (h.includes('lat')) {
        colIndices['lat'] = i;
      }
      else if (h.includes('lon') || h.includes('lng')) {
        colIndices['lon'] = i;
      }
      // The rest match exactly or via standard fallback
      else if (h === 'hdop') colIndices['hdop'] = i;
      else if (h === 'pdop') colIndices['pdop'] = i;
      else if (h === 'hacc_m') colIndices['hacc_m'] = i;
      else if (h === 'fix_type') colIndices['fix_type'] = i;
      else if (h === 'fix') {
        if (colIndices['fix_type'] === -1) colIndices['fix_type'] = i; // fallback for older schema
      }
      else if (h.includes('sat')) colIndices['sats'] = i;
      else if (h === 'speed_kts') colIndices['speed_kts'] = i;
      else if (h === 'course_deg') colIndices['course_deg'] = i;
    }

    // Processed-CSV column detection (re-imported data)
    let peakLabelColIndex = -1;
    let isPeakColIndex = -1;
    let peakExcludedColIndex = -1;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (h.includes('peaklabel') || h.includes('peak_label')) peakLabelColIndex = i;
      if (h.includes('ispeak') || h.includes('is_peak')) isPeakColIndex = i;
      if (h.includes('peakexcluded') || h.includes('peak_excluded')) peakExcludedColIndex = i;
    }

    // Explicit genuine-fix marker (re-imported processed CSV only). Without this,
    // a reimported track's dense Latitude/Longitude columns would make every row
    // look like a genuine fix, collapsing the anchor-only Kalman input in
    // map.js's _collectGpsPoints down to the full interpolated grid. Falls back
    // to the lat/lon-presence heuristic below when absent (raw device CSVs, or
    // processed CSVs exported before this column existed).
    const isGpsFixColIdx = headers.indexOf('is_gps_fix');

    // OSM environmental column detection
    let osmRoadClassColIdx = headers.indexOf('osm_road_class');
    let osmDistMajorRoadColIdx = headers.indexOf('osm_dist_major_road');
    let osmInParkColIdx = headers.indexOf('osm_in_park');
    let osmGreenPctColIdx = headers.indexOf('osm_green_pct_50m');
    let osmDistGreenColIdx = headers.indexOf('osm_dist_green');
    let osmCanopyPctColIdx = headers.indexOf('osm_canopy_pct_50m');
    let osmBldDensityColIdx = headers.indexOf('osm_building_density_50m');
    let osmDistWaterColIdx = headers.indexOf('osm_dist_water');
    let osmTreeDensityColIdx = headers.indexOf('osm_tree_density_50m');
    let osmAmenityCountColIdx = headers.indexOf('osm_amenity_count_50m');
    let ndviColIdx = headers.indexOf('ndvi');
    let ndvi50mColIdx = headers.indexOf('ndvi_50m');

    // RF column detection (300, 315, 434, 446, 815, 868, 915 MHz RSSI & EM fog)
    // EM fog has a legacy alias (subghz_em_fog) so it's handled separately.
    const RF_BANDS = ['rssi_300', 'rssi_315', 'rssi_434', 'rssi_446', 'rssi_815', 'rssi_868', 'rssi_915'];
    const rfColIdx = {};
    for (const band of RF_BANDS) rfColIdx[band] = headers.indexOf(band);
    let emFogColIdx = headers.indexOf('em_fog') !== -1 ? headers.indexOf('em_fog') : headers.indexOf('subghz_em_fog');

    // Fallbacks for main biometric columns
    if (colIndices['timestamp'] === -1) colIndices['timestamp'] = 0;
    if (colIndices['gsr_raw'] === -1) colIndices['gsr_raw'] = headers.length > 1 ? 1 : 0;

    // Parse data rows
    let rawDataList = [];
    for (let i = dataStartLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;

      const cols = GSRCSVParser._parseCsvLine(line);
      if (cols.length === 0) continue;

      let rawTimeStr = cols[colIndices['timestamp']] ? cols[colIndices['timestamp']].trim() : '';
      let timeVal = NaN;

      // Parse timestamp
      if (rawTimeStr.includes('-') || rawTimeStr.includes(':') || rawTimeStr.includes('T')) {
        let parsedDate = Date.parse(rawTimeStr);
        if (!isNaN(parsedDate)) {
          timeVal = parsedDate / 1000.0;
        }
      }
      if (isNaN(timeVal)) {
        timeVal = parseFloat(rawTimeStr);
      }

      let gsrVal = (colIndices['gsr_raw'] !== -1 && cols[colIndices['gsr_raw']]) ? parseFloat(cols[colIndices['gsr_raw']]) : NaN;

      // Parse RF fields (dBm)
      const rfRow = {};
      for (const band of RF_BANDS) {
        const idx = rfColIdx[band];
        rfRow[band] = idx !== -1 && cols[idx] ? parseFloat(cols[idx]) : NaN;
      }
      let { rssi_300, rssi_315, rssi_434, rssi_446, rssi_815, rssi_868, rssi_915 } = rfRow;
      let em_fog = emFogColIdx !== -1 && cols[emFogColIdx] ? parseFloat(cols[emFogColIdx]) : NaN;

      // Dynamic fallback for EM Fog if missing or NaN but RSSI values exist
      if (isNaN(em_fog)) {
        em_fog = GSRAnalyzer.calcEmFog({ rssi_300, rssi_315, rssi_434, rssi_446, rssi_815, rssi_868, rssi_915 });
      }

      // Parse GPS fields (empty fields parse to NaN)
      let latVal = colIndices['lat'] !== -1 && cols[colIndices['lat']] ? parseFloat(cols[colIndices['lat']]) : NaN;
      let lonVal = colIndices['lon'] !== -1 && cols[colIndices['lon']] ? parseFloat(cols[colIndices['lon']]) : NaN;

      // Fallback for standalone GPS + RF CSVs (where GSR is missing/NaN)
      if (isNaN(gsrVal)) {
        if (!isNaN(latVal) || !isNaN(lonVal) || !isNaN(rssi_815) || !isNaN(rssi_868) || !isNaN(rssi_915) || !isNaN(rssi_300) || !isNaN(rssi_315) || !isNaN(rssi_434) || !isNaN(rssi_446) || !isNaN(em_fog)) {
          gsrVal = 1.0; // Baseline value so standalone RF/GPS rows are kept
        } else {
          continue;
        }
      }
      if (isNaN(timeVal)) continue;

      let hdopVal     = colIndices['hdop']  !== -1 && cols[colIndices['hdop']]  ? parseFloat(cols[colIndices['hdop']])  : NaN;
      let pdopVal     = colIndices['pdop']  !== -1 && cols[colIndices['pdop']]  ? parseFloat(cols[colIndices['pdop']])  : NaN;
      let haccVal     = colIndices['hacc_m'] !== -1 && cols[colIndices['hacc_m']] ? parseFloat(cols[colIndices['hacc_m']]) : NaN;
      let satsVal     = colIndices['sats']  !== -1 && cols[colIndices['sats']]  ? parseInt(cols[colIndices['sats']])    : 0;
      let fixTypeVal  = colIndices['fix_type'] !== -1 && cols[colIndices['fix_type']] ? parseInt(cols[colIndices['fix_type']]) : 0;
      let speedKtsVal = colIndices['speed_kts'] !== -1 && cols[colIndices['speed_kts']] ? parseFloat(cols[colIndices['speed_kts']]) : NaN;
      let courseVal   = colIndices['course_deg']   !== -1 && cols[colIndices['course_deg']]   ? parseFloat(cols[colIndices['course_deg']])   : NaN;

      // Genuine-fix marker: prefer the explicit re-imported column when present
      let isGpsFixVal = !isNaN(latVal) && !isNaN(lonVal);
      if (isGpsFixColIdx !== -1 && cols[isGpsFixColIdx] && cols[isGpsFixColIdx].trim() !== '') {
        isGpsFixVal = cols[isGpsFixColIdx].trim() === '1';
      }

      // Read peak label from processed-CSV re-import
      let importedPeakLabel = '';
      let importedPeakExcluded = false;
      if (peakLabelColIndex !== -1 && isPeakColIndex !== -1 &&
          cols[isPeakColIndex] && parseInt(cols[isPeakColIndex]) === 1) {
        importedPeakLabel = (cols[peakLabelColIndex] || '').replace(/^"|"$/g, '').trim();
        if (peakExcludedColIndex !== -1 && cols[peakExcludedColIndex]) {
          importedPeakExcluded = (cols[peakExcludedColIndex].trim() === '1');
        }
      }

      // Parse OSM fields
      let osm_road_class = osmRoadClassColIdx !== -1 && cols[osmRoadClassColIdx] ? cols[osmRoadClassColIdx].trim().replace(/^"|"$/g, '') : null;
      let osm_dist_major_road = osmDistMajorRoadColIdx !== -1 && cols[osmDistMajorRoadColIdx] ? parseFloat(cols[osmDistMajorRoadColIdx]) : NaN;
      let osm_in_park = osmInParkColIdx !== -1 && cols[osmInParkColIdx] ? parseInt(cols[osmInParkColIdx]) : NaN;
      let osm_green_pct_50m = osmGreenPctColIdx !== -1 && cols[osmGreenPctColIdx] ? parseFloat(cols[osmGreenPctColIdx]) : NaN;
      let osm_dist_green = osmDistGreenColIdx !== -1 && cols[osmDistGreenColIdx] ? parseFloat(cols[osmDistGreenColIdx]) : NaN;
      let osm_canopy_pct_50m = osmCanopyPctColIdx !== -1 && cols[osmCanopyPctColIdx] ? parseFloat(cols[osmCanopyPctColIdx]) : NaN;
      let osm_building_density_50m = osmBldDensityColIdx !== -1 && cols[osmBldDensityColIdx] ? parseFloat(cols[osmBldDensityColIdx]) : NaN;
      let osm_dist_water = osmDistWaterColIdx !== -1 && cols[osmDistWaterColIdx] ? parseFloat(cols[osmDistWaterColIdx]) : NaN;
      let osm_tree_density_50m = osmTreeDensityColIdx !== -1 && cols[osmTreeDensityColIdx] ? parseFloat(cols[osmTreeDensityColIdx]) : NaN;
      let osm_amenity_count_50m = osmAmenityCountColIdx !== -1 && cols[osmAmenityCountColIdx] ? parseFloat(cols[osmAmenityCountColIdx]) : NaN;
      let ndviVal = ndviColIdx !== -1 && cols[ndviColIdx] ? parseFloat(cols[ndviColIdx]) : NaN;
      let ndvi50mVal = ndvi50mColIdx !== -1 && cols[ndvi50mColIdx] ? parseFloat(cols[ndvi50mColIdx]) : NaN;

      rawDataList.push({
        time: timeVal,
        val: gsrVal,
        lat: latVal,
        lon: lonVal,
        hdop: hdopVal,
        pdop: pdopVal,
        hacc: haccVal,
        sats: satsVal,
        fixType: fixTypeVal,
        speedKts: speedKtsVal,
        course: courseVal,
        hasGps: false,
        _isGpsFix: isGpsFixVal,
        _importLabel: importedPeakLabel,
        _importExcluded: importedPeakExcluded,
        rssi_300: rssi_300,
        rssi_315: rssi_315,
        rssi_434: rssi_434,
        rssi_446: rssi_446,
        rssi_815: rssi_815,
        rssi_868: rssi_868,
        rssi_915: rssi_915,
        em_fog: em_fog,
        osm_road_class: osm_road_class,
        osm_dist_major_road: osm_dist_major_road,
        osm_in_park: osm_in_park,
        osm_green_pct_50m: osm_green_pct_50m,
        osm_dist_green: osm_dist_green,
        osm_canopy_pct_50m: osm_canopy_pct_50m,
        osm_building_density_50m: osm_building_density_50m,
        osm_dist_water: osm_dist_water,
        osm_tree_density_50m: osm_tree_density_50m,
        osm_amenity_count_50m: osm_amenity_count_50m,
        ndvi: ndviVal,
        ndvi_50m: ndvi50mVal
      });
    }

    if (rawDataList.length === 0) {
      throw new Error("No valid numeric data found in CSV.");
    }

    // ── Input validation ──────────────────────────────────────────────────
    const warnings = [];

    // Check timestamp monotonicity
    let timeReversals = 0;
    for (let i = 1; i < rawDataList.length; i++) {
      if (rawDataList[i].time < rawDataList[i - 1].time) timeReversals++;
    }
    if (timeReversals > 0) {
      warnings.push(`Timestamps are non-monotonic (${timeReversals} reversals). Data may be corrupted.`);
    }

    // Check GSR value range (physiological: 0.1–50 000 nS)
    const gsrVals = rawDataList.map(d => d.val);
    const gsrMin = Math.min(...gsrVals);
    const gsrMax = Math.max(...gsrVals);
    if (gsrMin < 0.1) {
      warnings.push(`GSR contains near-zero values (min ${gsrMin.toFixed(1)} nS). Sensor may have been disconnected.`);
    }
    if (gsrMax > 50000) {
      warnings.push(`GSR contains rail-saturation values (max ${gsrMax.toFixed(0)} nS). Sensor may have been disconnected.`);
    }

    // Check for a flatlined / stuck signal. A genuine skin-contact recording
    // always carries some tonic drift and micro-variation; a trace that never
    // moves (or takes only a handful of distinct values) means the electrode
    // was not in contact — the tonic/phasic decomposition then yields an
    // all-zero phasic and no SCR can be detected, so the analysis comes back
    // empty with no other explanation. Relative std cutoff (0.05 %) separates
    // a dead trace from a real low-arousal one (real quiet tracks still run
    // ~1–2 % relative std after electrode contact).
    let gsrMean = 0;
    for (const v of gsrVals) gsrMean += v;
    gsrMean /= gsrVals.length;
    let gsrSq = 0;
    for (const v of gsrVals) gsrSq += (v - gsrMean) ** 2;
    const gsrStd = Math.sqrt(gsrSq / gsrVals.length);
    const distinctGsr = new Set(gsrVals).size;
    if (gsrVals.length >= 50 && (distinctGsr <= 3 || (gsrMean > 0 && gsrStd / gsrMean < 5e-4))) {
      warnings.push(`GSR signal is flat (${distinctGsr} distinct value${distinctGsr === 1 ? '' : 's'}, ` +
        `std ${gsrStd.toPrecision(2)}). Electrode was likely not in skin contact — no SCR peaks can be detected.`);
    }

    // Check for (0, 0) GPS sentinel values
    const zeroGps = rawDataList.filter(d => !isNaN(d.lat) && !isNaN(d.lon) && d.lat === 0 && d.lon === 0).length;
    if (zeroGps > 0) {
      warnings.push(`${zeroGps} GPS points at (0, 0) — likely startup sentinel values.`);
    }

    // Check GSR coverage
    const gsrPresent = rawDataList.filter(d => !isNaN(d.val)).length;
    if (gsrPresent < rawDataList.length * 0.5) {
      warnings.push(`Only ${gsrPresent}/${rawDataList.length} rows have GSR data. Check CSV format.`);
    }

    let csvWarnings = null;
    if (warnings.length > 0) {
      console.warn('CSV validation warnings:', warnings);
      csvWarnings = warnings;
    }

    // Sort chronologically
    rawDataList.sort((a, b) => a.time - b.time);

    // Reconstruct sub-second timestamps if multiple rows share identical seconds
    let hasDuplicates = false;
    for (let i = 1; i < rawDataList.length; i++) {
      if (rawDataList[i].time === rawDataList[i - 1].time) {
        hasDuplicates = true;
        break;
      }
    }

    if (hasDuplicates) {
      const firstTime = rawDataList[0].time;
      const lastTime = rawDataList[rawDataList.length - 1].time;
      const totalTimeDiff = lastTime - firstTime;
      if (totalTimeDiff > 0) {
        const step = totalTimeDiff / (rawDataList.length - 1);
        for (let i = 0; i < rawDataList.length; i++) {
          rawDataList[i].time = firstTime + i * step;
        }
      } else {
        for (let i = 0; i < rawDataList.length; i++) {
          rawDataList[i].time = i * 0.1;
        }
      }
    }

    // Store the recording start clock time (Unix epoch seconds).
    // If already restored from a metadata line (re-import), don't overwrite it.
    if (recordingStartTime === 0) {
      recordingStartTime = rawDataList.length > 0 ? rawDataList[0].time : 0;
    }

    // Offset timestamps relative to session start (0.0s)
    if (rawDataList.length > 0) {
      const startTime = rawDataList[0].time;
      rawDataList.forEach(d => {
        d.time = d.time - startTime;
      });
    }

    // Build imported peak label and exclusion lookup (time→label/excluded, after offset)
    const importedPeakLabels = new Map();
    const importedPeakExcluded = new Map();
    for (const d of rawDataList) {
      if (d._importLabel) {
        importedPeakLabels.set(d.time, d._importLabel);
      }
      if (d._importExcluded) importedPeakExcluded.set(d.time, true);
      delete d._importLabel;
      delete d._importExcluded;
    }

    // Auto-detect sample rate
    let sampleRate = 10.0;
    let timeDiffs = [];
    for (let i = 1; i < Math.min(100, rawDataList.length); i++) {
      let diff = rawDataList[i].time - rawDataList[i - 1].time;
      if (diff > 0) timeDiffs.push(diff);
    }
    if (timeDiffs.length > 0) {
      const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
      sampleRate = 1.0 / avgDiff;
    }

    // Auto-detect Units and convert to MicroSiemens (uS)
    const avgVal = rawDataList.reduce((sum, d) => sum + d.val, 0) / rawDataList.length;
    const gsrHeader = headers[colIndices['gsr_raw']] || "";
    const isResistanceHeader = gsrHeader.includes('resistance') || gsrHeader.includes('ohms');

    if (isResistanceHeader || avgVal > GSR_CONST.RESISTANCE_MIN_AVG) {
      isResistance = true;
      rawDataList.forEach(d => {
        d.val = d.val > 0 ? (1000000.0 / d.val) : 0;
      });
    } else if (avgVal > GSR_CONST.MICROSIEMENS_MIN_AVG && avgVal <= GSR_CONST.MICROSIEMENS_MAX_AVG) {
      rawDataList.forEach(d => {
        d.val = d.val / 1000.0;
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Linear Interpolation for Sparse 10 Hz GPS Coordinates
    // ─────────────────────────────────────────────────────────────────────────
    GSRCSVParser._interpolateGPS(rawDataList);

    const hasRfData = rawDataList.some(r => !isNaN(r.rssi_300) || !isNaN(r.rssi_315) || !isNaN(r.rssi_434) || !isNaN(r.rssi_446) || !isNaN(r.rssi_815) || !isNaN(r.rssi_868) || !isNaN(r.rssi_915) || !isNaN(r.em_fog));
    const rfPeakIndices = hasRfData ? GSRCSVParser._detectRfPeakIndices(rawDataList) : new Set();

    // Check if imported CSV is already enriched
    let isEnriched = false;
    if (osmRoadClassColIdx !== -1 || osmGreenPctColIdx !== -1 || ndviColIdx !== -1 || ndvi50mColIdx !== -1) {
      isEnriched = true;
      if (!enrichmentRadius) enrichmentRadius = 50; // fallback default
    } else {
      isEnriched = false;
      enrichmentRadius = null;
    }

    // Integrity bracket check (docs/csv_schema.md). dataStartLine is the
    // index of the column-name line, so dataStartLine + 1 lines precede the
    // first data row.
    const integrity = GSRCSVParser._verifyIntegrity(csvText, hasIntegrityMarker, dataStartLine + 1);

    return {
      raw: rawDataList,
      isResistance: isResistance,
      recordingStartTime: recordingStartTime,
      importedFilterParams: importedFilterParams,
      importedGpsFilterParams: importedGpsFilterParams,
      enrichmentRadius: enrichmentRadius,
      bandFloors: bandFloors,
      sampleRate: sampleRate,
      hasRfData: hasRfData,
      rfPeakIndices: rfPeakIndices,
      isEnriched: isEnriched,
      integrity: integrity,
      warnings: csvWarnings,
      importedPeakLabels: importedPeakLabels,
      importedPeakExcluded: importedPeakExcluded
    };
  }
}

if (typeof window !== 'undefined') window.GSRCSVParser = GSRCSVParser;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRCSVParser };
}
