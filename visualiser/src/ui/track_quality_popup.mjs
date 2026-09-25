/**
 * Track Quality Report Popup (Hover Card)
 *
 * Displays a visual summary of recording quality, integrity status (green tick),
 * sensor health (GSR, GPS, RF), and validation warnings when hovering over
 * a track item in the Track Library (#trackList).
 */

import { GSR_CONST } from '../core/constants.mjs';
import { GeoUtils } from '../gps/geo_utils.mjs';
import { GpsPipeline } from '../gps/gps_pipeline.mjs';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const RF_BANDS = [815, 868, 915, 434, 446];

// Both keyed weakly so entries vanish with the track / raw array.
const _summaryCache = new WeakMap(); // track -> {version,name,color,summary,html}
const _rawScanCache = new WeakMap(); // analyzer.raw -> {length,hasGps,hasRf,scan}

export const GSRTrackQualityPopup = {
  _popupEl: null,
  _activeTrackId: null,
  _renderedHtml: null,

  /**
   * Format elapsed duration into human-readable text (e.g. "38m 12s" or "1h 14m").
   */
  formatDuration(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0s';
    const s = Math.round(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs}h ${mins}m`;
    }
    if (mins > 0) {
      return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
  },

  /**
   * Format distance in meters or kilometers.
   */
  formatDistance(meters) {
    if (isNaN(meters) || meters <= 0) return '0 m';
    if (meters >= 1000) {
      return `${(meters / 1000).toFixed(1)} km`;
    }
    return `${Math.round(meters)} m`;
  },

  /**
   * Format day-of-month ordinal suffix (1st, 2nd, 3rd, 4th, etc.).
   */
  ordinalSuffix(day) {
    if (day % 100 >= 11 && day % 100 <= 13) return 'th';
    const rem = day % 10;
    if (rem === 1) return 'st';
    if (rem === 2) return 'nd';
    if (rem === 3) return 'rd';
    return 'th';
  },

  /**
   * Format date into human-readable UK style with shortened month, e.g. "3rd Mar 2026".
   */
  formatDateUK(recordingStartTime, relativeSeconds = 0) {
    if (!recordingStartTime || recordingStartTime < 86400) return '';
    const d = new Date((recordingStartTime + relativeSeconds) * 1000);
    const day = d.getUTCDate();
    const month = MONTHS[d.getUTCMonth()];
    const year = d.getUTCFullYear();
    return `${day}${this.ordinalSuffix(day)} ${month} ${year}`;
  },

  /**
   * Single-pass scan of the raw rows for GSR / GPS / RF health. Depends only
   * on the raw samples, so it is cached per raw array (see _rawScan) and
   * survives re-analysis (slider drags bump _dataVersion but never touch raw).
   */
  _scanRaw(raw, hasGps, hasRf) {
    const n = raw.length;

    let gsrMin = Infinity;
    let gsrMax = -Infinity;
    let gsrSum = 0;
    let validGsrCount = 0;
    let zeroGsrCount = 0;

    let gpsDistanceM = 0;
    let validGpsFixes = 0;
    let dropouts = 0;
    let prevFix = null;
    const haccList = [];
    const hdopList = [];

    const rfSeen = new Set();

    for (let i = 0; i < n; i++) {
      const row = raw[i];
      const v = row.val;
      if (typeof v === 'number' && !isNaN(v)) {
        validGsrCount++;
        gsrSum += v;
        if (v < gsrMin) gsrMin = v;
        if (v > gsrMax) gsrMax = v;
        if (v <= 0.001) zeroGsrCount++;
      }

      if (hasGps && row._isGpsFix && !isNaN(row.lat) && !isNaN(row.lon)) {
        validGpsFixes++;
        if (row.hacc > 0 && row.hacc < 50) haccList.push(row.hacc);
        if (row.hdop > 0 && row.hdop < 50) hdopList.push(row.hdop);
        if (prevFix) {
          const dt = row.time - prevFix.time;
          const dist = GeoUtils.haversineMeters(
            prevFix.lat,
            prevFix.lon,
            row.lat,
            row.lon,
          );
          gpsDistanceM += dist;
          if (dt > 30 && !GpsPipeline.isImpossibleJump(dist, dt)) dropouts++;
        }
        prevFix = row;
      }

      if (hasRf && rfSeen.size < RF_BANDS.length) {
        for (const b of RF_BANDS) {
          if (!rfSeen.has(b) && !isNaN(row[`rssi_${b}`])) rfSeen.add(b);
        }
      }
    }

    return {
      gsrMin,
      gsrMax,
      validGsrCount,
      zeroGsrCount,
      rawGsrMean: validGsrCount > 0 ? gsrSum / validGsrCount : 0,
      gpsDistanceM,
      validGpsFixes,
      dropouts,
      medianHacc: median(haccList),
      medianHdop: median(hdopList),
      rfBandsSeen: RF_BANDS.filter((b) => rfSeen.has(b)).map((b) => `${b} MHz`),
    };
  },

  /**
   * Raw-scan result cached against the raw array identity + length.
   */
  _rawScan(a) {
    const hit = _rawScanCache.get(a.raw);
    if (
      hit &&
      hit.length === a.raw.length &&
      hit.hasGps === !!a.hasGpsData &&
      hit.hasRf === !!a.hasRfData
    ) {
      return hit.scan;
    }
    const scan = this._scanRaw(a.raw, !!a.hasGpsData, !!a.hasRfData);
    _rawScanCache.set(a.raw, {
      length: a.raw.length,
      hasGps: !!a.hasGpsData,
      hasRf: !!a.hasRfData,
      scan,
    });
    return scan;
  },

  /**
   * Run peak detection if the track has never been analysed, so the popup can
   * report peak counts. No-op for any track that already has results.
   */
  _ensureAnalysed(track) {
    const a = track.analyzer;
    const hasPeaks =
      (Array.isArray(a.peaks) && a.peaks.length > 0) ||
      (Array.isArray(a._peaks) && a._peaks.length > 0);
    if (
      hasPeaks ||
      (Array.isArray(a.filtered) && a.filtered.length > 0) ||
      typeof a.analyze !== 'function' ||
      a.raw.length === 0
    ) {
      return;
    }
    try {
      const filterParams =
        track.filterParams ||
        a.importedFilterParams ||
        GSR_CONST?.GSR_DEFAULT ||
        {};
      a.analyze(filterParams, track.gpsFilterParams?.peakLatency || 0);
    } catch (_err) {
      // Fall back gracefully if analysis fails
    }
  },

  /**
   * Quality summary for a track. Cached per track (WeakMap, so nothing is
   * added to the track object and entries die with it). An entry is reused
   * while analyzer._dataVersion, name and colour are unchanged — the version
   * is bumped by analyze(), peak exclusion, label edits and enrichment.
   */
  computeSummary(track) {
    if (!track) return null;
    const a = track.analyzer;
    if (!a || !Array.isArray(a.raw)) return null;

    const hit = _summaryCache.get(track);
    if (
      hit &&
      hit.version === a._dataVersion &&
      hit.name === track.name &&
      hit.color === track.color
    ) {
      return hit.summary;
    }

    const summary = this._buildSummary(track);
    _summaryCache.set(track, {
      version: a._dataVersion,
      name: track.name,
      color: track.color,
      summary,
      html: null,
    });
    return summary;
  },

  _buildSummary(track) {
    const a = track.analyzer;
    const raw = a.raw;
    const n = raw.length;
    const scan = this._rawScan(a);

    // ── Metadata & duration ──────────────────────────────────────────────────
    const durationSec = n > 0 ? Math.max(0, raw[n - 1].time - raw[0].time) : 0;
    const durationStr = this.formatDuration(durationSec);

    let dateTimeStr = '';
    if (a.recordingStartTime && a.recordingStartTime >= 86400) {
      const dateStr = this.formatDateUK(a.recordingStartTime);
      const timeStr =
        typeof a.formatTimeOnly === 'function' ? a.formatTimeOnly(0) : '';
      dateTimeStr = timeStr ? `${dateStr}, ${timeStr}` : dateStr;
    } else if (n > 0) {
      dateTimeStr = `${durationStr} recording`;
    }

    const integrityInfo = a.integrity || { status: 'none', detail: '' };

    const trackType = [
      a.hasGpsData ? 'GPS' : null,
      'GSR',
      a.hasRfData ? 'RF' : null,
    ]
      .filter(Boolean)
      .join(' + ');

    // ── GSR ──────────────────────────────────────────────────────────────────
    const { gsrMin, gsrMax, validGsrCount, zeroGsrCount } = scan;
    const gsrRange = isFinite(gsrMin) && isFinite(gsrMax) ? gsrMax - gsrMin : 0;

    const warnings = Array.isArray(a._csvWarnings) ? [...a._csvWarnings] : [];
    let isFlatline = gsrRange < 0.001 || validGsrCount === 0;
    let isDisconnected = zeroGsrCount > validGsrCount * 0.5 || isFlatline;
    for (const w of warnings) {
      if (
        w.includes('flat') ||
        w.includes('Electrode was likely not in skin contact')
      ) {
        isFlatline = true;
        isDisconnected = true;
      }
      if (w.includes('near-zero values') || w.includes('disconnected')) {
        isDisconnected = true;
      }
    }

    this._ensureAnalysed(track);

    let stats = null;
    if (typeof a.getStats === 'function') {
      try {
        stats = a.getStats();
      } catch (_err) {
        // Fall back gracefully
      }
    }

    const peakList = Array.isArray(a.peaks)
      ? a.peaks
      : Array.isArray(a._peaks)
        ? a._peaks
        : [];
    let peaksCount = 0;
    for (const p of peakList) if (!p.excluded) peaksCount++;

    const durationMinutes = durationSec / 60.0;
    const peaksPerMin =
      stats && typeof stats.peakFrequency === 'number'
        ? +stats.peakFrequency.toFixed(1)
        : durationMinutes > 0
          ? +(peaksCount / durationMinutes).toFixed(1)
          : 0;

    const gsrMean =
      stats && typeof stats.meanSCL === 'number' && stats.meanSCL > 0
        ? stats.meanSCL
        : scan.rawGsrMean;

    // ── GPS ──────────────────────────────────────────────────────────────────
    const validGpsFixes = scan.validGpsFixes;
    const gpsRetentionPct =
      validGpsFixes === 0
        ? 0
        : durationSec > 0
          ? Math.min(100, Math.round((validGpsFixes / durationSec) * 100))
          : 100;

    // ── RF ───────────────────────────────────────────────────────────────────
    let rfActiveBands = [];
    let rfHotspotCount = 0;
    if (a.hasRfData) {
      if (a.bandFloors) {
        rfActiveBands = Object.keys(a.bandFloors).map((k) => `${k} MHz`);
      } else {
        rfActiveBands =
          scan.rfBandsSeen.length > 0 ? scan.rfBandsSeen : ['RF Active'];
      }
      rfHotspotCount = a.rfPeakIndices ? a.rfPeakIndices.size : 0;
    }

    return {
      name: track.name,
      color: track.color,
      trackType,
      dateTimeStr,
      durationStr,
      distanceStr: this.formatDistance(scan.gpsDistanceM),
      notesCount: a._userPeakLabels ? a._userPeakLabels.size : 0,
      integrity: {
        status: integrityInfo.status, // 'verified' | 'incomplete' | 'corrupt' | 'none'
        detail: integrityInfo.detail || '',
      },
      gsr: {
        valid: validGsrCount > 0,
        isFlatline,
        isDisconnected,
        min: isFinite(gsrMin) ? +gsrMin.toFixed(2) : 0,
        max: isFinite(gsrMax) ? +gsrMax.toFixed(2) : 0,
        mean: +gsrMean.toFixed(2),
        peaksCount,
        peaksPerMin,
      },
      gps: {
        hasGps: a.hasGpsData,
        fixCount: validGpsFixes,
        retentionPct: gpsRetentionPct,
        medianHacc: scan.medianHacc ? +scan.medianHacc.toFixed(1) : null,
        medianHdop: scan.medianHdop ? +scan.medianHdop.toFixed(1) : null,
        dropouts: scan.dropouts,
      },
      rf: {
        hasRf: a.hasRfData,
        bands: rfActiveBands,
        hotspots: rfHotspotCount,
      },
      warnings,
    };
  },

  /**
   * Render HTML for the popup card based on the computed summary.
   */
  renderCardHtml(s) {
    if (!s) return '';

    // Integrity badge / icon
    let integrityHtml = '';
    if (s.integrity.status === 'verified') {
      integrityHtml = `<span class="tq-badge tq-badge-verified" title="${escapeHtml(s.integrity.detail || 'FNV-1a checksum verified')}"><i class="fa-solid fa-circle-check"></i> Verified</span>`;
    } else if (s.integrity.status === 'incomplete') {
      integrityHtml = `<span class="tq-badge tq-badge-incomplete" title="${escapeHtml(s.integrity.detail || 'Recording did not end cleanly')}"><i class="fa-solid fa-triangle-exclamation"></i> Incomplete</span>`;
    } else if (s.integrity.status === 'corrupt') {
      integrityHtml = `<span class="tq-badge tq-badge-corrupt" title="${escapeHtml(s.integrity.detail || 'Checksum failure')}"><i class="fa-solid fa-circle-xmark"></i> Corrupt</span>`;
    }

    // Notes pill
    const notesHtml =
      s.notesCount > 0
        ? `<span class="tq-meta-item"><i class="fa-solid fa-tag"></i> ${s.notesCount} note${s.notesCount === 1 ? '' : 's'}</span>`
        : `<span class="tq-meta-item tq-text-muted">Unannotated</span>`;

    // GSR sensor status: Good tag, mean GSR (µS), and peaks per min on 1 line
    let gsrStatsHtml = '';
    if (!s.gsr.valid) {
      gsrStatsHtml = `<span class="tq-tag tq-tag-muted">No Data</span>`;
    } else if (s.gsr.isDisconnected || s.gsr.isFlatline) {
      gsrStatsHtml = `<span class="tq-tag tq-tag-bad"><i class="fa-solid fa-triangle-exclamation"></i> Disconnected</span> <span class="tq-sensor-detail">${s.gsr.mean} µS</span>`;
    } else {
      gsrStatsHtml = `<span class="tq-tag tq-tag-good"><i class="fa-solid fa-check"></i> Good</span> <span class="tq-sensor-detail">${s.gsr.mean} µS · <b>${s.gsr.peaksPerMin}</b> peaks/m</span>`;
    }

    // GPS sensor status
    let gpsContentHtml = '';
    if (s.gps.hasGps && s.gps.fixCount > 0) {
      const accStr = s.gps.medianHacc
        ? `±${s.gps.medianHacc}m acc`
        : s.gps.medianHdop
          ? `HDOP ${s.gps.medianHdop}`
          : 'Fix lock';
      const dropStr =
        s.gps.dropouts === 0
          ? 'Solid path'
          : `${s.gps.dropouts} gap${s.gps.dropouts > 1 ? 's' : ''}`;
      const gpsBadge = s.gps.dropouts === 0 ? 'tq-tag-good' : 'tq-tag-warn';
      gpsContentHtml = `<span class="tq-tag ${gpsBadge}"><i class="fa-solid fa-location-dot"></i> ${accStr}</span> <span class="tq-sensor-detail">${s.gps.retentionPct}% fixes · ${dropStr}</span>`;
    } else {
      gpsContentHtml = `<span class="tq-tag tq-tag-muted">No Fixes</span>`;
    }

    // RF sensor status (only if RF is present)
    let rfRowHtml = '';
    if (s.rf.hasRf) {
      const bandsStr = s.rf.bands.length > 0 ? s.rf.bands.join(', ') : 'Active';
      rfRowHtml = `
        <div class="tq-sensor-row">
          <div class="tq-sensor-label"><i class="fa-solid fa-tower-broadcast"></i> RF:</div>
          <div class="tq-sensor-value">
            <span class="tq-tag tq-tag-info">${escapeHtml(bandsStr)}</span>
          </div>
        </div>
      `;
    }

    // Warnings Banner
    let warningsHtml = '';
    if (s.warnings && s.warnings.length > 0) {
      const cleanWarnings = s.warnings
        .slice(0, 2)
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join('');
      warningsHtml = `
        <div class="tq-warnings">
          <div class="tq-warnings-title"><i class="fa-solid fa-triangle-exclamation"></i> Notices</div>
          <ul>${cleanWarnings}</ul>
        </div>
      `;
    }

    return `
      <div class="tq-card">
        <div class="tq-header">
          <div class="tq-title-group">
            <span class="tq-color-dot" style="background-color: ${escapeHtml(s.color)};"></span>
            <span class="tq-name">${escapeHtml(s.name)}</span>
          </div>
          <div class="tq-status-group">
            <span class="tq-type-badge">${s.trackType}</span>
            ${integrityHtml}
          </div>
        </div>

        <div class="tq-meta-bar">
          <span class="tq-meta-item"><i class="fa-regular fa-clock"></i> ${s.durationStr}</span>
          ${s.gps.hasGps ? `<span class="tq-meta-item"><i class="fa-solid fa-route"></i> ${s.distanceStr}</span>` : ''}
          ${notesHtml}
          ${s.dateTimeStr ? `<span class="tq-meta-item tq-date"><i class="fa-regular fa-calendar"></i> ${escapeHtml(s.dateTimeStr)}</span>` : ''}
        </div>

        <div class="tq-sensors">
          <div class="tq-sensor-row">
            <div class="tq-sensor-label"><i class="fa-solid fa-wave-square"></i> GSR:</div>
            <div class="tq-sensor-value">${gsrStatsHtml}</div>
          </div>
          <div class="tq-sensor-row">
            <div class="tq-sensor-label"><i class="fa-solid fa-satellite"></i> GPS:</div>
            <div class="tq-sensor-value">${gpsContentHtml}</div>
          </div>
          ${rfRowHtml}
        </div>

        ${warningsHtml}
      </div>
    `;
  },

  /**
   * Show the hover card anchored to targetEl.
   */
  show(track, targetEl) {
    if (!track || !targetEl) return;
    this._activeTrackId = track.id;

    if (!this._popupEl) {
      this._popupEl = document.createElement('div');
      this._popupEl.id = 'trackQualityHoverCard';
      this._popupEl.className = 'track-quality-popup';
      document.body.appendChild(this._popupEl);
    }

    const summary = this.computeSummary(track);
    if (!summary) return;

    // Reuse the rendered HTML while the summary entry is unchanged.
    const entry = _summaryCache.get(track);
    if (entry && entry.summary === summary) {
      if (entry.html === null) entry.html = this.renderCardHtml(summary);
      if (this._renderedHtml !== entry.html) {
        this._popupEl.innerHTML = entry.html;
        this._renderedHtml = entry.html;
      }
    } else {
      this._popupEl.innerHTML = this.renderCardHtml(summary);
      this._renderedHtml = null;
    }
    this._popupEl.style.display = 'block';
    this._popupEl.style.opacity = '1';

    // Position adjacent to the hovered track item
    const rect = targetEl.getBoundingClientRect();
    const popupRect = this._popupEl.getBoundingClientRect();

    // Prefer placing to the right of the track item
    let left = rect.right + 12;
    let top = rect.top + rect.height / 2 - popupRect.height / 2;

    // If overflowing viewport right edge, flip to left of track item
    if (left + popupRect.width > window.innerWidth - 10) {
      left = rect.left - popupRect.width - 12;
    }

    // Keep within vertical viewport bounds
    if (top < 10) top = 10;
    if (top + popupRect.height > window.innerHeight - 10) {
      top = window.innerHeight - popupRect.height - 10;
    }

    this._popupEl.style.left = `${Math.max(10, Math.round(left))}px`;
    this._popupEl.style.top = `${Math.round(top)}px`;
  },

  /**
   * Hide the hover card.
   */
  hide() {
    this._activeTrackId = null;
    if (this._popupEl) {
      this._popupEl.style.opacity = '0';
      this._popupEl.style.display = 'none';
    }
  },
};

function median(list) {
  if (list.length === 0) return null;
  const sorted = Float64Array.from(list).sort();
  return sorted[sorted.length >> 1];
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
