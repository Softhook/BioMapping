/**
 * Central Controller & p5.js Sketch Loop.
 * All shared state is accessed through AppState.
 */

function setup() {
  AppState.collectiveManager = new GSRCollectiveManager();
  AppState.analyzer = new GSRAnalyzer();
  AppState.mapManager = new GSRMapManager('map');

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
  AppState.myCanvas.elt.addEventListener('mouseenter', () => { AppState.mouseOverCanvas = true; });
  AppState.myCanvas.elt.addEventListener('mouseleave', () => { AppState.mouseOverCanvas = false; });

  GSREvents.cacheDOMElements();
  GSRStorage.loadSettings();
  GSREvents.initializeLabels();
  GSREvents.setupEventListeners();

  noLoop();
  GSRRenderer.drawPlaceholder();
}

function windowResized() {
  const container = document.getElementById('canvasContainer');
  const w = container.clientWidth;
  const h = container.clientHeight || 450;
  resizeCanvas(w, h);
  redraw();
}

function draw() {
  if (!AppState.analyzer || !AppState.analyzer.raw || AppState.analyzer.raw.length === 0) {
    GSRRenderer.drawPlaceholder();
    return;
  }

  background(9, 13, 22);

  const innerWidth = width - GSR_CONST.MARGIN.left - GSR_CONST.MARGIN.right;
  const timelineHeight = GSR_CONST.TIMELINE_HEIGHT;
  const timelineGap = GSR_CONST.TIMELINE_GAP;
  const totalHeight = height - GSR_CONST.MARGIN.top - GSR_CONST.MARGIN.bottom - GSR_CONST.MARGIN.gap - timelineHeight - timelineGap;
  const hUpper = totalHeight * GSR_CONST.GRAPH_UPPER_RATIO;
  const hLower = totalHeight * GSR_CONST.GRAPH_LOWER_RATIO;

  const yUpperBottom = GSR_CONST.MARGIN.top + hUpper;
  const yLowerTop = yUpperBottom + GSR_CONST.MARGIN.gap;
  const yLowerBottom = yLowerTop + hLower;

  AppState.yTimelineTop = yLowerBottom + timelineGap;
  AppState.yTimelineBottom = AppState.yTimelineTop + timelineHeight;
  AppState.yGraphBottom = yLowerBottom;

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
  } else {
    // Scan the visible window (fewer points when zoomed in)
    yMinUpper = Infinity;
    yMaxUpper = -Infinity;
    for (let i = idxStart; i <= idxEnd; i++) {
      if (AppState.showRaw && AppState.analyzer.raw[i]) {
        yMinUpper = Math.min(yMinUpper, AppState.analyzer.raw[i].val);
        yMaxUpper = Math.max(yMaxUpper, AppState.analyzer.raw[i].val);
      }
      if (AppState.showFiltered && AppState.analyzer.filtered[i]) {
        yMinUpper = Math.min(yMinUpper, AppState.analyzer.filtered[i].val);
        yMaxUpper = Math.max(yMaxUpper, AppState.analyzer.filtered[i].val);
      }
      if (AppState.showTonic && AppState.analyzer.tonic[i]) {
        yMinUpper = Math.min(yMinUpper, AppState.analyzer.tonic[i].val);
        yMaxUpper = Math.max(yMaxUpper, AppState.analyzer.tonic[i].val);
      }
    }
  }

  if (yMinUpper === Infinity) yMinUpper = 0;
  if (yMaxUpper === -Infinity) yMaxUpper = 10;

  let paddingUpper = (yMaxUpper - yMinUpper) * 0.1;
  if (paddingUpper === 0) paddingUpper = 0.5;
  yMinUpper = Math.max(0, yMinUpper - paddingUpper);
  yMaxUpper = yMaxUpper + paddingUpper;

  // Y-scaling for Lower Graph (Phasic)
  let yMaxLower;
  if (viewCoversMost && global && global.phasic) {
    yMaxLower = global.phasic.max;
  } else {
    yMaxLower = -Infinity;
    for (let i = idxStart; i <= idxEnd; i++) {
      if (AppState.analyzer.phasic[i]) {
        yMaxLower = Math.max(yMaxLower, AppState.analyzer.phasic[i].val);
      }
    }
  }
  if (yMaxLower <= 0) yMaxLower = parseFloat(AppState.sliders.peakThreshold.value) * 2;
  const paddingLower = yMaxLower * 0.15;
  yMaxLower = yMaxLower + paddingLower;
  const yMinLower = 0;

  // 1. Grids and Axes
  GSRRenderer.drawGridX(AppState.viewStartTime, viewEndTime, yUpperBottom, yLowerBottom);
  GSRRenderer.drawGridYUpper(yMinUpper, yMaxUpper, yUpperBottom, hUpper);
  GSRRenderer.drawGridYLower(yMinLower, yMaxLower, yLowerBottom, hLower);

  // 2. Upper Graph Curves
  if (AppState.showRaw) {
    GSRRenderer.drawSignalCurve(AppState.analyzer.raw, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, GSR_CONST.MARGIN.top, yUpperBottom, color(100, 116, 139, 140), 1.5);
  }
  if (AppState.showFiltered) {
    GSRRenderer.drawSignalCurve(AppState.analyzer.filtered, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, GSR_CONST.MARGIN.top, yUpperBottom, color(14, 165, 233), 2.2);
  }
  if (AppState.showTonic) {
    GSRRenderer.drawSignalCurve(AppState.analyzer.tonic, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, GSR_CONST.MARGIN.top, yUpperBottom, color(217, 70, 239), 2);
  }

  // 3. Lower Graph (Phasic)
  GSRRenderer.drawPhasicArea(AppState.analyzer.phasic, AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom);
  GSRRenderer.drawSignalCurve(AppState.analyzer.phasic, AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom, color(16, 185, 129), 2);

  // Threshold line on Phasic graph
  const thresholdVal = parseFloat(AppState.sliders.peakThreshold.value);
  const thresholdY = map(thresholdVal, yMinLower, yMaxLower, yLowerBottom, yLowerTop);
  stroke(244, 63, 94, 120);
  strokeWeight(1);
  drawingContext.setLineDash([5, 5]);
  line(GSR_CONST.MARGIN.left, thresholdY, width - GSR_CONST.MARGIN.right, thresholdY);
  drawingContext.setLineDash([]);

  fill(244, 63, 94, 150);
  noStroke();
  textSize(9);
  textAlign(RIGHT, CENTER);
  text('Threshold (' + thresholdVal.toFixed(3) + ' \u03bcS)', width - GSR_CONST.MARGIN.right - 5, thresholdY - 8);

  // 4. Peak Markers
  GSRRenderer.drawPeakMarkers(AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, GSR_CONST.MARGIN.top, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 5. Hover Scrubber
  GSRRenderer.handleScrubber(AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 6. Timeline overview
  GSRRenderer.drawTimelineOverview(innerWidth, timelineHeight);
}

function mousePressed() {
  if (AppState.analyzer.raw.length === 0) return;

  if (mouseX >= GSR_CONST.MARGIN.left && mouseX <= width - GSR_CONST.MARGIN.right &&
      mouseY >= AppState.yTimelineTop && mouseY <= AppState.yTimelineBottom) {
    AppState.isDraggingTimeline = true;
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
  }
}

function mouseDragged() {
  if (AppState.isDraggingTimeline && AppState.analyzer.raw.length > 0) {
    const dragTime = map(mouseX, GSR_CONST.MARGIN.left, width - GSR_CONST.MARGIN.right, 0, AppState.totalDuration);
    AppState.viewStartTime = constrain(dragTime - AppState.viewDuration / 2, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));
    redraw();
  }
  else if (AppState.isDragging && AppState.analyzer.raw.length > 0) {
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
}

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

    redraw();
    return false;
  }
}
