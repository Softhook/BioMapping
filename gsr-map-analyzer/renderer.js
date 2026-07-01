/**
 * Graphics Rendering & Drawing Utilities (p5.js Canvas View)
 */

function drawPlaceholder() {
  background(9, 13, 22, 0);
}

/**
 * Draw vertical gridlines and time labels (shared by both graphs)
 */
function drawGridX(tMin, tMax, yUpperBottom, yLowerBottom) {
  const innerWidth = width - margin.left - margin.right;
  
  // Choose reasonable grid step in seconds based on duration
  const span = tMax - tMin;
  let step = 10;
  if (span < 5) step = 0.5;
  else if (span < 15) step = 1;
  else if (span < 30) step = 5;
  else if (span < 120) step = 10;
  else if (span < 300) step = 30;
  else if (span < 900) step = 60;
  else if (span < 1800) step = 300; // 5 min
  else if (span < 3600) step = 600; // 10 min
  else if (span < 7200) step = 1200; // 20 min
  else step = 1800; // 30 min

  // Align start to step boundary
  const firstGridTime = Math.floor(tMin / step) * step;

  stroke(255, 255, 255, 12);
  strokeWeight(1);
  textAlign(CENTER, TOP);
  textSize(10);
  
  for (let t = firstGridTime; t <= tMax; t += step) {
    if (t < tMin) continue;

    const x = map(t, tMin, tMax, margin.left, width - margin.right);
    
    // Draw vertical gridline on Upper Graph
    line(x, margin.top, x, yUpperBottom);
    
    // Draw vertical gridline on Lower Graph
    line(x, yUpperBottom + margin.gap, x, yLowerBottom);
    
    // Time ticks at bottom of both
    fill(148, 163, 184);
    noStroke();
    
    // Format timestamp label
    let label = t.toFixed(t % 1 !== 0 ? 1 : 0) + 's';
    if (t >= 3600) {
      let h = Math.floor(t / 3600);
      let m = Math.floor((t % 3600) / 60);
      let s = Math.floor(t % 60);
      label = `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    } else if (t >= 60) {
      let m = Math.floor(t / 60);
      let s = Math.floor(t % 60);
      label = `${m}:${s < 10 ? '0' : ''}${s}`;
    }
    text(label, x, yLowerBottom + 6);
    stroke(255, 255, 255, 12);
  }

  // Draw axis boundaries
  stroke(255, 255, 255, 25);
  line(margin.left, margin.top, margin.left, yUpperBottom);
  line(margin.left, yUpperBottom + margin.gap, margin.left, yLowerBottom);
  line(margin.left, yUpperBottom, width - margin.right, yUpperBottom);
  line(margin.left, yLowerBottom, width - margin.right, yLowerBottom);
}

/**
 * Draw horizontal gridlines for Upper Graph (Conductance)
 */
function drawGridYUpper(yMin, yMax, yBottom, heightVal) {
  const span = yMax - yMin;
  let step = 0.5;
  if (span < 0.2) step = 0.02;
  else if (span < 1.0) step = 0.1;
  else if (span < 3.0) step = 0.5;
  else if (span < 10) step = 1.0;
  else step = 2.0;

  const firstGridVal = Math.floor(yMin / step) * step;

  stroke(255, 255, 255, 12);
  textAlign(RIGHT, CENTER);
  textSize(10);

  for (let val = firstGridVal; val <= yMax; val += step) {
    if (val < yMin) continue;

    const y = map(val, yMin, yMax, yBottom, margin.top);
    line(margin.left, y, width - margin.right, y);

    noStroke();
    fill(148, 163, 184);
    text(val.toFixed(2) + ' μS', margin.left - 8, y);
    stroke(255, 255, 255, 12);
  }
}

/**
 * Draw horizontal gridlines for Lower Graph (Phasic)
 */
function drawGridYLower(yMin, yMax, yBottom, heightVal) {
  const span = yMax - yMin;
  let step = 0.05;
  if (span < 0.05) step = 0.005;
  else if (span < 0.15) step = 0.01;
  else if (span < 0.5) step = 0.05;
  else if (span < 1.5) step = 0.1;
  else step = 0.5;

  const firstGridVal = Math.floor(yMin / step) * step;

  stroke(255, 255, 255, 12);
  textAlign(RIGHT, CENTER);
  textSize(10);

  for (let val = firstGridVal; val <= yMax; val += step) {
    if (val < yMin) continue;

    const y = map(val, yMin, yMax, yBottom, yBottom - heightVal);
    line(margin.left, y, width - margin.right, y);

    noStroke();
    fill(148, 163, 184);
    text(val.toFixed(3) + ' μS', margin.left - 8, y);
    stroke(255, 255, 255, 12);
  }
}

/**
 * Helper to draw a line plot for a given signal
 */
function drawSignalCurve(data, tMin, tMax, yMin, yMax, yTop, yBottom, lineColor, lineWt) {
  if (!data || data.length === 0) return;
  noFill();
  stroke(lineColor);
  strokeWeight(lineWt);
  
  // Find start and end indices in viewport
  const startIdx = Math.max(0, findClosestIndex(tMin) - 1);
  const endIdx = Math.min(data.length - 1, findClosestIndex(tMax) + 1);
  const count = endIdx - startIdx + 1;

  if (count <= 0) return;

  const maxVertices = 1500;
  const step = Math.max(1, Math.ceil(count / maxVertices));
  const useSpline = count < 600;

  beginShape();
  
  if (useSpline) {
    // First control point for p5 spline interpolation (duplicate first point in view)
    const dFirst = data[startIdx];
    const xFirst = map(dFirst.time, tMin, tMax, margin.left, width - margin.right);
    const yFirst = map(dFirst.val, yMin, yMax, yBottom, yTop);
    curveVertex(xFirst, yFirst);

    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      curveVertex(x, y);
    }

    // Last control point for p5 spline interpolation (duplicate last point in view)
    const dLast = data[endIdx];
    const xLast = map(dLast.time, tMin, tMax, margin.left, width - margin.right);
    const yLast = map(dLast.val, yMin, yMax, yBottom, yTop);
    curveVertex(xLast, yLast);
  } else {
    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      vertex(x, y);
    }
  }
  
  endShape();
}

/**
 * Draw semi-transparent gradient/area fill under the Phasic signal curve
 */
function drawPhasicArea(data, tMin, tMax, yMin, yMax, yTop, yBottom) {
  if (!data || data.length === 0) return;
  const startIdx = Math.max(0, findClosestIndex(tMin) - 1);
  const endIdx = Math.min(data.length - 1, findClosestIndex(tMax) + 1);
  const count = endIdx - startIdx + 1;
  
  if (count <= 0) return;

  noStroke();
  fill(16, 185, 129, 25); // Emerald transparent fill

  const maxVertices = 1500;
  const step = Math.max(1, Math.ceil(count / maxVertices));
  const useSpline = count < 600;

  beginShape();
  
  const dFirst = data[startIdx];
  const xStart = map(dFirst.time, tMin, tMax, margin.left, width - margin.right);
  
  // Anchor to baseline start
  vertex(xStart, yBottom);
  
  if (useSpline) {
    // Spline control point
    curveVertex(xStart, yBottom);

    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      curveVertex(x, y);
    }

    const dLast = data[endIdx];
    const xEnd = map(dLast.time, tMin, tMax, margin.left, width - margin.right);
    // Spline control point
    curveVertex(xEnd, yBottom);
    // Anchor to baseline end
    vertex(xEnd, yBottom);
  } else {
    for (let i = startIdx; i <= endIdx; i += step) {
      const d = data[i];
      const x = map(d.time, tMin, tMax, margin.left, width - margin.right);
      const y = map(d.val, yMin, yMax, yBottom, yTop);
      vertex(x, y);
    }
    const dLast = data[endIdx];
    const xEnd = map(dLast.time, tMin, tMax, margin.left, width - margin.right);
    vertex(xEnd, yBottom);
  }
  
  endShape();
}

/**
 * Draw visual annotations for all detected peaks in range
 */
function drawPeakMarkers(tMin, tMax, yMinU, yMaxU, yTopU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
  if (!showPeaks || !analyzer.peaks || analyzer.peaks.length === 0) return;
  for (let pIdx = 0; pIdx < analyzer.peaks.length; pIdx++) {
    const p = analyzer.peaks[pIdx];
    
    // Check if peak time or onset time is in viewport
    if (p.time < tMin && p.onsetTime < tMin && 
        (p.recoveryIndex === -1 || p.recoveryIndex === undefined || 
         !analyzer.phasic || !analyzer.phasic[p.recoveryIndex] || 
         analyzer.phasic[p.recoveryIndex].time < tMin)) {
      continue;
    }
    if (p.onsetTime > tMax) {
      continue;
    }

    const xPeak = map(p.time, tMin, tMax, margin.left, width - margin.right);
    const xOnset = map(p.onsetTime, tMin, tMax, margin.left, width - margin.right);
    
    const yFilteredPeak = map(analyzer.filtered[p.index].val, yMinU, yMaxU, yBottomU, yTopU);
    const yPhasicPeak = map(p.value, yMinL, yMaxL, yBottomL, yTopL);
    const yPhasicOnset = map(p.onsetValue, yMinL, yMaxL, yBottomL, yTopL);

    const isActive = (pIdx === activePeakIndex);
    const isHovered = (hoveredIndex >= p.onsetIndex && hoveredIndex <= p.index);

    // 1. Draw peak indicator in Phasic graph
    // Connect onset to peak with shaded highlight
    if (isActive || isHovered) {
      fill(244, 63, 94, 75); // Shaded fill under the curve (rose red at ~30% opacity)
      noStroke();
      beginShape();
      vertex(xOnset, yBottomL);
      for (let i = p.onsetIndex; i <= p.index; i++) {
        const xVal = map(analyzer.phasic[i].time, tMin, tMax, margin.left, width - margin.right);
        const yVal = map(analyzer.phasic[i].val, yMinL, yMaxL, yBottomL, yTopL);
        vertex(xVal, yVal);
      }
      vertex(xPeak, yBottomL);
      endShape(CLOSE);
    }

    // Peak Onset circle (Green)
    stroke(16, 185, 129);
    strokeWeight(1.5);
    fill(9, 13, 22);
    circle(xOnset, yPhasicOnset, isActive ? 8 : 5);

    // Vertical dashed lines connecting upper and lower graphs
    stroke(244, 63, 94, 60);
    strokeWeight(1);
    drawingContext.setLineDash([3, 3]);
    line(xPeak, yFilteredPeak, xPeak, yPhasicPeak);
    drawingContext.setLineDash([]);

    // Peak circle (Rose red)
    stroke(244, 63, 94);
    strokeWeight(2);
    fill(isActive ? color(244, 63, 94) : color(9, 13, 22));
    circle(xPeak, yPhasicPeak, isActive ? 9 : 6);
    circle(xPeak, yFilteredPeak, isActive ? 9 : 6);

    // Label peak number
    if (xPeak >= margin.left && xPeak <= width - margin.right) {
      if (viewDuration < 300 || isActive || isHovered) {
        noStroke();
        fill(244, 63, 94);
        textSize(10);
        textStyle(BOLD);
        textAlign(CENTER, BOTTOM);
        text(`#${pIdx + 1}`, xPeak, yFilteredPeak - 8);
        textStyle(NORMAL);
      }
    }
  }
}

