/**
 * p5.js Sketch for GSR / EDA Visualizer
 */

let analyzer;
let collectiveManager;
let activeTrackId = null;
let viewMode = 'single'; // 'single' or 'collective'
const TRACK_COLORS = [
  '#0ea5e9', // sky blue
  '#a855f7', // purple
  '#f43f5e', // rose red
  '#10b981', // green
  '#eab308', // yellow
  '#f97316', // orange
  '#06b6d4', // cyan
  '#ec4899'  // pink
];
let trackColorIndex = 0;
function getNextTrackColor() {
  const color = TRACK_COLORS[trackColorIndex % TRACK_COLORS.length];
  trackColorIndex++;
  return color;
}
let myCanvas;

// Timeline variables
let yTimelineTop = 0;
let yTimelineBottom = 0;
let isDraggingTimeline = false;

// Viewport variables (zoom and pan)
let totalDuration = 120.0; // Default demo duration
let viewStartTime = 0.0;
let viewDuration = 120.0;
let zoomFactor = 1.0;
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 50.0;

// Graph layout margins
const margin = {
  left: 65,
  right: 25,
  top: 25,
  bottom: 35,
  gap: 30
};

// Visibility states
let showRaw = true;
let showFiltered = true;
let showTonic = true;
let showPeaks = true;

// Interaction
let isDragging = false;
let dragStartMouseX = 0;
let dragStartViewStart = 0;
let hoveredIndex = -1;
let activePeakIndex = -1; // Index of the peak highlighted by table click

// DOM Elements cache
let sliders = {};
let statFields = {};
let tableBody;
let mapManager; // Leaflet Map controller

function setup() {
  // Initialize Collective Manager and Analyzer
  collectiveManager = new GSRCollectiveManager();
  analyzer = new GSRAnalyzer();

  // Initialize Map Manager
  mapManager = new GSRMapManager('map');

  // Create canvas inside container
  const container = document.getElementById('canvasContainer');
  const w = container.clientWidth;
  const h = container.clientHeight || 450;
  myCanvas = createCanvas(w, h);
  myCanvas.parent('canvasContainer');

  // Disable default context menu on canvas
  myCanvas.elt.oncontextmenu = (e) => e.preventDefault();

  // Cache DOM elements
  cacheDOMElements();

  // Load saved settings & update labels
  loadSettings();
  initializeLabels();

  // Setup UI Event Listeners
  setupEventListeners();

  // Draw background initially
  noLoop();
  drawPlaceholder();
}

function cacheDOMElements() {
  fileInput = document.getElementById('fileInput');
  dropZone = document.getElementById('dropZone');
  fileInfoBox = document.getElementById('fileInfoBox');
  loadedFileName = document.getElementById('loadedFileName');
  loadedFileMeta = document.getElementById('loadedFileMeta');
  clearFileBtn = document.getElementById('clearFileBtn');
  tableBody = document.querySelector('#peaksTable tbody');

  // Sliders
  sliders.medianSize = document.getElementById('medianSize');
  sliders.lpfWindow = document.getElementById('lpfWindow');
  sliders.tonicWindow = document.getElementById('tonicWindow');
  sliders.tonicMethod = document.getElementById('tonicMethod');
  sliders.peakThreshold = document.getElementById('peakThreshold');

  // Stats
  statFields.duration = document.getElementById('statDuration');
  statFields.meanSCL = document.getElementById('statMeanSCL');
  statFields.peakCount = document.getElementById('statPeakCount');
  statFields.peakFreq = document.getElementById('statPeakFreq');

  // GPS filter sliders
  sliders.gpsMinSats      = document.getElementById('gpsMinSats');
  sliders.gpsMaxSpeed     = document.getElementById('gpsMaxSpeed');
  sliders.gpsHampelWindow = document.getElementById('gpsHampelWindow');
  sliders.gpsHampelSigma  = document.getElementById('gpsHampelSigma');
  sliders.gpsDBSCANRadius = document.getElementById('gpsDBSCANRadius');
  sliders.gpsDBSCANMinPts = document.getElementById('gpsDBSCANMinPts');
  sliders.gpsKalmanR      = document.getElementById('gpsKalmanR');
  sliders.gpsKalmanQ      = document.getElementById('gpsKalmanQ');
  sliders.gpsRDP          = document.getElementById('gpsRDP');
  sliders.gpsMinDist      = document.getElementById('gpsMinDist');
  sliders.gpsDownsample   = document.getElementById('gpsDownsample');
  sliders.gpsTrackWeight  = document.getElementById('gpsTrackWeight');
}

