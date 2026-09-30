import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRLayoutManager } from '../core/layout_manager.mjs';
import { GSRMapManager } from '../map/map.mjs';
import { GSRAnalyzer } from '../signal/analyzer.mjs';
import { GSRCollectiveManager } from '../spatial/collective_manager.mjs';
import { GSRRenderer } from './renderer.mjs';

let _cachedPeakAnalyzer = null;
let _cachedPeakList = null;
let _cachedPeakDataVersion = null;
let _cachedActivePeaks = [];
let _cachedFilteredForce = [];
let _cachedMetricForce = [];
let _cachedDriverForce = []; // Driver spike apex indices — forced into decimation stride so spikes survive zoom-out

/**
 * Grid-scale descriptors for every metric view. Module-level so draw()
 * doesn't rebuild them each frame; the `phasicDriver` entry depends on the
 * active driver config, so _drawMetricView() builds it instead.
 */
const _LOWER_GRID_PRESETS = {
  tonic: {
    steps: [
      [0.2, 0.02],
      [1.0, 0.1],
      [3.0, 0.5],
      [10, 1.0],
    ],
    defaultStep: 2.0,
    unit: ' \u03bcS',
  },
  phasic: {
    steps: [
      [0.05, 0.005],
      [0.15, 0.01],
      [0.5, 0.05],
      [1.5, 0.1],
    ],
    defaultStep: 0.5,
    unit: ' \u03bcS',
  },
  peakDensity: {
    steps: [
      [5, 1],
      [20, 2],
      [60, 5],
      [200, 20],
    ],
    defaultStep: 10,
    unit: ' /min',
  },
  phasicAUC: {
    steps: [
      [0.5, 0.05],
      [2, 0.2],
      [5, 0.5],
      [20, 2],
    ],
    defaultStep: 5,
    unit: ' \u03bcS\u00b7s',
  },
  arousalIndex: {
    steps: [
      [1, 0.2],
      [3, 0.5],
      [6, 1],
      [12, 2],
    ],
    defaultStep: 1,
    unit: ' z',
  },
  triIndex: {
    steps: [
      [1, 0.2],
      [3, 0.5],
      [6, 1],
      [12, 2],
    ],
    defaultStep: 1,
    unit: ' z',
  },
  edasymp: {
    steps: [
      [0.002, 0.0002],
      [0.01, 0.001],
      [0.05, 0.005],
      [0.2, 0.02],
    ],
    defaultStep: 0.02,
    unit: ' \u03bcS\u00b2',
  },
  responseDynamics: {
    steps: [
      [0.05, 0.005],
      [0.15, 0.01],
      [0.5, 0.05],
      [1.5, 0.1],
    ],
    defaultStep: 0.5,
    unit: ' \u03bcS',
  },
};

// Coalesced redraw functions for high-frequency input events (drag, hover, wheel).
// GSREvents is reached via the Controllers registry (core/controllers.mjs),
// which events.mjs only populates once its own module has fully evaluated —
// reading Controllers.events at sketch.mjs's own module top level could still
// see it undefined depending on load order. setup() runs only once every
// module in the graph has finished loading, so these are assigned there
// instead — nothing outside this file ever reads them before setup() runs
// anyway (only mouseDragged/mouseMoved/mouseWheel below call them).
const _safeRedraw = () => {
  if (typeof redraw === 'function') redraw();
};
let coalescedDragRedraw = _safeRedraw;
let coalescedHoverRedraw = _safeRedraw;
let coalescedZoomRedraw = _safeRedraw;

