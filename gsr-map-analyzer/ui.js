/**
 * UI Actions — analysis pipeline, map rendering, stats, exports, fullscreen.
 * Event binding and DOM caching live in events.js.
 * Track library CRUD lives in tracks.js.
 * All shared state is accessed through AppState.
 */

const GSRUI = {

  /**
   * Invalidate cached environmental dashboard stats.
   */
  invalidateEnvironmentalCache() {
    if (AppState.analyzer) {
      AppState.analyzer._cachedEnvStats = null;
    }
    if (AppState.collectiveManager) {
      AppState.collectiveManager._cachedEnvStats = null;
    }
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
    GSRUI.invalidateEnvironmentalCache();
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
   * Handle real-time typing in label fields, updating the graph in real-time
   * without destroying/recreating the active Leaflet map popups.
   */
  handleLiveLabelInput(idx, value, trackId) {
    let peaksArr = GSRUI._getPeaksArray(trackId);
    if (!peaksArr || idx >= peaksArr.length) return;
    
    // Update in-memory model (avoid trim during typing to allow trailing spaces)
    peaksArr[idx].label = value;

    // 1. Sync table input if it exists and is not the active typing element
    const tableInput = document.querySelector(`.peak-label-input[data-peak-idx="${idx}"]`);
    if (tableInput && tableInput.value !== value) {
      tableInput.value = value;
      tableInput.style.height = 'auto';
      tableInput.style.height = tableInput.scrollHeight + 'px';
    }

    // 2. Sync map popup input if it exists and is not the active typing element
    const mapInput = document.querySelector('.peak-popup-label-input');
    if (mapInput && mapInput.value !== value) {
      mapInput.value = value;
      mapInput.style.height = 'auto';
      mapInput.style.height = mapInput.scrollHeight + 'px';
    }

    // 3. Immediately redraw p5.js graph to show the label text updating
    redraw();
  },

  /**
   * Zoom and highlight a specific peak event when user clicks a row in the peaks table.
   */
  focusOnPeak(idx, source) {
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

    const hasGps = AppState.analyzer.raw && AppState.analyzer.raw.some(d => d.hasGps);

    // 1. Expand relevant panels dynamically
    if (source === 'map') {
      const eventsPanel = document.getElementById('eventsPanel');
      if (eventsPanel && eventsPanel.classList.contains('collapsed')) {
        eventsPanel.classList.remove('collapsed');
      }
    } else if (hasGps) {
      const mapPanel = document.getElementById('mapPanel');
      if (mapPanel && mapPanel.classList.contains('collapsed')) {
        mapPanel.classList.remove('collapsed');
      }
    }

    // 2. Smoothly scroll table row into view if not clicked from table itself
    if (source !== 'table' && row) {
      setTimeout(() => {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, source === 'map' ? 100 : 0);
    }

    // 3. Open map marker popup if not clicked from map marker itself and track has GPS
    if (source !== 'map' && hasGps) {
      if (AppState.mapManager && AppState.mapManager.peakMarkers && AppState.mapManager.peakMarkers[idx]) {
        setTimeout(() => {
          if (AppState.mapManager.peakMarkers[idx]) {
            AppState.mapManager.peakMarkers[idx].openPopup();
          }
        }, 100);
      }
    }
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
    GSRUI.invalidateEnvironmentalCache();
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

      if (AppState.viewMode === 'single') {
        GSRTrackManager.saveActiveTrackParams();
        AppState.analyzer.analyze(params);
        GSRUI.invalidateEnvironmentalCache();
        if (AppState.mapManager) {
          AppState.mapManager.renderData(AppState.analyzer, GSRStorage.buildGpsParams());
        }
      } else {
        if (AppState.collectiveManager) {
          const activeTracks = AppState.collectiveManager.getActiveTracks();
          activeTracks.forEach(track => {
            track.analyzer.analyze(params);
            track.filterParams = { ...params };
          });
        }
        GSRUI.invalidateEnvironmentalCache();
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

      rowsHtml += '<tr id="peakRow-' + idx + '" ' + rowAttr + ' onclick="GSRUI.focusOnPeak(' + idx + ', \'table\')">' +
        '<td>' + (idx + 1) + '</td>' +
        '<td class="label-cell">' +
          '<textarea class="peak-label-input" rows="1" ' +
            'placeholder="Add label…" data-peak-idx="' + idx + '" ' +
            'onclick="event.stopPropagation();" ' +
            'oninput="GSRUI.handleLiveLabelInput(' + idx + ', this.value); this.style.height=\'auto\'; this.style.height=this.scrollHeight+\'px\';" ' +
            'onchange="GSRUI.updatePeakLabel(' + idx + ', this.value)" ' +
            'onkeydown="if(event.key===\'Enter\') { event.preventDefault(); GSRUI.updatePeakLabel(' + idx + ', this.value); this.blur(); }">' +
            escapedLabel +
          '</textarea>' +
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
        '<td><button class="btn-table-action" onclick="event.stopPropagation(); GSRUI.focusOnPeak(' + idx + ', \'table\')">' +
        '<i class="fa-solid fa-arrows-to-eye"></i> View</button></td></tr>';
    });

    tb.innerHTML = rowsHtml;

    // Auto-size all rendered textareas
    setTimeout(() => {
      tb.querySelectorAll('.peak-label-input').forEach(ta => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });
    }, 0);
  },

  /**
   * Render all active tracks on the collective map with contour lines.
   * Debounced at 150 ms to avoid redundant recalculation during slider drag.
   */
  updateCollectiveMap() {
    if (!AppState.mapManager) return;

    // Debounce: coalesce rapid calls (slider drag, multiple track toggles)
    if (this._collectiveDebounceId) {
      clearTimeout(this._collectiveDebounceId);
    }
    this._collectiveDebounceId = setTimeout(() => {
      this._collectiveDebounceId = null;
      this._updateCollectiveMapNow();
    }, 150);
  },

  _updateCollectiveMapNow() {
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
    const isSingleEnriched = AppState.analyzer && AppState.analyzer.isEnriched;
    const anyCollectiveEnriched = (AppState.viewMode === 'collective')
      && AppState.collectiveManager.getActiveTracks().some(t => t.analyzer && t.analyzer.isEnriched);
    const isEnriched = isSingleEnriched || anyCollectiveEnriched;
    const select = document.getElementById('mapColoringMetric');
    const btnToggleOsmShapes = document.getElementById('btnToggleOsmShapes');
    const envPanel = document.getElementById('environmentalPanel');

    if (isEnriched) {
      // Enable OSM coloring options in map dropdown
      document.querySelectorAll('.osm-option').forEach(opt => opt.removeAttribute('disabled'));
      
      // Show vector geometry toggle if cached geometries are available
      if (AppState.analyzer.osmGeoms) {
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
  async enrichTrack(forceFetch = false) {
    if (!AppState.analyzer || AppState.analyzer.raw.length === 0) {
      alert("Please load a track file first.");
      return;
    }

    const radius = parseInt(document.getElementById('osmRadius').value) || 50;
    const snapRadius  = parseInt(document.getElementById('gpsSnapRadius')?.value) || 25;
    const maxRadius   = Math.max(radius, snapRadius);
    const bbox = OSMEnricher.calculateBBox(AppState.analyzer.raw, maxRadius + 50);
    if (!bbox) {
      throw new Error("Could not calculate bounding box. Track coordinates may be invalid.");
    }

    const area = OSMEnricher.calculateBBoxAreaKm2(bbox);
    if (area > 10.0) {
      throw new Error(`Track bounding box is too large (${area.toFixed(1)} km²). Maximum size is 10 km² to prevent API overload.`);
    }

    let osmJson = AppState.analyzer.osmJson;
    const isLocal = !forceFetch && osmJson;

    if (isLocal) {
      // Silent instant local run — re-use cached OSM data, no fetch
      try {
        const snapEnabled = document.getElementById('gpsSnapToRoads')?.checked ?? true;
        const snapIn = Math.max(8, Math.round(snapRadius / 2));
        OSMEnricher.enrichTrack(AppState.analyzer, osmJson, radius,
          { enabled: snapEnabled, radiusIn: snapIn, radiusOut: snapRadius }
        );
        GSRUI.invalidateEnvironmentalCache();
        GSRUI.refreshOsmControls();
        GSRUI.rerenderMap();
      } catch (err) {
        console.error('Local enrichment failed:', err);
        // If local run fails, fall through to full network fetch
        AppState.analyzer.osmJson = null;
      }
      if (AppState.analyzer.osmJson) return;  // success — done
      // Fall through to network fetch below
    }

    // Prevent re-entrant network calls
    if (GSRUI._enriching) return;
    GSRUI._enriching = true;
    
    const btn = document.getElementById('btnEnrichTrack');
    const statusContainer = document.getElementById('osmStatusContainer');
    const statusMsg = document.getElementById('osmStatusMessage');
    const progressBar = document.getElementById('osmProgressBar');
    
    if (!btn || !statusContainer || !statusMsg || !progressBar) {
      GSRUI._enriching = false;
      return;
    }

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
      updateProgress('Fetching OpenStreetMap features...', 30);
      osmJson = await OSMEnricher.fetchOSMData(bbox, (msg) => updateProgress(msg));
      AppState.analyzer.osmJson = osmJson; // save vector geometries
      
      updateProgress('Processing spatial metrics...', 60);
      const snapEnabled = document.getElementById('gpsSnapToRoads')?.checked ?? true;
      const snapIn = Math.max(8, Math.round(snapRadius / 2));
      OSMEnricher.enrichTrack(AppState.analyzer, osmJson, radius,
        { enabled: snapEnabled, radiusIn: snapIn, radiusOut: snapRadius },
        (msg) => updateProgress(msg));
      GSRUI.invalidateEnvironmentalCache();
      
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
      GSRUI._enriching = false;
    }
  },

  /**
   * Helper mathematical routines for statistical correlations.
   */


  drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabel, yLabel) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (xVals.length === 0) {
      ctx.fillStyle = '#888888';
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

    // Draw axis frame
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, height - padB);
    ctx.lineTo(width - padR, height - padB);
    ctx.stroke();

    const mapX = (x) => padL + ((x - minX) / rangeX) * (width - padL - padR);
    const mapY = (y) => height - padB - ((y - minY) / rangeY) * (height - padB - padT);

    // Draw coordinates as orange dots
    ctx.fillStyle = 'rgba(255, 123, 0, 0.6)';
    for (let i = 0; i < xVals.length; i++) {
      const cx = mapX(xVals[i]);
      const cy = mapY(yVals[i]);
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Draw trendline (dark blue for contrast on white)
    const x1 = minX;
    const y1 = m * x1 + c;
    const x2 = maxX;
    const y2 = m * x2 + c;

    ctx.strokeStyle = '#0055cc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mapX(x1), mapY(y1));
    ctx.lineTo(mapX(x2), mapY(y2));
    ctx.stroke();

    // Text labels
    ctx.fillStyle = '#333333';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, padL + (width - padL - padR)/2, height - 6);

    ctx.save();
    ctx.translate(10, padT + (height - padT - padB)/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
    
    ctx.fillStyle = '#555555';
    ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(minX.toFixed(1), padL, height - padB + 10);
    ctx.textAlign = 'right';
    ctx.fillText(maxX.toFixed(1), width - padR, height - padB + 10);

    ctx.textAlign = 'right';
    ctx.fillText(minY.toFixed(2), padL - 5, height - padB);
    ctx.fillText(maxY.toFixed(2), padL - 5, padT + 5);

    // R² badge in top-right corner
    ctx.fillStyle = '#0055cc';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'right';
    const r2Text = 'R² = ' + r2.toFixed(3);
    const r2Width = ctx.measureText(r2Text).width;
    // Draw background box
    ctx.fillStyle = 'rgba(0, 85, 204, 0.08)';
    ctx.fillRect(width - padR - r2Width - 10, padT + 2, r2Width + 14, 18);
    ctx.strokeStyle = 'rgba(0, 85, 204, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(width - padR - r2Width - 10, padT + 2, r2Width + 14, 18);
    // Draw text
    ctx.fillStyle = '#0055cc';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(r2Text, width - padR - 3, padT + 15);
  },

  updateEnvironmentalDashboard() {
    // Resolve tracks to aggregate
    const activeTracks = (AppState.viewMode === 'single') 
      ? (AppState.analyzer && AppState.analyzer.isEnriched
          ? [ { id: AppState.activeTrackId, analyzer: AppState.analyzer } ]
          : [])
      : AppState.collectiveManager.getActiveTracks().filter(t => t.analyzer && t.analyzer.isEnriched);

    if (activeTracks.length === 0) return;

    const latency = parseFloat(document.getElementById('gpsPeakLatency').value) || 2.0;
    const trackIdsStr = activeTracks.map(t => t.id).join(',');

    // Use a shared cache location: in single mode, store on the analyzer;
    // in collective mode, store on the collective manager (avoids losing cache when switching active track)
    const cacheTarget = (AppState.viewMode === 'single') ? AppState.analyzer : AppState.collectiveManager;
    const cache = cacheTarget._cachedEnvStats;
    const needsRecalc = !cache || 
                      cache.latency !== latency || 
                      cache.trackCount !== activeTracks.length ||
                      cache.trackIds !== trackIdsStr;

    if (needsRecalc) {
      const allData = [];
      activeTracks.forEach(track => {
        const a = track.analyzer;
        if (!a || !a.isEnriched || a.raw.length === 0) return;
        
        let lastTime = -999;
        for (let i = 0; i < a.raw.length; i++) {
          const pt = a.raw[i];
          // Sample at 1 Hz intervals to avoid lag
          if (pt.time - lastTime >= 1.0) {
            const coords = a.getCoordinates(i);
            if (coords) {
              // Apply latency offset to find historical spatial context
              const envIdx = a.findClosestIndex(Math.max(0, pt.time - latency));
              const envPt = (envIdx !== -1) ? a.raw[envIdx] : pt;

              // Aggregate GSR values over the 1-second window (10 samples at 10 Hz) to capture peak amplitudes correctly
              const windowStartIdx = Math.max(0, i - 9);
              let sumVal = 0;
              let sumTonic = 0;
              let maxPhasic = 0;
              let count = 0;
              for (let j = windowStartIdx; j <= i; j++) {
                if (a.raw[j]) {
                  sumVal += a.raw[j].val || 0;
                  if (a.tonic && a.tonic[j]) {
                    sumTonic += a.tonic[j].val || 0;
                  }
                  if (a.phasic && a.phasic[j]) {
                    maxPhasic = Math.max(maxPhasic, a.phasic[j].val || 0);
                  }
                  count++;
                }
              }
              const avgVal = count > 0 ? sumVal / count : pt.val;
              const avgTonic = (count > 0 && a.tonic) ? sumTonic / count : 0;
              const finalPhasic = a.phasic ? maxPhasic : 0;

              allData.push({
                trackId: track.id,
                time: pt.time,
                val: avgVal,
                phasic: finalPhasic,
                tonic: avgTonic,
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

      // Calculate Pearson correlation matrix rows
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
      
      const peakCounts = [];
      activeTracks.forEach(track => {
        const a = track.analyzer;
        const peaks = a.peaks.filter(p => !p.excluded);
        // Bin peaks into non-overlapping 15-second windows to avoid double-counting
        const peakBinMap = new Map();
        peaks.forEach(p => {
          const bin = Math.floor(p.time / 15);
          peakBinMap.set(bin, (peakBinMap.get(bin) || 0) + 1);
        });
        allData.forEach(d => {
          if (d.trackId === track.id) {
            const bin = Math.floor(d.time / 15);
            peakCounts.push(peakBinMap.get(bin) || 0);
          }
        });
      });

      const correlationMatrix = features.map(f => {
        const validX = [];
        const validPhasic = [];
        const validTonic = [];
        const validPeaks = [];
        
        for (let i = 0; i < allData.length; i++) {
          const x = allData[i][f.key];
          // Exclude arbitrary 999.0 fallback indicator representing out-of-bounds / infinite distance
          if (x !== null && x !== undefined && !isNaN(x) && x !== 999.0) {
            validX.push(x);
            validPhasic.push(allData[i].phasic);
            validTonic.push(allData[i].tonic);
            validPeaks.push(peakCounts[i] || 0);
          }
        }

        const rpPhasic = StatsMath.calculatePearsonCorrelation(validX, validPhasic);
        const rpTonic = StatsMath.calculatePearsonCorrelation(validX, validTonic);
        const rpPeaks = StatsMath.calculatePearsonCorrelation(validX, validPeaks);
        const hasVariance = validX.length > 1 && new Set(validX).size > 1;
        return { name: f.name, key: f.key, n: validX.length, hasVariance,
                 rPhasic: rpPhasic.r, rTonic: rpTonic.r, rPeaks: rpPeaks.r,
                 pPhasic: rpPhasic.p, pTonic: rpTonic.p, pPeaks: rpPeaks.p };
      });

      // Calculate Road profiles (with std dev and 95% CI)
      const roadGroups = new Map();
      allData.forEach(d => {
        const cls = d.osm_road_class || 'none';
        if (!roadGroups.has(cls)) {
          roadGroups.set(cls, { phasicVals: [], tonicVals: [], peaks: 0 });
        }
        const g = roadGroups.get(cls);
        g.phasicVals.push(d.phasic);
        g.tonicVals.push(d.tonic);
      });

      activeTracks.forEach(track => {
        const a = track.analyzer;
        const peaks = a.peaks.filter(p => !p.excluded);
        peaks.forEach(p => {
          const idx = a.findClosestIndex(Math.max(0, p.time - latency));
          const rc = (idx !== -1 && a.raw[idx].osm_road_class) ? a.raw[idx].osm_road_class : 'none';
          if (roadGroups.has(rc)) {
            roadGroups.get(rc).peaks++;
          }
        });
      });

      const roadProfile = [];
      roadGroups.forEach((val, key) => {
        if (key === 'none' && val.phasicVals.length < 5) return;
        const n = val.phasicVals.length;
        const meanPhasic = val.phasicVals.reduce((s, v) => s + v, 0) / n;
        const meanTonic = val.tonicVals.reduce((s, v) => s + v, 0) / n;
        const stdPhasic = Math.sqrt(val.phasicVals.reduce((s, v) => s + (v - meanPhasic) ** 2, 0) / n);
        const stdTonic = Math.sqrt(val.tonicVals.reduce((s, v) => s + (v - meanTonic) ** 2, 0) / n);
        const ciPhasic = n > 1 ? 1.96 * stdPhasic / Math.sqrt(n) : 0;
        const ciTonic = n > 1 ? 1.96 * stdTonic / Math.sqrt(n) : 0;
        roadProfile.push({
          name: key,
          timeSpent: n,
          meanPhasic,
          meanTonic,
          stdPhasic,
          stdTonic,
          ciPhasic,
          ciTonic,
          peakRate: (val.peaks / (n / 60))
        });
      });
      roadProfile.sort((a, b) => b.meanPhasic - a.meanPhasic);

      // Save to client-side cache
      cacheTarget._cachedEnvStats = {
        latency,
        trackCount: activeTracks.length,
        trackIds: trackIdsStr,
        allData,
        correlationMatrix,
        roadProfile
      };
    }

    // ── Render Components using Cached Data ─────────────────────────────────
    const cachedStats = cacheTarget._cachedEnvStats;

    // 1. Render Correlation Matrix
    GSRUI.renderCorrelationTable(cachedStats.correlationMatrix);

    // 2. Draw Regression Plot
    GSRUI.drawRegressionScatterPlot(cachedStats.allData);

    // 3. Render Roads Profile
    GSRUI.renderRoadProfile(cachedStats.roadProfile);
  },

  /**
   * Render cached Pearson correlation matrix to HTML.
   */
  renderCorrelationTable(matrix) {
    const tbody = document.querySelector('#correlationTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const getCorrClass = (r) => {
      if (r > 0.35) return 'corr-pos-strong';
      if (r > 0.15) return 'corr-pos-mod';
      if (r < -0.35) return 'corr-neg-strong';
      if (r < -0.15) return 'corr-neg-mod';
      return 'corr-weak';
    };

    const formatP = (p) => {
      if (p < 0.001) return '<0.001';
      if (p < 0.01) return p.toFixed(4);
      return p.toFixed(3);
    };

    const getSigStars = (p) => {
      if (p < 0.001) return '***';
      if (p < 0.01) return '**';
      if (p < 0.05) return '*';
      return '';
    };

    const getInterpretation = (row) => {
      const rPh = row.rPhasic, rTo = row.rTonic, pPh = row.pPhasic, pTo = row.pTonic;
      if (!row.hasVariance) return 'Not enough variation to measure — same value at every point on this route';
      if (pPh >= 0.05 && pTo >= 0.05) return 'No detectable link to arousal — likely random variation';
      if (rPh > 0.25 && pPh < 0.05) return 'Higher momentary arousal (potential stressor)';
      if (rPh < -0.25 && pPh < 0.05) return 'Lower momentary arousal (potential restorative effect)';
      if (rTo < -0.25 && pTo < 0.05) return 'Lower baseline arousal (calming context)';
      if (rTo > 0.25 && pTo < 0.05) return 'Higher baseline arousal (activating context)';
      return 'Weak but statistically reliable — too small to be practically meaningful';
    };

    matrix.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${row.name}</strong></td>
        <td class="${getCorrClass(row.rPhasic)}">${row.rPhasic.toFixed(3)}${getSigStars(row.pPhasic)}</td>
        <td class="${getCorrClass(row.rTonic)}">${row.rTonic.toFixed(3)}${getSigStars(row.pTonic)}</td>
        <td class="${getCorrClass(row.rPeaks)}">${row.rPeaks.toFixed(3)}${getSigStars(row.pPeaks)}</td>
        <td>${formatP(row.pPhasic)}</td>
        <td>${formatP(row.pTonic)}</td>
        <td>${getInterpretation(row)}</td>
      `;
      tbody.appendChild(tr);
    });
  },

  /**
   * Render cached road profile stats to HTML.
   */
  renderRoadProfile(profile) {
    const roadBody = document.querySelector('#roadArousalTable tbody');
    const roadChart = document.getElementById('roadBarChartContainer');
    if (!roadBody || !roadChart) return;

    roadBody.innerHTML = '';
    roadChart.innerHTML = '';

    const maxPhasicVal = profile.length > 0 ? Math.max(...profile.map(p => p.meanPhasic)) : 1.0;

    profile.forEach(p => {
      const fmt = (v) => v.toFixed(3);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span style="font-family: monospace; font-size: 0.8rem;">${p.name}</span></td>
        <td>${p.timeSpent} s</td>
        <td>${fmt(p.meanPhasic)} μS</td>
        <td>${fmt(p.stdPhasic)} μS</td>
        <td>± ${fmt(p.ciPhasic)} μS</td>
        <td>${fmt(p.meanTonic)} μS</td>
        <td>± ${fmt(p.ciTonic)} μS</td>
        <td>${p.peakRate.toFixed(2)}</td>
      `;
      roadBody.appendChild(tr);

      const barRow = document.createElement('div');
      barRow.className = 'road-bar-row';
      const percent = maxPhasicVal > 0 ? (p.meanPhasic / maxPhasicVal) * 100 : 0;
      barRow.innerHTML = `
        <div class="road-bar-label" title="${p.name}">${p.name}</div>
        <div class="road-bar-track">
          <div class="road-bar-fill" style="width: ${percent}%;"></div>
        </div>
        <div class="road-bar-val">${fmt(p.meanPhasic)} μS</div>
      `;
      roadChart.appendChild(barRow);
    });
    
    // ── Dynamic interpretation of actual data ───────────────────────────
    const interpretEl = document.getElementById('roadInterpretationText');
    if (interpretEl && profile.length > 0) {
      const sorted = [...profile].sort((a, b) => b.meanPhasic - a.meanPhasic);
      const highest = sorted[0];
      const lowest = sorted[sorted.length - 1];

      // Identify small-sample roads (wide CI = unreliable)
      const unreliable = profile.filter(p => p.ciPhasic > p.meanPhasic * 0.5);
      const reliable = profile.filter(p => p.ciPhasic <= p.meanPhasic * 0.3);

      // Check CI overlap between highest and lowest
      const hiLowOverlap = (highest.meanPhasic - highest.ciPhasic) <= (lowest.meanPhasic + lowest.ciPhasic);

      const lines = [];

      // Main comparison
      if (highest !== lowest) {
        const diff = ((highest.meanPhasic - lowest.meanPhasic) / lowest.meanPhasic * 100);
        lines.push(`Your strongest arousal was on <strong>${highest.name}</strong> roads (${highest.meanPhasic.toFixed(3)} μS), ` +
          `which is <strong>${Math.abs(diff).toFixed(0)}% ${diff > 0 ? 'higher' : 'lower'}</strong> ` +
          `than ${lowest.name} roads (${lowest.meanPhasic.toFixed(3)} μS).`);
      }

      // CI overlap assessment
      if (hiLowOverlap) {
        lines.push(`However, the confidence intervals <strong>overlap</strong> — this difference may not be statistically reliable.`);
      } else {
        lines.push(`The confidence intervals <strong>do not overlap</strong>, suggesting this is a genuine physiological difference.`);
      }

      // Reliability notes
      if (unreliable.length > 0) {
        lines.push(`⚠️ <strong>Low confidence:</strong> ${unreliable.map(p =>
          `${p.name} (only ${p.timeSpent}s, CI ±${p.ciPhasic.toFixed(3)})`
        ).join(', ')} — treat these numbers as rough estimates.`);
      }
      if (reliable.length > 0) {
        const best = reliable.sort((a, b) => b.timeSpent - a.timeSpent)[0];
        lines.push(`✅ <strong>Most reliable:</strong> ${best.name} roads (${best.timeSpent}s of data, CI ±${best.ciPhasic.toFixed(3)}) — the most trustworthy comparison point.`);
      }

      // Consistency notes
      const highVar = profile.filter(p => p.stdPhasic > p.meanPhasic * 0.8);
      const lowVar = profile.filter(p => p.stdPhasic < p.meanPhasic * 0.3 && p.timeSpent > 30);
      if (highVar.length > 0) {
        lines.push(`${highVar.map(p =>
          `<strong>${p.name}</strong> has high variability (Std Dev ${p.stdPhasic.toFixed(3)} μS) — ` +
          `some parts were very calm, others very reactive.`
        ).join(' ')}`);
      }
      if (lowVar.length > 0) {
        lines.push(`${lowVar.map(p =>
          `<strong>${p.name}</strong> is very consistent (Std Dev ${p.stdPhasic.toFixed(3)} μS) — ` +
          `your arousal stayed steady throughout.`
        ).join(' ')}`);
      }

      interpretEl.innerHTML = lines.join('</p><p style="margin: 4px 0 0 0;">');
    } else if (interpretEl) {
      interpretEl.textContent = 'No road profile data to interpret.';
    }

    if (profile.length === 0) {
      roadBody.innerHTML = '<tr><td colspan="8" class="empty-row">No road profile data found. Enriched track has missing classes.</td></tr>';
    }
  },

  /**
   * Dynamically resizes the canvas drawing buffer and draws the regression scatter plot.
   */
  drawRegressionScatterPlot(allData) {
    const canvas = document.getElementById('regressionCanvas');
    if (!canvas) return;

    // Rescale drawing buffer to match CSS size pixel-for-pixel
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }

    const scatterXMetric = document.getElementById('scatterEnvMetric').value;
    const scatterYMetric = document.getElementById('scatterBioMetric').value;

    const xVals = [];
    const yVals = [];
    
    // Resolve data source: direct arg, single-track cache, or collective cache
    let dataSrc = allData;
    if (!dataSrc) {
      if (AppState.analyzer && AppState.analyzer._cachedEnvStats) {
        dataSrc = AppState.analyzer._cachedEnvStats.allData;
      } else if (AppState.collectiveManager && AppState.collectiveManager._cachedEnvStats) {
        dataSrc = AppState.collectiveManager._cachedEnvStats.allData;
      } else {
        dataSrc = [];
      }
    }
    dataSrc.forEach(d => {
      const x = d[scatterXMetric];
      const y = scatterYMetric === 'phasic' ? d.phasic : d.tonic;
      // Exclude arbitrary 999.0 fallback indicator representing out-of-bounds / infinite distance
      if (x !== null && x !== undefined && !isNaN(x) && x !== 999.0 && y !== null && y !== undefined && !isNaN(y)) {
        xVals.push(x);
        yVals.push(y);
      }
    });

    const { m, c, r2 } = StatsMath.calculateLinearRegression(xVals, yVals);
    
    const xLabels = {
      'osm_green_pct_50m': 'Green Space %',
      'osm_building_density_50m': 'Building Density',
      'osm_dist_major_road': 'Distance to Major Road (m)',
      'osm_dist_water': 'Distance to Water (m)',
      'osm_tree_density_50m': 'Tree Density',
      'osm_amenity_count_50m': 'Amenity Count'
    };
    
    const yLabels = {
      'phasic': 'Phasic (momentary arousal)',
      'tonic': 'Tonic (baseline arousal)'
    };

    GSRUI.drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabels[scatterXMetric], yLabels[scatterYMetric]);
  },

  /**
   * Open the street-level imagery modal overlay at the given coordinates.
   * Shows Mapillary by default; Google Street View embed if API key is set.
   */
  openStreetView(lat, lon, label) {
    const modal = document.getElementById('streetviewModal');
    const mapillaryIframe = document.getElementById('svIframe');
    const googleIframe = document.getElementById('svGoogleIframe');
    const googleLink = document.getElementById('svGoogleLink');
    const mapillaryExtLink = document.getElementById('svMapillaryExtLink');
    const coordsEl = document.getElementById('svModalCoords');
    const titleEl = document.getElementById('streetviewModalTitle');

    if (!modal || !mapillaryIframe) return;

    // Store coords for tab switching
    this._svLat = lat;
    this._svLon = lon;

    titleEl.textContent = label ? 'Street-Level View — ' + label : 'Street-Level View';
    coordsEl.textContent = lat.toFixed(5) + ', ' + lon.toFixed(5);

    // Set Mapillary embed URL
    mapillaryIframe.src = 'https://www.mapillary.com/embed?lat=' + lat + '&lng=' + lon + '&z=18';

    // Set Google Maps external link (fallback)
    googleLink.href = 'https://www.google.com/maps?layer=c&cbll=' + lat + ',' + lon;

    // Set Mapillary external link
    mapillaryExtLink.href = 'https://www.mapillary.com/app/?lat=' + lat + '&lng=' + lon + '&z=18';

    // Reset Google iframe
    if (googleIframe) googleIframe.src = '';

    // Start on Google tab (left)
    GSRUI.switchStreetViewTab('google');

    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Restore saved API key into input field
    const keyInput = document.getElementById('svApiKeyInput');
    const savedKey = localStorage.getItem('bioMappingGoogleMapsKey');
    if (keyInput && savedKey) {
      keyInput.value = savedKey;
    }
  },

  /**
   * Close the street-level imagery modal overlay.
   * If event is provided (click on overlay background), only close if clicking the backdrop.
   */
  closeStreetViewModal(event) {
    if (event && event.target !== document.getElementById('streetviewModal')) return;
    const modal = document.getElementById('streetviewModal');
    const mapillaryIframe = document.getElementById('svIframe');
    const googleIframe = document.getElementById('svGoogleIframe');
    if (modal) modal.style.display = 'none';
    if (mapillaryIframe) mapillaryIframe.src = '';
    if (googleIframe) googleIframe.src = '';
    this._svLat = null;
    this._svLon = null;
    document.body.style.overflow = '';
  },

  /**
   * Switch between Mapillary (embedded) and Google Street View tabs.
   * If a Google Maps API key is saved, embeds Street View via the free Maps Embed API.
   */
  switchStreetViewTab(tab) {
    const mapillaryTab = document.getElementById('svTabMapillary');
    const googleTab = document.getElementById('svTabGoogle');
    const iframeContainer = document.getElementById('svIframeContainer');
    const googleContainer = document.getElementById('svGoogleContainer');
    const googleIframeContainer = document.getElementById('svGoogleIframeContainer');
    const googleIframe = document.getElementById('svGoogleIframe');
    const googleFallback = document.getElementById('svGoogleFallback');

    mapillaryTab.classList.toggle('active', tab === 'mapillary');
    googleTab.classList.toggle('active', tab === 'google');
    iframeContainer.style.display = tab === 'mapillary' ? '' : 'none';
    googleContainer.style.display = tab === 'google' ? '' : 'none';

    if (tab === 'google' && this._svLat != null && this._svLon != null) {
      const apiKey = localStorage.getItem('bioMappingGoogleMapsKey');
      if (apiKey) {
        googleIframeContainer.style.display = '';
        googleFallback.style.display = 'none';
        const embedUrl = 'https://www.google.com/maps/embed/v1/streetview?key=' + encodeURIComponent(apiKey)
          + '&location=' + this._svLat + ',' + this._svLon + '&heading=0&pitch=0&fov=90';
        googleIframe.src = embedUrl;
      } else {
        googleIframeContainer.style.display = 'none';
        googleFallback.style.display = '';
        googleIframe.src = '';
      }
    }
  },

  /**
   * Save the Google Maps API key from the input field to localStorage.
   */
  saveGoogleMapsKey() {
    const input = document.getElementById('svApiKeyInput');
    const msg = document.getElementById('svKeySavedMsg');
    if (!input) return;
    const key = input.value.trim();
    if (key) {
      localStorage.setItem('bioMappingGoogleMapsKey', key);
      if (msg) {
        msg.style.display = '';
        setTimeout(function() { msg.style.display = 'none'; }, 3000);
      }
    }
  }
};