function setupEventListeners() {
  // Sliders input events (update value label immediately and re-analyze)
  const bindSlider = (id, labelId, suffix = '') => {
    const slider = document.getElementById(id);
    const label = document.getElementById(labelId);
    slider.addEventListener('input', () => {
      label.innerText = parseFloat(slider.value).toFixed(suffix.includes('μS') ? 3 : 1) + suffix;
      runAnalysis();
      saveSettings();
    });
  };

  bindSlider('medianSize', 'valMedianSize', ' s');
  bindSlider('lpfWindow', 'valLpfWindow', ' s');
  bindSlider('tonicWindow', 'valTonicWindow', ' s');
  bindSlider('peakThreshold', 'valPeakThreshold', ' μS');

  sliders.tonicMethod.addEventListener('change', () => {
    runAnalysis();
    saveSettings();
  });

  // File Upload Handlers
  fileInput.addEventListener('change', handleFileSelect);
  
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      loadFilesSequentially(files);
    }
  });

  dropZone.addEventListener('click', (e) => {
    // Only programmatically click input if they clicked the dropZone background,
    // not the browse button/label which naturally triggers the file dialog.
    if (!e.target.closest('label') && e.target !== fileInput) {
      fileInput.click();
    }
  });

  if (clearFileBtn) {
    clearFileBtn.addEventListener('click', clearFile);
  }

  // Window-level callback for Leaflet-to-Timeline scrubbing
  window.updateTimelineScrub = (time) => {
    if (analyzer.raw.length === 0) return;
    hoveredIndex = findClosestIndex(time);
    if (hoveredIndex !== -1) {
      const sample = analyzer.raw[hoveredIndex];
      if (sample && sample.hasGps && !isNaN(sample.lat) && !isNaN(sample.lon) && mapManager) {
        mapManager.setScrubPosition(sample.lat, sample.lon, false);
      }
      redraw(); // Refresh p5.js canvas to draw scrubbing cursor
    }
  };

  // Canvas Control Buttons
  document.getElementById('btnZoomIn').addEventListener('click', () => zoomCanvas(1.5));
  document.getElementById('btnZoomOut').addEventListener('click', () => zoomCanvas(0.67));
  document.getElementById('btnResetView').addEventListener('click', resetView);

  const timeWindowSelect = document.getElementById('timeWindowSelect');
  if (timeWindowSelect) {
    timeWindowSelect.addEventListener('change', () => {
      const val = timeWindowSelect.value;
      if (val === 'fit') {
        resetView();
      } else if (val !== 'custom') {
        const windowSec = parseFloat(val);
        viewDuration = Math.min(windowSec, totalDuration);
        viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));
        zoomFactor = totalDuration / viewDuration;
        redraw();
      }
    });
  }

  // Curve Toggles
  const bindToggle = (btnId, stateVarSetter, isStateVar) => {
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      if (btnId === 'btnToggleRaw') showRaw = !showRaw;
      if (btnId === 'btnToggleFiltered') showFiltered = !showFiltered;
      if (btnId === 'btnToggleTonic') showTonic = !showTonic;
      if (btnId === 'btnTogglePeaks') showPeaks = !showPeaks;
      redraw();
    });
  };

  bindToggle('btnToggleRaw');
  bindToggle('btnToggleFiltered');
  bindToggle('btnToggleTonic');
  bindToggle('btnTogglePeaks');

  // Exports
  document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
  document.getElementById('exportImageBtn').addEventListener('click', saveCanvasImage);
  document.getElementById('exportMapBtn').addEventListener('click', saveMapImage);

  // Demo loader buttons
  document.getElementById('loadDemoBtn').addEventListener('click', loadDemoData);

  const bindGpsSlider = (id, labelId, fmt) => {
    const slider = document.getElementById(id);
    const label  = document.getElementById(labelId);
    slider.addEventListener('input', () => {
      label.innerText = fmt(parseFloat(slider.value));
      rerenderMap();
      saveSettings();
    });
  };

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

  // ── View Switcher Event Listeners ─────────────────────────────────────────
  const btnSingleView = document.getElementById('btnSingleView');
  const btnCollectiveView = document.getElementById('btnCollectiveView');
  const appMainLayout = document.querySelector('.main-layout');
  const contourSettingsCard = document.getElementById('contourSettingsCard');

  btnSingleView.addEventListener('click', () => {
    if (viewMode === 'single') return;
    viewMode = 'single';
    btnSingleView.classList.add('active');
    btnCollectiveView.classList.remove('active');
    appMainLayout.classList.remove('collective-mode');
    contourSettingsCard.style.display = 'none';

    // Clear collective layers from map
    if (mapManager) {
      mapManager.clearCollectiveLayers();
    }

    // Show single-track panels
    document.getElementById('gsrPanel').style.display = 'block';
    document.getElementById('eventsPanel').style.display = 'block';

    if (analyzer && analyzer.raw.length > 0) {
      loop();
      runAnalysis();
    } else {
      noLoop();
      drawPlaceholder();
      if (mapManager) mapManager.clearMap();
    }
    if (mapManager && mapManager.map) {
      setTimeout(() => mapManager.map.invalidateSize(), 80);
    }
  });

  btnCollectiveView.addEventListener('click', () => {
    if (viewMode === 'collective') return;
    viewMode = 'collective';
    btnCollectiveView.classList.add('active');
    btnSingleView.classList.remove('active');
    appMainLayout.classList.add('collective-mode');
    contourSettingsCard.style.display = 'block';

    // Hide single-track panels
    document.getElementById('gsrPanel').style.display = 'none';
    document.getElementById('eventsPanel').style.display = 'none';
    noLoop(); // stop timeline loop

    updateCollectiveMap();
    if (mapManager && mapManager.map) {
      setTimeout(() => mapManager.map.invalidateSize(), 80);
    }
  });

  // ── Contour Settings Event Listeners ──────────────────────────────────────
  const bindContourInput = (id, labelId, fmt) => {
    const input = document.getElementById(id);
    const label = document.getElementById(labelId);
    input.addEventListener('input', () => {
      if (label) label.innerText = fmt(parseFloat(input.value));
      if (viewMode === 'collective') {
        updateCollectiveMap();
      }
    });
  };

  bindContourInput('gridResolution', 'valGridResolution', v => `${v} x ${v}`);
  bindContourInput('contourCount', 'valContourCount', v => `${v} lines`);
  bindContourInput('isolationRadius', 'valIsolationRadius', v => `${v} m`);
  bindContourInput('idwExponent', 'valIdwExponent', v => v.toFixed(1));
  bindContourInput('surfaceOpacity', 'valSurfaceOpacity', v => `${Math.round(v * 100)}%`);

  const showShaded = document.getElementById('showShadedSurface');
  const opacityGroup = document.getElementById('surfaceOpacityGroup');
  if (showShaded && opacityGroup) {
    opacityGroup.style.display = showShaded.checked ? 'block' : 'none';
    showShaded.addEventListener('change', () => {
      opacityGroup.style.display = showShaded.checked ? 'block' : 'none';
      if (viewMode === 'collective') {
        updateCollectiveMap();
      }
    });
  }
  
  document.getElementById('topoSource').addEventListener('change', () => {
    if (viewMode === 'collective') {
      updateCollectiveMap();
    }
  });

  // ── Sidebar Collapse Toggle ──────────────────────────────────────────────
  const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
  const mainLayout = document.querySelector('.main-layout');
  let sidebarCollapsed = false;

  sidebarToggleBtn.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    mainLayout.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    // Swap icon between bars (open) and bars-staggered (collapsed) for clear affordance
    const icon = document.getElementById('sidebarToggleIcon');
    if (sidebarCollapsed) {
      icon.classList.replace('fa-bars', 'fa-bars-staggered');
    } else {
      icon.classList.replace('fa-bars-staggered', 'fa-bars');
    }
    // Allow the CSS transition to finish before recalculating canvas size
    setTimeout(() => windowResized(), 320);
  });

  // ── Map Panel Controls ───────────────────────────────────────────────────
  document.getElementById('btnMapZoomIn').addEventListener('click', () => {
    if (mapManager) mapManager.zoomIn();
  });
  document.getElementById('btnMapZoomOut').addEventListener('click', () => {
    if (mapManager) mapManager.zoomOut();
  });
  document.getElementById('btnMapZoomExtent').addEventListener('click', () => {
    if (mapManager) mapManager.fitToTrack();
  });
  const btnToggleMapPeaks = document.getElementById('btnToggleMapPeaks');
  btnToggleMapPeaks.addEventListener('click', () => {
    btnToggleMapPeaks.classList.toggle('active');
    const isVisible = btnToggleMapPeaks.classList.contains('active');
    if (mapManager) mapManager.togglePeaks(isVisible);
  });

  // ── Panel Collapse Toggles ───────────────────────────────────────────────
  const gsrPanel = document.getElementById('gsrPanel');
  const btnGsrCollapse = document.getElementById('btnGsrCollapse');
  btnGsrCollapse.addEventListener('click', () => {
    gsrPanel.classList.toggle('collapsed');
    if (!gsrPanel.classList.contains('collapsed')) {
      setTimeout(() => windowResized(), 20);
    }
  });

  const mapPanel = document.getElementById('mapPanel');
  const btnMapCollapse = document.getElementById('btnMapCollapse');
  btnMapCollapse.addEventListener('click', () => {
    mapPanel.classList.toggle('collapsed');
    if (!mapPanel.classList.contains('collapsed')) {
      setTimeout(() => {
        if (mapManager && mapManager.map) {
          mapManager.map.invalidateSize();
        }
      }, 50);
    }
  });

  const eventsPanel = document.getElementById('eventsPanel');
  const btnEventsCollapse = document.getElementById('btnEventsCollapse');
  btnEventsCollapse.addEventListener('click', () => {
    eventsPanel.classList.toggle('collapsed');
  });

  // GSR and GPS filtering sidebar cards collapse
  const gsrFilteringCard = document.getElementById('gsrFilteringCard');
  const btnGsrFilteringCollapse = document.getElementById('btnGsrFilteringCollapse');
  btnGsrFilteringCollapse.addEventListener('click', () => {
    gsrFilteringCard.classList.toggle('collapsed');
  });

  const gpsFilteringCard = document.getElementById('gpsFilteringCard');
  const btnGpsFilteringCollapse = document.getElementById('btnGpsFilteringCollapse');
  btnGpsFilteringCollapse.addEventListener('click', () => {
    gpsFilteringCard.classList.toggle('collapsed');
  });

  // Import and Export sidebar cards collapse
  const importCard = document.getElementById('importCard');
  const btnImportCollapse = document.getElementById('btnImportCollapse');
  btnImportCollapse.addEventListener('click', () => {
    importCard.classList.toggle('collapsed');
  });

  const exportCard = document.getElementById('exportCard');
  const btnExportCollapse = document.getElementById('btnExportCollapse');
  btnExportCollapse.addEventListener('click', () => {
    exportCard.classList.toggle('collapsed');
  });

  const contourSettingsCardElement = document.getElementById('contourSettingsCard');
  const btnContourCollapse = document.getElementById('btnContourCollapse');
  if (btnContourCollapse && contourSettingsCardElement) {
    btnContourCollapse.addEventListener('click', () => {
      contourSettingsCardElement.classList.toggle('collapsed');
    });
  }

  // ── GSR Panel Fullscreen ─────────────────────────────────────────────────
  setupPanelFullscreen(
    'btnGsrFullscreen',
    'gsrPanel',
    () => {
      windowResized(); // immediate
      setTimeout(() => windowResized(), 40); // browser layout reflow
      setTimeout(() => windowResized(), 240); // animation transition complete
    }
  );

  // ── Map Panel Fullscreen ─────────────────────────────────────────────────
  setupPanelFullscreen(
    'btnMapFullscreen',
    'mapPanel',
    () => {
      // Invalidate Leaflet map size after DOM resize
      if (mapManager && mapManager.map) {
        mapManager.map.invalidateSize();
        setTimeout(() => mapManager.map.invalidateSize(), 40);
        setTimeout(() => mapManager.map.invalidateSize(), 240);
      }
    }
  );
}

/**
 * Generic helper: makes a panel section go full-screen by inserting it into
 * a fixed overlay div, then restores it when the button is clicked again or
 * the user presses Escape.
 *
 * @param {string} btnId   – ID of the expand button
 * @param {string} panelId – ID of the <section> to fullscreen
 * @param {Function} [onToggle] – optional callback fired on enter and exit
 */
