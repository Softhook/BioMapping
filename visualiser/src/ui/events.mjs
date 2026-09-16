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
import { AppState } from '../core/app_state.mjs';
import { GSRLayoutManager } from '../core/layout_manager.mjs';
import { GSRTrackManager } from './tracks.mjs';
import { GSRUI } from './ui.mjs';

export const GSR_SLIDER_DEFS = [
  { id: 'medianSize', labelId: 'valMedianSize', suffix: ' s' },
  { id: 'lpfWindow', labelId: 'valLpfWindow', suffix: ' s' },
  { id: 'tonicWindow', labelId: 'valTonicWindow', suffix: ' s' },
  { id: 'peakThreshold', labelId: 'valPeakThreshold', suffix: ' μS' },
  { id: 'minPeakQuality', labelId: 'valMinPeakQuality', suffix: '' },
  { id: 'hotspotPercentile', labelId: 'valHotspotPercentile', suffix: ' %' },
  { id: 'shapeMinSnr', labelId: 'valShapeMinSnr', suffix: '×' },
];

// `bindGps: true` entries are wired by bindGpsSlider() in setupEventListeners();
// the rest (peak latency, snap radius, place-merge distance) keep bespoke event
// wiring elsewhere but still take their formatter from here.
export const GPS_SLIDER_DEFS = [
  {
    id: 'gpsSmoothing',
    labelId: 'valGpsSmoothing',
    fmt: (v) => v.toFixed(2),
    bindGps: true,
  },
  {
    id: 'gpsKalmanR',
    labelId: 'valGpsKalmanR',
    fmt: (v) => `${v} m²`,
    bindGps: true,
  },
  {
    id: 'gpsMaxHdop',
    labelId: 'valGpsMaxHdop',
    fmt: (v) => `≤ ${v.toFixed(1)}`,
    bindGps: true,
  },
  {
    id: 'gpsMaxSpeed',
    labelId: 'valGpsMaxSpeed',
    fmt: (v) => GSREvents.fmtMaxSpeed(v),
    bindGps: true,
  },
  {
    id: 'gpsRDP',
    labelId: 'valGpsRDP',
    fmt: (v) => (v === 0 ? 'off' : `${v} m`),
    bindGps: true,
  },
  {
    id: 'gpsTrackWeight',
    labelId: 'valGpsTrackWeight',
    fmt: (v) => `${v} px`,
    bindGps: true,
  },
  {
    id: 'gpsPeakLatency',
    labelId: 'valGpsPeakLatency',
    fmt: (v) => `${v.toFixed(1)} s`,
  },
  { id: 'gpsSnapRadius', labelId: 'valGpsSnapRadius', fmt: (v) => `${v} m` },
  {
    id: 'placeMergeDistance',
    labelId: 'valPlaceMergeDistance',
    fmt: (v) => `${v} m`,
  },
  {
    id: 'maxArousalPlaces',
    labelId: 'valMaxArousalPlaces',
    fmt: (v) => `${Math.round(v)}`,
  },
];

