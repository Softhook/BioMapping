// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * GSREvents — Export/import/apply-to-all-tracks for GSR+GPS parameter presets. Object-augment split from events.js: loaded
 * immediately after events.js, adds these methods to the shared GSREvents
 * object.
 */
import { AppState } from '../core/app_state.mjs';
import { BusyOverlay } from '../core/busy_overlay.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRStorage } from './storage.mjs';
import { GSRTrackManager } from './tracks.mjs';

export const PresetEvents = {
  /**
   * Export/import/apply-to-all-tracks for GSR+GPS parameter presets.
   */
  _bindPresetControls() {
    // ── Preset Export / Import Controls ─────────────────────────────────────
    const btnExportPreset = document.getElementById('btnExportPreset');
    if (btnExportPreset) {
      btnExportPreset.addEventListener('click', () => {
        GSRStorage.exportPreset();
      });
    }

    const btnApplyPreset = document.getElementById('btnApplyPreset');
    const presetFileInput = document.getElementById('presetFileInput');
    if (btnApplyPreset && presetFileInput) {
      btnApplyPreset.addEventListener('click', () => {
        presetFileInput.click();
      });
      presetFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          GSRStorage.importPresetFile(file);
          presetFileInput.value = '';
        }
      });
    }

    const btnApplyActiveToAll = document.getElementById('btnApplyActiveToAll');
    if (btnApplyActiveToAll) {
      btnApplyActiveToAll.addEventListener('click', () => {
        const tracks = AppState.collectiveManager.tracks;
        if (!tracks || tracks.length === 0) {
          alert('No tracks loaded to apply preset to.');
          return;
        }

        // Flush live UI sliders into active track params first
        GSRTrackManager.saveActiveTrackParams();
        GSRTrackManager.saveActiveGpsParams();

        const activeGsr = GSRStorage.readGsrSliderValues();
        const activeGps = GSRStorage.readGpsSliderValues();

        BusyOverlay.run('Applying settings to all tracks…', () => {
          tracks.forEach((track) => {
            track.filterParams = JSON.parse(JSON.stringify(activeGsr));
            track.gpsFilterParams = JSON.parse(JSON.stringify(activeGps));
            try {
              track.analyzer.analyze(
                track.filterParams,
                track.gpsFilterParams.peakLatency ??
                  GSR_CONST.GPS_DEFAULT.peakLatency,
              );
            } catch (e) {
              console.warn(`Re-analysing track "${track.name}" failed:`, e);
            }
          });

          // Single-view only (hidden in Collective view, like the presets).
          if (typeof Controllers.ui?.runAnalysis === 'function') {
            Controllers.ui.runAnalysis();
          }

          GSRTrackManager.renderTrackList();
        });
      });
    }
  },
};