function setupPanelFullscreen(btnId, panelId, onToggle) {
  const btn   = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  if (!btn || !panel) return;

  let overlay      = null;
  let placeholder  = null; // invisible element that keeps the layout slot
  let escapeHint   = null;
  let isFs         = false;

  const enter = () => {
    isFs = true;
    btn.classList.add('is-fullscreen');
    btn.querySelector('i').classList.replace('fa-expand', 'fa-compress');

    // Create a placeholder so the layout doesn't jump
    placeholder = document.createElement('div');
    placeholder.style.cssText = `
      width: ${panel.offsetWidth}px;
      height: ${panel.offsetHeight}px;
      visibility: hidden;
    `;
    panel.parentNode.insertBefore(placeholder, panel);

    // Build the overlay wrapper
    overlay = document.createElement('div');
    overlay.className = 'panel-fullscreen-overlay';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Escape hint
    escapeHint = document.createElement('div');
    escapeHint.className = 'fs-escape-hint';
    escapeHint.innerHTML = '<i class="fa-solid fa-compress" style="margin-right:5px;"></i>Press Esc or click <strong>⊡</strong> to exit full screen';
    document.body.appendChild(escapeHint);
    // Remove after animation ends
    setTimeout(() => { if (escapeHint) escapeHint.remove(); escapeHint = null; }, 3200);

    if (onToggle) onToggle();
  };

  const exit = () => {
    if (!isFs) return;
    isFs = false;
    btn.classList.remove('is-fullscreen');
    btn.querySelector('i').classList.replace('fa-compress', 'fa-expand');

    // Restore the panel to its original position
    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(panel, placeholder);
      placeholder.remove();
      placeholder = null;
    }

    // Remove overlay
    if (overlay && overlay.parentNode) {
      overlay.remove();
      overlay = null;
    }

    // Remove hint if still present
    if (escapeHint) { escapeHint.remove(); escapeHint = null; }

    if (onToggle) onToggle();
  };

  btn.addEventListener('click', () => { isFs ? exit() : enter(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFs) exit();
  });
}

function windowResized() {
  const container = document.getElementById('canvasContainer');
  const w = container.clientWidth;
  const h = container.clientHeight || 450;
  resizeCanvas(w, h);
  redraw();
}

/**
 * Main draw loop (runs only when loop() is active, which is triggered after file load)
 */
function draw() {
  if (!analyzer || !analyzer.raw || analyzer.raw.length === 0) {
    drawPlaceholder();
    return;
  }

  background(9, 13, 22);

  // Calculate panel split dimensions
  const innerWidth = width - margin.left - margin.right;
  
  // Timeline heights
  const timelineHeight = 22;
  const timelineGap = 25;

  // Subtract timeline from total height budget
  const totalHeight = height - margin.top - margin.bottom - margin.gap - timelineHeight - timelineGap;
  
  const hUpper = totalHeight * 0.62; // Upper graph gets 62%
  const hLower = totalHeight * 0.38; // Lower graph gets 38%
  
  const yUpperBottom = margin.top + hUpper;
  const yLowerTop = yUpperBottom + margin.gap;
  const yLowerBottom = yLowerTop + hLower;

  // Save dynamic vertical bounds for timeline interaction
  yTimelineTop = yLowerBottom + timelineGap;
  yTimelineBottom = yTimelineTop + timelineHeight;

  // View bounds
  const viewEndTime = viewStartTime + viewDuration;

  // Get data points within viewport (plus one padding for boundary drawing)
  const inViewData = [];
  const startIdx = findClosestIndex(viewStartTime);
  const endIdx = findClosestIndex(viewEndTime);
  
  const idxStart = Math.max(0, startIdx - 1);
  const idxEnd = Math.min(analyzer.raw.length - 1, endIdx + 1);

  // Determine dynamic Y-scaling for Upper Graph (Raw/Filtered/Tonic)
  let yMinUpper = Infinity;
  let yMaxUpper = -Infinity;

  for (let i = idxStart; i <= idxEnd; i++) {
    if (showRaw && analyzer.raw[i]) {
      yMinUpper = Math.min(yMinUpper, analyzer.raw[i].val);
      yMaxUpper = Math.max(yMaxUpper, analyzer.raw[i].val);
    }
    if (showFiltered && analyzer.filtered[i]) {
      yMinUpper = Math.min(yMinUpper, analyzer.filtered[i].val);
      yMaxUpper = Math.max(yMaxUpper, analyzer.filtered[i].val);
    }
    if (showTonic && analyzer.tonic[i]) {
      yMinUpper = Math.min(yMinUpper, analyzer.tonic[i].val);
      yMaxUpper = Math.max(yMaxUpper, analyzer.tonic[i].val);
    }
  }

  // Fallbacks if not showing curves or empty
  if (yMinUpper === Infinity) yMinUpper = 0;
  if (yMaxUpper === -Infinity) yMaxUpper = 10;
  
  // Add some padding to vertical range
  let paddingUpper = (yMaxUpper - yMinUpper) * 0.1;
  if (paddingUpper === 0) paddingUpper = 0.5;
  yMinUpper = Math.max(0, yMinUpper - paddingUpper);
  yMaxUpper = yMaxUpper + paddingUpper;

  // Determine Y-scaling for Lower Graph (Phasic)
  let yMaxLower = -Infinity;
  for (let i = idxStart; i <= idxEnd; i++) {
    if (analyzer.phasic[i]) {
      yMaxLower = Math.max(yMaxLower, analyzer.phasic[i].val);
    }
  }
  if (yMaxLower <= 0) yMaxLower = parseFloat(sliders.peakThreshold.value) * 2;
  let paddingLower = yMaxLower * 0.15;
  yMaxLower = yMaxLower + paddingLower;
  const yMinLower = 0;

  // 1. Draw Grids and Axes
  drawGridX(viewStartTime, viewEndTime, yUpperBottom, yLowerBottom);
  drawGridYUpper(yMinUpper, yMaxUpper, yUpperBottom, hUpper);
  drawGridYLower(yMinLower, yMaxLower, yLowerBottom, hLower);

  // 2. Draw Upper Graph Curves
  if (showRaw) {
    drawSignalCurve(analyzer.raw, viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, color(100, 116, 139, 140), 1.5);
  }
  if (showFiltered) {
    drawSignalCurve(analyzer.filtered, viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, color(14, 165, 233), 2.2);
  }
  if (showTonic) {
    drawSignalCurve(analyzer.tonic, viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, color(217, 70, 239), 2);
  }

  // 3. Draw Lower Graph (Phasic)
  drawPhasicArea(analyzer.phasic, viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom);
  drawSignalCurve(analyzer.phasic, viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom, color(16, 185, 129), 2);
  
  // Draw threshold line on Phasic graph
  const thresholdVal = parseFloat(sliders.peakThreshold.value);
  const thresholdY = map(thresholdVal, yMinLower, yMaxLower, yLowerBottom, yLowerTop);
  stroke(244, 63, 94, 120);
  strokeWeight(1);
  drawingContext.setLineDash([5, 5]);
  line(margin.left, thresholdY, width - margin.right, thresholdY);
  drawingContext.setLineDash([]);
  
  fill(244, 63, 94, 150);
  noStroke();
  textSize(9);
  textAlign(RIGHT, CENTER);
  text(`Threshold (${thresholdVal.toFixed(3)} μS)`, width - margin.right - 5, thresholdY - 8);

  // 4. Draw Peak Markers
  drawPeakMarkers(viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 5. Draw Interactive Hover Scrubber
  handleScrubber(viewStartTime, viewEndTime, yMinUpper, yMaxUpper, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 6. Draw Timeline overview / Minimap
  if (analyzer.raw && analyzer.raw.length > 0) {
    // Timeline background
    fill(15, 23, 42, 180);
    stroke(255, 255, 255, 15);
    strokeWeight(1);
    rect(margin.left, yTimelineTop, innerWidth, timelineHeight, 6);

    // Draw full raw GSR signal downsampled to fit timeline smoothly
    noFill();
    stroke(148, 163, 184, 45); // muted slate grey-blue
    strokeWeight(1.2);
    
    // Find min and max of raw signal for full track (cached for performance)
    let minRaw = Infinity;
    let maxRaw = -Infinity;
    if (!analyzer.rawMinMaxCached) {
      for (let i = 0; i < analyzer.raw.length; i++) {
        const val = analyzer.raw[i].val;
        if (val < minRaw) minRaw = val;
        if (val > maxRaw) maxRaw = val;
      }
      analyzer.rawMinMaxCached = { minVal: minRaw, maxVal: maxRaw };
    } else {
      minRaw = analyzer.rawMinMaxCached.minVal;
      maxRaw = analyzer.rawMinMaxCached.maxVal;
    }
    
    if (minRaw === maxRaw) maxRaw = minRaw + 0.5;

    beginShape();
    const timelineStep = Math.max(1, Math.floor(analyzer.raw.length / 300));
    for (let i = 0; i < analyzer.raw.length; i += timelineStep) {
      const d = analyzer.raw[i];
      const xt = map(d.time, 0, totalDuration, margin.left, width - margin.right);
      const yt = map(d.val, minRaw, maxRaw, yTimelineBottom - 3, yTimelineTop + 3);
      vertex(xt, yt);
    }
    endShape();

    // Draw stress peak indicators as small red vertical lines
    if (showPeaks && analyzer.peaks) {
      fill(244, 63, 94, 180); // rose-600 with opacity
      noStroke();
      analyzer.peaks.forEach(pk => {
        const xp = map(pk.time, 0, totalDuration, margin.left, width - margin.right);
        rect(xp - 0.5, yTimelineTop + 2, 1.5, timelineHeight - 4);
      });
    }

    // Draw active viewport highlight rectangle (with nice glass effect)
    const xViewStart = map(viewStartTime, 0, totalDuration, margin.left, width - margin.right);
    const xViewEnd = map(viewStartTime + viewDuration, 0, totalDuration, margin.left, width - margin.right);
    
    fill(14, 165, 233, 25); // sky blue transparency
    stroke(14, 165, 233, 140);
    strokeWeight(1.5);
    rect(xViewStart, yTimelineTop, xViewEnd - xViewStart, timelineHeight, 4);
  }
}

function drawPlaceholder() {
  background(9, 13, 22, 0);
}

/**
 * Draw vertical gridlines and time labels (shared by both graphs)
 */
function drawGridX(tMin, tMax, yUpperBottom, yLowerBottom) {
  const innerWidth = width - margin.left - margin.right;
  
  // Choose reasonable grid step in seconds based on duration
  const span = tMax - tMin;
  let step = 10;
  if (span < 5) step = 0.5;
  else if (span < 15) step = 1;
  else if (span < 30) step = 5;
  else if (span < 120) step = 10;
  else if (span < 300) step = 30;
  else if (span < 900) step = 60;
  else step = 300;

  // Align start to step boundary
  const firstGridTime = Math.floor(tMin / step) * step;

  stroke(255, 255, 255, 12);
  strokeWeight(1);
  textAlign(CENTER, TOP);
  textSize(10);
  
  for (let t = firstGridTime; t <= tMax; t += step) {
    if (t < tMin) continue;

    const x = map(t, tMin, tMax, margin.left, width - margin.right);
    
    // Draw vertical gridline on Upper Graph
    line(x, margin.top, x, yUpperBottom);
    
    // Draw vertical gridline on Lower Graph
    line(x, yUpperBottom + margin.gap, x, yLowerBottom);
    
    // Time ticks at bottom of both
    fill(148, 163, 184);
    noStroke();
    
    // Format timestamp label
    let label = t.toFixed(t % 1 !== 0 ? 1 : 0) + 's';
    if (t >= 60) {
      let m = Math.floor(t / 60);
      let s = Math.floor(t % 60);
      label = `${m}:${s < 10 ? '0' : ''}${s}`;
    }
    text(label, x, yLowerBottom + 6);
    stroke(255, 255, 255, 12);
  }

  // Draw axis boundaries
  stroke(255, 255, 255, 25);
  line(margin.left, margin.top, margin.left, yUpperBottom);
  line(margin.left, yUpperBottom + margin.gap, margin.left, yLowerBottom);
  line(margin.left, yUpperBottom, width - margin.right, yUpperBottom);
  line(margin.left, yLowerBottom, width - margin.right, yLowerBottom);
}

/**
 * Draw horizontal gridlines for Upper Graph (Conductance)
 */
function drawGridYUpper(yMin, yMax, yBottom, height) {
  const span = yMax - yMin;
  let step = 0.5;
  if (span < 0.2) step = 0.02;
  else if (span < 1.0) step = 0.1;
  else if (span < 3.0) step = 0.5;
  else if (span < 10) step = 1.0;
  else step = 2.0;

  const firstGridVal = Math.floor(yMin / step) * step;

  stroke(255, 255, 255, 12);
  textAlign(RIGHT, CENTER);
  textSize(10);

  for (let val = firstGridVal; val <= yMax; val += step) {
    if (val < yMin) continue;

    const y = map(val, yMin, yMax, yBottom, margin.top);
    line(margin.left, y, width - margin.right, y);

    noStroke();
    fill(148, 163, 184);
    text(val.toFixed(2) + ' μS', margin.left - 8, y);
    stroke(255, 255, 255, 12);
  }
}

/**
 * Draw horizontal gridlines for Lower Graph (Phasic)
 */
function drawGridYLower(yMin, yMax, yBottom, height) {
  const span = yMax - yMin;
  let step = 0.05;
  if (span < 0.05) step = 0.005;
  else if (span < 0.15) step = 0.01;
  else if (span < 0.5) step = 0.05;
  else if (span < 1.5) step = 0.1;
  else step = 0.5;

  const firstGridVal = Math.floor(yMin / step) * step;

  stroke(255, 255, 255, 12);
  textAlign(RIGHT, CENTER);
  textSize(10);

  for (let val = firstGridVal; val <= yMax; val += step) {
    if (val < yMin) continue;

    const y = map(val, yMin, yMax, yBottom, yBottom - height);
    line(margin.left, y, width - margin.right, y);

    noStroke();
    fill(148, 163, 184);
    text(val.toFixed(3) + ' μS', margin.left - 8, y);
    stroke(255, 255, 255, 12);
  }
}

/**
 * Helper to draw a line plot for a given signal
 */
function drawSignalCurve(data, tMin, tMax, yMin, yMax, yTop, yBottom, lineColor, lineWt) {
  if (!data || data.length === 0) return;
  noFill();
  stroke(lineColor);
  strokeWeight(lineWt);
  
  // Find start and end indices in viewport
  const startIdx = Math.max(0, findClosestIndex(tMin) - 1);
  const endIdx = Math.min(data.length - 1, findClosestIndex(tMax) + 1);
  const count = endIdx - startIdx + 1;

  if (count <= 0) return;

  const maxVertices = 1500;
  const step = Math.max(1, Math.ceil(count / maxVertices));
  const useSpline = count < 600;

  beginShape();
  
  if (useSpline) {
    // First control point for p5 spline interpolation (duplicate first point in view)
    const dFirst = data[startIdx];
    const xFirst = map(dFirst.time, tMin, tMax, margin.left, width - margin.right);
    const yFirst = map(dFirst.val, yMin, yMax, yBottom, yTop);
    curveVertex(xFirst, yFirst);

    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      curveVertex(x, y);
    }

    // Last control point for p5 spline interpolation (duplicate last point in view)
    const dLast = data[endIdx];
    const xLast = map(dLast.time, tMin, tMax, margin.left, width - margin.right);
    const yLast = map(dLast.val, yMin, yMax, yBottom, yTop);
    curveVertex(xLast, yLast);
  } else {
    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      vertex(x, y);
    }
  }
  
  endShape();
}

