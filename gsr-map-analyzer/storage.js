/**
 * Settings Management & LocalStorage Persistence
 */

/**
 * Save user filter settings to localStorage.
 */
function saveSettings() {
  if (!window.sliders || !sliders.medianSize) return;
  const settings = {
    // GSR Settings
    medianSize: parseFloat(sliders.medianSize.value),
    lpfWindow: parseFloat(sliders.lpfWindow.value),
    tonicMethod: sliders.tonicMethod.value,
    tonicWindow: parseInt(sliders.tonicWindow.value),
    peakThreshold: parseFloat(sliders.peakThreshold.value),

    // GPS Settings
    gpsMinSats: parseInt(sliders.gpsMinSats.value),
    gpsMaxSpeed: parseFloat(sliders.gpsMaxSpeed.value),
    gpsHampelWindow: parseInt(sliders.gpsHampelWindow.value),
    gpsHampelSigma: parseFloat(sliders.gpsHampelSigma.value),
    gpsDBSCANRadius: parseFloat(sliders.gpsDBSCANRadius.value),
    gpsDBSCANMinPts: parseInt(sliders.gpsDBSCANMinPts.value),
    gpsKalmanR: parseFloat(sliders.gpsKalmanR.value),
    gpsKalmanQ: parseFloat(sliders.gpsKalmanQ.value),
    gpsRDP: parseFloat(sliders.gpsRDP.value),
    gpsMinDist: parseFloat(sliders.gpsMinDist.value),
    gpsDownsample: parseInt(sliders.gpsDownsample.value),
    gpsTrackWeight: parseInt(sliders.gpsTrackWeight.value)
  };
  localStorage.setItem('bioMappingSettings', JSON.stringify(settings));
}

/**
 * Load user filter settings from localStorage.
 */
function loadSettings() {
  const saved = localStorage.getItem('bioMappingSettings');
  if (!saved || !window.sliders) return;
  try {
    const settings = JSON.parse(saved);
    
    // GSR Settings
    if (settings.medianSize !== undefined && sliders.medianSize) sliders.medianSize.value = settings.medianSize;
    if (settings.lpfWindow !== undefined && sliders.lpfWindow) sliders.lpfWindow.value = settings.lpfWindow;
    if (settings.tonicMethod !== undefined && sliders.tonicMethod) sliders.tonicMethod.value = settings.tonicMethod;
    if (settings.tonicWindow !== undefined && sliders.tonicWindow) sliders.tonicWindow.value = settings.tonicWindow;
    if (settings.peakThreshold !== undefined && sliders.peakThreshold) sliders.peakThreshold.value = settings.peakThreshold;

    // GPS Settings
    if (settings.gpsMinSats !== undefined && sliders.gpsMinSats) sliders.gpsMinSats.value = settings.gpsMinSats;
    if (settings.gpsMaxSpeed !== undefined && sliders.gpsMaxSpeed) sliders.gpsMaxSpeed.value = settings.gpsMaxSpeed;
    if (settings.gpsHampelWindow !== undefined && sliders.gpsHampelWindow) sliders.gpsHampelWindow.value = settings.gpsHampelWindow;
    if (settings.gpsHampelSigma !== undefined && sliders.gpsHampelSigma) sliders.gpsHampelSigma.value = settings.gpsHampelSigma;
    if (settings.gpsDBSCANRadius !== undefined && sliders.gpsDBSCANRadius) sliders.gpsDBSCANRadius.value = settings.gpsDBSCANRadius;
    if (settings.gpsDBSCANMinPts !== undefined && sliders.gpsDBSCANMinPts) sliders.gpsDBSCANMinPts.value = settings.gpsDBSCANMinPts;
    if (settings.gpsKalmanR !== undefined && sliders.gpsKalmanR) sliders.gpsKalmanR.value = settings.gpsKalmanR;
    if (settings.gpsKalmanQ !== undefined && sliders.gpsKalmanQ) sliders.gpsKalmanQ.value = settings.gpsKalmanQ;
    if (settings.gpsRDP !== undefined && sliders.gpsRDP) sliders.gpsRDP.value = settings.gpsRDP;
    if (settings.gpsMinDist !== undefined && sliders.gpsMinDist) sliders.gpsMinDist.value = settings.gpsMinDist;
    if (settings.gpsDownsample !== undefined && sliders.gpsDownsample) sliders.gpsDownsample.value = settings.gpsDownsample;
    if (settings.gpsTrackWeight !== undefined && sliders.gpsTrackWeight) sliders.gpsTrackWeight.value = settings.gpsTrackWeight;
  } catch (err) {
    console.error("Error loading settings from localStorage:", err);
  }
}

/**
 * Initialize control labels to match the current slider values.
 */
function initializeLabels() {
  // GSR Labels
  const updateGsrLabel = (id, labelId, suffix) => {
    const slider = document.getElementById(id);
    const label = document.getElementById(labelId);
    if (slider && label) {
      label.innerText = parseFloat(slider.value).toFixed(suffix.includes('μS') ? 3 : 1) + suffix;
    }
  };
  updateGsrLabel('medianSize', 'valMedianSize', ' s');
  updateGsrLabel('lpfWindow', 'valLpfWindow', ' s');
  updateGsrLabel('tonicWindow', 'valTonicWindow', ' s');
  updateGsrLabel('peakThreshold', 'valPeakThreshold', ' μS');

  // GPS Labels
  const gpsFormatters = {
    gpsMinSats:      v => v === 0 ? 'off' : `≥ ${v}`,
    gpsMaxSpeed:     v => v === 0 ? 'off' : `${v} m/s`,
    gpsHampelWindow: v => v === 0 ? 'off' : `${v} s`,
    gpsHampelSigma:  v => v.toFixed(1),
    gpsDBSCANRadius: v => v === 0 ? 'off' : `${v} m`,
    gpsDBSCANMinPts: v => `${v} s`,
    gpsKalmanR:      v => v === 0 ? 'off' : `${v} m²`,
    gpsKalmanQ:      v => `1e-${v}`,
    gpsRDP:          v => v === 0 ? 'off' : `${v} m`,
    gpsMinDist:      v => v === 0 ? 'off' : `${v} m`,
    gpsDownsample:   v => v === 0 ? 'off' : '1 Hz',
    gpsTrackWeight:  v => `${v} px`
  };

  for (const [id, fmt] of Object.entries(gpsFormatters)) {
    const slider = document.getElementById(id);
    const labelId = 'val' + id.charAt(0).toUpperCase() + id.slice(1);
    const label = document.getElementById(labelId);
    if (slider && label) {
      label.innerText = fmt(parseFloat(slider.value));
    }
  }
}
