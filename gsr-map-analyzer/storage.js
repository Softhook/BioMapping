/**
 * Settings Management & LocalStorage Persistence.
 * Uses AppState.sliders instead of bare globals.
 */

/**
 * Read current GPS slider values into a clean param object.
 * Shared by tracks.js and storage.js.
 * This is the canonical source — always add new GPS sliders here first.
 */
const GSRStorage = {
  /**
   * Read current GSR slider values into a clean param object.
 * Shared by tracks.js, storage.js, and ui.js.
   * This is the canonical source — always add new GSR sliders here first.
   */
  readGsrSliderValues() {
    const S = AppState.sliders;
    if (!S || !S.medianSize) return null;
    return {
      medianSize:    parseFloat(S.medianSize.value),
      lpfWindow:     parseFloat(S.lpfWindow.value),
      tonicMethod:   S.tonicMethod.value,
      tonicWindow:   parseInt(S.tonicWindow.value),
      peakThreshold: parseFloat(S.peakThreshold.value),
      dwtLevel:      parseInt(S.dwtLevel ? S.dwtLevel.value : 6),
      minPeakQuality: parseFloat(S.minPeakQuality ? S.minPeakQuality.value : 0.0),
      // Peak shape criteria
      shapeMinRiseTime:     parseFloat(S.shapeMinRiseTime ? S.shapeMinRiseTime.value : 0.5),
      shapeMaxRiseTime:     parseFloat(S.shapeMaxRiseTime ? S.shapeMaxRiseTime.value : 5.0),
      shapeMinHalfRecovery: parseFloat(S.shapeMinHalfRecovery ? S.shapeMinHalfRecovery.value : 0.3),
      shapeMaxHalfRecovery: parseFloat(S.shapeMaxHalfRecovery ? S.shapeMaxHalfRecovery.value : 10.0),
      shapeMinSnr:          parseFloat(S.shapeMinSnr ? S.shapeMinSnr.value : 2.0),
      shapeMaxSkewRatio:    parseFloat(S.shapeMaxSkewRatio ? S.shapeMaxSkewRatio.value : 6.0)
    };
  },

  /**
   * Read current GPS slider values into a clean param object.
   * Shared by tracks.js and storage.js.
   * This is the canonical source — always add new GPS sliders here first.
   */
  readGpsSliderValues() {
    const S = AppState.sliders;
    return {
      smoothing:    parseFloat(S.gpsSmoothing ? S.gpsSmoothing.value : 0.5),
      kalmanR:      parseFloat(S.gpsKalmanR ? S.gpsKalmanR.value : 10),
      maxHdop:      parseFloat(S.gpsMaxHdop ? S.gpsMaxHdop.value : 2.0),
      maxSpeed:     parseFloat(S.gpsMaxSpeed ? S.gpsMaxSpeed.value : 3.0),
      rdpTolerance: parseFloat(S.gpsRDP ? S.gpsRDP.value : 0),
      downsample:   parseInt(S.gpsDownsample ? S.gpsDownsample.value : 0),
      trackWeight:  parseInt(S.gpsTrackWeight ? S.gpsTrackWeight.value : 5),
      peakLatency:  parseFloat(S.gpsPeakLatency ? S.gpsPeakLatency.value : 0)
    };
  },

  /**
   * Read current Map Display & Contour settings into a param object.
   */
  readMapSettings() {
    const C = AppState.contourControls;
    if (!C || !C.gridResolution) return null;
    return {
      gridResolution:    parseInt(C.gridResolution.value),
      contourCount:      parseInt(C.contourCount.value),
      isolationRadius:   parseInt(C.isolationRadius.value),
      idwExponent:       parseFloat(C.idwExponent.value),
      topoSource:        C.topoSource.value,
      showShadedSurface: C.showShadedSurface.checked,
      normalizeZScore:   C.normalizeZScore ? C.normalizeZScore.checked : false,
      surfaceOpacity:    parseFloat(C.surfaceOpacity.value)
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
