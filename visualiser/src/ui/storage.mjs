/**
 * Settings Management & LocalStorage Persistence.
 * Uses AppState.sliders instead of bare globals.
 */

/**
 * Typed slider value reader with automatic fallback.
 * Prevents the null-guard pattern from being copy-pasted with different
 * hardcoded defaults that drift out of sync with constants.js.
 *
 * @param {HTMLElement|null} el       - Slider or select element (may be null)
 * @param {*}                fallback - Default value when el is null/absent
 * @param {Function}         [fn]     - Parser: parseFloat (default) or parseInt
 */
import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRFileSaver } from '../core/file_saver.mjs';

export function sliderVal(el, fallback, fn) {
  fn = fn || parseFloat;
  return el
    ? fn(el.value)
    : typeof fallback === 'string'
      ? fn(fallback)
      : fallback;
}

export const GSRStorage = {
  /**
   * Read current GSR slider values into a clean param object.
   * Shared by tracks.js, storage.js, and ui.js.
   * This is the canonical source — always add new GSR sliders here first.
   */
  readGsrSliderValues() {
    const S = AppState.sliders;
    if (!S?.medianSize) return null;
    const D = GSR_CONST.GSR_DEFAULT;
    const PS = GSR_CONST.PEAK_SHAPE;
    return {
      medianSize: parseFloat(S.medianSize.value),
      lpfWindow: parseFloat(S.lpfWindow.value),
      useGaitFilter: S.useGaitFilter?.checked || false,
      repairGsrDisconnects: S.repairGsrDisconnects?.checked || false,
      tonicMethod: S.tonicMethod.value,
      tonicWindow: parseInt(S.tonicWindow.value, 10),
      peakThreshold: parseFloat(S.peakThreshold.value),
      // Optional sliders — fall back to GSR_DEFAULT (correct values for these keys)
      minPeakQuality: sliderVal(S.minPeakQuality, D.minPeakQuality),
      peakDensityWindow: sliderVal(
        S.peakDensityWindow,
        D.peakDensityWindow || 10,
        parseInt,
      ),
      hotspotPercentile:
        sliderVal(
          S.hotspotPercentile,
          D.hotspotPercentile ? D.hotspotPercentile * 100 : 2.0,
        ) / 100.0,
      // Min SNR — the only shape gate the live detectors use (default + deconvolution).
      shapeMinSnr: sliderVal(S.shapeMinSnr, PS.MIN_SNR),
      useDeconvolution: S.useDeconvolution?.checked || false,
      useSparsEDA: S.useSparsEDA?.checked || false,
      usePeakProminence: S.usePeakProminence?.checked || false,
      useCvxEDA: S.useCvxEDA?.checked || false,
    };
  },

  /**
   * Read current GPS slider values into a clean param object.
   * Shared by tracks.js and storage.js.
   * This is the canonical source — always add new GPS sliders here first.
   */
  readGpsSliderValues() {
    const S = AppState.sliders;
    if (!S) return null;
    const D = GSR_CONST.GPS_DEFAULT;
    const AP = GSR_CONST.AROUSAL_PLACES;
    const maxSpeed = sliderVal(S.gpsMaxSpeed, D.maxSpeed);
    const baseSmoothing = D.smoothing !== undefined ? D.smoothing : 0.5;
    const baseSpeed = D.maxSpeed || 3.0;
    const tiedSmoothing = baseSmoothing * (maxSpeed / baseSpeed) ** 2;
    return {
      smoothing: sliderVal(S.gpsSmoothing, tiedSmoothing),
      kalmanR: sliderVal(S.gpsKalmanR, D.kalmanR),
      maxHdop: sliderVal(S.gpsMaxHdop, D.maxHdop),
      maxSpeed: maxSpeed,
      rdpTolerance: sliderVal(S.gpsRDP, D.rdpTolerance),
      downsample: sliderVal(S.gpsDownsample, D.downsample ? 1 : 0, parseInt),
      trackWeight: sliderVal(S.gpsTrackWeight, D.trackWeight, parseInt),
      peakLatency: sliderVal(S.gpsPeakLatency, D.peakLatency),
      placeMergeDistance: sliderVal(S.placeMergeDistance, AP ? AP.mergeM : 35),
      maxArousalPlaces: sliderVal(
        S.maxArousalPlaces,
        AP ? AP.maxPlaces : 20,
        parseInt,
      ),
    };
  },

  /**
   * Write GPS and spatial clustering slider values to the DOM.
   * Shared by tracks.js and storage.js.
   *
   * @param {object} gps - GPS parameter values.
   */
  writeGpsSliderValues(gps) {
    if (!gps || typeof gps !== 'object') return;
    const S = AppState.sliders;
    if (!S) return;

    const gpsMap = {
      smoothing: 'gpsSmoothing',
      kalmanR: 'gpsKalmanR',
      maxHdop: 'gpsMaxHdop',
      maxSpeed: 'gpsMaxSpeed',
      rdpTolerance: 'gpsRDP',
      downsample: 'gpsDownsample',
      trackWeight: 'gpsTrackWeight',
      peakLatency: 'gpsPeakLatency',
      placeMergeDistance: 'placeMergeDistance',
      maxArousalPlaces: 'maxArousalPlaces',
    };

    for (const [key, val] of Object.entries(gps)) {
      if (val === undefined) continue;
      const sliderKey =
        gpsMap[key] || `gps${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      const slider = S[sliderKey] || S[key];
      if (slider) {
        slider.value = val;
      }
    }
  },

  /**
   * Read current Contour map surface slider values into a clean param object.
   */
  readContourSliderValues() {
    const C = AppState.contourControls;
    if (!C?.gridResolution) return null;
    return {
      gridResolution: parseInt(C.gridResolution.value, 10),
      contourCount: parseInt(C.contourCount.value, 10),
      isolationRadius: parseFloat(C.isolationRadius.value),
      idwExponent: parseFloat(C.idwExponent.value),
      peakPreservation: parseFloat(
        C.peakPreservation
          ? C.peakPreservation.value
          : GSR_CONST.COLLECTIVE.peakPreservation,
      ),
      coverageWeighting: parseFloat(
        C.coverageWeighting
          ? C.coverageWeighting.value
          : GSR_CONST.COLLECTIVE.coverageWeighting,
      ),
      surfaceOpacity: parseFloat(C.surfaceOpacity.value),
    };
  },

  /**
   * Build GPS filter params for the map renderer, post-processing raw slider values.
   * Uses readGpsSliderValues() as the canonical source.
   * Call this when passing params to GSRMapManager.renderData().
   */
  buildGpsParams() {
    const raw = this.readGpsSliderValues();
    return {
      smoothing: raw.smoothing,
      kalmanR: raw.kalmanR,
      maxHdop: raw.maxHdop,
      maxSpeed: raw.maxSpeed,
      rdpTolerance: raw.rdpTolerance,
      downsample: raw.downsample === 1,
      trackWeight: raw.trackWeight,
      peakLatency: raw.peakLatency,
    };
  },

  /**
   * Export current slider parameters to a downloadable .json preset file on disk.
   * Prompts the native OS Save File picker or pops up the Export Preset Save Menu modal.
   */
  async exportPreset(filenameBase) {
    const gsr = this.readGsrSliderValues();
    const gps = this.readGpsSliderValues();
    if (!gsr || !gps) {
      alert('No active slider settings found to export.');
      return;
    }

    const activeTrack = AppState.activeTrackId
      ? AppState.collectiveManager.getTrack(AppState.activeTrackId)
      : null;
    const baseName =
      filenameBase ||
      (activeTrack
        ? activeTrack.name.replace(/\.[^/.]+$/, '')
        : 'custom_preset');

    const preset = {
      type: 'BioMappingPreset',
      version: 1,
      name: baseName,
      exportedAt: new Date().toISOString(),
      gsr: gsr,
      gps: gps,
      contour: this.readContourSliderValues(),
    };

    // Save via GSRFileSaver save location dialog box
    await this.downloadPresetJson(preset, baseName);
  },

  async downloadPresetJson(preset, filenameBase) {
    const jsonStr = JSON.stringify(preset, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    const suggestedName = `biomapping_preset_${(filenameBase || 'preset').replace(/[^a-zA-Z0-9_-]/g, '_')}_${stamp}.json`;
    await GSRFileSaver.saveFile(jsonStr, suggestedName);
  },

  /**
   * Import a .json preset file from disk and apply its parameters.
   */
  importPresetFile(file, callback) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const preset = JSON.parse(e.target.result);
        const success = this.applyPreset(preset);
        if (callback) callback(success, preset);
      } catch (err) {
        alert(`Invalid preset file format: ${err.message}`);
        if (callback) callback(false, null);
      }
    };
    reader.readAsText(file);
  },

  /**
   * Fast, non-triggering UI display sync — updates text labels & dimmed states
   * without triggering duplicate analysis runs or map re-renders.
   */
  syncSliderValueDisplays() {
    if (
      Controllers.events &&
      typeof Controllers.events.initializeLabels === 'function'
    ) {
      Controllers.events.initializeLabels();
    }
  },

  /**
   * Apply a parsed preset object to the UI sliders and active track.
   */
  applyPreset(preset) {
    if (!preset) {
      alert('Invalid preset file.');
      return false;
    }

    const gsr = preset.gsr || preset;
    const gps = preset.gps || preset;

    const S = AppState.sliders;
    if (!S) return false;

    // Restore GSR sliders
    if (gsr.medianSize !== undefined && S.medianSize)
      S.medianSize.value = gsr.medianSize;
    if (gsr.lpfWindow !== undefined && S.lpfWindow)
      S.lpfWindow.value = gsr.lpfWindow;
    if (gsr.useGaitFilter !== undefined && S.useGaitFilter)
      S.useGaitFilter.checked = !!gsr.useGaitFilter;
    if (gsr.repairGsrDisconnects !== undefined && S.repairGsrDisconnects)
      S.repairGsrDisconnects.checked = !!gsr.repairGsrDisconnects;
    // A retired baseline method (e.g. a preset saved with 'dwt') would be an
    // invalid <select> value — a DOM no-op that leaves a stale label; ignore it.
    if (
      gsr.tonicMethod !== undefined &&
      S.tonicMethod &&
      ['percentile', 'median', 'lpf'].includes(gsr.tonicMethod)
    ) {
      S.tonicMethod.value = gsr.tonicMethod;
    }
    if (gsr.tonicWindow !== undefined && S.tonicWindow)
      S.tonicWindow.value = gsr.tonicWindow;
    if (gsr.peakThreshold !== undefined && S.peakThreshold)
      S.peakThreshold.value = gsr.peakThreshold;
    if (gsr.minPeakQuality !== undefined && S.minPeakQuality)
      S.minPeakQuality.value = gsr.minPeakQuality;
    if (gsr.peakDensityWindow !== undefined && S.peakDensityWindow)
      S.peakDensityWindow.value = gsr.peakDensityWindow;
    if (gsr.hotspotPercentile !== undefined && S.hotspotPercentile) {
      S.hotspotPercentile.value =
        gsr.hotspotPercentile > 1.0
          ? gsr.hotspotPercentile
          : gsr.hotspotPercentile * 100.0;
    }

    if (gsr.useDeconvolution !== undefined && S.useDeconvolution) {
      S.useDeconvolution.checked = !!gsr.useDeconvolution;
    }
    if (gsr.useSparsEDA !== undefined && S.useSparsEDA) {
      S.useSparsEDA.checked = !!gsr.useSparsEDA;
    }
    if (gsr.usePeakProminence !== undefined && S.usePeakProminence) {
      S.usePeakProminence.checked = !!gsr.usePeakProminence;
    }
    if (gsr.useCvxEDA !== undefined && S.useCvxEDA) {
      S.useCvxEDA.checked = !!gsr.useCvxEDA;
    }
    // The alternative detectors are mutually exclusive; if a stored config
    // somehow has multiple, keep the higher-precedence one (prominence >
    // cvxEDA > sparsEDA > deconvolution, matching analyze()).
    if (S.usePeakProminence?.checked) {
      if (S.useDeconvolution) S.useDeconvolution.checked = false;
      if (S.useSparsEDA) S.useSparsEDA.checked = false;
      if (S.useCvxEDA) S.useCvxEDA.checked = false;
    } else if (S.useCvxEDA?.checked) {
      if (S.useDeconvolution) S.useDeconvolution.checked = false;
      if (S.useSparsEDA) S.useSparsEDA.checked = false;
    } else if (S.useSparsEDA?.checked) {
      if (S.useDeconvolution) S.useDeconvolution.checked = false;
    }

    if (gsr.shapeMinSnr !== undefined && S.shapeMinSnr)
      S.shapeMinSnr.value = gsr.shapeMinSnr;

    // Restore GPS & Spatial Clustering sliders
    this.writeGpsSliderValues(gps);

    // Restore Contour surface sliders
    const contour = preset.contour;
    const C = AppState.contourControls;
    if (contour && C) {
      if (contour.gridResolution !== undefined && C.gridResolution)
        C.gridResolution.value = contour.gridResolution;
      if (contour.contourCount !== undefined && C.contourCount)
        C.contourCount.value = contour.contourCount;
      if (contour.isolationRadius !== undefined && C.isolationRadius)
        C.isolationRadius.value = contour.isolationRadius;
      if (contour.idwExponent !== undefined && C.idwExponent)
        C.idwExponent.value = contour.idwExponent;
      if (contour.peakPreservation !== undefined && C.peakPreservation)
        C.peakPreservation.value = contour.peakPreservation;
      if (contour.coverageWeighting !== undefined && C.coverageWeighting)
        C.coverageWeighting.value = contour.coverageWeighting;
      if (contour.surfaceOpacity !== undefined && C.surfaceOpacity)
        C.surfaceOpacity.value = contour.surfaceOpacity;
    }

    // Refresh dependent layout: tonic-window slider config.
    if (
      Controllers.events &&
      typeof Controllers.events.updateTonicMethodLayout === 'function'
    ) {
      Controllers.events.updateTonicMethodLayout();
    }

    // Dispatch input events on all sliders so on-screen text labels & dimmed states update immediately!
    this.syncSliderValueDisplays();

    // Commit to active track if one exists
    if (AppState.activeTrackId) {
      const track = AppState.collectiveManager.getTrack(AppState.activeTrackId);
      if (track) {
        track.filterParams = this.readGsrSliderValues();
        track.gpsFilterParams = this.readGpsSliderValues();
        try {
          const pl = track.gpsFilterParams?.peakLatency || 0;
          track.analyzer.analyze(track.filterParams, pl);
        } catch (e) {
          console.warn(
            `Re-analysing active track failed after loading preset:`,
            e,
          );
        }
        if (Controllers.trackManager) {
          Controllers.trackManager.renderTrackList();
        }
        if (Controllers.ui) {
          if (typeof Controllers.ui.runAnalysis === 'function') {
            Controllers.ui.runAnalysis();
          }
          if (
            AppState.viewMode === 'collective' &&
            typeof Controllers.ui.updateCollectiveMap === 'function'
          ) {
            Controllers.ui.updateCollectiveMap();
          }
        }
      }
    }
    return true;
  },
};
