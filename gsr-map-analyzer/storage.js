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
      minSats:      parseInt(S.gpsMinSats.value),
      maxSpeed:     parseFloat(S.gpsMaxSpeed.value),
      hampelWindow: parseInt(S.gpsHampelWindow.value),
      hampelSigma:  parseFloat(S.gpsHampelSigma.value),
      dbscanRadius: parseFloat(S.gpsDBSCANRadius.value),
      dbscanMinPts: parseInt(S.gpsDBSCANMinPts.value),
      kalmanR:      parseFloat(S.gpsKalmanR.value),
      kalmanQ:      parseFloat(S.gpsKalmanQ.value),
      rdpTolerance: parseFloat(S.gpsRDP.value),
      downsample:   parseInt(S.gpsDownsample.value),
      trackWeight:  parseInt(S.gpsTrackWeight.value),
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
      minSats:      raw.minSats,
      maxSpeed:     raw.maxSpeed,
      hampelWindow: raw.hampelWindow,
      hampelSigma:  raw.hampelSigma,
      dbscanRadius: raw.dbscanRadius,
      dbscanMinPts: raw.dbscanMinPts,
      kalmanR:      raw.kalmanR,
      kalmanQ:      raw.kalmanQ,
      rdpTolerance: raw.rdpTolerance,
      downsample:   raw.downsample === 1,
      trackWeight:  raw.trackWeight,
      peakLatency:  raw.peakLatency
    };
  },

  saveSettings() {
    const S = AppState.sliders;
    if (!S.medianSize) return;
    const gsr = this.readGsrSliderValues();
    const gps = this.readGpsSliderValues();
    const map = this.readMapSettings();
    const settings = {
      medianSize:    gsr.medianSize,
      lpfWindow:     gsr.lpfWindow,
      tonicMethod:   gsr.tonicMethod,
      tonicWindow:   gsr.tonicWindow,
      peakThreshold:      gsr.peakThreshold,
      dwtLevel:           gsr.dwtLevel,
      shapeMinRiseTime:     gsr.shapeMinRiseTime,
      shapeMaxRiseTime:     gsr.shapeMaxRiseTime,
      shapeMinHalfRecovery: gsr.shapeMinHalfRecovery,
      shapeMaxHalfRecovery: gsr.shapeMaxHalfRecovery,
      shapeMinSnr:          gsr.shapeMinSnr,
      shapeMaxSkewRatio:    gsr.shapeMaxSkewRatio,
      gpsMinSats:      gps.minSats,
      gpsMaxSpeed:     gps.maxSpeed,
      gpsHampelWindow: gps.hampelWindow,
      gpsHampelSigma:  gps.hampelSigma,
      gpsDBSCANRadius: gps.dbscanRadius,
      gpsDBSCANMinPts: gps.dbscanMinPts,
      gpsKalmanR:      gps.kalmanR,
      gpsKalmanQ:      gps.kalmanQ,
      gpsRDP:          gps.rdpTolerance,
      gpsDownsample:   gps.downsample,
      gpsTrackWeight:  gps.trackWeight,
      gpsPeakLatency:  gps.peakLatency
    };
    if (map) {
      settings.gridResolution = map.gridResolution;
      settings.contourCount = map.contourCount;
      settings.isolationRadius = map.isolationRadius;
      settings.idwExponent = map.idwExponent;
      settings.topoSource = map.topoSource;
      settings.showShadedSurface = map.showShadedSurface;
      settings.normalizeZScore = map.normalizeZScore;
      settings.surfaceOpacity = map.surfaceOpacity;
    }
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
