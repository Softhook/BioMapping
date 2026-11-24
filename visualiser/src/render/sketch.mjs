import { AppState } from '../core/app_state.mjs';
import { GSR_CONST } from '../core/constants.mjs';
import { Controllers } from '../core/controllers.mjs';
import { GSRLayoutManager } from '../core/layout_manager.mjs';
import { GSRMapManager } from '../map/map.mjs';
import { GSRAnalyzer } from '../signal/analyzer.mjs';
import { HeartRate } from '../signal/heart_rate.mjs';
import { GSRCollectiveManager } from '../spatial/collective_manager.mjs';
import { GSRRenderer } from './renderer.mjs';
import {
  initInputRedraws,
  installCanvasInputListeners,
} from './sketch_input.mjs';

let _cachedPeakAnalyzer = null;
let _cachedPeakList = null;
let _cachedPeakDataVersion = null;
let _cachedActivePeaks = [];
let _cachedFilteredForce = [];
let _cachedMetricForce = [];
let _cachedDriverForce = []; // Driver spike apex indices — forced into decimation stride so spikes survive zoom-out

// The y axis fits whatever is on screen, so a tall spike scrolling in or out
// would rescale the whole graph in one frame. Instead the drawn range glides
// to the fitted one over this long, starting again from wherever it is when
// the fitted range changes mid-glide.
const Y_GLIDE_MS = 400;
// { key, analyzer, from, to, cur, startMs } — `cur` is the range being drawn.
let _yGlide = null;
let _yGlideFramePending = false;
// Graph draws so far (one _easedYRange call per draw), so the glide's own
// frame can tell whether something else has already drawn.
let _graphDraws = 0;

/**
 * Keep a glide moving when nothing else is redrawing the graph: once per
 * screen frame, after that frame's other animation callbacks (a tour's own
 * per-frame redraw, say) have run, redraw only if none of them did. The
 * check waits for a timeout because animation-frame callbacks run in the
 * order they were requested, so from inside one it can't know whether
 * another will still draw this frame.
 */
function _requestGlideFrame() {
  if (_yGlideFramePending || typeof requestAnimationFrame !== 'function')
    return;
  _yGlideFramePending = true;
  const drawsAtRequest = _graphDraws;
  requestAnimationFrame(() =>
    setTimeout(() => {
      _yGlideFramePending = false;
      if (_graphDraws === drawsAtRequest) {
        if (typeof redraw === 'function') redraw();
      } else if (_yGlide && _yGlide.cur !== _yGlide.to) {
        _requestGlideFrame();
      }
    }, 0),
  );
}

/**
 * The y range to draw this frame: gliding from the range drawn last frame to
 * `target` (the range that fits the view). Snaps straight to `target` when
 * what is plotted changes (another track, view, metric or analysis run),
 * since there is nothing on screen to glide from. While still moving it asks
 * for another frame (_requestGlideFrame), so the glide finishes even when
 * nothing else is redrawing the graph.
 */
function _easedYRange(key, target) {
  _graphDraws++;
  const analyzer = AppState.analyzer;
  const now = performance.now();
  const g = _yGlide;
  if (!g || g.key !== key || g.analyzer !== analyzer) {
    _yGlide = { key, analyzer, from: target, to: target, cur: target };
    return target;
  }
  if (target.yMin !== g.to.yMin || target.yMax !== g.to.yMax) {
    g.from = g.cur;
    g.to = target;
    g.startMs = now;
  }
  if (g.cur === g.to) return g.cur;
  const t = Math.min(1, (now - g.startMs) / Y_GLIDE_MS);
  const e = 1 - (1 - t) ** 3; // ease-out cubic
  g.cur =
    t >= 1
      ? g.to
      : {
          yMin: g.from.yMin + (g.to.yMin - g.from.yMin) * e,
          yMax: g.from.yMax + (g.to.yMax - g.from.yMax) * e,
        };
  if (g.cur !== g.to) _requestGlideFrame();
  return g.cur;
}