/**
 * Draw semi-transparent gradient/area fill under the Phasic signal curve
 */
function drawPhasicArea(data, tMin, tMax, yMin, yMax, yTop, yBottom) {
  if (!data || data.length === 0) return;
  const startIdx = Math.max(0, findClosestIndex(tMin) - 1);
  const endIdx = Math.min(data.length - 1, findClosestIndex(tMax) + 1);
  const count = endIdx - startIdx + 1;
  
  if (count <= 0) return;

  noStroke();
  fill(16, 185, 129, 25); // Emerald transparent fill

  const maxVertices = 1500;
  const step = Math.max(1, Math.ceil(count / maxVertices));
  const useSpline = count < 600;

  beginShape();
  
  const dFirst = data[startIdx];
  const xStart = map(dFirst.time, tMin, tMax, margin.left, width - margin.right);
  
  // Anchor to baseline start
  vertex(xStart, yBottom);
  
  if (useSpline) {
    // Spline control point
    curveVertex(xStart, yBottom);

    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      curveVertex(x, y);
    }

    const dLast = data[endIdx];
    const xEnd = map(dLast.time, tMin, tMax, margin.left, width - margin.right);
    // Spline control point
    curveVertex(xEnd, yBottom);
    // Anchor to baseline end
    vertex(xEnd, yBottom);
  } else {
    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      vertex(x, y);
    }
    const dLast = data[endIdx];
    const xEnd = map(dLast.time, tMin, tMax, margin.left, width - margin.right);
    vertex(xEnd, yBottom);
  }
  
  endShape();
}

/**
 * Draw visual annotations for all detected peaks in range
 */
