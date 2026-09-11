/**
 * DOM Element Caching, Event Binding, and UI Initialization.
 * Extracted from ui.js — handles all slider/button/toggle wiring.
 */

/**
 * Slider value-label descriptors — the single source of truth for how each
 * slider's live value is rendered next to it. Consumed both by the bind*
 * handlers (label updates during a drag) and by initializeLabels() (initial
 * paint + post-preset resync), so the two can never drift apart.
 *
 * GSR sliders share one formatting rule (see GSREvents._gsrLabelText); GPS and
 * contour sliders each carry an explicit `fmt(value) -> string`.
 */
const GSR_SLIDER_DEFS = [
  { id: 'medianSize',        labelId: 'valMedianSize',        suffix: ' s' },
  { id: 'lpfWindow',         labelId: 'valLpfWindow',         suffix: ' s' },
  { id: 'tonicWindow',       labelId: 'valTonicWindow',       suffix: ' s' },
  { id: 'peakThreshold',     labelId: 'valPeakThreshold',     suffix: ' μS' },
  { id: 'minPeakQuality',    labelId: 'valMinPeakQuality',    suffix: '' },
  { id: 'hotspotPercentile', labelId: 'valHotspotPercentile', suffix: ' %' },
  { id: 'shapeMinSnr',       labelId: 'valShapeMinSnr',       suffix: '×' },
];

// `bindGps: true` entries are wired by bindGpsSlider() in setupEventListeners();
// the rest (peak latency, snap radius, place-merge distance) keep bespoke event
// wiring elsewhere but still take their formatter from here.
const GPS_SLIDER_DEFS = [
  { id: 'gpsSmoothing',       labelId: 'valGpsSmoothing',       fmt: v => v.toFixed(2),                bindGps: true },
  { id: 'gpsKalmanR',         labelId: 'valGpsKalmanR',         fmt: v => `${v} m²`,                   bindGps: true },
  { id: 'gpsMaxHdop',         labelId: 'valGpsMaxHdop',         fmt: v => `≤ ${v.toFixed(1)}`,         bindGps: true },
  { id: 'gpsMaxSpeed',        labelId: 'valGpsMaxSpeed',        fmt: v => GSREvents.fmtMaxSpeed(v),    bindGps: true },
  { id: 'gpsRDP',             labelId: 'valGpsRDP',             fmt: v => v === 0 ? 'off' : `${v} m`,  bindGps: true },
  { id: 'gpsTrackWeight',     labelId: 'valGpsTrackWeight',     fmt: v => `${v} px`,                   bindGps: true },
  { id: 'gpsPeakLatency',     labelId: 'valGpsPeakLatency',     fmt: v => `${v.toFixed(1)} s` },
  { id: 'gpsSnapRadius',      labelId: 'valGpsSnapRadius',      fmt: v => `${v} m` },
  { id: 'placeMergeDistance', labelId: 'valPlaceMergeDistance', fmt: v => `${v} m` },
];