export const CONTOUR_SLIDER_DEFS = [
  {
    id: 'gridResolution',
    labelId: 'valGridResolution',
    fmt: (v) => `${v} x ${v}`,
  },
  { id: 'contourCount', labelId: 'valContourCount', fmt: (v) => `${v} lines` },
  {
    id: 'isolationRadius',
    labelId: 'valIsolationRadius',
    fmt: (v) => `${v} m`,
  },
  { id: 'idwExponent', labelId: 'valIdwExponent', fmt: (v) => v.toFixed(1) },
  {
    id: 'peakPreservation',
    labelId: 'valPeakPreservation',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  {
    id: 'coverageWeighting',
    labelId: 'valCoverageWeighting',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  {
    id: 'surfaceOpacity',
    labelId: 'valSurfaceOpacity',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  {
    id: 'hillshadeStrength',
    labelId: 'valHillshadeStrength',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
];

/**
 * Graph background-band overlay toggles (OSM context, NDVI, EM Fog, ...) —
 * checkbox id + the AppState flag it mirrors. One shared table so wiring
 * (bindLabelsAndListeners) and the post-preset resync (initializeLabels)
 * can't drift apart, and a new overlay is just one more entry here.
 */
export const GRAPH_BAND_TOGGLE_DEFS = [
  { id: 'showOsmGraphBands', stateKey: 'showOsmContext' },
  { id: 'showNdviGraphBands', stateKey: 'showNdviContext' },
  { id: 'showEmFogGraphBands', stateKey: 'showEmFogContext' },
];

/**
 * Safe DOM lookup — warns on missing elements without crashing.
 */
export const GSREvents = {
  /**
   * Safe DOM lookup — warns on missing elements without crashing.
   */
  _id(id) {
    const el = document.getElementById(id);
    if (!el) console.warn(`GSR Map Analyzer: DOM element #${id} not found.`);
    return el;
  },

  /**
   * Cache all frequently-accessed DOM elements into AppState.
   */
  cacheDOMElements() {
    AppState.fileInput = GSREvents._id('fileInput');
    AppState.dropZone = GSREvents._id('dropZone');
    AppState.tableBody = document.querySelector('#peaksTable tbody');

    // Sliders & Selection inputs
    const sliderKeys = [
      'medianSize',
      'lpfWindow',
      'tonicWindow',
      'tonicMethod',
      'peakThreshold',
      'minPeakQuality',
      'hotspotPercentile',
      'shapeMinSnr',
      'gpsSmoothing',
      'gpsKalmanR',
      'gpsMaxHdop',
      'gpsMaxSpeed',
      'gpsRDP',
      'gpsTrackWeight',
      'gpsPeakLatency',
      'gpsSnapToRoads',
      'gpsSnapRadius',
      'placeMergeDistance',
      'maxArousalPlaces',
      'graphView',
      'useDeconvolution',
      'useSparsEDA',
      'usePeakProminence',
      'useCvxEDA',
      'useGaitFilter',
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
      spatialDataCard: 'statSpatialDataCard',
    };
    for (const [key, id] of Object.entries(statKeys)) {
      AppState.statFields[key] = GSREvents._id(id);
    }

    // Contour controls (used in collective map)
    const contourKeys = [
      'gridResolution',
      'contourCount',
      'isolationRadius',
      'idwExponent',
      'peakPreservation',
      'coverageWeighting',
      'topoSource',
      'normalizeZScore',
      'surfaceOpacity',
      'hillshadeStrength',
    ];
    AppState.contourControls = {};
    for (const key of contourKeys) {
      AppState.contourControls[key] = GSREvents._id(key);
    }
    AppState.contourControls.showShadedSurface = GSREvents._id(
      'btnToggleMapSurface',
    );
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
    table.querySelectorAll('thead th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (
          col &&
          typeof GSRUI !== 'undefined' &&
          typeof GSRUI[sortMethod] === 'function'
        ) {
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
    const group = document.getElementById('snapRadiusGroup');
    if (group) group.style.display = toggle?.checked ? '' : 'none';
  },

  /**
   * Look up a slider descriptor by element id across the GSR / GPS / contour
   * tables. Lets the few bespoke binding blocks (snap radius, peak latency,
   * arousal-places merge) pull their formatter from the same source as
   * initializeLabels() instead of re-declaring it inline.
   */
  _sliderDef(id) {
    return (
      GSR_SLIDER_DEFS.find((d) => d.id === id) ||
      GPS_SLIDER_DEFS.find((d) => d.id === id) ||
      CONTOUR_SLIDER_DEFS.find((d) => d.id === id)
    );
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
    const decimals = step < 0.1 ? 2 : suffix.includes('μS') ? 3 : 1;
    return val === 0 ? 'off' : val.toFixed(decimals) + suffix;
  },

  /**
   * Bind a GSR slider: update label immediately, re-run analysis, save settings.
   * Shows "off" when value is 0 and dims the slider group.
   */
  bindGsrSlider(id, labelId, suffix) {
    const slider = document.getElementById(id);
    const label = document.getElementById(labelId);
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
    const label = document.getElementById(labelId);
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
    const label = document.getElementById(labelId);
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
    if (!S?.tonicMethod) return;

    const method = S.tonicMethod.value;
    const slider = document.getElementById('tonicWindow');
    const rec = document.getElementById('tonicWindowRec');
    const help = document.getElementById('tonicWindowHelp');
    const label = document.getElementById('valTonicWindow');

    let min, max, defVal, recLeft, recWidth, helpText;

    if (method === 'percentile') {
      min = 5;
      max = 45;
      defVal = 15;
      recLeft = '12.5%';
      recWidth = '50%';
      helpText =
        'Wider windows isolate baseline from peaks. <strong>Recommended:</strong> 10–30 s.';
    } else if (method === 'median') {
      min = 10;
      max = 60;
      defVal = 30;
      recLeft = '20%';
      recWidth = '50%';
      helpText =
        'Robust median window to exclude peaks. <strong>Recommended:</strong> 20–45 s.';
    } else {
      // 'lpf' / 'ema'
      min = 15;
      max = 90;
      defVal = 45;
      recLeft = '20%';
      recWidth = '40%';
      helpText =
        'Low-pass equivalent window for EMA smoothing. <strong>Recommended:</strong> 30–60 s.';
    }

    if (slider) {
      slider.min = min;
      slider.max = max;
      const currVal = parseFloat(slider.value);
      if (!isInitial || isNaN(currVal) || currVal < min || currVal > max) {
        slider.value = defVal;
      }
      if (label) {
        label.innerText = `${parseFloat(slider.value).toFixed(1)} s`;
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
    if (!S?.tonicMethod) return;
    const cvx = !!S.useCvxEDA?.checked;
    const jointTonic = cvx;

    S.tonicMethod.disabled = jointTonic;
    const win = document.getElementById('tonicWindow');
    if (win) win.disabled = jointTonic;

    const methodGroup = document.getElementById('tonicMethodGroup');
    const winGroup = document.getElementById('tonicWindowGroup');
    if (methodGroup) methodGroup.classList.toggle('ctrl-inert', jointTonic);
    if (winGroup) winGroup.classList.toggle('ctrl-inert', jointTonic);

    const note = document.getElementById('tonicMethodHelp');
    if (note) note.hidden = !jointTonic;
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
    if (!S?.graphView) return;
    const v = S.graphView.value;
    AppState.graphView = v;
    if (v !== 'signal') AppState.lowerGraphMode = v;
    const showLayerBtns = v === 'signal';
    for (const id of [
      'btnToggleRaw',
      'btnToggleFiltered',
      'btnToggleTonic',
      'btnTogglePhasic',
    ]) {
      const b = document.getElementById(id);
      if (b) b.style.display = showLayerBtns ? '' : 'none';
    }
    redraw();
  },

  /**
   * Wire up all UI event listeners (sliders, file drop, buttons, toggles, panels).
   */
  setupEventListeners() {
    this._bindGsrAnalysisControls();
    this._bindTimelineControls();
    this._bindFileAndExportControls();
    this._bindGpsControls();
    this._bindMapPanelControls();
    this._bindPresetControls();
    this._bindEnrichmentControls();
    this._bindEnvironmentalDashboardControls();

    // ── Centralised Layout & Fullscreen Management ───────────────────────────
    GSRLayoutManager.init();
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
      const label = document.getElementById(d.labelId);
      if (slider && label)
        label.innerText = GSREvents._gsrLabelText(slider, d.suffix);
    }

    // Initial tonic method layout and visibility setup (preserving saved settings value)
    GSREvents.updateTonicMethodLayout(true);

    // GPS value labels (per-slider formatter from GPS_SLIDER_DEFS).
    for (const d of GPS_SLIDER_DEFS) {
      const slider = document.getElementById(d.id);
      const label = document.getElementById(d.labelId);
      if (slider && label) label.innerText = d.fmt(parseFloat(slider.value));
    }

    // Snap Radius slider is only shown while road-snapping is enabled
    GSREvents.updateSnapRadiusVisibility();

    // Sync graph background-band overlay checkboxes (OSM context, NDVI, EM Fog)
    for (const { id, stateKey } of GRAPH_BAND_TOGGLE_DEFS) {
      const toggle = document.getElementById(id);
      if (toggle) toggle.checked = !!AppState[stateKey];
    }

    // Contour Settings Labels & Visibility Setup
    const C = AppState.contourControls;
    if (C?.gridResolution) {
      const updateCLabel = (d) => {
        const input = document.getElementById(d.id);
        const label = document.getElementById(d.labelId);
        if (input && label) label.innerText = d.fmt(parseFloat(input.value));
      };
      CONTOUR_SLIDER_DEFS.forEach(updateCLabel);

      const btnToggleMapSurface = document.getElementById(
        'btnToggleMapSurface',
      );
      const opacityGroup = document.getElementById('surfaceOpacityGroup');
      if (btnToggleMapSurface && opacityGroup) {
        opacityGroup.classList.toggle(
          'ctrl-inert',
          !btnToggleMapSurface.classList.contains('active'),
        );
      }

      GSREvents.updatePeakPreservationInertState();
    }

    // Sync dim state for all sliders across all control cards
    document.querySelectorAll('input[type="range"]').forEach((slider) => {
      GSREvents.updateFilterDim(slider);
    });
  },
};