function drawPeakMarkers(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
  if (!showPeaks || !analyzer.peaks || analyzer.peaks.length === 0) return;
  for (let pIdx = 0; pIdx < analyzer.peaks.length; pIdx++) {
    const p = analyzer.peaks[pIdx];
    
    // Check if peak time or onset time is in viewport
    if (p.time < tMin && p.onsetTime < tMin && 
        (p.recoveryIndex === -1 || p.recoveryIndex === undefined || 
         !analyzer.phasic || !analyzer.phasic[p.recoveryIndex] || 
         analyzer.phasic[p.recoveryIndex].time < tMin)) {
      continue;
    }
    if (p.onsetTime > tMax) {
      continue;
    }

    const xPeak = map(p.time, tMin, tMax, margin.left, width - margin.right);
    const xOnset = map(p.onsetTime, tMin, tMax, margin.left, width - margin.right);
    
    const yFilteredPeak = map(analyzer.filtered[p.index].val, yMinU, yMaxU, yBottomU, yTopU);
    const yPhasicPeak = map(p.value, yMinL, yMaxL, yBottomL, yTopL);
    const yPhasicOnset = map(p.onsetValue, yMinL, yMaxL, yBottomL, yTopL);

    const isActive = (pIdx === activePeakIndex);
    const isHovered = (hoveredIndex >= p.onsetIndex && hoveredIndex <= p.index);

    // 1. Draw peak indicator in Phasic graph
    // Connect onset to peak with shaded highlight
    if (isActive || isHovered) {
      fill(244, 63, 94, 75); // Shaded fill under the curve (rose red at ~30% opacity)
      noStroke();
      beginShape();
      vertex(xOnset, yBottomL);
      for (let i = p.onsetIndex; i <= p.index; i++) {
        const xVal = map(analyzer.phasic[i].time, tMin, tMax, margin.left, width - margin.right);
        const yVal = map(analyzer.phasic[i].val, yMinL, yMaxL, yBottomL, yTopL);
        vertex(xVal, yVal);
      }
      vertex(xPeak, yBottomL);
      endShape(CLOSE);
    }

    // Peak Onset circle (Green)
    stroke(16, 185, 129);
    strokeWeight(1.5);
    fill(9, 13, 22);
    circle(xOnset, yPhasicOnset, isActive ? 8 : 5);

    // Vertical dashed lines connecting upper and lower graphs
    stroke(244, 63, 94, 60);
    strokeWeight(1);
    drawingContext.setLineDash([3, 3]);
    line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
    drawingContext.setLineDash([]);

    // Peak circle (Rose red)
    stroke(244, 63, 94);
    strokeWeight(2);
    fill(isActive ? color(244, 63, 94) : color(9, 13, 22));
    circle(xPeak, yPhasicPeak, isActive ? 9 : 6);
    circle(xPeak, yFilteredPeak, isActive ? 9 : 6);

    // Label peak number
    if (xPeak >= margin.left && xPeak <= width - margin.right) {
      if (viewDuration < 300 || isActive || isHovered) {
        noStroke();
        fill(244, 63, 94);
        textSize(10);
        textStyle(BOLD);
        textAlign(CENTER, BOTTOM);
        text(`#${pIdx + 1}`, xPeak, yFilteredPeak - 8);
        textStyle(NORMAL);
      }
    }
  }
}

/**
 * Handle hover scrubber line and details tooltip
 */
function handleScrubber(tMin, tMax, yMinU, yMaxU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
  // If mouse is outside graph bounds horizontally or dragging, don't draw scrubber
  if (mouseX < margin.left || mouseX > width - margin.right || isDragging) {
    hoveredIndex = -1;
    if (mapManager) mapManager.setScrubPosition(NaN, NaN);
    return;
  }

  if (!analyzer.raw || analyzer.raw.length === 0 || 
      !analyzer.filtered || analyzer.filtered.length === 0 ||
      !analyzer.tonic || analyzer.tonic.length === 0 ||
      !analyzer.phasic || analyzer.phasic.length === 0) {
    hoveredIndex = -1;
    if (mapManager) mapManager.setScrubPosition(NaN, NaN);
    return;
  }

  // Map mouse position back to signal time
  const tScrub = map(mouseX, margin.left, width - margin.right, tMin, tMax);
  hoveredIndex = findClosestIndex(tScrub);

  if (hoveredIndex === -1) return;

  const sample = analyzer.raw[hoveredIndex];
  if (sample && sample.hasGps && !isNaN(sample.lat) && !isNaN(sample.lon) && mapManager) {
    mapManager.setScrubPosition(sample.lat, sample.lon, false);
  } else if (mapManager) {
    mapManager.setScrubPosition(NaN, NaN);
  }

  const dRaw = analyzer.raw[hoveredIndex];
  const dFilt = analyzer.filtered[hoveredIndex];
  const dTonic = analyzer.tonic[hoveredIndex];
  const dPhasic = analyzer.phasic[hoveredIndex];

  const xScrub = map(dRaw.time, tMin, tMax, margin.left, width - margin.right);

  // Draw vertical line across entire canvas
  stroke(255, 255, 255, 50);
  strokeWeight(1);
  line(xScrub, margin.top, xScrub, yBottomL);

  // Draw intersection dots
  const yU = map(dFilt.val, yMinU, yMaxU, yBottomU, margin.top);
  const yL = map(dPhasic.val, yMinL, yMaxL, yBottomL, yTopL);

  stroke(14, 165, 233);
  fill(14, 165, 233);
  circle(xScrub, yU, 6);

  stroke(16, 185, 129);
  fill(16, 185, 129);
  circle(xScrub, yL, 6);

  // Render Tooltip Card
  drawTooltip(dRaw.time, dRaw.val, dFilt.val, dTonic.val, dPhasic.val);
}

function drawTooltip(time, rawVal, filtVal, tonicVal, phasicVal) {
  const pad = 12;
  const boxW = 190;
  const boxH = 120;
  
  // Decide tooltip placement: right of scrubber or left (if near right edge)
  let boxX = mouseX + 15;
  if (boxX + boxW > width - margin.right) {
    boxX = mouseX - boxW - 15;
  }
  
  let boxY = mouseY - 40;
  boxY = constrain(boxY, margin.top, height - margin.bottom - boxH);

  // Glass box background
  fill(22, 33, 54, 235);
  stroke(255, 255, 255, 15);
  strokeWeight(1);
  rect(boxX, boxY, boxW, boxH, 8);

  // Tooltip content
  noStroke();
  textAlign(LEFT, TOP);
  
  // Timestamp
  fill(255, 255, 255);
  textSize(10);
  textStyle(BOLD);
  text(`TIME: ${time.toFixed(2)} s`, boxX + pad, boxY + pad);
  textStyle(NORMAL);
  
  // Values
  textSize(9.5);
  const startY = boxY + pad + 18;
  const spacing = 18;

  // Raw GSR
  fill(148, 163, 184);
  text(`Raw:`, boxX + pad, startY);
  textAlign(RIGHT, TOP);
  text(`${rawVal.toFixed(4)} μS`, boxX + boxW - pad, startY);
  
  // Filtered GSR
  textAlign(LEFT, TOP);
  fill(14, 165, 233);
  text(`Filtered:`, boxX + pad, startY + spacing);
  textAlign(RIGHT, TOP);
  text(`${filtVal.toFixed(4)} μS`, boxX + boxW - pad, startY + spacing);

  // Tonic Baseline
  textAlign(LEFT, TOP);
  fill(217, 70, 239);
  text(`Tonic (SCL):`, boxX + pad, startY + 2 * spacing);
  textAlign(RIGHT, TOP);
  text(`${tonicVal.toFixed(4)} μS`, boxX + boxW - pad, startY + 2 * spacing);

  // Phasic Response
  textAlign(LEFT, TOP);
  fill(16, 185, 129);
  text(`Phasic (SCR):`, boxX + pad, startY + 3 * spacing);
  textAlign(RIGHT, TOP);
  text(`${phasicVal.toFixed(4)} μS`, boxX + boxW - pad, startY + 3 * spacing);
}

/**
 * Find closest index in dataset to target time using binary search (very fast!)
 */
function findClosestIndex(targetTime) {
  if (analyzer.raw.length === 0) return -1;
  
  let low = 0;
  let high = analyzer.raw.length - 1;

  if (targetTime <= analyzer.raw[low].time) return low;
  if (targetTime >= analyzer.raw[high].time) return high;

  while (low <= high) {
    let mid = Math.floor((low + high) / 2);
    let midTime = analyzer.raw[mid].time;

    if (midTime === targetTime) return mid;
    
    if (midTime < targetTime) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Check which boundary is closer
  if (Math.abs(analyzer.raw[low].time - targetTime) < Math.abs(analyzer.raw[high].time - targetTime)) {
    return low;
  }
  return high;
}

/**
 * Handle Zoom and Pan Mouse Gestures
 */
function mousePressed() {
  if (analyzer.raw.length === 0) return;
  
  // Check if click was inside timeline overview
  if (mouseX >= margin.left && mouseX <= width - margin.right &&
      mouseY >= yTimelineTop && mouseY <= yTimelineBottom) {
    isDraggingTimeline = true;
    const clickTime = map(mouseX, margin.left, width - margin.right, 0, totalDuration);
    viewStartTime = constrain(clickTime - viewDuration / 2, 0, Math.max(0, totalDuration - viewDuration));
    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';
    redraw();
  }
  // Check if click was inside graph bounds (above the timeline gap)
  else if (mouseX >= margin.left && mouseX <= width - margin.right &&
      mouseY >= margin.top && mouseY <= yTimelineTop - 20) {
    isDragging = true;
    dragStartMouseX = mouseX;
    dragStartViewStart = viewStartTime;
  }
}

function mouseDragged() {
  if (isDraggingTimeline && analyzer.raw.length > 0) {
    const dragTime = map(mouseX, margin.left, width - margin.right, 0, totalDuration);
    viewStartTime = constrain(dragTime - viewDuration / 2, 0, Math.max(0, totalDuration - viewDuration));
    redraw();
  }
  else if (isDragging && analyzer.raw.length > 0) {
    const mouseDx = mouseX - dragStartMouseX;
    const timePerPixel = viewDuration / (width - margin.left - margin.right);
    const timeShift = mouseDx * timePerPixel;
    
    viewStartTime = dragStartViewStart - timeShift;
    viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));
    redraw();
  }
}

