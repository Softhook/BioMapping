/**
 * DOM Element Caching, Event Binding, and UI Initialization.
 * Extracted from ui.js — handles all slider/button/toggle wiring.
 */

/**
 * Safe DOM lookup — warns on missing elements without crashing.
 */
function _id(id) {
  const el = document.getElementById(id);
  if (!el) console.warn('GSR Map Analyzer: DOM element #' + id + ' not found.');
  return el;
}

/**
 * Cache all frequently-accessed DOM elements into AppState.
 */
function cacheDOMElements() {
  AppState.fileInput    = _id('fileInput');
  AppState.dropZone     = _id('dropZone');
  AppState.tableBody    = document.querySelector('#peaksTable tbody');

  // Sliders
  AppState.sliders.medianSize    = _id('medianSize');
  AppState.sliders.lpfWindow     = _id('lpfWindow');
  AppState.sliders.tonicWindow   = _id('tonicWindow');
  AppState.sliders.tonicMethod   = _id('tonicMethod');
  AppState.sliders.peakThreshold = _id('peakThreshold');
  AppState.sliders.dwtLevel      = _id('dwtLevel');

  // Stats
  AppState.statFields.duration   = _id('statDuration');
  AppState.statFields.meanSCL    = _id('statMeanSCL');
  AppState.statFields.peakCount  = _id('statPeakCount');
  AppState.statFields.peakFreq   = _id('statPeakFreq');

  // GPS filter sliders
  AppState.sliders.gpsMinSats      = _id('gpsMinSats');
  AppState.sliders.gpsMaxSpeed     = _id('gpsMaxSpeed');
  AppState.sliders.gpsHampelWindow = _id('gpsHampelWindow');
  AppState.sliders.gpsHampelSigma  = _id('gpsHampelSigma');
  AppState.sliders.gpsDBSCANRadius = _id('gpsDBSCANRadius');
  AppState.sliders.gpsDBSCANMinPts = _id('gpsDBSCANMinPts');
  AppState.sliders.gpsKalmanR      = _id('gpsKalmanR');
  AppState.sliders.gpsKalmanQ      = _id('gpsKalmanQ');
  AppState.sliders.gpsRDP          = _id('gpsRDP');
  AppState.sliders.gpsMinDist      = _id('gpsMinDist');
  AppState.sliders.gpsDownsample   = _id('gpsDownsample');
  AppState.sliders.gpsTrackWeight  = _id('gpsTrackWeight');
  AppState.sliders.gpsPeakLatency  = _id('gpsPeakLatency');

  // Contour controls (used in collective map)
  AppState.contourControls = {
    gridResolution:    _id('gridResolution'),
    contourCount:      _id('contourCount'),
    isolationRadius:   _id('isolationRadius'),
    idwExponent:       _id('idwExponent'),
    topoSource:        _id('topoSource'),
    showShadedSurface: _id('showShadedSurface'),
    surfaceOpacity:    _id('surfaceOpacity')
  };
}

/**
 * Bind a collapse button to toggle the `.collapsed` class on its card.
 * Replaces 7+ copy-pasted addEventListener blocks.
 */
function bindCollapseButton(btnId, cardId) {
  const btn = _id(btnId);
  const card = _id(cardId);
  if (!btn || !card) return;
  btn.addEventListener('click', () => card.classList.toggle('collapsed'));
}

/**
 * Like bindCollapseButton but also calls onExpand after the expand animation.
 * Avoids the double-listener pattern that previously existed for GSR + Map panels.
 */
function setupCollapseWithResize(btnId, cardId, onExpand) {
  const btn = document.getElementById(btnId);
  const card = document.getElementById(cardId);
  if (!btn || !card) return;
  btn.addEventListener('click', () => {
    const wasCollapsed = card.classList.contains('collapsed');
    card.classList.toggle('collapsed');
    if (wasCollapsed && onExpand) setTimeout(onExpand, 50);
  });
}

/**
 * Update the dimmed state of a slider-group based on whether value is 0 (off).
 */
function updateFilterDim(slider) {
  const group = slider.closest('.slider-group');
  if (!group) return;
  const val = parseFloat(slider.value);
  group.classList.toggle('filter-off', val === 0);
}

