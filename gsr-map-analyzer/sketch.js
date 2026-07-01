/**
 * Central Controller & p5.js Sketch Loop.
 * All shared state is accessed through AppState.
 */

// M is a global shorthand declared in constants.js (GSR_CONST.MARGIN)

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

  cacheDOMElements();
  loadSettings();
  initializeLabels();
  setupEventListeners();

  noLoop();
  drawPlaceholder();
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
    drawPlaceholder();
    return;
  }

  background(9, 13, 22);

  const innerWidth = width - M.left - M.right;
  const timelineHeight = GSR_CONST.TIMELINE_HEIGHT;
  const timelineGap = GSR_CONST.TIMELINE_GAP;
  const totalHeight = height - M.top - M.bottom - M.gap - timelineHeight - timelineGap;
  const hUpper = totalHeight * GSR_CONST.GRAPH_UPPER_RATIO;
  const hLower = totalHeight * GSR_CONST.GRAPH_LOWER_RATIO;

  const yUpperBottom = M.top + hUpper;
  const yLowerTop = yUpperBottom + M.gap;
  const yLowerBottom = yLowerTop + hLower;

  AppState.yTimelineTop = yLowerBottom + timelineGap;
  AppState.yTimelineBottom = AppState.yTimelineTop + timelineHeight;
  AppState.yGraphBottom = yLowerBottom;

  const viewEndTime = AppState.viewStartTime + AppState.viewDuration;

  const startIdx = findClosestIndex(AppState.viewStartTime);
  const endIdx   = findClosestIndex(viewEndTime);
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
  drawGridX(AppState.viewStartTime, viewEndTime, yUpperBottom, yLowerBottom);
  drawGridYUpper(yMinUpper, yMaxUpper, yUpperBottom, hUpper);
  drawGridYLower(yMinLower, yMaxLower, yLowerBottom, hLower);

  // 2. Upper Graph Curves
  if (AppState.showRaw) {
    drawSignalCurve(AppState.analyzer.raw, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, M.top, yUpperBottom, color(100, 116, 139, 140), 1.5);
  }
  if (AppState.showFiltered) {
    drawSignalCurve(AppState.analyzer.filtered, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, M.top, yUpperBottom, color(14, 165, 233), 2.2);
  }
  if (AppState.showTonic) {
    drawSignalCurve(AppState.analyzer.tonic, AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, M.top, yUpperBottom, color(217, 70, 239), 2);
  }

  // 3. Lower Graph (Phasic)
  drawPhasicArea(AppState.analyzer.phasic, AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom);
  drawSignalCurve(AppState.analyzer.phasic, AppState.viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom, color(16, 185, 129), 2);

  // Threshold line on Phasic graph
  const thresholdVal = parseFloat(AppState.sliders.peakThreshold.value);
  const thresholdY = map(thresholdVal, yMinLower, yMaxLower, yLowerBottom, yLowerTop);
  stroke(244, 63, 94, 120);
  strokeWeight(1);
  drawingContext.setLineDash([5, 5]);
  line(M.left, thresholdY, width - M.right, thresholdY);
  drawingContext.setLineDash([]);

  fill(244, 63, 94, 150);
  noStroke();
  textSize(9);
  textAlign(RIGHT, CENTER);
  text('Threshold (' + thresholdVal.toFixed(3) + ' \u03bcS)', width - M.right - 5, thresholdY - 8);

  // 4. Peak Markers
  drawPeakMarkers(AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, M.top, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 5. Hover Scrubber
  handleScrubber(AppState.viewStartTime, viewEndTime, yMinUpper, yMaxUpper, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 6. Timeline overview (cached points — pre-computed after analysis)
  if (AppState.analyzer._timelinePoints && AppState.analyzer._timelinePoints.length > 0) {
    fill(15, 23, 42, 180);
    stroke(255, 255, 255, 15);
    strokeWeight(1);
    rect(M.left, AppState.yTimelineTop, innerWidth, timelineHeight, 6);

    noFill();
    stroke(148, 163, 184, 45);
    strokeWeight(1.2);

    let minRaw = Infinity;
    let maxRaw = -Infinity;
    if (!AppState.analyzer.rawMinMaxCached) {
      for (let i = 0; i < AppState.analyzer.raw.length; i++) {
        const val = AppState.analyzer.raw[i].val;
        if (val < minRaw) minRaw = val;
        if (val > maxRaw) maxRaw = val;
      }
      AppState.analyzer.rawMinMaxCached = { minVal: minRaw, maxVal: maxRaw };
    } else {
      minRaw = AppState.analyzer.rawMinMaxCached.minVal;
      maxRaw = AppState.analyzer.rawMinMaxCached.maxVal;
    }

    if (minRaw === maxRaw) maxRaw = minRaw + 0.5;

    // Use pre-cached timeline points (~300 samples)
    beginShape();
    const tPoints = AppState.analyzer._timelinePoints;
    for (let i = 0; i < tPoints.length; i++) {
      const d = tPoints[i];
      const xt = map(d.time, 0, AppState.totalDuration, M.left, width - M.right);
      const yt = map(d.val, minRaw, maxRaw, AppState.yTimelineBottom - 3, AppState.yTimelineTop + 3);
      vertex(xt, yt);
    }
    endShape();

    // Use pre-cached peak positions (fraction of total duration)
    if (AppState.showPeaks && AppState.analyzer._timelinePeakPct) {
      fill(244, 63, 94, 180);
      noStroke();
      const pcts = AppState.analyzer._timelinePeakPct;
      for (let j = 0; j < pcts.length; j++) {
        const xp = M.left + pcts[j] * innerWidth;
        rect(xp - 0.5, AppState.yTimelineTop + 2, 1.5, timelineHeight - 4);
      }
    }

    const xViewStart = map(AppState.viewStartTime, 0, AppState.totalDuration, M.left, width - M.right);
    const xViewEnd   = map(AppState.viewStartTime + AppState.viewDuration, 0, AppState.totalDuration, M.left, width - M.right);

    fill(14, 165, 233, 25);
    stroke(14, 165, 233, 140);
    strokeWeight(1.5);
    rect(xViewStart, AppState.yTimelineTop, xViewEnd - xViewStart, timelineHeight, 4);
  }
}

function findClosestIndex(targetTime) {
  if (!AppState.analyzer || !AppState.analyzer.raw || AppState.analyzer.raw.length === 0) return -1;
  const data = AppState.analyzer.raw;
  let low = 0;
  let high = data.length - 1;

  if (targetTime <= data[low].time) return low;
  if (targetTime >= data[high].time) return high;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const midTime = data[mid].time;

    if (midTime === targetTime) return mid;

    if (midTime < targetTime) {
      if (mid < data.length - 1 && data[mid + 1].time > targetTime) {
        return (targetTime - midTime < data[mid + 1].time - targetTime) ? mid : mid + 1;
      }
      low = mid + 1;
    } else {
      if (mid > 0 && data[mid - 1].time < targetTime) {
        return (targetTime - data[mid - 1].time < midTime - targetTime) ? mid - 1 : mid;
      }
      high = mid - 1;
    }
  }
  return -1;
}

