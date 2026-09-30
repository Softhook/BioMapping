/**
 * Track Library Management — the track object, switching and deleting
 * tracks, and each track's saved slider settings. File loading lives in
 * track_loading.mjs and the sidebar list in track_list.mjs; both are spread
 * into GSRTrackManager below.
 */

import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { windowResized } from '../render/sketch.mjs';
import { GSRAnalyzer } from '../signal/analyzer.mjs';
import { GSRStorage, normalizeDetectorCheckboxes } from './storage.mjs';
import { TrackList } from './track_list.mjs';
import { TrackLoading } from './track_loading.mjs';
import { GSRTrackQualityPopup } from './track_quality_popup.mjs';

export const GSRTrackManager = {
  ...TrackLoading,
  ...TrackList,

  /**
   * Buttons that only make sense once at least one track is loaded — kept in
   * one place so renderTrackList()'s empty-state branch and
   * switchActiveTrack() can't drift apart when a button gets added/removed.
   */
  EXPORT_BUTTON_IDS: [
    'exportCsvBtn',
    'exportImageBtn',
    'exportMapBtn',
    'exportSvgBtn',
    'exportCzmlBtn',
    'exportKmlBtn',
    'exportProjectBtn',
  ],

  /**
   * Get all enabled tracks — delegates to GSRCollectiveManager.
   */
  getActiveTracks() {
    return AppState.collectiveManager.getActiveTracks();
  },

  createTrackObject(trackId, trackName, trackColor, analyzer) {
    const filterParams =
      analyzer.importedFilterParams ||
      JSON.parse(JSON.stringify(GSR_CONST.GSR_DEFAULT));
    const gpsFilterParams =
      analyzer.importedGpsFilterParams ||
      JSON.parse(JSON.stringify(GSR_CONST.GPS_DEFAULT));

    return {
      id: trackId,
      name: trackName,
      color: trackColor,
      enabled: true,
      analyzer: analyzer,
      filterParams: filterParams,
      gpsFilterParams: gpsFilterParams,
      // Phase 1 (slice 1): the track's single Leaflet rendering handle — an
      // L.layerGroup() owning this track's path/peak/hotspot layers. Lazily
      // created by GSRMapManager._getTrackLayerGroup() on first render; null
      // when the track owns nothing on the map. Removing the track = removing
      // this group from the map.
      layerGroup: null,
      // Phase 1 (slice 3): the full registry of this track's render layers
      // (visible + hidden) so visibility toggles can restore hidden ones. The
      // layerGroup only holds the currently-visible layers. Populated by
      // GSRMapManager._registerTrackLayer().
      _ownedLayers: [],
    };
  },

  /**
   * Collective view's track-list click: fit the map to that walk without
   * selecting it or touching any settings.
   */
  zoomToTrack(trackId) {
    const track = AppState.collectiveManager.getTrack(trackId);
    const mm = AppState.mapManager;
    if (!track || typeof mm?.zoomToTrack !== 'function') return;
    if (!mm.zoomToTrack(track)) {
      GSRNotices.warn(`"${track.name}" has no GPS path to zoom to.`, 'zoom');
    }
  },

  switchActiveTrack(trackId) {
    GSRTrackQualityPopup.hide();
    AppState.activeTrackId = trackId;
    const track = AppState.collectiveManager.getTrack(trackId);
    if (!track) return;

    AppState.analyzer = track.analyzer;
    AppState.analyzer.rawMinMaxCached = null; // invalidate timeline cache
    AppState.totalDuration =
      AppState.analyzer.raw.length > 0 &&
      AppState.analyzer.raw[AppState.analyzer.raw.length - 1] &&
      AppState.analyzer.raw[0]
        ? AppState.analyzer.raw[AppState.analyzer.raw.length - 1].time -
          AppState.analyzer.raw[0].time
        : 0;

    GSRTrackManager.loadActiveTrackParams(track);
    GSRTrackManager.loadActiveGpsParams(track);
    Controllers.events.initializeLabels();
    Controllers.ui.resetView();
    Controllers.ui.runAnalysis();
    Controllers.ui.refreshOsmControls();
    GSRTrackManager.syncMapPanelForSpatialData(track);

    GSRTrackManager.EXPORT_BUTTON_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.removeAttribute('disabled');
    });

    const placeholder = document.getElementById('canvasPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    GSRTrackManager.renderTrackList();
    // No loop() here — the canvas renders on demand via the redraw() calls
    // already made above/below (resetView(), runAnalysis(), windowResized()'s
    // resizeCanvas()); see docs/archive/visualizer_rendering_perf_routes.md §2.5 for
    // why continuous looping was removed.
    requestAnimationFrame(() => windowResized());
  },

  /**
   * Wipe the entire track library back to a fresh-session state — every track,
   * the active-track pointer, and the map's rendered layers. Used by
   * GSRCollectiveProject.importProject() to clear the deck before restoring
   * tracks from a project zip; unlike deleteTrack() in a loop, this skips the
   * per-track teardown work (switching active track, re-analysing, etc.)
   * since the caller is about to rebuild everything from scratch anyway.
   */
  clearAllTracks() {
    GSRTrackQualityPopup.hide();
    if (
      Controllers.ui &&
      typeof Controllers.ui.cancelCollectiveMapUpdate === 'function'
    ) {
      Controllers.ui.cancelCollectiveMapUpdate();
    }
    AppState.collectiveManager.tracks = [];
    AppState.activeTrackId = null;
    AppState.analyzer = new GSRAnalyzer();
    AppState.trackColorIndex = 0; // restart the colour palette, matching a fresh page load
    // A project without saved Places settings must not inherit the last one's.
    GSRStorage.resetCollectivePlaces();

    if (AppState.mapManager) {
      AppState.mapManager.clearAll();
    }
    // clearMap() no longer drops the OSM overlay — reset + clear it here.
    if (Controllers.ui?.syncOsmOverlay) {
      Controllers.ui._osmOverlayOn = false;
      Controllers.ui.syncOsmOverlay();
    }
  },

  deleteTrack(trackId) {
    GSRTrackQualityPopup.hide();
    const track = AppState.collectiveManager.getTrack(trackId);
    if (!track) return;

    const performDelete = () => {
      // Save current GPS params before switching away
      GSRTrackManager.saveActiveGpsParams();

      // Phase 1 (slice 1): removal = map.removeLayer(track.layerGroup). Do this
      // before removing the track from the manager so the switch-active-track /
      // clearAll paths below never leave an orphaned group behind. Slice 2: also
      // forget the group from the map manager's rendered-set.
      if (AppState.mapManager?.map && track.layerGroup) {
        if (AppState.mapManager.map.hasLayer(track.layerGroup)) {
          AppState.mapManager.map.removeLayer(track.layerGroup);
        }
        track.layerGroup = null;
        AppState.mapManager._forgetTrackGroup(trackId);
      }

      AppState.collectiveManager.removeTrack(trackId);

      if (AppState.activeTrackId === trackId) {
        if (AppState.collectiveManager.tracks.length > 0) {
          GSRTrackManager.switchActiveTrack(
            AppState.collectiveManager.tracks[0].id,
          );
        } else {
          AppState.activeTrackId = null;
          AppState.analyzer = new GSRAnalyzer();
        }
      }

      // Phase 3 pilot (docs/archive/visualizer_architecture_refactor_plan.md): notify
      // interested modules instead of calling them directly by name.
      // GSRTrackManager (renderTrackList), GSRMapManager (clearAll when the
      // library goes empty), and GSRUI (updateCollectiveMap in collective
      // view) each subscribe to 'trackRemoved' independently — see the
      // AppState.on(...) registrations in sketch.js's setup().
      AppState.emit('trackRemoved', trackId);
      Controllers.ui?.refreshOsmControls?.();
      Controllers.ui?.updateEnvironmentalDashboard?.();
    };

    if (track.hasUnsavedLabels) {
      Controllers.ui.showUnsavedLabelsModal(track.name, trackId, performDelete);
    } else {
      performDelete();
    }
  },

  loadActiveTrackParams(track) {
    if (!track?.filterParams) return;
    // Fill any key the track's params lack from the shipped defaults — a
    // missing key would otherwise leave the previously open track's slider
    // value in place, and runAnalysis() would then analyse this track with it.
    const params = { ...GSR_CONST.GSR_DEFAULT, ...track.filterParams };
    const S = AppState.sliders;

    for (const key of Object.keys(params)) {
      // Params can come from an imported file: only touch real slider keys,
      // never inherited ones like "__proto__" (would pollute Object.prototype).
      if (!Object.hasOwn(S, key)) continue;
      if (
        key === 'useDeconvolution' ||
        key === 'useSparsEDA' ||
        key === 'usePeakProminence' ||
        key === 'useCvxEDA'
      )
        continue;
      // Checkboxes: assigning .value is a silent no-op, so the previous
      // track's ticked state would leak into this one.
      if (key === 'useGaitFilter' || key === 'repairGsrDisconnects') {
        if (S[key]) S[key].checked = !!params[key];
        continue;
      }
      if (S[key]) {
        // hotspotPercentile is stored as a 0–1 fraction but its slider is in
        // percent (0.5–10) — convert, or a default 0.02 clamps to the 0.5 min.
        // Mirrors GSRStorage.applyPreset().
        S[key].value =
          key === 'hotspotPercentile' && params[key] <= 1.0
            ? params[key] * 100.0
            : params[key];
      }
    }

    if (S.useDeconvolution) {
      S.useDeconvolution.checked = !!params.useDeconvolution;
    }
    if (S.useSparsEDA) {
      S.useSparsEDA.checked = !!params.useSparsEDA;
    }
    if (S.usePeakProminence) {
      S.usePeakProminence.checked = !!params.usePeakProminence;
    }
    if (S.useCvxEDA) {
      S.useCvxEDA.checked = !!params.useCvxEDA;
    }
    normalizeDetectorCheckboxes(S);
  },

  saveActiveTrackParams() {
    if (!AppState.activeTrackId) return;
    const track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
    if (!track) return;

    track.filterParams = GSRStorage.readGsrSliderValues();
  },

  saveActiveGpsParams() {
    // Collective view hides the per-track GPS controls, so there is nothing
    // of the active track's to save — and its Places sliders show Collective
    // view's own settings (GSRStorage.saveCollectivePlaces), not the track's.
    if (AppState.viewMode === 'collective') return;
    if (!AppState.activeTrackId) return;
    const track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
    if (!track) return;

    track.gpsFilterParams = GSRStorage.readGpsSliderValues();
  },

  loadActiveGpsParams(track) {
    if (!track?.gpsFilterParams) return;
    // Slider-key mapping lives once in GSRStorage.writeGpsSliderValues (its
    // mirror of saveActiveGpsParams' readGpsSliderValues). In Collective view
    // the Places sliders show Collective view's own settings, not the
    // track's; in Single view a walk saved before it had Places settings
    // gets the defaults rather than the previous slider value.
    if (AppState.viewMode === 'collective') {
      GSRStorage.writeGpsSliderValues(track.gpsFilterParams, {
        skipKeys: GSRStorage.PLACE_KEYS,
      });
      return;
    }
    const AP = GSR_CONST.AROUSAL_PLACES;
    GSRStorage.writeGpsSliderValues({
      placeMergeDistance: AP.mergeM,
      maxArousalPlaces: AP.maxPlaces,
      ...track.gpsFilterParams,
    });
  },

  /**
   * Sync map window collapse state based on active track's spatial data.
   * Delegates to GSRUI.syncMapPanelForSpatialData if available.
   *
   * @param {object} [track]
   */
  syncMapPanelForSpatialData(track) {
    if (
      Controllers.ui &&
      typeof Controllers.ui.syncMapPanelForSpatialData === 'function'
    ) {
      Controllers.ui.syncMapPanelForSpatialData(track);
    }
  },
};

Controllers.trackManager = GSRTrackManager;
