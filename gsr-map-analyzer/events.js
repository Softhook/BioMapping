/**
 * DOM Element Caching, Event Binding, and UI Initialization.
 * Extracted from ui.js — handles all slider/button/toggle wiring.
 */

/**
 * Safe DOM lookup — warns on missing elements without crashing.
 */
const GSREvents = {
  /**
   * Safe DOM lookup — warns on missing elements without crashing.
   */
  _id(id) {
    const el = document.getElementById(id);
    if (!el) console.warn('GSR Map Analyzer: DOM element #' + id + ' not found.');
    return el;
  },

  /**
   * Cache all frequently-accessed DOM elements into AppState.
   */
  cacheDOMElements() {
    AppState.fileInput    = GSREvents._id('fileInput');
    AppState.dropZone     = GSREvents._id('dropZone');
    AppState.tableBody    = document.querySelector('#peaksTable tbody');

    // Sliders
    AppState.sliders.medianSize    = GSREvents._id('medianSize');
    AppState.sliders.lpfWindow     = GSREvents._id('lpfWindow');
    AppState.sliders.tonicWindow   = GSREvents._id('tonicWindow');
    AppState.sliders.tonicMethod   = GSREvents._id('tonicMethod');
    AppState.sliders.peakThreshold     = GSREvents._id('peakThreshold');
    AppState.sliders.dwtLevel          = GSREvents._id('dwtLevel');
    AppState.sliders.shapeMinRiseTime  = GSREvents._id('shapeMinRiseTime');
    AppState.sliders.shapeMaxRiseTime  = GSREvents._id('shapeMaxRiseTime');
    AppState.sliders.shapeMinHalfRecovery = GSREvents._id('shapeMinHalfRecovery');
    AppState.sliders.shapeMaxHalfRecovery = GSREvents._id('shapeMaxHalfRecovery');
    AppState.sliders.shapeMinSnr       = GSREvents._id('shapeMinSnr');
    AppState.sliders.shapeMaxSkewRatio = GSREvents._id('shapeMaxSkewRatio');

    // Stats
    AppState.statFields.date       = GSREvents._id('statDate');
    AppState.statFields.startTime  = GSREvents._id('statStartTime');
    AppState.statFields.duration   = GSREvents._id('statDuration');
    AppState.statFields.meanSCL    = GSREvents._id('statMeanSCL');
    AppState.statFields.peakCount  = GSREvents._id('statPeakCount');
    AppState.statFields.peakFreq   = GSREvents._id('statPeakFreq');

    // GPS filter sliders
    AppState.sliders.gpsMinSats      = GSREvents._id('gpsMinSats');
    AppState.sliders.gpsMaxSpeed     = GSREvents._id('gpsMaxSpeed');
    AppState.sliders.gpsHampelWindow = GSREvents._id('gpsHampelWindow');
    AppState.sliders.gpsHampelSigma  = GSREvents._id('gpsHampelSigma');
    AppState.sliders.gpsDBSCANRadius = GSREvents._id('gpsDBSCANRadius');
    AppState.sliders.gpsDBSCANMinPts = GSREvents._id('gpsDBSCANMinPts');
    AppState.sliders.gpsKalmanR      = GSREvents._id('gpsKalmanR');
    AppState.sliders.gpsKalmanQ      = GSREvents._id('gpsKalmanQ');
    AppState.sliders.gpsRDP          = GSREvents._id('gpsRDP');
    AppState.sliders.gpsDownsample   = GSREvents._id('gpsDownsample');
    AppState.sliders.gpsTrackWeight  = GSREvents._id('gpsTrackWeight');
    AppState.sliders.gpsPeakLatency  = GSREvents._id('gpsPeakLatency');

    // Contour controls (used in collective map)
    AppState.contourControls = {
      gridResolution:    GSREvents._id('gridResolution'),
      contourCount:      GSREvents._id('contourCount'),
      isolationRadius:   GSREvents._id('isolationRadius'),
      idwExponent:       GSREvents._id('idwExponent'),
      topoSource:        GSREvents._id('topoSource'),
      showShadedSurface: GSREvents._id('showShadedSurface'),
      surfaceOpacity:    GSREvents._id('surfaceOpacity')
    };
  },

  /**
   * Bind a collapse button to toggle the `.collapsed` class on its card.
   * Replaces 7+ copy-pasted addEventListener blocks.
   */
  bindCollapseButton(btnId, cardId) {
    const btn = GSREvents._id(btnId);
    const card = GSREvents._id(cardId);
    if (!btn || !card) return;
    btn.addEventListener('click', () => card.classList.toggle('collapsed'));
  },

  /**
   * Like bindCollapseButton but also calls onExpand after the expand animation.
   * Avoids the double-listener pattern that previously existed for GSR + Map panels.
   */
  setupCollapseWithResize(btnId, cardId, onExpand) {
    const btn = document.getElementById(btnId);
    const card = document.getElementById(cardId);
    if (!btn || !card) return;
    btn.addEventListener('click', () => {
      const wasCollapsed = card.classList.contains('collapsed');
      card.classList.toggle('collapsed');
      if (wasCollapsed && onExpand) setTimeout(onExpand, 50);
    });
  },

  /**
   * Update the dimmed state of a slider-group based on whether value is 0 (off).
   * If a parentId is provided, dims based on the parent slider's value instead.
   */
  updateFilterDim(slider, parentId) {
    const group = slider.closest('.slider-group');
    if (!group) return;
    let val;
    if (parentId) {
      const parent = document.getElementById(parentId);
      if (!parent) return;
      val = parseFloat(parent.value);
    } else {
      val = parseFloat(slider.value);
    }
    group.classList.toggle('filter-off', val === 0);
  },

  /**
   * Bind a GSR slider: update label immediately, re-run analysis, save settings.
   * Shows "off" when value is 0 and dims the slider group.
   */
  bindGsrSlider(id, labelId, suffix) {
    const slider = document.getElementById(id);
    const label  = document.getElementById(labelId);
    const updateDim = () => GSREvents.updateFilterDim(slider);

    // Initial dim state
    updateDim();

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      label.innerText = val === 0 ? 'off' : val.toFixed(suffix.includes('μS') ? 3 : 1) + suffix;
      updateDim();
      GSRUI.runAnalysis();
      GSRStorage.saveSettings();
    });
  },

  /**
   * Bind a GPS slider: update label, re-render map, save settings.
   * Dims the slider group when value is 0 (off).
   * If parentId is set, dims based on the parent slider's value instead.
   */
  bindGpsSlider(id, labelId, fmt, parentId) {
    const slider = document.getElementById(id);
    const label  = document.getElementById(labelId);
    const updateDim = () => GSREvents.updateFilterDim(slider, parentId);

    // Initial dim state
    updateDim();

    slider.addEventListener('input', () => {
      label.innerText = fmt(parseFloat(slider.value));
      updateDim();
      GSRUI.rerenderMap();
      GSRStorage.saveSettings();
    });

    // Re-evaluate dim state when the parent slider changes
    if (parentId) {
      const parent = document.getElementById(parentId);
      if (parent) parent.addEventListener('input', updateDim);
    }
  },

  /**
   * Wire up all UI event listeners (sliders, file drop, buttons, toggles, panels).
   */
  setupEventListeners() {
    const S = AppState.sliders;

    // ── GSR slider bindings ──────────────────────────────────────────────────
    GSREvents.bindGsrSlider('medianSize',    'valMedianSize',    ' s');
    GSREvents.bindGsrSlider('lpfWindow',     'valLpfWindow',     ' s');
    GSREvents.bindGsrSlider('tonicWindow',   'valTonicWindow',   ' s');
    GSREvents.bindGsrSlider('peakThreshold',     'valPeakThreshold',     ' μS');
    GSREvents.bindGsrSlider('shapeMinRiseTime',  'valShapeMinRiseTime',  ' s');
    GSREvents.bindGsrSlider('shapeMaxRiseTime',  'valShapeMaxRiseTime',  ' s');
    GSREvents.bindGsrSlider('shapeMinHalfRecovery', 'valShapeMinHalfRecovery', ' s');
    GSREvents.bindGsrSlider('shapeMaxHalfRecovery', 'valShapeMaxHalfRecovery', ' s');
    GSREvents.bindGsrSlider('shapeMinSnr',       'valShapeMinSnr',       '×');
    GSREvents.bindGsrSlider('shapeMaxSkewRatio', 'valShapeMaxSkewRatio', '');

    // DWT level — custom binding (integer display)
    if (S.dwtLevel) {
      S.dwtLevel.addEventListener('input', () => {
        const level = parseInt(S.dwtLevel.value);
        document.getElementById('valDwtLevel').innerText = level;
        GSRUI.runAnalysis();
        GSRStorage.saveSettings();
      });
    }

    S.tonicMethod.addEventListener('change', () => {
      // Show/hide DWT level slider based on selected method
      const dwtGroup = document.getElementById('dwtLevelGroup');
      if (dwtGroup) {
        dwtGroup.style.display = S.tonicMethod.value === 'dwt' ? '' : 'none';
      }
      GSRUI.runAnalysis();
      GSRStorage.saveSettings();
    });

    // ── File Upload Handlers ──────────────────────────────────────────────────
    AppState.fileInput.addEventListener('change', GSRTrackManager.handleFileSelect);

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
        GSRTrackManager.loadFilesSequentially(Array.from(e.dataTransfer.files));
      }
    });
    AppState.dropZone.addEventListener('click', (e) => {
      if (!e.target.closest('label') && e.target !== AppState.fileInput) {
        AppState.fileInput.click();
      }
    });

    // ── Leaflet-to-Timeline scrubbing callback ────────────────────────────────
    GSREvents.updateTimelineScrub = (time) => {
      if (AppState.analyzer.raw.length === 0) return;
      AppState.hoveredIndex = AppState.analyzer.findClosestIndex(time);
      if (AppState.hoveredIndex !== -1) {
        const sample = AppState.analyzer.raw[AppState.hoveredIndex];
        if (sample && sample.hasGps && !isNaN(sample.lat) && !isNaN(sample.lon) && AppState.mapManager) {
          AppState.mapManager.setScrubPosition(sample.lat, sample.lon, false);
        }
        redraw();
      }
    };

    // ── Canvas Control Buttons ────────────────────────────────────────────────
    document.getElementById('btnZoomIn').addEventListener('click',    () => GSRUI.zoomCanvas(1.5));
    document.getElementById('btnZoomOut').addEventListener('click',   () => GSRUI.zoomCanvas(0.67));
    document.getElementById('btnResetView').addEventListener('click', GSRUI.resetView);

    const timeWindowSelect = document.getElementById('timeWindowSelect');
    if (timeWindowSelect) {
      timeWindowSelect.addEventListener('change', () => {
        const val = timeWindowSelect.value;
        if (val === 'fit') {
          GSRUI.resetView();
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
    document.getElementById('exportCsvBtn').addEventListener('click',   GSRUI.exportCSV);
    document.getElementById('exportImageBtn').addEventListener('click', GSRUI.saveCanvasImage);
    document.getElementById('exportMapBtn').addEventListener('click',   GSRUI.saveMapImage);

    // ── Demo Loader ──────────────────────────────────────────────────────────
    document.getElementById('loadDemoBtn').addEventListener('click', GSRTrackManager.loadDefaultTrack);

    // ── GPS slider bindings ──────────────────────────────────────────────────
    GSREvents.bindGpsSlider('gpsMinSats',      'valGpsMinSats',      v => v === 0 ? 'off' : `≥ ${v}`);
    GSREvents.bindGpsSlider('gpsMaxSpeed',     'valGpsMaxSpeed',     v => v === 0 ? 'off' : `${v} m/s`);
    GSREvents.bindGpsSlider('gpsHampelWindow', 'valGpsHampelWindow', v => v === 0 ? 'off' : `${v} s`);
    GSREvents.bindGpsSlider('gpsHampelSigma',  'valGpsHampelSigma',  v => v.toFixed(1), 'gpsHampelWindow');
    GSREvents.bindGpsSlider('gpsDBSCANRadius', 'valGpsDBSCANRadius', v => v === 0 ? 'off' : `${v} m`);
    GSREvents.bindGpsSlider('gpsDBSCANMinPts', 'valGpsDBSCANMinPts', v => `${v} s`, 'gpsDBSCANRadius');
    GSREvents.bindGpsSlider('gpsKalmanR',      'valGpsKalmanR',      v => v === 0 ? 'off' : `${v} m²`);
    GSREvents.bindGpsSlider('gpsKalmanQ',      'valGpsKalmanQ',      v => v === 0 ? 'off' : `${v} m²`, 'gpsKalmanR');
    GSREvents.bindGpsSlider('gpsRDP',          'valGpsRDP',          v => v === 0 ? 'off' : `${v} m`);
    GSREvents.bindGpsSlider('gpsDownsample',   'valGpsDownsample',   v => v === 0 ? 'off' : '1 Hz');
    GSREvents.bindGpsSlider('gpsTrackWeight',  'valGpsTrackWeight',  v => `${v} px`);

    // Peak latency — re-render map only (no analysis needed), highlight when active
    {
      const slider = document.getElementById('gpsPeakLatency');
      const label  = document.getElementById('valGpsPeakLatency');
      const group  = slider.closest('.slider-group');
      const updateDim = () => {
        GSREvents.updateFilterDim(slider);
        if (group) group.classList.toggle('latency-active', parseFloat(slider.value) > 0);
      };
      updateDim();
      slider.addEventListener('input', () => {
        label.innerText = parseFloat(slider.value).toFixed(1) + ' s';
        updateDim();
        GSRUI.rerenderMap();
        GSRStorage.saveSettings();
      });
    }

    // ── View Switcher ────────────────────────────────────────────────────────
    GSREvents.bindViewSwitcher();

    // ── Contour Settings ─────────────────────────────────────────────────────
    GSREvents.bindContourInputs();

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
    GSREvents.bindCollapseButton('btnEventsCollapse',        'eventsPanel');
    GSREvents.bindCollapseButton('btnGsrFilteringCollapse',  'gsrFilteringCard');
    GSREvents.bindCollapseButton('btnGpsFilteringCollapse',  'gpsFilteringCard');
    GSREvents.bindCollapseButton('btnMapDisplayCollapse',    'mapDisplayCard');
    GSREvents.bindCollapseButton('btnImportCollapse',        'importCard');
    GSREvents.bindCollapseButton('btnExportCollapse',        'exportCard');
    GSREvents.bindCollapseButton('btnContourCollapse',       'contourSettingsCard');

    // GSR + Map panels need extra resize after collapse (single listener each)
    GSREvents.setupCollapseWithResize('btnGsrCollapse', 'gsrPanel', () => { windowResized(); });
    GSREvents.setupCollapseWithResize('btnMapCollapse', 'mapPanel', () => {
      if (AppState.mapManager && AppState.mapManager.map) {
        AppState.mapManager.map.invalidateSize();
      }
    });

    // ── Panel Fullscreen ─────────────────────────────────────────────────────
    GSRUI.setupPanelFullscreen('btnGsrFullscreen', 'gsrPanel', () => {
      windowResized();
      setTimeout(() => windowResized(), 40);
      setTimeout(() => windowResized(), 240);
    });
    GSRUI.setupPanelFullscreen('btnMapFullscreen', 'mapPanel', () => {
      AppState.isMapFullscreen = !AppState.isMapFullscreen;
      if (AppState.mapManager && AppState.mapManager.map) {
        AppState.mapManager.map.invalidateSize();
        setTimeout(() => AppState.mapManager.map.invalidateSize(), 40);
        setTimeout(() => AppState.mapManager.map.invalidateSize(), 240);
      }
    });
  },

  /**
   * View switcher (Single Track ↔ Collective Map Surface).
   */
  bindViewSwitcher() {
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
        GSRUI.runAnalysis();
      } else {
        noLoop();
        GSRRenderer.drawPlaceholder();
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

      GSRUI.updateCollectiveMap();
      if (AppState.mapManager && AppState.mapManager.map) {
        setTimeout(() => AppState.mapManager.map.invalidateSize(), 80);
      }
    });
  },

  /**
   * Contour settings sliders.
   */
  bindContourInputs() {
    const bindCi = (id, labelId, fmt) => {
      const input = document.getElementById(id);
      const label = document.getElementById(labelId);
      input.addEventListener('input', () => {
        if (label) label.innerText = fmt(parseFloat(input.value));
        if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
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
        if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
      });
    }

    document.getElementById('topoSource').addEventListener('change', () => {
      if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
    });
  },

  /**
   * Initialize control labels to match current slider values.
   */
  initializeLabels() {
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
    updateLabel('peakThreshold',     'valPeakThreshold',     ' μS');
    updateLabel('shapeMinRiseTime',  'valShapeMinRiseTime',  ' s');
    updateLabel('shapeMaxRiseTime',  'valShapeMaxRiseTime',  ' s');
    updateLabel('shapeMinHalfRecovery', 'valShapeMinHalfRecovery', ' s');
    updateLabel('shapeMaxHalfRecovery', 'valShapeMaxHalfRecovery', ' s');
    // SNR: custom formatting with × suffix
    const snrSlider = document.getElementById('shapeMinSnr');
    const snrLabel  = document.getElementById('valShapeMinSnr');
    if (snrSlider && snrLabel) {
      snrLabel.innerText = parseFloat(snrSlider.value).toFixed(1) + '\u00d7';
    }
    updateLabel('shapeMaxSkewRatio', 'valShapeMaxSkewRatio', '');

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
      gpsKalmanQ:      v => v === 0 ? 'off' : `${v} m²`,
      gpsRDP:          v => v === 0 ? 'off' : `${v} m`,
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
    document.querySelectorAll('#gsrFilteringCard input[type="range"]').forEach(GSREvents.updateFilterDim);
    // Initial dim state for GPS sliders (dependent sliders check their parent)
    const gpsParentMap = {
      gpsHampelSigma:  'gpsHampelWindow',
      gpsDBSCANMinPts: 'gpsDBSCANRadius',
      gpsKalmanQ:      'gpsKalmanR'
    };
    document.querySelectorAll('#gpsFilteringCard input[type="range"]').forEach(slider => {
      GSREvents.updateFilterDim(slider, gpsParentMap[slider.id]);
    });
    // Initial dim state for map display sliders
    document.querySelectorAll('#mapDisplayCard input[type="range"]').forEach(GSREvents.updateFilterDim);
  }
};