const CONTOUR_SLIDER_DEFS = [
  { id: 'gridResolution',    labelId: 'valGridResolution',    fmt: v => `${v} x ${v}` },
  { id: 'contourCount',      labelId: 'valContourCount',      fmt: v => `${v} lines` },
  { id: 'isolationRadius',   labelId: 'valIsolationRadius',   fmt: v => `${v} m` },
  { id: 'idwExponent',       labelId: 'valIdwExponent',       fmt: v => v.toFixed(1) },
  { id: 'peakPreservation',  labelId: 'valPeakPreservation',  fmt: v => `${Math.round(v * 100)}%` },
  { id: 'coverageWeighting', labelId: 'valCoverageWeighting', fmt: v => `${Math.round(v * 100)}%` },
  { id: 'surfaceOpacity',    labelId: 'valSurfaceOpacity',    fmt: v => `${Math.round(v * 100)}%` },
  { id: 'hillshadeStrength', labelId: 'valHillshadeStrength', fmt: v => `${Math.round(v * 100)}%` },
];

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
      'medianSize', 'lpfWindow', 'tonicWindow', 'tonicMethod', 'peakThreshold', 'minPeakQuality', 'hotspotPercentile',
      'shapeMinSnr',
      'gpsSmoothing', 'gpsKalmanR', 'gpsMaxHdop', 'gpsMaxSpeed', 'gpsRDP', 'gpsTrackWeight', 'gpsPeakLatency',
      'gpsSnapToRoads', 'gpsSnapRadius',
      'placeMergeDistance',
      'graphView', 'useDeconvolution', 'usePeakProminence', 'useCvxEDA'
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
   * Bind clickable `<th class="sortable">` headers on a results table to the
   * matching GSRUI sort handler. Used by the SCR Events, Correlation Matrix and
   * Road Arousal tables — identical wiring, only the table id and handler differ.
   */
  bindTableSort(tableId, sortMethod) {
    const table = document.getElementById(tableId);
    if (!table) return;
    table.querySelectorAll('thead th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (col && typeof GSRUI !== 'undefined' && typeof GSRUI[sortMethod] === 'function') {
          GSRUI[sortMethod](col);
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
   * Format the Max Speed slider value with a human travel mode.
   * Thresholds follow the slider's help text: Walk ≈ 3 m/s, Run ≈ 5 m/s,
   * Bike ≈ 10 m/s.
   */
  fmtMaxSpeed(v) {
    const mode = v <= 3.5 ? 'Walk' : v <= 6.5 ? 'Run' : 'Bike';
    return `${v.toFixed(1)} m/s (${mode})`;
  },

  /**
   * Show the Snap Radius slider only while "Snap to Roads & Trails" is checked.
   * Called on setup, from the toggle handler, and after settings restore.
   */
  updateSnapRadiusVisibility() {
    const toggle = document.getElementById('gpsSnapToRoads');
    const group  = document.getElementById('snapRadiusGroup');
    if (group) group.style.display = (toggle && toggle.checked) ? '' : 'none';
  },

  /**
   * Look up a slider descriptor by element id across the GSR / GPS / contour
   * tables. Lets the few bespoke binding blocks (snap radius, peak latency,
   * arousal-places merge) pull their formatter from the same source as
   * initializeLabels() instead of re-declaring it inline.
   */
  _sliderDef(id) {
    return GSR_SLIDER_DEFS.find(d => d.id === id)
      || GPS_SLIDER_DEFS.find(d => d.id === id)
      || CONTOUR_SLIDER_DEFS.find(d => d.id === id);
  },

  /**
   * Render a GSR slider's value label: "off" at 0, otherwise the value with its
   * unit suffix. Decimal places follow the slider's own step — a sub-0.1 step
   * gets 2 dp, a μS slider 3 dp, everything else 1 dp. Shared by bindGsrSlider
   * (live drag) and initializeLabels (initial / post-preset) so they agree.
   */
  _gsrLabelText(slider, suffix) {
    const val = parseFloat(slider.value);
    const step = parseFloat(slider.step) || 0.1;
    const decimals = step < 0.1 ? 2 : (suffix.includes('μS') ? 3 : 1);
    return val === 0 ? 'off' : val.toFixed(decimals) + suffix;
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
      label.innerText = GSREvents._gsrLabelText(slider, suffix);
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
   * Bind the "Place Merge Distance" slider (#placeMergeDistance). Unlike the
   * generic GPS sliders it does NOT trigger a full rerenderMap() — the merge
   * distance only reshapes the Arousal Places layer, so a scoped
   * mapManager.refreshArousalPlaces() rebuilds just that (perf-routes doc
   * SS2.2), leaving path/peak/hotspot/contour layers alone. Still persists the
   * value via saveActiveGpsParams() (it rides in gpsFilterParams / the project
   * file). Falls back to rerenderMap() if the scoped method is unavailable.
   */
  bindArousalPlacesSlider(id, labelId, fmt) {
    const slider = document.getElementById(id);
    const label  = document.getElementById(labelId);
    if (!slider) return;
    const updateDim = () => GSREvents.updateFilterDim(slider);
    updateDim();

    const runRefresh = GSREvents.rafCoalesce(() => {
      if (typeof GSRTrackManager !== 'undefined') {
        GSRTrackManager.saveActiveGpsParams();
        GSRTrackManager.renderTrackList();
      }
      const mm = AppState.mapManager;
      if (mm && typeof mm.refreshArousalPlaces === 'function') {
        mm.refreshArousalPlaces();
      } else {
        GSRUI.rerenderMap();
      }
    });

    slider.addEventListener('input', () => {
      if (label) label.innerText = fmt(parseFloat(slider.value));
      updateDim();
      runRefresh();
    });
  },

  /**
   * Reconfigure the Tonic Baseline Window slider (range, default, help text)
   * for the selected baseline method.
   */
  updateTonicMethodLayout(isInitial = false) {
    const S = AppState.sliders;
    if (!S || !S.tonicMethod) return;

    const method = S.tonicMethod.value;
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
    } else { // 'lpf' / 'ema'
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
  },

  /**
   * cvxEDA re-estimates the tonic baseline jointly with the phasic fit and
   * overwrites whatever the Baseline Method produced, so that dropdown and the
   * Tonic Baseline Window slider are inert while cvxEDA is the active detector.
   * Grey them out (and disable interaction) to say so; every other mode —
   * including the matching-pursuit deconvolution path, which still subtracts
   * this baseline — leaves them live.
   */
  syncTonicBaselineControls() {
    const S = AppState.sliders;
    if (!S || !S.tonicMethod) return;
    const cvx = !!(S.useCvxEDA && S.useCvxEDA.checked);

    S.tonicMethod.disabled = cvx;
    const win = document.getElementById('tonicWindow');
    if (win) win.disabled = cvx;

    const methodGroup = document.getElementById('tonicMethodGroup');
    const winGroup = document.getElementById('tonicWindowGroup');
    if (methodGroup) methodGroup.classList.toggle('ctrl-inert', cvx);
    if (winGroup) winGroup.classList.toggle('ctrl-inert', cvx);

    const note = document.getElementById('tonicMethodHelp');
    if (note) note.hidden = !cvx;
  },

  /**
   * Apply the current #graphView selection: mirror it into AppState.graphView
   * (and arm it as lowerGraphMode when it's a metric view), show the
   * Raw/Filtered/Tonic/Phasic layer buttons only in 'signal' view, and redraw.
   * Called on 'change', once at wire-up, and by
   * GSRUI.syncGraphViewDetectorOptions() when it forces the selection back to
   * 'signal' after the driver series goes away.
   */
  applyGraphView() {
    const S = AppState.sliders;
    if (!S || !S.graphView) return;
    const v = S.graphView.value;
    AppState.graphView = v;
    if (v !== 'signal') AppState.lowerGraphMode = v;
    const showLayerBtns = (v === 'signal');
    for (const id of ['btnToggleRaw', 'btnToggleFiltered', 'btnToggleTonic', 'btnTogglePhasic']) {
      const b = document.getElementById(id);
      if (b) b.style.display = showLayerBtns ? '' : 'none';
    }
    redraw();
  },

  /**
   * Wire up all UI event listeners (sliders, file drop, buttons, toggles, panels).
   */
  setupEventListeners() {
    const S = AppState.sliders;

    // ── GSR slider bindings ──────────────────────────────────────────────────
    GSR_SLIDER_DEFS.forEach(d => GSREvents.bindGsrSlider(d.id, d.labelId, d.suffix));

    S.tonicMethod.addEventListener('change', () => {
      GSREvents.updateTonicMethodLayout(false);
      GSRUI.runAnalysis();
    });

    // ── Alternative-detector toggles (Prominence / Deconv / cvxEDA) ─────────
    // Mutually exclusive: analyze() only ever runs one detector, so turning one
    // alternative ON forces the others OFF (setting .checked in code does not
    // re-fire 'change', so no loop). Turning all OFF drops back to the default
    // full-scan detector. Each re-runs the full pipeline.
    const detectorToggles = ['usePeakProminence', 'useDeconvolution', 'useCvxEDA'];
    detectorToggles.forEach(id => {
      if (!S[id]) return;
      S[id].addEventListener('change', () => {
        if (S[id].checked) {
          detectorToggles.forEach(other => {
            if (other !== id && S[other]) S[other].checked = false;
          });
        }
        GSREvents.syncTonicBaselineControls();
        GSRUI.runAnalysis();
      });
    });
    GSREvents.syncTonicBaselineControls(); // initial state

    // ── Graph view selector ─────────────────────────────────────────────────
    // Rendering-only setting (no re-analysis needed). One dropdown picks the
    // whole plot: 'signal' or a single derived metric. Choosing a metric view
    // also arms it as lowerGraphMode. The Raw/Filtered/Tonic/Phasic curve
    // toggles are only meaningful in 'signal' view, so hide them otherwise.
    if (S.graphView) {
      GSREvents.applyGraphView();
      S.graphView.addEventListener('change', () => GSREvents.applyGraphView());
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
    GPS_SLIDER_DEFS.filter(d => d.bindGps)
      .forEach(d => GSREvents.bindGpsSlider(d.id, d.labelId, d.fmt));

    // ── Arousal Places slider binding ───────────────────────────────────────
    // Scoped refresh (Arousal Places layer only), not a full rerenderMap().
    {
      const d = GSREvents._sliderDef('placeMergeDistance');
      GSREvents.bindArousalPlacesSlider(d.id, d.labelId, d.fmt);
    }

    // ── Snap radius slider ───────────────────────────────────────────────────
    // Re-evaluates road snapping locally from cached OSM data when released.
    {
      const slider = document.getElementById('gpsSnapRadius');
      const label  = document.getElementById('valGpsSnapRadius');
      if (slider && label) {
        const fmt = GSREvents._sliderDef('gpsSnapRadius').fmt;
        const updateDim = () => GSREvents.updateFilterDim(slider);
        updateDim();
        slider.addEventListener('input', () => {
          label.innerText = fmt(parseFloat(slider.value));
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
        GSREvents.updateSnapRadiusVisibility();
        snapToggle.addEventListener('change', () => {
          GSREvents.updateSnapRadiusVisibility();
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

    // ── OSM graph background bands toggle ────────────────────────────────────
    {
      const osmBandsToggle = document.getElementById('showOsmGraphBands');
      if (osmBandsToggle) {
        osmBandsToggle.checked = !!AppState.showOsmContext;
        osmBandsToggle.addEventListener('change', () => {
          AppState.showOsmContext = osmBandsToggle.checked;
          if (typeof redraw === 'function') redraw();
        });
      }
    }


    // Peak latency — re-render map only (no analysis needed)
    {
      const slider = document.getElementById('gpsPeakLatency');
      const label  = document.getElementById('valGpsPeakLatency');
      const fmt = GSREvents._sliderDef('gpsPeakLatency').fmt;
      const updateDim = () => {
        GSREvents.updateFilterDim(slider);
      };
      updateDim();
      const runHeavyWork = GSREvents.rafCoalesce(() => {
        GSRUI.rerenderMap();
        if (typeof GSRUI !== 'undefined' && typeof GSRUI.updateEnvironmentalDashboard === 'function') {
          GSRUI.updateEnvironmentalDashboard();
        }
      });
      slider.addEventListener('input', () => {
        label.innerText = fmt(parseFloat(slider.value));
        updateDim();
        runHeavyWork();
      });
    }

    // ── View Switcher ────────────────────────────────────────────────────────
    GSREvents.bindViewSwitcher();
    GSREvents.bindSurfaceSwitcher();
    GSREvents.bindMobileSidebar();

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
    // The map panel's height now also tracks whether the GSR graph and events
    // table are collapsed: with the graph gone the map flex-grows to fill the
    // freed vertical space (see `#gsrPanel.collapsed ~ #mapPanel` in styles.css).
    // Collapsing a panel fires no resize event, so nudge Leaflet and the p5
    // canvas once the CSS max-height transition has settled.
    const refreshMapAfterPanelResize = () => {
      if (AppState.mapManager && AppState.mapManager.map && typeof AppState.mapManager.map.invalidateSize === 'function') {
        AppState.mapManager.map.invalidateSize({ pan: false, debounceMoveend: true });
      }
      if (typeof windowResized === 'function') {
        requestAnimationFrame(() => windowResized());
        setTimeout(() => windowResized(), 320);
      }
    };

    GSREvents.bindCollapseButton('btnEventsCollapse',        'eventsPanel', refreshMapAfterPanelResize);
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
      // Collapsing/expanding the graph resizes the map (see the CSS rule above).
      refreshMapAfterPanelResize();
    });
    GSREvents.bindCollapseButton('btnMapCollapse',           'mapPanel', () => {
      const mapPanel = document.getElementById('mapPanel');
      if (mapPanel) delete mapPanel.dataset.autoCollapsedNoSpatial;
      refreshMapAfterPanelResize();
    });
    GSREvents.bindCollapseButton('btnOsmEnrichmentCollapse', 'osmEnrichmentCard');
    GSREvents.bindCollapseButton('btnEnvCollapse',           'environmentalPanel');

    // ── Table Column Sorting ────────────────────────────────────────────────
    GSREvents.bindTableSort('peaksTable',       'sortPeaksTable');
    GSREvents.bindTableSort('correlationTable', 'sortCorrelationTable');
    GSREvents.bindTableSort('roadArousalTable', 'sortRoadArousalTable');

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
        if (typeof NDVISampler !== 'undefined' && typeof NDVISampler.clearCache === 'function') {
          NDVISampler.clearCache();
        }
        alert('OSM and satellite tile cache cleared.');
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

    // The OSM overlay (2D vector shapes / 3D extruded buildings) is one shared
    // toggle. The click only flips the intent — GSRUI.setOsmOverlay records it,
    // fetches the geometry on demand the first time (shared OsmCache), and
    // GSRUI.syncOsmOverlay renders it on whichever surface is mounted.
    const btnToggleOsmShapes = document.getElementById('btnToggleOsmShapes');
    btnToggleOsmShapes.addEventListener('click', () => {
      GSRUI.setOsmOverlay(!GSRUI._osmOverlayOn);
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
    const copernicusRawLayerInput = document.getElementById('copernicusRawLayerId');
    const copernicusTimeInput = document.getElementById('copernicusTimeRange');
    const syncCopernicusBadges = () => {
      const activeBadge = document.getElementById('copernicusActiveBadge');
      const defaultBadge = document.getElementById('copernicusDefaultBadge');
      const hasId = typeof NDVISampler !== 'undefined' ? NDVISampler.hasCopernicusConfig() : false;
      if (activeBadge) activeBadge.style.display = hasId ? 'inline-block' : 'none';
      if (defaultBadge) defaultBadge.style.display = hasId ? 'none' : 'inline-block';
    };

    if (copernicusInstanceInput) {
      const activeId = typeof NDVISampler !== 'undefined' ? NDVISampler.getInstanceId() : '';
      if (activeId) copernicusInstanceInput.value = activeId;
      copernicusInstanceInput.addEventListener('change', () => {
        if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
          localStorage.setItem('copernicus_instance_id', copernicusInstanceInput.value.trim());
        }
        syncCopernicusBadges();
        if (AppState.mapManager && AppState.mapManager.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }
    if (copernicusRawLayerInput) {
      const activeRawLayer = typeof NDVISampler !== 'undefined' ? NDVISampler.getRawLayerId() : 'NDVI_RAW';
      if (activeRawLayer) copernicusRawLayerInput.value = activeRawLayer;
      copernicusRawLayerInput.addEventListener('change', () => {
        if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
          localStorage.setItem('copernicus_raw_layer_id', copernicusRawLayerInput.value.trim());
        }
        // The map overlay renders this same raw layer directly (see
        // map_manager_osm.js: showNdviLayer) — re-render it if visible.
        if (AppState.mapManager && AppState.mapManager.ndviTileLayer) {
          AppState.mapManager.showNdviLayer();
        }
      });
    }
    if (copernicusTimeInput) {
      const activeTime = typeof NDVISampler !== 'undefined' ? NDVISampler.getTimeRange() : '2024-05-01/2024-09-30';
      if (activeTime) copernicusTimeInput.value = activeTime;
      copernicusTimeInput.addEventListener('change', () => {
        if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
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
        if (copernicusRawLayerInput) copernicusRawLayerInput.value = 'NDVI_RAW';
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
    const btnLiveView        = document.getElementById('btnLiveView');
    const livePanel          = document.getElementById('livePanel');
    const appMainLayout      = document.querySelector('.main-layout');
    const contourSettingsCard = document.getElementById('contourSettingsCard');

    // Leaving the Live view: drop the layout class and the tab highlight, and
    // let the live controller stand down (pause its redraw loop). It stays
    // mounted — an active BLE session and the accumulated packets are
    // untouched — so re-entering just resumes.
    const exitLiveView = () => {
      appMainLayout.classList.remove('live-mode');
      if (btnLiveView) btnLiveView.classList.remove('active');
      // Restore the mobile hamburger — there are controls to reach again.
      const sbToggle = document.getElementById('btnSidebarToggle');
      if (sbToggle) sbToggle.hidden = false;
      // Drop the edge-to-edge display mode (F) if it was left on.
      if (typeof GSRLayoutManager !== 'undefined' && GSRLayoutManager._liveDisplayModeActive &&
          GSRLayoutManager._liveDisplayModeActive()) {
        GSRLayoutManager.exitLiveDisplayMode();
      }
      // deactivate() now also drops the BLE link (keeping the session buffer)
      // — see GSRLiveView.deactivate()'s doc comment.
      if (typeof GSRLiveView !== 'undefined' && GSRLiveView._mounted) {
        GSRLiveView.deactivate();
      }
    };

    // Collective-only map toggle buttons (multi-track contour surface) —
    // meaningless in single-track view, so hidden there. See index.html.
    const collectiveOnlyMapBtns = [
      document.getElementById('btnToggleMapIsolines'),
      document.getElementById('btnToggleMapSurface'),
      document.getElementById('btnToggleMapTracks')
    ].filter(Boolean);

    // The map-header metric dropdown has no per-track path colouring to drive
    // in collective view, so it is swapped there for #topoSource (the contour
    // surface's Topography Source). Exactly one of the two is visible per mode.
    const mapColoringMetric = document.getElementById('mapColoringMetric');
    const topoSourceSelect = document.getElementById('topoSource');
    const setHeaderMetricControl = (mode) => {
      if (mapColoringMetric) mapColoringMetric.style.display = mode === 'collective' ? 'none' : '';
      if (topoSourceSelect) topoSourceSelect.style.display = mode === 'collective' ? '' : 'none';
    };
    setHeaderMetricControl(AppState.viewMode);

    btnSingleView.addEventListener('click', () => {
      if (AppState.viewMode === 'single') return;
      AppState.viewMode = 'single';
      exitLiveView();
      btnSingleView.classList.add('active');
      btnCollectiveView.classList.remove('active');

      if (AppState.mapManager) {
        AppState.mapManager.clearCollectiveLayers();
      }
      appMainLayout.classList.remove('collective-mode');
      contourSettingsCard.style.display = 'none';
      collectiveOnlyMapBtns.forEach(btn => btn.style.display = 'none');
      setHeaderMetricControl('single');

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
      exitLiveView();
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
      setHeaderMetricControl('collective');

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

    if (btnLiveView) {
      btnLiveView.addEventListener('click', () => {
        if (AppState.viewMode === 'live') return;
        AppState.viewMode = 'live';
        btnLiveView.classList.add('active');
        btnSingleView.classList.remove('active');
        btnCollectiveView.classList.remove('active');

        appMainLayout.classList.remove('collective-mode');
        appMainLayout.classList.add('live-mode');
        contourSettingsCard.style.display = 'none';
        collectiveOnlyMapBtns.forEach(btn => btn.style.display = 'none');

        // Live mode hides the sidebar entirely, so close the mobile drawer and
        // hide its hamburger — there is nothing behind it to open.
        appMainLayout.classList.remove('sidebar-open');
        const sbToggle = document.getElementById('btnSidebarToggle');
        if (sbToggle) {
          sbToggle.hidden = true;
          sbToggle.setAttribute('aria-expanded', 'false');
        }

        // Build the live UI into #livePanel on first open (idempotent) — its
        // BLE / geolocation code stays dormant until the user acts inside it —
        // then activate() every time: resume the redraw loop if a session is
        // live and re-measure the Leaflet map, which may have been sized while
        // the panel was hidden. mount() must run after the panel is displayed
        // (live-mode class above) so that measurement is correct on first open.
        if (livePanel && typeof GSRLiveView !== 'undefined') {
          GSRLiveView.mount(livePanel);
          GSRLiveView.activate();
        }

        // Nothing on the main canvas to draw while the live view owns the area.
        noLoop();
      });
    }
  },

  /**
   * Mobile sidebar drawer. On phones (≤768px, see styles.css) the control
   * sidebar is an off-canvas drawer instead of a full-height column that
   * shoves the map / Live view off the bottom of the page. This wires the
   * hamburger (#btnSidebarToggle) and the scrim (#sidebarBackdrop) to the
   * `.sidebar-open` class on `.main-layout`. The CSS is a no-op on desktop,
   * so these listeners are harmless there.
   */
  bindMobileSidebar() {
    const btn      = document.getElementById('btnSidebarToggle');
    const layout   = document.querySelector('.main-layout');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (!btn || !layout) return;

    const setOpen = (open) => {
      layout.classList.toggle('sidebar-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    btn.addEventListener('click', () => {
      setOpen(!layout.classList.contains('sidebar-open'));
    });
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));

    // Esc closes the drawer, matching the app's other overlays.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && layout.classList.contains('sidebar-open')) {
        setOpen(false);
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
    const mapDisplayCard = document.getElementById('mapDisplayCard');
    const cameraBtns = [
      document.getElementById('g3dBtnOrbit'),
      document.getElementById('g3dBtnTour'),
      document.getElementById('g3dBtnPersp3D'),
      document.getElementById('g3dBtnPerspTop'),
      document.getElementById('g3dBtnNorth')
    ];
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

      // The Map Display card ships collapsed; switching to the globe reveals the
      // 3D-only settings inside it, so expand it once so they aren't stranded
      // behind a collapsed header. Never auto-recollapses — the user's call.
      if (toGlobe && mapDisplayCard) mapDisplayCard.classList.remove('collapsed');

      if (typeof GSRGlobe3DView !== 'undefined') {
        if (toGlobe) GSRGlobe3DView.activate();
        else GSRGlobe3DView.deactivate();
      }

      // Re-render the shared OSM overlay on the now-mounted surface. 2D takes
      // effect immediately; the globe re-syncs from GSRGlobe3DView.activate()
      // once its manager is built (its manager isn't ready yet here).
      if (typeof GSRUI !== 'undefined' && GSRUI.syncOsmOverlay) GSRUI.syncOsmOverlay();

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

    CONTOUR_SLIDER_DEFS.forEach(d => bindCi(d.id, d.labelId, d.fmt));

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
    // GSR value labels (shared "off"/decimals/suffix rule — see _gsrLabelText).
    for (const d of GSR_SLIDER_DEFS) {
      const slider = document.getElementById(d.id);
      const label  = document.getElementById(d.labelId);
      if (slider && label) label.innerText = GSREvents._gsrLabelText(slider, d.suffix);
    }

    // Initial tonic method layout and visibility setup (preserving saved settings value)
    GSREvents.updateTonicMethodLayout(true);

    // GPS value labels (per-slider formatter from GPS_SLIDER_DEFS).
    for (const d of GPS_SLIDER_DEFS) {
      const slider = document.getElementById(d.id);
      const label  = document.getElementById(d.labelId);
      if (slider && label) label.innerText = d.fmt(parseFloat(slider.value));
    }

    // Snap Radius slider is only shown while road-snapping is enabled
    GSREvents.updateSnapRadiusVisibility();

    // Sync OSM graph background overlay checkbox
    const osmBandsToggle = document.getElementById('showOsmGraphBands');
    if (osmBandsToggle) osmBandsToggle.checked = !!AppState.showOsmContext;

    // Contour Settings Labels & Visibility Setup
    const C = AppState.contourControls;
    if (C && C.gridResolution) {
      const updateCLabel = (d) => {
        const input = document.getElementById(d.id);
        const label = document.getElementById(d.labelId);
        if (input && label) label.innerText = d.fmt(parseFloat(input.value));
      };
      CONTOUR_SLIDER_DEFS.forEach(updateCLabel);

      const btnToggleMapSurface = document.getElementById('btnToggleMapSurface');
      const opacityGroup = document.getElementById('surfaceOpacityGroup');
      if (btnToggleMapSurface && opacityGroup) {
        opacityGroup.classList.toggle('ctrl-inert', !btnToggleMapSurface.classList.contains('active'));
      }

      GSREvents.updatePeakPreservationInertState();
    }

    // Sync dim state for all sliders across all control cards
    document.querySelectorAll('input[type="range"]').forEach(slider => GSREvents.updateFilterDim(slider));
  },

};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSREvents };
}
if (typeof window !== 'undefined') {
  window.GSREvents = GSREvents;
}
