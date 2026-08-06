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
function sliderVal(el, fallback, fn) {
  fn = fn || parseFloat;
  return el ? fn(el.value) : (typeof fallback === 'string' ? fn(fallback) : fallback);
}

/**
 * Like sliderVal(), but for the shape sliders updateDeconvolutionUIState()
 * (events.js) locks to a kernel-canonical value while deconvolution is
 * enabled. In that state, el.value holds the temporary locked display
 * number, not the user's real underlying preference — reading it directly
 * would persist that decoy into track.filterParams / exported CSVs, and
 * later restoring it (e.g. via loadActiveTrackParams()) leaves the slider
 * permanently stuck at the locked value even after deconvolution is turned
 * back off, since there'd be nothing left to distinguish it from a genuine
 * custom setting. Prefer the cached pre-lock value (dataset.customValue)
 * whenever it's present, so persisted state always reflects what the user
 * actually chose.
 */
function shapeSliderVal(el, fallback) {
  if (!el) return fallback;
  if (el.dataset.customValue !== undefined) return parseFloat(el.dataset.customValue);
  return sliderVal(el, fallback);
}

const GSRStorage = {
  /**
   * Read current GSR slider values into a clean param object.
   * Shared by tracks.js, storage.js, and ui.js.
   * This is the canonical source — always add new GSR sliders here first.
   */
  readGsrSliderValues() {
    const S = AppState.sliders;
    if (!S || !S.medianSize) return null;
    const D  = GSR_CONST.GSR_DEFAULT;
    const PS = GSR_CONST.PEAK_SHAPE;
    return {
      medianSize:    parseFloat(S.medianSize.value),
      lpfWindow:     parseFloat(S.lpfWindow.value),
      tonicMethod:   S.tonicMethod.value,
      tonicWindow:   parseInt(S.tonicWindow.value),
      peakThreshold: parseFloat(S.peakThreshold.value),
      // Optional sliders — fall back to GSR_DEFAULT (correct values for these keys)
      dwtLevel:              sliderVal(S.dwtLevel,             D.dwtLevel,     parseInt),
      minPeakQuality:        sliderVal(S.minPeakQuality,       D.minPeakQuality),
      hotspotPercentile:     sliderVal(S.hotspotPercentile,    (D.hotspotPercentile ? D.hotspotPercentile * 100 : 2.0)) / 100.0,
      // Peak shape criteria — fall back to PEAK_SHAPE (literature-validated defaults).
      // Four of these five (all but shapeMinSnr) get locked to a kernel-canonical
      // value while deconvolution is on — read via shapeSliderVal() so a locked
      // display number never gets persisted as if it were the user's real setting.
      shapeMinRiseTime:      shapeSliderVal(S.shapeMinRiseTime,     PS.MIN_RISE_TIME),
      shapeMaxRiseTime:      shapeSliderVal(S.shapeMaxRiseTime,     PS.MAX_RISE_TIME),
      shapeMinHalfRecovery:  shapeSliderVal(S.shapeMinHalfRecovery, PS.MIN_HALF_RECOVERY),
      shapeMaxHalfRecovery:  shapeSliderVal(S.shapeMaxHalfRecovery, PS.MAX_HALF_RECOVERY),
      shapeMinSnr:           sliderVal(S.shapeMinSnr,          PS.MIN_SNR),
      shapeMaxSkewRatio:     shapeSliderVal(S.shapeMaxSkewRatio,    PS.SKEWNESS_RATIO_MAX),
      useDeconvolution:       (S.useDeconvolution && S.useDeconvolution.checked) || false
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
    return {
      smoothing:             parseFloat(S.gpsSmoothing ? S.gpsSmoothing.value : D.smoothing),
      kalmanR:               parseFloat(S.gpsKalmanR ? S.gpsKalmanR.value : D.kalmanR),
      maxHdop:               parseFloat(S.gpsMaxHdop ? S.gpsMaxHdop.value : D.maxHdop),
      maxSpeed:              parseFloat(S.gpsMaxSpeed ? S.gpsMaxSpeed.value : D.maxSpeed),
      rdpTolerance:          parseFloat(S.gpsRDP ? S.gpsRDP.value : D.rdpTolerance),
      downsample:            parseInt(S.gpsDownsample ? S.gpsDownsample.value : (D.downsample ? 1 : 0)),
      trackWeight:           parseInt(S.gpsTrackWeight ? S.gpsTrackWeight.value : D.trackWeight),
      peakLatency:           parseFloat(S.gpsPeakLatency ? S.gpsPeakLatency.value : D.peakLatency),
      clusterProximity:      parseFloat(S.clusterProximity ? S.clusterProximity.value : 35),
      clusterBoundaryRadius: parseFloat(S.clusterBoundaryRadius ? S.clusterBoundaryRadius.value : 5)
    };
  },

  /**
   * Read current Contour map surface slider values into a clean param object.
   */
  readContourSliderValues() {
    const C = AppState.contourControls;
    if (!C || !C.gridResolution) return null;
    return {
      gridResolution:  parseInt(C.gridResolution.value),
      contourCount:    parseInt(C.contourCount.value),
      isolationRadius: parseFloat(C.isolationRadius.value),
      idwExponent:     parseFloat(C.idwExponent.value),
      surfaceOpacity:  parseFloat(C.surfaceOpacity.value)
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
      smoothing:    raw.smoothing,
      kalmanR:      raw.kalmanR,
      maxHdop:      raw.maxHdop,
      maxSpeed:     raw.maxSpeed,
      rdpTolerance: raw.rdpTolerance,
      downsample:   raw.downsample === 1,
      trackWeight:  raw.trackWeight,
      peakLatency:  raw.peakLatency
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
      alert("No active slider settings found to export.");
      return;
    }

    const activeTrack = AppState.activeTrackId ? AppState.collectiveManager.getTrack(AppState.activeTrackId) : null;
    const baseName = filenameBase || (activeTrack ? activeTrack.name.replace(/\.[^/.]+$/, "") : "custom_preset");

    const preset = {
      type: "BioMappingPreset",
      version: 1,
      name: baseName,
      exportedAt: new Date().toISOString(),
      gsr: gsr,
      gps: gps,
      contour: this.readContourSliderValues()
    };

    // Save via GSRFileSaver save location dialog box
    await this.downloadPresetJson(preset, baseName);
  },

  async downloadPresetJson(preset, filenameBase) {
    const jsonStr = JSON.stringify(preset, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    const suggestedName = `biomapping_preset_${(filenameBase || "preset").replace(/[^a-zA-Z0-9_-]/g, "_")}_${stamp}.json`;
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
        alert("Invalid preset file format: " + err.message);
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
    if (typeof GSREvents !== 'undefined' && typeof GSREvents.initializeLabels === 'function') {
      GSREvents.initializeLabels();
    }
  },

  /**
   * Apply a parsed preset object to the UI sliders and active track.
   */
  applyPreset(preset) {
    if (!preset) {
      alert("Invalid preset file.");
      return false;
    }

    const gsr = preset.gsr || preset;
    const gps = preset.gps || preset;

    const S = AppState.sliders;
    if (!S) return false;

    // Restore GSR sliders
    if (gsr.medianSize !== undefined && S.medianSize) S.medianSize.value = gsr.medianSize;
    if (gsr.lpfWindow !== undefined && S.lpfWindow) S.lpfWindow.value = gsr.lpfWindow;
    if (gsr.tonicMethod !== undefined && S.tonicMethod) S.tonicMethod.value = gsr.tonicMethod;
    if (gsr.tonicWindow !== undefined && S.tonicWindow) S.tonicWindow.value = gsr.tonicWindow;
    if (gsr.peakThreshold !== undefined && S.peakThreshold) S.peakThreshold.value = gsr.peakThreshold;
    if (gsr.dwtLevel !== undefined && S.dwtLevel) S.dwtLevel.value = gsr.dwtLevel;
    if (gsr.minPeakQuality !== undefined && S.minPeakQuality) S.minPeakQuality.value = gsr.minPeakQuality;
    if (gsr.hotspotPercentile !== undefined && S.hotspotPercentile) {
      S.hotspotPercentile.value = gsr.hotspotPercentile > 1.0 ? gsr.hotspotPercentile : gsr.hotspotPercentile * 100.0;
    }

    if (gsr.useDeconvolution !== undefined && S.useDeconvolution) {
      S.useDeconvolution.checked = !!gsr.useDeconvolution;
    }

    const isDeconvOn = !!gsr.useDeconvolution;

    const shapeKeys = ['shapeMinRiseTime', 'shapeMaxRiseTime', 'shapeMinHalfRecovery', 'shapeMaxHalfRecovery', 'shapeMinSnr', 'shapeMaxSkewRatio'];
    shapeKeys.forEach(k => {
      if (gsr[k] !== undefined && S[k]) {
        if (isDeconvOn && k !== 'shapeMinSnr') {
          S[k].dataset.customValue = gsr[k];
        } else {
          delete S[k].dataset.customValue;
          S[k].value = gsr[k];
        }
      }
    });

    // Restore GPS & Spatial Clustering sliders
    if (gps.smoothing !== undefined && S.gpsSmoothing) S.gpsSmoothing.value = gps.smoothing;
    if (gps.kalmanR !== undefined && S.gpsKalmanR) S.gpsKalmanR.value = gps.kalmanR;
    if (gps.maxHdop !== undefined && S.gpsMaxHdop) S.gpsMaxHdop.value = gps.maxHdop;
    if (gps.maxSpeed !== undefined && S.gpsMaxSpeed) S.gpsMaxSpeed.value = gps.maxSpeed;
    if (gps.rdpTolerance !== undefined && S.gpsRDP) S.gpsRDP.value = gps.rdpTolerance;
    if (gps.downsample !== undefined && S.gpsDownsample) S.gpsDownsample.value = gps.downsample;
    if (gps.trackWeight !== undefined && S.gpsTrackWeight) S.gpsTrackWeight.value = gps.trackWeight;
    if (gps.peakLatency !== undefined && S.gpsPeakLatency) S.gpsPeakLatency.value = gps.peakLatency;
    if (gps.clusterProximity !== undefined && S.clusterProximity) S.clusterProximity.value = gps.clusterProximity;
    if (gps.clusterBoundaryRadius !== undefined && S.clusterBoundaryRadius) S.clusterBoundaryRadius.value = gps.clusterBoundaryRadius;

    // Restore Contour surface sliders
    const contour = preset.contour;
    const C = AppState.contourControls;
    if (contour && C) {
      if (contour.gridResolution !== undefined && C.gridResolution) C.gridResolution.value = contour.gridResolution;
      if (contour.contourCount !== undefined && C.contourCount) C.contourCount.value = contour.contourCount;
      if (contour.isolationRadius !== undefined && C.isolationRadius) C.isolationRadius.value = contour.isolationRadius;
      if (contour.idwExponent !== undefined && C.idwExponent) C.idwExponent.value = contour.idwExponent;
      if (contour.surfaceOpacity !== undefined && C.surfaceOpacity) C.surfaceOpacity.value = contour.surfaceOpacity;
    }

    // Update layout (DWT vs Tonic Window) and shape slider lock states (Deconvolution ON vs OFF)
    if (typeof GSREvents !== 'undefined') {
      if (typeof GSREvents.updateTonicMethodLayout === 'function') {
        GSREvents.updateTonicMethodLayout();
      }
      if (typeof GSREvents.updateDeconvolutionUIState === 'function') {
        GSREvents.updateDeconvolutionUIState();
      }
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
          const pl = (track.gpsFilterParams && track.gpsFilterParams.peakLatency) || 0;
          track.analyzer.analyze(track.filterParams, pl);
        } catch (e) {
          console.warn(`Re-analyzing active track failed after loading preset:`, e);
        }
        if (typeof GSRTrackManager !== 'undefined') {
          GSRTrackManager.renderTrackList();
        }
        if (typeof GSRUI !== 'undefined') {
          if (typeof GSRUI.invalidateEnvironmentalCache === 'function') {
            GSRUI.invalidateEnvironmentalCache();
          }
          if (typeof GSRUI.runAnalysis === 'function') {
            GSRUI.runAnalysis();
          }
          if (AppState.viewMode === 'collective' && typeof GSRUI.updateCollectiveMap === 'function') {
            GSRUI.updateCollectiveMap();
          }
        }
      }
    }
    return true;
  },

  /**
   * Determine whether a track's parameters match standard defaults,
   * were imported from CSV header metadata, or are custom modified.
   * Returns: 'standard' | 'imported' | 'custom'
   */
  getTrackSettingsStatus(track) {
    if (!track) return 'standard';
    if (!track.filterParams || !track.gpsFilterParams) return 'standard';

    const D = GSR_CONST.GSR_DEFAULT;
    const fp = track.filterParams;

    const isCustomGsr = (
      fp.medianSize !== D.medianSize ||
      fp.lpfWindow !== D.lpfWindow ||
      fp.tonicMethod !== D.tonicMethod ||
      fp.tonicWindow !== D.tonicWindow ||
      Math.abs(fp.peakThreshold - D.peakThreshold) > 0.0001 ||
      fp.dwtLevel !== D.dwtLevel ||
      fp.useDeconvolution !== D.useDeconvolution
    );

    const G = GSR_CONST.GPS_DEFAULT;
    const gp = track.gpsFilterParams;

    const isCustomGps = (
      gp.smoothing !== G.smoothing ||
      gp.kalmanR !== G.kalmanR ||
      gp.maxHdop !== G.maxHdop ||
      gp.maxSpeed !== G.maxSpeed ||
      gp.rdpTolerance !== G.rdpTolerance ||
      gp.peakLatency !== G.peakLatency
    );

    if (isCustomGsr || isCustomGps) {
      return 'custom';
    }

    if (track.settingsSource === 'imported') {
      return 'imported';
    }

    return 'standard';
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRStorage, sliderVal, shapeSliderVal };
}
if (typeof window !== 'undefined') {
  window.GSRStorage = GSRStorage;
}

