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

      // Union bounding box over every valid track's raw coordinates.
      // (Plain loop, not push(...spread) — that overflows the call stack
      // once a collection has tens of thousands of points.)
      const combinedRaw = [];
      for (const t of validTracks) {
        const r = t.analyzer.raw;
        for (let i = 0; i < r.length; i++) combinedRaw.push(r[i]);
      }

      const AREA_CAP_KM2 = 12.0;
      const snapEnabled = document.getElementById('gpsSnapToRoads')?.checked ?? false;
      const snapParams = { enabled: snapEnabled, radiusOut: snapRadius };

      const unionBBox = OSMEnricher.calculateBBox(combinedRaw, maxRadius + 50);
      if (!unionBBox) {
        throw new Error("Could not calculate bounding box. Track coordinates may be invalid.");
      }
      const unionArea = OSMEnricher.calculateBBoxAreaKm2(unionBBox);

      // One shared Overpass fetch when the whole collection fits under the
      // area cap (the common case: walks in one neighbourhood). When it
      // doesn't, fetch per track below so a geographically spread-out
      // collection still enriches every track — each walk's own bbox is small.
      let sharedJson = null;
      const singleFetch = unionArea <= AREA_CAP_KM2;
      const allInMem = !forceFetch && validTracks.every(t => t.analyzer.osmJson);

      if (singleFetch && !allInMem) {
        updateProgress('Checking local cache…', 10);
        sharedJson = await OsmCache.getForBBox(unionBBox);
        if (sharedJson) {
          updateProgress('Using cached OpenStreetMap data…', 40);
        } else {
          const plan = await OsmCache.planFetch(unionBBox);
          if (plan.mergeIds.length > 0) {
            updateProgress(`Expanding cached coverage (merging ${plan.mergeIds.length} nearby area${plan.mergeIds.length > 1 ? 's' : ''})…`, 20);
          }
          updateProgress('Fetching OpenStreetMap features…', 30);
          sharedJson = await OSMEnricher.fetchOSMData(plan.fetchBBox, (msg) => updateProgress(msg));
          OsmCache.store(plan.fetchBBox, sharedJson, plan.mergeIds);
        }
      }

      // Enrich every valid track. One track failing (bad geometry, an
      // oversized bbox, an Overpass error) must not abort the rest.
      let enriched = 0;
      const failed = [];
      const tooBig = [];
      for (let i = 0; i < validTracks.length; i++) {
        const t = validTracks[i];
        const label = t.name || t.id || `track ${i + 1}`;
        const basePct = 45 + Math.round(50 * i / validTracks.length);
        updateProgress(`[${i + 1}/${validTracks.length}] ${label}…`, basePct);
        try {
          let json = sharedJson || ((!forceFetch && t.analyzer.osmJson) ? t.analyzer.osmJson : null);
          if (!json) {
            const tb = OSMEnricher.calculateBBox(t.analyzer.raw, maxRadius + 50);
            if (!tb) { failed.push(label); continue; }
            if (OSMEnricher.calculateBBoxAreaKm2(tb) > AREA_CAP_KM2) { tooBig.push(label); continue; }
            json = await OsmCache.getForBBox(tb);
            if (!json) {
              const plan = await OsmCache.planFetch(tb);
              json = await OSMEnricher.fetchOSMData(plan.fetchBBox, (msg) => updateProgress(`[${i + 1}/${validTracks.length}] ${msg}`));
              OsmCache.store(plan.fetchBBox, json, plan.mergeIds);
            }
          }
          t.analyzer.osmJson = json;
          OSMEnricher.enrichTrack(t.analyzer, json, radius, snapParams,
            (msg) => updateProgress(`[${i + 1}/${validTracks.length}] ${msg}`));
          enriched++;
        } catch (e) {
          console.error('OSM enrichment failed for track', t.id, e);
          failed.push(label);
        }
      }

      updateProgress('Redrawing visualiser…', 96);
      GSRUI.refreshOsmControls();
      GSRUI.rerenderMap();

      const noGps = tracksToEnrich.length - validTracks.length;
      const parts = [`Enriched ${enriched}/${tracksToEnrich.length} walk${tracksToEnrich.length === 1 ? '' : 's'}`];
      if (noGps > 0) parts.push(`${noGps} without GPS`);
      if (tooBig.length > 0) parts.push(`${tooBig.length} too spread out (> ${AREA_CAP_KM2} km²)`);
      if (failed.length > 0) parts.push(`${failed.length} failed`);
      updateProgress(parts.join(' · '), 100);
      if (enriched === 0) progressBar.style.backgroundColor = 'var(--danger)';
      setTimeout(() => { statusContainer.style.display = 'none'; }, (failed.length || tooBig.length) ? 6000 : 3000);

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
   * Percentile of a value within an unsorted numeric array (linear interp
   * between order statistics). Used to clip scatter axes to a robust range.
   */
  _percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    return GSRUI._percentileSorted([...arr].sort((a, b) => a - b), p);
  },

  /** Percentile of an already-ascending-sorted array (no copy, no re-sort). */
  _percentileSorted(s, p) {
    if (!s || s.length === 0) return 0;
    if (s.length === 1) return s[0];
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  },

  /**
   * Paint a scatter of (x, y) points with an OLS trend line and an R² badge
   * onto `canvas`. Pure drawing — caller supplies the fitted m, c, r2.
   *
   * Axes are clipped to the 2nd–98th percentile of each variable so a handful
   * of arousal spikes can't flatten the whole cloud; out-of-range points are
   * drawn clamped to the frame edge. Point opacity and radius scale down as
   * the sample grows, so a dense collective-mode cloud shows a density
   * gradient instead of a solid blob. When X is binary the OLS line (which is
   * just a difference of two means dressed up as a slope) is replaced by a
   * box-and-whisker per group.
   */
  drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabel, yLabel, isBinaryX = false) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    const css = (typeof window !== 'undefined' && window.getComputedStyle)
      ? window.getComputedStyle(document.documentElement) : null;
    const themeColor = (name, fallback) => {
      const v = css ? css.getPropertyValue(name).trim() : '';
      return v || fallback;
    };
    const bg     = themeColor('--canvas-bg', '#ffffff');
    const axisC  = themeColor('--text-primary', '#111111');
    const textC  = themeColor('--canvas-text', '#444444');
    const trendC = themeColor('--primary-color', '#0055cc');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    if (xVals.length === 0) {
      ctx.fillStyle = textC;
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data available', width / 2, height / 2);
      return;
    }

    const padL = 40;
    const padR = 15;
    const padT = 15;
    const padB = 30;

    // Robust axis bounds: clip to the 2nd–98th percentile (binary X keeps its
    // true 0..1 range). Points outside are clamped to the frame when plotted.
    const ySorted = [...yVals].sort((a, b) => a - b);
    let minX, maxX;
    if (isBinaryX) {
      minX = -0.5; maxX = 1.5;
    } else {
      const xSorted = [...xVals].sort((a, b) => a - b);
      minX = GSRUI._percentileSorted(xSorted, 0.02);
      maxX = GSRUI._percentileSorted(xSorted, 0.98);
    }
    let minY = GSRUI._percentileSorted(ySorted, 0.02);
    let maxY = GSRUI._percentileSorted(ySorted, 0.98);

    if (maxX <= minX) maxX = minX + 1;
    if (maxY <= minY) maxY = minY + 1;

    const rangeX = maxX - minX;
    const rangeY = maxY - minY;

    // Draw axis frame
    ctx.strokeStyle = axisC;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, height - padB);
    ctx.lineTo(width - padR, height - padB);
    ctx.stroke();

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const plotL = padL, plotR = width - padR, plotT = padT, plotBt = height - padB;
    const mapX = (x) => clamp(padL + ((x - minX) / rangeX) * (plotR - plotL), plotL, plotR);
    const mapY = (y) => clamp(plotBt - ((y - minY) / rangeY) * (plotBt - plotT), plotT, plotBt);

    // Density-aware point style: with tens of thousands of samples a solid
    // fill hides all structure, so fade and shrink as n grows.
    const n = xVals.length;
    const alpha = Math.max(0.04, Math.min(0.6, 35 / Math.sqrt(n)));
    const radius = n > 8000 ? 1.4 : (n > 2000 ? 1.9 : 2.5);
    const jitterAmp = isBinaryX ? 0.16 : 0;

    ctx.fillStyle = `rgba(255, 123, 0, ${alpha.toFixed(3)})`;
    for (let i = 0; i < n; i++) {
      // Deterministic per-point jitter (index hash) so binary columns don't
      // shimmer when the plot is redrawn on resize / tab switch.
      const jit = jitterAmp ? (((i * 2654435761) % 1000) / 1000 - 0.5) * 2 * jitterAmp : 0;
      const cx = mapX(xVals[i] + jit);
      const cy = mapY(yVals[i]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fill();
    }

    if (isBinaryX) {
      // Box-and-whisker per group (median, IQR box, 10–90th-pct whiskers).
      const boxHalf = Math.min(26, (mapX(1) - mapX(0)) * 0.28);
      for (const g of [0, 1]) {
        const col = [];
        for (let i = 0; i < n; i++) if (xVals[i] === g) col.push(yVals[i]);
        if (col.length < 3) continue;
        col.sort((a, b) => a - b);
        const q1 = GSRUI._percentileSorted(col, 0.25);
        const md = GSRUI._percentileSorted(col, 0.50);
        const q3 = GSRUI._percentileSorted(col, 0.75);
        const w1 = GSRUI._percentileSorted(col, 0.10);
        const w2 = GSRUI._percentileSorted(col, 0.90);
        const cx = mapX(g);
        ctx.strokeStyle = trendC;
        ctx.fillStyle = 'rgba(0, 85, 204, 0.10)';
        ctx.lineWidth = 1.5;
        ctx.fillRect(cx - boxHalf, mapY(q3), boxHalf * 2, mapY(q1) - mapY(q3));
        ctx.strokeRect(cx - boxHalf, mapY(q3), boxHalf * 2, mapY(q1) - mapY(q3));
        ctx.beginPath();                              // median
        ctx.moveTo(cx - boxHalf, mapY(md)); ctx.lineTo(cx + boxHalf, mapY(md));
        ctx.moveTo(cx, mapY(q3)); ctx.lineTo(cx, mapY(w2));   // whiskers
        ctx.moveTo(cx, mapY(q1)); ctx.lineTo(cx, mapY(w1));
        ctx.moveTo(cx - boxHalf * 0.5, mapY(w2)); ctx.lineTo(cx + boxHalf * 0.5, mapY(w2));
        ctx.moveTo(cx - boxHalf * 0.5, mapY(w1)); ctx.lineTo(cx + boxHalf * 0.5, mapY(w1));
        ctx.stroke();
      }
    } else {
      // OLS trendline across the visible X range (clipped to the frame in Y)
      ctx.strokeStyle = trendC;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mapX(minX), mapY(m * minX + c));
      ctx.lineTo(mapX(maxX), mapY(m * maxX + c));
      ctx.stroke();
    }

    // Text labels
    ctx.fillStyle = textC;
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(xLabel, padL + (width - padL - padR)/2, height - 6);

    ctx.save();
    ctx.translate(10, padT + (height - padT - padB)/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    ctx.fillStyle = textC;
    ctx.font = '8px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(isBinaryX ? 'no' : minX.toFixed(1), padL, height - padB + 10);
    ctx.textAlign = 'right';
    ctx.fillText(isBinaryX ? 'yes' : maxX.toFixed(1), width - padR, height - padB + 10);

    ctx.textAlign = 'right';
    ctx.fillText(minY.toFixed(2), padL - 5, height - padB);
    ctx.fillText(maxY.toFixed(2), padL - 5, padT + 5);

    // Fit badge in top-right corner: R² for a continuous X, |r| for a binary
    // one (there R² is just the squared point-biserial correlation).
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'right';
    const badgeText = isBinaryX
      ? 'r = ' + (Math.sign(m) * Math.sqrt(Math.max(0, Math.min(1, r2)))).toFixed(3)
      : 'R² = ' + r2.toFixed(3);
    const bw = ctx.measureText(badgeText).width;
    ctx.fillStyle = 'rgba(0, 85, 204, 0.08)';
    ctx.fillRect(width - padR - bw - 10, padT + 2, bw + 14, 18);
    ctx.strokeStyle = 'rgba(0, 85, 204, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(width - padR - bw - 10, padT + 2, bw + 14, 18);
    ctx.fillStyle = trendC;
    ctx.textAlign = 'right';
    ctx.fillText(badgeText, width - padR - 3, padT + 15);
  },

  updateEnvironmentalDashboard() {
    // Every active track (the walks the user has toggled on), and the
    // enriched subset the analysis can actually use.
    const allActive = (AppState.viewMode === 'single')
      ? (AppState.analyzer ? [{ id: AppState.activeTrackId, analyzer: AppState.analyzer }] : [])
      : AppState.collectiveManager.getActiveTracks();
    const activeTracks = allActive.filter(t => t.analyzer && t.analyzer.isEnriched);
    const totalWalks = allActive.length;

    if (activeTracks.length === 0) return;

    const latency = parseFloat(document.getElementById('gpsPeakLatency').value) || 2.0;
    // SCL (tonic) follows its driver several times more slowly than an SCR, so
    // its environment is read further back than the phasic/peaks latency —
    // scaled from the same knob (×4, capped at 30 s ≈ ~40 m at walking pace).
    const tonicLatency = Math.min(30, latency * 4);
    const trackIdsStr = activeTracks.map(t => t.id).join(',');
    // Per-track mutation fingerprint (analyzer._dataVersion is bumped by
    // analyze(), setPeakLabel(), setPeakExcluded(), enrichTrack()). In the
    // cache key, so the cache self-invalidates on any of them.
    const versionSig = activeTracks.map(t => (t.analyzer && t.analyzer._dataVersion) || 0).join(',');

    // Cache on the analyzer (single mode) or the collective manager
    // (collective mode — survives active-track switches).
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
          // Sample at ~1 Hz (keeps the point set manageable)
          if (pt.time - lastTime >= 1.0) {
            const coords = a.getCoordinates(i);
            if (coords) {
              // Phasic + peaks: environment read `latency` seconds earlier —
              // an SCR lags its trigger and the subject has since moved on.
              // Tonic: read `tonicLatency` (a larger lag) earlier — SCL tracks
              // its driver over a slower time course (envPtTonic below).
              const envIdx = a.findClosestIndex(Math.max(0, pt.time - latency));
              const envPt = (envIdx !== -1) ? a.raw[envIdx] : pt;
              const envIdxT = a.findClosestIndex(Math.max(0, pt.time - tonicLatency));
              const envPtTonic = (envIdxT !== -1) ? a.raw[envIdxT] : pt;

              // Aggregate arousal over the trailing 1 s (10 samples @ 10 Hz):
              // mean for level, max for the phasic peak.
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
                osm_amenity_count_50m: envPt.osm_amenity_count_50m,
                // EM Fog Index (0-100), latency-shifted like the OSM fields.
                // NaN when the row has no Sub-GHz RSSI; dropped per-feature below.
                em_fog: (typeof envPt.em_fog === 'number') ? envPt.em_fog : NaN,
                // Environment for the tonic channel, read `tonicLatency` s back.
                tonicEnv: {
                  osm_road_class: envPtTonic.osm_road_class,
                  osm_dist_major_road: envPtTonic.osm_dist_major_road,
                  osm_in_park: envPtTonic.osm_in_park,
                  osm_green_pct_50m: envPtTonic.osm_green_pct_50m,
                  osm_building_density_50m: envPtTonic.osm_building_density_50m,
                  osm_dist_water: envPtTonic.osm_dist_water,
                  osm_tree_density_50m: envPtTonic.osm_tree_density_50m,
                  osm_amenity_count_50m: envPtTonic.osm_amenity_count_50m,
                  em_fog: (typeof envPtTonic.em_fog === 'number') ? envPtTonic.em_fog : NaN
                }
              });
              lastTime = pt.time;
            }
          }
        }
      });

      // Correlation features: continuous OSM fields + binary "in park"
      // (point-biserial r is Pearson on a 0/1 variable). Road Class is
      // multi-level categorical and stays out.
      const features = GSR_CONST.OSM_METRICS
        .filter(m => m.kind === 'continuous' || m.kind === 'binary')
        .map(m => ({ name: m.label, key: m.field, binary: m.kind === 'binary' }));

      // EM Fog comes from Sub-GHz RSSI, not Overpass, so it's not in
      // OSM_METRICS. Add it only when some sample carries a reading.
      if (allData.some(d => !isNaN(d.em_fog))) {
        features.push({ name: 'EM Fog Index', key: 'em_fog', binary: false });
      }

      // Peak count per sample = number of peaks in its 15 s bin. The Peaks
      // channel doesn't correlate this per-1-Hz-sample (that duplicates each
      // count ~15×); instead each walk's Peaks series is re-aggregated to one
      // point per 15 s bin in the feature loop below.
      const peakCounts = [];
      activeTracks.forEach(track => {
        const a = track.analyzer;
        const peaks = a.peaks.filter(p => !p.excluded);
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

      // 999.0 is the "no feature within radius" sentinel — not a distance.
      const validNum = (v) => v !== null && v !== undefined && !isNaN(v) && v !== 999.0;
      const coerceBin = (v) => (v === true || v === 1) ? 1 : (v === false || v === 0) ? 0 : NaN;

      const correlationMatrix = features.map(f => {
        // Valid samples for this feature, bucketed per track. allData is
        // track-contiguous. A track is a "walk" — an independent recording.
        //  - xPhasic / phasic : short-lag environment vs momentary arousal
        //  - xTonic  / tonic  : long-lag environment vs baseline arousal
        //  - peakBinX / peakBinY : one point per 15 s bin (mean feature vs
        //    peak count) — no per-second duplication of the binned count
        const byTrack = new Map();
        const validX = []; // pooled latency-shifted values, for the variance check
        for (let i = 0; i < allData.length; i++) {
          const row = allData[i];
          const tid = row.trackId;
          let b = byTrack.get(tid);
          if (!b) {
            b = { xPhasic: [], phasic: [], xTonic: [], tonic: [], binX: new Map(), binPk: new Map() };
            byTrack.set(tid, b);
          }
          let xP = f.binary ? coerceBin(row[f.key]) : row[f.key];
          const tEnv = row.tonicEnv || row;
          let xT = f.binary ? coerceBin(tEnv[f.key]) : tEnv[f.key];

          if (validNum(xP)) {
            b.xPhasic.push(xP);
            b.phasic.push(row.phasic);
            validX.push(xP);
            const bin = Math.floor(row.time / 15);
            let bx = b.binX.get(bin);
            if (!bx) { bx = []; b.binX.set(bin, bx); }
            bx.push(xP);
            b.binPk.set(bin, peakCounts[i] || 0);
          }
          if (validNum(xT)) {
            b.xTonic.push(xT);
            b.tonic.push(row.tonic);
          }
        }
        const walks = [...byTrack.values()];
        // Collapse each walk's binned Peaks data to one (mean x, count) pair
        // per 15 s bin.
        for (const b of walks) {
          b.peakBinX = []; b.peakBinY = [];
          for (const [bin, xs] of b.binX) {
            let s = 0;
            for (const v of xs) s += v;
            b.peakBinX.push(s / xs.length);
            b.peakBinY.push(b.binPk.get(bin) || 0);
          }
        }

        // One method for the whole matrix, by walk count:
        //  - 1 walk  → pooled r + autocorrelation-adjusted p ('single').
        //  - 2+ walks → random-effects meta-analysis across walks
        //    (inverse-variance per-walk r via effective N, DerSimonian–Laird
        //    heterogeneity, Knapp–Hartung t). Needs >= 3 walks in which this
        //    factor actually varies; graded by how many:
        //      >= META_SOLID  → 'meta' (a real significance verdict)
        //      3..SOLID-1     → 'metaProvisional' (direction only, "N walks")
        //      < 3            → 'fewWalks' (effect size only, no test)
        const META_SOLID = 5;
        const analyse = (getX, getY) => {
          if (walks.length === 1) {
            const c = StatsMath.calculateAutocorrCorrelation(getX(walks[0]), getY(walks[0]));
            return { r: c.r, p: c.p, method: 'single', k: 1 };
          }
          const meta = StatsMath.metaCorrelation(walks.map(w => ({ x: getX(w), y: getY(w) })));
          if (meta.k < 3) return { r: meta.r, p: NaN, method: 'fewWalks', k: meta.k };
          if (meta.k < META_SOLID) return { r: meta.r, p: meta.p, method: 'metaProvisional', k: meta.k };
          return { r: meta.r, p: meta.p, method: 'meta', k: meta.k };
        };
        const chPhasic = analyse(w => w.xPhasic,  w => w.phasic);
        const chTonic  = analyse(w => w.xTonic,   w => w.tonic);
        const chPeaks  = analyse(w => w.peakBinX, w => w.peakBinY);

        // hasVariance = the factor actually changed. A constant predictor
        // explains no variance in arousal whatever its r. Continuous fields
        // need a coefficient of variation ≥ 1% (sx.std is floored at 1, so
        // use the true spread from sx.variance).
        const sx = StatsMath.calculateStats(validX);
        const trueStd = Math.sqrt(sx.variance);
        const cv = trueStd / (Math.abs(sx.mean) + 1e-9);
        const hasVariance = f.binary
          ? (new Set(validX).size > 1)
          : (validX.length > 2 && trueStd > 0 && cv >= 0.01);

        return { name: f.name, key: f.key, n: validX.length, featureWalks: walks.length, hasVariance,
                 rPhasic: chPhasic.r, rTonic: chTonic.r, rPeaks: chPeaks.r,
                 pPhasic: chPhasic.p, pTonic: chTonic.p, pPeaks: chPeaks.p,
                 mPhasic: chPhasic.method, mTonic: chTonic.method, mPeaks: chPeaks.method,
                 kPhasic: chPhasic.k, kTonic: chTonic.k, kPeaks: chPeaks.k };
      });

      // Multiple comparisons: Benjamini–Hochberg FDR, one family PER arousal
      // channel (phasic, tonic, peaks). Phasic / tonic / peaks are three
      // correlated views of the same arousal, not three independent
      // discoveries, so pooling them into one 3×features family both
      // over-counts the tests and mixes hypotheses. Within a channel the
      // family is "which environmental factors relate to THIS measure" — the
      // features are the real multiple comparisons. Only cells carrying a
      // significance verdict ('meta'/'single') and real variation enter;
      // effect-size-only cells ('metaProvisional', 'fewWalks') get no q.
      const testable = (row, m) => row.hasVariance && (m === 'meta' || m === 'single');
      const adjustChannel = (mKey, pKey, qKey) => {
        const fam = correlationMatrix.map(row => testable(row, row[mKey]) ? row[pKey] : NaN);
        const q = StatsMath.benjaminiHochberg(fam);
        correlationMatrix.forEach((row, i) => { row[qKey] = q[i]; });
      };
      adjustChannel('mPhasic', 'pPhasic', 'qPhasic');
      adjustChannel('mTonic',  'pTonic',  'qTonic');
      adjustChannel('mPeaks',  'pPeaks',  'qPeaks');

      // Per-road-class arousal: mean, std, autocorrelation-adjusted 95% CI,
      // peak rate. 'unclassified' (OSM's mixed-bag minor-road tag) and any
      // class with under 5 s of data are dropped.
      const ROAD_SKIP = new Set(['unclassified']);
      const roadGroups = new Map();
      allData.forEach(d => {
        const cls = d.osm_road_class || 'none';
        let g = roadGroups.get(cls);
        if (!g) { g = { phasicVals: [], tonicVals: [], byWalk: new Map(), peaks: 0 }; roadGroups.set(cls, g); }
        g.phasicVals.push(d.phasic);
        g.tonicVals.push(d.tonic);
        // Also keep per-walk sub-arrays: the CI's effective sample size must be
        // estimated *within* each walk and summed, never off the walks stitched
        // end to end (that autocorrelation runs across recording boundaries and
        // is meaningless).
        let w = g.byWalk.get(d.trackId);
        if (!w) { w = { phasicVals: [], tonicVals: [] }; g.byWalk.set(d.trackId, w); }
        w.phasicVals.push(d.phasic);
        w.tonicVals.push(d.tonic);
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
        if (ROAD_SKIP.has(key)) return;
        const n = val.phasicVals.length;
        if (n < 5) return;
        const meanPhasic = val.phasicVals.reduce((s, v) => s + v, 0) / n;
        const meanTonic = val.tonicVals.reduce((s, v) => s + v, 0) / n;
        const stdPhasic = Math.sqrt(val.phasicVals.reduce((s, v) => s + (v - meanPhasic) ** 2, 0) / n);
        const stdTonic = Math.sqrt(val.tonicVals.reduce((s, v) => s + (v - meanTonic) ** 2, 0) / n);
        // CI uses the effective sample size, not the raw second count:
        // consecutive 1 Hz EDA samples are correlated, so sqrt(n) overstates
        // precision. Effective N is summed over per-walk estimates so the
        // autocorrelation is measured within a recording, not across the join.
        const walkArrs = [...val.byWalk.values()];
        const nEffPhasic = walkArrs.reduce((s, w) => s + StatsMath.effectiveSampleSize(w.phasicVals), 0);
        const nEffTonic  = walkArrs.reduce((s, w) => s + StatsMath.effectiveSampleSize(w.tonicVals), 0);
        const ciPhasic = nEffPhasic > 1 ? 1.96 * stdPhasic / Math.sqrt(nEffPhasic) : 0;
        const ciTonic = nEffTonic > 1 ? 1.96 * stdTonic / Math.sqrt(nEffTonic) : 0;
        roadProfile.push({
          name: key,
          timeSpent: n,
          effSamples: Math.round(nEffPhasic),
          meanPhasic,
          meanTonic,
          stdPhasic,
          stdTonic,
          ciPhasic,
          ciTonic,
          peakRate: (val.peaks / (n / 60)),
          _phasicVals: val.phasicVals,
          _nEffPhasic: nEffPhasic
        });
      });
      roadProfile.sort((a, b) => b.meanPhasic - a.meanPhasic);

      // Highest vs lowest road class: a Welch t-test on effective sample
      // sizes (a CI-overlap check is not a valid significance test), using the
      // per-walk-summed effective N so the autocorrelation isn't measured
      // across the joins between walks. hi and lo are the extremes of
      // `roadProfile.length` group means, picked *after* seeing the data —
      // testing that gap as if it were pre-specified inflates the false-positive
      // rate, so Bonferroni-adjust the p by the number of pairwise contrasts
      // that could have been the widest (k choose 2).
      let roadComparison = null;
      if (roadProfile.length >= 2) {
        const hi = roadProfile[0];
        const lo = roadProfile[roadProfile.length - 1];
        const w = StatsMath.welchTTest(hi._phasicVals, lo._phasicVals, true,
                                       { a: hi._nEffPhasic, b: lo._nEffPhasic });
        const nPairs = roadProfile.length * (roadProfile.length - 1) / 2;
        roadComparison = {
          highName: hi.name, lowName: lo.name,
          highMean: hi.meanPhasic, lowMean: lo.meanPhasic,
          diffPct: lo.meanPhasic !== 0 ? (hi.meanPhasic - lo.meanPhasic) / lo.meanPhasic * 100 : 0,
          t: w.t, df: w.df, p: w.p,
          pAdj: Number.isFinite(w.p) ? Math.min(1, w.p * nPairs) : w.p,
          nGroups: roadProfile.length
        };
      }
      roadProfile.forEach(p => { delete p._phasicVals; delete p._nEffPhasic; }); // drop internals before caching

      cacheTarget._cachedEnvStats = {
        latency,
        trackCount: activeTracks.length,
        trackIds: trackIdsStr,
        versionSig,
        allData,
        correlationMatrix,
        roadProfile,
        roadComparison
      };
    }

    // ── Render from the cache ─────────────────────────────────────────────
    const cachedStats = cacheTarget._cachedEnvStats;
    const hasEmFog = cachedStats.correlationMatrix.some(r => r.key === 'em_fog');

    // enriched-walk count is cached; totalWalks (incl. not-yet-enriched) is live.
    GSRUI.syncScatterEnvOptions(hasEmFog);
    GSRUI.renderCorrelationTable(cachedStats.correlationMatrix, cachedStats.trackCount, totalWalks);
    GSRUI.drawRegressionScatterPlot(cachedStats.allData);
    GSRUI.renderRoadProfile(cachedStats.roadProfile, cachedStats.roadComparison);
  },

  /**
   * Rebuild the #scatterEnvMetric <option> list from GSR_CONST.OSM_METRICS
   * (continuous + binary) plus EM Fog when present, keeping it in step with
   * the correlation-matrix feature set. Preserves the current selection when
   * still valid; no-ops when the option set is unchanged.
   */
  syncScatterEnvOptions(hasEmFog) {
    const sel = document.getElementById('scatterEnvMetric');
    if (!sel) return;
    const opts = GSR_CONST.OSM_METRICS
      .filter(m => m.kind === 'continuous' || m.kind === 'binary')
      .map(m => ({ value: m.field, label: m.unit ? `${m.label} (${m.unit})` : m.label }));
    if (hasEmFog) opts.push({ value: 'em_fog', label: 'EM Fog Index (0-100)' });

    const signature = opts.map(o => o.value).join(',');
    if (sel.dataset.optionSig === signature) return; // already current
    const prev = sel.value;
    sel.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    sel.value = opts.some(o => o.value === prev) ? prev : opts[0].value;
    sel.dataset.optionSig = signature;
  },

  /**
   * Effect-size band for a correlation coefficient — the primary cue in the
   * correlation table, since with a large n a negligible r can still be
   * "significant". Thresholds |r| .10 / .20 / .30 follow Gignac & Szodorai
   * (2016) for individual-differences research.
   * negligible <.10 · small .10–.20 · moderate .20–.30 · strong ≥.30.
   */
  correlationBand(r) {
    const a = Math.abs(r);
    if (!(a >= 0.10)) return { key: 'negligible', label: 'negligible' };
    if (a < 0.20) return { key: 'small', label: 'small' };
    if (a < 0.30) return { key: 'moderate', label: 'moderate' };
    return { key: 'strong', label: 'strong' };
  },

  /**
   * Render the cached correlation matrix to HTML. Effect-size band leads;
   * significance (or, with too few walks, effect size alone) only qualifies it.
   */
  renderCorrelationTable(matrix, enrichedWalks, totalWalks) {
    const tbody = document.querySelector('#correlationTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const used = enrichedWalks || (matrix.length ? matrix[0].featureWalks : 1);
    const loaded = totalWalks || used;
    // A cell's method is per channel; 'meta'/'single' carry a real verdict,
    // 'metaProvisional'/'fewWalks' are effect-size-only.
    const isTested = (m) => m === 'meta' || m === 'single';

    const noteEl = document.getElementById('correlationMethodNote');
    if (noteEl) {
      const anyMeta = matrix.some(r => r.mPhasic === 'meta' || r.mTonic === 'meta' || r.mPeaks === 'meta');
      // How many of the used walks each varying factor actually varied in.
      const ks = matrix.filter(r => r.hasVariance)
        .map(r => Math.max(r.kPhasic || 0, r.kTonic || 0, r.kPeaks || 0));
      const kLo = ks.length ? Math.min(...ks) : 0;
      const kHi = ks.length ? Math.max(...ks) : 0;
      const kRange = kLo === kHi ? `${kHi}` : `${kLo}–${kHi}`;

      const notEnriched = loaded > used
        ? `<strong>${used} of your ${loaded} walks are OSM-enriched</strong> — the analysis uses those ${used}; enrich the rest from the OSM panel to include them. `
        : '';

      if (used === 1) {
        noteEl.innerHTML = notEnriched + 'Single walk: <em>r</em> and <em>q</em> come from one recording, corrected for serial autocorrelation. Add walks to test whether an effect replicates.';
      } else if (anyMeta) {
        noteEl.innerHTML = notEnriched +
          `<strong>${used} walks analysed.</strong> <em>q</em> tests whether an effect is <strong>consistent across walks</strong> ` +
          `(random-effects meta-analysis — per-walk <em>r</em> weighted by its effective sample size, DerSimonian–Laird heterogeneity). <em>r</em> is the typical per-walk value. ` +
          `A "<em>k / ${used}</em>" tag means the factor varied enough to correlate in only <em>k</em> of the ${used} — need 5 for a verdict.`;
      } else {
        noteEl.innerHTML = notEnriched +
          `<strong>${used} walks analysed</strong>, but each factor varied enough to correlate in only <strong>${kRange} of ${used}</strong> ` +
          `(the "<em>k / ${used}</em>" tag) — need 5 for a consistency test, so no <em>q</em> yet. <em>r</em> is the typical per-walk value. ` +
          `A walk only counts toward a factor if that factor changes during it — short walks, and walks that stay in one kind of place, don't.`;
      }
    }

    const formatP = (p) => {
      if (p < 0.001) return '<0.001';
      if (p < 0.01) return p.toFixed(4);
      return p.toFixed(3);
    };

    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    const dirWord = (r) => (r > 0 ? 'higher' : 'lower');

    // Leads with the effect-size word so a reliable-but-tiny correlation
    // reads as "negligible", not as a finding.
    const getInterpretation = (row) => {
      if (!row.hasVariance) return 'Not enough variation to measure — this factor barely changes along the route';
      const chans = [
        { q: row.qPhasic, p: row.pPhasic, r: row.rPhasic, m: row.mPhasic, k: row.kPhasic, name: 'momentary arousal' },
        { q: row.qPeaks,  p: row.pPeaks,  r: row.rPeaks,  m: row.mPeaks,  k: row.kPeaks,  name: 'arousal-response rate' },
        { q: row.qTonic,  p: row.pTonic,  r: row.rTonic,  m: row.mTonic,  k: row.kTonic,  name: 'baseline arousal' },
      ];
      const byEffect = (a, b) => Math.abs(b.r) - Math.abs(a.r);

      const sig = chans.filter(c => isTested(c.m) && typeof c.q === 'number' && isFinite(c.q) && c.q < 0.05).sort(byEffect);
      if (sig.length > 0) {
        const top = sig[0];
        const band = GSRUI.correlationBand(top.r);
        if (band.key === 'negligible') return `Reliable but negligible (r ≈ ${top.r.toFixed(2)}) — detectable, too small to matter`;
        const how = top.m === 'meta' ? `consistent across your ${top.k} walks` : 'statistically reliable';
        return `${cap(band.label)} link to ${dirWord(top.r)} ${top.name} (r = ${top.r.toFixed(2)}), ${how}`;
      }

      const best = chans.slice().sort(byEffect)[0];
      const bestBand = GSRUI.correlationBand(best.r);
      if (bestBand.key === 'negligible') return 'No link to arousal — effect sizes are negligible';

      if (best.m === 'meta') {
        // Raw meta p < .05 but q ≥ .05 → real-looking, just doesn't clear the
        // multiple-comparison bar. Worth flagging as suggestive, not "nothing".
        const rawSig = typeof best.p === 'number' && isFinite(best.p) && best.p < 0.05;
        if (rawSig) {
          return `Suggestive ${bestBand.label} link to ${dirWord(best.r)} ${best.name} ` +
                 `(r = ${best.r.toFixed(2)}, p = ${formatP(best.p)} before correction) — doesn't survive correction for testing every factor; more walks may confirm`;
        }
        return `Apparent ${bestBand.label} link to ${dirWord(best.r)} ${best.name} (r = ${best.r.toFixed(2)}) — inconsistent across the ${best.k} walks it varied in`;
      }
      if (best.m === 'metaProvisional' || best.m === 'fewWalks') {
        return `${cap(bestBand.label)} link to ${dirWord(best.r)} ${best.name} (r = ${best.r.toFixed(2)}) — but this factor varied in only ${best.k} of ${used} walks; need 5 to test consistency`;
      }
      return `Apparent ${bestBand.label} link to ${dirWord(best.r)} ${best.name} (r = ${best.r.toFixed(2)}) — not statistically reliable from this data`;
    };

    matrix.forEach(row => {
      const tr = document.createElement('tr');
      // r cell = number (coloured by direction) + a chip: "no variation" for a
      // constant factor; else the effect-size band, tagged with the verdict
      // ("· n.s." when tested and q ≥ .05) or, when there aren't enough walks
      // to test, "· k/N" (varied in k of the N analysed walks).
      const cell = (r, q, m, k) => {
        const dir = Math.abs(r) < 0.10 ? 'dir-none' : (r >= 0 ? 'dir-pos' : 'dir-neg');
        let chip;
        if (!row.hasVariance) {
          chip = '<span class="mag-chip mag-negligible mag-ns">no variation</span>';
        } else {
          const band = GSRUI.correlationBand(r);
          let tag = '';
          if (isTested(m)) {
            const isSig = typeof q === 'number' && isFinite(q) && q < 0.05;
            tag = isSig ? '' : ' · n.s.';
          } else {
            tag = ` · ${k}/${used}`;
          }
          const muted = tag ? ' mag-ns' : '';
          chip = `<span class="mag-chip mag-${band.key}${muted}">${band.label}${tag}</span>`;
        }
        return `<td class="corr-cell"><span class="corr-num ${dir}">${r.toFixed(3)}</span>${chip}</td>`;
      };
      const qCell = (q, m) => (row.hasVariance && isTested(m) && typeof q === 'number' && isFinite(q)) ? formatP(q) : '—';
      tr.innerHTML = `
        <td><strong>${row.name}</strong></td>
        ${cell(row.rPhasic, row.qPhasic, row.mPhasic, row.kPhasic)}
        ${cell(row.rTonic, row.qTonic, row.mTonic, row.kTonic)}
        ${cell(row.rPeaks, row.qPeaks, row.mPeaks, row.kPeaks)}
        <td>${qCell(row.qPhasic, row.mPhasic)}</td>
        <td>${qCell(row.qTonic, row.mTonic)}</td>
        <td>${qCell(row.qPeaks, row.mPeaks)}</td>
        <td>${getInterpretation(row)}</td>
      `;
      tbody.appendChild(tr);
    });
  },

  /**
   * Render cached road profile stats to HTML.
   */
  renderRoadProfile(profile, comparison) {
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
        <td>${p.timeSpent} s <span style="color: var(--text-muted); font-size: 0.78rem;">(~${p.effSamples} eff.)</span></td>
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

      // Wide CI relative to the mean = unreliable estimate.
      const unreliable = profile.filter(p => p.ciPhasic > p.meanPhasic * 0.5);
      const reliable = profile.filter(p => p.ciPhasic <= p.meanPhasic * 0.3);

      const lines = [];

      // Main comparison
      if (highest !== lowest) {
        const diff = ((highest.meanPhasic - lowest.meanPhasic) / lowest.meanPhasic * 100);
        lines.push(`Your strongest arousal was on <strong>${highest.name}</strong> roads (${highest.meanPhasic.toFixed(3)} μS), ` +
          `which is <strong>${Math.abs(diff).toFixed(0)}% ${diff > 0 ? 'higher' : 'lower'}</strong> ` +
          `than ${lowest.name} roads (${lowest.meanPhasic.toFixed(3)} μS).`);
      }

      // Welch t-test (effective sample sizes) for the highest-vs-lowest gap.
      // This is the widest gap among `nGroups` road classes, picked after
      // seeing the means, so the verdict uses the selection-corrected pAdj
      // (Bonferroni over the k-choose-2 contrasts), with the raw p shown too.
      if (comparison && isFinite(comparison.pAdj)) {
        const fmtP = (v) => v < 0.001 ? 'p &lt; 0.001' : 'p = ' + v.toFixed(3);
        const selNote = (comparison.nGroups > 2)
          ? ` (widest gap among ${comparison.nGroups} road classes, so corrected for that choice; raw ${fmtP(comparison.p)})`
          : '';
        if (comparison.pAdj < 0.05) {
          lines.push(`A Welch <em>t</em>-test says this gap is <strong>statistically reliable</strong> ` +
            `(${fmtP(comparison.pAdj)}, t = ${comparison.t.toFixed(2)}, df ≈ ${comparison.df.toFixed(0)})${selNote} — ` +
            `unlikely to be sampling noise, though this is one walk in one set of places, not a controlled comparison.`);
        } else {
          lines.push(`A Welch <em>t</em>-test says this gap is <strong>not statistically reliable</strong> ` +
            `(${fmtP(comparison.pAdj)})${selNote} — it could easily be sampling noise, so treat the ordering with caution.`);
        }
      }

      // Reliability notes
      if (unreliable.length > 0) {
        lines.push(`⚠️ <strong>Low confidence:</strong> ${unreliable.map(p =>
          `${p.name} (~${p.effSamples} independent samples, CI ±${p.ciPhasic.toFixed(3)})`
        ).join(', ')} — treat these numbers as rough estimates.`);
      }
      if (reliable.length > 0) {
        const best = reliable.slice().sort((a, b) => b.effSamples - a.effSamples)[0];
        lines.push(`✅ <strong>Most reliable:</strong> ${best.name} roads (~${best.effSamples} independent samples, CI ±${best.ciPhasic.toFixed(3)}) — the most trustworthy comparison point.`);
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
      roadBody.innerHTML = '<tr><td colspan="8" class="empty-row">No road classes with enough data to profile.</td></tr>';
    }
  },

  /**
   * Resize the canvas to its CSS box and draw the regression scatter plot
   * for the currently selected environmental factor vs arousal metric.
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
    const isBinaryX = GSR_CONST.OSM_METRICS.some(m => m.field === scatterXMetric && m.kind === 'binary');
    const yIsTonic = scatterYMetric !== 'phasic';
    dataSrc.forEach(d => {
      // Tonic uses the longer-lag environment, phasic the shorter-lag one —
      // same split as the correlation table.
      const src = (yIsTonic && d.tonicEnv) ? d.tonicEnv : d;
      let x = src[scatterXMetric];
      if (isBinaryX) x = (x === true || x === 1) ? 1 : (x === false || x === 0) ? 0 : NaN;
      const y = yIsTonic ? d.tonic : d.phasic;
      // 999.0 is the "no feature within radius" sentinel — not a distance.
      if (x !== null && x !== undefined && !isNaN(x) && x !== 999.0 && y !== null && y !== undefined && !isNaN(y)) {
        xVals.push(x);
        yVals.push(y);
      }
    });

    const { m, c, r2 } = StatsMath.calculateLinearRegression(xVals, yVals);

    // Axis labels from GSR_CONST.OSM_METRICS (continuous + binary, unit in
    // parens where present) plus EM Fog.
    const xLabels = {};
    GSR_CONST.OSM_METRICS
      .filter(m => m.kind === 'continuous' || m.kind === 'binary')
      .forEach(m => { xLabels[m.field] = m.unit ? `${m.label} (${m.unit})` : m.label; });
    xLabels['em_fog'] = 'EM Fog Index (0-100)';
    
    const yLabels = {
      'phasic': 'Phasic (momentary arousal)',
      'tonic': 'Tonic (baseline arousal)'
    };

    GSRUI.drawRegressionScatter(canvas, xVals, yVals, m, c, r2, xLabels[scatterXMetric], yLabels[scatterYMetric], isBinaryX);
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
