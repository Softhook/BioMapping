// GSR/EDA Signal Analysis Engine with GPS coordinate parsing and interpolation
// Handles variable-rate (10 Hz GSR, up to 5 Hz GPS) CSV files.

class GSRAnalyzer {
  constructor() {
    this.raw = [];          // Raw signal: { time, val, lat, lon, hdop, pdop, sats, fixType, speedKts, course, hasGps }
    this.filtered = [];     // Cleaned signal: { time, val }
    this.tonic = [];        // Tonic component (SCL): { time, val }
    this.phasic = [];       // Phasic component (SCR): { time, val }
    this.tonicZ = [];       // Z-score Tonic component (SCL): { time, val }
    this.phasicZ = [];      // Z-score Phasic component (SCR): { time, val }
    this.phasicStd = 1;     // Standard deviation of phasic component for Z-scaling peaks
    this.peaks = [];        // Detected peaks with shape metrics:
                            // { time, index, amplitude, onsetIndex, onsetTime, halfRecoveryTime,
                            //   riseTime, onsetSlope, decaySlope, skewnessRatio, fwhm, snr,
                            //   qualityScore, salienceScore, label }
    this.memorableEvents = []; // Subset of this.peaks likely to be noticed/remembered
                                // (fast, high-amplitude) — see _computeSalienceScore().
                                // A different question from qualityScore: "was this real"
                                // vs "would a person notice this". Not a replacement for
                                // this.peaks, a companion view over the same list.

    // Continuous, threshold-independent arousal metrics (see
    // docs/environmental_stress_literature_review.md §5-6). These resolve the
    // "thresholding dilemma" and "superposition problem" inherent to discrete
    // peak counting by integrating the phasic signal rather than gating it.
    this.peakDensity = [];  // Sliding-window NS-SCR frequency: { time, val } — peaks/minute
    this.phasicAUC = [];    // Sliding-window Phasic AUC (ISCR): { time, val } — µS·s
    this.arousalIndex = []; // Combined tonic+phasic z-scored blend: { time, val }

    // Deconvolution state (Benedek & Kaernbach, 2010).
    this.phasicDriver = [];       // Raw driver signal: { time, val }
    this.phasicClean = [];        // Reconstructed clean phasic
    this.phasicDriverPeaks = [];  // Driver impulse list
    this.phasicDeconvTruncated = false; // True if matching pursuit hit maxIter before converging
    this._phasicOrig = null;      // Pre-deconvolution phasic backup (only set when deconvolution is on)

    this.sampleRate = 10;   // In Hz, auto-detected
    this.isResistance = false; // Whether original CSV was resistance (Ohms)
    this.filteredGps = [];
    this._userPeakLabels = new Map(); // Persistent time-indexed store: timestamp (sec) -> label string
  }

  /**
   * Register or update a user-assigned peak label by timestamp.
   * @param {number} time - Peak timestamp in seconds
   * @param {string} label - Text label for the peak
   */
  setPeakLabel(time, label) {
    if (time == null) return;
    const cleanLabel = (label || '').trim();
    const key = Number(time.toFixed(3));
    if (cleanLabel) {
      this._userPeakLabels.set(key, cleanLabel);
    } else {
      this._userPeakLabels.delete(key);
      for (const [t] of this._userPeakLabels.entries()) {
        if (Math.abs(t - time) <= 0.2) {
          this._userPeakLabels.delete(t);
        }
      }
    }
  }

  /**
   * Retrieve a user peak label by timestamp, using exact match first then nearest-neighbor lookup within tolerance.
   * @param {number} targetTime - Peak timestamp in seconds
   * @param {number} [maxToleranceSec=1.0] - Proximity window tolerance in seconds
   * @returns {string} Matching label or empty string
   */
  getMatchingLabel(targetTime, maxToleranceSec = 1.0) {
    if (targetTime == null || this._userPeakLabels.size === 0) return '';
    const key = Number(targetTime.toFixed(3));
    if (this._userPeakLabels.has(key)) {
      return this._userPeakLabels.get(key);
    }
    let bestMatch = '';
    let minDiff = Infinity;
    for (const [t, label] of this._userPeakLabels.entries()) {
      const diff = Math.abs(t - targetTime);
      if (diff <= maxToleranceSec && diff < minDiff) {
        minDiff = diff;
        bestMatch = label;
      }
    }
    return bestMatch;
  }

  /**
   * Assign persistent user labels to a list of detected peak objects using optimal 1-to-1 timestamp matching.
   * @param {Array<object>} peaks - List of detected peak objects
   * @private
   */
  _assignLabelsToPeaks(peaks) {
    if (!peaks || peaks.length === 0 || !this._userPeakLabels || this._userPeakLabels.size === 0) return;

    // Build list of candidate (peak, labelKey, diff) pairs within tolerance window (1.0s)
    const candidates = [];
    for (let pIdx = 0; pIdx < peaks.length; pIdx++) {
      const peak = peaks[pIdx];
      const pTime = peak.time;
      for (const [tKey, labelStr] of this._userPeakLabels.entries()) {
        const diff = Math.abs(pTime - tKey);
        if (diff <= 1.0 && labelStr) {
          candidates.push({ pIdx, tKey, labelStr, diff });
        }
      }
    }

    // Sort candidate pairs by ascending distance diff (closest matches first)
    candidates.sort((a, b) => a.diff - b.diff);

    // Greedily match 1-to-1: each peak gets at most 1 label, and each label key is used at most once
    const assignedPeaks = new Set();
    const assignedLabels = new Set();

    for (const cand of candidates) {
      if (!assignedPeaks.has(cand.pIdx) && !assignedLabels.has(cand.tKey)) {
        peaks[cand.pIdx].label = cand.labelStr;
        assignedPeaks.add(cand.pIdx);
        assignedLabels.add(cand.tKey);
      }
    }
  }