export function setup() {
  coalescedDragRedraw = Controllers.events.rafCoalesce
    ? Controllers.events.rafCoalesce(_safeRedraw)
    : _safeRedraw;
  coalescedHoverRedraw = Controllers.events.rafCoalesce
    ? Controllers.events.rafCoalesce(_safeRedraw)
    : _safeRedraw;
  coalescedZoomRedraw = Controllers.events.rafCoalesce
    ? Controllers.events.rafCoalesce(_safeRedraw)
    : _safeRedraw;

  AppState.collectiveManager = new GSRCollectiveManager();
  AppState.analyzer = new GSRAnalyzer();
  AppState.mapManager = new GSRMapManager('map');

  // Phase 3 pilot (docs/archive/visualizer_architecture_refactor_plan.md): each
  // interested module reacts to 'trackRemoved' independently instead of
  // GSRTrackManager.deleteTrack() calling them all out by name.
  AppState.on('trackRemoved', () => Controllers.trackManager.renderTrackList());
  AppState.on('trackRemoved', () => {
    if (AppState.collectiveManager.tracks.length === 0)
      AppState.mapManager.clearAll();
  });
  AppState.on('trackRemoved', () => {
    if (AppState.viewMode === 'collective')
      Controllers.ui.updateCollectiveMap();
  });

  const container = document.getElementById('canvasContainer');
  if (!container) {
    console.error(
      'GSR Map Analyzer: #canvasContainer not found — cannot initialise canvas.',
    );
    return;
  }
  const w = container.clientWidth;
  const h = container.clientHeight || 450;
  AppState.myCanvas = createCanvas(w, h);
  AppState.myCanvas.parent('canvasContainer');
  AppState.myCanvas.elt.oncontextmenu = (e) => {
    e.preventDefault();
  };

  // Track whether mouse is actually over the canvas (stale coordinates otherwise)
  AppState.myCanvas.elt.addEventListener('mouseenter', () => {
    AppState.mouseOverCanvas = true;
    updateCanvasCursor();
  });
  AppState.myCanvas.elt.addEventListener('mouseleave', () => {
    AppState.mouseOverCanvas = false;
    if (AppState.myCanvas?.elt) {
      AppState.myCanvas.elt.style.cursor = 'default';
    }
    // Without this, the scrubber/tooltip/map-cursor from the last hovered
    // position would stay stuck on screen until some unrelated redraw — see
    // mouseMoved() below for why hovering no longer keeps the loop running.
    redraw();
  });

  // Global mouseup safety so dragging never gets stuck if released outside the canvas
  window.addEventListener('mouseup', () => {
    if (AppState.isDragging || AppState.isDraggingTimeline) {
      AppState.isDragging = false;
      AppState.isDraggingTimeline = false;
      updateCanvasCursor();
      redraw();
    }
  });

  Controllers.events.cacheDOMElements();
  Controllers.events.initializeLabels();
  Controllers.events.setupEventListeners();

  noLoop();
  GSRRenderer.drawPlaceholder();
}

export function windowResized() {
  const container = document.getElementById('canvasContainer');
  if (container) {
    GSRLayoutManager.resizeCanvas(
      container.clientWidth,
      container.clientHeight,
    );
  }
}

export function draw() {
  if (!AppState.analyzer?.raw || AppState.analyzer.raw.length === 0) {
    GSRRenderer.drawPlaceholder();
    return;
  }

  background(GSRRenderer.getThemeColor('--canvas-bg', '#ffffff'));

  const frame = _layoutFrame();
  _refreshForceIndices();
  _drawContextBands(frame);
  if (frame.view === 'signal') _drawSignalView(frame);
  else _drawMetricView(frame);
  _drawNoPlaceShade(frame);

  // Overview timeline bar — pinned to the bottom, unless the panel is too short
  if (frame.showTimeline)
    GSRRenderer.drawTimelineOverview(frame.innerWidth, frame.timelineHeight);
}

/**
 * Plot geometry and visible sample range for this frame. Also publishes the
 * timeline/graph edges on AppState for the mouse handlers.
 */
