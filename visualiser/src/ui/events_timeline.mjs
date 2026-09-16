// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — Scrub-dot relay to the map, timeline zoom/reset buttons, curve show/hide toggles, unsaved-labels unload guard. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { GSREvents } from './events.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
  /**
   * Scrub-dot relay to the map, timeline zoom/reset buttons, curve show/hide toggles, unsaved-labels unload guard.
   */
  _bindTimelineControls() {
    // ── Shared scrub channel: relay to the 2D map ────────────────────────────
    // The GSR graph (renderer.js handleScrubber) and the 3D globe
    // (globe3d_view.js) both emit 'scrub' with {lat, lon, index, source} or
    // {clear:true}. This is the single place the Leaflet scrub dot is driven.
    // panTo stays on for graph/globe sources so the 2D map keeps its
    // pan-only-when-off-screen behaviour; a 'map'-sourced scrub never pans.
    AppState.on('scrub', (p) => {
      const mm = AppState.mapManager;
      if (!mm) return;
      if (!p || p.clear || isNaN(p.lat) || isNaN(p.lon)) {
        mm.setScrubPosition(NaN, NaN);
      } else {
        mm.setScrubPosition(p.lat, p.lon, p.source !== 'map');
      }
    });

    // ── Canvas Control Buttons ────────────────────────────────────────────────
    document
      .getElementById('btnZoomIn')
      .addEventListener('click', () => GSRUI.zoomCanvas(1.5));
    document
      .getElementById('btnZoomOut')
      .addEventListener('click', () => GSRUI.zoomCanvas(0.67));
    document
      .getElementById('btnResetView')
      .addEventListener('click', GSRUI.resetView);

    // ── Curve Toggle Buttons ──────────────────────────────────────────────────
    const bindToggle = (btnId, prop) => {
      const btn = document.getElementById(btnId);
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        AppState[prop] = !AppState[prop];
        redraw();
      });
    };
    bindToggle('btnToggleRaw', 'showRaw');
    bindToggle('btnToggleFiltered', 'showFiltered');
    bindToggle('btnToggleTonic', 'showTonic');
    bindToggle('btnTogglePhasic', 'showPhasic');
    bindToggle('btnTogglePeaks', 'showPeaks');
    bindToggle('btnToggleHotspots', 'showHotspots');

    // ── Page Unload & Keyboard Listener ──────────────────────────────────────
    window.addEventListener('beforeunload', (e) => {
      const hasDirty = AppState.collectiveManager?.tracks
        ? AppState.collectiveManager.tracks.some((t) => t.hasUnsavedLabels)
        : false;
      if (hasDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  },
};

Object.assign(GSREvents, __methods);
