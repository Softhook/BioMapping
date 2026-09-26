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
   * @param {number} state.enrichmentRadius
   * @param {number} state.recordingStartTime
   * @param {Array<string>} [state.deviceHeaderLines] - Device metadata lines from the source file.
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
      enrichmentRadius,
      recordingStartTime,
      deviceHeaderLines = [],
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

    const hasRssi300 = raw.some((d) => !isNaN(d.rssi_300));
    const hasRssi315 = raw.some((d) => !isNaN(d.rssi_315));
    const hasRssi434 = raw.some((d) => !isNaN(d.rssi_434));
    const hasRssi446 = raw.some((d) => !isNaN(d.rssi_446));
    const hasRssi815 = raw.some((d) => !isNaN(d.rssi_815));
    const hasRssi868 = raw.some((d) => !isNaN(d.rssi_868));
    const hasRssi915 = raw.some((d) => !isNaN(d.rssi_915));
    const hasEmFog = raw.some((d) => !isNaN(d.em_fog));

    const hasRf =
      hasRssi300 ||
      hasRssi315 ||
      hasRssi434 ||
      hasRssi446 ||
      hasRssi815 ||
      hasRssi868 ||
      hasRssi915 ||
      hasEmFog;
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
    if (isEnriched) {
      csv += `# EnrichmentRadius:${enrichmentRadius}\n`;
    }
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
      if (hasRssi300) csv += ',rssi_300';
      if (hasRssi315) csv += ',rssi_315';
      if (hasRssi434) csv += ',rssi_434';
      if (hasRssi446) csv += ',rssi_446';
      if (hasRssi815) csv += ',rssi_815';
      if (hasRssi868) csv += ',rssi_868';
      if (hasRssi915) csv += ',rssi_915';
      if (hasEmFog) csv += ',em_fog';
    }
    if (isEnriched) {
      csv +=
        ',osm_road_class,osm_dist_major_road,osm_in_park,osm_green_pct_50m,osm_dist_green,osm_canopy_pct_50m,osm_building_density_50m,osm_dist_water,osm_tree_density_50m,osm_amenity_count_50m';
    }
    if (hasNdvi) {
      csv += ',ndvi,ndvi_50m';
    }
    csv += '\n';

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
        if (hasRssi300)
          csv += `,${!isNaN(r.rssi_300) ? r.rssi_300.toFixed(1) : ''}`;
        if (hasRssi315)
          csv += `,${!isNaN(r.rssi_315) ? r.rssi_315.toFixed(1) : ''}`;
        if (hasRssi434)
          csv += `,${!isNaN(r.rssi_434) ? r.rssi_434.toFixed(1) : ''}`;
        if (hasRssi446)
          csv += `,${!isNaN(r.rssi_446) ? r.rssi_446.toFixed(1) : ''}`;
        if (hasRssi815)
          csv += `,${!isNaN(r.rssi_815) ? r.rssi_815.toFixed(1) : ''}`;
        if (hasRssi868)
          csv += `,${!isNaN(r.rssi_868) ? r.rssi_868.toFixed(1) : ''}`;
        if (hasRssi915)
          csv += `,${!isNaN(r.rssi_915) ? r.rssi_915.toFixed(1) : ''}`;
        if (hasEmFog) csv += `,${!isNaN(r.em_fog) ? r.em_fog.toFixed(1) : ''}`;
      }

      if (isEnriched) {
        const roadClassStr = raw[i].osm_road_class
          ? GSRCSVParser._csvEscape(raw[i].osm_road_class)
          : '';
        const distMajorStr =
          raw[i].osm_dist_major_road !== null &&
          !isNaN(raw[i].osm_dist_major_road)
            ? raw[i].osm_dist_major_road.toFixed(2)
            : '';
        const inParkStr =
          raw[i].osm_in_park !== null && !isNaN(raw[i].osm_in_park)
            ? raw[i].osm_in_park.toString()
            : '';
        const greenPctStr =
          raw[i].osm_green_pct_50m !== null && !isNaN(raw[i].osm_green_pct_50m)
            ? raw[i].osm_green_pct_50m.toFixed(1)
            : '';
        const distGreenStr =
          raw[i].osm_dist_green !== null && !isNaN(raw[i].osm_dist_green)
            ? raw[i].osm_dist_green.toFixed(2)
            : '';
        const canopyPctStr =
          raw[i].osm_canopy_pct_50m !== null &&
          !isNaN(raw[i].osm_canopy_pct_50m)
            ? raw[i].osm_canopy_pct_50m.toFixed(1)
            : '';
        const bldDensityStr =
          raw[i].osm_building_density_50m !== null &&
          !isNaN(raw[i].osm_building_density_50m)
            ? raw[i].osm_building_density_50m.toFixed(1)
            : '';
        const distWaterStr =
          raw[i].osm_dist_water !== null && !isNaN(raw[i].osm_dist_water)
            ? raw[i].osm_dist_water.toFixed(2)
            : '';
        const treeDensStr =
          raw[i].osm_tree_density_50m !== null &&
          !isNaN(raw[i].osm_tree_density_50m)
            ? raw[i].osm_tree_density_50m.toFixed(1)
            : '';
        const amCountStr =
          raw[i].osm_amenity_count_50m !== null &&
          !isNaN(raw[i].osm_amenity_count_50m)
            ? raw[i].osm_amenity_count_50m.toFixed(1)
            : '';

        csv += `,${roadClassStr},${distMajorStr},${inParkStr},${greenPctStr},${distGreenStr},${canopyPctStr},${bldDensityStr},${distWaterStr},${treeDensStr},${amCountStr}`;
      }
      if (hasNdvi) {
        const ndviStr =
          raw[i].ndvi !== null && !isNaN(raw[i].ndvi)
            ? raw[i].ndvi.toFixed(3)
            : '';
        const ndvi50mStr =
          raw[i].ndvi_50m !== null && !isNaN(raw[i].ndvi_50m)
            ? raw[i].ndvi_50m.toFixed(3)
            : '';
        csv += `,${ndviStr},${ndvi50mStr}`;
      }
      csv += '\n';
    }
    return csv;
  },
};