function _layoutFrame() {
  // One full-height plot: 'signal' (Raw/Filtered/Tonic, optionally Phasic) or a
  // single derived metric ('phasic' / 'phasicAUC' / 'arousalIndex').
  // X_LABEL_STRIP is the band under the plot that carries the x-axis time
  // labels. The overview timeline bar is pinned to the bottom, but drops out
  // when the panel is short (halved height) so the plot keeps a usable height.
  const view = AppState.graphView || 'signal';
  const X_LABEL_STRIP = 15;
  const showTimeline = height >= 240;
  const timelineHeight = showTimeline ? GSR_CONST.TIMELINE_HEIGHT : 0;
  const timelineGap = showTimeline ? GSR_CONST.TIMELINE_GAP : 0;

  const plotTop = GSR_CONST.MARGIN.top;
  const plotBottom =
    height -
    GSR_CONST.MARGIN.bottom -
    timelineHeight -
    timelineGap -
    X_LABEL_STRIP;

  AppState.yTimelineTop = showTimeline
    ? height - GSR_CONST.MARGIN.bottom - timelineHeight
    : height;
  AppState.yTimelineBottom = AppState.yTimelineTop + timelineHeight;
  AppState.yGraphBottom = plotBottom;

  // The x axis is place time (AppState.timeAxisStart). Skin data is drawn
  // the Response delay earlier, so it is read over the same window shifted
  // forward by the delay; place data (the context bands) and the time labels
  // use the window as it is.
  const viewStartTime = AppState.viewStartTime;
  const viewEndTime = viewStartTime + AppState.viewDuration;
  const analyzer = AppState.analyzer;
  const delay = analyzer.responseDelay || 0;
  const bodyStartTime = viewStartTime + delay;
  const bodyEndTime = viewEndTime + delay;

  const startIdx = analyzer.findClosestIndex(bodyStartTime);
  const endIdx = analyzer.findClosestIndex(bodyEndTime);
  const idxStart = Math.max(0, startIdx - 1);
  const idxEnd = Math.min(analyzer.raw.length - 1, endIdx + 1);

  // Use the global range cache when the view is wide, to skip a full scan.
  const globalRange = analyzer._globalRange;
  const viewCoversMost =
    !!globalRange && idxEnd - idxStart > analyzer.raw.length * 0.4;

  return {
    view,
    innerWidth: width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right,
    showTimeline,
    timelineHeight,
    plotTop,
    plotBottom,
    viewStartTime,
    viewEndTime,
    bodyStartTime,
    bodyEndTime,
    idxStart,
    idxEnd,
    globalRange,
    viewCoversMost,
  };
}

/**
 * Grey out the start of the axis, before 0: readings there have no place
 * (it would be before the recording started), so they are shown but not
 * paired with anything on the map.
 */
function _drawNoPlaceShade({
  viewStartTime,
  viewEndTime,
  plotTop,
  plotBottom,
}) {
  if (viewStartTime >= 0) return;
  const left = GSR_CONST.MARGIN.left;
  const right = width - GSR_CONST.MARGIN.right;
  const x0 = map(0, viewStartTime, viewEndTime, left, right);
  if (x0 <= left) return;
  const bg = GSRRenderer.getThemeColor('--canvas-bg', '#ffffff');
  noStroke();
  fill(color(`${bg}b3`));
  rect(left, plotTop, Math.min(x0, right) - left, plotBottom - plotTop);
}

/** Y range (padded, floored at 0) for the µS signal view. */
function _signalRange(frame, view) {
  const { globalRange, idxStart, idxEnd } = frame;
  const analyzer = AppState.analyzer;
  let yMin = Infinity;
  let yMax = -Infinity;

  if (frame.viewCoversMost) {
    // Fast path: estimate from pre-computed global ranges
    if (AppState.showRaw && globalRange.raw) {
      yMin = Math.min(yMin, globalRange.raw.min);
      yMax = Math.max(yMax, globalRange.raw.max);
    }
    if (AppState.showFiltered && globalRange.filtered) {
      yMin = Math.min(yMin, globalRange.filtered.min);
      yMax = Math.max(yMax, globalRange.filtered.max);
    }
    if (AppState.showTonic && globalRange.tonic) {
      yMin = Math.min(yMin, globalRange.tonic.min);
      yMax = Math.max(yMax, globalRange.tonic.max);
    }
    // Phasic overlay rides the same µS axis — pull the floor down so its
    // (much smaller) values stay on-graph instead of clipping below.
    if (AppState.showPhasic && view === 'signal' && globalRange.phasic) {
      yMin = Math.min(yMin, globalRange.phasic.min);
      yMax = Math.max(yMax, globalRange.phasic.max);
    }
  } else {
    // Scan the visible window (fewer points when zoomed in)
    for (let i = idxStart; i <= idxEnd; i++) {
      if (AppState.showRaw && analyzer.raw[i]) {
        const val = analyzer.raw[i].val;
        if (val < yMin) yMin = val;
        if (val > yMax) yMax = val;
      }
      if (AppState.showFiltered && analyzer.filtered[i]) {
        const val = analyzer.filtered[i].val;
        if (val < yMin) yMin = val;
        if (val > yMax) yMax = val;
      }
      if (AppState.showTonic && analyzer.tonic[i]) {
        const val = analyzer.tonic[i].val;
        if (val < yMin) yMin = val;
        if (val > yMax) yMax = val;
      }
      if (AppState.showPhasic && view === 'signal' && analyzer.phasic[i]) {
        const val = analyzer.phasic[i].val;
        if (val < yMin) yMin = val;
        if (val > yMax) yMax = val;
      }
    }
  }

  if (yMin === Infinity) yMin = 0;
  if (yMax === -Infinity) yMax = 10;

  let padding = (yMax - yMin) * 0.1;
  if (padding === 0) padding = 0.5;
  return { yMin: Math.max(0, yMin - padding), yMax: yMax + padding };
}