/**
 * Bind a GSR slider: update label immediately, re-run analysis, save settings.
 * Shows "off" when value is 0 and dims the slider group.
 */
function bindGsrSlider(id, labelId, suffix) {
  const slider = document.getElementById(id);
  const label  = document.getElementById(labelId);
  const updateDim = () => updateFilterDim(slider);

  // Initial dim state
  updateDim();

  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    label.innerText = val === 0 ? 'off' : val.toFixed(suffix.includes('μS') ? 3 : 1) + suffix;
    updateDim();
    runAnalysis();
    saveSettings();
  });
}

/**
 * Bind a GPS slider: update label, re-render map, save settings.
 * Dims the slider group when value is 0 (off).
 */
function bindGpsSlider(id, labelId, fmt) {
  const slider = document.getElementById(id);
  const label  = document.getElementById(labelId);
  const updateDim = () => updateFilterDim(slider);

  // Initial dim state
  updateDim();

  slider.addEventListener('input', () => {
    label.innerText = fmt(parseFloat(slider.value));
    updateDim();
    rerenderMap();
    saveSettings();
  });
}

/**
 * Wire up all UI event listeners (sliders, file drop, buttons, toggles, panels).
 */
function setupEventListeners() {
  const S = AppState.sliders;

  // ── GSR slider bindings ──────────────────────────────────────────────────
  bindGsrSlider('medianSize',    'valMedianSize',    ' s');
  bindGsrSlider('lpfWindow',     'valLpfWindow',     ' s');
  bindGsrSlider('tonicWindow',   'valTonicWindow',   ' s');
  bindGsrSlider('peakThreshold', 'valPeakThreshold', ' μS');

  // DWT level — custom binding (integer display)
  if (S.dwtLevel) {
    S.dwtLevel.addEventListener('input', () => {
      const level = parseInt(S.dwtLevel.value);
      document.getElementById('valDwtLevel').innerText = level;
      runAnalysis();
      saveSettings();
    });
  }

  S.tonicMethod.addEventListener('change', () => {
    // Show/hide DWT level slider based on selected method
    const dwtGroup = document.getElementById('dwtLevelGroup');
    if (dwtGroup) {
      dwtGroup.style.display = S.tonicMethod.value === 'dwt' ? '' : 'none';
    }
    runAnalysis();
    saveSettings();
  });

  // ── File Upload Handlers ──────────────────────────────────────────────────
  AppState.fileInput.addEventListener('change', handleFileSelect);

  AppState.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    AppState.dropZone.classList.add('dragover');
  });
  AppState.dropZone.addEventListener('dragleave', () => {
    AppState.dropZone.classList.remove('dragover');
  });
  AppState.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    AppState.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      loadFilesSequentially(Array.from(e.dataTransfer.files));
    }
  });
  AppState.dropZone.addEventListener('click', (e) => {
    if (!e.target.closest('label') && e.target !== AppState.fileInput) {
      AppState.fileInput.click();
    }
  });

  // ── Leaflet-to-Timeline scrubbing callback ────────────────────────────────
  window.updateTimelineScrub = (time) => {
    if (AppState.analyzer.raw.length === 0) return;
    AppState.hoveredIndex = findClosestIndex(time);
    if (AppState.hoveredIndex !== -1) {
      const sample = AppState.analyzer.raw[AppState.hoveredIndex];
      if (sample && sample.hasGps && !isNaN(sample.lat) && !isNaN(sample.lon) && AppState.mapManager) {
        AppState.mapManager.setScrubPosition(sample.lat, sample.lon, false);
      }
      redraw();
    }
  };

  // ── Canvas Control Buttons ────────────────────────────────────────────────
  document.getElementById('btnZoomIn').addEventListener('click',    () => zoomCanvas(1.5));
  document.getElementById('btnZoomOut').addEventListener('click',   () => zoomCanvas(0.67));
  document.getElementById('btnResetView').addEventListener('click', resetView);

  const timeWindowSelect = document.getElementById('timeWindowSelect');
  if (timeWindowSelect) {
    timeWindowSelect.addEventListener('change', () => {
      const val = timeWindowSelect.value;
      if (val === 'fit') {
        resetView();
      } else if (val !== 'custom') {
        const windowSec = parseFloat(val);
        AppState.viewDuration = Math.min(windowSec, AppState.totalDuration);
        AppState.viewStartTime = constrain(AppState.viewStartTime, 0,
          Math.max(0, AppState.totalDuration - AppState.viewDuration));
        AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;
        redraw();
      }
    });
  }

  // ── Curve Toggle Buttons ──────────────────────────────────────────────────
  const bindToggle = (btnId, prop) => {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      AppState[prop] = !AppState[prop];
      redraw();
    });
  };
  bindToggle('btnToggleRaw',      'showRaw');
  bindToggle('btnToggleFiltered', 'showFiltered');
  bindToggle('btnToggleTonic',    'showTonic');
  bindToggle('btnTogglePeaks',    'showPeaks');

  // ── Export Buttons ────────────────────────────────────────────────────────
  document.getElementById('exportCsvBtn').addEventListener('click',   exportCSV);
  document.getElementById('exportImageBtn').addEventListener('click', saveCanvasImage);
  document.getElementById('exportMapBtn').addEventListener('click',   saveMapImage);

  // ── Demo Loader ──────────────────────────────────────────────────────────
  document.getElementById('loadDemoBtn').addEventListener('click', loadDemoData);

  // ── GPS slider bindings ──────────────────────────────────────────────────
  bindGpsSlider('gpsMinSats',      'valGpsMinSats',      v => v === 0 ? 'off' : `≥ ${v}`);
  bindGpsSlider('gpsMaxSpeed',     'valGpsMaxSpeed',     v => v === 0 ? 'off' : `${v} m/s`);
  bindGpsSlider('gpsHampelWindow', 'valGpsHampelWindow', v => v === 0 ? 'off' : `${v} s`);
  bindGpsSlider('gpsHampelSigma',  'valGpsHampelSigma',  v => v.toFixed(1));
  bindGpsSlider('gpsDBSCANRadius', 'valGpsDBSCANRadius', v => v === 0 ? 'off' : `${v} m`);
  bindGpsSlider('gpsDBSCANMinPts', 'valGpsDBSCANMinPts', v => `${v} s`);
  bindGpsSlider('gpsKalmanR',      'valGpsKalmanR',      v => v === 0 ? 'off' : `${v} m²`);
  bindGpsSlider('gpsKalmanQ',      'valGpsKalmanQ',      v => `1e-${v}`);
  bindGpsSlider('gpsRDP',          'valGpsRDP',          v => v === 0 ? 'off' : `${v} m`);
  bindGpsSlider('gpsMinDist',      'valGpsMinDist',      v => v === 0 ? 'off' : `${v} m`);
  bindGpsSlider('gpsDownsample',   'valGpsDownsample',   v => v === 0 ? 'off' : '1 Hz');
  bindGpsSlider('gpsTrackWeight',  'valGpsTrackWeight',  v => `${v} px`);

  // Peak latency — re-render map only (no analysis needed), highlight when active
  {
    const slider = document.getElementById('gpsPeakLatency');
    const label  = document.getElementById('valGpsPeakLatency');
    const group  = slider.closest('.slider-group');
    const updateDim = () => {
      updateFilterDim(slider);
      if (group) group.classList.toggle('latency-active', parseFloat(slider.value) > 0);
    };
    updateDim();
    slider.addEventListener('input', () => {
      label.innerText = parseFloat(slider.value).toFixed(1) + ' s';
      updateDim();
      rerenderMap();
      saveSettings();
    });
  }

  // ── View Switcher ────────────────────────────────────────────────────────
  bindViewSwitcher();

  // ── Contour Settings ─────────────────────────────────────────────────────
  bindContourInputs();

  // ── Sidebar Collapse ─────────────────────────────────────────────────────
  bindSidebarToggle();

  // ── Map Panel Controls ───────────────────────────────────────────────────
  document.getElementById('btnMapZoomIn').addEventListener('click', () => {
    if (AppState.mapManager) AppState.mapManager.zoomIn();
  });
  document.getElementById('btnMapZoomOut').addEventListener('click', () => {
    if (AppState.mapManager) AppState.mapManager.zoomOut();
  });
  document.getElementById('btnMapZoomExtent').addEventListener('click', () => {
    if (AppState.mapManager) AppState.mapManager.fitToTrack();
  });
  const btnToggleMapPeaks = document.getElementById('btnToggleMapPeaks');
  btnToggleMapPeaks.addEventListener('click', () => {
    btnToggleMapPeaks.classList.toggle('active');
    if (AppState.mapManager) AppState.mapManager.togglePeaks(btnToggleMapPeaks.classList.contains('active'));
  });

  // ── Panel Collapse Toggles (DRY via bindCollapseButton) ──────────────────
  bindCollapseButton('btnEventsCollapse',        'eventsPanel');
  bindCollapseButton('btnGsrFilteringCollapse',  'gsrFilteringCard');
  bindCollapseButton('btnGpsFilteringCollapse',  'gpsFilteringCard');
  bindCollapseButton('btnImportCollapse',        'importCard');
  bindCollapseButton('btnExportCollapse',        'exportCard');
  bindCollapseButton('btnContourCollapse',       'contourSettingsCard');

  // GSR + Map panels need extra resize after collapse (single listener each)
  setupCollapseWithResize('btnGsrCollapse', 'gsrPanel', () => { windowResized(); });
  setupCollapseWithResize('btnMapCollapse', 'mapPanel', () => {
    if (AppState.mapManager && AppState.mapManager.map) {
      AppState.mapManager.map.invalidateSize();
    }
  });

  // ── Panel Fullscreen ─────────────────────────────────────────────────────
  setupPanelFullscreen('btnGsrFullscreen', 'gsrPanel', () => {
    windowResized();
    setTimeout(() => windowResized(), 40);
    setTimeout(() => windowResized(), 240);
  });
  setupPanelFullscreen('btnMapFullscreen', 'mapPanel', () => {
    AppState.isMapFullscreen = !AppState.isMapFullscreen;
    if (AppState.mapManager && AppState.mapManager.map) {
      AppState.mapManager.map.invalidateSize();
      setTimeout(() => AppState.mapManager.map.invalidateSize(), 40);
      setTimeout(() => AppState.mapManager.map.invalidateSize(), 240);
    }
  });
}

