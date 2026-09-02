/**
 * Central Controller & p5.js Sketch Loop.
 * All shared state is accessed through AppState.
 */

function setup() {
  AppState.collectiveManager = new GSRCollectiveManager();
  AppState.analyzer = new GSRAnalyzer();
  AppState.mapManager = new GSRMapManager('map');

  // Phase 3 pilot (docs/archive/visualizer_architecture_refactor_plan.md): each
  // interested module reacts to 'trackRemoved' independently instead of
  // GSRTrackManager.deleteTrack() calling them all out by name.
  AppState.on('trackRemoved', () => GSRTrackManager.renderTrackList());
  AppState.on('trackRemoved', () => {
    if (AppState.collectiveManager.tracks.length === 0) AppState.mapManager.clearAll();
  });
  AppState.on('trackRemoved', () => {
    if (AppState.viewMode === 'collective') GSRUI.updateCollectiveMap();
  });

  const container = document.getElementById('canvasContainer');
  if (!container) {
    console.error('GSR Map Analyzer: #canvasContainer not found — cannot initialise canvas.');
    return;
  }
  const w = container.clientWidth;
  const h = container.clientHeight || 450;
  AppState.myCanvas = createCanvas(w, h);
  AppState.myCanvas.parent('canvasContainer');
  AppState.myCanvas.elt.oncontextmenu = (e) => { e.preventDefault(); };

  // Track whether mouse is actually over the canvas (stale coordinates otherwise)
  AppState.myCanvas.elt.addEventListener('mouseenter', () => {
    AppState.mouseOverCanvas = true;
    updateCanvasCursor();
  });
  AppState.myCanvas.elt.addEventListener('mouseleave', () => {
    AppState.mouseOverCanvas = false;
    if (AppState.myCanvas && AppState.myCanvas.elt) {
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

  GSREvents.cacheDOMElements();
  GSREvents.initializeLabels();
  GSREvents.setupEventListeners();

  noLoop();
  GSRRenderer.drawPlaceholder();
}

function windowResized() {
  const container = document.getElementById('canvasContainer');
  if (container) {
    GSRLayoutManager.resizeCanvas(container.clientWidth, container.clientHeight);
  }
}

function draw() {
  if (!AppState.analyzer || !AppState.analyzer.raw || AppState.analyzer.raw.length === 0) {
    GSRRenderer.drawPlaceholder();
    return;
  }

  const canvasBg = GSRRenderer.getThemeColor('--canvas-bg', '#ffffff');
  background(canvasBg);

  const innerWidth = width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right;

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
  const plotBottom = height - GSR_CONST.MARGIN.bottom - timelineHeight - timelineGap - X_LABEL_STRIP;

  AppState.yTimelineTop = showTimeline ? (height - GSR_CONST.MARGIN.bottom - timelineHeight) : height;
  AppState.yTimelineBottom = AppState.yTimelineTop + timelineHeight;
  AppState.yGraphBottom = plotBottom;

  const viewEndTime = AppState.viewStartTime + AppState.viewDuration;

  const startIdx = AppState.analyzer.findClosestIndex(AppState.viewStartTime);
  const endIdx   = AppState.analyzer.findClosestIndex(viewEndTime);
  const idxStart = Math.max(0, startIdx - 1);
  const idxEnd   = Math.min(AppState.analyzer.raw.length - 1, endIdx + 1);

  // ── Y-scaling — use global cache when view is wide to skip full scan ─────
  const global = AppState.analyzer._globalRange;
  const viewCoversMost = global && (idxEnd - idxStart) > AppState.analyzer.raw.length * 0.4;

  let yMinUpper, yMaxUpper;

  if (viewCoversMost) {
    // Fast path: estimate from pre-computed global ranges
    yMinUpper = Infinity;
    yMaxUpper = -Infinity;
    if (AppState.showRaw && global.raw) {
      yMinUpper = Math.min(yMinUpper, global.raw.min);
      yMaxUpper = Math.max(yMaxUpper, global.raw.max);
    }
    if (AppState.showFiltered && global.filtered) {
      yMinUpper = Math.min(yMinUpper, global.filtered.min);
      yMaxUpper = Math.max(yMaxUpper, global.filtered.max);
    }
    if (AppState.showTonic && global.tonic) {
      yMinUpper = Math.min(yMinUpper, global.tonic.min);
      yMaxUpper = Math.max(yMaxUpper, global.tonic.max);
    }
    // Phasic overlay rides the same µS axis — pull the floor down so its
    // (much smaller) values stay on-graph instead of clipping below.
    if (AppState.showPhasic && view === 'signal' && global.phasic) {
      yMinUpper = Math.min(yMinUpper, global.phasic.min);
      yMaxUpper = Math.max(yMaxUpper, global.phasic.max);
    }
  } else {
    // Scan the visible window (fewer points when zoomed in)
    yMinUpper = Infinity;
    yMaxUpper = -Infinity;
    for (let i = idxStart; i <= idxEnd; i++) {
      if (AppState.showRaw && AppState.analyzer.raw[i]) {
        const val = AppState.analyzer.raw[i].val;
        if (val < yMinUpper) yMinUpper = val;
        if (val > yMaxUpper) yMaxUpper = val;
      }
      if (AppState.showFiltered && AppState.analyzer.filtered[i]) {
        const val = AppState.analyzer.filtered[i].val;
        if (val < yMinUpper) yMinUpper = val;
        if (val > yMaxUpper) yMaxUpper = val;
      }
      if (AppState.showTonic && AppState.analyzer.tonic[i]) {
        const val = AppState.analyzer.tonic[i].val;
        if (val < yMinUpper) yMinUpper = val;
        if (val > yMaxUpper) yMaxUpper = val;
      }
      if (AppState.showPhasic && view === 'signal' && AppState.analyzer.phasic[i]) {
        const val = AppState.analyzer.phasic[i].val;
        if (val < yMinUpper) yMinUpper = val;
        if (val > yMaxUpper) yMaxUpper = val;
      }
    }
  }

  if (yMinUpper === Infinity) yMinUpper = 0;
  if (yMaxUpper === -Infinity) yMaxUpper = 10;

  let paddingUpper = (yMaxUpper - yMinUpper) * 0.1;
  if (paddingUpper === 0) paddingUpper = 0.5;
  yMinUpper = Math.max(0, yMinUpper - paddingUpper);
  yMaxUpper = yMaxUpper + paddingUpper;

  // Y-scaling for a metric view — phasic (default) / phasicAUC / arousalIndex.
  // See GSR_CONST.LOWER_GRAPH_MODES.
  const lowerMode = AppState.lowerGraphMode || 'phasic';
  const lowerCfg = GSR_CONST.LOWER_GRAPH_MODES[lowerMode] || GSR_CONST.LOWER_GRAPH_MODES.phasic;
  const lowerSeries = AppState.analyzer[lowerMode] || AppState.analyzer.phasic;

  let yMinLower = lowerCfg.allowNegative ? Infinity : 0;
  let yMaxLower;
  if (viewCoversMost && global && global[lowerMode]) {
    yMaxLower = global[lowerMode].max;
    if (lowerCfg.allowNegative) yMinLower = global[lowerMode].min;
  } else {
    yMaxLower = -Infinity;
    for (let i = idxStart; i <= idxEnd; i++) {
      if (lowerSeries[i]) {
        const val = lowerSeries[i].val;
        if (val > yMaxLower) yMaxLower = val;
        if (lowerCfg.allowNegative && val < yMinLower) yMinLower = val;
      }
    }
  }
  if (lowerCfg.allowNegative) {
    if (yMinLower === Infinity) yMinLower = -1;
    if (yMaxLower === -Infinity) yMaxLower = 1;
  } else {
    if (yMaxLower === -Infinity || yMaxLower <= 0) {
      yMaxLower = lowerMode === 'phasic' ? parseFloat(AppState.sliders.peakThreshold.value) * 2 : 100;
    }
  }
  const lowerSpan = yMaxLower - yMinLower;
  const paddingLower = (lowerSpan > 0 ? lowerSpan : Math.abs(yMaxLower) || 1) * 0.15;
  yMaxLower = yMaxLower + paddingLower;
  if (lowerCfg.allowNegative) yMinLower = yMinLower - paddingLower;

  // \u2500\u2500 Render inputs shared by every view \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const lowerGridPresets = {
    tonic:        { steps: [[0.2, 0.02], [1.0, 0.1], [3.0, 0.5], [10, 1.0]],       defaultStep: 2.0, decimals: 2, unit: ' \u03bcS' },
    phasic:       { steps: [[0.05, 0.005], [0.15, 0.01], [0.5, 0.05], [1.5, 0.1]], defaultStep: 0.5, decimals: 3, unit: ' \u03bcS' },
    peakDensity:  { steps: [[5, 1], [20, 2], [60, 5], [200, 20]],                  defaultStep: 10,  decimals: 0, unit: ' /min' },
    phasicAUC:    { steps: [[0.5, 0.05], [2, 0.2], [5, 0.5], [20, 2]],             defaultStep: 5,   decimals: 2, unit: ' \u03bcS\u00b7s' },
    arousalIndex: { steps: [[1, 0.2], [3, 0.5], [6, 1], [12, 2]],                  defaultStep: 1,   decimals: 1, unit: ' z' },
    triIndex:     { steps: [[1, 0.2], [3, 0.5], [6, 1], [12, 2]],                  defaultStep: 1,   decimals: 1, unit: ' z' }
  };
  const gridPreset = lowerGridPresets[lowerMode] || lowerGridPresets.phasic;
  // The upper (Filtered/Raw/Tonic, µS) plot uses the same grid as the Tonic preset.
  const upperGridPreset = lowerGridPresets.tonic;

  const colorRaw = GSRRenderer.getThemeColor('--color-raw', '#7c7c76');
  const colorFiltered = GSRRenderer.getThemeColor('--color-filtered', '#005bc4');
  const colorTonic = GSRRenderer.getThemeColor('--color-tonic', '#a30091');
  const colorPeak = GSRRenderer.getThemeColor('--color-peak', '#d10024');
  const colorLower = GSRRenderer.getThemeColor(lowerCfg.colorVar, lowerCfg.colorDefault);

  // Peak sample indices, forced into curve decimation so drawn lines actually
  // reach every marker instead of a stride segment cutting the corner past it
  // (see _buildCurveContext()'s doc comment in renderer.js). Only meaningful
  // against the curves peaks are plotted on: Filtered (via onsetIndex+index for
  // the shaded region's edges too) and Phasic (via index, when it's selected).
  const activePeaks = AppState.analyzer.peaks.filter(p => !p.excluded);
  const filteredForceIndices = [];
  for (const p of activePeaks) { filteredForceIndices.push(p.onsetIndex, p.index); }
  // Every metric view now drops a marker on its curve at each peak's time, so
  // force those sample indices into the curve so the line actually reaches them.
  const metricForceIndices = activePeaks.map(p => p.index);

  // Dashed horizontal reference line + optional right-edge label \u2014 the Phasic
  // threshold line and the Arousal-Index zero line, for the single metric view.
  const drawRefLine = (val, yTop, yBottom, dash, hexAlpha, label) => {
    const y = map(val, yMinLower, yMaxLower, yBottom, yTop);
    stroke(color(colorPeak + hexAlpha));
    strokeWeight(1);
    drawingContext.setLineDash(dash);
    line(GSR_CONST.MARGIN.left, y, width - GSR_CONST.MARGIN.right, y);
    drawingContext.setLineDash([]);
    if (label) {
      fill(color(colorPeak + '96'));
      noStroke();
      textSize(9);
      textAlign(RIGHT, CENTER);
      text(label, width - GSR_CONST.MARGIN.right - 5, y - 8);
    }
  };

  if (view === 'signal') {
    // 'Signal' - Raw / Filtered / Tonic (+ optional Phasic overlay), full height (uS)
    GSRRenderer.drawGridX(AppState.viewStartTime, viewEndTime, plotBottom, plotBottom, true);
    GSRRenderer.drawGridY(yMinUpper, yMaxUpper, plotBottom, plotTop, upperGridPreset.steps, upperGridPreset.defaultStep, upperGridPreset.decimals);

    if (AppState.showRaw) {
      GSRRenderer.drawSignalCurve(AppState.analyzer.raw, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, plotTop, plotBottom, color(colorRaw + '8c'), 1.5);
    }
    if (AppState.showTonic) {
      GSRRenderer.drawSignalCurve(AppState.analyzer.tonic, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, plotTop, plotBottom, colorTonic, 2);
    }
    // Phasic (SCR) overlaid on the same uS axis - a thin, low-amplitude trace
    // near the baseline (the axis floor was pulled toward 0 above so it stays
    // on-graph). Drawn under Filtered so the primary curve stays on top.
    if (AppState.showPhasic) {
      const colorPhasic = GSRRenderer.getThemeColor('--color-phasic', '#008f3c');
      GSRRenderer.drawSignalCurve(AppState.analyzer.phasic, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, plotTop, plotBottom, color(colorPhasic + 'c8'), 1.5, activePeaks.map(pk => pk.index));
    }
    if (AppState.showFiltered) {
      GSRRenderer.drawSignalCurve(AppState.analyzer.filtered, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, plotTop, plotBottom, colorFiltered, 2.2, filteredForceIndices);
    }

    // Peaks / hotspots on the Filtered curve only - no phasic-scaled lower half
    // (showUpperMarker=true, showLowerMarker=false).
    GSRRenderer.drawPeakMarkers(AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, plotTop, plotBottom, 0, 1, plotBottom, plotBottom, false, true);
    GSRRenderer.drawHotspotMarkers(AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, plotTop, plotBottom, 0, 1, plotBottom, plotBottom, false, true);
    // L-params = the same uS range so handleScrubber can drop a Phasic dot too.
    GSRRenderer.handleScrubber(AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, plotBottom, yMinUpper, yMaxUpper, plotTop, plotBottom);

  } else {
    // \u2500\u2500 Single metric view \u2014 one derived series, full height, own Y axis \u2500\u2500\u2500\u2500
    GSRRenderer.drawGridX(AppState.viewStartTime, viewEndTime, plotBottom, plotBottom, true);
    GSRRenderer.drawGridY(yMinLower, yMaxLower, plotBottom, plotTop,
      gridPreset.steps, gridPreset.defaultStep, gridPreset.decimals, gridPreset.unit);

    GSRRenderer.drawPhasicArea(lowerSeries, AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, plotTop, plotBottom, colorLower, metricForceIndices);
    GSRRenderer.drawSignalCurve(lowerSeries, AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, plotTop, plotBottom, colorLower, 2, metricForceIndices);

    if (lowerCfg.showPeakOverlay) {
      drawRefLine(parseFloat(AppState.sliders.peakThreshold.value), plotTop, plotBottom, [5, 5], '78',
        'Threshold (' + parseFloat(AppState.sliders.peakThreshold.value).toFixed(3) + ' \u03bcS)');
      // Phasic view: peak amplitudes ARE on this axis, so draw the full SCR
      // treatment (shaded region + onset dot) and skip the missing Filtered
      // half (showLowerMarker=true, showUpperMarker=false).
      GSRRenderer.drawPeakMarkers(AppState.viewStartTime, viewEndTime, 0, 1, plotTop, plotBottom, yMinLower, yMaxLower, plotTop, plotBottom, true, false);
      GSRRenderer.drawHotspotMarkers(AppState.viewStartTime, viewEndTime, 0, 1, plotTop, plotBottom, yMinLower, yMaxLower, plotTop, plotBottom, true, false);
    } else {
      if (lowerCfg.allowNegative) drawRefLine(0, plotTop, plotBottom, [2, 3], '50', null);
      // Tonic / Peak Density / AUC / Arousal: a peak's \u00b5S amplitude means
      // nothing on a \u00b5S\u00b7s / /min / z axis, so mark each peak (and hotspot) as a
      // dot on THIS curve at its own time \u2014 markerSeries = the plotted series,
      // U-axis = this metric's range, no phasic lower half.
      GSRRenderer.drawPeakMarkers(AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, plotTop, plotBottom, 0, 1, plotBottom, plotBottom, false, true, lowerSeries);
      GSRRenderer.drawHotspotMarkers(AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, plotTop, plotBottom, 0, 1, plotBottom, plotBottom, false, true, lowerSeries);
    }

    GSRRenderer.handleScrubber(AppState.viewStartTime, viewEndTime, 0, 1, plotBottom, yMinLower, yMaxLower, plotTop, plotBottom);
  }

  // Overview timeline bar \u2014 pinned to the bottom, unless the panel is too short
  if (showTimeline) GSRRenderer.drawTimelineOverview(innerWidth, timelineHeight);
}

function updateCanvasCursor() {
  if (!AppState.myCanvas || !AppState.myCanvas.elt) return;
  let cur = 'default';
  if (AppState.isDragging || AppState.isDraggingTimeline) {
    cur = 'grabbing';
  } else if (AppState.mouseOverCanvas && AppState.analyzer && AppState.analyzer.raw && AppState.analyzer.raw.length > 0) {
    if ((typeof GSRRenderer.isOverExclude === 'function' && GSRRenderer.isOverExclude(mouseX, mouseY)) ||
        (typeof GSRRenderer.isOverPeak === 'function' && GSRRenderer.isOverPeak(mouseX, mouseY))) {
      cur = 'pointer';
    } else if (mouseX >= GSR_CONST.MARGIN.left && mouseX <= width - GSR_CONST.MARGIN.right &&
               mouseY >= AppState.yTimelineTop && mouseY <= AppState.yTimelineBottom) {
      cur = 'ew-resize';
    } else if (mouseX >= GSR_CONST.MARGIN.left && mouseX <= width - GSR_CONST.MARGIN.right &&
               mouseY >= GSR_CONST.MARGIN.top && mouseY <= AppState.yGraphBottom) {
      cur = 'crosshair';
    }
  }
  AppState.myCanvas.elt.style.cursor = cur;
}

function mousePressed() {
  if (AppState.analyzer.raw.length === 0) return;

  // Check for click on an on-canvas exclude ✕ / ＋ button — abort drag if hit
  if (GSRRenderer.checkExcludeHit(mouseX, mouseY)) {
    updateCanvasCursor();
    return;
  }

  // Check for click on a peak marker or vertical line — select if hit and abort drag
  if (GSRRenderer.checkPeakClick && GSRRenderer.checkPeakClick(mouseX, mouseY)) {
    updateCanvasCursor();
    redraw();
    return;
  }

  if (mouseX >= GSR_CONST.MARGIN.left && mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= AppState.yTimelineTop && mouseY <= AppState.yTimelineBottom) {
    AppState.isDraggingTimeline = true;
    updateCanvasCursor();
    const clickTime = map(mouseX, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right, 0, AppState.totalDuration);
    AppState.viewStartTime = constrain(clickTime - AppState.viewDuration / 2, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));
    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';
    redraw();
  }
  else if (mouseX >= GSR_CONST.MARGIN.left && mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= GSR_CONST.MARGIN.top && mouseY <= AppState.yGraphBottom) {
    AppState.isDragging = true;
    AppState.dragStartMouseX = mouseX;
    AppState.dragStartViewStart = AppState.viewStartTime;
    updateCanvasCursor();
  }
}

function mouseDragged() {
  if (AppState.isDraggingTimeline && AppState.analyzer.raw.length > 0) {
    updateCanvasCursor();
    const dragTime = map(mouseX, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right, 0, AppState.totalDuration);
    AppState.viewStartTime = constrain(dragTime - AppState.viewDuration / 2, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));
    redraw();
  }
  else if (AppState.isDragging && AppState.analyzer.raw.length > 0) {
    updateCanvasCursor();
    const mouseDx = mouseX - AppState.dragStartMouseX;
    const timePerPixel = AppState.viewDuration / (width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right);
    const timeShift = mouseDx * timePerPixel;

    AppState.viewStartTime = AppState.dragStartViewStart - timeShift;
    AppState.viewStartTime = constrain(AppState.viewStartTime, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));
    redraw();
  }
}