/**
 * What the single-metric view plots: the series, its display config and
 * (for the driver) the unit config of whichever detector produced it.
 * See GSR_CONST.LOWER_GRAPH_MODES.
 */
function _metricSeries() {
  const mode = AppState.lowerGraphMode || 'phasic';
  const cfg =
    GSR_CONST.LOWER_GRAPH_MODES[mode] || GSR_CONST.LOWER_GRAPH_MODES.phasic;
  const series =
    mode === 'responseDynamics'
      ? AppState.analyzer.phasic
      : AppState.analyzer[mode] || AppState.analyzer.phasic;

  // 'phasicDriver' has no single static display config: matching pursuit's
  // driver and cvxEDA's driver are different physical quantities (µS vs
  // µS/s — see GSR_CONST.DRIVER_UNIT_BY_ALGORITHM's comment), so pick it by
  // whichever detector actually produced the currently-plotted series.
  const driverCfg =
    mode === 'phasicDriver'
      ? GSR_CONST.DRIVER_UNIT_BY_ALGORITHM?.[
          AppState.analyzer._driverAlgorithm
        ] || GSR_CONST.DRIVER_UNIT_BY_ALGORITHM.matching_pursuit
      : null;

  return { mode, cfg, series, driverCfg };
}

/** Y range (padded) for the single-metric view. */
function _metricRange(frame, metric) {
  const { mode, cfg, series, driverCfg } = metric;
  const { globalRange, idxStart, idxEnd } = frame;

  // Rise Speed plots the phasic (coloured by speed), so it scales to the
  // phasic's range, not the speed-factor series'.
  const rangeKey = mode === 'responseDynamics' ? 'phasic' : mode;
  let yMin = cfg.allowNegative ? Infinity : 0;
  let yMax;
  if (frame.viewCoversMost && globalRange?.[rangeKey]) {
    yMax = globalRange[rangeKey].max;
    if (cfg.allowNegative) yMin = globalRange[rangeKey].min;
  } else {
    yMax = -Infinity;
    for (let i = idxStart; i <= idxEnd; i++) {
      if (series[i]) {
        const val = series[i].val;
        if (val > yMax) yMax = val;
        if (cfg.allowNegative && val < yMin) yMin = val;
      }
    }
  }
  if (cfg.allowNegative) {
    if (yMin === Infinity) yMin = -1;
    if (yMax === -Infinity) yMax = 1;
  } else {
    if (yMax === -Infinity || yMax <= 0) {
      if (mode === 'phasic' || mode === 'responseDynamics')
        yMax = parseFloat(AppState.sliders.peakThreshold.value) * 2;
      else if (mode === 'phasicDriver') yMax = driverCfg.gridDefaultStep * 2;
      else yMax = 100;
    }
  }
  const span = yMax - yMin;
  const padding = (span > 0 ? span : Math.abs(yMax) || 1) * 0.15;
  yMax = yMax + padding;
  if (cfg.allowNegative) yMin = yMin - padding;
  return { yMin, yMax };
}

/**
 * Peak sample indices, forced into curve decimation so drawn lines actually
 * reach every marker instead of a stride segment cutting the corner past it
 * (see _buildCurveContext()'s doc comment in renderer.js). Cached across
 * animation frames (pan/zoom/scrub) and invalidated only on peak revisions.
 */
