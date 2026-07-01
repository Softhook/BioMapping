/**
 * Settings Management & LocalStorage Persistence.
 * Uses AppState.sliders instead of bare globals.
 */

/**
 * Read current GPS slider values into a clean param object.
 * Shared by tracks.js, simulator.js, and storage.js.
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

function saveSettings() {
  const S = AppState.sliders;
  if (!S.medianSize) return;
  const settings = {
    medianSize:    parseFloat(S.medianSize.value),
    lpfWindow:     parseFloat(S.lpfWindow.value),
    tonicMethod:   S.tonicMethod.value,
    tonicWindow:   parseInt(S.tonicWindow.value),
    peakThreshold: parseFloat(S.peakThreshold.value),
    gpsMinSats:      parseInt(S.gpsMinSats.value),
    gpsMaxSpeed:     parseFloat(S.gpsMaxSpeed.value),
    gpsHampelWindow: parseInt(S.gpsHampelWindow.value),
    gpsHampelSigma:  parseFloat(S.gpsHampelSigma.value),
    gpsDBSCANRadius: parseFloat(S.gpsDBSCANRadius.value),
    gpsDBSCANMinPts: parseInt(S.gpsDBSCANMinPts.value),
    gpsKalmanR:      parseFloat(S.gpsKalmanR.value),
    gpsKalmanQ:      parseInt(S.gpsKalmanQ.value),
    gpsRDP:          parseFloat(S.gpsRDP.value),
    gpsMinDist:      parseFloat(S.gpsMinDist.value),
    gpsDownsample:   parseInt(S.gpsDownsample.value),
    gpsTrackWeight:  parseInt(S.gpsTrackWeight.value)
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
