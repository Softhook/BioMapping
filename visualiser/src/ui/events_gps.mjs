// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — GPS filter sliders and graph background-band overlay toggles. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import {
  GPS_SLIDER_DEFS,
  GRAPH_BAND_TOGGLE_DEFS,
  GSREvents,
} from './events.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
  /**
   * GPS filter sliders, the Arousal Places slider, road-snap radius/toggle, graph background-band overlay toggles, and peak-latency (map-only re-render).
   */
  _bindGpsControls() {
    // ── GPS slider bindings ──────────────────────────────────────────────────
    GPS_SLIDER_DEFS.filter((d) => d.bindGps).forEach((d) => {
      GSREvents.bindGpsSlider(d.id, d.labelId, d.fmt);
    });

    // ── Arousal Places slider binding ───────────────────────────────────────
    // Scoped refresh (Arousal Places layer only), not a full rerenderMap().
    ['placeMergeDistance', 'maxArousalPlaces'].forEach((id) => {
      const d = GSREvents._sliderDef(id);
      if (d) GSREvents.bindArousalPlacesSlider(d.id, d.labelId, d.fmt);
    });

    // ── Snap radius slider ───────────────────────────────────────────────────
    // Re-evaluates road snapping locally from cached OSM data when released.
    {
      const slider = document.getElementById('gpsSnapRadius');
      const label = document.getElementById('valGpsSnapRadius');
      if (slider && label) {
        const fmt = GSREvents._sliderDef('gpsSnapRadius').fmt;
        const updateDim = () => GSREvents.updateFilterDim(slider);
        updateDim();
        slider.addEventListener('input', () => {
          label.innerText = fmt(parseFloat(slider.value));
          updateDim();
        });
        slider.addEventListener('change', () => {
          if (AppState.analyzer?.osmJson) {
            GSRUI.enrichTrack(false); // Recompute using local cache!
          } else {
            GSRUI.rerenderMap();
          }
        });
      }
    }

    // ── Road snap toggle ─────────────────────────────────────────────────────
    // Toggling re-runs enrichment (which includes snapping) if OSM data is
    // already loaded; otherwise just saves the preference for next enrichment.
    {
      const snapToggle = document.getElementById('gpsSnapToRoads');
      if (snapToggle) {
        GSREvents.updateSnapRadiusVisibility();
        snapToggle.addEventListener('change', () => {
          GSREvents.updateSnapRadiusVisibility();
          if (AppState.analyzer?.osmJson) {
            // OSM data already loaded — re-run enrichment locally
            GSRUI.enrichTrack(false);
          } else {
            // No OSM data yet — just re-render
            GSRUI.rerenderMap();
          }
        });
      }
    }

    // ── Graph background-band overlay toggles (OSM context, NDVI, EM Fog) ───
    for (const { id, stateKey } of GRAPH_BAND_TOGGLE_DEFS) {
      const toggle = document.getElementById(id);
      if (!toggle) continue;
      toggle.checked = !!AppState[stateKey];
      toggle.addEventListener('change', () => {
        AppState[stateKey] = toggle.checked;
        if (typeof redraw === 'function') redraw();
      });
    }

    // Peak latency — re-render map only (no analysis needed)
    {
      const slider = document.getElementById('gpsPeakLatency');
      const label = document.getElementById('valGpsPeakLatency');
      const fmt = GSREvents._sliderDef('gpsPeakLatency').fmt;
      const updateDim = () => {
        GSREvents.updateFilterDim(slider);
      };
      updateDim();
      const runHeavyWork = GSREvents.rafCoalesce(() => {
        GSRUI.rerenderMap();
        if (
          typeof GSRUI !== 'undefined' &&
          typeof GSRUI.updateEnvironmentalDashboard === 'function'
        ) {
          GSRUI.updateEnvironmentalDashboard();
        }
      });
      slider.addEventListener('input', () => {
        label.innerText = fmt(parseFloat(slider.value));
        updateDim();
        runHeavyWork();
      });
    }
  },
};

Object.assign(GSREvents, __methods);