function _refreshForceIndices() {
  const analyzer = AppState.analyzer;
  if (
    _cachedPeakAnalyzer &&
    _cachedPeakAnalyzer === analyzer &&
    _cachedPeakList === analyzer.peaks &&
    _cachedPeakDataVersion === analyzer._dataVersion
  ) {
    return;
  }
  _cachedPeakAnalyzer = analyzer;
  _cachedPeakList = analyzer ? analyzer.peaks : null;
  _cachedPeakDataVersion = analyzer ? analyzer._dataVersion : 0;
  _cachedActivePeaks = analyzer?.peaks
    ? analyzer.peaks.filter((p) => !p.excluded)
    : [];
  _cachedFilteredForce = [];
  for (let i = 0; i < _cachedActivePeaks.length; i++) {
    const p = _cachedActivePeaks[i];
    _cachedFilteredForce.push(p.onsetIndex, p.index);
  }
  _cachedMetricForce = _cachedActivePeaks.map((p) => p.index);

  // Driver spike apex indices — so narrow spikes (often 1–3 samples wide)
  // are never skipped by the uniform decimation stride when zoomed out.
  // phasicDriverPeaks stores { index, time, amplitude } for every impulse
  // the deconvolution / matching-pursuit step detected.
  // Force apex-1, apex, apex+1 for each driver spike so the rendered line
  // captures both zero-crossing shoulders, not just the peak tip. Without
  // the neighbours the stride interpolates a fabricated triangle whose rise
  // and fall slopes depend on whichever stride samples happen to bracket the
  // apex — the height is right but the shape is wrong. Clamped to [0, n-1]
  // so boundary spikes don't produce out-of-range indices.
  if (analyzer?.phasicDriverPeaks && analyzer.phasicDriverPeaks.length > 0) {
    const driverLen = analyzer.phasicDriver
      ? analyzer.phasicDriver.length - 1
      : Infinity;
    const df = [];
    for (const pk of analyzer.phasicDriverPeaks) {
      const idx = pk.index;
      if (idx > 0) df.push(idx - 1);
      df.push(idx);
      if (idx < driverLen) df.push(idx + 1);
    }
    _cachedDriverForce = df;
  } else {
    _cachedDriverForce = [];
  }
}

// Background context bands, drawn behind whichever graph is showing — each
// overlay reads its own AppState toggle and no-ops when off.
function _drawContextBands({
  viewStartTime,
  viewEndTime,
  plotTop,
  plotBottom,
}) {
  if (AppState.showOsmContext)
    GSRRenderer.drawOsmContextBands(
      viewStartTime,
      viewEndTime,
      plotTop,
      plotBottom,
    );
  if (AppState.showNdviContext)
    GSRRenderer.drawNdviContextBands(
      viewStartTime,
      viewEndTime,
      plotTop,
      plotBottom,
    );
  if (AppState.showEmFogContext)
    GSRRenderer.drawEmFogContextBands(
      viewStartTime,
      viewEndTime,
      plotTop,
      plotBottom,
    );
}

/** Peak and hotspot markers always take the same arguments. */
function _drawPeakAndHotspotMarkers(...args) {
  GSRRenderer.drawPeakMarkers(...args);
  GSRRenderer.drawHotspotMarkers(...args);
}

