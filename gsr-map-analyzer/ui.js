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
  var self = this;

  const onKeyDown = function(e) {
    if (e.key === 'Escape' && isFs) exit();
  };

  const enter = function() {
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
    setTimeout(function() { if (escapeHint) escapeHint.remove(); escapeHint = null; }, 3200);

    if (onToggle) onToggle();
  };

  const exit = function() {
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

  btn.addEventListener('click', function() {
    if (isFs) exit();
    else enter();
  });

  document.addEventListener('keydown', onKeyDown);
}

/**
 * Build the GPS filter parameter object from current slider values.
 */
function getGpsParams() {
  var S = AppState.sliders;
  return {
    minSats:      parseInt(S.gpsMinSats.value),
    maxSpeed:     parseFloat(S.gpsMaxSpeed.value),
    hampelWindow: parseInt(S.gpsHampelWindow.value),
    hampelSigma:  parseFloat(S.gpsHampelSigma.value),
    dbscanRadius: parseFloat(S.gpsDBSCANRadius.value),
    dbscanMinPts: parseInt(S.gpsDBSCANMinPts.value),
    kalmanR:      parseFloat(S.gpsKalmanR.value),
    kalmanQ:      Math.pow(10, -parseFloat(S.gpsKalmanQ.value)),
    rdpTolerance: parseFloat(S.gpsRDP.value),
    minDist:      parseFloat(S.gpsMinDist.value),
    downsample:   parseInt(S.gpsDownsample.value) === 1,
    trackWeight:  parseInt(S.gpsTrackWeight.value)
  };
}

/**
 * Re-render the Leaflet map with current GPS filter parameters.
 */
function rerenderMap() {
  if (!AppState.mapManager || !AppState.analyzer || AppState.analyzer.raw.length === 0) return;
  if (AppState.viewMode === 'single') {
    AppState.mapManager.renderData(AppState.analyzer, getGpsParams());
  } else {
    updateCollectiveMap();
  }
}

/**
 * Zoom and highlight a specific peak event when user clicks a row in the peaks table.
 */
function focusOnPeak(idx) {
  if (!AppState.analyzer || !AppState.analyzer.peaks || idx >= AppState.analyzer.peaks.length) return;
  var peak = AppState.analyzer.peaks[idx];
  AppState.activePeakIndex = idx;
  AppState.viewStartTime = Math.max(0, peak.onsetTime - 2);
  AppState.viewDuration = Math.min((peak.time - peak.onsetTime) + 5, AppState.totalDuration);
  AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;
  var select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'custom';
  document.querySelectorAll('#peaksTable tbody tr').forEach(function(r) { r.classList.remove('active-row'); });
  var row = document.getElementById('peakRow-' + idx);
  if (row) row.classList.add('active-row');
  redraw();
}

/**
 * Run the full analysis pipeline: GSR filtering + peak detection + map update.
 */
function runAnalysis() {
  if (!AppState.analyzer || AppState.analyzer.raw.length === 0) return;

  try {
    var S = AppState.sliders;
    var params = {
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
        AppState.mapManager.renderData(AppState.analyzer, getGpsParams());
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
  var stats = AppState.analyzer.getStats();
  var F = AppState.statFields;
  F.duration.innerText  = stats.duration.toFixed(1) + " s";
  F.meanSCL.innerText   = stats.meanSCL.toFixed(3) + " \u03bcS";
  F.peakCount.innerText = stats.peakCount;
  F.peakFreq.innerText  = stats.peakFrequency.toFixed(2) + " / min";
}

/**
 * Populate the peak events table below the graph.
 */
function updatePeaksTable() {
  var peaks = AppState.analyzer.peaks;
  var tb    = AppState.tableBody;

  if (peaks.length === 0) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="8">No peaks detected. Try reducing the Peak Amplitude threshold.</td></tr>';
    return;
  }

  var rowsHtml = "";
  peaks.forEach(function(p, idx) {
    var isAct = (idx === AppState.activePeakIndex) ? "class='active-row'" : "";
    var riseTimeStr = (p.time - p.onsetTime).toFixed(2);
    var recTimeStr = p.recoveryTime !== -1 ? p.recoveryTime.toFixed(2) : "N/A";

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
    document.getElementById('statDuration').innerText = '--';
    document.getElementById('statMeanSCL').innerText  = '--';
    document.getElementById('statPeakCount').innerText = '--';
    document.getElementById('statPeakFreq').innerText  = '--';
    return;
  }

  var contourParams = {
    gridResolution:    parseInt(document.getElementById('gridResolution').value),
    contourCount:      parseInt(document.getElementById('contourCount').value),
    isolationRadius:   parseFloat(document.getElementById('isolationRadius').value),
    idwExponent:       parseFloat(document.getElementById('idwExponent').value),
    topographySource:  document.getElementById('topoSource').value,
    showShadedSurface: document.getElementById('showShadedSurface') ? document.getElementById('showShadedSurface').checked : true,
    surfaceOpacity:    document.getElementById('surfaceOpacity') ? parseFloat(document.getElementById('surfaceOpacity').value) : 0.40
  };

  AppState.mapManager.renderCollectiveData(AppState.collectiveManager, contourParams);

  var totalDur = 0, totalPeaks = 0, sumSCL = 0, sclCount = 0;

  AppState.collectiveManager.getActiveTracks().forEach(function(track) {
    var stats = track.analyzer.getStats();
    totalDur += stats.duration;
    totalPeaks += stats.peakCount;
    track.analyzer.tonic.forEach(function(d) {
      sumSCL += d.val;
      sclCount++;
    });
  });

  var meanSCL = sclCount > 0 ? (sumSCL / sclCount) : 0;
  var meanPeakFreq = (totalDur > 0) ? (totalPeaks / (totalDur / 60.0)) : 0;

  document.getElementById('statDuration').innerText = (totalDur / 60.0).toFixed(1) + " min";
  document.getElementById('statMeanSCL').innerText  = meanSCL.toFixed(3) + " \u03bcS";
  document.getElementById('statPeakCount').innerText = totalPeaks;
  document.getElementById('statPeakFreq').innerText  = meanPeakFreq.toFixed(2) + " / min";
}

/**
 * Export processed GSR data as CSV.
 */
function exportCSV() {
  if (AppState.analyzer.raw.length === 0) return;
  var csvContent = AppState.analyzer.exportToCSV();

  var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  var url  = URL.createObjectURL(blob);
  var link = document.createElement("a");

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
  if (AppState.analyzer.raw.length === 0) return;
  saveCanvas(AppState.myCanvas, 'gsr_analysis_chart_' + Date.now(), 'png');
}

/**
 * Export Leaflet map as PNG via html2canvas.
 */
function saveMapImage() {
  if (AppState.analyzer.raw.length === 0) return;

  var mapElement = document.getElementById('map');
  var btn        = document.getElementById('exportMapBtn');
  var originalText = btn.innerHTML;

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
  btn.setAttribute('disabled', 'true');

  html2canvas(mapElement, {
    useCORS: true,
    allowTaint: false,
    backgroundColor: null,
    logging: false
  }).then(function(canvas) {
    var link = document.createElement("a");
    link.download = 'bio_map_' + Date.now() + '.png';
    link.href = canvas.toDataURL("image/png");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    btn.innerHTML = originalText;
    btn.removeAttribute('disabled');
  }).catch(function(err) {
    console.error("Error generating map PNG:", err);
    alert("Could not export map. Some map resources may have failed to load securely (CORS).");
    btn.innerHTML = originalText;
    btn.removeAttribute('disabled');
  });
}
