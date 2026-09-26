// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — 2D map / 3D globe surface switcher. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRGlobe3DView } from '../map/globe3d_view.mjs';

export const SurfaceSwitcherEvents = {
  /**
   * Surface switcher (2D Map ↔ 3D Globe). Orthogonal to the Single/Collective
   * scope switcher above. Leaflet and Cesium are equivalent display engines
   * swapped inside the one #mapPanel: this toggles which container div is shown
   * (#map ⇄ #globe3dContainer) and reveals the 3D-only settings sub-section.
   * The header controls drive whichever engine is mounted; the globe is still a
   * read-only view of the 2D state — see src/map/globe3d_view.js.
   */
  bindSurfaceSwitcher() {
    const tabs = Array.from(document.querySelectorAll('.surface-tab'));
    if (!tabs.length) return;

    GSRGlobe3DView.init();

    const mapEl = document.getElementById('map');
    const globeEl = document.getElementById('globe3dContainer');
    const settings3d = document.getElementById('mapDisplay3DGroup');
    const mapDisplayCard = document.getElementById('mapDisplayCard');
    const cameraBtns = [
      document.getElementById('g3dBtnOrbit'),
      document.getElementById('g3dBtnTour'),
      document.getElementById('g3dBtnPersp3D'),
      document.getElementById('g3dBtnPerspTop'),
      document.getElementById('g3dBtnNorth'),
    ];
    const show = (el, on) => {
      if (el) el.style.display = on ? '' : 'none';
    };

    const setSurface = (target) => {
      if (AppState.surfaceView === target) return;
      if (target === 'globe' && AppState.viewMode === 'collective') return;
      const toGlobe = target === 'globe';

      AppState.surfaceView = target;
      tabs.forEach((t) => {
        t.classList.toggle('active', t.dataset.surface === target);
      });
      show(mapEl, !toGlobe);
      show(globeEl, toGlobe);
      show(settings3d, toGlobe);
      cameraBtns.forEach((btn) => {
        show(btn, toGlobe);
      });

      // The Map Display card ships collapsed; switching to the globe reveals the
      // 3D-only settings inside it, so expand it once so they aren't stranded
      // behind a collapsed header. Never auto-recollapses — the user's call.
      if (toGlobe && mapDisplayCard)
        mapDisplayCard.classList.remove('collapsed');

      if (toGlobe) GSRGlobe3DView.activate();
      else GSRGlobe3DView.deactivate();

      // Re-render the shared OSM overlay on the now-mounted surface. 2D takes
      // effect immediately; the globe re-syncs from GSRGlobe3DView.activate()
      // once its manager is built (its manager isn't ready yet here).
      Controllers.ui?.syncOsmOverlay?.();

      if (
        !toGlobe &&
        AppState.mapManager &&
        AppState.mapManager.map &&
        typeof AppState.mapManager.map.invalidateSize === 'function'
      ) {
        AppState.mapManager.map.invalidateSize({
          pan: false,
          debounceMoveend: true,
        });
        // A track loaded while the globe was up left its auto-fit deferred (the
        // hidden map can't be flown to) — frame it now that 2D is back.
        if (typeof AppState.mapManager._applyPendingFit === 'function') {
          AppState.mapManager._applyPendingFit();
        }
      }
    };
    this.setSurface = setSurface;
    tabs.forEach((t) => {
      t.addEventListener('click', () => setSurface(t.dataset.surface));
    });
  },
};