// 'Signal' - Raw / Filtered / Tonic (+ optional Phasic overlay), full height (uS)
function _drawSignalView(frame) {
  const { viewStartTime, viewEndTime, bodyStartTime, bodyEndTime } = frame;
  const { plotTop, plotBottom } = frame;
  const { yMin, yMax } = _signalRange(frame, frame.view);
  const grid = _LOWER_GRID_PRESETS.tonic; // the µS signal uses the Tonic grid

  GSRRenderer.drawGridX(
    viewStartTime,
    viewEndTime,
    plotBottom,
    plotBottom,
    true,
  );
  GSRRenderer.drawGridY(
    yMin,
    yMax,
    plotBottom,
    plotTop,
    grid.steps,
    grid.defaultStep,
  );

  const curve = (series, stroke, weight, forceIndices) =>
    GSRRenderer.drawSignalCurve(
      series,
      bodyStartTime,
      bodyEndTime,
      yMin,
      yMax,
      plotTop,
      plotBottom,
      stroke,
      weight,
      forceIndices,
    );

  if (AppState.showRaw) {
    const colorRaw = GSRRenderer.getThemeColor('--color-raw', '#7c7c76');
    curve(AppState.analyzer.raw, color(`${colorRaw}8c`), 1.5);
  }
  if (AppState.showTonic) {
    curve(
      AppState.analyzer.tonic,
      GSRRenderer.getThemeColor('--color-tonic', '#a30091'),
      2,
    );
  }
  // Phasic (SCR) overlaid on the same uS axis - a thin, low-amplitude trace
  // near the baseline (the axis floor was pulled toward 0 above so it stays
  // on-graph). Drawn under Filtered so the primary curve stays on top.
  if (AppState.showPhasic) {
    const colorPhasic = GSRRenderer.getThemeColor('--color-phasic', '#008f3c');
    curve(
      AppState.analyzer.phasic,
      color(`${colorPhasic}c8`),
      1.5,
      _cachedMetricForce,
    );
  }
  if (AppState.showFiltered) {
    curve(
      AppState.analyzer.filtered,
      GSRRenderer.getThemeColor('--color-filtered', '#005bc4'),
      2.2,
      _cachedFilteredForce,
    );
  }

  // Peaks / hotspots on the Filtered curve only - no phasic-scaled lower half
  // (showUpperMarker=true, showLowerMarker=false).
  _drawPeakAndHotspotMarkers(
    bodyStartTime,
    bodyEndTime,
    yMin,
    yMax,
    plotTop,
    plotBottom,
    0,
    1,
    plotBottom,
    plotBottom,
    false,
    true,
  );
  // L-params = the same uS range so handleScrubber can drop a Phasic dot too.
  GSRRenderer.handleScrubber(
    bodyStartTime,
    bodyEndTime,
    yMin,
    yMax,
    plotBottom,
    yMin,
    yMax,
    plotTop,
    plotBottom,
  );
}

/**
 * Dashed horizontal reference line — the Phasic threshold line and the
 * Arousal-Index zero line, for the single metric view.
 */
function _drawRefLine(y, dash, colorPeak, hexAlpha) {
  stroke(color(colorPeak + hexAlpha));
  strokeWeight(1);
  drawingContext.setLineDash(dash);
  line(GSR_CONST.MARGIN.left, y, width - GSR_CONST.MARGIN.right, y);
  drawingContext.setLineDash([]);
}

/**
 * Right-edge label for a reference line, on a card-coloured backing so it
 * stays legible over the trace. Drawn after the peak markers, which would
 * otherwise paint over it.
 */
function _drawRefLabel(y, colorPeak, label) {
  noStroke();
  textSize(9);
  textAlign(RIGHT, CENTER);
  const x = width - GSR_CONST.MARGIN.right - 5;
  const ty = y - 8;
  const pad = 3;
  const w = textWidth(label) + pad * 2;
  fill(color(`${GSRRenderer.getThemeColor('--bg-card', '#ffffff')}d9`));
  rect(x - w + pad, ty - 6, w, 12, 2);
  fill(color(`${colorPeak}96`));
  text(label, x, ty);
}

