// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — The map panel's zoom/RF-fluid/shared 2D-3D toggles, coloring-metric selector, contour inputs, panel collapse buttons, and table column sorting. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRGlobe3DView } from '../map/globe3d_view.mjs';
import { JunctionDebug } from '../map/junction_debug.mjs';
import { windowResized } from '../render/sketch.mjs';
import { CONTOUR_SLIDER_DEFS } from './events_slider_defs.mjs';
import { GSRStorage } from './storage.mjs';
import { GSRTrackManager } from './tracks.mjs';

export const MapPanelEvents = {
  /**
   * View/surface switchers, contour inputs, the map panel's zoom/RF-fluid/shared 2D-3D toggles and coloring-metric selector, panel collapse buttons, and table column sorting.
   */
  _bindMapPanelControls() {
    // ── View Switcher ────────────────────────────────────────────────────────
    this.bindViewSwitcher();
    this.bindSurfaceSwitcher();
    this.bindMobileSidebar();

    // ── Contour Settings ─────────────────────────────────────────────────────
    this.bindContourInputs();

    // ── Map Panel Controls ───────────────────────────────────────────────────
    // One header, two engines: when the 3D globe is the mounted surface the
    // shared controls dispatch to it instead of / as well as the Leaflet map
    // (see GSRGlobe3DView.applyToggle / applyRfMode / zoom).
    const g3d = () =>
      typeof GSRGlobe3DView !== 'undefined' ? GSRGlobe3DView : null;
    const onGlobe = () => AppState.surfaceView === 'globe';

    document.getElementById('btnMapZoomIn').addEventListener('click', () => {
      if (onGlobe()) {
        if (g3d()) g3d().zoom(-1);
        return;
      }
      if (AppState.mapManager) AppState.mapManager.zoomIn();
    });
    document.getElementById('btnMapZoomOut').addEventListener('click', () => {
      if (onGlobe()) {
        if (g3d()) g3d().zoom(1);
        return;
      }
      if (AppState.mapManager) AppState.mapManager.zoomOut();
    });
    document
      .getElementById('btnMapZoomExtent')
      .addEventListener('click', () => {
        if (onGlobe()) {
          if (g3d()) g3d().fitTrack();
          return;
        }
        if (AppState.mapManager) AppState.mapManager.fitToTrack();
      });
    const btnToggleRFFluid = document.getElementById('btnToggleRFFluid');
    if (btnToggleRFFluid) {
      btnToggleRFFluid.addEventListener('click', () => {
        if (btnToggleRFFluid.hasAttribute('disabled')) return;
        btnToggleRFFluid.classList.toggle('active');
        const on = btnToggleRFFluid.classList.contains('active');
        if (AppState.mapManager) AppState.mapManager.toggleRFFluid(on);
        if (g3d()) g3d().applyToggle('rf', on);
      });
    }

    const rfFluidMode = document.getElementById('rfFluidMode');
    if (rfFluidMode) {
      rfFluidMode.addEventListener('change', (e) => {
        if (AppState.mapManager)
          AppState.mapManager.setRFFluidMode(e.target.value);
        if (g3d()) g3d().applyRfMode(e.target.value);
      });
    }

    const bindSharedToggle = (btnId, mmMethod, g3dName) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        const on = btn.classList.contains('active');
        if (AppState.mapManager) AppState.mapManager[mmMethod](on);
        if (g3d()) g3d().applyToggle(g3dName, on);
      });
    };
    bindSharedToggle('btnToggleMapPeaks', 'togglePeaks', 'peaks');
    bindSharedToggle('btnToggleMapHotspots', 'toggleHotspots', 'hotspots');
    bindSharedToggle('btnToggleMapLabels', 'toggleLabels', 'labels');
    bindSharedToggle('btnToggleMapClusters', 'toggleClusters', 'clusters');

    const btnJunctionDebug = document.getElementById('btnToggleJunctionDebug');
    if (btnJunctionDebug) {
      btnJunctionDebug.addEventListener('click', () => {
        btnJunctionDebug.classList.toggle('active');
        JunctionDebug.toggle(btnJunctionDebug.classList.contains('active'));
      });
      // Keep the overlay in step with track / snap / view changes.
      AppState.on('map:rendered', () => {
        if (JunctionDebug.isOn()) JunctionDebug.refresh();
      });
    }

    const btnToggleMapIsolines = document.getElementById(
      'btnToggleMapIsolines',
    );
    btnToggleMapIsolines.addEventListener('click', () => {
      btnToggleMapIsolines.classList.toggle('active');
      if (AppState.mapManager)
        AppState.mapManager.toggleIsolines(
          btnToggleMapIsolines.classList.contains('active'),
        );
    });

    const btnToggleMapSurface = document.getElementById('btnToggleMapSurface');
    const opacityGroup = document.getElementById('surfaceOpacityGroup');
    btnToggleMapSurface.addEventListener('click', () => {
      btnToggleMapSurface.classList.toggle('active');
      const isActive = btnToggleMapSurface.classList.contains('active');
      if (opacityGroup) {
        opacityGroup.classList.toggle('ctrl-inert', !isActive);
      }
      if (AppState.mapManager) AppState.mapManager.toggleSurface(isActive);
    });

    const btnToggleMapTracks = document.getElementById('btnToggleMapTracks');
    btnToggleMapTracks.addEventListener('click', () => {
      btnToggleMapTracks.classList.toggle('active');
      if (AppState.mapManager)
        AppState.mapManager.toggleTracks(
          btnToggleMapTracks.classList.contains('active'),
        );
    });

    document
      .getElementById('mapColoringMetric')
      .addEventListener('change', (e) => {
        if (AppState.mapManager) {
          AppState.mapManager.activeColoringMetric = e.target.value;
          // Only the path's colour changes here — a full rerenderMap() also
          // destroys/rebuilds peak+hotspot markers for no reason (perf-routes
          // doc §2.2). Single-track view has a scoped path-only refresh;
          // collective mode still does the full rebuild (out of scope for
          // this pass — renderCollectiveData()'s per-track loop needs its own
          // investigation before a partial-render path is worth the risk).
          if (
            AppState.viewMode === 'single' &&
            AppState.analyzer &&
            AppState.analyzer.raw.length > 0
          ) {
            GSRTrackManager.saveActiveGpsParams();
            AppState.mapManager.refreshPath(
              AppState.analyzer,
              GSRStorage.buildGpsParams(),
            );
          } else {
            Controllers.ui?.rerenderMap();
          }
        }
        // Forward the metric change to the 3D globe immediately when it is the
        // active surface. Without this the globe only updates after the map emits
        // 'map:rendered' → 250ms debounce → full renderData rebuild. The
        // setColoringMetric() fast path avoids that wall-primitive teardown.
        if (g3d()) g3d().applyColorMetric(e.target.value);
      });

    // ── Panel Collapse Toggles (DRY via bindCollapseButton) ──────────────────
    // The map panel's height now also tracks whether the GSR graph and events
    // table are collapsed: with the graph gone the map flex-grows to fill the
    // freed vertical space (see `#gsrPanel.collapsed ~ #mapPanel` in styles.css).
    // Collapsing a panel fires no resize event, so nudge Leaflet and the p5
    // canvas once the CSS max-height transition has settled.
    const refreshMapAfterPanelResize = () => {
      if (
        AppState.mapManager?.map &&
        typeof AppState.mapManager.map.invalidateSize === 'function'
      ) {
        AppState.mapManager.map.invalidateSize({
          pan: false,
          debounceMoveend: true,
        });
      }
      if (typeof windowResized === 'function') {
        requestAnimationFrame(() => windowResized());
        setTimeout(() => windowResized(), 320);
      }
    };

    this.bindCollapseButton(
      'btnEventsCollapse',
      'eventsPanel',
      refreshMapAfterPanelResize,
    );
    this.bindCollapseButton('btnGsrFilteringCollapse', 'gsrFilteringCard');
    this.bindCollapseButton('btnPeakDetectionCollapse', 'peakDetectionCard');
    this.bindCollapseButton('btnGpsFilteringCollapse', 'gpsFilteringCard');
    this.bindCollapseButton('btnMapDisplayCollapse', 'mapDisplayCard');
    this.bindCollapseButton('btnImportCollapse', 'importCard');
    this.bindCollapseButton('btnExportCollapse', 'exportCard');
    this.bindCollapseButton('btnContourCollapse', 'contourSettingsCard');
    // Collapsing the panel doesn't move the mouse, so no mouseleave fires on
    // the canvas — reset mouseOverCanvas here so mouseMoved() (sketch.js)
    // doesn't keep forcing redraws while the mouse sits over the collapsed
    // graph's old screen area. (handleScrubber's own elementFromPoint
    // hit-test is what actually keeps the scrubber from reactivating.)
    this.bindCollapseButton('btnGsrCollapse', 'gsrPanel', (collapsed) => {
      if (collapsed) {
        AppState.mouseOverCanvas = false;
        AppState.hoveredIndex = -1;
        if (AppState.scrubSource === 'graph') AppState.scrubSource = null;
        AppState.emit('scrub', { clear: true, source: 'graph' });
      }
      // Collapsing/expanding the graph resizes the map (see the CSS rule above).
      refreshMapAfterPanelResize();
    });
    this.bindCollapseButton('btnMapCollapse', 'mapPanel', () => {
      const mapPanel = document.getElementById('mapPanel');
      if (mapPanel) delete mapPanel.dataset.autoCollapsedNoSpatial;
      refreshMapAfterPanelResize();
    });
    this.bindCollapseButton('btnOsmEnrichmentCollapse', 'osmEnrichmentCard');
    this.bindCollapseButton('btnEnvCollapse', 'environmentalPanel');

    // ── Table Column Sorting ────────────────────────────────────────────────
    this.bindTableSort('peaksTable', 'sortPeaksTable');
    this.bindTableSort('correlationTable', 'sortCorrelationTable');
    this.bindTableSort('roadArousalTable', 'sortRoadArousalTable');
  },
  /**
   * Contour settings sliders.
   */
  bindContourInputs() {
    const triggerUpdate = this.rafCoalesce(() => {
      if (AppState.viewMode === 'collective')
        Controllers.ui?.updateCollectiveMap();
    });

    const bindCi = (id, labelId, fmt) => {
      const input = document.getElementById(id);
      const label = document.getElementById(labelId);
      // Initial dim state — matters for hillshadeStrength specifically,
      // whose default is 0 ("off"); the others can never reach 0 (all have
      // min > 0), so this is a no-op for them.
      this.updateFilterDim(input);
      input.addEventListener('input', () => {
        if (label) label.innerText = fmt(parseFloat(input.value));
        // Without this, a slider that starts at 0 (only hillshadeStrength
        // does) stays marked filter-off — and visually greyed out — forever
        // after the very first initializeLabels() sweep, even once dragged
        // up to a nonzero value: this listener is the only place hillshade's
        // own dim state gets re-evaluated on drag (unlike bindGsrSlider/
        // bindGpsSlider, which call updateFilterDim from their own input
        // handlers already).
        this.updateFilterDim(input);
        triggerUpdate();
      });
    };

    CONTOUR_SLIDER_DEFS.forEach((d) => {
      bindCi(d.id, d.labelId, d.fmt);
    });

    const topoSource = document.getElementById('topoSource');
    topoSource.addEventListener('change', () => {
      this.updatePeakPreservationInertState();
      triggerUpdate();
    });
    this.updatePeakPreservationInertState();

    const normalizeZ = document.getElementById('normalizeZScore');
    if (normalizeZ) {
      normalizeZ.addEventListener('change', triggerUpdate);
    }
  },
};
