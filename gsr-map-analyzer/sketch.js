/**
 * Central Controller & p5.js Sketch Loop
 */

let analyzer;
let collectiveManager;
let activeTrackId = null;
let viewMode = 'single'; // 'single' or 'collective'
const TRACK_COLORS = [
  '#0ea5e9', // Sky blue
  '#10b981', // Emerald green
  '#f43f5e', // Rose red
  '#a855f7', // Purple
  '#f59e0b', // Amber yellow
  '#ec4899', // Pink
  '#14b8a6', // Teal
  '#f97316'  // Orange
];
let trackColorIndex = 0;
function getNextTrackColor() {
  const c = TRACK_COLORS[trackColorIndex];
  trackColorIndex = (trackColorIndex + 1) % TRACK_COLORS.length;
  return c;
}
let myCanvas;

// Timeline variables
let yTimelineTop = 0;
let yTimelineBottom = 0;
let isDraggingTimeline = false;

// Viewport variables (zoom and pan)
let totalDuration = 120.0;
let viewStartTime = 0.0;
let viewDuration = 120.0;
let zoomFactor = 1.0;
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 50.0;

// Graph layout margins
const margin = {
  top: 30,
  bottom: 50,
  left: 70,
  right: 35,
  gap: 40 // gap between Upper and Lower graphs
};

// Visibility states
let showRaw = true;
let showFiltered = true;
let showTonic = true;
let showPeaks = true;

// Interaction
let isDragging = false;
let dragStartMouseX = 0;
let dragStartViewStart = 0;
let hoveredIndex = -1;
let activePeakIndex = -1;

// DOM Elements cache
let sliders = {};
let statFields = {};
let tableBody;
let mapManager; // Leaflet Map controller

