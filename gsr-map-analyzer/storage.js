/**
 * Settings Management & LocalStorage Persistence.
 * Uses AppState.sliders instead of bare globals.
 */

/**
 * Read current GPS slider values into a clean param object.
 * Shared by tracks.js, simulator.js, and storage.js.
 * This is the canonical source — always add new GPS sliders here first.
 */
function readGpsSliderValues() {
  const S = AppState.sliders;
  return {
    minSats:      parseInt(S.gpsMinSats.value),
    maxSpeed:     parseFloat(S.gpsMaxSpeed.value),
    hampelWindow: parseInt(S.gpsHampelWindow.value),
    hampelSigma:  parseFloat(S.gpsHampelSigma.value),
    dbscanRadius: parseFloat(S.gpsDBSCANRadius.value),
    dbscanMinPts: parseInt(S.gpsDBSCANMinPts.value),
    kalmanR:      parseFloat(S.gpsKalmanR.value),
    kalmanQ:      parseInt(S.gpsKalmanQ.value),
    rdpTolerance: parseFloat(S.gpsRDP.value),
    minDist:      parseFloat(S.gpsMinDist.value),
    downsample:   parseInt(S.gpsDownsample.value),
    trackWeight:  parseInt(S.gpsTrackWeight.value)
  };
}

/**
 * Build GPS filter params for the map renderer, post-processing raw slider values.
 * Uses readGpsSliderValues() as the canonical source.
 * Call this when passing params to GSRMapManager.renderData().
 */
function buildGpsParams() {
  const raw = readGpsSliderValues();
  return {
    minSats:      raw.minSats,
    maxSpeed:     raw.maxSpeed,
    hampelWindow: raw.hampelWindow,
    hampelSigma:  raw.hampelSigma,
    dbscanRadius: raw.dbscanRadius,
    dbscanMinPts: raw.dbscanMinPts,
    kalmanR:      raw.kalmanR,
    kalmanQ:      Math.pow(10, -raw.kalmanQ),
    rdpTolerance: raw.rdpTolerance,
    minDist:      raw.minDist,
    downsample:   raw.downsample === 1,
    trackWeight:  raw.trackWeight
  };
}

function saveSettings() {
  const S = AppState.sliders;
  if (!S.medianSize) return;
  const gps = readGpsSliderValues();
  const settings = {
    medianSize:    parseFloat(S.medianSize.value),
    lpfWindow:     parseFloat(S.lpfWindow.value),
    tonicMethod:   S.tonicMethod.value,
    tonicWindow:   parseInt(S.tonicWindow.value),
    peakThreshold: parseFloat(S.peakThreshold.value),
    dwtLevel:      parseInt(S.dwtLevel.value),
    gpsMinSats:      gps.minSats,
    gpsMaxSpeed:     gps.maxSpeed,
    gpsHampelWindow: gps.hampelWindow,
    gpsHampelSigma:  gps.hampelSigma,
    gpsDBSCANRadius: gps.dbscanRadius,
    gpsDBSCANMinPts: gps.dbscanMinPts,
    gpsKalmanR:      gps.kalmanR,
    gpsKalmanQ:      gps.kalmanQ,
    gpsRDP:          gps.rdpTolerance,
    gpsMinDist:      gps.minDist,
    gpsDownsample:   gps.downsample,
    gpsTrackWeight:  gps.trackWeight
  };
  localStorage.setItem('bioMappingSettings', JSON.stringify(settings));
}

function loadSettings() {
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
    if (settings.peakThreshold !== undefined && S.peakThreshold) S.peakThreshold.value = settings.peakThreshold;
    if (settings.gpsMinSats      !== undefined && S.gpsMinSats)      S.gpsMinSats.value      = settings.gpsMinSats;
    if (settings.gpsMaxSpeed     !== undefined && S.gpsMaxSpeed)     S.gpsMaxSpeed.value     = settings.gpsMaxSpeed;
    if (settings.gpsHampelWindow !== undefined && S.gpsHampelWindow) S.gpsHampelWindow.value = settings.gpsHampelWindow;
    if (settings.gpsHampelSigma  !== undefined && S.gpsHampelSigma)  S.gpsHampelSigma.value  = settings.gpsHampelSigma;
    if (settings.gpsDBSCANRadius !== undefined && S.gpsDBSCANRadius) S.gpsDBSCANRadius.value = settings.gpsDBSCANRadius;
    if (settings.gpsDBSCANMinPts !== undefined && S.gpsDBSCANMinPts) S.gpsDBSCANMinPts.value = settings.gpsDBSCANMinPts;
    if (settings.gpsKalmanR      !== undefined && S.gpsKalmanR)      S.gpsKalmanR.value      = settings.gpsKalmanR;
    if (settings.gpsKalmanQ      !== undefined && S.gpsKalmanQ)      S.gpsKalmanQ.value      = settings.gpsKalmanQ;
    if (settings.gpsRDP          !== undefined && S.gpsRDP)          S.gpsRDP.value          = settings.gpsRDP;
    if (settings.gpsMinDist      !== undefined && S.gpsMinDist)      S.gpsMinDist.value      = settings.gpsMinDist;
    if (settings.gpsDownsample   !== undefined && S.gpsDownsample)   S.gpsDownsample.value   = settings.gpsDownsample;
    if (settings.gpsTrackWeight  !== undefined && S.gpsTrackWeight)  S.gpsTrackWeight.value  = settings.gpsTrackWeight;
  } catch (err) {
    console.error('Error loading settings from localStorage:', err);
  }
}