function mouseReleased() {
  isDragging = false;
  isDraggingTimeline = false;
}

function mouseWheel(event) {
  // Zoom only if hovered over the graph canvas area (above the timeline)
  if (mouseX >= margin.left && mouseX <= width - margin.right &&
      mouseY >= margin.top && mouseY <= yTimelineTop - 20) {
    
    if (analyzer.raw.length === 0) return false;

    // Get time coordinate under mouse before zoom
    const mouseTime = map(mouseX, margin.left, width - margin.right, viewStartTime, viewStartTime + viewDuration);

    // Zoom direction
    const zoomMultiplier = event.delta < 0 ? 0.85 : 1.15;
    
    viewDuration = constrain(viewDuration * zoomMultiplier, 2.0, totalDuration);
    zoomFactor = totalDuration / viewDuration;

    // Center zoom on mouse time coordinate
    viewStartTime = mouseTime - (mouseX - margin.left) * (viewDuration / (width - margin.left - margin.right));
    viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));

    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';

    redraw();
    return false; // Prevent page scroll
  }
}

/**
 * Zoom graph from canvas buttons
 */
function zoomCanvas(multiplier) {
  if (analyzer.raw.length === 0) return;
  
  // Center Zoom on current view center
  const centerTime = viewStartTime + viewDuration / 2;
  
  viewDuration = constrain(viewDuration / multiplier, 2.0, totalDuration);
  zoomFactor = totalDuration / viewDuration;
  
  viewStartTime = centerTime - viewDuration / 2;
  viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));
  
  const select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'custom';
  
  redraw();
}

function resetView() {
  if (analyzer.raw.length === 0) return;
  viewStartTime = 0;
  viewDuration = totalDuration;
  zoomFactor = 1.0;
  activePeakIndex = -1;
  
  const select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'fit';

  // De-select table rows
  document.querySelectorAll('#peaksTable tbody tr').forEach(r => r.classList.remove('active-row'));
  
  redraw();
}

/**
 * Handle CSV processing pipeline
 */
/**
 * Handle CSV processing pipeline supporting multiple files
 */
function handleFileSelect(e) {
  if (e.target.files.length > 0) {
    const files = Array.from(e.target.files);
    loadFilesSequentially(files);
  }
}

function loadFilesSequentially(files) {
  let index = 0;
  const loadNext = () => {
    if (index >= files.length) {
      fileInput.value = ""; // Clear file input
      return;
    }
    const file = files[index];
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target.result;
        
        const tempAnalyzer = new GSRAnalyzer();
        tempAnalyzer.parseCSV(text);

        const trackId = 'track_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const trackColor = getNextTrackColor();

        // Default filter parameters for new tracks
        const filterParams = {
          medianSize: 1.0,
          lpfWindow: 0.8,
          tonicMethod: 'percentile',
          tonicWindow: 15,
          peakThreshold: 0.020
        };

        const newTrack = {
          id: trackId,
          name: file.name,
          color: trackColor,
          enabled: true,
          analyzer: tempAnalyzer,
          filterParams: filterParams
        };

        collectiveManager.addTrack(newTrack);
        tempAnalyzer.analyze(filterParams);

        if (!activeTrackId) {
          switchActiveTrack(trackId);
        } else {
          renderTrackList();
        }

        const fileStatus = document.getElementById('fileStatus');
        fileStatus.querySelector('.status-dot').className = 'status-dot success';
        fileStatus.querySelector('.status-text').innerText = `${collectiveManager.tracks.length} Tracks Loaded`;

        if (viewMode === 'collective') {
          updateCollectiveMap();
        }

        index++;
        loadNext();
      } catch (err) {
        alert(`Error parsing "${file.name}": ` + err.message);
        index++;
        loadNext();
      }
    };
    reader.readAsText(file);
  };
  loadNext();
}

function renderTrackList() {
  const container = document.getElementById('trackListContainer');
  const listElement = document.getElementById('trackList');
  
  if (collectiveManager.tracks.length === 0) {
    container.style.display = 'none';
    dropZone.style.display = 'flex';
    dropZone.classList.remove('compact');
    
    analyzer = new GSRAnalyzer();
    activeTrackId = null;
    
    // Disable export buttons
    document.getElementById('exportCsvBtn').setAttribute('disabled', 'true');
    document.getElementById('exportImageBtn').setAttribute('disabled', 'true');
    document.getElementById('exportMapBtn').setAttribute('disabled', 'true');

    if (mapManager) {
      mapManager.clearMap();
      mapManager.clearCollectiveLayers();
    }
    
    const fileStatus = document.getElementById('fileStatus');
    fileStatus.querySelector('.status-dot').className = 'status-dot warning';
    fileStatus.querySelector('.status-text').innerText = 'No File Loaded';
    
    const placeholder = document.getElementById('canvasPlaceholder');
    if (placeholder) placeholder.style.display = 'flex';
    noLoop();
    drawPlaceholder();
    return;
  }
  
  container.style.display = 'block';
  dropZone.style.display = 'flex';
  dropZone.classList.add('compact');
  
  listElement.innerHTML = '';
  
  collectiveManager.tracks.forEach(track => {
    const isEditing = (track.id === activeTrackId);
    
    const li = document.createElement('li');
    li.className = `track-item ${isEditing ? 'active' : ''}`;
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'track-checkbox';
    checkbox.checked = track.enabled;
    checkbox.title = 'Include in Collective Surface';
    checkbox.addEventListener('change', (e) => {
      track.enabled = e.target.checked;
      if (viewMode === 'collective') {
        updateCollectiveMap();
      }
    });
    
    const badge = document.createElement('span');
    badge.className = 'track-color-badge';
    badge.style.backgroundColor = track.color;
    
    const details = document.createElement('div');
    details.className = 'track-details';
    details.title = 'Click to analyze and tweak';
    details.addEventListener('click', () => {
      switchActiveTrack(track.id);
    });
    
    const name = document.createElement('span');
    name.className = 'track-name';
    name.innerText = track.name;
    
    const meta = document.createElement('span');
    meta.className = 'track-meta';
    meta.innerText = `${track.analyzer.raw.length} pts | ${track.analyzer.peaks.length} peaks`;
    
    details.appendChild(name);
    details.appendChild(meta);
    
    const actions = document.createElement('div');
    actions.className = 'track-actions';
    
    const editBtn = document.createElement('button');
    editBtn.className = 'track-action-btn edit-btn';
    editBtn.title = 'Analyze and tweak filters';
    editBtn.innerHTML = '<i class="fa-solid fa-pencil"></i>';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchActiveTrack(track.id);
      if (viewMode === 'collective') {
        document.getElementById('btnSingleView').click();
      }
    });
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'track-action-btn delete-btn';
    deleteBtn.title = 'Remove track';
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTrack(track.id);
    });
    
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    
    li.appendChild(checkbox);
    li.appendChild(badge);
    li.appendChild(details);
    li.appendChild(actions);
    
    listElement.appendChild(li);
  });
}