function mousePressed() {
  if (AppState.analyzer.raw.length === 0) return;

  if (mouseX >= M.left && mouseX <= width - M.right &&
      mouseY >= AppState.yTimelineTop && mouseY <= AppState.yTimelineBottom) {
    AppState.isDraggingTimeline = true;
    const clickTime = map(mouseX, M.left, width - M.right, 0, AppState.totalDuration);
    AppState.viewStartTime = constrain(clickTime - AppState.viewDuration / 2, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));
    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';
    redraw();
  }
  else if (mouseX >= M.left && mouseX <= width - M.right &&
      mouseY >= M.top && mouseY <= AppState.yGraphBottom) {
    AppState.isDragging = true;
    AppState.dragStartMouseX = mouseX;
    AppState.dragStartViewStart = AppState.viewStartTime;
  }
}

function mouseDragged() {
  if (AppState.isDraggingTimeline && AppState.analyzer.raw.length > 0) {
    const dragTime = map(mouseX, M.left, width - M.right, 0, AppState.totalDuration);
    AppState.viewStartTime = constrain(dragTime - AppState.viewDuration / 2, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));
    redraw();
  }
  else if (AppState.isDragging && AppState.analyzer.raw.length > 0) {
    const mouseDx = mouseX - AppState.dragStartMouseX;
    const timePerPixel = AppState.viewDuration / (width - M.left - M.right);
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
  if (mouseX >= M.left && mouseX <= width - M.right &&
      mouseY >= M.top && mouseY <= AppState.yGraphBottom) {

    if (AppState.analyzer.raw.length === 0) return false;

    const mouseTime = map(mouseX, M.left, width - M.right, AppState.viewStartTime, AppState.viewStartTime + AppState.viewDuration);
    const zoomMultiplier = event.delta < 0 ? 0.85 : 1.15;

    AppState.viewDuration = constrain(AppState.viewDuration * zoomMultiplier, 2.0, AppState.totalDuration);
    AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;

    AppState.viewStartTime = mouseTime - (mouseX - M.left) * (AppState.viewDuration / (width - M.left - M.right));
    AppState.viewStartTime = constrain(AppState.viewStartTime, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));

    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';

    redraw();
    return false;
  }
}

function zoomCanvas(multiplier) {
  if (AppState.analyzer.raw.length === 0) return;

  const centerTime = AppState.viewStartTime + AppState.viewDuration / 2;

  AppState.viewDuration = constrain(AppState.viewDuration / multiplier, 2.0, AppState.totalDuration);
  AppState.zoomFactor = AppState.totalDuration / AppState.viewDuration;

  AppState.viewStartTime = centerTime - AppState.viewDuration / 2;
  AppState.viewStartTime = constrain(AppState.viewStartTime, 0, Math.max(0, AppState.totalDuration - AppState.viewDuration));

  const select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'custom';

  redraw();
}

function resetView() {
  if (AppState.analyzer.raw.length === 0) return;
  AppState.viewStartTime = 0;
  AppState.viewDuration = AppState.totalDuration;
  AppState.zoomFactor = 1.0;
  AppState.activePeakIndex = -1;

  const select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'fit';

  document.querySelectorAll('#peaksTable tbody tr').forEach(r => { r.classList.remove('active-row'); });

  redraw();
}
