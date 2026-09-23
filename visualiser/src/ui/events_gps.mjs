// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — GPS filter sliders and graph background-band overlay toggles. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { Controllers } from '../core/controllers.mjs';
import {
  GPS_SLIDER_DEFS,
  GRAPH_BAND_TOGGLE_DEFS,
} from './events_slider_defs.mjs';

export const GpsEvents = {
  /**
   * GPS filter sliders, the Arousal Places slider, road-snap radius/toggle, graph background-band overlay toggles, and peak-latency (map-only re-render).
   */
  _bindGpsControls() {
    // ── GPS slider bindings ──────────────────────────────────────────────────
    GPS_SLIDER_DEFS.filter((d) => d.bindGps).forEach((d) => {
      this.bindGpsSlider(d.id, d.labelId, d.fmt);
    });

    // ── Arousal Places slider binding ───────────────────────────────────────
    // Scoped refresh (Arousal Places layer only), not a full rerenderMap().
    ['placeMergeDistance', 'maxArousalPlaces'].forEach((id) => {
      const d = this._sliderDef(id);
      if (d) this.bindArousalPlacesSlider(d.id, d.labelId, d.fmt);
    });

    // ── Snap radius slider ───────────────────────────────────────────────────
    // Re-evaluates road snapping locally from cached OSM data when released.
    {
      const slider = document.getElementById('gpsSnapRadius');
      const label = document.getElementById('valGpsSnapRadius');
      if (slider && label) {
        const fmt = this._sliderDef('gpsSnapRadius').fmt;
        const updateDim = () => this.updateFilterDim(slider);
        updateDim();
        slider.addEventListener('input', () => {
          label.innerText = fmt(parseFloat(slider.value));
          updateDim();
        });
        slider.addEventListener('change', () => {
          if (AppState.analyzer?.osmJson) {
            Controllers.ui?.enrichTrack(false); // Recompute using local cache!
          } else {
            Controllers.ui?.rerenderMap();
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
        this.updateSnapRadiusVisibility();
        snapToggle.addEventListener('change', () => {
          this.updateSnapRadiusVisibility();
          if (AppState.analyzer?.osmJson) {
            // OSM data already loaded — re-run enrichment locally
            Controllers.ui?.enrichTrack(false);
          } else {
            // No OSM data yet — just re-render
            Controllers.ui?.rerenderMap();
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

    // Peak latency — the map follows the drag; the environmental dashboard
    // (junction permutation tests take seconds on a large collective) only
    // recomputes on release.
    {
      const slider = document.getElementById('gpsPeakLatency');
      const label = document.getElementById('valGpsPeakLatency');
      const fmt = this._sliderDef('gpsPeakLatency').fmt;
      const updateDim = () => {
        this.updateFilterDim(slider);
      };
      updateDim();
      const rerenderMap = this.rafCoalesce(() => {
        Controllers.ui?.rerenderMap();
      });
      slider.addEventListener('input', () => {
        label.innerText = fmt(parseFloat(slider.value));
        updateDim();
        rerenderMap();
      });
      slider.addEventListener('change', () => {
        Controllers.ui?.updateEnvironmentalDashboard?.();
      });
    }
  },
};