function setup() {
  // Initialize Collective Manager and Analyzer
  collectiveManager = new GSRCollectiveManager();
  analyzer = new GSRAnalyzer();

  // Initialize Map Manager
  mapManager = new GSRMapManager('map');

  // Create canvas inside container
  const container = document.getElementById('canvasContainer');
  const w = container.clientWidth;
  const h = container.clientHeight || 450;
  myCanvas = createCanvas(w, h);
  myCanvas.parent('canvasContainer');

  // Disable default context menu on canvas
  myCanvas.elt.oncontextmenu = (e) => e.preventDefault();

  // Cache DOM elements
  cacheDOMElements();

  // Load saved settings & update labels
  loadSettings();
  initializeLabels();

  // Setup UI Event Listeners
  setupEventListeners();

  // Draw background initially
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
  if (!analyzer || !analyzer.raw || analyzer.raw.length === 0) {
    drawPlaceholder();
    return;
  }

  background(9, 13, 22);

  // Calculate panel split dimensions
  const innerWidth = width - margin.left - margin.right;
  
  // Timeline heights
  const timelineHeight = 22;
  const timelineGap = 25;

  // Subtract timeline from total height budget
  const totalHeight = height - margin.top - margin.bottom - margin.gap - timelineHeight - timelineGap;
  
  const hUpper = totalHeight * 0.62; // Upper graph gets 62%
  const hLower = totalHeight * 0.38; // Lower graph gets 38%
  
  const yUpperBottom = margin.top + hUpper;
  const yLowerTop = yUpperBottom + margin.gap;
  const yLowerBottom = yLowerTop + hLower;

  // Save dynamic vertical bounds for timeline interaction
  yTimelineTop = yLowerBottom + timelineGap;
  yTimelineBottom = yTimelineTop + timelineHeight;

  // View bounds
  const viewEndTime = viewStartTime + viewDuration;

  // Get data points within viewport (plus one padding for boundary drawing)
  const startIdx = findClosestIndex(viewStartTime);
  const endIdx = findClosestIndex(viewEndTime);
  
  const idxStart = Math.max(0, startIdx - 1);
  const idxEnd = Math.min(analyzer.raw.length - 1, endIdx + 1);

  // Determine dynamic Y-scaling for Upper Graph (Raw/Filtered/Tonic)
  let yMinUpper = Infinity;
  let yMaxUpper = -Infinity;

  for (let i = idxStart; i <= idxEnd; i++) {
    if (showRaw && analyzer.raw[i]) {
      yMinUpper = Math.min(yMinUpper, analyzer.raw[i].val);
      yMaxUpper = Math.max(yMaxUpper, analyzer.raw[i].val);
    }
    if (showFiltered && analyzer.filtered[i]) {
      yMinUpper = Math.min(yMinUpper, analyzer.filtered[i].val);
      yMaxUpper = Math.max(yMaxUpper, analyzer.filtered[i].val);
    }
    if (showTonic && analyzer.tonic[i]) {
      yMinUpper = Math.min(yMinUpper, analyzer.tonic[i].val);
      yMaxUpper = Math.max(yMaxUpper, analyzer.tonic[i].val);
    }
  }

  // Fallbacks if not showing curves or empty
  if (yMinUpper === Infinity) yMinUpper = 0;
  if (yMaxUpper === -Infinity) yMaxUpper = 10;
  
  // Add some padding to vertical range
  let paddingUpper = (yMaxUpper - yMinUpper) * 0.1;
  if (paddingUpper === 0) paddingUpper = 0.5;
  yMinUpper = Math.max(0, yMinUpper - paddingUpper);
  yMaxUpper = yMaxUpper + paddingUpper;

  // Determine Y-scaling for Lower Graph (Phasic)
  let yMaxLower = -Infinity;
  for (let i = idxStart; i <= idxEnd; i++) {
    if (analyzer.phasic[i]) {
      yMaxLower = Math.max(yMaxLower, analyzer.phasic[i].val);
    }
  }
  if (yMaxLower <= 0) yMaxLower = parseFloat(sliders.peakThreshold.value) * 2;
  let paddingLower = yMaxLower * 0.15;
  yMaxLower = yMaxLower + paddingLower;
  const yMinLower = 0;

  // 1. Draw Grids and Axes
  drawGridX(viewStartTime, viewEndTime, yUpperBottom, yLowerBottom);
  drawGridYUpper(yMinUpper, yMaxUpper, yUpperBottom, hUpper);
  drawGridYLower(yMinLower, yMaxLower, yLowerBottom, hLower);

  // 2. Draw Upper Graph Curves
  if (showRaw) {
    drawSignalCurve(analyzer.raw, viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, color(100, 116, 139, 140), 1.5);
  }
  if (showFiltered) {
    drawSignalCurve(analyzer.filtered, viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, color(14, 165, 233), 2.2);
  }
  if (showTonic) {
    drawSignalCurve(analyzer.tonic, viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, color(217, 70, 239), 2);
  }

  // 3. Draw Lower Graph (Phasic)
  drawPhasicArea(analyzer.phasic, viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom);
  drawSignalCurve(analyzer.phasic, viewStartTime, viewEndTime, yMinLower, yMaxLower, yLowerTop, yLowerBottom, color(16, 185, 129), 2);
  
  // Draw threshold line on Phasic graph
  const thresholdVal = parseFloat(sliders.peakThreshold.value);
  const thresholdY = map(thresholdVal, yMinLower, yMaxLower, yLowerBottom, yLowerTop);
  stroke(244, 63, 94, 120);
  strokeWeight(1);
  drawingContext.setLineDash([5, 5]);
  line(margin.left, thresholdY, width - margin.right, thresholdY);
  drawingContext.setLineDash([]);
  
  fill(244, 63, 94, 150);
  noStroke();
  textSize(9);
  textAlign(RIGHT, CENTER);
  text(`Threshold (${thresholdVal.toFixed(3)} μS)`, width - margin.right - 5, thresholdY - 8);

  // 4. Draw Peak Markers
  drawPeakMarkers(viewStartTime, viewEndTime, yMinUpper, yMaxUpper, margin.top, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 5. Draw Interactive Hover Scrubber
  handleScrubber(viewStartTime, viewEndTime, yMinUpper, yMaxUpper, yUpperBottom, yMinLower, yMaxLower, yLowerTop, yLowerBottom);

  // 6. Draw Timeline overview / Minimap
  if (analyzer.raw && analyzer.raw.length > 0) {
    // Timeline background
    fill(15, 23, 42, 180);
    stroke(255, 255, 255, 15);
    strokeWeight(1);
    rect(margin.left, yTimelineTop, innerWidth, timelineHeight, 6);

    // Draw full raw GSR signal downsampled to fit timeline smoothly
    noFill();
    stroke(148, 163, 184, 45); // muted slate grey-blue
    strokeWeight(1.2);
    
    // Find min and max of raw signal for full track (cached for performance)
    let minRaw = Infinity;
    let maxRaw = -Infinity;
    if (!analyzer.rawMinMaxCached) {
      for (let i = 0; i < analyzer.raw.length; i++) {
        const val = analyzer.raw[i].val;
        if (val < minRaw) minRaw = val;
        if (val > maxRaw) maxRaw = val;
      }
      analyzer.rawMinMaxCached = { minVal: minRaw, maxVal: maxRaw };
    } else {
      minRaw = analyzer.rawMinMaxCached.minVal;
      maxRaw = analyzer.rawMinMaxCached.maxVal;
    }
    
    if (minRaw === maxRaw) maxRaw = minRaw + 0.5;

    beginShape();
    const timelineStep = Math.max(1, Math.floor(analyzer.raw.length / 300));
    for (let i = 0; i < analyzer.raw.length; i += timelineStep) {
      const d = analyzer.raw[i];
      const xt = map(d.time, 0, totalDuration, margin.left, width - margin.right);
      const yt = map(d.val, minRaw, maxRaw, yTimelineBottom - 3, yTimelineTop + 3);
      vertex(xt, yt);
    }
    endShape();

    // Draw stress peak indicators as small red vertical lines
    if (showPeaks && analyzer.peaks) {
      fill(244, 63, 94, 180); // rose-600 with opacity
      noStroke();
      analyzer.peaks.forEach(pk => {
        const xp = map(pk.time, 0, totalDuration, margin.left, width - margin.right);
        rect(xp - 0.5, yTimelineTop + 2, 1.5, timelineHeight - 4);
      });
    }

    // Draw active viewport highlight rectangle (with nice glass effect)
    const xViewStart = map(viewStartTime, 0, totalDuration, margin.left, width - margin.right);
    const xViewEnd = map(viewStartTime + viewDuration, 0, totalDuration, margin.left, width - margin.right);
    
    fill(14, 165, 233, 25); // sky blue transparency
    stroke(14, 165, 233, 140);
    strokeWeight(1.5);
    rect(xViewStart, yTimelineTop, xViewEnd - xViewStart, timelineHeight, 4);
  }
}

/**
 * Find closest index in dataset to target time using binary search (very fast!)
 */
function findClosestIndex(targetTime) {
  if (!analyzer || !analyzer.raw || analyzer.raw.length === 0) return -1;
  const data = analyzer.raw;
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
        // Return whichever is closer
        return (targetTime - midTime < data[mid + 1].time - targetTime) ? mid : mid + 1;
      }
      low = mid + 1;
    } else {
      if (mid > 0 && data[mid - 1].time < targetTime) {
        // Return whichever is closer
        return (targetTime - data[mid - 1].time < midTime - targetTime) ? mid - 1 : mid;
      }
      high = mid - 1;
    }
  }
  return -1;
}

