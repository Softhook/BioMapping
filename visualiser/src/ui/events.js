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
      'medianSize', 'lpfWindow', 'tonicWindow', 'tonicMethod', 'peakThreshold', 'minPeakQuality', 'peakDensityWindow', 'hotspotPercentile', 'dwtLevel',
      'shapeMinRiseTime', 'shapeMaxRiseTime', 'shapeMinHalfRecovery', 'shapeMaxHalfRecovery',
      'shapeMinSnr', 'shapeMaxSkewRatio',
      'gpsSmoothing', 'gpsKalmanR', 'gpsMaxHdop', 'gpsMaxSpeed', 'gpsRDP', 'gpsDownsample', 'gpsTrackWeight', 'gpsPeakLatency',
      'gpsSnapToRoads', 'gpsSnapRadius',
      'clusterProximity', 'clusterBoundaryRadius',
      'graphView', 'useDeconvolution', 'usePeakProminence', 'adaptiveNotch'
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
      'gridResolution', 'contourCount', 'isolationRadius', 'idwExponent', 'peakPreservation',
      'coverageWeighting', 'topoSource', 'normalizeZScore', 'surfaceOpacity', 'hillshadeStrength'
    ];
    AppState.contourControls = {};
    for (const key of contourKeys) {
      AppState.contourControls[key] = GSREvents._id(key);
    }
    AppState.contourControls.showShadedSurface = GSREvents._id('btnToggleMapSurface');
  },

  /**
   * Bind a collapse button to toggle the `.collapsed` class on its card.
   * Replaces 7+ copy-pasted addEventListener blocks. Optional onToggle(collapsed)
   * lets a caller react to the new state (see the gsrPanel binding below).
   */
  bindCollapseButton(btnId, cardId, onToggle) {
    const btn = GSREvents._id(btnId);
    const card = GSREvents._id(cardId);
    if (!btn || !card) return;
    btn.addEventListener('click', () => {
      const collapsed = card.classList.toggle('collapsed');
      if (onToggle) onToggle(collapsed);
    });
  },

  /**
   * Bind clickable column headers on the SCR Events table for sorting.
   */
  bindPeaksTableSort() {
    const table = document.getElementById('peaksTable');
    if (!table) return;
    const ths = table.querySelectorAll('thead th.sortable');
    ths.forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (col && typeof GSRUI !== 'undefined' && typeof GSRUI.sortPeaksTable === 'function') {
          GSRUI.sortPeaksTable(col);
        }
      });
    });
  },



  /**
   * Wrap fn so repeated calls collapse into one trailing-edge call per
   * animation frame. A slider's native 'input' event can fire far more often
   * than the screen actually repaints during a drag, and the work behind
   * these sliders (analyzer.analyze() / the GPS Kalman pipeline, followed by
   * mapManager.clearMap() + a full Leaflet layer rebuild) is heavy enough
   * that running it on every single tick makes dragging feel sluggish. This
   * keeps the label/dim updates instant (callers do those synchronously,
   * outside the wrapped fn) while capping the expensive re-render to once
   * per frame.
   */
  rafCoalesce(fn) {
    let scheduled = false;
    let lastArgs;
    return (...args) => {
      lastArgs = args;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn(...lastArgs);
      });
    };
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

    const runHeavyWork = GSREvents.rafCoalesce(() => {
      if (typeof GSRTrackManager !== 'undefined') {
        GSRTrackManager.saveActiveTrackParams();
        GSRTrackManager.renderTrackList();
      }
      GSRUI.runAnalysis();
    });

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      const step = parseFloat(slider.step) || 0.1;
      const decimals = step < 0.1 ? 2 : (suffix.includes('μS') ? 3 : 1);
      label.innerText = val === 0 ? 'off' : val.toFixed(decimals) + suffix;
      updateDim();
      runHeavyWork();
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

    const runHeavyWork = GSREvents.rafCoalesce(() => {
      if (typeof GSRTrackManager !== 'undefined') {
        GSRTrackManager.saveActiveGpsParams();
        GSRTrackManager.renderTrackList();
      }
      GSRUI.rerenderMap();
    });

    slider.addEventListener('input', () => {
      label.innerText = fmt(parseFloat(slider.value));
      updateDim();
      runHeavyWork();
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
    GSREvents.bindGsrSlider('peakDensityWindow', 'valPeakDensityWindow', ' s');
    GSREvents.bindGsrSlider('hotspotPercentile', 'valHotspotPercentile', ' %');
    GSREvents.bindGsrSlider('shapeMinRiseTime',  'valShapeMinRiseTime',  ' s');
    GSREvents.bindGsrSlider('shapeMaxRiseTime',  'valShapeMaxRiseTime',  ' s');
    GSREvents.bindGsrSlider('shapeMinHalfRecovery', 'valShapeMinHalfRecovery', ' s');
    GSREvents.bindGsrSlider('shapeMaxHalfRecovery', 'valShapeMaxHalfRecovery', ' s');
    GSREvents.bindGsrSlider('shapeMinSnr',       'valShapeMinSnr',       '×');
    GSREvents.bindGsrSlider('shapeMaxSkewRatio', 'valShapeMaxSkewRatio', '');

    // DWT level — custom binding (integer display)
    if (S.dwtLevel) {
      const runHeavyWork = GSREvents.rafCoalesce(() => GSRUI.runAnalysis());
      S.dwtLevel.addEventListener('input', () => {
        const level = parseInt(S.dwtLevel.value);
        document.getElementById('valDwtLevel').innerText = level;
        runHeavyWork();
      });
    }

    S.tonicMethod.addEventListener('change', () => {
      GSREvents.updateTonicMethodLayout(false);
      GSRUI.runAnalysis();
    });

    // ── Alternative-detector toggles (Combined / Deconvolution) ──────────────
    // Mutually exclusive: analyze() only ever runs one detector, so turning
    // either alternative ON forces the other OFF (setting .checked in code
    // does not re-fire 'change', so no loop). Turning one OFF just drops back
    // to the default trough-to-peak detector. Both re-run the full pipeline
    // and refresh the shape-slider visibility.
    if (S.useDeconvolution) {
      S.useDeconvolution.addEventListener('change', () => {
        if (S.useDeconvolution.checked && S.usePeakProminence) {
          S.usePeakProminence.checked = false;
        }
        GSREvents.updateShapeSlidersForDetector();
        GSRUI.runAnalysis();
      });
    }

    if (S.usePeakProminence) {
      S.usePeakProminence.addEventListener('change', () => {
        if (S.usePeakProminence.checked && S.useDeconvolution) {
          S.useDeconvolution.checked = false;
        }
        GSREvents.updateShapeSlidersForDetector();
        GSRUI.runAnalysis();
      });
    }

    // ── Adaptive Notch Filter toggle ──────────────────────────────────────────
    if (S.adaptiveNotch) {
      S.adaptiveNotch.addEventListener('change', () => {
        GSREvents.updateAdaptiveNotchUIState();
        GSRUI.runAnalysis();
      });
    }

    // ── Graph view selector ─────────────────────────────────────────────────
    // Rendering-only setting (no re-analysis needed). One dropdown picks the
    // whole plot: 'signal' or a single derived metric. Choosing a metric view
    // also arms it as lowerGraphMode. The Raw/Filtered/Tonic/Phasic curve
    // toggles are only meaningful in 'signal' view, so hide them otherwise.
    if (S.graphView) {
      const applyGraphView = () => {
        const v = S.graphView.value;
        AppState.graphView = v;
        if (v !== 'signal') AppState.lowerGraphMode = v;
        const showLayerBtns = (v === 'signal');
        for (const id of ['btnToggleRaw', 'btnToggleFiltered', 'btnToggleTonic', 'btnTogglePhasic']) {
          const b = document.getElementById(id);
          if (b) b.style.display = showLayerBtns ? '' : 'none';
        }
        redraw();
      };
      applyGraphView();
      S.graphView.addEventListener('change', applyGraphView);
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

    // ── Shared scrub channel: relay to the 2D map ────────────────────────────
    // The GSR graph (renderer.js handleScrubber) and the 3D globe
    // (globe3d_view.js) both emit 'scrub' with {lat, lon, index, source} or
    // {clear:true}. This is the single place the Leaflet scrub dot is driven.
    // panTo stays on for graph/globe sources so the 2D map keeps its
    // pan-only-when-off-screen behaviour; a 'map'-sourced scrub never pans.
    AppState.on('scrub', (p) => {
      const mm = AppState.mapManager;
      if (!mm) return;
      if (!p || p.clear || isNaN(p.lat) || isNaN(p.lon)) {
        mm.setScrubPosition(NaN, NaN);
      } else {
        mm.setScrubPosition(p.lat, p.lon, p.source !== 'map');
      }
    });

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
    bindToggle('btnTogglePhasic',   'showPhasic');
    bindToggle('btnTogglePeaks',    'showPeaks');
    bindToggle('btnToggleHotspots', 'showHotspots');

    // ── Page Unload & Keyboard Listener ──────────────────────────────────────
    window.addEventListener('beforeunload', (e) => {
      const hasDirty = AppState.collectiveManager && AppState.collectiveManager.tracks
        ? AppState.collectiveManager.tracks.some(t => t.hasUnsavedLabels)
        : false;
      if (hasDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // ── Export Buttons ────────────────────────────────────────────────────────
    document.getElementById('exportCsvBtn').addEventListener('click',   GSRUI.exportCSV);
    document.getElementById('exportImageBtn').addEventListener('click', GSRUI.saveCanvasImage);
    document.getElementById('exportMapBtn').addEventListener('click',   GSRUI.saveMapImage);
    document.getElementById('exportSvgBtn').addEventListener('click', async () => {
      if (AppState.mapManager) await GSRMapExporter.exportToSvg(AppState.mapManager);
    });
    document.getElementById('exportCzmlBtn').addEventListener('click', () => GSREvents.export3DTrack('czml'));
    document.getElementById('exportKmlBtn').addEventListener('click',  () => GSREvents.export3DTrack('kml'));
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
      const runHeavyWork = GSREvents.rafCoalesce(() => {
        GSRUI.rerenderMap();
        if (typeof GSRUI !== 'undefined' && typeof GSRUI.updateEnvironmentalDashboard === 'function') {
          GSRUI.updateEnvironmentalDashboard();
        }
      });
      slider.addEventListener('input', () => {
        label.innerText = parseFloat(slider.value).toFixed(1) + ' s';
        updateDim();
        runHeavyWork();
      });
    }

    // ── View Switcher ────────────────────────────────────────────────────────
    GSREvents.bindViewSwitcher();
    GSREvents.bindSurfaceSwitcher();

    // ── Contour Settings ─────────────────────────────────────────────────────
    GSREvents.bindContourInputs();

    // ── Map Panel Controls ───────────────────────────────────────────────────
    // One header, two engines: when the 3D globe is the mounted surface the
    // shared controls dispatch to it instead of / as well as the Leaflet map
    // (see GSRGlobe3DView.applyToggle / applyRfMode / zoom).
    const g3d = () => (typeof GSRGlobe3DView !== 'undefined') ? GSRGlobe3DView : null;
    const onGlobe = () => AppState.surfaceView === 'globe';

    document.getElementById('btnMapZoomIn').addEventListener('click', () => {
      if (onGlobe()) { if (g3d()) g3d().zoom(-1); return; }
      if (AppState.mapManager) AppState.mapManager.zoomIn();
    });
    document.getElementById('btnMapZoomOut').addEventListener('click', () => {
      if (onGlobe()) { if (g3d()) g3d().zoom(1); return; }
      if (AppState.mapManager) AppState.mapManager.zoomOut();
    });
    document.getElementById('btnMapZoomExtent').addEventListener('click', () => {
      if (onGlobe()) { if (g3d()) g3d().fitTrack(); return; }
      if (AppState.mapManager) AppState.mapManager.fitToTrack();
    });
    const btnToggleRFFluid = document.getElementById('btnToggleRFFluid');
    if (btnToggleRFFluid) {
      btnToggleRFFluid.addEventListener('click', () => {
        if (btnToggleRFFluid.hasAttribute('disabled')) return;
        btnToggleRFFluid.classList.toggle('active');
        const on = btnToggleRFFluid.classList.contains('active');
        if (AppState.mapManager) AppState.mapManager.toggleRFFluid(on);
        if (g3d()) g3d().applyToggle('rf', on);
      });
    }

    const rfFluidMode = document.getElementById('rfFluidMode');
    if (rfFluidMode) {
      rfFluidMode.addEventListener('change', (e) => {
        if (AppState.mapManager) AppState.mapManager.setRFFluidMode(e.target.value);
        if (g3d()) g3d().applyRfMode(e.target.value);
      });
    }

    const bindSharedToggle = (btnId, mmMethod, g3dName) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        const on = btn.classList.contains('active');
        if (AppState.mapManager) AppState.mapManager[mmMethod](on);
        if (g3d()) g3d().applyToggle(g3dName, on);
      });
    };
    bindSharedToggle('btnToggleMapPeaks',    'togglePeaks',    'peaks');
    bindSharedToggle('btnToggleMapHotspots', 'toggleHotspots', 'hotspots');
    bindSharedToggle('btnToggleMapLabels',   'toggleLabels',   'labels');
    bindSharedToggle('btnToggleMapClusters', 'toggleClusters', 'clusters');

    const btnToggleMapIsolines = document.getElementById('btnToggleMapIsolines');
    btnToggleMapIsolines.addEventListener('click', () => {
      btnToggleMapIsolines.classList.toggle('active');
      if (AppState.mapManager) AppState.mapManager.toggleIsolines(btnToggleMapIsolines.classList.contains('active'));
    });

    const btnToggleMapSurface = document.getElementById('btnToggleMapSurface');
    const opacityGroup = document.getElementById('surfaceOpacityGroup');
    btnToggleMapSurface.addEventListener('click', () => {
      btnToggleMapSurface.classList.toggle('active');
      const isActive = btnToggleMapSurface.classList.contains('active');
      if (opacityGroup) {
        opacityGroup.classList.toggle('ctrl-inert', !isActive);
      }
      if (AppState.mapManager) AppState.mapManager.toggleSurface(isActive);
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
    // Collapsing the panel doesn't move the mouse, so no mouseleave fires on
    // the canvas — reset mouseOverCanvas here so mouseMoved() (sketch.js)
    // doesn't keep forcing redraws while the mouse sits over the collapsed
    // graph's old screen area. (handleScrubber's own elementFromPoint
    // hit-test is what actually keeps the scrubber from reactivating.)
    GSREvents.bindCollapseButton('btnGsrCollapse',           'gsrPanel', (collapsed) => {
      if (collapsed) {
        AppState.mouseOverCanvas = false;
        AppState.hoveredIndex = -1;
        if (AppState.scrubSource === 'graph') AppState.scrubSource = null;
        AppState.emit('scrub', { clear: true, source: 'graph' });
      }
    });
    GSREvents.bindCollapseButton('btnMapCollapse',           'mapPanel');
    GSREvents.bindCollapseButton('btnOsmEnrichmentCollapse', 'osmEnrichmentCard');
    GSREvents.bindCollapseButton('btnEnvCollapse',           'environmentalPanel');

    // ── SCR Events Table Sorting ────────────────────────────────────────────
    GSREvents.bindPeaksTableSort();

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
            console.warn(`Re-analysing track "${track.name}" failed:`, e);
          }
        });

        if (typeof GSRUI !== 'undefined') {
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
      // Ask via the shared notices layer; fall back to a no-op (rather than
      // silently clearing) if no notice layer is available.
      const proceed = (typeof GSRNotices !== 'undefined')
        ? await GSRNotices.dialog({
            title: 'Clear OSM Cache',
            message: 'Clear locally cached OpenStreetMap data? Future enrichment will re-fetch from the Overpass API.',
            buttons: [{ label: 'Clear', value: 'clear', style: 'danger' }],
            dismissLabel: 'Cancel',
            tone: 'warn',
          })
        : null;
      if (proceed !== 'clear') return;
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
        // Only the path's colour changes here — a full rerenderMap() also
        // destroys/rebuilds peak+hotspot markers for no reason (perf-routes
        // doc §2.2). Single-track view has a scoped path-only refresh;
        // collective mode still does the full rebuild (out of scope for
        // this pass — renderCollectiveData()'s per-track loop needs its own
        // investigation before a partial-render path is worth the risk).
        if (AppState.viewMode === 'single' && AppState.analyzer && AppState.analyzer.raw.length > 0) {
          GSRTrackManager.saveActiveGpsParams();
          AppState.mapManager.refreshPath(AppState.analyzer, GSRStorage.buildGpsParams());
        } else {
          GSRUI.rerenderMap();
        }
      }
      // Forward the metric change to the 3D globe immediately when it is the
      // active surface. Without this the globe only updates after the map emits
      // 'map:rendered' → 250ms debounce → full renderData rebuild. The
      // setColoringMetric() fast path avoids that wall-primitive teardown.
      if (g3d()) g3d().applyColorMetric(e.target.value);
    });

    const btnToggleOsmShapes = document.getElementById('btnToggleOsmShapes');
    btnToggleOsmShapes.addEventListener('click', () => {
      btnToggleOsmShapes.classList.toggle('active');
      const active = btnToggleOsmShapes.classList.contains('active');
      // On the 3D globe the OSM button toggles the extruded OSM buildings —
      // the 3D equivalent of the 2D vector shapes.
      if (onGlobe()) { if (g3d()) g3d().applyBuildings(active); return; }
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

    const btnToggleNdviLayer = document.getElementById('btnToggleNdviLayer');
    if (btnToggleNdviLayer) {
      btnToggleNdviLayer.addEventListener('click', () => {
        btnToggleNdviLayer.classList.toggle('active');
        const active = btnToggleNdviLayer.classList.contains('active');
        if (AppState.mapManager) {
          AppState.mapManager.toggleNdviLayer(active);
        }
      });
    }

    const btnSampleNdvi = document.getElementById('btnSampleNdvi');
    if (btnSampleNdvi) {
      btnSampleNdvi.addEventListener('click', () => GSRUI.sampleNdviTrack());
    }

    const copernicusInstanceInput = document.getElementById('copernicusInstanceId');
    const copernicusLayerInput = document.getElementById('copernicusLayerId');
    const copernicusTimeInput = document.getElementById('copernicusTimeRange');
    const syncCopernicusBadges = () => {
      const activeBadge = document.getElementById('copernicusActiveBadge');
      const defaultBadge = document.getElementById('copernicusDefaultBadge');
      const hasId = typeof NDVISampler !== 'undefined' ? NDVISampler.hasCopernicusConfig() : false;
      if (activeBadge) activeBadge.style.display = hasId ? 'inline-block' : 'none';
      if (defaultBadge) defaultBadge.style.display = hasId ? 'none' : 'inline-block';
    };

    if (copernicusInstanceInput && typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const savedInstance = localStorage.getItem('copernicus_instance_id');
      if (savedInstance) copernicusInstanceInput.value = savedInstance;
      copernicusInstanceInput.addEventListener('change', () => {
        if (typeof localStorage.setItem === 'function') {
          localStorage.setItem('copernicus_instance_id', copernicusInstanceInput.value.trim());
        }
        syncCopernicusBadges();
        if (AppState.mapManager && AppState.mapManager.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }
    if (copernicusLayerInput && typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const savedLayer = localStorage.getItem('copernicus_layer_id');
      if (savedLayer) copernicusLayerInput.value = savedLayer;
      copernicusLayerInput.addEventListener('change', () => {
        if (typeof localStorage.setItem === 'function') {
          localStorage.setItem('copernicus_layer_id', copernicusLayerInput.value.trim());
        }
        if (AppState.mapManager && AppState.mapManager.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }
    if (copernicusTimeInput && typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      const savedTime = localStorage.getItem('copernicus_time_range');
      if (savedTime) copernicusTimeInput.value = savedTime;
      copernicusTimeInput.addEventListener('change', () => {
        if (typeof localStorage.setItem === 'function') {
          localStorage.setItem('copernicus_time_range', copernicusTimeInput.value.trim());
        }
        if (AppState.mapManager && AppState.mapManager.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }

    const btnClearCreds = document.getElementById('btnClearCopernicusCreds');
    if (btnClearCreds) {
      btnClearCreds.addEventListener('click', () => {
        if (typeof NDVISampler !== 'undefined') NDVISampler.clearCredentials();
        if (copernicusInstanceInput) copernicusInstanceInput.value = '';
        if (copernicusLayerInput) copernicusLayerInput.value = 'VEGETATION_INDEX';
        if (copernicusTimeInput) copernicusTimeInput.value = '2024-05-01/2024-09-30';
        syncCopernicusBadges();
        if (AppState.mapManager && AppState.mapManager.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }

    syncCopernicusBadges();

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

      if (AppState.mapManager) {
        AppState.mapManager.clearCollectiveLayers();
      }
      appMainLayout.classList.remove('collective-mode');
      contourSettingsCard.style.display = 'none';
      collectiveOnlyMapBtns.forEach(btn => btn.style.display = 'none');

      const peakCard = document.getElementById('peakDetectionCard');
      if (peakCard) peakCard.style.display = '';

      const btnEnrich = document.getElementById('btnEnrichTrack');
      if (btnEnrich) btnEnrich.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Retrieve Spatial Data';

      document.getElementById('gsrPanel').style.display = '';
      document.getElementById('eventsPanel').style.display = '';

      // Force synchronous measurement of the new container size without panning the map
      if (AppState.mapManager && AppState.mapManager.map && typeof AppState.mapManager.map.invalidateSize === 'function') {
        AppState.mapManager.map.invalidateSize({ pan: false, debounceMoveend: true });
      }

      if (AppState.analyzer && AppState.analyzer.raw.length > 0) {
        windowResized();
        GSRUI.runAnalysis();
      } else {
        noLoop();
        GSRRenderer.drawPlaceholder();
        if (AppState.mapManager) AppState.mapManager.clearMap();
      }
      GSRUI.refreshOsmControls(); // resync OSM Layers button/indicator to the now-active single track
    });

    btnCollectiveView.addEventListener('click', () => {
      if (AppState.viewMode === 'collective') return;
      AppState.viewMode = 'collective';
      btnCollectiveView.classList.add('active');
      btnSingleView.classList.remove('active');

      // Collective mode only supports the 2D map. If the 3D globe was active,
      // revert to the 2D map surface immediately.
      if (typeof GSREvents.setSurface === 'function') {
        GSREvents.setSurface('map');
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

      // No graph to scrub in collective view — drop any scrub indicator left
      // over from single-track hover immediately.
      AppState.mouseOverCanvas = false;
      AppState.hoveredIndex = -1;
      AppState.scrubSource = null;
      AppState.emit('scrub', { clear: true });

      // Force synchronous measurement of the new expanded container dimensions without panning the map
      if (AppState.mapManager && AppState.mapManager.map && typeof AppState.mapManager.map.invalidateSize === 'function') {
        AppState.mapManager.map.invalidateSize({ pan: false, debounceMoveend: true });
      }

      // Render collective map immediately without 150ms debounce lag on mode swap
      if (typeof GSRUI !== 'undefined') {
        if (GSRUI._collectiveDebounceId) {
          clearTimeout(GSRUI._collectiveDebounceId);
          GSRUI._collectiveDebounceId = null;
        }
        if (typeof GSRUI._updateCollectiveMapNow === 'function') {
          GSRUI._updateCollectiveMapNow();
        } else if (typeof GSRUI.updateCollectiveMap === 'function') {
          GSRUI.updateCollectiveMap();
        }
        if (typeof GSRUI.refreshOsmControls === 'function') {
          GSRUI.refreshOsmControls();
        }
      }
    });
  },

  /**
   * Surface switcher (2D Map ↔ 3D Globe). Orthogonal to the Single/Collective
   * scope switcher above. Leaflet and Cesium are equivalent display engines
   * swapped inside the one #mapPanel: this toggles which container div is shown
   * (#map ⇄ #globe3dContainer) and reveals the 3D-only settings sub-section.
   * The header controls drive whichever engine is mounted; the globe is still a
   * read-only view of the 2D state — see src/map/globe3d_view.js.
   */
  bindSurfaceSwitcher() {
    const tabs = Array.from(document.querySelectorAll('.surface-tab'));
    if (!tabs.length) return;

    if (typeof GSRGlobe3DView !== 'undefined') GSRGlobe3DView.init();

    const mapEl     = document.getElementById('map');
    const globeEl   = document.getElementById('globe3dContainer');
    const settings3d = document.getElementById('mapDisplay3DGroup');
    const cameraBtns = [
      document.getElementById('g3dBtnOrbit'),
      document.getElementById('g3dBtnTour'),
      document.getElementById('g3dBtnPersp3D'),
      document.getElementById('g3dBtnPerspTop'),
      document.getElementById('g3dBtnNorth')
    ];
    const osmBtn    = document.getElementById('btnToggleOsmShapes');

    const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };

    const setSurface = (target) => {
      if (AppState.surfaceView === target) return;
      if (target === 'globe' && AppState.viewMode === 'collective') return;
      const toGlobe = target === 'globe';

      AppState.surfaceView = target;
      tabs.forEach(t => t.classList.toggle('active', t.dataset.surface === target));
      show(mapEl, !toGlobe);
      show(globeEl, toGlobe);
      show(settings3d, toGlobe);
      cameraBtns.forEach(btn => show(btn, toGlobe));

      // The OSM header button is ONE shared toggle: "2D vector shapes" on the
      // map, "3D OSM buildings" on the globe, same OSM data (see
      // GSRGlobe3DView.applyBuildings). Its .active state persists across the
      // swap — the incoming surface adopts it, it is not reset.
      //   → globe: GSRGlobe3DView.activate() shows the buildings if it's on.
      //   → map:   refreshOsmControls() re-shows the button and redraws the
      //            vector shapes if it's on.
      if (osmBtn) {
        if (toGlobe) {
          osmBtn.style.display = 'inline-block';
        } else if (typeof GSRUI !== 'undefined' && GSRUI.refreshOsmControls) {
          GSRUI.refreshOsmControls();
        }
      }

      if (typeof GSRGlobe3DView !== 'undefined') {
        if (toGlobe) GSRGlobe3DView.activate();
        else GSRGlobe3DView.deactivate();
      }

      if (!toGlobe && AppState.mapManager && AppState.mapManager.map && typeof AppState.mapManager.map.invalidateSize === 'function') {
        AppState.mapManager.map.invalidateSize({ pan: false, debounceMoveend: true });
        // A track loaded while the globe was up left its auto-fit deferred (the
        // hidden map can't be flown to) — frame it now that 2D is back.
        if (typeof AppState.mapManager._applyPendingFit === 'function') {
          AppState.mapManager._applyPendingFit();
        }
      }
    };

    GSREvents.setSurface = setSurface;
    tabs.forEach(t => t.addEventListener('click', () => setSurface(t.dataset.surface)));
  },

  /**
   * Export the active single track as the 3D extruded arousal ribbon (CZML or
   * KML), driven from the main Export Options panel — no live 3D viewer needed.
   * Uses the exact display points the 2D map drew (single-track scope only:
   * collective's merged drawPoints carry cross-analyzer indices), the map's
   * active colour metric, and the 3D extrusion slider's value.
   * @param {'czml'|'kml'} kind
   */
  export3DTrack(kind) {
    const analyzer = AppState.analyzer;
    const mm = AppState.mapManager;
    const drawPoints = (AppState.viewMode !== 'collective' && mm) ? mm._lastDrawPoints : null;
    if (!analyzer || !drawPoints || drawPoints.length < 2) {
      const msg = 'Load a single track with GPS data before exporting the 3D track.';
      if (typeof GSRNotices !== 'undefined') GSRNotices.warn(msg, 'export3d');
      else console.warn('[export3d]', msg);
      return;
    }
    const extEl = document.getElementById('g3dExtrusionScale');
    const opts = {
      metric: (mm && mm.activeColoringMetric) || 'phasic',
      extrusionScale: extEl ? parseFloat(extEl.value) : undefined
    };
    const baseName = (typeof GSRUI !== 'undefined' && typeof GSRUI._exportFilenameBase === 'function')
      ? GSRUI._exportFilenameBase()
      : 'biomapping_track';
    if (kind === 'kml') {
      GSRGlobe3DExport.download(
        GSRGlobe3DExport.buildKml(analyzer, drawPoints, opts),
        `${baseName}_3d.kml`, 'application/vnd.google-earth.kml+xml');
    } else {
      GSRGlobe3DExport.download(
        GSRGlobe3DExport.buildCzml(analyzer, drawPoints, opts),
        `${baseName}_3d.czml`, 'application/json');
    }
  },

  /**
   * Contour settings sliders.
   */
  bindContourInputs() {
    const triggerUpdate = GSREvents.rafCoalesce(() => {
      if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
    });

    const bindCi = (id, labelId, fmt) => {
      const input = document.getElementById(id);
      const label = document.getElementById(labelId);
      // Initial dim state — matters for hillshadeStrength specifically,
      // whose default is 0 ("off"); the others can never reach 0 (all have
      // min > 0), so this is a no-op for them.
      GSREvents.updateFilterDim(input);
      input.addEventListener('input', () => {
        if (label) label.innerText = fmt(parseFloat(input.value));
        // Without this, a slider that starts at 0 (only hillshadeStrength
        // does) stays marked filter-off — and visually greyed out — forever
        // after the very first initializeLabels() sweep, even once dragged
        // up to a nonzero value: this listener is the only place hillshade's
        // own dim state gets re-evaluated on drag (unlike bindGsrSlider/
        // bindGpsSlider, which call updateFilterDim from their own input
        // handlers already).
        GSREvents.updateFilterDim(input);
        triggerUpdate();
      });
    };

    bindCi('gridResolution',  'valGridResolution',  v => `${v} x ${v}`);
    bindCi('contourCount',    'valContourCount',    v => `${v} lines`);
    bindCi('isolationRadius', 'valIsolationRadius', v => `${v} m`);
    bindCi('idwExponent',     'valIdwExponent',     v => v.toFixed(1));
    bindCi('peakPreservation', 'valPeakPreservation', v => `${Math.round(v * 100)}%`);
    bindCi('coverageWeighting', 'valCoverageWeighting', v => `${Math.round(v * 100)}%`);
    bindCi('surfaceOpacity',  'valSurfaceOpacity',  v => `${Math.round(v * 100)}%`);
    bindCi('hillshadeStrength', 'valHillshadeStrength', v => `${Math.round(v * 100)}%`);

    const topoSource = document.getElementById('topoSource');
    topoSource.addEventListener('change', () => {
      GSREvents.updatePeakPreservationInertState();
      triggerUpdate();
    });
    GSREvents.updatePeakPreservationInertState();

    const normalizeZ = document.getElementById('normalizeZScore');
    if (normalizeZ) {
      normalizeZ.addEventListener('change', triggerUpdate);
    }
  },

  /**
   * Peak Preservation has no effect when the collective surface's topography
   * source is Peak Stress Hotspots (see generateContourSurface()'s
   * `topographySource !== 'peaks'` gate) — hide it entirely rather than
   * leaving an inert control on screen.
   */
  updatePeakPreservationInertState() {
    const topoSource = document.getElementById('topoSource');
    const group = document.getElementById('peakPreservationGroup');
    if (!topoSource || !group) return;
    group.style.display = topoSource.value === 'peaks' ? 'none' : '';
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
    updateLabel('peakDensityWindow', 'valPeakDensityWindow', ' s');
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
      updateCLabel('peakPreservation', 'valPeakPreservation', v => `${Math.round(v * 100)}%`);
      updateCLabel('coverageWeighting', 'valCoverageWeighting', v => `${Math.round(v * 100)}%`);
      updateCLabel('surfaceOpacity',  'valSurfaceOpacity',  v => `${Math.round(v * 100)}%`);
      updateCLabel('hillshadeStrength', 'valHillshadeStrength', v => `${Math.round(v * 100)}%`);

      const btnToggleMapSurface = document.getElementById('btnToggleMapSurface');
      const opacityGroup = document.getElementById('surfaceOpacityGroup');
      if (btnToggleMapSurface && opacityGroup) {
        opacityGroup.classList.toggle('ctrl-inert', !btnToggleMapSurface.classList.contains('active'));
      }

      GSREvents.updatePeakPreservationInertState();
    }

    // Sync dim state for all sliders across all control cards
    document.querySelectorAll('input[type="range"]').forEach(slider => GSREvents.updateFilterDim(slider));

    GSREvents.updateShapeSlidersForDetector();
    GSREvents.updateAdaptiveNotchUIState();
  },

  /**
   * Show/hide the morphology shape sliders (rise / half-recovery / skew) to
   * match the active peak detector. These bounds are meaningful for the
   * trough-to-peak detector only:
   *
   *   - Trough-to-peak (default): live — applied as rejection gates.
   *   - Combined (usePeakProminence): hidden. Identification is topographic
   *     prominence + SNR + quality, not morphology; _detectPeaksCombined()
   *     forces these bounds off so a hidden slider has no effect.
   *   - Deconvolution: hidden and pinned to the SCRF kernel's canonical shape —
   *     once the kernel is fixed, morphology isn't free to vary, so bounding a
   *     reconstructed peak against those numbers is meaningless.
   *
   * Min SNR and Min Peak Quality are NOT in this list — they are per-peak
   * properties, not shape constants, and stay live in every mode.
   */
  updateShapeSlidersForDetector() {
    const deconvCheckbox = document.getElementById('useDeconvolution');
    const useDeconv = deconvCheckbox ? deconvCheckbox.checked : false;
    const promCheckbox = document.getElementById('usePeakProminence');
    const useCombined = promCheckbox ? promCheckbox.checked : false;
    // Neither alternative detector uses the morphology sliders — hide them in
    // both modes. Deconvolution additionally pins them to canonical kernel
    // values (so a stale number can't be persisted via readGsrSliderValues());
    // the combined detector forces them off in the analyzer, so its slider
    // values are simply never read.
    const hideShape = useDeconv || useCombined;

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
        slider.disabled = hideShape;
        if (useDeconv) {
          // Cache custom user setting before overwriting
          if (slider.dataset.customValue === undefined) {
            slider.dataset.customValue = slider.value;
          }
          slider.value = s.canonicalValue;
        } else if (!hideShape) {
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
        group.style.display = hideShape ? 'none' : '';
      }
      if (label) {
        if (useDeconv) {
          label.innerText = s.canonical;
        } else if (useCombined) {
          label.innerText = 'not used';
        } else if (slider) {
          const val = parseFloat(slider.value);
          const step = parseFloat(slider.step) || 0.1;
          const decimals = step < 0.1 ? 2 : 1;
          label.innerText = val === 0 ? 'off' : val.toFixed(decimals) + (s.suffix || '');
        }
      }
    });
  },

  updateAdaptiveNotchUIState() {
    const adaptiveCheckbox = document.getElementById('adaptiveNotch');
    const isAdaptive = adaptiveCheckbox ? adaptiveCheckbox.checked : false;

    const lpfSlider = document.getElementById('lpfWindow');
    const lpfLabel = document.getElementById('valLpfWindow');
    const lpfGroup = lpfSlider ? lpfSlider.closest('.slider-group') : null;

    if (lpfSlider) {
      lpfSlider.disabled = isAdaptive;
    }
    if (lpfGroup) {
      lpfGroup.classList.toggle('ctrl-inert', isAdaptive);
    }
    if (lpfLabel) {
      if (isAdaptive) {
        lpfLabel.innerText = 'auto';
      } else if (lpfSlider) {
        const val = parseFloat(lpfSlider.value);
        lpfLabel.innerText = val === 0 ? 'off' : val.toFixed(1) + ' s';
      }
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSREvents };
}
if (typeof window !== 'undefined') {
  window.GSREvents = GSREvents;
}
