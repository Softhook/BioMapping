/**
 * UI Actions — analysis pipeline, timeline view, cross-cutting helpers.
 * Event binding and DOM caching live in events.js.
 * Track library CRUD lives in tracks.js.
 * All shared state is accessed through AppState.
 *
 * Everything else GSRUI used to hold now lives in topic-split sibling
 * modules (ui_peaks_table.mjs, ui_stats_panel.mjs, ui_collective_map.mjs,
 * ui_export.mjs, ui_osm_overlay.mjs, ui_enrichment.mjs, ui_correlation_table.mjs,
 * ui_road_profile.mjs, ui_environmental_dashboard.mjs, ui_modals.mjs), composed
 * into GSRUI below.
 */

import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { GSRStorage } from './storage.mjs';
import { CollectiveMapUI } from './ui_collective_map.mjs';
import { CorrelationTableUI } from './ui_correlation_table.mjs';
import { EnrichmentUI } from './ui_enrichment.mjs';
import { EnvironmentalDashboardUI } from './ui_environmental_dashboard.mjs';
import { ExportUI } from './ui_export.mjs';
import { ModalsUI } from './ui_modals.mjs';
import { OsmOverlayUI } from './ui_osm_overlay.mjs';
import { PeaksTableUI } from './ui_peaks_table.mjs';
import { RoadProfileUI } from './ui_road_profile.mjs';
import { StatsPanelUI } from './ui_stats_panel.mjs';

export const GSRUI = {
  ...PeaksTableUI,
  ...StatsPanelUI,
  ...CollectiveMapUI,
  ...ExportUI,
  ...OsmOverlayUI,
  ...EnrichmentUI,
  ...CorrelationTableUI,
  ...RoadProfileUI,
  ...EnvironmentalDashboardUI,
  ...ModalsUI,

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
      const activeTrack = AppState.collectiveManager.getTrack(
        AppState.activeTrackId,
      );
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
      Controllers.trackManager.saveActiveGpsParams();
      AppState.mapManager.renderData(
        AppState.analyzer,
        GSRStorage.buildGpsParams(),
      );
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
        Controllers.trackManager.saveActiveTrackParams();
        AppState.analyzer.analyze(params, peakLatency);
        if (AppState.mapManager) {
          AppState.mapManager.renderData(
            AppState.analyzer,
            GSRStorage.buildGpsParams(),
          );
        }
      } else {
        if (AppState.collectiveManager) {
          const activeTracks = AppState.collectiveManager.getActiveTracks();
          activeTracks.forEach((track) => {
            track.analyzer.analyze(params, peakLatency);
            track.filterParams = { ...params };
          });
        }
        GSRUI.updateCollectiveMap();
      }

      GSRUI.updateStatsPanel();
      GSRUI.updatePeaksTable();
      GSRUI.updateDeconvTruncationWarning();
      Controllers.events.syncTonicBaselineControls();
      GSRUI.syncPhasicAUCLabels();
      GSRUI.syncGraphViewDetectorOptions();
      GSRUI.syncResponseDynamicsOptions();
      GSRUI.syncMapPanelForSpatialData();
      redraw();
    } catch (err) {
      console.error('Analysis error:', err);
      alert(`Error running analysis: ${err.message}`);
    }
  },

  /**
   * Zoom the p5.js timeline view.
   */
  zoomCanvas(multiplier) {
    if (AppState.analyzer.raw.length === 0) return;

    const centerTime = AppState.viewStartTime + AppState.viewDuration / 2;

    AppState.viewDuration = constrain(
      AppState.viewDuration / multiplier,
      2.0,
      AppState.totalDuration,
    );
    AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;

    AppState.viewStartTime = centerTime - AppState.viewDuration / 2;
    AppState.viewStartTime = constrain(
      AppState.viewStartTime,
      0,
      Math.max(0, AppState.totalDuration - AppState.viewDuration),
    );

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

    document.querySelectorAll('#peaksTable tbody tr').forEach((r) => {
      r.classList.remove('active-row');
    });

    redraw();
  },

  /** Percentile of an already-ascending-sorted array (no copy, no re-sort). */
  _percentileSorted(s, p) {
    if (!s || s.length === 0) return 0;
    if (s.length === 1) return s[0];
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx),
      hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  },

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

    const warning =
      trackId === 'ALL'
        ? 'You have unsaved peak labels across loaded tracks.'
        : `Track "${trackName}" has unsaved peak labels.`;

    // Log the warning through the notices layer; the dialog below is the
    // visible notice and the decision point, so no duplicate toast.
    GSRNotices.warn(warning, 'unsaved-labels', { toast: false });

    const action = await GSRNotices.dialog({
      title: 'Unsaved Labels',
      message:
        trackId === 'ALL'
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
        if (Controllers.collectiveProject) {
          await Controllers.collectiveProject.exportProject();
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

Controllers.ui = GSRUI;