/**
 * The 3D tours' playhead: a line at AppState.tourHeadTime (place time, set
 * by globe3d_view.mjs) while a tour runs — the replay clock, or the hotspot
 * tour's current stop. It sits at that time itself rather than the nearest
 * sample, so it glides with the scrolling graph.
 */
function _drawTourPlayhead({
  viewStartTime,
  viewEndTime,
  plotTop,
  plotBottom,
}) {
  const t = AppState.tourHeadTime;
  if (t == null || t < viewStartTime || t > viewEndTime) return;
  const x = map(
    t,
    viewStartTime,
    viewEndTime,
    GSR_CONST.MARGIN.left,
    width - GSR_CONST.MARGIN.right,
  );
  const c = GSRRenderer.getThemeColor('--text-primary', '#111111');
  push();
  stroke(c);
  strokeWeight(1.5);
  line(x, plotTop, x, plotBottom);
  noStroke();
  fill(c);
  triangle(x - 5, plotTop - 6, x + 5, plotTop - 6, x, plotTop);
  pop();
}

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
  heartPulse: {
    steps: [
      [2, 0.2],
      [5, 0.5],
      [10, 1],
      [25, 2],
      [50, 5],
      [100, 10],
    ],
    defaultStep: 50,
    unit: ' nS',
  },
  heartRate: {
    steps: [
      [10, 1],
      [25, 2],
      [50, 5],
      [100, 10],
    ],
    defaultStep: 20,
    unit: '/min',
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

export function setup() {
  initInputRedraws();

  AppState.collectiveManager = new GSRCollectiveManager();
  AppState.analyzer = new GSRAnalyzer();
  AppState.mapManager = new GSRMapManager('map');

  // Each interested module reacts to 'trackRemoved' independently instead of
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
  installCanvasInputListeners(AppState.myCanvas.elt);

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
  else if (frame.view === 'heartPulse' || frame.view === 'heartRate')
    _drawHeartView(frame);
  else _drawMetricView(frame);

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

/**
 * The greyed start goes over the curves and peak markers but under the
 * exclude buttons and the hover cursor and tooltip, which must stay readable.
 */
function _drawNoPlaceShadeAndButtons(frame) {
  _drawNoPlaceShade(frame);
  GSRRenderer.drawExcludeButtons();
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
 * (see _buildCurveContext()'s doc comment in renderer_curve.mjs). Cached across
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
  const { yMin, yMax } = _easedYRange(
    `signal|${AppState.analyzer._dataVersion}`,
    _signalRange(frame, frame.view),
  );
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
  _drawNoPlaceShadeAndButtons(frame);
  _drawTourPlayhead(frame);
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

// ── Heart views — the pulse ripple in the GSR and the rate found from it ──
// Both come from HeartRate (src/signal/heart_rate.mjs). The rate is blank
// (NaN) wherever no clear pulse was found, so each found stretch is drawn as
// its own line. The pulse wave is drawn everywhere, faint where no pulse was
// found, with a dot on each beat.

/** Y range for the heart views: from found stretches in view where there are any. */
function _heartRange(frame, mode) {
  const A = AppState.analyzer;
  const { idxStart, idxEnd } = frame;
  const rate = A.heartRate;
  const pulse = A.heartPulse;
  if (mode === 'heartRate') {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = idxStart; i <= idxEnd; i++) {
      const v = rate[i]?.val;
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo === Infinity) return { yMin: 40, yMax: 140 };
    const mid = (lo + hi) / 2;
    const half = Math.max(10, (hi - lo) / 2 + 5);
    return { yMin: Math.max(0, mid - half), yMax: mid + half };
  }
  // Pulse: the biggest swing inside found stretches; with none in view, the
  // 98th percentile of the whole view so one twitch can't flatten the rest.
  let m = 0;
  for (let i = idxStart; i <= idxEnd; i++) {
    if (!Number.isFinite(rate[i]?.val)) continue;
    const v = Math.abs(pulse[i]?.val ?? 0);
    if (v > m) m = v;
  }
  if (m === 0) {
    const abs = [];
    const step = Math.max(1, Math.floor((idxEnd - idxStart) / 4000));
    for (let i = idxStart; i <= idxEnd; i += step)
      if (pulse[i]) abs.push(Math.abs(pulse[i].val));
    abs.sort((p, q) => p - q);
    m = abs.length ? abs[Math.floor(abs.length * 0.98)] : 1;
  }
  m = Math.max(m, 0.5) * 1.15;
  return { yMin: -m, yMax: m };
}

/**
 * One series as a line, only over samples where `keep(i)` is true; each
 * kept stretch is its own line. Many samples a pixel: a min–max band per
 * pixel column. Few: a smooth curve through every sample.
 */
function _drawHeartLine(series, keep, frame, yOf, strokeColor, weight) {
  const { bodyStartTime, bodyEndTime, idxStart, idxEnd } = frame;
  const left = GSR_CONST.MARGIN.left;
  const right = width - GSR_CONST.MARGIN.right;
  const xOf = (t) => map(t, bodyStartTime, bodyEndTime, left, right);
  const count = idxEnd - idxStart + 1;
  noFill();
  stroke(strokeColor);
  strokeWeight(weight);
  if (count > (right - left) * 1.5) {
    // Min–max band per pixel column.
    let col = -1;
    let lo = 0;
    let hi = 0;
    let prev = null;
    const flush = () => {
      if (col < 0) return;
      const yLo = yOf(lo);
      const yHi = yOf(hi);
      line(col, yLo, col, yHi);
      if (prev && prev.col === col - 1)
        line(prev.col, prev.y, col, (yLo + yHi) / 2);
      prev = { col, y: (yLo + yHi) / 2 };
    };
    for (let i = idxStart; i <= idxEnd; i++) {
      const d = series[i];
      if (!d || !keep(i) || !Number.isFinite(d.val)) {
        flush();
        col = -1;
        prev = null;
        continue;
      }
      const c = Math.round(xOf(d.time));
      if (c !== col) {
        flush();
        col = c;
        lo = hi = d.val;
      } else {
        if (d.val < lo) lo = d.val;
        if (d.val > hi) hi = d.val;
      }
    }
    flush();
    return;
  }
  const smooth = count < GSR_CONST.SPLINE_THRESHOLD;
  const v = smooth ? curveVertex : vertex;
  let open = false;
  let last = null;
  for (let i = idxStart; i <= idxEnd + 1; i++) {
    const d = i <= idxEnd ? series[i] : null;
    const ok = d && keep(i) && Number.isFinite(d.val);
    if (ok) {
      const x = xOf(d.time);
      const y = yOf(d.val);
      if (!open) {
        beginShape();
        if (smooth) curveVertex(x, y);
        open = true;
      }
      v(x, y);
      last = [x, y];
    } else if (open) {
      if (smooth && last) curveVertex(last[0], last[1]);
      endShape();
      open = false;
    }
  }
}

function _drawHeartView(frame) {
  const { viewStartTime, viewEndTime, bodyStartTime, bodyEndTime } = frame;
  const { plotTop, plotBottom, idxStart, idxEnd } = frame;
  const A = AppState.analyzer;
  const mode = frame.view;
  const cfg = GSR_CONST.LOWER_GRAPH_MODES[mode];
  const rate = A.heartRate || [];
  const pulse = A.heartPulse || [];
  const { yMin, yMax } = _easedYRange(
    `${mode}|${A._dataVersion}`,
    _heartRange(frame, mode),
  );
  const grid = _LOWER_GRID_PRESETS[mode];
  const yOf = (val) => map(val, yMin, yMax, plotBottom, plotTop);
  const colorHeart = GSRRenderer.getThemeColor(cfg.colorVar, cfg.colorDefault);
  const colorMuted = GSRRenderer.getThemeColor('--color-raw', '#7c7c76');
  const found = (i) => Number.isFinite(rate[i]?.val);
  // Sweat peaks and hotspots aren't drawn here (they mean nothing on a
  // pulse or /min axis), so clear what the last view left: the hotspot
  // rings are page elements over the canvas, and the click targets would
  // still answer clicks.
  GSRRenderer.clearPulseRings();
  AppState._peakExcludeButtons = [];
  AppState._peakClickTargets = [];

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

  push();
  const left = GSR_CONST.MARGIN.left;
  drawingContext.beginPath();
  drawingContext.rect(
    left,
    plotTop,
    width - GSR_CONST.MARGIN.right - left,
    plotBottom - plotTop,
  );
  drawingContext.clip();

  let anyFound = false;
  for (let i = idxStart; i <= idxEnd && !anyFound; i++)
    if (found(i)) anyFound = true;

  if (mode === 'heartPulse') {
    _drawHeartLine(
      pulse,
      (i) => !found(i),
      frame,
      yOf,
      color(`${colorMuted}66`),
      1,
    );
    _drawHeartLine(pulse, found, frame, yOf, colorHeart, 1.6);
    // A dot on each beat, when they are far enough apart to see.
    const beats = A.heartBeats || [];
    const pxPerSec =
      (width - GSR_CONST.MARGIN.right - left) / (bodyEndTime - bodyStartTime);
    if (pxPerSec >= 15) {
      noStroke();
      fill(colorHeart);
      for (const b of beats) {
        if (b.time < bodyStartTime || b.time > bodyEndTime) continue;
        const i = b.index;
        const i1 = Math.min(pulse.length - 1, i + 1);
        const f =
          pulse[i1].time > pulse[i].time
            ? (b.time - pulse[i].time) / (pulse[i1].time - pulse[i].time)
            : 0;
        const val = pulse[i].val + f * (pulse[i1].val - pulse[i].val);
        circle(
          map(
            b.time,
            bodyStartTime,
            bodyEndTime,
            left,
            width - GSR_CONST.MARGIN.right,
          ),
          yOf(val),
          5,
        );
      }
    }
  } else {
    _drawHeartLine(rate, found, frame, yOf, colorHeart, 2);
  }
  pop();

  // Typical rate (whole recording) in the top-left corner, or why there is none.
  const s = A.heartSummary;
  let label;
  if (s && Number.isFinite(s.bpm) && s.foundSec > 0) {
    const share = Math.round((100 * s.foundSec) / s.totalSec);
    label = `Typical pulse ${Math.round(s.bpm)}/min · found in ${share}% of the recording`;
    if (HeartRate.mayBeFootsteps(s))
      label += ' · no GPS speed: may be footsteps if walking';
    if (!anyFound) label += ' · none here';
  } else {
    label = 'No clear pulse found · it only shows when sitting still';
  }
  noStroke();
  textSize(10);
  textAlign(LEFT, TOP);
  const pad = 4;
  const tw = textWidth(label) + pad * 2;
  fill(color(`${GSRRenderer.getThemeColor('--bg-card', '#ffffff')}d9`));
  rect(left + 6, plotTop + 4, tw, 16, 2);
  fill(colorHeart);
  text(label, left + 6 + pad, plotTop + 7);

  _drawNoPlaceShadeAndButtons(frame);
  _drawTourPlayhead(frame);
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

// ── Single metric view — one derived series, full height, own Y axis ────
function _drawMetricView(frame) {
  const { viewStartTime, viewEndTime, bodyStartTime, bodyEndTime } = frame;
  const { plotTop, plotBottom } = frame;
  const metric = _metricSeries();
  const { mode, cfg, series, driverCfg } = metric;
  const { yMin, yMax } = _easedYRange(
    `${mode}|${AppState.analyzer._dataVersion}`,
    _metricRange(frame, metric),
  );

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

  _drawNoPlaceShadeAndButtons(frame);
  _drawTourPlayhead(frame);
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
