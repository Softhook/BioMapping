/**
 * UI Actions — analysis pipeline, map rendering, stats, exports, fullscreen.
 * Event binding and DOM caching live in events.js.
 * Track library CRUD lives in tracks.js.
 * All shared state is accessed through AppState.
 */

const GSRUI = {

  _resolveTrackAndAnalyzer(trackId) {
    let track = null;
    let analyzer = null;
    if (trackId) {
      track = AppState.collectiveManager.getTrack(trackId);
      if (track) analyzer = track.analyzer;
    } else {
      analyzer = AppState.analyzer;
      if (AppState.activeTrackId) {
        track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
      }
    }
    return { track, analyzer };
  },

  _markUnsavedLabels(track) {
    if (track) {
      track.hasUnsavedLabels = true;
    } else if (AppState.activeTrackId) {
      const activeTrack = AppState.collectiveManager.getTrack(AppState.activeTrackId);
      if (activeTrack) activeTrack.hasUnsavedLabels = true;
    }
  },

  /**
   * Re-render the Leaflet map with current GPS filter parameters.
   */
  rerenderMap() {
    if (!AppState.mapManager) return;

    if (AppState.viewMode === 'single') {
      if (!AppState.analyzer || AppState.analyzer.raw.length === 0) return;
      GSRTrackManager.saveActiveGpsParams();
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
    const { track, analyzer } = this._resolveTrackAndAnalyzer(trackId);

    if (!analyzer || !analyzer.peaks || idx >= analyzer.peaks.length) return;
    const pk = analyzer.peaks[idx];
    const clean = label.trim();
    pk.label = clean;
    if (typeof analyzer.setPeakLabel === 'function') {
      analyzer.setPeakLabel(pk.time, clean);
    }
    this._markUnsavedLabels(track);

    // Refresh displays. A label edit only ever changes this one peak's label
    // chip/popup — refreshPeakMarkers()/refreshCollectivePeakMarkers()
    // re-render just the peak-marker layer instead of a full path+peaks+
    // hotspots(+clusters+contours, in collective mode) rebuild (see
    // docs/archive/visualizer_rendering_perf_routes.md §2.2 and the Phase 6 step 2
    // investigation note in the architecture refactor plan for why this is
    // safe in collective mode specifically for labels, unlike exclusion).
    if (AppState.viewMode === 'single') {
      if (AppState.mapManager) {
        // skipClustering: true — a label edit can't change clusterPeaks()'s
        // input (lat/lon/amplitude per non-excluded peak), so recomputing
        // cluster blobs here is provably wasted (see refreshPeakMarkers()'s
        // own doc comment and docs/archive/visualizer_rendering_perf_routes.md §2.4).
        AppState.mapManager.refreshPeakMarkers(AppState.analyzer, GSRStorage.buildGpsParams(), { skipClustering: true });
      }
      GSRUI.updatePeaksTable();
      redraw();
    } else if (AppState.mapManager) {
      const latSlider = AppState.sliders.gpsPeakLatency;
      const peakLatency = parseFloat(latSlider ? latSlider.value : GSR_CONST.GPS_DEFAULT.peakLatency);
      AppState.mapManager.refreshCollectivePeakMarkers(track, peakLatency);
    }
  },

  /**
   * Handle real-time typing in label fields, updating the graph in real-time
   * without destroying/recreating the active Leaflet map popups.
   */
  handleLiveLabelInput(idx, value, trackId) {
    const { track, analyzer } = this._resolveTrackAndAnalyzer(trackId);
    const peaksArr = analyzer ? analyzer.peaks : null;
    if (!peaksArr || idx >= peaksArr.length) return;
    
    // Update in-memory model (avoid trim during typing to allow trailing spaces)
    const pk = peaksArr[idx];
    pk.label = value;
    if (analyzer && typeof analyzer.setPeakLabel === 'function') {
      analyzer.setPeakLabel(pk.time, value);
    }
    this._markUnsavedLabels(track);

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

    // 3. Navigate the active map surface to the peak.
    if (source === 'table' && hasGps) {
      // SCR Events table: jump straight to the spot with the scrub dot as the
      // locator and no popup — works even when the peak-marker layer is hidden.
      if (AppState.surfaceView === 'globe' && typeof GSRGlobe3DView !== 'undefined' && GSRGlobe3DView.isActive) {
        if (typeof GSRGlobe3DView.focusOnPeakLocation === 'function') {
          GSRGlobe3DView.focusOnPeakLocation(idx);
        }
      } else if (AppState.mapManager && typeof AppState.mapManager.focusOnPeakLocation === 'function') {
        AppState.mapManager.focusOnPeakLocation(idx, AppState.analyzer, GSRStorage.buildGpsParams());
      }
    } else if (source !== 'map' && hasGps) {
      // Graph click: fly to the peak and open its popup.
      if (AppState.surfaceView === 'globe' && typeof GSRGlobe3DView !== 'undefined' && GSRGlobe3DView.isActive) {
        if (typeof GSRGlobe3DView.focusOnPeak === 'function') {
          GSRGlobe3DView.focusOnPeak(idx);
        }
      } else {
        // Phase 1 (slice 3): the peakMarkers flat array is gone; resolve the
        // marker for this peak index from the track layerGroups instead.
        const peakMarker = (AppState.mapManager && typeof AppState.mapManager.getPeakMarkerByIndex === 'function')
          ? AppState.mapManager.getPeakMarkerByIndex(idx)
          : null;
        if (peakMarker) {
          setTimeout(() => peakMarker.openPopup(), 100);
        }
      }
    }
  },

  /**
   * Toggle exclusion state for a peak event, then refresh all views.
   */
  togglePeakExclusion(idx, trackId) {
    const { analyzer } = this._resolveTrackAndAnalyzer(trackId);
    if (!analyzer || !analyzer.peaks || idx >= analyzer.peaks.length) return;
    analyzer.setPeakExcluded(idx, !analyzer.peaks[idx].excluded);
    // Refresh displays. Same path/hotspot-skip reasoning as updatePeakLabel():
    // refreshPeakMarkers() rebuilds just the peak-marker layer instead of
    // renderData()'s full path+peaks+hotspots rebuild (see
    // docs/archive/visualizer_rendering_perf_routes.md §2.2). Unlike a label edit,
    // this does NOT pass skipClustering — excluding a peak changes
    // clusterPeaks()'s input set (activePeaks filters on ap.peak.excluded),
    // so cluster blobs must be recomputed here (see §2.4 and
    // refreshPeakMarkers()'s own doc comment).
    if (AppState.viewMode === 'single') {
      GSRUI.updatePeaksTable();
      redraw();
      if (AppState.mapManager) {
        AppState.mapManager.refreshPeakMarkers(AppState.analyzer, GSRStorage.buildGpsParams());
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
      // Hotspot selection (analyze()'s memorableEvents) resolves GPS
      // positions using peakLatency so candidate positions match the latency-shifted
      // locations rendered on the map.
      const peakLatency = GSRStorage.readGpsSliderValues().peakLatency;

      if (AppState.viewMode === 'single') {
        GSRTrackManager.saveActiveTrackParams();
        AppState.analyzer.analyze(params, peakLatency);
        if (AppState.mapManager) {
          AppState.mapManager.renderData(AppState.analyzer, GSRStorage.buildGpsParams());
        }
      } else {
        if (AppState.collectiveManager) {
          const activeTracks = AppState.collectiveManager.getActiveTracks();
          activeTracks.forEach(track => {
            track.analyzer.analyze(params, peakLatency);
            track.filterParams = { ...params };
          });
        }
        GSRUI.updateCollectiveMap();
      }

      GSRUI.updateStatsPanel();
      GSRUI.updatePeaksTable();
      GSRUI.updateDeconvTruncationWarning();
      redraw();
    } catch (err) {
      console.error("Analysis error:", err);
      alert("Error running analysis: " + err.message);
    }
  },

  /**
   * Show/hide the SCR-deconvolution truncation warning (index.html,
   * #deconvTruncationWarning). phasicDeconvTruncated is set by
   * _runDeconvolutionPipeline() (analyzer.js) whenever matching pursuit hits
   * maxIter before the residual actually converges — a real, possible
   * failure mode (some genuine SCRs left unmodelled with no other visible
   * sign) that previously had no indication anywhere in the UI; the flag
   * existed but only tests ever read it.
   */
  updateDeconvTruncationWarning() {
    const el = document.getElementById('deconvTruncationWarning');
    if (!el) return;
    const truncated = !!(AppState.analyzer && AppState.analyzer.phasicDeconvTruncated);
    el.style.display = truncated ? '' : 'none';
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
    if (F.duration) {
      F.duration.innerText  = durMins > 0
        ? durMins + ' min ' + durSecs + ' sec'
        : durSecs + ' sec';
    }
    if (F.meanSCL)   F.meanSCL.innerText   = stats.meanSCL.toFixed(3) + " \u03bcS";
    if (F.peakCount) F.peakCount.innerText = stats.peakCount;
    if (F.peakFreq)  F.peakFreq.innerText  = stats.peakFrequency.toFixed(2) + " / min";

    GSRUI.updateSpatialDataIndicator();
  },

  /**
   * Reflects whether spatial data (OSM retrieval) is present in the
   * "Spatial Data" stat card, as a green/grey dot rather than text:
   *   - Single-track mode: green if the active track is enriched, grey
   *     otherwise.
   *   - Collective mode: green only if EVERY active track is enriched.
   *     Grey if none are, or if it's a mix of enriched/not — a partial
   *     state isn't "green" since not all shown structures/metrics would
   *     actually have spatial data behind them.
   * Called after a fresh analysis run (updateStatsPanel) and immediately
   * after enrichment completes/changes (refreshOsmControls) so it never
   * lags behind the actual analyzer.isEnriched state(s).
   */
  updateSpatialDataIndicator() {
    const el = AppState.statFields.spatialData;
    if (!el) return;

    let allEnriched;
    if (AppState.viewMode === 'collective') {
      const tracks = AppState.collectiveManager ? AppState.collectiveManager.getActiveTracks() : [];
      allEnriched = tracks.length > 0 && tracks.every(t => t.analyzer && t.analyzer.isEnriched);
    } else {
      allEnriched = !!(AppState.analyzer && AppState.analyzer.isEnriched);
    }

    el.innerText = '●'; // ● — a plain coloured dot, no wording needed
    el.style.color = allEnriched ? 'var(--success)' : 'var(--text-muted)';

    const tooltip = allEnriched
      ? 'Spatial data retrieved'
      : (AppState.viewMode === 'collective'
          ? 'Spatial data missing for one or more active tracks'
          : 'Spatial data not retrieved');

    // Put the title on the whole card, not just the dot glyph — the dot
    // is only a few pixels wide, so hovering it precisely enough to see
    // the tooltip was fiddly. The card is a much larger, easier target.
    const card = AppState.statFields.spatialDataCard;
    if (card) {
      card.title = tooltip;
    } else {
      el.title = tooltip; // fallback if the card element isn't wired up
    }
  },

  /**
   * Sort the peaks table by a column key ('index'|'label'|'amplitude'|'riseTime'|'quality'|'excluded').
   */
  sortPeaksTable(col) {
    if (!col) return;
    if (AppState.peakSortColumn === col) {
      AppState.peakSortDirection = (AppState.peakSortDirection === 'asc') ? 'desc' : 'asc';
    } else {
      AppState.peakSortColumn = col;
      AppState.peakSortDirection = 'asc';
    }
    this.updatePeaksTable();
  },

  /**
   * Update header icons and classes according to the active sort state.
   */
  updatePeaksTableSortHeaders() {
    const table = document.getElementById('peaksTable');
    if (!table) return;
    const ths = table.querySelectorAll('thead th.sortable');
    const curCol = AppState.peakSortColumn || 'index';
    const curDir = AppState.peakSortDirection || 'asc';

    ths.forEach(th => {
      const col = th.dataset.sort;
      const icon = th.querySelector('.sort-icon');
      if (col === curCol) {
        th.classList.remove('sort-asc', 'sort-desc');
        th.classList.add(curDir === 'desc' ? 'sort-desc' : 'sort-asc');
        if (icon) {
          icon.className = 'fa-solid ' + (curDir === 'desc' ? 'fa-sort-down' : 'fa-sort-up') + ' sort-icon';
        }
      } else {
        th.classList.remove('sort-asc', 'sort-desc');
        if (icon) {
          icon.className = 'fa-solid fa-sort sort-icon';
        }
      }
    });
  },

  /**
   * Populate the peak events table below the graph.
   */
  updatePeaksTable() {
    const peaks = (AppState.analyzer && AppState.analyzer.peaks) ? AppState.analyzer.peaks : [];
    const tb    = AppState.tableBody;

    if (!tb) return;

    if (peaks.length === 0) {
      tb.innerHTML = '<tr class="empty-row"><td colspan="7">No peaks detected. Try reducing the Peak Amplitude threshold.</td></tr>';
      this.updatePeaksTableSortHeaders();
      return;
    }

    const sortCol = AppState.peakSortColumn || 'index';
    const sortDir = (AppState.peakSortDirection === 'desc') ? -1 : 1;

    // Create array of { p, idx } pairs to sort without mutating AppState.analyzer.peaks
    const indexedPeaks = peaks.map((p, idx) => ({ p, idx }));
    const getRiseTime = (p) => (p.riseTime ?? (p.time - p.onsetTime) ?? 0);

    indexedPeaks.sort((a, b) => {
      let diff = 0;
      switch (sortCol) {
        case 'label': {
          const lA = (a.p.label || '').trim().toLowerCase();
          const lB = (b.p.label || '').trim().toLowerCase();
          if (lA < lB) diff = -1;
          else if (lA > lB) diff = 1;
          break;
        }
        case 'amplitude':
          diff = (a.p.amplitude ?? 0) - (b.p.amplitude ?? 0);
          break;
        case 'riseTime':
          diff = getRiseTime(a.p) - getRiseTime(b.p);
          break;
        case 'quality':
          diff = (a.p.qualityScore ?? 0) - (b.p.qualityScore ?? 0);
          break;
        case 'excluded':
          diff = (a.p.excluded ? 1 : 0) - (b.p.excluded ? 1 : 0);
          break;
        case 'index':
        default:
          diff = a.idx - b.idx;
          break;
      }

      if (diff !== 0) {
        return diff * sortDir;
      }
      return a.idx - b.idx; // Stable fallback to chronological index
    });

    let rowsHtml = "";
    indexedPeaks.forEach(({ p, idx }) => {
      const rowClass = [];
      if (idx === AppState.activePeakIndex) rowClass.push('active-row');
      if (p.excluded) rowClass.push('excluded-row');
      const rowAttr = rowClass.length > 0 ? "class='" + rowClass.join(' ') + "'" : "";
      const riseTimeStr = getRiseTime(p).toFixed(2);
      const qScore = p.qualityScore !== undefined ? p.qualityScore : 0;
      const qColor = getQualityColor(qScore, '20');
      const { pct: qPct, label: qLabel } = getQualityLabel(qScore);

      const escapedLabel = (typeof GSRNotices !== 'undefined' && typeof GSRNotices.escapeHtml === 'function')
        ? GSRNotices.escapeHtml(p.label || '')
        : (p.label || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
        '<td>' + p.amplitude.toFixed(4) + '</td>' +
        '<td>' + riseTimeStr + '</td>' +
        '<td style="background:' + qColor + '">' +
          qPct + '% ' + qLabel + '</td>' +
        '<td class="exclude-cell"><button class="btn-exclude" ' +
          'onclick="event.stopPropagation(); GSRUI.togglePeakExclusion(' + idx + ')" ' +
          'title="' + (p.excluded ? 'Include peak' : 'Exclude peak') + '">' +
          (p.excluded ? '<i class="fa-solid fa-plus"></i>' : '<i class="fa-solid fa-xmark"></i>') +
          '</button></td>' +
        '<td><button class="btn-table-action" onclick="event.stopPropagation(); GSRUI.focusOnPeak(' + idx + ', \'table\')">' +
        '<i class="fa-solid fa-arrows-to-eye"></i> View</button></td></tr>';
    });

    tb.innerHTML = rowsHtml;

    // Update header sort indicators
    this.updatePeaksTableSortHeaders();

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
      peakPreservation:  parseFloat(cc.peakPreservation ? cc.peakPreservation.value : GSR_CONST.COLLECTIVE.peakPreservation),
      coverageWeighting: parseFloat(cc.coverageWeighting ? cc.coverageWeighting.value : GSR_CONST.COLLECTIVE.coverageWeighting),
      topographySource:  cc.topoSource ? cc.topoSource.value : 'phasic',
      showShadedSurface: cc.showShadedSurface ? cc.showShadedSurface.classList.contains('active') : true,
      normalizeZScore:   cc.normalizeZScore ? cc.normalizeZScore.checked : true,
      surfaceOpacity:    cc.surfaceOpacity ? parseFloat(cc.surfaceOpacity.value) : 0.40,
      hillshadeStrength: cc.hillshadeStrength ? parseFloat(cc.hillshadeStrength.value) : 0.0
    };

    const lat = parseFloat(AppState.sliders.gpsPeakLatency ? AppState.sliders.gpsPeakLatency.value : GSR_CONST.GPS_DEFAULT.peakLatency);
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
   * Get a sanitised filename base from the active track name.
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
   * @param {string} [targetTrackId] - Optional track ID to export, defaults to active track
   * @returns {Promise<boolean>} True if saved, false if cancelled or failed
   */
  async exportCSV(targetTrackId) {
    let track = null;
    let analyzer = AppState.analyzer;
    if (targetTrackId) {
      track = AppState.collectiveManager.getTrack(targetTrackId);
      if (track) analyzer = track.analyzer;
    } else if (AppState.activeTrackId) {
      track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
    }

    if (!analyzer || analyzer.raw.length === 0) return false;
    const params = track ? track.filterParams : GSRStorage.readGsrSliderValues();
    const gpsParams = track ? track.gpsFilterParams : GSRStorage.readGpsSliderValues();
    const csvContent = analyzer.exportToCSV(params, gpsParams);
    const nameToSanitize = track ? track.name : (AppState.activeTrackId ? (AppState.collectiveManager.getTrack(AppState.activeTrackId) || {}).name : null);
    const baseName = nameToSanitize ? nameToSanitize.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') : GSRUI._exportFilenameBase();
    const saved = await GSRFileSaver.saveFile(csvContent, baseName + '_processed.csv');
    if (saved !== false) {
      if (track) track.hasUnsavedLabels = false;
      if (AppState.activeTrackId && (!targetTrackId || targetTrackId === AppState.activeTrackId)) {
        const activeTrack = AppState.collectiveManager.getTrack(AppState.activeTrackId);
        if (activeTrack) activeTrack.hasUnsavedLabels = false;
      }
      return true;
    }
    return false;
  },

  /**
   * Export p5.js canvas as PNG.
   */
  async saveCanvasImage() {
    if (!AppState.myCanvas || AppState.analyzer.raw.length === 0) return;
    const baseName = GSRUI._exportFilenameBase();
    const suggestedName = baseName + '_chart.png';
    const canvasEl = document.querySelector("#sketch-container canvas") || (AppState.myCanvas ? AppState.myCanvas.elt : null);
    if (canvasEl && typeof canvasEl.toBlob === 'function') {
      canvasEl.toBlob(async (blob) => {
        if (blob) {
          await GSRFileSaver.saveFile(blob, suggestedName);
        }
      }, 'image/png');
    } else {
      saveCanvas(AppState.myCanvas, baseName + '_chart', 'png');
    }
  },

  /**
   * Export the active map view (2D Leaflet vector rasterisation or 3D Cesium WebGL) as PNG.
   */
  async saveMapImage() {
    if (AppState.analyzer.raw.length === 0) return;

    const btn = document.getElementById('exportMapBtn');
    const originalText = btn ? btn.innerHTML : '';

    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
      btn.setAttribute('disabled', 'true');
    }

    try {
      if (typeof GSRGlobe3DView !== 'undefined' && GSRGlobe3DView.isActive && GSRGlobe3DView.manager?.viewer) {
        // 3D Globe Mode (Cesium WebGL canvas capture).
        // Primitives compiled with asynchronous:true (the wall, RF expanse)
        // are uploaded to the GPU asynchronously — they first appear in the
        // frame AFTER render() is called. Wait for scene.postRender so the
        // snapshot always captures fully-rendered geometry.
        const viewer = GSRGlobe3DView.manager.viewer;
        const canvas = viewer.scene.canvas;
        const baseName = GSRUI._exportFilenameBase();
        const mode = AppState.viewMode || 'single';
        const suggestedName = `${baseName}_globe3d_${mode}_export.png`;

        await new Promise((resolve) => {
          const remove = viewer.scene.postRender.addEventListener(() => {
            remove(); // one-shot
            if (typeof canvas.toBlob === 'function') {
              canvas.toBlob(async (blob) => {
                if (blob) await GSRFileSaver.saveFile(blob, suggestedName);
                resolve();
              }, 'image/png');
            } else if (typeof canvas.toDataURL === 'function') {
              GSRFileSaver.saveFile(canvas.toDataURL('image/png'), suggestedName).then(resolve);
            } else {
              resolve();
            }
          });
          viewer.render(); // trigger the frame that will compile + upload pending geometry
        });
      } else if (typeof GSRMapExporter !== 'undefined' && AppState.mapManager) {
        // 2D Map Mode (Native vector SVG rendered to PNG)
        await GSRMapExporter.exportToPng(AppState.mapManager);
      }
    } catch (err) {
      console.error("Error generating map PNG:", err);
      alert("Could not export map PNG.");
    } finally {
      if (btn) {
        btn.innerHTML = originalText;
        btn.removeAttribute('disabled');
      }
    }
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
   * OSM ways/relations to draw as map overlays for whichever tracks are
   * currently active: a single analyzer's osmGeoms in single-track mode,
   * or the union — de-duplicated by OSM element id — of every active
   * track's osmGeoms in collective mode. Two tracks enriched at
   * different times can have their own osmGeoms with only partial or no
   * overlap; without merging them, toggling "OSM Layers" in collective
   * mode would only ever draw whichever single analyzer AppState.analyzer
   * happened to reference, not the combined coverage the user actually
   * retrieved. OSM element ids are globally stable, so de-duping by id
   * across tracks is safe (same id always means the same geometry).
   */
  getCombinedOsmGeoms() {
    if (AppState.viewMode !== 'collective') {
      return (AppState.analyzer && AppState.analyzer.osmGeoms) ? AppState.analyzer.osmGeoms : null;
    }

    if (!AppState.collectiveManager) return null;
    const tracks = AppState.collectiveManager.getActiveTracks()
      .filter(t => t.analyzer && t.analyzer.osmGeoms);
    if (tracks.length === 0) return null;
    if (tracks.length === 1) return tracks[0].analyzer.osmGeoms;

    const wayMap = new Map();
    const relationMap = new Map();
    for (const t of tracks) {
      const g = t.analyzer.osmGeoms;
      if (g.ways)      for (const w of g.ways)      wayMap.set(w.id, w);
      if (g.relations) for (const r of g.relations) relationMap.set(r.id, r);
    }
    return { ways: Array.from(wayMap.values()), relations: Array.from(relationMap.values()) };
  },

  /**
   * Helper to refresh UI elements based on track enrichment state.
   */
  refreshOsmControls() {
    const analyzers = (AppState.viewMode === 'single')
      ? (AppState.analyzer ? [AppState.analyzer] : [])
      : AppState.collectiveManager.getActiveTracks().map(t => t.analyzer).filter(Boolean);

    // Full enrichment (per-point spatial metadata) → OSM colour metrics + the
    // environmental dashboard. A 3D-buildings download only reconstructs
    // geometry (analyzer.osmGeoms), which is all the 2D vector-shapes button
    // needs — so that button tracks osmGeoms, not isEnriched.
    const enriched = analyzers.filter(a => a.isEnriched);
    const isEnriched = enriched.length > 0;
    const hasOsmGeoms = analyzers.some(a => a.osmGeoms);

    GSRUI.updateSpatialDataIndicator();

    const select = document.getElementById('mapColoringMetric');
    const btnToggleOsmShapes = document.getElementById('btnToggleOsmShapes');
    const envPanel = document.getElementById('environmentalPanel');

    // The OSM header button is the 3D-buildings toggle while the globe is the
    // mounted surface — GSREvents.setSurface owns it there, leave it alone.
    if (AppState.surfaceView !== 'globe') {
      if (hasOsmGeoms) {
        btnToggleOsmShapes.style.display = 'inline-block';
        // If the layer toggle is already on (e.g. the user just enriched a
        // second track while looking at the first one's shapes), redraw with
        // the newly-combined coverage instead of leaving stale shapes.
        if (btnToggleOsmShapes.classList.contains('active') && AppState.mapManager) {
          const geoms = GSRUI.getCombinedOsmGeoms();
          if (geoms) AppState.mapManager.drawOsmShapes(geoms);
        }
      } else {
        btnToggleOsmShapes.style.display = 'none';
        btnToggleOsmShapes.classList.remove('active');
        if (AppState.mapManager) AppState.mapManager.clearOsmShapes();
      }
    }

    if (isEnriched) {
      document.querySelectorAll('.osm-option').forEach(opt => opt.removeAttribute('disabled'));
      envPanel.style.display = 'block';

      const firstEnriched = enriched.find(a => a.enrichmentRadius);
      const rad = firstEnriched ? firstEnriched.enrichmentRadius : null;
      if (rad) {
        document.getElementById('osmRadius').value = rad;
        document.getElementById('valOsmRadius').innerText = rad + ' m';
      }

      GSRUI.updateEnvironmentalDashboard();
    } else {
      document.querySelectorAll('.osm-option').forEach(opt => opt.setAttribute('disabled', 'true'));
      // Only fall back to GSR if the current metric is an OSM-only one that just
      // became unavailable — don't clobber a plain choice like Phasic.
      const cur = select && select.selectedOptions && select.selectedOptions[0];
      if (cur && cur.classList.contains('osm-option')) {
        select.value = 'gsr';
        if (AppState.mapManager) AppState.mapManager.activeColoringMetric = 'gsr';
      }
      envPanel.style.display = 'none';
    }
  },

  /**
   * Orchestrates bounding box computation, Overpass fetching, and spatial enrichment.
   */
  async enrichTrack(forceFetch = false) {
    if (GSRUI._enriching) return;
    
    const isCollective = (AppState.viewMode === 'collective');
    
    // Get tracks to enrich
    let tracksToEnrich = [];
    if (isCollective) {
      if (!AppState.collectiveManager) return;
      tracksToEnrich = AppState.collectiveManager.getActiveTracks();
    } else {
      if (AppState.analyzer && AppState.analyzer.raw.length > 0) {
        tracksToEnrich = [{
          id: AppState.activeTrackId,
          analyzer: AppState.analyzer
        }];
      }
    }

    if (tracksToEnrich.length === 0) {
      alert("Please load or select active track files first.");
      return;
    }

    // Filter to tracks that contain at least one valid GPS coordinate fix
    const validTracks = tracksToEnrich.filter(t => {
      if (!t || !t.analyzer || !t.analyzer.raw) return false;
      return t.analyzer.raw.some(pt => pt && OSMEnricher._isValidCoord(pt.lat, pt.lon));
    });

    if (validTracks.length === 0) {
      alert("No valid GPS coordinates found in the selected track(s). OpenStreetMap spatial data retrieval requires GPS location fixes.");
      return;
    }

    const btn = document.getElementById('btnEnrichTrack');
    const statusContainer = document.getElementById('osmStatusContainer');
    const statusMsg = document.getElementById('osmStatusMessage');
    const progressBar = document.getElementById('osmProgressBar');
    
    if (!btn || !statusContainer || !statusMsg || !progressBar) {
      return;
    }

    const originalText = btn.innerHTML;
    GSRUI._enriching = true;
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
      const radius = parseInt(document.getElementById('osmRadius').value) || 50;
      const snapRadius  = parseInt(document.getElementById('gpsSnapRadius')?.value) || 25;
      const maxRadius   = Math.max(radius, snapRadius);

      // Calculate union bounding box using valid raw coordinates
      const combinedRaw = [];
      for (const t of validTracks) {
        combinedRaw.push(...t.analyzer.raw);
      }

      const unionBBox = OSMEnricher.calculateBBox(combinedRaw, maxRadius + 50);
      if (!unionBBox) {
        throw new Error("Could not calculate bounding box. Track coordinates may be invalid.");
      }

      const area = OSMEnricher.calculateBBoxAreaKm2(unionBBox);
      if (area > 12.0) {
        throw new Error(`The combined tracks' bounding box is too large (${area.toFixed(1)} km²). Maximum size is 12 km² to prevent API overload. Try selecting fewer active tracks.`);
      }

      // Check if we can reuse cached in-memory OSM data
      const allCached = !forceFetch && validTracks.every(t => t.analyzer.osmJson);

      if (allCached) {
        const snapEnabled = document.getElementById('gpsSnapToRoads')?.checked ?? false;
        validTracks.forEach(t => {
          OSMEnricher.enrichTrack(t.analyzer, t.analyzer.osmJson, radius,
            { enabled: snapEnabled, radiusOut: snapRadius }
          );
        });
        GSRUI.refreshOsmControls();
        GSRUI.rerenderMap();
        updateProgress('Enrichment complete (using local cache)!', 100);
        setTimeout(() => { statusContainer.style.display = 'none'; }, 2500);
        return;
      }

      // Check persistent storage cache or fetch from Overpass API
      updateProgress('Checking local cache...', 10);
      let osmJson = await OsmCache.getForBBox(unionBBox);

      if (osmJson) {
        updateProgress('Using cached OpenStreetMap data...', 50);
      } else {
        const plan = await OsmCache.planFetch(unionBBox);
        if (plan.mergeIds.length > 0) {
          updateProgress(`Expanding cached coverage (merging ${plan.mergeIds.length} nearby area${plan.mergeIds.length > 1 ? 's' : ''})...`, 20);
        }

        updateProgress('Fetching OpenStreetMap features for tracks...', 30);
        osmJson = await OSMEnricher.fetchOSMData(plan.fetchBBox, (msg) => updateProgress(msg));
        OsmCache.store(plan.fetchBBox, osmJson, plan.mergeIds);
      }

      updateProgress('Processing spatial metrics...', 60);
      const snapEnabled = document.getElementById('gpsSnapToRoads')?.checked ?? false;

      // Enrich each valid track using OSM JSON
      validTracks.forEach((t, i) => {
        t.analyzer.osmJson = osmJson;
        OSMEnricher.enrichTrack(t.analyzer, osmJson, radius,
          { enabled: snapEnabled, radiusOut: snapRadius },
          (msg) => updateProgress(`[Track ${i+1}/${validTracks.length}] ${msg}`)
        );
      });

      updateProgress('Redrawing visualizer...', 90);
      
      // Update UI displays
      GSRUI.refreshOsmControls();
      GSRUI.rerenderMap();
      
      const skippedCount = tracksToEnrich.length - validTracks.length;
      if (skippedCount > 0) {
        updateProgress(`Enrichment complete! (Skipped ${skippedCount} track${skippedCount > 1 ? 's' : ''} with no GPS fixes)`, 100);
      } else {
        updateProgress('Enrichment complete!', 100);
      }
      
      setTimeout(() => {
        statusContainer.style.display = 'none';
      }, 3000);

    } catch (err) {
      console.error('OSM Enrichment error:', err);
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
    // Per-track data-mutation fingerprint (bumped by analyzer.analyze(),
    // setPeakLabel(), setPeakExcluded(), and OSMEnricher.enrichTrack() —
    // see analyzer.js's _dataVersion doc comment). Folding this into the
    // cache key means the cache self-validates against any of those
    // mutations without a caller having to remember to invalidate it.
    const versionSig = activeTracks.map(t => (t.analyzer && t.analyzer._dataVersion) || 0).join(',');

    // Use a shared cache location: in single mode, store on the analyzer;
    // in collective mode, store on the collective manager (avoids losing cache when switching active track)
    const cacheTarget = (AppState.viewMode === 'single') ? AppState.analyzer : AppState.collectiveManager;
    const cache = cacheTarget._cachedEnvStats;
    const needsRecalc = !cache ||
                      cache.latency !== latency ||
                      cache.trackCount !== activeTracks.length ||
                      cache.trackIds !== trackIdsStr ||
                      cache.versionSig !== versionSig;

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

      // Calculate Pearson correlation matrix rows — continuous OSM fields
      // only (roadClass/inPark are categorical, not correlatable), from the
      // shared GSR_CONST.OSM_METRICS table (constants.js).
      const features = GSR_CONST.OSM_METRICS
        .filter(m => m.kind === 'continuous')
        .map(m => ({ name: m.label, key: m.field }));

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
        versionSig,
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
      const cacheTarget = (AppState.viewMode === 'single') ? AppState.analyzer : AppState.collectiveManager;
      if (cacheTarget && cacheTarget._cachedEnvStats) {
        dataSrc = cacheTarget._cachedEnvStats.allData;
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
    
    // Continuous OSM fields, from the shared GSR_CONST.OSM_METRICS table
    // (constants.js) — unit (when present) appended in parens, matching
    // this axis-label context's existing "(m)" suffix on the two distance
    // fields; every other OSM_METRICS consumer uses the bare label.
    const xLabels = {};
    GSR_CONST.OSM_METRICS.filter(m => m.kind === 'continuous').forEach(m => {
      xLabels[m.field] = m.unit ? `${m.label} (${m.unit})` : m.label;
    });
    
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
  openStreetView(lat, lon, label, heading) {
    const modal = document.getElementById('streetviewModal');
    const mapillaryIframe = document.getElementById('svIframe');
    const googleIframe = document.getElementById('svGoogleIframe');
    const googleLink = document.getElementById('svGoogleLink');
    const mapillaryExtLink = document.getElementById('svMapillaryExtLink');
    const coordsEl = document.getElementById('svModalCoords');
    const titleEl = document.getElementById('streetviewModalTitle');

    if (!modal || !mapillaryIframe) return;

    // Resolve heading defensively to a finite number
    let cleanHeading = 0;
    if (typeof heading === 'number' && !isNaN(heading) && isFinite(heading)) {
      cleanHeading = heading;
    } else if (typeof heading === 'string') {
      const parsed = parseFloat(heading);
      if (!isNaN(parsed) && isFinite(parsed)) cleanHeading = parsed;
    }

    // Store coords and heading for tab switching
    this._svLat = lat;
    this._svLon = lon;
    this._svHeading = cleanHeading;

    titleEl.textContent = label ? 'Street-Level View — ' + label : 'Street-Level View';
    coordsEl.textContent = lat.toFixed(5) + ', ' + lon.toFixed(5);

    // Set Mapillary embed URL
    mapillaryIframe.src = 'https://www.mapillary.com/embed?lat=' + lat + '&lng=' + lon + '&z=18';

    // Set Google Maps external link (fallback) using viewpoint API to support heading orientation
    googleLink.href = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + lat + ',' + lon + '&heading=' + cleanHeading.toFixed(0);

    // Set Mapillary external link
    mapillaryExtLink.href = 'https://www.mapillary.com/app/?lat=' + lat + '&lng=' + lon + '&z=18';

    // Show the modal first so that the browser does not pause/optimise away the iframe loading
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Set Mapillary embed URL (now loaded while modal is visible)
    mapillaryIframe.src = 'https://www.mapillary.com/embed?lat=' + lat + '&lng=' + lon + '&z=18';

    // Reset Google iframe
    if (googleIframe) googleIframe.src = '';

    // Start on Google tab (left)
    GSRUI.switchStreetViewTab('google');

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
    this._svHeading = null;
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

        let cleanHeading = 0;
        if (typeof this._svHeading === 'number' && !isNaN(this._svHeading) && isFinite(this._svHeading)) {
          cleanHeading = this._svHeading;
        }

        const embedUrl = 'https://www.google.com/maps/embed/v1/streetview?key=' + encodeURIComponent(apiKey)
          + '&location=' + this._svLat + ',' + this._svLon + '&heading=' + cleanHeading.toFixed(0) + '&pitch=0&fov=90';
        
        // Defer setting the source to allow the browser layout engine to paint
        // the newly visible iframe container first. This resolves lazy-loading deferrals in modern browsers.
        setTimeout(() => {
          googleIframe.src = embedUrl;
        }, 0);
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
  },

  /**
   * Open the Export Preset Save Menu Modal Overlay.
   */
  openExportPresetModal(defaultName) {
    const modal = document.getElementById('exportPresetModal');
    const input = document.getElementById('presetFileNameInput');
    const summary = document.getElementById('presetModalSummary');
    if (!modal) return;

    if (input) {
      const activeTrack = AppState.activeTrackId ? AppState.collectiveManager.getTrack(AppState.activeTrackId) : null;
      input.value = defaultName || (activeTrack ? activeTrack.name.replace(/\.[^/.]+$/, "") : "custom_preset");
    }

    if (summary && typeof GSRStorage !== 'undefined') {
      const gsr = GSRStorage.readGsrSliderValues() || {};
      const gps = GSRStorage.readGpsSliderValues() || {};
      summary.innerHTML = `
        <strong>Active Preset Parameters to Export:</strong><br>
        • <strong>GSR:</strong> Median size=${gsr.medianSize}s, LPF window=${gsr.lpfWindow}s, Baseline=${gsr.tonicMethod} (${gsr.tonicWindow}s), Peak threshold=${gsr.peakThreshold}μS, Deconv=${gsr.useDeconvolution ? 'ON' : 'OFF'}<br>
        • <strong>GPS:</strong> Smoothing=${gps.smoothing}, Kalman R=${gps.kalmanR}, Max HDOP=${gps.maxHdop}, Peak latency=${gps.peakLatency}s
      `;
    }

    modal.style.display = 'flex';
  },

  closeExportPresetModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('exportPresetModal');
    if (modal) modal.style.display = 'none';
  },

  confirmExportPreset() {
    const input = document.getElementById('presetFileNameInput');
    const name = input ? input.value.trim() || 'preset' : 'preset';
    const gsr = GSRStorage.readGsrSliderValues();
    const gps = GSRStorage.readGpsSliderValues();
    if (!gsr || !gps) return;
    const preset = {
      type: "BioMappingPreset",
      version: 1,
      name: name,
      exportedAt: new Date().toISOString(),
      gsr: gsr,
      gps: gps,
      contour: GSRStorage.readContourSliderValues()
    };
    GSRStorage.downloadPresetJson(preset, name);
    this.closeExportPresetModal();
  },

  /**
   * Open the Unsaved Labels Warning Modal.
   * @param {string} trackName - Name of the track being closed/deleted.
   * @param {string|null} trackId - ID of track being closed, or 'ALL' for multiple.
   * @param {Function} onConfirmClose - Callback to execute if user chooses to proceed with close/deletion.
   */
  /**
   * Open the Unsaved Labels Warning Dialog via the shared notices layer.
   * @param {string} trackName - Name of the track being closed/deleted.
   * @param {string|null} trackId - ID of track being closed, or 'ALL' for multiple.
   * @param {Function} onConfirmClose - Callback to execute if the user chooses to proceed with close/deletion.
   */
  async showUnsavedLabelsModal(trackName, trackId, onConfirmClose) {
    if (typeof GSRNotices === 'undefined') {
      // No notice layer available — refuse to delete: losing unsaved labels
      // without an explicit user choice is not acceptable.
      return;
    }

    const warning = trackId === 'ALL'
      ? 'You have unsaved peak labels across loaded tracks.'
      : `Track "${trackName}" has unsaved peak labels.`;

    // Log the warning through the notices layer; the dialog below is the
    // visible notice and the decision point, so no duplicate toast.
    GSRNotices.warn(warning, 'unsaved-labels', { toast: false });

    const action = await GSRNotices.dialog({
      title: 'Unsaved Labels',
      message: trackId === 'ALL'
        ? `${warning} Would you like to export your project bundle before closing, or lose all unsaved labels?`
        : `${warning} Would you like to export your peak labels to CSV before closing, or lose unsaved labels?`,
      buttons: [
        { label: 'Export CSV', value: 'export', style: 'primary' },
        { label: 'Lose Labels', value: 'lose', style: 'danger' },
      ],
      dismissLabel: 'Cancel',
      tone: 'warn',
    });

    if (action === 'export') {
      let success = false;
      if (trackId === 'ALL') {
        if (typeof GSRCollectiveProject !== 'undefined') {
          await GSRCollectiveProject.exportProject();
          success = true;
        }
      } else {
        success = await GSRUI.exportCSV(trackId);
      }
      if (success) onConfirmClose();
    } else if (action === 'lose') {
      onConfirmClose();
    }
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRUI };
}
if (typeof window !== 'undefined') {
  window.GSRUI = GSRUI;
}
