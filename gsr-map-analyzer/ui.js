/**
 * UI Element Caching, Event Handlers, Panels toggles, and Actions Management
 */

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
  const bindToggle = (btnId) => {
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
    const icon = document.getElementById('sidebarToggleIcon');
    if (sidebarCollapsed) {
      icon.classList.replace('fa-bars', 'fa-bars-staggered');
    } else {
      icon.classList.replace('fa-bars-staggered', 'fa-bars');
    }
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

  // Click handler on fullscreen expand button
  btn.addEventListener('click', () => {
    if (isFs) exit();
    else enter();
  });

  // Global escape key handler for exiting fullscreen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFs) {
      exit();
    }
  });
}

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

function rerenderMap() {
  if (!mapManager || !analyzer || analyzer.raw.length === 0) return;
  if (viewMode === 'single') {
    mapManager.renderData(analyzer, getGpsParams());
  } else {
    updateCollectiveMap();
  }
}

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

    saveActiveTrackParams();
    analyzer.analyze(params);

    if (viewMode === 'single') {
      if (mapManager) {
        mapManager.renderData(analyzer, getGpsParams());
      }
    } else {
      updateCollectiveMap();
    }

    updateStatsPanel();
    updatePeaksTable();
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