/**
 * View switcher (Single Track ↔ Collective Map Surface).
 */
function bindViewSwitcher() {
  const btnSingleView      = document.getElementById('btnSingleView');
  const btnCollectiveView  = document.getElementById('btnCollectiveView');
  const appMainLayout      = document.querySelector('.main-layout');
  const contourSettingsCard = document.getElementById('contourSettingsCard');

  btnSingleView.addEventListener('click', () => {
    if (AppState.viewMode === 'single') return;
    AppState.viewMode = 'single';
    btnSingleView.classList.add('active');
    btnCollectiveView.classList.remove('active');
    appMainLayout.classList.remove('collective-mode');
    contourSettingsCard.style.display = 'none';

    if (AppState.mapManager) AppState.mapManager.clearCollectiveLayers();

    document.getElementById('gsrPanel').style.display = 'block';
    document.getElementById('eventsPanel').style.display = 'block';

    if (AppState.analyzer && AppState.analyzer.raw.length > 0) {
      loop();
      runAnalysis();
    } else {
      noLoop();
      drawPlaceholder();
      if (AppState.mapManager) AppState.mapManager.clearMap();
    }
    if (AppState.mapManager && AppState.mapManager.map) {
      setTimeout(() => AppState.mapManager.map.invalidateSize(), 80);
    }
  });

  btnCollectiveView.addEventListener('click', () => {
    if (AppState.viewMode === 'collective') return;
    AppState.viewMode = 'collective';
    btnCollectiveView.classList.add('active');
    btnSingleView.classList.remove('active');
    appMainLayout.classList.add('collective-mode');
    contourSettingsCard.style.display = 'block';

    document.getElementById('gsrPanel').style.display = 'none';
    document.getElementById('eventsPanel').style.display = 'none';
    noLoop();

    updateCollectiveMap();
    if (AppState.mapManager && AppState.mapManager.map) {
      setTimeout(() => AppState.mapManager.map.invalidateSize(), 80);
    }
  });
}

