/**
 * UI Actions — analysis pipeline, map rendering, stats, exports, fullscreen.
 * Event binding and DOM caching live in events.js.
 * Track library CRUD lives in tracks.js.
 * All shared state is accessed through AppState.
 */

/**
 * Generic helper: makes a panel section go full-screen by inserting it into
 * a fixed overlay div, then restores it when the button is clicked again or
 * the user presses Escape.
 */
const GSRUI = {
  /**
   * Generic helper: makes a panel section go full-screen by inserting it into
   * a fixed overlay div, then restores it when the button is clicked again or
   * the user presses Escape.
   */
  setupPanelFullscreen(btnId, panelId, onToggle) {
    const btn   = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) return;

    let overlay      = null;
    let placeholder  = null;
    let escapeHint   = null;
    let isFs         = false;

    const onKeyDown = (e) => {
      if (e.key === 'Escape' && isFs) exit();
    };

    const enter = () => {
      isFs = true;
      btn.classList.add('is-fullscreen');
      btn.querySelector('i').classList.replace('fa-expand', 'fa-compress');

      placeholder = document.createElement('div');
      placeholder.style.cssText = 'width: ' + panel.offsetWidth + 'px; height: ' + panel.offsetHeight + 'px; visibility: hidden;';
      panel.parentNode.insertBefore(placeholder, panel);

      overlay = document.createElement('div');
      overlay.className = 'panel-fullscreen-overlay';
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      escapeHint = document.createElement('div');
      escapeHint.className = 'fs-escape-hint';
      escapeHint.innerHTML = '<i class="fa-solid fa-compress" style="margin-right:5px;"></i>Press Esc or click <strong>\u2291</strong> to exit full screen';
      document.body.appendChild(escapeHint);
      setTimeout(() => { if (escapeHint) escapeHint.remove(); escapeHint = null; }, 3200);

      if (onToggle) onToggle();
    };

    const exit = () => {
      if (!isFs) return;
      isFs = false;
      btn.classList.remove('is-fullscreen');
      btn.querySelector('i').classList.replace('fa-compress', 'fa-expand');

      if (placeholder && placeholder.parentNode) {
        placeholder.parentNode.insertBefore(panel, placeholder);
        placeholder.remove();
        placeholder = null;
      }

      if (overlay && overlay.parentNode) {
        overlay.remove();
        overlay = null;
      }

      if (escapeHint) { escapeHint.remove(); escapeHint = null; }

      if (onToggle) onToggle();
    };

    btn.addEventListener('click', () => {
      if (isFs) exit();
      else enter();
    });

    document.addEventListener('keydown', onKeyDown);
  },

  /**
   * Re-render the Leaflet map with current GPS filter parameters.
   */
  rerenderMap() {
    if (!AppState.mapManager || !AppState.analyzer || AppState.analyzer.raw.length === 0) return;

    // Save GPS params to the active track whenever GPS sliders change
    GSRTrackManager.saveActiveGpsParams();

    if (AppState.viewMode === 'single') {
      AppState.mapManager.renderData(AppState.analyzer, GSRStorage.buildGpsParams());
    } else {
      GSRUI.updateCollectiveMap();
    }
  },

  /**
   * Update a peak's label from table or map popup input, then refresh the UI.
   * If trackId is provided, the peak belongs to that track (collective mode).
   */
  updatePeakLabel(idx, label, trackId) {
    let peaksArr;
    if (trackId) {
      const track = AppState.collectiveManager.getTrack(trackId);
      if (!track || !track.analyzer || !track.analyzer.peaks || idx >= track.analyzer.peaks.length) return;
      peaksArr = track.analyzer.peaks;
    } else {
      if (!AppState.analyzer || !AppState.analyzer.peaks || idx >= AppState.analyzer.peaks.length) return;
      peaksArr = AppState.analyzer.peaks;
    }
    peaksArr[idx].label = label.trim();
    // Refresh displays
    if (AppState.viewMode === 'single') {
      if (AppState.mapManager) {
        AppState.mapManager.renderData(AppState.analyzer, GSRStorage.buildGpsParams());
      }
      GSRUI.updatePeaksTable();
      redraw();
    } else {
      GSRUI.updateCollectiveMap();
    }
  },

  /**
   * Zoom and highlight a specific peak event when user clicks a row in the peaks table.
   */
  focusOnPeak(idx) {
    if (!AppState.analyzer || !AppState.analyzer.peaks || idx >= AppState.analyzer.peaks.length) return;
    const peak = AppState.analyzer.peaks[idx];
    AppState.activePeakIndex = idx;
    AppState.viewStartTime = Math.max(0, peak.onsetTime - 2);
    AppState.viewDuration = Math.min((peak.time - peak.onsetTime) + 5, AppState.totalDuration);
    AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;
    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';
    document.querySelectorAll('#peaksTable tbody tr').forEach(r => r.classList.remove('active-row'));
    const row = document.getElementById('peakRow-' + idx);
    if (row) row.classList.add('active-row');
    redraw();
  },

  /**
   * Run the full analysis pipeline: GSR filtering + peak detection + map update.
   */
  runAnalysis() {
    if (!AppState.analyzer || AppState.analyzer.raw.length === 0) return;

    try {
      const params = GSRStorage.readGsrSliderValues();

      GSRTrackManager.saveActiveTrackParams();
      AppState.analyzer.analyze(params);

      if (AppState.viewMode === 'single') {
        if (AppState.mapManager) {
          AppState.mapManager.renderData(AppState.analyzer, GSRStorage.buildGpsParams());
        }
      } else {
        GSRUI.updateCollectiveMap();
      }

      GSRUI.updateStatsPanel();
      GSRUI.updatePeaksTable();
      redraw();
    } catch (err) {
      console.error("Analysis error:", err);
      alert("Error running analysis: " + err.message);
    }
  },

  /**
   * Update the four stat cards with current track metrics.
   */
  updateStatsPanel() {
    const stats = AppState.analyzer.getStats();
    const a = AppState.analyzer;
    const F = AppState.statFields;

    const hasClock = a.recordingStartTime && a.recordingStartTime >= 86400;
    if (F.date)      F.date.innerText      = hasClock ? a.formatDateUK(0) : '--';
    if (F.startTime) F.startTime.innerText  = hasClock ? a.formatTimeOnly(0) : '--';
    F.duration.innerText  = stats.duration.toFixed(1) + " s";
    F.meanSCL.innerText   = stats.meanSCL.toFixed(3) + " \u03bcS";
    F.peakCount.innerText = stats.peakCount;
    F.peakFreq.innerText  = stats.peakFrequency.toFixed(2) + " / min";
  },

  /**
   * Populate the peak events table below the graph.
   */
  updatePeaksTable() {
    const peaks = AppState.analyzer.peaks;
    const tb    = AppState.tableBody;

    if (peaks.length === 0) {
      tb.innerHTML = '<tr class="empty-row"><td colspan="13">No peaks detected. Try reducing the Peak Amplitude threshold.</td></tr>';
      return;
    }

    // Quality score thresholds for coloring
    const qualityLow = '#d1002420';
    const qualityMed = '#e59e0030';
    const qualityHigh = '#008f3c20';

    let rowsHtml = "";
    peaks.forEach((p, idx) => {
      const isAct = (idx === AppState.activePeakIndex) ? "class='active-row'" : "";
      const riseTimeStr = (p.riseTime || (p.time - p.onsetTime)).toFixed(2);
      const recTimeStr = p.halfRecoveryTime !== undefined && p.halfRecoveryTime !== -1
        ? p.halfRecoveryTime.toFixed(2) : "N/A";
      const onsetSlopeStr = p.onsetSlope !== undefined
        ? p.onsetSlope.toFixed(5) : (p.amplitude / Math.max(0.1, p.time - p.onsetTime)).toFixed(5);
      const decaySlopeStr = p.decaySlope !== undefined
        ? p.decaySlope.toFixed(5) : "N/A";
      const skewStr = p.skewnessRatio !== undefined
        ? p.skewnessRatio.toFixed(3) : "N/A";
      const snrStr = p.snr !== undefined
        ? p.snr.toFixed(2) + "x" : "N/A";
      const qScore = p.qualityScore !== undefined ? p.qualityScore : 0;
      const qPct = Math.round(qScore * 100);
      const qColor = qScore >= 0.7 ? qualityHigh : (qScore >= 0.4 ? qualityMed : qualityLow);
      const qLabel = qScore >= 0.7 ? 'High' : (qScore >= 0.4 ? 'Med' : 'Low');

      const escapedLabel = (p.label || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      rowsHtml += '<tr id="peakRow-' + idx + '" ' + isAct + ' onclick="GSRUI.focusOnPeak(' + idx + ')">' +
        '<td>' + (idx + 1) + '</td>' +
        '<td class="label-cell">' +
          '<input class="peak-label-input" type="text" value="' + escapedLabel + '" ' +
            'placeholder="Add label…" data-peak-idx="' + idx + '" ' +
            'onclick="event.stopPropagation();" ' +
            'onchange="GSRUI.updatePeakLabel(' + idx + ', this.value)" ' +
            'onkeydown="if(event.key===\'Enter\') { GSRUI.updatePeakLabel(' + idx + ', this.value); this.blur(); }">' +
        '</td>' +
        '<td>' + p.onsetTime.toFixed(2) + '</td>' +
        '<td>' + p.time.toFixed(2) + '</td>' +
        '<td>' + p.value.toFixed(4) + '</td>' +
        '<td>' + p.amplitude.toFixed(4) + '</td>' +
        '<td>' + riseTimeStr + '</td>' +
        '<td>' + recTimeStr + '</td>' +
        '<td style="background:' + qColor + '; font-weight:' + (qScore >= 0.7 ? '600' : '400') + '">' +
          qPct + '% ' + qLabel + '</td>' +
        '<td>' + onsetSlopeStr + '</td>' +
        '<td>' + skewStr + '</td>' +
        '<td>' + snrStr + '</td>' +
        '<td><button class="btn-table-action" onclick="event.stopPropagation(); GSRUI.focusOnPeak(' + idx + ')">' +
        '<i class="fa-solid fa-arrows-to-eye"></i> View</button></td></tr>';
    });

    tb.innerHTML = rowsHtml;
  },

  /**
   * Render all active tracks on the collective map with contour lines.
   */
  updateCollectiveMap() {
    if (!AppState.mapManager) return;

    if (GSRTrackManager.getActiveTracks().length === 0) {
      AppState.mapManager.clearCollectiveLayers();
      const F0 = AppState.statFields;
      if (F0.duration)  F0.duration.innerText  = '--';
      if (F0.meanSCL)   F0.meanSCL.innerText   = '--';
      if (F0.peakCount) F0.peakCount.innerText = '--';
      if (F0.peakFreq)  F0.peakFreq.innerText  = '--';
      return;
    }

    const cc = AppState.contourControls;
    const contourParams = {
      gridResolution:    parseInt(cc.gridResolution ? cc.gridResolution.value : GSR_CONST.COLLECTIVE.gridResolution),
      contourCount:      parseInt(cc.contourCount ? cc.contourCount.value : GSR_CONST.COLLECTIVE.contourCount),
      isolationRadius:   parseFloat(cc.isolationRadius ? cc.isolationRadius.value : GSR_CONST.COLLECTIVE.isolationRadius),
      idwExponent:       parseFloat(cc.idwExponent ? cc.idwExponent.value : GSR_CONST.COLLECTIVE.idwExponent),
      topographySource:  cc.topoSource ? cc.topoSource.value : 'phasic',
      showShadedSurface: cc.showShadedSurface ? cc.showShadedSurface.checked : true,
      surfaceOpacity:    cc.surfaceOpacity ? parseFloat(cc.surfaceOpacity.value) : 0.40
    };

    const lat = parseFloat(AppState.sliders.gpsPeakLatency ? AppState.sliders.gpsPeakLatency.value : 0);
    AppState.mapManager.renderCollectiveData(AppState.collectiveManager, contourParams, lat);

    let totalDur = 0, totalPeaks = 0, sumSCL = 0, sclCount = 0;

    GSRTrackManager.getActiveTracks().forEach(track => {
      const stats = track.analyzer.getStats();
      totalDur += stats.duration;
      totalPeaks += stats.peakCount;
      track.analyzer.tonic.forEach(d => {
        sumSCL += d.val;
        sclCount++;
      });
    });

    const meanSCL = sclCount > 0 ? (sumSCL / sclCount) : 0;
    const meanPeakFreq = (totalDur > 0) ? (totalPeaks / (totalDur / 60.0)) : 0;

    const F = AppState.statFields;
    if (F.date)      F.date.innerText      = '--';
    if (F.startTime) F.startTime.innerText  = '--';
    if (F.duration) F.duration.innerText = (totalDur / 60.0).toFixed(1) + " min";
    if (F.meanSCL)  F.meanSCL.innerText  = meanSCL.toFixed(3) + " \u03bcS";
    if (F.peakCount) F.peakCount.innerText = totalPeaks;
    if (F.peakFreq)  F.peakFreq.innerText  = meanPeakFreq.toFixed(2) + " / min";
  },

  /**
   * Get a sanitized filename base from the active track name.
   */
  _exportFilenameBase() {
    const track = AppState.activeTrackId
      ? AppState.collectiveManager.getTrack(AppState.activeTrackId)
      : null;
    const name = track ? track.name.replace(/\.[^/.]+$/, '') : 'gsr_analysis';
    // Sanitize for filenames: replace non-alphanumeric chars (except . - _) with underscores
    return name.replace(/[^a-zA-Z0-9._-]/g, '_');
  },

  /**
   * Export processed GSR data as CSV.
   */
  exportCSV() {
    if (AppState.analyzer.raw.length === 0) return;
    const csvContent = AppState.analyzer.exportToCSV();

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const baseName = GSRUI._exportFilenameBase();
    link.setAttribute("href", url);
    link.setAttribute("download", baseName + '_processed.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },

  /**
   * Export p5.js canvas as PNG.
   */
  saveCanvasImage() {
    if (!AppState.myCanvas || AppState.analyzer.raw.length === 0) return;
    const baseName = GSRUI._exportFilenameBase();
    saveCanvas(AppState.myCanvas, baseName + '_chart', 'png');
  },

  /**
   * Export Leaflet map as PNG via html2canvas.
   */
  saveMapImage() {
    if (AppState.analyzer.raw.length === 0) return;

    const mapElement = document.getElementById('map');
    const btn        = document.getElementById('exportMapBtn');
    const originalText = btn.innerHTML;

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
    btn.setAttribute('disabled', 'true');

    const baseName = GSRUI._exportFilenameBase();
    html2canvas(mapElement, {
      useCORS: true,
      allowTaint: false,
      backgroundColor: null,
      logging: false
    }).then(canvas => {
      const link = document.createElement("a");
      link.download = baseName + '_map.png';
      link.href = canvas.toDataURL("image/png");
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      btn.innerHTML = originalText;
      btn.removeAttribute('disabled');
    }).catch(err => {
      console.error("Error generating map PNG:", err);
      alert("Could not export map. Some map resources may have failed to load securely (CORS).");
      btn.innerHTML = originalText;
      btn.removeAttribute('disabled');
    });
  },

  /**
   * Zoom the p5.js timeline view.
   */
  zoomCanvas(multiplier) {
    if (AppState.analyzer.raw.length === 0) return;

    const centerTime = AppState.viewStartTime + AppState.viewDuration / 2;

    AppState.viewDuration = constrain(AppState.viewDuration / multiplier, 2.0, AppState.totalDuration);
    AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;

    AppState.viewStartTime = centerTime - AppState.viewDuration / 2;
    AppState.viewStartTime = constrain(AppState.viewStartTime, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));

    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';

    redraw();
  },

  /**
   * Reset the p5.js timeline view to fit the full track.
   */
  resetView() {
    if (AppState.analyzer.raw.length === 0) return;
    AppState.viewStartTime = 0;
    AppState.viewDuration = AppState.totalDuration;
    AppState.zoomFactor = 1.0;
    AppState.activePeakIndex = -1;

    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'fit';

    document.querySelectorAll('#peaksTable tbody tr').forEach(r => { r.classList.remove('active-row'); });

    redraw();
  }
};
