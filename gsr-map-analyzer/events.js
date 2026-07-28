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

    // Sliders & Selection inputs
    const sliderKeys = [
      'medianSize', 'lpfWindow', 'tonicWindow', 'tonicMethod', 'peakThreshold', 'minPeakQuality', 'hotspotPercentile', 'dwtLevel',
      'shapeMinRiseTime', 'shapeMaxRiseTime', 'shapeMinHalfRecovery', 'shapeMaxHalfRecovery',
      'shapeMinSnr', 'shapeMaxSkewRatio',
      'gpsSmoothing', 'gpsKalmanR', 'gpsMaxHdop', 'gpsMaxSpeed', 'gpsRDP', 'gpsDownsample', 'gpsTrackWeight', 'gpsPeakLatency',
      'gpsSnapToRoads', 'gpsSnapRadius',
      'clusterProximity', 'clusterBoundaryRadius',
      'lowerGraphMode', 'useDeconvolution'
    ];
    for (const key of sliderKeys) {
      AppState.sliders[key] = GSREvents._id(key);
    }

    // Stats display text elements
    const statKeys = {
      date: 'statDate',
      startTime: 'statStartTime',
      duration: 'statDuration',
      meanSCL: 'statMeanSCL',
      peakCount: 'statPeakCount',
      peakFreq: 'statPeakFreq',
      spatialData: 'statSpatialData',
      spatialDataCard: 'statSpatialDataCard'
    };
    for (const [key, id] of Object.entries(statKeys)) {
      AppState.statFields[key] = GSREvents._id(id);
    }

    // Contour controls (used in collective map)
    const contourKeys = [
      'gridResolution', 'contourCount', 'isolationRadius', 'idwExponent',
      'topoSource', 'showShadedSurface', 'normalizeZScore', 'surfaceOpacity'
    ];
    AppState.contourControls = {};
    for (const key of contourKeys) {
      AppState.contourControls[key] = GSREvents._id(key);
    }
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
   * Update the dimmed state of a slider-group based on whether value is 0 (off).
   * If a parentId is provided, dims based on the parent slider's value instead.
   */
  updateFilterDim(slider, parentId) {
    const group = slider.closest('.slider-group');
    if (!group) return;
    let val;
    if (typeof parentId === 'string' && parentId) {
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
      const step = parseFloat(slider.step) || 0.1;
      const decimals = step < 0.1 ? 2 : (suffix.includes('μS') ? 3 : 1);
      label.innerText = val === 0 ? 'off' : val.toFixed(decimals) + suffix;
      updateDim();
      if (typeof GSRTrackManager !== 'undefined') {
        GSRTrackManager.saveActiveTrackParams();
        GSRTrackManager.renderTrackList();
      }
      GSRUI.runAnalysis();
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
      if (typeof GSRTrackManager !== 'undefined') {
        GSRTrackManager.saveActiveGpsParams();
        GSRTrackManager.renderTrackList();
      }
      GSRUI.rerenderMap();
    });

    // Re-evaluate dim state when the parent slider changes
    if (parentId) {
      const parent = document.getElementById(parentId);
      if (parent) parent.addEventListener('input', updateDim);
    }
  },

  /**
   * Update the Tonic Baseline Window slider configuration and DWT visibility
   * dynamically based on the selected baseline method.
   */
  updateTonicMethodLayout(isInitial = false) {
    const S = AppState.sliders;
    if (!S || !S.tonicMethod) return;

    const method = S.tonicMethod.value;
    const dwtGroup = document.getElementById('dwtLevelGroup');
    const twGroup = document.getElementById('tonicWindowGroup');
    
    if (dwtGroup) dwtGroup.style.display = method === 'dwt' ? '' : 'none';
    if (twGroup) twGroup.style.display = method === 'dwt' ? 'none' : '';

    if (method !== 'dwt') {
      const slider = document.getElementById('tonicWindow');
      const rec = document.getElementById('tonicWindowRec');
      const help = document.getElementById('tonicWindowHelp');
      const label = document.getElementById('valTonicWindow');

      let min, max, defVal, recLeft, recWidth, helpText;

      if (method === 'percentile') {
        min = 5; max = 45; defVal = 15;
        recLeft = '12.5%'; recWidth = '50%';
        helpText = 'Wider windows isolate baseline from peaks. <strong>Recommended:</strong> 10–30 s.';
      } else if (method === 'median') {
        min = 10; max = 60; defVal = 30;
        recLeft = '20%'; recWidth = '50%';
        helpText = 'Robust median window to exclude peaks. <strong>Recommended:</strong> 20–45 s.';
      } else if (method === 'lpf') {
        min = 15; max = 90; defVal = 45;
        recLeft = '20%'; recWidth = '40%';
        helpText = 'Low-pass equivalent window for EMA smoothing. <strong>Recommended:</strong> 30–60 s.';
      }

      if (slider) {
        slider.min = min;
        slider.max = max;
        const currVal = parseFloat(slider.value);
        if (!isInitial || isNaN(currVal) || currVal < min || currVal > max) {
          slider.value = defVal;
        }
        if (label) {
          label.innerText = parseFloat(slider.value).toFixed(1) + ' s';
        }
      }
      if (rec) {
        rec.style.left = recLeft;
        rec.style.width = recWidth;
      }
      if (help) {
        help.innerHTML = helpText;
      }
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
    GSREvents.bindGsrSlider('minPeakQuality',    'valMinPeakQuality',    '');
    GSREvents.bindGsrSlider('hotspotPercentile', 'valHotspotPercentile', ' %');
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
      });
    }

    S.tonicMethod.addEventListener('change', () => {
      GSREvents.updateTonicMethodLayout(false);
      GSRUI.runAnalysis();
    });

    // ── SCR Deconvolution toggle ──────────────────────────────────────────────
    // Triggers full re-analysis because the phasic signal is replaced with the
    // deconvolved/reconstructed version when enabled.
    if (S.useDeconvolution) {
      S.useDeconvolution.addEventListener('change', () => {
        GSREvents.updateDeconvolutionUIState();
        GSRUI.runAnalysis();
      });
    }

    // ── Lower graph metric selector ──────────────────────────────────────────
    // Rendering-only setting (no re-analysis needed) — sync AppState immediately
    // so it reflects any value restored from localStorage by loadSettings().
    if (S.lowerGraphMode) {
      AppState.lowerGraphMode = S.lowerGraphMode.value;
      S.lowerGraphMode.addEventListener('change', () => {
        AppState.lowerGraphMode = S.lowerGraphMode.value;
        redraw();
      });
    }

    // ── File Upload Handlers ──────────────────────────────────────────────────
    // Save browser fullscreen state before the file dialog opens (browser exits fullscreen)
    AppState.fileInput.addEventListener('click', () => {
      GSRTrackManager._browserFsSave = AppState.isBrowserFullscreen;
    });
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
      // Dragging doesn't exit fullscreen, no save needed
      if (e.dataTransfer.files.length > 0) {
        GSRTrackManager.handleIncomingFiles(Array.from(e.dataTransfer.files));
      }
    });
    AppState.dropZone.addEventListener('click', (e) => {
      if (!e.target.closest('label') && e.target !== AppState.fileInput) {
        // Save browser fullscreen state before the file dialog opens
        GSRTrackManager._browserFsSave = AppState.isBrowserFullscreen;
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
    bindToggle('btnToggleHotspots', 'showHotspots');

    // ── Export Buttons ────────────────────────────────────────────────────────
    document.getElementById('exportCsvBtn').addEventListener('click',   GSRUI.exportCSV);
    document.getElementById('exportImageBtn').addEventListener('click', GSRUI.saveCanvasImage);
    document.getElementById('exportMapBtn').addEventListener('click',   GSRUI.saveMapImage);
    document.getElementById('exportSvgBtn').addEventListener('click', async () => {
      if (AppState.mapManager) await GSRMapExporter.exportToSvg(AppState.mapManager);
    });
    document.getElementById('exportProjectBtn').addEventListener('click', () => {
      GSRCollectiveProject.exportProject();
    });

    // ── Demo Loader ──────────────────────────────────────────────────────────
    document.getElementById('loadDemoBtn').addEventListener('click', GSRTrackManager.loadDefaultTrack);

    // ── GPS slider bindings ──────────────────────────────────────────────────
    GSREvents.bindGpsSlider('gpsSmoothing',   'valGpsSmoothing',   v => v.toFixed(2));
    GSREvents.bindGpsSlider('gpsKalmanR',     'valGpsKalmanR',     v => `${v} m²`);
    GSREvents.bindGpsSlider('gpsMaxHdop',     'valGpsMaxHdop',     v => `≤ ${v.toFixed(1)}`);
    GSREvents.bindGpsSlider('gpsMaxSpeed',    'valGpsMaxSpeed',    v => `${v.toFixed(1)} m/s`);
    GSREvents.bindGpsSlider('gpsRDP',         'valGpsRDP',         v => v === 0 ? 'off' : `${v} m`);
    GSREvents.bindGpsSlider('gpsDownsample',  'valGpsDownsample',  v => v === 0 ? 'off' : '1 Hz');
    GSREvents.bindGpsSlider('gpsTrackWeight', 'valGpsTrackWeight', v => `${v} px`);

    // ── Spatial Clustering slider bindings ──────────────────────────────────
    GSREvents.bindGpsSlider('clusterProximity', 'valClusterProximity', v => `${v} m`);
    GSREvents.bindGpsSlider('clusterBoundaryRadius', 'valClusterBoundaryRadius', v => `${v} m`);

    // ── Snap radius slider ───────────────────────────────────────────────────
    // Re-evaluates road snapping locally from cached OSM data when released.
    {
      const slider = document.getElementById('gpsSnapRadius');
      const label  = document.getElementById('valGpsSnapRadius');
      if (slider && label) {
        const updateDim = () => GSREvents.updateFilterDim(slider);
        updateDim();
        slider.addEventListener('input', () => {
          label.innerText = `${parseInt(slider.value)} m`;
          updateDim();
        });
        slider.addEventListener('change', () => {
          if (AppState.analyzer && AppState.analyzer.osmJson) {
            GSRUI.enrichTrack(false); // Recompute using local cache!
          } else {
            GSRUI.rerenderMap();
          }
        });
      }
    }

    // ── Road snap toggle ─────────────────────────────────────────────────────
    // Toggling re-runs enrichment (which includes snapping) if OSM data is
    // already loaded; otherwise just saves the preference for next enrichment.
    {
      const snapToggle = document.getElementById('gpsSnapToRoads');
      if (snapToggle) {
        snapToggle.addEventListener('change', () => {
          if (AppState.analyzer && AppState.analyzer.osmJson) {
            // OSM data already loaded — re-run enrichment locally
            GSRUI.enrichTrack(false);
          } else {
            // No OSM data yet — just re-render
            GSRUI.rerenderMap();
          }
        });
      }
    }


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
        if (typeof GSRUI !== 'undefined' && typeof GSRUI.updateEnvironmentalDashboard === 'function') {
          GSRUI.updateEnvironmentalDashboard();
        }
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
    const btnToggleRFFluid = document.getElementById('btnToggleRFFluid');
    if (btnToggleRFFluid) {
      btnToggleRFFluid.addEventListener('click', () => {
        btnToggleRFFluid.classList.toggle('active');
        if (AppState.mapManager) AppState.mapManager.toggleRFFluid(btnToggleRFFluid.classList.contains('active'));
      });
    }

    const rfFluidMode = document.getElementById('rfFluidMode');
    if (rfFluidMode) {
      rfFluidMode.addEventListener('change', (e) => {
        if (AppState.mapManager) AppState.mapManager.setRFFluidMode(e.target.value);
      });
    }

    const btnToggleMapPeaks = document.getElementById('btnToggleMapPeaks');
    btnToggleMapPeaks.addEventListener('click', () => {
      btnToggleMapPeaks.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.togglePeaks(btnToggleMapPeaks.classList.contains('active'));
    });

    const btnToggleMapHotspots = document.getElementById('btnToggleMapHotspots');
    btnToggleMapHotspots.addEventListener('click', () => {
      btnToggleMapHotspots.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.toggleHotspots(btnToggleMapHotspots.classList.contains('active'));
    });

    const btnToggleMapLabels = document.getElementById('btnToggleMapLabels');
    btnToggleMapLabels.addEventListener('click', () => {
      btnToggleMapLabels.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.toggleLabels(btnToggleMapLabels.classList.contains('active'));
    });

    const btnToggleMapClusters = document.getElementById('btnToggleMapClusters');
    btnToggleMapClusters.addEventListener('click', () => {
      btnToggleMapClusters.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.toggleClusters(btnToggleMapClusters.classList.contains('active'));
    });

    const btnToggleMapIsolines = document.getElementById('btnToggleMapIsolines');
    btnToggleMapIsolines.addEventListener('click', () => {
      btnToggleMapIsolines.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.toggleIsolines(btnToggleMapIsolines.classList.contains('active'));
    });

    const btnToggleMapSurface = document.getElementById('btnToggleMapSurface');
    btnToggleMapSurface.addEventListener('click', () => {
      btnToggleMapSurface.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.toggleSurface(btnToggleMapSurface.classList.contains('active'));
    });

    const btnToggleMapTracks = document.getElementById('btnToggleMapTracks');
    btnToggleMapTracks.addEventListener('click', () => {
      btnToggleMapTracks.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.toggleTracks(btnToggleMapTracks.classList.contains('active'));
    });

    // ── Panel Collapse Toggles (DRY via bindCollapseButton) ──────────────────
    GSREvents.bindCollapseButton('btnEventsCollapse',        'eventsPanel');
    GSREvents.bindCollapseButton('btnGsrFilteringCollapse',  'gsrFilteringCard');
    GSREvents.bindCollapseButton('btnPeakDetectionCollapse', 'peakDetectionCard');
    GSREvents.bindCollapseButton('btnGpsFilteringCollapse',  'gpsFilteringCard');
    GSREvents.bindCollapseButton('btnMapDisplayCollapse',    'mapDisplayCard');
    GSREvents.bindCollapseButton('btnImportCollapse',        'importCard');
    GSREvents.bindCollapseButton('btnExportCollapse',        'exportCard');
    GSREvents.bindCollapseButton('btnContourCollapse',       'contourSettingsCard');
    GSREvents.bindCollapseButton('btnGsrCollapse',           'gsrPanel');
    GSREvents.bindCollapseButton('btnMapCollapse',           'mapPanel');
    GSREvents.bindCollapseButton('btnOsmEnrichmentCollapse', 'osmEnrichmentCard');
    GSREvents.bindCollapseButton('btnEnvCollapse',           'environmentalPanel');

    // ── Preset Export / Import Controls ─────────────────────────────────────
    const btnExportPreset = document.getElementById('btnExportPreset');
    if (btnExportPreset) {
      btnExportPreset.addEventListener('click', () => {
        GSRStorage.exportPreset();
      });
    }

    const btnConfirmExportPreset = document.getElementById('btnConfirmExportPreset');
    if (btnConfirmExportPreset) {
      btnConfirmExportPreset.addEventListener('click', () => {
        if (typeof GSRUI !== 'undefined' && typeof GSRUI.confirmExportPreset === 'function') {
          GSRUI.confirmExportPreset();
        }
      });
    }

    const presetFileNameInput = document.getElementById('presetFileNameInput');
    if (presetFileNameInput) {
      presetFileNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (typeof GSRUI !== 'undefined' && typeof GSRUI.confirmExportPreset === 'function') {
            GSRUI.confirmExportPreset();
          }
        }
      });
    }

    const btnApplyPreset = document.getElementById('btnApplyPreset');
    const presetFileInput = document.getElementById('presetFileInput');
    if (btnApplyPreset && presetFileInput) {
      btnApplyPreset.addEventListener('click', () => {
        presetFileInput.click();
      });
      presetFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          GSRStorage.importPresetFile(file);
          presetFileInput.value = '';
        }
      });
    }

    const btnApplyActiveToAll = document.getElementById('btnApplyActiveToAll');
    if (btnApplyActiveToAll) {
      btnApplyActiveToAll.addEventListener('click', () => {
        const tracks = AppState.collectiveManager.tracks;
        if (!tracks || tracks.length === 0) {
          alert('No tracks loaded to apply preset to.');
          return;
        }

        // Flush live UI sliders into active track params first
        if (typeof GSRTrackManager !== 'undefined') {
          GSRTrackManager.saveActiveTrackParams();
          GSRTrackManager.saveActiveGpsParams();
        }

        const activeGsr = GSRStorage.readGsrSliderValues();
        const activeGps = GSRStorage.readGpsSliderValues();

        tracks.forEach(track => {
          track.filterParams = JSON.parse(JSON.stringify(activeGsr));
          track.gpsFilterParams = JSON.parse(JSON.stringify(activeGps));
          try {
            const pl = (track.gpsFilterParams && track.gpsFilterParams.peakLatency) || 0;
            track.analyzer.analyze(track.filterParams, pl);
          } catch (e) {
            console.warn(`Re-analyzing track "${track.name}" failed:`, e);
          }
        });

        if (typeof GSRUI !== 'undefined') {
          if (typeof GSRUI.invalidateEnvironmentalCache === 'function') {
            GSRUI.invalidateEnvironmentalCache();
          }
          if (typeof GSRUI.runAnalysis === 'function') {
            GSRUI.runAnalysis();
          }
          if (AppState.viewMode === 'collective' && typeof GSRUI.updateCollectiveMap === 'function') {
            GSRUI.updateCollectiveMap();
          }
        }

        if (typeof GSRTrackManager !== 'undefined') {
          GSRTrackManager.renderTrackList();
        }
      });
    }

    // ── OSM Enrichment Control Bindings ─────────────────────────────────────
    {
      const radiusSlider = document.getElementById('osmRadius');
      const radiusLabel = document.getElementById('valOsmRadius');
      radiusSlider.addEventListener('input', () => {
        radiusLabel.innerText = radiusSlider.value + ' m';
      });
      radiusSlider.addEventListener('change', () => {
        if (AppState.analyzer && AppState.analyzer.osmJson) {
          GSRUI.enrichTrack(false); // Re-run enrichment locally!
        }
      });
    }

    document.getElementById('btnEnrichTrack').addEventListener('click', () => GSRUI.enrichTrack(true));

    document.getElementById('btnClearOsmCache').addEventListener('click', async () => {
      if (!confirm('Clear locally cached OpenStreetMap data? Future enrichment will re-fetch from the Overpass API.')) return;
      try {
        await OsmCache.clear();
        alert('OSM cache cleared.');
      } catch (err) {
        console.error('OsmCache.clear failed:', err);
        alert('Could not clear the OSM cache: ' + err.message);
      }
    });

    document.getElementById('mapColoringMetric').addEventListener('change', (e) => {
      if (AppState.mapManager) {
        AppState.mapManager.activeColoringMetric = e.target.value;
        GSRUI.rerenderMap();
      }
    });

    const btnToggleOsmShapes = document.getElementById('btnToggleOsmShapes');
    btnToggleOsmShapes.addEventListener('click', () => {
      btnToggleOsmShapes.classList.toggle('active');
      const active = btnToggleOsmShapes.classList.contains('active');
      if (AppState.mapManager) {
        if (active) {
          // Combines every active track's OSM geometry in collective
          // mode (not just AppState.analyzer's) — see getCombinedOsmGeoms.
          const geoms = GSRUI.getCombinedOsmGeoms();
          if (geoms) AppState.mapManager.drawOsmShapes(geoms);
        } else {
          AppState.mapManager.clearOsmShapes();
        }
      }
    });

    // Dashboard Tab Switcher
    const bindEnvTab = (btnId, panelId) => {
      const btn = document.getElementById(btnId);
      btn.addEventListener('click', () => {
        document.querySelectorAll('#envTabSwitcher .view-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.env-tab-content').forEach(p => {
          p.style.display = 'none';
          p.classList.remove('active');
        });
        btn.classList.add('active');
        const pEl = document.getElementById(panelId);
        if (pEl) {
          pEl.style.display = 'flex';
          pEl.classList.add('active');
        }
        GSRUI.updateEnvironmentalDashboard();
      });
    };
    bindEnvTab('btnEnvTabCorrelation', 'envTabCorrelation');
    bindEnvTab('btnEnvTabScatter',     'envTabScatter');
    bindEnvTab('btnEnvTabRoads',       'envTabRoads');

    document.getElementById('scatterEnvMetric').addEventListener('change', () => GSRUI.updateEnvironmentalDashboard());
    document.getElementById('scatterBioMetric').addEventListener('change', () => GSRUI.updateEnvironmentalDashboard());

    // ── Centralised Layout & Fullscreen Management ───────────────────────────
    GSRLayoutManager.init();
  },

  /**
   * View switcher (Single Track ↔ Collective Map Surface).
   */
  bindViewSwitcher() {
    const btnSingleView      = document.getElementById('btnSingleView');
    const btnCollectiveView  = document.getElementById('btnCollectiveView');
    const appMainLayout      = document.querySelector('.main-layout');
    const contourSettingsCard = document.getElementById('contourSettingsCard');

    // Collective-only map toggle buttons (multi-track contour surface) —
    // meaningless in single-track view, so hidden there. See index.html.
    const collectiveOnlyMapBtns = [
      document.getElementById('btnToggleMapIsolines'),
      document.getElementById('btnToggleMapSurface'),
      document.getElementById('btnToggleMapTracks')
    ].filter(Boolean);

    btnSingleView.addEventListener('click', () => {
      if (AppState.viewMode === 'single') return;
      AppState.viewMode = 'single';
      btnSingleView.classList.add('active');
      btnCollectiveView.classList.remove('active');

      // Force the next renderData() to re-fit the viewport — otherwise the map keeps
      // whatever framing the collective view left it at (e.g. fit to several tracks) since
      // the active track's cacheKey hasn't itself changed. See GSRMapManager's
      // _lastFitBoundsTrackId/_lastFitBoundsTrackSet in map.js.
      if (AppState.mapManager) {
        AppState.mapManager._lastFitBoundsTrackId = null;
        AppState.mapManager._lastFitBoundsTrackSet = null;
      }
      appMainLayout.classList.remove('collective-mode');
      contourSettingsCard.style.display = 'none';
      collectiveOnlyMapBtns.forEach(btn => btn.style.display = 'none');

      const peakCard = document.getElementById('peakDetectionCard');
      if (peakCard) peakCard.style.display = '';

      const btnEnrich = document.getElementById('btnEnrichTrack');
      if (btnEnrich) btnEnrich.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Retrieve Spatial Data';

      if (AppState.mapManager) AppState.mapManager.clearCollectiveLayers();

      document.getElementById('gsrPanel').style.display = '';
      document.getElementById('eventsPanel').style.display = '';

      if (AppState.analyzer && AppState.analyzer.raw.length > 0) {
        windowResized();
        loop();
        GSRUI.runAnalysis();
      } else {
        noLoop();
        GSRRenderer.drawPlaceholder();
        if (AppState.mapManager) AppState.mapManager.clearMap();
      }
      GSRUI.refreshOsmControls(); // resync OSM Layers button/indicator to the now-active single track
      if (AppState.mapManager && AppState.mapManager.map) {
        setTimeout(() => AppState.mapManager.map.invalidateSize(), 80);
      }
    });

    btnCollectiveView.addEventListener('click', () => {
      if (AppState.viewMode === 'collective') return;
      AppState.viewMode = 'collective';
      btnCollectiveView.classList.add('active');
      btnSingleView.classList.remove('active');

      // Force the next renderCollectiveData() to re-fit — otherwise if the same active
      // track set was already fit once before (e.g. user bounced collective -> single ->
      // collective without changing which tracks are active), the signature check would
      // wrongly treat it as "unchanged" and leave the map framed to whatever single-track
      // view was showing instead. See GSRMapManager's _lastFitBoundsTrackId/TrackSet in map.js.
      if (AppState.mapManager) {
        AppState.mapManager._lastFitBoundsTrackId = null;
        AppState.mapManager._lastFitBoundsTrackSet = null;
      }
      appMainLayout.classList.add('collective-mode');
      contourSettingsCard.style.display = '';
      collectiveOnlyMapBtns.forEach(btn => btn.style.display = '');

      const peakCard = document.getElementById('peakDetectionCard');
      if (peakCard) peakCard.style.display = 'none';

      const btnEnrich = document.getElementById('btnEnrichTrack');
      if (btnEnrich) btnEnrich.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Retrieve Spatial Data';

      document.getElementById('gsrPanel').style.display = 'none';
      document.getElementById('eventsPanel').style.display = 'none';
      noLoop();

      GSRUI.updateCollectiveMap();
      GSRUI.refreshOsmControls(); // reflects all/none/mixed enrichment across active tracks
      if (AppState.mapManager && AppState.mapManager.map) {
        setTimeout(() => AppState.mapManager.map.invalidateSize(), 80);
      }
    });
  },

  /**
   * Contour settings sliders.
   */
  bindContourInputs() {
    const triggerUpdate = () => {
      if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
    };

    const bindCi = (id, labelId, fmt) => {
      const input = document.getElementById(id);
      const label = document.getElementById(labelId);
      input.addEventListener('input', () => {
        if (label) label.innerText = fmt(parseFloat(input.value));
        triggerUpdate();
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
        triggerUpdate();
      });
    }

    document.getElementById('topoSource').addEventListener('change', triggerUpdate);

    const normalizeZ = document.getElementById('normalizeZScore');
    if (normalizeZ) {
      normalizeZ.addEventListener('change', triggerUpdate);
    }
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
        const step = parseFloat(slider.step) || 0.1;
        const decimals = step < 0.1 ? 2 : (suffix.includes('μS') ? 3 : 1);
        label.innerText = val === 0 ? 'off' : val.toFixed(decimals) + suffix;
      }
    };
    updateLabel('medianSize',    'valMedianSize',    ' s');
    updateLabel('lpfWindow',     'valLpfWindow',     ' s');
    updateLabel('tonicWindow',   'valTonicWindow',   ' s');
    updateLabel('dwtLevel',      'valDwtLevel',      '');
    updateLabel('peakThreshold',     'valPeakThreshold',     ' μS');
    updateLabel('minPeakQuality',    'valMinPeakQuality',    '');
    updateLabel('hotspotPercentile', 'valHotspotPercentile', ' %');
    updateLabel('shapeMinRiseTime',  'valShapeMinRiseTime',  ' s');
    updateLabel('shapeMaxRiseTime',  'valShapeMaxRiseTime',  ' s');
    updateLabel('shapeMinHalfRecovery', 'valShapeMinHalfRecovery', ' s');
    updateLabel('shapeMaxHalfRecovery', 'valShapeMaxHalfRecovery', ' s');
    // SNR: custom formatting with × suffix (show off when 0)
    const snrSlider = document.getElementById('shapeMinSnr');
    const snrLabel  = document.getElementById('valShapeMinSnr');
    if (snrSlider && snrLabel) {
      const val = parseFloat(snrSlider.value);
      snrLabel.innerText = val === 0 ? 'off' : val.toFixed(1) + '\u00d7';
    }
    updateLabel('shapeMaxSkewRatio', 'valShapeMaxSkewRatio', '');

    // Initial tonic method layout and visibility setup (preserving saved settings value)
    GSREvents.updateTonicMethodLayout(true);

    // GPS Labels
    const gpsFormatters = {
      gpsSmoothing:   v => v.toFixed(2),
      gpsKalmanR:     v => `${v} m²`,
      gpsMaxHdop:     v => `≤ ${v.toFixed(1)}`,
      gpsMaxSpeed:    v => `${v.toFixed(1)} m/s`,
      gpsRDP:         v => v === 0 ? 'off' : `${v} m`,
      gpsDownsample:  v => v === 0 ? 'off' : '1 Hz',
      gpsTrackWeight: v => `${v} px`,
      gpsPeakLatency: v => `${v.toFixed(1)} s`,
      gpsSnapRadius:  v => `${v} m`,
      clusterProximity: v => `${v} m`,
      clusterBoundaryRadius: v => `${v} m`
    };

    for (const [id, fmt] of Object.entries(gpsFormatters)) {
      const slider = document.getElementById(id);
      const labelId = 'val' + id.charAt(0).toUpperCase() + id.slice(1);
      const label = document.getElementById(labelId);
      if (slider && label) {
        label.innerText = fmt(parseFloat(slider.value));
      }
    }

    // Contour Settings Labels & Visibility Setup
    const C = AppState.contourControls;
    if (C && C.gridResolution) {
      const updateCLabel = (id, labelId, fmt) => {
        const input = document.getElementById(id);
        const label = document.getElementById(labelId);
        if (input && label) label.innerText = fmt(parseFloat(input.value));
      };
      updateCLabel('gridResolution',  'valGridResolution',  v => `${v} x ${v}`);
      updateCLabel('contourCount',    'valContourCount',    v => `${v} lines`);
      updateCLabel('isolationRadius', 'valIsolationRadius', v => `${v} m`);
      updateCLabel('idwExponent',     'valIdwExponent',     v => v.toFixed(1));
      updateCLabel('surfaceOpacity',  'valSurfaceOpacity',  v => `${Math.round(v * 100)}%`);

      const showShaded = document.getElementById('showShadedSurface');
      const opacityGroup = document.getElementById('surfaceOpacityGroup');
      if (showShaded && opacityGroup) {
        opacityGroup.style.display = showShaded.checked ? 'block' : 'none';
      }
    }

    // Sync dim state for all sliders across all control cards
    document.querySelectorAll('input[type="range"]').forEach(slider => GSREvents.updateFilterDim(slider));

    GSREvents.updateDeconvolutionUIState();
  },

  /**
   * Lock/unlock shape sliders depending on deconvolution state.
   */
  updateDeconvolutionUIState() {
    const deconvCheckbox = document.getElementById('useDeconvolution');
    const useDeconv = deconvCheckbox ? deconvCheckbox.checked : false;

    // Derive canonical shape values analytically from the actual SCRF kernel so
    // they stay in sync with GSR_CONST.SCRF if tauSlow/tauFast ever change,
    // rather than being hand-typed numbers that can drift.
    const scf = (typeof GSR_CONST !== 'undefined') ? GSR_CONST.SCRF : null;
    let canonRise = 1.2, canonHalf = 2.2, canonSkew = 0.55;
    if (scf && typeof SCRDeconvolution !== 'undefined') {
      const sampleRate = 10; // Kernel metrics are rate-independent at this resolution
      const k = SCRDeconvolution.buildSCRFKernel(sampleRate, scf.tauSlow, scf.tauFast, scf.kernelSec);
      const dt = 1.0 / sampleRate;
      let kPeakIdx = 0;
      for (let i = 1; i < k.length; i++) { if (k[i] > k[kPeakIdx]) kPeakIdx = i; }
      let kHalfIdx = kPeakIdx;
      for (let i = kPeakIdx; i < k.length; i++) { if (k[i] <= 0.5) { kHalfIdx = i; break; } }
      canonRise = parseFloat((kPeakIdx * dt).toFixed(2));
      canonHalf = parseFloat(((kHalfIdx - kPeakIdx) * dt).toFixed(2));
      canonSkew = canonHalf > 0 ? parseFloat((canonRise / canonHalf).toFixed(2)) : 0;
    }

    const shapeSliders = [
      { id: 'shapeMinRiseTime',      labelId: 'valShapeMinRiseTime',      canonical: `${canonRise} s (locked)`,  canonicalValue: canonRise, suffix: ' s' },
      { id: 'shapeMaxRiseTime',      labelId: 'valShapeMaxRiseTime',      canonical: `${canonRise} s (locked)`,  canonicalValue: canonRise, suffix: ' s' },
      { id: 'shapeMinHalfRecovery',  labelId: 'valShapeMinHalfRecovery',  canonical: `${canonHalf} s (locked)`,  canonicalValue: canonHalf, suffix: ' s' },
      { id: 'shapeMaxHalfRecovery',  labelId: 'valShapeMaxHalfRecovery',  canonical: `${canonHalf} s (locked)`,  canonicalValue: canonHalf, suffix: ' s' },
      { id: 'shapeMaxSkewRatio',     labelId: 'valShapeMaxSkewRatio',     canonical: `${canonSkew} (locked)`,    canonicalValue: canonSkew, suffix: '' }
    ];

    shapeSliders.forEach(s => {
      const slider = document.getElementById(s.id);
      const label = document.getElementById(s.labelId);
      const group = slider ? slider.closest('.slider-group') : null;
      
      if (slider) {
        slider.disabled = useDeconv;
        if (useDeconv) {
          // Cache custom user setting before overwriting
          if (slider.dataset.customValue === undefined) {
            slider.dataset.customValue = slider.value;
          }
          slider.value = s.canonicalValue;
        } else {
          // Restore the cached pre-lock value, or — if there isn't one —
          // fall back to the slider's own declared default (its HTML
          // value="0"/off attribute). Without this fallback, unchecking
          // deconvolution when no genuine "before" state was ever cached
          // (e.g. the checkbox was already checked on page load via browser
          // form-state restoration, or loadActiveTrackParams() just cleared
          // the cache when switching tracks) silently leaves the slider at
          // whatever locked canonical number it was showing. That's a real
          // problem specifically for the min/max pairs (rise time, half-
          // recovery): both ends of the pair get locked to the SAME
          // canonical value, so a stuck slider means min === max — a
          // razor-thin range that rejects almost every peak — not a merely
          // suboptimal one. Falling back to the shipped default (0 = off,
          // matching GSR_DEFAULT) guarantees the slider always lands back in
          // a sane, usable state rather than an accidental leftover lock.
          if (slider.dataset.customValue !== undefined) {
            slider.value = slider.dataset.customValue;
            delete slider.dataset.customValue;
          }
        }
      }
      if (group) {
        group.classList.toggle('deconv-locked', useDeconv);
      }
      if (label) {
        if (useDeconv) {
          label.innerText = s.canonical;
        } else if (slider) {
          const val = parseFloat(slider.value);
          const step = parseFloat(slider.step) || 0.1;
          const decimals = step < 0.1 ? 2 : 1;
          label.innerText = val === 0 ? 'off' : val.toFixed(decimals) + (s.suffix || '');
        }
      }
    });
  }
};