// ── Single metric view — one derived series, full height, own Y axis ────
function _drawMetricView(frame) {
  const { viewStartTime, viewEndTime, bodyStartTime, bodyEndTime } = frame;
  const { plotTop, plotBottom } = frame;
  const metric = _metricSeries();
  const { mode, cfg, series, driverCfg } = metric;
  const { yMin, yMax } = _metricRange(frame, metric);

  const grid =
    mode === 'phasicDriver' && driverCfg
      ? {
          steps: driverCfg.gridSteps,
          defaultStep: driverCfg.gridDefaultStep,
          unit: ` ${driverCfg.unit}`,
        }
      : _LOWER_GRID_PRESETS[mode] || _LOWER_GRID_PRESETS.phasic;
  const colorPeak = GSRRenderer.getThemeColor('--color-peak', '#d10024');
  const colorMetric = GSRRenderer.getThemeColor(cfg.colorVar, cfg.colorDefault);
  const yOf = (val) => map(val, yMin, yMax, plotBottom, plotTop);

  GSRRenderer.drawGridX(
    viewStartTime,
    viewEndTime,
    plotBottom,
    plotBottom,
    true,
  );
  GSRRenderer.drawGridY(
    yMin,
    yMax,
    plotBottom,
    plotTop,
    grid.steps,
    grid.defaultStep,
    grid.unit,
  );

  // Driver view: use driver spike apices as forced vertices so narrow impulses
  // (often 1–3 samples wide) are never swallowed by the uniform decimation
  // stride when zoomed out. All other metric views use SCR peak positions.
  const forceIndices =
    mode === 'phasicDriver' ? _cachedDriverForce : _cachedMetricForce;

  if (mode === 'responseDynamics') {
    GSRRenderer.drawResponseDynamicsPhasic(
      series,
      AppState.analyzer.responseDynamics,
      bodyStartTime,
      bodyEndTime,
      yMin,
      yMax,
      plotTop,
      plotBottom,
      forceIndices,
    );
  } else {
    GSRRenderer.drawPhasicArea(
      series,
      bodyStartTime,
      bodyEndTime,
      yMin,
      yMax,
      plotTop,
      plotBottom,
      colorMetric,
      forceIndices,
    );
    GSRRenderer.drawSignalCurve(
      series,
      bodyStartTime,
      bodyEndTime,
      yMin,
      yMax,
      plotTop,
      plotBottom,
      colorMetric,
      2,
      forceIndices,
    );
  }

  if (cfg.showPeakOverlay) {
    const threshold = parseFloat(AppState.sliders.peakThreshold.value);
    _drawRefLine(yOf(threshold), [5, 5], colorPeak, '78');
    // Phasic view: peak amplitudes ARE on this axis, so draw the full SCR
    // treatment (shaded region + onset dot) and skip the missing Filtered
    // half (showLowerMarker=true, showUpperMarker=false).
    _drawPeakAndHotspotMarkers(
      bodyStartTime,
      bodyEndTime,
      0,
      1,
      plotTop,
      plotBottom,
      yMin,
      yMax,
      plotTop,
      plotBottom,
      true,
      false,
    );
    _drawRefLabel(
      yOf(threshold),
      colorPeak,
      `Threshold (${threshold.toFixed(3)} μS)`,
    );
  } else {
    if (cfg.allowNegative) _drawRefLine(yOf(0), [2, 3], colorPeak, '50');
    // Tonic / Peak Density / AUC / Arousal: a peak's µS amplitude means
    // nothing on a µS·s / /min / z axis, so mark each peak (and hotspot) as a
    // dot on THIS curve at its own time — markerSeries = the plotted series,
    // U-axis = this metric's range, no phasic lower half.
    _drawPeakAndHotspotMarkers(
      bodyStartTime,
      bodyEndTime,
      yMin,
      yMax,
      plotTop,
      plotBottom,
      0,
      1,
      plotBottom,
      plotBottom,
      false,
      true,
      series,
    );
  }

  GSRRenderer.handleScrubber(
    bodyStartTime,
    bodyEndTime,
    0,
    1,
    plotBottom,
    yMin,
    yMax,
    plotTop,
    plotBottom,
  );
}

function updateCanvasCursor() {
  if (!AppState.myCanvas?.elt) return;
  let cur = 'default';
  if (AppState.isDragging || AppState.isDraggingTimeline) {
    cur = 'grabbing';
  } else if (
    AppState.mouseOverCanvas &&
    AppState.analyzer?.raw &&
    AppState.analyzer.raw.length > 0
  ) {
    if (
      GSRRenderer.isOverExclude(mouseX, mouseY) ||
      GSRRenderer.isOverPeak(mouseX, mouseY)
    ) {
      cur = 'pointer';
    } else if (
      mouseX >= GSR_CONST.MARGIN.left &&
      mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= AppState.yTimelineTop &&
      mouseY <= AppState.yTimelineBottom
    ) {
      cur = 'ew-resize';
    } else if (
      mouseX >= GSR_CONST.MARGIN.left &&
      mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= GSR_CONST.MARGIN.top &&
      mouseY <= AppState.yGraphBottom
    ) {
      cur = 'crosshair';
    }
  }
  AppState.myCanvas.elt.style.cursor = cur;
}

