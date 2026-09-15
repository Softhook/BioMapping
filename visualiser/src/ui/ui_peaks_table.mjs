/**
 * GSRUI — peak events table. Object-augment split from ui.js: loaded
 * immediately after ui.js, adds these methods to the shared GSRUI object.
 *
 * Covers per-peak label editing (table + map-popup + live-typing sync),
 * focusing/zooming the timeline and active map surface to a peak, exclusion
 * toggling, and building/sorting the #peaksTable rows.
 */
import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { GSRGlobe3DView } from '../map/globe3d_view.mjs';
import { getQualityColor, getQualityLabel } from '../render/renderer.mjs';
import { GSRStorage } from './storage.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
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
        // skipClustering: true — a label edit can't change the Arousal Places
        // clusterer's input (lat/lon/amplitude per non-excluded peak), so
        // recomputing the places here is provably wasted (see
        // refreshPeakMarkers()'s own doc comment and
        // docs/archive/visualizer_rendering_perf_routes.md §2.4).
        AppState.mapManager.refreshPeakMarkers(
          AppState.analyzer,
          GSRStorage.buildGpsParams(),
          { skipClustering: true },
        );
      }
      GSRUI.updatePeaksTable();
      redraw();
    } else if (AppState.mapManager) {
      const latSlider = AppState.sliders.gpsPeakLatency;
      const peakLatency = parseFloat(
        latSlider ? latSlider.value : GSR_CONST.GPS_DEFAULT.peakLatency,
      );
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
    const tableInput = document.querySelector(
      `.peak-label-input[data-peak-idx="${idx}"]`,
    );
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
    if (
      !AppState.analyzer ||
      !AppState.analyzer.peaks ||
      idx >= AppState.analyzer.peaks.length
    )
      return;
    const peak = AppState.analyzer.peaks[idx];
    AppState.activePeakIndex = idx;
    AppState.viewStartTime = Math.max(0, peak.onsetTime - 2);
    AppState.viewDuration = Math.min(
      peak.time - peak.onsetTime + 5,
      AppState.totalDuration,
    );
    AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;
    document
      .querySelectorAll('#peaksTable tbody tr')
      .forEach((r) => r.classList.remove('active-row'));
    const row = document.getElementById('peakRow-' + idx);
    if (row) row.classList.add('active-row');
    redraw();

    const hasGps =
      AppState.analyzer.raw && AppState.analyzer.raw.some((d) => d.hasGps);

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
      setTimeout(
        () => {
          row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },
        source === 'map' ? 100 : 0,
      );
    }

    // 3. Navigate the active map surface to the peak.
    if (source === 'table' && hasGps) {
      // SCR Events table: jump straight to the spot with the scrub dot as the
      // locator and no popup — works even when the peak-marker layer is hidden.
      if (
        AppState.surfaceView === 'globe' &&
        typeof GSRGlobe3DView !== 'undefined' &&
        GSRGlobe3DView.isActive
      ) {
        if (typeof GSRGlobe3DView.focusOnPeakLocation === 'function') {
          GSRGlobe3DView.focusOnPeakLocation(idx);
        }
      } else if (
        AppState.mapManager &&
        typeof AppState.mapManager.focusOnPeakLocation === 'function'
      ) {
        AppState.mapManager.focusOnPeakLocation(
          idx,
          AppState.analyzer,
          GSRStorage.buildGpsParams(),
        );
      }
    } else if (source !== 'map' && hasGps) {
      // Graph click: fly to the peak and open its popup.
      if (
        AppState.surfaceView === 'globe' &&
        typeof GSRGlobe3DView !== 'undefined' &&
        GSRGlobe3DView.isActive
      ) {
        if (typeof GSRGlobe3DView.focusOnPeak === 'function') {
          GSRGlobe3DView.focusOnPeak(idx);
        }
      } else {
        // Phase 1 (slice 3): the peakMarkers flat array is gone; resolve the
        // marker for this peak index from the track layerGroups instead.
        const peakMarker =
          AppState.mapManager &&
          typeof AppState.mapManager.getPeakMarkerByIndex === 'function'
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
    // this does NOT pass skipClustering — excluding a peak changes the Arousal
    // Places clusterer's input set (activePeaks filters on ap.peak.excluded),
    // so the places must be recomputed here (see §2.4 and
    // refreshPeakMarkers()'s own doc comment).
    if (AppState.viewMode === 'single') {
      GSRUI.updatePeaksTable();
      redraw();
      if (AppState.mapManager) {
        AppState.mapManager.refreshPeakMarkers(
          AppState.analyzer,
          GSRStorage.buildGpsParams(),
        );
      }
    } else {
      GSRUI.updateCollectiveMap();
    }
  },

  /**
   * Sort the peaks table by a column key ('index'|'label'|'amplitude'|'riseTime'|'quality'|'excluded').
   */
  sortPeaksTable(col) {
    if (!col) return;
    if (AppState.peakSortColumn === col) {
      AppState.peakSortDirection =
        AppState.peakSortDirection === 'asc' ? 'desc' : 'asc';
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

    ths.forEach((th) => {
      const col = th.dataset.sort;
      const icon = th.querySelector('.sort-icon');
      if (col === curCol) {
        th.classList.remove('sort-asc', 'sort-desc');
        th.classList.add(curDir === 'desc' ? 'sort-desc' : 'sort-asc');
        if (icon) {
          icon.className =
            'fa-solid ' +
            (curDir === 'desc' ? 'fa-sort-down' : 'fa-sort-up') +
            ' sort-icon';
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
    const peaks =
      AppState.analyzer && AppState.analyzer.peaks
        ? AppState.analyzer.peaks
        : [];
    const tb = AppState.tableBody;

    if (!tb) return;

    if (peaks.length === 0) {
      tb.innerHTML =
        '<tr class="empty-row"><td colspan="7">No peaks detected. Try reducing the Peak Amplitude threshold.</td></tr>';
      this.updatePeaksTableSortHeaders();
      return;
    }

    const sortCol = AppState.peakSortColumn || 'index';
    const sortDir = AppState.peakSortDirection === 'desc' ? -1 : 1;

    // Create array of { p, idx } pairs to sort without mutating AppState.analyzer.peaks
    const indexedPeaks = peaks.map((p, idx) => ({ p, idx }));
    const getRiseTime = (p) => p.riseTime ?? p.time - p.onsetTime ?? 0;

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

    let rowsHtml = '';
    indexedPeaks.forEach(({ p, idx }) => {
      const rowClass = [];
      if (idx === AppState.activePeakIndex) rowClass.push('active-row');
      if (p.excluded) rowClass.push('excluded-row');
      const rowAttr =
        rowClass.length > 0 ? "class='" + rowClass.join(' ') + "'" : '';
      const riseTimeStr = getRiseTime(p).toFixed(2);
      const qScore = p.qualityScore !== undefined ? p.qualityScore : 0;
      const qColor = getQualityColor(qScore, '20');
      const { pct: qPct, label: qLabel } = getQualityLabel(qScore);

      const escapedLabel =
        typeof GSRNotices !== 'undefined' &&
        typeof GSRNotices.escapeHtml === 'function'
          ? GSRNotices.escapeHtml(p.label || '')
          : (p.label || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');

      const speedBadge = p.speedLabel
        ? '<span class="badge-speed speed-' +
          p.speedLabel.toLowerCase().replace(/\s+/g, '-') +
          '" title="SparsEDA dynamics: ' +
          p.speedLabel +
          ' (' +
          (p.scaleFactor || 1) +
          'x)">' +
          p.speedLabel +
          '</span>'
        : '';

      rowsHtml +=
        '<tr id="peakRow-' +
        idx +
        '" ' +
        rowAttr +
        ' onclick="GSRUI.focusOnPeak(' +
        idx +
        ", 'table')\">" +
        '<td>' +
        (idx + 1) +
        '</td>' +
        '<td class="label-cell">' +
        '<textarea class="peak-label-input" rows="1" ' +
        'placeholder="Add label…" data-peak-idx="' +
        idx +
        '" ' +
        'onclick="event.stopPropagation();" ' +
        'oninput="GSRUI.handleLiveLabelInput(' +
        idx +
        ", this.value); this.style.height='auto'; this.style.height=this.scrollHeight+'px';\" " +
        'onchange="GSRUI.updatePeakLabel(' +
        idx +
        ', this.value)" ' +
        "onkeydown=\"if(event.key==='Enter') { event.preventDefault(); GSRUI.updatePeakLabel(" +
        idx +
        ', this.value); this.blur(); }">' +
        escapedLabel +
        '</textarea>' +
        '</td>' +
        '<td>' +
        p.amplitude.toFixed(4) +
        '</td>' +
        '<td>' +
        riseTimeStr +
        speedBadge +
        '</td>' +
        '<td style="background:' +
        qColor +
        '">' +
        qPct +
        '% ' +
        qLabel +
        '</td>' +
        '<td class="exclude-cell"><button class="btn-exclude" ' +
        'onclick="event.stopPropagation(); GSRUI.togglePeakExclusion(' +
        idx +
        ')" ' +
        'title="' +
        (p.excluded ? 'Include peak' : 'Exclude peak') +
        '">' +
        (p.excluded
          ? '<i class="fa-solid fa-plus"></i>'
          : '<i class="fa-solid fa-xmark"></i>') +
        '</button></td>' +
        '<td><button class="btn-table-action" onclick="event.stopPropagation(); GSRUI.focusOnPeak(' +
        idx +
        ", 'table')\">" +
        '<i class="fa-solid fa-arrows-to-eye"></i> View</button></td></tr>';
    });

    tb.innerHTML = rowsHtml;

    // Update header sort indicators
    this.updatePeaksTableSortHeaders();

    // Auto-size all rendered textareas
    setTimeout(() => {
      tb.querySelectorAll('.peak-label-input').forEach((ta) => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });
    }, 0);
  },
};

Object.assign(GSRUI, __methods);