function mousePressed() {
  if (analyzer.raw.length === 0) return;
  
  // Check if click was inside timeline overview
  if (mouseX >= margin.left && mouseX <= width - margin.right &&
      mouseY >= yTimelineTop && mouseY <= yTimelineBottom) {
    isDraggingTimeline = true;
    const clickTime = map(mouseX, margin.left, width - margin.right, 0, totalDuration);
    viewStartTime = constrain(clickTime - viewDuration / 2, 0, Math.max(0, totalDuration - viewDuration));
    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';
    redraw();
  }
  // Check if click was inside graph bounds (above the timeline gap)
  else if (mouseX >= margin.left && mouseX <= width - margin.right &&
      mouseY >= margin.top && mouseY <= yTimelineTop - 20) {
    isDragging = true;
    dragStartMouseX = mouseX;
    dragStartViewStart = viewStartTime;
  }
}

function mouseDragged() {
  if (isDraggingTimeline && analyzer.raw.length > 0) {
    const dragTime = map(mouseX, margin.left, width - margin.right, 0, totalDuration);
    viewStartTime = constrain(dragTime - viewDuration / 2, 0, Math.max(0, totalDuration - viewDuration));
    redraw();
  }
  else if (isDragging && analyzer.raw.length > 0) {
    const mouseDx = mouseX - dragStartMouseX;
    const timePerPixel = viewDuration / (width - margin.left - margin.right);
    const timeShift = mouseDx * timePerPixel;
    
    viewStartTime = dragStartViewStart - timeShift;
    viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));
    redraw();
  }
}

function mouseReleased() {
  isDragging = false;
  isDraggingTimeline = false;
}

function mouseWheel(event) {
  // Zoom only if hovered over the graph canvas area (above the timeline)
  if (mouseX >= margin.left && mouseX <= width - margin.right &&
      mouseY >= margin.top && mouseY <= yTimelineTop - 20) {
    
    if (analyzer.raw.length === 0) return false;

    // Get time coordinate under mouse before zoom
    const mouseTime = map(mouseX, margin.left, width - margin.right, viewStartTime, viewStartTime + viewDuration);

    // Zoom direction
    const zoomMultiplier = event.delta < 0 ? 0.85 : 1.15;
    
    viewDuration = constrain(viewDuration * zoomMultiplier, 2.0, totalDuration);
    zoomFactor = totalDuration / viewDuration;

    // Center zoom on mouse time coordinate
    viewStartTime = mouseTime - (mouseX - margin.left) * (viewDuration / (width - margin.left - margin.right));
    viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));

    const select = document.getElementById('timeWindowSelect');
    if (select) select.value = 'custom';

    redraw();
    return false; // Prevent page scroll
  }
}

/**
 * Zoom graph from canvas buttons
 */
function zoomCanvas(multiplier) {
  if (analyzer.raw.length === 0) return;
  
  // Center Zoom on current view center
  const centerTime = viewStartTime + viewDuration / 2;
  
  viewDuration = constrain(viewDuration / multiplier, 2.0, totalDuration);
  zoomFactor = totalDuration / viewDuration;
  
  viewStartTime = centerTime - viewDuration / 2;
  viewStartTime = constrain(viewStartTime, 0, Math.max(0, totalDuration - viewDuration));
  
  const select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'custom';
  
  redraw();
}

function resetView() {
  if (analyzer.raw.length === 0) return;
  viewStartTime = 0;
  viewDuration = totalDuration;
  zoomFactor = 1.0;
  activePeakIndex = -1;
  
  const select = document.getElementById('timeWindowSelect');
  if (select) select.value = 'fit';

  // De-select table rows
  document.querySelectorAll('#peaksTable tbody tr').forEach(r => r.classList.remove('active-row'));
  
  redraw();
}
