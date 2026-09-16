// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — OSM enrichment controls. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { NDVISampler } from '../osm/ndvi_sampler.mjs';
import { OsmCache } from '../osm/osm_cache.mjs';
import { GSREvents } from './events.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
  /**
   * OSM enrichment radius/retrieve/clear-cache, the shared OSM overlay toggle, and NDVI layer/sample/Copernicus config controls.
   */
  _bindEnrichmentControls() {
    // ── OSM Enrichment Control Bindings ─────────────────────────────────────
    {
      const radiusSlider = document.getElementById('osmRadius');
      const radiusLabel = document.getElementById('valOsmRadius');
      radiusSlider.addEventListener('input', () => {
        radiusLabel.innerText = `${radiusSlider.value} m`;
      });
      radiusSlider.addEventListener('change', () => {
        if (AppState.analyzer?.osmJson) {
          GSRUI.enrichTrack(false); // Re-run enrichment locally!
        }
      });
    }

    document
      .getElementById('btnEnrichTrack')
      .addEventListener('click', () => GSRUI.enrichTrack(true));

    document
      .getElementById('btnClearOsmCache')
      .addEventListener('click', async () => {
        // Ask via the shared notices layer; fall back to a no-op (rather than
        // silently clearing) if no notice layer is available.
        const proceed =
          typeof GSRNotices !== 'undefined'
            ? await GSRNotices.dialog({
                title: 'Clear OSM Cache',
                message:
                  'Clear locally cached OpenStreetMap data? Future enrichment will re-fetch from the Overpass API.',
                buttons: [{ label: 'Clear', value: 'clear', style: 'danger' }],
                dismissLabel: 'Cancel',
                tone: 'warn',
              })
            : null;
        if (proceed !== 'clear') return;
        try {
          await OsmCache.clear();
          if (
            typeof NDVISampler !== 'undefined' &&
            typeof NDVISampler.clearCache === 'function'
          ) {
            NDVISampler.clearCache();
          }
          alert('OSM and satellite tile cache cleared.');
        } catch (err) {
          console.error('OsmCache.clear failed:', err);
          alert(`Could not clear the OSM cache: ${err.message}`);
        }
      });

    // The OSM overlay (2D vector shapes / 3D extruded buildings) is one shared
    // toggle. The click only flips the intent — GSRUI.setOsmOverlay records it,
    // fetches the geometry on demand the first time (shared OsmCache), and
    // GSRUI.syncOsmOverlay renders it on whichever surface is mounted.
    const btnToggleOsmShapes = document.getElementById('btnToggleOsmShapes');
    btnToggleOsmShapes.addEventListener('click', () => {
      GSRUI.setOsmOverlay(!GSRUI._osmOverlayOn);
    });

    const btnToggleNdviLayer = document.getElementById('btnToggleNdviLayer');
    if (btnToggleNdviLayer) {
      btnToggleNdviLayer.addEventListener('click', () => {
        btnToggleNdviLayer.classList.toggle('active');
        const active = btnToggleNdviLayer.classList.contains('active');
        if (AppState.mapManager) {
          AppState.mapManager.toggleNdviLayer(active);
        }
      });
    }

    const btnSampleNdvi = document.getElementById('btnSampleNdvi');
    if (btnSampleNdvi) {
      btnSampleNdvi.addEventListener('click', () => GSRUI.sampleNdviTrack());
    }

    const copernicusInstanceInput = document.getElementById(
      'copernicusInstanceId',
    );
    const copernicusRawLayerInput = document.getElementById(
      'copernicusRawLayerId',
    );
    const copernicusTimeInput = document.getElementById('copernicusTimeRange');
    const syncCopernicusBadges = () => {
      const activeBadge = document.getElementById('copernicusActiveBadge');
      const defaultBadge = document.getElementById('copernicusDefaultBadge');
      const hasId =
        typeof NDVISampler !== 'undefined'
          ? NDVISampler.hasCopernicusConfig()
          : false;
      if (activeBadge)
        activeBadge.style.display = hasId ? 'inline-block' : 'none';
      if (defaultBadge)
        defaultBadge.style.display = hasId ? 'none' : 'inline-block';
    };

    if (copernicusInstanceInput) {
      const activeId =
        typeof NDVISampler !== 'undefined' ? NDVISampler.getInstanceId() : '';
      if (activeId) copernicusInstanceInput.value = activeId;
      copernicusInstanceInput.addEventListener('change', () => {
        if (
          typeof localStorage !== 'undefined' &&
          typeof localStorage.setItem === 'function'
        ) {
          localStorage.setItem(
            'copernicus_instance_id',
            copernicusInstanceInput.value.trim(),
          );
        }
        syncCopernicusBadges();
        if (AppState.mapManager?.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }
    if (copernicusRawLayerInput) {
      const activeRawLayer =
        typeof NDVISampler !== 'undefined'
          ? NDVISampler.getRawLayerId()
          : 'NDVI_RAW';
      if (activeRawLayer) copernicusRawLayerInput.value = activeRawLayer;
      copernicusRawLayerInput.addEventListener('change', () => {
        if (
          typeof localStorage !== 'undefined' &&
          typeof localStorage.setItem === 'function'
        ) {
          localStorage.setItem(
            'copernicus_raw_layer_id',
            copernicusRawLayerInput.value.trim(),
          );
        }
        // The map overlay renders this same raw layer directly (see
        // map_manager_osm.js: showNdviLayer) — re-render it if visible.
        if (AppState.mapManager?.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }
    if (copernicusTimeInput) {
      const activeTime =
        typeof NDVISampler !== 'undefined'
          ? NDVISampler.getTimeRange()
          : '2024-05-01/2024-09-30';
      if (activeTime) copernicusTimeInput.value = activeTime;
      copernicusTimeInput.addEventListener('change', () => {
        if (
          typeof localStorage !== 'undefined' &&
          typeof localStorage.setItem === 'function'
        ) {
          localStorage.setItem(
            'copernicus_time_range',
            copernicusTimeInput.value.trim(),
          );
        }
        if (AppState.mapManager?.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }

    const btnClearCreds = document.getElementById('btnClearCopernicusCreds');
    if (btnClearCreds) {
      btnClearCreds.addEventListener('click', () => {
        if (typeof NDVISampler !== 'undefined') NDVISampler.clearCredentials();
        if (copernicusInstanceInput) copernicusInstanceInput.value = '';
        if (copernicusRawLayerInput) copernicusRawLayerInput.value = 'NDVI_RAW';
        if (copernicusTimeInput)
          copernicusTimeInput.value = '2024-05-01/2024-09-30';
        syncCopernicusBadges();
        if (AppState.mapManager?.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }

    syncCopernicusBadges();
  },
};

Object.assign(GSREvents, __methods);
