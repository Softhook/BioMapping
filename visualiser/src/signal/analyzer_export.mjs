// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * CSV export — extracted from analyzer.js. Pure: the analyzer's series
 * state is passed in as a plain `state` object rather than read off `this`.
 * GSRAnalyzer keeps a thin instance wrapper (`exportToCSV`) that builds
 * `state` from `this.*` and delegates here.
 */
import { GSRCSVParser } from './csv_parser.mjs';
import { SUB_GHZ_BANDS } from './em_fog.mjs';

export const AnalyzerExport = {
  /**
   * @param {object} state
   * @param {Array<object>} state.raw
   * @param {Array<{val:number}>} state.filtered
   * @param {Array<{val:number}>} state.tonic
   * @param {Array<{val:number}>} state.phasic
   * @param {Array<object>} state.peaks
   * @param {Array<{lat:number,lon:number}>|null} state.filteredGps
   * @param {boolean} state.isEnriched
   * @param {number} state.recordingStartTime
   * @param {Array<string>} [state.deviceHeaderLines] - Device metadata lines from the source file.
   * @param {number} [state.responseDelay] - Response delay (s) the walk was shown at.
   * @param {object} [params] - Filter params, echoed into a header comment for re-import.
   * @param {object} [gpsParams] - GPS filter params, echoed into a header comment for re-import.
   * @returns {string}
   */
  toCSV(state, params, gpsParams) {
    const {
      raw,
      filtered,
      tonic,
      phasic,
      peaks,
      hiddenLabels = [],
      hiddenExclusions = [],
      filteredGps,
      isEnriched,
      recordingStartTime,
      deviceHeaderLines = [],
      responseDelay = 0,
    } = state;

    if (raw.length === 0) return '';

    // Guard: if analysis hasn't been run, filtered/tonic/phasic are empty
    if (filtered.length === 0 || tonic.length === 0 || phasic.length === 0) {
      return '';
    }

    const hasFilteredGps = filteredGps && filteredGps.length === raw.length;
    // GPS quality fields (hdop/pdop/hacc_m/fix_type/sats/speed_kts/course_deg) feed the
    // Kalman noise model and the maxHdop/maxSpeed/minFixType gates (gps_cv_kalman.mjs,
    // gps_pipeline.mjs). Without them a reloaded processed CSV can't be meaningfully
    // reprocessed with different GPS slider values, so preserve them when present.
    const hasGpsQuality = raw.some(
      (d) =>
        !isNaN(d.hdop) ||
        !isNaN(d.pdop) ||
        !isNaN(d.hacc) ||
        !isNaN(d.speedKts) ||
        !isNaN(d.course) ||
        d.fixType ||
        d.sats,
    );

    const activeBands = SUB_GHZ_BANDS.filter((b) =>
      raw.some((d) => !isNaN(d[b.prop])),
    );
    const hasEmFog = raw.some((d) => !isNaN(d.em_fog));
    const hasRf = activeBands.length > 0 || hasEmFog;
    const hasNdvi = raw.some(
      (d) =>
        (typeof d.ndvi === 'number' && !isNaN(d.ndvi)) ||
        (typeof d.ndvi_50m === 'number' && !isNaN(d.ndvi_50m)),
    );

    // Preserve recording start time and configurations for re-import
    let csv = `# RecordingStartTime:${recordingStartTime}\n`;
    // Device metadata (calibration, band floors, device/chip IDs) carried over
    // verbatim. The integrity bracket is not: this file is no longer the
    // unmodified recording it vouched for.
    for (const line of deviceHeaderLines) csv += `${line}\n`;
    if (params) {
      csv += `# FilterParams:${JSON.stringify(params)}\n`;
    }
    if (gpsParams) {
      csv += `# GpsFilterParams:${JSON.stringify(gpsParams)}\n`;
    }
    // For the record only: the rows below are never shifted (times are when
    // each reading was taken, positions where it was taken), so a reload
    // applies the project's own delay once, not twice.
    csv += `# ResponseDelay:${responseDelay}\n`;
    csv +=
      'Time (s),Raw Conductance (uS),Filtered Conductance (uS),Tonic Baseline (uS),Phasic Response (uS),IsPeak,PeakAmplitude,PeakLabel,PeakExcluded,Latitude,Longitude';
    if (hasFilteredGps) {
      // Named "Pre-Kalman", not "Raw" — a header containing "raw" collides with
      // GSR_KEYWORDS ('raw' is a GSR-column keyword, checked before lat/lon
      // detection in parseCSV), which silently swallows the column into the
      // gsr_raw branch and makes it unrecoverable on reimport. The columns
      // hold the raw fix coordinates, before the Kalman filter.
      csv += ',Pre-Kalman Latitude,Pre-Kalman Longitude';
    }
    if (hasGpsQuality) {
      csv += ',hdop,pdop,hacc_m,fix_type,sats,speed_kts,course_deg,is_gps_fix';
    }
    if (hasRf) {
      for (const b of activeBands) csv += `,${b.prop}`;
      if (hasEmFog) csv += ',em_fog';
    }
    // Environment columns (see GSRCSVParser.OSM_COLUMNS / NDVI_COLUMNS).
    const envCols = [
      ...(isEnriched ? GSRCSVParser.OSM_COLUMNS : []),
      ...(hasNdvi ? GSRCSVParser.NDVI_COLUMNS : []),
    ];
    for (const c of envCols) csv += `,${c.field}`;
    csv += '\n';
    const envCell = (c, v) => {
      if (c.kind === 'categorical') return v ? GSRCSVParser._csvEscape(v) : '';
      if (v === null || isNaN(v)) return '';
      return c.kind === 'binary' ? v.toString() : v.toFixed(c.digits);
    };

    // Build O(1) peak lookup map (avoid O(n²) .find() inside the loop)
    const peakByIndex = new Map();
    for (let pi = 0; pi < peaks.length; pi++) {
      peakByIndex.set(peaks[pi].index, peaks[pi]);
    }

    // Labels and exclusions whose peak isn't detected under the current
    // settings go on the nearest row free for them (IsPeak 0) so saving keeps
    // them; re-import reads PeakLabel / PeakExcluded on any row.
    const nearestFreeRow = (time, taken) => {
      let lo = 0;
      let hi = raw.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (raw[mid].time < time) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && time - raw[lo - 1].time < raw[lo].time - time) lo--;
      for (let d = 0; d < raw.length; d++) {
        if (lo + d < raw.length && !taken(lo + d)) return lo + d;
        if (lo - d >= 0 && !taken(lo - d)) return lo - d;
      }
      return -1;
    };
    const hiddenLabelByRow = new Map();
    for (const { time, label } of hiddenLabels) {
      const row = nearestFreeRow(
        time,
        (i) => hiddenLabelByRow.has(i) || !!peakByIndex.get(i)?.label?.trim(),
      );
      if (row !== -1) hiddenLabelByRow.set(row, label);
    }
    const hiddenExcludedRows = new Set();
    for (const { time } of hiddenExclusions) {
      const row = nearestFreeRow(
        time,
        (i) => hiddenExcludedRows.has(i) || peakByIndex.has(i),
      );
      if (row !== -1) hiddenExcludedRows.add(row);
    }

    for (let i = 0; i < raw.length; i++) {
      let isPeak = 0;
      let peakAmp = '';
      let peakLabel = '';
      let peakExcluded = '';

      const peak = peakByIndex.get(i);
      if (peak) {
        isPeak = 1;
        peakAmp = peak.amplitude.toFixed(4);
        peakLabel = peak.label || '';
        peakExcluded = peak.excluded ? '1' : '0';
      } else {
        peakLabel = hiddenLabelByRow.get(i) || '';
        if (hiddenExcludedRows.has(i)) peakExcluded = '1';
      }

      let latVal = raw[i].lat;
      let lonVal = raw[i].lon;
      let rawLatVal = NaN;
      let rawLonVal = NaN;

      if (hasFilteredGps) {
        rawLatVal = latVal;
        rawLonVal = lonVal;
        latVal = filteredGps[i].lat;
        lonVal = filteredGps[i].lon;
      }

      const latStr =
        latVal !== null && latVal !== undefined && !isNaN(latVal)
          ? latVal.toFixed(7)
          : '';
      const lonStr =
        lonVal !== null && lonVal !== undefined && !isNaN(lonVal)
          ? lonVal.toFixed(7)
          : '';
      const rawLatStr =
        rawLatVal !== null && rawLatVal !== undefined && !isNaN(rawLatVal)
          ? rawLatVal.toFixed(7)
          : '';
      const rawLonStr =
        rawLonVal !== null && rawLonVal !== undefined && !isNaN(rawLonVal)
          ? rawLonVal.toFixed(7)
          : '';

      csv +=
        `${raw[i].time.toFixed(3)},` +
        `${raw[i].val.toFixed(4)},` +
        `${filtered[i].val.toFixed(4)},` +
        `${tonic[i].val.toFixed(4)},` +
        `${phasic[i].val.toFixed(4)},` +
        `${isPeak},` +
        `${peakAmp},` +
        `${GSRCSVParser._csvEscape(GSRCSVParser.cleanLabel(peakLabel))},` +
        `${peakExcluded},` +
        `${latStr},` +
        `${lonStr}`;

      if (hasFilteredGps) {
        csv += `,${rawLatStr},${rawLonStr}`;
      }

      if (hasGpsQuality) {
        const r = raw[i];
        // Only genuine fix rows carry real quality metadata — interpolated rows
        // are step-held in memory (see the interpolation pass in parseCSV) but
        // exporting that fabricated data would make every reimported row look
        // like an independent anchor, collapsing map.js's anchor-only Kalman
        // input back down to the dense interpolated grid. Leaving them blank
        // mirrors how the original device CSV itself encodes "no fix this tick".
        const isFix = !!r._isGpsFix;
        const hdopStr = isFix && !isNaN(r.hdop) ? r.hdop.toFixed(2) : '';
        const pdopStr = isFix && !isNaN(r.pdop) ? r.pdop.toFixed(2) : '';
        const haccStr = isFix && !isNaN(r.hacc) ? r.hacc.toFixed(2) : '';
        const speedKtsStr =
          isFix && !isNaN(r.speedKts) ? r.speedKts.toFixed(2) : '';
        const courseStr = isFix && !isNaN(r.course) ? r.course.toFixed(1) : '';
        const fixTypeStr = isFix ? r.fixType || 0 : '';
        const satsStr = isFix ? r.sats || 0 : '';
        csv += `,${hdopStr},${pdopStr},${haccStr},${fixTypeStr},${satsStr},${speedKtsStr},${courseStr},${isFix ? 1 : 0}`;
      }

      if (hasRf) {
        const r = raw[i];
        for (const b of activeBands)
          csv += `,${!isNaN(r[b.prop]) ? r[b.prop].toFixed(1) : ''}`;
        if (hasEmFog) csv += `,${!isNaN(r.em_fog) ? r.em_fog.toFixed(1) : ''}`;
      }

      for (const c of envCols) csv += `,${envCell(c, raw[i][c.field])}`;
      csv += '\n';
    }
    return csv;
  },
};