  /**
   * Parse one CSV line into fields, honoring quoted commas and escaped quotes.
   */
  _parseCsvLine(line) {
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
   */
  _csvEscape(val) {
    if (val === null || val === undefined) return '';
    const str = String(val).replace(/"/g, '""');
    return '"' + str + '"';
  }

  /**
   * Binary search the raw data array for the index closest to a target time.
   */
  findClosestIndex(targetTime) {
    if (!this.raw || this.raw.length === 0) return -1;
    const data = this.raw;
    let low = 0;
    let high = data.length - 1;

    if (targetTime <= data[low].time) return low;
    if (targetTime >= data[high].time) return high;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midTime = data[mid].time;

      if (midTime === targetTime) return mid;

      if (midTime < targetTime) {
        if (mid < data.length - 1 && data[mid + 1].time > targetTime) {
          return (targetTime - midTime < data[mid + 1].time - targetTime) ? mid : mid + 1;
        }
        low = mid + 1;
      } else {
        if (mid > 0 && data[mid - 1].time < targetTime) {
          return (targetTime - data[mid - 1].time < midTime - targetTime) ? mid - 1 : mid;
        }
        high = mid - 1;
      }
    }
    return -1;
  }

  /**
   * Helper: gets coordinates at a given index from filtered GPS data if valid,
   * otherwise falls back to raw GPS data. Returns { lat, lon } or null.
   */
  getCoordinates(index, preferRaw = false) {
    const raw = this.raw[index];
    if (preferRaw && raw && !isNaN(raw.lat) && !isNaN(raw.lon)) {
      return { lat: raw.lat, lon: raw.lon };
    }
    const filtered = this.filteredGps && this.filteredGps[index];
    if (filtered && !isNaN(filtered.lat) && !isNaN(filtered.lon)) {
      return { lat: filtered.lat, lon: filtered.lon };
    }
    if (raw && !isNaN(raw.lat) && !isNaN(raw.lon)) {
      return { lat: raw.lat, lon: raw.lon };
    }
    return null;
  }

  /**
   * Format a relative time (seconds from recording start) as a clock time string.
   * If recordingStartTime is set (real timestamps were in the CSV), returns
   * a formatted time like "14:32:05".
   * Falls back to relative seconds display when no real clock time is available.
   */
  formatClockTime(relativeSeconds) {
    const absSeconds = this.recordingStartTime + relativeSeconds;
    const d = new Date(absSeconds * 1000);

    // If recordingStartTime is 0 or not a real date, show relative time
    if (!this.recordingStartTime || this.recordingStartTime < 86400) {
      const totalSec = Math.round(relativeSeconds);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      return h > 0
        ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
        : m + ':' + String(s).padStart(2, '0');
    }

    const hours = d.getUTCHours();
    const mins = d.getUTCMinutes();
    const secs = d.getUTCSeconds();
    return String(hours).padStart(2, '0') + ':' +
           String(mins).padStart(2, '0') + ':' +
           String(secs).padStart(2, '0');
  }

  /**
   * Returns just the formatted clock time, e.g. "14:32:05".
   * Falls back to relative seconds when no real clock time is available.
   */
  formatTimeOnly(relativeSeconds) {
    const absSeconds = this.recordingStartTime + relativeSeconds;
    const d = new Date(absSeconds * 1000);

    if (!this.recordingStartTime || this.recordingStartTime < 86400) {
      return this.formatClockTime(relativeSeconds);
    }

    return String(d.getUTCHours()).padStart(2, '0') + ':' +
           String(d.getUTCMinutes()).padStart(2, '0') + ':' +
           String(d.getUTCSeconds()).padStart(2, '0');
  }

  /**
   * Returns a UK-formatted date string, e.g. "30th Dec 2026".
   * Falls back to relative seconds display when no real clock time is available.
   */
  formatDateUK(relativeSeconds) {
    const absSeconds = this.recordingStartTime + relativeSeconds;
    const d = new Date(absSeconds * 1000);

    if (!this.recordingStartTime || this.recordingStartTime < 86400) {
      return this.formatClockTime(relativeSeconds);
    }

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = d.getUTCDate();
    const month = months[d.getUTCMonth()];
    const year = d.getUTCFullYear();

    // Ordinal suffix
    let suffix = 'th';
    if (day % 10 === 1 && day !== 11) suffix = 'st';
    else if (day % 10 === 2 && day !== 12) suffix = 'nd';
    else if (day % 10 === 3 && day !== 13) suffix = 'rd';

    return day + suffix + ' ' + month + ' ' + year;
  }

  /**
   * Returns a short numeric date string, e.g. "30.12.2026".
   * Falls back to relative seconds display when no real clock time is available.
   */
  formatDateShort(relativeSeconds) {
    const absSeconds = this.recordingStartTime + relativeSeconds;
    const d = new Date(absSeconds * 1000);

    if (!this.recordingStartTime || this.recordingStartTime < 86400) {
      return this.formatClockTime(relativeSeconds);
    }

    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();

    return day + '.' + month + '.' + year;
  }

  /**
   * Parse CSV string into raw time/value objects with GPS columns.
   * Interpolates GPS coordinates to reconstruct a continuous 10 Hz path.
   */
  parseCSV(csvText) {
    this.raw = [];
    this.isResistance = false;

    // Split into lines
    const lines = csvText.split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error("CSV file is empty or has too few lines.");
    }

    // Restore recordingStartTime and filter configurations from metadata comment lines
    this.recordingStartTime = 0;
    this.importedFilterParams = null;
    this.importedGpsFilterParams = null;
    this.enrichmentRadius = null;
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
          this.recordingStartTime = metaVal;
        }
      } else if (line.startsWith('# FilterParams:')) {
        try {
          this.importedFilterParams = JSON.parse(line.substring('# FilterParams:'.length).trim());
        } catch (e) {
          console.warn("Failed to parse FilterParams metadata:", e);
        }
      } else if (line.startsWith('# GpsFilterParams:')) {
        try {
          this.importedGpsFilterParams = JSON.parse(line.substring('# GpsFilterParams:'.length).trim());
        } catch (e) {
          console.warn("Failed to parse GpsFilterParams metadata:", e);
        }
      } else if (line.startsWith('# EnrichmentRadius:')) {
        const radVal = parseFloat(line.substring('# EnrichmentRadius:'.length));
        if (!isNaN(radVal)) {
          this.enrichmentRadius = radVal;
        }
      }
      dataStartLine++;
    }

    // Read headers
    const headerLine = lines[dataStartLine];
    const headers = this._parseCsvLine(headerLine).map(h => h.trim().toLowerCase());

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
    let osmBldDensityColIdx = headers.indexOf('osm_building_density_50m');
    let osmDistWaterColIdx = headers.indexOf('osm_dist_water');
    let osmTreeDensityColIdx = headers.indexOf('osm_tree_density_50m');
    let osmAmenityCountColIdx = headers.indexOf('osm_amenity_count_50m');

    // RF column detection (300, 315, 434, 446, 815, 868, 915 MHz RSSI & EM fog)
    let rssi300ColIdx = headers.indexOf('rssi_300');
    let rssi315ColIdx = headers.indexOf('rssi_315');
    let rssi434ColIdx = headers.indexOf('rssi_434');
    let rssi446ColIdx = headers.indexOf('rssi_446');
    let rssi815ColIdx = headers.indexOf('rssi_815');
    let rssi868ColIdx = headers.indexOf('rssi_868');
    let rssi915ColIdx = headers.indexOf('rssi_915');
    let emFogColIdx   = headers.indexOf('em_fog') !== -1 ? headers.indexOf('em_fog') : headers.indexOf('subghz_em_fog');

    // Fallbacks for main biometric columns
    if (colIndices['timestamp'] === -1) colIndices['timestamp'] = 0;
    if (colIndices['gsr_raw'] === -1) colIndices['gsr_raw'] = headers.length > 1 ? 1 : 0;

    // Parse data rows
    let rawDataList = [];
    for (let i = dataStartLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;

      const cols = this._parseCsvLine(line);
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
      let rssi_300 = rssi300ColIdx !== -1 && cols[rssi300ColIdx] ? parseFloat(cols[rssi300ColIdx]) : NaN;
      let rssi_315 = rssi315ColIdx !== -1 && cols[rssi315ColIdx] ? parseFloat(cols[rssi315ColIdx]) : NaN;
      let rssi_434 = rssi434ColIdx !== -1 && cols[rssi434ColIdx] ? parseFloat(cols[rssi434ColIdx]) : NaN;
      let rssi_446 = rssi446ColIdx !== -1 && cols[rssi446ColIdx] ? parseFloat(cols[rssi446ColIdx]) : NaN;
      let rssi_815 = rssi815ColIdx !== -1 && cols[rssi815ColIdx] ? parseFloat(cols[rssi815ColIdx]) : NaN;
      let rssi_868 = rssi868ColIdx !== -1 && cols[rssi868ColIdx] ? parseFloat(cols[rssi868ColIdx]) : NaN;
      let rssi_915 = rssi915ColIdx !== -1 && cols[rssi915ColIdx] ? parseFloat(cols[rssi915ColIdx]) : NaN;
      let em_fog   = emFogColIdx   !== -1 && cols[emFogColIdx]   ? parseFloat(cols[emFogColIdx])   : NaN;

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
      let osm_building_density_50m = osmBldDensityColIdx !== -1 && cols[osmBldDensityColIdx] ? parseFloat(cols[osmBldDensityColIdx]) : NaN;
      let osm_dist_water = osmDistWaterColIdx !== -1 && cols[osmDistWaterColIdx] ? parseFloat(cols[osmDistWaterColIdx]) : NaN;
      let osm_tree_density_50m = osmTreeDensityColIdx !== -1 && cols[osmTreeDensityColIdx] ? parseFloat(cols[osmTreeDensityColIdx]) : NaN;
      let osm_amenity_count_50m = osmAmenityCountColIdx !== -1 && cols[osmAmenityCountColIdx] ? parseFloat(cols[osmAmenityCountColIdx]) : NaN;

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
        osm_building_density_50m: osm_building_density_50m,
        osm_dist_water: osm_dist_water,
        osm_tree_density_50m: osm_tree_density_50m,
        osm_amenity_count_50m: osm_amenity_count_50m
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

    // Check for (0, 0) GPS sentinel values
    const zeroGps = rawDataList.filter(d => d.hasGps && d.lat === 0 && d.lon === 0).length;
    if (zeroGps > 0) {
      warnings.push(`${zeroGps} GPS points at (0, 0) — likely startup sentinel values.`);
    }

    // Check GSR coverage
    const gsrPresent = rawDataList.filter(d => !isNaN(d.val)).length;
    if (gsrPresent < rawDataList.length * 0.5) {
      warnings.push(`Only ${gsrPresent}/${rawDataList.length} rows have GSR data. Check CSV format.`);
    }

    if (warnings.length > 0) {
      console.warn('CSV validation warnings:', warnings);
      this._csvWarnings = warnings;
    } else {
      this._csvWarnings = null;
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
    if (this.recordingStartTime === 0) {
      this.recordingStartTime = rawDataList.length > 0 ? rawDataList[0].time : 0;
    }

    // Offset timestamps relative to session start (0.0s)
    if (rawDataList.length > 0) {
      const startTime = rawDataList[0].time;
      rawDataList.forEach(d => {
        d.time = d.time - startTime;
      });
    }

    // Build imported peak label and exclusion lookup (time→label/excluded, after offset)
    this._importedPeakLabels = new Map();
    this._importedPeakExcluded = new Map();
    for (const d of rawDataList) {
      if (d._importLabel) {
        this._importedPeakLabels.set(d.time, d._importLabel);
        this.setPeakLabel(d.time, d._importLabel);
      }
      if (d._importExcluded) this._importedPeakExcluded.set(d.time, true);
      delete d._importLabel;
      delete d._importExcluded;
    }

    // Auto-detect sample rate
    let timeDiffs = [];
    for (let i = 1; i < Math.min(100, rawDataList.length); i++) {
      let diff = rawDataList[i].time - rawDataList[i - 1].time;
      if (diff > 0) timeDiffs.push(diff);
    }
    if (timeDiffs.length > 0) {
      const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
      this.sampleRate = 1.0 / avgDiff;
    } else {
      this.sampleRate = 10.0;
    }

    // Auto-detect Units and convert to MicroSiemens (uS)
    const avgVal = rawDataList.reduce((sum, d) => sum + d.val, 0) / rawDataList.length;
    const gsrHeader = headers[colIndices['gsr_raw']] || "";
    const isResistanceHeader = gsrHeader.includes('resistance') || gsrHeader.includes('ohms');
    
    if (isResistanceHeader || avgVal > GSR_CONST.RESISTANCE_MIN_AVG) {
      this.isResistance = true;
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
    let gpsIndices = [];
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

    if (gpsIndices.length > 0) {
      // 1. Fill values before first GPS coordinate
      const firstGpsIdx = gpsIndices[0];
      const firstGps = rawDataList[firstGpsIdx];
      for (let i = 0; i < firstGpsIdx; i++) {
        rawDataList[i].lat     = firstGps.lat;
        rawDataList[i].lon     = firstGps.lon;
        rawDataList[i].sats    = firstGps.sats;
        rawDataList[i].hdop    = firstGps.hdop;
        rawDataList[i].pdop    = firstGps.pdop;
        rawDataList[i].fixType = firstGps.fixType;
        rawDataList[i].speedKts = firstGps.speedKts;
        rawDataList[i].course  = firstGps.course;
        rawDataList[i].hasGps  = true;
      }

      // 2. Linearly interpolate coordinates in gap intervals
      for (let k = 0; k < gpsIndices.length - 1; k++) {
        const idxA = gpsIndices[k];
        const idxB = gpsIndices[k + 1];
        const dA = rawDataList[idxA];
        const dB = rawDataList[idxB];
        const tA = dA.time;
        const tB = dB.time;

        for (let i = idxA + 1; i < idxB; i++) {
          const d = rawDataList[i];
          const tI = d.time;
          const ratio = (tI - tA) / (tB - tA);
          d.lat = dA.lat + ratio * (dB.lat - dA.lat);
          d.lon = dA.lon + ratio * (dB.lon - dA.lon);
          d.sats    = dB.sats;
          // Step-hold DOP, fix_type, and velocity from the prior GPS anchor —
          // DOP reflects satellite geometry which changes slowly (~1 min).
          // Speed/course are held rather than interpolated since they can
          // jump discontinuously at corners; the velocity-aiding filter
          // uses the per-anchor values directly.
          d.hdop    = dA.hdop;
          d.pdop    = dA.pdop;
          d.fixType = dA.fixType;
          d.speedKts = dA.speedKts;
          d.course  = dA.course;
          d.hasGps  = true;
        }
      }

      // 3. Fill values after last GPS coordinate
      const lastGpsIdx = gpsIndices[gpsIndices.length - 1];
      const lastGps = rawDataList[lastGpsIdx];
      for (let i = lastGpsIdx + 1; i < rawDataList.length; i++) {
        rawDataList[i].lat     = lastGps.lat;
        rawDataList[i].lon     = lastGps.lon;
        rawDataList[i].sats    = lastGps.sats;
        rawDataList[i].hdop    = lastGps.hdop;
        rawDataList[i].pdop    = lastGps.pdop;
        rawDataList[i].fixType = lastGps.fixType;
        rawDataList[i].speedKts = lastGps.speedKts;
        rawDataList[i].course  = lastGps.course;
        rawDataList[i].hasGps  = true;
      }
    }

    this.raw = rawDataList;
    this.hasRfData = rawDataList.some(r => !isNaN(r.rssi_300) || !isNaN(r.rssi_315) || !isNaN(r.rssi_434) || !isNaN(r.rssi_446) || !isNaN(r.rssi_815) || !isNaN(r.rssi_868) || !isNaN(r.rssi_915) || !isNaN(r.em_fog));

    // Check if imported CSV is already enriched
    if (osmRoadClassColIdx !== -1 || osmGreenPctColIdx !== -1) {
      this.isEnriched = true;
      if (!this.enrichmentRadius) this.enrichmentRadius = 50; // fallback default
    } else {
      this.isEnriched = false;
      this.enrichmentRadius = null;
    }

    return this.raw;
  }

  /**
   * Run the analysis pipeline with current parameter adjustments.
   *
   * @param {object} params - GSR filter/detection params (see GSRStorage.readGsrSliderValues()).
   * @param {number} [peakLatency=0] - GPS peak-latency compensation (seconds),
   *   from GSRStorage.readGpsSliderValues(). Used when resolving coordinates
   *   for hotspot selection (memorableEvents). Defaults to 0 (no shift).
   */
  analyze(params, peakLatency = 0) {
    if (this.raw.length === 0) return;

    const n = this.raw.length;

    // 1. Noise Median Filtering
    const medWindowSize = Math.max(1, Math.round(params.medianSize * this.sampleRate));
    let afterMedian = GsrFilter.applyMedianFilter(this.raw.map(d => d.val), medWindowSize);

    // 2. Low-Pass Filter
    const lpfWinSize = Math.max(1, Math.round(params.lpfWindow * this.sampleRate));
    let afterLPF = GsrFilter.applyZeroPhaseMovingAverage(afterMedian, lpfWinSize);

    this.filtered = this.raw.map((d, i) => ({ time: d.time, val: afterLPF[i] }));

    // 3. Tonic/Phasic Decomposition
    // 3. Tonic/Phasic Decomposition (Initial Estimate)
    let tonicVals = [];
    let phasicVals = [];

    if (params.tonicMethod === 'dwt') {
      // ── DWT Wavelet Decomposition (db3) ────────────────────────────────
      // Uses the afterLPF signal (median + low-pass filtered) as input.
      // Tonic: approximation at level N (SCL), 0–Fs/2^(N+1) Hz
      const dwtLevel = params.dwtLevel || 6;
      const result = DWT.analyzeGSR(afterLPF, dwtLevel);
      // Gentle post-smoothing (5 s window) removes DWT reconstruction
      // ripples without introducing phase lag.  Empirically, 5 s gives the
      // best tonic RMSE and phasic/truth correlation across levels 4–7.
      const smoothWin = Math.max(1, Math.round(5 * this.sampleRate));
      tonicVals = GsrFilter.applyZeroPhaseMovingAverage(result.tonic, smoothWin);
    } else {
      // ── Classical sliding-window methods ────────────────────────────────
      const tonicWinSize = Math.max(5, Math.round(params.tonicWindow * this.sampleRate));

      if (params.tonicMethod === 'median') {
        tonicVals = GsrFilter.applyMedianFilter(afterLPF, tonicWinSize);
      } else if (params.tonicMethod === 'percentile') {
        tonicVals = GsrFilter.applyPercentileFilter(afterLPF, tonicWinSize, 0.10);
      } else {
        const alpha = 2.0 / (tonicWinSize + 1);
        tonicVals = GsrFilter.applyZeroPhaseEMA(afterLPF, alpha);
      }
    }

    // 4. Phasic = Filtered - Tonic (Initial Subtraction)
    phasicVals = afterLPF.map((v, i) => v - tonicVals[i]);

    // Reposition the tonic using a local-floor approach: for each sample, find
    // the minimum of (signal - tonic) in a ±6 s window — this is how far the
    // tonic needs to drop at that point to sit at the local floor (troughs).
    // This correction is applied to all methods (dwt, median, percentile, lpf)
    // to track the lower envelope and ensure the Phasic signal is non-negative.
    const floorHalf = Math.max(1, Math.round(6 * this.sampleRate)); // ±6 s
    const localOffsets = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(0, i - floorHalf);
      const e = Math.min(n - 1, i + floorHalf);
      let mn = Infinity;
      for (let j = s; j <= e; j++) {
        if (phasicVals[j] < mn) mn = phasicVals[j];
      }
      localOffsets[i] = mn;
    }
    // Light smoothing on offset curve (4 s window) keeps the tonic responsive
    // to rapid SCR onsets without introducing jitter.
    const smoothOffsets = GsrFilter.applyZeroPhaseMovingAverage(
      localOffsets, Math.round(4 * this.sampleRate)
    );
    for (let i = 0; i < n; i++) {
      tonicVals[i] += smoothOffsets[i];  // offset is negative → moves tonic down
    }
    // Recompute phasic from repositioned tonic, clamp to ≥0
    phasicVals = afterLPF.map((v, i) => Math.max(0, v - tonicVals[i]));

    this.tonic = this.raw.map((d, i) => ({ time: d.time, val: tonicVals[i] }));
    this.phasic = this.raw.map((d, i) => ({ time: d.time, val: phasicVals[i] }));

    // Compute Z-Scores and cache standard deviation of phasic values for peak scaling
    this.tonicZ = GsrFilter.standardizeSignal(this.tonic);
    this.phasicZ = GsrFilter.standardizeSignal(this.phasic);
    this.phasicStd = GsrFilter.calculateStats(phasicVals).std;

    // 5. Phasic Peak Detection.
    // Either trough-to-peak shape-criteria detection (default), or — when
    // deconvolution is enabled — a single global SCR deconvolution pass that
    // replaces this.phasic with a resolved, superposition-free reconstruction
    // and builds peaks directly from its driver impulses. These are mutually
    // exclusive: deconvolution supersedes detectPeaks() rather than refining
    // its output, so there is exactly one pipeline building this.peaks per
    // analyze() call, and no risk of the two pipelines double-counting the
    // same SCR from overlapping local windows.
    if (params.useDeconvolution) {
      this._runDeconvolutionPipeline(phasicVals, params);
    } else {
      this.phasicDriver = [];
      this.phasicClean = [];
      this.phasicDriverPeaks = [];
      this.phasicDeconvTruncated = false;
      this._phasicOrig = null; // clear stale backup from a prior deconvolution run
      this.detectPeaks(params.peakThreshold, params);
    }

    // 5b. Memorable-event ("hotspot") view — a curated top slice of
    // this.peaks by amplitude, as opposed to the full census of every
    // detected SCR. See _computeSalienceScore()'s doc comment for why this
    // is a separate metric from qualityScore rather than folded into peak
    // filtering.
    //
    // Selection is percentile-based (top HOTSPOT_PERCENTILE by amplitude,
    // at least 1 whenever any active peak exists), not a fixed absolute
    // score threshold — an earlier version used salienceScore >= 0.5, which
    // scaled with however many peaks a recording happened to have rather
    // than staying a small, curated set: on track 059 (1395 peaks) it
    // selected 379, 27% of the census, which reads as "most peaks" rather
    // than "the standout ones". A percentile keeps the *proportion* small
    // and predictable regardless of recording length or peak count. 2% was
    // chosen by checking real yields across all four project tracks: at 2%,
    // busy/long tracks land in the high tens (28-38 on the 60-minute, ~1400-
    // 1900-peak track 059) while calm/short tracks still get a handful (3-4
    // on tracks 048/058, ~150 peaks each) rather than being rounded to zero.
    // Wider percentiles (5-20%) were also measured and rejected for the same
    // "too many to read as curated" reason that motivated moving off the
    // fixed threshold in the first place. Treat 2% as a tunable starting
    // point, not a validated ideal.
    //
    // Excluded (user-hidden) peaks are left out, matching how
    // computeTemporalPeakDensity() already treats exclusion. Sorted by
    // descending amplitude so the single biggest event is first.
    //
    // HOTSPOT_PERCENTILE lives in GSR_CONST.MEMORABLE_EVENTS (constants.js),
    // discoverable/tunable alongside every other threshold in this codebase.
    //
    // Peaks with no GPS fix (getCoordinates returns null) are skipped
    // entirely, not auto-included: GSRMapManager._renderHotspotMarkers() /
    // _renderCollectiveTrackHotspots() (map.js) both bail out with
    // `if (!coords) return;`, so an unrenderable peak selected here would
    // silently consume a slot and render nothing — shrinking the visible
    // hotspot count below targetCount for no reason, when a lower-amplitude
    // but actually renderable peak was available to take its place instead.
    const ME = GSR_CONST.MEMORABLE_EVENTS;
    {
      const activeSorted = this.peaks.filter(p => !p.excluded).sort((a, b) => {
        const scoreA = a.salienceScore != null ? a.salienceScore : a.amplitude;
        const scoreB = b.salienceScore != null ? b.salienceScore : b.amplitude;
        const diff = scoreB - scoreA;
        return Math.abs(diff) > 1e-6 ? diff : b.amplitude - a.amplitude;
      });
      const percentile = (params && params.hotspotPercentile != null)
        ? params.hotspotPercentile
        : ME.HOTSPOT_PERCENTILE;
      const targetCount = activeSorted.length > 0
        ? Math.max(1, Math.round(activeSorted.length * percentile))
        : 0;

      const selected = [];
      for (const p of activeSorted) {
        if (selected.length >= targetCount) break;
        const coords = this.getCoordinates(this._resolveHotspotIndex(p, peakLatency));
        if (!coords) continue;
        selected.push(p);
      }
      this.memorableEvents = selected;
    }

    // 6. Continuous, threshold-independent arousal metrics (ISCR/AUC + combined index + EM Fog)
    this.peakDensity = this.computeTemporalPeakDensity();
    this.phasicAUC = this.computePhasicAUC();
    this.arousalIndex = this.computeCombinedArousalIndex();
    this.em_fog = this.raw.map(d => ({ time: d.time, val: (d.em_fog !== undefined && !isNaN(d.em_fog)) ? d.em_fog : 0 }));
    this.emFog = this.em_fog;

    // 7. Build display cache for fast rendering (Y-range pyramid, timeline)
    this._buildDisplayCache();
  }

  /**
   * Derive shape metrics (rise time, half-recovery time, skewness ratio,
   * FWHM, peak onset slope) analytically from a canonical SCRF kernel.
   * Per Benedek & Kaernbach (2010) and the equivalent Ledalab/cvxEDA
   * deconvolution methods, the kernel's rise/decay time constants are
   * treated as fixed across an entire recording — the whole point of
   * deconvolving against ONE canonical response shape is that amplitude
   * becomes the only free parameter per event, which is what makes
   * superposed/overlapping SCRs separable in the first place.
   *
   * Only kPeakIdx (this function's first return value) is actually consumed
   * by _runDeconvolutionPipeline() now — it locates the kernel's own peak
   * offset for resolveApex()'s search. The other returned metrics
   * (riseTime, halfRecoveryTime, skewnessRatio, fwhm) are no longer assigned
   * to individual peaks: _detectPeaksFromCurve() measures those empirically
   * off the *reconstructed* phasicClean curve instead, since a reconstructed
   * peak's true shape reflects however many atoms summed into it, which can
   * differ from any single canonical SCR's shape (see that method's own doc
   * comment). This function is kept as-is because kPeakIdx is still needed
   * and deriving it from the kernel is still correct — just note its other
   * return values are currently unused outside this file's own callers.
   * @private
   */
  _kernelShapeMetrics(kernel, dt) {
    const kLen = kernel.length;
    let kPeakIdx = 0;
    for (let i = 0; i < kLen; i++) {
      if (kernel[i] > kernel[kPeakIdx]) kPeakIdx = i;
    }
    const riseTime = kPeakIdx * dt;
    let kHalfIdx = kPeakIdx;
    for (let i = kPeakIdx; i < kLen; i++) {
      if (kernel[i] <= 0.5) { kHalfIdx = i; break; }
    }
    const halfRecoveryTime = (kHalfIdx - kPeakIdx) * dt;
    let onsetSlopeUnit = 0;
    for (let i = 1; i <= kPeakIdx; i++) {
      const s = (kernel[i] - kernel[i - 1]) / dt;
      if (s > onsetSlopeUnit) onsetSlopeUnit = s;
    }
    const skewnessRatio = halfRecoveryTime > 0 ? riseTime / halfRecoveryTime : 0;
    let kFwhmStart = 0, kFwhmEnd = kLen - 1;
    for (let i = 0; i <= kPeakIdx; i++) {
      if (kernel[i] >= 0.5) { kFwhmStart = i; break; }
    }
    for (let i = kPeakIdx; i < kLen; i++) {
      if (kernel[i] <= 0.5) { kFwhmEnd = i; break; }
    }
    const fwhm = (kFwhmEnd - kFwhmStart) * dt;
    return { kPeakIdx, riseTime, halfRecoveryTime, onsetSlopeUnit, skewnessRatio, fwhm };
  }

  /**
   * SCR Deconvolution Pipeline (Benedek & Kaernbach, 2010).
   *
   * Runs ONE global nonnegative deconvolution over the entire phasic trace
   * (not a per-peak local window) against a canonical bi-exponential SCRF
   * kernel, recovering a sparse "driver" signal whose impulses each
   * correspond to one SCR — superposed/overlapping responses that a
   * trough-to-peak detector undercounts become separable because each
   * impulse only has to explain the residual left after every other impulse
   * already placed has been subtracted out.
   *
   * A single global pass (rather than independently deconvolving a window
   * around each already-detected peak) is deliberate: it's both what the
   * published method actually does, and it avoids a real bug the previous
   * per-peak-window version had — independently re-running deconvolution in
   * overlapping ±5s windows around nearby peaks caused the same physical SCR
   * to be explained twice from two different windows. A single pass and a
   * single global minimum-gap pass over the driver structurally rules that
   * out, matching the ~0.5s minimum-separation constraint documented in
   * the sparse-EDA-deconvolution literature.
   *
   * Known limitation carried over from the base method (Benedek & Kaernbach
   * 2010 themselves note this): nonnegative/matching-pursuit deconvolution
   * can occasionally explain residual noise as a spurious small-amplitude
   * SCR. This is mitigated here by (a) enforcing the same amplitude
   * threshold used by the non-deconvolution path, and (b) requiring each
   * impulse to correspond to a genuine local rise in the original phasic
   * signal, not just a driver-domain artifact — but it is not eliminated
   * the way a fully regularized convex solver (e.g. cvxEDA) would.
   *
   * Amplitude accuracy: MP's per-atom amplitude (residual peak value) is
   * exact for isolated SCRs but overestimates energy when adjacent kernel
   * copies overlap, because each new atom's residual is contaminated by
   * prior atoms' tails.  A post-hoc global rescaling step below corrects
   * this: after reconstruction, all impulse amplitudes are multiplied by
   * sum(phasicVals)/sum(cleanVals), bringing the aggregate energy — and
   * therefore phasicAUC, arousalIndex, and CSV-exported amplitudes — to
   * the correct scale.  The earlier +60–68% AUC inflation measured on real
   * tracks is eliminated.  Per-peak relative ordering is preserved (the
   * scalar is uniform), and position selection remains greedy MP.
   *
   * @param {Array<number>} phasicVals - Tonic-subtracted phasic values (>= 0).
   * @param {object} params - Analysis parameters (peakThreshold, minPeakQuality, shapeMinSnr).
   * @private
   */
  _runDeconvolutionPipeline(phasicVals, params) {
    const n = phasicVals.length;
    this.phasicDriver = [];
    this.phasicClean = [];
    this.phasicDriverPeaks = [];
    if (n === 0) { this.peaks = []; return; }

    // Preserve user-set labels/exclusions across re-analysis, same convention
    // as detectPeaks().
    const oldLabels = new Map();
    const oldExcluded = new Set();
    for (const pk of this.peaks) {
      if (pk.label && pk.label.trim()) {
        this.setPeakLabel(pk.time, pk.label);
        oldLabels.set(pk.index, pk.label);
      }
      if (pk.excluded) oldExcluded.add(pk.index);
    }

    const scf = GSR_CONST.SCRF;
    const dt = 1.0 / this.sampleRate;
    const times = this.phasic.map(d => d.time);
    const phasicArr = new Float64Array(phasicVals);

    const result = SCRDeconvolution.deconvolve(phasicArr, this.sampleRate, {
      tauSlow: scf.tauSlow, tauFast: scf.tauFast, kernelSec: scf.kernelSec,
      maxIter: scf.maxIter, lr: scf.lr, convTol: scf.convTol
    });

    // Diagnostic: whether matching pursuit converged (residual < convTol)
    // before exhausting its iteration budget, or was truncated by maxIter.
    // A truncated run means real SCRs may have been left unmodeled with no
    // visible sign in the results — check this if peak counts look low for
    // a long/busy recording.
    this.phasicDeconvTruncated = result.iterations >= scf.maxIter;

    this.phasicDriver = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicDriver[i] = { time: times[i], val: result.driver[i] };
    }

    // Global impulse detection: minImpulseGapSec is enforced exactly once,
    // across the whole track, so no two accepted impulses can be closer than
    // that regardless of how many original peaks would once have generated
    // overlapping local windows around them.
    const rawImpulses = SCRDeconvolution.detectImpulses(
      result.driver, this.sampleRate, scf.impulseThreshold, scf.minImpulseGapSec
    );

    // Only kPeakIdx is needed here now — it locates the kernel's own peak
    // offset for resolveApex() below. The kernel's canonical riseTime/
    // halfRecoveryTime/skewnessRatio/fwhm are no longer used to build peak
    // objects: _detectPeaksFromCurve() measures those directly off the
    // reconstructed curve instead (see its doc comment for why).
    const { kPeakIdx } = this._kernelShapeMetrics(result.kernel, dt);

    // Map each clamped driver-array position back to the individual
    // matching-pursuit atom(s) that were combined into it — usually exactly
    // one, but multiple whenever two+ atoms independently clamp to the same
    // position, which in practice only happens right at the recording
    // boundary (see deconvolve()'s clampedImpIdx comment). rawImpulses
    // below (from detectImpulses(), which only sees the already-collapsed
    // `driver` array) only knows the CLAMPED position; resolving/
    // reconstructing a boundary impulse from that clamped position instead
    // of its true (possibly negative) one reproduces a mistimed, reshaped
    // bump — verified empirically (see deconvolve()'s impulseLog doc
    // comment: true apex at sample 4 reconstructed at sample ~kPeakIdx=12).
    const logByClampedIndex = new Map();
    for (const entry of result.impulseLog) {
      if (!logByClampedIndex.has(entry.clampedIndex)) logByClampedIndex.set(entry.clampedIndex, []);
      logByClampedIndex.get(entry.clampedIndex).push(entry);
    }
    // For the apex-prediction sanity check below, use the single largest
    // contributor's true position when multiple atoms share a clamped slot
    // — a coarse "is there really a rise near here" gate doesn't need every
    // contributor, just the dominant one's true position.
    const dominantTrueIndex = (clampedIndex) => {
      const entries = logByClampedIndex.get(clampedIndex);
      if (!entries || entries.length === 0) return clampedIndex; // shouldn't happen; safe fallback
      let best = entries[0];
      for (const e of entries) if (e.amplitude > best.amplitude) best = e;
      return best.trueIndex;
    };

    // IMPORTANT: imp.index from detectImpulses() is the driver-domain
    // impulse/ONSET position, not the SCR's apex. deconvolve() places each
    // impulse at maxIdx - kPeakIdx precisely so that convolving it with the
    // kernel produces a bump whose OWN peak lands back at maxIdx — i.e. the
    // true apex is offset from imp.index by +kPeakIdx samples (~riseTime
    // seconds later), not the other way round. An earlier version of this
    // method got this backwards (treated imp.index as the apex and
    // subtracted riseTime to get the onset), which visibly misplaced peak
    // markers and — more importantly — fed the wrong (near-baseline, onset)
    // value into the run-consolidation check, making it too easy to satisfy
    // and causing genuinely separate second peaks to be swallowed.
    //
    // Resolve the true apex by searching the *original* phasic signal near
    // the kernel-predicted position, rather than trusting that position
    // exactly — the canonical kernel's shape is only an approximation of any
    // individual real SCR, so the actual local maximum can sit a little
    // earlier or later than kPeakIdx samples after onset.
    // Checked 0.75s against real track 053 data during review, expecting a
    // wider window to catch more true apexes sitting just past a 0.5s edge —
    // it didn't help (6.7% still off vs 6.3%) and slightly hurt agreement
    // with detectPeaks() (88.9% vs 91.1%), because widening also makes it
    // more likely to snap onto a nearby *different* peak's taller value
    // instead of this impulse's own apex. Reverted to 0.5s. The residual
    // ~6% "off" rate on real data — almost all by <0.02µS, a few by more —
    // appears to be inherent real-data noise/kernel-mismatch, not a window-
    // size problem. Note resolveApex() here is only used to gate which raw
    // impulses are real enough to feed the reconstruction (see below) — it
    // no longer determines the final peak positions directly; those come
    // from _detectPeaksFromCurve() scanning the reconstructed curve, which
    // has no notion of "duplicate apex index" to begin with (two impulses
    // landing on the same local max in the summed curve just are one peak).
    const apexSearchHalfWin = Math.max(1, Math.round(0.5 * this.sampleRate));
    const resolveApex = (onsetIdx) => {
      const predicted = Math.min(n - 1, onsetIdx + kPeakIdx);
      // Clamp the search window's lower bound to onsetIdx itself, not just
      // predicted-halfWin: near the end of a recording, `predicted` gets
      // clamped down to n-1, which can pull predicted-halfWin below onsetIdx
      // — without this, the search could return an apex earlier than its own
      // onset, which is physically nonsensical and breaks anything iterating
      // the [onsetIndex, index] range (e.g. renderer.js's shaded-region draw).
      const lo = Math.max(0, onsetIdx, predicted - apexSearchHalfWin);
      const hi = Math.min(n - 1, predicted + apexSearchHalfWin);
      let bestIdx = Math.max(onsetIdx, predicted), bestVal = phasicVals[bestIdx] || 0;
      for (let i = lo; i <= hi; i++) {
        if (phasicVals[i] > bestVal) { bestVal = phasicVals[i]; bestIdx = i; }
      }
      return { apexIdx: bestIdx, apexVal: bestVal };
    };

    // Gate which raw impulses feed the reconstruction: the same amplitude
    // threshold detectPeaks() applies, plus a sanity check that each impulse
    // corresponds to a genuine local rise in the *original* signal at its
    // resolved apex, not just a driver-domain artifact (mitigates "noise
    // detected as SCR", a documented limitation of nonnegative SCR
    // deconvolution). This is deliberately the ONLY filter applied before
    // reconstruction — SNR and quality are judgments about individual
    // reported *events*, not about whether a piece of signal is real, so
    // they're applied once, below, to the peaks actually built from the
    // reconstructed curve — mirroring detectPeaks()'s own filter order
    // (amplitude gates candidacy, SNR/quality filter the resulting peak
    // objects at the end) rather than inventing a separate convention here.
    // resolveApex() is predicted from the TRUE (possibly negative) onset via
    // dominantTrueIndex(), not imp.index's clamped position — otherwise a
    // boundary impulse's predicted apex is off by however far the clamp
    // shifted it (up to kPeakIdx samples), which can push the actual apex
    // outside the ±0.5s search window entirely (see this method's doc
    // comment above for the measured window-size tradeoffs).
    const threshold = params.peakThreshold;
    const minApexVal = scf.minApexVal ?? 0.001;
    const impulses = rawImpulses
      .map(imp => ({ imp, ...resolveApex(dominantTrueIndex(imp.index)) }))
      .filter(({ imp, apexVal }) => imp.amplitude >= threshold && apexVal >= minApexVal);
    this.phasicDriverPeaks = impulses.map(({ imp }) => imp);

    // Reconstruct the clean, superposition-resolved phasic signal from every
    // impulse that passed the gate above, at each atom's TRUE (possibly
    // negative) onset position — reconstructPhasic() treats impulse "index"
    // as the ONSET position (the kernel is convolved starting there), not
    // the apex, and needs the true position to correctly reproduce only the
    // visible tail of a kernel whose modeled onset predates t=0 (see that
    // function's doc comment). Falls back to the clamped position/amplitude
    // if a gated impulse's clamped index has no logged entry (shouldn't
    // happen — every driver-array impulse originates from an impulseLog
    // entry — but degrades safely rather than dropping the impulse).
    const reconstructionImpulses = [];
    for (const { imp } of impulses) {
      const entries = logByClampedIndex.get(imp.index);
      if (entries && entries.length > 0) {
        for (const e of entries) reconstructionImpulses.push({ index: e.trueIndex, amplitude: e.amplitude });
      } else {
        reconstructionImpulses.push({ index: imp.index, amplitude: imp.amplitude });
      }
    }
    const cleanValsRaw = SCRDeconvolution.reconstructPhasic(reconstructionImpulses, n, result.kernel);

    // ═══════════════════════════════════════════════════════════════════════════
    // CRITICAL: the rescaling below must operate on the EXACT SAME impulse set
    // that cleanValsRaw was reconstructed from.  If any filtering, merging, or
    // amplitude adjustment is inserted between reconstructPhasic() here and the
    // rescaling block below, the scale factor will be calibrated against a
    // different signal than the one it's applied to — silently corrupting all
    // downstream amplitudes, phasicAUC, arousalIndex, and CSV exports.
    //
    // The three arrays rescaled below (reconstructionImpulses, phasicDriverPeaks,
    // phasicDriver) are all derived from the SAME gated impulse set (the
    // `impulses` variable above), keeping the per-atom log entries, the summed
    // driver-domain peaks, and the driver display array mutually consistent.
    // ═══════════════════════════════════════════════════════════════════════════

    // Post-hoc amplitude rescaling — corrects the MP overestimation that
    // arises when adjacent kernel copies overlap.  The greedy residual-peak
    // amplitude heuristic (amplitude = maxVal at each MP step) is exact for
    // isolated SCRs (kernel[kPeakIdx] == 1.0) but overestimates energy when
    // the residual has been contaminated by neighbouring atoms' tails.
    // The correction is a global scalar applied uniformly to all accepted
    // impulse amplitudes:
    //
    //   scale = sum(phasicVals) / sum(cleanValsRaw)
    //
    // This is equivalent to asking "what single factor makes the total energy
    // of the reconstructed signal match the total energy of the original
    // phasic?" — exactly what the AUC overestimation is about.  Applying it
    // uniformly to all amplitudes preserves the *relative* amplitude ordering
    // of peaks (and therefore the peak/quality/salience ranking) while
    // bringing the aggregate and per-peak absolute values to the correct scale.
    //
    // A global scalar cannot fix per-peak errors that stem from MP's greedy
    // position selection (a fully joint NNLS optimisation would be needed for
    // that), but it eliminates the systematic aggregate bias measured at
    // +60–68% on real tracks and makes phasicAUC/arousalIndex/CSV amplitude
    // exports physiologically meaningful rather than inflation-inflated.
    //
    // Guard: if cleanValsRaw sums to zero (no impulses passed the gate, e.g.
    // a recording with no detectable SCRs), skip the rescaling to avoid ÷0.
    let rescaleAmplitudes = 1.0;
    {
      let sumClean = 0, sumPhasic = 0;
      for (let i = 0; i < n; i++) { sumClean += cleanValsRaw[i]; sumPhasic += phasicVals[i]; }
      if (sumClean > 0) rescaleAmplitudes = sumPhasic / sumClean;
    }
    // Apply the scale to every impulse so cleanVals, phasicDriver values, and
    // the impulse amplitudes stored on phasicDriverPeaks are all consistent.
    let cleanVals;
    if (Math.abs(rescaleAmplitudes - 1.0) < 1e-9) {
      // No inflation detected (isolated SCRs or empty reconstruction) — skip
      // the second reconstruction pass to save time.
      cleanVals = cleanValsRaw;
    } else {
      for (const imp of reconstructionImpulses) imp.amplitude *= rescaleAmplitudes;
      for (const imp of this.phasicDriverPeaks)  imp.amplitude *= rescaleAmplitudes;
      // Rescale the driver array in-place so phasicDriver display is consistent.
      for (let i = 0; i < n; i++) this.phasicDriver[i].val *= rescaleAmplitudes;
      cleanVals = SCRDeconvolution.reconstructPhasic(reconstructionImpulses, n, result.kernel);
    }
    this.phasicClean = new Array(n);
    for (let i = 0; i < n; i++) {
      this.phasicClean[i] = { time: times[i], val: cleanVals[i] };
    }
    this._phasicOrig = this.phasic;
    this.phasic = this.phasicClean;
    this.phasicZ = GsrFilter.standardizeSignal(this.phasic);
    this.phasicStd = GsrFilter.calculateStats(cleanVals).std;

    // Build the final, displayed peak list by scanning the reconstructed
    // curve for local maxima — see _detectPeaksFromCurve()'s doc comment for
    // why this replaces the previous atom-level "run consolidation" pass.
    this.peaks = this._detectPeaksFromCurve(cleanVals, times, params, oldLabels, oldExcluded);
    this._assignLabelsToPeaks(this.peaks);
  }

  /**
   * Build the final discrete deconvolution-mode peak list by scanning the
   * reconstructed, superposition-resolved phasicClean curve for local
   * maxima — the same simple approach detectPeaks() already uses on the raw
   * signal in non-deconvolution mode — rather than working at the level of
   * individual matching-pursuit atoms and guessing which ones to merge.
   *
   * This replaces a previous "run consolidation" pass that decided whether
   * adjacent atoms belonged to the same event using a pairwise gap+trough
   * test, capped at a gap derived from the kernel's own half-recovery time
   * (~2.2s at defaults). That test was pairwise but chained transitively: a
   * sequence of atoms each individually within the gap cap of its neighbor
   * could span far beyond that cap end-to-end, since nothing bounded the
   * *whole run's* span, only each consecutive step. Confirmed directly on
   * track 059 (a 61-minute recording with several rapid real events, e.g.
   * quick social encounters): one chain of 6 atoms spanning 6.5 seconds
   * collapsed into a single reported peak, discarding atoms individually
   * 2.89µS and 2.91µS — essentially as large as the 4.96µS "survivor" — as
   * if they were the same event. A scan across all three real tracks found
   * this transitive-merge pattern in 15–163 multi-atom runs per track,
   * discarding 22–234 atoms that were each individually ≥50% the amplitude
   * of whatever "survived" alongside them. Widening or shrinking the gap cap
   * (already tried in earlier rounds — 2x halfRecoveryTime barely moved a
   * separate mismatch metric) doesn't fix this class of bug, because the
   * problem isn't the cap's size, it's that chaining lets many individually-
   * legal steps add up to an illegitimate total.
   *
   * Scanning the reconstructed curve directly sidesteps the "how many atoms
   * is too many to merge" question rather than re-tuning it: two atoms close
   * enough that their summed kernels don't produce two distinguishable local
   * maxima genuinely can't be told apart by this model either, and correctly
   * become one peak with no heuristic involved. Atoms far enough apart to
   * show as separate bumps on the reconstructed curve become separate peaks,
   * with no gap cap or chain-length limit needed at all.
   *
   * Unlike detectPeaks(), this does not apply the rise-time / half-recovery /
   * skewness shape bounds. Those sliders stay locked to the kernel-derived
   * canonical values in the UI whenever deconvolution is on (see
   * events.js:updateDeconvolutionUIState) — rise/recovery/skew measured off
   * a *reconstructed* curve reflect the summed shape of however many atoms
   * landed in one peak, not any single canonical SCR shape, so bounding them
   * against the kernel's own canonical values would be checking a peak
   * against a number that peak was never expected to match. Amplitude
   * (peakThreshold), SNR (shapeMinSnr) and composite quality
   * (minPeakQuality) still apply, exactly as they did before.
   *
   * @param {Float64Array} cleanVals - Reconstructed phasic values (>= 0).
   * @param {Array<number>} times - Timestamps parallel to cleanVals.
   * @param {object} params - Analysis parameters (peakThreshold, shapeMinSnr, minPeakQuality).
   * @param {Map} oldLabels - Preserved user labels, keyed by raw index.
   * @param {Set} oldExcluded - Preserved exclusion flags, keyed by raw index.
   * @private
   */
  _detectPeaksFromCurve(cleanVals, times, params, oldLabels, oldExcluded) {
    const n = cleanVals.length;
    const peaks = [];
    if (n < 3) return peaks;

    const defaults = GSR_CONST.PEAK_SHAPE;
    const threshold = params.peakThreshold;
    // Backward onset-search bound only — not a shape filter (those stay
    // locked/inapplicable in decon mode, see doc comment above). Reuses the
    // same default search limit detectPeaks() falls back to when its own
    // slider is off, purely to stop the walk-back at a sane point.
    const maxOnsetSteps = Math.round(defaults.MAX_RISE_TIME * this.sampleRate);
    const noiseHalfWin = Math.max(1, Math.round(this.sampleRate));

    for (let i = 1; i < n - 1; i++) {
      const prev = cleanVals[i - 1], curr = cleanVals[i], next = cleanVals[i + 1];
      if (!(curr > prev && curr >= next)) continue;
      if (curr < 0.001) continue;

      let onsetIdx = i, onsetSteps = 0;
      while (onsetIdx > 0 && cleanVals[onsetIdx] > 0 && onsetSteps < maxOnsetSteps) {
        if (onsetIdx < i && cleanVals[onsetIdx] < cleanVals[onsetIdx - 1]) break;
        onsetIdx--;
        onsetSteps++;
      }

      const amplitude = curr - cleanVals[onsetIdx];
      if (amplitude < threshold) continue;

      const riseTime = times[i] - times[onsetIdx];
      const onsetSlope = riseTime > 0 ? amplitude / riseTime : 0;

      const halfDecayVal = cleanVals[onsetIdx] + amplitude * 0.5;
      let recoveryIdx = -1;
      for (let j = i + 1; j < n; j++) {
        if (cleanVals[j] <= halfDecayVal) { recoveryIdx = j; break; }
        if (j < n - 1 && cleanVals[j] < cleanVals[j + 1] &&
            cleanVals[j] > halfDecayVal + GSR_CONST.PEAK_RECOVERY_BREAK) break;
      }
      const halfRecoveryTime = recoveryIdx !== -1 ? times[recoveryIdx] - times[i] : -1;
      const decaySlope = halfRecoveryTime > 0 ? (cleanVals[i] - cleanVals[recoveryIdx]) / halfRecoveryTime : 0;
      const skewnessRatio = halfRecoveryTime > 0 ? riseTime / halfRecoveryTime : 0;

      let fwhmStart = onsetIdx;
      for (let j = onsetIdx; j <= i; j++) {
        if (cleanVals[j] >= halfDecayVal) { fwhmStart = j; break; }
      }
      const fwhm = recoveryIdx !== -1 ? times[recoveryIdx] - times[fwhmStart] : -1;

      const noiseFloor = this._computeNoiseFloor(onsetIdx, noiseHalfWin);
      const snr = noiseFloor > 0 ? amplitude / noiseFloor : 0;

      const peak = {
        index: i,
        time: times[i],
        value: curr,
        amplitude: amplitude,
        onsetIndex: onsetIdx,
        onsetTime: times[onsetIdx],
        onsetValue: cleanVals[onsetIdx],
        recoveryIndex: recoveryIdx,
        halfRecoveryTime: halfRecoveryTime,
        riseTime: riseTime,
        onsetSlope: onsetSlope,
        decaySlope: decaySlope,
        skewnessRatio: skewnessRatio,
        fwhm: fwhm,
        snr: snr,
        label: oldLabels.get(i) ||
               this.getMatchingLabel(times[i]) ||
               (this._importedPeakLabels ? this._importedPeakLabels.get(times[i]) : '') ||
               '',
        excluded: oldExcluded.has(i)
      };
      // Uses the deconvolution-specific quality formula, not
      // _computePeakQuality() — see _computeDeconPeakQuality()'s doc
      // comment for why the shape-based formula doesn't apply here.
      peak.qualityScore = this._computeDeconPeakQuality(peak);
      peak.salienceScore = this._computeSalienceScore(peak);
      peaks.push(peak);

      // Enforce minimum gap between peaks, same convention as detectPeaks().
      i = Math.min(n - 2, i + Math.round(GSR_CONST.PEAK_MIN_GAP * this.sampleRate));
    }

    // Enforce the same hard SNR cutoff detectPeaks() applies (shape.MIN_SNR,
    // "0 = off"). shapeMinSnr stays live/editable in the UI when
    // deconvolution is on — unlike rise time/half-recovery/skew, SNR isn't a
    // property fixed by the kernel shape, it depends on each peak's local
    // noise floor regardless of detection mode.
    const minSnr = params && params.shapeMinSnr != null ? params.shapeMinSnr : defaults.MIN_SNR;
    let result = minSnr > 0 ? peaks.filter(pk => pk.snr >= minSnr) : peaks;

    // Same "0 = off" convention as detectPeaks() — no hardcoded floor here;
    // a hardcoded minimum would silently override an explicit user choice.
    const minQuality = params.minPeakQuality != null ? params.minPeakQuality : 0.0;
    result = result.filter(pk => pk.qualityScore >= minQuality);

    return result;
  }

  /**
   * Pre-compute global Y-ranges
   */
  _buildDisplayCache() {
    // Global Y-range per curve — used when view covers >40 % of data
    this._globalRange = {};
    for (const key of ['raw', 'filtered', 'tonic', 'phasic', 'peakDensity', 'phasicAUC', 'arousalIndex', 'em_fog']) {
      const arr = this[key];
      if (!arr || arr.length === 0) continue;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i].val;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      this._globalRange[key] = { min: mn, max: mx };
    }

    // Reset per-redraw cache (recomputed once by draw())
    this.rawMinMaxCached = null;

    // Timeline waveform: sub-sample to ~300 points
    this._timelinePoints = [];
    if (this.raw.length > 0) {
      const step = Math.max(1, Math.floor(this.raw.length / 300));
      for (let i = 0; i < this.raw.length; i += step) {
        this._timelinePoints.push(this.raw[i]);
      }
    }

    // Timeline peak positions as fraction of total duration (exclude excluded peaks)
    this._timelinePeakPct = [];
    if (this.peaks.length > 0 && this.raw.length > 0) {
      const totalDur = this.raw[this.raw.length - 1].time - this.raw[0].time;
      if (totalDur > 0) {
        this._timelinePeakPct = this.peaks
          .filter(pk => !pk.excluded)
          .map(pk => pk.time / totalDur);
      }
    }
  }

  /**
   * Compute the local noise floor around an index for SNR estimation.
   * Uses ±1 s window, excludes the peak region.
   */
  _computeNoiseFloor(idx, halfWindow) {
    // Use the filtered signal (median+LPF, pre-decomposition) instead of
    // phasic, so that nearby SCRs don't inflate the noise estimate.
    const vals = this.filtered.map(d => d.val);
    const start = Math.max(0, idx - halfWindow);
    const end = Math.min(vals.length - 1, idx + halfWindow);
    let sum = 0, count = 0;
    for (let j = start; j <= end; j++) {
      sum += vals[j];
      count++;
    }
    const mean = sum / count;
    let sqSum = 0;
    for (let j = start; j <= end; j++) {
      sqSum += (vals[j] - mean) ** 2;
    }
    return Math.sqrt(sqSum / count);
  }

  /**
   * Compute a quality score (0–1) for a detected peak based on
   * how well it matches the canonical SCR shape.
   */
  _computePeakQuality(peak) {
    const W = GSR_CONST.PEAK_SHAPE.QUALITY_WEIGHTS;
    let score = 0;

    // Amplitude: higher is better, saturate at 0.5 µS
    const ampScore = Math.min(1, peak.amplitude / 0.5);
    score += ampScore * W.amplitude;

    // Rise time: ideal is 0.5–3 s, penalize outside that
    if (peak.riseTime >= 0.5 && peak.riseTime <= 3.0) {
      score += W.riseTime;
    } else if (peak.riseTime > 0 && peak.riseTime <= 5.0) {
      score += W.riseTime * 0.5;
    }

    // Recovery time: ideal is 0.5–4 s
    if (peak.halfRecoveryTime >= 0.5 && peak.halfRecoveryTime <= 4.0) {
      score += W.recoveryTime;
    } else if (peak.halfRecoveryTime > 0 && peak.halfRecoveryTime <= 8.0) {
      score += W.recoveryTime * 0.5;
    }

    // Skewness: classic SCR has fast rise, slow recovery (ratio < 1)
    if (peak.skewnessRatio > 0 && peak.skewnessRatio <= 1.0) {
      score += W.skewness;
    } else if (peak.skewnessRatio > 1.0 && peak.skewnessRatio <= 2.0) {
      score += W.skewness * 0.6;
    } else if (peak.skewnessRatio > 2.0 && peak.skewnessRatio <= 4.0) {
      score += W.skewness * 0.3;
    }

    // Onset slope: steep but not too steep (in µS/s)
    if (peak.onsetSlope >= 0.01 && peak.onsetSlope <= 1.0) {
      score += W.onsetSlope;
    } else if (peak.onsetSlope > 0 && peak.onsetSlope <= 3.0) {
      score += W.onsetSlope * 0.5;
    }

    // SNR
    if (peak.snr >= 3.0) {
      score += W.snr;
    } else if (peak.snr >= 2.0) {
      score += W.snr * 0.7;
    } else if (peak.snr >= 1.5) {
      score += W.snr * 0.4;
    }

    // Decay slope: recovery must exist (in µS/s)
    if (peak.decaySlope > 0.001) {
      score += W.decaySlope;
    }

    return Math.min(1, Math.max(0, score));
  }

  /**
   * Quality score (0–1) for a deconvolution-mode peak.
   *
   * NOTE: this is deliberately a *different* formula from _computePeakQuality(),
   * not a shared call with different inputs — reusing the shape-based formula
   * unchanged for deconvolution peaks was tried first and found to be wrong.
   *
   * Under the fixed-kernel SCRF model (Benedek & Kaernbach, 2010 — see the
   * SCRF class comment in constants.js), every deconvolution peak shares the
   * exact same riseTime, halfRecoveryTime, skewnessRatio and fwhm by
   * construction: they're derived once from the kernel, not measured per
   * peak. Verified empirically on track 053: all 205 peaks have exactly one
   * distinct riseTime/halfRecoveryTime/skewnessRatio value between them,
   * vs. 17/30/many distinct values for the same fields in shape-based mode.
   * Likewise onsetSlope (= onsetSlopeUnit × amplitude) and decaySlope
   * (= amplitude × 0.5 / halfRecoveryTime) are pure linear rescalings of
   * amplitude in this mode, since onsetSlopeUnit and halfRecoveryTime are
   * themselves kernel constants — they carry no information beyond amplitude
   * itself here, unlike in shape-based mode where they're independently
   * measured from the noisy raw signal.
   *
   * Feeding _computePeakQuality()'s weights unchanged into that reality gave
   * every peak an automatic ~45% of the total score (riseTime + recoveryTime
   * + skewness weights) regardless of size or genuineness, plus decaySlope's
   * near-zero pass bar (>0.001 µS/s) cleared by almost anything real — around
   * 55% of the composite score effectively free. Measured effect on track
   * 053: quality scores clustered at 0.66–0.98 (median 0.83) vs. shape mode's
   * 0.18–0.91 (median 0.56), and a peak sitting right at the amplitude
   * threshold (0.021 µS) still scored 0.808 — barely below a peak 56x larger
   * (0.950). minPeakQuality was consequently a no-op below ~0.6 in decon mode.
   *
   * This formula instead scores only the two quantities that are genuinely
   * independent per deconvolution peak: amplitude and SNR (local noise floor
   * varies per peak regardless of kernel shape). This also brings the scoring
   * closer to actual literature practice, not further from it — Ledalab's CDA
   * analysis (the standard implementation of this same fixed-kernel approach)
   * filters individual deconvolved SCRs by a minimum reconvolved amplitude
   * threshold alone (commonly 0.01–0.02 µS), not by re-scoring each impulse's
   * morphology, precisely because morphology isn't free to vary once the
   * kernel is fixed. Amplitude/SNR weights are rescaled from the shape-based
   * formula's own W.amplitude/W.snr ratio (not arbitrary new values) so the
   * two modes stay comparably calibrated where they overlap conceptually.
   */
  _computeDeconPeakQuality(peak) {
    const W = GSR_CONST.PEAK_SHAPE.QUALITY_WEIGHTS;
    const totalW = W.amplitude + W.snr;
    const ampWeight = totalW > 0 ? W.amplitude / totalW : 0.5;
    const snrWeight = totalW > 0 ? W.snr / totalW : 0.5;

    // Amplitude: higher is better, saturate at 0.5 µS (same convention as
    // the shape-based formula).
    const ampScore = Math.min(1, peak.amplitude / 0.5);

    // SNR: same graduated breakpoints as the shape-based formula's SNR bucket.
    let snrScore = 0;
    if (peak.snr >= 3.0) snrScore = 1.0;
    else if (peak.snr >= 2.0) snrScore = 0.7;
    else if (peak.snr >= 1.5) snrScore = 0.4;

    const score = ampScore * ampWeight + snrScore * snrWeight;
    return Math.min(1, Math.max(0, score));
  }

  /**
   * "Memorability" / salience score (0–1) for a peak — a genuinely different
   * question from qualityScore. Quality asks "how confident are we this is a
   * real SCR, as opposed to noise"; salience asks "if it is real, how likely
   * is a person to actually notice/remember this moment" — fast, high-
   * amplitude responses read as salient regardless of how textbook-shaped
   * their recovery curve is.
   *
   * This exists as a separate metric rather than folding "memorable" into
   * the existing peak list, because they answer separate questions that
   * don't share one correct granularity. The discrete peak count (this.peaks)
   * is trying to be an honest census of distinct SCR events — how many
   * separate things happened — a question the earlier chain-merge
   * consolidation bug (see _detectPeaksFromCurve()'s doc comment) actively
   * hurt. Phasic AUC (computePhasicAUC) is a continuous, 30s-windowed
   * measure of total phasic activation, already fairly robust to exactly how
   * many discrete atoms happened to compose a burst, since it integrates the
   * reconstructed signal directly rather than iterating peaks. Salience adds
   * a third view: one score per already-correctly-separated peak, so the
   * standout moments can be picked out from the full census without
   * confusing "how many events happened" with "which ones were memorable."
   *
   * Blends Amplitude (50%), Steepest Rise / Onset Slope (30%), and Local Contrast / SNR (20%).
   * - Amplitude measures total response magnitude (saturating at 0.5 µS).
   * - Onset slope (amplitude / riseTime) measures response suddenness (saturating at 0.5 µS/s).
   * - SNR (contrast against local background noise) suppresses duplicate follow-up peaks in a cluster (saturating at SNR = 3.0).
   */
  _computeSalienceScore(peak) {
    const ampScore = Math.min(1, Math.max(0, peak.amplitude / 0.5));
    const slope = peak.onsetSlope != null ? peak.onsetSlope : (peak.riseTime > 0 ? peak.amplitude / peak.riseTime : 0);
    const slopeScore = Math.min(1, Math.max(0, slope / 0.5));
    const snrScore = peak.snr != null ? Math.min(1, Math.max(0, peak.snr / 3.0)) : 0.5;
    return Math.min(1, Math.max(0, ampScore * 0.50 + slopeScore * 0.30 + snrScore * 0.20));
  }

  /**
   * Resolve the raw-sample index a hotspot's position should be evaluated
   * at, applying the same GPS-latency shift the map actually renders
   * markers with (see GSRMapManager._resolveLatencyIndex() in map.js).
   */
  _resolveHotspotIndex(peak, peakLatency) {
    if (!(peakLatency > 0)) return peak.index;
    const shiftedTime = Math.max(0, peak.time - peakLatency);
    const si = this.findClosestIndex(shiftedTime);
    return si >= 0 ? si : peak.index;
  }

  detectPeaks(threshold, params) {
    // Preserve any user-set labels and exclusion state across re-analysis by matching on raw index
    const oldLabels = new Map();
    const oldExcluded = new Set();
    for (const pk of this.peaks) {
      if (pk.label && pk.label.trim()) {
        this.setPeakLabel(pk.time, pk.label);
        oldLabels.set(pk.index, pk.label);
      }
      if (pk.excluded) oldExcluded.add(pk.index);
    }
    // Also merge labels and exclusion imported from re-loaded processed CSV (matched by time)
    if (this._importedPeakLabels && this._importedPeakLabels.size > 0) {
      for (const pk of this.peaks) {
        if (!pk.label || !pk.label.trim()) {
          const imported = this._importedPeakLabels.get(pk.time);
          if (imported) oldLabels.set(pk.index, imported);
        }
        if (!pk.excluded) {
          const importedEx = this._importedPeakExcluded && this._importedPeakExcluded.get(pk.time);
          if (importedEx) oldExcluded.add(pk.index);
        }
      }
    }
    this.peaks = [];
    const n = this.phasic.length;
    if (n < 3) return;

    const phasicVals = this.phasic.map(d => d.val);
    const times = this.phasic.map(d => d.time);
    const defaults = GSR_CONST.PEAK_SHAPE;

    // Use dynamic slider values when available, fall back to defaults
    const shape = {
      MIN_RISE_TIME:     params && params.shapeMinRiseTime     != null ? params.shapeMinRiseTime     : defaults.MIN_RISE_TIME,
      MAX_RISE_TIME:     params && params.shapeMaxRiseTime     != null ? params.shapeMaxRiseTime     : defaults.MAX_RISE_TIME,
      MIN_HALF_RECOVERY: params && params.shapeMinHalfRecovery != null ? params.shapeMinHalfRecovery : defaults.MIN_HALF_RECOVERY,
      MAX_HALF_RECOVERY: params && params.shapeMaxHalfRecovery != null ? params.shapeMaxHalfRecovery : defaults.MAX_HALF_RECOVERY,
      MIN_ONSET_SLOPE:   defaults.MIN_ONSET_SLOPE,
      MAX_ONSET_SLOPE:   defaults.MAX_ONSET_SLOPE,
      MIN_DECAY_SLOPE:   defaults.MIN_DECAY_SLOPE,
      MAX_PEAK_WIDTH:    defaults.MAX_PEAK_WIDTH,
      MIN_SNR:           params && params.shapeMinSnr          != null ? params.shapeMinSnr          : defaults.MIN_SNR,
      SKEWNESS_RATIO_MIN: defaults.SKEWNESS_RATIO_MIN,
      SKEWNESS_RATIO_MAX: params && params.shapeMaxSkewRatio   != null ? params.shapeMaxSkewRatio   : defaults.SKEWNESS_RATIO_MAX,
      QUALITY_WEIGHTS:   defaults.QUALITY_WEIGHTS
    };

    for (let i = 1; i < n - 1; i++) {
      const prev = phasicVals[i - 1];
      const curr = phasicVals[i];
      const next = phasicVals[i + 1];

      // ── 1. Local maximum check ──────────────────────────────────────────
      if (!(curr > prev && curr >= next)) continue;
      if (curr < 0.001) continue; // Noise floor check to skip flat/zero regions

      // ── 2. Find onset (trough before peak) ──────────────────────────────
      // Limit backward search to MAX_RISE_TIME seconds to prevent walking
      // backward through overlapping SCRs into an unrelated trough.
      // If the slider is set to 0 (off), fallback to standard default limit (5.0s).
      const maxRiseLimit = shape.MAX_RISE_TIME > 0 ? shape.MAX_RISE_TIME : defaults.MAX_RISE_TIME;
      const maxOnsetSteps = Math.round(maxRiseLimit * this.sampleRate);
      let onsetIdx = i;
      let onsetSteps = 0;
      while (onsetIdx > 0 && phasicVals[onsetIdx] > 0 && onsetSteps < maxOnsetSteps) {
        if (onsetIdx < i && phasicVals[onsetIdx] < phasicVals[onsetIdx - 1]) {
          break;
        }
        onsetIdx--;
        onsetSteps++;
      }

      const amplitude = curr - phasicVals[onsetIdx];
      // Under literature standards, threshold is strictly applied to response amplitude
      if (amplitude < threshold) continue;

      // ── 3. Rise time (onset → peak duration) ────────────────────────────
      const riseTime = times[i] - times[onsetIdx];

      const onsetSlope = riseTime > 0 ? amplitude / riseTime : 0;

      // Rise time bounds (skip check when slider is 0 / off)
      if (shape.MIN_RISE_TIME > 0 && riseTime < shape.MIN_RISE_TIME) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (shape.MAX_RISE_TIME > 0 && riseTime > shape.MAX_RISE_TIME) {
        i = Math.min(n - 2, i + 1);
        continue;
      }
      if (onsetSlope < shape.MIN_ONSET_SLOPE || onsetSlope > shape.MAX_ONSET_SLOPE) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 5. Half-recovery search ─────────────────────────────────────────
      const halfDecayVal = phasicVals[onsetIdx] + amplitude * 0.5;
      let recoveryIdx = -1;
      for (let j = i + 1; j < n; j++) {
        if (phasicVals[j] <= halfDecayVal) {
          recoveryIdx = j;
          break;
        }
        if (j < n - 1 &&
            phasicVals[j] < phasicVals[j + 1] &&
            phasicVals[j] > halfDecayVal + GSR_CONST.PEAK_RECOVERY_BREAK) {
          break;
        }
      }

      let halfRecoveryTime = -1;
      if (recoveryIdx !== -1) {
        halfRecoveryTime = times[recoveryIdx] - times[i];
      }

      // ── 6. Decay / recovery metrics ─────────────────────────────────────
      const decaySlope = halfRecoveryTime > 0
        ? (phasicVals[i] - phasicVals[recoveryIdx]) / halfRecoveryTime
        : 0;

      // Genuine SCRs have fast rise, slow recovery → ratio < 1
      const skewnessRatio = halfRecoveryTime > 0
        ? riseTime / halfRecoveryTime
        : 0;

      // Shape checks that require a valid half-recovery (skip if none found,
      // e.g. for overlapping peaks or peaks near the end of the recording)
      if (halfRecoveryTime >= 0) {
        if (shape.MIN_HALF_RECOVERY > 0 && halfRecoveryTime < shape.MIN_HALF_RECOVERY) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (shape.MAX_HALF_RECOVERY > 0 && halfRecoveryTime > shape.MAX_HALF_RECOVERY) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (decaySlope < shape.MIN_DECAY_SLOPE) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (skewnessRatio < shape.SKEWNESS_RATIO_MIN) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
        if (shape.SKEWNESS_RATIO_MAX > 0 && skewnessRatio > shape.SKEWNESS_RATIO_MAX) {
          i = Math.min(n - 2, i + 1);
          continue;
        }
      }

      // ── 8. Full width at half maximum (FWHM) ───────────────────────────
      // Find start of half-max on rising edge
      let fwhmStart = onsetIdx;
      for (let j = onsetIdx; j <= i; j++) {
        if (phasicVals[j] >= halfDecayVal) {
          fwhmStart = j;
          break;
        }
      }
      const fwhm = recoveryIdx !== -1
        ? times[recoveryIdx] - times[fwhmStart]
        : -1;

      if (fwhm > 0 && fwhm > shape.MAX_PEAK_WIDTH) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 9. Signal-to-noise ratio ───────────────────────────────────────
      const noiseHalfWin = Math.max(1, Math.round(this.sampleRate)); // ±1 s
      const noiseFloor = this._computeNoiseFloor(onsetIdx, noiseHalfWin);
      const snr = noiseFloor > 0 ? amplitude / noiseFloor : 0;

      if (shape.MIN_SNR > 0 && snr < shape.MIN_SNR) {
        i = Math.min(n - 2, i + 1);
        continue;
      }

      // ── 10. Build peak object with full shape metrics ──────────────────
      const peak = {
        index: i,
        time: times[i],
        value: curr,
        amplitude: amplitude,
        onsetIndex: onsetIdx,
        onsetTime: times[onsetIdx],
        onsetValue: phasicVals[onsetIdx],
        recoveryIndex: recoveryIdx,
        halfRecoveryTime: halfRecoveryTime,
        // New shape metrics
        riseTime: riseTime,
        onsetSlope: onsetSlope,
        decaySlope: decaySlope,
        skewnessRatio: skewnessRatio,
        fwhm: fwhm,
        snr: snr,
        label: oldLabels.get(i) ||
               this.getMatchingLabel(times[i]) ||
               (this._importedPeakLabels ? this._importedPeakLabels.get(times[i]) : '') ||
               '',
        excluded: oldExcluded.has(i) ||
                  (this._importedPeakExcluded ? this._importedPeakExcluded.has(times[i]) : false)
      };

      // ── 11. Compute composite quality score ────────────────────────────
      peak.qualityScore = this._computePeakQuality(peak);
      peak.salienceScore = this._computeSalienceScore(peak);

      const minQuality = params && params.minPeakQuality != null ? params.minPeakQuality : 0.0;
      if (peak.qualityScore >= minQuality) {
        this.peaks.push(peak);
      }

      // Skip ahead to enforce minimum gap between peaks
      i = Math.min(n - 2, i + Math.round(GSR_CONST.PEAK_MIN_GAP * this.sampleRate));
    }
    this._assignLabelsToPeaks(this.peaks);
  }

  /**
   * Sliding-window temporal peak density (Non-Specific SCR Frequency), in
   * peaks/minute, using a *centered* window (±windowSizeSec/2) — same
   * convention as computePhasicAUC, so the two continuous metrics stay
   * time-aligned with each other.
   *
   * Classic EDA literature (Dawson, Schell & Filion, 2007; Boucsein, 2012)
   * reports NS-SCR frequency as a single scalar over a fixed epoch (e.g. one
   * number for a whole baseline/task period), not as a continuous series.
   * The continuous sliding-window delivery here is an adaptation for spatial
   * mapping — it IS an established convention in ambulatory/wearable EDA
   * feature extraction specifically (60 s windows are documented in that
   * literature), just not how classic lab-based EDA studies report the
   * metric. peakFrequency in getStats() is the single-scalar, textbook form;
   * this is the continuous, per-sample companion built for plotting/mapping.
   *
   * Two-pointer sliding window over the (time-sorted) active peak list, so
   * this runs in O(n + peakCount) rather than the O(n × peakCount) naive scan.
   *
   * @param {number} windowSizeSec - Temporal window width in seconds (default: 60)
   */
  computeTemporalPeakDensity(windowSizeSec = 60) {
    const n = this.phasic.length;
    if (n === 0) return [];

    const density = new Array(n);
    const halfWin = windowSizeSec / 2;

    const activePeakTimes = this.peaks
      .filter(p => !p.excluded)
      .map(p => p.time);
    const m = activePeakTimes.length;

    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      const t = this.phasic[i].time;
      const tStart = t - halfWin;
      const tEnd = t + halfWin;

      while (lo < m && activePeakTimes[lo] < tStart) lo++;
      while (hi < m && activePeakTimes[hi] <= tEnd) hi++;

      density[i] = {
        time: t,
        val: (hi - lo) * (60 / windowSizeSec)
      };
    }
    return density;
  }

  /**
   * Sliding-window Phasic Area Under the Curve, in µS·s — an ISCR-*inspired*
   * continuous metric, not a reproduction of Benedek & Kaernbach's (2010)
   * published Integrated Skin Conductance Response. Their ISCR integrates a
   * deconvolved "phasic driver" signal (nonnegative deconvolution against a
   * canonical bi-exponential SCR kernel), which is what properly separates
   * overlapping/superposed SCRs. This integrates the simpler tonic-subtracted
   * phasic signal produced by analyze() instead — no deconvolution — so it
   * meaningfully softens (but doesn't fully solve, the way true deconvolution
   * would) the "superposition problem" and the amplitude-threshold cliff-edge
   * described in docs/environmental_stress_literature_review.md §5B/§5D.
   *
   * Uses a *centered* window (±windowSizeSec/2), matching
   * computeTemporalPeakDensity's convention, so the two continuous metrics
   * stay time-aligned with each other — a single spike is smeared
   * symmetrically around its own timestamp in both series rather than
   * appearing to "start" at the spike in one and being centered on it in
   * the other.
   *
   * @param {number} windowSizeSec - Temporal window width in seconds (default: 30)
   */
  computePhasicAUC(windowSizeSec = 30) {
    const n = this.phasic.length;
    if (n === 0) return [];

    const auc = new Array(n);
    const halfWin = windowSizeSec / 2;

    let lo = 0, hi = 0;
    let runningSum = 0;

    for (let i = 0; i < n; i++) {
      const t = this.phasic[i].time;
      const tStart = t - halfWin;
      const tEnd = t + halfWin;

      // Advance the trailing edge to include samples entering the window.
      // this.phasic is already clamped to ≥0 during decomposition (see
      // analyze()), but re-clamp defensively in case this is called against
      // externally-supplied phasic data.
      while (hi < n && this.phasic[hi].time <= tEnd) {
        runningSum += Math.max(0, this.phasic[hi].val);
        hi++;
      }
      // Advance the leading edge to drop samples that have fallen out of the window.
      while (lo < n && this.phasic[lo].time < tStart) {
        runningSum -= Math.max(0, this.phasic[lo].val);
        lo++;
      }

      auc[i] = {
        time: t,
        val: runningSum / this.sampleRate // Convert running sum to a time-integral (µS·s)
      };
    }
    return auc;
  }

  /**
   * Combined Arousal Index — a weighted, per-participant z-scored blend of
   * tonic baseline (SCL) and phasic AUC. Phasic is weighted higher by
   * default to prioritize immediate environmental triggers over baseline
   * physiological tone (exertion, thermal load) — a direction consistent
   * with the general practice in spatial wearability studies (e.g. Shoval
   * et al. 2018; Zhang et al. 2022) of treating phasic reactivity as the
   * primary signal and tonic as a secondary baseline term.
   *
   * IMPORTANT: the specific 0.3/0.7 split is this project's own default, not
   * a value taken from those papers — a search of their published methods
   * did not turn up a specific numeric weighting to cite, and
   * docs/environmental_stress_literature_review.md §5C itself frames the
   * split as illustrative ("e.g."). Treat these defaults as a tunable
   * starting point, not an empirically-validated constant; if this matters
   * for your use case, consider validating a weighting against ground-truth
   * data (e.g. self-reported arousal) rather than assuming these values.
   *
   * @param {number} wTonic - Weight for tonic SCL component (default: 0.3)
   * @param {number} wPhasic - Weight for phasic AUC component (default: 0.7)
   */
  computeCombinedArousalIndex(wTonic = 0.3, wPhasic = 0.7) {
    const n = this.phasic.length;
    if (n === 0) return [];

    const auc = this.computePhasicAUC(30);
    const tonicVals = this.tonic.map(d => d.val);
    const aucVals = auc.map(d => d.val);

    const tonicStats = GsrFilter.calculateStats(tonicVals);
    const aucStats = GsrFilter.calculateStats(aucVals);

    const arousalIndex = new Array(n);
    for (let i = 0; i < n; i++) {
      const tZ = (this.tonic[i].val - tonicStats.mean) / tonicStats.std;
      const aZ = (aucVals[i] - aucStats.mean) / aucStats.std;

      arousalIndex[i] = {
        time: this.phasic[i].time,
        val: (wTonic * tZ) + (wPhasic * aZ)
      };
    }
    return arousalIndex;
  }

  getStats() {
    if (this.raw.length === 0) {
      return {
        duration: 0,
        meanSCL: 0,
        peakCount: 0,
        peakFrequency: 0,
        meanPeakAmplitude: 0,
        meanPhasicAUC: 0
      };
    }

    const duration = this.raw[this.raw.length - 1].time - this.raw[0].time;
    const sumTonic = this.tonic.reduce((sum, d) => sum + d.val, 0);
    const meanSCL = sumTonic / this.tonic.length;

    const durationMinutes = duration / 60.0;
    const activePeaks = this.peaks.filter(p => !p.excluded);
    const peakCount = activePeaks.length;
    const peakFrequency = durationMinutes > 0 ? (peakCount / durationMinutes) : 0;

    const sumAmp = activePeaks.reduce((sum, p) => sum + p.amplitude, 0);
    const meanPeakAmplitude = peakCount > 0 ? (sumAmp / peakCount) : 0;

    // Mean of the sliding-window Phasic AUC series — a threshold-independent
    // companion to peakFrequency/meanPeakAmplitude (µS·s, 30s window).
    const meanPhasicAUC = this.phasicAUC.length > 0
      ? this.phasicAUC.reduce((sum, d) => sum + d.val, 0) / this.phasicAUC.length
      : 0;

    return {
      duration: duration,
      meanSCL: meanSCL,
      peakCount: peakCount,
      peakFrequency: peakFrequency,
      meanPeakAmplitude: meanPeakAmplitude,
      meanPhasicAUC: meanPhasicAUC
    };
  }

  exportToCSV(params, gpsParams) {
    if (this.raw.length === 0) return "";

    // Guard: if analysis hasn't been run, filtered/tonic/phasic are empty
    if (this.filtered.length === 0 || this.tonic.length === 0 || this.phasic.length === 0) {
      return "";
    }

    const hasFilteredGps = this.filteredGps && this.filteredGps.length === this.raw.length;
    const isEnriched = this.isEnriched;
    // GPS quality fields (hdop/pdop/hacc_m/fix_type/sats/speed_kts/course_deg) feed the
    // Kalman noise model and the maxHdop/maxSpeed/minFixType gates (gps_filter.js,
    // gps_pipeline.js). Without them a reloaded processed CSV can't be meaningfully
    // reprocessed with different GPS slider values, so preserve them when present.
    const hasGpsQuality = this.raw.some(d =>
      (!isNaN(d.hdop) || !isNaN(d.pdop) || !isNaN(d.hacc) || !isNaN(d.speedKts) || !isNaN(d.course) ||
       d.fixType || d.sats)
    );

    // Preserve recording start time and configurations for re-import
    let csv = `# RecordingStartTime:${this.recordingStartTime}\n`;
    if (params) {
      csv += `# FilterParams:${JSON.stringify(params)}\n`;
    }
    if (gpsParams) {
      csv += `# GpsFilterParams:${JSON.stringify(gpsParams)}\n`;
    }
    if (isEnriched) {
      csv += `# EnrichmentRadius:${this.enrichmentRadius}\n`;
    }
    csv += "Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude,PeakLabel,PeakExcluded,Latitude,Longitude";
    if (hasFilteredGps) {
      // Named "Pre-Kalman", not "Raw" — a header containing "raw" collides with
      // GSR_KEYWORDS ('raw' is a GSR-column keyword, checked before lat/lon
      // detection in parseCSV), which silently swallows the column into the
      // gsr_raw branch and makes it unrecoverable on reimport. See gps_pipeline.js
      // applyPreKalmanFilters for what "pre-Kalman" means here.
      csv += ",Pre-Kalman Latitude,Pre-Kalman Longitude";
    }
    if (hasGpsQuality) {
      csv += ",hdop,pdop,hacc_m,fix_type,sats,speed_kts,course_deg,is_gps_fix";
    }
    if (isEnriched) {
      csv += ",osm_road_class,osm_dist_major_road,osm_in_park,osm_green_pct_50m,osm_building_density_50m,osm_dist_water,osm_tree_density_50m,osm_amenity_count_50m";
    }
    csv += "\n";

    // Build O(1) peak lookup map (avoid O(n²) .find() inside the loop)
    const peakByIndex = new Map();
    for (let pi = 0; pi < this.peaks.length; pi++) {
      peakByIndex.set(this.peaks[pi].index, this.peaks[pi]);
    }

    for (let i = 0; i < this.raw.length; i++) {
      let isPeak = 0;
      let peakAmp = "";
      let peakLabel = "";
      let peakExcluded = "";
      
      const peak = peakByIndex.get(i);
      if (peak) {
        isPeak = 1;
        peakAmp = peak.amplitude.toFixed(4);
        peakLabel = peak.label || "";
        peakExcluded = peak.excluded ? "1" : "0";
      }

      let latVal = this.raw[i].lat;
      let lonVal = this.raw[i].lon;
      let rawLatVal = NaN;
      let rawLonVal = NaN;

      if (hasFilteredGps) {
        rawLatVal = latVal;
        rawLonVal = lonVal;
        latVal = this.filteredGps[i].lat;
        lonVal = this.filteredGps[i].lon;
      }

      const latStr = (latVal !== null && latVal !== undefined && !isNaN(latVal)) ? latVal.toFixed(6) : "";
      const lonStr = (lonVal !== null && lonVal !== undefined && !isNaN(lonVal)) ? lonVal.toFixed(6) : "";
      const rawLatStr = (rawLatVal !== null && rawLatVal !== undefined && !isNaN(rawLatVal)) ? rawLatVal.toFixed(6) : "";
      const rawLonStr = (rawLonVal !== null && rawLonVal !== undefined && !isNaN(rawLonVal)) ? rawLonVal.toFixed(6) : "";

      csv += `${this.raw[i].time.toFixed(3)},` +
             `${this.raw[i].val.toFixed(4)},` +
             `${this.filtered[i].val.toFixed(4)},` +
             `${this.tonic[i].val.toFixed(4)},` +
             `${this.phasic[i].val.toFixed(4)},` +
             `${isPeak},` +
             `${peakAmp},` +
             `${this._csvEscape(peakLabel)},` +
             `${peakExcluded},` +
             `${latStr},` +
             `${lonStr}`;

      if (hasFilteredGps) {
        csv += `,${rawLatStr},${rawLonStr}`;
      }

      if (hasGpsQuality) {
        const r = this.raw[i];
        // Only genuine fix rows carry real quality metadata — interpolated rows
        // are step-held in memory (see the interpolation pass in parseCSV) but
        // exporting that fabricated data would make every reimported row look
        // like an independent anchor, collapsing map.js's anchor-only Kalman
        // input back down to the dense interpolated grid. Leaving them blank
        // mirrors how the original device CSV itself encodes "no fix this tick".
        const isFix = !!r._isGpsFix;
        const hdopStr     = (isFix && !isNaN(r.hdop))     ? r.hdop.toFixed(2)     : "";
        const pdopStr     = (isFix && !isNaN(r.pdop))     ? r.pdop.toFixed(2)     : "";
        const haccStr     = (isFix && !isNaN(r.hacc))     ? r.hacc.toFixed(2)     : "";
        const speedKtsStr = (isFix && !isNaN(r.speedKts)) ? r.speedKts.toFixed(2) : "";
        const courseStr   = (isFix && !isNaN(r.course))   ? r.course.toFixed(1)   : "";
        const fixTypeStr  = isFix ? (r.fixType || 0) : "";
        const satsStr     = isFix ? (r.sats || 0) : "";
        csv += `,${hdopStr},${pdopStr},${haccStr},${fixTypeStr},${satsStr},${speedKtsStr},${courseStr},${isFix ? 1 : 0}`;
      }

      if (isEnriched) {
        const roadClassStr = this.raw[i].osm_road_class ? this._csvEscape(this.raw[i].osm_road_class) : "";
        const distMajorStr = (this.raw[i].osm_dist_major_road !== null && !isNaN(this.raw[i].osm_dist_major_road)) ? this.raw[i].osm_dist_major_road.toFixed(2) : "";
        const inParkStr = (this.raw[i].osm_in_park !== null && !isNaN(this.raw[i].osm_in_park)) ? this.raw[i].osm_in_park.toString() : "";
        const greenPctStr = (this.raw[i].osm_green_pct_50m !== null && !isNaN(this.raw[i].osm_green_pct_50m)) ? this.raw[i].osm_green_pct_50m.toFixed(1) : "";
        const bldDensityStr = (this.raw[i].osm_building_density_50m !== null && !isNaN(this.raw[i].osm_building_density_50m)) ? this.raw[i].osm_building_density_50m.toFixed(1) : "";
        const distWaterStr = (this.raw[i].osm_dist_water !== null && !isNaN(this.raw[i].osm_dist_water)) ? this.raw[i].osm_dist_water.toFixed(2) : "";
        const treeDensStr = (this.raw[i].osm_tree_density_50m !== null && !isNaN(this.raw[i].osm_tree_density_50m)) ? this.raw[i].osm_tree_density_50m.toFixed(1) : "";
        const amCountStr = (this.raw[i].osm_amenity_count_50m !== null && !isNaN(this.raw[i].osm_amenity_count_50m)) ? this.raw[i].osm_amenity_count_50m.toFixed(1) : "";

        csv += `,${roadClassStr},${distMajorStr},${inParkStr},${greenPctStr},${bldDensityStr},${distWaterStr},${treeDensStr},${amCountStr}`;
      }
      csv += "\n";
    }
    return csv;
  }

  /**
   * Calculate EM Fog Index (0-100) from RSSI readings across Sub-GHz bands.
   */
  static calcEmFog(row) {
    const BANDS = ['rssi_300', 'rssi_315', 'rssi_434', 'rssi_446', 'rssi_815', 'rssi_868', 'rssi_915'];
    let sumPsq = 0, cnt = 0;
    for (let i = 0; i < BANDS.length; i++) {
      const v = row[BANDS[i]];
      if (typeof v === 'number' && !isNaN(v)) {
        const norm = Math.min(1.0, Math.max(0.0, (v + 100.0) / 70.0));
        sumPsq += norm * norm;
        cnt++;
      }
    }
    return cnt > 0 ? Math.sqrt(sumPsq / cnt) * 100.0 : NaN;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRAnalyzer };
} else {
  window.GSRAnalyzer = GSRAnalyzer;
}