function switchActiveTrack(trackId) {
  activeTrackId = trackId;
  const track = collectiveManager.getTrack(trackId);
  if (!track) return;
  
  analyzer = track.analyzer;
  totalDuration = (analyzer.raw.length > 0 && analyzer.raw[analyzer.raw.length - 1] && analyzer.raw[0]) ? 
    (analyzer.raw[analyzer.raw.length - 1].time - analyzer.raw[0].time) : 0;
  
  loadActiveTrackParams(track);
  resetView();
  runAnalysis();

  document.getElementById('exportCsvBtn').removeAttribute('disabled');
  document.getElementById('exportImageBtn').removeAttribute('disabled');
  document.getElementById('exportMapBtn').removeAttribute('disabled');

  const placeholder = document.getElementById('canvasPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  renderTrackList();
  loop();
}

function deleteTrack(trackId) {
  collectiveManager.removeTrack(trackId);
  
  if (activeTrackId === trackId) {
    if (collectiveManager.tracks.length > 0) {
      switchActiveTrack(collectiveManager.tracks[0].id);
    } else {
      activeTrackId = null;
      analyzer = new GSRAnalyzer();
    }
  }
  
  renderTrackList();
  
  const fileStatus = document.getElementById('fileStatus');
  if (collectiveManager.tracks.length > 0) {
    fileStatus.querySelector('.status-dot').className = 'status-dot success';
    fileStatus.querySelector('.status-text').innerText = `${collectiveManager.tracks.length} Tracks Loaded`;
  } else {
    fileStatus.querySelector('.status-dot').className = 'status-dot warning';
    fileStatus.querySelector('.status-text').innerText = 'No File Loaded';
  }
  
  if (viewMode === 'collective') {
    updateCollectiveMap();
  }
}

function loadActiveTrackParams(track) {
  if (!track || !track.filterParams) return;
  const params = track.filterParams;
  
  sliders.medianSize.value = params.medianSize;
  document.getElementById('valMedianSize').innerText = params.medianSize.toFixed(1) + ' s';
  
  sliders.lpfWindow.value = params.lpfWindow;
  document.getElementById('valLpfWindow').innerText = params.lpfWindow.toFixed(1) + ' s';
  
  sliders.tonicWindow.value = params.tonicWindow;
  document.getElementById('valTonicWindow').innerText = params.tonicWindow + ' s';
  
  sliders.tonicMethod.value = params.tonicMethod;
  
  sliders.peakThreshold.value = params.peakThreshold;
  document.getElementById('valPeakThreshold').innerText = params.peakThreshold.toFixed(3) + ' μS';
}

function saveActiveTrackParams() {
  if (!activeTrackId) return;
  const track = collectiveManager.getTrack(activeTrackId);
  if (!track) return;
  
  track.filterParams = {
    medianSize: parseFloat(sliders.medianSize.value),
    lpfWindow: parseFloat(sliders.lpfWindow.value),
    tonicMethod: sliders.tonicMethod.value,
    tonicWindow: parseInt(sliders.tonicWindow.value),
    peakThreshold: parseFloat(sliders.peakThreshold.value)
  };
}

function updateCollectiveMap() {
  if (!mapManager) return;
  
  if (collectiveManager.getActiveTracks().length === 0) {
    mapManager.clearCollectiveLayers();
    document.getElementById('statDuration').innerText = '--';
    document.getElementById('statMeanSCL').innerText = '--';
    document.getElementById('statPeakCount').innerText = '--';
    document.getElementById('statPeakFreq').innerText = '--';
    return;
  }
  
  const topoSource = document.getElementById('topoSource').value;
  const gridResolution = parseInt(document.getElementById('gridResolution').value);
  const contourCount = parseInt(document.getElementById('contourCount').value);
  const isolationRadius = parseFloat(document.getElementById('isolationRadius').value);
  const idwExponent = parseFloat(document.getElementById('idwExponent').value);
  const showShadedSurface = document.getElementById('showShadedSurface') ? document.getElementById('showShadedSurface').checked : true;
  const surfaceOpacity = document.getElementById('surfaceOpacity') ? parseFloat(document.getElementById('surfaceOpacity').value) : 0.40;

  const contourParams = {
    gridResolution,
    contourCount,
    isolationRadius,
    idwExponent,
    topographySource: topoSource,
    showShadedSurface,
    surfaceOpacity
  };

  mapManager.renderCollectiveData(collectiveManager, contourParams);

  // Compute collective stats
  let totalDur = 0;
  let totalPeaks = 0;
  let sumSCL = 0;
  let sclCount = 0;

  collectiveManager.getActiveTracks().forEach(track => {
    const stats = track.analyzer.getStats();
    totalDur += stats.duration;
    totalPeaks += stats.peakCount;
    
    track.analyzer.tonic.forEach(d => {
      sumSCL += d.val;
      sclCount++;
    });
  });

  const meanSCL = sclCount > 0 ? (sumSCL / sclCount) : 0;
  const meanPeakFreq = (totalDur > 0) ? (totalPeaks / (totalDur / 60.0)) : 0;

  document.getElementById('statDuration').innerText = (totalDur / 60.0).toFixed(1) + " min";
  document.getElementById('statMeanSCL').innerText = meanSCL.toFixed(3) + " μS";
  document.getElementById('statPeakCount').innerText = totalPeaks;
  document.getElementById('statPeakFreq').innerText = meanPeakFreq.toFixed(2) + " / min";
}

function clearFile() {
  if (activeTrackId) {
    deleteTrack(activeTrackId);
  } else {
    collectiveManager.tracks = [];
    renderTrackList();
  }
}

/**
 * Read GPS filter slider values into a params object.
 */
function getGpsParams() {
  return {
    minSats:      parseInt(sliders.gpsMinSats.value),
    maxSpeed:     parseFloat(sliders.gpsMaxSpeed.value),
    hampelWindow: parseInt(sliders.gpsHampelWindow.value),
    hampelSigma:  parseFloat(sliders.gpsHampelSigma.value),
    dbscanRadius: parseFloat(sliders.gpsDBSCANRadius.value),
    dbscanMinPts: parseInt(sliders.gpsDBSCANMinPts.value),
    kalmanR:      parseFloat(sliders.gpsKalmanR.value),
    kalmanQ:      Math.pow(10, -parseFloat(sliders.gpsKalmanQ.value)),
    rdpTolerance: parseFloat(sliders.gpsRDP.value),
    minDist:      parseFloat(sliders.gpsMinDist.value),
    downsample:   parseInt(sliders.gpsDownsample.value) === 1,
    trackWeight:  parseInt(sliders.gpsTrackWeight.value)
  };
}

/**
 * Re-render only the map with current GPS filter settings, without
 * re-running the full signal analysis pipeline. Called by GPS sliders.
 */
function rerenderMap() {
  if (!mapManager || !analyzer || analyzer.raw.length === 0) return;
  if (viewMode === 'single') {
    mapManager.renderData(analyzer, getGpsParams());
  } else {
    updateCollectiveMap();
  }
}

/**
 * Gather parameters from sliders and run analytical calculations
 */
function runAnalysis() {
  if (!analyzer || analyzer.raw.length === 0) return;

  try {
    const params = {
      medianSize: parseFloat(sliders.medianSize.value),
      lpfWindow: parseFloat(sliders.lpfWindow.value),
      tonicMethod: sliders.tonicMethod.value,
      tonicWindow: parseInt(sliders.tonicWindow.value),
      peakThreshold: parseFloat(sliders.peakThreshold.value)
    };

    // Save parameters to current track state
    saveActiveTrackParams();

    // Run core mathematics
    analyzer.analyze(params);

    // Update Geographical Map (with GPS filter params)
    if (viewMode === 'single') {
      if (mapManager) {
        mapManager.renderData(analyzer, getGpsParams());
      }
    } else {
      updateCollectiveMap();
    }

    // Update UI Panels
    updateStatsPanel();
    updatePeaksTable();

    // Trigger immediate render refresh
    redraw();
  } catch (err) {
    console.error("Analysis error:", err);
    alert("Error running analysis: " + err.message);
  }
}

function updateStatsPanel() {
  const stats = analyzer.getStats();
  
  statFields.duration.innerText = stats.duration.toFixed(1) + " s";
  statFields.meanSCL.innerText = stats.meanSCL.toFixed(3) + " μS";
  statFields.peakCount.innerText = stats.peakCount;
  statFields.peakFreq.innerText = stats.peakFrequency.toFixed(2) + " / min";
}

function updatePeaksTable() {
  if (analyzer.peaks.length === 0) {
    tableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">No peaks detected. Try reducing the Peak Amplitude threshold.</td>
      </tr>
    `;
    return;
  }

  let rowsHtml = "";
  analyzer.peaks.forEach((p, idx) => {
    const isAct = (idx === activePeakIndex) ? "class='active-row'" : "";
    const riseTimeStr = (p.time - p.onsetTime).toFixed(2);
    const recTimeStr = p.recoveryTime !== -1 ? p.recoveryTime.toFixed(2) : "N/A";

    rowsHtml += `
      <tr id="peakRow-${idx}" ${isAct} onclick="focusOnPeak(${idx})">
        <td>${idx + 1}</td>
        <td>${p.onsetTime.toFixed(2)}</td>
        <td>${p.time.toFixed(2)}</td>
        <td>${p.value.toFixed(4)}</td>
        <td>${p.amplitude.toFixed(4)}</td>
        <td>${riseTimeStr}</td>
        <td>${recTimeStr}</td>
        <td>
          <button class="btn-table-action" onclick="event.stopPropagation(); focusOnPeak(${idx})">
            <i class="fa-solid fa-arrows-to-eye"></i> View
          </button>
        </td>
      </tr>
    `;
  });

  tableBody.innerHTML = rowsHtml;
}

/**
 * Focus and zoom on a specific peak selected from the table
 */
window.focusOnPeak = function(idx) {
  if (idx < 0 || idx >= analyzer.peaks.length) return;
  
  activePeakIndex = idx;
  const p = analyzer.peaks[idx];
  
  // Set zoom to look at 10-second window centered around the peak
  zoomFactor = totalDuration / 12.0;
  viewDuration = 12.0;
  
  // Center around peak
  viewStartTime = p.time - viewDuration / 2;
  viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));

  const select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'custom';

  // Update table row highlighting
  document.querySelectorAll('#peaksTable tbody tr').forEach(r => r.classList.remove('active-row'));
  const row = document.getElementById(`peakRow-${idx}`);
  if (row) row.classList.add('active-row');

  // Trigger drawing update
  redraw();
};

/**
 * Exports & Saves
 */
function exportCSV() {
  if (analyzer.raw.length === 0) return;
  const csvContent = analyzer.exportToCSV();
  
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  
  link.setAttribute("href", url);
  link.setAttribute("download", `processed_gsr_${Date.now()}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function saveCanvasImage() {
  if (analyzer.raw.length === 0) return;
  saveCanvas(myCanvas, `gsr_analysis_chart_${Date.now()}`, 'png');
}

function saveMapImage() {
  if (analyzer.raw.length === 0) return;
  
  const mapElement = document.getElementById('map');
  const btn = document.getElementById('exportMapBtn');
  const originalText = btn.innerHTML;
  
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
  btn.setAttribute('disabled', 'true');

  html2canvas(mapElement, {
    useCORS: true,
    allowTaint: false,
    backgroundColor: null,
    logging: false
  }).then(canvas => {
    const link = document.createElement("a");
    link.download = `bio_map_${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    btn.innerHTML = originalText;
    btn.removeAttribute('disabled');
  }).catch(err => {
    console.error("Error generating map PNG:", err);
    alert("Could not export map. Some map resources may have failed to load securely (CORS).");
    btn.innerHTML = originalText;
    btn.removeAttribute('disabled');
  });
}

/**
 * Generates highly realistic mock GSR data for demonstration
 */
function loadDemoData() {
  // 120 seconds of data @ 10Hz
  const Fs = 10;
  const len = 120 * Fs;
  
  let csvRows = ["Time (s),Conductance (uS),Latitude,Longitude"];
  
  // Starting point: London (Trafalgar Square)
  let lat = 51.5074;
  let lon = -0.1278;
  
  let baseline = 3.0; // Start at 3 uS SCL
  let activePeaks = []; // Peaks currently active in the generation

  // Define times and magnitudes of simulated stimuli responses
  // Format: [onset_time, peak_height]
  const stimuli = [
    [12, 0.45],  // Clean SCR peak
    [32, 0.25],  // Smaller SCR
    [50, 0.65],  // Large SCR response
    [75, 0.35],  // Standard SCR
    [95, 0.50]   // Double peak overlapping
  ];

  // We also simulate a second overlapping peak at 99s to test deconvolution-like splitting
  stimuli.push([99, 0.40]);

  // Generate samples
  for (let i = 0; i < len; i++) {
    const t = i / Fs;
    
    // 1. Simulate Slow Tonic drift (combination of exponential decay and slow sine wave)
    let tonicValue = baseline - 0.005 * t + 0.15 * sin(t * 0.04);
    
    // 2. Simulate Phasic Peaks (SCRs)
    let phasicValue = 0;
    stimuli.forEach(([onsetTime, peakHeight]) => {
      if (t >= onsetTime) {
        const dt = t - onsetTime;
        // SCR model: double exponential function
        // rises in ~1.5s, decays with half-time of ~6s
        const tauRise = 1.2;
        const tauDecay = 5.5;
        // Peak normalization factor
        const tPeak = (tauRise * tauDecay / (tauDecay - tauRise)) * log(tauDecay / tauRise);
        const norm = 1.0 / (exp(-tPeak / tauDecay) - exp(-tPeak / tauRise));
        
        const scrVal = peakHeight * norm * (exp(-dt / tauDecay) - exp(-dt / tauRise));
        if (scrVal > 0) {
          phasicValue += scrVal;
        }
      }
    });

    // 3. Add High Frequency Measurement Noise
    let noiseVal = randomGaussian(0, 0.003);

    // 4. Add Motion Artifact Spikes (brief, sharp jumps)
    // Motion spike at 22s and 65s
    let motionArtifact = 0;
    if (t >= 22.0 && t <= 22.6) {
      motionArtifact = 0.8 * Math.sin((t - 22.0) * Math.PI / 0.6); // smooth half-sine bump
    }
    if (t >= 65.1 && t <= 65.3) {
      motionArtifact = -1.2 * Math.sin((t - 65.1) * Math.PI / 0.2); // sharp contact drop
    }

    // Simulate walking path: update GPS coordinates at 1 Hz (once per 10 ticks)
    let latStr = "";
    let lonStr = "";
    if (i % 10 === 0) {
      lat += 0.000015 * Math.sin(t * 0.05) + 0.000012;
      lon += 0.000020 * Math.cos(t * 0.05) + 0.000006;
      latStr = lat.toFixed(6);
      lonStr = lon.toFixed(6);
    }

    const totalVal = tonicValue + phasicValue + noiseVal + motionArtifact;
    csvRows.push(`${t.toFixed(2)},${totalVal.toFixed(5)},${latStr},${lonStr}`);
  }

  const csvText = csvRows.join("\n");
  
  // Load mock file inside collective manager pipeline
  const file = { name: "demo_gsr_data.csv" };
  
  try {
    const tempAnalyzer = new GSRAnalyzer();
    tempAnalyzer.parseCSV(csvText);

    const trackId = 'track_demo_' + Date.now();
    const trackColor = getNextTrackColor();

    const filterParams = {
      medianSize: 1.0,
      lpfWindow: 0.8,
      tonicMethod: 'percentile',
      tonicWindow: 15,
      peakThreshold: 0.020
    };

    const newTrack = {
      id: trackId,
      name: file.name,
      color: trackColor,
      enabled: true,
      analyzer: tempAnalyzer,
      filterParams: filterParams
    };

    collectiveManager.addTrack(newTrack);
    tempAnalyzer.analyze(filterParams);

    switchActiveTrack(trackId);
    renderTrackList();

    const fileStatus = document.getElementById('fileStatus');
    fileStatus.querySelector('.status-dot').className = 'status-dot success';
    fileStatus.querySelector('.status-text').innerText = `${collectiveManager.tracks.length} Tracks Loaded`;

    if (viewMode === 'collective') {
      updateCollectiveMap();
    }
  } catch (err) {
    alert("Error loading demo: " + err.message);
  }
}

// Simple Gaussian Random number helper (Box-Muller transform)
function randomGaussian(mean = 0, stdDev = 1) {
  let u1 = Math.random();
  let u2 = Math.random();
  while (u1 <= 0.0000001) u1 = Math.random(); // avoid log(0)
  
  let randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
  return mean + stdDev * randStdNormal;
}

/**
 * Save user filter settings to localStorage.
 */
function saveSettings() {
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
  if (!saved) return;
  try {
    const settings = JSON.parse(saved);
    
    // GSR Settings
    if (settings.medianSize !== undefined) sliders.medianSize.value = settings.medianSize;
    if (settings.lpfWindow !== undefined) sliders.lpfWindow.value = settings.lpfWindow;
    if (settings.tonicMethod !== undefined) sliders.tonicMethod.value = settings.tonicMethod;
    if (settings.tonicWindow !== undefined) sliders.tonicWindow.value = settings.tonicWindow;
    if (settings.peakThreshold !== undefined) sliders.peakThreshold.value = settings.peakThreshold;

    // GPS Settings
    if (settings.gpsMinSats !== undefined) sliders.gpsMinSats.value = settings.gpsMinSats;
    if (settings.gpsMaxSpeed !== undefined) sliders.gpsMaxSpeed.value = settings.gpsMaxSpeed;
    if (settings.gpsHampelWindow !== undefined) sliders.gpsHampelWindow.value = settings.gpsHampelWindow;
    if (settings.gpsHampelSigma !== undefined) sliders.gpsHampelSigma.value = settings.gpsHampelSigma;
    if (settings.gpsDBSCANRadius !== undefined) sliders.gpsDBSCANRadius.value = settings.gpsDBSCANRadius;
    if (settings.gpsDBSCANMinPts !== undefined) sliders.gpsDBSCANMinPts.value = settings.gpsDBSCANMinPts;
    if (settings.gpsKalmanR !== undefined) sliders.gpsKalmanR.value = settings.gpsKalmanR;
    if (settings.gpsKalmanQ !== undefined) sliders.gpsKalmanQ.value = settings.gpsKalmanQ;
    if (settings.gpsRDP !== undefined) sliders.gpsRDP.value = settings.gpsRDP;
    if (settings.gpsMinDist !== undefined) sliders.gpsMinDist.value = settings.gpsMinDist;
    if (settings.gpsDownsample !== undefined) sliders.gpsDownsample.value = settings.gpsDownsample;
    if (settings.gpsTrackWeight !== undefined) sliders.gpsTrackWeight.value = settings.gpsTrackWeight;
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