/**
 * Handle hover scrubber line and details tooltip
 */
function handleScrubber(tMin, tMax, yMinU, yMaxU, yBottomU, yMinL, yMaxL, yTopL, yBottomL) {
  // If mouse is outside graph bounds horizontally or dragging, don't draw scrubber
  if (mouseX < margin.left || mouseX > width - margin.right || isDragging) {
    hoveredIndex = -1;
    if (mapManager) mapManager.setScrubPosition(NaN, NaN);
    return;
  }

  if (!analyzer.raw || analyzer.raw.length === 0 || 
      !analyzer.filtered || analyzer.filtered.length === 0 ||
      !analyzer.tonic || analyzer.tonic.length === 0 ||
      !analyzer.phasic || analyzer.phasic.length === 0) {
    hoveredIndex = -1;
    if (mapManager) mapManager.setScrubPosition(NaN, NaN);
    return;
  }

  // Map mouse position to time coordinate
  const hoverTime = map(mouseX, margin.left, width - margin.right, tMin, tMax);
  hoveredIndex = findClosestIndex(hoverTime);

  if (hoveredIndex === -1) return;

  const dRaw = analyzer.raw[hoveredIndex];
  if (!dRaw) return;

  // Sync Leaflet map scrubber marker coordinate position
  if (dRaw.hasGps && !isNaN(dRaw.lat) && !isNaN(dRaw.lon)) {
    if (mapManager) mapManager.setScrubPosition(dRaw.lat, dRaw.lon, true);
  } else {
    if (mapManager) mapManager.setScrubPosition(NaN, NaN);
  }

  const dFilt = analyzer.filtered[hoveredIndex];
  const dTonic = analyzer.tonic[hoveredIndex];
  const dPhasic = analyzer.phasic[hoveredIndex];

  const xScrub = map(dRaw.time, tMin, tMax, margin.left, width - margin.right);

  // Draw vertical line across entire canvas
  stroke(255, 255, 255, 50);
  strokeWeight(1);
  line(xScrub, margin.top, xScrub, yBottomL);

  // Draw intersection dots
  const yU = map(dFilt.val, yMinU, yMaxU, yBottomU, margin.top);
  const yL = map(dPhasic.val, yMinL, yMaxL, yBottomL, yTopL);

  stroke(14, 165, 233);
  fill(14, 165, 233);
  circle(xScrub, yU, 6);

  stroke(16, 185, 129);
  fill(16, 185, 129);
  circle(xScrub, yL, 6);

  // Render Tooltip Card
  drawTooltip(dRaw.time, dRaw.val, dFilt.val, dTonic.val, dPhasic.val);
}

