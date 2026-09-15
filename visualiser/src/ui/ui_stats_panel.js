/**
 * GSRUI — stats panel + detector-dependent control sync. Object-augment
 * split from ui.js: loaded immediately after ui.js, adds these methods to
 * the shared GSRUI object.
 *
 * Covers the four stat cards (updateStatsPanel), the spatial-data indicator
 * dot, the map-panel auto-collapse for trackless-GPS data, and the small
 * dropdown/label sync jobs that run after every analyze() call (deconv
 * truncation warning, Phasic AUC / graph-view / response-dynamics option
 * availability).
 */
(function () {
const __methods = {

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
    // Collective mode runs the same detector on every active track, so any one
    // of them hitting its iteration cap is worth surfacing — not just the one
    // AppState.analyzer currently points at.
    const analyzers = (AppState.viewMode === 'single')
      ? (AppState.analyzer ? [AppState.analyzer] : [])
      : (AppState.collectiveManager
          ? AppState.collectiveManager.getActiveTracks().map(t => t.analyzer).filter(Boolean)
          : []);
    const truncated = analyzers.some(a => a.phasicDeconvTruncated);
    el.style.display = truncated ? '' : 'none';
  },

  /**
   * The Phasic AUC metric is true ISCR only when it integrated the deconvolved
   * driver (analyzer.phasicAUCIsISCR — deconvolution / cvxEDA runs). Reflect
   * that in the graph-view and map-metric dropdown labels; in every other mode
   * it's the phasic-response integral and stays plain "Phasic AUC".
   */
  syncPhasicAUCLabels() {
    const txt = 'Phasic AUC' +
      ((AppState.analyzer && AppState.analyzer.phasicAUCIsISCR) ? ' (ISCR)' : '');
    for (const selId of ['graphView', 'mapColoringMetric']) {
      const opt = document.querySelector('#' + selId + ' option[value="phasicAUC"]');
      if (opt) opt.textContent = txt;
    }
  },

  /**
   * The 'phasicDriver' graph view plots analyzer.phasicDriver, which is only
   * populated while a deconvolution or cvxEDA detector is active. Enable the
   * dropdown option only in those modes; if it is the current selection when
   * the user switches to a non-deconvolution detector, drop back to 'signal'
   * so the plot never has to render an empty series. Called from runAnalysis()
   * (after each analyze()) and once at startup.
   */
  syncGraphViewDetectorOptions() {
    const sel = AppState.sliders && AppState.sliders.graphView;
    if (!sel) return;
    const opt = sel.querySelector('option[value="phasicDriver"]');
    if (!opt) return;
    const hasDriver = !!(AppState.analyzer && AppState.analyzer.phasicDriver &&
      AppState.analyzer.phasicDriver.length > 0);
    opt.disabled = !hasDriver;
    if (!hasDriver && sel.value === 'phasicDriver') {
      sel.value = 'signal';
      GSREvents.applyGraphView();
    }
  },

  /**
   * The 'responseDynamics' graph view and map coloring metric plot the continuous
   * response speed multiplier computed during SparsEDA deconvolution.
   * Enable the dropdown option in both #graphView and #mapColoringMetric only when
   * SparsEDA is active; if either is the current selection when the user switches
   * away from SparsEDA, fall back cleanly to 'signal' (graph) or 'gsr' (map).
   */
  syncResponseDynamicsOptions() {
    const isSparsEDA = !!(AppState.analyzer && AppState.analyzer._driverAlgorithm === 'sparseda');

    // 1. Graph view dropdown
    const graphSel = (AppState.sliders && AppState.sliders.graphView) || (typeof document !== 'undefined' && document.getElementById('graphView'));
    if (graphSel && typeof graphSel.querySelector === 'function') {
      const opt = graphSel.querySelector('option[value="responseDynamics"]');
      if (opt) opt.disabled = !isSparsEDA;
      if (!isSparsEDA && graphSel.value === 'responseDynamics') {
        graphSel.value = 'signal';
        if (typeof GSREvents !== 'undefined' && typeof GSREvents.applyGraphView === 'function') {
          GSREvents.applyGraphView();
        }
      }
    }

    // 2. Map metric dropdown
    const mapSel = (typeof document !== 'undefined' && document.getElementById('mapColoringMetric'));
    if (mapSel && typeof mapSel.querySelector === 'function') {
      const opt = mapSel.querySelector('option[value="responseDynamics"]');
      if (opt) opt.disabled = !isSparsEDA;
      if (!isSparsEDA && mapSel.value === 'responseDynamics') {
        mapSel.value = 'gsr';
        if (typeof Event !== 'undefined') {
          mapSel.dispatchEvent(new Event('change'));
        }
      }
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
    const el = AppState.statFields?.spatialData;
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
   * Automatically manage the map window (#mapPanel) collapsed state based on
   * whether the active track (or collective tracks) have spatial data.
   * Tracks with no spatial data (like track 27) collapse the map window to free
   * vertical layout space. Switching to a track with spatial data restores it
   * if it was auto-collapsed.
   *
   * @param {object} [track] - Optional track object.
   */
  syncMapPanelForSpatialData(track) {
    const mapPanel = document.getElementById('mapPanel');
    if (!mapPanel) return;

    let hasSpatial = false;
    const isCollective = typeof AppState !== 'undefined' && AppState.viewMode === 'collective';
    if (isCollective) {
      const activeTracks = (AppState.collectiveManager && typeof AppState.collectiveManager.getActiveTracks === 'function')
        ? AppState.collectiveManager.getActiveTracks()
        : [];
      hasSpatial = activeTracks.some(t => t.analyzer && (t.analyzer.hasSpatialData || (t.analyzer.raw && t.analyzer.raw.some(d => d.hasGps))));
    } else {
      const targetTrack = track || (typeof AppState !== 'undefined' && AppState.collectiveManager && AppState.activeTrackId ? AppState.collectiveManager.getTrack(AppState.activeTrackId) : null);
      const analyzer = targetTrack ? targetTrack.analyzer : (typeof AppState !== 'undefined' ? AppState.analyzer : null);
      hasSpatial = !!(analyzer && (analyzer.hasSpatialData || (analyzer.raw && analyzer.raw.some(d => d.hasGps))));
    }

    if (!hasSpatial) {
      mapPanel.dataset.autoCollapsedNoSpatial = 'true';
      if (!mapPanel.classList.contains('collapsed')) {
        mapPanel.classList.add('collapsed');
        if (typeof windowResized === 'function') {
          requestAnimationFrame(() => windowResized());
          setTimeout(() => windowResized(), 220);
        }
      }
    } else if (mapPanel.dataset.autoCollapsedNoSpatial === 'true') {
      mapPanel.classList.remove('collapsed');
      delete mapPanel.dataset.autoCollapsedNoSpatial;
      if (typeof AppState !== 'undefined' && AppState.mapManager && AppState.mapManager.map && typeof AppState.mapManager.map.invalidateSize === 'function') {
        AppState.mapManager.map.invalidateSize({ pan: false, debounceMoveend: true });
      }
      if (typeof windowResized === 'function') {
        requestAnimationFrame(() => windowResized());
        setTimeout(() => windowResized(), 220);
      }
    }
  },

};

if (typeof module !== 'undefined' && module.exports) {
  Object.assign(global, require('./ui.js'));
  module.exports = __methods;
} else {
  Object.assign(GSRUI, __methods);
}
})();