/**
 * Contour settings sliders.
 */
function bindContourInputs() {
  const bindCi = (id, labelId, fmt) => {
    const input = document.getElementById(id);
    const label = document.getElementById(labelId);
    input.addEventListener('input', () => {
      if (label) label.innerText = fmt(parseFloat(input.value));
      if (AppState.viewMode === 'collective') updateCollectiveMap();
    });
  };

  bindCi('gridResolution',  'valGridResolution',  v => `${v} x ${v}`);
  bindCi('contourCount',    'valContourCount',    v => `${v} lines`);
  bindCi('isolationRadius', 'valIsolationRadius', v => `${v} m`);
  bindCi('idwExponent',     'valIdwExponent',     v => v.toFixed(1));
  bindCi('surfaceOpacity',  'valSurfaceOpacity',  v => `${Math.round(v * 100)}%`);

  const showShaded   = document.getElementById('showShadedSurface');
  const opacityGroup = document.getElementById('surfaceOpacityGroup');
  if (showShaded && opacityGroup) {
    opacityGroup.style.display = showShaded.checked ? 'block' : 'none';
    showShaded.addEventListener('change', () => {
      opacityGroup.style.display = showShaded.checked ? 'block' : 'none';
      if (AppState.viewMode === 'collective') updateCollectiveMap();
    });
  }

  document.getElementById('topoSource').addEventListener('change', () => {
    if (AppState.viewMode === 'collective') updateCollectiveMap();
  });
}