export function mousePressed() {
  if (AppState.analyzer.raw.length === 0) return;

  // Check for click on an on-canvas exclude ✕ / ＋ button — abort drag if hit
  if (GSRRenderer.checkExcludeHit(mouseX, mouseY)) {
    updateCanvasCursor();
    return;
  }

  // Check for click on a peak marker or vertical line — select if hit and abort drag
  if (GSRRenderer.checkPeakClick?.(mouseX, mouseY)) {
    updateCanvasCursor();
    redraw();
    return;
  }

  if (
    mouseX >= GSR_CONST.MARGIN.left &&
    mouseX <= width - GSR_CONST.MARGIN.right &&
    mouseY >= AppState.yTimelineTop &&
    mouseY <= AppState.yTimelineBottom
  ) {
    AppState.isDraggingTimeline = true;
    updateCanvasCursor();
    const clickTime = map(
      mouseX,
      GSR_CONST.MARGIN.left,
      width - GSR_CONST.MARGIN.right,
      AppState.timeAxisStart,
      AppState.totalDuration,
    );
    AppState.viewStartTime = AppState.clampViewStart(
      clickTime - AppState.viewDuration / 2,
    );
    redraw();
  } else if (
    mouseX >= GSR_CONST.MARGIN.left &&
    mouseX <= width - GSR_CONST.MARGIN.right &&
    mouseY >= GSR_CONST.MARGIN.top &&
    mouseY <= AppState.yGraphBottom
  ) {
    AppState.isDragging = true;
    AppState.dragStartMouseX = mouseX;
    AppState.dragStartViewStart = AppState.viewStartTime;
    updateCanvasCursor();
  }
}

export function mouseDragged() {
  if (AppState.isDraggingTimeline && AppState.analyzer.raw.length > 0) {
    updateCanvasCursor();
    const dragTime = map(
      mouseX,
      GSR_CONST.MARGIN.left,
      width - GSR_CONST.MARGIN.right,
      AppState.timeAxisStart,
      AppState.totalDuration,
    );
    AppState.viewStartTime = AppState.clampViewStart(
      dragTime - AppState.viewDuration / 2,
    );
    coalescedDragRedraw();
  } else if (AppState.isDragging && AppState.analyzer.raw.length > 0) {
    updateCanvasCursor();
    const mouseDx = mouseX - AppState.dragStartMouseX;
    const timePerPixel =
      AppState.viewDuration /
      (width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right);
    const timeShift = mouseDx * timePerPixel;

    AppState.viewStartTime = AppState.clampViewStart(
      AppState.dragStartViewStart - timeShift,
    );
    coalescedDragRedraw();
  }
}

export function mouseReleased() {
  AppState.isDragging = false;
  AppState.isDraggingTimeline = false;
  updateCanvasCursor();
}

export function mouseMoved() {
  if (AppState.mouseOverCanvas) {
    updateCanvasCursor();
    coalescedHoverRedraw();
  }
}

export function mouseWheel(event) {
  if (
    mouseX >= GSR_CONST.MARGIN.left &&
    mouseX <= width - GSR_CONST.MARGIN.right &&
    mouseY >= GSR_CONST.MARGIN.top &&
    mouseY <= AppState.yGraphBottom
  ) {
    if (AppState.analyzer.raw.length === 0) return false;

    const mouseTime = map(
      mouseX,
      GSR_CONST.MARGIN.left,
      width - GSR_CONST.MARGIN.right,
      AppState.viewStartTime,
      AppState.viewStartTime + AppState.viewDuration,
    );
    const zoomMultiplier = event.delta < 0 ? 0.85 : 1.15;

    AppState.viewDuration = constrain(
      AppState.viewDuration * zoomMultiplier,
      2.0,
      AppState.timeAxisSpan,
    );
    AppState.zoomFactor = AppState.timeAxisSpan / AppState.viewDuration;

    AppState.viewStartTime = AppState.clampViewStart(
      mouseTime -
        (mouseX - GSR_CONST.MARGIN.left) *
          (AppState.viewDuration /
            (width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right)),
    );

    coalescedZoomRedraw();
    return false;
  }
}