function drawTooltip(time, rawVal, filtVal, tonicVal, phasicVal) {
  const pad = 12;
  const boxW = 190;
  const boxH = 120;
  
  // Decide tooltip placement: right of scrubber or left (if near right edge)
  let boxX = mouseX + 15;
  if (boxX + boxW > width - margin.right) {
    boxX = mouseX - boxW - 15;
  }
  
  let boxY = mouseY - 40;
  boxY = constrain(boxY, margin.top, height - margin.bottom - boxH);

  // Glass box background
  fill(22, 33, 54, 235);
  stroke(255, 255, 255, 15);
  strokeWeight(1);
  rect(boxX, boxY, boxW, boxH, 8);

  // Tooltip content
  noStroke();
  textAlign(LEFT, TOP);
  
  // Timestamp
  fill(255, 255, 255);
  textSize(10);
  textStyle(BOLD);
  text(`TIME: ${time.toFixed(2)} s`, boxX + pad, boxY + pad);
  textStyle(NORMAL);
  
  // Values
  textSize(9.5);
  const startY = boxY + pad + 18;
  const spacing = 18;

  // Raw GSR
  fill(148, 163, 184);
  text(`Raw:`, boxX + pad, startY);
  textAlign(RIGHT, TOP);
  text(`${rawVal.toFixed(4)} μS`, boxX + boxW - pad, startY);
  
  // Filtered GSR
  textAlign(LEFT, TOP);
  fill(14, 165, 233);
  text(`Filtered:`, boxX + pad, startY + spacing);
  textAlign(RIGHT, TOP);
  text(`${filtVal.toFixed(4)} μS`, boxX + boxW - pad, startY + spacing);

  // Tonic Baseline
  textAlign(LEFT, TOP);
  fill(217, 70, 239);
  text(`Tonic (SCL):`, boxX + pad, startY + 2 * spacing);
  textAlign(RIGHT, TOP);
  text(`${tonicVal.toFixed(4)} μS`, boxX + boxW - pad, startY + 2 * spacing);

  // Phasic Response
  textAlign(LEFT, TOP);
  fill(16, 185, 129);
  text(`Phasic (SCR):`, boxX + pad, startY + 3 * spacing);
  textAlign(RIGHT, TOP);
  text(`${phasicVal.toFixed(4)} μS`, boxX + boxW - pad, startY + 3 * spacing);
}