/**
 * Sidebar collapse toggle.
 */
function bindSidebarToggle() {
  const btn    = document.getElementById('sidebarToggleBtn');
  const layout = document.querySelector('.main-layout');
  let collapsed = false;

  btn.addEventListener('click', () => {
    collapsed = !collapsed;
    layout.classList.toggle('sidebar-collapsed', collapsed);
    const icon = document.getElementById('sidebarToggleIcon');
    if (collapsed) {
      icon.classList.replace('fa-bars', 'fa-bars-staggered');
    } else {
      icon.classList.replace('fa-bars-staggered', 'fa-bars');
    }
    setTimeout(() => windowResized(), 320);
  });
}

/**
 * Initialize control labels to match current slider values.
 */
function initializeLabels() {
  // GSR Labels (show "off" when value is 0)
  const updateLabel = (id, labelId, suffix) => {
    const slider = document.getElementById(id);
    const label  = document.getElementById(labelId);
    if (slider && label) {
      const val = parseFloat(slider.value);
      label.innerText = val === 0 ? 'off' : val.toFixed(suffix.includes('μS') ? 3 : 1) + suffix;
    }
  };
  updateLabel('medianSize',    'valMedianSize',    ' s');
  updateLabel('lpfWindow',     'valLpfWindow',     ' s');
  updateLabel('tonicWindow',   'valTonicWindow',   ' s');
  updateLabel('dwtLevel',      'valDwtLevel',      '');
  updateLabel('peakThreshold', 'valPeakThreshold', ' μS');

  // Initial DWT level group visibility
  const tonicMethod = document.getElementById('tonicMethod');
  const dwtGroup = document.getElementById('dwtLevelGroup');
  if (dwtGroup && tonicMethod) {
    dwtGroup.style.display = tonicMethod.value === 'dwt' ? '' : 'none';
  }

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
    gpsTrackWeight:  v => `${v} px`,
    gpsPeakLatency:  v => `${v.toFixed(1)} s`
  };

  for (const [id, fmt] of Object.entries(gpsFormatters)) {
    const slider = document.getElementById(id);
    const labelId = 'val' + id.charAt(0).toUpperCase() + id.slice(1);
    const label = document.getElementById(labelId);
    if (slider && label) {
      label.innerText = fmt(parseFloat(slider.value));
    }
  }

  // Initial dim state for all GSR sliders (only those that can be 0)
  document.querySelectorAll('#gsrFilteringCard input[type="range"]').forEach(updateFilterDim);
  // Initial dim state for all GPS sliders
  document.querySelectorAll('#gpsFilteringCard input[type="range"]').forEach(updateFilterDim);
}
