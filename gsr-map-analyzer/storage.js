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
      // Peak shape criteria — fall back to PEAK_SHAPE (literature-validated defaults)
      shapeMinRiseTime:      sliderVal(S.shapeMinRiseTime,     PS.MIN_RISE_TIME),
      shapeMaxRiseTime:      sliderVal(S.shapeMaxRiseTime,     PS.MAX_RISE_TIME),
      shapeMinHalfRecovery:  sliderVal(S.shapeMinHalfRecovery, PS.MIN_HALF_RECOVERY),
      shapeMaxHalfRecovery:  sliderVal(S.shapeMaxHalfRecovery, PS.MAX_HALF_RECOVERY),
      shapeMinSnr:           sliderVal(S.shapeMinSnr,          PS.MIN_SNR),
      shapeMaxSkewRatio:     sliderVal(S.shapeMaxSkewRatio,    PS.SKEWNESS_RATIO_MAX)
    };
  },


  /**
   * Read current GPS slider values into a clean param object.
   * Shared by tracks.js and storage.js.
   * This is the canonical source — always add new GPS sliders here first.
   */
  readGpsSliderValues() {
    const S = AppState.sliders;
    const D = GSR_CONST.GPS_DEFAULT;
    return {
      smoothing:    parseFloat(S.gpsSmoothing ? S.gpsSmoothing.value : D.smoothing),
      kalmanR:      parseFloat(S.gpsKalmanR ? S.gpsKalmanR.value : D.kalmanR),
      maxHdop:      parseFloat(S.gpsMaxHdop ? S.gpsMaxHdop.value : D.maxHdop),
      maxSpeed:     parseFloat(S.gpsMaxSpeed ? S.gpsMaxSpeed.value : D.maxSpeed),
      rdpTolerance: parseFloat(S.gpsRDP ? S.gpsRDP.value : D.rdpTolerance),
      downsample:   parseInt(S.gpsDownsample ? S.gpsDownsample.value : (D.downsample ? 1 : 0)),
      trackWeight:  parseInt(S.gpsTrackWeight ? S.gpsTrackWeight.value : D.trackWeight),
      peakLatency:  parseFloat(S.gpsPeakLatency ? S.gpsPeakLatency.value : D.peakLatency)
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

  saveSettings() {
    const S = AppState.sliders;
    if (!S || !S.medianSize) return;
    
    const settings = {};
    const extractValues = (controls) => {
      if (!controls) return;
      for (const [key, el] of Object.entries(controls)) {
        if (el) {
          settings[key] = el.type === 'checkbox' ? el.checked : el.value;
        }
      }
    };

    extractValues(S);
    extractValues(AppState.contourControls);

    localStorage.setItem('bioMappingSettings', JSON.stringify(settings));
  },

  loadSettings() {
    const saved = localStorage.getItem('bioMappingSettings');
    const S = AppState.sliders;
    if (!saved || !S.medianSize) return;
    try {
      const settings = JSON.parse(saved);
      
      const restoreValue = (el, val) => {
        if (!el || val === undefined) return;
        if (el.type === 'checkbox') {
          el.checked = !!val;
        } else {
          el.value = val;
        }
      };

      // Restore S (sliders)
      for (const [key, val] of Object.entries(settings)) {
        if (S[key]) {
          restoreValue(S[key], val);
        }
      }

      // Restore C (contour controls)
      const C = AppState.contourControls;
      if (C) {
        for (const [key, val] of Object.entries(settings)) {
          if (C[key]) {
            restoreValue(C[key], val);
          }
        }
      }
    } catch (err) {
      console.error('Error loading settings from localStorage:', err);
    }
  }
};
