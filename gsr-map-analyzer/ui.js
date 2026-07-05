/**
 * UI Actions — analysis pipeline, map rendering, stats, exports, fullscreen.
 * Event binding and DOM caching live in events.js.
 * Track library CRUD lives in tracks.js.
 * All shared state is accessed through AppState.
 */

const GSRUI = {

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
   * Resolve the correct peaks array for a given trackId (or active track).
   */
  _getPeaksArray(trackId) {
    if (trackId) {
      const track = AppState.collectiveManager.getTrack(trackId);
      return (track && track.analyzer) ? track.analyzer.peaks : null;
    }
    return (AppState.analyzer) ? AppState.analyzer.peaks : null;
  },

  /**
   * Toggle exclusion state for a peak event, then refresh all views.
   */
  togglePeakExclusion(idx, trackId) {
    const peaks = GSRUI._getPeaksArray(trackId);
    if (!peaks || idx >= peaks.length) return;
    peaks[idx].excluded = !peaks[idx].excluded;
    // Refresh displays
    if (AppState.viewMode === 'single') {
      GSRUI.updatePeaksTable();
      redraw();
      if (AppState.mapManager) {
        AppState.mapManager.renderData(AppState.analyzer, GSRStorage.buildGpsParams());
      }
    } else {
      GSRUI.updateCollectiveMap();
    }
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
    const dur = stats.duration;
    const durMins = Math.floor(dur / 60);
    const durSecs = Math.floor(dur % 60);
    F.duration.innerText  = durMins > 0
      ? durMins + ' min ' + durSecs + ' sec'
      : durSecs + ' sec';
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
      tb.innerHTML = '<tr class="empty-row"><td colspan="14">No peaks detected. Try reducing the Peak Amplitude threshold.</td></tr>';
      return;
    }

    let rowsHtml = "";
    peaks.forEach((p, idx) => {
      const rowClass = [];
      if (idx === AppState.activePeakIndex) rowClass.push('active-row');
      if (p.excluded) rowClass.push('excluded-row');
      const rowAttr = rowClass.length > 0 ? "class='" + rowClass.join(' ') + "'" : "";
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
      const qColor = getQualityColor(qScore, '20');
      const { pct: qPct, label: qLabel } = getQualityLabel(qScore);

      const escapedLabel = (p.label || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      rowsHtml += '<tr id="peakRow-' + idx + '" ' + rowAttr + ' onclick="GSRUI.focusOnPeak(' + idx + ')">' +
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
        '<td style="background:' + qColor + '">' +
          qPct + '% ' + qLabel + '</td>' +
        '<td>' + onsetSlopeStr + '</td>' +
        '<td>' + skewStr + '</td>' +
        '<td>' + snrStr + '</td>' +
        '<td class="exclude-cell"><button class="btn-exclude" ' +
          'onclick="event.stopPropagation(); GSRUI.togglePeakExclusion(' + idx + ')" ' +
          'title="' + (p.excluded ? 'Include peak' : 'Exclude peak') + '">' +
          (p.excluded ? '<i class="fa-solid fa-plus"></i>' : '<i class="fa-solid fa-xmark"></i>') +
          '</button></td>' +
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
      normalizeZScore:   cc.normalizeZScore ? cc.normalizeZScore.checked : false,
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
    const params = GSRStorage.readGsrSliderValues();
    const gpsParams = GSRStorage.readGpsSliderValues();
    const csvContent = AppState.analyzer.exportToCSV(params, gpsParams);

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
      scale: window.devicePixelRatio || 1,
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
  },

  /**
   * Helper to refresh UI elements based on track enrichment state.
   */
  refreshOsmControls() {
    const isEnriched = (AppState.analyzer && AppState.analyzer.isEnriched);
    const select = document.getElementById('mapColoringMetric');
    const btnToggleOsmShapes = document.getElementById('btnToggleOsmShapes');
    const envPanel = document.getElementById('environmentalPanel');

    if (isEnriched) {
      // Enable OSM coloring options in map dropdown
      document.querySelectorAll('.osm-option').forEach(opt => opt.removeAttribute('disabled'));
      
      // Show vector geometry toggle if data is available
      if (AppState.analyzer.osmJson) {
        btnToggleOsmShapes.style.display = 'inline-block';
      } else {
        btnToggleOsmShapes.style.display = 'none';
        btnToggleOsmShapes.classList.remove('active');
        if (AppState.mapManager) AppState.mapManager.clearOsmShapes();
      }

      // Display Environmental analysis dashboard
      envPanel.style.display = 'block';
      
      if (AppState.analyzer.enrichmentRadius) {
        document.getElementById('osmRadius').value = AppState.analyzer.enrichmentRadius;
        document.getElementById('valOsmRadius').innerText = AppState.analyzer.enrichmentRadius + ' m';
      }

      // Update dashboard values
      GSRUI.updateEnvironmentalDashboard();
    } else {
      // Reset map coloring dropdown to GSR Arousal and disable OSM ones
      document.querySelectorAll('.osm-option').forEach(opt => opt.setAttribute('disabled', 'true'));
      if (select) select.value = 'gsr';
      if (AppState.mapManager) {
        AppState.mapManager.activeColoringMetric = 'gsr';
        AppState.mapManager.clearOsmShapes();
      }
      btnToggleOsmShapes.style.display = 'none';
      btnToggleOsmShapes.classList.remove('active');
      
      // Hide dashboard
      envPanel.style.display = 'none';
    }
  },

  /**
   * Orchestrates bounding box computation, Overpass fetching, and spatial enrichment.
   */
  async enrichTrack() {
    if (!AppState.analyzer || AppState.analyzer.raw.length === 0) {
      alert("Please load a track file first.");
      return;
    }
    
    const btn = document.getElementById('btnEnrichTrack');
    const statusContainer = document.getElementById('osmStatusContainer');
    const statusMsg = document.getElementById('osmStatusMessage');
    const progressBar = document.getElementById('osmProgressBar');
    
    const radius = parseInt(document.getElementById('osmRadius').value) || 50;
    const latency = parseFloat(document.getElementById('osmLatency').value) || 2.0;

    const originalText = btn.innerHTML;
    btn.setAttribute('disabled', 'true');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enriching...';
    
    statusContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.style.backgroundColor = '#ff7b00';
    
    const updateProgress = (msg, pct) => {
      statusMsg.innerText = msg;
      if (pct !== undefined) progressBar.style.width = pct + '%';
    };

    try {
      updateProgress('Calculating bounding box...', 10);
      const bbox = OSMEnricher.calculateBBox(AppState.analyzer.raw, radius + 50);
      if (!bbox) {
        throw new Error("Could not calculate bounding box. Track coordinates may be invalid.");
      }

      const area = OSMEnricher.calculateBBoxAreaKm2(bbox);
      if (area > 10.0) {
        throw new Error(`Track bounding box is too large (${area.toFixed(1)} km²). Maximum size is 10 km² to prevent API overload.`);
      }

      updateProgress('Fetching OpenStreetMap features...', 30);
      const osmJson = await OSMEnricher.fetchOSMData(bbox, (msg) => updateProgress(msg));
      
      AppState.analyzer.osmJson = osmJson; // save vector geometries
      
      updateProgress('Processing spatial metrics...', 60);
      OSMEnricher.enrichTrack(AppState.analyzer, osmJson, radius, (msg) => updateProgress(msg));
      
      updateProgress('Redrawing visualizer...', 90);
      
      // Update UI displays
      GSRUI.refreshOsmControls();
      GSRUI.rerenderMap();
      
      updateProgress('Enrichment complete!', 100);
      
      setTimeout(() => {
        statusContainer.style.display = 'none';
      }, 3000);

    } catch (err) {
      console.error(err);
      alert("OSM Enrichment failed: " + err.message);
      statusMsg.innerText = "Error: " + err.message;
      progressBar.style.backgroundColor = "var(--danger)";
    } finally {
      btn.removeAttribute('disabled');
      btn.innerHTML = originalText;
    }
  },

  /**
   * Helper mathematical routines for statistical correlations.
   */
  calculatePearsonCorrelation(x, y) {
    const n = x.length;
    if (n === 0) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 0 : num / den;
  },

  calculateLinearRegression(x, y) {
    const n = x.length;
    if (n === 0) return { m: 0, c: 0, r2: 0 };
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    
    const numM = n * sumXY - sumX * sumY;
    const denM = n * sumX2 - sumX * sumX;
    const m = denM === 0 ? 0 : numM / denM;
    const c = meanY - m * meanX;
    
    let ssTot = 0;
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const pred = m * x[i] + c;
      const dev = y[i] - meanY;
      const res = y[i] - pred;
      ssTot += dev * dev;
      ssRes += res * res;
    }
    const r2 = ssTot === 0 ? 1 : 1 - (ssRes / ssTot);
    
    return { m, c, r2 };
  },

  drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabel, yLabel) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (xVals.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data available', width / 2, height / 2);
      return;
    }

    const padL = 40;
    const padR = 15;
    const padT = 15;
    const padB = 30;

    let minX = Math.min(...xVals);
    let maxX = Math.max(...xVals);
    let minY = Math.min(...yVals);
    let maxY = Math.max(...yVals);

    if (maxX === minX) maxX = minX + 1;
    if (maxY === minY) maxY = minY + 1;
    
    const rangeX = maxX - minX;
    const rangeY = maxY - minY;

    // Draw grid bounds
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, height - padB);
    ctx.lineTo(width - padR, height - padB);
    ctx.stroke();

    const mapX = (x) => padL + ((x - minX) / rangeX) * (width - padL - padR);
    const mapY = (y) => height - padB - ((y - minY) / rangeY) * (height - padB - padT);

    // Draw coordinates as orange dots
    ctx.fillStyle = 'rgba(255, 123, 0, 0.4)';
    for (let i = 0; i < xVals.length; i++) {
      const cx = mapX(xVals[i]);
      const cy = mapY(yVals[i]);
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Draw Cyan trendline
    const x1 = minX;
    const y1 = m * x1 + c;
    const x2 = maxX;
    const y2 = m * x2 + c;

    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mapX(x1), mapY(y1));
    ctx.lineTo(mapX(x2), mapY(y2));
    ctx.stroke();

    // Text labels
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, padL + (width - padL - padR)/2, height - 6);

    ctx.save();
    ctx.translate(10, padT + (height - padT - padB)/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
    
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(minX.toFixed(1), padL, height - padB + 10);
    ctx.textAlign = 'right';
    ctx.fillText(maxX.toFixed(1), width - padR, height - padB + 10);

    ctx.textAlign = 'right';
    ctx.fillText(minY.toFixed(2), padL - 5, height - padB);
    ctx.fillText(maxY.toFixed(2), padL - 5, padT + 5);
  },

  /**
   * Recomputes the correlation dashboard metrics and draws graphs.
   */
  updateEnvironmentalDashboard() {
    if (!AppState.analyzer || !AppState.analyzer.isEnriched) return;

    // 1. Gather points from enabled enriched tracks
    const activeTracks = (AppState.viewMode === 'single') 
      ? [ { id: AppState.activeTrackId, analyzer: AppState.analyzer } ]
      : AppState.collectiveManager.getActiveTracks().filter(t => t.analyzer.isEnriched);

    const latency = parseFloat(document.getElementById('osmLatency').value) || 2.0;
    const allData = [];

    activeTracks.forEach(track => {
      const a = track.analyzer;
      if (!a || !a.isEnriched || a.raw.length === 0) return;
      
      let lastTime = -999;
      for (let i = 0; i < a.raw.length; i++) {
        const pt = a.raw[i];
        // Sample at 1 Hz intervals to maintain speed
        if (pt.time - lastTime >= 1.0) {
          const coords = a.getCoordinates(i);
          if (coords) {
            // Apply latency offset to locate coordinate context in the past
            const envIdx = a.findClosestIndex(Math.max(0, pt.time - latency));
            const envPt = (envIdx !== -1) ? a.raw[envIdx] : pt;

            allData.push({
              trackId: track.id,
              time: pt.time,
              val: pt.val,
              phasic: (a.phasic && a.phasic[i]) ? a.phasic[i].val : 0,
              tonic: (a.tonic && a.tonic[i]) ? a.tonic[i].val : 0,
              osm_road_class: envPt.osm_road_class,
              osm_dist_major_road: envPt.osm_dist_major_road,
              osm_in_park: envPt.osm_in_park,
              osm_green_pct_50m: envPt.osm_green_pct_50m,
              osm_building_density_50m: envPt.osm_building_density_50m,
              osm_dist_water: envPt.osm_dist_water,
              osm_tree_density_50m: envPt.osm_tree_density_50m,
              osm_amenity_count_50m: envPt.osm_amenity_count_50m
            });
            lastTime = pt.time;
          }
        }
      }
    });

    if (allData.length === 0) return;

    // ── Tab 1: Correlation Matrix ───────────────────────────────────────────
    const features = [
      { name: 'Green Space %', key: 'osm_green_pct_50m' },
      { name: 'Building Density', key: 'osm_building_density_50m' },
      { name: 'Distance to Major Road', key: 'osm_dist_major_road' },
      { name: 'Distance to Water', key: 'osm_dist_water' },
      { name: 'Tree Density', key: 'osm_tree_density_50m' },
      { name: 'Amenity Count', key: 'osm_amenity_count_50m' }
    ];

    const phasicVals = allData.map(d => d.phasic);
    const tonicVals = allData.map(d => d.tonic);
    
    // Estimate peaks count near each node
    // Peaks map: lookup counts of stress peaks within a 15-second window
    const peakCounts = [];
    activeTracks.forEach(track => {
      const a = track.analyzer;
      const peaks = a.peaks.filter(p => !p.excluded);
      allData.forEach(d => {
        if (d.trackId === track.id) {
          const count = peaks.filter(p => Math.abs(p.time - d.time) <= 15).length;
          peakCounts.push(count);
        }
      });
    });

    const tbody = document.querySelector('#correlationTable tbody');
    if (tbody) {
      tbody.innerHTML = '';
      features.forEach(f => {
        const xVals = allData.map(d => d[f.key]);
        
        const rPhasic = GSRUI.calculatePearsonCorrelation(xVals, phasicVals);
        const rTonic = GSRUI.calculatePearsonCorrelation(xVals, tonicVals);
        const rPeaks = GSRUI.calculatePearsonCorrelation(xVals, peakCounts);

        const getCorrClass = (r) => {
          if (r > 0.35) return 'corr-pos-strong';
          if (r > 0.15) return 'corr-pos-mod';
          if (r < -0.35) return 'corr-neg-strong';
          if (r < -0.15) return 'corr-neg-mod';
          return 'corr-weak';
        };

        const getInterpretation = (rPh, rTo) => {
          if (rPh > 0.25) return 'Correlates with physiological stress spikes (potential stressor)';
          if (rPh < -0.25) return 'Correlates with immediate stress reduction (restorative)';
          if (rTo < -0.25) return 'Associated with lower baseline tension (calming context)';
          if (rTo > 0.25) return 'Associated with higher baseline stress level';
          return 'Negligible direct impact on physiological arousal';
        };

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${f.name}</strong></td>
          <td class="${getCorrClass(rPhasic)}">${rPhasic.toFixed(3)}</td>
          <td class="${getCorrClass(rTonic)}">${rTonic.toFixed(3)}</td>
          <td class="${getCorrClass(rPeaks)}">${rPeaks.toFixed(3)}</td>
          <td>${getInterpretation(rPhasic, rTonic)}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    // ── Tab 2: Regression Plot ──────────────────────────────────────────────
    const scatterXMetric = document.getElementById('scatterEnvMetric').value;
    const scatterYMetric = document.getElementById('scatterBioMetric').value;
    const canvas = document.getElementById('regressionCanvas');
    
    if (canvas) {
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
      }
      const xVals = [];
      const yVals = [];
      allData.forEach(d => {
        const x = d[scatterXMetric];
        const y = scatterYMetric === 'phasic' ? d.phasic : d.tonic;
        if (x !== null && x !== undefined && !isNaN(x) && y !== null && y !== undefined && !isNaN(y)) {
          xVals.push(x);
          yVals.push(y);
        }
      });

      const { m, c, r2 } = GSRUI.calculateLinearRegression(xVals, yVals);
      
      const xLabels = {
        'osm_green_pct_50m': 'Green Space %',
        'osm_building_density_50m': 'Building Density',
        'osm_dist_major_road': 'Distance to Major Road (m)',
        'osm_dist_water': 'Distance to Water (m)',
        'osm_tree_density_50m': 'Tree Density',
        'osm_amenity_count_50m': 'Amenity Count'
      };
      
      const yLabels = {
        'phasic': 'Phasic GSR (uS)',
        'tonic': 'Tonic SCL (uS)'
      };

      document.getElementById('valFormula').innerText = `y = ${m.toFixed(4)}x + ${c.toFixed(4)}`;
      document.getElementById('valR2').innerText = r2.toFixed(3);

      GSRUI.drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabels[scatterXMetric], yLabels[scatterYMetric]);
    }

    // ── Tab 3: Roads Profile ────────────────────────────────────────────────
    // Group by roadClass
    const roadGroups = new Map();
    allData.forEach(d => {
      const cls = d.osm_road_class || 'none';
      if (!roadGroups.has(cls)) {
        roadGroups.set(cls, { count: 0, sumPhasic: 0, sumTonic: 0, peaks: 0 });
      }
      const g = roadGroups.get(cls);
      g.count++;
      g.sumPhasic += d.phasic;
      g.sumTonic += d.tonic;
    });

    // Match peak rates
    activeTracks.forEach(track => {
      const a = track.analyzer;
      const peaks = a.peaks.filter(p => !p.excluded);
      peaks.forEach(p => {
        // Find road class at peak time (latency-adjusted)
        const idx = a.findClosestIndex(Math.max(0, p.time - latency));
        const rc = (idx !== -1 && a.raw[idx].osm_road_class) ? a.raw[idx].osm_road_class : 'none';
        if (roadGroups.has(rc)) {
          roadGroups.get(rc).peaks++;
        }
      });
    });

    const roadBody = document.querySelector('#roadArousalTable tbody');
    const roadChart = document.getElementById('roadBarChartContainer');
    
    if (roadBody && roadChart) {
      roadBody.innerHTML = '';
      roadChart.innerHTML = '';

      const profiles = [];
      roadGroups.forEach((val, key) => {
        if (key === 'none' && val.count < 5) return; // skip unclassified background data if small
        profiles.push({
          name: key,
          timeSpent: val.count, // 1 Hz sample = 1 second
          meanPhasic: val.sumPhasic / val.count,
          meanTonic: val.sumTonic / val.count,
          peakRate: (val.peaks / (val.count / 60)) // peaks per minute
        });
      });

      // Sort by mean Phasic stress levels descending
      profiles.sort((a, b) => b.meanPhasic - a.meanPhasic);

      const maxPhasicVal = profiles.length > 0 ? Math.max(...profiles.map(p => p.meanPhasic)) : 1.0;

      profiles.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span style="font-family: monospace; font-size: 0.8rem;">${p.name}</span></td>
          <td>${p.timeSpent} s</td>
          <td>${p.meanPhasic.toFixed(3)} μS</td>
          <td>${p.meanTonic.toFixed(3)} μS</td>
          <td>${p.peakRate.toFixed(2)}</td>
        `;
        roadBody.appendChild(tr);

        // Draw horizontal CSS bar in bar chart container
        const barRow = document.createElement('div');
        barRow.className = 'road-bar-row';
        const percent = maxPhasicVal > 0 ? (p.meanPhasic / maxPhasicVal) * 100 : 0;
        barRow.innerHTML = `
          <div class="road-bar-label" title="${p.name}">${p.name}</div>
          <div class="road-bar-track">
            <div class="road-bar-fill" style="width: ${percent}%;"></div>
          </div>
          <div class="road-bar-val">${p.meanPhasic.toFixed(3)} μS</div>
        `;
        roadChart.appendChild(barRow);
      });
      
      if (profiles.length === 0) {
        roadBody.innerHTML = '<tr><td colspan="5" class="empty-row">No road profile data found. Enriched track has missing classes.</td></tr>';
      }
    }
  }
};
