// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — Single/Collective/Live view switcher and the mobile sidebar toggle. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRLayoutManager } from '../core/layout_manager.mjs';
import { GSRLiveView } from '../live/live_view.mjs';
import { GSRRenderer } from '../render/renderer.mjs';
import { windowResized } from '../render/sketch.mjs';

export const ViewSwitcherEvents = {
  /**
   * View switcher (Single Track ↔ Collective Map Surface).
   */
  bindViewSwitcher() {
    const btnSingleView = document.getElementById('btnSingleView');
    const btnCollectiveView = document.getElementById('btnCollectiveView');
    const btnLiveView = document.getElementById('btnLiveView');
    const livePanel = document.getElementById('livePanel');
    const appMainLayout = document.querySelector('.main-layout');
    const contourSettingsCard = document.getElementById('contourSettingsCard');

    // Leaving the Live view: drop the layout class and the tab highlight, and
    // let the live controller stand down (pause its redraw loop). It stays
    // mounted — an active BLE session and the accumulated packets are
    // untouched — so re-entering just resumes.
    const exitLiveView = () => {
      appMainLayout.classList.remove('live-mode');
      const appContainer = document.querySelector('.app-container');
      if (appContainer) appContainer.classList.remove('live-mode');
      if (btnLiveView) btnLiveView.classList.remove('active');
      // Restore the mobile hamburger — there are controls to reach again.
      const sbToggle = document.getElementById('btnSidebarToggle');
      if (sbToggle) sbToggle.hidden = false;
      // Drop the edge-to-edge display mode (F) if it was left on.
      if (GSRLayoutManager?._liveDisplayModeActive?.()) {
        GSRLayoutManager.exitLiveDisplayMode();
      }
      // In-app tab switch: pause rendering but keep BLE link live in background.
      if (GSRLiveView?._mounted) {
        GSRLiveView.deactivate(true);
      }
    };

    // Collective-only map toggle buttons (multi-track contour surface) —
    // meaningless in single-track view, so hidden there. See index.html.
    const collectiveOnlyMapBtns = [
      document.getElementById('btnToggleMapIsolines'),
      document.getElementById('btnToggleMapSurface'),
      document.getElementById('btnToggleMapTracks'),
    ].filter(Boolean);

    // The map-header metric dropdown has no per-track path colouring to drive
    // in collective view, so it is swapped there for #topoSource (the contour
    // surface's Topography Source). Exactly one of the two is visible per mode.
    const mapColoringMetric = document.getElementById('mapColoringMetric');
    const topoSourceSelect = document.getElementById('topoSource');
    const setHeaderMetricControl = (mode) => {
      if (mapColoringMetric)
        mapColoringMetric.style.display = mode === 'collective' ? 'none' : '';
      if (topoSourceSelect)
        topoSourceSelect.style.display = mode === 'collective' ? '' : 'none';
    };
    setHeaderMetricControl(AppState.viewMode);

    btnSingleView.addEventListener('click', () => {
      if (AppState.viewMode === 'single') return;
      AppState.viewMode = 'single';
      exitLiveView();
      btnSingleView.classList.add('active');
      btnCollectiveView.classList.remove('active');

      if (AppState.mapManager) {
        AppState.mapManager.clearCollectiveLayers();
      }
      appMainLayout.classList.remove('collective-mode');
      contourSettingsCard.style.display = 'none';
      collectiveOnlyMapBtns.forEach((btn) => {
        btn.style.display = 'none';
      });
      setHeaderMetricControl('single');

      const peakCard = document.getElementById('peakDetectionCard');
      if (peakCard) peakCard.style.display = '';

      const btnEnrich = document.getElementById('btnEnrichTrack');
      if (btnEnrich)
        btnEnrich.innerHTML =
          '<i class="fa-solid fa-wand-magic-sparkles"></i> Retrieve Spatial Data';

      document.getElementById('gsrPanel').style.display = '';
      document.getElementById('eventsPanel').style.display = '';

      // Force synchronous measurement of the new container size without panning the map
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
        windowResized();
      }
      if (AppState.analyzer && AppState.analyzer.raw.length > 0) {
        Controllers.ui?.runAnalysis();
      } else {
        noLoop();
        GSRRenderer.drawPlaceholder();
        if (AppState.mapManager) AppState.mapManager.clearMap();
      }
      Controllers.ui?.refreshOsmControls(); // resync OSM Layers button/indicator to the now-active single track
    });

    btnCollectiveView.addEventListener('click', () => {
      if (AppState.viewMode === 'collective') return;
      AppState.viewMode = 'collective';
      exitLiveView();
      btnCollectiveView.classList.add('active');
      btnSingleView.classList.remove('active');

      // Collective mode only supports the 2D map. If the 3D globe was active,
      // revert to the 2D map surface immediately.
      if (typeof Controllers.events?.setSurface === 'function') {
        Controllers.events.setSurface('map');
      }

      appMainLayout.classList.add('collective-mode');
      contourSettingsCard.style.display = '';
      collectiveOnlyMapBtns.forEach((btn) => {
        btn.style.display = '';
      });
      setHeaderMetricControl('collective');

      const peakCard = document.getElementById('peakDetectionCard');
      if (peakCard) peakCard.style.display = 'none';

      const btnEnrich = document.getElementById('btnEnrichTrack');
      if (btnEnrich)
        btnEnrich.innerHTML =
          '<i class="fa-solid fa-wand-magic-sparkles"></i> Retrieve Spatial Data';

      document.getElementById('gsrPanel').style.display = 'none';
      document.getElementById('eventsPanel').style.display = 'none';
      noLoop();

      // No graph to scrub in collective view — drop any scrub indicator left
      // over from single-track hover immediately.
      AppState.mouseOverCanvas = false;
      AppState.hoveredIndex = -1;
      AppState.scrubSource = null;
      AppState.emit('scrub', { clear: true });

      // Force synchronous measurement of the new expanded container dimensions without panning the map
      if (
        AppState.mapManager?.map &&
        typeof AppState.mapManager.map.invalidateSize === 'function'
      ) {
        AppState.mapManager.map.invalidateSize({
          pan: false,
          debounceMoveend: true,
        });
      }

      // Render collective map immediately without 150ms debounce lag on mode swap
      if (Controllers.ui) {
        if (Controllers.ui._collectiveDebounceId) {
          clearTimeout(Controllers.ui._collectiveDebounceId);
          Controllers.ui._collectiveDebounceId = null;
        }
        if (typeof Controllers.ui._updateCollectiveMapNow === 'function') {
          Controllers.ui._updateCollectiveMapNow();
        } else if (typeof Controllers.ui.updateCollectiveMap === 'function') {
          Controllers.ui.updateCollectiveMap();
        }
        if (typeof Controllers.ui.refreshOsmControls === 'function') {
          Controllers.ui.refreshOsmControls();
        }
      }
    });

    if (btnLiveView) {
      const enterLiveView = () => {
        if (AppState.viewMode === 'live') return;
        AppState.viewMode = 'live';
        btnLiveView.classList.add('active');
        btnSingleView.classList.remove('active');
        btnCollectiveView.classList.remove('active');

        appMainLayout.classList.remove('collective-mode');
        appMainLayout.classList.add('live-mode');
        const appContainer = document.querySelector('.app-container');
        if (appContainer) appContainer.classList.add('live-mode');
        contourSettingsCard.style.display = 'none';
        collectiveOnlyMapBtns.forEach((btn) => {
          btn.style.display = 'none';
        });

        // Live mode hides the sidebar entirely, so close the mobile drawer and
        // hide its hamburger — there is nothing behind it to open.
        appMainLayout.classList.remove('sidebar-open');
        const sbToggle = document.getElementById('btnSidebarToggle');
        if (sbToggle) {
          sbToggle.hidden = true;
          sbToggle.setAttribute('aria-expanded', 'false');
        }

        // Build the live UI into #livePanel on first open (idempotent) — its
        // BLE / geolocation code stays dormant until the user acts inside it —
        // then activate() every time: resume the redraw loop if a session is
        // live and re-measure the Leaflet map, which may have been sized while
        // the panel was hidden. mount() must run after the panel is displayed
        // (live-mode class above) so that measurement is correct on first open.
        if (livePanel && typeof GSRLiveView !== 'undefined') {
          GSRLiveView.mount(livePanel);
          GSRLiveView.activate();
        }

        // Nothing on the main canvas to draw while the live view owns the area.
        noLoop();
      };

      btnLiveView.addEventListener('click', enterLiveView);

      // Mobile lands on Live by default instead of Single Track — the tab
      // strip above stays visible and clickable either way (nothing hides
      // it just because Live is active), so a misdetected device or a
      // phone user who actually wants Single Track is one tap away, never
      // stuck. Reuses GSRLiveView.isCompactLayout()'s width+pointer check
      // rather than a second detection — one signal decides both this and
      // the Live view's own map-first default. Desktop (AppState.viewMode
      // stays 'single' as today) is completely unaffected.
      if (
        typeof GSRLiveView !== 'undefined' &&
        typeof GSRLiveView.isCompactLayout === 'function' &&
        GSRLiveView.isCompactLayout()
      ) {
        enterLiveView();
      }
    }
  },
  /**
   * Mobile sidebar drawer. On phones (≤768px, see styles.css) the control
   * sidebar is an off-canvas drawer instead of a full-height column that
   * shoves the map / Live view off the bottom of the page. This wires the
   * hamburger (#btnSidebarToggle) and the scrim (#sidebarBackdrop) to the
   * `.sidebar-open` class on `.main-layout`. The CSS is a no-op on desktop,
   * so these listeners are harmless there.
   */
  bindMobileSidebar() {
    const btn = document.getElementById('btnSidebarToggle');
    const layout = document.querySelector('.main-layout');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (!btn || !layout) return;

    const setOpen = (open) => {
      layout.classList.toggle('sidebar-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    btn.addEventListener('click', () => {
      setOpen(!layout.classList.contains('sidebar-open'));
    });
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));

    // Esc closes the drawer, matching the app's other overlays.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && layout.classList.contains('sidebar-open')) {
        setOpen(false);
      }
    });
  },
};
