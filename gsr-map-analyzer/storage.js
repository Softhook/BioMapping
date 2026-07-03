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
      if (settings.medianSize    !== undefined && S.medianSize)    S.medianSize.value    = settings.medianSize;
      if (settings.lpfWindow     !== undefined && S.lpfWindow)     S.lpfWindow.value     = settings.lpfWindow;
      if (settings.tonicMethod   !== undefined && S.tonicMethod)   S.tonicMethod.value   = settings.tonicMethod;
      if (settings.tonicWindow   !== undefined && S.tonicWindow)   S.tonicWindow.value   = settings.tonicWindow;
      if (settings.dwtLevel      !== undefined && S.dwtLevel)      S.dwtLevel.value      = settings.dwtLevel;
      if (settings.peakThreshold      !== undefined && S.peakThreshold)      S.peakThreshold.value      = settings.peakThreshold;
      if (settings.shapeMinRiseTime   !== undefined && S.shapeMinRiseTime)   S.shapeMinRiseTime.value   = settings.shapeMinRiseTime;
      if (settings.shapeMaxRiseTime   !== undefined && S.shapeMaxRiseTime)   S.shapeMaxRiseTime.value   = settings.shapeMaxRiseTime;
      if (settings.shapeMinHalfRecovery !== undefined && S.shapeMinHalfRecovery) S.shapeMinHalfRecovery.value = settings.shapeMinHalfRecovery;
      if (settings.shapeMaxHalfRecovery !== undefined && S.shapeMaxHalfRecovery) S.shapeMaxHalfRecovery.value = settings.shapeMaxHalfRecovery;
      if (settings.shapeMinSnr        !== undefined && S.shapeMinSnr)        S.shapeMinSnr.value        = settings.shapeMinSnr;
      if (settings.shapeMaxSkewRatio  !== undefined && S.shapeMaxSkewRatio)  S.shapeMaxSkewRatio.value  = settings.shapeMaxSkewRatio;
      if (settings.gpsMinSats         !== undefined && S.gpsMinSats)      S.gpsMinSats.value      = settings.gpsMinSats;
      if (settings.gpsMaxSpeed     !== undefined && S.gpsMaxSpeed)     S.gpsMaxSpeed.value     = settings.gpsMaxSpeed;
      if (settings.gpsHampelWindow !== undefined && S.gpsHampelWindow) S.gpsHampelWindow.value = settings.gpsHampelWindow;
      if (settings.gpsHampelSigma  !== undefined && S.gpsHampelSigma)  S.gpsHampelSigma.value  = settings.gpsHampelSigma;
      if (settings.gpsDBSCANRadius !== undefined && S.gpsDBSCANRadius) S.gpsDBSCANRadius.value = settings.gpsDBSCANRadius;
      if (settings.gpsDBSCANMinPts !== undefined && S.gpsDBSCANMinPts) S.gpsDBSCANMinPts.value = settings.gpsDBSCANMinPts;
      if (settings.gpsKalmanR      !== undefined && S.gpsKalmanR)      S.gpsKalmanR.value      = settings.gpsKalmanR;
      if (settings.gpsKalmanQ      !== undefined && S.gpsKalmanQ)      S.gpsKalmanQ.value      = settings.gpsKalmanQ;
      if (settings.gpsRDP          !== undefined && S.gpsRDP)          S.gpsRDP.value          = settings.gpsRDP;
      if (settings.gpsDownsample   !== undefined && S.gpsDownsample)   S.gpsDownsample.value   = settings.gpsDownsample;
      if (settings.gpsTrackWeight  !== undefined && S.gpsTrackWeight)  S.gpsTrackWeight.value  = settings.gpsTrackWeight;
      if (settings.gpsPeakLatency  !== undefined && S.gpsPeakLatency)  S.gpsPeakLatency.value  = settings.gpsPeakLatency;

      // Contour Display Settings (Global Only)
      const C = AppState.contourControls;
      if (C && C.gridResolution) {
        if (settings.gridResolution !== undefined && C.gridResolution) C.gridResolution.value = settings.gridResolution;
        if (settings.contourCount !== undefined && C.contourCount) C.contourCount.value = settings.contourCount;
        if (settings.isolationRadius !== undefined && C.isolationRadius) C.isolationRadius.value = settings.isolationRadius;
        if (settings.idwExponent !== undefined && C.idwExponent) C.idwExponent.value = settings.idwExponent;
        if (settings.topoSource !== undefined && C.topoSource) C.topoSource.value = settings.topoSource;
        if (settings.showShadedSurface !== undefined && C.showShadedSurface) C.showShadedSurface.checked = settings.showShadedSurface;
        if (settings.normalizeZScore !== undefined && C.normalizeZScore) C.normalizeZScore.checked = settings.normalizeZScore;
        if (settings.surfaceOpacity !== undefined && C.surfaceOpacity) C.surfaceOpacity.value = settings.surfaceOpacity;
      }
    } catch (err) {
      console.error('Error loading settings from localStorage:', err);
    }
  }
};
