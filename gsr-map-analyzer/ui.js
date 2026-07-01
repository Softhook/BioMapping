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
function setupPanelFullscreen(btnId, panelId, onToggle) {
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
}

/**
 * Re-render the Leaflet map with current GPS filter parameters.
 */
function rerenderMap() {
  if (!AppState.mapManager || !AppState.analyzer || AppState.analyzer.raw.length === 0) return;

  // Save GPS params to the active track whenever GPS sliders change
  saveActiveGpsParams();

  if (AppState.viewMode === 'single') {
    AppState.mapManager.renderData(AppState.analyzer, buildGpsParams());
  } else {
    updateCollectiveMap();
  }
}

/**
 * Zoom and highlight a specific peak event when user clicks a row in the peaks table.
 */
function focusOnPeak(idx) {
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
}

/**
 * Run the full analysis pipeline: GSR filtering + peak detection + map update.
 */
function runAnalysis() {
  if (!AppState.analyzer || AppState.analyzer.raw.length === 0) return;

  try {
    const S = AppState.sliders;
    const params = {
      medianSize:    parseFloat(S.medianSize.value),
      lpfWindow:     parseFloat(S.lpfWindow.value),
      tonicMethod:   S.tonicMethod.value,
      tonicWindow:   parseInt(S.tonicWindow.value),
      peakThreshold: parseFloat(S.peakThreshold.value)
    };

    saveActiveTrackParams();
    AppState.analyzer.analyze(params);

    if (AppState.viewMode === 'single') {
      if (AppState.mapManager) {
        AppState.mapManager.renderData(AppState.analyzer, buildGpsParams());
      }
    } else {
      updateCollectiveMap();
    }

    updateStatsPanel();
    updatePeaksTable();
    redraw();
  } catch (err) {
    console.error("Analysis error:", err);
    alert("Error running analysis: " + err.message);
  }
}

/**
 * Update the four stat cards with current track metrics.
 */
function updateStatsPanel() {
  const stats = AppState.analyzer.getStats();
  const F = AppState.statFields;
  F.duration.innerText  = stats.duration.toFixed(1) + " s";
  F.meanSCL.innerText   = stats.meanSCL.toFixed(3) + " \u03bcS";
  F.peakCount.innerText = stats.peakCount;
  F.peakFreq.innerText  = stats.peakFrequency.toFixed(2) + " / min";
}

/**
 * Populate the peak events table below the graph.
 */
function updatePeaksTable() {
  const peaks = AppState.analyzer.peaks;
  const tb    = AppState.tableBody;

  if (peaks.length === 0) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">No peaks detected. Try reducing the Peak Amplitude threshold.</td></tr>';
    return;
  }

  let rowsHtml = "";
  peaks.forEach((p, idx) => {
    const isAct = (idx === AppState.activePeakIndex) ? "class='active-row'" : "";
    const riseTimeStr = (p.time - p.onsetTime).toFixed(2);
    const recTimeStr = p.recoveryTime !== -1 ? p.recoveryTime.toFixed(2) : "N/A";

    rowsHtml += '<tr id="peakRow-' + idx + '" ' + isAct + ' onclick="focusOnPeak(' + idx + ')">' +
      '<td>' + (idx + 1) + '</td>' +
      '<td>' + p.onsetTime.toFixed(2) + '</td>' +
      '<td>' + p.time.toFixed(2) + '</td>' +
      '<td>' + p.value.toFixed(4) + '</td>' +
      '<td>' + p.amplitude.toFixed(4) + '</td>' +
      '<td>' + riseTimeStr + '</td>' +
      '<td>' + recTimeStr + '</td>' +
      '<td><button class="btn-table-action" onclick="event.stopPropagation(); focusOnPeak(' + idx + ')">' +
      '<i class="fa-solid fa-arrows-to-eye"></i> View</button></td></tr>';
  });

  tb.innerHTML = rowsHtml;
}

/**
 * Render all active tracks on the collective map with contour lines.
 */
function updateCollectiveMap() {
  if (!AppState.mapManager) return;

  if (AppState.collectiveManager.getActiveTracks().length === 0) {
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

  AppState.mapManager.renderCollectiveData(AppState.collectiveManager, contourParams);

  let totalDur = 0, totalPeaks = 0, sumSCL = 0, sclCount = 0;

  AppState.collectiveManager.getActiveTracks().forEach(track => {
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
  if (F.duration) F.duration.innerText = (totalDur / 60.0).toFixed(1) + " min";
  if (F.meanSCL)  F.meanSCL.innerText  = meanSCL.toFixed(3) + " \u03bcS";
  if (F.peakCount) F.peakCount.innerText = totalPeaks;
  if (F.peakFreq)  F.peakFreq.innerText  = meanPeakFreq.toFixed(2) + " / min";
}

/**
 * Export processed GSR data as CSV.
 */
function exportCSV() {
  if (AppState.analyzer.raw.length === 0) return;
  const csvContent = AppState.analyzer.exportToCSV();

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.setAttribute("href", url);
  link.setAttribute("download", 'processed_gsr_' + Date.now() + '.csv');
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Export p5.js canvas as PNG.
 */
function saveCanvasImage() {
  if (!AppState.myCanvas || AppState.analyzer.raw.length === 0) return;
  saveCanvas(AppState.myCanvas, 'gsr_analysis_chart_' + Date.now(), 'png');
}

/**
 * Export Leaflet map as PNG via html2canvas.
 */
function saveMapImage() {
  if (AppState.analyzer.raw.length === 0) return;

  const mapElement = document.getElementById('map');
  const btn        = document.getElementById('exportMapBtn');
  const originalText = btn.innerHTML;

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
  btn.setAttribute('disabled', 'true');

  html2canvas(mapElement, {
    useCORS: true,
    allowTaint: false,
    backgroundColor: null,
    logging: false
  }).then(canvas => {
    const link = document.createElement("a");
    link.download = 'bio_map_' + Date.now() + '.png';
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
}