function mouseReleased() {
  AppState.isDragging = false;
  AppState.isDraggingTimeline = false;
  updateCanvasCursor();
}

// Restores hover-follow (tooltip / scrubber dot / map cursor sync,
// GSRRenderer.handleScrubber()) now that draw() no longer runs continuously
// for the life of a track view (see tracks.js/events.js — loop() used to be
// left running uncapped just so hover updates kept landing every frame; see
// docs/archive/visualizer_rendering_perf_routes.md §2.5). p5 only calls this while
// no mouse button is held (mouseDragged() covers the held case above), so
// this is purely the passive-hover path. rAF-coalesced like the other
// high-frequency inputs (GSREvents.rafCoalesce) since native mousemove can
// still fire faster than the screen repaints.
const coalescedHoverRedraw = GSREvents.rafCoalesce(() => redraw());

function mouseMoved() {
  if (AppState.mouseOverCanvas) {
    updateCanvasCursor();
    coalescedHoverRedraw();
  }
}

// Trackpads/mice can fire many wheel ticks per animation frame during a
// zoom gesture; redraw() runs draw() synchronously (noLoop() mode), so
// calling it once per tick stacks up full canvas repaints faster than the
// browser can paint them, reading as a stutter/freeze. Cap it to once per
// frame — same GSREvents.rafCoalesce() pattern already used for the GSR/GPS
// sliders (events.js). mouseWheel's state updates below stay synchronous
// (cheap arithmetic), only the expensive repaint is coalesced.
const coalescedZoomRedraw = GSREvents.rafCoalesce(() => redraw());

function mouseWheel(event) {
  if (mouseX >= GSR_CONST.MARGIN.left && mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= GSR_CONST.MARGIN.top && mouseY <= AppState.yGraphBottom) {

    if (AppState.analyzer.raw.length === 0) return false;

    const mouseTime = map(mouseX, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right, AppState.viewStartTime, AppState.viewStartTime + AppState.viewDuration);
    const zoomMultiplier = event.delta < 0 ? 0.85 : 1.15;

    AppState.viewDuration = constrain(AppState.viewDuration * zoomMultiplier, 2.0, AppState.totalDuration);
    AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;

    AppState.viewStartTime = mouseTime - (mouseX - GSR_CONST.MARGIN.left) * (AppState.viewDuration / (width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right));
    AppState.viewStartTime = constrain(AppState.viewStartTime, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));

    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';

    coalescedZoomRedraw();
    return false;
  }
}
