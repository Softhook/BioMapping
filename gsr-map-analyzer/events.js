/**
 * DOM Element Caching, Event Binding, and UI Initialization.
 * Extracted from ui.js — handles all slider/button/toggle wiring.
 */

/**
 * Cache all frequently-accessed DOM elements into AppState.
 */
function cacheDOMElements() {
  AppState.fileInput    = document.getElementById('fileInput');
  AppState.dropZone     = document.getElementById('dropZone');
  AppState.fileInfoBox  = document.getElementById('fileInfoBox');
  AppState.loadedFileName = document.getElementById('loadedFileName');
  AppState.loadedFileMeta = document.getElementById('loadedFileMeta');
  AppState.clearFileBtn = document.getElementById('clearFileBtn');
  AppState.tableBody    = document.querySelector('#peaksTable tbody');

  // Sliders
  AppState.sliders.medianSize    = document.getElementById('medianSize');
  AppState.sliders.lpfWindow     = document.getElementById('lpfWindow');
  AppState.sliders.tonicWindow   = document.getElementById('tonicWindow');
  AppState.sliders.tonicMethod   = document.getElementById('tonicMethod');
  AppState.sliders.peakThreshold = document.getElementById('peakThreshold');

  // Stats
  AppState.statFields.duration   = document.getElementById('statDuration');
  AppState.statFields.meanSCL    = document.getElementById('statMeanSCL');
  AppState.statFields.peakCount  = document.getElementById('statPeakCount');
  AppState.statFields.peakFreq   = document.getElementById('statPeakFreq');

  // GPS filter sliders
  AppState.sliders.gpsMinSats      = document.getElementById('gpsMinSats');
  AppState.sliders.gpsMaxSpeed     = document.getElementById('gpsMaxSpeed');
  AppState.sliders.gpsHampelWindow = document.getElementById('gpsHampelWindow');
  AppState.sliders.gpsHampelSigma  = document.getElementById('gpsHampelSigma');
  AppState.sliders.gpsDBSCANRadius = document.getElementById('gpsDBSCANRadius');
  AppState.sliders.gpsDBSCANMinPts = document.getElementById('gpsDBSCANMinPts');
  AppState.sliders.gpsKalmanR      = document.getElementById('gpsKalmanR');
  AppState.sliders.gpsKalmanQ      = document.getElementById('gpsKalmanQ');
  AppState.sliders.gpsRDP          = document.getElementById('gpsRDP');
  AppState.sliders.gpsMinDist      = document.getElementById('gpsMinDist');
  AppState.sliders.gpsDownsample   = document.getElementById('gpsDownsample');
  AppState.sliders.gpsTrackWeight  = document.getElementById('gpsTrackWeight');
}

/**
 * Bind a collapse button to toggle the `.collapsed` class on its card.
 * Replaces 7+ copy-pasted addEventListener blocks.
 */
function bindCollapseButton(btnId, cardId) {
  const btn = document.getElementById(btnId);
  const card = document.getElementById(cardId);
  if (!btn || !card) return;
  btn.addEventListener('click', () => card.classList.toggle('collapsed'));
}

/**
 * Bind a GSR slider: update label immediately, re-run analysis, save settings.
 */
function bindGsrSlider(id, labelId, suffix) {
  const slider = document.getElementById(id);
  const label  = document.getElementById(labelId);
  slider.addEventListener('input', () => {
    label.innerText = parseFloat(slider.value).toFixed(suffix.includes('μS') ? 3 : 1) + suffix;
    runAnalysis();
    saveSettings();
  });
}

/**
 * Bind a GPS slider: update label, re-render map, save settings.
 */
function bindGpsSlider(id, labelId, fmt) {
  const slider = document.getElementById(id);
  const label  = document.getElementById(labelId);
  slider.addEventListener('input', () => {
    label.innerText = fmt(parseFloat(slider.value));
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

  S.tonicMethod.addEventListener('change', () => {
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

  if (AppState.clearFileBtn) {
    AppState.clearFileBtn.addEventListener('click', clearFile);
  }

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
  bindCollapseButton('btnGsrCollapse',           'gsrPanel');
  bindCollapseButton('btnMapCollapse',           'mapPanel');
  bindCollapseButton('btnEventsCollapse',        'eventsPanel');
  bindCollapseButton('btnGsrFilteringCollapse',  'gsrFilteringCard');
  bindCollapseButton('btnGpsFilteringCollapse',  'gpsFilteringCard');
  bindCollapseButton('btnImportCollapse',        'importCard');
  bindCollapseButton('btnExportCollapse',        'exportCard');
  bindCollapseButton('btnContourCollapse',       'contourSettingsCard');

  // ── Panel resize after collapse animations ───────────────────────────────
  document.getElementById('btnGsrCollapse').addEventListener('click', () => {
    const panel = document.getElementById('gsrPanel');
    if (!panel.classList.contains('collapsed')) setTimeout(() => windowResized(), 20);
  });
  document.getElementById('btnMapCollapse').addEventListener('click', () => {
    const panel = document.getElementById('mapPanel');
    if (!panel.classList.contains('collapsed')) {
      setTimeout(() => {
        if (AppState.mapManager && AppState.mapManager.map) {
          AppState.mapManager.map.invalidateSize();
        }
      }, 50);
    }
  });

  // ── Panel Fullscreen ─────────────────────────────────────────────────────
  setupPanelFullscreen('btnGsrFullscreen', 'gsrPanel', () => {
    windowResized();
    setTimeout(() => windowResized(), 40);
    setTimeout(() => windowResized(), 240);
  });
  setupPanelFullscreen('btnMapFullscreen', 'mapPanel', () => {
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
  // GSR Labels
  const updateLabel = (id, labelId, suffix) => {
    const slider = document.getElementById(id);
    const label  = document.getElementById(labelId);
    if (slider && label) {
      label.innerText = parseFloat(slider.value).toFixed(suffix.includes('μS') ? 3 : 1) + suffix;
    }
  };
  updateLabel('medianSize',    'valMedianSize',    ' s');
  updateLabel('lpfWindow',     'valLpfWindow',     ' s');
  updateLabel('tonicWindow',   'valTonicWindow',   ' s');
  updateLabel('peakThreshold', 'valPeakThreshold', ' μS');

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
